// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 49. These tests exist because the constant they check was already
 * wrong in a shipped file: Codex's restrictive lane assertion was
 * `INITIAL_AGENT_MODE=read-only` for BOTH kinds, and #41 measured that mode as
 * blocking writes at the OS level — so every Codex `write` worker would have
 * been sandboxed out of doing its job, failing as a bad agent rather than a bad
 * constant.
 *
 * Each assertion below has its opposite asserted beside it, so a guard that
 * always passes cannot look like a working one.
 */

import { describe, expect, test } from "bun:test";
import { PROFILES, buildEnvironment, laneModeFor } from "../src/agent/profiles.ts";
import { KIND_CONTRACT, lanePolicyFor } from "../src/work/kind.ts";

describe("the work kinds differ where ruling 49 says they differ", () => {
  test("read-only denies flatly; write uses the lane", () => {
    expect(lanePolicyFor("read-only")).toBe("deny");
    expect(lanePolicyFor("write")).toBe("lane");
  });

  test("only write merges back, installs, and is cross-vendor reviewed", () => {
    expect(KIND_CONTRACT.write.mergesBack).toBe(true);
    expect(KIND_CONTRACT["read-only"].mergesBack).toBe(false);
    expect(KIND_CONTRACT.write.mayInstallDependencies).toBe(true);
    expect(KIND_CONTRACT["read-only"].mayInstallDependencies).toBe(false);
    expect(KIND_CONTRACT.write.crossVendorReview).toBe(true);
    expect(KIND_CONTRACT["read-only"].crossVendorReview).toBe(false);
  });

  test("the read-only recycle keeps `clean -fdx`", () => {
    // #19: `checkout --force` leaves untracked and gitignored residue, which is
    // how one item's junk becomes the next item's context.
    expect(KIND_CONTRACT["read-only"].recycle).toContain("git clean -fdx");
    expect(KIND_CONTRACT.write.recycle).toHaveLength(0);
  });
});

describe("the per-kind lane assertion", () => {
  test("Codex asserts a DIFFERENT mode per kind", () => {
    const codex = PROFILES.codex.laneAssertion;
    const write = laneModeFor(codex, "write");
    const readOnly = laneModeFor(codex, "read-only");
    expect(write).toBe("agent");
    expect(readOnly).toBe("read-only");
    // The defect this file exists for: one value serving both kinds.
    expect(write).not.toBe(readOnly);
  });

  test("an unmeasured read-only lever reads as absent, not as a mode", () => {
    // Claude: no read-only session mode was measured, so there is nothing to
    // assert and ruling 49's flat deny is the whole enforcement there.
    expect(laneModeFor(PROFILES.claude.laneAssertion, "read-only")).toBeUndefined();
    expect(laneModeFor(PROFILES.claude.laneAssertion, "write")).toBe("default");
    // Negative control on the other branch of laneModeFor.
    expect(laneModeFor(PROFILES.copilot.laneAssertion, "write")).toBeUndefined();
  });

  test("the kind reaches the spawned environment", () => {
    const name = "INITIAL_AGENT_MODE";
    expect(buildEnvironment(PROFILES.codex, { kind: "write" })[name]).toBe("agent");
    expect(buildEnvironment(PROFILES.codex, { kind: "read-only" })[name]).toBe("read-only");
    // Baseline measurement only — never for work.
    expect(buildEnvironment(PROFILES.codex, { kind: "read-only", restrictive: false })[name]).toBe(
      "agent-full-access",
    );
  });
});

describe("ruling 64: TMPDIR is per item", () => {
  test("a supplied tmpDir wins over the inherited one", () => {
    // #41: Codex's sandbox ADDS $TMPDIR to its writable set, so a shared
    // $TMPDIR is a shared writable region between siblings. Pointing it inside
    // the item makes the exemption add nothing.
    const env = buildEnvironment(PROFILES.codex, { tmpDir: "/Users/x/.brigadier/r/a1/3/tmp" });
    expect(env["TMPDIR"]).toBe("/Users/x/.brigadier/r/a1/3/tmp");
  });

  test("without one, the operator's TMPDIR is inherited unchanged", () => {
    // Detection and tests have no item to be inside. Negative control for the
    // branch above.
    const env = buildEnvironment(PROFILES.codex);
    expect(env["TMPDIR"]).toBe(process.env["TMPDIR"]);
  });
});
