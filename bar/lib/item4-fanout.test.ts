// SPDX-License-Identifier: Apache-2.0
/**
 * Item 4's ruling-54 half: three filters, three causes, three sentences — and
 * the guards that make the third of them a measurement rather than a claim.
 *
 * WHY THIS FILE EXISTS, in the words of the two defects it is about.
 *
 * ONE — THE ROW THAT GATED NOTHING. Item 4 carried a `Checks.note()` saying
 * ruling 54's RAM filter *"cannot be manufactured without constraining the
 * machine"*. `note` stamps `ok: true` and contributes nothing to the verdict, so
 * `BAR.md`'s "three different sentences for the same worker count" rendered as
 * two green rows and one row that asserted nothing at all. The premise was also
 * wrong: RAM binds whenever it is the STRICT MINIMUM of ruling 14's four
 * filters, and the plan's length and `--workers` are both the operator's, so a
 * plan sized above the machine makes RAM bind on the real machine with its real
 * `totalmem()`. Nothing is injected and nothing is overridden, which matters
 * because the whole value of that sentence is that it is true.
 *
 * TWO — THE CHECK THAT WAS NOT CHECKING. Its predecessor read the sentence with
 * `/—\s*(.+?)\s*$/m`, and the first em dash in an admission block is on
 * `admitted — <plan path>: N item(s) in M wave(s)`. So the "two different
 * sentences" it compared were two plan paths, and it would have passed against
 * a binary that printed ONE fan-out sentence for every filter — the exact
 * collapse ruling 54 forbids. `bindingLines` is pinned below against a whole
 * admission block, and the `admitted —` line is named as the thing it must not
 * return.
 *
 * The sentences below are TRANSCRIBED from `src/queue/admit.ts`'s
 * `bindingSentence` on 2026-08-20. `bar/` imports nothing from `src/`, so they
 * are a second copy of product prose, and copies go stale in silence — the
 * drift block reads the product's own source as TEXT and fails if any of the
 * four phrases stops appearing there. That is the same guard, for the same
 * reason, as `bar/lib/timeout-order.test.ts`.
 *
 * Both directions, per `AGENTS.md`: every property holds on the real shapes AND
 * every judge is shown failing on the shape it exists to reject.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Checks, leader } from "./checks.ts";
import {
  FILTER_PHRASES,
  MIN_CAP_TO_DISTINGUISH,
  RAM_LADDER,
  WORKERS_ABOVE_ANY_MACHINE,
  bindingLines,
  classifyBindingSentence,
  judgeFanOutFilters,
  judgeHostCanDistinguish,
  planTheOtherTwoDrives,
  waveOne,
  type FanOutObservation,
} from "../items/04-fanout-isolates.ts";

// Assembled from parts rather than written as one literal, for the reason
// `bar/self-check.test.ts` records: a literal specifier here would itself be a
// reach into `src/`, and the import scanner would — correctly — flag this file.
const ADMIT = fileURLToPath(new URL(["..", "..", "src", "queue", "admit.ts"].join("/"), import.meta.url));

/** Wave one's sentence for each filter, as the product prints it. */
const SENTENCE = {
  "item-count": "1 worker(s) in wave 1 — the plan had 1 item(s) here and no filter reduced it",
  desirability:
    '2 worker(s) in wave 1 — desirability capped it: the operator\'s per-run budget is 2, and ruling 21 ranks "don\'t spawn" the first token lever',
  feasibility:
    "5 worker(s) in wave 1 — RAM capped it: this machine's TOTAL memory leaves room for 5 worker(s) at 3 GiB each " +
    "(ruling 54 computes from totalmem(), never freemem(); brigadier does not schedule against current load and does not pretend to)",
  legality:
    "2 worker(s) in wave 1 — legality capped it: only 2 item(s) here own disjoint paths and may run at once",
} as const;

