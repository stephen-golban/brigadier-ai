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
import { WORKER_MARKER } from "./marker.ts";

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

/**
 * WHERE ruling 38's run marker goes in this profile's argv.
 *
 * Ruling 38 requires the marker to be in the command line of every process
 * brigadier causes to exist, and that requirement is unchanged. What was wrong
 * was treating the PLACEMENT as a constant: `spawnMarkedAgent` appended a bare
 * `--brigadier-run=<run>/<item>` to every profile, and a vendor that validates
 * its options rejects it and never starts.
 *
 * MEASURED on 2026-08-20 against Copilot 1.0.80, Qwen 0.21.13, Gemini 0.55.1
 * and opencode 1.18.18, macOS 26.5.2 arm64, load1 3.16–4.31. An ACP server
 * reading a closed stdin exits 0, so `exit 0` here means the argv was accepted
 * and the process started; `exit 1` is a parse refusal before any protocol:
 *
 *   copilot --acp --brigadier-run=X          exit 1  unknown option
 *   copilot --acp -- --brigadier-run=X       exit 1  unknown option
 *   copilot --acp --name '<marker>'          exit 0  ACCEPTED
 *   copilot --acp --session-id X             exit 1  cannot be used with --acp
 *   qwen/gemini/opencode  bare marker        exit 1  unknown argument
 *   qwen/gemini/opencode  after `--`         exit 0  ACCEPTED
 *
 * So three vendors need a `--` terminator and Copilot needs a flag to carry the
 * marker as a value. This is the field that says which.
 *
 * THE COST, stated rather than discovered: this is one more per-vendor
 * measured coordinate in the table this file's header calls a standing hazard,
 * and it goes stale the same way the others do — a vendor that removes `--name`
 * or starts validating after `--` breaks the spawn, loudly, at the handshake.
 * `bar/items/14-marker-argv-contract.ts` is the leg that catches that.
 */
export type MarkerPlacement =
  /** Appended bare. For bridged agents, whose launcher forwards unknown argv. */
  | { kind: "append" }
  /** After a `--` terminator, as a positional the vendor's parser stops reading. */
  | { kind: "after-terminator" }
  /**
   * As the VALUE of a flag the vendor already accepts.
   *
   * Ruling 38 says the marker must be the command line and never a name
   * pattern. That constraint is about MATCHING — the sweep greps argv for a
   * token brigadier put there, rather than guessing from a program name like
   * `pgrep node`. Carrying the token in a flag's value keeps the sweep's
   * matcher exactly as it was: `src/run/marker.ts`'s regex anchors on
   * whitespace, so `--name --brigadier-run=r/1` matches unchanged and no sweep
   * code needs to know this placement exists.
   */
  | { kind: "flag-value"; flag: string };

export interface LaunchProfile {
  id: AgentId;
  /** Display name, as the agent reports itself at `initialize`. */
  name: string;
  /** Argv. A bridged agent runs through npx; a native one is its own binary. */
  command: string;
  args: string[];
  /** Ruling 38's marker placement, per vendor. Measured, never assumed. */
  markerPlacement: MarkerPlacement;
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
  /**
   * Can this agent reach the public web with its own tool? Ruling 78's column.
   *
   * **A launch-profile fact, NOT a ruling 53 capability**, and the distinction is
   * the ruling. Ruling 53's vocabulary is three permanent terms and it fenced
   * against a fourth deliberately; web reach could not be one anyway, because on
   * Codex it is not a property the agent has or lacks — it is an argv flag
   * brigadier passes (`--search`), and a boolean requirement cannot pass a flag.
   * So it sits here beside `emitsUsage` and `modelsAtSessionNew`: measured facts
   * about a vendor, each carrying what measured it.
   *
   * **Absent means UNMEASURED, which does not satisfy.** Ruling 53's rule,
   * unchanged: a `research` item refuses on an agent whose reach is unmeasured,
   * and the refusal says *unmeasured on this agent* rather than *unsupported*,
   * because those need different remedies.
   *
   * **What this measures is an UPPER BOUND on what a worker gets.** It was taken
   * against each vendor's own CLI, not through the ACP session a worker actually
   * receives. If the CLI cannot reach the web the worker certainly cannot; the
   * converse does not follow, and ruling 53 is explicit that conflating the agent
   * process with the worker's shell *"is exactly the research-in-measurement's-
   * clothes error"*. The ACP-channel measurement is separate and has not been
   * taken.
   */
  reachesWeb?: boolean;
  /** Anything a caller would otherwise have to learn the hard way. */
  caveats: string[];
}

