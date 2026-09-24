//! The conversation driver: the orchestrator of a session, or the model of a Chat.
//!
//! One CLI session per conversation, started on the first turn and replaced whenever it is
//! gone. Turns are non-blocking for everyone else:
//!
//! - A message sent while no turn runs starts one. While a turn runs it waits in the queue
//!   (or is steered into the turn when the user asks, or when queueing is off).
//! - Worker results arrive as [`Envelope`]s in the inbox. Only final reports, blocking
//!   questions, card outcomes and task failures ever enter the orchestrator's context;
//!   worker progress never does. An envelope arriving while the orchestrator is idle starts
//!   a turn.
//! - When a turn ends, the next turn carries the next queued message (unless the queue is
//!   paused) together with everything in the inbox.
//!
//! Every byte sent to the orchestrator is logged as a [`ContextInjection`] on `orch:<id>`,
//! next to the CLI's own usage and context-size events, so the Inspector can show that its
//! context grows only by messages and reports.

use std::sync::Arc;
use std::time::Duration;

use brigadier_providers::{
    Access, ApprovalDecision, Artifact, Decider, ErrorKind, InputFile, McpServer, Origin,
    ProviderEvent, ProviderKind, ProviderSession, Role as ProviderRole, SessionSpec, Started,
    ToolSet, TurnInput, TurnStatus,
};
use brigadier_store::StreamPage;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::SessionManager;
use super::prompts;
use crate::model::{
    ConversationId, ConversationKind, DomainEvent, Lifecycle, Message, MessageRole, ModelChoice,
    Notice, Setup, streams,
};
use crate::runtime::{is_delta, merge_delta};
use crate::tools::Role;
use crate::work::{
    AttachmentRef, ContextInjection, InjectionKind, OrchestratorEntry, QueuedMessage, RunState,
    TaskId,
};
use crate::{Error, Result, now_ms};

/// Text deltas arriving within this window are stored as one event.
const DELTA_WINDOW: Duration = Duration::from_millis(30);
/// How long a blocking MCP call may take for the orchestrator (its tools return at once).
const ORCHESTRATOR_TOOL_TIMEOUT_SECS: u64 = 120;
/// Messages carried verbatim when a conversation's CLI session is started over.
const RESEED_MESSAGES: u32 = 40;
/// Bytes of transcript carried when a conversation's CLI session is started over.
const RESEED_BYTES: usize = 48_000;

/// Where a sent message went.
#[derive(Debug, Clone)]
pub enum SendOutcome {
    /// In the transcript: a new turn, or steered into the running one.
    Sent(Message),
    /// Waiting in the queue.
    Queued(QueuedMessage),
}

/// Something for the orchestrator's next turn.
#[derive(Debug, Clone)]
pub(crate) struct Envelope {
    pub kind: InjectionKind,
    /// Short label for the Inspector ("report task-3").
    pub label: String,
    pub task_id: Option<TaskId>,
    /// The text the orchestrator reads.
    pub text: String,
}

/// A live CLI session of a conversation or task.
pub(crate) struct Cli {
    pub provider: ProviderKind,
    pub model: ModelChoice,
    pub session: Arc<dyn ProviderSession>,
    /// The cleanup-ledger owner (`orch:…`, `chat:…`, `task:…`).
    pub owner: String,
    /// Cancelled once the session's pump has stored its last event.
    pub ended: CancellationToken,
}

#[derive(Default)]
struct ConvState {
    cli: Option<Arc<Cli>>,
    /// A turn is starting or running.
    busy: bool,
    /// The CLI is being closed on purpose (hibernate, archive, fallback).
    closing: bool,
    /// Envelopes for the next turn.
    inbox: Vec<Envelope>,
    /// User messages already in the transcript that the next turn carries.
    pending: Vec<Message>,
    /// The user messages the running turn carries (resent after a Chat fallback).
    in_turn: Vec<Message>,
    /// The next CLI session starts fresh and must be given the transcript so far.
    reseed: bool,
    /// A Chat that hit a usage limit continues on this model (the saved choice is untouched).
    fallback: Option<ModelChoice>,
    /// The running turn failed on a usage limit.
    limit_hit: bool,
    last_activity_ms: i64,
}

/// A conversation's live state.
pub(crate) struct ConvLive {
    pub id: ConversationId,
    pub kind: ConversationKind,
    state: tokio::sync::Mutex<ConvState>,
}

impl ConvLive {
    pub fn new(id: ConversationId, kind: ConversationKind) -> Self {
        Self {
            id,
            kind,
            state: tokio::sync::Mutex::new(ConvState {
                last_activity_ms: now_ms(),
                ..ConvState::default()
            }),
        }
    }

