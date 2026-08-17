// SPDX-License-Identifier: Apache-2.0
/**
 * The launch-profile table.
 *
 * Decision 2 is "one ACP transport plus a declarative launch-profile table",
 * and this is the table. Every field here was MEASURED against a running binary
 * on 2026-08-17 (macOS 26.5.2 arm64) — see the ticket cited on each entry.
 *
 * Two standing hazards this file exists to hold at bay:
 *
 *   Stale coordinates. Three of six coordinates in circulation were wrong when
 *   #2 checked, and four more when #45 did. A stale one fails as a HANG or a
 *   4.5 KB stub, not an error: `@zed-industries/codex-acp` is a stub at 0.16.0
 *   while the live package is `@agentclientprotocol/codex-acp`. Never copy a
 *   coordinate from documentation.
 *
 *   Invented levers. The map once carried `CLAUDE_ACP_MODEL`,
 *   `CLAUDE_ACP_ALLOWED_TOOLS`, `CLAUDE_ACP_MAX_TURNS`, `CLAUDE_ACP_TIMEOUT`
 *   and `CLAUDE_ACP_SKIP_PERMISSIONS` as the Claude launch profile. All five
 *   have ZERO occurrences in the shipped bridge. Every variable named below was
 *   confirmed as a real `process.env` read.
 */

import type { WorkKind } from "../work/kind.ts";
import type { Capabilities } from "../work/requires.ts";

export type AgentId = "claude" | "codex" | "copilot" | "qwen" | "opencode" | "gemini";

/**
 * How, if at all, the permission lane can be asserted before the first turn.
 *
 * The restrictive mode is PER WORK KIND, and that is ruling 49 correcting a
 * constant this file already shipped. Codex's single restrictive value was
 * `INITIAL_AGENT_MODE=read-only`, which #41 measured as blocking writes at the
 * OS level — correct for a `read-only` item and fatal for a `write` one, where
 * every Codex worker would have been sandboxed out of doing its job and the
 * failure would have looked like a bad agent rather than a bad constant. The
 * `write` mode is `agent`: out-of-`cwd` writes and all network blocked, work
 * inside the clone permitted (#41).
 *
 * `readOnly` is absent where no vendor lever for it was measured. Absent means
 * absent — the enforcement there is brigadier's own flat `deny` and nothing
 * else, which is exactly what ruling 49 says out loud.
 */
export type LaneAssertion =
  /** An env var pins the mode at spawn. */
  | { kind: "env"; name: string; permissive: string; write: string; readOnly?: string }
  /** `session/set_mode` after `session/new`. */
  | { kind: "session-mode"; write: string; readOnly?: string }
  /** No spawn-time lever measured; the agent decides for itself. */
  | { kind: "none" };

/** The mode to assert for this kind, or undefined when the vendor offers none. */
export function laneModeFor(assertion: LaneAssertion, kind: WorkKind): string | undefined {
  if (assertion.kind === "none") return undefined;
  return kind === "read-only" ? assertion.readOnly : assertion.write;
}

export interface LaunchProfile {
  id: AgentId;
  /** Display name, as the agent reports itself at `initialize`. */
  name: string;
  /** Argv. A bridged agent runs through npx; a native one is its own binary. */
  command: string;
  args: string[];
  /** True when the agent is reached through a vendored ACP bridge. */
  bridged: boolean;
  /** The version this profile was measured against. Never assume it still holds. */
  measuredVersion: string;
  /** Environment variables to forward from the operator's environment, if set. */
  passthroughEnv: string[];
  /** Where this agent keeps its config root — decision 17's suppression lever. */
  configRootEnv?: string;
  laneAssertion: LaneAssertion;
  /**
   * Ruling 53's brigadier-defined half of the requirement vocabulary.
   *
   * A key is present ONLY where it was measured, and an absent key means
   * unmeasured — which does not satisfy a requirement. `imageInput` is
   * deliberately never here: it is read from ACP's
   * `promptCapabilities.image` at the handshake, and no term exists in
   * both places.
   *
   * This table is mostly empty today. That is the finding, not an
   * embarrassment: filling it is measurement work nobody has scheduled.
   */
  capabilities: Capabilities;
  /** Does `session/new` return a model list we can route over? (#2, ruling 40.) */
  modelsAtSessionNew: boolean;
  /** Does the agent emit `usage_update` over ACP? (#46 — three of six do.) */
  emitsUsage: boolean;
  /** Anything a caller would otherwise have to learn the hard way. */
  caveats: string[];
}

