// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 56's invariant, ruling 49's one exception to it, and every way found
 * so far of getting round either.
 *
 * Every containment check plants a payload that writes a canary file OUTSIDE
 * the clone, runs the command brigadier would run, and asks whether the canary
 * exists. Never a flag, never a boolean the code returned: v1's finding 41 is
 * that a flag assertion survives a refactor that removes the property, and a
 * canary path does not.
 *
 * Four of these exist because two blind critics found the earlier version of
 * this module did NOT hold the invariant: the hooks sink was a directory the
 * agent could write and the whole run shared it; `witnessOperator` and
 * `buildBaseState` were unguarded git wrappers taking a bare path; the marker
 * was deletable, and deleting it opened the door rather than closing it; and
 * the restore covered one of git's three config levels.
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
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { hooklessArgs } from "../src/repo/git.ts";
import {
  buildBaseState,
  prepareClone,
  recycleClone,
  releaseToAgent,
  witnessOperator,
  type AgentOwnedClone,
  type ReclamationEvidence,
  type BaseState,
  type PreparedClone,
} from "../src/isolation/index.ts";
import { runGit } from "../src/isolation/internal-git.ts";
import { checkedOut } from "../bar/lib/git.ts";

/** Raw git: no hooks sink, no config isolation, no authority. The hostile baseline. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  return rawGit({ cwd, args });
}

async function rawGit(run: {
  cwd: string;
  args: string[];
  env?: Record<string, string>;
}): Promise<string> {
  const child = Bun.spawn(["git", ...run.args], {
    cwd: run.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...run.env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (code !== 0) throw new Error(`git ${run.args.join(" ")} exited ${code}: ${stderr}`);
  return stdout.trim();
}


/**
 * The sweep's evidence, stubbed.
 *
 * `recycleClone` requires proof from ruling 38's reclamation sweep that this
 * item's processes are gone. That module is a different slice and does not
 * exist yet, so these tests construct the evidence themselves — honestly: no
 * worker process is ever spawned here, so there is nothing to reclaim and
 * nothing to lie about. `test/isolation-live.test.ts` is where the evidence is
 * false on purpose, and where the refusals are checked.
 */
function sweptClean(clone: AgentOwnedClone): ReclamationEvidence {
  return {
    runId: clone.runId,
    item: clone.item,
    sweptAt: Date.now(),
    reclaimedPids: [],
    survivors: [],
    sweptBy: "test stub: no worker process was spawned for this item",
  };
}

let scratch: string;
let runRootHome: string;
let canaryDir: string;
let emptyHooks: string;
let repo: string;

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-recycle-")));
  const home = join(homedir(), ".brigadier-test");
  mkdirSync(home, { recursive: true });
  runRootHome = realpathSync(mkdtempSync(join(home, "recycle-")));
  canaryDir = join(scratch, "escaped");
  mkdirSync(canaryDir, { recursive: true });
  emptyHooks = join(scratch, "no-hooks");
  mkdirSync(emptyHooks, { recursive: true });

  repo = join(scratch, "parent");
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "operator@example.com");
  await git(repo, "config", "user.name", "Operator");
  writeFileSync(join(repo, ".gitignore"), "*.log\n");
  writeFileSync(join(repo, "a.txt"), "hello\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(runRootHome, { recursive: true, force: true });
});

/** A script that writes a canary OUTSIDE the clone and exits clean. */
function payload(name: string): string {
  return `#!/bin/sh\ntouch "${join(canaryDir, name)}"\nexit 0\n`;
}

const escaped = (name: string): boolean => existsSync(join(canaryDir, name));

/**
 * `C:\a\b` -> `C:/a/b`, and a no-op on POSIX, where paths carry no backslashes.
 *
 * ONLY the COMMAND git is pointed at, never the canary path inside the script.
 * Git for Windows runs a `core.fsmonitor` through its own bundled `sh`, which
 * eats backslashes as escapes, so a native `C:\Users\...` arrives as
 * `C:Users...`, names nothing, and git ignores the failure IN SILENCE.
 *
 * MEASURED on `windows-latest` 2026-08-20, run 32415677392, job 96576151123, by
 * `test/git-payload-shape.test.ts`: all four payload shapes FIRED there, because
 * that file forwards the command path in its own setup line and every other
 * fixture here did not. `OWNER-QUESTIONS.md` #13 records the separation.
 *
 * The HOOK plants above are untouched, deliberately: git executes a hook FILE by
 * path itself rather than handing a string to a shell, so nothing measured here
 * applies to them and a change would be a guess.
 */
