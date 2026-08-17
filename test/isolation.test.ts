// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 50, exercised against real git in real repositories.
 *
 * Nothing here is mocked, and every assertion is on bytes that exist or do not.
 * v1's finding 41 is that a flag assertion survives a refactor that removes the
 * property, so a containment check names a canary file outside the clone and an
 * ownership check names the literal string ruling 50 fixes — never a value
 * recomputed by the same function the implementation calls, which is a
 * tautology wearing an assertion's clothes.
 *
 * The witness is taken with `hashWorkingTree: true` at EVERY call site in this
 * file. Without it `witnessDrift` silently skips the one of the four facts that
 * catches a gitignored write, which is the fact the other three cannot see.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  OperatorRepoDisturbed,
  buildBaseState,
  hashWorkingTree,
  prepareClone,
  releaseToAgent,
  seedVerdict,
  statusRecords,
  witnessDrift,
  witnessOperator,
} from "../src/isolation/index.ts";

// ---------------------------------------------------------------- fixtures

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}: ${stderr}`);
  return stdout.trim();
}

let scratch: string;
/**
 * Run roots live under `$HOME`, not under `$TMPDIR`.
 *
 * Not fastidiousness: `prepareClone` refuses a temp-rooted run root, because
 * #41 measured a worker in a temp root writing into another clone's tracked
 * file. A suite that had to disable that refusal would be testing a different
 * program.
 */
let runRootHome: string;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-isolation-")));
  const home = join(homedir(), ".brigadier-test");
  mkdirSync(home, { recursive: true });
  runRootHome = realpathSync(mkdtempSync(join(home, "run-")));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(runRootHome, { recursive: true, force: true });
});

/**
 * The operator's repository, in the shape `probes/base-state.sh` measured
 * against, plus the cases that make the flags observable:
 *
 *   - a modification, a deletion, an untracked file;
 *   - an untracked DIRECTORY holding two files, so that `-uall` and `-unormal`
 *     give different counts;
 *   - an ignored directory holding two files plus an ignored log, so that
 *     entry granularity and file granularity give different counts;
 *   - a file that is TRACKED and also matches `.gitignore`, which is the case
 *     that separates the two ways of building the temporary index.
 */
async function operatorRepo(name: string): Promise<string> {
  const repo = join(scratch, name);
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "operator@example.com");
  await git(repo, "config", "user.name", "Operator");

  writeFileSync(join(repo, "committed.txt"), "committed\n");
  writeFileSync(join(repo, "modified.txt"), "original\n");
  writeFileSync(join(repo, "deleted.txt"), "doomed\n");
  writeFileSync(join(repo, ".gitignore"), "ignored/\n*.log\n");
  mkdirSync(join(repo, "ignored"), { recursive: true });
  writeFileSync(join(repo, "ignored", "dep.txt"), "dep\n");
  writeFileSync(join(repo, "ignored", "dep2.txt"), "another dep\n");
  writeFileSync(join(repo, "noise.log"), "noise\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base commit");

  writeFileSync(join(repo, "tracked.log"), "tracked-and-ignored\n");
  await git(repo, "add", "-f", "tracked.log");
  await git(repo, "commit", "-q", "-m", "a tracked file matching .gitignore");

  // The operator's uncommitted work.
  writeFileSync(join(repo, "modified.txt"), "edited by the operator\n");
  rmSync(join(repo, "deleted.txt"));
  writeFileSync(join(repo, "untracked.txt"), "brand new, never added\n");
  mkdirSync(join(repo, "notes"), { recursive: true });
  writeFileSync(join(repo, "notes", "one.md"), "first note\n");
  writeFileSync(join(repo, "notes", "two.md"), "second note\n");
  return repo;
}

const runRoot = (name: string): string => {
  const root = join(runRootHome, name);
  mkdirSync(root, { recursive: true });
  return root;
};

// ------------------------------------------------------- ruling 50: content

describe("the base state carries the operator's uncommitted work", () => {
  let repo: string;
  let tree: string;
  let ref: string;

  beforeAll(async () => {
    repo = await operatorRepo("content");
    const base = await buildBaseState({
      repo,
      runId: "content",
      scratchDir: join(runRoot("content"), "scratch"),
      hashWorkingTree: true,
    });
    tree = base.tree;
    ref = base.ref;
  });

  const inTree = (path: string) => git(repo, "show", `${tree}:${path}`);
  const present = async (path: string) => {
    try {
      await git(repo, "cat-file", "-e", `${tree}:${path}`);
      return true;
    } catch {
      return false;
    }
  };

  test("a tracked modification is in it", async () => {
    expect(await inTree("modified.txt")).toBe("edited by the operator");
  });

  test("untracked, unignored work is in it — including a whole new directory", async () => {
    expect(await inTree("untracked.txt")).toBe("brand new, never added");
    expect(await inTree("notes/one.md")).toBe("first note");
    expect(await inTree("notes/two.md")).toBe("second note");
  });

  test("a deletion is in it", async () => {
    expect(await present("deleted.txt")).toBe(false);
  });

  test("a gitignored dependency is NOT in it, and is never transplanted", async () => {
    expect(await present("ignored/dep.txt")).toBe(false);
    expect(await present("ignored/dep2.txt")).toBe(false);
    expect(await present("noise.log")).toBe(false);
  });

  test("a file that is TRACKED and also ignored survives — the seed is why", async () => {
    expect(await inTree("tracked.log")).toBe("tracked-and-ignored");
  });

  test("the base ref is the literal invisible one, not merely some ref", async () => {
    // Written out rather than recomputed with `baseRef()`. If the namespace
    // moved to `refs/heads/...` the whole invisibility property would go with
    // it, and an assertion that calls the same function as the implementation
    // would follow it there without a word.
    expect(ref).toBe("refs/brigadier/content/base");
    expect(ref.startsWith("refs/heads/")).toBe(false);
    // And it really is invisible where it has to be.
    expect(await git(repo, "branch", "--list", "--format=%(refname)")).not.toContain("brigadier");
    expect(await git(repo, "rev-parse", "--verify", ref)).toMatch(/^[0-9a-f]{40}$/);
  });

  test("NEGATIVE CONTROL: an unseeded temporary index silently drops it", async () => {
    // The naive version, done here with raw git exactly as it would be written
    // by someone who had not read ruling 50: a temporary index with no
    // `read-tree HEAD` seed. `git add -A` then obeys `.gitignore` and the
    // tracked-but-ignored file disappears from the tree — no error, no warning,
    // and a worker that sees a deletion the operator never made.
    const naiveIndex = join(scratch, "naive-index");
    rmSync(naiveIndex, { force: true });
    const child = Bun.spawn(["git", "add", "-A"], {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_INDEX_FILE: naiveIndex },
    });
    expect(await child.exited).toBe(0);
    const naiveTree = (
      await Bun.spawn(["git", "write-tree"], {
        cwd: repo,
        stdout: "pipe",
        env: { ...process.env, GIT_INDEX_FILE: naiveIndex },
      }).stdout.text()
    ).trim();

    const dropped = (await git(repo, "ls-tree", "-r", "--name-only", naiveTree)).split("\n");
    expect(dropped).not.toContain("tracked.log");
    // ...and it is not that the naive tree is empty: it kept everything else.
    expect(dropped).toContain("untracked.txt");
    expect(await present("tracked.log")).toBe(true);
  });

  test("the counts are per file going in and per entry staying out", async () => {
    const base = await buildBaseState({
      repo,
      runId: "counts",
      scratchDir: join(runRoot("counts"), "scratch"),
      hashWorkingTree: true,
    });
    // `untracked.txt`, `notes/one.md`, `notes/two.md`. `-unormal` would say 2,
    // collapsing the directory — which is why ruling 50 names `-uall` and why
    // the fixture has an untracked directory in it.
    expect(base.untrackedIncluded).toBe(3);
    // `ignored/` as one entry, plus `noise.log`. Per FILE this would be 3,
    // because `ignored/` holds two files. The granularity is the claim, so the
    // fixture makes the two numbers different.
    expect(base.ignoredEntriesExcluded).toBe(2);
  });

  test("a staged rename does not derail the untracked count", async () => {
    // `--porcelain=v1 -z` follows a rename record with a second record holding
    // the source path. Consuming it is what stops a source path being counted
    // as its own entry.
    const renamed = await operatorRepo("renamed");
    await git(renamed, "mv", "committed.txt", "renamed.txt");
    const base = await buildBaseState({
      repo: renamed,
      runId: "renamed",
      scratchDir: join(runRoot("renamed"), "scratch"),
      hashWorkingTree: true,
    });
    expect(base.untrackedIncluded).toBe(3);
  });

  test("statusRecords consumes the source path of a rename", () => {
    // Directly, with the bytes git produces: `R  new` then `old`.
    const output = "R  after.txt\0before.txt\0?? untracked.txt\0";
    expect(statusRecords(output)).toEqual(["R  after.txt", "?? untracked.txt"]);
    // Without the consumption, `before.txt` would be a record of its own — and
    // a source path called `?? x` would then be counted as an untracked file.
    expect(statusRecords("R  a\0?? b\0?? real.txt\0")).toEqual(["R  a", "?? real.txt"]);
  });
});

// ------------------------------------------- ruling 50: the operator's tree

describe("the operator's repository is byte-identical throughout", () => {
  test("all four witnessed facts hold across a full build", async () => {
    const repo = await operatorRepo("untouched");
    const before = await witnessOperator(repo, { hashWorkingTree: true });

    await buildBaseState({
      repo,
      runId: "untouched",
      scratchDir: join(runRoot("untouched"), "scratch"),
      hashWorkingTree: true,
    });

    const after = await witnessOperator(repo, { hashWorkingTree: true });
    expect(witnessDrift(before, after)).toEqual([]);
    // Named individually, so a failure says which of the four moved.
    expect(after.status).toBe(before.status);
    expect(after.indexHash).toBe(before.indexHash);
    expect(after.head).toBe(before.head);
    expect(after.treeHash).toBe(before.treeHash);
    expect(before.treeHash).not.toBeNull();
  });

  test("the status is taken with -uall, so a new directory is not one line", async () => {
    const repo = await operatorRepo("statusdepth");
    const witness = await witnessOperator(repo, { hashWorkingTree: true });
    // `-unormal` reports `?? notes/`. The witness has to see the files, or a
    // worker adding 40 files inside an existing untracked directory is one
    // unchanged line.
    expect(witness.status).toContain("?? notes/one.md");
    expect(witness.status).toContain("?? notes/two.md");
    expect(witness.status).not.toContain("?? notes/\n");
  });

  test("two consecutive witnesses agree even when git wants to rewrite the index", async () => {
    // MEASURED against `git 2.50.1` on 2026-08-17: after `touch` on tracked
    // files the index is byte-identical, and the NEXT `git status` refreshes
    // the stat cache and writes it back. The witness takes the status BEFORE
    // hashing the index for exactly this reason; reversed, the first witness
    // hashes the pre-refresh index and the second the post-refresh one, and the
    // guard reports drift nobody caused.
    const repo = await operatorRepo("staleness");
    const future = new Date(Date.now() + 2000);
    for (const file of ["committed.txt", "modified.txt", "tracked.log"]) {
      utimesSync(join(repo, file), future, future);
    }

    const first = await witnessOperator(repo, { hashWorkingTree: true });
    const second = await witnessOperator(repo, { hashWorkingTree: true });
    expect(witnessDrift(first, second)).toEqual([]);
  });

  test("NEGATIVE CONTROL: staging a file on purpose IS caught", async () => {
    const repo = await operatorRepo("staged");
    const before = await witnessOperator(repo, { hashWorkingTree: true });
    await git(repo, "add", "modified.txt");
    const after = await witnessOperator(repo, { hashWorkingTree: true });

    const drift = witnessDrift(before, after);
    expect(drift).toContain(".git/index changed");
    expect(drift).toContain("git status changed");
    // The working tree really did not change — only the index did. A guard that
    // fires on everything is a guard nobody reads.
    expect(drift).not.toContain("the working tree changed");
  });

  test("NEGATIVE CONTROL: a gitignored write nothing else sees IS caught", async () => {
    const repo = await operatorRepo("ignored-write");
    const before = await witnessOperator(repo, { hashWorkingTree: true });
    writeFileSync(join(repo, "ignored", "dep.txt"), "someone rewrote the dependency\n");
    const after = await witnessOperator(repo, { hashWorkingTree: true });

    // `git status` cannot see this. `.git/index` cannot see this. HEAD cannot.
    // This is the one of the four that earns its cost.
    expect(witnessDrift(before, after)).toEqual(["the working tree changed"]);
  });

  test("NEGATIVE CONTROL: a commit IS caught, by the fact that names it", async () => {
    const repo = await operatorRepo("committed");
    const before = await witnessOperator(repo, { hashWorkingTree: true });
    await git(repo, "commit", "-q", "-am", "the operator committed mid-run");
    const after = await witnessOperator(repo, { hashWorkingTree: true });

    const drift = witnessDrift(before, after);
    expect(drift.some((line) => line.startsWith("HEAD moved"))).toBe(true);
    expect(drift.join(" ")).toContain(before.head);
    expect(drift.join(" ")).toContain(after.head);
  });

  test("a retargeted symlink is drift, and a symlink loop does not hang the walk", () => {
    const dir = join(scratch, "symlinks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, "b.txt"), "a\n");
    symlinkSync(join(dir, "a.txt"), join(dir, "link"));
    // A loop: git repositories really do contain these, and a walk that
    // followed links would not return from here.
    symlinkSync(join(dir, "loop"), join(dir, "loop"));

    const before = hashWorkingTree(dir);
    rmSync(join(dir, "link"));
    // Same bytes at the other end, different target string.
    symlinkSync(join(dir, "b.txt"), join(dir, "link"));
    expect(hashWorkingTree(dir)).not.toBe(before);
  });

  test("NEGATIVE CONTROL: a disturbance DURING the temporary index is caught, and named", async () => {
    // MEASURED against `git 2.50.1` on 2026-08-17: `git add -A` executes the
    // repository's configured `filter.*.clean` drivers. This one writes into
    // the working tree, which is drift, and the stage in the error is the whole
    // reason the witness is taken mid-build rather than only at the end.
    const repo = await operatorRepo("filtered");
    const filter = join(scratch, "clean-filter.sh");
    writeFileSync(filter, `#!/bin/sh\nprintf 'x\\n' > "${join(repo, "filter-wrote-this.txt")}"\ncat\n`, {
      mode: 0o755,
    });
    await git(repo, "config", "filter.evil.clean", filter);
    writeFileSync(join(repo, ".gitattributes"), "modified.txt filter=evil\n");

    let thrown: unknown;
    try {
      await buildBaseState({
        repo,
        runId: "filtered",
        scratchDir: join(runRoot("filtered"), "scratch"),
        hashWorkingTree: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(existsSync(join(repo, "filter-wrote-this.txt"))).toBe(true);
    expect(thrown).toBeInstanceOf(OperatorRepoDisturbed);
    expect((thrown as OperatorRepoDisturbed).stage).toBe("building the temporary index");
  });

  test("NEGATIVE CONTROL: a disturbance while PUBLISHING the ref is caught, and named", async () => {
    const repo = await operatorRepo("disturbed");
    // brigadier publishes the base ref with `git update-ref` in the OPERATOR'S
    // repository, and the operator's own `reference-transaction` hook fires on
    // it. Ruling 56 is deliberate that this is not an escalation — it runs with
    // the operator's privileges in the operator's own repository — but it is
    // still a write brigadier's presence caused, and the witness notices.
    const hook = join(repo, ".git", "hooks", "reference-transaction");
    writeFileSync(hook, `#!/bin/sh\nprintf 'x\\n' > "${join(repo, "hook-wrote-this.txt")}"\nexit 0\n`, {
      mode: 0o755,
    });

    let thrown: unknown;
    try {
      await buildBaseState({
        repo,
        runId: "disturbed",
        scratchDir: join(runRoot("disturbed"), "scratch"),
        hashWorkingTree: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(existsSync(join(repo, "hook-wrote-this.txt"))).toBe(true);
    expect(thrown).toBeInstanceOf(OperatorRepoDisturbed);
    expect((thrown as OperatorRepoDisturbed).stage).toBe("publishing the base ref");
    expect((thrown as OperatorRepoDisturbed).drift).toContain("git status changed");
  });
});

// -------------------------------------------------- ruling 50: the scratch index

describe("the temporary index is nowhere near the operator's repository", () => {
  test("a scratch directory inside the repo is refused, and none is created", async () => {
    const repo = await operatorRepo("self-sweep");
    const wanted = join(repo, "scratch");
    await expect(
      buildBaseState({ repo, runId: "self-sweep", scratchDir: wanted }),
    ).rejects.toThrow(/temporary index inside the operator's repository/);
    // The refusal happens before the directory is created. A refusal that first
    // creates the directory it is refusing has already done the thing it exists
    // to prevent — and an empty directory inside the repo is invisible to `git
    // status` and visible to the tree hash, so it would fail a later run's
    // witness for a reason nobody could find.
    expect(existsSync(wanted)).toBe(false);
  });

  test("a symlink that POINTS inside the repo is refused too", async () => {
    // The lexical check cannot see this one: the path is outside by every
    // string comparison. Ruling 61's `realpath` requirement is what catches it,
    // and this is the case that proves the second check is not decoration.
    const repo = await operatorRepo("symlinked-scratch");
    mkdirSync(join(repo, "inside"), { recursive: true });
    const link = join(scratch, "looks-outside");
    rmSync(link, { force: true, recursive: true });
    symlinkSync(join(repo, "inside"), link);

    await expect(
      buildBaseState({ repo, runId: "symlinkedscratch", scratchDir: link }),
    ).rejects.toThrow(/temporary index inside the operator's repository/);
  });

  test("a stale scratch index contributes nothing, on either path", async () => {
    // There used to be a `rm -f` of the leftover index here, justified as "a
    // seed nobody chose". No test could make it matter, so it was deleted and
    // this took its place: the MEASURED behaviour that made it dead.
    //
    // Born HEAD: `read-tree HEAD` replaces the index outright, garbage
    // included. Unborn HEAD: there is no read-tree, and `git add -A` REMOVES
    // entries whose paths are absent from the working tree, so another
    // repository's entries cannot survive into the tree.
    const shared = join(runRoot("stale"), "shared-scratch");
    const born = await operatorRepo("stale-born");
    const first = await buildBaseState({
      repo: born,
      runId: "staleborn",
      scratchDir: shared,
      hashWorkingTree: true,
    });
    expect(existsSync(join(shared, "base-index"))).toBe(true);

    // Garbage, on the born path.
    writeFileSync(join(shared, "base-index"), "this is not an index file\n");
    const second = await buildBaseState({
      repo: born,
      runId: "staleborn2",
      scratchDir: shared,
      hashWorkingTree: true,
    });
    expect(second.tree).toBe(first.tree);

    // A real index from another repository, on the unborn path.
    const unborn = join(scratch, "stale-unborn");
    mkdirSync(unborn, { recursive: true });
    await git(unborn, "init", "-q", "-b", "main");
    await git(unborn, "config", "user.email", "operator@example.com");
    await git(unborn, "config", "user.name", "Operator");
    writeFileSync(join(unborn, "only.txt"), "the first file\n");
    const third = await buildBaseState({
      repo: unborn,
      runId: "staleunborn",
      scratchDir: shared,
      hashWorkingTree: true,
    });
    expect(third.parentless).toBe(true);
    expect(await git(unborn, "ls-tree", "-r", "--name-only", third.tree)).toBe("only.txt");
  });

  test("the base commit is brigadier's, in a repository with no identity at all", async () => {
    // Machinery commits are never attributed to the operator, and a first-day
    // repository with no `user.email` anywhere must still be able to produce
    // one. Both halves of that are the explicit `GIT_AUTHOR_*` environment.
    const repo = await operatorRepo("identity");
    const emptyGlobal = join(scratch, "empty-gitconfig");
    writeFileSync(emptyGlobal, "");
    await git(repo, "config", "--unset", "user.email");
    await git(repo, "config", "--unset", "user.name");

    const restore = { global: process.env["GIT_CONFIG_GLOBAL"], nosystem: process.env["GIT_CONFIG_NOSYSTEM"] };
    process.env["GIT_CONFIG_GLOBAL"] = emptyGlobal;
    process.env["GIT_CONFIG_NOSYSTEM"] = "1";
    try {
      const base = await buildBaseState({
        repo,
        runId: "identity",
        scratchDir: join(runRoot("identity"), "scratch"),
        hashWorkingTree: true,
      });
      expect(await git(repo, "log", "-1", "--format=%an <%ae>", base.sha)).toBe(
        "brigadier <brigadier@localhost>",
      );
    } finally {
      if (restore.global === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
      else process.env["GIT_CONFIG_GLOBAL"] = restore.global;
      if (restore.nosystem === undefined) delete process.env["GIT_CONFIG_NOSYSTEM"];
      else process.env["GIT_CONFIG_NOSYSTEM"] = restore.nosystem;
    }
  });
});

// ---------------------------------------------------- ruling 50: first day

describe("a first-day repository", () => {
  test("an unborn HEAD produces a parentless base commit, and it clones", async () => {
    const repo = join(scratch, "unborn");
    mkdirSync(repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "operator@example.com");
    await git(repo, "config", "user.name", "Operator");
    writeFileSync(join(repo, "only.txt"), "the first file\n");

    const root = runRoot("unborn");
    const base = await buildBaseState({
      repo,
      runId: "unborn",
      scratchDir: join(root, "scratch"),
      hashWorkingTree: true,
    });

    expect(base.parentless).toBe(true);
    expect(await git(repo, "rev-list", "--count", base.sha)).toBe("1");

    const clone = await prepareClone({ base, item: 1, runRoot: root });
    expect(readFileSync(join(clone.dir, "only.txt"), "utf8")).toBe("the first file\n");
    releaseToAgent(clone);
  }, 20_000);

  test("a read-tree failure with a LIVE head is a refusal, not a parentless commit", () => {
    // The cross-check, at the seam. A parentless base commit for a repository
    // that has a parent would turn every file in it into a new file for the
    // worker, and `git read-tree HEAD` exits non-zero for reasons other than an
    // unborn HEAD — a corrupt index, an unwritable path.
    expect(seedVerdict(0, "0123456789abcdef0123456789abcdef01234567")).toBe("seeded");
    expect(seedVerdict(128, "unborn")).toBe("parentless");
    expect(() => seedVerdict(128, "0123456789abcdef0123456789abcdef01234567", "boom")).toThrow(
      /exited 128 but HEAD resolves to/,
    );
  });

  test("KNOWN GAP: with no HEAD to seed from, a staged-and-ignored file is dropped", async () => {
    // Not a passing guard. This pins a measured limitation so that closing it
    // is a visible change rather than a silent one.
    //
    // Ruling 50 fixes the seed as `read-tree HEAD`. On an unborn HEAD there is
    // no HEAD, the temporary index starts empty, and `git add -A` then obeys
    // `.gitignore` — the exact failure the seed exists to prevent, in the one
    // case where the seed cannot be taken.
    const repo = join(scratch, "unborn-staged");
    mkdirSync(repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "operator@example.com");
    await git(repo, "config", "user.name", "Operator");
    writeFileSync(join(repo, ".gitignore"), "*.log\n");
    writeFileSync(join(repo, "secret.log"), "staged before the first commit\n");
    await git(repo, "add", "-f", "secret.log");
    writeFileSync(join(repo, "a.txt"), "plain\n");

    expect(await git(repo, "ls-files")).toBe("secret.log");

    const base = await buildBaseState({
      repo,
      runId: "unbornstaged",
      scratchDir: join(runRoot("unborn-staged"), "scratch"),
      hashWorkingTree: true,
    });
    const contents = (await git(repo, "ls-tree", "-r", "--name-only", base.tree)).split("\n");
    expect(contents).toContain("a.txt");
    expect(contents).not.toContain("secret.log");
  });
});

// ------------------------------------------------------- ruling 50: the clone

describe("the worker's clone", () => {
  let repo: string;
  let root: string;
  let dir: string;

  beforeAll(async () => {
    repo = await operatorRepo("clone");
    root = runRoot("clone");
    const base = await buildBaseState({
      repo,
      runId: "clone",
      scratchDir: join(root, "scratch"),
      hashWorkingTree: true,
    });
    const clone = await prepareClone({ base, item: 1, runRoot: root });
    dir = clone.dir;
  }, 20_000);

  test("sees the operator's modification and untracked work", () => {
    expect(readFileSync(join(dir, "modified.txt"), "utf8")).toBe("edited by the operator\n");
    expect(readFileSync(join(dir, "untracked.txt"), "utf8")).toBe("brand new, never added\n");
    expect(readFileSync(join(dir, "notes", "two.md"), "utf8")).toBe("second note\n");
  });

  test("sees the deletion, and does not get the gitignored dependency", () => {
    expect(existsSync(join(dir, "deleted.txt"))).toBe(false);
    expect(existsSync(join(dir, "ignored", "dep.txt"))).toBe(false);
    expect(existsSync(join(dir, "noise.log"))).toBe(false);
  });

  test("keeps the tracked-but-ignored file", () => {
    expect(readFileSync(join(dir, "tracked.log"), "utf8")).toBe("tracked-and-ignored\n");
  });

  test("starts on `work`, with the base branch beside it for the ownership diff", async () => {
    expect(await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("work");
    expect(await git(dir, "diff", "--name-only", "brigadier-base..HEAD")).toBe("");
  });

  test("NEGATIVE CONTROL: a default clone carries neither the ref nor the work", async () => {
    // Without the explicit fetch the worker would silently get HEAD's content
    // and none of the operator's uncommitted work.
    const naive = join(scratch, "naive-clone");
    rmSync(naive, { recursive: true, force: true });
    await git(scratch, "clone", "-q", "--local", repo, naive);

    let refPresent = true;
    try {
      await git(naive, "rev-parse", "--verify", "refs/brigadier/clone/base");
    } catch {
      refPresent = false;
    }
    expect(refPresent).toBe(false);
    expect(readFileSync(join(naive, "modified.txt"), "utf8")).toBe("original\n");
    expect(existsSync(join(naive, "untracked.txt"))).toBe(false);
  }, 20_000);
});
