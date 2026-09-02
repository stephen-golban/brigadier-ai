//! The control plane: `control_request`, `control_response` and `control_cancel_request`.
//!
//! The channel is symmetric — both sides send `control_request` and both answer with exactly one
//! `control_response` carrying the same `request_id` (`sdk.d.ts:4268-4270`). `request_id` has no
//! format or ordering requirement; the SDK uses
//! `Math.random().toString(36).substring(2,15)` (`sdk.mjs:47803`).
//!
//! Because the channel is symmetric, [`ControlRequest`] and [`ControlResponse`] are each used in
//! both directions; the per-subtype docs say who sends what.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::message::Extra;

literal_tag!(
    /// `type: "control_request"`.
    ControlRequestTag { ControlRequest => "control_request" }
);

literal_tag!(
    /// `type: "control_response"`.
    ControlResponseTag { ControlResponse => "control_response" }
);

literal_tag!(
    /// `type: "control_cancel_request"`.
    ControlCancelTag { ControlCancelRequest => "control_cancel_request" }
);

/// `{"type":"control_request", "request_id": ..., "request": {...}}` (`sdk.d.ts:4271-4278`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlRequest {
    /// Always `"control_request"`. Present as a field (rather than implied) so an encoded frame
    /// is byte-complete; defaulted so a hand-built request need not set it.
    #[serde(rename = "type", default)]
    pub kind: ControlRequestTag,
    /// Chosen by the sender, unique among its in-flight requests; the `control_response` and any
    /// `control_cancel_request` echo it.
    pub request_id: String,
    /// The request itself.
    pub request: ControlRequestBody,
}

impl ControlRequest {
    /// Builds a request with the `type` tag filled in.
    pub fn new(request_id: impl Into<String>, request: ControlRequestBody) -> Self {
        Self {
            kind: ControlRequestTag::ControlRequest,
            request_id: request_id.into(),
            request,
        }
    }
}

/// `{"type":"control_cancel_request", "request_id": ...}` — withdraws an in-flight request
/// (`sdk.d.ts:3524-3530`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlCancelRequest {
    /// Always `"control_cancel_request"`.
    #[serde(rename = "type", default)]
    pub kind: ControlCancelTag,
    /// The `request_id` of the `control_request` being withdrawn.
    pub request_id: String,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// The `request` payload, discriminated on `subtype`, with a lossless fallback.
///
/// `sdk.d.ts:4280` (`SDKControlRequestInner`) is **not** the full set: `sdk.mjs` still sends at
/// least `claude_authenticate`, `mcp_authenticate`, `channel_enable`, `set_cwd`, `side_question`
/// and eight more that the union omits (`docs/research/cli-protocol.md` §3). Those decode into
/// [`ControlRequestBody::Unknown`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ControlRequestBody {
    /// A modelled subtype. Boxed: the `initialize` payload dwarfs the others.
    Known(Box<ControlRequestKnown>),
    /// Any other subtype, kept verbatim.
    Unknown(ControlRequestUnknown),
}