export const PROFILES: Record<AgentId, LaunchProfile> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    bridged: true,
    measuredVersion: "0.69.0 (claude 2.1.233)",
    passthroughEnv: ["ANTHROPIC_MODEL", "MAX_THINKING_TOKENS", "CLAUDE_CODE_EXECUTABLE"],
    configRootEnv: "CLAUDE_CONFIG_DIR",
    // #3, #50: sends an `execute` permission request, so it runs commands.
    // networkAccess unmeasured — not false, and it does not satisfy.
    capabilities: { commandExecution: true },
    // The bridge opens sessions in `bypassPermissions`, which routes every write
    // around the client. The lane means nothing until this is set back (#3).
    // No read-only session mode was measured on this bridge, so there is no
    // `readOnly` value to name. Ruling 49's flat `deny` is the whole
    // enforcement for a read-only item here.
    laneAssertion: { kind: "session-mode", write: "default" },
    modelsAtSessionNew: false,
    emitsUsage: false,
    caveats: [
      "Opens in bypassPermissions — the lane MUST be asserted or it is not enforced (#3).",
      "MAX_THINKING_TOKENS is a switch, not a dial: 0 disables thinking, any non-zero value behaves alike (ruling 40).",
      "CLAUDE_CODE_EXECUTABLE is load-bearing under bun --compile: the bridge resolves the agent via import.meta.resolve, which fails inside /$bunfs/ (ruling 44).",
      "No usage, quota or cost data reaches ACP (#15).",
    ],
  },

  codex: {
    id: "codex",
    name: "Codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    bridged: true,
    measuredVersion: "1.4.0 (codex-cli 0.147.0)",
    passthroughEnv: ["CODEX_PATH"],
    configRootEnv: "CODEX_CONFIG",
    // #3: sends an `execute` request. #41: ruling 49's `write` mode is
    // `agent`, which blocks ALL network at the OS level — so these two differ
    // in the same session, which is exactly findings 70 and 71's asymmetry.
    capabilities: { commandExecution: true, networkAccess: false },
    laneAssertion: {
      kind: "env",
      name: "INITIAL_AGENT_MODE",
      // `agent` blocks out-of-cwd writes and all network at the OS level while
      // permitting work inside the clone; `read-only` blocks writes outright
      // (#41). Ruling 49: one value cannot serve both kinds.
      write: "agent",
      readOnly: "read-only",
      permissive: "agent-full-access",
    },
    modelsAtSessionNew: true,
    emitsUsage: false,
    caveats: [
      "Permission payloads carry NOTHING — no title, no locations, no rawInput (#3). The lane can only refuse what it cannot place.",
      "An OS sandbox is real in every mode, but an APPROVED permission runs outside it (ruling 43).",
      "workspace-write permits /tmp and $TMPDIR by design — run directories must live elsewhere or workers are not isolated from each other (#49).",
      "Whether it asks for permission at all is non-deterministic: 2 of 4 identical runs asked (ruling 43).",
      "Model ids encode effort as a suffix, e.g. gpt-5.6-sol[high]. Read them from availableModels; never construct one.",
      "Pre-flight quota is readable out of band via `codex app-server` account/rateLimits/read (#46).",
    ],
  },

  copilot: {
    id: "copilot",
    name: "GitHub Copilot",
    command: "copilot",
    args: ["--acp"],
    bridged: false,
    measuredVersion: "1.0.80",
    passthroughEnv: [],
    // #50: `execute` requests carry a meaningful title. Network unmeasured.
    capabilities: { commandExecution: true },
    laneAssertion: { kind: "none" },
    modelsAtSessionNew: false,
    emitsUsage: true,
    caveats: [
      "Best-behaved lane measured: edit requests carry a full path, a title and rawInput.fileName (#50).",
      "Has its OWN trusted-directory gate and asks before leaving cwd, unprompted by us (#50).",
      "The only agent using ACP's canonical session-mode URIs rather than vendor strings.",
      "Emits usage_update {used, size} — window 128,000 (#46).",
      "/usage is session-scoped spend, NOT remaining quota.",
    ],
  },

  qwen: {
    id: "qwen",
    name: "Qwen Code",
    command: "qwen",
    args: ["--acp"],
    bridged: false,
    measuredVersion: "0.21.13",
    passthroughEnv: [],
    configRootEnv: "QWEN_HOME",
    // Ruling 53: unmeasured is not permission. Qwen never issues a permission
    // request at all (#50), so nothing here has been observed either way.
    capabilities: {},
    laneAssertion: { kind: "none" },
    modelsAtSessionNew: false,
    emitsUsage: true,
    caveats: [
      "NEVER issues a permission request — zero in every run. Enforcement is its own `auto` mode policy and is invisible to ACP (#50).",
      "Safe despite that: it blocked an out-of-cwd write itself. An agent can be safe while giving brigadier no lane.",
      "Compaction is announced only as ENGLISH PROSE in an agent_message_chunk — no structured event (#47).",
      "Compaction is a treadmill once over threshold: fires every turn, recovers ~15%, latency 5.8s -> 65.6s (#47).",
      "usage_update `used` PLATEAUS while compacting — a flat line is not a stable context (#47).",
      "Window is 1,000,000 tokens; the documented chatCompression.contextPercentageThreshold key is REMOVED, use context.autoCompactThreshold.",
      "Does NOT auto-discover ~/.agents/skills — the lone measured counterexample (#26).",
    ],
  },

  opencode: {
    id: "opencode",
    name: "opencode",
    command: "opencode",
    args: ["acp"],
    bridged: false,
    measuredVersion: "1.18.18",
    passthroughEnv: [],
    configRootEnv: "OPENCODE_CONFIG_DIR",
    // #50: it ran `printf > ~/...` and reported exit 0. #42 proves the AGENT
    // PROCESS reaches a network gateway; that says nothing about the worker's
    // shell, and conflating the two would be research in measurement's clothes.
    capabilities: { commandExecution: true },
    laneAssertion: { kind: "none" },
    modelsAtSessionNew: false,
    emitsUsage: true,
    caveats: [
      "HIGHEST RISK of the fleet, on two independent axes (#42, #50).",
      "NO boundary of any kind for execute-class work: no permission request, no cwd policy, no sandbox. It ran `printf > ~/...` and reported exit 0 (#50).",
      "Its file-EDIT tool does route through permissions, so the gap is per-tool-class.",
      "Reaches a model with NO credential at all, via its own gateway (providerID=opencode, model big-pickle) — so a successful turn proves nothing about which account is billed (#42).",
      "Emits usage_update WITH a cost object — the only agent measured to do so. Window 200,000 (#46).",
      "Declares no session modes, so there is no ACP-visible lever to restrict it.",
    ],
  },

  gemini: {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    args: ["--acp"],
    bridged: false,
    measuredVersion: "0.55.1",
    passthroughEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    // Unmeasured on both terms. #42 could not even establish its config root.
    capabilities: {},
    laneAssertion: { kind: "none" },
    modelsAtSessionNew: false,
    emitsUsage: false,
    caveats: [
      "OAuth is DEAD for individual accounts: session/new fails -32000 'This client is no longer supported for Gemini Code Assist for individuals'.",
      "Needs BOTH an API key in the spawned environment AND security.auth.selectedType='gemini-api-key' in ~/.gemini/settings.json.",
      "Does NOT read ~/.gemini/.env in ACP mode, despite its own interactive path documenting that file — the key must be in the process environment (#42).",
      "No config-root env var found: GEMINI_DIR is an internal constant with zero env reads (#42).",
      "Google Antigravity is NOT a substitute — it does not speak ACP at all (#45).",
    ],
  },
};

