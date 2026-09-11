//! CLI → host messages: the `SDKMessage` union (`sdk.d.ts:4603`, 39 members) plus the three
//! non-`SDKMessage` frames that share the stream (`keep_alive`, `transcript_mirror`,
//! `active_goal`).
//!
//! Only the variants the harness reads are given typed fields. Every other `system` subtype
//! decodes into [`SystemMessage::Other`] and every other top-level `type` into
//! [`CliMessage::Unknown`] — both lossless.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Unknown fields captured by `#[serde(flatten)]`, re-emitted verbatim on encode.
pub type Extra = serde_json::Map<String, Value>;

/// Deserialises `T`, yielding `None` instead of an error when the wire value has drifted to a
/// different shape.
///
/// Pair it with `#[serde(default)]` on an `Option` field of a struct that sits inside an
/// `#[serde(untagged)]` union. Without it a single drifted field type — `"capabilities":{"x":1}`
/// where an array was transcribed — fails the whole struct and silently demotes the frame to the
/// union's fallback arm, taking every *other* field of that frame with it. With it, only the
/// drifted field is lost.
pub(crate) fn lenient<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    Ok(T::deserialize(&value).ok())
}

/// Deserialises a present field into `Some(_)`, so an explicit `null` becomes `Some(None)` rather
/// than collapsing into the `None` that means "the key was absent".
///
/// Serde's own `Option` impl maps JSON `null` to `None` at whichever level it is applied, so a bare
/// `Option<Option<T>>` cannot tell the two apart; this pushes the null one level down. Used by
/// [`SystemStatus::status`], where the difference is the whole end-of-compaction frame.
pub(crate) fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// One frame from the CLI, tolerant of message types this crate does not know.
///
/// Implemented as an `#[serde(untagged)]` wrapper (not a custom `Deserialize`): serde tries
/// [`CliMessage::Known`] first and falls through to [`CliMessage::Unknown`] when the `type` is
/// unrecognised *or* a known payload fails to typecheck. The cost of that tolerance is that a
/// malformed known message is silently demoted rather than reported.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CliMessage {
    /// A message type this crate models. Boxed: `KnownMessage` is much larger than a `Value`.
    Known(Box<KnownMessage>),
    /// An unrecognised `type`, kept verbatim.
    Unknown(Value),
}

/// The message types this crate models, discriminated on the top-level `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum KnownMessage {
    /// `system` — informational, sub-discriminated on `subtype`.
    #[serde(rename = "system")]
    System(SystemMessage),
    /// `assistant` — one model turn (`sdk.d.ts:3271`).
    #[serde(rename = "assistant")]
    Assistant(AssistantMessage),
    /// `user` — a user turn or a tool result (`sdk.d.ts:5267`, `sdk.d.ts:5318` for the replay
    /// form emitted on resume; both share this shape).
    #[serde(rename = "user")]
    User(UserMessage),
    /// `result` — one per turn (`sdk.d.ts:4917`).
    #[serde(rename = "result")]
    Result(ResultMessage),
    /// `stream_event` — raw Anthropic streaming deltas; requires `includePartialMessages`
    /// (`sdk.d.ts:4748`).
    #[serde(rename = "stream_event")]
    StreamEvent(StreamEventMessage),
    /// `tool_progress` (`sdk.d.ts:5234`).
    #[serde(rename = "tool_progress")]
    ToolProgress(ToolProgressMessage),
    /// `tool_use_summary` (`sdk.d.ts:5255`).
    #[serde(rename = "tool_use_summary")]
    ToolUseSummary(ToolUseSummaryMessage),
    /// `auth_status` (`sdk.d.ts:3334`).
    #[serde(rename = "auth_status")]
    AuthStatus(AuthStatusMessage),
    /// `prompt_suggestion` — needs `promptSuggestions: true` and arrives *after* `result`
    /// (`sdk.d.ts:4832`).
    #[serde(rename = "prompt_suggestion")]
    PromptSuggestion(PromptSuggestionMessage),
    /// `rate_limit_event` (`sdk.d.ts:4842`).
    #[serde(rename = "rate_limit_event")]
    RateLimitEvent(RateLimitEventMessage),
    /// `conversation_reset` (`sdk.d.ts:4407`).
    #[serde(rename = "conversation_reset")]
    ConversationReset(ConversationResetMessage),
    /// `active_goal` — not in `SDKMessage`, but in `StdoutMessage` (`sdk.d.ts:3240`, `:8296`).
    #[serde(rename = "active_goal")]
    ActiveGoal(ActiveGoalMessage),
    /// `keep_alive` — ignored by the SDK (`sdk.d.ts:4536`).
    #[serde(rename = "keep_alive")]
    KeepAlive(KeepAliveMessage),
    /// `transcript_mirror` — not in `sdk.d.ts` at all; only `sdk.mjs:47224-47227` handles it,
    /// which is why the fields are untyped here.
    #[serde(rename = "transcript_mirror")]
    TranscriptMirror(TranscriptMirrorMessage),
}

