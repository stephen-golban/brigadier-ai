//! `intents` — the row the harness commits *before* it causes an effect, and what settles it.
//!
//! One row per effectful step, written and **committed** before the effect is attempted and
//! closed after it. [`IntentState`] is three-valued on settlement — `done`, `not_done`,
//! `unknown` — never two-valued, because "we cannot tell" must not be spelled as "not done":
//! that is what makes a fresh context repeat a commit that already landed.
//!
//! The asymmetry is the whole design. Record-before-effect can only ever *over*-report, and
//! over-reporting is recoverable by reading the world; effect-before-record under-reports, and
//! nothing recovers that.
//!
//! **The barrier is [`crate::StoreHandle::intent_open`] itself.** It returns only once the row
//! is committed, and every failure — the insert's and the commit's alike — comes back as `Err`,
//! so a caller that acts on `Ok(())` is acting on a row that is on disk. The store enforces the
//! barrier; the caller cannot forget to take it, and no `flush()` is needed. That is a change
//! from `docs/research/intent-records.md` §2.3, which still describes (B) open and (C) flush as
//! two steps: `flush()` reports that the *batch* committed and not that the row inserted, so a
//! failed insert was logged, skipped, and answered `Ok(())`.
//!
//! The reconciler that reads these rows is **not in this crate**: it needs `git` subprocesses and
//! lives in `crates/supervisor/`. This module is only what it reads and writes.
//!
//! **For whoever writes that reconciler:** when it surfaces an `unknown` row as a feed row, the
//! row's `seq` must be `sessions.last_event_seq + 1`, never 0 or 1. `feed`'s insert is
//! `ON CONFLICT(session_id, seq) DO UPDATE` (`writer.rs`), so numbering from zero silently
//! rewrites a session's oldest rows rather than erroring. `crates/store/src/lib.rs`'s
//! `a_resumed_sessions_rows_land_after_the_old_ones_and_leave_them_untouched` demonstrates the
//! collision deliberately.
// see docs/research/intent-records.md — §2.1 the DDL, §2.2 the ops, §2.3 the lifecycle,
// §4.3 kind → postcondition, §6 retention, and the 2026-09-04 amendment at the foot of the file.

use std::time::{Duration, SystemTime};

use brigadier_core::event::{bounded, SessionId};
use rusqlite::{Connection, Row};

use crate::schema::{from_millis, to_millis, INTENT_DETAIL_LIMIT, INTENT_EVIDENCE_LIMIT};
use crate::Result;

/// How long a settled intent is kept before the sweep at `Store::open` removes it.
///
/// `unknown` rows are **never** swept: they are few, they are the ones a human still owes an
/// answer to, and sweeping one would delete the only record that something may have happened.
// see docs/research/intent-records.md §6.
pub const INTENT_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// How long [`crate::StoreHandle::intent_open`] waits for its commit before giving up.
///
/// **An assumption, not a measurement.** 5 s is twenty times the default 250 ms batch window and
/// far past any commit this store makes, so it fires only when the writer is genuinely stuck — a
/// wedged filesystem, a thread that died mid-batch. The value it protects is the orchestration
/// loop: without a deadline the loop awaits a oneshot behind an unbounded queue and stalls
/// forever, with no error and nothing to surface.
///
/// A timeout is **not** evidence that the row was not written. It is the caller's cue to stop, not
/// to retry: see [`crate::Error::IntentOpenTimeout`].
pub const INTENT_OPEN_TIMEOUT: Duration = Duration::from_secs(5);

/// Which effect an intent row records, as the slug stored in `intents.kind`.
///
/// **A pass-through slug, not a closed set.** A row written by a build that knows a kind this one
/// does not keeps its slug rather than collapsing to a placeholder, so an older reader stays
/// honest about what it is looking at and a newer build can still read it. [`IntentKind::known`]
/// is the typed view of the set this build understands.
///
/// Pass-through on *read* only. A close on a kind this build cannot name settles
/// [`IntentState::Unknown`] — see `hold_to_settleable` — because a settleable set we cannot look
/// up is not one we can enforce, and `IntentKind::new("work_oder")` must not be able to do what
/// `work_order` is forbidden from doing.
// see docs/research/intent-records.md §5 — `kind` is a pass-through slug on the wire for the same
// reason `permission_mode` is, and the opposite of `mcp`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct IntentKind(String);

