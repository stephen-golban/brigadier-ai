// SPDX-License-Identifier: Apache-2.0
/**
 * Everything a plan is refused for, and the fact that an admissible plan is
 * not refused for any of it.
 *
 * Each refusal below is paired with a NEGATIVE CONTROL that passes the same
 * validator with the offending property removed. Ruling 62(b): a guard nobody
 * has watched fire is a guard, and a guard nobody has watched NOT fire is a
 * refusal that will one day refuse everything.
 */

import { describe, expect, test } from "bun:test";
import {
  DIFFICULTY_ORDER,
  clampDifficulty,
  parsePlan,
  PlanUnreadable,
  requirementRefusal,
  validatePlan,
  type AgentOnLadder,
  type PlanSpec,
} from "../src/queue/plan.ts";

const CAPABLE: AgentOnLadder[] = [
  { id: "codex", resolved: "/x/npx", capabilities: { commandExecution: true, networkAccess: false } },
];

const plan = (items: unknown[]): PlanSpec => ({ version: 1, items });
const validate = (items: unknown[], agents: AgentOnLadder[] = CAPABLE) =>
  validatePlan(plan(items), { cwd: process.cwd(), agents });

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "write",
  paths: [`${id}.txt`],
  prompt: `write ${id}.txt`,
  ...extra,
});

describe("the plan is read without being trusted", () => {
  test("a non-JSON plan names the file and the reason", () => {
    expect(() => parsePlan("{ not json", "p.json")).toThrow(PlanUnreadable);
  });

  test("NEGATIVE CONTROL: a well-formed plan parses", () => {
    expect(parsePlan(JSON.stringify(plan([item("a")])), "p.json").items).toHaveLength(1);
  });

  test("a plan whose items are not an array is refused rather than crashed on", () => {
    expect(() => parsePlan(JSON.stringify({ version: 1, items: "nope" }), "p.json")).toThrow(PlanUnreadable);
  });
});

describe("ruling 13: two items may not claim one path", () => {
  test("the collision is refused and the PATH is named", () => {
    const result = validate([item("one", { paths: ["shared.txt"] }), item("two", { paths: ["shared.txt"] })]);
    const refusal = result.refusals.find((r) => r.ruling === "ruling 13");
    expect(refusal).toBeDefined();
    expect(refusal?.lines.join("\n")).toContain("shared.txt");
    // The remedy rather than the arithmetic.
    expect(refusal?.lines.join("\n")).toContain("dependsOn");
  });

  test("NEGATIVE CONTROL: disjoint paths are not refused", () => {
    expect(validate([item("one"), item("two")]).refusals).toEqual([]);
  });

  test("a write item owning no path at all is refused", () => {
    const result = validate([item("one", { paths: [] })]);
    expect(result.refusals.map((r) => r.ruling)).toContain("ruling 13");
  });

  test("NEGATIVE CONTROL: a READ-ONLY item owning no path is not, because it merges nothing", () => {
    const result = validate([{ id: "r", kind: "read-only", paths: [], prompt: "summarise" }]);
    expect(result.refusals).toEqual([]);
  });
});

describe("ruling 54: the wave order, and the cycle that has none", () => {
  test("dependsOn becomes waves, by item NUMBER", () => {
    const result = validate([item("a"), item("b", { dependsOn: ["a"] }), item("c")]);
    expect(result.refusals).toEqual([]);
    expect(result.waves).toEqual([[1, 3], [2]]);
  });

  test("a cycle is refused at validation, naming every item that can never become eligible", () => {
    const result = validate([item("a", { dependsOn: ["b"] }), item("b", { dependsOn: ["a"] })]);
    const refusal = result.refusals.find((r) => r.ruling === "ruling 54");
    expect(refusal?.lines.join("\n")).toContain("cycle");
    expect(refusal?.lines.join("\n")).toContain("a, b");
    expect(result.waves).toEqual([]);
  });

  test("NEGATIVE CONTROL: the same two items without the back-edge produce waves", () => {
    const result = validate([item("a"), item("b", { dependsOn: ["a"] })]);
    expect(result.refusals).toEqual([]);
    expect(result.waves).toEqual([[1], [2]]);
  });

  test("a dependsOn naming an item the plan does not contain is refused", () => {
    const result = validate([item("a", { dependsOn: ["ghost"] })]);
    expect(result.refusals.find((r) => r.ruling === "ruling 54")?.lines.join("\n")).toContain("ghost");
  });
});

