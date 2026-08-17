// SPDX-License-Identifier: Apache-2.0
/** Ruling 69. Drift is graded by what it can silently break, not by how far the number moved. */

import { describe, expect, test } from "bun:test";
import { PROFILES } from "../src/agent/profiles.ts";
import { driftFor, laneFailureBlocks, overrideWarning } from "../src/agent/drift.ts";

describe("drift is graded by blast radius", () => {
  test("a moved version makes the lane assertion blocking and capabilities a warning", () => {
    const drift = driftFor(PROFILES.claude, "0.70.0");
    const bySeverity = Object.fromEntries(drift.map((d) => [d.field, d.severity]));
    expect(bySeverity["laneAssertion"]).toBe("blocking");
    expect(bySeverity["capabilities"]).toBe("warn");
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

describe("a bridge override is loud", () => {
  test("it names what it invalidated", () => {
    const warning = overrideWarning({ agent: "codex", command: "npx", args: ["-y", "some-fork"] });
    expect(warning).toContain("codex");
    expect(warning).toContain("some-fork");
    expect(warning).toContain("unverified");
  });
});
