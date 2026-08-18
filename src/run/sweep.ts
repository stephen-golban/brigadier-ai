// SPDX-License-Identifier: Apache-2.0
/**
 * The reclamation sweep: match on the command line, terminate, and confirm.
 *
 * RULING 38 — THE SWEEP IS THE CONTAINMENT MECHANISM, NOT CRASH RECOVERY. That
 * promotion is measured, not defensive. MEASURED at #43: Bun's Windows job
 * object is created with `JOB_OBJECT_LIMIT_BREAKAWAY_OK` **and**
 * `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` (`LIMIT_FLAGS=0x00003C00`, read from
 * inside the job), so `cmd /c start` escapes it — an ordinary idiom, not an
 * attack — as do `Win32_Process.Create` and `schtasks`, the last two because a
 * *system service* creates the process and it was therefore never in the job.
 * On POSIX one `setsid()` escapes `kill(-pgid)`. brigadier cannot fix any of it,
 * because Bun creates the job. So the group kill is a fast path, and this is the
 * boundary.
 *
 * Two requirements follow and both are met elsewhere in this directory:
 *
 *   - the sweep runs on START as well as on exit (`start.ts`), because a
 *     supervisor that was SIGKILLed never ran its exit path and the escaped
 *     descendant is still there when the operator comes back;
 *   - every process brigadier causes to exist carries a marker in its COMMAND
 *     LINE (`marker.ts`), never a name pattern, or this has nothing to match.
 *
 * AND A THIRD LINK, BECAUSE THE FIRST TWO ARE BOTH CUT IN THE ORDINARY CASE.
 * brigadier marks what IT spawns; it cannot write argv for a process an AGENT
 * spawns, and that process's ppid becomes 1 the moment the shell that launched
 * it exits. REPRODUCED on this host on 2026-08-18 with only the marker and the
 * ppid graph: a `/bin/sh` loop spawned `detached: true` from a short-lived
 * launcher, standing in the clone, came back `ppid 1`, and this sweep reported
 * `reclaimedPids: [worker, sleep], survivors: []` while its heartbeat grew from
 * 6 to 11 bytes through the measurement. So the closure also reclaims a process
 * whose WORKING DIRECTORY is inside a directory the run's manifest recorded
 * before creating it — ruling 15's proof of provenance, applied to a process —
 * with one exemption for the operator (`Disposition["terminal"]`).
 *
 * RULING 63 — WHAT THIS FILE MAY AND MAY NOT RECLAIM. Processes ALWAYS.
 * Directories only for runs that are complete, and that is `reclaim.ts` and
 * `start.ts`, deliberately not here. A leaked process consumes the machine and
 * can still act; a retained directory is inert and holds the only copy of
 * someone's work. Nothing in this file deletes anything on disk.
 *
 * AN UNCONFIRMED TERMINATION IS REPORTED WITH THE EXACT PIDS, because killing
 * them is the owner's only remedy and "something may still be running" is not an
 * instruction anybody can follow.
 *
 * WHAT THE EVIDENCE DOES AND DOES NOT CLAIM. `ReclamationEvidence.survivors`
 * being empty means *nothing that this reading of the process table matched
 * survived the kill*. It does not mean the sweep found every process, and
 * `src/isolation/clone.ts` says so plainly at the type: a caller reporting an
 * empty list gets past `assertReclaimed`. That check is not weakened here to
 * make anything easier. Instead `SweepCoverage.completeness` is the constant
 * `"not-proven"` and `SweepCoverage.limits` names each thing the scan cannot
 * see, so a report can carry the qualification rather than dropping it.
 */

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { ReclamationEvidence } from "../isolation/index.ts";
import { markerMatches, parseRunMarker, type MarkerScope } from "./marker.ts";
import {
  ancestorsOf,
  descendantsOf,
  isAlive as defaultIsAlive,
  noWorkspaceReading,
  readWorkspaceOccupants,
  scanProcessTable,
  signalPid as defaultSignalPid,
  type ProcessRow,
  type ProcessTable,
  type SignalResult,
  type WorkspaceReading,
} from "./processes.ts";

