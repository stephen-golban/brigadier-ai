#![cfg(target_os = "macos")]
use brigadier_core::checkpoint::*;
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};
fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}
struct Rig {
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
    store: SnapshotStore,
}
impl Rig {
    fn new() -> Self {
        WorkspaceLease::isolate_registry_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("work");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q"]);
        let store =
            SnapshotStore::open(dir.path().join("private"), "git".into(), Limits::default())
                .unwrap();
        Self {
            _dir: dir,
            root,
            store,
        }
    }
    fn capture(&self) -> Snapshot {
        self.store.capture(&self.root, Coverage::default()).unwrap()
    }
    fn write(&self, path: &str, bytes: &[u8]) {
        fs::write(self.root.join(path), bytes).unwrap()
    }
}
#[test]
fn worktree_seeding_leaves_provenance_to_macos_and_preserves_other_attributes() {
    let source = Rig::new();
    source.write(".gitignore", b"node_modules/\n");
    let file = fs::File::open(source.root.join(".gitignore")).unwrap();
    for (name, value) in [
        ("com.apple.provenance", b"provenance".as_slice()),
        (
            "com.apple.quarantine",
            b"0081;00000000;Brigadier test;".as_slice(),
        ),
        ("user.brigadier-test", b"keep this metadata".as_slice()),
    ] {
        rustix::fs::fsetxattr(&file, name, value, rustix::fs::XattrFlags::empty()).unwrap();
    }
    let mut provenance = [0; 1024];
    assert!(rustix::fs::fgetxattr(&file, "com.apple.provenance", &mut provenance).unwrap() > 0);
    let original = source.capture();
    let attributes = &original.files[".gitignore"]
        .metadata
        .as_ref()
        .unwrap()
        .attributes;
    assert!(!attributes.contains_key("com.apple.provenance"));
    assert_eq!(
        attributes["com.apple.quarantine"],
        b"0081;00000000;Brigadier test;"
    );
    assert_eq!(attributes["user.brigadier-test"], b"keep this metadata");

    // Older checkpoint records must compare like new captures, including when embedded
    // in persisted recovery plans. Otherwise they fail before a restore can start.
    let mut legacy = serde_json::to_value(&original).unwrap();
    legacy["files"][".gitignore"]["metadata"]["attributes"]["com.apple.provenance"] =
        serde_json::json!([1, 2, 3]);
    let restored: Snapshot = serde_json::from_value(legacy).unwrap();
    assert_eq!(restored, original);

    let target = source._dir.path().join("worktree");
    fs::create_dir(&target).unwrap();
    git(&target, &["init", "-q"]);
    fs::write(target.join(".gitignore"), b"old\n").unwrap();
    let current = source.store.capture(&target, Coverage::default()).unwrap();
    let plan = plan_apply(&current.files.clone(), &restored.files, current).unwrap();
    assert!(!plan.changes.is_empty());
    source.store.validate_restore(&plan).unwrap();
    for change in &plan.changes {
        source
            .store
            .apply_change(&target, &plan.current.identity, change)
            .unwrap();
    }
    assert_eq!(
        source.store.capture(&target, Coverage::default()).unwrap().files,
        original.files
    );
}

