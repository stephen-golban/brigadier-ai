// SPDX-License-Identifier: Apache-2.0
/**
 * The base state: HEAD plus the operator's uncommitted tracked AND untracked
 * work, captured as a commit without touching the operator's index or working
 * tree.
 *
 * Ruling 50. Three things about it are not obvious, and each was found by
 * measurement rather than by reasoning.
 *
 * ONE — the seed is load-bearing and the naive version fails SILENTLY. The
 * temporary index must be seeded with `read-tree HEAD` before `git add -A`.
 * Starting from an empty temporary index makes `git add -A` obey `.gitignore`
 * and quietly drop files that are TRACKED and also ignored — a `git add -f`
 * lockfile, a committed `*.log` fixture. The worker then sees a deletion the
 * operator never made, and nothing anywhere reports it. MEASURED
 * (`probes/base-state.sh`, against `git 2.50.1` on 2026-08-17): the seeded
 * index keeps `tracked.log`; the empty index drops it.
 *
 * TWO — `.gitignore` is the only discriminator, and brigadier adds no second
 * one. Untracked-and-not-ignored is the operator's work and goes in.
 * Untracked-and-ignored does not. There is no heuristic here about whether a
 * file "looks like junk", because that would be a guess about someone else's
 * repository. The counts are reported instead, on `BaseState`.
 *
 * THREE — gitignored dependencies are NEVER transplanted into a clone. Not by
 * symlink (ruling 12: Windows), not by `cp -c` (APFS only), not by copying —
 * the 9.82 GB-in-20-minutes failure ruling 50 records — and the reason nobody
 * lists first: a dependency tree is a capability boundary, because postinstall
 * scripts are arbitrary code. Installing in the clone is the worker's business,
 * and there is deliberately no function in this module that copies one in.
 *
 * On an unborn HEAD, `read-tree HEAD` fails non-zero while a parentless
 * `commit-tree` succeeds. That is a first-day repository, not an exotic case,
 * and it is handled here rather than assumed away. MEASURED against
 * `git 2.50.1` on 2026-08-17: `read-tree HEAD` exits 128 there.
 *
 * Every git command in this file runs in the OPERATOR's repository, which is
 * where ruling 56 does not apply — the operator's hooks and filters run with
 * the operator's privileges in the operator's own repository, which is not an
 * escalation. It is not nothing, though, and it is written down rather than
 * implied: MEASURED against `git 2.50.1` on 2026-08-17, `git add -A` against a
 * temporary index EXECUTES the repository's configured `filter.*.clean`
 * drivers, which is how git-lfs works and equally how anything else in that
 * config works. `internal-git.ts` refuses to run any of this against a worker
 * clone, which is the case that would be an escalation.
 *
 * A KNOWN GAP, recorded rather than quietly closed. Ruling 50 fixes the seed as
 * `read-tree HEAD`, and on an unborn HEAD there is no HEAD to seed from — so
 * the temporary index starts empty, `git add -A` obeys `.gitignore`, and a file
 * the operator staged with `git add -f` before their first commit is dropped
 * from the base state exactly the way the unseeded index drops one. MEASURED
 * against `git 2.50.1` on 2026-08-17: in a repository with no commits, a
 * `.gitignore` of `*.log` and `secret.log` staged with `add -f`, the base tree
 * contains `.gitignore` and `a.txt` and not `secret.log`. The narrow fix would
 * be to seed from the operator's real `.git/index` in this one case, which is a
 * change to what ruling 50 specifies and belongs on a ticket rather than in
 * this file. `test/isolation.test.ts` pins the current behaviour so that
 * closing it is a visible change.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { baseRef } from "../repo/refs.ts";
import { git, nulRecords, runGit } from "./internal-git.ts";
import { witnessDrift, witnessOperator, type OperatorWitness, type WitnessOptions } from "./witness.ts";

export interface BaseState {
  /** The operator's repository root, as git resolves it. */
  repo: string;
  runId: string;
  /** `refs/brigadier/<run-id>/base`, published in the operator's repository. */
  ref: string;
  sha: string;
  tree: string;
  /** True when the operator's HEAD was unborn and the base commit has no parent. */
  parentless: boolean;
  /**
   * The `core.autocrlf` the base commit was built under, resolved from the
   * operator's effective config.
   *
   * It must be set explicitly on every clone. #5 MEASURED a mismatch turning a
   * one-line edit into a six-line whole-file diff — invisible in the ordinary
   * case and catastrophic for ruling 51's ownership diff.
   */
  autocrlf: string;
  /** Untracked, not ignored: the operator's work, and it went in. A count, never a judgement. */
  untrackedIncluded: number;
  /**
   * Ignored entries left out. An ENTRY, not a file: git reports a wholly
   * ignored directory as one record, so `node_modules/` counts once.
   */
  ignoredEntriesExcluded: number;
  /** The longest path the clone will have to create. Ruling 61's budget check consumes it. */
  longestPath: string;
}

