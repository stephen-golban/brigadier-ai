//! [`SessionHandle`]: the thing a supervisor holds for one live session.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use crate::approval::ApprovalTable;
use crate::driver::PermissionMode;
use crate::event::{Envelope, InstanceId, RequestId, SessionId, TurnId};

/// Capacity of the command channel. Commands are operator-paced, so this is small and fixed.
pub const COMMAND_BUFFER: usize = 32;

/// One user turn's input.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TurnInput {
    /// The prompt text.
    pub text: String,
    /// Authored text retained separately from native context.
    pub display_text: Option<String>,
    /// Immutable imported file content.
    pub attachments: Vec<TurnAttachment>,
    /// Files to attach, by absolute path.
    pub attachment_paths: Vec<PathBuf>,
}

impl TurnInput {
    /// A text-only turn.
    pub fn text(s: impl Into<String>) -> Self {
        Self {
            text: s.into(),
            attachment_paths: Vec::new(),
            display_text: None,
            attachments: Vec::new(),
        }
    }
}

/// One image prepared before opening a turn. The ID owns its durable bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnAttachment {
    /// Project-scoped durable identity.
    pub id: String,
    /// Actual validated MIME type.
    pub media_type: String,
    /// Durable display filename.
    pub name: String,
    /// UTF-8 file context when this is a text attachment.
    pub text: Option<String>,
    /// Base64 encoding of immutable bytes.
    pub base64: String,
}

/// How a parked request was answered.
///
/// Mirrors the provider's `PermissionResult` and nothing more. "Always allow" is an
/// [`Decision::Allow`] whose `updated_permissions` echoes the request's `suggestions`; there is
/// deliberately no `AllowAlways` variant.
// see docs/research/agent-sdk.md §3 for `updatedInput`/`updatedPermissions`/`interrupt`, and
// docs/research/provider-driver.md §6 #26 — `acceptAlways` is in t3code's contract and
// implemented by nobody, so it is rejected here.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Decision {
    /// Let the tool run.
    Allow {
        /// Replacement tool input, when the operator edited it.
        updated_input: Option<serde_json::Value>,
        /// Opaque provider permission updates to persist, echoed from the request's suggestions.
        updated_permissions: Vec<serde_json::Value>,
    },
    /// Refuse the tool.
    Deny {
        /// Message handed back to the model.
        reason: String,
        /// Also end the turn rather than letting the model retry.
        interrupt: bool,
    },
}

impl Decision {
    /// Allow with no edits and no persisted rule change.
    pub fn allow() -> Self {
        Self::Allow {
            updated_input: None,
            updated_permissions: Vec::new(),
        }
    }

    /// Deny with a reason, letting the model continue.
    pub fn deny(reason: impl Into<String>) -> Self {
        Self::Deny {
            reason: reason.into(),
            interrupt: false,
        }
    }
}

/// Why a command could not be delivered.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CommandError {
    /// Refused before any provider write.
    #[error("{0}")]
    NotDispatched(String),
    /// The provider may have received part of the request.
    #[error("{0}")]
    DeliveryUnknown(String),
    /// The adapter is gone; the session is over.
    #[error("session is closed")]
    Closed,
    /// The adapter refused the command.
    #[error("{0}")]
    Rejected(String),
}

/// Why a decision could not be applied to a parked request.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum RespondError {
    /// No request by that id was ever opened here.
    #[error("unknown request")]
    Unknown,
    /// It was already answered.
    #[error("request already resolved")]
    AlreadyResolved,
    /// It timed out or was cancelled; nothing is listening.
    #[error("request expired")]
    Expired,
}

/// Why a turn's full final assistant text could not be produced.
///
/// Deliberately distinct from "the text was empty": an orchestration loop that reads its next
/// instruction out of a child's final message must be able to tell *the child said nothing* from
/// *this adapter never held that turn*. Returning `""` for both is how a loop silently does
/// nothing forever.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum FinalTextError {
    /// No turn has been closed by a terminal frame on this session yet.
    #[error("no turn has completed on this session")]
    NoCompletedTurn,
    /// A turn completed, but not that one — only the most recent is kept.
    #[error("the last completed turn is {held}, not the one asked for")]
    NotHeld {
        /// The turn that is held.
        held: TurnId,
    },
}