/**
 * How long a matched process is given to exit on `SIGTERM` before `SIGKILL`.
 *
 * Small on purpose, and for ruling 63's reason: this is not `session/cancel`.
 * Cancellation is the courtesy and it has already had `CANCEL_DEADLINE_MS`
 * (`interrupt.ts`) by the time anything gets here. A process that has been asked
 * to stop, has been killed by process group, and is still running has already
 * declined two invitations.
 */
export const TERM_GRACE_MS = 1_500;
/** After `SIGKILL` this is the kernel's own latency, not the process's choice. */
export const KILL_GRACE_MS = 750;

export type Disposition =
  /** Signalled, and confirmed gone afterwards. */
  | "reclaimed"
  /** Matched, and already dead when the first signal was delivered. */
  | "already-gone"
  /** Matched, signalled, and STILL ALIVE. Named in the report with its pid. */
  | "survivor"
  /** This process or one of its ancestors. Never signalled — see `ancestorsOf`. */
  | "self"
  /**
   * Standing inside one of this run's clones AND holding a CONTROLLING
   * TERMINAL. Never signalled.
   *
   * This is a person. brigadier retains the clones of interrupted runs and
   * prints their paths, so `cd`-ing into one to read the work is a thing the
   * product invites; every process brigadier itself spawns has its stdio on
   * pipes and no controlling terminal. Killing this would be the
   * working-directory rule doing exactly what ruling 38 forbids the marker to
   * do — reclaiming something on a resemblance rather than on provenance.
   *
   * NOT a survivor. `survivors` means brigadier signalled and could not confirm
   * death; this was deliberately never signalled, and it is named with its pid
   * in the sweep's limits instead so the qualification travels with the report.
   */
  | "terminal"
  /**
   * Turned up in the RE-SCAN, after the kill round had already finished.
   *
   * Always a survivor, even when the follow-up kill confirms it dead. Its
   * existence proves a spawner the sweep never saw, and evidence that licensed
   * `recycleClone` on such an item would re-open through this module the exact
   * race `src/isolation/` refuses to proceed without evidence about.
   */
  | "appeared";

export interface MatchedProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly commandLine: string;
  readonly item: number;
  /** False for an unmarked process reached through the ppid graph or its working directory. */
  readonly marked: boolean;
  /** Which link put this process in scope. Named in the report, because the three differ in strength. */
  readonly via: "marker" | "descendant" | "working-directory";
  readonly disposition: Disposition;
  /** Why it ended up in that disposition, in words a report can print. */
  readonly note: string;
}

/**
 * What the sweep could see, carried alongside what it did.
 *
 * `completeness` is a constant rather than a computed value. There is no reading
 * of a process table that proves completeness, so a field that could ever say
 * `"proven"` would be a field that eventually lies.
 */
export interface SweepCoverage {
  readonly source: string;
  readonly scannedAt: number;
  readonly rowsScanned: number;
  readonly completeness: "not-proven";
  readonly limits: readonly string[];
}

export interface SweepOutcome {
  /** The type `recycleClone` requires. Honest about this run, this item, and these pids. */
  readonly evidence: ReclamationEvidence;
  readonly matched: readonly MatchedProcess[];
  /** Ruling 63: the exact pids brigadier could not confirm dead. Identical to `evidence.survivors`. */
  readonly unconfirmed: readonly number[];
  /** Never signalled, because signalling them would kill the sweep. */
  readonly protectedPids: readonly number[];
  readonly coverage: SweepCoverage;
}

/**
 * One directory brigadier RECORDED IN ITS MANIFEST BEFORE IT CREATED IT, and
 * the item it belongs to.
 *
 * The item travels with the directory so that a process found only by where it
 * is standing still lands in per-item evidence, exactly as a marked one does.
 */
export interface Workspace {
  readonly item: number;
  readonly dir: string;
}

