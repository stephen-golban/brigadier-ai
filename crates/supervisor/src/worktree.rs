//! One git worktree per session: where it goes, what refuses a start, and how it is torn down.
//!
//! `brigadier_core::worktree` is the git layer — it shells out and classifies stderr, and knows
//! nothing about sessions. This module is the policy on top of it:
//!
//! - a session gets branch `brigadier/<short-id>` and a checkout at
//!   `<project root>/.brigadier/worktrees/<short-id>`, and the child's `cwd` is that checkout;
//! - `.brigadier/` is excluded once per project, at project-add time, in
//!   `$GIT_COMMON_DIR/info/exclude` and never in `.gitignore`;
//! - a project that is not a git repository is not an error: its sessions run in the project
//!   root with no worktree and no branch;
//! - cleanup is **explicit**. Nothing here runs on `end_session` or `kill`, because a resumed
//!   session needs its worktree as `cwd`, and because `git worktree remove` on a clean tree with
//!   unmerged commits exits 0 in silence.
//!
//! Everything measured about git's behaviour is in `docs/research/worktree-git.md`; the section
//! citations below point at it.

use std::path::{Path, PathBuf};

use brigadier_core::worktree::{
    self, add_or_rollback, check_ref_format, commits_only_here, dirty_count, ensure_excluded,
    has_commits, has_submodules, is_repo, main_worktree_of, resolve_git, short_id, show_toplevel,
    RemoveForce, WorktreeError, WorktreeSpec,
};
use serde::Serialize;

use crate::error::SupervisorError;

/// Directory, relative to the project root, that every session worktree is created under.
pub const WORKTREES_SUBDIR: &str = ".brigadier/worktrees";

/// The one line written to `$GIT_COMMON_DIR/info/exclude` per project.
///
/// The trailing slash is load-bearing: **documented** in `gitignore(5)`, "if there is a separator
/// at the end of the pattern then the pattern will only match directories".
// see docs/research/worktree-git.md §1.
pub const EXCLUDE_PATTERN: &str = ".brigadier/";

/// Namespace every session branch lives under.
pub const BRANCH_PREFIX: &str = "brigadier/";

/// The base every session branch starts at.
///
/// `HEAD` rather than a named branch: **measured**, `git worktree add <path> main` fails with
/// `fatal: 'main' is already used by worktree at …` when `main` is checked out, while `HEAD`
/// works even from a detached main tree — and `HEAD` is what the operator means by "branch off
/// what I am looking at".
// see docs/research/worktree-git.md §3.
const BASE: &str = "HEAD";

/// The lock reason git writes itself while `worktree add` is checking a worktree out, and leaves
/// behind if that add is killed. **measured** on git 2.50.1: `git worktree list --porcelain`
/// reports `locked initializing` for a `SIGKILL`ed add, and this exact string is the only lock
/// reason brigadier will ever override.
// see docs/research/worktree-cleanup.md §1.1.
const GIT_INITIALIZING_LOCK: &str = "initializing";

/// Why a cleanup refused. `None` on the paths that removed something.
///
/// Every variant is a *refusal*, never an authorization, and the two at the bottom are refusals
/// `force = true` cannot answer — the operator has to act outside brigadier.
// see docs/research/worktree-cleanup.md "Hard rules".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupBlocked {
    /// Modified, untracked or ignored entries would be discarded. `force = true` answers it.
    Dirty,
    /// Commits exist here and on no other ref. `force = true` answers it, and even then the
    /// branch survives — this is the "you are about to lose sight of them" warning, not a delete.
    Commits,
    /// The live `git worktree list` branch is not the one the session row records: the agent
    /// detached `HEAD`, checked out its own branch, or the operator renamed ours. `force = true`
    /// answers it, and [`WorktreeCleanup::live_branch`] says what git actually reports.
    // see docs/research/worktree-cleanup.md §1.5 and "Hard rules" 10.
    BranchMoved,
    /// The directory exists but git does not register it as a worktree of this repository —
    /// §1.3(b), reached by a hand-deleted admin directory or by a prune that ran before a repair.
    /// **`force` deliberately does not answer this.** The only remedy is deleting the directory,
    /// and an `rm -rf` fallback is the exact bug Claude Code shipped and withdrew in v2.1.143 for
    /// destroying gitignored and in-progress files.
    // see docs/research/worktree-cleanup.md §1.3, §1.4 and "Hard rules" 1.
    Unregistered,
    /// Something holds a `git worktree lock` on it. **`force` deliberately does not answer this**:
    /// only `remove -f -f` clears a lock and a lock is another process's claim.
    // see docs/research/worktree-cleanup.md §1.8 and "Hard rules" 4.
    Locked,
    /// `git worktree remove` reported success and the directory is still there — the state a
    /// moved project produces (**measured**, exit 0 with every file left on disk).
    // see docs/research/worktree-cleanup.md §1.4 and "Hard rules" 11.
    LeftOnDisk,
}

/// What [`crate::Supervisor::cleanup_worktree`] did, or refused to do.
///
/// `removed: false` with a `blocked` reason is the "are you sure" case: nothing was touched. For
/// [`CleanupBlocked::Dirty`], [`CleanupBlocked::Commits`] and [`CleanupBlocked::BranchMoved`] the
/// same call with `force = true` proceeds; the other three are refusals `force` does not answer,
/// and the message names what to do instead.
///
/// `branch` is always the session's branch and it is **always still there**: no cleanup path
/// deletes a branch. The worktree is a reconstructible checkout; the branch is the only copy of
/// whatever the agent committed.
// see docs/research/worktree-git.md §4 and "Risks" 1, docs/research/worktree-cleanup.md §6.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorktreeCleanup {
    /// Whether the checkout is gone **from disk** and from `git worktree list`. Never set from
    /// git's exit code alone: a `remove` that exits 0 and leaves every file behind is a measured
    /// state, so this is only `true` after the path is confirmed gone.
    pub removed: bool,
    /// Entries `git status --porcelain --ignored=matching -uall` reported, one per line.
    pub dirty_files: u32,
    /// Commits reachable from this worktree's `HEAD` and from no other branch, tag or remote ref.
    /// Working-tree dirt and commits are different losses and are counted separately; a clean
    /// worktree carrying five unpushed commits used to remove with exit 0 in silence.
    // see docs/research/worktree-cleanup.md §2.6 rung 1.
    pub commits: u32,
    /// The session's branch, which survives every cleanup.
    pub branch: String,
    /// What `git worktree list --porcelain` says is checked out there right now: `None` for a
    /// detached head, and the *only* trustworthy answer where it disagrees with `branch`.
    pub live_branch: Option<String>,
    /// Why nothing was removed, or `None`.
    pub blocked: Option<CleanupBlocked>,
}

impl WorktreeCleanup {
    /// A refusal that touched nothing.
    fn refused(
        blocked: CleanupBlocked,
        dirty_files: u32,
        commits: u32,
        branch: String,
        live_branch: Option<String>,
    ) -> Self {
        Self { removed: false, dirty_files, commits, branch, live_branch, blocked: Some(blocked) }
    }
}

/// Compare two paths as the filesystem sees them.
///
/// git reports its own canonicalisation, and on macOS `/var/…` is a symlink to `/private/var/…`,
/// so a byte comparison of git's answer against the caller's path is wrong far more often than it
/// is right.
fn same_path(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(b)
}

/// A worktree created for a session that has not started yet.
///
/// Held only across the `driver.start_session` call: if the child will not come up, the caller
/// hands this back to [`Prepared::roll_back`] rather than leaving a checkout and a branch behind
/// for a session that never existed.
#[derive(Clone, Debug)]
pub(crate) struct Prepared {
    git: PathBuf,
    repo: PathBuf,
    /// Where the child will run.
    pub(crate) path: PathBuf,
    /// The branch that checkout is on.
    pub(crate) branch: String,
}