export const PROFILES: Record<AgentId, LaunchProfile> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    // Bridged: npx forwards unrecognised argv to the bridge, which ignores it.
    // The verifier's 2026-08-20 real-fleet drive reached `session/prompt` on
    // this profile, so the appended marker is measured not to block startup.
    markerPlacement: { kind: "append" },
    bridged: true,
    // RE-MEASURED 2026-08-20 against `@agentclientprotocol/claude-agent-acp
    // 0.70.0` / `claude 2.1.237`, EVERY FIELD, because ruling 69 makes this
    // string mean "every field below was measured against this". The bridge had
    // moved to 0.70.0 while the profile still said 0.69.0, and ruling 69 grades
    // the `laneAssertion` drift BLOCKING — which had stopped all write work on
    // this vendor, leaving the machine one vendor short of cross-vendor review.
    //
    // The measurement, frame by frame, from one handshake + `session/new` +
    // `session/set_mode` (free) and ONE prompt turn on the operator's own
    // authenticated session (bar item 14's path, not the metered one):
    //
    //   agentInfo.version    "0.70.0", name `@agentclientprotocol/claude-agent-acp`
    //   laneAssertion        `session/new` still answers `currentModeId:
    //                        "bypassPermissions"`, `availableModes` still offers
    //                        `default`, and `session/set_mode {modeId:"default"}`
    //                        returned `{}` AND the agent echoed a
    //                        `config_option_update` with `currentValue:
    //                        "default"`. Confirmed by the echo, not merely by the
    //                        absence of an error.
    //   commandExecution     STILL TRUE, and observed rather than inferred: the
    //                        turn produced a `tool_call` with `kind: "execute"`,
    //                        `toolName: "Bash"`, `status: "completed"`.
    //   modelsAtSessionNew   still false — `session/new` returned no
    //                        `models`/`availableModels` envelope of either shape.
    //   emitsUsage           CHANGED. See the field below.
    //
    // NOT SETTLED BY THIS MEASUREMENT, and recorded rather than glossed: in mode
    // `default` the Bash call above completed with ZERO
    // `session/request_permission` frames. That mode describes itself as
    // "prompts for dangerous operations", and `echo` is not one, so this is
    // CONSISTENT with the mode working as documented and is NOT evidence of a
    // hole. What would settle it is the same turn driving an operation the mode
    // calls dangerous, which this measurement did not do. Written down because
    // an unasked-for `execute` is the exact shape ruling 43 and #3 are about,
    // and because "still unexplained" beats a second plausible story.
    measuredVersion: "0.70.0 (claude 2.1.237)",
    passthroughEnv: ["ANTHROPIC_MODEL", "MAX_THINKING_TOKENS", "CLAUDE_CODE_EXECUTABLE"],
    // The CLI and the BRIDGE behave differently here, and the difference is the
    // reason this note exists rather than the one first written in its place.
    //
    // MEASURED against claude 2.1.233 on 2026-08-20, with a negative control:
    //   CLAUDE_CONFIG_DIR=<empty dir> claude -p 'say ok' -> exit 1 "Not logged in"
    //   (no redirect)                 claude -p 'say ok' -> exit 0 "ok"
    // and the credential is in the macOS Keychain, not in the root being
    // redirected (`security find-generic-password -s "Claude Code-credentials"`
    // succeeds; copying `~/.claude.json` into the redirected root did NOT
    // restore login).
    //
    // That is the CLI. It is NOT this profile: MEASURED the same day against
    // `@agentclientprotocol/claude-agent-acp` 0.70.0 through `detectOne` under a
    // worker-shaped config root, this profile reported `usable` — handshake AND
    // session — so the bridge keeps its authentication across the redirect.
    //
    // Recorded because the inference ran the other way first. "The redirect logs
    // every worker out" was generalised from the CLI and from Codex, and the
    // measurement refused it. It is therefore NOT established that the redirect
    // caused the verifier's 2026-08-20 Claude failure
    // (`session/prompt: -32000 Authentication required`); that failure is still
    // unexplained, and saying so is cheaper than a second wrong cause.
    configRootEnv: "CLAUDE_CONFIG_DIR",
    // #3, #50: sends an `execute` permission request, so it runs commands.
    // networkAccess unmeasured — not false, and it does not satisfy.
    capabilities: { commandExecution: true },
    // MEASURED 2026-08-21 against `claude 2.1.238`: it returned the exact
    // `dist.shasum` of bun's current npm release, matching an independent
    // `curl`, and separately fetched a loopback URL with the request observed in
    // that server's OWN access log — evidence independent of what the model
    // said. Control fires: asked for the same value from memory with no tool it
    // answered UNKNOWN, so a match proves retrieval rather than recall.
    reachesWeb: true,
    // The bridge opens sessions in `bypassPermissions`, which routes every write
    // around the client. The lane means nothing until this is set back (#3).
    // No read-only session mode was measured on this bridge, so there is no
    // `readOnly` value to name. Ruling 49's flat `deny` is the whole
    // enforcement for a read-only item here.
    laneAssertion: { kind: "session-mode", write: "default" },
    modelsAtSessionNew: false,
    // WAS `false`, and that was measured FALSE on 2026-08-20 against 0.70.0.
    // One prompt turn produced SIX `session/update/usage_update` frames and a
    // turn carrying `{used: 25122, size: 1000000, cost: {amount: 0.1156,
    // currency: "USD"}}`. So the bridge now reports tokens, a context size AND a
    // money cost. Ruling 69 grades this field a `note`, which means nothing
    // would ever have gone red for it — it was found by re-measuring the fields
    // rather than by anything failing.
    emitsUsage: true,
    caveats: [
      "Opens in bypassPermissions — the lane MUST be asserted or it is not enforced (#3).",
      "MAX_THINKING_TOKENS is a switch, not a dial: 0 disables thinking, any non-zero value behaves alike (ruling 40).",
      "CLAUDE_CODE_EXECUTABLE is load-bearing under bun --compile: the bridge resolves the agent via import.meta.resolve, which fails inside /$bunfs/ (ruling 44).",
      // #15's finding, CORRECTED by re-measurement on 2026-08-20 rather than
      // left standing: it was true of the bridge #15 measured and is false of
      // 0.70.0. Ruling 62 (f) — a comment contradicting its cited fact is a
      // fail, not advisory.
      "Usage, context size AND a USD cost DO reach ACP as of bridge 0.70.0 (MEASURED 2026-08-20: six `usage_update` frames, `cost.amount` in USD). This REVERSES #15, which measured none of it reaching ACP.",
    ],
  },

  codex: {
    id: "codex",
    name: "Codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    // Bridged, as above. Codex's 2026-08-20 failure was CODEX_CONFIG, not argv.
    markerPlacement: { kind: "append" },
    bridged: true,
    measuredVersion: "1.4.0 (codex-cli 0.147.0)",
    passthroughEnv: ["CODEX_PATH"],
    // CORRECTED 2026-08-20. This field held `CODEX_CONFIG`, which is NOT a
    // config root and never was — the coordinate was wrong, which is the exact
    // hazard this file's header names.
    //
    // MEASURED against `@agentclientprotocol/codex-acp` 1.6.2: `CODEX_CONFIG`
    // is "a JSON object merged into the Codex session config" (README line 54),
    // read at `dist/index.js:32869` as
    // `const config2 = configString ? JSON.parse(configString) : void 0`.
    // Handing it a DIRECTORY PATH makes the bridge throw
    // `SyntaxError: Unexpected token '/'` before `initialize` — the verifier's
    // 2026-08-20 finding V3, reproduced against the installed bridge. The
    // bridge reads eight environment variables and `CODEX_HOME` is not among
    // them, so it has no config-root lever of its own.
    //
    // MEASURED against codex-cli 0.147.0 on 2026-08-20, with a negative
    // control, because the redirect has to work on the binary the bridge
    // spawns rather than on the bridge:
    //   CODEX_HOME=<empty dir> codex login status  -> exit 1 "Not logged in"
    //   (no CODEX_HOME)        codex login status  -> exit 0 "Logged in using ChatGPT"
    // and the redirected root was written into, so the variable is honoured.
    //
    // WHAT THAT COSTS, and it is a ruling-57 question rather than a bug: a
    // redirected config root logs the worker OUT, because the credential lives
    // in the root being redirected. Seeding `auth.json` alone into the
    // redirected root restored login (exit 0, measured). The same is NOT true
    // of Claude — see `CLAUDE_CONFIG_DIR` above. Nothing here seeds anything;
    // that decision is the owner's and is raised in `RULING-38-AMENDMENT.md`.
    configRootEnv: "CODEX_HOME",
    // #3: sends an `execute` request. #41: ruling 49's `write` mode is
    // `agent`, which blocks ALL network at the OS level — so these two differ
    // in the same session, which is exactly findings 70 and 71's asymmetry.
    capabilities: { commandExecution: true, networkAccess: false },
    // reachesWeb UNMEASURED: this agent is not authenticated on the machine the
    // 2026-08-21 sweep ran on, so its web reach could not be driven at all. That
    // is a fact about the measurement and not about the vendor, and under ruling
    // 53 unmeasured does not satisfy — a `research` item refuses here and says
    // *unmeasured on this agent* rather than *unsupported*.
    // Codex additionally needs an ARGV FLAG for live results: MEASURED that
    // `codex --search` exists — "Enable live web search. When enabled, the native
    // Responses `web_search` tool is available" — with a firing control (`--web-search`
    // and an invented flag are both rejected rc=2). Its built-in default is a CACHED
    // mode returning pre-indexed snippets, which is exactly what D22's dated-finding
    // rule exists to defeat. This is the concrete reason web reach is a launch-profile
    // fact and not a ruling 53 capability: a boolean requirement cannot pass a flag.
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
    // MEASURED against copilot 1.0.80 on 2026-08-20: the ONLY vendor in the
    // fleet that rejects the marker both bare AND after `--`. `--name` takes it
    // as a value (exit 0) and `--session-id` is refused alongside `--acp`.
    markerPlacement: { kind: "flag-value", flag: "--name" },
    bridged: false,
    measuredVersion: "1.0.80",
    passthroughEnv: [],
    // MEASURED against `copilot 1.0.80` on 2026-08-18: COPILOT_HOME is a real
    // process.env read AND a real config root. An ACP `initialize` under a
    // redirected COPILOT_HOME wrote config.json and logs/ into that directory;
    // the negative control (same handshake, variable unset) wrote nothing there.
    // Ruling 57 recorded Copilot as UNESTABLISHED for a config-root redirect;
    // this establishes it, so the lever exists on 5 of 6 vendors, not 4.
    // Gemini remains the sole vendor with none (#42: GEMINI_DIR is an internal
    // constant with zero env reads), so decision 17 cannot hold there.
    configRootEnv: "COPILOT_HOME",
    // #50: `execute` requests carry a meaningful title. Network unmeasured.
    capabilities: { commandExecution: true },
    // MEASURED 2026-08-21 against `copilot 1.0.80`: it returned the exact
    // `dist.shasum` of bun's current npm release, matching an independent
    // `curl`. Same control as claude's row, and it fires.
    //
    // **It refuses LOOPBACK, and finding that out is why this column is not a
    // localhost probe.** `web_fetch` answered
    // `WebFetchBlockedUrlError: web_fetch URL "http://127.0.0.1:…" resolves to
    // blocked` — ordinary SSRF protection. A probe that only served a token on
    // 127.0.0.1 would have recorded `false` here for a vendor that reaches the
    // public web perfectly well, which is a wrong table row produced by a sound-
    // looking measurement.
    reachesWeb: true,
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
    // MEASURED against qwen 0.21.13 on 2026-08-20: bare marker exits 1
    // ("Unknown arguments: brigadier-run"), after `--` exits 0.
    markerPlacement: { kind: "after-terminator" },
    bridged: false,
    measuredVersion: "0.21.13",
    passthroughEnv: [],
    configRootEnv: "QWEN_HOME",
    // Ruling 53: unmeasured is not permission. Qwen never issues a permission
    // request at all (#50), so nothing here has been observed either way.
    capabilities: {},
    // reachesWeb UNMEASURED: this agent is not authenticated on the machine the
    // 2026-08-21 sweep ran on, so its web reach could not be driven at all. That
    // is a fact about the measurement and not about the vendor, and under ruling
    // 53 unmeasured does not satisfy — a `research` item refuses here and says
    // *unmeasured on this agent* rather than *unsupported*.
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
    // MEASURED against opencode 1.18.18 on 2026-08-20: bare marker exits 1 and
    // prints subcommand help; after `--` exits 0.
    markerPlacement: { kind: "after-terminator" },
    bridged: false,
    measuredVersion: "1.18.18",
    passthroughEnv: [],
    configRootEnv: "OPENCODE_CONFIG_DIR",
    // #50: it ran `printf > ~/...` and reported exit 0. #42 proves the AGENT
    // PROCESS reaches a network gateway; that says nothing about the worker's
    // shell, and conflating the two would be research in measurement's clothes.
    capabilities: { commandExecution: true },
    // MEASURED 2026-08-21 against `OpenCode 1.18.18`: it returned the exact
    // `dist.shasum` of bun's current npm release, matching an independent
    // `curl`, and fetched a loopback URL with the request observed in that
    // server's own access log. Same control as claude's row, and it fires.
    reachesWeb: true,
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
    // MEASURED against gemini 0.55.1 on 2026-08-20: bare marker exits 1
    // ("Unknown arguments"), after `--` exits 0.
    markerPlacement: { kind: "after-terminator" },
    bridged: false,
    measuredVersion: "0.55.1",
    passthroughEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    // Unmeasured on both terms. #42 could not even establish its config root.
    capabilities: {},
    // reachesWeb UNMEASURED: this agent is not authenticated on the machine the
    // 2026-08-21 sweep ran on, so its web reach could not be driven at all. That
    // is a fact about the measurement and not about the vendor, and under ruling
    // 53 unmeasured does not satisfy — a `research` item refuses here and says
    // *unmeasured on this agent* rather than *unsupported*.
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
 * The full argv for one marked spawn, with ruling 38's marker where THIS
 * profile was measured to accept it.
 *
 * Kept beside the table rather than in `src/queue/spawn.ts` because it is a
 * property of the vendor, not of spawning: the same placement has to be
 * reproducible by anything that wants to predict what brigadier will run —
 * `bar/items/14-marker-argv-contract.ts` drives exactly this shape against the
 * real binaries, and item 7's sweep documentation quotes it.
 */
export function markedArgv(profile: LaunchProfile, marker: string): string[] {
  const placement = profile.markerPlacement;
  switch (placement.kind) {
    case "append":
      return [profile.command, ...profile.args, marker];
    case "after-terminator":
      return [profile.command, ...profile.args, "--", marker];
    case "flag-value":
      return [profile.command, ...profile.args, placement.flag, marker];
  }
}

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
    /**
     * Ruling 64. Per item, inside the item's own directory — see below. Omitted
     * only by detection and by tests, which have no item to be inside.
     */
    tmpDir?: string;
    /** False only for baseline measurement. Never for work. */
    restrictive?: boolean;
    extra?: Record<string, string>;
  } = {},
): Record<string, string> {
  const source = process.env;
  const env: Record<string, string> = {};

  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM"]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }

  // TMPDIR is deliberately NOT inherited. Ruling 64: #41 measured the Codex ACP
  // bridge building its sandbox with `excludeTmpdirEnvVar: false`, which ADDS
  // $TMPDIR to the writable set — and that is how a worker poisoned a sibling
  // clone's tracked file. Pointing TMPDIR inside the item's own directory makes
  // that exemption add nothing, because the exempted region IS the item's own
  // region and was writable anyway.
  //
  // Half a fix, and recorded as half: `/tmp` stays exempted regardless
  // (`excludeSlashTmp: false`), so ruling 61's placement — run directories
  // outside every temp root — is still what keeps the clones out of reach.
  // Neither is sufficient alone.
  if (options.tmpDir) env["TMPDIR"] = options.tmpDir;
  else if (source["TMPDIR"] !== undefined) env["TMPDIR"] = source["TMPDIR"];
  if (process.platform === "win32") {
    for (const key of ["SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "PATHEXT", "COMSPEC"]) {
      const value = source[key];
      if (value !== undefined) env[key] = value;
    }
  }

  // Ruling 57. Set on every worker, unconditionally, before anything
  // vendor-specific — this is the only universal mechanism keeping brigadier's
  // own plugin inert inside a worker session.
  env[WORKER_MARKER] = "1";

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

/**
 * May a `research` item route to this agent? Ruling 78, and ruling 53's rule
 * about unmeasured things applied to a column rather than to a capability.
 *
 * **Absent is not false.** The three states are *measured true*, *measured
 * false*, and *never driven*, and only the first is eligible. Collapsing the
 * last two into "no" would make a refusal say the wrong thing: an unmeasured
 * agent needs somebody to run a probe, and a measured-false one needs a
 * different vendor. Ruling 53 makes that distinction explicit — the refusal says
 * *unmeasured on this agent* rather than *unsupported* — because those need
 * different remedies.
 */
export function reachesWeb(agent: AgentId): boolean | undefined {
  return PROFILES[agent].reachesWeb;
}

/**
 * Why a `research` item cannot go to this agent, or nothing when it can.
 *
 * D22's dated-finding rule is what makes this refuse rather than degrade: a
 * research finding must say when it was measured, and an agent that cannot reach
 * today's web can only produce a finding dated from its training. That is the
 * exact staleness the work kind exists to defeat — models reaching for 2024 and
 * 2025 when it is 2026 — so routing there and hoping is worse than refusing.
 */
export function researchRefusal(agent: AgentId): string | undefined {
  const reach = PROFILES[agent].reachesWeb;
  if (reach === true) return undefined;
  if (reach === false) {
    return `${agent} was measured unable to reach the web, so it cannot produce a dated finding (D22).`;
  }
  return (
    `${agent}'s web reach is UNMEASURED, and unmeasured is not permission (ruling 53). ` +
    "Nobody has driven it — that is a gap in what we know, not a fact about the vendor."
  );
}