const forwardSlashes = (path: string): string => path.replace(/\\/g, "/");

function plantHookIn(hooksDir: string, hook: string, canary: string): void {
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, hook), payload(canary), { mode: 0o755 });
}

const plantHook = (dir: string, hook: string, canary: string): void =>
  plantHookIn(join(dir, ".git", "hooks"), hook, canary);

async function plantFsmonitor(dir: string, canary: string): Promise<void> {
  const script = join(scratch, `fsmonitor-${canary}.sh`);
  writeFileSync(script, payload(canary), { mode: 0o755 });
  await git(dir, "config", "core.fsmonitor", forwardSlashes(script));
}

let runCounter = 0;
async function preparedClone(
  label: string,
  content: string,
): Promise<{ clone: PreparedClone; base: BaseState; root: string }> {
  const runId = `${label}${runCounter++}`;
  const root = join(runRootHome, runId);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(repo, "a.txt"), content);
  const base = await buildBaseState({ repo, runId, scratchDir: join(root, "scratch") });
  return { clone: await prepareClone({ base, item: 1, runRoot: root }), base, root };
}

/** The state after an agent has worked: released, and brigadier's token gone. */
async function agentOwnedClone(
  label: string,
  content: string,
): Promise<{ clone: AgentOwnedClone; base: BaseState; root: string }> {
  const { clone, base, root } = await preparedClone(label, content);
  return { clone: releaseToAgent(clone), base, root };
}

// ------------------------------------------------- ruling 49: the restore

