//! Tables, pragmas, the migration ladder, and the plain-value rows that cross the API.
//!
//! Nothing here is append-only and archival.
// see docs/research/persistence.md §3 — the t3code failure to design against is an unbounded
// `orchestration_events` table: 282 KB → 218 MB in 25 h. Per session we keep exactly one
// upserted row; the feed is a capped ring; usage is overwritten, never accumulated per event.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use brigadier_core::approval::PendingApproval;
use brigadier_core::driver::DriverKind;
use brigadier_core::event::{
    bounded, ExitReason, InstanceId, RequestId, RequestKind, SessionId, Usage,
    INPUT_EXCERPT_LIMIT,
};
use brigadier_core::session::Decision;
use rusqlite::{Connection, Row};

use crate::{Error, Result};

/// Deny reason stamped on every approval that was still pending when the app restarted.
// see docs/research/persistence.md §6 — after a restart nothing is listening on the in-memory
// one-shot, so a surviving pending row is expired by definition.
pub const EXPIRED_REASON: &str = "expired: app restarted";

/// `meta` key holding the UUID minted once per app launch.
pub const RUN_ID_KEY: &str = "run_id";

/// Bytes of `approvals.kind_json` kept; a `Write` approval carries a whole file body.
// see docs/research/persistence.md §6 — truncate at ~8 KB, the full copy lives in the NDJSON log.
pub const KIND_JSON_LIMIT: usize = INPUT_EXCERPT_LIMIT;

/// Bytes of `sessions.summary_json` kept.
pub const SUMMARY_JSON_LIMIT: usize = 4 * 1024;

/// WAL byte cap re-applied at every open.
// see docs/research/persistence.md §3 — a checkpoint restarts the WAL rather than shrinking it,
// so without `journal_size_limit` a stalled checkpoint leaves a WAL that never comes back down.
pub const JOURNAL_SIZE_LIMIT: i64 = 64 * 1024 * 1024;

/// The migration ladder. `user_version` equals the number of entries already applied.
///
/// Migration 0 sets `auto_vacuum=INCREMENTAL` **before the first `CREATE TABLE`**, and
/// [`open_connection`] deliberately runs the ladder before switching the file to WAL.
// see docs/research/persistence.md §3, quoting sqlite.org/pragma.html: "auto-vacuuming must be
// turned on before any tables are created. It is not possible to enable or disable auto-vacuum
// after a table has been created." The usual escape hatch — set the pragma then VACUUM — is
// documented as working only "when *not* in write-ahead log mode", so under WAL this choice is
// permanent. Retrofitting it later would cost a journal-mode round trip on a live database.
pub(crate) const MIGRATIONS: &[&str] = &[
    r#"
PRAGMA auto_vacuum = INCREMENTAL;

CREATE TABLE projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    root_path  TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
    id                    TEXT PRIMARY KEY,
    project_id            TEXT REFERENCES projects(id) ON DELETE CASCADE,
    instance_id           TEXT,
    driver_kind           TEXT,
    provider_session_id   TEXT,
    cwd                   TEXT,
    worktree_path         TEXT,
    branch                TEXT,
    model                 TEXT,
    status                TEXT    NOT NULL DEFAULT 'starting',
    transcript_path       TEXT,
    resume_token          TEXT,
    started_at            INTEGER,
    ended_at              INTEGER,
    exit_code             INTEGER,
    last_event_seq        INTEGER NOT NULL DEFAULT 0,
    cost_usd_cumulative   REAL    NOT NULL DEFAULT 0,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    context_window        INTEGER,
    summary_json          TEXT
);

CREATE TABLE feed (
    session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    at         INTEGER NOT NULL,
    line       TEXT    NOT NULL,
    PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE TABLE approvals (
    request_id    TEXT PRIMARY KEY,
    session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    run_id        TEXT    NOT NULL,
    opened_at     INTEGER NOT NULL,
    kind_json     TEXT    NOT NULL,
    resolved_at   INTEGER,
    decision_json TEXT
);

CREATE INDEX approvals_open ON approvals(session_id) WHERE resolved_at IS NULL;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"#,
];

/// Where a session is in its life.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SessionStatus {
    /// Spawned, no `SessionStarted` seen yet.
    #[default]
    Starting,
    /// The provider accepted the session.
    Running,
    /// The session ended and the child left cleanly.
    Exited,
    /// The session ended badly: killed, crashed, or a fatal adapter error.
    Failed,
}

