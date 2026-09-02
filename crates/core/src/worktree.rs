//! One git worktree per session, driven by shelling out to `git`.
//!
//! No global state: every call takes the `git` binary and the repository explicitly, so N
//! sessions can manage N worktrees concurrently without a registry.
// see docs/research/tauri-runtime.md §6 — `gix` 0.87.1 has no worktree add/remove/prune at all,
// and `git2` 0.21.0 covers add but not remove and drags libgit2 in; the CLI's porcelain listing
// is contractually stable ("will remain stable across Git versions and regardless of user
// configuration"), so the CLI wins.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};

use tokio::process::Command;

/// What to create: a new branch checked out at a new path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorktreeSpec {
    /// The main worktree, or any path inside the repository.
    pub repo: PathBuf,
    /// Where the new worktree is created. Must not exist, or must be an empty directory.
    pub path: PathBuf,
    /// Branch to create and check out.
    pub branch: String,
    /// Ref the branch starts at, e.g. `main` or `HEAD`.
    pub base: String,
}

/// One row of `git worktree list --porcelain`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Worktree {
    /// Absolute path as git reports it (already canonicalised by git).
    pub path: PathBuf,
    /// Checked-out branch, short name. `None` when the head is detached or the repo is bare.
    pub branch: Option<String>,
    /// The 40-hex commit at `HEAD`. Empty for a bare main worktree, which has no `HEAD` line.
    pub head: String,
    /// True for the first row, which git always reports as the main worktree.
    pub is_main: bool,
    /// `Some(reason)` when git flagged the entry prunable; `Some("")` when it gave no reason.
    pub prunable: Option<String>,
    /// `Some(reason)` when the worktree is locked; `Some("")` when locked without a reason.
    pub locked: Option<String>,
}

/// Why a worktree operation failed.
#[derive(Debug, thiserror::Error)]
pub enum WorktreeError {
    /// No `git` executable on `PATH`, or the path handed in does not exist.
    #[error("git was not found")]
    GitNotFound,
    /// `add -b` refused because the branch is already there.
    #[error("a branch named '{0}' already exists")]
    BranchExists(String),
    /// `add` refused because the target path already exists and is not empty.
    #[error("{} already exists", .0.display())]
    PathExists(PathBuf),
    /// `add` refused because a registered-but-missing worktree still owns the path.
    #[error("{} is registered but missing ({reason}); prune or remove it first", .path.display())]
    PrunableEntryBlocks {
        /// Path git is still holding.
        path: PathBuf,
        /// Reason git reports in the porcelain listing.
        reason: String,
    },
    /// The path is not a registered worktree of this repository.
    #[error("{} is not a working tree", .0.display())]
    NotAWorktree(PathBuf),
    /// `remove` without `force` on a worktree with modified or untracked files.
    #[error("{} contains modified or untracked files", .0.display())]
    Dirty(PathBuf),
    /// Any other non-zero exit.
    #[error("git {} exited with {code:?}: {stderr}", args.join(" "))]
    Git {
        /// Arguments passed to git, lossily decoded.
        args: Vec<String>,
        /// Exit code, `None` when the process was signalled.
        code: Option<i32>,
        /// Trimmed stderr.
        stderr: String,
    },
    /// The process could not be run at all.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[cfg(windows)]
const GIT_BIN: &str = "git.exe";
#[cfg(not(windows))]
const GIT_BIN: &str = "git";

/// First `git` on `PATH`, or `None`. A `which` walk, so the crate needs no extra dependency.
pub fn resolve_git() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(GIT_BIN))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// `git --version`, trimmed. The cheapest liveness check on the binary.
pub async fn git_version(git: &Path) -> Result<String, WorktreeError> {
    let out = stdout(git, &[osarg("--version")]).await?;
    Ok(String::from_utf8_lossy(&out).trim().to_owned())
}

/// `git worktree add -b <branch> <path> <base>`, then the created row from a fresh listing.
///
/// On failure nothing is cleaned up. git 2.50.1 creates the branch before it validates the path,
/// so a [`WorktreeError::PathExists`] or [`WorktreeError::PrunableEntryBlocks`] leaves the branch
/// behind; the caller decides whether to [`delete_branch`] it.
pub async fn add(git: &Path, spec: &WorktreeSpec) -> Result<Worktree, WorktreeError> {
    let args = vec![
        osarg("-C"),
        spec.repo.as_os_str().to_os_string(),
        osarg("worktree"),
        osarg("add"),
        osarg("-b"),
        osarg(&spec.branch),
        spec.path.as_os_str().to_os_string(),
        osarg(&spec.base),
    ];
    match stdout(git, &args).await {
        Ok(_) => {}
        // git names the blocking entry but not why it is prunable; the listing has the reason.
        Err(WorktreeError::PrunableEntryBlocks { path, reason }) if reason.is_empty() => {
            let reason = prunable_reason(git, &spec.repo, &path)
                .await
                .unwrap_or_else(|| "missing but already registered worktree".to_owned());
            return Err(WorktreeError::PrunableEntryBlocks { path, reason });
        }
        Err(other) => return Err(other),
    }
    // The branch is new, so exactly one row carries it; that row has git's own idea of the path.
    list(git, &spec.repo)
        .await?
        .into_iter()
        .find(|w| w.branch.as_deref() == Some(spec.branch.as_str()))
        .ok_or_else(|| WorktreeError::NotAWorktree(spec.path.clone()))
}

