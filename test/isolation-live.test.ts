// SPDX-License-Identifier: Apache-2.0
/**
 * The seven escapes a third blind critic found, each reproduced against a real
 * clone and each closed.
 *
 * The critic's verdict was "I can make brigadier execute agent-supplied code,
 * deterministically, twice in a row, with no race-tuning and without ever
 * leaving the clone directory the agent already owns". It was right, and the
 * reason it was right is worth stating once: the capability token proves *is
 * this directory brigadier's right now*, and the invariant needs *is this
 * directory free of agent-supplied execution surfaces right now*. Authority was
 * durable and sanitisation was instantaneous, and git re-reads `.git/config`
 * from disk on every single invocation.
 *
 * Every test here plants a payload that writes a canary OUTSIDE the clone, and
 * every one has a negative control proving the payload is live — because a
 * containment test whose payload never worked is indistinguishable from one
 * that contains it. Nothing asserts on a flag.
 *
 * The loop variants of E1 and E3 are NOT tested by timing. A test that has to
 * win a race is a flake, and a flaky gate gets ignored. They are answered by
 * `ReclamationEvidence` instead, which is tested here as a refusal.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowedEnv,
  buildBaseState,
  claimedByManifest,
  prepareClone,
  recycleClone,
  releaseToAgent,
  UnsafePath,
  witnessOperator,
  type AgentOwnedClone,
  type BaseState,
  type PreparedClone,
  type ReclamationEvidence,
} from "../src/isolation/index.ts";
import { runGit } from "../src/isolation/internal-git.ts";

/** Raw git: whatever the parent environment holds, no sanitisation. The hostile baseline. */
async function rawGit(run: {
  cwd: string;
  args: string[];
  env?: Record<string, string>;
}): Promise<number> {
  const child = Bun.spawn(["git", ...run.args], {
    cwd: run.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...run.env },
  });
  await new Response(child.stdout).text();
  await new Response(child.stderr).text();
  return await child.exited;
}

const git = async (cwd: string, ...args: string[]): Promise<number> => rawGit({ cwd, args });

let scratch: string;
let runRootHome: string;
let canaryDir: string;
let repo: string;

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-live-")));
  const home = join(homedir(), ".brigadier-test");
  mkdirSync(home, { recursive: true });
  runRootHome = realpathSync(mkdtempSync(join(home, "live-")));
  canaryDir = join(scratch, "escaped");
  mkdirSync(canaryDir, { recursive: true });

  repo = join(scratch, "parent");
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "operator@example.com");
  await git(repo, "config", "user.name", "Operator");
  writeFileSync(join(repo, "a.txt"), "hello\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(runRootHome, { recursive: true, force: true });
});

/**
 * `C:\a\b` -> `C:/a/b`, and a no-op on POSIX, where paths carry no backslashes.
 *
 * ONLY the COMMAND git is pointed at, never the canary path inside the script.
 * Git for Windows runs a `core.fsmonitor` through its own bundled `sh`, which
 * eats backslashes as escapes, so a native `C:\Users\...` arrives as
 * `C:Users...`, names nothing, and git ignores the failure IN SILENCE — which is
 * why every control below read as inert rather than as an error.
 *
 * MEASURED on `windows-latest` 2026-08-20, run 32415677392, job 96576151123, by
 * `test/git-payload-shape.test.ts`: all four payload shapes FIRED, including
 * `sh` + `touch` + a native canary path, because that file forwards the command
 * path in its own setup line. The canary path inside the script needs no such
 * treatment and does not get it. `OWNER-QUESTIONS.md` #13 records the whole
 * separation, and what it refutes.
 */
const forwardSlashes = (path: string): string => path.replace(/\\/g, "/");

function payloadScript(canary: string): string {
  const path = join(scratch, `payload-${canary}.sh`);
  writeFileSync(path, `#!/bin/sh\ntouch "${join(canaryDir, canary)}"\nexit 0\n`, { mode: 0o755 });
  // The FILE is written at its native path; what is RETURNED is the spelling git
  // is handed, and those are not the same string on Windows.
  return forwardSlashes(path);
}

