//! A [`ProviderDriver`] with no child process: it replays a script of canonical events.
//!
//! This is what the 10-agent burn runs on. Ten real sessions cost ten API bills, are not
//! reproducible, and their event rate is not a dial; the thing under test is the
//! Channel → rAF → React → DOM path, not the process side, which `substrate.md` already measured
//! at 0.34% of a core for ten concurrent streams.
// see docs/research/feed-rendering.md §4 "The 10-agent burn harness".
//!
//! [`ReplayDriver::from_fixture`] builds its script by driving the **real** Claude adapter
//! (`brigadier_core::claude::adapter::connect`) over a pair of `tokio::io::duplex` pipes with a
//! captured NDJSON fixture on one end — the same technique as the `Rig` harness in
//! `crates/core/tests/claude_adapter.rs` — so the events in the script are the real translation
//! and not a second, drifting implementation of it.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use brigadier_core::claude::adapter::{connect, AdapterConfig};
use brigadier_core::claude::hook::allow_all;
use brigadier_core::claude::process::{ExitInfo, KillHandle};
use brigadier_core::driver::{
    BoxFuture, DriverError, DriverInfo, DriverKind, ProviderDriver, Resumed, ResumeSession,
    StartSession,
};
use brigadier_core::event::{
    Envelope, Event, ExitReason, InstanceId, RequestId, RequestKind, SessionId,
};
use brigadier_core::session::{Command, Decision, SessionBackend, SessionHandle, TurnInput};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::{mpsc, oneshot};

use crate::error::SupervisorError;

/// The slug a replay driver answers to.
pub const REPLAY: &str = "replay";

/// Events emitted per session per second, unless [`ReplayDriver::with_rate`] says otherwise.
pub const DEFAULT_ROWS_PER_SEC: f64 = 50.0;

/// Slowest rate a replay will run at. Below this the tick period overflows `Duration`:
/// `Duration::from_secs_f64(1.0 / 1e-320)` is a panic, not a slow metronome.
pub const MIN_ROWS_PER_SEC: f64 = 0.01;

/// Fastest rate a replay will run at. Well past anything a real adapter produces, and past what
/// a 16 ms frame can carry; higher values only starve the runtime.
pub const MAX_ROWS_PER_SEC: f64 = 10_000.0;

/// Duplex pipe capacity while loading a fixture. The largest capture is 43 KB.
const PIPE: usize = 256 * 1024;

/// How long the fixture loader waits on any single step before giving up.
const LOAD_TIMEOUT: Duration = Duration::from_secs(10);

/// Silence on the event stream that means the adapter has finished with the fixture.
const QUIET_PERIOD: Duration = Duration::from_millis(500);

/// One `can_use_tool`-shaped permission request a replayed session raises, once.
///
/// The point is the *path*, not the payload: the request is parked in the session's real
/// [`brigadier_core::approval::ApprovalTable`] and announced with a real
/// [`Event::RequestOpened`], which is everything the Claude adapter's `open_permission` does
/// downstream of the CLI frame it decodes (`crates/core/src/claude/adapter.rs` `open_permission`).
/// So it reaches the store, the batcher and the sink by exactly the route a real prompt takes,
/// and [`Supervisor::respond`](crate::Supervisor::respond) answers it for real.
///
/// Build `kind` from a capture rather than by hand — the script
/// [`ReplayDriver::from_fixture`] makes of `s2-can-use-tool-allow.ndjson` contains the real
/// adapter's translation of a real frame, and that is the one to hand over here.
#[derive(Clone, Debug)]
pub struct ApprovalPlan {
    /// Delay from session start before the request is raised.
    pub after: Duration,
    /// What is being asked.
    pub kind: RequestKind,
    /// Park deadline, mirroring `AdapterConfig::approval_timeout`. `None` parks forever.
    pub timeout: Option<Duration>,
}

/// One session's copy of the plan, with the slot the raised request is published in.
struct Prompt {
    plan: ApprovalPlan,
    raised: Arc<OnceLock<RaisedApproval>>,
}

