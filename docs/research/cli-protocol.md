# Claude Code CLI stdio control protocol — can Rust speak it directly?

Question: the plan ships a ~62 MB bun-compiled Node sidecar whose only job is to run
`@anthropic-ai/claude-agent-sdk`, which spawns the `claude` binary and speaks NDJSON over its
stdio. Could Rust speak that protocol and delete the sidecar?

Inspected: `@anthropic-ai/claude-agent-sdk@0.3.257` (npm, 2026-09-01), local CLI `2.1.257`
(`/Users/stephen/.local/share/claude/versions/2.1.257`, Mach-O arm64, 199,011,264 bytes).

**Citation convention.** `sdk.mjs` ships as one 1.4 MB minified line. Every `sdk.mjs:N` below is a
line in the beautified copy produced by `npx prettier@3 --no-config --parser babel sdk.mjs`.
`sdk.d.ts:N` cites the shipped file verbatim. `claude:strings` cites `strings -n 6` over the CLI
binary.

Prior briefs: `docs/research/t3code.md` (how a production consumer wires the SDK),
`docs/research/long-sessions.md` (session limits). Not repeated here.

---

## 0. Premise correction

The SDK does not bundle the CLI as JavaScript any more — it declares eight platform-native binary
packages as `optionalDependencies` and shells out to them. **[verified: package.json:60-69]**
`manifest.json` pins `version: 2.1.257`, commit `2c673ee`, and a per-platform binary size of
199,011,264 for darwin-arm64 **[verified: manifest.json:1-12]** — byte-identical to the locally
installed `claude`. **[verified: ls of /Users/stephen/.local/share/claude/versions/2.1.257]**
So the sidecar is 62 MB of JS glue *on top of* a ~199 MB binary that ships either way. Deleting the
sidecar saves 62 MB and one runtime, not 260 MB. **[asserted]**

---

## 1. How the SDK spawns the CLI

Class `ProcessTransport`; `initialize()` builds argv, `spawnLocalProcess()` spawns.
**[verified: sdk.mjs:46357, sdk.mjs:46299]**

Base argv, unconditional, in this order: **[verified: sdk.mjs:46398-46404]**

    ["--output-format","stream-json","--verbose","--input-format","stream-json"]

**`--print` / `-p` is never passed.** `grep -c -- '--print' sdk.mjs` = 0.
**[verified: grep over package/sdk.mjs, 0 hits]**
The CLI has a mode predicate keyed on the flag pair instead:
`!e.print && !e.initOnly && e.nonInteractive && !e.hasSdkUrl && e.inputFormat==="stream-json" &&
e.outputFormat==="stream-json"`. **[verified: claude:strings, function `TFn`]**
This is the settled anti-`claude -p` decision holding: the SDK path is *not* headless one-shot mode.

Conditional flags appended, in source order **[verified: sdk.mjs:46405-46495]**:
`--thinking` / `--max-thinking-tokens` / `--thinking-display`, `--effort`, `--max-turns`,
`--max-budget-usd`, `--task-budget`, `--model`, `--agent`, `--betas`, `--json-schema`,
`--debug-file` / `--debug`, `--permission-prompt-tool`, `--continue`, `--resume=<id>`,
`--channels`, `--allowedTools`, `--disallowedTools`, `--tools`, `--mcp-config <json>`,
`--setting-sources=`, `--strict-mcp-config`, `--permission-mode`,
`--allow-dangerously-skip-permissions`, `--fallback-model`, `--include-hook-events`,
`--include-partial-messages`, `--session-mirror`, `--add-dir`, `--plugin-dir` /
`--plugin-dir-no-mcp`, `--fork-session`, `--resume-session-at=`, `--resume-drops-turn=`,
`--session-id=`, `--no-session-persistence`, `--managed-settings`, then arbitrary `extraArgs`.

The permission branch is the load-bearing line: **[verified: sdk.mjs:46441-46442]**

    if (se) { if (S) throw Error(...); Z.push("--permission-prompt-tool", "stdio"); }
    else if (S) Z.push("--permission-prompt-tool", S);

`"stdio"` is a sentinel, not an MCP tool name. See §5.

**`--sdk-url` is not used by this transport** — 0 hits in `sdk.mjs`. It exists in the CLI but only
on the cloud/remote path, alongside `--print`: `[...n,"--print","--sdk-url",Kt,"--input-format",
"stream-json","--output-format",...]`. **[verified: sdk.mjs grep 0 hits; claude:strings]**

