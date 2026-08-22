// SPDX-License-Identifier: Apache-2.0
/**
 * Which vendor gets which item.
 *
 * D6, D20 and ruling 81, and the defect they replace is one line:
 * `src/queue/execute.ts` read `options.admission.agents[0]` and gave **every
 * item of every run to the first agent on the list.** A five-item fan-out on a
 * three-vendor machine ran five claude workers, and nothing said so. That is the
 * monoculture D20 records the objection to — *"the objection was never to
 * ranking, it was to a monoculture"* — arriving through the other door.
 *
 * Three rules, in the order they apply:
 *
 * **1. SPREAD FIRST (D6).** *"Assignment spreads across distinct vendors first,
 * then reuses — so three items on three vendors get one each, and three items on
 * a claude-only machine get three claude workers."* A single-vendor machine
 * keeps its parallelism; a three-vendor machine stops being a one-vendor machine
 * by accident.
 *
 * **2. BEST OF WHAT IS LEFT (D20).** Within the vendors still unused this round,
 * the highest-ranked one wins. Ranking is not the enemy of spreading — it
 * decides which vendor takes the next item, while spreading decides how many any
 * one vendor may take.
 *
 * **3. AN EXPLORATION FLOOR, MANDATORY (ruling 81).** *"Every capable vendor
 * keeps receiving some work regardless of score"*, or a single early failure
 * entrenches itself — v1's finding 87, a model scored 85 silently excluded from
 * every `hard` item. Ruling 67 refused v1's numeric score floors for that exact
 * reason, and this must not reintroduce silent exclusion through the other door.
 *
 * **WHY THE FLOOR IS NOT RANDOM.** Ruling 81 asks for a share, and a share is
 * usually implemented by rolling a die. A die makes a run unreproducible, and
 * this repository has spent two sessions on measurements that were only readable
 * because the same input produced the same behaviour. So the floor is a
 * DETERMINISTIC STRIDE: every Nth item goes to the vendor the ranking did not
 * pick, where N is `1/floor`. Same distribution over a run, same run twice.
 */

import type { WorkKind } from "../work/kind.ts";
import { adjustment, provenance, tallyKey, type Tally } from "./outcomes.ts";

/** A vendor that could take this item, with the ranking's own number. */
export interface Candidate {
  readonly id: string;
  /** The hand-maintained score. `undefined` is ruling 68's UNRANKED — eligible, sorts last. */
  readonly score: number | undefined;
}

export interface AssignmentInput {
  readonly items: readonly { readonly number: number; readonly kind: WorkKind }[];
  readonly candidates: readonly Candidate[];
  /** Ruling 81's learned column, keyed by `tallyKey`. Empty on a new machine. */
  readonly outcomes: ReadonlyMap<string, Tally>;
  /** Ruling 81's floor, from config. Printed beside the ranking it protects. */
  readonly explorationFloor: number;
}

export interface Assignment {
  readonly item: number;
  readonly agent: string;
  /** Why this vendor, in one line — D24's form, and ruling 52's no-footnotes rule. */
  readonly why: string;
}

/**
 * Assign every item, in one pass, deterministically.
 *
 * Returns an empty list when there are no candidates rather than throwing: a
 * machine with no drivable vendor is refused at admission, long before this, and
 * a second refusal here would be a second place for that message to live.
 */
export function assign(input: AssignmentInput): Assignment[] {
  const candidates = [...input.candidates];
  if (candidates.length === 0 || input.items.length === 0) return [];

  const out: Assignment[] = [];
  // D6: the vendors not yet used in this pass. Refilled when it empties, which
  // is what makes a claude-only machine run three claude workers rather than
  // stalling — "then reuses" is a real clause, not a fallback.
  let unused = new Set(candidates.map((candidate) => candidate.id));
  const stride = strideFor(input.explorationFloor);
  let placed = 0;

  for (const item of input.items) {
    if (unused.size === 0) unused = new Set(candidates.map((candidate) => candidate.id));
    const pool = candidates.filter((candidate) => unused.has(candidate.id));
    const ranked = rankFor(pool, item.kind, input.outcomes);
    const best = ranked[0] as Candidate;

    // Ruling 81's floor. `placed` counts items, not rounds, so the stride is
    // even across a whole run rather than clustering at the start of each round.
    const exploring = stride !== undefined && placed % stride === stride - 1 && ranked.length > 1;
    const picked = exploring ? (ranked[ranked.length - 1] as Candidate) : best;

    out.push({
      item: item.number,
      agent: picked.id,
      why: exploring
        ? `exploration floor ${input.explorationFloor} — every ${stride}th item goes to a vendor the ranking did ` +
          `not pick, so an early failure cannot entrench itself (ruling 81). ${describe(picked, item.kind, input.outcomes)}`
        : `best of ${pool.length} vendor(s) not yet used this round (D6, D20). ${describe(picked, item.kind, input.outcomes)}`,
    });
    unused.delete(picked.id);
    placed += 1;
  }
  return out;
}

/**
 * Every Nth item explores, or never.
 *
 * A floor of 0 disables it, and that is the operator's to set — ruling 81 makes
 * the floor mandatory as a MECHANISM, and an operator who turns theirs to zero
 * has made a choice the config records, rather than the code having no floor.
 * Above 1 is meaningless and clamps to every item.
 */
export function strideFor(floor: number): number | undefined {
  if (!Number.isFinite(floor) || floor <= 0) return undefined;
  return Math.max(2, Math.round(1 / Math.min(floor, 1)));
}

/**
 * The ranking, with ruling 81's learned adjustment on top of ruling 68's
 * hand-maintained score.
 *
 * **UNRANKED SORTS LAST AND IS NOT EXCLUDED**, which is ruling 68's rule and the
 * deliberate asymmetry it names with ruling 53: *"a capability is a permission
 * and fails closed; a ranking is a preference and fails open."* Ties break on
 * the id, so a run is reproducible rather than dependent on the order a
 * directory happened to be read in.
 */
export function rankFor(
  candidates: readonly Candidate[],
  kind: WorkKind,
  outcomes: ReadonlyMap<string, Tally>,
): Candidate[] {
  return [...candidates].sort((a, b) => {
    const sa = effective(a, kind, outcomes);
    const sb = effective(b, kind, outcomes);
    if (sa !== sb) return sb - sa;
    return a.id.localeCompare(b.id);
  });
}

function effective(candidate: Candidate, kind: WorkKind, outcomes: ReadonlyMap<string, Tally>): number {
  if (candidate.score === undefined) return Number.NEGATIVE_INFINITY;
  return candidate.score + (adjustment(outcomes.get(tallyKey(candidate.id, kind))) ?? 0);
}

/** What this vendor's number is made of, said where the choice is reported. */
function describe(candidate: Candidate, kind: WorkKind, outcomes: ReadonlyMap<string, Tally>): string {
  const tally = outcomes.get(tallyKey(candidate.id, kind));
  const score = candidate.score === undefined ? "unranked" : String(candidate.score);
  return `${candidate.id} ${kind}: ${score}, ${provenance(tally)}`;
}
