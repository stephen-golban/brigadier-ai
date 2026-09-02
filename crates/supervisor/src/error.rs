//! The one error type every [`crate::Supervisor`] method returns.

use brigadier_core::driver::{DriverError, DriverKind};
use brigadier_core::session::{CommandError, RespondError};
use brigadier_core::worktree::WorktreeError;

/// Why a supervisor call could not be satisfied.
///
/// The `code` the IPC contract puts on the wire is [`SupervisorError::code`]; the message is the
/// `Display` text.
#[derive(Debug, thiserror::Error)]
pub enum SupervisorError {
    /// No live session by that id. It may have exited, or never existed.
    #[error("no such session")]
    NoSuchSession,
    /// No project by that id.
    #[error("no such project")]
    NoSuchProject,
    /// The session is known but its adapter is gone, so no command can reach it.
    #[error("session is not running")]
    SessionNotRunning,
    /// No parked request by that id in that session.
    #[error("no such request")]
    NoSuchRequest,
    /// No driver has been registered for that kind.
    #[error("no driver registered for {0}")]
    NoDriver(DriverKind),
    /// The session cannot be resumed, and the message says which condition failed: no stored
    /// resume token, still live, or a status that is neither `exited` nor `failed`.
    ///
    /// Liveness is checked as well as status because they answer different questions: the status
    /// says what the store believes, `is_live` says whether a child is on the other end. Two
    /// children on one provider session interleave into one transcript.
    // see docs/research/resume.md §7 and §9 ("two children on one provider session").
    #[error("{0}")]
    NotResumable(String),
    /// The caller handed us something we will not act on.
    #[error("{0}")]
    InvalidArgument(String),
    /// The operation needs the session to be finished, and a child is still on the other end.
    ///
    /// The mirror image of [`SupervisorError::SessionNotRunning`], and a separate code because
    /// the remedies are opposite: this one says "end it first".
    #[error("{0}")]
    SessionLive(String),
    /// A session cannot be started in a project with no commits: `git worktree add … HEAD` would
    /// either fail or, with the base omitted, silently produce an orphan worktree that shares no
    /// history with the project.
    // see docs/research/worktree-git.md §3.
    #[error("{0}")]
    WorktreeUnbornHead(String),
    /// The branch this session's short id maps to is already there, so the start is refused
    /// rather than a second id minted behind the operator's back.
    // see docs/research/worktree-git.md §7.
    #[error("{0}")]
    WorktreeBranchExists(String),
    /// Any other git failure while creating, listing or removing a worktree.
    #[error(transparent)]
    Worktree(WorktreeError),
    /// The driver could not start or resume the session.
    #[error(transparent)]
    Driver(#[from] DriverError),
    /// The command could not be delivered to the adapter.
    #[error(transparent)]
    Command(#[from] CommandError),
    /// The decision could not be applied to the parked request.
    #[error(transparent)]
    Respond(#[from] RespondError),
    /// The store refused the read or the write.
    #[error(transparent)]
    Store(#[from] brigadier_store::Error),
    /// Something on the filesystem.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl SupervisorError {
    /// The stable machine-readable code the IPC contract puts on the wire.
    // see docs/plans/ipc-contract.md "Conventions" for the closed set.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoSuchSession => "no_such_session",
            Self::NoSuchProject => "no_such_project",
            Self::SessionNotRunning => "session_not_running",
            Self::NoSuchRequest => "no_such_request",
            Self::NoDriver(_) => "driver",
            Self::NotResumable(_) => "not_resumable",
            Self::InvalidArgument(_) => "invalid_argument",
            Self::SessionLive(_) => "session_running",
            Self::WorktreeUnbornHead(_) => "worktree_unborn_head",
            Self::WorktreeBranchExists(_) => "worktree_branch_exists",
            Self::Worktree(_) => "worktree",
            Self::Driver(_) => "driver",
            Self::Command(_) => "driver",
            Self::Respond(_) => "no_such_request",
            Self::Store(_) => "store",
            Self::Io(_) => "io",
        }
    }
}

/// Two of git's failures have their own remedy in the UI, so they get their own codes; the rest
/// travel as `worktree` with git's own message.
///
/// `BranchExists` is deliberately **not** collapsed into a retry with a fresh id: a branch under
/// `brigadier/` that we did not just create is either a previous session's work or the operator's
/// own, and minting a second id would hide both.
// see docs/research/worktree-git.md §7 and "Risks" 1.
impl From<WorktreeError> for SupervisorError {
    fn from(e: WorktreeError) -> Self {
        match e {
            WorktreeError::UnbornHead(ref path) => {
                Self::WorktreeUnbornHead(format!("{} has no commits yet; commit something before starting a session", path.display()))
            }
            WorktreeError::BranchExists(ref branch) => Self::WorktreeBranchExists(format!(
                "branch '{branch}' already exists; refusing to start a session on it"
            )),
            other => Self::Worktree(other),
        }
    }
}

/// A command failure means one of two very different things, and the UI acts on the difference.
pub(crate) fn from_command(e: CommandError) -> SupervisorError {
    match e {
        CommandError::Closed => SupervisorError::SessionNotRunning,
        other => SupervisorError::Command(other),
    }
}

/// Likewise for a decision: an id we never parked is a different bug from a stale one.
pub(crate) fn from_respond(e: RespondError) -> SupervisorError {
    match e {
        RespondError::Unknown => SupervisorError::NoSuchRequest,
        other => SupervisorError::Respond(other),
    }
}