// ---------------------------------------------------------------------------------------------
// system
// ---------------------------------------------------------------------------------------------

/// `{"type":"system", ...}`, sub-discriminated on `subtype`, with a lossless fallback.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SystemMessage {
    /// `system`/`init` — the session handshake (`sdk.d.ts:5057`).
    Init(SystemInit),
    /// `system`/`compact_boundary` (`sdk.d.ts:3378`).
    CompactBoundary(SystemCompactBoundary),
    /// `system`/`hook_started` | `hook_progress` | `hook_response`
    /// (`sdk.d.ts:4500`, `sdk.d.ts:4472`, `sdk.d.ts:4485`).
    Hook(SystemHook),
    /// `system`/`status` (`sdk.d.ts:5042`).
    Status(SystemStatus),
    /// `system`/`permission_denied` — advisory only; `result.permission_denials` is
    /// authoritative (`sdk.d.ts:4773`).
    PermissionDenied(SystemPermissionDenied),
    /// Any other `subtype` (`api_retry`, `task_started`, `notification`, `informational`, … —
    /// 25-odd more at `sdk.d.ts:4603`), kept verbatim. Must stay last.
    Other(SystemOther),
}

literal_tag!(
    /// `subtype: "init"`.
    InitTag { Init => "init" }
);

/// `system`/`init`: the only place `capabilities`, `claude_code_version` and the resolved
/// session id appear (`sdk.d.ts:5057-5109`). Feature-detect on `capabilities` — it is an open
/// set, ignore unknown values (`sdk.d.ts:5107` and its docstring).
///
/// Every field but `subtype` is deserialised leniently: this struct is the first arm of an
/// `#[serde(untagged)]` union, so one drifted field type would otherwise demote the handshake to
/// [`SystemMessage::Other`] and cost the adapter `session_id`. A drifted field reads as `None`;
/// the rest of the frame survives.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemInit {
    /// Always `"init"`.
    pub subtype: InitTag,
    /// Session id assigned by the CLI; the value to pass to `--resume`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub session_id: Option<String>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub uuid: Option<String>,
    /// Resolved model id.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub model: Option<String>,
    /// Working directory the session resolved to.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub cwd: Option<String>,
    /// Tool names available this session.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub tools: Option<Vec<String>>,
    /// Configured MCP servers and their connection status.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub mcp_servers: Option<Vec<McpServerStatus>>,
    /// Effective permission mode. CamelCase on the wire (`sdk.d.ts:5077`).
    #[serde(rename = "permissionMode")]
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub permission_mode: Option<String>,
    /// CLI version; tracks the SDK version 1:1 (`0.3.N` ↔ `2.1.N`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub claude_code_version: Option<String>,
    /// Protocol capabilities, open set — e.g. `interrupt_receipt_v1`,
    /// `interrupt_cancel_queued_v1`, `queued_notifications` (`sdk.d.ts:5107` and its docstring).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub capabilities: Option<Vec<String>>,
    /// Where the credential came from. CamelCase on the wire (`sdk.d.ts:5064`).
    #[serde(rename = "apiKeySource")]
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub api_key_source: Option<String>,
    /// Subagent names discovered for this session.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub agents: Option<Vec<String>>,
    /// Slash command names.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub slash_commands: Option<Vec<String>>,
    /// Active output style name.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub output_style: Option<String>,
    /// Skill names loaded into the main system prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub skills: Option<Vec<String>>,
    /// Loaded plugins (`{name, path, version?}`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub plugins: Option<Value>,
    /// API betas the session enabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub betas: Option<Vec<String>>,
    /// Reasoning effort, nullable (`'low'|'medium'|'high'|'xhigh'|'max'|null`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, deserialize_with = "lenient")]
    pub effort: Option<String>,
    /// Everything else `system`/`init` carries.
    #[serde(flatten)]
    pub extra: Extra,
}