impl IntentKind {
    /// Wrap a slug, whatever it is.
    pub fn new(slug: impl Into<String>) -> Self {
        Self(slug.into())
    }

    /// The stored slug, verbatim.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The typed reading, or `None` when this build does not know the slug.
    pub fn known(&self) -> Option<KnownIntentKind> {
        KnownIntentKind::from_slug(&self.0)
    }
}

impl std::fmt::Display for IntentKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<KnownIntentKind> for IntentKind {
    fn from(kind: KnownIntentKind) -> Self {
        Self(kind.as_slug().to_owned())
    }
}

/// The intent kinds this build knows how to reconcile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum KnownIntentKind {
    /// `worktree::prepare` — a checkout on disk and a branch ref.
    WorktreeAdd,
    /// `worktree::remove` — a checkout deleted, ignored files included.
    WorktreeRemove,
    /// One dispatched work order, measured coarsely against its worktree.
    WorkOrder,
    /// The commit that closes a phase.
    PhaseCommit,
    /// Landing a phase branch on its base.
    MergeToBase,
    /// An approval decision written to a child's stdin.
    ToolPermission,
    /// A supervised child process.
    Spawn,
}

impl KnownIntentKind {
    /// The slug stored in `intents.kind`.
    pub fn as_slug(self) -> &'static str {
        match self {
            Self::WorktreeAdd => "worktree_add",
            Self::WorktreeRemove => "worktree_remove",
            Self::WorkOrder => "work_order",
            Self::PhaseCommit => "phase_commit",
            Self::MergeToBase => "merge_to_base",
            Self::ToolPermission => "tool_permission",
            Self::Spawn => "spawn",
        }
    }

    /// Parse a slug; `None` for anything this build does not know.
    pub fn from_slug(s: &str) -> Option<Self> {
        match s {
            "worktree_add" => Some(Self::WorktreeAdd),
            "worktree_remove" => Some(Self::WorktreeRemove),
            "work_order" => Some(Self::WorkOrder),
            "phase_commit" => Some(Self::PhaseCommit),
            "merge_to_base" => Some(Self::MergeToBase),
            "tool_permission" => Some(Self::ToolPermission),
            "spawn" => Some(Self::Spawn),
            _ => None,
        }
    }

    /// The settled states this kind's postcondition is allowed to write.
    ///
    /// Three entries are narrower than the full set, and each narrowing is a decision:
    ///
    /// - [`KnownIntentKind::WorkOrder`] may settle **only** `unknown`. Owner decision
    ///   2026-09-04: `rev-list --count baseline..BR` plus a dirty count is not a sufficient test
    ///   for "nothing happened" — a worker that ran `npm install`, wrote above the worktree root,
    ///   or made and reverted its own changes leaves both at baseline and would read `not_done`,
    ///   which authorizes re-dispatching an order that already had effects. The accepted cost is
    ///   a re-dispatch we could otherwise have made safely.
    /// - [`KnownIntentKind::MergeToBase`] never reads `not_done`: "not merged" has no sound test.
    ///   `git cherry` reports three `+` for three commits squashed into one upstream commit, and
    ///   `-` for work applied and then reverted (**measured**, `worktree-cleanup.md` §2.2, §2.4).
    ///   `rev-list --count base..branch == 0` proves nothing to lose; non-zero proves nothing.
    /// - [`KnownIntentKind::ToolPermission`] has no postcondition at all: the frame went down a
    ///   pipe to a process that no longer exists. `done` comes only from a stored ack.
    ///
    /// **Enforced at the write, not merely documented.** A close whose state is outside this set
    /// is downgraded to [`IntentState::Unknown`] and the downgrade is recorded in `evidence`; see
    /// `hold_to_settleable`, which `IntentClose` calls inside its own transaction. A convention
    /// that is not enforced gets violated, and the operator command that settles an intent takes
    /// `"done" | "not_done"` straight from a human clicking a button.
    // see docs/research/intent-records.md §4.3 and the 2026-09-04 amendment.
    pub fn settleable(self) -> &'static [IntentState] {
        use IntentState::{Done, NotDone, Unknown};
        match self {
            Self::WorkOrder => &[Unknown],
            Self::MergeToBase | Self::ToolPermission => &[Done, Unknown],
            Self::WorktreeAdd | Self::WorktreeRemove | Self::PhaseCommit | Self::Spawn => {
                &[Done, NotDone, Unknown]
            }
        }
    }
}

