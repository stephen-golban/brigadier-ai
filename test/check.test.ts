// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 52, with the three v1 failures written as tests.
 *
 * Each of them reported success. If any of these ever passes again, the
 * corresponding assertion below is what should have caught it.
 */

import { describe, expect, test } from "bun:test";
import {
  INITIAL_OUTCOME,
  blocks,
  renderCheck,
  renderChecks,
  succeeded,
  type CheckResult,
} from "../src/work/check.ts";

describe("only `pass` is a pass", () => {
  test("three of the four outcomes block", () => {
    expect(blocks("pass")).toBe(false);
    expect(blocks("fail")).toBe(true);
    expect(blocks("error")).toBe(true);
    expect(blocks("not-run")).toBe(true);
  });

  test("`unconfigured` is the one non-blocking non-pass, deliberately", () => {
    expect(blocks("unconfigured")).toBe(false);
  });
});

describe("v1's three failures, as tests", () => {
  test("the reviewer hit a turn limit — REVIEWER_FAILED must not merge", () => {
    const checks: CheckResult[] = [
      { name: "verify", outcome: "pass" },
      { name: "review", outcome: "error", detail: "reviewer hit its turn limit" },
    ];
    expect(succeeded(checks)).toBe(false);
    // And it must not be `fail`, which would dispatch the builder to fix nothing.
    expect(checks[1]!.outcome).not.toBe("fail");
  });

  test("a misspelled test command — a gate that could not start is not a gate that passed", () => {
    const checks: CheckResult[] = [
      { name: "verify", outcome: "not-run", detail: "bunn: command not found" },
      { name: "review", outcome: "pass" },
    ];
    expect(succeeded(checks)).toBe(false);
  });

  test("a killed gate — the write-ahead default is blocking, so absence cannot occur", () => {
    // The slot is written before the check runs. A crash between started and
    // finished leaves exactly this value.
    expect(INITIAL_OUTCOME).toBe("not-run");
    expect(blocks(INITIAL_OUTCOME)).toBe(true);
  });
});

describe("rendering cannot make a skip read as a pass", () => {
  test("no non-result glyph resembles a tick", () => {
    const tick = renderCheck({ name: "verify", outcome: "pass" }).split(" ")[0]!;
    for (const outcome of ["fail", "error", "not-run", "unconfigured"] as const) {
      expect(renderCheck({ name: "verify", outcome }).split(" ")[0]).not.toBe(tick);
    }
  });

  test("the qualifier is inside the result string, not a footnote", () => {
    expect(renderCheck({ name: "review", outcome: "pass", qualifier: "same-vendor" })).toContain(
      "review: pass (same-vendor)",
    );
  });

  test("every check appears, including the ones that did not run", () => {
    const checks: CheckResult[] = [
      { name: "verify", outcome: "not-run" },
      { name: "review", outcome: "pass" },
      { name: "ownership", outcome: "pass" },
    ];
    const rendered = renderChecks(checks);
    // v1's compact output reduced exactly this to "(approved by codex)".
    for (const c of checks) expect(rendered).toContain(c.name);
    expect(rendered.split("\n")).toHaveLength(3);
  });

  test("`unconfigured` prints in the same slot with the same prominence", () => {
    const rendered = renderCheck({
      name: "verify",
      outcome: "unconfigured",
      detail: "nothing was verified",
    });
    expect(rendered).toContain("verify: unconfigured");
    // It does not block, and it is still printed. Both halves matter.
    expect(succeeded([{ name: "verify", outcome: "unconfigured" }])).toBe(true);
  });
});
