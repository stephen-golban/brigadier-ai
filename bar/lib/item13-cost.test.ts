// SPDX-License-Identifier: Apache-2.0
/**
 * Item 13's deep guards, each shown FAILING.
 *
 * The reason this file exists in the words of the defect it is about:
 * amendment §19's `effort` was declared in the record, read by the reporter and
 * written by nothing, and NOTHING NOTICED — because everything that looked at
 * it printed what it found. A guard against that shape is worth exactly as much
 * as the demonstration that it rejects the shape, so every property below has a
 * negative control and every negative control asserts that its own rewrite
 * applied.
 *
 * The report fixtures are TRANSCRIBED from `src/report/run-report.ts` composing
 * a four-item record on 2026-08-19 — the `cost estimate … ; actual …` line, the
 * two ceiling sentences with their different verbs, the one-line weakened-gap
 * warning that carries the words `soft`, `hard` AND `cancel` at once, the
 * `lever active:` lines and the disclaimer. `bar/` imports nothing from `src/`,
 * so the shape is copied by hand and any drift fails here loudly.
 */

import { describe, expect, test } from "bun:test";
import type { RunRecord } from "./contract.ts";
import {
  EFFORT_ORDER,
  NO_LEVER,
  ceilingLines,
  effortInstrumentControls,
  expectedEffort,
  judgeCeilings,
  judgeDeepCost,
  judgeEffort,
  stated,
  type CeilingObservations,
  type EffortItem,
  type OneRun,
} from "./item13-cost.ts";

function mutate(text: string, from: string | RegExp, to: string): string {
  const out = text.replace(from, to);
  expect(out).not.toBe(text);
  return out;
}

const PLANTED = ["qwen", "copilot", "opencode"];
const LEVERS = [
  "byte-stable brief prefix (rulings 16 and 21): every item's brief opens with the same bytes, which is the shape ruling 21 recorded a 16.5× prompt-cache lever on. Whether any vendor cached it is not observable over ACP",
  'one worker per item and no agent pipeline: 3 concurrent, against ruling 21\'s ranking of "don\'t spawn" as the first lever',
];
/** One line in the record and one line in the report, exactly as the product joins it. */
const GAP_WARNING =
  "WEAKENED SOFT CEILING — --soft-ceiling 3,764 and --hard-ceiling 37,648 leave a gap of 33,884 tokens, and up to 3 " +
  "item(s) can be in flight when the soft ceiling trips.   Ruling 66: the soft ceiling stops NEW items and lets " +
  "in-flight ones finish; the hard ceiling   cancels work already running. With a gap this narrow the hard ceiling " +
  "may fire anyway and   cancel work the soft one had already allowed to complete.";

/**
 * The fixture's cost block. `gapWarning` comes from the contract now — the
 * reconciliation pass transcribed it — and it is the line that mentions `soft`,
 * `hard` and `cancel` at once, which is what the ceiling reader has to excise.
 */
type Cost = NonNullable<RunRecord["cost"]>;
/** Explicitly `| undefined` per member: `exactOptionalPropertyTypes` is on. */
type CostOverrides = { [K in keyof Cost]?: Cost[K] | undefined };

function costOf(extra: CostOverrides = {}): Cost {
  return {
    currency: "tokens",
    estimateLow: 57_468,
    estimateHigh: 287_340,
    provenance: "provenance: 47104 bytes per item (#14) … widened to 1–5×",
    actual: 9_412,
    quota: { qwen: "unreadable", copilot: "unreadable", opencode: "unpriceable" },
    levers: LEVERS,
    lowerBound: true,
    softCeilingHit: false,
    hardCeilingHit: false,
    ...extra,
  } as Cost;
}

function itemOf(id: string, n: number, status: string, extra: Partial<EffortItem> = {}): EffortItem & { status: string } {
  const dispatched = status === "integrated" || status === "failed";
  return {
    id,
    number: n,
    status,
    kind: "write",
    ...(dispatched
      ? {
          agent: "qwen",
          model: "qwen-m",
          effort: "medium not asserted — no effort lever is measured on this vendor",
          effortRequested: "medium",
          effortLever: NO_LEVER,
          effortDisposition: "no-lever",
          effortConfirmed: false,
        }
      : {}),
    ...extra,
  } as EffortItem & { status: string };
}

