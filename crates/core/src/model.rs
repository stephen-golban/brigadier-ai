//! Domain model. These types are the wire contract too: they are exported to TypeScript.

use std::collections::HashMap;

use brigadier_providers::{
    Access, Artifact, ModelCatalog, ProviderEvent, ProviderKind, ProviderStatus, QuotaSnapshot,
};

use crate::work::{
    Approval, AttachmentRef, Compaction, MessageQueue, OrchestratorEntry, OrchestratorStep, Plan,
    Question, RunState, Task, UserRequest, WorkerStep,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

macro_rules! id_type {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        // Serde serializes newtypes as their inner string.
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
        pub struct $name(pub String);

        impl $name {
            pub fn generate() -> Self {
                Self(uuid::Uuid::now_v7().to_string())
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

id_type!(
    /// Identifies a project.
    ProjectId
);
id_type!(
    /// Identifies a session or a chat.
    ConversationId
);

impl ConversationId {
    /// The last 8 characters (random in a v7 uuid): the session's part of the branch and
    /// folder names Brigadier creates for it.
    pub fn short(&self) -> &str {
        &self.0[self.0.len().saturating_sub(8)..]
    }
}

id_type!(
    /// Identifies a raw provider session (a CLI session driven from the Inspector).
    RawSessionId
);
id_type!(
    /// Identifies a delegated task (and its worker).
    TaskId
);
id_type!(
    /// Identifies a card waiting for the user: an approval, a question or a plan.
    CardId
);

/// A workspace of one or more repos. Owns its sessions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub created_at_ms: i64,
    /// The project's repositories. Sessions work in the first one until multi-repo projects
    /// (Phase 8).
    #[serde(default)]
    pub repos: Vec<ProjectRepo>,
    /// Choices remembered for the project's next session.
    #[serde(default)]
    pub prefs: ProjectPrefs,
}

/// A git repository in a project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepo {
    /// Absolute path of the repository's top-level directory (the user's own checkout).
    pub path: String,
    pub name: String,
}

/// What a project remembers from its last session setup, plus its secrets list.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectPrefs {
    /// Absent: the global default from Settings.
    pub permission: Option<PermissionLevel>,
    /// Orchestrator provider, model and effort. Absent: the global default.
    pub orchestrator: Option<ModelChoice>,
    pub environment: Option<EnvironmentKind>,
    /// Gitignored env files (paths relative to the repository root) copied into every worker
    /// worktree. Their values are redacted everywhere Brigadier shows or stores text.
    pub secret_files: Vec<String>,
}

/// How much a session may do on its own (PLAN.md §5). Outward actions always ask.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PermissionLevel {
    /// You approve every plan and every landed change. Sandboxed.
    AskForApproval,
    /// Brigadier approves on your behalf and stops only for questions only you can answer.
    /// Sandboxed.
    #[default]
    ApproveForMe,
    /// Approve for me without the OS sandbox.
    FullAccess,
}

/// A provider, model and reasoning effort, as picked in the composer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub provider: ProviderKind,
    /// The CLI's model id. Absent: the CLI's own default.
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum EnvironmentKind {
    LocalCheckout,
    NewWorktree,
}

/// Where a session's accepted work lands, as asked for in the composer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EnvironmentRequest {
    /// Commits land on `branch` in the user's own checkout.
    LocalCheckout {
        branch: String,
        /// "New branch…": create `branch` from this branch or commit first.
        create_from: Option<String>,
    },
    /// The session gets its own worktree on a new branch from `base`, merged back on approval.
    NewWorktree {
        base: String,
        /// The session branch's name. Absent: Brigadier names it (`brigadier/<session>/session`).
        branch: Option<String>,
    },
}

/// A session's environment once set up.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Environment {
    LocalCheckout {
        branch: String,
    },
    NewWorktree {
        base: String,
        branch: String,
        /// The session worktree, in Brigadier's data directory. Absent until it is created.
        path: Option<String>,
        /// The commit the session branch starts from (a fork's point). Absent: `base`'s tip.
        #[serde(default)]
        start: Option<String>,
    },
}