/// The most recently completed turn's full final assistant text, shared between the adapter that
/// fills it and the [`SessionCommands`] that reads it.
///
/// **Not on the command channel, and that is the point.** The adapter's loop ends when the child
/// exits, so a command-shaped read would answer "session is closed" for exactly the case this
/// exists to serve: a one-turn disposable child whose answer is read *after* it is gone
/// (`docs/research/orchestration-loop.md` §2.2). A shared cell survives the loop, the same reason
/// [`ApprovalTable`] is shared rather than commanded.
///
/// One slot, deliberately: the loop's children are one turn each, so a second completed turn
/// replaces the first rather than accumulating.
#[derive(Clone, Debug, Default)]
pub struct FinalText(Arc<Mutex<Option<(TurnId, String)>>>);

impl FinalText {
    /// An empty slot.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a completed turn's text, replacing whatever was there.
    pub fn set(&self, turn_id: TurnId, text: String) {
        *self.lock() = Some((turn_id, text));
    }

    /// The text of `turn_id`, or why it cannot be had.
    ///
    /// # Errors
    /// [`FinalTextError::NoCompletedTurn`] when nothing has been recorded, and
    /// [`FinalTextError::NotHeld`] when a different turn's text is held.
    pub fn get(&self, turn_id: &TurnId) -> Result<String, FinalTextError> {
        match &*self.lock() {
            Some((held, text)) if held == turn_id => Ok(text.clone()),
            Some((held, _)) => Err(FinalTextError::NotHeld { held: held.clone() }),
            None => Err(FinalTextError::NoCompletedTurn),
        }
    }

    /// The turn whose text is held, if any.
    pub fn held(&self) -> Option<TurnId> {
        self.lock().as_ref().map(|(id, _)| id.clone())
    }

    /// A poisoned lock is recovered rather than propagated: this holds one string, nothing about
    /// it can be left half-written, and a panic elsewhere must not take the seam down with it.
    fn lock(&self) -> MutexGuard<'_, Option<(TurnId, String)>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Native controls verified against Claude 2.1.261. Other adapters refuse them.
/// See docs/research/rewind-context-2026-09-05.md.
#[derive(Clone, Debug)]
pub enum NativeControl {
    /// Current context estimate; never cumulative billing usage.
    ContextSummary,
    /// Observed main/child agent identity and lifecycle, without a provider round trip.
    Activity,
    /// Restore provider file checkpoints, or inspect them without changing files.
    RewindFiles {
        /// Verified native human message UUID.
        message_uuid: String,
        /// Inspect without restoring files.
        dry_run: bool,
    },
    /// Remove the target human message and its following conversation.
    RewindConversation {
        /// Message to remove, along with all later messages.
        target_uuid: String,
        /// Last human message observed, used as the native concurrency guard.
        last_seen_uuid: String,
    },
    /// Release the send barrier only after local persistence has caught up.
    FinishRewind,
    /// Reserve an idle provider while capturing a workspace boundary.
    CheckpointBarrier,
    /// Verify a held capture boundary without releasing its send barrier.
    CheckpointVerify {
        /// Expected event cursor.
        seq: u64,
    },
    /// Check that no events arrived during capture; optionally permit one reserved send.
    CheckpointRelease {
        /// Last observed adapter event cursor.
        seq: u64,
        /// The only message permitted to consume this reservation.
        turn_id: Option<TurnId>,
    },
}

/// One instruction from the supervisor to the adapter driving a session.
#[derive(Debug)]
pub enum Command {
    /// A bounded, provider-specific request with its complete response.
    Native {
        /// Operation; never arbitrary JSON supplied by the frontend.
        request: NativeControl,
        /// Provider response, including semantic refusals.
        ack: oneshot::Sender<Result<serde_json::Value, CommandError>>,
    },
    /// Send a user turn under a locally minted id.
    SendTurn {
        /// The id the adapter must use for this turn's events.
        turn_id: TurnId,
        /// What to send.
        input: TurnInput,
        /// Delivery acknowledgement.
        ack: oneshot::Sender<Result<(), CommandError>>,
    },
    /// End the current turn gracefully; the session survives.
    // see docs/research/agent-sdk.md §10 — interrupt yields a real terminal frame.
    Interrupt {
        /// Delivery acknowledgement.
        ack: oneshot::Sender<Result<(), CommandError>>,
    },
    /// Kill the child process group; no terminal frame will arrive.
    // see docs/research/tauri-runtime.md — killing the direct child leaves the CLI grandchild alive.
    Kill {
        /// Delivery acknowledgement.
        ack: oneshot::Sender<Result<(), CommandError>>,
    },
    /// End the session gracefully: close the child's stdin and let it exit on its own.
    ///
    /// The ack fires once stdin is closed, not once the child is gone — the adapter has to stay
    /// in its loop to observe the exit at all. The exit itself arrives on the event stream as
    /// `SessionExited { reason: Graceful, .. }`.
    // see docs/research/claude-direct-spike.md scenario 1 — exit 0 in 571 ms, no signal needed.
    EndSession {
        /// Delivery acknowledgement.
        ack: oneshot::Sender<Result<(), CommandError>>,
    },
    /// Switch models mid-session.
    SetModel {
        /// New model slug.
        model: String,
        /// Delivery acknowledgement.
        ack: oneshot::Sender<Result<(), CommandError>>,
    },
    /// Switch permission mode mid-session.
    SetPermissionMode {
        /// New mode.
        mode: PermissionMode,
        /// Delivery acknowledgement.
        ack: oneshot::Sender<Result<(), CommandError>>,
    },
}

/// The command side of a session. Cheap to clone; every clone drives the same session.
///
/// It carries the session's [`ApprovalTable`] as well as the command channel, because answering a
/// parked request must not queue behind the adapter's loop: the loop can be busy draining stdout
/// into a backpressured event channel, and "the operator can always answer a permission prompt"
/// is exactly the property that would lose.
#[derive(Clone, Debug)]
pub struct SessionCommands {
    tx: mpsc::Sender<Command>,
    approvals: ApprovalTable,
    final_text: FinalText,
}

impl SessionCommands {
    /// The shared slot an adapter fills. Internal: the public read is
    /// [`SessionCommands::final_assistant_text`].
    pub(crate) fn final_text_slot(&self) -> FinalText {
        self.final_text.clone()
    }