export interface BaseStateOptions extends WitnessOptions {
  /** The operator's repository. Any path inside it; the root is resolved from it. */
  repo: string;
  runId: string;
  /**
   * Where the temporary index file is written. Must be OUTSIDE the operator's
   * repository — a scratch index inside it would be an untracked file, and
   * `git add -A` would sweep it into the base commit.
   */
  scratchDir: string;
  message?: string;
}

export class OperatorRepoDisturbed extends Error {
  constructor(
    readonly stage: string,
    readonly drift: readonly string[],
  ) {
    super(
      `ruling 50: brigadier disturbed the operator's repository while ${stage} — ${drift.join("; ")}`,
    );
    this.name = "OperatorRepoDisturbed";
  }
}

/**
 * Build and publish the base commit.
 *
 * Every git command here runs in the OPERATOR's repository, which is the one
 * place ruling 56 does not apply: the operator's hooks run with the operator's
 * privileges in the operator's own repository, which is not an escalation and
 * is not brigadier's business to neuter. Ruling 56's invariant is about a clone
 * an agent has had access to. No agent has been anywhere near this.
 */
export async function buildBaseState(options: BaseStateOptions): Promise<BaseState> {
  const repo = realpathSync(await git({ cwd: options.repo, args: ["rev-parse", "--show-toplevel"] }));
  const witnessOptions: WitnessOptions =
    options.hashWorkingTree === undefined ? {} : { hashWorkingTree: options.hashWorkingTree };

  const before = await witnessOperator(repo, witnessOptions);

  const untrackedIncluded = await countUntracked(repo);
  const ignoredEntriesExcluded = await countIgnoredEntries(repo);
  const autocrlf = await effectiveAutocrlf(repo);

  // A scratch index inside the operator's repository is an untracked file, and
  // two lines below is `git add -A`. It would sweep itself into the base
  // commit. Checked TWICE and the order is deliberate: lexically before the
  // directory is created, so that a refusal does not leave a directory behind
  // in a repository this module's whole premise is not to touch; then again by
  // `realpath` afterwards, because a symlink defeats the lexical form and
  // ruling 61 is emphatic about which of the two is authoritative.
  refuseInsideRepo(resolve(options.scratchDir), repo);
  mkdirSync(options.scratchDir, { recursive: true });
  const scratchRoot = realpathSync(options.scratchDir);
  refuseInsideRepo(scratchRoot, repo);

  const scratchIndex = join(scratchRoot, "base-index");
  const scratchEnv = { GIT_INDEX_FILE: scratchIndex };
  // There was a `rm -f` of a leftover index here, justified as "a leftover
  // index from an earlier attempt is a seed nobody chose". It was DELETED
  // rather than kept, because no test could make it matter and the reason is
  // measured rather than argued. MEASURED against `git 2.50.1` on 2026-08-17:
  // with a born HEAD, `read-tree HEAD` replaces the index contents outright,
  // garbage included; with an unborn HEAD there is no read-tree, and `git add
  // -A` REMOVES index entries whose paths are absent from the working tree, so
  // a stale index from a different repository contributed nothing to the tree.
  // A guard that cannot fail looks exactly like one that works.

  // THE SEED. A non-zero exit is expected on an unborn HEAD and nowhere else,
  // so it is cross-checked rather than inferred: the witness already resolved
  // HEAD a few lines above, and disagreement between the two means something
  // this function does not understand is wrong with the repository. Reporting
  // that is better than building a parentless base commit for a repository
  // that has a parent. MEASURED against `git 2.50.1` on 2026-08-17: `read-tree
  // HEAD` exits 128 against an unborn HEAD.
  const seed = await runGit({ cwd: repo, args: ["read-tree", "HEAD"], env: scratchEnv });
  const parentless = seedVerdict(seed.code, before.head, seed.stderr) === "parentless";

  await git({ cwd: repo, args: ["add", "-A"], env: scratchEnv });

  // DURING, not just after. `git add -A` is the step that could plausibly write
  // to the real index, and a check that only runs at the end cannot say which
  // step did it.
  assertUndisturbed("building the temporary index", before, await witnessOperator(repo, witnessOptions));

  const tree = await git({ cwd: repo, args: ["write-tree"], env: scratchEnv });
  const message = options.message ?? `brigadier base state for run ${options.runId}`;
  const sha = await git({
    cwd: repo,
    args: parentless
      ? ["commit-tree", tree, "-m", message]
      : ["commit-tree", tree, "-p", "HEAD", "-m", message],
    env: {
      // An explicit identity, so that a repository with no `user.email`
      // configured — a first-day repository again — does not fail here, and so
      // that machinery commits are never attributed to the operator.
      GIT_AUTHOR_NAME: "brigadier",
      GIT_AUTHOR_EMAIL: "brigadier@localhost",
      GIT_COMMITTER_NAME: "brigadier",
      GIT_COMMITTER_EMAIL: "brigadier@localhost",
    },
  });

  const ref = baseRef(options.runId);
  await git({ cwd: repo, args: ["update-ref", ref, sha] });

  const longestPath = longest([
    ...(await listTracked(repo)),
    ...(await listTree(repo, tree)),
  ]);

  assertUndisturbed("publishing the base ref", before, await witnessOperator(repo, witnessOptions));

  return {
    repo,
    runId: options.runId,
    ref,
    sha,
    tree,
    parentless,
    autocrlf,
    untrackedIncluded,
    ignoredEntriesExcluded,
    longestPath,
  };
}

