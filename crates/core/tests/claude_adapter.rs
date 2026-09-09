//! The Claude adapter, replayed against the real captures in `crates/claude-spike/fixtures/`.
//!
//! No `claude` process is spawned by any test here except the `#[ignore]`d `live_pong`. The
//! adapter is driven over a pair of [`tokio::io::duplex`] pipes: the test writes a fixture's
//! stdout lines into one and reads what the adapter wrote to the child's stdin out of the other.
//!
//! Lines are fed **in order and in steps**, not all at once, because the CLI's own ordering is
//! part of what is under test: the frames after a `can_use_tool` exist only because the host
//! answered it, so replaying them before the answer would prove nothing.
//!
//! The one thing a fixture cannot supply verbatim is a `control_response`'s `request_id` — it
//! echoes an id the adapter mints at run time. [`Rig::feed`] rewrites exactly that field, taking
//! the id from the next unanswered `control_request` the adapter actually wrote.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Duration;

use brigadier_core::approval::ApprovalTable;
use brigadier_core::claude::adapter::{
    approval_request_id, connect, AdapterConfig, EXIT_REASON, FINAL_TEXT_LIMIT,
};
use brigadier_core::claude::hook::allow_all;
use brigadier_core::claude::process::{ExitInfo, KillHandle};
use brigadier_core::event::{
    Envelope, Event, ExitReason, InstanceId, ItemId, ItemKind, RequestKind, SessionId, StopReason,
    TurnId, Usage,
};
use brigadier_core::session::{Decision, FinalTextError, SessionCommands, TurnInput};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::{mpsc, oneshot};

/// Big enough for the largest fixture (`s4`, 43 KB) so a `feed` never blocks on the pipe.
const PIPE: usize = 256 * 1024;

fn fixture_lines(name: &str) -> VecDeque<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claude-spike/fixtures")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("fixture {}: {e}", path.display()));
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

/// One replayed session.
struct Rig {
    events: mpsc::Receiver<Envelope>,
    commands: SessionCommands,
    approvals: ApprovalTable,
    to_adapter: DuplexStream,
    sent_rx: mpsc::UnboundedReceiver<String>,
    sent_log: Vec<Value>,
    sent_cursor: usize,
    outbound: VecDeque<String>,
    lines: VecDeque<String>,
    collected: Vec<Event>,
    exit_tx: Option<oneshot::Sender<ExitInfo>>,
    kill_rx: mpsc::Receiver<()>,
    session: SessionId,
}

impl Rig {
    /// Spawns the adapter over duplex pipes and completes the handshake using the fixture's
    /// first line, which in every capture is the `initialize` `control_response`.
    async fn start(fixture: &str, event_buffer: usize) -> Rig {
        let mut lines = fixture_lines(fixture);
        let (mut to_adapter, adapter_stdout) = tokio::io::duplex(PIPE);
        let (adapter_stdin, from_adapter) = tokio::io::duplex(PIPE);

        let (sent_tx, mut sent_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut reader = BufReader::new(from_adapter).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if sent_tx.send(line).is_err() {
                    break;
                }
            }
        });

        let session = SessionId::new("test-session");
        let (exit_tx, exit_rx) = oneshot::channel();
        let (kill, kill_rx) = KillHandle::channel();
        let config = AdapterConfig {
            instance_id: InstanceId::new("claude-code:test"),
            session_id: session.clone(),
            cwd: PathBuf::from("/w"),
            model: Some("claude-haiku-4-5".into()),
            approval_timeout: None,
            prompt: None,
            event_buffer,
            start_seq: 0,
        };
        let connecting = tokio::spawn(connect(
            config,
            adapter_stdout,
            adapter_stdin,
            exit_rx,
            kill,
            allow_all(),
        ));

        // The adapter writes `initialize` before it reads anything back.
        let mut sent_log = Vec::new();
        let mut outbound = VecDeque::new();
        let initialize = sent_rx.recv().await.expect("adapter wrote initialize");
        record(&initialize, &mut sent_log, &mut outbound);
        assert_eq!(
            sent_log[0]["request"]["subtype"], "initialize",
            "the first frame the adapter writes must be the handshake"
        );
        assert_eq!(
            sent_log[0]["request"]["hooks"]["PreToolUse"][0]["hookCallbackIds"][0],
            brigadier_core::claude::PRE_TOOL_USE_CALLBACK_ID,
            "the PreToolUse hook is registered in initialize"
        );
        let request_id = outbound
            .pop_front()
            .expect("initialize is a control_request");

        let handshake = lines.pop_front().expect("fixture has a handshake line");
        write_line(&mut to_adapter, &patch_response_id(&handshake, &request_id)).await;

        let handle = connecting
            .await
            .expect("connect task joins")
            .expect("handshake succeeds");
        assert_eq!(
            handle.session_id, session,
            "the handle knows its id before the CLI does"
        );
        assert_eq!(handle.instance_id, InstanceId::new("claude-code:test"));

        Rig {
            events: handle.events,
            commands: handle.commands,
            approvals: handle.approvals,
            to_adapter,
            sent_rx,
            sent_log,
            sent_cursor: 1,
            outbound,
            lines,
            collected: Vec::new(),
            exit_tx: Some(exit_tx),
            kill_rx,
            session,
        }
    }

    /// Writes the next `n` fixture lines, rewriting a `control_response`'s `request_id` to the id
    /// of the next unanswered `control_request` the adapter wrote. That rewrite blocks until the
    /// adapter has actually sent one, which is how the `s4` interrupt stays ordered.
    async fn feed(&mut self, n: usize) {
        for _ in 0..n {
            let line = self.lines.pop_front().expect("fixture has another line");
            let line = if is_control_response(&line) {
                let id = self.next_outbound_id().await;
                patch_response_id(&line, &id)
            } else {
                line
            };
            write_line(&mut self.to_adapter, &line).await;
        }
    }

    async fn feed_rest(&mut self) {
        self.feed(self.lines.len()).await;
    }

    /// One line the adapter has to decode, not from the fixture.
    ///
    /// Used only where no capture carries the shape under test: no fixture's final assistant text
    /// is longer than one line, so the difference between the bounded summary and the full text
    /// cannot be shown with captured bytes alone.
    async fn feed_raw(&mut self, line: &str) {
        write_line(&mut self.to_adapter, line).await;
    }

    async fn next_outbound_id(&mut self) -> String {
        loop {
            if let Some(id) = self.outbound.pop_front() {
                return id;
            }
            let line = self.sent_rx.recv().await.expect("adapter stdin still open");
            record(&line, &mut self.sent_log, &mut self.outbound);
        }
    }

    /// The next line the adapter wrote to the child's stdin, in order.
    async fn next_sent(&mut self) -> Value {
        while self.sent_cursor >= self.sent_log.len() {
            let line = tokio::time::timeout(Duration::from_secs(5), self.sent_rx.recv())
                .await
                .expect("timed out waiting for the adapter to write")
                .expect("adapter stdin still open");
            record(&line, &mut self.sent_log, &mut self.outbound);
        }
        let value = self.sent_log[self.sent_cursor].clone();
        self.sent_cursor += 1;
        value
    }

    async fn next_event(&mut self) -> Event {
        match tokio::time::timeout(Duration::from_secs(5), self.events.recv()).await {
            Ok(Some(envelope)) => envelope.event,
            Ok(None) => panic!("event stream ended early"),
            Err(_) => panic!("timed out waiting for an event"),
        }
    }

    /// Reads events until `stop` matches, returning every label including the last, and keeping
    /// the events themselves in `collected` for id correlation.
    async fn labels_until(&mut self, stop: fn(&Event) -> bool) -> Vec<String> {
        let mut out = Vec::new();
        loop {
            let event = self.next_event().await;
            let done = stop(&event);
            out.push(label(&event));
            self.collected.push(event);
            if done {
                return out;
            }
        }
    }

    async fn envelopes_until(&mut self, stop: impl Fn(&Envelope) -> bool) -> Vec<Envelope> {
        let mut received = Vec::new();
        loop {
            let envelope = tokio::time::timeout(Duration::from_secs(5), self.events.recv())
                .await
                .expect("timed out waiting for an envelope")
                .expect("adapter event stream is open");
            let done = stop(&envelope);
            self.collected.push(envelope.event.clone());
            received.push(envelope);
            if done {
                return received;
            }
        }
    }

    async fn send_turn(&self) {
        self.commands
            .send_turn(TurnInput::text("go"))
            .await
            .expect("turn accepted");
    }
}

