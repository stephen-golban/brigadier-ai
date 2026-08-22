// SPDX-License-Identifier: Apache-2.0
/**
 * D6's spread, D20's ranking and ruling 81's exploration floor.
 *
 * **THE DEFECT THIS REPLACES, and it is why the first test is the one it is.**
 * `src/queue/execute.ts` read `options.admission.agents[0]` and gave every item
 * of every run to the first agent on the list. Five items on a three-vendor
 * machine were five claude workers, and nothing in the record said so — the
 * monoculture D20 names the objection to, arriving through the door nobody was
 * watching. A test that only checked "each item got an agent" would have passed
 * against that code.
 */

import { describe, expect, test } from "bun:test";
import { assign, rankFor, strideFor, type Candidate } from "../src/router/assign.ts";
import {
  MIN_OBSERVATIONS,
  OUTCOME_CAVEAT,
  accumulate,
  adjustment,
  provenance,
  tallyKey,
  type Tally,
} from "../src/router/outcomes.ts";
import { DEFAULT_EXPLORATION_FLOOR } from "../src/config/config.ts";
import type { WorkKind } from "../src/work/kind.ts";

const NONE = new Map<string, Tally>();
const items = (count: number, kind: WorkKind = "write") =>
  Array.from({ length: count }, (_, index) => ({ number: index + 1, kind }));

const THREE: Candidate[] = [
  { id: "claude", score: 80 },
  { id: "codex", score: 80 },
  { id: "copilot", score: 65 },
];

/** No exploration, so spreading can be asserted on its own. */
const spread = (count: number, candidates = THREE) =>
  assign({ items: items(count), candidates, outcomes: NONE, explorationFloor: 0 });

describe("D6: assignment spreads across distinct vendors first", () => {
  test("THREE ITEMS ON THREE VENDORS GET ONE EACH", () => {
    const agents = spread(3).map((a) => a.agent);
    expect(new Set(agents).size).toBe(3);
    expect([...agents].sort()).toEqual(["claude", "codex", "copilot"]);
  });

  test("three items on a CLAUDE-ONLY machine get three claude workers", () => {
    // D6's other half, word for word: "a single-vendor machine keeps its
    // parallelism". A spread that stalled here would have traded the
    // monoculture for a worse bug.
    const agents = spread(3, [{ id: "claude", score: 80 }]).map((a) => a.agent);
    expect(agents).toEqual(["claude", "claude", "claude"]);
  });

  test("five items on three vendors reuse only after all three are used", () => {
    const agents = spread(5).map((a) => a.agent);
    expect(new Set(agents.slice(0, 3)).size).toBe(3);
    // And the fourth starts a new round rather than piling onto one vendor.
    expect(new Set(agents.slice(3, 5)).size).toBe(2);
  });

  test("NEGATIVE CONTROL: the old behaviour is what this rejects", () => {
    // Every item to `agents[0]`. If `assign` ever regresses to that, this is
    // the assertion that says so in the language of the defect.
    const agents = spread(5).map((a) => a.agent);
    expect(agents.every((agent) => agent === agents[0])).toBe(false);
  });

  test("every item is assigned, and to a vendor that was offered", () => {
    const assigned = spread(7);
    expect(assigned).toHaveLength(7);
    expect(assigned.map((a) => a.item)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const one of assigned) expect(THREE.map((c) => c.id)).toContain(one.agent);
  });

  test("no candidates is an empty assignment, not a throw", () => {
    // A machine with no drivable vendor is refused at admission, long before
    // this. A second refusal here would be a second place for that message.
    expect(assign({ items: items(3), candidates: [], outcomes: NONE, explorationFloor: 0 })).toEqual([]);
  });
});

