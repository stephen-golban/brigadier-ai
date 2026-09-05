//! `delete_session` and `delete_project`, end to end against throwaway git repositories.
//!
//! No `claude` process is spawned: every session here is driven by [`ReplayDriver`]. Every path
//! is under a `tempfile::tempdir()` — the owner's data directory is never opened, and neither is
//! this repository.
//!
//! What each test pins is the *refusal*, not the happy path. A delete that removes the rows is
//! easy; a delete that refuses over a live child, or over a branch carrying commits nothing else
//! keeps, is the part that has to be true.
// see docs/vision.md §8 and docs/research/worktree-cleanup.md "Hard rules".

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use brigadier_core::driver::{DriverKind, ProviderDriver, StartSession};
use brigadier_core::event::{Event, ItemId, ItemKind, SessionId};
use brigadier_core::worktree::resolve_git;
use brigadier_store::Store;
use brigadier_supervisor::{ReplayDriver, Supervisor, SupervisorConfig, SupervisorError, VecSink};
use tempfile::TempDir;

/// A throwaway git repository, a store in its own directory, and a supervisor over both.
struct Rig {
    dir: TempDir,
    repo: PathBuf,
    git: PathBuf,
    data: PathBuf,
    store: Store,
    sup: Supervisor,
    kind: DriverKind,
}

impl Rig {
    fn new() -> Rig {
        let git = resolve_git().expect("git on PATH");
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).expect("mkdir repo");
        git_run(&git, &repo, &["init", "-q", "-b", "main", "."]);
        // A throwaway repo needs an initial commit: `worktree add … HEAD` has nothing to branch
        // from against an unborn head, and every session here needs a worktree.
        std::fs::write(repo.join("f.txt"), "hi\n").expect("write");
        git_run(&git, &repo, &["add", "f.txt"]);
        git_run(&git, &repo, &["commit", "-qm", "init"]);

        let data = dir.path().join("data");
        std::fs::create_dir(&data).expect("mkdir data");
        let store = Store::open(&data).expect("store opens");
        let sup = Supervisor::new(SupervisorConfig::new(
            store.handle().clone(),
            store.run_id().to_owned(),
            data.clone(),
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
        Rig {
            dir,
            repo,
            git,
            data,
            store,
            sup,
            kind,
        }
    }

    async fn project(&self) -> String {
        self.sup
            .add_project(self.repo.clone())
            .await
            .expect("project added")
            .id
    }

    async fn start(&self, project: &str) -> SessionId {
        self.sup
            .start_session(project, &self.kind, StartSession::new(self.repo.clone()))
            .await
            .expect("session starts")
    }

    async fn worktree_of(&self, id: &SessionId) -> PathBuf {
        self.store.handle().flush().await.expect("flush");
        self.sup
            .session(id)
            .await
            .expect("read")
            .expect("row")
            .worktree_path
            .expect("the session has a worktree")
    }

    fn branches(&self) -> Vec<String> {
        git_run(
            &self.git,
            &self.repo,
            &["branch", "--format=%(refname:short)"],
        )
        .lines()
        .map(str::to_owned)
        .collect()
    }

    /// End the session and wait until it has left the live map. A delete refuses while it has not.
    async fn end_and_settle(&self, id: &SessionId) {
        self.sup.end_session(id).await.expect("end");
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.sup.is_live(id) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!self.sup.is_live(id), "the session never left the live map");
        self.store.handle().flush().await.expect("flush");
    }

    fn raw_logs(&self, id: &SessionId) -> Vec<PathBuf> {
        brigadier_store::ndjson::log_files(&self.data, id)
    }
}