/// Where a forked session works.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ForkPlace {
    /// In the user's checkout, on a new branch from the fork's point.
    Workspace,
    /// In a worktree of its own, on a new branch from the fork's point.
    NewWorktree,
}

/// The conversation and answer a fork continues from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ForkOrigin {
    pub conversation_id: ConversationId,
    /// The answer it was forked from: the last message it copied.
    pub message_id: String,
}

/// What a new conversation is set up with, from the composer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SetupRequest {
    Session {
        /// One of the project's repositories.
        repo: String,
        environment: EnvironmentRequest,
        permission: PermissionLevel,
        orchestrator: ModelChoice,
    },
    Chat {
        model: ModelChoice,
    },
}

/// What the user thought of an answer ("Good response" / "Bad response").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Rating {
    Good,
    Bad,
}

/// How a conversation is set up.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Setup {
    Session {
        repo: String,
        environment: Environment,
        permission: PermissionLevel,
        orchestrator: ModelChoice,
        /// Local checkout with uncommitted changes: whether workers start from them. Absent
        /// until the user answered (or when the checkout was clean).
        workers_see_uncommitted: Option<bool>,
    },
    Chat {
        model: ModelChoice,
    },
}

impl Setup {
    /// The setup a composer request asks for. A new-worktree session without a branch name
    /// gets `brigadier/<id.short()>/session`, next to its task branches; the runtime creates
    /// the branch and worktree when the session starts.
    pub fn from_request(request: SetupRequest, id: &ConversationId) -> Self {
        match request {
            SetupRequest::Session {
                repo,
                environment,
                permission,
                orchestrator,
            } => Self::Session {
                repo,
                environment: match environment {
                    EnvironmentRequest::LocalCheckout { branch, .. } => {
                        Environment::LocalCheckout { branch }
                    }
                    EnvironmentRequest::NewWorktree { base, branch } => Environment::NewWorktree {
                        base,
                        branch: branch
                            .filter(|branch| !branch.trim().is_empty())
                            .unwrap_or_else(|| format!("brigadier/{}/session", id.short())),
                        path: None,
                        start: None,
                    },
                },
                permission,
                orchestrator,
                workers_see_uncommitted: None,
            },
            SetupRequest::Chat { model } => Self::Chat { model },
        }
    }
}

/// Changes to a project; absent fields stay as they are.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectPatch {
    pub name: Option<String>,
    /// Absolute paths of the project's repositories (replaces the list).
    pub repos: Option<Vec<String>>,
    pub prefs: Option<ProjectPrefs>,
}

/// Where a conversation is in its lifecycle (PLAN.md §5). Deleted conversations leave the
/// catalog.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Lifecycle {
    #[default]
    Active,
    /// Idle: its CLI processes stopped and temp files are gone; the next message continues it.
    Hibernated,
    /// Hidden in the Archived view; everything it created was cleaned up. Restorable.
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ConversationKind {
    /// An orchestrator conversation inside a project.
    Session,
    /// A plain conversation with the picked model, outside any project.
    Chat,
}

/// A session (inside a project) or a chat (outside any project), as listed in the sidebar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: ConversationId,
    pub kind: ConversationKind,
    /// Set for sessions, absent for chats.
    pub project_id: Option<ProjectId>,
    pub title: String,
    /// When it was pinned; absent when not pinned.
    pub pinned_at_ms: Option<i64>,
    pub created_at_ms: i64,
    /// Last activity (creation, rename, pin, message).
    pub updated_at_ms: i64,
    /// Absent for conversations created before setups existed (they get one on first use).
    #[serde(default)]
    pub setup: Option<Setup>,
    #[serde(default)]
    pub lifecycle: Lifecycle,
    /// Set for a fork: where it continues from ("Continued from chat").
    #[serde(default)]
    pub forked_from: Option<ForkOrigin>,
}

/// Something a user message @-mentions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Mention {
    /// A worker of the conversation.
    Task { id: TaskId },
    /// A file of the session's checkout, relative to its root.
    File { path: String },
    /// Another conversation: its recent messages go along as context.
    Chat { id: ConversationId, title: String },
}

