//! The normalized provider model: what every adapter reports, whatever its CLI speaks.
//!
//! These types are part of the wire contract (they are stored as event payloads and exported to
//! TypeScript), so field names are camelCase and enums are internally tagged.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A CLI Brigadier can drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    Claude,
    Codex,
}

impl ProviderKind {
    pub const ALL: [ProviderKind; 2] = [ProviderKind::Claude, ProviderKind::Codex];

    /// The product name shown to the user.
    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
        }
    }

    /// The binary name looked up on the login shell's PATH.
    pub fn binary(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

impl std::fmt::Display for ProviderKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        })
    }
}

/// Whether a CLI is installed and logged in, with what to do when it is not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: ProviderKind,
    /// Absolute path of the binary, when found.
    pub path: Option<String>,
    pub version: Option<String>,
    pub logged_in: bool,
    /// How the CLI is authenticated (`claude.ai`, `chatgpt`, `api key`, …).
    pub auth_method: Option<String>,
    /// Subscription plan, when the CLI reports one.
    pub plan: Option<String>,
    /// What the user should do before this provider can be used. Absent when ready.
    pub guidance: Option<String>,
}

/// A model a provider offers, as the CLI itself reports it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// The value passed back to the CLI to select this model.
    pub id: String,
    pub display_name: String,
    pub description: String,
    /// The concrete model an alias resolves to, when the CLI says.
    pub resolved: Option<String>,
    /// Reasoning effort levels the model accepts, lowest first. Empty when it has none.
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    pub is_default: bool,
    /// Input kinds the model accepts (`text`, `image`).
    pub input_modalities: Vec<String>,
}

/// A provider's model list with its provenance, as cached on disk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub provider: ProviderKind,
    pub models: Vec<ModelInfo>,
    /// Version of the CLI that reported the list.
    pub cli_version: Option<String>,
    pub fetched_at_ms: i64,
}

/// One usage window (Claude's 5-hour and weekly windows, Codex's primary and secondary).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    /// Stable identifier (`five_hour`, `seven_day`, `primary`, `secondary`, …).
    pub id: String,
    pub label: String,
    /// Share of the window used, 0–100.
    pub used_percent: f64,
    pub resets_at_ms: Option<i64>,
    pub window_minutes: Option<i64>,
}

/// Remaining quota as last reported by a provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSnapshot {
    pub provider: ProviderKind,
    pub windows: Vec<QuotaWindow>,
    /// Set while the provider refuses work because a limit was reached.
    pub limit: Option<LimitHit>,
    pub observed_at_ms: i64,
}

/// A reached limit and when it lifts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LimitHit {
    /// The window that ran out, when known (`five_hour`, `seven_day`, `primary`, …).
    pub window: Option<String>,
    pub resets_at_ms: Option<i64>,
}

/// What went wrong, classified so the router can react (fallback, wait, ask the user).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// A subscription usage window is exhausted; work resumes after the reset.
    UsageLimit,
    /// Short-term request throttling; retrying soon succeeds.
    RateLimit,
    /// The provider is overloaded or unavailable.
    Overloaded,
    /// Not logged in, or the login expired.
    Auth,
    /// Billing or credits problem on the account.
    Billing,
    /// The conversation no longer fits the model's context window.
    ContextWindow,
    /// The request was rejected as invalid.
    InvalidRequest,
    /// Content or safety policy refusal.
    Policy,
    /// The connection to the provider failed.
    Network,
    /// The CLI's sandbox got in the way.
    Sandbox,
    /// The provider or the CLI failed internally.
    Server,
    /// The CLI process itself failed (did not start, crashed, spoke garbage).
    Process,
    Other,
}

/// A classified provider error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderError {
    pub kind: ErrorKind,
    pub message: String,
    /// The CLI retries on its own; nothing to do yet.
    pub will_retry: bool,
    /// For limit errors: which window and when it resets.
    pub limit: Option<LimitHit>,
    /// The provider's own error code, for debugging (`rate_limit`, `usageLimitExceeded`, …).
    pub code: Option<String>,
}

/// Something a session wants permission for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalKind {
    /// Run a shell command.
    Command,
    /// Write or edit files.
    FileChange,
    /// Use some other tool.
    Tool,
    /// Widen the session's permissions (more paths, network).
    Permissions,
}

/// A permission request from a CLI, routed to Brigadier.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    /// Unique within the session; used to answer.
    pub id: String,
    pub kind: ApprovalKind,
    /// The CLI's tool name (`Bash`, `Edit`, `commandExecution`, …).
    pub tool: String,
    /// The command line, for command approvals.
    pub command: Option<String>,
    pub cwd: Option<String>,
    /// Files involved, for file changes.
    pub paths: Vec<String>,
    /// Why the CLI asks, in its own words.
    pub reason: Option<String>,
    /// The request is to run outside the OS sandbox or to widen it.
    pub escalation: bool,
    /// The tool input as JSON text, for display.
    pub input: Option<String>,
}

/// The answer to an [`ApprovalRequest`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ApprovalDecision {
    Allow,
    Deny { message: String },
}

