// SPDX-License-Identifier: Apache-2.0
/**
 * What may be deleted, and the proofs that have to be in hand first.
 *
 * RULING 15, EXTENDED BY RULING 50. A path is deletable only if it is
 *
 *   (a) inside brigadier's own root by **`realpath`**,
 *   (b) recorded in a manifest written BEFORE anything was created, and
 *   (c) carrying a marker file brigadier wrote.
 *
 * All three, or refuse and report. There is no majority rule and no "two out of
 * three is close enough": each of the three fails in a different way and the
 * failures are not correlated. (a) alone is satisfied by the operator's own
 * files if they ever put something under the run root. (b) alone is satisfied by
 * a manifest an agent wrote. (c) alone is satisfied by a marker file an agent
 * copied. What makes the conjunction worth anything is that an attacker needs
 * all three and a mistake needs only one.
 *
 * REFS GET A FOURTH RULE OF THE SAME SHAPE rather than a generous reading of the
 * first three, because a ref lives inside the OPERATOR'S `.git`, which is
 * outside brigadier's root by construction — `src/repo/refs.ts` opens with that
 * argument. A ref is deletable only if it is under `refs/brigadier/<run-id>/`,
 * its `<run-id>` appears in a manifest written before the ref existed, and the
 * delete is the compare-and-swap form `git update-ref -d <ref> <expected-sha>`.
 * Never the two-argument form: a ref that moved under us means something we do
 * not understand is happening in the operator's repository, and the correct
 * response is to report rather than to win.
 *
 * WHAT IS DELIBERATELY NOT HERE: any decision about WHETHER a directory should
 * go. Ruling 63 splits that from ownership entirely — the sweep reclaims
 * processes always and directories only for runs that are complete — and it
 * lives in `start.ts`. This file answers "may brigadier delete this", never
 * "should it".
 */

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
  claimedByManifest,
  intendedRealPath,
  readManifest,
  type RunManifest,
} from "../isolation/index.ts";
import { CLONE_SIGNATURE, runGit } from "../isolation/internal-git.ts";
import { RUN_DIR } from "../repo/layout.ts";
import { REF_NAMESPACE, deleteRefArgv } from "../repo/refs.ts";

/**
 * Each of ruling 15's three conditions, separately, so that a refusal can name
 * the one that failed.
 *
 * A boolean would be the wrong return type here for the reason
 * `assertReclaimed` gives about its own refusals: "false" is not a report anyone
 * can act on, and the operator's remedy differs completely depending on which
 * condition was missing.
 */
export interface DirectoryProof {
  readonly candidate: string;
  readonly realPath: string;
  /** (a) Inside brigadier's own root, judged by `realpath` and never lexically. */
  readonly insideRunRoot: boolean;
  /** (b) The manifest that claims it, by path, or null. */
  readonly manifest: string | null;
  /** (c) The marker file brigadier wrote, by path, or null. */
  readonly markerFile: string | null;
  /**
   * Whether the manifest entry predates the directory, when the filesystem can
   * say.
   *
   * MEASURED against `bun 1.3.14` on macOS 26.5.2 (APFS) on 2026-08-17:
   * `statSync().birthtimeMs` carries sub-millisecond birth times, so the
   * ordering ruling 15 requires is checkable after the fact rather than only
   * structurally. It is `null` where the platform gives no usable birth time —
   * some Linux filesystems do not — and a `null` does NOT block, because a
   * missing measurement is not evidence of a violation. A definite `false` does.
   */
  readonly manifestOlderThanDirectory: boolean | null;
}

export interface DeleteVerdict {
  readonly deletable: boolean;
  readonly proof: DirectoryProof;
  /** One line per missing condition, each naming the remedy. Empty iff deletable. */
  readonly refusals: readonly string[];
}

export interface DirectoryOptions {
  /** brigadier's own root, as configured. Resolved by `realpath` here. */
  readonly runRoot: string;
}

/**
 * Establish all three conditions, or say which one is absent.
 *
 * `realpath` on both sides is load-bearing rather than decorative: on macOS
 * `/var` is a symlink to `/private/var`, and a lexical containment test against
 * an unresolved run root silently judges a tree that is not the one the
 * directory is in. That is the escape v1 shipped in its lane containment, and it
 * is the same mistake at a bigger blast radius here, because this one deletes.
 */
