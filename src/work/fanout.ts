// SPDX-License-Identifier: Apache-2.0
/**
 * How many workers may run at once, and which filter said so.
 *
 * Ruling 14 defines three independent filters and says the lowest wins and the
 * report must name it. Ruling 54 supplies the arithmetic for the feasibility
 * one, and the arithmetic is not the obvious arithmetic.
 *
 * MEASURED on the owner's machine (24 GB, 14 cores, macOS 26.5.2, 2026-08-17):
 *
 *   os.totalmem()                                    24.00 GB
 *   os.freemem()                                     1.75 GB, then 0.06 GB
 *                                                    seconds later
 *   macOS `memory_pressure`                          "free percentage: 41%"
 *   vm_stat free+inactive+speculative+purgeable      4.37 GB
 *
 * `os.freemem()` returns Mach's *pages free* alone and counts none of the
 * 4.30 GB of inactive pages the OS reclaims on demand. So the obvious
 * implementation — available memory over a per-worker budget — yields ZERO
 * workers on a machine the operating system itself calls 41% free. And two
 * readings seconds apart differed by 1.79 GB, so one sample cannot govern a run
 * that lasts minutes.
 *
 * Therefore feasibility is computed from `totalmem()`, a stable machine-shaped
 * number. **brigadier does not schedule against current load and does not
 * pretend to** — the accepted cost, stated in ruling 54, is that it will start
 * three workers on a machine that is already swapping, because it is not
 * looking.
 *
 * THERE IS DELIBERATELY NO WAY TO TELL THIS MODULE A MEMORY FIGURE FROM THE
 * ENVIRONMENT OR FROM A FLAG. Ruling 54's whole value is that the sentence the
 * report prints — *"RAM capped it: this machine's TOTAL memory leaves room for
 * N worker(s)"* — is TRUE, and an override reachable in production is an
 * override that can make it false. `totalMemoryBytes` is a parameter of this
 * module, supplied by tests and by nothing above `admit()`.
 *
 * Nor is a seam needed to exercise this branch end to end. The filter binds
 * whenever it is the STRICT MINIMUM of ruling 14's four, and two of the other
 * three are the operator's own inputs — the plan's item count and `--workers` —
 * while legality is unbounded at admission because ruling 13 has already
 * refused every colliding plan. So a plan sized ABOVE the machine makes RAM
 * bind, on the real machine, from the real number.
 * `bar/items/04-fanout-isolates.ts` drives ruling 54's third sentence that way.
 * Do not add an override here for a harness that does not need one.
 *
 * Linux and Windows have the same CLASS of problem (page cache and standby
 * lists counted as used) but are unmeasured here. Computing from `totalmem()`
 * sidesteps all three, which is a second reason to prefer it.
 */

import { totalmem } from "node:os";

/**
 * v1 measured 1–3 GB RSS per worker. The UPPER bound is the planning number:
 * under-provisioning causes swap — the map's 9.82 GB-in-20-minutes story —
 * while over-provisioning only costs concurrency. One failure is catastrophic
 * and the other is recoverable.
 */
export const WORKER_MEMORY_BYTES = 3 * 1024 ** 3;

/** Against 3.99 GB measured wired on this machine. */
export const OS_RESERVE_BYTES = 4 * 1024 ** 3;

/**
 * Ruling 21 ranks "don't spawn" as the number-one token lever — above every
 * tooling change — and a three-agent pipeline was measured at ~29,000 tokens
 * against ~10,000 single-agent. Google Research finds diminishing returns
 * beyond five and the map's own reading of it is "start at two or three".
 *
 * v1's default was 5, chosen before ruling 21 existed. This is a per-machine
 * config DEFAULT, not a limit.
 */
export const DEFAULT_DESIRABILITY_CAP = 3;

/** Which of ruling 14's filters bound the count. Never collapse these. */
export type BindingFilter =
  /** Disjoint ownership, or for `read-only` a resolvable distinct ref (ruling 49). */
  | "legality"
  /** This machine's RAM. */
  | "feasibility"
  /** The operator's per-run budget. */
  | "desirability"
  /** Nothing bound it — the plan simply had this many items. */
  | "item-count";

export interface FanOut {
  workers: number;
  boundBy: BindingFilter;
  /** Every filter's own answer, so the report can show the losing ones too. */
  candidates: Record<BindingFilter, number>;
}

