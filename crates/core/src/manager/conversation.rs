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
//! - Each turn serves one user request (see [`crate::work::UserRequest`]). When a turn ends,
//!   the next one carries, in this order: user messages that could not be steered; else
//!   every envelope of one request (a worker's question first); else the next queued
//!   message (unless the queue is paused). So results reach the orchestrator before the
//!   user's next queued message, and never mixed into another request's turn unlabelled.
//!
//! Every byte sent to the orchestrator is logged as a [`ContextInjection`] on `orch:<id>`,
//! next to the CLI's own usage and context-size events, so the Inspector can show that its
//! context grows only by messages and reports.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use brigadier_providers::{
    Access, ApprovalDecision, Artifact, Decider, ErrorKind, InputFile, ItemStatus, McpServer,
    Origin, ProviderEvent, ProviderKind, ProviderSession, Role as ProviderRole, SessionSpec,
    Started, ToolSet, TurnInput, TurnStatus,
};
use brigadier_store::StreamPage;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::SessionManager;
use super::prompts;
use crate::model::{
    ConversationId, ConversationKind, ConversationStatus, DomainEvent, Lifecycle, Mention, Message,
    MessageRole, ModelChoice, Notice, Setup, streams,
};
use crate::runtime::{is_delta, merge_delta};
use crate::tools::Role;
use crate::work::{
    AttachmentRef, Compaction, CompactionState, ContextInjection, InjectionKind, OrchestratorEntry,
    OrchestratorStepKind, QueuedMessage, RequestState, RunState, TaskId,
};
use crate::{Error, Result, now_ms};

/// Text deltas arriving within this window are stored as one event.
const DELTA_WINDOW: Duration = Duration::from_millis(30);
/// How long a blocking MCP call may take for the orchestrator (its tools return at once).
const ORCHESTRATOR_TOOL_TIMEOUT_SECS: u64 = 120;
/// Messages carried verbatim when a conversation's CLI session is started over.
const RESEED_MESSAGES: usize = 40;
/// Bytes of transcript carried when a conversation's CLI session is started over.
const RESEED_BYTES: usize = 48_000;
/// Messages of an @-mentioned conversation that go along as context.
const MENTIONED_CHAT_MESSAGES: usize = 30;
/// Bytes of an @-mentioned conversation that go along as context.
const MENTIONED_CHAT_BYTES: usize = 24_000;
/// A Chat's text attachments up to this size go into the message itself.
const CHAT_INLINE_MAX_BYTES: usize = 200_000;
const ENDED_UNEXPECTEDLY: &str = "The CLI session ended unexpectedly.";

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
    /// Envelopes for coming turns, each with the request it belongs to.
    inbox: Vec<(Envelope, Option<String>)>,
    /// User messages already in the transcript that the next turn carries.
    pending: Vec<Message>,
    /// The request the running turn serves.
    request: Option<String>,
    /// How the last turn for a request ended, when it was stopped or failed.
    outcomes: HashMap<String, RequestState>,
    /// The last error the running turn reported.
    turn_error: Option<String>,
    /// Brigadier's notes for the next turn that carries user messages (an edit, a redo).
    notes: Vec<String>,
    /// No new turn starts while the user's edit or redo takes the thread apart.
    held: bool,
    /// Tasks stopped by an edit or redo: what they still send is dropped.
    withdrawn: HashSet<TaskId>,
    /// The user messages the running turn carries (resent after a Chat fallback).
    in_turn: Vec<Message>,
    /// Replies that were streaming when a message was steered in, and the request they
    /// answer (the one before the steer).
    replying_for: HashMap<String, String>,
    /// The next CLI session starts fresh and must be given the transcript so far.
    reseed: bool,
    /// A Chat that hit a usage limit continues on this model (the saved choice is untouched).
    fallback: Option<ModelChoice>,
    /// The running turn failed on a usage limit.
    limit_hit: bool,
    /// The running turn is one of its own that compacts the context: messages sent meanwhile
    /// wait for the next turn.
    compacting: bool,
    /// The compaction running now (a Chat's).
    compaction: Option<Compaction>,
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
        state.compacting = false;
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

    /// Whether a turn is starting or running.
    pub(super) async fn turn_running(&self) -> bool {
        self.state.lock().await.busy
    }

    /// Stops the running turn, if any; what it carried stays in the transcript.
    pub(super) async fn interrupt_turn(&self) {
        let cli = {
            let state = self.state.lock().await;
            state.busy.then(|| state.cli.clone()).flatten()
        };
        if let Some(cli) = cli
            && let Err(err) = cli.session.interrupt().await
        {
            tracing::warn!(conversation = %self.id, error = %err, "could not stop the turn");
        }
    }

    /// Holds new turns until [`Self::carry`].
    pub(super) async fn hold(&self) {
        self.state.lock().await.held = true;
    }

    /// Holds new turns and drops what waits for `request`, and anything `tasks` still send:
    /// the user edits or redoes it.
    pub(super) async fn withdraw(&self, request: &str, tasks: impl IntoIterator<Item = TaskId>) {
        let mut state = self.state.lock().await;
        state.held = true;
        state.inbox.retain(|(_, of)| of.as_deref() != Some(request));
        state
            .pending
            .retain(|message| message.request_id.as_deref() != Some(request));
        state.withdrawn.extend(tasks);
    }

    /// Waits until no turn runs (a stopped turn has stored what it said), for at most `limit`.
    pub(super) async fn wait_idle(&self, limit: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + limit;
        while self.turn_running().await {
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        true
    }

    /// Queues a user message (already in the transcript) for the next turn, with a note, and
    /// lets turns start again.
    pub(super) async fn carry(&self, message: Option<Message>, note: Option<String>) {
        let mut state = self.state.lock().await;
        state.pending.extend(message);
        state.notes.extend(note);
        state.held = false;
    }

    /// The request the running turn serves.
    pub(super) async fn running_request(&self) -> Option<String> {
        let state = self.state.lock().await;
        state.busy.then(|| state.request.clone()).flatten()
    }

    /// What the driver holds for each request right now.
    pub(super) async fn request_activity(&self) -> RequestActivity {
        let state = self.state.lock().await;
        RequestActivity {
            running: state.busy.then(|| state.request.clone()).flatten(),
            carried: state
                .inbox
                .iter()
                .filter_map(|(_, request)| request.clone())
                .chain(
                    state
                        .pending
                        .iter()
                        .filter_map(|message| message.request_id.clone()),
                )
                .collect(),
            outcomes: state.outcomes.clone(),
        }
    }
}