impl Prepared {
    /// Remove the checkout and delete the branch: undo everything [`prepare`] did.
    ///
    /// The one path that *does* delete a branch, and the delete is **`-d`, never `-D`**: the
    /// branch was created seconds ago at `HEAD` and no child ever ran in this checkout, so it is
    /// fully merged and `-d` takes it (**measured**). If anything did land a commit on it — which
    /// would mean this is not the branch we think it is — `-d` refuses with `not fully merged`
    /// and the work survives. Errors are logged, never returned: the caller is already on its way
    /// out with the real failure.
    /// **The one caller entitled to `remove -f -f`, and only against git's own `initializing`
    /// lock.** A crash — ours or the machine's — partway through `git worktree add` leaves the
    /// entry `locked initializing`, and **measured** on git 2.50.1 every ordinary verb refuses it:
    /// `prune -v` exits 0 and prints nothing, `remove` and `remove --force` both fatal at exit 128
    /// with `cannot remove a locked working tree`, and `branch -D` answers `cannot delete branch
    /// … used by worktree at …` at exit 1. Only `remove -f -f` gets out, and then the branch
    /// deletes. Without this escalation the residue is permanent and blocks the path forever.
    ///
    /// The escalation is gated on the lock reason being exactly `initializing`. Any other reason
    /// is somebody's deliberate claim on the directory and is left alone with a warning — Hard
    /// rule 4. This is a worktree this process created seconds ago and never handed to a child,
    /// which is the only circumstance in which "the lock is ours" is knowable.
    ///
    /// **measured**, and worth expecting: on a large repository `remove -f -f` against that
    /// residue can exit **255** with `failed to delete '<path>': Directory not empty` *after*
    /// unregistering the entry, leaving a directory git no longer knows. The branch still deletes,
    /// which is the part that matters here; the directory is reported by the launch sweep.
    // see docs/research/worktree-git.md "Measured 2026-09-02" and
    // docs/research/worktree-cleanup.md §1.1 and "Hard rules" 4.
    pub(crate) async fn roll_back(self) {
        match worktree::remove(&self.git, &self.repo, &self.path, RemoveForce::Discard).await {
            Ok(()) => {}
            Err(WorktreeError::Locked(reason)) if reason == GIT_INITIALIZING_LOCK => {
                if let Err(e) =
                    worktree::remove(&self.git, &self.repo, &self.path, RemoveForce::Unlock).await
                {
                    tracing::warn!(path = %self.path.display(), error = %e, "could not clear the half-built worktree");
                }
            }
            Err(WorktreeError::Locked(reason)) => tracing::warn!(
                path = %self.path.display(),
                reason = %reason,
                "the worktree is locked by something else; leaving it rather than overriding the lock"
            ),
            Err(e) => {
                tracing::warn!(path = %self.path.display(), error = %e, "could not roll back the worktree")
            }
        }
        if let Err(e) = worktree::delete_branch(&self.git, &self.repo, &self.branch, false).await {
            tracing::warn!(branch = %self.branch, error = %e, "could not roll back the branch");
        }
    }
}

/// Create the worktree a new session will run in, or decide it gets none.
///
/// `Ok(None)` means "run in the project root": either `git` is not on `PATH` or the project is
/// not inside a repository. Both are recorded as a `worktree_path`/`branch` of `NULL` on the
/// session row, and both are normal — a scratch directory is a legitimate project.
///
/// # Errors
/// [`SupervisorError::WorktreeUnbornHead`] when the repository has no commit to branch from,
/// [`SupervisorError::WorktreeBranchExists`] when `brigadier/<id>` is already taken, and
/// [`SupervisorError::Worktree`] for anything else git refused. Every one of them refuses the
/// start rather than falling back to the project root, because a session that silently ran in the
/// operator's own checkout is the failure mode this whole feature exists to prevent.
// see docs/research/worktree-git.md §3, §5 and §7.
pub(crate) async fn prepare(project_root: &Path) -> Result<Option<Prepared>, SupervisorError> {
    let Some(git) = resolve_git() else {
        tracing::warn!("no git on PATH; the session will run in the project root");
        return Ok(None);
    };
    if !is_repo(&git, project_root).await {
        tracing::debug!(
            root = %project_root.display(),
            "not a git repository; the session will run in the project root"
        );
        return Ok(None);
    }
    // A project root that is a *subdirectory* of a repository would get a checkout of the whole
    // repository, whose top level is the new path — so the child's cwd would be the repository
    // root, two levels from where the operator pointed, with no indication. **measured**. Refuse
    // and name the remedy rather than silently relocating the session.
    // see docs/research/worktree-git.md "Measured 2026-09-02".
    let toplevel = show_toplevel(&git, project_root).await?;
    if !same_path(&toplevel, project_root) {
        return Err(SupervisorError::from(WorktreeError::NotRepositoryRoot {
            dir: project_root.to_owned(),
            toplevel,
        }));
    }
    // A project root that is itself a *linked worktree* passes the check above — `show_toplevel`
    // inside a linked worktree returns that worktree's own root — and is the more dangerous of
    // the two. Sessions would nest inside it, and **measured**, `git worktree remove` on the
    // outer worktree takes the inner one's files with it at exit 0 while
    // `status --ignored=matching -uall` in the outer reports nothing, so `dirty_count` says 0 over
    // another session's uncommitted work. The remedy is to open the main repository instead.
    // see docs/research/worktree-cleanup.md §1.6.
    if let Some(main) = main_worktree_of(&git, project_root).await? {
        return Err(SupervisorError::from(WorktreeError::LinkedWorktree {
            dir: project_root.to_owned(),
            main,
        }));
    }
    // Up front, so an unborn HEAD is a message with a remedy in it rather than git's
    // `fatal: invalid reference: HEAD` — or, with the base omitted, a silent orphan worktree.
    if !has_commits(&git, project_root).await? {
        return Err(SupervisorError::from(WorktreeError::UnbornHead(project_root.to_owned())));
    }
    // Submodules. **measured**: `worktree add` succeeds, the submodule directory is **empty**,
    // and `git status --porcelain` inside the new worktree reports nothing — an incomplete
    // checkout that reads as clean, so the agent's build fails for a reason nothing in the UI
    // explains. Then, once anything runs `submodule update --init`, `worktree remove` refuses
    // categorically (`working trees containing submodules cannot be moved or removed`, exit 128)
    // on a tree `dirty_count` calls clean. Refusing up front is the honest answer; making the
    // worktree complete would mean brigadier running `submodule update --init` in the operator's
    // repository, which is a decision for the operator, not for us.
    // see docs/research/worktree-cleanup.md §1.13.
    if has_submodules(&git, project_root).await? {
        return Err(SupervisorError::from(WorktreeError::RepositoryHasSubmodules(
            project_root.to_owned(),
        )));
    }

    let id = short_id(&uuid::Uuid::new_v4().to_string());
    let branch = format!("{BRANCH_PREFIX}{id}");
    let path = project_root.join(WORKTREES_SUBDIR).join(&id);
    // Cheap assertion, not a formality: it also catches the D/F conflict's cousin, a `branch`
    // that some future id scheme made ref-illegal. see docs/research/worktree-git.md §7.
    check_ref_format(&git, &branch).await?;

    let spec = WorktreeSpec {
        repo: project_root.to_owned(),
        path: path.clone(),
        branch: branch.clone(),
        base: BASE.to_owned(),
    };
    let made = add_or_rollback(&git, &spec).await?;
    tracing::info!(path = %made.path.display(), branch = %branch, "worktree created");
    // git's own idea of the path: canonicalised, which on macOS means `/private/var/…` where the
    // caller said `/var/…`. The child's cwd and the stored row should agree with git.
    Ok(Some(Prepared { git, repo: project_root.to_owned(), path: made.path, branch }))
}