/// Where an intent is: open, or one of the three answers reconciliation writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentState {
    /// Written before the effect; nothing has settled it.
    Open,
    /// The postcondition holds. The loop treats the step as taken.
    Done,
    /// The postcondition provably does not hold. The only value the loop may act on.
    NotDone,
    /// We cannot tell. **Never retried**, surfaced instead.
    Unknown,
    /// Reserved, and in practice unreachable: the FK cascade already removed a row whose session
    /// or project was deleted. Named in the set so a later build need not migrate to add it.
    Superseded,
}

impl IntentState {
    /// The slug stored in `intents.state`.
    pub fn as_slug(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Done => "done",
            Self::NotDone => "not_done",
            Self::Unknown => "unknown",
            Self::Superseded => "superseded",
        }
    }

    /// Parse a slug; `None` for anything outside the closed set.
    pub fn from_slug(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Self::Open),
            "done" => Some(Self::Done),
            "not_done" => Some(Self::NotDone),
            "unknown" => Some(Self::Unknown),
            "superseded" => Some(Self::Superseded),
            _ => None,
        }
    }

    /// Parse a slug, falling back to [`IntentState::Unknown`].
    ///
    /// The lossy read is deliberately the **restrictive** one. A slug this build does not know
    /// must not read back as `done`, which would authorize the loop to treat an effect as taken,
    /// nor as `not_done`, which would authorize a repeat. `unknown` is never retried and is
    /// surfaced to a human, which is the only safe reading of a value we cannot interpret.
    // see `McpPolicy::from_slug_lossy` for the pattern, and docs/research/intent-records.md §2.1.
    pub fn from_slug_lossy(s: &str) -> Self {
        Self::from_slug(s).unwrap_or(Self::Unknown)
    }

    /// Whether this is a settled state the retention sweep is allowed to delete.
    pub fn is_sweepable(self) -> bool {
        matches!(self, Self::Done | Self::NotDone)
    }
}

/// How an intent's state came to be set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentOutcome {
    /// The effect's own code path closed the row while the process was still alive.
    Acked,
    /// A postcondition read the world after a restart.
    Reconciled,
    /// A human looked at the diff and said.
    Operator,
}

impl IntentOutcome {
    /// The slug stored in `intents.outcome`.
    pub fn as_slug(self) -> &'static str {
        match self {
            Self::Acked => "acked",
            Self::Reconciled => "reconciled",
            Self::Operator => "operator",
        }
    }

    /// Parse a slug; `None` for anything outside the closed set.
    ///
    /// Unlike [`IntentState`] this has no lossy reading and needs none: the column is narration
    /// about *how* a state was set, never an authorization, so an unrecognised slug reads back as
    /// `None` — "we do not know how this was settled" — rather than being collapsed into one of
    /// the three real answers.
    pub fn from_slug(s: &str) -> Option<Self> {
        match s {
            "acked" => Some(Self::Acked),
            "reconciled" => Some(Self::Reconciled),
            "operator" => Some(Self::Operator),
            _ => None,
        }
    }
}