function recordOf(items: EffortItem[], cost: Cost): RunRecord {
  return {
    runId: "r1",
    integrationRef: "refs/heads/brigadier/r1",
    base: { ref: "refs/brigadier/r1/base", sha: "b".repeat(40) },
    runRoot: "/home/me/.brigadier/runs/r1",
    bindingFilter: "desirability",
    workers: 3,
    refusedDelegations: 0,
    cost,
    items: items as unknown as RunRecord["items"],
  };
}

const DISPATCHED = [itemOf("cheap", 1, "integrated"), itemOf("declared-hard", 2, "integrated", { difficulty: "hard", clampedTo: "medium" })];
const UNRUN = itemOf("fourth", 4, "unrun");

const TRIPLE_LINES = DISPATCHED.map(
  (i) => `  ${i.id}: integrated — (${String(i.agent)}, ${String(i.model)}, ${String(i.effort)})`,
).join("\n");

const COST_TAIL = [
  `cost estimate 57,468 – 287,340 tokens; actual 9,412 — a LOWER BOUND: a vendor in this run is unpriceable (ruling 70)`,
  ...LEVERS.map((l) => `  lever active: ${l}`),
  "  brigadier makes no claim to have saved anything: those are levers that were active, not a measurement of what this run would otherwise have cost (ruling 70).",
].join("\n");

const SOFT_REPORT = [
  "PARTIAL INTEGRATION — 3 of 4 items landed; 1 unrun.",
  TRIPLE_LINES,
  "  fourth: unrun",
  "      — integrate item 4: not-run (ceiling stopped dispatch)",
  COST_TAIL,
  `  ${GAP_WARNING}`,
  "  soft ceiling reached at 3,764 tokens — no further item was DISPATCHED; items already in flight were allowed to finish (ruling 66).",
].join("\n");

const HARD_REPORT = [
  "NOTHING INTEGRATED — 0 of 4 items landed; 3 cancelled; 1 unrun.",
  COST_TAIL,
  `  ${GAP_WARNING}`,
  "  HARD CEILING FIRED at 3,764 tokens — work already running was cancelled. Items in flight are `cancelled` rather than `failed`.",
  "  soft ceiling reached at 1,882 tokens — no further item was DISPATCHED; items already in flight were allowed to finish (ruling 66).",
].join("\n");

const UNCAPPED_REPORT = ["integrated — 4 of 4 items landed", TRIPLE_LINES, COST_TAIL].join("\n");

const softRecord = recordOf([...DISPATCHED, UNRUN], costOf({ softCeiling: 3_764, hardCeiling: 37_648, softCeilingHit: true, gapWarning: GAP_WARNING }));
const hardRecord = recordOf(
  [itemOf("cheap", 1, "cancelled"), itemOf("declared-hard", 2, "cancelled"), UNRUN],
  costOf({ softCeiling: 1_882, hardCeiling: 3_764, softCeilingHit: true, hardCeilingHit: true, gapWarning: GAP_WARNING }),
);
const uncappedRecord = recordOf([...DISPATCHED], costOf());

const run = (report: string, record: RunRecord): OneRun => ({ what: "x", report, record, exitCode: 1 });
const CEILINGS: CeilingObservations = {
  uncapped: run(UNCAPPED_REPORT, uncappedRecord),
  soft: run(SOFT_REPORT, softRecord),
  hard: run(HARD_REPORT, hardRecord),
};

const cnames = (o: CeilingObservations): string[] => judgeCeilings(o).failures.map((f) => f.name);
const detailOf = (o: CeilingObservations, name: string): string =>
  judgeCeilings(o).rows.find((r) => r.name === name)?.detail ?? "";