describe("D20: best of what is available, within the spread", () => {
  test("the highest-ranked unused vendor takes the next item", () => {
    const assigned = spread(1, [
      { id: "weak", score: 10 },
      { id: "strong", score: 90 },
    ]);
    expect(assigned[0]?.agent).toBe("strong");
  });

  test("ruling 68: an UNRANKED vendor sorts last and is NOT excluded", () => {
    const ranked = rankFor([{ id: "unknown", score: undefined }, { id: "known", score: 50 }], "write", NONE);
    expect(ranked.map((c) => c.id)).toEqual(["known", "unknown"]);
    // Eligible: with two items it gets one, because the spread reaches it.
    const agents = spread(2, [{ id: "known", score: 50 }, { id: "unknown", score: undefined }]).map((a) => a.agent);
    expect(agents).toContain("unknown");
  });

  test("ties break on the id, so a run is REPRODUCIBLE", () => {
    const a = rankFor([{ id: "b", score: 80 }, { id: "a", score: 80 }], "write", NONE);
    const b = rankFor([{ id: "a", score: 80 }, { id: "b", score: 80 }], "write", NONE);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });

  test("the same input assigns the same way twice", () => {
    expect(spread(9).map((a) => a.agent)).toEqual(spread(9).map((a) => a.agent));
  });

  test("every assignment SAYS why, on one line", () => {
    for (const one of spread(4)) {
      expect(one.why.length).toBeGreaterThan(0);
      expect(one.why.split("\n")).toHaveLength(1);
      // Ruling 52: the qualifier lives inside the result, never in a footnote.
      expect(one.why).toContain(one.agent);
    }
  });
});

describe("ruling 81: the exploration floor is mandatory and deterministic", () => {
  test("with the default floor, a vendor the ranking did NOT pick still gets work", () => {
    // v1's finding 87 is the failure: a model scored 85, silently excluded from
    // every `hard` item. The floor is what stops an early failure entrenching.
    const assigned = assign({
      items: items(10),
      candidates: [{ id: "strong", score: 95 }, { id: "weak", score: 5 }],
      outcomes: NONE,
      explorationFloor: DEFAULT_EXPLORATION_FLOOR,
    });
    const exploring = assigned.filter((a) => a.why.includes("exploration floor"));
    expect(exploring.length).toBeGreaterThan(0);
    // And the exploring items name the floor in the line, per ruling 81's
    // requirement that it be printed beside the ranking it protects.
    for (const one of exploring) expect(one.why).toContain(String(DEFAULT_EXPLORATION_FLOOR));
  });

  test("the stride is 1/floor, and a floor of zero disables it", () => {
    expect(strideFor(0.2)).toBe(5);
    expect(strideFor(0.5)).toBe(2);
    expect(strideFor(0)).toBeUndefined();
    // An operator who sets zero has made a choice their config records, which is
    // different from the code having no floor.
    const assigned = assign({
      items: items(10),
      candidates: [{ id: "strong", score: 95 }, { id: "weak", score: 5 }],
      outcomes: NONE,
      explorationFloor: 0,
    });
    expect(assigned.every((a) => !a.why.includes("exploration floor"))).toBe(true);
  });

  test("it is DETERMINISTIC, not random — the same run twice is the same run", () => {
    const once = assign({ items: items(20), candidates: THREE, outcomes: NONE, explorationFloor: 0.2 });
    const twice = assign({ items: items(20), candidates: THREE, outcomes: NONE, explorationFloor: 0.2 });
    expect(once.map((a) => a.agent)).toEqual(twice.map((a) => a.agent));
  });

  test("with one vendor there is nothing to explore to, and it does not pretend", () => {
    const assigned = assign({
      items: items(10),
      candidates: [{ id: "only", score: 50 }],
      outcomes: NONE,
      explorationFloor: 0.5,
    });
    expect(assigned.every((a) => a.agent === "only")).toBe(true);
    expect(assigned.every((a) => !a.why.includes("exploration floor"))).toBe(true);
  });
});

