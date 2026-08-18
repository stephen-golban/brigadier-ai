// SPDX-License-Identifier: Apache-2.0
/**
 * The ledger a REFUSED DELEGATION writes itself into, and the count the run
 * reads back out of it.
 *
 * Ruling 59, and the half of it that was missing. Ruling 57's binary refusal
 * already worked — MEASURED on 2026-08-18 against a real vendor's tool shell,
 * bar item 9: the marker reached the shell, `brigadier run --plan whatever` was
 * invoked inside a worker, and the binary exited 3 without orchestrating
 * anything. Ruling 57's one unmeasured assumption is therefore measured and
 * holding. But nothing counted it: `record.refusedDelegations` was the literal
 * `0`, written by `execute.ts` at the end of every run, and the report line was
 * consequently never printed. A guard that fires and is never observed is
 * indistinguishable from a guard that never fires, and the operator loses the
 * one signal that says their brief — or their repository's `AGENTS.md` — is
 * pointing workers back at brigadier.
 *
 * THE REFUSING PROCESS WRITES ITS OWN LINE, and it can only do that because
 * ruling 59 made the worker marker an IDENTITY rather than a boolean.
 * `BRIGADIER_WORKER=<run-id>/<item>` says WHICH run's ledger to append to;
 * `BRIGADIER_RUN_ROOT` says where that run's directory lives, because the run
 * root is per-machine and per-invocation (`--run-root`) and cannot be derived
 * from an id. Ruling 57 shipped the boolean `"1"`, and a worker spawned by an
 * older brigadier is still refused — it simply has nowhere to write, which is
 * why `recordRefusal` reports `no-home` rather than throwing.
 *
 * WHY A SIDECAR FILE RATHER THAN THE NDJSON RECORD. The two writers are
 * different processes with different lifetimes, and `src/run/record.ts`'s event
 * union is the orchestrator's vocabulary — a refusal is not an event the
 * orchestrator observed, it is a fact a descendant reported about itself. Both
 * files live in the same run directory, both are append-only NDJSON, both are
 * opened `O_APPEND | O_NOFOLLOW`, and both survive a kill with everything
 * before the last line intact. Ruling 70's reason for NDJSON applies unchanged:
 * a truncated last line costs one refusal, not the whole ledger.
 *
 * AND IT IS WRITTEN THROUGH THE SINK (ruling 65), which is why the append
 * primitive is a PARAMETER here rather than an `fs` call. `Sink.append` already
 * carries the `O_APPEND | O_NOFOLLOW`, the non-regular-file refusal, the
 * truncated-tail handling and the newline refusal — and, decisively, it redacts
 * the composed line. Ruling 65 names "the sink being bypassed" as the most
 * likely way redaction fails in practice, and `src/secrets/audit.ts`'s ratchet
 * caught this file doing exactly that on its first draft: a private `writeSync`
 * beside a comment explaining why it was careful. The comment was true and the
 * file was still a second writer.
 *
 * A COUNT, NOT A DIAGNOSIS. The line records which run, which item, when, and
 * the pid — and deliberately not the argv. The argv of a process spawned inside
 * a worker can carry anything the model typed, including a value ruling 65's
 * inventory in the ORCHESTRATOR's process has never seen and therefore cannot
 * redact out of a file this process writes. So the ledger carries only fields
 * brigadier itself generated. The report says how many workers tried; it does
 * not say which sentence in which file persuaded them, because guessing that
 * would mean parsing somebody else's conventions file for intent.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKER_MARKER, workerIdentity } from "../agent/marker.ts";
import { RUN_DIR } from "../repo/layout.ts";

/**
 * Where the run root is, for a process that is not the orchestrator.
 *
 * A second variable rather than a longer marker value, because the marker is
 * ruling 59's identity and `src/run/marker.ts` parses the command-line form of
 * the same `<run-id>/<item>` shape. Widening either to carry a filesystem path
 * would put a path with slashes in it through two parsers that split on the
 * last slash.
 */
export const RUN_ROOT_ENV = "BRIGADIER_RUN_ROOT";

export const REFUSAL_LEDGER = "refusals.ndjson";

/** Beside `record.ndjson` and `record.json`, in the run directory ruling 61 places. */
export function refusalLedgerPath(runRoot: string, runId: string): string {
  return join(runRoot, RUN_DIR, runId, REFUSAL_LEDGER);
}