/** The em dash that broke the predecessor, in its natural habitat. */
const ADMISSION_BLOCK = [
  "admitted — /w/solo.json: 1 item(s) in 1 wave(s)",
  "  agents     2 resolved on PATH: qwen at /w/bin/qwen, copilot at /w/bin/copilot",
  "             resolving a name is not driving an agent — `brigadier detect` opens a session,",
  "             and that is the only thing that proves one is usable (ruling 46).",
  "  ladder     two rungs offered",
  "  wave 1     1 item(s)",
  `             ${SENTENCE["item-count"]}`,
  "  ruling 37  a verify command committed in the repository is never read and never run:",
].join("\n");

/** The three drives item 4 makes, all correct. The other cases mutate this. */
const HEALTHY: FanOutObservation[] = [
  { cause: "a one-item plan", wants: "item-count", sentence: SENTENCE["item-count"] },
  { cause: "six items with --workers 2", wants: "desirability", sentence: SENTENCE.desirability },
  { cause: "more items than RAM allows", wants: "feasibility", sentence: SENTENCE.feasibility },
];

describe("each filter's sentence classifies as itself and as nothing else", () => {
  test("all four, and no sentence answers to another filter's name", () => {
    for (const [name, text] of Object.entries(SENTENCE)) {
      expect(classifyBindingSentence(text)).toBe(name as keyof typeof SENTENCE);
    }
    // The property the whole item rests on, stated as a matrix rather than as
    // four independent facts: no sentence carries a second filter's phrase.
    for (const [name, text] of Object.entries(SENTENCE)) {
      const matched = FILTER_PHRASES.filter(([, phrase]) => phrase.test(text)).map(([f]) => f);
      expect(matched).toEqual([name as keyof typeof SENTENCE]);
    }
  });

  test("a sentence naming NO filter is `null`, not a lucky match", () => {
    expect(classifyBindingSentence("3 worker(s) in wave 1 — because I said so")).toBeNull();
    expect(classifyBindingSentence("")).toBeNull();
    // `item(s)` appears in all four sentences, so a classifier keyed on it
    // would answer `item-count` for every one of them.
    expect(classifyBindingSentence("1 worker(s) in wave 1 — 1 item(s)")).toBeNull();
  });

  test("a sentence naming TWO filters is refused rather than resolved by precedence", () => {
    // The collapse ruling 54 forbids, wearing the clothes of a pass: a product
    // that hedged would otherwise be classified as whichever phrase was listed
    // first here.
    const collapsed = "1 worker(s) in wave 1 — RAM capped it: desirability capped it too";
    expect(classifyBindingSentence(collapsed)).toBeNull();
  });
});

describe("wave sentences are found by their own shape, never by `the first em dash`", () => {
  test("the `admitted —` line is not mistaken for a fan-out sentence", () => {
    const found = bindingLines(ADMISSION_BLOCK);
    expect(found).toHaveLength(1);
    expect(found[0]?.wave).toBe(1);
    expect(found[0]?.workers).toBe(1);
    expect(found[0]?.filter).toBe("item-count");
    // The predecessor's regex, shown returning the plan path instead. This is
    // the defect, in one assertion.
    expect(/—\s*(.+?)\s*$/m.exec(ADMISSION_BLOCK)?.[1]).toBe("/w/solo.json: 1 item(s) in 1 wave(s)");
    expect(found[0]?.text).not.toBe(/—\s*(.+?)\s*$/m.exec(ADMISSION_BLOCK)?.[1]);
  });

  test("every wave gets its own line, in wave order", () => {
    const twoWaves = [
      "  wave 1     3 item(s)",
      `             ${SENTENCE.desirability}`,
      "  wave 2     1 item(s)",
      `             ${SENTENCE["item-count"].replace("wave 1", "wave 2")}`,
    ].join("\n");
    expect(bindingLines(twoWaves).map((l) => l.wave)).toEqual([1, 2]);
    expect(bindingLines(twoWaves).map((l) => l.filter)).toEqual(["desirability", "item-count"]);
  });

  test("output with no fan-out sentence yields nothing rather than a guess", () => {
    expect(bindingLines("refused — the plan is impossible\n")).toEqual([]);
  });
});

