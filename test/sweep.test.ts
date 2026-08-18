// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 38's sweep, against real processes.
 *
 * Every assertion here is on the escaped bytes: a process that was reclaimed is
 * ABSENT FROM THE PROCESS TABLE and its heartbeat file has stopped growing.
 * Never a boolean the sweep returned. v1's finding 41 is that a flag assertion
 * survives a refactor that removes the property, and "the sweep returned
 * `reclaimed: 2`" is exactly such a flag.
 *
 * The heartbeat is read twice, several tick intervals apart, because a single
 * reading cannot tell a dead process from one that is between ticks. A process
 * writing every 100 ms cannot sit through 500 ms silently.
 *
 * The bystander is the point of the whole file. A sweep that kills everything
 * passes every "did it reclaim the worker" test and is a catastrophe, so a
 * second marked process belonging to a DIFFERENT run runs throughout and is
 * asserted alive and still ticking at the end.
 *
 * A NOTE ON A FLAKE THAT WAS NOT THE PRODUCT'S, because the diagnosis is the
 * useful part. The bystander assertion failed in roughly 1 run in 4 while three
 * other builds shared this working tree. `SweepOutcome.matched` proved the sweep
 * had never signalled it — only two pids were ever matched — and the
 * `Subprocess` handle recorded `signalCode: "SIGKILL"` where the sweep only ever
 * sends `SIGTERM` first. The killer was a CONCURRENTLY RUNNING OLDER COPY of
 * this same file, whose cleanup killed bare recorded pids after the pid space
 * had wrapped (MEASURED on this host on 2026-08-17: 99,826 one run, 806 the
 * next). With no other suite running, 8 runs in 8 were green. The lesson is the
 * product's own: identify a process by its COMMAND LINE, never by a number —
 * which is what `killIfStillOurs` below now does.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertReclaimed } from "../src/isolation/index.ts";
import { runMarkerArg } from "../src/run/marker.ts";
import { isAlive, scanProcessTable, type ProcessTable } from "../src/run/processes.ts";
import { describeSweep, sweep } from "../src/run/sweep.ts";

let scratch: string;
let script: string;
/** The handles, not just the pids: a dropped `Subprocess` is a process nothing owns. */
const spawned: Array<Bun.Subprocess> = [];

/**
 * A long-lived process whose COMMAND LINE carries the marker, ticking a
 * heartbeat — and deliberately a CHEAP one.
 *
 * MEASURED on this host on 2026-08-17: with a `bun` runtime per fake worker
 * (130 MB resident) and three other builds running on the same machine, free
 * memory reached 65 MB and unrelated fake workers were killed by the OS, which
 * this suite could not distinguish from a sweep killing a bystander. A `/bin/sh`
 * loop is about 1 MB and carries the marker just as well: MEASURED against `ps`
 * on macOS 26.5.2, `sh -c '<loop>' sh --brigadier-run=x/1` shows the marker in
 * `args=`, because a shell cannot `exec`-optimise a loop away the way it does a
 * single command.
 *
 * Windows keeps the `bun` form: there is no `/bin/sh` there, and the marker's
 * visibility to `Get-CimInstance Win32_Process` is UNMEASURED either way.
 */
function spawnMarked(runId: string, item: number): { pid: number; heartbeat: string } {
  const heartbeat = join(scratch, `hb-${runId}-${item}.log`);
  const marker = runMarkerArg(runId, item);
  const argv =
    process.platform === "win32"
      ? ["bun", script, heartbeat, marker]
      : ["/bin/sh", "-c", `while :; do printf . >> "${heartbeat}"; sleep 0.2; done`, "sh", marker];
  const child = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  spawned.push(child);
  return { pid: child.pid, heartbeat };
}

