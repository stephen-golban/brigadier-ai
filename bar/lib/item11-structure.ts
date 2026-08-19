// SPDX-License-Identifier: Apache-2.0
/**
 * Item 11's structural half: WHERE a failure is printed, not merely whether its
 * letters occur somewhere in the report.
 *
 * This file exists because the item's existing assertions are satisfiable by a
 * report that has lost the property they exist to hold.
 *
 * `hostReport.includes(id)` is the clearest case, and it is not hypothetical
 * here: the fifty-item fixture fails `fifty-4`, `fifty-18` and `fifty-43`, and
 * `"fifty-43".includes("fifty-4")` is TRUE. A cap that dropped `fifty-4`
 * entirely would still have passed "every failing item still appears", because
 * a different item's id contains it. The same shape one level down is worse:
 * the product's per-item verify check is called `verify`, and a report
 * containing the sentence *"the merged result was verified"* satisfies
 * `report.includes("verify")` while printing none of the item's checks at all.
 *
 * So nothing here searches the whole report. Every assertion is made against
 * the BLOCK the report devotes to one item — the head line the product writes
 * for it and the lines under it before the next item begins — which is the unit
 * ruling 52 actually governs: *under space pressure print fewer ITEMS, never
 * fewer CHECKS.*
 *
 * The other three properties in here are the ones with no textual proxy at all:
 *
 *   the WRITE-AHEAD (ruling 52) — a check slot is opened holding `not-run`
 *   before the check runs, so a crash leaves a blocking value rather than an
 *   absent field. That is a claim about ORDER, and only the appended NDJSON
 *   flight recorder can answer it. A JSON record written at the end cannot: it
 *   holds the settled value either way.
 *
 *   the TOP LEVEL (ruling 52) — a run carrying a blocking check that is not
 *   `pass` may not report success. An exit code is not a rendering and cannot
 *   be phrased around.
 *
 *   the DETECTOR'S OWN POSITIVE CONTROL — "no worker transcript appears in the
 *   host report" is worth nothing unless the pattern it searches with can be
 *   shown to fire on the real transcript this run wrote to disk. An absence
 *   measured with a broken detector is the instrument reporting on itself.
 */

import { Checks, excerpt } from "./checks.ts";
import { itemHead } from "./item-head.ts";

/** A check as the RECORD states it. The report is then required to say the same. */
export interface RecordedCheck {
  name: string;
  outcome: string;
  qualifier?: string;
  blocking?: boolean;
}

/** One item as the record states it, with the ordinal the product routes it by. */
export interface RecordedItem {
  id: string;
  number?: number;
  status?: string;
  checks: RecordedCheck[];
}

/** A `check-slot` / `check-settled` line of the appended NDJSON record. */
export interface SlotEvent {
  /** Position in the file. The whole point of this type is the ORDER. */
  line: number;
  type: "check-slot" | "check-settled";
  item: number;
  check: string;
  outcome: string;
}

/** Ruling 52's initial value. A slot that opens as anything else is not a write-ahead. */
export const INITIAL_OUTCOME = "not-run";

