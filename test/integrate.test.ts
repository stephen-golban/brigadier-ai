// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 51's integration, exercised against real git on real repositories.
 *
 * Nothing here is mocked. Every assertion is on bytes that exist or do not: the
 * merged tree read back through `git cat-file`, the branch resolved through
 * `git rev-parse`, and the operator's working tree hashed before and after.
 * v1's finding 41 is that a flag assertion survives a refactor that removes the
 * property, so no test here asks the implementation what it thinks it did.
 *
 * Every guard has a negative control (ruling 62b), and each is labelled. A
 * guard that always passes looks identical to a working one.
 *
 * MEASURED against `git 2.50.1` on 2026-08-17, macOS 25.5.0 — every fact this
 * file asserts is re-measured on the machine that runs it, and the version is
 * printed by `git --version` in the first test so a failure elsewhere can be
 * attributed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  applyRefTransaction,
  assertLocalPathTransport,
  assertPublishCommand,
  assertNoWorkingTreeCommand,
  assertOwnedRef,
  assertUsableDeclaration,
  attemptable,
  CyclicPlan,
  discardGateClone,
  GitTooOld,
  headline,
  initialIntegrationCheck,
  integrateWave,
  ItemRefOccupied,
  isDeclared,
  judgeOwnership,
  meetsFloor,
  parentGit,
  parseGitVersion,
  parseMergeTree,
  planWaves,
  RefRefused,
  renderRun,
  runIntegrationGate,
  runSucceeded,
  PARENT_COMMANDS,
  subcommandOf,
  transactionStdin,
  versionRefusal,
  waveBoundary,
  WorkingTreeCommandRefused,
  type RefEntry,
  type WaveIntegration,
} from "../src/integrate/index.ts";
import { deleteRefArgv, integrationBranch, isDeletableRef, itemRef } from "../src/repo/refs.ts";
import { succeeded } from "../src/work/check.ts";

// ---------------------------------------------------------------- fixtures

interface Raw {
  code: number;
  stdout: string;
  stderr: string;
}

/** Raw git, straight out of the test. Deliberately not the module under test. */
async function rawGit(cwd: string, ...args: string[]): Promise<Raw> {
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
  return { code: await child.exited, stdout, stderr };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await rawGit(cwd, ...args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${result.code}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

let scratch: string;
/**
 * Ruling 61: the gate clone is where merged, agent-written code executes, so
 * its run root may not be inside a temp region — `runIntegrationGate` refuses
 * one, and a suite that disabled that refusal would be testing a different
 * program. Operator repositories and worker clones are ordinary directories and
 * live under `$TMPDIR` quite happily.
 */
let runRootHome: string;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-integrate-")));
  const home = join(homedir(), ".brigadier-test");
  mkdirSync(home, { recursive: true });
  runRootHome = realpathSync(mkdtempSync(join(home, "integrate-")));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(runRootHome, { recursive: true, force: true });
});

interface Scenario {
  repo: string;
  base: string;
  runId: string;
  /** A worker clone with `work` committed and `origin` removed, as ruling 51 leaves it. */
  clone: (name: string, edits: Record<string, string | null>) => Promise<string>;
}

let scenarioCount = 0;

async function scenario(files: Record<string, string>): Promise<Scenario> {
  const id = `s${++scenarioCount}`;
  const repo = join(scratch, `parent-${id}`);
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "operator@example.com");
  await git(repo, "config", "user.name", "Operator");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  const base = await git(repo, "rev-parse", "HEAD");

  return {
    repo,
    base,
    runId: `run${id}`,
    clone: async (name, edits) => {
      const dir = join(scratch, `clone-${id}-${name}`);
      await git(scratch, "clone", "-q", "--local", repo, dir);
      await git(dir, "config", "user.email", "worker@example.com");
      await git(dir, "config", "user.name", "Worker");
      await git(dir, "checkout", "-q", "-b", "work");
      for (const [path, content] of Object.entries(edits)) {
        if (content === null) rmSync(join(dir, path), { force: true });
        else {
          mkdirSync(join(dir, path, ".."), { recursive: true });
          writeFileSync(join(dir, path), content);
        }
      }
      await git(dir, "add", "-A");
      // A worker that changed no tracked file leaves `work` at the base commit,
      // which is what a `read-only` item looks like from the parent. Committing
      // an empty commit here would be the test inventing a state.
      if ((await git(dir, "status", "--porcelain", "-uall")).length > 0) {
        await git(dir, "commit", "-q", "-m", `agent work: ${name}`);
      }
      // Ruling 51's speed bump, applied by `prepareClone` in production.
      await git(dir, "remote", "remove", "origin");
      return dir;
    },
  };
}

/** The four facts, plus a hash over the whole working tree. */
async function witness(repo: string): Promise<Record<string, string>> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === ".git") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(`${relative(repo, path)}:${Bun.hash(readFileSync(path)).toString(16)}`);
    }
  };
  walk(repo);
  return {
    status: (await git(repo, "status", "--porcelain", "-uall")).split("\n").sort().join("\n"),
    index: Bun.hash(readFileSync(join(repo, ".git", "index"))).toString(16),
    head: await git(repo, "rev-parse", "HEAD"),
    tree: files.join("\n"),
  };
}

async function refs(repo: string): Promise<string[]> {
  const listed = await git(repo, "for-each-ref", "--format=%(refname)");
  return listed.length === 0 ? [] : listed.split("\n").sort();
}

const outcomes = (wave: WaveIntegration): Record<number, string> =>
  Object.fromEntries(wave.items.map((item) => [item.item, item.outcome]));

// ------------------------------------------------------- the whole loop