fn git_run(git: &Path, cwd: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new(git)
        .arg("-C")
        .arg(cwd)
        .args([
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "user.name=test",
        ])
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

/// The whole of `docs/vision.md` §8 in one test: the rows go, the feed goes, the raw log goes,
/// the checkout goes — and the branch stays.
#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_session_removes_history_and_preserves_its_worktree() {
    let rig = Rig::new();
    let project = rig.project().await;
    let session = rig.start(&project).await;
    let worktree = rig.worktree_of(&session).await;
    rig.end_and_settle(&session).await;

    assert!(worktree.is_dir(), "precondition: the checkout exists");
    assert!(
        !rig.raw_logs(&session).is_empty(),
        "precondition: a raw log exists"
    );
    let branch = rig
        .sup
        .session(&session)
        .await
        .expect("read")
        .expect("row")
        .branch
        .expect("branch");

    let out = rig
        .sup
        .delete_session(&session, false)
        .await
        .expect("delete");

    assert!(out.removed, "{out:?}");
    assert_eq!(out.rows.sessions, 1);
    assert!(
        out.rows.feed > 0,
        "the session's feed rows went with it: {:?}",
        out.rows
    );
    assert_eq!(out.logs_removed, 1, "the raw NDJSON log went too");
    assert_eq!(
        out.branch.as_deref(),
        Some(branch.as_str()),
        "the report names the branch"
    );
    assert_eq!(out.worktree.as_ref().and_then(|w| w.blocked), None);
    assert!(out.worktree.is_none());

    assert!(worktree.exists(), "the checkout must remain on disk");
    assert!(
        rig.raw_logs(&session).is_empty(),
        "the raw log is still on disk"
    );
    assert!(
        rig.sup.session(&session).await.expect("read").is_none(),
        "the row survived"
    );
    assert!(rig
        .sup
        .feed_tail(&session, 10)
        .await
        .expect("feed")
        .is_empty());
    assert!(
        rig.branches().contains(&branch),
        "the branch must survive a delete: {:?}",
        rig.branches()
    );

    rig.store.close().await.expect("store closes");
    drop(rig.dir);
}

/// Deleting a running chat stops it without requiring a separate action.
#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_live_session_stops_it_and_does_not_recreate_history() {
    let rig = Rig::new();
    let project = rig.project().await;
    let session = rig.start(&project).await;
    let worktree = rig.worktree_of(&session).await;
    let out = rig
        .sup
        .delete_session(&session, false)
        .await
        .expect("delete live session");
    assert!(out.removed);
    assert!(!rig.sup.is_live(&session));
    assert!(worktree.is_dir());
    rig.store.handle().flush().await.expect("flush");
    assert!(rig.sup.session(&session).await.expect("read").is_none());
    assert!(rig
        .sup
        .feed_tail(&session, 10)
        .await
        .expect("feed")
        .is_empty());
    rig.store.close().await.expect("store closes");
}

/// A branch carrying commits no other ref keeps is not silently destroyed.
///
/// The count comes from `git rev-list --count`, never from `git`'s `cherry` subcommand, which
/// reports work unmerged after a squash-merge and reports it merged when it was applied upstream
/// and then reverted (**measured**, `docs/research/worktree-cleanup.md` §§2.2–2.4).
#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_locked_dirty_session_preserves_unmerged_commits_and_files() {
    let rig = Rig::new();
    let project = rig.project().await;
    let session = rig.start(&project).await;
    let worktree = rig.worktree_of(&session).await;
    rig.end_and_settle(&session).await;

    // What an agent leaves behind: a commit on its own branch and nowhere else.
    std::fs::write(worktree.join("work.txt"), "the agent's work\n").expect("write");
    git_run(&rig.git, &worktree, &["add", "work.txt"]);
    git_run(&rig.git, &worktree, &["commit", "-qm", "the agent's work"]);

    std::fs::write(worktree.join("untracked.txt"), "keep me").expect("write");
    std::fs::write(worktree.join(".env"), "fixture only").expect("write");
    git_run(
        &rig.git,
        &rig.repo,
        &["worktree", "lock", worktree.to_str().unwrap()],
    );
    let removed = rig
        .sup
        .delete_session(&session, false)
        .await
        .expect("delete locked session");
    assert!(removed.removed);
    assert!(removed.worktree.is_none());
    let branch = removed.branch.expect("branch");
    assert!(worktree.is_dir());
    assert_eq!(
        std::fs::read_to_string(worktree.join("untracked.txt")).unwrap(),
        "keep me"
    );
    assert_eq!(
        std::fs::read_to_string(worktree.join(".env")).unwrap(),
        "fixture only"
    );
    assert!(rig.sup.session(&session).await.expect("read").is_none());
    assert!(rig.branches().contains(&branch));
    let log = git_run(&rig.git, &rig.repo, &["log", "--oneline", &branch]);
    assert!(
        log.contains("the agent's work"),
        "the commit must survive the delete: {log:?}"
    );

    rig.store.close().await.expect("store closes");
    drop(rig.dir);
}

