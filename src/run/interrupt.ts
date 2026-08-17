// SPDX-License-Identifier: Apache-2.0
/**
 * What the first interrupt does, what the second does, and why the second one
 * re-raises rather than exits.
 *
 * Ruling 63. v1's rule, kept and sharpened: **registering a signal handler
 * disables default termination, so it is a duty, not a feature.** The duty is
 * to give the default behaviour back on demand — which is what `SIG_DFL` plus a
 * re-raise actually is, and what `process.exit(130)` only imitates.
 *
 * The difference matters to whoever is above us. A re-raised signal produces a
 * genuine signal-terminated status, which a parent shell reports as such, a CI
 * runner attributes correctly, and a supervisor can distinguish from an
 * ordinary non-zero exit. A hand-picked exit code is a number we made up that
 * happens to look like one.
 */

export type InterruptPhase =
  /** Nothing is in flight. v1's rule: exit immediately, with the signal's status. */
  | "idle"
  /** First interrupt: cancel, then kill, then sweep — under a deadline. */
  | "draining"
  /** Second interrupt: restore the default handler and re-raise. */
  | "abandoning";

/**
 * Cancellation is a courtesy, and the deadline is the mechanism.
 *
 * `session/cancel` is an ACP NOTIFICATION — #6's four-method surface gives us
 * nothing to await — so there is no acknowledgement and no way to know an agent
 * heard it. And the deadline cannot be generous: #48 measured a real client
 * tolerating a 285-second turn and holding a permission open 195 s, so "wait
 * for the agent to finish" is not a bounded wait.
 *
 * After this, the process group / job object is killed and ruling 38's sweep
 * runs. Some agents will be killed mid-write, which ruling 63 accepts.
 */
export const CANCEL_DEADLINE_MS = 5_000;

export interface InterruptState {
  phase: InterruptPhase;
  /** Signals seen, in order. The second of the same signal abandons. */
  received: NodeJS.Signals[];
}

export function initialState(inFlight: boolean): InterruptState {
  return { phase: inFlight ? "draining" : "idle", received: [] };
}

/**
 * What to do about this signal, given what has already happened.
 *
 * `idle` is deliberately terminal on the first signal: there is nothing to
 * clean up, and a handler that delays there is pure downside.
 */
export function onSignal(state: InterruptState, signal: NodeJS.Signals): InterruptState {
  const received = [...state.received, signal];
  if (state.phase === "idle") return { phase: "abandoning", received };
  if (state.phase === "draining" && state.received.length > 0) {
    return { phase: "abandoning", received };
  }
  return { phase: state.phase, received };
}

/**
 * Restore the default handler and re-raise, so the exit status is the signal's
 * own rather than one we invented.
 *
 * Nothing is cleaned up here. That is not negligence: ruling 52 writes every
 * check slot BEFORE the check runs and ruling 58 writes the full record before
 * anything is summarised, so the record already says what was in flight. There
 * is nothing left to write that would be more true than what is on disk.
 */
export function abandon(signal: NodeJS.Signals, raise: (s: NodeJS.Signals) => void): void {
  process.removeAllListeners(signal);
  raise(signal);
}

/**
 * Ruling 63's promise about a run that could not be finished cleanly: four
 * facts, none of them a reassurance.
 *
 * The pid list is the one v1 could not produce. Ruling 38 requires every
 * process brigadier causes to exist to carry a marker in its COMMAND LINE —
 * never a name pattern — because the sweep has nothing to match on otherwise;
 * that same marker is what lets this name the exact processes rather than
 * saying "something may still be running".
 */
export interface UnfinishedRun {
  landed: number[];
  didNotLand: number[];
  /** Kept until the operator discharges them. Ruling 63 splits this from ruling 38's sweep. */
  retainedClones: Array<{ item: number; path: string; bytes: number }>;
  /** Ruling 38's marker is what makes these nameable. Killing them is the owner's only remedy. */
  unconfirmedPids: number[];
}

export function describeUnfinished(run: UnfinishedRun): string[] {
  const lines = [
    `${run.landed.length} item(s) landed: ${run.landed.join(", ") || "none"}`,
    `${run.didNotLand.length} did not: ${run.didNotLand.join(", ") || "none"}`,
  ];
  if (run.retainedClones.length > 0) {
    const bytes = run.retainedClones.reduce((sum, c) => sum + c.bytes, 0);
    // Reported because otherwise it grows invisibly — #19 measured ~67 MB
    // incremental per clone.
    lines.push(
      `${run.retainedClones.length} clone(s) retained, ${(bytes / 1024 ** 2).toFixed(0)} MB — not merged, not reviewed, not deleted`,
    );
    for (const clone of run.retainedClones) lines.push(`  item ${clone.item}: ${clone.path}`);
  }
  if (run.unconfirmedPids.length > 0) {
    lines.push(
      `could not confirm dead: pid ${run.unconfirmedPids.join(", ")} — killing them is the only remedy`,
    );
  }
  return lines;
}