export interface FanOutInputs {
  /** Items eligible to run concurrently in this wave. */
  itemCount: number;
  /** Ruling 14's legality filter: how many items may legally run at once. */
  legalityCap: number;
  /** The operator's per-run budget. Defaults to ruling 54's 3. */
  desirabilityCap?: number;
  /**
   * True when brigadier was invoked from inside a host agent session — decision
   * 25's normal case.
   *
   * This reserves a FULL per-worker budget for the host agent, and it is the
   * whole of ruling 54's closure of the map's fog item "decision 14's RAM
   * filter measures the machine while ignoring that the host agent is itself
   * consuming a large share of it". Under decision 25 the host agent is an
   * agent; it gets an agent's budget.
   */
  hostFirst: boolean;
  /** Overridable for tests. Never `freemem()` — see the module comment. */
  totalMemoryBytes?: number;
}

export function feasibilityCap(hostFirst: boolean, totalMemoryBytes = totalmem()): number {
  const reserve = OS_RESERVE_BYTES + (hostFirst ? WORKER_MEMORY_BYTES : 0);
  return Math.max(0, Math.floor((totalMemoryBytes - reserve) / WORKER_MEMORY_BYTES));
}

/**
 * Why this module refuses a number it cannot use, rather than computing with it.
 *
 * `src/cli.ts` reads `--workers` as `Number(value("workers"))` with no
 * validation, so an operator typo arrives here as `NaN`, `0`, `-1` or `2.5`.
 * Until the floor was added, `planFanOut` returned `candidates[boundBy]` and a
 * `NaN` simply never won a `<` comparison, so it was discarded by accident. The
 * floor is a `Math.min`/`Math.max` chain, and those PROPAGATE it.
 *
 * MEASURED against `bun 1.3.14` on 2026-08-20, driving this module directly:
 * `--workers abc` gave `workers: NaN`, printed `NaN worker(s) in wave 1 — RAM
 * capped it…`, and handed `NaN` to the batch cursor in
 * `src/queue/execute.ts` — which dispatches ZERO items and exits reporting
 * success. `--workers 2.5` gave `2.5 worker(s)` and a cursor that steps by 2.5.
 * A run that does nothing and reports success for it is the failure `BAR.md`
 * opens on, and it was reachable from an ordinary typo. The same gates run that
 * started this family is 32310525311.
 *
 * So: LOUD, and at the arithmetic rather than only at the caller. This is a
 * backstop — the operator-facing refusal belongs at the CLI boundary, where the
 * flag can be named and exit 2 returned — but `planFanOut` carries ruling 54
 * and a `NaN` reaching it silently is a hazard whatever any caller does. An
 * exception is unmistakable; a `NaN` answer is not.
 *
 * Coercion was rejected. Falling back to `DEFAULT_DESIRABILITY_CAP` would
 * silently ignore what the operator asked for, which is the same defect the bar
 * already records once — a run that thought it was setting ruling 54's
 * desirability filter and was quietly getting the default.
 */
function requireWholeNumber(field: string, value: number, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(
      `planFanOut: ${field} must be a whole number of at least ${minimum}, and it was ${String(value)}. ` +
        "Nothing is computed from it: a non-integer or negative count propagates through ruling 14's " +
        "lowest-wins arithmetic into the printed worker count AND the dispatch cursor, where it dispatches " +
        "nothing and reports success. If this came from `--workers`, the refusal belongs at the CLI boundary.",
    );
  }
  return value;
}

function requireFiniteBytes(field: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `planFanOut: ${field} must be a finite, non-negative byte count, and it was ${String(value)}. ` +
        "`feasibilityCap` divides by it, so a non-finite reading becomes a non-finite worker count.",
    );
  }
  return value;
}

/**
 * Ruling 14: the lowest wins, and the report names which.
 *
 * Ties resolve toward the more specific explanation — `item-count` last, so
 * "the plan only had one item" never masquerades as "RAM capped you at one".
 * Three distinct reasons to run one worker must never render as one sentence.
 */
