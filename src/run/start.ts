// SPDX-License-Identifier: Apache-2.0
/**
 * The sweep that runs on START, and the seam ruling 63 puts through it.
 *
 * WHY START. Ruling 38 promotes the sweep from crash recovery to the
 * containment mechanism, and a containment mechanism that only runs on a clean
 * exit contains nothing: the case it exists for is the case where there was no
 * clean exit. v1's finding 92 is an external `SIGTERM` to a supervisor; a
 * `SIGKILL` is worse still, because no handler runs at all. Whatever escaped is
 * still there when the operator comes back, and the next start is the first
 * moment brigadier can do anything about it.
 *
 * THE SEAM, AND IT POINTS BOTH WAYS. Ruling 63:
 *
 *     the sweep reclaims PROCESSES always, and DIRECTORIES only for runs the
 *     manifest marks complete.
 *
 * The asymmetry is the whole content of the ruling. A leaked process consumes
 * the machine and can still act — it can write into a clone, into the operator's
 * repository, into anything its sandbox allows — so it is reclaimed
 * unconditionally. A retained directory is inert and holds the only copy of
 * somebody's work, so it is retained until explicitly discharged. Deleting it
 * reproduces finding 92 exactly: an external `SIGTERM` killed a supervisor, both
 * workers had done real work, and it was unrecoverable.
 *
 * AND ON RESUME AN ITEM IS COMPLETE IFF ITS REF EXISTS, not if the record says
 * so. That is ruling 58's dead-pid rule generalised — *a state file records
 * intent, the world records fact, and where the world can be consulted the world
 * wins* — and it runs in both directions here. A record that says `run-finished:
 * complete` with no refs on disk is NOT complete. A record that says nothing at
 * all, whose every item has a ref, IS. A state file's `running` is never trusted
 * anywhere in this directory; liveness comes from the process table, and the
 * sweep's matcher IS the liveness check.
 *
 * WHEN THE WORLD CANNOT BE CONSULTED — no record, no repository path, git
 * unreadable — the verdict is `unknown` and the directory is RETAINED. Every
 * unknown in this file resolves toward keeping somebody's work.
 *
 * WHAT RETENTION COSTS IS REPORTED AT EVERY START, in bytes, because otherwise
 * it grows invisibly and the operator discovers it as a full disk. #19 measured
 * roughly 67 MB incremental per clone.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readManifest, type RunManifest } from "../isolation/index.ts";
import { manifestPath } from "../isolation/manifest.ts";
import { RUN_DIR } from "../repo/layout.ts";
import { itemRef } from "../repo/refs.ts";
import type { UnfinishedRun } from "./interrupt.ts";
import { parseRunMarker } from "./marker.ts";
import { scanProcessTable, type ProcessTable } from "./processes.ts";
import {
  directoryBytes,
  listOwnedRefs,
  proveDeletableDirectory,
  reclaimDirectory,
  reclaimRef,
  type GitRunner,
  type OwnedRef,
} from "./reclaim.ts";
import {
  appendEvent,
  dischargedItems,
  readRunRecord,
  recordPath,
  runFacts,
  spawnedProcesses,
  type RecordReading,
} from "./record.ts";
import { describeSweep, sweep, type SweepOutcome } from "./sweep.ts";

/** One run's state on disk, as three independent artifacts. */
export interface RunOnDisk {
  readonly runId: string;
  readonly dir: string;
  readonly manifest: RunManifest | null;
  readonly record: RecordReading;
}

