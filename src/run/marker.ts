// SPDX-License-Identifier: Apache-2.0
/**
 * The marker the sweep matches on: a token in the process COMMAND LINE.
 *
 * Ruling 38, and it is explicit that this is the command line and NEVER a name
 * pattern. A name pattern matches `node`, `bun`, `codex`, `sh` — every one of
 * which the operator also runs for their own reasons — so a sweep built on one
 * is a sweep that eventually kills somebody's editor. The command line is the
 * only channel that is simultaneously (a) set by brigadier at spawn, (b) visible
 * to an unrelated process reading the process table, and (c) specific enough
 * that a match is proof of provenance rather than a coincidence of names.
 *
 * Ruling 57's warning is the reason this file is separate from
 * `src/agent/marker.ts`'s `WORKER_MARKER`. There are TWO markers for two
 * purposes and conflating them breaks the sweep:
 *
 *   - `BRIGADIER_WORKER` in the ENVIRONMENT makes brigadier's own plugin inert
 *     inside a worker. A sweep scanning `ps` cannot see it.
 *   - the RUN MARKER below, in the COMMAND LINE, is what the sweep matches. A
 *     binary checking `process.env` cannot see it.
 *
 * Both are required and neither substitutes. `RUN_MARKER_FLAG` itself lives in
 * `src/agent/marker.ts` beside the other one, precisely so that the two are read
 * together; the construction and matching of the token live here, with the sweep
 * that consumes it.
 *
 * MEASURED against `ps` on macOS 26.5.2 (Darwin 25.5.0 arm64) on 2026-08-17,
 * with `bun 1.3.14`: `ps -A -o pid=,ppid=,args=` renders the FULL argv of a
 * spawned `bun run idle.ts --brigadier-run=abc123/7`, marker included, and did
 * not truncate a 1,942-character line. `-ww` made no difference to the output on
 * that host, so the plain form is what `processes.ts` uses.
 *
 * A LIMIT OF THIS MECHANISM, stated because the sweep's honesty depends on it:
 * the command line is the process's own memory. A process that rewrites its
 * argv after `exec` — or one that `exec`s something else without the marker —
 * stops matching, and no sweep reading `ps` will ever find it again. That is not
 * hypothetical for shells: `/bin/sh -c 'sleep 5'` `exec`s `sleep` and the shell's
 * argv is gone. It is why `SweepCoverage` says `not-proven` rather than
 * reporting completeness it has not earned.
 */

import { RUN_MARKER_FLAG } from "../agent/marker.ts";

/**
 * The same shape `src/repo/refs.ts` enforces on a run id, restated rather than
 * imported because that module keeps it private and a marker that could carry a
 * slash or a space would break the parse below rather than the ref namespace.
 */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What one process's command line says about which run and item it belongs to. */
export interface RunMarker {
  readonly runId: string;
  readonly item: number;
}

/**
 * The argv entry to append to EVERY process brigadier causes to exist.
 *
 * Ruling 38 says every process, and the word is load-bearing: an agent binary,
 * a verify command, a spawned shell. Anything that is not marked is a process
 * the sweep cannot see, which means it is a process nothing will reclaim.
 */
export function runMarkerArg(runId: string, item: number): string {
  if (!RUN_ID.test(runId)) throw new Error(`unusable run id for a marker: ${JSON.stringify(runId)}`);
  if (!Number.isInteger(item) || item < 1) throw new Error(`unusable item number: ${item}`);
  return `${RUN_MARKER_FLAG}=${runId}/${item}`;
}

/**
 * Anchored at a word boundary on the left and closed by `=` or whitespace on the
 * right, so that `--brigadier-runner=x` and `--not-brigadier-run=x` do not
 * match. A sweep matcher that is loose in either direction kills the wrong
 * process, and the wrong process here belongs to the operator.
 *
 * The space-separated form is accepted on READ and never produced on write:
 * argv-joining is a property of whatever spawned the process, and a matcher that
 * only understood one form would silently miss a real worker.
 */
const MARKER = new RegExp(
  `(?:^|\\s)${RUN_MARKER_FLAG.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}[=\\s]([^\\s]+)`,
);

/** Which run and item this command line belongs to, or null if it is not ours. */
export function parseRunMarker(commandLine: string): RunMarker | null {
  const match = MARKER.exec(commandLine);
  if (match === null) return null;
  const value = match[1];
  if (value === undefined) return null;
  const slash = value.lastIndexOf("/");
  if (slash <= 0) return null;
  const runId = value.slice(0, slash);
  const item = Number(value.slice(slash + 1));
  if (!RUN_ID.test(runId)) return null;
  if (!Number.isInteger(item) || item < 1) return null;
  return { runId, item };
}

/** A run id, or a run id and one item. An absent `item` means the whole run. */
export interface MarkerScope {
  readonly runId: string;
  readonly item?: number;
}

/**
 * Does this command line belong to the scope being swept?
 *
 * Exact on both fields. A sweep scoped to `run/3` must not reclaim `run/4`,
 * because ruling 49's recycle asks for evidence about ONE item and evidence
 * about a different item is not evidence about this one — which is exactly what
 * `assertReclaimed` refuses.
 */
export function markerMatches(commandLine: string, scope: MarkerScope): boolean {
  const marker = parseRunMarker(commandLine);
  if (marker === null) return false;
  if (marker.runId !== scope.runId) return false;
  return scope.item === undefined || marker.item === scope.item;
}
