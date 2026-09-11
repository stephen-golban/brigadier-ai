//! Who a refused workspace lock names, and what the registry sweep may delete.
//! see docs/research/workspace-lock-holder-identity-2026-09-11.md
#![cfg(unix)]
use brigadier_core::checkpoint::{Error, LeaseKind, LockOwner, WorkspaceLease};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::OnceLock,
};

/// Every test in this binary shares one isolated registry, so none of them touch `~/.brigadier`.
/// Each test uses its own workspace roots and its own file names, so they stay independent while
/// sweeping the same directory — which is itself part of what is under test.
fn registry() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(WorkspaceLease::isolate_registry_for_tests)
}
/// The registry's file name for a directory's own exclusive lock.
fn key(root: &Path) -> String {
    let m = fs::metadata(fs::canonicalize(root).unwrap()).unwrap();
    format!("{}-{}", m.dev(), m.ino())
}
fn workspace() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("work");
    fs::create_dir(&root).unwrap();
    (dir, root)
}
fn refusal(e: Error) -> (String, Option<LockOwner>, bool) {
    match e {
        Error::Busy(conflict) => (
            conflict.to_string(),
            conflict.holder.clone(),
            conflict.holder_live,
        ),
        other => panic!("expected a lock conflict, got {other}"),
    }
}
/// A pid that is certainly not a process: spawned, exited, and reaped.
fn dead_pid() -> u32 {
    let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    pid
}

#[test]
fn a_turn_refused_by_a_terminal_names_that_terminal_its_path_and_its_pid() {
    registry();
    let (_dir, root) = workspace();
    let shell = WorkspaceLease::terminal_as(&root, "terminal-7").unwrap();
    let (message, holder, live) = refusal(WorkspaceLease::acquire(&root).unwrap_err());
    let holder = holder.expect("the refusal must name the shell that holds the workspace");
    assert_eq!(holder.kind, LeaseKind::Terminal);
    assert_eq!(holder.id.as_deref(), Some("terminal-7"));
    assert_eq!(holder.pid, std::process::id());
    assert_eq!(holder.root, fs::canonicalize(&root).unwrap());
    assert!(live);
    let root = fs::canonicalize(&root).unwrap();
    let expected = format!(
        "Workspace {} is held by terminal 7 (pid {}) opened on {}; close that terminal or start this session in a worktree (lock file {}/terminal-root-{})",
        root.display(),
        std::process::id(),
        root.display(),
        registry().display(),
        key(&root),
    );
    assert_eq!(message, expected);
    drop(shell);
    WorkspaceLease::acquire(&root).unwrap();
}

#[test]
fn an_ancestor_turn_refused_by_a_descendant_turn_still_names_the_session() {
    registry();
    let (_dir, root) = workspace();
    let child = root.join("child");
    fs::create_dir(&child).unwrap();
    // The parent is refused by a lock the child holds *shared*, which carries no record; the
    // holder has to be found from the record it published on its own root instead.
    let _held = WorkspaceLease::acquire_as(&child, "session-abc").unwrap();
    let (message, holder, live) = refusal(WorkspaceLease::acquire(&root).unwrap_err());
    let holder = holder.expect("a live overlapping holder must be found by the registry search");
    assert_eq!(holder.kind, LeaseKind::Turn);
    assert_eq!(holder.root, fs::canonicalize(&child).unwrap());
    assert!(live);
    assert!(
        message.contains("is held by turn session-abc")
            && message.contains("wait for that turn to finish"),
        "{message}"
    );
}

#[test]
fn an_owner_record_naming_a_dead_process_is_reported_as_stale() {
    registry();
    let (_dir, root) = workspace();
    let _shell = WorkspaceLease::terminal_as(&root, "terminal-9").unwrap();
    let canonical = fs::canonicalize(&root).unwrap();
    let lock = registry().join(format!("terminal-root-{}", key(&canonical)));
    let gone = dead_pid();
    // The lock is genuinely held; only the identity in it is stale. Advisory locks do not stop
    // the write, which is exactly why a record can outlive the process that wrote it.
    fs::write(
        &lock,
        serde_json::to_vec(&LockOwner {
            kind: LeaseKind::Terminal,
            id: Some("terminal-9".into()),
            root: canonical.clone(),
            pid: gone,
            started_at: 0,
        })
        .unwrap(),
    )
    .unwrap();
    let (message, holder, live) = refusal(WorkspaceLease::acquire(&root).unwrap_err());
    assert!(!live, "a dead pid must never be reported as a live holder");
    assert_eq!(
        holder.expect("the stale record is still reported").pid,
        gone
    );
    assert!(
        message.contains("overlaps another running turn, terminal, or restore operation")
            && message.contains(&format!(
                "was terminal 9 (pid {gone}), which is no longer running"
            ))
            && message.contains("the live holder is unidentified"),
        "{message}"
    );
}

#[test]
fn the_sweep_removes_dead_lock_files_and_leaves_live_leases_alone() {
    registry();
    let token = format!("sweeptest{}", std::process::id());
    let dead: Vec<PathBuf> = (0..200)
        .map(|i| {
            let path = registry().join(format!("{token}-{i}"));
            fs::write(&path, b"").unwrap();
            path
        })
        .collect();
    let live: Vec<_> = (0..5).map(|_| workspace()).collect();
    let leases: Vec<_> = live
        .iter()
        .map(|(_, root)| WorkspaceLease::acquire(root).unwrap())
        .collect();
    // The bound is per call, so a backlog drains over several; ten calls is far more than the
    // 200 files here need. see docs/research/workspace-lock-holder-identity-2026-09-11.md §4.
    for _ in 0..10 {
        if dead.iter().all(|path| !path.exists()) {
            break;
        }
        WorkspaceLease::sweep_registry().unwrap();
    }
    assert!(
        dead.iter().all(|path| !path.exists()),
        "every unheld lock file must be collected"
    );
    for (_, root) in &live {
        assert!(
            registry().join(key(root)).exists(),
            "a held lock file must survive the sweep"
        );
        assert!(
            WorkspaceLease::acquire(root).is_err(),
            "exclusion must still hold after the sweep"
        );
    }
    drop(leases);
}