const escaped = (canary: string): boolean => existsSync(join(canaryDir, canary));
const forget = (canary: string): void => rmSync(join(canaryDir, canary), { force: true });

/** `.git/config` carrying a `core.fsmonitor`, which fires on an ordinary `git status`. */
function poisonedConfig(canary: string): string {
  return `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ${payloadScript(canary)}\n`;
}

let runCounter = 0;
async function preparedClone(label: string): Promise<{ clone: PreparedClone; base: BaseState }> {
  const runId = `${label}${runCounter++}`;
  const root = join(runRootHome, runId);
  mkdirSync(root, { recursive: true });
  const base = await buildBaseState({ repo, runId, scratchDir: join(root, "scratch") });
  return { clone: await prepareClone({ base, item: 1, runRoot: root }), base };
}

async function agentOwnedClone(
  label: string,
): Promise<{ clone: AgentOwnedClone; base: BaseState }> {
  const { clone, base } = await preparedClone(label);
  return { clone: releaseToAgent(clone), base };
}

/** Honest for this file: no worker process is spawned, so there is nothing to reclaim. */
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

// =========================================================== E1

describe("E1: re-poisoning .git/config after the restore", () => {
  test("NEGATIVE CONTROL: the payload really does fire from a poisoned .git/config", async () => {
    const { clone } = await agentOwnedClone("e1control");
    forget("e1-control");
    writeFileSync(join(clone.dir, ".git", "config"), poisonedConfig("e1-control"));
    await git(clone.dir, "status", "--porcelain");
    expect(escaped("e1-control")).toBe(true);
  }, 20_000);

  test("one write after recycleClone returns owns NO later spawn", async () => {
    const { clone, base } = await agentOwnedClone("e1");
    const recycled = await recycleClone(clone, { base, reclaimed: sweptClean(clone) });

    // The escape, exactly as reported: a single `writeFileSync` AFTER the
    // recycle has returned. No loop, no race-tuning, and the directory is the
    // one the agent already owns.
    forget("e1-after");
    writeFileSync(recycled.hermetic.config.path, poisonedConfig("e1-after"));

    await runGit({
      cwd: recycled.dir,
      args: ["status", "--porcelain"],
      authority: recycled.authority,
      hermetic: recycled.hermetic,
    });

    expect(escaped("e1-after")).toBe(false);
    // And the bytes: the config on disk is brigadier's again, because the
    // rewrite happens immediately before every spawn rather than once per
    // recycle. git re-reads this file on every invocation.
    expect(readFileSync(recycled.hermetic.config.path, "utf8")).not.toContain("fsmonitor");
  }, 20_000);

  test("and the second spawn is protected exactly like the first", async () => {
    // "Twice in a row" was the critic's phrase. Two poisonings, two spawns.
    const { clone, base } = await agentOwnedClone("e1twice");
    const recycled = await recycleClone(clone, { base, reclaimed: sweptClean(clone) });

    for (const canary of ["e1-first", "e1-second"]) {
      forget(canary);
      writeFileSync(recycled.hermetic.config.path, poisonedConfig(canary));
      await runGit({
        cwd: recycled.dir,
        args: ["status", "--porcelain"],
        authority: recycled.authority,
        hermetic: recycled.hermetic,
      });
      expect(escaped(canary)).toBe(false);
    }
  }, 20_000);
});

// =========================================================== E2

describe("E2: the empty global config, written once and read forever", () => {
  test("NEGATIVE CONTROL: filling that file in makes the payload fire", async () => {
    const { clone } = await preparedClone("e2control");
    forget("e2-control");
    writeFileSync(clone.hermetic.emptyGlobalConfig, poisonedConfig("e2-control"));
    // Raw git, pointed at the same file the hermetic invocation points at.
    await rawGit({
      cwd: clone.dir,
      args: ["status", "--porcelain"],
      env: { GIT_CONFIG_GLOBAL: clone.hermetic.emptyGlobalConfig },
    });
    expect(escaped("e2-control")).toBe(true);
  }, 20_000);

  test("the file is rewritten from memory before every spawn, not once at creation", async () => {
    const { clone } = await preparedClone("e2");
    forget("e2-poisoned");
    // The escape: the pointer was closed and the hole moved to its target. One
    // static write to the file `GIT_CONFIG_GLOBAL` aims at, no race.
    writeFileSync(clone.hermetic.emptyGlobalConfig, poisonedConfig("e2-poisoned"));

    await runGit({
      cwd: clone.dir,
      args: ["status", "--porcelain"],
      authority: clone.authority,
      hermetic: clone.hermetic,
    });

    expect(escaped("e2-poisoned")).toBe(false);
    expect(readFileSync(clone.hermetic.emptyGlobalConfig, "utf8")).toBe("");
  }, 20_000);
});