/// A `control_request` subtype this crate models.
///
/// The first eight variants are the complete CLI → host set the SDK dispatches in
/// `processControlRequest` (`sdk.mjs:47362-47481`, `docs/research/cli-protocol.md` §2); the rest
/// are the host → CLI requests the harness sends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "subtype")]
pub enum ControlRequestKnown {
    /// CLI → host. The permission prompt, reached because the SDK spawns the CLI with
    /// `--permission-prompt-tool stdio` (`sdk.mjs:46441-46442`). Answer with
    /// [`PermissionResult`]. Never answer `null`: it sends nothing at all and parks the tool
    /// forever with no timeout (`sdk.mjs:47385`).
    #[serde(rename = "can_use_tool")]
    CanUseTool(CanUseToolRequest),
    /// CLI → host. A registered hook fired (`sdk.d.ts:4463-4470`). Answer with
    /// [`HookJsonOutput`].
    #[serde(rename = "hook_callback")]
    HookCallback(HookCallbackRequest),
    /// CLI → host. A JSON-RPC 2.0 message for an SDK-hosted MCP server
    /// (`sdk.d.ts:4094-4101`). Answer `{"mcp_response": <JSON-RPC response>}`.
    #[serde(rename = "mcp_message")]
    McpMessage(McpMessageRequest),
    /// CLI → host. An MCP elicitation (`sdk.d.ts:3535-3555`). Answer with the handler result, or
    /// `{"action":"decline"}` when unhandled (`sdk.mjs:47407-47427`).
    #[serde(rename = "elicitation")]
    Elicitation(ElicitationRequest),
    /// CLI → host. Render a tool-driven blocking dialog (`sdk.d.ts:4304-4315`). **Stay silent**
    /// for a `dialog_kind` not declared in `initialize.supportedDialogKinds`
    /// (`sdk.mjs:47428-47449`).
    #[serde(rename = "request_user_dialog")]
    RequestUserDialog(RequestUserDialogRequest),
    /// CLI → host, no fields. Answer `{"accessToken": ...}` or
    /// `{"accessToken": null, "reason": ...}` (`sdk.mjs:47450-47463`).
    #[serde(rename = "oauth_token_refresh")]
    OauthTokenRefresh(EmptyRequest),
    /// CLI → host, no fields. Answer `{"authToken": ...}` (`sdk.mjs:47464-47468`).
    #[serde(rename = "host_auth_token_refresh")]
    HostAuthTokenRefresh(EmptyRequest),
    /// CLI → host. Answer `{"work_secret": ...}` (`sdk.mjs:47469-47479`).
    #[serde(rename = "remote_control_work_secret")]
    RemoteControlWorkSecret(RemoteControlWorkSecretRequest),
    /// Host → CLI. The handshake; must be the first control request the host sends.
    #[serde(rename = "initialize")]
    Initialize(Box<InitializeRequest>),
    /// Host → CLI. Ends the current turn gracefully; the session survives and the CLI still
    /// emits a real `result` (`sdk.d.ts:4011-4020`).
    #[serde(rename = "interrupt")]
    Interrupt(InterruptRequest),
    /// Host → CLI, ack only (`sdk.mjs:47563-47565`).
    #[serde(rename = "set_permission_mode")]
    SetPermissionMode(SetPermissionModeRequest),
    /// Host → CLI, ack only (`sdk.mjs:47613-47615`).
    #[serde(rename = "set_model")]
    SetModel(SetModelRequest),
}

/// A `control_request` subtype this crate does not model, kept verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlRequestUnknown {
    /// The unmodelled subtype.
    pub subtype: String,
    /// The whole rest of the payload.
    #[serde(flatten)]
    pub extra: Extra,
}

/// A subtype that carries no fields of its own.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EmptyRequest {
    /// Anything the CLI adds later.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `can_use_tool` (`sdk.d.ts:4138-4181`). Only `tool_name`, `input` and `tool_use_id` are