/** Every run directory under a root. Missing or unreadable artifacts are not an error. */
export function runsUnder(runRoot: string): RunOnDisk[] {
  const runs = join(runRoot, RUN_DIR);
  if (!existsSync(runs)) return [];
  const found: RunOnDisk[] = [];
  for (const entry of readdirSync(runs)) {
    const dir = join(runs, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    found.push({
      runId: entry,
      dir,
      manifest: readManifest(manifestPath(runRoot, RUN_DIR, entry)),
      record: readRunRecord(recordPath(runRoot, entry)),
    });
  }
  return found;
}

export type Completion = "complete" | "incomplete" | "unknown";

export interface RunVerdict {
  readonly runId: string;
  readonly completion: Completion;
  readonly reason: string;
  readonly items: readonly number[];
  readonly itemsWithRefs: readonly number[];
  /** Recorded as landed but with no ref in the operator's repository. The world wins. */
  readonly claimedButAbsent: readonly number[];
}

/**
 * Decide whether a run's directories may be reclaimed, consulting the world.
 *
 * `refs` is every ref brigadier owns in the operator's repository, or null when
 * the repository could not be consulted at all. Null is the difference between
 * "the work is not there" and "we could not look", and the two must not collapse
 * — collapsing them would delete a completed run's clones on a machine where git
 * happened to be unavailable.
 */
export function judgeRun(run: RunOnDisk, refs: readonly OwnedRef[] | null): RunVerdict {
  const discharged = dischargedItems(run.record.events);
  const items = (run.manifest?.clones ?? []).map((clone) => clone.item).sort((a, b) => a - b);

  if (discharged.run) {
    return {
      runId: run.runId,
      completion: "complete",
      reason: "explicitly discharged: the operator released this run's directories",
      items,
      itemsWithRefs: [],
      claimedButAbsent: [],
    };
  }
  if (run.manifest === null) {
    return {
      runId: run.runId,
      completion: "unknown",
      reason: `no readable manifest in ${run.dir} — without ruling 15's record nothing here is deletable anyway`,
      items,
      itemsWithRefs: [],
      claimedButAbsent: [],
    };
  }
  if (refs === null) {
    return {
      runId: run.runId,
      completion: "unknown",
      reason:
        "the operator's repository could not be consulted, so no item's ref could be checked. " +
        "Ruling 63 decides completion from the ref and this is the case where the world is unavailable",
      items,
      itemsWithRefs: [],
      claimedButAbsent: [],
    };
  }

  const present = new Set(refs.map((owned) => owned.ref));
  const itemsWithRefs = items.filter((item) => present.has(itemRef(run.runId, item)));
  const outstanding = items.filter(
    (item) => !present.has(itemRef(run.runId, item)) && !discharged.items.has(item),
  );
  // The record's own claim, checked against the world rather than believed.
  const claimedButAbsent = [...claimedLandingsOf(run)].filter((item) => !present.has(itemRef(run.runId, item)));

  if (outstanding.length === 0) {
    return {
      runId: run.runId,
      completion: "complete",
      reason:
        items.length === 0
          ? "the manifest records no clones"
          : `every item has its ref in the operator's repository (${itemsWithRefs.join(", ")})`,
      items,
      itemsWithRefs,
      claimedButAbsent,
    };
  }
  return {
    runId: run.runId,
    completion: "incomplete",
    reason:
      `item ${outstanding.join(", ")} has no ref under refs/brigadier/${run.runId}/ and was not ` +
      "discharged. Ruling 63 retains its directory: it is inert, and it may hold the only copy of that work" +
      (claimedButAbsent.length > 0
        ? `. The record CLAIMS item ${claimedButAbsent.join(", ")} landed and the repository disagrees — the world wins`
        : ""),
    items,
    itemsWithRefs,
    claimedButAbsent,
  };
}

function claimedLandingsOf(run: RunOnDisk): Set<number> {
  const claimed = new Set<number>();
  for (const event of run.record.events) {
    if (event.type === "item-landed") claimed.add(event.item);
  }
  return claimed;
}

export interface RetainedDirectory {
  readonly runId: string;
  readonly item: number;
  readonly path: string;
  readonly bytes: number;
  readonly reason: string;
}

export interface StartSweepReport {
  readonly runsSeen: readonly string[];
  readonly verdicts: readonly RunVerdict[];
  readonly processes: readonly SweepOutcome[];
  readonly reclaimedDirs: ReadonlyArray<{ runId: string; item: number; path: string; bytes: number }>;
  readonly refusedDirs: ReadonlyArray<{ runId: string; item: number; path: string; refusals: readonly string[] }>;
  readonly retained: readonly RetainedDirectory[];
  readonly retainedBytes: number;
  readonly reclaimedRefs: readonly string[];
  readonly refusedRefs: ReadonlyArray<{ ref: string; refusal: string }>;
  /** Ruling 63: every pid across every scope that could not be confirmed dead. */
  readonly unconfirmedPids: readonly number[];
  /**
   * Marked processes belonging to a run THIS ROOT has no record of. Reported,
   * never signalled.
   *
   * MEASURED against `bun 1.3.14` on macOS 26.5.2 on 2026-08-17, and it is the
   * reason this field exists: while this module's own tests were running, a
   * SECOND process in the same working tree ran the test suite, its
   * `sweepAtStart` read the machine-wide process table, and it killed the first
   * one's live workers. Reproduced deliberately: 4 of 24 runs, always as an
   * unrelated marked process dying.
   *
   * The earlier version drew its scope from the union of "runs on disk" and
   * "every run id in the process table", which made a start sweep MACHINE-WIDE.
   * Two brigadiers on one machine — two checkouts, two operators on a shared
   * box, a CI runner beside a developer — would each reclaim the other's live
   * workers, and the victim would see a worker vanish with no explanation
   * anywhere in its own record.
   *
   * Ruling 15's shape, applied to processes: a marker is IDENTITY, not
   * AUTHORITY. Recognising a process as brigadier's does not establish that it
   * is THIS brigadier's to kill. The record under this root is what does, and
   * where there is no record the answer is to report with the exact pid — which
   * is what ruling 63 already requires of anything brigadier cannot confirm
   * dead.
   *
   * The cost, stated: a leaked process from a run whose directory was removed by
   * hand is reported rather than reclaimed. That is bounded, because reclaiming
   * a run's clones deliberately KEEPS its manifest and record, so the run stays
   * known to this root and its processes stay sweepable.
   */
  readonly foreignMarked: ReadonlyArray<{ pid: number; runId: string; item: number; commandLine: string }>;
}

export interface StartSweepOptions {
  readonly runRoot: string;
  /** The run about to start. Never swept, in any respect. */
  readonly currentRunId?: string;
  readonly sweptBy?: string;
  readonly table?: ProcessTable;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly isAlive?: (pid: number) => boolean;
  readonly signal?: (pid: number, signal: NodeJS.Signals) => "sent" | "gone" | "denied";
  readonly selfPid?: number;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  readonly git?: GitRunner;
  /** Set false to report what WOULD be reclaimed without touching anything. */
  readonly apply?: boolean;
}

/**
 * The whole start-of-run sweep.
 *
 * The order is fixed and each step depends on the one before:
 *
 *   1. read the process table ONCE, so every scope is judged against one
 *      consistent view. The runs to sweep are those THIS ROOT has a record of;
 *      a marked process naming a run this root has never heard of is REPORTED
 *      with its pid and never signalled (`foreignMarked`, which records the
 *      measurement that made it necessary);
 *   2. reclaim processes for every stale run. ALWAYS, before anything is judged,
 *      because a live worker can still write into the directory being judged;
 *   3. consult the operator's repository and judge each run;
 *   4. delete directories for complete runs only, each through ruling 15's three
 *      proofs, and record what was refused;
 *   5. delete the refs of runs whose directories are gone, compare-and-swap;
 *   6. total up what is retained, in bytes.
 */
export async function sweepAtStart(options: StartSweepOptions): Promise<StartSweepReport> {
  const apply = options.apply ?? true;
  const sweptBy = options.sweptBy ?? "start-of-run sweep";
  const table = options.table ?? scanProcessTable();
  const runs = runsUnder(options.runRoot);

  // 1. Runs to consider: those THIS ROOT has a record of. A marked process whose
  //    run id this root has never heard of is REPORTED, never killed — see
  //    `foreignMarked` below for why that is a correctness rule and not caution.
  const runIds = new Set<string>(runs.map((run) => run.runId));
  if (options.currentRunId !== undefined) runIds.delete(options.currentRunId);

  const foreignMarked: Array<{ pid: number; runId: string; item: number; commandLine: string }> = [];
  for (const row of table.rows) {
    const marker = parseRunMarker(row.commandLine);
    if (marker === null) continue;
    if (marker.runId === options.currentRunId || runIds.has(marker.runId)) continue;
    foreignMarked.push({ pid: row.pid, runId: marker.runId, item: marker.item, commandLine: row.commandLine });
  }

  // 2. Processes, always.
  const processes: SweepOutcome[] = [];
  for (const runId of [...runIds].sort()) {
    const run = runs.find((candidate) => candidate.runId === runId);
    const recordedPids = run === undefined ? [] : spawnedProcesses(run.record.events).map((p) => p.pid);
    processes.push(
      await sweep({
        scope: { runId },
        sweptBy,
        table,
        recordedPids,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.selfPid === undefined ? {} : { selfPid: options.selfPid }),
        ...(options.termGraceMs === undefined ? {} : { termGraceMs: options.termGraceMs }),
        ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      }),
    );
  }

  // 3. Judge, having consulted the world.
  const stale = runs.filter((run) => run.runId !== options.currentRunId);
  const knownRunIds = runs.map((run) => run.runId);
  const verdicts: RunVerdict[] = [];
  const reclaimedDirs: Array<{ runId: string; item: number; path: string; bytes: number }> = [];
  const refusedDirs: Array<{ runId: string; item: number; path: string; refusals: readonly string[] }> = [];
  const retained: RetainedDirectory[] = [];
  const reclaimedRefs: string[] = [];
  const refusedRefs: Array<{ ref: string; refusal: string }> = [];

  for (const run of stale) {
    const facts = runFacts(run.record.events);
    const refs = facts === null ? null : await ownedRefs(facts.repo, options.git);
    const verdict = judgeRun(run, refs);
    verdicts.push(verdict);

    for (const clone of run.manifest?.clones ?? []) {
      if (!existsSync(clone.dir)) continue;
      if (verdict.completion !== "complete") {
        // 6's input: retained, with what it costs.
        retained.push({
          runId: run.runId,
          item: clone.item,
          path: clone.dir,
          bytes: directoryBytes(clone.dir),
          reason: verdict.reason,
        });
        continue;
      }
      // 4. Complete: ruling 15's three proofs, every time.
      if (!apply) {
        const dry = proveDeletableDirectory(clone.dir, { runRoot: options.runRoot });
        if (dry.deletable) reclaimedDirs.push({ runId: run.runId, item: clone.item, path: clone.dir, bytes: directoryBytes(clone.dir) });
        else refusedDirs.push({ runId: run.runId, item: clone.item, path: clone.dir, refusals: dry.refusals });
        continue;
      }
      const outcome = reclaimDirectory(clone.dir, { runRoot: options.runRoot });
      if (outcome.deleted) {
        reclaimedDirs.push({ runId: run.runId, item: clone.item, path: clone.dir, bytes: outcome.bytes });
        reclaimStateDir(options.runRoot, run.runId, clone.item);
      } else {
        refusedDirs.push({
          runId: run.runId,
          item: clone.item,
          path: clone.dir,
          refusals: outcome.verdict.refusals,
        });
        retained.push({
          runId: run.runId,
          item: clone.item,
          path: clone.dir,
          bytes: directoryBytes(clone.dir),
          reason: `refused by ruling 15: ${outcome.verdict.refusals.join(" ")}`,
        });
      }
    }

    // 5. Refs, once the directories they describe are gone. Only for a complete
    //    run: an incomplete run's refs are the resume information ruling 63
    //    decides completion from, and deleting them would erase the only record
    //    that the work landed.
    if (verdict.completion === "complete" && refs !== null && apply) {
      const facts2 = runFacts(run.record.events);
      const mine = refs.filter((owned) => owned.ref.startsWith(`refs/brigadier/${run.runId}/`));
      for (const owned of mine) {
        if (facts2 === null) break;
        const result = await reclaimRef(facts2.repo, owned, knownRunIds, options.git);
        if (result.deleted) reclaimedRefs.push(owned.ref);
        else if (result.refusal !== null) refusedRefs.push({ ref: owned.ref, refusal: result.refusal });
      }
      // Mark it discharged so a later start does not judge it incomplete purely
      // because the refs it would have checked have just been reclaimed. The
      // manifest and the record are deliberately KEPT — a few kilobytes, and the
      // only surviving evidence of what this run did.
      if (mine.length > 0 || (run.manifest?.clones ?? []).length > 0) {
        try {
          appendEvent(recordPath(options.runRoot, run.runId), {
            type: "discharged",
            at: (options.now ?? Date.now)(),
            item: null,
            by: sweptBy,
          });
        } catch {
          // A record that cannot be appended to is not a reason to undo a
          // reclamation that already happened. The next start re-derives.
        }
      }
    }
  }

  const unconfirmedPids = processes.flatMap((outcome) => [...outcome.unconfirmed]);
  return {
    runsSeen: [...runIds].sort(),
    verdicts,
    processes,
    reclaimedDirs,
    refusedDirs,
    retained,
    retainedBytes: retained.reduce((sum, item) => sum + item.bytes, 0),
    reclaimedRefs,
    refusedRefs,
    unconfirmedPids,
    foreignMarked,
  };
}