export const ALL_AGENT_IDS = Object.keys(PROFILES) as AgentId[];

/**
 * Build the environment a worker is spawned with.
 *
 * Decision 17 suppresses user-global ambient instruction files by default, and
 * the mechanism is pointing the agent's config root somewhere brigadier owns.
 * The minimal environment is deliberately small — but not empty:
 *
 * **`USER` is required.** v1 measured that every Claude worker fails with
 * `Not logged in` without it, `LOGNAME` does not substitute, and it was found
 * only by bisecting the real binary. #4 reproduced it exactly. `HOME` and
 * `PATH` are equally load-bearing and equally boring.
 */
export function buildEnvironment(
  profile: LaunchProfile,
  options: {
    configRoot?: string;
    /** Ruling 49: the mode asserted depends on the kind, not on a single flag. */
    kind?: WorkKind;
    /** False only for baseline measurement. Never for work. */
    restrictive?: boolean;
    extra?: Record<string, string>;
  } = {},
): Record<string, string> {
  const source = process.env;
  const env: Record<string, string> = {};

  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM"]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  if (process.platform === "win32") {
    for (const key of ["SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "PATHEXT", "COMSPEC"]) {
      const value = source[key];
      if (value !== undefined) env[key] = value;
    }
  }

  for (const key of profile.passthroughEnv) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }

  if (options.configRoot && profile.configRootEnv) {
    env[profile.configRootEnv] = options.configRoot;
  }

  const assertion = profile.laneAssertion;
  if (assertion.kind === "env") {
    const restrictive = laneModeFor(assertion, options.kind ?? "write");
    env[assertion.name] =
      options.restrictive === false ? assertion.permissive : (restrictive ?? assertion.write);
  }

  // Colour codes in a protocol stream are noise at best.
  env["NO_COLOR"] = "1";

  return { ...env, ...(options.extra ?? {}) };
}