async fn write_line(stream: &mut DuplexStream, line: &str) {
    stream.write_all(line.as_bytes()).await.expect("write line");
    stream.write_all(b"\n").await.expect("write newline");
    stream.flush().await.expect("flush");
}

fn record(line: &str, log: &mut Vec<Value>, outbound: &mut VecDeque<String>) {
    let value: Value = serde_json::from_str(line).expect("adapter wrote valid JSON");
    if value.get("type").and_then(Value::as_str) == Some("control_request") {
        let id = value
            .get("request_id")
            .and_then(Value::as_str)
            .expect("control_request carries a request_id");
        outbound.push_back(id.to_owned());
    }
    log.push(value);
}

fn is_control_response(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|v| v.get("type").and_then(Value::as_str).map(str::to_owned))
        .as_deref()
        == Some("control_response")
}

fn patch_response_id(line: &str, request_id: &str) -> String {
    let mut value: Value = serde_json::from_str(line).expect("fixture line is JSON");
    value["response"]["request_id"] = Value::String(request_id.to_owned());
    value.to_string()
}

fn kind_label(kind: &ItemKind) -> String {
    match kind {
        ItemKind::AssistantText => "assistant-text".into(),
        ItemKind::Thinking => "thinking".into(),
        ItemKind::ToolCall { name } => format!("tool-call({name})"),
        ItemKind::ToolResult { is_error, .. } => format!("tool-result(is_error={is_error})"),
        ItemKind::UserText => "user-text".into(),
        ItemKind::Subagent { .. } => "subagent".into(),
    }
}

fn label(event: &Event) -> String {
    match event {
        Event::SessionStarted { .. } => "session-started".into(),
        Event::SessionExited { reason, .. } => format!("session-exited({reason:?})"),
        Event::TurnStarted { .. } => "turn-started".into(),
        Event::TurnCompleted { stop_reason, .. } => format!("turn-completed({stop_reason:?})"),
        Event::TurnAborted { reason, .. } => format!("turn-aborted({reason:?})"),
        Event::ItemStarted { kind, .. } => format!("item-started:{}", kind_label(kind)),
        Event::ItemUpdated { kind, .. } => format!("item-updated:{}", kind_label(kind)),
        Event::ItemCompleted { kind, .. } => format!("item-completed:{}", kind_label(kind)),
        Event::ContentDelta { .. } => "content-delta".into(),
        Event::RequestOpened { .. } => "request-opened".into(),
        Event::RequestResolved { decision, .. } => match decision {
            Decision::Allow { .. } => "request-resolved(allow)".into(),
            Decision::Deny { reason, .. } => format!("request-resolved(deny:{reason})"),
        },
        Event::SessionCompacted { .. } => "session-compacted".into(),
        Event::RuntimeWarning { .. } => "runtime-warning".into(),
        Event::RuntimeError { .. } => "runtime-error".into(),
    }
}

fn is_request_opened(event: &Event) -> bool {
    matches!(event, Event::RequestOpened { .. })
}

fn is_turn_end(event: &Event) -> bool {
    matches!(
        event,
        Event::TurnCompleted { .. } | Event::TurnAborted { .. }
    )
}

fn is_turn_started(event: &Event) -> bool {
    matches!(event, Event::TurnStarted { .. })
}

/// Every `TurnStarted` id, in order.
fn started_ids(rig: &Rig) -> Vec<TurnId> {
    rig.collected
        .iter()
        .filter_map(|e| match e {
            Event::TurnStarted { turn_id } => Some(turn_id.clone()),
            _ => None,
        })
        .collect()
}

/// Every `TurnCompleted`, in order, as the three fields the store writes.
fn completed(rig: &Rig) -> Vec<(TurnId, Usage, f64)> {
    rig.collected
        .iter()
        .filter_map(|e| match e {
            Event::TurnCompleted {
                turn_id,
                usage,
                cost_usd_cumulative,
                ..
            } => Some((turn_id.clone(), *usage, *cost_usd_cumulative)),
            _ => None,
        })
        .collect()
}

/// Costs are compared with an epsilon of 1e-12: the fixture's `total_cost_usd` is parsed to the
/// same `f64` it was serialised from, so this is tighter than the value's own last digit.
fn about(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-12, "{actual} != {expected}");
}

fn is_session_exited(event: &Event) -> bool {
    matches!(event, Event::SessionExited { .. })
}

/// The one `ToolPermission` in `collected`.
fn permission(rig: &Rig) -> (&str, Option<&str>) {
    rig.collected
        .iter()
        .find_map(|e| match e {
            Event::RequestOpened {
                kind:
                    RequestKind::ToolPermission {
                        tool_name,
                        tool_call_id,
                        ..
                    },
                ..
            } => Some((tool_name.as_str(), tool_call_id.as_deref())),
            _ => None,
        })
        .expect("a tool permission was opened")
}

fn tool_call_item_id(rig: &Rig) -> ItemId {
    rig.collected
        .iter()
        .find_map(|e| match e {
            Event::ItemStarted {
                item_id,
                kind: ItemKind::ToolCall { .. },
                ..
            } => Some(item_id.clone()),
            _ => None,
        })
        .expect("a tool call item was started")
}

fn tool_result_call_id(rig: &Rig) -> String {
    rig.collected
        .iter()
        .find_map(|e| match e {
            Event::ItemCompleted {
                kind: ItemKind::ToolResult { tool_call_id, .. },
                ..
            } => Some(tool_call_id.clone()),
            _ => None,
        })
        .expect("a tool result item completed")
}

// -----------------------------------------------------------------------------------------
// s1 — handshake and one plain turn
// -----------------------------------------------------------------------------------------

#[tokio::test]
async fn s1_handshake_and_turn() {
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    rig.send_turn().await;
    rig.feed_rest().await;

    assert_eq!(
        rig.labels_until(is_turn_end).await,
        [
            "turn-started",
            "item-started:user-text",
            "item-completed:user-text",
            "session-started",
            "item-started:thinking",
            "item-completed:thinking",
            "item-started:assistant-text",
            "item-completed:assistant-text",
            "turn-completed(EndTurn)",
        ]
    );

    // `system/init` is the only place the resume token appears.
    let started = rig
        .collected
        .iter()
        .find_map(|e| match e {
            Event::SessionStarted {
                provider_session_id,
                resume_token,
                model,
                capabilities,
                ..
            } => Some((
                provider_session_id.clone(),
                resume_token.clone(),
                model.clone(),
                capabilities.clone(),
            )),
            _ => None,
        })
        .expect("session started");
    assert_eq!(started.0, "8380cdea-0e11-4fa3-b5df-9c606b7262aa");
    assert_eq!(
        started.1.as_deref(),
        Some("8380cdea-0e11-4fa3-b5df-9c606b7262aa")
    );
    assert_eq!(started.2, "claude-haiku-4-5");
    assert!(
        started.3.contains(&"interrupt_receipt_v1".to_owned()),
        "{:?}",
        started.3
    );

    // The cumulative cost is passed through, never summed.
    let cost = rig
        .collected
        .iter()
        .find_map(|e| match e {
            Event::TurnCompleted {
                cost_usd_cumulative,
                ..
            } => Some(*cost_usd_cumulative),
            _ => None,
        })
        .expect("turn completed");
    assert!((cost - 0.026_220_999_999_999_998).abs() < 1e-9, "{cost}");

    // The turn the adapter sent is the SDK's own shape.
    let turn = rig.next_sent().await;
    assert_eq!(turn["type"], "user");
    assert_eq!(turn["message"]["content"][0]["text"], "go");
}

// -----------------------------------------------------------------------------------------
// s2 — can_use_tool, allowed
// -----------------------------------------------------------------------------------------