/// One entry of `system`/`init`'s `mcp_servers` (`sdk.d.ts:5069-5072`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpServerStatus {
    /// Server name as configured.
    pub name: String,
    /// Connection status string.
    pub status: String,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

literal_tag!(
    /// `subtype: "compact_boundary"`.
    CompactBoundaryTag { CompactBoundary => "compact_boundary" }
);

/// `system`/`compact_boundary` (`sdk.d.ts:3378`; first observed on the wire in
/// `crates/claude-spike/fixtures/s11-auto-compaction.ndjson:49`, CLI 2.1.268).
///
/// It arrives **after** the three `system`/`status` frames of the compaction and **before** the
/// synthetic `user` frame that carries the summary ("This session is being continued from a
/// previous conversation…"). A compaction that fails emits neither.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemCompactBoundary {
    /// Always `"compact_boundary"`.
    pub subtype: CompactBoundaryTag,
    /// What was compacted and why.
    pub compact_metadata: CompactMetadata,
    /// Uuid of the last message kept, which the summary is spliced after. Measured on the real
    /// capture; equals `compact_metadata.preserved_segment.tail_uuid` there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_parent_uuid: Option<String>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `compact_metadata` (`sdk.d.ts:3381-3405`). Every field below `trigger` was observed populated
/// in `crates/claude-spike/fixtures/s11-auto-compaction.ndjson:49`, CLI 2.1.268.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompactMetadata {
    /// `"manual"` or `"auto"`.
    pub trigger: String,
    /// Token count before compaction. Measured: `70633`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_tokens: Option<u64>,
    /// Token count after compaction. Measured: `1379` — the summary alone, not the whole context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_tokens: Option<u64>,
    /// Running total of context tokens every compaction in this session has removed, roughly
    /// `pre_tokens - post_tokens` summed. Measured: `69254` on the first compaction.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cumulative_dropped_tokens: Option<u64>,
    /// How long compaction took. Measured: `12262` ms, on haiku, for a 70k context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// `preserved_segment`, `preserved_messages`, and anything added later.
    #[serde(flatten)]
    pub extra: Extra,
}

literal_tag!(
    /// The three hook lifecycle subtypes.
    HookTag {
        Started => "hook_started",
        Progress => "hook_progress",
        Response => "hook_response",
    }
);

/// `system`/`hook_started` | `hook_progress` | `hook_response`. One struct for all three:
/// `hook_progress` adds the stream fields and `hook_response` adds the outcome fields
/// (`sdk.d.ts:4485-4512`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemHook {
    /// Which of the three lifecycle frames this is.
    pub subtype: HookTag,
    /// Stable id correlating the three frames of one hook run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook_id: Option<String>,
    /// Hook name as configured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook_name: Option<String>,
    /// Hook event that fired (`PreToolUse`, `Stop`, …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook_event: Option<String>,
    /// Combined output; `hook_progress` and `hook_response` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// Captured stdout; `hook_progress` and `hook_response` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    /// Captured stderr; `hook_progress` and `hook_response` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    /// Process exit code; `hook_response` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    /// `"success" | "error" | "cancelled"`; `hook_response` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

literal_tag!(
    /// `subtype: "status"`.
    StatusTag { Status => "status" }
);