#[test]
fn raw_restore_preserves_index_manual_files_modes_and_xattrs() {
    let r = Rig::new();
    r.write("tracked", b"staged\r\n");
    git(&r.root, &["add", "tracked"]);
    r.write("tracked", b"dirty before\r\n");
    r.write("binary", b"\0before\xff");
    r.write("manual", b"M0");
    fs::set_permissions(r.root.join("binary"), fs::Permissions::from_mode(0o600)).unwrap();
    let file = fs::File::open(r.root.join("binary")).unwrap();
    rustix::fs::fsetxattr(
        &file,
        "user.brigadier-test",
        b"metadata",
        rustix::fs::XattrFlags::empty(),
    )
    .unwrap();
    let index = fs::read(r.root.join(".git/index")).unwrap();
    let pre = r.capture();
    r.write("tracked", b"agent\r\n");
    r.write("binary", b"\0after\xff");
    r.write("empty", b"");
    let post = r.capture();
    r.write("manual", b"M1");
    let plan = plan_restore(
        &[Epoch {
            turn_id: "t".into(),
            pre: pre.clone(),
            post: Some(post),
            error: None,
        }],
        r.capture(),
    )
    .unwrap();
    assert_eq!(plan.changes.len(), 3);
    assert!(plan.conflicts.is_empty());
    r.store.validate_restore(&plan).unwrap();
    for c in &plan.changes {
        r.store.apply_change(&r.root, &pre.identity, c).unwrap();
    }
    assert_eq!(
        fs::read(r.root.join("tracked")).unwrap(),
        b"dirty before\r\n"
    );
    assert_eq!(fs::read(r.root.join("binary")).unwrap(), b"\0before\xff");
    assert_eq!(fs::read(r.root.join("manual")).unwrap(), b"M1");
    assert!(!r.root.join("empty").exists());
    assert_eq!(fs::read(r.root.join(".git/index")).unwrap(), index);
    assert_eq!(r.capture().files["binary"], pre.files["binary"]);
    let objects = git(&r.root, &["count-objects", "-v"]);
    assert!(String::from_utf8_lossy(&objects).contains("count: 1\n"));
}
#[test]
fn excludes_secrets_ignored_build_output_and_does_not_run_filters() {
    let r = Rig::new();
    r.write(".gitignore", b"ignored\n");
    r.write("ignored", b"ignored");
    r.write(".env", b"secret");
    fs::create_dir(r.root.join("node_modules")).unwrap();
    r.write("node_modules/x", b"dependency");
    r.write(".gitattributes", b"*.raw filter=poison text\n");
    r.write("x.raw", b"a\r\nb\r\n");
    git(
        &r.root,
        &["config", "filter.poison.clean", "touch FILTER_RAN; cat"],
    );
    git(
        &r.root,
        &["config", "filter.poison.smudge", "touch FILTER_RAN; cat"],
    );
    let s = r.capture();
    assert!(!s.files.contains_key(".env"));
    assert!(!s.files.contains_key("ignored"));
    assert!(!s.files.contains_key("node_modules/x"));
    assert!(!r.root.join("FILTER_RAN").exists());
    assert_eq!(r.store.blob(&s.files["x.raw"].oid).unwrap(), b"a\r\nb\r\n");
}
#[test]
fn stale_plan_and_symlink_paths_fail_without_writing() {
    let r = Rig::new();
    r.write("x", b"A");
    let pre = r.capture();
    r.write("x", b"B");
    let post = r.capture();
    let plan = plan_restore(
        &[Epoch {
            turn_id: "t".into(),
            pre,
            post: Some(post),
            error: None,
        }],
        r.capture(),
    )
    .unwrap();
    r.write("x", b"manual");
    assert!(r.store.validate_restore(&plan).is_err());
    assert!(r
        .store
        .apply_change(&r.root, &plan.current.identity, &plan.changes[0])
        .is_err());
    assert_eq!(fs::read(r.root.join("x")).unwrap(), b"manual");
    fs::remove_file(r.root.join("x")).unwrap();
    std::os::unix::fs::symlink("/tmp", r.root.join("x")).unwrap();
    assert!(r
        .store
        .apply_change(&r.root, &plan.current.identity, &plan.changes[0])
        .is_err());
}
#[test]
fn lease_excludes_overlapping_handles_and_releases_on_drop() {
    let r = Rig::new();
    let first = WorkspaceLease::acquire(&r.root).unwrap();
    assert!(WorkspaceLease::acquire(&r.root).is_err());
    drop(first);
    assert!(WorkspaceLease::acquire(&r.root).is_ok());
}
#[test]
fn reverse_intents_recovers_partial_apply_and_is_idempotent() {
    let r = Rig::new();
    r.write("a", b"A");
    r.write("b", b"B");
    let pre = r.capture();
    r.write("a", b"AA");
    r.write("b", b"BB");
    let post = r.capture();
    let p = plan_restore(
        &[Epoch {
            turn_id: "t".into(),
            pre,
            post: Some(post),
            error: None,
        }],
        r.capture(),
    )
    .unwrap();
    r.store
        .apply_change(&r.root, &p.current.identity, &p.changes[0])
        .unwrap();
    // Second intent was journaled but never applied. Both inverse paths must succeed.
    for c in p.changes.iter().rev() {
        let inverse = Change {
            path: c.path.clone(),
            before: c.after.clone(),
            after: c.before.clone(),
        };
        r.store
            .apply_change(&r.root, &p.current.identity, &inverse)
            .unwrap();
        r.store
            .apply_change(&r.root, &p.current.identity, &inverse)
            .unwrap();
    }
    assert_eq!(r.capture().files, p.current.files);
}
#[test]
fn retention_keeps_active_tree_and_prunes_only_unretained_snapshots() {
    let r = Rig::new();
    r.write("x", b"old unique bytes");
    let old = r.capture();
    r.write("x", b"current unique bytes");
    let current = r.capture();
    r.store
        .retain(&[current.id.clone()].into_iter().collect())
        .unwrap();
    assert_eq!(
        r.store.blob(&current.files["x"].oid).unwrap(),
        b"current unique bytes"
    );
    assert!(r.store.blob(&old.files["x"].oid).is_err());
}
#[test]
fn unsupported_acl_and_missing_parent_fail_before_restore() {
    let r = Rig::new();
    r.write("file", b"A");
    let pre = r.capture();
    r.write("file", b"B");
    let post = r.capture();
    let plan = plan_restore(
        &[Epoch {
            turn_id: "t".into(),
            pre,
            post: Some(post),
            error: None,
        }],
        r.capture(),
    )
    .unwrap();
    let out = Command::new("/bin/chmod")
        .args(["+a", "everyone allow read"])
        .arg(r.root.join("file"))
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(r.store.validate_restore(&plan).is_err());
    assert_eq!(fs::read(r.root.join("file")).unwrap(), b"B");
}

