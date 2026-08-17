// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 60. The self-check must assert on NAMES, and these tests exist to hold
 * it there — because the obvious implementation checks a count, and the same
 * probe measured a count being inflated by garbage in `.lsp.json`.
 */

import { describe, expect, test } from "bun:test";
import {
  FLOOR_HOOK_EVENTS,
  HOOK_FLOOR_CLAUDE_VERSION,
  REGISTERED_HOOK_EVENTS,
  eventsAboveFloor,
  hookWarning,
  missingHooks,
} from "../src/plugin/hooks.ts";

// Real output shape, copied from `claude plugin details` on 2.1.233.
const healthy = `probeplug 0.0.1
  probe
  Source: probeplug@skills-dir

Component inventory
  Skills (1)  demo
  Agents (0)
  Hooks (1)  PreCompact  (harness-only — no model context cost)
  MCP servers (0)
  LSP servers (0)
`;

// What one unrecognised event produces. This is the failure, and it is silent.
const discarded = healthy.replace(
  "  Hooks (1)  PreCompact  (harness-only — no model context cost)\n",
  "  Hooks (0)\n",
);

describe("the build gate", () => {
  test("what we register is inside the measured floor", () => {
    expect(eventsAboveFloor()).toEqual([]);
    expect(HOOK_FLOOR_CLAUDE_VERSION).toBe("2.1.233");
  });

  test("NEGATIVE CONTROL: an event above the floor is caught", () => {
    expect(eventsAboveFloor(["PreCompact", "SomeNewEventAddedLater"])).toEqual([
      "SomeNewEventAddedLater",
    ]);
  });

  test("one event, which is the minimum possible blast radius", () => {
    // Because the discard is TOTAL, every extra event is another way to lose
    // all of them on an older host.
    expect(REGISTERED_HOOK_EVENTS).toHaveLength(1);
    expect(REGISTERED_HOOK_EVENTS[0]).toBe("PreCompact");
    expect(FLOOR_HOOK_EVENTS).toContain("PreCompact");
  });
});

describe("the self-check asserts names, not a count", () => {
  test("a healthy plugin reports nothing missing", () => {
    expect(missingHooks(healthy)).toEqual([]);
    expect(hookWarning(missingHooks(healthy))).toBe("");
  });

  test("the silent total discard is detected", () => {
    expect(missingHooks(discarded)).toEqual(["PreCompact"]);
    expect(hookWarning(missingHooks(discarded))).toContain("not registered");
  });

  test("a NON-ZERO count with the wrong names is still a failure", () => {
    // This is the case a count-based check would pass. `.lsp.json` was measured
    // reporting `LSP servers (1)` for `{"notARealKey": 1}`, so a non-zero count
    // is not evidence that the right thing loaded.
    const wrong = healthy.replace("Hooks (1)  PreCompact", "Hooks (1)  SomethingElse");
    expect(missingHooks(wrong)).toEqual(["PreCompact"]);
  });

  test("multiple expected events are reported individually", () => {
    expect(missingHooks(healthy, ["PreCompact", "SubagentStop"])).toEqual(["SubagentStop"]);
    expect(hookWarning(["PreCompact", "SubagentStop"])).toContain("hooks are");
    expect(hookWarning(["PreCompact"])).toContain("hook is");
  });

  test("output with no Hooks line at all is a failure, not a pass", () => {
    // A reformat of `claude plugin details` lands here. Ruling 52: it blocks
    // rather than passes, so it fails safe and noisily.
    expect(missingHooks("some completely different output")).toEqual(["PreCompact"]);
  });
});
