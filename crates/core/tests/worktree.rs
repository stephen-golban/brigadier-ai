//! Worktree behaviour, reproduced against the real `git` on this machine.
//!
//! Every test builds a throwaway repository in its own `tempfile::tempdir()` with one commit;
//! nothing here touches the checkout it runs from.

use std::path::{Path, PathBuf};
use std::process::Command;

use brigadier_core::worktree::{
    add, commits_only_here, delete_branch, dirty_count, git_version, has_submodules, list,
    main_worktree_of, prune, remove, repair, resolve_git, RemoveForce, Worktree, WorktreeError,
    WorktreeSpec,
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

    remove(&s.git, &s.repo(), &s.at("clean"), RemoveForce::No).await.expect("clean remove");
    assert!(!s.at("clean").exists());

    std::fs::write(s.at("dirty").join("f.txt"), "edited\n").expect("dirty the tracked file");
    // Observed on git 2.50.1:
    // "fatal: '<path>' contains modified or untracked files, use --force to delete it".
    match remove(&s.git, &s.repo(), &s.at("dirty"), RemoveForce::No).await {
        Err(WorktreeError::Dirty(p)) => assert!(same_path(&p, &s.at("dirty")), "{p:?}"),
        other => panic!("expected Dirty, got {other:?}"),
    }
    assert!(s.at("dirty").exists(), "a refused remove must not delete anything");

    remove(&s.git, &s.repo(), &s.at("dirty"), RemoveForce::Discard).await.expect("forced remove");
    assert!(!s.at("dirty").exists());
    assert_eq!(list(&s.git, &s.repo()).await.expect("list").len(), 1);
}

#[tokio::test]
async fn remove_on_an_unregistered_path_is_not_a_worktree() {
    let s = Scratch::new();
    // Observed on git 2.50.1: "fatal: '<path>' is not a working tree".
    match remove(&s.git, &s.repo(), &s.at("never-existed"), RemoveForce::No).await {
        Err(WorktreeError::NotAWorktree(p)) => assert!(p.ends_with("never-existed"), "{p:?}"),
        other => panic!("expected NotAWorktree, got {other:?}"),
    }
}