export interface SweepOptions {
  readonly scope: MarkerScope;
  /** Named in every refusal `assertReclaimed` can raise, so it has to identify a caller. */
  readonly sweptBy: string;
  /** A reading taken by the caller. Defaults to reading the table now. */
  readonly table?: ProcessTable;
  /**
   * A SECOND reading, taken after the kill round and before the evidence is
   * stamped.
   *
   * Defaults to a fresh scan, or to the injected `table` when one was supplied,
   * so a test with a static table stays deterministic. A caller cannot opt out
   * of the re-scan itself: without it, a process that started during the grace
   * window is reported as an absence, and `assertReclaimed` believes it.
   */
  readonly rescan?: () => ProcessTable;
  /**
   * Pids the record says brigadier spawned for this scope.
   *
   * Advisory only. A recorded pid that is alive but no longer carries the marker
   * is far more likely to be a REUSED pid than an escaped worker, so it is
   * reported as a limit rather than treated as a survivor — a sweep that blocked
   * every recycle on pid reuse would be turned off, and a sweep that is turned
   * off contains nothing.
   */
  readonly recordedPids?: readonly number[];
  /**
   * This run's clone directories, from the manifest that recorded them before
   * they existed.
   *
   * NOT advisory, unlike `recordedPids`, and the asymmetry is the point. A pid
   * is a number the kernel reuses within minutes, so a recorded pid proves
   * nothing about the process holding it now. A directory brigadier wrote down
   * before creating it is ruling 15's own proof of provenance, and a process
   * standing inside it is standing inside brigadier's isolation.
   *
   * Empty means the caller has no manifest to offer — an item-scoped sweep from
   * a caller that never had one, or a test — and the sweep falls back to the
   * command line and the ppid graph alone.
   */
  readonly workspaces?: readonly Workspace[];
  /**
   * Where every process is standing, and who holds a terminal.
   *
   * Defaults to reading it, and ONLY when there is something to match: no
   * workspaces or no rows means no reader is forked at all, so a caller passing
   * a static table stays hermetic and cheap.
   */
  readonly occupants?: WorkspaceReading;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: (pid: number, signal: NodeJS.Signals) => SignalResult;
  readonly isAlive?: (pid: number) => boolean;
  readonly selfPid?: number;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One process the sweep is responsible for, and the link that made it so. */
interface Candidate {
  row: ProcessRow;
  item: number;
  marked: boolean;
  via: "marker" | "descendant" | "working-directory";
}

/** What the closure deliberately left alone, so the caller can report it. */
interface Closure {
  candidates: Candidate[];
  /** Standing in a clone, holding a controlling terminal. A person, never signalled. */
  occupiedByTerminal: Candidate[];
  /**
   * Processes in a clone that DESCEND from one of those people.
   *
   * Counted rather than listed: they are `sleep`, `git`, `grep` — whatever the
   * person's shell is running this second — and naming them would bury the one
   * pid the operator can act on. Sparing them is not politeness: a rule that
   * kills the children of the shell it just declined to kill has not spared
   * anybody.
   */
  sharedWithAPerson: number;
}

/**
 * `realpath` on both sides, because `/var` is a symlink to `/private/var` on
 * macOS and a lexical comparison against an unresolved manifest entry judges a
 * tree that is not the one the process is standing in. The same argument
 * `reclaim.ts` makes for deletion, at the same blast radius: this one kills.
 *
 * An unresolvable path falls back to the string, which can only ever make the
 * comparison FAIL to match — the safe direction, since a miss leaks a process
 * and a false match kills a stranger.
 */
function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function inside(cwd: string, dir: string): boolean {
  return cwd === dir || cwd.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * The set of processes this scope is responsible for, by three links of
 * decreasing strength.
 *
 *   1. THE MARKER, in the command line. Ruling 38's own channel, and proof that
 *      brigadier spawned this process itself.
 *   2. THE PPID GRAPH. Ruling 38 says every process brigadier CAUSES TO EXIST
 *      carries the marker, and brigadier cannot mark what an agent spawns for
 *      itself: a worker that runs `sh build.sh &` leaves an unmarked child, and
 *      the marked set misses it while the ppid column of the same reading does
 *      not.
 *   3. THE WORKING DIRECTORY, against directories the manifest recorded before
 *      creating them. This is the link that survives what cuts the first two at
 *      once, which is the ORDINARY case and not the exotic one: the escapee is
 *      unmarked because an agent spawned it, and its ppid is 1 within
 *      milliseconds because the shell that launched it exited. REPRODUCED on
 *      2026-08-18 with links 1 and 2 alone: `reclaimedPids: [worker, sleep],
 *      survivors: []`, while the escapee's heartbeat grew from 6 to 11 bytes
 *      through the measurement.
 *
 * A process found by any link contributes its own ppid-descendants, so an
 * escapee that has since forked is reclaimed with its children rather than
 * alone. Every non-marker candidate inherits the item of whatever put it in
 * scope, so evidence stays per-item.
 *
 * THE ONE OCCUPANT THAT IS NEVER SIGNALLED is a process holding a controlling
 * terminal. See `Disposition["terminal"]`: brigadier prints the paths of the
 * clones it retains, so an operator reading one is a case the product invites,
 * and it is separated out here rather than filtered later so that it can never
 * be reached as somebody else's descendant either.
 */
function closureFor(
  table: ProcessTable,
  scope: MarkerScope,
  workspaces: readonly Workspace[],
  occupants: WorkspaceReading,
): Closure {
  const byPid = new Map(table.rows.map((row) => [row.pid, row] as const));
  const candidates = new Map<number, Candidate>();
  const occupiedByTerminal: Candidate[] = [];

  // The terminal exemption is deliberately NOT applied here. Links 1 and 2 are
  // proof that brigadier caused the process to exist, and a worker started from
  // the operator's own terminal is in the operator's session — sparing it would
  // turn the guard into "never reclaim anything when brigadier is run the
  // ordinary way". Only the working-directory link, which proves location and
  // not provenance, defers to a person.
  const adopt = (root: ProcessRow, item: number, via: Candidate["via"]): void => {
    for (const pid of descendantsOf([root.pid], table.rows)) {
      if (candidates.has(pid)) continue;
      const row = pid === root.pid ? root : byPid.get(pid);
      if (row === undefined) continue;
      candidates.set(pid, {
        row,
        item,
        marked: pid === root.pid && via === "marker",
        via: pid === root.pid ? via : "descendant",
      });
    }
  };

  for (const row of table.rows) {
    if (!markerMatches(row.commandLine, scope)) continue;
    candidates.delete(row.pid);
    adopt(row, itemOf(row, scope), "marker");
  }

  let sharedWithAPerson = 0;
  if (workspaces.length > 0 && occupants.cwds.size > 0) {
    const dirs = workspaces.map((workspace) => ({ item: workspace.item, dir: resolved(workspace.dir) }));
    for (const row of table.rows) {
      if (candidates.has(row.pid)) continue;
      const cwd = occupants.cwds.get(row.pid);
      if (cwd === undefined) continue;
      const home = dirs.find((workspace) => inside(cwd, workspace.dir));
      if (home === undefined) continue;
      if (occupants.interactive.has(row.pid)) {
        occupiedByTerminal.push({ row, item: home.item, marked: false, via: "working-directory" });
        continue;
      }
      // Whatever that person's shell is running right now is theirs as well.
      // Without this the exemption is worthless: the shell survives and every
      // command it runs inside the clone is killed under it.
      let theirs = false;
      for (const ancestor of ancestorsOf(row.pid, table.rows)) {
        if (!occupants.interactive.has(ancestor)) continue;
        theirs = true;
        break;
      }
      if (theirs) {
        sharedWithAPerson += 1;
        continue;
      }
      adopt(row, home.item, "working-directory");
    }
  }

  return { candidates: [...candidates.values()], occupiedByTerminal, sharedWithAPerson };
}

/**
 * Run the sweep for one scope.
 *
 * The order is fixed:
 *
 *   1. read the process table once, so the closure is computed against one
 *      consistent view rather than a table that moves under the loop;
 *   2. compute the protected set — this process and every ancestor — BEFORE any
 *      signal is sent. The orchestrator's own command line carries the run
 *      marker, and a sweep that matched itself would kill the process doing the
 *      sweeping;
 *   3. `SIGTERM` every candidate, wait, `SIGKILL` what is left, wait;
 *   4. RE-SCAN. Anything for this scope that is alive now and was not in the
 *      first reading started during the sweep, and is a SURVIVOR — not an
 *      absence. Skipping this step reports `survivors: []` for an item whose
 *      worker is live, which licenses `recycleClone` on a directory somebody is
 *      still writing to;
 *   5. confirm each pid with signal 0 and only then stamp `sweptAt`. Evidence
 *      timestamped before the confirmation would be evidence about an earlier
 *      world.
 */
export async function sweep(options: SweepOptions): Promise<SweepOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const signal = options.signal ?? defaultSignalPid;
  const alive = options.isAlive ?? defaultIsAlive;
  const selfPid = options.selfPid ?? process.pid;
  const termGraceMs = options.termGraceMs ?? TERM_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const table = options.table ?? scanProcessTable();
  const injected = options.table;
  const rescan = options.rescan ?? (injected === undefined ? scanProcessTable : () => injected);
  const workspaces = options.workspaces ?? [];

  // The reader is forked ONLY when it could change an answer: no workspaces to
  // match against, or no rows to match, and the whole reading is skipped. That
  // keeps every caller that injects a static table hermetic and free.
  const occupy = (): WorkspaceReading => {
    if (options.occupants !== undefined) return options.occupants;
    if (workspaces.length === 0) {
      return noWorkspaceReading("not read", "the caller offered no manifest-recorded directories to match a working directory against");
    }
    return readWorkspaceOccupants();
  };
  const occupants = table.rows.length === 0
    ? noWorkspaceReading("not read", "the process table reading had no rows, so there was nothing to place")
    : occupy();

  const protectedPids = ancestorsOf(selfPid, table.rows);
  const matched: MatchedProcess[] = [];
  const pending: Candidate[] = [];
  const closure = closureFor(table, options.scope, workspaces, occupants);

  for (const person of closure.occupiedByTerminal) {
    matched.push({
      ...describe(person),
      disposition: "terminal",
      note:
        `standing in ${occupants.cwds.get(person.row.pid) ?? "one of this run's clones"} and holding a ` +
        "controlling terminal as its own process group leader — that is a person, not a leaked worker. " +
        "brigadier prints the paths of the clones it retains, so reading one is a thing it invited. " +
        "Reported, never signalled.",
    });
  }

  for (const candidate of closure.candidates) {
    if (protectedPids.has(candidate.row.pid) || candidate.row.pid <= 1) {
      matched.push({
        ...describe(candidate),
        disposition: "self",
        note:
          candidate.row.pid === selfPid
            ? "this is the process performing the sweep"
            : `pid ${candidate.row.pid} is an ancestor of the sweeping process (${selfPid}) or pid 1`,
      });
      continue;
    }
    pending.push(candidate);
  }

  // 3. Terminate. A process that is already gone is recorded as such rather than
  //    as a kill we performed, because the two are different facts.
  const stillPending: Candidate[] = [];
  for (const candidate of pending) {
    const result = signal(candidate.row.pid, "SIGTERM");
    if (result === "gone") {
      matched.push({ ...describe(candidate), disposition: "already-gone", note: "exited before the first signal" });
      continue;
    }
    stillPending.push(candidate);
  }

  if (stillPending.length > 0) {
    await settle(stillPending, termGraceMs, sleep, alive);
    for (const candidate of stillPending) {
      if (alive(candidate.row.pid)) signal(candidate.row.pid, "SIGKILL");
    }
    await settle(stillPending, killGraceMs, sleep, alive);
  }

  const reclaimedPids: number[] = [];
  const survivors: number[] = [];
  for (const candidate of stillPending) {
    if (alive(candidate.row.pid)) {
      survivors.push(candidate.row.pid);
      matched.push({
        ...describe(candidate),
        disposition: "survivor",
        note:
          `still alive after SIGTERM, ${termGraceMs} ms, SIGKILL and ${killGraceMs} ms. ` +
          "Either it belongs to another user (signal denied) or it is unkillable from here.",
      });
    } else {
      reclaimedPids.push(candidate.row.pid);
      matched.push({
        ...describe(candidate),
        disposition: "reclaimed",
        note: candidate.marked
          ? "confirmed gone with signal 0"
          : candidate.via === "working-directory"
            ? "UNMARKED and unreachable through the ppid graph — found only by standing inside a " +
              "directory this run's manifest recorded; confirmed gone with signal 0"
            : "an UNMARKED descendant of a marked process, confirmed gone with signal 0",
      });
    }
  }
  for (const already of matched) {
    if (already.disposition === "already-gone") reclaimedPids.push(already.pid);
  }

  // 4. The re-scan. Reproduced 3 times in 3 before it existed: a marked process
  //    appearing 500 ms into a 1.6 s sweep was still ticking at the end and the
  //    evidence said `survivors: []`.
  const afterTable = rescan();
  // The occupants are re-read too, and for the same reason the table is: a
  // process that stepped into a clone during the grace window is exactly the
  // spawner this step exists to notice.
  const afterOccupants = afterTable.rows.length === 0 ? occupants : occupy();
  const seen = new Set(pending.map((candidate) => candidate.row.pid));
  const afterClosure = closureFor(afterTable, options.scope, workspaces, afterOccupants);
  const appeared: Candidate[] = [];
  for (const candidate of afterClosure.candidates) {
    const pid = candidate.row.pid;
    if (seen.has(pid) || protectedPids.has(pid) || pid <= 1) continue;
    if (!alive(pid)) continue;
    appeared.push(candidate);
  }
  for (const candidate of appeared) signal(candidate.row.pid, "SIGKILL");
  if (appeared.length > 0) await settle(appeared, killGraceMs, sleep, alive);
  for (const candidate of appeared) {
    // A SURVIVOR whether or not the follow-up kill worked. Its existence proves
    // a spawner this sweep never saw, and "we killed the one we noticed" is not
    // the claim `assertReclaimed` acts on.
    survivors.push(candidate.row.pid);
    matched.push({
      ...describe(candidate),
      disposition: "appeared",
      note:
        `started DURING the sweep and was not in the first reading; killed, now ` +
        `${alive(candidate.row.pid) ? "still alive" : "gone"}. Something is still spawning for this ` +
        "scope, so this sweep cannot license a recycle.",
    });
  }

  const limits = [...table.limits, ...occupants.limits];
  const people = matched.filter((m) => m.disposition === "terminal");
  if (people.length > 0) {
    limits.push(
      `pid ${people.map((m) => m.pid).join(", ")} is standing inside one of this run's clones and ` +
        "holds a controlling terminal as its own process group leader, so it was NOT signalled — " +
        "that is somebody reading the work, and brigadier printed the path that invited them. It " +
        "is not counted a survivor because it was never signalled, and the directory it is in is " +
        "not brigadier's to recycle while it is there." +
        (closure.sharedWithAPerson > 0
          ? ` ${closure.sharedWithAPerson} further process(es) in that clone descend from them and were left alone too.`
          : ""),
    );
  }
  const stale = (options.recordedPids ?? []).filter(
    (pid) => alive(pid) && !matched.some((m) => m.pid === pid),
  );
  if (stale.length > 0) {
    limits.push(
      `the record says brigadier spawned pid ${stale.join(", ")} for this scope; those pids are ` +
        "alive and no longer carry the marker. Most likely the pid was reused; it cannot be " +
        "proved either way, so they were not signalled and are not counted as survivors.",
    );
  }
  if (matched.some((m) => m.disposition === "self")) {
    limits.push(
      `${matched.filter((m) => m.disposition === "self").length} matching process(es) were the ` +
        "sweeping process or its ancestors and were deliberately not signalled",
    );
  }

  // 5. Only now. `sweptAt` has to be at or after the confirmation, and
  //    `assertReclaimed` compares it against the moment the clone was released.
  const sweptAt = now();
  return {
    evidence: {
      runId: options.scope.runId,
      // A run-wide sweep records item 0, and 0 is not a usable item number
      // anywhere in brigadier. That is the intended consequence: run-wide
      // evidence can never satisfy `assertReclaimed` for a specific clone, so a
      // caller cannot recycle item 3 on the strength of a sweep that was never
      // scoped to it. Scope the sweep to the item, or do not recycle.
      item: options.scope.item ?? 0,
      sweptAt,
      reclaimedPids,
      survivors,
      sweptBy: options.sweptBy,
    },
    matched,
    unconfirmed: survivors,
    protectedPids: [...protectedPids],
    coverage: {
      source: table.source,
      scannedAt: table.scannedAt,
      rowsScanned: table.rows.length,
      completeness: "not-proven",
      limits,
    },
  };
}

function describe(candidate: Candidate): Omit<MatchedProcess, "disposition" | "note"> {
  return {
    pid: candidate.row.pid,
    ppid: candidate.row.ppid,
    commandLine: candidate.row.commandLine,
    item: candidate.item,
    marked: candidate.marked,
    via: candidate.via,
  };
}

/** The item this row's own marker names. `markerMatches` has already agreed it is ours. */
function itemOf(row: ProcessRow, scope: MarkerScope): number {
  return parseRunMarker(row.commandLine)?.item ?? scope.item ?? 0;
}

/** Poll rather than sleep flat: a process that exits at once should not cost the full grace. */
async function settle(
  candidates: ReadonlyArray<{ row: ProcessRow }>,
  budgetMs: number,
  sleep: (ms: number) => Promise<void>,
  alive: (pid: number) => boolean,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!candidates.some((candidate) => alive(candidate.row.pid))) return;
    if (Date.now() >= deadline) return;
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}

