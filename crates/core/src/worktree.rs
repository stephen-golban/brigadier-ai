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
    /// The directory is inside a repository but is not its root, so a worktree of it would
    /// check out the **whole** repository somewhere the caller did not ask for.
    ///
    /// **measured**: `git worktree add` from `<repo>/apps/web` produces a checkout of the entire
    /// repository whose top level is the new path, so the caller's intended working directory is
    /// two levels below it and nothing says so.
    // see docs/research/worktree-git.md "Measured 2026-09-02".
    #[error("{} is inside the repository at {}, not its root; add the repository root {} as the project, or a directory that is not inside a repository", .dir.display(), .toplevel.display(), .toplevel.display())]
    NotRepositoryRoot {
        /// The directory that was offered as a project root.
        dir: PathBuf,
        /// The repository root git reported for it.
        toplevel: PathBuf,
    },
    /// The repository has no commits, so there is nothing to branch a worktree off.
    ///
    /// Detected up front with `rev-parse --verify HEAD` rather than left to `worktree add`,
    /// which would otherwise succeed with an implicit `--orphan` and hand the session a
    /// worktree sharing no history with the project.
    // see docs/research/worktree-git.md §3.
    #[error("{} has no commits yet; commit something first", .0.display())]
    UnbornHead(PathBuf),
    /// `check-ref-format --branch` rejected the name before anything was created.
    #[error("'{0}' is not a valid branch name")]
    InvalidRef(String),
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

/// Forced onto every command whose answer, or whose safety net, depends on seeing untracked
/// files. The operator's global `status.showUntrackedFiles=no` otherwise makes git report a
/// worktree full of new work as empty — and then delete it.
// see docs/research/worktree-git.md "Measured 2026-09-02".
const SHOW_UNTRACKED: &str = "status.showUntrackedFiles=normal";

/// The config keys that turn a `.gitattributes` `filter=<name>` selection into a shell command.
///
/// All four, not three. `process` is a separate driver spelling and is spawned before it is
/// spoken to; `required` decides whether a blanked driver is a fatal error, and **measured**, a
/// repository carrying `filter.<n>.required = true` — which `git lfs install --local` writes —
/// answers `worktree add` with exit 128 `fatal: <file>: smudge filter <n> failed` when only the
/// three command keys are blanked.
// see docs/research/gitattributes.md §3.
const FILTER_KEYS: [&str; 4] = ["smudge", "clean", "process", "required"];

/// Value handed to each blanked key. `required` is the odd one out: empty string is what
/// `git config --type=bool` reads as false anyway (**documented**, `git(1)` on `-c foo.bar=`),
/// but spelling it out keeps the intent readable in a `ps` listing.
const FILTER_OFF: [&str; 4] = ["", "", "", "false"];

