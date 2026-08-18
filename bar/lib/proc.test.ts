// SPDX-License-Identifier: Apache-2.0
/**
 * `exec`'s timeout, against the failure it is actually for.
 *
 * MEASURED on this host on 2026-08-18: a `--live` `bar/run.ts` run against the
 * real binary timed out inside `exec`, `proc.kill("SIGKILL")` reaped the direct
 * child, and TWO of its own ACP vendor children — `--brigadier-run` markers
 * still in their command lines — were left behind, reparented to `launchd`,
 * each pinning a core at ~100% CPU indefinitely. Killing one pid was never
 * going to catch a child of that pid, and by the time anyone looked the item's
 * `finally` had already deleted the run root a later sweep would have needed.
 *
 * This is that scenario, reproduced with `/bin/sh` standing in for the real
 * binary and its own backgrounded `&` job standing in for the ACP child: both
 * outlive the timeout unless the WHOLE group is reclaimed, not just the pid
 * `exec` holds a handle to.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TIMEOUT_SIGNAL, exec, killTree } from "./proc.ts";

let scratch: string;
const stragglers: number[] = [];
const groups: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Bounded, because a cleanup that waits forever is not a cleanup. */
async function waitForFile(path: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(20);
  return existsSync(path);
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-proc-")));
});

afterAll(() => {
  // Groups first: the negative control deliberately leaves a whole tree alive,
  // and reaping only the pids it published would leave its intermediate shell.
  for (const pid of groups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const pid of stragglers) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is what every test below is trying to prove.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * The real shape, one level deeper than a backgrounded job.
 *
 * `bar/lib/fixtures.ts` plants each vendor as a `/bin/sh` shim that `exec`s
 * `bun bar/fakes/vendor.ts`, and the fixture itself spawns too. So the tree the
 * group kill has to reach is `exec`'s child → a shell → a descendant, not
 * `exec`'s child → a descendant. This builds exactly that, and the innermost
 * process publishes its own pid so "still running" is `kill(pid, 0)` rather than
 * an inference.
 */
function grandchildTree(name: string): { argv: string[]; pidFile: string } {
  const pidFile = join(scratch, `${name}.pid`);
  const inner = join(scratch, `${name}-inner.sh`);
  const outer = join(scratch, `${name}-outer.sh`);
  writeFileSync(inner, "#!/bin/sh\nsleep 300 &\necho $! > \"$1\"\nsleep 300\n", { mode: 0o755 });
  writeFileSync(outer, `#!/bin/sh\n/bin/sh ${JSON.stringify(inner)} "$1" &\nsleep 300\n`, { mode: 0o755 });
  return { argv: ["/bin/sh", outer, pidFile], pidFile };
}

describe("a timed-out invocation's descendants are reclaimed too", () => {
  test("a backgrounded child of the killed process does not outlive it", async () => {
    if (process.platform === "win32") return; // no `&` job control to model this with
    const pidFile = join(scratch, "child.pid");

    // Stands in for the product spawning an ACP vendor: a descendant left
    // running in the SAME process group as the pid `exec` is about to kill,
    // reachable only by a group signal.
    const result = await exec(
      ["/bin/sh", "-c", `sleep 300 & echo $! > ${JSON.stringify(pidFile)}; sleep 300`],
      { timeoutMs: 500 },
    );

    expect(result.code).toBeNull();
    expect(result.signal).toBe(TIMEOUT_SIGNAL);

    // The pid file is the fixture's own proof of what it spawned, read after
    // the fact rather than assumed from the shell source.
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(pidFile)).toBe(true);
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(childPid).toBeGreaterThan(0);
    stragglers.push(childPid);

    // The bytes, not a boolean: signal 0 against the pid the fixture itself
    // published. Before the group kill this was the leak — `exec` had already
    // returned, believing it was done, with this pid still alive and spinning.
    expect(isAlive(childPid)).toBe(false);
  }, 20_000);

  test("a GRANDCHILD is reclaimed too — the fixture spawns, so one level is not enough", async () => {
    if (process.platform === "win32") return;
    const { argv, pidFile } = grandchildTree("grandchild");

    const result = await exec(argv, { timeoutMs: 500 });
    expect(result.signal).toBe(TIMEOUT_SIGNAL);

    expect(await waitForFile(pidFile, 5_000)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    stragglers.push(pid);

    // The group signal is not depth-limited, and this is the assertion that
    // says so on a pid rather than on the man page.
    expect(isAlive(pid)).toBe(false);
  }, 20_000);

  test("NEGATIVE CONTROL: killing only the pid leaves that same grandchild running", async () => {
    if (process.platform === "win32") return;
    const { argv, pidFile } = grandchildTree("single-pid");

    // Spawned exactly as `exec` spawns — same argv, same `detached: true`, so
    // the ONLY difference from the test above is which signal is sent. Without
    // that difference this pair would prove nothing about the group kill.
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
    groups.push(proc.pid);

    expect(await waitForFile(pidFile, 10_000)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    stragglers.push(pid);

    proc.kill("SIGKILL"); // the pre-fix reap: one pid, no group
    const deadline = Date.now() + 3_000;
    while (proc.exitCode === null && proc.signalCode === null && Date.now() < deadline) await Bun.sleep(20);

    // THE LEAK, measured. This is the state two orphaned ACP vendor fixtures
    // were found in on 2026-08-17: parent reaped, descendant alive.
    expect(isAlive(pid)).toBe(true);

    // And the fix reclaims it after the fact, which is the same call `exec`
    // makes on timeout.
    killTree(proc);
    const gone = Date.now() + 5_000;
    while (isAlive(pid) && Date.now() < gone) await Bun.sleep(20);
    expect(isAlive(pid)).toBe(false);
  }, 30_000);

  test("a process that exits on its own within the budget is unaffected", async () => {
    const result = await exec(["/bin/sh", "-c", "echo hi"], { timeoutMs: 5_000 });
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout.trim()).toBe("hi");
  });
});
