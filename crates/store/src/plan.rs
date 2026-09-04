//! The plan, the phases, the unknowns and the work orders — the only thing that remembers.
//!
//! Under `docs/vision.md` §3 the Rust harness owns goal, plan, progress and thread, and model
//! windows are rented per decision and thrown away. **Nothing else in the design remembers
//! anything**, so a store that drifts out of true produces a thread that is confidently wrong for
//! hours. That is why every slug column here is read lossily and restrictively, why every child
//! cascades from its parent, and why every free-text column is bounded.
//!
//! Five tables, all O(phases) and bounded by construction — none is append-only and archival, and
//! none needs a retention sweep:
//!
//! - [`PlanRow`] — one per project per goal-run. The `approved_at` stamp is the envelope the
//!   owner approves once, covering the whole run (`docs/vision.md` §4 step 6).
//! - [`PhaseRow`] — the ordered checklist, each with a definition of done and a real verify
//!   command. `verify_command` is nullable so the loop can *see* a phase that cannot go green
//!   through a gate, rather than inventing one.
//! - [`PlanRevisionRow`] — what brigadier rewrote inside the approved goal, and why
//!   (`docs/vision.md` §8). A revision that moved a definition of done is flagged, because that
//!   one escalates to fusion and then to the owner.
//! - [`UnknownRow`] — §4 step 5's two bins, and the record of what "just go" skipped: *"when a
//!   phase later fails on a question that was waved off, the thread can say which one."*
//! - [`WorkOrderRow`] — per-phase dispatch, holding the worker's **report, not its transcript**
//!   (`docs/vision.md` §4 step 7.3).
//!
//! The plan card of `docs/vision.md` §9 — `> Plan 6 phases . 3 done`, `Phase 3 . API routes`,
//! `3 workers dispatched` — is the read side these serve. The card itself is not built here.
// see docs/plans/phase-4.md, "W1-A — the plan and progress store".

use std::path::PathBuf;
use std::time::SystemTime;

use brigadier_core::event::SessionId;
use rusqlite::Row;

use crate::schema::{from_millis, path_of};

/// Where a plan is. `draft` until the owner approves the envelope.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanStatus {
    /// Being assembled: unknowns outstanding, phases still moving, nothing authorized.
    Draft,
    /// The owner approved the envelope. This is what authorizes autonomous work.
    Approved,
    /// Every phase settled.
    Done,
    /// Given up on, or replaced by another goal-run.
    Abandoned,
}

impl PlanStatus {
    /// The slug stored in `plans.status`.
    pub fn as_slug(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Approved => "approved",
            Self::Done => "done",
            Self::Abandoned => "abandoned",
        }
    }

    /// Parse a slug; `None` for anything outside the closed set.
    pub fn from_slug(s: &str) -> Option<Self> {
        match s {
            "draft" => Some(Self::Draft),
            "approved" => Some(Self::Approved),
            "done" => Some(Self::Done),
            "abandoned" => Some(Self::Abandoned),
            _ => None,
        }
    }

    /// Parse a slug, falling back to [`PlanStatus::Draft`].
    ///
    /// The restrictive reading. `approved` is the envelope that authorizes autonomous work and
    /// must never be reached by a slug this build cannot read; a plan that reads `draft` asks the
    /// owner again, which costs one click.
    pub fn from_slug_lossy(s: &str) -> Self {
        Self::from_slug(s).unwrap_or(Self::Draft)
    }
}

/// Where one phase is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhaseState {
    /// Not started.
    Pending,
    /// A lead call dispatched work for it.
    Running,
    /// The verify command exited 0. Merged, committed, done.
    Green,
    /// Red gate, an `unknown` intent, or a question nobody answered. Needs a decision.
    Blocked,
}

