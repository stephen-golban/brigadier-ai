use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;

use rusqlite::{Connection, OptionalExtension, params};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::{
    Counters, Error, MAX_BATCH, NewEvent, Result, Retention, StoredEvent, WriterState, schema,
};

pub(crate) struct WriteCommand {
    pub(crate) op: WriteOp,
}

pub(crate) enum WriteOp {
    Append {
        events: Vec<NewEvent>,
        retention: Option<Retention>,
        reply: AppendReply,
    },
    Checkpoint {
        reply: oneshot::Sender<Result<()>>,
    },
    Shutdown {
        reply: oneshot::Sender<Result<()>>,
    },
}

type Feed = broadcast::Sender<Arc<StoredEvent>>;
type AppendReply = oneshot::Sender<Result<Vec<Arc<StoredEvent>>>>;

struct PendingAppend {
    events: Vec<NewEvent>,
    retention: Option<Retention>,
    reply: AppendReply,
}

pub(crate) fn spawn(
    db_path: PathBuf,
    rx: mpsc::Receiver<WriteCommand>,
    feed: Feed,
    counters: Arc<Counters>,
    state: watch::Sender<WriterState>,
    ready: std::sync::mpsc::Sender<Result<()>>,
) -> Result<()> {
    std::thread::Builder::new()
        .name("store-writer".into())
        .spawn(move || {
            let mut guard = StateGuard {
                state,
                outcome: None,
            };
            let mut writer = match Writer::open(&db_path, feed, counters) {
                Ok(writer) => {
                    let _ = ready.send(Ok(()));
                    writer
                }
                Err(err) => {
                    guard.outcome = Some(WriterState::Died(err.to_string()));
                    let _ = ready.send(Err(err));
                    return;
                }
            };
            guard.outcome = Some(match writer.run(rx) {
                Ok(()) => WriterState::Stopped,
                Err(err) => {
                    tracing::error!(error = %err, "store writer failed");
                    WriterState::Died(err.to_string())
                }
            });
        })?;
    Ok(())
}

/// Publishes how the writer ended, including when it unwinds from a panic.
struct StateGuard {
    state: watch::Sender<WriterState>,
    outcome: Option<WriterState>,
}

impl Drop for StateGuard {
    fn drop(&mut self) {
        let outcome = self.outcome.take().unwrap_or_else(|| {
            WriterState::Died(if std::thread::panicking() {
                "store writer panicked".into()
            } else {
                "store writer exited unexpectedly".into()
            })
        });
        self.state.send_replace(outcome);
    }
}

struct Writer {
    conn: Connection,
    wal_path: PathBuf,
    feed: Feed,
    counters: Arc<Counters>,
    /// Last `stream_seq` per stream. Only this thread writes, so the cache is authoritative.
    heads: HashMap<String, i64>,
}

/// Bound on cached stream heads; the cache is simply reloaded from the index when cleared.
const MAX_CACHED_HEADS: usize = 16_384;

