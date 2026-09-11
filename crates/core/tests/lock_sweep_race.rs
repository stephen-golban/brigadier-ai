//! The sweep against a live acquirer. Its own binary, and therefore its own registry, so that
//! hammering the directory cannot perturb the exact-message assertions in `lock_registry.rs`.
//! see docs/research/workspace-lock-holder-identity-2026-09-11.md §3
#![cfg(unix)]
use brigadier_core::checkpoint::WorkspaceLease;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[test]
fn a_sweep_running_against_an_acquisition_never_refuses_it_and_never_breaks_exclusion() {
    WorkspaceLease::isolate_registry_for_tests();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("work");
    std::fs::create_dir(&root).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let sweeping = stop.clone();
    // The sweep unlinks files it has locked, so an acquirer can be holding an orphaned inode or
    // be refused by a lock that belongs to nobody. Both are retried, and neither may surface.
    let sweeper = std::thread::spawn(move || {
        while !sweeping.load(Ordering::Relaxed) {
            WorkspaceLease::sweep_registry().unwrap();
        }
    });
    for _ in 0..200 {
        let held = match WorkspaceLease::acquire(&root) {
            Ok(held) => held,
            Err(e) => panic!("a concurrent sweep refused an uncontended workspace: {e}"),
        };
        assert!(
            WorkspaceLease::acquire(&root).is_err(),
            "a concurrent sweep must not delete a held lock file out from under exclusion"
        );
        drop(held);
    }
    stop.store(true, Ordering::Relaxed);
    sweeper.join().unwrap();
}
