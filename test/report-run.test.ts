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
import { homedir } from "node:os";
import { join } from "node:path";
import { admit, agentsOnPath, describeAdmission } from "../src/queue/admit.ts";
import { parsePlan, validatePlan } from "../src/queue/plan.ts";
import { estimateTokens, HOST_REPORT_TOKEN_CEILING } from "../src/report/budget.ts";
import type { RecordCheck, RecordItem, RunRecord } from "../src/report/record.ts";
import { SecretInventory } from "../src/secrets/redact.ts";
import { Sink } from "../src/secrets/sink.ts";
import {
  itemBlocks,
  refusedDelegationLine,
  renderItem,
  renderRecordCheck,
  runHeadline,
  writeRunReport,
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
    integrationSha: "1".repeat(40),
    base: { ref: "refs/brigadier/r1/base", sha: "0".repeat(40) },
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

/** Everything the sink actually put on stdout, joined. */
function report(items: RecordItem[], audience: "host-session" | "terminal" = "host-session", refused = 0): string {
  const written: string[] = [];
  const sink = new Sink(new SecretInventory(), { out: (chunk) => written.push(chunk), err: () => {} });
  writeRunReport(
    {
      record: record(items, refused),
      recordPath: "/home/x/.brigadier/r/r1/record.json",
      headline: "PARTIAL INTEGRATION — some of it landed",
      mergedResult: GATE,
      audience,
    },
    sink,
  );
  sink.end();
  return written.join("");
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

// ------------------------------ the ceiling is on the CHANNEL, not the report

/**
 * Ruling 58's ceiling applied to everything this process writes to stdout.
 *
 * THE DEFECT, MEASURED. On 2026-08-18 against `bun 1.3.14` a fifty-item host run
 * printed **3,682 tokens against the 2,000-token ceiling** — and `run-report.ts`
 * was inside its budget the whole time. 1,648 of those tokens were the admission
 * block, written first, counted against nothing, because the cap had been
 * written as a property of one artifact rather than of the channel. Every byte
 * on that stdout lands in the same context window and is charged once, so a
 * budget that governs only the last thing written is not a budget.
 *
 * This composes the two exactly as `src/cli.ts` does — admission block, then
 * report, with what the first cost handed to the second — and asserts on the
 * total. The terminal control is what keeps it from passing on a build that
 * simply prints less.
 */
describe("a fifty-item run's WHOLE stdout fits the host ceiling", () => {
  const failing = [4, 18, 43];
  const plannedItems = Array.from({ length: 50 }, (_, index) => ({
    id: `fifty-${index + 1}`,
    kind: "write" as const,
    paths: [`fifty-${index + 1}.txt`],
    prompt: `create fifty-${index + 1}.txt`,
  }));
  const planPath = join(homedir(), ".brigadier-report-channel-test", "plan.json");
  const spec = parsePlan(JSON.stringify({ version: 1, items: plannedItems }), planPath);
  const agents = agentsOnPath((command) => (command === "qwen" ? "/usr/local/bin/qwen" : null), []);
  const admission = admit({ plan: validatePlan(spec, { cwd: process.cwd(), agents }), agents, hostFirst: true });

  const items = plannedItems.map((planned, index) =>
    item(planned.id, failing.includes(index + 1)),
  );

  function stdout(audience: "host-session" | "terminal"): string {
    const head = describeAdmission(admission, planPath, audience);
    const spent = estimateTokens(head.join("\n"));
    const written: string[] = [];
    const sink = new Sink(new SecretInventory(), { out: (chunk) => written.push(chunk), err: () => {} });
    writeRunReport(
      {
        record: record(items),
        recordPath: "/home/x/.brigadier/r/r1/record.json",
        headline: runHeadline({ items, mergedResult: GATE }),
        mergedResult: GATE,
        audience,
        ...(audience === "host-session" ? { budgetSpent: spent } : {}),
      },
      sink,
    );
    sink.end();
    return [...head, ...written].join("\n");
  }

  const host = stdout("host-session");

  test("the whole of stdout is under the ceiling, not just the report", () => {
    expect(estimateTokens(host)).toBeLessThanOrEqual(HOST_REPORT_TOKEN_CEILING);
  });

  test("every failing item is still there, with its blocking check", () => {
    for (const index of failing) {
      expect(host).toContain(`fifty-${index}:`);
      expect(host).toContain(`verify fifty-${index}`);
    }
  });

  test("the truncation is STATED rather than silent", () => {
    expect(host).toMatch(/\d+ passing item\(s\) collapsed/);
    expect(host).toContain("COLLAPSED for a host session");
  });

  test("the headline names the blocking check kind, once, not fifty times", () => {
    const headline = host.split("\n").find((line) => line.includes("PARTIAL INTEGRATION")) ?? "";
    expect(headline).toContain("blocked by verify fifty-N: fail");
    // O(1): one kind for three items, rather than one clause per item in the
    // one part of the report the cap can never trim.
    expect(headline.match(/blocked by/g) ?? []).toHaveLength(1);
  });

  test("NEGATIVE CONTROL: a terminal reader still gets all fifty items and both blocks in full", () => {
    const terminal = stdout("terminal");
    for (let index = 1; index <= 50; index++) expect(terminal).toContain(`fifty-${index}:`);
    // The admission block too: collapsing it is a host-session behaviour, not a
    // renderer that lost the lines.
    expect(terminal).toContain("fifty-50    verify: unconfigured");
    expect(estimateTokens(terminal)).toBeGreaterThan(HOST_REPORT_TOKEN_CEILING);
  });
});