describe("ruling 53: eligibility over the whole ladder, with the remedy", () => {
  test("an unmeasured TERM says nobody has measured it, and names no arithmetic", () => {
    const result = validate([item("a", { requires: ["telepathy"] })]);
    const text = result.refusals.find((r) => r.ruling === "ruling 53")?.lines.join("\n") ?? "";
    expect(text).toContain("telepathy");
    expect(text).toMatch(/nobody has measured/i);
    // v1's `ROUTING_FAILED — 11 model(s) were eliminated` is the shape this
    // must never take.
    expect(text).not.toMatch(/\b\d+\s+(model|agent)s?\b[^.]*\beliminated\b/i);
  });

  test("an agent MEASURED unable is reported differently from one nobody measured", () => {
    // Two different remedies: route elsewhere, versus go and measure it.
    const unable = requirementRefusal("a", "networkAccess", CAPABLE);
    expect(unable.join("\n")).toMatch(/CANNOT/);
    const unmeasured = requirementRefusal("a", "imageInput", CAPABLE);
    expect(unmeasured.join("\n")).toMatch(/UNMEASURED/);
    expect(unmeasured.join("\n")).not.toMatch(/CANNOT/);
  });

  test("NEGATIVE CONTROL: a requirement the ladder satisfies is not refused", () => {
    expect(validate([item("a", { requires: ["commandExecution"] })]).refusals).toEqual([]);
  });

  test("the SAME requirement on a ladder that lacks it IS refused", () => {
    // The control on the control: the pass above must be about the capability
    // rather than about the validator never looking.
    const blind: AgentOnLadder[] = [{ id: "qwen", resolved: "/x/qwen", capabilities: {} }];
    expect(validate([item("a", { requires: ["commandExecution"] })], blind).refusals).toHaveLength(1);
  });
});

describe("ruling 67: the clamp only ever goes down", () => {
  test("hard clamps to medium under the default ceiling, and it is recorded per item", () => {
    const result = validate([item("a", { difficulty: "hard" })]);
    expect(result.items[0]?.difficulty).toBe("hard");
    expect(result.items[0]?.clampedTo).toBe("medium");
  });

  test("NEGATIVE CONTROL: easy is NOT raised to the ceiling", () => {
    const result = validate([item("a", { difficulty: "easy" })]);
    expect(result.items[0]?.clampedTo).toBe("easy");
  });

  test("no pair of (asked, ceiling) produces an upward clamp", () => {
    // Exhaustive over the whole vocabulary rather than the two interesting
    // cases: an upward clamp spends money the operator did not ask for, and the
    // property is small enough to check completely.
    for (const asked of DIFFICULTY_ORDER) {
      for (const ceiling of DIFFICULTY_ORDER) {
        const got = clampDifficulty(asked, ceiling);
        expect(DIFFICULTY_ORDER.indexOf(got)).toBeLessThanOrEqual(DIFFICULTY_ORDER.indexOf(asked));
      }
    }
  });

  test("an unusable difficulty is refused rather than silently dropped", () => {
    expect(validate([item("a", { difficulty: "impossible" })]).refusals).toHaveLength(1);
  });
});

describe("ruling 52 at validation: the checker is looked up before anything is spent", () => {
  test("a misspelled verify command refuses, naming the command", () => {
    const result = validate([item("a", { verify: "bnu tset" })]);
    const text = result.refusals.find((r) => r.ruling === "ruling 52")?.lines.join("\n") ?? "";
    expect(text).toContain("bnu tset");
  });

  test("NEGATIVE CONTROL: a command that resolves does not refuse", () => {
    expect(validate([item("a", { verify: "git --version" })]).refusals).toEqual([]);
  });

  test("NEGATIVE CONTROL: no verify command at all does not refuse", () => {
    expect(validate([item("a")]).refusals).toEqual([]);
  });
});

describe("the plan's own shape", () => {
  test("a duplicate id is refused: ids are how a report names an item", () => {
    expect(validate([item("a"), item("a")]).refusals[0]?.lines.join("\n")).toContain("share the id");
  });

  test("an item with no prompt is refused", () => {
    expect(validate([{ id: "a", kind: "write", paths: ["a.txt"] }]).refusals).toHaveLength(1);
  });

  test("NEGATIVE CONTROL: the minimum viable item is accepted", () => {
    expect(validate([item("a")]).refusals).toEqual([]);
  });
});
