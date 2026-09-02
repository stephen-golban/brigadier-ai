//! The supervisor end to end, driven by [`ReplayDriver`] against a temporary store.
//!
//! No `claude` process is spawned anywhere here. One test loads a captured fixture, which drives
//! the real Claude adapter over duplex pipes but spawns nothing.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use brigadier_core::approval::PendingApproval;
use brigadier_core::driver::{
    BoxFuture, DriverError, DriverInfo, DriverKind, ProviderDriver, ResumeSession, StartSession,
};
use brigadier_core::event::{
    Envelope, Event, InstanceId, ItemId, ItemKind, RequestId, RequestKind, SessionId, StopReason,
    TurnId, Usage,
};
use brigadier_core::session::SessionHandle;
use brigadier_store::Store;
use brigadier_supervisor::batcher::{MAX_MESSAGE_BYTES, MAX_ROWS_PER_MESSAGE};
use brigadier_supervisor::replay::REPLAY;
use brigadier_supervisor::{
    FeedBatch, ReplayDriver, Supervisor, SupervisorConfig, SupervisorError, VecSink,
};
use tempfile::TempDir;

/// A store, a supervisor over it, and the sink everything lands in.
struct Harness {
    dir: TempDir,
    store: Store,
    sink: Arc<VecSink>,
    sup: Supervisor,
}

impl Harness {
    fn with_run_id(run_id: &str) -> Harness {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = Store::open(dir.path()).expect("store opens");
        let sink = Arc::new(VecSink::new());
        let mut config = SupervisorConfig::new(
            store.handle().clone(),
            run_id,
            dir.path().to_owned(),
            sink.clone(),
        );
        config.frame_interval = Duration::from_millis(16);
        let sup = Supervisor::new(config);
        Harness { dir, store, sink, sup }
    }

    fn new() -> Harness {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = Store::open(dir.path()).expect("store opens");
        let run_id = store.run_id().to_owned();
        let sink = Arc::new(VecSink::new());
        let mut config = SupervisorConfig::new(
            store.handle().clone(),
            run_id,
            dir.path().to_owned(),
            sink.clone(),
        );
        config.frame_interval = Duration::from_millis(16);
        let sup = Supervisor::new(config);
        Harness { dir, store, sink, sup }
    }

    async fn project(&self) -> String {
        let root = self.dir.path().join("project");
        std::fs::create_dir_all(&root).expect("project dir");
        self.sup.add_project(root).await.expect("project added").id
    }
}

/// Rows whose terse line is at or near the 200-byte cap: the worst case for the byte budget.
fn fat_script(n: usize) -> Vec<Event> {
    (0..n)
        .map(|i| {
            Event::item_completed(
                ItemId::new(format!("item-{i}")),
                ItemKind::ToolCall { name: "Bash".into() },
                &"x".repeat(300),
                None,
            )
        })
        .collect()
}

/// One signal and a handful of rows.
fn mixed_script() -> Vec<Event> {
    let mut script = vec![Event::TurnCompleted {
        turn_id: TurnId::new("t1"),
        stop_reason: StopReason::EndTurn,
        usage: Usage::default(),
        cost_usd_cumulative: 0.001,
    }];
    script.extend(fat_script(8));
    script
}

fn replay(script: Vec<Event>, rate: f64) -> Arc<ReplayDriver> {
    Arc::new(ReplayDriver::new(script).with_rate(rate))
}

fn kind() -> DriverKind {
    DriverKind::new(REPLAY)
}

fn assert_within_budget(batches: &[FeedBatch]) -> usize {
    let mut worst = 0;
    for batch in batches {
        let size = serde_json::to_vec(batch).map(|v| v.len()).unwrap_or(usize::MAX);
        assert!(size < MAX_MESSAGE_BYTES, "a message of {size} bytes crosses the eval cliff");
        assert!(
            batch.rows.len() <= MAX_ROWS_PER_MESSAGE,
            "{} rows in one message",
            batch.rows.len()
        );
        worst = worst.max(size);
    }
    worst
}

async fn wait_until(mut done: impl FnMut() -> bool, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    done()
}