/// The request an [`ApprovalPlan`] actually raised, and the instant it was raised.
///
/// `at` is taken immediately before the park is opened, so it is the producer-side `t0` a
/// latency measurement needs; inferring it from the wall clock or from `opened_at` (a
/// `SystemTime`, coarser and not monotonic) would fold the measurement's own error into the
/// number. Instrumentation only.
#[derive(Clone, Debug)]
pub struct RaisedApproval {
    /// Our id for the parked request.
    pub request_id: RequestId,
    /// When the driver raised it.
    pub at: Instant,
}

/// A driver that emits a fixed script of events on a timer, with no process behind it.
#[derive(Clone, Debug)]
pub struct ReplayDriver {
    instance_id: InstanceId,
    kind: DriverKind,
    script: Arc<Vec<Event>>,
    rows_per_sec: f64,
    max_cycles: Option<usize>,
    /// Shared by every clone and every session this driver opens, so a load test can say what the
    /// producer actually produced instead of inferring it from the clock.
    emitted: Arc<AtomicU64>,
    /// The one permission request this driver's sessions raise, if any.
    approval: Option<ApprovalPlan>,
    /// Filled by whichever session raises the plan first; a plan is raised once per driver.
    raised: Arc<OnceLock<RaisedApproval>>,
}

impl ReplayDriver {
    /// A driver that cycles `script` forever at [`DEFAULT_ROWS_PER_SEC`].
    pub fn new(script: Vec<Event>) -> Self {
        Self {
            instance_id: InstanceId::new(format!("replay:{}", uuid::Uuid::new_v4())),
            kind: DriverKind::new(REPLAY),
            script: Arc::new(script),
            rows_per_sec: DEFAULT_ROWS_PER_SEC,
            max_cycles: None,
            emitted: Arc::new(AtomicU64::new(0)),
            approval: None,
            raised: Arc::new(OnceLock::new()),
        }
    }

    /// Load a captured NDJSON fixture and keep the events the real adapter makes of it.
    ///
    /// `Event::SessionExited` is filtered out of the script: the replay emits its own terminal
    /// event when it is killed, ended, or runs out of cycles, and a script that ends the session
    /// mid-cycle could not loop.
    ///
    /// Needs a Tokio runtime, because it runs the adapter.
    pub async fn from_fixture(path: impl AsRef<Path>) -> Result<Self, SupervisorError> {
        let path = path.as_ref().to_owned();
        let text = std::fs::read_to_string(&path)?;
        let lines: VecDeque<String> =
            text.lines().filter(|l| !l.trim().is_empty()).map(str::to_owned).collect();
        if lines.is_empty() {
            return Err(SupervisorError::InvalidArgument(format!(
                "fixture {} is empty",
                path.display()
            )));
        }
        let script = replay_fixture(lines).await?;
        if script.is_empty() {
            return Err(SupervisorError::InvalidArgument(format!(
                "fixture {} produced no events",
                path.display()
            )));
        }
        Ok(Self::new(script))
    }

    /// Emit `rows_per_sec` events per second per session, clamped to
    /// [`MIN_ROWS_PER_SEC`]`..=`[`MAX_ROWS_PER_SEC`].
    ///
    /// The clamp is not tidiness: the per-tick period is `1.0 / rows_per_sec`, and
    /// `Duration::from_secs_f64` panics on the infinity a denormal rate produces. A non-finite
    /// rate is ignored entirely and the driver keeps the rate it had.
    pub fn with_rate(mut self, rows_per_sec: f64) -> Self {
        if rows_per_sec.is_finite() {
            self.rows_per_sec = rows_per_sec.clamp(MIN_ROWS_PER_SEC, MAX_ROWS_PER_SEC);
        }
        self
    }

    /// Stop after `cycles` passes through the script, emitting a graceful exit. `None` is forever.
    pub fn with_max_cycles(mut self, cycles: Option<usize>) -> Self {
        self.max_cycles = cycles;
        self
    }

    /// Name this instance, so several replay drivers are distinguishable in the store.
    pub fn with_instance_id(mut self, instance_id: impl Into<InstanceId>) -> Self {
        self.instance_id = instance_id.into();
        self
    }