/// `system`/`status` (`sdk.d.ts:5042`; first observed on the wire in
/// `crates/claude-spike/fixtures/s11-auto-compaction.ndjson`, CLI 2.1.268).
///
/// A compaction shows up here as three frames in order: `"requesting"`, `"compacting"`, then
/// `null` carrying `compact_result` (`"success"` or `"failed"`, the latter with `compact_error`)
/// in [`Self::extra`]. The `compact_boundary` frame follows only when it succeeded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemStatus {
    /// Always `"status"`.
    pub subtype: StatusTag,
    /// `"compacting" | "requesting"`, or an explicit `null` that clears the phase.
    ///
    /// Two `Option`s, not one, because the outer and the inner mean different things on the wire
    /// and the difference is load-bearing: the frame that *ends* a compaction is
    /// `{"status":null,"compact_result":"success"}`, and a single `Option` plus
    /// `skip_serializing_if` re-encoded it without the key at all. Measured on the real capture —
    /// `crates/claude-spike/fixtures/s11-auto-compaction.ndjson:26` and `:48`, CLI 2.1.268 — where
    /// it cost two lines of `real_captures_round_trip_byte_faithfully`.
    ///
    /// `None` = the key was absent; `Some(None)` = the key was present and `null`.
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<Option<String>>,
    /// Current permission mode, camelCase on the wire.
    #[serde(rename = "permissionMode")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// `compact_result`, `compact_error`, and anything added later.
    #[serde(flatten)]
    pub extra: Extra,
}

literal_tag!(
    /// `subtype: "permission_denied"`.
    PermissionDeniedTag { PermissionDenied => "permission_denied" }
);

/// `system`/`permission_denied` — best-effort advisory (`docs/research/agent-sdk.md` §6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemPermissionDenied {
    /// Always `"permission_denied"`.
    pub subtype: PermissionDeniedTag,
    /// Tool that was denied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Tool use id that was denied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    /// Subagent that issued the call, when it was not the main loop.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Human-readable denial message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// `decision_reason`, `decision_reason_type`, and anything added later.
    #[serde(flatten)]
    pub extra: Extra,
}

/// Any `system` subtype this crate does not model, kept verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemOther {
    /// The unmodelled subtype.
    pub subtype: String,
    /// The whole rest of the frame.
    #[serde(flatten)]
    pub extra: Extra,
}

// ---------------------------------------------------------------------------------------------
// assistant / user
// ---------------------------------------------------------------------------------------------

/// `{"type":"assistant"}` (`sdk.d.ts:3271`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssistantMessage {
    /// The Anthropic `BetaMessage` the model produced (`sdk.d.ts:3276`).
    pub message: AnthropicMessage,
    /// Task tool_use id when this turn belongs to a subagent, else `null`.
    // Not skipped: every `assistant`/`user` line in the CLI 2.1.257 captures writes this
    // key explicitly, `null` included, so skipping it would break byte fidelity.
    pub parent_tool_use_id: Option<String>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Message uuids this frame replaces — evict them and render this instead (refusal
    /// fallback) (`sdk.d.ts:3293`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<Vec<String>>,
    /// `true` when the turn was truncated mid-stream; no `stop_reason` in that case.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aborted: Option<bool>,
    /// API-level failure category (`sdk.d.ts:3332` `SDKAssistantMessageError`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Subagent type when `parent_tool_use_id` is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent_type: Option<String>,
    /// `request_id`, `user_message_uuid`, `context_usage`, `timestamp`, …
    #[serde(flatten)]
    pub extra: Extra,
}

