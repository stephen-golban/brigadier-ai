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
pub mod worktree;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use brigadier_core::approval::ApprovalTable;
use brigadier_core::driver::{
    DriverKind, PermissionMode, ProviderDriver, Resumed, ResumeSession, StartSession,
};
use brigadier_core::event::{
    Envelope, Event, ExitReason, InstanceId, RequestId, SessionId, TurnId, Usage,
};
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
pub use crate::worktree::WorktreeCleanup;

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

/// One session's accounted token spend.
///
/// **Telemetry, never a gate.** Nothing in the harness refuses work on this number:
/// `docs/vision.md` removes the accumulating session — the harness owns the goal, plan, progress
/// and thread, and rents a model window per decision then throws it away — so there is no
/// long-lived context for a ceiling to protect. The refusal that once read this number is a dead
/// end (`docs/STATUS.md` §7), and nothing here should be repointed at one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextStatus {
    /// [`context_size`] of the session's stored usage.
    pub used: u64,
}

/// The four counters added, saturating: `input + cache_creation + cache_read + output`.
///
/// `context_window` is a capacity rather than a counter and is deliberately not part of it.
/// Nothing here reads a session transcript; the counters are already on the session row, written
/// by `brigadier_store::feed::apply` from the provider's own terminal frame, so this is a read of
/// one row.
///
/// **What comes back is lifetime token spend, not a context footprint.** Two caveats say why,
/// both **measured against the code, not asserted**, and neither fixable inside this crate:
///
/// 1. **The counters are cumulative for the session, not a snapshot of the live context.**
///    `crates/core/src/claude/adapter.rs:1258` reads `result.modelUsage`, which
///    `docs/research/agent-sdk.md` §6 records as "cumulative across turns … read the latest
///    `result`, never sum", and `brigadier_store::writer::Op::SetUsage` overwrites the row with
///    it. So this sum is what the session has spent since it started — on a 1M window using 100k
///    of it, it passes 700k after about seven turns.
/// 2. **Subagent turns are not excluded, because nothing in the store distinguishes them.** That
///    same `modelUsage` is chosen precisely *because* it "includes subagents, sidechains and
///    compaction" (`adapter.rs:1259`), and no column, event or flag separates them afterwards.
///    Excluding a subagent's spend would need a second counter fed from the main-loop-only
///    `usage` object, which is a change to `crates/core` and is **not** implemented.
///
/// On a resumed session the row also carries every earlier child's totals (`Accrued`), so the
/// number covers the whole conversation rather than the current child.
pub fn context_size(usage: &Usage) -> u64 {
    usage
        .input_tokens
        .saturating_add(usage.cache_creation_tokens)
        .saturating_add(usage.cache_read_tokens)
        .saturating_add(usage.output_tokens)
}

/// One live session: what it takes to command it and to account for it.
struct LiveSession {
    project_id: String,
    commands: SessionCommands,
    approvals: ApprovalTable,
    pid: Option<u32>,
    /// Which installation filed this entry. A consumer removes the entry only while the stored
    /// generation is still its own, so a previous child that is slow to die cannot un-live the
    /// session the operator is actually using.
    generation: u64,
    /// Set immediately after the entry is filed; `None` only inside that window.
    task: Option<JoinHandle<()>>,
}

/// What a session has already spent and consumed before its current child started.
///
/// Zero for a cold start. On a resume it is the row's own `cost_usd_cumulative` and `usage`,
/// because the provider reports `total_cost_usd` cumulatively **per child process** and the store
/// overwrites rather than sums (deliberately — see `docs/research/persistence.md` §3). Without a
/// base, resuming a session erases everything its earlier children cost.
// see docs/research/resume.md §11, and `brigadier_core::event::Usage`, whose own doc records that
// "a resumed session restarts at zero".
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Accrued {
    /// USD spent by earlier children of this session.
    cost_usd: f64,
    /// Tokens counted by earlier children of this session.
    usage: Usage,
}

impl Accrued {
    /// True for a cold start, where every envelope passes through untouched.
    fn is_zero(&self) -> bool {
        self.cost_usd == 0.0 && self.usage == Usage::default()
    }

    /// Add the earlier children's totals to a `TurnCompleted`, or `None` when the envelope needs
    /// no adjustment.
    ///
    /// Only the store row and the wire are rebased; the raw log keeps the provider's own numbers,
    /// so the transcript still says exactly what the CLI said.
    fn rebase(&self, env: &Envelope) -> Option<Envelope> {
        if self.is_zero() {
            return None;
        }
        let Event::TurnCompleted { turn_id, stop_reason, usage, cost_usd_cumulative } = &env.event
        else {
            return None;
        };
        let mut out = env.clone();
        out.event = Event::TurnCompleted {
            turn_id: turn_id.clone(),
            stop_reason: stop_reason.clone(),
            usage: Usage {
                input_tokens: self.usage.input_tokens.saturating_add(usage.input_tokens),
                output_tokens: self.usage.output_tokens.saturating_add(usage.output_tokens),
                cache_read_tokens: self
                    .usage
                    .cache_read_tokens
                    .saturating_add(usage.cache_read_tokens),
                cache_creation_tokens: self
                    .usage
                    .cache_creation_tokens
                    .saturating_add(usage.cache_creation_tokens),
                // A capacity, not a counter: the current child's report wins.
                context_window: usage.context_window.or(self.usage.context_window),
            },
            cost_usd_cumulative: self.cost_usd + cost_usd_cumulative,
        };
        Some(out)
    }
}

/// Holds a session's resume reservation until the live entry is filed or the resume fails.
///
/// Released by `Drop`, which is the whole point: `Supervisor::resume_session` has a dozen early
/// returns between the reservation and the spawn, and a reservation leaked by one of them would
/// make the session permanently unresumable.
struct ResumeGuard {
    inner: Arc<Inner>,
    session_id: SessionId,
}

