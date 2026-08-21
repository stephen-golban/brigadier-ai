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
import type { WorkKind } from "../work/kind.ts";

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
export function laneFailureBlocks(profile: LaunchProfile, kind: WorkKind): boolean {
  // `write` and nothing else, and since ruling 78 that is three kinds it is
  // false for rather than one. A `plan` or `research` worker's directory is
  // never diffed, merged or read back, so a failed vendor-mode assertion there
  // costs nothing the flat `deny` lane was not already covering.
  return kind === "write" && profile.laneAssertion.kind !== "none";
}

/**
 * What a session just contradicted about its own profile.
 *
 * The other half of ruling 69, and the half that needs no history: a version
 * comparison catches a table that has gone stale against a NUMBER, but a bridge
 * can be replaced under the same version and take a measured behaviour with it.
 * `modelsAtSessionNew: true` says models were MEASURED to arrive (#2), so a
 * session that returns none is a discrepancy checkable inside a single run, with
 * nothing to remember between runs.
 *
 * Graded `warn` rather than `note`. The `note` grade above is about the FLAG
 * going stale — that is harmless because the list is observed fresh every run.
 * This is the observed contradiction, and it has a consequence: ruling 55's
 * second retry rung is `same-vendor-different-model`, and on a single-vendor
 * machine that rung is reachable only because Codex returns its 33
 * effort-bearing model ids. An empty list silently shortens every ladder there.
 * It is not `blocking`, because blocking is reserved for the one axis that
 * loses containment silently, and routing badly is not losing containment.
 */
export interface SessionObservation {
  /** Model ids read back at `session/new`. Never constructed — see profiles.ts. */
  models: readonly string[];
}

export function sessionContradictions(profile: LaunchProfile, observed: SessionObservation): Drift[] {
  if (!profile.modelsAtSessionNew || observed.models.length > 0) return [];
  return [
    {
      field: "modelsAtSessionNew",
      severity: "warn",
      measuredAgainst: profile.measuredVersion,
      observed: "session/new returned no model ids",
      why: "the profile was measured with a model list arriving here (#2); without one, ruling 55's second retry rung (same-vendor-different-model) silently disappears from every ladder on this machine",
    },
  ];
}

/**
 * Why a drift produced nothing blocking — said out loud rather than left to be
 * inferred from an absence.
 *
 * A reader handed a `warn` and nothing else cannot tell whether the blocking
 * axis was checked and found clean or never existed on this vendor, and those
 * are two different facts about their machine. Four of six profiles declare no
 * lane lever at all (copilot, qwen, opencode, gemini), so on this fleet the
 * common case is the one that most needs saying.
 *
 * `undefined` when something blocking DID fire: `driftFor` has already emitted
 * that entry with its own reason, and printing both would be saying it twice.
 */
export function noBlockingReason(profile: LaunchProfile, drift: readonly Drift[]): string | undefined {
  if (drift.some((d) => d.severity === "blocking")) return undefined;
  return profile.laneAssertion.kind === "none"
    ? `lane assertion — none declared for ${profile.id}: no spawn-time lever was measured, so there is nothing here to go stale and nothing BLOCKS. Where a vendor declares one, a drifted lane assertion blocks every write item.`
    : `lane assertion — declared for ${profile.id} and not among what drifted here, so nothing BLOCKS. A drifted lane assertion blocks every write item.`;
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

/**
 * Read overrides out of the operator's own config, strictly.
 *
 * Takes the text rather than a path so that the file read stays in the CLI and
 * this stays a total function of its input — which is also what makes the
 * rejection cases testable without a filesystem.
 *
 * Every rejection is REPORTED rather than dropped. An override an operator
 * wrote and brigadier silently ignored is the worst of the three outcomes: they
 * believe their fixed bridge is in use, and the coordinate actually running is
 * the one in the table.
 */
export function parseOverrides(json: string): { overrides: BridgeOverride[]; problems: string[] } {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { overrides: [], problems: [`bridge overrides are not valid JSON: ${String(error)}`] };
  }
  if (!Array.isArray(parsed)) {
    return { overrides: [], problems: ["bridge overrides must be a JSON array of {agent, command, args}"] };
  }

  const overrides: BridgeOverride[] = [];
  for (const [index, raw] of parsed.entries()) {
    const entry = raw as { agent?: unknown; command?: unknown; args?: unknown } | null;
    const args = entry?.args ?? [];
    if (typeof entry?.agent !== "string" || typeof entry.command !== "string") {
      problems.push(`bridge override ${index} needs a string \`agent\` and a string \`command\``);
      continue;
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      problems.push(`bridge override for ${entry.agent}: \`args\` must be an array of strings`);
      continue;
    }
    overrides.push({ agent: entry.agent, command: entry.command, args: args as string[] });
  }
  return { overrides, problems };
}

/**
 * The override applied to a profile — the coordinate only.
 *
 * `measuredVersion` is deliberately left alone. It is the record of what was
 * measured and against what, and rewriting it to say "unverified" would destroy
 * the one fact drift grading compares against. The invalidation is announced by
 * `overrideWarning` instead, which is where an operator will read it.
 */
export function applyOverride(profile: LaunchProfile, overrides: readonly BridgeOverride[]): LaunchProfile {
  const override = overrides.find((o) => o.agent === profile.id);
  return override ? { ...profile, command: override.command, args: [...override.args] } : profile;
}
