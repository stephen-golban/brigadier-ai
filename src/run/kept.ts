// SPDX-License-Identifier: Apache-2.0
/**
 * Does this clone hold anybody's work? Asked of git, never of a record.
 *
 * RULING 63 SPLITS THE SWEEP — processes always, directories only for runs the
 * manifest marks complete — and the reason it gives for the second half is a
 * statement about CONTENT, not about status: *a retained directory is inert and
 * holds the only copy of someone's work.* A clone that holds no copy of
 * anything has no claim under that sentence, and retaining it is not free.
 * #19 measured roughly **67 MB incremental per clone**, so a rule of "retain
 * every directory of every unfinished run" grows without bound, and an operator
 * who cannot tell an empty retained clone from one holding their only copy will
 * eventually delete both. Ruling 63's own remedy for invisible growth — report
 * what is retained and what it costs — only works if the thing reported is
 * worth the sentence.
 *
 * SO THE QUESTION IS PUT TO GIT. Ruling 63 already says *on resume an item is
 * complete iff its REF exists, not if the record says so*: a state file records
 * intent, the world records fact, and where the world can be consulted the
 * world wins. The world for this question is the clone's own object store, and
 * the answer is `HEAD` resolving to a commit that is not the base — read back
 * through `git cat-file`, so a sha in a ref file that names nothing readable
 * counts as **undetermined** rather than as work.
 *
 * AND THE FAILURE DIRECTION IS FIXED. v1's finding 92 — an external `SIGTERM`
 * killed a supervisor, both workers had done real work, and it was
 * unrecoverable — is the cost of being wrong in one direction; a disk that
 * fills with empty clones is the cost of being wrong in the other. They are not
 * the same size. So **every state except a positively established emptiness
 * retains**: no `.git`, no readable base, a sha `cat-file` will not confirm, a
 * git that will not run, a repository format this scratch cannot read — all
 * `undetermined`, all retained, all *saying so* in the line the start prints.
 *
 * A DIRTY WORKING TREE WITH NO COMMITS IS NOT EMPTY. It is the strongest form
 * of finding 92 there is: an uncommitted edit exists in exactly one place on
 * the machine and no object store holds it, so deleting the directory is the
 * only way to destroy it and there is no recovery afterwards. `empty` therefore
 * requires BOTH — `HEAD` at the base AND a working tree git reports as clean,
 * untracked files included.
 *
 * HOW THIS ASKS GIT WITHOUT BREAKING RULING 56.
 *
 *     brigadier runs no git command inside a clone after an agent has had
 *     access to it.
 *
 * That invariant is not bent here, and the reason it would be so easy to bend
 * is the reason for the machinery below: `--git-dir=<clone>/.git` makes git
 * read the clone's `.git/config`, which is the file an agent owns, and
 * `probes/git-exec.sh` MEASURED against `git 2.50.1` on 2026-08-17
 * `core.fsmonitor` executing from it on an ordinary `git status` — a surface
 * `-c core.hooksPath=` does not close.
 *
 * Instead brigadier builds a git directory OF ITS OWN, under its own run root,
 * and points it at the clone's objects with `objects/info/alternates`. An
 * object store is inert: it holds loose files and packs, no config, no hooks,
 * no fsmonitor. Every git command then runs with `--git-dir` at brigadier's
 * scratch, so the config git reads is brigadier's — the clone's is never
 * opened. The working-tree question is asked the same way, with `--work-tree`
 * at the clone and `GIT_INDEX_FILE` at a scratch index: git STATS the agent's
 * files, which is reading, and takes its configuration entirely from
 * brigadier. A `.gitattributes` naming a filter travels with the working tree,
 * and `src/isolation/clone.ts` records it MEASURED inert until the driver
 * exists in config — which here it never does.
 *
 * MEASURED against `git 2.50.1 (Apple Git-155)` and `bun 1.3.14` on macOS
 * 26.5.2 on 2026-08-18, and `test/run-kept.test.ts` is that measurement kept:
 * with `core.fsmonitor` and `core.hooksPath` both planted in a clone's
 * `.git/config`, this inspection answered `uncommitted` and NEITHER payload
 * ran; the same planted content executed on the next command git ran with that
 * `.git` as its git directory. Without the control the first half passes on a
 * payload that never worked.
 *
 * The one thing read out of the clone directly is a REF FILE — `HEAD`,
 * `refs/heads/*`, `packed-refs`. Those are inert text, reading a file is not
 * running a command, and nothing here trusts what they say: a sha from them is
 * a candidate until `git cat-file -t` in brigadier's own repository answers
 * `commit`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { runGit, type Hermetic } from "../isolation/internal-git.ts";
import { BASE_BRANCH } from "../repo/refs.ts";
import { Sink } from "../secrets/sink.ts";

/**
 * What a clone holds, in the four answers ruling 63 can act on.
 *
 * Three of the four retain. That asymmetry is the ruling's, not a preference:
 * only `empty` is a positive finding that nothing would be destroyed.
 */