/// `git worktree list --porcelain -z`, parsed.
pub async fn list(git: &Path, repo: &Path) -> Result<Vec<Worktree>, WorktreeError> {
    // see docs/research/tauri-runtime.md §6 — without `-z` a lock reason is quoted per
    // `core.quotePath` and a path containing a newline is unparseable.
    let args = vec![
        osarg("-C"),
        repo.as_os_str().to_os_string(),
        osarg("worktree"),
        osarg("list"),
        osarg("--porcelain"),
        osarg("-z"),
    ];
    Ok(parse_porcelain(&stdout(git, &args).await?))
}

/// `git worktree remove [--force] <path>`. Does not delete the branch.
pub async fn remove(
    git: &Path,
    repo: &Path,
    path: &Path,
    force: bool,
) -> Result<(), WorktreeError> {
    let mut args = vec![
        osarg("-C"),
        repo.as_os_str().to_os_string(),
        osarg("worktree"),
        osarg("remove"),
    ];
    if force {
        args.push(osarg("--force"));
    }
    args.push(path.as_os_str().to_os_string());
    stdout(git, &args).await.map(drop)
}

/// `git worktree prune`: forget entries whose directory is gone. Does not delete branches.
pub async fn prune(git: &Path, repo: &Path) -> Result<(), WorktreeError> {
    let args = vec![
        osarg("-C"),
        repo.as_os_str().to_os_string(),
        osarg("worktree"),
        osarg("prune"),
    ];
    stdout(git, &args).await.map(drop)
}

/// `git branch -d|-D <branch>`.
// see docs/research/tauri-runtime.md §6 — neither `remove` nor `prune` deletes the branch, so
// session teardown has to do it here or leak one branch per session.
pub async fn delete_branch(
    git: &Path,
    repo: &Path,
    branch: &str,
    force: bool,
) -> Result<(), WorktreeError> {
    let args = vec![
        osarg("-C"),
        repo.as_os_str().to_os_string(),
        osarg("branch"),
        osarg(if force { "-D" } else { "-d" }),
        osarg(branch),
    ];
    stdout(git, &args).await.map(drop)
}

fn osarg(s: impl AsRef<OsStr>) -> OsString {
    s.as_ref().to_os_string()
}

async fn stdout(git: &Path, args: &[OsString]) -> Result<Vec<u8>, WorktreeError> {
    let out = spawn(git, args).await?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(classify(args, &out))
    }
}

async fn spawn(git: &Path, args: &[OsString]) -> Result<Output, WorktreeError> {
    let mut cmd = Command::new(git);
    cmd.args(args)
        // Never a shell, and never an interactive credential prompt that would hang the harness.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match cmd.output().await {
        Ok(out) => Ok(out),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(WorktreeError::GitNotFound),
        Err(e) => Err(WorktreeError::Io(e)),
    }
}

/// Map git's stderr onto the typed variants.
///
/// Every substring below was observed on **git 2.50.1 (Apple Git-155)** by the tests in
/// `crates/core/tests/worktree.rs`; the porcelain listing is contractually stable but these
/// messages are not, so an unmatched failure degrades to [`WorktreeError::Git`] rather than
/// being guessed at.
fn classify(args: &[OsString], out: &Output) -> WorktreeError {
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();

    // "fatal: a branch named 'feat' already exists" — checked first because it also contains
    // the PathExists substring.
    if stderr.contains("already exists") {
        if let Some(branch) = quoted_after(&stderr, "a branch named ") {
            return WorktreeError::BranchExists(branch);
        }
    }
    // "fatal: '<path>' is a missing but already registered worktree;\nuse 'add -f' to override…"
    if let Some(path) = quoted_before(&stderr, " is a missing but already registered worktree") {
        return WorktreeError::PrunableEntryBlocks { path, reason: String::new() };
    }
    // "fatal: '<path>' already exists"
    if let Some(path) = quoted_before(&stderr, " already exists") {
        return WorktreeError::PathExists(path);
    }
    // "fatal: '<path>' contains modified or untracked files, use --force to delete it"
    if let Some(path) = quoted_before(&stderr, " contains modified or untracked files") {
        return WorktreeError::Dirty(path);
    }
    // "fatal: '<path>' is not a working tree"
    if let Some(path) = quoted_before(&stderr, " is not a working tree") {
        return WorktreeError::NotAWorktree(path);
    }
    WorktreeError::Git {
        args: args.iter().map(|a| a.to_string_lossy().into_owned()).collect(),
        code: out.status.code(),
        stderr: stderr.trim_end().to_owned(),
    }
}

