// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 63's seam, in both of the directions it points.
 *
 *   the sweep reclaims PROCESSES always, and DIRECTORIES only for runs the
 *   manifest marks complete.
 *
 * The failure in one direction is v1's leaked worker: a process nothing
 * reclaims, consuming the machine and still able to act. The failure in the
 * other is v1's finding 92: an external `SIGTERM` killed a supervisor, both
 * workers had done real work, and deleting their directories made it
 * unrecoverable. A test that only checked one direction would be satisfied by a
 * product that fails the other, so both are here — including one case where the
 * process is reclaimed and the directory beside it is deliberately kept.
 *
 * And completion is decided by the WORLD. Ruling 63: on resume an item is
 * complete iff its REF exists, not if the record says so. Both directions of
 * that are tested too — a record that claims success with no refs, and refs with
 * no record claiming anything.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLONE_SIGNATURE } from "../src/isolation/internal-git.ts";
import { manifestPath, recordClone } from "../src/isolation/manifest.ts";
import { RUN_DIR } from "../src/repo/layout.ts";
import { itemRef } from "../src/repo/refs.ts";
import { runMarkerArg } from "../src/run/marker.ts";
import { isAlive, scanProcessTable, type ProcessTable } from "../src/run/processes.ts";
import { describeUnfinished } from "../src/run/interrupt.ts";
import { appendEvent, dischargedItems, readRunRecord, recordPath } from "../src/run/record.ts";
import {
  describeStartSweep,
  dischargeRun,
  judgeRun,
  runsUnder,
  sweepAtStart,
  unfinishedFrom,
} from "../src/run/start.ts";

let scratch: string;
let runRoot: string;
let repo: string;
/** The handles, not just the pids: a dropped `Subprocess` is a process nothing owns. */
const spawnedWorkers: Bun.Subprocess[] = [];
let markedScript: string;
/**
 * A pid that is definitely gone.
 *
 * The fixtures used `pid: 1` for the orchestrator, and `isAlive(1)` is true on
 * every POSIX machine — which made every planted run look in flight once the
 * liveness gate existed. A pid from a process that has actually exited is what a
 * crashed run's record really contains.
 */
let deadPid: number;

const EMPTY_TABLE: ProcessTable = { rows: [], source: "injected", scannedAt: 0, limits: [] };

/**
 * A long-lived process carrying the marker in its COMMAND LINE, deliberately
 * cheap.
 *
 * MEASURED on this host on 2026-08-17: a `bun` runtime per fake worker is
 * 130 MB resident, and with three other builds on the same machine free memory
 * reached 65 MB and unrelated fake workers were killed by the OS — a failure
 * this suite could not tell apart from a sweep killing a bystander. A `/bin/sh`
 * loop is about 1 MB, and MEASURED against `ps` on macOS 26.5.2 it shows the
 * marker in `args=` because a shell cannot `exec`-optimise a loop away.
 * Windows keeps the `bun` form; there is no `/bin/sh` there.
 */
function markedArgv(heartbeat: string, marker: string): string[] {
  if (process.platform === "win32") return ["bun", markedScript, heartbeat, marker];
  return ["/bin/sh", "-c", `while :; do printf . >> "${heartbeat}"; sleep 0.2; done`, "sh", marker];
}

/**
 * A run id no other process can produce.
 *
 * MEASURED on this host on 2026-08-17: this working tree is shared by several
 * builds, so two `bun test` processes run this file at the same time. With fixed
 * run ids they each recorded the same id under their own run root, and each
 * one's start sweep then reclaimed the OTHER's marked process — indistinguishable
 * from the product killing a bystander. The pid makes the id unique per process,
 * which is the same lesson the product learned in `foreignMarked`: a marker
 * names a run, and a run has to be somebody's.
 */