impl PhaseState {
    /// The slug stored in `phases.state`.
    pub fn as_slug(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Green => "green",
            Self::Blocked => "blocked",
        }
    }

    /// Parse a slug; `None` for anything outside the closed set.
    pub fn from_slug(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "running" => Some(Self::Running),
            "green" => Some(Self::Green),
            "blocked" => Some(Self::Blocked),
            _ => None,
        }
    }

    /// Parse a slug, falling back to [`PhaseState::Blocked`].
    ///
    /// The restrictive reading, and neither obvious neighbour. Not `green`, which would let the
    /// loop skip a phase that never passed a gate; not `pending`, which would authorize a repeat
    /// of work that may already have run. `blocked` stops and asks.
    pub fn from_slug_lossy(s: &str) -> Self {
        Self::from_slug(s).unwrap_or(Self::Blocked)
    }
}

/// Which bin an unknown was sorted into (`docs/vision.md` §4 step 5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnknownBin {
    /// Only the user can answer: one question at a time, as a real choice.
    Owner,
    /// The internet can answer: a research subagent, findings to a file.
    Research,
}

impl UnknownBin {
    /// The slug stored in `unknowns.bin`.
    pub fn as_slug(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Research => "research",
        }
    }

    /// Parse a slug; `None` for anything outside the closed set.
    pub fn from_slug(s: &str) -> Option<Self> {
        match s {
            "owner" => Some(Self::Owner),
            "research" => Some(Self::Research),
            _ => None,
        }
    }

    /// Parse a slug, falling back to [`UnknownBin::Owner`].
    ///
    /// The restrictive reading: a question routed to the owner costs a prompt, one routed to a
    /// research subagent by mistake costs a model window and an answer nobody asked for.
    pub fn from_slug_lossy(s: &str) -> Self {
        Self::from_slug(s).unwrap_or(Self::Owner)
    }
}

/// Whether an unknown still owes an answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnknownState {
    /// Still owed an answer.
    Open,
    /// Answered, by the owner or by research.
    Answered,
    /// Waved off. See [`UnknownRow::skipped_for_just_go`] for whether "just go" did it.
    Skipped,
}

impl UnknownState {
    /// The slug stored in `unknowns.state`.
    pub fn as_slug(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Answered => "answered",
            Self::Skipped => "skipped",
        }
    }

    /// Parse a slug; `None` for anything outside the closed set.
    pub fn from_slug(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Self::Open),
            "answered" => Some(Self::Answered),
            "skipped" => Some(Self::Skipped),
            _ => None,
        }
    }

    /// Parse a slug, falling back to [`UnknownState::Open`].
    ///
    /// The restrictive reading: still owed an answer. Reading it as `answered` would let the plan
    /// go final on a question nobody resolved, which is the failure §4 step 5 exists to prevent.
    pub fn from_slug_lossy(s: &str) -> Self {
        Self::from_slug(s).unwrap_or(Self::Open)
    }
}

/// Where one dispatched work order is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkOrderState {
    /// Written down, not yet handed to a child.
    Pending,
    /// A child is running it in its own worktree.
    Dispatched,
    /// The worker returned a report.
    Reported,
    /// The worker died, or its order was abandoned.
    Failed,
    /// We cannot tell. Also the reading of a slug this build does not know.
    Unknown,
}

impl WorkOrderState {
    /// The slug stored in `work_orders.state`.
    pub fn as_slug(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Dispatched => "dispatched",
            Self::Reported => "reported",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
        }
    }

    /// Parse a slug; `None` for anything outside the closed set.
    pub fn from_slug(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "dispatched" => Some(Self::Dispatched),
            "reported" => Some(Self::Reported),
            "failed" => Some(Self::Failed),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }

    /// Parse a slug, falling back to [`WorkOrderState::Unknown`].
    ///
    /// The restrictive reading, for the same reason [`crate::IntentState`] takes it: `pending`
    /// would authorize re-dispatching an order that may already have written files, and
    /// `reported` would let the loop consume a report that does not exist.
    pub fn from_slug_lossy(s: &str) -> Self {
        Self::from_slug(s).unwrap_or(Self::Unknown)
    }
}

