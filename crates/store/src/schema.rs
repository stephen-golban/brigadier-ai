//! Tables, pragmas, the migration ladder, and the plain-value rows that cross the API.
//!
//! Nothing here is append-only and archival.
// see docs/research/persistence.md §3 — the t3code failure to design against is an unbounded
// `orchestration_events` table: 282 KB → 218 MB in 25 h. Per session we keep exactly one
// upserted row; the feed is a capped ring; usage is overwritten, never accumulated per event.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use brigadier_core::approval::PendingApproval;
use brigadier_core::driver::{DriverKind, McpPolicy};
use brigadier_core::event::{
    bounded, ExitReason, InstanceId, RequestId, RequestKind, SessionId, Usage, INPUT_EXCERPT_LIMIT,
};
use rusqlite::{Connection, Row};

use crate::feed::FeedKind;
use crate::{Error, Result};

/// `meta` key holding the UUID minted once per app launch.
pub const RUN_ID_KEY: &str = "run_id";

/// Bytes of `approvals.kind_json` kept; a `Write` approval carries a whole file body.
// see docs/research/persistence.md §6 — truncate at ~8 KB, the full copy lives in the NDJSON log.
pub const KIND_JSON_LIMIT: usize = INPUT_EXCERPT_LIMIT;

/// Bytes of `sessions.summary_json` kept.
pub const SUMMARY_JSON_LIMIT: usize = 4 * 1024;

/// Bytes of `intents.detail_json` kept; a `tool_permission` intent can carry a whole file body.
///
/// Same treatment as [`KIND_JSON_LIMIT`]: past this an oversized value is **replaced** by
/// `{"type":"oversized","bytes":N,"head":…}`, never stored. `intents` is the only growing table
/// in the crate and it has no ring to cap it, so the bound is the cap.
// see docs/research/intent-records.md §2.1.
pub const INTENT_DETAIL_LIMIT: usize = INPUT_EXCERPT_LIMIT;

/// Bytes of `intents.evidence` kept: one command and the value it printed, not its output.
pub const INTENT_EVIDENCE_LIMIT: usize = 4 * 1024;

/// Bytes of `intents.subject` and `intents.baseline` kept.
///
/// Both are short by construction — a worktree path, a branch, a ref, a request id, a sha, a
/// count — but both are caller-supplied free text, and "short by construction" is a convention,
/// not a bound. Truncated rather than replaced: a truncated path is visibly wrong, which is what
/// a reconciler needs, and 4 KiB is well past any real value.
pub const INTENT_SUBJECT_LIMIT: usize = 4 * 1024;

/// Bytes kept for every free-text column of the plan tables.
///
/// Covers, truncated at the write: `plans.goal`, `phases.title`, `phases.definition_of_done`,
/// `phases.verify_command`, `phases.commit_sha`, `phases.last_evidence`,
/// `plan_revisions.reason`, `unknowns.question`, `unknowns.answer`, `unknowns.findings_path`,
/// `work_orders.title`, `work_orders.worktree_path`, `work_orders.branch` and
/// `work_orders.report`. These are prose and paths the UI renders, and a tail-truncated value
/// still reads.
///
/// The two **JSON** columns — `plan_revisions.change_json` and `work_orders.owned_paths_json` —
/// are replaced by the `{"type":"oversized",…}` placeholder instead, never truncated by
/// [`bounded`]: truncating JSON produces text that no longer parses, and `owned_paths_json` is
/// what stops two workers writing the same file.
// see docs/research/persistence.md §3 — nothing append-only and archival, and t3code's 282 KB →
// 218 MB in 25 h was unbounded text in a table nobody capped.
pub const PLAN_TEXT_LIMIT: usize = 8 * 1024;

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
    decision_json TEXT    -- NULL with a resolved_at set == expired: nothing answered it, and
                          -- nothing was denied. Never written as a deny.
);

CREATE INDEX approvals_open ON approvals(session_id) WHERE resolved_at IS NULL;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"#,
    // Migration 1 (2026-09-03). The webview gets one pre-rendered string per row and had to
    // parse its leading label to tell model prose from a tool call. `kind` is that discriminator,
    // stored so a row replayed by `feed_tail` carries the same `k` as the live row did.
    //
    // A pre-existing row keeps its line and reads back as `unknown`, which is a class of its own:
    // its kind was never recorded. It is deliberately not `sys` — `sys` means the three session
    // lifetime events, and defaulting to it would have told a UI filter that every row written
    // before today was session housekeeping.
    //
    // Edited in place on 2026-09-03, hours after it was written (959bd0c), rather than superseded
    // by a migration 2: it had run only on test tempdirs and scratch databases, never on the
    // owner's data dir. Any later change to this statement needs a new rung on the ladder.
    r#"
ALTER TABLE feed ADD COLUMN kind TEXT NOT NULL DEFAULT 'unknown';
"#,
    // Migration 2 (2026-09-03). Whether a project's children inherit the user's MCP servers.
    // Slug set, closed: `off` | `inherit` (`brigadier_core::driver::McpPolicy`).
    //
    // **This rung switches every existing project to `off`**, the owner's two live projects
    // included, by owner decision on 2026-09-03: MCP startup is 751.5 ms of every 1,395 ms spawn
    // and the harness rents a child per decision, so the default is the restrictive one and a
    // project opts back in per project (`set_project_mcp`). A project reading `off` may
    // therefore be this migration's doing rather than anyone's choice; nothing records which.
    // see docs/research/spawn-split.md §2 and §6 (measured), docs/vision.md §3.
    r#"