export type WorkState =
  /** `HEAD` is a commit `cat-file` read back, and it is not the base. Retained. */
  | "committed"
  /** `HEAD` is at the base, and the working tree differs from it. Retained. */
  | "uncommitted"
  /** `HEAD` is at the base and git reports the working tree clean. Reclaimable. */
  | "empty"
  /** Anything brigadier could not establish. Retained, and the line says which. */
  | "undetermined";

export interface CloneWork {
  readonly dir: string;
  readonly state: WorkState;
  /** The commit `git cat-file -t` confirmed, when there is one. */
  readonly commit: string | null;
  /** The base the clone started from, when it could be resolved. */
  readonly base: string | null;
  /** Working-tree paths git reported as differing from the base. Capped for printing. */
  readonly changed: readonly string[];
  /** One sentence naming what was asked and what git answered. Printed. */
  readonly detail: string;
}

/** How many changed paths a retention line names before it stops. */
export const CHANGED_PATHS_SHOWN = 5;

export interface InspectOptions {
  /**
   * Where the scratch git directory is built. brigadier's own run root, never
   * inside a clone.
   */
  readonly runRoot: string;
  /** Injectable so a test can force the "git will not run" branch. */
  readonly git?: typeof runGit;
  /**
   * RULING 65's ONE SINK — the writer every byte leaving this module goes
   * through, redacting the FINAL bytes rather than any field of them.
   *
   * The four files below are git plumbing brigadier composes itself, and it
   * would be easy to argue they are not run text and could take `writeFileSync`
   * directly. `src/secrets/audit.ts` is the answer to that argument: the ruling
   * names the sink being bypassed as the most likely way redaction fails in
   * practice, so the exemption list is short, each entry is justified in terms
   * of the bytes, and "this particular writer is harmless" is how the list
   * stops being short.
   *
   * Defaults to a sink of its own, which writes with the same refusing syscall
   * and an EMPTY inventory. That default is honest about its limit rather than
   * silent: nothing is redacted through it, and the adoption is for
   * `src/queue/execute.ts` to pass the run's sink — which is already carrying
   * the grant by the time `sweepAtStart` is called — down through
   * `StartSweepOptions.sink`.
   */
  readonly sink?: Sink;
}

/**
 * Resolve one ref out of a git directory by reading its files.
 *
 * Loose file first, then `packed-refs` — `git gc` runs `pack-refs`, and
 * `src/isolation/manifest.ts` records that MEASURED against `git 2.50.1` on
 * 2026-08-17 as the reason the in-clone signature could not be the durable
 * record. A resolver that only read loose files would report a gc'd clone as
 * having no base and retain it forever on a technicality.
 *
 * Symbolic refs are followed, with a bound, because a ref file that points at
 * itself is a file an agent can write.
 */
export function resolveRef(gitDir: string, name: string): string | null {
  let current = name;
  for (let hop = 0; hop < 8; hop++) {
    const direct = readTrimmed(join(gitDir, current));
    if (direct !== null) {
      if (direct.startsWith("ref:")) {
        current = direct.slice(4).trim();
        continue;
      }
      if (isSha(direct)) return direct;
      return null;
    }
    const packed = fromPackedRefs(gitDir, current);
    if (packed !== null) return packed;
    return null;
  }
  return null;
}

/** `HEAD`, whether it is symbolic or detached. */
export function resolveHead(gitDir: string): string | null {
  return resolveRef(gitDir, "HEAD");
}

