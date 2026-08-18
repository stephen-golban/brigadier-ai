// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 58's cap, tested against the property that makes it safe rather than
 * against a line count:
 *
 *     THE CAP CAN HIDE A SUCCESS AND CAN NEVER HIDE A FAILURE.
 *
 * The hard case is the one a budget makes tempting: a run where the BLOCKING
 * items alone exceed the budget. There is no arithmetic that fits them, so the
 * report goes over and says so — and the test asserts on the failures still
 * being present, not on the report being small.
 */

import { describe, expect, test } from "bun:test";
import { estimateTokens, HOST_REPORT_TOKEN_CEILING } from "../src/report/budget.ts";
import type { RecordCheck, RecordItem, RunRecord } from "../src/report/record.ts";
import {
  itemBlocks,
  refusedDelegationLine,
  renderItem,
  renderRecordCheck,
  renderRunReport,
} from "../src/report/run-report.ts";

function item(id: string, blocking: boolean): RecordItem {
  return {
    id,
    number: Number(id.replace(/\D/g, "")) || 1,
    status: blocking ? "failed" : "integrated",
    kind: "write",
    agent: "codex",
    model: "gpt-5.6-sol",
    // Realistic rather than minimal: a real item carries three checks and each
    // one carries the checker's own words, and a fixture of one-word checks
    // would make the cap look roomier than it is.
    checks: blocking
      ? [
          { name: "worker", outcome: "pass", blocking: false, detail: "codex took one turn and stopped with end_turn" },
          {
            name: `verify ${id}`,
            outcome: "fail",
            blocking: true,
            detail: `\`bun test\` exited 1 on the merged commit for ${id}; 2 failing`,
          },
          { name: `integrate item ${id}`, outcome: "pass", blocking: false, detail: "1 path merged cleanly" },
        ]
      : [
          { name: "worker", outcome: "pass", blocking: false, detail: "codex took one turn and stopped with end_turn" },
          { name: "review", outcome: "pass", blocking: true, qualifier: "cross-vendor", detail: "qwen reviewed codex's diff" },
          { name: `integrate item ${id}`, outcome: "pass", blocking: false, detail: "1 path merged cleanly" },
        ],
  };
}

function record(items: RecordItem[], refusedDelegations = 0): RunRecord {
  return {
    runId: "r1",
    integrationRef: "refs/heads/brigadier/r1",
    runRoot: "/home/x/.brigadier",
    bindingFilter: "desirability",
    workers: 3,
    refusedDelegations,
    items,
  };
}

const GATE: RecordCheck[] = [
  { name: "verify (merged result)", outcome: "unconfigured", blocking: false, qualifier: "wave 1" },
];

function report(items: RecordItem[], audience: "host-session" | "terminal" = "host-session", refused = 0): string {
  return renderRunReport({
    record: record(items, refused),
    recordPath: "/home/x/.brigadier/r/r1/record.json",
    headline: "PARTIAL INTEGRATION — some of it landed",
    mergedResult: GATE,
    audience,
  });
}

describe("a fifty-item run fits a host window", () => {
  const items = [
    ...Array.from({ length: 47 }, (_, index) => item(`ok${index + 1}`, false)),
    item("bad4", true),
    item("bad18", true),
    item("bad43", true),
  ];
  const text = report(items);

  test("it is under the ceiling", () => {
    expect(estimateTokens(text)).toBeLessThanOrEqual(HOST_REPORT_TOKEN_CEILING);
  });

  test("every failing item is still there, with every one of its checks", () => {
    for (const id of ["bad4", "bad18", "bad43"]) {
      expect(text).toContain(id);
      expect(text).toContain(`verify ${id}`);
    }
  });

  test("passing items collapsed to a COUNT rather than being dropped silently", () => {
    expect(text).toMatch(/\d+ passing item\(s\) collapsed/);
  });

  test("NEGATIVE CONTROL: an uncapped audience prints every item", () => {
    // Without this, "the cap collapsed 47 items" would also be satisfied by a
    // renderer that never printed them under any audience.
    const uncapped = report(items, "terminal");
    for (let index = 1; index <= 47; index++) expect(uncapped).toContain(`ok${index}:`);
    expect(estimateTokens(uncapped)).toBeGreaterThan(HOST_REPORT_TOKEN_CEILING);
  });
});

