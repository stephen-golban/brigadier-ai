// SPDX-License-Identifier: Apache-2.0
/**
 * The run record: NDJSON, appended, never rewritten.
 *
 * Ruling 70. Not one JSON document, and the reason is a specific failure rather
 * than a preference. The failure this exists for is a process dying without
 * warning — v1's finding 92, an external `SIGTERM` to a supervisor — and the two
 * formats behave completely differently under it:
 *
 *   - a single JSON document truncated by a kill is unparseable IN ITS ENTIRETY.
 *     Every earlier fact in the file is lost with the last one, and the file
 *     that was supposed to say what happened says nothing at all;
 *   - NDJSON loses the last line and keeps every earlier one. A partial file is
 *     still evidence.
 *
 * It composes with two other rulings without extra machinery. Resumption reads
 * the file and folds it, with no merge step, because appending IS the merge.
 * And ruling 52's write-ahead — every blocking check's slot written BEFORE the
 * check runs, initialised to `not-run` — is a plain append here rather than a
 * read-modify-write of a document, so a crash mid-check leaves a *blocking*
 * value on disk rather than an absent field. Absence is made impossible rather
 * than handled.
 *
 * ONE EVENT IS ALWAYS ONE LINE, and that is not a convention this file hopes
 * everyone keeps: `JSON.stringify` escapes every newline inside a string, so a
 * path or an error message containing a newline cannot split a record. The only
 * partial line a reader can ever see is the last one.
 *
 * WHAT THIS FILE IS NOT. It is a record of INTENT. Ruling 63 is explicit that on
 * resume an item is complete iff its REF exists, not if the record says so —
 * ruling 58's dead-pid rule generalised: *a state file records intent, the world
 * records fact, and where the world can be consulted the world wins.* Nothing
 * here reports liveness, and there is deliberately no `running` field for a
 * later reader to trust; liveness is derived from the process table by
 * `sweep.ts`, whose matcher IS the liveness check.
 *
 * It also does not replace `src/isolation/manifest.ts`. That file is ruling 15's
 * ownership record and `src/isolation/` depends on it for the durable clone
 * signature; this one sits beside it in the same run directory and records what
 * HAPPENED. `reclaim.ts` reads both, and requires the manifest — never this
 * file — before it will delete anything.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { RUN_DIR } from "../repo/layout.ts";
import { INITIAL_OUTCOME, type CheckOutcome } from "../work/check.ts";

export const RECORD_NAME = "record.ndjson";

/** Beside `manifest.json`, in the run directory ruling 61 places. */
export function recordPath(runRoot: string, runId: string): string {
  return join(runRoot, RUN_DIR, runId, RECORD_NAME);
}

export type RunEvent =
  /** Written before anything is created, so a record exists even for a run that dies immediately. */
  | { type: "run-started"; at: number; runId: string; repo: string; runRoot: string; pid: number }
  /**
   * The commit a wave's items were cloned from and are diffed against.
   *
   * `wave: 0` is ruling 50's base commit for the whole run; `wave: n` is what
   * ruling 54 gives wave `n` — the base commit on wave 1, and the integration
   * commit the previous wave published afterwards. Recorded because
   * `item-landed` names only the RIGHT-hand side of `git diff <base>..<ref>`,
   * and a record that cannot re-derive an item's diff cannot support ruling
   * 51's ownership check or ruling 52's reviewer brief after the fact.
   */
  | { type: "base-recorded"; at: number; wave: number; ref: string; sha: string }
  /** Mirrors the manifest entry. The manifest is authority for deletion; this is the timeline. */
  | { type: "clone-recorded"; at: number; item: number; dir: string }
  /** Ruling 38: the marker as spawned, so a later sweep can be told what it should have matched. */
  | { type: "process-spawned"; at: number; item: number; pid: number; commandLine: string }
  /** Ruling 52's write-ahead. Always `not-run`; written BEFORE the check runs. */
  | { type: "check-slot"; at: number; item: number; check: string; outcome: CheckOutcome }
  | { type: "check-settled"; at: number; item: number; check: string; outcome: CheckOutcome; detail: string | null }
  /** Intent. Ruling 63 decides completion from the ref, and this is only what we meant. */
  | { type: "item-landed"; at: number; item: number; ref: string; sha: string }
  | { type: "run-finished"; at: number; outcome: "complete" | "abandoned" }
  /** Ruling 63's explicit discharge. `item: null` discharges the whole run. */
  | { type: "discharged"; at: number; item: number | null; by: string }
  | {
      type: "swept";
      at: number;
      sweptBy: string;
      runId: string;
      item: number | null;
      reclaimedPids: number[];
      survivors: number[];
    };

export type RunEventType = RunEvent["type"];

