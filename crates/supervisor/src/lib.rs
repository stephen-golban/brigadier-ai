//! Managed state for N supervised sessions, and the flow control between the adapters and the
//! webview.
//!
//! This crate has **no Tauri dependency**. It owns the live session map, one consumer task per
//! session, the per-frame batcher that keeps every IPC message under Tauri's 8 KB `eval` cliff,
//! and the seams for the two things it deliberately does not do: delivering a batch
//! ([`FeedSink`]) and killing orphaned children ([`ProcessTracker`]).
//!
//! ```text
//! adapter ──Envelope──▶ consumer task ──▶ feed::apply  (sqlite)
//!                                    ├──▶ RawLog       (ndjson)
//!                                    └──▶ Batcher ──16 ms──▶ FeedSink ──▶ tauri::ipc::Channel
//! ```
//!
//! The consumer task never blocks on the sink: the batcher's `push` takes a short lock and
//! returns. Backpressure exists only upstream of it, in the adapter's bounded event channel.
// see docs/plans/ipc-contract.md for every wire shape, docs/research/tauri-runtime.md §3 for why
// rAF batching in Rust is the only flow control there is, and docs/research/feed-rendering.md §4
// for the batch arithmetic.

#![deny(unsafe_code)]
#![warn(missing_docs)]

pub mod batcher;
pub mod error;
pub mod replay;
pub mod sink;
pub mod tracker;
pub mod wire;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use brigadier_core::approval::ApprovalTable;
use brigadier_core::driver::{DriverKind, ProviderDriver, StartSession};
use brigadier_core::event::{Envelope, Event, ExitReason, InstanceId, RequestId, SessionId, TurnId};
use brigadier_core::session::{Decision, SessionCommands, SessionHandle, TurnInput};
use brigadier_store::ndjson::RawLog;
use brigadier_store::{ProjectRow, SessionRecord, SessionRow, SessionStatus, StoreHandle};
use tokio::task::JoinHandle;

pub use crate::batcher::{Batcher, DEFAULT_FRAME_INTERVAL, MAX_MESSAGE_BYTES, MAX_ROWS_PER_MESSAGE};
pub use crate::error::SupervisorError;
pub use crate::replay::ReplayDriver;
pub use crate::sink::{FeedSink, SinkError, VecSink};
pub use crate::tracker::{NoopTracker, ProcessTracker};
pub use crate::wire::{ApprovalView, FeedBatch, FeedRowWire, SessionCounter};

/// The [`ExitReason::Error`] text on the exit the supervisor synthesizes when an adapter drops its
/// event stream without ever sending a terminal event.
pub const STREAM_CLOSED: &str = "event stream closed";

/// How long [`Supervisor::shutdown`] waits for graceful exits before it starts killing.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// How long [`Supervisor::shutdown_with`] waits for the live map to drain after it has killed
/// whatever the graceful phase could not end.
pub const KILL_GRACE: Duration = Duration::from_millis(200);

/// How often the shutdown path re-checks whether the live map has drained.
const DRAIN_POLL: Duration = Duration::from_millis(20);

/// The longest a session's raw log may sit unflushed while its events keep arriving.
///
/// Measured, not chosen for tidiness: a quit that never reaches [`Supervisor::shutdown_with`] —
/// macOS ⌘Q, which raises `RunEvent::Exit` with no `ExitRequested` before it
/// (`docs/research/tauri-commands.md` §12) — aborts the consumer task and the whole 64 KB
/// `BufWriter` goes with it. A per-line flush would reintroduce the syscall-per-chunk cost
/// `persistence.md` §4 rejects, so the compromise is a bounded window: at most this much of a
/// transcript can be lost, and never a settled turn.
const RAW_LOG_FLUSH_INTERVAL: Duration = Duration::from_millis(250);

/// A poisoned lock means a panic elsewhere, not a reason to panic here too: the data behind these
/// locks is a map of handles and a pile of counters, and carrying on with it is strictly better
/// than taking the app down.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Everything the supervisor needs to exist.
pub struct SupervisorConfig {
    /// The open store's handle.
    pub store: StoreHandle,
    /// This launch's id, from `Store::run_id`. An approval carrying a different one is expired.
    pub run_id: String,
    /// Where per-session raw logs go (`<data_dir>/raw/<session>.ndjson`).
    pub data_dir: PathBuf,
    /// Where finished batches go.
    pub sink: Arc<dyn FeedSink>,
    /// What records live children so a crash does not orphan them.
    pub tracker: Arc<dyn ProcessTracker>,
    /// One batch per project per tick. 16 ms is one animation frame at 60 Hz.
    pub frame_interval: Duration,
}