const SOFT = "the SOFT ceiling stopped new items being DISPATCHED and cancelled nothing (ruling 66)";
const NO_CANCEL = "and it did NOT report cancelling work that was already running";
const HARD = "the HARD ceiling CANCELLED work already running, and says so (ruling 66)";
const DISTINGUISH = "the report DISTINGUISHES the two: the same plan under each ceiling reads differently";
const CONTROL = "a run with NO ceilings records neither as hit and prints no ceiling event (the negative control)";

describe("item 13 — a value that is really there, versus one that was stringified", () => {
  test("the four shapes amendment §19 warns about are not values", () => {
    expect(stated(undefined)).toBeUndefined();
    expect(stated(null)).toBeUndefined();
    expect(stated("undefined")).toBeUndefined();
    expect(stated("null")).toBeUndefined();
    expect(stated("")).toBeUndefined();
    expect(stated("   ")).toBeUndefined();
    expect(stated(42)).toBeUndefined();
    expect(stated("medium")).toBe("medium");
  });

  test("ruling 31's derivation is recomputed rather than read back", () => {
    expect(expectedEffort("write", "easy")).toBe("low");
    expect(expectedEffort("write", "medium")).toBe("medium");
    expect(expectedEffort("write", "hard")).toBe("high");
    // Ruling 49: a read-only item's directory is never diffed, so a more
    // expensive attempt buys an answer nobody can check. One step down.
    expect(expectedEffort("read-only", "hard")).toBe("medium");
    expect(expectedEffort("read-only", "easy")).toBe("low");
    // An item that declares nothing gets the middle, which is also what
    // `difficulty` defaults to.
    expect(expectedEffort("write", undefined)).toBe("medium");
    // Ruling 30's ceiling is in the vocabulary, and `xhigh` is above it.
    expect(EFFORT_ORDER.indexOf("xhigh")).toBeGreaterThan(EFFORT_ORDER.indexOf("high"));
  });
});