/// Also reads mentions stored before files and chats could be mentioned: a bare task id.
impl<'de> Deserialize<'de> for Mention {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(tag = "type", rename_all = "camelCase")]
        enum Tagged {
            Task { id: TaskId },
            File { path: String },
            Chat { id: ConversationId, title: String },
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Stored {
            Tagged(Tagged),
            Task(TaskId),
        }
        Ok(match Stored::deserialize(deserializer)? {
            Stored::Tagged(Tagged::Task { id }) | Stored::Task(id) => Mention::Task { id },
            Stored::Tagged(Tagged::File { path }) => Mention::File { path },
            Stored::Tagged(Tagged::Chat { id, title }) => Mention::Chat { id, title },
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

/// One message in a conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub conversation_id: ConversationId,
    /// Position in the conversation, starting at 1.
    pub seq: i64,
    pub role: MessageRole,
    /// The text, or its first part when `blob` is set.
    pub text: String,
    /// Content hash of the full text when it was too large to keep inline.
    pub blob: Option<String>,
    pub created_at_ms: i64,
    #[serde(default)]
    pub attachments: Vec<AttachmentRef>,
    /// What the message @-mentions: workers, files, other conversations.
    #[serde(default)]
    pub mentions: Vec<Mention>,
    /// For assistant messages: the model that wrote it (a Chat may fall back to another).
    #[serde(default)]
    pub model: Option<ModelChoice>,
    /// The user request it belongs to: its own id for a user message, the request the
    /// model was serving for a reply. Absent for messages from before requests existed.
    #[serde(default)]
    pub request_id: Option<String>,
    /// The message before it on its branch; empty for a first message that replaced another
    /// (an edit). Absent for messages from before branches existed: those follow the message
    /// before them.
    #[serde(default)]
    pub parent_id: Option<String>,
}

/// Global size and spacing scale for every control.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Density {
    Compact,
    #[default]
    Normal,
}

/// User settings persisted by the core.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub density: Density,
    /// Permission level for projects that have not remembered one.
    pub default_permission: PermissionLevel,
    /// Orchestrator model for projects that have not remembered one. Absent: the first
    /// logged-in provider's default model.
    pub default_orchestrator: Option<ModelChoice>,
    /// Model for new Chats. Absent: as for the orchestrator.
    pub default_chat_model: Option<ModelChoice>,
    /// Messages sent while a turn runs wait in the queue; off: they steer the running turn.
    pub queue_enabled: bool,
    /// A conversation with nothing running hibernates after this many idle minutes.
    pub hibernate_after_minutes: u32,
    /// The composer shows how full the model's context is (a ring by the model picker).
    pub show_context_usage: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            density: Density::default(),
            default_permission: PermissionLevel::default(),
            default_orchestrator: None,
            default_chat_model: None,
            queue_enabled: false,
            hibernate_after_minutes: 30,
            show_context_usage: true,
        }
    }
}

/// Everything the sidebar needs, in one read.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub projects: Vec<Project>,
    pub conversations: Vec<Conversation>,
    pub settings: Settings,
}

/// A page of messages, oldest first.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<Message>,
    /// Whether older messages exist before the first one returned.
    pub has_more: bool,
}

/// Text an assistant is still writing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StreamingMessage {
    pub message_id: String,
    pub text: String,
    /// The request the running turn serves.
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub level: brigadier_providers::NoticeLevel,
    pub text: String,
    pub at_ms: i64,
}

/// How full the conversation model's context is, as its CLI last said.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub used_tokens: i64,
    /// Absent when the CLI does not say.
    pub window_tokens: Option<i64>,
}

/// What `/status` shows for a conversation: its model's CLI session and the usage left.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationStatus {
    /// The CLI serving the conversation's model (a session's orchestrator).
    pub provider: ProviderKind,
    /// Its own id for the session (Claude session, Codex thread); absent until it first ran.
    pub native_id: Option<String>,
    /// The provider's usage windows, as it last reported them.
    pub quota: Option<QuotaSnapshot>,
}

