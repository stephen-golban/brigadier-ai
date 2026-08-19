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
 * The report fixtures are TRANSCRIBED from `src/report/run-report.ts`,
 * `src/queue/admit.ts`, `src/queue/estimate.ts` and `src/queue/execute.ts`
 * composing a four-item record on 2026-08-19. `bar/` imports nothing from
 * `src/`, so the shape is copied by hand and any drift fails here loudly.
 *
 * THREE THINGS THE FIXTURES GAINED ON 2026-08-19, each because the harness
 * passed here and failed against `dist/brigadier`, which means the fixture was
 * not a fixture for the check it was a fixture to:
 *
 *   THE ADMISSION BLOCK. A host session's collapsed per-item block says *"the
 *   ceiling is on everything this process writes"* — ruling 58's REPORT-SIZE
 *   ceiling, in a run that was given no ruling-66 ceiling at all. `/ceiling/i`
 *   counted it as a ceiling event and the negative control failed against the
 *   real binary while passing here, because no fixture here had ever contained
 *   an admission block.
 *
 *   THE WEAKENED-GAP WARNING, IN BOTH OF ITS FORMS. `src/cli.ts:499` prints
 *   `narrowGapLines` ONE PER LINE to stderr before the run; `src/queue/
 *   execute.ts:2069` puts the SAME lines into the record joined by a space, and
 *   `src/report/run-report.ts:394` prints that joined copy. A report is
 *   `stdout + stderr`, so it holds both. The fixture held only the joined one,
 *   so an excision that split the report on the record's copy looked complete.
 *
 *   AN ITEM WHOSE MODEL NOTHING ROUTED. Every fixture item ran on `qwen` with a
 *   model, so ruling 29's absent second member — measured on `copilot`, whose
 *   ACP session advertises none — was never exercised in either direction.
 */

