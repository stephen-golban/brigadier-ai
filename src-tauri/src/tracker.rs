//! Adapts `brigadier_proc::PidTracker` to the supervisor's [`ProcessTracker`] seam.
//!
//! The supervisor speaks `SessionId`; the proc crate deliberately speaks `&str` so it depends on
//! nothing. This newtype is the whole join, plus the logging of results neither side wants to
//! own: `track` returns an `io::Result` the supervisor's trait cannot carry, and `shutdown_sync`
//! returns kill outcomes that belong in the log, not in a return value on the UI thread.
// see docs/research/orphan-sweep.md "Recommended design" steps 2 and 4.

use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use brigadier_core::event::SessionId;
use brigadier_proc::PidTracker;
use brigadier_supervisor::ProcessTracker;

/// The supervisor's view of the real pid tracker.
#[derive(Debug)]
pub(crate) struct TrackerAdapter(Arc<PidTracker>);

impl TrackerAdapter {
    /// Wrap the tracker the app owns.
    pub(crate) fn new(tracker: Arc<PidTracker>) -> Self {
        Self(tracker)
    }
}

impl ProcessTracker for TrackerAdapter {
    fn track(&self, session_id: &SessionId, pid: u32, binary: &Path, cwd: &Path) {
        // A pid file we could not write means this child survives a force-quit unrecorded. That
        // is bad, and it is still not a reason to fail the session the operator just started.
        if let Err(e) = self.0.track(session_id.as_str(), pid, binary, cwd) {
            tracing::warn!(
                session_id = session_id.as_str(),
                pid,
                error = %e,
                "could not write pid record; this child will not be swept after a crash"
            );
        } else {
            tracing::debug!(session_id = session_id.as_str(), pid, "tracked child");
        }
    }

    fn untrack(&self, session_id: &SessionId) {
        self.0.untrack(session_id.as_str());
    }

    fn shutdown_sync(&self, grace: Duration) {
        for outcome in self.0.shutdown_sync(grace) {
            tracing::info!(
                session_id = outcome.session_id,
                pgid = outcome.pgid,
                action = ?outcome.action,
                "shutdown kill"
            );
        }
    }
}

/// The app's one tracker, for the children that are spawned outside the supervisor.
///
/// Terminal shells are spawned from a blocking thread with no `AppState` in reach
/// (`crate::terminal::spawn_profile`), and they have the same problem a session's child has: own
/// process group, survives a force-quit, invisible to the next launch's sweep unless a pid record
/// was written (`docs/research/lifecycle-bounds-audit-2026-09-11.md` §3 gap 2).
static AMBIENT: OnceLock<Arc<PidTracker>> = OnceLock::new();

/// Publish the tracker for those spawners. Called once, from `lib.rs`'s setup task once the
/// state is ready — so only a real launch publishes one; a second call is ignored rather than
/// fatal.
pub(crate) fn install(tracker: Arc<PidTracker>) {
    let _ = AMBIENT.set(tracker);
}

/// Record a child spawned outside the supervisor. `id` must be unique for this launch and usable
/// as a filename; no-op when the pid directory would not open, which is already logged there.
///
/// A failure to write is logged and swallowed for the same reason [`TrackerAdapter::track`]
/// swallows it: an unrecorded child is bad, and it is not a reason to fail the thing the operator
/// just opened.
pub(crate) fn track_child(id: &str, pid: u32, binary: &Path, cwd: &Path) {
    let Some(tracker) = AMBIENT.get() else { return };
    if let Err(e) = tracker.track(id, pid, binary, cwd) {
        tracing::warn!(id, pid, error = %e, "could not write pid record; this child will not be swept after a crash");
    }
}

/// Forget one. Idempotent, and safe to call for an id that was never tracked.
pub(crate) fn untrack_child(id: &str) {
    if let Some(tracker) = AMBIENT.get() {
        tracker.untrack(id);
    }
}

/// Where the installed tracker writes, for the tests that assert a record exists.
#[cfg(test)]
pub(crate) fn ambient_dir() -> Option<std::path::PathBuf> {
    AMBIENT.get().map(|t| t.dir().path().to_path_buf())
}