/**
 * THE PRODUCT'S DETAIL LINE, TRANSCRIBED — and the classifier that keeps every
 * hand-written fixture in step with it.
 *
 * `bar/` imports nothing from `src/`, so every fact this harness holds about the
 * product's rendering is copied by hand, and a hand copy goes stale silently.
 * It already did: `DETAIL_SIGIL` was added to `src/report/run-report.ts` in
 * round 16 to stop a checker's own output forging another item's head line, and
 * two fixtures in `item11-structure.test.ts` went on writing detail lines
 * without it. A fixture that disagrees with the product tests a report the
 * product does not write.
 *
 * The shape, read off `src/report/run-report.ts`'s working tree on 2026-08-20:
 * `renderItem` pushes each check at SIX spaces and then, for a blocking check
 * with a detail, `details.lines(check.detail, "          ")` — TEN spaces — and
 * `DetailWriter.lines` prefixes `DETAIL_SIGIL` to every one of those lines,
 * unconditionally, cut or uncut. So the rule is positional: a line at exactly
 * ten spaces followed by a non-space is an item-list detail, and the product
 * always writes `| ` next.
 *
 * CLASSIFY WITHIN, OPT IN AT THE EDGE — and the second half is the honest
 * qualifier on the first. `unsigiledDetailLines` is handed a whole report and
 * decides line by line, keeping no list of lines to remember; but the classifier
 * only ever sees what someone routed through `transcribedReport`, so its REAL
 * COVERAGE is "the fixtures built with it", which today means the two in
 * `item11-structure.test.ts`. Identical unsigil'd ten-space transcriptions exist
 * uncovered at `bar/lib/item13-cost.test.ts:309`, `:702` and `:719`. Calling
 * this "classify, do not whitelist" without that sentence oversells it.
 *
 * `transcribedReport` THROWS rather than returns — a stale fixture must take its
 * test file down at load, not be quietly measured.
 *
 * EXACTLY WHAT IT FIRES ON, AND EXACTLY WHAT THAT IS WORTH. The rule is TEN
 * SPACES FOLLOWED BY A NON-SPACE, and the "followed by" half is load-bearing
 * rather than tidy. An earlier version of this note claimed the classifier was
 * "capable of a MISS and not of a false accusation" and that was FALSE:
 * `src/queue/admit.ts` writes its continuation prose at THIRTEEN spaces
 * (`:291-292`, `:322-323`, `:335`), a prefix-match on ten spaces swallows those,
 * and fixtures do splice admission lines into report strings — so the guard
 * could have thrown on bytes the product genuinely writes. Narrowed on
 * 2026-08-20, and the claim is now measured rather than asserted: `grep -rE
 * '"          [^ ]' src/` MEASURED against `grep (BSD) on 2026-08-20` returns
 * ONE emitting site in the whole product, `run-report.ts:246`'s detail indent.
 *
 * So the honest statement of the property is: the classifier fires on a position
 * that, in TODAY'S tree, no product writer but the item-list detail occupies.
 * That is a measurement over one tree, not a guarantee over every future one — a
 * new writer that chose exactly ten spaces would be accused wrongly, and this
 * paragraph is where that lands.
 *
 * AND IT IS BLIND AT SIX. `renderRun`'s merged-result and run-level tails carry
 * check details too and indent them SIX spaces (`details.lines(check.detail,
 * "      ")`) while indenting their own check lines TWO. Six is therefore a
 * detail line in a tail and a CHECK line in the item list, and no rule reading
 * one line at a time can separate them — that needs the section boundaries
 * transcribed as well. The classifier says nothing at six and misses those. No
 * fixture under `bar/lib/` renders a tail detail today; the one that first does
 * will need this widened.
 */
export const DETAIL_INDENT = "          ";

/** `DETAIL_SIGIL` in `src/report/run-report.ts`, which `^\s*<id>:\s` can never match. */
export const DETAIL_SIGIL = "| ";

/**
 * Is this line at the item-list detail position? Ten spaces and then something
 * that is not another space — `admit.ts`'s thirteen-space prose is NOT this.
 */
export function atDetailIndent(line: string): boolean {
  return line.startsWith(DETAIL_INDENT) && !line.startsWith(`${DETAIL_INDENT} `) && line.length > DETAIL_INDENT.length;
}

/** Lines a report renders at the detail indent WITHOUT the product's sigil. */
export function unsigiledDetailLines(report: string): string[] {
  return report.split("\n").filter((line) => atDetailIndent(line) && !line.startsWith(`${DETAIL_INDENT}${DETAIL_SIGIL}`));
}

/**
 * The head of ruling 58's overflow sentence AS BRIGADIER SPELLS IT, transcribed
 * from `src/report/run-report.ts`'s working tree on 2026-08-20:
 *
 *   `this report is OVER the ${HOST_REPORT_TOKEN_CEILING}-token ceiling${share} because ${why}.`
 *
 * FOR CHECKING FIXTURES, NOT FOR CHECKING IMPLEMENTATIONS — see the note in
 * `judgeOverride`. A fixture claiming to be brigadier's output must spell it
 * brigadier's way or it is testing a report nothing writes; an implementation
 * satisfying ruling 58 may state the overflow in its own words, and
 * `bar/fakes/honest.ts` does.
 *
 * Anchored at column zero because that is where run-level sentences go, and
 * `src/gate/run.ts` carries a checker's own words into details ten spaces in.
 * Everything after `ceiling` is left free: it is `${share}` and `${why}`, both
 * interpolated. `\d+` and not `\d[\d,]*` — the ceiling is interpolated as a bare
 * number, so a thousands separator is drift rather than a spelling choice, and
 * that separator is exactly what the stale fixture had.
 */