/// Write `.brigadier/` into the project's `$GIT_COMMON_DIR/info/exclude`, once.
///
/// Called from `add_project`, not from `start_session`: the file is a shared resource and two
/// concurrent starts appending to it can interleave, whereas project-add happens once and under
/// a lock. Never fatal — a project whose exclude file will not open still works, it just risks
/// the gitlink described in §1 — so this logs and returns.
// see docs/research/worktree-git.md §1 and "Risks" 2 and 6.
pub(crate) async fn exclude_project(project_root: &Path) {
    let Some(git) = resolve_git() else { return };
    if !is_repo(&git, project_root).await {
        return;
    }
    match ensure_excluded(&git, project_root, EXCLUDE_PATTERN).await {
        Ok(true) => {
            tracing::info!(root = %project_root.display(), "wrote {EXCLUDE_PATTERN} to info/exclude")
        }
        Ok(false) => tracing::debug!(root = %project_root.display(), "info/exclude already excludes {EXCLUDE_PATTERN}"),
        Err(e) => tracing::warn!(
            root = %project_root.display(),
            error = %e,
            "could not exclude {EXCLUDE_PATTERN}; `git add -A` in this project may stage a gitlink"
        ),
    }
}

/// Every directory that looks like one of our session worktrees, straight off the disk.
///
/// `read_dir`, not the session rows, and not `git worktree list`: after a project is moved the
/// listing reports the *old* paths and a row can be missing entirely, while the directories are
/// the one thing that is still where it is. Order is whatever the filesystem gives; `repair` does
/// not care.
// see docs/research/worktree-cleanup.md §1.4 and §3.
fn worktree_dirs_on_disk(project_root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(project_root.join(WORKTREES_SUBDIR)) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect()
}

/// `git worktree repair` then `git worktree prune`, for one project. Logged and swallowed.
///
/// **The order is the whole point and it was the wrong way round.** A worktree records two
/// absolute paths and brigadier's worktrees are nested inside the project, so one `mv` of the
/// project folder breaks every one of them at once. From there the two orders do not converge:
///
/// - `repair <path>` first → exit 0, both files rewritten, `git -C <wt> status` works again and
///   the agent's uncommitted work is intact. **Fully recovered** (**measured**).
/// - `prune` first — which is what this function used to do, on every launch — → the entry is
///   removed, and `repair` afterwards answers `error: unable to locate repository`, exit 1, with
///   no way back. The checkout becomes a directory git will neither describe, remove nor reuse
///   (**measured**).
///
/// So the launch sweep converted a fully recoverable state into a permanently unrecoverable one
/// every time the operator renamed a folder. Both verbs touch **no files** — repair rewrites two
/// path strings, prune deletes admin entries only — which is why this pair is the only part of
/// the reconciliation in §3 that is allowed to run unattended.
///
/// `repair`'s errors are expected and ignored: a directory under `.brigadier/worktrees/` that is
/// not a worktree makes the whole call exit 1 **after repairing the ones that are** (**measured**).
// see docs/research/worktree-cleanup.md §1.4, §3.2 and "Hard rules" 7.
pub(crate) async fn prune_project(project_root: &Path) {
    let Some(git) = resolve_git() else { return };
    if !is_repo(&git, project_root).await {
        return;
    }
    let dirs = worktree_dirs_on_disk(project_root);
    if !dirs.is_empty() {
        match worktree::repair(&git, project_root, &dirs).await {
            Ok(()) => {
                tracing::debug!(root = %project_root.display(), count = dirs.len(), "worktrees repaired")
            }
            // Not a failure worth a warning on its own: repair exits 1 for any path in the batch
            // that is not a worktree, having already fixed the ones that are.
            Err(e) => {
                tracing::debug!(root = %project_root.display(), error = %e, "worktree repair reported a problem")
            }
        }
    }
    match worktree::prune(&git, project_root).await {
        Ok(()) => tracing::debug!(root = %project_root.display(), "worktrees pruned"),
        Err(e) => tracing::warn!(root = %project_root.display(), error = %e, "worktree prune failed"),
    }
}

