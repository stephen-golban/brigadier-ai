// SPDX-License-Identifier: Apache-2.0
/**
 * What a plan will probably cost, as a RANGE, with its provenance attached.
 *
 * Ruling 66. A single number here would be a lie with a decimal point on it,
 * and the measurement that settles it is #44: two IDENTICAL Codex runs produced
 * 427,723 and 28,245 bytes of agent→client traffic — a 15× spread on identical
 * input. Published tooling independently puts real cost at 3–5× naive
 * estimates. So the estimate is an interval, the interval's width is a
 * measured property of the process rather than a hedge, and the provenance
 * travels with the number so a reader can argue with the arithmetic instead of
 * believing it.
 *
 * THE UNIT IS TOKENS, NOT MONEY, and that is a refusal rather than an
 * omission. Converting tokens to currency needs a per-model rate, this
 * repository has never measured one, and ruling 70's whole subject is a number
 * that reads as more certain than it is. A dollar figure derived from an
 * unmeasured rate would be exactly that. When a rate is measured this module
 * gains a second unit; until then it reports the thing it can actually count.
 *
 * RULING 70, and the sentence it exists to prevent: *the 16.5× cache lever was
 * active* must never be readable as *this run saved 16.5×*. So levers are
 * reported as levers — a list of mechanisms that were switched on — and the
 * report carries an explicit disclaimer in the same block. brigadier cannot
 * observe a vendor's cache hit rate over ACP (#46 measured that three of six
 * agents emit no usage at all), so it does not have the number it would need to
 * make the claim even if it wanted to.
 *
 * AND OPENCODE IS UNPRICEABLE. #42 measured it reaching a model with NO
 * credential at all through its own gateway, so a successful turn proves
 * nothing about which account was billed. A run that used it reports
 * `unpriceable` for that vendor and its total as a LOWER BOUND.
 */

import type { PlannedItem } from "./plan.ts";

/**
 * #14: ~46 KB of agent→client traffic for a ONE-LINE change, on both vendors.
 *
 * The floor for one item's turn, in bytes. Named rather than inlined because it
 * is a measurement and the next person to touch it needs to know it is one.
 */
export const MEASURED_ITEM_BYTES = 46 * 1024;

/**
 * #23 measured `chars/4` underestimating a real artifact by 22%.
 *
 * Applied rather than ignored: an estimate checked with a formula known to be
 * too small is an estimate that passes runs it should not.
 */
export const CHARS_PER_TOKEN = 4;
export const NAIVE_CORRECTION = 1.22;

/** Published tooling puts real cost at 3–5× naive estimates; #44 measured 15× between two runs. */
export const SPREAD_LOW = 1;
export const SPREAD_HIGH = 5;

export interface Estimate {
  /** Tokens, not currency. See the module header for why that is a refusal. */
  unit: "tokens";
  low: number;
  high: number;
  provenance: string;
  /** Ruling 70: true when a vendor in this run cannot be priced at all. */
  lowerBound: boolean;
  levers: string[];
}

/** The naive floor for one item, before the spread is applied. */
export function naiveItemTokens(): number {
  return Math.ceil((MEASURED_ITEM_BYTES / CHARS_PER_TOKEN) * NAIVE_CORRECTION);
}

/**
 * The upper bound for ONE item, which is the number every ceiling is sized
 * against.
 *
 * Ruling 66: predict as a range and trigger on the UPPER bound. #44 measured
 * 427,723 against 28,245 bytes on two identical Codex runs — 15× on identical
 * input — so an in-flight item's remaining cost is not knowable and the widest
 * thing it could still become is the only safe figure to reserve for.
 */
export function itemCeilingReserve(): number {
  return naiveItemTokens() * SPREAD_HIGH;
}

/**
 * What a run has ACTUALLY spent so far, from bytes that were counted on the
 * wire.
 *
 * THE SOURCE IS THE WIRE, NEVER `usage_update`, and that is a measurement
 * rather than a preference. #46 measured `usage_update` arriving from three of
 * six agents at all, and the drive measured something worse: `used` PLATEAUED
 * FOR FIVE TURNS while the agent rewrote its history — the field MASKS
 * compaction. Reading that plateau as "these turns were cheap" reports a run's
 * most expensive turns as its cheapest, and a ceiling driven off it would let a
 * run through exactly when it should stop. Bytes counted as they cross the
 * channel cannot plateau while work is happening.
 *
 * The conversion is `chars/4` with #23's measured +22% correction, the same
 * arithmetic as the estimate — deliberately, so `actual` and `estimateHigh` are
 * comparable numbers rather than two units wearing one name. It is still an
 * ESTIMATE of tokens from bytes: the only exact answer is the vendor's own
 * tokeniser, which brigadier does not have and #46 measured half the fleet
 * never reporting.
 */
export function tokensFromBytes(bytes: number): number {
  return Math.ceil((bytes / CHARS_PER_TOKEN) * NAIVE_CORRECTION);
}

