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
 * THE PREFIX BELONGS TO THE NAME, AND THE DETAIL DOES NOT REPEAT IT. A census
 * of the report's own bytes on 2026-08-19 found TEN spellings of "we could not
 * measure this", four of them a detail opening `not attempted:` beneath a name
 * already reading `NOT-RUN — …`: the same verdict twice, in two vocabularies,
 * leaving a reader to work out whether that was one claim or two. A detail says
 * WHY, and what was seen. It states a verdict only where the NAME cannot carry
 * one — a check whose name is a plain assertion but whose FAILING branch is a
 * not-run, because the name is fixed and the branch is not — and then it uses
 * the word above rather than a new one.
 *
 * THREE THINGS THAT LOOK LIKE THIS VOCABULARY AND ARE NOT IT. They survived
 * that census deliberately, written down here so the next one does not collapse
 * them:
 *
 *   `none measured`   ruling 40's value in the PRODUCT's own `effortLever`
 *                     field. Item 13 asserts on the literal, so it is data this
 *                     harness READS, never a verdict this harness writes.
 *   `unattributable`  item 9's classification of ONE ledger row it could not
 *                     tie to an identity. A per-row state, which then blocks
 *                     through an ordinary `ok: false` like any other finding.
 *   `unproven`        a check that RAN, and that is naming what it does not
 *                     cover. `NOT-RUN` is `ok: false` and reached nothing;
 *                     `unproven` is the honest edge of something that did. Item
 *                     10's struck cold-start clause is the pattern.
 *
 * AND NEITHER IS EVER A `note`. `note` stamps `ok: true` and CONTRIBUTES NOTHING
 * TO THE VERDICT: `failures` filters `!ok`, so a note can never appear there,
 * and `passed` is `failures.length === 0`. A note describing a blocking
 * condition is therefore a `SKIPPED` in a note's clothes, which is the exact
 * substitution ruling 52 exists to forbid. `note` is for something worth
 * reporting that was never a gate.
 *
 * Until 2026-08-19 a note also PRINTED as `ok  <name> (note)`, identical in its
 * leader to a genuine passing assertion, so the report gave a reader no way to
 * see the difference at all. It shipped that way once, on item 10: the host view
 * was a note, `claude` was absent on a CI leg, and the item printed PASS on a
 * run where `BAR.md`'s own named instrument never executed. `render` now leads a
 * note with `note` instead. That is a REPORTING fix and nothing more — a note
 * still gates nothing, and the per-item question of which of the surviving notes
 * should have been `expect(…, false, …)` all along is answered item by item, not
 * here. `bar/lib/checks.test.ts` pins both halves of that: the rendering guard,
 * and the un-gated verdict named as the hazard it still is.
 *
 * THAT PER-ITEM QUESTION WAS ANSWERED ON 2026-08-20, and the answer is that none
 * of them should have been. Every `.note(` call site outside the tests was read
 * — 21 of them, in items 05, 07, 09, 10, 12, 13 and 14 — and each was checked
 * against one question: *does this row describe a condition that BLOCKS, or a
 * fact that never was a gate?* All 21 are the second. The four that come closest
 * are the four worth naming, because they are the shape a future one will take:
 *
 *   item 05  "whose defects these are" — the harness's planting is a stand-in
 *            between verifier visits. Owner decision §25 settles this exactly:
 *            the catch rate is the VERIFIER's to produce and the automated item
 *            publishes no rate. A note is the correct instrument.
 *   item 07  ruling 38's one hole, the operator's verify command carrying no
 *            command-line marker. Not a blocked check — nothing above it demands
 *            the marker, because demanding it would fail a CORRECT product. It
 *            is recorded in `BAR.md` under item 7 as well, so the note is the
 *            report repeating a written-down limit rather than hiding one.
 *   item 09  what a fixture fleet cannot settle about a real vendor's tool
 *            shell. The checks it sits beside DO block, including
 *            `unattributable`; the note scopes what they cover.
 *   item 14  the placements the artifact states. The blocking half is the live
 *            one, and when it cannot run the item returns `kind: "skipped"`,
 *            which blocks under ruling 48 rather than noting its way past.
 *
 * SO THE AUDIT IS CLEAN AND THE STRUCTURE IS STILL THE HAZARD. `note` writes
 * `ok: true` into a field it has no verdict for, and `failures` filters `!ok`,
 * so the NEXT note written in a blocked branch is invisible to the verdict
 * exactly as the ones above would have been. A point-in-time reading does not
 * fix that; only making a note's absence-of-verdict unrepresentable would —
 * `Check` becoming a discriminated union whose note arm carries no `ok` at all.
 * That is a change to the type every item's verdict is computed from, and it is
 * NOT made here: it was scoped on 2026-08-20 at roughly 41 call sites inside the
 * instrument that grades the release, and starting it at the end of a round is
 * how the instrument becomes the defect for the fourth time (amendment §20).
 *
 * **RULED 2026-08-20, the owner having delegated that round's rulings.** The
 * union is the real fix and it is NOT taken now, deliberately: it is a refactor
 * of the verdict type of the instrument that grades the release, at ~41 call
 * sites, and it needs a round that begins with it and verifies it alone. That is
 * this file's own recommendation and the reason is amendment §20's three
 * recorded occasions on which the instrument became the defect. **A ruling to
 * defer is still a ruling and it carries a cost: until the union lands, a note
 * written in a blocked branch is invisible to `failures`, and nothing here makes
 * that impossible.**
 *
 * **What IS taken now is the part that stops the audit above from expiring.**
 * The audit is a point-in-time answer — it was true of 21 call sites on
 * 2026-08-20 and says nothing about the 22nd. So `note` REFUSES, at runtime and
 * at every call site, a row whose name carries this file's own blocking
 * vocabulary: `FAIL —`, `NOT-RUN —` and `ERROR —` are verdicts, and a verdict
 * written through a channel that has none is the exact confusion the union
 * would make unrepresentable. It is a narrowing and not the fix:
 *
 *   - it catches the case where the AUTHOR knew they were describing a blocked
 *     condition and reached for `note` anyway, which is how all three of item
 *     12's near-misses would have read;
 *   - it does NOT catch a note whose prose describes a blocking condition
 *     without using the vocabulary, and it cannot, because that is a judgement
 *     about meaning. Only the union closes that, and the union is scheduled.
 */