    /// Answer to a different [`DriverKind`], for tests that register more than one.
    pub fn with_kind(mut self, kind: DriverKind) -> Self {
        self.kind = kind;
        self
    }

    /// Raise one permission request, once, on the first session that reaches the deadline.
    ///
    /// A driver with a plan should back exactly one session; register it under its own
    /// [`DriverKind`] if the run also needs plain replayed sessions.
    pub fn with_approval(mut self, plan: ApprovalPlan) -> Self {
        self.approval = Some(plan);
        self
    }

    /// The request [`ReplayDriver::with_approval`] raised, once it has been raised.
    pub fn raised_approval(&self) -> Option<RaisedApproval> {
        self.raised.get().cloned()
    }

    /// The script being replayed.
    pub fn script(&self) -> &[Event] {
        &self.script
    }

    /// The rate this driver's sessions run at, after clamping.
    pub fn rows_per_sec(&self) -> f64 {
        self.rows_per_sec
    }

    /// How many envelopes this driver's sessions have put on their event streams, terminal
    /// `SessionExited` included, since it was built.
    ///
    /// Shared across clones and sessions. This is the producer-side ground truth a load test
    /// needs: without it "enough rows arrived" can only be guessed from the wall clock.
    pub fn emitted(&self) -> u64 {
        self.emitted.load(Ordering::Relaxed)
    }

    /// Open one replayed session.
    ///
    /// `resumed` mirrors the real driver: `None` mints a fresh id and numbers from zero, `Some`
    /// continues the caller's row from `start_seq`, so a supervisor resume driven by a replay
    /// behaves like one driven by a child process.
    // see docs/research/resume.md §7.
    fn open(&self, event_buffer: usize, resumed: Option<Resumed>) -> SessionHandle {
        let (session_id, start_seq) = match resumed {
            Some(Resumed { session_id, start_seq }) => (session_id, start_seq),
            None => (SessionId::new(uuid::Uuid::new_v4().to_string()), 0),
        };
        let (handle, backend) =
            SessionHandle::channel(session_id.clone(), self.instance_id.clone(), event_buffer);
        tokio::spawn(run(
            backend,
            Stream { session_id, instance_id: self.instance_id.clone(), start_seq },
            Arc::clone(&self.script),
            self.rows_per_sec,
            self.max_cycles,
            Arc::clone(&self.emitted),
            self.approval.clone().map(|plan| Prompt { plan, raised: Arc::clone(&self.raised) }),
        ));
        handle
    }
}

impl ProviderDriver for ReplayDriver {
    fn kind(&self) -> DriverKind {
        self.kind.clone()
    }

    fn instance_id(&self) -> &InstanceId {
        &self.instance_id
    }

    fn describe(&self) -> DriverInfo {
        DriverInfo {
            display_name: "Replay".to_owned(),
            binary_path: None,
            version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            account_label: None,
        }
    }

    fn start_session(&self, req: StartSession) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
        let handle = self.open(req.event_buffer, req.resumed);
        Box::pin(async move { Ok(handle) })
    }

    fn resume_session(
        &self,
        req: ResumeSession,
    ) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
        let handle = self.open(req.event_buffer, req.resumed);
        Box::pin(async move { Ok(handle) })
    }
}

/// What one replayed session stamps on every envelope it emits.
struct Stream {
    session_id: SessionId,
    instance_id: InstanceId,
    /// Envelope `seq` to continue from; `0` on a cold start, the row's `last_event_seq` on a
    /// resume. see docs/research/resume.md §7.
    start_seq: u64,
}