#[test]
fn missing_restore_parent_is_created_only_after_validation() {
    let r = Rig::new();
    fs::create_dir(r.root.join("sub")).unwrap();
    r.write("sub/file", b"original");
    let pre = r.capture();
    fs::remove_file(r.root.join("sub/file")).unwrap();
    fs::remove_dir(r.root.join("sub")).unwrap();
    let post = r.capture();
    let plan = plan_restore(
        &[Epoch {
            turn_id: "t".into(),
            pre,
            post: Some(post),
            error: None,
        }],
        r.capture(),
    )
    .unwrap();
    r.store.validate_support(&plan).unwrap();
    assert!(!r.root.join("sub").exists(), "preview is read-only");
    for change in &plan.changes {
        r.store
            .apply_change(&plan.current.root, &plan.current.identity, change)
            .unwrap();
    }
    assert_eq!(fs::read(r.root.join("sub/file")).unwrap(), b"original");
}

#[test]
fn hierarchical_leases_exclude_nested_roots_but_allow_siblings_and_aliases() {
    WorkspaceLease::isolate_registry_for_tests();
    let parent = tempfile::tempdir().unwrap();
    let child = parent.path().join("child");
    let sibling = parent.path().join("sibling");
    fs::create_dir(&child).unwrap();
    fs::create_dir(&sibling).unwrap();
    let alias = parent.path().join("alias");
    std::os::unix::fs::symlink(&child, &alias).unwrap();
    let held = WorkspaceLease::acquire(&child).unwrap();
    assert!(WorkspaceLease::acquire(parent.path()).is_err());
    assert!(WorkspaceLease::acquire(&alias).is_err());
    assert!(WorkspaceLease::acquire(&sibling).is_ok());
    drop(held);
    let held = WorkspaceLease::acquire(parent.path()).unwrap();
    assert!(WorkspaceLease::acquire(&child).is_err());
    assert!(WorkspaceLease::acquire(&sibling).is_err());
    drop(held);
    assert!(WorkspaceLease::acquire(&child).is_ok());
}

#[test]
fn durable_recovery_blocks_nested_roots_after_live_lease_exits() {
    WorkspaceLease::isolate_registry_for_tests();
    let parent = tempfile::tempdir().unwrap();
    let child = parent.path().join("child");
    let sibling = parent.path().join("sibling");
    fs::create_dir(&child).unwrap();
    fs::create_dir(&sibling).unwrap();
    for root in [&child, &parent.path().to_path_buf()] {
        let operation = uuid::Uuid::new_v4().to_string();
        let held = WorkspaceLease::acquire(root).unwrap();
        held.block(&operation).unwrap();
        drop(held);
        assert!(WorkspaceLease::acquire(parent.path()).is_err());
        assert!(WorkspaceLease::acquire(&child).is_err());
        assert!(WorkspaceLease::recover(root, &uuid::Uuid::new_v4().to_string()).is_err());
        if root == &child {
            assert!(WorkspaceLease::acquire(&sibling).is_ok());
        }
        let held = WorkspaceLease::recover(root, &operation).unwrap();
        held.resolve(&operation).unwrap();
        drop(held);
        assert!(WorkspaceLease::acquire(parent.path()).is_ok());
    }
}

