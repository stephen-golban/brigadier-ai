//! The wire protocol between the app and `brigadierd`.
//!
//! Frames are length-prefixed JSON (see [`crate::frame`]). The first client frame must be a
//! [`ClientFrame::Hello`] carrying the per-launch token, or one of the two grant-scoped frames
//! CLI sessions use ([`ClientFrame::Mcp`], [`ClientFrame::Gate`]); anything else closes the
//! connection.
//! Requests carry a client-chosen id echoed on the response. Responses reuse the request's
//! `method` tag, so TypeScript can pair them with `Extract<Response, { method: M }>`.

use brigadier_core::{
    AttachmentRef, CardId, Catalog, Conversation, ConversationId, ConversationKind,
    ConversationView, Message, MessagePage, MessageQueue, OrchestratorPage, ProbeBurst, Project,
    ProjectId, ProjectPatch, ProvidersView, QueuedMessage, RawApprovals, RawPage, RawSession,
    RawSessionId, RepoInfo, RestoreOutcome, Settings, Setup, SetupRequest, TaskId, WorkerPage,
};
use brigadier_providers::{Access, ApprovalDecision, ProviderKind};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use ts_rs::TS;

use crate::metrics::{DaemonMetrics, Diagnostics};

/// Bumped on any incompatible change to these types.
pub const PROTOCOL_VERSION: u32 = 2;

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
    /// First frame of a Brigadier MCP connection (`brigadierd mcp`, spawned by a CLI session).
    /// After it the connection carries raw MCP (newline-delimited JSON-RPC) in both directions.
    /// The grant must belong to an orchestrator or a worker; there is no token and no reply
    /// frame, a refused grant just closes the connection.
    Mcp {
        grant: String,
    },
    /// First and only frame of an outward-command gate check: may `argv` run in `cwd`? The
    /// grant must be a gate grant. Answered with one [`GateVerdict`].
    Gate {
        grant: String,
        /// The full command line as the program received it (`argv[0]` included).
        argv: Vec<String>,
        cwd: String,
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
    /// Creates a project. With `repo` (a repository's top-level folder, from the native
    /// picker or typed), an empty `name` names it after the folder.
    CreateProject {
        name: String,
        repo: Option<String>,
    },
    UpdateProject {
        id: ProjectId,
        patch: ProjectPatch,
    },
    /// Branches and state of a repository, for the composer's branch picker.
    GetRepoInfo {
        path: String,
    },
    /// Creates a session (with a project) or a chat (without). The setup comes from the
    /// composer; sessions need one to run, and their project remembers it.
    CreateConversation {
        kind: ConversationKind,
        project_id: Option<ProjectId>,
        title: Option<String>,
        setup: Option<SetupRequest>,
    },
    /// Changes the model, effort or permission level (a session's repository and environment
    /// cannot change once set).
    UpdateSetup {
        id: ConversationId,
        setup: Setup,
    },
    /// Messages (newest `limit`), tasks, cards, queue and run state in one read.
    GetConversation {
        id: ConversationId,
        limit: u32,
    },
    /// Sends a message. While a turn runs it waits in the queue (when queueing is on), or with
    /// `steer` goes into the running turn now.
    SendMessage {
        conversation_id: ConversationId,
        text: String,
        attachments: Vec<AttachmentRef>,
        mentions: Vec<TaskId>,
        steer: bool,
    },
    EditQueued {
        conversation_id: ConversationId,
        item_id: String,
        text: String,
        attachments: Vec<AttachmentRef>,
        mentions: Vec<TaskId>,
    },
    DeleteQueued {
        conversation_id: ConversationId,
        item_id: String,
    },
    /// Moves a queued message to `index` (drag to reorder).
    MoveQueued {
        conversation_id: ConversationId,
        item_id: String,
        index: u32,
    },
    /// Sends a queued message into the running turn now.
    SteerQueued {
        conversation_id: ConversationId,
        item_id: String,
    },
    /// Resumes a queue paused by an interrupt.
    ResumeQueue {
        conversation_id: ConversationId,
    },
    /// Stops the running turn; the queue pauses.
    Interrupt {
        conversation_id: ConversationId,
    },
    /// Stores a file for a message. `data` is base64; at most 10 MB decoded.
    AddAttachment {
        name: String,
        mime: String,
        data: String,
    },
    /// Answers an approval card.
    AnswerCard {
        conversation_id: ConversationId,
        card_id: CardId,
        decision: ApprovalDecision,
    },
    AnswerQuestion {
        conversation_id: ConversationId,
        card_id: CardId,
        answer: String,
    },
    DecidePlan {
        conversation_id: ConversationId,
        card_id: CardId,
        approve: bool,
        message: Option<String>,
    },
    /// Stops a worker for good (its unfinished changes are kept, see `Task.kept`).
    StopTask {
        task_id: TaskId,
    },
    /// Interrupts a worker's turn; `resumeTask` continues it.
    PauseTask {
        task_id: TaskId,
    },
    ResumeTask {
        task_id: TaskId,
    },
    /// Restores a task's kept patch (`KeptWork::Diff`) as a new branch on its target branch.
    RestoreKeptWork {
        task_id: TaskId,
    },
    /// A page of a worker's live transcript.
    ListWorkerEvents {
        task_id: TaskId,
        /// Only entries with a smaller `streamSeq` (for paging backwards).
        before: Option<i64>,
        limit: u32,
    },
    /// A page of the orchestrator log (Inspector): CLI events and context injections.
    ListOrchestratorLog {
        conversation_id: ConversationId,
        before: Option<i64>,
        limit: u32,
    },
    /// Part of an artifact's text.
    ReadArtifact {
        id: String,
        offset: u64,
        limit: u32,
    },
    /// Writes an artifact to a file the user picked ("Save to…"), replacing it.
    SaveArtifact {
        id: String,
        /// Absolute path.
        path: String,
    },
    /// Copies an artifact under `file_name` into Brigadier's cache (emptied at the next start),
    /// for the user to open with its default app.
    OpenArtifact {
        id: String,
        file_name: String,
    },
    /// Stops its CLI processes and removes temp files now; the next message continues it.
    Hibernate {
        id: ConversationId,
    },
    /// Stops workers, removes everything the conversation created (worktrees, CLI session
    /// files, processes, scratch folders) and hides it in the Archived view.
    Archive {
        id: ConversationId,
    },
    /// Brings an archived conversation back; its model restarts from the transcript.
    Restore {
        id: ConversationId,
    },
    /// Permanently removes a conversation and its transcript.
    Delete {
        id: ConversationId,
        /// Also delete its unmerged branches (otherwise they are kept).
        delete_branches: bool,
        /// Forget what the Project Brain learned from it (Phase 4; ignored until then).
        forget_brain: bool,
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
    /// Providers (login, models, quota), raw sessions and replayable fixtures.
    GetProviders,
    /// Checks every provider again in the background; results arrive as `providerChecked`.
    RefreshProviders,
    /// Starts a raw CLI session in the background; its state arrives as `rawSessionUpdated`.
    StartRawSession {
        provider: ProviderKind,
        /// Absolute path of the working directory.
        cwd: String,
        model: Option<String>,
        effort: Option<String>,
        access: Access,
        approvals: RawApprovals,
        /// Record the raw stdio exchange as a replayable fixture.
        record: bool,
    },
    /// Starts a stopped raw session's CLI session again.
    ResumeRawSession {
        id: RawSessionId,
    },
    /// Branches a new raw session off this one's CLI session.
    ForkRawSession {
        id: RawSessionId,
    },
    /// Sends a message: a new turn, or with `steer` into the running turn.
    SendRawSession {
        id: RawSessionId,
        text: String,
        steer: bool,
    },
    InterruptRawSession {
        id: RawSessionId,
    },
    /// The user's answer to an approval routed to them.
    AnswerApproval {
        id: RawSessionId,
        approval_id: String,
        decision: ApprovalDecision,
    },
    /// Ends the CLI process, keeping its CLI session for a resume.
    StopRawSession {
        id: RawSessionId,
    },
    /// Ends the CLI process and removes everything its CLI session created.
    CloseRawSession {
        id: RawSessionId,
    },
    /// A page of a raw session's transcript.
    ListRawEvents {
        id: RawSessionId,
        /// Only entries with a smaller `streamSeq` (for paging backwards).
        before: Option<i64>,
        limit: u32,
    },
    /// Replays a fixture through a fresh parser into a new, isolated raw session.
    ReplayFixture {
        fixture_id: String,
    },
    /// Feeds a simulated usage-limit turn through a fresh parser in an isolated raw session.
    SimulateUsageLimit {
        provider: ProviderKind,
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
        project: Box<Project>,
    },
    UpdateProject {
        project: Box<Project>,
    },
    GetRepoInfo {
        repo: RepoInfo,
    },
    CreateConversation {
        conversation: Box<Conversation>,
    },
    UpdateSetup {
        conversation: Box<Conversation>,
    },
    GetConversation {
        view: Box<ConversationView>,
    },
    SendMessage {
        outcome: SendOutcome,
    },
    EditQueued {
        queue: MessageQueue,
    },
    DeleteQueued {
        queue: MessageQueue,
    },
    MoveQueued {
        queue: MessageQueue,
    },
    SteerQueued,
    ResumeQueue {
        queue: MessageQueue,
    },
    Interrupt,
    AddAttachment {
        attachment: AttachmentRef,
    },
    AnswerCard,
    AnswerQuestion,
    DecidePlan,
    StopTask,
    PauseTask,
    ResumeTask,
    RestoreKeptWork {
        outcome: RestoreOutcome,
    },
    ListWorkerEvents {
        page: WorkerPage,
    },
    ListOrchestratorLog {
        page: OrchestratorPage,
    },
    ReadArtifact {
        text: ArtifactText,
    },
    SaveArtifact,
    OpenArtifact {
        /// The copy to open.
        path: String,
    },
    Hibernate {
        conversation: Box<Conversation>,
    },
    Archive {
        conversation: Box<Conversation>,
    },
    Restore {
        conversation: Box<Conversation>,
    },
    Delete,
    RenameConversation {
        conversation: Box<Conversation>,
    },
    SetPinned {
        conversation: Box<Conversation>,
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
    GetProviders {
        view: ProvidersView,
    },
    RefreshProviders,
    StartRawSession {
        session: Box<RawSession>,
    },
    ResumeRawSession {
        session: Box<RawSession>,
    },
    ForkRawSession {
        session: Box<RawSession>,
    },
    SendRawSession,
    InterruptRawSession,
    AnswerApproval,
    StopRawSession,
    CloseRawSession {
        session: Box<RawSession>,
    },
    ListRawEvents {
        page: RawPage,
    },
    ReplayFixture {
        session: Box<RawSession>,
    },
    SimulateUsageLimit {
        session: Box<RawSession>,
    },
    Shutdown,
}

/// What happened to a sent message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SendOutcome {
    /// It is in the transcript (a new turn, or steered into the running one).
    Sent { message: Box<Message> },
    /// It waits in the queue.
    Queued { item: QueuedMessage },
}

/// A slice of an artifact's text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactText {
    pub text: String,
    pub offset: u64,
    pub total_bytes: u64,
    /// Not text: `text` is empty.
    pub binary: bool,
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
    pub event: RawJson,
}

/// Pre-encoded JSON. The daemon sends stored payloads as they are (no re-encoding per
/// subscriber). Deserializing goes through [`serde_json::Value`], because the frames are
/// internally tagged enums and serde buffers their content, which a borrowed [`RawValue`]
/// cannot be read back from.
#[derive(Debug, Clone)]
pub struct RawJson(pub Box<RawValue>);

impl Serialize for RawJson {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for RawJson {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        serde_json::value::to_raw_value(&value)
            .map(RawJson)
            .map_err(serde::de::Error::custom)
    }
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

/// The daemon's only frame on a gate connection: the answer to its [`ClientFrame::Gate`]
/// check. A gate connection carries nothing else, so this is not a [`ServerFrame`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateVerdict {
    pub allow: bool,
    /// Why the command was denied, for the program's stderr.
    pub message: Option<String>,
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
            E::Invalid(_) | E::Provider(_) => ErrorCode::Invalid,
            E::Store(_) | E::Corrupt { .. } => ErrorCode::Internal,
        };
        Self {
            code,
            message: err.to_string(),
        }
    }
}