describe("ruling 51: the parent fetches, merges without a working tree, publishes once", () => {
  test("two disjoint items merge into a real branch, and the operator's tree never moves", async () => {
    const version = await git(scratch, "--version");
    // Printed, so a failure anywhere in this file can be attributed to a
    // version rather than guessed at. AGENTS.md: never present tense.
    expect(version).toContain("git version");

    const s = await scenario({ "a.txt": "a\n", "b.txt": "b\n", "shared.txt": "s\n" });
    // The operator leaves uncommitted work behind, exactly as they would.
    writeFileSync(join(s.repo, "a.txt"), "a\nUNCOMMITTED\n");
    writeFileSync(join(s.repo, "untracked.txt"), "operator's scratch\n");
    const before = await witness(s.repo);
    const refsBefore = await refs(s.repo);

    const one = await s.clone("one", { "a.txt": "item one\n" });
    const two = await s.clone("two", { "b.txt": "item two\n" });

    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [
        { item: 1, clone: one, declaredPaths: ["a.txt"] },
        { item: 2, clone: two, declaredPaths: ["b.txt"] },
      ],
    });

    expect(outcomes(wave)).toEqual({ 1: "integrated", 2: "integrated" });
    expect(wave.published).toBe(true);
    expect(wave.partial).toBe(false);
    expect(succeeded(wave.checks)).toBe(true);

    // The BYTES, read back out of the merged tree rather than out of the result
    // object. A real recursive merge carries both items.
    const branch = integrationBranch(s.runId);
    expect(await git(s.repo, "rev-parse", branch)).toBe(wave.head);
    expect(await git(s.repo, "cat-file", "-p", `${branch}:a.txt`)).toBe("item one");
    expect(await git(s.repo, "cat-file", "-p", `${branch}:b.txt`)).toBe("item two");
    expect(await git(s.repo, "cat-file", "-p", `${branch}:shared.txt`)).toBe("s");

    // The deliverable is a REAL branch: visible where an operator looks.
    const branches = await git(s.repo, "branch", "--list", "--format=%(refname)");
    expect(branches.split("\n")).toContain(branch);
    // And the machinery is not.
    expect(branches).not.toContain("refs/brigadier/");

    // Two parents, so the agents' own commits stay reachable and attributed.
    const parents = await git(s.repo, "log", "-1", "--format=%P", wave.head);
    expect(parents.split(" ")).toHaveLength(2);
    expect(await git(s.repo, "log", "-1", "--format=%an", wave.head)).toBe("brigadier");
    const itemOne = wave.items.find((item) => item.item === 1)!;
    expect(await git(s.repo, "log", "-1", "--format=%an", itemOne.sha!)).toBe("Worker");
    expect(await git(s.repo, "merge-base", "--is-ancestor", itemOne.sha!, wave.head)).toBe("");

    // The item refs are where ruling 50 puts them, at the shas the merge used.
    expect(await git(s.repo, "rev-parse", itemRef(s.runId, 1))).toBe(itemOne.sha!);

    // The operator's repository, through all of the above. `MERGE_HEAD` and
    // `ORIG_HEAD` are the fingerprints a checkout or a merge leaves behind, and
    // neither exists — the promise is that nothing brigadier ran could make one.
    expect(await witness(s.repo)).toEqual(before);
    expect(existsSync(join(s.repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(existsSync(join(s.repo, ".git", "ORIG_HEAD"))).toBe(false);
    const added = (await refs(s.repo)).filter((ref) => !refsBefore.includes(ref));
    expect(added.sort()).toEqual(
      [branch, itemRef(s.runId, 1), itemRef(s.runId, 2)].sort(),
    );
  });

  test("the only ref brigadier makes visible is the only ref it never deletes", () => {
    const runId = "run-visible";
    const branch = integrationBranch(runId);
    expect(branch).toBe(`refs/heads/brigadier/${runId}`);
    // Ruling 50's delete rule covers `refs/brigadier/` alone, precisely so that
    // it can never reach the deliverable. NEGATIVE CONTROL in both directions:
    // the machinery ref IS deletable, the branch is NOT.
    expect(isDeletableRef(itemRef(runId, 1), [runId])).toBe(true);
    expect(isDeletableRef(branch, [runId])).toBe(false);
    expect(() => deleteRefArgv(branch, "a".repeat(40), [runId])).toThrow(/does not own/);
    expect(deleteRefArgv(itemRef(runId, 1), "a".repeat(40), [runId])).toEqual([
      "update-ref",
      "-d",
      itemRef(runId, 1),
      "a".repeat(40),
    ]);
  });

  test("NEGATIVE CONTROL: `git checkout` in the operator's repository is refused, not avoided", async () => {
    const s = await scenario({ "a.txt": "a\n" });
    const before = await witness(s.repo);

    expect(() => assertNoWorkingTreeCommand(["checkout", "-b", "x"])).toThrow(
      WorkingTreeCommandRefused,
    );
    await expect(parentGit(s.repo, ["checkout", "-b", "x"])).rejects.toThrow(
      WorkingTreeCommandRefused,
    );
    // NEGATIVE CONTROL for the blocklist this replaced: every one of these
    // moves a working tree, an index or HEAD, and every one of them got past a
    // list that named `checkout`, `switch`, `reset` and `merge`.
    for (const args of [
      ["checkout-index", "-a", "-f"],
      ["read-tree", "-m", "-u", "HEAD"],
      ["update-index", "--refresh"],
      ["symbolic-ref", "HEAD", "refs/heads/other"],
      ["worktree", "add", "/tmp/wt"],
      ["branch", "-D", "main"],
      ["sparse-checkout", "set", "src"],
      ["reset", "--hard"],
      ["stash"],
      ["clean", "-fdx"],
      ["gc", "--prune=now"],
    ]) {
      expect(() => assertNoWorkingTreeCommand(args)).toThrow(WorkingTreeCommandRefused);
    }
    // An alias is a command somebody else defines, so a config override is
    // refused outright rather than parsed.
    expect(() => assertNoWorkingTreeCommand(["-c", "alias.z=checkout", "z"])).toThrow(
      WorkingTreeCommandRefused,
    );
    expect(() => assertNoWorkingTreeCommand(["--exec-path=/tmp/evil", "diff"])).toThrow(
      WorkingTreeCommandRefused,
    );
    expect(subcommandOf(["--no-pager", "diff"])).toBe("diff");
    // And the read-only ones this module actually uses are NOT refused, so the
    // guard is discriminating rather than universal.
    for (const command of PARENT_COMMANDS) {
      expect(() => assertNoWorkingTreeCommand([command])).not.toThrow();
    }
    expect([...PARENT_COMMANDS].sort()).toEqual(
      [
        "cat-file",
        "commit-tree",
        "diff",
        "fetch",
        "for-each-ref",
        "merge-tree",
        "rev-parse",
        "update-ref",
        "version",
      ],
    );
    expect(await witness(s.repo)).toEqual(before);
    expect(await refs(s.repo)).toEqual(["refs/heads/main"]);
  });
});

// ------------------------------------------------------------- ownership

describe("ruling 51: declared ownership becomes checked ownership", () => {
  test("NEGATIVE CONTROL: an item that wrote outside its declared paths is rejected WHOLE", async () => {
    const s = await scenario({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    const good = await s.clone("good", { "a.txt": "item one\n" });
    // Item 2 declared b.txt and also wrote c.txt.
    const strayed = await s.clone("strayed", { "b.txt": "obedient half\n", "c.txt": "STRAY\n" });

    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [
        { item: 1, clone: good, declaredPaths: ["a.txt"] },
        { item: 2, clone: strayed, declaredPaths: ["b.txt"] },
      ],
    });

    expect(outcomes(wave)).toEqual({ 1: "integrated", 2: "rejected" });
    const rejected = wave.items.find((item) => item.item === 2)!;
    expect(rejected.ownership?.touched).toEqual(["b.txt", "c.txt"]);
    expect(rejected.ownership?.strayed).toEqual(["c.txt"]);

    const branch = integrationBranch(s.runId);
    // The obedient half did NOT land: b.txt is still the operator's bytes.
    expect(await git(s.repo, "cat-file", "-p", `${branch}:b.txt`)).toBe("b");
    expect(await git(s.repo, "cat-file", "-p", `${branch}:c.txt`)).toBe("c");
    // And the good item did.
    expect(await git(s.repo, "cat-file", "-p", `${branch}:a.txt`)).toBe("item one");

    // The ref is left in place for inspection, and it is the whole of the
    // rejected work — nothing was cherry-picked out of it.
    expect(await git(s.repo, "cat-file", "-p", `${itemRef(s.runId, 2)}:c.txt`)).toBe("STRAY");

    // Partial, and it never renders as success.
    expect(wave.partial).toBe(true);
    expect(succeeded(wave.checks)).toBe(false);
  });

  test("a declaration is exact, and the matcher's forms are the plan's forms", () => {
    expect(isDeclared("src/integrate/index.ts", ["src/integrate/**"])).toBe(true);
    expect(isDeclared("src/integrate/deep/x.ts", ["src/integrate/**"])).toBe(true);
    expect(isDeclared("src/isolation/clone.ts", ["src/integrate/**"])).toBe(false);
    expect(isDeclared("test/integrate.test.ts", ["test/integrate*.test.ts"])).toBe(true);
    expect(isDeclared("test/deep/integrate.test.ts", ["test/integrate*.test.ts"])).toBe(false);
    expect(isDeclared("src/integrate/x.ts", ["src/integrate/"])).toBe(true);
    // NEGATIVE CONTROL: a bare directory name is not a prefix. An implicit
    // prefix is how a declaration of `src` silently comes to own the tree.
    expect(isDeclared("src/integrate/x.ts", ["src/integrate"])).toBe(false);
    // A regex metacharacter in a path is a literal, not a wildcard.
    expect(isDeclared("axb.txt", ["a.b.txt"])).toBe(false);
    expect(isDeclared("a.b.txt", ["a.b.txt"])).toBe(true);
    // Ruling 12: a Windows-shaped declaration is refused rather than silently
    // matching nothing and rejecting the item for files it thought it declared.
    expect(() => assertUsableDeclaration("src\\integrate\\**")).toThrow(/forward slashes/);
    expect(() => assertUsableDeclaration("../outside.ts")).toThrow(/\.\./);
    expect(() => assertUsableDeclaration("/etc/passwd")).toThrow(/relative/);
    expect(judgeOwnership(["a.txt"], ["a.txt"]).within).toBe(true);
    expect(judgeOwnership(["a.txt"], ["a.txt", "b.txt"]).strayed).toEqual(["b.txt"]);
  });

  test("an item that changed nothing contributes nothing, and is not a failure", async () => {
    const s = await scenario({ "a.txt": "a\n" });
    // The read-only half, which is the one that can quietly fail: the worker
    // wrote into its own directory anyway, and the file is untracked, so
    // nothing of it is ever read back.
    const readOnly = await s.clone("readonly", {});
    writeFileSync(join(readOnly, "worker-scratch.txt"), "the worker wrote this anyway\n");
    // A `read-only` item's worker may have written into its own directory; the
    // commit carries no tracked change, and the clone is never read back.
    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [{ item: 1, clone: readOnly, declaredPaths: [] }],
    });
    expect(outcomes(wave)).toEqual({ 1: "no-change" });
    expect(wave.published).toBe(false);
    expect(wave.head).toBe(s.base);
    expect(existsSync(join(s.repo, ".git", "refs", "heads", "brigadier"))).toBe(false);
    expect(succeeded(wave.checks)).toBe(true);
  });
});