/// Deleting a project takes every session under it — rows, logs and checkouts.
#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_project_takes_its_sessions_with_it() {
    let rig = Rig::new();
    let project = rig.project().await;
    let first = rig.start(&project).await;
    let first_tree = rig.worktree_of(&first).await;
    rig.end_and_settle(&first).await;
    let second = rig.start(&project).await;
    let second_tree = rig.worktree_of(&second).await;
    rig.end_and_settle(&second).await;

    assert!(
        first_tree.is_dir() && second_tree.is_dir(),
        "precondition: two checkouts"
    );

    let out = rig
        .sup
        .delete_project(&project, false)
        .await
        .expect("delete");

    assert!(out.removed, "{out:?}");
    assert_eq!(out.rows.projects, 1);
    assert_eq!(out.rows.sessions, 2, "{:?}", out.rows);
    assert!(out.rows.feed > 0);
    assert!(out.worktrees.is_empty());
    assert!(out
        .worktrees
        .iter()
        .all(|w| w.cleanup.removed && w.cleanup.blocked.is_none()));
    assert_eq!(out.logs_removed, 2);
    assert!(!out.brigadier_dir_removed);

    assert!(first_tree.exists() && second_tree.exists());
    assert!(rig.repo.join(".brigadier").exists());
    assert!(rig.sup.project(&project).await.expect("read").is_none());
    assert!(rig.sup.session(&first).await.expect("read").is_none());
    assert!(rig.sup.session(&second).await.expect("read").is_none());
    assert!(rig.sup.list_sessions().await.expect("read").is_empty());
    // Two branches plus `main`: no cleanup path deletes a branch, project delete included.
    assert_eq!(rig.branches().len(), 3, "{:?}", rig.branches());

    rig.store.close().await.expect("store closes");
    drop(rig.dir);
}

/// A project with one live session refuses **whole**, before any other session is touched.
///
/// The alternative — delete the settled sessions and then stop — is the half-succeeded delete
/// this surface exists to avoid.
#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_project_stops_live_sessions_and_preserves_all_local_files() {
    let rig = Rig::new();
    let project = rig.project().await;
    let settled = rig.start(&project).await;
    let settled_tree = rig.worktree_of(&settled).await;
    rig.end_and_settle(&settled).await;
    let live = rig.start(&project).await;
    let live_tree = rig.worktree_of(&live).await;

    git_run(
        &rig.git,
        &rig.repo,
        &["worktree", "lock", settled_tree.to_str().unwrap()],
    );
    std::fs::write(live_tree.join("local.txt"), "keep local work").unwrap();
    let out = rig
        .sup
        .delete_project(&project, false)
        .await
        .expect("remove project");
    assert!(out.removed);
    assert!(!rig.sup.is_live(&live));
    assert!(settled_tree.is_dir() && live_tree.is_dir());
    assert_eq!(
        std::fs::read_to_string(live_tree.join("local.txt")).unwrap(),
        "keep local work"
    );
    assert_eq!(
        std::fs::read_to_string(rig.repo.join("f.txt")).unwrap(),
        "hi\n"
    );
    assert!(rig.sup.project(&project).await.expect("read").is_none());
    assert!(rig.sup.list_sessions().await.expect("read").is_empty());
    let readded = rig
        .sup
        .add_project(rig.repo.clone())
        .await
        .expect("re-add project");
    assert!(rig.sup.project(&readded.id).await.expect("read").is_some());
    rig.store.close().await.expect("store closes");
    drop(rig.dir);
}

