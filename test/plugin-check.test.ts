// SPDX-License-Identifier: Apache-2.0
/**
 * The negatives, which are the only part of this that is worth anything.
 *
 * Ruling 60's failure is SILENT: one unrecognised event in a `hooks.json`
 * discards every hook in the file, and malformed JSON does the same, and neither
 * prints anything. A checker for a silent failure that is itself never exercised
 * against the failure is indistinguishable from `return "ok"`, so ruling 62b's
 * demonstrated negative is not a nicety here — it is the entire test.
 *
 * Three of them, matching `BAR.md` item 10's three:
 *
 *   an unrecognised event is detected and reported BY NAME, never by count;
 *   malformed JSON is detected;
 *   a missing `PreCompact` is a RUN-LEVEL line (ruling 58), because it is a
 *   property of the installation and not of any one row.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PLUGIN_NAME } from "../src/plugin/asset.ts";
import { describeFinding, hooksCandidates, inspectHooks, judgeHooks } from "../src/plugin/check.ts";
import { KNOWN_HOOK_EVENTS, REGISTERED_HOOK_EVENTS } from "../src/plugin/hooks.ts";

const H = [{ hooks: [{ type: "command", command: "true" }] }];
const wrapped = (events: Record<string, unknown>) => JSON.stringify({ hooks: events });
const OURS = "/scratch/.claude/skills/brigadier/hooks/hooks.json";

/** Exactly the file `bar/items/10-the-artifact-ships.ts` plants. */
const poisonKey = "notARealEvent-a1b2c3";
const barPoison = JSON.stringify({ PreCompact: [{ command: "echo ok" }], [poisonKey]: [{ command: "echo no" }] }, null, 2);

describe("a healthy file", () => {
  test("the registered event is read back by name", () => {
    const finding = inspectHooks(OURS, wrapped({ PreCompact: H }), true);
    expect(finding.status).toBe("healthy");
    expect(finding.shape).toBe("wrapped");
    expect(finding.events).toEqual(["PreCompact"]);
    expect(finding.unrecognised).toEqual([]);
    expect(finding.detail).toContain("PreCompact");
  });

  test("every event `claude` was measured to accept is healthy", () => {
    // If this list were wrong in the small direction, a working installation
    // would be reported as poisoned. That is the false alarm the wide
    // vocabulary in hooks.ts exists to prevent, so it is asserted.
    const finding = inspectHooks(OURS, wrapped(Object.fromEntries(KNOWN_HOOK_EVENTS.map((e) => [e, H]))), true);
    expect(finding.status).toBe("healthy");
    expect(finding.unrecognised).toEqual([]);
  });

  test("absent is a different observation from empty, and says so", () => {
    expect(inspectHooks(OURS, undefined, true).status).toBe("absent");
    expect(inspectHooks(OURS, "{}", true).status).toBe("healthy");
    expect(inspectHooks(OURS, "{}", true).events).toEqual([]);
  });
});

describe("NEGATIVE CONTROL: one unrecognised event, reported by NAME", () => {
  test("the poison is found beside valid hooks", () => {
    const finding = inspectHooks(OURS, wrapped({ PreCompact: H, NotARealEvent: H }), true);
    expect(finding.status).toBe("poisoned");
    expect(finding.unrecognised).toEqual(["NotARealEvent"]);
  });

  test("the key itself is quoted back, and the total discard is stated", () => {
    const finding = inspectHooks(OURS, wrapped({ PreCompact: H, NotARealEvent: H }), true);
    const text = describeFinding(finding, "why").join("\n");
    expect(text).toContain("NotARealEvent");
    expect(text).toContain("DISCARDS EVERY HOOK IN THIS FILE");
    // Item 10's own predicate, so the unit test and the bar cannot disagree.
    expect(/(discard|ignored|unrecognis|unrecogniz|unknown event|invalid)/i.test(text)).toBe(true);
  });

  test("a COUNT would pass this file, which is why nothing here counts", () => {
    // `.lsp.json` was measured reporting `LSP servers (1)` for `{"notARealKey": 1}`.
    const finding = inspectHooks(OURS, wrapped({ PreCompact: H, NotARealEvent: H }), true);
    expect(finding.events).toHaveLength(2);
    expect(finding.events.length > 0).toBe(true);
    expect(finding.status).toBe("poisoned");
  });

  test("the bar's own planted file, in its own bare shape", () => {
    // The harness writes NO `hooks` wrapper, so the top-level keys are the
    // events. A checker that only understood the wrapped shape would read this
    // file as having one unrecognised key called `PreCompact` — or as healthy.
    const finding = inspectHooks("/scratch/.claude/hooks.json", barPoison, false);
    expect(finding.shape).toBe("bare");
    expect(finding.status).toBe("poisoned");
    expect(finding.unrecognised).toEqual([poisonKey]);
    expect(describeFinding(finding, "why").join("\n")).toContain(poisonKey);
  });

  test("several unrecognised events are all named, in file order", () => {
    const finding = inspectHooks(OURS, wrapped({ zzTop: H, PreCompact: H, aaBottom: H }), true);
    expect(finding.unrecognised).toEqual(["zzTop", "aaBottom"]);
  });
});

