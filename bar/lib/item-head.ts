// SPDX-License-Identifier: Apache-2.0
/**
 * Where the report starts talking about ONE item, spelled once.
 *
 * This existed twice: `headLine` in `bar/lib/item11-structure.ts` handed back an
 * index, `itemLine` in `bar/lib/item13-cost.ts` handed back the text, and both
 * built the same anchored pattern out of the same escape. They were the same
 * lookup wearing two return types, and a reader that wants the index should not
 * have to rebuild the one that wants the text — the two drifting apart is how
 * two files end up disagreeing about which line belongs to which item.
 *
 * ANCHORED, AND THAT IS THE WHOLE POINT. `^\s*<id>:\s` and nothing looser.
 * `"fifty-43".includes("fifty-4")` is TRUE, so a containment test cannot tell
 * two items apart and a report that dropped `fifty-4` entirely still satisfies
 * one. Both callers exist because that defect was found in them.
 *
 * WHAT THE ANCHOR LEANS ON, WHICH IS IN THE PRODUCT AND NOT HERE. Anchoring on
 * the id rather than on the column means a line a checker printed can look like
 * a head line: `src/gate/run.ts` carries a checker's last lines into a failing
 * check's detail verbatim, and a checker whose output contained `zzz-2:
 * integrated` once opened a forged block that carried `✓ verify: pass` — a
 * checker hanging a PASS onto the item that was really failing. The repair is
 * `DETAIL_SIGIL` in `src/report/run-report.ts`: every detail line's first
 * non-space characters are `| `, which `^\s*<id>:` can never match, so no
 * arrangement of bytes a checker can emit produces a head line. That is a
 * property of the PRODUCT. Loosening this pattern — dropping the `^`, dropping
 * the `\s` after the colon, matching mid-line — walks straight back into it, so
 * do not, and if the sigil is ever removed this anchor is not safe again by
 * itself. (Named rather than cited by line: `src/report/run-report.ts` moved
 * three times in one round and every line-numbered citation of it went stale.)
 *
 * `undefined` FOR "NO SUCH LINE", never `-1`. The report having no line at all
 * for an item is a different finding from the line being there and saying the
 * wrong thing, and it must not render as the same one. `-1` is truthy and
 * indexes from the end of an array; `undefined` is neither, so a caller that
 * forgets to check it fails loudly instead of quietly reading the last line of
 * the report as if it belonged to this item.
 */

/** The report's line for an item: where it is, and what it says. */
export interface ItemHead {
  /** Index of the head line among the report's lines, counting from zero. */
  index: number;
  /** The head line exactly as the report wrote it, indent included. */
  text: string;
}

/** Regex-literal form of an item id, which `src/queue/plan.ts` does not constrain. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The report's head line for `id`, or `undefined` if it has none.
 *
 * Takes the whole report or its already-split lines, because one caller splits
 * once and looks up many ids against the same array and the other holds only
 * the text. Splitting is the only difference between the two, and it belongs
 * here rather than in a second function.
 */
export function itemHead(report: string | readonly string[], id: string): ItemHead | undefined {
  const lines = typeof report === "string" ? report.split("\n") : report;
  const head = new RegExp(`^\\s*${escape(id)}:\\s`);
  for (const [index, line] of lines.entries()) {
    if (head.test(line)) return { index, text: line };
  }
  return undefined;
}