    /// Ends the CLI session, if any. Its files stay (it can be resumed).
    pub async fn close_cli(&self) {
        let cli = {
            let mut state = self.state.lock().await;
            state.closing = true;
            state.cli.take()
        };
        if let Some(cli) = cli {
            cli.session.close().await;
            cli.ended.cancelled().await;
        }
        let mut state = self.state.lock().await;
        state.closing = false;
        state.busy = false;
    }

    /// Whether a turn is starting or running, or work waits for one.
    pub async fn is_busy(&self) -> bool {
        let state = self.state.lock().await;
        state.busy || !state.inbox.is_empty() || !state.pending.is_empty()
    }

    pub async fn idle_since_ms(&self) -> Option<i64> {
        let state = self.state.lock().await;
        (!state.busy && state.cli.is_some()).then_some(state.last_activity_ms)
    }

    /// The next CLI session must start from the transcript (its files are gone).
    pub async fn mark_reseed(&self) {
        self.state.lock().await.reseed = true;
    }
}

impl SessionManager {
    /// Sends a user message: starts a turn, or queues it, or steers it into the running turn.
    pub async fn send_message(
        &self,
        id: ConversationId,
        text: String,
        attachments: Vec<AttachmentRef>,
        mentions: Vec<TaskId>,
        steer: bool,
    ) -> Result<SendOutcome> {
        self.admit()?;
        let conversation = self.core.conversation(&id)?;
        match conversation.lifecycle {
            Lifecycle::Archived => {
                return Err(Error::Invalid(
                    "this conversation is archived; restore it first".into(),
                ));
            }
            Lifecycle::Hibernated => {
                self.core
                    .set_lifecycle(id.clone(), Lifecycle::Active)
                    .await?;
            }
            Lifecycle::Active => {}
        }
        if conversation.kind == ConversationKind::Session && conversation.setup.is_none() {
            return Err(Error::Invalid(
                "choose the session's repository and environment first".into(),
            ));
        }
        // Attachments uploaded a while ago must survive blob collection from now on.
        for attachment in &attachments {
            let Ok(hash) = attachment.id.parse::<brigadier_store::BlobHash>() else {
                return Err(Error::Invalid(format!(
                    "attachment {} is unknown",
                    attachment.name
                )));
            };
            if !self.core.store().blobs().touch(hash).await? {
                return Err(Error::Invalid(format!(
                    "{} is no longer stored; attach it again",
                    attachment.name
                )));
            }
        }
        let conv = self.conv(&id)?;
        let mut state = conv.state.lock().await;
        state.last_activity_ms = now_ms();
        if state.busy {
            if steer || !self.core.settings().queue_enabled {
                let message = self
                    .core
                    .append_user_message(id.clone(), text, attachments, mentions)
                    .await?;
                let steered = match &state.cli {
                    Some(cli) => {
                        let input = self
                            .turn_input(&conv, std::slice::from_ref(&message), &[])
                            .await;
                        cli.session.steer(input).await.is_ok()
                    }
                    None => false,
                };
                if steered {
                    self.log_user_injection(&conv, &message).await;
                    state.in_turn.push(message.clone());
                } else {
                    // The turn is still starting (or just ended): the next turn carries it.
                    state.pending.push(message.clone());
                }
                return Ok(SendOutcome::Sent(message));
            }
            let item = self.core.enqueue(&id, text, attachments, mentions).await?;
            return Ok(SendOutcome::Queued(item));
        }
        let message = self
            .core
            .append_user_message(id.clone(), text, attachments, mentions)
            .await?;
        state.pending.push(message.clone());
        drop(state);
        self.kick(&conv);
        Ok(SendOutcome::Sent(message))
    }

    /// Sends a queued message now, into the running turn (or as a new turn when idle).
    pub async fn steer_queued(&self, id: ConversationId, item_id: String) -> Result<()> {
        self.admit()?;
        let conv = self.conv(&id)?;
        let item = self.core.take_queued(&id, &item_id).await?;
        let message = self
            .core
            .append_user_message(id.clone(), item.text, item.attachments, item.mentions)
            .await?;
        let mut state = conv.state.lock().await;
        let steered = match (&state.cli, state.busy) {
            (Some(cli), true) => {
                let input = self
                    .turn_input(&conv, std::slice::from_ref(&message), &[])
                    .await;
                cli.session.steer(input).await.is_ok()
            }
            _ => false,
        };
        if steered {
            self.log_user_injection(&conv, &message).await;
            state.in_turn.push(message);
            return Ok(());
        }
        state.pending.push(message);
        drop(state);
        self.kick(&conv);
        Ok(())
    }

    /// Unpauses the queue and sends its next message if nothing runs.
    pub async fn resume_queue(&self, id: ConversationId) -> Result<crate::work::MessageQueue> {
        let queue = self.core.set_queue_paused(&id, false).await?;
        let conv = self.conv(&id)?;
        self.kick(&conv);
        Ok(queue)
    }