impl Drop for ResumeGuard {
    fn drop(&mut self) {
        lock(&self.inner.resuming).remove(&self.session_id);
    }
}

/// Everything one installation needs beyond the driver and the session handle.
struct Install {
    project_id: String,
    cwd: PathBuf,
    /// Envelope number the adapter was seeded with; `0` on a cold start.
    start_seq: u64,
    /// Accounting the row already holds from earlier children of this session.
    base: Accrued,
}

/// Everything the per-session consumer needs beyond its channels.
struct ConsumeSpec {
    project_id: String,
    session_id: SessionId,
    instance_id: InstanceId,
    start_seq: u64,
    generation: u64,
    base: Accrued,
}

struct Inner {
    store: StoreHandle,
    run_id: String,
    data_dir: PathBuf,
    tracker: Arc<dyn ProcessTracker>,
    batcher: Batcher,
    drivers: Mutex<BTreeMap<DriverKind, Arc<dyn ProviderDriver>>>,
    live: Mutex<BTreeMap<SessionId, LiveSession>>,
    /// Sessions whose resume is in flight. Reserved before the first `await` and released when
    /// the live entry is filed or the resume fails, so the window between "not live" and "live"
    /// — which spans a whole process spawn — cannot be entered twice.
    // see docs/research/resume.md §9, "two children on one provider session".
    resuming: Mutex<BTreeSet<SessionId>>,
    /// Hands out [`LiveSession::generation`]; monotonic for the life of the process.
    generations: AtomicU64,
    flusher: Mutex<Option<JoinHandle<()>>>,
}

impl Inner {
    /// Reserve `session_id` for a resume, or say why it cannot be reserved.
    ///
    /// The liveness check and the reservation happen under the **same** `live` guard, and every
    /// path that files a live entry takes that guard too, so two concurrent resumes cannot both
    /// get past this point. Checking `is_live` alone does not work: the gap between that check and
    /// the insert in `Supervisor::install` spans a process spawn, which is ample time for a second
    /// click to slip through and put two children on one transcript with the same `start_seq`,
    /// each overwriting the other's feed rows.
    fn reserve_resume(&self, session_id: &SessionId) -> Result<(), SupervisorError> {
        let live = lock(&self.live);
        if live.contains_key(session_id) {
            return Err(SupervisorError::NotResumable(format!(
                "session {session_id} is still live"
            )));
        }
        let mut resuming = lock(&self.resuming);
        if !resuming.insert(session_id.clone()) {
            return Err(SupervisorError::NotResumable(format!(
                "session {session_id} is still live: a resume of it is already in flight"
            )));
        }
        Ok(())
    }