export function planFanOut(inputs: FanOutInputs): FanOut {
  // EVERY NUMBER IS CHECKED BEFORE ANY OF IT IS USED, and this is a backstop
  // rather than the operator's error message. See `requireFanOutInput`.
  requireWholeNumber("itemCount", inputs.itemCount, 0);
  requireWholeNumber("legalityCap", inputs.legalityCap, 0);
  if (inputs.desirabilityCap !== undefined) requireWholeNumber("desirabilityCap", inputs.desirabilityCap, 1);
  if (inputs.totalMemoryBytes !== undefined) requireFiniteBytes("totalMemoryBytes", inputs.totalMemoryBytes);

  const candidates: Record<BindingFilter, number> = {
    legality: inputs.legalityCap,
    feasibility: feasibilityCap(inputs.hostFirst, inputs.totalMemoryBytes),
    desirability: inputs.desirabilityCap ?? DEFAULT_DESIRABILITY_CAP,
    "item-count": inputs.itemCount,
  };

  const order: BindingFilter[] = ["legality", "feasibility", "desirability", "item-count"];
  let boundBy = order[0]!;
  for (const filter of order) {
    if (candidates[filter] < candidates[boundBy]) boundBy = filter;
  }

  // `boundBy` is read off the RAW candidates above and is not touched by the
  // floor below. On a small host RAM really is the filter that bound the count,
  // and ruling 54 wants that said even though one worker runs: the remedy for
  // *RAM capped it* is a bigger machine, and the remedy for *the plan only had
  // one item* is a longer plan. Flooring the candidate instead of the count
  // would erase that difference — which is why the floor is applied here, to
  // the answer, and never inside `feasibilityCap`.
  return { workers: admittedWorkers(candidates), boundBy, candidates };
}

/**
 * The count a run ADMITS — which is the count it prints AND the count it
 * dispatches, because those were two different numbers and nothing noticed.
 *
 * `feasibilityCap` answers 0 on any host-first machine below about 9 GiB, and
 * `bindingSentence` renders `FanOut.workers` verbatim, so brigadier printed
 * *0 worker(s) in wave 1 — RAM capped it* and then ran one, because
 * `src/queue/execute.ts` had its own `Math.max(1, …)` at the dispatch site.
 * `src/cli.ts` defaults the audience to `host-session`, so that was stdout on
 * EVERY run on an ordinary 8 GiB laptop, not only on CI. MEASURED against `bun
 * 1.3.14` on 2026-08-20: `planFanOut({hostFirst: true, totalMemoryBytes: 7 GiB})`
 * returned `workers: 0`; the same run dispatched 1. The gates run that surfaced
 * the family is 32310525311, where the same zero made `bar/fakes/honest.ts`
 * produce a run with no items at all on both `ubuntu-latest` and `macos-latest`.
 *
 * ZERO WORKERS IS NOT A REFUSAL. It is a run that does no work and then reports
 * success for it, which is the failure `BAR.md` opens on. Refusing outright
 * would make brigadier unusable on the hardware most operators have, and ruling
 * 54's 3 GiB is the UPPER bound of v1's measured 1–3 GB per worker — chosen
 * because under-provisioning swaps — so one worker on a machine the planning
 * number says has room for none is a tight fit, not an impossible one.
 *
 * THE TWO HARD FILTERS ARE NOT FLOORED. Legality and the item count are facts
 * about the plan: a wave with no items has nothing to run, and running an item
 * that may not legally run at all would be a correctness failure rather than a
 * tight fit. Feasibility and desirability are planning numbers, and those are
 * the two this floor applies to.
 */
function admittedWorkers(candidates: Record<BindingFilter, number>): number {
  const budgets = Math.max(1, Math.min(candidates.feasibility, candidates.desirability));
  return Math.min(candidates.legality, candidates["item-count"], budgets);
}

/**
 * The concurrency a wave dispatches at. One function, so the number a reader is
 * shown and the number that runs cannot drift apart again.
 *
 * IT CANNOT RETURN A BAD NUMBER, structurally, rather than by every caller
 * remembering to clamp. The dispatch loop steps its cursor by this value, so a
 * zero would spin forever and a fraction would slice batches at fractional
 * indices — neither of which is a concurrency. `undefined`, `NaN`, `0`,
 * negatives and fractions all answer 1.
 *
 * The one place it disagrees with `planFanOut` is a wave with no items or no
 * legal items, where `planFanOut` answers 0 and this answers 1. That is not a
 * worker invented out of nothing and it is UNREACHABLE rather than merely
 * harmless: `src/queue/execute.ts` computes the width only inside a loop whose
 * body iterates `eligible.run`, so an empty eligible list runs nothing at any
 * width; and `src/queue/admit.ts` passes `LEGALITY_UNBOUNDED` for every wave,
 * because `validatePlan` has already refused the colliding plans legality would
 * otherwise have caught. Written down so the next reader does not have to
 * re-derive it — the two functions answer different questions, and the answer
 * to *how wide is a batch* must be a positive integer whatever the answer to
 * *how many items may run* turns out to be.
 */
export function dispatchWidth(fanOut: FanOut | undefined): number {
  const workers = fanOut?.workers ?? 0;
  return Number.isInteger(workers) && workers >= 1 ? workers : 1;
}