/**
 * What a `read-tree HEAD` exit code means, cross-checked against HEAD.
 *
 * Its own function because the interesting branch is the third one, and an
 * inline `if` inside a 60-line async function is a branch no test can reach
 * without contriving a filesystem failure. A non-zero exit is expected on an
 * unborn HEAD and nowhere else; if HEAD resolves and `read-tree` still failed,
 * something is wrong with the repository that this module does not understand,
 * and building a PARENTLESS base commit for a repository that has a parent
 * would turn every file in it into a new file for the worker.
 */
export function seedVerdict(
  readTreeCode: number,
  headBefore: string,
  stderr = "",
): "seeded" | "parentless" {
  if (readTreeCode === 0) return "seeded";
  if (headBefore === "unborn") return "parentless";
  throw new Error(
    `refusing to build a base state: \`git read-tree HEAD\` exited ${readTreeCode} but HEAD ` +
      `resolves to ${headBefore}. ${stderr.trim()}`,
  );
}

function refuseInsideRepo(candidate: string, repo: string): void {
  if (candidate === repo || candidate.startsWith(repo + sep)) {
    throw new Error(
      `refusing a temporary index inside the operator's repository: ${candidate}. ` +
        "`git add -A` would sweep it into the base commit.",
    );
  }
}

function assertUndisturbed(stage: string, before: OperatorWitness, after: OperatorWitness): void {
  const drift = witnessDrift(before, after);
  if (drift.length > 0) throw new OperatorRepoDisturbed(stage, drift);
}