/// One goal-run's plan. One per project at a time; the newest is the live one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanRow {
    /// Stable plan id, chosen by the caller.
    pub id: String,
    /// Owning project. `ON DELETE CASCADE`: removing a project removes its plans and everything
    /// under them.
    pub project_id: String,
    /// The owner's stated intent, verbatim (`docs/vision.md` §4 step 3).
    pub goal: String,
    /// Where the plan is. Moved by [`crate::StoreHandle::plan_approved`], not by an upsert.
    pub status: PlanStatus,
    /// How many times the plan has been revised inside the approved goal. Bumped by
    /// [`crate::StoreHandle::plan_revised`], which writes the matching [`PlanRevisionRow`].
    pub revision: u32,
    /// When the plan was first written.
    pub created_at: SystemTime,
    /// When the owner approved the envelope, if they have.
    pub approved_at: Option<SystemTime>,
}

impl PlanRow {
    /// A fresh draft: revision 0, unapproved.
    pub fn new(
        id: impl Into<String>,
        project_id: impl Into<String>,
        goal: impl Into<String>,
        created_at: SystemTime,
    ) -> Self {
        Self {
            id: id.into(),
            project_id: project_id.into(),
            goal: goal.into(),
            status: PlanStatus::Draft,
            revision: 0,
            created_at,
            approved_at: None,
        }
    }
}

/// One phase of the checklist.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PhaseRow {
    /// Stable phase id, chosen by the caller.
    pub id: String,
    /// Owning plan, `ON DELETE CASCADE`.
    pub plan_id: String,
    /// Position in the checklist. Unique within the plan.
    pub ordinal: u32,
    /// The one-line name the plan card shows.
    pub title: String,
    /// What "done" means for this phase, in the owner's terms.
    pub definition_of_done: String,
    /// The real command whose exit code is the gate.
    ///
    /// Nullable, and it must be: a phase with no verify command **cannot go green through a
    /// gate**, and the loop has to be able to see that rather than fabricate a command or treat
    /// the absence as a pass.
    pub verify_command: Option<String>,
    /// Where the phase is. Moved by [`crate::StoreHandle::phase_attempt_started`] and
    /// [`crate::StoreHandle::phase_settled`], not by an upsert.
    pub state: PhaseState,
    /// How many times the phase has been attempted.
    pub attempts: u32,
    /// When the first attempt started.
    pub started_at: Option<SystemTime>,
    /// When it settled.
    pub ended_at: Option<SystemTime>,
    /// The commit this phase's work branches **from**, captured when the phase starts.
    ///
    /// Stored rather than recomputed, and that is the point: `worktree::prepare` branches from the
    /// constant `HEAD`, so once the loop commits per phase, two orders dispatched either side of a
    /// phase commit would branch from different bases and the merge would be against two different
    /// bases. `None` for a phase that predates the column, or one nothing has started yet — never
    /// today's `HEAD` standing in for a base nobody recorded.
    ///
    /// **Write-once.** [`crate::StoreHandle::upsert_phase`] takes the stored value in preference
    /// to the incoming one, so the first sha that becomes knowable is the phase's base for good: a
    /// later upsert can neither clear it nor move it. A base that can move is the bug the column
    /// exists to prevent, not a lesser version of it.
    // see docs/plans/w1b-loop-order.md §1 D7 — "resolve the base once per phase, store it, pass it
    // explicitly", and docs/research/orchestration-loop.md work item B4.
    pub base_sha: Option<String>,
    /// The commit the green gate produced.
    pub commit_sha: Option<String>,
    /// The verify command's last exit code. `0` is the only value that means green.
    pub last_exit_code: Option<i32>,
    /// A bounded excerpt of what the gate said. Never the whole output — that goes to a worker's
    /// window, never into the thread (`docs/vision.md` §4 step 7.5).
    pub last_evidence: Option<String>,
}