/// What the caller opens: everything that is knowable *before* the effect is attempted.
///
/// `state` is `open` by definition and `run_id` is stamped by the writer thread from the current
/// launch, so neither is a field here. The read shape is [`IntentRecord`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentRow {
    /// A fresh id, minted before the effect. There is no `ON CONFLICT` on this table.
    pub id: String,
    /// What is about to happen.
    pub kind: IntentKind,
    /// Owning project, when the effect belongs to one.
    pub project_id: Option<String>,
    /// The session, when there is one yet.
    ///
    /// **Nullable and it must be:** `worktree::prepare` runs before `start_session` mints the id,
    /// so a `worktree_add` intent has no session to name when it is written. The id is filled in
    /// on close.
    pub session_id: Option<SessionId>,
    /// When the row was opened.
    pub opened_at: SystemTime,
    /// What the effect acts on: a worktree path, a branch, a ref, a request id.
    pub subject: Option<String>,
    /// The value the postcondition will be measured against, captured **before** the effect,
    /// because it stops being knowable the moment the effect runs.
    pub baseline: Option<String>,
    /// Anything else worth narrating, as JSON text. Bounded to
    /// [`crate::schema::INTENT_DETAIL_LIMIT`] on write; an oversized value is replaced by a
    /// placeholder rather than stored.
    pub detail_json: String,
}

impl IntentRow {
    /// An intent that names only what it must: an id, a kind, and when it was opened.
    pub fn new(id: impl Into<String>, kind: impl Into<IntentKind>, opened_at: SystemTime) -> Self {
        Self {
            id: id.into(),
            kind: kind.into(),
            project_id: None,
            session_id: None,
            opened_at,
            subject: None,
            baseline: None,
            detail_json: "{}".to_owned(),
        }
    }
}

/// One intent as stored, read back whole.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentRecord {
    /// The id minted before the effect.
    pub id: String,
    /// App launch that opened it. Equal to [`crate::Store::run_id`] means this launch opened it.
    pub run_id: String,
    /// What was about to happen, as the stored slug.
    pub kind: IntentKind,
    /// Where it is now.
    pub state: IntentState,
    /// Owning project, when it has one.
    pub project_id: Option<String>,
    /// The session, once one is known.
    pub session_id: Option<SessionId>,
    /// When the row was opened.
    pub opened_at: SystemTime,
    /// When it was settled, if it has been.
    pub closed_at: Option<SystemTime>,
    /// What the effect acts on.
    pub subject: Option<String>,
    /// The pre-effect value the postcondition is measured against.
    pub baseline: Option<String>,
    /// Bounded JSON text; may be the oversized placeholder rather than the real value.
    pub detail_json: String,
    /// How the state was set, when the stored slug is one this build knows.
    pub outcome: Option<IntentOutcome>,
    /// The command and the value that decided it, bounded. What makes a wrong answer auditable
    /// rather than mysterious.
    pub evidence: Option<String>,
}

/// Column list shared by every `intents` read.
pub(crate) const INTENT_COLUMNS: &str = "id, run_id, kind, state, project_id, session_id, \
     opened_at, closed_at, subject, baseline, detail_json, outcome, evidence";

pub(crate) fn intent_from_row(row: &Row<'_>) -> rusqlite::Result<IntentRecord> {
    Ok(IntentRecord {
        id: row.get("id")?,
        run_id: row.get("run_id")?,
        // Pass-through on purpose: a slug this build does not know keeps its own name rather
        // than being collapsed, so a newer build's kind is legible instead of erased.
        kind: IntentKind::new(row.get::<_, String>("kind")?),
        // Lossy on purpose, and restrictively: an unknown slug reads `unknown`, never `done`.
        state: IntentState::from_slug_lossy(&row.get::<_, String>("state")?),
        project_id: row.get("project_id")?,
        session_id: row.get::<_, Option<String>>("session_id")?.map(SessionId::new),
        opened_at: from_millis(row.get("opened_at")?),
        closed_at: row.get::<_, Option<i64>>("closed_at")?.map(from_millis),
        subject: row.get("subject")?,
        baseline: row.get("baseline")?,
        detail_json: row.get("detail_json")?,
        outcome: row
            .get::<_, Option<String>>("outcome")?
            .as_deref()
            .and_then(IntentOutcome::from_slug),
        evidence: row.get("evidence")?,
    })
}