/**
 * The operator's effective `core.autocrlf`.
 *
 * `git config --get` searches system, global and local and returns whichever
 * value is effective, which is the value the base commit is actually built
 * under. Absent from all three, git's documented built-in default is `false`.
 *
 * Not measured here and therefore not claimed here: what a Windows installer
 * puts in the system config. This was written on macOS, and #5's finding is
 * about a MISMATCH between the two sides rather than about any particular
 * value — so the code reads whatever is effective and writes that same string
 * onto the clone, which is correct without knowing what it will be.
 */
async function effectiveAutocrlf(repo: string): Promise<string> {
  const result = await runGit({ cwd: repo, args: ["config", "--get", "core.autocrlf"] });
  const value = result.stdout.trim();
  return result.code === 0 && value.length > 0 ? value : "false";
}

/**
 * `??` records from `-uall`: every untracked, non-ignored file, individually.
 *
 * `-uall` and not the default: `-unormal` collapses an untracked DIRECTORY to
 * one record, so a worker that received 40 new files would be reported as
 * having received one. Ruling 50 names `-uall`, and `test/isolation.test.ts`
 * has an untracked directory in the fixture so that the difference is
 * observable rather than stipulated.
 */
async function countUntracked(repo: string): Promise<number> {
  const output = await git({ cwd: repo, args: ["status", "--porcelain=v1", "-uall", "-z"] });
  return statusRecords(output).filter((record) => record.startsWith("?? ")).length;
}

/**
 * `!!` records at directory granularity.
 *
 * Deliberately `-unormal` here, and deliberately `-uall` above, because the two
 * counts answer different questions. What went IN must be counted per file:
 * that is the operator's work. What stayed OUT is reported so the operator can
 * see how much `.gitignore` excluded, and a wholly ignored directory is one
 * fact, not thousands.
 *
 * MEASURED against `git 2.50.1` on 2026-08-17, 3,000 gitignored files under one
 * ignored directory: `-unormal --ignored` reports 1 entry, `-uall --ignored`
 * reports 3,000. Both took 12 ms at that size — so this is a choice about what
 * the number MEANS, and the earlier version of this comment, which justified it
 * on speed, was wrong. The record count is the honest reason.
 */
async function countIgnoredEntries(repo: string): Promise<number> {
  const output = await git({
    cwd: repo,
    args: ["status", "--porcelain=v1", "-unormal", "--ignored", "-z"],
  });
  return statusRecords(output).filter((record) => record.startsWith("!! ")).length;
}

/**
 * Split `--porcelain=v1 -z` output into status records.
 *
 * A rename or copy record is followed by a second record holding the source
 * path. Consuming it here keeps a file called `?? something` from being
 * counted as an untracked file.
 */
export function statusRecords(output: string): string[] {
  const raw = nulRecords(output);
  const records: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const record = raw[i]!;
    records.push(record);
    const x = record[0];
    const y = record[1];
    if (x === "R" || x === "C" || y === "R" || y === "C") i++;
  }
  return records;
}

async function listTracked(repo: string): Promise<string[]> {
  return nulRecords(await git({ cwd: repo, args: ["ls-files", "-z"] }));
}

/**
 * The paths the base commit actually carries.
 *
 * Ruling 61 says `git ls-files`, and `listTracked` above is that. This is the
 * union with the base tree, and the union is not a re-decision: the base
 * commit's whole point is that it also carries the operator's UNTRACKED work,
 * so the longest path a clone will create can be a path `ls-files` has never
 * heard of. Taking the longer of the two can only refuse earlier, never later.
 */
async function listTree(repo: string, tree: string): Promise<string[]> {
  return nulRecords(await git({ cwd: repo, args: ["ls-tree", "-r", "--name-only", "-z", tree] }));
}

function longest(paths: readonly string[]): string {
  let best = "";
  for (const path of paths) if (path.length > best.length) best = path;
  return best;
}
