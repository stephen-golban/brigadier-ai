use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OpenFlags, Row, params, params_from_iter};
use serde_json::value::RawValue;
use tokio::sync::{mpsc, oneshot};

use crate::{Error, MAX_PAGE, Result, StoredEvent, StreamHead, StreamPage, schema};

type Job = Box<dyn FnOnce(&Connection) + Send>;

/// Capacity of the async → reader queue.
const READ_QUEUE: usize = 256;

/// Fixed pool of reader threads, each owning a read-only connection.
#[derive(Clone)]
pub(crate) struct ReadPool {
    jobs: mpsc::Sender<Job>,
}

impl ReadPool {
    pub(crate) fn spawn(db_path: &Path, readers: usize) -> Result<Self> {
        let (jobs, rx) = mpsc::channel::<Job>(READ_QUEUE);
        let rx = Arc::new(Mutex::new(rx));
        for index in 0..readers {
            let conn = Connection::open_with_flags(
                db_path,
                OpenFlags::SQLITE_OPEN_READ_ONLY
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX
                    | OpenFlags::SQLITE_OPEN_URI,
            )?;
            schema::configure_reader(&conn)?;
            let rx = rx.clone();
            std::thread::Builder::new()
                .name(format!("store-reader-{index}"))
                .spawn(move || {
                    loop {
                        // One idle thread waits on the queue while the others wait on the lock.
                        let job = match rx.lock() {
                            Ok(mut rx) => rx.blocking_recv(),
                            Err(_) => return,
                        };
                        let Some(job) = job else { return };
                        // A panicking read drops its reply (the caller sees an error); the
                        // thread and its connection stay usable.
                        if catch_unwind(AssertUnwindSafe(|| job(&conn))).is_err() {
                            tracing::error!("store read panicked");
                        }
                    }
                })?;
        }
        Ok(Self { jobs })
    }

    /// Runs `read` on a pool thread. The closure must return fully materialized data.
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        read: impl FnOnce(&Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        let job: Job = Box::new(move |conn| {
            let _ = tx.send(read(conn));
        });
        self.jobs.send(job).await.map_err(|_| Error::ReaderGone)?;
        rx.await.map_err(|_| Error::ReaderGone)?
    }
}

fn clamp(limit: u32) -> u32 {
    limit.clamp(1, MAX_PAGE)
}

fn event(row: &Row<'_>) -> rusqlite::Result<StoredEvent> {
    let payload: String = row.get(5)?;
    Ok(StoredEvent {
        seq: row.get(0)?,
        stream: row.get(1)?,
        stream_seq: row.get(2)?,
        kind: row.get(3)?,
        at_ms: row.get(4)?,
        payload: RawValue::from_string(payload).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, err.into())
        })?,
    })
}

const COLUMNS: &str = "seq, stream, stream_seq, kind, at_ms, payload";

pub(crate) fn read_stream(
    conn: &Connection,
    stream: &str,
    page: &StreamPage,
) -> Result<Vec<StoredEvent>> {
    let mut sql = format!("SELECT {COLUMNS} FROM events WHERE stream = ?");
    let mut args: Vec<rusqlite::types::Value> = vec![stream.to_owned().into()];
    if !page.kinds.is_empty() {
        sql.push_str(" AND kind IN (");
        for (index, kind) in page.kinds.iter().enumerate() {
            sql.push_str(if index == 0 { "?" } else { ", ?" });
            args.push(kind.clone().into());
        }
        sql.push(')');
    }
    if let Some(before) = page.before {
        sql.push_str(" AND stream_seq < ?");
        args.push(before.into());
    }
    // Newest first so a page ends at the most recent event; callers reverse for display.
    sql.push_str(" ORDER BY stream_seq DESC LIMIT ?");
    args.push(i64::from(clamp(page.limit)).into());
    let mut statement = conn.prepare_cached(&sql)?;
    let rows = statement.query_map(params_from_iter(args), event)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub(crate) fn read_since(conn: &Connection, after: i64, limit: u32) -> Result<Vec<StoredEvent>> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM events WHERE seq > ?1 ORDER BY seq LIMIT ?2"
    ))?;
    let rows = statement.query_map(params![after, clamp(limit)], event)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub(crate) fn read_stream_since(
    conn: &Connection,
    stream: &str,
    after: i64,
    limit: u32,
) -> Result<Vec<StoredEvent>> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM events WHERE stream = ?1 AND stream_seq > ?2 \
         ORDER BY stream_seq LIMIT ?3"
    ))?;
    let rows = statement.query_map(params![stream, after, clamp(limit)], event)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub(crate) fn stream_heads(conn: &Connection, prefix: &str) -> Result<Vec<StreamHead>> {
    // A range on the (stream, stream_seq) index instead of LIKE, which cannot use it.
    let mut upper = prefix.to_owned();
    upper.push(char::MAX);
    let mut statement = conn.prepare_cached(
        "SELECT stream, MAX(stream_seq), MAX(at_ms) FROM events \
         WHERE stream >= ?1 AND stream < ?2 GROUP BY stream",
    )?;
    let rows = statement.query_map(params![prefix, upper], |row| {
        Ok(StreamHead {
            stream: row.get(0)?,
            stream_seq: row.get(1)?,
            at_ms: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