describe("three causes, three sentences — and the RAM one only where RAM bound", () => {
  test("the healthy three pass every row", () => {
    const checks = judgeFanOutFilters(HEALTHY);
    expect(checks.failures.map((f) => f.name)).toEqual([]);
    expect(checks.passed).toBe(true);
    // And nothing here is a note. A note stamps `ok: true` and gates nothing,
    // which is precisely what this file replaced.
    expect(checks.rows.some((r) => r.note === true)).toBe(false);
  });

  test("NEGATIVE: a product that printed the RAM sentence for a one-item plan fails twice", () => {
    const lying = HEALTHY.map((o) =>
      o.wants === "item-count" ? { ...o, sentence: SENTENCE.feasibility } : o,
    );
    const checks = judgeFanOutFilters(lying);
    expect(checks.passed).toBe(false);
    const failed = checks.failures.map((f) => f.name);
    // Once for naming the wrong filter, and once for the negative control that
    // exists so this cannot be caught by distinctness alone.
    expect(failed).toContain("a one-item plan — the report names the item-count filter (ruling 54)");
    expect(failed).toContain("the RAM-bound sentence appears ONLY where RAM actually bound");
    expect(checks.reason()).toMatch(/claimed a RAM bound without one/);
  });

  test("NEGATIVE: two causes collapsing to one sentence fails distinctness", () => {
    // Both non-RAM drives print the desirability sentence, which is what a
    // product that had collapsed two filters into one would do.
    const collapsed = HEALTHY.map((o) =>
      o.wants === "item-count" ? { ...o, sentence: SENTENCE.desirability } : o,
    );
    const checks = judgeFanOutFilters(collapsed);
    expect(checks.passed).toBe(false);
    expect(checks.failures.map((f) => f.name)).toContain(
      "each of the 3 cause(s) driven produced a DIFFERENT sentence (ruling 54)",
    );
  });

  test("NEGATIVE: a ladder that never reached RAM fails, and says the binary printed nothing", () => {
    // What item 4 records on a machine so large that the top of `RAM_LADDER`
    // still does not bind: an empty sentence, and a failing row rather than a
    // note excusing it.
    const unreached = HEALTHY.map((o) => (o.wants === "feasibility" ? { ...o, sentence: "" } : o));
    const checks = judgeFanOutFilters(unreached);
    expect(checks.passed).toBe(false);
    expect(checks.reason()).toMatch(/printed no wave-one fan-out sentence/);
  });

  test("NEGATIVE: an unrecognised sentence is a failure, never a shrug", () => {
    const drifted = HEALTHY.map((o) =>
      // Names no filter at all. It used to say "memory, probably", which the
      // label-anchored classifier now correctly recognises as a RAM claim —
      // the widening working, caught by its own test.
      o.wants === "feasibility" ? { ...o, sentence: "5 worker(s) in wave 1 — it worked out that way" } : o,
    );
    const checks = judgeFanOutFilters(drifted);
    expect(checks.passed).toBe(false);
    expect(checks.reason()).toMatch(/NO SINGLE FILTER/);
  });
});

describe("the ladder is sized so RAM can actually be reached", () => {
  test("it climbs, and its top covers a machine far larger than any this ships to", () => {
    expect(RAM_LADDER.length).toBeGreaterThan(0);
    for (let i = 1; i < RAM_LADDER.length; i++) {
      expect(RAM_LADDER[i]!).toBeGreaterThan(RAM_LADDER[i - 1]!);
    }
    // At the product's 3 GiB per worker, a feasibility cap of 512 needs about
    // 1.5 TB of RAM. The rung below the top covers a 768 GB machine.
    expect(RAM_LADDER[RAM_LADDER.length - 1]).toBeGreaterThanOrEqual(512);
    // MEASURED against `bun 1.3.14` on 2026-08-20: this host reports 24 GB from
    // `os.totalmem()`, so its feasibility cap is 5 and the FIRST rung binds.
    expect(RAM_LADDER[0]!).toBeGreaterThan(5);
  });

  test("the RAM drive's --workers can never be the filter that binds", () => {
    // It must exceed every rung, or the desirability filter would win on the
    // very drive that exists to make RAM win.
    expect(WORKERS_ABOVE_ANY_MACHINE).toBeGreaterThan(RAM_LADDER[RAM_LADDER.length - 1]!);
  });
});