export interface RefusedDelegation {
  at: number;
  runId: string;
  /** The item whose worker spawned the process that tried to delegate. */
  item: number;
  /** The subcommand that was refused — `run`, `plan`. From a fixed set, never free text. */
  command: string;
  /** The refusing process's own pid. brigadier generated nothing else it may safely record. */
  pid: number;
}

/** What `recordRefusal` did, so a caller can say it out loud rather than guess. */
export type RefusalRecording =
  /** Not inside a worker at all: there is nothing to refuse and nothing to record. */
  | { kind: "not-a-worker" }
  /**
   * Inside a worker whose marker is ruling 57's bare boolean, or with no run
   * root in the environment. The refusal still stands; it has nowhere to land.
   */
  | { kind: "no-home"; why: string }
  | { kind: "recorded"; path: string; entry: RefusedDelegation }
  /** The append failed. The refusal still stands — see `refuseAndRecord`'s contract. */
  | { kind: "unwritable"; path: string; why: string };

/**
 * Append one refusal to the run that spawned this process's ancestor.
 *
 * NEVER THROWS, and that is the contract rather than defensiveness. This runs
 * on the path where brigadier has already decided to refuse, and a refusal that
 * turns into a crash because a ledger was unwritable would replace a clean
 * `exit 3` — the thing bar item 9 actually measured — with a stack trace. The
 * count is the lesser fact; the refusal is the guard.
 */
/**
 * The one write primitive this module is allowed, supplied by the caller.
 *
 * Structural rather than an import of `Sink`, so nothing here can reach the
 * filesystem on its own and `src/secrets/audit.ts`'s scan has nothing to find.
 * The only implementation in the product is `Sink.append`.
 */
export interface RefusalAppender {
  append(path: string, line: string): void;
}

export function recordRefusal(
  command: string,
  sink: RefusalAppender,
  env: Record<string, string | undefined> = process.env,
  pid: number = process.pid,
  at: number = Date.now(),
): RefusalRecording {
  const identity = workerIdentity(env);
  if (identity === null) {
    const marker = env[WORKER_MARKER];
    if (marker === undefined || marker === "" || marker === "0") return { kind: "not-a-worker" };
    return {
      kind: "no-home",
      why:
        `${WORKER_MARKER} is ${JSON.stringify(marker)}, which is ruling 57's boolean rather than ` +
        "ruling 59's `<run-id>/<item>` identity. The refusal stands; there is no record to append it to.",
    };
  }
  const runRoot = env[RUN_ROOT_ENV];
  if (runRoot === undefined || runRoot === "") {
    return {
      kind: "no-home",
      why: `${RUN_ROOT_ENV} is unset, so this process cannot find run ${identity.runId}'s directory.`,
    };
  }

  const path = refusalLedgerPath(runRoot, identity.runId);
  const entry: RefusedDelegation = { at, runId: identity.runId, item: identity.item, command, pid };
  try {
    // `JSON.stringify` escapes every newline inside a string, so one entry is
    // one line and the only partial line a reader can ever see is the last —
    // the same property `src/run/record.ts` relies on for the same reason.
    sink.append(path, JSON.stringify(entry));
    return { kind: "recorded", path, entry };
  } catch (error) {
    return { kind: "unwritable", path, why: error instanceof Error ? error.message : String(error) };
  }
}

export interface RefusalTally {
  count: number;
  /** Which items' workers tried. Ascending, deduped — a worker may try twice. */
  items: number[];
  /** A line present but unparseable. One kill costs one refusal, never the ledger. */
  damagedLines: number;
}

/**
 * What the ledger says, read once at the end of the run.
 *
 * An absent ledger is zero refusals and not an error: the common case is a run
 * in which nothing tried to delegate, and a missing file is exactly what that
 * looks like. `refusedDelegationLine(0)` returns `null`, so zero refusals
 * produces no line at all — which is the negative control that keeps the line
 * from being wallpaper.
 */
export function readRefusals(path: string): RefusalTally {
  const tally: RefusalTally = { count: 0, items: [], damagedLines: 0 };
  if (!existsSync(path)) return tally;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return tally;
  }
  const items = new Set<number>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      tally.damagedLines++;
      continue;
    }
    const entry = parsed as Partial<RefusedDelegation>;
    if (typeof entry.runId !== "string" || !Number.isInteger(entry.item)) {
      tally.damagedLines++;
      continue;
    }
    tally.count++;
    items.add(entry.item as number);
  }
  tally.items = [...items].sort((a, b) => a - b);
  return tally;
}