impl SupervisorConfig {
    /// A config with a [`NoopTracker`] and a 16 ms frame.
    pub fn new(
        store: StoreHandle,
        run_id: impl Into<String>,
        data_dir: impl Into<PathBuf>,
        sink: Arc<dyn FeedSink>,
    ) -> Self {
        Self {
            store,
            run_id: run_id.into(),
            data_dir: data_dir.into(),
            sink,
            tracker: Arc::new(NoopTracker),
            frame_interval: DEFAULT_FRAME_INTERVAL,
        }
    }
}

impl std::fmt::Debug for SupervisorConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SupervisorConfig")
            .field("run_id", &self.run_id)
            .field("data_dir", &self.data_dir)
            .field("frame_interval", &self.frame_interval)
            .finish_non_exhaustive()
    }
}

/// One live session: what it takes to command it and to account for it.
struct LiveSession {
    project_id: String,
    commands: SessionCommands,
    approvals: ApprovalTable,
    pid: Option<u32>,
    /// Set immediately after the entry is filed; `None` only inside that window.
    task: Option<JoinHandle<()>>,
}

struct Inner {
    store: StoreHandle,
    run_id: String,
    data_dir: PathBuf,
    tracker: Arc<dyn ProcessTracker>,
    batcher: Batcher,
    drivers: Mutex<BTreeMap<DriverKind, Arc<dyn ProviderDriver>>>,
    live: Mutex<BTreeMap<SessionId, LiveSession>>,
    flusher: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Some(task) = lock(&self.flusher).take() {
            task.abort();
        }
    }
}

