// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 61 (where a clone goes, and the refusals that happen before anything
 * is created) and ruling 51's `origin` removal, recorded as what it is: a speed
 * bump, not a boundary.
 *
 * Two of these tests exist because the earlier versions could not fail. One
 * computed its expected path with `itemDir()` — the same function the
 * implementation calls — so renaming the layout to `runs/place/item-7` would
 * have kept it green while ruling 61's whole point evaporated. The other handed
 * the temp-root refusal a path it had already resolved, so a lexical
 * implementation passed it and a clone would then have landed in `$TMPDIR`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBaseState,
  discardClone,
  intendedRealPath,
  pathBudgetRefusal,
  prepareClone,
  realTempDirs,
  recycleClone,
  releaseToAgent,
  type AgentOwnedClone,
  type BaseState,
  type ReclamationEvidence,
} from "../src/isolation/index.ts";

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

/** A git exit code, without throwing: the operator's `fsck` is the assertion. */
async function gitExit(cwd: string, ...args: string[]): Promise<number> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  await new Response(child.stdout).text();
  await new Response(child.stderr).text();
  return await child.exited;
}

let scratch: string;
let runRootHome: string;
let repo: string;
let base: BaseState;

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-placement-")));
  const home = join(homedir(), ".brigadier-test");
  mkdirSync(home, { recursive: true });
  runRootHome = realpathSync(mkdtempSync(join(home, "placement-")));

  repo = join(scratch, "parent");
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "operator@example.com");
  await git(repo, "config", "user.name", "Operator");
  writeFileSync(join(repo, "a.txt"), "hello\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");

  base = await buildBaseState({ repo, runId: "place", scratchDir: join(scratch, "state") });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(runRootHome, { recursive: true, force: true });
});

