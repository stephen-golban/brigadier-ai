//! The single writer thread and the handle the async side talks to it through.
//!
//! One `rusqlite::Connection` lives on one dedicated `std::thread`. Everything — writes *and*
//! reads — crosses an unbounded channel as an [`Op`] and is applied on that thread, in order.
//!
//! Why one connection for reads too, when WAL explicitly allows concurrent readers: a second
//! connection buys nothing here (the UI reads a few hundred rows on demand, not a query load)
//! and costs a second thing to reason about — reader/writer visibility, a long-running reader
//! that stalls a checkpoint, and a second pool to close on shutdown. One connection makes
//! "an op sent before `flush` is visible after it" a property of the channel, not of SQLite.
// see docs/research/persistence.md §3: in WAL "there can only be one writer at a time", and a
// long-running reader can prevent a checkpoint from completing.

use std::collections::BTreeSet;
use std::sync::mpsc;
use std::time::{Instant, SystemTime};

use brigadier_core::approval::PendingApproval;
use brigadier_core::event::{bounded, ExitReason, RequestId, SessionId, Usage};
use brigadier_core::session::Decision;
use rusqlite::{named_params, Connection};
use tokio::sync::oneshot;

use crate::schema::{
    self, ApprovalRecord, FeedRow, ProjectRow, SessionRecord, SessionRow, SessionStatus,
    PROJECT_COLUMNS, SESSION_COLUMNS, SUMMARY_JSON_LIMIT,
};
use crate::{Error, Result, StoreConfig};

/// Free pages that must pile up before an idle reclaim is worth its writes (~1 MiB at 4 KiB).
const RECLAIM_THRESHOLD_PAGES: i64 = 256;

/// Pages one idle reclaim moves, so a huge freelist is drained over several batches.
const RECLAIM_PAGES_PER_BATCH: usize = 2048;

/// One unit of work for the writer thread. Crate-private: the public surface is [`StoreHandle`].
pub(crate) enum Op {
    /// Insert or replace a project.
    UpsertProject(ProjectRow),
    /// Merge a partial session row; `None` fields leave the stored value alone.
    UpsertSession(Box<SessionRow>),
    /// Append one terse feed row and advance the session's event cursor.
    Feed { session_id: SessionId, seq: u64, at: SystemTime, line: String },
    /// Overwrite the session's cumulative usage and cost.
    ///
    /// Overwrite, not `SET x = x + ?`: the provider reports `usage` and `total_cost_usd`
    /// cumulatively on every terminal frame, so summing them double-counts.
    // see docs/research/agent-sdk.md §6 and `brigadier_core::event::Usage`. The `x = x + ?`
    // shape of docs/research/persistence.md §3 still binds any counter that is *ours*; none is.
    SetUsage { session_id: SessionId, usage: Usage, cost_usd_cumulative: f64 },
    /// Record a parked request so a reload can re-render it.
    ApprovalOpened { session_id: SessionId, approval: Box<PendingApproval> },
    /// Record the answer that unparked it.
    ApprovalResolved { request_id: RequestId, decision: Decision, at: SystemTime },
    /// Settle a session's lifecycle columns.
    SessionEnded {
        session_id: SessionId,
        reason: ExitReason,
        exit_code: Option<i32>,
        at: SystemTime,
    },
    /// Run a closure against the connection, inside the current batch's transaction.
    ///
    /// Like [`Op::Flush`] it closes the coalescing window: a read submitted at the top of a
    /// window must not wait the whole `batch_window` for its answer, and everything queued
    /// before it is in the same transaction, so the closure still sees every prior write.
    Query(Box<dyn FnOnce(&Connection) + Send>),
    /// Commit everything queued before it, then reply.
    Flush(oneshot::Sender<()>),
    /// Checkpoint, reclaim free pages, and stop the thread.
    Shutdown,
}

/// The async side of the store. Cloning is a channel-sender clone; every clone writes to the
/// same connection.
#[derive(Clone, Debug)]
pub struct StoreHandle {
    tx: mpsc::Sender<Op>,
}

impl StoreHandle {
    fn send(&self, op: Op) -> Result<()> {
        self.tx.send(op).map_err(|_| Error::Closed)
    }

    /// Insert or replace a project.
    pub async fn upsert_project(&self, project: ProjectRow) -> Result<()> {
        self.send(Op::UpsertProject(project))
    }

    /// Merge a partial session row. `None` fields leave the stored value alone.
    pub async fn upsert_session(&self, row: SessionRow) -> Result<()> {
        self.send(Op::UpsertSession(Box::new(row)))
    }