    /// Stops the running turn. The queue pauses so nothing is sent until the user resumes.
    pub async fn interrupt(&self, id: ConversationId) -> Result<()> {
        let conv = self.conv(&id)?;
        let cli = conv.state.lock().await.cli.clone();
        let waiting = !self
            .core
            .conversation_view(id.clone(), 1)
            .await?
            .queue
            .items
            .is_empty();
        if waiting {
            self.core.set_queue_paused(&id, true).await?;
        }
        if let Some(cli) = cli {
            cli.session
                .interrupt()
                .await
                .map_err(|err| Error::Provider(err.to_string()))?;
        }
        Ok(())
    }

    /// Queues an envelope for the orchestrator's next turn, starting one if it is idle.
    pub(crate) async fn deliver(&self, id: &ConversationId, envelope: Envelope) {
        let Ok(conv) = self.conv(id) else {
            return;
        };
        if matches!(
            self.core.conversation(id).map(|c| c.lifecycle),
            Ok(Lifecycle::Archived)
        ) {
            return;
        }
        conv.state.lock().await.inbox.push(envelope);
        self.kick(&conv);
    }

    /// Starts the next turn if none runs and there is something to say.
    pub(crate) fn kick(&self, conv: &Arc<ConvLive>) {
        let manager = self.arc();
        let conv = conv.clone();
        self.spawn(async move { manager.next_turn(conv).await });
    }

    async fn next_turn(self: Arc<Self>, conv: Arc<ConvLive>) {
        let (users, envelopes) = {
            let mut state = conv.state.lock().await;
            if state.busy || state.closing || self.admit().is_err() {
                return;
            }
            let mut users = std::mem::take(&mut state.pending);
            if users.is_empty() {
                match self.core.pop_queued(&conv.id).await {
                    Ok(Some(item)) => match self
                        .core
                        .append_user_message(
                            conv.id.clone(),
                            item.text,
                            item.attachments,
                            item.mentions,
                        )
                        .await
                    {
                        Ok(message) => users.push(message),
                        Err(err) => {
                            tracing::warn!(conversation = %conv.id, error = %err, "could not send a queued message");
                        }
                    },
                    Ok(None) => {}
                    Err(err) => {
                        tracing::warn!(conversation = %conv.id, error = %err, "could not read the queue");
                    }
                }
            }
            let envelopes = std::mem::take(&mut state.inbox);
            if users.is_empty() && envelopes.is_empty() {
                return;
            }
            state.busy = true;
            state.limit_hit = false;
            state.in_turn = users.clone();
            (users, envelopes)
        };
        self.set_run(&conv.id, RunState::Starting, None).await;
        let cli = match self.ensure_cli(&conv).await {
            Ok(cli) => cli,
            Err(err) => {
                let message = err.to_string();
                self.fail_turn(&conv, users, envelopes, &message).await;
                return;
            }
        };
        let reseed = std::mem::take(&mut conv.state.lock().await.reseed);
        let mut input = self.turn_input(&conv, &users, &envelopes).await;
        if reseed {
            let transcript = self.reseed_text(&conv.id, &users).await;
            if !transcript.is_empty() {
                self.log_injection(
                    &conv.id,
                    InjectionKind::Reseed,
                    "transcript so far".into(),
                    None,
                    transcript.len(),
                )
                .await;
                input.text = format!("{transcript}\n\n{}", input.text);
            }
        }
        for message in &users {
            self.log_user_injection(&conv, message).await;
        }
        for envelope in &envelopes {
            self.log_injection(
                &conv.id,
                envelope.kind,
                envelope.label.clone(),
                envelope.task_id.clone(),
                envelope.text.len(),
            )
            .await;
        }
        self.set_run(&conv.id, RunState::Running, None).await;
        if let Err(err) = cli.session.send(input).await {
            let message = format!("The CLI did not take the turn: {err}");
            self.fail_turn(&conv, users, envelopes, &message).await;
        }
    }

    /// A turn could not start: keep what it carried for the next try and say why.
    async fn fail_turn(
        &self,
        conv: &Arc<ConvLive>,
        users: Vec<Message>,
        envelopes: Vec<Envelope>,
        message: &str,
    ) {
        {
            let mut state = conv.state.lock().await;
            state.busy = false;
            let mut pending = users;
            pending.append(&mut state.pending);
            state.pending = pending;
            let mut inbox = envelopes;
            inbox.append(&mut state.inbox);
            state.inbox = inbox;
        }
        self.notice(&conv.id, brigadier_providers::NoticeLevel::Warning, message)
            .await;
        self.set_run(&conv.id, RunState::Failed, Some(message.to_owned()))
            .await;
    }

