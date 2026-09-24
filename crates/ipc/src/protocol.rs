//! The wire protocol between the app and `brigadierd`.
//!
//! Frames are length-prefixed JSON (see [`crate::frame`]). The first client frame must be a
//! [`ClientFrame::Hello`] carrying the per-launch token; anything else closes the connection.
//! Requests carry a client-chosen id echoed on the response. Responses reuse the request's
//! `method` tag, so TypeScript can pair them with `Extract<Response, { method: M }>`.

use brigadier_core::{
    Catalog, Conversation, ConversationId, ConversationKind, Message, MessagePage, ProbeBurst,
    Project, ProjectId, Settings,
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use ts_rs::TS;

use crate::metrics::{DaemonMetrics, Diagnostics};

/// Bumped on any incompatible change to these types.
pub const PROTOCOL_VERSION: u32 = 1;

/// Who is connecting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub pid: u32,
}

/// Frames sent by a client.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientFrame {
    Hello {
        token: String,
        protocol: u32,
        client: ClientInfo,
    },
    Request {
        id: u32,
        request: Request,
    },
}

/// Commands and queries.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "method",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    GetCatalog,
    CreateProject {
        name: String,
    },
    CreateConversation {
        kind: ConversationKind,
        project_id: Option<ProjectId>,
        title: Option<String>,
    },
    RenameConversation {
        id: ConversationId,
        title: String,
    },
    SetPinned {
        id: ConversationId,
        pinned: bool,
    },
    AppendMessage {
        conversation_id: ConversationId,
        text: String,
    },
    ListMessages {
        conversation_id: ConversationId,
        /// Only messages with a smaller `seq` (for paging backwards).
        before: Option<i64>,
        limit: u32,
    },
    ReadBlobText {
        hash: String,
    },
    UpdateSettings {
        settings: Settings,
    },
    /// Starts the live event feed. Events after `afterSeq` that were already committed are
    /// replayed first; then new events stream as they commit.
    Subscribe {
        after_seq: i64,
        /// Also stream daemon metrics once a second.
        metrics: bool,
    },
    /// Turns the metrics stream on or off (the Inspector is shown or hidden).
    SetMetricsStreaming {
        enabled: bool,
    },
    /// A page of committed events, for resync after `lagged`.
    EventsSince {
        after_seq: i64,
        limit: u32,
    },
    GetDiagnostics,
    /// Emits `count` diagnostic events through the normal write path, `intervalMs` apart.
    ProbeBurst {
        count: u32,
        interval_ms: u32,
    },
    /// Orderly quit: stop admitting writes, commit what is queued, acknowledge, exit.
    Shutdown,
}

/// Results, tagged with the method of the request they answer.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "method",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Response {
    GetCatalog {
        catalog: Catalog,
    },
    CreateProject {
        project: Project,
    },
    CreateConversation {
        conversation: Conversation,
    },
    RenameConversation {
        conversation: Conversation,
    },
    SetPinned {
        conversation: Conversation,
    },
    AppendMessage {
        message: Message,
    },
    ListMessages {
        page: MessagePage,
    },
    ReadBlobText {
        text: String,
    },
    UpdateSettings {
        settings: Settings,
    },
    Subscribe {
        last_seq: i64,
    },
    SetMetricsStreaming {
        enabled: bool,
    },
    EventsSince {
        events: Vec<EventEnvelope>,
        last_seq: i64,
    },
    GetDiagnostics {
        diagnostics: Box<Diagnostics>,
    },
    ProbeBurst {
        burst: ProbeBurst,
    },
    Shutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    NotFound,
    Invalid,
    ShuttingDown,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: ErrorCode,
    pub message: String,
}

/// The daemon's identity, sent after a successful hello.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DaemonInfo {
    pub version: String,
    pub protocol: u32,
    pub pid: u32,
    pub platform: String,
    pub started_at_ms: i64,
    pub data_dir: String,
}

/// A committed event as delivered to clients.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub seq: i64,
    pub stream: String,
    pub stream_seq: i64,
    /// When the daemon ingested the event, in ms since the Unix epoch.
    pub at_ms: i64,
    /// The stored payload, passed through without re-encoding.
    #[ts(as = "brigadier_core::DomainEvent")]
    pub event: Box<RawValue>,
}

/// Frames sent by the daemon.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerFrame {
    Welcome {
        daemon: DaemonInfo,
        last_seq: i64,
    },
    Response {
        id: u32,
        result: Outcome,
    },
    Event {
        event: EventEnvelope,
    },
    /// The client fell behind the live feed and was unsubscribed. Resync with `eventsSince`
    /// from `resumeAfter`, then subscribe again.
    Lagged {
        resume_after: i64,
    },
    Metrics {
        metrics: DaemonMetrics,
    },
    /// The daemon is shutting down; the connection closes next.
    Closing,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Outcome {
    Ok { value: Response },
    Err { error: IpcError },
}

impl From<Result<Response, IpcError>> for Outcome {
    fn from(result: Result<Response, IpcError>) -> Self {
        match result {
            Ok(value) => Self::Ok { value },
            Err(error) => Self::Err { error },
        }
    }
}

impl From<brigadier_core::Error> for IpcError {
    fn from(err: brigadier_core::Error) -> Self {
        use brigadier_core::Error as E;
        let code = match &err {
            _ if err.is_shutting_down() => ErrorCode::ShuttingDown,
            E::NotFound(_) => ErrorCode::NotFound,
            E::Invalid(_) => ErrorCode::Invalid,
            E::Store(_) | E::Corrupt { .. } => ErrorCode::Internal,
        };
        Self {
            code,
            message: err.to_string(),
        }
    }
}
