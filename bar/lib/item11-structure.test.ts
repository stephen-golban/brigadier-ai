// SPDX-License-Identifier: Apache-2.0
/**
 * The guards item 11 now rests on, each shown FAILING.
 *
 * Ruling 62(b), and `AGENTS.md`'s own line: *every check needs a negative
 * control showing it can fail; a guard that always passes looks identical to a
 * working one.* Item 11's previous three assertions were exactly that — they
 * had tests, and the tests passed, and none of them could have caught the cap
 * hiding `fifty-4`.
 *
 * TWO THINGS ABOUT HOW THIS FILE IS WRITTEN.
 *
 * The report below is TRANSCRIBED from the product's own renderer rather than
 * invented: the head line, the two-space item line, the six-space check line
 * with its glyph, the ten-space detail, the collapse sentence and the
 * unindented `the merged result:` section were read off
 * `src/report/run-report.ts` composing a fifty-item record on 2026-08-19.
 * `bar/` imports nothing from `src/` (`bar/self-check.test.ts` enforces it), so
 * the shape is copied by hand and drifts loudly rather than silently: every
 * assertion here would fail on a rendering this file no longer describes.
 *
 * And every negative control MUTATES THE POSITIVE ONE AND ASSERTS THE MUTATION
 * APPLIED. A control that silently rewrote nothing — a `replace` whose needle
 * moved, which is the most ordinary way a suite rots — would go on passing
 * while testing the clean fixture over and over. `mutate` makes that a failure.
 */

import { describe, expect, test } from "bun:test";
import { itemHead } from "./item-head.ts";
import {
  DETAIL_INDENT,
  DETAIL_SIGIL,
  INITIAL_OUTCOME,
  OVER_CEILING_HEAD,
  atDetailIndent,
  collapsedCounts,
  detailLine,
  itemBlock,
  judgeOverride,
  judgeReportStructure,
  readSlotEvents,
  transcribedReport,
  unsigiledDetailLines,
  writeAhead,
  type RecordedItem,
  type SlotEvent,
  type StructureObservations,
} from "./item11-structure.ts";
import { estimateTokens } from "./plan.ts";

/** Rewrite, and prove the rewrite happened. A no-op mutation is a dead control. */
function mutate(text: string, from: string | RegExp, to: string): string {
  const out = text.replace(from, to);
  expect(out).not.toBe(text);
  return out;
}

const failed = (id: string, n: number): RecordedItem => ({
  id,
  number: n,
  status: "failed",
  checks: [
    { name: "worker", outcome: "pass", blocking: true },
    { name: "verify", outcome: "fail", blocking: true, qualifier: `item ${n}` },
  ],
});

/**
 * The product's rendering, transcribed. `fifty-4` and `fifty-43` both present.
 *
 * DETAIL LINES CARRY `| `, because `src/report/run-report.ts` emits its
 * `DETAIL_SIGIL` unconditionally and this fixture had them without it — the
 * fixture was the wrong side of that disagreement, corrected on 2026-08-19. The
 * `✓`/`✗` CHECK lines are not detail lines and stay unsigil'd. No assertion
 * moved: the sigil is exactly what stops a checker's output from being read as
 * an item head line, which is the property `itemHead` leans on.
 *
 * Built through `transcribedReport`/`detailLine` since 2026-08-20 so that the
 * next omission throws at load rather than being measured — see the classifier's
 * own note in `item11-structure.ts`.
 */
const REPORT = transcribedReport([
  "PARTIAL INTEGRATION — 47 of 50 items landed; 3 failed; blocked by verify: fail (3 items).",
  "run-record: /runs/r1/record.json",
  "base refs/brigadier/r1/base at cccccccccccc — every item's diff is <base>..<its ref>",
  "branch refs/heads/brigadier/r1 at bbbbbbbbbbbb — the deliverable",
  "  fifty-1: integrated — (qwen, qwen-m, medium (set, NOT confirmed — #45))",
  "      ✓ worker: pass",
  "      ✓ verify: pass (item 1)",
  "  fifty-4: failed — (qwen, qwen-m, medium (set, NOT confirmed — #45))",
  "      ✓ worker: pass",
  "      ✗ verify: fail (item 4)",
  detailLine("`/w/failing-verify` exited 1. This is the WORKER's to fix."),
  "  fifty-43: failed — (qwen, qwen-m, medium (set, NOT confirmed — #45))",
  "      ✓ worker: pass",
  "      ✗ verify: fail (item 43)",
  detailLine("`/w/failing-verify` exited 1. This is the WORKER's to fix."),
  "  2 passing item(s) collapsed to this count — the cap can hide a success and can never hide a failure (ruling 58)",
  "",
  "the merged result:",
  "  — verify (merged result): unconfigured",
]);

