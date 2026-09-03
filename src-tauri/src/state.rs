//! The app's managed state, and the startup that builds it.
//!
//! One managed type, one value, never removed — Tauri's state map is keyed by `TypeId` and
//! `unmanage` is deprecated as unsafe (`docs/research/tauri-commands.md` §4).
//!
//! The whole of `setup` is fallible and **none of it may `?` out**: `Builder::setup` returning
//! `Err` panics the process with no graceful path (`tauri-commands.md` §4.1). A read-only home
//! directory must produce a window that says so, not a crash. So [`AppState`] is two-valued:
//! either everything opened, or a single startup message that every command returns as
//! `AppError { code: "store", .. }`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use brigadier_core::claude::{ClaudeDriver, ClaudeDriverConfig};
use brigadier_proc::{sweep, PidDir, PidTracker, DEFAULT_GRACE};
use brigadier_store::Store;
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
    tracker: Option<Arc<PidTracker>>,
    /// The channel the webview subscribed with, if it has.
    pub sink: Arc<ChannelSink>,
    /// The last `claude` probe. Re-run by `probe_claude`, never cached past a call.
    claude: Mutex<Result<ClaudeStatus, AppError>>,
    /// This launch's id.
    pub run_id: String,
    /// Where the database, the raw logs, the pid files and `frame-stats.ndjson` live.
    pub data_dir: PathBuf,
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

/// The managed value: a working app, or the reason there is not one.
#[derive(Debug)]
pub(crate) struct AppState {
    ready: Option<Ready>,
    startup_error: Option<AppError>,
}

impl AppState {
    /// A working app.
    pub(crate) fn ready(ready: Ready) -> Self {
        Self { ready: Some(ready), startup_error: None }
    }

    /// Startup failed; every command will say so, with the code startup produced — a data
    /// directory another instance holds answers `data_dir_locked`, not `store`.
    pub(crate) fn failed(error: AppError) -> Self {
        Self { ready: None, startup_error: Some(error) }
    }

    /// The working state, or the startup failure as a command error.
    pub(crate) fn get(&self) -> Result<&Ready, AppError> {
        match (&self.ready, &self.startup_error) {
            (Some(ready), _) => Ok(ready),
            (None, Some(err)) => Err(err.clone()),
            // Unreachable by construction; still not worth a panic in a command.
            (None, None) => Err(AppError::store("app state was never initialized")),
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
        let Some(ready) = &self.ready else { return };
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
        let Some(ready) = &self.ready else { return };
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

    crate::trace::stage("state_build_end");
    Ok(Ready { supervisor, store, tracker, sink, claude: Mutex::new(claude), run_id, data_dir })
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