describe("the copied prose is checked against the original it was copied from", () => {
  /**
   * The source with its string concatenation joined up.
   *
   * `bindingSentence` wraps its sentences across source lines — *"…here and no
   * "* + *"filter reduced it"* — so a phrase that is contiguous in the OUTPUT is
   * not contiguous in the FILE. Searching the raw file reported the item-count
   * phrase missing when it was present and correct, which is a drift guard
   * failing on its own formatting rather than on drift.
   */
  const source = readFileSync(ADMIT, "utf8")
    .replace(/["`]\s*\+\s*["`]/g, "")
    .replace(/\s+/g, " ");

  test("every phrase this harness classifies on still appears in the product's own source", () => {
    for (const [name, phrase] of FILTER_PHRASES) {
      // A missing phrase is a finding, not a pass: the classifier would start
      // returning `null` and item 4 would fail with prose nobody could explain.
      expect([name, phrase.test(source)]).toEqual([name, true]);
    }
  });

  test("the joining is not what makes the guard pass", () => {
    // The negative control on the normalisation itself: a phrase the product
    // does not print must still be absent after the source has been flattened.
    expect(/swap capped it/.test(source)).toBe(false);
    expect(/no filter reduced it/.test("and no filter reduced it")).toBe(true);
  });

  test("the line shape `bindingLines` anchors on is the shape the product prints", () => {
    expect(source.includes("worker(s) in ${where} — ")).toBe(true);
  });

  test("the flag the desirability drive passes is the flag the CLI reads", () => {
    // The predecessor passed `--max-workers`, which `src/cli.ts` does not read,
    // so its "capped at 2" run was capped at ruling 54's default of 3 and the
    // detail line said something false. Read out of the product rather than
    // remembered.
    const cli = fileURLToPath(new URL(["..", "..", "src", "cli.ts"].join("/"), import.meta.url));
    const cliSource = readFileSync(cli, "utf8");
    expect(cliSource.includes('value("workers")')).toBe(true);
    expect(cliSource.includes('value("max-workers")')).toBe(false);
  });
});

describe("the two non-RAM drives are sized from the machine, never assumed", () => {
  test("the three numbers, pinned on this side of the wall", () => {
    // `test/fanout.test.ts` verifies against the REAL filter that these sizes
    // bind the filters they are meant to. `bar/` imports nothing from `src/`,
    // so the shared thing is these three numbers and both sides pin them.
    expect(planTheOtherTwoDrives(2)).toEqual({
      itemCountItems: 1,
      desirabilityItems: 4,
      desirabilityWorkers: 1,
    });
    expect(planTheOtherTwoDrives(5)).toEqual({
      itemCountItems: 1,
      desirabilityItems: 7,
      desirabilityWorkers: 4,
    });
    for (const cap of [2, 3, 5, 19, 339]) {
      const sized = planTheOtherTwoDrives(cap)!;
      // The two properties that make each drive bind what it must: the plan is
      // longer than the machine can hold, and the budget is strictly under it.
      expect(sized.desirabilityItems).toBeGreaterThan(cap);
      expect(sized.desirabilityWorkers).toBeLessThan(cap);
      expect(sized.desirabilityWorkers).toBeGreaterThanOrEqual(1);
      expect(sized.itemCountItems).toBeLessThan(cap);
    }
  });

  test("NEGATIVE: a host that cannot separate the causes gets `null`, not a guess", () => {
    // A cap of 0 or 1 leaves nothing strictly under it: a plan cannot have zero
    // items and a budget of zero is not a run. MEASURED with the product's own
    // `feasibilityCap` on 2026-08-20, that is every host below about 13 GiB —
    // which includes `macos-latest` at 7 GB and a private repository's
    // `ubuntu-latest` at 8 GB, per GitHub's runner table read the same day.
    expect(MIN_CAP_TO_DISTINGUISH).toBe(2);
    expect(planTheOtherTwoDrives(0)).toBeNull();
    expect(planTheOtherTwoDrives(1)).toBeNull();
    expect(planTheOtherTwoDrives(-1)).toBeNull();
    expect(planTheOtherTwoDrives(1.5)).toBeNull();
  });

  test("NEGATIVE: on such a host the judge grades ONE cause and says so in the row name", () => {
    // What item 4 records when only the RAM drive could be made: the RAM row
    // still passes, because it really was driven — and the distinctness row
    // names the count, so nobody reads a one-cause run as a three-cause one.
    // The row that BLOCKS is the item's own `this host can tell ruling 54's
    // three causes apart at all`, which is `expect(…, false, …)` and never a
    // note; that is what stops this degrading into a pass.
    const ramOnly: FanOutObservation[] = [
      { cause: "more items than RAM allows", wants: "feasibility", sentence: SENTENCE.feasibility },
    ];
    const checks = judgeFanOutFilters(ramOnly);
    expect(checks.passed).toBe(true);
    expect(checks.rows.map((r) => r.name)).toContain(
      "each of the 1 cause(s) driven produced a DIFFERENT sentence (ruling 54)",
    );
    // And the three-cause run says three, so the two are never confusable.
    expect(judgeFanOutFilters(HEALTHY).rows.map((r) => r.name)).toContain(
      "each of the 3 cause(s) driven produced a DIFFERENT sentence (ruling 54)",
    );
    // Nothing the judge emits is a note, on either path.
    expect(checks.rows.some((r) => r.note === true)).toBe(false);
  });
});