impl SessionStatus {
    /// The lowercase slug stored in `sessions.status`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Failed => "failed",
        }
    }

    /// Parse a slug; an unknown value reads back as [`SessionStatus::Starting`].
    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "exited" => Self::Exited,
            "failed" => Self::Failed,
            _ => Self::Starting,
        }
    }

    /// The status an [`ExitReason`] settles a session into.
    pub fn from_exit(reason: &ExitReason) -> Self {
        match reason {
            ExitReason::Graceful => Self::Exited,
            _ => Self::Failed,
        }
    }
}

/// A project the operator has opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectRow {
    /// Stable project id, chosen by the caller.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Repository root.
    pub root_path: PathBuf,
    /// First time we saw it.
    pub created_at: SystemTime,
}

/// A partial update to the one row a session owns. Every field is optional and `None` means
/// "leave whatever is already stored", so an adapter may upsert what it learned without
/// clobbering what the supervisor recorded at spawn time.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionRow {
    /// Which session. The only required field.
    pub session_id: SessionId,
    /// Owning project, when the session belongs to one.
    pub project_id: Option<String>,
    /// Which provider instance drives it.
    pub instance_id: Option<InstanceId>,
    /// Which driver kind that instance is.
    pub driver_kind: Option<DriverKind>,
    /// The provider's own session id.
    pub provider_session_id: Option<String>,
    /// Working directory handed to the child.
    pub cwd: Option<PathBuf>,
    /// Worktree the session runs in, when it is not the repository root.
    pub worktree_path: Option<PathBuf>,
    /// Branch checked out in that worktree.
    pub branch: Option<String>,
    /// Model slug in effect.
    pub model: Option<String>,
    /// Lifecycle state.
    pub status: Option<SessionStatus>,
    /// Pointer to the provider's own transcript; a cache that may be swept away.
    // see docs/research/persistence.md §1 — Claude Code deletes it after `cleanupPeriodDays`.
    pub transcript_path: Option<PathBuf>,
    /// Token to hand back to `resume_session`.
    pub resume_token: Option<String>,
    /// When the session was started.
    pub started_at: Option<SystemTime>,
    /// Bounded derived summary, as JSON text. Truncated to [`SUMMARY_JSON_LIMIT`] on write.
    pub summary_json: Option<String>,
}

impl SessionRow {
    /// An update that touches nothing but names the session.
    pub fn new(session_id: SessionId) -> Self {
        Self {
            session_id,
            project_id: None,
            instance_id: None,
            driver_kind: None,
            provider_session_id: None,
            cwd: None,
            worktree_path: None,
            branch: None,
            model: None,
            status: None,
            transcript_path: None,
            resume_token: None,
            started_at: None,
            summary_json: None,
        }
    }
}

/// One session as stored, read back whole.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionRecord {
    /// Which session.
    pub session_id: SessionId,
    /// Owning project, when it has one.
    pub project_id: Option<String>,
    /// Which provider instance drives it.
    pub instance_id: Option<InstanceId>,
    /// Which driver kind that instance is.
    pub driver_kind: Option<DriverKind>,
    /// The provider's own session id.
    pub provider_session_id: Option<String>,
    /// Working directory handed to the child.
    pub cwd: Option<PathBuf>,
    /// Worktree the session runs in.
    pub worktree_path: Option<PathBuf>,
    /// Branch checked out in that worktree.
    pub branch: Option<String>,
    /// Model slug in effect.
    pub model: Option<String>,
    /// Lifecycle state.
    pub status: SessionStatus,
    /// Pointer to the provider's own transcript.
    pub transcript_path: Option<PathBuf>,
    /// Token to hand back to `resume_session`.
    pub resume_token: Option<String>,
    /// When the session started.
    pub started_at: Option<SystemTime>,
    /// When it ended.
    pub ended_at: Option<SystemTime>,
    /// Child exit code, when one was observed.
    pub exit_code: Option<i32>,
    /// Envelope sequence number of the newest event that produced a feed row.
    pub last_event_seq: u64,
    /// Cumulative token accounting, as of the provider's latest terminal frame.
    pub usage: Usage,
    /// Cumulative cost in USD, read from the latest result and never summed.
    pub cost_usd_cumulative: f64,
    /// Bounded derived summary, as JSON text.
    pub summary_json: Option<String>,
}

/// One terse row of the capped UI feed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedRow {
    /// Which session.
    pub session_id: SessionId,
    /// Envelope sequence number the row came from.
    pub seq: u64,
    /// Host wall clock at emission.
    pub at: SystemTime,
    /// The one-line, bounded human-readable text.
    pub line: String,
}

