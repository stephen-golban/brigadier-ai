//! The app's managed state, and the startup that builds it.
//!
//! One managed type, one value, never removed — Tauri's state map is keyed by `TypeId` and
//! `unmanage` is deprecated as unsafe (`docs/research/tauri-commands.md` §4).
//!
//! The whole of `setup` is fallible and **none of it may `?` out**: `Builder::setup` returning
//! `Err` panics the process with no graceful path (`tauri-commands.md` §4.1). A read-only home
//! directory must produce a window that says so, not a crash. [`AppState`] starts pending
//! while the launch window paints, then publishes either the working services or the
//! original startup error. Shutdown prevents a late publication.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use brigadier_core::claude::{ClaudeDriver, ClaudeDriverConfig};
use brigadier_proc::{sweep, PidDir, PidTracker, DEFAULT_GRACE};
use brigadier_store::{Store, StoreHandle};
use brigadier_supervisor::loop_::barrier::{self, Barrier, ReconcileSender};
use brigadier_supervisor::{Supervisor, SupervisorConfig};

use crate::error::AppError;
use crate::sink::ChannelSink;
use crate::tracker::TrackerAdapter;
use crate::views::ClaudeStatus;

/// How long the graceful phase of the exit hook gets: `end_session` on every live session, then
/// a wait for their consumer tasks to finish.
///
/// `claude-direct-spike.md` scenario 1 measured a clean `exit 0` at **571 ms** after stdin is
/// closed; `docs/research/orphan-sweep.md` §6 recommends capping the phase at ~1.5 s so a hung
/// session cannot hold the quit. 2 s is that cap plus the store write behind it.
const GRACEFUL_EXIT_GRACE: Duration = Duration::from_secs(2);

/// The routing key for the one Claude instance this phase drives. Multi-account is a map keyed
/// by `InstanceId` and a decision about which account a new session gets; neither exists yet.
pub(crate) const CLAUDE_INSTANCE: &str = "claude-code:default";

/// Everything the commands reach through, once startup succeeded.
pub(crate) struct Ready {
    /// The live session map, the drivers, and the feed batcher.
    pub supervisor: Supervisor,
    /// Held for the life of the process: dropping it joins the writer thread.
    store: Store,
    /// The pid files and the process groups this launch owns. `None` when the pid directory
    /// would not open: the app still runs, it just cannot sweep orphans.
    pub(crate) tracker: Option<Arc<PidTracker>>,
    /// The channel the webview subscribed with, if it has.
    pub sink: Arc<ChannelSink>,
    /// The last `claude` probe. Re-run by `probe_claude`, never cached past a call.
    claude: Mutex<Result<ClaudeStatus, AppError>>,
    /// This launch's id.
    pub run_id: String,
    /// Where the database, the raw logs, the pid files and `frame-stats.ndjson` live.
    pub data_dir: PathBuf,
    /// The reconciliation barrier every [`brigadier_supervisor::loop_::RunSpec`] is handed.
    ///
    /// Level-triggered, so a run started long after reconciliation finished still sees the
    /// answer, and **nothing dispatches before it resolves**
    /// (`docs/research/intent-records.md` §4.1).
    pub barrier: Barrier,
    /// The writing half, taken once by the task `crate::run` spawns.
    ///
    /// Held here rather than passed out of [`build`] so that dropping it without publishing —
    /// which the loop reads as `reconcile_failed` and refuses to dispatch on — can only happen if
    /// the reconciler itself dies, never because a caller forgot to move it.
    reconcile_tx: Mutex<Option<ReconcileSender>>,
    /// Plans the owner stopped **in this launch**.
    ///
    /// The store has no op that writes `plans.status = 'abandoned'` — its only status transition
    /// is `plan_approved` — so this is where a stop is remembered, and it is remembered for one
    /// launch only. See [`crate::views::run_status`], which spends the flag, and
    /// [`crate::commands::stop_run`], which sets it.
    stopped_runs: Mutex<HashSet<String>>,
}

impl std::fmt::Debug for Ready {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ready")
            .field("run_id", &self.run_id)
            .field("data_dir", &self.data_dir)
            .field("store", &self.store.path())
            .finish_non_exhaustive()
    }
}

