//! Removing a session, and removing a project with everything under it.
//!
//! Two statements do almost all of the work — `DELETE FROM sessions WHERE id = ?` and
//! `DELETE FROM projects WHERE id = ?` — because the schema already says what depends on what.
//! Everything else here exists to make the answer *checkable*: SQLite reports `changes()` for the
//! rows a statement deleted itself and **says nothing at all about the rows a foreign key
//! cascaded**, so a delete that reported only `changes()` would answer `1` for a session whose
//! nine thousand feed rows went with it, and `1` again for a session whose feed rows stayed
//! because someone dropped an `ON DELETE CASCADE`.
//!
//! So each delete resolves the ids it is about to destroy, counts every dependant of those ids,
//! runs the statement, and asks **the same question again**. The before-counts are what it
//! reports; a non-zero after-count is an [`Error::DeleteIncomplete`], raised inside the caller's
//! transaction so the whole delete rolls back rather than leaving orphans and calling it success.
//!
//! Asking by *id* rather than by "everything belonging to this project" is the load-bearing part
//! of that. A check phrased as `WHERE session_id IN (SELECT id FROM sessions WHERE project_id =
//! ?)` answers zero after the delete whether the feed rows went or not, because the sub-select is
//! empty either way — a check that cannot fail.
//!
//! ## The cascade map this file relies on
//!
//! Read off `schema.rs`, and `PRAGMA foreign_keys = ON` is set on the one connection in
//! `crate::schema::open_connection`:
//!
//! ```text
//! projects ─CASCADE→ sessions ─CASCADE→ feed
//!          │                  ├CASCADE→ approvals
//!          │                  ├CASCADE→ intents (by session_id)
//!          │                  └SET NULL→ work_orders.session_id
//!          ├CASCADE→ intents (by project_id)
//!          └CASCADE→ plans ─CASCADE→ phases ─CASCADE→ work_orders
//!                          ├CASCADE→ plan_revisions
//!                          └CASCADE→ unknowns
//! ```
//!
//! **`work_orders.session_id` is `ON DELETE SET NULL` on purpose and is not to be "fixed".** The
//! plan is the durable thing (`docs/vision.md` §8: the work is in the repository, only the
//! narration goes) and it has to outlive the session that ran it, so deleting a session leaves
//! its work order standing with a null `session_id`. [`Deleted::work_orders_orphaned`] counts
//! those separately from [`Deleted::work_orders`], which counts the ones that were genuinely
//! deleted — through their phase, from the project end.
//!
//! Nothing outside the database cascades: the raw NDJSON log, the pid file, the git worktree and
//! the gate logs are all files, and removing them is the supervisor's half of the job.
// see docs/vision.md §8, docs/research/persistence.md §3 (t3code #5110 — "deleting threads did
// not purge events" was a missing foreign key), and the migration 4 comment in `schema.rs`.

use rusqlite::Connection;
use serde::Serialize;

use crate::{Error, Result};

/// Rows one delete removed, by table.
///
/// Every field is a count of rows that matched **before** the delete, so the numbers describe
/// what went rather than what the statement happened to report. A delete that leaves any of them
/// behind is an error, not a smaller number.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Deleted {
    /// `projects` rows: 1 for a project delete, 0 for a session delete.
    pub projects: u32,
    /// `sessions` rows.
    pub sessions: u32,
    /// `feed` rows across every deleted session.
    pub feed: u32,
    /// `approvals` rows across every deleted session.
    pub approvals: u32,
    /// `intents` rows, by `project_id` or by `session_id`.
    pub intents: u32,
    /// `plans` rows.
    pub plans: u32,
    /// `phases` rows.
    pub phases: u32,
    /// `plan_revisions` rows.
    pub plan_revisions: u32,
    /// `unknowns` rows.
    pub unknowns: u32,
    /// `work_orders` rows **deleted**, through their phase.
    pub work_orders: u32,
    /// `work_orders` rows **kept**, with `session_id` set to null.
    ///
    /// The deliberate exception in the cascade map: the plan outlives the session that ran it.
    /// For a session delete this is every work order that named it; for a project delete it is
    /// only orders belonging to *another* project's phases, which is normally zero.
    pub work_orders_orphaned: u32,
}

/// Ids a delete took with it, for the caller that has files keyed on them.
///
/// Resolved inside the deleting transaction, before the statement runs: afterwards the rows are
/// gone and there is nothing left to ask.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeletedIds {
    /// Sessions that were deleted. Their raw logs and pid files are the caller's to remove.
    pub sessions: Vec<String>,
    /// Plans that were deleted.
    pub plans: Vec<String>,
    /// Phases that were deleted. Their gate logs are the caller's to remove.
    pub phases: Vec<String>,
}

