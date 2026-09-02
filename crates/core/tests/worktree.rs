//! Worktree behaviour, reproduced against the real `git` on this machine.
//!
//! Every test builds a throwaway repository in its own `tempfile::tempdir()` with one commit;
//! nothing here touches the checkout it runs from.

use std::path::{Path, PathBuf};
use std::process::Command;

use brigadier_core::worktree::{
    add, delete_branch, dirty_count, git_version, list, prune, remove, resolve_git, Worktree,
    WorktreeError, WorktreeSpec,
};
use tempfile::TempDir;

/// A scratch repo: `root/repo` with a single commit on `main`, and room beside it for worktrees.
struct Scratch {
    dir: TempDir,
    git: PathBuf,
}

impl Scratch {
    fn new() -> Self {
        let git = resolve_git().expect("git on PATH");
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).expect("mkdir repo");
        run(&git, &repo, &["init", "-q", "-b", "main", "."]);
        std::fs::write(repo.join("f.txt"), "hi\n").expect("write f.txt");
        run(&git, &repo, &["add", "f.txt"]);
        run(&git, &repo, &["commit", "-qm", "init"]);
        Self { dir, git }
    }

    fn repo(&self) -> PathBuf {
        self.dir.path().join("repo")
    }

    fn at(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn spec(&self, name: &str, branch: &str) -> WorktreeSpec {
        WorktreeSpec {
            repo: self.repo(),
            path: self.at(name),
            branch: branch.to_owned(),
            base: "HEAD".to_owned(),
        }
    }

    fn branches(&self) -> Vec<String> {
        run(&self.git, &self.repo(), &["branch", "--format=%(refname:short)"])
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn head(&self) -> String {
        run(&self.git, &self.repo(), &["rev-parse", "HEAD"]).trim().to_owned()
    }
}

/// Synchronous git for test *setup* only; identity is pinned so a missing user config cannot fail.
fn run(git: &Path, cwd: &Path, args: &[&str]) -> String {
    let out = Command::new(git)
        .arg("-C")
        .arg(cwd)
        .args(["-c", "user.email=test@example.invalid", "-c", "user.name=test"])
        .args(["-c", "commit.gpgsign=false"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// git canonicalises paths (on macOS `/var/…` is a symlink to `/private/var/…`).
fn same_path(reported: &Path, expected: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(reported) == canon(expected)
}

fn find<'a>(worktrees: &'a [Worktree], branch: &str) -> &'a Worktree {
    worktrees
        .iter()
        .find(|w| w.branch.as_deref() == Some(branch))
        .unwrap_or_else(|| panic!("no worktree on {branch} in {worktrees:#?}"))
}

#[tokio::test]
async fn git_version_reports_a_version() {
    let git = resolve_git().expect("git on PATH");
    let v = git_version(&git).await.expect("git --version");
    assert!(v.starts_with("git version"), "{v}");
}

#[tokio::test]
async fn add_creates_the_worktree_and_branch_and_list_shows_both() {
    let s = Scratch::new();
    let made = add(&s.git, &s.spec("wt", "feat")).await.expect("add");

    assert!(same_path(&made.path, &s.at("wt")), "{made:?}");
    assert_eq!(made.branch.as_deref(), Some("feat"));
    assert_eq!(made.head, s.head());
    assert!(!made.is_main);
    assert!(s.at("wt").join("f.txt").is_file());

    let all = list(&s.git, &s.repo()).await.expect("list");
    assert_eq!(all.len(), 2, "{all:#?}");
    let main = &all[0];
    assert!(main.is_main && same_path(&main.path, &s.repo()), "{main:?}");
    assert_eq!(main.branch.as_deref(), Some("main"));
    assert_eq!(main.head, s.head());
    let secondary = find(&all, "feat");
    assert!(!secondary.is_main && secondary.prunable.is_none() && secondary.locked.is_none());
}

#[tokio::test]
async fn add_with_an_existing_branch_fails_and_leaves_no_directory() {
    let s = Scratch::new();
    add(&s.git, &s.spec("wt", "feat")).await.expect("first add");

    // Observed on git 2.50.1: "fatal: a branch named 'feat' already exists".
    match add(&s.git, &s.spec("wt2", "feat")).await {
        Err(WorktreeError::BranchExists(b)) => assert_eq!(b, "feat"),
        other => panic!("expected BranchExists, got {other:?}"),
    }
    assert!(!s.at("wt2").exists(), "git left a directory behind");
    assert_eq!(list(&s.git, &s.repo()).await.expect("list").len(), 2);
}

#[tokio::test]
async fn add_onto_an_existing_non_empty_path_fails() {
    let s = Scratch::new();
    std::fs::create_dir(s.at("occupied")).expect("mkdir");
    std::fs::write(s.at("occupied").join("x"), "x").expect("write");

    // Observed on git 2.50.1: "fatal: '<path>' already exists".
    match add(&s.git, &s.spec("occupied", "feat")).await {
        Err(WorktreeError::PathExists(p)) => assert!(same_path(&p, &s.at("occupied")), "{p:?}"),
        other => panic!("expected PathExists, got {other:?}"),
    }
    assert!(s.at("occupied").join("x").is_file(), "the existing content must survive");
}

#[tokio::test]
async fn a_deleted_directory_is_prunable_blocks_re_add_and_prune_clears_it() {
    let s = Scratch::new();
    add(&s.git, &s.spec("wt", "feat")).await.expect("add");
    std::fs::remove_dir_all(s.at("wt")).expect("delete the worktree out from under git");

    let stale = list(&s.git, &s.repo()).await.expect("list");
    assert_eq!(
        find(&stale, "feat").prunable.as_deref(),
        Some("gitdir file points to non-existent location"),
        "{stale:#?}"
    );

    // Observed on git 2.50.1: "fatal: '<path>' is a missing but already registered worktree;".
    match add(&s.git, &s.spec("wt", "blocked")).await {
        Err(WorktreeError::PrunableEntryBlocks { path, reason }) => {
            assert!(same_path(&path, &s.at("wt")), "{path:?}");
            assert_eq!(reason, "gitdir file points to non-existent location");
        }
        other => panic!("expected PrunableEntryBlocks, got {other:?}"),
    }
    // git 2.50.1 creates the branch before it checks the path, so a failed `add` leaks it. The
    // module reports the failure and leaves the branch alone; teardown is `delete_branch`.
    assert!(s.branches().contains(&"blocked".to_owned()), "{:?}", s.branches());

    prune(&s.git, &s.repo()).await.expect("prune");
    let pruned = list(&s.git, &s.repo()).await.expect("list");
    assert_eq!(pruned.len(), 1, "{pruned:#?}");

    add(&s.git, &s.spec("wt", "other")).await.expect("add succeeds after prune");
    assert_eq!(list(&s.git, &s.repo()).await.expect("list").len(), 2);
}

#[tokio::test]
async fn remove_takes_a_clean_worktree_and_rejects_a_dirty_one_without_force() {
    let s = Scratch::new();
    add(&s.git, &s.spec("clean", "clean-branch")).await.expect("add clean");
    add(&s.git, &s.spec("dirty", "dirty-branch")).await.expect("add dirty");

    remove(&s.git, &s.repo(), &s.at("clean"), false).await.expect("clean remove");
    assert!(!s.at("clean").exists());

    std::fs::write(s.at("dirty").join("f.txt"), "edited\n").expect("dirty the tracked file");
    // Observed on git 2.50.1:
    // "fatal: '<path>' contains modified or untracked files, use --force to delete it".
    match remove(&s.git, &s.repo(), &s.at("dirty"), false).await {
        Err(WorktreeError::Dirty(p)) => assert!(same_path(&p, &s.at("dirty")), "{p:?}"),
        other => panic!("expected Dirty, got {other:?}"),
    }
    assert!(s.at("dirty").exists(), "a refused remove must not delete anything");

    remove(&s.git, &s.repo(), &s.at("dirty"), true).await.expect("forced remove");
    assert!(!s.at("dirty").exists());
    assert_eq!(list(&s.git, &s.repo()).await.expect("list").len(), 1);
}

#[tokio::test]
async fn remove_on_an_unregistered_path_is_not_a_worktree() {
    let s = Scratch::new();
    // Observed on git 2.50.1: "fatal: '<path>' is not a working tree".
    match remove(&s.git, &s.repo(), &s.at("never-existed"), false).await {
        Err(WorktreeError::NotAWorktree(p)) => assert!(p.ends_with("never-existed"), "{p:?}"),
        other => panic!("expected NotAWorktree, got {other:?}"),
    }
}

#[tokio::test]
async fn neither_remove_nor_prune_deletes_the_branch_but_delete_branch_does() {
    let s = Scratch::new();
    add(&s.git, &s.spec("wt", "feat")).await.expect("add");

    // A branch checked out in a live worktree cannot be deleted; that is git's guard, not ours.
    let held = delete_branch(&s.git, &s.repo(), "feat", false).await;
    assert!(matches!(held, Err(WorktreeError::Git { .. })), "{held:?}");

    remove(&s.git, &s.repo(), &s.at("wt"), false).await.expect("remove");
    prune(&s.git, &s.repo()).await.expect("prune");
    assert!(s.branches().contains(&"feat".to_owned()), "{:?}", s.branches());

    delete_branch(&s.git, &s.repo(), "feat", false).await.expect("delete_branch");
    assert!(!s.branches().contains(&"feat".to_owned()), "{:?}", s.branches());
}

#[tokio::test]
async fn list_parses_a_lock_reason_and_a_path_containing_a_space() {
    let s = Scratch::new();
    add(&s.git, &s.spec("with space", "spacey")).await.expect("add");
    let locked = s.at("with space");
    let locked = locked.to_str().expect("utf-8 temp path");
    run(&s.git, &s.repo(), &["worktree", "lock", "--reason", "held by session 7", locked]);

    let all = list(&s.git, &s.repo()).await.expect("list");
    let wt = find(&all, "spacey");
    assert!(same_path(&wt.path, &s.at("with space")), "{:?}", wt.path);
    assert_eq!(wt.path.file_name().and_then(|n| n.to_str()), Some("with space"));
    assert_eq!(wt.locked.as_deref(), Some("held by session 7"));
    assert!(all[0].locked.is_none(), "the main worktree is not locked");
}

// ---------------------------------------------------------------------------------------------
// SECURITY — repository filter drivers.
//
// `git worktree add` checks out every tracked file, and a checkout runs the smudge filter that
// the repository's own `.gitattributes` names. The driver's command lives in config, which an
// agent reaches with one `git config --local` from inside its own worktree, so the next session's
// worktree creation runs arbitrary shell. Reproduced on git 2.50.1 before the fix.
// see docs/research/gitattributes.md.
// ---------------------------------------------------------------------------------------------

/// Arm the repository with a filter driver whose command writes `marker`, selected for `*.txt` by
/// a committed `.gitattributes`. `tee` so the driver is a faithful pass-through and only its
/// side effect is observable. Returns the marker path.
fn arm_filter_driver(s: &Scratch, driver: &str) -> PathBuf {
    let marker = s.at("FILTER-DRIVER-RAN");
    let marker_str = marker.to_str().expect("utf-8 temp path");
    std::fs::write(s.repo().join(".gitattributes"), format!("*.txt filter={driver}\n"))
        .expect("write .gitattributes");
    run(&s.git, &s.repo(), &["add", ".gitattributes"]);
    run(&s.git, &s.repo(), &["commit", "-qm", "attrs"]);
    // Not `git config --local` from a worktree, which is how an agent would really do it; writing
    // it here is the same file and keeps the test independent of worktree ordering.
    run(&s.git, &s.repo(), &["config", &format!("filter.{driver}.smudge"), &format!("tee '{marker_str}'")]);
    marker
}

#[tokio::test]
async fn add_does_not_run_the_repositorys_filter_drivers() {
    let s = Scratch::new();
    let marker = arm_filter_driver(&s, "marker");

    let made = add(&s.git, &s.spec("wt", "feat")).await.expect("add succeeds");
    assert!(same_path(&made.path, &s.at("wt")), "{:?}", made.path);
    assert!(
        !marker.exists(),
        "git ran the repository's smudge filter during `worktree add`: {marker:?}"
    );
    // The checkout is still a real checkout; neutralising the driver must not empty the file.
    let checked_out = std::fs::read_to_string(s.at("wt").join("f.txt")).expect("read f.txt");
    assert_eq!(checked_out, "hi\n");
}

#[tokio::test]
async fn a_filter_name_containing_an_equals_sign_is_still_neutralised() {
    // `git -c filter.a=b.smudge=` sets a key called `filter.a` and leaves the real driver live;
    // the `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` form has no such parse. Observed on 2.50.1.
    let s = Scratch::new();
    let marker = arm_filter_driver(&s, "a=b");

    add(&s.git, &s.spec("wt", "feat")).await.expect("add succeeds");
    assert!(!marker.exists(), "a filter named `a=b` escaped neutralisation: {marker:?}");
}

#[tokio::test]
async fn a_required_filter_driver_does_not_block_add() {
    // `git lfs install --local` writes `filter.lfs.required = true`. Observed on 2.50.1: blanking
    // only smudge/clean/process leaves `worktree add` failing with exit 128
    // "fatal: f.txt: smudge filter lfs failed", so `required=false` has to be in the set.
    let s = Scratch::new();
    let marker = arm_filter_driver(&s, "lfs");
    run(&s.git, &s.repo(), &["config", "filter.lfs.required", "true"]);

    add(&s.git, &s.spec("wt", "feat")).await.expect("a required driver must not fail the add");
    assert!(!marker.exists(), "{marker:?}");
    assert_eq!(std::fs::read_to_string(s.at("wt").join("f.txt")).expect("read f.txt"), "hi\n");
}

#[tokio::test]
async fn core_fsmonitor_is_not_executed_by_add() {
    // Same class, different key: `core.fsmonitor` set to a command is a shell command git runs
    // during `worktree add` and again on every later `status`. Observed on 2.50.1.
    let s = Scratch::new();
    let marker = s.at("FSMONITOR-RAN");
    let marker_str = marker.to_str().expect("utf-8 temp path");
    run(&s.git, &s.repo(), &["config", "core.fsmonitor", &format!("tee '{marker_str}'")]);

    add(&s.git, &s.spec("wt", "feat")).await.expect("add succeeds");
    assert!(!marker.exists(), "git ran core.fsmonitor during `worktree add`: {marker:?}");
    // `dirty_count` runs `status`, which is the other place it fires.
    dirty_count(&s.git, &s.at("wt")).await.expect("dirty_count");
    assert!(!marker.exists(), "git ran core.fsmonitor during `status`: {marker:?}");
}

#[tokio::test]
async fn ordinary_gitattributes_keep_working() {
    // The guard blanks filter *drivers*, nothing else. git's built-in conversions are attributes,
    // not drivers, and `linguist-*` is inert metadata; all three must survive.
    let s = Scratch::new();
    std::fs::write(s.repo().join("crlf.txt"), "a\r\nb\r\n").expect("write crlf.txt");
    std::fs::write(s.repo().join("f.id"), "blob $Id$\n").expect("write f.id");
    std::fs::write(
        s.repo().join(".gitattributes"),
        "*.txt text eol=crlf\n*.id ident\n*.md linguist-documentation\n",
    )
    .expect("write .gitattributes");
    run(&s.git, &s.repo(), &["config", "core.autocrlf", "false"]);
    run(&s.git, &s.repo(), &["add", "-A"]);
    run(&s.git, &s.repo(), &["commit", "-qm", "attrs"]);

    add(&s.git, &s.spec("wt", "feat")).await.expect("add succeeds");

    let crlf = std::fs::read(s.at("wt").join("crlf.txt")).expect("read crlf.txt");
    assert_eq!(crlf, b"a\r\nb\r\n", "eol=crlf must still be applied");
    let ident = std::fs::read_to_string(s.at("wt").join("f.id")).expect("read f.id");
    assert!(ident.starts_with("blob $Id: ") && ident.trim_end().ends_with('$'), "{ident:?}");
    assert_eq!(
        dirty_count(&s.git, &s.at("wt")).await.expect("dirty_count"),
        0,
        "a freshly created worktree with legitimate attributes must read as clean"
    );
}