describe("recycling a pooled directory a previous agent could write to", () => {
  test("NEGATIVE CONTROL: without the restore, ruling 19's three commands run both families", async () => {
    const { clone, base } = await agentOwnedClone("control", "control\n");
    plantHook(clone.dir, "post-checkout", "control-hook");
    await plantFsmonitor(clone.dir, "control-fsmonitor");

    // Ruling 19's recycle, written the way it reads: fetch, checkout, clean.
    // No restore, because nothing in those three words asks for one.
    await git(clone.dir, "fetch", "--no-tags", repo, `+${base.ref}:refs/heads/brigadier-base`);
    await git(clone.dir, "checkout", "--force", "-B", "work", "brigadier-base");
    await git(clone.dir, "status", "--porcelain");

    expect(escaped("control-hook")).toBe(true);
    expect(escaped("control-fsmonitor")).toBe(true);
  }, 20_000);

  test("NEGATIVE CONTROL: core.hooksPath alone does NOT close core.fsmonitor", async () => {
    const { clone } = await agentOwnedClone("hookspath", "hookspath\n");
    await plantFsmonitor(clone.dir, "hookspath-fsmonitor");

    // The defence brigadier keeps on every invocation, applied on its own. It
    // is a second execution family, and defending it with `-c <key>=` overrides
    // would be a blocklist against a config surface git keeps growing — which
    // is why the restore replaces the whole file instead.
    await git(clone.dir, ...hooklessArgs(emptyHooks), "status", "--porcelain");
    expect(escaped("hookspath-fsmonitor")).toBe(true);
  }, 20_000);

  test("recycleClone contains both families", async () => {
    const { clone, base } = await agentOwnedClone("restored", "restored\n");
    plantHook(clone.dir, "post-checkout", "restored-hook");
    plantHook(clone.dir, "pre-commit", "restored-precommit");
    plantHook(clone.dir, "reference-transaction", "restored-refs");
    await plantFsmonitor(clone.dir, "restored-fsmonitor");

    const recycled = await recycleClone(clone, { base, reclaimed: sweptClean(clone) });
    await git(recycled.dir, "status", "--porcelain");

    expect(escaped("restored-hook")).toBe(false);
    expect(escaped("restored-precommit")).toBe(false);
    expect(escaped("restored-refs")).toBe(false);
    expect(escaped("restored-fsmonitor")).toBe(false);
    // The bytes, not the behaviour: the planted hooks are gone from disk and
    // the planted config key is gone from the file.
    expect(readdirSync(join(recycled.dir, ".git", "hooks"))).toEqual([]);
    expect(readFileSync(join(recycled.dir, ".git", "config"), "utf8")).not.toContain("fsmonitor");
  }, 20_000);

  test("after recycleClone, even an UNPROTECTED git command runs no planted hook", async () => {
    // The pair to the first negative control, and the version that can fail.
    //
    // This test used to perform the `rm -rf .git/hooks` itself and then run raw
    // git, which proved that the OPERATION works and nothing about whether the
    // module performs it — it would have stayed green with the module's
    // clearing deleted. So the module does the work now, and the raw command
    // comes afterwards: `-c core.hooksPath=<empty>` protects brigadier's own
    // spawns and cannot protect this one, so the only thing standing between
    // the planted hook and the canary is that `recycleClone` deleted it.
    const { clone, base } = await agentOwnedClone("hooksonly", "hooksonly\n");
    plantHook(clone.dir, "post-checkout", "hooksonly-hook");

    const recycled = await recycleClone(clone, { base, reclaimed: sweptClean(clone) });
    await git(recycled.dir, "checkout", "--force", "-B", "unprotected", "work");

    expect(escaped("hooksonly-hook")).toBe(false);
    expect(readdirSync(join(recycled.dir, ".git", "hooks"))).toEqual([]);
  }, 20_000);

  test("a `.gitattributes` filter planted by the agent is inert after the restore", async () => {
    // Family three collapses into family two: an attribute is a SELECTOR for an
    // execution surface, not one. It does nothing until the driver exists in
    // `.git/config`, and the restore replaces `.git/config` wholesale.
    const { clone, base } = await agentOwnedClone("attrs", "attrs\n");
    const smudge = join(scratch, "smudge.sh");
    writeFileSync(smudge, payload("attrs-smudge"), { mode: 0o755 });
    writeFileSync(join(clone.dir, ".gitattributes"), "a.txt filter=evil\n");
    await git(clone.dir, "config", "filter.evil.smudge", smudge);
    await git(clone.dir, ...hooklessArgs(emptyHooks), "add", ".gitattributes");
    await git(
      clone.dir,
      "-c",
      "user.email=w@example.com",
      "-c",
      "user.name=W",
      ...hooklessArgs(emptyHooks),
      "commit",
      "-q",
      "-m",
      "attrs",
    );

    const recycled = await recycleClone(clone, { base, reclaimed: sweptClean(clone) });
    rmSync(join(recycled.dir, "a.txt"), { force: true });
    await git(recycled.dir, ...hooklessArgs(emptyHooks), "checkout", "--", "a.txt");

    expect(escaped("attrs-smudge")).toBe(false);
  }, 20_000);

  test("overwriting the known-good config does not get the payload restored INTO the clone", async () => {
    // The copy on disk is a file an agent can reach. The authority is the
    // string held in memory, and the file is rewritten from it immediately
    // before the copy — so the worst an agent achieves is to have its own bytes
    // overwritten.
    const { clone, base } = await agentOwnedClone("goodconfig", "goodconfig\n");
    const script = join(scratch, "planted-config-fsmonitor.sh");
    writeFileSync(script, payload("goodconfig-fsmonitor"), { mode: 0o755 });
    writeFileSync(
      clone.knownGoodConfigPath,
      `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ${forwardSlashes(script)}\n`,
    );

    const recycled = await recycleClone(clone, { base, reclaimed: sweptClean(clone) });
    await git(recycled.dir, "status", "--porcelain");

    expect(escaped("goodconfig-fsmonitor")).toBe(false);
    expect(readFileSync(join(recycled.dir, ".git", "config"), "utf8")).not.toContain("fsmonitor");
  }, 20_000);
});

// ------------------------------------- the hooks sink is not the agent's

