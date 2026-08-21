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
  KNOWN_EVENTS_CLAUDE_VERSION,
  KNOWN_HOOK_EVENTS,
  REGISTERED_HOOK_EVENTS,
  eventsAboveFloor,
  hookWarning,
  missingHooks,
  unrecognisedEvents,
} from "../src/plugin/hooks.ts";

// Real output, CAPTURED from `claude plugin details brigadier` against
// `claude 2.1.238` on macOS 26.5.2 on 2026-08-21, with brigadier's own asset
// installed. The previous fixture was the same command's output at 2.1.233 with
// one hook registered; it was replaced when ruling 75 registered a second,
// rather than hand-edited — the point of a captured fixture is that no human
// decided what it says.
//
// It also settles the question registering a second event raises: `Hooks (2)`
// with both names means the file was NOT discarded on this version, which is
// ruling 60's silent failure mode observed not happening.
const healthy = `brigadier 0.0.0
  An ACP hub: one client drives whichever coding agents are installed, isolates each unit of work, and composes them.
  Source: brigadier@skills-dir

Component inventory
  Skills (1)  brigadier
  Agents (0)
  Hooks (2)  PreCompact, UserPromptSubmit  (harness-only — no model context cost)
  MCP servers (0)
  LSP servers (0)
`;

// What one unrecognised event produces. This is the failure, and it is silent.
const discarded = healthy.replace(
  "  Hooks (2)  PreCompact, UserPromptSubmit  (harness-only — no model context cost)\n",
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

  test("two events, and every one of them is another way to lose all of them", () => {
    // Because the discard is TOTAL, the count is a liability rather than a
    // feature. This asserts the exact set rather than a maximum, so ADDING a
    // third is a deliberate edit here — which is the only protection a
    // total-discard failure mode can have.
    expect([...REGISTERED_HOOK_EVENTS]).toEqual(["PreCompact", "UserPromptSubmit"]);
    for (const event of REGISTERED_HOOK_EVENTS) expect(FLOOR_HOOK_EVENTS).toContain(event);
  });
});

describe("the self-check asserts names, not a count", () => {
  test("a healthy plugin reports nothing missing", () => {
    expect(missingHooks(healthy)).toEqual([]);
    expect(hookWarning(missingHooks(healthy))).toBe("");
  });

  test("the silent total discard is detected, and reports EVERY lost event", () => {
    // The cost of the second event, made visible: a discard now loses possession
    // AND decision 28's handoff nudge, and the check has to name both or an
    // operator fixes one and believes they are done.
    expect(missingHooks(discarded)).toEqual(["PreCompact", "UserPromptSubmit"]);
    expect(hookWarning(missingHooks(discarded))).toContain("not registered");
  });

  test("a NON-ZERO count with the wrong names is still a failure", () => {
    // This is the case a count-based check would pass. `.lsp.json` was measured
    // reporting `LSP servers (1)` for `{"notARealKey": 1}`, so a non-zero count
    // is not evidence that the right thing loaded.
    const wrong = healthy.replace("Hooks (2)  PreCompact, UserPromptSubmit", "Hooks (2)  SomethingElse, AnotherThing");
    expect(missingHooks(wrong)).toEqual(["PreCompact", "UserPromptSubmit"]);
  });

  test("multiple expected events are reported individually", () => {
    expect(missingHooks(healthy, ["PreCompact", "SubagentStop"])).toEqual(["SubagentStop"]);
    expect(hookWarning(["PreCompact", "SubagentStop"])).toContain("hooks are");
    expect(hookWarning(["PreCompact"])).toContain("hook is");
  });

  test("output with no Hooks line at all is a failure, not a pass", () => {
    // A reformat of `claude plugin details` lands here. Ruling 52: it blocks
    // rather than passes, so it fails safe and noisily.
    expect(missingHooks("some completely different output")).toEqual(["PreCompact", "UserPromptSubmit"]);
  });
});

describe("the vocabulary used to FLAG someone else's file", () => {
  test("what brigadier registers is inside the vocabulary it recognises", () => {
    for (const event of REGISTERED_HOOK_EVENTS) expect(KNOWN_HOOK_EVENTS).toContain(event);
    for (const event of FLOOR_HOOK_EVENTS) expect(KNOWN_HOOK_EVENTS).toContain(event);
  });

  test("the vocabulary is measured against a NEWER claude than the floor", () => {
    // The two constants point in opposite directions on purpose: the floor is
    // the oldest claude the registered set survives, the vocabulary is the
    // newest one, because flagging a real event as poison is a false alarm on a
    // working installation.
    expect(KNOWN_EVENTS_CLAUDE_VERSION).toBe("2.1.234");
    expect(HOOK_FLOOR_CLAUDE_VERSION).toBe("2.1.233");
    expect(KNOWN_HOOK_EVENTS.length).toBeGreaterThan(FLOOR_HOOK_EVENTS.length);
  });

  test("nothing is recognised twice, and the list is sorted so a diff is readable", () => {
    expect(new Set(KNOWN_HOOK_EVENTS).size).toBe(KNOWN_HOOK_EVENTS.length);
    expect([...KNOWN_HOOK_EVENTS]).toEqual([...KNOWN_HOOK_EVENTS].sort());
  });

  test("NEGATIVE CONTROL: the four names MEASURED to be rejected are rejected", () => {
    // Measured in the same run that produced the list, against `claude 2.1.234`
    // on 2026-08-18: each of these reported `Hooks (0)` — the total discard.
    // Two of them are plausible enough that a hand-written list would carry them.
    expect(unrecognisedEvents(["PreSubagentStart", "PermissionDecision", "Error", "NotARealEvent"])).toEqual([
      "PreSubagentStart",
      "PermissionDecision",
      "Error",
      "NotARealEvent",
    ]);
  });

  test("and the real ones beside them are not", () => {
    expect(unrecognisedEvents(["SubagentStart", "Setup", "TeammateIdle", "PostCompact"])).toEqual([]);
  });

  test("file order is preserved, because that is the order the reader will scan", () => {
    expect(unrecognisedEvents(["zzz", "PreCompact", "aaa"])).toEqual(["zzz", "aaa"]);
  });
});
