//! The normalized provider model: what every adapter reports, whatever its CLI speaks.
//!
//! These types are part of the wire contract (they are stored as event payloads and exported to
//! TypeScript), so field names are camelCase and enums are internally tagged.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::redact::Redactor;

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
    /// Its version can compact a session's context on request
    /// ([`ProviderSession::compact`](crate::ProviderSession::compact)).
    #[serde(default)]
    pub compacts: bool,
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
    /// Set when the user may allow this exact command for the rest of the CLI session
    /// ([`ApprovalDecision::AllowSimilar`]): the command as shown.
    #[serde(default)]
    pub grant: Option<String>,
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
    /// Allow, and allow the same command again for the rest of the CLI session without
    /// asking ("Don't ask again for this command"). Never persisted.
    AllowSimilar,
    Deny {
        message: String,
    },
}

/// Who answered an approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Decider {
    /// Brigadier's policy, on the user's behalf.
    Policy,
    User,
    /// Replayed from a recording, which keeps the answer but not who gave it.
    Recorded,
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
    /// The CLI began compacting the conversation (summarizing it to free up context): asked
    /// to ([`ProviderSession::compact`](crate::ProviderSession::compact)), or on its own
    /// (`automatic`) as the context filled up.
    CompactionStarted {
        automatic: bool,
    },
    /// The compaction ended: the context before and after it, when the CLI says, or why it
    /// failed.
    CompactionEnded {
        automatic: bool,
        tokens_before: Option<i64>,
        tokens_after: Option<i64>,
        error: Option<String>,
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
    /// A worker's sandbox, each part set on its own. Everything is readable except
    /// `denyRead` (where the CLI's sandbox can deny reads).
    Scoped {
        /// The working directory is writable. Codex always makes it writable, so a read-only
        /// Codex worker runs in its scratch folder instead.
        write_cwd: bool,
        #[ts(as = "Vec<String>")]
        writable_roots: Vec<PathBuf>,
        network: bool,
        #[ts(as = "Vec<String>")]
        deny_read: Vec<PathBuf>,
        /// Unix sockets it may connect to (Brigadier's, for the command gate).
        #[ts(as = "Vec<String>")]
        unix_sockets: Vec<PathBuf>,
    },
}

impl Access {
    /// Directories the session may write besides its working directory.
    pub fn writable_roots(&self) -> &[PathBuf] {
        match self {
            Self::Workspace { extra_roots } => extra_roots,
            Self::Scoped { writable_roots, .. } => writable_roots,
            Self::ReadOnly | Self::Full => &[],
        }
    }
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

/// A file sent with a turn. Images reach the model as images; other files are named by path,
/// for a session that can read them.
#[derive(Debug, Clone, PartialEq)]
pub struct InputFile {
    pub path: PathBuf,
    /// The name the user gave it (the file's own name when attached).
    pub name: String,
    pub mime: String,
}

impl InputFile {
    pub fn is_image(&self) -> bool {
        matches!(
            self.mime.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        )
    }
}

/// What a turn (or a steer) sends: text, files, or both.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnInput {
    pub text: String,
    pub files: Vec<InputFile>,
}

impl TurnInput {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            files: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty() && self.files.is_empty()
    }

    /// The text followed by a line per file that is not an image, naming where it is.
    pub fn text_with_file_notes(&self) -> String {
        let mut text = self.text.clone();
        for file in self.files.iter().filter(|file| !file.is_image()) {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&format!(
                "[Attached file \"{}\" ({}): {}]",
                file.name,
                file.mime,
                file.path.display()
            ));
        }
        text
    }
}

impl From<String> for TurnInput {
    fn from(text: String) -> Self {
        Self::text(text)
    }
}

/// Which of the CLI's built-in tools a session gets.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ToolSet {
    /// The CLI's usual tools (workers, raw sessions).
    #[default]
    Default,
    /// None at all: only the MCP servers given (the orchestrator).
    None,
    /// Web search and fetch only (Chats).
    Web,
}

/// An MCP server a session gets, launched by the CLI over stdio.
#[derive(Debug, Clone, PartialEq)]
pub struct McpServer {
    pub name: String,
    pub command: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Its tools may run for this long (a worker's blocking question waits for an answer).
    pub tool_timeout_secs: Option<u64>,
    /// Its tool calls run without asking for approval (Brigadier's own server).
    pub trusted: bool,
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
    /// MCP servers for the session. Only these are loaded.
    pub mcp_servers: Vec<McpServer>,
    pub tools: ToolSet,
    /// Extra environment for the CLI and everything it starts (the process tag, the command
    /// gate).
    pub env: Vec<(String, String)>,
    /// Directories put first on the CLI's PATH (the command gate's shims).
    pub path_prepend: Vec<PathBuf>,
    /// Records the raw stdio exchange to this file (JSONL), for replay fixtures.
    pub record_to: Option<PathBuf>,
    /// Secret values (the project's secret files, the session's grants) replaced in every
    /// event, logged stderr line and recorded line before they leave the adapter.
    pub redactor: Option<Arc<Redactor>>,
    /// `cwd` is a folder Brigadier created for this session (an orchestrator folder, a worker
    /// worktree or scratch folder, a Chat folder). Only then may the adapter record and later
    /// undo what the CLI persists about that exact folder in the user's own configuration
    /// (Codex's project trust entry). Raw sessions in the user's folders are never owned.
    pub owned_cwd: bool,
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
    /// Claude Code's write-staging directory in the working directory (`.claude/.cc-writes`,
    /// or `.claude` itself when that did not exist). Removed only while it holds no files.
    ClaudeStagingDir { path: String },
    /// A Codex thread: its rollout file and state records, removed through `thread/delete`.
    CodexThread { thread_id: String },
    /// The folder where Codex saves a thread's generated images
    /// (`$CODEX_HOME/generated_images/<thread id>`), which deleting the thread leaves behind.
    CodexGeneratedImages { path: String },
    /// A project trust entry Codex persisted in the user's `config.toml` when a thread started
    /// there. Removed through Codex's config API, only while it is still just `trusted`.
    CodexProjectTrust { path: String },
    /// Every process working inside `dir`, a folder Brigadier created (a worktree, a scratch
    /// folder): what a worker started there, including processes that left its tree.
    ProcessesIn { dir: String },
    /// A git worktree Brigadier created (for a task or a session) in its data directory.
    Worktree { repo: String, path: String },
    /// A folder Brigadier created in its data directory (a worker's scratch folder, the
    /// orchestrator's or a Chat's working folder).
    ScratchDir { path: String },
    /// A short temp folder of a Claude session's own (`/tmp/brigadier-<id>`), for Claude's
    /// temp files and its sandboxed commands' TMPDIR.
    ClaudeTempDir { path: String },
}
