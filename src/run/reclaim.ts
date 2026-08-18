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

import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
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

  // (b) Claimed by a manifest, and by a manifest for THIS root. A manifest an
  //     agent dropped into a directory it owns claims nothing about a directory
  //     brigadier created.
  const manifestPath = claimedByManifest(realPath);
  const manifest: RunManifest | null = manifestPath === null ? null : readManifest(manifestPath);
  if (manifestPath === null || manifest === null) {
    refusals.push(
      `ruling 15 (b): no run manifest records ${realPath} as a clone. A directory brigadier ` +
        "did not write down is a directory brigadier did not create.",
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
  const markerFile = existsSync(markerCandidate) ? markerCandidate : null;
  if (markerFile === null) {
    refusals.push(
      `ruling 15 (c): no marker file at ${markerCandidate}. brigadier writes one into every ` +
        "clone it creates; without it this directory cannot be shown to be one, and it is " +
        "retained rather than deleted.",
    );
  }

  const ordering = manifestOrdering(manifest, realPath);
  if (ordering === false) {
    refusals.push(
      `ruling 15 (b): the manifest entry for ${realPath} is dated AFTER the directory was ` +
        "created. The manifest has to be written before anything exists, or it records a " +
        "directory it did not authorise.",
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

function manifestOrdering(manifest: RunManifest | null, realPath: string): boolean | null {
  if (manifest === null) return null;
  const entry = manifest.clones.find((clone) => clone.dir === realPath);
  if (entry === undefined || typeof entry.createdAt !== "number") return null;
  let birth: number;
  try {
    birth = statSync(realPath).birthtimeMs;
  } catch {
    return null;
  }
  // A birth time of 0 (or one before the epoch of this project) is the
  // filesystem saying it does not keep one. Unknown, not violated.
  if (!Number.isFinite(birth) || birth <= 0) return null;
  return entry.createdAt <= birth;
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
  const result = await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)", `${REF_NAMESPACE}/`]);
  if (result.code !== 0) return [];
  const refs: OwnedRef[] = [];
  for (const line of result.stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const sha = line.slice(0, space).trim();
    const ref = line.slice(space + 1).trim();
    if (/^[0-9a-f]{7,64}$/.test(sha) && ref.length > 0) refs.push({ ref, sha });
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
  let argv: string[];
  try {
    argv = deleteRefArgv(owned.ref, owned.sha, knownRunIds);
  } catch (error) {
    return { ref: owned.ref, deleted: false, refusal: (error as Error).message };
  }
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