/// `{"type":"user"}` — both the live form (`sdk.d.ts:5267`) and the resume-replay form
/// (`sdk.d.ts:5318`), which differ only by `isReplay`/`file_attachments`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserMessage {
    /// The Anthropic `MessageParam`; carries `tool_result` blocks for completed tool calls.
    pub message: AnthropicMessage,
    /// Task tool_use id when this belongs to a subagent, else `null`.
    // Not skipped: every `assistant`/`user` line in the CLI 2.1.257 captures writes this
    // key explicitly, `null` included, so skipping it would break byte fidelity.
    pub parent_tool_use_id: Option<String>,
    /// Frame uuid; optional on `user` alone among `SDKMessage` members.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Session id; optional on `user` alone among `SDKMessage` members.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Structured tool result payload the CLI attaches alongside the content block.
    ///
    /// A frame-level **sibling of `message`**, not a field inside it, and its type is unstable —
    /// see [`ToolUseResult`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_result: Option<ToolUseResult>,
    /// CLI-synthesised rather than user-authored.
    #[serde(rename = "isSynthetic")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_synthetic: Option<bool>,
    /// Set on frames replayed while resuming a session (`sdk.d.ts:5318`).
    #[serde(rename = "isReplay")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_replay: Option<bool>,
    /// `origin`, `priority`, `shouldQuery`, `timestamp`, `file_attachments`, …
    #[serde(flatten)]
    pub extra: Extra,
}

/// The `tool_use_result` sibling a `user` frame carries beside its `tool_result` block.
///
/// **Untagged on purpose: the CLI writes three different JSON types into this one key**, measured
/// across the six captures in `crates/claude-spike/fixtures` and recorded in
/// `docs/research/cli-steer-and-exit-codes.md` §2 —
///
/// - a **structured object** on success, `{stdout, stderr, interrupted, isImage,
///   noOutputExpected}` for `Bash`, and a wholly different set of keys for `Read`, `Write`,
///   `Task`, `ToolSearch`, … (`{type, file}`, `{type, filePath, content, structuredPatch, …}`,
///   `{isAsync, status, agentId, …}`, `{matches, query, total_deferred_tools}`);
/// - the **string** `"Error: " + content` when a command exits non-zero;
/// - the **string** `"User rejected tool use"` when the operator interrupted or denied it.
///
/// [`ToolUseResult::Structured`]'s named fields are the `Bash` shape only; every other key is
/// caught by its `extra` and re-emitted verbatim, which is what keeps
/// `decode.rs::real_captures_round_trip_byte_faithfully` green for the eleven non-`Bash` object
/// shapes in the captures. [`ToolUseResult::Other`] is the lenient arm: a value that is neither a
/// string nor an object — or an object whose `stdout` has drifted to a non-string — is kept as a
/// [`Value`] rather than failing the whole `user` frame down to [`CliMessage::Unknown`].
///
/// **There is no exit-code field here or anywhere else on the wire.** The only carrier of an exit
/// code is the literal first line `Exit code N\n` of `tool_result.content`; it is parsed in
/// `brigadier_core::claude::adapter`, never inferred from `is_error`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolUseResult {
    /// An object payload. The five named fields are `Bash`'s; anything else lands in `extra`.
    Structured {
        /// Standard output, when the tool reports it separately.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stdout: Option<String>,
        /// Standard error. Note that in `tool_result.content` stderr is concatenated **after**
        /// stdout with no delimiter; only this sibling separates them.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stderr: Option<String>,
        /// True when the tool was cut short rather than having failed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        interrupted: Option<bool>,
        /// True when the result body is an image rather than text.
        #[serde(default, rename = "isImage", skip_serializing_if = "Option::is_none")]
        is_image: Option<bool>,
        /// True when the tool is expected to produce no output at all.
        #[serde(
            default,
            rename = "noOutputExpected",
            skip_serializing_if = "Option::is_none"
        )]
        no_output_expected: Option<bool>,
        /// Every other key, verbatim.
        #[serde(flatten)]
        extra: Extra,
    },
    /// A bare string: `"Error: …"` on a non-zero exit, `"User rejected tool use"` on an interrupt.
    Message(String),
    /// Anything else, kept rather than dropped.
    Other(Value),
}

/// The exact string the CLI writes when the operator interrupted or denied a tool use.
// see docs/plans/codex-thread-rebuild-2026-09-11.md §4.1 and landmine 1 — an interrupt is an
// interruption, not a failure, and it arrives with `is_error: true` like a failure does.
pub const REJECTED_TOOL_USE: &str = "User rejected tool use";