/// Bound `intents.detail_json`, replacing an oversized value rather than storing it.
///
/// The same treatment `schema::kind_json` gives an approval's payload, on already-serialised
/// text: past [`crate::schema::INTENT_DETAIL_LIMIT`] the stored value becomes
/// `{"type":"oversized","bytes":N,"head":…}`, so a reader renders "truncated" instead of holding
/// a whole file body in a table that has no ring to cap it.
pub(crate) fn detail_json(raw: &str) -> String {
    crate::schema::oversized_json(raw, INTENT_DETAIL_LIMIT)
}

/// Hold a close to the states its kind is allowed to settle.
///
/// Anything outside [`KnownIntentKind::settleable`] — and any close on a kind this build cannot
/// name at all — becomes [`IntentState::Unknown`], and the request that was refused is prepended
/// to `evidence` so the downgrade is auditable rather than mysterious.
///
/// **Downgraded, never refused.** `unknown` is the restrictive reading: it is never retried, it
/// is surfaced to a human, and it authorizes nothing. A refused close would instead leave the row
/// `open` — indistinguishable from a crash — and invite the retry the downgrade exists to
/// prevent. Closing a `work_order` as `not_done` is the worst case the design has: it authorizes
/// re-dispatching an order that already had effects.
///
/// **A kind this build cannot name settles `unknown`**, exactly as a state it cannot name reads
/// back `unknown`. `IntentKind` stays a pass-through slug on *read* — the stored name is never
/// collapsed — but a settleable set we cannot look up is not one we can check, and the restrictive
/// reading applies to kinds for the same reason it applies to states: `IntentKind::new("work_oder")`
/// is one typo away from closing a `work_order` as `not_done`, which authorizes a repeat of work
/// that may already have run.
// see docs/research/intent-records.md §4.3 and the 2026-09-04 amendment.
pub(crate) fn hold_to_settleable(
    kind: &IntentKind,
    state: IntentState,
    evidence: Option<String>,
) -> (IntentState, Option<String>) {
    let note = match kind.known() {
        Some(known) if known.settleable().contains(&state) => return (state, evidence),
        Some(known) => {
            let slugs: Vec<&str> =
                known.settleable().iter().map(|s| s.as_slug()).collect();
            format!(
                "requested {}; {} settles {} only",
                state.as_slug(),
                known.as_slug(),
                slugs.join("|")
            )
        }
        // Already the restrictive answer: downgrading `unknown` to `unknown` would only add a
        // note about a refusal that did not happen.
        None if state == IntentState::Unknown => return (state, evidence),
        None => format!("requested {}; kind {kind} is not one this build knows", state.as_slug()),
    };
    let note = match evidence {
        Some(had) => format!("{note}. {had}"),
        None => note,
    };
    (IntentState::Unknown, Some(note))
}

/// Bound `intents.evidence`: one command and the value it printed, not its output.
pub(crate) fn evidence(raw: &str) -> String {
    bounded(raw, INTENT_EVIDENCE_LIMIT)
}

