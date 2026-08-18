// SPDX-License-Identifier: Apache-2.0
/**
 * How much brigadier is allowed to say, and to whom.
 *
 * Ruling 58. The governing asymmetry is one sentence:
 *
 *     Progress is free when a human reads it and expensive when a model does.
 *
 * A terminal is ephemeral and a person watches it. An ACP client is a UI — #48
 * measured Zed rendering a `plan` as a task list with concurrent `tool_call`
 * rows, tolerating a 285-second turn and holding a permission open 195 s. But
 * under decision 25 the product is HOST-FIRST, where brigadier's stdout lands
 * in a model's context window and every byte is a permanent charge against the
 * window the owner is working in.
 *
 * The arithmetic that decides the cap is entirely from existing measurements:
 *
 *   #14   ~46 KB of agent→client traffic for a ONE-LINE change, both vendors
 *   ×10   a five-item fan-out with one retry each  =>  ~460 KB
 *   /4    ~115,000 tokens — and #23 measured chars/4 underestimating a real
 *         artifact by 22%, so this is a FLOOR
 *   #46   Copilot's measured context window: 128,000 tokens
 *
 * One five-item run would consume roughly 90% of the smallest measured host
 * window if worker transcripts reached it. Nobody proposed sending transcripts;
 * the point is the order of magnitude — the cost of being careless here is the
 * whole session.
 */

export type Audience =
  /** A person watches; scrollback is free. Stream. */
  | "terminal"
  /**
   * An editor renders it. Stream — but progress must RE-SEND the stable `plan`:
   * #48 measured `plan_update` is UNSTABLE and Zed silently ignores it,
   * producing a display that was not stale but actively wrong.
   */
  | "acp-client"
  /** A model reads it, and pays for it forever. Hard cap. */
  | "host-session";

/**
 * The hard ceiling on a run report into a host session, in tokens.
 *
 * DERIVED, NOT PICKED: ruling 39 settled ~2K as what a per-run artifact may
 * cost, calling the repo map "a cheap lottery ticket with a large payout". That
 * makes it this project's own benchmark for per-run token spend, and a report
 * that costs more than the repo map while carrying less information is not
 * defensible.
 *
 * Recorded honestly: the 115,000-token floor above is a measurement; this
 * ceiling is an argument from precedent.
 */
export const HOST_REPORT_TOKEN_CEILING = 2_000;

/** Ruling 58 truncates to fit. This is a ceiling, not a target. */
export function isCapped(audience: Audience): boolean {
  return audience === "host-session";
}

/**
 * What is left of the ceiling for the report, given what the process already
 * put on the same stdout.
 *
 * THE CEILING IS ON THE CHANNEL, NOT ON ONE ARTIFACT. MEASURED on 2026-08-18
 * against `bun 1.3.14`: a fifty-item host run printed 3,682 tokens against this
 * 2,000-token ceiling while `run-report.ts` was inside its budget the whole
 * time — 1,648 of them were the admission block, written first and counted
 * against nothing. Every byte on that stdout lands in the same context window
 * and is charged once, so the budget the report may spend is the ceiling MINUS
 * what was already spent, and a budget that governs only the last thing written
 * is not a budget.
 *
 * Never negative: a prologue that has already exceeded the ceiling leaves zero,
 * the report keeps only its blocking items, and it says out loud that it is
 * over. Ruling 52 has no exception for space at any level.
 */
export function remainingBudget(alreadySpent: number): number {
  return Math.max(0, HOST_REPORT_TOKEN_CEILING - Math.max(0, alreadySpent));
}

/**
 * How many tokens a piece of text will cost the reader, with the correction
 * that makes the number honest.
 *
 * `chars/4` is the usual rule of thumb and #23 MEASURED it underestimating a
 * real artifact by 22%. A budget checked with a formula known to be too small
 * is a budget that passes reports it should not, so the correction is applied
 * rather than noted somewhere and forgotten. Still an estimate: the only exact
 * answer is the reader's own tokeniser, which brigadier does not have.
 *
 * RE-EXPORTED RATHER THAN RE-IMPLEMENTED. This module had its own copy —
 * `Math.ceil((text.length / 4) * 1.22)`, the same arithmetic with the two
 * numbers inlined — written at the same time as `src/repomap/tokens.ts`. Two
 * copies of one estimate is one retuning away from a report and a repo map
 * disagreeing about what a token costs, and the report's ceiling is the half
 * that would silently pass. `tokens.ts` is the one with the measurement behind
 * it and with `CHARS_PER_TOKEN` and `UNDERCOUNT_CORRECTION` named, so it is the
 * one that survives; it imports nothing, so nothing of the map comes with it.
 */
export { estimateTokens } from "../repomap/tokens.ts";

/**
 * Is there anything to show while the run is in flight?
 *
 * `false` for a host session, and that is the honest answer rather than a
 * limitation to work around. brigadier's stdout lands in the model's context as
 * ONE BLOCK when the process exits — there is no stream, so periodic progress
 * would be paying tokens for an animation nobody watches.
 *
 * Decision 25 already recorded that brigadier cannot PROMPT the operator in
 * host-first. It cannot report progress either, and both come from the same
 * fact about the channel.
 */
export function hasInFlightDisplay(audience: Audience): boolean {
  return audience !== "host-session";
}

/**
 * Ruling 58's collapse rule, which is ruling 52's rendering rule seen from the
 * other end.
 *
 * Ruling 52: under space pressure print fewer ITEMS, never fewer CHECKS. So a
 * capped report may drop a passing item, and may never drop an item carrying a
 * blocking check.
 *
 * The property, stated so a test can hold it: THE CAP CAN HIDE A SUCCESS AND
 * CAN NEVER HIDE A FAILURE.
 */
export interface ItemLine {
  index: number;
  blocking: boolean;
  line: string;
}

export interface CappedReport {
  shown: ItemLine[];
  /** Passing items that collapsed. Rendered as a count, never silently dropped. */
  collapsed: number;
}

export function capItems(items: readonly ItemLine[], maxLines: number): CappedReport {
  const blocking = items.filter((i) => i.blocking);
  if (blocking.length >= maxLines) {
    // Never drop a blocking item to fit a budget. Ruling 52 has no exception
    // for space, and a budget that could suppress a failure would be worse than
    // no budget at all.
    return { shown: blocking, collapsed: items.length - blocking.length };
  }
  const passing = items.filter((i) => !i.blocking);
  const room = maxLines - blocking.length;
  const kept = passing.slice(0, room);
  return {
    shown: [...blocking, ...kept].sort((a, b) => a.index - b.index),
    collapsed: passing.length - kept.length,
  };
}