/// The `'…'` immediately preceding `tail`.
fn quoted_before(haystack: &str, tail: &str) -> Option<PathBuf> {
    let end = haystack.find(tail)?;
    let head = haystack[..end].strip_suffix('\'')?;
    let start = head.rfind('\'')?;
    Some(PathBuf::from(&head[start + 1..]))
}

/// The `'…'` immediately following `head`.
fn quoted_after(haystack: &str, head: &str) -> Option<String> {
    let rest = haystack.split_once(head)?.1.strip_prefix('\'')?;
    let end = rest.find('\'')?;
    Some(rest[..end].to_owned())
}

async fn prunable_reason(git: &Path, repo: &Path, path: &Path) -> Option<String> {
    let target = canonical_ish(path);
    list(git, repo)
        .await
        .ok()?
        .into_iter()
        .find(|w| canonical_ish(&w.path) == target)
        .and_then(|w| w.prunable)
        .filter(|r| !r.is_empty())
}

/// Resolve as much of `path` as exists on disk, keeping the rest verbatim.
///
/// The listing reports git's canonical path while a fatal echoes the caller's, and on macOS
/// `/var` is a symlink to `/private/var`; a prunable entry's directory is gone by definition, so
/// plain `canonicalize` cannot bridge the two.
fn canonical_ish(path: &Path) -> PathBuf {
    if let Ok(real) = std::fs::canonicalize(path) {
        return real;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => canonical_ish(parent).join(name),
        _ => path.to_path_buf(),
    }
}

/// Parse `git worktree list --porcelain -z`: every attribute is NUL-terminated and a record ends
/// with an extra NUL, so an empty field closes the record. The first record is the main worktree.
// see docs/research/tauri-runtime.md §6 LIST OUTPUT FORMAT.
fn parse_porcelain(bytes: &[u8]) -> Vec<Worktree> {
    let mut out: Vec<Worktree> = Vec::new();
    let mut current: Option<Worktree> = None;
    for field in bytes.split(|b| *b == 0) {
        if field.is_empty() {
            out.extend(current.take());
            continue;
        }
        let text = String::from_utf8_lossy(field);
        let (label, value) = match text.split_once(' ') {
            Some((label, value)) => (label, value),
            None => (text.as_ref(), ""),
        };
        match label {
            "worktree" => {
                out.extend(current.take());
                current = Some(Worktree {
                    path: PathBuf::from(value),
                    branch: None,
                    head: String::new(),
                    is_main: out.is_empty(),
                    prunable: None,
                    locked: None,
                });
            }
            other => {
                let Some(entry) = current.as_mut() else { continue };
                match other {
                    "HEAD" => entry.head = value.to_owned(),
                    "branch" => {
                        entry.branch =
                            Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_owned())
                    }
                    "locked" => entry.locked = Some(value.to_owned()),
                    "prunable" => entry.prunable = Some(value.to_owned()),
                    // `bare` and `detached` are bare labels and need no field of their own.
                    _ => {}
                }
            }
        }
    }
    out.extend(current);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_main_and_a_detached_secondary() {
        let raw = b"worktree /r/bare\0bare\0\0worktree /r/wt\0HEAD abc123\0detached\0\0";
        let got = parse_porcelain(raw);
        assert_eq!(got.len(), 2);
        assert!(got[0].is_main && got[0].head.is_empty() && got[0].branch.is_none());
        assert_eq!(got[1].head, "abc123");
        assert!(!got[1].is_main && got[1].branch.is_none());
    }

    #[test]
    fn parses_a_bare_locked_label_as_a_reasonless_lock() {
        let raw = b"worktree /r\0HEAD abc\0branch refs/heads/main\0\0\
                    worktree /r/x\0HEAD abc\0locked\0\0";
        let got = parse_porcelain(raw);
        assert_eq!(got[0].branch.as_deref(), Some("main"));
        assert_eq!(got[1].locked.as_deref(), Some(""));
    }

    #[test]
    fn quoting_helpers_pull_the_name_out_of_gits_fatals() {
        assert_eq!(
            quoted_after("fatal: a branch named 'feat' already exists", "a branch named ")
                .as_deref(),
            Some("feat")
        );
        assert_eq!(
            quoted_before("fatal: '/a b/c' is not a working tree", " is not a working tree"),
            Some(PathBuf::from("/a b/c"))
        );
        assert_eq!(quoted_before("fatal: nope", " is not a working tree"), None);
    }
}