function unique(base: string): string {
  return `${base}${process.pid.toString(36)}`;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}: ${stderr}`);
  return stdout.trim();
}

interface PlantOptions {
  /** Items whose ref exists in the operator's repository — the world's answer. */
  landedForReal?: readonly number[];
  /** Items the RECORD claims landed, whether or not they did. */
  claimed?: readonly number[];
  finished?: "complete" | "abandoned";
  /** Omit the record entirely: the "we could not look" case. */
  withoutRecord?: boolean;
  /** The pid `run-started` names as the orchestrator. Liveness is read from it. */
  orchestratorPid?: number;
}

async function plantRun(runId: string, items: readonly number[], options: PlantOptions = {}): Promise<void> {
  const runDir = join(runRoot, RUN_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  for (const item of items) {
    const dir = join(runDir, String(item));
    recordClone(
      manifestPath(runRoot, RUN_DIR, runId),
      { runId, runRoot, createdAt: Date.now(), clones: [] },
      { item, dir, createdAt: Date.now() },
    );
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", CLONE_SIGNATURE), `${runId}/${item}\n`);
    writeFileSync(join(dir, "work.txt"), "the worker's only copy\n".repeat(200));
    mkdirSync(join(runDir, "state", String(item)), { recursive: true });
    writeFileSync(join(runDir, "state", String(item), "token"), "nonce\n");
  }
  if (options.withoutRecord !== true) {
    const path = recordPath(runRoot, runId);
    appendEvent(path, { type: "run-started", at: 1, runId, repo, runRoot, pid: options.orchestratorPid ?? deadPid });
    for (const item of items) appendEvent(path, { type: "clone-recorded", at: 2, item, dir: join(runDir, String(item)) });
    for (const item of options.claimed ?? []) {
      appendEvent(path, { type: "item-landed", at: 3, item, ref: itemRef(runId, item), sha: "0".repeat(40) });
    }
    if (options.finished !== undefined) appendEvent(path, { type: "run-finished", at: 4, outcome: options.finished });
  }
  const head = await git(repo, "rev-parse", "HEAD");
  for (const item of options.landedForReal ?? []) {
    await git(repo, "update-ref", itemRef(runId, item), head);
  }
}

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-start-")));
  runRoot = join(scratch, "root");
  mkdirSync(runRoot, { recursive: true });
  repo = join(scratch, "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "operator@example.com");
  await git(repo, "config", "user.name", "Operator");
  writeFileSync(join(repo, "a.txt"), "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "one");
  const corpse = Bun.spawn(["/bin/sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
  deadPid = corpse.pid;
  await corpse.exited;
  while (isAlive(deadPid)) await Bun.sleep(20);

  markedScript = join(scratch, "marked.ts");
  writeFileSync(
    markedScript,
    [
      "// SPDX-License-Identifier: Apache-2.0",
      'import { appendFileSync } from "node:fs";',
      "const heartbeat = process.argv[2];",
      "setInterval(() => { try { appendFileSync(heartbeat, '.'); } catch {} }, 100);",
    ].join("\n"),
  );
});

afterAll(() => {
  // Marker-verified, never by bare pid: MEASURED on this host on 2026-08-17,
  // repeated runs of this suite wrapped the pid space (99,826 one run, 806 the
  // next), and after a wrap a bare-pid kill hits whatever now holds the number.
  for (const worker of spawnedWorkers) {
    const pid = worker.pid as number;
    const row = scanProcessTable().rows.find((candidate) => candidate.pid === pid);
    if (row === undefined || !row.commandLine.includes(scratch)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already reclaimed, which is what the sweep is for.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("directories: only for runs that are complete", () => {
  test("an INCOMPLETE run's directories are retained, reported with path and bytes", async () => {
    // Item 2 never landed. Finding 92: this directory holds the only copy of
    // that work, and deleting it is the failure.
    const runId = unique("incomplete1");
    await plantRun(runId, [1, 2], { landedForReal: [1] });
    const report = await sweepAtStart({ runRoot, table: EMPTY_TABLE });

    const verdict = report.verdicts.find((v) => v.runId === runId);
    expect(verdict?.completion).toBe("incomplete");
    expect(report.reclaimedDirs.filter((dir) => dir.runId === runId)).toEqual([]);

    // Asserted on the bytes on disk, not on the verdict string.
    for (const item of [1, 2]) {
      const dir = join(runRoot, RUN_DIR, runId, String(item));
      expect(existsSync(join(dir, "work.txt"))).toBe(true);
      expect(statSync(join(dir, "work.txt")).size).toBeGreaterThan(1000);
    }
    const retained = report.retained.filter((item) => item.runId === runId);
    expect(retained.length).toBe(2);
    expect(retained.every((item) => item.bytes > 0)).toBe(true);

    const printed = describeStartSweep(report).join("\n");
    expect(printed).toContain(join(runRoot, RUN_DIR, runId, "2"));
    expect(printed).toContain("MB");
    expect(printed).toContain("not merged, not reviewed, not deleted");
    expect(printed).toContain("discharge them explicitly");
  }, 30_000);

  test("a COMPLETE run's directories, state and refs are reclaimed", async () => {
    const runId = unique("complete1");
    await plantRun(runId, [1, 2], { landedForReal: [1, 2], claimed: [1, 2], finished: "complete" });
    const before = runsUnder(runRoot).find((run) => run.runId === runId);
    expect(before?.manifest?.clones.length).toBe(2);

    const report = await sweepAtStart({ runRoot, table: EMPTY_TABLE });
    expect(report.verdicts.find((v) => v.runId === runId)?.completion).toBe("complete");
    expect(report.reclaimedDirs.filter((dir) => dir.runId === runId).length).toBe(2);
    for (const item of [1, 2]) {
      expect(existsSync(join(runRoot, RUN_DIR, runId, String(item)))).toBe(false);
      // The per-item state directory goes with it, or it grows invisibly.
      expect(existsSync(join(runRoot, RUN_DIR, runId, "state", String(item)))).toBe(false);
    }
    // The refs are stale once the work has landed and the directories are gone.
    expect(report.reclaimedRefs).toContain(itemRef(runId, 1));
    expect(report.refusedRefs).toEqual([]);
    expect(await git(repo, "for-each-ref", "--format=%(refname)", `refs/brigadier/${runId}/`)).toBe("");

    // The record and manifest are KEPT: a few kilobytes, and the only surviving
    // evidence of what this run did.
    expect(existsSync(recordPath(runRoot, runId))).toBe(true);
    // What the sweep writes is `swept`, never the operator's `discharged`: it
    // cannot grant itself the permission it then reads back.
    const events = readRunRecord(recordPath(runRoot, runId)).events;
    expect(events.some((event) => event.type === "swept")).toBe(true);
    expect(dischargedItems(events).run).toBe(false);
  }, 30_000);

  test("the run about to start is never swept, in any respect", async () => {
    const runId = unique("current1");
    await plantRun(runId, [1], { landedForReal: [1], finished: "complete" });
    const report = await sweepAtStart({ runRoot, currentRunId: runId, table: EMPTY_TABLE });
    expect(report.runsSeen).not.toContain(runId);
    expect(report.verdicts.some((v) => v.runId === runId)).toBe(false);
    expect(existsSync(join(runRoot, RUN_DIR, runId, "1", "work.txt"))).toBe(true);
    expect(await git(repo, "rev-parse", itemRef(runId, 1))).toHaveLength(40);
  }, 30_000);
});

describe("the world records fact, and where it can be consulted the world wins", () => {
  test("a record claiming success with NO ref is incomplete, and the reason says so", async () => {
    const runId = unique("liar1");
    // The record says everything landed and the run finished. The repository
    // disagrees about item 2. Ruling 58's dead-pid rule, generalised.
    await plantRun(runId, [1, 2], { landedForReal: [1], claimed: [1, 2], finished: "complete" });
    const report = await sweepAtStart({ runRoot, table: EMPTY_TABLE });
    const verdict = report.verdicts.find((v) => v.runId === runId);
    expect(verdict?.completion).toBe("incomplete");
    expect(verdict?.claimedButAbsent).toEqual([2]);
    expect(verdict?.reason).toContain("the world wins");
    expect(existsSync(join(runRoot, RUN_DIR, runId, "2", "work.txt"))).toBe(true);
  }, 30_000);

  test("refs with no claim in the record are complete", async () => {
    // The other direction: the record never got to say anything, because the
    // process died. The refs are there, so the work landed.
    const runId = unique("silent1");
    await plantRun(runId, [1], { landedForReal: [1] });
    const report = await sweepAtStart({ runRoot, table: EMPTY_TABLE });
    expect(report.verdicts.find((v) => v.runId === runId)?.completion).toBe("complete");
    expect(existsSync(join(runRoot, RUN_DIR, runId, "1"))).toBe(false);
  }, 30_000);

  test("when the world cannot be consulted at all, the verdict is unknown and nothing is deleted", async () => {
    const runId = unique("norecord1");
    await plantRun(runId, [1], { withoutRecord: true });
    const report = await sweepAtStart({ runRoot, table: EMPTY_TABLE });
    const verdict = report.verdicts.find((v) => v.runId === runId);
    expect(verdict?.completion).toBe("unknown");
    expect(verdict?.reason).toContain("could not be consulted");
    expect(existsSync(join(runRoot, RUN_DIR, runId, "1", "work.txt"))).toBe(true);
  }, 30_000);

  test("a run with no readable manifest is unknown, not deletable", () => {
    const runId = unique("nomanifest1");
    mkdirSync(join(runRoot, RUN_DIR, runId, "1"), { recursive: true });
    const run = runsUnder(runRoot).find((candidate) => candidate.runId === runId)!;
    expect(judgeRun(run, []).completion).toBe("unknown");
  });
});

describe("ruling 63's explicit discharge is the only thing that releases a retained directory", () => {
  test("discharging a retained run makes the next start reclaim it", async () => {
    const runId = unique("discharge1");
    await plantRun(runId, [1, 2], { landedForReal: [1] });
    const first = await sweepAtStart({ runRoot, table: EMPTY_TABLE });
    expect(first.retained.some((item) => item.runId === runId)).toBe(true);
    expect(existsSync(join(runRoot, RUN_DIR, runId, "2", "work.txt"))).toBe(true);

    // The operator says so. Explicitly, and by name.
    dischargeRun(runRoot, runId, "operator@example.com");

    const second = await sweepAtStart({ runRoot, table: EMPTY_TABLE });
    expect(second.verdicts.find((v) => v.runId === runId)?.completion).toBe("complete");
    expect(second.retained.some((item) => item.runId === runId)).toBe(false);
    expect(existsSync(join(runRoot, RUN_DIR, runId, "2"))).toBe(false);
  }, 30_000);

  test("a discharge deletes nothing by itself — it is permission, not an instruction", () => {
    const runId = unique("discharge2");
    const dir = join(runRoot, RUN_DIR, runId, "1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "work.txt"), "still here\n");
    dischargeRun(runRoot, runId, "operator@example.com");
    expect(existsSync(join(dir, "work.txt"))).toBe(true);
  });

  test("NEGATIVE: a discharged directory that fails ruling 15 is STILL refused", async () => {
    // Discharge is permission to consider deleting it. The three proofs are
    // independent of it, and a missing marker refuses either way.
    const runId = unique("discharge3");
    const dir = join(runRoot, RUN_DIR, runId, "1");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "work.txt"), "no marker on this one\n");
    recordClone(
      manifestPath(runRoot, RUN_DIR, runId),
      { runId, runRoot, createdAt: Date.now(), clones: [] },
      { item: 1, dir, createdAt: Date.now() },
    );
    appendEvent(recordPath(runRoot, runId), { type: "run-started", at: 1, runId, repo, runRoot, pid: deadPid });
    dischargeRun(runRoot, runId, "operator@example.com");

    const report = await sweepAtStart({ runRoot, table: EMPTY_TABLE });
    expect(report.refusedDirs.some((refused) => refused.path === dir)).toBe(true);
    expect(report.refusedDirs.find((refused) => refused.path === dir)?.refusals.join(" ")).toContain("ruling 15 (c)");
    expect(existsSync(join(dir, "work.txt"))).toBe(true);
    expect(describeStartSweep(report)).toContain(`refused to delete ${dir}:`);
  }, 30_000);
});

describe("processes always, directories only when complete — in one run", () => {
  test("the worker of an incomplete run is killed and its directory is kept", async () => {
    const runId = unique("bothways1");
    await plantRun(runId, [1], {});
    const heartbeat = join(scratch, "bothways.log");
    const worker = Bun.spawn(markedArgv(heartbeat, runMarkerArg(runId, 1)), {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    spawnedWorkers.push(worker);

    // Wait for it to be BOTH visible to the sweep and actually acting: a
    // heartbeat of zero bytes would make the "it stopped" assertion below pass
    // against a process that never started.
    const deadline = Date.now() + 20_000;
    while (
      Date.now() < deadline &&
      (!scanProcessTable().rows.some((row) => row.pid === worker.pid) || !existsSync(heartbeat))
    ) {
      await Bun.sleep(100);
    }
    expect(isAlive(worker.pid)).toBe(true);
    expect(statSync(heartbeat).size).toBeGreaterThan(0);

    const report = await sweepAtStart({ runRoot });

    // Processes: ALWAYS. Asserted on the process table and the heartbeat.
    expect(isAlive(worker.pid)).toBe(false);
    expect(scanProcessTable().rows.some((row) => row.pid === worker.pid)).toBe(false);
    const beats = statSync(heartbeat).size;
    await Bun.sleep(500);
    expect(statSync(heartbeat).size).toBe(beats);

    // Directories: only when complete. This one is not, so it is kept — the
    // same sweep, the opposite decision.
    expect(existsSync(join(runRoot, RUN_DIR, runId, "1", "work.txt"))).toBe(true);
    expect(report.retained.some((item) => item.runId === runId)).toBe(true);
  }, 60_000);
});

describe("liveness before authority: a run somebody is still running is untouchable", () => {
  test("a CONCURRENT run under the SAME root keeps its worker, its clone and its ref", async () => {
    // MEASURED on 2026-08-18, and no attacker is required: `~/.brigadier` is the
    // DEFAULT root and it is shared, so a concurrent run A is under this root
    // and therefore in scope. Before this gate, `sweepAtStart({runRoot,
    // currentRunId: B})` killed A's worker, deleted A's clone and CAS-deleted
    // A's landed ref. `currentRunId` excuses only the sweeper's own run, and
    // `foreignMarked` never fired because A was not foreign.
    const runA = unique("concurrentA");
    const runB = unique("concurrentB");

    // A's orchestrator: a real, live process. Its pid is what the record names.
    const orchestratorBeat = join(scratch, "orchestrator.log");
    const orchestrator = Bun.spawn(markedArgv(orchestratorBeat, `--not-a-marker-${runA}`), {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    spawnedWorkers.push(orchestrator);
    // A's worker: marked, and doing real work.
    const workerBeat = join(scratch, "concurrent-worker.log");
    const worker = Bun.spawn(markedArgv(workerBeat, runMarkerArg(runA, 1)), {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    spawnedWorkers.push(worker);

    // A looks COMPLETE on disk — every item landed — which is precisely what
    // made the old code delete it.
    await plantRun(runA, [1], { landedForReal: [1], claimed: [1], orchestratorPid: orchestrator.pid });

    const deadline = Date.now() + 25_000;
    while (
      Date.now() < deadline &&
      (!scanProcessTable().rows.some((row) => row.pid === worker.pid) || !existsSync(workerBeat))
    ) {
      await Bun.sleep(100);
    }
    expect(isAlive(worker.pid)).toBe(true);
    expect(isAlive(orchestrator.pid)).toBe(true);

    const report = await sweepAtStart({ runRoot, currentRunId: runB });

    // The worker is alive and still writing. Asserted on the bytes.
    expect(isAlive(worker.pid)).toBe(true);
    const before = statSync(workerBeat).size;
    const grown = Date.now() + 15_000;
    while (Date.now() < grown && statSync(workerBeat).size <= before) await Bun.sleep(100);
    expect(statSync(workerBeat).size).toBeGreaterThan(before);

    // The clone is on disk and the landed ref is intact.
    expect(existsSync(join(runRoot, RUN_DIR, runA, "1", "work.txt"))).toBe(true);
    expect(await git(repo, "rev-parse", itemRef(runA, 1))).toHaveLength(40);

    // And it is reported as in flight rather than silently skipped.
    const live = report.inFlight.find((entry) => entry.runId === runA);
    expect(live?.reason).toContain(`orchestrator (pid ${orchestrator.pid}) is alive`);
    expect(report.reclaimedDirs.some((dir) => dir.runId === runA)).toBe(false);
    expect(report.reclaimedRefs).not.toContain(itemRef(runA, 1));
    expect(describeStartSweep(report).join("\n")).toContain(`run ${runA} left untouched`);

    orchestrator.kill("SIGKILL");
    worker.kill("SIGKILL");
  }, 90_000);

  test("a run whose orchestrator is GONE is still swept — the gate is the orchestrator, not the workers", async () => {
    // The other direction, and the reason the discriminator is the orchestrator
    // rather than "any marked process is alive": that weaker rule would make
    // every leaked worker evidence that its own run is still running, which is
    // the exact case ruling 38 exists to reclaim.
    const runId = unique("crashedA");
    const dead = Bun.spawn(markedArgv(join(scratch, "dead-orch.log"), `--not-a-marker-${runId}`), {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    const deadPid = dead.pid;
    dead.kill("SIGKILL");
    await dead.exited;
    while (isAlive(deadPid)) await Bun.sleep(50);

    const beat = join(scratch, "leaked-worker.log");
    const leaked = Bun.spawn(markedArgv(beat, runMarkerArg(runId, 1)), {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    spawnedWorkers.push(leaked);
    await plantRun(runId, [1], { orchestratorPid: deadPid });
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && (!existsSync(beat) || !isAlive(leaked.pid))) await Bun.sleep(100);
    expect(isAlive(leaked.pid)).toBe(true);

    const report = await sweepAtStart({ runRoot });

    expect(report.inFlight.some((entry) => entry.runId === runId)).toBe(false);
    expect(isAlive(leaked.pid)).toBe(false);
    const frozen = statSync(beat).size;
    await Bun.sleep(500);
    expect(statSync(beat).size).toBe(frozen);
    // Its directory is retained, because the run is incomplete. Both halves of
    // ruling 63 in one sweep.
    expect(existsSync(join(runRoot, RUN_DIR, runId, "1", "work.txt"))).toBe(true);
  }, 90_000);
});

describe("the sweep cannot grant itself permission", () => {
  test("a REFUSED delete does not write a discharge the next start reads as one", async () => {
    // The earlier version appended `discharged` — the operator's word —
    // unconditionally, and a later start then reported "explicitly discharged:
    // the operator released this run's directories" with zero refs present. A
    // self-written line permanently short-circuited the one rule that says a
    // state file records intent and the world records fact.
    const runId = unique("selfgrant");
    const dir = join(runRoot, RUN_DIR, runId, "1");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "work.txt"), "no marker, so the delete is refused\n");
    recordClone(
      manifestPath(runRoot, RUN_DIR, runId),
      { runId, runRoot, createdAt: Date.now(), clones: [] },
      { item: 1, dir, createdAt: Date.now() },
    );
    appendEvent(recordPath(runRoot, runId), { type: "run-started", at: 1, runId, repo, runRoot, pid: deadPid });
    const head = await git(repo, "rev-parse", "HEAD");
    await git(repo, "update-ref", itemRef(runId, 1), head);

    const first = await sweepAtStart({ runRoot, table: EMPTY_TABLE });
    expect(first.verdicts.find((v) => v.runId === runId)?.completion).toBe("complete");
    expect(first.refusedDirs.some((refused) => refused.path === dir)).toBe(true);

    // No operator discharge was written. The sweep records `swept` instead.
    const events = readRunRecord(recordPath(runRoot, runId)).events;
    expect(dischargedItems(events).run).toBe(false);
    expect(events.some((event) => event.type === "swept")).toBe(true);

    const second = await sweepAtStart({ runRoot, table: EMPTY_TABLE });
    const reason = second.verdicts.find((v) => v.runId === runId)?.reason ?? "";
    expect(reason).not.toContain("explicitly discharged");
    expect(existsSync(join(dir, "work.txt"))).toBe(true);
  }, 30_000);
});

describe("a marker is identity, not authority", () => {
  test("a marked process belonging to another run root is REPORTED, never killed", async () => {
    // MEASURED against `bun 1.3.14` on macOS 26.5.2 on 2026-08-17: while this
    // suite was running, a second process in the same working tree ran the same
    // suite, its start sweep read the machine-wide process table, and it killed
    // the first one's live workers — 4 failures in 24 runs, each one an
    // unrelated marked process dying. A start sweep whose scope is "every run id
    // in the process table" is machine-wide, and two brigadiers on one machine
    // then reclaim each other's workers.
    const heartbeat = join(scratch, "foreign.log");
    const foreignRun = unique("someoneelsesrun");
    const worker = Bun.spawn(markedArgv(heartbeat, runMarkerArg(foreignRun, 1)), {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    spawnedWorkers.push(worker);
    const deadline = Date.now() + 20_000;
    while (
      Date.now() < deadline &&
      (!scanProcessTable().rows.some((row) => row.pid === worker.pid) || !existsSync(heartbeat))
    ) {
      await Bun.sleep(100);
    }
    expect(isAlive(worker.pid)).toBe(true);

    // This root has never heard of `someoneelsesrun`: no manifest, no record.
    const report = await sweepAtStart({ runRoot });

    // Alive, and still acting. Asserted on the bytes.
    expect(isAlive(worker.pid)).toBe(true);
    const before = statSync(heartbeat).size;
    const grown = Date.now() + 15_000;
    while (Date.now() < grown && statSync(heartbeat).size <= before) await Bun.sleep(100);
    expect(statSync(heartbeat).size).toBeGreaterThan(before);

    // And it is reported, with the exact pid, because the operator's remedy is
    // to go to the other run root.
    const foreign = report.foreignMarked.find((entry) => entry.pid === worker.pid);
    expect(foreign?.runId).toBe(foreignRun);
    const printed = describeStartSweep(report).join("\n");
    expect(printed).toContain(`pid ${worker.pid}: run ${foreignRun}`);
    expect(printed).toContain("another run root's to reclaim");

    worker.kill("SIGKILL");
  }, 60_000);
});

describe("what a start always says", () => {
  test("retention is reported even when there is none", async () => {
    const emptyRoot = join(scratch, "empty-root");
    mkdirSync(emptyRoot, { recursive: true });
    const report = await sweepAtStart({ runRoot: emptyRoot, table: EMPTY_TABLE });
    expect(report.retained).toEqual([]);
    // A line that only appears when something is wrong is a line nobody learns
    // to read.
    expect(describeStartSweep(report)).toContain("0 clone(s) retained from earlier runs");
  });

  test("the interrupt path and the start path tell the same story", async () => {
    // Both halves have to be non-empty or this compares two empty arrays with
    // each other and passes on any implementation. The pid comes from a real
    // unconfirmed termination: a matched process the sweep is not permitted to
    // signal, which is what an unkillable worker looks like.
    const runId = unique("bridge1");
    await plantRun(runId, [1, 2], { landedForReal: [1] });
    const stubborn = 424_242;
    const table: ProcessTable = {
      rows: [{ pid: stubborn, ppid: 1, commandLine: `agent ${runMarkerArg(runId, 2)}` }],
      source: "injected",
      scannedAt: Date.now(),
      limits: [],
    };
    const report = await sweepAtStart({
      runRoot,
      table,
      signal: () => "denied",
      isAlive: (pid) => pid === stubborn,
      termGraceMs: 10,
      killGraceMs: 10,
    });
    expect(report.unconfirmedPids).toContain(stubborn);

    const unfinished = unfinishedFrom(report, runId, [1], [2]);
    expect(unfinished.retainedClones.map((clone) => clone.item).sort()).toEqual([1, 2]);
    expect(unfinished.retainedClones.every((clone) => clone.bytes > 0)).toBe(true);
    expect(unfinished.unconfirmedPids).toContain(stubborn);
    // And the interrupt path renders it with the pid, as ruling 63 requires.
    expect(describeUnfinished(unfinished).join("\n")).toContain(`pid ${stubborn}`);
  }, 30_000);
});
