//! brigadier-store: the supervisor's own state, on one SQLite file and one writer thread.
//!
//! Four things live here and nothing else does:
//!
//! - [`schema`] — the tables, the pragmas, and the `user_version` migration ladder.
//! - `writer` (private) — one `rusqlite::Connection` on one dedicated thread, one transaction per
//!   ~250 ms across every session, reached through a clone-cheap [`StoreHandle`].
//! - [`feed`] — the bounded one-line row a canonical event contributes to the UI feed, and
//!   [`feed::apply`], the single call an adapter's consumer makes per envelope.
//! - [`ndjson`] — our own size-rotated NDJSON, which is where raw provider traffic goes.
//!
//! Raw provider traffic is never stored in the database, and neither is anything append-only
//! and archival: per session one upserted row, a feed ring capped at
//! [`StoreConfig::feed_cap`], usage overwritten from the provider's latest cumulative frame,
//! and approvals kept only so a reload can re-render a prompt.
// see docs/research/persistence.md — §2 for rusqlite over sqlx, §3 for the write patterns and
// every pragma, §4 for the NDJSON sink, §6 for approvals and the per-launch `run_id`.

#![deny(unsafe_code)]
#![warn(missing_docs)]

pub mod feed;
pub mod ndjson;
pub mod schema;
mod writer;

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub use feed::FeedKind;
pub use schema::{
    ApprovalRecord, FeedRow, ProjectRow, SessionRecord, SessionRow, SessionStatus, EXPIRED_REASON,
};
pub use writer::StoreHandle;

/// Database filename under the store root.
pub const DB_FILENAME: &str = "brigadier.sqlite";

/// Lock filename under the store root. One app instance per data directory.
// see docs/research/data-dir-lock.md — `Store::open` settles every unfinished session
// unconditionally, so a second instance on one directory would fail the first instance's live
// sessions. The decision is to refuse the second instance rather than to scope the sweep.
pub const LOCK_FILENAME: &str = "brigadier.lock";

/// Log loudly above this size. t3code's growth was invisible until a user measured it.
// see docs/research/persistence.md §3, last bullet.
pub const SIZE_WARN_BYTES: u64 = 200 * 1024 * 1024;

/// Anything that can go wrong in this crate.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// SQLite said no.
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The filesystem said no.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// A stored JSON value could not be encoded or decoded.
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    /// The database was written by a newer build of the app.
    #[error("database is at migration {found}, this build knows {known}")]
    Newer {
        /// `user_version` found in the file.
        found: usize,
        /// Migrations this build ships.
        known: usize,
    },
    /// A pragma name that is not a bare lowercase identifier was asked for.
    #[error("refusing to interpolate pragma name {0:?}")]
    BadPragma(String),
    /// The writer thread has stopped; nothing further will be persisted.
    #[error("store is closed")]
    Closed,
    /// Another instance of the app is already using this data directory.
    #[error("another brigadier instance already holds {}", path.display())]
    Locked {
        /// The lock file that is held.
        path: PathBuf,
    },
}

/// This crate's result type.
pub type Result<T> = std::result::Result<T, Error>;

/// Tunables. The defaults are the ones the research argues for.
#[derive(Clone, Copy, Debug)]
pub struct StoreConfig {
    /// How long the writer coalesces ops before committing. One transaction per window, across
    /// every session.
    // see docs/research/persistence.md §3 — SQLite does "50,000 or more INSERT statements per
    // second" but "approximately 60 transactions per second"; batching is the whole game, and
    // in WAL "there can only be one writer at a time" so all sessions share this window.
    pub batch_window: Duration,
    /// Feed rows kept per session. Older rows are deleted in the same transaction that inserts.
    pub feed_cap: usize,
}

impl Default for StoreConfig {
    fn default() -> Self {
        Self { batch_window: Duration::from_millis(250), feed_cap: 500 }
    }
}

/// An exclusive advisory lock on `<root>/brigadier.lock`, held for as long as the value lives.
///
/// This is what makes one data directory admit one app instance. `Store::open` takes it before it
/// expires approvals or settles stale sessions, both of which are unscoped sweeps that would
/// otherwise kill a *running* instance's sessions from a second instance's startup.
///
/// The lock is `flock(LOCK_EX)` on macOS: advisory, owned by the open file description, and
/// released when the file closes — so a crash or a `kill -9` leaves nothing to clean up.
// see docs/research/data-dir-lock.md — `File::try_lock` is stable since Rust 1.89 (this toolchain
// is 1.98), so no crate is needed.
#[derive(Debug)]
pub struct DataDirLock {
    file: std::fs::File,
    path: PathBuf,
}