export function proveDeletableDirectory(candidate: string, options: DirectoryOptions): DeleteVerdict {
  const realRoot = intendedRealPath(options.runRoot);
  const realPath = intendedRealPath(candidate);
  const refusals: string[] = [];

  // (a) Inside the run root, and specifically inside its `r/` subtree: the run
  //     root itself may hold configuration and a cache, and neither is a clone.
  const runs = join(realRoot, RUN_DIR);
  const insideRunRoot = realPath.startsWith(runs + sep);
  if (!insideRunRoot) {
    refusals.push(
      `ruling 15 (a): ${realPath} is not inside brigadier's own run directory (${runs}) by realpath. ` +
        "Nothing outside it is brigadier's to delete, whatever else claims it.",
    );
  }

  // (b) Recorded in a manifest, and recorded as THIS PATH.
  //
  //     `claimedByManifest` walks UP, which is right for its own job — refusing
  //     a git command anywhere inside a worker clone — and wrong for this one.
  //     Under the walking form, `<clone>/agent-made/` inherits its parent's
  //     entry and is judged deletable, so an agent that creates a subdirectory
  //     and drops a marker into it gets brigadier to delete it. Ruling 15 (b) is
  //     a statement about the path being deleted, not about some ancestor of it,
  //     so the entry has to name this path exactly.
  const manifestPath = claimedByManifest(realPath);
  const manifest: RunManifest | null = manifestPath === null ? null : readManifest(manifestPath);
  const entry =
    manifest === null ? undefined : manifest.clones.find((clone) => clone.dir === realPath);
  if (manifestPath === null || manifest === null) {
    refusals.push(
      `ruling 15 (b): no run manifest records ${realPath} as a clone. A directory brigadier ` +
        "did not write down is a directory brigadier did not create.",
    );
  } else if (entry === undefined) {
    refusals.push(
      `ruling 15 (b): ${manifestPath} records an ANCESTOR of ${realPath} but not ${realPath} ` +
        "itself. An entry for a parent authorises the parent; a subdirectory an agent created " +
        "inside its own clone is recorded nowhere and is not brigadier's to delete.",
    );
  } else if (intendedRealPath(manifest.runRoot) !== realRoot) {
    refusals.push(
      `ruling 15 (b): ${manifestPath} claims ${realPath} but names run root ${manifest.runRoot}, ` +
        `and this sweep is rooted at ${realRoot}. A manifest for another root grants nothing here.`,
    );
  }

  // (c) The marker file brigadier wrote — the in-clone signature `prepareClone`
  //     writes at `.git/brigadier-clone`. It is the WEAKEST of the three, and
  //     deliberately so: an agent owns that directory and can delete the file,
  //     in which case this refuses and reports. Refusing to delete a clone
  //     because its marker is gone is the safe direction of that failure.
  const markerCandidate = join(realPath, ".git", CLONE_SIGNATURE);
  const markerFile = regularFile(markerCandidate) ? markerCandidate : null;
  if (markerFile === null) {
    refusals.push(
      `ruling 15 (c): no marker file at ${markerCandidate}, or it is not a plain regular file. ` +
        "brigadier writes one into every clone it creates; without it this directory cannot be " +
        "shown to be one, and it is retained rather than deleted.",
    );
  } else if (manifest !== null && entry !== undefined) {
    // The marker lives inside a directory the agent owns, so its PRESENCE is
    // the weakest of the three signals — the isolation slice moved the durable
    // record out of `.git` for exactly this reason. Its CONTENT is checked
    // against the manifest entry so that a marker copied from a sibling clone
    // does not stand in for this one.
    const expected = `${manifest.runId}/${entry.item}`;
    let contents = "";
    try {
      contents = readFileSync(markerFile, "utf8").trim();
    } catch {
      contents = "";
    }
    if (contents !== expected) {
      refusals.push(
        `ruling 15 (c): the marker at ${markerFile} says ${JSON.stringify(contents)} and the ` +
          `manifest records ${JSON.stringify(expected)}. A marker that does not name this clone ` +
          "is not this clone's marker.",
      );
    }
  }

  const ordering = manifestOrdering(manifest, manifestPath, realPath);
  if (ordering === false) {
    refusals.push(
      `ruling 15 (b): the manifest for ${realPath} is dated AFTER the directory was created — ` +
        "by its recorded timestamp or by the manifest file's own birth time, which a forged " +
        "timestamp cannot change. The manifest has to be written before anything exists, or it " +
        "records a directory it did not authorise.",
    );
  }

  return {
    deletable: refusals.length === 0,
    proof: {
      candidate,
      realPath,
      insideRunRoot,
      manifest: manifestPath,
      markerFile,
      manifestOlderThanDirectory: ordering,
    },
    refusals,
  };
}