/// required by the .d.ts; everything else is display or policy metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanUseToolRequest {
    /// Tool being asked about.
    pub tool_name: String,
    /// The tool's arguments, as the model produced them.
    pub input: Value,
    /// The tool call this ask belongs to (`sdk.d.ts:4174`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    /// Rule changes the CLI suggests the host offer (`coreTypes.PermissionUpdate[]`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_suggestions: Option<Value>,
    /// Path that triggered a path-based block.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_path: Option<String>,
    /// Human-readable escalation reason. **May carry ANSI escapes; sanitize before rendering**
    /// (`sdk.d.ts:4146-4147`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_reason: Option<String>,
    /// Structured escalation reason (`rule`, `mode`, `subcommandResults`, `safetyCheck`, …)
    /// (`sdk.d.ts:4150-4151`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_reason_type: Option<String>,
    /// Subagent that issued the call; absent for the main loop (`sdk.d.ts:4175`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Structured header title from the MCP permission display.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Short tool/server label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Consent subtitle.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `classifier_approvable`, `suppress_always_allow_rule`, `default_to_no`,
    /// `matched_ask_rule`, `requires_user_interaction` — carried but not typed here.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `hook_callback` (`sdk.d.ts:4463-4470`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookCallbackRequest {
    /// The opaque id the host registered in `initialize.hooks[...].hookCallbackIds`
    /// (`sdk.d.ts:4451-4457`); maps back to the host's handler.
    pub callback_id: String,
    /// The `HookInput` for the event that fired; a large discriminated union owned by the SDK,
    /// left untyped here.
    pub input: Value,
    /// Present for tool-scoped hook events.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `mcp_message` (`sdk.d.ts:4094-4101`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpMessageRequest {
    /// Which SDK-hosted MCP server the message is for.
    pub server_name: String,
    /// A JSON-RPC 2.0 request, notification or response.
    pub message: Value,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `elicitation` (`sdk.d.ts:3535-3555`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ElicitationRequest {
    /// MCP server asking.
    pub mcp_server_name: String,
    /// Prompt text.
    pub message: String,
    /// `"form"` or `"url"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// URL to open in `url` mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Correlates with the `system`/`elicitation_complete` frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elicitation_id: Option<String>,
    /// JSON Schema for the requested form.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_schema: Option<Value>,
    /// `title`, `display_name`, `description` — mirror `can_use_tool`'s.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `request_user_dialog` (`sdk.d.ts:4304-4315`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RequestUserDialogRequest {
    /// Open string union; a kind not declared in `initialize.supportedDialogKinds` must not be
    /// answered at all — an error response is discarded and the dialog stays pending, and
    /// `{"behavior":"cancelled"}` is a real settlement (`sdk.d.ts:4307-4309`).
    pub dialog_kind: String,
    /// Dialog-specific data, transported opaquely.
    pub payload: Value,
    /// Present for tool-driven dialogs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `remote_control_work_secret` (`sdk.mjs:47469-47479`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteControlWorkSecretRequest {
    /// Session the secret is wanted for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `initialize` — the handshake, host → CLI.
///
/// Transcribed from the payload literal `sdk.mjs` builds, in source order:
/// `hooks`, `sdkMcpServers`, `sdkMcpServerConfigs`, `jsonSchema`, `systemPrompt`,
/// `appendSystemPrompt`, `planModeInstructions`, `systemPromptSnapshot`,
/// `appendSubagentSystemPrompt`, `toolAliases`, `excludeDynamicSections`, `agents`, `title`,
/// `skills`, `webSearchIsolationExemptMcpServers`, `promptSuggestions`,
/// `agentProgressSummaries`, `forwardSubagentText`, `supportedDialogKinds`,
/// `perTaskStopAffordance` — 20 fields (`sdk.mjs:47516-47542`, minified `sdk.mjs:102`).
///
/// **`sdk.d.ts` and `sdk.mjs` disagree.** `SDKControlInitializeRequest` (`sdk.d.ts:3915-3970`)
/// omits `appendSubagentSystemPrompt` and `webSearchIsolationExemptMcpServers`, both of which
/// `sdk.mjs` sends today. Per the crate rule, `sdk.mjs` wins and both are present here.
///
/// Every field is optional: the CLI accepts a bare `{"subtype":"initialize"}`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InitializeRequest {
    /// `Partial<Record<HookEvent, SDKHookCallbackMatcher[]>>` — per event, a list of
    /// `{matcher?, hookCallbackIds, timeout?}`. Hooks are registered *here*, not by a separate
    /// call; the CLI then delivers `hook_callback` carrying one of the ids
    /// (`sdk.mjs:47489-47506`, `sdk.d.ts:4451-4457`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hooks: Option<Value>,
    /// Names of MCP servers the host serves over the `mcp_message` control channel.
    #[serde(rename = "sdkMcpServers")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sdk_mcp_servers: Option<Vec<String>>,
    /// Per-server settings for `sdkMcpServers`, keyed by name; unknown entries are ignored
    /// rather than rejected (`sdk.d.ts:3922`).
    #[serde(rename = "sdkMcpServerConfigs")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sdk_mcp_server_configs: Option<Value>,
    /// JSON Schema constraining the session's structured output.
    #[serde(rename = "jsonSchema")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json_schema: Option<Value>,
    /// System prompt blocks. A bare string option is widened to a one-element array by the SDK
    /// before it reaches the wire (`sdk.mjs:47516-47542`).
    #[serde(rename = "systemPrompt")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<Vec<String>>,
    /// Text appended to the preset system prompt.
    #[serde(rename = "appendSystemPrompt")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub append_system_prompt: Option<String>,
    /// Replaces the default plan-mode workflow body.
    #[serde(rename = "planModeInstructions")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_mode_instructions: Option<String>,
    /// Record the system prompt once and reuse it verbatim on resume (recommended `true`).
    #[serde(rename = "systemPromptSnapshot")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt_snapshot: Option<bool>,
    /// Text appended to every subagent's system prompt. **Absent from `sdk.d.ts:3915-3970`;
    /// present in `sdk.mjs:47516-47542`.**
    #[serde(rename = "appendSubagentSystemPrompt")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub append_subagent_system_prompt: Option<String>,
    /// Single-hop tool-name aliases applied before name resolution.
    #[serde(rename = "toolAliases")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_aliases: Option<Value>,
    /// Omit per-user dynamic sections from the cached system prompt and re-inject them as the
    /// first user message, so a static prefix can be cached across users.
    #[serde(rename = "excludeDynamicSections")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_dynamic_sections: Option<bool>,
    /// `Record<string, AgentDefinition>` — subagents defined by the host.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents: Option<Value>,
    /// Custom session title; skips automatic title generation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Allow-list of skill names for the main session; omit to load every discovered skill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<String>>,
    /// MCP servers exempt from web-search isolation. **Absent from `sdk.d.ts:3915-3970`;
    /// present in `sdk.mjs:47516-47542`.**
    #[serde(rename = "webSearchIsolationExemptMcpServers")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_search_isolation_exempt_mcp_servers: Option<Value>,
    /// Emit `prompt_suggestion` messages (they arrive after `result`).
    #[serde(rename = "promptSuggestions")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_suggestions: Option<bool>,
    /// Add `summary` to `system`/`task_progress`.
    #[serde(rename = "agentProgressSummaries")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_progress_summaries: Option<bool>,
    /// Forward subagent assistant text to the host.
    #[serde(rename = "forwardSubagentText")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forward_subagent_text: Option<bool>,
    /// `request_user_dialog` kinds the host can render. **Absence fails closed** — an
    /// undeclared kind degrades the flow rather than parking a dialog. First attached client
    /// wins (`sdk.d.ts:3964`).
    #[serde(rename = "supportedDialogKinds")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_dialog_kinds: Option<Vec<String>>,
    /// Declares a per-task stop control wired to `stop_task`. **Absence fails closed**: an
    /// interrupt then kills background tasks (`sdk.d.ts:3968`).
    #[serde(rename = "perTaskStopAffordance")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_task_stop_affordance: Option<bool>,
    /// Anything the CLI grows that this transcription predates.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `interrupt` (`sdk.d.ts:4011-4020`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InterruptRequest {
    /// Also cancel queued turns. Advertised by the `interrupt_cancel_queued_v1` capability on
    /// `system`/`init`; older CLIs ignore it and behave as `false`, leaving queued turns listed
    /// under the response's `still_queued`. The TypeScript `interrupt()` takes no parameters, so
    /// this is reachable from the SDK only via a cast (`docs/research/agent-sdk.md` §10).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancel_queued: Option<bool>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// The success payload of an `interrupt` (`sdk.d.ts:4021-4033`). `undefined` on CLIs that do not
/// advertise `interrupt_receipt_v1`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InterruptResponse {
    /// Queued commands that survived the interrupt.
    #[serde(default)]
    pub still_queued: Vec<String>,
    /// Queued commands cancelled because `cancel_queued` was set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<Vec<String>>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `set_permission_mode` (`sdk.d.ts:4375-4386`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SetPermissionModeRequest {
    /// One of `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto`
    /// (`sdk.d.ts:2293`). Kept as a `String`: the set is open in practice.
    pub mode: String,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

/// `set_model` (`sdk.d.ts:4363-4374`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SetModelRequest {
    /// Model to switch to. Omitted, `null` or `"default"` resets to the session default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Unknown fields.
    #[serde(flatten)]
    pub extra: Extra,
}

// ---------------------------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------------------------

/// `{"type":"control_response", "response": {...}}` (`sdk.d.ts:4320-4323`).
///
/// Used in both directions: the host sends one per CLI-originated request, and the CLI sends one
/// per host-originated request. [`ControlResponseIn`] is an alias naming the inbound direction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlResponse {
    /// Always `"control_response"`.
    #[serde(rename = "type", default)]
    pub kind: ControlResponseTag,
    /// Success or error, both echoing the originating `request_id`.
    pub response: ControlResponseBody,
}