describe("the guard on the guard: a host that cannot distinguish makes the item FAIL", () => {
  const ROW = "this host can tell ruling 54's three causes apart at all";

  test("NEGATIVE: below the floor the row FAILS, in the bytes a reader sees", () => {
    // A blind critic replaced this row's predicate with `true` and 173 of 173
    // tests stayed green: only its INPUTS were pinned, never the row. This is
    // the row itself, in both directions.
    for (const cap of [undefined, 0, 1]) {
      const checks = judgeHostCanDistinguish(cap);
      expect([cap, checks.passed]).toEqual([cap, false]);
      expect(checks.rows.map((r) => r.name)).toEqual([ROW]);
      // Never a note. A note stamps `ok: true` and gates nothing, which is the
      // substitution this whole item was rebuilt to remove.
      expect(checks.rows[0]?.note).toBeUndefined();
      expect(leader(checks.rows[0]!)).toBe("FAIL");
      expect(checks.reason()).toMatch(/NOT DRIVEN/);
    }
    // `undefined` is the ladder never binding, and it must not read like a
    // small host — the two are different findings.
    expect(judgeHostCanDistinguish(undefined).rows[0]?.detail).toMatch(/no value at all/);
    expect(judgeHostCanDistinguish(1).rows[0]?.detail).toMatch(/1 worker\(s\)/);
  });

  test("and at or above the floor it PASSES, so it is not simply always-red", () => {
    for (const cap of [MIN_CAP_TO_DISTINGUISH, 3, 5, 19, 339]) {
      const checks = judgeHostCanDistinguish(cap);
      expect([cap, checks.passed]).toEqual([cap, true]);
      expect(leader(checks.rows[0]!)).toBe("ok  ");
    }
  });

  test("on a small host this row is the ONLY thing that can fail the item", () => {
    // Which is exactly why it needs a control of its own. The other judge is
    // CONTENT on such a host: the single cause that was driven was driven
    // honestly, so it passes — and if this row were neutered the item would
    // report PASS having proved one of ruling 54's three sentences.
    const ramOnly: FanOutObservation[] = [
      { cause: "more items than RAM allows", wants: "feasibility", sentence: SENTENCE.feasibility },
    ];
    expect(judgeFanOutFilters(ramOnly).passed).toBe(true);
    expect(judgeHostCanDistinguish(1).passed).toBe(false);
    // The item absorbs both, and `Checks.passed` is `failures.length === 0`, so
    // one failing row is the whole verdict.
    const item = new Checks();
    item.absorb(judgeFanOutFilters(ramOnly));
    item.absorb(judgeHostCanDistinguish(1));
    expect(item.passed).toBe(false);
    expect(item.failures.map((f) => f.name)).toEqual([ROW]);
  });

  test("and on a host that CAN distinguish, the same two judges pass together", () => {
    const item = new Checks();
    item.absorb(judgeFanOutFilters(HEALTHY));
    item.absorb(judgeHostCanDistinguish(5));
    expect(item.failures.map((f) => f.name)).toEqual([]);
    expect(item.rows.some((r) => r.note === true)).toBe(false);
  });
});