impl DataDirLock {
    /// Take the lock, or say who has it.
    ///
    /// Returns [`Error::Locked`] when another instance — in this process or any other — holds it.
    pub fn acquire(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        let path = root.join(LOCK_FILENAME);
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        match file.try_lock() {
            Ok(()) => Ok(Self { file, path }),
            Err(std::fs::TryLockError::WouldBlock) => Err(Error::Locked { path }),
            Err(std::fs::TryLockError::Error(e)) => Err(Error::Io(e)),
        }
    }

    /// The lock file.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for DataDirLock {
    fn drop(&mut self) {
        // Closing the descriptor would release it anyway; unlocking first makes the release
        // explicit and keeps the field read, rather than relying on drop order.
        let _ = self.file.unlock();
    }
}

/// The open database: a writer thread, the handle to it, and this launch's `run_id`.
#[derive(Debug)]
pub struct Store {
    handle: StoreHandle,
    join: Option<std::thread::JoinHandle<()>>,
    run_id: String,
    path: PathBuf,
    lock: DataDirLock,
}

impl Store {
    /// Take the data-directory lock, then open (or create) `<root>/brigadier.sqlite`, migrate it,
    /// mint a fresh `run_id`, expire every approval that was still pending, and fail every
    /// session left unfinished.
    ///
    /// Blocking, and meant to be called once at startup before the UI loads.
    pub fn open(root: &Path) -> Result<Self> {
        Self::open_with(root, StoreConfig::default())
    }

    /// [`Store::open`] with explicit tunables.
    ///
    /// Fails with [`Error::Locked`] when another instance already holds this directory.
    pub fn open_with(root: &Path, config: StoreConfig) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        // Before either unscoped sweep below: both would settle a *live* instance's rows.
        // see docs/research/data-dir-lock.md.
        let lock = DataDirLock::acquire(root)?;
        let path = root.join(DB_FILENAME);
        let conn = schema::open_connection(&path)?;

        // A launch stamp, so the UI can tell a *resumable* pending prompt (the Rust host
        // survived a webview reload) from one whose listener died with the process.
        // see docs/research/persistence.md §6 — more reliable than a pid, which gets reused.
        let run_id = uuid::Uuid::new_v4().to_string();
        schema::set_run_id(&conn, &run_id)?;

        // Unconditional: a row that outlived the process has no one listening on its one-shot.
        // see docs/research/persistence.md §6.
        let expired = schema::expire_pending_approvals(&conn, SystemTime::now())?;
        if expired > 0 {
            tracing::info!(expired, run_id, "expired approvals left by a previous launch");
        }

