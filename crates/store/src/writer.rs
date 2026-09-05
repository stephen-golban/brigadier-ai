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
use brigadier_core::driver::McpPolicy;
use brigadier_core::event::{bounded, ExitReason, RequestId, SessionId, Usage};
use brigadier_core::session::Decision;
use rusqlite::{named_params, Connection, OptionalExtension};
use tokio::sync::oneshot;

use crate::delete::{self, DeleteOutcome, DeletedIds};
use crate::feed::FeedKind;
use crate::intents::{
    self, IntentKind, IntentOutcome, IntentRecord, IntentRow, IntentState, INTENT_COLUMNS,
    INTENT_OPEN_TIMEOUT,
};
use crate::plan::{
    self, PhaseRow, PhaseState, PlanRevisionRow, PlanRow, PlanStatus, UnknownRow, UnknownState,
    WorkOrderRow, WorkOrderState, PHASE_COLUMNS, PLAN_COLUMNS, PLAN_REVISION_COLUMNS,
    UNKNOWN_COLUMNS, WORK_ORDER_COLUMNS,
};
use crate::schema::{
    self, ApprovalRecord, FeedRow, ProjectRow, SessionRecord, SessionRow, SessionStatus,
    INTENT_SUBJECT_LIMIT, PLAN_TEXT_LIMIT, PROJECT_COLUMNS, SESSION_COLUMNS, SUMMARY_JSON_LIMIT,
};
use crate::{Error, Result, StoreConfig};

/// Free pages that must pile up before an idle reclaim is worth its writes (~1 MiB at 4 KiB).
const RECLAIM_THRESHOLD_PAGES: i64 = 256;

/// Pages one idle reclaim moves, so a huge freelist is drained over several batches.
const RECLAIM_PAGES_PER_BATCH: usize = 2048;

/// Bound one caller-supplied free-text value of the plan tables.
///
/// Every `&row.<field>` that is prose, a title, a command or a path goes through this on its way
/// into a statement. `schema::PLAN_TEXT_LIMIT` says which columns, and why a JSON column instead
/// gets `schema::oversized_json`.
fn plan_text(s: &str) -> String {
    bounded(s, PLAN_TEXT_LIMIT)
}

/// The statement behind [`StoreHandle::unsettled_intents`].
///
/// One string rather than an inline `format!`, so the test that checks it still rides the partial
/// index `intents_unsettled` is checking the statement the store actually runs.
fn unsettled_intents_sql() -> String {
    format!(
        "SELECT {INTENT_COLUMNS} FROM intents
         WHERE state IN ('open', 'unknown')
           AND (outcome IS NULL OR outcome NOT IN ('acked', 'operator'))
         ORDER BY opened_at ASC, id ASC"
    )
}

/// The same bound, on a path that is about to become text.
///
/// A truncated path is broken and visibly so, which is the right failure: the alternative is an
/// unbounded column, and unbounded text in an uncapped table is exactly how t3code went from
/// 282 KB to 218 MB in 25 hours.
fn plan_path(p: Option<&std::path::PathBuf>) -> Option<String> {
    p.map(|p| plan_text(&p.to_string_lossy()))
}

/// Which delete an [`Op::Delete`] is.
pub(crate) enum DeleteTarget {
    /// One session, by id.
    Session(String),
    /// One project, by id, and everything the cascade map hangs off it.
    Project(String),
}