    /// Append one terse feed row; the ring drops the oldest rows past the cap in the same
    /// transaction that inserts.
    pub async fn feed(&self, session_id: SessionId, seq: u64, at: SystemTime, line: String)
        -> Result<()>
    {
        self.send(Op::Feed { session_id, seq, at, line })
    }

    /// Overwrite a session's cumulative usage and cost.
    pub async fn set_usage(
        &self,
        session_id: SessionId,
        usage: Usage,
        cost_usd_cumulative: f64,
    ) -> Result<()> {
        self.send(Op::SetUsage { session_id, usage, cost_usd_cumulative })
    }

    /// Record a parked request, stamped with the current launch's `run_id`.
    pub async fn approval_opened(
        &self,
        session_id: SessionId,
        approval: PendingApproval,
    ) -> Result<()> {
        self.send(Op::ApprovalOpened { session_id, approval: Box::new(approval) })
    }

    /// Record the answer that unparked a request.
    pub async fn approval_resolved(
        &self,
        request_id: RequestId,
        decision: Decision,
        at: SystemTime,
    ) -> Result<()> {
        self.send(Op::ApprovalResolved { request_id, decision, at })
    }

    /// Settle a session's lifecycle columns.
    pub async fn session_ended(
        &self,
        session_id: SessionId,
        reason: ExitReason,
        exit_code: Option<i32>,
        at: SystemTime,
    ) -> Result<()> {
        self.send(Op::SessionEnded { session_id, reason, exit_code, at })
    }

    /// Commit everything sent before this call and wait for the commit.
    pub async fn flush(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.send(Op::Flush(tx))?;
        rx.await.map_err(|_| Error::Closed)
    }