/// Delete settled intents closed before `now - INTENT_RETENTION`, and report how many.
///
/// Runs at [`crate::Store::open`], beside `expire_pending_approvals`. `unknown` rows survive any
/// age — they are the record that something may have happened and nobody has looked yet — and so
/// does `open`, which reconciliation has not reached.
///
/// This is the crate's first retention rule, and `intents` is the only growing table in it: the
/// plan tables are O(phases) and bounded by construction, and the feed is a capped ring.
// see docs/research/intent-records.md §6 — ~226 rows/hour under a continuous autonomous run.
pub(crate) fn sweep_settled(conn: &Connection, now: SystemTime) -> Result<usize> {
    let cutoff = to_millis(now.checked_sub(INTENT_RETENTION).unwrap_or(SystemTime::UNIX_EPOCH));
    let n = conn.execute(
        "DELETE FROM intents WHERE state IN ('done', 'not_done') AND closed_at < ?1",
        (cutoff,),
    )?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::open_connection;

    /// A row as a newer build would have written it: a `state` slug outside the closed set, and a
    /// `kind` slug this build has never heard of.
    fn insert_raw(conn: &Connection, id: &str, kind: &str, state: &str) {
        conn.execute(
            "INSERT INTO intents(id, run_id, kind, state, opened_at, closed_at)
             VALUES (?1, 'r', ?2, ?3, 1, 2)",
            (id, kind, state),
        )
        .expect("insert");
    }

    fn read(conn: &Connection, id: &str) -> IntentRecord {
        let sql = format!("SELECT {INTENT_COLUMNS} FROM intents WHERE id = ?1");
        conn.query_row(&sql, (id,), intent_from_row).expect("read")
    }

    /// The column is a closed slug set read lossily, and the lossy read is the restrictive one:
    /// a value outside the set is `unknown`, never `done` and never `not_done`. Either of those
    /// would authorize the loop to act — one to treat an effect as taken, the other to repeat it.
    ///
    /// This is `an_unknown_mcp_slug_reads_back_off`, one table over.
    #[test]
    fn an_unknown_intent_state_slug_reads_back_unknown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_connection(&dir.path().join("t.sqlite")).expect("open");
        insert_raw(&conn, "i1", "worktree_add", "half_done");
        let row = read(&conn, "i1");
        assert_eq!(row.state, IntentState::Unknown);
        assert_ne!(row.state, IntentState::Done);
        assert_ne!(row.state, IntentState::NotDone);
    }

    /// The `kind` column is the opposite treatment, and deliberately so: a pass-through slug, so
    /// a build that adds a kind is not lossy to an older reader.
    #[test]
    fn an_unknown_intent_kind_slug_is_preserved_verbatim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_connection(&dir.path().join("t.sqlite")).expect("open");
        insert_raw(&conn, "i1", "db_migrate", "open");
        let row = read(&conn, "i1");
        assert_eq!(row.kind.as_str(), "db_migrate", "the slug is not collapsed");
        assert_eq!(row.kind.known(), None, "but this build does not claim to know it");
        assert_eq!(row.state, IntentState::Open);
    }

    /// An `outcome` slug outside the set reads back as `None` — "we do not know how this was
    /// settled" — rather than being collapsed into one of the three real answers.
    #[test]
    fn an_unknown_outcome_slug_reads_back_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_connection(&dir.path().join("t.sqlite")).expect("open");
        insert_raw(&conn, "i1", "spawn", "done");
        conn.execute("UPDATE intents SET outcome = 'fusion' WHERE id = 'i1'", [])
            .expect("update");
        assert_eq!(read(&conn, "i1").outcome, None);
    }

    /// `ON DELETE CASCADE` on both foreign keys: deleting a session or a project takes its
    /// intents with it. t3code's "deleting threads did not purge events" (#5110) was a missing
    /// foreign key, not a hard problem.
    #[test]
    fn deleting_a_session_or_a_project_takes_its_intents_with_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_connection(&dir.path().join("t.sqlite")).expect("open");
        conn.execute(
            "INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'x', '/r', 0)",
            [],
        )
        .expect("project");
        conn.execute("INSERT INTO sessions(id, project_id) VALUES ('s1', 'p1')", [])
            .expect("session");
        conn.execute(
            "INSERT INTO intents(id, run_id, kind, state, project_id, session_id, opened_at)
             VALUES ('i1', 'r', 'spawn', 'open', 'p1', 's1', 1),
                    ('i2', 'r', 'work_order', 'open', 'p1', NULL, 2)",
            [],
        )
        .expect("intents");

        let count = |conn: &Connection| -> i64 {
            conn.query_row("SELECT COUNT(*) FROM intents", [], |r| r.get(0)).expect("count")
        };
        assert_eq!(count(&conn), 2);
        conn.execute("DELETE FROM sessions WHERE id = 's1'", []).expect("delete session");
        assert_eq!(count(&conn), 1, "the session's intent went with it");
        conn.execute("DELETE FROM projects WHERE id = 'p1'", []).expect("delete project");
        assert_eq!(count(&conn), 0, "the project's intents went with it");
    }

    /// The sweep at [`crate::Store::open`], against a raw connection so the cutoff is exact.
    #[test]
    fn the_sweep_takes_settled_rows_past_the_cutoff_and_nothing_else() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_connection(&dir.path().join("t.sqlite")).expect("open");
        let now = SystemTime::UNIX_EPOCH + INTENT_RETENTION + Duration::from_secs(60 * 60);
        let stale = to_millis(SystemTime::UNIX_EPOCH + Duration::from_secs(1));
        let fresh = to_millis(now - Duration::from_secs(60));
        for (id, state, closed) in [
            ("old-done", "done", Some(stale)),
            ("old-not-done", "not_done", Some(stale)),
            ("old-unknown", "unknown", Some(stale)),
            ("old-superseded", "superseded", Some(stale)),
            ("new-done", "done", Some(fresh)),
            ("never-closed", "open", None),
        ] {
            conn.execute(
                "INSERT INTO intents(id, run_id, kind, state, opened_at, closed_at)
                 VALUES (?1, 'r', 'spawn', ?2, 1, ?3)",
                (id, state, closed),
            )
            .expect("insert");
        }

        assert_eq!(sweep_settled(&conn, now).expect("sweep"), 2);
        let mut stmt = conn.prepare("SELECT id FROM intents ORDER BY id").expect("prepare");
        let left: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .expect("query")
            .collect::<rusqlite::Result<_>>()
            .expect("rows");
        assert_eq!(
            left,
            vec!["never-closed", "new-done", "old-superseded", "old-unknown"],
            "an unknown row is never swept, whatever its age"
        );
    }

    /// The set is pinned, and the one narrowing the owner settled on 2026-09-04 is pinned with
    /// it: a `work_order` can only ever settle `unknown`.
    #[test]
    fn a_work_order_can_only_ever_settle_unknown() {
        assert_eq!(KnownIntentKind::WorkOrder.settleable(), &[IntentState::Unknown]);
        assert!(
            !KnownIntentKind::WorkOrder.settleable().contains(&IntentState::NotDone),
            "not_done would authorize re-dispatching an order that already had effects"
        );
        assert!(!KnownIntentKind::MergeToBase.settleable().contains(&IntentState::NotDone));
        assert!(!KnownIntentKind::ToolPermission.settleable().contains(&IntentState::NotDone));
        assert!(KnownIntentKind::WorktreeAdd.settleable().contains(&IntentState::NotDone));
    }

    /// The narrowing is enforced, not advised: a `work_order` closed `not_done` comes out
    /// `unknown`, carrying the request that was refused.
    #[test]
    fn a_close_outside_the_settleable_set_is_downgraded_to_unknown() {
        let work_order = IntentKind::from(KnownIntentKind::WorkOrder);
        let (state, evidence) = hold_to_settleable(
            &work_order,
            IntentState::NotDone,
            Some("rev-list --count -> 0".to_owned()),
        );
        assert_eq!(state, IntentState::Unknown, "not_done would authorize a re-dispatch");
        let evidence = evidence.expect("the downgrade is recorded");
        assert!(evidence.starts_with("requested not_done; work_order settles unknown only"));
        assert!(evidence.ends_with("rev-list --count -> 0"), "the caller's own evidence survives");

        // `done` is outside the set too, and gets the same treatment.
        let (state, _) = hold_to_settleable(&work_order, IntentState::Done, None);
        assert_eq!(state, IntentState::Unknown);
    }

    /// Everything the set does allow passes through untouched.
    #[test]
    fn a_close_inside_the_settleable_set_is_left_alone() {
        let worktree = IntentKind::from(KnownIntentKind::WorktreeAdd);
        for state in [IntentState::Done, IntentState::NotDone, IntentState::Unknown] {
            let (got, evidence) = hold_to_settleable(&worktree, state, Some("git".to_owned()));
            assert_eq!(got, state);
            assert_eq!(evidence.as_deref(), Some("git"), "no note where there was no downgrade");
        }
    }

    /// **A kind this build cannot name settles `unknown`**, exactly as a state it cannot name
    /// reads back `unknown`.
    ///
    /// The failure this closes is one typo wide: `IntentKind::new("work_oder")` is not
    /// `work_order`, so it has no settleable set to be held to — and passing it through let it
    /// close `not_done`, which authorizes re-dispatching an order that may already have written
    /// files, the one thing `work_order` itself is forbidden from doing.
    #[test]
    fn a_close_on_a_kind_this_build_cannot_name_settles_unknown() {
        let typo = IntentKind::new("work_oder");
        for state in [IntentState::NotDone, IntentState::Done] {
            let (got, evidence) = hold_to_settleable(&typo, state, Some("git".to_owned()));
            assert_eq!(got, IntentState::Unknown, "{state:?} on an unnameable kind must not stand");
            let evidence = evidence.expect("the downgrade is recorded");
            assert!(
                evidence.starts_with(&format!(
                    "requested {}; kind work_oder is not one this build knows",
                    state.as_slug()
                )),
                "{evidence}"
            );
            assert!(evidence.ends_with("git"), "the caller's own evidence survives");
        }
        // `unknown` is already the restrictive answer, so it earns no note about a refusal that
        // did not happen.
        let (got, evidence) = hold_to_settleable(&typo, IntentState::Unknown, None);
        assert_eq!(got, IntentState::Unknown);
        assert_eq!(evidence, None);
    }

    /// A kind slug this build does not know is preserved, not collapsed.
    #[test]
    fn an_unknown_kind_slug_is_passed_through_not_flattened() {
        let kind = IntentKind::new("db_migrate");
        assert_eq!(kind.as_str(), "db_migrate");
        assert_eq!(kind.known(), None);
        assert_eq!(IntentKind::from(KnownIntentKind::Spawn).known(), Some(KnownIntentKind::Spawn));
    }

    /// The restrictive reading, stated as an assertion rather than a comment.
    #[test]
    fn an_unknown_state_slug_reads_back_unknown_never_done() {
        assert_eq!(IntentState::from_slug_lossy("done"), IntentState::Done);
        assert_eq!(IntentState::from_slug("half_done"), None);
        assert_eq!(IntentState::from_slug_lossy("half_done"), IntentState::Unknown);
        assert!(!IntentState::Unknown.is_sweepable(), "an unknown row is never swept");
        assert!(IntentState::Done.is_sweepable() && IntentState::NotDone.is_sweepable());
        assert!(!IntentState::Open.is_sweepable() && !IntentState::Superseded.is_sweepable());
    }

    /// An oversized payload is replaced by a placeholder that says how big it was.
    #[test]
    fn an_oversized_detail_payload_is_replaced_not_stored() {
        let small = r#"{"tool":"Write"}"#;
        assert_eq!(detail_json(small), small);
        let huge = format!("{{\"body\":\"{}\"}}", "z".repeat(INTENT_DETAIL_LIMIT * 2));
        let stored = detail_json(&huge);
        assert!(stored.len() < huge.len(), "{} bytes stored", stored.len());
        assert!(stored.contains("\"oversized\""), "{stored}");
        assert!(!stored.contains(&"z".repeat(INTENT_DETAIL_LIMIT)), "the body is not stored");
    }
}
