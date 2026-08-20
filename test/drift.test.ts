// SPDX-License-Identifier: Apache-2.0
/** Ruling 69. Drift is graded by what it can silently break, not by how far the number moved. */

import { describe, expect, test } from "bun:test";
import { PROFILES } from "../src/agent/profiles.ts";
import {
  applyOverride,
  driftFor,
  laneFailureBlocks,
  noBlockingReason,
  overrideWarning,
  parseOverrides,
  sessionContradictions,
} from "../src/agent/drift.ts";

describe("drift is graded by blast radius", () => {
  /**
   * DERIVED FROM THE PROFILE, never a literal, and that is the whole lesson of
   * this test's own history. It used to read `driftFor(PROFILES.claude,
   * "0.70.0")` against a profile whose `measuredVersion` was `0.69.0` — a real
   * drift, pinned as a fixture. On 2026-08-20 the Claude profile was
   * re-measured against 0.70.0 and the literal became the profile's OWN
   * version, so the test asserted that a version drifts against itself and went
   * red. A fixture that names a moving coordinate goes stale exactly the way
   * ruling 69 says every table naming one does.
   *
   * `${measured}-moved` cannot be any profile's measured version, so this
   * asserts the GRADING — blocking vs warn — rather than a coordinate.
   */
  test("a moved version makes the lane assertion blocking and capabilities a warning", () => {
    const drift = driftFor(PROFILES.claude, `${PROFILES.claude.measuredVersion}-moved`);
    const bySeverity = Object.fromEntries(drift.map((d) => [d.field, d.severity]));
    expect(bySeverity["laneAssertion"]).toBe("blocking");
    expect(bySeverity["capabilities"]).toBe("warn");
  });

  test("NEGATIVE CONTROL: the Claude profile's OWN measured version drifts against nothing", () => {
    // The half that would have caught the staleness above the moment it
    // appeared, rather than when a literal happened to collide.
    expect(driftFor(PROFILES.claude, PROFILES.claude.measuredVersion)).toEqual([]);
  });

  test("a vendor with no lane lever has nothing blocking to lose", () => {
    // Copilot's laneAssertion is `none` — there is no assertion to fail, so the
    // drift there is a stale capability table and nothing more.
    const drift = driftFor(PROFILES.copilot, "9.9.9");
    expect(drift.every((d) => d.severity !== "blocking")).toBe(true);
    expect(drift.length).toBeGreaterThan(0);
  });

  test("NEGATIVE CONTROL: the measured version drifts against nothing", () => {
    expect(driftFor(PROFILES.copilot, "1.0.80")).toEqual([]);
    // And an agent that reported no version cannot be compared, so it is not
    // reported as drifted — an unknown is not a change.
    expect(driftFor(PROFILES.copilot, "unknown")).toEqual([]);
  });
});

describe("a failed lane assertion blocks a write item", () => {
  test("write on a vendor that has a lever", () => {
    // #3 measured the Claude bridge opening in bypassPermissions, so a write
    // worker whose lane did not assert is a worker with no lane.
    expect(laneFailureBlocks(PROFILES.claude, "write")).toBe(true);
    expect(laneFailureBlocks(PROFILES.codex, "write")).toBe(true);
  });

  test("read-only does not block on it — ruling 49 is why", () => {
    // Its flat `deny` lane needs no vendor cooperation. That is exactly why
    // ruling 49 defined the kind by what brigadier reads back.
    expect(laneFailureBlocks(PROFILES.claude, "read-only")).toBe(false);
  });

  test("a vendor with no lever cannot fail an assertion it never makes", () => {
    expect(laneFailureBlocks(PROFILES.qwen, "write")).toBe(false);
    expect(laneFailureBlocks(PROFILES.opencode, "write")).toBe(false);
  });
});

describe("a bridge that moved under a fixed version number", () => {
  test("a profile measured with a model list, and a session with none, is a contradiction", () => {
    // No history is needed and none is kept: `modelsAtSessionNew: true` says
    // models were MEASURED to arrive here, so their absence is checkable inside
    // the run that observed it.
    const drift = sessionContradictions(PROFILES.codex, { models: [] });
    expect(drift).toHaveLength(1);
    expect(drift[0]!.field).toBe("modelsAtSessionNew");
    // Warn, not blocking: ruling 55's second rung is
    // same-vendor-different-model, and on a one-vendor machine it exists only
    // because Codex returns its effort-bearing ids — so an empty list silently
    // shortens the ladder. Silent, but not a loss of containment.
    expect(drift[0]!.severity).toBe("warn");
  });

  test("NEGATIVE CONTROL: a session that returned models contradicts nothing", () => {
    expect(sessionContradictions(PROFILES.codex, { models: ["gpt-5.6-sol[high]"] })).toEqual([]);
  });

  test("NEGATIVE CONTROL: a profile measured WITHOUT a model list is not accused of losing one", () => {
    // Five of six return none (#2). Reporting those every run would be a
    // warning that fires on the normal case, which is a warning nobody reads.
    for (const id of ["claude", "copilot", "qwen", "opencode", "gemini"] as const) {
      expect(sessionContradictions(PROFILES[id], { models: [] })).toEqual([]);
    }
  });
});

