//! The outward-command gate's shims, as workers see them.
//!
//! The daemon creates `<data>/gate/bin` empty at start and puts it first on every worker's
//! PATH. It holds a shim (a link to `brigadierd`) only for the always-ask programs the user
//! really has on their login PATH: a missing program must look missing (`command -v` and
//! `which` fail, the shell says "command not found"), exactly as without Brigadier. The
//! folder is brought up to date before a worker starts and before each message it is sent, so
//! a program installed or removed meanwhile is gated, or no longer shown, from then on.

use super::SessionManager;
use crate::Result;

impl SessionManager {
    /// Brings the gate's shims in line with the programs on the login PATH.
    #[cfg(unix)]
    pub(super) async fn sync_gate(&self) -> Result<()> {
        let Some(dir) = self.config.gate_dir.clone() else {
            return Ok(());
        };
        let env = self.runtime.cli_env().clone();
        let exe = self.config.daemon_exe.clone();
        super::blocking(move || {
            sync(&dir, &exe, |program| env.which(program).is_some())
                .map_err(|err| crate::Error::Invalid(format!("updating the command gate: {err}")))
        })
        .await
    }

    /// On Windows there are no shims (see the daemon's gate).
    #[cfg(not(unix))]
    pub(super) async fn sync_gate(&self) -> Result<()> {
        Ok(())
    }
}

/// Links each gated program that `exists` to `exe` in `dir`, and removes the others' links.
/// Links that are already right are left alone, so a worker running one meanwhile never sees
/// it missing.
#[cfg(unix)]
fn sync(
    dir: &std::path::Path,
    exe: &std::path::Path,
    exists: impl Fn(&str) -> bool,
) -> std::io::Result<()> {
    use std::io::ErrorKind;

    let exe = std::fs::canonicalize(exe)?;
    for program in brigadier_providers::policy::gate_programs() {
        let link = dir.join(program);
        let linked = match std::fs::symlink_metadata(&link) {
            Ok(_) => true,
            Err(err) if err.kind() == ErrorKind::NotFound => false,
            Err(err) => return Err(err),
        };
        match (exists(program), linked) {
            (true, false) => match std::os::unix::fs::symlink(&exe, &link) {
                // Another worker's start linked it first.
                Err(err) if err.kind() != ErrorKind::AlreadyExists => return Err(err),
                _ => {}
            },
            (false, true) => match std::fs::remove_file(&link) {
                Err(err) if err.kind() != ErrorKind::NotFound => {
                    // A stale shim only claims the program exists; it still finds nothing.
                    tracing::warn!(program, error = %err, "could not remove a gate shim");
                }
                _ => {}
            },
            _ => {}
        }
    }
    Ok(())
}
