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

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TIMEOUT_SIGNAL, exec } from "./proc.ts";

let scratch: string;
const stragglers: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterAll(() => {
  for (const pid of stragglers) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is what every test below is trying to prove.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("a timed-out invocation's descendants are reclaimed too", () => {
  test("a backgrounded child of the killed process does not outlive it", async () => {
    if (process.platform === "win32") return; // no `&` job control to model this with
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-proc-")));
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

  test("a process that exits on its own within the budget is unaffected", async () => {
    const result = await exec(["/bin/sh", "-c", "echo hi"], { timeoutMs: 5_000 });
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout.trim()).toBe("hi");
  });
});
