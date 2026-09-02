//! The one error type every [`crate::Supervisor`] method returns.

use brigadier_core::driver::{DriverError, DriverKind};
use brigadier_core::session::{CommandError, RespondError};

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
    /// The caller handed us something we will not act on.
    #[error("{0}")]
    InvalidArgument(String),
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
            Self::InvalidArgument(_) => "invalid_argument",
            Self::Driver(_) => "driver",
            Self::Command(_) => "driver",
            Self::Respond(_) => "no_such_request",
            Self::Store(_) => "store",
            Self::Io(_) => "io",
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