impl ToolUseResult {
    /// True when this result says the tool was interrupted or rejected rather than having failed.
    ///
    /// Two carriers, both read: the literal [`REJECTED_TOOL_USE`] string, and `interrupted: true`
    /// on the structured form. Nothing is inferred from `is_error`, which is `true` for a failure,
    /// an interrupt and a rejection alike.
    pub fn is_interrupted(&self) -> bool {
        match self {
            Self::Message(s) => s == REJECTED_TOOL_USE,
            Self::Structured { interrupted, .. } => interrupted.unwrap_or(false),
            Self::Other(_) => false,
        }
    }
}

/// The Anthropic `BetaMessage` / `MessageParam` shape carried by `assistant` and `user` frames.
///
/// Not defined in `sdk.d.ts` — it is imported from
/// `@anthropic-ai/sdk/resources/beta/messages/messages.mjs` (`sdk.d.ts:1`), so everything but
/// `role` and `content` is optional here to cover both the full `BetaMessage` (assistant) and
/// the two-field `MessageParam` (user).
///
/// `stop_reason` and `stop_sequence` are deliberately **not** named fields: `assistant` frames
/// always write them as an explicit `null` and `user` frames omit them entirely, and an
/// `Option<String>` cannot tell those apart on re-encode. Left in [`AnthropicMessage::extra`] the
/// distinction survives verbatim; read them through [`AnthropicMessage::stop_reason`] and
/// [`AnthropicMessage::stop_sequence`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnthropicMessage {
    /// `"assistant"` or `"user"`.
    pub role: String,
    /// Text or a block list.
    pub content: MessageContent,
    /// Anthropic message id; assistant frames only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Always `"message"` when present; assistant frames only. Renamed to dodge the keyword.
    #[serde(rename = "type")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_type: Option<String>,
    /// Model that produced the turn; assistant frames only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Per-request token usage. Left untyped: this is the Anthropic API's `BetaUsage`, which
    /// this crate does not own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    /// Unknown fields, `stop_reason` and `stop_sequence` among them.
    #[serde(flatten)]
    pub extra: Extra,
}

impl AnthropicMessage {
    /// `end_turn`, `tool_use`, `max_tokens`, …; `None` while streaming, or on a `user` frame.
    pub fn stop_reason(&self) -> Option<&str> {
        self.extra.get("stop_reason").and_then(Value::as_str)
    }

    /// The stop sequence the turn matched, if any.
    pub fn stop_sequence(&self) -> Option<&str> {
        self.extra.get("stop_sequence").and_then(Value::as_str)
    }
}

/// `content`: the Anthropic API accepts a bare string or a block list; the CLI emits both.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    /// A bare string.
    Text(String),
    /// A list of content blocks.
    Blocks(Vec<ContentBlock>),
}

/// One content block, tolerant of block types this crate does not model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ContentBlock {
    /// A modelled block type.
    Known(ContentBlockKnown),
    /// Anything else (`server_tool_use`, `web_search_tool_result`, `image`, `document`, …).
    Unknown(Value),
}

/// The content-block types the harness renders.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlockKnown {
    /// Plain assistant or user text.
    #[serde(rename = "text")]
    Text {
        /// The text.
        text: String,
        /// `citations`, `cache_control`, …
        #[serde(flatten)]
        extra: Extra,
    },
    /// Extended-thinking output.
    #[serde(rename = "thinking")]
    Thinking {
        /// The thinking text.
        thinking: String,
        /// Cryptographic signature the API requires on replay.
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
        /// Unknown fields.
        #[serde(flatten)]
        extra: Extra,
    },
    /// Thinking the API redacted; opaque, must be replayed verbatim.
    #[serde(rename = "redacted_thinking")]
    RedactedThinking {
        /// Opaque payload.
        data: String,
        /// Unknown fields.
        #[serde(flatten)]
        extra: Extra,
    },
    /// A tool call.
    #[serde(rename = "tool_use")]
    ToolUse {
        /// Tool use id, echoed by the matching `tool_result` and by `can_use_tool`.
        id: String,
        /// Tool name.
        name: String,
        /// Tool arguments.
        input: Value,
        /// Unknown fields.
        #[serde(flatten)]
        extra: Extra,
    },
    /// A tool result, carried on `user` frames.
    #[serde(rename = "tool_result")]
    ToolResult {
        /// The `tool_use` id this answers.
        tool_use_id: String,
        /// String or block-list result.
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<Value>,
        /// Whether the tool failed.
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
        /// Unknown fields.
        #[serde(flatten)]
        extra: Extra,
    },
}

