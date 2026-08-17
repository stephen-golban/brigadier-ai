// SPDX-License-Identifier: Apache-2.0
/** Ruling 55. The assertions that matter are the ones about what a report cannot say. */

import { describe, expect, test } from "bun:test";
import { RUNG_PREFERENCE, chooseRung, renderLadder } from "../src/work/ladder.ts";

describe("the rung ordering", () => {
  test("vendor beats model beats effort beats a re-roll", () => {
    expect(RUNG_PREFERENCE).toEqual([
      "different-vendor",
      "same-vendor-different-model",
      "same-vendor-different-effort",
      "same-triple",
    ]);
  });

  test("a two-vendor machine takes rung 1", () => {
    expect(chooseRung(["same-triple", "different-vendor", "same-vendor-different-model"])).toBe(
      "different-vendor",
    );
  });

  test("a single-vendor machine falls to the best it has, not to nothing", () => {
    expect(chooseRung(["same-triple", "same-vendor-different-model"])).toBe(
      "same-vendor-different-model",
    );
    expect(chooseRung(["same-triple"])).toBe("same-triple");
  });

  test("and a machine with nothing reports short rather than inventing a rung", () => {
    expect(chooseRung([])).toBeNull();
  });
});

describe("a missing rung must never render as an exhausted one", () => {
  test("the four outcomes produce four different strings", () => {
    const rendered = [
      renderLadder({ kind: "completed", attempts: 2, distance: "different-vendor" }),
      renderLadder({ kind: "completed", attempts: 2, distance: "same-vendor-different-model" }),
      renderLadder({ kind: "short", attempts: 1, reason: "only one vendor is drivable" }),
      renderLadder({ kind: "budget-capped", attempts: 1 }),
    ];
    expect(new Set(rendered).size).toBe(4);
  });

  test("a short ladder says why, and does not look like two attempts", () => {
    const short = renderLadder({ kind: "short", attempts: 1, reason: "only one vendor is drivable" });
    expect(short).toContain("no second rung");
    expect(short).toContain("only one vendor is drivable");
    expect(short).not.toBe(renderLadder({ kind: "completed", attempts: 1, distance: "different-vendor" }));
  });

  test("a same-vendor retry cannot render as a cross-vendor one", () => {
    // The qualifier is inside the string, per ruling 52 — not a footnote.
    for (const distance of RUNG_PREFERENCE.slice(1)) {
      const line = renderLadder({ kind: "completed", attempts: 2, distance });
      expect(line).toContain(distance);
      expect(line).not.toBe(renderLadder({ kind: "completed", attempts: 2, distance: "different-vendor" }));
    }
  });

  test("budget-capped is not `failed after two attempts`", () => {
    expect(renderLadder({ kind: "budget-capped", attempts: 1 })).toContain("not taken");
    expect(renderLadder({ kind: "budget-capped", attempts: 1 })).toContain("budget ceiling");
  });
});
