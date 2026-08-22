// SPDX-License-Identifier: Apache-2.0
/**
 * Who decides an item gets an adversarial review, and what brigadier may do
 * about that decision.
 *
 * D7, D17 and D19, which amend ruling 67. What was there before: `--review` is a
 * flag a caller passes, and **nothing decided whether a review was warranted** —
 * a human or a host model did, by typing a flag.
 *
 * **D7 — the planner decides per item, and its judgement is the default.**
 * **D17 — the decision CLAMPS, in ruling 67's shape**: brigadier may override
 * *toward* review and never away from it.
 *
 * **WHY ONE-WAY.** Ruling 67 built the same shape for `difficulty` and named the
 * reason: the error is asymmetric. An unnecessary review costs one turn on a
 * different vendor; a skipped review that was needed ships a defect into the
 * operator's integration branch. And the input is self-serving — a planner that
 * could set `review: false` has been handed a way to make its own plan cheaper
 * to be wrong about.
 *
 * **D19 — NO REVIEW GLOBS, AND BRIGADIER NEVER REQUIRES A VERIFY COMMAND.**
 * Nothing here pushes the operator toward having tests, nothing warns them for
 * not having them, and a repository with no test suite is a normal repository.
 * The obvious floor — *"review anything under `src/auth/`"* — needs a
 * maintained list per repository, and the list is wrong the day somebody moves a
 * directory. So the floor is **ruling 67's existing structural input: owned-path
 * count and bytes changed.** It needs no tests, no settings and no list, and a
 * planner cannot inflate it to dodge review without giving up fan-out, because
 * ruling 14 rejects two items claiming one path.
 */

/**
 * The structural facts the floor is computed from. Both are ruling 67's own
 * inputs, and neither can be supplied by a model.
 */
export interface Structure {
  /** How many paths this item claims. Ruling 14 makes these disjoint across items. */
  readonly paths: number;
  /** Bytes the item's diff actually changed. Measured after the work, not declared. */
  readonly bytes: number;
}

/**
 * Where the floor sits.
 *
 * **JUDGEMENTS, NOT MEASUREMENTS, and they are printed beside every override
 * they cause** — the same discipline ruling 81's exploration floor carries and
 * `BAR.md` applies to its own contribution budget.
 *
 * They are anchored rather than invented. Ruling 14 rejects two items claiming
 * one path, so an item claiming FOUR OR MORE paths is one whose author declined
 * a fan-out it could have had; that is a coordination-shaped change, and
 * coordination-shaped changes are where a reviewer earns its turn. The byte
 * threshold is one order of magnitude above the ~2 KB a repo map is budgeted at
 * (ruling 39), which is this project's own unit for *"a substantial artifact"*.
 */
export const REVIEW_FLOOR_PATHS = 4;
export const REVIEW_FLOOR_BYTES = 20_000;

export interface ClampInput {
  /** D7: what the planner said. `undefined` where no planner ran (`--plan`). */
  readonly planner: boolean | undefined;
  /** The operator's `--review`, which forces review on for the whole run. */
  readonly operator: boolean;
  readonly structure: Structure;
}

export interface ClampResult {
  readonly review: boolean;
  /** One line, D24's form, carrying WHY — ruling 52 keeps a qualifier inside the result. */
  readonly why: string;
  /** True when brigadier overrode the planner. Tracked per repository (D17). */
  readonly overridden: boolean;
}

/**
 * Decide, clamping only upward.
 *
 * Read the order: the operator wins, then the structural floor, then the
 * planner, then the default. There is no branch anywhere below that turns a
 * `true` into a `false`, and that absence is the ruling.
 */
export function clampReview(input: ClampInput): ClampResult {
  if (input.operator) {
    return { review: true, why: "review: yes — you asked for it with `--review`", overridden: false };
  }

  const { paths, bytes } = input.structure;
  const overFloor = paths >= REVIEW_FLOOR_PATHS || bytes >= REVIEW_FLOOR_BYTES;
  if (overFloor) {
    const reason =
      paths >= REVIEW_FLOOR_PATHS
        ? `it claims ${paths} paths (floor ${REVIEW_FLOOR_PATHS})`
        : `it changed ${bytes} bytes (floor ${REVIEW_FLOOR_BYTES})`;
    // The clamp fires whether the planner said no or said nothing, and it says
    // which — an operator reading "brigadier overrode the planner" needs to know
    // there was a planner to override.
    const overridden = input.planner === false;
    return {
      review: true,
      why:
        `review: yes — ${overridden ? "the planner said no and brigadier overrode it TOWARD review" : "brigadier's floor"}, ` +
        `because ${reason}. That floor is a judgement, not a measurement, and it is structural: no globs, no test ` +
        "suite required, nothing a plan can inflate without giving up fan-out (D19).",
      overridden,
    };
  }

  if (input.planner === true) {
    return { review: true, why: "review: yes — the planner asked for one, and its judgement is the default (D7)", overridden: false };
  }
  if (input.planner === false) {
    return {
      review: false,
      why: "review: no — the planner said so and nothing structural overrides it (D7, D17)",
      overridden: false,
    };
  }
  return {
    review: false,
    why: "review: no — no planner ran and nothing structural asks for one; `--review` forces it (D17)",
    overridden: false,
  };
}

/**
 * D17's other half: *"the `review: false` rate is tracked against each
 * repository's own history."*
 *
 * Ruling 67's distribution check, pointed at a different field. It reports a
 * departure and does not block — the same choice ruling 67 made about
 * `difficulty`, for the same reason: a repository legitimately full of one-file
 * changes has a high no-review rate and is not misbehaving.
 *
 * **A NEW REPOSITORY HAS NO HISTORY**, which is ruling 67's own accepted cost
 * arriving a third time: the mechanism aimed at the real failure is the one that
 * takes longest to become useful. Said out loud rather than papered over — with
 * too few runs this returns nothing at all rather than a comparison against
 * noise.
 */
export const MIN_RUNS_FOR_HISTORY = 5;

export function noReviewDeparture(
  history: readonly number[],
  thisRun: number,
): string | undefined {
  if (history.length < MIN_RUNS_FOR_HISTORY) {
    return undefined;
  }
  const mean = history.reduce((sum, rate) => sum + rate, 0) / history.length;
  // Twenty points, a judgement, printed with the number it is comparing.
  if (thisRun - mean < 0.2) return undefined;
  return (
    `this run declined review on ${Math.round(thisRun * 100)}% of items against this repository's own average of ` +
    `${Math.round(mean * 100)}% over ${history.length} runs (D17). Reported, not blocked: a repository full of ` +
    "one-file changes legitimately has a high no-review rate."
  );
}