const FAILING = [failed("fifty-4", 4), failed("fifty-43", 43)];
const ALL_IDS = ["fifty-1", "fifty-4", "fifty-43", "fifty-7", "fifty-9"];
const PASSING = ["fifty-1", "fifty-7", "fifty-9"];

const slotsFor = (items: readonly RecordedItem[]): SlotEvent[] => {
  const events: SlotEvent[] = [];
  let line = 0;
  for (const item of items) {
    for (const check of item.checks) {
      events.push({ line: line++, type: "check-slot", item: item.number ?? 0, check: check.name, outcome: INITIAL_OUTCOME });
      events.push({ line: line++, type: "check-settled", item: item.number ?? 0, check: check.name, outcome: check.outcome });
    }
  }
  return events;
};

const CLEAN: StructureObservations = {
  report: REPORT,
  exitCode: 1,
  failing: FAILING,
  passingIds: PASSING,
  allIds: ALL_IDS,
  slots: slotsFor(FAILING),
  transcriptHasFrames: true,
};

const names = (o: StructureObservations): string[] => judgeReportStructure(o).failures.map((f) => f.name);

const OWN_LINE = "every failing item is printed as its OWN item line, not merely as a substring";
const EVERY_CHECK = "every check of a failing item is printed inside that item's block, with its outcome (ruling 52)";
const QUALIFIER = "a check's qualifier is rendered INSIDE its result string (ruling 52)";
const COLLAPSED = "passing items collapsed to a COUNT, and the count is the number actually hidden";
const WRITE_AHEAD = "each blocking check's slot was written BEFORE the check ran, holding `not-run` (ruling 52)";
const TOP_LEVEL = "a run carrying a blocking check that is not `pass` does not report success at the top level";
const DETECTOR =
  "the transcript detector fires on the transcript this run actually wrote to disk (the POSITIVE CONTROL for the absence above)";

describe("item 11 — the block parser, against the substring trap that motivated it", () => {
  test("an item's block is its own lines and stops at the next item", () => {
    const block = itemBlock(REPORT, "fifty-4", ALL_IDS) ?? "";
    expect(block).toContain("fifty-4: failed");
    expect(block).toContain("✗ verify: fail (item 4)");
    // The next item's lines are NOT in it, which is the whole point.
    expect(block).not.toContain("fifty-43");
    expect(block).not.toContain("the merged result:");
  });

  test("`fifty-43` does not satisfy a lookup for `fifty-4` — the hole this replaced", () => {
    // The old check was `report.includes(id)`, and this expression is why it
    // could not see the cap drop `fifty-4`.
    expect("fifty-43".includes("fifty-4")).toBe(true);
    const withoutFour = mutate(REPORT, /^ {2}fifty-4: [\s\S]*?(?= {2}fifty-43:)/m, "");
    expect(withoutFour).toContain("fifty-43");
    expect(itemBlock(withoutFour, "fifty-4", ALL_IDS)).toBeUndefined();
  });

  test("an item the report never mentions has no block", () => {
    expect(itemBlock(REPORT, "fifty-9", ALL_IDS)).toBeUndefined();
  });

  test("collapse counts are read only from lines that talk about collapsing", () => {
    expect(collapsedCounts(REPORT)).toContain(2);
    expect(collapsedCounts("nothing was hidden here; 47 items landed")).toEqual([]);
  });
});