ALTER TABLE projects ADD COLUMN mcp TEXT NOT NULL DEFAULT 'off';
"#,
    // Migration 3 (2026-09-04). Effect residue: what the harness was about to do when it died.
    //
    // One row per effectful step, written and COMMITTED before the effect is attempted and closed
    // after it. `state` is the three-valued answer reconciliation writes: 'done', 'not_done' and
    // 'unknown' — never two-valued, because "we cannot tell" must not be spelled as "not done",
    // which is what makes a fresh context repeat a commit that already landed.
    //
    // Nothing to backfill: the table starts empty, and unlike migration 1 no pre-existing row has
    // to read `unknown` for want of a recorded value.
    // see docs/research/intent-records.md, docs/research/panel-review-2026-09-03.md §3.4.
    r#"
CREATE TABLE intents (
    id          TEXT PRIMARY KEY,            -- uuid v4, minted before the effect
    run_id      TEXT    NOT NULL,            -- the launch that opened it; == meta.run_id is ours
    kind        TEXT    NOT NULL,            -- pass-through slug: never collapsed on read
    state       TEXT    NOT NULL DEFAULT 'open',
                                             -- 'open'|'done'|'not_done'|'unknown'|'superseded'
    project_id  TEXT    REFERENCES projects(id) ON DELETE CASCADE,
    session_id  TEXT    REFERENCES sessions(id) ON DELETE CASCADE,
    opened_at   INTEGER NOT NULL,
    closed_at   INTEGER,
    subject     TEXT,                        -- worktree path, branch, ref, request_id
    baseline    TEXT,                        -- the value the postcondition is measured against,
                                             -- captured BEFORE the effect (a sha, a count, a path)
    detail_json TEXT    NOT NULL DEFAULT '{}',  -- bounded to INTENT_DETAIL_LIMIT on write
    outcome     TEXT,                        -- 'acked'|'reconciled'|'operator' — how state was set
    evidence    TEXT                         -- the command and the value that decided it; bounded
);

-- The reconciler's only query, and the plan card's. Deliberately *wider* than that query, which
-- also excludes `outcome IN ('acked', 'operator')` — a row closed live by the code that did the
-- thing, or already answered by the owner, is not something a human has to decide about. SQLite
-- may use a partial index whose WHERE is implied by the query's, so the narrower query still rides
-- this index; see `StoreHandle::unsettled_intents`.
CREATE INDEX intents_unsettled ON intents(opened_at)
    WHERE state IN ('open', 'unknown');
-- Everything a session shows, newest first.
CREATE INDEX intents_session ON intents(session_id, opened_at);
"#,
    // Migration 4 (2026-09-04). The plan and progress store: the only thing that remembers.
    //
    // Under docs/vision.md §3 the harness owns goal, plan, progress and thread and rents model
    // windows per decision, so nothing else in the design remembers anything. Every child cascades
    // from its parent — persistence.md §3, t3code #5110 ("deleting threads did not purge events")
    // was a missing foreign key, not a hard problem — with one deliberate exception:
    // `work_orders.session_id` is ON DELETE SET NULL, because deleting a session removes its
    // narration (docs/vision.md §8) while the plan is the durable thing and must not lose the
    // record that an order was dispatched.
    //
    // Every table here is O(phases) and bounded by construction; none needs a retention sweep.
    // Every free-text column is bounded on write, at PLAN_TEXT_LIMIT — truncated for prose and
    // paths, replaced by the oversized placeholder for the two JSON columns, because truncating
    // JSON produces text that no longer parses. The `-- bounded` markers below say which is which.
    // see docs/plans/phase-4.md "W1-A", docs/vision.md §4 steps 5-7, §8, §9.
    r#"
CREATE TABLE plans (
    id          TEXT PRIMARY KEY,
    project_id  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    goal        TEXT    NOT NULL,            -- the owner's stated intent, verbatim; bounded
    status      TEXT    NOT NULL DEFAULT 'draft',
                                             -- 'draft'|'approved'|'done'|'abandoned'
    revision    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    approved_at INTEGER                      -- null until the owner approves the envelope
);

CREATE INDEX plans_project ON plans(project_id, created_at);

CREATE TABLE phases (
    id                 TEXT PRIMARY KEY,
    plan_id            TEXT    NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    ordinal            INTEGER NOT NULL,
    title              TEXT    NOT NULL,     -- bounded
    definition_of_done TEXT    NOT NULL DEFAULT '',  -- bounded
    verify_command     TEXT,                 -- bounded; null: this phase cannot go green
                                             -- through a gate
    state              TEXT    NOT NULL DEFAULT 'pending',
                                             -- 'pending'|'running'|'green'|'blocked'
    attempts           INTEGER NOT NULL DEFAULT 0,
    started_at         INTEGER,
    ended_at           INTEGER,
    commit_sha         TEXT,
    last_exit_code     INTEGER,
    last_evidence      TEXT,                 -- bounded; the gate's output goes to a worker window
    UNIQUE (plan_id, ordinal)
);

CREATE TABLE plan_revisions (
    id                       TEXT PRIMARY KEY,
    plan_id                  TEXT    NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    revision                 INTEGER NOT NULL,
    at                       INTEGER NOT NULL,
    reason                   TEXT    NOT NULL,   -- required and refused when empty, at the write:
                                                 -- `TEXT NOT NULL` does not mean non-empty, and a
                                                 -- revision with no reason is the thing this
                                                 -- table exists to prevent. Bounded.
    change_json              TEXT    NOT NULL DEFAULT '{}',  -- bounded by the JSON placeholder
    moved_definition_of_done INTEGER NOT NULL DEFAULT 0,     -- escalates to fusion, then the owner
    UNIQUE (plan_id, revision)
);