import { describe, expect, test } from "bun:test";
import type { RunRecord } from "./contract.ts";
import {
  EFFORT_ORDER,
  NO_LEVER,
  UNROUTED_MODEL,
  CEILING_EVENTS,
  CEILING_NON_EVENTS,
  bounded,
  ceilingLines,
  classifyCeilingLine,
  costLines,
  effortInstrumentControls,
  expectedEffort,
  expectedTriple,
  judgeCeilings,
  judgeDeepCost,
  judgeEffort,
  stated,
  unrecognisedCeilingLines,
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

/**
 * `src/queue/estimate.ts:194`'s `narrowGapLines`, as the CLI writes them —
 * one per line, on stderr, before anything is spent.
 *
 * The paragraph that carries `soft`, `hard` AND `cancel` at once. It is not a
 * ceiling event: it is a statement about the PAIR the operator handed in, made
 * before the run and printed whether or not either ceiling ever acts.
 */
const SOFT_CEILING = 3_764;
const HARD_CEILING = 37_648;
const WORKERS = 3;
/**
 * `src/queue/estimate.ts`, RECOMPUTED rather than typed out.
 *
 * The first version of this fixture invented its numbers — `11,294`, `33,882`,
 * `37,646` — and a blind critic showed the invention was self-refuting: with a
 * reserve of 33,882 and a gap of 33,884, `estimate.ts:180`'s
 * `if (hard - soft > reserve) return null` means the product emits NO warning
 * at all for the pair the fixture depicted. A fixture that shows the product
 * saying something it would not say is not a transcription.
 *
 * So the constants are transcribed (`MEASURED_ITEM_BYTES = 46 * 1024`,
 * `CHARS_PER_TOKEN = 4`, `NAIVE_CORRECTION = 1.22`, `SPREAD_HIGH = 5`) and the
 * arithmetic is done here: `itemCeilingReserve()` is 71,835, which the module's
 * own comment at `estimate.ts:123` states independently, and the reserve that
 * has to fit in the gap is that times the worker count.
 */
const ITEM_RESERVE = Math.ceil(((46 * 1024) / 4) * 1.22) * 5;
const RESERVE = ITEM_RESERVE * WORKERS;
const n = (v: number): string => v.toLocaleString("en-US");

const GAP_WARNING_LINES = [
  `WEAKENED SOFT CEILING — --soft-ceiling ${n(SOFT_CEILING)} and --hard-ceiling ${n(HARD_CEILING)} leave a gap of ` +
    `${n(HARD_CEILING - SOFT_CEILING)} tokens, and up to ${WORKERS} item(s) can be in flight when the soft ceiling trips.`,
  // `${MEASURED_ITEM_BYTES}` is interpolated raw, so it carries no comma.
  `  Each of them can still spend ${n(ITEM_RESERVE)} tokens (47104 bytes per #14, widened 5× because #44 measured 15× between`,
  `  two identical runs), so the reserve that has to fit in the gap is ${n(RESERVE)}.`,
  "  Ruling 66: the soft ceiling stops NEW items and lets in-flight ones finish; the hard ceiling",
  "  cancels work already running. With a gap this narrow the hard ceiling may fire anyway and",
  "  cancel work the soft one had already allowed to complete.",
  "  The run PROCEEDS: you asked for a hard ceiling and it is honoured. What is weakened is the",
  "  soft one, and the report names which ceiling actually fired. To restore it, raise",
  `  --hard-ceiling above ${n(SOFT_CEILING + RESERVE)}.`,
];
/** `src/queue/execute.ts:2069` — the record's copy is the SAME lines, joined by a space. */
const GAP_WARNING = GAP_WARNING_LINES.join(" ");

/**
 * `src/queue/admit.ts:363` — the per-item block a host session gets.
 *
 * Ruling 58's ceiling is on the report's own SIZE. It has nothing to do with
 * ruling 66 and it prints on every host-session run, ceilings or none.
 */
const ADMISSION = [
  "admitted — /tmp/plan.json: 4 item(s) in 1 wave(s)",
  "  items      4 item(s); per-item admission facts are COLLAPSED for a host session (ruling 58: the ceiling is on " +
    "everything this process writes, not on the report alone).",
  "             they were computed from /tmp/plan.json and every one of them is in the run record.",
];

/**
 * The fixture's cost block. `gapWarning` comes from the contract now — the
 * reconciliation pass transcribed it.
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

const EFFORT_TEXT = "medium not asserted — no effort lever is measured on this vendor";

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
          effort: EFFORT_TEXT,
          effortRequested: "medium",
          effortLever: NO_LEVER,
          effortDisposition: "no-lever",
          effortConfirmed: false,
        }
      : {}),
    ...extra,
  } as EffortItem & { status: string };
}

/** An item whose `model` key is genuinely ABSENT, the way `copilot` records one. */
function unroutedItem(id: string, n: number): EffortItem & { status: string } {
  const { model: _model, ...rest } = itemOf(id, n, "integrated", { agent: "copilot" });
  return rest as EffortItem & { status: string };
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

/**
 * `src/report/run-report.ts:95`, transcribed — the PRODUCT's spelling of the
 * triple, written with the product's own `??` rather than with anything this
 * harness uses.
 *
 * Deliberately NOT `expectedTriple`. A fixture rendered by the function under
 * test agrees with it by construction and can never catch it disagreeing with
 * the product, which is precisely the defect of 2026-08-19: the expectation
 * said `(copilot, , …)`, the failure message said `(copilot, undefined, …)` and
 * `dist/brigadier` said `(copilot, unrouted, …)`. The test below asserts the
 * two independent spellings match.
 */
function productTriple(item: EffortItem): string {
  return `(${String(item.agent)}, ${item.model ?? "unrouted"}, ${String(item.effort ?? "effort NOT recorded")})`;
}

function productItemLine(item: EffortItem & { status: string }): string {
  const clamp =
    item.difficulty === undefined
      ? ""
      : ` — ${item.difficulty === item.clampedTo ? `difficulty: ${item.difficulty}` : `difficulty: ${item.difficulty} (clamped to ${item.clampedTo ?? "?"})`}`;
  return `  ${item.id}: ${item.status}${clamp} — ${productTriple(item)} — attempts 1 of 2`;
}

// `cheap` and `third` both run on copilot with NO model, which does two jobs at
// once: it exercises ruling 29's absent second member, and it gives the report
// two IDENTICAL triples so the whole-report-containment hole below still has
// something to hide behind.
const CHEAP = unroutedItem("cheap", 1);
const THIRD = unroutedItem("third", 3);
const DECLARED_HARD = itemOf("declared-hard", 2, "integrated", { difficulty: "hard", clampedTo: "medium" });
const DISPATCHED = [CHEAP, DECLARED_HARD, THIRD];
const UNRUN = itemOf("fourth", 4, "unrun");

const TRIPLE_LINES = DISPATCHED.map(productItemLine).join("\n");

const COST_TAIL = [
  `cost estimate 57,468 – 287,340 tokens; actual 9,412 — a LOWER BOUND: a vendor in this run is unpriceable (ruling 70)`,
  ...LEVERS.map((l) => `  lever active: ${l}`),
  "  brigadier makes no claim to have saved anything: those are levers that were active, not a measurement of what this run would otherwise have cost (ruling 70).",
].join("\n");

/** `src/report/run-report.ts:573` — printed only beside a ceiling that FIRED. */
const PROVENANCE =
  "  the ceiling is the primary control and the estimate is not: #44 measured 427,723 against 28,245 bytes on two " +
  "identical runs, so no prediction is load-bearing enough to be the thing that stops a run. The number above was " +
  "measured as this run happened.";

const SOFT_EVENT =
  `  soft ceiling reached at ${n(SOFT_CEILING)} tokens — no further item was DISPATCHED; items already in flight ` +
  "were allowed to finish (ruling 66).";
const HARD_EVENT =
  `  HARD CEILING FIRED at ${n(HARD_CEILING)} tokens — work already running was cancelled. Items in flight are ` +
  "`cancelled` rather than `failed`: they did not fail at anything, brigadier stopped them (ruling 66).";
/**
 * `src/queue/execute.ts:1235` — the hard ceiling on STDERR, as it fires.
 *
 * THE LINE A WHITELIST OF REPORT SENTENCES MISSED. `bar/items/13-cost-model.ts`
 * reads `stdout + stderr`, so this is in the text every row here scans; it is
 * the most explicit statement the product ever makes that running work was
 * cancelled, and it names the workers. A blind critic showed on 2026-08-19 that
 * without it a SOFT run which cancelled work already running passed *and it did
 * NOT report cancelling work that was already running*.
 */
const HARD_STDERR =
  `HARD CEILING — ${n(HARD_CEILING)} tokens reached. \`session/cancel\` sent to 3 live worker(s) and each is ` +
  "killed immediately: ruling 66's hard ceiling cancels work already running, and `session/cancel` is an " +
  "unacknowledged notification, so the kill is the mechanism and the cancel is the courtesy.";

/**
 * `src/report/run-report.ts:770` and `:816` — ruling 52's and ruling 58's prose
 * about the REPORT's own size.
 *
 * `:770` did not exist at `HEAD`: it was added to `src/report/run-report.ts` in
 * this same round, by another builder, while this file was being written. It
 * carries the word `ceiling` and cites ruling 52, so a blacklist keyed on
 * ruling 58 would have missed it — which is the argument for the anti-drift row
 * rather than for a longer list.
 */
/**
 * `src/report/run-report.ts:803`, as `dist/brigadier` wrote it on 2026-08-19.
 *
 * Quoted from the failure this row produced against a live run rather than
 * retyped from the template: `${share}` and `${why}` are both interpolated and
 * both moved today, and a sample composed from the source would agree with a
 * pattern composed from the same source while disagreeing with the binary.
 */
const OVER_BUDGET =
  "this report is OVER the 2000-token ceiling — 1564 of them were left after the rest of this run's stdout was " +
  "charged against it because 3 item(s) carry a blocking check and ruling 52 has no exception for space.";

const REPORT_BUDGET = [
  "  2 passing item(s) collapsed to this count — the cap can hide a success and can never hide a failure (ruling 58)",
];

const SOFT_REPORT = [
  // stderr, before the run: `src/cli.ts:499` writes these one per line.
  ...GAP_WARNING_LINES,
  ...ADMISSION,
  "PARTIAL INTEGRATION — 3 of 4 items landed; 1 unrun.",
  TRIPLE_LINES,
  "  fourth: unrun",
  "      ✗ integrate item 4: not-run (ceiling stopped dispatch)",
  `          the soft ceiling (${n(SOFT_CEILING)} tokens) stopped dispatch before this item was given a directory. ` +
    "Remedy: raise the ceiling, or split the plan.",
  ...REPORT_BUDGET,
  COST_TAIL,
  // stdout, in the report: the record's joined copy of the same warning.
  `  ${GAP_WARNING}`,
  SOFT_EVENT,
  PROVENANCE,
].join("\n");

const HARD_REPORT = [
  ...GAP_WARNING_LINES,
  // stderr, as the ceiling fires and the workers are killed.
  HARD_STDERR,
  ...ADMISSION,
  "NOTHING INTEGRATED — 0 of 4 items landed; 3 cancelled; 1 unrun.",
  "  fourth: unrun",
  "      ✗ integrate item 4: not-run (ceiling stopped dispatch)",
  ...REPORT_BUDGET,
  COST_TAIL,
  `  ${GAP_WARNING}`,
  HARD_EVENT,
  `  soft ceiling reached at ${n(1_882)} tokens — no further item was DISPATCHED; items already in flight were allowed to finish (ruling 66).`,
  PROVENANCE,
].join("\n");

/**
 * The run that was given NO ceilings — and which still says the word, because
 * ruling 58's report budget and ruling 52's collapse rule both name a ceiling.
 */
const UNCAPPED_REPORT = [
  ...ADMISSION,
  "integrated — 4 of 4 items landed",
  TRIPLE_LINES,
  ...REPORT_BUDGET,
  COST_TAIL,
].join("\n");

const softRecord = recordOf([...DISPATCHED, UNRUN], costOf({ softCeiling: SOFT_CEILING, hardCeiling: HARD_CEILING, softCeilingHit: true, gapWarning: GAP_WARNING }));
const hardRecord = recordOf(
  [itemOf("cheap", 1, "cancelled"), itemOf("declared-hard", 2, "cancelled"), UNRUN],
  costOf({ softCeiling: 1_882, hardCeiling: HARD_CEILING, softCeilingHit: true, hardCeilingHit: true, gapWarning: GAP_WARNING }),
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
const HARD = "the HARD ceiling CANCELLED work already running, and says so — in the report AND as it fires (ruling 66)";
const PROV_ROW = "a ceiling that FIRED prints ruling 66's ordering: the ceiling is the primary control, the estimate is not";
const DISTINGUISH = "the report DISTINGUISHES the two: the same plan under each ceiling reads differently";
const CONTROL = "a run with NO ceilings records neither as hit and prints no ceiling event (the negative control)";
const DRIFT = "every line that says `ceiling` is classified as ruling 66 acting, or as prose that is not (the anti-drift row)";

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

describe("item 13 — ruling 29's triple, and the three spellings of its missing member", () => {
  test("the harness's expectation is the PRODUCT's spelling, member for member", () => {
    // The defect of 2026-08-19, as an equality. `expectedTriple` and
    // `productTriple` are written independently — one uses `stated`, the other
    // the product's own `??` — and the check is worthless the moment they part.
    for (const item of DISPATCHED) expect(expectedTriple(item).want).toBe(productTriple(item));
  });

  test("a model nothing routed is NAMED, never blank and never the word `undefined`", () => {
    const want = expectedTriple(CHEAP).want ?? "";
    expect(want).toBe(`(copilot, ${UNROUTED_MODEL}, ${EFFORT_TEXT})`);
    // The two spellings that were in this file and in its failure message.
    expect(want).not.toContain("(copilot, ,");
    expect(want).not.toContain("undefined");
  });

  test("a `model` that holds a stringified absence is a defect, not an unrouted model", () => {
    // Laundering `"undefined"` into `unrouted` would make the harness disagree
    // with the report it is reading: the product prints a non-empty string as
    // it stands, so `(copilot, undefined, …)` is what an operator would see.
    for (const value of ["undefined", "null", "", "   "]) {
      const got = expectedTriple({ ...CHEAP, model: value });
      expect(got.want).toBeUndefined();
      expect(got.missing).toContain("present, and not a name");
    }
  });

  test("an item with no rendered effort has no triple to require — the product's own wording is not accepted", () => {
    const { effort: _e, ...rest } = CHEAP;
    const got = expectedTriple(rest as EffortItem);
    expect(got.want).toBeUndefined();
    // `src/report/run-report.ts:95` prints `effort NOT recorded`. Mirroring it
    // here would let an item with no effort satisfy the effort check.
    expect(got.missing).not.toContain("effort NOT recorded is fine");
    expect(got.missing).toContain("Amendment §19's shape");
  });

  test("a dispatched item with no agent has no triple to require, and says so by name", () => {
    const { agent: _a, ...rest } = CHEAP;
    expect(expectedTriple(rest as EffortItem).missing).toContain("NO agent");
  });
});

describe("item 13 — the effort half, shown failing on every shape that got through before", () => {
  const judge = (items: EffortItem[], report = SOFT_REPORT): string[] =>
    judgeEffort({ report, items, leverlessVendors: PLANTED }).failures.map((f) => f.name);
  const detail = (items: EffortItem[], report = SOFT_REPORT): string =>
    judgeEffort({ report, items, leverlessVendors: PLANTED }).rows.find((r) => r.name === PRINTED)?.detail ?? "";
  const VALUE = "every dispatched item records an effort that is a VALUE, not a stringified absence (ruling 29)";
  const DERIVED = "the recorded effort is what ruling 31 DERIVES from (kind, difficulty), never something else";
  const CEILING = "no item exceeds ruling 30's `high` ceiling — this run asked for no edge case";
  const LEVER = "a vendor with no measured effort lever records `none measured` (ruling 40)";
  const CONFIRMED = "`effortConfirmed` is the literal `false` on every dispatched item (#45)";
  const PRINTED = "the report prints each dispatched item's triple, with the effort inside it (ruling 29)";

  test("the positive control passes — including the two items whose model nothing routed", () => {
    expect(judge([...DISPATCHED, UNRUN])).toEqual([]);
    expect(SOFT_REPORT).toContain(`(copilot, ${UNROUTED_MODEL}, `);
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
    const report = mutate(SOFT_REPORT, /\((?:copilot|qwen), [^)]*\)/g, "(routing not recorded)");
    expect(judge([...DISPATCHED, UNRUN], report)).toContain(PRINTED);
  });

  // ------------------------------------------------------------------ the
  // NEGATIVE CONTROLS FOR THE 2026-08-19 REPAIR. The property this check exists
  // to prove is *the report spells each dispatched item's triple the way the
  // product spells it, on that item's own line*. Each row below removes exactly
  // one part of that and requires the check to notice.

  test("fails when the report leaves the unrouted model BLANK — the spelling the expectation used to ask for", () => {
    const report = mutate(SOFT_REPORT, /\(copilot, unrouted, /g, "(copilot, , ");
    expect(judge([...DISPATCHED, UNRUN], report)).toContain(PRINTED);
    // And the message says what it wanted, in the product's words.
    expect(detail([...DISPATCHED, UNRUN], report)).toContain(`(copilot, ${UNROUTED_MODEL}, `);
  });

  test("fails when the report prints the word `undefined` — the spelling the MESSAGE used to name", () => {
    const report = mutate(SOFT_REPORT, /\(copilot, unrouted, /g, "(copilot, undefined, ");
    expect(judge([...DISPATCHED, UNRUN], report)).toContain(PRINTED);
  });

  test("the failure message never renders a missing model as `undefined` or as a blank", () => {
    // The old message built `${i.model}`, so the reader was told to look for
    // five characters the product never writes.
    const report = mutate(SOFT_REPORT, /^ {2}cheap: .*$/m, "  cheap: integrated");
    const text = detail([...DISPATCHED, UNRUN], report);
    expect(text).toContain(`(copilot, ${UNROUTED_MODEL}, `);
    expect(text).not.toContain("(copilot, undefined,");
    expect(text).not.toContain("(copilot, ,");
  });

  test("fails when the RECORD's model is a stringified absence, and says no triple could be required", () => {
    const items = [{ ...CHEAP, model: "undefined" }, DECLARED_HARD, THIRD, UNRUN];
    expect(judge(items)).toContain(PRINTED);
    expect(detail(items)).toContain("NO TRIPLE COULD BE REQUIRED");
  });

  test("fails when a routed model is recorded and a DIFFERENT one is printed", () => {
    const items = [{ ...CHEAP, model: "gpt-5-codex" }, DECLARED_HARD, THIRD, UNRUN];
    expect(judge(items)).toContain(PRINTED);
  });

  test("fails when the effort is absent from the record — the product's `effort NOT recorded` is not a pass", () => {
    const { effort: _e, ...bare } = CHEAP;
    const report = mutate(SOFT_REPORT, /\(copilot, unrouted, [^)]*\)/, "(copilot, unrouted, effort NOT recorded)");
    expect(judge([bare as EffortItem, DECLARED_HARD, THIRD, UNRUN], report)).toContain(PRINTED);
  });

  test("fails when ONE item's triple is dropped and another item's identical triple remains", () => {
    // THE HOLE THIS TEST FOUND, on 2026-08-19. `cheap` and `third` are both
    // copilot with no model at the same grade, so their triples are the same
    // string — and a whole-report `includes` was satisfied for both by whichever
    // one the report still printed. Anchoring on the item's own line is what
    // makes a dropped triple visible.
    const report = mutate(SOFT_REPORT, /^ {2}cheap: integrated —.*$/m, "  cheap: integrated");
    expect(report).toContain(`(copilot, ${UNROUTED_MODEL}, ${EFFORT_TEXT})`);
    expect(judge([...DISPATCHED, UNRUN], report)).toContain(PRINTED);
  });

  test("fails when the report gives a dispatched item no line at all", () => {
    const report = mutate(SOFT_REPORT, /^ {2}cheap: integrated —.*$/m, "");
    expect(judge([...DISPATCHED, UNRUN], report)).toContain(PRINTED);
  });

  test("fails when nothing was dispatched at all", () => {
    expect(judge([UNRUN])).toContain(VALUE);
    expect(judge([UNRUN])).toContain(PRINTED);
  });

  test("the instrument's own controls all pass, and there are seven of them", () => {
    const rows = effortInstrumentControls().rows;
    expect(rows.filter((r) => !r.ok)).toEqual([]);
    expect(rows.length).toBe(7);
  });
});

describe("item 13 — a ceiling EVENT, told from the word `ceiling`", () => {
  test("every line of every fixture that says `ceiling` is classified", () => {
    // The anti-drift guarantee, asserted directly. An unclassified line is a
    // reworded event or new honest prose, and both must be visible.
    for (const report of [UNCAPPED_REPORT, SOFT_REPORT, HARD_REPORT]) {
      expect(unrecognisedCeilingLines(report)).toEqual([]);
    }
  });

  test("the prose that carries the word is not an event", () => {
    for (const line of [...ADMISSION, ...REPORT_BUDGET, ...GAP_WARNING_LINES, `  ${GAP_WARNING}`]) {
      expect(classifyCeilingLine(line)).toBe("not-an-event");
    }
    // The gap-warning line that failed `it did NOT report cancelling` against
    // `dist/brigadier` on 2026-08-19.
    expect(GAP_WARNING_LINES.some((l) => /cancels work already running/.test(l))).toBe(true);
    // And the per-item facts, judged on the item's own line.
    expect(classifyCeilingLine("      ✗ integrate item 4: not-run (ceiling stopped dispatch)")).toBe("not-an-event");
    expect(classifyCeilingLine("  a: integrated — attempt 2 not taken — budget ceiling")).toBe("not-an-event");
  });

  test("and ruling 66 ACTING is an event, on stdout and on stderr", () => {
    expect(classifyCeilingLine(SOFT_EVENT)).toBe("event");
    expect(classifyCeilingLine(HARD_EVENT)).toBe("event");
    expect(classifyCeilingLine(PROVENANCE)).toBe("event");
    expect(classifyCeilingLine(HARD_STDERR)).toBe("event");
    // `bar/fakes/honest.ts` writes the two report sentences with no indent.
    expect(classifyCeilingLine("HARD CEILING FIRED at 3,764 tokens — work already running was CANCELLED where it stood")).toBe("event");
    expect(classifyCeilingLine("soft ceiling reached at 3,764 tokens — no further items were dispatched")).toBe("event");
  });

  test("a reworded event is UNCLASSIFIED, not silently dropped — which is what pins every pattern", () => {
    // Deleting or rewording any of the four event sentences in the product used
    // to produce silence. It now produces a named failure.
    for (const reworded of [
      "  HARD CEILING TRIGGERED at 37,648 tokens — running work was cancelled.",
      "  soft ceiling hit at 3,764 tokens — no further item was DISPATCHED.",
      "  the ceiling is the control that matters and the estimate is not: #44 measured …",
      "HARD CEILING at 37,648 tokens. `session/cancel` sent to 3 live worker(s).",
    ]) {
      expect(classifyCeilingLine(reworded)).toBeNull();
    }
  });

  test("ruling 58's over-budget sentence classifies, with EITHER interpolation and with both", () => {
    // MEASURED against a live run on 2026-08-19: this exact line went
    // unclassified and failed the anti-drift row. `${share}` is empty when
    // nothing else spent the channel's budget and `${why}` has two forms, so
    // all four combinations are put to the pattern — a transcription that only
    // holds for the shape that happened to fail is not a transcription.
    const shares = ["", " — 1564 of them were left after the rest of this run's stdout was charged against it"];
    const whys = [
      "3 item(s) carry a blocking check and ruling 52 has no exception for space",
      "no item here carries a blocking check: what does not fit is the run-level sections and the checkers' own " +
        "words, which are not items and which this cap may not collapse",
    ];
    for (const share of shares) {
      for (const why of whys) {
        expect(classifyCeilingLine(`this report is OVER the 2000-token ceiling${share} because ${why}.`)).toBe("not-an-event");
      }
    }
    expect(classifyCeilingLine(OVER_BUDGET)).toBe("not-an-event");
  });

  test("the over-budget pattern is not the `/ceiling/i` net it replaced", () => {
    // Constraint on the repair: a pattern loose enough to swallow any line
    // carrying the word puts the classifier back where it started. The head has
    // to be the head.
    expect(classifyCeilingLine("  the 2000-token ceiling was fine and nothing overflowed")).toBeNull();
    expect(classifyCeilingLine("this report is UNDER the 2000-token ceiling because everything fit.")).toBeNull();
    expect(classifyCeilingLine("  some ceiling, some reason because something.")).toBeNull();
  });

  test("new honest prose carrying the word is UNCLASSIFIED too — the failure that costs a human one edit", () => {
    expect(classifyCeilingLine("  a brand new sentence about some other ceiling entirely")).toBeNull();
  });

  test("the word `ceiling` is in a report that announced nothing — which is why the word is not the test", () => {
    const byWord = UNCAPPED_REPORT.split("\n").filter((l) => /ceiling/i.test(l));
    expect(byWord.length).toBeGreaterThan(0);
    expect(ceilingLines(UNCAPPED_REPORT)).toEqual([]);
  });

  test("the gap warning is gone for EVERY reader, in both of the forms the product writes it in", () => {
    // The old excision split the report on the record's joined copy, so the
    // CLI's one-per-line copy on stderr survived it. Both are in this fixture.
    expect(SOFT_REPORT).toContain(GAP_WARNING);
    expect(SOFT_REPORT).toContain(GAP_WARNING_LINES[4] ?? "");
    expect(ceilingLines(SOFT_REPORT).some((l) => /cancel/i.test(l))).toBe(false);
    // And the reader needs no record to get that right.
    expect(ceilingLines(SOFT_REPORT)).toEqual([SOFT_EVENT, PROVENANCE]);
  });

  test("the gap warning's numbers are the product's own arithmetic, and the pair really does warn", () => {
    // `estimate.ts:123` states `itemCeilingReserve()` is 71,835 independently of
    // the arithmetic recomputed here.
    expect(ITEM_RESERVE).toBe(71_835);
    expect(RESERVE).toBe(215_505);
    // `estimate.ts:180`: the warning exists only while the gap does NOT exceed
    // the reserve. A fixture depicting a warning the product would not emit is
    // an invention, and this is the assertion that would have caught it.
    expect(HARD_CEILING - SOFT_CEILING).toBeLessThanOrEqual(RESERVE);
    expect(HARD_CEILING).toBeGreaterThan(SOFT_CEILING);
    expect(GAP_WARNING_LINES[8]).toBe("  --hard-ceiling above 219,269.");
  });

  test("every EVENT pattern is exercised by a fixture line — a pattern nothing matches could be wrong forever", () => {
    const lines = [UNCAPPED_REPORT, SOFT_REPORT, HARD_REPORT].flatMap((r) => r.split("\n"));
    for (const p of CEILING_EVENTS) expect(lines.some((l) => p.re.test(l))).toBe(true);
    expect(CEILING_EVENTS).toHaveLength(4);
  });

  test("every NON-EVENT pattern matches the line it was transcribed from", () => {
    // Fixture reachability is the wrong test for these: several are produced by
    // paths that stop the run before a report exists, and inventing a fixture
    // line for one of those is how an unreachable sentence got into this file
    // the first time. Each pattern is instead put to the sentence it was copied
    // from, so a mistranscription fails here rather than lying dormant.
    const SAMPLES: Record<string, string> = {
      "ruling 58's report budget, in the admission block (`src/queue/admit.ts:364`)": ADMISSION[1] ?? "",
      "ruling 58's report budget, when the report is over it (`src/report/run-report.ts:803`)": OVER_BUDGET,
      "ruling 30's effort ceiling (`src/queue/spawn.ts:314`)":
        "          effort at or below `high`. Ruling 30's ceiling is not exceeded to make a worker try harder.",
      "the weakened-pair warning, its head — and its whole joined copy (`src/queue/estimate.ts:194`)": GAP_WARNING_LINES[0] ?? "",
      "the weakened-pair warning, ruling 66's two verbs (`src/queue/estimate.ts:200`)": GAP_WARNING_LINES[3] ?? "",
      "the weakened-pair warning, its hypothetical cancellation (`src/queue/estimate.ts:201`)": GAP_WARNING_LINES[4] ?? "",
      "the weakened-pair warning, the run proceeding (`src/queue/estimate.ts:203`)": GAP_WARNING_LINES[6] ?? "",
      "the weakened-pair warning, the remedy (`src/queue/estimate.ts:204`)": GAP_WARNING_LINES[7] ?? "",
      "the weakened-pair warning, the number to raise to (`src/queue/estimate.ts:205`)": GAP_WARNING_LINES[8] ?? "",
      "the refused pair, its head (`src/queue/estimate.ts:171`)":
        "--soft-ceiling 37,648 is at or above --hard-ceiling 3,764, so the soft ceiling can never act first.",
      "the refused pair, ruling 66's two verbs (`src/queue/estimate.ts:173`)": GAP_WARNING_LINES[3] ?? "",
      "the refused pair, its remedy (`src/queue/estimate.ts:176`)":
        "  Remedy: --hard-ceiling must be above --soft-ceiling, and above 253,153",
      "a ladder rung not taken for budget (`src/work/ladder.ts:124`)":
        "  cheap: failed — (copilot, unrouted, medium) — attempt 2 not taken — budget ceiling",
      "the per-item never-dispatched qualifier (`src/queue/execute.ts:1880`)":
        "      ✗ integrate item 4: not-run (ceiling stopped dispatch)",
      "the per-item never-dispatched remedy (`src/queue/execute.ts:1893`)":
        "          nothing of it exists to inspect. Remedy: raise the ceiling, or split the plan.",
      "a plan that set `effort` itself (`src/queue/plan.ts:302`)":
        "if it has to (ruling 67). The only channel that raises the ceiling is the operator's own `--xhigh <item-id>`.",
    };
    // Every pattern has a sample and every sample is classified as prose.
    expect(CEILING_NON_EVENTS.map((p) => p.what).sort()).toEqual(Object.keys(SAMPLES).sort());
    for (const p of CEILING_NON_EVENTS) {
      const sample = SAMPLES[p.what] ?? "";
      expect({ what: p.what, matched: p.re.test(sample) }).toEqual({ what: p.what, matched: true });
      expect({ what: p.what, kind: classifyCeilingLine(sample) }).toEqual({ what: p.what, kind: "not-an-event" });
    }
  });
});

describe("item 13 — the two ceilings, as two events", () => {
  test("the positive control passes", () => {
    expect(cnames(CEILINGS)).toEqual([]);
  });

  // ------------------------------------------------- the negative control's
  // own negative control. `uncappedLines.length === 0` is a property that an
  // over-matching reader breaks in one direction and an under-matching one
  // breaks in the other, so both are induced here.

  test("fails when a run given no ceilings announces a ceiling event anyway", () => {
    const report = `${UNCAPPED_REPORT}\n${SOFT_EVENT}`;
    expect(cnames({ ...CEILINGS, uncapped: run(report, uncappedRecord) })).toContain(CONTROL);
  });

  test("fails when the uncapped run announces one only on STDERR — the line a whitelist missed", () => {
    // `bar/items/13-cost-model.ts` reads `stdout + stderr`, so this is in the
    // report. MEASURED green by a blind critic before the classifier landed.
    const report = `${UNCAPPED_REPORT}\n${HARD_STDERR}`;
    expect(cnames({ ...CEILINGS, uncapped: run(report, uncappedRecord) })).toContain(CONTROL);
  });

  test("PASSES on the admission block alone — the line that failed this check against the real binary", () => {
    // Ruling 58's report-size ceiling is not ruling 66's. A check that cannot
    // tell them apart fails a product that is behaving.
    expect(UNCAPPED_REPORT).toContain("the ceiling is on everything this process writes");
    expect(cnames(CEILINGS)).not.toContain(CONTROL);
  });

  test("fails when a run given no ceilings records one as hit", () => {
    const record = recordOf([...DISPATCHED], costOf({ softCeilingHit: true }));
    expect(cnames({ ...CEILINGS, uncapped: run(UNCAPPED_REPORT, record) })).toContain(CONTROL);
  });

  test("fails when the soft ceiling cancelled work already running", () => {
    const record = recordOf(
      [itemOf("cheap", 1, "cancelled"), ...DISPATCHED.slice(1), UNRUN],
      costOf({ softCeiling: SOFT_CEILING, hardCeiling: HARD_CEILING, softCeilingHit: true, gapWarning: GAP_WARNING }),
    );
    expect(cnames({ ...CEILINGS, soft: run(SOFT_REPORT, record) })).toContain(SOFT);
  });

  test("fails when the soft ceiling stopped nothing — every item ran", () => {
    const record = recordOf([...DISPATCHED], costOf({ softCeiling: 3_764, softCeilingHit: true }));
    expect(cnames({ ...CEILINGS, soft: run(SOFT_REPORT, record) })).toContain(SOFT);
  });

  test("fails when the soft run reports a cancellation in a ceiling event of its own", () => {
    const report = mutate(
      SOFT_REPORT,
      "  soft ceiling reached at 3,764 tokens — no further item was DISPATCHED",
      "  soft ceiling reached at 3,764 tokens — running work was cancelled and no further item was DISPATCHED",
    );
    expect(cnames({ ...CEILINGS, soft: run(report, softRecord) })).toContain(NO_CANCEL);
  });

  test("PASSES the gap warning, which is what it failed on against the real binary", () => {
    // MEASURED on 2026-08-19: the matched line was *"cancels work already
    // running. With a gap this narrow the hard ceiling may fire anyway and"* —
    // the product describing a WEAKENING before the run, read as the soft
    // ceiling cancelling work in flight.
    expect(SOFT_REPORT).toContain("cancels work already running. With a gap this narrow");
    expect(cnames(CEILINGS)).not.toContain(NO_CANCEL);
  });

  test("`did NOT cancel` is NOT satisfied by a soft run that announced nothing at all", () => {
    // `[].every(...)` is `true`. Without the length guard this row would pass
    // on a product that stopped printing ceiling events altogether, which is
    // the vacuous-over-an-empty-list shape item 7 carried for nine rounds.
    const report = [...GAP_WARNING_LINES, ...ADMISSION, TRIPLE_LINES, COST_TAIL].join("\n");
    expect(unrecognisedCeilingLines(report)).toEqual([]);
    expect(ceilingLines(report)).toEqual([]);
    const failed = cnames({ ...CEILINGS, soft: run(report, softRecord) });
    expect(failed).toContain(NO_CANCEL);
    expect(detailOf({ ...CEILINGS, soft: run(report, softRecord) }, NO_CANCEL)).toContain("NO ceiling event at all");
  });

  test("fails when the SOFT run cancelled work already running and said so ON STDERR", () => {
    // THE FALSE NEGATIVE A WHITELIST OF REPORT SENTENCES OPENED, re-induced.
    // `src/queue/execute.ts:1235` is the product's most explicit statement that
    // running work was cancelled, and it is on stderr rather than in the report.
    const report = `${SOFT_REPORT}\n${HARD_STDERR}`;
    expect(cnames({ ...CEILINGS, soft: run(report, softRecord) })).toContain(NO_CANCEL);
  });

  test("the anti-drift row fails when the product rewords an event", () => {
    const report = mutate(SOFT_REPORT, /^ {2}soft ceiling reached at /m, "  soft ceiling hit at ");
    expect(cnames({ ...CEILINGS, soft: run(report, softRecord) })).toContain(DRIFT);
    // And the reworded line is quoted, so classifying it is one edit.
    expect(detailOf({ ...CEILINGS, soft: run(report, softRecord) }, DRIFT)).toContain("soft ceiling hit at");
  });

  test("fails when the product DELETES the provenance sentence — the deletion nothing noticed", () => {
    // A blind critic removed `src/report/run-report.ts:573` from the product
    // outright on 2026-08-19 and every row here stayed green, because no row
    // required it. Deleting it says nothing about `ceiling`, so the anti-drift
    // row cannot see it either: an ABSENCE is pinned by a row that REQUIRES.
    const report = mutate(SOFT_REPORT, PROVENANCE, "");
    expect(cnames({ ...CEILINGS, soft: run(report, softRecord) })).toContain(PROV_ROW);
    expect(cnames({ ...CEILINGS, hard: run(mutate(HARD_REPORT, PROVENANCE, ""), hardRecord) })).toContain(PROV_ROW);
  });

  test("fails when the hard run never says what was done to the live workers", () => {
    // `src/queue/execute.ts:1235` is the only line that names the mechanism and
    // the worker count. Without this the stderr pattern is required by nothing.
    const report = mutate(HARD_REPORT, HARD_STDERR, "");
    expect(cnames({ ...CEILINGS, hard: run(report, hardRecord) })).toContain(HARD);
  });

  test("the anti-drift row PASSES ruling 58's over-budget sentence and still fails an unknown one", () => {
    // Both directions on the same row, on the same run: the legitimate product
    // line must not fail it, and a line nobody has classified must.
    const fine = `${UNCAPPED_REPORT}\n${OVER_BUDGET}`;
    expect(cnames({ ...CEILINGS, uncapped: run(fine, uncappedRecord) })).not.toContain(DRIFT);
    const broken = `${fine}\n  the ceiling was raised by an unknown hand`;
    expect(cnames({ ...CEILINGS, uncapped: run(broken, uncappedRecord) })).toContain(DRIFT);
    expect(detailOf({ ...CEILINGS, uncapped: run(broken, uncappedRecord) }, DRIFT)).toContain("raised by an unknown hand");
  });

  test("the anti-drift row fails on honest new prose nobody has classified yet", () => {
    const report = `${UNCAPPED_REPORT}\n  a new sentence about some other ceiling entirely`;
    expect(cnames({ ...CEILINGS, uncapped: run(report, uncappedRecord) })).toContain(DRIFT);
  });

  test("fails when the hard ceiling cancelled nothing", () => {
    const record = recordOf([...DISPATCHED, UNRUN], costOf({ hardCeiling: 3_764, hardCeilingHit: true }));
    expect(cnames({ ...CEILINGS, hard: run(HARD_REPORT, record) })).toContain(HARD);
  });

  test("fails when the hard ceiling fired and the report never says work was cancelled", () => {
    const report = mutate(mutate(HARD_REPORT, /^ {2}HARD CEILING FIRED.*$/m, "  a ceiling was reached."), HARD_STDERR, "");
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
  const NUMBERS = "the report prints the actual spend against BOTH ends of the predicted range, as numbers, on one line";
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

  test("a number that is part of a NAME is not the spend — a run id, a path, a larger number", () => {
    // MEASURED green on 2026-08-19 with a digits-only boundary: `run r-9412`
    // satisfied `9412` on the very line that read `actual not measured`.
    const three = `${SOFT_REPORT}`;
    for (const impostor of ["run r-9412", "--run-root /runs/9412", "actual 29,412"]) {
      const report = mutate(three, /9,412/g, "not measured").replace("actual not measured", `actual not measured; ${impostor}`);
      expect(judge({ report })).toContain(NUMBERS);
    }
  });

  test("the check reads the PROPERTY, not brigadier's sentence — `honest.ts`'s wording passes too", () => {
    // `bar/fakes/honest.ts:1605` writes the three numbers the other way round.
    // Anchoring on `src/report/run-report.ts:680` word for word failed a
    // from-scratch reimplementation for its prose, which measured the wrong thing.
    const report = mutate(SOFT_REPORT, /^cost estimate .*$/m, "actual 9,412 tokens against predicted 57,468 – 287,340");
    expect(judge({ report })).toEqual([]);
  });

  test("fails when the three numbers are split across two lines — a comparison needs both sides", () => {
    const report = mutate(SOFT_REPORT, /^cost estimate .*$/m, "estimate 57,468 – 287,340 tokens\nactual 9,412");
    expect(judge({ report })).toContain(NUMBERS);
  });

  test("fails when `actual` is recorded and never printed — the word `actual` is not the number", () => {
    // EVERY occurrence, and that is not a nicety. `src/queue/execute.ts:1614`'s
    // run note prints the same spend a second time (`9,412 tokens spent, read
    // from …`), so a control that rewrote only the cost line left the number in
    // the report and this row went on passing — found on 2026-08-19 the moment
    // the fixture gained the note. The property is *the number reaches the
    // reader*, so the control has to take the number away.
    const report = mutate(SOFT_REPORT, /9,412/g, "not measured");
    expect(report).toContain("actual not measured");
    expect(report).not.toContain("9,412");
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
