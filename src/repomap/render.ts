// SPDX-License-Identifier: Apache-2.0
/**
 * Fitting the ranked files into ruling 39's budget.
 *
 * Aider's mechanism, and #23's: render the top N ranked files, binary-search
 * for the largest N whose estimate fits, take that. The search is over a
 * MONOTONE quantity — one more file is never fewer characters — which is what
 * makes the binary search sound; `renderMap` therefore never reorders or
 * deduplicates across the cut.
 *
 * Ruling 16's brief is byte-identical for every worker and carries IDENTIFIERS,
 * NOT CONTENTS. #23 found no vendor asymmetry to justify varying it: both
 * measured vendors drop to zero tool calls when the target is in the map, so
 * there is nothing for a per-vendor rendering to exploit.
 */

import { estimateTokens } from "./tokens.ts";

/** Symbols shown per file. Aider's number, and #23's. */
export const SYMBOLS_PER_FILE = 12;

export interface RenderedMap {
  readonly text: string;
  /** The files that actually made it in, in rank order. */
  readonly files: readonly string[];
  readonly estimatedTokens: number;
}

/**
 * Render the top `count` files.
 *
 * Symbols are sorted so the same repository renders the same bytes twice
 * running; a map that reshuffles is indistinguishable from one that changed.
 */
export function renderMap(
  ordered: readonly string[],
  symbolsByFile: ReadonlyMap<string, readonly string[]>,
  count: number,
): string {
  const lines: string[] = [];
  for (const path of ordered.slice(0, count)) {
    const symbols = [...(symbolsByFile.get(path) ?? [])].sort().slice(0, SYMBOLS_PER_FILE);
    lines.push(symbols.length > 0 ? `${path}:\n  ${symbols.join(", ")}` : path);
  }
  return lines.join("\n");
}

/**
 * The largest prefix of `ordered` that fits in `budgetTokens`.
 *
 * Returns an empty map rather than an over-budget one when even the first file
 * does not fit. That is the honest failure: a budget that is exceeded "only a
 * little" is a budget that does not exist, and `buildRepoMap` reports the empty
 * result as degraded rather than as a map.
 */
export function fitToBudget(
  ordered: readonly string[],
  symbolsByFile: ReadonlyMap<string, readonly string[]>,
  budgetTokens: number,
): RenderedMap {
  let low = 0;
  let high = ordered.length;
  let best = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (estimateTokens(renderMap(ordered, symbolsByFile, mid)) <= budgetTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const text = renderMap(ordered, symbolsByFile, best);
  return { text, files: ordered.slice(0, best), estimatedTokens: estimateTokens(text) };
}

/**
 * Cut a diagnostic line down to the budget.
 *
 * Only reached when there is no map to render. The point is that the budget
 * invariant holds with NO exception — `estimatedTokens <= budgetTokens` is true
 * of every `RepoMap`, including the degraded ones — while the full sentence
 * survives on `RepoMap.degraded`, which no budget governs. A guard with one
 * exception is a guard someone will find the exception in.
 */
export function truncateToBudget(text: string, budgetTokens: number): string {
  if (estimateTokens(text) <= budgetTokens) return text;
  let kept = text;
  while (kept.length > 0 && estimateTokens(kept) > budgetTokens) {
    kept = kept.slice(0, kept.length - 1);
  }
  return kept;
}
