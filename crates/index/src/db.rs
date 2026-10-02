use std::path::Path;
use std::sync::mpsc::{self, Sender};
use std::thread;

use rusqlite::{Connection, OptionalExtension, params};

use crate::{Error, Result};

pub struct SymbolRow {
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub end_line: u32,
    pub is_def: bool,
    pub signature: String,
    pub doc: Option<String>,
}

pub struct FileRow {
    pub path: String,
    pub lang: String,
    pub size: u64,
    pub mtime_ns: i64,
    pub hash: String,
    pub symbols: Vec<SymbolRow>,
    pub is_new: bool,
}

pub enum Command {
    Apply {
        files: Vec<FileRow>,
        removed: Vec<String>,
        reply: Sender<Result<()>>,
    },
    Popular {
        reply: Sender<Result<()>>,
    },
    /// Files read again whose content had not changed: only their size and time moved.
    Touch {
        files: Vec<Touched>,
        reply: Sender<Result<()>>,
    },
    Metadata {
        manifests: Vec<(String, String)>,
        scripts: Vec<(String, String, String)>,
        services: Vec<(String, String)>,
        reply: Sender<Result<()>>,
    },
    /// Empties every table, for a rebuild.
    Clear {
        reply: Sender<Result<()>>,
    },
}

/// Bumped when the tables or what a parse records change (a tags query, say): an index of
/// another version is dropped and rebuilt from the files on its next scan.
const SCHEMA_VERSION: i64 = 4;

fn db_error(error: impl std::fmt::Display) -> Error {
    Error::Db(error.to_string())
}

