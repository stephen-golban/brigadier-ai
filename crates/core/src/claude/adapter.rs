//! Wire → canonical: one task per session, translating the CLI's stdio protocol into
//! [`crate::event::Event`]s and the supervisor's [`Command`]s back onto the wire.
//!
//! # Loop structure, and why it is shaped this way
//!
//! `SessionBackend.events` is a *bounded* channel and `send` blocks when the supervisor falls
//! behind. That is the intended flow control for the **stdout side** only: a slow UI should stall
//! the CLI's output, never the operator's ability to answer a permission prompt or kill a runaway
//! session. A naive `events.send(..).await` inside the select loop would do exactly that, because
//! a pending `Respond`/`Interrupt`/`Kill` cannot be dequeued while the task is parked on a send.
//!
//! So the loop never awaits a send. It keeps an internal `outbox: VecDeque<Envelope>` and the
//! select has five arms:
//!
//! | arm | enabled when | effect |
//! |---|---|---|
//! | [`tokio::sync::mpsc::Sender::reserve`] on the event channel | the outbox is non-empty | hands over one envelope through the permit, non-blocking |
//! | inbound line | the outbox is under [`OUTBOX_LIMIT`] | decode one frame, push zero or more envelopes |
//! | command | always | `SendTurn`/`Interrupt`/`Kill`/`Respond`/`SetModel`/`SetPermissionMode` |
//! | resolved approval | always | write the `control_response` the CLI is blocked on |
//! | child exit | once | synthesise the terminal events and drain |
//!
//! `reserve` is cancel-safe (nothing is sent if another branch wins), so a full event channel
//! disables exactly one arm and leaves the other four live. Backpressure then propagates the
//! right way: the outbox fills, the inbound arm switches off, and the reader task's bounded
//! channel stalls the stdout read. Commands keep flowing throughout.
//!
//! The only `await` inside a handler is a write to the child's stdin. The CLI reads its stdin
//! eagerly — the SDK writes the same way (`sdk.mjs:47325-47331`) — so that is not a place a
//! stall is expected; it is called out here because it is the one exception to the rule above.
//!
//! # Mapping
//!
//! Every `match` over a wire type lists every variant by name, including the ones that map to
//! nothing. A new variant in `claude-wire` is then a compile error rather than a silently
//! dropped frame.
// see docs/research/agent-sdk.md §6 for the message union this maps from, and
// docs/research/claude-direct-spike.md for the frames measured on a live account.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::time::Duration;

use claude_wire::control::{
    CanUseToolRequest, ControlRequestKnown, ControlResponseBody, HookCallbackRequest,
    InitializeRequest, InterruptRequest, SetModelRequest, SetPermissionModeRequest,
};
use claude_wire::message::{
    AssistantMessage, CliMessage, ContentBlock, ContentBlockKnown, KnownMessage, MessageContent,
    ResultErrorTag, ResultMessage, SystemInit, SystemMessage, UserMessage,
};
use claude_wire::{
    decode_line, encode_line, ControlRequest, ControlRequestBody, ControlResponse, Inbound,
    PermissionResult, SdkUserMessage,
};
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::approval::ApprovalTable;
use crate::claude::hook::{SharedHookPolicy, PRE_TOOL_USE_CALLBACK_ID};
use crate::claude::process::{ExitInfo, KillHandle};
use crate::driver::DriverError;
use crate::event::{
    bounded, AbortReason, CompactTrigger, Envelope, Event, ExitReason, InstanceId, ItemId,
    ItemKind, RequestId, RequestKind, SessionId, StopReason, TurnId, Usage, SUMMARY_LIMIT,
};
use crate::session::{
    Command, CommandError, Decision, FinalText, NativeControl, SessionBackend, SessionHandle,
    TurnInput,
};

/// How many decoded lines the reader task may run ahead of the select loop.
pub const INBOUND_BUFFER: usize = 64;

/// How many envelopes may queue while the supervisor is behind, before the inbound arm switches
/// off and backpressure reaches the child's stdout.
pub const OUTBOX_LIMIT: usize = 1024;

/// How long the `initialize` handshake may take before the session is declared broken.
///
/// The spike measured 719 ms from spawn to the `initialize` `control_response`; this is two
/// orders of magnitude of headroom, not a tuned value.
// see docs/research/claude-direct-spike.md scenario 1.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// Deny reason handed to every request still parked when the session ends.
pub const EXIT_REASON: &str = "session exited";

/// Deny reason for a request the CLI withdrew with `control_cancel_request`.
pub const CANCELLED_REASON: &str = "cancelled by provider";

/// How much of a turn's final assistant text
/// [`SessionCommands::final_assistant_text`](crate::session::SessionCommands::final_assistant_text)
/// keeps, in bytes.
///
/// **An assumption, not a measurement.** Nothing has counted the size of a real lead-call answer;
/// 64 KiB is chosen to be far larger than the action blocks of
/// `docs/research/orchestration-loop.md` §2.3 and far smaller than a transcript. What is measured
/// is only that it is 8× the 8 KiB `INPUT_EXCERPT_LIMIT` the approval path already carries.
///
/// On overflow the **tail** is kept, not the head: the fenced block a loop reads is at the end of
/// a final message, so a head-first cut would throw away the one part that matters.
pub const FINAL_TEXT_LIMIT: usize = 64 * 1024;

/// The `RequestId` the adapter mints for the `n`-th (1-based) permission prompt of a session.
///
/// Derived rather than random so a caller can address a prompt whose `RequestOpened` it has not
/// read yet — which is exactly what a backpressured supervisor is doing.
// see docs/research/provider-driver.md §6 #5 — the id is ours, never the CLI's `request_id`.
pub fn approval_request_id(session: &SessionId, n: u64) -> RequestId {
    RequestId::new(format!("{session}:approval:{n}"))
}

/// One decoded stdout line, with the raw text kept for [`Envelope::raw`].
#[derive(Debug)]
pub struct InboundLine {
    /// The decoded frame.
    pub frame: Inbound,
    /// The line as it arrived, before bounding.
    pub raw: String,
}

/// Everything the adapter needs that is not a pipe.
#[derive(Clone, Debug)]
pub struct AdapterConfig {
    /// Which provider instance owns this session.
    pub instance_id: InstanceId,
    /// Our session id; also the prefix of every minted request id.
    pub session_id: SessionId,
    /// The cwd handed to the child, used until `system/init` reports its own.
    pub cwd: PathBuf,
    /// Model slug we asked for, used until `system/init` reports the resolved one.
    pub model: Option<String>,
    /// Deadline on a parked permission prompt; `None` parks forever.
    pub approval_timeout: Option<Duration>,
    /// First turn to send once the handshake completes.
    pub prompt: Option<String>,
    /// Event-channel capacity.
    pub event_buffer: usize,
    /// Envelope `seq` this adapter continues from. `0` on a cold start, so the first envelope
    /// is `1`; on a resume it is the row's `sessions.last_event_seq`, so the new child's rows
    /// land *after* the old conversation's instead of overwriting them.
    ///
    /// Not cosmetic. `feed`'s insert is `ON CONFLICT(session_id, seq) DO UPDATE`, so a second
    /// adapter on the same row restarting at `1` silently rewrites the oldest rows and the
    /// ring's trim then deletes the genuinely new ones.
    // see docs/research/resume.md §7 and §8 gap 1.
    pub start_seq: u64,
}

/// Reads `stdout` line by line, decodes each, and forwards it.
///
/// A malformed line is logged and skipped rather than fatal, matching the SDK
/// (`sdk.mjs:46751-46779`). The terminator is trimmed inside `decode_line`.
fn spawn_reader<R>(stdout: R, tx: mpsc::Sender<InboundLine>)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            let line = match lines.next_line().await {
                Ok(Some(line)) => line,
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!(target: "claude.stdout", "read failed: {e}");
                    break;
                }
            };
            match decode_line(line.as_bytes()) {
                Ok(frame) => {
                    if tx.send(InboundLine { frame, raw: line }).await.is_err() {
                        break;
                    }
                }
                Err(claude_wire::DecodeError::EmptyLine) => {}
                Err(e) => {
                    tracing::warn!(target: "claude.stdout", "{e}: {}", bounded(&line, 200));
                }
            }
        }
    });
}

/// The channels the run loop owns as locals, kept out of [`Adapter`] so a `select!` arm and an
/// `&mut self` handler never borrow the same value.
struct Wires {
    inbound: mpsc::Receiver<InboundLine>,
    commands: mpsc::Receiver<Command>,
    resolved: mpsc::UnboundedReceiver<(RequestId, Decision)>,
    exit: oneshot::Receiver<ExitInfo>,
    events: mpsc::Sender<Envelope>,
}

/// The turn the CLI is inside, and whether the harness asked for it.
///
/// The distinction is load-bearing on exactly one decision: [`Command::SendTurn`] refuses while an
/// operator's turn is in flight, and **pre-empts** a minted one. A minted turn is the adapter's own
/// bookkeeping for a turn the CLI ran unasked, so it must never be the reason an operator cannot
/// send.
// see docs/research/unprompted-init.md.
#[derive(Clone, Debug)]
struct OpenTurn {
    /// The id every terminal event for this turn carries.
    id: TurnId,
    /// True when [`Adapter::on_init`] or [`Adapter::on_result`] opened it, false when a
    /// `SendTurn` (or [`connect`]'s `prompt`) did.
    minted: bool,
}

/// One parked `can_use_tool`, kept so the answer can be written back.
#[derive(Debug)]
struct OpenPermission {
    /// The CLI's own `request_id`, echoed on the `control_response`.
    cli_request_id: String,
    /// The tool arguments as the model produced them; echoed as `updatedInput` on an allow.
    original_input: Value,
}

/// Drives one session. Constructed by [`connect`]; owns the child's stdin.
///
/// `stdin` is an `Option` because dropping it is a protocol action, not just cleanup: closing the
/// child's stdin is how a session ends gracefully — the spike measured exit 0 after 571 ms with
/// no signal needed.
// see docs/research/claude-direct-spike.md scenario 1 (measured) and
// docs/research/sidecar-spike.md landmine 5 — readline's `close` fires when the host closes stdin.
struct Adapter<W> {
    stdin: Option<W>,
    approvals: ApprovalTable,
    resolved_tx: mpsc::UnboundedSender<(RequestId, Decision)>,
    kill: KillHandle,
    hook_policy: SharedHookPolicy,
    config: AdapterConfig,