    /// True when a child is driving this session **or** a resume of it is in flight.
    ///
    /// `is_live` alone is not enough for anything that touches a session's files:
    /// [`Inner::reserve_resume`] reserves the id before the process spawn and the live entry is
    /// filed only after it, so there is a whole spawn's worth of time in which the session is
    /// "not live" and a child is nevertheless about to run in its worktree.
    ///
    /// Takes `live` before `resuming`, the same order as [`Inner::reserve_resume`], so the two
    /// can never deadlock against each other.
    fn is_engaged(&self, session_id: &SessionId) -> bool {
        let live = lock(&self.live);
        live.contains_key(session_id) || lock(&self.resuming).contains(session_id)
    }
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
                resuming: Mutex::new(BTreeSet::new()),
                generations: AtomicU64::new(0),
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
    ///
    /// Also the one place `.brigadier/` is excluded from the project's git index, in
    /// `$GIT_COMMON_DIR/info/exclude` and never in `.gitignore`. Here rather than in
    /// [`Supervisor::start_session`] because the exclude file is a shared resource that two
    /// concurrent starts could interleave on, and here rather than nowhere because without it one
    /// `git add -A` by an agent stages the nested worktree as a `160000` gitlink (**measured**).
    /// A project that is not a git repository skips it silently and is not an error.
    // see docs/research/worktree-git.md §1 and "Risks" 2 and 6.
    pub async fn add_project(&self, path: PathBuf) -> Result<ProjectRow, SupervisorError> {
        if !path.is_dir() {
            return Err(SupervisorError::InvalidArgument(format!(
                "{} is not an existing directory",
                path.display()
            )));
        }
        let root_path = std::fs::canonicalize(&path)?;
        // Before the early return, so re-adding a project repairs an exclude file that was
        // deleted or never written — and proves idempotent rather than merely being skipped.
        worktree::exclude_project(&root_path).await;
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
    ///
    /// **The child runs in its own git worktree**, `<project root>/.brigadier/worktrees/<id>`, on
    /// a new branch `brigadier/<id>`, and `req.cwd` is overridden with it. The worktree is created
    /// before the driver is asked for anything and rolled back — checkout removed, branch deleted
    /// — if the child will not come up, so a failed start leaves nothing behind. A project that is
    /// not a git repository (or a machine with no `git`) gets no worktree: the session runs in the
    /// project root and its row's `worktree_path`/`branch` stay `NULL`.
    ///
    /// # Errors
    /// [`SupervisorError::WorktreeUnbornHead`] when the project has no commit to branch from,
    /// [`SupervisorError::WorktreeBranchExists`] when the branch is already taken, and
    /// [`SupervisorError::Worktree`] for any other git refusal. Each of them refuses the start
    /// rather than falling back to the project root.
    // see docs/research/worktree-git.md §3, §5 and §7.
    pub async fn start_session(
        &self,
        project_id: &str,
        kind: &DriverKind,
        mut req: StartSession,
    ) -> Result<SessionId, SupervisorError> {
        let project = self
            .project(project_id)
            .await?
            .ok_or(SupervisorError::NoSuchProject)?;
        let driver =
            self.driver(kind).ok_or_else(|| SupervisorError::NoDriver(kind.clone()))?;

        let prepared = worktree::prepare(&project.root_path).await?;
        if let Some(prepared) = &prepared {
            req.cwd = prepared.path.clone();
        }
        let cwd = req.cwd.clone();
        let model = req.model.clone();
        let handle = match driver.start_session(req).await {
            Ok(handle) => handle,
            Err(e) => {
                // Nothing ever ran here, so the branch is worth no more than the checkout.
                if let Some(prepared) = prepared {
                    prepared.roll_back().await;
                }
                return Err(SupervisorError::Driver(e));
            }
        };

        let mut row = SessionRow::new(handle.session_id.clone());
        row.project_id = Some(project.id.clone());
        row.instance_id = Some(handle.instance_id.clone());
        row.driver_kind = Some(driver.kind());
        row.cwd = Some(cwd.clone());
        // `cwd` and `worktree_path` are the same string when there is a worktree, and that is
        // deliberate: `resume_session` reads `cwd`, so the resumed child lands in the same
        // checkout without needing to know worktrees exist.
        row.worktree_path = prepared.as_ref().map(|p| p.path.clone());
        row.branch = prepared.as_ref().map(|p| p.branch.clone());
        row.model = model;
        row.status = Some(SessionStatus::Starting);
        row.started_at = Some(SystemTime::now());
        self.inner.store.upsert_session(row).await?;

        self.install(
            &driver,
            handle,
            Install { project_id: project.id, cwd, start_seq: 0, base: Accrued::default() },
        )
    }

    /// Continue an ended session: the same harness row, a new child, the same feed.
    ///
    /// Refused unless the row carries a `resume_token`, no child is live on it, and its status is
    /// `exited` or `failed` — `failed` included because `settle_stale_sessions` turns every
    /// session that outlived a crash or a force-quit into `failed`, which is the most common
    /// reason an operator reaches for Resume at all.
    ///
    /// The envelope numbering is seeded from `sessions.last_event_seq`, so the new child's rows
    /// land after the old conversation's instead of overwriting them in place, and the row's
    /// `ended_at`/`exit_code` are cleared by [`brigadier_store::StoreHandle::session_resumed`],
    /// which is the only op that can clear them.
    ///
    /// The permission mode is **not** restored from the old session: the CLI does not restore it
    /// on a non-interactive resume either, and the harness has nowhere to read it from — no
    /// column stores it. The child comes back in [`PermissionMode::Default`].
    ///
    /// # Errors
    /// [`SupervisorError::NoSuchSession`] when the store has no such row,
    /// [`SupervisorError::NotResumable`] when one of the three conditions above fails,
    /// [`SupervisorError::NoSuchProject`] when the row's project is gone,
    /// [`SupervisorError::NoDriver`] when no driver is registered for the row's kind, and
    /// [`SupervisorError::Driver`] when the child will not come up — including the case where the
    /// provider no longer holds the conversation, which reaches us only as a failed handshake.
    // see docs/research/resume.md §7 (data model), §8 gap 4 and §9 (risks).
    pub async fn resume_session(
        &self,
        session_id: &SessionId,
    ) -> Result<SessionId, SupervisorError> {
        // Reserved before the first `await`, and released by `_guard` on every path out. The
        // liveness check lives inside the reservation because the two must be one atomic step:
        // everything below is a sequence of awaits ending in a process spawn, and a bare
        // `is_live` check would let a second concurrent call through the whole of it.
        self.inner.reserve_resume(session_id)?;
        let _guard =
            ResumeGuard { inner: Arc::clone(&self.inner), session_id: session_id.clone() };

        let record = self.session(session_id).await?.ok_or(SupervisorError::NoSuchSession)?;
        if !matches!(record.status, SessionStatus::Exited | SessionStatus::Failed) {
            return Err(SupervisorError::NotResumable(format!(
                "session {session_id} is {}, not exited or failed",
                record.status.as_str()
            )));
        }
        let token = record.resume_token.clone().ok_or_else(|| {
            SupervisorError::NotResumable(format!(
                "session {session_id} has no resume token; the provider never named its session"
            ))
        })?;
        let kind = record.driver_kind.clone().ok_or_else(|| {
            SupervisorError::NotResumable(format!(
                "session {session_id} records no driver kind"
            ))
        })?;
        let project_id = record.project_id.clone().ok_or_else(|| {
            SupervisorError::NotResumable(format!("session {session_id} belongs to no project"))
        })?;
        let project = self.project(&project_id).await?.ok_or(SupervisorError::NoSuchProject)?;
        let driver = self.driver(&kind).ok_or_else(|| SupervisorError::NoDriver(kind.clone()))?;

        let cwd = record.cwd.clone().unwrap_or_else(|| project.root_path.clone());
        // A pruned worktree, a deleted checkout: the spawn would fail as `driver`, which the
        // contract tells the UI to read as "the provider swept the conversation". Name the real
        // cause instead. see docs/plans/ipc-contract.md "### resume_session".
        if !cwd.is_dir() {
            return Err(SupervisorError::NotResumable(format!(
                "the working directory {} is gone",
                cwd.display()
            )));
        }
        let start_seq = record.last_event_seq;
        let mut req = ResumeSession::new(token, cwd.clone());
        req.model = record.model.clone();
        req.permission_mode = PermissionMode::Default;
        req.resumed = Some(Resumed { session_id: session_id.clone(), start_seq });
        let handle = driver.resume_session(req).await?;

        // Clear the ending *before* the merge: `upsert_session` COALESCEs every column it names
        // and does not name `ended_at`/`exit_code` at all, so nothing else can unset them.
        // see docs/research/resume.md §8 gap 5.
        self.inner.store.session_resumed(session_id.clone(), SystemTime::now()).await?;
        let mut row = SessionRow::new(session_id.clone());
        row.instance_id = Some(handle.instance_id.clone());
        row.driver_kind = Some(driver.kind());
        row.cwd = Some(cwd.clone());
        row.model = record.model.clone();
        row.status = Some(SessionStatus::Starting);
        self.inner.store.upsert_session(row).await?;

        // The provider's `total_cost_usd` restarts at zero in every child, and the store
        // overwrites rather than sums, so the row's current totals become the base every
        // `TurnCompleted` from here on is added to. see docs/research/resume.md §11.
        let base = Accrued { cost_usd: record.cost_usd_cumulative, usage: record.usage };
        tracing::info!(
            session_id = session_id.as_str(),
            start_seq,
            base_cost_usd = base.cost_usd,
            instance_id = handle.instance_id.as_str(),
            "resuming"
        );
        // `_guard` is still held: it is released when this function returns, which is after
        // `install` has filed the real live entry.
        self.install(&driver, handle, Install { project_id: project.id, cwd, start_seq, base })
    }

    /// Everything a started and a resumed session do identically: file the live entry, open the
    /// raw log, track the pid, and spawn the consumer.
    ///
    /// # Errors
    /// [`SupervisorError::NotResumable`] when an entry for that session is already live. The
    /// reservation in [`Inner::reserve_resume`] should make that unreachable; this is the second
    /// lock on the same door, because overwriting a live entry silently orphans a child process
    /// and hands its exit the power to un-live the session that replaced it.
    fn install(
        &self,
        driver: &Arc<dyn ProviderDriver>,
        handle: SessionHandle,
        what: Install,
    ) -> Result<SessionId, SupervisorError> {
        let Install { project_id, cwd, start_seq, base } = what;
        let SessionHandle { session_id, instance_id, events, commands, approvals, pid } = handle;
        let generation = self.inner.generations.fetch_add(1, Ordering::Relaxed).wrapping_add(1);

        // File the entry *before* spawning: the task removes itself when the stream ends, and a
        // script short enough to finish first would otherwise leave a corpse in the map.
        {
            let mut live = lock(&self.inner.live);
            if live.contains_key(&session_id) {
                drop(live);
                tracing::error!(
                    session_id = session_id.as_str(),
                    "refusing to install over a live session; killing the child just spawned"
                );
                tokio::spawn(async move {
                    let _ = commands.kill().await;
                });
                return Err(SupervisorError::NotResumable(format!(
                    "session {session_id} is still live"
                )));
            }
            live.insert(
                session_id.clone(),
                LiveSession {
                    project_id: project_id.clone(),
                    commands,
                    approvals,
                    pid,
                    generation,
                    task: None,
                },
            );
        }

        // A log that will not open is a lost transcript, not a lost session. It is opened in
        // append mode, so a resume continues the same file rather than truncating it.
        // see crates/store/src/ndjson.rs `RawLog::open` (measured against file-rotate 0.8.0).
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

        let task = tokio::spawn(consume(
            Arc::clone(&self.inner),
            ConsumeSpec {
                project_id,
                session_id: session_id.clone(),
                instance_id,
                start_seq,
                generation,
                base,
            },
            events,
            raw_log,
        ));
        match lock(&self.inner.live).get_mut(&session_id) {
            Some(entry) if entry.generation == generation => entry.task = Some(task),
            // Already gone, or already replaced: the session ended between the insert and here.
            _ => task.abort(),
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
    ///
    /// Never refused on context size: `docs/vision.md` removes the accumulating session, so there
    /// is no long-lived window for a ceiling to protect. [`Supervisor::context_status`] reports
    /// the number; nothing acts on it.
    ///
    /// # Errors
    /// [`SupervisorError::NoSuchSession`] when nothing is live under that id, and
    /// [`SupervisorError::SessionNotRunning`] when its adapter has gone.
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

    /// What this session has accounted for, as telemetry. Nothing gates on it.
    ///
    /// Read from the session's stored row — no transcript is parsed. See [`context_size`] for
    /// what the number is and, more importantly, what it is **not**: it is lifetime token spend
    /// including every subagent, never a snapshot of the live context.
    ///
    /// # Errors
    /// [`SupervisorError::NoSuchSession`] when the store has no such row.
    pub async fn context_status(
        &self,
        session_id: &SessionId,
    ) -> Result<ContextStatus, SupervisorError> {
        let record = self.session(session_id).await?.ok_or(SupervisorError::NoSuchSession)?;
        Ok(ContextStatus { used: context_size(&record.usage) })
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
    ///
    /// The session's worktree is **left alone**. It is the `cwd` a resume needs, and removing a
    /// clean worktree whose branch carries unmerged commits exits 0 in silence (**measured**);
    /// cleanup is [`Supervisor::cleanup_worktree`] and nothing else calls it.
    // see docs/research/worktree-git.md §4 "Risks" 1.
    pub async fn end_session(&self, session_id: &SessionId) -> Result<(), SupervisorError> {
        self.commands(session_id)?.end_session().await.map_err(error::from_command)
    }

    /// Kill the session's process group.
    ///
    /// Leaves the worktree, for the same reason [`Supervisor::end_session`] does — more so: a
    /// killed session is the one most likely to be resumed.
    pub async fn kill(&self, session_id: &SessionId) -> Result<(), SupervisorError> {
        self.commands(session_id)?.kill().await.map_err(error::from_command)
    }

    // ---- worktrees -----------------------------------------------------------------------

    /// Remove one ended session's worktree, keeping its branch.
    ///
    /// Explicit, never automatic. `force = false` is the question — a dirty worktree comes back
    /// as `removed: false` with the entry count and nothing touched — and `force = true` is the
    /// answer. Either way the branch survives: the checkout is reconstructible, the branch is the
    /// only copy of whatever the agent committed, and `git worktree remove` on a clean tree with
    /// unmerged commits exits 0 without a word (**measured**).
    ///
    /// A checkout already gone from disk is pruned out of git's registry and reported removed.
    ///
    /// After this the session's `cwd` names a directory that no longer exists, so resuming it
    /// will fail; clean up a session only when you are finished with it.
    ///
    /// The row keeps its `worktree_path` and `branch`: `upsert_session` COALESCEs every column it
    /// names, so there is no op that can clear them, and inventing one to erase the only record
    /// of which branch holds the work is the wrong trade. A second call on the same session is
    /// therefore not an error — the checkout is already gone, so it prunes and answers
    /// `removed: true` again.
    ///
    /// # Errors
    /// [`SupervisorError::NoSuchSession`] when the store has no such row,
    /// [`SupervisorError::SessionLive`] when a child is still running in it,
    /// [`SupervisorError::InvalidArgument`] when the session has no worktree at all, and
    /// [`SupervisorError::Worktree`] for a git failure.
    // see docs/research/worktree-git.md §4 and "Risks" 1.
    pub async fn cleanup_worktree(
        &self,
        session_id: &SessionId,
        force: bool,
    ) -> Result<WorktreeCleanup, SupervisorError> {
        let record = self.session(session_id).await?.ok_or(SupervisorError::NoSuchSession)?;
        // `is_engaged`, not `is_live`: a resume reserved but not yet spawned is about to run a
        // child in exactly the directory this call would delete.
        if self.inner.is_engaged(session_id) {
            return Err(SupervisorError::SessionLive(format!(
                "session {session_id} is still live; end it before cleaning up its worktree"
            )));
        }
        let path = record.worktree_path.clone().ok_or_else(|| {
            SupervisorError::InvalidArgument(format!(
                "session {session_id} has no worktree; it ran in its project root"
            ))
        })?;
        let branch = record.branch.clone().unwrap_or_default();
        // The repository, not the worktree: `git -C <removed path>` has nowhere to run.
        let repo = match record.project_id.as_deref() {
            Some(id) => self.project(id).await?.map(|p| p.root_path),
            None => None,
        };
        let repo = repo.ok_or_else(|| {
            SupervisorError::InvalidArgument(format!(
                "session {session_id} belongs to no project, so its repository is unknown"
            ))
        })?;
        let outcome = worktree::cleanup(&repo, &path, branch, force).await?;
        tracing::info!(
            session_id = session_id.as_str(),
            removed = outcome.removed,
            dirty_files = outcome.dirty_files,
            branch = %outcome.branch,
            "worktree cleanup"
        );
        Ok(outcome)
    }

    /// `git worktree prune` and the `.brigadier/` exclude line, in every project, at app start.
    ///
    /// Both halves are safe by construction and neither is ever fatal: a project that will not
    /// prune, or whose `info/exclude` will not open, is one `tracing::warn` line.
    ///
    /// The prune exists because a worktree directory deleted by hand stays in `git worktree
    /// list` as prunable and blocks the next `add` at the same path — and **measured**, prune
    /// never touches a branch.
    ///
    /// The exclude is here because [`Supervisor::add_project`] was the *only* caller of it, and
    /// a call that happens once per project can never repair anything: a project added before
    /// that code existed, or one whose write failed, stayed unexcluded forever and dirtied the
    /// operator's own repository with `?? .brigadier/` — **measured on this repository,
    /// 2026-09-02**. `worktree::exclude_project` is idempotent (it returns without writing when
    /// the pattern is already a line of the file, `crates/core/src/worktree.rs:679`) and
    /// swallows every failure, so running it per launch costs one `git rev-parse` and one read
    /// per project.
    // see docs/research/worktree-git.md §1 and §4.
    pub async fn prune_worktrees(&self) {
        let projects = match self.list_projects().await {
            Ok(projects) => projects,
            Err(e) => {
                tracing::warn!(error = %e, "could not list projects to prune their worktrees");
                return;
            }
        };
        for project in projects {
            worktree::prune_project(&project.root_path).await;
            worktree::exclude_project(&project.root_path).await;
        }
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
    spec: ConsumeSpec,
    mut events: tokio::sync::mpsc::Receiver<Envelope>,
    raw_log: Option<RawLog>,
) {
    let ConsumeSpec { project_id, session_id, instance_id, start_seq, generation, base } = spec;
    let mut raw_log = raw_log.map(LoggedRaw::new);
    // The adapter was seeded with `start_seq`, so its first envelope is `start_seq + 1`; a
    // synthesized exit for a stream that never spoke has to land there too, not at zero, or a
    // resumed session's ending would sort before its own history.
    // see docs/research/resume.md §7.
    let mut next_seq = start_seq.saturating_add(1);
    let mut exited = false;
    while let Some(env) = events.recv().await {
        next_seq = env.seq.saturating_add(1);
        route(&inner, &project_id, &env, raw_log.as_mut(), &base).await;
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
        route(&inner, &project_id, &env, raw_log.as_mut(), &base).await;
    }
    if let Some(mut log) = raw_log {
        log.flush();
    }
    inner.tracker.untrack(&session_id);
    // Only our own entry. A resumed session can briefly have two consumers — a previous child
    // winding down while the new one is already filed — and an unconditional remove would let
    // the dying one un-live the session the operator is using.
    {
        let mut live = lock(&inner.live);
        if live.get(&session_id).is_some_and(|s| s.generation == generation) {
            live.remove(&session_id);
        }
    }
    tracing::debug!(session_id = session_id.as_str(), "session consumer finished");
}

/// Push one envelope through all three sinks, in order: store, raw log, batcher.
///
/// The store and the batcher see the envelope **rebased** onto `base` — a `TurnCompleted`'s cost
/// and token counters carry the totals of every child this session has had, not just this one's.
/// The raw log does not: it keeps the provider's own numbers, so the transcript still says
/// exactly what the CLI said. see [`Accrued`].
async fn route(
    inner: &Inner,
    project_id: &str,
    env: &Envelope,
    raw_log: Option<&mut LoggedRaw>,
    base: &Accrued,
) {
    let rebased = base.rebase(env);
    let accounted = rebased.as_ref().unwrap_or(env);

    // `feed::apply` is the whole persistence policy for an event, including the session row it
    // settles on `SessionStarted` (provider_session_id, model, cwd, resume_token, status Running)
    // and on `SessionExited`. Nothing here writes those columns a second time.
    brigadier_store::feed::apply(accounted, &inner.store).await;

    if let Some(log) = raw_log {
        log.write(env);
    }

    inner.batcher.push(project_id, accounted);
}

#[cfg(test)]
mod tests {
    use super::*;
    use brigadier_core::event::{ItemId, ItemKind, StopReason};
    use brigadier_store::Store;

    /// Cost the replay's scripted `TurnCompleted` reports, as a child process would: cumulative
    /// for **that child**, starting from zero.
    const REPLAY_TURN_COST: f64 = 0.25;

    /// Token counters that scripted turn reports.
    const REPLAY_TURN_USAGE: Usage = Usage {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 30,
        cache_creation_tokens: 40,
        context_window: Some(200_000),
    };

    /// A supervisor over a throwaway store, with a replay driver already registered.
    struct Rig {
        _dir: tempfile::TempDir,
        store: Store,
        sup: Supervisor,
        kind: DriverKind,
    }

    impl Rig {
        fn new() -> Rig {
            let dir = tempfile::tempdir().expect("temp dir");
            let store = Store::open(dir.path()).expect("store opens");
            let sup = Supervisor::new(SupervisorConfig::new(
                store.handle().clone(),
                store.run_id().to_owned(),
                dir.path().to_owned(),
                Arc::new(VecSink::new()),
            ));
            // One assistant item and one completed turn per cycle. The turn carries a cost, so
            // the accounting a resume has to preserve is exercised as well as the feed.
            let script = vec![
                Event::item_completed(ItemId::new("i"), ItemKind::AssistantText, "hello", None),
                Event::TurnCompleted {
                    turn_id: TurnId::new("t"),
                    stop_reason: StopReason::EndTurn,
                    usage: REPLAY_TURN_USAGE,
                    cost_usd_cumulative: REPLAY_TURN_COST,
                },
            ];
            let driver = ReplayDriver::new(script).with_rate(200.0);
            let kind = driver.kind();
            sup.register_driver(Arc::new(driver));
            Rig { _dir: dir, store, sup, kind }
        }

        async fn project(&self) -> String {
            self.sup.add_project(self._dir.path().to_owned()).await.expect("project").id
        }

        /// Run a session for `ms`, then end it and wait for the live map to lose it.
        async fn run_and_end(&self, project: &str, ms: u64) -> SessionId {
            let session = self
                .sup
                .start_session(project, &self.kind, StartSession::new(self._dir.path()))
                .await
                .expect("session starts");
            tokio::time::sleep(Duration::from_millis(ms)).await;
            self.sup.end_session(&session).await.expect("end");
            assert!(self.until(Duration::from_secs(5), || !self.sup.is_live(&session)).await);
            session
        }

        /// Stand in for what a real `SessionStarted` would have stored: the replay never names a
        /// provider session, so no row it writes is resumable without this.
        async fn store_token(&self, id: &SessionId) {
            let mut row = SessionRow::new(id.clone());
            row.resume_token = Some("provider-session-id".to_owned());
            self.store.handle().upsert_session(row).await.expect("token stored");
            self.store.handle().flush().await.expect("flush");
        }

        async fn row(&self, id: &SessionId) -> SessionRecord {
            self.store.handle().flush().await.expect("flush");
            self.sup.session(id).await.expect("read").expect("row exists")
        }

        /// Poll until `f` holds, or give up after `within`.
        async fn until(&self, within: Duration, mut f: impl FnMut() -> bool) -> bool {
            let deadline = Instant::now() + within;
            while Instant::now() < deadline {
                if f() {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            f()
        }
    }

    /// Every refusal names the condition that failed, and every one carries the `not_resumable`
    /// code the contract puts on the wire.
    // see docs/research/resume.md §7.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_is_resumable_only_with_a_token_when_it_is_not_live_and_has_ended() {
        let rig = Rig::new();
        let project = rig.project().await;

        let unknown = SessionId::new("nope");
        assert!(matches!(
            rig.sup.resume_session(&unknown).await,
            Err(SupervisorError::NoSuchSession)
        ));

        let session = rig
            .sup
            .start_session(&project, &rig.kind, StartSession::new(rig._dir.path()))
            .await
            .expect("session starts");

        // Live: refused before anything else is looked at.
        let e = rig.sup.resume_session(&session).await.expect_err("a live session is refused");
        assert_eq!(e.code(), "not_resumable");
        assert!(e.to_string().contains("still live"), "{e}");

        rig.sup.end_session(&session).await.expect("end");
        assert!(rig.until(Duration::from_secs(5), || !rig.sup.is_live(&session)).await);

        // Ended, but the replay never reported a provider session id, so there is no token.
        let e = rig.sup.resume_session(&session).await.expect_err("no token is refused");
        assert_eq!(e.code(), "not_resumable");
        assert!(e.to_string().contains("no resume token"), "{e}");

        rig.store.close().await.expect("store closes");
    }

    /// The whole point of the feature, without a child process: the same row, a new instance, the
    /// old rows untouched, and the new rows after them.
    // see docs/research/resume.md §7.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_resumed_session_reuses_its_row_and_continues_its_feed() {
        let rig = Rig::new();
        let project = rig.project().await;
        let session = rig
            .sup
            .start_session(&project, &rig.kind, StartSession::new(rig._dir.path()))
            .await
            .expect("session starts");
        // Let the replay put a few rows down before ending it.
        tokio::time::sleep(Duration::from_millis(150)).await;
        rig.sup.end_session(&session).await.expect("end");
        assert!(rig.until(Duration::from_secs(5), || !rig.sup.is_live(&session)).await);

        let ended = rig.row(&session).await;
        let old_seq = ended.last_event_seq;
        assert!(old_seq > 0, "the first run must have written rows");
        assert!(ended.ended_at.is_some());
        let before = rig.sup.feed_tail(&session, 1000).await.expect("tail");
        let first_instance = ended.instance_id.clone().expect("an instance was recorded");
        assert!(!before.is_empty());

        // The replay never names a provider session, so stand in for what a real
        // `SessionStarted` would have stored.
        let mut row = SessionRow::new(session.clone());
        row.resume_token = Some("provider-session-id".to_owned());
        rig.store.handle().upsert_session(row).await.expect("token stored");
        rig.store.handle().flush().await.expect("flush");

        let resumed = rig.sup.resume_session(&session).await.expect("resume");
        assert_eq!(resumed, session, "the harness row is reused, never re-minted");
        let live = rig.row(&session).await;
        assert_eq!(live.ended_at, None, "a resumed session is not an ended one");
        assert_eq!(live.exit_code, None);
        // `instance_id` names the **driver instance** — the account — not the child, and one
        // driver serves every session it opens (`ClaudeDriver::open` clones its own id into every
        // `AdapterConfig`). So a resume keeps it. `docs/research/resume.md` §7's "new
        // `instance_id`" describes an id the code does not have.
        assert_eq!(live.instance_id, Some(first_instance), "the driver instance is unchanged");

        tokio::time::sleep(Duration::from_millis(150)).await;
        rig.sup.end_session(&session).await.expect("end again");
        assert!(rig.until(Duration::from_secs(5), || !rig.sup.is_live(&session)).await);

        let after = rig.sup.feed_tail(&session, 1000).await.expect("tail");
        assert!(after.len() > before.len(), "the resume wrote new rows");
        assert_eq!(&after[..before.len()], &before[..], "no old row changed");
        assert!(
            after[before.len()..].iter().all(|r| r.q > old_seq),
            "every post-resume row lands after the old ones: {:?}",
            &after[before.len()..]
        );

        rig.store.close().await.expect("store closes");
    }

    /// Two operators (or two clicks) resuming at once must not put two children on one
    /// transcript. Both would be seeded with the same `start_seq` and would overwrite each
    /// other's feed rows in place, because `feed`'s insert is `ON CONFLICT DO UPDATE`.
    ///
    /// Checking `is_live` and inserting into the live map are separated by a whole process spawn,
    /// so the check alone is not a lock; the reservation in `Inner::reserve_resume` is.
    // see docs/research/resume.md §9, "two children on one provider session".
    #[tokio::test(flavor = "multi_thread")]
    async fn two_concurrent_resumes_cannot_both_win() {
        let rig = Rig::new();
        let project = rig.project().await;
        let session = rig.run_and_end(&project, 100).await;
        rig.store_token(&session).await;

        let (a, b) = tokio::join!(
            rig.sup.resume_session(&session),
            rig.sup.resume_session(&session)
        );
        let winners = [&a, &b].iter().filter(|r| r.is_ok()).count();
        assert_eq!(winners, 1, "exactly one resume may win: a={a:?} b={b:?}");
        let loser = a.err().or(b.err()).expect("one of them failed");
        assert_eq!(loser.code(), "not_resumable");
        // The *reservation* is what turned it away, not the collision check inside `install`:
        // only `Inner::reserve_resume` says "already in flight", and it says it before the driver
        // is ever consulted, so the losing call never spawns a child at all. Asserting only
        // "still live" would pass even with the reservation removed, because `install` would
        // then catch the second caller after it had already started a process.
        assert!(
            loser.to_string().contains("already in flight"),
            "the second resume must be refused before it spawns anything: {loser}"
        );
        assert_eq!(
            rig.sup.live_sessions(),
            vec![session.clone()],
            "exactly one child is live afterwards"
        );

        rig.sup.end_session(&session).await.expect("end");
        assert!(rig.until(Duration::from_secs(5), || !rig.sup.is_live(&session)).await);
        rig.store.close().await.expect("store closes");
    }

    /// Cost and tokens are cumulative **across resumes**, not just within one child.
    ///
    /// The provider restarts `total_cost_usd` at zero in every child and
    /// `brigadier_store::writer::Op::SetUsage` overwrites rather than sums, so without a base the
    /// first child's spend disappears from the row the moment the second one completes a turn.
    /// The owner audits every cent; a resume must not lose one.
    // see docs/research/resume.md §11.
    #[tokio::test(flavor = "multi_thread")]
    async fn cost_and_usage_accumulate_across_a_resume() {
        const BASE_COST: f64 = 1.5;
        const BASE_USAGE: Usage = Usage {
            input_tokens: 1_000,
            output_tokens: 2_000,
            cache_read_tokens: 3_000,
            cache_creation_tokens: 4_000,
            context_window: Some(200_000),
        };

        let rig = Rig::new();
        let project = rig.project().await;
        let session = rig.run_and_end(&project, 100).await;
        rig.store_token(&session).await;

        // Stand the row up at a known total, as if earlier children had spent it.
        rig.store
            .handle()
            .set_usage(session.clone(), BASE_USAGE, BASE_COST)
            .await
            .expect("base recorded");
        rig.store.handle().flush().await.expect("flush");
        assert_eq!(rig.row(&session).await.cost_usd_cumulative, BASE_COST);

        rig.sup.resume_session(&session).await.expect("resume");
        // The resumed child reports `REPLAY_TURN_COST` as *its* cumulative total; give it long
        // enough to complete a scripted turn.
        tokio::time::sleep(Duration::from_millis(150)).await;
        rig.sup.end_session(&session).await.expect("end");
        assert!(rig.until(Duration::from_secs(5), || !rig.sup.is_live(&session)).await);

        let row = rig.row(&session).await;
        let expected = BASE_COST + REPLAY_TURN_COST;
        assert!(
            (row.cost_usd_cumulative - expected).abs() < 1e-9,
            "cost must be the base plus the resumed child's total, got {} want {expected}",
            row.cost_usd_cumulative
        );
        assert_eq!(
            row.usage,
            Usage {
                input_tokens: BASE_USAGE.input_tokens + REPLAY_TURN_USAGE.input_tokens,
                output_tokens: BASE_USAGE.output_tokens + REPLAY_TURN_USAGE.output_tokens,
                cache_read_tokens: BASE_USAGE.cache_read_tokens
                    + REPLAY_TURN_USAGE.cache_read_tokens,
                cache_creation_tokens: BASE_USAGE.cache_creation_tokens
                    + REPLAY_TURN_USAGE.cache_creation_tokens,
                context_window: Some(200_000),
            },
            "every token counter adds too"
        );

        rig.store.close().await.expect("store closes");
    }

    /// A cold start is not rebased at all: `Accrued::default()` passes every envelope through
    /// untouched, so nothing about the common path changes.
    #[test]
    fn a_zero_base_rebases_nothing() {
        let env = Envelope::new(
            1,
            InstanceId::new("i"),
            SessionId::new("s"),
            Event::TurnCompleted {
                turn_id: TurnId::new("t"),
                stop_reason: StopReason::EndTurn,
                usage: REPLAY_TURN_USAGE,
                cost_usd_cumulative: REPLAY_TURN_COST,
            },
        );
        assert!(Accrued::default().rebase(&env).is_none());
        // And a non-zero base leaves everything but a completed turn alone.
        let base = Accrued { cost_usd: 1.0, usage: Usage::default() };
        let other = Envelope::new(
            2,
            InstanceId::new("i"),
            SessionId::new("s"),
            Event::TurnStarted { turn_id: TurnId::new("t") },
        );
        assert!(base.rebase(&other).is_none());
        assert!(base.rebase(&env).is_some());
    }

    /// Every token the replay's scripted turn accounts for.
    const REPLAY_TURN_TOKENS: u64 = 10 + 20 + 30 + 40;

    /// The accounting is all four counters and nothing else — `context_window` is a capacity, and
    /// counting it would add a fixed 200,000 to every session on the first turn.
    #[test]
    fn the_size_is_the_four_counters_added_and_never_the_window() {
        let usage = Usage {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 4,
            cache_creation_tokens: 8,
            context_window: Some(200_000),
        };
        assert_eq!(context_size(&usage), 15);
        assert_eq!(context_size(&Usage::default()), 0);
        // Saturating, not wrapping: a provider that reports nonsense must not read as an empty
        // context.
        assert_eq!(context_size(&Usage { input_tokens: u64::MAX, ..usage }), u64::MAX);
    }

    /// `context_status` is telemetry off the stored row: it reports what the session accounted
    /// for, it says so for an unknown session rather than inventing a zero, and — the point of
    /// this test — no size of it ever refuses a turn.
    // see docs/STATUS.md §7: the wall that used to sit in `send_turn` is a dead end.
    #[tokio::test(flavor = "multi_thread")]
    async fn context_status_reports_the_row_and_never_gates_a_turn() {
        let rig = Rig::new();
        let project = rig.project().await;

        let e = rig
            .sup
            .context_status(&SessionId::new("nope"))
            .await
            .expect_err("an unknown session is still unknown");
        assert!(matches!(e, SupervisorError::NoSuchSession), "{e}");

        let session = rig
            .sup
            .start_session(&project, &rig.kind, StartSession::new(rig._dir.path()))
            .await
            .expect("session starts");

        // The scripted turn is the only thing that ever writes usage, and it overwrites with the
        // same constant every cycle, so the row settles at a known total.
        let mut used = 0;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            used = context_size(&rig.row(&session).await.usage);
            if used > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(used, REPLAY_TURN_TOKENS, "the replay's turn must have been accounted for");
        assert_eq!(
            rig.sup.context_status(&session).await.expect("status"),
            ContextStatus { used: REPLAY_TURN_TOKENS }
        );

        // However big the number gets, the turn goes through: there is no ceiling to cross.
        rig.sup.send_turn(&session, "one more").await.expect("a turn is never refused on size");

        rig.sup.end_session(&session).await.expect("end");
        assert!(rig.until(Duration::from_secs(5), || !rig.sup.is_live(&session)).await);
        rig.store.close().await.expect("store closes");
    }
}