Env: `CLAUDE_CODE_ENTRYPOINT` is set to `"sdk-ts"` only if unset; `NODE_OPTIONS` is deleted;
`DEBUG` is set to `"1"` when `DEBUG_CLAUDE_AGENT_SDK` is truthy, otherwise deleted.
Everything else is inherited `process.env`. **[verified: sdk.mjs:46496-46497]**

Executable resolution: if `pathToClaudeCodeExecutable` does **not** end in
`.js|.mjs|.tsx|.ts|.jsx` it is spawned directly as a native binary; otherwise it is passed as
argv[0] to `node`/`bun`. **[verified: sdk.mjs:46836-46838, sdk.mjs:46500-46503]**

Stdio: `stdio: ["pipe","pipe","pipe"]`, `windowsHide: true`, abort forwarded via `signal`.
stderr is *not* protocol — it is drained into a bounded `stderrTail` for error messages and
optionally forwarded to an `options.stderr` callback. **[verified: sdk.mjs:46299-46306]**

Framing: `readline.createInterface({input: stdout})`, one JSON object per line, non-JSON lines
logged and skipped rather than fatal. **[verified: sdk.mjs:46751-46779]**
Writes are `JSON.stringify(msg) + "\n"` to stdin. **[verified: sdk.mjs:47325-47331, sdk.mjs:48035]**

The shipped types state the contract outright: "Everything the CLI writes to its output stream
(stdout in stream-json mode): exactly one StdoutMessage per line, as a single JSON object. Besides
the SDKMessage members this includes the control protocol - control requests the CLI originates,
control responses to the client's requests, cancellations and keep-alives."
**[verified: sdk.d.ts:8294-8296]**

A bare string prompt is written as one frame and stdin is then closed:
`{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":...}]},
"parent_tool_use_id":null}`. **[verified: sdk.mjs:72374-72383, sdk.mjs:48052-48053]**

---

## 2. The control plane

### Envelopes

Request: `{type:"control_request", request_id: string, request: {subtype, ...}}`
**[verified: sdk.d.ts:4271-4278]**
Response: `{type:"control_response", response: {subtype:"success"|"error", request_id, ...}}`
**[verified: sdk.d.ts:4320-4323]**
Success payload: `{subtype:"success", request_id, response?: object, pending_permission_requests?,
pending_user_dialog_requests?}` **[verified: sdk.d.ts:308-326]**
Error payload: `{subtype:"error", request_id, error: string, pending_permission_requests?,
pending_user_dialog_requests?}` **[verified: sdk.d.ts:285-303]**
Withdrawal: `{type:"control_cancel_request", request_id}` **[verified: sdk.d.ts:3524-3530]**
Also on the wire: `{type:"keep_alive"}` (ignored) and `{type:"transcript_mirror", filePath, entries}`.
**[verified: sdk.mjs:47224-47227]**
Correction: two more top-level frames observed live and not listed above: `rate_limit_event` and
`system/thinking_tokens`. **[source: docs/research/claude-direct-spike.md]**

Symmetric: both sides send `control_request` and both answer with exactly one `control_response`
carrying the same `request_id`. **[verified: sdk.d.ts:4268-4270]**
`request_id` from the SDK is `Math.random().toString(36).substring(2,15)` — no ordering or format
requirement. **[verified: sdk.mjs:47803]**
Unmatched inbound `control_response`s are buffered in a capped LRU, so a response may arrive before
its awaiter registers. **[verified: sdk.mjs:47201-47217]**
Duplicate delivery of an in-flight inbound `request_id` is dropped. **[verified: sdk.mjs:47355-47360]**

### CLI → SDK (the SDK must answer these) — 8 subtypes

All dispatched in `processControlRequest`. **[verified: sdk.mjs:47362-47481]**

