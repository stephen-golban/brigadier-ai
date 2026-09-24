//! Brigadier's event store.
//!
//! - **One writer.** A dedicated OS thread owns the only read-write SQLite connection. Callers
//!   hand it work over a bounded Tokio channel (`send().await` on the async side,
//!   `blocking_recv` on the thread), so a slow disk applies backpressure instead of growing a
//!   queue or blocking the runtime. Everything queued when the writer wakes up is committed in
//!   one transaction, up to [`MAX_BATCH`] commands.
//! - **A read pool.** A fixed set of OS threads with read-only connections. Every read
//!   materializes a bounded page and finishes its statement before the result leaves the
//!   thread, so no WAL snapshot is ever held while a client is being served.
//! - **Append-only streams.** Events are appended per stream with a per-stream sequence and a
//!   global, monotonically increasing `seq` that subscribers use as a resync cursor.
//! - **Blobs.** Large payloads live in a content-addressed store on disk ([`BlobStore`]).
//!
//! Nothing here ever blocks a Tokio worker thread.

mod blob;
mod reader;
mod schema;
mod writer;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::value::RawValue;
use tokio::sync::{broadcast, mpsc, oneshot, watch};

pub use blob::{BlobHash, BlobStore};
use reader::ReadPool;
use writer::{WriteCommand, WriteOp};

/// Most commands the writer folds into one transaction.
pub const MAX_BATCH: usize = 256;
/// Capacity of the async → writer queue; senders wait when it is full.
pub const WRITE_QUEUE: usize = 1024;
/// Largest page any read returns.
pub const MAX_PAGE: u32 = 1000;
/// Capacity of the live event feed; slower subscribers are cut off and must resync.
pub const FEED_CAPACITY: usize = 4096;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("migration: {0}")]
    Migration(#[from] rusqlite_migration::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("the store is shutting down")]
    ShuttingDown,
    #[error("the store writer has stopped")]
    WriterGone,
    #[error("the store read pool has stopped")]
    ReaderGone,
    #[error("invalid blob hash")]
    InvalidBlobHash,
}

pub type Result<T> = std::result::Result<T, Error>;

/// An event to append.
#[derive(Debug, Clone)]
pub struct NewEvent {
    pub stream: String,
    pub kind: String,
    /// Wall-clock time the daemon ingested the event, in ms since the Unix epoch.
    pub at_ms: i64,
    /// JSON payload.
    pub payload: Box<RawValue>,
}

impl NewEvent {
    pub fn new(
        stream: impl Into<String>,
        kind: impl Into<String>,
        at_ms: i64,
        payload: &impl Serialize,
    ) -> Result<Self> {
        Ok(Self {
            stream: stream.into(),
            kind: kind.into(),
            at_ms,
            payload: serde_json::value::to_raw_value(payload)?,
        })
    }
}

/// A committed event.
#[derive(Debug, Clone)]
pub struct StoredEvent {
    /// Global sequence number, unique and increasing across all streams.
    pub seq: i64,
    pub stream: String,
    /// Position within the stream, starting at 1.
    pub stream_seq: i64,
    pub kind: String,
    pub at_ms: i64,
    pub payload: Box<RawValue>,
}

/// Keeps only the newest `keep_last` events of the appended streams (used for diagnostics).
#[derive(Debug, Clone, Copy)]
pub struct Retention {
    pub keep_last: u32,
}

/// Direction and bounds for a stream page.
#[derive(Debug, Clone, Default)]
pub struct StreamPage {
    /// Only events with `stream_seq` below this (paging backwards from the newest).
    pub before: Option<i64>,
    /// Only events of these kinds (empty = all).
    pub kinds: Vec<String>,
    pub limit: u32,
}

/// The newest event of a stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamHead {
    pub stream: String,
    pub stream_seq: i64,
    pub at_ms: i64,
}

/// Store tuning.
#[derive(Debug, Clone)]
pub struct StoreConfig {
    pub db_path: PathBuf,
    pub blobs_dir: PathBuf,
    pub readers: usize,
}

/// Live counters for the Inspector.
#[derive(Debug, Clone, Copy, Default)]
pub struct StoreStats {
    pub last_seq: i64,
    pub queued_writes: usize,
    pub committed_batches: u64,
    pub committed_events: u64,
    pub last_batch_commands: u64,
    pub last_commit_us: u64,
    pub wal_bytes: u64,
    pub checkpoints: u64,
}

/// How the writer thread ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriterState {
    Running,
    /// Stopped after an orderly [`Store::shutdown`].
    Stopped,
    /// Stopped for any other reason (panic, fatal SQLite error). The daemon must exit.
    Died(String),
}

#[derive(Debug, Default)]
struct Counters {
    last_seq: AtomicI64,
    committed_batches: AtomicU64,
    committed_events: AtomicU64,
    last_batch_commands: AtomicU64,
    last_commit_us: AtomicU64,
    wal_bytes: AtomicU64,
    checkpoints: AtomicU64,
}

/// Handle to the event store. Cheap to clone.
#[derive(Clone)]
pub struct Store {
    writes: mpsc::Sender<WriteCommand>,
    reads: ReadPool,
    feed: broadcast::Sender<Arc<StoredEvent>>,
    admitting: Arc<AtomicBool>,
    counters: Arc<Counters>,
    writer_state: watch::Receiver<WriterState>,
    blobs: BlobStore,
}