/**
 * The sweep, in the words a report prints.
 *
 * The survivor line names every pid, because ruling 63 requires it and because
 * an operator who is told "one process could not be reclaimed" has been given a
 * worry rather than a remedy.
 */
export function describeSweep(outcome: SweepOutcome): string[] {
  const scope = outcome.evidence.item === 0
    ? outcome.evidence.runId
    : `${outcome.evidence.runId}/${outcome.evidence.item}`;
  const lines = [
    `sweep ${scope} (${outcome.evidence.sweptBy}): ${outcome.evidence.reclaimedPids.length} process(es) reclaimed, ` +
      `${outcome.unconfirmed.length} unconfirmed, from ${outcome.coverage.rowsScanned} rows read by \`${outcome.coverage.source}\``,
  ];
  for (const match of outcome.matched) {
    if (match.disposition === "reclaimed" || match.disposition === "already-gone") {
      lines.push(`  reclaimed pid ${match.pid} (item ${match.item}): ${match.note}`);
    }
  }
  for (const person of outcome.matched) {
    if (person.disposition !== "terminal") continue;
    lines.push(
      `  pid ${person.pid} (item ${person.item}) is IN this run's clone with a terminal open and was ` +
        "NOT signalled — leave it, or close it and start again",
    );
  }
  const appeared = outcome.matched.filter((m) => m.disposition === "appeared");
  for (const late of appeared) {
    lines.push(
      `  pid ${late.pid} (item ${late.item}) STARTED DURING the sweep and was killed; counted as a ` +
        "survivor because something is still spawning for this scope",
    );
  }
  const stubborn = outcome.unconfirmed.filter((pid) => !appeared.some((m) => m.pid === pid));
  if (stubborn.length > 0) {
    lines.push(
      `  could not confirm dead: pid ${stubborn.join(", ")} — killing them is the only remedy`,
    );
  }
  // Printed every time, including on a clean sweep. The qualification is worth
  // least exactly when it would be most tempting to drop it.
  lines.push(`  completeness: ${outcome.coverage.completeness} — an empty survivor list is not proof the sweep found everything`);
  for (const limit of outcome.coverage.limits) lines.push(`    - ${limit}`);
  return lines;
}