/// A conversation driver's part in its requests.
pub(super) struct RequestActivity {
    /// The request of the running turn.
    pub running: Option<String>,
    /// Requests with envelopes or user messages waiting for a turn.
    pub carried: HashSet<String>,
    /// How requests' last turns ended, when they were stopped or failed.
    pub outcomes: HashMap<String, RequestState>,
}

impl SessionManager {
    /// Sends a user message: starts a turn, or queues it, or steers it into the running turn.
    /// With `queue_index` (and no `steer`) it queues at that slot whenever it would wait: while
    /// a turn runs, whatever the queueing setting, or while the queue is paused.
    pub async fn send_message(
        &self,
        id: ConversationId,
        text: String,
        attachments: Vec<AttachmentRef>,
        mentions: Vec<Mention>,
        steer: bool,
        queue_index: Option<u32>,
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
        let queue_index = queue_index.filter(|_| !steer);
        let paused = queue_index.is_some() && self.core.board(&id).await?.queue.paused;
        let conv = self.conv(&id)?;
        let mut state = conv.state.lock().await;
        state.last_activity_ms = now_ms();
        if state.busy && !state.compacting {
            if steer || (queue_index.is_none() && !self.core.settings().queue_enabled) {
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
                let mut into = None;
                if steered {
                    self.log_user_injection(&conv, &message).await;
                    // The rest of the turn answers the new message: its own request.
                    into = std::mem::replace(&mut state.request, message.request_id.clone());
                    state.in_turn.push(message.clone());
                } else {
                    // The turn is still starting (or just ended): the next turn carries it.
                    state.pending.push(message.clone());
                }
                drop(state);
                self.note_steered(&conv, &message, into).await;
                self.settle_requests(&id).await;
                return Ok(SendOutcome::Sent(message));
            }
            let item = self
                .core
                .enqueue(&id, text, attachments, mentions, queue_index)
                .await?;
            return Ok(SendOutcome::Queued(item));
        }
        if paused {
            // Back into the paused queue it came from; nothing sends until the user resumes.
            let item = self
                .core
                .enqueue(&id, text, attachments, mentions, queue_index)
                .await?;
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
        let steered = match (&state.cli, state.busy && !state.compacting) {
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
            let into = std::mem::replace(&mut state.request, message.request_id.clone());
            state.in_turn.push(message.clone());
            drop(state);
            self.note_steered(&conv, &message, into).await;
            self.settle_requests(&id).await;
            return Ok(());
        }
        state.pending.push(message);
        drop(state);
        self.kick(&conv);
        Ok(())
    }

    /// A message steered into the turn of request `into`: its request says so, and after
    /// which reply, so the thread shows it inside that request's block where it was sent. The
    /// reply streaming right now still answers `into`.
    async fn note_steered(&self, conv: &ConvLive, message: &Message, into: Option<String>) {
        let (Some(request), Some(into)) = (&message.request_id, into) else {
            return;
        };
        let streaming = match self.core.board(&conv.id).await {
            Ok(board) => board.streaming.map(|streaming| streaming.message_id),
            Err(_) => None,
        };
        if let Some(reply) = &streaming {
            conv.state
                .lock()
                .await
                .replying_for
                .insert(reply.clone(), into.clone());
        }
        if let Err(err) = self
            .core
            .mark_steered(&conv.id, request, &into, streaming)
            .await
        {
            tracing::warn!(conversation = %conv.id, error = %err, "could not mark a steered request");
        }
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

    /// Continues the latest request after the user stopped it: a turn for that request, in its
    /// block, telling the model to carry on. Workers are untouched (a stop never ends them);
    /// the queue unpauses and runs after this turn.
    pub async fn resume(&self, id: ConversationId) -> Result<()> {
        let conv = self.conv(&id)?;
        {
            let state = conv.state.lock().await;
            if state.busy || !state.pending.is_empty() || !state.inbox.is_empty() {
                return Err(Error::Invalid(
                    "a turn is already running or about to start".into(),
                ));
            }
        }
        let board = self.core.board(&id).await?;
        let request = match board.latest_request() {
            Some(request) if request.state == RequestState::Stopped => request.id.clone(),
            _ => {
                return Err(Error::Invalid(
                    "only a stopped request can be resumed".into(),
                ));
            }
        };
        self.core.set_queue_paused(&id, false).await?;
        let envelope = Envelope {
            kind: InjectionKind::Resume,
            label: "resume".into(),
            task_id: None,
            text: "[The user stopped you, then asked you to resume. Continue their request from \
                   where you left off.]"
                .into(),
        };
        self.deliver_for(&id, envelope, Some(request)).await;
        Ok(())
    }

    /// Compacts a Chat's context now, as ChatGPT's `/compact` does: its CLI summarizes the
    /// conversation in a turn of its own that answers nothing, which the thread shows as one
    /// row. A session's orchestrator never compacts: Brigadier starts it afresh instead.
    pub async fn compact(&self, id: ConversationId) -> Result<()> {
        self.admit()?;
        let conversation = self.core.conversation(&id)?;
        if conversation.kind != ConversationKind::Chat {
            return Err(Error::Invalid("only a chat compacts its context".into()));
        }
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
        if !self.has_history(&id).await {
            return Err(Error::Invalid("there is nothing to compact yet".into()));
        }
        let conv = self.conv(&id)?;
        {
            let mut state = conv.state.lock().await;
            if state.busy || state.held || !state.pending.is_empty() || !state.inbox.is_empty() {
                return Err(Error::Invalid(
                    "wait until the reply is done, then compact".into(),
                ));
            }
            // A turn of its own, for no request.
            state.busy = true;
            state.compacting = true;
            state.request = None;
            state.turn_error = None;
            state.limit_hit = false;
            state.in_turn.clear();
        }
        self.set_run(&id, RunState::Starting, None).await;
        let started = async {
            let cli = self.ensure_cli(&conv).await?;
            if conv.state.lock().await.reseed {
                return Err(Error::Invalid(
                    "the model starts afresh with the next message, so there is nothing to \
                     compact"
                        .into(),
                ));
            }
            if !cli.session.can_compact() {
                return Err(Error::Invalid(format!(
                    "this version of {} cannot compact its context",
                    cli.provider
                )));
            }
            self.set_run(&id, RunState::Running, None).await;
            cli.session
                .compact()
                .await
                .map_err(|err| Error::Provider(err.to_string()))
        }
        .await;
        if let Err(err) = started {
            {
                let mut state = conv.state.lock().await;
                state.busy = false;
                state.compacting = false;
            }
            self.set_run(&id, RunState::Idle, None).await;
            self.kick(&conv);
            return Err(err);
        }
        Ok(())
    }

    /// What `/status` shows: the CLI session of the conversation's model (running, or the one
    /// its next turn resumes) and its provider's usage left.
    pub async fn conversation_status(&self, id: ConversationId) -> Result<ConversationStatus> {
        let conversation = self.core.conversation(&id)?;
        let conv = self.conv(&id)?;
        let (cli, fallback) = {
            let state = conv.state.lock().await;
            (state.cli.clone(), state.fallback.clone())
        };
        let (provider, native_id) = match cli {
            Some(cli) => (cli.provider, Some(cli.session.native_id())),
            None => {
                let provider = match (&conversation.setup, fallback) {
                    (_, Some(fallback)) => fallback.provider,
                    (Some(Setup::Chat { model }), None) => model.provider,
                    (Some(Setup::Session { orchestrator, .. }), None) => orchestrator.provider,
                    (None, None) => {
                        return Err(Error::Invalid(
                            "choose the conversation's model first".into(),
                        ));
                    }
                };
                (provider, self.last_native_id(&id, provider).await)
            }
        };
        Ok(ConversationStatus {
            provider,
            native_id,
            quota: self
                .runtime
                .overview(provider)
                .and_then(|overview| overview.quota),
        })
    }

    /// Queues an envelope for the orchestrator, starting a turn if it is idle. It belongs to
    /// its task's request (or the running turn's, or the newest).
    pub(crate) async fn deliver(&self, id: &ConversationId, envelope: Envelope) {
        let request = self.request_for(id, envelope.task_id.as_ref()).await;
        self.deliver_for(id, envelope, request).await;
    }

    /// Queues an envelope that belongs to `request`.
    pub(crate) async fn deliver_for(
        &self,
        id: &ConversationId,
        envelope: Envelope,
        request: Option<String>,
    ) {
        let Ok(conv) = self.conv(id) else {
            return;
        };
        if matches!(
            self.core.conversation(id).map(|c| c.lifecycle),
            Ok(Lifecycle::Archived)
        ) {
            return;
        }
        {
            let mut state = conv.state.lock().await;
            if envelope
                .task_id
                .as_ref()
                .is_some_and(|task| state.withdrawn.contains(task))
            {
                return;
            }
            state.inbox.push((envelope, request));
        }
        // The request works again until the orchestrator has read it.
        self.settle_requests(id).await;
        self.kick(&conv);
    }

    /// Starts the next turn if none runs and there is something to say.
    pub(crate) fn kick(&self, conv: &Arc<ConvLive>) {
        let manager = self.arc();
        let conv = conv.clone();
        self.spawn(async move { manager.next_turn(conv).await });
    }

    async fn next_turn(self: Arc<Self>, conv: Arc<ConvLive>) {
        let (users, envelopes, request, user_notes) = {
            let mut state = conv.state.lock().await;
            if state.busy || state.closing || state.held || self.admit().is_err() {
                return;
            }
            let mut users = std::mem::take(&mut state.pending);
            let notes = if users.is_empty() {
                Vec::new()
            } else {
                std::mem::take(&mut state.notes)
            };
            let envelopes = if users.is_empty() {
                take_one_request(&mut state.inbox)
            } else {
                Vec::new()
            };
            if users.is_empty() && envelopes.is_empty() {
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
            if users.is_empty() && envelopes.is_empty() {
                drop(state);
                // Nothing left to say: the requests settle.
                self.settle_requests(&conv.id).await;
                return;
            }
            let request = match users.last() {
                Some(message) => message.request_id.clone(),
                None => envelopes[0].1.clone(),
            };
            state.busy = true;
            state.limit_hit = false;
            state.turn_error = None;
            state.request.clone_from(&request);
            if let Some(request) = &request {
                state.outcomes.remove(request);
            }
            state.in_turn = users.clone();
            (users, envelopes, request, notes)
        };
        self.settle_requests(&conv.id).await;
        self.set_run_for(&conv.id, RunState::Starting, None, request.clone())
            .await;
        let cli = match self.ensure_cli(&conv).await {
            Ok(cli) => cli,
            Err(err) => {
                let message = err.to_string();
                self.fail_turn(&conv, users, envelopes, &message).await;
                return;
            }
        };
        let reseed = std::mem::take(&mut conv.state.lock().await.reseed);
        let notes = self
            .request_notes(&conv.id, &envelopes, request.as_deref())
            .await;
        let mut input = self
            .turn_input(&conv, &users, &[user_notes, notes.clone()].concat())
            .await;
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
        for ((envelope, _), note) in envelopes.iter().zip(&notes) {
            self.log_injection(
                &conv.id,
                envelope.kind,
                envelope.label.clone(),
                envelope.task_id.clone(),
                note.len(),
            )
            .await;
        }
        self.set_run_for(&conv.id, RunState::Running, None, request)
            .await;
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
        envelopes: Vec<(Envelope, Option<String>)>,
        message: &str,
    ) {
        {
            let mut state = conv.state.lock().await;
            state.busy = false;
            state.compacting = false;
            if let Some(request) = state.request.take() {
                state.outcomes.insert(
                    request,
                    RequestState::Failed {
                        error: message.to_owned(),
                    },
                );
            }
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
        self.settle_requests(&conv.id).await;
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
                match self
                    .runtime
                    .start_hosted(&owner, choice.provider, spec)
                    .await
                {
                    Ok(started) => started,
                    Err(err) => {
                        self.grants.revoke_owner(&owner);
                        return Err(err);
                    }
                }
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

    /// The turn's input: user messages verbatim, then Brigadier's notes (the envelopes).
    /// Images go along as images. Other attachments are named so the orchestrator can hand
    /// them to workers; a Chat cannot open files, so it gets text files inline.
    async fn turn_input(
        &self,
        conv: &Arc<ConvLive>,
        users: &[Message],
        notes: &[String],
    ) -> TurnInput {
        let mut parts = Vec::new();
        let mut files = Vec::new();
        for message in users {
            let mut text = self.full_text(message).await;
            for attachment in &message.attachments {
                if conv.kind == ConversationKind::Chat && !is_image(&attachment.mime) {
                    text.push_str(&self.inline_attachment(attachment).await);
                    continue;
                }
                if is_image(&attachment.mime)
                    && let Some(file) = self.attachment_file(conv, attachment).await
                {
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
            for mention in &message.mentions {
                match mention {
                    Mention::Task { id } => {
                        if let Ok(tasks) = self.core.tasks(&conv.id).await
                            && let Some(task) = tasks.iter().find(|t| &t.id == id)
                        {
                            text.push_str(&format!(
                                "\n[mentions task-{}: {}]",
                                task.number, task.title
                            ));
                        }
                    }
                    Mention::File { path } => {
                        text.push_str(&format!("\n[mentions the file {path}]"));
                    }
                    Mention::Chat { id, title } => {
                        text.push_str(&self.mentioned_chat(id, title).await);
                    }
                }
            }
            parts.push(text);
        }
        parts.extend(notes.iter().cloned());
        TurnInput {
            text: parts.join("\n\n"),
            files,
        }
    }

    /// Another conversation the user @-mentioned, as context: its latest messages on the
    /// branch it shows (bounded).
    async fn mentioned_chat(&self, id: &ConversationId, title: &str) -> String {
        let branch = match self.core.head(id).await {
            Ok(Some(head)) => self.core.branch(id, &head).await.unwrap_or_default(),
            _ => Vec::new(),
        };
        let mut lines = Vec::new();
        let mut bytes = 0;
        for message in branch.iter().rev().take(MENTIONED_CHAT_MESSAGES) {
            let who = match message.role {
                MessageRole::User => "User",
                MessageRole::Assistant => "Assistant",
                MessageRole::System => continue,
            };
            let line = format!("{who}: {}", message.text);
            bytes += line.len();
            if bytes > MENTIONED_CHAT_BYTES {
                break;
            }
            lines.push(line);
        }
        if lines.is_empty() {
            return format!("\n[mentions the conversation \"{title}\", which has no messages]");
        }
        lines.reverse();
        format!(
            "\n[mentions the conversation \"{title}\"; its latest messages follow]\n{}\n[/conversation]",
            lines.join("\n\n")
        )
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

    /// A Chat's non-image attachment as text in the message: the file itself when it is text
    /// of a sensible size, otherwise a note saying it could not be read.
    async fn inline_attachment(&self, attachment: &AttachmentRef) -> String {
        let bytes = match attachment.id.parse::<brigadier_store::BlobHash>() {
            Ok(hash) => self.core.store().blobs().get(hash).await.ok().flatten(),
            Err(_) => None,
        };
        match bytes.map(String::from_utf8) {
            Some(Ok(content)) if content.len() <= CHAT_INLINE_MAX_BYTES => format!(
                "\n\n[attached file \"{}\" ({})]\n{content}\n[end of \"{}\"]",
                attachment.name, attachment.mime, attachment.name
            ),
            Some(Ok(_)) => format!(
                "\n\n[attached file \"{}\" is larger than {} kB, too large to include here]",
                attachment.name,
                CHAT_INLINE_MAX_BYTES / 1_000
            ),
            _ => format!(
                "\n\n[attached file \"{}\" ({}) is not text and cannot be read in a Chat]",
                attachment.name, attachment.mime
            ),
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
        let mut quiet = Quiet::new(conv.kind == ConversationKind::Session);
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
                        self.store_deltas(&conv.id, quiet.pass(std::mem::take(&mut deltas))).await;
                        let exited = matches!(event, ProviderEvent::Exited { .. });
                        quiet.forget(&event);
                        self.on_conversation_event(&conv, &cli, event).await;
                        if exited {
                            break;
                        }
                    }
                    None => break,
                },
                () = flush_at => {
                    deadline = None;
                    self.store_deltas(&conv.id, quiet.pass(std::mem::take(&mut deltas))).await;
                }
            }
        }
        self.store_deltas(&conv.id, quiet.pass(deltas)).await;
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
            state.compacting = false;
            if let Some(request) = state.request.take()
                && was_busy
                && !state.closing
            {
                state.outcomes.insert(
                    request,
                    RequestState::Failed {
                        error: ENDED_UNEXPECTEDLY.into(),
                    },
                );
            }
            (was_busy, state.closing)
        };
        self.end_compaction(&conv, ENDED_UNEXPECTEDLY.into()).await;
        cli.ended.cancel();
        if was_busy && !closing {
            self.set_run(&conv.id, RunState::Failed, Some(ENDED_UNEXPECTEDLY.into()))
                .await;
        } else if !closing {
            self.set_run(&conv.id, RunState::Idle, None).await;
        }
        self.settle_requests(&conv.id).await;
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
                let request = {
                    let mut state = conv.state.lock().await;
                    state
                        .replying_for
                        .remove(item_id)
                        .or_else(|| state.request.clone())
                };
                let shown = if conv.kind == ConversationKind::Session {
                    without_quiet(text)
                } else {
                    Some(text.as_str())
                };
                if let Some(text) = shown
                    && let Err(err) = self
                        .core
                        .append_assistant_message(
                            conv.id.clone(),
                            item_id.clone(),
                            text.to_owned(),
                            Some(cli.model.clone()),
                            request,
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
                    conv.state.lock().await.turn_error = Some(error.message.clone());
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
            ProviderEvent::ToolCall {
                name,
                input,
                status: ItemStatus::Completed,
                ..
            } if conv.kind == ConversationKind::Chat => {
                if let Some(kind) = web_step(name, input.as_deref()) {
                    self.orchestrator_step(&conv.id, kind).await;
                }
            }
            ProviderEvent::RateLimits { quota } => {
                self.runtime.note_quota_snapshot(quota.clone()).await;
            }
            ProviderEvent::CompactionStarted { automatic }
                if conv.kind == ConversationKind::Chat =>
            {
                let after = self
                    .core
                    .board(&conv.id)
                    .await
                    .ok()
                    .and_then(|board| board.head.map(|(head, _)| head));
                let compaction = {
                    let mut state = conv.state.lock().await;
                    let compaction = Compaction {
                        id: uuid::Uuid::now_v7().to_string(),
                        // Compacting on its own, the model is in the middle of a request.
                        request_id: automatic.then(|| state.request.clone()).flatten(),
                        after,
                        automatic: *automatic,
                        state: CompactionState::Running,
                        tokens_before: None,
                        tokens_after: None,
                        started_at_ms: now_ms(),
                        ended_at_ms: None,
                        position: 0,
                    };
                    state.compaction = Some(compaction.clone());
                    compaction
                };
                self.record_compaction(&conv.id, compaction).await;
            }
            ProviderEvent::CompactionEnded {
                automatic,
                tokens_before,
                tokens_after,
                error,
            } if conv.kind == ConversationKind::Chat => {
                let running = conv.state.lock().await.compaction.take();
                let now = now_ms();
                let mut compaction = running.unwrap_or_else(|| Compaction {
                    id: uuid::Uuid::now_v7().to_string(),
                    request_id: None,
                    after: None,
                    automatic: *automatic,
                    state: CompactionState::Running,
                    tokens_before: None,
                    tokens_after: None,
                    started_at_ms: now,
                    ended_at_ms: None,
                    position: 0,
                });
                compaction.state = match error {
                    Some(error) => CompactionState::Failed {
                        error: error.clone(),
                    },
                    None => CompactionState::Done,
                };
                compaction.tokens_before = *tokens_before;
                compaction.tokens_after = *tokens_after;
                compaction.ended_at_ms = Some(now);
                self.record_compaction(&conv.id, compaction).await;
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

    /// Stores a compaction's snapshot.
    async fn record_compaction(&self, id: &ConversationId, compaction: Compaction) {
        if let Err(err) = self
            .core
            .record_conversation(id, vec![DomainEvent::CompactionUpdated { compaction }])
            .await
        {
            tracing::warn!(conversation = %id, error = %err, "could not store a compaction");
        }
    }

    /// A compaction the turn left unfinished failed (it was stopped, or the CLI ended).
    async fn end_compaction(&self, conv: &Arc<ConvLive>, error: String) {
        let Some(mut compaction) = conv.state.lock().await.compaction.take() else {
            return;
        };
        compaction.state = CompactionState::Failed { error };
        compaction.ended_at_ms = Some(now_ms());
        self.record_compaction(&conv.id, compaction).await;
    }

    async fn turn_completed(&self, conv: &Arc<ConvLive>, cli: &Arc<Cli>, status: TurnStatus) {
        let unfinished = match status {
            TurnStatus::Interrupted => "You stopped it".to_owned(),
            _ => conv
                .state
                .lock()
                .await
                .turn_error
                .clone()
                .unwrap_or_else(|| "The model did not finish compacting".into()),
        };
        self.end_compaction(conv, unfinished).await;
        let (limit_hit, carried) = {
            let mut state = conv.state.lock().await;
            state.busy = false;
            state.compacting = false;
            state.last_activity_ms = now_ms();
            state.replying_for.clear();
            let ended = match status {
                TurnStatus::Interrupted => Some(RequestState::Stopped),
                TurnStatus::Failed => Some(RequestState::Failed {
                    error: state
                        .turn_error
                        .take()
                        .unwrap_or_else(|| "The reply failed.".into()),
                }),
                _ => None,
            };
            if let Some(request) = state.request.take()
                && let Some(ended) = ended
            {
                state.outcomes.insert(request, ended);
            }
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
        self.settle_requests(&conv.id).await;
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

    /// The transcript so far, for a CLI session that starts over: the last messages of the
    /// branch shown, verbatim (bounded), and the tasks.
    async fn reseed_text(&self, id: &ConversationId, carried: &[Message]) -> String {
        let branch = match self.core.head(id).await {
            Ok(Some(head)) => self.core.branch(id, &head).await.unwrap_or_default(),
            _ => Vec::new(),
        };
        let carried: Vec<&str> = carried.iter().map(|m| m.id.as_str()).collect();
        let mut lines = Vec::new();
        let mut bytes = 0;
        for message in branch.iter().rev().take(RESEED_MESSAGES) {
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
        self.set_run_for(id, state, error, None).await;
    }

    /// Records the run state of a turn that serves `request`.
    async fn set_run_for(
        &self,
        id: &ConversationId,
        state: RunState,
        error: Option<String>,
        request: Option<String>,
    ) {
        if let Err(err) = self
            .core
            .record_conversation(
                id,
                vec![DomainEvent::RunStateChanged {
                    conversation_id: id.clone(),
                    state,
                    error,
                    request_id: request,
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

/// Holds back an orchestrator reply's streamed text while it may still be [`prompts::QUIET`],
/// so the user never sees it appear.
struct Quiet {
    enabled: bool,
    /// Text streamed so far per reply still held back; released replies are absent.
    held: HashMap<String, String>,
    released: HashSet<String>,
}

impl Quiet {
    fn new(enabled: bool) -> Self {
        Self {
            enabled,
            held: HashMap::new(),
            released: HashSet::new(),
        }
    }

    /// The deltas the user may see: a reply's text is released, whole, once it can no longer
    /// be [`prompts::QUIET`].
    fn pass(&mut self, deltas: Vec<ProviderEvent>) -> Vec<ProviderEvent> {
        if !self.enabled {
            return deltas;
        }
        deltas
            .into_iter()
            .filter_map(|event| match event {
                ProviderEvent::MessageDelta { item_id, text } => {
                    if self.released.contains(&item_id) {
                        return Some(ProviderEvent::MessageDelta { item_id, text });
                    }
                    let so_far = self.held.entry(item_id.clone()).or_default();
                    so_far.push_str(&text);
                    if prompts::QUIET.starts_with(so_far.trim()) {
                        return None;
                    }
                    let text = self.held.remove(&item_id).unwrap_or_default();
                    self.released.insert(item_id.clone());
                    Some(ProviderEvent::MessageDelta { item_id, text })
                }
                event => Some(event),
            })
            .collect()
    }

    /// Forgets a reply once it is complete.
    fn forget(&mut self, event: &ProviderEvent) {
        if let ProviderEvent::Message { item_id, .. } = event {
            self.held.remove(item_id);
            self.released.remove(item_id);
        }
    }
}

/// An orchestrator reply as the user sees it: without a trailing [`prompts::QUIET`], and
/// nothing when that was all of it.
fn without_quiet(text: &str) -> Option<&str> {
    let text = text.trim_end();
    let text = text.strip_suffix(prompts::QUIET).unwrap_or(text).trim_end();
    (!text.trim_start().is_empty()).then_some(text)
}

/// Takes every envelope of one request from the inbox, in arrival order: the request of the
/// first worker question (it blocks a worker), else of the oldest envelope.
fn take_one_request(
    inbox: &mut Vec<(Envelope, Option<String>)>,
) -> Vec<(Envelope, Option<String>)> {
    let Some(request) = inbox
        .iter()
        .find(|(envelope, _)| envelope.kind == InjectionKind::WorkerQuestion)
        .or_else(|| inbox.first())
        .map(|(_, request)| request.clone())
    else {
        return Vec::new();
    };
    let (taken, kept) = std::mem::take(inbox)
        .into_iter()
        .partition(|(_, of)| *of == request);
    *inbox = kept;
    taken
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

/// A Chat's web search or page read, as a row for its answer.
fn web_step(tool: &str, input: Option<&str>) -> Option<OrchestratorStepKind> {
    let field = |key: &str| {
        input
            .and_then(|input| serde_json::from_str::<serde_json::Value>(input).ok())
            .and_then(|args| {
                args.get(key)
                    .and_then(|value| value.as_str().map(str::to_owned))
            })
    };
    match tool {
        "WebSearch" => field("query").map(|query| OrchestratorStepKind::SearchedWeb { query }),
        // Codex gives the query itself.
        "web_search" => input.map(|query| OrchestratorStepKind::SearchedWeb {
            query: query.to_owned(),
        }),
        "WebFetch" => field("url").map(|url| OrchestratorStepKind::ReadPage { url }),
        _ => None,
    }
}