#[test]
fn apply_delta_preserves_unrelated_project_edits_and_index() {
    let r = Rig::new();
    r.write("edited", b"base");
    r.write("manual", b"original");
    git(&r.root, &["add", "."]);
    let index = fs::read(r.root.join(".git/index")).unwrap();
    let base = r.capture();
    r.write("edited", b"agent");
    fs::create_dir(r.root.join("new")).unwrap();
    r.write("new/file", b"created");
    let changed = r.capture();
    r.write("edited", b"base");
    fs::remove_dir_all(r.root.join("new")).unwrap();
    r.write("manual", b"user edit");
    let plan = plan_apply(&base.files, &changed.files, r.capture()).unwrap();
    assert!(plan.conflicts.is_empty());
    assert_eq!(plan.changes.len(), 2);
    r.store.validate_restore(&plan).unwrap();
    assert!(!r.root.join("new").exists());
    for change in &plan.changes {
        r.store
            .apply_change(&r.root, &plan.current.identity, change)
            .unwrap();
        r.store
            .apply_change(&r.root, &plan.current.identity, change)
            .unwrap();
    }
    assert_eq!(fs::read(r.root.join("edited")).unwrap(), b"agent");
    assert_eq!(fs::read(r.root.join("new/file")).unwrap(), b"created");
    assert_eq!(fs::read(r.root.join("manual")).unwrap(), b"user edit");
    assert_eq!(fs::read(r.root.join(".git/index")).unwrap(), index);
}

#[test]
fn apply_conflicting_delta_does_not_overwrite_project() {
    let r = Rig::new();
    r.write("edited", b"base");
    let base = r.capture();
    r.write("edited", b"agent");
    let changed = r.capture();
    r.write("edited", b"user edit");
    let plan = plan_apply(&base.files, &changed.files, r.capture()).unwrap();
    assert_eq!(plan.conflicts, vec!["edited"]);
    assert!(r.store.validate_restore(&plan).is_err());
    assert_eq!(fs::read(r.root.join("edited")).unwrap(), b"user edit");
}

#[test]
fn recovery_marker_is_idempotent_only_for_its_owner() {
    let r = Rig::new();
    let lease = WorkspaceLease::acquire(&r.root).unwrap();
    lease.block("11111111-1111-4111-8111-111111111111").unwrap();
    lease.block("11111111-1111-4111-8111-111111111111").unwrap();
    assert!(lease.block("22222222-2222-4222-8222-222222222222").is_err());
    drop(lease);
    assert!(WorkspaceLease::acquire(&r.root).is_err());
    let lease = WorkspaceLease::recover(&r.root, "11111111-1111-4111-8111-111111111111").unwrap();
    lease
        .resolve("11111111-1111-4111-8111-111111111111")
        .unwrap();
    drop(lease);
    WorkspaceLease::acquire(&r.root).unwrap();
}

#[test]
fn interactive_shells_allow_writers_but_guard_destructive_operations_in_both_directions() {
    WorkspaceLease::isolate_registry_for_tests();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let child = root.join("child");
    let sibling = temp.path().join("sibling");
    fs::create_dir_all(&child).unwrap(); fs::create_dir_all(&sibling).unwrap();
    let shell = WorkspaceLease::terminal(&root).unwrap();
    assert!(WorkspaceLease::writer(&root).is_ok());
    assert!(WorkspaceLease::writer(&child).is_ok());
    assert!(WorkspaceLease::acquire(&root).is_err());
    assert!(WorkspaceLease::acquire(&child).is_err());
    assert!(WorkspaceLease::acquire(&sibling).is_ok());
    let writer = WorkspaceLease::writer(&root).unwrap();
    assert!(WorkspaceLease::writer(&child).is_err());
    drop(writer); drop(shell);
    let shell = WorkspaceLease::terminal(&child).unwrap();
    assert!(WorkspaceLease::acquire(&root).is_err());
    drop(shell);
    let restore = WorkspaceLease::acquire(&root).unwrap();
    assert!(WorkspaceLease::terminal(&child).is_err());
    assert!(WorkspaceLease::terminal(&root).is_err());
    assert!(WorkspaceLease::terminal(&sibling).is_ok());
    drop(restore);
    let restore = WorkspaceLease::acquire(&child).unwrap();
    assert!(WorkspaceLease::terminal(&root).is_err());
    drop(restore);
}