/// Everything a conversation view shows, in one read. Live changes follow on the
/// conversation's event stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationView {
    pub conversation: Conversation,
    /// How full its model's context is; absent until its CLI first said.
    pub context: Option<ContextUsage>,
    /// The newest page of messages.
    pub messages: MessagePage,
    pub tasks: Vec<Task>,
    pub approvals: Vec<Approval>,
    pub questions: Vec<Question>,
    pub plans: Vec<Plan>,
    /// Every request of the conversation, oldest first.
    pub requests: Vec<UserRequest>,
    /// Every worker step, in the order they happened.
    pub worker_steps: Vec<WorkerStep>,
    /// Every orchestrator step, in the order they happened.
    pub orchestrator_steps: Vec<OrchestratorStep>,
    /// Every compaction of a Chat's context, in the order they happened.
    pub compactions: Vec<Compaction>,
    pub queue: MessageQueue,
    pub run: RunState,
    /// The request the running turn serves.
    pub run_request: Option<String>,
    /// The last message of the branch the thread shows (the newest message until the user
    /// edits, regenerates or switches branches).
    pub head: Option<String>,
    /// The user's ratings of answers, by subject (see `DomainEvent::MessageRated`).
    pub ratings: HashMap<String, Rating>,
    pub streaming: Option<StreamingMessage>,
    /// The latest notices (environment problems, fallbacks), newest last.
    pub notices: Vec<Notice>,
}

/// A branch, for the composer's branch picker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub commit: String,
    /// The worktree that has it checked out (the user's checkout or another), if any.
    pub checked_out_at: Option<String>,
}

/// A repository's state, for the composer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// The repository's top-level directory.
    pub path: String,
    pub name: String,
    /// The branch checked out in the user's checkout; absent when detached.
    pub current_branch: Option<String>,
    pub branches: Vec<BranchInfo>,
    /// The user's checkout has uncommitted changes (tracked or untracked).
    pub dirty: bool,
}

/// A page of a worker's transcript, oldest first.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkerPage {
    pub entries: Vec<RawEntry>,
    pub has_more: bool,
}

/// A page of the orchestrator log, oldest first.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorPage {
    pub entries: Vec<OrchestratorLogEntry>,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorLogEntry {
    pub stream_seq: i64,
    pub at_ms: i64,
    pub entry: OrchestratorEntry,
}

/// Where a raw session's events come from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RawSource {
    /// A live CLI process.
    Live,
    /// A recording replayed through the adapter's parser.
    Replay { title: String },
    /// Simulated CLI output fed through the adapter's parser (diagnostics).
    Simulation { title: String },
}

/// Who answers a raw session's approval requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum RawApprovals {
    /// Brigadier's policy answers what stays inside the session's access; the user the rest.
    Delegated,
    /// Brigadier declines every request (a read-only session such as an orchestrator).
    DeclineAll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum RawState {
    Starting,
    Running,
    /// The CLI process ended; its CLI session is kept and can be resumed.
    Stopped,
    /// It could not start; whatever it created was removed.
    Failed,
    /// Being disposed of: the process is ending and its files are being removed.
    Closing,
    /// Everything it created is gone. The transcript stays in Brigadier.
    Closed,
}

/// A raw provider session: one CLI session driven directly, for debugging adapters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RawSession {
    pub id: RawSessionId,
    pub provider: ProviderKind,
    pub source: RawSource,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub access: Access,
    pub approvals: RawApprovals,
    /// The CLI's own session or thread id, once known.
    pub native_id: Option<String>,
    /// The session this one was forked from.
    pub parent_id: Option<RawSessionId>,
    pub state: RawState,
    pub error: Option<String>,
    /// File the raw stdio exchange is recorded to.
    pub recording: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// What Brigadier last learned about a provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOverview {
    pub provider: ProviderKind,
    pub status: Option<ProviderStatus>,
    /// Live model list, or the cached one until the first refresh.
    pub models: Option<ModelCatalog>,
    pub quota: Option<QuotaSnapshot>,
    /// Why the last refresh could not complete.
    pub error: Option<String>,
    pub checked_at_ms: Option<i64>,
}