impl Store {
    /// Opens (creating and migrating if needed) the store and starts its threads.
    ///
    /// This does blocking file I/O. Call it before starting the async runtime or from
    /// `spawn_blocking`.
    pub fn open(config: StoreConfig) -> Result<Self> {
        if let Some(parent) = config.db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let blobs = BlobStore::open(config.blobs_dir.clone())?;
        let counters = Arc::new(Counters::default());
        let (feed, _) = broadcast::channel(FEED_CAPACITY);
        let (writes, writer_rx) = mpsc::channel(WRITE_QUEUE);
        let (state_tx, writer_state) = watch::channel(WriterState::Running);

        // The writer migrates the schema before any reader opens a connection.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        writer::spawn(
            config.db_path.clone(),
            writer_rx,
            feed.clone(),
            counters.clone(),
            state_tx,
            ready_tx,
        )?;
        ready_rx.recv().map_err(|_| Error::WriterGone)??;

        let reads = ReadPool::spawn(&config.db_path, config.readers.max(1))?;
        Ok(Self {
            writes,
            reads,
            feed,
            admitting: Arc::new(AtomicBool::new(true)),
            counters,
            writer_state,
            blobs,
        })
    }

    /// Appends events atomically, in order. Returns them with their assigned sequence numbers
    /// once committed.
    pub async fn append(&self, events: Vec<NewEvent>) -> Result<Vec<Arc<StoredEvent>>> {
        self.append_with(events, None).await
    }

    /// Like [`Store::append`], then trims each touched stream to its newest events.
    pub async fn append_with(
        &self,
        events: Vec<NewEvent>,
        retention: Option<Retention>,
    ) -> Result<Vec<Arc<StoredEvent>>> {
        if !self.admitting.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.command(|reply| WriteOp::Append {
            events,
            retention,
            reply,
        })
        .await?
    }

    /// Asks the writer for a PASSIVE WAL checkpoint without waiting behind a full queue.
    pub fn request_checkpoint(&self) {
        let (reply, _) = oneshot::channel();
        let _ = self.writes.try_send(WriteCommand {
            op: WriteOp::Checkpoint { reply },
        });
    }

    /// Stops admitting writes, commits everything already queued, truncates the WAL and stops
    /// the writer thread.
    pub async fn shutdown(&self) -> Result<()> {
        self.admitting.store(false, Ordering::Release);
        self.command(|reply| WriteOp::Shutdown { reply }).await?
    }

    /// A stream page, newest first (optionally only events before `page.before`).
    pub async fn read_stream(&self, stream: String, page: StreamPage) -> Result<Vec<StoredEvent>> {
        self.reads
            .run(move |conn| reader::read_stream(conn, &stream, &page))
            .await
    }

    /// Every event with `seq > after`, oldest first, at most `limit`.
    pub async fn read_since(&self, after: i64, limit: u32) -> Result<Vec<StoredEvent>> {
        self.reads
            .run(move |conn| reader::read_since(conn, after, limit))
            .await
    }

    /// Every event of `stream` with `stream_seq > after`, oldest first, at most `limit`.
    pub async fn read_stream_since(
        &self,
        stream: String,
        after: i64,
        limit: u32,
    ) -> Result<Vec<StoredEvent>> {
        self.reads
            .run(move |conn| reader::read_stream_since(conn, &stream, after, limit))
            .await
    }

    /// The newest event of every stream whose name starts with `prefix`.
    pub async fn stream_heads(&self, prefix: String) -> Result<Vec<StreamHead>> {
        self.reads
            .run(move |conn| reader::stream_heads(conn, &prefix))
            .await
    }

    /// Subscribes to committed events. A receiver that falls more than [`FEED_CAPACITY`] events
    /// behind gets `Lagged` and must resync with [`Store::read_since`].
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<StoredEvent>> {
        self.feed.subscribe()
    }

    pub fn last_seq(&self) -> i64 {
        self.counters.last_seq.load(Ordering::Acquire)
    }

    pub fn blobs(&self) -> &BlobStore {
        &self.blobs
    }

    pub fn stats(&self) -> StoreStats {
        let c = &self.counters;
        StoreStats {
            last_seq: c.last_seq.load(Ordering::Acquire),
            queued_writes: WRITE_QUEUE - self.writes.capacity(),
            committed_batches: c.committed_batches.load(Ordering::Relaxed),
            committed_events: c.committed_events.load(Ordering::Relaxed),
            last_batch_commands: c.last_batch_commands.load(Ordering::Relaxed),
            last_commit_us: c.last_commit_us.load(Ordering::Relaxed),
            wal_bytes: c.wal_bytes.load(Ordering::Relaxed),
            checkpoints: c.checkpoints.load(Ordering::Relaxed),
        }
    }

    /// Resolves when the writer thread stops, with the reason.
    pub async fn writer_stopped(&self) -> WriterState {
        let mut state = self.writer_state.clone();
        match state.wait_for(|state| *state != WriterState::Running).await {
            Ok(state) => state.clone(),
            Err(_) => WriterState::Died("writer state channel closed".into()),
        }
    }

    async fn command<T>(&self, op: impl FnOnce(oneshot::Sender<T>) -> WriteOp) -> Result<T> {
        let (reply, rx) = oneshot::channel();
        self.writes
            .send(WriteCommand { op: op(reply) })
            .await
            .map_err(|_| Error::WriterGone)?;
        rx.await.map_err(|_| Error::WriterGone)
    }
}

/// Interval for the periodic PASSIVE checkpoint the daemon requests.
pub const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(30);