/// One approval as stored: enough to *render* the prompt, nothing needed to *answer* it.
// see docs/research/persistence.md §6 — the answer path is the in-memory one-shot or it does
// not exist; persistence is for redraw after a webview reload.
#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalRecord {
    /// The parked request.
    pub request_id: RequestId,
    /// The session it blocks.
    pub session_id: SessionId,
    /// App launch that opened it. Equal to [`crate::Store::run_id`] means resumable.
    pub run_id: String,
    /// When it was parked.
    pub opened_at: SystemTime,
    /// What is being asked, as JSON text bounded by [`KIND_JSON_LIMIT`].
    pub kind_json: String,
    /// When it was answered, expired, or cancelled.
    pub resolved_at: Option<SystemTime>,
    /// The answer, as JSON text.
    pub decision_json: Option<String>,
}

impl ApprovalRecord {
    /// Decode [`ApprovalRecord::kind_json`], which fails when the value was replaced by the
    /// oversized placeholder the writer substitutes past [`KIND_JSON_LIMIT`].
    pub fn kind(&self) -> Option<RequestKind> {
        serde_json::from_str(&self.kind_json).ok()
    }
}

/// Milliseconds since the Unix epoch, saturating rather than failing.
pub(crate) fn to_millis(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// Inverse of [`to_millis`].
pub(crate) fn from_millis(ms: i64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(u64::try_from(ms).unwrap_or(0))
}

/// Serialise a request kind, bounded. An oversized value is replaced by a placeholder that says
/// how big it was, so the UI can render "truncated" instead of failing to parse.
pub(crate) fn kind_json(kind: &RequestKind) -> String {
    let full = serde_json::to_string(kind).unwrap_or_else(|_| "null".to_owned());
    if full.len() <= KIND_JSON_LIMIT {
        return full;
    }
    let head = bounded(&full, KIND_JSON_LIMIT / 2);
    serde_json::json!({ "type": "oversized", "bytes": full.len(), "head": head }).to_string()
}

fn path_of(row: &Row<'_>, idx: &str) -> rusqlite::Result<Option<PathBuf>> {
    Ok(row.get::<_, Option<String>>(idx)?.map(PathBuf::from))
}

/// Column list shared by every `sessions` read.
pub(crate) const SESSION_COLUMNS: &str = "id, project_id, instance_id, driver_kind, \
     provider_session_id, cwd, worktree_path, branch, model, status, transcript_path, \
     resume_token, started_at, ended_at, exit_code, last_event_seq, cost_usd_cumulative, \
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, context_window, \
     summary_json";

pub(crate) fn session_from_row(row: &Row<'_>) -> rusqlite::Result<SessionRecord> {
    Ok(SessionRecord {
        session_id: SessionId::new(row.get::<_, String>("id")?),
        project_id: row.get("project_id")?,
        instance_id: row.get::<_, Option<String>>("instance_id")?.map(InstanceId::new),
        driver_kind: row.get::<_, Option<String>>("driver_kind")?.map(DriverKind::new),
        provider_session_id: row.get("provider_session_id")?,
        cwd: path_of(row, "cwd")?,
        worktree_path: path_of(row, "worktree_path")?,
        branch: row.get("branch")?,
        model: row.get("model")?,
        status: SessionStatus::from_str_lossy(&row.get::<_, String>("status")?),
        transcript_path: path_of(row, "transcript_path")?,
        resume_token: row.get("resume_token")?,
        started_at: row.get::<_, Option<i64>>("started_at")?.map(from_millis),
        ended_at: row.get::<_, Option<i64>>("ended_at")?.map(from_millis),
        exit_code: row.get("exit_code")?,
        last_event_seq: row.get("last_event_seq")?,
        usage: Usage {
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            cache_read_tokens: row.get("cache_read_tokens")?,
            cache_creation_tokens: row.get("cache_creation_tokens")?,
            context_window: row.get("context_window")?,
        },
        cost_usd_cumulative: row.get("cost_usd_cumulative")?,
        summary_json: row.get("summary_json")?,
    })
}

pub(crate) fn feed_from_row(row: &Row<'_>) -> rusqlite::Result<FeedRow> {
    Ok(FeedRow {
        session_id: SessionId::new(row.get::<_, String>("session_id")?),
        seq: row.get("seq")?,
        at: from_millis(row.get("at")?),
        line: row.get("line")?,
    })
}

pub(crate) fn approval_from_row(row: &Row<'_>) -> rusqlite::Result<ApprovalRecord> {
    Ok(ApprovalRecord {
        request_id: RequestId::new(row.get::<_, String>("request_id")?),
        session_id: SessionId::new(row.get::<_, String>("session_id")?),
        run_id: row.get("run_id")?,
        opened_at: from_millis(row.get("opened_at")?),
        kind_json: row.get("kind_json")?,
        resolved_at: row.get::<_, Option<i64>>("resolved_at")?.map(from_millis),
        decision_json: row.get("decision_json")?,
    })
}

/// Open `path`, apply the migration ladder, then set the runtime pragmas.
///
/// Order is load-bearing: the ladder runs while a brand-new file is still in the default
/// rollback-journal mode, because migration 0 sets `auto_vacuum` and WAL makes that unchangeable.
// see docs/research/persistence.md §3 for every pragma below.
pub(crate) fn open_connection(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    // `busy_timeout=5000` matches sqlx's default and covers the checkpoint window; foreign keys
    // are what makes "delete a session" purge its children, the bug t3code shipped as #5110.
    conn.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;")?;
    migrate(&conn)?;
    // `synchronous=NORMAL` under WAL is corruption-safe and loses at most the last commits after
    // a power cut — invisible for UI-reload state, and the whole point of the 250 ms batch.
    conn.execute_batch(&format!(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; \
         PRAGMA journal_size_limit = {JOURNAL_SIZE_LIMIT};"
    ))?;
    Ok(conn)
}

/// Apply every migration the file has not seen, one transaction each.
fn migrate(conn: &Connection) -> Result<()> {
    let applied: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let applied = usize::try_from(applied).unwrap_or(0);
    if applied > MIGRATIONS.len() {
        return Err(Error::Newer { found: applied, known: MIGRATIONS.len() });
    }
    for (n, sql) in MIGRATIONS.iter().enumerate().skip(applied) {
        // `PRAGMA auto_vacuum` must not be wrapped in an explicit transaction; migration 0 opens
        // with it, so each migration is run as its own batch and the version bump seals it.
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", n as i64 + 1)?;
    }
    Ok(())
}

/// Read `meta.run_id`, minting and storing a fresh UUID when the key is absent or `fresh`.
pub(crate) fn set_run_id(conn: &Connection, run_id: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (RUN_ID_KEY, run_id),
    )?;
    Ok(())
}

