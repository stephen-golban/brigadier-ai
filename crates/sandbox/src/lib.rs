//! OS abstraction for Brigadier.
//!
//! Everything platform-specific that the core needs sits behind [`Platform`]: data paths and the
//! IPC endpoint, private files, process spawn and control, credential storage, the user's login
//! shell, and the worker sandbox. macOS is fully implemented. Windows and Linux implement
//! everything the daemon needs to run (paths, private files, processes, the instance lock) and
//! report [`Error::Unsupported`] for the worker sandbox, credential storage and login-shell
//! resolution until their platform phase.

mod paths;
mod process;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
pub mod windows;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use paths::{AppPaths, IpcEndpoint};
pub use process::{DetachedChild, InstanceLock, SpawnSpec};

/// Errors raised by the platform layer.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{what} is not supported on {platform} yet")]
    Unsupported {
        what: &'static str,
        platform: &'static str,
    },
    #[error("no home or data directory could be resolved for this user")]
    NoDataDir,
    #[error("credential store error: {0}")]
    Credentials(String),
    #[error("login shell error: {0}")]
    Shell(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// The operating-system services Brigadier builds on.
pub trait Platform: Send + Sync + 'static {
    /// Short platform name for logs and the Inspector (`macos`, `linux`, `windows`).
    fn name(&self) -> &'static str;
    /// Resolved data, log and runtime locations plus the IPC endpoint.
    fn paths(&self) -> &AppPaths;
    /// Directories and files readable only by the current user.
    fn private_fs(&self) -> &dyn PrivateFs;
    /// Process spawn, liveness, termination and timing.
    fn processes(&self) -> &dyn Processes;
    /// OS credential storage (Keychain on macOS).
    fn credentials(&self) -> &dyn CredentialStore;
    /// The user's login shell and the environment it produces.
    fn shell(&self) -> &dyn Shell;
    /// The OS sandbox used to confine worker processes.
    fn sandbox(&self) -> &dyn Sandbox;
}

/// Creates directories and files that only the current user can access.
pub trait PrivateFs: Send + Sync {
    /// Creates `dir` (and parents) and restricts `dir` itself to the current user.
    fn create_private_dir(&self, dir: &Path) -> Result<()>;
    /// Creates a new file that is private from the moment it exists. Fails if it already exists.
    fn create_private_file(&self, path: &Path) -> Result<File>;
}

/// Process control used by the app (to launch the daemon) and the daemon (to manage children).
pub trait Processes: Send + Sync {
    /// Spawns a process fully detached from the caller: its own session / process group, no
    /// controlling terminal, null stdio. It keeps running after the caller exits.
    fn spawn_detached(&self, spec: &SpawnSpec) -> Result<DetachedChild>;
    /// A command for a child the caller talks to over stdio: stdin, stdout and stderr are
    /// piped, and the child leads its own process group (a new process group on Windows), so
    /// [`Processes::kill_tree`] ends it together with everything it started. The caller spawns
    /// it (for example through `tokio::process::Command::from`).
    fn piped_command(&self, spec: &SpawnSpec) -> std::process::Command;
    /// Whether a process with this id currently exists.
    fn is_alive(&self, pid: u32) -> bool;
    /// Asks a process to exit (SIGTERM on Unix). On Windows this terminates it.
    fn terminate(&self, pid: u32) -> Result<()>;
    /// Kills a process and everything it started: its process group and, walking the process
    /// tree, descendants that moved to groups or sessions of their own (CLIs start tool commands
    /// that way). `pid` must still be the caller's process: not yet reaped, or its start time
    /// checked.
    fn kill_tree(&self, pid: u32) -> Result<()>;
    /// Kills what is left in the process group `pid` led, after that process exited and was
    /// reaped. Never signals `pid` itself, which may belong to another process by now.
    fn kill_group(&self, pid: u32) -> Result<()>;
    /// Wall-clock start time of a process, in milliseconds since the Unix epoch.
    fn start_time_ms(&self, pid: u32) -> Result<f64>;
}

/// Generic secrets stored in the OS credential store, namespaced by service.
pub trait CredentialStore: Send + Sync {
    fn set(&self, account: &str, secret: &[u8]) -> Result<()>;
    fn get(&self, account: &str) -> Result<Option<Vec<u8>>>;
    fn delete(&self, account: &str) -> Result<()>;
}

/// The user's login shell.
pub trait Shell: Send + Sync {
    /// Absolute path of the user's login shell.
    fn login_shell(&self) -> Result<PathBuf>;
    /// Environment variables a login shell sets up (PATH and friends), which GUI apps on macOS
    /// do not inherit. This spawns the shell, so call it off the async runtime.
    fn login_environment(&self) -> Result<BTreeMap<OsString, OsString>>;
}

/// What a sandboxed worker may touch.
#[derive(Debug, Clone, Default)]
pub struct SandboxPolicy {
    /// Directories the process may write to (its worktree, its scratch folder).
    pub writable_roots: Vec<PathBuf>,
    /// Whether outbound network access is allowed.
    pub network: bool,
}

/// Confines a process to a [`SandboxPolicy`] by rewriting its spawn spec.
pub trait Sandbox: Send + Sync {
    /// Rewrites `spec` so that the spawned process runs inside the OS sandbox.
    fn confine(&self, spec: SpawnSpec, policy: &SandboxPolicy) -> Result<SpawnSpec>;
}

/// Options that change where Brigadier keeps its data.
#[derive(Debug, Clone, Default)]
pub struct PlatformOptions {
    /// Overrides the data directory (also read from `BRIGADIER_DATA_DIR`).
    pub data_dir: Option<PathBuf>,
}

/// Service name used for credentials and anything else that needs the app identity.
pub const APP_ID: &str = "ai.brigadier.app";

/// Environment variable that overrides the data directory, used by the smoke check and dev runs.
pub const DATA_DIR_ENV: &str = "BRIGADIER_DATA_DIR";

/// Builds the platform implementation for the current OS.
pub fn native(options: PlatformOptions) -> Result<Arc<dyn Platform>> {
    let data_dir = match options.data_dir {
        Some(dir) => dir,
        None => match std::env::var_os(DATA_DIR_ENV) {
            Some(dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => paths::default_data_dir()?,
        },
    };
    let paths = AppPaths::resolve(data_dir)?;

    #[cfg(target_os = "macos")]
    return Ok(Arc::new(macos::MacOs::new(paths)));
    #[cfg(target_os = "linux")]
    return Ok(Arc::new(linux::Linux::new(paths)));
    #[cfg(windows)]
    return Ok(Arc::new(windows::Windows::new(paths)));
}

#[cfg(not(target_os = "macos"))]
fn unsupported<T>(what: &'static str, platform: &'static str) -> Result<T> {
    Err(Error::Unsupported { what, platform })
}
