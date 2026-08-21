// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 74 — the planner, and the rules its output is held to.
 *
 * The assertions that matter are about what the parser REFUSES. A planner that
 * returns prose is a fact an operator needs to see; a parser that salvaged
 * something from it would hand `validatePlan` a plan nobody wrote, which is
 * worse than the refusal in every way that matters.
 */

import { describe, expect, test } from "bun:test";
import {
  PLANNER_RULES,
  PlannerUnusable,
  extractPlanJson,
  looksTrivial,
  plannerBrief,
} from "../src/plan/planner.ts";
import { parsePlan } from "../src/queue/plan.ts";
import { choosePlanner } from "../src/plan/commission.ts";

const PLAN = `{"version":1,"items":[{"id":"a","kind":"write","paths":["src/a.ts"],"prompt":"do a"}]}`;

describe("the brief", () => {
  test("the stable rules come FIRST, before anything that varies", () => {
    // Ruling 21 measured a 16.5x cache lever on a byte-stable prefix. A brief
    // that put the goal before the rules would spend it on every plan.
    const brief = plannerBrief({ goal: "add pagination", repoMap: "", repoName: "app" });
    expect(brief.startsWith(PLANNER_RULES)).toBe(true);
  });

  test("two goals share a byte-identical prefix", () => {
    const a = plannerBrief({ goal: "one", repoMap: "", repoName: "app" });
    const b = plannerBrief({ goal: "two", repoMap: "", repoName: "app" });
    let shared = 0;
    while (shared < a.length && a[shared] === b[shared]) shared++;
    expect(shared).toBeGreaterThanOrEqual(PLANNER_RULES.length);
  });

  test("an absent repo map is omitted rather than announced as empty", () => {
    // Ruling 39 calls the map "a cheap lottery ticket": a miss costs its own
    // ~1,003 tokens. An empty section costs tokens to say nothing.
    const brief = plannerBrief({ goal: "g", repoMap: "   ", repoName: "app" });
    expect(brief).not.toContain("A map of this repository");
  });

  test("the map is included when there is one", () => {
    const brief = plannerBrief({ goal: "g", repoMap: "src/a.ts: foo, bar", repoName: "app" });
    expect(brief).toContain("src/a.ts: foo, bar");
  });
});

describe("the rules the planner is held to are the rulings, stated", () => {
  test("ruling 14's legality filter is stated as absolute", () => {
    expect(PLANNER_RULES).toContain("NO TWO ITEMS MAY CLAIM THE SAME PATH");
  });

  test("ruling 31's fence is stated, including that setting effort is refused BY NAME", () => {
    expect(PLANNER_RULES).toContain("MAY NOT set `effort`");
  });

  test("ruling 67's clamp is stated, so inflating difficulty is not a free move", () => {
    expect(PLANNER_RULES).toContain("clamped down");
  });

  test("ruling 16 is honoured: the prompt must stand alone, because a worker has no memory of the plan", () => {
    expect(PLANNER_RULES).toContain("has seen nothing else");
  });

  test("a single-item plan is named as CORRECT, not as a failure", () => {
    // Otherwise a planner facing an indivisible goal invents fan-out to look
    // useful — and ruling 14 would then refuse the plan it was pushed into.
    expect(PLANNER_RULES).toContain("That is a correct plan, not a failure");
  });
});

describe("extracting the plan, and refusing rather than salvaging", () => {
  test("a bare object works", () => {
    expect(JSON.parse(extractPlanJson(PLAN, "claude")).items).toHaveLength(1);
  });

  test("a fenced block works, because that is how models actually reply", () => {
    const reply = "Here is the plan:\n\n```json\n" + PLAN + "\n```\n\nWant me to explain it?";
    expect(JSON.parse(extractPlanJson(reply, "claude")).version).toBe(1);
  });

  test("an unfenced object with prose around it works", () => {
    expect(JSON.parse(extractPlanJson(`Sure. ${PLAN} Let me know.`, "claude")).items).toHaveLength(1);
  });

  test("PROSE ONLY refuses, and carries the raw text so a person can see it", () => {
    try {
      extractPlanJson("I would start by reading the users endpoint.", "codex");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PlannerUnusable);
      expect((error as PlannerUnusable).received).toContain("users endpoint");
      expect((error as Error).message).toContain("codex");
    }
  });

  test("MALFORMED JSON refuses rather than being repaired", () => {
    expect(() => extractPlanJson('```json\n{"items":[}\n```', "claude")).toThrow(PlannerUnusable);
  });

  test("the extracted text is what `parsePlan` then reads, unchanged", () => {
    // The whole point of ruling 74 being cheap: no second validation path. What
    // a planner produced goes through the same parser as a hand-written file.
    const spec = parsePlan(extractPlanJson("```json\n" + PLAN + "\n```", "claude"), "planner");
    expect(Array.isArray(spec.items)).toBe(true);
  });
});

describe("D3: work that needs no plan should not pay for one", () => {
  test("a short obviously-trivial goal is flagged", () => {
    expect(looksTrivial("fix the typo in the readme")).toBe(true);
    expect(looksTrivial("bump the lockfile")).toBe(true);
  });

  test("a substantial goal is not", () => {
    expect(looksTrivial("add pagination to the users and orders endpoints with tests")).toBe(false);
  });

  test("a LONG goal is never trivial, however it is worded", () => {
    // The guard against the heuristic's own failure mode: a long sentence
    // containing the word "rename" is not a rename.
    const long = "rename the user model and then migrate every caller across the api and the workers and update the docs";
    expect(looksTrivial(long)).toBe(false);
  });
});

describe("who plans", () => {
  test("the operator's configured order wins, because ruling 71 writes it to be changed", () => {
    expect(choosePlanner(["claude", "codex"], ["codex", "claude"])).toBe("codex");
  });

  test("a configured agent that is NOT usable is skipped rather than attempted", () => {
    // Detection is ruling 41's two steps; a configured-but-unusable agent is a
    // stale config, and failing at it would spend a spawn to learn what
    // detection already knew.
    expect(choosePlanner(["claude"], ["gemini", "claude"])).toBe("claude");
  });

  test("with no config, a usable agent is chosen rather than nothing", () => {
    expect(choosePlanner(["opencode"], undefined)).toBe("opencode");
  });

  test("nothing usable chooses NOTHING, rather than a plausible default", () => {
    // The caller turns this into a refusal naming each vendor's own remedy.
    // Returning a guess here would spawn a vendor detection said was unusable.
    expect(choosePlanner([], ["claude"])).toBeUndefined();
    expect(choosePlanner([], undefined)).toBeUndefined();
  });

  test("the planner is NOT chosen by the competence table", () => {
    // Deliberate: the table's own header says "Not one row says `measured`", and
    // the plan is the single most consequential call in a run. A stable choice
    // that an operator can override beats a ranking nobody has evidence for.
    expect(choosePlanner(["copilot", "claude"], undefined)).toBe("copilot");
  });
});