describe("the shared item lookup — one anchored search, both answers", () => {
  // `headLine` (an index, `-1` when absent) and `itemLine` (the text,
  // `undefined` when absent) were two spellings of this search in two files.
  // A caller wanting the index must not have to rebuild the one wanting the
  // text, and the two must never disagree about which line belongs to an item.
  test("the index and the text name the same line", () => {
    const head = itemHead(REPORT, "fifty-4");
    expect(head?.text).toBe("  fifty-4: failed — (qwen, qwen-m, medium (set, NOT confirmed — #45))");
    expect(REPORT.split("\n")[head?.index ?? -1]).toBe(head?.text);
  });

  test("absent is `undefined`, and never `-1`", () => {
    // `-1` is truthy and indexes from the end of an array. A caller that forgot
    // to test it read the report's last line as this item's; `undefined` makes
    // that mistake throw or short-circuit instead of lying quietly.
    const absent = itemHead(REPORT, "fifty-9");
    expect(absent).toBeUndefined();
    expect(absent as unknown).not.toBe(-1);
  });

  test("anchored: `fifty-43` is not `fifty-4`, and a colon needs whitespace after it", () => {
    expect(itemHead(REPORT, "fifty-4")?.text).toContain("fifty-4: failed");
    expect(itemHead(REPORT, "fifty-4")?.text).not.toContain("fifty-43");
    expect(itemHead("  fifty-4:failed\n", "fifty-4")).toBeUndefined();
    // An id is not constrained by `src/queue/plan.ts`, so it is escaped.
    expect(itemHead("  a.b: ok", "a+b")).toBeUndefined();
    expect(itemHead("  a.b: ok", "a.b")?.index).toBe(0);
  });

  test("a detail line cannot forge a head line, because the product sigils it", () => {
    // The round-16 defect: a checker printing `zzz-2: integrated` opened a
    // block that carried a forged `✓ verify: pass` for a failing item.
    // `DETAIL_SIGIL` in `src/report/run-report.ts` puts `| ` at the front of
    // every detail line, which `^\s*<id>:` can never match. Asserted here so
    // that loosening this anchor fails a test rather than a live run.
    expect(itemHead("          zzz-2: integrated", "zzz-2")?.index).toBe(0);
    expect(itemHead("          | zzz-2: integrated", "zzz-2")).toBeUndefined();
  });

  test("the whole report and its already-split lines answer identically", () => {
    // One caller splits once and looks up many ids; the other holds only text.
    expect(itemHead(REPORT.split("\n"), "fifty-43")).toEqual(itemHead(REPORT, "fifty-43"));
  });
});

describe("item 11 — every structural guard, shown failing", () => {
  test("the positive control passes on the product's own rendering", () => {
    expect(names(CLEAN)).toEqual([]);
  });

  test("fails when the cap drops a failing item whose id is a substring of another", () => {
    const report = mutate(REPORT, /^ {2}fifty-4: [\s\S]*?(?= {2}fifty-43:)/m, "");
    expect(names({ ...CLEAN, report })).toContain(OWN_LINE);
  });

  test("fails when a shown item loses one of its checks (fewer checks, not fewer items)", () => {
    const report = mutate(REPORT, "      ✗ verify: fail (item 4)\n", "");
    expect(names({ ...CLEAN, report })).toContain(EVERY_CHECK);
  });

  test("fails when a check prints a different outcome from the one recorded", () => {
    const report = mutate(REPORT, "✗ verify: fail (item 4)", "✓ verify: pass (item 4)");
    expect(names({ ...CLEAN, report })).toContain(EVERY_CHECK);
  });

  test("fails when the qualifier is moved out of the result string into a footnote", () => {
    const report = mutate(REPORT, "✗ verify: fail (item 4)", "✗ verify: fail [see note 4]");
    expect(names({ ...CLEAN, report })).toContain(QUALIFIER);
  });

  test("fails when passing items vanish with no count stated", () => {
    const report = mutate(REPORT, /^ {2}\d+ passing item.*$/m, "");
    expect(names({ ...CLEAN, report })).toContain(COLLAPSED);
  });

  test("fails when the stated count is not the number actually hidden", () => {
    const report = mutate(REPORT, "2 passing item(s)", "9 passing item(s)");
    expect(names({ ...CLEAN, report })).toContain(COLLAPSED);
  });

  test("fails when nothing was under pressure — no passing item was hidden at all", () => {
    // A ceiling measured on a report that never had to drop anything measures
    // nothing, so this is a failure rather than a quiet pass.
    expect(names({ ...CLEAN, passingIds: ["fifty-1"] })).toContain(COLLAPSED);
  });

  test("fails when no check slot was ever opened (ruling 52's write-ahead)", () => {
    const slots = CLEAN.slots.filter((s) => s.type !== "check-slot");
    expect(slots.length).toBeLessThan(CLEAN.slots.length);
    expect(names({ ...CLEAN, slots })).toContain(WRITE_AHEAD);
  });

  test("fails when the slot was opened AFTER the check settled", () => {
    const slots = CLEAN.slots.map((s) => (s.type === "check-slot" ? { ...s, line: s.line + 1_000 } : s));
    expect(names({ ...CLEAN, slots })).toContain(WRITE_AHEAD);
  });

  test("fails when the slot was opened holding something that does not block", () => {
    const slots = CLEAN.slots.map((s) => (s.type === "check-slot" ? { ...s, outcome: "pass" } : s));
    expect(names({ ...CLEAN, slots })).toContain(WRITE_AHEAD);
  });

  test("fails when the record gave the item no ordinal to look its slot up by", () => {
    const failing = CLEAN.failing.map(({ number: _n, ...rest }) => rest);
    expect(names({ ...CLEAN, failing })).toContain(WRITE_AHEAD);
  });

  test("fails when a run carrying a blocking failure exits 0", () => {
    expect(names({ ...CLEAN, exitCode: 0 })).toContain(TOP_LEVEL);
  });

  test("fails when the headline reads as a success despite a blocking failure", () => {
    const report = mutate(REPORT, /^PARTIAL INTEGRATION.*$/m, "integrated — 50 of 50 items landed");
    expect(names({ ...CLEAN, report, exitCode: 1 })).toContain(TOP_LEVEL);
  });

  test("fails when the transcript detector matches nothing on disk", () => {
    // The absence of a transcript in the report proves nothing if the pattern
    // that looked for it cannot match a real transcript.
    expect(names({ ...CLEAN, transcriptHasFrames: false })).toContain(DETECTOR);
  });

  test("fails when the run recorded no failing item at all", () => {
    expect(names({ ...CLEAN, failing: [] })).toContain(OWN_LINE);
  });
});