#[test]
fn a_recovery_marker_for_a_vanished_root_is_removed_and_one_for_a_live_root_is_not() {
    registry();
    let (dir, root) = workspace();
    let (_other_dir, other) = workspace();
    let operation = uuid::Uuid::new_v4().to_string();
    let held = WorkspaceLease::acquire(&root).unwrap();
    held.block(&operation).unwrap();
    drop(held);
    let canonical = fs::canonicalize(&root).unwrap();
    assert!(marked(&canonical), "the blocker must be published");
    // Any acquisition scans the markers, and a live root's marker is never collected.
    let scan = WorkspaceLease::acquire(&other).unwrap();
    assert!(marked(&canonical), "a live root keeps its durable blocker");
    drop(scan);
    drop(dir);
    let scan = WorkspaceLease::acquire(&other).unwrap();
    drop(scan);
    assert!(
        !marked(&canonical),
        "a marker whose root is gone can never be recovered into and must be collected"
    );
}
/// Whether any marker in the registry still blocks this root. Markers are named by a hash of the
/// path, so they are found by reading them rather than by recomputing the name.
fn marked(root: &Path) -> bool {
    fs::read_dir(registry()).unwrap().any(|entry| {
        let path = entry.unwrap().path();
        path.extension().and_then(|x| x.to_str()) == Some("recovery")
            && fs::read(&path).ok().is_some_and(|bytes| {
                serde_json::from_slice::<serde_json::Value>(&bytes)
                    .ok()
                    .and_then(|v| v.get("root").and_then(|r| r.as_str().map(PathBuf::from)))
                    .is_some_and(|recorded| recorded == root)
            })
    })
}

#[test]
fn a_shared_ancestor_lock_survives_the_sweep_and_still_excludes_its_parent() {
    registry();
    let (_dir, root) = workspace();
    let child = root.join("child");
    fs::create_dir(&child).unwrap();
    // The child holds the parent's lock file *shared*, so the sweep's exclusive probe must fail
    // on it. This is the case that would silently break exclusion if the probe were skipped.
    let held = WorkspaceLease::acquire(&child).unwrap();
    WorkspaceLease::sweep_registry().unwrap();
    assert!(
        registry().join(key(&root)).exists(),
        "an ancestor lock held shared must survive the sweep"
    );
    assert!(
        WorkspaceLease::acquire(&root).is_err(),
        "the parent must still be excluded after the sweep"
    );
    drop(held);
    WorkspaceLease::acquire(&root).unwrap();
}

#[test]
fn a_marker_whose_root_cannot_be_stat_ed_survives_the_sweep() {
    registry();
    let (_dir, outer) = workspace();
    let root = outer.join("inner");
    fs::create_dir(&root).unwrap();
    let canonical = fs::canonicalize(&root).unwrap();
    let held = WorkspaceLease::acquire(&root).unwrap();
    held.block(&uuid::Uuid::new_v4().to_string()).unwrap();
    drop(held);
    // EACCES is not "gone". Unlinking a durable blocker because the path was merely unreachable
    // loses an unresolved restore for good, so only NotFound may collect one.
    fs::set_permissions(&outer, fs::Permissions::from_mode(0o000)).unwrap();
    let unreadable = fs::symlink_metadata(&canonical)
        .err()
        .is_some_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied);
    let (_other_dir, other) = workspace();
    let scan = WorkspaceLease::acquire(&other).unwrap();
    drop(scan);
    let survived = marked(&canonical);
    fs::set_permissions(&outer, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        !unreadable || survived,
        "a blocker whose root only failed to stat must be kept"
    );
    // Clean up after the assertion, so the shared registry does not keep a live blocker.
    let recovered = WorkspaceLease::acquire(&root);
    drop(recovered);
}

#[test]
fn a_record_left_behind_for_another_directory_is_not_reported_as_this_holder() {
    registry();
    let (_dir, root) = workspace();
    let (_elsewhere_dir, elsewhere) = workspace();
    let _shell = WorkspaceLease::terminal_as(&root, "terminal-11").unwrap();
    let canonical = fs::canonicalize(&root).unwrap();
    let stranger = fs::canonicalize(&elsewhere).unwrap();
    // What a SIGKILLed exclusive holder leaves behind in a file others still hold shared: a
    // record about some other directory, whose pid may since have been reused by a live process.
    fs::write(
        registry().join(format!("terminal-root-{}", key(&canonical))),
        serde_json::to_vec(&LockOwner {
            kind: LeaseKind::Turn,
            id: Some("session-stranger".into()),
            root: stranger.clone(),
            pid: std::process::id(),
            started_at: 0,
        })
        .unwrap(),
    )
    .unwrap();
    let (message, holder, _) = refusal(WorkspaceLease::acquire(&root).unwrap_err());
    assert!(
        holder.is_none(),
        "a record about {stranger:?} is not evidence about this lock"
    );
    assert!(
        !message.contains("session-stranger") && message.contains("carries no owner record"),
        "{message}"
    );
}