#[tokio::test]
async fn s2_can_use_tool_allow() {
    let mut rig = Rig::start("s2-can-use-tool-allow.ndjson", 64).await;
    rig.send_turn().await;

    // Up to and including the `can_use_tool` frame (fixture lines 1..=9).
    rig.feed(9).await;
    assert_eq!(
        rig.labels_until(is_request_opened).await,
        [
            "turn-started",
            "item-started:user-text",
            "item-completed:user-text",
            "session-started",
            "item-started:thinking",
            "item-completed:thinking",
            "item-started:tool-call(Bash)",
            "item-completed:tool-call(Bash)",
            "request-opened",
        ]
    );

    let request_id = approval_request_id(&rig.session, 1);
    rig.commands
        .respond(request_id, Decision::allow())
        .await
        .expect("allowed");

    // The user turn was written first; the allow is the second thing on the wire.
    let turn = rig.next_sent().await;
    assert_eq!(turn["type"], "user");
    let allow = rig.next_sent().await;
    assert_eq!(allow["type"], "control_response");
    assert_eq!(allow["response"]["subtype"], "success");
    assert_eq!(allow["response"]["response"]["behavior"], "allow");
    // `updatedInput` echoes the model's own arguments, exactly as the spike's working allow did.
    let ask: Value =
        serde_json::from_str(&fixture_lines("s2-can-use-tool-allow.ndjson")[9]).expect("json");
    assert_eq!(allow["response"]["request_id"], ask["request_id"]);
    assert_eq!(
        allow["response"]["response"]["updatedInput"],
        ask["request"]["input"]
    );

    rig.feed_rest().await;
    assert_eq!(
        rig.labels_until(is_turn_end).await,
        [
            "request-resolved(allow)",
            "item-completed:tool-result(is_error=false)",
            "item-started:thinking",
            "item-completed:thinking",
            "item-started:assistant-text",
            "item-completed:assistant-text",
            "turn-completed(EndTurn)",
        ]
    );

    // The three ids the UI correlates on are one id.
    let (tool_name, permission_call_id) = permission(&rig);
    assert_eq!(tool_name, "Bash");
    assert_eq!(permission_call_id, Some("toolu_017EqysfWQUVfeERnAaHzgSW"));
    assert_eq!(
        tool_call_item_id(&rig).as_str(),
        permission_call_id.expect("id")
    );
    assert_eq!(tool_result_call_id(&rig), permission_call_id.expect("id"));
}

// -----------------------------------------------------------------------------------------
// s3 — can_use_tool, denied
// -----------------------------------------------------------------------------------------

#[tokio::test]
async fn s3_can_use_tool_deny() {
    let mut rig = Rig::start("s3-can-use-tool-deny.ndjson", 64).await;
    rig.send_turn().await;
    rig.feed(9).await;
    let before = rig.labels_until(is_request_opened).await;
    assert_eq!(before.last().expect("last"), "request-opened");

    let request_id = approval_request_id(&rig.session, 1);
    rig.commands
        .respond(request_id, Decision::deny("denied by test"))
        .await
        .expect("denied");

    let _turn = rig.next_sent().await;
    let deny = rig.next_sent().await;
    // A deny is a *successful* control response carrying `behavior: "deny"`; "success"
    // describes the transport, not the verdict.
    assert_eq!(deny["response"]["subtype"], "success");
    assert_eq!(deny["response"]["response"]["behavior"], "deny");
    assert_eq!(deny["response"]["response"]["message"], "denied by test");
    assert!(
        deny["response"]["response"].get("interrupt").is_none(),
        "{deny}"
    );

    rig.feed_rest().await;
    assert_eq!(
        rig.labels_until(is_turn_end).await,
        [
            "request-resolved(deny:denied by test)",
            // The CLI still writes a `tool_result`, flagged as an error, for a denied call.
            "item-completed:tool-result(is_error=true)",
            "item-started:thinking",
            "item-completed:thinking",
            "item-started:assistant-text",
            "item-completed:assistant-text",
            "turn-completed(EndTurn)",
        ]
    );
}

// -----------------------------------------------------------------------------------------
// s4 — interrupt, then a second turn on the same session
// -----------------------------------------------------------------------------------------

#[tokio::test]
async fn s4_interrupt_then_a_second_turn() {
    let mut rig = Rig::start("s4-interrupt.ndjson", 64).await;
    rig.send_turn().await;
    rig.feed(7).await; // lines 1..=7, through the first assistant frame

    // Line 8 is the interrupt's `control_response`, so `feed` blocks until the adapter has
    // actually written the interrupt request. `interrupt()` waits for that response, so it has
    // to run concurrently.
    let commands = rig.commands.clone();
    let interrupting = tokio::spawn(async move { commands.interrupt().await });
    rig.feed(1).await;
    interrupting
        .await
        .expect("task joins")
        .expect("interrupt acknowledged");

    rig.feed(3).await; // lines 9..=11: assistant text, the synthetic user note, result #1
    assert_eq!(
        rig.labels_until(is_turn_end).await,
        [
            "turn-started",
            "item-started:user-text",
            "item-completed:user-text",
            "session-started",
            "item-started:thinking",
            "item-completed:thinking",
            "item-started:assistant-text",
            "item-completed:assistant-text",
            // `[Request interrupted by user]` is a user text block, deliberately not an item.
            "turn-aborted(Interrupted)",
        ]
    );

    // The session survived: a second turn completes on the same process.
    rig.send_turn().await;
    rig.feed_rest().await;
    assert_eq!(
        rig.labels_until(is_turn_end).await,
        [
            "turn-started",
            "item-started:user-text",
            "item-completed:user-text",
            // The second `system/init` carries the same session id and emits nothing.
            "item-started:thinking",
            "item-completed:thinking",
            "item-started:assistant-text",
            "item-completed:assistant-text",
            "turn-completed(EndTurn)",
        ]
    );

    let interrupt = rig
        .sent_log
        .iter()
        .find(|v| v["request"]["subtype"] == "interrupt");
    assert!(
        interrupt.is_some(),
        "the adapter sent an interrupt control_request"
    );
}

// -----------------------------------------------------------------------------------------
// s6 — the PreToolUse hook and can_use_tool both fire on the same call
// -----------------------------------------------------------------------------------------

#[tokio::test]
async fn s6_hook_callback_is_answered_with_an_empty_object() {
    let mut rig = Rig::start("s6-hook-callback.ndjson", 64).await;
    rig.send_turn().await;
    rig.feed(9).await; // lines 1..=9, through the `hook_callback`

    let lines = fixture_lines("s6-hook-callback.ndjson");
    let hook: Value = serde_json::from_str(&lines[9]).expect("json");
    assert_eq!(hook["request"]["subtype"], "hook_callback");

    let _turn = rig.next_sent().await;
    let answer = rig.next_sent().await;
    assert_eq!(answer["type"], "control_response");
    assert_eq!(answer["response"]["request_id"], hook["request_id"]);
    assert_eq!(answer["response"]["subtype"], "success");
    assert_eq!(answer["response"]["response"], serde_json::json!({}));

    // The hook produced no canonical event of its own; `can_use_tool` is the operator-facing gate.
    rig.feed(1).await; // line 10, the `can_use_tool`
    assert_eq!(
        rig.labels_until(is_request_opened).await,
        [
            "turn-started",
            "item-started:user-text",
            "item-completed:user-text",
            "session-started",
            "item-started:thinking",
            "item-completed:thinking",
            "item-started:tool-call(Bash)",
            "item-completed:tool-call(Bash)",
            "request-opened",
        ]
    );

    rig.commands
        .respond(approval_request_id(&rig.session, 1), Decision::allow())
        .await
        .expect("allowed");
    rig.feed_rest().await;
    assert_eq!(
        rig.labels_until(is_turn_end).await.last().expect("last"),
        "turn-completed(EndTurn)"
    );
}

// -----------------------------------------------------------------------------------------
// s9 / f-b-fanout — a background subagent runs a turn the harness never sent
// -----------------------------------------------------------------------------------------

/// One user message, two `result` frames. The `Agent` tool backgrounds its subagent, the CLI
/// closes the turn when it *launches*, and the finished subagent makes it run a second turn the
/// harness never sent. Both results are cumulative, so the last one is the truth: dropping it
/// under-counted this fixture by 13.5% in dollars and 37.1% in `cacheReadInputTokens`.
// see docs/research/async-subagent-results.md §0 (measured) and docs/STATUS.md §5.
#[tokio::test]
async fn s9_a_background_subagent_produces_a_second_turn() {
    let mut rig = Rig::start("s9-subagent-agent-id.ndjson", 64).await;
    let sent = rig
        .commands
        .send_turn(TurnInput::text("go"))
        .await
        .expect("turn accepted");

    // Fixture lines 2..=49, ending on `result` #1 — the frame that used to end the turn for good.
    rig.feed(48).await;
    assert_eq!(
        rig.labels_until(is_turn_end).await.last().expect("last"),
        "turn-completed(EndTurn)"
    );

    // Lines 50..=56: the task notification and `system/init` #2. Nothing was written to the
    // child's stdin in between, so the turn that init opens is one nobody asked for.
    rig.feed(7).await;
    assert_eq!(
        rig.labels_until(is_turn_started)
            .await
            .last()
            .expect("last"),
        "turn-started"
    );

    rig.feed_rest().await;
    assert_eq!(
        rig.labels_until(is_turn_end).await.last().expect("last"),
        "turn-completed(EndTurn)"
    );

    let completed = completed(&rig);
    assert_eq!(completed.len(), 2, "one `TurnCompleted` per `result` frame");
    about(completed[0].2, 0.049_362_199_999_999_995);
    about(completed[1].2, 0.057_083_999_999_999_996);
    assert_eq!(completed[0].1.cache_read_tokens, 72_567);
    assert_eq!(completed[1].1.cache_read_tokens, 115_395);

    // The continuation turn is a minted id, not the operator's, and it is the one that completed.
    let started = started_ids(&rig);
    assert_eq!(started, vec![sent.clone(), completed[1].0.clone()]);
    assert_eq!(completed[0].0, sent);
    assert_ne!(completed[1].0, sent);
}

