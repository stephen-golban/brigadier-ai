use rusqlite::Connection;
use rusqlite_migration::{M, Migrations};

/// Schema migrations, applied in order by the writer when a Brain opens. Append only: unlike
/// the code index, a Brain is not a cache and cannot be rebuilt from anything.
fn migrations() -> Migrations<'static> {
    Migrations::from_iter([M::up(
        // `rid` is the rowid the FTS tables point at; an explicit INTEGER PRIMARY KEY keeps it
        // stable across VACUUM, which an implicit rowid is not.
        "CREATE TABLE meta (
            key    TEXT PRIMARY KEY,
            value  TEXT NOT NULL
        ) STRICT, WITHOUT ROWID;

        CREATE TABLE nodes (
            rid             INTEGER PRIMARY KEY,
            id              TEXT    NOT NULL UNIQUE,
            kind            TEXT    NOT NULL,
            key             TEXT,
            title           TEXT    NOT NULL,
            body            TEXT    NOT NULL,
            state           TEXT    NOT NULL DEFAULT 'fresh',
            stale_reason    TEXT,
            stale_since_ms  INTEGER,
            superseded_by   TEXT,
            provenance      TEXT    NOT NULL,
            session_id      TEXT,
            created_ms      INTEGER NOT NULL,
            updated_ms      INTEGER NOT NULL,
            expires_ms      INTEGER,
            embedding       BLOB,
            embed_model     TEXT
        ) STRICT;
        CREATE UNIQUE INDEX nodes_by_kind_key ON nodes (kind, key) WHERE key IS NOT NULL;
        CREATE INDEX nodes_by_key ON nodes (key) WHERE key IS NOT NULL;
        CREATE INDEX nodes_by_session ON nodes (session_id) WHERE session_id IS NOT NULL;
        CREATE INDEX nodes_by_updated ON nodes (updated_ms);
        CREATE INDEX nodes_by_superseder ON nodes (superseded_by) WHERE superseded_by IS NOT NULL;
        CREATE INDEX nodes_expiring ON nodes (expires_ms) WHERE expires_ms IS NOT NULL;

        CREATE TABLE edges (
            from_id  TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
            to_id    TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
            kind     TEXT NOT NULL,
            PRIMARY KEY (from_id, to_id, kind)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX edges_by_to ON edges (to_id);

        CREATE TABLE node_files (
            node_id  TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
            path     TEXT NOT NULL,
            hash     TEXT,
            PRIMARY KEY (node_id, path)
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX node_files_by_path ON node_files (path);

        CREATE VIRTUAL TABLE nodes_fts USING fts5 (
            title, body,
            content = 'nodes', content_rowid = 'rid',
            tokenize = 'porter unicode61'
        );
        CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes BEGIN
            INSERT INTO nodes_fts (rowid, title, body) VALUES (new.rid, new.title, new.body);
        END;
        CREATE TRIGGER nodes_fts_delete AFTER DELETE ON nodes BEGIN
            INSERT INTO nodes_fts (nodes_fts, rowid, title, body)
                VALUES ('delete', old.rid, old.title, old.body);
        END;
        CREATE TRIGGER nodes_fts_update AFTER UPDATE OF title, body ON nodes BEGIN
            INSERT INTO nodes_fts (nodes_fts, rowid, title, body)
                VALUES ('delete', old.rid, old.title, old.body);
            INSERT INTO nodes_fts (rowid, title, body) VALUES (new.rid, new.title, new.body);
        END;

        CREATE TABLE transcript (
            rid              INTEGER PRIMARY KEY,
            conversation_id  TEXT    NOT NULL,
            seq              INTEGER NOT NULL,
            role             TEXT    NOT NULL,
            request_id       TEXT,
            at_ms            INTEGER NOT NULL,
            text             TEXT    NOT NULL,
            UNIQUE (conversation_id, seq)
        ) STRICT;
        CREATE VIRTUAL TABLE transcript_fts USING fts5 (
            text,
            content = 'transcript', content_rowid = 'rid',
            tokenize = 'porter unicode61'
        );
        CREATE TRIGGER transcript_fts_insert AFTER INSERT ON transcript BEGIN
            INSERT INTO transcript_fts (rowid, text) VALUES (new.rid, new.text);
        END;
        CREATE TRIGGER transcript_fts_delete AFTER DELETE ON transcript BEGIN
            INSERT INTO transcript_fts (transcript_fts, rowid, text)
                VALUES ('delete', old.rid, old.text);
        END;",
    )
    .comment("knowledge graph, its full-text index and the transcript index")])
}

pub(crate) fn migrate(conn: &mut Connection) -> rusqlite_migration::Result<()> {
    migrations().to_latest(conn)
}

/// Pragmas for the writer's connection.
pub(crate) fn configure_writer(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // Durable across application crashes in WAL mode; only an OS crash can drop the latest
    // commits.
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    // Required: edges and file rows go with their node through `ON DELETE CASCADE`.
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "journal_size_limit", 8 * 1024 * 1024)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}

/// Pragmas for the read connections.
pub(crate) fn configure_reader(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "query_only", "ON")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}
