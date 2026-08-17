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
 * Ruling 14: the lowest wins, and the report names which.
 *
 * Ties resolve toward the more specific explanation — `item-count` last, so
 * "the plan only had one item" never masquerades as "RAM capped you at one".
 * Three distinct reasons to run one worker must never render as one sentence.
 */
export function planFanOut(inputs: FanOutInputs): FanOut {
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

  return { workers: candidates[boundBy], boundBy, candidates };
}
