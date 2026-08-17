// SPDX-License-Identifier: Apache-2.0
/**
 * A repository's state, captured four ways.
 *
 * `BAR.md` item 4 asks for the operator's own repository to be byte-identical
 * after a run: `git status --porcelain -uall`, the hash of `.git/index`, a hash
 * over the whole working tree, and `HEAD`, taken before and asserted after.
 *
 * `git for-each-ref` is captured too, and it is the sharp one. Ruling 51
 * measured that a worker can push into the operator's repository through the
 * clone's own `origin`, and that removing the remote is a speed bump rather than
 * a boundary — so a ref that appeared and was not one brigadier created is the
 * signal, and no other capture here would notice it.
 *
 * `-uall` rather than the default `-unormal` matters: the default collapses an
 * untracked directory to one line, so a worker that wrote fifty files into a new
 * directory in the operator's tree would show up as one entry that looks like
 * the directory itself.
 */

import { join } from "node:path";
import { hashFile, hashTree } from "./fs.ts";
import { exec } from "./proc.ts";

export interface RepoState {
  head: string;
  status: string;
  refs: string;
  indexHash: string;
  treeHash: string;
}

async function git(repo: string, args: string[]): Promise<string> {
  const result = await exec(["git", ...args], { cwd: repo, timeoutMs: 60_000 });
  if (result.code !== 0) return `<git ${args.join(" ")} failed: exit ${result.code} ${result.stderr.trim()}>`;
  return result.stdout;
}

export async function captureRepo(repo: string): Promise<RepoState> {
  return {
    head: (await git(repo, ["rev-parse", "HEAD"])).trim(),
    status: await git(repo, ["status", "--porcelain", "-uall"]),
    refs: await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    indexHash: hashFile(join(repo, ".git", "index")),
    // `.git` is excluded from the tree hash because the index and the refs are
    // captured separately and with meaning; hashing the object store as one blob
    // would make every capture differ for reasons nobody can read.
    treeHash: hashTree(repo, (name) => name === ".git"),
  };
}

export interface RepoDiff {
  field: keyof RepoState;
  before: string;
  after: string;
}

export function diffRepo(before: RepoState, after: RepoState): RepoDiff[] {
  const fields: Array<keyof RepoState> = ["head", "status", "refs", "indexHash", "treeHash"];
  return fields
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

/** Refs present after but not before. Ruling 51's check. */
export function newRefs(before: RepoState, after: RepoState): string[] {
  const seen = new Set(before.refs.split("\n").map((l) => l.trim()).filter(Boolean));
  return after.refs
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !seen.has(l));
}

/** A throwaway repository with one commit, for items that need an operator tree. */
export async function makeRepo(dir: string, files: Record<string, string>): Promise<void> {
  await exec(["git", "init", "-q", "-b", "main", dir], { timeoutMs: 60_000 });
  for (const [name, contents] of Object.entries(files)) {
    await Bun.write(join(dir, name), contents);
  }
  await exec(["git", "add", "-A"], { cwd: dir });
  await exec(
    ["git", "-c", "user.name=bar", "-c", "user.email=bar@example.invalid", "commit", "-q", "-m", "base"],
    { cwd: dir },
  );
}