        // Same reasoning, one table over: a session still `starting` or `running` in the file is
        // one whose consumer task died with the process, and nothing will ever settle it.
        let stale = schema::settle_stale_sessions(&conn, SystemTime::now())?;
        if stale > 0 {
            tracing::info!(stale, run_id, "failed sessions left unfinished by a previous launch");
        }

        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > SIZE_WARN_BYTES {
                tracing::warn!(bytes = meta.len(), path = %path.display(), "store is large");
            }
        }

        let (handle, join) = writer::spawn(conn, run_id.clone(), config)?;
        Ok(Self { handle, join: Some(join), run_id, path, lock })
    }

    /// The clone-cheap handle every writer and reader goes through.
    pub fn handle(&self) -> &StoreHandle {
        &self.handle
    }

    /// This launch's id. An [`ApprovalRecord`] carrying a different one belongs to a lost launch.
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// The database file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The data-directory lock this store holds until it is dropped.
    pub fn lock_path(&self) -> &Path {
        self.lock.path()
    }

    /// Total bytes of the database and its WAL sidecars.
    pub fn size_on_disk(&self) -> u64 {
        ["", "-wal", "-shm"]
            .iter()
            .filter_map(|suffix| {
                let mut p = self.path.clone().into_os_string();
                p.push(suffix);
                std::fs::metadata(PathBuf::from(p)).ok().map(|m| m.len())
            })
            .sum()
    }

    /// Flush, checkpoint, and join the writer thread.
    ///
    /// The join briefly blocks the calling task while the last transaction commits and the WAL
    /// is folded back in; this is a shutdown path, measured in milliseconds.
    pub async fn close(mut self) -> Result<()> {
        let join = self.join.take();
        self.handle.flush().await?;
        self.handle.shutdown();
        if let Some(join) = join {
            let _ = join.join();
        }
        Ok(())
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        // A dropped store must not leak the thread. Queued ops still commit: `Shutdown` is the
        // last op in the channel, and the batch carrying it is applied before the loop breaks.
        if let Some(join) = self.join.take() {
            self.handle.shutdown();
            let _ = join.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brigadier_core::event::{ExitReason, SessionId};
    use schema::SessionRow;

    async fn upsert(store: &Store, id: &str, status: Option<SessionStatus>) {
        let mut row = SessionRow::new(SessionId::new(id));
        row.status = status;
        store.handle().upsert_session(row).await.expect("upsert");
    }

    #[tokio::test]
    async fn a_session_left_unfinished_by_a_previous_launch_is_failed_at_open() {
        let dir = tempfile::tempdir().expect("temp dir");

        let store = Store::open(dir.path()).expect("store opens");
        upsert(&store, "running", Some(SessionStatus::Running)).await;
        upsert(&store, "starting", None).await;
        upsert(&store, "done", Some(SessionStatus::Running)).await;
        store
            .handle()
            .session_ended(
                SessionId::new("done"),
                ExitReason::Graceful,
                Some(0),
                SystemTime::now(),
            )
            .await
            .expect("session ended");
        let before = store
            .handle()
            .session(SessionId::new("done"))
            .await
            .expect("read")
            .expect("row");
        assert_eq!(before.status, SessionStatus::Exited);
        store.close().await.expect("store closes");

        let store = Store::open(dir.path()).expect("store reopens");
        let read = |id: &str| {
            let handle = store.handle().clone();
            let id = SessionId::new(id);
            async move { handle.session(id).await.expect("read").expect("row") }
        };

        for id in ["running", "starting"] {
            let row = read(id).await;
            assert_eq!(row.status, SessionStatus::Failed, "{id} was left unfinished");
            assert!(row.ended_at.is_some(), "{id} must be stamped with an end time");
            assert_eq!(row.exit_code, None, "{id} never reported an exit code");
        }

        // A session that already reached a terminal status is left exactly as it was.
        let after = read("done").await;
        assert_eq!(after, before, "an already-exited session is untouched");

        store.close().await.expect("store closes");
    }

    /// One data directory, one instance. The second `Store::open` is refused rather than allowed
    /// to run `settle_stale_sessions` over the first instance's live rows.
    // see docs/research/data-dir-lock.md.
    #[tokio::test]
    async fn a_second_store_on_the_same_data_dir_is_refused() {
        let dir = tempfile::tempdir().expect("temp dir");
        let first = Store::open(dir.path()).expect("first store opens");
        assert_eq!(first.lock_path(), dir.path().join(LOCK_FILENAME));

        match Store::open(dir.path()) {
            Err(Error::Locked { path }) => {
                assert_eq!(path, dir.path().join(LOCK_FILENAME));
            }
            other => panic!("a second instance must be refused, got {other:?}"),
        }

        // Dropping the first store closes the file, which is what releases the flock.
        first.close().await.expect("store closes");
        let again = Store::open(dir.path()).expect("the lock goes with the store that held it");
        again.close().await.expect("store closes");
    }

    /// The upsert cannot clear `ended_at`/`exit_code` — they are not in its statement, and every
    /// column that is, is `COALESCE`d — so a resumed row would keep reading as ended while it is
    /// live. `session_resumed` is the op that clears them.
    // see docs/research/resume.md §8 gap 5.
    #[tokio::test]
    async fn resuming_a_session_clears_the_ending_the_upsert_cannot_clear() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = Store::open(dir.path()).expect("store opens");
        let id = SessionId::new("s");

        let mut row = SessionRow::new(id.clone());
        row.started_at = Some(SystemTime::UNIX_EPOCH + Duration::from_millis(1_000));
        store.handle().upsert_session(row).await.expect("upsert");
        store
            .handle()
            .session_ended(id.clone(), ExitReason::Graceful, Some(0), SystemTime::now())
            .await
            .expect("session ended");
        store.handle().flush().await.expect("flush");
        let ended = store.handle().session(id.clone()).await.expect("read").expect("row");
        assert_eq!(ended.status, SessionStatus::Exited);
        assert!(ended.ended_at.is_some());
        assert_eq!(ended.exit_code, Some(0));

        // What the supervisor's resume path does, in order: clear, then merge the new instance.
        store.handle().session_resumed(id.clone(), SystemTime::now()).await.expect("resumed");
        let mut row = SessionRow::new(id.clone());
        row.status = Some(SessionStatus::Starting);
        row.instance_id = Some(brigadier_core::event::InstanceId::new("claude-code:2"));
        // Deliberately no `started_at`: `upsert_session` COALESCEs the *parameter* first, so a
        // non-`None` value overwrites rather than defers, and the resume path must not.
        store.handle().upsert_session(row).await.expect("upsert");
        store.handle().flush().await.expect("flush");

        let resumed = store.handle().session(id.clone()).await.expect("read").expect("row");
        assert_eq!(resumed.status, SessionStatus::Starting);
        assert_eq!(resumed.ended_at, None, "a live session must not carry an end time");
        assert_eq!(resumed.exit_code, None, "nor a stale exit code");
        assert_eq!(
            resumed.started_at, ended.started_at,
            "the start time is kept here — only until the resumed child announces itself, when \
             `feed::apply`'s SessionStarted branch overwrites it"
        );
        assert_eq!(resumed.instance_id.as_ref().map(|i| i.as_str()), Some("claude-code:2"));

        store.close().await.expect("store closes");
    }

    /// Pins the **store behaviour** the resume feature depends on, not the seeding itself.
    ///
    /// Two claims, both about this crate: rows written at seqs above `last_event_seq` append
    /// without disturbing what is already there, and — the reason the seeding exists — a row
    /// written at a seq that already exists is silently *updated*, because `feed`'s insert is
    /// `ON CONFLICT(session_id, seq) DO UPDATE`. A second adapter that restarted numbering at 1
    /// would therefore rewrite the old conversation in place and never error.
    ///
    /// It does **not** prove that anything seeds the adapter: reverting `AdapterConfig.start_seq`
    /// leaves this test green. The proof of the seeding is
    /// `crates/supervisor/src/lib.rs::a_resumed_session_reuses_its_row_and_continues_its_feed`,
    /// which drives a real resume end to end.
    // see docs/research/resume.md §7.
    #[tokio::test]
    async fn a_resumed_sessions_rows_land_after_the_old_ones_and_leave_them_untouched() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = Store::open(dir.path()).expect("store opens");
        let id = SessionId::new("s");
        let at = |ms: u64| SystemTime::UNIX_EPOCH + Duration::from_millis(ms);

        for seq in 1..=3u64 {
            store
                .handle()
                .feed(id.clone(), seq, at(seq), FeedKind::Sys, format!("before {seq}"))
                .await
                .expect("feed");
        }
        store.handle().flush().await.expect("flush");
        let before = store.handle().feed_tail(id.clone(), 100).await.expect("tail");
        let old_seq = store.handle().session(id.clone()).await.expect("read").expect("row")
            .last_event_seq;
        assert_eq!(old_seq, 3, "last_event_seq tracks the newest row");

        // The resumed adapter is seeded from `old_seq`, so its first envelope is `old_seq + 1`.
        for offset in 1..=2u64 {
            let seq = old_seq + offset;
            store
                .handle()
                .feed(id.clone(), seq, at(100 + seq), FeedKind::Sys, format!("after {seq}"))
                .await
                .expect("feed");
        }
        store.handle().flush().await.expect("flush");

        let after = store.handle().feed_tail(id.clone(), 100).await.expect("tail");
        assert_eq!(after.len(), 5, "nothing was overwritten: {after:?}");
        assert_eq!(&after[..3], &before[..], "every pre-resume row is byte-identical");
        assert!(
            after[3..].iter().all(|r| r.seq > old_seq),
            "every post-resume row lands after the old ones: {:?}",
            &after[3..]
        );
        assert_eq!(
            store.handle().session(id.clone()).await.expect("read").expect("row").last_event_seq,
            5
        );

        // And the failure this guards against, spelled out: an adapter that restarted at 1 would
        // have rewritten the oldest row in place rather than appending.
        store
            .handle()
            .feed(id.clone(), 1, at(999), FeedKind::Sys, "a restart at seq 1".to_owned())
            .await
            .expect("feed");
        store.handle().flush().await.expect("flush");
        let clobbered = store.handle().feed_tail(id.clone(), 100).await.expect("tail");
        assert_eq!(clobbered.len(), 5, "the collision silently updated instead of erroring");
        assert_eq!(clobbered[0].line, "a restart at seq 1");

        store.close().await.expect("store closes");
    }
}