/**
 * The SAME four filters in a second implementation's words.
 *
 * TRANSCRIBED from `bar/fakes/honest.ts` on 2026-08-20. That fixture is the
 * instrument's positive control — a from-scratch brigadier that really clones,
 * spawns, merges and records — and it names ruling 14's filters in prose it
 * wrote itself. A classifier anchored on the PRODUCT's clauses returned `null`
 * for its item-count sentence and failed the control; round 16 had already
 * recorded that shape and its remedy. These fixtures are what stops it
 * returning.
 */
const OTHER_IMPLEMENTATION = {
  "item-count": "admitted: 5 worker(s) — the plan had 5 item(s), which was the binding filter",
  desirability: "admitted: 3 worker(s) — desirability capped it at 3, which was the binding filter",
  feasibility:
    "admitted: 5 worker(s) — available RAM capped it at 5, which was the binding filter: this machine's TOTAL " +
    "memory, less the operating system's share and the host agent's own, leaves room for that many at 3 GiB each",
} as const;

describe("the check names the FILTER, not one product's sentence", () => {
  test("a second implementation's own words classify to the same four filters", () => {
    for (const [name, text] of Object.entries(OTHER_IMPLEMENTATION)) {
      expect([name, classifyBindingSentence(text)]).toEqual([name, name]);
    }
  });

  test("and it is a different sentence from the product's in every case", () => {
    // Otherwise this block would be asserting that the fixture echoes the
    // product, which is the opposite of a control.
    for (const name of Object.keys(OTHER_IMPLEMENTATION) as Array<keyof typeof OTHER_IMPLEMENTATION>) {
      expect(OTHER_IMPLEMENTATION[name]).not.toBe(SENTENCE[name]);
    }
  });

  test("a fan-out line that numbers no wave is still wave one's", () => {
    // The fixture reports one sentence for the run rather than one per wave.
    // That is a rendering choice, not a non-conformance, and the item grades
    // wave one either way.
    const line = waveOne(`ladder: 2 rungs\n${OTHER_IMPLEMENTATION.feasibility}\n  wave 1     8 item(s)\n`);
    expect(line?.wave).toBeNull();
    expect(line?.workers).toBe(5);
    expect(line?.filter).toBe("feasibility");
    // And the product's numbered form still resolves to the same place.
    expect(waveOne(ADMISSION_BLOCK)?.wave).toBe(1);
    expect(waveOne(ADMISSION_BLOCK)?.filter).toBe("item-count");
  });

  test("NEGATIVE: widening the labels did not make prose without a label pass", () => {
    // The whole risk of anchoring on a label is that the alternation swallows
    // anything. It does not: a sentence that names no filter is still `null`,
    // and one that names two is still refused.
    expect(classifyBindingSentence("admitted: 3 worker(s) — that seemed about right")).toBeNull();
    expect(classifyBindingSentence("admitted: 3 worker(s) — the machine decided")).toBeNull();
    expect(
      classifyBindingSentence("admitted: 3 worker(s) — desirability capped it, and so did available RAM"),
    ).toBeNull();
  });
});