// -------------------------------------------------------------- conflicts

describe("ruling 51: a conflict is reported, not resolved, and the run continues", () => {
  test("NEGATIVE CONTROL: a conflicted item names its path, keeps its ref, and costs no other item", async () => {
    const s = await scenario({ "shared.txt": "s\n", "c.txt": "c\n", "a.txt": "a\n" });
    const one = await s.clone("first", { "shared.txt": "version from item one\n" });
    const two = await s.clone("second", { "shared.txt": "version from item two\n" });
    const three = await s.clone("third", { "c.txt": "item three\n" });

    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [
        { item: 1, clone: one, declaredPaths: ["shared.txt"] },
        { item: 2, clone: two, declaredPaths: ["shared.txt"] },
        { item: 3, clone: three, declaredPaths: ["c.txt"] },
      ],
    });

    expect(outcomes(wave)).toEqual({ 1: "integrated", 2: "conflicted", 3: "integrated" });
    const conflicted = wave.items.find((item) => item.item === 2)!;
    expect(conflicted.conflictPaths).toEqual(["shared.txt"]);
    expect(conflicted.detail).toContain("shared.txt");

    // Integration CONTINUED: item 3 is on the branch.
    const branch = integrationBranch(s.runId);
    expect(await git(s.repo, "cat-file", "-p", `${branch}:c.txt`)).toBe("item three");
    expect(await git(s.repo, "cat-file", "-p", `${branch}:shared.txt`)).toBe(
      "version from item one",
    );
    // No conflict markers were invented and no resolution was written.
    expect(await git(s.repo, "cat-file", "-p", `${branch}:shared.txt`)).not.toContain("<<<<<<<");
    // The conflicted item's ref is left in place, for inspection.
    expect(await git(s.repo, "cat-file", "-p", `${conflicted.ref}:shared.txt`)).toBe(
      "version from item two",
    );

    // NEVER RENDERS AS SUCCESS.
    const outcome = { waves: [wave], gates: [initialIntegrationCheck(1)] };
    expect(runSucceeded(outcome)).toBe(false);
    expect(headline(outcome)).toContain("PARTIAL INTEGRATION");
    const rendered = renderRun(outcome);
    expect(rendered).toContain("PARTIAL INTEGRATION");
    expect(rendered).toContain("shared.txt");
    expect(rendered).toContain(conflicted.ref);
    expect(rendered).toContain("the merged result:");
    expect(rendered).not.toContain("✓ integrate item 2");
  });

  test("the merge parse tells a conflict from an error, which the exit code cannot", () => {
    // MEASURED against `git 2.50.1` on 2026-08-17: a genuine conflict and an
    // unresolvable ref BOTH exit 1. The conflict writes a tree and prints its
    // OID first; the error prints nothing on stdout.
    const tree = "f99cc0eae5a05baa281dddcc8d3404ef946a8071";
    expect(parseMergeTree(1, `${tree}\0shared.txt\0\0`)).toEqual({
      kind: "conflicted",
      tree,
      paths: ["shared.txt"],
    });
    expect(parseMergeTree(0, `${tree}\0`)).toEqual({ kind: "merged", tree });
    // NEGATIVE CONTROL: rc=1 with an empty stdout is not a clean merge and not
    // a conflict. It is a shape this code refuses to interpret.
    expect(parseMergeTree(1, "")).toBeNull();
    expect(parseMergeTree(1, `${tree}\0`)).toBeNull();
  });
});