impl PhaseRow {
    /// A pending phase: no attempts, no gate result.
    pub fn new(
        id: impl Into<String>,
        plan_id: impl Into<String>,
        ordinal: u32,
        title: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            plan_id: plan_id.into(),
            ordinal,
            title: title.into(),
            definition_of_done: String::new(),
            verify_command: None,
            state: PhaseState::Pending,
            attempts: 0,
            started_at: None,
            ended_at: None,
            base_sha: None,
            commit_sha: None,
            last_exit_code: None,
            last_evidence: None,
        }
    }
}

/// One re-planning event: what changed inside the approved goal, and why.
// see docs/vision.md §8 — "brigadier may rewrite, add or drop phases inside the goal the owner
// approved, recording what changed and why."
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanRevisionRow {
    /// Stable revision-record id, chosen by the caller.
    pub id: String,
    /// Owning plan, `ON DELETE CASCADE`.
    pub plan_id: String,
    /// The revision number this record explains. Unique within the plan.
    pub revision: u32,
    /// When it happened.
    pub at: SystemTime,
    /// Why, in the harness's own words. Required: a revision with no reason is the thing this
    /// table exists to prevent.
    pub reason: String,
    /// What changed, as bounded JSON text.
    pub change_json: String,
    /// Whether the revision moved a **definition of done**.
    ///
    /// Recorded separately because that one escalates: `docs/vision.md` §8 sends it to fusion and,
    /// on disagreement, to the owner. The failure being guarded against is *agents declaring done
    /// prematurely*, so a silent edit to what "done" means is exactly the move to flag.
    pub moved_definition_of_done: bool,
}

impl PlanRevisionRow {
    /// A revision record that changed no definition of done.
    pub fn new(
        id: impl Into<String>,
        plan_id: impl Into<String>,
        revision: u32,
        at: SystemTime,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            plan_id: plan_id.into(),
            revision,
            at,
            reason: reason.into(),
            change_json: "{}".to_owned(),
            moved_definition_of_done: false,
        }
    }
}

/// One thing brigadier did not know, and what became of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnknownRow {
    /// Stable id, chosen by the caller.
    pub id: String,
    /// Owning plan, `ON DELETE CASCADE`.
    pub plan_id: String,
    /// Which bin it was sorted into.
    pub bin: UnknownBin,
    /// The question, as it was asked.
    pub question: String,
    /// Whether it still owes an answer. Moved by [`crate::StoreHandle::unknown_settled`].
    pub state: UnknownState,
    /// The answer, bounded. `None` while open, and `None` for a research unknown whose findings
    /// went to a file.
    pub answer: Option<String>,
    /// Where a research subagent's findings were written. Findings go to a file, not into the
    /// store.
    pub findings_path: Option<PathBuf>,
    /// When it was asked.
    pub asked_at: SystemTime,
    /// When it was answered or waved off.
    pub settled_at: Option<SystemTime>,
    /// Whether the owner's "just go" is what skipped it.
    ///
    /// The reason this table exists. `docs/vision.md` §4 step 5: *"'Just go' is always one click
    /// away, and skipping is recorded — when a phase later fails on a question that was waved
    /// off, the thread can say which one."*
    pub skipped_for_just_go: bool,
}

impl UnknownRow {
    /// An open question, unanswered.
    pub fn new(
        id: impl Into<String>,
        plan_id: impl Into<String>,
        bin: UnknownBin,
        question: impl Into<String>,
        asked_at: SystemTime,
    ) -> Self {
        Self {
            id: id.into(),
            plan_id: plan_id.into(),
            bin,
            question: question.into(),
            state: UnknownState::Open,
            answer: None,
            findings_path: None,
            asked_at,
            settled_at: None,
            skipped_for_just_go: false,
        }
    }
}