| subtype | request fields | response |
|---|---|---|
| `can_use_tool` | `tool_name`, `input`, `tool_use_id`, and optional `permission_suggestions`, `blocked_path`, `decision_reason`, `decision_reason_type`, `classifier_approvable`, `suppress_always_allow_rule`, `default_to_no`, `matched_ask_rule{source,tool_name,rule_content?}`, `title`, `display_name`, `description`, `agent_id`, `requires_user_interaction` **[verified: sdk.d.ts:4138-4181]** | `PermissionResult`: `{behavior:"allow", updatedInput?, updatedPermissions?, toolUseID?, decisionClassification?}` or `{behavior:"deny", message, interrupt?, toolUseID?, decisionClassification?}` **[verified: sdk.d.ts:2315-2327]**; returning `null` sends nothing at all **[verified: sdk.mjs:47385]** |
| `hook_callback` | `callback_id`, `input: HookInput`, `tool_use_id?` **[verified: sdk.d.ts:4463-4470]** | whatever the registered callback returns **[verified: sdk.mjs:48083-48087]** |
| `mcp_message` | `server_name`, `message` (JSON-RPC 2.0) **[verified: sdk.d.ts:4095]** | `{mcp_response: <JSON-RPC response>}`; notifications get `{mcp_response:{jsonrpc:"2.0",result:{},id:0}}` **[verified: sdk.mjs:47395-47406]** |
| `elicitation` | `mcp_server_name`, `message`, `mode?`, `url?`, `elicitation_id?`, `requested_schema?`, `title?`, `display_name?`, `description?` **[verified: sdk.d.ts:3535-3555]** | handler result, or `{action:"decline"}` with no handler **[verified: sdk.mjs:47407-47427]** |
| `request_user_dialog` | `dialog_kind` (open string union), `payload`, `tool_use_id?` **[verified: sdk.d.ts:4304-4315]** | handler result; **must stay silent** for a kind not declared in `initialize.supportedDialogKinds` **[verified: sdk.d.ts:4307, sdk.mjs:47428-47449]** |
| `oauth_token_refresh` | — | `{accessToken}` or `{accessToken:null, reason}` **[verified: sdk.mjs:47450-47463]** |
| `host_auth_token_refresh` | — | `{authToken}` **[verified: sdk.mjs:47464-47468]** |
| `remote_control_work_secret` | `session_id` | `{work_secret}` **[verified: sdk.mjs:47469-47479]** |

Anything else: `throw Error("Unsupported control request subtype: " + subtype)`, which the wrapper
turns into a `{subtype:"error"}` response. **[verified: sdk.mjs:47480, sdk.mjs:47336-47340]**

### SDK → CLI — 39 subtypes actually emitted

Complete set from `grep -o 'subtype: "[a-z_]*"' sdk.pretty.mjs`, minus `success`/`error`
(response envelopes) and `mirror_error` (an SDKMessage): **[verified: sdk.mjs, grep]**

`initialize`, `interrupt`, `set_permission_mode`, `set_mcp_permission_mode_override`, `set_model`,
`set_max_thinking_tokens`, `set_cwd`, `get_settings`, `update_settings`, `apply_flag_settings`,
`get_usage`, `get_context_usage`, `read_file`, `seed_read_state`, `rewind_files`,
`cancel_async_message`, `stop_task`, `background_tasks`, `reload_plugins`, `reload_skills`,
`mcp_message`, `mcp_status`, `mcp_set_servers`, `mcp_reconnect`, `mcp_toggle`, `mcp_authenticate`,
`mcp_clear_auth`, `mcp_oauth_callback_url`, `channel_enable`, `claude_authenticate`,
`claude_oauth_callback`, `claude_oauth_wait_for_completion`, `generate_session_title`,
`side_question`, `submit_feedback`, `message_rated`, `ultrareview_launch`, `remote_control`.

The three the harness actually needs:

- `initialize` → `{subtype:"initialize", hooks?, sdkMcpServers?, sdkMcpServerConfigs?, jsonSchema?,
  systemPrompt?: string[], appendSystemPrompt?, planModeInstructions?, systemPromptSnapshot?,
  appendSubagentSystemPrompt?, toolAliases?, excludeDynamicSections?, agents?, title?, skills?,
  webSearchIsolationExemptMcpServers?, promptSuggestions?, agentProgressSummaries?,
  forwardSubagentText?, supportedDialogKinds?, perTaskStopAffordance?}`
  **[verified: sdk.mjs:47516-47542, sdk.d.ts:3915-3970]**
  Correction: `appendSubagentSystemPrompt` and `webSearchIsolationExemptMcpServers` exist only in
  `sdk.mjs`; `SDKControlInitializeRequest` in `sdk.d.ts:3915-3970` does not declare them (0 hits in
  the .d.ts). **[found transcribing crates/claude-wire, 2026-09-02]**
  Response: `{commands, agents, output_style, available_output_styles, models, account,
  hooks_applied?, fast_mode_state?, fast_mode_disabled_reason?}` **[verified: sdk.d.ts:3975-4006]**