    /// Run `f` on the writer thread, inside the transaction that carries the ops queued before it.
    async fn query<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T> + Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        self.send(Op::Query(Box::new(move |conn| {
            let _ = tx.send(f(conn));
        })))?;
        rx.await.map_err(|_| Error::Closed)?
    }

    /// Every project, oldest first by creation time.
    pub async fn list_projects(&self) -> Result<Vec<ProjectRow>> {
        self.query(|conn| {
            let sql = format!(
                "SELECT {PROJECT_COLUMNS} FROM projects ORDER BY created_at ASC, id ASC"
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let rows = stmt.query_map([], schema::project_from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
    }

    /// One project by id.
    pub async fn project(&self, id: &str) -> Result<Option<ProjectRow>> {
        let id = id.to_owned();
        self.query(move |conn| {
            let sql = format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE id = ?1");
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut rows = stmt.query((id.as_str(),))?;
            match rows.next()? {
                Some(row) => Ok(Some(schema::project_from_row(row)?)),
                None => Ok(None),
            }
        })
        .await
    }

    /// Every session, newest first by start time.
    pub async fn list_sessions(&self) -> Result<Vec<SessionRecord>> {
        self.query(|conn| {
            let sql = format!(
                "SELECT {SESSION_COLUMNS} FROM sessions ORDER BY started_at DESC, id ASC"
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let rows = stmt.query_map([], schema::session_from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
    }

    /// One session by id.
    pub async fn session(&self, session_id: SessionId) -> Result<Option<SessionRecord>> {
        self.query(move |conn| {
            let sql = format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?1");
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut rows = stmt.query((session_id.as_str(),))?;
            match rows.next()? {
                Some(row) => Ok(Some(schema::session_from_row(row)?)),
                None => Ok(None),
            }
        })
        .await
    }

    /// The newest `n` feed rows for a session, oldest first.
    pub async fn feed_tail(&self, session_id: SessionId, n: usize) -> Result<Vec<FeedRow>> {
        self.query(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT session_id, seq, at, line FROM feed WHERE session_id = ?1
                 ORDER BY seq DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map((session_id.as_str(), n as i64), schema::feed_from_row)?;
            let mut out = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            out.reverse();
            Ok(out)
        })
        .await
    }

    /// Every approval with no answer recorded, oldest first.
    ///
    /// After a restart this is empty: [`crate::Store::open`] expires every surviving row.
    /// A row whose `run_id` differs from [`crate::Store::run_id`] belongs to a lost launch.
    pub async fn pending_approvals(&self) -> Result<Vec<ApprovalRecord>> {
        self.query(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT request_id, session_id, run_id, opened_at, kind_json, resolved_at,
                        decision_json
                 FROM approvals WHERE resolved_at IS NULL ORDER BY opened_at ASC, request_id ASC",
            )?;
            let rows = stmt.query_map([], schema::approval_from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
    }

    /// Every approval for one session, newest first, answered or not.
    pub async fn approvals(&self, session_id: SessionId) -> Result<Vec<ApprovalRecord>> {
        self.query(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT request_id, session_id, run_id, opened_at, kind_json, resolved_at,
                        decision_json
                 FROM approvals WHERE session_id = ?1 ORDER BY opened_at DESC, request_id ASC",
            )?;
            let rows = stmt.query_map((session_id.as_str(),), schema::approval_from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
    }

    /// Read an integer `PRAGMA` from the writer thread's connection.
    ///
    /// Pragma names cannot be bound as parameters, so `name` is restricted to lowercase ASCII
    /// and `_`; anything else is refused rather than interpolated.
    pub async fn pragma_i64(&self, name: &str) -> Result<i64> {
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
            return Err(Error::BadPragma(name.to_owned()));
        }
        let sql = format!("PRAGMA {name}");
        self.query(move |conn| Ok(conn.query_row(&sql, [], |row| row.get(0))?)).await
    }

    pub(crate) fn shutdown(&self) {
        let _ = self.tx.send(Op::Shutdown);
    }
}

/// Move `conn` onto its own thread and hand back the way to talk to it.
pub(crate) fn spawn(
    conn: Connection,
    run_id: String,
    config: StoreConfig,
) -> Result<(StoreHandle, std::thread::JoinHandle<()>)> {
    let (tx, rx) = mpsc::channel();
    let join = std::thread::Builder::new()
        .name("brigadier-store".to_owned())
        .spawn(move || run(conn, rx, run_id, config))?;
    Ok((StoreHandle { tx }, join))
}

/// Drain the channel forever, one transaction per `batch_window`.
///
/// The window is a deadline, not a poll: the thread blocks in `recv`/`recv_timeout` and
/// wakes only for an op or for the deadline. An op that someone is waiting on — a
/// [`Op::Query`], an [`Op::Flush`] or [`Op::Shutdown`] — ends the window immediately.
fn run(
    mut conn: Connection,
    rx: mpsc::Receiver<Op>,
    run_id: String,
    config: StoreConfig,
) {
    loop {
        let Ok(first) = rx.recv() else { break };
        let mut batch = vec![first];
        let deadline = Instant::now() + config.batch_window;
        // Coalesce. A `Query`, `Flush` or `Shutdown` closes the window early so the waiter is
        // not held for a window it did not ask for.
        while !matches!(batch.last(), Some(Op::Query(_) | Op::Flush(_) | Op::Shutdown)) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            // Timed blocking receive, not `try_recv` plus a sleep: an idle window costs one
            // wakeup at the deadline instead of one per millisecond. This is the whole reason
            // the channel is `std::sync::mpsc` rather than `tokio::sync::mpsc` — `recv_timeout`
            // exists, senders stay non-blocking and `Clone`, and no runtime is needed here.
            match rx.recv_timeout(left) {
                Ok(op) => batch.push(op),
                // The window expired, or every sender is gone; commit what we have either way.
                Err(_) => break,
            }
        }
        let stop = matches!(batch.last(), Some(Op::Shutdown));
        match apply_batch(&mut conn, batch, &run_id, &config) {
            // The ring's deletes leave free pages behind. Reclaim them between transactions,
            // in bounded slices, so the writer stays responsive.
            // see docs/research/persistence.md §3 — "PRAGMA incremental_vacuum(<N>) on idle
            // after a bulk delete", not VACUUM, which needs 2x the file in free disk space.
            Ok(deleted) if deleted > 0 => reclaim(&conn, Some(RECLAIM_PAGES_PER_BATCH)),
            Ok(_) => {}
            Err(e) => tracing::error!(error = %e, "store batch failed; its writes rolled back"),
        }
        if stop {
            break;
        }
    }
    // Best effort on the way out: reclaim everything, then fold the WAL back into the database.
    // The checkpoint is what removes the `-wal` sidecar and resizes the file on disk.
    reclaim(&conn, None);
    if let Err(e) = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);") {
        tracing::warn!(error = %e, "store checkpoint on shutdown failed");
    }
}

/// Free pages left by the ring's deletes, once there are enough of them to be worth the writes.
fn reclaim(conn: &Connection, budget: Option<usize>) {
    let outcome = schema::freelist_count(conn).and_then(|free| {
        if free < RECLAIM_THRESHOLD_PAGES && budget.is_some() {
            return Ok(0);
        }
        schema::incremental_vacuum(conn, budget)
    });
    match outcome {
        Ok(freed) if freed > 0 => tracing::debug!(freed, "reclaimed free pages"),
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "incremental vacuum failed"),
    }
}

/// Apply one coalesced batch as one transaction.
///
/// A statement that fails is logged and skipped rather than aborting the batch: one bad op —
/// a feed row for a session that was deleted, say — must not discard every other session's
/// writes from the same 250 ms window.
fn apply_batch(
    conn: &mut Connection,
    batch: Vec<Op>,
    run_id: &str,
    config: &StoreConfig,
) -> Result<usize> {
    let tx = conn.transaction()?;
    let mut touched: BTreeSet<String> = BTreeSet::new();
    let mut flushes: Vec<oneshot::Sender<()>> = Vec::new();
    let mut queries = 0usize;

    for op in batch {
        let outcome = match op {
            Op::Flush(reply) => {
                flushes.push(reply);
                Ok(())
            }
            Op::Shutdown => Ok(()),
            Op::Query(f) => {
                queries += 1;
                f(&tx);
                Ok(())
            }
            other => apply_one(&tx, other, run_id, &mut touched),
        };
        if let Err(e) = outcome {
            tracing::warn!(error = %e, "store op failed");
        }
    }

    let mut deleted = 0usize;
    for session_id in &touched {
        match trim_feed(&tx, session_id, config.feed_cap) {
            Ok(n) => deleted += n,
            Err(e) => tracing::warn!(error = %e, session_id, "feed ring trim failed"),
        }
    }
    tx.commit()?;
    tracing::trace!(queries, deleted, sessions = touched.len(), "store batch committed");
    for reply in flushes {
        let _ = reply.send(());
    }
    Ok(deleted)
}

fn apply_one(
    tx: &rusqlite::Transaction<'_>,
    op: Op,
    run_id: &str,
    touched: &mut BTreeSet<String>,
) -> Result<()> {
    match op {
        Op::UpsertProject(p) => {
            tx.prepare_cached(
                "INSERT INTO projects(id, name, root_path, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                     root_path = excluded.root_path",
            )?
            .execute((
                &p.id,
                &p.name,
                p.root_path.to_string_lossy().as_ref(),
                schema::to_millis(p.created_at),
            ))?;
        }
        Op::UpsertSession(row) => upsert_session(tx, *row)?,
        Op::Feed { session_id, seq, at, line } => {
            ensure_session(tx, &session_id, touched)?;
            tx.prepare_cached(
                "INSERT INTO feed(session_id, seq, at, line) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(session_id, seq) DO UPDATE SET at = excluded.at,
                     line = excluded.line",
            )?
            .execute((session_id.as_str(), seq, schema::to_millis(at), &line))?;
            // `last_event_seq` is the cursor of the newest event that produced a *feed row*;
            // events with no terse line are deliberately not written at all.
            // see docs/research/persistence.md §3 — never a write per chunk.
            tx.prepare_cached(
                "UPDATE sessions SET last_event_seq = MAX(last_event_seq, ?2) WHERE id = ?1",
            )?
            .execute((session_id.as_str(), seq))?;
        }
        Op::SetUsage { session_id, usage, cost_usd_cumulative } => {
            ensure_session(tx, &session_id, touched)?;
            tx.prepare_cached(
                "UPDATE sessions SET input_tokens = ?2, output_tokens = ?3,
                     cache_read_tokens = ?4, cache_creation_tokens = ?5,
                     context_window = COALESCE(?6, context_window), cost_usd_cumulative = ?7
                 WHERE id = ?1",
            )?
            .execute((
                session_id.as_str(),
                usage.input_tokens,
                usage.output_tokens,
                usage.cache_read_tokens,
                usage.cache_creation_tokens,
                usage.context_window,
                cost_usd_cumulative,
            ))?;
        }
        Op::ApprovalOpened { session_id, approval } => {
            ensure_session(tx, &session_id, touched)?;
            let params = schema::approval_params(&session_id, run_id, &approval);
            tx.prepare_cached(
                "INSERT INTO approvals(request_id, session_id, run_id, opened_at, kind_json)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(request_id) DO UPDATE SET kind_json = excluded.kind_json",
            )?
            .execute(params)?;
        }
        Op::ApprovalResolved { request_id, decision, at } => {
            let json = serde_json::to_string(&decision)?;
            tx.prepare_cached(
                "UPDATE approvals SET resolved_at = ?2, decision_json = ?3
                 WHERE request_id = ?1 AND resolved_at IS NULL",
            )?
            .execute((request_id.as_str(), schema::to_millis(at), json))?;
        }
        Op::SessionEnded { session_id, reason, exit_code, at } => {
            ensure_session(tx, &session_id, touched)?;
            tx.prepare_cached(
                "UPDATE sessions SET status = ?2, ended_at = ?3, exit_code = ?4 WHERE id = ?1",
            )?
            .execute((
                session_id.as_str(),
                SessionStatus::from_exit(&reason).as_str(),
                schema::to_millis(at),
                exit_code,
            ))?;
        }
        // Handled by `apply_batch` before it delegates here; never reached, and a stray one is
        // logged rather than panicking a thread that owns the only connection.
        Op::Query(_) | Op::Flush(_) | Op::Shutdown => {
            tracing::error!("control op reached apply_one");
        }
    }
    Ok(())
}

/// A feed row or an approval for a session we have never seen creates a stub row, so the
/// foreign key holds and the row is not silently dropped.
fn ensure_session(
    tx: &rusqlite::Transaction<'_>,
    session_id: &SessionId,
    touched: &mut BTreeSet<String>,
) -> Result<()> {
    if touched.insert(session_id.to_string()) {
        tx.prepare_cached("INSERT OR IGNORE INTO sessions(id) VALUES (?1)")?
            .execute((session_id.as_str(),))?;
    }
    Ok(())
}

fn upsert_session(tx: &rusqlite::Transaction<'_>, row: SessionRow) -> Result<()> {
    let path = |p: Option<&std::path::PathBuf>| {
        p.map(|p| p.to_string_lossy().into_owned())
    };
    let summary = row.summary_json.as_deref().map(|s| bounded(s, SUMMARY_JSON_LIMIT));
    tx.prepare_cached(
        "INSERT INTO sessions (id, project_id, instance_id, driver_kind, provider_session_id,
             cwd, worktree_path, branch, model, status, transcript_path, resume_token,
             started_at, summary_json)
         VALUES (:id, :project_id, :instance_id, :driver_kind, :provider_session_id, :cwd,
             :worktree_path, :branch, :model, COALESCE(:status, 'starting'), :transcript_path,
             :resume_token, :started_at, :summary_json)
         ON CONFLICT(id) DO UPDATE SET
             project_id          = COALESCE(:project_id, sessions.project_id),
             instance_id         = COALESCE(:instance_id, sessions.instance_id),
             driver_kind         = COALESCE(:driver_kind, sessions.driver_kind),
             provider_session_id = COALESCE(:provider_session_id, sessions.provider_session_id),
             cwd                 = COALESCE(:cwd, sessions.cwd),
             worktree_path       = COALESCE(:worktree_path, sessions.worktree_path),
             branch              = COALESCE(:branch, sessions.branch),
             model               = COALESCE(:model, sessions.model),
             status              = COALESCE(:status, sessions.status),
             transcript_path     = COALESCE(:transcript_path, sessions.transcript_path),
             resume_token        = COALESCE(:resume_token, sessions.resume_token),
             started_at          = COALESCE(:started_at, sessions.started_at),
             summary_json        = COALESCE(:summary_json, sessions.summary_json)",
    )?
    .execute(named_params! {
        ":id": row.session_id.as_str(),
        ":project_id": row.project_id,
        ":instance_id": row.instance_id.as_ref().map(|i| i.as_str()),
        ":driver_kind": row.driver_kind.as_ref().map(|d| d.as_str()),
        ":provider_session_id": row.provider_session_id,
        ":cwd": path(row.cwd.as_ref()),
        ":worktree_path": path(row.worktree_path.as_ref()),
        ":branch": row.branch,
        ":model": row.model,
        ":status": row.status.map(SessionStatus::as_str),
        ":transcript_path": path(row.transcript_path.as_ref()),
        ":resume_token": row.resume_token,
        ":started_at": row.started_at.map(schema::to_millis),
        ":summary_json": summary,
    })?;
    Ok(())
}

/// Drop everything older than the newest `cap` rows for one session.
// see docs/research/persistence.md §3 — the feed is capped, not archival: "keep the last N terse
// rows per session (N ~ 500), delete older rows in the same transaction that inserts".
fn trim_feed(tx: &rusqlite::Transaction<'_>, session_id: &str, cap: usize) -> Result<usize> {
    Ok(tx
        .prepare_cached(
            "DELETE FROM feed WHERE session_id = ?1 AND seq <= (
                 SELECT seq FROM feed WHERE session_id = ?1 ORDER BY seq DESC LIMIT 1 OFFSET ?2)",
        )?
        .execute((session_id, i64::try_from(cap).unwrap_or(i64::MAX)))?)
}