/// The CLI → host direction of [`ControlResponse`], named for [`crate::Inbound`].
pub type ControlResponseIn = ControlResponse;

impl ControlResponse {
    /// Builds a success response carrying `payload` as its `response` object.
    ///
    /// # Errors
    /// Propagates a `serde_json` failure serialising `payload`.
    pub fn success<T: Serialize + ?Sized>(
        request_id: impl Into<String>,
        payload: &T,
    ) -> Result<Self, serde_json::Error> {
        Ok(Self {
            kind: ControlResponseTag::ControlResponse,
            response: ControlResponseBody::Success {
                subtype: ControlSuccessTag::Success,
                request_id: request_id.into(),
                response: Some(serde_json::to_value(payload)?),
                pending_permission_requests: None,
                pending_user_dialog_requests: None,
                extra: Extra::new(),
            },
        })
    }

    /// Builds a bare acknowledgement: `"response": {}`.
    ///
    /// The CLI 2.1.257 captures only ever show `"response":{}` on an ack
    /// (`crates/claude-spike/fixtures/*.ndjson`); **whether the CLI also accepts the key being
    /// absent is unproven**, so this emits the shape that was observed working.
    pub fn ack(request_id: impl Into<String>) -> Self {
        Self {
            kind: ControlResponseTag::ControlResponse,
            response: ControlResponseBody::Success {
                subtype: ControlSuccessTag::Success,
                request_id: request_id.into(),
                response: Some(Value::Object(serde_json::Map::new())),
                pending_permission_requests: None,
                pending_user_dialog_requests: None,
                extra: Extra::new(),
            },
        }
    }