// ---------------------------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------------------------

/// `{"type":"result"}` — exactly one per turn, after that turn's other messages. Informational
/// frames may follow it (`prompt_suggestion` deliberately does), so never close the stream on it
/// in streaming-input mode (`sdk.d.ts:4917`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResultMessage {
    /// `subtype: "success"` (`sdk.d.ts:4919` `SDKResultSuccess`).
    Success(ResultSuccess),
    /// The four error subtypes (`sdk.d.ts:4875` `SDKResultError`).
    Error(ResultError),
    /// A `result` subtype added after this transcription. Must stay last.
    Other(ResultOther),
}

literal_tag!(
    /// `subtype: "success"`.
    ResultSuccessTag { Success => "success" }
);

literal_tag!(
    /// The four `SDKResultError` subtypes (`sdk.d.ts:4877`).
    ResultErrorTag {
        ErrorDuringExecution => "error_during_execution",
        ErrorMaxTurns => "error_max_turns",
        ErrorMaxBudgetUsd => "error_max_budget_usd",
        ErrorMaxStructuredOutputRetries => "error_max_structured_output_retries",
    }
);

/// `result`/`success`.
///
/// `total_cost_usd`, `usage` and `modelUsage` are **cumulative across turns** in a
/// streaming-input session: read the latest `result`, never sum. `modelUsage` is the accounting
/// field — `usage` is main-loop-only (`docs/research/agent-sdk.md` §6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResultSuccess {
    /// Always `"success"`.
    pub subtype: ResultSuccessTag,
    /// Wall-clock duration of the turn.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Time spent in API calls.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_api_ms: Option<u64>,
    /// Whether the turn ended in an error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    /// Assistant turns taken.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_turns: Option<u64>,
    /// The final assistant text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// Cumulative cost for the session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cost_usd: Option<f64>,
    /// Main-loop token usage; cumulative.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    /// Per-model usage including subagents, sidechains and compaction; cumulative.
    /// CamelCase on the wire (`sdk.d.ts:4948`).
    #[serde(rename = "modelUsage")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_usage: Option<Value>,
    /// Authoritative record of tools denied this session (`sdk.d.ts:4764`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_denials: Option<Vec<PermissionDenial>>,
    /// Why the turn ended (`sdk.d.ts:8443` `TerminalReason`, 19 values).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
    /// Model stop reason; `null` when the turn was aborted.
    // Not skipped: every `result` line in the captures carries the key, `null` included.
    pub stop_reason: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// `queued_turn_count`, `structured_output`, `ttft_ms`, `fast_mode_state`, …
    #[serde(flatten)]
    pub extra: Extra,
}

/// `result`/`error_*`. Same shape as [`ResultSuccess`] minus `result`/`structured_output`, plus
/// `errors`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResultError {
    /// Which error subtype.
    pub subtype: ResultErrorTag,
    /// Wall-clock duration of the turn.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Time spent in API calls.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_api_ms: Option<u64>,
    /// Whether the turn ended in an error (always true here).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    /// Assistant turns taken.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_turns: Option<u64>,
    /// Error strings for this turn.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<String>>,
    /// Cumulative cost for the session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cost_usd: Option<f64>,
    /// Main-loop token usage; cumulative.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    /// Per-model usage; cumulative. CamelCase on the wire.
    #[serde(rename = "modelUsage")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_usage: Option<Value>,
    /// Authoritative record of tools denied this session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_denials: Option<Vec<PermissionDenial>>,
    /// Why the turn ended (`sdk.d.ts:8443`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
    /// Model stop reason.
    // Not skipped: every `result` line in the captures carries the key, `null` included.
    pub stop_reason: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// A `result` subtype added after this transcription, kept verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResultOther {
    /// The unmodelled subtype.
    pub subtype: String,
    /// The whole rest of the frame.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `SDKPermissionDenial` (`sdk.d.ts:4764`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PermissionDenial {
    /// Tool that was denied.
    pub tool_name: String,
    /// The denied tool use id.
    pub tool_use_id: String,
    /// The arguments that were denied.
    pub tool_input: Value,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

