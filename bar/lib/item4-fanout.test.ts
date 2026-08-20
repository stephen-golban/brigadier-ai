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

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Checks, leader } from "./checks.ts";
import { gatherRunEvidence, proofOfWork } from "./evidence.ts";
import { isolatedPath, plantFleet } from "./fixtures.ts";
import { ensureDir, pruneEmpty, removeDir, writeScript } from "./fs.ts";
import { makeRepo, plantSeeds } from "./git.ts";
import { runSampled } from "./inflight.ts";
import { disjointPlan, writePlan } from "./plan.ts";
import { baseEnv, exec } from "./proc.ts";
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

/**
 * The same fixture's RAM sentence on a machine with room for NOTHING, which is
 * every GitHub-hosted runner this repository builds on.
 *
 * It is here because it is the sentence most likely to break the classifier: it
 * carries a second worker count, a second clause and a full stop the other
 * three do not have. A widened label alternation that swallowed it — or refused
 * it — would take item 4's whole ruling-54 half down with it, on CI only.
 */
const FIXTURE_ZERO_CAP_SENTENCE =
  "admitted: 1 worker(s) — available RAM capped it at 0, which was the binding filter: this machine's TOTAL " +
  "memory, less the operating system's share and the host agent's own, leaves room for none at 3 GiB each. " +
  "One worker runs regardless and the fan-out is serial, because a zero-worker admission is not a refusal: " +
  "it is a run that does nothing and then reports success for it";

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

  test("the zero-cap sentence is still ONE filter, and it is feasibility", () => {
    expect(classifyBindingSentence(FIXTURE_ZERO_CAP_SENTENCE)).toBe("feasibility");
    // And it is read as ONE worker — the number that ran — rather than as the
    // zero it explains. A sentence whose own arithmetic is quoted inside it is
    // exactly where a count-scraping regex goes wrong.
    const line = waveOne(FIXTURE_ZERO_CAP_SENTENCE);
    expect(line?.workers).toBe(1);
    expect(line?.filter).toBe("feasibility");
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

/**
 * ── THE SMALL HOST, DRIVEN ──────────────────────────────────────────────────
 *
 * WHY THIS EXISTS. Round 18 replaced the fixture's `const byRam = 64` with a
 * real cap computed from `totalmem()`, which was right — a constant is not a
 * cap and ruling 54's third sentence could never be driven against one. On the
 * owner's 24 GiB host it worked. MEASURED by the coordinator against
 * `gates.yml` on 2026-08-20: on `ubuntu-latest` and `macos-latest` it returned
 * ZERO, `admit` handed that zero to a short-circuit that dispatched nothing,
 * and twelve tests on each runner failed with `record.items gave no items at
 * all` — a string that appears in no earlier CI log. The fixture cloned
 * nothing, spawned nothing, merged nothing, and exited 0.
 *
 * So the repair is worth nothing unless it is measured on the machine it is
 * for, and nobody here owns a 7 GiB machine. These arms build a copy of
 * `bar/fakes/honest.ts` with its ONE reading of this host's memory rewritten to
 * a fixed number and then drive it for real — real `git clone`, real worker
 * processes, real `git merge-tree`, real record — through the same
 * `proofOfWork` gate that failed on CI. The rewrite is asserted, for the reason
 * `bar/lib/item12-negative-control.test.ts` states at length: a control built
 * by string replacement whose anchor has been reworded still compiles, still
 * runs, and silently stops controlling.
 *
 * The second arm is the one that makes the first mean something. It puts the
 * two lines back exactly as they stood in `7ff6431` and requires the run to
 * produce nothing — so "the fixture works on a small host" is a difference this
 * file can see, rather than a claim about a machine it cannot reach.
 */

const HONEST = fileURLToPath(new URL("../fakes/honest.ts", import.meta.url));
const VENDOR_SCRIPT = fileURLToPath(new URL("../fakes/vendor.ts", import.meta.url));
const LIB_DIR = fileURLToPath(new URL(".", import.meta.url));
const GIB = 1024 ** 3;

// Outside every temp root, because ruling 61 is one of the things the drive
// below asserts and a harness under `/tmp` would fail the item it is checking.
const ROOTS = join(homedir(), ".brigadier-bar-item4");
afterAll(() => pruneEmpty(ROOTS));

interface Rewrite {
  /** What this edit is for, quoted back in the error if its anchor is gone. */
  why: string;
  find: string;
  replace: string;
}

/** A copy of the honest fixture with named edits applied, each one asserted. */
function variantOf(dir: string, name: string, rewrites: readonly Rewrite[]): string {
  let source = readFileSync(HONEST, "utf8");
  // The copy lives outside `bar/fakes/`, so everything it reaches for by
  // relative path is made absolute first.
  const relocations: Rewrite[] = [
    { why: "relocate the fixture's `../lib` imports", find: 'from "../lib/', replace: `from "${LIB_DIR}` },
    {
      why: "relocate the vendor script the fixture spawns",
      find: 'fileURLToPath(new URL("./vendor.ts", import.meta.url))',
      replace: JSON.stringify(VENDOR_SCRIPT),
    },
  ];
  for (const rewrite of [...relocations, ...rewrites]) {
    if (!source.includes(rewrite.find)) {
      throw new Error(
        `the small-host control could not apply "${rewrite.why}": the anchor ${JSON.stringify(rewrite.find)} is no ` +
          "longer present in bar/fakes/honest.ts. A control that silently stops controlling is worse than no " +
          "control, so this is an error rather than a skipped edit. Re-anchor it against the current fixture.",
      );
    }
    source = source.split(rewrite.find).join(rewrite.replace);
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, source);
  return path;
}

/**
 * The whole point: the fixture reads this machine's memory in exactly one
 * place, so exactly one edit makes it a different machine. Nothing else about
 * the arithmetic is touched — the reserves, the per-worker budget and the
 * division are the fixture's own on both sides of this rewrite.
 */
function forceTotalMemory(bytes: number): Rewrite {
  return {
    why: `force the fixture's only reading of this host's total memory to ${bytes} bytes`,
    find: "function hostTotalMemoryBytes(): number {\n  return totalmem();\n}",
    replace: `function hostTotalMemoryBytes(): number {\n  return ${bytes};\n}`,
  };
}

/** `7ff6431`'s two lines, restored verbatim. This is the defect, executable. */
const THE_DEFECT_RESTORED: readonly Rewrite[] = [
  {
    why: "put back the unfloored worker count, so a zero cap admits zero workers",
    find: "  const workers = Math.min(byPlan, Math.max(1, Math.min(byDesirability, byRam)));",
    replace: "  const workers = Math.min(byPlan, byDesirability, byRam);",
  },
  {
    why: "put back the short-circuit that made a zero-worker admission dispatch nothing",
    find: "    const eligible = wave;",
    replace: "    const eligible = admission.workers === 0 ? [] : wave;",
  },
];

interface SmallHostResult {
  /** Every `proofOfWork` row that failed, by name. Empty is the pass. */
  failures: string[];
  itemsInRecord: number;
  /** What `git cat-file -t` said about the integration ref. */
  refType: string | undefined;
  clonesSeen: number;
  /** Ruling 54's sentence, as this run printed it. */
  admission: string;
  /** The worker count the run PRINTED, read back out of its own stdout. */
  printedWorkers: number | undefined;
  /** The most clones alive at one moment: what the run actually DISPATCHED. */
  peakConcurrentClones: number;
}

/** A whole brigadier, on a machine of the caller's choosing. */
async function smallHost(
  name: string,
  totalMemoryBytes: number,
  extra: readonly Rewrite[] = [],
  items = 2,
): Promise<{
  dryRun: (args: readonly string[]) => Promise<string>;
  attempt: (args: readonly string[]) => Promise<{ text: string; code: number | null }>;
  run: () => Promise<SmallHostResult>;
  clean: () => void;
}> {
  const root = join(ROOTS, `${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  // EVERYTHING that can throw is inside the guard, and the directory is removed
  // before the error is re-raised. `variantOf` throws by design when one of its
  // anchors has been reworded, and it threw AFTER the `mkdirSync` above and
  // before any caller's `finally` existed — so the arm that exists to fail
  // loudly left a directory under `$HOME` every time it did its job.
  try {
    return await build();
  } catch (error) {
    removeDir(root);
    throw error;
  }

  async function build(): Promise<{
    dryRun: (args: readonly string[]) => Promise<string>;
    attempt: (args: readonly string[]) => Promise<{ text: string; code: number | null }>;
    run: () => Promise<SmallHostResult>;
    clean: () => void;
  }> {
  const script = variantOf(join(root, "fixture"), name, [forceTotalMemory(totalMemoryBytes), ...extra]);
  // Wrapped as an executable, so the fixture is driven exactly as the harness
  // drives a release artifact: argv, stdout, exit code and the filesystem.
  const binary = writeScript(
    join(ensureDir(join(root, "bin")), `brigadier-${name}`),
    `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
  );
  const fleetDir = ensureDir(join(root, "fleet"));
  plantFleet(fleetDir, join(root, "vendor-ledger.tsv"), [{ id: "qwen", version: "0.21.13" }]);
  const env = baseEnv({ PATH: isolatedPath(fleetDir) });
  const repo = join(root, "repo");
  await makeRepo(repo, { "README.md": "base\n" });
  const seeded = disjointPlan(items, name);
  await plantSeeds(repo, seeded.seeds);
  const planFile = writePlan(root, seeded.plan);
  const runs = ensureDir(join(root, "runs"));
  const base = ["run", "--plan", planFile, "--repo", repo, "--run-root", runs];

  /** One admission attempt, with its EXIT CODE — a refusal is not a string. */
  async function attempt(args: readonly string[]): Promise<{ text: string; code: number | null }> {
    const result = await exec([binary, ...base, "--dry-run", ...args], { cwd: root, env, timeoutMs: 120_000 });
    return { text: `${result.stdout}${result.stderr}`, code: result.code };
  }

  return {
    dryRun: async (args) => {
      const attempted = await attempt(args);
      return attempted.text;
    },
    attempt,
    run: async () => {
      const head = (await exec(["git", "rev-parse", "HEAD"], { cwd: repo, timeoutMs: 60_000 })).stdout.trim();
      const sampled = await runSampled([binary, ...base], {
        cwd: root,
        env,
        runRoot: runs,
        operatorHead: head,
        timeoutMs: 300_000,
      });
      const report = `${sampled.stdout}${sampled.stderr}`;
      const evidence = await gatherRunEvidence(repo, report);
      // The same gate that went red on CI, applied to the same evidence — and
      // `expectedWorkers` is READ OUT OF THE REPORT rather than chosen here.
      // That parameter is harness-supplied everywhere else in `bar/`, which is
      // why a binary that printed one worker count and ran a different one went
      // unnoticed for a round: the harness was asserting its own number against
      // itself. Taking it from the binary's own stdout makes `proofOfWork`'s
      // concurrency row a claim the BINARY made, so a run that says `5
      // worker(s)` and clones one at a time now fails on the number it printed.
      const printedWorkers = waveOne(report)?.workers;
      const checks = proofOfWork(evidence, {
        expected: seeded.expected,
        itemIds: seeded.itemIds,
        flight: sampled.flight,
        expectedWorkers: printedWorkers ?? 1,
      });
      return {
        failures: checks.failures.map((f) => f.name),
        itemsInRecord: evidence.record?.items.length ?? 0,
        refType: evidence.refType,
        clonesSeen: sampled.flight.clonesSeen.size,
        admission: waveOne(report)?.text ?? "",
        printedWorkers,
        peakConcurrentClones: sampled.flight.peakConcurrentClones,
      };
    },
    clean: () => removeDir(root),
  };
  }
}

describe("ruling 54's arithmetic, read on hosts nobody here owns", () => {
  test("decision 25's reserve comes off a host session and NOT a terminal run", async () => {
    // The divergence that turned a 7 GiB runner's cap from one into zero: the
    // fixture subtracted the host agent's budget unconditionally, while
    // `src/work/fanout.ts` takes it as `feasibilityCap(hostFirst)` and
    // `src/cli.ts` sets `hostFirst` from `audience === "host-session"`. A
    // terminal run has no host agent to reserve for.
    const host = await smallHost("audience", 7 * GIB);
    try {
      const session = await host.dryRun(["--audience", "host-session"]);
      const terminal = await host.dryRun(["--audience", "terminal"]);
      expect(waveOne(session)?.filter).toBe("feasibility");
      expect(waveOne(terminal)?.filter).toBe("feasibility");
      expect(waveOne(session)?.text).toContain("capped it at 0");
      expect(waveOne(session)?.text).toContain("the host agent's own");
      expect(waveOne(terminal)?.text).toContain("capped it at 1");
      expect(waveOne(terminal)?.text).not.toContain("the host agent's own");
      // Both admit one worker; only one of them had room for it. The count is
      // the same and the reason is not, which is ruling 54's whole complaint.
      expect(waveOne(session)?.workers).toBe(1);
      expect(waveOne(terminal)?.workers).toBe(1);
      expect(waveOne(session)?.text).not.toBe(waveOne(terminal)?.text);
    } finally {
      host.clean();
    }
  }, 300_000);

  test("an unparseable `--workers` is REFUSED, never run as a NaN worker count", async () => {
    // The shape the product carried too: `Number("abc")` is `NaN`, ruling 14's
    // arithmetic is a `Math.min` chain, and a `NaN` worker count dispatches no
    // items and exits reporting success. The positive control must not have the
    // defect it exists to detect, so it refuses at the boundary instead — and
    // this is the working example of the same refusal `src/cli.ts` needs.
    const host = await smallHost("typo", 7 * GIB);
    try {
      for (const typed of ["abc", "", "0", "-1", "2.5", "Infinity"]) {
        const attempted = await host.attempt(["--workers", typed]);
        // A usage error, not a run. Exit 2 is what a missing `--plan` gets.
        expect([typed, attempted.code]).toEqual([typed, 2]);
        expect([typed, attempted.text.includes("--workers must be a whole number of at least 1")]).toEqual([typed, true]);
        // And nothing was admitted: no fan-out sentence was ever printed, so
        // there is no `NaN worker(s)` line for a reader to believe.
        expect([typed, waveOne(attempted.text)]).toEqual([typed, undefined]);
      }
      // A value the operator plainly meant still admits, so this is a guard
      // rather than a flag that stopped working.
      const good = await host.attempt(["--workers", "1"]);
      expect(good.code).toBe(0);
      expect(waveOne(good.text)?.workers).toBe(1);
    } finally {
      host.clean();
    }
  }, 300_000);

  test("and on the owner's 24 GiB host the same arithmetic still answers 5", async () => {
    // The other end of the range, so the floor cannot be mistaken for the
    // answer: a cap this large is computed, is above `MIN_CAP_TO_DISTINGUISH`,
    // and is what lets item 4 drive all three of ruling 54's causes at all.
    // Eight items and a budget above any machine, so neither of the other two
    // filters can be the lowest — the same shape `RAM_LADDER` climbs to.
    const host = await smallHost("roomy", 24 * GIB, [], 8);
    try {
      const session = await host.dryRun(["--audience", "host-session", "--workers", String(WORKERS_ABOVE_ANY_MACHINE)]);
      const line = waveOne(session);
      expect(line?.filter).toBe("feasibility");
      expect(line?.text).toContain("capped it at 5");
      expect(line?.text).toContain("leaves room for that many");
      expect(line?.workers).toBe(5); // computed, not floored — the cap itself
      expect(planTheOtherTwoDrives(5)).not.toBeNull();
      // MEASURED by the coordinator on 2026-08-20: a private repository's
      // runners are 7–8 GiB, and no cap that small can separate three causes.
      expect(planTheOtherTwoDrives(1)).toBeNull();
    } finally {
      host.clean();
    }
  }, 300_000);
});

describe("the positive control on a machine with room for no worker at all", () => {
  test("FORCED 7 GiB: the fixture really clones, integrates and records", async () => {
    const host = await smallHost("small", 7 * GIB);
    try {
      const result = await host.run();
      // The rows that went red on both CI runners, green here on a machine
      // whose memory this file chose.
      expect(result.failures).toEqual([]);
      expect(result.itemsInRecord).toBe(2);
      expect(result.refType).toBe("commit");
      expect(result.clonesSeen).toBeGreaterThan(0);
      // And it did not get there by pretending the machine was bigger: the
      // sentence it printed says the machine had room for none.
      expect(classifyBindingSentence(result.admission)).toBe("feasibility");
      expect(result.admission).toContain("leaves room for none at 3 GiB each");
      // The count on stdout is the floored one, so the number a reader sees is
      // the number that ran. `proofOfWork` above was given this same number
      // rather than one this file picked.
      expect(result.printedWorkers).toBe(1);
      expect(result.peakConcurrentClones).toBeGreaterThanOrEqual(1);
    } finally {
      host.clean();
    }
  }, 900_000);

  test("THE CONTROL: with `7ff6431`'s two lines back, the same run produces NOTHING", async () => {
    // Without this arm the test above is satisfied by any fixture that happens
    // to work, and could not tell a repaired floor from a machine that never
    // needed one.
    const host = await smallHost("small-unfloored", 7 * GIB, THE_DEFECT_RESTORED);
    try {
      const result = await host.run();
      expect(result.itemsInRecord).toBe(0);
      expect(result.clonesSeen).toBe(0);
      expect(result.refType).toBeUndefined();
      // The exact rows the coordinator read out of the CI log.
      expect(result.failures).toContain("the integration ref resolves to a real commit object");
      expect(result.failures).toContain(
        "the record accounts for every plan item, by the ordinal the product routes it under",
      );
      expect(result.failures).toContain("clones really existed while the run was in flight");
    } finally {
      host.clean();
    }
  }, 900_000);
});
