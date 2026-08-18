// SPDX-License-Identifier: Apache-2.0
/**
 * `runSampled`'s timeout, against the same defect `bar/lib/proc.test.ts` names
 * for `exec`.
 *
 * `runSampled` is the OTHER place that spawns the real binary and kills it on a
 * timeout — items 2, 3, 4, 9, 11 and 12 all drive live runs through it while
 * sampling the filesystem and the process table. It had its own copy of the
 * single-pid `proc.kill("SIGKILL")`, so a timeout here would have left the same
 * kind of orphaned ACP vendor child behind that `exec`'s did. Proven the same
 * way: a `/bin/sh` standing in for the binary backgrounds a child, the sampled
 * run times out, and the child must not outlive it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSampled } from "./inflight.ts";

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
      // Already gone, which is what this file is trying to prove.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

test("a backgrounded child of a sampled run does not outlive its timeout", async () => {
  if (process.platform === "win32") return; // no `&` job control to model this with
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-inflight-proc-")));
  const runRoot = join(scratch, "runs");
  const pidFile = join(scratch, "child.pid");

  const result = await runSampled(
    ["/bin/sh", "-c", `sleep 300 & echo $! > ${JSON.stringify(pidFile)}; sleep 300`],
    { runRoot, timeoutMs: 500, intervalMs: 20 },
  );

  expect(result.code).toBeNull();
  expect(result.signal).toBe("BAR_TIMEOUT");

  const deadline = Date.now() + 5_000;
  while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(pidFile)).toBe(true);
  const childPid = Number(readFileSync(pidFile, "utf8").trim());
  expect(childPid).toBeGreaterThan(0);
  stragglers.push(childPid);

  expect(isAlive(childPid)).toBe(false);
}, 20_000);