    /// Builds an error response.
    pub fn error(request_id: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            kind: ControlResponseTag::ControlResponse,
            response: ControlResponseBody::Error {
                subtype: ControlErrorTag::Error,
                request_id: request_id.into(),
                error: error.into(),
                pending_permission_requests: None,
                pending_user_dialog_requests: None,
                extra: Extra::new(),
            },
        }
    }

    /// The `request_id` this response answers, whichever arm it is.
    ///
    /// `""` for a [`ControlResponseBody::Unknown`] frame that carried no string `request_id` —
    /// nothing correlates to it, and no live request can have that id.
    pub fn request_id(&self) -> &str {
        match &self.response {
            ControlResponseBody::Success { request_id, .. } => request_id,
            ControlResponseBody::Error { request_id, .. } => request_id,
            ControlResponseBody::Unknown(unknown) => unknown.request_id.as_deref().unwrap_or(""),
        }
    }
}

literal_tag!(
    /// `subtype: "success"` on a `control_response`.
    ControlSuccessTag { Success => "success" }
);

literal_tag!(
    /// `subtype: "error"` on a `control_response`.
    ControlErrorTag { Error => "error" }
);

/// `ControlResponse | ControlErrorResponse` (`sdk.d.ts:285-326`), with a lossless fallback.
///
/// `#[serde(untagged)]` rather than `#[serde(tag = "subtype")]`: an internally-tagged enum has no
/// catch-all arm, so a `subtype` this crate does not model — or a modelled one whose shape has
/// drifted — would fail the whole line. The `subtype` discriminant is therefore a literal-tag
/// field on each arm, matching how [`ControlRequestBody`] and `SystemMessage` are built. Encoding
/// is unchanged: `subtype` is still the first key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ControlResponseBody {
    /// The request was handled (`sdk.d.ts:308-326`).
    Success {
        /// Always `"success"`.
        subtype: ControlSuccessTag,
        /// The `request_id` this answers.
        request_id: String,
        /// The payload, shaped per the answered subtype; absent or `{}` for a bare ack.
        #[serde(skip_serializing_if = "Option::is_none")]
        response: Option<Value>,
        /// Permission requests still awaiting an answer; sent on the `initialize` response so a
        /// client joining an initialized session learns about in-flight prompts.
        #[serde(skip_serializing_if = "Option::is_none")]
        pending_permission_requests: Option<Vec<ControlRequest>>,
        /// `request_user_dialog` requests still awaiting an answer. A receiver must tolerate the
        /// same `request_id` also arriving as a live `control_request` and render it once.
        #[serde(skip_serializing_if = "Option::is_none")]
        pending_user_dialog_requests: Option<Vec<ControlRequest>>,
        /// Unknown fields.
        #[serde(flatten)]
        extra: Extra,
    },
    /// The request failed (`sdk.d.ts:285-303`).
    Error {
        /// Always `"error"`.
        subtype: ControlErrorTag,
        /// The `request_id` this answers.
        request_id: String,
        /// Human-readable failure description.
        error: String,
        /// See the `success` arm.
        #[serde(skip_serializing_if = "Option::is_none")]
        pending_permission_requests: Option<Vec<ControlRequest>>,
        /// See the `success` arm.
        #[serde(skip_serializing_if = "Option::is_none")]
        pending_user_dialog_requests: Option<Vec<ControlRequest>>,
        /// Unknown fields.
        #[serde(flatten)]
        extra: Extra,
    },
    /// A `subtype` this crate does not model, or a modelled one whose shape has drifted, kept
    /// verbatim. Must stay last.
    Unknown(ControlResponseUnknown),
}