/// Three subagents, one user message, **four** `result` frames. This is the test a
/// `subagent_stats.spawned > completed` implementation fails: result #3 reports `spawned 3,
/// completed 3` and stops at $0.086_817, 4.5% short.
// see docs/research/async-subagent-results.md §A (measured).
#[tokio::test]
async fn f_b_fanout_reports_the_last_of_four_results() {
    let mut rig = Rig::start("f-b-fanout.ndjson", 64).await;
    let sent = rig
        .commands
        .send_turn(TurnInput::text("go"))
        .await
        .expect("turn accepted");
    rig.feed_rest().await;

    for _ in 0..4 {
        assert_eq!(
            rig.labels_until(is_turn_end).await.last().expect("last"),
            "turn-completed(EndTurn)"
        );
    }

    let completed = completed(&rig);
    assert_eq!(completed.len(), 4, "one `TurnCompleted` per `result` frame");
    let costs: Vec<f64> = completed.iter().map(|c| c.2).collect();
    about(costs[0], 0.041_506_75);
    about(costs[1], 0.080_402_900_000_000_01);
    about(costs[2], 0.086_817_05);
    about(costs[3], 0.090_915_950_000_000_01);
    let cache: Vec<u64> = completed.iter().map(|c| c.1.cache_read_tokens).collect();
    assert_eq!(cache, vec![43_590, 157_119, 198_568, 225_897]);

    // Four turns, four starts: the operator's, then three the CLI ran on its own.
    let started = started_ids(&rig);
    assert_eq!(started.len(), 4);
    assert_eq!(started[0], sent);
    let ids: Vec<TurnId> = completed.iter().map(|c| c.0.clone()).collect();
    assert_eq!(
        ids, started,
        "every completion closes the turn that started it"
    );
}

/// A minted turn must never be the reason an operator cannot send. Nothing on the wire promises
/// that every `system/init` is followed by a `result`, and an `init` that none follows would
/// otherwise refuse every `SendTurn` until the child exits — a kill as the only escape.
// see docs/research/unprompted-init.md.
#[tokio::test]
async fn a_minted_turn_is_pre_empted_by_a_send() {
    let mut rig = Rig::start("s9-subagent-agent-id.ndjson", 64).await;
    let first = rig
        .commands
        .send_turn(TurnInput::text("go"))
        .await
        .expect("turn accepted");
    rig.feed(48).await; // through `result` #1
    rig.labels_until(is_turn_end).await;
    rig.feed(7).await; // through `system/init` #2, which mints a continuation turn
    rig.labels_until(is_turn_started).await;
    let minted = started_ids(&rig)
        .last()
        .cloned()
        .expect("a continuation turn was minted");
    assert_ne!(minted, first, "the continuation id is not the operator's");

    // Accepted, not rejected — and the minted turn is closed rather than left unpaired.
    let second = rig
        .commands
        .send_turn(TurnInput::text("again"))
        .await
        .expect("send accepted");
    assert_eq!(
        rig.labels_until(is_turn_started).await,
        ["turn-aborted(Interrupted)", "turn-started"]
    );
    let aborted = rig
        .collected
        .iter()
        .rev()
        .find_map(|e| match e {
            Event::TurnAborted { turn_id, .. } => Some(turn_id.clone()),
            _ => None,
        })
        .expect("the minted turn was aborted");
    assert_eq!(aborted, minted);
    assert_eq!(started_ids(&rig).last().cloned().expect("started"), second);

    // Both user frames reached the child, in order.
    let mut texts: Vec<String> = Vec::new();
    while texts.len() < 2 {
        let sent = rig.next_sent().await;
        if sent["type"] == "user" {
            texts.push(
                sent["message"]["content"][0]["text"]
                    .as_str()
                    .expect("text")
                    .to_owned(),
            );
        }
    }
    assert_eq!(texts, ["go", "again"]);

    // The trade-off, pinned so it is a decision and not a surprise: the continuation's `result`
    // was already in flight, so it closes the operator's turn instead of the minted one.
    // Attribution is approximate across a pre-emption; the cumulative cost is not.
    rig.feed_rest().await;
    assert_eq!(
        rig.labels_until(is_turn_end).await.last().expect("last"),
        "turn-completed(EndTurn)"
    );
    let completed = completed(&rig);
    let last = completed.last().expect("a completion");
    assert_eq!(last.0, second);
    about(last.2, 0.057_083_999_999_999_996);
}

/// The belt and braces. A `result` that arrives with no open turn and no `system/init` before it
/// is still translated: a `TurnStarted`/`TurnCompleted` pair on a minted id, cost intact. The
/// frame is synthetic — every `result` in all 16 captures is preceded by an `init` — which is
/// exactly why this arm needs a test of its own.
// see docs/research/async-subagent-results.md §B.
#[tokio::test]
async fn a_result_with_no_open_turn_is_still_reported() {
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    let bare = serde_json::json!({
        "type": "result",
        "subtype": "success",
        "is_error": false,
        "duration_ms": 1,
        "duration_api_ms": 1,
        "num_turns": 1,
        "result": "ok",
        "session_id": "no-init",
        "stop_reason": "end_turn",
        "terminal_reason": "completed",
        "total_cost_usd": 0.125,
        "usage": {"input_tokens": 1, "output_tokens": 2, "cache_read_input_tokens": 3},
        "modelUsage": {"claude-haiku-4-5": {
            "inputTokens": 11, "outputTokens": 22, "cacheReadInputTokens": 33,
            "cacheCreationInputTokens": 44, "contextWindow": 200000
        }}
    });
    write_line(&mut rig.to_adapter, &bare.to_string()).await;

    assert_eq!(
        rig.labels_until(is_turn_end).await,
        ["turn-started", "turn-completed(EndTurn)"]
    );
    let completed = completed(&rig);
    assert_eq!(completed.len(), 1);
    about(completed[0].2, 0.125);
    assert_eq!(
        completed[0].1.cache_read_tokens, 33,
        "`modelUsage`, not the main-loop `usage`"
    );
    assert_eq!(
        started_ids(&rig),
        vec![completed[0].0.clone()],
        "one minted id, one pair"
    );
}

// -----------------------------------------------------------------------------------------
// backpressure
// -----------------------------------------------------------------------------------------

/// The event channel holds one envelope and nothing ever drains it. Answering an open permission
/// prompt must still work, because a decision goes straight into the approval table and never
/// queues behind the adapter's loop.
///
/// The request id is derived rather than read off a `RequestOpened` — reading one would drain the
/// channel and defeat the test. Waiting for the park to appear is *setup*; the assertion is
/// strict: one `respond` call, no retries, answered within 100 ms.
#[tokio::test]
async fn a_jammed_event_channel_does_not_block_a_response() {
    let mut rig = Rig::start("s2-can-use-tool-allow.ndjson", 1).await;
    rig.send_turn().await;
    rig.feed(9).await;

    // Setup: the `can_use_tool` frame has to have been decoded before there is anything to answer.
    // The handle's own view of the park is how we know, without touching the jammed event channel.
    let request_id = approval_request_id(&rig.session, 1);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !rig
            .approvals
            .pending()
            .iter()
            .any(|p| p.request_id == request_id)
        {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("the permission prompt parked within 5 s");

    let commands = rig.commands.clone();
    let answered = tokio::time::timeout(
        Duration::from_millis(100),
        commands.respond(request_id, Decision::allow()),
    )
    .await
    .expect("respond completed within 100 ms");
    assert_eq!(answered, Ok(()));

    // And the adapter kept running: the allow reached the child's stdin.
    let allow = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let sent = rig.next_sent().await;
            if sent["type"] == "control_response" {
                return sent;
            }
        }
    })
    .await
    .expect("the allow was written within 1 s");
    assert_eq!(allow["response"]["response"]["behavior"], "allow");
}

