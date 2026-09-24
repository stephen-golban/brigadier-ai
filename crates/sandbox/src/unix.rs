//! Pieces shared by macOS and Linux.

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::Path;

use nix::sys::signal::{self, Signal};
use nix::unistd::{Pid, Uid};

use crate::{DetachedChild, Error, PrivateFs, Result, SpawnSpec};

pub(crate) struct UnixPrivateFs;

impl PrivateFs for UnixPrivateFs {
    fn create_private_dir(&self, dir: &Path) -> Result<()> {
        if let Some(parent) = dir.parent() {
            fs::create_dir_all(parent)?;
        }
        match DirBuilder::new().mode(0o700).create(dir) {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
            Err(err) => return Err(err.into()),
        }
        // It already existed: it must be a real directory we own, and nobody else may enter it.
        let meta = fs::symlink_metadata(dir)?;
        if !meta.is_dir() || meta.uid() != Uid::current().as_raw() {
            return Err(Error::Io(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "{} is not a directory owned by the current user",
                    dir.display()
                ),
            )));
        }
        if meta.permissions().mode() & 0o077 != 0 {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    fn create_private_file(&self, path: &Path) -> Result<File> {
        Ok(OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?)
    }
}

pub(crate) fn spawn_detached(spec: &SpawnSpec) -> Result<DetachedChild> {
    let mut command = spec.command();
    // SAFETY: `setsid` is async-signal-safe and the closure touches no other state, which is the
    // contract for code running between fork and exec.
    #[allow(unsafe_code)]
    unsafe {
        command.pre_exec(|| nix::unistd::setsid().map(drop).map_err(io::Error::from));
    }
    Ok(DetachedChild::new(command.spawn()?))
}

pub(crate) fn is_alive(pid: u32) -> bool {
    let Some(pid) = to_pid(pid) else {
        return false;
    };
    match signal::kill(pid, None) {
        Ok(()) => true,
        // It exists but belongs to someone else.
        Err(nix::errno::Errno::EPERM) => true,
        Err(_) => false,
    }
}

pub(crate) fn terminate(pid: u32) -> Result<()> {
    let pid = to_pid(pid).ok_or_else(invalid_pid)?;
    signal::kill(pid, Signal::SIGTERM).map_err(io::Error::from)?;
    Ok(())
}

pub(crate) fn kill_tree(pid: u32) -> Result<()> {
    let pid = to_pid(pid).ok_or_else(invalid_pid)?;
    // Detached children lead their own process group, so the group id is their pid.
    match signal::killpg(pid, Signal::SIGKILL) {
        Ok(()) => Ok(()),
        Err(nix::errno::Errno::ESRCH) => {
            signal::kill(pid, Signal::SIGKILL).map_err(io::Error::from)?;
            Ok(())
        }
        Err(err) => Err(io::Error::from(err).into()),
    }
}

fn to_pid(pid: u32) -> Option<Pid> {
    i32::try_from(pid)
        .ok()
        .filter(|pid| *pid > 0)
        .map(Pid::from_raw)
}

fn invalid_pid() -> Error {
    Error::Io(io::Error::new(io::ErrorKind::InvalidInput, "invalid pid"))
}