describe("the hooks sink", () => {
  test("NEGATIVE CONTROL: a hook planted in the sink runs, if the sink is not cleared", async () => {
    // `-c core.hooksPath=<dir>` makes that directory a live execution surface.
    // A sink brigadier merely created once is a directory an agent can write a
    // `post-checkout` into afterwards, and this is what that costs.
    const { clone } = await agentOwnedClone("sinkcontrol", "sinkcontrol\n");
    const sink = join(scratch, "writable-sink");
    plantHookIn(sink, "post-checkout", "sink-control");

    await git(clone.dir, ...hooklessArgs(sink), "checkout", "--force", "-B", "other", "work");
    expect(escaped("sink-control")).toBe(true);
  }, 20_000);

  test("recycleClone survives a hook planted in its own sink", async () => {
    const { clone, base } = await agentOwnedClone("sink", "sink\n");
    plantHookIn(clone.hermetic.hooksSink, "post-checkout", "sink-recycle");
    plantHookIn(clone.hermetic.hooksSink, "reference-transaction", "sink-refs");

    await recycleClone(clone, { base, reclaimed: sweptClean(clone) });

    expect(escaped("sink-recycle")).toBe(false);
    expect(escaped("sink-refs")).toBe(false);
    // The bytes: the sink was deleted and recreated, not merely bypassed.
    expect(readdirSync(clone.hermetic.hooksSink)).toEqual([]);
  }, 20_000);

  test("one item's sink is not another's, and cannot reach a clone no agent has been in", async () => {
    // The old sink was one directory per RUN, one level above the workspace, so
    // an agent working on item 1 could plant a hook that fired while brigadier
    // built item 2 — a clone no agent had ever been in. Per item, and cleared
    // before every invocation, there is no such path.
    const { clone, base, root } = await agentOwnedClone("crossitem", "crossitem\n");
    plantHookIn(clone.hermetic.hooksSink, "post-checkout", "cross-item");
    plantHookIn(clone.hermetic.hooksSink, "reference-transaction", "cross-item-refs");

    const second = await prepareClone({ base, item: 2, runRoot: root });

    expect(escaped("cross-item")).toBe(false);
    expect(escaped("cross-item-refs")).toBe(false);
    expect(second.hermetic.hooksSink).not.toBe(clone.hermetic.hooksSink);
    expect(relative(second.dir, second.hermetic.hooksSink).startsWith("..")).toBe(true);
  }, 20_000);

  test("a hook planted in .git/hooks does not fire on brigadier's OWN commands", async () => {
    // The clone is brigadier's here — no agent has been released into it — so
    // this is the planted-by-a-race case that `-c core.hooksPath=<empty>`
    // exists for. It is the only test in which that override is the sole
    // defence: with `hooklessArgs` returning nothing, this canary escapes.
    const { clone } = await preparedClone("race", "race\n");
    plantHook(clone.dir, "post-checkout", "race-hook");

    await runGit({
      cwd: clone.dir,
      args: ["checkout", "--force", "-B", "other", "work"],
      authority: clone.authority,
      hermetic: clone.hermetic,
    });

    expect(escaped("race-hook")).toBe(false);
  }, 20_000);
});

// ------------------------------------- the config levels .git/config is not

