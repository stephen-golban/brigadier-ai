//! Open, migrate, and the two pragmas that cannot be fixed later.

use brigadier_store::{Store, StoreConfig, DB_FILENAME};

#[tokio::test]
async fn open_migrates_and_sets_the_pragmas_that_cannot_be_retrofitted() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(dir.path()).expect("open");
    let h = store.handle();

    // 9 == migration 0 (the tables), migration 1 (`feed.kind`, added 2026-09-03; edited in place
    // the same day when its default was corrected from `'sys'` to `'unknown'`, because it had
    // never run on the owner's data dir), migration 2 (`projects.mcp`, 2026-09-03, which
    // switches every existing project to `off`), migration 3 (`intents`, 2026-09-04),
    // migration 4 (the plan tables, 2026-09-04) and migration 5 (`phases.base_sha`, 2026-09-04).
    // Migration 6 adds durable chat items; migration 7 preserves the installed rewind schema.
    assert_eq!(h.pragma_i64("user_version").await.expect("user_version"), 10);
    // 2 == INCREMENTAL. Set as the first statement of migration 0, before any CREATE TABLE,
    // because sqlite.org says it "is not possible to enable or disable auto-vacuum after a
    // table has been created" and the VACUUM escape hatch does not exist in WAL mode.
    assert_eq!(h.pragma_i64("auto_vacuum").await.expect("auto_vacuum"), 2);
    assert_eq!(
        h.pragma_i64("journal_size_limit").await.expect("limit"),
        64 * 1024 * 1024
    );
    assert_eq!(h.pragma_i64("foreign_keys").await.expect("fk"), 1);
    assert_eq!(h.pragma_i64("synchronous").await.expect("sync"), 1); // NORMAL
    assert_eq!(h.pragma_i64("busy_timeout").await.expect("busy"), 5000);

    assert!(dir.path().join(DB_FILENAME).is_file());
    assert!(
        h.pragma_i64("Journal Mode").await.is_err(),
        "pragma names are not interpolated"
    );
    store.close().await.expect("close");
}

#[tokio::test]
async fn reopening_is_idempotent_and_mints_a_new_run_id() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = Store::open(dir.path()).expect("open");
    let run_a = first.run_id().to_owned();
    assert_eq!(
        first.handle().pragma_i64("user_version").await.expect("v"),
        10
    );
    first.close().await.expect("close");

    let second = Store::open_with(dir.path(), StoreConfig::default()).expect("reopen");
    assert_eq!(
        second.handle().pragma_i64("user_version").await.expect("v"),
        10
    );
    assert_eq!(
        second.handle().pragma_i64("auto_vacuum").await.expect("av"),
        2
    );
    assert_ne!(second.run_id(), run_a, "every launch gets its own run_id");
    second.close().await.expect("close");
}