describe("item 13 — the effort half, shown failing on every shape that got through before", () => {
  const judge = (items: EffortItem[], report = SOFT_REPORT): string[] =>
    judgeEffort({ report, items, leverlessVendors: PLANTED }).failures.map((f) => f.name);
  const VALUE = "every dispatched item records an effort that is a VALUE, not a stringified absence (ruling 29)";
  const DERIVED = "the recorded effort is what ruling 31 DERIVES from (kind, difficulty), never something else";
  const CEILING = "no item exceeds ruling 30's `high` ceiling — this run asked for no edge case";
  const LEVER = "a vendor with no measured effort lever records `none measured` (ruling 40)";
  const CONFIRMED = "`effortConfirmed` is the literal `false` on every dispatched item (#45)";
  const PRINTED = "the report prints each dispatched item's triple, with the effort inside it (ruling 29)";

  test("the positive control passes", () => {
    expect(judge([...DISPATCHED, UNRUN])).toEqual([]);
  });

  test("fails on amendment §19's own shape: the field declared and never assigned", () => {
    const items = DISPATCHED.map(({ effort: _e, effortRequested: _r, ...rest }) => rest as EffortItem);
    expect(judge(items)).toContain(VALUE);
  });

  test("fails on the stringified absence — a check that prints the field would pass here", () => {
    expect(`${undefined}`).toBe("undefined");
    expect(judge(DISPATCHED.map((i) => ({ ...i, effortRequested: "undefined", effort: "undefined" })))).toContain(VALUE);
  });

  test("fails when the grade is not in ruling 30's vocabulary at all", () => {
    expect(judge(DISPATCHED.map((i) => ({ ...i, effortRequested: "thorough" })))).toContain(VALUE);
  });

  test("fails when the grade is a value but not the one ruling 31 derives", () => {
    expect(judge(DISPATCHED.map((i) => ({ ...i, effortRequested: "low" })))).toContain(DERIVED);
  });

  test("fails when an item is above ruling 30's ceiling without the operator's flag", () => {
    expect(judge(DISPATCHED.map((i) => ({ ...i, effortRequested: "xhigh" })))).toContain(CEILING);
  });

  test("fails when a vendor with no measured lever claims one (ruling 40)", () => {
    expect(judge(DISPATCHED.map((i) => ({ ...i, effortLever: "session/set_model" })))).toContain(LEVER);
  });

  test("fails when the lever field is absent rather than saying `none measured`", () => {
    const items = DISPATCHED.map(({ effortLever: _l, ...rest }) => rest as EffortItem);
    expect(judge(items)).toContain(LEVER);
  });

  test("fails when nothing ran on a vendor this harness planted — the case that measures nothing", () => {
    expect(judge(DISPATCHED.map((i) => ({ ...i, agent: "somebody-else" })))).toContain(LEVER);
  });

  test("fails on a confirmation #45 says nobody can earn — including a boolean that happens to be false today", () => {
    expect(judge(DISPATCHED.map((i) => ({ ...i, effortConfirmed: true })))).toContain(CONFIRMED);
    const items = DISPATCHED.map(({ effortConfirmed: _c, ...rest }) => rest as EffortItem);
    expect(judge(items)).toContain(CONFIRMED);
  });

  test("fails when the triple is recorded and never printed", () => {
    const report = mutate(SOFT_REPORT, /\(qwen, qwen-m, medium[^)]*\)/g, "(qwen, qwen-m)");
    expect(judge([...DISPATCHED, UNRUN], report)).toContain(PRINTED);
  });

  test("fails when ONE item's triple is dropped and another item's identical triple remains", () => {
    // THE HOLE THIS TEST FOUND, on 2026-08-19. Every item in item 13's plan
    // runs on the same vendor at the same grade, so the triples are identical
    // strings — and a whole-report `includes` was satisfied for all four items
    // by whichever one the report still printed. Anchoring on the item's own
    // line is what makes a dropped triple visible.
    const report = mutate(SOFT_REPORT, /^ {2}cheap: integrated —.*$/m, "  cheap: integrated");
    expect(report).toContain("(qwen, qwen-m, medium not asserted");
    expect(judge([...DISPATCHED, UNRUN], report)).toContain(PRINTED);
  });

  test("fails when the report gives a dispatched item no line at all", () => {
    const report = mutate(SOFT_REPORT, /^ {2}cheap: integrated —.*$/m, "");
    expect(judge([...DISPATCHED, UNRUN], report)).toContain(PRINTED);
  });

  test("fails when nothing was dispatched at all", () => {
    expect(judge([UNRUN])).toContain(VALUE);
  });

  test("the instrument's own controls all pass, and there are five of them", () => {
    const rows = effortInstrumentControls().rows;
    expect(rows.filter((r) => !r.ok)).toEqual([]);
    expect(rows.length).toBe(5);
  });
});