/**
 * Did the manifest exist before the directory?
 *
 * Both halves are checked, and the second is why: `createdAt` is a NUMBER IN
 * THE FILE, so a forged manifest can carry any value it likes and pass. The
 * manifest file's own birth time is not the forger's to choose — writing the
 * file is what sets it — so a manifest created after the directory it claims is
 * caught even when its recorded timestamp says otherwise.
 *
 * `null` means the platform gave no usable birth time, and `null` does not
 * block: a missing measurement is not evidence of a violation. A definite
 * `false` does.
 */
function manifestOrdering(
  manifest: RunManifest | null,
  manifestPath: string | null,
  realPath: string,
): boolean | null {
  if (manifest === null || manifestPath === null) return null;
  const entry = manifest.clones.find((clone) => clone.dir === realPath);
  if (entry === undefined || typeof entry.createdAt !== "number") return null;
  const dirBirth = birthTime(realPath);
  if (dirBirth === null) return null;
  if (entry.createdAt > dirBirth) return false;
  const manifestBirth = birthTime(manifestPath);
  if (manifestBirth === null) return true;
  return manifestBirth <= dirBirth;
}

function birthTime(path: string): number | null {
  let birth: number;
  try {
    birth = statSync(path).birthtimeMs;
  } catch {
    return null;
  }
  // A birth time of 0 is the filesystem saying it does not keep one.
  return Number.isFinite(birth) && birth > 0 ? birth : null;
}

/** A plain regular file, never a symlink, a directory or a device. */
function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export interface DirectoryReclamation {
  readonly deleted: boolean;
  readonly verdict: DeleteVerdict;
  /** Bytes the directory held, measured BEFORE the delete. Zero when nothing was deleted. */
  readonly bytes: number;
}

/**
 * Delete a directory, having proved all three conditions.
 *
 * Measures first, deletes second: the report has to say what the reclamation
 * recovered, and after `rmSync` there is nothing left to measure.
 */
export function reclaimDirectory(candidate: string, options: DirectoryOptions): DirectoryReclamation {
  const verdict = proveDeletableDirectory(candidate, options);
  if (!verdict.deletable) return { deleted: false, verdict, bytes: 0 };
  const bytes = directoryBytes(verdict.proof.realPath);
  rmSync(verdict.proof.realPath, { recursive: true, force: true });
  return { deleted: true, verdict, bytes };
}

/**
 * Bytes on disk under a directory, without following symlinks.
 *
 * `lstat`, never `stat`, and the reason is the reason everything else in this
 * area uses it: a symlink to `/` would otherwise make this walk the machine.
 * Ruling 63 requires every start to report what is retained and what it costs —
 * #19 measured roughly 67 MB incremental per clone — so this number is part of
 * the promise rather than a diagnostic.
 */
export function directoryBytes(dir: string): number {
  let total = 0;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dir);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return stat.size;
  if (!stat.isDirectory()) return stat.size;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return total;
  }
  for (const entry of entries) total += directoryBytes(join(dir, entry));
  return total;
}

export interface OwnedRef {
  readonly ref: string;
  readonly sha: string;
  /**
   * True when the ref is SYMBOLIC — it names another ref rather than an object.
   *
   * This field exists because of a measured way to destroy the deliverable.
   * `for-each-ref` reports a symbolic ref's TARGET's object name, so a symbolic
   * `refs/brigadier/<run>/base` pointing at `refs/heads/brigadier/<run>` yields
   * a sha that matches, the compare-and-swap therefore succeeds, and
   * `git update-ref -d` DEREFERENCES by default — deleting the integration
   * branch. That is the one ref ruling 51 says brigadier never deletes, and the
   * invisible namespace exists precisely so the delete rule can never reach it.
   * A symbolic ref under our namespace is refused outright, and `--no-deref` is
   * on every delete besides.
   */
  readonly symbolic: boolean;
}

