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
  renderRanked,
  renderRow,
  type CompetenceRow,
} from "../src/router/competence.ts";
import { isLineAnchor } from "../bar/items/05-review-is-cross-vendor.ts";
import {
  KNOWN,
  TABLE,
  renderCompetence,
  rows as tableRows,
  tableProblems,
  toRow,
  unlistedModels,
  type TableEntry,
} from "../src/router/table.ts";

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

/**
 * The shipped table, and the guards that keep it auditable by someone who does
 * not trust its author.
 *
 * `isLineAnchor` is imported from the bar item rather than restated, on purpose:
 * the product's own `citationProblems` rejects `<path>.<ext>:<number>`, while
 * the auditor's predicate rejects any `:<number>` at all. Asserting the shipped
 * rows against the STRICTER of the two is the only version of this test that
 * cannot pass by agreeing with itself.
 */
describe("the table that ships inside the binary (ruling 68)", () => {
  const rendered = renderCompetence();
  const printedRows = rendered.filter((l) => l.trim().length > 0 && !/^\s*#/.test(l));

  test("every shipped citation holds — and the guard is wired, not merely present", () => {
    expect(tableProblems()).toEqual([]);
    expect(TABLE.length).toBeGreaterThan(0);
  });

  test("NEGATIVE CONTROL: a line anchor in a shipped row is caught", () => {
    // v1's METHODOLOGY.md carried 44 of these and one comment-only sweep
    // invalidated 8, so this is the defect that must not get back in.
    const rotted: TableEntry[] = [
      { ...TABLE[0]!, citation: "src/router/table.ts:120" },
    ];
    const problems = tableProblems(rotted);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("line anchor");
  });

  test("NEGATIVE CONTROL: a sourced row with no ticket, version or date is caught", () => {
    const vague: TableEntry[] = [
      { ...TABLE[0]!, inputs: ["benchmark"], citation: "some benchmark everyone knows" },
    ];
    expect(tableProblems(vague).length).toBeGreaterThan(0);
  });

  test("NEGATIVE CONTROL: an empty citation is caught", () => {
    expect(tableProblems([{ ...TABLE[0]!, citation: "  " }]).length).toBeGreaterThan(0);
  });

  test("no printed row carries a line anchor, by the auditor's stricter predicate", () => {
    expect(printedRows.filter(isLineAnchor)).toEqual([]);
    expect(printedRows.length).toBe(TABLE.length);
  });

  test("every printed row carries its class beside its score, never in a footnote", () => {
    // `claude: 90` tells a reader nothing about whether it was measured or
    // invented, which is the whole of ruling 68's rendering rule.
    for (const row of printedRows) expect(row).toMatch(/\((measured|benchmark|vendor|editorial):/);
  });

  test("a row whose reason rests on a measurement still prints editorial", () => {
    // The mixing rule, demonstrated on the shipped table rather than only on a
    // fixture: several rows are judgement resting on #3, #41, #42, #46 or #47,
    // and every one of them declares both inputs.
    const mixed = TABLE.filter((e) => e.inputs.length > 1);
    expect(mixed.length).toBeGreaterThan(0);
    for (const entry of mixed) {
      expect(entry.inputs).toContain("measured");
      expect(toRow(entry).evidence).toBe("editorial");
    }
  });

  test("not one row claims to be measured — and that is the finding", () => {
    // Decision 10 keeps this hand-maintained. A table that looked mostly
    // measured would be the warning sign, so this asserts the honest state
    // rather than an aspiration.
    expect(tableRows().every((r) => r.evidence === "editorial")).toBe(true);
  });
});

describe("an unranked model is used, sorted last, and named", () => {
  test("the shipped table really has unranked rows, and they are named in the output", () => {
    const unranked = TABLE.filter((e) => e.score === undefined);
    expect(unranked.length).toBeGreaterThan(0);
    const printed = renderCompetence().join("\n");
    for (const entry of unranked) {
      expect(printed).toContain(`${entry.agent}/${entry.model} ${entry.role}: unranked`);
    }
  });

  test("they sort last within their role rather than being dropped", () => {
    for (const role of ["builder", "reviewer"] as const) {
      const forRole = tableRows().filter((r) => r.role === role);
      const ranked = rank(forRole, KNOWN);
      expect(ranked).toHaveLength(forRole.length);
      const firstUnranked = ranked.findIndex((r) => !KNOWN.has(`${r.agent}/${r.model}`));
      const lastRanked = ranked.map((r) => KNOWN.has(`${r.agent}/${r.model}`)).lastIndexOf(true);
      expect(firstUnranked).toBeGreaterThan(lastRanked);
    }
  });

  test("NEGATIVE CONTROL: dropping them instead would lose rows, and the count catches it", () => {
    const kept = tableRows().filter((r) => KNOWN.has(`${r.agent}/${r.model}`));
    expect(kept.length).toBeLessThan(TABLE.length);
  });

  test("an unranked row prints the word rather than a zero", () => {
    // A zero sorts and reads like a bad model. An unknown is not a bad one, and
    // conflating them is the shape of v1's finding 87.
    const { score: _scored, ...unscored } = TABLE[0]!;
    const row = toRow({ ...unscored, agent: "codex", model: "brand-new" });
    expect(renderRanked(row, KNOWN)).toContain("unranked");
    expect(renderRanked(row, KNOWN)).not.toContain(": 0 ");
  });
});

describe("maintenance is a mechanical trigger, not a calendar", () => {
  test("a model id detection saw that the table does not list is reported", () => {
    expect(unlistedModels("codex", ["gpt-5.6-sol[high]", "gpt-5.6-sol[low]"])).toEqual([
      "gpt-5.6-sol[high]",
      "gpt-5.6-sol[low]",
    ]);
  });

  test("NEGATIVE CONTROL: an id the table does list is not reported", () => {
    expect(unlistedModels("claude", ["default"])).toEqual([]);
  });

  test("the trigger is per agent, not per id — the same name under another vendor still counts", () => {
    expect(unlistedModels("codex", ["default"])).toEqual([]);
    expect(unlistedModels("nobody", ["default"])).toEqual(["default"]);
  });
});