/// A replayable recording.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Fixture {
    /// `builtin:<name>` for fixtures shipped with Brigadier, `recording:<file>` for recordings
    /// made from the Inspector.
    pub id: String,
    pub title: String,
    pub provider: ProviderKind,
    pub cli_version: Option<String>,
    pub lines: u32,
}

/// Everything the Inspector's Providers tab shows, in one read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersView {
    pub providers: Vec<ProviderOverview>,
    /// Newest first.
    pub sessions: Vec<RawSession>,
    pub fixtures: Vec<Fixture>,
}

/// One entry of a raw session's transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RawEntry {
    pub stream_seq: i64,
    pub at_ms: i64,
    pub event: ProviderEvent,
}

/// A page of a raw session's transcript, oldest first.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RawPage {
    pub entries: Vec<RawEntry>,
    pub has_more: bool,
}

/// Every change the core records. Serialized as the payload of a stored event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DomainEvent {
    ProjectCreated {
        project: Project,
    },
    ConversationCreated {
        conversation: Conversation,
    },
    ConversationRenamed {
        id: ConversationId,
        title: String,
    },
    ConversationPinned {
        id: ConversationId,
        pinned_at_ms: Option<i64>,
    },
    MessageAppended {
        message: Message,
    },
    SettingsChanged {
        settings: Settings,
    },
    RawSessionCreated {
        session: RawSession,
    },
    RawSessionUpdated {
        id: RawSessionId,
        state: RawState,
        native_id: Option<String>,
        error: Option<String>,
    },
    /// Something a raw session's CLI reported.
    RawEvent {
        session_id: RawSessionId,
        event: ProviderEvent,
    },
    /// An artifact a CLI session created, recorded before it is relied on. Owners are raw
    /// session ids, or `orch:`, `chat:`, `task:` and `session:` followed by an id.
    CleanupRecorded {
        owner: String,
        artifact: Artifact,
    },
    /// These artifacts of `owner` are gone.
    CleanupRemoved {
        owner: String,
        artifacts: Vec<Artifact>,
    },
    /// Everything `owner` created is to be removed; what fails is retried at the next launch.
    CleanupRequested {
        owner: String,
    },
    /// Written before artifacts were acknowledged one by one: every artifact of `owner` was
    /// dealt with.
    CleanupCompleted {
        owner: String,
        failures: Vec<String>,
    },
    ProviderChecked {
        overview: ProviderOverview,
    },
    /// A project's name, repositories or remembered choices changed (full snapshot).
    ProjectUpdated {
        project: Project,
    },
    ConversationSetUp {
        id: ConversationId,
        setup: Setup,
    },
    ConversationLifecycleChanged {
        id: ConversationId,
        lifecycle: Lifecycle,
    },
    /// Permanently removed; its streams are purged.
    ConversationDeleted {
        id: ConversationId,
    },
    /// Assistant text as it streams. The final `messageAppended` with the same id replaces it.
    MessageDelta {
        conversation_id: ConversationId,
        message_id: String,
        text: String,
    },
    RunStateChanged {
        conversation_id: ConversationId,
        state: RunState,
        error: Option<String>,
        /// The request the turn serves.
        #[serde(default)]
        request_id: Option<String>,
    },
    /// A user request started, or its state changed (full snapshot).
    RequestUpdated {
        request: UserRequest,
    },
    /// A worker started, finished, waits for the user, and so on.
    WorkerStepped {
        step: WorkerStep,
    },
    /// The orchestrator messaged a worker, read a report, and so on.
    OrchestratorStepped {
        step: OrchestratorStep,
    },
    /// A Chat's model began compacting its context, or finished (full snapshot).
    CompactionUpdated {
        compaction: Compaction,
    },
    /// The user rated an answer. Ratings stay on this machine.
    MessageRated {
        /// The answer: a message id, or `task:<id>` for a worker's report.
        subject: String,
        rating: Rating,
    },
    /// The thread now shows the branch that ends at `head`; new messages continue it.
    BranchSwitched {
        conversation_id: ConversationId,
        head: String,
    },
    ConversationNotice {
        conversation_id: ConversationId,
        notice: Notice,
    },
    /// A task was created or changed (full snapshot).
    TaskUpdated {
        task: Box<Task>,
    },
    ApprovalUpdated {
        approval: Approval,
    },
    QuestionUpdated {
        question: Question,
    },
    PlanUpdated {
        plan: Plan,
    },
    QueueChanged {
        conversation_id: ConversationId,
        queue: MessageQueue,
    },
    /// Something a worker's CLI reported.
    WorkerEvent {
        task_id: TaskId,
        event: ProviderEvent,
    },
    OrchestratorLogged {
        conversation_id: ConversationId,
        entry: OrchestratorEntry,
    },
    /// Diagnostic probe used to measure ingest → paint latency end to end.
    Probe {
        burst_id: String,
        index: u32,
        count: u32,
    },
}