/// Environment that disables every filter driver the repository's **effective** config defines,
/// plus `core.fsmonitor`.
///
/// **SECURITY — this is the whole reason it exists.** `git worktree add` checks out every tracked
/// file, and a checkout runs the smudge filter named by the repository's own `.gitattributes`.
/// The driver's *command* lives in config rather than in tracked content, and that is no defence:
/// **measured**, an agent running `git config --local filter.x.smudge '<command>'` from inside
/// its own linked worktree writes into the **main** repository's `.git/config` (a linked
/// worktree's `.git` is a file, so `--local` means the common dir), and the *next* session's
/// `git worktree add` executes that command with exit 0. Arbitrary shell, one session to the
/// next, outside every approval prompt.
///
/// **documented**, `git-config(1)`: `GIT_CONFIG_COUNT` with `GIT_CONFIG_KEY_<n>` /
/// `GIT_CONFIG_VALUE_<n>` pairs "will override values in configuration files, but will be
/// overridden by any explicit options passed via `git -c`" — so this never fights the `-c`
/// arguments the callers below pass, which name unrelated keys.
///
/// **Why the environment and not `-c`.** `-c` splits its argument on the first `=`, and a filter
/// subsection name may contain one: **measured**, `git config` accepts `filter.a=b.smudge`,
/// `.gitattributes` selects it with `*.txt filter=a=b`, and `-c 'filter.a=b.smudge='` sets a key
/// called `filter.a` while the real driver still fires. The env form carries key and value in
/// separate variables and has no such parse.
///
/// **Accepted consequence**: the enumeration reads system + global + local + `include.path`
/// config, so a globally defined `lfs` driver is blanked too and LFS content arrives in a new
/// worktree as pointer files. `git lfs pull` inside the worktree is the cure. Claude Code accepts
/// the same trade.
// see docs/research/gitattributes.md §§1-3.
async fn filter_neutralising_env(
    git: &Path,
    dir: &Path,
) -> Result<Vec<(OsString, OsString)>, WorktreeError> {
    // `--name-only -z`: a subsection name may contain a space, a quote or an `=`, and **measured**
    // `-z` returns `filter.a=b c.smudge` as one intact NUL-terminated record.
    let args = vec![
        osarg("-C"),
        dir.as_os_str().to_os_string(),
        osarg("config"),
        osarg("--list"),
        osarg("--name-only"),
        osarg("-z"),
    ];
    let listing = stdout(git, &args).await?;

    let mut names: Vec<String> = Vec::new();
    for key in listing.split(|b| *b == 0).filter(|k| !k.is_empty()) {
        // Fail closed rather than lossily decode: a name mangled by `from_utf8_lossy` would not
        // match the driver git resolves, and the override would silently miss.
        let key = std::str::from_utf8(key).map_err(|_| {
            WorktreeError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "a git config key is not valid UTF-8; refusing to run with filter drivers live",
            ))
        })?;
        let Some(rest) = key.strip_prefix("filter.") else { continue };
        let Some(name) = FILTER_KEYS.iter().find_map(|k| rest.strip_suffix(&format!(".{k}"))) else {
            continue;
        };
        // A name may itself contain dots (`filter.a.b.smudge`), which the suffix strip handles.
        if !name.is_empty() && !names.iter().any(|seen| seen == name) {
            names.push(name.to_owned());
        }
    }

    // **measured**: `core.fsmonitor` set to a command is executed by `worktree add` itself, and
    // again by every later `git status`. It is a performance cache, so `false` costs nothing.
    let mut pairs: Vec<(OsString, OsString)> =
        vec![(osarg("GIT_CONFIG_KEY_0"), osarg("core.fsmonitor")), (osarg("GIT_CONFIG_VALUE_0"), osarg("false"))];
    let mut n = 1usize;
    for name in &names {
        for (key, off) in FILTER_KEYS.iter().zip(FILTER_OFF) {
            pairs.push((osarg(format!("GIT_CONFIG_KEY_{n}")), osarg(format!("filter.{name}.{key}"))));
            pairs.push((osarg(format!("GIT_CONFIG_VALUE_{n}")), osarg(off)));
            n += 1;
        }
    }
    pairs.push((osarg("GIT_CONFIG_COUNT"), osarg(n.to_string())));
    Ok(pairs)
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
///
/// **The checkout runs with the repository's filter drivers disabled** — see
/// `filter_neutralising_env` below. Without that, `.gitattributes` plus a `filter.<n>.smudge` in the
/// repository's config is arbitrary shell executed by this call (**measured**, exit 0, marker
/// file written).
// see docs/research/gitattributes.md §1.
pub async fn add(git: &Path, spec: &WorktreeSpec) -> Result<Worktree, WorktreeError> {
    // Enumerated before anything is created, so a failure here creates no branch and no directory.
    let env = filter_neutralising_env(git, &spec.repo).await?;
    let args = vec![
        osarg("-C"),
        spec.repo.as_os_str().to_os_string(),
        osarg("worktree"),
        osarg("add"),
        osarg("-b"),
        osarg(&spec.branch),
        // Everything after `--` is a path, so a checkout directory that begins with a dash is a
        // path and not a flag. **measured**: `worktree add -b dash -- -weird HEAD` exits 0 and
        // creates `./-weird`, and the base argument after it is still read as the base.
        osarg("--"),
        spec.path.as_os_str().to_os_string(),
        osarg(&spec.base),
    ];
    match stdout_with(git, &args, &env).await {
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
///
/// **`--force` is not merely a confirmation: without it git still deletes ignored files.**
/// **measured** — a worktree whose only extra content was `.env` and `node_modules/`, both
/// matched by `.gitignore`, was removed by the unforced command with exit 0 and no warning. Ask
/// [`dirty_count`], which counts ignored entries, before deciding.
// see docs/research/worktree-git.md "Measured 2026-09-02".
pub async fn remove(
    git: &Path,
    repo: &Path,
    path: &Path,
    force: bool,
) -> Result<(), WorktreeError> {
    // The unforced form runs `status` internally, and `status` runs the repository's **clean**
    // filters to decide what counts as modified. Same shell, same attacker.
    // see docs/research/gitattributes.md §4.
    let env = filter_neutralising_env(git, repo).await?;
    let mut args = vec![
        // Without this, an operator with `status.showUntrackedFiles=no` in their global config
        // loses git's own refusal as well as ours. **measured**: under that setting a worktree
        // holding a brand-new untracked `NOTES.md` is removed with exit 0 and the file is gone;
        // with `-c status.showUntrackedFiles=normal` the same command exits 128 with
        // `contains modified or untracked files` and the file survives.
        osarg("-c"),
        osarg(SHOW_UNTRACKED),
        osarg("-C"),
        repo.as_os_str().to_os_string(),
        osarg("worktree"),
        osarg("remove"),
    ];
    if force {
        args.push(osarg("--force"));
    }
    args.push(osarg("--"));
    args.push(path.as_os_str().to_os_string());
    stdout_with(git, &args, &env).await.map(drop)
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

/// [`add`], plus the branch rollback git 2.50.1 makes necessary.
///
/// git prints `Preparing worktree (new branch …)` — and creates the ref — *before* it validates
/// the path, so every failure except [`WorktreeError::BranchExists`] leaves a dead branch behind.
/// On any other failure this fires `delete_branch(.., force = false)` and returns the original
/// error. **`-d`, never `-D`**: a branch this call created seconds ago points at `spec.base` and
/// is therefore fully merged, so `-d` deletes it (**measured**, exit 0), while a branch carrying
/// commits — anything that is not ours — makes `-d` refuse with `not fully merged`, exit 1
/// (**measured**). That is exactly the discrimination wanted, and it holds even if the
/// `BranchExists` classification ever misses. `BranchExists` is skipped as well, because that
/// branch was explicitly not ours.
///
/// [`add`] itself is left raw: `crates/core/tests/worktree.rs` pins git's leak as observed
/// behaviour, and a caller that wants the leak (to inspect it) should still be able to see it.
// see docs/research/worktree-git.md §5 "Failure atomicity and concurrency".
pub async fn add_or_rollback(git: &Path, spec: &WorktreeSpec) -> Result<Worktree, WorktreeError> {
    match add(git, spec).await {
        Ok(made) => Ok(made),
        Err(WorktreeError::BranchExists(branch)) => Err(WorktreeError::BranchExists(branch)),
        Err(other) => {
            if let Err(e) = delete_branch(git, &spec.repo, &spec.branch, false).await {
                // Expected whenever the branch was never created at all; only worth a debug line.
                tracing::debug!(branch = %spec.branch, error = %e, "no leaked branch to roll back");
            }
            Err(other)
        }
    }
}

/// The stderr fragments that mean "this repository has no commit yet" rather than "something
/// else went wrong". Matched against `LC_ALL=C` output, which [`spawn`] pins.
const UNBORN_HEAD_STDERR: [&str; 4] = [
    // git 2.50.1 (Apple Git-155), **measured**.
    "Needed a single revision",
    "invalid reference: HEAD",
    "ambiguous argument 'HEAD'",
    "unknown revision or path not in the working tree",
];

/// `git rev-parse --verify HEAD`: does this repository have a commit yet?
///
/// **measured** on git 2.50.1 (Apple Git-155): a repository with no commits answers
/// `fatal: Needed a single revision`, exit 128; one with a commit prints the 40-hex sha, exit 0.
///
/// A non-zero exit is only reported as "unborn" when the stderr says so. Anything else — a
/// corrupt object store, a permission failure — is propagated, because answering `Ok(false)` to
/// those turns an unrelated fault into "commit something first", which is advice that will not
/// help and hides the real error.
// see docs/research/worktree-git.md §3.
pub async fn has_commits(git: &Path, repo: &Path) -> Result<bool, WorktreeError> {
    let args = vec![
        osarg("-C"),
        repo.as_os_str().to_os_string(),
        osarg("rev-parse"),
        osarg("--verify"),
        osarg("HEAD"),
    ];
    let out = spawn(git, &args).await?;
    if out.status.success() {
        return Ok(true);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if UNBORN_HEAD_STDERR.iter().any(|needle| stderr.contains(needle)) {
        Ok(false)
    } else {
        Err(classify(&args, &out))
    }
}

/// `git rev-parse --show-toplevel`: the root of the working tree `dir` is in.
///
/// The main worktree's root for a path inside the main worktree, the linked worktree's own root
/// for a path inside one. Absolute, and git's own canonicalisation.
pub async fn show_toplevel(git: &Path, dir: &Path) -> Result<PathBuf, WorktreeError> {
    let args = vec![
        osarg("-C"),
        dir.as_os_str().to_os_string(),
        osarg("rev-parse"),
        osarg("--show-toplevel"),
    ];
    let out = stdout(git, &args).await?;
    Ok(PathBuf::from(String::from_utf8_lossy(&out).trim().to_owned()))
}

/// Whether `path` is inside a git repository at all.
///
/// **measured**: a plain directory answers `fatal: not a git repository (or any of the parent
/// directories): .git`, exit 128. A directory *nested inside* someone else's repository answers
/// with that repository, which is the honest answer — the harness would be creating worktrees of
/// it either way.
pub async fn is_repo(git: &Path, path: &Path) -> bool {
    git_common_dir(git, path).await.is_ok()
}

/// `git -C <dir> rev-parse --git-common-dir`, resolved against `dir`.
///
/// **measured**: the answer is *relative to the directory `-C` named* — `.git` from a repository
/// root, `../../.git` from two levels down — so it is only meaningful joined back onto `dir`.
/// From inside a linked worktree it names the **main** `.git`, which is the whole reason the
/// exclude rule needs writing only once per project.
// see docs/research/worktree-git.md §1 "Ignore-rule decision".
pub async fn git_common_dir(git: &Path, dir: &Path) -> Result<PathBuf, WorktreeError> {
    let args = vec![
        osarg("-C"),
        dir.as_os_str().to_os_string(),
        osarg("rev-parse"),
        osarg("--git-common-dir"),
    ];
    let out = stdout(git, &args).await?;
    let reported = PathBuf::from(String::from_utf8_lossy(&out).trim().to_owned());
    Ok(if reported.is_absolute() { reported } else { dir.join(reported) })
}

/// Serializes the read-modify-write in [`ensure_excluded`].
///
/// Process-wide, not cross-process: two brigadier processes opening the same project at the same
/// instant can still interleave. Not checked, and judged acceptable — the write is one short line
/// appended to a local file, and the idempotence check makes a duplicated line the worst case.
// see docs/research/worktree-git.md "Risks" 6.
static EXCLUDE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Append `pattern` to `$GIT_COMMON_DIR/info/exclude` unless it is already a line there.
///
/// Returns `true` when it wrote, `false` when the pattern was already present. Creates `info/`
/// and the file if they are missing. Never touches `.gitignore`: that file is under the
/// operator's version control, and dirtying it — or worse, editing a committed one — is the
/// harness writing to the user's repository behind their back.
///
/// The rule is not cosmetic. **measured**: without it, one `git add -A` in the main tree stages
/// the nested worktree as a `160000` gitlink.
// see docs/research/worktree-git.md §1.
pub async fn ensure_excluded(
    git: &Path,
    repo: &Path,
    pattern: &str,
) -> Result<bool, WorktreeError> {
    let exclude = git_common_dir(git, repo).await?.join("info").join("exclude");
    let _guard = EXCLUDE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // Everything below is synchronous on purpose: the guard must not be held across an await.
    let existing = match std::fs::read_to_string(&exclude) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(WorktreeError::Io(e)),
    };
    if existing.lines().any(|line| line.trim() == pattern) {
        return Ok(false);
    }
    if let Some(parent) = exclude.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(pattern);
    next.push('\n');
    std::fs::write(&exclude, next)?;
    Ok(true)
}

/// Everything in `worktree` that a removal would destroy, counted.
///
/// **Ignored files are counted as dirt, and that is the whole point.** `git worktree remove`
/// without `--force` protects modified and untracked files but **not** ignored ones:
/// **measured**, a worktree whose only extra content was a `.env` and a `node_modules/` — both
/// matched by the project's `.gitignore` — was removed with exit 0 and silently deleted. A count
/// that ignored them would report `0` and hand the operator a "clean, safe to remove" that
/// destroys their secrets. So the count is over `--ignored=matching --untracked-files=all`.
///
/// `-c status.showUntrackedFiles=normal` because the operator's own global config can set that to
/// `no`, which blinds `--porcelain` completely (**measured**: a brand-new untracked file counted
/// zero). A config value is not permission to delete someone's work.
///
/// One line per entry, so a pathname containing a newline inflates the count. That is accepted:
/// the number is what an operator is shown before deciding to discard the work, and `-z` would
/// undercount nothing but overcount every rename (two NUL-terminated fields per entry).
///
/// The repository's filter drivers are disabled for this call too, because `status` runs the
/// **clean** filter on candidate files and that is a shell command the repository chose. It can
/// only push the count **up** — content a clean filter would have normalised back to the index
/// now reads as modified — and that is the safe direction: an over-count refuses a removal, an
/// under-count deletes work.
// see docs/research/worktree-git.md §4, "Measured 2026-09-02", and
// docs/research/gitattributes.md §§4-5.
pub async fn dirty_count(git: &Path, worktree: &Path) -> Result<u32, WorktreeError> {
    let env = filter_neutralising_env(git, worktree).await?;
    let args = vec![
        osarg("-c"),
        osarg(SHOW_UNTRACKED),
        osarg("-C"),
        worktree.as_os_str().to_os_string(),
        osarg("status"),
        osarg("--porcelain"),
        osarg("--ignored=matching"),
        osarg("--untracked-files=all"),
    ];
    let out = stdout_with(git, &args, &env).await?;
    let count = String::from_utf8_lossy(&out).lines().filter(|l| !l.trim().is_empty()).count();
    Ok(u32::try_from(count).unwrap_or(u32::MAX))
}

/// `git check-ref-format --branch <name>`, as a cheap assertion before anything is created.
///
/// **measured** on git 2.50.1: a rejected name exits **128** with
/// `fatal: '<name>' is not a valid branch name`. `docs/research/worktree-git.md` §7 recorded
/// exit 1, which is what the *other* spelling (`check-ref-format refs/heads/<name>`, no
/// `--branch`) returns; the exit code is not read here, only success.
pub async fn check_ref_format(git: &Path, branch: &str) -> Result<(), WorktreeError> {
    let args =
        vec![osarg("check-ref-format"), osarg("--branch"), osarg(branch)];
    match spawn(git, &args).await {
        Ok(out) if out.status.success() => Ok(()),
        Ok(_) => Err(WorktreeError::InvalidRef(branch.to_owned())),
        Err(e) => Err(e),
    }
}

/// The short id a branch and a worktree directory are named after: eight lowercase hex chars.
///
/// Ref-safe by construction (`[0-9a-f]{8}` matches nothing `git check-ref-format` rejects),
/// filesystem-safe on case-insensitive APFS/HFS+ — which is why lowercase only — and short
/// enough to read in a sidebar.
///
/// The eight characters are the first eight hex digits of `id`, which for a v4 UUID is its first
/// group. An id with fewer than eight hex digits in it falls back to a hash of the whole string,
/// so the function is total and always returns exactly eight characters.
// see docs/research/worktree-git.md §7.
pub fn short_id(id: &str) -> String {
    let hex: String = id
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .take(8)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if hex.len() == 8 {
        return hex;
    }
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut hasher);
    format!("{:08x}", hasher.finish() as u32)
}

fn osarg(s: impl AsRef<OsStr>) -> OsString {
    s.as_ref().to_os_string()
}

async fn stdout(git: &Path, args: &[OsString]) -> Result<Vec<u8>, WorktreeError> {
    stdout_with(git, args, &[]).await
}

async fn stdout_with(
    git: &Path,
    args: &[OsString],
    env: &[(OsString, OsString)],
) -> Result<Vec<u8>, WorktreeError> {
    let out = spawn_with(git, args, env).await?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(classify(args, &out))
    }
}

async fn spawn(git: &Path, args: &[OsString]) -> Result<Output, WorktreeError> {
    spawn_with(git, args, &[]).await
}

async fn spawn_with(
    git: &Path,
    args: &[OsString],
    env: &[(OsString, OsString)],
) -> Result<Output, WorktreeError> {
    let mut cmd = Command::new(git);
    cmd.envs(env.iter().map(|(k, v)| (k.as_os_str(), v.as_os_str())));
    cmd.args(args)
        // Never a shell, and never an interactive credential prompt that would hang the harness.
        .env("GIT_TERMINAL_PROMPT", "0")
        // `classify` reads git's stderr by substring. A gettext build under a non-English locale
        // translates every one of those messages, and a missed `BranchExists` match is not a
        // cosmetic failure: it is the difference between "the operator already has this branch"
        // and a rollback that deletes it. Pin the locale rather than trusting the environment.
        // see docs/research/worktree-git.md "Measured 2026-09-02".
        .env("LC_ALL", "C")
        .env("LANGUAGE", "")
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
    fn a_short_id_is_always_eight_lowercase_hex_characters() {
        assert_eq!(short_id("3F9A2B1C-dead-4beef-8000-000000000000"), "3f9a2b1c");
        assert_eq!(short_id("00000000-0000-4000-8000-000000000000"), "00000000");
        // Not a UUID at all: still eight hex characters, still deterministic.
        let odd = short_id("replay");
        assert_eq!(odd.len(), 8, "{odd}");
        assert_eq!(odd, short_id("replay"));
        assert!(odd.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{odd}");
        assert_ne!(short_id(""), short_id("x"));
        assert_eq!(short_id("").len(), 8);
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