/// One work order dispatched for a phase.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkOrderRow {
    /// Stable id, chosen by the caller.
    pub id: String,
    /// Owning phase, `ON DELETE CASCADE`.
    pub phase_id: String,
    /// The session that ran it, while one exists.
    ///
    /// `ON DELETE SET NULL`, deliberately, and **not** `CASCADE`: `docs/vision.md` §8 says
    /// deleting a session removes its rows, its feed log and its worktree because "only the
    /// narration goes" — the work is in the repository. The plan is the durable thing, so the
    /// record that an order was dispatched, with its report, must outlive the session that ran
    /// it. Cascading here would delete the plan's own history as a side effect of pruning a
    /// session from the sidebar.
    pub session_id: Option<SessionId>,
    /// The one-line name the plan card shows.
    pub title: String,
    /// The paths this order owns, as bounded JSON text. Disjoint ownership is what stops two
    /// workers writing the same file (`docs/vision.md` §4 step 7.2).
    pub owned_paths_json: String,
    /// Where the order is. Moved by [`crate::StoreHandle::work_order_finished`].
    pub state: WorkOrderState,
    /// The worktree the worker runs in.
    pub worktree_path: Option<PathBuf>,
    /// The branch checked out there.
    pub branch: Option<String>,
    /// When the child was started for it.
    pub dispatched_at: Option<SystemTime>,
    /// When the worker finished or died.
    pub finished_at: Option<SystemTime>,
    /// The worker's **report**, bounded. Workers return reports, not transcripts
    /// (`docs/vision.md` §4 step 7.3); the transcript is the provider's own file.
    pub report: Option<String>,
}

impl WorkOrderRow {
    /// An order written down but not yet dispatched.
    pub fn new(
        id: impl Into<String>,
        phase_id: impl Into<String>,
        title: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            phase_id: phase_id.into(),
            session_id: None,
            title: title.into(),
            owned_paths_json: "[]".to_owned(),
            state: WorkOrderState::Pending,
            worktree_path: None,
            branch: None,
            dispatched_at: None,
            finished_at: None,
            report: None,
        }
    }
}

/// Column list shared by every `plans` read.
pub(crate) const PLAN_COLUMNS: &str =
    "id, project_id, goal, status, revision, created_at, approved_at";

pub(crate) fn plan_from_row(row: &Row<'_>) -> rusqlite::Result<PlanRow> {
    Ok(PlanRow {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        goal: row.get("goal")?,
        // Lossy on purpose: a slug this build does not know reads back as `Draft`, never as
        // `Approved`, which is the envelope that authorizes autonomous work.
        status: PlanStatus::from_slug_lossy(&row.get::<_, String>("status")?),
        revision: row.get("revision")?,
        created_at: from_millis(row.get("created_at")?),
        approved_at: row.get::<_, Option<i64>>("approved_at")?.map(from_millis),
    })
}

/// Column list shared by every `phases` read.
pub(crate) const PHASE_COLUMNS: &str = "id, plan_id, ordinal, title, definition_of_done, \
     verify_command, state, attempts, started_at, ended_at, base_sha, commit_sha, last_exit_code, \
     last_evidence";

pub(crate) fn phase_from_row(row: &Row<'_>) -> rusqlite::Result<PhaseRow> {
    Ok(PhaseRow {
        id: row.get("id")?,
        plan_id: row.get("plan_id")?,
        ordinal: row.get("ordinal")?,
        title: row.get("title")?,
        definition_of_done: row.get("definition_of_done")?,
        verify_command: row.get("verify_command")?,
        // Lossy on purpose: an unknown slug reads `Blocked`, never `Green` (which would let the
        // loop skip a phase that never passed) and never `Pending` (which would repeat it).
        state: PhaseState::from_slug_lossy(&row.get::<_, String>("state")?),
        attempts: row.get("attempts")?,
        started_at: row.get::<_, Option<i64>>("started_at")?.map(from_millis),
        ended_at: row.get::<_, Option<i64>>("ended_at")?.map(from_millis),
        base_sha: row.get("base_sha")?,
        commit_sha: row.get("commit_sha")?,
        last_exit_code: row.get("last_exit_code")?,
        last_evidence: row.get("last_evidence")?,
    })
}