/// The managed value: pending startup, a working app, or its startup error.
#[derive(Debug)]
pub(crate) struct AppState {
    initialized: OnceLock<Result<Ready, AppError>>,
    closing: Mutex<bool>,
}

impl AppState {
    pub(crate) fn pending() -> Self {
        Self {
            initialized: OnceLock::new(),
            closing: Mutex::new(false),
        }
    }

    /// Publication and shutdown are serialized; no services start after an early quit.
    pub(crate) fn initialize(&self, value: Result<Ready, AppError>) -> bool {
        let closing = self.closing.lock().unwrap_or_else(|e| e.into_inner());
        if *closing {
            return false;
        }
        self.initialized.set(value).is_ok()
    }

    /// Startup failed; every command will say so, with the code startup produced — a data
    /// directory another instance holds answers `data_dir_locked`, not `store`.
    pub(crate) fn failed(error: AppError) -> Self {
        let state = Self::pending();
        state.initialize(Err(error));
        state
    }

    /// The working state, or the startup failure as a command error.
    pub(crate) fn get(&self) -> Result<&Ready, AppError> {
        match self.initialized.get() {
            Some(Ok(ready)) => Ok(ready),
            Some(Err(err)) => Err(err.clone()),
            None => Err(AppError::new("startup_pending", "Brigadier is opening")),
        }
    }

    /// End every live session and kill its process group. Called from **both** exit arms, named
    /// by `reason`, on the main thread.
    ///
    /// Two phases, and the order is the whole point. `Supervisor::shutdown_sync` alone *aborts*
    /// every consumer task, so no `SessionExited` is ever stored, the raw log's `BufWriter` is
    /// dropped mid-buffer, and the next launch settles every one of those rows as `failed`. So
    /// the cooperative path runs first — `end_session` on each session, then a bounded wait for
    /// the consumers to route the real exit and flush their logs — and the synchronous kill is
    /// the backstop under it.
    ///
    /// **Idempotent, and that is load-bearing.** macOS ⌘Q raises `RunEvent::Exit` with no
    /// `RunEvent::ExitRequested` before it (`docs/research/tauri-commands.md` §12), so this has
    /// to run from the `Exit` arm too — and on every path that *did* go through `ExitRequested`
    /// the second call must cost nothing. An empty live map is exactly that test: the first call
    /// leaves it empty, so the second returns before it can spend a second grace period.
    ///
    /// `block_on` is legal here: the `RunEvent` callback is called on the main/event-loop thread,
    /// which is not inside a Tokio runtime, and `tauri-runtime.md` §7 pitfall 4 only forbids it
    /// from inside a task.
    // see docs/research/tauri-commands.md §5 (the callback may block; `block_on` compiles and
    // runs there) and docs/research/orphan-sweep.md §6 (close stdin, clean `exit 0` at 571 ms).
    pub(crate) fn shutdown_sync(&self, reason: &'static str, grace: Duration) {
        *self.closing.lock().unwrap_or_else(|e| e.into_inner()) = true;
        crate::terminal::shutdown();
        let Ok(ready) = self.get() else { return };
        let live = ready.supervisor.live_sessions().len();
        if live == 0 {
            tracing::debug!(reason, "graceful shutdown skipped: nothing live");
            return;
        }
        tracing::info!(reason, live, "graceful shutdown");
        tauri::async_runtime::block_on(ready.supervisor.shutdown_with(GRACEFUL_EXIT_GRACE));
        ready.supervisor.shutdown_sync(grace);
    }

    /// The last pass on `RunEvent::Exit`, after [`AppState::shutdown_sync`] has run there: the
    /// final store flush, and a backstop kill for anything the graceful phase never saw. Nothing
    /// is on screen any more, so this may take its grace.
    ///
    /// The kill normally reports nothing. `PidTracker::shutdown_sync` **drains** its map
    /// (`crates/proc/src/tracker.rs:117`) and the pass before this one already called it through
    /// the supervisor, so this is not a retry of anything. The store flush always runs.
    pub(crate) fn final_sweep(&self, grace: Duration) {
        let Ok(ready) = self.get() else { return };
        if let Some(tracker) = &ready.tracker {
            let outcomes = tracker.shutdown_sync(grace);
            if outcomes.is_empty() {
                tracing::debug!("exit sweep: the tracker had nothing left to kill");
            }
            for outcome in outcomes {
                tracing::info!(
                    session_id = outcome.session_id,
                    pgid = outcome.pgid,
                    action = ?outcome.action,
                    "exit sweep"
                );
            }
        }
        // The writer coalesces ~250 ms of ops; a quit inside that window would otherwise lose
        // the last feed rows and the session's exit row.
        let handle = ready.store.handle().clone();
        if let Err(e) = tauri::async_runtime::block_on(handle.flush()) {
            tracing::warn!(error = %e, "final store flush failed");
        }
    }