/// Who answered an approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Decider {
    /// Brigadier's policy, on the user's behalf.
    Policy,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    User,
    Assistant,
}

/// Where a tool call, command or file change stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    InProgress,
    Completed,
    Failed,
    Declined,
}

/// How a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    Completed,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    Add,
    Update,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub kind: FileChangeKind,
}

/// Token usage, as totals for the session so far or for one turn.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub cache_write_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    /// Cost reported by the CLI, when it reports one.
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum NoticeLevel {
    Info,
    Warning,
}

/// Everything a provider session reports, in one vocabulary for every CLI.
///
/// Streaming text arrives as `*Delta` events keyed by `itemId`; the matching final event
/// (`message`, `reasoning`) carries the complete text and replaces whatever the deltas built.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProviderEvent {
    /// The CLI accepted the session. `nativeId` is its own session or thread id.
    SessionStarted {
        native_id: String,
        model: Option<String>,
        cwd: Option<String>,
        cli_version: Option<String>,
    },
    TurnStarted {
        turn_id: Option<String>,
    },
    MessageDelta {
        item_id: String,
        text: String,
    },
    Message {
        item_id: String,
        role: Role,
        text: String,
    },
    ReasoningDelta {
        item_id: String,
        text: String,
    },
    /// A reasoning summary (the model's own words about its thinking).
    Reasoning {
        item_id: String,
        text: String,
    },
    ToolCall {
        item_id: String,
        name: String,
        /// Tool input as JSON text, once complete.
        input: Option<String>,
        status: ItemStatus,
        /// Result text (truncated), once finished.
        output: Option<String>,
    },
    Command {
        item_id: String,
        command: String,
        cwd: Option<String>,
        status: ItemStatus,
        exit_code: Option<i32>,
        /// Combined output (truncated), once finished.
        output: Option<String>,
        duration_ms: Option<i64>,
    },
    CommandOutputDelta {
        item_id: String,
        text: String,
    },
    FileChanges {
        item_id: String,
        changes: Vec<FileChange>,
        status: ItemStatus,
    },
    /// A generated image.
    Image {
        item_id: String,
        status: ItemStatus,
        path: Option<String>,
        prompt: Option<String>,
    },
    Usage {
        /// Totals for the session so far.
        total: TokenUsage,
    },
    ContextSize {
        used_tokens: i64,
        window_tokens: Option<i64>,
    },
    RateLimits {
        quota: QuotaSnapshot,
    },
    ApprovalRequested {
        request: ApprovalRequest,
    },
    ApprovalResolved {
        id: String,
        decision: ApprovalDecision,
        decided_by: Decider,
    },
    TurnCompleted {
        turn_id: Option<String>,
        status: TurnStatus,
        duration_ms: Option<i64>,
        usage: Option<TokenUsage>,
    },
    Error {
        error: ProviderError,
    },
    Notice {
        level: NoticeLevel,
        message: String,
    },
    /// The CLI process ended.
    Exited {
        code: Option<i32>,
        /// The last lines it wrote to stderr, when it failed.
        stderr_tail: Option<String>,
    },
}

/// What a session is allowed to do. The CLI's own OS sandbox enforces it; the always-ask list
/// ([`crate::policy::ALWAYS_ASK`]) applies at every level.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Access {
    /// Full-auto inside the OS sandbox: write only the working directory and `extraRoots`,
    /// network on. Anything else is an approval request.
    Workspace {
        #[ts(as = "Vec<String>")]
        extra_roots: Vec<PathBuf>,
    },
    /// Read-only sandbox: every write or command that needs approval goes to Brigadier.
    ReadOnly,
    /// No OS sandbox.
    Full,
}

/// How a session begins.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Origin {
    New,
    /// Continue the CLI session or thread `nativeId`.
    Resume {
        native_id: String,
    },
    /// Branch a new session off `nativeId`, leaving the original untouched.
    Fork {
        native_id: String,
    },
}

/// Everything needed to start a provider session.
#[derive(Debug, Clone)]
pub struct SessionSpec {
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub origin: Origin,
    pub access: Access,
    /// Appended to the CLI's own system prompt.
    pub append_system_prompt: Option<String>,
    /// MCP servers for the session, as an `mcpServers` object. Only these are loaded.
    pub mcp_servers: serde_json::Map<String, serde_json::Value>,
    /// Records the raw stdio exchange to this file (JSONL), for replay fixtures.
    pub record_to: Option<PathBuf>,
}

/// Something a session created that must be removed when it is disposed of. Recorded in the
/// session's cleanup ledger the moment it is known.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Artifact {
    /// A CLI process and its process group.
    Process {
        pid: u32,
        /// Start time, to tell it apart from a later process that reused the pid.
        started_at_ms: Option<f64>,
    },
    /// A Claude Code session: its transcript and per-session state under the config directory.
    ClaudeSession { session_id: String },
    /// A Claude Code project directory (`projects/<encoded cwd>`) that did not exist before.
    ClaudeProjectDir { path: String },
    /// A Codex thread: its rollout file and state records, removed through `thread/delete`.
    CodexThread { thread_id: String },
}
