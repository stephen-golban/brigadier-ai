# `@anthropic-ai/claude-agent-sdk` — current public API

Verified against **0.3.257** (published 2026-09-01), installed into a scratchpad, never into the repo.

Sources, in order of trust:
- **`.d.ts`** — `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (8,687 lines) and `package.json`.
  Line numbers below are for that file at 0.3.257. Re-resolve after a version bump.
- **`sdk.mjs`** — shipped bundle (1.5 MB, minified). Cited by function name, not line.
- **docs** — `code.claude.com/docs/en/agent-sdk/*` (`docs.claude.com` and `platform.claude.com`
  301/307 to it).
- **GitHub** — `anthropics/claude-agent-sdk-typescript` releases + `CHANGELOG.md`.

Companions: `long-sessions.md` (compaction, caching, rate limits, long-horizon patterns) and
`t3code.md` (how one shipping product wires this SDK). Not repeated here.

---

## 1. Version, bundled CLI, version handshake

- Latest published: **0.3.257**; `dist-tags` `latest` and `next` both point at it. **[verified]** `npm view`
- `package.json` carries a top-level `"claudeCodeVersion": "2.1.257"`. **[verified in package.json]**
- The SDK **ships its own native CLI binary**, not `@anthropic-ai/claude-code`. Eight
  `optionalDependencies`, all pinned to the exact SDK version: `claude-agent-sdk-{linux,darwin,win32}-{x64,arm64}`
  (+ `-musl` for linux). **[verified in package.json]**
- On darwin-arm64 that package is a single 199 MB `claude` executable; running it prints
  `2.1.257 (Claude Code)`. **[verified]**
- Version rule: **SDK patch == bundled Claude Code patch.** CHANGELOG entries are literally
  "Updated to parity with Claude Code v2.1.NNN". A feature needing CLI v2.1.222 needs SDK v0.3.222+. **[docs + CHANGELOG]**
- No pin *enforcement*: `pathToClaudeCodeExecutable` is taken verbatim, spawned, no version check
  before or after. **[verified in sdk.mjs `DL`/`qC.initialize`]**
- Missing native dep throws at `query()` construction:
  `Native CLI binary for <platform>-<arch> not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.` **[verified in sdk.mjs `DL`]**
- **The handshake is `system/init`, and it is capability-based, not version-based.**
  `SDKSystemMessage` (sdk.d.ts:5057) carries `claude_code_version: string` and
  `capabilities?: string[]` — "so SDK consumers can feature-detect instead of version-sniffing.
  Open set — ignore unknown values." Known values today: `interrupt_receipt_v1`,
  `interrupt_cancel_queued_v1`, `queued_notifications`. **[verified in .d.ts]**
- Mismatched CLI: the SDK sends control requests the old CLI does not know; the CLI answers
  `Unsupported control request subtype: <x>`, and newer response fields are simply absent
  (documented per-field as "absent on CLIs that predate the field"). Degradation is per-feature,
  not a hard failure. **[verified in .d.ts field docs + sdk.mjs error string]**
- The SDK always sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts` and `CLAUDE_AGENT_SDK_VERSION=0.3.257` in the
  child env. **[verified in sdk.mjs `DL`]**

## 2. `query()` and the `Query` object

```ts
function query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query
interface Query extends AsyncGenerator<SDKMessage, void> { ... }
```
sdk.d.ts:2913, 2577. **[verified in .d.ts]**

- The CLI is **always** spawned as
  `--output-format stream-json --verbose --input-format stream-json`. The string-prompt form is not
  a different wire mode; it just writes one user frame and later closes stdin.
  **[verified in sdk.mjs `qC.initialize`]**
- `LL()`: string prompt → one `{type:'user', session_id:'', message:{role:'user',content:[{type:'text',text}]}, parent_tool_use_id:null}` line.
  AsyncIterable → `Query.streamInput(iterable)`. **[verified in sdk.mjs `LL`]**
- Minimum `SDKUserMessage` for a turn: `{ type:'user', message: MessageParam, parent_tool_use_id: null }`.
  `uuid` and `session_id` are optional (sdk.d.ts:5267). Docs' canonical example yields exactly those
  three fields. **[verified in .d.ts + docs]**
- Notable optional `SDKUserMessage` fields: `uuid` (your client id; echoed back as
  `user_message_uuid` on the first reply frame and on the `result`), `priority: 'now'|'next'|'later'`,
  `shouldQuery: false` (append to transcript without triggering a turn), `isSynthetic`. **[verified in .d.ts]**
- **Follow-up turns** = yield another `SDKUserMessage` from the same iterable. There is no
  `send()`/`submit()` method. `Query.streamInput(stream)` exists on the interface (sdk.d.ts, "Used
  internally") and can be called with a second stream. **[verified in .d.ts]**
- **Ending input**: when the iterable completes, `streamInput` waits for the first `result` (only if
  `hasBidirectionalNeeds()` — hooks / canUseTool / SDK MCP / elicitation / onUserDialog are wired),
  then calls `transport.endInput()` → `stdin.end()`. So an infinite generator that never returns keeps
  the session open; returning from it ends the session. **[verified in sdk.mjs `Gy.streamInput`]**
- Gotcha: **if your generator throws, the stream surfaces `Claude Code process aborted by user`**, not
  your error. **[docs, streaming-vs-single-mode; consistent with sdk.mjs `Ky()`]**
- Gotcha: a **single-message** `query()` *throws* after yielding an error `result`. **[docs]**

`Query` methods present at 0.3.257 (all sdk.d.ts:2577–2911) — the header says control requests are
"only supported when streaming input/output is used", i.e. stdin must stay open:

| Method | Signature |
|---|---|
| `interrupt` | `(): Promise<SDKControlInterruptResponse \| undefined>` |
| `setPermissionMode` | `(mode: PermissionMode): Promise<void>` |
| `setMcpPermissionModeOverride` | `(serverName: string, mode: 'default'\|'auto'\|null): Promise<{warning?: string}>` |
| `setModel` | `(model?: string): Promise<void>` |
| `setMaxThinkingTokens` | `(n: number\|null, thinkingDisplay?: 'summarized'\|'omitted'\|null): Promise<void>` — **deprecated**, use `thinking` |
| `applyFlagSettings` | `(settings: {[K in keyof Settings]?: ...\|null}): Promise<void>` |
| `updateSettings` | `(source: 'localSettings', settings: Record<string,unknown>): Promise<void>` — allowlist is `outputStyle` only |
| `initializationResult` | `(): Promise<SDKControlInitializeResponse>` (cached first-connect result) |
| `reinitialize` | `(): Promise<SDKControlInitializeResponse>` (fresh request; re-registers hooks; redelivers parked `can_use_tool`) |
| `supportedCommands` | `(): Promise<SlashCommand[]>` |
| `supportedModels` | `(): Promise<ModelInfo[]>` |
| `supportedAgents` | `(): Promise<AgentInfo[]>` |
| `mcpServerStatus` | `(): Promise<McpServerStatus[]>` |
| `getContextUsage` | `(opts?: {detail?: 'summary'\|'full'}): Promise<SDKControlGetContextUsageResponse>` — default `'full'`; `'summary'` avoids per-category token-count API calls (new in 0.3.257) |
| `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` | `(): Promise<SDKControlGetUsageResponse>` — session cost + plan rate-limit windows |
| `readFile` | `(path: string, opts?: {maxBytes?: number; encoding?: 'utf-8'\|'base64'}): Promise<SDKControlReadFileResponse \| null>` |
| `reloadPlugins` / `reloadSkills` | `(): Promise<SDKControlReload*Response>` |
| `accountInfo` | `(): Promise<AccountInfo>` |
| `rewindFiles` | `(userMessageId: string, opts?: {dryRun?: boolean}): Promise<RewindFilesResult>` — needs `enableFileCheckpointing` |
| `seedReadState` | `(path: string, mtime: number): Promise<void>` |
| `reconnectMcpServer` / `toggleMcpServer` | `(serverName, [enabled]): Promise<void>` |
| `setMcpServers` | `(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>` |
| `streamInput` | `(stream: AsyncIterable<SDKUserMessage>): Promise<void>` |
| `stopTask` | `(taskId: string): Promise<void>` |
| `backgroundTasks` | `(toolUseId?: string): Promise<boolean>` (Ctrl+B equivalent) |
| `close` | `(): void` |

- **Undeclared runtime arg**: the implementation is `async interrupt(e)` and honours
  `e.cancelQueued === true` → sends `cancel_queued: true`. The `.d.ts` declares `interrupt()` with no
  parameters. Cancelling queued turns therefore needs a cast today. **[verified in sdk.mjs `Gy.interrupt` vs .d.ts:2591]**
- `startup(params?: {options?: Options; initializeTimeoutMs?: number}): Promise<WarmQuery>` pre-spawns
  and completes the initialize handshake; `WarmQuery.query(prompt)` can be called **once**
  (sdk.d.ts:8288, 8656). Default `initializeTimeoutMs` 60000. **[verified in .d.ts + sdk.mjs]**

## 3. `canUseTool`

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal
    suggestions?: PermissionUpdate[]
    blockedPath?: string
    decisionReason?: string
    title?: string          // full rendered prompt sentence, e.g. "Claude wants to read foo.txt"
    displayName?: string    // short noun phrase, e.g. "Read file"
    description?: string
    toolUseID: string
    agentID?: string        // set when the call comes from a subagent
    requestId: string       // control_request envelope id
    matchedAskRule?: { source: string; toolName: string; ruleContent?: string }
  }
) => Promise<PermissionResult | null>
```
sdk.d.ts:209. **[verified in .d.ts]**

```ts
type PermissionResult =
  | { behavior:'allow'; updatedInput?: Record<string,unknown>; updatedPermissions?: PermissionUpdate[]; toolUseID?: string; decisionClassification?: PermissionDecisionClassification }
  | { behavior:'deny';  message: string; interrupt?: boolean;  toolUseID?: string; decisionClassification?: PermissionDecisionClassification }
```
sdk.d.ts:2315. `PermissionDecisionClassification = 'user_temporary'|'user_permanent'|'user_reject'` (:2275). **[verified in .d.ts]**

- Returning **`null`** means "I already sent the `control_response` out-of-band echoing `requestId`".
  Fail-closed: an accidental `null` blocks the tool **forever** — permission prompts have no park
  deadline. **[verified in .d.ts:195]**
- `PermissionUpdate` (sdk.d.ts:2334) variants: `addRules` | `replaceRules` | `removeRules`
  (`rules: {toolName, ruleContent?}[]`, `behavior: 'allow'|'deny'|'ask'`), `setMode`,
  `addDirectories`, `removeDirectories`. All carry
  `destination: 'userSettings'|'projectSettings'|'localSettings'|'session'|'cliArg'`. The `suggestions`
  passed in are the exact set to echo back as `updatedPermissions` for an "always allow" button. **[verified in .d.ts]**
- Wiring: `canUseTool` set → the SDK appends **`--permission-prompt-tool stdio`**. Setting both
  `canUseTool` and `permissionPromptToolName` throws
  `canUseTool callback cannot be used with permissionPromptToolName. Please use one or the other.` **[verified in sdk.mjs `qC.initialize`]**
- **It fires in both prompt forms** (the wire is always `--input-format stream-json`), but the
  streaming-input form is what keeps the process alive long enough to answer and to use the other
  control methods. **[verified in sdk.mjs; t3code drives it exactly this way — see `t3code.md`]**
- **Precedence (docs, "How permissions are evaluated"):** hooks → deny rules → ask rules →
  permission mode → allow rules → `canUseTool`. Auto-approved calls **never** reach the callback. **[docs]**
- Always reaches the callback regardless of allow rules: `AskUserQuestion`, MCP tools with
  `_meta["anthropic/requiresUserInteraction"]`, org-`ask` connector tools, and `rm`/`rmdir` on
  critical paths. In `dontAsk` these are denied instead and the callback is never called. **[docs]**
- The SDK emits a one-shot `process.emitWarning` with code **`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`**
  when `permissionMode:'bypassPermissions'` or when `allowedTools` contains a **bare** name (no
  `(...)` specifier). Allow rules from settings files are invisible to this check. **[verified in sdk.mjs `NZ`/`zKe`]**
- To gate *every* call regardless of mode and rules, the documented answer is a **`PreToolUse` hook**,
  not `canUseTool`. **[docs + the warning text itself]**

## 4. Hooks

`hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>` (sdk.d.ts:1396ff).
`interface HookCallbackMatcher { matcher?: string; hooks: HookCallback[]; timeout?: number /* seconds */ }` (:866).
`type HookCallback = (input: HookInput, toolUseID: string | undefined, options: {signal: AbortSignal}) => Promise<HookJSONOutput>` (:859). **[verified in .d.ts]**

`HOOK_EVENTS` (sdk.d.ts:854) — **33 events**, exhaustive: **[verified in .d.ts]**

`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`,
`UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`,
`SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`,
`PermissionRequest`, `PermissionDenied`, `Setup`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`,
`Elicitation`, `ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`,
`InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`, `MessageDisplay`.

