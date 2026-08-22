// SPDX-License-Identifier: Apache-2.0
/**
 * D8, D9, D18 — the cold vendor — and D7, D17, D19 — the review clamp.
 *
 * **The assertion that carries the most weight is D9's**, and it is the one that
 * looks like an omission: an unclassified failure must NOT mark a vendor cold.
 * A mechanism that routed away on every failure would pass every "does failover
 * work" test while walking broken work down the whole fleet, one burnt attempt
 * per vendor, and ending with a report blaming six vendors for one bad plan.
 *
 * The clamp's is the mirror image: there is no input anywhere below that turns a
 * `true` into a `false`, and the test for that is written as an exhaustive sweep
 * rather than as an example, because one-way-ness is a property and examples do
 * not establish properties.
 */

import { describe, expect, test } from "bun:test";
import {
  COLD_MS,
  classify,
  eligibility,
  markCold,
  stillCold,
  thawed,
  type ColdEntry,
} from "../src/router/cold.ts";
import {
  MIN_RUNS_FOR_HISTORY,
  REVIEW_FLOOR_BYTES,
  REVIEW_FLOOR_PATHS,
  clampReview,
  noReviewDeparture,
} from "../src/queue/clamp.ts";

const NOW = 1_787_000_000_000;

describe("D9: an unclassified failure is the WORK failing, not the vendor", () => {
  test("a message no class recognises marks nothing cold", () => {
    const { cold, classified } = markCold([], "claude", "the diff did not apply cleanly", NOW);
    expect(classified).toBeUndefined();
    // This is the whole of D9. Routing away here walks broken work down the
    // fleet, one burnt attempt per vendor.
    expect(cold).toEqual([]);
  });

  test("nor does an ordinary test failure, which is the most common failure there is", () => {
    expect(classify("2 tests failed in auth.test.ts")).toBeUndefined();
    expect(classify("the worker produced no diff")).toBeUndefined();
    expect(classify("verify exited 1")).toBeUndefined();
  });

  test("THE CONTROL: the classes that DO fire, each anchored on measured words", () => {
    // Every string here appeared in this repository's own measurements.
    expect(classify("session/new: -32000 Authentication required")).toBe("credential");
    expect(classify("Not logged in · Please run /login")).toBe("credential");
    expect(classify("Gemini API key is missing or not configured")).toBe("credential");
    expect(classify("429 too many requests")).toBe("exhausted");
    expect(classify("you have hit your usage limit")).toBe("exhausted");
    expect(classify("error: unknown option '--brigadier'")).toBe("unstartable");
    expect(classify("qwen did not answer within the detection timeout")).toBe("unstartable");
  });

  test("the set is CLOSED, and that closure is what D9 is made of", () => {
    // A catch-all member would delete the distinction the rule turns on.
    const classes = new Set(
      ["Authentication required", "rate limit", "unknown option"].map((m) => classify(m)),
    );
    expect(classes).toEqual(new Set(["credential", "exhausted", "unstartable"]));
  });
});

describe("D8: a classified failure marks the vendor cold, and quota is never read", () => {
  test("a credential refusal takes the vendor out", () => {
    const { cold, classified } = markCold([], "codex", "-32000 Authentication required", NOW);
    expect(classified).toBe("credential");
    expect(cold).toHaveLength(1);
    expect(cold[0]?.agent).toBe("codex");
    // The vendor's own words survive, because a report that paraphrases a
    // refusal has removed the only text the operator can act on.
    expect(cold[0]?.said).toContain("Authentication required");
  });

  test("a second failure from the same vendor replaces rather than duplicates", () => {
    const first = markCold([], "codex", "rate limit", NOW).cold;
    const second = markCold(first, "codex", "Authentication required", NOW + 1000).cold;
    expect(second).toHaveLength(1);
    expect(second[0]?.why).toBe("credential");
  });
});