/// The fallback arm of [`ControlResponseBody`]: whatever the frame was, with the `request_id`
/// pulled out so a response the harness cannot interpret can still be correlated to the request
/// it answers.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ControlResponseUnknown {
    /// The `request_id` this answers, when the frame carries a string one. Lenient: a drifted
    /// `request_id` reads as `None` rather than failing this last-resort arm.
    #[serde(default, deserialize_with = "crate::message::lenient")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// The whole rest of the frame, `subtype` included.
    #[serde(flatten)]
    pub extra: Extra,
}

/// The answer to `can_use_tool` (`sdk.d.ts:2315-2327`), sent as the `response` object of a
/// success [`ControlResponse`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "behavior")]
pub enum PermissionResult {
    /// Run the tool.
    #[serde(rename = "allow")]
    Allow {
        /// Arguments to run instead of the model's. Omit to run the model's unchanged.
        #[serde(rename = "updatedInput", skip_serializing_if = "Option::is_none")]
        updated_input: Option<Value>,
        /// `PermissionUpdate[]` the CLI should persist alongside this decision.
        #[serde(rename = "updatedPermissions", skip_serializing_if = "Option::is_none")]
        updated_permissions: Option<Value>,
        /// Echoes the ask's `tool_use_id` (`toolUseID`, camelCase with a capital D).
        #[serde(rename = "toolUseID", skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
        /// Telemetry classification of how the decision was reached.
        #[serde(
            rename = "decisionClassification",
            skip_serializing_if = "Option::is_none"
        )]
        decision_classification: Option<String>,
    },
    /// Refuse the tool.
    #[serde(rename = "deny")]
    Deny {
        /// Required. Shown to the model as the refusal reason.
        message: String,
        /// Also end the turn, not just this call.
        #[serde(skip_serializing_if = "Option::is_none")]
        interrupt: Option<bool>,
        /// Echoes the ask's `tool_use_id`.
        #[serde(rename = "toolUseID", skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
        /// Telemetry classification of how the decision was reached.
        #[serde(
            rename = "decisionClassification",
            skip_serializing_if = "Option::is_none"
        )]
        decision_classification: Option<String>,
    },
}

impl PermissionResult {
    /// Allow the call with the model's own arguments.
    pub fn allow() -> Self {
        Self::Allow {
            updated_input: None,
            updated_permissions: None,
            tool_use_id: None,
            decision_classification: None,
        }
    }

    /// Deny the call with a reason for the model.
    pub fn deny(message: impl Into<String>) -> Self {
        Self::Deny {
            message: message.into(),
            interrupt: None,
            tool_use_id: None,
            decision_classification: None,
        }
    }
}

/// The answer to `hook_callback`: the synchronous arm of `HookJSONOutput`
/// (`SyncHookJSONOutput`, `sdk.d.ts:8373-8392`).
///
/// The asynchronous arm (`AsyncHookJSONOutput`, `sdk.d.ts:129-132`, `{async: true,
/// asyncTimeout?}`) is not modelled: the harness answers hooks synchronously. Send it through
/// `extra` if that changes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HookJsonOutput {
    /// `false` stops the session after this hook.
    #[serde(rename = "continue", skip_serializing_if = "Option::is_none")]
    pub continue_: Option<bool>,
    /// Hide the hook's stdout from the transcript.
    #[serde(rename = "suppressOutput", skip_serializing_if = "Option::is_none")]
    pub suppress_output: Option<bool>,
    /// Reason shown when `continue` is `false`.
    #[serde(rename = "stopReason", skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    /// `"approve"` or `"block"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    /// Reason for `decision`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Message surfaced to the user.
    #[serde(rename = "systemMessage", skip_serializing_if = "Option::is_none")]
    pub system_message: Option<String>,
    /// Per-event payload (`PreToolUseHookSpecificOutput` and 21 siblings, `sdk.d.ts:8386`).
    /// Left untyped — it is one union per hook event and the harness passes it through.
    #[serde(rename = "hookSpecificOutput", skip_serializing_if = "Option::is_none")]
    pub hook_specific_output: Option<Value>,
    /// `terminalSequence` and anything added later.
    #[serde(flatten)]
    pub extra: Extra,
}