    /// The conversation's live CLI session, started (or resumed) when there is none.
    async fn ensure_cli(&self, conv: &Arc<ConvLive>) -> Result<Arc<Cli>> {
        if let Some(cli) = conv.state.lock().await.cli.clone() {
            return Ok(cli);
        }
        let conversation = self.core.conversation(&conv.id)?;
        let (owner, area) = match conv.kind {
            ConversationKind::Session => (format!("orch:{}", conv.id), "orch"),
            ConversationKind::Chat => (format!("chat:{}", conv.id), "chat"),
        };
        let dir = self.owned_dir(area, &conv.id.0);
        self.prepare_owned_dir(&owner, &dir).await?;

        let fallback = conv.state.lock().await.fallback.clone();
        let mut grant_values = Vec::new();
        let (choice, prompt, mcp) = match (&conversation.setup, conv.kind) {
            (Some(Setup::Session { orchestrator, .. }), _) => {
                let choice = self.orchestrator_choice(&conv.id, orchestrator).await;
                let project = conversation
                    .project_id
                    .as_ref()
                    .and_then(|id| self.core.project(id).ok());
                let prompt = prompts::orchestrator(&conversation, project.as_ref());
                let grant = self.grants.issue(
                    &owner,
                    Role::Orchestrator {
                        conversation_id: conv.id.clone(),
                    },
                );
                grant_values.push(grant.clone());
                (
                    choice,
                    prompt,
                    vec![self.brigadier_server(grant, ORCHESTRATOR_TOOL_TIMEOUT_SECS)],
                )
            }
            (Some(Setup::Chat { model }), _) => (
                fallback.unwrap_or_else(|| model.clone()),
                prompts::chat(),
                Vec::new(),
            ),
            (None, ConversationKind::Chat) => {
                let model = self
                    .core
                    .settings()
                    .default_chat_model
                    .unwrap_or(ModelChoice {
                        provider: ProviderKind::Claude,
                        model: None,
                        effort: None,
                    });
                (fallback.unwrap_or(model), prompts::chat(), Vec::new())
            }
            (None, ConversationKind::Session) => {
                return Err(Error::Invalid("the session has no setup".into()));
            }
        };

        let grant_redactor = super::secrets::redactor(grant_values);
        let resume = self.last_native_id(&conv.id, choice.provider).await;
        let reseed_needed = resume.is_none() && self.has_history(&conv.id).await;
        let mut spec = SessionSpec {
            cwd: dir.clone(),
            model: choice.model.clone(),
            effort: choice.effort.clone(),
            origin: match &resume {
                Some(native_id) => Origin::Resume {
                    native_id: native_id.clone(),
                },
                None => Origin::New,
            },
            access: Access::ReadOnly,
            append_system_prompt: Some(prompt.clone()),
            mcp_servers: mcp,
            tools: match conv.kind {
                ConversationKind::Session => ToolSet::None,
                ConversationKind::Chat => ToolSet::Web,
            },
            env: Vec::new(),
            path_prepend: Vec::new(),
            record_to: None,
            redactor: grant_redactor.clone(),
            owned_cwd: true,
        };
        let started = match self
            .runtime
            .start_hosted(&owner, choice.provider, spec.clone())
            .await
        {
            Ok(started) => started,
            Err(err) if resume.is_some() => {
                tracing::info!(conversation = %conv.id, error = %err, "resume failed; starting over from the transcript");
                spec.origin = Origin::New;
                conv.state.lock().await.reseed = true;
                self.runtime
                    .start_hosted(&owner, choice.provider, spec)
                    .await?
            }
            Err(err) => {
                self.grants.revoke_owner(&owner);
                return Err(err);
            }
        };
        if reseed_needed {
            conv.state.lock().await.reseed = true;
        }
        if resume.is_none() {
            self.log_injection(
                &conv.id,
                InjectionKind::Instructions,
                "role instructions".into(),
                None,
                prompt.len(),
            )
            .await;
        }
        let Started { session, events } = started;
        let cli = Arc::new(Cli {
            provider: choice.provider,
            model: choice,
            session,
            owner,
            ended: CancellationToken::new(),
        });
        conv.state.lock().await.cli = Some(cli.clone());
        let manager = self.arc();
        let pumped = cli.clone();
        let conv = conv.clone();
        self.spawn(async move { manager.pump_conversation(conv, pumped, events).await });
        Ok(cli)
    }