// ------------------------------------------------------ the transaction

describe("ruling 51: one transaction, or none of it", () => {
  test("NEGATIVE CONTROL: one bad entry leaves the GOOD entry unapplied too", async () => {
    const s = await scenario({ "a.txt": "a\n" });
    const good = `refs/brigadier/${s.runId}/first`;
    const other = `refs/brigadier/${s.runId}/second`;

    // The batch applies as a batch.
    await applyRefTransaction(s.repo, s.runId, [
      { kind: "create", ref: good, value: s.base },
      { kind: "create", ref: other, value: s.base },
    ]);
    expect(await git(s.repo, "rev-parse", good)).toBe(s.base);
    await git(s.repo, "update-ref", "-d", good);
    await git(s.repo, "update-ref", "-d", other);

    // And it fails as a batch: one entry that cannot be applied takes the
    // whole transaction with it. MEASURED against `git 2.50.1` on 2026-08-17.
    const third = `refs/brigadier/${s.runId}/third`;
    await git(s.repo, "update-ref", third, s.base);
    await expect(
      applyRefTransaction(s.repo, s.runId, [
        { kind: "create", ref: good, value: s.base },
        { kind: "verify", ref: third, value: "0000000000000000000000000000000000000001" },
      ]),
    ).rejects.toThrow(/NOTHING was published/);
    expect((await rawGit(s.repo, "rev-parse", "--verify", "-q", good)).code).not.toBe(0);
  });

  test("NEGATIVE CONTROL: a batch may not name a ref this run does not own", () => {
    expect(() => assertOwnedRef("refs/heads/main", "run1")).toThrow(/refusing to write/);
    expect(() => assertOwnedRef("refs/brigadier/other-run/item/1", "run1")).toThrow();
    expect(() => assertOwnedRef("refs/heads/brigadier/run1", "run1")).not.toThrow();
    expect(() => assertOwnedRef("refs/brigadier/run1/item/1", "run1")).not.toThrow();
    // A short sha is not a sha.
    expect(() =>
      transactionStdin([{ kind: "create", ref: "refs/brigadier/run1/x", value: "abc1234" }], "run1"),
    ).toThrow(/without a full sha/);
    // The `-z` framing, exactly as git reads it.
    expect(
      transactionStdin(
        [
          { kind: "verify", ref: "refs/brigadier/run1/item/1", value: "a".repeat(40) },
          {
            kind: "update",
            ref: "refs/heads/brigadier/run1",
            value: "b".repeat(40),
            old: "c".repeat(40),
          },
        ],
        "run1",
      ),
    ).toBe(
      `verify refs/brigadier/run1/item/1\0${"a".repeat(40)}\0` +
        `update refs/heads/brigadier/run1\0${"b".repeat(40)}\0${"c".repeat(40)}\0`,
    );
  });

  test("the wave's item refs are pinned by the same transaction that publishes the branch", async () => {
    const s = await scenario({ "a.txt": "a\n" });
    const one = await s.clone("one", { "a.txt": "one\n" });
    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [{ item: 1, clone: one, declaredPaths: ["a.txt"] }],
    });
    expect(wave.published).toBe(true);
    // The publish asserted the item ref at the sha the merge was computed from;
    // moving it afterwards is the operator's business, but a wave that raced
    // with such a move would have published nothing at all.
    await expect(
      applyRefTransaction(s.repo, s.runId, [
        { kind: "verify", ref: itemRef(s.runId, 1), value: "0".repeat(39) + "1" },
        { kind: "create", ref: `refs/brigadier/${s.runId}/never`, value: s.base },
      ]),
    ).rejects.toThrow();
    expect(
      (await rawGit(s.repo, "rev-parse", "--verify", "-q", `refs/brigadier/${s.runId}/never`)).code,
    ).not.toBe(0);
  });
});

// ------------------------------------------------------- the version floor

describe("ruling 51: git >= 2.38.0, checked at first run", () => {
  test("the floor is arithmetic, and the refusal names the remedy", async () => {
    const real = await git(scratch, "--version");
    const parsed = parseGitVersion(real);
    expect(parsed).not.toBeNull();
    expect(meetsFloor(parsed!)).toBe(true);
    expect(versionRefusal(parsed, real)).toBeNull();

    // NEGATIVE CONTROL: the versions that must be refused.
    for (const raw of ["git version 2.37.0", "git version 2.9.0", "git version 1.9.5"]) {
      const refusal = versionRefusal(parseGitVersion(raw), raw);
      expect(refusal).not.toBeNull();
      expect(refusal).toContain("2.38.0");
      expect(refusal).toContain("trivial-merge report");
    }
    expect(versionRefusal(parseGitVersion("git version 2.38.0"), "")).toBeNull();
    // A string comparison would have got this one wrong.
    expect(meetsFloor(parseGitVersion("git version 2.9.0")!)).toBe(false);
    expect(meetsFloor(parseGitVersion("git version 2.45.1.windows.1")!)).toBe(true);
    expect(versionRefusal(null, "not a version at all")).toContain("will not guess");
  });

  test("NEGATIVE CONTROL: an old git is refused BEFORE anything is fetched", async () => {
    const s = await scenario({ "a.txt": "a\n" });
    const one = await s.clone("one", { "a.txt": "one\n" });
    const refsBefore = await refs(s.repo);
    await expect(
      integrateWave({
        repo: s.repo,
        runId: s.runId,
        base: s.base,
        items: [{ item: 1, clone: one, declaredPaths: ["a.txt"] }],
        gitVersionOutput: "git version 2.37.0",
      }),
    ).rejects.toThrow(GitTooOld);
    // Nothing was written to the operator's repository.
    expect(await refs(s.repo)).toEqual(refsBefore);
  });

  test("this is the misbehaviour the floor prevents, measured on today's git", async () => {
    // HONEST LIMIT: no git older than 2.38.0 is installed here, so what is
    // exercised above is the REFUSAL, not an actual old git. What can be
    // measured today is the shape of the failure it prevents — the trivial
    // three-argument mode still exists, and it still exits 0.
    //
    // MEASURED against `git 2.50.1` on 2026-08-17: `git merge-tree <base> <a> <b>`
    // exited 0 and printed a human-readable merge report whose first line is
    // not a tree OID. On git 2.37 the `--write-tree` call would have fallen
    // into exactly this mode, so an unguarded brigadier would have read that
    // text as a tree and reported a clean merge.
    const s = await scenario({ "a.txt": "a\n", "b.txt": "b\n" });
    const one = await s.clone("one", { "a.txt": "one\n" });
    const two = await s.clone("two", { "b.txt": "two\n" });
    await git(s.repo, "fetch", "--no-tags", one, "work:refs/brigadier/trivial/one");
    await git(s.repo, "fetch", "--no-tags", two, "work:refs/brigadier/trivial/two");
    const trivial = await rawGit(
      s.repo,
      "merge-tree",
      s.base,
      "refs/brigadier/trivial/one",
      "refs/brigadier/trivial/two",
    );
    expect(trivial.code).toBe(0);
    expect(trivial.stdout.split("\n")[0]).not.toMatch(/^[0-9a-f]{40,64}$/);
    // And the modern mode, on the same two refs, returns exactly one OID.
    const modern = await rawGit(
      s.repo,
      "merge-tree",
      "--write-tree",
      "refs/brigadier/trivial/one",
      "refs/brigadier/trivial/two",
    );
    expect(modern.code).toBe(0);
    expect(modern.stdout.trim()).toMatch(/^[0-9a-f]{40,64}$/);
  });
});

