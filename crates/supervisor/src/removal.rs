//! Deleting a session, and deleting a project with every session under it.
//!
//! `docs/vision.md` §8 is the specification and it is short: *"Deleting a session removes its
//! rows, its feed log and its worktree — and because every phase commits to git, deleting a
//! session destroys nothing that matters. The work is in the repository; only the narration
//! goes."*
//!
//! Four artefacts exist per session and each has an owner here:
//!
//! | artefact | removed by |
//! | --- | --- |
//! | store rows — `sessions`, `feed`, `approvals`, `intents` | `brigadier_store::delete`, one transaction, cascade-checked |
//! | `<data_dir>/raw/<id>.ndjson` and its rotations | `removal::remove_logs` |
//! | `<data_dir>/pids/<id>.json` | the [`crate::ProcessTracker`] seam's `untrack` |
//! | the git worktree | [`crate::Supervisor::cleanup_worktree`], reused verbatim |
//!
//! And one that is **not** removed, deliberately: the session's branch. No path in this crate
//! deletes a branch, this one included. The checkout is reconstructible; the branch is the only
//! copy of whatever the agent committed, so a delete that took it would be the one way this
//! operation could destroy something.
//!
//! The provider's transcript directory, `~/.claude/projects/<mangled cwd>/`, is not touched
//! either — Hard rule 8 of `docs/research/worktree-cleanup.md`: it is keyed on a path we chose
//! inside a directory we do not own, and 3.0 GB of it on the owner's machine predates brigadier.
// see docs/vision.md §8 and §9, docs/research/worktree-cleanup.md "Hard rules".

use std::path::Path;

use brigadier_core::event::SessionId;
use brigadier_store::Deleted;
use serde::Serialize;

use crate::worktree::WorktreeCleanup;

/// What a `delete_session` did, or refused to do.
///
/// `removed: false` is a refusal that **touched no rows**: `worktree` carries the
/// [`crate::WorktreeCleanup`] that said no, and its `blocked` field is the same closed set the
/// `cleanup_worktree` command already returns, so the UI needs no second vocabulary for this.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SessionDeletion {
    /// The session that was asked about.
    pub session_id: String,
    /// Whether the rows are gone. `false` means nothing was deleted at all.
    pub removed: bool,
    /// Rows removed, by table. All zero on a refusal.
    pub rows: Deleted,
    /// The worktree half, verbatim. `None` when the session had no worktree — it ran in the
    /// project root, which is never removed.
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

/// What a `delete_project` did, or refused to do.
///
/// **The database half is all-or-nothing and the worktree half is not**, and the report says so
/// rather than smoothing it over. Worktrees are removed one session at a time before any row is
/// touched, and the first refusal stops the pass: `removed` is then `false`, `rows` is all
/// zeroes, and `worktrees` lists exactly what happened to each session up to and including the
/// one that refused. Nothing is lost by that — every branch survives — but a checkout that went
/// before the refusal does not come back, so the list is the truth the UI has to show.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProjectDeletion {
    /// The project that was asked about.
    pub project_id: String,
    /// Whether the project row and everything under it are gone.
    pub removed: bool,
    /// Rows removed, by table. All zero on a refusal.
    pub rows: Deleted,
    /// One entry per session that had a worktree, in the order they were attempted.
    pub worktrees: Vec<SessionWorktree>,
    /// Raw NDJSON files removed across every session of the project.
    pub logs_removed: u32,
    /// Gate-log directories removed under `<data_dir>/gates/<phase_id>/`.
    pub gate_logs_removed: u32,
    /// Whether `<project root>/.brigadier/` was removed. It is removed **only if it is empty**,
    /// which is what `remove_dir` means: anything the operator left in there survives.
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

/// Remove `<project root>/.brigadier/` **if nothing is left in it**.
///
/// `remove_dir`, never `remove_dir_all`: an empty directory is tidiness, and a non-empty one is
/// somebody's files. `git worktree remove` leaves the `worktrees/` parent behind after the last
/// checkout goes, which is the only case this is here for, so the inner directory is tried first
/// and the outer one only succeeds if that left it empty.
///
/// The exclude line in `$GIT_COMMON_DIR/info/exclude` is **left alone**. It is one line naming a
/// directory that may come back the next time a session starts, and rewriting the operator's
/// exclude file to remove it would be a write to their repository for no gain.
pub(crate) fn remove_brigadier_dir(project_root: &Path) -> bool {
    let brigadier = project_root.join(".brigadier");
    // Not an error and not logged: a project with live sessions elsewhere, or one that was never
    // a git repository, has nothing to tidy.
    let _ = std::fs::remove_dir(brigadier.join("worktrees"));
    std::fs::remove_dir(&brigadier).is_ok()
}