function readTrimmed(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function fromPackedRefs(gitDir: string, name: string): string | null {
  const text = readTrimmed(join(gitDir, "packed-refs"));
  if (text === null) return null;
  for (const line of text.split("\n")) {
    // `^<sha>` is the peeled value of the PREVIOUS line's tag. Never a ref.
    if (line.startsWith("#") || line.startsWith("^")) continue;
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const sha = line.slice(0, space).trim();
    if (line.slice(space + 1).trim() === name && isSha(sha)) return sha;
  }
  return null;
}

function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value);
}

/**
 * Ask git what this clone holds.
 *
 * Never throws: every failure is an answer (`undetermined`) with a sentence
 * naming what could not be established, because the caller's alternative to an
 * answer would be to guess, and one of the two guesses is finding 92.
 */
export async function inspectClone(dir: string, options: InspectOptions): Promise<CloneWork> {
  const gitDir = join(dir, ".git");
  const undetermined = (detail: string, base: string | null = null): CloneWork => ({
    dir,
    state: "undetermined",
    commit: null,
    base,
    changed: [],
    detail,
  });

  let gitDirIsDirectory = false;
  try {
    gitDirIsDirectory = statSync(gitDir).isDirectory();
  } catch {
    gitDirIsDirectory = false;
  }
  if (!gitDirIsDirectory) {
    return undetermined(
      `there is no .git directory at ${gitDir}, so git cannot be asked whether this clone holds ` +
        "committed work. Unknown retains",
    );
  }

  const base = resolveRef(gitDir, `refs/heads/${BASE_BRANCH}`);
  const head = resolveHead(gitDir);
  if (base === null) {
    return undetermined(
      `no readable refs/heads/${BASE_BRANCH} in ${gitDir}, so there is nothing to compare a commit ` +
        "against. Unknown retains",
    );
  }
  if (head === null) {
    return undetermined(`HEAD in ${gitDir} does not resolve to an object name. Unknown retains`, base);
  }

  const scratch = mkdtempSync(join(options.runRoot, "inspect-"));
  try {
    const inspector = buildInspector(scratch, gitDir, base, options.sink ?? new Sink());
    const git = options.git ?? runGit;
    const run = (args: string[], env?: Record<string, string>): ReturnType<typeof runGit> =>
      git({ cwd: scratch, args: [...inspector.prefix, ...args], hermetic: inspector.hermetic, ...(env === undefined ? {} : { env }) });

    // THE READ-BACK. A sha in a ref file is a claim; this is the world's answer
    // to it, and an object the store cannot produce is not work.
    const type = await run(["cat-file", "-t", head]).catch(() => null);
    if (type === null || type.code !== 0 || type.stdout.trim() !== "commit") {
      return undetermined(
        `git cat-file -t ${head} through this clone's own object store did not answer \`commit\` ` +
          `(${type === null ? "git could not be run" : `exit ${type.code}: ${(type.stderr || type.stdout).trim() || "no output"}`}). ` +
          "Unknown retains",
        base,
      );
    }

    if (head !== base) {
      return {
        dir,
        state: "committed",
        commit: head,
        base,
        changed: [],
        detail: `HEAD is commit ${head}, which is not the base ${base}; \`git cat-file -t\` read it back as a commit`,
      };
    }

    // HEAD is the base, so nothing was committed. The working tree is the other
    // place work can be, and it is the place from which nothing can be
    // recovered.
    const index = join(scratch, "index");
    const seeded = await run(["--work-tree", dir, "read-tree", head], { GIT_INDEX_FILE: index }).catch(() => null);
    if (seeded === null || seeded.code !== 0) {
      return undetermined(
        `HEAD is at the base ${base} and the working tree could not be compared against it ` +
          `(\`git read-tree\` ${seeded === null ? "could not be run" : `exited ${seeded.code}: ${(seeded.stderr || seeded.stdout).trim()}`}). ` +
          "Unknown retains",
        base,
      );
    }
    const status = await run(
      ["--work-tree", dir, "status", "--porcelain", "--untracked-files=all"],
      { GIT_INDEX_FILE: index },
    ).catch(() => null);
    if (status === null || status.code !== 0) {
      return undetermined(
        `HEAD is at the base ${base} and \`git status\` against brigadier's own config ` +
          `${status === null ? "could not be run" : `exited ${status.code}: ${(status.stderr || status.stdout).trim()}`}. ` +
          "Unknown retains",
        base,
      );
    }
    const changed = status.stdout
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((path) => path.length > 0);
    if (changed.length > 0) {
      return {
        dir,
        state: "uncommitted",
        commit: null,
        base,
        changed: changed.slice(0, CHANGED_PATHS_SHOWN),
        detail:
          `nothing was committed — HEAD is still the base ${base} — but ${changed.length} path(s) in the ` +
          `working tree differ from it (${changed.slice(0, CHANGED_PATHS_SHOWN).join(", ")}${changed.length > CHANGED_PATHS_SHOWN ? ", …" : ""}). ` +
          "An uncommitted edit exists nowhere else, so this is retained",
      };
    }
    return {
      dir,
      state: "empty",
      commit: null,
      base,
      changed: [],
      detail:
        `HEAD is the base ${base}, no commit was made, and \`git status\` reports the working tree ` +
        "clean including untracked files — there is no copy of anybody's work here",
    };
  } catch (error) {
    return undetermined(
      `asking git about ${dir} raised ${(error as Error).message}. Unknown retains`,
      base,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

interface Inspector {
  readonly prefix: string[];
  readonly hermetic: Hermetic;
}

/**
 * brigadier's own git directory, reading the clone's objects through
 * `objects/info/alternates`.
 *
 * The config written here is the whole point: it is brigadier's, it is three
 * lines, and it is what every command below reads INSTEAD of the file inside
 * the clone. `hermetic` then adds `-c core.hooksPath=<empty dir>`,
 * `GIT_CONFIG_NOSYSTEM=1` and an empty global config, and `runGit` rewrites
 * this file from memory before each spawn — so the config is brigadier's at
 * every level git consults, not merely at the local one.
 *
 * `refs/heads/inspect` holds the BASE, and `HEAD` points at it, so `git status`
 * has a commit to compare against. A repository whose object format this
 * scratch cannot read (a sha-256 clone, say) fails at `cat-file`, which is
 * `undetermined`, which retains.
 */
function buildInspector(scratch: string, cloneGitDir: string, base: string, sink: Sink): Inspector {
  const gitDir = join(scratch, "gitdir");
  mkdirSync(join(gitDir, "objects", "info"), { recursive: true });
  mkdirSync(join(gitDir, "objects", "pack"), { recursive: true });
  mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
  const config = join(gitDir, "config");
  sink.write(config, INSPECTOR_CONFIG);
  sink.write(join(gitDir, "objects", "info", "alternates"), `${join(cloneGitDir, "objects")}\n`);
  sink.write(join(gitDir, "refs", "heads", "inspect"), `${base}\n`);
  sink.write(join(gitDir, "HEAD"), "ref: refs/heads/inspect\n");

  const hooks = join(scratch, "hooks");
  mkdirSync(hooks, { recursive: true });
  const emptyGlobalConfig = join(scratch, "global-config");
  sink.write(emptyGlobalConfig, "");

  return {
    prefix: ["--git-dir", gitDir],
    hermetic: {
      hooksSink: hooks,
      emptyGlobalConfig,
      config: { path: config, known: INSPECTOR_CONFIG },
    },
  };
}

/** brigadier's config for the inspection, and the only one these commands read. */
const INSPECTOR_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n";

/**
 * The four answers in the half-sentence a retention line prints.
 *
 * `committed` names the sha, because that is the thing an operator can act on:
 * `git --git-dir=<clone>/.git cat-file -p <sha>` is the recovery, and a line
 * that said "holds work" would leave them to find it.
 */
export function describeWork(work: { work: WorkState; commit: string | null }): string {
  switch (work.work) {
    case "committed":
      return `HOLDS COMMITTED WORK: commit ${work.commit ?? "?"}`;
    case "uncommitted":
      return "HOLDS UNCOMMITTED working-tree changes";
    case "empty":
      return "holds no work";
    case "undetermined":
      return "brigadier could NOT determine what it holds, so it is kept";
  }
}
