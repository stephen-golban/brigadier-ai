//! Domain model. These types are the wire contract too: they are exported to TypeScript.

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

    pub fn conversation(id: &ConversationId) -> String {
        format!("conversation:{id}")
    }
}