async function ownedRefs(repo: string, git: GitRunner | undefined): Promise<OwnedRef[] | null> {
  if (!existsSync(repo)) return null;
  try {
    return git === undefined ? await listOwnedRefs(repo) : await listOwnedRefs(repo, git);
  } catch {
    // Ruling 63's unknown: "we could not look" is not "the work is not there".
    return null;
  }
}

/**
 * The per-item state directory, deleted only after its clone was proved and
 * deleted.
 *
 * Stated rather than hidden: this directory carries no marker file of its own,
 * so it does not satisfy ruling 15 (c) by itself. It is deleted on the strength
 * of the CLONE's three proofs plus a path brigadier computes rather than
 * discovers — `<run root>/r/<run id>/state/<item>`, re-checked for existence and
 * never derived from anything an agent supplied. An agent never learns this
 * path from brigadier, and nothing in it is work product: it holds the
 * capability token, the empty global config and the hooks sink. Leaving it
 * behind would be the invisible growth ruling 63 requires be reported.
 */
function reclaimStateDir(runRoot: string, runId: string, item: number): void {
  const dir = join(runRoot, RUN_DIR, runId, "state", String(item));
  if (!existsSync(dir)) return;
  try {
    if (!statSync(dir).isDirectory()) return;
  } catch {
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}

/**
 * What a start prints.
 *
 * Retention is reported at EVERY start, including when there is none, because a
 * line that only appears when something is wrong is a line nobody learns to
 * read.
 */
export function describeStartSweep(report: StartSweepReport): string[] {
  const lines: string[] = [];
  for (const outcome of report.processes) {
    if (outcome.matched.length === 0 && outcome.unconfirmed.length === 0) continue;
    lines.push(...describeSweep(outcome));
  }
  if (report.reclaimedDirs.length > 0) {
    const bytes = report.reclaimedDirs.reduce((sum, dir) => sum + dir.bytes, 0);
    lines.push(
      `reclaimed ${report.reclaimedDirs.length} directory(ies) from completed runs, ${megabytes(bytes)}`,
    );
  }
  for (const refused of report.refusedDirs) {
    lines.push(`refused to delete ${refused.path}:`);
    for (const refusal of refused.refusals) lines.push(`  ${refusal}`);
  }
  if (report.reclaimedRefs.length > 0) {
    lines.push(`reclaimed ${report.reclaimedRefs.length} stale ref(s) under refs/brigadier/`);
  }
  for (const refused of report.refusedRefs) lines.push(`refused to delete ${refused.ref}: ${refused.refusal}`);

  lines.push(
    report.retained.length === 0
      ? "0 clone(s) retained from earlier runs"
      : `${report.retained.length} clone(s) retained from earlier runs, ${megabytes(report.retainedBytes)} — not merged, not reviewed, not deleted`,
  );
  for (const item of report.retained) {
    lines.push(`  ${item.runId} item ${item.item}: ${item.path} (${megabytes(item.bytes)}) — ${item.reason}`);
  }
  if (report.retained.length > 0) {
    lines.push("  discharge them explicitly to release the space; nothing here is deleted on your behalf");
  }
  if (report.unconfirmedPids.length > 0) {
    lines.push(
      `could not confirm dead: pid ${report.unconfirmedPids.join(", ")} — killing them is the only remedy`,
    );
  }
  if (report.foreignMarked.length > 0) {
    // Reported with the exact pid and the run it names, because the operator's
    // remedy is to go to THAT brigadier's run root — and because a marker is
    // identity, not authority.
    lines.push(
      `${report.foreignMarked.length} brigadier process(es) belong to runs this root has no record of, and were NOT touched:`,
    );
    for (const foreign of report.foreignMarked) {
      lines.push(`  pid ${foreign.pid}: run ${foreign.runId} item ${foreign.item} — another run root's to reclaim`);
    }
  }
  return lines;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(bytes < 1024 ** 2 ? 2 : 0)} MB`;
}

/**
 * Ruling 63's explicit discharge, which is the ONLY thing that turns a retained
 * directory into a deletable one.
 *
 * It is an append to the run record and nothing else. It deletes nothing itself:
 * the next start's sweep applies ruling 15's three proofs as it does to any
 * other directory, so a discharge is permission rather than an instruction.
 */
export function dischargeRun(runRoot: string, runId: string, by: string, at = Date.now()): void {
  appendEvent(recordPath(runRoot, runId), { type: "discharged", at, item: null, by });
}

/** Discharge one item. Same shape, narrower scope. */
export function dischargeItem(runRoot: string, runId: string, item: number, by: string, at = Date.now()): void {
  appendEvent(recordPath(runRoot, runId), { type: "discharged", at, item, by });
}

/**
 * Bridge to `interrupt.ts`'s promise about a run that could not be finished.
 *
 * The same four facts, sourced from the sweep rather than assembled by hand, so
 * the interrupt path and the start path cannot drift into telling the operator
 * two different stories about the same directories.
 */
export function unfinishedFrom(
  report: StartSweepReport,
  runId: string,
  landed: readonly number[],
  didNotLand: readonly number[],
): UnfinishedRun {
  return {
    landed: [...landed],
    didNotLand: [...didNotLand],
    retainedClones: report.retained
      .filter((item) => item.runId === runId)
      .map((item) => ({ item: item.item, path: item.path, bytes: item.bytes })),
    unconfirmedPids: [...report.unconfirmedPids],
  };
}
