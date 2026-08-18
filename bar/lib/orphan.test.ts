// SPDX-License-Identifier: Apache-2.0
/**
 * The orphan guard, and the straggler it was written for.
 *
 * MEASURED on this host on 2026-08-17: two `bar/fakes/vendor.ts` processes were
 * found alive at 98.7% and 100% CPU with `--brigadier-run` markers still in
 * their command lines, reparented after their parents were reaped. The process
 * group kill in `bar/lib/proc.ts` covers the case where this harness is the
 * killer; it cannot cover item 7, which SIGKILLs the orchestrator deliberately
 * and by design leaves whatever that orchestrator spawned behind.
 *
 * So the fixture watches its own `ppid`. This drives the exact shape: a shell
 * that starts the vendor, a FIFO writer that keeps the vendor's stdin OPEN so
 * that end-of-input cannot be the reason it stops, and — the control — a plain
 * `sleep` started by the same shell in the same breath. Killing the shell alone
 * orphans all three. The vendor must exit; the `sleep`, which carries no guard,
 * must not. Without that second half the test would pass just as well if the
 * kill had reached the whole tree, which is precisely the confusion the
 * original stragglers were found in.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VENDOR = fileURLToPath(new URL("../fakes/vendor.ts", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-orphan-")));
const groups: number[] = [];
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
      // Already gone — which is what the vendor half asserts.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** Bounded, always. A cleanup downstream of an unbounded wait is not a cleanup. */
async function until(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
  return predicate();
}

describe("a fixture does not outlive the process it was spawned to serve", () => {
  test("the vendor exits when orphaned; a plain sleep beside it does not", async () => {
    if (process.platform === "win32") return; // no reparenting, so nothing to notice

    const config = join(scratch, "copilot.vendor.json");
    writeFileSync(config, JSON.stringify({ id: "copilot", version: "1.0.80" }, null, 2));

    const fifo = join(scratch, "in.fifo");
    const vendorPidFile = join(scratch, "vendor.pid");
    const controlPidFile = join(scratch, "control.pid");
    const errLog = join(scratch, "vendor.err");
    const script = join(scratch, "parent.sh");

    // Each background job is a SINGLE command, so `$!` is unambiguous — a
    // pipeline's `$!` is implementation-defined and this test turns on knowing
    // exactly which pid it is watching.
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        `mkfifo ${JSON.stringify(fifo)}`,
        `sleep 300 > ${JSON.stringify(fifo)} &`,
        `${JSON.stringify(process.execPath)} ${JSON.stringify(VENDOR)} ${JSON.stringify(config)} --acp < ${JSON.stringify(fifo)} 2> ${JSON.stringify(errLog)} &`,
        `echo $! > ${JSON.stringify(vendorPidFile)}`,
        "sleep 300 &",
        `echo $! > ${JSON.stringify(controlPidFile)}`,
        "sleep 300",
      ].join("\n"),
      { mode: 0o755 },
    );

    const parent = Bun.spawn(["/bin/sh", script], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    groups.push(parent.pid);

    expect(await until(() => existsSync(vendorPidFile) && existsSync(controlPidFile), 20_000)).toBe(true);
    const vendorPid = Number(readFileSync(vendorPidFile, "utf8").trim());
    const controlPid = Number(readFileSync(controlPidFile, "utf8").trim());
    expect(vendorPid).toBeGreaterThan(0);
    expect(controlPid).toBeGreaterThan(0);
    stragglers.push(vendorPid, controlPid);

    // Both are up and being served by the shell that is about to die.
    expect(await until(() => isAlive(vendorPid), 20_000)).toBe(true);
    expect(isAlive(controlPid)).toBe(true);

    // ONE pid. Not the group — the point is what the survivors do on their own.
    parent.kill("SIGKILL");
    expect(await until(() => parent.exitCode !== null || parent.signalCode !== null, 10_000)).toBe(true);

    // The vendor notices and goes. Its stdin is still held open by the orphaned
    // FIFO writer, so end-of-input is not what stopped it.
    expect(await until(() => !isAlive(vendorPid), 20_000)).toBe(true);

    // THE CONTROL. Same shell, same breath, same orphaning, no guard — still
    // running. Without this line, a kill that had reached the whole tree would
    // read identically to the guard working.
    expect(isAlive(controlPid)).toBe(true);

    // And it said why, on a stream the harness captures, rather than vanishing.
    expect(existsSync(errLog)).toBe(true);
    expect(readFileSync(errLog, "utf8")).toContain("vendor: parent");
  }, 90_000);
});
