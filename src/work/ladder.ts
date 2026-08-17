// SPDX-License-Identifier: Apache-2.0
/**
 * The retry ladder's second rung, and the four things a report must be able to
 * say about it.
 *
 * Ruling 24 said the second attempt gets a fresh clone and a DIFFERENT VENDOR.
 * Ruling 32 then made a one-vendor machine a supported and common
 * configuration, which turned that rule into a special case. Ruling 55
 * generalises it: "a different vendor" becomes "the most different triple
 * available", preferring vendor over model over effort.
 *
 * The generalisation is honest only because rung 2's value splits in two:
 *
 *   A FRESH CONTEXT — the attempt does not inherit the first's confusion. This
 *   owes nothing to the vendor and survives a single-vendor machine entirely.
 *
 *   A DIFFERENT FAILURE MODE — a different vendor fails differently. This is
 *   the half that attenuates, by however far the triple actually moved.
 *
 * Without that split the ordering below reads as a consolation prize. With it,
 * each rung is a specific claim about which half you still have.
 */

/**
 * How far the second attempt's triple moved from the first's.
 *
 * Ordered best to worst. The qualifier a report prints comes from here and is
 * mandatory: `attempts 2 of 2` alone cannot tell a reader whether a second
 * vendor was ever involved, and that line will be skimmed.
 */
export type RungDistance =
  /** Ruling 24's original, and still the best. */
  | "different-vendor"
  /**
   * Genuinely different failure modes, and measured available on both bridged
   * vendors by different levers: Codex returns 33 models and `set_model` moves
   * the backend for real (ruling 40, #45); Claude returns `models: null`, so
   * the lever is spawn-time `ANTHROPIC_MODEL`, verified with a negative
   * control (#2).
   */
  | "same-vendor-different-model"
  /**
   * Weak, and on Claude close to vacuous. Ruling 40 measured
   * `MAX_THINKING_TOKENS` as a switch rather than a dial — 0 ⇒ 768 median
   * output tokens, 4000 ⇒ 2744, 32000 ⇒ 2836, an 8× budget for a 3% median
   * change with fully overlapping ranges. So this rung has TWO states on Claude
   * and thirty-three-ish on Codex, and one word for both would be one word for
   * two different products.
   */
  | "same-vendor-different-effort"
  /**
   * The weakest, and not theatre: #44 measured two identical Codex runs
   * producing 427,723 and 28,245 bytes — a 15× spread on identical input — so
   * re-rolling a high-variance process is a real strategy. Offered under budget
   * rather than by default, and never described as more than it is.
   */
  | "same-triple";

export const RUNG_PREFERENCE: RungDistance[] = [
  "different-vendor",
  "same-vendor-different-model",
  "same-vendor-different-effort",
  "same-triple",
];

/**
 * What actually happened to the ladder.
 *
 * Four values, because v1 would have merged the last two into "failed after
 * retries". A ladder that ran out and a ladder that never had a second step are
 * different facts about the machine — and under ruling 53 the second is
 * knowable at plan admission, before anything is spent.
 */
export type LadderOutcome =
  | { kind: "completed"; attempts: number; distance: RungDistance }
  /** Ruling 53: computed over the whole ladder at validation, and said up front. */
  | { kind: "short"; attempts: number; reason: string }
  /** Ruling 23's ceiling. NOT the same as having tried twice. */
  | { kind: "budget-capped"; attempts: number };

/**
 * Ruling 52's rendering rule: the qualifier lives inside the result string,
 * never in a footnote, because v1's output was truthful in its detail view and
 * false in its summary and people read summaries.
 */
export function renderLadder(outcome: LadderOutcome): string {
  switch (outcome.kind) {
    case "completed":
      return outcome.distance === "different-vendor"
        ? `attempts ${outcome.attempts} of ${outcome.attempts}`
        : `attempts ${outcome.attempts} of ${outcome.attempts} (${outcome.distance})`;
    case "short":
      return `attempts ${outcome.attempts} of ${outcome.attempts} — no second rung: ${outcome.reason}`;
    case "budget-capped":
      return `attempt ${outcome.attempts + 1} not taken — budget ceiling`;
  }
}

/**
 * Pick the second rung from what this machine actually has.
 *
 * `null` means the ladder is short, which is a fact about the machine and is
 * reported at admission rather than discovered when the first attempt fails.
 */
export function chooseRung(available: readonly RungDistance[]): RungDistance | null {
  for (const rung of RUNG_PREFERENCE) {
    if (available.includes(rung)) return rung;
  }
  return null;
}