/**
 * The fields each event must carry to be usable, checked on read.
 *
 * A line that survived a kill half-written is not evidence of what it looks
 * like it says, so it is reported rather than folded. This is deliberately the
 * only validation: a record from a newer brigadier carrying extra fields is
 * still readable, because the alternative is a gate that rejects the evidence it
 * was written to preserve.
 */
const REQUIRED: Record<RunEventType, readonly string[]> = {
  "run-started": ["runId", "repo", "runRoot", "pid"],
  "base-recorded": ["wave", "ref", "sha"],
  "clone-recorded": ["item", "dir"],
  "process-spawned": ["item", "pid", "commandLine"],
  "check-slot": ["item", "check", "outcome"],
  "check-settled": ["item", "check", "outcome"],
  "item-landed": ["item", "ref", "sha"],
  "run-finished": ["outcome"],
  discharged: ["item", "by"],
  swept: ["sweptBy", "runId", "reclaimedPids", "survivors"],
};

/**
 * Append one event.
 *
 * `O_APPEND` so that two processes writing the same record interleave whole
 * lines rather than overwriting one another at a shared offset, and
 * `O_NOFOLLOW` plus the lstat for the reason `src/isolation/safe-fs.ts` gives:
 * this path is beside a directory an agent can reach, and both `writeFileSync`
 * and `appendFileSync` follow a symlink at the destination. That module's writer
 * cannot be reused here because it truncates, which is the one thing ruling 70
 * forbids.
 */
export function appendEvent(path: string, event: RunEvent): void {
  let stat: ReturnType<typeof lstatSync> | null = null;
  try {
    stat = lstatSync(path);
  } catch {
    stat = null;
  }
  if (stat !== null) {
    if (stat.isSymbolicLink()) {
      throw new Error(
        `refusing to append the run record through a symlink: ${path}. The record is evidence ` +
          "about processes brigadier may have to kill; writing it somewhere an agent chose is " +
          "not a recoverable state.",
      );
    }
    if (!stat.isFile()) throw new Error(`refusing to append to ${path}, which is not a regular file`);
  }
  // A record whose last line was truncated by a kill does NOT end in a newline.
  // Appending straight onto it fuses the new event with the fragment and costs
  // that event too — the fragment is reported as a damaged line either way, so
  // the loss is one event more than it looks. A leading newline closes the
  // fragment and keeps the new event whole. This is the resumption case, so it
  // is the case that must not lose anything.
  const needsBreak = stat !== null && stat.size > 0 && !endsWithNewline(path);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND |
      (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0),
  );
  try {
    writeSync(fd, `${needsBreak ? "\n" : ""}${JSON.stringify(event)}\n`);
  } finally {
    closeSync(fd);
  }
}

/** Does the file end in a newline, i.e. is its last record whole? */
function endsWithNewline(path: string): boolean {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const tail = Buffer.alloc(1);
    readSync(fd, tail, 0, 1, size - 1);
    return tail[0] === 0x0a;
  } catch {
    // Unreadable: assume it needs the break. A spurious blank line costs
    // nothing; a fused event costs an event.
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * What a read of the record yielded, INCLUDING what it could not read.
 *
 * `truncatedTail` and `damagedLines` are different problems and are reported
 * separately on purpose. A truncated last line is the expected consequence of a
 * kill and costs one event; a damaged line in the middle means something other
 * than a kill happened to the file, and a reader that silently treated the two
 * alike would hide it.
 */
export interface RecordReading {
  events: RunEvent[];
  /** The final line, present but unparseable. Ruling 70's whole point: everything before it survives. */
  truncatedTail: string | null;
  /** 1-based line numbers of earlier lines that did not parse. */
  damagedLines: number[];
  lines: number;
}

/** Never throws. A record brigadier cannot read is still the best evidence available. */
export function readRunRecord(path: string): RecordReading {
  const reading: RecordReading = { events: [], truncatedTail: null, damagedLines: [], lines: 0 };
  if (!existsSync(path)) return reading;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return reading;
  }
  const raw = text.split("\n");
  // A well-formed file ends with a newline, so the final element is empty. If it
  // is not, the process died mid-line and that line is the truncated tail.
  const trailing = raw[raw.length - 1] ?? "";
  const lines = trailing === "" ? raw.slice(0, -1) : raw;
  reading.lines = lines.length;

  lines.forEach((line, index) => {
    const event = parseEvent(line);
    if (event !== null) {
      reading.events.push(event);
      return;
    }
    if (line.trim() === "") return;
    if (index === lines.length - 1 && trailing !== "") reading.truncatedTail = line;
    else reading.damagedLines.push(index + 1);
  });
  return reading;
}

function parseEvent(line: string): RunEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const type = record["type"];
  if (typeof type !== "string" || !(type in REQUIRED)) return null;
  if (typeof record["at"] !== "number" || !Number.isFinite(record["at"])) return null;
  for (const field of REQUIRED[type as RunEventType]) {
    if (record[field] === undefined) return null;
  }
  return parsed as RunEvent;
}

