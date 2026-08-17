// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 68. The test that matters is the line-anchor one: v1's METHODOLOGY.md
 * existed to be checkable by someone who did not trust its author, and a single
 * comment-only sweep invalidated 8 of its 44 anchors while 4 were already wrong.
 */

import { describe, expect, test } from "bun:test";
import {
  UNRANKED,
  citationProblems,
  governingClass,
  rank,
  renderRow,
  type CompetenceRow,
} from "../src/router/competence.ts";

const row = (over: Partial<CompetenceRow> = {}): CompetenceRow => ({
  agent: "codex",
  model: "gpt-5.6-sol",
  role: "builder",
  score: 90,
  evidence: "measured",
  citation: "#45",
  ...over,
});

describe("citations cite identity, never location", () => {
  test("a line anchor is rejected — v1's defect, as a predicate", () => {
    const problems = citationProblems(row({ citation: "src/router/competence.ts:120" }));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("line anchor");
  });

  test("stable identifiers pass", () => {
    for (const citation of [
      "#45",
      "FrontierCode v2, read 2026-08-17",
      "https://example.invalid/docs, read 2026-08-17",
    ]) {
      expect(citationProblems(row({ citation }))).toEqual([]);
    }
  });

  test("an empty citation is a problem", () => {
    expect(citationProblems(row({ citation: "   " })).length).toBeGreaterThan(0);
  });

  test("a sourced class must carry a ticket, version or date; editorial need not", () => {
    expect(citationProblems(row({ evidence: "benchmark", citation: "some benchmark" })).length)
      .toBeGreaterThan(0);
    // Editorial cites a REASON rather than a source, so it is exempt.
    expect(citationProblems(row({ evidence: "editorial", citation: "weakest on long refactors" })))
      .toEqual([]);
  });
});

describe("a mixed row takes its weakest class", () => {
  test("measured plus editorial is editorial", () => {
    expect(governingClass(["measured", "editorial"])).toBe("editorial");
    expect(governingClass(["measured", "benchmark"])).toBe("benchmark");
    expect(governingClass(["measured"])).toBe("measured");
  });
});

describe("the class renders with the score, not in a footnote", () => {
  test("a reader can tell measured from invented", () => {
    expect(renderRow(row())).toContain("(measured: #45)");
    expect(renderRow(row({ evidence: "editorial", citation: "judgement" }))).toContain("(editorial:");
  });
});

describe("an unranked model is NOT excluded", () => {
  const known = new Set(["codex/gpt-5.6-sol"]);
  const rows = [
    row({ agent: "codex", model: "brand-new-model", score: 0 }),
    row({ agent: "codex", model: "gpt-5.6-sol", score: 90 }),
  ];

  test("it sorts last but is still there", () => {
    const ranked = rank(rows, known);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.model).toBe("gpt-5.6-sol");
    expect(ranked[1]!.model).toBe("brand-new-model");
  });

  test("the asymmetry with ruling 53 is deliberate and is asserted", () => {
    // A capability is a permission and fails CLOSED (ruling 53: unmeasured does
    // not satisfy). A ranking is a preference and fails OPEN. A refactor that
    // unified them would break one — refusing an unranked model silently
    // freezes the fleet, which is v1's finding 87 shape.
    expect(UNRANKED).toBe(Number.NEGATIVE_INFINITY);
    expect(rank(rows, new Set()).length).toBe(2);
  });
});