describe("item 11 — the appended record, read tolerantly", () => {
  test("a half-written last line is skipped and everything before it survives", () => {
    const text = [
      JSON.stringify({ type: "run-started", at: 1, runId: "r1" }),
      JSON.stringify({ type: "check-slot", at: 2, item: 4, check: "verify", outcome: "not-run" }),
      JSON.stringify({ type: "check-settled", at: 3, item: 4, check: "verify", outcome: "fail", detail: null }),
      '{"type":"check-slot","at":4,"item',
    ].join("\n");
    const events = readSlotEvents(text);
    expect(events.map((e) => e.type)).toEqual(["check-slot", "check-settled"]);
    expect(events[0]?.line).toBeLessThan(events[1]?.line ?? -1);
  });

  test("events of other kinds, and slot events missing their fields, are not counted", () => {
    const text = [
      JSON.stringify({ type: "process-spawned", at: 1, item: 4, pid: 9 }),
      JSON.stringify({ type: "check-slot", at: 2, check: "verify", outcome: "not-run" }),
      JSON.stringify({ type: "check-slot", at: 3, item: "four", check: "verify", outcome: "not-run" }),
    ].join("\n");
    expect(readSlotEvents(text)).toEqual([]);
  });

  test("writeAhead separates `never opened` from `opened late`", () => {
    const events = slotsFor(FAILING);
    expect(writeAhead(events, 4, "verify")).toEqual({ opened: true, initial: "not-run", beforeSettle: true });
    expect(writeAhead(events, 4, "nonesuch").opened).toBe(false);
    expect(writeAhead(events, 4, "nonesuch").beforeSettle).toBe(false);
  });
});

// ------------------------------------------------------------------ override

/**
 * Two failing items whose blocks are long enough to blow a small ceiling.
 *
 * TWO DRIFTS CORRECTED ON 2026-08-20, and the first doc block written here
 * claimed the fixture was aligned when only one of them had been found — so this
 * one names what is aligned and what is still knowingly not.
 *
 * THE SIGIL. Two lines here are DETAIL lines — the two at ten spaces, the
 * checker's own words carried in by `src/gate/run.ts` — and the product sigils
 * both. The two `✗ verify:` lines sit at six spaces and are CHECK lines, which
 * the product does not sigil; the head lines, `run-record:` and the closing
 * sentence are at two spaces and column zero and are not details either.
 *
 * THE OVERFLOW SENTENCE. The fixture said *"OVER the 2,000-token ceiling because
 * every remaining item carries a blocking check, and ruling 52 …"*. The product
 * emits `` `…OVER the ${HOST_REPORT_TOKEN_CEILING}-token ceiling${share} because
 * ${why}.` `` with `why` = `` `${blocking} item(s) carry a blocking check and
 * ruling 52 has no exception for space` `` — so `2000` and not `2,000`, the
 * BLOCKING COUNT and not a quantifier, and no comma. Three differences, none of
 * them visible to the old detector's grep for two words. `bar/lib/item13-cost.test.ts`
 * transcribes the same sentence correctly, which is how the fixture was
 * established as the stale side rather than the product.
 *
 * MEASURED against `bun 1.3.14` on 2026-08-20: 1,580 chars ≈ 482 tokens as
 * found, 1,584 ≈ 484 with the sigil, 1,569 ≈ 479 with the sentence corrected too
 * — the product's sentence is 125 characters against the invented one's 140.
 * Nothing in this file is asserted against any of those numbers; `OVER` states
 * its own `tokens`, measured from these bytes, and 479 clears the 100-token
 * ceiling this fixture exists to exceed by the same margin the stale 400 did.
 *
 * KNOWINGLY NOT ALIGNED, and left deliberately: the 560-character detail line
 * could not survive a capped audience. `renderRun` passes `DETAIL_LINE_WIDTH`
 * (320) when `isCapped(audience)`, so the real bytes would be cut at 320 with
 * ` … [cut]` appended. Nothing here reads the line's width — it exists to be
 * bulk — and shortening it is a change to what this fixture is for, not a
 * transcription repair. Named so the next reader does not mistake silence for
 * agreement.
 */