describe("NEGATIVE CONTROL: malformed JSON", () => {
  test("detected, and named as the silent zero it is", () => {
    const finding = inspectHooks(OURS, '{ "hooks": { oops\n', true);
    expect(finding.status).toBe("malformed");
    expect(describeFinding(finding, "why").join("\n")).toContain("discarded");
  });

  test("a top level that is not an object is detected too", () => {
    expect(inspectHooks(OURS, "[]", true).status).toBe("not-an-object");
    expect(inspectHooks(OURS, "42", true).status).toBe("not-an-object");
    expect(inspectHooks(OURS, "null", true).status).toBe("not-an-object");
  });
});

describe("NEGATIVE CONTROL: ruling 58's run-level line for a missing PreCompact", () => {
  // A healthy file now carries BOTH registered events — decision 28's handoff
  // nudge and ruling 75's possession. A fixture with only one is a file missing
  // a hook, which is what these tests exist to detect.
  const healthyOwn = inspectHooks(OURS, wrapped({ PreCompact: H, UserPromptSubmit: H }), true);

  test("a complete installation produces no missing-hook line", () => {
    const report = judgeHooks({ findings: [healthyOwn], detailsOutput: undefined, installed: true });
    expect(report.ok).toBe(true);
    expect(report.runLevel.join("\n")).not.toContain("not registered");
  });

  test("brigadier's own file without PreCompact is a RUN-LEVEL line, not a row", () => {
    const stripped = inspectHooks(OURS, wrapped({ UserPromptSubmit: H }), true);
    const report = judgeHooks({ findings: [stripped], detailsOutput: undefined, installed: true });
    expect(report.ok).toBe(false);
    expect(report.runLevel.join("\n")).toContain(`${REGISTERED_HOOK_EVENTS[0]} hook is not registered`);
    // The row itself is healthy — the file parses and its one event is real.
    // That is exactly why this cannot live in a row.
    expect(stripped.status).toBe("healthy");
  });

  test("the host's own view is read by NAME when it is consulted", () => {
    const discarded = "Component inventory\n  Skills (1)  brigadier\n  Hooks (0)\n  MCP servers (0)\n";
    const report = judgeHooks({ findings: [healthyOwn], detailsOutput: discarded, installed: true });
    expect(report.ok).toBe(false);
    expect(report.runLevel.join("\n")).toContain("not registered");
  });

  test("a non-zero count with the WRONG name still fails", () => {
    const wrongName = "Component inventory\n  Hooks (1)  SomethingElse\n";
    const report = judgeHooks({ findings: [healthyOwn], detailsOutput: wrongName, installed: true });
    expect(report.ok).toBe(false);
  });

  test("and the healthy host view says so by name rather than by count", () => {
    // Two names now. CAPTURED from `claude plugin details brigadier` against
    // `claude 2.1.238` on 2026-08-21 — a real installation, not a hand-written
    // shape.
    const good = "Component inventory\n  Hooks (2)  PreCompact, UserPromptSubmit  (harness-only — no model context cost)\n";
    const report = judgeHooks({ findings: [healthyOwn], detailsOutput: good, installed: true });
    expect(report.ok).toBe(true);
    expect(report.runLevel.join("\n")).toContain("asserted by NAME");
  });

  test("not consulting `claude` is stated, never left to be assumed", () => {
    const report = judgeHooks({ findings: [healthyOwn], detailsOutput: undefined, installed: true });
    expect(report.runLevel.join("\n")).toContain("was not run");
  });

  test("an absent installation is an outcome, not a silent pass", () => {
    const report = judgeHooks({ findings: [], detailsOutput: undefined, installed: false });
    expect(report.ok).toBe(false);
    expect(report.runLevel.join("\n")).toContain("not installed");
  });
});

describe("which files are looked at", () => {
  const candidates = hooksCandidates({ HOME: "/scratch" }, "/scratch");

  test("brigadier's own file is the only one marked ours under .claude", () => {
    const ours = candidates.filter((c) => c.ours).map((c) => c.path);
    expect(ours).toContain(join("/scratch", ".claude", "skills", PLUGIN_NAME, "hooks", "hooks.json"));
  });

  test("the file the bar plants is on the list", () => {
    expect(candidates.map((c) => c.path)).toContain(join("/scratch", ".claude", "hooks.json"));
  });

  test("a file under ~/.agents is inspected and reported INERT, because nothing reads it", () => {
    // MEASURED against `claude 2.1.234` on 2026-08-18: a complete plugin planted
    // under ~/.agents/skills/ reported `Plugin "probeplug" not found`.
    const path = join("/scratch", ".agents", "skills", PLUGIN_NAME, "hooks", "hooks.json");
    expect(candidates.map((c) => c.path)).toContain(path);
    const finding = inspectHooks(path, wrapped({ PreCompact: H }), true);
    expect(describeFinding(finding, "why").join("\n")).toContain("inert");
  });

  test("CLAUDE_CONFIG_DIR moves the candidates with it", () => {
    const moved = hooksCandidates({ HOME: "/scratch", CLAUDE_CONFIG_DIR: "/elsewhere" }, "/scratch");
    expect(moved.map((c) => c.path)).toContain(join("/elsewhere", "hooks.json"));
  });
});
