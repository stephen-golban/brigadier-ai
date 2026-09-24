use rusqlite::Connection;
use rusqlite_migration::{M, Migrations};

/// Schema migrations, applied in order by the writer when the store opens. Append only.
const MIGRATIONS: &[M<'static>] = &[M::up(
    "CREATE TABLE events (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        stream      TEXT    NOT NULL,
        stream_seq  INTEGER NOT NULL,
        kind        TEXT    NOT NULL,
        at_ms       INTEGER NOT NULL,
        payload     TEXT    NOT NULL,
        UNIQUE (stream, stream_seq)
    ) STRICT;",
)
.comment("append-only event log")];

pub(crate) fn migrate(conn: &mut Connection) -> rusqlite_migration::Result<()> {
    Migrations::from_slice(MIGRATIONS).to_latest(conn)
}

/// Pragmas for the single read-write connection.
pub(crate) fn configure_writer(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // In WAL mode NORMAL is durable across application crashes; only an OS crash or power
    // loss can drop the most recent commits.
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    // Checkpoint policy: SQLite auto-checkpoints every ~4 MB of WAL (1000 pages), the daemon
    // asks for a PASSIVE checkpoint every CHECKPOINT_INTERVAL, shutdown TRUNCATEs, and a
    // checkpointed WAL is trimmed back to this size.
    conn.pragma_update(None, "wal_autocheckpoint", 1000)?;
    conn.pragma_update(None, "journal_size_limit", 16 * 1024 * 1024)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}

/// Pragmas for read-only pool connections.
pub(crate) fn configure_reader(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "query_only", "ON")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}
