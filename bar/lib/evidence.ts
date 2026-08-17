// SPDX-License-Identifier: Apache-2.0
/**
 * Proof that a run happened, taken with `git` rather than from stdout.
 *
 * This module exists because of one reproduced finding: a fake brigadier whose
 * whole behaviour was `console.log` plus a hand-written 41-byte
 * `.git/refs/heads/brigadier/run-0001` scored 10 of 13 against this harness's
 * first draft. The ref FILE existed. Nothing behind it did.
 *
 * So nothing here reads a ref file. Every assertion goes through a real `git`
 * process run by the harness, in this order, because each step catches
 * something the previous one cannot:
 *
 *   `rev-parse`     the ref resolves to an object id at all
 *   `cat-file -t`   that object exists in the store, and is a commit
 *   `fsck`          the commit's tree and parents are reachable — this is the
 *                   one a hand-written ref file fails, and it fails loudly
 *   `log --format`  the history carries one commit per plan item
 *   `cat-file blob` the merged tree holds the exact bytes a worker was asked to
 *                   write, which are a token generated after the binary was
 *                   built and cannot be baked into it
 *
 * The last step is the load-bearing one. A liar can create a ref by doing real
 * git work — and if it does real git work with the worker's real output in it,
 * it has done the work, which is the whole point of the bar.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { Checks, excerpt } from "./checks.ts";
import { parseRecord, recordPathFrom, type RunRecord } from "./contract.ts";
import { exec } from "./proc.ts";

async function git(repo: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const result = await exec(["git", ...args], { cwd: repo, timeoutMs: 120_000 });
  return { ok: result.code === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}

export async function revParse(repo: string, ref: string): Promise<string | undefined> {
  const result = await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.ok && result.out.length === 40 ? result.out : undefined;
}

export async function objectType(repo: string, sha: string): Promise<string | undefined> {
  const result = await git(repo, ["cat-file", "-t", sha]);
  return result.ok ? result.out : undefined;
}

/**
 * The check a hand-written ref cannot survive.
 *
 * `--connectivity-only` walks from every ref to every object it names. A ref
 * pointing at an object id that was never written comes back as
 * `broken link` / `missing commit`, and no amount of printing fixes it.
 */
