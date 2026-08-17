// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 58. The property under test is one sentence:
 *
 *   The cap can hide a success and can never hide a failure.
 *
 * A budget that could suppress a failure would be worse than no budget at all,
 * so the blocking-item case is asserted from both directions.
 */

import { describe, expect, test } from "bun:test";
import {
  HOST_REPORT_TOKEN_CEILING,
  capItems,
  hasInFlightDisplay,
  isCapped,
  type ItemLine,
} from "../src/report/budget.ts";

const item = (index: number, blocking: boolean): ItemLine => ({
  index,
  blocking,
  line: `item ${index}`,
});

describe("who pays for output", () => {
  test("only the host session is capped", () => {
    expect(isCapped("host-session")).toBe(true);
    expect(isCapped("terminal")).toBe(false);
    expect(isCapped("acp-client")).toBe(false);
  });

  test("and only the host session has no in-flight display", () => {
    // Not a limitation to work around: stdout lands in the model's context as
    // one block at exit, so progress would be tokens spent on an animation.
    expect(hasInFlightDisplay("host-session")).toBe(false);
    expect(hasInFlightDisplay("terminal")).toBe(true);
    expect(hasInFlightDisplay("acp-client")).toBe(true);
  });

  test("the ceiling is ruling 39's repo-map budget", () => {
    expect(HOST_REPORT_TOKEN_CEILING).toBe(2_000);
  });
});

describe("the cap can hide a success and never a failure", () => {
  const fifty = Array.from({ length: 50 }, (_, i) => item(i + 1, false));

  test("passing items collapse to a count rather than vanishing", () => {
    const { shown, collapsed } = capItems(fifty, 5);
    expect(shown).toHaveLength(5);
    expect(collapsed).toBe(45);
    // The collapsed count is returned, so it can be printed. Silently dropping
    // 45 items is the failure mode this guards.
    expect(shown.length + collapsed).toBe(fifty.length);
  });

  test("a blocking item is always shown, even when it does not fit", () => {
    const items = [...fifty.slice(0, 49), item(50, true)];
    const { shown } = capItems(items, 3);
    expect(shown.some((i) => i.blocking)).toBe(true);
    expect(shown.find((i) => i.index === 50)?.blocking).toBe(true);
  });

  test("MORE blocking items than the budget still shows all of them", () => {
    // Ruling 52 has no exception for space. The budget yields, not the checks.
    const items = Array.from({ length: 20 }, (_, i) => item(i + 1, true));
    const { shown, collapsed } = capItems(items, 3);
    expect(shown).toHaveLength(20);
    expect(collapsed).toBe(0);
  });

  test("blocking and passing mixed: every blocking one survives", () => {
    const items = [item(1, false), item(2, true), item(3, false), item(4, true), item(5, false)];
    const { shown } = capItems(items, 2);
    expect(shown.map((i) => i.index)).toEqual([2, 4]);
  });

  test("order is preserved so item numbers still read in sequence", () => {
    const items = [item(1, false), item(2, true), item(3, false)];
    const { shown } = capItems(items, 3);
    expect(shown.map((i) => i.index)).toEqual([1, 2, 3]);
  });

  test("nothing collapses when everything fits", () => {
    const { shown, collapsed } = capItems(fifty, 100);
    expect(shown).toHaveLength(50);
    expect(collapsed).toBe(0);
  });
});