pub fn open(path: &Path) -> Result<(Sender<Command>, Vec<std::sync::Mutex<Connection>>)> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| Error::Io {
            path: parent.display().to_string(),
            message: e.to_string(),
        })?;
    }
    let mut connection = Connection::open(path).map_err(db_error)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(db_error)?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(db_error)?;
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(db_error)?;
    if version != SCHEMA_VERSION {
        connection.execute_batch("DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS manifests; DROP TABLE IF EXISTS scripts; DROP TABLE IF EXISTS services; DROP TABLE IF EXISTS popular; DROP TABLE IF EXISTS file_fts; DROP TABLE IF EXISTS symbol_fts;").map_err(db_error)?;
    }
    connection.execute_batch("CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, lang TEXT NOT NULL, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, hash TEXT NOT NULL, indexed_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS symbols(file TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, end_line INTEGER NOT NULL, is_def INTEGER NOT NULL, signature TEXT NOT NULL, doc TEXT);
      CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name, is_def);
      CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file);
      CREATE TABLE IF NOT EXISTS manifests(path TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scripts(name TEXT NOT NULL, command TEXT NOT NULL, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS services(name TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS popular(name TEXT NOT NULL, file TEXT NOT NULL, refs INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS popular_rank ON popular(refs DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts5(path, tokenize='trigram');
      CREATE VIRTUAL TABLE IF NOT EXISTS symbol_fts USING fts5(name, file UNINDEXED, tokenize='trigram');").map_err(db_error)?;
    connection
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(db_error)?;
    let (tx, rx) = mpsc::channel();
    thread::Builder::new()
        .name("index-writer".into())
        .spawn(move || {
            while let Ok(command) = rx.recv() {
                match command {
                    Command::Apply {
                        files,
                        removed,
                        reply,
                    } => {
                        let _ = reply.send(apply(&mut connection, files, removed));
                    }
                    Command::Popular { reply } => {
                    let result = connection.execute_batch("DELETE FROM popular; INSERT INTO popular(name,file,refs) SELECT s.name,s.file,c.n FROM symbols s JOIN (SELECT name,count(*) AS n FROM symbols WHERE is_def=0 GROUP BY name) c ON c.name=s.name WHERE s.is_def=1 ORDER BY c.n DESC LIMIT 2000;").map_err(db_error);
                    let _=reply.send(result);
                }
                Command::Touch { files, reply } => {
                        let _ = reply.send(touch(&mut connection, files));
                    }
                Command::Metadata {
                        manifests,
                        scripts,
                        services,
                        reply,
                    } => {
                        let _ = reply.send(metadata(&mut connection, manifests, scripts, services));
                    }
                    Command::Clear { reply } => {
                        let _ = reply.send(clear(&mut connection));
                    }
                }
            }
        })
        .map_err(db_error)?;
    let mut reads = Vec::new();
    for _ in 0..4 {
        let conn = Connection::open(path).map_err(db_error)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db_error)?;
        reads.push(std::sync::Mutex::new(conn));
    }
    Ok((tx, reads))
}

/// A file whose size or time changed but not its content.
pub struct Touched {
    pub path: String,
    pub size: u64,
    pub mtime_ns: i64,
}

fn touch(conn: &mut Connection, files: Vec<Touched>) -> Result<()> {
    let tx = conn.transaction().map_err(db_error)?;
    for file in &files {
        tx.prepare_cached("UPDATE files SET size=?2, mtime_ns=?3 WHERE path=?1")
            .map_err(db_error)?
            .execute(params![file.path, file.size as i64, file.mtime_ns])
            .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)
}

fn apply(conn: &mut Connection, files: Vec<FileRow>, removed: Vec<String>) -> Result<()> {
    let tx = conn.transaction().map_err(db_error)?;
    for path in removed
        .iter()
        .chain(files.iter().filter(|f| !f.is_new).map(|f| &f.path))
    {
        let rowids = tx
            .prepare_cached("SELECT rowid FROM symbols WHERE file=?1 AND is_def=1")
            .map_err(db_error)?
            .query_map([path], |r| r.get::<_, i64>(0))
            .map_err(db_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        for rowid in rowids {
            tx.prepare_cached("DELETE FROM symbol_fts WHERE rowid=?1")
                .map_err(db_error)?
                .execute([rowid])
                .map_err(db_error)?;
        }
        tx.prepare_cached("DELETE FROM symbols WHERE file=?1")
            .map_err(db_error)?
            .execute([path])
            .map_err(db_error)?;
        let rowid: Option<i64> = tx
            .query_row("SELECT rowid FROM files WHERE path=?1", [path], |r| {
                r.get(0)
            })
            .optional()
            .map_err(db_error)?;
        if let Some(rowid) = rowid {
            tx.prepare_cached("DELETE FROM file_fts WHERE rowid=?1")
                .map_err(db_error)?
                .execute([rowid])
                .map_err(db_error)?;
        }
        tx.prepare_cached("DELETE FROM files WHERE path=?1")
            .map_err(db_error)?
            .execute([path])
            .map_err(db_error)?;
    }
    let now = crate::now_ms();
    for file in files {
        tx.prepare_cached(
            "INSERT INTO files(path,lang,size,mtime_ns,hash,indexed_ms) VALUES(?1,?2,?3,?4,?5,?6)",
        )
        .map_err(db_error)?
        .execute(params![
            file.path,
            file.lang,
            file.size as i64,
            file.mtime_ns,
            file.hash,
            now
        ])
        .map_err(db_error)?;
        let rowid = tx.last_insert_rowid();
        tx.prepare_cached("INSERT INTO file_fts(rowid,path) VALUES(?1,?2)")
            .map_err(db_error)?
            .execute(params![rowid, file.path])
            .map_err(db_error)?;
        for symbol in file.symbols {
            tx.prepare_cached("INSERT INTO symbols(file,name,kind,line,end_line,is_def,signature,doc) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)").map_err(db_error)?
                .execute(params![file.path,symbol.name,symbol.kind,symbol.line,symbol.end_line,symbol.is_def,symbol.signature,symbol.doc]).map_err(db_error)?;
            if symbol.is_def {
                tx.prepare_cached("INSERT INTO symbol_fts(rowid,name,file) VALUES(?1,?2,?3)")
                    .map_err(db_error)?
                    .execute(params![tx.last_insert_rowid(), symbol.name, file.path])
                    .map_err(db_error)?;
            }
        }
    }
    tx.commit().map_err(db_error)
}

fn metadata(
    conn: &mut Connection,
    manifests: Vec<(String, String)>,
    scripts: Vec<(String, String, String)>,
    services: Vec<(String, String)>,
) -> Result<()> {
    let tx = conn.transaction().map_err(db_error)?;
    tx.execute_batch("DELETE FROM manifests; DELETE FROM scripts; DELETE FROM services;")
        .map_err(db_error)?;
    for (path, json) in manifests {
        tx.execute("INSERT INTO manifests VALUES(?1,?2)", params![path, json])
            .map_err(db_error)?;
    }
    for (name, command, source) in scripts {
        tx.execute(
            "INSERT INTO scripts VALUES(?1,?2,?3)",
            params![name, command, source],
        )
        .map_err(db_error)?;
    }
    for (name, json) in services {
        tx.execute("INSERT INTO services VALUES(?1,?2)", params![name, json])
            .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)
}

pub fn send_apply(
    sender: &Sender<Command>,
    files: Vec<FileRow>,
    removed: Vec<String>,
) -> Result<()> {
    let (tx, rx) = mpsc::channel();
    sender
        .send(Command::Apply {
            files,
            removed,
            reply: tx,
        })
        .map_err(|_| Error::Closed)?;
    rx.recv().map_err(|_| Error::Closed)?
}

pub fn send_metadata(
    sender: &Sender<Command>,
    manifests: Vec<(String, String)>,
    scripts: Vec<(String, String, String)>,
    services: Vec<(String, String)>,
) -> Result<()> {
    let (tx, rx) = mpsc::channel();
    sender
        .send(Command::Metadata {
            manifests,
            scripts,
            services,
            reply: tx,
        })
        .map_err(|_| Error::Closed)?;
    rx.recv().map_err(|_| Error::Closed)?
}

fn clear(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction().map_err(db_error)?;
    tx.execute_batch(
        "DELETE FROM files; DELETE FROM symbols; DELETE FROM manifests; DELETE FROM scripts;
         DELETE FROM services; DELETE FROM popular; DELETE FROM file_fts; DELETE FROM symbol_fts;",
    )
    .map_err(db_error)?;
    tx.commit().map_err(db_error)
}

pub fn send_clear(sender: &Sender<Command>) -> Result<()> {
    let (tx, rx) = mpsc::channel();
    sender
        .send(Command::Clear { reply: tx })
        .map_err(|_| Error::Closed)?;
    rx.recv().map_err(|_| Error::Closed)?
}

pub fn send_touch(sender: &Sender<Command>, files: Vec<Touched>) -> Result<()> {
    let (tx, rx) = mpsc::channel();
    sender
        .send(Command::Touch { files, reply: tx })
        .map_err(|_| Error::Closed)?;
    rx.recv().map_err(|_| Error::Closed)?
}

pub fn send_popular(sender: &Sender<Command>) -> Result<()> {
    let (tx, rx) = mpsc::channel();
    sender
        .send(Command::Popular { reply: tx })
        .map_err(|_| Error::Closed)?;
    rx.recv().map_err(|_| Error::Closed)?
}