#[tokio::test]
async fn neither_remove_nor_prune_deletes_the_branch_but_delete_branch_does() {
    let s = Scratch::new();
    add(&s.git, &s.spec("wt", "feat")).await.expect("add");

    // A branch checked out in a live worktree cannot be deleted; that is git's guard, not ours,
    // and the refusal names the worktree holding it — which is the whole remedy, so it is typed
    // rather than left as an opaque `Git`.
    // see docs/research/worktree-cleanup.md §1.5.
    match delete_branch(&s.git, &s.repo(), "feat", false).await {
        Err(WorktreeError::BranchInUse { branch, path }) => {
            assert_eq!(branch, "feat");
            assert!(same_path(&path, &s.at("wt")), "{path:?}");
        }
        other => panic!("expected BranchInUse, got {other:?}"),
    }

    remove(&s.git, &s.repo(), &s.at("wt"), RemoveForce::No).await.expect("remove");
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

// ---------------------------------------------------------------------------------------------
// Destructive states: a moved project, a killed `add`, submodules, and the commits nobody counts.
// Every claim below was reproduced on git 2.50.1 (Apple Git-155) before the code was written.
// see docs/research/worktree-cleanup.md.
// ---------------------------------------------------------------------------------------------

/// A `Scratch` whose worktrees are nested inside the repository, the way brigadier's are, so one
/// `mv` of the project breaks every one of them at once.
fn nested_spec(s: &Scratch, id: &str) -> WorktreeSpec {
    WorktreeSpec {
        repo: s.repo(),
        path: s.repo().join(".brigadier/worktrees").join(id),
        branch: format!("brigadier/{id}"),
        base: "HEAD".to_owned(),
    }
}

/// The ordering bug, both halves in one test: `repair` recovers a renamed project completely, and
/// a `prune` that runs first makes that recovery impossible forever.
// see docs/research/worktree-cleanup.md §1.4 and "Hard rules" 7.
#[tokio::test]
async fn repair_recovers_a_moved_project_and_a_prune_that_runs_first_does_not() {
    for prune_first in [false, true] {
        let s = Scratch::new();
        add(&s.git, &nested_spec(&s, "aaaa1111")).await.expect("add");
        let wt = s.repo().join(".brigadier/worktrees/aaaa1111");
        std::fs::write(wt.join("NOTES.md"), "a whole session of work\n").expect("write NOTES.md");

        // The rename. Both recorded absolute paths are now stale.
        let moved = s.at("renamed");
        std::fs::rename(s.repo(), &moved).expect("rename the project");
        let wt = moved.join(".brigadier/worktrees/aaaa1111");
        let all = list(&s.git, &moved).await.expect("list");
        assert_eq!(
            all.iter().filter(|w| w.prunable.is_some()).count(),
            1,
            "the move must leave exactly one prunable entry: {all:#?}"
        );

        if prune_first {
            prune(&s.git, &moved).await.expect("prune");
        }
        let repaired = repair(&s.git, &moved, std::slice::from_ref(&wt)).await;

        if prune_first {
            // The entry is gone, so there is nothing left to point at the checkout.
            assert!(repaired.is_err(), "prune-then-repair must not silently succeed");
            assert!(
                dirty_count(&s.git, &wt).await.is_err(),
                "git must not be able to describe the orphaned checkout"
            );
            assert!(wt.join("NOTES.md").is_file(), "and the work is stranded on disk");
        } else {
            repaired.expect("repair recovers a moved project");
            let all = list(&s.git, &moved).await.expect("list");
            assert!(
                all.iter().all(|w| w.prunable.is_none()),
                "repair must clear the prunable flag: {all:#?}"
            );
            assert_eq!(
                dirty_count(&s.git, &wt).await.expect("status works again"),
                1,
                "the uncommitted work is visible again"
            );
        }
    }
}

/// `repair` is called with every directory under `.brigadier/worktrees/`, some of which may not be
/// worktrees at all, so a bad path must not cost the good ones their repair.
// see docs/research/worktree-cleanup.md §1.4.
#[tokio::test]
async fn a_bad_path_in_a_repair_batch_still_repairs_the_good_ones() {
    let s = Scratch::new();
    add(&s.git, &nested_spec(&s, "bbbb2222")).await.expect("add");
    let moved = s.at("renamed");
    std::fs::rename(s.repo(), &moved).expect("rename");
    let good = moved.join(".brigadier/worktrees/bbbb2222");
    let bad = moved.join(".brigadier/worktrees/not-a-worktree");
    std::fs::create_dir_all(&bad).expect("mkdir");

    let out = repair(&s.git, &moved, &[good.clone(), bad]).await;
    assert!(out.is_err(), "a path that is not a worktree makes the call fail");
    let all = list(&s.git, &moved).await.expect("list");
    assert!(all.iter().all(|w| w.prunable.is_none()), "the good path was repaired anyway: {all:#?}");
}

/// An empty batch is a no-op, not the argument-less form — which **measured** exits 0, prints
/// nothing and repairs none of our nested worktrees.
#[tokio::test]
async fn repair_with_no_paths_does_nothing() {
    let s = Scratch::new();
    add(&s.git, &nested_spec(&s, "cccc3333")).await.expect("add");
    let moved = s.at("renamed");
    std::fs::rename(s.repo(), &moved).expect("rename");

    repair(&s.git, &moved, &[]).await.expect("an empty batch cannot fail");
    let all = list(&s.git, &moved).await.expect("list");
    assert_eq!(all.iter().filter(|w| w.prunable.is_some()).count(), 1, "{all:#?}");
}

/// A lock is a third refusal, not a harder kind of dirt: one `--force` does not touch it.
// see docs/research/worktree-cleanup.md §1.1 and §1.8.
#[tokio::test]
async fn only_a_double_force_clears_a_locked_worktree() {
    let s = Scratch::new();
    add(&s.git, &s.spec("wt", "feat")).await.expect("add");
    let wt = s.at("wt");
    let wt_str = wt.to_str().expect("utf-8 temp path");
    // The exact marker git leaves behind when its own `worktree add` is killed mid-checkout.
    run(&s.git, &s.repo(), &["worktree", "lock", "--reason", "initializing", wt_str]);

    for rung in [RemoveForce::No, RemoveForce::Discard] {
        match remove(&s.git, &s.repo(), &wt, rung).await {
            Err(WorktreeError::Locked(reason)) => assert_eq!(reason, "initializing"),
            other => panic!("{rung:?} should not clear a lock, got {other:?}"),
        }
    }
    // And the branch cannot be deleted while the entry stands, so the residue is permanent.
    assert!(
        matches!(
            delete_branch(&s.git, &s.repo(), "feat", true).await,
            Err(WorktreeError::BranchInUse { .. })
        ),
        "a locked entry must keep its branch undeleteable"
    );

    remove(&s.git, &s.repo(), &wt, RemoveForce::Unlock).await.expect("-f -f clears it");
    assert!(!wt.exists(), "the checkout is gone");
    delete_branch(&s.git, &s.repo(), "feat", true).await.expect("and now the branch goes");
}

/// A lock taken with no reason at all still classifies, so the caller can tell "locked" from
/// "some other git failure" without reading stderr.
#[tokio::test]
async fn a_reasonless_lock_still_classifies_as_locked() {
    let s = Scratch::new();
    add(&s.git, &s.spec("wt", "feat")).await.expect("add");
    let wt = s.at("wt");
    run(&s.git, &s.repo(), &["worktree", "lock", wt.to_str().expect("utf-8")]);
    match remove(&s.git, &s.repo(), &wt, RemoveForce::Discard).await {
        Err(WorktreeError::Locked(reason)) => assert!(reason.is_empty(), "{reason:?}"),
        other => panic!("expected Locked, got {other:?}"),
    }
}

/// The count that decides whether there is anything to lose, and the three ways of getting it
/// wrong that were measured before it was written.
// see docs/research/worktree-cleanup.md §2.6 rung 1, §1.5 and §1.17.
#[tokio::test]
async fn commits_only_here_counts_what_no_other_ref_keeps() {
    let s = Scratch::new();
    add(&s.git, &s.spec("wt", "feat")).await.expect("add");
    let wt = s.at("wt");

    assert_eq!(
        commits_only_here(&s.git, &wt, Some("feat")).await.expect("count"),
        0,
        "a fresh worktree holds nothing of its own"
    );

    std::fs::write(wt.join("a.txt"), "a\n").expect("write");
    run(&s.git, &wt, &["add", "a.txt"]);
    run(&s.git, &wt, &["commit", "-qm", "one"]);
    std::fs::write(wt.join("b.txt"), "b\n").expect("write");
    run(&s.git, &wt, &["add", "b.txt"]);
    run(&s.git, &wt, &["commit", "-qm", "two"]);
    assert_eq!(commits_only_here(&s.git, &wt, Some("feat")).await.expect("count"), 2);

    // The prefix trap: `--exclude=refs/heads/feat` matches nothing, so the count silently
    // collapses to 0 — a false "safe to delete". Pinned so nobody re-adds the prefix.
    assert_eq!(
        commits_only_here(&s.git, &wt, Some("refs/heads/feat")).await.expect("count"),
        0,
        "if this is 2, `--exclude` has changed and the caller can stop stripping the prefix"
    );

    // A stash is not a copy the count may credit: `--all` would see `refs/stash`, whose parent is
    // HEAD, and answer 0 over work that exists only in a stash.
    std::fs::write(wt.join("c.txt"), "c\n").expect("write");
    run(&s.git, &wt, &["add", "c.txt"]);
    run(&s.git, &wt, &["stash", "-q"]);
    assert_eq!(commits_only_here(&s.git, &wt, Some("feat")).await.expect("count"), 2);

    // Another ref reaching the same commits is what makes them safe.
    run(&s.git, &s.repo(), &["branch", "keep", "feat"]);
    assert_eq!(commits_only_here(&s.git, &wt, Some("feat")).await.expect("count"), 0);
}

/// The stored branch name is not the fact. An agent that checks out its own branch moves the work
/// to a ref nowhere in our database, and only the live name gives the right count.
// see docs/research/worktree-cleanup.md §1.5.
#[tokio::test]
async fn the_live_branch_is_what_the_count_must_exclude() {
    let s = Scratch::new();
    add(&s.git, &s.spec("wt", "brigadier/dddd4444")).await.expect("add");
    let wt = s.at("wt");
    run(&s.git, &wt, &["checkout", "-q", "-b", "agents-own"]);
    std::fs::write(wt.join("a.txt"), "a\n").expect("write");
    run(&s.git, &wt, &["add", "a.txt"]);
    run(&s.git, &wt, &["commit", "-qm", "the agent's work"]);

    let all = list(&s.git, &s.repo()).await.expect("list");
    let live = find(&all, "agents-own");
    assert!(same_path(&live.path, &wt), "{live:?}");

    assert_eq!(
        commits_only_here(&s.git, &wt, Some("brigadier/dddd4444")).await.expect("count"),
        0,
        "excluding the stored name credits a branch that no longer holds the work"
    );
    assert_eq!(
        commits_only_here(&s.git, &wt, live.branch.as_deref()).await.expect("count"),
        1,
        "excluding the live name is the honest answer"
    );
}

/// A detached head has no branch to exclude, and the work is still on the old branch.
#[tokio::test]
async fn a_detached_head_needs_no_exclusion() {
    let s = Scratch::new();
    add(&s.git, &s.spec("wt", "feat")).await.expect("add");
    let wt = s.at("wt");
    std::fs::write(wt.join("a.txt"), "a\n").expect("write");
    run(&s.git, &wt, &["add", "a.txt"]);
    run(&s.git, &wt, &["commit", "-qm", "one"]);
    run(&s.git, &wt, &["checkout", "-q", "--detach", "HEAD"]);

    let all = list(&s.git, &s.repo()).await.expect("list");
    let entry = all.iter().find(|w| !w.is_main).expect("the linked worktree");
    assert!(entry.branch.is_none(), "a detached entry has no branch line: {entry:?}");
    assert_eq!(
        commits_only_here(&s.git, &wt, entry.branch.as_deref()).await.expect("count"),
        0,
        "`feat` still holds the commit, so nothing would be lost"
    );
}

/// A worktree of a repository with submodules is checked out **incomplete and reads clean**, and
/// then refuses to be removed for a reason that has nothing to do with dirt.
// see docs/research/worktree-cleanup.md §1.13.
#[tokio::test]
async fn a_repository_with_submodules_makes_an_incomplete_worktree_that_reads_clean() {
    let s = Scratch::new();
    // A second repository to embed. `protocol.file.allow` because git refuses a file-transport
    // submodule by default since CVE-2022-39253.
    let inner = s.at("inner");
    std::fs::create_dir(&inner).expect("mkdir inner");
    run(&s.git, &inner, &["init", "-q", "-b", "main", "."]);
    std::fs::write(inner.join("g.txt"), "g\n").expect("write");
    run(&s.git, &inner, &["add", "g.txt"]);
    run(&s.git, &inner, &["commit", "-qm", "inner"]);

    assert!(!has_submodules(&s.git, &s.repo()).await.expect("no submodules yet"));
    let url = inner.to_str().expect("utf-8 temp path");
    run(
        &s.git,
        &s.repo(),
        &["-c", "protocol.file.allow=always", "submodule", "add", "-q", url, "sub"],
    );
    run(&s.git, &s.repo(), &["commit", "-qm", "add the submodule"]);
    assert!(has_submodules(&s.git, &s.repo()).await.expect("submodules now"));

    add(&s.git, &s.spec("wt", "feat")).await.expect("add succeeds anyway");
    let wt = s.at("wt");
    assert!(wt.join("sub").is_dir(), "the submodule directory exists");
    assert_eq!(
        std::fs::read_dir(wt.join("sub")).expect("read_dir").count(),
        0,
        "and it is empty: the worktree is incomplete"
    );
    assert_eq!(
        dirty_count(&s.git, &wt).await.expect("dirty_count"),
        0,
        "while reading perfectly clean — which is why `prepare` refuses these repositories"
    );

    // And once anything initialises it, removal refuses categorically, not for dirtiness.
    run(&s.git, &wt, &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
    assert_eq!(dirty_count(&s.git, &wt).await.expect("dirty_count"), 0, "still clean");
    match remove(&s.git, &s.repo(), &wt, RemoveForce::No).await {
        Err(WorktreeError::SubmodulesBlockRemoval) => {}
        other => panic!("expected SubmodulesBlockRemoval, got {other:?}"),
    }
    remove(&s.git, &s.repo(), &wt, RemoveForce::Discard).await.expect("--force takes it");
}

/// `--show-toplevel` cannot tell a linked worktree from a main one; the common dir can.
// see docs/research/worktree-cleanup.md §1.6.
#[tokio::test]
async fn main_worktree_of_tells_a_linked_worktree_from_a_main_one() {
    let s = Scratch::new();
    add(&s.git, &s.spec("wt", "feat")).await.expect("add");

    assert_eq!(
        main_worktree_of(&s.git, &s.repo()).await.expect("main"),
        None,
        "the main worktree is not linked to anything"
    );
    let main = main_worktree_of(&s.git, &s.at("wt"))
        .await
        .expect("query")
        .expect("a linked worktree names its main tree");
    assert!(same_path(&main, &s.repo()), "{main:?}");
}

/// **The hazard `removed: true` has to defend against, pinned as observed behaviour.** With the
/// project renamed under git's feet, a *relative* `worktree remove` argument exits 0, unregisters
/// the entry and leaves every file on disk. The absolute path this crate always passes refuses
/// instead — so the safety of `remove` rests on that spelling, and this is the test that notices
/// if it ever changes.
// see docs/research/worktree-cleanup.md §1.4 and "Hard rules" 11.
#[tokio::test]
async fn a_relative_remove_argument_reports_success_over_files_it_left_behind() {
    let s = Scratch::new();
    add(&s.git, &nested_spec(&s, "eeee5555")).await.expect("add");
    let wt = s.repo().join(".brigadier/worktrees/eeee5555");
    std::fs::write(wt.join("NOTES.md"), "work\n").expect("write");
    let moved = s.at("renamed");
    std::fs::rename(s.repo(), &moved).expect("rename");
    let wt = moved.join(".brigadier/worktrees/eeee5555");

    // What this crate does: absolute, via `-C`. git refuses, and nothing is lost.
    match remove(&s.git, &moved, &wt, RemoveForce::No).await {
        Err(WorktreeError::NotAWorktree(_)) => {}
        other => panic!("an absolute argument must refuse, got {other:?}"),
    }
    assert!(wt.join("NOTES.md").is_file());

    // What a relative argument does instead, on the same state.
    let out = Command::new(&s.git)
        .arg("-C")
        .arg(&moved)
        .args(["worktree", "remove", "--", ".brigadier/worktrees/eeee5555"])
        .env("LC_ALL", "C")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "the relative form exits 0: {out:?}");
    assert!(wt.join("NOTES.md").is_file(), "…over a file it did not delete");
    let all = list(&s.git, &moved).await.expect("list");
    assert_eq!(all.len(), 1, "…and it unregistered the entry: {all:#?}");
}
