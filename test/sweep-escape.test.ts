// SPDX-License-Identifier: Apache-2.0
/**
 * The demonstrated negative that ruling 38 rests on: a descendant that ESCAPES
 * containment, and a sweep that reclaims it anyway.
 *
 * Without this file every other sweep test is a test of a well-behaved child,
 * and ruling 38 exists precisely because well-behaved children are not the
 * problem. MEASURED at #43: Bun's Windows job object carries
 * `JOB_OBJECT_LIMIT_BREAKAWAY_OK` and `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`
 * (`LIMIT_FLAGS=0x00003C00`), so `cmd /c start` escapes it; on POSIX one
 * `setsid()` escapes `kill(-pgid)`. brigadier cannot fix either, because Bun
 * creates the job.
 *
 * HOW THE ESCAPE IS PERFORMED HERE, AND WHAT IT DOES AND DOES NOT PROVE.
 * macOS ships no `setsid(1)`, so the `setsid(2)` call is made directly rather
 * than through a binary: `node:child_process`'s `detached: true`. MEASURED
 * against `bun 1.3.14` on macOS 26.5.2 (Darwin 25.5.0 arm64) on 2026-08-17,
 * with `python3 -c 'os.getsid/os.getpgid'`: a child spawned with `detached:
 * true` reported `sid == pgid == pid`, while its sibling spawned without the
 * flag shared the parent's session and process group. That is a real new
 * session, not an approximation of one.
 *
 * It PROVES: a descendant in its own session survives `kill(-pgid)` of the
 * supervisor's group, and ruling 38's command-line sweep reclaims it afterwards.
 *
 * It DOES NOT PROVE: anything about Windows job objects — #43 measured those and
 * this test's Windows branch (`taskkill /T /F`) is UNMEASURED, since no Windows
 * host was available on 2026-08-17. Nor does it prove the sweep can find a
 * process that has hidden itself: the escape here is an ORDINARY IDIOM, which is
 * ruling 38's point, not an attack on the matcher.
 *
 * THE VACUITY CONTROL is the second child. A plain, non-detached sibling is
 * spawned alongside and asserted DEAD after the same group kill. Without it,
 * "the detached child survived" could just mean the kill never happened.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMarkerArg } from "../src/run/marker.ts";
import { isAlive, scanProcessTable } from "../src/run/processes.ts";
import { sweep } from "../src/run/sweep.ts";

let scratch: string;
let marked: string;
let supervisor: string;
const survivors: number[] = [];

function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Wait for a heartbeat to GROW rather than sleeping a fixed interval.
 *
 * The fixed-sleep form was load-sensitive and failed as one: this suite runs
 * several `bun` runtimes at once and a starved process can miss five 100 ms
 * ticks without being any less alive. The opposite assertion — that a heartbeat
 * has STOPPED — stays a fixed wait, because starvation there makes the test pass
 * rather than fail, and it is corroborated by the pid being absent from the
 * process table.
 */
async function grewWithin(path: string, from: number, budgetMs: number): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let latest = size(path);
  while (Date.now() < deadline && latest <= from) {
    await Bun.sleep(100);
    latest = size(path);
  }
  return latest;
}

/**
 * The process group id, or null where the platform has no such thing.
 *
 * This is here to remove a race rather than to decorate the test. `setsid()`
 * happens in the child between `fork` and `exec`, so for a few milliseconds
 * after `spawn` returns the grandchild is still in its parent's group — and a
 * group kill delivered in that window would take it, making the escape look
 * like it did not happen. Waiting on the actual group id turns "probably
 * detached by now" into an observed fact.
 */