describe("ruling 61: where the clone goes", () => {
  test("the literal shape: <real run root>/r/<run-id>/<n>", async () => {
    const root = join(runRootHome, "shape");
    mkdirSync(root, { recursive: true });
    const clone = await prepareClone({ base, item: 7, runRoot: root });

    // Written out, not recomputed with `itemDir()`. `r` rather than `runs` and
    // a bare `7` rather than `item-7` are the ruling: 23 characters of spread
    // between the shortest and longest candidate, 13% of #5's measured budget.
    expect(clone.dir).toBe(join(realpathSync(root), "r", "place", "7"));
    expect(clone.dir.endsWith(`${join("r", "place", "7")}`)).toBe(true);
    // The real path, not the lexical one.
    expect(realpathSync(clone.dir)).toBe(clone.dir);
    for (const temp of realTempDirs()) {
      expect(clone.dir.startsWith(temp)).toBe(false);
    }
    discardClone(releaseToAgent(clone));
  }, 20_000);

  test("an UNRESOLVED temp path is refused, and nothing is created", async () => {
    // The path as `mkdtemp(os.tmpdir())` really returns it on macOS —
    // `/var/folders/...`, where `/var` is a symlink to `/private/var`. Handing
    // the refusal a pre-resolved path is what made the earlier version of this
    // test unable to fail: `resolve()` and `realpath()` agree on an already
    // resolved path, and disagree on this one.
    const tempRoot = mkdtempSync(join(tmpdir(), "brigadier-badroot-"));
    const resolved = realpathSync(tempRoot);
    if (process.platform === "darwin") expect(tempRoot).not.toBe(resolved);

    await expect(prepareClone({ base, item: 1, runRoot: tempRoot })).rejects.toThrow(/temp region/);
    // Nothing was created. A refusal after the clone is a cleanup problem.
    expect(readdirSync(resolved)).toEqual([]);
    expect(existsSync(join(resolved, "r"))).toBe(false);
    rmSync(resolved, { recursive: true, force: true });
  });

  test("a run root that does not exist yet is still judged on where it would land", () => {
    // `realpathSync` throws on a path that does not exist, which is why the
    // refusal needs the deepest existing ancestor plus the tail.
    const real = realpathSync(tmpdir());
    const intended = intendedRealPath(join(tmpdir(), "not-created-yet", "deeper"));
    expect(intended).toBe(join(real, "not-created-yet", "deeper"));
    expect(realTempDirs().some((temp) => intended.startsWith(temp))).toBe(true);
  });

  test("the path budget refuses end to end, before anything is created", async () => {
    // `fitsBudget` short-circuits to "fits" off Windows, so the only way to
    // exercise the refusal path from a Mac is to be Windows for one call. The
    // alternative is a platform-gated test, and a skipped test is not a passing
    // test.
    const root = join(runRootHome, "budget");
    mkdirSync(root, { recursive: true });
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const deep = { ...base, longestPath: join("src", "a".repeat(200), "file.ts") };
      await expect(prepareClone({ base: deep, item: 1, runRoot: root })).rejects.toThrow(
        /ruling 61: refusing this run before cloning/,
      );
      expect(existsSync(join(root, "r", "place", "1"))).toBe(false);
      expect(existsSync(join(root, "r"))).toBe(false);
    } finally {
      if (descriptor !== undefined) Object.defineProperty(process, "platform", descriptor);
    }
    // And the same run fits once the platform is itself again: the refusal is
    // about the budget, not about the arguments.
    const fine = await prepareClone({ base, item: 1, runRoot: root });
    expect(existsSync(fine.dir)).toBe(true);
    discardClone(releaseToAgent(fine));
  }, 20_000);

  test("the refusal names the offending path and the run root", () => {
    const worst = "C:\\Users\\alexandra.hemmingway\\.brigadier\\r\\a1b2c3\\12\\" + "x".repeat(200);
    const message = pathBudgetRefusal(
      { fits: false, worstPath: worst, budget: 220 },
      "C:\\Users\\alexandra.hemmingway\\.brigadier",
    );
    expect(message).toContain(worst);
    expect(message).toContain("C:\\Users\\alexandra.hemmingway\\.brigadier");
    expect(message).toContain("220");
    // Positive control: a run that fits produces no refusal at all.
    expect(pathBudgetRefusal({ fits: true, budget: 220 }, "C:\\Users\\x")).toBeNull();
  });

  test("core.autocrlf on the clone MATCHES the base, including a non-default value", async () => {
    // #5's defect is a MISMATCH, not an absence: it turned a one-line edit into
    // a six-line whole-file diff. Asserting the value is merely set would pass
    // with the clone hardcoded to something else entirely.
    const crlfRepo = join(scratch, "crlf");
    mkdirSync(crlfRepo, { recursive: true });
    await git(crlfRepo, "init", "-q", "-b", "main");
    await git(crlfRepo, "config", "user.email", "operator@example.com");
    await git(crlfRepo, "config", "user.name", "Operator");
    await git(crlfRepo, "config", "core.autocrlf", "input");
    writeFileSync(join(crlfRepo, "a.txt"), "hello\n");
    await git(crlfRepo, "add", "-A");
    await git(crlfRepo, "commit", "-q", "-m", "base");

    const crlfBase = await buildBaseState({
      repo: crlfRepo,
      runId: "crlf",
      scratchDir: join(scratch, "crlf-state"),
    });
    expect(crlfBase.autocrlf).toBe("input");

    const root = join(runRootHome, "crlf");
    mkdirSync(root, { recursive: true });
    const clone = await prepareClone({ base: crlfBase, item: 1, runRoot: root });
    expect(await git(clone.dir, "config", "--local", "--get", "core.autocrlf")).toBe(
      crlfBase.autocrlf,
    );

    // And the default case is written explicitly too, because "unset" is not
    // "matching" — `GIT_CONFIG_NOSYSTEM` means the value a Windows system
    // config would have supplied is not there to inherit.
    const plainRoot = join(runRootHome, "crlf-default");
    mkdirSync(plainRoot, { recursive: true });
    const plain = await prepareClone({ base, item: 1, runRoot: plainRoot });
    expect(await git(plain.dir, "config", "--local", "--get", "core.autocrlf")).toBe(base.autocrlf);
  }, 20_000);

  test("discarding takes the clone and its state with it", async () => {
    const root = join(runRootHome, "discard");
    mkdirSync(root, { recursive: true });
    const agent = releaseToAgent(await prepareClone({ base, item: 4, runRoot: root }));
    expect(existsSync(agent.dir)).toBe(true);
    expect(existsSync(agent.stateDir)).toBe(true);

    discardClone(agent);

    expect(existsSync(agent.dir)).toBe(false);
    expect(existsSync(agent.stateDir)).toBe(false);
  }, 20_000);

  test("an existing target is refused even when the agent emptied it", async () => {
    // Emptiness is not availability. An agent that removes its own files makes
    // the directory look free; the clone then lands on a path that is still
    // somebody's, and the failure arrives two git commands later.
    const root = join(runRootHome, "occupied");
    mkdirSync(root, { recursive: true });
    const clone = await prepareClone({ base, item: 3, runRoot: root });
    const agent = releaseToAgent(clone);
    rmSync(join(agent.dir, "a.txt"), { force: true });

    await expect(prepareClone({ base, item: 3, runRoot: root })).rejects.toThrow(/already exists/);

    // The per-item state directory is the first thing checked, so the refusal
    // above could be coming from it alone. Take it away and leave the workspace
    // COMPLETELY EMPTY: the target is still not free, and emptiness is still
    // not availability.
    rmSync(agent.stateDir, { recursive: true, force: true });
    rmSync(agent.dir, { recursive: true, force: true });
    mkdirSync(agent.dir, { recursive: true });
    expect(readdirSync(agent.dir)).toEqual([]);
    await expect(prepareClone({ base, item: 3, runRoot: root })).rejects.toThrow(/already exists/);
  }, 20_000);
});