function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Wait for a heartbeat to GROW, rather than sleeping a fixed interval and
 * asserting it did.
 *
 * The fixed-sleep form was load-sensitive and failed as one: this suite runs
 * several `bun` runtimes at once, and a starved process can miss five 100 ms
 * ticks without being any less alive. Polling keeps the assertion ("it is still
 * acting") and drops the assumption ("it gets scheduled promptly").
 *
 * The opposite assertion — that a heartbeat has STOPPED — stays a fixed wait,
 * because there starvation makes the test pass rather than fail, and it is
 * corroborated by the pid being absent from the process table.
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

/** Wait until the process table shows the pid, so the sweep is not racing the spawn. */
async function waitForTable(pids: readonly number[], budgetMs = 15_000): Promise<ProcessTable> {
  const deadline = Date.now() + budgetMs;
  let table = scanProcessTable();
  while (Date.now() < deadline) {
    table = scanProcessTable();
    if (pids.every((pid) => table.rows.some((row) => row.pid === pid))) return table;
    await Bun.sleep(100);
  }
  return table;
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-sweep-")));
  script = join(scratch, "marked.ts");
  writeFileSync(
    script,
    [
      "// SPDX-License-Identifier: Apache-2.0",
      "// A marked, long-lived process. Its heartbeat is what the sweep is asserted against.",
      'import { appendFileSync } from "node:fs";',
      "const heartbeat = process.argv[2];",
      "setInterval(() => { try { appendFileSync(heartbeat, '.'); } catch {} }, 100);",
    ].join("\n"),
  );
});

/**
 * Kill a pid ONLY if it is still the process this file spawned.
 *
 * MEASURED on this host on 2026-08-17: repeated runs of this suite wrapped the
 * pid space (99,826 one run, 806 the next). After a wrap, a cleanup that kills a
 * bare recorded pid kills whatever now holds that number. So the cleanup obeys
 * ruling 38's own rule — identity comes from the COMMAND LINE, never from a
 * number and never from a name.
 */
function killIfStillOurs(pid: number): void {
  const row = scanProcessTable().rows.find((candidate) => candidate.pid === pid);
  if (row === undefined || !row.commandLine.includes(scratch)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Exited between the scan and the signal, which is the outcome we wanted.
  }
}

afterAll(() => {
  for (const child of spawned) killIfStillOurs(child.pid as number);
  rmSync(scratch, { recursive: true, force: true });
});