/// A session that never had a worktree — a project that is not a git repository — deletes
/// cleanly rather than erroring on a checkout that was never there.
///
/// This is the owner's forty synthetic burn rows: they run in a temp directory with
/// `worktree_path: null`.
#[tokio::test(flavor = "multi_thread")]
async fn a_session_with_no_worktree_deletes_without_complaint() {
    let rig = Rig::new();
    let plain = rig.dir.path().join("not-a-repo");
    std::fs::create_dir(&plain).expect("mkdir");
    let project = rig
        .sup
        .add_project(plain.clone())
        .await
        .expect("project")
        .id;
    let session = rig
        .sup
        .start_session(&project, &rig.kind, StartSession::new(plain.clone()))
        .await
        .expect("session starts");
    rig.end_and_settle(&session).await;
    assert!(
        rig.sup
            .session(&session)
            .await
            .expect("read")
            .expect("row")
            .worktree_path
            .is_none(),
        "precondition: no worktree"
    );

    let out = rig
        .sup
        .delete_session(&session, false)
        .await
        .expect("delete");
    assert!(out.removed, "{out:?}");
    assert!(out.worktree.is_none(), "there was no worktree to report on");
    assert_eq!(out.branch, None);
    assert!(rig.sup.session(&session).await.expect("read").is_none());

    rig.store.close().await.expect("store closes");
    drop(rig.dir);
}

/// Deleting something that is not there is `no_such_session` / `no_such_project`, not a panic.
#[tokio::test(flavor = "multi_thread")]
async fn deleting_what_does_not_exist_is_a_typed_error() {
    let rig = Rig::new();
    let missing = SessionId::new("nope");
    let err = rig
        .sup
        .delete_session(&missing, false)
        .await
        .expect_err("refuses");
    assert!(matches!(err, SupervisorError::NoSuchSession), "{err}");
    let err = rig
        .sup
        .delete_project("nope", false)
        .await
        .expect_err("refuses");
    assert!(matches!(err, SupervisorError::NoSuchProject), "{err}");

    rig.store.close().await.expect("store closes");
    drop(rig.dir);
}

/// The owner's actual case: forty synthetic burn rows under a project that is not a git
/// repository. No worktrees, no branches, nothing to refuse — the rows and the logs just go.
#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_project_that_is_not_a_repository_takes_its_sessions_too() {
    let rig = Rig::new();
    let plain = rig.dir.path().join("burn");
    std::fs::create_dir(&plain).expect("mkdir");
    let project = rig
        .sup
        .add_project(plain.clone())
        .await
        .expect("project")
        .id;
    let mut sessions = Vec::new();
    for _ in 0..3 {
        let id = rig
            .sup
            .start_session(&project, &rig.kind, StartSession::new(plain.clone()))
            .await
            .expect("session starts");
        rig.end_and_settle(&id).await;
        sessions.push(id);
    }

    let out = rig
        .sup
        .delete_project(&project, false)
        .await
        .expect("delete");
    assert!(out.removed, "{out:?}");
    assert_eq!(out.rows.sessions, 3);
    assert!(out.worktrees.is_empty(), "no session had a worktree");
    assert_eq!(out.logs_removed, 3);
    assert!(
        !out.brigadier_dir_removed,
        "there was never a .brigadier/ to remove"
    );
    for id in &sessions {
        assert!(
            rig.sup.session(id).await.expect("read").is_none(),
            "{id} survived"
        );
        assert!(rig.raw_logs(id).is_empty(), "{id}'s raw log survived");
    }
    assert!(rig.sup.list_sessions().await.expect("read").is_empty());
    assert!(
        plain.is_dir(),
        "the project directory itself is never removed"
    );

    rig.store.close().await.expect("store closes");
    drop(rig.dir);
}