export const OVER_CEILING_HEAD = /^this report is OVER the \d+-token ceiling\b/;

/** One rendered detail line, spelled the one way the product spells it. */
export function detailLine(text: string): string {
  return `${DETAIL_INDENT}${DETAIL_SIGIL}${text}`;
}

/**
 * A fixture asserting that it is what the product renders. Throws if it is not.
 *
 * Deliberately NOT applied to strings that are hand-forged non-product bytes —
 * a checker's raw output, or the corpus of near-misses `itemHead` is
 * differentiated against. Those are inputs, not transcriptions, and the
 * difference is declared by which constructor built them rather than by a list
 * kept somewhere else.
 */
export function transcribedReport(lines: readonly string[]): string {
  const report = lines.join("\n");
  const stale = unsigiledDetailLines(report);
  if (stale.length > 0) {
    throw new Error(
      `fixture drift: ${stale.length} line(s) at the product's detail indent without its ` +
        `${JSON.stringify(DETAIL_SIGIL)} sigil — ${stale.map((line) => JSON.stringify(line)).join(", ")}. ` +
        "`src/report/run-report.ts` emits the sigil unconditionally; the fixture is the stale side",
    );
  }
  return report;
}

/**
 * The block the report devotes to one item: its head line and everything under
 * it, up to the next item or the end of the item list.
 *
 * The list ends where an unindented line begins — the product's run-level
 * sections (`the merged result:`, `the run:`, `review:`) are written at column
 * zero and its item lines are not. Both boundaries are used rather than either
 * alone, because a renderer that stopped indenting would otherwise hand this
 * function the whole report and every containment test would pass.
 */
export function itemBlock(report: string, id: string, allIds: readonly string[]): string | undefined {
  const lines = report.split("\n");
  const head = itemHead(lines, id);
  if (head === undefined) return undefined;
  const start = head.index;
  const others = allIds
    .filter((other) => other !== id)
    .map((other) => itemHead(lines, other)?.index)
    .filter((index): index is number => index !== undefined && index > start);
  const unindented = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  const ends = [...others, unindented === -1 ? lines.length : unindented, lines.length].filter((index) => index > start);
  return lines.slice(start, Math.min(...ends)).join("\n");
}

/** Every number printed on a line that talks about collapsing. */
export function collapsedCounts(report: string): number[] {
  return report
    .split("\n")
    .filter((line) => /collaps/i.test(line))
    .flatMap((line) => [...line.matchAll(/\d[\d,]*/g)].map((m) => Number(m[0].replace(/,/g, ""))));
}

/** Tolerant NDJSON reader: a line that does not parse is skipped, never thrown on. */
export function readSlotEvents(text: string): SlotEvent[] {
  const events: SlotEvent[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim().length === 0) return;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const type = parsed["type"];
      if (type !== "check-slot" && type !== "check-settled") return;
      const item = parsed["item"];
      const check = parsed["check"];
      const outcome = parsed["outcome"];
      if (typeof item !== "number" || typeof check !== "string" || typeof outcome !== "string") return;
      events.push({ line: index, type, item, check, outcome });
    } catch {
      // A half-written last line is exactly what the NDJSON format exists to
      // survive. Skipping it is the format's own contract, not leniency.
    }
  });
  return events;
}

/**
 * Was this check's slot opened, holding `not-run`, BEFORE it was settled?
 *
 * `undefined` for "no slot was ever opened", which is a different finding from
 * "it was opened late" and must not render as the same one.
 */
export function writeAhead(
  events: readonly SlotEvent[],
  item: number,
  check: string,
): { opened: boolean; initial: string | undefined; beforeSettle: boolean } {
  const mine = events.filter((event) => event.item === item && event.check === check);
  const slot = mine.find((event) => event.type === "check-slot");
  const settled = mine.filter((event) => event.type === "check-settled");
  return {
    opened: slot !== undefined,
    initial: slot?.outcome,
    beforeSettle: slot !== undefined && settled.every((event) => event.line > slot.line),
  };
}