Return type is `AsyncHookJSONOutput | SyncHookJSONOutput`:
- `AsyncHookJSONOutput` (:129) — `{ async: true; asyncTimeout?: number }`; agent proceeds immediately.
- `SyncHookJSONOutput` (:8373) — `{ continue?: boolean; suppressOutput?: boolean; stopReason?: string;
  decision?: 'approve'|'block'; systemMessage?: string; terminalSequence?: string; reason?: string;
  hookSpecificOutput?: ... }`. `{}` = allow unchanged. **[verified in .d.ts]**
- Conflict resolution across hooks/rules: `deny` > `defer` > `ask` > `allow`. **[docs]**

`hookSpecificOutput` exists for only 22 of the 33 events (sdk.d.ts:8373 union). The ones the adapter
will use:

| Event | Input (beyond `BaseHookInput`) | Output |
|---|---|---|
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` | `permissionDecision?: 'allow'\|'deny'\|'ask'\|'defer'`, `permissionDecisionReason?`, `updatedInput?`, `additionalContext?` |
| `PostToolUse` | tool name/input/response | `additionalContext?`, `updatedToolOutput?`, `classifierContext?` (TS, 0.3.236+) |
| `UserPromptSubmit` | `prompt`, `source?: 'user'\|'sdk'\|'system'\|'loop_wakeup'\|'schedule_wakeup'\|'poll_event'`, `session_title?` | `additionalContext?`, `sessionTitle?`, `suppressOriginalPrompt?` |
| `SessionStart` | `source: 'startup'\|'resume'\|'clear'\|'compact'\|'fork'`, `model?`, `session_title?`, `seconds_since_last_response?`, `context_tokens?`, `prompt_cache_likely_expired?`, `estimated_cache_write_usd?` | `additionalContext?`, `initialUserMessage?`, `sessionTitle?`, `watchPaths?`, `reloadSkills?` |
| `Stop` / `SubagentStop` | `stop_hook_active`, `last_assistant_message?`, `background_tasks?`, `session_crons?` (+ `agent_id`, `agent_transcript_path`, `agent_type` for subagent) | `additionalContext?` — non-error feedback, conversation continues |
| `SessionEnd` | — | **no `hookSpecificOutput`** |
| `Notification` | message/title | `NotificationHookSpecificOutput` |

`BaseHookInput` (sdk.d.ts:167) on every event: `session_id`, `transcript_path`, `cwd`, `prompt_id?`,
`permission_mode?`, **`agent_id?`** (present only inside a subagent — the field to key on),
`agent_type?`, `effort?: {level: string}`. **[verified in .d.ts]**

**`PreCompact` specifically** (sdk.d.ts:2493):
```ts
PreCompactHookInput = BaseHookInput & { hook_event_name: 'PreCompact'; trigger: 'manual'|'auto'; custom_instructions: string | null }
```
- `custom_instructions` is **read-only input** — the instructions the user already passed to
  `/compact`. **[verified in .d.ts]**
- There is **no `PreCompactHookSpecificOutput`** in the `hookSpecificOutput` union. **PreCompact
  cannot inject or modify compaction instructions.** It can only do side effects (archive the
  transcript at `transcript_path`) and block. **[verified in .d.ts:8373]**
- It *can* block: the Claude Code hooks reference lists `PreCompact` under "Can block? Yes"
  (exit 2 / `decision: 'block'`). **[docs]**
- `PostCompact` (sdk.d.ts:2371) receives `trigger` plus **`compact_summary: string`** — the generated
  summary. Also no `hookSpecificOutput`. **[verified in .d.ts]**
- Hook failures on `PreCompact`/`Notification`/`PostModelSwitch` are logged and execution continues. **[docs]**
- `includeHookEvents?: boolean` (default `false`) surfaces `hook_started`/`hook_progress`/`hook_response`
  system messages for all events; `SessionStart` and `Setup` are always emitted. **[verified in .d.ts]**

## 5. Session continuity

- Options: `resume?: string`, `continue?: boolean` (mutually exclusive with `resume`),
  `forkSession?: boolean` (use with `resume`), `sessionId?: string` (must be a UUID; cannot combine
  with `continue`/`resume` unless `forkSession` is also set), `resumeSessionAt?: string`,
  `resumeDropsTurn?: string`, `persistSession?: boolean` (default `true`), `title?: string`. **[verified in .d.ts:1396ff]**
- Session id arrives twice: on `system/init` as `session_id` (earliest), and on every `result` as
  `session_id`. For a fork, read the **fork's new id from the init frame**. **[verified in .d.ts + docs]**
- Transcripts: **`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`**, or
  `$CLAUDE_CONFIG_DIR/projects/` when set. Encoding: every non-alphanumeric char in the absolute cwd
  → `-`; names over 200 chars are truncated + hashed. `CLAUDE_CODE_PROJECT_DIR_NAME` (SDK 0.3.234+)
  overrides the directory name. Subagent transcripts:
  `~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`. **[docs + verified in .d.ts:1041 + confirmed on this machine]**
- **Resume across a different `cwd`: yes.** "Claude Code searches beyond the current project
  directory to find the ID." Same machine only. Before CLI **v2.1.223** the lookup was scoped to the
  current project dir + its git worktrees; 0.3.257 bundles 2.1.257, so cross-directory lookup is on. **[docs]**
- `resumeSessionAt` = truncating resume at any chain-entry UUID. `resumeDropsTurn` names the prompt
  UUID of the turn being discarded and makes the CLI *validate* the discarded range; a refusal is an
  `error_during_execution` result whose message starts with **`Resume rejected by --resume-drops-turn:`**.
  It is **deterministic — never retry**; fall back to a plain resume. Both options are honoured on
  the **print/headless lane only**. **[verified in .d.ts:2493-region docs]**
- Fork-point rule: fork at the **last chain entry of the kept turn**, not the last assistant UUID
  (structured-output attachments, tool_result carriers and `shouldQuery:false` appends all count). **[verified in .d.ts]**
- Out-of-band session helpers (no subprocess): `listSessions`, `getSessionInfo`, `getSessionMessages`,
  `getSubagentMessages`, `listSubagents`, `renameSession`, `tagSession`, `deleteSession`,
  `forkSession`, `importSessionToStore`, `foldSessionSummary`, `resolveSettings`. All take
  `{dir?}` — **omit `dir` and they scan every project directory**. `listSessions` also takes
  `limit`/`offset`/`includeWorktrees` (default `true`)/`includeProgrammatic` (default `true`). **[verified in .d.ts:992ff]**
- `sessionStore?: SessionStore` (@alpha) dual-writes transcripts to your own backend; requires local
  writes, so it cannot combine with `persistSession:false` or `enableFileCheckpointing`.
  `sessionStoreFlush: 'batched'|'eager'` (default `'batched'`), `loadTimeoutMs` default `60000`. **[verified in .d.ts + sdk.mjs]**
- Removed: the experimental V2 `createSession()` API — gone in 0.3.142. **[docs]**

## 6. `SDKMessage` — exhaustive variant list

`type SDKMessage = ...` at sdk.d.ts:4603, 39 members. Every member carries `uuid: UUID` and
`session_id: string` (optional on `SDKUserMessage`). Discriminate on `type`, then `subtype`.
Correction: the table below has 40 rows because `SDKResultMessage` expands to success + error.
**[verified in .d.ts, mechanically extracted]**

| `type` | `subtype` | Type | Top-level fields |
|---|---|---|---|
| `assistant` | — | `SDKAssistantMessage` | `message: BetaMessage`, `parent_tool_use_id`, `error?: SDKAssistantMessageError`, `request_id?`, `user_message_uuid?`, `resumed_from_incomplete_thinking?`, `supersedes?: UUID[]`, `aborted?: true`, `subagent_type?`, `task_description?`, `timestamp?`, `context_usage?` |
| `user` | — | `SDKUserMessage` | `message: MessageParam`, `parent_tool_use_id`, `isSynthetic?`, `tool_use_result?: unknown`, `priority?`, `origin?`, `shouldQuery?`, `timestamp?`, `subagent_type?`, `task_description?` |
| `user` | — | `SDKUserMessageReplay` | as above + `isReplay`, `file_attachments?` (emitted on resume replay) |
| `result` | `success` | `SDKResultSuccess` | `duration_ms`, `duration_api_ms`, `ttft_ms?`, `ttft_stream_ms?`, `time_to_request_ms?`, `user_message_uuid?`, `request_sent_wall_ms?`, `time_to_request_from_spawn_ms?`, `warm_spare_claimed?`, `time_origin_ms?`, `is_error`, `api_error_status?`, `num_turns`, `result: string`, `stop_reason`, `total_cost_usd`, `usage: NonNullableUsage`, `modelUsage: Record<string, ModelUsage>`, `permission_denials: SDKPermissionDenial[]`, `queued_turn_count?`, `structured_output?`, `deferred_tool_use?`, `terminal_reason?`, `fast_mode_state?`, `fast_mode_disabled_reason?`, `origin?` |
| `result` | `error_during_execution` \| `error_max_turns` \| `error_max_budget_usd` \| `error_max_structured_output_retries` | `SDKResultError` | same minus `result`/`structured_output`, plus `errors: string[]` |
| `system` | `init` | `SDKSystemMessage` | `agents?`, `apiKeySource`, `betas?`, `claude_code_version`, `cwd`, `tools: string[]`, `mcp_servers: {name,status}[]`, `model`, `permissionMode`, `slash_commands: string[]`, `terminal_slash_commands?`, `output_style`, `skills: string[]`, `plugins: {name,path,version?}[]`, `fast_mode_state?`, `fast_mode_disabled_reason?`, `effort?`, `capabilities?: string[]` |
| `system` | `compact_boundary` | `SDKCompactBoundaryMessage` | `compact_metadata: { trigger: 'manual'\|'auto'; pre_tokens; post_tokens?; duration_ms?; preserved_segment?: {head_uuid,anchor_uuid,tail_uuid}; preserved_messages?: {anchor_uuid, uuids: UUID[]} }` |
| `stream_event` | — | `SDKPartialAssistantMessage` | `event: BetaRawMessageStreamEvent`, `parent_tool_use_id`, `ttft_ms?`, `user_message_uuid?` — **requires `includePartialMessages: true`** |
| `tool_progress` | — | `SDKToolProgressMessage` | `tool_use_id`, `tool_name`, `parent_tool_use_id`, `elapsed_time_seconds`, `task_id?`, `heartbeat?`, `subagent_type?`, `subagent_retry?` |
| `tool_use_summary` | — | `SDKToolUseSummaryMessage` | `summary`, `preceding_tool_use_ids` |
| `auth_status` | — | `SDKAuthStatusMessage` | `isAuthenticating`, `output`, `error?` |
| `rate_limit_event` | — | `SDKRateLimitEvent` | `rate_limit_info: SDKRateLimitInfo` |
| `prompt_suggestion` | — | `SDKPromptSuggestionMessage` | `suggestion` — needs `promptSuggestions: true`; **arrives AFTER `result`** |
| `conversation_reset` | — | `SDKConversationResetMessage` | `new_conversation_id` |
| `system` | `status` | `SDKStatusMessage` | `status: 'compacting'\|'requesting'\|null`, `permissionMode?`, `compact_result?`, `compact_error?` |
| `system` | `api_retry` | `SDKAPIRetryMessage` | `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error` |
| `system` | `control_request_progress` | `SDKControlRequestProgressMessage` | `request_id`, `status`, `attempt?`, `max_retries?`, `retry_delay_ms?`, `error_status?` |
| `system` | `model_refusal_fallback` | `SDKModelRefusalFallbackMessage` | `trigger`, `direction`, `scope?`, `original_model`, `fallback_model`, `request_id`, `api_refusal_category?`, `api_refusal_explanation?`, `retracted_message_uuids?`, `refused_user_message_uuid?`, `content` |
| `system` | `model_refusal_no_fallback` | `SDKModelRefusalNoFallbackMessage` | `original_model`, `request_id`, `api_refusal_category?`, `api_refusal_explanation?`, `refused_user_message_uuid?`, `content` |
| `system` | `local_command_output` | `SDKLocalCommandOutputMessage` | `content` |
| `system` | `hook_started` | `SDKHookStartedMessage` | `hook_id`, `hook_name`, `hook_event` |
| `system` | `hook_progress` | `SDKHookProgressMessage` | + `stdout`, `stderr`, `output` |
| `system` | `hook_response` | `SDKHookResponseMessage` | + `output`, `stdout`, `stderr`, `exit_code?`, `outcome` |
| `system` | `plugin_install` | `SDKPluginInstallMessage` | `status`, `name?`, `error?` |
| `system` | `task_started` | `SDKTaskStartedMessage` | `task_id`, `tool_use_id?`, `description`, `subagent_type?`, `is_backgrounded?`, `spawn_depth?`, `task_type?`, `workflow_name?`, `prompt?`, `skip_transcript?`, `ambient?` |
| `system` | `task_progress` | `SDKTaskProgressMessage` | `task_id`, `tool_use_id?`, `description`, `subagent_type?`, `usage`, `last_tool_name?`, `summary?` (needs `agentProgressSummaries`) |
| `system` | `task_updated` | `SDKTaskUpdatedMessage` | `task_id`, `patch` |
| `system` | `task_notification` | `SDKTaskNotificationMessage` | `task_id`, `tool_use_id?`, `status`, `output_file`, `summary`, `usage?`, `resource_links?`, `skip_transcript?`, `ambient?` |
| `system` | `background_tasks_changed` | `SDKBackgroundTasksChangedMessage` | `tasks` |
| `system` | `thinking_tokens` | `SDKThinkingTokensMessage` | `estimated_tokens`, `estimated_tokens_delta` |
| `system` | `session_state_changed` | `SDKSessionStateChangedMessage` | `state` |
| `system` | `worker_shutting_down` | `SDKWorkerShuttingDownMessage` | `reason` |
| `system` | `commands_changed` | `SDKCommandsChangedMessage` | `commands` — REPLACE your cached list |
| `system` | `notification` | `SDKNotificationMessage` | `key`, `text`, `priority`, `color?`, `timeout_ms?` |
| `system` | `files_persisted` | `SDKFilesPersistedEvent` | `files`, `failed`, `processed_at` |
| `system` | `memory_recall` | `SDKMemoryRecallMessage` | `mode`, `memories` |
| `system` | `elicitation_complete` | `SDKElicitationCompleteMessage` | `mcp_server_name`, `elicitation_id` |
| `system` | `permission_denied` | `SDKPermissionDeniedMessage` | `tool_name`, `tool_use_id`, `agent_id?`, `decision_reason_type?`, `decision_reason?`, `message` |
| `system` | `mirror_error` | `SDKMirrorErrorMessage` | `error`, `key` |
| `system` | `informational` | `SDKInformationalMessage` | `content`, `level`, `tool_use_id?`, `prevent_continuation?` |

Notes the adapter must honour:
- `SDKPermissionDenial = { tool_name, tool_use_id, tool_input }` (sdk.d.ts:4764). The `permission_denied`
  event is **best-effort advisory**; `result.permission_denials` is the authoritative record. **[verified in .d.ts]**
- `total_cost_usd`, `usage` and `modelUsage` are **cumulative across turns** in a streaming-input
  session — read the latest `result`, never sum. `usage` is main-loop-only; **`modelUsage` is the
  correct field for accounting** (includes subagents, sidechains, compaction). Resumed sessions start
  at zero; a mid-session `/clear` resets. **[verified in .d.ts:4919]**
- Exactly one `result` per turn, after that turn's assistant/user/stream_event messages. Informational
  system messages **may follow it** — `prompt_suggestion` deliberately does. Do not close the stream
  on `result` in streaming-input mode. **[verified in .d.ts:4917 + docs]**
- `queued_turn_count > 0` on a `result` means another turn follows with no further input.
- `TerminalReason` (sdk.d.ts:8443), on `result.terminal_reason`: `blocking_limit`,
  `rapid_refill_breaker`, `prompt_too_long`, `image_error`, `model_error`, `api_error`,
  `malformed_tool_use_exhausted`, `aborted_streaming`, `aborted_tools`, `stop_hook_prevented`,
  `hook_stopped`, `tool_deferred`, `max_turns`, `background_requested`, `completed`,
  `budget_exhausted`, `structured_output_retry_exhausted`, `tool_deferred_unavailable`,
  `turn_setup_failed`. **[verified in .d.ts]**
- `SDKAssistantMessage.supersedes: UUID[]` — evict those message uuids and treat this frame as the
  replacement (refusal fallback). `aborted: true` means truncated mid-stream, no `stop_reason`. **[verified in .d.ts]**
- Not in `SDKMessage` but on the wire: `StdoutMessage` (sdk.d.ts:8296) also carries
  `SDKControlResponse`, `SDKControlRequest`, `SDKControlCancelRequest`, `SDKKeepAliveMessage`,
  `SDKActiveGoalMessage`. The SDK consumes those; a raw NDJSON tap would see them. **[verified in .d.ts]**

## 7. Options — exists / type / default

All from sdk.d.ts:1396–2263 unless marked. **[verified in .d.ts]**

| Option | Type | Default | Notes |
|---|---|---|---|
| `cwd` | `string` | `process.cwd()` | passed to `spawn`, **no `process.chdir`** |
| `env` | `{[k:string]: string\|undefined}` | inherits `process.env` | **REPLACES the child env entirely** when set — spread `process.env` yourself |
| `model` | `string` | CLI default | `'claude-sonnet-5'`, `'claude-opus-4-8'`, `'claude-fable-5'` |
| `fallbackModel` | `string` | — | comma-separated list allowed; throws if equal to `model`; primary retried each user turn |
| `maxTurns` | `number` | — | → `error_max_turns` |
| `maxBudgetUsd` | `number` | — | → `error_max_budget_usd` |
| `taskBudget` | `{total: number}` | — | @alpha; `task-budgets-2026-03-13` beta |
| `maxThinkingTokens` | `number` | — | **deprecated**, use `thinking` |
| `thinking` | `{type:'adaptive'} \| {type:'enabled',budgetTokens} \| {type:'disabled'}` | `adaptive` on models that support it | `display?: 'summarized'\|'omitted'` also accepted |
| `effort` | `'low'\|'medium'\|'high'\|'xhigh'\|'max'` | `'high'` per docstring | `'max'` also settable session-scoped via `applyFlagSettings` |
| `permissionMode` | `'default'\|'acceptEdits'\|'bypassPermissions'\|'plan'\|'dontAsk'\|'auto'` | `'default'` | `bypassPermissions` requires `allowDangerouslySkipPermissions: true` |
| `planModeInstructions` | `string` | — | replaces the plan-mode workflow body |
| `allowedTools` | `string[]` | `[]` | bare names shadow `canUseTool` |
| `disallowedTools` | `string[]` | `[]` | bare name removes the tool from context; globs `*`, `mcp__*` supported |
| `tools` | `string[] \| {type:'preset',preset:'claude_code'}` | CLI preset | `[]` disables all built-ins; native builds may need `Grep`/`Glob` listed explicitly |
| `toolAliases` | `Record<string,string>` | — | single-hop redirect of model-emitted tool names |
| `toolConfig` | `{askUserQuestion?: {previewFormat?: 'markdown'\|'html'}}` | `'markdown'` | |
| `settingSources` | `('user'\|'project'\|'local')[]` | **all three** when omitted | `[]` = SDK isolation; **must include `'project'` to load CLAUDE.md** |
| `settings` | `string \| Settings` | — | flag-settings layer (highest user-controlled) |
| `managedSettings` | `Settings` | — | policy tier, restrictive-only filtering |
| `systemPrompt` | `string \| string[] \| {type:'custom',prompt,snapshot?} \| {type:'preset',preset:'claude_code',append?,excludeDynamicSections?,snapshot?}` | none (empty) | `snapshot: true` **recommended** — records the prompt once per conversation, keeps the cache prefix stable. `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` splits cacheable prefix from dynamic suffix |
| `agent` | `string` | — | main-thread agent (`--agent`) |
| `agents` | `Record<string, AgentDefinition>` | — | see :38 for the full 16-field `AgentDefinition` |
| `skills` | `string[] \| 'all'` | omitted ≠ off | context filter, not a sandbox |
| `plugins` | `SdkPluginConfig[]` | — | `{type:'local', path}` only |
| `mcpServers` | `Record<string, McpServerConfig>` | `{}` | stdio / sse / http / in-process `sdk` |
| `strictMcpConfig` | `boolean` | `false` | ignore `.mcp.json`, user settings, plugin + agent-frontmatter MCP |
| `abortController` | `AbortController` | fresh one | see §10 |
| `stderr` | `(data: string) => void` | — | setting it also turns on stderr forwarding |
| `debug` / `debugFile` | `boolean` / `string` | `false` | `debugFile` implies `debug` |
| `executable` | `'bun'\|'deno'\|'node'` | auto (`bun` if running under Bun, else `node`) | mostly moot: the bundled binary is native |
| `executableArgs` | `string[]` | `[]` | |
| `pathToClaudeCodeExecutable` | `string` | resolved from the platform optional-dep | |
| `spawnClaudeCodeProcess` | `(o: SpawnOptions) => SpawnedProcess` | — | for VM/container/remote execution |
| `extraArgs` | `Record<string, string \| null>` | `{}` | keys without `--`; `null` = boolean flag |
| `includePartialMessages` | `boolean` | `false` | gates `stream_event` |
| `includeHookEvents` | `boolean` | `false` | gates `hook_*` system messages |
| `forwardSubagentText` | `boolean` | `false` | full nested subagent transcript vs tool_use/tool_result only |
| `agentProgressSummaries` | `boolean` | `false` | ~30 s AI summaries on `task_progress.summary` |
| `promptSuggestions` | `boolean` | `false` | emits `prompt_suggestion` after `result` |
| `persistSession` | `boolean` | `true` | `false` = no `~/.claude/projects` write, no resume |
| `sessionStore` / `sessionStoreFlush` / `loadTimeoutMs` | `SessionStore` / `'batched'\|'eager'` / `number` | — / `'batched'` / `60000` | @alpha |
| `outputFormat` | `{type:'json_schema', schema: Record<string,unknown>}` | — | `OutputFormat = JsonSchemaOutputFormat` only; lands on `result.structured_output` |
| `betas` | `SdkBeta[]` | `[]` | **exactly one value exists: `'context-1m-2025-08-07'`** (sdk.d.ts:3365) |
| `enableFileCheckpointing` | `boolean` | `false` | required by `Query.rewindFiles()` |
| `sandbox` | `SandboxSettings` | — | cannot combine with a `settings` **file path**; `enabled:true` defaults `failIfUnavailable:true` |
| `additionalDirectories` | `string[]` | `[]` | absolute paths |
| `canUseTool` / `permissionPromptToolName` | see §3 | — | mutually exclusive |
| `hooks` | see §4 | — | |
| `onElicitation` | `OnElicitation` | — | unhandled elicitations auto-decline |
| `onUserDialog` + `supportedDialogKinds` | `OnUserDialog`, `string[]` | — | `supportedDialogKinds` without `onUserDialog` **throws**; without the declaration no dialogs are ever emitted |
| `perTaskStopAffordance` | `boolean` | `false` | when true, interrupt spares background tasks on an open-stdin session |
| `title` | `string` | auto-generated | ignored on resume |
| `continue` / `resume` / `forkSession` / `sessionId` / `resumeSessionAt` / `resumeDropsTurn` | see §5 | | |

**Does not exist**: any `contextManagement` / `autoCompact` / `compactionControl` option (see
`long-sessions.md`); `outputFormat` types other than `json_schema`; `betas` values beyond the one above.

## 8. `@anthropic-ai/claude-agent-sdk/extract`

```ts
export function extractFromBunfs(embeddedPath: string): string
```
`extractFromBunfs.d.ts:1` (the whole file). Exported at `package.json` `exports["./extract"]`. **[verified in .d.ts]**

- Purpose: under `bun build --compile`, `require.resolve` cannot see inside Bun's virtual filesystem
  (`/$bunfs/...`), so the native CLI binary cannot be located. You import the binary as a file asset,
  hand the bunfs path to `extractFromBunfs`, and get back a real on-disk path for
  `pathToClaudeCodeExecutable`. **[docs]**
- Outside a compiled executable it returns the input path unchanged — safe to call unconditionally. **[docs]**
- Requires SDK v0.3.144+. **[docs]**
- Usage (docs):
  ```ts
  import binPath from "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" with { type: "file" }
  import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract"
  const cliPath = extractFromBunfs(binPath)
  ```
- **Irrelevant to us if the sidecar runs on Node** — which it will. Only needed for a Bun
  single-file sidecar. Other subpath exports: `./browser` (browser bundle), `./bridge`, `./sdk-tools`
  (types only). **[verified in package.json]**

## 9. Concurrency, shared state, credentials

- **Concurrent `query()` calls in one process: supported.** Each call constructs its own
  `ProcessTransport` (own child process, own `AbortController`, own env object) and its own `Query`.
  Nothing is keyed on a module-level singleton on that path. **[verified in sdk.mjs `DL`/`MZt`]**
- `cwd` is passed to `spawn()`; the SDK never calls `process.chdir`. Two projects in one sidecar is
  safe. **[verified in sdk.mjs `qC.spawnLocalProcess`]**
- `env` is built per-query: `In = options.env ? {...options.env} : {...process.env}` and only ever
  mutated on that copy. **[verified in sdk.mjs `DL`]**
- **The one global mutation**: `DL` executes `process.env.CLAUDE_AGENT_SDK_VERSION = "0.3.257"` on the
  parent process on every `query()`. Benign, but it means `process.env` is written under you. **[verified in sdk.mjs `DL`]**
- Credential selection is entirely the **child's**, driven by the env you hand it. Precedence env
  vars the CLI recognises (`UD` list in the bundle): `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_FOUNDRY_API_KEY`,
  `ANTHROPIC_FOUNDRY_AUTH_TOKEN`, `ANTHROPIC_AWS_API_KEY`. **[verified in sdk.mjs]**
- `system/init.apiKeySource: ApiKeySource` reports which one won:
  `'ANTHROPIC_API_KEY' | 'apiKeyHelper' | '/login managed key' | 'none'`. **`'none'` is what a
  claude.ai OAuth login reports** — the legacy `'oauth'`/`'user'`/`'project'`/`'org'`/`'temporary'`
  members are never emitted by current CLIs. **[verified in .d.ts:127]**
- **OAuth storage is keyed by `CLAUDE_CONFIG_DIR`.** The keychain service name is
  `` `Claude Code${OAUTH_FILE_SUFFIX}${suffix}${o}` `` where `o` is `""` when `CLAUDE_CONFIG_DIR` is
  unset and `` `-${sha256(configDir).hex.slice(0,8)}` `` otherwise. Verified on this machine: a
  generic-password item named exactly `Claude Code-credentials` exists and `~/.claude/.credentials.json`
  does not. **[verified in sdk.mjs `IZ`/`PZ` + `security find-generic-password`]**
- **Therefore: two different OAuth accounts CAN run side by side in one Node process** — give each
  `query()` a distinct `env.CLAUDE_CONFIG_DIR` (each gets its own keychain item, its own
  `projects/` tree, its own settings). One process per account is not required. On Windows also set
  `CLAUDE_SECURESTORAGE_CONFIG_DIR`. **[verified in sdk.mjs; NOT exercised end-to-end — see Not checked]**
- Cost of that isolation: separate `~/.claude` trees means separate settings, sessions and memory per
  account. Session transcripts land under `$CLAUDE_CONFIG_DIR/projects/`, so `listSessions()` must be
  told which config dir to look in via its own env.
- **Licensing constraint, not technical**: "Unless previously approved, Anthropic does not allow third
  party developers to offer claude.ai login or rate limits for their products, including agents built
  on the Claude Agent SDK." **[docs, agent-sdk/overview]**

## 10. Cancellation

- `abortController.abort()` → `ProcessTransport.close()`:
  1. `stdin.end()` (graceful EOF),
  2. after **2000 ms**, if still alive: POSIX `SIGTERM`, then `SIGKILL` after a further **5000 ms**;
     Windows goes straight to `SIGKILL` after 5000 ms.
  All timers are `.unref()`d. **[verified in sdk.mjs `qC.close`, const `VFe=2000`]**
- The generator then **throws `AbortError`** (`class AbortError extends Error`, sdk.d.ts:17) with
  message **`Claude Code process aborted by user`**. Control requests in flight reject with
  `Operation aborted`. **[verified in sdk.mjs `Ky`/`zK`]**
- **`abort()` does not produce a `result` message from the SDK.** Anything already on stdout is still
  yielded, but the SDK emits nothing terminal of its own — the consumer sees a thrown `AbortError`.
  Design the adapter to synthesise its own terminal event on abort. **[verified in sdk.mjs; NOT exercised at runtime]**
- `query.interrupt()` is the graceful path: a control request, session stays alive, the CLI ends the
  turn and emits a **real `result`** with `terminal_reason: 'aborted_streaming' | 'aborted_tools'`.
  It resolves to `{still_queued: string[], cancelled?: string[]}` on CLIs advertising
  `interrupt_receipt_v1`, `undefined` on older ones. **[verified in .d.ts:4023 + sdk.mjs]**
- Queued user messages **survive** a plain interrupt (listed in `still_queued`). To stop everything in
  one round trip you need `cancel_queued: true` — advertised as `interrupt_cancel_queued_v1`, and
  **only reachable via a cast** because the `.d.ts` declares `interrupt()` with no parameters. **[verified]**
- Ordering: on a clean interrupt the receipt is written **before** the interrupted turn's result; a
  turn that crashes during interrupt handling may emit its error result first. **[verified in .d.ts:4023]**
- `query.close()` is the hard stop: tears down pending control requests, MCP transports and the child.
- Interrupting while a hook callback is pending cancels the pending tool call (CLI v2.1.208+). **[docs]**
- `spawnClaudeCodeProcess` receives `signal`, and it fires only **after** the EOF + grace window, so
  forwarding it to your own spawn/VM API is safe. **[verified in .d.ts:1396-region]**

---

## Implications for the adapter

- Pin the SDK exactly and treat `SDK 0.3.N ⇒ CLI 2.1.N` as one unit. Never let `pathToClaudeCodeExecutable`
  point at a system `claude`: nothing checks, and drift shows up as silently missing fields.
- Feature-detect on `system/init.capabilities` (open set) plus `claude_code_version`, not on the SDK
  version. Persist the init frame per session — it is also the only place a fork's new id appears early.
- One `query()` per session, streaming-input, generator held open by the adapter; ending the generator
  is the only clean way to end the session. Never close the stream on `result`.
- Use `env.CLAUDE_CONFIG_DIR` as the account boundary — that one variable partitions keychain item,
  transcripts, settings and memory. It buys multi-account in a single sidecar process.
- Bill and display from `result.modelUsage` (cumulative, includes subagents), never `usage`, and never
  sum across `result` frames.
- Approvals: `canUseTool` for the interactive prompt UI, but a `PreToolUse` hook is the only seam that
  sees *every* call. Listen for `process.on('warning')` / `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` and surface
  it — it means our own config silently disabled our approval UI.
- Never return `null` from `canUseTool`; a stray `null` parks the tool forever with no timeout.
- Cancellation has two shapes and the adapter needs both: `interrupt()` (turn ends, real `result`,
  session survives, queued turns survive unless you cast in `cancelQueued`) vs `abort()`/`close()`
  (process dies, `AbortError` thrown, no `result` — synthesise one).
- PreCompact can archive and block but **cannot steer** compaction. Own the handoff with
  `forkSession` + `resumeSessionAt` and files, per `long-sessions.md`.
- Map `SDKAssistantMessage.supersedes` to an evict-and-replace in the event log, and honour
  `aborted: true` / `terminal_reason`, or the timeline will show retracted refusal content forever.

## Not checked

- **No live `query()` was run.** Every runtime claim below the type level is read from the shipped
  bundle, not observed: the abort grace window, the absence of a `result` on abort, `canUseTool`
  firing under a string prompt, and two `CLAUDE_CONFIG_DIR`s side by side. Measure these before
  designing against them — `t3code.md` already flags one prior `canUseTool` measurement that
  contradicted a doc claim.
- Cross-`cwd` resume is **docs-only**. The bundled binary contains both a `not_found_explicit_id`
  path and a "This conversation is from a different directory" picker message; which one a headless
  `--resume=<id>` takes was not confirmed by execution.
- The Python SDK (`claude-agent-sdk-python`) was not examined; TS only.
- `Settings` (sdk.d.ts:5650–8156, ~2,500 lines) was not enumerated. `resolveSettings()` /
  `ResolvedSettings.provenance` (@alpha) look useful for a settings UI and deserve their own pass.
- `SessionStore` / `sessionStoreFlush` (@alpha) read but not evaluated as a persistence design.
- `DirectConnectTransport` / `parseDirectConnectUrl` (WebSocket transport, exported but undocumented
  in the reference) not investigated.
- `bridge.mjs` (1.46 MB, `./bridge` export, 378 lines of `.d.ts`) not investigated.
- No check of whether `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` and `zod` peer deps (`>=0.93.0`,
  `^1.29.0`, `^4.0.0`) conflict with anything we plan to ship in the sidecar.