    /// The last `seq` emitted. Starts at [`AdapterConfig::start_seq`], so the first envelope of
    /// a resumed session follows the last one the store already holds.
    seq: u64,
    outbox: VecDeque<Envelope>,
    events_closed: bool,
    shutdown: bool,
    /// True once [`Adapter::close_stdin`] ran: we asked for the end, so a child that leaves
    /// without an exit code left on our say-so rather than crashing.
    ending: bool,

    next_control_id: u64,
    next_approval: u64,
    next_anon_message: u64,
    stream_blocks: HashMap<(String, usize), ItemId>,
    stream_generation: u64,

    open_turn: Option<OpenTurn>,
    provider_session_id: Option<String>,
    session_started: bool,
    killed: bool,

    open_permissions: HashMap<RequestId, OpenPermission>,
    by_cli_id: HashMap<String, RequestId>,
    withdrawn: HashSet<RequestId>,
    pending_acks: HashMap<String, oneshot::Sender<Result<(), CommandError>>>,

    /// The open turn's assistant **text** so far, main loop only, bounded to
    /// [`FINAL_TEXT_LIMIT`] by keeping the tail.
    native_pending: HashMap<String, (NativeControl, oneshot::Sender<Result<Value, CommandError>>)>,
    rewind_paused: bool,
    checkpoint_send: Option<TurnId>,
    checkpoint_tasks_overflow: bool,
    checkpoint_revision: Option<u64>,
    inbound_revision: u64,
    observed_model: Option<String>,
    tasks: Vec<Value>,
    last_action: Option<String>,
    turn_text: String,
    /// The most recently completed turn's text, and nothing older. Shared with
    /// [`SessionCommands`](crate::session::SessionCommands), which is where a caller reads it —
    /// and it outlives this loop, so a one-turn disposable child's answer is still readable after
    /// the child is gone.
    final_text: FinalText,
}

/// Drives one Claude Code session over an already-open pair of pipes.
///
/// The `initialize` handshake completes before this returns, so a broken protocol is a start-up
/// error rather than a session that never speaks. Frames that arrive during the handshake — and
/// `system/init` routinely does not, since the `initialize` response comes first and `init` only
/// follows the first user turn — are buffered and replayed into the loop in order.
///
/// Public because the adapter's test seam is a pair of [`tokio::io::duplex`] pipes; a caller that
/// wants a real process should use [`crate::claude::ClaudeDriver`].
///
/// # Errors
/// [`DriverError::Protocol`] when the handshake fails, times out, or the child's stdout closes
/// before answering.
pub async fn connect<R, W>(
    config: AdapterConfig,
    stdout: R,
    stdin: W,
    exit: oneshot::Receiver<ExitInfo>,
    kill: KillHandle,
    hook_policy: SharedHookPolicy,
) -> Result<SessionHandle, DriverError>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (inbound_tx, inbound_rx) = mpsc::channel(INBOUND_BUFFER);
    spawn_reader(stdout, inbound_tx);

    let (handle, backend) = SessionHandle::channel(
        config.session_id.clone(),
        config.instance_id.clone(),
        config.event_buffer,
    );
    let SessionBackend {
        commands,
        events,
        approvals,
    } = backend;
    // The slot the handle reads from. Taken from the handle rather than passed through the
    // backend, so `SessionBackend`'s shape — which a replay driver destructures — is untouched.
    let final_text = handle.commands.final_text_slot();
    let (resolved_tx, resolved) = mpsc::unbounded_channel();

    // Read before `config` moves into the struct literal below.
    let start_seq = config.start_seq;
    let mut adapter = Adapter {
        stdin: Some(stdin),
        approvals,
        resolved_tx,
        kill,
        hook_policy,
        config,
        // Seeded, not zeroed: on a resume this is the row's `last_event_seq`.
        // see docs/research/resume.md §7.
        seq: start_seq,
        outbox: VecDeque::new(),
        events_closed: false,
        shutdown: false,
        ending: false,
        next_control_id: 0,
        // A fresh native execution may retain the durable Brigadier identity.
        // Seed local identities from its persisted event cursor to avoid old approval/item IDs.
        next_approval: start_seq,
        next_anon_message: start_seq,
        stream_blocks: HashMap::new(),
        stream_generation: start_seq,
        open_turn: None,
        provider_session_id: None,
        session_started: false,
        killed: false,
        open_permissions: HashMap::new(),
        by_cli_id: HashMap::new(),
        withdrawn: HashSet::new(),
        pending_acks: HashMap::new(),
        native_pending: HashMap::new(),
        rewind_paused: false,
        checkpoint_send: None,
        checkpoint_tasks_overflow: false,
        checkpoint_revision: None,
        inbound_revision: 0,
        observed_model: None,
        tasks: Vec::new(),
        last_action: None,
        turn_text: String::new(),
        final_text,
    };

    let mut wires = Wires {
        inbound: inbound_rx,
        commands,
        resolved,
        exit,
        events,
    };
    let buffered = adapter.handshake(&mut wires).await?;

    if let Some(prompt) = adapter.config.prompt.clone() {
        // The prompt path opens a turn the supervisor never asked for, so the id is minted here.
        adapter
            .start_turn(mint_turn_id(), TurnInput::text(prompt))
            .await
            .map_err(|e| DriverError::Protocol(format!("could not send initial prompt: {e}")))?;
    }

    tokio::spawn(adapter.run(wires, buffered));
    Ok(handle)
}