describe("real processes, reclaimed and confirmed", () => {
  test("the sweep reclaims this run's processes and leaves another run's alone", async () => {
    const runId = `swa${Date.now().toString(36)}${process.pid.toString(36)}`;
    const other = `swb${Date.now().toString(36)}${process.pid.toString(36)}`;
    const one = spawnMarked(runId, 1);
    const two = spawnMarked(runId, 2);
    const bystander = spawnMarked(other, 1);

    const table = await waitForTable([one.pid, two.pid, bystander.pid]);
    expect(table.rows.some((row) => row.pid === one.pid)).toBe(true);

    // They are really running: the heartbeats grew before anything was swept.
    await Bun.sleep(400);
    expect(size(one.heartbeat)).toBeGreaterThan(0);
    expect(size(bystander.heartbeat)).toBeGreaterThan(0);

    const outcome = await sweep({ scope: { runId }, sweptBy: "sweep.test.ts", table });

    // The bytes, not the flag: both pids are gone from a FRESH reading of the
    // process table, and signal 0 agrees.
    const after = scanProcessTable();
    expect(after.rows.some((row) => row.pid === one.pid)).toBe(false);
    expect(after.rows.some((row) => row.pid === two.pid)).toBe(false);
    expect(isAlive(one.pid)).toBe(false);
    expect(isAlive(two.pid)).toBe(false);

    // And they have stopped ACTING, measured across several tick intervals.
    const oneAfter = size(one.heartbeat);
    const twoAfter = size(two.heartbeat);
    await Bun.sleep(500);
    expect(size(one.heartbeat)).toBe(oneAfter);
    expect(size(two.heartbeat)).toBe(twoAfter);

    expect([...outcome.evidence.reclaimedPids].sort()).toEqual([one.pid, two.pid].sort());
    expect(outcome.evidence.survivors).toEqual([]);
    expect(outcome.unconfirmed).toEqual([]);

    // THE BYSTANDER. A sweep that killed everything would pass every assertion
    // above. This one is asserted alive AND still writing.
    expect(isAlive(bystander.pid)).toBe(true);
    expect(after.rows.some((row) => row.pid === bystander.pid)).toBe(true);
    const bystanderBefore = size(bystander.heartbeat);
    expect(await grewWithin(bystander.heartbeat, bystanderBefore, 15_000)).toBeGreaterThan(bystanderBefore);
  }, 60_000);

  test("evidence from an item-scoped sweep satisfies assertReclaimed", async () => {
    const runId = `swc${Date.now().toString(36)}${process.pid.toString(36)}`;
    const releasedAt = Date.now();
    const worker = spawnMarked(runId, 3);
    // A sibling item, to prove the scope is not "everything with this run id".
    const sibling = spawnMarked(runId, 4);
    const table = await waitForTable([worker.pid, sibling.pid]);

    const outcome = await sweep({ scope: { runId, item: 3 }, sweptBy: "sweep.test.ts", table });
    expect(isAlive(worker.pid)).toBe(false);
    expect(isAlive(sibling.pid)).toBe(true);

    // The consumer's own check, unmodified, run against evidence this sweep
    // produced rather than a stub.
    expect(() =>
      assertReclaimed({ runId, item: 3, releasedAt, dir: join(scratch, "clone") }, outcome.evidence),
    ).not.toThrow();

    // NEGATIVE: the same evidence does not license the sibling's directory.
    expect(() =>
      assertReclaimed({ runId, item: 4, releasedAt, dir: join(scratch, "clone-4") }, outcome.evidence),
    ).toThrow(/NotReclaimed|evidence names/);

    // NEGATIVE: evidence older than the release says nothing about the
    // processes the release started.
    expect(() =>
      assertReclaimed(
        { runId, item: 3, releasedAt: outcome.evidence.sweptAt + 1_000, dir: "/x" },
        outcome.evidence,
      ),
    ).toThrow(/released at/);

    // NEGATIVE: evidence that names a LIVE pid as reclaimed is refused. This is
    // the check that makes the sweep's output worth anything, and it is
    // asserted against a process that is genuinely still running.
    expect(() =>
      assertReclaimed(
        { runId, item: 4, releasedAt, dir: "/x" },
        { ...outcome.evidence, item: 4, reclaimedPids: [sibling.pid] },
      ),
    ).toThrow(/still alive/);

    killIfStillOurs(sibling.pid);
  }, 60_000);

  test("a run-wide sweep can never license a specific item's recycle", async () => {
    const runId = `swd${Date.now().toString(36)}${process.pid.toString(36)}`;
    const worker = spawnMarked(runId, 1);
    const table = await waitForTable([worker.pid]);
    const outcome = await sweep({ scope: { runId }, sweptBy: "sweep.test.ts", table });
    // Item 0 is not a usable item number anywhere in brigadier, so
    // `assertReclaimed` refuses it for every real item — deliberately.
    expect(outcome.evidence.item).toBe(0);
    expect(() =>
      assertReclaimed({ runId, item: 1, releasedAt: 0, dir: "/x" }, outcome.evidence),
    ).toThrow(/evidence names/);
  }, 60_000);

  test("a process that exited before the sweep is recorded as already gone", async () => {
    const runId = `swe${Date.now().toString(36)}${process.pid.toString(36)}`;
    const worker = spawnMarked(runId, 1);
    const table = await waitForTable([worker.pid]);
    process.kill(worker.pid, "SIGKILL");
    await Bun.sleep(300);
    expect(isAlive(worker.pid)).toBe(false);

    // The table is deliberately stale: this is the ordinary race between
    // reading `ps` and acting on it.
    const outcome = await sweep({ scope: { runId }, sweptBy: "sweep.test.ts", table });
    expect(outcome.matched.map((m) => m.disposition)).toEqual(["already-gone"]);
    expect(outcome.evidence.reclaimedPids).toEqual([worker.pid]);
    expect(outcome.evidence.survivors).toEqual([]);
  }, 60_000);
});