impl DomainEvent {
    /// The stored event `kind`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ProjectCreated { .. } => "project.created",
            Self::ConversationCreated { .. } => "conversation.created",
            Self::ConversationRenamed { .. } => "conversation.renamed",
            Self::ConversationPinned { .. } => "conversation.pinned",
            Self::MessageAppended { .. } => "message.appended",
            Self::SettingsChanged { .. } => "settings.changed",
            Self::RawSessionCreated { .. } => "raw.created",
            Self::RawSessionUpdated { .. } => "raw.updated",
            Self::RawEvent { .. } => "raw.event",
            Self::CleanupRecorded { .. } => "cleanup.recorded",
            Self::CleanupRemoved { .. } => "cleanup.removed",
            Self::CleanupRequested { .. } => "cleanup.requested",
            Self::CleanupCompleted { .. } => "cleanup.completed",
            Self::ProviderChecked { .. } => "provider.checked",
            Self::ProjectUpdated { .. } => "project.updated",
            Self::ConversationSetUp { .. } => "conversation.setUp",
            Self::ConversationLifecycleChanged { .. } => "conversation.lifecycle",
            Self::ConversationDeleted { .. } => "conversation.deleted",
            Self::MessageDelta { .. } => "message.delta",
            Self::RunStateChanged { .. } => "conversation.run",
            Self::RequestUpdated { .. } => "request.updated",
            Self::WorkerStepped { .. } => "worker.step",
            Self::OrchestratorStepped { .. } => "orchestrator.step",
            Self::CompactionUpdated { .. } => "compaction.updated",
            Self::MessageRated { .. } => "message.rated",
            Self::BranchSwitched { .. } => "conversation.branch",
            Self::ConversationNotice { .. } => "conversation.notice",
            Self::TaskUpdated { .. } => "task.updated",
            Self::ApprovalUpdated { .. } => "approval.updated",
            Self::QuestionUpdated { .. } => "question.updated",
            Self::PlanUpdated { .. } => "plan.updated",
            Self::QueueChanged { .. } => "queue.changed",
            Self::WorkerEvent { .. } => "worker.event",
            Self::OrchestratorLogged { .. } => "orchestrator.logged",
            Self::Probe { .. } => "diag.probe",
        }
    }
}

/// Event streams. Catalog changes share one stream so the sidebar can be rebuilt in order;
/// each conversation's messages get their own.
pub mod streams {
    use super::ConversationId;

    pub const CATALOG: &str = "catalog";
    pub const SETTINGS: &str = "settings";
    pub const DIAGNOSTICS: &str = "diag";
    /// Raw sessions: creation and state changes.
    pub const RAW: &str = "raw";
    /// The cleanup ledger of every CLI session.
    pub const CLEANUP: &str = "cleanup";
    pub const PROVIDERS: &str = "providers";

    pub fn raw_session(id: &super::RawSessionId) -> String {
        format!("raw:{id}")
    }

    /// A conversation's messages, tasks, cards, queue and run state.
    pub fn conversation(id: &ConversationId) -> String {
        format!("conversation:{id}")
    }

    /// A worker's CLI events.
    pub fn task(id: &super::TaskId) -> String {
        format!("task:{id}")
    }

    /// The orchestrator's CLI events and context injections (Inspector).
    pub fn orchestrator(id: &ConversationId) -> String {
        format!("orch:{id}")
    }
}