- `interrupt` → `{subtype:"interrupt", cancel_queued?}`; response `{still_queued: string[],
  cancelled?: string[]}` **[verified: sdk.d.ts:4011-4032, sdk.mjs:47546-47561]**
- `set_permission_mode` → `{subtype:"set_permission_mode", mode}`, ack only.
  `set_model` → `{subtype:"set_model", model}`, ack only. **[verified: sdk.mjs:47563-47565, 47613-47615]**

Hooks are registered *in* `initialize`: each hook function is assigned an id `hook_<n>` and the
payload sends `{[HookEvent]: [{matcher, hookCallbackIds: string[], timeout?}]}`; the CLI then calls
back with `hook_callback` carrying that id. **[verified: sdk.mjs:47489-47506, sdk.d.ts:4455-4457]**

### Feature detection

`system`/`init` carries `capabilities?: string[]` — "Protocol capabilities this CLI supports, so SDK
consumers can feature-detect instead of version-sniffing. Open set — ignore unknown values."
Named examples: `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `queued_notifications`.
**[verified: sdk.d.ts:5104-5107]** **[docs: https://code.claude.com/docs/en/headless]** (documented
there as requiring CLI v2.1.205+).

---

## 3. Is any of this documented?

No. Zero occurrences of `control_request`, `control_response` or `can_use_tool` anywhere on
docs.claude.com or code.claude.com — CLI reference, headless, streaming-vs-single-mode, agent-sdk
overview, TS reference, and permissions pages all checked.
**[docs: https://code.claude.com/docs/en/cli-reference]**
**[docs: https://code.claude.com/docs/en/headless]**
**[docs: https://code.claude.com/docs/en/agent-sdk/typescript]**
**[docs: https://code.claude.com/docs/en/agent-sdk/permissions]**
What *is* documented is the `stream-json` **output** event format and the SDK's language-level
`canUseTool` callback — never the wire message that backs it. **[docs: as above]**

No stability or versioning statement exists for the control channel. The only adjacent mechanism is
the `capabilities` array above, scoped to session/interrupt behaviors. **[docs: headless]**

The `.d.ts` is, in practice, a shipped protocol spec: every control type carries a prose docstring,
several of them paragraphs long (see `SDKControlInterruptResponse.still_queued`, ~1,200 words).
**[verified: sdk.d.ts:4020-4032]** It is not advertised as one and is not versioned.

**The `.d.ts` union is incomplete — do not treat it as the protocol.** `SDKControlRequestInner`
**[verified: sdk.d.ts:4280]** omits at least `claude_authenticate`, `claude_oauth_callback`,
`claude_oauth_wait_for_completion`, `mcp_authenticate`, `mcp_clear_auth`, `mcp_oauth_callback_url`,
`channel_enable`, `generate_session_title`, `side_question`, `submit_feedback`, `message_rated`,
`ultrareview_launch`, `remote_control`, `set_cwd` — all of which `sdk.mjs` still sends today.
**[verified: sdk.mjs grep vs sdk.d.ts:4280]** `sdk.mjs` is the source of truth; the types are a
curated subset.

### Drift, 0.3.159 (2026-05-31) → 0.3.221 (2026-08-03) → 0.3.257 (2026-09-01)

284 published versions; 49 in the last 60 days (~0.8/day). **[verified: npm view … time --json]**
`claudeCodeVersion` tracks the SDK version 1:1 (`0.3.N` ↔ `2.1.N`) in all three.
**[verified: package.json of each]**
`subtype:` literal set across the whole `.d.ts`: 54 → 67 → 66. 159→221 added 13
(`get_plan`, `get_workspace_diff`, `list_models`, `get_usage`, `register_repo_root`,
`reload_skills`, `control_request_progress`, `commands_changed`, `background_tasks_changed`,
`informational`, `model_refusal_fallback`, `model_refusal_no_fallback`, `worker_shutting_down`),
removed none. 221→257 added `update_settings`, removed `get_plan` and `get_workspace_diff` —
added and pulled within one month. **[verified: diff of the three sdk.d.ts files]**
The apparent "16 request types dropped" from the `SDKControlRequestInner` union between 159 and 221
is a type-curation change, not a protocol removal — `sdk.mjs` in 0.3.257 still sends all of them.
**[verified: sdk.mjs grep]**
`manifest.json.sdkCompat` did not exist in 0.3.159; it appears in 0.3.221 with `harnessSchema: 1`,
unchanged in 0.3.257. `testedWrapperVersions` is a rolling ~12–30-version window, not cumulative.
**[verified: manifest.json of each]**
`--permission-prompt-tool stdio` is byte-identical in all three. **[verified: grep of each sdk.mjs]**
`--resume` changed argv shape: `push("--resume", id)` in 0.3.159 → `push("--resume=" + id)` in
0.3.221/0.3.257. **[verified: sdk.mjs of each]**

Verdict on churn: the long tail moves weekly; the primitives this harness needs (envelope,
`initialize`, `can_use_tool`, `hook_callback`, `mcp_message`, `interrupt`, the argv base, the
`stdio` sentinel) held across three months. **[asserted]**

---

## 4. What the SDK owns beyond framing

A Rust port would have to reimplement each of these.

1. **argv construction** — ~40 option→flag mappings, incl. skills→`Skill(...)` synthesis into
   `--allowedTools` and the `canUseTool` ⊕ `permissionPromptToolName` mutual exclusion.
   **[verified: sdk.mjs:46398-46495]**
2. **Executable resolution** — extension sniff for native-vs-JS, `bun` vs `node` default, musl
   detection on Linux (`process.report.header.glibcVersionRuntime === undefined`), per-platform
   package path lookup. **[verified: sdk.mjs:46836-46838, sdk.mjs:46888-46893, sdk.mjs:46895-46930]**
   (t3code adds its own Windows PATHEXT/`.cmd`-shim resolution on top; see `docs/research/t3code.md`.)
3. **NDJSON framing both directions** + tolerate non-JSON stdout lines.
   **[verified: sdk.mjs:46751-46779]**
4. **Request/response correlation** — pending map, capped LRU for early responses, per-request
   `AbortController` → `control_cancel_request` on abort.
   **[verified: sdk.mjs:47802-47875, sdk.mjs:47824]**
5. **Inbound dispatch + error wrapping** — every handler throw becomes a `{subtype:"error"}`
   response; a second write failure is logged, not raised. **[verified: sdk.mjs:47336-47348]**
6. **`canUseTool` marshalling** — 17 request fields → callback context, `null` → silence,
   `toolUseID` re-attached on the way back. **[verified: sdk.mjs:47363-47387]**
7. **Hook registration + dispatch** — id minting during `initialize`, `hookCallbacks` map, abort
   signal threading. **[verified: sdk.mjs:47489-47506, sdk.mjs:48083-48087]**
8. **In-process MCP bridging** — `createSdkMcpServer` servers are connected over a synthetic
   transport (`JC`) that tunnels JSON-RPC 2.0 through `mcp_message` control frames in both
   directions, with a `pendingMcpResponses` map keyed `serverName:jsonrpcId`.
   **[verified: sdk.mjs:48088-48152]** This is a whole second protocol layer.
9. **Prompt-redelivery replay** — `pending_permission_requests` / `pending_user_dialog_requests` on
   the `initialize` response must be re-dispatched as if they had arrived live; ignoring them on
   non-`initialize` responses. **[verified: sdk.mjs:47790-47801, sdk.d.ts:319-325]**
10. **Process lifecycle** — track child, forward abort, `close()` waits then `SIGTERM`, then
    `SIGKILL` after 5 s (`SIGKILL` only, after 5 s, on win32); stderr `close` and `exit` are joined
    before teardown. **[verified: sdk.mjs:46700-46745]**
11. **Error mapping** — distinct classes: `aborted`, `spawn_failed`, `process_error`,
    `executable_not_found`, `executable_launch_failed`, `process_exited_nonzero`,
    `process_killed_by_signal`, `control_request_failed`, `error_result`; plus a bounded stderr tail
    appended to exit-error messages, and the rule that an error `result` message's text *replaces*
    the exit error. **[verified: sdk.mjs:46524-46590, sdk.mjs:46592-46630, sdk.mjs:47297-47308]**
12. **Stream bookkeeping** — `keep_alive` drop, `transcript_mirror` batching, `commands_changed`
    caching, close stdin on first `result` for single-turn queries.
    **[verified: sdk.mjs:47224-47272]**

---

## 5. The permission-prompt path without the SDK

Two different mechanisms share one flag.

**MCP variant** — documented: "Specify an MCP tool to handle permission prompts in non-interactive
mode", value is an MCP tool name, `-p` only, waits up to `MCP_TIMEOUT` (30 s default) for the
server. **[docs: https://code.claude.com/docs/en/cli-reference]**
The CLI validates it: "tool `<x>` (passed via `--permission-prompt-tool`) must be an MCP tool" and
"MCP tool `<x>` … not found. Available MCP tools: …". **[verified: claude:strings]**
It must return "a single text block param with `type="text"` and a string text value" — the verdict
is JSON encoded inside that text block. **[verified: claude:strings]**
It cannot answer a tool marked `requiresUserInteraction`: "MCP tool requires user interaction; not
supported via `--permission-prompt-tool`" — an `allow` for one is converted to a deny.
**[verified: claude:strings]** **[docs: cli-reference]**
The MCP tool's own input/output JSON contract is **not documented** — open issue
`anthropics/claude-code#24595`. **[docs: https://github.com/anthropics/claude-code/issues/24595]**

