// SPDX-License-Identifier: Apache-2.0
/** Ruling 55. The assertions that matter are the ones about what a report cannot say. */

import { describe, expect, test } from "bun:test";
import {
  RUNG_PREFERENCE,
  RUNG_QUALIFIER,
  chooseRung,
  ladderTaken,
  renderLadder,
  renderLadderOffered,
  rungsOffered,
} from "../src/work/ladder.ts";

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
      renderLadder({ kind: "completed", attempts: 2, of: 2, distance: "different-vendor" }),
      renderLadder({ kind: "completed", attempts: 2, of: 2, distance: "same-vendor-different-model" }),
      renderLadder({ kind: "short", attempts: 1, reason: "only one vendor is drivable" }),
      renderLadder({ kind: "budget-capped", attempts: 1 }),
    ];
    expect(new Set(rendered).size).toBe(4);
    // The exact strings, because ruling 55 is about what a SKIMMER reads and a
    // set-size assertion is satisfied by four equally unreadable strings.
    expect(rendered[0]).toBe("attempts 2 of 2");
    expect(rendered[1]).toBe("attempts 2 of 2 (same-vendor, model changed)");
    expect(rendered[2]).toBe("attempts 1 of 1 — no second rung: only one vendor is drivable");
    expect(rendered[3]).toBe("attempt 2 not taken — budget ceiling");
  });

  test("a short ladder says why, and does not look like two attempts", () => {
    const short = renderLadder({ kind: "short", attempts: 1, reason: "only one vendor is drivable" });
    expect(short).toContain("no second rung");
    expect(short).toContain("only one vendor is drivable");
    expect(short).not.toBe(renderLadder({ kind: "completed", attempts: 1, of: 1, distance: "different-vendor" }));
  });

  test("NEGATIVE CONTROL: a short ladder and an exhausted one are not the same string", () => {
    // The pair v1 collapsed into "failed after retries". Both are "N of N" to a
    // skimmer unless the short one carries its reason, so this is the assertion
    // that would fail if the qualifier were ever moved into a footnote.
    const exhausted = renderLadder({ kind: "completed", attempts: 2, of: 2, distance: "different-vendor" });
    const short = renderLadder({ kind: "short", attempts: 1, reason: "only one vendor is drivable" });
    expect(short).not.toBe(exhausted);
    expect(exhausted).not.toContain("no second rung");
    // And a machine WITH a second rung it did not need is neither of them.
    expect(renderLadder({ kind: "completed", attempts: 1, of: 2, distance: "different-vendor" })).toBe(
      "attempts 1 of 2",
    );
  });

  test("a same-vendor retry cannot render as a cross-vendor one", () => {
    // The qualifier is inside the string, per ruling 52 — not a footnote.
    for (const distance of RUNG_PREFERENCE.slice(1)) {
      const line = renderLadder({ kind: "completed", attempts: 2, of: 2, distance });
      expect(line).toContain("same-vendor");
      expect(line).toContain(RUNG_QUALIFIER[distance]);
      expect(line).not.toBe(renderLadder({ kind: "completed", attempts: 2, of: 2, distance: "different-vendor" }));
    }
  });

  test("`rungsOffered` reads the machine's rung count off each outcome", () => {
    expect(rungsOffered({ kind: "completed", attempts: 0, of: 2, distance: "different-vendor" })).toBe(2);
    expect(rungsOffered({ kind: "short", attempts: 1, reason: "one vendor" })).toBe(1);
    expect(rungsOffered({ kind: "budget-capped", attempts: 1 })).toBe(2);
  });

  test("`ladderTaken` records what was SPENT without changing what was OFFERED", () => {
    const offered = { kind: "completed", attempts: 0, of: 2, distance: "different-vendor" } as const;
    expect(renderLadder(ladderTaken(offered, 1))).toBe("attempts 1 of 2");
    // Ruling 52's budget rule stated as an assertion: a reviewer's re-run is not
    // an argument this function takes, so nothing a reviewer does can reach it.
    expect(ladderTaken.length).toBe(2);
  });

  test("the ladder OFFERED and the ladder SPENT are different sentences", () => {
    // Ruling 53's order: the first is printed before anything is spent, the
    // second beside the item afterwards. A single renderer would make the
    // admission line claim attempts that had not happened.
    const short = { kind: "short", attempts: 1, reason: "only one vendor is drivable" } as const;
    expect(renderLadderOffered(short)).toContain("no second rung");
    expect(renderLadderOffered({ kind: "completed", attempts: 0, of: 2, distance: "different-vendor" })).toContain(
      "2 rungs",
    );
    expect(
      renderLadderOffered({ kind: "completed", attempts: 0, of: 2, distance: "different-vendor" }),
    ).not.toMatch(/attempts\s+\d+\s+of\s+\d+/);
  });

  test("budget-capped is not `failed after two attempts`", () => {
    expect(renderLadder({ kind: "budget-capped", attempts: 1 })).toContain("not taken");
    expect(renderLadder({ kind: "budget-capped", attempts: 1 })).toContain("budget ceiling");
  });
});
