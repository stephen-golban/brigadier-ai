//! Who holds a workspace lock, and how the loser finds out.
//!
//! `flock(2)` — what `std::fs::File::try_lock` is on Unix — has no query interface: it answers
//! `EWOULDBLOCK` and nothing about the holder, and it does not interact with the `fcntl` record
//! locks whose `F_GETLK` would at least have named a pid. So the holder publishes its own identity
//! into every lock file it holds *exclusively*, and the loser reads it back on refusal.
//! see docs/research/workspace-lock-holder-identity-2026-09-11.md §1.
use super::*;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

/// Which operation a lease belongs to; also the noun the user reads in a refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaseKind {
    /// An AI turn that owns the workspace outright.
    Turn,
    /// A rewind/restore transaction resuming its recorded operation.
    Restore,
    /// A turn's writer epoch, which tolerates the user's own shells.
    Writer,
    /// An interactive shell the user opened on the workspace.
    Terminal,
}
impl LeaseKind {
    /// The word the user sees. A writer lease is still an AI turn as far as the user is concerned.
    pub fn noun(self) -> &'static str {
        match self {
            Self::Turn | Self::Writer => "turn",
            Self::Restore => "restore",
            Self::Terminal => "terminal",
        }
    }
    /// How this holder relates to its directory, so the sentence reads naturally either way.
    fn preposition(self) -> &'static str {
        match self {
            Self::Terminal => "opened on",
            _ => "running on",
        }
    }
    /// What the user can actually do about a holder of this kind.
    fn remedy(self) -> &'static str {
        match self {
            Self::Terminal => "close that terminal or start this session in a worktree",
            Self::Turn | Self::Writer => {
                "wait for that turn to finish or start this session in a worktree"
            }
            Self::Restore => "wait for that restore to finish, or resolve it from session history",
        }
    }
}
impl std::fmt::Display for LeaseKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.noun())
    }
}

/// The identity a lease writes into each lock file it holds exclusively.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockOwner {
    /// What the holder is doing.
    pub kind: LeaseKind,
    /// Session or terminal id, when the call site had one to give.
    #[serde(default)]
    pub id: Option<String>,
    /// The holder's own canonical root, which is not always the refused workspace.
    pub root: PathBuf,
    /// The holder's process. Checked for liveness before it is reported as a holder.
    pub pid: u32,
    /// Unix seconds at acquisition; kept for a future start-time check against pid reuse.
    pub started_at: u64,
}

/// A refused acquisition, with whatever could be proven about the holder.
///
/// `holder` is `None` when the lock file carried no readable record; `holder_live` is false when
/// the record names a process that is gone, which is reported as stale rather than as a holder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LockConflict {
    /// What the refused caller was trying to take.
    pub kind: LeaseKind,
    /// The refused caller's canonical workspace root.
    pub root: PathBuf,
    /// The lock file that refused it.
    pub lock_path: PathBuf,
    /// The holder, when one could be named.
    pub holder: Option<LockOwner>,
    /// Whether `holder`'s process is still running.
    pub holder_live: bool,
}
impl std::fmt::Display for LockConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (root, lock) = (self.root.display(), self.lock_path.display());
        // The unidentified cases keep the original wording, because it is the one sentence the
        // owner and the UI have seen before; only the identified case gets a new shape.
        let vague = "overlaps another running turn, terminal, or restore operation";
        let fallback = "close other brigadier terminals and windows on this workspace, or start this session in a worktree";
        match (&self.holder, self.holder_live) {
            (Some(held), true) => write!(
                f,
                "Workspace {root} is held by {} (pid {}) {} {}; {} (lock file {lock})",
                label(held.kind, held.id.as_deref()),
                held.pid,
                held.kind.preposition(),
                held.root.display(),
                held.kind.remedy(),
            ),
            (Some(held), false) => write!(
                f,
                "Workspace {root} {vague}. The owner recorded in {lock} was {} (pid {}), which is no longer running, so the live holder is unidentified; {fallback}",
                label(held.kind, held.id.as_deref()),
                held.pid,
            ),
            (None, _) => write!(f, "Workspace {root} {vague}, and {lock} carries no owner record; {fallback}"),
        }
    }
}

/// `terminal terminal-3` reads badly, so an id that already repeats its noun is trimmed.
fn label(kind: LeaseKind, id: Option<&str>) -> String {
    let noun = kind.noun();
    match id {
        Some(id) => {
            let short = id
                .strip_prefix(noun)
                .map(|rest| rest.trim_start_matches(['-', '_', ' ']))
                .filter(|rest| !rest.is_empty())
                .unwrap_or(id);
            format!("{noun} {short}")
        }
        None => format!("a {noun}"),
    }
}

/// Unix seconds, monotonicity not required: this is a label, never a deadline.
pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Whether a recorded pid is still a process. `EPERM` means alive and owned by someone else.
pub(crate) fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // pid 0 is "every process in the group" and pid 1 is never a brigadier lease; treating
        // either as a holder would turn a corrupt record into a permanent false positive.
        if pid <= 1 || pid > i32::MAX as u32 {
            return false;
        }
        !matches!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None),
            Err(nix::errno::Errno::ESRCH)
        )
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// Publish this lease's identity into a file it holds exclusively. Advisory: a failure to write
/// costs diagnosability, never correctness, so callers ignore it.
pub(crate) fn publish(file: &File, owner: &LockOwner) -> Result<()> {
    let bytes = serde_json::to_vec(owner)?;
    file.set_len(0)?;
    let mut handle = file;
    handle.seek(SeekFrom::Start(0))?;
    handle.write_all(&bytes)?;
    Ok(())
}

/// Drop this lease's identity before releasing the lock, so the next reader sees nothing rather
/// than a record for a holder that has gone.
pub(crate) fn retract(file: &File) {
    let _ = file.set_len(0);
}

/// Read a record back. Anything unreadable, oversized or half-written is "no record", never a
/// guess: a torn read is possible because the holder writes after it locks.
pub(crate) fn read(path: &Path) -> Option<LockOwner> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).ok()?;
    if file.metadata().ok()?.len() > 64 * 1024 {
        return None;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    serde_json::from_slice(&bytes).ok()
}