impl<W> Adapter<W>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    // -------------------------------------------------------------------------------------
    // handshake
    // -------------------------------------------------------------------------------------

    /// Sends `initialize` and waits for its `control_response`, returning whatever else arrived.
    ///
    /// The hook payload is the shape the spike proved verbatim
    /// (`crates/claude-spike/fixtures/s6-hook-callback.sent.ndjson`), with `matcher: ""` so it
    /// fires for every tool rather than only `Bash`.
    // see docs/research/claude-direct-spike.md §6 and docs/research/cli-protocol.md §2
    // ("Hooks are registered *in* `initialize`").
    async fn handshake(&mut self, wires: &mut Wires) -> Result<Vec<InboundLine>, DriverError> {
        let request_id = self.mint_control_id();
        let hooks = serde_json::json!({
            "PreToolUse": [{ "matcher": "", "hookCallbackIds": [PRE_TOOL_USE_CALLBACK_ID] }]
        });
        let request = ControlRequest::new(
            request_id.clone(),
            known(ControlRequestKnown::Initialize(Box::new(
                InitializeRequest {
                    hooks: Some(hooks),
                    ..InitializeRequest::default()
                },
            ))),
        );
        self.write_frame(&request)
            .await
            .map_err(|e| DriverError::Protocol(format!("could not send initialize: {e}")))?;

        let mut buffered = Vec::new();
        let deadline = tokio::time::Instant::now() + HANDSHAKE_TIMEOUT;
        loop {
            let line = tokio::time::timeout_at(deadline, wires.inbound.recv())
                .await
                .map_err(|_| {
                    DriverError::Protocol("timed out waiting for the initialize response".into())
                })?
                .ok_or_else(|| {
                    DriverError::Protocol(
                        "child stdout closed before the initialize response".into(),
                    )
                })?;

            if let Inbound::ControlResponse(response) = &line.frame {
                if response.request_id() == request_id {
                    return match &response.response {
                        ControlResponseBody::Success { .. } => {
                            if let Ok(value) = serde_json::to_value(&response.response) {
                                if let Some(body) = value.get("response") {
                                    crate::claude::capabilities::record_commands(
                                        self.config.session_id.as_str(),
                                        body,
                                    );
                                    crate::claude::capabilities::record(
                                        self.config.instance_id.as_str(),
                                        body,
                                    );
                                }
                            }
                            Ok(buffered)
                        }
                        ControlResponseBody::Error { error, .. } => {
                            Err(DriverError::Protocol(format!("initialize failed: {error}")))
                        }
                        // An unmodelled or drifted response shape. The `request_id` matched, so
                        // the CLI did answer; failing the session over a shape we cannot read
                        // would be worse than continuing.
                        ControlResponseBody::Unknown(other) => {
                            tracing::warn!(
                                target: "claude.wire",
                                "initialize answered with an unmodelled response body: {}",
                                bounded(&serde_json::to_string(&other.extra).unwrap_or_default(), 200)
                            );
                            Ok(buffered)
                        }
                    };
                }
            }
            buffered.push(line);
        }
    }

    // -------------------------------------------------------------------------------------
    // the loop
    // -------------------------------------------------------------------------------------

    async fn run(mut self, mut wires: Wires, buffered: Vec<InboundLine>) {
        for line in buffered {
            self.on_inbound(line).await;
        }
        let mut commands_open = true;
        let mut inbound_open = true;
        let mut exited = false;

        loop {
            if self.shutdown && self.outbox.is_empty() {
                break;
            }
            tokio::select! {
                // 1. Hand one envelope over, but only when the consumer has room. Cancel-safe:
                //    if another arm wins, no permit was taken and nothing was sent.
                permit = wires.events.reserve(), if !self.events_closed && !self.outbox.is_empty() => {
                    match permit {
                        Ok(permit) => {
                            if let Some(envelope) = self.outbox.pop_front() {
                                permit.send(envelope);
                            }
                        }
                        Err(_) => {
                            // The supervisor dropped its receiver. Keep serving commands so a
                            // kill still works; stop building envelopes nobody will read.
                            self.events_closed = true;
                            self.outbox.clear();
                        }
                    }
                }
                // 2. One stdout frame, while the outbox has room.
                line = wires.inbound.recv(), if inbound_open && !self.shutdown && self.outbox.len() < OUTBOX_LIMIT => {
                    match line {
                        Some(line) => self.on_inbound(line).await,
                        // stdout closed: the child is on its way out. The exit arm carries the
                        // authoritative reason, so nothing is emitted here.
                        None => {
                            inbound_open = false;
                            tracing::debug!("claude stdout closed");
                        }
                    }
                }
                // 3. Commands. Never gated on the event channel — that is the point of the outbox.
                command = wires.commands.recv(), if commands_open => {
                    match command {
                        Some(command) => self.on_command(command).await,
                        // Every `SessionCommands` clone is gone: nothing can drive this session
                        // again, so end it the graceful way rather than leaving a CLI running
                        // with nobody attached — the same path `Command::EndSession` takes. The
                        // exit arm then reports it.
                        None => {
                            commands_open = false;
                            tracing::debug!("command channel closed; closing the child's stdin");
                            self.close_stdin();
                        }
                    }
                }
                // 4. An approval that was answered, timed out, or cancelled.
                resolved = wires.resolved.recv() => {
                    if let Some((request_id, decision)) = resolved {
                        self.on_decision(request_id, decision).await;
                    }
                }
                // 5. The child exited. Polled once; `exited` disables the arm afterwards.
                info = &mut wires.exit, if !exited => {
                    exited = true;
                    self.on_exit(info.ok());
                }
            }
        }

        // Dropping `wires.events` ends the supervisor's stream: that is the session's EOF.
        tracing::debug!(session = %self.config.session_id, "claude adapter loop finished");
    }

    // -------------------------------------------------------------------------------------
    // inbound frames
    // -------------------------------------------------------------------------------------

    async fn on_inbound(&mut self, line: InboundLine) {
        self.inbound_revision = self.inbound_revision.wrapping_add(1);
        let InboundLine { frame, raw } = line;
        match frame {
            Inbound::Message(CliMessage::Known(message)) => self.on_message(*message, &raw),
            Inbound::Message(CliMessage::Unknown(value)) => {
                tracing::debug!(target: "claude.wire", "unmodelled message type: {}", type_of(&value));
            }
            Inbound::ControlRequest(request) => self.on_control_request(request, &raw).await,
            Inbound::ControlResponse(response) => self.on_control_response(&response),
            Inbound::ControlCancel(cancel) => self.on_control_cancel(&cancel.request_id),
            Inbound::Unknown(value) => {
                let message = format!(
                    "non-object line on stdout: {}",
                    bounded(&value.to_string(), 200)
                );
                self.emit(Event::RuntimeWarning { message }, Some(&raw));
            }
        }
    }

    fn on_message(&mut self, message: KnownMessage, raw: &str) {
        match message {
            KnownMessage::System(system) => self.on_system(system, raw),
            KnownMessage::Assistant(assistant) => self.on_assistant(assistant, raw),
            KnownMessage::User(user) => self.on_user(user, raw),
            KnownMessage::Result(result) => self.on_result(&result, raw),
            KnownMessage::StreamEvent(stream) => self.on_stream(stream, raw),
            KnownMessage::RateLimitEvent(rate) => {
                if let Some(info) = rate.rate_limit_info {
                    crate::claude::capabilities::record_usage(
                        self.config.instance_id.as_str(),
                        info.clone(),
                    );
                    if info.get("status").and_then(Value::as_str) == Some("rejected") {
                        self.emit(
                            Event::RuntimeWarning {
                                message: format!(
                                    "Provider usage limit: {}",
                                    bounded(&info.to_string(), 2048)
                                ),
                            },
                            Some(raw),
                        );
                    }
                }
            }
            // Informational frames, deliberately not events: `system/thinking_tokens` alone was
            // 40 of the 99 frames the spike captured, and a feed of those is noise.
            // see docs/research/claude-direct-spike.md "Frame-type census".
            KnownMessage::ToolProgress(_)
            | KnownMessage::ToolUseSummary(_)
            | KnownMessage::AuthStatus(_)
            | KnownMessage::PromptSuggestion(_)
            | KnownMessage::ConversationReset(_)
            | KnownMessage::ActiveGoal(_)
            | KnownMessage::KeepAlive(_)
            | KnownMessage::TranscriptMirror(_) => {}
        }
    }

    fn on_stream(&mut self, stream: claude_wire::message::StreamEventMessage, raw: &str) {
        let event = stream.event;
        let parent = stream.parent_tool_use_id.unwrap_or_default();
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                self.stream_generation += 1;
            }
            Some("content_block_start") => {
                let block = &event["content_block"];
                let kind = match block["type"].as_str() {
                    Some("text") => ItemKind::AssistantText,
                    Some("thinking") => ItemKind::Thinking,
                    _ => return,
                };
                if self.stream_blocks.len() >= 256 {
                    return;
                }
                let id = ItemId::new(format!(
                    "{}:stream:{}:{parent}:{index}",
                    self.config.session_id, self.stream_generation
                ));
                self.stream_blocks
                    .insert((parent.clone(), index), id.clone());
                self.emit(
                    Event::item_started(
                        id,
                        kind,
                        "",
                        (!parent.is_empty()).then(|| ItemId::new(parent)),
                    ),
                    Some(raw),
                );
            }
            Some("content_block_delta") => {
                if let Some(id) = self.stream_blocks.get(&(parent, index)).cloned() {
                    if let Some(text) = event["delta"]["text"]
                        .as_str()
                        .or_else(|| event["delta"]["thinking"].as_str())
                    {
                        self.emit(
                            Event::ContentDelta {
                                item_id: id,
                                text: bounded(text, 128 * 1024),
                            },
                            Some(raw),
                        );
                    }
                }
            }
            _ => {}
        }
    }

    fn completed_block_id(
        &mut self,
        uuid: Option<&str>,
        index: usize,
        parent: Option<&ItemId>,
    ) -> ItemId {
        self.stream_blocks
            .remove(&(parent.map_or("", ItemId::as_str).to_owned(), index))
            .unwrap_or_else(|| self.block_item_id(uuid, index))
    }

    fn on_system(&mut self, system: SystemMessage, raw: &str) {
        if let SystemMessage::Other(other) = &system {
            if [
                "task_started",
                "task_progress",
                "task_updated",
                "task_notification",
            ]
            .contains(&other.subtype.as_str())
            {
                if let Some(id) = other.extra.get("task_id").and_then(Value::as_str) {
                    let index = self
                        .tasks
                        .iter()
                        .position(|t| t["id"] == id)
                        .unwrap_or_else(|| {
                            if self.tasks.len() >= 64 {
                                self.checkpoint_tasks_overflow = true;
                                self.tasks.remove(0);
                            }
                            self.tasks
                                .push(serde_json::json!({"id":id,"status":"Unknown","model":null}));
                            self.tasks.len() - 1
                        });
                    let task = &mut self.tasks[index];
                    for (from, to) in [
                        ("description", "description"),
                        ("summary", "action"),
                        ("last_tool_name", "action"),
                        ("tool_use_id", "toolId"),
                    ] {
                        if let Some(value) = other.extra.get(from).and_then(Value::as_str) {
                            task[to] = bounded(value, 240).into();
                        }
                    }
                    if other.subtype == "task_started" {
                        task["status"] = "Working".into();
                    }
                    if let Some(status) = other
                        .extra
                        .get("status")
                        .or_else(|| other.extra.get("patch").and_then(|v| v.get("status")))
                        .and_then(Value::as_str)
                    {
                        task["status"] = bounded(status, 40).into();
                    }
                }
            }
        }
        match system {
            SystemMessage::Init(init) => self.on_init(init, raw),
            SystemMessage::CompactBoundary(boundary) => {
                let trigger = match boundary.compact_metadata.trigger.as_str() {
                    "manual" => CompactTrigger::Manual,
                    _ => CompactTrigger::Auto,
                };
                let pre_tokens = boundary.compact_metadata.pre_tokens;
                self.emit(
                    Event::SessionCompacted {
                        trigger,
                        pre_tokens,
                    },
                    Some(raw),
                );
            }
            // Hook lifecycle frames need `includeHookEvents`; `status`, `permission_denied` and
            // the 25 other subtypes are informational. `result.permission_denials` is the
            // authoritative denial record (docs/research/agent-sdk.md §6), so the advisory frame
            // is not an event of its own.
            SystemMessage::Hook(_)
            | SystemMessage::Status(_)
            | SystemMessage::PermissionDenied(_)
            | SystemMessage::Other(_) => {}
        }
    }

    /// `system/init` arrives **once per turn**, not once per process: the spike's interrupted
    /// session produced two, same `session_id`, different `uuid`. Only the first starts the
    /// session; a later one with a different id is a warning, not a second start.
    // see docs/research/claude-direct-spike.md scenario 1, "`system/init` is emitted once per
    // turn" (measured).
    fn on_init(&mut self, init: SystemInit, raw: &str) {
        self.observed_model = Some(init.model.clone().unwrap_or_default());
        let session_id = init.session_id.clone().unwrap_or_default();
        if self.session_started {
            let changed = matches!(
                &self.provider_session_id,
                Some(known) if !session_id.is_empty() && session_id != *known
            );
            if changed {
                let known = self.provider_session_id.clone().unwrap_or_default();
                self.provider_session_id = Some(session_id.clone());
                self.emit(
                    Event::RuntimeWarning {
                        message: format!(
                            "provider session id changed from {known} to {session_id}"
                        ),
                    },
                    Some(raw),
                );
            }
            // A later `system/init` with no open turn is the CLI running a turn the harness never
            // sent: a finished background subagent injects one, and its `result` comes back
            // stamped `origin: {kind:"task-notification"}`. `init` and `result` alternate
            // one-for-one in 14 of the 16 captures; the two exceptions carry no counter-example —
            // `s7-kill` is an `init` with no `result`, the kill path `on_exit` already covers, and
            // `s7-can-use-tool-write` has neither frame. So minting here keeps `open_turn` `Some`
            // for the whole continuation segment, which is what makes `busy` true while the CLI
            // is genuinely working. The turn is marked `minted`: a `SendTurn` pre-empts it rather
            // than being refused, because nothing on the wire promises that every `init` is
            // followed by a `result`.
            //
            // Two consequences, both accepted rather than engineered away:
            //   - `busy` flickers false → true between a `result` and the next `init`. That is
            //     truthful: the CLI completed one turn and started another.
            //   - The minted `turn_id` is one the front end never sent, so the optimistic-entry
            //     retirement in `docs/vision.md` §9 — which fires on a *matched*
            //     `TurnStarted.turn_id` — matches nothing and cannot falsely retire an entry.
            //     That is the correct outcome, not a gap to close.
            //
            // Guarded on `session_started`, so the **first** `init` of a process never mints: a
            // resume is spawned with no prompt (`crates/supervisor/src/lib.rs:635`) and a mint
            // there would open a phantom turn nothing closes until exit.
            // see docs/research/async-subagent-results.md §B.
            if self.open_turn.is_none() {
                let turn_id = mint_turn_id();
                self.open_turn = Some(OpenTurn {
                    id: turn_id.clone(),
                    minted: true,
                });
                self.emit(Event::TurnStarted { turn_id }, None);
            }
            return;
        }
        self.session_started = true;
        self.provider_session_id = Some(session_id.clone());
        // A plain resume continues the same id; only `--fork-session` mints a new one.
        // see docs/research/claude-direct-spike.md scenario 5 (measured).
        let resume_token = (!session_id.is_empty()).then(|| session_id.clone());
        self.emit(
            Event::SessionStarted {
                provider_session_id: session_id,
                model: init
                    .model
                    .or_else(|| self.config.model.clone())
                    .unwrap_or_default(),
                cwd: init
                    .cwd
                    .map(PathBuf::from)
                    .unwrap_or_else(|| self.config.cwd.clone()),
                capabilities: init.capabilities.unwrap_or_default(),
                resume_token,
            },
            Some(raw),
        );
    }

    /// One `ItemStarted`/`ItemCompleted` pair per content block.
    ///
    /// `supersedes` is **not** honoured as an eviction: the replacement frame's blocks are
    /// emitted as fresh items under the new message's uuid, and the superseded uuids are only
    /// logged. A timeline that wants the retracted content gone has to act on the raw excerpt.
    // see docs/research/agent-sdk.md §6 — `supersedes` is the refusal-fallback evict-and-replace.
    // TODO(supersedes): honour the eviction and emit `Event::ItemUpdated` for the replaced items.
    // Nothing in this adapter emits `ItemUpdated` today, so a retracted assistant frame leaves its
    // superseded items standing in the timeline. see docs/research/agent-sdk.md §6
    // (`SDKAssistantMessage.supersedes: UUID[]` — "evict those message uuids").
    fn on_assistant(&mut self, assistant: AssistantMessage, raw: &str) {
        if let Some(model) = assistant.message.model.as_ref() {
            if let Some(parent) = assistant.parent_tool_use_id.as_ref() {
                if let Some(task) = self.tasks.iter_mut().find(|t| t["toolId"] == *parent) {
                    task["model"] = model.clone().into();
                }
            } else {
                self.observed_model = Some(model.clone());
            }
        }
        if let Some(superseded) = assistant.supersedes.as_ref().filter(|s| !s.is_empty()) {
            tracing::debug!(target: "claude.wire", ?superseded, "assistant frame supersedes earlier uuids");
        }
        let parent = assistant.parent_tool_use_id.as_deref().map(ItemId::new);
        let uuid = assistant.uuid.clone();
        match assistant.message.content {
            MessageContent::Text(text) => {
                self.append_turn_text(&text, parent.is_some());
                let item_id = self.completed_block_id(uuid.as_deref(), 0, parent.as_ref());
                self.emit_item(item_id, ItemKind::AssistantText, &text, parent, raw);
            }
            MessageContent::Blocks(blocks) => {
                for (index, block) in blocks.into_iter().enumerate() {
                    self.on_assistant_block(block, uuid.as_deref(), index, parent.clone(), raw);
                }
            }
        }
    }

    fn on_assistant_block(
        &mut self,
        block: ContentBlock,
        uuid: Option<&str>,
        index: usize,
        parent: Option<ItemId>,
        raw: &str,
    ) {
        let known = match block {
            ContentBlock::Known(known) => known,
            ContentBlock::Unknown(value) => {
                tracing::debug!(target: "claude.wire", "unmodelled content block: {}", type_of(&value));
                return;
            }
        };
        match known {
            ContentBlockKnown::Text { text, .. } => {
                self.append_turn_text(&text, parent.is_some());
                let item_id = self.completed_block_id(uuid, index, parent.as_ref());
                self.emit_item(item_id, ItemKind::AssistantText, &text, parent, raw);
            }
            ContentBlockKnown::Thinking { thinking, .. } => {
                let item_id = self.completed_block_id(uuid, index, parent.as_ref());
                self.emit_item(item_id, ItemKind::Thinking, &thinking, parent, raw);
            }
            ContentBlockKnown::RedactedThinking { .. } => {
                let item_id = self.completed_block_id(uuid, index, parent.as_ref());
                self.emit_item(
                    item_id,
                    ItemKind::Thinking,
                    "(redacted thinking)",
                    parent,
                    raw,
                );
            }
            // The item id **is** the `tool_use` id: it is what `can_use_tool.tool_use_id` and the
            // answering `tool_result.tool_use_id` carry, so all three correlate for free.
            ContentBlockKnown::ToolUse {
                id, name, input, ..
            } => {
                let summary = format!("{name}: {}", compact(&input));
                if parent.is_none() {
                    self.last_action = Some(bounded(&summary, 240));
                }
                let kind = ItemKind::ToolCall { name };
                self.emit_item(ItemId::new(id), kind, &summary, parent, raw);
            }
            // A `tool_result` on an assistant frame is not a shape the CLI produces.
            ContentBlockKnown::ToolResult { tool_use_id, .. } => {
                tracing::debug!(target: "claude.wire", %tool_use_id, "tool_result on an assistant frame");
            }
        }
    }

    /// `user` frames carry tool results. Their text blocks — the CLI's synthetic notes such as
    /// `[Request interrupted by user]`, and the echo of the turn we just sent — are not emitted:
    /// the harness already knows what it wrote, and an interruption is reported by `TurnAborted`.
    fn on_user(&mut self, user: UserMessage, raw: &str) {
        let parent = user.parent_tool_use_id.as_deref().map(ItemId::new);
        let MessageContent::Blocks(blocks) = user.message.content else {
            return;
        };
        for block in blocks {
            let ContentBlock::Known(ContentBlockKnown::ToolResult {
                tool_use_id,
                content,
                is_error,
                ..
            }) = block
            else {
                continue;
            };
            let body = content.as_ref().map(result_text).unwrap_or_default();
            let summary = summarize(&body);
            let is_error = is_error.unwrap_or(false);
            self.emit(
                Event::item_completed(
                    ItemId::new(format!("{tool_use_id}:result")),
                    ItemKind::ToolResult {
                        tool_call_id: tool_use_id,
                        is_error,
                    },
                    &summary,
                    parent.clone(),
                ),
                Some(raw),
            );
            if let Some(envelope) = self.outbox.back_mut() {
                envelope.body = Some(bounded(&body, 128 * 1024));
            }
        }
    }

    /// One `result` closes the open turn, and **no `result` frame is ever dropped**.
    ///
    /// One user message can produce N results — 4 measured on `f-b-fanout` — because a finished
    /// background subagent makes the CLI run a turn the harness never sent. `total_cost_usd` and
    /// `modelUsage` are cumulative, so dropping the later frames under-counted by 54.3% in dollars
    /// and 80.7% in `cacheReadInputTokens` on that fixture. `on_init` normally mints the
    /// continuation turn first; the mint below is the belt and braces for a CLI version where the
    /// init/result alternation does not hold, and it emits `TurnStarted` before `TurnCompleted` so
    /// the pair stays intact.
    ///
    /// **The accepted risk, unobserved in any capture:** the failure mode flipped direction here.
    /// A stray `result` with no open turn used to be discarded; it is now translated, and on a
    /// resumed session the supervisor adds the row's stored lifetime base to every `TurnCompleted`
    /// (`crates/supervisor/src/lib.rs:656`). A replayed or duplicated frame carrying a previous
    /// child's cumulative figure therefore **doubles** the row instead of being ignored. On a
    /// usage-window product an over-count trips the 80% reserve early, which is the direction that
    /// costs the owner his own Claude Code. No fixture produces such a frame; nothing guards it.
    ///
    /// `terminal_reason` is checked **before** `subtype`: an interrupted turn's result is
    /// `subtype: "error_during_execution"` with `terminal_reason: "aborted_streaming"`, so
    /// branching on the subtype first would report a real interrupt as a failure.
    // see docs/research/claude-direct-spike.md scenario 4 (measured) and
    // docs/research/async-subagent-results.md §B.
    fn on_result(&mut self, result: &ResultMessage, raw: &str) {
        let view = ResultView::of(result);
        let turn_id = match self.open_turn.take() {
            Some(open) => open.id,
            None => {
                tracing::debug!(target: "claude.wire", subtype = view.subtype, "result with no open turn; minting a continuation");
                let turn_id = mint_turn_id();
                self.emit(
                    Event::TurnStarted {
                        turn_id: turn_id.clone(),
                    },
                    None,
                );
                turn_id
            }
        };
        // A `result` is the turn's terminal frame either way, so whatever text the model produced
        // is final now — including on an abort, where the partial text is still the best answer
        // there will ever be.
        self.close_turn_text(&turn_id);
        let event = match view.terminal_reason {
            // The two abort reasons in `TerminalReason` (`sdk.d.ts:8443`).
            Some("aborted_streaming" | "aborted_tools") => Event::TurnAborted {
                turn_id,
                reason: AbortReason::Interrupted,
            },
            _ if view.success || view.terminal_reason == Some("completed") => {
                Event::TurnCompleted {
                    turn_id,
                    stop_reason: stop_reason_of(view.stop_reason, view.terminal_reason),
                    usage: view.usage(),
                    cost_usd_cumulative: view.total_cost_usd,
                }
            }
            _ => Event::TurnAborted {
                turn_id,
                reason: AbortReason::Error(view.failure_message()),
            },
        };
        self.emit(event, Some(raw));
    }

    // -------------------------------------------------------------------------------------
    // control plane
    // -------------------------------------------------------------------------------------

    async fn on_control_request(&mut self, request: ControlRequest, raw: &str) {
        let cli_request_id = request.request_id;
        let known = match request.request {
            ControlRequestBody::Known(known) => *known,
            ControlRequestBody::Unknown(other) => {
                self.reject_control(cli_request_id, &other.subtype, raw)
                    .await;
                return;
            }
        };
        match known {
            ControlRequestKnown::CanUseTool(ask) => {
                self.open_permission(cli_request_id, ask, raw);
            }
            ControlRequestKnown::HookCallback(hook) => {
                self.answer_hook(cli_request_id, hook).await;
            }
            // Everything else is answered with an error rather than ignored: an unanswered
            // control request parks the CLI forever (`sdk.mjs:47385` documents the same hazard
            // for a `null` permission answer). `request_user_dialog` is the one place this
            // diverges from the SDK, which stays silent for a kind not declared in
            // `initialize.supportedDialogKinds` (`sdk.d.ts:4307`); we declare none, and an
            // explicit refusal is the safer default for a harness that must never wedge.
            ControlRequestKnown::McpMessage(_) => {
                self.reject_control(cli_request_id, "mcp_message", raw)
                    .await;
            }
            ControlRequestKnown::Elicitation(_) => {
                self.reject_control(cli_request_id, "elicitation", raw)
                    .await;
            }
            ControlRequestKnown::RequestUserDialog(_) => {
                self.reject_control(cli_request_id, "request_user_dialog", raw)
                    .await;
            }
            ControlRequestKnown::OauthTokenRefresh(_) => {
                self.reject_control(cli_request_id, "oauth_token_refresh", raw)
                    .await;
            }
            ControlRequestKnown::HostAuthTokenRefresh(_) => {
                self.reject_control(cli_request_id, "host_auth_token_refresh", raw)
                    .await;
            }
            ControlRequestKnown::RemoteControlWorkSecret(_) => {
                self.reject_control(cli_request_id, "remote_control_work_secret", raw)
                    .await;
            }
            // Host → CLI subtypes; the CLI never asks us these.
            ControlRequestKnown::Initialize(_) => {
                self.reject_control(cli_request_id, "initialize", raw).await;
            }
            ControlRequestKnown::Interrupt(_) => {
                self.reject_control(cli_request_id, "interrupt", raw).await;
            }
            ControlRequestKnown::SetPermissionMode(_) => {
                self.reject_control(cli_request_id, "set_permission_mode", raw)
                    .await;
            }
            ControlRequestKnown::SetModel(_) => {
                self.reject_control(cli_request_id, "set_model", raw).await;
            }
        }
    }

    async fn reject_control(&mut self, cli_request_id: String, subtype: &str, raw: &str) {
        let message = format!("control request `{subtype}` is unsupported by brigadier");
        let response = ControlResponse::error(cli_request_id, message.as_str());
        if let Err(e) = self.write_frame(&response).await {
            tracing::warn!("could not refuse `{subtype}`: {e}");
        }
        self.emit(Event::RuntimeWarning { message }, Some(raw));
    }

    fn open_permission(&mut self, cli_request_id: String, ask: CanUseToolRequest, raw: &str) {
        self.next_approval += 1;
        let request_id = approval_request_id(&self.config.session_id, self.next_approval);
        let kind = RequestKind::tool_permission(
            ask.tool_name.clone(),
            &compact(&ask.input),
            // The exact set to echo back as `updatedPermissions` for an "always allow" button.
            // see docs/research/agent-sdk.md §3. Absent on every frame the spike captured.
            match ask.permission_suggestions {
                Some(Value::Array(items)) => items,
                _ => Vec::new(),
            },
            ask.tool_use_id.clone(),
        );
        let receiver = self.approvals.open(
            request_id.clone(),
            kind.clone(),
            self.config.approval_timeout,
        );
        let resolved_tx = self.resolved_tx.clone();
        let parked_id = request_id.clone();
        // One forwarder per park, rather than a `FuturesUnordered` in the loop: it needs no
        // `futures` dependency and costs one task per open prompt, which is bounded by the
        // number of prompts a human can have open.
        tokio::spawn(async move {
            if let Ok(decision) = receiver.await {
                let _ = resolved_tx.send((parked_id, decision));
            }
        });

        self.open_permissions.insert(
            request_id.clone(),
            OpenPermission {
                cli_request_id: cli_request_id.clone(),
                original_input: ask.input,
            },
        );
        self.by_cli_id.insert(cli_request_id, request_id.clone());
        let turn_id = self.open_turn.as_ref().map(|open| open.id.clone());
        self.emit(
            Event::RequestOpened {
                request_id,
                kind,
                turn_id,
            },
            Some(raw),
        );
    }

    /// The `PreToolUse` gate. Answers whatever the policy says — `{}` under
    /// [`crate::claude::AllowAll`] — and emits nothing: this is internal policy, not a question
    /// for the operator.
    async fn answer_hook(&mut self, cli_request_id: String, hook: HookCallbackRequest) {
        if hook.callback_id != PRE_TOOL_USE_CALLBACK_ID {
            tracing::debug!(target: "claude.wire", callback = %hook.callback_id, "hook callback id we did not register");
        }
        let tool_name = hook.input.get("tool_name").and_then(Value::as_str);
        let tool_input = hook.input.get("tool_input").unwrap_or(&Value::Null);
        tracing::debug!(
            target: "claude.hook",
            tool = tool_name.unwrap_or("?"),
            tool_use_id = hook.tool_use_id.as_deref().unwrap_or("?"),
            "PreToolUse"
        );
        let output = self.hook_policy.pre_tool_use(tool_name, tool_input);
        match ControlResponse::success(cli_request_id, &output) {
            Ok(response) => {
                if let Err(e) = self.write_frame(&response).await {
                    tracing::warn!("could not answer the PreToolUse hook: {e}");
                }
            }
            Err(e) => tracing::warn!("could not encode the hook response: {e}"),
        }
    }

    fn on_control_response(&mut self, response: &ControlResponse) {
        let request_id = response.request_id();
        if let Some((request, ack)) = self.native_pending.remove(request_id) {
            let result = match &response.response {
                ControlResponseBody::Success { response, .. } => {
                    Ok(response.clone().unwrap_or(Value::Null))
                }
                ControlResponseBody::Error { error, .. } => {
                    Err(CommandError::Rejected(error.clone()))
                }
                ControlResponseBody::Unknown(_) => Err(CommandError::Rejected(
                    "Unrecognized provider reply; outcome is unconfirmed".into(),
                )),
            };
            if matches!(request, NativeControl::RewindConversation { .. })
                && result
                    .as_ref()
                    .ok()
                    .and_then(|v| v.get("rewound"))
                    .and_then(Value::as_bool)
                    == Some(true)
            {
                self.rewind_paused = true;
                self.checkpoint_revision = Some(self.inbound_revision);
                self.turn_text.clear();
            }
            let result = result.map(|mut value| {
                if let Some(object) = value.as_object_mut() {
                    object.insert("brigadier_seq".into(), self.seq.into());
                }
                value
            });
            let _ = ack.send(result);
            return;
        }
        let Some(ack) = self.pending_acks.remove(request_id) else {
            tracing::debug!(target: "claude.wire", request_id, "control_response with no waiter");
            return;
        };
        let result = match &response.response {
            ControlResponseBody::Success { .. } => Ok(()),
            ControlResponseBody::Error { error, .. } => Err(CommandError::Rejected(error.clone())),
            // The CLI answered in a shape this crate does not model. The command was delivered
            // and acknowledged, which is all the ack promises.
            ControlResponseBody::Unknown(_) => Ok(()),
        };
        let _ = ack.send(result);
    }

    /// The CLI withdrew a request it had asked us. Settle the park, but write nothing back: the
    /// request is gone, and answering a withdrawn id is what the SDK's duplicate guard drops
    /// (`sdk.mjs:47355-47360`).
    fn on_control_cancel(&mut self, cli_request_id: &str) {
        let Some(request_id) = self.by_cli_id.remove(cli_request_id) else {
            tracing::debug!(target: "claude.wire", cli_request_id, "cancel for an unknown request");
            return;
        };
        self.withdrawn.insert(request_id.clone());
        let _ = self
            .approvals
            .resolve(&request_id, Decision::deny(CANCELLED_REASON));
    }

    // -------------------------------------------------------------------------------------
    // decisions
    // -------------------------------------------------------------------------------------

    /// Apply a decision to a parked request, and resolve it **only if the answer reached the
    /// model**.
    ///
    /// `docs/vision.md` §9: *"Approvals are never optimistic. The dock resolves only when Rust
    /// confirms the decision reached the model … a panel that shows 'denied' for a deny that did
    /// not land — or 'allowed' for something that never ran — breaks the one screen the owner has
    /// to be able to trust."* So an encode failure or a failed `write_frame` emits
    /// [`Event::RuntimeWarning`] and **no** [`Event::RequestResolved`]: the request stays open and
    /// expires undelivered, which is the truth.
    ///
    /// The one case that resolves without a write is a request the CLI already withdrew with
    /// `control_cancel_request` — there is nothing left to answer, so nothing failed.
    async fn on_decision(&mut self, request_id: RequestId, decision: Decision) {
        let Some(open) = self.open_permissions.remove(&request_id) else {
            return;
        };
        self.by_cli_id.remove(&open.cli_request_id);
        let withdrawn = self.withdrawn.remove(&request_id);

        if !withdrawn {
            let result = match &decision {
                Decision::Allow {
                    updated_input,
                    updated_permissions,
                } => PermissionResult::Allow {
                    // The spike's working allow echoed the original `input` back as
                    // `updatedInput`; keep that unless the operator edited the arguments.
                    updated_input: Some(
                        updated_input
                            .clone()
                            .unwrap_or_else(|| open.original_input.clone()),
                    ),
                    updated_permissions: (!updated_permissions.is_empty())
                        .then(|| Value::Array(updated_permissions.clone())),
                    tool_use_id: None,
                    decision_classification: None,
                },
                Decision::Deny { reason, interrupt } => PermissionResult::Deny {
                    message: reason.clone(),
                    interrupt: interrupt.then_some(true),
                    tool_use_id: None,
                    decision_classification: None,
                },
            };
            let undelivered = match ControlResponse::success(open.cli_request_id, &result) {
                Ok(response) => self
                    .write_frame(&response)
                    .await
                    .err()
                    .map(|e| e.to_string()),
                Err(e) => Some(e.to_string()),
            };
            if let Some(why) = undelivered {
                tracing::warn!("could not answer can_use_tool {request_id}: {why}");
                // Not resolved: the model never got this. Putting it back would re-arm a park
                // whose waiter is already gone, so the row is simply dropped here and the
                // request expires undelivered.
                self.emit(
                    Event::RuntimeWarning {
                        message: format!(
                            "the decision for request {request_id} did not reach the model \
                             ({why}); the request will expire undelivered"
                        ),
                    },
                    None,
                );
                return;
            }
        }

        self.emit(
            Event::RequestResolved {
                request_id,
                decision,
            },
            None,
        );
    }

    // -------------------------------------------------------------------------------------
    // commands
    // -------------------------------------------------------------------------------------

    async fn on_command(&mut self, command: Command) {
        match command {
            Command::Native { request, ack } => {
                if matches!(request, NativeControl::Steer { .. }) {
                    let _ = ack.send(Err(CommandError::NotDispatched(
                        "Claude steering requires interrupt-and-continue".into(),
                    )));
                    return;
                }
                if matches!(request, NativeControl::Compact) {
                    let _ = ack.send(Err(CommandError::Rejected(
                        "Native compaction control is not implemented by the Claude SDK adapter"
                            .into(),
                    )));
                    return;
                }
                if matches!(request, NativeControl::Activity) {
                    let _ = ack.send(Ok(serde_json::json!({"provider":"Claude Code","cli":"claude","instance":self.config.instance_id,"model":self.observed_model,"status":if self.rewind_paused {"Rewinding"} else if !self.open_permissions.is_empty() {"Needs approval"} else if self.open_turn.is_some() {"Working"} else {"Idle"},"action":self.last_action,"agents":self.tasks})));
                    return;
                }
                if matches!(request, NativeControl::CheckpointBarrier) {
                    let busy = self.shutdown
                        || self.checkpoint_tasks_overflow
                        || self.open_turn.is_some()
                        || !self.open_permissions.is_empty()
                        || self.tasks.iter().any(|t| {
                            !matches!(
                                t["status"].as_str(),
                                Some("completed" | "failed" | "stopped")
                            )
                        })
                        || !self.native_pending.is_empty()
                        || self.rewind_paused;
                    if busy {
                        let _=ack.send(Err(CommandError::Rejected("Workspace checkpoint requires an idle provider with no background tasks".into())));
                    } else {
                        self.rewind_paused = true;
                        self.checkpoint_revision = Some(self.inbound_revision);
                        let _ = ack.send(Ok(serde_json::json!({"seq":self.seq})));
                    }
                    return;
                }
                if let NativeControl::CheckpointVerify { seq } = &request {
                    let valid = self.rewind_paused
                        && *seq == self.seq
                        && self.checkpoint_revision == Some(self.inbound_revision)
                        && self.open_turn.is_none();
                    let _ = ack.send(if valid {
                        Ok(Value::Null)
                    } else {
                        Err(CommandError::Rejected(
                            "Provider advanced during workspace capture".into(),
                        ))
                    });
                    return;
                }
                if let NativeControl::CheckpointRelease { seq, turn_id } = &request {
                    if !self.rewind_paused
                        || *seq != self.seq
                        || self.open_turn.is_some()
                        || self.checkpoint_revision != Some(self.inbound_revision)
                    {
                        self.rewind_paused = false;
                        let _ = ack.send(Err(CommandError::Rejected(
                            "Provider advanced during workspace capture".into(),
                        )));
                    } else {
                        self.checkpoint_send = turn_id.clone();
                        self.rewind_paused = turn_id.is_some();
                        let _ = ack.send(Ok(Value::Null));
                    }
                    return;
                }
                if matches!(request, NativeControl::FinishRewind) {
                    self.rewind_paused = false;
                    self.checkpoint_revision = None;
                    self.checkpoint_send = None;
                    let _ = ack.send(Ok(Value::Null));
                    return;
                }
                let mutating = matches!(
                    request,
                    NativeControl::RewindConversation { .. }
                        | NativeControl::RewindFiles { dry_run: false, .. }
                );
                if self.shutdown
                    || (mutating
                        && self.rewind_paused
                        && self.checkpoint_revision.is_some()
                        && self.checkpoint_revision != Some(self.inbound_revision))
                    || (mutating
                        && (self.open_turn.is_some()
                            || !self.open_permissions.is_empty()
                            || self.checkpoint_tasks_overflow
                            || self.tasks.iter().any(|t| {
                                !matches!(
                                    t["status"].as_str(),
                                    Some("completed" | "failed" | "stopped")
                                )
                            })))
                {
                    let message =
                        "Wait for the current turn and approvals to finish before rewinding";
                    let reply = match request {
                        NativeControl::RewindConversation { .. } => {
                            Ok(serde_json::json!({"rewound":false,"error":message}))
                        }
                        NativeControl::RewindFiles { .. } => {
                            Ok(serde_json::json!({"canRewind":false,"error":message}))
                        }
                        _ => Err(CommandError::Rejected(message.into())),
                    };
                    let _ = ack.send(reply);
                    return;
                }
                self.native_pending
                    .retain(|_, (_, waiter)| !waiter.is_closed());
                if self.native_pending.len() >= 8 {
                    let reply = if matches!(request, NativeControl::RewindConversation { .. }) {
                        Ok(serde_json::json!({"rewound":false,"error":"Provider control is busy"}))
                    } else {
                        Err(CommandError::Rejected("Provider control is busy".into()))
                    };
                    let _ = ack.send(reply);
                    return;
                }
                if mutating {
                    self.rewind_paused = true;
                }
                let body = match &request {
                    NativeControl::ContextSummary => {
                        serde_json::json!({"subtype":"get_context_usage","detail":"summary"})
                    }
                    NativeControl::RewindFiles {
                        message_uuid,
                        dry_run,
                    } => {
                        serde_json::json!({"subtype":"rewind_files","user_message_id":message_uuid,"dry_run":dry_run})
                    }
                    NativeControl::RewindConversation {
                        target_uuid,
                        last_seen_uuid,
                    } => {
                        serde_json::json!({"subtype":"rewind_conversation","target_message_uuid":target_uuid,"last_seen_user_message_uuid":last_seen_uuid,"interrupt_if_running":false})
                    }
                    NativeControl::Compact
                    | NativeControl::FinishRewind
                    | NativeControl::Activity
                    | NativeControl::CheckpointBarrier
                    | NativeControl::CheckpointRelease { .. }
                    | NativeControl::CheckpointVerify { .. }
                    | NativeControl::Steer { .. } => unreachable!(),
                };
                let request_id = self.mint_control_id();
                let frame = serde_json::json!({"type":"control_request","request_id":request_id,"request":body});
                if let Err(e) = self.write_frame(&frame).await {
                    let _ = ack.send(Err(CommandError::Rejected(e.to_string())));
                } else {
                    self.native_pending.insert(request_id, (request, ack));
                }
            }
            Command::SendTurn {
                turn_id,
                input,
                ack,
            } => {
                if self.checkpoint_send.as_ref() == Some(&turn_id) {
                    self.checkpoint_send = None;
                    self.rewind_paused = false;
                    if self.open_turn.is_some()
                        || !self.open_permissions.is_empty()
                        || self.checkpoint_revision != Some(self.inbound_revision)
                    {
                        let _ = ack.send(Err(CommandError::Rejected(
                            "Provider is no longer idle".into(),
                        )));
                        return;
                    }
                }
                if self.rewind_paused {
                    let _ = ack.send(Err(CommandError::Rejected(
                        "Rewind is awaiting local persistence".into(),
                    )));
                    return;
                }
                if self.shutdown {
                    let _ = ack.send(Err(CommandError::Closed));
                    return;
                }
                match self.open_turn.take() {
                    // An operator's turn is genuinely in flight. Refuse, exactly as before: this
                    // adapter does not promise to interleave two user frames in one turn.
                    Some(open) if !open.minted => {
                        self.open_turn = Some(open);
                        let _ =
                            ack.send(Err(CommandError::Rejected("a turn is already open".into())));
                        return;
                    }
                    // A minted turn is the adapter's own bookkeeping for a turn nobody sent, so it
                    // must never be the reason an operator cannot send. A `system/init` that no
                    // `result` ever closes would otherwise refuse every `SendTurn` until the child
                    // exits, leaving a kill as the only escape. Whether the CLI emits such an
                    // `init` is **not settled**: no capture contains one, but the premise that an
                    // `init` follows a user frame is already disproved by the continuation mint
                    // above. see docs/research/unprompted-init.md.
                    //
                    // The trade-off, taken deliberately. The CLI still has a `result` in flight
                    // for the pre-empted turn; it lands on the operator's turn and closes it
                    // early, and the operator's own `result` then mints a continuation of its own.
                    // Attribution is therefore approximate across a pre-emption. Cost is not:
                    // every figure is cumulative and every layer overwrites rather than sums
                    // (`crates/store/src/writer.rs:477`), so the row still ends on the true total.
                    // Never wedged and never unpaired beat exact attribution. A FIFO queue of open
                    // turns would attribute both correctly, but it would rest on the CLI queueing
                    // the send behind the continuation — documented, unmeasured
                    // (docs/research/async-subagent-results.md §D4).
                    //
                    // `Interrupted`, not `Error`: the session survives and nothing failed. The
                    // feed renders an `Error` abort as "error: …" (`crates/store/src/feed.rs:124`),
                    // which this is not.
                    Some(open) => {
                        self.emit(
                            Event::TurnAborted {
                                turn_id: open.id,
                                reason: AbortReason::Interrupted,
                            },
                            None,
                        );
                    }
                    None => {}
                }
                let result = self.start_turn(turn_id, input).await;
                let _ = ack.send(result);
            }
            // A real `result` follows, `terminal_reason: aborted_streaming`, and the session
            // survives. see docs/research/agent-sdk.md §10 and spike scenario 4 (1 ms round trip).
            Command::Interrupt { ack } => {
                let body = known(ControlRequestKnown::Interrupt(InterruptRequest::default()));
                self.send_control(body, ack).await;
            }
            // A kill yields no `result` at all, so the terminal events are synthesised on the
            // exit arm. see docs/research/agent-sdk.md §10 and spike scenario 7 (zero results).
            Command::Kill { ack } => {
                self.killed = true;
                self.kill.kill();
                let _ = ack.send(Ok(()));
            }
            // The graceful end: close stdin and let the CLI's own readline `close` fire. The ack
            // goes back as soon as stdin is gone, because the loop has to keep running to see the
            // exit at all — waiting for the child here would park the very arm that observes it.
            Command::EndSession { ack } => {
                self.close_stdin();
                let _ = ack.send(Ok(()));
            }
            Command::SetModel { model, ack } => {
                let body = known(ControlRequestKnown::SetModel(SetModelRequest {
                    model: Some(model),
                    extra: Default::default(),
                }));
                self.send_control(body, ack).await;
            }
            Command::SetPermissionMode { mode, ack } => {
                let body = known(ControlRequestKnown::SetPermissionMode(
                    SetPermissionModeRequest {
                        // The CLI's own camelCase vocabulary, not this crate's kebab-case.
                        mode: mode.as_cli_flag().to_owned(),
                        extra: Default::default(),
                    },
                ));
                self.send_control(body, ack).await;
            }
        }
    }

    async fn start_turn(&mut self, turn_id: TurnId, input: TurnInput) -> Result<(), CommandError> {
        if !input.attachment_paths.is_empty() {
            return Err(CommandError::NotDispatched(
                "Import attachments into durable project storage before sending".into(),
            ));
        }
        if input.text.trim().is_empty() && input.attachments.is_empty() {
            return Err(CommandError::NotDispatched(
                "A message or image is required".into(),
            ));
        }
        let mut frame = SdkUserMessage::text(input.text.clone());
        if let MessageContent::Blocks(blocks) = &mut frame.message.content {
            if input.text.is_empty() {
                blocks.clear();
            }
            for image in &input.attachments {
                if matches!(
                    image.media_type.as_str(),
                    "text/plain" | "application/octet-stream"
                ) {
                    let text = image
                        .text
                        .as_ref()
                        .filter(|s| s.len() <= 1024 * 1024)
                        .ok_or_else(|| {
                            CommandError::NotDispatched(
                                "Missing text or local file attachment reference".into(),
                            )
                        })?;
                    blocks.push(ContentBlock::Known(ContentBlockKnown::Text {
                        text: format!(
                            "Attached file {} (attachment ID {}):\n{}",
                            image.name, image.id, text
                        ),
                        extra: Default::default(),
                    }));
                    continue;
                }
                if !["image/png", "image/jpeg", "image/gif", "image/webp"]
                    .contains(&image.media_type.as_str())
                    || image.base64.is_empty()
                {
                    return Err(CommandError::NotDispatched(
                        "Unsupported or empty image attachment".into(),
                    ));
                }
                blocks.push(ContentBlock::Unknown(serde_json::json!({"type":"image","source":{"type":"base64","media_type":image.media_type,"data":image.base64}})));
            }
        }
        if !input.attachments.is_empty() {
            if let MessageContent::Blocks(blocks) = &mut frame.message.content {
                let refs = input
                    .attachments
                    .iter()
                    .map(|a| serde_json::json!({"id":a.id,"name":a.name,"mediaType":a.media_type}))
                    .collect::<Vec<_>>();
                blocks.push(ContentBlock::Known(ContentBlockKnown::Text {text:format!("Attachments for this request (use these durable attachmentIds when delegating): {}",serde_json::to_string(&refs).expect("refs")),extra:Default::default()}));
            }
        }
        // A new turn starts on an empty buffer. This is also what discards a pre-empted minted
        // turn's text: that turn never produced a `result` here, so nothing kept it.
        self.turn_text.clear();
        self.last_action = None;
        self.open_turn = Some(OpenTurn {
            id: turn_id.clone(),
            minted: false,
        });
        self.emit(
            Event::TurnStarted {
                turn_id: turn_id.clone(),
            },
            None,
        );
        frame.uuid = Some(turn_id.to_string());
        if let Err(e) = self.write_frame(&frame).await {
            self.emit(
                Event::RuntimeError {
                    message: format!("could not send the turn: {e}"),
                    fatal: false,
                },
                None,
            );
            self.open_turn = None;
            self.emit(
                Event::TurnAborted {
                    turn_id,
                    reason: AbortReason::Error(e.to_string()),
                },
                None,
            );
            return Err(CommandError::DeliveryUnknown(e.to_string()));
        }
        self.emit_item(
            ItemId::new(format!("{turn_id}:user")),
            ItemKind::UserText,
            input.display_text.as_deref().unwrap_or(&input.text),
            None,
            &serde_json::json!({"type":"user","uuid":frame.uuid}).to_string(),
        );
        Ok(())
    }

    /// Writes a host → CLI control request and parks the caller's ack until its response lands.
    async fn send_control(
        &mut self,
        body: ControlRequestBody,
        ack: oneshot::Sender<Result<(), CommandError>>,
    ) {
        let request_id = self.mint_control_id();
        let request = ControlRequest::new(request_id.clone(), body);
        if let Err(e) = self.write_frame(&request).await {
            let _ = ack.send(Err(CommandError::Rejected(e.to_string())));
            return;
        }
        self.pending_acks.insert(request_id, ack);
    }

    // -------------------------------------------------------------------------------------
    // teardown
    // -------------------------------------------------------------------------------------

    /// The one graceful-end path, shared by [`Command::EndSession`] and by the last
    /// `SessionCommands` clone dropping. Dropping the writer closes the child's stdin, the CLI's
    /// readline `close` fires, and it exits 0 with no signal sent.
    ///
    /// Idempotent: a second call is a no-op, so ending a session and then dropping its handle is
    /// not a double teardown.
    // see docs/research/claude-direct-spike.md scenario 1 (exit 0 after 571 ms, measured) and
    // docs/research/sidecar-spike.md landmine 5.
    fn close_stdin(&mut self) {
        self.ending = true;
        self.stdin = None;
    }

    /// Synthesises the terminal events. The `cancel_all` is mandatory: an untimed park with no
    /// waiter left is a turn that never ends.
    // see crates/core/src/approval.rs — teardown fan-out is that type's stated contract.
    fn on_exit(&mut self, info: Option<ExitInfo>) {
        let exit_code = info.and_then(|i| i.code);
        let open: Vec<RequestId> = self.open_permissions.keys().cloned().collect();
        self.approvals.cancel_all(EXIT_REASON);
        for request_id in open {
            self.open_permissions.remove(&request_id);
            self.emit(
                Event::RequestResolved {
                    request_id,
                    decision: Decision::deny(EXIT_REASON),
                },
                None,
            );
        }
        if let Some(open) = self.open_turn.take() {
            let turn_id = open.id;
            let reason = if self.killed {
                AbortReason::Killed
            } else {
                AbortReason::Error("the session ended before the turn completed".into())
            };
            self.emit(Event::TurnAborted { turn_id, reason }, None);
        }
        let reason = if self.killed {
            ExitReason::Killed
        } else if exit_code == Some(0) || (self.ending && exit_code.is_none()) {
            // Closing stdin ends the CLI gracefully: exit 0 after 571 ms, no signal needed.
            // A child that left with no code at all after *we* closed its stdin also ended on our
            // say-so; a **non-zero** code after the same request is still a crash, not a courtesy.
            // see docs/research/claude-direct-spike.md scenario 1 (measured).
            ExitReason::Graceful
        } else {
            ExitReason::Crashed
        };
        self.emit(Event::SessionExited { reason, exit_code }, None);
        for (_, ack) in self.pending_acks.drain() {
            let _ = ack.send(Err(CommandError::Closed));
        }
        self.shutdown = true;
    }

    // -------------------------------------------------------------------------------------
    // plumbing
    // -------------------------------------------------------------------------------------

    fn mint_control_id(&mut self) -> String {
        self.next_control_id += 1;
        // Free format; the SDK uses `Math.random().toString(36)` and the CLI never checks it.
        // see docs/research/cli-protocol.md §2.
        format!("brigadier_{}", self.next_control_id)
    }

    fn block_item_id(&mut self, uuid: Option<&str>, index: usize) -> ItemId {
        match uuid {
            Some(uuid) => ItemId::new(format!("{uuid}:{index}")),
            None => {
                self.next_anon_message += 1;
                ItemId::new(format!(
                    "{}:msg{}:{index}",
                    self.config.session_id, self.next_anon_message
                ))
            }
        }
    }

    fn emit_item(
        &mut self,
        item_id: ItemId,
        kind: ItemKind,
        body: &str,
        parent: Option<ItemId>,
        raw: &str,
    ) {
        let summary = summarize(body);
        self.emit(
            Event::item_started(item_id.clone(), kind.clone(), &summary, parent.clone()),
            Some(raw),
        );
        self.emit(
            Event::item_completed(item_id, kind, &summary, parent),
            Some(raw),
        );
        if let Some(envelope) = self.outbox.back_mut() {
            envelope.body = Some(bounded(body, 128 * 1024));
        }
    }

    /// Accumulate one assistant text block into the open turn's buffer.
    ///
    /// Thinking and tool calls are not text and never arrive here; a block from a **subagent**
    /// (`parent_tool_use_id` set) is dropped, because the caller wants what the child itself said
    /// last, and a background subagent's prose interleaved after it would sit at exactly the tail
    /// this buffer is built to preserve.
    fn append_turn_text(&mut self, text: &str, from_subagent: bool) {
        if from_subagent {
            return;
        }
        if !self.turn_text.is_empty() {
            self.turn_text.push('\n');
        }
        self.turn_text.push_str(text);
        keep_tail(&mut self.turn_text, FINAL_TEXT_LIMIT);
    }

    /// Move the open turn's buffer into the shared slot, replacing whatever was there.
    fn close_turn_text(&mut self, turn_id: &TurnId) {
        let text = std::mem::take(&mut self.turn_text);
        self.final_text.set(turn_id.clone(), text);
    }

    fn emit(&mut self, event: Event, raw: Option<&str>) {
        if self.events_closed {
            return;
        }
        self.seq += 1;
        let envelope = Envelope::new(
            self.seq,
            self.config.instance_id.clone(),
            self.config.session_id.clone(),
            event,
        );
        // Events the adapter synthesises — turn starts, exits, resolutions — have no wire line.
        self.outbox.push_back(match raw {
            Some(raw) => envelope.with_raw(raw),
            None => envelope,
        });
    }

    async fn write_frame<T: Serialize + ?Sized>(&mut self, value: &T) -> std::io::Result<()> {
        let bytes = encode_line(value)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let Some(stdin) = self.stdin.as_mut() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "the child's stdin is closed",
            ));
        };
        stdin.write_all(&bytes).await?;
        stdin.flush().await
    }
}

