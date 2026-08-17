// SPDX-License-Identifier: Apache-2.0
/**
 * What a work item may declare that it requires.
 *
 * Ruling 53. This ticket (#28) asked whether the vocabulary should come from
 * ACP's own capability names or from a brigadier-defined set, and framed it as
 * portable-but-coarse against accurate-but-another-table.
 *
 * It is not a trade-off. MEASURED against copilot 1.0.80, qwen-code 0.21.13,
 * OpenCode 1.18.18 and gemini-cli 0.55.1 on macOS 26.5.2 on 2026-08-17
 * (probes/acp-handshake.ts), `agentCapabilities` carries exactly:
 *
 *   loadSession, mcpCapabilities{http,sse},
 *   promptCapabilities{image,audio,embeddedContext},
 *   sessionCapabilities{close,fork,list,resume}
 *
 * Every one of those is about what may be put INTO a prompt or done to a
 * session. Not one describes what an agent can do in a repository — no command
 * execution, no network, no create-versus-edit, no context-window size, on four
 * agents of four implementing the same schema. So v1's finding 70 (a plan could
 * not say "this item must be able to run commands") is NOT closed by the
 * handshake, and the repository-facing vocabulary has to be ours.
 *
 * The rule that keeps the split from rotting: a term is read from ACP if and
 * only if ACP has a field for it, and NO TERM EXISTS IN BOTH PLACES.
 * Duplication is how a table goes stale, and profiles.ts already carries this
 * project's stalest-fact risk.
 */

/**
 * Three terms. Deliberately three — #28's own words are "keep it small, every
 * term is permanent", and two candidates were rejected on the record:
 *
 *   fileCreation vs edit-only — no measured agent lacks it. A permanent term
 *   for an unobserved distinction is how a vocabulary ends up with four terms
 *   of which one is the one people need.
 *
 *   minContextWindowTokens — #46 measured windows only through
 *   `usage_update.size`, and the two agents that emit nothing are the two
 *   BRIDGED ones, Claude and Codex. A requirement that cannot be evaluated on
 *   the most-used half of the fleet either eliminates those vendors (finding
 *   87's empty eligible set, by construction) or is vacuous for them (finding
 *   71's mis-route, by construction) — both of v1's failures out of one term.
 *   The window is still RECORDED where it is observable, for reporting and for
 *   #24's cost model. It may not be required.
 */
export type Requirement =
  /** The worker must be able to run commands. Finding 70's missing term. */
  | "commandExecution"
  /**
   * The worker's commands must reach the network.
   *
   * Separate from commandExecution because on Codex they differ IN THE SAME
   * SESSION: #41 measured `agent` mode blocking all network at the OS level,
   * and ruling 49 makes `agent` the mode brigadier asserts for every Codex
   * `write` item. v1 recorded "Codex workers ran with network disabled
   * unconditionally"; it still holds, and it is now our own doing.
   */
  | "networkAccess"
  /**
   * The prompt will carry an image.
   *
   * The only term ACP genuinely carries, so it is READ from
   * `agentCapabilities.promptCapabilities.image` and never written into
   * profiles.ts. It is the one of v1's four terms that survives, and it
   * survives by being delegated rather than kept.
   */
  | "imageInput";

export const ALL_REQUIREMENTS: Requirement[] = [
  "commandExecution",
  "networkAccess",
  "imageInput",
];

/** Where the truth for a term lives. There is deliberately no third option. */
export const REQUIREMENT_SOURCE: Record<Requirement, "profile" | "handshake"> = {
  commandExecution: "profile",
  networkAccess: "profile",
  imageInput: "handshake",
};

/**
 * What an agent is known to support.
 *
 * `undefined` means UNMEASURED, and unmeasured is not permission — not `false`,
 * not `true`. It does not satisfy a requirement, and the refusal says
 * "unmeasured on this agent" rather than "unsupported", because those need
 * different remedies. This is ruling 49's lane rule one layer up: refuse what
 * you cannot place.
 */
export type Capabilities = Partial<Record<Requirement, boolean>>;

export type Satisfaction = "satisfied" | "unsupported" | "unmeasured";

export function satisfies(capabilities: Capabilities, requirement: Requirement): Satisfaction {
  const value = capabilities[requirement];
  if (value === undefined) return "unmeasured";
  return value ? "satisfied" : "unsupported";
}

export interface Eligibility {
  eligible: boolean;
  /** Per requirement, why. Carried into the refusal so it names a remedy, not arithmetic. */
  reasons: Array<{ requirement: Requirement; satisfaction: Satisfaction }>;
}

/**
 * Is this agent eligible for an item with these requirements?
 *
 * Ruling 53: the refusal names the remedy, not the arithmetic. v1's
 * `ROUTING_FAILED — 11 model(s) were eliminated` is arithmetic; which term
 * failed on which agent, and whether it failed because the agent cannot or
 * because nobody has measured it, is a remedy.
 */
export function eligibleFor(
  capabilities: Capabilities,
  requirements: readonly Requirement[],
): Eligibility {
  const reasons = requirements.map((requirement) => ({
    requirement,
    satisfaction: satisfies(capabilities, requirement),
  }));
  return { eligible: reasons.every((r) => r.satisfaction === "satisfied"), reasons };
}