// ======================================================== E5 and E6

describe("E5 and E6: the environment is built, not inherited", () => {
  test("NEGATIVE CONTROL: GIT_CONFIG_COUNT needs no file at all, and fires", async () => {
    const { clone } = await preparedClone("e5control");
    forget("e5-control");
    await rawGit({
      cwd: clone.dir,
      args: ["status", "--porcelain"],
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: payloadScript("e5-control"),
      },
    });
    expect(escaped("e5-control")).toBe(true);
  }, 20_000);

  test("GIT_CONFIG_COUNT in brigadier's own environment does not reach the child", async () => {
    const { clone } = await preparedClone("e5");
    forget("e5-env");
    const saved = { ...process.env };
    process.env["GIT_CONFIG_COUNT"] = "1";
    process.env["GIT_CONFIG_KEY_0"] = "core.fsmonitor";
    process.env["GIT_CONFIG_VALUE_0"] = payloadScript("e5-env");
    try {
      await runGit({
        cwd: clone.dir,
        args: ["status", "--porcelain"],
        authority: clone.authority,
        hermetic: clone.hermetic,
      });
    } finally {
      for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
    expect(escaped("e5-env")).toBe(false);
  }, 20_000);

  test("NEGATIVE CONTROL: GIT_DIR moves an ordinary command into the agent's clone", async () => {
    const { clone } = await agentOwnedClone("e6control");
    forget("e6-control");
    writeFileSync(join(clone.dir, ".git", "config"), poisonedConfig("e6-control"));
    // The cwd is the operator's repository and looks innocent. The command runs
    // in the clone anyway.
    await rawGit({
      cwd: repo,
      args: ["status", "--porcelain"],
      env: { GIT_DIR: join(clone.dir, ".git"), GIT_WORK_TREE: clone.dir },
    });
    expect(escaped("e6-control")).toBe(true);
  }, 20_000);

  test("GIT_DIR cannot redirect witnessOperator into a released clone", async () => {
    const { clone } = await agentOwnedClone("e6");
    forget("e6-env");
    writeFileSync(join(clone.dir, ".git", "config"), poisonedConfig("e6-env"));
    writeFileSync(join(repo, "operator-only.txt"), "the operator's own untracked file\n");

    const saved = { dir: process.env["GIT_DIR"], tree: process.env["GIT_WORK_TREE"] };
    process.env["GIT_DIR"] = join(clone.dir, ".git");
    process.env["GIT_WORK_TREE"] = clone.dir;
    let witness;
    try {
      witness = await witnessOperator(repo);
    } finally {
      if (saved.dir === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved.dir;
      if (saved.tree === undefined) delete process.env["GIT_WORK_TREE"];
      else process.env["GIT_WORK_TREE"] = saved.tree;
    }

    expect(escaped("e6-env")).toBe(false);
    // And it really did witness the OPERATOR's repository, not the clone's.
    expect(witness.status).toContain("operator-only.txt");
    rmSync(join(repo, "operator-only.txt"), { force: true });
  }, 20_000);

  test("the allowlist keeps PATH and drops every git redirection variable", () => {
    const hostile = {
      PATH: "/usr/bin",
      HOME: "/home/operator",
      GIT_DIR: "/somewhere/.git",
      GIT_WORK_TREE: "/somewhere",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_GLOBAL: "/hostile/gitconfig",
      GIT_OBJECT_DIRECTORY: "/hostile/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/hostile/alt",
      GIT_SSH_COMMAND: "/hostile/ssh",
      GIT_EXTERNAL_DIFF: "/hostile/diff",
      LD_PRELOAD: "/hostile/lib.so",
      DYLD_INSERT_LIBRARIES: "/hostile/lib.dylib",
    };
    // An allowlist, so a variable git grows next year is excluded by default
    // rather than by an update to a blocklist.
    expect(allowedEnv(hostile)).toEqual({ PATH: "/usr/bin", HOME: "/home/operator" });
  });
});

// =========================================================== E7

describe("E7: writing through a symlinked .git/config", () => {
  test("NEGATIVE CONTROL: copyFileSync follows the link and overwrites the target", () => {
    const victim = join(scratch, "e7-victim-control");
    writeFileSync(victim, "the operator's file\n");
    const link = join(scratch, "e7-link-control");
    rmSync(link, { force: true });
    symlinkSync(victim, link);
    const source = join(scratch, "e7-source");
    writeFileSync(source, "brigadier's known-good config\n");

    copyFileSync(source, link);

    // This is the hazard, in two lines: the write landed outside, and the link
    // is still a link, so the next reader reads a path the agent chose.
    expect(readFileSync(victim, "utf8")).toBe("brigadier's known-good config\n");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test("recycleClone refuses, and does not touch the file the link points at", async () => {
    const { clone, base } = await agentOwnedClone("e7");
    const victim = join(scratch, "e7-victim");
    writeFileSync(victim, "the operator's file\n");

    const configPath = join(clone.dir, ".git", "config");
    rmSync(configPath, { force: true });
    symlinkSync(victim, configPath);

    await expect(recycleClone(clone, { base, reclaimed: sweptClean(clone) })).rejects.toThrow(
      UnsafePath,
    );

    // The bytes outside the clone are untouched.
    expect(readFileSync(victim, "utf8")).toBe("the operator's file\n");
    // Refuse, never repair: the directory is left exactly as found, because a
    // silent fix for a clone that has just demonstrated something is wrong with
    // it is how a defect becomes invisible.
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
  }, 20_000);

  test("an authorised spawn refuses the same link rather than writing through it", async () => {
    const { clone } = await preparedClone("e7spawn");
    const victim = join(scratch, "e7-victim-spawn");
    writeFileSync(victim, "the operator's file\n");
    rmSync(clone.hermetic.config.path, { force: true });
    symlinkSync(victim, clone.hermetic.config.path);

    await expect(
      runGit({
        cwd: clone.dir,
        args: ["status", "--porcelain"],
        authority: clone.authority,
        hermetic: clone.hermetic,
      }),
    ).rejects.toThrow(/symlink/);
    expect(readFileSync(victim, "utf8")).toBe("the operator's file\n");
  }, 20_000);

  test("a hard link is refused too, because there is no symlink to see", async () => {
    const { clone } = await preparedClone("e7hard");
    const victim = join(scratch, "e7-victim-hard");
    writeFileSync(victim, "the operator's file\n");
    rmSync(clone.hermetic.config.path, { force: true });
    await Bun.spawn(["ln", victim, clone.hermetic.config.path]).exited;

    await expect(
      runGit({
        cwd: clone.dir,
        args: ["status", "--porcelain"],
        authority: clone.authority,
        hermetic: clone.hermetic,
      }),
    ).rejects.toThrow(/links/);
    expect(readFileSync(victim, "utf8")).toBe("the operator's file\n");
  }, 20_000);
});

// =========================================================== E4

describe("E4: the durable signature", () => {
  test("git gc alone erases the in-clone signals, and the manifest still refuses", async () => {
    // Never released, so the in-process registry has nothing to say — which is
    // the case a second process would always be in.
    const { clone } = await preparedClone("e4");
    forget("e4-manifest");
    writeFileSync(join(clone.dir, ".git", "config"), poisonedConfig("e4-manifest"));

    // MEASURED against `git 2.50.1` on 2026-08-17: `pack-refs --all` moves
    // `refs/heads/brigadier-base` into `packed-refs` and removes the loose
    // file. `git gc` runs `pack-refs`, so this needs no hostile intent at all.
    await git(clone.dir, "pack-refs", "--all");
    expect(existsSync(join(clone.dir, ".git", "refs", "heads", "brigadier-base"))).toBe(false);
    // And the marker file is inside a directory the agent owns.
    rmSync(join(clone.dir, ".git", "brigadier-clone"), { force: true });

    await expect(witnessOperator(clone.dir)).rejects.toThrow(/worker clone, recorded in/);
    expect(escaped("e4-manifest")).toBe(false);

    // The manifest is what did it, and it is outside the clone.
    const manifest = claimedByManifest(clone.dir);
    expect(manifest).not.toBeNull();
    expect(manifest!.startsWith(clone.dir)).toBe(false);
  }, 20_000);

  test("NEGATIVE CONTROL: with the manifest gone as well, nothing refuses", async () => {
    // The honest limit, stated with bytes rather than left to inference. An
    // agent that can write outside its own clone can delete the manifest too;
    // ruling 15's record is what survives everything an agent does INSIDE the
    // directory it was given, which is the case the erased in-clone signature
    // failed at.
    const { clone } = await preparedClone("e4limit");
    forget("e4-limit");
    writeFileSync(join(clone.dir, ".git", "config"), poisonedConfig("e4-limit"));
    await git(clone.dir, "pack-refs", "--all");
    rmSync(join(clone.dir, ".git", "brigadier-clone"), { force: true });
    const manifest = claimedByManifest(clone.dir);
    rmSync(manifest!, { force: true });

    await witnessOperator(clone.dir);
    expect(escaped("e4-limit")).toBe(true);
  }, 20_000);
});

// =========================================================== E3

describe("E3: a live agent has to be impossible, not unlikely", () => {
  test("recycleClone refuses when the sweep reports a survivor, before touching anything", async () => {
    const { clone, base } = await agentOwnedClone("e3survivor");
    forget("e3-survivor");
    writeFileSync(join(clone.dir, ".git", "config"), poisonedConfig("e3-survivor"));

    await expect(
      recycleClone(clone, {
        base,
        reclaimed: { ...sweptClean(clone), survivors: [4242], sweptBy: "a sweep that tried" },
      }),
    ).rejects.toThrow(/could not reclaim/);
    // No git ran: the refusal is the first thing recycleClone does.
    expect(escaped("e3-survivor")).toBe(false);
  }, 20_000);

  test("recycleClone refuses when a pid the sweep claims to have reclaimed is alive", async () => {
    const { clone, base } = await agentOwnedClone("e3alive");
    // A real process, checked with signal 0 rather than taken on trust. This is
    // the part of the sweep's claim this module can verify for itself.
    const survivor = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      await expect(
        recycleClone(clone, {
          base,
          reclaimed: { ...sweptClean(clone), reclaimedPids: [survivor.pid] },
        }),
      ).rejects.toThrow(/still alive/);
    } finally {
      survivor.kill();
      await survivor.exited;
    }

    // And once it really is gone, the same evidence is accepted.
    const recycled = await recycleClone(clone, {
      base,
      reclaimed: { ...sweptClean(clone), reclaimedPids: [survivor.pid] },
    });
    expect(existsSync(join(recycled.dir, "a.txt"))).toBe(true);
  }, 30_000);

  test("recycleClone refuses evidence older than the release, or about another item", async () => {
    const { clone, base } = await agentOwnedClone("e3stale");
    await expect(
      recycleClone(clone, {
        base,
        reclaimed: { ...sweptClean(clone), sweptAt: clone.releasedAt - 1 },
      }),
    ).rejects.toThrow(/says nothing about the processes the release started/);

    await expect(
      recycleClone(clone, { base, reclaimed: { ...sweptClean(clone), item: 99 } }),
    ).rejects.toThrow(/the evidence names/);

    await expect(
      recycleClone(clone, { base, reclaimed: { ...sweptClean(clone), runId: "someone-else" } }),
    ).rejects.toThrow(/the evidence names/);
  }, 20_000);
});