describe("the cap can hide a success and can never hide a failure", () => {
  test("when the BLOCKING items alone exceed the budget, the report goes over and says so", () => {
    const items = Array.from({ length: 120 }, (_, index) => item(`bad${index + 1}`, true));
    const text = report(items);
    expect(estimateTokens(text)).toBeGreaterThan(HOST_REPORT_TOKEN_CEILING);
    expect(text).toContain("OVER the");
    // The point: not one of them was dropped to fit.
    for (const entry of items) expect(text).toContain(`${entry.id}:`);
  });

  test("NEGATIVE CONTROL: the same 120 items PASSING do fit, by collapsing", () => {
    const items = Array.from({ length: 120 }, (_, index) => item(`ok${index + 1}`, false));
    const text = report(items);
    expect(estimateTokens(text)).toBeLessThanOrEqual(HOST_REPORT_TOKEN_CEILING);
    expect(text).not.toContain("OVER the");
  });
});

describe("ruling 52's rendering rules", () => {
  test("a qualifier lives INSIDE the result string", () => {
    expect(renderRecordCheck({ name: "review", outcome: "pass", blocking: false, qualifier: "same-vendor" })).toBe(
      "✓ review: pass (same-vendor)",
    );
  });

  test("NEGATIVE CONTROL: the banned compact form is not produced anywhere", () => {
    const text = report([item("a1", true)]);
    expect(text).not.toMatch(/approved by \w+/i);
  });

  test("`pass` is the only affirmative glyph", () => {
    for (const outcome of ["fail", "error", "not-run", "unconfigured"] as const) {
      expect(renderRecordCheck({ name: "x", outcome, blocking: true })).not.toContain("✓");
    }
    expect(renderRecordCheck({ name: "x", outcome: "pass", blocking: false })).toContain("✓");
  });

  test("an item's checks are never abbreviated", () => {
    const rendered = renderItem(item("a1", true));
    expect(rendered).toContain("worker: pass");
    expect(rendered).toContain("verify a1: fail");
  });

  test("`unconfigured` does not block but prints in the same slot", () => {
    expect(itemBlocks({ ...item("a1", false), checks: [{ name: "v", outcome: "unconfigured", blocking: false }] })).toBe(
      false,
    );
    expect(report([item("a1", false)])).toContain("verify (merged result): unconfigured (wave 1)");
  });
});

describe("ruling 59: a run-level line, O(1), that survives the cap", () => {
  test("it prints once for the whole run", () => {
    expect(refusedDelegationLine(3)).toContain("3 workers attempted to delegate and were refused");
  });

  test("NEGATIVE CONTROL: nobody delegated means no line at all", () => {
    expect(refusedDelegationLine(0)).toBeNull();
  });

  test("it survives a run whose items were all collapsed", () => {
    const items = Array.from({ length: 120 }, (_, index) => item(`ok${index + 1}`, false));
    const text = report(items, "host-session", 3);
    expect(text).toMatch(/3 workers attempted to delegate/);
    expect(text).toMatch(/collapsed/);
  });
});

describe("ruling 58: the pointer travels, the transcript does not", () => {
  test("the report names the record path", () => {
    expect(report([item("a1", false)])).toContain("run-record: /home/x/.brigadier/r/r1/record.json");
  });

  test("NEGATIVE CONTROL: no protocol frame shape appears in a host report", () => {
    const text = report([item("a1", true)]);
    expect(text).not.toMatch(/"jsonrpc"|session\/update|agent_message_chunk|tool_call_update/);
  });
});