/// Pages currently on the freelist.
pub(crate) fn freelist_count(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA freelist_count", [], |r| r.get(0))?)
}

/// Return freed pages to the operating system, at most `max_pages` of them.
///
/// `PRAGMA incremental_vacuum` frees **one page per `sqlite3_step`** and reports each freed page
/// as a row, so it has to be drained like a query. `execute_batch` steps it exactly once and
/// silently reclaims a single page — measured on this machine 2026-09-02: a 2,363-page freelist
/// went to 2,362 through `execute_batch` and to 0 through the drain below.
// see docs/research/persistence.md §3 — "PRAGMA incremental_vacuum causes up to N pages to be
// removed from the freelist. The database file is truncated by the same amount." This is the
// shrink path that avoids VACUUM's 2x disk spike and its refusal to run mid-transaction.
pub(crate) fn incremental_vacuum(conn: &Connection, max_pages: Option<usize>) -> Result<usize> {
    let sql = match max_pages {
        Some(n) => format!("PRAGMA incremental_vacuum({n})"),
        None => "PRAGMA incremental_vacuum".to_owned(),
    };
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    let mut freed = 0;
    while rows.next()?.is_some() {
        freed += 1;
    }
    Ok(freed)
}

/// Expire every approval still open, unconditionally, and report how many.
///
/// Unconditional by design: a row that survived process exit has no listener, whatever launch
/// opened it. The stored `run_id` stays put so the UI can say *which* launch was lost.
// see docs/research/persistence.md §6.
pub(crate) fn expire_pending_approvals(conn: &Connection, now: SystemTime) -> Result<usize> {
    let decision = serde_json::to_string(&Decision::deny(EXPIRED_REASON))?;
    let n = conn.execute(
        "UPDATE approvals SET resolved_at = ?1, decision_json = ?2 WHERE resolved_at IS NULL",
        (to_millis(now), decision),
    )?;
    Ok(n)
}

/// The `PendingApproval` shape the writer stores, kept next to the table it feeds.
pub(crate) fn approval_params(
    session_id: &SessionId,
    run_id: &str,
    approval: &PendingApproval,
) -> (String, String, String, i64, String) {
    (
        approval.request_id.to_string(),
        session_id.to_string(),
        run_id.to_owned(),
        to_millis(approval.opened_at),
        kind_json(&approval.kind),
    )
}