export type GitRunner = (repo: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * The default runner is `src/isolation/internal-git.ts`'s, deliberately.
 *
 * It builds the child environment from an allowlist and — with no authority
 * argument — REFUSES if the target is a worker clone. Ref reclamation runs in
 * the operator's repository, so that refusal should never fire; wiring it up
 * anyway means a future caller that passes a clone path gets ruling 56's
 * refusal rather than a git command inside a directory an agent has been in.
 */
const defaultGit: GitRunner = async (repo, args) => runGit({ cwd: repo, args: [...args] });

/** Every ref brigadier owns in this repository, with the sha the delete will be pinned to. */
export async function listOwnedRefs(repo: string, git: GitRunner = defaultGit): Promise<OwnedRef[]> {
  // `%(symref)` is empty for an ordinary ref and holds the target for a symbolic
  // one. Asking for it is the only way to tell them apart here: `%(objectname)`
  // reports the target's sha for both.
  const result = await git(repo, [
    "for-each-ref",
    "--format=%(objectname)\t%(symref)\t%(refname)",
    `${REF_NAMESPACE}/`,
  ]);
  if (result.code !== 0) return [];
  const refs: OwnedRef[] = [];
  for (const line of result.stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const sha = (parts[0] ?? "").trim();
    const symref = (parts[1] ?? "").trim();
    const ref = parts.slice(2).join("\t").trim();
    if (ref.length === 0) continue;
    if (symref.length > 0) {
      refs.push({ ref, sha, symbolic: true });
      continue;
    }
    if (/^[0-9a-f]{7,64}$/.test(sha)) refs.push({ ref, sha, symbolic: false });
  }
  return refs;
}

export interface RefReclamation {
  readonly ref: string;
  readonly deleted: boolean;
  readonly refusal: string | null;
}

/**
 * Delete one of brigadier's refs, compare-and-swap.
 *
 * Two refusals, and they are different failures. `deleteRefArgv` throws when the
 * ref is not ours or the sha is not a sha — a programming error, caught before
 * git is invoked at all. A non-zero exit from git means the ref MOVED between
 * the read and the delete, and that is the case the three-argument form exists
 * for: brigadier reports it and leaves the ref alone.
 */
export async function reclaimRef(
  repo: string,
  owned: OwnedRef,
  knownRunIds: readonly string[],
  git: GitRunner = defaultGit,
): Promise<RefReclamation> {
  if (owned.symbolic) {
    return {
      ref: owned.ref,
      deleted: false,
      refusal:
        `ruling 50 and ruling 51: refusing to delete ${owned.ref}, which is a SYMBOLIC ref. ` +
        "`for-each-ref` reports its target's object name, so the compare-and-swap would match " +
        "on a sha that is not this ref's, and the delete would follow the link. The one ref " +
        "brigadier never deletes is reachable that way, so a symbolic ref in our namespace is " +
        "reported rather than resolved.",
    };
  }
  let argv: string[];
  try {
    argv = deleteRefArgv(owned.ref, owned.sha, knownRunIds);
  } catch (error) {
    return { ref: owned.ref, deleted: false, refusal: (error as Error).message };
  }
  // `--no-deref` on every delete, belt and braces beside the refusal above:
  // `git update-ref -d` dereferences by default, and the thing on the far end
  // of a link in this namespace can be `refs/heads/brigadier/<run-id>`.
  argv = [argv[0] as string, "--no-deref", ...argv.slice(1)];
  const result = await git(repo, argv);
  if (result.code === 0) return { ref: owned.ref, deleted: true, refusal: null };
  return {
    ref: owned.ref,
    deleted: false,
    refusal:
      `ruling 50: \`git ${argv.join(" ")}\` exited ${result.code} — ` +
      `${(result.stderr || result.stdout).trim()}. The ref moved between the read and the delete, ` +
      "so brigadier refused it rather than clobbering whatever it points at now.",
  };
}
