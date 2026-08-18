// SPDX-License-Identifier: Apache-2.0
/**
 * Partial integration is a first-class outcome, and it never renders as
 * success.
 *
 * This is forced rather than chosen. Ruling 51 says integration CONTINUES past
 * a conflicted or rejected item — one bad item does not cost nine good ones —
 * so "some of it landed" is a state a run can end in, and it is the state a
 * report is most likely to round off. #6 measured that ACP's `stopReason`
 * carries five values, none of which is a partial success and none of which is
 * "needs human". So the run report is the AUTHORITY and `stopReason` is
 * DECORATION, and the two must not be read the other way round: a turn that
 * ended normally says nothing about whether the work integrated.
 *
 * The rendering rules are ruling 52's, one level up:
 *
 *   - every check prints, always. Under space pressure a report prints fewer
 *     ITEMS, never fewer CHECKS — `renderChecks` has no `limit` parameter for a
 *     caller to reach for, and neither does this;
 *   - the per-item gates and the merged-result gate print in separate sections,
 *     so "every item passed" can never stand in for "the merged result passed";
 *   - the headline is computed from the checks, not passed in. A headline a
 *     caller can choose is a headline that will one day say "done".
 */

import { blocks, renderChecks, succeeded, type CheckResult } from "../work/check.ts";
import type { WaveIntegration } from "./integrate.ts";

export interface RunOutcome {
  waves: readonly WaveIntegration[];
  /** One per wave, in wave order. Ruling 52's write-ahead value if it never ran. */
  gates: readonly CheckResult[];
}

/**
 * Success is the conjunction of every check in the run, per-item AND
 * merged-result.
 *
 * Delegated to `succeeded` rather than reimplemented, so that ruling 52's "only
 * `pass` is affirmative, `unconfigured` does not block, everything else does"
 * has exactly one definition in this codebase.
 */
export function runSucceeded(outcome: RunOutcome): boolean {
  return succeeded([...outcome.waves.flatMap((wave) => wave.checks), ...outcome.gates]);
}

export interface Tally {
  integrated: number;
  noChange: number;
  rejected: number;
  conflicted: number;
  notAttempted: number;
  total: number;
}

export function tally(waves: readonly WaveIntegration[]): Tally {
  const counts: Tally = {
    integrated: 0,
    noChange: 0,
    rejected: 0,
    conflicted: 0,
    notAttempted: 0,
    total: 0,
  };
  for (const wave of waves) {
    for (const item of wave.items) {
      counts.total++;
      if (item.outcome === "integrated") counts.integrated++;
      else if (item.outcome === "no-change") counts.noChange++;
      else if (item.outcome === "rejected") counts.rejected++;
      else if (item.outcome === "conflicted") counts.conflicted++;
      else counts.notAttempted++;
    }
  }
  return counts;
}

/**
 * The one line an operator reads first, and the word "success" is not available
 * to it unless every check passed.
 *
 * v1's compact output was truthful in its detail view and false in its summary,
 * and people read summaries.
 */
export function headline(outcome: RunOutcome): string {
  const counts = tally(outcome.waves);
  const gateBlocked = outcome.gates.filter((gate) => blocks(gate.outcome));
  const landed = counts.integrated + counts.noChange;

  if (counts.total === 0) return "nothing to integrate: this run had no items";

  const reasons: string[] = [];
  if (counts.rejected > 0) {
    reasons.push(`${counts.rejected} rejected for writing outside their declared paths`);
  }
  if (counts.conflicted > 0) reasons.push(`${counts.conflicted} conflicted`);
  if (counts.notAttempted > 0) reasons.push(`${counts.notAttempted} never attempted`);
  if (gateBlocked.length > 0) {
    reasons.push(`the merged result is ${gateBlocked.map((gate) => gate.outcome).join(", ")}`);
  }

  if (landed === 0) {
    return (
      `NOTHING INTEGRATED — 0 of ${counts.total} items landed on the integration branch; ` +
      `${reasons.join("; ")}.`
    );
  }
  if (landed < counts.total || gateBlocked.length > 0) {
    return (
      `PARTIAL INTEGRATION — ${landed} of ${counts.total} items landed; ${reasons.join("; ")}. ` +
      "This is not a success, and it is not a failure: it is the state the run ended in."
    );
  }
  // A VERIFICATION CLAIM IS DERIVED FROM A `pass` THAT HAPPENED, never from the
  // absence of a failure. With `gates: []`, or an all-`no-change` wave and an
  // `unconfigured` gate — reachable whenever nothing was published — the older
  // wording printed "and the merged result was verified" over a run in which
  // nothing was verified and no branch was created. That is ruling 52's exact
  // bug, an absent result rendering as a satisfied requirement, in the one line
  // people actually read.
  const verified = outcome.gates.some((gate) => gate.outcome === "pass");
  if (verified) {
    return `integrated — ${landed} of ${counts.total} items landed, and the merged result was verified`;
  }
  const why =
    outcome.gates.length === 0
      ? "no integration gate was recorded for this run"
      : `the merged result is ${outcome.gates.map((gate) => gate.outcome).join(", ")}`;
  return (
    `${landed} of ${counts.total} items landed, and THE MERGED RESULT WAS NOT VERIFIED — ${why}`
  );
}

/**
 * The whole report.
 *
 * The branch is named in full every time, because it is the deliverable and
 * because it is the one ref an operator can act on: `git switch`, an editor's
 * branch picker, `gh pr create`. The invisible machinery refs are named only
 * where an item needs inspecting.
 */
export function renderRun(outcome: RunOutcome): string {
  const lines: string[] = [headline(outcome)];
  for (const wave of outcome.waves) {
    lines.push("");
    lines.push(
      `wave ${wave.wave} — ${wave.base.slice(0, 12)} → ${wave.head.slice(0, 12)}` +
        `${wave.published ? ` published at ${wave.branch}` : " (nothing published)"}`,
    );
    lines.push(renderChecks(wave.checks));
    for (const item of wave.items) {
      if (item.outcome === "conflicted" || item.outcome === "rejected") {
        lines.push(`    item ${item.item}: ${item.detail ?? ""}`);
        lines.push(`    inspect it at ${item.ref}`);
      } else if (item.outcome === "not-attempted") {
        lines.push(`    item ${item.item}: ${item.detail ?? ""}`);
      }
    }
  }
  lines.push("");
  // Its own section, and it is not optional. Ruling 52's `unconfigured` prints
  // here at the same size as a failure.
  lines.push("the merged result:");
  lines.push(renderChecks(outcome.gates));
  for (const gate of outcome.gates) {
    // Ruling 52: `unconfigured` prints its detail here too. It does not block,
    // and that is the only difference it gets — the difference between an unmet
    // requirement and an absent one is real, and the difference in how loudly
    // they print is not.
    if (gate.detail !== undefined && gate.outcome !== "pass") lines.push(`    ${gate.detail}`);
  }
  return lines.join("\n");
}