// -----------------------------------------------------------------------------------------
// teardown
// -----------------------------------------------------------------------------------------

/// A child that dies with a prompt open must not leave the park wedged: every `RequestOpened`
/// gets a `RequestResolved`, the open turn aborts, and the session reports its exit.
#[tokio::test]
async fn child_exit_cancels_every_open_request() {
    let mut rig = Rig::start("s2-can-use-tool-allow.ndjson", 64).await;
    rig.send_turn().await;
    rig.feed(9).await;
    let opened = rig.labels_until(is_request_opened).await;
    assert_eq!(opened.iter().filter(|l| *l == "request-opened").count(), 1);

    rig.exit_tx
        .take()
        .expect("exit sender")
        .send(ExitInfo { code: Some(1) })
        .expect("send exit");

    let after = rig.labels_until(is_session_exited).await;
    assert_eq!(
        after,
        [
            format!("request-resolved(deny:{EXIT_REASON})"),
            "turn-aborted(Error(\"the session ended before the turn completed\"))".to_owned(),
            format!("session-exited({:?})", ExitReason::Crashed),
        ]
    );

    // The stream ends once the adapter drops its sender.
    assert!(
        rig.events.recv().await.is_none(),
        "the event stream closes after the exit"
    );
}

/// `Kill` reaches the process supervisor, and the synthesised terminal events say `Killed` —
/// there is no `result` frame to read them from.
#[tokio::test]
async fn kill_reaches_the_supervisor_and_reports_killed() {
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    rig.send_turn().await;
    rig.feed(2).await; // rate_limit_event, then `system/init`

    rig.commands.kill().await.expect("kill accepted");
    rig.kill_rx
        .recv()
        .await
        .expect("the supervisor was asked to kill the process group");

    // The real supervisor answers a kill by exiting; the rig stands in for it.
    rig.exit_tx
        .take()
        .expect("exit sender")
        .send(ExitInfo { code: None })
        .expect("send exit");

    let labels = rig.labels_until(is_session_exited).await;
    assert_eq!(
        labels,
        [
            "turn-started",
            "item-started:user-text",
            "item-completed:user-text",
            "session-started",
            "turn-aborted(Killed)",
            &format!("session-exited({:?})", ExitReason::Killed),
        ]
    );
}

/// A second `SendTurn` while a turn is open is rejected rather than queued.
#[tokio::test]
async fn a_second_turn_while_one_is_open_is_rejected() {
    let rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    rig.send_turn().await;
    let err = rig
        .commands
        .send_turn(TurnInput::text("again"))
        .await
        .expect_err("a second turn is rejected");
    assert_eq!(
        err,
        brigadier_core::session::CommandError::Rejected("a turn is already open".into())
    );
}

/// Dropping the last `SessionCommands` closes the child's stdin. That is the graceful end of a
/// session: the CLI's own readline `close` fires and it exits 0, no signal needed.
// see docs/research/claude-direct-spike.md scenario 1 (exit 0 in 571 ms, measured).
#[tokio::test]
async fn dropping_the_command_handle_closes_the_childs_stdin() {
    let rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    let Rig {
        commands,
        mut sent_rx,
        ..
    } = rig;
    drop(commands);
    assert!(
        tokio::time::timeout(Duration::from_secs(5), sent_rx.recv())
            .await
            .expect("stdin closed within 5 s")
            .is_none(),
        "the adapter drops the child's stdin when nothing can drive the session"
    );
}

/// `end_session` is the same graceful end, asked for explicitly instead of falling out of a drop:
/// the child sees EOF on its stdin, and the stream ends with `SessionExited { Graceful }`.
// see docs/research/claude-direct-spike.md scenario 1 (exit 0 in 571 ms, measured).
#[tokio::test]
async fn end_session_closes_stdin_and_reports_a_graceful_exit() {
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    rig.commands
        .end_session()
        .await
        .expect("end_session accepted");

    // The fake child's stdin reaches EOF, with the command handle still very much alive.
    assert!(
        tokio::time::timeout(Duration::from_secs(5), rig.sent_rx.recv())
            .await
            .expect("stdin closed within 5 s")
            .is_none(),
        "end_session closes the child's stdin"
    );

    // A real CLI answers that EOF by exiting 0; the rig stands in for the process supervisor.
    rig.exit_tx
        .take()
        .expect("exit sender")
        .send(ExitInfo { code: Some(0) })
        .expect("send exit");

    assert_eq!(
        rig.labels_until(is_session_exited).await,
        [format!("session-exited({:?})", ExitReason::Graceful)]
    );
    assert!(
        matches!(
            rig.collected.last(),
            Some(Event::SessionExited {
                exit_code: Some(0),
                ..
            })
        ),
        "{:?}",
        rig.collected.last()
    );
    assert!(
        rig.events.recv().await.is_none(),
        "the event stream ends with the session"
    );
}

/// A child that leaves without reporting a code at all, after *we* asked for the end, still ended
/// gracefully. A non-zero code after the same request would not — that is a crash on the way out.
#[tokio::test]
async fn a_requested_end_with_no_exit_code_is_still_graceful() {
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    rig.commands
        .end_session()
        .await
        .expect("end_session accepted");
    rig.exit_tx
        .take()
        .expect("exit sender")
        .send(ExitInfo { code: None })
        .expect("send exit");
    assert_eq!(
        rig.labels_until(is_session_exited).await,
        [format!("session-exited({:?})", ExitReason::Graceful)]
    );
}

/// `SetModel` and `SetPermissionMode` go out as control requests in the CLI's own vocabulary and
/// only acknowledge once the CLI answers.
#[tokio::test]
async fn set_model_and_permission_mode_use_the_cli_spelling() {
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;

    let commands = rig.commands.clone();
    let setting = tokio::spawn(async move {
        commands
            .set_permission_mode(brigadier_core::driver::PermissionMode::AcceptEdits)
            .await
    });
    let request = rig.next_sent().await;
    assert_eq!(request["request"]["subtype"], "set_permission_mode");
    assert_eq!(request["request"]["mode"], "acceptEdits");

    let ack = serde_json::json!({
        "type": "control_response",
        "response": {"subtype": "success", "request_id": request["request_id"], "response": {}}
    });
    write_line(&mut rig.to_adapter, &ack.to_string()).await;
    setting.await.expect("task joins").expect("acknowledged");

    let commands = rig.commands.clone();
    let setting = tokio::spawn(async move { commands.set_model("claude-opus-4-8").await });
    let request = rig.next_sent().await;
    assert_eq!(request["request"]["subtype"], "set_model");
    assert_eq!(request["request"]["model"], "claude-opus-4-8");
    let ack = serde_json::json!({
        "type": "control_response",
        "response": {"subtype": "success", "request_id": request["request_id"], "response": {}}
    });
    write_line(&mut rig.to_adapter, &ack.to_string()).await;
    setting.await.expect("task joins").expect("acknowledged");
}

/// An unsupported CLI → host control request is refused, not ignored: an unanswered request
/// parks the CLI forever.
#[tokio::test]
async fn an_unsupported_control_request_is_refused_and_warned_about() {
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    let ask = serde_json::json!({
        "type": "control_request",
        "request_id": "cli_42",
        "request": {"subtype": "elicitation", "mcp_server_name": "x", "message": "hi"}
    });
    write_line(&mut rig.to_adapter, &ask.to_string()).await;

    let refusal = rig.next_sent().await;
    assert_eq!(refusal["response"]["subtype"], "error");
    assert_eq!(refusal["response"]["request_id"], "cli_42");
    assert!(
        refusal["response"]["error"]
            .as_str()
            .expect("error string")
            .contains("unsupported by brigadier"),
        "{refusal}"
    );
    assert_eq!(label(&rig.next_event().await), "runtime-warning");
}