// -------------------------------------------------------------------------------------------
// free helpers
// -------------------------------------------------------------------------------------------

/// A `TurnId` for a turn nobody asked this adapter for.
///
/// Three callers: [`connect`]'s `prompt`, and the two continuation mints — a `system/init` that
/// arrives with no open turn, and the same case on a `result`.
// see docs/research/async-subagent-results.md §B.
fn mint_turn_id() -> TurnId {
    TurnId::new(uuid::Uuid::new_v4().to_string())
}

fn known(request: ControlRequestKnown) -> ControlRequestBody {
    ControlRequestBody::Known(Box::new(request))
}

fn type_of(value: &Value) -> String {
    value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("<no type>")
        .to_owned()
}

fn compact(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// A `tool_result`'s `content` is a string or a block list; flatten either to text.
fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        other => other.to_string(),
    }
}

/// Trim `s` to at most `max_bytes` **from the front**, on a UTF-8 boundary.
///
/// The opposite end from [`bounded`], and on purpose: this is the buffer a loop reads a fenced
/// block out of, and that block is at the end. No ellipsis is added — the result is fed to a
/// parser, not to a reader, and a marker would be one more thing it has to strip.
fn keep_tail(s: &mut String, max_bytes: usize) {
    if s.len() <= max_bytes {
        return;
    }
    let mut cut = s.len() - max_bytes;
    while cut < s.len() && !s.is_char_boundary(cut) {
        cut += 1;
    }
    s.drain(..cut);
}