export async function fsck(repo: string): Promise<string> {
  const result = await git(repo, ["fsck", "--no-progress", "--connectivity-only", "--strict"]);
  const noise = /dangling|notice:/i;
  const problems = `${result.out}\n${result.err}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !noise.test(l));
  return problems.join("; ");
}

export async function commitSubjects(repo: string, ref: string): Promise<string[]> {
  const result = await git(repo, ["log", "--format=%s", ref]);
  return result.ok ? result.out.split("\n").filter((l) => l.length > 0) : [];
}

export async function commitParents(repo: string, sha: string): Promise<string[]> {
  const result = await git(repo, ["rev-list", "--parents", "-n", "1", sha]);
  return result.ok ? result.out.split(/\s+/).slice(1) : [];
}

/** Every path in a ref's tree, with its bytes. Used for content and secret scans. */
export async function treeFiles(repo: string, ref: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const listing = await git(repo, ["ls-tree", "-r", "--name-only", ref]);
  if (!listing.ok) return files;
  for (const path of listing.out.split("\n").filter((l) => l.length > 0)) {
    const blob = await git(repo, ["cat-file", "blob", `${ref}:${path}`]);
    if (blob.ok) files.set(path, blob.out);
  }
  return files;
}

export async function refList(repo: string): Promise<string[]> {
  const result = await git(repo, ["for-each-ref", "--format=%(refname)"]);
  return result.ok ? result.out.split("\n").filter((l) => l.length > 0) : [];
}

/**
 * Ruling 61: by `realpath`, never lexically — macOS's `/var` → `/private/var`
 * symlink is the whole reason the ruling says so.
 *
 * A path that does not exist still has to be resolvable, and getting that wrong
 * is not academic: a report naming a run directory that was never created is
 * precisely what a fabricating binary produces, and an early version of this
 * function let exactly that case through. `realpathSync` throws on a missing
 * path, so this resolves the nearest ancestor that DOES exist and re-appends the
 * rest.
 */
export function resolveThroughSymlinks(path: string): string {
  const parts = path.split("/");
  for (let i = parts.length; i > 0; i--) {
    const head = parts.slice(0, i).join("/") || "/";
    try {
      const real = realpathSync(head);
      const tail = parts.slice(i);
      return tail.length === 0 ? real : `${real}/${tail.join("/")}`;
    } catch {
      // Not there either; try a shorter prefix.
    }
  }
  return path;
}

export function insideTempRoot(path: string): string | undefined {
  const roots = [tmpdir(), "/tmp", process.env["TMPDIR"] ?? ""].filter((r) => r.length > 0);
  const real = resolveThroughSymlinks(path);
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(`${realRoot}/`)) return `${real} is under ${realRoot}`;
  }
  return undefined;
}

export interface RunEvidence {
  report: string;
  recordPath: string | undefined;
  recordExists: boolean;
  record: RunRecord | undefined;
  refSha: string | undefined;
  refType: string | undefined;
  fsckProblems: string;
  subjects: string[];
  files: Map<string, string>;
  refsAfter: string[];
}

/**
 * Everything downstream assertions need, gathered once with real `git`.
 *
 * Deliberately tolerant: every field can be absent, because a run that did not
 * happen must produce an EVIDENCED failure rather than an exception. An item
 * that throws has measured nothing.
 */
export async function gatherRunEvidence(repo: string, report: string): Promise<RunEvidence> {
  const recordPath = recordPathFrom(report);
  const recordExists = recordPath !== undefined && existsSync(recordPath);
  const record = recordExists && recordPath ? parseRecord(readFileSync(recordPath, "utf8")) : undefined;
  const ref = record?.integrationRef;
  const refSha = ref ? await revParse(repo, ref) : undefined;

  return {
    report,
    recordPath,
    recordExists,
    record,
    refSha,
    refType: refSha ? await objectType(repo, refSha) : undefined,
    fsckProblems: await fsck(repo),
    subjects: ref && refSha ? await commitSubjects(repo, ref) : [],
    files: ref && refSha ? await treeFiles(repo, ref) : new Map(),
    refsAfter: await refList(repo),
  };
}

export interface WorkExpectation {
  /** Path → the exact token the plan asked a worker to write. Generated per run. */
  expected: Map<string, string>;
  /** Plan item ids that must appear as commits in the integration history. */
  itemIds: string[];
}

/**
 * The positive half every item needs: a run genuinely happened.
 *
 * Without this an item like "no foreign config file changed" passes trivially,
 * because nothing ran between the two hashes. An absence that predates the run
 * proves nothing, and that was true of five items in the first draft.
 */
export function proofOfWork(e: RunEvidence, expect: WorkExpectation): Checks {
  const checks = new Checks();

  checks.expect(
    "the run names a record on disk, and it is there",
    e.recordExists && e.record !== undefined,
    `run-record: ${e.recordPath ?? "NOT NAMED in the report"}; exists: ${e.recordExists}; parsed: ${e.record !== undefined}`,
  );
  checks.expect(
    "the integration ref resolves to a real commit object",
    e.refSha !== undefined && e.refType === "commit",
    `${e.record?.integrationRef ?? "no ref named"} -> ${e.refSha ?? "unresolvable"} (git cat-file -t: ${e.refType ?? "no object"})`,
  );
  // The check a 41-byte hand-written ref file cannot pass.
  checks.expect(
    "the repository survives `git fsck --connectivity-only --strict`",
    e.fsckProblems.length === 0,
    e.fsckProblems.length === 0 ? "no broken links, no missing objects" : e.fsckProblems,
  );

  const missingCommits = expect.itemIds.filter((id) => !e.subjects.some((s) => s.includes(id)));
  checks.expect(
    "the integration history carries one commit per plan item",
    expect.itemIds.length > 0 && missingCommits.length === 0,
    `expected ${expect.itemIds.join(", ")}; git log --format=%s gave ${e.subjects.join(" | ") || "nothing"}`,
  );

  // The bytes. These tokens are generated after the binary was built, so they
  // cannot be baked in, and they are reachable only through the object store.
  const wrong: string[] = [];
  for (const [path, token] of expect.expected) {
    const actual = e.files.get(path);
    if (actual === undefined) wrong.push(`${path}: absent from the merged tree`);
    else if (!actual.includes(token)) wrong.push(`${path}: ${excerpt(actual, 60)} does not contain ${token}`);
  }
  checks.expect(
    "the merged tree contains every worker's actual output",
    expect.expected.size > 0 && wrong.length === 0,
    wrong.length === 0
      ? `${expect.expected.size} path(s) verified with \`git cat-file blob\`: ${[...expect.expected.keys()].join(", ")}`
      : wrong.join("; "),
  );

  const runRoot = e.record?.runRoot;
  checks.expect(
    "the run directory is outside every temp root (ruling 61, by realpath)",
    runRoot !== undefined && insideTempRoot(runRoot) === undefined,
    runRoot === undefined ? "the record names no run root" : (insideTempRoot(runRoot) ?? `${runRoot} is outside /tmp and $TMPDIR`),
  );

  return checks;
}

/** Bytes on disk at a path, or `undefined`. Ruling 63 reports a retained clone with both. */
export function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}