**stdio variant** — `--permission-prompt-tool stdio` is a reserved sentinel handled by the CLI
itself, not a tool lookup. The CLI's own guard reads:
`permissionPromptTool: ({permissionPromptTool: w}) => w === "stdio" ? Uo :
to("unsupported", "--permission-prompt-tool (permission prompts reach the host over stdio; an MCP
tool cannot answer them here)")`. **[verified: claude:strings]**
With it set, the CLI emits `{subtype:"can_use_tool", tool_name, display_name, input,
permission_suggestions, blocked_path, decision_reason, decision_reason_type, matched_ask_rule,
tool_use_id, …}` as a `control_request` on stdout and awaits a `control_response`.
**[verified: claude:strings, `this.sendRequest({subtype:"can_use_tool", …})`]**
The flag itself is hidden from `claude --help` — the help string `--permission-prompt-tool <tool>` /
"MCP tool to use for permission prompts (only works with --print)" exists in the binary but is not
printed. **[verified: claude --help output; claude:strings]**

Differences that matter: the stdio path is richer (structured escalation reason, ask-rule
provenance, permission-rule suggestions, `updatedInput`, `updatedPermissions`), needs no MCP server,
has no 30 s connect race, and is the only one that can answer interaction-requiring tools.
**[verified: sdk.d.ts:4138-4181 vs claude:strings]**
So a Rust client wanting real approvals should pass `--permission-prompt-tool stdio` and answer
`can_use_tool` frames — not stand up an MCP server. **[asserted]**