/**
 * Ruling 66's structural requirement on the two ceilings, checked BEFORE
 * anything is spent.
 *
 * *The gap between them must exceed the most expensive item that could be in
 * flight, or the soft ceiling never prevents the hard one firing.* The soft
 * ceiling stops new dispatch and lets in-flight items finish; if those items
 * can still spend more than the remaining gap, the hard ceiling fires anyway
 * and cancels work that was already allowed to complete — which makes the soft
 * ceiling a line in a report rather than a control.
 *
 * `workers` is in the arithmetic because "the most expensive item that could be
 * in flight" is a fleet of them: with W concurrent workers, W items are still
 * running when the soft ceiling trips.
 *
 * Returns the refusal, or `null` when the pair is usable. A refusal here costs
 * nothing — no clone, no process — which is the whole of ruling 53's ordering
 * promise applied to the one control ruling 66 calls primary.
 */
export function ceilingRefusal(
  soft: number | undefined,
  hard: number | undefined,
  workers: number,
): string[] | null {
  if (soft === undefined || hard === undefined) return null;
  const concurrent = Math.max(1, workers);
  const reserve = itemCeilingReserve() * concurrent;
  if (hard - soft > reserve) return null;
  return [
    `--soft-ceiling ${soft.toLocaleString("en-US")} and --hard-ceiling ${hard.toLocaleString("en-US")} ` +
      `leave a gap of ${(hard - soft).toLocaleString("en-US")} ${"tokens"}, and up to ${concurrent} item(s) can be`,
    `  in flight when the soft ceiling trips. Each of them can still spend ${itemCeilingReserve().toLocaleString("en-US")} tokens`,
    `  (${MEASURED_ITEM_BYTES} bytes per #14, widened ${SPREAD_HIGH}× because #44 measured 15× between two`,
    `  identical runs), so the reserve that has to fit in the gap is ${reserve.toLocaleString("en-US")}.`,
    "  Ruling 66: the soft ceiling stops NEW items and lets in-flight ones finish; the hard ceiling",
    "  cancels work already running. With a gap this narrow the hard ceiling fires anyway and the",
    "  soft one is a line in a report rather than a control.",
    `  Remedy: raise --hard-ceiling above ${(soft + reserve).toLocaleString("en-US")}, or lower --soft-ceiling.`,
  ];
}

/**
 * Ruling 70's levers, as levers.
 *
 * Each entry names a MECHANISM that is switched on for this run. None of them
 * is a quantity, and that is deliberate: a quantity beside a lever is the
 * sentence ruling 70 forbids, one comma away.
 */
export function activeLevers(items: readonly PlannedItem[], workers: number): string[] {
  const levers = [
    "byte-stable brief prefix (rulings 16 and 21): every item's brief opens with the same bytes, " +
      "which is the shape ruling 21 recorded a 16.5× prompt-cache lever on. Whether any vendor " +
      "cached it is not observable over ACP",
    `one worker per item and no agent pipeline: ${workers} concurrent, against ruling 21's ranking of ` +
      '"don\'t spawn" as the first lever',
  ];
  if (items.some((item) => item.kind === "read-only")) {
    levers.push(
      "read-only items use a pooled directory rather than a fresh clone (ruling 49), measured at " +
        "~1–3 s against 6.06 s to clone (#19)",
    );
  }
  return levers;
}

/**
 * The disclaimer, in the same block as the levers.
 *
 * It carries the words "makes no claim" on the same line as the word a reader
 * would scan for, because ruling 70 is about what a skimmed line says and a
 * footnote is not in the same block.
 */
export const NO_SAVINGS_CLAIM =
  "brigadier makes no claim to have saved anything: the lines above say which levers were " +
  "active, not what this run would otherwise have cost.";

export function estimatePlan(
  items: readonly PlannedItem[],
  workers: number,
  vendors: readonly string[] = [],
): Estimate {
  const perItem = naiveItemTokens();
  const attempted = items.length;
  const unpriceable = vendors.includes("opencode");
  return {
    unit: "tokens",
    low: perItem * attempted * SPREAD_LOW,
    high: perItem * attempted * SPREAD_HIGH,
    provenance:
      `provenance: ${MEASURED_ITEM_BYTES} bytes of agent→client traffic per item (#14, a ONE-LINE ` +
      `change on both vendors), read as tokens at chars/${CHARS_PER_TOKEN} with #23's measured +22% ` +
      `correction applied, times ${attempted} item(s), widened to ${SPREAD_LOW}–${SPREAD_HIGH}× because ` +
      "published tooling puts real cost at 3–5× naive estimates and #44 measured 15× between two " +
      "identical Codex runs. A single number here would be a lie with a decimal point on it.",
    lowerBound: unpriceable,
    levers: activeLevers(items, workers),
  };
}

/** The estimate, rendered. The range is a range on the page as well as in the type. */
export function describeEstimate(estimate: Estimate): string[] {
  const lines = [
    `estimate   ${estimate.low.toLocaleString("en-US")} – ${estimate.high.toLocaleString("en-US")} ${estimate.unit}`,
    `  ${estimate.provenance}`,
    "  the unit is tokens rather than money: converting to currency needs a per-model rate and",
    "  this build has never measured one, so a dollar figure would be exactly the false precision",
    "  ruling 70 is about.",
  ];
  if (estimate.lowerBound) {
    lines.push(
      "  opencode is in this run's vendor set, so the total is a LOWER BOUND and that vendor is",
      "  unpriceable: #42 measured it reaching a model with no credential at all through its own",
      "  gateway, so a successful turn proves nothing about which account was billed.",
    );
  }
  lines.push("  levers active:");
  for (const lever of estimate.levers) lines.push(`    - ${lever}`);
  lines.push(`  ${NO_SAVINGS_CLAIM}`);
  return lines;
}
