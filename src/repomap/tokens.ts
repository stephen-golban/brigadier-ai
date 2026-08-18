// SPDX-License-Identifier: Apache-2.0
/**
 * What the map costs the window it lands in.
 *
 * The naive estimator is `chars / 4`. It is wrong in the dangerous direction:
 * #23 measured it UNDERSTATING a real path list by **22%**, which means a
 * budget enforced with it silently overspends. Ruling 39 fixes the budget at
 * ~2K tokens, so an estimator that under-counts by a fifth turns a 2,000-token
 * promise into a ~2,440-token charge in someone else's context window.
 *
 * Two ways to fix that, and only one of them fits:
 *
 *   Ship a real tokenizer. #23 measured it at **+3.3 MB**, against 2,449,054
 *   bytes of binary headroom of which `src/repomap/grammars.ts` already spends
 *   809,088. Rejected on size, and the rejection is the reason the correction
 *   below is a constant rather than a lookup.
 *
 *   Correct the estimator by the measured error. Free, and honest as long as
 *   the correction is stated rather than buried.
 *
 * MEASURED against `gpt-tokenizer 4.0.0` (`gpt-4o`, o200k_base) on 2026-08-18,
 * on this repository, at two artifact shapes:
 *
 *   a bare path list (`git ls-files`, 4,095 chars) — `chars / 4` under-counted
 *   by **22.6%**, reproducing #23's 22% on the up-front artifact ruling 16
 *   describes;
 *
 *   a rendered repo map at budgets of 1K, 2K and 4K — `chars / 4` under-counted
 *   by only **6.3% to 8.2%**, because a map is mostly identifiers and
 *   identifiers tokenise far better than slash-separated paths do.
 *
 * The correction is set from the LARGER of the two, and that is a deliberate
 * choice rather than an oversight about the smaller one. A map is not always
 * identifier-dense: a file with no exported symbols renders as a bare path, so
 * a repository of such files degenerates into exactly the shape that costs
 * 22.6%. Erring the other way would let the budget be exceeded on precisely the
 * repositories where the map is least useful. The measured price of the margin
 * is that a 2,000-token map really costs ~1,744 tokens — the estimate ran
 * **12.8% to 14.7% HIGH** on this repository's maps, so the map is a little
 * smaller than it could be and never larger than promised.
 *
 * The tokenizer was installed to take that measurement and REMOVED again; it is
 * not a dependency and nothing here imports one. `RepoMap.characters` is
 * reported beside `RepoMap.estimatedTokens` so a caller that does have a
 * tokenizer can check this arithmetic instead of trusting it.
 */

/** The naive divisor. Named because it is the thing being corrected. */
export const CHARS_PER_TOKEN = 4;

/**
 * How much `chars / 4` under-counts, on the worst measured artifact shape.
 *
 * 1.22 rather than 1.08: see the shape argument above. The number is the
 * path-list measurement, not an average of the two.
 */
export const UNDERCOUNT_CORRECTION = 1.22;

/**
 * Tokens, estimated high on purpose.
 *
 * This is an ESTIMATE and the type cannot say so, which is why `RepoMap`
 * reports `characters` beside `estimatedTokens`.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil((text.length / CHARS_PER_TOKEN) * UNDERCOUNT_CORRECTION);
}

/**
 * Ruling 39's budget: **~2K tokens, not ~1K**.
 *
 * MEASURED across 404 work items on five repositories at #44: at ~1K the item's
 * target is in the map 8.1% of the time on a 2,014-file repository and 25.8% on
 * a 2,425-file one; doubling to ~2K more than doubles both (+9.3 and +16.7
 * points) and every later doubling buys 2–3 points. ~2K is the knee, and that
 * is why it is a constant here rather than a caller's choice with a default
 * nobody revisits.
 */
export const DEFAULT_BUDGET_TOKENS = 2_000;
