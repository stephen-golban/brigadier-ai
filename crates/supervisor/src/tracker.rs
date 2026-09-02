//! The seam between the supervisor and whatever keeps children from outliving the app.
//!
//! This crate defines the seam and nothing else: the real implementation writes a pid file per
//! session and signals the process group on the way out, and lives in its own crate.
// see docs/research/orphan-sweep.md — a pid file plus a startup sweep; the child is its own
// process group leader (`crates/core/src/claude/process.rs`), so the pid is also the pgid.

use std::path::Path;
use std::time::Duration;

use brigadier_core::event::SessionId;

/// Records the children this launch owns, so a crash does not leave them running.
pub trait ProcessTracker: Send + Sync + 'static {
    /// A session's child is alive under `pid`. `binary` and `cwd` are recorded so a later sweep
    /// can tell one of ours from a recycled pid.
    fn track(&self, session_id: &SessionId, pid: u32, binary: &Path, cwd: &Path);

    /// The child is gone; forget it. Idempotent.
    fn untrack(&self, session_id: &SessionId);

    /// Terminate everything still tracked, giving each `grace` before escalating.
    ///
    /// **Synchronous and callable off a Tokio runtime**, because the caller is an application
    /// exit handler on the UI thread and there may be no runtime left to block on.
    fn shutdown_sync(&self, grace: Duration);
}

/// A tracker that records nothing and kills nothing.
///
/// The default, and the right one for a replay session that has no process behind it.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopTracker;

impl ProcessTracker for NoopTracker {
    fn track(&self, session_id: &SessionId, pid: u32, _binary: &Path, _cwd: &Path) {
        tracing::debug!(session_id = session_id.as_str(), pid, "untracked child (noop tracker)");
    }

    fn untrack(&self, _session_id: &SessionId) {}

    fn shutdown_sync(&self, _grace: Duration) {}
}