// ---------------------------------------------------------------------------------------------
// the remaining top-level types
// ---------------------------------------------------------------------------------------------

/// `{"type":"stream_event"}` (`sdk.d.ts:4748`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StreamEventMessage {
    /// The Anthropic `BetaRawMessageStreamEvent`. Deliberately untyped: it is the API's own
    /// streaming union, owned by `@anthropic-ai/sdk`, and the harness only forwards it.
    pub event: Value,
    /// Task tool_use id when the deltas belong to a subagent, else `null`.
    // Not skipped, for the same reason as `assistant`/`user`. Unverified for this frame:
    // the captures contain none.
    pub parent_tool_use_id: Option<String>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// `ttft_ms`, `user_message_uuid`.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `{"type":"tool_progress"}` (`sdk.d.ts:5234`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolProgressMessage {
    /// Tool call this progress belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    /// Tool name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Task tool_use id when the call belongs to a subagent, else `null`.
    // Not skipped, for the same reason as `assistant`/`user`. Unverified for this frame:
    // the captures contain none.
    pub parent_tool_use_id: Option<String>,
    /// Seconds elapsed since the call started.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_time_seconds: Option<f64>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// `task_id`, `heartbeat`, `subagent_type`, `subagent_retry`.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `{"type":"tool_use_summary"}` (`sdk.d.ts:5255`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolUseSummaryMessage {
    /// Human-readable summary of the tool calls it covers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// The tool use ids summarised.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preceding_tool_use_ids: Option<Vec<String>>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `{"type":"auth_status"}` (`sdk.d.ts:3334`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuthStatusMessage {
    /// Whether an interactive auth flow is in progress. CamelCase on the wire.
    #[serde(rename = "isAuthenticating")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_authenticating: Option<bool>,
    /// Lines the auth flow wants shown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Vec<String>>,
    /// Failure message, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `{"type":"prompt_suggestion"}` (`sdk.d.ts:4832`). Arrives *after* the turn's `result`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptSuggestionMessage {
    /// The suggested next prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `{"type":"rate_limit_event"}` (`sdk.d.ts:4842`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RateLimitEventMessage {
    /// `SDKRateLimitInfo`; left untyped until the harness needs a field from it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limit_info: Option<Value>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `{"type":"conversation_reset"}` (`sdk.d.ts:4407`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationResetMessage {
    /// The conversation id that replaces the previous one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_conversation_id: Option<String>,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `{"type":"active_goal"}` (`sdk.d.ts:3240`). Not an `SDKMessage`; a raw NDJSON tap sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveGoalMessage {
    /// `{condition, iterations, set_at, tokens_at_start, last_reason?}` or `null`.
    #[serde(default)]
    pub value: Value,
    /// Frame uuid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// Session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `{"type":"keep_alive"}` (`sdk.d.ts:4536`). The SDK ignores it; so should the harness, but it
/// is proof the child is alive.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct KeepAliveMessage {
    /// Nothing is documented on this frame; anything present is kept here.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `{"type":"transcript_mirror"}`.
///
/// **`sdk.d.ts` has no type for this frame at all** — it exists only in `sdk.mjs:47224-47227`,
/// which reads `filePath` and `entries` off it. Per the "sdk.mjs wins" rule the fields are
/// transcribed from the bundle and left loosely typed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscriptMirrorMessage {
    /// Transcript file the entries belong to. CamelCase on the wire (`sdk.mjs:47224`).
    #[serde(rename = "filePath")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    /// Opaque transcript entries to append.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Value>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}
