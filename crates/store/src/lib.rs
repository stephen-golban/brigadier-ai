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

pub use schema::{
    ApprovalRecord, FeedRow, ProjectRow, SessionRecord, SessionRow, SessionStatus, EXPIRED_REASON,
};
pub use writer::StoreHandle;

/// Database filename under the store root.
pub const DB_FILENAME: &str = "brigadier.sqlite";

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

/// The open database: a writer thread, the handle to it, and this launch's `run_id`.
#[derive(Debug)]
pub struct Store {
    handle: StoreHandle,
    join: Option<std::thread::JoinHandle<()>>,
    run_id: String,
    path: PathBuf,
}

impl Store {
    /// Open (or create) `<root>/brigadier.sqlite`, migrate it, mint a fresh `run_id`, and expire
    /// every approval that was still pending.
    ///
    /// Blocking, and meant to be called once at startup before the UI loads.
    pub fn open(root: &Path) -> Result<Self> {
        Self::open_with(root, StoreConfig::default())
    }

    /// [`Store::open`] with explicit tunables.
    pub fn open_with(root: &Path, config: StoreConfig) -> Result<Self> {
        std::fs::create_dir_all(root)?;
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

        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > SIZE_WARN_BYTES {
                tracing::warn!(bytes = meta.len(), path = %path.display(), "store is large");
            }
        }

        let (handle, join) = writer::spawn(conn, run_id.clone(), config)?;
        Ok(Self { handle, join: Some(join), run_id, path })
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