#[tokio::test(flavor = "multi_thread")]
async fn one_session_streams_rows_and_signals_in_bounded_batches() {
    let h = Harness::new();
    let project = h.project().await;
    h.sup.register_driver(replay(mixed_script(), 200.0));

    let session = h
        .sup
        .start_session(&project, &kind(), StartSession::new(h.dir.path()))
        .await
        .expect("session starts");

    assert!(
        wait_until(|| h.sink.len() >= 5, Duration::from_secs(5)).await,
        "batches must arrive within 5 s"
    );
    let batches = h.sink.take();
    let worst = assert_within_budget(&batches);
    assert!(worst > 0);

    let rows: usize = batches.iter().map(|b| b.rows.len()).sum();
    let signals: usize = batches.iter().map(|b| b.signals.len()).sum();
    assert!(rows > 0, "terse rows must arrive");
    assert!(signals > 0, "signal envelopes must arrive");
    assert!(
        batches.iter().all(|b| b.project_id == project),
        "every batch is stamped with its project"
    );
    assert!(
        batches.iter().flat_map(|b| b.counters.iter()).all(|c| c.session_id == session.as_str()),
        "counters name the session"
    );
    assert!(
        batches.iter().flat_map(|b| b.signals.iter()).all(|s| s.raw().is_none()),
        "no signal carries a raw excerpt"
    );

    h.sup.shutdown_with(Duration::from_secs(2)).await;
    h.store.close().await.expect("store closes");
}

/// The shape of the load test: ten sessions, 200 events a second each, for two seconds.
const LOAD_SESSIONS: usize = 10;
const LOAD_RATE: f64 = 200.0;
const LOAD_SECONDS: f64 = 2.0;

