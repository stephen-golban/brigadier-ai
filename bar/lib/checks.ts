// SPDX-License-Identifier: Apache-2.0
/**
 * A sub-check accumulator, and the reason an item is not one big boolean.
 *
 * Every `BAR.md` item is several assertions wearing one heading — item 1 alone
 * carries "absent when off PATH", "reports the RESOLVED entry", "unusable
 * carries the vendor's own remedy" and "drift is reported". Collapsing them to a
 * single pass/fail would produce exactly the report ruling 52 forbids: fewer
 * CHECKS rather than fewer items, so a reader cannot tell which promise broke.
 *
 * So each sub-check records the bytes it saw whether it passed or failed. A
 * check that only speaks up on failure cannot be audited by someone who does not
 * trust the author, which is `BAR.md`'s first rule.
 *
 * ─────────────────── THE VERDICT VOCABULARY, WRITTEN DOWN ───────────────────
 *
 * A `Check` is a boolean and ruling 52's vocabulary has five values, so items
 * carry the missing three in the check's NAME. Several items had each invented
 * their own spelling of this before the 2026-08-19 reconciliation pass — the
 * same verdict appearing as `not-run —`, `NOT-RUN —` and `NOT RUN —` in three
 * files — and a reader of the full output cannot tell whether three spellings
 * are three concepts. The convention, so the next item does not invent a fourth:
 *
 *   `ERROR — <what broke>`     the INSTRUMENT or a premise broke, so the item
 *                              never reached the assertion it names. Ruling 52's
 *                              `error`. Always `ok: false` — it BLOCKS, and its
 *                              remedy points at this harness or at the machine,
 *                              never at the product.
 *   `NOT-RUN — <what did not>` the assertion never happened at all, because
 *                              something it needs was absent. Ruling 52's
 *                              `not-run`. Always `ok: false` — a check that did
 *                              not run is not a check that passed (ruling 48).
 *   `FAIL — <what broke>`      the PRODUCT did not keep its promise, in a place
 *                              where the reader must not be sent to the harness
 *                              instead. Only worth the prefix where an ERROR row
 *                              could be confused for it; an ordinary assertion
 *                              needs no prefix, because `ok: false` already
 *                              means `fail`.
 *   anything else              an ordinary assertion about the PRODUCT. `ok`
 *                              true or false is `pass` or `fail`.
 *
 * The prefix and the item's own internal verdict must AGREE. `judgeSink` in
 * `bar/lib/item12-delivery.ts` returned `error` under a name beginning `FAIL —`
 * until 2026-08-19: it blocked either way, so nothing was hidden, but a reader
 * of the name and a reader of the verdict were sent to different places.
 *
 * UPPER CASE IS THE HARNESS SPEAKING. Lower-case `not-run` in backticks is the
 * product's own record value — the write-ahead slot ruling 52 requires — and
 * items 11 and 12 assert on that literal. The two appear in the same report and
 * must not be mistaken for each other.
 *
 * AND NEITHER IS EVER A `note`. `note` stamps `ok: true`, so a note describing a
 * blocking condition renders as a passing assertion in both the report and the
 * halves — a `SKIPPED` in a note's clothes, which is the exact substitution
 * ruling 52 exists to forbid. `note` is for something worth reporting that was
 * never a gate.
 */

export interface Check {
  name: string;
  ok: boolean;
  /** What was actually seen. Recorded on a pass as well as a failure. */
  detail: string;
}

export class Checks {
  readonly rows: Check[] = [];

  /**
   * Record one assertion.
   *
   * `detail` is not optional, and that is on purpose: an assertion that cannot
   * say what it saw is an assertion nobody can re-derive.
   */
  expect(name: string, ok: boolean, detail: string): boolean {
    this.rows.push({ name, ok, detail });
    return ok;
  }

  /** Record something worth reporting that is not itself a pass/fail gate. */
  note(name: string, detail: string): void {
    this.rows.push({ name: `${name} (note)`, ok: true, detail });
  }

  get failures(): Check[] {
    return this.rows.filter((r) => !r.ok);
  }

  get passed(): boolean {
    return this.failures.length === 0;
  }

  /** Every row, one per line, with its bytes. This becomes `BarResult.observed`. */
  render(): string {
    return this.rows.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`).join("\n");
  }

  /** Which assertions failed. This becomes `BarResult.reason`. */
  reason(): string | undefined {
    const failed = this.failures;
    if (failed.length === 0) return undefined;
    return failed.map((r) => `${r.name} — ${r.detail}`).join("; ");
  }
}

/** Trim a captured stream for a one-line observation without hiding that it was trimmed. */
export function excerpt(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat === "" ? "<empty>" : flat;
  return `${flat.slice(0, limit)}… (${flat.length} chars total)`;
}