describe("item 13 — the two ceilings, as two events", () => {
  test("the gap warning is excised before any ceiling line is read", () => {
    // The warning is ONE line carrying `soft`, `hard` and `cancel`, so a
    // keyword test on the soft run reads it as a hard-ceiling cancellation.
    expect(GAP_WARNING).toContain("hard");
    expect(GAP_WARNING).toContain("cancel");
    expect(ceilingLines(SOFT_REPORT, softRecord).some((l) => /cancel/i.test(l))).toBe(false);
    // And without the record's copy of it, the same report reads the other way
    // — which is the instrument defect this excision removes.
    expect(ceilingLines(SOFT_REPORT, undefined).some((l) => /cancel/i.test(l))).toBe(true);
  });

  test("the positive control passes", () => {
    expect(cnames(CEILINGS)).toEqual([]);
  });

  test("fails when a run given no ceilings prints a ceiling event anyway", () => {
    expect(cnames({ ...CEILINGS, uncapped: run(SOFT_REPORT, uncappedRecord) })).toContain(CONTROL);
  });

  test("fails when a run given no ceilings records one as hit", () => {
    const record = recordOf([...DISPATCHED], costOf({ softCeilingHit: true }));
    expect(cnames({ ...CEILINGS, uncapped: run(UNCAPPED_REPORT, record) })).toContain(CONTROL);
  });

  test("fails when the soft ceiling cancelled work already running", () => {
    const record = recordOf(
      [itemOf("cheap", 1, "cancelled"), ...DISPATCHED.slice(1), UNRUN],
      costOf({ softCeiling: 3_764, hardCeiling: 37_648, softCeilingHit: true, gapWarning: GAP_WARNING }),
    );
    expect(cnames({ ...CEILINGS, soft: run(SOFT_REPORT, record) })).toContain(SOFT);
  });

  test("fails when the soft ceiling stopped nothing — every item ran", () => {
    const record = recordOf([...DISPATCHED], costOf({ softCeiling: 3_764, softCeilingHit: true }));
    expect(cnames({ ...CEILINGS, soft: run(SOFT_REPORT, record) })).toContain(SOFT);
  });

  test("fails when the soft run reports a cancellation in a ceiling line of its own", () => {
    const report = mutate(
      SOFT_REPORT,
      "  soft ceiling reached at 3,764 tokens — no further item was DISPATCHED",
      "  soft ceiling reached at 3,764 tokens — running work was cancelled and no further item was DISPATCHED",
    );
    expect(cnames({ ...CEILINGS, soft: run(report, softRecord) })).toContain(NO_CANCEL);
  });

  test("fails when the hard ceiling cancelled nothing", () => {
    const record = recordOf([...DISPATCHED, UNRUN], costOf({ hardCeiling: 3_764, hardCeilingHit: true }));
    expect(cnames({ ...CEILINGS, hard: run(HARD_REPORT, record) })).toContain(HARD);
  });

  test("fails when the hard ceiling fired and the report never says work was cancelled", () => {
    const report = mutate(HARD_REPORT, /^ {2}HARD CEILING FIRED.*$/m, "  a ceiling was reached.");
    expect(cnames({ ...CEILINGS, hard: run(report, hardRecord) })).toContain(HARD);
  });

  test("fails when both runs read identically — two words in one report is not a distinction", () => {
    expect(cnames({ ...CEILINGS, hard: run(SOFT_REPORT, hardRecord) })).toContain(DISTINGUISH);
  });

  test("a ceiling that did not fire says NOT ENFORCED when the run spent past it", () => {
    const record = recordOf([...DISPATCHED, UNRUN], costOf({ softCeiling: 100, actual: 9_412 }));
    expect(detailOf({ ...CEILINGS, soft: run(SOFT_REPORT, record) }, SOFT)).toContain("NOT ENFORCED");
  });

  test("and says NEVER REACHED when the run spent less than the number it was calibrated to", () => {
    // #44 measured 15× between two identical runs, so this is the reading that
    // sends the reader to the calibration rather than to the product.
    const record = recordOf([...DISPATCHED, UNRUN], costOf({ softCeiling: 90_000, actual: 9_412 }));
    const detail = detailOf({ ...CEILINGS, soft: run(SOFT_REPORT, record) }, SOFT);
    expect(detail).toContain("NEVER REACHED");
    expect(detail).not.toContain("NOT ENFORCED");
  });
});