describe("what a drift did NOT block is stated, never inferred from silence", () => {
  test("a vendor with no lever says so, and names what would have blocked", () => {
    const drift = driftFor(PROFILES.qwen, "99.0.0");
    const reason = noBlockingReason(PROFILES.qwen, drift);
    expect(reason).toContain("lane assertion");
    expect(reason).toContain("BLOCKS");
    expect(reason).toContain("qwen");
  });

  test("NEGATIVE CONTROL: nothing is said twice when something blocking did fire", () => {
    // `driftFor` already emitted the blocking entry with its own reason there.
    expect(noBlockingReason(PROFILES.claude, driftFor(PROFILES.claude, "99.0.0"))).toBeUndefined();
  });

  test("a declared lever that did not drift is reported as clean, not as absent", () => {
    // Codex at its measured version with an empty model list: one warn, no
    // blocking entry, and a lane lever that exists. Those are different facts
    // from qwen's, and collapsing them would tell an operator their containment
    // was never there.
    const drift = sessionContradictions(PROFILES.codex, { models: [] });
    const reason = noBlockingReason(PROFILES.codex, drift);
    expect(reason).toContain("declared for codex");
    expect(reason).toContain("BLOCKS");
  });
});

describe("a bridge override is loud", () => {
  test("it names what it invalidated", () => {
    const warning = overrideWarning({ agent: "codex", command: "npx", args: ["-y", "some-fork"] });
    expect(warning).toContain("codex");
    expect(warning).toContain("some-fork");
    expect(warning).toContain("unverified");
  });

  test("it replaces the coordinate and nothing else", () => {
    const overridden = applyOverride(PROFILES.codex, [
      { agent: "codex", command: "/opt/fixed-codex-acp", args: ["--acp"] },
    ]);
    expect(overridden.command).toBe("/opt/fixed-codex-acp");
    expect(overridden.args).toEqual(["--acp"]);
    // measuredVersion is the record of what was measured and against WHAT.
    // Rewriting it to say "unverified" would destroy the only fact drift
    // grading has to compare against; the invalidation is announced instead.
    expect(overridden.measuredVersion).toBe(PROFILES.codex.measuredVersion);
    expect(overridden.laneAssertion).toEqual(PROFILES.codex.laneAssertion);
  });

  test("NEGATIVE CONTROL: an override for another agent leaves this one alone", () => {
    expect(applyOverride(PROFILES.codex, [{ agent: "claude", command: "x", args: [] }])).toBe(PROFILES.codex);
    expect(applyOverride(PROFILES.codex, [])).toBe(PROFILES.codex);
  });

  test("a malformed override is REPORTED, never silently dropped", () => {
    // The worst outcome is the silent one: an operator who wrote an override
    // believes their fixed bridge is running while the table's coordinate is.
    expect(parseOverrides("not json").problems.length).toBeGreaterThan(0);
    expect(parseOverrides('{"agent":"codex"}').problems.length).toBeGreaterThan(0);
    expect(parseOverrides('[{"command":"x"}]').problems[0]).toContain("agent");
    expect(parseOverrides('[{"agent":"codex","command":"x","args":[1]}]').problems[0]).toContain("args");
    // and nothing malformed becomes an override
    expect(parseOverrides('[{"agent":"codex","command":"x","args":[1]}]').overrides).toEqual([]);
  });

  test("a well-formed override parses, with args defaulting to none", () => {
    const parsed = parseOverrides('[{"agent":"codex","command":"/opt/acp","args":["--acp"]},{"agent":"claude","command":"c"}]');
    expect(parsed.problems).toEqual([]);
    expect(parsed.overrides).toEqual([
      { agent: "codex", command: "/opt/acp", args: ["--acp"] },
      { agent: "claude", command: "c", args: [] },
    ]);
  });
});
