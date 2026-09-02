//! Adapts `brigadier_proc::PidTracker` to the supervisor's [`ProcessTracker`] seam.
//!
//! The supervisor speaks `SessionId`; the proc crate deliberately speaks `&str` so it depends on
//! nothing. This newtype is the whole join, plus the logging of results neither side wants to
//! own: `track` returns an `io::Result` the supervisor's trait cannot carry, and `shutdown_sync`
//! returns kill outcomes that belong in the log, not in a return value on the UI thread.
// see docs/research/orphan-sweep.md "Recommended design" steps 2 and 4.

use std::path::Path;
use std::sync::Arc;
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