function processGroup(pid: number): number | null {
  if (process.platform === "win32") return null;
  const result = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
  const value = Number(new TextDecoder().decode(result.stdout).trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-escape-")));
  marked = join(scratch, "marked.ts");
  writeFileSync(
    marked,
    [
      "// SPDX-License-Identifier: Apache-2.0",
      'import { appendFileSync } from "node:fs";',
      "const heartbeat = process.argv[2];",
      "setInterval(() => { try { appendFileSync(heartbeat, '.'); } catch {} }, 100);",
    ].join("\n"),
  );
  supervisor = join(scratch, "supervisor.ts");
  writeFileSync(
    supervisor,
    [
      "// SPDX-License-Identifier: Apache-2.0",
      "// Stands in for brigadier: it spawns one descendant that escapes its process",
      "// group and one that does not, then waits to be killed.",
      'import { spawn } from "node:child_process";',
      "const [script, hbDetached, hbPlain, markerDetached, markerPlain] = process.argv.slice(2);",
      // Cheap descendants: a `/bin/sh` loop is about 1 MB against a `bun`
      // runtime's 130 MB, and MEASURED on this host on 2026-08-17 the heavy form
      // was killed by the OS under memory pressure, which looks exactly like an
      // escape that did not happen. Windows keeps the `bun` form.
      "const argv = (hb: string, marker: string): string[] =>",
      "  process.platform === 'win32'",
      "    ? [process.execPath, script!, hb, marker]",
      "    : ['/bin/sh', '-c', `while :; do printf . >> \"${hb}\"; sleep 0.2; done`, 'sh', marker];",
      "const one = argv(hbDetached!, markerDetached!);",
      "const two = argv(hbPlain!, markerPlain!);",
      "const escaped = spawn(one[0]!, one.slice(1), { detached: true, stdio: 'ignore' });",
      "escaped.unref();",
      "const contained = spawn(two[0]!, two.slice(1), { detached: false, stdio: 'ignore' });",
      "process.stdout.write(JSON.stringify({ escaped: escaped.pid, contained: contained.pid, supervisor: process.pid }) + '\\n');",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
});

/**
 * Kill a pid ONLY if it is still the process this file spawned.
 *
 * Not fastidiousness: MEASURED on this host on 2026-08-17, repeated runs of
 * this suite wrapped the pid space (99,826 one run, 806 the next), and a
 * cleanup that kills a bare recorded pid after a wrap kills whatever now holds
 * that number. Which is ruling 38's own rule turned on the test: identity comes
 * from the COMMAND LINE, never from a number and never from a name.
 */
function killIfStillOurs(pid: number): void {
  const row = scanProcessTable().rows.find((candidate) => candidate.pid === pid);
  if (row === undefined) return;
  // Every process this file spawns names a script inside its own mkdtemp
  // directory. Nothing else on the machine can.
  if (!row.commandLine.includes(scratch)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Exited between the scan and the signal, which is the outcome we wanted.
  }
}

afterAll(() => {
  for (const pid of survivors) killIfStillOurs(pid);
  rmSync(scratch, { recursive: true, force: true });
});

describe("a descendant that escapes containment is still reclaimed", () => {
  test("setsid escapes the group kill, and the sweep reaches it anyway", async () => {
    const runId = `esc${Date.now().toString(36)}${process.pid.toString(36)}`;
    const hbEscaped = join(scratch, "escaped.log");
    const hbContained = join(scratch, "contained.log");

    // The supervisor is detached so that it leads its OWN process group: that
    // is what makes the group kill below target it and its children rather than
    // this test runner.
    const child = spawn(
      process.execPath,
      [supervisor, marked, hbEscaped, hbContained, runMarkerArg(runId, 1), runMarkerArg(runId, 2)],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !stdout.includes("\n")) await Bun.sleep(100);
    const pids = JSON.parse(stdout.trim()) as { escaped: number; contained: number; supervisor: number };
    survivors.push(pids.escaped, pids.contained, pids.supervisor);

    // Both descendants are really running, and really writing.
    const growing = Date.now() + 20_000;
    while (Date.now() < growing && (size(hbEscaped) === 0 || size(hbContained) === 0)) await Bun.sleep(100);
    expect(size(hbEscaped)).toBeGreaterThan(0);
    expect(size(hbContained)).toBeGreaterThan(0);

    // The fixture is sound before anything is concluded from it. Stated as
    // three separate assertions because a run where the whole tree had already
    // exited once produced a confusing failure ten seconds later, in the group
    // check below, rather than an obvious one here.
    expect({ supervisor: isAlive(pids.supervisor), escaped: isAlive(pids.escaped), contained: isAlive(pids.contained) })
      .toEqual({ supervisor: true, escaped: true, contained: true });

    // The escape, observed BEFORE it is relied on. On POSIX the escaped child
    // must be in its own process group and the contained one must not, or the
    // kill below proves nothing about either.
    if (process.platform !== "win32") {
      const settled = Date.now() + 10_000;
      while (Date.now() < settled && processGroup(pids.escaped) === pids.supervisor) await Bun.sleep(50);
      expect(processGroup(pids.contained)).toBe(pids.supervisor);
      expect(processGroup(pids.escaped)).toBe(pids.escaped);
    }

    // The containment brigadier actually has: kill the supervisor's process
    // group. On Windows the nearest equivalent is a tree kill.
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pids.supervisor)], { stdout: "ignore", stderr: "ignore" });
    } else {
      process.kill(-pids.supervisor, "SIGKILL");
    }
    await Bun.sleep(700);

    // VACUITY CONTROL. The contained sibling died with the group. If this fails,
    // the kill did not happen and the survival below means nothing.
    expect(isAlive(pids.contained)).toBe(false);
    const containedAtKill = size(hbContained);
    await Bun.sleep(500);
    expect(size(hbContained)).toBe(containedAtKill);

    // THE ESCAPE, asserted on the bytes. It outlived the kill that took its
    // sibling, and it is still writing to disk.
    expect(isAlive(pids.escaped)).toBe(true);
    const escapedAtKill = size(hbEscaped);
    const escapedBeforeSweep = await grewWithin(hbEscaped, escapedAtKill, 15_000);
    expect(escapedBeforeSweep).toBeGreaterThan(escapedAtKill);

    // Ruling 38: the next start sweeps, and the marker in the command line is
    // the only thing that makes this process findable at all — its parent is
    // gone, it is in another session, and its name is `bun`, exactly like the
    // test runner asserting on it.
    const table = scanProcessTable();
    expect(table.rows.some((row) => row.pid === pids.escaped)).toBe(true);
    const outcome = await sweep({ scope: { runId }, sweptBy: "sweep-escape.test.ts", table });

    expect(outcome.evidence.reclaimedPids).toContain(pids.escaped);
    expect(outcome.evidence.survivors).toEqual([]);

    // Asserted on the world afterwards, twice over: absent from a fresh reading
    // of the process table, and no longer writing.
    expect(scanProcessTable().rows.some((row) => row.pid === pids.escaped)).toBe(false);
    expect(isAlive(pids.escaped)).toBe(false);
    const afterSweep = size(hbEscaped);
    await Bun.sleep(600);
    expect(size(hbEscaped)).toBe(afterSweep);
  }, 90_000);

  test("NEGATIVE: an unmarked descendant that escapes is NOT found, and the report says why", async () => {
    // The honest limit of ruling 38, demonstrated rather than asserted in a
    // comment. The sweep matches the COMMAND LINE; a process brigadier caused to
    // exist without a marker is invisible to it forever. This is why the ruling
    // says EVERY process brigadier causes to exist must carry one, and why
    // `SweepCoverage.completeness` is `not-proven`.
    //
    // The limit is narrower than it was and this test states the narrowing
    // rather than being deleted by it: the sweep is given no `workspaces` here,
    // and `test/sweep-workspace.test.ts` covers the case where it has them —
    // an unmarked, reparented descendant standing INSIDE a directory the run's
    // manifest recorded is reclaimed. One standing anywhere else, like this
    // one, still is not.
    const runId = `unm${Date.now().toString(36)}${process.pid.toString(36)}`;
    const heartbeat = join(scratch, "unmarked.log");
    const orphan = spawn(process.execPath, [marked, heartbeat], { detached: true, stdio: "ignore" });
    orphan.unref();
    survivors.push(orphan.pid!);

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && size(heartbeat) === 0) await Bun.sleep(100);
    expect(size(heartbeat)).toBeGreaterThan(0);

    const outcome = await sweep({ scope: { runId }, sweptBy: "sweep-escape.test.ts" });
    expect(outcome.matched).toEqual([]);
    expect(outcome.evidence.survivors).toEqual([]);

    // Still alive, still writing — and the sweep reported no survivors, which is
    // exactly the gap `completeness: "not-proven"` names.
    expect(isAlive(orphan.pid!)).toBe(true);
    const before = size(heartbeat);
    expect(await grewWithin(heartbeat, before, 15_000)).toBeGreaterThan(before);
    expect(outcome.coverage.completeness).toBe("not-proven");
    expect(outcome.coverage.limits.join(" ")).toContain("does not match");

    process.kill(orphan.pid!, "SIGKILL");
  }, 60_000);
});