---

## 6. Licence

`package.json` says `"license": "SEE LICENSE IN README.md"`. **[verified: package.json:34]**
`LICENSE.md` in full: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements
outlined here: https://code.claude.com/docs/en/legal-and-compliance."
**[verified: package/LICENSE.md]**

Relevant clauses, verbatim:

- "**The Claude Code binary must not be modified.** Claude Code must be installed and run as
  published by Anthropic, and customers may not remove, disable, or restrict any authentication
  method built into it…" **[docs: https://code.claude.com/docs/en/legal-and-compliance]**
- "**Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf.**"
  **[docs: same]**
- "Anthropic does not permit third-party developers to offer Claude.ai login into their own
  applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their
  users… developers may not collect, store, or intermediate Claude.ai credentials or session
  tokens." **[docs: same]**
- Commercial ToS §D.4: "Customer may not and must not attempt to (a) access the Services to build a
  competing product or service, including to train competing AI models or resell the Services except
  as expressly approved by Anthropic; (b) reverse engineer or duplicate the Services; or (c) support
  any third party's attempt at any of the conduct restricted in this sentence."
  **[docs: https://www.anthropic.com/legal/commercial-terms]**
- Usage Policy prohibits "Intentionally bypass[ing] capabilities, restrictions, or guardrails
  established within our products…" **[docs: https://www.anthropic.com/legal/aup]**

**No clause names the stdio protocol, non-SDK clients, or programmatic invocation of the binary.**
**[docs: all of the above]**
Spawning an unmodified `claude`, under the end user's own credentials, and speaking its stdio
protocol is not addressed either way by the quoted text; the live constraints are (a) don't modify
or repackage the binary, (b) don't intermediate credentials or resell usage, (c) "reverse engineer
or duplicate the Services" in §D.4 is the clause a hostile reading would reach for, and reading
`sdk.d.ts` — a file Anthropic ships as public API surface — is a weak fit for it. **[asserted]**
This is an engineering read, not legal advice. **[asserted]**
Consumer ToS not fetched. **[asserted]**

---

## 7. Estimate — Rust port vs the 62 MB sidecar

Everything in this section is an **estimate**, not a measurement. **[asserted]**

Scope for parity with what the harness needs — spawn, stream-json both ways, `initialize`,
`can_use_tool`, `interrupt`, hooks, resume/fork:

| Piece | Est. lines of Rust |
|---|---|
| argv builder (~40 options) | 150 |
| executable resolution + platform/musl | 80 |
| NDJSON codec over tokio child stdio | 80 |
| envelope types + serde (`serde_json::Value` for payload bodies) | 150 |
| request/response correlation, cancel, keep-alive, LRU | 180 |
| `initialize` req/resp + capability parse | 90 |
| `can_use_tool` + `PermissionResult` + `PermissionUpdate` | 140 |
| hook registration + `hook_callback` dispatch + `HookInput` types | 250 |
| `interrupt`, `set_permission_mode`, `set_model`, `set_cwd` | 70 |
| process lifecycle (SIGTERM→SIGKILL, stderr tail, exit join) | 160 |
| error taxonomy + result-text override | 110 |
| typed SDKMessage stream (init/assistant/user/result/partial; rest as `Value`) | 250 |
| **subtotal** | **~1,700** |
| in-process MCP bridging over `mcp_message` (only if `createSdkMcpServer` equivalents are wanted) | +500 |
| `elicitation`, `request_user_dialog`, OAuth refresh subtypes | +250 |

So **~1,700 lines for the core, ~2,400 with the optional layers** — one focused week, plus a
conformance-test harness. **[estimate]**

Maintenance risk, honestly stated. Against it: undocumented, unversioned, no stability promise, and
`sdk.d.ts` is provably an incomplete view of the wire. Near-daily releases; two subtypes were added
and removed within a single month. For it: the specific surface the harness needs did not change
across three months and 98 releases; the `.d.ts` is richly annotated and machine-diffable, so a CI
job that re-packs the SDK and diffs the control types is a real early-warning system; `capabilities`
on `system`/`init` gives runtime feature detection; and the CLI binary is pinned by path anyway, so
drift only arrives when *you* upgrade. The sidecar does not remove this risk — it relocates it into
a component that Anthropic updates on the same cadence and that must itself be re-tested per
release. **[estimate]**

---

## Recommendation

*My recommendation.* Delete the sidecar and speak the protocol from Rust: the surface the harness
actually needs is roughly 1,700 lines, it held stable across three months of near-daily SDK
releases, and `--permission-prompt-tool stdio` gives real `can_use_tool` approvals without any MCP
server — which is the whole reason the sidecar exists. Treat `sdk.mjs`, not `sdk.d.ts`, as the
protocol source of truth, pin the `claude` binary by path, and add a CI job that re-packs the SDK
on each CLI bump and diffs the control types so drift shows up as a red build rather than a field
bug. Keep the sidecar running behind a flag only until the Rust path has demonstrated
`can_use_tool`, hook dispatch and `--resume` against a real session.

## Not checked

- Nothing was executed against the CLI beyond `--version` and `--help`; no session was started, so
  every wire claim is read from source or from the binary's string table, never observed on a live
  socket.
- No Rust code written; the LOC table is an estimate with no prototype behind it.
- `bridge.mjs` (1.4 MB) and `browser-sdk.js` (1.4 MB) not read — the WebSocket/SSE transports and
  the browser entry point may carry protocol details this brief misses.
- `HookInput` / `HookOutput` variant shapes not enumerated (there are ~20 hook events); only the
  `hook_callback` envelope was verified.
- The CLI's own parsing of inbound frames was read only through string-table fragments; the exact
  validation and rejection behavior for malformed control requests is unverified.
- Consumer Terms of Service not fetched.
- Whether the 62 MB sidecar figure is accurate for our build — taken from the brief, not measured.
- No comparison against t3code's `ClaudeAdapter.ts` at the wire level; that file consumes the SDK's
  TypeScript API, so it observes none of this protocol directly.