// ------------------------------------------------------------- the fetch

describe("ruling 51: the parent fetches from the clone, and the transport is named", () => {
  test("NEGATIVE CONTROL: without --no-tags the agent's tags land in the operator's repository", async () => {
    const s = await scenario({ "a.txt": "a\n" });
    const one = await s.clone("tagged", { "a.txt": "one\n" });
    await git(one, "tag", "agent-planted-tag");

    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [{ item: 1, clone: one, declaredPaths: ["a.txt"] }],
    });
    expect(wave.published).toBe(true);
    // brigadier's fetch carried no tag.
    expect(await refs(s.repo)).not.toContain("refs/tags/agent-planted-tag");

    // NEGATIVE CONTROL, MEASURED against `git 2.50.1` on 2026-08-17: the same
    // fetch WITHOUT `--no-tags` does carry it — into `refs/tags/`, which is
    // outside `refs/brigadier/` and therefore outside ruling 50's delete rule.
    await git(s.repo, "fetch", one, "work:refs/brigadier/tagtest/1");
    expect(await refs(s.repo)).toContain("refs/tags/agent-planted-tag");
  });

  test("the fetch needs no remote on either side, and copies no objects", async () => {
    const s = await scenario({ "a.txt": "a\n" });
    const one = await s.clone("one", { "a.txt": "one\n" });
    expect(await git(one, "remote")).toBe("");
    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [{ item: 1, clone: one, declaredPaths: ["a.txt"] }],
    });
    expect(wave.published).toBe(true);
    // Hardlinked, so the fetch transferred nothing. MEASURED against
    // `git 2.50.1` on 2026-08-17 — `probes/integration.sh` check 2 measured the
    // same property on the clone side.
    const linked = await Bun.spawn(
      ["find", join(one, ".git", "objects"), "-type", "f", "-links", "+1"],
      { stdout: "pipe" },
    );
    expect((await new Response(linked.stdout).text()).trim().length).toBeGreaterThan(0);
  });

  test("NEGATIVE CONTROL: a URL transport is refused, because the measurement was about a path", async () => {
    expect(() => assertLocalPathTransport("/tmp/clone")).not.toThrow();
    expect(() => assertLocalPathTransport("C:\\clones\\1")).not.toThrow();
    for (const url of ["file:///tmp/clone", "ssh://host/repo", "git@example.com:repo.git"]) {
      expect(() => assertLocalPathTransport(url)).toThrow(/upload-pack/);
    }
    const s = await scenario({ "a.txt": "a\n" });
    const one = await s.clone("one", { "a.txt": "one\n" });
    const refsBefore = await refs(s.repo);
    await expect(
      integrateWave({
        repo: s.repo,
        runId: s.runId,
        base: s.base,
        items: [{ item: 1, clone: `file://${one}`, declaredPaths: ["a.txt"] }],
      }),
    ).rejects.toThrow(/upload-pack/);
    expect(await refs(s.repo)).toEqual(refsBefore);
  });

  test("NEGATIVE CONTROL: an item ref that already exists is not overwritten", async () => {
    const s = await scenario({ "a.txt": "a\n" });
    const one = await s.clone("one", { "a.txt": "one\n" });
    await git(s.repo, "update-ref", itemRef(s.runId, 1), s.base);
    await expect(
      integrateWave({
        repo: s.repo,
        runId: s.runId,
        base: s.base,
        items: [{ item: 1, clone: one, declaredPaths: ["a.txt"] }],
      }),
    ).rejects.toThrow(ItemRefOccupied);
    expect(await git(s.repo, "rev-parse", itemRef(s.runId, 1))).toBe(s.base);
  });
});

// -------------------------------------------------------------- the gate