/**
 * Ruling 52's write-ahead, made a single call so that "write the slot first" is
 * not something a caller has to remember to do in the right order.
 *
 * The slot is `not-run`, which BLOCKS. A crash between here and `settleCheck`
 * leaves a blocking value on disk rather than an absent field, which is the
 * whole fix for v1's killed gate decaying into an ordinary skip.
 */
export function openCheckSlot(path: string, item: number, check: string, at = Date.now()): void {
  appendEvent(path, { type: "check-slot", at, item, check, outcome: INITIAL_OUTCOME });
}

export function settleCheck(
  path: string,
  item: number,
  check: string,
  outcome: CheckOutcome,
  detail: string | null = null,
  at = Date.now(),
): void {
  appendEvent(path, { type: "check-settled", at, item, check, outcome, detail });
}

export interface CheckSlot {
  item: number;
  check: string;
  outcome: CheckOutcome;
  detail: string | null;
  /** False until a `check-settled` arrives. A slot that never settled is a crash, not a skip. */
  settled: boolean;
}

/**
 * Fold the record into the state of every check slot.
 *
 * Last write wins per `<item>/<check>`, which is what append-only means: a
 * settled check that is re-run appends a new slot and a new result, and the fold
 * reads the latest. There is no path here that produces an absent outcome,
 * because a slot cannot exist without one.
 */
export function checkSlots(events: readonly RunEvent[]): CheckSlot[] {
  const slots = new Map<string, CheckSlot>();
  for (const event of events) {
    if (event.type === "check-slot") {
      slots.set(`${event.item}/${event.check}`, {
        item: event.item,
        check: event.check,
        outcome: event.outcome,
        detail: null,
        settled: false,
      });
    } else if (event.type === "check-settled") {
      // A settled result with no slot before it is still recorded: the write-ahead
      // is the producer's duty, and a reader that dropped the result because the
      // slot was missing would hide exactly the bug ruling 52 is about.
      slots.set(`${event.item}/${event.check}`, {
        item: event.item,
        check: event.check,
        outcome: event.outcome,
        detail: event.detail,
        settled: true,
      });
    }
  }
  return [...slots.values()];
}

/** The run-level facts, from the first `run-started`. Null if the record never got one. */
export function runFacts(
  events: readonly RunEvent[],
): { runId: string; repo: string; runRoot: string; startedAt: number; pid: number } | null {
  for (const event of events) {
    if (event.type === "run-started") {
      return {
        runId: event.runId,
        repo: event.repo,
        runRoot: event.runRoot,
        startedAt: event.at,
        pid: event.pid,
      };
    }
  }
  return null;
}

/** Every item the record ever mentions, in ascending order. */
export function itemsMentioned(events: readonly RunEvent[]): number[] {
  const items = new Set<number>();
  for (const event of events) {
    if ("item" in event && typeof event.item === "number") items.add(event.item);
  }
  return [...items].sort((a, b) => a - b);
}

/** What the record CLAIMS landed. Ruling 63 checks the ref before believing it. */
export function claimedLandings(events: readonly RunEvent[]): Map<number, { ref: string; sha: string }> {
  const landed = new Map<number, { ref: string; sha: string }>();
  for (const event of events) {
    if (event.type === "item-landed") landed.set(event.item, { ref: event.ref, sha: event.sha });
  }
  return landed;
}

/**
 * Ruling 63's explicit discharge: the operator saying a retained directory may
 * go. A run-level discharge (`item: null`) covers every item.
 */
export function dischargedItems(events: readonly RunEvent[]): { run: boolean; items: Set<number> } {
  const items = new Set<number>();
  let run = false;
  for (const event of events) {
    if (event.type !== "discharged") continue;
    if (event.item === null) run = true;
    else items.add(event.item);
  }
  return { run, items };
}

/** Did the record ever say the run finished? Intent only — never sufficient on its own. */
export function finishedIntent(events: readonly RunEvent[]): "complete" | "abandoned" | null {
  let outcome: "complete" | "abandoned" | null = null;
  for (const event of events) {
    if (event.type === "run-finished") outcome = event.outcome;
  }
  return outcome;
}

/** Every pid the record says brigadier spawned, with the marker it was spawned with. */
export function spawnedProcesses(
  events: readonly RunEvent[],
): Array<{ item: number; pid: number; commandLine: string }> {
  const spawned: Array<{ item: number; pid: number; commandLine: string }> = [];
  for (const event of events) {
    if (event.type === "process-spawned") {
      spawned.push({ item: event.item, pid: event.pid, commandLine: event.commandLine });
    }
  }
  return spawned;
}