describe("ruling 51: origin is removed, and that is a speed bump", () => {
  test("with origin gone the agent's push creates no branch in the operator's repo", async () => {
    const root = join(runRootHome, "push");
    mkdirSync(root, { recursive: true });
    const agent = releaseToAgent(await prepareClone({ base, item: 1, runRoot: root }));

    expect(await git(agent.dir, "remote")).toBe("");
    let pushed = true;
    try {
      await git(agent.dir, "push", "origin", "work:refs/heads/agent-planted");
    } catch {
      pushed = false;
    }
    expect(pushed).toBe(false);
    // The bytes: no such branch in the operator's repository.
    expect(await git(repo, "branch", "--list", "agent-planted")).toBe("");
  }, 20_000);

  test("NEGATIVE CONTROL: with origin present, the same push DOES create the branch", async () => {
    // The half that makes the removal worth doing, measured rather than
    // inherited from the ruling. A plain `git clone --local` keeps `origin`
    // pointing at the operator's repository, and from inside its own clone an
    // agent's push lands there.
    const withOrigin = join(scratch, "clone-with-origin");
    rmSync(withOrigin, { recursive: true, force: true });
    await git(scratch, "clone", "-q", "--local", repo, withOrigin);
    await git(withOrigin, "checkout", "-q", "-b", "work");

    await git(withOrigin, "push", "origin", "work:refs/heads/agent-planted-0");
    expect(await git(repo, "branch", "--list", "agent-planted-0")).toContain("agent-planted-0");
    await git(repo, "branch", "-D", "agent-planted-0");
  }, 20_000);

  test("HONEST COUNTERPART: a push to the parent's explicit path still lands", async () => {
    const root = join(runRootHome, "push2");
    mkdirSync(root, { recursive: true });
    const agent = releaseToAgent(await prepareClone({ base, item: 1, runRoot: root }));

    await git(agent.dir, "push", repo, "work:refs/heads/agent-planted-2");
    // It landed. This is why `remote remove origin` is a speed bump: it stops
    // an accidental `git pull` mid-run and the reflexive `git push origin`, and
    // it stops nothing that is trying.
    expect(await git(repo, "branch", "--list", "agent-planted-2")).toContain("agent-planted-2");
    await git(repo, "branch", "-D", "agent-planted-2");
  }, 20_000);

  test("origin stays removed across a recycle", async () => {
    const root = join(runRootHome, "push3");
    mkdirSync(root, { recursive: true });
    const agent = releaseToAgent(await prepareClone({ base, item: 1, runRoot: root }));
    // The agent adds it back, which it is free to do inside its own clone.
    await git(agent.dir, "remote", "add", "origin", repo);

    const recycled = await recycleClone(agent, { base, reclaimed: sweptClean(agent) });
    // The known-good config was captured AFTER the removal, so restoring it
    // does not restore `origin`.
    expect(await git(recycled.dir, "remote")).toBe("");
  }, 20_000);
});

describe("the operator's object store is not shared with a worker clone", () => {
  test("objects are copied, and a hostile write inside the clone leaves fsck clean", async () => {
    // Its own parent repository: this test writes hostile bytes, and a shared
    // fixture would make the damage look like someone else's bug.
    const doomed = join(scratch, "doomed-parent");
    mkdirSync(doomed, { recursive: true });
    await git(doomed, "init", "-q", "-b", "main");
    await git(doomed, "config", "user.email", "operator@example.com");
    await git(doomed, "config", "user.name", "Operator");
    writeFileSync(join(doomed, "a.txt"), "the operator's history\n");
    await git(doomed, "add", "-A");
    await git(doomed, "commit", "-q", "-m", "base");
    // Packed, which is what a real repository looks like: one file holding
    // every object, hardlinked into every clone that does not say otherwise.
    await git(doomed, "gc", "-q");

    const doomedBase = await buildBaseState({
      repo: doomed,
      runId: "objects",
      scratchDir: join(scratch, "objects-state"),
    });
    const root = join(runRootHome, "objects");
    mkdirSync(root, { recursive: true });
    const agent = releaseToAgent(await prepareClone({ base: doomedBase, item: 1, runRoot: root }));

    // 1. Nothing in the clone's object store shares an inode with anything.
    const objects = join(agent.dir, ".git", "objects");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, name.name);
        if (name.isDirectory()) walk(path);
        else if (name.isFile()) files.push(path);
      }
    };
    walk(objects);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(lstatSync(file).nlink).toBe(1);

    // 2. The agent does the worst thing available to it: overwrites the object
    // store from inside the directory it was given. No git, no escape, one
    // write. With `git clone --local` and no `--no-hardlinks` this replaced the
    // operator's pack and left them at `git fsck` exit 94, `git log` exit 128.
    const operatorPack = readdirSync(join(doomed, ".git", "objects", "pack")).find((name) =>
      name.endsWith(".pack"),
    )!;
    const operatorPackPath = join(doomed, ".git", "objects", "pack", operatorPack);
    const operatorBytes = readFileSync(operatorPackPath);
    for (const file of files) {
      chmodSync(file, 0o644);
      writeFileSync(file, "OWNED BY THE AGENT\n");
    }

    // 3. The operator's bytes, and the operator's repository, are untouched.
    expect(readFileSync(operatorPackPath).equals(operatorBytes)).toBe(true);
    expect(await gitExit(doomed, "fsck", "--no-progress")).toBe(0);
    expect(await gitExit(doomed, "log", "--oneline", "-1")).toBe(0);
    expect(await gitExit(doomed, "cat-file", "-p", "HEAD")).toBe(0);
  }, 30_000);
});