/// A parked orchestration task cannot recreate a project after sidebar removal.
#[tokio::test(flavor = "multi_thread")]
async fn removing_a_project_cancels_its_orchestration_task() {
    use brigadier_supervisor::loop_::{barrier::barrier, RunSpec};
    let rig = Rig::new();
    let project = rig.project().await;
    let (_sender, waiting) = barrier();
    let run = rig
        .sup
        .start_run(RunSpec::new(
            project.clone(),
            "fixture",
            rig.kind.clone(),
            waiting,
        ))
        .await
        .expect("run");
    assert!(run.active());
    let out = rig
        .sup
        .delete_project(&project, false)
        .await
        .expect("delete");
    assert!(out.removed);
    assert!(!run.active());
    assert!(rig.sup.runs().is_empty());
    assert!(rig.sup.list_projects().await.unwrap().is_empty());
    assert!(rig.sup.list_sessions().await.unwrap().is_empty());
    assert!(rig.repo.is_dir());
    rig.store.close().await.unwrap();
}

#[tokio::test]
async fn deliberate_discard_removes_owned_dirty_worktree_branch_and_history() {
    let rig = Rig::new();
    let project = rig.project().await;
    let id = rig.start(&project).await;
    let path = rig.worktree_of(&id).await;
    std::fs::write(path.join("only-here"), "discard me").unwrap();
    let branch = rig.sup.session(&id).await.unwrap().unwrap().branch.unwrap();
    rig.sup.mark_deleting(&[id.clone()]);
    assert!(rig.sup.require_session_available(&id).is_err());
    rig.sup.discard_session(&id).await.unwrap();
    assert!(!rig.sup.is_live(&id));
    assert!(!path.exists());
    assert!(!rig.branches().contains(&branch));
    assert!(rig.sup.session(&id).await.unwrap().is_none());
    assert!(rig.raw_logs(&id).is_empty());
    assert!(rig.repo.join("f.txt").exists());
    rig.sup.discard_session(&id).await.unwrap();
    rig.sup.shutdown().await;
}

#[tokio::test]
async fn interactive_worktree_inherits_current_files_without_modifying_project() {
    let rig = Rig::new();
    let project = rig.project().await;
    std::fs::write(rig.repo.join("f.txt"), "dirty original").unwrap();
    std::fs::write(rig.repo.join("untracked"), "local file").unwrap();
    let before = git_run(&rig.git, &rig.repo, &["status", "--porcelain"]);
    let id = rig
        .sup
        .start_project_session(
            &project,
            &rig.kind,
            StartSession::new(rig.repo.clone()),
            true,
        )
        .await
        .unwrap();
    let path = rig.worktree_of(&id).await;
    assert_eq!(
        std::fs::read_to_string(path.join("f.txt")).unwrap(),
        "dirty original"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("untracked")).unwrap(),
        "local file"
    );
    std::fs::write(path.join("f.txt"), "agent change").unwrap();
    assert_eq!(
        std::fs::read_to_string(rig.repo.join("f.txt")).unwrap(),
        "dirty original"
    );
    let after = git_run(&rig.git, &rig.repo, &["status", "--porcelain"]);
    // App-owned .brigadier may appear as an untracked directory; original file state is exact.
    assert_eq!(
        before
            .lines()
            .filter(|l| !l.contains(".brigadier"))
            .collect::<Vec<_>>(),
        after
            .lines()
            .filter(|l| !l.contains(".brigadier"))
            .collect::<Vec<_>>()
    );
    rig.sup.discard_session(&id).await.unwrap();
    rig.sup.shutdown().await;
}