/// What one delete did: the counts, and the ids whose files the caller still has to remove.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeleteOutcome {
    /// Rows removed, by table.
    pub rows: Deleted,
    /// Ids that went, resolved before the statement ran.
    pub ids: DeletedIds,
}

/// One table's dependency on a set of ids: what to call it, how to count it, and for which ids.
///
/// The same value is used before the delete and after it, which is the whole point — the
/// after-check is not a differently-worded approximation of the before-count, it is the identical
/// query.
struct Scope<'a> {
    label: &'a str,
    /// A `SELECT COUNT(*) … WHERE <column> = ?1` over one id.
    sql: &'a str,
    ids: &'a [String],
}

/// Sum one scope's count across its ids. An empty id list is zero without touching the database.
fn count(conn: &Connection, scope: &Scope<'_>) -> Result<u32> {
    if scope.ids.is_empty() {
        return Ok(0);
    }
    let mut stmt = conn.prepare(scope.sql)?;
    let mut total: i64 = 0;
    for id in scope.ids {
        total += stmt.query_row((id.as_str(),), |row| row.get::<_, i64>(0))?;
    }
    Ok(u32::try_from(total).unwrap_or(u32::MAX))
}

/// One `SELECT <id column> …`, as a `Vec`.
fn ids(conn: &Connection, sql: &str, id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map((id,), |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Fold every scope's count into `out`, by label.
fn tally(conn: &Connection, scopes: &[Scope<'_>], out: &mut Deleted) -> Result<()> {
    for scope in scopes {
        let n = count(conn, scope)?;
        let slot = match scope.label {
            "projects" => &mut out.projects,
            "sessions" => &mut out.sessions,
            "feed" => &mut out.feed,
            "approvals" => &mut out.approvals,
            "intents" => &mut out.intents,
            "plans" => &mut out.plans,
            "phases" => &mut out.phases,
            "plan_revisions" => &mut out.plan_revisions,
            "unknowns" => &mut out.unknowns,
            "work_orders" => &mut out.work_orders,
            other => unreachable!("unlabelled dependant {other}"),
        };
        *slot += n;
    }
    Ok(())
}

/// Every scope that is still non-zero after the delete, as `table=count` text.
fn survivors(conn: &Connection, scopes: &[Scope<'_>]) -> Result<String> {
    let mut left = Vec::new();
    for scope in scopes {
        let n = count(conn, scope)?;
        if n > 0 {
            left.push(format!("{}={n}", scope.label));
        }
    }
    Ok(left.join(", "))
}

/// Delete one session and everything the schema hangs off it.
///
/// Runs inside the caller's transaction. Returns `Ok(None)` when there is no such session — a
/// missing row is not a failure, because the point of the call is that the row should not exist
/// afterwards and it already does not.
///
/// `work_orders` that named this session are **kept**, with `session_id` set to null, and
/// reported as [`Deleted::work_orders_orphaned`]; see this module's header for why that is
/// deliberate rather than an oversight.
///
/// # Errors
/// [`Error::DeleteIncomplete`] when a dependant survived the statement, which means a foreign key
/// is missing or `PRAGMA foreign_keys` was off. The transaction is the caller's, and rolling it
/// back on this error is what keeps a half-deleted session out of the database.
pub(crate) fn session(conn: &Connection, session_id: &str) -> Result<Option<Deleted>> {
    let one = [session_id.to_owned()];
    let scopes = session_scopes(&one);

    let mut out = Deleted::default();
    tally(conn, &scopes, &mut out)?;
    if out.sessions == 0 {
        return Ok(None);
    }
    out.work_orders_orphaned = count(
        conn,
        &Scope {
            label: "work_orders_orphaned",
            sql: "SELECT COUNT(*) FROM work_orders WHERE session_id = ?1",
            ids: &one,
        },
    )?;

    conn.execute("DELETE FROM sessions WHERE id = ?1", (session_id,))?;

    let left = survivors(conn, &scopes)?;
    if !left.is_empty() {
        return Err(Error::DeleteIncomplete { what: format!("session {session_id}"), left });
    }
    Ok(Some(out))
}

/// The four tables keyed directly on a session id.
fn session_scopes(sessions: &[String]) -> Vec<Scope<'_>> {
    vec![
        Scope { label: "sessions", sql: "SELECT COUNT(*) FROM sessions WHERE id = ?1", ids: sessions },
        Scope { label: "feed", sql: "SELECT COUNT(*) FROM feed WHERE session_id = ?1", ids: sessions },
        Scope {
            label: "approvals",
            sql: "SELECT COUNT(*) FROM approvals WHERE session_id = ?1",
            ids: sessions,
        },
        Scope {
            label: "intents",
            sql: "SELECT COUNT(*) FROM intents WHERE session_id = ?1",
            ids: sessions,
        },
    ]
}

/// Delete one project, every session under it, and the whole plan tree under it.
///
/// Runs inside the caller's transaction. Returns `Ok(None)` when there is no such project.
///
/// The returned [`DeletedIds`] is resolved before the statement, because the rows that answer it
/// are gone afterwards: the session ids the caller needs in order to remove raw logs and pid
/// files, and the phase ids it needs in order to remove gate logs.
///
/// # Errors
/// [`Error::DeleteIncomplete`], exactly as [`session`].
pub(crate) fn project(
    conn: &Connection,
    project_id: &str,
) -> Result<Option<(Deleted, DeletedIds)>> {
    let one = [project_id.to_owned()];
    let project_scope = [Scope {
        label: "projects",
        sql: "SELECT COUNT(*) FROM projects WHERE id = ?1",
        ids: &one,
    }];
    let mut out = Deleted::default();
    tally(conn, &project_scope, &mut out)?;
    if out.projects == 0 {
        return Ok(None);
    }

    let found = DeletedIds {
        sessions: ids(conn, "SELECT id FROM sessions WHERE project_id = ?1", project_id)?,
        plans: ids(conn, "SELECT id FROM plans WHERE project_id = ?1", project_id)?,
        phases: ids(
            conn,
            "SELECT id FROM phases
             WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?1)",
            project_id,
        )?,
    };
    let scopes = project_scopes(&one, &found);
    tally(conn, &scopes, &mut out)?;
    // Orders belonging to *another* project's phases that nevertheless name a session of this
    // one. Normally zero; counted rather than assumed, because a `session_id` going null in
    // somebody else's plan is a real edit and the report should say it happened. Filtered in
    // Rust because the question needs two id sets at once and [`Scope`] binds one.
    out.work_orders_orphaned = orphaned_orders(conn, &found)?;

    conn.execute("DELETE FROM projects WHERE id = ?1", (project_id,))?;

    let mut left = survivors(conn, &project_scope)?;
    let rest = survivors(conn, &scopes)?;
    if !rest.is_empty() {
        if left.is_empty() {
            left = rest;
        } else {
            left = format!("{left}, {rest}");
        }
    }
    if !left.is_empty() {
        return Err(Error::DeleteIncomplete { what: format!("project {project_id}"), left });
    }
    Ok(Some((out, found)))
}

/// Work orders naming one of these sessions from a phase that is **not** being deleted.
///
/// Those are the rows `ON DELETE SET NULL` keeps, and they are the whole reason the report
/// distinguishes an order that went from an order that merely lost its session.
fn orphaned_orders(conn: &Connection, found: &DeletedIds) -> Result<u32> {
    let mut stmt = conn.prepare("SELECT phase_id FROM work_orders WHERE session_id = ?1")?;
    let mut orphaned = 0u32;
    for session_id in &found.sessions {
        let rows = stmt.query_map((session_id.as_str(),), |row| row.get::<_, String>(0))?;
        for phase_id in rows {
            if !found.phases.contains(&phase_id?) {
                orphaned += 1;
            }
        }
    }
    Ok(orphaned)
}

/// Every table under a project, keyed on the ids resolved before the delete.
fn project_scopes<'a>(project: &'a [String], found: &'a DeletedIds) -> Vec<Scope<'a>> {
    let mut scopes = session_scopes(&found.sessions);
    scopes.extend([
        // The one table reachable two ways. The by-session half is already in `session_scopes`;
        // this adds the rows a session id would never find, and both halves are re-asked after
        // the delete.
        Scope {
            label: "intents",
            sql: "SELECT COUNT(*) FROM intents WHERE project_id = ?1 AND session_id IS NULL",
            ids: project,
        },
        Scope {
            label: "plans",
            sql: "SELECT COUNT(*) FROM plans WHERE project_id = ?1",
            ids: project,
        },
        Scope {
            label: "phases",
            sql: "SELECT COUNT(*) FROM phases WHERE id = ?1",
            ids: &found.phases,
        },
        Scope {
            label: "plan_revisions",
            sql: "SELECT COUNT(*) FROM plan_revisions WHERE plan_id = ?1",
            ids: &found.plans,
        },
        Scope {
            label: "unknowns",
            sql: "SELECT COUNT(*) FROM unknowns WHERE plan_id = ?1",
            ids: &found.plans,
        },
        Scope {
            label: "work_orders",
            sql: "SELECT COUNT(*) FROM work_orders WHERE phase_id = ?1",
            ids: &found.phases,
        },
    ]);
    scopes
}
