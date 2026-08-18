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
 * How a rung that is not `different-vendor` renders, in a reader's words.
 *
 * The machine-readable name is the `RungDistance` and it stays in the record.
 * This is what goes in the report, because `same-vendor-different-model` is a
 * type name and `same-vendor, model changed` is a sentence — and ruling 52's
 * whole complaint about v1's output is that its summary was skimmable and
 * false. A reader who skims must land on *same-vendor* rather than on a token
 * they parse as jargon and move past.
 */
export const RUNG_QUALIFIER: Record<RungDistance, string> = {
  "different-vendor": "different vendor",
  "same-vendor-different-model": "same-vendor, model changed",
  "same-vendor-different-effort": "same-vendor, effort changed",
  "same-triple": "same-vendor, same triple",
};

/**
 * What actually happened to the ladder.
 *
 * FOUR OUTCOMES, and a two-value field would collapse them into one:
 *
 *   both rungs, cross-vendor        `attempts 2 of 2`
 *   both rungs, same vendor         `attempts 2 of 2 (same-vendor, model changed)`
 *   only one rung on this machine   `attempts 1 of 1 — no second rung: …`
 *   the rung existed, not taken     `attempt 2 not taken — budget ceiling`
 *
 * The third and fourth are the pair v1 merged into "failed after retries". A
 * ladder that ran out and a ladder that never had a second step are different
 * facts about the machine, only one of them is the operator's fault, and under
 * ruling 53 the second is knowable at plan ADMISSION, before anything is spent.
 *
 * `of` is separate from `attempts` because the ordinary success — one attempt
 * taken on a machine that had two rungs — is `attempts 1 of 2`, and rendering
 * that as `attempts 1 of 1` would claim a short ladder on a machine that has a
 * full one.
 */
export type LadderOutcome =
  | { kind: "completed"; attempts: number; of: number; distance: RungDistance }
  /** Ruling 53: computed over the whole ladder at validation, and said up front. */
  | { kind: "short"; attempts: number; reason: string }
  /** Ruling 23's ceiling. NOT the same as having tried twice. */
  | { kind: "budget-capped"; attempts: number; reason?: string };

/**
 * Ruling 52's rendering rule: the qualifier lives inside the result string,
 * never in a footnote, because v1's output was truthful in its detail view and
 * false in its summary and people read summaries.
 */
export function renderLadder(outcome: LadderOutcome): string {
  switch (outcome.kind) {
    case "completed":
      return outcome.distance === "different-vendor"
        ? `attempts ${outcome.attempts} of ${outcome.of}`
        : `attempts ${outcome.attempts} of ${outcome.of} (${RUNG_QUALIFIER[outcome.distance]})`;
    case "short":
      return `attempts ${outcome.attempts} of ${outcome.attempts} — no second rung: ${outcome.reason}`;
    case "budget-capped":
      return `attempt ${outcome.attempts + 1} not taken — ${outcome.reason ?? "budget ceiling"}`;
  }
}

/**
 * How many rungs this machine offers, read off the outcome rather than
 * recomputed by every caller.
 *
 * The record's `attemptsAvailable` comes from here, and the point of it being
 * one function is ruling 55's sharp half: a MISSING rung must never be recorded
 * as an EXHAUSTED one, and a fact each caller re-derives is a fact one caller
 * gets wrong.
 */
export function rungsOffered(outcome: LadderOutcome): number {
  switch (outcome.kind) {
    case "completed":
      return outcome.of;
    case "short":
      return outcome.attempts;
    case "budget-capped":
      return outcome.attempts + 1;
  }
}

/**
 * The ladder AS ONE ITEM GOT IT, from the ladder the machine offered.
 *
 * Ruling 55's "say which rung it actually got". The admission-time outcome says
 * what was available; this says what was spent, and the two are printed in
 * different places on purpose — admission before anything is spent, this beside
 * the item afterwards.
 *
 * Nothing here may raise `attempts` on account of a reviewer. Ruling 52's budget
 * rule: the builder's ladder is charged to the item's budget and a broken
 * reviewer's re-run is charged to brigadier, because a builder must not lose a
 * rung to somebody else's failure.
 */
export function ladderTaken(offered: LadderOutcome, attempts: number): LadderOutcome {
  if (offered.kind === "short") return { kind: "short", attempts, reason: offered.reason };
  if (offered.kind === "budget-capped") {
    return { kind: "budget-capped", attempts, ...(offered.reason === undefined ? {} : { reason: offered.reason }) };
  }
  return { kind: "completed", attempts, of: offered.of, distance: offered.distance };
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

/**
 * The ladder as it is stated AT ADMISSION, before anything is spent.
 *
 * Separate from `renderLadder` because the two answer different questions and
 * ruling 55's finding-87 half is about the order in which they are asked. This
 * one says what the MACHINE offers — `2 rungs`, or `no second rung` with the
 * reason — and it is printed by `--dry-run` and by the head of every run. The
 * other says what one item SPENT, and it is printed beside that item afterwards.
 *
 * v1 discovered a short ladder after an attempt was already gone, which is a
 * cost paid for a fact that was knowable from `PATH` alone.
 */
export function renderLadderOffered(outcome: LadderOutcome): string {
  switch (outcome.kind) {
    case "completed":
      return (
        `${outcome.of} rungs — attempt 1, then a fresh clone with a ${RUNG_QUALIFIER[outcome.distance]}` +
        (outcome.distance === "different-vendor"
          ? ""
          : ". Ruling 24 asked for a different vendor; this machine cannot offer one, and the rung says so")
      );
    case "short":
      return renderLadder(outcome);
    case "budget-capped":
      return renderLadder(outcome);
  }
}