/// The app's managed state: every live session, every registered driver, and the feed batcher.
///
/// Cheap to clone; every clone drives the same sessions.
#[derive(Clone)]
pub struct Supervisor {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Supervisor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Supervisor")
            .field("run_id", &self.inner.run_id)
            .field("live", &lock(&self.inner.live).len())
            .field("drivers", &lock(&self.inner.drivers).keys().cloned().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

impl Supervisor {
    /// Build the supervisor and start its flusher.
    ///
    /// Must be called from inside a Tokio runtime: the per-frame flusher is a spawned task.
    pub fn new(config: SupervisorConfig) -> Self {
        let batcher = Batcher::new(Arc::clone(&config.sink));
        let flusher = batcher.spawn_flusher(config.frame_interval);
        Supervisor {
            inner: Arc::new(Inner {
                store: config.store,
                run_id: config.run_id,
                data_dir: config.data_dir,
                tracker: config.tracker,
                batcher,
                drivers: Mutex::new(BTreeMap::new()),
                live: Mutex::new(BTreeMap::new()),
                flusher: Mutex::new(Some(flusher)),
            }),
        }
    }

    /// This launch's id.
    pub fn run_id(&self) -> &str {
        &self.inner.run_id
    }

    /// Where raw logs are written.
    pub fn data_dir(&self) -> &Path {
        &self.inner.data_dir
    }

    /// The feed batcher, for instrumentation and tests.
    pub fn batcher(&self) -> &Batcher {
        &self.inner.batcher
    }

    // ---- drivers -------------------------------------------------------------------------

    /// File a driver under its own [`DriverKind`], replacing any previous instance of that kind.
    ///
    /// One instance per kind is all this phase needs; multi-account is a map keyed by
    /// `InstanceId` and a decision about which one a new session gets, neither of which exists yet.
    pub fn register_driver(&self, driver: Arc<dyn ProviderDriver>) {
        lock(&self.inner.drivers).insert(driver.kind(), driver);
    }

    /// Remove the driver filed under `kind`, handing back whatever was there.
    ///
    /// Only the caller that registered a throwaway driver — the burn — has any business calling
    /// this; sessions already started keep running, because a driver is consulted only by
    /// [`Supervisor::start_session`].
    pub fn unregister_driver(&self, kind: &DriverKind) -> Option<Arc<dyn ProviderDriver>> {
        lock(&self.inner.drivers).remove(kind)
    }

    /// The driver registered for `kind`, if any.
    pub fn driver(&self, kind: &DriverKind) -> Option<Arc<dyn ProviderDriver>> {
        lock(&self.inner.drivers).get(kind).map(Arc::clone)
    }

    /// Every registered kind, sorted.
    pub fn driver_kinds(&self) -> Vec<DriverKind> {
        lock(&self.inner.drivers).keys().cloned().collect()
    }

    // ---- projects ------------------------------------------------------------------------

    /// Record a project rooted at `path`.
    ///
    /// The directory must exist. A path already recorded returns the existing row rather than
    /// minting a second id for the same tree.
    pub async fn add_project(&self, path: PathBuf) -> Result<ProjectRow, SupervisorError> {
        if !path.is_dir() {
            return Err(SupervisorError::InvalidArgument(format!(
                "{} is not an existing directory",
                path.display()
            )));
        }
        let root_path = std::fs::canonicalize(&path)?;
        if let Some(existing) =
            self.list_projects().await?.into_iter().find(|p| p.root_path == root_path)
        {
            return Ok(existing);
        }
        let name = root_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root_path.to_string_lossy().into_owned());
        let row = ProjectRow {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            root_path,
            created_at: SystemTime::now(),
        };
        self.inner.store.upsert_project(row.clone()).await?;
        Ok(row)
    }

    /// Every project, oldest first.
    pub async fn list_projects(&self) -> Result<Vec<ProjectRow>, SupervisorError> {
        Ok(self.inner.store.list_projects().await?)
    }

    /// One project by id.
    pub async fn project(&self, project_id: &str) -> Result<Option<ProjectRow>, SupervisorError> {
        Ok(self.inner.store.project(project_id).await?)
    }

    // ---- sessions ------------------------------------------------------------------------

    /// Start a session for `project_id` on the driver registered for `kind`.
    ///
    /// The session row is written before the consumer task starts, so a feed row can never arrive
    /// for a session the database has not heard of.
    pub async fn start_session(
        &self,
        project_id: &str,
        kind: &DriverKind,
        req: StartSession,
    ) -> Result<SessionId, SupervisorError> {
        let project = self
            .project(project_id)
            .await?
            .ok_or(SupervisorError::NoSuchProject)?;
        let driver =
            self.driver(kind).ok_or_else(|| SupervisorError::NoDriver(kind.clone()))?;

        let cwd = req.cwd.clone();
        let model = req.model.clone();
        let handle = driver.start_session(req).await?;
        let SessionHandle { session_id, instance_id, events, commands, approvals, pid } = handle;

        let mut row = SessionRow::new(session_id.clone());
        row.project_id = Some(project.id.clone());
        row.instance_id = Some(instance_id.clone());
        row.driver_kind = Some(driver.kind());
        row.cwd = Some(cwd.clone());
        row.model = model;
        row.status = Some(SessionStatus::Starting);
        row.started_at = Some(SystemTime::now());
        self.inner.store.upsert_session(row).await?;

        // A log that will not open is a lost transcript, not a lost session.
        let raw_log = match RawLog::open(&self.inner.data_dir, &session_id) {
            Ok(log) => Some(log),
            Err(e) => {
                tracing::warn!(error = %e, session_id = session_id.as_str(), "raw log unavailable");
                None
            }
        };

        if let Some(pid) = pid {
            let binary = driver.describe().binary_path.unwrap_or_default();
            self.inner.tracker.track(&session_id, pid, &binary, &cwd);
        }

        // File the entry *before* spawning: the task removes itself when the stream ends, and a
        // script short enough to finish first would otherwise leave a corpse in the map.
        lock(&self.inner.live).insert(
            session_id.clone(),
            LiveSession {
                project_id: project.id.clone(),
                commands,
                approvals,
                pid,
                task: None,
            },
        );
        let task = tokio::spawn(consume(
            Arc::clone(&self.inner),
            project.id,
            session_id.clone(),
            instance_id,
            events,
            raw_log,
        ));
        match lock(&self.inner.live).get_mut(&session_id) {
            Some(entry) => entry.task = Some(task),
            // Already gone: the session ended between the insert and here.
            None => task.abort(),
        }
        Ok(session_id)
    }

    /// Session ids that are live right now, sorted.
    pub fn live_sessions(&self) -> Vec<SessionId> {
        lock(&self.inner.live).keys().cloned().collect()
    }

    /// Whether this session is still being driven.
    pub fn is_live(&self, session_id: &SessionId) -> bool {
        lock(&self.inner.live).contains_key(session_id)
    }

    /// Which project a live session belongs to.
    pub fn project_of(&self, session_id: &SessionId) -> Option<String> {
        lock(&self.inner.live).get(session_id).map(|s| s.project_id.clone())
    }

    /// The child pid behind a live session, when it has one.
    pub fn pid(&self, session_id: &SessionId) -> Option<u32> {
        lock(&self.inner.live).get(session_id).and_then(|s| s.pid)
    }

    fn commands(&self, session_id: &SessionId) -> Result<SessionCommands, SupervisorError> {
        lock(&self.inner.live)
            .get(session_id)
            .map(|s| s.commands.clone())
            .ok_or(SupervisorError::NoSuchSession)
    }

    /// Queue a user turn; the returned id is the one the session's events will carry.
    pub async fn send_turn(
        &self,
        session_id: &SessionId,
        text: impl Into<String>,
    ) -> Result<TurnId, SupervisorError> {
        self.commands(session_id)?
            .send_turn(TurnInput::text(text))
            .await
            .map_err(error::from_command)
    }

    /// Answer a parked request.
    pub async fn respond(
        &self,
        session_id: &SessionId,
        request_id: RequestId,
        decision: Decision,
    ) -> Result<(), SupervisorError> {
        self.commands(session_id)?
            .respond(request_id, decision)
            .await
            .map_err(error::from_respond)
    }

    /// End the current turn; the session survives.
    pub async fn interrupt(&self, session_id: &SessionId) -> Result<(), SupervisorError> {
        self.commands(session_id)?.interrupt().await.map_err(error::from_command)
    }

    /// End the session gracefully. The exit arrives on the event stream, not from this call.
    pub async fn end_session(&self, session_id: &SessionId) -> Result<(), SupervisorError> {
        self.commands(session_id)?.end_session().await.map_err(error::from_command)
    }

    /// Kill the session's process group.
    pub async fn kill(&self, session_id: &SessionId) -> Result<(), SupervisorError> {
        self.commands(session_id)?.kill().await.map_err(error::from_command)
    }

    /// Requests parked right now for one live session, oldest first.
    pub fn pending_for(&self, session_id: &SessionId) -> Vec<brigadier_core::approval::PendingApproval> {
        lock(&self.inner.live).get(session_id).map(|s| s.approvals.pending()).unwrap_or_default()
    }

    // ---- reads ---------------------------------------------------------------------------

    /// The newest `n` feed rows for a session, oldest first, in wire shape.
    pub async fn feed_tail(
        &self,
        session_id: &SessionId,
        n: usize,
    ) -> Result<Vec<FeedRowWire>, SupervisorError> {
        let rows = self.inner.store.feed_tail(session_id.clone(), n).await?;
        Ok(rows.iter().map(FeedRowWire::from).collect())
    }

    /// Every session, newest first.
    pub async fn list_sessions(&self) -> Result<Vec<SessionRecord>, SupervisorError> {
        Ok(self.inner.store.list_sessions().await?)
    }

    /// One session by id.
    pub async fn session(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<SessionRecord>, SupervisorError> {
        Ok(self.inner.store.session(session_id.clone()).await?)
    }

    /// Every unanswered approval, oldest first, each marked resumable or expired.
    ///
    /// Expired means nothing is listening: the record belongs to a previous launch (`run_id`), or
    /// its session is no longer in this launch's live map, which is the same thing from the
    /// operator's side.
    // see docs/research/persistence.md §6.
    pub async fn pending_approvals(&self) -> Result<Vec<ApprovalView>, SupervisorError> {
        let records = self.inner.store.pending_approvals().await?;
        let live: BTreeSet<String> =
            lock(&self.inner.live).keys().map(|k| k.as_str().to_owned()).collect();
        Ok(records
            .iter()
            .map(|r| {
                let expired = r.run_id != self.inner.run_id || !live.contains(r.session_id.as_str());
                ApprovalView::from_record(r, expired)
            })
            .collect())
    }

    /// Rows for projects outside `ids` are dropped in Rust and counted; signals still flow.
    pub fn set_visible_projects(&self, ids: Vec<String>) {
        self.inner.batcher.set_visible_projects(ids);
    }

    // ---- teardown ------------------------------------------------------------------------

    /// End every live session gracefully, then kill whatever is left.
    pub async fn shutdown(&self) {
        self.shutdown_with(SHUTDOWN_GRACE).await;
    }

    /// [`Supervisor::shutdown`] with an explicit grace period.
    ///
    /// This is the path that keeps a quit from losing data: every consumer task that ends on its
    /// own routes a real `SessionExited` through the store *and* flushes its raw log, whereas
    /// [`Supervisor::shutdown_sync`] only aborts them. So the graceful phase runs first and the
    /// synchronous one is the backstop underneath it.
    ///
    /// Bounded end to end by `grace + KILL_GRACE`, whatever the adapters do: the two teardown
    /// commands are fanned out concurrently and abandoned when their budget runs out, so a
    /// session whose adapter never answers costs one grace period for everybody, not one each.
    ///
    /// Logs one `info` line on the way out — sessions live at entry, how many ended gracefully,
    /// how many had to be killed, how many were dropped mid-stream, and the wall time. A quit is
    /// the one path nobody can attach a debugger to, so it accounts for itself in the log.
    pub async fn shutdown_with(&self, grace: Duration) {
        let started = Instant::now();
        let deadline = started + grace;
        let live = lock(&self.inner.live).len();
        fan_out(self.all_commands(), Teardown::End, grace).await;
        self.drain_until(deadline).await;

        // Whatever is still live either never answered or has no graceful ending.
        let killed = lock(&self.inner.live).len();
        fan_out(self.all_commands(), Teardown::Kill, KILL_GRACE).await;
        self.drain_until(Instant::now() + KILL_GRACE).await;

        // Anything left after the kill phase is dropped mid-stream by the sync backstop: its
        // consumer is aborted, so this is the count of transcripts that end without a real exit.
        let dropped = lock(&self.inner.live).len();
        self.shutdown_sync(Duration::ZERO);
        tracing::info!(
            live,
            drained = live.saturating_sub(killed),
            killed,
            dropped,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "supervisor shutdown"
        );
    }

    /// Poll the live map until it is empty or `deadline` passes.
    async fn drain_until(&self, deadline: Instant) {
        while !lock(&self.inner.live).is_empty() {
            let now = Instant::now();
            if now >= deadline {
                return;
            }
            tokio::time::sleep(DRAIN_POLL.min(deadline - now)).await;
        }
    }

    fn all_commands(&self) -> Vec<SessionCommands> {
        lock(&self.inner.live).values().map(|s| s.commands.clone()).collect()
    }

    /// Drop every live session and hand the tracker `grace` to finish off their process groups.
    ///
    /// Synchronous and safe off a Tokio runtime, because the caller is an application exit
    /// handler on the UI thread. The tracker owns the killing; this only lets go of the handles.
    pub fn shutdown_sync(&self, grace: Duration) {
        let live = std::mem::take(&mut *lock(&self.inner.live));
        for (session_id, session) in live {
            session.approvals.cancel_all("app is shutting down");
            if let Some(task) = session.task {
                task.abort();
            }
            tracing::debug!(session_id = session_id.as_str(), "dropped on shutdown");
        }
        self.inner.tracker.shutdown_sync(grace);
    }
}

/// One session's raw log plus the clock that decides when its buffer reaches the disk.
///
/// [`RawLog`] itself has no flush policy — it is a `BufWriter` and a rotating file — because the
/// policy belongs to whoever knows what an event means. That is here.
struct LoggedRaw {
    log: RawLog,
    last_flush: Instant,
}

impl LoggedRaw {
    fn new(log: RawLog) -> Self {
        Self { log, last_flush: Instant::now() }
    }

    /// Serialize one envelope into the log, then flush if it settled something or the window
    /// ([`RAW_LOG_FLUSH_INTERVAL`]) has expired.
    ///
    /// The forcing events are the ones a reader would notice missing: a turn that ended either
    /// way, the session's exit, and an approval prompt — the last because the operator may sit on
    /// it for minutes, which is exactly the window in which a quit loses everything before it.
    fn write(&mut self, env: &Envelope) {
        match serde_json::to_vec(env) {
            Ok(line) => {
                if let Err(e) = self.log.append_line(&line) {
                    tracing::warn!(error = %e, "raw log write failed");
                }
            }
            Err(e) => tracing::warn!(error = %e, "envelope would not serialize"),
        }
        let forced = matches!(
            env.event,
            Event::TurnCompleted { .. }
                | Event::TurnAborted { .. }
                | Event::SessionExited { .. }
                | Event::RequestOpened { .. }
        );
        if forced || self.last_flush.elapsed() >= RAW_LOG_FLUSH_INTERVAL {
            self.flush();
        }
    }

    fn flush(&mut self) {
        self.last_flush = Instant::now();
        if let Err(e) = self.log.flush() {
            tracing::warn!(error = %e, "raw log flush failed");
        }
    }
}

/// Which teardown command [`fan_out`] sends.
#[derive(Clone, Copy, Debug)]
enum Teardown {
    /// Close the child's stdin and let it exit on its own.
    End,
    /// Signal the process group.
    Kill,
}

/// Send one teardown command to every session at once, and give the whole fan-out `within`.
///
/// Concurrent rather than sequential because both commands wait for the adapter's ack: one
/// session whose adapter is gone would otherwise spend the entire budget by itself and leave the
/// rest untouched. Anything still outstanding when the budget expires is aborted — this runs on
/// the way out of the process, and a hung adapter must not hold the quit.
async fn fan_out(commands: Vec<SessionCommands>, how: Teardown, within: Duration) {
    if commands.is_empty() {
        return;
    }
    let mut set = tokio::task::JoinSet::new();
    for cmd in commands {
        set.spawn(async move {
            let _ = match how {
                Teardown::End => cmd.end_session().await,
                Teardown::Kill => cmd.kill().await,
            };
        });
    }
    let all = async {
        while set.join_next().await.is_some() {}
    };
    if tokio::time::timeout(within, all).await.is_err() {
        tracing::warn!(?how, "teardown command did not ack within its budget");
    }
    set.abort_all();
}

/// One session's consumer: persist, log, batch, and clean up when the stream ends.
///
/// Deliberately linear and unconditional. The three sinks are independent — a closed store must
/// not stop the feed, a full disk must not stop the store — so each failure is logged where it
/// happens and the loop carries on.
///
/// A stream can end two ways. Either a [`Event::SessionExited`] arrives and settles the session,
/// or the adapter drops its sender without one — a panicked task, a closed pipe, a driver that
/// forgot. The second case is synthesized here, because nothing else ever will: without it the
/// row stays `running` until the next app launch settles it, and the UI shows a live session
/// behind a dead process.
async fn consume(
    inner: Arc<Inner>,
    project_id: String,
    session_id: SessionId,
    instance_id: InstanceId,
    mut events: tokio::sync::mpsc::Receiver<Envelope>,
    raw_log: Option<RawLog>,
) {
    let mut raw_log = raw_log.map(LoggedRaw::new);
    let mut next_seq = 0u64;
    let mut exited = false;
    while let Some(env) = events.recv().await {
        next_seq = env.seq.saturating_add(1);
        route(&inner, &project_id, &env, raw_log.as_mut()).await;
        if matches!(env.event, Event::SessionExited { .. }) {
            exited = true;
            break;
        }
    }
    if !exited {
        // Routed exactly like a real event, so the store, the raw log and the webview all see the
        // same ending. `exit_code` stays `None`: no exit was observed.
        let env = Envelope::new(
            next_seq,
            instance_id,
            session_id.clone(),
            Event::SessionExited {
                reason: ExitReason::Error(STREAM_CLOSED.to_owned()),
                exit_code: None,
            },
        );
        tracing::warn!(session_id = session_id.as_str(), "{STREAM_CLOSED}; synthesizing an exit");
        route(&inner, &project_id, &env, raw_log.as_mut()).await;
    }
    if let Some(mut log) = raw_log {
        log.flush();
    }
    inner.tracker.untrack(&session_id);
    lock(&inner.live).remove(&session_id);
    tracing::debug!(session_id = session_id.as_str(), "session consumer finished");
}

/// Push one envelope through all three sinks, in order: store, raw log, batcher.
async fn route(inner: &Inner, project_id: &str, env: &Envelope, raw_log: Option<&mut LoggedRaw>) {
    // `feed::apply` is the whole persistence policy for an event, including the session row it
    // settles on `SessionStarted` (provider_session_id, model, cwd, resume_token, status Running)
    // and on `SessionExited`. Nothing here writes those columns a second time.
    brigadier_store::feed::apply(env, &inner.store).await;

    if let Some(log) = raw_log {
        log.write(env);
    }

    inner.batcher.push(project_id, env);
}