export interface StructureObservations {
  report: string;
  /** The run's exit status. `null` means the harness killed it on a timeout. */
  exitCode: number | null;
  /** The record's rows for the items the HARNESS made fail. */
  failing: readonly RecordedItem[];
  /** Ids the harness expects to pass. Owned by the harness, not read back. */
  passingIds: readonly string[];
  /** Every id the record carries, used only to find where one block ends. */
  allIds: readonly string[];
  slots: readonly SlotEvent[];
  /**
   * Does the transcript detector fire on the transcript this run really wrote?
   *
   * The positive control for "no worker transcript appears in the host report".
   */
  transcriptHasFrames: boolean;
}

export function judgeReportStructure(o: StructureObservations): Checks {
  const checks = new Checks();
  const blocks = new Map(o.failing.map((item) => [item.id, itemBlock(o.report, item.id, o.allIds)]));

  // 1. THE FAILURE HAS ITS OWN BLOCK. `report.includes("fifty-4")` is satisfied
  //    by `fifty-43`, so containment is not the test — a head line is.
  const missing = o.failing.filter((item) => blocks.get(item.id) === undefined).map((item) => item.id);
  checks.expect(
    "every failing item is printed as its OWN item line, not merely as a substring",
    o.failing.length > 0 && missing.length === 0,
    `${o.failing.length} failing item(s) recorded; without an item line of their own: ${missing.join(", ") || "none"}. ` +
      "Anchored at `^<id>:` because `fifty-43` contains `fifty-4` and an `includes` test cannot tell them apart",
  );

  // 2. FEWER ITEMS, NEVER FEWER CHECKS. Every check the RECORD holds for a
  //    failing item has to appear inside that item's block with its outcome.
  const absent: string[] = [];
  let expected = 0;
  for (const item of o.failing) {
    const block = blocks.get(item.id);
    for (const check of item.checks) {
      expected += 1;
      if (block === undefined || !block.includes(`${check.name}: ${check.outcome}`)) {
        absent.push(`${item.id}/${check.name}: ${check.outcome}`);
      }
    }
  }
  checks.expect(
    "every check of a failing item is printed inside that item's block, with its outcome (ruling 52)",
    expected > 0 && absent.length === 0,
    `${expected} check(s) recorded across the failing items; not found in their own blocks: ${absent.join("; ") || "none"}. ` +
      "Searched the item's block rather than the report: the per-item check is called `verify`, and " +
      '"the merged result was verified" satisfies a whole-report substring test while printing no check at all',
  );

  // 3. THE QUALIFIER IS INSIDE THE RESULT (ruling 52), never a footnote.
  const qualified = o.failing.flatMap((item) =>
    item.checks.filter((check) => check.qualifier !== undefined).map((check) => ({ item, check })),
  );
  const footnoted = qualified.filter(
    ({ item, check }) =>
      !(blocks.get(item.id) ?? "").includes(`${check.name}: ${check.outcome} (${check.qualifier ?? ""})`),
  );
  checks.expect(
    "a check's qualifier is rendered INSIDE its result string (ruling 52)",
    qualified.length === 0 || footnoted.length === 0,
    qualified.length === 0
      ? "no check on a failing item carried a qualifier, so there was nothing here to misplace"
      : `${qualified.length} qualified check(s); not rendered as \`name: outcome (qualifier)\`: ${footnoted
          .map(({ item, check }) => `${item.id}/${check.name} (${check.qualifier ?? ""})`)
          .join("; ") || "none"}`,
  );

  // 4. THE CAP BIT, AND IT BIT THE RIGHT HALF. A token count measured on a
  //    report that never had to drop anything proves nothing about the cap.
  const lines = o.report.split("\n");
  const shownPassing = o.passingIds.filter((id) => itemHead(lines, id) !== undefined);
  const hidden = o.passingIds.length - shownPassing.length;
  const counts = collapsedCounts(o.report);
  checks.expect(
    "passing items collapsed to a COUNT, and the count is the number actually hidden",
    hidden > 0 && counts.includes(hidden),
    `${o.passingIds.length} passing item(s), ${shownPassing.length} printed in full, so ${hidden} were hidden; ` +
      `numbers printed on lines that mention collapsing: ${counts.join(", ") || "NONE — nothing said anything was hidden"}. ` +
      "A ceiling measured on a report under no pressure measures nothing",
  );

  // 5. RULING 52'S WRITE-AHEAD, which only the appended record can answer.
  const late: string[] = [];
  const unopened: string[] = [];
  let asked = 0;
  for (const item of o.failing) {
    const number = item.number;
    for (const check of item.checks.filter((c) => c.blocking === true && c.outcome !== "pass")) {
      asked += 1;
      if (number === undefined) {
        unopened.push(`${item.id}/${check.name} (the record gave the item no ordinal to look it up by)`);
        continue;
      }
      const seen = writeAhead(o.slots, number, check.name);
      if (!seen.opened) unopened.push(`${item.id}#${number}/${check.name}`);
      else if (seen.initial !== INITIAL_OUTCOME || !seen.beforeSettle) {
        late.push(`${item.id}#${number}/${check.name} opened as \`${seen.initial}\`, before its settle: ${seen.beforeSettle}`);
      }
    }
  }
  checks.expect(
    "each blocking check's slot was written BEFORE the check ran, holding `not-run` (ruling 52)",
    asked > 0 && unopened.length === 0 && late.length === 0,
    `${asked} blocking check(s) on the failing items; no slot event at all: ${unopened.join(", ") || "none"}; ` +
      `opened wrong or opened late: ${late.join("; ") || "none"}. Read from the appended record, which is the only ` +
      "artifact that can answer a question about ORDER — the JSON written at the end holds the settled value either way",
  );

  // 6. THE TOP LEVEL. Ruling 52: a blocking check that is not `pass` cannot be
  //    reported as a success, and an exit status cannot be phrased around.
  const headline = o.report.split("\n").find((line) => line.trim().length > 0) ?? "";
  checks.expect(
    "a run carrying a blocking check that is not `pass` does not report success at the top level",
    o.exitCode !== null && o.exitCode !== 0 && !/^\s*(integrated\b|success\b|all items? )/i.test(headline),
    `exit ${o.exitCode ?? "killed on a timeout"}; first line of the report: ${excerpt(headline, 160)}`,
  );

  // 7. THE DETECTOR'S POSITIVE CONTROL.
  checks.expect(
    "the transcript detector fires on the transcript this run actually wrote to disk (the POSITIVE CONTROL for the absence above)",
    o.transcriptHasFrames,
    o.transcriptHasFrames
      ? "the on-disk transcript matches the same pattern the host report is required NOT to match, so the absence above was measured with an instrument that works"
      : "the on-disk transcript matches NOTHING the detector looks for — so `no worker transcript appears in the host report` is an absence measured with a detector that cannot detect, and it proves nothing",
  );

  return checks;
}

