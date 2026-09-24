//! Domain model. These types are the wire contract too: they are exported to TypeScript.

use brigadier_providers::{
    Access, Artifact, ModelCatalog, ProviderEvent, ProviderKind, ProviderStatus, QuotaSnapshot,
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

id_type!(
    /// Identifies a raw provider session (a CLI session driven from the Inspector).
    RawSessionId
);

/// A workspace of one or more repos. Owns its sessions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub created_at_ms: i64,
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
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub density: Density,
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
    /// An artifact a CLI session created, recorded before it is relied on.
    CleanupRecorded {
        owner: RawSessionId,
        artifact: Artifact,
    },
    /// Every artifact recorded for `owner` was removed (except the listed failures).
    CleanupCompleted {
        owner: RawSessionId,
        failures: Vec<String>,
    },
    ProviderChecked {
        overview: ProviderOverview,
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
            Self::CleanupCompleted { .. } => "cleanup.completed",
            Self::ProviderChecked { .. } => "provider.checked",
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

    pub fn conversation(id: &ConversationId) -> String {
        format!("conversation:{id}")
    }
}
