// SPDX-License-Identifier: Apache-2.0
/**
 * Four facts about the operator's repository, captured before brigadier touches
 * it and compared afterwards.
 *
 * Ruling 50's load-bearing claim is that building the base state "provably
 * cannot disturb the operator's uncommitted work". That is not a claim to
 * assert — it is a claim to witness, and the shape of the witness is the one
 * `probes/base-state.sh` used: `git status --porcelain -uall`, the `.git/index`
 * bytes, a hash over the whole working tree, and `HEAD`. That probe runs 28
 * checks, four of them labelled NEGATIVE CONTROL, against `git 2.50.1` on
 * 2026-08-17. (An earlier version of this comment said six. It was counted, not
 * remembered, and it was wrong.)
 *
 * Each of the four catches something the others miss:
 *
 *   - `status` catches a staged or unstaged change appearing or vanishing;
 *   - the index hash catches a change that leaves `status` looking identical
 *     (a `git add` of an already-identical blob, an index refresh);
 *   - the tree hash catches a working-tree write that git does not track at all
 *     — a gitignored file, a file inside an ignored directory;
 *   - `HEAD` catches a checkout, a reset, or a commit.
 *
 * WHAT IT DOES NOT COVER, stated rather than implied: `git add -A` against a
 * temporary index writes new loose objects into the operator's `.git/objects`.
 * None of the four sees them, and that is deliberate — they are unreferenced
 * until `update-ref` publishes the base commit, they are what makes the base
 * commit exist at all, and `git gc` prunes them if the run never finishes.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { git, runGit } from "./internal-git.ts";

export interface OperatorWitness {
  /** `git status --porcelain=v1 -uall`, sorted. */
  status: string;
  /** sha-256 of the `.git/index` bytes, or `"absent"` for a repository with no index yet. */
  indexHash: string;
  /** The commit `HEAD` resolves to, or `"unborn"`. */
  head: string;
  /**
   * sha-256 over every path in the working tree and its contents, `.git`
   * excluded. `null` when it was not captured — see `hashWorkingTree`.
   */
  treeHash: string | null;
}

export interface WitnessOptions {
  /**
   * Hash the whole working tree as well as the cheap three.
   *
   * Default false, and the default is a cost rather than an opinion. The cheap
   * three are three git calls; the tree hash reads every byte of every file
   * outside `.git` — including the gitignored ones, which is the whole reason
   * it catches what the other three cannot — and it runs at least twice per
   * base state.
   *
   * The numbers are measured by `test/isolation-cost.test.ts` rather than
   * quoted here. An earlier version of this comment quoted a witness WITH the
   * hash as cheaper than the hash alone, which is impossible and was the
   * artefact of comparing two runs in two processes with a warm page cache
   * between them. Cost is linear in BYTES rather than in tracked files, so a
   * repository with a large ignored build directory pays most — which is
   * exactly the repository whose operator would most want the check.
   */
  hashWorkingTree?: boolean;
}

/** Capture the four facts. */
export async function witnessOperator(
  repo: string,
  options: WitnessOptions = {},
): Promise<OperatorWitness> {
  // ORDER IS LOAD-BEARING, and it is measurable rather than intermittent.
  // MEASURED against `git 2.50.1` on 2026-08-17: after `touch` on tracked files
  // the index is byte-identical, and the NEXT `git status` rewrites it (the
  // stat cache is refreshed and written back); the status after that leaves it
  // alone. Taking the status first therefore absorbs that write before the hash
  // below, and two consecutive witnesses over an untouched repository agree.
  // Reversed, the first witness hashes the pre-refresh index and the second the
  // post-refresh one, and the guard reports drift that nobody caused —
  // `test/isolation.test.ts` reproduces exactly that with a `utimes` call.
  const status = await git({ cwd: repo, args: ["status", "--porcelain=v1", "-uall"] });
  const gitDir = await git({ cwd: repo, args: ["rev-parse", "--absolute-git-dir"] });
  const indexPath = join(gitDir, "index");
  const headResult = await runGit({ cwd: repo, args: ["rev-parse", "--verify", "-q", "HEAD"] });

  return {
    status: status.split("\n").filter((line) => line.length > 0).sort().join("\n"),
    indexHash: existsSync(indexPath)
      ? createHash("sha256").update(readFileSync(indexPath)).digest("hex")
      : "absent",
    head: headResult.code === 0 ? headResult.stdout.trim() : "unborn",
    treeHash: options.hashWorkingTree === true ? hashWorkingTree(repo) : null,
  };
}

/**
 * What changed between two witnesses, named one per line.
 *
 * Returns an empty array when nothing did. A list rather than a boolean,
 * because "the operator's repository moved" is a report the operator has to be
 * able to act on, and `false` is not one.
 */
export function witnessDrift(before: OperatorWitness, after: OperatorWitness): string[] {
  const drift: string[] = [];
  if (before.status !== after.status) drift.push("git status changed");
  if (before.indexHash !== after.indexHash) drift.push(".git/index changed");
  if (before.head !== after.head) drift.push(`HEAD moved (${before.head} -> ${after.head})`);
  if (before.treeHash !== null && after.treeHash !== null && before.treeHash !== after.treeHash) {
    drift.push("the working tree changed");
  }
  return drift;
}

/**
 * sha-256 over the working tree: every path, and the bytes at it.
 *
 * Directories named `.git` are pruned at every depth, not just the root —
 * git's own bookkeeping churns constantly and a submodule's does too.
 *
 * Symlinks are hashed as their TARGET STRING and never followed. Two
 * consequences, both exercised by `test/isolation.test.ts` against real
 * symlinks in a real fixture rather than asserted here: a symlink loop cannot
 * hang the walk, and retargeting a link is drift even though no file's contents
 * changed.
 */
export function hashWorkingTree(root: string): string {
  const entries: string[] = [];
  walk(root, root, entries);
  entries.sort();
  const digest = createHash("sha256");
  for (const entry of entries) digest.update(entry).update("\n");
  return digest.digest("hex");
}

function walk(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const path = join(dir, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      // Vanished between readdir and lstat. Record the fact rather than
      // throwing: a file that disappears mid-witness IS drift, and a witness
      // that crashes reports nothing at all.
      out.push(`${relative(root, path).split(sep).join("/")}\0vanished`);
      continue;
    }
    const relativePath = relative(root, path).split(sep).join("/");
    if (stat.isDirectory()) {
      out.push(`${relativePath}\0dir`);
      walk(root, path, out);
    } else if (stat.isSymbolicLink()) {
      out.push(`${relativePath}\0link\0${readlinkSync(path)}`);
    } else if (stat.isFile()) {
      out.push(
        `${relativePath}\0file\0${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
      );
    } else {
      out.push(`${relativePath}\0other`);
    }
  }
}