/**
 * The one place ruling 52 OVERRIDES ruling 58, and the one path the fifty-item
 * run can never reach.
 *
 * `capItems` drops passing items until the report fits, and stops at the
 * blocking set. When the blocking items ALONE exceed the budget there is
 * nothing left to drop, and the product goes OVER the ceiling and says so
 * rather than hiding a failure — *"the cap can hide a success and can never
 * hide a failure"*, at the only moment the sentence costs anything.
 *
 * The fifty-item run cannot exercise it: three failing items fit comfortably,
 * and a run driven until they did not would fail the item's own 2,000-token
 * check. That is not a contradiction in `BAR.md` — it is two different runs
 * proving two different halves of ruling 58, and this one deliberately does NOT
 * assert the ceiling. Asserting it here would be asserting that the product
 * drops a failure to fit, which is the opposite of what ruling 52 requires.
 *
 * Driven with a verify command whose output is long: `src/gate/run.ts` carries
 * the checker's last `VERIFY_TAIL_LINES` lines into the failing check's detail,
 * so a handful of chatty failures put the blocking set over the budget without
 * a run of fifty workers.
 */
export interface OverrideObservations {
  report: string;
  exitCode: number | null;
  /** Every item in this run, all of which the harness made fail. */
  failing: readonly RecordedItem[];
  allIds: readonly string[];
  /** Ruling 58's ceiling, so the check can say which number was exceeded. */
  ceiling: number;
  /** The report's cost in tokens, measured by the caller with the same estimator. */
  tokens: number;
}