const OVER_REPORT = transcribedReport([
  "NOTHING INTEGRATED — 0 of 2 items landed on the integration branch; 2 failed; blocked by verify: fail (2 items).",
  "run-record: /runs/r2/record.json",
  "  pressure-1: failed — (qwen, qwen-m, medium)",
  "      ✗ verify: fail (item 1)",
  detailLine("pressure line ".repeat(40)),
  "  pressure-2: failed — (qwen, qwen-m, medium)",
  "      ✗ verify: fail (item 2)",
  detailLine("pressure line ".repeat(40)),
  "this report is OVER the 2000-token ceiling because 2 item(s) carry a blocking check and ruling 52 has no exception for space.",
]);

const OVER_FAILING: RecordedItem[] = [
  { id: "pressure-1", number: 1, status: "failed", checks: [{ name: "verify", outcome: "fail", blocking: true, qualifier: "item 1" }] },
  { id: "pressure-2", number: 2, status: "failed", checks: [{ name: "verify", outcome: "fail", blocking: true, qualifier: "item 2" }] },
];

const OVER = {
  report: OVER_REPORT,
  exitCode: 1,
  failing: OVER_FAILING,
  allIds: ["pressure-1", "pressure-2"],
  ceiling: 100,
  // MEASURED, not asserted from memory. `tokens` is documented as "the report's
  // cost in tokens, measured by the caller with the same estimator", and
  // `bar/items/11-report-fits-the-window.ts` passes `estimateTokens(report)`; a
  // hand-typed stand-in here was a second transcription able to drift from its
  // own bytes, and had: it said 400 for a fixture that estimates 479
  // (1,569 chars ÷ 4 × 1.22, MEASURED against `bun 1.3.14` on 2026-08-20).
  // The ceiling stays 100 because the branch under test is `tokens > ceiling`,
  // and 479 > 100 by the same margin the stale 400 gave. Computed rather than
  // typed, so the two corrections above could not leave it stale a third time.
  tokens: estimateTokens(OVER_REPORT),
};

const overNames = (o: typeof OVER): string[] => judgeOverride(o).failures.map((f) => f.name);

