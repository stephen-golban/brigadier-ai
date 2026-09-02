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
    self, add_or_rollback, check_ref_format, dirty_count, ensure_excluded, has_commits, is_repo,
    resolve_git, short_id, show_toplevel, WorktreeError, WorktreeSpec,
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

/// What [`crate::Supervisor::cleanup_worktree`] did, or refused to do.
///
/// `removed: false` with a non-zero `dirty_files` is the "are you sure" case: nothing was
/// touched, and the same call with `force = true` will discard that many entries.
///
/// `branch` is always the session's branch and it is **always still there**: no cleanup path
/// deletes a branch. The worktree is a reconstructible checkout; the branch is the only copy of
/// whatever the agent committed.
// see docs/research/worktree-git.md §4 and "Risks" 1.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorktreeCleanup {
    /// Whether the checkout is gone from disk and from `git worktree list`.
    pub removed: bool,
    /// Entries `git status --porcelain` reported in the worktree, one per line.
    pub dirty_files: u32,
    /// The session's branch, which survives every cleanup.
    pub branch: String,
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
    // see docs/research/worktree-git.md "Measured 2026-09-02".
    pub(crate) async fn roll_back(self) {
        if let Err(e) = worktree::remove(&self.git, &self.repo, &self.path, true).await {
            tracing::warn!(path = %self.path.display(), error = %e, "could not roll back the worktree");
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
    // Up front, so an unborn HEAD is a message with a remedy in it rather than git's
    // `fatal: invalid reference: HEAD` — or, with the base omitted, a silent orphan worktree.
    if !has_commits(&git, project_root).await? {
        return Err(SupervisorError::from(WorktreeError::UnbornHead(project_root.to_owned())));
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

/// `git worktree prune` for one project. Safe by construction: **measured**, prune never touches
/// a branch. Logged and swallowed.
// see docs/research/worktree-git.md §4.
pub(crate) async fn prune_project(project_root: &Path) {
    let Some(git) = resolve_git() else { return };
    if !is_repo(&git, project_root).await {
        return;
    }
    match worktree::prune(&git, project_root).await {
        Ok(()) => tracing::debug!(root = %project_root.display(), "worktrees pruned"),
        Err(e) => tracing::warn!(root = %project_root.display(), error = %e, "worktree prune failed"),
    }
}

/// Remove one session's checkout, keeping its branch.
///
/// Refuses on a dirty tree unless `force`, and reports the count either way. A checkout that is
/// already gone from disk is pruned out of git's registry and reported as removed.
// see docs/research/worktree-git.md §4.
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
        return Ok(WorktreeCleanup { removed: true, dirty_files: 0, branch });
    }
    let dirty = dirty_count(&git, path).await?;
    if dirty > 0 && !force {
        return Ok(WorktreeCleanup { removed: false, dirty_files: dirty, branch });
    }
    match worktree::remove(&git, repo, path, force).await {
        Ok(()) => Ok(WorktreeCleanup { removed: true, dirty_files: dirty, branch }),
        // Something dirtied the tree between the count and the remove. Report, do not force.
        Err(WorktreeError::Dirty(_)) => {
            let dirty = dirty_count(&git, path).await.unwrap_or(dirty.max(1));
            Ok(WorktreeCleanup { removed: false, dirty_files: dirty, branch })
        }
        Err(e) => Err(SupervisorError::from(e)),
    }
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
        worktree::remove(&rig.git, &rig.repo, &path, true).await.expect("remove");

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
}