/// `control_cancel_request` settles the park and emits a resolution, but writes nothing back to a
/// request the CLI has already withdrawn.
#[tokio::test]
async fn a_withdrawn_request_resolves_without_an_answer() {
    let mut rig = Rig::start("s2-can-use-tool-allow.ndjson", 64).await;
    rig.send_turn().await;
    rig.feed(9).await;
    rig.labels_until(is_request_opened).await;

    let ask: Value =
        serde_json::from_str(&fixture_lines("s2-can-use-tool-allow.ndjson")[9]).expect("json");
    let cancel = serde_json::json!({
        "type": "control_cancel_request",
        "request_id": ask["request_id"],
    });
    write_line(&mut rig.to_adapter, &cancel.to_string()).await;

    assert_eq!(
        label(&rig.next_event().await),
        "request-resolved(deny:cancelled by provider)"
    );

    // Only the user turn was ever written; no `control_response` answered the withdrawn ask.
    let turn = rig.next_sent().await;
    assert_eq!(turn["type"], "user");
    assert!(
        tokio::time::timeout(Duration::from_millis(200), rig.sent_rx.recv())
            .await
            .is_err(),
        "nothing was written back for a withdrawn request"
    );
}

// -----------------------------------------------------------------------------------------
// live
// -----------------------------------------------------------------------------------------

/// Drives the real `claude` binary. **Ignored, and never run by this work order** — it costs the
/// owner money on a live account. Run it deliberately:
///
/// ```text
/// CLAUDE_BIN=$(which claude) cargo test -p brigadier-core --test claude_adapter \
///     -- --ignored live_pong --nocapture
/// ```
#[tokio::test]
#[ignore = "spawns the real claude binary and spends money on a live account"]
async fn live_pong() {
    let Ok(binary) = std::env::var("CLAUDE_BIN") else {
        eprintln!("CLAUDE_BIN unset; skipping");
        return;
    };
    let mut config = brigadier_core::claude::ClaudeDriverConfig::new("claude-code:live");
    config.binary = Some(PathBuf::from(binary));
    config.default_model =
        Some(std::env::var("CLAUDE_MODEL").unwrap_or_else(|_| "claude-haiku-4-5".to_owned()));
    let driver = brigadier_core::claude::ClaudeDriver::probe(config)
        .await
        .expect("probe");

    let cwd = std::env::temp_dir();
    let mut request = brigadier_core::driver::StartSession::new(cwd);
    request.prompt = Some("Reply with exactly the word pong.".into());

    use brigadier_core::driver::ProviderDriver as _;
    let mut handle = driver.start_session(request).await.expect("session starts");

    let mut saw_started = false;
    let mut saw_completed = false;
    while let Ok(Some(envelope)) =
        tokio::time::timeout(Duration::from_secs(120), handle.events.recv()).await
    {
        match envelope.event {
            Event::SessionStarted { .. } => saw_started = true,
            Event::TurnCompleted { stop_reason, .. } => {
                assert_eq!(stop_reason, StopReason::EndTurn);
                saw_completed = true;
                break;
            }
            other => eprintln!("{}", label(&other)),
        }
    }
    assert!(saw_started, "a SessionStarted must arrive");
    assert!(saw_completed, "a TurnCompleted must arrive");
    handle.commands.kill().await.expect("kill");
}

// -----------------------------------------------------------------------------------------
// the full final assistant text of a turn
// -----------------------------------------------------------------------------------------

/// One `assistant` frame carrying a single text block, in the CLI's own shape.
fn assistant_text_line(uuid: &str, text: &str) -> String {
    serde_json::json!({
        "type": "assistant",
        "parent_tool_use_id": null,
        "uuid": uuid,
        "message": {
            "model": "claude-haiku-4-5-20251001",
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
            "stop_reason": null,
        },
    })
    .to_string()
}

/// A minimal `result`/`success`, which is what closes a turn.
fn result_success_line() -> String {
    serde_json::json!({
        "type": "result",
        "subtype": "success",
        "stop_reason": "end_turn",
        "total_cost_usd": 0.01,
    })
    .to_string()
}

/// The full text of the last completed turn, and the summaries the feed would store.
fn item_summaries(rig: &Rig) -> Vec<String> {
    rig.collected
        .iter()
        .filter_map(|e| match e {
            Event::ItemCompleted {
                kind: ItemKind::AssistantText,
                summary,
                ..
            } => Some(summary.clone()),
            _ => None,
        })
        .collect()
}

/// The captured path: `s3`'s 127-character denial text comes back whole, off real bytes.
#[tokio::test]
async fn a_captured_turns_final_text_comes_back_whole() {
    let mut rig = Rig::start("s3-can-use-tool-deny.ndjson", 64).await;
    rig.send_turn().await;
    rig.feed(9).await;
    rig.labels_until(is_request_opened).await;
    rig.commands
        .respond(approval_request_id(&rig.session, 1), Decision::deny("no"))
        .await
        .expect("denied");
    rig.feed_rest().await;
    rig.labels_until(is_turn_end).await;

    let turn_id = started_ids(&rig).pop().expect("a turn started");
    let text = rig
        .commands
        .final_assistant_text(turn_id)
        .await
        .expect("text is held");

    // The fixture's own assistant text blocks, in order, joined the way the adapter joins them.
    let expected: Vec<String> = fixture_lines("s3-can-use-tool-deny.ndjson")
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|v| v["type"] == "assistant")
        .filter_map(|v| v["message"]["content"].as_array().cloned())
        .flatten()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str().map(str::to_owned))
        .collect();
    assert_eq!(text, expected.join("\n"));
    assert_eq!(
        text.len(),
        127,
        "the capture's own denial text, byte for byte"
    );
}

/// The whole point, both halves at once: a fenced ` ```json ` block with newlines inside it comes
/// back **whole**, while the `ItemCompleted` the store persists is still one bounded line.
#[tokio::test]
async fn a_fenced_json_block_survives_while_the_summary_stays_one_bounded_line() {
    let block = "Here is the plan for phase 2.\n\n\
                 ```json\n\
                 {\n  \"action\": \"dispatch\",\n  \"orders\": [\n    {\"id\": \"o1\"}\n  ]\n}\n\
                 ```\n";

    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    rig.send_turn().await;
    rig.feed_raw(&assistant_text_line("u1", block)).await;
    rig.feed_raw(&result_success_line()).await;
    assert_eq!(
        rig.labels_until(is_turn_end).await,
        [
            "turn-started",
            "item-started:user-text",
            "item-completed:user-text",
            "item-started:assistant-text",
            "item-completed:assistant-text",
            "turn-completed(EndTurn)",
        ]
    );

    let turn_id = started_ids(&rig).pop().expect("a turn started");
    let text = rig
        .commands
        .final_assistant_text(turn_id)
        .await
        .expect("text is held");

    // Half one: the full text, verbatim, newlines and fences intact.
    assert_eq!(text, block);
    assert!(
        text.contains("```json\n{\n  \"action\": \"dispatch\""),
        "{text}"
    );

    // Half two: nothing about what is persisted changed. The feed's summary is still the first
    // non-empty line and still bounded — it is 29 bytes here, and it is *not* the JSON.
    let summaries = item_summaries(&rig);
    assert_eq!(summaries, ["Here is the plan for phase 2."]);
    assert!(
        summaries[0].len() <= 240,
        "the summary is bounded: {}",
        summaries[0].len()
    );
    assert!(
        !summaries[0].contains('{'),
        "the summary must not carry the action"
    );
}

/// Overflow keeps the **tail**: the fenced block a loop reads is at the end of the message.
#[tokio::test]
async fn an_oversized_final_text_keeps_its_tail() {
    let tail = "\n```json\n{\"action\": \"verify\"}\n```";
    let mut body = "x".repeat(FINAL_TEXT_LIMIT + 4096);
    body.push_str(tail);

    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    rig.send_turn().await;
    rig.feed_raw(&assistant_text_line("u1", &body)).await;
    rig.feed_raw(&result_success_line()).await;
    rig.labels_until(is_turn_end).await;

    let turn_id = started_ids(&rig).pop().expect("a turn started");
    let text = rig
        .commands
        .final_assistant_text(turn_id)
        .await
        .expect("text is held");
    assert!(text.len() <= FINAL_TEXT_LIMIT, "bounded: {}", text.len());
    assert!(
        text.ends_with(tail),
        "the tail is what survives, not the head"
    );
    assert!(!text.starts_with("xxxx") || text.len() == FINAL_TEXT_LIMIT);
}

