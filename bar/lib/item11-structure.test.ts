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
  INITIAL_OUTCOME,
  collapsedCounts,
  itemBlock,
  judgeOverride,
  judgeReportStructure,
  readSlotEvents,
  writeAhead,
  type RecordedItem,
  type SlotEvent,
  type StructureObservations,
} from "./item11-structure.ts";

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
 */
const REPORT = [
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
  "          | `/w/failing-verify` exited 1. This is the WORKER's to fix.",
  "  fifty-43: failed — (qwen, qwen-m, medium (set, NOT confirmed — #45))",
  "      ✓ worker: pass",
  "      ✗ verify: fail (item 43)",
  "          | `/w/failing-verify` exited 1. This is the WORKER's to fix.",
  "  2 passing item(s) collapsed to this count — the cap can hide a success and can never hide a failure (ruling 58)",
  "",
  "the merged result:",
  "  — verify (merged result): unconfigured",
].join("\n");

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

/** Two failing items whose blocks are long enough to blow a small ceiling. */
const OVER_REPORT = [
  "NOTHING INTEGRATED — 0 of 2 items landed on the integration branch; 2 failed; blocked by verify: fail (2 items).",
  "run-record: /runs/r2/record.json",
  "  pressure-1: failed — (qwen, qwen-m, medium)",
  "      ✗ verify: fail (item 1)",
  `          ${"pressure line ".repeat(40)}`,
  "  pressure-2: failed — (qwen, qwen-m, medium)",
  "      ✗ verify: fail (item 2)",
  `          ${"pressure line ".repeat(40)}`,
  "this report is OVER the 2,000-token ceiling because every remaining item carries a blocking check, and ruling 52 has no exception for space.",
].join("\n");

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
  tokens: 400,
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
      "\n          filler from the checker: this put the blocking set over ruling 58's ceiling.",
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