/// One unit of work for the writer thread. Crate-private: the public surface is [`StoreHandle`].
pub(crate) enum Op {
    /// Durability barrier: callback result is acknowledged only after FULL commit.
    Durable(
        Box<dyn FnOnce(&Connection) -> Result<()> + Send>,
        oneshot::Sender<Result<()>>,
    ),
    Chat(crate::chat::ChatItem),
    /// Insert or replace a project.
    UpsertProject(ProjectRow),
    /// Set one project's MCP policy. A missing project is a no-op here; the supervisor checks
    /// existence first and answers `no_such_project` itself.
    SetProjectMcp {
        id: String,
        mcp: McpPolicy,
    },
    /// Merge a partial session row; `None` fields leave the stored value alone.
    UpsertSession(Box<SessionRow>),
    /// Append one terse feed row and advance the session's event cursor.
    Feed {
        session_id: SessionId,
        seq: u64,
        at: SystemTime,
        kind: FeedKind,
        line: String,
    },
    /// Overwrite the session's cumulative usage and cost.
    ///
    /// Overwrite, not `SET x = x + ?`: the provider reports `usage` and `total_cost_usd`
    /// cumulatively on every terminal frame, so summing them double-counts.
    // see docs/research/agent-sdk.md §6 and `brigadier_core::event::Usage`. The `x = x + ?`
    // shape of docs/research/persistence.md §3 still binds any counter that is *ours*; none is.
    SetUsage {
        session_id: SessionId,
        usage: Usage,
        cost_usd_cumulative: f64,
    },
    /// Record a parked request so a reload can re-render it.
    ApprovalOpened {
        session_id: SessionId,
        approval: Box<PendingApproval>,
    },
    /// Record the answer that unparked it.
    ApprovalResolved {
        request_id: RequestId,
        decision: Decision,
        at: SystemTime,
    },
    /// Settle a session's lifecycle columns.
    SessionEnded {
        session_id: SessionId,
        reason: ExitReason,
        exit_code: Option<i32>,
        at: SystemTime,
    },
    /// Unsettle them again: the row is being resumed by a new child.
    ///
    /// A separate op rather than an [`Op::UpsertSession`] because the upsert **cannot express
    /// this**: `ended_at` and `exit_code` are not in its statement at all, and every column that
    /// is, is `COALESCE`d, so `None` means "leave alone" and there is no value that means
    /// "clear". A resumed session that keeps its old `ended_at` reads as ended while it is live.
    // see docs/research/resume.md §8 gap 5.
    SessionResumed {
        session_id: SessionId,
        at: SystemTime,
    },
    /// Record an effect the harness is **about to** cause, and answer once it is committed.
    ///
    /// The only op that carries its own result back. Everything else here is fire-and-forget and
    /// a failed statement is logged and skipped; this one is what the caller is about to act on,
    /// so its insert error — and the commit that carries it — reach [`StoreHandle::intent_open`]
    /// instead of a log line nobody reads. Closes the coalescing window for the same reason
    /// [`Op::Query`] does: someone is waiting.
    ///
    /// There is no `ON CONFLICT` clause: `intents.id` is a fresh uuid per open, and unlike
    /// [`Op::Feed`] there is no second writer that can silently rewrite history here. A duplicate
    /// id therefore fails the statement, and that failure is now the caller's answer.
    // see docs/research/intent-records.md §2.1, §2.2.
    IntentOpen(Box<IntentRow>, oneshot::Sender<Result<()>>),
    /// Settle one intent.
    ///
    /// Never needs a flush: a lost close reads back as `open` and reconciliation re-derives the
    /// same answer from the world. Carries `session_id` because a `worktree_add` open could not
    /// name one — `worktree::prepare` runs before the session id is minted.
    ///
    /// Guarded by `AND state = 'open'`, the guard [`Op::ApprovalResolved`] uses, so a close that
    /// races the reconciler cannot overwrite a settled row.
    IntentClose {
        id: String,
        state: IntentState,
        outcome: IntentOutcome,
        evidence: Option<String>,
        session_id: Option<SessionId>,
        at: SystemTime,
    },
    /// A human looked at the diff and answered an intent nothing else could settle.
    ///
    /// A **separate op** from [`Op::IntentClose`], and it has to be: `IntentClose` is guarded by
    /// `AND state = 'open'`, which is what makes a live close idempotent and stops a late or
    /// duplicate close from resurrecting a settled row. But the plan card's *mark done / mark not
    /// done* exists **only** for rows reading `unknown`, and those are not `open` — so routing the
    /// owner's answer through `IntentClose` matched zero rows and the button did nothing.
    ///
    /// Guarded by `state IN ('open', 'unknown')`: exactly the rows the owner can be looking at.
    /// A row already settled `done`, `not_done` or `superseded` is left alone — that is an answer,
    /// and this op does not overwrite answers.
    ///
    /// `hold_to_settleable` still applies, and it applies to the owner too: a `work_order` is held
    /// to `unknown` **whoever asks**. The narrowing is the owner's own decision of 2026-09-04 and a
    /// button does not outrank it. What the row records instead is `outcome = 'operator'` and
    /// evidence naming the answer a human gave, so it reads as *answered by hand* rather than
    /// *derived*.
    // see docs/research/intent-records.md §5.4 — "the plan card offers exactly one action, and only
    // when the phase is blocked on it: mark done / mark not done, after the owner has looked at the
    // diff", and §5.2, whose `settle_intent` writes `outcome = 'operator'`. That file's §10.4 says
    // the store side is "a thin wrapper away" over `intent_close`; it is not, for the reason above.
    IntentSettledByOperator {
        id: String,
        state: IntentState,
        evidence: Option<String>,
        at: SystemTime,
    },
    /// Insert a plan, or rewrite the goal of one that exists.
    ///
    /// On conflict **only `goal` is rewritten**: `status`, `revision` and `approved_at` are
    /// transitions with their own ops, and an upsert that reset them could walk an approved plan
    /// back to `draft` — or worse, forward to `approved` — as a side effect of restating the goal.
    UpsertPlan(Box<PlanRow>),
    /// Stamp the owner's approval on a plan. Guarded by `AND status = 'draft'`, so a second
    /// approval does not move the timestamp the autonomous run is authorized by.
    PlanApproved {
        id: String,
        at: SystemTime,
    },
    /// Record one re-planning event and bump the plan's revision counter, in one transaction.
    ///
    /// Both statements or neither: a plan whose `revision` does not match its newest
    /// [`PlanRevisionRow`] is a plan whose history has a hole in it.
    // see docs/vision.md §8 — "recording what changed and why".
    PlanRevised(Box<PlanRevisionRow>),
    /// Insert a phase, or rewrite the content of one that exists.
    ///
    /// On conflict `ordinal`, `title`, `definition_of_done` and `verify_command` are rewritten —
    /// the four things re-planning changes — and the progress columns are left alone.
    ///
    /// **`UNIQUE(plan_id, ordinal)` is checked per statement, not per transaction.** Swapping two
    /// phases' ordinals in one batch fails the second statement, and `apply_batch` logs and skips
    /// it rather than raising. A reorder has to move one phase to a spare ordinal first.
    UpsertPhase(Box<PhaseRow>),
    /// Begin an attempt: `running`, `attempts + 1`, and the last gate's result cleared.
    ///
    /// A separate op rather than an [`Op::UpsertPhase`] because the upsert **cannot express
    /// this** — `attempts + 1` reads the stored value, and `ended_at`, `last_exit_code` and
    /// `last_evidence` have to be *cleared*, which no `COALESCE`d upsert can do. A re-attempted
    /// phase that keeps the previous attempt's exit code reads red while it is running.
    // the same reasoning as `Op::SessionResumed`; see docs/research/resume.md §8 gap 5.
    PhaseAttemptStarted {
        id: String,
        at: SystemTime,
    },
    /// Settle a phase with the gate's real exit code and a bounded excerpt of what it said.
    PhaseSettled {
        id: String,
        state: PhaseState,
        exit_code: Option<i32>,
        evidence: Option<String>,
        commit_sha: Option<String>,
        at: SystemTime,
    },
    /// Insert an unknown, or rewrite its bin and question.
    UpsertUnknown(Box<UnknownRow>),
    /// Settle an unknown, recording whether "just go" is what skipped it. Guarded by
    /// `AND state = 'open'`, so a real answer is not overwritten by a later skip.
    UnknownSettled {
        id: String,
        state: UnknownState,
        answer: Option<String>,
        findings_path: Option<std::path::PathBuf>,
        skipped_for_just_go: bool,
        at: SystemTime,
    },
    /// Insert a work order, or merge what dispatch learned about one.
    ///
    /// `session_id`, `worktree_path`, `branch` and `dispatched_at` are `COALESCE`d, so a second
    /// upsert that knows less does not clear what the first recorded.
    UpsertWorkOrder(Box<WorkOrderRow>),
    /// Store a worker's report and settle its order. Guarded by `AND finished_at IS NULL`, so a
    /// late duplicate cannot overwrite the report that was actually returned.
    WorkOrderFinished {
        id: String,
        state: WorkOrderState,
        report: Option<String>,
        at: SystemTime,
    },
    /// Delete a session, or a project and everything under it, and answer **after the commit**.
    ///
    /// Not an [`Op::Query`], for two reasons. `Query` hands its answer back *before* the
    /// transaction commits, which is right for a read and wrong for the one call whose caller is
    /// about to delete files on the strength of it. And a delete that fails its own
    /// post-condition has to roll back **only itself**, not the batch it was coalesced into, so
    /// it runs inside a savepoint.
    Delete {
        what: DeleteTarget,
        reply: oneshot::Sender<Result<Option<DeleteOutcome>>>,
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

    /// Persist a completed display item independently of the telemetry ring.
    pub async fn chat_item(&self, item: crate::chat::ChatItem) -> Result<()> {
        self.send(Op::Chat(item))
    }

    /// Page completed display items after a sequence cursor. The page is bounded.
    pub async fn chat_items(
        &self,
        session_id: String,
        after: u64,
    ) -> Result<Vec<crate::chat::ChatItem>> {
        self.query(move |conn| crate::chat::read(conn, &session_id, after))
            .await
    }

    /// Recent native rewind records, including incomplete operations needing reconciliation.
    pub async fn rewind_records(&self, session_id: String) -> Result<Vec<serde_json::Value>> {
        self.query(move |conn| {
            let mut stmt = conn.prepare("SELECT id,state,created_at FROM chat_rewinds WHERE session_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 20")?;
            let rows = stmt.query_map([session_id], |r| Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"state":r.get::<_,String>(1)?,"createdAt":r.get::<_,i64>(2)? * 1000})))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        }).await
    }

    /// Page retained transcript bodies for one rewind. Reading does not alter provider state.
    pub async fn rewind_items(
        &self,
        session_id: String,
        rewind_id: String,
        after: i64,
    ) -> Result<Vec<serde_json::Value>> {
        self.query(move |conn| {
            let mut stmt = conn.prepare("SELECT rowid,item_json FROM chat_archive WHERE session_id=?1 AND rewind_id=?2 AND rowid>?3 ORDER BY rowid LIMIT 20")?;
            let rows = stmt.query_map((session_id,rewind_id,after), |r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?)))?;
            let rows=rows.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().filter_map(|(cursor,body)| serde_json::from_str::<serde_json::Value>(&body).ok().map(|item|serde_json::json!({"cursor":cursor,"item":item}))).collect())
        }).await
    }

    /// Whether a native mutation needs reconciliation. Sending/resuming is blocked in this state.
    pub async fn rewind_pending(&self, session_id: String) -> Result<bool> {
        self.query(move |conn| {
            Ok(conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_rewinds WHERE session_id=?1 AND state='pending')",
                [session_id],
                |r| r.get(0),
            )?)
        })
        .await
    }

    /// Retain the discarded conversation before invoking the native provider mutation.
    pub async fn prepare_rewind(
        &self,
        id: String,
        session_id: String,
        target_id: String,
    ) -> Result<()> {
        self.durable(move |conn| {
            conn.execute_batch("SAVEPOINT prepare_rewind")?;
            let result = (|| -> Result<()> {
                let target_seq: i64 = conn.query_row("SELECT seq FROM chat_items WHERE session_id=?1 AND id=?2 AND provider_uuid IS NOT NULL", (&session_id, &target_id), |r| r.get(0))?;
                conn.execute("INSERT INTO chat_rewinds(id,session_id,target_id,target_seq,state,created_at) VALUES (?1,?2,?3,?4,'pending',unixepoch())", (&id,&session_id,&target_id,target_seq))?;
                let mut cursor = target_seq.saturating_sub(1) as u64;
                loop {
                    let page = crate::chat::read(conn, &session_id, cursor)?;
                    if page.is_empty() { break; }
                    for item in page {
                        cursor = item.seq;
                        conn.execute("INSERT INTO chat_archive(rewind_id,session_id,item_json) VALUES (?1,?2,?3)", (&id,&session_id,serde_json::to_string(&item).expect("chat item")))?;
                    }
                }
                Ok(())
            })();
            if result.is_err() { conn.execute_batch("ROLLBACK TO prepare_rewind")?; }
            conn.execute_batch("RELEASE prepare_rewind")?;
            result
        }).await?;
        self.flush().await
    }

    /// Finalize after an authoritative native reply. Failed requests keep the visible history.
    pub async fn finish_rewind(&self, id: String, through_seq: Option<u64>) -> Result<()> {
        self.durable(move |conn| {
            conn.execute_batch("SAVEPOINT finish_rewind")?;
            let result = (|| -> Result<()> {
                if let Some(seq) = through_seq {
                    conn.execute("DELETE FROM chat_items WHERE session_id=(SELECT session_id FROM chat_rewinds WHERE id=?1 AND state='pending') AND seq >= (SELECT target_seq FROM chat_rewinds WHERE id=?1) AND seq <= ?2", (&id,seq))?;
                }
                conn.execute("UPDATE chat_rewinds SET state=?2,through_seq=?3 WHERE id=?1 AND state='pending'", (&id,if through_seq.is_some(){"applied"}else{"refused"},through_seq))?;
                Ok(())
            })();
            if result.is_err() { conn.execute_batch("ROLLBACK TO finish_rewind")?; }
            conn.execute_batch("RELEASE finish_rewind")?;
            result
        }).await?;
        self.flush().await
    }

    /// Insert or replace a project.
    pub async fn upsert_project(&self, project: ProjectRow) -> Result<()> {
        self.send(Op::UpsertProject(project))
    }

    /// Set whether a project's children inherit the user's MCP servers.
    // see docs/research/spawn-split.md §6 and the migration 2 comment in `schema.rs`.
    pub async fn set_project_mcp(&self, id: String, mcp: McpPolicy) -> Result<()> {
        self.send(Op::SetProjectMcp { id, mcp })
    }

    /// Merge a partial session row. `None` fields leave the stored value alone.
    pub async fn upsert_session(&self, row: SessionRow) -> Result<()> {
        self.send(Op::UpsertSession(Box::new(row)))
    }

    /// Append one terse feed row; the ring drops the oldest rows past the cap in the same
    /// transaction that inserts.
    pub async fn feed(
        &self,
        session_id: SessionId,
        seq: u64,
        at: SystemTime,
        kind: FeedKind,
        line: String,
    ) -> Result<()> {
        self.send(Op::Feed {
            session_id,
            seq,
            at,
            kind,
            line,
        })
    }

    /// Overwrite a session's cumulative usage and cost.
    pub async fn set_usage(
        &self,
        session_id: SessionId,
        usage: Usage,
        cost_usd_cumulative: f64,
    ) -> Result<()> {
        self.send(Op::SetUsage {
            session_id,
            usage,
            cost_usd_cumulative,
        })
    }

    /// Record a parked request, stamped with the current launch's `run_id`.
    pub async fn approval_opened(
        &self,
        session_id: SessionId,
        approval: PendingApproval,
    ) -> Result<()> {
        self.send(Op::ApprovalOpened {
            session_id,
            approval: Box::new(approval),
        })
    }

    /// Record the answer that unparked a request.
    pub async fn approval_resolved(
        &self,
        request_id: RequestId,
        decision: Decision,
        at: SystemTime,
    ) -> Result<()> {
        self.send(Op::ApprovalResolved {
            request_id,
            decision,
            at,
        })
    }

    /// Reopen a settled session's lifecycle columns for a new child: `status` back to
    /// `starting`, `ended_at` and `exit_code` cleared.
    ///
    /// `at` stamps `started_at` only when the row never recorded one. A row that has a start time
    /// keeps it **only until the resumed child announces itself**: `feed::apply`'s
    /// `SessionStarted` branch then writes `started_at` again, and `upsert_session` COALESCEs the
    /// *parameter* first, so that non-`None` value overwrites. The conversation's original start
    /// time is not retained anywhere.
    // see docs/research/resume.md §11 and docs/plans/ipc-contract.md "### resume_session".
    pub async fn session_resumed(&self, session_id: SessionId, at: SystemTime) -> Result<()> {
        self.send(Op::SessionResumed { session_id, at })
    }

    /// Settle a session's lifecycle columns.
    pub async fn session_ended(
        &self,
        session_id: SessionId,
        reason: ExitReason,
        exit_code: Option<i32>,
        at: SystemTime,
    ) -> Result<()> {
        self.send(Op::SessionEnded {
            session_id,
            reason,
            exit_code,
            at,
        })
    }

    /// Record an effect the harness is about to cause, and return **only once the row is
    /// committed**.
    ///
    /// The one write in this crate that is durable on return, and it is the barrier itself:
    ///
    /// ```text
    /// (A) mint the id, capture the baseline   <- it stops being knowable after the effect
    /// (B) store.intent_open(row).await?       <- THE BARRIER: `Ok` means the row is on disk
    /// (C) perform the effect
    /// (D) store.intent_close(..).await        <- no flush, deliberately
    /// ```
    ///
    /// `Ok(())` means the insert ran and the transaction carrying it committed. Every failure —
    /// a foreign key, a duplicate id, an oversized value, a commit that did not land, a writer
    /// thread that is gone — is an `Err`, and an `Err` means the caller must not attempt the
    /// effect. No separate `flush()` is needed; one taken anyway is a second empty transaction.
    ///
    /// It costs one transaction, because the op ends the writer's coalescing window rather than
    /// waiting it out — the same commit the old `intent_open` + `flush()` pair already paid for.
    ///
    /// **It is bounded by [`crate::intents::INTENT_OPEN_TIMEOUT`], and a timeout must be treated
    /// by the caller exactly like a failed open: do not attempt the effect.** The queue in front
    /// of the writer is unbounded and the wait is a oneshot, so without a deadline a wedged
    /// filesystem stalls the orchestration loop indefinitely with nothing to surface.
    /// [`crate::Error::IntentOpenTimeout`] says the commit did not arrive in time — never that the
    /// row was not written — so the answer to one is to stop and reconcile, never to retry the
    /// effect.
    ///
    /// Why it is not `flush()`'s job: `flush()` answers "the batch committed", and `apply_batch`
    /// logs and skips a failed op rather than aborting the batch, so a row that never inserted
    /// was answered with `Ok(())` by every flush that followed it. That is the unrecorded-effect
    /// window this table exists to close, reintroduced underneath it.
    // see docs/research/intent-records.md §2.3 and §3, whose steps (B) and (C) this collapses
    // into one call the caller cannot forget to take.
    pub async fn intent_open(&self, row: IntentRow) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.send(Op::IntentOpen(Box::new(row), tx))?;
        match tokio::time::timeout(INTENT_OPEN_TIMEOUT, rx).await {
            Ok(reply) => reply.map_err(|_| Error::Closed)?,
            Err(_) => Err(Error::IntentOpenTimeout(INTENT_OPEN_TIMEOUT)),
        }
    }

    /// Settle an intent. Deliberately not flushed: a lost close reads back as `open` and
    /// reconciliation re-derives the same answer from the world.
    ///
    /// `session_id` fills in the id a `worktree_add` open could not name. A row that is already
    /// settled is left alone.
    pub async fn intent_close(
        &self,
        id: String,
        state: IntentState,
        outcome: IntentOutcome,
        evidence: Option<String>,
        session_id: Option<SessionId>,
        at: SystemTime,
    ) -> Result<()> {
        self.send(Op::IntentClose {
            id,
            state,
            outcome,
            evidence,
            session_id,
            at,
        })
    }

    /// Record the owner's own answer to an intent nothing else could settle — the plan card's
    /// *mark done* / *mark not done*, after they have looked at the diff.
    ///
    /// The path [`StoreHandle::intent_close`] cannot serve: that one is guarded on `state =
    /// 'open'` so a late or duplicate close cannot resurrect a settled row, and the rows this
    /// button exists for read `unknown`. This one is guarded on `state IN ('open', 'unknown')` —
    /// every row the owner can be looking at, and nothing that already carries a real answer.
    ///
    /// Two things it does **not** do. It does not outrank
    /// [`KnownIntentKind::settleable`](crate::KnownIntentKind::settleable): a `work_order` marked
    /// *done* by hand still lands on `unknown`, because the owner's 2026-09-04 narrowing says no
    /// postcondition — and no button — can prove more than that. And it does not pretend the
    /// answer was derived: the row records `outcome = 'operator'` and evidence naming what the
    /// human said, so the audit trail distinguishes a person from a postcondition.
    ///
    /// The row leaves [`StoreHandle::unsettled_intents`] afterwards. That is the point: a
    /// question a human has answered is not a question a human still has to answer.
    pub async fn intent_settled_by_operator(
        &self,
        id: String,
        state: IntentState,
        evidence: Option<String>,
        at: SystemTime,
    ) -> Result<()> {
        self.send(Op::IntentSettledByOperator {
            id,
            state,
            evidence,
            at,
        })
    }

    /// Insert a plan, or rewrite the goal of one that exists. On conflict **only `goal` is
    /// rewritten**: `status`, `revision` and `approved_at` are transitions with their own ops,
    /// and an upsert that reset them could walk an approved plan back to `draft`.
    pub async fn upsert_plan(&self, row: PlanRow) -> Result<()> {
        self.send(Op::UpsertPlan(Box::new(row)))
    }

    /// Stamp the owner's approval on a draft plan. A plan that is not `draft` is left alone.
    pub async fn plan_approved(&self, id: String, at: SystemTime) -> Result<()> {
        self.send(Op::PlanApproved { id, at })
    }

    /// Record one re-planning event and bump the plan's revision counter together.
    ///
    /// **A revision with no reason is refused**, with [`Error::Required`], rather than stored or
    /// silently filled in. `plan_revisions.reason` is `TEXT NOT NULL`, which does not mean
    /// non-empty, and a revision nobody explained is the thing the table exists to prevent
    /// (`docs/vision.md` §8). Refused and not substituted, because a manufactured reason —
    /// `"(none given)"` — reads in the UI exactly like one somebody wrote, and the caller is the
    /// only thing that knows the real one. Whitespace counts as empty.
    pub async fn plan_revised(&self, row: PlanRevisionRow) -> Result<()> {
        if row.reason.trim().is_empty() {
            return Err(Error::Required {
                field: "plan_revisions.reason",
            });
        }
        self.send(Op::PlanRevised(Box::new(row)))
    }

    /// Insert a phase, or rewrite the content of one that exists.
    ///
    /// `base_sha` is the exception: it is **write-once**, so the first sha stored is the phase's
    /// base for good and a later upsert can neither clear it nor move it. Everything else the
    /// statement touches — ordinal, title, definition of done, verify command — is content
    /// re-planning owns and is rewritten.
    pub async fn upsert_phase(&self, row: PhaseRow) -> Result<()> {
        self.send(Op::UpsertPhase(Box::new(row)))
    }

    /// Begin an attempt on a phase: `running`, `attempts + 1`, last gate result cleared.
    pub async fn phase_attempt_started(&self, id: String, at: SystemTime) -> Result<()> {
        self.send(Op::PhaseAttemptStarted { id, at })
    }

    /// Settle a phase with the gate's real exit code.
    pub async fn phase_settled(
        &self,
        id: String,
        state: PhaseState,
        exit_code: Option<i32>,
        evidence: Option<String>,
        commit_sha: Option<String>,
        at: SystemTime,
    ) -> Result<()> {
        self.send(Op::PhaseSettled {
            id,
            state,
            exit_code,
            evidence,
            commit_sha,
            at,
        })
    }

    /// Insert an unknown, or rewrite its bin and question.
    pub async fn upsert_unknown(&self, row: UnknownRow) -> Result<()> {
        self.send(Op::UpsertUnknown(Box::new(row)))
    }

    /// Settle an unknown, recording whether the owner's "just go" is what skipped it.
    pub async fn unknown_settled(
        &self,
        id: String,
        state: UnknownState,
        answer: Option<String>,
        findings_path: Option<std::path::PathBuf>,
        skipped_for_just_go: bool,
        at: SystemTime,
    ) -> Result<()> {
        self.send(Op::UnknownSettled {
            id,
            state,
            answer,
            findings_path,
            skipped_for_just_go,
            at,
        })
    }

    /// Insert a work order, or merge what dispatch learned about one.
    pub async fn upsert_work_order(&self, row: WorkOrderRow) -> Result<()> {
        self.send(Op::UpsertWorkOrder(Box::new(row)))
    }

    /// Store a worker's report and settle its order. An order that already finished is left alone.
    pub async fn work_order_finished(
        &self,
        id: String,
        state: WorkOrderState,
        report: Option<String>,
        at: SystemTime,
    ) -> Result<()> {
        self.send(Op::WorkOrderFinished {
            id,
            state,
            report,
            at,
        })
    }

    /// Commit everything sent before this call and wait for the commit.
    ///
    /// `Ok(())` means **the batch committed**, not that every op in it succeeded: a statement
    /// that failed was logged and skipped so that one bad op could not discard a whole window of
    /// other sessions' writes, and this call cannot tell you which. [`StoreHandle::intent_open`]
    /// is the one op that reports its own result, because it is the one a caller acts on.
    pub async fn flush(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.send(Op::Flush(tx))?;
        rx.await.map_err(|_| Error::Closed)
    }

    /// Delete one session's rows: the row itself, its feed, its approvals and its intents.
    ///
    /// **Durable on return.** `Ok(Some(..))` means the delete ran, every dependant went with it,
    /// and the transaction carrying all of that committed. `Ok(None)` means there was no such
    /// session, which is not an error: the caller wanted the row gone and it is.
    ///
    /// Work orders that named this session are **kept**, with `session_id` set to null, and
    /// counted as [`crate::delete::Deleted::work_orders_orphaned`]. That is `schema.rs`'s deliberate exception —
    /// the plan outlives the session that ran it — and not a leak.
    ///
    /// Nothing outside the database is touched. The raw NDJSON log, the pid file and the git
    /// worktree are the supervisor's half.
    ///
    /// # Errors
    /// [`Error::DeleteIncomplete`] when a dependant survived, in which case **nothing was
    /// deleted**: the delete runs inside its own savepoint and that error rolls it back.
    /// [`Error::Closed`] when the writer thread has stopped.
    // see crate::delete for the cascade map and the before/after check.
    pub async fn delete_session(&self, session_id: SessionId) -> Result<Option<DeleteOutcome>> {
        self.delete(DeleteTarget::Session(session_id.as_str().to_owned()))
            .await
    }

    /// Delete one project, every session under it, and its whole plan tree.
    ///
    /// Durable on return and `Ok(None)` for a project that is not there, exactly as
    /// [`StoreHandle::delete_session`]. The returned [`DeletedIds`] carries the session and phase
    /// ids that went, because the files keyed on them — raw logs, pid files, gate logs — cannot
    /// be found once the rows are gone.
    ///
    /// # Errors
    /// As [`StoreHandle::delete_session`].
    pub async fn delete_project(&self, project_id: String) -> Result<Option<DeleteOutcome>> {
        self.delete(DeleteTarget::Project(project_id)).await
    }

    async fn delete(&self, what: DeleteTarget) -> Result<Option<DeleteOutcome>> {
        let (tx, rx) = oneshot::channel();
        self.send(Op::Delete { what, reply: tx })?;
        rx.await.map_err(|_| Error::Closed)?
    }

    /// Run `f` on the writer thread, inside the transaction that carries the ops queued before it.
    pub(crate) async fn query<T, F>(&self, f: F) -> Result<T>
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

    pub(crate) async fn durable<F>(&self, f: F) -> Result<()>
    where
        F: FnOnce(&Connection) -> Result<()> + Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        self.send(Op::Durable(Box::new(f), tx))?;
        rx.await.map_err(|_| Error::Closed)?
    }

    /// Every project, oldest first by creation time.
    pub async fn list_projects(&self) -> Result<Vec<ProjectRow>> {
        self.query(|conn| {
            let sql =
                format!("SELECT {PROJECT_COLUMNS} FROM projects ORDER BY created_at ASC, id ASC");
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
            let sql =
                format!("SELECT {SESSION_COLUMNS} FROM sessions ORDER BY started_at DESC, id ASC");
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
                "SELECT session_id, seq, at, kind, line FROM feed WHERE session_id = ?1
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

    /// Every intent **a human still has to decide about**, oldest first.
    ///
    /// Read that sentence and not "every row not marked done" — the difference is the whole
    /// query. Two conditions, and the second is the one that is easy to drop:
    ///
    /// 1. `state` is `open` or `unknown`. Nothing settled it, or what settled it could not tell.
    /// 2. `outcome` is neither `acked` nor `operator` — the two ways a row can already have been
    ///    answered. `acked` means the code that did the thing closed it live, while the process
    ///    that opened it was still running. `operator` means a **human already looked and said**,
    ///    through [`StoreHandle::intent_settled_by_operator`]. Both are deliberate answers rather
    ///    than absences of one, and neither is anything the owner needs to look at again. Only
    ///    `reconciled` — a postcondition that read the world and could not tell — and a bare `open`
    ///    row with no outcome at all survive.
    ///
    /// Condition 2's `operator` half is load-bearing for the plan card and not an optimisation. A
    /// `work_order` is held to `unknown` whoever settles it, the owner included, so a row the owner
    /// has personally answered still reads `unknown` — without this it returns to the card forever
    /// and the button appears to do nothing however many times it is pressed.
    ///
    /// Without condition 2 this returns a row for **every work order that ever ran**, green phases
    /// included: [`KnownIntentKind::WorkOrder`](crate::KnownIntentKind::WorkOrder) may settle only
    /// [`IntentState::Unknown`] (the
    /// owner's 2026-09-04 narrowing, and it is right), so `hold_to_settleable` writes `unknown` on
    /// the loop's *normal* close too. The plan card would then offer the owner a list of
    /// everything that worked, and a reconciler applying "an `unknown` blocks its phase" would
    /// block every phase that ever dispatched an order. `outcome` is what tells a live ack from a
    /// post-crash finding: [`IntentOutcome::Reconciled`] and [`IntentOutcome::Operator`] survive
    /// the filter, and an `open` row has no outcome at all and survives it too.
    ///
    /// Rows from *any* `run_id`, not just the previous one: the data-dir lock guarantees one
    /// instance, so an `open` row is by definition unattended.
    ///
    /// Still served by the partial index `intents_unsettled`, whose predicate is the **wider** of
    /// the two conditions: SQLite may use a partial index whose `WHERE` is implied by the query's,
    /// and condition 1 is a top-level term here verbatim. Narrowing the index to match would cost
    /// a migration rung for a table that holds a few hundred rows and is swept weekly, which is
    /// out of proportion; the query is where correctness lives.
    // see docs/research/intent-records.md §4.2 step 2 and §5.
    pub async fn unsettled_intents(&self) -> Result<Vec<IntentRecord>> {
        self.query(|conn| {
            let sql = unsettled_intents_sql();
            let mut stmt = conn.prepare_cached(&sql)?;
            let rows = stmt.query_map([], intents::intent_from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
    }

    /// Every intent for one session, newest first. Served by `intents_session`.
    pub async fn session_intents(&self, session_id: SessionId) -> Result<Vec<IntentRecord>> {
        self.query(move |conn| {
            let sql = format!(
                "SELECT {INTENT_COLUMNS} FROM intents WHERE session_id = ?1
                 ORDER BY opened_at DESC, id ASC"
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let rows = stmt.query_map((session_id.as_str(),), intents::intent_from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
    }

    /// The live plan for a project: the newest one written, or `None`.
    ///
    /// "Newest" and not "the newest non-terminal one" on purpose — one plan per goal-run means a
    /// finished plan is the current one until the owner states a new intent, and the plan card
    /// has to be able to say *"6 phases · 6 done"* rather than showing nothing.
    pub async fn current_plan(&self, project_id: &str) -> Result<Option<PlanRow>> {
        let project_id = project_id.to_owned();
        self.query(move |conn| {
            let sql = format!(
                "SELECT {PLAN_COLUMNS} FROM plans WHERE project_id = ?1
                 ORDER BY created_at DESC, id ASC LIMIT 1"
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut rows = stmt.query((project_id.as_str(),))?;
            match rows.next()? {
                Some(row) => Ok(Some(plan::plan_from_row(row)?)),
                None => Ok(None),
            }
        })
        .await
    }

    /// One plan by id.
    pub async fn plan(&self, id: &str) -> Result<Option<PlanRow>> {
        let id = id.to_owned();
        self.query(move |conn| {
            let sql = format!("SELECT {PLAN_COLUMNS} FROM plans WHERE id = ?1");
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut rows = stmt.query((id.as_str(),))?;
            match rows.next()? {
                Some(row) => Ok(Some(plan::plan_from_row(row)?)),
                None => Ok(None),
            }
        })
        .await
    }

    /// The phases of a plan, in `ordinal` order. The checklist the plan card renders.
    pub async fn phases(&self, plan_id: &str) -> Result<Vec<PhaseRow>> {
        let plan_id = plan_id.to_owned();
        self.query(move |conn| {
            let sql =
                format!("SELECT {PHASE_COLUMNS} FROM phases WHERE plan_id = ?1 ORDER BY ordinal");
            let mut stmt = conn.prepare_cached(&sql)?;
            let rows = stmt.query_map((plan_id.as_str(),), plan::phase_from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
    }

    /// Every re-planning event on a plan, oldest first.
    pub async fn plan_revisions(&self, plan_id: &str) -> Result<Vec<PlanRevisionRow>> {
        let plan_id = plan_id.to_owned();
        self.query(move |conn| {
            let sql = format!(
                "SELECT {PLAN_REVISION_COLUMNS} FROM plan_revisions WHERE plan_id = ?1
                 ORDER BY revision ASC"
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let rows = stmt.query_map((plan_id.as_str(),), plan::plan_revision_from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
    }

    /// Every unknown of a plan, oldest first — answered, skipped and outstanding alike.
    ///
    /// Skipped ones are kept and returned so that when a phase later fails on a question that was
    /// waved off, the thread can say which one (`docs/vision.md` §4 step 5).
    pub async fn unknowns(&self, plan_id: &str) -> Result<Vec<UnknownRow>> {
        let plan_id = plan_id.to_owned();
        self.query(move |conn| {
            let sql = format!(
                "SELECT {UNKNOWN_COLUMNS} FROM unknowns WHERE plan_id = ?1
                 ORDER BY asked_at ASC, id ASC"
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let rows = stmt.query_map((plan_id.as_str(),), plan::unknown_from_row)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
    }

    /// The work orders of one phase, oldest dispatch first.
    pub async fn work_orders(&self, phase_id: &str) -> Result<Vec<WorkOrderRow>> {
        let phase_id = phase_id.to_owned();
        self.query(move |conn| {
            let sql = format!(
                "SELECT {WORK_ORDER_COLUMNS} FROM work_orders WHERE phase_id = ?1
                 ORDER BY dispatched_at ASC, id ASC"
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let rows = stmt.query_map((phase_id.as_str(),), plan::work_order_from_row)?;
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
        self.query(move |conn| Ok(conn.query_row(&sql, [], |row| row.get(0))?))
            .await
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
/// [`Op::Query`], an [`Op::IntentOpen`], an [`Op::Flush`] or [`Op::Shutdown`] — ends the window
/// immediately.
fn run(mut conn: Connection, rx: mpsc::Receiver<Op>, run_id: String, config: StoreConfig) {
    loop {
        let Ok(first) = rx.recv() else { break };
        let mut batch = vec![first];
        let deadline = Instant::now() + config.batch_window;
        // Coalesce. A `Query`, `Flush` or `Shutdown` closes the window early so the waiter is
        // not held for a window it did not ask for.
        while !matches!(
            batch.last(),
            Some(
                Op::Durable(..)
                    | Op::Query(_)
                    | Op::IntentOpen(..)
                    | Op::Delete { .. }
                    | Op::Flush(_)
                    | Op::Shutdown
            )
        ) {
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
/// writes from the same 250 ms window. [`Op::IntentOpen`] is skipped the same way and **also
/// answered**: its caller is holding the reply, and is about to cause a real effect on the
/// strength of it. [`Op::Delete`] is answered the same way, and additionally runs inside a
/// savepoint so that "skipped" means *nothing of it landed* rather than "half of it landed".
fn apply_batch(
    conn: &mut Connection,
    batch: Vec<Op>,
    run_id: &str,
    config: &StoreConfig,
) -> Result<usize> {
    let durable = batch.iter().any(|op| matches!(op, Op::Durable(..)));
    if durable {
        conn.execute_batch("PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;")?;
    }
    let mut tx = conn.transaction()?;
    let mut touched: BTreeSet<String> = BTreeSet::new();
    let mut flushes: Vec<oneshot::Sender<()>> = Vec::new();
    // Answered after `tx.commit()`, so an `Ok` reply means the row is on disk and not merely
    // inserted. A commit that fails takes the whole `Vec` down with it unsent, and the caller
    // reads the dropped sender as `Error::Closed` — an error either way, never `Ok`.
    let mut opens: Vec<(Result<()>, oneshot::Sender<Result<()>>)> = Vec::new();
    // Answered after the commit, for the same reason `opens` is: the caller is about to remove
    // worktrees and log files on the strength of the answer.
    type DeleteReply = (
        Result<Option<DeleteOutcome>>,
        oneshot::Sender<Result<Option<DeleteOutcome>>>,
    );
    let mut deletes: Vec<DeleteReply> = Vec::new();
    let mut queries = 0usize;

    for op in batch {
        let outcome = match op {
            Op::Durable(f, reply) => {
                let sp = tx.savepoint()?;
                let result = f(&sp).and_then(|()| sp.commit().map_err(Error::from));
                opens.push((result, reply));
                Ok(())
            }
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
            Op::IntentOpen(row, reply) => {
                let result = insert_intent(&tx, *row, run_id, &mut touched);
                // Logged here rather than below, because the value itself goes to the caller.
                if let Err(e) = &result {
                    tracing::warn!(error = %e, "intent_open failed; the caller is told so");
                }
                opens.push((result, reply));
                Ok(())
            }
            Op::Delete { what, reply } => {
                let result = run_delete(&mut tx, &what);
                if let Err(e) = &result {
                    tracing::warn!(error = %e, "delete failed and was rolled back");
                }
                deletes.push((result, reply));
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
    if durable {
        conn.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA fullfsync=OFF;")?;
    }
    tracing::trace!(
        queries,
        deleted,
        sessions = touched.len(),
        "store batch committed"
    );
    for (result, reply) in opens {
        let _ = reply.send(result);
    }
    for (result, reply) in deletes {
        // A project delete can free tens of thousands of feed pages; feeding its row count into
        // the same counter is what makes `run` reclaim them instead of leaving the file at its
        // high-water mark.
        if let Ok(Some(outcome)) = &result {
            deleted += outcome.rows.feed as usize;
        }
        let _ = reply.send(result);
    }
    for reply in flushes {
        let _ = reply.send(());
    }
    Ok(deleted)
}

/// Run one delete inside its own savepoint, so a failed post-condition rolls back the delete and
/// nothing else in the batch.
///
/// The `?`s are the mechanism: dropping a [`rusqlite::Savepoint`] without committing rolls it
/// back, so every error path here — a missing foreign key, a surviving dependant — leaves the
/// database as it was and the caller is told so.
fn run_delete(
    tx: &mut rusqlite::Transaction<'_>,
    what: &DeleteTarget,
) -> Result<Option<DeleteOutcome>> {
    let sp = tx.savepoint()?;
    let outcome = match what {
        DeleteTarget::Session(id) => delete::session(&sp, id)?.map(|rows| DeleteOutcome {
            rows,
            ids: DeletedIds {
                sessions: vec![id.clone()],
                ..DeletedIds::default()
            },
        }),
        DeleteTarget::Project(id) => {
            delete::project(&sp, id)?.map(|(rows, ids)| DeleteOutcome { rows, ids })
        }
    };
    sp.commit()?;
    Ok(outcome)
}

fn apply_one(
    tx: &rusqlite::Transaction<'_>,
    op: Op,
    run_id: &str,
    touched: &mut BTreeSet<String>,
) -> Result<()> {
    match op {
        Op::Chat(item) => {
            ensure_session(tx, &SessionId::new(&item.session_id), touched)?;
            crate::chat::write(tx, &item)?;
            // A crash between this projection and its feed row must not reuse this sequence.
            tx.execute(
                "UPDATE sessions SET last_event_seq=MAX(last_event_seq,?2) WHERE id=?1",
                (&item.session_id, item.seq),
            )?;
        }
        Op::UpsertProject(p) => {
            // `mcp` is written on insert and on conflict alike: the row carries the policy, so
            // an upsert that omitted it would silently reset an opted-in project to `off`.
            tx.prepare_cached(
                "INSERT INTO projects(id, name, root_path, created_at, mcp)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                     root_path = excluded.root_path, mcp = excluded.mcp",
            )?
            .execute((
                &p.id,
                &p.name,
                p.root_path.to_string_lossy().as_ref(),
                schema::to_millis(p.created_at),
                p.mcp.as_slug(),
            ))?;
        }
        Op::SetProjectMcp { id, mcp } => {
            tx.prepare_cached("UPDATE projects SET mcp = ?1 WHERE id = ?2")?
                .execute((mcp.as_slug(), &id))?;
        }
        Op::UpsertSession(row) => upsert_session(tx, *row)?,
        Op::Feed {
            session_id,
            seq,
            at,
            kind,
            line,
        } => {
            ensure_session(tx, &session_id, touched)?;
            tx.prepare_cached(
                "INSERT INTO feed(session_id, seq, at, kind, line) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(session_id, seq) DO UPDATE SET at = excluded.at,
                     kind = excluded.kind, line = excluded.line",
            )?
            .execute((
                session_id.as_str(),
                seq,
                schema::to_millis(at),
                kind.as_str(),
                &line,
            ))?;
            // `last_event_seq` is the cursor of the newest event that produced a *feed row*;
            // events with no terse line are deliberately not written at all.
            // see docs/research/persistence.md §3 — never a write per chunk.
            tx.prepare_cached(
                "UPDATE sessions SET last_event_seq = MAX(last_event_seq, ?2) WHERE id = ?1",
            )?
            .execute((session_id.as_str(), seq))?;
        }
        Op::SetUsage {
            session_id,
            usage,
            cost_usd_cumulative,
        } => {
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
        Op::ApprovalOpened {
            session_id,
            approval,
        } => {
            ensure_session(tx, &session_id, touched)?;
            let params = schema::approval_params(&session_id, run_id, &approval);
            tx.prepare_cached(
                "INSERT INTO approvals(request_id, session_id, run_id, opened_at, kind_json)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(request_id) DO UPDATE SET kind_json = excluded.kind_json",
            )?
            .execute(params)?;
        }
        Op::ApprovalResolved {
            request_id,
            decision,
            at,
        } => {
            let json = serde_json::to_string(&decision)?;
            tx.prepare_cached(
                "UPDATE approvals SET resolved_at = ?2, decision_json = ?3
                 WHERE request_id = ?1 AND resolved_at IS NULL",
            )?
            .execute((request_id.as_str(), schema::to_millis(at), json))?;
        }
        Op::SessionEnded {
            session_id,
            reason,
            exit_code,
            at,
        } => {
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
        Op::SessionResumed { session_id, at } => {
            ensure_session(tx, &session_id, touched)?;
            tx.prepare_cached(
                "UPDATE sessions SET status = ?2, ended_at = NULL, exit_code = NULL,
                     started_at = COALESCE(started_at, ?3) WHERE id = ?1",
            )?
            .execute((
                session_id.as_str(),
                SessionStatus::Starting.as_str(),
                schema::to_millis(at),
            ))?;
        }
        Op::IntentClose {
            id,
            state,
            outcome,
            evidence,
            session_id,
            at,
        } => {
            // The close is what names the session a `worktree_add` open could not, so the stub
            // has to exist here too or the foreign key rejects the whole update and the row
            // silently stays `open`.
            if let Some(session_id) = session_id.as_ref() {
                ensure_session(tx, session_id, touched)?;
            }
            // The kind lives on the row, not in the op, so the guard has to read it back — in
            // this transaction, under the same `state = 'open'` guard the UPDATE uses, so a row
            // that is already settled or absent is not judged against a kind it no longer has.
            let kind: Option<String> = tx
                .prepare_cached("SELECT kind FROM intents WHERE id = ?1 AND state = 'open'")?
                .query_row((&id,), |row| row.get(0))
                .optional()?;
            let (state, evidence) = match kind {
                Some(kind) => intents::hold_to_settleable(&IntentKind::new(kind), state, evidence),
                None => (state, evidence),
            };
            tx.prepare_cached(
                "UPDATE intents SET state = ?2, outcome = ?3, evidence = ?4, closed_at = ?5,
                     session_id = COALESCE(?6, session_id)
                 WHERE id = ?1 AND state = 'open'",
            )?
            .execute((
                &id,
                state.as_slug(),
                outcome.as_slug(),
                evidence.as_deref().map(intents::evidence),
                schema::to_millis(at),
                session_id.as_ref().map(|s| s.as_str()),
            ))?;
        }
        Op::IntentSettledByOperator {
            id,
            state,
            evidence,
            at,
        } => {
            // Read the kind under the *same* guard the UPDATE uses, so a row that is already
            // answered or absent is not judged against a kind it no longer has — the reasoning
            // `IntentClose` uses, one guard wider.
            const GUARD: &str = "state IN ('open', 'unknown')";
            let kind: Option<String> = tx
                .prepare_cached(&format!(
                    "SELECT kind FROM intents WHERE id = ?1 AND {GUARD}"
                ))?
                .query_row((&id,), |row| row.get(0))
                .optional()?;
            // Recorded before the hold, so the evidence says what the human answered even when
            // the hold then overrides it: "requested done; work_order settles unknown only.
            // operator answered done. <whatever they typed>".
            let stated = format!("operator answered {}", state.as_slug());
            let evidence = Some(match evidence {
                Some(had) => format!("{stated}. {had}"),
                None => stated,
            });
            let (state, evidence) = match kind {
                Some(kind) => intents::hold_to_settleable(&IntentKind::new(kind), state, evidence),
                None => (state, evidence),
            };
            tx.prepare_cached(&format!(
                "UPDATE intents SET state = ?2, outcome = ?3, evidence = ?4, closed_at = ?5
                 WHERE id = ?1 AND {GUARD}"
            ))?
            .execute((
                &id,
                state.as_slug(),
                IntentOutcome::Operator.as_slug(),
                evidence.as_deref().map(intents::evidence),
                schema::to_millis(at),
            ))?;
        }
        Op::UpsertPlan(row) => {
            tx.prepare_cached(
                "INSERT INTO plans(id, project_id, goal, status, revision, created_at,
                     approved_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET goal = excluded.goal",
            )?
            .execute((
                &row.id,
                &row.project_id,
                plan_text(&row.goal),
                row.status.as_slug(),
                row.revision,
                schema::to_millis(row.created_at),
                row.approved_at.map(schema::to_millis),
            ))?;
        }
        Op::PlanApproved { id, at } => {
            tx.prepare_cached(
                "UPDATE plans SET status = ?2, approved_at = ?3
                 WHERE id = ?1 AND status = 'draft'",
            )?
            .execute((&id, PlanStatus::Approved.as_slug(), schema::to_millis(at)))?;
        }
        Op::PlanRevised(row) => {
            tx.prepare_cached(
                "INSERT INTO plan_revisions(id, plan_id, revision, at, reason, change_json,
                     moved_definition_of_done)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?
            .execute((
                &row.id,
                &row.plan_id,
                row.revision,
                schema::to_millis(row.at),
                plan_text(&row.reason),
                // Never `bounded`: it appends `…`, and `…` in the middle of a JSON document is
                // text that no longer parses.
                schema::oversized_json(&row.change_json, PLAN_TEXT_LIMIT),
                i64::from(row.moved_definition_of_done),
            ))?;
            // Same statement pair, same transaction: a plan whose `revision` disagrees with its
            // newest revision row is a plan whose history has a hole in it.
            tx.prepare_cached("UPDATE plans SET revision = MAX(revision, ?2) WHERE id = ?1")?
                .execute((&row.plan_id, row.revision))?;
        }
        Op::UpsertPhase(row) => {
            // **`base_sha` is write-once.** `COALESCE(phases.base_sha, excluded.base_sha)` takes
            // the stored value first, so the first sha that becomes knowable wins: a later upsert
            // can neither clear it (a `None` loses to the stored value) nor *move* it (a
            // conflicting sha loses too). Operand order is the whole fix — the other way round,
            // `COALESCE` returns the incoming sha whenever it is non-null and the column is
            // silently mutable.
            //
            // Mutability here is the bug the column exists to prevent: `worktree::prepare`
            // branches from the constant `HEAD`, and once the loop commits per phase `HEAD` moves,
            // so two orders dispatched either side of a phase commit must branch from the *same*
            // base or the merge is against two different bases.
            // see docs/plans/w1b-loop-order.md §1 D7.
            tx.prepare_cached(
                "INSERT INTO phases(id, plan_id, ordinal, title, definition_of_done,
                     verify_command, state, attempts, started_at, ended_at, base_sha, commit_sha,
                     last_exit_code, last_evidence)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(id) DO UPDATE SET ordinal = excluded.ordinal,
                     title = excluded.title,
                     definition_of_done = excluded.definition_of_done,
                     verify_command = excluded.verify_command,
                     base_sha = COALESCE(phases.base_sha, excluded.base_sha)",
            )?
            .execute((
                &row.id,
                &row.plan_id,
                row.ordinal,
                plan_text(&row.title),
                plan_text(&row.definition_of_done),
                row.verify_command.as_deref().map(plan_text),
                row.state.as_slug(),
                row.attempts,
                row.started_at.map(schema::to_millis),
                row.ended_at.map(schema::to_millis),
                row.base_sha.as_deref().map(plan_text),
                row.commit_sha.as_deref().map(plan_text),
                row.last_exit_code,
                row.last_evidence.as_deref().map(plan_text),
            ))?;
        }
        Op::PhaseAttemptStarted { id, at } => {
            tx.prepare_cached(
                "UPDATE phases SET state = ?2, attempts = attempts + 1,
                     started_at = COALESCE(started_at, ?3), ended_at = NULL,
                     last_exit_code = NULL, last_evidence = NULL
                 WHERE id = ?1",
            )?
            .execute((&id, PhaseState::Running.as_slug(), schema::to_millis(at)))?;
        }
        Op::PhaseSettled {
            id,
            state,
            exit_code,
            evidence,
            commit_sha,
            at,
        } => {
            tx.prepare_cached(
                "UPDATE phases SET state = ?2, ended_at = ?3, last_exit_code = ?4,
                     last_evidence = ?5, commit_sha = COALESCE(?6, commit_sha)
                 WHERE id = ?1",
            )?
            .execute((
                &id,
                state.as_slug(),
                schema::to_millis(at),
                exit_code,
                evidence.as_deref().map(plan_text),
                commit_sha.as_deref().map(plan_text),
            ))?;
        }
        Op::UpsertUnknown(row) => {
            tx.prepare_cached(
                "INSERT INTO unknowns(id, plan_id, bin, question, state, answer, findings_path,
                     asked_at, settled_at, skipped_for_just_go)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET bin = excluded.bin,
                     question = excluded.question",
            )?
            .execute((
                &row.id,
                &row.plan_id,
                row.bin.as_slug(),
                plan_text(&row.question),
                row.state.as_slug(),
                row.answer.as_deref().map(plan_text),
                plan_path(row.findings_path.as_ref()),
                schema::to_millis(row.asked_at),
                row.settled_at.map(schema::to_millis),
                i64::from(row.skipped_for_just_go),
            ))?;
        }
        Op::UnknownSettled {
            id,
            state,
            answer,
            findings_path,
            skipped_for_just_go,
            at,
        } => {
            tx.prepare_cached(
                "UPDATE unknowns SET state = ?2, answer = ?3, findings_path = ?4,
                     skipped_for_just_go = ?5, settled_at = ?6
                 WHERE id = ?1 AND state = 'open'",
            )?
            .execute((
                &id,
                state.as_slug(),
                answer.as_deref().map(plan_text),
                plan_path(findings_path.as_ref()),
                i64::from(skipped_for_just_go),
                schema::to_millis(at),
            ))?;
        }
        Op::UpsertWorkOrder(row) => {
            if let Some(session_id) = row.session_id.as_ref() {
                ensure_session(tx, session_id, touched)?;
            }
            // **A finished order is history and this statement must not rewrite it.** `state`,
            // `title` and `owned_paths_json` are guarded on `finished_at IS NULL`: without the
            // guard a stale upsert walked a *reported* order back to `dispatched`, and the loop
            // then ran the same work twice — the exact failure the `intents` table exists to
            // prevent, reintroduced one table over. `report` and `finished_at` are not in the
            // update at all, and `Op::WorkOrderFinished` is the only op that sets them.
            tx.prepare_cached(
                "INSERT INTO work_orders(id, phase_id, session_id, title, owned_paths_json,
                     state, worktree_path, branch, dispatched_at, finished_at, report)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO UPDATE SET
                     session_id = COALESCE(excluded.session_id, work_orders.session_id),
                     title = CASE WHEN work_orders.finished_at IS NULL
                                  THEN excluded.title ELSE work_orders.title END,
                     owned_paths_json = CASE WHEN work_orders.finished_at IS NULL
                                             THEN excluded.owned_paths_json
                                             ELSE work_orders.owned_paths_json END,
                     state = CASE WHEN work_orders.finished_at IS NULL
                                  THEN excluded.state ELSE work_orders.state END,
                     worktree_path = COALESCE(excluded.worktree_path, work_orders.worktree_path),
                     branch = COALESCE(excluded.branch, work_orders.branch),
                     dispatched_at = COALESCE(excluded.dispatched_at, work_orders.dispatched_at)",
            )?
            .execute((
                &row.id,
                &row.phase_id,
                row.session_id.as_ref().map(|s| s.as_str()),
                plan_text(&row.title),
                // Never `bounded`: a truncated path list is a path list two workers can both
                // match, and disjoint ownership is what stops them writing the same file.
                schema::oversized_json(&row.owned_paths_json, PLAN_TEXT_LIMIT),
                row.state.as_slug(),
                plan_path(row.worktree_path.as_ref()),
                row.branch.as_deref().map(plan_text),
                row.dispatched_at.map(schema::to_millis),
                row.finished_at.map(schema::to_millis),
                row.report.as_deref().map(plan_text),
            ))?;
        }
        Op::WorkOrderFinished {
            id,
            state,
            report,
            at,
        } => {
            tx.prepare_cached(
                "UPDATE work_orders SET state = ?2, report = ?3, finished_at = ?4
                 WHERE id = ?1 AND finished_at IS NULL",
            )?
            .execute((
                &id,
                state.as_slug(),
                report.as_deref().map(plan_text),
                schema::to_millis(at),
            ))?;
        }
        // Handled by `apply_batch` before it delegates here; never reached, and a stray one is
        // logged rather than panicking a thread that owns the only connection.
        Op::Durable(..)
        | Op::IntentOpen(..)
        | Op::Delete { .. }
        | Op::Query(_)
        | Op::Flush(_)
        | Op::Shutdown => {
            tracing::error!("an op apply_batch owns reached apply_one");
        }
    }
    Ok(())
}

/// Insert the one row that is written *before* an effect, and report what happened.
///
/// Split out of [`apply_one`] because its caller is waiting on the answer: everything else in
/// this crate is fire-and-forget, and a failure here — a foreign key, a duplicate id, a
/// serialization error — has to reach [`StoreHandle::intent_open`] rather than a log line.
fn insert_intent(
    tx: &rusqlite::Transaction<'_>,
    row: IntentRow,
    run_id: &str,
    touched: &mut BTreeSet<String>,
) -> Result<()> {
    // A session that has not reached the table yet gets a stub, so the FK holds and the one row
    // this design depends on is not silently dropped. `project_id` gets no such courtesy: a
    // project is created before anything acts on it, and inventing one would hide a caller bug —
    // which is now a caller bug the caller is told about.
    if let Some(session_id) = row.session_id.as_ref() {
        ensure_session(tx, session_id, touched)?;
    }
    tx.prepare_cached(
        "INSERT INTO intents(id, run_id, kind, state, project_id, session_id, opened_at,
             subject, baseline, detail_json)
         VALUES (?1, ?2, ?3, 'open', ?4, ?5, ?6, ?7, ?8, ?9)",
    )?
    .execute((
        &row.id,
        run_id,
        row.kind.as_str(),
        &row.project_id,
        row.session_id.as_ref().map(|s| s.as_str()),
        schema::to_millis(row.opened_at),
        row.subject
            .as_deref()
            .map(|s| bounded(s, INTENT_SUBJECT_LIMIT)),
        row.baseline
            .as_deref()
            .map(|s| bounded(s, INTENT_SUBJECT_LIMIT)),
        intents::detail_json(&row.detail_json),
    ))?;
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
    let path = |p: Option<&std::path::PathBuf>| p.map(|p| p.to_string_lossy().into_owned());
    // `oversized_json` and not `bounded`: `summary_json` is a JSON column, and `bounded` appends
    // `…`, which turns a document into text that no longer parses. The same defect that was in
    // `change_json` and `owned_paths_json`; one helper covers all three.
    let summary = row
        .summary_json
        .as_deref()
        .map(|s| schema::oversized_json(s, SUMMARY_JSON_LIMIT));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intents::KnownIntentKind;

    /// [`StoreHandle::intent_open`] awaits a oneshot behind an unbounded queue. Without a deadline
    /// a writer that never answers — a wedged filesystem, a thread that died mid-batch — stalls
    /// the caller forever, and the caller is the orchestration loop.
    ///
    /// The receiver here is alive and never read, which is exactly that case: the op is queued and
    /// nothing will ever reply to it. The clock is paused, so the 5 s is virtual and the test is
    /// instant. The outer bound is what makes a revert **fail** rather than hang: strip the
    /// timeout out of `intent_open` and the only timer left is the outer one, so the match below
    /// sees `Err(Elapsed)` instead of `IntentOpenTimeout` and panics.
    #[tokio::test(start_paused = true)]
    async fn intent_open_gives_up_on_a_writer_that_never_answers() {
        let (tx, _rx) = mpsc::channel::<Op>();
        let handle = StoreHandle { tx };
        let row = IntentRow::new("i1", KnownIntentKind::Spawn, SystemTime::UNIX_EPOCH);
        match tokio::time::timeout(INTENT_OPEN_TIMEOUT * 4, handle.intent_open(row)).await {
            Ok(Err(Error::IntentOpenTimeout(waited))) => assert_eq!(waited, INTENT_OPEN_TIMEOUT),
            other => panic!(
                "intent_open must give up rather than wait on a writer that never answers, \
                 got {other:?}"
            ),
        }
    }

    /// Narrowing `unsettled_intents` to exclude live acks did not cost it the partial index.
    ///
    /// `intents_unsettled`'s predicate is `state IN ('open','unknown')` and the query now carries
    /// a second term as well. SQLite may use a partial index whose `WHERE` is implied by the
    /// query's, and the index's term is still a top-level term of the query verbatim — but "may"
    /// is the planner's word, not a guarantee, so this measures it instead of assuming it. The
    /// alternative was a migration rung to narrow the index, which is out of proportion for a
    /// table of a few hundred rows.
    #[test]
    fn the_unsettled_query_still_rides_its_partial_index() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = schema::open_connection(&dir.path().join("t.sqlite")).expect("open");
        let plan: String = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {}", unsettled_intents_sql()))
            .expect("prepare")
            .query_map([], |row| row.get::<_, String>(3))
            .expect("query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("rows")
            .join(" | ");
        assert!(
            plan.contains("intents_unsettled"),
            "the narrowed query fell off its index and now scans: {plan}"
        );
    }

    /// A revision with no reason is refused before it reaches the channel, so nothing downstream
    /// has to decide what an empty required column means.
    #[tokio::test]
    async fn a_revision_with_no_reason_is_refused_rather_than_stored() {
        let (tx, rx) = mpsc::channel::<Op>();
        let handle = StoreHandle { tx };
        for blank in ["", "   ", "\n\t"] {
            let row = PlanRevisionRow::new("r1", "pl1", 1, SystemTime::UNIX_EPOCH, blank);
            match handle.plan_revised(row).await {
                Err(Error::Required { field }) => assert_eq!(field, "plan_revisions.reason"),
                other => panic!("an empty reason must be refused, got {other:?}"),
            }
        }
        assert!(rx.try_recv().is_err(), "nothing was queued for the writer");
    }
}