describe("D18: cold expires on ELAPSED TIME, and the classes differ", () => {
  const cold: ColdEntry[] = [
    { agent: "codex", why: "credential", since: NOW, said: "Authentication required" },
    { agent: "qwen", why: "exhausted", since: NOW, said: "rate limit" },
  ];

  test("a shorter window thaws first, and the longer one is still frozen", () => {
    const later = NOW + COLD_MS.exhausted + 1000;
    expect(thawed(cold, later).map((e) => e.agent)).toEqual(["qwen"]);
    expect(stillCold(cold, later).map((e) => e.agent)).toEqual(["codex"]);
  });

  test("a credential failure stays cold longer than an exhausted one, because nothing we do fixes it", () => {
    expect(COLD_MS.credential).toBeGreaterThan(COLD_MS.exhausted);
  });

  test("nothing anywhere reads a vendor's stated reset", () => {
    // D18: `resetsAt` was recorded drifting with wall clock, so a design that
    // waited on it would be waiting on a number measured to be wrong. The entry
    // type has nowhere to put one.
    expect(Object.keys(cold[0] as object).sort()).toEqual(["agent", "said", "since", "why"]);
  });
});

describe("D18: cold removes a vendor from BUILD and keeps it as a REVIEWER", () => {
  const agents = ["claude", "codex", "copilot"];
  const cold: ColdEntry[] = [{ agent: "codex", why: "exhausted", since: NOW, said: "rate limit" }];

  test("the asymmetry: a builder failure costs an attempt, a reviewer failure costs a turn", () => {
    const eligible = eligibility(agents, cold, NOW + 1000);
    expect(eligible.builders).toEqual(["claude", "copilot"]);
    expect(eligible.reviewers).toEqual(agents);
    expect(eligible.forced).toBe(false);
  });

  test("the exclusion is REPORTED, with the window named as a judgement", () => {
    const eligible = eligibility(agents, cold, NOW + 1000);
    expect(eligible.lines.join("\n")).toContain("out of BUILD");
    expect(eligible.lines.join("\n")).toContain("still eligible to REVIEW");
    expect(eligible.lines.join("\n")).toContain("judgement, not a measurement");
    // And the vendor's own words reach the operator.
    expect(eligible.lines.join("\n")).toContain("rate limit");
  });

  test("a fleet with EVERY vendor cold builds anyway, and says so", () => {
    // Refusing would turn a rate limit into a failed run on a single-vendor
    // machine, which ruling 32 makes a supported and common configuration.
    const all: ColdEntry[] = agents.map((agent) => ({ agent, why: "exhausted", since: NOW, said: "rate limit" }));
    const eligible = eligibility(agents, all, NOW + 1000);
    expect(eligible.builders).toEqual(agents);
    expect(eligible.forced).toBe(true);
    expect(eligible.lines.join("\n")).toContain("BUILDS ON A COLD VENDOR");
  });

  test("a thawed vendor is a builder again with no further ceremony", () => {
    expect(eligibility(agents, cold, NOW + COLD_MS.exhausted + 1).builders).toEqual(agents);
  });
});

