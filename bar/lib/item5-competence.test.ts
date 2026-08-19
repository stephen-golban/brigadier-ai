// SPDX-License-Identifier: Apache-2.0
/**
 * Negative controls for item 5's ruling-68 half (ruling 62b).
 *
 * A blind critic found both of these checks vacuous on 2026-08-19, and the shape
 * of each fault is the one this project keeps reproducing — a check reporting
 * success for something it never examined:
 *
 *   **"no citation is a line anchor"** tested the WHOLE ROW for an anchor
 *   pattern. A table that stopped citing altogether has no anchors in it, so the
 *   check passed on a table with no citations at all. It now locates the
 *   citation first and fails when one is missing.
 *
 *   **"a model the table has never heard of is named"** was `/unranked/i`
 *   against all of stdout, and the table's own header prose explains what
 *   `unranked` means — so the check was satisfied by the documentation of the
 *   property rather than by the property. It now requires a row whose SCORE is
 *   unranked, which NAMES its agent, and which sorts last in its section.
 *
 * Every block below therefore removes exactly one property from a table that
 * otherwise passes, and asserts the corresponding check goes red. The positive
 * case is the real binary's own output, pinned as a shape rather than a string.
 */

import { describe, expect, test } from "bun:test";
import { agentOf, citationOf, judgeCompetence } from "../items/05-review-is-cross-vendor.ts";
import type { Checks } from "./checks.ts";

const failed = (c: Checks): string[] => c.failures.map((f) => f.name);
const judge = (stdout: string): string[] => failed(judgeCompetence({ code: 0, stdout, stderr: "" }));

const CITED = "no citation is a line anchor (ruling 68)";
const NAMED = "a model the table has never heard of is named rather than silently excluded";
const LAST = "an unranked model sorts LAST in its section (ruling 68)";
const CLASSED = "every row carries an evidence class and a citation";

/**
 * A table in the shape `brigadier competence` really prints, MEASURED against
 * `dist/brigadier` on 2026-08-19: `<agent>/<model> <role>: <score> (<class>: <citation>)`.
 */
const TABLE = [
  "claude/default builder: 80 (editorial: judgement, resting on #3's measurement that its bridge opens in bypassPermissions)",
  "qwen/default builder: 50 (editorial: judgement, resting on #47's measurement that compaction becomes a treadmill)",
  "opencode/default builder: unranked (editorial: unranked on purpose — #42 measured it reaching a model with no credential)",
  "claude/default reviewer: 80 (editorial: judgement alone — ruling 52 hands a reviewer an exact diff)",
  "gemini/default reviewer: unranked (editorial: unranked — never driven here (#42), so there is nothing to rank)",
].join("\n");

describe("item 5 — ruling 68 is cite-by-identity, so the identity is asserted", () => {
  test("the real table's shape passes every check", () => {
    expect(judge(TABLE)).toEqual([]);
  });

  test("NEGATIVE CONTROL: citations vanish entirely — the anchor check must NOT pass", () => {
    const stripped = TABLE.split("\n")
      .map((r) => r.replace(/\(editorial:.*\)$/, "(editorial)"))
      .join("\n");
    // The old check passed here: a table with no citations has no anchors in it.
    expect(judge(stripped)).toContain(CITED);
    expect(judge(stripped)).toContain(CLASSED);
  });

  test("NEGATIVE CONTROL: one citation becomes a line anchor", () => {
    expect(judge(`${TABLE}\ncodex/default builder: 80 (measured: src/router/table.ts:112)`)).toContain(CITED);
  });

  test("a bare ticket is a complete citation, and is not an anchor", () => {
    expect(citationOf("codex/default builder: 80 (measured: #41)")).toBe("#41)");
    expect(judge("codex/default builder: 80 (measured: #41)\nx/default builder: unranked (editorial: never driven, #42)")).toEqual([]);
  });

  test("NEGATIVE CONTROL: the word `unranked` in prose alone does not satisfy the named check", () => {
    // Exactly the old defect: the table's header explains the property, and the
    // rows below have quietly dropped every unranked model.
    const prose = "# a model this table has never heard of is unranked, stays eligible and sorts last\n" +
      "claude/default builder: 80 (editorial: judgement, resting on #3)";
    expect(judge(prose)).toContain(NAMED);
  });

  test("NEGATIVE CONTROL: an unranked row that names nothing", () => {
    expect(judge("claude/default builder: 80 (editorial: judgement, #3)\nunranked (editorial: nothing named here at all)")).toContain(NAMED);
  });

  test("NEGATIVE CONTROL: an unranked row that does not sort last in its section", () => {
    const misordered = [
      "opencode/default builder: unranked (editorial: unranked on purpose — #42)",
      "claude/default builder: 80 (editorial: judgement, resting on #3)",
    ].join("\n");
    expect(judge(misordered)).toContain(LAST);
  });

  test("sorting is asked PER SECTION — a builder row after a reviewer's unranked row is not misplaced", () => {
    const bySection = [
      "claude/default builder: 80 (editorial: judgement, resting on #3)",
      "opencode/default builder: unranked (editorial: unranked on purpose — #42)",
      "claude/default reviewer: 80 (editorial: judgement alone, ruling 52)",
      "gemini/default reviewer: unranked (editorial: never driven here, #42)",
    ].join("\n");
    expect(judge(bySection)).toEqual([]);
  });

  test("the row's agent identity is what `agentOf` reads", () => {
    expect(agentOf("opencode/default builder: unranked (editorial: #42)")).toBe("opencode/default");
    expect(agentOf("  nobody-ranked  unranked  editorial  a reason")).toBe("nobody-ranked");
  });
});
