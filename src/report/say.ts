// SPDX-License-Identifier: Apache-2.0
/**
 * How brigadier talks to the person, and the one rule it cannot break.
 *
 * D24, carried by ruling 80: **every user-facing message is one line.**
 *
 * The alternative that was rejected, and why the rejection is the mechanism: a
 * word list detects slop AFTER somebody writes it, and needs maintaining,
 * arguing about, and exempting. **A line form leaves nowhere to put it.** You
 * cannot write a paragraph of throat-clearing on one line and still say the
 * thing, and unlike tone it is checkable without judgement — a string containing
 * no newline is a mechanical assertion.
 *
 * So this module is the only constructor for brigadier's own user-facing
 * messages, and it REFUSES a multi-line one rather than flattening it. Flattening
 * would keep the paragraph and hide it; refusing makes the author decide which
 * fact is the one worth a line.
 *
 * **SCOPE IS THE OWNER'S OWN: output TO THE USER only.** Brigadier keeps talking
 * normally to its workhorses — a worker brief is prose and is meant to be —
 * and `AGENTS.md`, `BAR.md`, `PRODUCT.md` and the worker briefs are all out of
 * scope. So is the run REPORT's internal structure, which ruling 52 governs;
 * D24's requirement there is one line per fact, which `run-report.ts` already
 * satisfies by giving every blocking check its own line and collapsing passing
 * items to a count.
 *
 * **AND THERE IS NO LINT.** D24 declines one on purpose. The tone standard lives
 * in `AGENTS.md` and is enforced by review, which is a person; the SHAPE is
 * enforced here, at the one place a message is built.
 */

/** What a user-facing line opens with, so a person can tell brigadier from a vendor. */
export const SPEAKER = "brigadier: ";

/**
 * A message that breaks D24's line form, thrown rather than flattened.
 *
 * Reachable only from brigadier's own code — a caller composing a message from a
 * worker's prose is supposed to `quote()` it first — so this is a defect in this
 * repository and not a runtime condition an operator can cause.
 */
export class NotOneLine extends Error {
  constructor(readonly fact: string) {
    super(
      `a user-facing message must be one line (D24), and this one is ${fact.split("\n").length}: ` +
        `${JSON.stringify(fact.slice(0, 120))}. Say the one fact that is worth a line, or quote() the prose.`,
    );
    this.name = "NotOneLine";
  }
}

/**
 * One fact, in brigadier's own voice.
 *
 * ```
 * brigadier: planning → claude
 * brigadier: plan ready → ~/.brigadier/r/<run-id>/plan.json
 * brigadier: item 3 → codex
 * brigadier: item 3 done
 * ```
 */
export function say(fact: string): string {
  if (/[\r\n]/.test(fact)) throw new NotOneLine(fact);
  return `${SPEAKER}${fact}`;
}

/** How much of somebody else's prose fits inside one of brigadier's lines. */
export const QUOTE_WIDTH = 200;

/**
 * A worker's prose, made to fit on one line without being rewritten.
 *
 * **This is the thing D24 says cannot be shaped**: the reviewer finding text a
 * rejected item carries into a retry is a worker's own words, and *"brigadier
 * can quote it or drop it. It has no model with which to rewrite it."* So this
 * quotes: the newlines collapse, the width is bounded, and the truncation SAYS
 * it truncated. What it never does is paraphrase, summarise or tidy — every byte
 * that survives is the worker's own, in the worker's own order.
 */
export function quote(prose: string, width = QUOTE_WIDTH): string {
  const flat = prose.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  return `${flat.slice(0, width)} … [cut]`;
}