describe("item 11 — the override, where ruling 52 beats ruling 58", () => {
  test("the positive control passes: over budget, nothing dropped, and it says so", () => {
    expect(overNames(OVER)).toEqual([]);
  });

  test("fails when the blocking set fit after all — the path was never exercised", () => {
    // The most dangerous outcome available here is a quiet pass on a run that
    // never asked the product to choose.
    expect(overNames({ ...OVER, tokens: 90 })).toContain(
      "the blocking set alone really does exceed the ceiling, so the override path was reached",
    );
  });

  test("fails when a failing item was dropped to fit", () => {
    const report = mutate(OVER_REPORT, /^ {2}pressure-2:[\s\S]*?(?=^this report)/m, "");
    expect(overNames({ ...OVER, report })).toContain(
      "NO failing item was dropped to fit the ceiling (ruling 52 has no exception for space)",
    );
  });

  test("fails when a check was dropped to fit", () => {
    const report = mutate(OVER_REPORT, "      ✗ verify: fail (item 2)\n", "");
    expect(overNames({ ...OVER, report })).toContain(
      "and no CHECK was dropped either — fewer items, never fewer checks (ruling 52)",
    );
  });

  test("fails when the report goes over the ceiling QUIETLY", () => {
    const report = mutate(OVER_REPORT, /^this report is OVER.*$/m, "");
    expect(overNames({ ...OVER, report })).toContain(
      "the report SAYS it is over the ceiling rather than going over quietly (ruling 58)",
    );
  });

  test("a CHECK DETAIL that says the words does not count as the report saying them", () => {
    // MEASURED on 2026-08-19, and the reason the statement is looked for at
    // column zero: `src/gate/run.ts` carries the checker's own output into the
    // failing check's detail, so a verify command that prints the words `over`
    // and `ceiling` made this control pass with the product's own statement
    // deleted. The harness was supplying the needle it then went looking for.
    const contaminated = mutate(OVER_REPORT, /^this report is OVER.*$/m, "").concat(
      `\n${detailLine("filler from the checker: this put the blocking set over ruling 58's ceiling.")}`,
    );
    expect(overNames({ ...OVER, report: contaminated })).toContain(
      "the report SAYS it is over the ceiling rather than going over quietly (ruling 58)",
    );
  });

  test("fails when a run in which every item blocks exits 0", () => {
    expect(overNames({ ...OVER, exitCode: 0 })).toContain(
      "a run in which every item blocks does not report success at the top level",
    );
  });
});

/**
 * WHY THE FIXTURES ARE BUILT RATHER THAN TYPED.
 *
 * `REPORT` was found writing detail lines without the product's sigil and was
 * corrected; `OVER_REPORT` had the same defect and was corrected a round later,
 * which is the evidence that a corrected transcription does not stay corrected.
 * Nothing connected either fixture to `src/report/run-report.ts`, and nothing
 * can: `bar/` imports nothing from `src/`.
 *
 * WHAT WAS DELIBERATELY NOT BUILT: a test that READS `src/report/run-report.ts`
 * off disk and greps its `DETAIL_SIGIL` out. It would catch the drift exactly —
 * and it is the import rule wearing a disguise, a harness deriving its
 * expectations from the artifact under test, which is the failure `BAR.md`
 * opens by recording. The brief's own word is *transcribe*.
 *
 * So the guard is on THIS side of the wall: the transcription is written once,
 * every fixture that claims to be product output is built through it, and the
 * classifier below decides line by line rather than consulting a list of
 * fixtures somebody has to remember to extend. It cannot notice the product
 * changing its sigil. It can, and does, notice a fixture disagreeing with what
 * this harness says the product's sigil is — which is the drift that actually
 * happened, twice.
 */