describe("ruling 52: the verify command runs once more, on the merged result", () => {
  const verifySymbols = [
    "sh",
    "-c",
    'while read -r line; do sym=${line#uses }; grep -qx "$sym" lib.txt || exit 1; done < app.txt',
  ];

  async function twoCleanItemsThatBreakTheMerge() {
    const s = await scenario({ "lib.txt": "alpha\nbeta\n", "app.txt": "uses alpha\n" });
    // Item 1 points the app at `beta`, which exists in the base's lib.
    const one = await s.clone("app", { "app.txt": "uses beta\n" });
    // Item 2 removes `beta` from lib, which the base's app does not use.
    const two = await s.clone("lib", { "lib.txt": "alpha\n" });
    return { s, one, two };
  }

  test("two items that each pass, whose merge does not — and it is reported separately", async () => {
    const { s, one, two } = await twoCleanItemsThatBreakTheMerge();

    // Each item's own gate, run in that item's own clone, exactly as the
    // per-item gate would. Both pass.
    for (const clone of [one, two]) {
      const child = Bun.spawn(verifySymbols, { cwd: clone, stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).toBe(0);
    }

    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [
        { item: 1, clone: one, declaredPaths: ["app.txt"] },
        { item: 2, clone: two, declaredPaths: ["lib.txt"] },
      ],
    });
    expect(outcomes(wave)).toEqual({ 1: "integrated", 2: "integrated" });
    expect(succeeded(wave.checks)).toBe(true); // every item passed…

    const gate = await runIntegrationGate({
      repo: s.repo,
      runId: s.runId,
      commit: wave.head,
      verify: verifySymbols,
      runRoot: runRootHome,
    });
    // …and the merged result did not. This is the classic integration failure,
    // and without this gate it passes silently.
    expect(gate.check.outcome).toBe("fail");
    expect(gate.check.name).toBe("verify (merged result)");
    const outcome = { waves: [wave], gates: [gate.check] };
    expect(runSucceeded(outcome)).toBe(false);
    expect(headline(outcome)).toContain("PARTIAL");
    // Never conflated: the item checks and the gate are separate sections.
    expect(renderRun(outcome)).toContain("the merged result:");
    if (gate.cloneDir !== null) discardGateClone(gate.cloneDir);
  });

  test("a merged result that verifies is a pass, and the gate clone is not the operator's repo", async () => {
    const s = await scenario({ "lib.txt": "alpha\nbeta\n", "app.txt": "uses alpha\n" });
    const one = await s.clone("app", { "app.txt": "uses beta\n" });
    const before = await witness(s.repo);
    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [{ item: 1, clone: one, declaredPaths: ["app.txt"] }],
    });
    const gate = await runIntegrationGate({
      repo: s.repo,
      runId: s.runId,
      commit: wave.head,
      verify: verifySymbols,
      runRoot: runRootHome,
    });
    expect(gate.check.outcome).toBe("pass");
    expect(gate.cloneDir).not.toBeNull();
    expect(gate.cloneDir!.startsWith(runRootHome)).toBe(true);
    // The gate checked out the MERGED commit, in its own clone.
    expect(await git(gate.cloneDir!, "rev-parse", "HEAD")).toBe(wave.head);
    expect(readFileSync(join(gate.cloneDir!, "app.txt"), "utf8")).toBe("uses beta\n");
    // And the operator's repository still has no checkout of any of it.
    expect(await witness(s.repo)).toEqual(before);
    expect(runSucceeded({ waves: [wave], gates: [gate.check] })).toBe(true);
    discardGateClone(gate.cloneDir!);
    expect(existsSync(gate.cloneDir!)).toBe(false);
  });

  test("ruling 52's outcomes: unconfigured does not block, a missing command is not-run, a kill is error", async () => {
    const s = await scenario({ "a.txt": "a\n" });
    const one = await s.clone("one", { "a.txt": "one\n" });
    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [{ item: 1, clone: one, declaredPaths: ["a.txt"] }],
    });

    const unconfigured = await runIntegrationGate({
      repo: s.repo,
      runId: s.runId,
      commit: wave.head,
      verify: null,
      runRoot: runRootHome,
    });
    expect(unconfigured.check.outcome).toBe("unconfigured");
    expect(unconfigured.cloneDir).toBeNull();
    expect(runSucceeded({ waves: [wave], gates: [unconfigured.check] })).toBe(true);

    // NEGATIVE CONTROL: a command that does not exist is `not-run` — the
    // operator's environment, no retry helps — and it BLOCKS. It is also
    // resolved before anything is cloned.
    const missing = await runIntegrationGate({
      repo: s.repo,
      runId: s.runId,
      commit: wave.head,
      verify: ["brigadier-no-such-command-42"],
      runRoot: runRootHome,
      wave: 7,
    });
    expect(missing.check.outcome).toBe("not-run");
    expect(missing.cloneDir).toBeNull();
    expect(runSucceeded({ waves: [wave], gates: [missing.check] })).toBe(false);

    // NEGATIVE CONTROL: a checker that was killed is `error`, not `fail`.
    const killed = await runIntegrationGate({
      repo: s.repo,
      runId: s.runId,
      commit: wave.head,
      verify: ["sh", "-c", "sleep 30"],
      runRoot: runRootHome,
      wave: 8,
      timeoutMs: 400,
    });
    expect(killed.check.outcome).toBe("error");
    expect(killed.check.detail).toContain("re-run the checker");
    if (killed.cloneDir !== null) discardGateClone(killed.cloneDir);
    // The write-ahead value is the blocking one, so a crash before any of this
    // leaves a blocking result rather than an absent field.
    expect(initialIntegrationCheck(1).outcome).toBe("not-run");
    expect(runSucceeded({ waves: [wave], gates: [initialIntegrationCheck(1)] })).toBe(false);
    // NO WIDENED BOUND HERE, and that is the point.
    //
    // This test timed out at Bun's 5,000 ms default on ubuntu-latest (5,001 ms,
    // run 32394716171) and reproduced on Linux under Docker at 5,006 ms while
    // passing on darwin. The first response was a 60,000 ms backstop. Then the
    // CAUSE was measured, and it was a product defect rather than a slow runner:
    // `runIntegrationGate` killed the checker but then awaited its PIPES, which
    // the `sleep 30` grandchild kept open — 30,050 ms against a 400 ms timeout.
    // `src/integrate/gate.ts` now bounds the wait, and this test runs in
    // 2,448 ms on the platform where it took 30,050.
    //
    // So the bound came back off. Leaving a widened timeout behind after
    // removing its cause is how a suite stops meaning anything, and 60 s would
    // now hide a real hang for twelve times longer than the code can produce one.
  });

  test("NEGATIVE CONTROL: ruling 61 refuses a gate under a temp root, where the merged code would execute", async () => {
    const s = await scenario({ "a.txt": "a\n" });
    const one = await s.clone("one", { "a.txt": "one\n" });
    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [{ item: 1, clone: one, declaredPaths: ["a.txt"] }],
    });
    await expect(
      runIntegrationGate({
        repo: s.repo,
        runId: s.runId,
        commit: wave.head,
        verify: ["sh", "-c", "true"],
        runRoot: join(scratch, "gate-under-tmp"),
      }),
    ).rejects.toThrow(/ruling 61/);
  });
});

// ------------------------------------------------ the repair round's five

