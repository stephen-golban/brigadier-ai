// SPDX-License-Identifier: Apache-2.0
/**
 * The second rung's selector and its brief.
 *
 * **THE DISPATCH IS NOT WIRED YET** — see `src/work/rung2.ts` and the handoff.
 * These tests hold the two pieces that are built, and they are deliberately
 * written so they cannot pass against a product that never takes the rung: they
 * assert on the CHOICE and the BRIEF, both of which are pure and both of which
 * the dispatch will consume unchanged.
 */

import { describe, expect, test } from "bun:test";
import { chooseRung2, retryContext, type FirstAttempt } from "../src/work/rung2.ts";

const FAILED: FirstAttempt = {
  agent: "claude",
  failed: true,
  why: "verify failed: 2 tests red in auth.test.ts",
  reviewerFound: [],
};

describe("who takes the second attempt", () => {
  test("a DIFFERENT vendor is preferred, which is ruling 24's original", () => {
    const choice = chooseRung2(FAILED, ["claude", "codex"], []);
    expect(choice.agent).toBe("codex");
    expect(choice.distance).toBe("different-vendor");
  });

  test("a one-vendor machine still gets the rung, and the line says what it is worth", () => {
    // Ruling 32 makes this supported rather than degraded, and ruling 55 splits
    // the value: a fresh context survives here, a different failure mode does
    // not. A rung refused here would throw away the half that still holds.
    const choice = chooseRung2(FAILED, ["claude"], []);
    expect(choice.agent).toBe("claude");
    expect(choice.distance).not.toBe("different-vendor");
    expect(choice.why).toContain("fresh context");
    expect(choice.why).toContain("does not buy is a different");
  });

  test("a COLD vendor is not chosen while a warm one exists (D18)", () => {
    // The first attempt may be exactly what marked it cold. Spending the last
    // rung there is spending it to relearn a fact brigadier already has.
    const choice = chooseRung2(FAILED, ["claude", "codex", "copilot"], ["codex"]);
    expect(choice.agent).toBe("copilot");
  });

  test("but an all-cold fleet still gets a rung rather than nothing", () => {
    const choice = chooseRung2(FAILED, ["claude", "codex"], ["claude", "codex"]);
    expect(choice.agent).toBe("codex");
  });

  test("no candidates is no second attempt, said plainly", () => {
    const choice = chooseRung2(FAILED, [], []);
    expect(choice.agent).toBeNull();
    expect(choice.distance).toBeNull();
  });

  test("every choice carries its reason on ONE line (D24)", () => {
    for (const candidates of [["claude", "codex"], ["claude"], []]) {
      expect(chooseRung2(FAILED, candidates, []).why.split("\n")).toHaveLength(1);
    }
  });
});

describe("what the second attempt is told that the first was not", () => {
  test("the checker's own words reach the retry", () => {
    // The channel the second verifier said was missing: a blocking verdict whose
    // reason is dropped leaves the second rung no better informed than the first.
    const context = retryContext(FAILED);
    expect(context).toContain("verify failed: 2 tests red in auth.test.ts");
    expect(context).toContain("A PREVIOUS ATTEMPT AT THIS ITEM FAILED");
  });

  test("a reviewer's findings travel VERBATIM, because they cannot be rewritten", () => {
    const context = retryContext({
      ...FAILED,
      reviewerFound: ["src/retry.ts missing between-attempts abort check"],
    });
    // D24: brigadier can quote it or drop it. It has no model with which to
    // rewrite it, and this asserts it did not try.
    expect(context).toContain("src/retry.ts missing between-attempts abort check");
    expect(context).toContain("verbatim");
  });

  test("it says the attempt is FRESH, not continued", () => {
    // A worker told it is "continuing" will look for work that is not in its
    // clone, because ruling 63 keeps the first attempt's directory and never
    // hands it over.
    expect(retryContext(FAILED)).toContain("You are not continuing it");
  });

  test("it frames the account as EVIDENCE, not as instructions", () => {
    // One model's account of one attempt, which may be wrong. A retry that
    // treated it as the brief would have swapped the item for somebody's
    // opinion of the item.
    const context = retryContext(FAILED);
    expect(context).toContain("EVIDENCE, not instructions");
    expect(context).toContain("Your brief is unchanged");
  });

  test("NOTHING to add produces NOTHING, rather than an empty section", () => {
    // A section saying the last attempt reported nothing is a claim; silence is
    // not. This is ruling 52's shape at the brief instead of at the report.
    expect(retryContext({ agent: "claude", failed: true, why: "", reviewerFound: [] })).toBe("");
  });
});