CREATE TABLE unknowns (
    id                 TEXT PRIMARY KEY,
    plan_id            TEXT    NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    bin                TEXT    NOT NULL,     -- 'owner'|'research'
    question           TEXT    NOT NULL,     -- bounded
    state              TEXT    NOT NULL DEFAULT 'open',
                                             -- 'open'|'answered'|'skipped'
    answer             TEXT,                 -- bounded
    findings_path      TEXT,                 -- bounded; research findings go to a file, not the
                                             -- store
    asked_at           INTEGER NOT NULL,
    settled_at         INTEGER,
    skipped_for_just_go INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX unknowns_plan ON unknowns(plan_id, asked_at);

CREATE TABLE work_orders (
    id               TEXT PRIMARY KEY,
    phase_id         TEXT    NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
    session_id       TEXT    REFERENCES sessions(id) ON DELETE SET NULL,
    title            TEXT    NOT NULL,     -- bounded
    owned_paths_json TEXT    NOT NULL DEFAULT '[]',  -- bounded by the JSON placeholder, never
                                             -- truncated: disjoint ownership per order is what
                                             -- stops two workers writing the same file, and a
                                             -- truncated path list silently overlaps
    state            TEXT    NOT NULL DEFAULT 'pending',
                                             -- 'pending'|'dispatched'|'reported'|'failed'|'unknown'
    worktree_path    TEXT,                   -- bounded
    branch           TEXT,                   -- bounded
    dispatched_at    INTEGER,
    finished_at      INTEGER,
    report           TEXT                    -- bounded; workers return reports, not transcripts
);

CREATE INDEX work_orders_phase ON work_orders(phase_id, dispatched_at);
"#,
    // Migration 5 (2026-09-04). The commit a phase's work branches from, stored rather than
    // recomputed.
    //
    // `worktree::prepare` branches from the constant `HEAD`. That is correct only while nothing
    // commits underneath it: once the loop commits per phase, two orders dispatched either side of
    // a phase commit branch from *different* bases, and the merge is then against two different
    // bases. The base is knowable exactly once — when the phase starts — so it is captured there
    // and read back, never re-derived from a `HEAD` that has moved.
    //
    // Nullable, and it must be: every phase that predates this rung has no recorded base, and
    // `NULL` says so rather than inventing today's `HEAD` for a phase that started last week.
    // see docs/research/orchestration-loop.md — "`HEAD` moves once the loop starts committing"
    // and work item B4, "the phase base sha". This rung is the store half of B4; `prepare` taking
    // an explicit base is the supervisor half and is not in this crate.
    r#"
ALTER TABLE phases ADD COLUMN base_sha TEXT;
"#,
    r#"
CREATE TABLE chat_items (
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 seq INTEGER NOT NULL,
 at INTEGER NOT NULL,
 kind TEXT NOT NULL,
 body TEXT NOT NULL,
 parent_id TEXT,
 PRIMARY KEY(session_id, id)
);
CREATE INDEX chat_items_cursor ON chat_items(session_id, seq);
"#,
    // Schema 8 shipped in the installed desktop app. Preserve its rewind records even when
    // this frontend does not expose rewind controls. Never lower an installed database version.
    r#"
ALTER TABLE chat_items ADD COLUMN provider_uuid TEXT;
CREATE TABLE chat_rewinds (
 id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 target_id TEXT NOT NULL,
 target_seq INTEGER NOT NULL,
 through_seq INTEGER,
 state TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX chat_rewinds_pending ON chat_rewinds(session_id) WHERE state='pending';
CREATE TABLE chat_archive (
 rewind_id TEXT NOT NULL REFERENCES chat_rewinds(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL,
 item_json TEXT NOT NULL
);
"#,
    // Session cleanup explicitly purges these after all workspace writers drain.
    r#"
CREATE TABLE workspace_epochs (
 session_id TEXT NOT NULL, turn_id TEXT NOT NULL, body TEXT NOT NULL,
 updated_at INTEGER NOT NULL, PRIMARY KEY(session_id,turn_id)
);
CREATE TABLE workspace_rewinds (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace TEXT NOT NULL,
 phase TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX workspace_rewinds_pending ON workspace_rewinds(workspace,phase);
CREATE TABLE workspace_applies (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, body TEXT NOT NULL);
"#,
    r#"
CREATE TABLE chat_turns (
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 id TEXT NOT NULL, start_seq INTEGER NOT NULL, end_seq INTEGER,
 started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL,
 PRIMARY KEY(session_id,id)
);
CREATE INDEX chat_turns_cursor ON chat_turns(session_id,start_seq);
"#,
    // Preserve the schema already shipped in version 11; legacy payload tables remain dormant.
    r#"
ALTER TABLE chat_items ADD COLUMN streaming INTEGER NOT NULL DEFAULT 0;
CREATE TABLE conversation_attachments (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 name TEXT NOT NULL, media_type TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size > 0 AND size = length(bytes)),
 created_at INTEGER NOT NULL, bytes BLOB NOT NULL,
 lineage_id TEXT NOT NULL,
 UNIQUE(project_id,lineage_id)
);
CREATE INDEX conversation_attachments_project ON conversation_attachments(project_id);
CREATE TABLE conversation_attachment_copies (
 source_id TEXT NOT NULL REFERENCES conversation_attachments(id) ON DELETE CASCADE,
 destination_project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 id TEXT NOT NULL REFERENCES conversation_attachments(id) ON DELETE CASCADE,
 PRIMARY KEY(source_id,destination_project)
);
CREATE TABLE conversation_attachment_refs (
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 attachment_id TEXT NOT NULL REFERENCES conversation_attachments(id) ON DELETE CASCADE,
 PRIMARY KEY(session_id,attachment_id)
);
CREATE TABLE conversation_rewind_attachment_refs (
 rewind_id TEXT NOT NULL REFERENCES workspace_rewinds(id) ON DELETE CASCADE,
 attachment_id TEXT NOT NULL REFERENCES conversation_attachments(id) ON DELETE CASCADE,
 PRIMARY KEY(rewind_id,attachment_id)
);
CREATE TRIGGER conversation_attachment_gc AFTER DELETE ON conversation_attachment_refs
BEGIN
 DELETE FROM conversation_attachments WHERE id=OLD.attachment_id AND NOT EXISTS(
  SELECT 1 FROM conversation_attachment_refs WHERE attachment_id=OLD.attachment_id)
  AND NOT EXISTS(SELECT 1 FROM conversation_rewind_attachment_refs WHERE attachment_id=OLD.attachment_id);
END;
CREATE TRIGGER conversation_rewind_attachment_gc AFTER DELETE ON conversation_rewind_attachment_refs
BEGIN
 DELETE FROM conversation_attachments WHERE id=OLD.attachment_id AND NOT EXISTS(
  SELECT 1 FROM conversation_attachment_refs WHERE attachment_id=OLD.attachment_id)
  AND NOT EXISTS(SELECT 1 FROM conversation_rewind_attachment_refs WHERE attachment_id=OLD.attachment_id);
END;
CREATE TABLE conversation_payloads (
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL,
 payload_json TEXT NOT NULL,
 PRIMARY KEY(session_id,item_id,kind)
);
CREATE INDEX conversation_payloads_cursor ON conversation_payloads(session_id,seq);
CREATE TABLE conversation_payload_archive (
 rewind_id TEXT NOT NULL REFERENCES chat_rewinds(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL,
 payload_json TEXT NOT NULL,
 PRIMARY KEY(rewind_id,session_id,item_id,kind,seq)
);
"#,
    // Peer attachment request context, compatible with databases from the removed UI migration.
    r#"
CREATE TABLE session_attachment_inputs (
 session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
 ids_json TEXT NOT NULL
);
INSERT INTO session_attachment_inputs(session_id,ids_json)
 SELECT p.session_id,json_extract(p.payload_json,'$.data.ids') FROM conversation_payloads p
 WHERE p.kind='attachments' AND json_type(p.payload_json,'$.data.ids')='array'
 AND p.item_id=(SELECT id FROM chat_items c WHERE c.session_id=p.session_id AND json_extract(c.kind,'$.type')='user-text' ORDER BY seq DESC,id DESC LIMIT 1);
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
    /// Whether this project's children inherit the user's MCP servers. `Off` unless the project
    /// opted in; every project that predates migration 2 reads `Off` for that reason alone.
    pub mcp: McpPolicy,
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
    /// What the row is, for a consumer that must not parse [`FeedRow::line`].
    pub kind: FeedKind,
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
    /// The answer, as JSON text. `None` with a `resolved_at` set means **expired**: the launch
    /// that owned the prompt died before anything answered it, and the row records no decision
    /// because none was made. See [`ApprovalOutcome`].
    pub decision_json: Option<String>,
}

/// What became of one stored approval. Three states, and the third is not a denial.
// see docs/vision.md §9 — "a panel that shows 'denied' for a deny that did not land — or
// 'allowed' for something that never ran — breaks the one screen the owner has to be able to
// trust." Approvals are the one surface in this product that is never optimistic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalOutcome {
    /// Still parked, and answerable if [`ApprovalRecord::run_id`] is this launch's.
    Pending,
    /// A real decision was recorded. [`ApprovalRecord::decision_json`] is it.
    Answered,
    /// The launch that owned it died first. `resolved_at` is stamped and there is **no**
    /// decision: neither allowed nor denied, and the tool it was gating may well have run.
    Expired,
}

impl ApprovalRecord {
    /// Decode [`ApprovalRecord::kind_json`], which fails when the value was replaced by the
    /// oversized placeholder the writer substitutes past [`KIND_JSON_LIMIT`].
    pub fn kind(&self) -> Option<RequestKind> {
        serde_json::from_str(&self.kind_json).ok()
    }

    /// Which of the three states this row is in.
    ///
    /// A resolved row with no decision is [`ApprovalOutcome::Expired`], never a deny — the
    /// decision never reached the child, so the store does not claim one was made.
    pub fn outcome(&self) -> ApprovalOutcome {
        match (self.resolved_at, self.decision_json.is_some()) {
            (None, _) => ApprovalOutcome::Pending,
            (Some(_), true) => ApprovalOutcome::Answered,
            (Some(_), false) => ApprovalOutcome::Expired,
        }
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

/// Bound a **JSON** column: past `limit` the value is *replaced* by
/// `{"type":"oversized","bytes":N,"head":…}` rather than truncated.
///
/// The one treatment every JSON column in this crate gets, and the reason it exists is that
/// [`bounded`] must never touch one: it appends `…`, which turns a JSON document into text that no
/// longer parses. The placeholder is a document in its own right, so every reader still gets JSON
/// and can render "truncated" instead of failing to decode.
pub(crate) fn oversized_json(raw: &str, limit: usize) -> String {
    if raw.len() <= limit {
        return raw.to_owned();
    }
    let head = bounded(raw, limit / 2);
    serde_json::json!({ "type": "oversized", "bytes": raw.len(), "head": head }).to_string()
}

/// Serialise a request kind, bounded. An oversized value is replaced by a placeholder that says
/// how big it was, so the UI can render "truncated" instead of failing to parse.
pub(crate) fn kind_json(kind: &RequestKind) -> String {
    let full = serde_json::to_string(kind).unwrap_or_else(|_| "null".to_owned());
    oversized_json(&full, KIND_JSON_LIMIT)
}

pub(crate) fn path_of(row: &Row<'_>, idx: &str) -> rusqlite::Result<Option<PathBuf>> {
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
        instance_id: row
            .get::<_, Option<String>>("instance_id")?
            .map(InstanceId::new),
        driver_kind: row
            .get::<_, Option<String>>("driver_kind")?
            .map(DriverKind::new),
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

/// Column list shared by every `projects` read.
pub(crate) const PROJECT_COLUMNS: &str = "id, name, root_path, created_at, mcp";

pub(crate) fn project_from_row(row: &Row<'_>) -> rusqlite::Result<ProjectRow> {
    Ok(ProjectRow {
        id: row.get("id")?,
        name: row.get("name")?,
        root_path: PathBuf::from(row.get::<_, String>("root_path")?),
        created_at: from_millis(row.get("created_at")?),
        // Lossy on purpose: a slug this build does not know reads back as `Off`, the restrictive
        // reading, never as `Inherit`. see `McpPolicy::from_slug_lossy`.
        mcp: McpPolicy::from_slug_lossy(&row.get::<_, String>("mcp")?),
    })
}

pub(crate) fn feed_from_row(row: &Row<'_>) -> rusqlite::Result<FeedRow> {
    Ok(FeedRow {
        session_id: SessionId::new(row.get::<_, String>("session_id")?),
        seq: row.get("seq")?,
        at: from_millis(row.get("at")?),
        kind: FeedKind::from_slug(&row.get::<_, String>("kind")?),
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

/// The first rung that runs inside an explicit transaction, together with its version bump.
///
/// Rungs 0-2 cannot. Migration 0 opens with `PRAGMA auto_vacuum`, which sqlite refuses inside a
/// transaction, and 1 and 2 are one `ALTER TABLE` each, which is atomic on its own. Rung 3 and
/// rung 4 create six tables and five indices between them, and a crash part-way through one of
/// those would leave `user_version` behind the file: the next open re-runs the rung, fails on
/// `table intents already exists`, and the app cannot open its store at all.
///
/// Rung 5 is one `ALTER TABLE` and would be safe either way; it runs inside the transaction
/// because it is above the threshold, and the threshold is a floor, not a per-rung judgement.
pub(crate) const TRANSACTIONAL_FROM: usize = 3;

/// Apply every migration the file has not seen.
///
/// From [`TRANSACTIONAL_FROM`] up, a rung's statements **and** its `user_version` bump are one
/// transaction, so a crash mid-rung leaves the file exactly as it was. The bump has to be inside
/// it: committing the DDL and then dying before the pragma is the same disaster as a half-applied
/// rung. Below it each statement stands alone, for the `auto_vacuum` reason above.
fn migrate(conn: &Connection) -> Result<()> {
    let applied: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let applied = usize::try_from(applied).unwrap_or(0);
    if applied > MIGRATIONS.len() {
        return Err(Error::Newer {
            found: applied,
            known: MIGRATIONS.len(),
        });
    }
    for (n, sql) in MIGRATIONS.iter().enumerate().skip(applied) {
        let version = n as i64 + 1;
        if n >= TRANSACTIONAL_FROM {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", version)?;
            tx.commit()?;
        } else {
            conn.execute_batch(sql)?;
            conn.pragma_update(None, "user_version", version)?;
        }
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
///
/// **`decision_json` is set to `NULL`, not to a denial.** Nothing answered the prompt, so nothing
/// was denied: the frame never went down the pipe, and the tool the approval was gating may well
/// have run. A resolved row with no decision means exactly one thing —
/// [`ApprovalOutcome::Expired`], outcome unknown — and that is the truth about it.
// see docs/research/persistence.md §6 for the expiry, and docs/vision.md §9 for why it is not
// spelled as a deny: "a panel that shows 'denied' for a deny that did not land — or 'allowed' for
// something that never ran — breaks the one screen the owner has to be able to trust."
pub(crate) fn expire_pending_approvals(conn: &Connection, now: SystemTime) -> Result<usize> {
    let n = conn.execute(
        "UPDATE approvals SET resolved_at = ?1, decision_json = NULL WHERE resolved_at IS NULL",
        (to_millis(now),),
    )?;
    Ok(n)
}

/// Fail every session a previous launch left mid-flight, and report how many.
///
/// A session row only reaches a terminal status when its consumer stores a `SessionExited`, and a
/// quit, a crash or a force-quit aborts that consumer first — so without this, a `starting` or
/// `running` row from a dead process stays that way forever and the UI shows a session that
/// cannot exist. Nothing that owned it survived the process, so at open it is a failure.
///
/// `exit_code` is deliberately left NULL: no exit was ever observed, and inventing one would be a
/// lie the UI would render as fact.
// see docs/research/persistence.md §6 — the same reasoning that expires a surviving approval:
// a row that outlived the process has nobody behind it, whatever launch opened it.
pub(crate) fn settle_stale_sessions(conn: &Connection, now: SystemTime) -> Result<usize> {
    let n = conn.execute(
        "UPDATE sessions SET status = ?1, ended_at = ?2 WHERE status IN (?3, ?4)",
        (
            SessionStatus::Failed.as_str(),
            to_millis(now),
            SessionStatus::Starting.as_str(),
            SessionStatus::Running.as_str(),
        ),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The migration's column default, proven rather than asserted: a row written by the
    /// pre-migration statement — no `kind` column at all — must read back as
    /// [`FeedKind::Unknown`], never as `sys`, which is a class of its own.
    #[test]
    fn a_row_that_predates_the_kind_column_reads_back_as_unknown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_connection(&dir.path().join("t.sqlite")).expect("open");
        conn.execute("INSERT INTO sessions(id) VALUES ('s1')", [])
            .expect("session");
        conn.execute(
            "INSERT INTO feed(session_id, seq, at, line) VALUES ('s1', 1, 0, 'an old row')",
            [],
        )
        .expect("feed");
        let mut stmt = conn
            .prepare("SELECT session_id, seq, at, kind, line FROM feed")
            .expect("prepare");
        let row = stmt.query_row([], feed_from_row).expect("read");
        assert_eq!(
            row.kind,
            FeedKind::Unknown,
            "an unrecorded kind is not `sys`"
        );
        assert_eq!(row.line, "an old row", "the line itself is never lost");
    }

    /// Migration 2 proven on a file that stopped at `user_version` 2: a project written before
    /// the `mcp` column existed reads back as [`McpPolicy::Off`] afterwards, which is the owner's
    /// 2026-09-03 decision applied to every pre-existing project, and the ladder ends at 3.
    #[test]
    fn migration_2_switches_a_pre_existing_project_to_off() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.sqlite");
        {
            // A database as the previous build left it: rungs 0 and 1 only.
            let conn = Connection::open(&path).expect("open");
            for (n, sql) in MIGRATIONS.iter().enumerate().take(2) {
                conn.execute_batch(sql).expect("old rung");
                conn.pragma_update(None, "user_version", n as i64 + 1)
                    .expect("bump");
            }
            conn.execute(
                "INSERT INTO projects(id, name, root_path, created_at) VALUES ('p1', 'old', '/r', 0)",
                [],
            )
            .expect("a project with no mcp column at all");
        }
        let conn = open_connection(&path).expect("reopen runs the ladder");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .expect("version");
        assert_eq!(version, MIGRATIONS.len() as i64);
        assert_eq!(version, 12, "conversation lifecycle schema is the top rung");
        let sql = format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE id = 'p1'");
        let row = conn.query_row(&sql, [], project_from_row).expect("read");
        assert_eq!(
            row.mcp,
            McpPolicy::Off,
            "an existing project is switched off, not opted in"
        );
        assert_eq!(row.name, "old", "nothing else about the row moves");
    }

    /// Migrations 3 and 4 proven on a file that stopped at `user_version` 3 — the version the
    /// owner's own data directory read on 2026-09-04 (`docs/STATUS.md`). The ladder ends at 5,
    /// every new table and index exists, and no pre-existing row moved.
    #[test]
    fn migrations_3_and_4_land_on_a_file_stopped_at_user_version_3() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.sqlite");
        {
            // A database as the previous build left it: rungs 0, 1 and 2 only.
            let conn = Connection::open(&path).expect("open");
            for (n, sql) in MIGRATIONS.iter().enumerate().take(3) {
                conn.execute_batch(sql).expect("old rung");
                conn.pragma_update(None, "user_version", n as i64 + 1)
                    .expect("bump");
            }
            conn.execute(
                "INSERT INTO projects(id, name, root_path, created_at, mcp)
                 VALUES ('p1', 'old', '/r', 7, 'inherit')",
                [],
            )
            .expect("project");
            conn.execute(
                "INSERT INTO sessions(id, project_id) VALUES ('s1', 'p1')",
                [],
            )
            .expect("session");
            conn.execute(
                "INSERT INTO feed(session_id, seq, at, kind, line)
                 VALUES ('s1', 1, 11, 'text', 'an old row')",
                [],
            )
            .expect("feed");
        }

        let conn = open_connection(&path).expect("reopen runs the ladder");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .expect("version");
        assert_eq!(version, MIGRATIONS.len() as i64);
        assert_eq!(version, 12, "conversation lifecycle schema is the top rung");

        let has = |kind: &str, name: &str| -> bool {
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = ?1 AND name = ?2",
                (kind, name),
                |r| r.get::<_, i64>(0),
            )
            .expect("sqlite_master")
                == 1
        };
        for table in [
            "intents",
            "plans",
            "phases",
            "plan_revisions",
            "unknowns",
            "work_orders",
        ] {
            assert!(has("table", table), "migration did not create {table}");
        }
        for index in [
            "intents_unsettled",
            "intents_session",
            "plans_project",
            "unknowns_plan",
            "work_orders_phase",
        ] {
            assert!(has("index", index), "migration did not create {index}");
        }

        // Nothing that was already there moved.
        let sql = format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE id = 'p1'");
        let row = conn
            .query_row(&sql, [], project_from_row)
            .expect("read project");
        assert_eq!(row.name, "old");
        assert_eq!(
            row.mcp,
            McpPolicy::Inherit,
            "an opted-in project stays opted in"
        );
        assert_eq!(to_millis(row.created_at), 7);
        let mut stmt = conn
            .prepare("SELECT session_id, seq, at, kind, line FROM feed")
            .expect("prepare");
        let feed = stmt.query_row([], feed_from_row).expect("read feed");
        assert_eq!(feed.line, "an old row");
        assert_eq!(feed.kind, FeedKind::Text);
        assert_eq!(feed.seq, 1);
        // And the new tables start empty: there is nothing to backfill.
        let intents: i64 = conn
            .query_row("SELECT COUNT(*) FROM intents", [], |r| r.get(0))
            .expect("count");
        assert_eq!(intents, 0);
    }

    /// A rung that dies part-way through leaves the file exactly as it was, and a later open
    /// still works.
    ///
    /// A rung cannot be interrupted from a test the way a power cut interrupts it, so the
    /// interruption here is a statement that fails: a stray `work_orders` table collides with the
    /// **last** `CREATE TABLE` of rung 4, after four of its five tables have run. SQLite treats
    /// both the same way — the statements before it are pending, and whether they survive is
    /// decided by whether a transaction is open, which is exactly the property under test.
    ///
    /// Before [`TRANSACTIONAL_FROM`] existed this left `plans`, `phases`, `plan_revisions` and
    /// `unknowns` on disk with `user_version` still 4, so **every later open failed** on `table
    /// plans already exists` and the app could not open its store at all. The last two assertions
    /// are the ones that would fail without the transaction.
    ///
    /// What it does **not** prove: that the version bump is inside that transaction. The failure
    /// forced here lands inside `execute_batch`, before the bump, and both orderings roll back
    /// identically from there. `a_rung_whose_version_bump_fails_leaves_no_tables_behind` is the
    /// test for that, and it forces its failure at the bump itself.
    #[test]
    fn a_migration_that_dies_part_way_through_leaves_nothing_behind() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.sqlite");
        let count = |conn: &Connection, name: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                (name,),
                |r| r.get(0),
            )
            .expect("sqlite_master")
        };

        {
            // A database as the previous build left it: every rung below the transactional ones,
            // plus the obstruction the top rung will trip over.
            let conn = Connection::open(&path).expect("open");
            for (n, sql) in MIGRATIONS.iter().enumerate().take(TRANSACTIONAL_FROM) {
                conn.execute_batch(sql).expect("old rung");
                conn.pragma_update(None, "user_version", n as i64 + 1)
                    .expect("bump");
            }
            conn.execute_batch("CREATE TABLE work_orders (id TEXT PRIMARY KEY);")
                .expect("the obstruction");
        }

        {
            let conn = Connection::open(&path).expect("reopen");
            migrate(&conn).expect_err("rung 4 must fail on the table that already exists");
            let version: i64 = conn
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .expect("version");
            assert_eq!(
                version, 4,
                "rung 3 committed; rung 4's bump rolled back with its DDL"
            );
            assert_eq!(
                count(&conn, "intents"),
                1,
                "the rung that did commit is still there"
            );
            for table in ["plans", "phases", "plan_revisions", "unknowns"] {
                assert_eq!(
                    count(&conn, table),
                    0,
                    "{table} outlived the rung that created it"
                );
            }
        }

        // Clear the obstruction and open for real. This is the assertion the old code failed:
        // with rung 4's leftovers on disk it died on `table plans already exists` instead.
        {
            let conn = Connection::open(&path).expect("reopen");
            conn.execute_batch("DROP TABLE work_orders;")
                .expect("clear");
        }
        let conn = open_connection(&path).expect("the next open must not trip over a partial rung");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .expect("version");
        assert_eq!(version, MIGRATIONS.len() as i64);
        for table in [
            "intents",
            "plans",
            "phases",
            "plan_revisions",
            "unknowns",
            "work_orders",
        ] {
            assert_eq!(count(&conn, table), 1, "the reopen did not create {table}");
        }
    }

    /// **The version bump is inside the rung's transaction**, and this is the test that fails if
    /// it is moved back out.
    ///
    /// The sibling test above forces its failure *inside* `execute_batch`, which both orderings
    /// survive identically — so it proves the DDL rolls back and proves nothing about the bump.
    /// The failure here lands exactly between the two: an authorizer that denies the
    /// `PRAGMA user_version = N` **write** and nothing else, leaving the read `migrate` opens with
    /// alone. With the bump inside the transaction the rung's tables roll back with it; with the
    /// bump outside, `tx.commit()` has already landed `intents` by the time the pragma is refused,
    /// and the last assertion here fails — which is the disaster in miniature, because the next
    /// open re-runs the rung and dies on `table intents already exists`.
    #[test]
    fn a_rung_whose_version_bump_fails_leaves_no_tables_behind() {
        use rusqlite::hooks::{AuthAction, AuthContext, Authorization};

        let dir = tempfile::tempdir().expect("tempdir");
        let conn = Connection::open(dir.path().join("t.sqlite")).expect("open");
        // Every rung below the transactional threshold, as a previous build left them.
        for (n, sql) in MIGRATIONS.iter().enumerate().take(TRANSACTIONAL_FROM) {
            conn.execute_batch(sql).expect("old rung");
            conn.pragma_update(None, "user_version", n as i64 + 1)
                .expect("bump");
        }
        // `pragma_update` writes the value into the statement text, so a write is a `Pragma`
        // action carrying `Some(value)` and a read carries `None`. Only the write is refused.
        conn.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
            AuthAction::Pragma {
                pragma_name: "user_version",
                pragma_value: Some(_),
                ..
            } => Authorization::Deny,
            _ => Authorization::Allow,
        }))
        .expect("authorizer");

        let err = migrate(&conn).expect_err("the bump must be refused");
        assert!(err.to_string().contains("not authorized"), "{err}");

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .expect("version");
        assert_eq!(
            version, TRANSACTIONAL_FROM as i64,
            "the bump did not land, by construction"
        );
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'intents'",
                [],
                |r| r.get(0),
            )
            .expect("sqlite_master");
        assert_eq!(
            tables, 0,
            "rung {TRANSACTIONAL_FROM}'s DDL outlived the version bump that failed after it"
        );
    }

    /// Rung 5 on a file stopped at `user_version` 5: the column arrives, and a phase written
    /// before it existed reads back with **no** base — never a base invented at read time.
    #[test]
    fn migration_5_adds_base_sha_and_an_older_phase_has_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.sqlite");
        {
            // A database as the previous build left it: rungs 0-4 only.
            let conn = Connection::open(&path).expect("open");
            for (n, sql) in MIGRATIONS.iter().enumerate().take(5) {
                conn.execute_batch(sql).expect("old rung");
                conn.pragma_update(None, "user_version", n as i64 + 1)
                    .expect("bump");
            }
            conn.execute(
                "INSERT INTO projects(id, name, root_path, created_at, mcp)
                 VALUES ('p1', 'old', '/r', 7, 'off')",
                [],
            )
            .expect("project");
            conn.execute(
                "INSERT INTO plans(id, project_id, goal, created_at) VALUES ('pl1', 'p1', 'g', 8)",
                [],
            )
            .expect("plan");
            conn.execute(
                "INSERT INTO phases(id, plan_id, ordinal, title, commit_sha)
                 VALUES ('ph1', 'pl1', 0, 'schema', 'abc123')",
                [],
            )
            .expect("a phase with no base_sha column at all");
        }

        let conn = open_connection(&path).expect("reopen runs the ladder");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .expect("version");
        assert_eq!(version, MIGRATIONS.len() as i64);
        assert_eq!(version, 12, "conversation lifecycle schema is the top rung");

        let sql = format!(
            "SELECT {} FROM phases WHERE id = 'ph1'",
            crate::plan::PHASE_COLUMNS
        );
        let row = conn
            .query_row(&sql, [], crate::plan::phase_from_row)
            .expect("read");
        assert_eq!(
            row.base_sha, None,
            "a phase that predates the column records no base"
        );
        assert_eq!(
            row.commit_sha.as_deref(),
            Some("abc123"),
            "nothing else about the row moves"
        );
        assert_eq!(row.title, "schema");
    }

    /// The same rung from zero: a file this build creates is at the top of the ladder and carries
    /// the column, so `0 -> 6` and `5 -> 6` are both proved rather than one standing in for both.
    #[test]
    fn a_fresh_file_lands_on_the_top_rung_with_base_sha() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_connection(&dir.path().join("t.sqlite")).expect("open");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .expect("version");
        assert_eq!(version, 12);
        let has_column: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('phases') WHERE name = 'base_sha'",
                [],
                |r| r.get(0),
            )
            .expect("table_info");
        assert_eq!(
            has_column, 1,
            "a fresh file gets the column from the ladder, not from a patch"
        );
    }

    /// A file written by a build with more rungs than this one is refused, not opened and half
    /// understood. This is what an older binary does when it meets a `user_version` 6 file: it
    /// knows 5, finds one more, and stops.
    #[test]
    fn a_file_from_a_newer_build_is_refused_rather_than_opened() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.sqlite");
        {
            let conn = open_connection(&path).expect("open");
            // One rung past this build: exactly the relationship a `user_version` 6 file has to a
            // build that shipped 5 rungs.
            conn.pragma_update(None, "user_version", MIGRATIONS.len() as i64 + 1)
                .expect("bump");
        }
        let conn = Connection::open(&path).expect("open");
        match migrate(&conn) {
            Err(Error::Newer { found, known }) => {
                assert_eq!(found, MIGRATIONS.len() + 1);
                assert_eq!(known, MIGRATIONS.len());
            }
            other => panic!("a newer file must be refused, got {other:?}"),
        }
    }

    /// The column is a closed slug set; a value outside it is read as `off`, never `inherit`.
    #[test]
    fn an_unknown_mcp_slug_reads_back_off() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_connection(&dir.path().join("t.sqlite")).expect("open");
        conn.execute(
            "INSERT INTO projects(id, name, root_path, created_at, mcp)
             VALUES ('p1', 'x', '/r', 0, 'everything')",
            [],
        )
        .expect("insert");
        let sql = format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE id = 'p1'");
        let row = conn.query_row(&sql, [], project_from_row).expect("read");
        assert_eq!(row.mcp, McpPolicy::Off);
    }
    #[test]
    fn installed_schema_eight_reopens_and_chat_history_cascades() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("installed.sqlite");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            for (index, migration) in MIGRATIONS.iter().take(8).enumerate() {
                conn.execute_batch(migration).unwrap();
                conn.pragma_update(None, "user_version", index as i64 + 1)
                    .unwrap();
            }
            conn.execute_batch(
                "INSERT INTO sessions(id) VALUES ('s');
                INSERT INTO chat_items(session_id,id,seq,at,kind,body,provider_uuid)
                VALUES ('s','item',1,1,'user-text','fixture','provider-item');
                INSERT INTO chat_rewinds(id,session_id,target_id,target_seq,state,created_at)
                VALUES ('r','s','item',1,'pending',1);
                INSERT INTO chat_archive(rewind_id,session_id,item_json) VALUES ('r','s','{}');",
            )
            .unwrap();
        }
        let conn = open_connection(&path).unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            12
        );
        assert_eq!(
            conn.query_row("SELECT provider_uuid FROM chat_items", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "provider-item"
        );
        conn.execute("DELETE FROM sessions WHERE id='s'", [])
            .unwrap();
        for table in ["chat_items", "chat_rewinds", "chat_archive"] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }
    #[test]
    fn installed_v11_attachments_upgrade_without_losing_bytes_or_request_context() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            for (index, migration) in MIGRATIONS.iter().take(11).enumerate() {
                conn.execute_batch(migration).unwrap();
                conn.pragma_update(None, "user_version", index as i64 + 1).unwrap();
            }
            conn.execute_batch(r#"
                INSERT INTO projects(id,name,root_path,created_at,mcp) VALUES ('p','Project','/p',1,'off');
                INSERT INTO sessions(id,status) VALUES ('s','exited');
                UPDATE sessions SET project_id='p' WHERE id='s';
                INSERT INTO conversation_attachments(id,project_id,name,media_type,size,created_at,bytes,lineage_id)
                VALUES ('a','p','note.txt','text/plain',4,1,x'74657374','a');
                INSERT INTO conversation_attachment_refs(session_id,attachment_id) VALUES ('s','a');
                INSERT INTO chat_items(session_id,id,seq,at,kind,body) VALUES ('s','u',2,1,'{"type":"user-text"}','Request');
                INSERT INTO conversation_payloads(session_id,item_id,kind,seq,payload_json)
                VALUES ('s','u','attachments',2,'{"version":1,"data":{"ids":["a"]}}');
            "#).unwrap();
        }
        let conn = open_connection(&path).unwrap();
        assert_eq!(conn.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),12);
        assert_eq!(conn.query_row("SELECT ids_json FROM session_attachment_inputs WHERE session_id='s'",[],|r|r.get::<_,String>(0)).unwrap(),r#"["a"]"#);
        assert_eq!(conn.query_row("SELECT bytes FROM conversation_attachments WHERE id='a'",[],|r|r.get::<_,Vec<u8>>(0)).unwrap(),b"test");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM conversation_payloads",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }

}