describe("the sweep never kills the sweep", () => {
  test("this process and its ancestors are matched, reported, and NOT signalled", async () => {
    const runId = `swf${Date.now().toString(36)}${process.pid.toString(36)}`;
    const signalled: number[] = [];
    const parent = scanProcessTable().rows.find((row) => row.pid === process.pid)?.ppid ?? 1;
    // A table in which the sweeping process and its parent both carry the marker.
    const table: ProcessTable = {
      rows: [
        { pid: process.pid, ppid: parent, commandLine: `bun test ${runMarkerArg(runId, 1)}` },
        { pid: parent, ppid: 1, commandLine: `sh -c brigadier ${runMarkerArg(runId, 1)}` },
      ],
      source: "injected",
      scannedAt: Date.now(),
      limits: [],
    };

    const outcome = await sweep({
      scope: { runId },
      sweptBy: "sweep.test.ts",
      table,
      signal: (pid) => {
        signalled.push(pid);
        return "sent";
      },
    });

    // Asserted on what was signalled, not on a disposition string: a refactor
    // that dropped the protection and kept the label would fail here.
    expect(signalled).toEqual([]);
    expect(outcome.matched.every((m) => m.disposition === "self")).toBe(true);
    expect(outcome.evidence.reclaimedPids).toEqual([]);
    expect(outcome.protectedPids).toContain(process.pid);
    expect(outcome.coverage.limits.join(" ")).toContain("deliberately not signalled");
    // And the sweeping process is, self-evidently, still here to assert it.
    expect(isAlive(process.pid)).toBe(true);
  });
});

describe("an unconfirmed termination is reported with the exact pids", () => {
  test("a process that will not die is a survivor, named", async () => {
    const runId = `swg${Date.now().toString(36)}${process.pid.toString(36)}`;
    // A process brigadier is not permitted to signal — another user's, in the
    // real case. Modelled with an injected signal, because creating one for
    // real needs a second uid.
    const table: ProcessTable = {
      rows: [{ pid: 424_242, ppid: 1, commandLine: `agent ${runMarkerArg(runId, 1)}` }],
      source: "injected",
      scannedAt: Date.now(),
      limits: [],
    };
    const outcome = await sweep({
      scope: { runId, item: 1 },
      sweptBy: "sweep.test.ts",
      table,
      signal: () => "denied",
      isAlive: () => true,
      selfPid: process.pid,
      termGraceMs: 10,
      killGraceMs: 10,
      sleep: (ms) => Bun.sleep(ms),
    });

    expect(outcome.evidence.survivors).toEqual([424_242]);
    expect(outcome.unconfirmed).toEqual([424_242]);
    expect(outcome.evidence.reclaimedPids).toEqual([]);
    const report = describeSweep(outcome).join("\n");
    expect(report).toContain("could not confirm dead: pid 424242");
    expect(report).toContain("killing them is the only remedy");

    // And the consumer refuses to recycle on it. Ruling 63's other half: the
    // sweep reports, and isolation declines.
    expect(() =>
      assertReclaimed({ runId, item: 1, releasedAt: 0, dir: "/x" }, outcome.evidence),
    ).toThrow(/could not reclaim/);
  });
});

describe("the sweep does not claim completeness it has not earned", () => {
  test("even a clean sweep prints the qualification and the limits", async () => {
    const runId = `swh${Date.now().toString(36)}${process.pid.toString(36)}`;
    const outcome = await sweep({
      scope: { runId },
      sweptBy: "sweep.test.ts",
      table: { rows: [], source: "injected", scannedAt: 1, limits: ["a stated limit"] },
    });
    expect(outcome.evidence.survivors).toEqual([]);
    // An empty survivor list is not a completeness claim, and the report says so
    // on the clean path — which is exactly when it is most tempting to drop it.
    expect(outcome.coverage.completeness).toBe("not-proven");
    const report = describeSweep(outcome).join("\n");
    expect(report).toContain("not-proven");
    expect(report).toContain("an empty survivor list is not proof");
    expect(report).toContain("a stated limit");
  });

  test("a reader that failed produces a reading that says nothing was read", () => {
    // The failure mode this exists for: a scan that errors and returns zero
    // rows looks identical to a machine with nothing to reclaim.
    const table = scanProcessTable({ run: () => ({ code: 127, stdout: "" }) });
    expect(table.rows).toEqual([]);
    expect(table.limits.join(" ")).toContain("NOTHING WAS READ");
  });

  test("the real reader on this platform produces rows including this process", () => {
    // The negative control for the control: if this ever returns nothing, every
    // "the sweep found no survivors" assertion above is vacuous.
    const table = scanProcessTable();
    expect(table.rows.length).toBeGreaterThan(5);
    expect(table.rows.some((row) => row.pid === process.pid)).toBe(true);
    expect(table.limits.length).toBeGreaterThan(0);
  });
});