describe("the operator's repository survives the gate, the ownership check and the transaction", () => {
  test("NEGATIVE CONTROL: a hostile verify command cannot corrupt the operator's object store", async () => {
    const s = await scenario({ "a.txt": "a\n", "b.txt": "b\n" });
    const one = await s.clone("one", { "a.txt": "one\n" });
    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [{ item: 1, clone: one, declaredPaths: ["a.txt"] }],
    });

    // The merged, agent-authored code, executing as the verify command, doing
    // the worst thing available to it: writing over every object in the clone's
    // object store. With `git clone --local` and no `--no-hardlinks` those
    // files ARE the operator's — MEASURED against `git 2.50.1` on 2026-08-18 as
    // the same inode with nlink 2 — and this left the operator's repository
    // with `git fsck` exiting 128 while the gate returned `pass`.
    const gate = await runIntegrationGate({
      repo: s.repo,
      runId: s.runId,
      commit: wave.head,
      verify: [
        "sh",
        "-c",
        'find .git/objects -type f -exec sh -c \'printf CORRUPTED > "$1"\' _ {} \\; ; exit 0',
      ],
      runRoot: runRootHome,
      wave: 21,
    });
    expect(gate.check.outcome).toBe("pass"); // the verify command "succeeded"…

    // …and the operator's repository is untouched. On BYTES, through git's own
    // integrity check.
    const fsck = await rawGit(s.repo, "fsck", "--no-progress");
    expect(fsck.code).toBe(0);
    expect(await git(s.repo, "cat-file", "-p", `${s.base}:a.txt`)).toBe("a");
    expect(await git(s.repo, "cat-file", "-p", `${wave.head}:a.txt`)).toBe("one");

    // And the physics that makes it true, asserted directly: no object file in
    // the gate clone shares an inode with the operator's, and the operator's
    // objects have a single link.
    const objectsOf = (repo: string): string[] => {
      const root = join(repo, ".git", "objects");
      const found: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (statSync(path).isDirectory()) walk(path);
          else found.push(path);
        }
      };
      walk(root);
      return found;
    };
    const operatorObjects = objectsOf(s.repo);
    expect(operatorObjects.length).toBeGreaterThan(0);
    const operatorInodes = new Set(operatorObjects.map((path) => statSync(path).ino));
    expect(gate.cloneDir).not.toBeNull();
    const gateObjects = objectsOf(gate.cloneDir!);
    expect(gateObjects.length).toBeGreaterThan(0);
    for (const path of gateObjects) {
      expect(operatorInodes.has(statSync(path).ino)).toBe(false);
      expect(statSync(path).nlink).toBe(1);
    }
    discardGateClone(gate.cloneDir!);

    // NOT CLAIMED, and stated here so it is not read as claimed: the operator's
    // own object files still show nlink 2, because this suite's WORKER clones
    // are made with a plain `git clone --local`, as `src/isolation/clone.ts`
    // makes them. That share is an agent's to abuse from inside its own clone
    // and it is another module's to decide about; what this test closes is the
    // gate clone, which is brigadier's own and which brigadier itself invites
    // agent-authored code to execute in.
  });

  test("NEGATIVE CONTROL: a rename cannot smuggle a deletion past the ownership check", async () => {
    const s = await scenario({
      "secret/credentials.txt": "creds\n",
      "declared/x.txt": "x\n",
      "other.txt": "other\n",
    });
    // An exact rename OUT of an undeclared directory. MEASURED against
    // `git 2.50.1` on 2026-08-18: `--name-only` alone printed only
    // `declared/moved.txt`, so ownership saw no stray and the item integrated
    // having deleted a file it never declared.
    const mover = await s.clone("mover", {});
    await git(mover, "mv", "secret/credentials.txt", "declared/moved.txt");
    await git(mover, "commit", "-q", "-m", "renamed");
    // A rename that also edits, and a plain delete of an undeclared path.
    const similar = await s.clone("similar", {});
    await git(similar, "mv", "secret/credentials.txt", "declared/similar.txt");
    writeFileSync(join(similar, "declared/similar.txt"), "creds\nplus a line\n");
    await git(similar, "add", "-A");
    await git(similar, "commit", "-q", "-m", "renamed and edited");
    const deleter = await s.clone("deleter", { "other.txt": null });

    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [
        { item: 1, clone: mover, declaredPaths: ["declared/**"] },
        { item: 2, clone: similar, declaredPaths: ["declared/**"] },
        { item: 3, clone: deleter, declaredPaths: ["declared/**"] },
      ],
    });

    expect(outcomes(wave)).toEqual({ 1: "rejected", 2: "rejected", 3: "rejected" });
    for (const item of wave.items) {
      expect(item.ownership?.strayed).toContain(
        item.item === 3 ? "other.txt" : "secret/credentials.txt",
      );
    }
    expect(wave.published).toBe(false);
    expect(succeeded(wave.checks)).toBe(false);

    // Nothing landed, and the file the rename would have deleted is still
    // reachable from the base — checked on bytes, which is where the defect
    // showed itself (`git cat-file -e <branch>:secret/credentials.txt` had been
    // exiting 128).
    expect(await git(s.repo, "cat-file", "-p", `${s.base}:secret/credentials.txt`)).toBe("creds");

    // POSITIVE CONTROL: a rename entirely INSIDE the declared paths is fine, so
    // the fix rejects deletions rather than renames.
    const inside = await s.clone("inside", {});
    await git(inside, "mv", "declared/x.txt", "declared/y.txt");
    await git(inside, "commit", "-q", "-m", "renamed inside");
    const second = await integrateWave({
      repo: s.repo,
      runId: `${s.runId}b`,
      base: s.base,
      items: [{ item: 1, clone: inside, declaredPaths: ["declared/**"] }],
    });
    expect(outcomes(second)).toEqual({ 1: "integrated" });
    expect([...(second.items[0]?.ownership?.touched ?? [])].sort()).toEqual([
      "declared/x.txt",
      "declared/y.txt",
    ]);
  });

  test("NEGATIVE CONTROL: a publish cannot delete the deliverable, whatever the type system thinks", async () => {
    const s = await scenario({ "a.txt": "a\n" });
    const one = await s.clone("one", { "a.txt": "one\n" });
    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [{ item: 1, clone: one, declaredPaths: ["a.txt"] }],
    });
    const branch = integrationBranch(s.runId);
    expect(await git(s.repo, "rev-parse", branch)).toBe(wave.head);

    // The union is a compile-time guard, so the attack arrives as a cast —
    // which is what a caller in JavaScript, or next year's fourth kind, looks
    // like from here.
    const deletion = { kind: "delete", ref: branch, value: wave.head } as unknown as RefEntry;
    expect(() => transactionStdin([deletion], s.runId)).toThrow(/never deletes/);
    await expect(applyRefTransaction(s.repo, s.runId, [deletion])).rejects.toThrow(/never deletes/);
    expect(() => assertPublishCommand("delete", branch, s.runId)).toThrow(RefRefused);
    expect(() => assertPublishCommand("option", branch, s.runId)).toThrow(RefRefused);
    for (const kind of ["create", "update", "verify"]) {
      expect(() => assertPublishCommand(kind, branch, s.runId)).not.toThrow();
    }
    // The branch is still there, in `git branch --list`, where the operator can
    // see it.
    expect(await git(s.repo, "rev-parse", branch)).toBe(wave.head);
    expect(await git(s.repo, "branch", "--list", "--format=%(refname)")).toContain(branch);

    // And a ref that traverses out of the namespace is refused by brigadier
    // rather than by git's refname parser.
    expect(() =>
      assertOwnedRef(`refs/brigadier/${s.runId}/../../heads/main`, s.runId),
    ).toThrow(/shape/);
    expect(() => assertOwnedRef(`refs/brigadier/${s.runId}//item/1`, s.runId)).toThrow(/shape/);
  });

  test("NEGATIVE CONTROL: a report never claims verification that did not happen", async () => {
    const s = await scenario({ "a.txt": "a\n" });
    const readOnly = await s.clone("readonly", {});
    const wave = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [{ item: 1, clone: readOnly, declaredPaths: [] }],
    });
    expect(wave.published).toBe(false);

    // Every item "landed" (nothing to land), no branch was created, and the
    // gate is `unconfigured` — the shape the old headline called verified.
    const unconfigured = {
      waves: [wave],
      gates: [
        {
          name: "verify (merged result)",
          outcome: "unconfigured" as const,
          qualifier: "wave 1",
        },
      ],
    };
    expect(headline(unconfigured)).toContain("NOT VERIFIED");
    expect(headline(unconfigured)).not.toContain("was verified");
    // `unconfigured` still does not BLOCK — ruling 52 — so the two facts stay
    // separate: the run did not fail, and nothing was verified.
    expect(runSucceeded(unconfigured)).toBe(true);
    expect(renderRun(unconfigured)).toContain("NOT VERIFIED");

    // An empty gate list is the same absence with less ceremony.
    expect(headline({ waves: [wave], gates: [] })).toContain("no integration gate was recorded");

    // POSITIVE CONTROL: the claim is available, and only from a `pass`.
    const passed = {
      waves: [wave],
      gates: [{ name: "verify (merged result)", outcome: "pass" as const }],
    };
    expect(headline(passed)).toContain("the merged result was verified");
  });
});