export function judgeOverride(o: OverrideObservations): Checks {
  const checks = new Checks();

  // THE PRECONDITION, ASSERTED RATHER THAN ASSUMED. If the blocking set fit
  // after all, the override never ran and this run measured nothing — which is
  // a failure of the fixture and must read as one, never as a pass.
  checks.expect(
    "the blocking set alone really does exceed the ceiling, so the override path was reached",
    o.tokens > o.ceiling,
    `${o.failing.length} failing item(s) rendered to ${o.tokens} tokens against a ${o.ceiling}-token ceiling. ` +
      "Under the ceiling means the product was never asked to choose between the two rulings, and this run proved nothing",
  );

  const blocks = new Map(o.failing.map((item) => [item.id, itemBlock(o.report, item.id, o.allIds)]));
  const dropped = o.failing.filter((item) => blocks.get(item.id) === undefined).map((item) => item.id);
  checks.expect(
    "NO failing item was dropped to fit the ceiling (ruling 52 has no exception for space)",
    o.failing.length > 0 && dropped.length === 0,
    `${o.failing.length} failing item(s); missing from a report that is over budget: ${dropped.join(", ") || "none"}`,
  );

  const absent: string[] = [];
  let expected = 0;
  for (const item of o.failing) {
    const block = blocks.get(item.id);
    for (const check of item.checks) {
      expected += 1;
      if (block === undefined || !block.includes(`${check.name}: ${check.outcome}`)) {
        absent.push(`${item.id}/${check.name}: ${check.outcome}`);
      }
    }
  }
  checks.expect(
    "and no CHECK was dropped either — fewer items, never fewer checks (ruling 52)",
    expected > 0 && absent.length === 0,
    `${expected} check(s) recorded; absent from their item's block: ${absent.join("; ") || "none"}`,
  );

  // Ruling 58 requires the excess to be STATED. A report that quietly goes over
  // is a report whose ceiling means nothing to the reader paying for it.
  //
  // AT COLUMN ZERO, and that is not decoration. MEASURED on 2026-08-19: the
  // fixture that drives this run uses a verify command whose output says the
  // words *over* and *ceiling*, and `src/gate/run.ts` carries the checker's own
  // last lines into the failing check's detail — so the harness was feeding
  // this detector its own needle, and the control that removed the product's
  // statement still passed. The product writes its run-level sentences
  // unindented and every check detail ten spaces in, so the statement is looked
  // for where the product makes it rather than anywhere in the bytes.
  //
  // AND DELIBERATELY NOT ANCHORED ON BRIGADIER'S SENTENCE, which was considered
  // on 2026-08-20 and rejected with a reason. `OVER_CEILING_HEAD` transcribes
  // the product's exact opening and it does catch the drift that actually
  // happened — but THIS check is a BAR check, and a bar check is the contract
  // every honest implementation must satisfy, not brigadier's phrasing. MEASURED
  // on 2026-08-20: `bar/fakes/honest.ts:801`, the harness's own honest
  // implementation, states the overflow as *"this report is OVER ruling 58's
  // 2,000-token ceiling: the blocking items alone cost …"* — column zero,
  // naming the number, nothing dropped, ruling 58 fully satisfied, and NOT
  // brigadier's wording. Anchoring here would fail the positive control that
  // exists to prove this bar is passable, which is the bar measuring a vendor
  // rather than a promise.
  //
  // So the exact-sentence transcription is asserted where it belongs — against
  // the FIXTURE, in `item11-structure.test.ts`, where a stale transcription is
  // the defect — and the contract stays stated as a contract: at column zero,
  // because `src/gate/run.ts` carries a checker's own words into details ten
  // spaces in and a verify command that says *over* and *ceiling* was feeding
  // this detector its own needle.
  const said = o.report
    .split("\n")
    .filter((line) => /^\S/.test(line) && /over\b/i.test(line) && /ceiling/i.test(line))
    .map((line) => line.trim());
  checks.expect(
    "the report SAYS it is over the ceiling rather than going over quietly (ruling 58)",
    said.length > 0,
    said.map((line) => excerpt(line, 160)).join(" | ") ||
      "no line says the report exceeded the ceiling — the reader is charged the excess and never told",
  );

  checks.expect(
    "a run in which every item blocks does not report success at the top level",
    o.exitCode !== null && o.exitCode !== 0,
    `exit ${o.exitCode ?? "killed on a timeout"}`,
  );

  return checks;
}