/// Remove one session's checkout, keeping its branch.
///
/// **Every safety decision here reads `git worktree list --porcelain`, not the session row.** The
/// column is a label for the UI; the porcelain is the fact, and they diverge in three measured
/// ways: an agent that runs `checkout --detach` inside its own worktree leaves the entry
/// `detached` with no branch line — and `git branch -d` on our recorded name then succeeds at exit
/// 0 even though the worktree still exists; an agent that runs `checkout -b its-own` moves the
/// session's real work onto a branch whose name is nowhere in our database, so "we always keep the
/// branch" protects the wrong, empty ref; and the operator's own `git branch -m` leaves our stored
/// name dangling, `branch 'brigadier/…' not found`, exit 1.
///
/// The ladder, cheapest refusal first, and every rung is a *refusal* rather than an
/// authorization:
///
/// 1. gone from disk → prune and report removed (unchanged);
/// 2. `repair`, then look the path up in the porcelain. **Not registered → refuse.** In that
///    state `git worktree remove` can exit 0, unregister the entry and leave every file on disk,
///    and `dirty_count` cannot even run because git cannot reach the admin directory — so the
///    safety net is not merely wrong, it is absent. No `rm -rf` fallback, forced or not;
/// 3. locked → refuse. One `--force` does not clear a lock and the second is not ours to give;
/// 4. live branch ≠ recorded branch → refuse unless forced, reporting what git says;
/// 5. working-tree dirt, and **commits this worktree holds that no other ref does** → refuse
///    unless forced. The second is the one that was missing: a clean worktree with five unpushed
///    commits removed with exit 0 in silence, and Claude Code refuses that same case without an
///    explicit `discard_changes`;
/// 6. remove, then **`stat` the path**. Exit 0 is not proof (**measured**).
// see docs/research/worktree-git.md §4, docs/research/worktree-cleanup.md §1.4, §1.5, §2.6 and
// "Hard rules" 1, 4, 10, 11.
pub(crate) async fn cleanup(
    repo: &Path,
    path: &Path,
    branch: String,
    force: bool,
) -> Result<WorktreeCleanup, SupervisorError> {
    let Some(git) = resolve_git() else {
        return Err(SupervisorError::Worktree(WorktreeError::GitNotFound));
    };
    if !path.exists() {
        // `rm -rf` by hand, or a previous cleanup that raced this one: the entry survives in
        // `git worktree list` as prunable and would block a re-add at the same path.
        prune_project(repo).await;
        return Ok(WorktreeCleanup {
            removed: true,
            dirty_files: 0,
            commits: 0,
            branch,
            live_branch: None,
            blocked: None,
        });
    }
    // Free, non-destructive, and it is the difference between "the operator renamed a folder" and
    // an unrecoverable state: repair rewrites the two stale absolute paths and touches no files.
    let candidates = [path.to_path_buf()];
    if let Err(e) = worktree::repair(&git, repo, &candidates).await {
        tracing::debug!(path = %path.display(), error = %e, "worktree repair before cleanup reported a problem");
    }
    let entry = worktree::list(&git, repo)
        .await?
        .into_iter()
        // A `prunable` entry is as good as absent: its admin link is broken, so `status` cannot
        // run and neither can any honest safety check. **measured**, this is also the one state in
        // which `git worktree remove` reports success over a directory it did not touch.
        .find(|w| !w.is_main && w.prunable.is_none() && same_path(&w.path, path));
    let Some(entry) = entry else {
        // §1.3(b): a directory of the agent's files that git will neither describe, remove nor
        // reuse. `force` does not reach it either — the only verb left is `rm -rf`, and that is
        // the fallback Claude Code shipped and withdrew in v2.1.143 for destroying gitignored and
        // in-progress files. Name the path and let the operator decide.
        tracing::warn!(
            path = %path.display(),
            "git does not register this directory as a worktree; leaving it on disk"
        );
        return Ok(WorktreeCleanup::refused(CleanupBlocked::Unregistered, 0, 0, branch, None));
    };
    if let Some(reason) = entry.locked.as_deref() {
        tracing::warn!(path = %path.display(), reason, "the worktree is locked; refusing to remove it");
        return Ok(WorktreeCleanup::refused(
            CleanupBlocked::Locked,
            0,
            0,
            branch,
            entry.branch.clone(),
        ));
    }
    let live_branch = entry.branch.clone();
    let dirty = dirty_count(&git, path).await?;
    let commits = commits_only_here(&git, path, live_branch.as_deref()).await?;
    if live_branch.as_deref() != Some(branch.as_str()) && !force {
        return Ok(WorktreeCleanup::refused(
            CleanupBlocked::BranchMoved,
            dirty,
            commits,
            branch,
            live_branch,
        ));
    }
    if !force {
        // Dirt first: it is the loss the operator can see, and the UI already has a sentence for
        // it. Commits are the quieter half and the reason this rung exists at all.
        if dirty > 0 {
            return Ok(WorktreeCleanup::refused(
                CleanupBlocked::Dirty,
                dirty,
                commits,
                branch,
                live_branch,
            ));
        }
        if commits > 0 {
            return Ok(WorktreeCleanup::refused(
                CleanupBlocked::Commits,
                dirty,
                commits,
                branch,
                live_branch,
            ));
        }
    }
    let rung = if force { RemoveForce::Discard } else { RemoveForce::No };
    let removed = match worktree::remove(&git, repo, path, rung).await {
        Ok(()) => true,
        // Something dirtied the tree between the count and the remove. Report, do not force.
        Err(WorktreeError::Dirty(_)) => {
            let dirty = dirty_count(&git, path).await.unwrap_or(dirty.max(1));
            return Ok(WorktreeCleanup::refused(
                CleanupBlocked::Dirty,
                dirty,
                commits,
                branch,
                live_branch,
            ));
        }
        // Somebody locked it between the listing and the remove.
        Err(WorktreeError::Locked(_)) => {
            return Ok(WorktreeCleanup::refused(
                CleanupBlocked::Locked,
                dirty,
                commits,
                branch,
                live_branch,
            ));
        }
        Err(e) => return Err(SupervisorError::from(e)),
    };
    // **The exit code is not the answer.** `git worktree remove` exits 0, unregisters the entry
    // and leaves every file where it was when the project has been renamed under git's feet
    // (**measured**, twice). Reporting `removed: true` there tells the operator their work is
    // gone while it sits on disk, and takes the Resume button away for nothing.
    if path.exists() {
        tracing::warn!(
            path = %path.display(),
            "git reported the worktree removed and the directory is still there"
        );
        return Ok(WorktreeCleanup::refused(
            CleanupBlocked::LeftOnDisk,
            dirty,
            commits,
            branch,
            live_branch,
        ));
    }
    Ok(WorktreeCleanup { removed, dirty_files: dirty, commits, branch, live_branch, blocked: None })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use brigadier_core::driver::{
        BoxFuture, DriverError, DriverInfo, DriverKind, ProviderDriver, ResumeSession,
        StartSession,
    };
    use brigadier_core::event::InstanceId;
    use brigadier_core::session::SessionHandle;
    use brigadier_core::event::{Event, ItemId, ItemKind, SessionId};
    use brigadier_store::{SessionRow, Store};
    use tempfile::TempDir;

    use super::*;
    use crate::{ReplayDriver, Supervisor, SupervisorConfig, VecSink};

    /// A throwaway git repo, a store, and a supervisor with a replay driver registered.
    struct Rig {
        dir: TempDir,
        repo: PathBuf,
        git: PathBuf,
        store: Store,
        sup: Supervisor,
        kind: DriverKind,
    }

    impl Rig {
        /// `commits = false` leaves HEAD unborn.
        fn new(commits: bool) -> Rig {
            let git = resolve_git().expect("git on PATH");
            let dir = tempfile::tempdir().expect("temp dir");
            let repo = dir.path().join("repo");
            std::fs::create_dir(&repo).expect("mkdir repo");
            git_run(&git, &repo, &["init", "-q", "-b", "main", "."]);
            if commits {
                std::fs::write(repo.join("f.txt"), "hi\n").expect("write");
                git_run(&git, &repo, &["add", "f.txt"]);
                git_run(&git, &repo, &["commit", "-qm", "init"]);
            }
            let data = dir.path().join("data");
            std::fs::create_dir(&data).expect("mkdir data");
            let store = Store::open(&data).expect("store opens");
            let sup = Supervisor::new(SupervisorConfig::new(
                store.handle().clone(),
                store.run_id().to_owned(),
                data,
                Arc::new(VecSink::new()),
            ));
            let script = vec![Event::item_completed(
                ItemId::new("i"),
                ItemKind::AssistantText,
                "hello",
                None,
            )];
            let driver = ReplayDriver::new(script).with_rate(200.0);
            let kind = driver.kind();
            sup.register_driver(Arc::new(driver));
            Rig { dir, repo, git, store, sup, kind }
        }

        async fn project(&self) -> String {
            self.sup.add_project(self.repo.clone()).await.expect("project added").id
        }

        async fn start(&self, project: &str) -> Result<SessionId, SupervisorError> {
            self.sup
                .start_session(project, &self.kind, StartSession::new(self.repo.clone()))
                .await
        }

        async fn row(&self, id: &SessionId) -> brigadier_store::SessionRecord {
            self.store.handle().flush().await.expect("flush");
            self.sup.session(id).await.expect("read").expect("row")
        }

        fn branches(&self) -> Vec<String> {
            git_run(&self.git, &self.repo, &["branch", "--format=%(refname:short)"])
                .lines()
                .map(str::to_owned)
                .collect()
        }

        fn exclude_text(&self) -> String {
            std::fs::read_to_string(self.repo.join(".git").join("info").join("exclude"))
                .expect("exclude file")
        }

        async fn end_and_settle(&self, id: &SessionId) {
            self.sup.end_session(id).await.expect("end");
            let deadline = Instant::now() + Duration::from_secs(5);
            while self.sup.is_live(id) && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!self.sup.is_live(id), "the session never left the live map");
        }
    }

    /// A driver that refuses every start. The only way to exercise the rollback path, which is
    /// otherwise reachable only when a real `claude` will not come up.
    #[derive(Debug)]
    struct RefusingDriver {
        instance_id: InstanceId,
        kind: DriverKind,
    }

    impl RefusingDriver {
        fn new() -> Self {
            Self {
                instance_id: InstanceId::new("refusing"),
                kind: DriverKind::new("refusing"),
            }
        }
    }

    impl ProviderDriver for RefusingDriver {
        fn kind(&self) -> DriverKind {
            self.kind.clone()
        }
        fn instance_id(&self) -> &InstanceId {
            &self.instance_id
        }
        fn describe(&self) -> DriverInfo {
            DriverInfo {
                display_name: "Refusing".to_owned(),
                binary_path: None,
                version: None,
                account_label: None,
            }
        }
        fn start_session(
            &self,
            _req: StartSession,
        ) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
            Box::pin(async { Err(DriverError::Protocol("the child would not come up".to_owned())) })
        }
        fn resume_session(
            &self,
            _req: ResumeSession,
        ) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
            Box::pin(async { Err(DriverError::Protocol("the child would not come up".to_owned())) })
        }
    }

    fn git_run(git: &Path, cwd: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new(git)
            .arg("-C")
            .arg(cwd)
            .args(["-c", "user.email=test@example.invalid", "-c", "user.name=test"])
            .args(["-c", "commit.gpgsign=false"])
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// The whole scheme in one assertion set: where the checkout is, what the branch is called,
    /// and that the row carries both plus a `cwd` that agrees with them.
    // see docs/research/worktree-git.md §7.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_runs_in_its_own_worktree_on_its_own_branch() {
        let rig = Rig::new(true);
        let project = rig.project().await;
        let session = rig.start(&project).await.expect("session starts");

        let row = rig.row(&session).await;
        let path = row.worktree_path.clone().expect("the row records a worktree");
        let branch = row.branch.clone().expect("the row records a branch");

        assert_eq!(row.cwd.as_deref(), Some(path.as_path()), "the child runs in the worktree");
        let id = branch.strip_prefix(BRANCH_PREFIX).expect("branch is namespaced").to_owned();
        assert_eq!(id.len(), 8, "short id is eight characters: {id}");
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{id}");
        assert!(
            same_path(&path, &rig.repo.join(WORKTREES_SUBDIR).join(&id)),
            "{} is not <root>/{WORKTREES_SUBDIR}/{id}",
            path.display()
        );
        assert!(path.join("f.txt").is_file(), "the worktree is checked out at HEAD");
        assert!(rig.branches().contains(&branch), "{:?}", rig.branches());

        rig.end_and_settle(&session).await;
        rig.store.close().await.expect("store closes");
    }

    /// The exclude line is the difference between a clean `git add -A` and a staged gitlink, and
    /// re-adding a project must not write it twice.
    // see docs/research/worktree-git.md §1.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_exclude_line_is_written_once_however_often_the_project_is_added() {
        let rig = Rig::new(true);
        let first = rig.project().await;
        let text = rig.exclude_text();
        assert!(text.lines().any(|l| l.trim() == EXCLUDE_PATTERN), "{text:?}");

        let again = rig.project().await;
        assert_eq!(again, first, "the same tree keeps its project id");
        let text = rig.exclude_text();
        assert_eq!(
            text.lines().filter(|l| l.trim() == EXCLUDE_PATTERN).count(),
            1,
            "duplicated the exclude line: {text:?}"
        );
        // The rule works: a worktree nested in the main tree leaves the main tree clean.
        let session = rig.start(&first).await.expect("session starts");
        let status = git_run(&rig.git, &rig.repo, &["status", "--porcelain"]);
        assert!(status.trim().is_empty(), "main tree is dirty: {status:?}");

        rig.end_and_settle(&session).await;
        rig.store.close().await.expect("store closes");
    }

    /// The repair, which is the half `add_project` cannot do.
    ///
    /// `add_project` runs once per project ever, so a project recorded before the exclude code
    /// existed — or one whose write failed — stayed unexcluded for good and dirtied the
    /// operator's own repository with `?? .brigadier/` (**measured on brigadier-ai itself,
    /// 2026-09-02**). The app-start sweep is what makes it self-healing, and it must not
    /// clobber whatever else the operator keeps in that file.
    // see docs/research/worktree-git.md §1.
    #[tokio::test(flavor = "multi_thread")]
    async fn app_start_rewrites_an_exclude_line_a_project_has_lost() {
        const OPERATORS_OWN: &str = "# operator's own excludes\nscratch.txt\n";

        let rig = Rig::new(true);
        rig.project().await;
        assert!(rig.exclude_text().lines().any(|l| l.trim() == EXCLUDE_PATTERN));

        // As a project added before `exclude_project` existed would look.
        let exclude = rig.repo.join(".git").join("info").join("exclude");
        std::fs::write(&exclude, OPERATORS_OWN).expect("exclude rewritten");
        assert!(!rig.exclude_text().lines().any(|l| l.trim() == EXCLUDE_PATTERN));

        rig.sup.prune_worktrees().await;

        let text = rig.exclude_text();
        assert_eq!(
            text.lines().filter(|l| l.trim() == EXCLUDE_PATTERN).count(),
            1,
            "app start did not restore exactly one exclude line: {text:?}"
        );
        assert!(text.contains("scratch.txt"), "the operator's own lines were lost: {text:?}");

        // And it is still idempotent: a second launch changes nothing.
        rig.sup.prune_worktrees().await;
        assert_eq!(rig.exclude_text(), text, "a second launch rewrote the file");

        rig.store.close().await.expect("store closes");
    }

    /// A repository with no commits cannot be branched from, and refusing beats orphaning.
    // see docs/research/worktree-git.md §3.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_unborn_head_refuses_the_start_instead_of_orphaning_a_worktree() {
        let rig = Rig::new(false);
        let project = rig.project().await;

        let e = rig.start(&project).await.expect_err("an unborn HEAD must refuse");
        assert_eq!(e.code(), "worktree_unborn_head", "{e}");
        assert!(e.to_string().contains("commit"), "{e}");
        assert!(!rig.repo.join(WORKTREES_SUBDIR).exists(), "nothing was created");
        assert!(rig.branches().is_empty(), "{:?}", rig.branches());

        rig.store.close().await.expect("store closes");
    }

    /// git 2.50.1 creates the branch before it validates the path, so a failed `add` leaks one.
    /// The start must refuse *and* leave nothing behind.
    // see docs/research/worktree-git.md §5.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_pre_existing_branch_refuses_the_start_and_leaves_no_worktree() {
        let rig = Rig::new(true);
        let project = rig.project().await;

        // Take the id the next start would use by starting one, reading its branch, ending it,
        // removing the worktree, and re-using the name: the only way to collide deterministically
        // on a random id.
        let first = rig.start(&project).await.expect("session starts");
        let row = rig.row(&first).await;
        let branch = row.branch.clone().expect("branch");
        let path = row.worktree_path.clone().expect("path");
        rig.end_and_settle(&first).await;
        worktree::remove(&rig.git, &rig.repo, &path, RemoveForce::Discard)
            .await
            .expect("remove");

        // Now force the next id to be that one by creating the directory-free collision: recreate
        // the branch and point `prepare` at it directly, which is what a collision looks like.
        let spec = WorktreeSpec {
            repo: rig.repo.clone(),
            path: rig.repo.join(WORKTREES_SUBDIR).join("collide"),
            branch: branch.clone(),
            base: BASE.to_owned(),
        };
        let e = add_or_rollback(&rig.git, &spec).await.expect_err("the branch is taken");
        let e = SupervisorError::from(e);
        assert_eq!(e.code(), "worktree_branch_exists", "{e}");
        assert!(!spec.path.exists(), "a refused add must leave no directory");
        assert!(rig.branches().contains(&branch), "the operator's branch survives");

        // And the rollback rule: a failure that is *not* BranchExists must not leak a branch.
        std::fs::create_dir_all(rig.repo.join(WORKTREES_SUBDIR).join("occupied"))
            .expect("mkdir");
        std::fs::write(rig.repo.join(WORKTREES_SUBDIR).join("occupied").join("x"), "x")
            .expect("write");
        let blocked = WorktreeSpec {
            repo: rig.repo.clone(),
            path: rig.repo.join(WORKTREES_SUBDIR).join("occupied"),
            branch: format!("{BRANCH_PREFIX}deadbeef"),
            base: BASE.to_owned(),
        };
        let e = add_or_rollback(&rig.git, &blocked).await.expect_err("the path is occupied");
        assert!(matches!(e, WorktreeError::PathExists(_)), "{e:?}");
        assert!(
            !rig.branches().contains(&blocked.branch),
            "the leaked branch was not rolled back: {:?}",
            rig.branches()
        );

        rig.store.close().await.expect("store closes");
    }

    /// Cleanup is explicit, refuses to discard work without being told twice, and never touches
    /// the branch — the branch is the only copy of what the agent committed.
    // see docs/research/worktree-git.md §4 and "Risks" 1.
    #[tokio::test(flavor = "multi_thread")]
    async fn cleanup_refuses_a_dirty_worktree_until_forced_and_always_keeps_the_branch() {
        let rig = Rig::new(true);
        let project = rig.project().await;
        let session = rig.start(&project).await.expect("session starts");
        let row = rig.row(&session).await;
        let path = row.worktree_path.clone().expect("path");
        let branch = row.branch.clone().expect("branch");

        // Live sessions are refused outright: the child is running in that directory.
        let e = rig
            .sup
            .cleanup_worktree(&session, true)
            .await
            .expect_err("a live session must be refused");
        assert_eq!(e.code(), "session_running", "{e}");

        rig.end_and_settle(&session).await;
        std::fs::write(path.join("f.txt"), "edited\n").expect("dirty a tracked file");
        std::fs::write(path.join("new.txt"), "new\n").expect("add an untracked file");

        let refused = rig.sup.cleanup_worktree(&session, false).await.expect("counts");
        assert!(!refused.removed, "{refused:?}");
        assert_eq!(refused.dirty_files, 2, "{refused:?}");
        assert_eq!(refused.branch, branch);
        assert!(path.exists(), "a refused cleanup must not delete anything");

        let forced = rig.sup.cleanup_worktree(&session, true).await.expect("forced cleanup");
        assert!(forced.removed, "{forced:?}");
        assert_eq!(forced.branch, branch);
        assert!(!path.exists(), "the checkout is gone");
        assert!(rig.branches().contains(&branch), "the branch survives: {:?}", rig.branches());

        rig.store.close().await.expect("store closes");
    }

    /// A resume must land in the same checkout the first child ran in, or the agent loses its
    /// work and its transcript directory changes underneath it.
    // see docs/research/worktree-git.md §6 and docs/research/resume.md §7.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_resumed_session_reuses_its_stored_worktree_as_cwd() {
        let rig = Rig::new(true);
        let project = rig.project().await;
        let session = rig.start(&project).await.expect("session starts");
        let started = rig.row(&session).await;
        let path = started.worktree_path.clone().expect("path");
        rig.end_and_settle(&session).await;

        // The replay driver never names a provider session, so stand in for what a real
        // `SessionStarted` would have stored.
        let mut row = SessionRow::new(session.clone());
        row.resume_token = Some("provider-session-id".to_owned());
        rig.store.handle().upsert_session(row).await.expect("token stored");
        rig.store.handle().flush().await.expect("flush");

        rig.sup.resume_session(&session).await.expect("resume");
        let resumed = rig.row(&session).await;
        assert_eq!(
            resumed.cwd.as_deref(),
            Some(path.as_path()),
            "the resumed child must run in the same worktree"
        );
        assert_eq!(resumed.worktree_path, Some(path), "and the row must still record it");
        assert_eq!(resumed.branch, started.branch);

        rig.end_and_settle(&session).await;
        rig.store.close().await.expect("store closes");
    }

    /// A project that is not a repository is not an error: no git, no worktree, no branch, and
    /// the session runs in the project root.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_project_that_is_not_a_git_repository_runs_in_its_root_with_no_branch() {
        let rig = Rig::new(true);
        let plain = rig.dir.path().join("plain");
        std::fs::create_dir(&plain).expect("mkdir");
        let project = rig.sup.add_project(plain.clone()).await.expect("project added");

        let session = rig
            .sup
            .start_session(&project.id, &rig.kind, StartSession::new(plain.clone()))
            .await
            .expect("session starts");
        let row = rig.row(&session).await;
        assert_eq!(row.worktree_path, None, "no worktree");
        assert_eq!(row.branch, None, "no branch");
        assert!(same_path(row.cwd.as_deref().expect("cwd"), &plain), "{:?}", row.cwd);

        rig.end_and_settle(&session).await;
        rig.store.close().await.expect("store closes");
    }

    /// `git worktree remove` without `--force` deletes ignored files (**measured**), so a count
    /// that skipped them would hand the operator "clean, safe to remove" over their own `.env`.
    // see docs/research/worktree-git.md "Measured 2026-09-02".
    #[tokio::test(flavor = "multi_thread")]
    async fn a_worktree_holding_only_gitignored_files_is_dirty_and_survives_an_unforced_cleanup() {
        let rig = Rig::new(true);
        std::fs::write(rig.repo.join(".gitignore"), "node_modules/\n.env\n").expect("write");
        git_run(&rig.git, &rig.repo, &["add", ".gitignore"]);
        git_run(&rig.git, &rig.repo, &["commit", "-qm", "ignore"]);

        let project = rig.project().await;
        let session = rig.start(&project).await.expect("session starts");
        let path = rig.row(&session).await.worktree_path.expect("path");
        rig.end_and_settle(&session).await;

        // Nothing tracked is touched and nothing untracked is visible: only ignored content.
        std::fs::write(path.join(".env"), "SECRET=hunter2\n").expect("write .env");
        std::fs::create_dir(path.join("node_modules")).expect("mkdir node_modules");
        std::fs::write(path.join("node_modules").join("big.js"), "//\n").expect("write");
        let plain = git_run(&rig.git, &path, &["status", "--porcelain"]);
        assert!(plain.trim().is_empty(), "the plain porcelain sees nothing: {plain:?}");

        let refused = rig.sup.cleanup_worktree(&session, false).await.expect("counts");
        assert!(!refused.removed, "ignored content must not be removed unasked: {refused:?}");
        assert!(refused.dirty_files >= 1, "{refused:?}");
        assert!(path.join(".env").is_file(), "the operator's .env was deleted");
        assert!(path.join("node_modules").join("big.js").is_file(), "node_modules was deleted");

        rig.store.close().await.expect("store closes");
    }

    /// `status.showUntrackedFiles=no` in the operator's own config blinds `--porcelain`
    /// completely (**measured**), so the count forces it back on.
    // see docs/research/worktree-git.md "Measured 2026-09-02".
    #[tokio::test(flavor = "multi_thread")]
    async fn an_operator_config_hiding_untracked_files_cannot_hide_them_from_the_count() {
        let rig = Rig::new(true);
        git_run(&rig.git, &rig.repo, &["config", "status.showUntrackedFiles", "no"]);
        let project = rig.project().await;
        let session = rig.start(&project).await.expect("session starts");
        let path = rig.row(&session).await.worktree_path.expect("path");
        rig.end_and_settle(&session).await;

        std::fs::write(path.join("NOTES.md"), "a whole session of work\n").expect("write");
        let blinded = git_run(&rig.git, &path, &["status", "--porcelain"]);
        assert!(blinded.trim().is_empty(), "the config really does blind git: {blinded:?}");

        let refused = rig.sup.cleanup_worktree(&session, false).await.expect("counts");
        assert!(!refused.removed, "{refused:?}");
        assert_eq!(refused.dirty_files, 1, "{refused:?}");
        assert!(path.join("NOTES.md").is_file(), "the operator's work was deleted");

        rig.store.close().await.expect("store closes");
    }

    /// A resume is reserved before its child is spawned and files its live entry only after, so
    /// `is_live` is false for a whole process spawn while a child is about to run in the
    /// worktree. Cleanup must refuse for that window too.
    // see docs/research/resume.md §9.
    #[tokio::test(flavor = "multi_thread")]
    async fn cleanup_is_refused_while_a_resume_is_reserved_but_not_yet_live() {
        let rig = Rig::new(true);
        let project = rig.project().await;
        let session = rig.start(&project).await.expect("session starts");
        rig.end_and_settle(&session).await;
        assert!(!rig.sup.is_live(&session), "the precondition: nothing is live");

        rig.sup.inner.reserve_resume(&session).expect("reserved");
        let e = rig
            .sup
            .cleanup_worktree(&session, true)
            .await
            .expect_err("a reserved resume must refuse cleanup");
        assert_eq!(e.code(), "session_running", "{e}");

        // Releasing the reservation is what `ResumeGuard::drop` does; cleanup works again after.
        crate::lock(&rig.sup.inner.resuming).remove(&session);
        let cleaned = rig.sup.cleanup_worktree(&session, true).await.expect("cleanup");
        assert!(cleaned.removed, "{cleaned:?}");

        rig.store.close().await.expect("store closes");
    }

    /// A project root inside someone else's repository would get a checkout of the *whole*
    /// repository with the child two levels from where the operator pointed (**measured**).
    // see docs/research/worktree-git.md "Measured 2026-09-02".
    #[tokio::test(flavor = "multi_thread")]
    async fn a_project_below_the_repository_root_refuses_instead_of_checking_out_the_whole_repo() {
        let rig = Rig::new(true);
        let nested = rig.repo.join("apps").join("web");
        std::fs::create_dir_all(&nested).expect("mkdir");
        let project = rig.sup.add_project(nested.clone()).await.expect("project added");

        let e = rig
            .sup
            .start_session(&project.id, &rig.kind, StartSession::new(nested.clone()))
            .await
            .expect_err("a subdirectory project must refuse");
        assert_eq!(e.code(), "worktree", "{e}");
        let message = e.to_string();
        assert!(message.contains("not its root"), "{message}");
        assert!(message.contains("add the repository root"), "{message}");
        assert!(!nested.join(WORKTREES_SUBDIR).exists(), "nothing was created");
        assert!(
            rig.branches().iter().all(|b| !b.starts_with(BRANCH_PREFIX)),
            "a branch leaked: {:?}",
            rig.branches()
        );

        rig.store.close().await.expect("store closes");
    }

    /// The rollback path: a driver that will not come up must leave neither a checkout nor a
    /// branch behind for a session that never existed.
    // see docs/research/worktree-git.md §5.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_driver_that_refuses_to_start_leaves_no_worktree_and_no_branch() {
        let rig = Rig::new(true);
        let project = rig.project().await;
        let refusing = RefusingDriver::new();
        let kind = refusing.kind();
        rig.sup.register_driver(Arc::new(refusing));

        let before = rig.branches();
        let e = rig
            .sup
            .start_session(&project, &kind, StartSession::new(rig.repo.clone()))
            .await
            .expect_err("the driver refuses");
        assert_eq!(e.code(), "driver", "{e}");

        assert_eq!(rig.branches(), before, "a branch leaked: {:?}", rig.branches());
        let worktrees = rig.repo.join(WORKTREES_SUBDIR);
        let left: Vec<PathBuf> = std::fs::read_dir(&worktrees)
            .map(|entries| entries.filter_map(|e| e.ok()).map(|e| e.path()).collect())
            .unwrap_or_default();
        assert!(left.is_empty(), "a checkout was left behind: {left:?}");
        assert_eq!(
            worktree::list(&rig.git, &rig.repo).await.expect("list").len(),
            1,
            "git still registers a worktree"
        );

        rig.store.close().await.expect("store closes");
    }

    // ---------------------------------------------------------------------------------------
    // The destructive states. Each of these was a defect listed in `docs/STATUS.md` §5 and each
    // was reproduced against real git before the code was written.
    // see docs/research/worktree-cleanup.md.
    // ---------------------------------------------------------------------------------------

    /// **The launch sweep used to make a renamed project unrecoverable.** `prune_project` now
    /// repairs first, and repair recovers everything a move broke — including the agent's
    /// uncommitted work.
    // see docs/research/worktree-cleanup.md §1.4 and "Hard rules" 7.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_launch_sweep_repairs_a_renamed_project_before_it_prunes() {
        let rig = Rig::new(true);
        let project = rig.project().await;
        let session = rig.start(&project).await.expect("session starts");
        let path = rig.row(&session).await.worktree_path.expect("path");
        rig.end_and_settle(&session).await;
        std::fs::write(path.join("NOTES.md"), "a whole session of work\n").expect("write");

        // The operator renames the project folder. Both recorded absolute paths are now stale.
        let renamed = rig.dir.path().join("renamed");
        std::fs::rename(&rig.repo, &renamed).expect("rename the project");
        let moved_path = renamed.join(path.strip_prefix(&rig.repo).unwrap_or(Path::new("")));
        let stale = worktree::list(&rig.git, &renamed).await.expect("list");
        assert_eq!(
            stale.iter().filter(|w| w.prunable.is_some()).count(),
            1,
            "the precondition: the move broke the entry: {stale:#?}"
        );

        prune_project(&renamed).await;

        let all = worktree::list(&rig.git, &renamed).await.expect("list");
        assert_eq!(all.len(), 2, "the entry survived the sweep: {all:#?}");
        assert!(all.iter().all(|w| w.prunable.is_none()), "and it is healthy again: {all:#?}");
        assert_eq!(
            dirty_count(&rig.git, &moved_path).await.expect("status works again"),
            1,
            "the agent's uncommitted work is reachable again"
        );

        rig.store.close().await.expect("store closes");
    }

    /// A crash partway through `git worktree add` leaves `locked initializing`, which `prune`,
    /// `remove` and `remove --force` all refuse and which keeps the branch undeleteable forever.
    /// The rollback is the one caller allowed to escalate to `-f -f`, and only for that reason.
    // see docs/research/worktree-cleanup.md §1.1 and "Hard rules" 4.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_rollback_clears_the_locked_initializing_residue_of_a_killed_add() {
        let rig = Rig::new(true);
        let path = rig.repo.join(WORKTREES_SUBDIR).join("aaaa1111");
        let branch = format!("{BRANCH_PREFIX}aaaa1111");
        let made = add_or_rollback(
            &rig.git,
            &WorktreeSpec {
                repo: rig.repo.clone(),
                path: path.clone(),
                branch: branch.clone(),
                base: BASE.to_owned(),
            },
        )
        .await
        .expect("add");
        // Exactly the state a `SIGKILL`ed `worktree add` leaves behind (**measured**).
        git_run(
            &rig.git,
            &rig.repo,
            &["worktree", "lock", "--reason", "initializing", made.path.to_str().expect("utf-8")],
        );
        // The precondition: nothing gentler gets out of it.
        assert!(matches!(
            worktree::remove(&rig.git, &rig.repo, &made.path, RemoveForce::Discard).await,
            Err(WorktreeError::Locked(_))
        ));

        Prepared {
            git: rig.git.clone(),
            repo: rig.repo.clone(),
            path: made.path.clone(),
            branch: branch.clone(),
        }
        .roll_back()
        .await;

        assert!(!made.path.exists(), "the half-built checkout is gone");
        assert!(!rig.branches().contains(&branch), "and its branch: {:?}", rig.branches());
        assert_eq!(worktree::list(&rig.git, &rig.repo).await.expect("list").len(), 1);

        rig.store.close().await.expect("store closes");
    }

    /// A lock we did not take is somebody's claim on the directory. `force` is the operator
    /// saying "discard my changes", not "override another process", so it does not reach this.
    // see docs/research/worktree-cleanup.md §1.8 and "Hard rules" 4.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_lock_taken_by_something_else_refuses_cleanup_even_when_forced() {
        let rig = Rig::new(true);
        let project = rig.project().await;
        let session = rig.start(&project).await.expect("session starts");
        let path = rig.row(&session).await.worktree_path.expect("path");
        rig.end_and_settle(&session).await;
        git_run(
            &rig.git,
            &rig.repo,
            &["worktree", "lock", "--reason", "operator is using it", path.to_str().expect("utf-8")],
        );

        for force in [false, true] {
            let out = rig.sup.cleanup_worktree(&session, force).await.expect("answers");
            assert!(!out.removed, "force={force}: {out:?}");
            assert_eq!(out.blocked, Some(CleanupBlocked::Locked), "force={force}: {out:?}");
            assert!(path.join("f.txt").is_file(), "force={force}: the checkout must survive");
        }

        rig.store.close().await.expect("store closes");
    }

    /// **`removed: true` used to be reachable over a directory full of the agent's files.** A
    /// checkout git no longer registers is refused and named, never `rm -rf`'d — the exact
    /// fallback Claude Code shipped and withdrew in v2.1.143 for destroying gitignored files.
    // see docs/research/worktree-cleanup.md §1.3(b), §1.4 and "Hard rules" 1 and 11.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_checkout_git_no_longer_registers_is_refused_and_left_alone() {
        let rig = Rig::new(true);
        let project = rig.project().await;
        let session = rig.start(&project).await.expect("session starts");
        let path = rig.row(&session).await.worktree_path.expect("path");
        rig.end_and_settle(&session).await;
        std::fs::write(path.join("NOTES.md"), "work\n").expect("write");

        // The admin directory goes, the checkout stays: §1.3(b), and also what a prune-before-
        // repair used to produce on every launch after a rename.
        let id = path.file_name().expect("id").to_owned();
        std::fs::remove_dir_all(rig.repo.join(".git").join("worktrees").join(&id))
            .expect("delete the admin dir");
        assert!(dirty_count(&rig.git, &path).await.is_err(), "git cannot describe it any more");

        for force in [false, true] {
            let out = rig.sup.cleanup_worktree(&session, force).await.expect("answers");
            assert!(!out.removed, "force={force}: {out:?}");
            assert_eq!(out.blocked, Some(CleanupBlocked::Unregistered), "force={force}: {out:?}");
            assert!(path.join("NOTES.md").is_file(), "force={force}: the work must survive");
        }

        rig.store.close().await.expect("store closes");
    }

    /// **The unforced remove used to ignore commits entirely.** A clean worktree carrying commits
    /// no other ref holds removed with exit 0 in silence; now it is a refusal that says how many.
    // see docs/research/worktree-cleanup.md §2.6 rung 1 and §6.2.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_clean_worktree_carrying_its_own_commits_refuses_until_forced() {
        let rig = Rig::new(true);
        let project = rig.project().await;
        let session = rig.start(&project).await.expect("session starts");
        let row = rig.row(&session).await;
        let path = row.worktree_path.clone().expect("path");
        let branch = row.branch.clone().expect("branch");
        rig.end_and_settle(&session).await;

        std::fs::write(path.join("a.txt"), "a\n").expect("write");
        git_run(&rig.git, &path, &["add", "a.txt"]);
        git_run(&rig.git, &path, &["commit", "-qm", "the agent's work"]);
        let plain = git_run(&rig.git, &path, &["status", "--porcelain"]);
        assert!(plain.trim().is_empty(), "the tree is clean: {plain:?}");

        let refused = rig.sup.cleanup_worktree(&session, false).await.expect("counts");
        assert!(!refused.removed, "{refused:?}");
        assert_eq!(refused.blocked, Some(CleanupBlocked::Commits), "{refused:?}");
        assert_eq!(refused.dirty_files, 0, "{refused:?}");
        assert_eq!(refused.commits, 1, "{refused:?}");
        assert!(path.exists(), "a refused cleanup must not delete anything");

        let forced = rig.sup.cleanup_worktree(&session, true).await.expect("forced");
        assert!(forced.removed && forced.blocked.is_none(), "{forced:?}");
        assert_eq!(forced.commits, 1, "the count is still reported: {forced:?}");
        assert!(rig.branches().contains(&branch), "the branch keeps the commit");

        rig.store.close().await.expect("store closes");
    }

    /// **Safety decisions read `git worktree list --porcelain`, not `sessions.branch`.** An agent
    /// that checks out its own branch moves the session's real work to a ref nowhere in our
    /// database, and "we always keep the branch" would otherwise protect the wrong, empty one.
    // see docs/research/worktree-cleanup.md §1.5 and "Hard rules" 10.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_agent_that_checks_out_its_own_branch_stops_the_cleanup_and_is_named() {
        let rig = Rig::new(true);
        let project = rig.project().await;
        let session = rig.start(&project).await.expect("session starts");
        let row = rig.row(&session).await;
        let path = row.worktree_path.clone().expect("path");
        let recorded = row.branch.clone().expect("branch");
        rig.end_and_settle(&session).await;

        git_run(&rig.git, &path, &["checkout", "-q", "-b", "agents-own"]);
        std::fs::write(path.join("a.txt"), "a\n").expect("write");
        git_run(&rig.git, &path, &["add", "a.txt"]);
        git_run(&rig.git, &path, &["commit", "-qm", "the agent's work"]);

        let refused = rig.sup.cleanup_worktree(&session, false).await.expect("answers");
        assert!(!refused.removed, "{refused:?}");
        assert_eq!(refused.blocked, Some(CleanupBlocked::BranchMoved), "{refused:?}");
        assert_eq!(refused.branch, recorded, "the row's label is reported as the row's label");
        assert_eq!(
            refused.live_branch.as_deref(),
            Some("agents-own"),
            "and git's answer is reported as the fact: {refused:?}"
        );
        assert_eq!(refused.commits, 1, "counted against the live branch, not the stored one");
        assert!(path.exists(), "nothing was touched");

        let forced = rig.sup.cleanup_worktree(&session, true).await.expect("forced");
        assert!(forced.removed, "{forced:?}");
        assert!(
            rig.branches().contains(&"agents-own".to_owned()),
            "the branch actually holding the work survives: {:?}",
            rig.branches()
        );

        rig.store.close().await.expect("store closes");
    }

    /// A detached head is the other half of §1.5: no branch line at all, and `git branch -d` on
    /// our recorded name would then succeed while the worktree still exists.
    // see docs/research/worktree-cleanup.md §1.5.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_detached_head_is_reported_as_a_branch_that_moved() {
        let rig = Rig::new(true);
        let project = rig.project().await;
        let session = rig.start(&project).await.expect("session starts");
        let path = rig.row(&session).await.worktree_path.expect("path");
        rig.end_and_settle(&session).await;
        git_run(&rig.git, &path, &["checkout", "-q", "--detach", "HEAD"]);

        let refused = rig.sup.cleanup_worktree(&session, false).await.expect("answers");
        assert!(!refused.removed, "{refused:?}");
        assert_eq!(refused.blocked, Some(CleanupBlocked::BranchMoved), "{refused:?}");
        assert_eq!(refused.live_branch, None, "{refused:?}");

        rig.store.close().await.expect("store closes");
    }

    /// A project root that is itself a linked worktree passes the `NotRepositoryRoot` guard —
    /// `--show-toplevel` inside a linked worktree returns that worktree's own root — and then
    /// removing the outer worktree destroys the inner session's work while `dirty_count` reads 0.
    // see docs/research/worktree-cleanup.md §1.6.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_project_that_is_itself_a_linked_worktree_refuses_the_start() {
        let rig = Rig::new(true);
        let outer = rig.dir.path().join("outer");
        git_run(
            &rig.git,
            &rig.repo,
            &["worktree", "add", "-q", "-b", "outer", outer.to_str().expect("utf-8"), "HEAD"],
        );
        let project = rig.sup.add_project(outer.clone()).await.expect("project added");

        let e = rig
            .sup
            .start_session(&project.id, &rig.kind, StartSession::new(outer.clone()))
            .await
            .expect_err("a linked worktree must refuse");
        assert_eq!(e.code(), "worktree", "{e}");
        let message = e.to_string();
        assert!(message.contains("linked git worktree"), "{message}");
        assert!(!outer.join(WORKTREES_SUBDIR).exists(), "nothing was created");
        assert!(
            rig.branches().iter().all(|b| !b.starts_with(BRANCH_PREFIX)),
            "a branch leaked: {:?}",
            rig.branches()
        );

        rig.store.close().await.expect("store closes");
    }

    /// A worktree of a repository with submodules is checked out **incomplete and reads clean**,
    /// and then refuses removal categorically. Refusing the start is the honest answer; running
    /// `submodule update --init` in the operator's repository is not ours to decide.
    // see docs/research/worktree-cleanup.md §1.13.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_repository_with_submodules_refuses_the_start() {
        let rig = Rig::new(true);
        let inner = rig.dir.path().join("inner");
        std::fs::create_dir(&inner).expect("mkdir");
        git_run(&rig.git, &inner, &["init", "-q", "-b", "main", "."]);
        std::fs::write(inner.join("g.txt"), "g\n").expect("write");
        git_run(&rig.git, &inner, &["add", "g.txt"]);
        git_run(&rig.git, &inner, &["commit", "-qm", "inner"]);
        // `protocol.file.allow` because git refuses a file-transport submodule by default.
        git_run(
            &rig.git,
            &rig.repo,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                inner.to_str().expect("utf-8"),
                "sub",
            ],
        );
        git_run(&rig.git, &rig.repo, &["commit", "-qm", "add the submodule"]);

        let project = rig.project().await;
        let e = rig.start(&project).await.expect_err("submodules must refuse");
        assert_eq!(e.code(), "worktree", "{e}");
        assert!(e.to_string().contains("submodules"), "{e}");
        assert!(!rig.repo.join(WORKTREES_SUBDIR).exists(), "nothing was created");

        rig.store.close().await.expect("store closes");
    }

}
