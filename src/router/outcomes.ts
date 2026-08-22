// SPDX-License-Identifier: Apache-2.0
/**
 * What actually happened, per (vendor, work kind) — and the seam that keeps it
 * away from cost.
 *
 * Ruling 81 overturns ruling 23's separation **for outcomes only**, on ruling
 * 23's own reason rather than against it. Ruling 23 separated the paths because
 * *"a prediction is falsifiable, a competence score is editorial"* — and **an
 * outcome is falsifiable.** Whether item 3 passed its gate, how many rungs the
 * ladder took, and whether the reviewer rejected it are facts about what
 * happened, not editorials about what a vendor is like.
 *
 * **COST STAYS BARRED, and the measurement is why.** #44 measured **15×
 * variance in output bytes between two identical runs**, and ruling 66 already
 * made the ceiling the primary control precisely because the estimate cannot
 * gate. A cost-derived competence score would rank vendors by noise. Ruling 67
 * rejected a cost-based veto on the same grounds hours after ruling 66 was made;
 * this is the third time that measurement has decided something.
 *
 * **THIS FILE IS A THIRD PATH AND MUST STAY ONE.** The obvious way to defeat
 * ruling 81 is to put the outcome store next to the cost store and let the
 * router import both, so `scripts/forbidden-imports.ts` gains an entry saying
 * this module may not import anything under a `cost` directory either. Ruling 81 moves a
 * `bun run claims` gate by **adding** to it, never by relaxing it.
 *
 * Ruling 68's standing rule — *"no number in the competence table may be
 * compared against a number derived from `difficulty`"* — is joined by a second
 * of the same shape: **no number here may be derived from cost.** There is
 * deliberately no field on `Observation` that could hold one.
 */

import type { WorkKind } from "../work/kind.ts";

/** One item's ending, as facts rather than as a judgement about a vendor. */
export interface Observation {
  readonly agent: string;
  readonly kind: WorkKind;
  /** Did the item's own gate pass? Ruling 52's outcome, not an opinion. */
  readonly passed: boolean;
  /** How many rungs of ruling 24's ladder it took. 1 is first-attempt. */
  readonly rungs: number;
  /** Did a reviewer reject it? `undefined` where no review ran (ruling 52's `unconfigured`). */
  readonly reviewerRejected?: boolean;
}

/** What the store holds for one (agent, kind), and nothing more. */
export interface Tally {
  readonly attempts: number;
  readonly passed: number;
  readonly rungs: number;
  readonly reviewed: number;
  readonly rejected: number;
}

const EMPTY: Tally = { attempts: 0, passed: 0, rungs: 0, reviewed: 0, rejected: 0 };

export function tallyKey(agent: string, kind: WorkKind): string {
  return `${agent}/${kind}`;
}

export function accumulate(into: ReadonlyMap<string, Tally>, observation: Observation): Map<string, Tally> {
  const out = new Map(into);
  const key = tallyKey(observation.agent, observation.kind);
  const before = out.get(key) ?? EMPTY;
  out.set(key, {
    attempts: before.attempts + 1,
    passed: before.passed + (observation.passed ? 1 : 0),
    rungs: before.rungs + observation.rungs,
    reviewed: before.reviewed + (observation.reviewerRejected === undefined ? 0 : 1),
    rejected: before.rejected + (observation.reviewerRejected === true ? 1 : 0),
  });
  return out;
}

/**
 * How many observations before a tally may move a ranking at all.
 *
 * **A JUDGEMENT, and it is printed beside every ranking it affects**, the same
 * discipline ruling 81 requires of the exploration floor. Three, because two
 * cannot distinguish a vendor that fails from a vendor that failed once, and a
 * larger floor would make the mechanism aimed at the real failure the one that
 * takes longest to become useful — ruling 67's accepted cost, which ruling 81
 * inherits and which this bounds rather than fixes.
 */
export const MIN_OBSERVATIONS = 3;

/**
 * The learned adjustment for one (agent, kind), or nothing.
 *
 * **Deliberately an ADJUSTMENT and not a score.** Ruling 68 keeps the competence
 * table hand-maintained and auditable from the binary; a learned number that
 * replaced a hand-maintained one would make `brigadier competence` print
 * something no reader could check against the source. So this returns a delta
 * the ranking applies on top, and `provenance` below is what makes the delta
 * visible where the number is.
 */
export function adjustment(tally: Tally | undefined): number | undefined {
  if (tally === undefined || tally.attempts < MIN_OBSERVATIONS) return undefined;
  const passRate = tally.passed / tally.attempts;
  const rejectRate = tally.reviewed === 0 ? 0 : tally.rejected / tally.reviewed;
  // Bounded to ±10 on a 0–100 scale: an outcome record is evidence about this
  // machine and this repository, and letting it dominate a table built from
  // benchmarks and measurements would be the editorial/falsifiable confusion
  // running the other way.
  return Math.round((passRate - 0.5) * 20 - rejectRate * 10);
}

/**
 * Where a number came from, for `brigadier competence`.
 *
 * Ruling 81's accepted cost #1: *"a learned column has a provenance a reader
 * cannot check by eye"*, and ruling 68's auditability is weakened at exactly
 * this seam unless the command prints where each number came from — **and from
 * how many observations.** So the string carries the count.
 */
export function provenance(tally: Tally | undefined): string {
  if (tally === undefined || tally.attempts === 0) return "hand-maintained (no observations here)";
  if (tally.attempts < MIN_OBSERVATIONS) {
    return `hand-maintained (${tally.attempts} observation(s), below the ${MIN_OBSERVATIONS} needed to move a ranking)`;
  }
  const delta = adjustment(tally) ?? 0;
  return `hand-maintained ${delta >= 0 ? "+" : ""}${delta} learned from ${tally.attempts} observation(s) on this machine`;
}

/**
 * The sentence that has to travel with any learned number.
 *
 * Ruling 81's accepted cost #2, which no arithmetic can fix: an item can fail
 * because the plan was bad, the gate was flaky, or the repository was hostile.
 * The learning loop cannot tell those apart and charges the vendor for all of
 * them.
 */
export const OUTCOME_CAVEAT =
  "an outcome is attributed to a vendor and the vendor is not the only cause: an item can fail because the " +
  "plan was bad, the gate was flaky or the repository was hostile, and this cannot tell those apart (ruling 81)";