#[tokio::test(flavor = "multi_thread")]
async fn ten_sessions_at_two_hundred_rows_a_second_stay_under_the_cliff() {
    let h = Harness::new();
    let project = h.project().await;
    let driver = replay(fat_script(64), LOAD_RATE);
    h.sup.register_driver(driver.clone());

    let mut sessions = Vec::new();
    for _ in 0..LOAD_SESSIONS {
        sessions.push(
            h.sup
                .start_session(&project, &kind(), StartSession::new(h.dir.path()))
                .await
                .expect("session starts"),
        );
    }

    tokio::time::sleep(Duration::from_secs_f64(LOAD_SECONDS)).await;

    // Stop production before measuring, or the counters race the sink.
    for session in &sessions {
        let _ = h.sup.kill(session).await;
    }
    assert!(
        wait_until(|| h.sup.live_sessions().is_empty(), Duration::from_secs(5)).await,
        "every session must end"
    );
    // Let the flusher idle for ~18 frames, so no batch is in flight between the drain and the
    // sink when the counters are read.
    tokio::time::sleep(Duration::from_millis(300)).await;

    let batches = h.sink.take();
    let worst = assert_within_budget(&batches);
    let delivered: usize = batches.iter().map(|b| b.rows.len()).sum();

    // The producer's own count, not the clock's. `delivered > 1500` proved only that *some* load
    // arrived; the driver knows exactly how many envelopes it put on its streams, so the test can
    // say the metronome kept up and that every single one of them survived the whole path.
    let emitted = driver.emitted();
    let floor = (0.9 * LOAD_SESSIONS as f64 * LOAD_RATE * LOAD_SECONDS) as u64;
    assert!(
        emitted >= floor,
        "the replay must sustain its rate: {emitted} envelopes, floor {floor}"
    );

    // The counters are the proof the consumer never fell behind: nothing was ever dropped, and
    // every row a session produced reached the sink.
    let mut total = 0u64;
    let mut dropped = 0u64;
    for session in &sessions {
        let (t, d) = h
            .sup
            .batcher()
            .counters(&project, session.as_str())
            .expect("every session has counters");
        total += t;
        dropped += d;
    }
    assert_eq!(dropped, 0, "no row may be dropped while the project is visible");
    assert_eq!(h.sup.batcher().buffered_rows(&project), 0, "the flush drains the buffer");
    assert_eq!(total, emitted, "the batcher counted every envelope the driver emitted");
    assert_eq!(delivered as u64, emitted, "every envelope the driver emitted reached the sink");
    eprintln!(
        "{LOAD_SESSIONS} sessions x {LOAD_RATE} rows/s x {LOAD_SECONDS} s: {emitted} emitted, \
         {delivered} delivered in {} messages, worst {worst} bytes",
        batches.len()
    );

    h.store.close().await.expect("store closes");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_invisible_project_yields_no_rows_but_still_gets_signals() {
    let h = Harness::new();
    let project = h.project().await;
    h.sup.set_visible_projects(vec!["somewhere-else".to_owned()]);
    h.sup.register_driver(replay(mixed_script(), 200.0));

    let _session = h
        .sup
        .start_session(&project, &kind(), StartSession::new(h.dir.path()))
        .await
        .expect("session starts");

    assert!(
        wait_until(|| h.sink.len() >= 5, Duration::from_secs(5)).await,
        "batches must still arrive for an invisible project"
    );
    let batches = h.sink.take();
    assert_within_budget(&batches);
    assert!(batches.iter().all(|b| b.rows.is_empty()), "an invisible project sends no rows");
    assert!(
        batches.iter().map(|b| b.signals.len()).sum::<usize>() > 0,
        "signals ignore visibility"
    );
    let worst_dropped = batches
        .iter()
        .flat_map(|b| b.counters.iter())
        .map(|c| c.rows_dropped)
        .max()
        .unwrap_or(0);
    assert!(worst_dropped > 0, "dropped rows must be counted");

    h.sup.shutdown_with(Duration::from_secs(2)).await;
    h.store.close().await.expect("store closes");
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_ends_the_session_and_clears_the_live_map() {
    let h = Harness::new();
    let project = h.project().await;
    h.sup.register_driver(replay(fat_script(16), 100.0));

    let session = h
        .sup
        .start_session(&project, &kind(), StartSession::new(h.dir.path()))
        .await
        .expect("session starts");
    assert_eq!(h.sup.live_sessions(), vec![session.clone()]);
    assert_eq!(h.sup.pid(&session), None, "a replay session is backed by no process");

    h.sup.kill(&session).await.expect("kill accepted");
    assert!(
        wait_until(|| !h.sup.is_live(&session), Duration::from_secs(5)).await,
        "the live map must lose the session"
    );

    assert!(
        wait_until(
            || h.sink.batches().iter().any(|b| b
                .signals
                .iter()
                .any(|s| matches!(s.event, Event::SessionExited { .. }))),
            Duration::from_secs(5)
        )
        .await,
        "a SessionExited signal must reach the sink"
    );

    // A command to a session that is gone is `no_such_session`, not a hang.
    let err = h.sup.send_turn(&session, "hello").await.expect_err("dead session refuses commands");
    assert!(matches!(err, SupervisorError::NoSuchSession), "got {err:?}");

    let record = h.sup.session(&session).await.expect("read").expect("session row exists");
    assert_eq!(record.project_id.as_deref(), Some(project.as_str()));
    assert_eq!(record.status, brigadier_store::SessionStatus::Failed, "a kill is not graceful");

    h.store.close().await.expect("store closes");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_graceful_shutdown_settles_every_session_as_exited() {
    // The regression this pins: `shutdown_sync` alone aborts every consumer task, so no
    // `SessionExited` is ever stored and the next launch settles all of these rows as `failed`.
    // `shutdown_with` has to end them cooperatively and wait for their consumers to route it.
    let h = Harness::new();
    let project = h.project().await;
    h.sup.register_driver(replay(fat_script(32), 100.0));

    let mut sessions = Vec::new();
    for _ in 0..2 {
        sessions.push(
            h.sup
                .start_session(&project, &kind(), StartSession::new(h.dir.path()))
                .await
                .expect("session starts"),
        );
    }
    assert_eq!(h.sup.live_sessions().len(), 2);
    assert!(wait_until(|| h.sink.len() >= 2, Duration::from_secs(5)).await, "rows flow first");

    h.sup.shutdown_with(Duration::from_secs(1)).await;

    assert!(h.sup.live_sessions().is_empty(), "the live map must be empty when shutdown returns");
    for session in &sessions {
        let record = h.sup.session(session).await.expect("read").expect("session row exists");
        assert_eq!(
            record.status,
            brigadier_store::SessionStatus::Exited,
            "a cooperative shutdown is a graceful exit, not a failure: {session}"
        );
        assert!(record.ended_at.is_some(), "{session} must carry an end time");
    }

    h.store.close().await.expect("store closes");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_completed_turn_reaches_the_raw_log_before_the_session_ends() {
    // The regression this pins: the raw log is a 64 KB `BufWriter`, and macOS ⌘Q reaches
    // `RunEvent::Exit` with no `ExitRequested` before it, aborting every consumer task mid-buffer
    // (`docs/research/tauri-commands.md` §12). Measured on the real app: a session's `.ndjson`
    // was **0 bytes** after a quit. So a settled turn has to be on disk while the session is
    // still running, not only at the end of `consume`.
    let h = Harness::new();
    let project = h.project().await;
    // `mixed_script` opens with a `TurnCompleted`, and the replay cycles forever, so the session
    // is still live when the assertion runs.
    h.sup.register_driver(replay(mixed_script(), 50.0));

    let session = h
        .sup
        .start_session(&project, &kind(), StartSession::new(h.dir.path()))
        .await
        .expect("session starts");
    let raw = h.dir.path().join("raw").join(format!("{}.ndjson", session.as_str()));

    // The batcher is pushed *after* the raw log inside `route`, so a `TurnCompleted` visible in
    // the sink proves the log write and its forced flush already happened.
    assert!(
        wait_until(
            || h.sink.batches().iter().any(|b| b
                .signals
                .iter()
                .any(|s| matches!(s.event, Event::TurnCompleted { .. }))),
            Duration::from_secs(5),
        )
        .await,
        "a TurnCompleted signal must reach the sink"
    );
    assert!(h.sup.is_live(&session), "the session must still be running for this to mean anything");

    let bytes = std::fs::metadata(&raw).map(|m| m.len()).unwrap_or(0);
    assert!(bytes > 0, "{} is still empty after a completed turn", raw.display());
    let text = std::fs::read_to_string(&raw).expect("raw log reads");
    assert!(
        text.lines().any(|l| l.contains(r#""type":"turn-completed""#)),
        "the flushed bytes are the turn itself: {text:?}"
    );

    h.sup.shutdown_with(Duration::from_secs(2)).await;
    h.store.close().await.expect("store closes");
}

#[test]
fn a_shutdown_driven_from_outside_the_runtime_still_settles_sessions() {
    // The exact shape of the Tauri exit hook: `RunEvent::ExitRequested` is called on the main
    // thread, which is *not* a tokio worker, and reaches `shutdown_with` through
    // `Handle::block_on` (`tauri::async_runtime::block_on`). Everything inside — `JoinSet::spawn`,
    // `tokio::time::sleep` — has to work from that context, and no `#[tokio::test]` proves it.
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let h = runtime.block_on(async { Harness::new() });
    let project = runtime.block_on(h.project());
    h.sup.register_driver(replay(fat_script(32), 100.0));
    let session = runtime
        .block_on(h.sup.start_session(&project, &kind(), StartSession::new(h.dir.path())))
        .expect("session starts");

    // This call is on the test thread, with no ambient runtime — the main thread's position.
    runtime.handle().block_on(h.sup.shutdown_with(Duration::from_secs(1)));

    assert!(h.sup.live_sessions().is_empty(), "the live map must be empty when shutdown returns");
    let record = runtime
        .block_on(h.sup.session(&session))
        .expect("read")
        .expect("session row exists");
    assert_eq!(record.status, brigadier_store::SessionStatus::Exited);
    assert!(record.ended_at.is_some());

    runtime.block_on(h.store.close()).expect("store closes");
}

#[tokio::test(flavor = "multi_thread")]
async fn feed_tail_returns_what_was_applied() {
    let h = Harness::new();
    let project = h.project().await;
    h.sup.register_driver(replay(fat_script(4), 200.0));

    let session = h
        .sup
        .start_session(&project, &kind(), StartSession::new(h.dir.path()))
        .await
        .expect("session starts");
    assert!(wait_until(|| h.sink.len() >= 3, Duration::from_secs(5)).await, "rows must flow");
    h.sup.kill(&session).await.expect("kill accepted");
    assert!(wait_until(|| !h.sup.is_live(&session), Duration::from_secs(5)).await);

    let tail = h.sup.feed_tail(&session, 10).await.expect("feed tail reads");
    assert!(!tail.is_empty(), "the store kept what `feed::apply` wrote");
    assert!(tail.windows(2).all(|w| w[0].q < w[1].q), "oldest first");
    assert!(
        tail.iter().all(|r| r.s == session.as_str()),
        "every row belongs to the session asked for"
    );
    assert!(
        tail.iter().any(|r| r.l.starts_with("tool Bash done")),
        "the terse line is the store's, not ours: {:?}",
        tail.first().map(|r| &r.l)
    );

    h.store.close().await.expect("store closes");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_approval_from_another_launch_is_expired() {
    // The supervisor's `run_id` deliberately differs from the store's, which is exactly the state
    // a restart leaves behind: rows stamped by a launch that is gone.
    let h = Harness::with_run_id("a-launch-that-is-over");
    let session = SessionId::new("ghost");
    h.store
        .handle()
        .approval_opened(
            session.clone(),
            PendingApproval {
                request_id: RequestId::new("req-1"),
                kind: RequestKind::tool_permission("Bash", r#"{"command":"ls"}"#, Vec::new(), None),
                opened_at: SystemTime::now(),
            },
        )
        .await
        .expect("approval recorded");
    h.store.handle().flush().await.expect("flush");

    let pending = h.sup.pending_approvals().await.expect("read approvals");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].request_id, RequestId::new("req-1"));
    assert!(pending[0].expired, "a foreign run_id means nothing is listening");
    assert!(!pending[0].resolved);
    assert!(matches!(pending[0].kind, Some(RequestKind::ToolPermission { .. })));

    // Same store, a supervisor whose run_id matches: still expired, because the session is not
    // in this launch's live map.
    let sink = Arc::new(VecSink::new());
    let matching = Supervisor::new(SupervisorConfig::new(
        h.store.handle().clone(),
        h.store.run_id(),
        h.dir.path().to_owned(),
        sink,
    ));
    let pending = matching.pending_approvals().await.expect("read approvals");
    assert!(pending[0].expired, "a dead session's prompt is expired even in the same launch");

    h.store.close().await.expect("store closes");
}

#[tokio::test(flavor = "multi_thread")]
async fn add_project_rejects_a_missing_directory() {
    let h = Harness::new();
    let missing = h.dir.path().join("not-here");
    let err = h.sup.add_project(missing.clone()).await.expect_err("a missing path is refused");
    assert!(matches!(err, SupervisorError::InvalidArgument(_)), "got {err:?}");
    assert_eq!(err.code(), "invalid_argument");

    let file = h.dir.path().join("a-file");
    std::fs::write(&file, b"x").expect("write");
    assert!(h.sup.add_project(file).await.is_err(), "a file is not a project root");

    // Adding the same directory twice is one project, not two.
    let first = h.project().await;
    let second = h.project().await;
    assert_eq!(first, second);
    assert_eq!(h.sup.list_projects().await.expect("list").len(), 1);

    // And an unknown project cannot start a session.
    h.sup.register_driver(replay(fat_script(2), 50.0));
    let err = h
        .sup
        .start_session("nope", &kind(), StartSession::new(h.dir.path()))
        .await
        .expect_err("unknown project");
    assert!(matches!(err, SupervisorError::NoSuchProject), "got {err:?}");

    // As cannot an unregistered driver kind.
    let err = h
        .sup
        .start_session(&first, &DriverKind::new("nobody"), StartSession::new(h.dir.path()))
        .await
        .expect_err("unknown driver");
    assert!(matches!(err, SupervisorError::NoDriver(_)), "got {err:?}");

    h.store.close().await.expect("store closes");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fixture_script_is_the_real_adapter_translation() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claude-spike/fixtures/s1-handshake-and-turn.ndjson");
    let driver = ReplayDriver::from_fixture(&fixture).await.expect("fixture loads");
    let script = driver.script().to_vec();
    assert!(
        script.iter().any(|e| matches!(e, Event::SessionStarted { .. })),
        "the capture's handshake becomes a SessionStarted: {script:?}"
    );
    assert!(
        script.iter().any(|e| matches!(e, Event::TurnCompleted { .. })),
        "the capture's result becomes a TurnCompleted"
    );
    assert!(
        !script.iter().any(|e| matches!(e, Event::SessionExited { .. })),
        "the terminal event is the replay's to emit, not the script's"
    );

    let h = Harness::new();
    let project = h.project().await;
    h.sup.register_driver(Arc::new(driver.with_rate(200.0)));
    let session = h
        .sup
        .start_session(&project, &kind(), StartSession::new(h.dir.path()))
        .await
        .expect("session starts");

    assert!(wait_until(|| h.sink.len() >= 3, Duration::from_secs(5)).await, "batches arrive");
    assert_within_budget(&h.sink.batches());

    // `feed::apply` settles the session row off the replayed `SessionStarted`; the supervisor
    // deliberately does not write those columns a second time.
    let record = h.sup.session(&session).await.expect("read").expect("row exists");
    assert_eq!(record.status, brigadier_store::SessionStatus::Running);
    assert!(record.provider_session_id.is_some(), "the capture's session id survives");
    assert_eq!(record.project_id.as_deref(), Some(project.as_str()));
    assert_eq!(record.driver_kind, Some(kind()));

    h.sup.shutdown_with(Duration::from_secs(2)).await;
    h.store.close().await.expect("store closes");
}

/// A driver whose session emits two events and then drops its event sender without ever sending a
/// terminal one — an adapter task that died, which the [`ReplayDriver`] cannot reproduce because
/// every one of its endings emits a `SessionExited`.
#[derive(Debug)]
struct SilentDriver {
    instance_id: InstanceId,
    kind: DriverKind,
}

impl SilentDriver {
    fn new(kind: DriverKind) -> Self {
        Self { instance_id: InstanceId::new("silent:1"), kind }
    }

    fn open(&self, event_buffer: usize) -> SessionHandle {
        let session_id = SessionId::new("silent-session");
        let instance_id = self.instance_id.clone();
        let (handle, backend) =
            SessionHandle::channel(session_id.clone(), instance_id.clone(), event_buffer);
        tokio::spawn(async move {
            for seq in 0..2u64 {
                let event = Event::item_completed(
                    ItemId::new(format!("item-{seq}")),
                    ItemKind::ToolCall { name: "Bash".into() },
                    "ls",
                    None,
                );
                let env = Envelope::new(seq, instance_id.clone(), session_id.clone(), event);
                if backend.events.send(env).await.is_err() {
                    return;
                }
            }
            // Everything the adapter owns goes out of scope here, event sender included, with no
            // `SessionExited` behind it. This is the case the supervisor has to survive.
            drop(backend);
        });
        handle
    }
}

impl ProviderDriver for SilentDriver {
    fn kind(&self) -> DriverKind {
        self.kind.clone()
    }

    fn instance_id(&self) -> &InstanceId {
        &self.instance_id
    }

    fn describe(&self) -> DriverInfo {
        DriverInfo {
            display_name: "Silent".to_owned(),
            binary_path: None,
            version: None,
            account_label: None,
        }
    }

    fn start_session(&self, req: StartSession) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
        let handle = self.open(req.event_buffer);
        Box::pin(async move { Ok(handle) })
    }

    fn resume_session(
        &self,
        req: ResumeSession,
    ) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
        let handle = self.open(req.event_buffer);
        Box::pin(async move { Ok(handle) })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_closed_event_stream_ends_the_session() {
    let h = Harness::new();
    let project = h.project().await;
    let silent = DriverKind::new("silent");
    h.sup.register_driver(Arc::new(SilentDriver::new(silent.clone())));

    let session = h
        .sup
        .start_session(&project, &silent, StartSession::new(h.dir.path()))
        .await
        .expect("session starts");

    assert!(
        wait_until(|| !h.sup.is_live(&session), Duration::from_secs(5)).await,
        "the live map must lose a session whose stream closed"
    );
    assert!(
        wait_until(
            || h.sink.batches().iter().any(|b| b
                .signals
                .iter()
                .any(|s| matches!(s.event, Event::SessionExited { .. }))),
            Duration::from_secs(5)
        )
        .await,
        "the synthesized session-exited signal must reach the sink"
    );

    // And the store agrees: no terminal event ever arrived, so the row is settled as a failure
    // with no exit code rather than left `running` for the next launch to clean up.
    let record = h.sup.session(&session).await.expect("read").expect("session row exists");
    assert_eq!(record.status, brigadier_store::SessionStatus::Failed);
    assert!(record.ended_at.is_some(), "the row must carry an end time");
    assert_eq!(record.exit_code, None, "no exit was observed");

    let tail = h.sup.feed_tail(&session, 10).await.expect("feed tail reads");
    assert!(
        tail.iter().any(|r| r.l.contains(brigadier_supervisor::STREAM_CLOSED)),
        "the feed says why the session ended: {tail:?}"
    );
    // Two real events plus the synthesized exit; the exit's seq follows the last one seen.
    assert_eq!(tail.len(), 3, "{tail:?}");
    assert_eq!(tail.last().map(|r| r.q), Some(2));

    h.store.close().await.expect("store closes");
}
