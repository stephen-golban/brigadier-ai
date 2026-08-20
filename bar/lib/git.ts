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

export interface Placement {
  path: string;
  value: string;
  placement: "committed" | "uncommitted-tracked" | "untracked" | "gitignored";
}

/**
 * Plant nonces into a repository in every shape a clone must — and must not —
 * carry them.
 *
 * The three placements are not decoration. Ruling 33 repairs ruling 7 by
 * carrying the owner's uncommitted TRACKED and UNTRACKED work into each clone,
 * and ruling 50 keeps gitignored content out of the base commit entirely. A
 * product that dropped any one of the three would still look correct on a
 * repository whose seeds were all committed, which is precisely how ruling 7
 * lost the mechanism in the first place.
 *
 * `uncommitted-tracked` is committed with a placeholder first and then modified,
 * so the working-tree value is genuinely different from the value at `HEAD` —
 * a clone that checked out `HEAD` rather than the scratch base commit yields the
 * placeholder and the derivation comes out wrong.
 */
export async function plantSeeds(repo: string, seeds: readonly Placement[]): Promise<void> {
  const committedFirst = seeds.filter((s) => s.placement === "committed" || s.placement === "uncommitted-tracked");
  for (const seed of committedFirst) {
    await Bun.write(join(repo, seed.path), seed.placement === "committed" ? `${seed.value}\n` : "PLACEHOLDER-AT-HEAD\n");
  }
  const ignored = seeds.filter((s) => s.placement === "gitignored");
  if (ignored.length > 0) {
    await Bun.write(join(repo, ".gitignore"), `${ignored.map((s) => s.path).join("\n")}\n`);
  }
  if (committedFirst.length > 0 || ignored.length > 0) {
    await exec(["git", "add", "-A"], { cwd: repo });
    await exec(
      ["git", "-c", "user.name=bar", "-c", "user.email=bar@example.invalid", "commit", "-q", "-m", "seeds"],
      { cwd: repo },
    );
  }

  for (const seed of seeds) {
    if (seed.placement === "committed") continue;
    await Bun.write(join(repo, seed.path), `${seed.value}\n`);
  }
}

/**
 * The bytes a checkout of `text` is expected to hold, in the working tree of
 * `dir`, given that repository's effective `core.autocrlf`.
 *
 * **WHY THIS IS NOT "NORMALISE THE LINE ENDINGS AND COMPARE".** Git for Windows
 * sets `core.autocrlf=true` in the SYSTEM config, so on `windows-latest` every
 * checkout of an LF-committed file lands as CRLF. That is git working exactly as
 * configured — `BaseState.autocrlf` exists to record it — and #5 measured the
 * cost of getting it wrong in the other direction: `core.autocrlf=false` turning
 * a one-line edit into a six-line whole-file diff. VERIFIED on `windows-latest`
 * on 2026-08-20, six assertions in `test/isolation.test.ts`,
 * `test/isolation-recycle.test.ts` and `test/integrate.test.ts` failed with
 * `Expected - 0 / Received + 0`, which is a single `\r` and nothing else.
 *
 * Stripping `\r` before comparing would make every one of those assertions pass
 * AND make them unable to notice a product that mangled line endings. This
 * instead asks the repository what it is configured to do and demands EXACTLY
 * that: LF where `autocrlf` is off, CRLF where it is on. The assertion stays as
 * strict as it was on POSIX and becomes true on Windows for a stated reason.
 *
 * **What it deliberately does not model:** `.gitattributes` (`text`, `eol`,
 * `binary`) and `core.eol`, either of which overrides `core.autocrlf` per path.
 * No fixture repository in this suite has a `.gitattributes`, and a helper that
 * pretended to reimplement git's full attribute resolution would be a second,
 * drifting copy of it. A repository that grows one must assert against `git
 * check-attr` rather than against this.
 */
export function checkedOut(text: string, dir: string): string {
  const result = Bun.spawnSync(["git", "-C", dir, "config", "--get", "core.autocrlf"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const value = new TextDecoder().decode(result.stdout).trim();
  // `--get` searches system, global and local and returns whichever is
  // effective. Absent from all three, git's documented default is `false`.
  const autocrlf = result.exitCode === 0 && value.length > 0 ? value : "false";
  // `input` converts on COMMIT and never on checkout, so a working tree under it
  // holds LF — the same as `false` for this question, and different for a
  // different one.
  if (autocrlf !== "true") return text;
  // Normalise first, so a text that already carries CRLF does not become CRCRLF.
  return text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}