describe("git's other two config levels", () => {
  test("NEGATIVE CONTROL: core.fsmonitor in the global config fires on an ordinary command", async () => {
    // Ruling 61 deliberately puts the run root under the operator's HOME, so
    // `$HOME/.gitconfig` is not an exotic place for an agent to reach — and the
    // pooled restore covers exactly one of git's three config levels.
    const { clone } = await agentOwnedClone("globalcontrol", "globalcontrol\n");
    const script = join(scratch, "global-fsmonitor.sh");
    writeFileSync(script, payload("global-control"), { mode: 0o755 });
    const hostileGlobal = join(scratch, "hostile-gitconfig");
    writeFileSync(hostileGlobal, `[core]\n\tfsmonitor = ${forwardSlashes(script)}\n`);

    await rawGit({
      cwd: clone.dir,
      args: [...hooklessArgs(emptyHooks), "status", "--porcelain"],
      env: { GIT_CONFIG_GLOBAL: hostileGlobal },
    });
    expect(escaped("global-control")).toBe(true);
  }, 20_000);

  test("recycleClone is unaffected by a hostile global config", async () => {
    const { clone, base } = await agentOwnedClone("globalsafe", "globalsafe\n");
    const script = join(scratch, "global-fsmonitor-2.sh");
    writeFileSync(script, payload("global-safe"), { mode: 0o755 });
    const hostileGlobal = join(scratch, "hostile-gitconfig-2");
    writeFileSync(hostileGlobal, `[core]\n\tfsmonitor = ${forwardSlashes(script)}\n`);

    const previous = process.env["GIT_CONFIG_GLOBAL"];
    process.env["GIT_CONFIG_GLOBAL"] = hostileGlobal;
    try {
      const recycled = await recycleClone(clone, { base, reclaimed: sweptClean(clone) });
      await runGit({
        cwd: recycled.dir,
        args: ["status", "--porcelain"],
        authority: recycled.authority,
        hermetic: recycled.hermetic,
      });
    } finally {
      if (previous === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
      else process.env["GIT_CONFIG_GLOBAL"] = previous;
    }

    expect(escaped("global-safe")).toBe(false);
  }, 20_000);
});

// ------------------------------------------- ruling 56: the capability token

describe("brigadier runs no git command inside a clone an agent has had access to", () => {
  test("witnessOperator refuses an agent-owned clone, and nothing planted runs", async () => {
    const { clone } = await agentOwnedClone("witness", "witness\n");
    await plantFsmonitor(clone.dir, "witness-fsmonitor");

    // An exported function taking a bare path is the same capability as the
    // internal runner under a friendlier name. It is guarded at the spawn, not
    // by an export list.
    await expect(witnessOperator(clone.dir)).rejects.toThrow(/ruling 56/);
    expect(escaped("witness-fsmonitor")).toBe(false);
  }, 20_000);

  test("buildBaseState refuses an agent-owned clone, and nothing planted runs", async () => {
    const { clone } = await agentOwnedClone("basestate", "basestate\n");
    await plantFsmonitor(clone.dir, "basestate-fsmonitor");
    plantHook(clone.dir, "reference-transaction", "basestate-refs");

    await expect(
      buildBaseState({
        repo: clone.dir,
        runId: "hijack",
        scratchDir: join(scratch, "hijack-scratch"),
      }),
    ).rejects.toThrow(/ruling 56/);
    expect(escaped("basestate-fsmonitor")).toBe(false);
    expect(escaped("basestate-refs")).toBe(false);
  }, 20_000);

  test("a clone no agent has touched is refused too, by its on-disk signature", async () => {
    // The registry is in-process and exact; the signature is what survives a
    // process restart. A worker clone is never the argument these functions
    // want, released or not.
    const { clone } = await preparedClone("signature", "signature\n");
    await expect(witnessOperator(clone.dir)).rejects.toThrow(/worker clone/);
    expect(existsSync(join(clone.dir, ".git", "brigadier-clone"))).toBe(true);
  }, 20_000);

  test("deleting the on-disk signature does not buy the agent anything", async () => {
    // The signature is a file inside a directory the agent owns, so the agent
    // can remove it — and that is exactly why it is not the only signal. The
    // in-process registry is not on the agent's filesystem at all.
    const { clone } = await agentOwnedClone("delsig", "delsig\n");
    await plantFsmonitor(clone.dir, "delsig-fsmonitor");
    rmSync(join(clone.dir, ".git", "brigadier-clone"), { force: true });
    rmSync(join(clone.dir, ".git", "refs", "heads", "brigadier-base"), { force: true });

    await expect(witnessOperator(clone.dir)).rejects.toThrow(/handed to an agent/);
    expect(escaped("delsig-fsmonitor")).toBe(false);
  }, 20_000);

  test("deleting the token FAILS CLOSED, where deleting a marker failed open", async () => {
    // The earlier design was a marker that had to be ABSENT for git to run, one
    // directory above the workspace. `sh -c "rm -f ../1.agent-owned"` walked
    // straight through it. A token that must be PRESENT and must MATCH cannot
    // be walked through by deletion, and cannot be forged without the nonce.
    const { clone } = await preparedClone("token", "token\n");
    await plantFsmonitor(clone.dir, "token-fsmonitor");

    rmSync(clone.tokenPath, { force: true });
    await expect(
      runGit({
        cwd: clone.dir,
        args: ["status", "--porcelain"],
        authority: clone.authority,
        hermetic: clone.hermetic,
      }),
    ).rejects.toThrow(/no capability token/);
    expect(escaped("token-fsmonitor")).toBe(false);
  }, 20_000);

  test("forging a token is refused: the nonce is what is checked", async () => {
    const { clone } = await preparedClone("forge", "forge\n");
    await plantFsmonitor(clone.dir, "forge-fsmonitor");

    writeFileSync(clone.tokenPath, "an agent's guess");
    await expect(
      runGit({
        cwd: clone.dir,
        args: ["status", "--porcelain"],
        authority: clone.authority,
        hermetic: clone.hermetic,
      }),
    ).rejects.toThrow(/does not match/);
    expect(escaped("forge-fsmonitor")).toBe(false);
  }, 20_000);

  test("a PreparedClone kept across the door still typechecks, and still cannot run git", async () => {
    // The honest statement of what the types do. `releaseToAgent` returns a new
    // object and leaves this one valid to the compiler; what stops it is that
    // the file its nonce refers to is gone.
    const { clone } = await preparedClone("stale", "stale\n");
    await plantFsmonitor(clone.dir, "stale-fsmonitor");
    const stale: PreparedClone = clone;
    releaseToAgent(clone);

    await expect(
      runGit({
        cwd: stale.dir,
        args: ["status", "--porcelain"],
        authority: stale.authority,
        hermetic: stale.hermetic,
      }),
    ).rejects.toThrow(/no capability token/);
    expect(escaped("stale-fsmonitor")).toBe(false);
  }, 20_000);

  test("an authority for one clone does not authorise another", async () => {
    const first = await preparedClone("auth1", "auth1\n");
    const second = await prepareClone({ base: first.base, item: 2, runRoot: first.root });
    await plantFsmonitor(second.dir, "wrong-authority");

    await expect(
      runGit({
        cwd: second.dir,
        args: ["status", "--porcelain"],
        authority: first.clone.authority,
        hermetic: second.hermetic,
      }),
    ).rejects.toThrow(/does not authorise/);
    expect(escaped("wrong-authority")).toBe(false);
  }, 20_000);
});

// --------------------------------------------- ruling 19: clean -fdx is not tidy

describe("recycling leaves nothing of the previous item behind", () => {
  test("NEGATIVE CONTROL: checkout --force leaves untracked and gitignored residue", async () => {
    const { clone, base } = await agentOwnedClone("residue", "residue\n");
    writeFileSync(join(clone.dir, "scratch-note.txt"), "the previous item's junk\n");
    writeFileSync(join(clone.dir, "build.log"), "gitignored junk\n");

    await git(clone.dir, "fetch", "--no-tags", repo, `+${base.ref}:refs/heads/brigadier-base`);
    await git(clone.dir, "checkout", "--force", "-B", "work", "brigadier-base");

    expect(existsSync(join(clone.dir, "scratch-note.txt"))).toBe(true);
    expect(existsSync(join(clone.dir, "build.log"))).toBe(true);
  }, 20_000);

  test("recycleClone removes both, and lands on the NEXT item's base state", async () => {
    const { clone } = await agentOwnedClone("clean", "first item\n");
    writeFileSync(join(clone.dir, "scratch-note.txt"), "the previous item's junk\n");
    writeFileSync(join(clone.dir, "build.log"), "gitignored junk\n");
    writeFileSync(join(clone.dir, "a.txt"), "the agent's edit\n");
    await git(
      clone.dir,
      "-c",
      "user.email=w@example.com",
      "-c",
      "user.name=W",
      ...hooklessArgs(emptyHooks),
      "commit",
      "-q",
      "-am",
      "the agent's work",
    );

    writeFileSync(join(repo, "a.txt"), "second item\n");
    const next = await buildBaseState({
      repo,
      runId: "cleannext",
      scratchDir: join(runRootHome, "cleannext-scratch"),
    });

    const recycled = await recycleClone(clone, { base: next, reclaimed: sweptClean(clone) });

    expect(existsSync(join(recycled.dir, "scratch-note.txt"))).toBe(false);
    expect(existsSync(join(recycled.dir, "build.log"))).toBe(false);
    expect(readFileSync(join(recycled.dir, "a.txt"), "utf8")).toBe(checkedOut("second item\n", recycled.dir));
    // The agent's commit is not on `work` any more, and `work` is exactly the
    // new base: ruling 51's ownership diff reads `base..work`, and a leftover
    // commit would be attributed to the next item.
    expect(await git(recycled.dir, "rev-parse", "work")).toBe(next.sha);
    expect(await git(recycled.dir, "diff", "--name-only", "brigadier-base..work")).toBe("");
  }, 20_000);
});