    async fn dispatch(
        &self,
        cmd: Command,
        rx: oneshot::Receiver<Result<(), CommandError>>,
    ) -> Result<(), CommandError> {
        self.tx.send(cmd).await.map_err(|_| CommandError::Closed)?;
        rx.await.map_err(|_| CommandError::Closed)?
    }

    /// Send a verified provider control. A timeout is an unknown outcome, never success.
    pub async fn native_control(
        &self,
        request: NativeControl,
    ) -> Result<serde_json::Value, CommandError> {
        let (ack, rx) = oneshot::channel();
        self.tx
            .send(Command::Native { request, ack })
            .await
            .map_err(|_| CommandError::Closed)?;
        tokio::time::timeout(std::time::Duration::from_secs(20), rx)
            .await
            .map_err(|_| {
                CommandError::Rejected("Provider control timed out; outcome is unconfirmed".into())
            })?
            .map_err(|_| CommandError::Closed)?
    }

    /// Queue a user turn; returns the locally minted turn id the events will carry.
    // see docs/research/provider-driver.md §6 #5 — mint our own ids, never reuse the provider's.
    pub async fn send_turn(&self, input: TurnInput) -> Result<TurnId, CommandError> {
        let turn_id = TurnId::new(uuid::Uuid::new_v4().to_string());
        self.send_reserved_turn(turn_id, input).await
    }

    /// Dispatch a pre-journaled message identity.
    pub async fn send_reserved_turn(
        &self,
        turn_id: TurnId,
        input: TurnInput,
    ) -> Result<TurnId, CommandError> {
        let (ack, rx) = oneshot::channel();
        self.dispatch(
            Command::SendTurn {
                turn_id: turn_id.clone(),
                input,
                ack,
            },
            rx,
        )
        .await?;
        Ok(turn_id)
    }

    /// End the current turn gracefully.
    pub async fn interrupt(&self) -> Result<(), CommandError> {
        let (ack, rx) = oneshot::channel();
        self.dispatch(Command::Interrupt { ack }, rx).await
    }

