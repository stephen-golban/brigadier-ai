// SPDX-License-Identifier: Apache-2.0
/**
 * What happens when an agent moves underneath a measured table.
 *
 * Ruling 69. Three tables in this design go stale silently as the world moves —
 * the launch-profile table, the competence table, and the vendored bridges —
 * and none of them fails loudly.
 *
 * MEASURED against copilot 1.0.80, qwen-code 0.21.13, OpenCode 1.18.18 and
 * gemini-cli 0.55.1 on 2026-08-17: **every one returned `protocolVersion: 1`**.
 * So the handshake's protocol version cannot discriminate anything and is
 * useless as a drift signal. The agent's own `agentInfo.version` is the signal,
 * and it is present on all four.
 *
 * Refusing to run on a version change is not available: agents auto-update, and
 * a product that stops working after every vendor release is not a product. So
 * drift is GRADED BY WHAT IT CAN SILENTLY BREAK, which is the only axis that
 * distinguishes "your table is out of date" from "your containment is gone".
 */

import type { LaunchProfile } from "./profiles.ts";

export type DriftSeverity =
  /**
   * The lane assertion. If this silently stops working the containment is gone
   * and NOTHING goes red — #3 measured the Claude bridge opening sessions in
   * `bypassPermissions`, so an unasserted lane there is no lane at all.
   */
  | "blocking"
  /**
   * Capabilities (ruling 53). A stale `commandExecution` costs an empty diff —
   * v1's finding 71 — which is expensive and visible, not silent and dangerous.
   */
  | "warn"
  /** `emitsUsage`, `modelsAtSessionNew`. Observed fresh every run anyway. */
  | "note";

export interface Drift {
  field: string;
  severity: DriftSeverity;
  measuredAgainst: string;
  observed: string;
  why: string;
}

/**
 * What is now unverified, given the version the agent actually reported.
 *
 * `measuredVersion` is what makes this computable at all: every field in a
 * profile is implicitly "measured against `measuredVersion`", which is why
 * AGENTS.md requires "MEASURED against <tool> <version>" rather than the
 * present tense. v1 watched codex-cli move 0.145.0 → 0.147.0 mid-project, which
 * made every present-tense claim stale while every "MEASURED against 0.145.0"
 * claim stayed true forever.
 */
export function driftFor(profile: LaunchProfile, observedVersion: string): Drift[] {
  if (observedVersion === "unknown" || profile.measuredVersion.includes(observedVersion)) return [];

  const drift: Drift[] = [
    {
      field: "capabilities",
      severity: "warn",
      measuredAgainst: profile.measuredVersion,
      observed: observedVersion,
      why: "a stale capability costs an empty diff (finding 71) — expensive and visible, not silent",
    },
  ];

  if (profile.laneAssertion.kind !== "none") {
    drift.push({
      field: "laneAssertion",
      severity: "blocking",
      measuredAgainst: profile.measuredVersion,
      observed: observedVersion,
      why: "if the lane assertion silently stops working the containment is gone and nothing goes red",
    });
  }
  return drift;
}

/**
 * Ruling 69's tightening of an existing behaviour.
 *
 * `Worker` records `laneAsserted: false` when a vendor offers a restrictive mode
 * and it could not be set, and until now that was "recorded, and the caller can
 * decide". This decides: **for a `write` item on a vendor whose profile declares
 * a lane assertion, a failed assertion BLOCKS.**
 *
 * Because #3 measured the Claude bridge opening in `bypassPermissions` — every
 * write routed around the client — so a `write` worker whose lane did not
 * assert is a worker with no lane, and ruling 32's standing rule says a weakened
 * check never renders as a pass.
 *
 * A `read-only` item does not block on it: ruling 49 gives it a flat `deny` lane
 * that needs no vendor cooperation, which is exactly why that ruling defined the
 * kind the way it did.
 */
export function laneFailureBlocks(profile: LaunchProfile, kind: "write" | "read-only"): boolean {
  return kind === "write" && profile.laneAssertion.kind !== "none";
}

/**
 * Ruling 69's answer to "how does an owner get a fixed bridge without waiting
 * for a brigadier release" — the ticket asks for an answer, not a shrug.
 *
 * A per-machine config key overrides an agent's bridge coordinate. Per-machine
 * and never per-repo: ruling 37's principle is that capability comes from the
 * human and never from data, and a repository choosing which binary brigadier
 * executes is the same class of attack as a repository supplying a verify
 * command.
 *
 * And it is loud, because an overridden bridge invalidates every measured fact
 * about that agent. The operator chose it, so the operator gets the
 * consequences — stated rather than discovered.
 */
export interface BridgeOverride {
  agent: string;
  command: string;
  args: string[];
}

export function overrideWarning(override: BridgeOverride): string {
  return `${override.agent}: bridge overridden to \`${override.command} ${override.args.join(" ")}\` — every measured fact in its launch profile is now unverified`;
}
