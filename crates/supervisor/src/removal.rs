//! Removal of Brigadier history and app-owned logs. Repository files, worktrees,
//! branches and provider transcripts are preserved. Worktree cleanup is a separate action.

use std::path::Path;

use brigadier_core::event::SessionId;
use brigadier_store::Deleted;
use serde::Serialize;

use crate::worktree::WorktreeCleanup;

/// Result of removing Brigadier session history.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SessionDeletion {
    /// The session that was asked about.
    pub session_id: String,
    /// Whether the rows are gone. `false` means nothing was deleted at all.
    pub removed: bool,
    /// Rows removed, by table. All zero on a refusal.
    pub rows: Deleted,
    /// Always `None`: deletion preserves worktrees. Kept for IPC compatibility.
    pub worktree: Option<WorktreeCleanup>,
    /// Raw NDJSON files removed from `<data_dir>/raw/`, live file and rotations counted alike.
    pub logs_removed: u32,
    /// The branch that still holds this session's commits, when it had one.
    ///
    /// Present on a refusal *and* on a success, because it is the only thing left that names
    /// where the work went once the row is gone.
    pub branch: Option<String>,
}

/// One session's worktree outcome inside a project delete.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SessionWorktree {
    /// Which session's worktree this was.
    pub session_id: String,
    /// What [`crate::Supervisor::cleanup_worktree`] answered for it.
    pub cleanup: WorktreeCleanup,
}

/// Result of removing a project from Brigadier. Local files are preserved.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProjectDeletion {
    /// The project that was asked about.
    pub project_id: String,
    /// Whether the project row and everything under it are gone.
    pub removed: bool,
    /// Rows removed, by table. All zero on a refusal.
    pub rows: Deleted,
    /// Empty: sidebar removal does not clean worktrees.
    pub worktrees: Vec<SessionWorktree>,
    /// Raw NDJSON files removed across every session of the project.
    pub logs_removed: u32,
    /// Gate-log directories removed under `<data_dir>/gates/<phase_id>/`.
    pub gate_logs_removed: u32,
    /// Always false: no directory inside the repository is removed.
    pub brigadier_dir_removed: bool,
}

/// Remove one session's raw NDJSON log and every rotation of it. Returns how many files went.
///
/// Best effort by design: a log that will not unlink is a `tracing::warn` and a smaller number,
/// never a failed delete. The rows are the thing the operator asked to be rid of, and refusing
/// the whole operation because a gzipped rotation is read-only would leave the session in the
/// sidebar forever.
pub(crate) fn remove_logs(data_dir: &Path, session_id: &SessionId) -> u32 {
    let mut gone = 0;
    for path in brigadier_store::ndjson::log_files(data_dir, session_id) {
        match std::fs::remove_file(&path) {
            Ok(()) => gone += 1,
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "could not remove a raw log")
            }
        }
    }
    gone
}

/// Remove one phase's gate logs, `<data_dir>/gates/<phase_id>/`. Returns whether a directory went.
///
/// Same best-effort rule as `remove_logs`, and the same reason. `phase_id` is used as one path
/// segment and nothing else; a phase id is a uuid minted by this crate.
// see crate::loop_::green::gate_log_path, which is where these files are written.
pub(crate) fn remove_gate_logs(data_dir: &Path, phase_id: &str) -> bool {
    let dir = data_dir.join("gates").join(phase_id);
    if !dir.exists() {
        return false;
    }
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!(path = %dir.display(), error = %e, "could not remove a phase's gate logs");
            false
        }
    }
}