    /// Kill the session's process group.
    pub async fn kill(&self) -> Result<(), CommandError> {
        let (ack, rx) = oneshot::channel();
        self.dispatch(Command::Kill { ack }, rx).await
    }

    /// End the session gracefully: the adapter closes the child's stdin and the child exits on
    /// its own, yielding `SessionExited { reason: Graceful, .. }` on the event stream.
    ///
    /// The ack returns once stdin is closed; the exit follows on the stream.
    pub async fn end_session(&self) -> Result<(), CommandError> {
        let (ack, rx) = oneshot::channel();
        self.dispatch(Command::EndSession { ack }, rx).await
    }

    /// Answer a parked request.
    ///
    /// This never touches the command channel: the decision goes straight into the approval
    /// table, so it lands even while the adapter's loop is stalled behind a full event channel.
    /// The adapter notices when the parked waiter wakes, writes the provider's answer, and emits
    /// `RequestResolved`.
    ///
    /// A request that was never opened here reports [`RespondError::Unknown`]; one the session
    /// already tore down reports [`RespondError::Expired`], because teardown cancels every park.
    pub async fn respond(
        &self,
        request_id: RequestId,
        decision: Decision,
    ) -> Result<(), RespondError> {
        self.approvals.resolve(&request_id, decision)
    }

    /// Switch models mid-session.
    pub async fn set_model(&self, model: impl Into<String>) -> Result<(), CommandError> {
        let (ack, rx) = oneshot::channel();
        self.dispatch(
            Command::SetModel {
                model: model.into(),
                ack,
            },
            rx,
        )
        .await
    }

    /// Switch permission mode mid-session.
    pub async fn set_permission_mode(&self, mode: PermissionMode) -> Result<(), CommandError> {
        let (ack, rx) = oneshot::channel();
        self.dispatch(Command::SetPermissionMode { mode, ack }, rx)
            .await
    }