describe("D17: the review decision clamps, and only upward", () => {
  const small = { paths: 1, bytes: 100 };
  const large = { paths: REVIEW_FLOOR_PATHS, bytes: 100 };

  test("THE PROPERTY, swept rather than exampled: no input turns a yes into a no", () => {
    for (const planner of [true, false, undefined]) {
      for (const operator of [true, false]) {
        for (const structure of [small, large, { paths: 1, bytes: REVIEW_FLOOR_BYTES }]) {
          const result = clampReview({ planner, operator, structure });
          // Every path that should force review does, and nothing unsets it.
          const mustReview = operator || planner === true || structure !== small;
          if (mustReview) expect(result.review).toBe(true);
        }
      }
    }
  });

  test("D7: the planner's judgement is the default when nothing overrides it", () => {
    expect(clampReview({ planner: true, operator: false, structure: small }).review).toBe(true);
    expect(clampReview({ planner: false, operator: false, structure: small }).review).toBe(false);
  });

  test("the planner saying NO is overridden by the structural floor, and the line says so", () => {
    const result = clampReview({ planner: false, operator: false, structure: large });
    expect(result.review).toBe(true);
    expect(result.overridden).toBe(true);
    expect(result.why).toContain("overrode it TOWARD review");
  });

  test("the floor firing with NO planner is not an override, and does not claim to be", () => {
    const result = clampReview({ planner: undefined, operator: false, structure: large });
    expect(result.review).toBe(true);
    expect(result.overridden).toBe(false);
    expect(result.why).not.toContain("overrode");
  });

  test("`--review` wins over everything and is reported as the operator's choice", () => {
    const result = clampReview({ planner: false, operator: true, structure: small });
    expect(result.review).toBe(true);
    expect(result.why).toContain("you asked for it");
  });

  test("every decision carries its reason on ONE line (D24, ruling 52)", () => {
    for (const planner of [true, false, undefined]) {
      const result = clampReview({ planner, operator: false, structure: small });
      expect(result.why.split("\n")).toHaveLength(1);
      expect(result.why.startsWith("review: ")).toBe(true);
    }
  });
});

describe("D19: the floor is structural — no globs, and no test suite required", () => {
  test("bytes alone can trip it, and so can paths alone", () => {
    expect(clampReview({ planner: false, operator: false, structure: { paths: 1, bytes: REVIEW_FLOOR_BYTES } }).review).toBe(true);
    expect(clampReview({ planner: false, operator: false, structure: { paths: REVIEW_FLOOR_PATHS, bytes: 0 } }).review).toBe(true);
  });

  test("a repository with NO test suite is a normal repository", () => {
    // Nothing in the input mentions a verify command, and nothing in the output
    // asks for one. D19: nothing pushes the operator toward having tests and
    // nothing warns them for not having them.
    const result = clampReview({ planner: false, operator: false, structure: { paths: 1, bytes: 10 } });
    expect(result.why).not.toMatch(/test|verify|coverage/i);
  });

  test("the floor NAMES itself as a judgement wherever it fires", () => {
    const result = clampReview({ planner: undefined, operator: false, structure: large_() });
    expect(result.why).toContain("judgement, not a measurement");
    expect(result.why).toContain("no globs");
  });

  function large_() {
    return { paths: REVIEW_FLOOR_PATHS + 1, bytes: 0 };
  }
});

describe("D17: the no-review rate is tracked against the repository's own history", () => {
  test("a new repository gets NO comparison rather than a comparison against noise", () => {
    // Ruling 67's accepted cost, a third time: the mechanism aimed at the real
    // failure is the one that takes longest to become useful.
    expect(noReviewDeparture([0.1, 0.1], 0.9)).toBeUndefined();
    expect(noReviewDeparture([], 1)).toBeUndefined();
  });

  test("a departure is REPORTED and does not block", () => {
    const history = Array.from({ length: MIN_RUNS_FOR_HISTORY }, () => 0.1);
    const line = noReviewDeparture(history, 0.9);
    expect(line).toContain("90%");
    expect(line).toContain("10%");
    expect(line).toContain("Reported, not blocked");
  });

  test("a repository legitimately full of one-file changes is NOT flagged", () => {
    // The negative control that keeps this from being noise: a high rate that
    // matches the repository's own history is not a departure.
    const history = Array.from({ length: MIN_RUNS_FOR_HISTORY }, () => 0.9);
    expect(noReviewDeparture(history, 0.9)).toBeUndefined();
  });

  test("a run that reviewed MORE than usual is not a departure — the check is one-directional", () => {
    const history = Array.from({ length: MIN_RUNS_FOR_HISTORY }, () => 0.9);
    expect(noReviewDeparture(history, 0.1)).toBeUndefined();
  });
});