/// Column list shared by every `plan_revisions` read.
pub(crate) const PLAN_REVISION_COLUMNS: &str =
    "id, plan_id, revision, at, reason, change_json, moved_definition_of_done";

pub(crate) fn plan_revision_from_row(row: &Row<'_>) -> rusqlite::Result<PlanRevisionRow> {
    Ok(PlanRevisionRow {
        id: row.get("id")?,
        plan_id: row.get("plan_id")?,
        revision: row.get("revision")?,
        at: from_millis(row.get("at")?),
        reason: row.get("reason")?,
        change_json: row.get("change_json")?,
        moved_definition_of_done: row.get::<_, i64>("moved_definition_of_done")? != 0,
    })
}

/// Column list shared by every `unknowns` read.
pub(crate) const UNKNOWN_COLUMNS: &str = "id, plan_id, bin, question, state, answer, \
     findings_path, asked_at, settled_at, skipped_for_just_go";

pub(crate) fn unknown_from_row(row: &Row<'_>) -> rusqlite::Result<UnknownRow> {
    Ok(UnknownRow {
        id: row.get("id")?,
        plan_id: row.get("plan_id")?,
        // Lossy on purpose: an unknown bin reads `Owner`, the one that asks rather than spends.
        bin: UnknownBin::from_slug_lossy(&row.get::<_, String>("bin")?),
        question: row.get("question")?,
        // Lossy on purpose: an unknown slug reads `Open` — still owed an answer.
        state: UnknownState::from_slug_lossy(&row.get::<_, String>("state")?),
        answer: row.get("answer")?,
        findings_path: path_of(row, "findings_path")?,
        asked_at: from_millis(row.get("asked_at")?),
        settled_at: row.get::<_, Option<i64>>("settled_at")?.map(from_millis),
        skipped_for_just_go: row.get::<_, i64>("skipped_for_just_go")? != 0,
    })
}

/// Column list shared by every `work_orders` read.
pub(crate) const WORK_ORDER_COLUMNS: &str = "id, phase_id, session_id, title, owned_paths_json, \
     state, worktree_path, branch, dispatched_at, finished_at, report";