    /// The last probe result, cloned.
    pub(crate) fn claude_status(&self) -> Result<ClaudeStatus, AppError> {
        self.get()?.lock_claude().clone()
    }

    /// Re-run `claude --version`, register the driver when it succeeds, and remember either way.
    pub(crate) async fn probe_claude(&self) -> Result<ClaudeStatus, AppError> {
        let ready = self.get()?;
        let result = probe(&ready.supervisor).await;
        *ready.lock_claude() = result.clone();
        result
    }
}

impl Ready {
    fn lock_claude(&self) -> MutexGuard<'_, Result<ClaudeStatus, AppError>> {
        self.claude.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The store's own handle, for the reads the run commands make directly.
    ///
    /// The supervisor exposes no accessor for it, and the run's five commands need reads it does
    /// not wrap — plans, phases, work orders, unknowns and intents.
    pub(crate) fn store(&self) -> &StoreHandle {
        self.store.handle()
    }

    /// Take the reconciler's sender. `None` on every call after the first.
    pub(crate) fn take_reconcile_sender(&self) -> Option<ReconcileSender> {
        self.reconcile_tx.lock().unwrap_or_else(PoisonError::into_inner).take()
    }

    /// Remember that the owner stopped this plan. Idempotent.
    pub(crate) fn mark_stopped(&self, plan_id: &str) {
        self.stopped_runs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(plan_id.to_owned());
    }

    /// Forget a stop, because the owner started that plan again.
    pub(crate) fn clear_stopped(&self, plan_id: &str) {
        self.stopped_runs.lock().unwrap_or_else(PoisonError::into_inner).remove(plan_id);
    }

    /// Whether the owner stopped this plan in this launch.
    pub(crate) fn is_stopped(&self, plan_id: &str) -> bool {
        self.stopped_runs.lock().unwrap_or_else(PoisonError::into_inner).contains(plan_id)
    }
}

/// Probe the `claude` binary and, on success, register the driver under `claude-code`.
async fn probe(supervisor: &Supervisor) -> Result<ClaudeStatus, AppError> {
    match ClaudeDriver::probe(ClaudeDriverConfig::new(CLAUDE_INSTANCE)).await {
        Ok(driver) => {
            let status = ClaudeStatus {
                binary: driver.binary().display().to_string(),
                version: driver.version().to_owned(),
            };
            supervisor.register_driver(Arc::new(driver));
            tracing::info!(binary = %status.binary, version = %status.version, "claude resolved");
            Ok(status)
        }
        Err(e) => {
            let err = AppError::from(e);
            tracing::warn!(code = %err.code, message = %err.message, "claude not usable");
            Err(err)
        }
    }
}