export interface Check {
  name: string;
  ok: boolean;
  /** What was actually seen. Recorded on a pass as well as a failure. */
  detail: string;
  /**
   * Set only by `note`. `ok` is the VERDICT and a note has none, so the two
   * cannot share one field without a note either blocking or masquerading as a
   * pass. This flag exists so `render` can tell them apart; nothing that
   * computes a verdict reads it.
   */
  note?: true;
}

/**
 * This file's own blocking vocabulary, as prefixes. See the header for the
 * convention and for why three spellings of one verdict is a defect on its own.
 */
export const BLOCKING_PREFIXES = ["FAIL —", "NOT-RUN —", "ERROR —"] as const;

/**
 * A note may not carry a verdict, and this is what says so at the call site.
 *
 * THROWS rather than returning false. A `Checks` object is built while an item
 * runs and read to produce that item's outcome, so a soft failure here would
 * become a row nobody reads inside a verdict nobody checks — which is the shape
 * being guarded against, one level up. A throw makes the item `error`, and
 * ruling 52 makes `error` block.
 */
export function refuseVerdictInANote(name: string, detail: string): void {
  const prefix = BLOCKING_PREFIXES.find((p) => name.trimStart().startsWith(p));
  if (prefix === undefined) return;
  throw new Error(
    `a note may not carry a verdict: ${JSON.stringify(name)} opens with ${JSON.stringify(prefix)}, ` +
      "which this file's vocabulary reserves for a row that BLOCKS. `note` writes `ok: true` into a " +
      "field it has no verdict for, so this row would have rendered as a fact and gated nothing. " +
      "Use `expect(name, false, detail)` — a check that did not run is not a check that passed " +
      `(ruling 48). Detail was: ${detail.slice(0, 160)}`,
  );
}

/** The four-column leader `render` prints. Exported so tests assert on the bytes, not on a flag. */
export function leader(row: Check): "ok  " | "FAIL" | "note" {
  if (row.note) return "note";
  return row.ok ? "ok  " : "FAIL";
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

  /**
   * Record something worth reporting that is not itself a pass/fail gate.
   *
   * The ` (note)` suffix stays: it is what item 10's own controls filter gates
   * on, and it survives into the reason-free half of the report. The `note`
   * flag is what `render` reads.
   */
  note(name: string, detail: string): void {
    refuseVerdictInANote(name, detail);
    this.rows.push({ name: `${name} (note)`, ok: true, detail, note: true });
  }

  /**
   * Take every row of another accumulator AS IT STANDS.
   *
   * Items build their judgement in pieces — `proofOfWork`, `judgeCost`,
   * `judgeSecret` — and then merge the pieces into the item's own `Checks`. The
   * idiom for that merge used to be
   *
   *   for (const row of judgeCost(…).rows) checks.expect(row.name, row.ok, row.detail);
   *
   * which RECONSTRUCTS each row through `expect` and therefore drops every field
   * `expect` does not take. On 2026-08-19 that meant `note`: a note copied
   * through the loop came out the far side indistinguishable from a pass again,
   * so the leader fixed in `render` never reached the two items that needed it
   * most — item 13, whose note names "what #45 leaves unproven" about a cost
   * figure, and item 12's two notes. Fifteen call sites across items 02, 03, 04, 06, 09, 11,
   * 12 and 13 copied rows that way.
   *
   * `absorb` copies the row instead of re-deriving it, so a row means the same
   * thing in the accumulator that receives it as in the one that made it. It
   * changes no verdict: a copied failing row still fails, a copied note still
   * gates nothing. Adding a field to `Check` is now safe by default rather than
   * safe only where someone remembered.
   */
  absorb(other: Checks): void {
    for (const row of other.rows) this.rows.push({ ...row });
  }

  get failures(): Check[] {
    return this.rows.filter((r) => !r.ok);
  }

  get passed(): boolean {
    return this.failures.length === 0;
  }

  /**
   * Every row, one per line, with its bytes. This becomes `BarResult.observed`.
   *
   * Three leaders, all four columns wide so the names stay aligned: `ok  ` is an
   * assertion that PASSED, `FAIL` is one that did not, and `note` asserted
   * nothing. A reader who sees `note` is being told, in the leader, not to count
   * the row as evidence of anything.
   */
  render(): string {
    return this.rows.map((r) => `${leader(r)} ${r.name}: ${r.detail}`).join("\n");
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