// -------------------------------------------------------------- the waves

describe("ruling 54: a wave boundary is a gate boundary", () => {
  test("a cycle is rejected at plan validation, before anything runs", () => {
    expect(planWaves([{ item: 1 }, { item: 2, dependsOn: [1] }, { item: 3, dependsOn: [1] }])).toEqual(
      [[1], [2, 3]],
    );
    expect(planWaves([{ item: 1 }, { item: 2 }])).toEqual([[1, 2]]);
    // NEGATIVE CONTROL.
    expect(() => planWaves([{ item: 1, dependsOn: [2] }, { item: 2, dependsOn: [1] }])).toThrow(
      CyclicPlan,
    );
    expect(() => planWaves([{ item: 1, dependsOn: [1] }])).toThrow(/depends on itself/);
    expect(() => planWaves([{ item: 1, dependsOn: [9] }])).toThrow(/does not contain/);
  });

  test("wave 2 clones from wave 1's integration commit and sees its prerequisite's output", async () => {
    const s = await scenario({ "a.txt": "a\n", "b.txt": "b\n" });
    const one = await s.clone("one", { "a.txt": "item one\n" });

    const waveOne = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [{ item: 1, clone: one, declaredPaths: ["a.txt"] }],
      wave: 1,
    });
    expect(waveOne.published).toBe(true);

    const gate = await runIntegrationGate({
      repo: s.repo,
      runId: s.runId,
      commit: waveOne.head,
      verify: ["sh", "-c", "test \"$(cat a.txt)\" = 'item one'"],
      runRoot: runRootHome,
      wave: 1,
    });
    expect(gate.check.outcome).toBe("pass");
    expect(waveBoundary(1, gate.check).proceed).toBe(true);
    if (gate.cloneDir !== null) discardGateClone(gate.cloneDir);

    // Wave 2's clone comes from wave 1's integration commit — the way
    // `prepareClone` builds one, by fetching the ref rather than by cloning a
    // branch it cannot see.
    const second = join(scratch, `clone-wave2-${s.runId}`);
    await git(scratch, "clone", "-q", "--local", "--no-checkout", s.repo, second);
    await git(second, "config", "user.email", "worker@example.com");
    await git(second, "config", "user.name", "Worker");
    await git(second, "fetch", "--no-tags", s.repo, `+${waveOne.branch}:refs/heads/brigadier-base`);
    await git(second, "checkout", "-q", "-b", "work", "brigadier-base");
    await git(second, "remote", "remove", "origin");
    // The BYTES: wave 2 sees its prerequisite's output.
    expect(readFileSync(join(second, "a.txt"), "utf8")).toBe("item one\n");
    writeFileSync(join(second, "b.txt"), "item two\n");
    await git(second, "commit", "-q", "-am", "item two");

    const waveTwo = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: waveOne.head,
      branchAt: waveOne.head,
      items: [{ item: 2, clone: second, declaredPaths: ["b.txt"] }],
      wave: 2,
    });
    expect(outcomes(waveTwo)).toEqual({ 2: "integrated" });
    expect(waveTwo.published).toBe(true);
    // The compare-and-swap moved the branch, and the branch carries both.
    expect(await git(s.repo, "rev-parse", waveOne.branch)).toBe(waveTwo.head);
    expect(await git(s.repo, "cat-file", "-p", `${waveOne.branch}:a.txt`)).toBe("item one");
    expect(await git(s.repo, "cat-file", "-p", `${waveOne.branch}:b.txt`)).toBe("item two");
    expect(await git(s.repo, "merge-base", "--is-ancestor", waveOne.head, waveTwo.head)).toBe("");
  });

  test("NEGATIVE CONTROL: an item whose prerequisite did not integrate is never attempted, and blocks", async () => {
    const s = await scenario({ "a.txt": "a\n", "b.txt": "b\n" });
    const strayed = await s.clone("strayed", { "a.txt": "one\n", "b.txt": "STRAY\n" });

    const waveOne = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: s.base,
      items: [{ item: 1, clone: strayed, declaredPaths: ["a.txt"] }],
      wave: 1,
    });
    expect(outcomes(waveOne)).toEqual({ 1: "rejected" });
    expect(waveOne.published).toBe(false);

    const integrated = new Set(
      waveOne.items.filter((item) => item.outcome === "integrated").map((item) => item.item),
    );
    const plan = [{ item: 1 }, { item: 2, dependsOn: [1] }];
    const next = attemptable([2], plan, integrated);
    expect(next.run).toEqual([]);
    expect(next.blocked).toEqual([{ item: 2, missing: [1] }]);

    const waveTwo = await integrateWave({
      repo: s.repo,
      runId: s.runId,
      base: waveOne.head,
      items: [],
      blocked: next.blocked,
      wave: 2,
    });
    expect(outcomes(waveTwo)).toEqual({ 2: "not-attempted" });
    // Ruling 52's write-ahead value, and it BLOCKS. This is v1's "both slices
    // ok" made impossible rather than fixed.
    expect(waveTwo.checks[0]?.outcome).toBe("not-run");
    expect(succeeded(waveTwo.checks)).toBe(false);
    const outcome = { waves: [waveOne, waveTwo], gates: [initialIntegrationCheck(1)] };
    expect(runSucceeded(outcome)).toBe(false);
    expect(renderRun(outcome)).toContain("never attempted");
  });

  test("NEGATIVE CONTROL: a blocking gate stops the next wave from starting at all", () => {
    expect(waveBoundary(1, { name: "verify (merged result)", outcome: "pass" }).proceed).toBe(true);
    expect(waveBoundary(1, { name: "verify (merged result)", outcome: "unconfigured" }).proceed).toBe(
      true,
    );
    for (const outcome of ["fail", "error", "not-run"] as const) {
      const boundary = waveBoundary(1, { name: "verify (merged result)", outcome });
      expect(boundary.proceed).toBe(false);
      expect(boundary.reason).toContain("wave 2 does not start");
    }
  });
});