    /// The orchestrator's model: the session's choice, unless it is a Codex orchestrator that
    /// cannot be locked down (then Claude, with a notice).
    async fn orchestrator_choice(&self, id: &ConversationId, choice: &ModelChoice) -> ModelChoice {
        if choice.provider != ProviderKind::Codex {
            return choice.clone();
        }
        match brigadier_providers::codex::orchestrator_lockdown() {
            Ok(()) => choice.clone(),
            Err(reason) => {
                self.notice(
                    id,
                    brigadier_providers::NoticeLevel::Warning,
                    &format!(
                        "A Codex orchestrator cannot be limited to talking only ({reason}), so this session's orchestrator runs on Claude."
                    ),
                )
                .await;
                ModelChoice {
                    provider: ProviderKind::Claude,
                    model: None,
                    effort: choice.effort.clone(),
                }
            }
        }
    }

    /// The Brigadier MCP server entry a CLI session gets.
    pub(crate) fn brigadier_server(&self, grant: String, timeout_secs: u64) -> McpServer {
        McpServer {
            name: "brigadier".into(),
            command: self.config.daemon_exe.clone(),
            args: vec![
                "mcp".into(),
                "--data-dir".into(),
                self.data_dir.to_string_lossy().into_owned(),
            ],
            env: vec![("BRIGADIER_MCP_GRANT".into(), grant)],
            tool_timeout_secs: Some(timeout_secs),
            trusted: true,
        }
    }

    /// Creates a Brigadier-owned folder and records it (and anything running inside it) in
    /// the cleanup ledger first.
    pub(crate) async fn prepare_owned_dir(&self, owner: &str, dir: &std::path::Path) -> Result<()> {
        let ledger = self.runtime.ledger();
        let path = dir.to_string_lossy().into_owned();
        ledger
            .record(owner, Artifact::ScratchDir { path: path.clone() })
            .await?;
        ledger
            .record(owner, Artifact::ProcessesIn { dir: path })
            .await?;
        let dir = dir.to_owned();
        super::blocking(move || {
            std::fs::create_dir_all(&dir).map_err(|err| Error::Invalid(err.to_string()))
        })
        .await
    }

    /// The turn's input: user messages verbatim, then each envelope. Images go along as
    /// images; other attachments are named so the orchestrator can hand them to workers.
    async fn turn_input(
        &self,
        conv: &Arc<ConvLive>,
        users: &[Message],
        envelopes: &[Envelope],
    ) -> TurnInput {
        let mut parts = Vec::new();
        let mut files = Vec::new();
        for message in users {
            let mut text = self.full_text(message).await;
            for attachment in &message.attachments {
                let wanted = conv.kind == ConversationKind::Chat || is_image(&attachment.mime);
                if wanted && let Some(file) = self.attachment_file(conv, attachment).await {
                    files.push(file);
                }
                if conv.kind == ConversationKind::Session {
                    text.push_str(&format!(
                        "\n[attachment {} \"{}\" ({}, {} bytes){}]",
                        attachment.id,
                        attachment.name,
                        attachment.mime,
                        attachment.bytes,
                        if is_image(&attachment.mime) {
                            ""
                        } else {
                            "; pass its id to delegate_task so a worker can read it"
                        }
                    ));
                }
            }
            for task in &message.mentions {
                if let Ok(tasks) = self.core.tasks(&conv.id).await
                    && let Some(task) = tasks.iter().find(|t| &t.id == task)
                {
                    text.push_str(&format!(
                        "\n[mentions task-{}: {}]",
                        task.number, task.title
                    ));
                }
            }
            parts.push(text);
        }
        for envelope in envelopes {
            parts.push(envelope.text.clone());
        }
        TurnInput {
            text: parts.join("\n\n"),
            files,
        }
    }

    async fn full_text(&self, message: &Message) -> String {
        match &message.blob {
            Some(hash) => self
                .core
                .read_blob_text(hash.clone())
                .await
                .unwrap_or_else(|_| message.text.clone()),
            None => message.text.clone(),
        }
    }

    /// Writes an attachment into the conversation's own folder so the CLI can read it.
    async fn attachment_file(
        &self,
        conv: &Arc<ConvLive>,
        attachment: &AttachmentRef,
    ) -> Option<InputFile> {
        let area = match conv.kind {
            ConversationKind::Session => "orch",
            ConversationKind::Chat => "chat",
        };
        let dir = self.owned_dir(area, &conv.id.0).join("attachments");
        let path = dir.join(format!(
            "{}-{}",
            &attachment.id[..attachment.id.len().min(12)],
            safe_file_name(&attachment.name)
        ));
        let bytes = self
            .core
            .store()
            .blobs()
            .get(attachment.id.parse::<brigadier_store::BlobHash>().ok()?)
            .await
            .ok()??;
        let target = path.clone();
        super::blocking(move || {
            std::fs::create_dir_all(&dir).map_err(|err| Error::Invalid(err.to_string()))?;
            std::fs::write(&target, bytes).map_err(|err| Error::Invalid(err.to_string()))
        })
        .await
        .ok()?;
        Some(InputFile {
            path,
            name: attachment.name.clone(),
            mime: attachment.mime.clone(),
        })
    }

