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
// The harness's own predicate, not a third copy of it. This test HAD a private
// `kill(pid, 0)` copy and that copy is what failed it: MEASURED 2026-08-20, the
// orphaned vendor really did exit and really did print its reason, and a
// `kill(pid, 0)` cannot tell an exited-but-unreaped process from a running one.
// The reasoning is at `isAlive` in `bar/lib/inflight.ts`.
import { isAlive } from "./inflight.ts";
import { WATCHING_PREFIX } from "./orphan.ts";
import { notRunHere } from "./platform.ts";

const VENDOR = fileURLToPath(new URL("../fakes/vendor.ts", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-orphan-")));
const groups: number[] = [];
const stragglers: number[] = [];

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

/**
 * The shell that starts a vendor, a FIFO writer holding its stdin open, and a
 * guardless `sleep` beside it as the control. Returns the pids the test watches.
 */
function bed(name: string): { script: string; vendorPidFile: string; controlPidFile: string; errLog: string } {
  const config = join(scratch, `${name}.vendor.json`);
  writeFileSync(config, JSON.stringify({ id: "copilot", version: "1.0.80" }, null, 2));

  const fifo = join(scratch, `${name}.fifo`);
  const vendorPidFile = join(scratch, `${name}.vendor.pid`);
  const controlPidFile = join(scratch, `${name}.control.pid`);
  const errLog = join(scratch, `${name}.err`);
  const script = join(scratch, `${name}.sh`);

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
  return { script, vendorPidFile, controlPidFile, errLog };
}

function said(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

describe("a fixture does not outlive the process it was spawned to serve", () => {
  test("the vendor exits when orphaned; a plain sleep beside it does not", async () => {
    if (process.platform === "win32") {
      notRunHere(
        "a vendor fixture noticing it has been orphaned and exiting, while a plain sleep beside it does not",
        "the fixture's guard watches for REPARENTING — its ppid becoming 1 — and Windows has no " +
          "reparenting: an orphan keeps the pid of the parent that died, and the pid may be reused. " +
          "The equivalent is a job object with KILL_ON_JOB_CLOSE, or waiting on a handle to the " +
          "parent process, and `bar/lib/orphan.ts` implements neither.",
      );
    }

    const { script, vendorPidFile, controlPidFile, errLog } = bed("armed");
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

    // BOUND THE WORK, NOT THE CLOCK (ruling 62 (d)). Waiting for the pid to
    // EXIST is what this test used to do, and a pid exists the instant a shell
    // backgrounds a command — long before `bun` has loaded a module and armed
    // the guard. Killing the parent inside that window is a race, and it is the
    // race this test lost on CI three times in twelve platform-runs while
    // winning it on every quiet machine. The fixture now says when it is armed
    // and this waits for that sentence, so the arm below tests the guard rather
    // than the scheduler. The window itself is not lost: it is the second test.
    expect(await until(() => said(errLog).includes(WATCHING_PREFIX), 20_000)).toBe(true);
    expect(isAlive(vendorPid)).toBe(true);
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
    expect(said(errLog)).toContain("vendor: parent");
  }, 90_000);

  test("THE RACE, driven: a vendor orphaned BEFORE its guard is armed still exits", async () => {
    if (process.platform === "win32") {
      notRunHere(
        "a vendor orphaned before its guard could be armed exiting anyway",
        "same missing reparenting as the arm above: with no reparenting there is no ppid change to " +
          "read, and `bar/lib/orphan.ts` returns early on this platform by design.",
      );
    }

    // WHAT THIS EXISTS FOR. `exitWhenOrphaned` read `process.ppid` and, finding
    // 1, concluded there was nothing to notice the loss of and armed NOTHING.
    // Not one of these fixtures is started by init, so a ppid of 1 there means
    // the process it exists to serve died between the spawn and that line — and
    // the fixture then ran forever, which is the leak this whole file is about.
    //
    // MEASURED against `bun 1.3.14` under `oven/bun:1.3.14` on 2026-08-20 with
    // `probes/orphan-race.ts`, killing the parent shell at a range of delays
    // after the fixture's pid appeared: at 0 ms the vendor SURVIVED the full
    // 20 s with an EMPTY stderr; at 30 ms and beyond it exited within a second.
    // That is the signature the CI failures had — the full bound consumed rather
    // than a spread of times under it.
    const { script, vendorPidFile, errLog } = bed("raced");
    const parent = Bun.spawn(["/bin/sh", script], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    groups.push(parent.pid);

    // Deliberately the OLD, racy wait: the pid exists and nothing else is known.
    expect(await until(() => existsSync(vendorPidFile), 20_000)).toBe(true);
    const vendorPid = Number(readFileSync(vendorPidFile, "utf8").trim());
    expect(vendorPid).toBeGreaterThan(0);
    stragglers.push(vendorPid);

    // And kill immediately, which is the window the fixture used to leak in.
    parent.kill("SIGKILL");
    expect(await until(() => parent.exitCode !== null || parent.signalCode !== null, 10_000)).toBe(true);

    expect(await until(() => !isAlive(vendorPid), 30_000)).toBe(true);
    // It must say WHICH branch stopped it, or a pass here cannot be told from
    // the vendor having died of something else entirely — and "died of something
    // else" is exactly what a leak guard must never be credited with. Both
    // spellings are accepted because BOTH are correct outcomes: whether the
    // guard was armed in time is the race, and either branch means no leak.
    const stderr = said(errLog);
    expect(stderr, "the vendor exited without saying why, so nothing here is evidence about the guard").toMatch(
      /started with no parent|parent \d+ is gone/,
    );
  }, 90_000);
});