describe("the transcription is enforced, so the next omission fails at load", () => {
  test("every fixture built as product output carries the sigil on every detail line", () => {
    // Counted, not merely asserted empty: a fixture edited down to no detail
    // lines at all would satisfy "none of them is wrong" while testing nothing.
    const details = (report: string): string[] => report.split("\n").filter(atDetailIndent);
    expect(details(REPORT)).toHaveLength(2);
    expect(details(OVER_REPORT)).toHaveLength(2);
    expect(unsigiledDetailLines(REPORT)).toEqual([]);
    expect(unsigiledDetailLines(OVER_REPORT)).toEqual([]);
  });

  test("and the guard fires when it is violated — the negative control", () => {
    // The exact bytes `OVER_REPORT` held before 2026-08-20.
    const stale = ["  pressure-1: failed", "      ✗ verify: fail (item 1)", `${DETAIL_INDENT}pressure line`];
    expect(() => transcribedReport(stale)).toThrow(/fixture drift/);
    expect(unsigiledDetailLines(stale.join("\n"))).toEqual([`${DETAIL_INDENT}pressure line`]);
  });

  test("it classifies by position: a CHECK line is not a detail line and is not sigil'd", () => {
    // The whole risk in this alignment was sigilling the wrong lines. Six spaces
    // is `renderItem`'s check line; ten is what it hands `DetailWriter.lines`.
    // Six spaces is a DETAIL line in `renderRun`'s tails and the classifier
    // stays silent there on purpose — see its note. It misses those; it does not
    // accuse a check line of being an unsigil'd detail.
    expect(() => transcribedReport(["  x: failed", "      ✓ worker: pass", detailLine("out")])).not.toThrow();
    expect(unsigiledDetailLines("      ✓ worker: pass\n  x: failed\nthe merged result:")).toEqual([]);
  });

  test("THIRTEEN spaces is `admit.ts`, not a stale detail — the false accusation that was possible", () => {
    // `src/queue/admit.ts:291-292, :322-323, :335` writes continuation prose at
    // thirteen spaces and no sigil, and fixtures splice admission blocks into
    // report strings. A prefix match on ten spaces threw on bytes the product
    // genuinely writes, so the rule is ten spaces AND then a non-space.
    const admission = "             resolving a name is not driving an agent — `brigadier detect` opens a session,";
    expect(admission.startsWith(DETAIL_INDENT)).toBe(true);
    expect(atDetailIndent(admission)).toBe(false);
    expect(() => transcribedReport(["  agents     none resolved on PATH", admission])).not.toThrow();
  });

  test("the transcribed constants are the ones the assertions elsewhere depend on", () => {
    // Relaxing the sigil to make a fixture pass would otherwise be silent, and
    // `itemHead`'s forgery guard is built on this exact string.
    expect(DETAIL_SIGIL).toBe("| ");
    expect(DETAIL_INDENT).toBe(" ".repeat(10));
    expect(itemHead(detailLine("zzz-2: integrated"), "zzz-2")).toBeUndefined();
  });

  test("the fixture spells the overflow sentence the way brigadier spells it", () => {
    // The drift the sigil audit did not find, and the reason a second guard was
    // needed: `judgeOverride` greps for `over` + `ceiling` at column zero, which
    // three separate errors satisfied. Asserted here, against the FIXTURE, where
    // the transcription is the thing that must be right.
    expect(OVER_REPORT.split("\n").filter((line) => OVER_CEILING_HEAD.test(line))).toHaveLength(1);
    // Each of the three, shown failing. The thousands separator matters most:
    // `${HOST_REPORT_TOKEN_CEILING}` interpolates a bare number.
    expect(OVER_CEILING_HEAD.test("this report is OVER the 2,000-token ceiling because 2 item(s) carry a blocking check.")).toBe(false);
    expect(OVER_REPORT).toContain("because 2 item(s) carry a blocking check and ruling 52");
    expect(OVER_REPORT).not.toContain("every remaining item carries");
    expect(OVER_REPORT).not.toContain("blocking check, and ruling 52");
    // The interpolated tail is deliberately unconstrained: `share` appears only
    // when the budget was shared, and `why` differs when nothing blocks.
    expect(
      OVER_CEILING_HEAD.test(
        "this report is OVER the 2000-token ceiling — 1564 of them were left after the rest of this run's stdout was " +
          "charged against it because no item here carries a blocking check: what does not fit is the run-level sections.",
      ),
    ).toBe(true);
    // Column zero, because a checker's words arrive ten spaces in.
    expect(OVER_CEILING_HEAD.test(detailLine("this report is OVER the 2000-token ceiling because 2 item(s) carry."))).toBe(false);
  });

  test("but the BAR check is not anchored on it, and the honest fake is why", () => {
    // `bar/fakes/honest.ts:801` states the overflow as its own sentence — column
    // zero, naming the number, nothing dropped — and ruling 58 is satisfied by
    // it. A bar check anchored on brigadier's phrasing would fail the positive
    // control that exists to prove this bar is passable, which is the bar
    // measuring one vendor rather than a promise. So the exact head guards the
    // fixture, and `judgeOverride` keeps the contract.
    const honest =
      "this report is OVER ruling 58's 2,000-token ceiling: the blocking items alone cost 3,682 tokens against the " +
      "2,000 this stdout had left. Nothing was dropped to fit — ruling 52 has no exception for space.";
    expect(OVER_CEILING_HEAD.test(honest)).toBe(false);
    expect(overNames({ ...OVER, report: mutate(OVER_REPORT, /^this report is OVER.*$/m, honest) })).toEqual([]);
  });
});

/**
 * FROZEN HISTORICAL COPIES — the specification, not live code.
 *
 * `headLine` as `bar/lib/item11-structure.ts` held it, and `itemLine` as
 * `bar/lib/item13-cost.ts` held it, at the commit before they were unified
 * behind `itemHead`. Copied byte for byte, including the `-1` sentinel, the
 * inlined escape in one and the extracted `escape()` in the other, and the
 * re-split of the report on every call.
 *
 * DO NOT "FIX", TIDY, DEDUPE OR MODERNISE THEM, and do not make them share the
 * escape they both spell. They exist to be disagreed with: the point of the
 * test below is that the live `itemHead` answers exactly what these two
 * answered, and a copy edited to look like the live implementation proves only
 * that the live implementation agrees with itself. If a future change to
 * `itemHead` makes this test fail, the finding is that the change moved
 * behaviour — decide that deliberately and say so, rather than editing these.
 */
function frozenEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function frozenHeadLine(lines: readonly string[], id: string): number {
  const head = new RegExp(`^\\s*${frozenEscape(id)}:\\s`);
  return lines.findIndex((line) => head.test(line));
}

function frozenItemLine(report: string, id: string): string | undefined {
  const anchor = new RegExp(`^\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s`);
  return report.split("\n").find((line) => anchor.test(line));
}

/** Every shape the unification had to survive, one per report. */
const CORPUS: readonly string[] = [
  REPORT,
  // A forged head line inside a detail, with the product's sigil and without it.
  "fifty-43: failed\n          | zzz-2: integrated\nthe run: done",
  "fifty-43: failed\n          zzz-2: integrated\nthe run: done",
  // The prefix pair that motivated the anchor, adjacent.
  "  fifty-4: failed — x\n  fifty-43: failed\n",
  // A colon with nothing after it: `\s` is required and this must not match.
  "fifty-4:failed\n",
  "\tfifty-4: ok\n",
  "nothing here\n",
  // Regex metacharacters in an id — `src/queue/plan.ts` constrains none.
  "a.b: ok\na+b: ok\n",
  "  a.b: ok\n",
  // The same id twice: the first line wins, and both spellings must agree on it.
  "x: 1\nx: 2\n",
  "",
  "  control-good: integrated — (qwen, m, medium)",
];

const CORPUS_IDS: readonly string[] = [
  "fifty-4",
  "fifty-43",
  "fifty-9",
  "zzz-2",
  "a.b",
  "a+b",
  "x",
  "control-good",
  "missing",
  "a|b",
  "[q]",
];

describe("the unification is behaviour-preserving, against frozen copies of what it replaced", () => {
  test("`itemHead` answers what `headLine` and `itemLine` answered, on every case", () => {
    let cases = 0;
    const disagreed: string[] = [];
    for (const report of CORPUS) {
      const lines = report.split("\n");
      for (const id of CORPUS_IDS) {
        cases += 1;
        const wasIndex = frozenHeadLine(lines, id);
        const wasText = frozenItemLine(report, id);
        const now = itemHead(report, id);
        // `-1` and `undefined` are the two spellings of "no such line". The
        // migration is the only place they are allowed to differ.
        const indexAgrees = wasIndex === -1 ? now === undefined : now?.index === wasIndex;
        const textAgrees = wasText === undefined ? now === undefined : now?.text === wasText;
        // The two originals must also have agreed with EACH OTHER, or the
        // unification was hiding a real difference rather than removing a copy.
        const originalsAgree = (wasIndex === -1) === (wasText === undefined);
        // Both input shapes are one lookup.
        const shapesAgree = JSON.stringify(itemHead(lines, id)) === JSON.stringify(now);
        if (!indexAgrees || !textAgrees || !originalsAgree || !shapesAgree) {
          disagreed.push(`${JSON.stringify(report)} / ${id}: was ${wasIndex}/${JSON.stringify(wasText)}, now ${JSON.stringify(now)}`);
        }
      }
    }
    expect(disagreed).toEqual([]);
    // The corpus itself is asserted, so a case set silently emptied by an edit
    // cannot pass this as "nothing disagreed".
    expect(cases).toBe(CORPUS.length * CORPUS_IDS.length);
    expect(cases).toBeGreaterThanOrEqual(100);
  });

  test("the corpus really does exercise the cases it names", () => {
    // A differential over inputs that all miss proves only that both spellings
    // can fail to find something. These are the hits and the near-misses.
    expect(frozenHeadLine(REPORT.split("\n"), "fifty-4")).toBeGreaterThan(-1);
    expect(frozenItemLine("  fifty-4: failed — x\n  fifty-43: failed\n", "fifty-43")).toBe("  fifty-43: failed");
    expect(frozenHeadLine(["fifty-4:failed"], "fifty-4")).toBe(-1);
    expect(frozenItemLine("          | zzz-2: integrated", "zzz-2")).toBeUndefined();
    expect(frozenItemLine("          zzz-2: integrated", "zzz-2")).toBe("          zzz-2: integrated");
    expect(frozenHeadLine(["a.b: ok", "a+b: ok"], "a+b")).toBe(1);
    expect(frozenHeadLine(["x: 1", "x: 2"], "x")).toBe(0);
  });
});
