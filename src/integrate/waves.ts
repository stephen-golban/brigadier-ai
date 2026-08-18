// SPDX-License-Identifier: Apache-2.0
/**
 * Waves, and why a wave boundary is a gate boundary.
 *
 * Ruling 54. Wave 1 clones from ruling 50's base commit; wave N+1 clones from
 * the integration commit wave N produced, which is the whole of "wave 2 sees
 * its prerequisite's output". Everything else here exists to make one v1
 * failure impossible rather than fixed: v1 ran a dependent slice against a
 * prerequisite that had not landed and **reported both slices ok**.
 *
 * Three rules, and each of them removes a way to produce that report:
 *
 *   1. A cycle is rejected at PLAN VALIDATION. Not detected during execution,
 *      where the symptom is items that never become eligible and a run that
 *      stops early with nothing to say. This is the session's habit of finding
 *      out before spending — ruling 52 resolves the verify command on PATH
 *      before spawning, ruling 53 computes eligibility over the whole ladder at
 *      plan validation, ruling 61 refuses a path budget before cloning.
 *
 *   2. An item whose prerequisite did not integrate is NEVER ATTEMPTED, and its
 *      checks stay at ruling 52's write-ahead `not-run`, which BLOCKS. Not
 *      `skipped`, which does not exist in that vocabulary for exactly this
 *      reason: v1's absent result rendered as a satisfied requirement.
 *
 *   3. Wave N+1 does not start until the integration gate has run on wave N's
 *      partial commit and did not block. Wave N+1 clones from that commit; a
 *      wave that builds on an unverified base is a wave whose failures cannot
 *      be attributed.
 */

import { blocks, INITIAL_OUTCOME, type CheckResult } from "../work/check.ts";

export interface WaveItem {
  /** 1-based, and it is the clone's directory name. */
  item: number;
  /** Item numbers this one must see the output of. */
  dependsOn?: readonly number[];
}

export class CyclicPlan extends Error {
  constructor(readonly unresolved: readonly number[]) {
    super(
      "ruling 54: this plan's dependsOn graph has a cycle, so no wave order exists — " +
        `items ${unresolved.join(", ")} can never become eligible. Rejected at plan ` +
        "validation, because the alternative is a run that starts, integrates nothing and " +
        "cannot say why.",
    );
    this.name = "CyclicPlan";
  }
}

export class UnusablePlan extends Error {
  constructor(message: string) {
    super(`ruling 54: ${message}`);
    this.name = "UnusablePlan";
  }
}

/**
 * The plan, in waves.
 *
 * Kahn's algorithm, with the leftover set reported as the cycle — the leftover
 * IS the cycle plus everything downstream of it, and naming all of it is more
 * useful to an operator than naming the shortest loop.
 */
export function planWaves(items: readonly WaveItem[]): number[][] {
  const numbers = new Set<number>();
  for (const item of items) {
    if (!Number.isInteger(item.item) || item.item < 1) {
      throw new UnusablePlan(`unusable item number: ${item.item}`);
    }
    if (numbers.has(item.item)) throw new UnusablePlan(`item ${item.item} appears twice`);
    numbers.add(item.item);
  }
  for (const item of items) {
    for (const dependency of item.dependsOn ?? []) {
      if (dependency === item.item) throw new UnusablePlan(`item ${item.item} depends on itself`);
      if (!numbers.has(dependency)) {
        throw new UnusablePlan(
          `item ${item.item} depends on item ${dependency}, which this plan does not contain`,
        );
      }
    }
  }

  const remaining = new Map(items.map((item) => [item.item, new Set(item.dependsOn ?? [])]));
  const waves: number[][] = [];
  const done = new Set<number>();
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, dependencies]) => [...dependencies].every((d) => done.has(d)))
      .map(([number]) => number)
      .sort((a, b) => a - b);
    if (ready.length === 0) throw new CyclicPlan([...remaining.keys()].sort((a, b) => a - b));
    for (const number of ready) {
      remaining.delete(number);
      done.add(number);
    }
    waves.push(ready);
  }
  return waves;
}

export interface Attemptable {
  /** Items whose every prerequisite integrated. */
  run: number[];
  /** Items that are never attempted, with the prerequisites that did not integrate. */
  blocked: Array<{ item: number; missing: number[] }>;
}

/**
 * Which of this wave's items may be attempted, given what has integrated.
 *
 * Transitive without needing to be: a blocked item never integrates, so its own
 * dependents are blocked by the same test in the next wave. There is no code
 * path where "blocked" decays into "ran".
 */
export function attemptable(
  wave: readonly number[],
  items: readonly WaveItem[],
  integrated: ReadonlySet<number>,
): Attemptable {
  const dependencies = new Map(items.map((item) => [item.item, item.dependsOn ?? []]));
  const result: Attemptable = { run: [], blocked: [] };
  for (const number of wave) {
    const missing = [...(dependencies.get(number) ?? [])].filter((d) => !integrated.has(d));
    if (missing.length === 0) result.run.push(number);
    else result.blocked.push({ item: number, missing });
  }
  return result;
}

/**
 * The check an unattempted item carries.
 *
 * `not-run` is ruling 52's write-ahead value and it BLOCKS, which is the
 * point: this is the slot v1's "both slices ok" came out of, and here the
 * absence has nowhere else to land.
 */
export function prerequisiteCheck(item: number, missing: readonly number[]): CheckResult {
  return {
    name: `integrate item ${item}`,
    outcome: INITIAL_OUTCOME,
    qualifier: "prerequisite did not integrate",
    detail:
      `item ${item} was never attempted: item${missing.length === 1 ? "" : "s"} ` +
      `${missing.join(", ")} did not integrate, so the base it would have cloned from does ` +
      "not contain the work it depends on. Re-running it against a base without its " +
      "prerequisite would produce work reviewed against a state that never existed.",
  };
}

export interface WaveBoundary {
  proceed: boolean;
  reason: string;
}

/**
 * Ruling 54's boundary: the next wave starts only if the integration gate on
 * this wave's partial commit did not block.
 *
 * `unconfigured` does not block — ruling 52 is explicit that a first-time user
 * with no verify command must still get a product that runs — and the reason
 * string says so, in the same slot and with the same prominence, because the
 * difference between an unmet requirement and an absent one is real and the
 * difference in how loudly they print is not.
 */
export function waveBoundary(wave: number, gate: CheckResult): WaveBoundary {
  if (blocks(gate.outcome)) {
    return {
      proceed: false,
      reason:
        `wave ${wave + 1} does not start: the integration gate on wave ${wave}'s commit is ` +
        `${gate.outcome}${gate.qualifier === undefined ? "" : ` (${gate.qualifier})`}. Wave ` +
        `${wave + 1} would clone from that commit, so every result it produced would be ` +
        "measured against a base brigadier could not verify.",
    };
  }
  return {
    proceed: true,
    reason:
      `wave ${wave}'s integration gate is ${gate.outcome}` +
      `${gate.outcome === "unconfigured" ? " — no verify command is configured, which ruling 52 does not treat as a failure" : ""}`,
  };
}
