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

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The line index at which the report starts talking about `id`, or `-1`.
 *
 * Anchored: `^\s*<id>:` and nothing looser. `fifty-4` and `fifty-43` are
 * different items and a substring test cannot tell them apart.
 */
export function headLine(lines: readonly string[], id: string): number {
  const head = new RegExp(`^\\s*${escape(id)}:\\s`);
  return lines.findIndex((line) => head.test(line));
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
  const start = headLine(lines, id);
  if (start === -1) return undefined;
  const others = allIds
    .filter((other) => other !== id)
    .map((other) => headLine(lines, other))
    .filter((index) => index > start);
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
  const shownPassing = o.passingIds.filter((id) => headLine(o.report.split("\n"), id) !== -1);
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
    "the transcript detector fires on the transcript this run actually wrote to disk",
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