/// One terse line, bounded. A summary is a label, never content.
fn summarize(body: &str) -> String {
    let line = body
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    bounded(line, SUMMARY_LIMIT)
}

/// `stop_reason` first, then `terminal_reason`; an unmapped value rides verbatim in `Other`.
// see docs/research/provider-driver.md §6 #21 — never substring-sniff an unmapped value.
fn stop_reason_of(stop: Option<&str>, terminal: Option<&str>) -> StopReason {
    match stop {
        Some("end_turn") => StopReason::EndTurn,
        Some("max_tokens") => StopReason::MaxTokens,
        Some("refusal") => StopReason::Refusal,
        Some(other) => StopReason::Other(other.to_owned()),
        None => match terminal {
            Some("max_turns") => StopReason::MaxTurns,
            Some("completed") | None => StopReason::EndTurn,
            Some(other) => StopReason::Other(other.to_owned()),
        },
    }
}

/// The fields of a `result` the adapter reads, from either subtype arm.
struct ResultView<'a> {
    subtype: &'a str,
    success: bool,
    terminal_reason: Option<&'a str>,
    stop_reason: Option<&'a str>,
    total_cost_usd: f64,
    model_usage: Option<&'a Value>,
    usage: Option<&'a Value>,
    errors: &'a [String],
}