describe("ruling 81: outcomes may feed competence, and cost may not", () => {
  const observe = (n: number, passed: boolean, kind: WorkKind = "write") => {
    let tallies: ReadonlyMap<string, Tally> = NONE;
    for (let i = 0; i < n; i += 1) {
      tallies = accumulate(tallies, { agent: "a", kind, passed, rungs: 1 });
    }
    return tallies;
  };

  test("below the observation floor, nothing moves — and the provenance SAYS so", () => {
    const few = observe(MIN_OBSERVATIONS - 1, false);
    expect(adjustment(few.get(tallyKey("a", "write")))).toBeUndefined();
    expect(provenance(few.get(tallyKey("a", "write")))).toContain("below the");
  });

  test("a vendor that keeps failing is adjusted DOWN, and one that passes is adjusted up", () => {
    expect(adjustment(observe(5, false).get(tallyKey("a", "write")))).toBeLessThan(0);
    expect(adjustment(observe(5, true).get(tallyKey("a", "write")))).toBeGreaterThan(0);
  });

  test("the adjustment is BOUNDED, so a local record cannot dominate the table", () => {
    const worst = adjustment(observe(50, false).get(tallyKey("a", "write"))) ?? 0;
    const best = adjustment(observe(50, true).get(tallyKey("a", "write"))) ?? 0;
    expect(Math.abs(worst)).toBeLessThanOrEqual(20);
    expect(Math.abs(best)).toBeLessThanOrEqual(20);
  });

  test("outcomes are PER KIND: failing at `write` does not demote a researcher", () => {
    const writes = observe(5, false, "write");
    expect(adjustment(writes.get(tallyKey("a", "write")))).toBeLessThan(0);
    expect(adjustment(writes.get(tallyKey("a", "research")))).toBeUndefined();
  });

  test("a reviewer rejection counts, and an unreviewed item is not a pass for the reviewer", () => {
    const rejected = accumulate(NONE, { agent: "a", kind: "write", passed: true, rungs: 1, reviewerRejected: true });
    const unreviewed = accumulate(NONE, { agent: "a", kind: "write", passed: true, rungs: 1 });
    expect(rejected.get(tallyKey("a", "write"))?.reviewed).toBe(1);
    expect(unreviewed.get(tallyKey("a", "write"))?.reviewed).toBe(0);
  });

  test("the learned number changes the ranking, and the provenance travels with it", () => {
    const failing = observe(6, false);
    const ranked = rankFor([{ id: "a", score: 80 }, { id: "b", score: 75 }], "write", failing);
    // `a` outranks `b` by 5 on the hand-maintained table and loses it here.
    expect(ranked[0]?.id).toBe("b");
    const assigned = assign({
      items: items(2),
      candidates: [{ id: "a", score: 80 }, { id: "b", score: 75 }],
      outcomes: failing,
      explorationFloor: 0,
    });
    // `b` wins the first item on a table where it is 5 points behind. That IS
    // the learned number acting.
    expect(assigned[0]?.agent).toBe("b");
    // Ruling 81's accepted cost #1: a learned column has a provenance a reader
    // cannot check by eye unless the count is printed with it. The line for the
    // vendor that HAS observations carries them; the one that has none says so
    // rather than staying silent, which is the same distinction one field over.
    const forA = assigned.find((one) => one.agent === "a");
    expect(forA?.why).toContain("observation(s) on this machine");
    expect(forA?.why).toContain("6 observation(s)");
    expect(assigned[0]?.why).toContain("no observations here");
  });

  test("THERE IS NO COST FIELD to derive a number from", () => {
    // Ruling 81 hardens the cost bar rather than relaxing it, and the strongest
    // form of that is a type with nowhere to put one. #44 measured 15× variance
    // between two identical runs; a cost-derived score would rank noise.
    const observation = { agent: "a", kind: "write" as WorkKind, passed: true, rungs: 1 };
    expect(Object.keys(accumulate(NONE, observation).get(tallyKey("a", "write")) ?? {})).toEqual([
      "attempts",
      "passed",
      "rungs",
      "reviewed",
      "rejected",
    ]);
  });

  test("the caveat that no arithmetic can fix is carried, not implied", () => {
    expect(OUTCOME_CAVEAT).toContain("the vendor is not the only cause");
    expect(OUTCOME_CAVEAT).toContain("ruling 81");
  });
});
