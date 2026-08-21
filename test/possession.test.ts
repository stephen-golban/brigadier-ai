// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 75 — possession, and the two cases where it must say nothing.
 *
 * The silences are the assertions that matter. A hook that tells a WORKER it is
 * brigadier is v1's finding 114 with a louder voice — a worker that ran the
 * orchestrator instead of working, 12 minutes and zero files, which reproduced
 * unprovoked in #14. And a toggle that does not turn anything off is not a
 * toggle.
 */

import { describe, expect, test } from "bun:test";
import {
  POSSESSION_DOCTRINE,
  POSSESSION_LINE,
  possessionContext,
  possessionSilence,
} from "../src/plugin/possess.ts";
import { POSSESSABLE, binaryNameFor, isAgentName, planLaunch, vendorArgs } from "../src/setup/launch.ts";
import { FLOOR_HOOK_EVENTS, REGISTERED_HOOK_EVENTS, eventsAboveFloor } from "../src/plugin/hooks.ts";
import { ALL_AGENT_IDS, PROFILES, reachesWeb, researchRefusal } from "../src/agent/profiles.ts";

describe("what a possessed session is told", () => {
  test("a normal session gets the line", () => {
    expect(possessionContext({ insideWorker: false, enabled: true })).toBe(POSSESSION_LINE);
  });

  test("the line is ONE line, because it is paid for on every prompt", () => {
    // Not D24's rule — that governs output to the USER. This is output to a
    // model, and it is one line for ruling 21's reason: a byte-stable prefix was
    // measured at a 16.5x cache lever, and this string is emitted again on every
    // turn of a conversation that may run for hours.
    expect(POSSESSION_LINE).not.toContain("\n");
  });

  test("the line carries NOTHING that varies", () => {
    // The moment a run id, a timestamp or a path enters this string, the cache
    // lever is spent on every turn — the most expensive possible way to be
    // slightly more informative. Called twice, it must be byte-identical.
    const a = possessionContext({ insideWorker: false, enabled: true });
    const b = possessionContext({ insideWorker: false, enabled: true });
    expect(a).toBe(b);
    expect(POSSESSION_LINE).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(POSSESSION_LINE).not.toMatch(/\/(Users|home)\//);
  });

  test("it names the goal entry point, which is the whole point of possession", () => {
    expect(POSSESSION_LINE).toContain("--goal");
  });
});

describe("the two silences", () => {
  test("inside a WORKER it emits NOTHING — not a shorter line, nothing", () => {
    expect(possessionContext({ insideWorker: true, enabled: true })).toBe("");
  });

  test("with the toggle off it emits NOTHING", () => {
    expect(possessionContext({ insideWorker: false, enabled: false })).toBe("");
  });

  test("a worker is silent even when possession is enabled — ruling 36 wins over D1", () => {
    // The precedence matters and is not obvious: an operator with possession on
    // is not asking for their workers to be possessed. If these two were ever
    // resolved the other way, every worker would be told to delegate.
    expect(possessionContext({ insideWorker: true, enabled: true })).toBe("");
  });

  test("the hook stays silent, but the DIAGNOSTIC path explains — they are different channels", () => {
    // A hook that explains why it is quiet costs tokens to say nothing, on every
    // prompt, forever. A person who runs a check has asked once.
    expect(possessionSilence({ insideWorker: true, enabled: true })).toContain("finding 114");
    expect(possessionSilence({ insideWorker: false, enabled: false })).toContain("possession.enabled");
    expect(possessionSilence({ insideWorker: false, enabled: true })).toBeUndefined();
  });
});

describe("ruling 60's blast radius, now that a second event is registered", () => {
  test("both registered events are at or below the measured floor", () => {
    // The build gate. ONE unrecognised event discards EVERY hook in the file —
    // `Hooks (3)` becomes `Hooks (0)`, silently — so registering above the floor
    // would break the PreCompact nudge too, on every older claude.
    expect(eventsAboveFloor()).toEqual([]);
  });

  test("UserPromptSubmit is registered, and it was in the floor all along", () => {
    expect(REGISTERED_HOOK_EVENTS).toContain("UserPromptSubmit");
    expect(FLOOR_HOOK_EVENTS).toContain("UserPromptSubmit");
  });

  test("decision 28's PreCompact nudge was not traded away for it", () => {
    expect(REGISTERED_HOOK_EVENTS).toContain("PreCompact");
  });
});

describe("`brigadier claude` — the launch path", () => {
  const base = {
    userArgs: [] as string[],
    binary: "/usr/local/bin/claude",
    pluginDirectory: "/home/example/.claude/skills/brigadier",
    doctrine: "/home/example/.brigadier/possession.md",
    enabled: true,
  };

  test("possession APPENDS to the system prompt and never replaces it", () => {
    // `--system-prompt-file` would delete Claude Code's own system prompt: every
    // tool instruction and every safety property the vendor put there. A hub
    // that lobotomises its workers is a competitor wearing a hub's name.
    const plan = planLaunch({ ...base, agent: "claude" });
    expect(plan.args).toContain("--append-system-prompt-file");
    expect(plan.args).not.toContain("--system-prompt-file");
  });

  test("the plugin is loaded for that session only", () => {
    const plan = planLaunch({ ...base, agent: "claude" });
    expect(plan.args).toContain("--plugin-dir");
    expect(plan.possessed).toBe(true);
    expect(plan.notice).toBeUndefined();
  });

  test("the operator's arguments come LAST, so anything they typed can win", () => {
    const plan = planLaunch({ ...base, agent: "claude", userArgs: ["--model", "opus", "-p", "hi"] });
    const injected = plan.args.indexOf("--plugin-dir");
    const theirs = plan.args.indexOf("--model");
    expect(injected).toBeLessThan(theirs);
    expect(plan.args.slice(-4)).toEqual(["--model", "opus", "-p", "hi"]);
  });

  test("an UNPOSSESSABLE vendor is launched untouched, and told so once", () => {
    // Possession is measured on Claude Code and nowhere else. Injecting flags
    // into the other five would be a product claim with no measurement under it.
    const plan = planLaunch({ ...base, agent: "codex", binary: "/usr/local/bin/codex" });
    expect(plan.args).toEqual([]);
    expect(plan.possessed).toBe(false);
    expect(plan.notice).toContain("model discretion");
  });

  test("the toggle turns the launch path off too, not just the hook", () => {
    const plan = planLaunch({ ...base, agent: "claude", enabled: false });
    expect(plan.possessed).toBe(false);
    expect(plan.args).toEqual([]);
    expect(plan.notice).toContain("turned off");
  });

  test("only claude is possessable, and the list says so out loud", () => {
    expect([...POSSESSABLE]).toEqual(["claude"]);
  });
});

describe("the launch target is the CLI, not the ACP bridge", () => {
  test("`brigadier claude` launches `claude`, never `npx`", () => {
    // The trap: PROFILES.claude.command is `npx`, because claude is reached
    // through a vendored bridge (rulings 4 and 44). Launching that when a person
    // typed `brigadier claude` starts a stdio protocol against a human, which
    // hangs rather than errors — ruling 69's stale-coordinate failure shape.
    expect(PROFILES.claude.command).toBe("npx");
    expect(binaryNameFor("claude")).toBe("claude");
    expect(binaryNameFor("codex")).toBe("codex");
  });
});

describe("a vendor name must never be shadowed by a subcommand", () => {
  test("no agent id collides with a brigadier subcommand", () => {
    // `brigadier claude` dispatches to a launch before the subcommand switch is
    // consulted, so a future subcommand named after a vendor would become
    // unreachable silently. This is the guard that makes that a red test rather
    // than a mystery.
    const subcommands = [
      "run", "plan", "serve", "detect", "agents", "competence", "licenses",
      "version", "install", "uninstall", "plugin", "setup", "hook", "resume",
    ];
    for (const id of ALL_AGENT_IDS) expect(subcommands).not.toContain(id);
  });

  test("every agent id is recognised as a launch target", () => {
    for (const id of ALL_AGENT_IDS) expect(isAgentName(id)).toBe(true);
    expect(isAgentName("run")).toBe(false);
    expect(isAgentName(undefined)).toBe(false);
  });
});

describe("the doctrine the shim injects", () => {
  test("it may be long, because it is paid for ONCE per session", () => {
    expect(POSSESSION_DOCTRINE.split("\n").length).toBeGreaterThan(5);
  });

  test("it tells the session not to paste a plan into the conversation", () => {
    // D4: a plan is always shown as a path, never inline. If the doctrine ever
    // stops saying this, the session becomes the thing that floods its own
    // window — which is the failure ruling 58 measured at 115,000 tokens.
    expect(POSSESSION_DOCTRINE).toContain("path");
    expect(POSSESSION_DOCTRINE.toLowerCase()).toContain("do not paste a plan");
  });

  test("it tells the session to relay a question rather than answer it", () => {
    expect(POSSESSION_DOCTRINE).toContain("resume");
  });

  test("it does NOT make brigadier a tax on small work", () => {
    // D3: work that needs neither research nor a plan gets neither.
    expect(POSSESSION_DOCTRINE).toContain("single obvious edit");
  });
});

describe("brigadier's own flags must not reach the vendor's argv", () => {
  test("--home and --run-root are stripped, with their values", () => {
    // FOUND by driving it: `brigadier claude --version --home /x` forwarded
    // `--home /x` to claude, which rejects an unknown option with exit 1. It
    // only looked fine because `--version` short-circuits before argument
    // validation — a check that passed for a reason unrelated to what it tested.
    expect(vendorArgs(["--version", "--home", "/x", "--run-root", "/y"])).toEqual(["--version"]);
  });

  test("the vendor's own flags pass through untouched, including unknown ones", () => {
    // A launcher that filtered to a known list would break every flag the vendor
    // adds after we last looked at their CLI.
    expect(vendorArgs(["--model", "opus", "--some-future-flag", "-p", "hi"]))
      .toEqual(["--model", "opus", "--some-future-flag", "-p", "hi"]);
  });

  test("a trailing --home does not eat the vendor's next argument", () => {
    expect(vendorArgs(["--home", "--model", "opus"])).toEqual(["--model", "opus"]);
  });
});

describe("ruling 78's web-reach column", () => {
  test("measured-true agents are eligible for research", () => {
    // MEASURED 2026-08-21: each returned the exact dist.shasum of bun's current
    // npm release, matching an independent curl, against a control that answered
    // UNKNOWN when asked for the same value from memory.
    for (const id of ["claude", "copilot", "opencode"] as const) {
      expect(reachesWeb(id)).toBe(true);
      expect(researchRefusal(id)).toBeUndefined();
    }
  });

  test("UNMEASURED is a third state, and its refusal reads differently from a NO", () => {
    // The distinction is the ruling: an unmeasured agent needs somebody to run a
    // probe, a measured-false one needs a different vendor. Collapsing them into
    // "no" makes the refusal name the wrong remedy.
    for (const id of ["codex", "qwen", "gemini"] as const) {
      expect(reachesWeb(id)).toBeUndefined();
      expect(researchRefusal(id)).toContain("UNMEASURED");
      expect(researchRefusal(id)).not.toContain("unable to reach");
    }
  });

  test("the column is NOT a ruling 53 capability, and the vocabulary stays at three", () => {
    // On Codex, web reach is an argv flag (`--search`), and a boolean requirement
    // cannot pass a flag. That is why this is a launch-profile fact.
    const terms = Object.keys(PROFILES.codex.capabilities);
    expect(terms).not.toContain("webAccess");
    expect(terms).not.toContain("reachesWeb");
  });
});