const NO_ERRORS: &[String] = &[];

impl<'a> ResultView<'a> {
    fn of(result: &'a ResultMessage) -> Self {
        match result {
            ResultMessage::Success(r) => ResultView {
                subtype: "success",
                success: true,
                terminal_reason: r.terminal_reason.as_deref(),
                stop_reason: r.stop_reason.as_deref(),
                total_cost_usd: r.total_cost_usd.unwrap_or_default(),
                model_usage: r.model_usage.as_ref(),
                usage: r.usage.as_ref(),
                errors: NO_ERRORS,
            },
            ResultMessage::Error(r) => ResultView {
                subtype: match r.subtype {
                    ResultErrorTag::ErrorDuringExecution => "error_during_execution",
                    ResultErrorTag::ErrorMaxTurns => "error_max_turns",
                    ResultErrorTag::ErrorMaxBudgetUsd => "error_max_budget_usd",
                    ResultErrorTag::ErrorMaxStructuredOutputRetries => {
                        "error_max_structured_output_retries"
                    }
                },
                success: false,
                terminal_reason: r.terminal_reason.as_deref(),
                stop_reason: r.stop_reason.as_deref(),
                total_cost_usd: r.total_cost_usd.unwrap_or_default(),
                model_usage: r.model_usage.as_ref(),
                usage: r.usage.as_ref(),
                errors: r.errors.as_deref().unwrap_or(NO_ERRORS),
            },
            ResultMessage::Other(r) => ResultView {
                subtype: r.subtype.as_str(),
                success: false,
                terminal_reason: r.extra.get("terminal_reason").and_then(Value::as_str),
                stop_reason: r.extra.get("stop_reason").and_then(Value::as_str),
                total_cost_usd: r
                    .extra
                    .get("total_cost_usd")
                    .and_then(Value::as_f64)
                    .unwrap_or_default(),
                model_usage: r.extra.get("modelUsage"),
                usage: r.extra.get("usage"),
                errors: NO_ERRORS,
            },
        }
    }