pub(crate) fn work_order_from_row(row: &Row<'_>) -> rusqlite::Result<WorkOrderRow> {
    Ok(WorkOrderRow {
        id: row.get("id")?,
        phase_id: row.get("phase_id")?,
        session_id: row.get::<_, Option<String>>("session_id")?.map(SessionId::new),
        title: row.get("title")?,
        owned_paths_json: row.get("owned_paths_json")?,
        // Lossy on purpose: an unknown slug reads `Unknown`, never `Pending` (a repeat) and never
        // `Reported` (a report that does not exist).
        state: WorkOrderState::from_slug_lossy(&row.get::<_, String>("state")?),
        worktree_path: path_of(row, "worktree_path")?,
        branch: row.get("branch")?,
        dispatched_at: row.get::<_, Option<i64>>("dispatched_at")?.map(from_millis),
        finished_at: row.get::<_, Option<i64>>("finished_at")?.map(from_millis),
        report: row.get("report")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::open_connection;
    use rusqlite::Connection;

    /// A plan, one phase and one work order, as a build that knew different slugs wrote them.
    fn seed(conn: &Connection, plan_status: &str, phase_state: &str, order_state: &str) {
        conn.execute(
            "INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'x', '/r', 0)",
            [],
        )
        .expect("project");
        conn.execute("INSERT INTO sessions(id, project_id) VALUES ('s1', 'p1')", [])
            .expect("session");
        conn.execute(
            "INSERT INTO plans(id, project_id, goal, status, revision, created_at)
             VALUES ('pl1', 'p1', 'ship it', ?1, 0, 1)",
            (plan_status,),
        )
        .expect("plan");
        conn.execute(
            "INSERT INTO phases(id, plan_id, ordinal, title, state)
             VALUES ('ph1', 'pl1', 0, 'schema', ?1)",
            (phase_state,),
        )
        .expect("phase");
        conn.execute(
            "INSERT INTO work_orders(id, phase_id, session_id, title, state)
             VALUES ('wo1', 'ph1', 's1', 'write the schema', ?1)",
            (order_state,),
        )
        .expect("work order");
    }

    fn open(dir: &tempfile::TempDir) -> Connection {
        open_connection(&dir.path().join("t.sqlite")).expect("open")
    }

    /// `approved` is the envelope that authorizes autonomous work, so a slug this build cannot
    /// read must never reach it. The restrictive reading is `draft`, which asks the owner again.
    #[test]
    fn an_unknown_plan_status_reads_back_draft_never_approved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open(&dir);
        seed(&conn, "provisionally_approved", "pending", "pending");
        let sql = format!("SELECT {PLAN_COLUMNS} FROM plans WHERE id = 'pl1'");
        let row = conn.query_row(&sql, [], plan_from_row).expect("read");
        assert_eq!(row.status, PlanStatus::Draft);
        assert_ne!(row.status, PlanStatus::Approved);
        assert_eq!(row.goal, "ship it", "nothing else about the row moves");
    }

    /// Not `green`, which would let the loop skip a phase that never passed a gate, and not
    /// `pending`, which would authorize a repeat. `blocked` stops and asks.
    #[test]
    fn an_unknown_phase_state_reads_back_blocked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open(&dir);
        seed(&conn, "draft", "amber", "pending");
        let sql = format!("SELECT {PHASE_COLUMNS} FROM phases WHERE id = 'ph1'");
        let row = conn.query_row(&sql, [], phase_from_row).expect("read");
        assert_eq!(row.state, PhaseState::Blocked);
        assert_ne!(row.state, PhaseState::Green);
        assert_ne!(row.state, PhaseState::Pending);
        assert_eq!(row.title, "schema");
    }

    /// Still owed an answer. Reading an unrecognised slug as `answered` would let the plan go
    /// final on a question nobody resolved.
    #[test]
    fn an_unknown_unknown_state_reads_back_open() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open(&dir);
        seed(&conn, "draft", "pending", "pending");
        conn.execute(
            "INSERT INTO unknowns(id, plan_id, bin, question, state, asked_at)
             VALUES ('u1', 'pl1', 'fusion', 'who posts jobs?', 'deferred', 5)",
            [],
        )
        .expect("unknown");
        let sql = format!("SELECT {UNKNOWN_COLUMNS} FROM unknowns WHERE id = 'u1'");
        let row = conn.query_row(&sql, [], unknown_from_row).expect("read");
        assert_eq!(row.state, UnknownState::Open);
        assert_ne!(row.state, UnknownState::Answered);
        // And the bin's own lossy read, which is the one that asks rather than spends.
        assert_eq!(row.bin, UnknownBin::Owner);
        assert!(!row.skipped_for_just_go);
    }

    /// Not `pending`, which would re-dispatch an order that may already have written files, and
    /// not `reported`, which would let the loop consume a report that does not exist.
    #[test]
    fn an_unknown_work_order_state_reads_back_unknown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open(&dir);
        seed(&conn, "draft", "pending", "merged");
        let sql = format!("SELECT {WORK_ORDER_COLUMNS} FROM work_orders WHERE id = 'wo1'");
        let row = conn.query_row(&sql, [], work_order_from_row).expect("read");
        assert_eq!(row.state, WorkOrderState::Unknown);
        assert_ne!(row.state, WorkOrderState::Pending);
        assert_ne!(row.state, WorkOrderState::Reported);
    }

    /// Every child cascades from its parent — except `work_orders.session_id`, which is
    /// `SET NULL` so that deleting a session takes its narration and leaves the plan's record
    /// that an order was dispatched.
    #[test]
    fn deleting_a_session_nulls_a_work_order_and_deleting_a_project_takes_the_plan() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open(&dir);
        seed(&conn, "approved", "green", "reported");
        conn.execute(
            "INSERT INTO plan_revisions(id, plan_id, revision, at, reason)
             VALUES ('r1', 'pl1', 1, 9, 'split phase 2')",
            [],
        )
        .expect("revision");
        conn.execute(
            "INSERT INTO unknowns(id, plan_id, bin, question, state, asked_at)
             VALUES ('u1', 'pl1', 'owner', 'payments now?', 'open', 5)",
            [],
        )
        .expect("unknown");

        let count = |table: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .expect("count")
        };

        conn.execute("DELETE FROM sessions WHERE id = 's1'", []).expect("delete session");
        assert_eq!(count("work_orders"), 1, "the order survives the session that ran it");
        let sql = format!("SELECT {WORK_ORDER_COLUMNS} FROM work_orders WHERE id = 'wo1'");
        let row = conn.query_row(&sql, [], work_order_from_row).expect("read");
        assert_eq!(row.session_id, None, "only the pointer at the narration is cleared");
        assert_eq!(row.state, WorkOrderState::Reported, "and the report is still attributed");

        conn.execute("DELETE FROM projects WHERE id = 'p1'", []).expect("delete project");
        for table in ["plans", "phases", "work_orders", "plan_revisions", "unknowns"] {
            assert_eq!(count(table), 0, "{table} did not cascade from the project");
        }
    }

    /// One phase per ordinal, enforced by the database rather than by the caller's care.
    #[test]
    fn two_phases_cannot_share_an_ordinal_in_one_plan() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open(&dir);
        seed(&conn, "draft", "pending", "pending");
        let clash = conn.execute(
            "INSERT INTO phases(id, plan_id, ordinal, title) VALUES ('ph2', 'pl1', 0, 'again')",
            [],
        );
        assert!(clash.is_err(), "UNIQUE(plan_id, ordinal) must refuse the second row");
    }

    /// Every slug column's lossy read is the restrictive one, pinned as a unit assertion beside
    /// the round-trip tests that pin it through SQLite.
    #[test]
    fn every_lossy_read_is_the_restrictive_one() {
        assert_eq!(PlanStatus::from_slug_lossy("shipped"), PlanStatus::Draft);
        assert_eq!(PhaseState::from_slug_lossy("amber"), PhaseState::Blocked);
        assert_eq!(UnknownBin::from_slug_lossy("fusion"), UnknownBin::Owner);
        assert_eq!(UnknownState::from_slug_lossy("deferred"), UnknownState::Open);
        assert_eq!(WorkOrderState::from_slug_lossy("merged"), WorkOrderState::Unknown);
    }

    /// Round-trip every slug this build writes, so a rename cannot pass unnoticed.
    #[test]
    fn every_slug_round_trips() {
        for s in [PlanStatus::Draft, PlanStatus::Approved, PlanStatus::Done, PlanStatus::Abandoned]
        {
            assert_eq!(PlanStatus::from_slug(s.as_slug()), Some(s));
        }
        for s in [PhaseState::Pending, PhaseState::Running, PhaseState::Green, PhaseState::Blocked]
        {
            assert_eq!(PhaseState::from_slug(s.as_slug()), Some(s));
        }
        for s in [UnknownBin::Owner, UnknownBin::Research] {
            assert_eq!(UnknownBin::from_slug(s.as_slug()), Some(s));
        }
        for s in [UnknownState::Open, UnknownState::Answered, UnknownState::Skipped] {
            assert_eq!(UnknownState::from_slug(s.as_slug()), Some(s));
        }
        for s in [
            WorkOrderState::Pending,
            WorkOrderState::Dispatched,
            WorkOrderState::Reported,
            WorkOrderState::Failed,
            WorkOrderState::Unknown,
        ] {
            assert_eq!(WorkOrderState::from_slug(s.as_slug()), Some(s));
        }
    }
}