    /// The **full** final assistant text of a completed turn, concatenated and bounded — not the
    /// 240-byte summary the feed stores.
    ///
    /// This is the seam an orchestration loop reads its next instruction through: the loop's
    /// children answer with a fenced `json` block (three backticks, then `json`) inside their last
    /// message, and every other channel loses it. `Event::ItemCompleted.summary` is one bounded
    /// *line*, so a JSON block arrives on the event stream as the single character `{`; the
    /// store's `feed` table holds that same pre-rendered line and no body; and `Envelope.raw` is
    /// the provider's own wire JSON, which a provider-agnostic supervisor must not parse. So the
    /// text is assembled where the frame is already decoded and handed back through this
    /// provider-agnostic call.
    /// See `docs/research/orchestration-loop.md` §2.2.
    ///
    /// **Nothing about this is persisted and nothing crosses the IPC boundary.** The feed still
    /// stores the bounded summary; this is an in-process read of the adapter's own buffer.
    ///
    /// Only the **most recently completed** turn is retained, deliberately: the loop's children
    /// are one turn and disposable, so a second turn's text is a second child's problem. Asking
    /// for any other turn reports [`FinalTextError::NotHeld`] rather than an empty string.
    ///
    /// A session that has already ended still answers: the text lives in a [`FinalText`] slot
    /// that outlives the adapter's loop, which is the case this exists for.
    ///
    /// # Errors
    /// [`FinalTextError::NoCompletedTurn`] when no turn has yet been closed by a terminal frame,
    /// and [`FinalTextError::NotHeld`] when the turn asked for is not the one that is kept.
    pub async fn final_assistant_text(&self, turn_id: TurnId) -> Result<String, FinalTextError> {
        self.final_text.get(&turn_id)
    }
}

/// What a supervisor holds for one live session: an event stream in, a command handle out.
///
/// **Backpressure:** `events` is a *bounded* channel sized by `StartSession.event_buffer`. The
/// adapter `await`s `send`, which stalls its own stdout read when the supervisor falls behind. It
/// never drops and never grows. Rust is the only flow control in the system — the webview cannot
/// exert any — so coalescing and dropping belong at the IPC boundary above this type, not here.
// see docs/research/tauri-runtime.md "Implications for the supervisor", and
// docs/research/provider-driver.md §6 #15 — t3code's unbounded PubSub is the rejected alternative.
#[derive(Debug)]
pub struct SessionHandle {
    /// Our id for this session, minted before the child was spawned; every [`Envelope`] on
    /// `events` carries it. The provider's own id arrives later, as `SessionStarted`'s
    /// `provider_session_id`/`resume_token`.
    pub session_id: SessionId,
    /// The provider instance driving it.
    pub instance_id: InstanceId,
    /// Ordered event stream for this session; ends when the adapter drops its sender.
    pub events: mpsc::Receiver<Envelope>,
    /// The command side.
    pub commands: SessionCommands,
    /// The session's parked requests. Shared with the adapter, so a supervisor can list what is
    /// pending — and re-render it after a reload — without asking the adapter's loop.
    pub approvals: ApprovalTable,
    /// The child's process id, when this session is backed by a real process.
    ///
    /// `None` from [`SessionHandle::channel`], which knows nothing about processes; a driver that
    /// spawned a child fills it in before returning the handle, and a driver that spawns nothing
    /// (a replay) leaves it `None`. On Unix the child is its own process group leader, so this is
    /// also the pgid a supervisor hands to an orphan sweeper.
    // see docs/research/orphan-sweep.md — a pid file plus a startup sweep needs the pid at hand.
    pub pid: Option<u32>,
}

/// What an adapter drives: the other end of everything in [`SessionHandle`].
#[derive(Debug)]
pub struct SessionBackend {
    /// Commands from the supervisor.
    pub commands: mpsc::Receiver<Command>,
    /// Where the adapter publishes events; `send` blocks under backpressure.
    pub events: mpsc::Sender<Envelope>,
    /// Parked requests awaiting a decision.
    pub approvals: ApprovalTable,
}

impl SessionHandle {
    /// Build a paired handle and backend. `buffer` is the event channel capacity, at least 1.
    ///
    /// The ids are fixed here, before anything is spawned, so a supervisor can file the handle
    /// under its session id without waiting for the provider's handshake.
    pub fn channel(
        session_id: SessionId,
        instance_id: InstanceId,
        buffer: usize,
    ) -> (SessionHandle, SessionBackend) {
        let (event_tx, event_rx) = mpsc::channel(buffer.max(1));
        let (cmd_tx, cmd_rx) = mpsc::channel(COMMAND_BUFFER);
        let approvals = ApprovalTable::new();
        (
            SessionHandle {
                session_id,
                instance_id,
                events: event_rx,
                commands: SessionCommands {
                    tx: cmd_tx,
                    approvals: approvals.clone(),
                    final_text: FinalText::new(),
                },
                approvals: approvals.clone(),
                pid: None,
            },
            SessionBackend {
                commands: cmd_rx,
                events: event_tx,
                approvals,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{Event, RequestKind};

    fn paired(buffer: usize) -> (SessionHandle, SessionBackend) {
        SessionHandle::channel(SessionId::new("s"), InstanceId::new("i"), buffer)
    }

    fn ask() -> RequestKind {
        RequestKind::tool_permission("Bash", "{}", Vec::new(), None)
    }

    fn envelope(seq: u64) -> Envelope {
        Envelope::new(
            seq,
            InstanceId::new("i"),
            SessionId::new("s"),
            Event::RuntimeWarning {
                message: "w".into(),
            },
        )
    }

    #[test]
    fn decision_wire_shape() {
        assert_eq!(
            serde_json::to_string(&Decision::allow()).expect("ser"),
            r#"{"type":"allow","updated_input":null,"updated_permissions":[]}"#
        );
        assert_eq!(
            serde_json::to_string(&Decision::Deny {
                reason: "no".into(),
                interrupt: true
            })
            .expect("ser"),
            r#"{"type":"deny","reason":"no","interrupt":true}"#
        );
    }

    #[tokio::test]
    async fn event_channel_honours_the_requested_capacity() {
        let (handle, backend) = paired(1);
        backend.events.try_send(envelope(0)).expect("first fits");
        assert!(
            backend.events.try_send(envelope(1)).is_err(),
            "capacity 1 must reject the second"
        );
        drop(handle);
    }

    #[tokio::test]
    async fn send_turn_mints_an_id_the_backend_sees() {
        let (handle, mut backend) = paired(4);
        let commands = handle.commands.clone();
        let task = tokio::spawn(async move { commands.send_turn(TurnInput::text("hi")).await });

        let cmd = backend.commands.recv().await.expect("command arrives");
        let seen = match cmd {
            Command::SendTurn {
                turn_id,
                input,
                ack,
            } => {
                assert_eq!(input.text, "hi");
                ack.send(Ok(())).expect("ack accepted");
                turn_id
            }
            other => panic!("unexpected command: {other:?}"),
        };
        let minted = task.await.expect("task joins").expect("turn accepted");
        assert_eq!(minted, seen);
        assert_ne!(minted.as_str(), "");
    }

    #[tokio::test]
    async fn commands_on_a_dead_session_report_closed() {
        let (handle, backend) = paired(4);
        drop(backend);
        assert_eq!(handle.commands.interrupt().await, Err(CommandError::Closed));
        assert_eq!(handle.commands.kill().await, Err(CommandError::Closed));
        assert_eq!(
            handle.commands.set_model("m").await,
            Err(CommandError::Closed)
        );
        assert_eq!(
            handle
                .commands
                .set_permission_mode(PermissionMode::Plan)
                .await,
            Err(CommandError::Closed)
        );
        assert_eq!(
            handle.commands.end_session().await,
            Err(CommandError::Closed)
        );
        assert_eq!(
            handle
                .commands
                .send_turn(TurnInput::text("x"))
                .await
                .unwrap_err(),
            CommandError::Closed
        );
        // `respond` no longer rides the command channel, so a dead session says what the approval
        // table says. An id that was never parked here is `Unknown`; a real teardown cancels every
        // open park, and those report `Expired` — see `a_torn_down_park_reports_expired`.
        assert_eq!(
            handle
                .commands
                .respond(RequestId::new("r"), Decision::allow())
                .await,
            Err(RespondError::Unknown)
        );
    }

    /// The decision path does not go through the adapter's loop at all: with the backend's command
    /// receiver alive but never polled, an open park is still answerable.
    #[tokio::test]
    async fn respond_bypasses_the_command_channel() {
        let (handle, backend) = paired(1);
        let waiter = backend.approvals.open(RequestId::new("r"), ask(), None);
        assert_eq!(
            handle.approvals.pending().len(),
            1,
            "the handle sees the same table"
        );

        handle
            .commands
            .respond(RequestId::new("r"), Decision::allow())
            .await
            .expect("answered");
        assert_eq!(
            waiter.await.expect("the parked waiter woke"),
            Decision::allow()
        );
        // Nothing was ever queued on the command channel.
        assert!(handle.approvals.pending().is_empty());
    }

    /// Teardown cancels every open park, and a late answer to one of those is `Expired`.
    #[tokio::test]
    async fn a_torn_down_park_reports_expired() {
        let (handle, backend) = paired(1);
        let _waiter = backend.approvals.open(RequestId::new("r"), ask(), None);
        backend.approvals.cancel_all("session exited");
        assert_eq!(
            handle
                .commands
                .respond(RequestId::new("r"), Decision::allow())
                .await,
            Err(RespondError::Expired)
        );
    }

    #[test]
    fn the_handle_carries_its_identity_from_the_start() {
        let (handle, _backend) =
            SessionHandle::channel(SessionId::new("s7"), InstanceId::new("claude-code:work"), 4);
        assert_eq!(handle.session_id, SessionId::new("s7"));
        assert_eq!(handle.instance_id, InstanceId::new("claude-code:work"));
        assert_eq!(handle.pid, None, "a bare channel is backed by no process");
    }

    #[tokio::test]
    async fn an_adapter_rejection_reaches_the_caller() {
        let (handle, mut backend) = paired(4);
        let commands = handle.commands.clone();
        let task = tokio::spawn(async move { commands.interrupt().await });
        match backend.commands.recv().await.expect("command arrives") {
            Command::Interrupt { ack } => {
                ack.send(Err(CommandError::Rejected("no active turn".into())))
                    .expect("ack");
            }
            other => panic!("unexpected command: {other:?}"),
        }
        assert_eq!(
            task.await.expect("task joins"),
            Err(CommandError::Rejected("no active turn".into()))
        );
    }
}
