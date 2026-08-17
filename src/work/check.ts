// SPDX-License-Identifier: Apache-2.0
/**
 * The outcome of a check, and the rule that only one of its values is a pass.
 *
 * Ruling 52. v1 produced three separate failures here and they were one bug
 * three times — an absent result rendered as a satisfied requirement:
 *
 *   - a reviewer hit a turn limit, `review: not run (REVIEWER_FAILED)`, and the
 *     most delicate change of the build merged entirely unreviewed;
 *   - an injected ENOENT on the test command produced "approved, tests_pass
 *     skipped", rendered as `(approved by codex)`;
 *   - a killed gate decayed into an ordinary skipped gate and the slice
 *     committed with verification that never ran.
 *
 * Nothing about reviewers or ENOENT is load-bearing. The shape is that the type
 * had two values and reality had four. So there are four, and three of them
 * block — the same sentence BAR.md already says about a tag ("a SKIPPED item
 * blocks a tag exactly as a FAIL does"), one level down at a single change.
 *
 * The four are distinct because their REMEDIES are distinct. Collapsing `error`
 * into `fail` sends a builder to fix a defect that is not in its code and burns
 * a rung of ruling 24's ladder doing it; collapsing `not-run` into `fail` sends
 * a worker to fix a command that does not exist.
 */

export type CheckOutcome =
  /** Ran, and was satisfied. The only affirmative value. */
  | "pass"
  /** Ran, and was not satisfied. The worker's to fix — ruling 24's ladder. */
  | "fail"
  /** The CHECKER broke: a crash, a turn limit, a kill. Re-run the checker. */
  | "error"
  /** Never started. The operator's environment; no retry helps. */
  | "not-run"
  /**
   * Never configured, so there is no check.
   *
   * Deliberately NOT blocking — a first-time user with no verify command must
   * still get a product that runs. That makes this the value most likely to
   * become v1's bug wearing a different noun, so ruling 52 gives it the same
   * treatment as the blocking ones: it is printed in the same slot with the
   * same prominence. The difference between an unmet requirement and an absent
   * one is real; the difference in how loudly they print is not.
   */
  | "unconfigured";

/**
 * The initial value of every blocking check's slot, written to the run record
 * BEFORE the check runs.
 *
 * This is the whole fix for v1's third failure. Write-ahead means a crash
 * between "started" and "finished" leaves a *blocking* value rather than an
 * absent field, so there is no code path that produces "no result". v1's abort
 * decayed into a skip because the skip was where the absence landed; here
 * absence has nowhere to land.
 */
export const INITIAL_OUTCOME: CheckOutcome = "not-run";

/** Ruling 52: `pass` proceeds, `unconfigured` does not block, everything else does. */
export function blocks(outcome: CheckOutcome): boolean {
  return outcome !== "pass" && outcome !== "unconfigured";
}

export interface CheckResult {
  /** What was checked, as the operator would name it: `verify`, `review`, `ownership`. */
  name: string;
  outcome: CheckOutcome;
  /**
   * A qualifier that lives INSIDE the rendered result and never in a footnote —
   * `review: pass (same-vendor)`. v1's compact output was truthful in its detail
   * view and false in its summary, and people read summaries.
   */
  qualifier?: string;
  /** The checker's own words. On `error` and `not-run` this is the remedy. */
  detail?: string;
}

/** `pass` is the only affirmative glyph in the vocabulary. Nothing else resembles a tick. */
const GLYPH: Record<CheckOutcome, string> = {
  pass: "✓",
  fail: "✗",
  error: "!",
  "not-run": "—",
  unconfigured: "—",
};

/** One check, rendered. Never abbreviated away — see `renderChecks`. */
export function renderCheck(result: CheckResult): string {
  const qualifier = result.qualifier ? ` (${result.qualifier})` : "";
  return `${GLYPH[result.outcome]} ${result.name}: ${result.outcome}${qualifier}`;
}

/**
 * Every check, always.
 *
 * Ruling 52 bans the compact form that reduced v1's output to
 * `(approved by codex)`: under space pressure a report prints fewer ITEMS,
 * never fewer CHECKS. There is deliberately no `limit` parameter here for a
 * caller to reach for.
 */
export function renderChecks(results: readonly CheckResult[]): string {
  return results.map(renderCheck).join("\n");
}

/**
 * Ruling 52, and ruling 51's partial-integration rule, and ruling 32's standing
 * rule — which are all the same rule: a weakened or skipped check never renders
 * as a pass, so a run with any blocking check outstanding cannot report success.
 */
export function succeeded(results: readonly CheckResult[]): boolean {
  return !results.some((r) => blocks(r.outcome));
}