/// The per-session task: a metronome on one side, the command channel on the other.
async fn run(
    backend: SessionBackend,
    stream: Stream,
    script: Arc<Vec<Event>>,
    rows_per_sec: f64,
    max_cycles: Option<usize>,
    emitted: Arc<AtomicU64>,
    prompt: Option<Prompt>,
) {
    let Stream { session_id, instance_id, start_seq } = stream;
    let SessionBackend { mut commands, events, approvals } = backend;
    // Clamped again here, not only in `with_rate`: this is the call that panics on a bad rate.
    let period = Duration::from_secs_f64(1.0 / rows_per_sec.clamp(MIN_ROWS_PER_SEC, MAX_ROWS_PER_SEC));
    let mut ticker = tokio::time::interval(period);
    // A load generator must catch up rather than silently lower the requested rate.
    // See docs/research/native-react-profiling-2026-09-10.md.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
    // The last `seq` emitted, not the next: every emission pre-increments.
    let mut seq = start_seq;
    let mut index = 0usize;
    let mut cycles = 0usize;
    // The plan is taken by the branch that raises it, which disables the branch for good: one
    // request per driver, not one per tick.
    let mut prompt = prompt;
    let raise_at = prompt.as_ref().map(|p| tokio::time::Instant::now() + p.plan.after);
    // The answer comes back on a channel rather than on the park's own `oneshot`, because a
    // `select!` branch may not hand its handler a mutable borrow the branch future still holds.
    // One slot: there is at most one request in flight.
    let (decided_tx, mut decided) = mpsc::channel::<(RequestId, Decision)>(1);

    let ending = loop {
        tokio::select! {
            cmd = commands.recv() => {
                match cmd {
                    // A replay has no turn machinery, so an interrupt has nothing to cut short
                    // and ends the session, like `EndSession`.
                    Some(Command::Native { ack, .. }) => {
                        let _ = ack.send(Err(brigadier_core::session::CommandError::Rejected("Native controls are unavailable for replay sessions".into())));
                    }
                    Some(Command::Kill { ack }) => {
                        let _ = ack.send(Ok(()));
                        break Some((ExitReason::Killed, None));
                    }
                    Some(Command::EndSession { ack }) | Some(Command::Interrupt { ack }) => {
                        let _ = ack.send(Ok(()));
                        break Some((ExitReason::Graceful, Some(0)));
                    }
                    Some(Command::SendTurn { ack, .. })
                    | Some(Command::SetModel { ack, .. })
                    | Some(Command::SetPermissionMode { ack, .. }) => {
                        let _ = ack.send(Ok(()));
                    }
                    // Every supervisor handle is gone; nobody is listening.
                    None => break None,
                }
            }
            // Raise the one planned permission request. This is `open_permission`'s work minus
            // the CLI correlation it has no frame for: park in the real table, then announce it.
            _ = sleep_until(raise_at), if prompt.is_some() => {
                let Prompt { plan: ApprovalPlan { kind, timeout, .. }, raised } =
                    prompt.take().expect("the branch condition proved it is Some");
                let at = Instant::now();
                let request_id = RequestId::new(format!("{}:approval:1", session_id.as_str()));
                let waiter = approvals.open(request_id.clone(), kind.clone(), timeout);
                let answered = decided_tx.clone();
                let parked_id = request_id.clone();
                // One forwarder per park, as the adapter does.
                tokio::spawn(async move {
                    if let Ok(decision) = waiter.await {
                        let _ = answered.send((parked_id, decision)).await;
                    }
                });
                let _ = raised.set(RaisedApproval { request_id: request_id.clone(), at });
                seq += 1;
                let envelope = Envelope::new(
                    seq,
                    instance_id.clone(),
                    session_id.clone(),
                    Event::RequestOpened { request_id, kind, turn_id: None },
                );
                if events.send(envelope).await.is_err() {
                    break None;
                }
                emitted.fetch_add(1, Ordering::Relaxed);
            }
            // The answer, whether it came from `Supervisor::respond`, the park's deadline, or
            // teardown. The adapter emits `RequestResolved` here too.
            Some((request_id, decision)) = decided.recv() => {
                seq += 1;
                let envelope = Envelope::new(
                    seq,
                    instance_id.clone(),
                    session_id.clone(),
                    Event::RequestResolved { request_id, decision },
                );
                if events.send(envelope).await.is_err() {
                    break None;
                }
                emitted.fetch_add(1, Ordering::Relaxed);
            }
            _ = ticker.tick() => {
                if script.is_empty() {
                    break Some((ExitReason::Graceful, Some(0)));
                }
                let event = script[index].clone();
                index += 1;
                if index >= script.len() {
                    index = 0;
                    cycles += 1;
                }
                // Pre-increment, like the real adapter's `emit`: `seq` is the last number
                // used, so the first envelope after a resume is `start_seq + 1`.
                seq += 1;
                let envelope = Envelope::new(seq, instance_id.clone(), session_id.clone(), event);
                // A bounded send: when the consumer falls behind, this is where it shows up,
                // exactly as a real adapter's would.
                if events.send(envelope).await.is_err() {
                    break None;
                }
                emitted.fetch_add(1, Ordering::Relaxed);
                if max_cycles.is_some_and(|max| cycles >= max) {
                    break Some((ExitReason::Graceful, Some(0)));
                }
            }
        }
    };

    approvals.cancel_all("session exited");
    if let Some((reason, exit_code)) = ending {
        seq += 1;
        let exit = Envelope::new(
            seq,
            instance_id,
            session_id,
            Event::SessionExited { reason, exit_code },
        );
        if events.send(exit).await.is_ok() {
            emitted.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Drive the real adapter over duplex pipes with `lines` on the child's stdout, and keep the
/// events it produces.
async fn replay_fixture(mut lines: VecDeque<String>) -> Result<Vec<Event>, SupervisorError> {
    let (mut to_adapter, adapter_stdout) = tokio::io::duplex(PIPE);
    let (adapter_stdin, from_adapter) = tokio::io::duplex(PIPE);

    let (sent_tx, mut sent_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut reader = BufReader::new(from_adapter).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if sent_tx.send(line).is_err() {
                return;
            }
        }
    });

    let session_id = SessionId::new("replay-fixture");
    let (exit_tx, exit_rx) = oneshot::channel();
    let (kill, _kill_rx) = KillHandle::channel();
    let config = AdapterConfig {
        instance_id: InstanceId::new("replay:fixture"),
        session_id,
        cwd: PathBuf::from("/"),
        model: Some("replay".to_owned()),
        approval_timeout: None,
        prompt: None,
        event_buffer: 4096,
        start_seq: 0,
    };
    let connecting =
        tokio::spawn(connect(config, adapter_stdout, adapter_stdin, exit_rx, kill, allow_all()));

    // The adapter writes `initialize` before it reads anything; the first fixture line is that
    // handshake's reply, and its `request_id` echoes an id minted at run time.
    let mut outbound: VecDeque<String> = VecDeque::new();
    let first = next_line(&mut sent_rx).await?;
    record(&first, &mut outbound);
    let request_id = outbound
        .pop_front()
        .ok_or_else(|| invalid("the adapter's first frame was not a control_request"))?;
    let handshake = lines
        .pop_front()
        .ok_or_else(|| invalid("fixture has no handshake line"))?;
    write_line(&mut to_adapter, &patch_response_id(&handshake, &request_id)).await?;

    let mut handle = match connecting.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => return Err(SupervisorError::Driver(e)),
        Err(e) => return Err(invalid(format!("adapter task failed: {e}"))),
    };

    // Every capture was taken after a turn was sent, so send one before replaying it.
    let _ = handle.commands.send_turn(TurnInput::text("replay")).await;

    // A capture that parked a permission prompt only continues because the host answered it.
    let approvals = handle.approvals.clone();
    let auto_allow = tokio::spawn(async move {
        loop {
            for pending in approvals.pending() {
                let _ = approvals.resolve(&pending.request_id, Decision::allow());
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    });

    while let Some(line) = lines.pop_front() {
        let line = if is_control_response(&line) {
            let id = next_outbound_id(&mut sent_rx, &mut outbound).await?;
            patch_response_id(&line, &id)
        } else {
            line
        };
        write_line(&mut to_adapter, &line).await?;
    }

    // The child's exit is only signalled once the adapter has gone quiet, because an exit racing
    // the last frames aborts the turn and truncates the script.
    let mut script = Vec::new();
    let mut exit_tx = Some(exit_tx);
    loop {
        match tokio::time::timeout(QUIET_PERIOD, handle.events.recv()).await {
            Ok(Some(envelope)) => {
                if !matches!(envelope.event, Event::SessionExited { .. }) {
                    script.push(envelope.event);
                }
            }
            Ok(None) => break,
            Err(_) => match exit_tx.take() {
                Some(tx) => {
                    let _ = tx.send(ExitInfo { code: Some(0) });
                }
                None => break,
            },
        }
    }
    auto_allow.abort();
    Ok(script)
}

/// Wait until `deadline`, or forever when there is none.
///
/// `select!` needs a future in every branch even when the branch is disabled; a bare `if` guard
/// still has to be handed something to poll.
async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

fn invalid(message: impl Into<String>) -> SupervisorError {
    SupervisorError::InvalidArgument(message.into())
}

async fn next_line(rx: &mut mpsc::UnboundedReceiver<String>) -> Result<String, SupervisorError> {
    match tokio::time::timeout(LOAD_TIMEOUT, rx.recv()).await {
        Ok(Some(line)) => Ok(line),
        Ok(None) => Err(invalid("the adapter closed its stdin")),
        Err(_) => Err(invalid("timed out waiting for the adapter to write")),
    }
}

async fn next_outbound_id(
    rx: &mut mpsc::UnboundedReceiver<String>,
    outbound: &mut VecDeque<String>,
) -> Result<String, SupervisorError> {
    loop {
        if let Some(id) = outbound.pop_front() {
            return Ok(id);
        }
        let line = next_line(rx).await?;
        record(&line, outbound);
    }
}

async fn write_line(stream: &mut DuplexStream, line: &str) -> Result<(), SupervisorError> {
    stream.write_all(line.as_bytes()).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    Ok(())
}

fn record(line: &str, outbound: &mut VecDeque<String>) {
    let Ok(value) = serde_json::from_str::<Value>(line) else { return };
    if value.get("type").and_then(Value::as_str) == Some("control_request") {
        if let Some(id) = value.get("request_id").and_then(Value::as_str) {
            outbound.push_back(id.to_owned());
        }
    }
}

fn is_control_response(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|v| v.get("type").and_then(Value::as_str).map(str::to_owned))
        .as_deref()
        == Some("control_response")
}

fn patch_response_id(line: &str, request_id: &str) -> String {
    match serde_json::from_str::<Value>(line) {
        Ok(mut value) => {
            value["response"]["request_id"] = Value::String(request_id.to_owned());
            value.to_string()
        }
        Err(_) => line.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rate_of(rows_per_sec: f64) -> f64 {
        ReplayDriver::new(Vec::new()).with_rate(rows_per_sec).rows_per_sec()
    }

    #[test]
    fn an_out_of_range_rate_is_clamped_instead_of_overflowing_a_duration() {
        // `1.0 / 1e-320` is `inf`, and `Duration::from_secs_f64(inf)` panics.
        assert_eq!(rate_of(1e-320), MIN_ROWS_PER_SEC);
        assert_eq!(rate_of(0.0), MIN_ROWS_PER_SEC);
        assert_eq!(rate_of(-5.0), MIN_ROWS_PER_SEC);
        assert_eq!(rate_of(1e12), MAX_ROWS_PER_SEC);
        assert_eq!(rate_of(200.0), 200.0);
        // A rate that is not a number says nothing, so it changes nothing.
        assert_eq!(rate_of(f64::NAN), DEFAULT_ROWS_PER_SEC);
        assert_eq!(rate_of(f64::INFINITY), DEFAULT_ROWS_PER_SEC);

        // The period every clamped rate produces is a real `Duration`.
        for rate in [MIN_ROWS_PER_SEC, MAX_ROWS_PER_SEC, DEFAULT_ROWS_PER_SEC] {
            assert!(Duration::from_secs_f64(1.0 / rate) > Duration::ZERO);
        }
    }

    #[test]
    fn a_fresh_driver_has_emitted_nothing() {
        assert_eq!(ReplayDriver::new(Vec::new()).emitted(), 0);
    }
}