describe("item 13 — quota, levers and the numbers, shown failing", () => {
  const judge = (over: { report?: string; record?: RunRecord; plantedVendors?: string[] } = {}): string[] =>
    judgeDeepCost({
      report: SOFT_REPORT,
      record: softRecord,
      plantedVendors: PLANTED,
      savingsClaims: (report) =>
        report.split("\n").filter((l) => /\b(saved|savings)\b/i.test(l) && !/no claim|cannot be read as/i.test(l)),
      ...over,
    })
      .failures.map((f) => f.name);
  const NUMBERS = "the report prints the actual spend and both ends of the predicted range, as numbers";
  const BOUND = "the actual spend is at or below the predicted UPPER bound (ruling 66)";
  const QUOTA = "quota is reported for every vendor this run could have used, as read / unreadable / unpriceable";
  const OPENCODE = "opencode is `unpriceable` and the run's total is a LOWER BOUND (#42)";
  const LEVER_NAMES = "every lever the record lists is printed in the report, by name (ruling 70)";
  const MULTIPLIER = "a line carrying a measured multiplier cannot be read as a saving (ruling 70)";
  const DISCLAIMER = "the levers are printed beside an explicit disclaimer, in the same block (ruling 70)";

  test("the positive control passes", () => {
    expect(judge()).toEqual([]);
  });

  test("fails when `actual` is absent from the record", () => {
    const record = recordOf([...DISPATCHED, UNRUN], costOf({ actual: undefined, softCeilingHit: true }));
    expect(judge({ record })).toContain(NUMBERS);
  });

  test("fails when `actual` is recorded and never printed — the word `actual` is not the number", () => {
    const report = mutate(SOFT_REPORT, "actual 9,412", "actual not measured");
    expect(report).toContain("actual");
    expect(judge({ report })).toContain(NUMBERS);
  });

  test("fails when the range's ends are not printed", () => {
    const report = mutate(SOFT_REPORT, "cost estimate 57,468 – 287,340 tokens; ", "cost estimate: a range; ");
    expect(judge({ report })).toContain(NUMBERS);
  });

  test("fails when the run spent more than its own upper bound", () => {
    const record = recordOf([...DISPATCHED, UNRUN], costOf({ actual: 400_000, softCeilingHit: true }));
    const report = mutate(SOFT_REPORT, "actual 9,412", "actual 400,000");
    expect(judge({ record, report })).toContain(BOUND);
  });

  test("fails when a vendor this harness planted has no quota entry", () => {
    const record = recordOf([...DISPATCHED, UNRUN], costOf({ quota: { qwen: "unreadable" } }));
    expect(judge({ record })).toContain(QUOTA);
  });

  test("fails when a quota entry is not one of the three legal answers", () => {
    const record = recordOf(
      [...DISPATCHED, UNRUN],
      costOf({ quota: { qwen: "fine" as "read", copilot: "unreadable", opencode: "unpriceable" } }),
    );
    expect(judge({ record })).toContain(QUOTA);
  });

  test("fails when opencode is priced optimistically (#42)", () => {
    const record = recordOf(
      [...DISPATCHED, UNRUN],
      costOf({ quota: { qwen: "unreadable", copilot: "unreadable", opencode: "read" }, lowerBound: false }),
    );
    expect(judge({ record })).toContain(OPENCODE);
  });

  test("fails when opencode is unpriceable and the total is not called a lower bound", () => {
    const record = recordOf([...DISPATCHED, UNRUN], costOf({ lowerBound: false }));
    expect(judge({ record })).toContain(OPENCODE);
  });

  test("fails when opencode was never on this run's PATH — the branch nobody exercised", () => {
    // The old check was `!used.includes("opencode") || …`, which is true for
    // every fleet without it. Keying on what the harness planted makes the
    // absence a failure instead of a free pass.
    expect(judge({ plantedVendors: ["qwen", "copilot"] })).toContain(OPENCODE);
  });

  test("fails when the record lists a lever the report never printed", () => {
    const record = recordOf([...DISPATCHED, UNRUN], costOf({ levers: ["notARealLever"] }));
    expect(judge({ record })).toContain(LEVER_NAMES);
  });

  test("fails when the lever list is empty — a count would have accepted this", () => {
    const record = recordOf([...DISPATCHED, UNRUN], costOf({ levers: [] }));
    expect(judge({ record })).toContain(LEVER_NAMES);
  });

  test("fails when a line reads as a saving (ruling 70)", () => {
    expect(judge({ report: `${SOFT_REPORT}\nthis run saved 16.5× on tokens` })).toContain(MULTIPLIER);
  });

  test("fails when the disclaimer is gone from the lever block", () => {
    const report = mutate(SOFT_REPORT, /^ {2}brigadier makes no claim.*$/m, "");
    expect(judge({ report })).toContain(DISCLAIMER);
  });

  test("ruling 70's own required phrasing is not itself a violation", () => {
    // A check that rejects the wording it exists to require is broken, not
    // strict — and the lever line names 16.5× on purpose.
    expect(judge()).toEqual([]);
    expect(SOFT_REPORT).toContain("16.5×");
  });
});