/// "There is no such turn" and "the turn said nothing" are different answers.
#[tokio::test]
async fn an_unheld_turn_is_a_typed_error_and_never_an_empty_string() {
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    rig.send_turn().await;

    // Nothing has completed yet.
    assert_eq!(
        rig.commands
            .final_assistant_text(TurnId::new("whatever"))
            .await,
        Err(FinalTextError::NoCompletedTurn)
    );

    rig.feed_raw(&assistant_text_line("u1", "")).await;
    rig.feed_raw(&result_success_line()).await;
    rig.labels_until(is_turn_end).await;
    let turn_id = started_ids(&rig).pop().expect("a turn started");

    // A turn that genuinely said nothing answers with the empty string, not an error.
    assert_eq!(
        rig.commands.final_assistant_text(turn_id.clone()).await,
        Ok(String::new())
    );
    // And a turn this adapter does not hold is an error, not that same empty string.
    assert_eq!(
        rig.commands
            .final_assistant_text(TurnId::new("some-other-turn"))
            .await,
        Err(FinalTextError::NotHeld { held: turn_id })
    );
}

// -----------------------------------------------------------------------------------------
// approvals never resolve optimistically
// -----------------------------------------------------------------------------------------

/// `docs/vision.md` §9: the dock resolves only when Rust confirms the decision reached the model.
/// With the child's stdin closed the write fails, so the request must stay unresolved and the
/// harness must say so.
#[tokio::test]
async fn a_decision_that_cannot_reach_the_child_warns_and_never_resolves() {
    let mut rig = Rig::start("s2-can-use-tool-allow.ndjson", 64).await;
    rig.send_turn().await;
    rig.feed(9).await;
    rig.labels_until(is_request_opened).await;

    // Close the child's stdin. Every later `write_frame` is a broken pipe.
    rig.commands.end_session().await.expect("stdin closed");
    rig.commands
        .respond(approval_request_id(&rig.session, 1), Decision::allow())
        .await
        .expect("the table accepts the answer");

    let event = rig.next_event().await;
    let Event::RuntimeWarning { message } = &event else {
        panic!("expected a runtime warning, got {}", label(&event));
    };
    assert!(
        message.contains(approval_request_id(&rig.session, 1).as_str()),
        "the warning names the request: {message}"
    );
    assert!(message.contains("did not reach the model"), "{message}");
    assert!(message.contains("expire"), "{message}");

    // Drain to the end of the session and prove no resolution was ever emitted for it.
    rig.exit_tx
        .take()
        .expect("exit channel")
        .send(ExitInfo { code: Some(0) })
        .ok();
    let labels = rig.labels_until(is_session_exited).await;
    assert!(
        !labels.iter().any(|l| l.starts_with("request-resolved")),
        "an undelivered decision must never resolve: {labels:?}"
    );
}

/// The other half of the same rule: a write that *does* land still resolves, unchanged.
///
/// This one passes against the unfixed code too — it is the guard that the fix did not break the
/// path that worked, not a proof of the fix.
#[tokio::test]
async fn a_decision_that_reaches_the_child_still_resolves() {
    let mut rig = Rig::start("s2-can-use-tool-allow.ndjson", 64).await;
    rig.send_turn().await;
    rig.feed(9).await;
    rig.labels_until(is_request_opened).await;

    rig.commands
        .respond(approval_request_id(&rig.session, 1), Decision::allow())
        .await
        .expect("allowed");

    // The allow is on the wire...
    let turn = rig.next_sent().await;
    assert_eq!(turn["type"], "user");
    let allow = rig.next_sent().await;
    assert_eq!(allow["response"]["response"]["behavior"], "allow");
    // ...and only then is the request resolved.
    assert_eq!(
        rig.next_event().await,
        Event::RequestResolved {
            request_id: approval_request_id(&rig.session, 1),
            decision: Decision::allow(),
        }
    );
}

#[tokio::test]
async fn native_context_is_summary_and_rewind_holds_sends_until_persistence() {
    use brigadier_core::session::NativeControl;
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    let commands = rig.commands.clone();
    let pending =
        tokio::spawn(async move { commands.native_control(NativeControl::ContextSummary).await });
    let request = rig.next_sent().await;
    assert_eq!(
        request["request"],
        serde_json::json!({"subtype":"get_context_usage","detail":"summary"})
    );
    write_line(&mut rig.to_adapter, &serde_json::json!({"type":"control_response","response":{"subtype":"success","request_id":request["request_id"],"response":{"totalTokens":3500,"maxTokens":200000}}}).to_string()).await;
    assert_eq!(pending.await.unwrap().unwrap()["totalTokens"], 3500);
    let commands = rig.commands.clone();
    let pending = tokio::spawn(async move {
        commands
            .native_control(NativeControl::RewindConversation {
                target_uuid: "first".into(),
                last_seen_uuid: "latest".into(),
            })
            .await
    });
    let request = rig.next_sent().await;
    assert_eq!(
        request["request"],
        serde_json::json!({"subtype":"rewind_conversation","target_message_uuid":"first","last_seen_user_message_uuid":"latest","interrupt_if_running":false})
    );
    assert!(rig
        .commands
        .send_turn(TurnInput::text("race"))
        .await
        .is_err());
    write_line(&mut rig.to_adapter, &serde_json::json!({"type":"control_response","response":{"subtype":"success","request_id":request["request_id"],"response":{"rewound":true,"targetMessageUuid":"first","prefillText":"draft"}}}).to_string()).await;
    let response = pending.await.unwrap().unwrap();
    assert_eq!(response["rewound"], true);
    assert!(response["brigadier_seq"].is_u64());
    assert!(rig
        .commands
        .send_turn(TurnInput::text("before disk commit"))
        .await
        .is_err());
    rig.commands
        .native_control(NativeControl::FinishRewind)
        .await
        .unwrap();
    let turn = rig
        .commands
        .send_turn(TurnInput::text("edited"))
        .await
        .unwrap();
    let sent = rig.next_sent().await;
    assert_eq!(sent["uuid"], turn.as_str());
    assert_eq!(sent["message"]["content"][0]["text"], "edited");
}

#[tokio::test]
async fn native_refusal_is_not_a_success_and_agent_completion_is_explicit() {
    use brigadier_core::session::NativeControl;
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    let commands = rig.commands.clone();
    let pending = tokio::spawn(async move {
        commands
            .native_control(NativeControl::RewindConversation {
                target_uuid: "old".into(),
                last_seen_uuid: "old".into(),
            })
            .await
    });
    let request = rig.next_sent().await;
    write_line(&mut rig.to_adapter,&serde_json::json!({"type":"control_response","response":{"subtype":"error","request_id":request["request_id"],"error":"Unsupported request"}}).to_string()).await;
    assert!(pending.await.unwrap().is_err());
    rig.commands
        .native_control(NativeControl::FinishRewind)
        .await
        .unwrap();
    write_line(&mut rig.to_adapter,&serde_json::json!({"type":"system","subtype":"task_started","task_id":"child","tool_use_id":"tool","description":"Review files"}).to_string()).await;
    // Barrier through the provider pipe ensures the preceding task event was consumed.
    let commands = rig.commands.clone();
    let barrier =
        tokio::spawn(async move { commands.native_control(NativeControl::ContextSummary).await });
    let request = rig.next_sent().await;
    write_line(&mut rig.to_adapter,&serde_json::json!({"type":"control_response","response":{"subtype":"success","request_id":request["request_id"],"response":{}}}).to_string()).await;
    barrier.await.unwrap().unwrap();
    let activity = rig
        .commands
        .native_control(NativeControl::Activity)
        .await
        .unwrap();
    assert_eq!(activity["agents"][0]["status"], "Working");
    assert_eq!(activity["agents"][0]["model"], Value::Null);
}

#[tokio::test]
async fn native_rewind_refuses_an_active_turn_without_an_uncertain_outcome() {
    use brigadier_core::session::NativeControl;
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    rig.commands
        .send_turn(TurnInput::text("working"))
        .await
        .unwrap();
    rig.next_sent().await;
    let response = rig
        .commands
        .native_control(NativeControl::RewindConversation {
            target_uuid: "old".into(),
            last_seen_uuid: "latest".into(),
        })
        .await
        .unwrap();
    assert_eq!(response["rewound"], false);
    assert!(response["error"].as_str().unwrap().contains("current turn"));
}