    fn failure_message(&self) -> String {
        if self.errors.is_empty() {
            match self.terminal_reason {
                Some(reason) => format!("{}: {reason}", self.subtype),
                None => self.subtype.to_owned(),
            }
        } else {
            bounded(&self.errors.join("; "), SUMMARY_LIMIT)
        }
    }

    /// Tokens summed across every model in `modelUsage`, which is the accounting field: it
    /// includes subagents, sidechains and compaction, where `usage` is main-loop-only. Every
    /// number is **cumulative for the session** and read from the latest `result`, never summed
    /// across frames — which is also why `cost_usd_cumulative` passes `total_cost_usd` through
    /// untouched.
    // see docs/research/agent-sdk.md §6; the double-`result` defect is docs/STATUS.md §5.
    fn usage(&self) -> Usage {
        if let Some(Value::Object(models)) = self.model_usage {
            if !models.is_empty() {
                let mut out = Usage::default();
                for entry in models.values() {
                    out.input_tokens += u64_at(entry, "inputTokens");
                    out.output_tokens += u64_at(entry, "outputTokens");
                    out.cache_read_tokens += u64_at(entry, "cacheReadInputTokens");
                    out.cache_creation_tokens += u64_at(entry, "cacheCreationInputTokens");
                    let window = entry.get("contextWindow").and_then(Value::as_u64);
                    out.context_window = out.context_window.max(window);
                }
                return out;
            }
        }
        // `modelUsage` absent: fall back to the main-loop `usage` object's snake_case fields.
        match self.usage {
            Some(usage) => Usage {
                input_tokens: u64_at(usage, "input_tokens"),
                output_tokens: u64_at(usage, "output_tokens"),
                cache_read_tokens: u64_at(usage, "cache_read_input_tokens"),
                cache_creation_tokens: u64_at(usage, "cache_creation_input_tokens"),
                context_window: None,
            },
            None => Usage::default(),
        }
    }
}