impl Writer {
    fn open(db_path: &Path, feed: Feed, counters: Arc<Counters>) -> Result<Self> {
        let mut conn = Connection::open(db_path)?;
        schema::configure_writer(&conn)?;
        schema::migrate(&mut conn)?;
        let last_seq: i64 =
            conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM events", [], |row| {
                row.get(0)
            })?;
        counters.last_seq.store(last_seq, Ordering::Release);
        let mut wal_path = db_path.as_os_str().to_owned();
        wal_path.push("-wal");
        let writer = Self {
            conn,
            wal_path: wal_path.into(),
            feed,
            counters,
            heads: HashMap::new(),
        };
        writer.record_wal_size();
        Ok(writer)
    }

    fn run(&mut self, mut rx: mpsc::Receiver<WriteCommand>) -> Result<()> {
        let mut batch = Vec::with_capacity(MAX_BATCH);
        loop {
            // Sleep until there is work, then take whatever else is already queued.
            let Some(first) = rx.blocking_recv() else {
                // Every handle was dropped without an explicit shutdown: still close cleanly.
                return self.checkpoint("TRUNCATE");
            };
            batch.push(first);
            while batch.len() < MAX_BATCH {
                match rx.try_recv() {
                    Ok(command) => batch.push(command),
                    Err(_) => break,
                }
            }

            let mut shutdown = None;
            let mut checkpoints = Vec::new();
            let mut appends = Vec::new();
            for command in batch.drain(..) {
                match command.op {
                    WriteOp::Append {
                        events,
                        retention,
                        reply,
                    } => appends.push(PendingAppend {
                        events,
                        retention,
                        reply,
                    }),
                    WriteOp::Checkpoint { reply } => checkpoints.push(reply),
                    WriteOp::Shutdown { reply } => shutdown = Some(reply),
                }
            }

            if shutdown.is_some() {
                // Admission is already closed; commit anything that raced in behind us.
                rx.close();
                while let Ok(command) = rx.try_recv() {
                    match command.op {
                        WriteOp::Append {
                            events,
                            retention,
                            reply,
                        } => appends.push(PendingAppend {
                            events,
                            retention,
                            reply,
                        }),
                        WriteOp::Checkpoint { reply } => checkpoints.push(reply),
                        WriteOp::Shutdown { reply } => {
                            let _ = reply.send(Ok(()));
                        }
                    }
                }
            }

            if !appends.is_empty() {
                self.commit(appends)?;
            }
            for reply in checkpoints {
                let _ = reply.send(self.checkpoint("PASSIVE"));
            }
            if let Some(reply) = shutdown {
                let result = self.checkpoint("TRUNCATE");
                let failed = result.as_ref().err().map(ToString::to_string);
                let _ = reply.send(result);
                tracing::info!("store writer stopped");
                return match failed {
                    Some(err) => Err(Error::Io(std::io::Error::other(err))),
                    None => Ok(()),
                };
            }
        }
    }

    /// Commits every append in one transaction, isolating each command in a savepoint so one
    /// bad command fails alone. Replies and the live feed only see committed events.
    fn commit(&mut self, appends: Vec<PendingAppend>) -> Result<()> {
        let started = Instant::now();
        let commands = appends.len() as u64;
        let mut outcomes = Vec::with_capacity(appends.len());

        let mut tx = self.conn.transaction()?;
        for PendingAppend {
            events,
            retention,
            reply,
        } in appends
        {
            let mut savepoint = tx.savepoint()?;
            match append(&savepoint, &mut self.heads, events, retention) {
                Ok(stored) => {
                    savepoint.commit()?;
                    outcomes.push((reply, Ok(stored)));
                }
                Err(err) => {
                    savepoint.rollback()?;
                    // Heads touched by the failed command may be ahead of the table.
                    self.heads.clear();
                    outcomes.push((reply, Err(err)));
                }
            }
        }
        if let Err(err) = tx.commit() {
            self.heads.clear();
            let message = err.to_string();
            for (reply, _) in outcomes {
                let _ = reply.send(Err(Error::Io(std::io::Error::other(message.clone()))));
            }
            return Err(err.into());
        }

        let mut committed = 0u64;
        for (reply, outcome) in outcomes {
            if let Ok(stored) = &outcome {
                for event in stored {
                    committed += 1;
                    self.counters.last_seq.store(event.seq, Ordering::Release);
                    // No receivers is fine; lagging receivers are handled on their side.
                    let _ = self.feed.send(event.clone());
                }
            }
            let _ = reply.send(outcome);
        }

        let c = &self.counters;
        c.committed_batches.fetch_add(1, Ordering::Relaxed);
        c.committed_events.fetch_add(committed, Ordering::Relaxed);
        c.last_batch_commands.store(commands, Ordering::Relaxed);
        c.last_commit_us
            .store(started.elapsed().as_micros() as u64, Ordering::Relaxed);
        self.record_wal_size();
        if self.heads.len() > MAX_CACHED_HEADS {
            self.heads.clear();
        }
        Ok(())
    }

    fn checkpoint(&self, mode: &str) -> Result<()> {
        let (busy, _log, _done): (i64, i64, i64) =
            self.conn
                .query_row(&format!("PRAGMA wal_checkpoint({mode})"), [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?;
        if busy != 0 {
            tracing::debug!(
                mode,
                "wal checkpoint could not complete while readers were active"
            );
        }
        self.counters.checkpoints.fetch_add(1, Ordering::Relaxed);
        self.record_wal_size();
        Ok(())
    }

    fn record_wal_size(&self) {
        let bytes = std::fs::metadata(&self.wal_path)
            .map(|m| m.len())
            .unwrap_or(0);
        self.counters.wal_bytes.store(bytes, Ordering::Relaxed);
    }
}

fn append(
    conn: &Connection,
    heads: &mut HashMap<String, i64>,
    events: Vec<NewEvent>,
    retention: Option<Retention>,
) -> Result<Vec<Arc<StoredEvent>>> {
    let mut insert = conn.prepare_cached(
        "INSERT INTO events (stream, stream_seq, kind, at_ms, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    let mut stored = Vec::with_capacity(events.len());
    for event in events {
        let head = match heads.get(&event.stream) {
            Some(head) => *head,
            None => conn
                .query_row(
                    "SELECT MAX(stream_seq) FROM events WHERE stream = ?1",
                    [&event.stream],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .optional()?
                .flatten()
                .unwrap_or(0),
        };
        let stream_seq = head + 1;
        insert.execute(params![
            event.stream,
            stream_seq,
            event.kind,
            event.at_ms,
            event.payload.get()
        ])?;
        heads.insert(event.stream.clone(), stream_seq);
        stored.push(Arc::new(StoredEvent {
            seq: conn.last_insert_rowid(),
            stream: event.stream,
            stream_seq,
            kind: event.kind,
            at_ms: event.at_ms,
            payload: event.payload,
        }));
    }
    if let Some(Retention { keep_last }) = retention {
        let mut trim =
            conn.prepare_cached("DELETE FROM events WHERE stream = ?1 AND stream_seq <= ?2")?;
        let mut trimmed: Vec<&str> = Vec::new();
        for event in &stored {
            if trimmed.contains(&event.stream.as_str()) {
                continue;
            }
            trimmed.push(&event.stream);
            let head = heads[&event.stream];
            trim.execute(params![event.stream, head - i64::from(keep_last)])?;
        }
    }
    Ok(stored)
}