#[tokio::test]
async fn checkpoint_barrier_allows_only_the_durable_reserved_message() {
    use brigadier_core::session::NativeControl;
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    let state = rig
        .commands
        .native_control(NativeControl::CheckpointBarrier)
        .await
        .unwrap();
    let seq = state["seq"].as_u64().unwrap();
    assert!(rig
        .commands
        .send_turn(TurnInput::text("racing"))
        .await
        .is_err());
    rig.commands
        .native_control(NativeControl::CheckpointVerify { seq })
        .await
        .unwrap();
    let turn = TurnId::new("saved-message");
    rig.commands
        .native_control(NativeControl::CheckpointRelease {
            seq,
            turn_id: Some(turn.clone()),
        })
        .await
        .unwrap();
    assert!(rig
        .commands
        .send_turn(TurnInput::text("unreserved"))
        .await
        .is_err());
    rig.commands
        .send_reserved_turn(turn, TurnInput::text("reserved"))
        .await
        .unwrap();
    let sent = rig.next_sent().await;
    assert_eq!(sent["uuid"], "saved-message");
    assert!(rig
        .commands
        .native_control(NativeControl::CheckpointBarrier)
        .await
        .is_err());
}

#[tokio::test]
async fn invisible_background_frames_invalidate_a_checkpoint_boundary() {
    use brigadier_core::session::NativeControl;
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    let seq = rig
        .commands
        .native_control(NativeControl::CheckpointBarrier)
        .await
        .unwrap()["seq"]
        .as_u64()
        .unwrap();
    write_line(
        &mut rig.to_adapter,
        &serde_json::json!({"type":"system","subtype":"task_started","task_id":"child"})
            .to_string(),
    )
    .await;
    write_line(&mut rig.to_adapter,&serde_json::json!({"type":"system","subtype":"task_notification","task_id":"child","status":"completed"}).to_string()).await;
    let commands = rig.commands.clone();
    let pending =
        tokio::spawn(async move { commands.native_control(NativeControl::ContextSummary).await });
    let request = rig.next_sent().await;
    write_line(&mut rig.to_adapter,&serde_json::json!({"type":"control_response","response":{"subtype":"success","request_id":request["request_id"],"response":{}}}).to_string()).await;
    pending.await.unwrap().unwrap();
    assert!(rig
        .commands
        .native_control(NativeControl::CheckpointVerify { seq })
        .await
        .is_err());
    assert!(rig
        .commands
        .native_control(NativeControl::CheckpointRelease { seq, turn_id: None })
        .await
        .is_err());
    assert!(rig
        .commands
        .native_control(NativeControl::CheckpointBarrier)
        .await
        .is_ok());
}

use brigadier_core::session::TurnAttachment;
const ATTACHMENT_PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

fn prepared_image(id: &str) -> TurnAttachment {
    TurnAttachment {
        id: id.into(),
        name: "diagram.png".into(),
        media_type: "image/png".into(),
        text: None,
        base64: ATTACHMENT_PNG_BASE64.into(),
    }
}


#[tokio::test]
async fn prepared_attachments_reach_stdin_and_keep_send_uuid_and_history_ids() {
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    let file_text = "# Notes\nПривіт — preserve UTF-8 and \"quotes\".\n/effort high\n";
    let turn = rig
        .commands
        .send_turn(TurnInput {
            text: "Read both attachments.".into(),
            display_text: Some("Authored request".into()),
            attachments: vec![
                prepared_image("image-1"),
                TurnAttachment {
                    id: "text-1".into(),
                    name: "notes.md".into(),
                    media_type: "text/plain".into(),
                    text: Some(file_text.into()),
                    base64: String::new(),
                },
            ],
            ..Default::default()
        })
        .await
        .expect("prepared attachment send acknowledged");
    let sent = rig.next_sent().await;
    assert_eq!(sent["type"], "user");
    assert_eq!(sent["uuid"], turn.as_str());
    assert_eq!(sent["parent_tool_use_id"], Value::Null);
    assert_eq!(sent["message"]["role"], "user");
    let blocks = sent["message"]["content"].as_array().unwrap();
    assert_eq!(blocks[0]["text"], "Read both attachments.");
    assert_eq!(
        blocks
            .iter()
            .find(|block| block["type"] == "image")
            .unwrap()["source"],
        serde_json::json!({"type":"base64","media_type":"image/png","data":ATTACHMENT_PNG_BASE64})
    );
    assert!(blocks.iter().any(|block| block["text"]
        .as_str()
        .is_some_and(|text| text.contains("notes.md")
            && text.contains("text-1")
            && text.ends_with(file_text))));
    assert!(!sent.to_string().contains("attachment_paths"));

    let user_id = format!("{turn}:user");
    let sent_events = rig.envelopes_until(|env| matches!(&env.event,
        Event::ItemCompleted { item_id, kind: ItemKind::UserText, .. } if item_id.as_str() == user_id)).await;
    assert_eq!(
        sent_events
            .iter()
            .filter(|env| matches!(&env.event, Event::TurnStarted {turn_id} if turn_id == &turn))
            .count(),
        1
    );
    let user = sent_events.last().unwrap();
    assert_eq!(user.body.as_deref(), Some("Authored request"));
    assert!(
        !user.raw().unwrap_or("").contains(ATTACHMENT_PNG_BASE64),
        "image bytes are not diagnostic excerpts"
    );

    rig.feed_raw(&serde_json::json!({"type":"result","subtype":"success","stop_reason":"end_turn","user_message_uuid":turn.as_str()}).to_string()).await;
    let terminal = rig.envelopes_until(|env| is_turn_end(&env.event)).await;
    assert!(
        matches!(&terminal.last().unwrap().event, Event::TurnCompleted {turn_id,..} if turn_id == &turn)
    );
    assert!(
        !terminal
            .iter()
            .any(|env| matches!(env.event, Event::TurnStarted { .. })),
        "provider UUID closes the acknowledged send, not a phantom turn"
    );
}

#[tokio::test]
async fn image_only_turn_sends_real_image_content_without_requiring_prompt_text() {
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    let turn = rig
        .commands
        .send_turn(TurnInput {
            attachments: vec![prepared_image("image-only")],
            ..Default::default()
        })
        .await
        .expect("image-only turn accepted");
    let sent = rig.next_sent().await;
    assert_eq!(sent["uuid"], turn.as_str());
    assert_eq!(sent["message"]["content"][0]["type"], "image");
    assert_eq!(
        sent["message"]["content"][0]["source"]["data"],
        ATTACHMENT_PNG_BASE64
    );
    assert!(!sent["message"]["content"]
        .as_array()
        .unwrap()
        .iter()
        .any(|block| block["type"] == "text" && block["text"] == ""));
}

#[tokio::test]
async fn invalid_attachments_are_rejected_before_any_turn_or_stdin_message() {
    let mut rig = Rig::start("s1-handshake-and-turn.ndjson", 64).await;
    let mut empty_image = prepared_image("empty");
    empty_image.base64.clear();
    let mut unsupported = prepared_image("unsupported");
    unsupported.media_type = "image/svg+xml".into();
    for input in [
        TurnInput {
            text: "path rejected".into(),
            attachment_paths: vec![PathBuf::from("/not-imported/image.png")],
            ..Default::default()
        },
        TurnInput {
            text: "empty rejected".into(),
            attachments: vec![empty_image],
            ..Default::default()
        },
        TurnInput {
            text: "unsupported rejected".into(),
            attachments: vec![unsupported],
            ..Default::default()
        },
        TurnInput::default(),
    ] {
        assert!(rig.commands.send_turn(input).await.is_err());
    }
    // A valid send and its terminal frame are ordering barriers: any accidental earlier
    // TurnStarted or stdin user frame would be observed before these, without sleep races.
    let turn = rig
        .commands
        .send_turn(TurnInput::text("valid after rejection"))
        .await
        .unwrap();
    let sent = rig.next_sent().await;
    assert_eq!(sent["uuid"], turn.as_str());
    assert_eq!(
        sent["message"]["content"][0]["text"],
        "valid after rejection"
    );
    rig.feed_raw(&result_success_line()).await;
    let envelopes = rig.envelopes_until(|env| is_turn_end(&env.event)).await;
    let starts: Vec<_> = envelopes
        .iter()
        .filter_map(|env| match &env.event {
            Event::TurnStarted { turn_id } => Some(turn_id),
            _ => None,
        })
        .collect();
    assert_eq!(starts, vec![&turn]);
    assert_eq!(
        envelopes
            .iter()
            .filter(|env| matches!(
                env.event,
                Event::ItemCompleted {
                    kind: ItemKind::UserText,
                    ..
                }
            ))
            .count(),
        1
    );
}