fn u64_at(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summaries_are_one_bounded_line() {
        assert_eq!(summarize("hello\nworld"), "hello");
        assert_eq!(summarize("\n\n  second line  \nthird"), "second line");
        assert_eq!(summarize(""), "");
        assert!(summarize(&"x".repeat(1000)).len() <= SUMMARY_LIMIT);
    }

    #[test]
    fn stop_reasons_map_or_ride_verbatim() {
        assert_eq!(
            stop_reason_of(Some("end_turn"), Some("completed")),
            StopReason::EndTurn
        );
        assert_eq!(
            stop_reason_of(Some("max_tokens"), None),
            StopReason::MaxTokens
        );
        assert_eq!(stop_reason_of(Some("refusal"), None), StopReason::Refusal);
        assert_eq!(
            stop_reason_of(None, Some("max_turns")),
            StopReason::MaxTurns
        );
        assert_eq!(stop_reason_of(None, Some("completed")), StopReason::EndTurn);
        assert_eq!(
            stop_reason_of(Some("tool_use"), None),
            StopReason::Other("tool_use".into())
        );
        assert_eq!(
            stop_reason_of(None, Some("api_error")),
            StopReason::Other("api_error".into())
        );
    }

    #[test]
    fn approval_ids_are_derivable_from_the_session() {
        let session = SessionId::new("s1");
        assert_eq!(approval_request_id(&session, 1).as_str(), "s1:approval:1");
        assert_ne!(
            approval_request_id(&session, 1),
            approval_request_id(&session, 2)
        );
    }

    #[test]
    fn tool_result_content_flattens_from_both_shapes() {
        assert_eq!(result_text(&serde_json::json!("ok")), "ok");
        assert_eq!(
            result_text(
                &serde_json::json!([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}])
            ),
            "a b"
        );
        assert_eq!(result_text(&Value::Null), "null");
    }

    #[test]
    fn usage_sums_model_usage_and_falls_back_to_the_main_loop_object() {
        // The two-model shape the spike captured on a real `result`.
        let model_usage = serde_json::json!({
            "claude-haiku-4-5-20251001": {
                "inputTokens": 912, "outputTokens": 13, "cacheReadInputTokens": 0,
                "cacheCreationInputTokens": 0, "contextWindow": 200000
            },
            "claude-haiku-4-5": {
                "inputTokens": 18, "outputTokens": 172, "cacheReadInputTokens": 52852,
                "cacheCreationInputTokens": 190, "contextWindow": 200000
            }
        });
        let view = ResultView {
            subtype: "success",
            success: true,
            terminal_reason: Some("completed"),
            stop_reason: Some("end_turn"),
            total_cost_usd: 0.0075202,
            model_usage: Some(&model_usage),
            usage: None,
            errors: NO_ERRORS,
        };
        assert_eq!(
            view.usage(),
            Usage {
                input_tokens: 930,
                output_tokens: 185,
                cache_read_tokens: 52_852,
                cache_creation_tokens: 190,
                context_window: Some(200_000),
            }
        );

        let usage = serde_json::json!({
            "input_tokens": 18, "output_tokens": 172,
            "cache_read_input_tokens": 52852, "cache_creation_input_tokens": 190
        });
        let fallback = ResultView {
            model_usage: None,
            usage: Some(&usage),
            ..view
        };
        assert_eq!(
            fallback.usage(),
            Usage {
                input_tokens: 18,
                output_tokens: 172,
                cache_read_tokens: 52_852,
                cache_creation_tokens: 190,
                context_window: None,
            }
        );
    }
}