/// Open everything, in the order the research fixed, and hand back the managed value.
///
/// Ordering that matters: the store is opened first because it mints the `run_id` every later
/// step is stamped with; the sweep runs before any child of this launch exists, so a record it
/// finds is unambiguously a previous launch's
/// (`docs/research/orphan-sweep.md` "Recommended design" step 3).
///
/// Must be called inside a Tokio runtime: [`Supervisor::new`] spawns the per-frame flusher.
pub(crate) async fn build(data_dir: PathBuf) -> Result<Ready, AppError> {
    crate::trace::stage("state_build_start");
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| AppError::io(format!("could not create {}: {e}", data_dir.display())))?;
    crate::trace::stage("data_dir_ready");

    // `AppError::from` keeps `Error::Locked` on its own code; the message names the directory,
    // because the remedy is to quit the other window.
    // see docs/research/data-dir-lock.md.
    let store = Store::open(&data_dir).map_err(|e| {
        let mut err = AppError::from(e);
        err.message = format!("could not open the store in {}: {}", data_dir.display(), err.message);
        err
    })?;
    // `Store::open` is the flock, the migrations and the pragmas in one call
    // (`docs/research/data-dir-lock.md`, `crates/store/src/schema.rs`).
    crate::trace::stage("store_open");
    let run_id = store.run_id().to_owned();

    let tracker = open_pid_dir(&data_dir, &run_id);

    let sink = Arc::new(ChannelSink::new());
    let mut config = SupervisorConfig::new(
        store.handle().clone(),
        run_id.clone(),
        data_dir.clone(),
        Arc::clone(&sink) as Arc<dyn brigadier_supervisor::FeedSink>,
    );
    if let Some(tracker) = tracker.clone() {
        config.tracker = Arc::new(TrackerAdapter::new(tracker));
    }
    let supervisor = Supervisor::new(config);
    crate::trace::stage("supervisor_new");

    let claude = probe(&supervisor).await;
    // The `claude --version` child. One of two per launch — the frontend's mount-time
    // `probeClaude()` spawns the other (`perceived-performance.md` §1.4). No session, no API call.
    crate::trace::stage_with(
        "claude_probe",
        if claude.is_ok() { "outcome=ok" } else { "outcome=failed" },
    );

    // Unresolved on purpose: the run barrier is published by the reconciler task `crate::run`
    // spawns, and a run started before that lands waits on it rather than dispatching into a
    // repository nothing has read yet.
    let (reconcile_tx, barrier) = barrier::barrier();

    crate::trace::stage("state_build_end");
    Ok(Ready {
        supervisor,
        store,
        tracker,
        sink,
        claude: Mutex::new(claude),
        run_id,
        data_dir,
        barrier,
        reconcile_tx: Mutex::new(Some(reconcile_tx)),
        stopped_runs: Mutex::new(HashSet::new()),
    })
}

/// Open `<data_dir>/pids`, sweep whatever the last launch left, and build the tracker.
///
/// Returns `None` when the directory will not open — logged, never fatal.
fn open_pid_dir(data_dir: &Path, run_id: &str) -> Option<Arc<PidTracker>> {
    let path = data_dir.join("pids");
    let dir = match PidDir::open(&path) {
        Ok(dir) => dir,
        Err(e) => {
            tracing::error!(
                path = %path.display(),
                error = %e,
                "pid directory unavailable; orphaned children will not be swept"
            );
            crate::trace::stage_with("pid_sweep", "outcome=dir_unavailable swept=0");
            return None;
        }
    };
    // `swept=0` is the interesting value: it says the 400 ms `DEFAULT_GRACE` had nothing to wait
    // on, so the stage's own elapsed time is the directory scan alone. A non-zero count with a
    // ~400 ms stage is the grace firing.
    let mut swept = 0usize;
    for outcome in sweep(&dir, run_id, DEFAULT_GRACE) {
        swept += 1;
        tracing::info!(
            session_id = outcome.session_id,
            pgid = outcome.pgid,
            action = ?outcome.action,
            "startup sweep"
        );
    }
    crate::trace::stage_with("pid_sweep", &format!("outcome=ok swept={swept}"));
    Some(Arc::new(PidTracker::new(dir, run_id)))
}

#[cfg(test)]
mod launch_lifecycle_tests {
    use super::*;

    #[test]
    fn startup_publishes_once_and_preserves_the_original_failure() {
        let state = AppState::pending();
        assert_eq!(state.get().unwrap_err().code, "startup_pending");
        assert!(state.initialize(Err(AppError::new("data_dir_locked", "Already open"))));
        assert!(!state.initialize(Err(AppError::io("Later failure"))));
        assert_eq!(state.get().unwrap_err().code, "data_dir_locked");
    }

    #[test]
    fn quitting_during_startup_prevents_late_publication() {
        let state = AppState::pending();
        state.shutdown_sync("test", Duration::ZERO);
        assert!(!state.initialize(Err(AppError::io("Late result"))));
        assert_eq!(state.get().unwrap_err().code, "startup_pending");
    }
}