    /// Stores the conversation CLI's events: streaming text into the transcript, the rest
    /// into `orch:<id>` for the Inspector.
    async fn pump_conversation(
        self: Arc<Self>,
        conv: Arc<ConvLive>,
        cli: Arc<Cli>,
        mut events: mpsc::Receiver<ProviderEvent>,
    ) {
        let mut deltas: Vec<ProviderEvent> = Vec::new();
        let mut deadline: Option<tokio::time::Instant> = None;
        loop {
            let flush_at = async {
                match deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                event = events.recv() => match event {
                    Some(event) if is_delta(&event) => {
                        merge_delta(&mut deltas, event);
                        deadline.get_or_insert_with(|| tokio::time::Instant::now() + DELTA_WINDOW);
                    }
                    Some(event) => {
                        deadline = None;
                        self.store_deltas(&conv.id, std::mem::take(&mut deltas)).await;
                        let exited = matches!(event, ProviderEvent::Exited { .. });
                        self.on_conversation_event(&conv, &cli, event).await;
                        if exited {
                            break;
                        }
                    }
                    None => break,
                },
                () = flush_at => {
                    deadline = None;
                    self.store_deltas(&conv.id, std::mem::take(&mut deltas)).await;
                }
            }
        }
        self.store_deltas(&conv.id, deltas).await;
        self.grants.revoke_owner(&cli.owner);
        let (was_busy, closing) = {
            let mut state = conv.state.lock().await;
            if state
                .cli
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &cli))
            {
                state.cli = None;
            }
            let was_busy = state.busy;
            state.busy = false;
            (was_busy, state.closing)
        };
        cli.ended.cancel();
        if was_busy && !closing {
            self.set_run(
                &conv.id,
                RunState::Failed,
                Some("The CLI session ended unexpectedly.".into()),
            )
            .await;
        } else if !closing {
            self.set_run(&conv.id, RunState::Idle, None).await;
        }
    }

    async fn store_deltas(&self, id: &ConversationId, deltas: Vec<ProviderEvent>) {
        let events: Vec<DomainEvent> = deltas
            .into_iter()
            .filter_map(|event| match event {
                ProviderEvent::MessageDelta { item_id, text } => Some(DomainEvent::MessageDelta {
                    conversation_id: id.clone(),
                    message_id: item_id,
                    text,
                }),
                _ => None,
            })
            .collect();
        if events.is_empty() {
            return;
        }
        if let Err(err) = self.core.record_conversation(id, events).await {
            tracing::debug!(conversation = %id, error = %err, "could not store streamed text");
        }
    }

    async fn on_conversation_event(
        &self,
        conv: &Arc<ConvLive>,
        cli: &Arc<Cli>,
        event: ProviderEvent,
    ) {
        match &event {
            ProviderEvent::Message {
                item_id,
                role: ProviderRole::Assistant,
                text,
            } => {
                if let Err(err) = self
                    .core
                    .append_assistant_message(
                        conv.id.clone(),
                        item_id.clone(),
                        text.clone(),
                        Some(cli.model.clone()),
                    )
                    .await
                {
                    tracing::warn!(conversation = %conv.id, error = %err, "could not store a reply");
                }
            }
            ProviderEvent::ApprovalRequested { request } => {
                // The orchestrator never runs anything, and a Chat only searches the web.
                let allowed = conv.kind == ConversationKind::Chat
                    && matches!(request.tool.as_str(), "WebSearch" | "WebFetch");
                let decision = if allowed {
                    ApprovalDecision::Allow
                } else {
                    ApprovalDecision::Deny {
                        message: "Declined by Brigadier: this session only talks.".into(),
                    }
                };
                if let Err(err) = cli
                    .session
                    .answer(request.id.clone(), decision.clone())
                    .await
                {
                    tracing::warn!(conversation = %conv.id, error = %err, "could not answer an approval");
                }
                self.log_provider(
                    &conv.id,
                    cli.provider,
                    ProviderEvent::ApprovalResolved {
                        id: request.id.clone(),
                        decision,
                        decided_by: Decider::Policy,
                    },
                )
                .await;
            }
            ProviderEvent::Error { error } => {
                if error.kind == ErrorKind::UsageLimit && !error.will_retry {
                    conv.state.lock().await.limit_hit = true;
                }
                if !error.will_retry {
                    self.notice(
                        &conv.id,
                        brigadier_providers::NoticeLevel::Warning,
                        &error.message,
                    )
                    .await;
                }
            }
            ProviderEvent::Notice { level, message } => {
                self.notice(&conv.id, *level, message).await;
            }
            ProviderEvent::RateLimits { quota } => {
                self.runtime.note_quota_snapshot(quota.clone()).await;
            }
            _ => {}
        }
        let completed = match &event {
            ProviderEvent::TurnCompleted { status, .. } => Some(*status),
            _ => None,
        };
        self.log_provider(&conv.id, cli.provider, event).await;
        if let Some(status) = completed {
            self.turn_completed(conv, cli, status).await;
        }
    }

    async fn turn_completed(&self, conv: &Arc<ConvLive>, cli: &Arc<Cli>, status: TurnStatus) {
        let (limit_hit, carried) = {
            let mut state = conv.state.lock().await;
            state.busy = false;
            state.last_activity_ms = now_ms();
            (state.limit_hit, std::mem::take(&mut state.in_turn))
        };
        if limit_hit
            && status == TurnStatus::Failed
            && conv.kind == ConversationKind::Chat
            && let Some(next) = self.chat_fallback_choice(cli)
        {
            // Not from inside the CLI's own event pump: closing the CLI waits for it.
            let (manager, conv, cli) = (self.arc(), conv.clone(), cli.clone());
            self.spawn(async move { manager.chat_fallback(&conv, &cli, next, carried).await });
            return;
        }
        self.set_run(&conv.id, RunState::Idle, None).await;
        self.kick(conv);
    }

    /// The model a Chat continues on after `cli`'s vendor hit a usage limit.
    fn chat_fallback_choice(&self, cli: &Arc<Cli>) -> Option<brigadier_router::Choice> {
        let from = brigadier_router::Choice {
            provider: cli.provider,
            model: cli.model.model.clone(),
            effort: cli.model.effort.clone(),
            reason: String::new(),
            cross_vendor: None,
        };
        brigadier_router::fallback(
            &from,
            brigadier_router::TaskCategory::Chat,
            &self.availability(),
        )
    }

    /// A Chat hit a usage limit: continue on the other vendor's equivalent model, seeded with
    /// the transcript, and resend the turn. The saved model choice is left alone.
    async fn chat_fallback(
        &self,
        conv: &Arc<ConvLive>,
        cli: &Arc<Cli>,
        next: brigadier_router::Choice,
        carried: Vec<Message>,
    ) {
        let choice = ModelChoice {
            provider: next.provider,
            model: next.model.clone(),
            effort: next.effort.clone(),
        };
        self.notice(
            &conv.id,
            brigadier_providers::NoticeLevel::Info,
            &format!(
                "{} hit its usage limit; continuing with {} ({}).",
                cli.provider.label(),
                next.provider.label(),
                next.model
                    .clone()
                    .unwrap_or_else(|| "its default model".into())
            ),
        )
        .await;
        conv.close_cli().await;
        {
            let mut state = conv.state.lock().await;
            state.fallback = Some(choice);
            state.reseed = true;
            let mut pending = carried;
            pending.append(&mut state.pending);
            state.pending = pending;
        }
        self.kick(conv);
    }

    /// What each provider can offer right now, for the router.
    pub(crate) fn availability(&self) -> Vec<brigadier_router::Availability> {
        [ProviderKind::Claude, ProviderKind::Codex]
            .into_iter()
            .map(|provider| brigadier_router::Availability {
                provider,
                usable: self.provider_usable(provider),
                models: self
                    .runtime
                    .overview(provider)
                    .and_then(|overview| overview.models)
                    .map(|catalog| catalog.models)
                    .unwrap_or_default(),
            })
            .collect()
    }

    /// The native id of the conversation's last CLI session with `provider`, to resume it.
    async fn last_native_id(&self, id: &ConversationId, provider: ProviderKind) -> Option<String> {
        let page = self
            .core
            .store()
            .read_stream(
                streams::orchestrator(id),
                StreamPage {
                    before: None,
                    kinds: vec!["orchestrator.logged".into()],
                    limit: 200,
                },
            )
            .await
            .ok()?;
        for stored in page {
            let Ok(DomainEvent::OrchestratorLogged {
                entry:
                    OrchestratorEntry::Provider {
                        provider: kind,
                        event,
                    },
                ..
            }) = serde_json::from_str::<DomainEvent>(stored.payload.get())
            else {
                continue;
            };
            match event {
                // A reset marker: the CLI files are gone (archive, cleanup).
                ProviderEvent::Notice { message, .. } if message == prompts::SESSION_RESET => {
                    return None;
                }
                ProviderEvent::SessionStarted { native_id, .. } if kind == provider => {
                    return Some(native_id);
                }
                _ => {}
            }
        }
        None
    }

    /// Marks the conversation's CLI session as gone for good: the next one starts over.
    pub(crate) async fn forget_native_session(&self, id: &ConversationId) {
        self.log_provider(
            id,
            ProviderKind::Claude,
            ProviderEvent::Notice {
                level: brigadier_providers::NoticeLevel::Info,
                message: prompts::SESSION_RESET.into(),
            },
        )
        .await;
    }

    async fn has_history(&self, id: &ConversationId) -> bool {
        self.core
            .list_messages(id.clone(), None, 2)
            .await
            .is_ok_and(|page| page.messages.len() > 1)
    }

    /// The transcript so far, for a CLI session that starts over: the last messages
    /// verbatim (bounded), and the tasks.
    async fn reseed_text(&self, id: &ConversationId, carried: &[Message]) -> String {
        let Ok(page) = self
            .core
            .list_messages(id.clone(), None, RESEED_MESSAGES)
            .await
        else {
            return String::new();
        };
        let carried: Vec<&str> = carried.iter().map(|m| m.id.as_str()).collect();
        let mut lines = Vec::new();
        let mut bytes = 0;
        for message in page.messages.iter().rev() {
            if carried.contains(&message.id.as_str()) {
                continue;
            }
            let who = match message.role {
                MessageRole::User => "User",
                MessageRole::Assistant => "You",
                MessageRole::System => "Brigadier",
            };
            let line = format!("{who}: {}", message.text);
            bytes += line.len();
            if bytes > RESEED_BYTES {
                break;
            }
            lines.push(line);
        }
        lines.reverse();
        let mut text = String::new();
        if !lines.is_empty() {
            text.push_str(
                "[Brigadier: this conversation continues from an earlier session. The transcript so far]\n",
            );
            text.push_str(&lines.join("\n\n"));
        }
        if let Ok(tasks) = self.core.tasks(id).await
            && !tasks.is_empty()
        {
            text.push_str("\n\n[Tasks so far]\n");
            for task in tasks {
                text.push_str(&format!(
                    "task-{} ({:?}, {:?}): {}\n",
                    task.number, task.kind, task.state, task.title
                ));
            }
        }
        text
    }

    pub(crate) async fn set_run(
        &self,
        id: &ConversationId,
        state: RunState,
        error: Option<String>,
    ) {
        if let Err(err) = self
            .core
            .record_conversation(
                id,
                vec![DomainEvent::RunStateChanged {
                    conversation_id: id.clone(),
                    state,
                    error,
                }],
            )
            .await
        {
            tracing::debug!(conversation = %id, error = %err, "could not store the run state");
        }
    }

    pub(crate) async fn notice(
        &self,
        id: &ConversationId,
        level: brigadier_providers::NoticeLevel,
        text: &str,
    ) {
        let event = DomainEvent::ConversationNotice {
            conversation_id: id.clone(),
            notice: Notice {
                level,
                text: text.to_owned(),
                at_ms: now_ms(),
            },
        };
        if let Err(err) = self.core.record_conversation(id, vec![event]).await {
            tracing::debug!(conversation = %id, error = %err, "could not store a notice");
        }
    }

    async fn log_user_injection(&self, conv: &Arc<ConvLive>, message: &Message) {
        if conv.kind != ConversationKind::Session {
            return;
        }
        let bytes = message.blob.as_ref().map_or(message.text.len(), |_| {
            // Stored as a blob: count what was sent.
            message.text.len().max(1)
        });
        self.log_injection(
            &conv.id,
            InjectionKind::UserMessage,
            "user message".into(),
            None,
            bytes,
        )
        .await;
    }

    /// Logs what entered the orchestrator's context.
    pub(crate) async fn log_injection(
        &self,
        id: &ConversationId,
        kind: InjectionKind,
        label: String,
        task_id: Option<TaskId>,
        bytes: usize,
    ) {
        let entry = OrchestratorEntry::Injection {
            injection: ContextInjection {
                kind,
                bytes: bytes as u64,
                tokens_estimate: (bytes as u64).div_ceil(4),
                label,
                task_id,
            },
        };
        self.log_orchestrator(id, entry).await;
    }

    async fn log_provider(
        &self,
        id: &ConversationId,
        provider: ProviderKind,
        event: ProviderEvent,
    ) {
        self.log_orchestrator(id, OrchestratorEntry::Provider { provider, event })
            .await;
    }

    async fn log_orchestrator(&self, id: &ConversationId, entry: OrchestratorEntry) {
        let event = DomainEvent::OrchestratorLogged {
            conversation_id: id.clone(),
            entry,
        };
        if let Err(err) = self
            .core
            .record(vec![(streams::orchestrator(id), event)])
            .await
        {
            tracing::debug!(conversation = %id, error = %err, "could not log the orchestrator");
        }
    }
}

fn is_image(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

/// A file name that is safe inside a folder.
pub(crate) fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_start_matches('.');
    if trimmed.is_empty() {
        "file".into()
    } else {
        trimmed.chars().take(80).collect()
    }
}
