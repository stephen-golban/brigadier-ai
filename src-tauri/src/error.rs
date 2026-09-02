//! The one error shape that crosses the IPC boundary.
//!
//! `{ "code": string, "message": string }`, verbatim from `docs/plans/ipc-contract.md`
//! "Conventions". The closed set of codes lives there; [`brigadier_supervisor::SupervisorError`]
//! already carries most of it in `SupervisorError::code`.
// Tauri's bound on a command's error type is `E: Into<InvokeError>`, satisfied by any
// `E: Serialize` — `std::error::Error` is not required.
// see docs/research/tauri-commands.md §1.5.

use brigadier_core::driver::DriverError;
use brigadier_supervisor::SupervisorError;
use serde::Serialize;

/// What a failed command hands the webview.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct AppError {
    /// Stable machine-readable code from the contract's closed set.
    pub code: String,
    /// Human-readable text; never the only thing the UI branches on.
    pub message: String,
}

impl AppError {
    /// An error with an explicit code.
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_owned(), message: message.into() }
    }

    /// The store (or the startup path that opens it) is unusable.
    pub(crate) fn store(message: impl Into<String>) -> Self {
        Self::new("store", message)
    }

    /// The caller handed us something we will not act on.
    pub(crate) fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new("invalid_argument", message)
    }

    /// Something on the filesystem.
    pub(crate) fn io(message: impl Into<String>) -> Self {
        Self::new("io", message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl From<SupervisorError> for AppError {
    fn from(e: SupervisorError) -> Self {
        // One code table, owned by the supervisor; this layer only reshapes it.
        let code = e.code().to_owned();
        // A driver failure carries its own, finer code — a missing binary must not read as a
        // generic `driver` error, because the UI's remedy for it is completely different.
        if let SupervisorError::Driver(driver) = &e {
            return Self { code: driver_code(driver).to_owned(), message: e.to_string() };
        }
        Self { code, message: e.to_string() }
    }
}

impl From<DriverError> for AppError {
    fn from(e: DriverError) -> Self {
        Self { code: driver_code(&e).to_owned(), message: e.to_string() }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::io(e.to_string())
    }
}

/// The two driver failures the UI has a specific remedy for; everything else is `driver`.
fn driver_code(e: &DriverError) -> &'static str {
    match e {
        DriverError::BinaryNotFound(_) => "claude_not_installed",
        DriverError::VersionTooOld { .. } => "claude_too_old",
        _ => "driver",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn driver_errors_map_to_the_codes_the_ui_branches_on() {
        let e = AppError::from(DriverError::BinaryNotFound("claude".into()));
        assert_eq!(e.code, "claude_not_installed");
        assert!(e.message.contains("claude"));

        let e = AppError::from(DriverError::VersionTooOld {
            found: "2.1.1".into(),
            required: "2.1.257".into(),
        });
        assert_eq!(e.code, "claude_too_old");

        let e = AppError::from(DriverError::Protocol("bad frame".into()));
        assert_eq!(e.code, "driver");
    }

    #[test]
    fn supervisor_errors_keep_their_own_code_but_refine_driver_failures() {
        assert_eq!(AppError::from(SupervisorError::NoSuchSession).code, "no_such_session");
        assert_eq!(AppError::from(SupervisorError::NoSuchProject).code, "no_such_project");
        assert_eq!(
            AppError::from(SupervisorError::InvalidArgument("nope".into())).code,
            "invalid_argument"
        );
        // `SupervisorError::code()` would say `driver` here; the finer code wins.
        assert_eq!(
            AppError::from(SupervisorError::Driver(DriverError::BinaryNotFound("claude".into())))
                .code,
            "claude_not_installed"
        );
    }

    #[test]
    fn the_wire_shape_is_two_string_fields() {
        let json = serde_json::to_string(&AppError::store("closed")).expect("ser");
        assert_eq!(json, r#"{"code":"store","message":"closed"}"#);
    }
}
