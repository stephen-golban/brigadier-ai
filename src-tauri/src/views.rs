//! The serde shapes the commands return, verbatim from `docs/plans/ipc-contract.md`.
//!
//! Every timestamp is milliseconds since the Unix epoch with a `_ms` suffix; every id is a
//! string. Nothing here is a re-modelling of a core type for its own sake — `Usage`,
//! `ApprovalView`, `FeedRowWire` and `Envelope` cross the wire in their own crates' shapes.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use brigadier_core::driver::McpPolicy;
use brigadier_core::event::Usage;
use brigadier_store::intents::IntentRecord;
use brigadier_store::plan::{PhaseRow, PhaseState, PlanRow, UnknownRow, WorkOrderRow};
use brigadier_store::{ProjectRow, SessionRecord};
use serde::{Deserialize, Serialize};

/// Milliseconds since the Unix epoch. Saturates rather than erring, like the supervisor's own.
pub(crate) fn to_millis(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

fn path_string(p: &Path) -> String {
    p.display().to_string()
}

/// What the app is, this launch.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppInfo {
    /// This launch's id; an approval carrying a different one is expired.
    pub run_id: String,
    /// Where the database, the raw logs and the pid files live.
    pub data_dir: String,
    /// The app's crate version.
    pub version: String,
}

/// A resolved `claude` install.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ClaudeStatus {
    /// Absolute path to the binary we would spawn.
    pub binary: String,
    /// What `claude --version` reported.
    pub version: String,
}

/// One model the operator may pin on a new session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ModelInfo {
    /// What goes on `--model`.
    pub id: String,
    /// What the picker shows.
    pub label: String,
    /// Exactly one entry in the list carries `true`.
    #[serde(rename = "default")]
    pub is_default: bool,
}

/// A project the operator has opened.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ProjectView {
    /// Stable project id.
    pub id: String,
    /// Directory basename.
    pub name: String,
    /// Absolute root.
    pub root_path: String,
    /// When it was first recorded.
    pub created_at_ms: i64,
    /// Whether this project's children inherit the user's MCP servers: `"off"` or `"inherit"`,
    /// a bare string on the wire. `"off"` may be migration 2's doing rather than a choice.
    // see docs/plans/ipc-contract.md "### set_project_mcp".
    pub mcp: McpPolicy,
}

impl From<&ProjectRow> for ProjectView {
    fn from(row: &ProjectRow) -> Self {
        Self {
            id: row.id.clone(),
            name: row.name.clone(),
            root_path: path_string(&row.root_path),
            created_at_ms: to_millis(row.created_at),
            mcp: row.mcp,
        }
    }
}

/// One session as the sidebar and the header need it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct SessionView {
    /// Our id for the session.
    pub session_id: String,
    /// Which project it belongs to.
    pub project_id: Option<String>,
    /// Which driver instance is driving it.
    pub instance_id: Option<String>,
    /// The provider's own session id, once it has told us.
    pub provider_session_id: Option<String>,
    /// Working directory of the child. Equal to `worktree_path` whenever there is one.
    pub cwd: Option<String>,
    /// The git worktree this session runs in, or `null` when the project is not a git repository
    /// and the session runs in its root.
    // see docs/research/worktree-git.md §7.
    pub worktree_path: Option<String>,
    /// The branch that worktree is on, `brigadier/<short id>`; `null` with no worktree.
    pub branch: Option<String>,
    /// Model slug, when one was pinned or reported.
    pub model: Option<String>,
    /// Effective persisted execution settings.
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    /// `starting` | `running` | `exited` | `failed`.
    pub status: &'static str,
    /// When the session was started.
    pub started_at_ms: Option<i64>,
    /// When it ended.
    pub ended_at_ms: Option<i64>,
    /// The child's exit code, when it had one.
    pub exit_code: Option<i32>,
    /// Highest `seq` the store has seen for this session.
    pub last_event_seq: u64,
    /// Cumulative token accounting.
    pub usage: Usage,
    /// Cumulative cost as the provider reports it.
    pub cost_usd_cumulative: f64,
}

impl From<&SessionRecord> for SessionView {
    fn from(r: &SessionRecord) -> Self {
        Self {
            session_id: r.session_id.as_str().to_owned(),
            project_id: r.project_id.clone(),
            instance_id: r.instance_id.as_ref().map(|i| i.as_str().to_owned()),
            provider_session_id: r.provider_session_id.clone(),
            cwd: r.cwd.as_deref().map(path_string),
            worktree_path: r.worktree_path.as_deref().map(path_string),
            branch: r.branch.clone(),
            model: r.model.clone(),
            effort: r.effort.clone(),
            permission_mode: r.permission_mode.clone(),
            status: r.status.as_str(),
            started_at_ms: r.started_at.map(to_millis),
            ended_at_ms: r.ended_at.map(to_millis),
            exit_code: r.exit_code,
            last_event_seq: r.last_event_seq,
            usage: r.usage,
            cost_usd_cumulative: r.cost_usd_cumulative,
        }
    }
}

/* ------------------------------------------------------------------- the run
 *
 * `docs/plans/ipc-contract.md` "The run". Five shapes, and one rule that outranks every field in
 * them: **no dollar figure appears here and none may be added** (`docs/vision.md` §6). The owner
 * runs on his own subscription and is never billed per token; the currency is the usage window.
 * `SessionView::cost_usd_cumulative` above is the provider's own number for one session and is
 * deliberately not carried into any of these.
 */

/// One work order of a phase.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct WorkOrderView {
    /// The stored row id. Namespaced `<phase_id>/<lead's own id>`, because a lead's `id` is only
    /// unique inside its own answer (`crates/supervisor/src/loop_/dispatch.rs`).
    pub order_id: String,
    /// The one-line name the plan card shows.
    pub title: String,
    /// The paths this order owns. Read lossily: a `owned_paths_json` that will not parse reads as
    /// no paths rather than failing the whole run view.
    pub owned_paths: Vec<String>,
    /// `pending` | `dispatched` | `reported` | `failed` | `unknown`. **`unknown` is not a
    /// spinner**: it means something moved in that worktree and the harness cannot tell what.
    pub state: &'static str,
    /// The session that ran it, while one exists.
    pub session_id: Option<String>,
    /// The branch checked out in its worktree.
    pub branch: Option<String>,
    /// The worktree the worker ran in.
    pub worktree_path: Option<String>,
    /// The worker's **report**, never its transcript.
    pub report: Option<String>,
}

impl From<&WorkOrderRow> for WorkOrderView {
    fn from(row: &WorkOrderRow) -> Self {
        Self {
            order_id: row.id.clone(),
            title: row.title.clone(),
            owned_paths: serde_json::from_str(&row.owned_paths_json).unwrap_or_default(),
            state: row.state.as_slug(),
            session_id: row.session_id.as_ref().map(|s| s.as_str().to_owned()),
            branch: row.branch.clone(),
            worktree_path: row.worktree_path.as_deref().map(path_string),
            report: row.report.clone(),
        }
    }
}

/// One phase of the checklist, with the orders dispatched for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct PhaseView {
    /// Stable phase id.
    pub phase_id: String,
    /// Position in the checklist.
    pub ordinal: u32,
    /// The one-line name.
    pub title: String,
    /// What "done" means, in the owner's terms.
    pub definition_of_done: String,
    /// The command whose exit code is the gate. **`null` is the information**: a phase with no
    /// verify command cannot go green through a gate, and nothing here fabricates one.
    pub verify_command: Option<String>,
    /// `pending` | `running` | `green` | `blocked`.
    pub state: &'static str,
    /// How many attempts the phase has had.
    pub attempts: u32,
    /// The commit this phase's work branches from.
    pub base_sha: Option<String>,
    /// The commit the green gate produced.
    pub commit_sha: Option<String>,
    /// The gate's answer. `0` is the only value that means green.
    pub last_exit_code: Option<i32>,
    /// A bounded excerpt, bounded again by the store. **Never a log tail** — the verify command's
    /// output goes to a file and to a worker's window, never onto this wire.
    pub last_evidence: Option<String>,
    /// The orders dispatched for this phase, oldest dispatch first.
    pub orders: Vec<WorkOrderView>,
}

impl PhaseView {
    /// One phase and the orders the store holds for it.
    pub(crate) fn new(row: &PhaseRow, orders: &[WorkOrderRow]) -> Self {
        Self {
            phase_id: row.id.clone(),
            ordinal: row.ordinal,
            title: row.title.clone(),
            definition_of_done: row.definition_of_done.clone(),
            verify_command: row.verify_command.clone(),
            state: row.state.as_slug(),
            attempts: row.attempts,
            base_sha: row.base_sha.clone(),
            commit_sha: row.commit_sha.clone(),
            last_exit_code: row.last_exit_code,
            last_evidence: row.last_evidence.clone(),
            orders: orders.iter().map(WorkOrderView::from).collect(),
        }
    }
}

/// One thing the planner did not know.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct UnknownView {
    /// Stable id.
    pub unknown_id: String,
    /// `owner` | `research`.
    pub bin: &'static str,
    /// The question as it was asked.
    pub question: String,
    /// `open` | `answered` | `skipped`.
    pub state: &'static str,
    /// Whether the owner's "just go" is what skipped it.
    pub skipped_for_just_go: bool,
}

impl From<&UnknownRow> for UnknownView {
    fn from(row: &UnknownRow) -> Self {
        Self {
            unknown_id: row.id.clone(),
            bin: row.bin.as_slug(),
            question: row.question.clone(),
            state: row.state.as_slug(),
            skipped_for_just_go: row.skipped_for_just_go,
        }
    }
}

/// One run: the goal, where it is, and every phase under it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct RunView {
    /// The plan this run works through.
    pub plan_id: String,
    /// Which project.
    pub project_id: String,
    /// The owner's stated intent, verbatim.
    pub goal: String,
    /// `draft` | `approved` | `done` | `abandoned`. See [`run_status`] — two of the four are
    /// **derived here** because the store has no op that writes them.
    pub status: &'static str,
    /// How many times the plan has been revised inside the approved goal.
    pub revision: u32,
    /// When the plan was first written.
    pub created_at_ms: i64,
    /// When the owner approved the envelope.
    pub approved_at_ms: Option<i64>,
    /// The checklist, in `ordinal` order.
    pub phases: Vec<PhaseView>,
    /// Everything the planner did not know — answered, skipped and outstanding alike.
    pub unknowns: Vec<UnknownView>,
}

/// What a run's status is on the wire, which is **not** simply `plans.status`.
///
/// Two of the contract's four values cannot come out of the store at all, and pretending
/// otherwise would leave the run surface with no way forward:
///
/// - **`done`.** The store's only status transition is `plan_approved` (`draft` → `approved`,
///   `crates/store/src/writer.rs`); there is no `plan_done`, and the loop says so in as many
///   words — *"The plan row stays `approved`, and that is the store's shape, not an oversight …
///   A run is finished when every phase is `green`, which is what the plan card reads anyway"*
///   (`crates/supervisor/src/loop_/mod.rs`). So a finished run is derived from its phases. Left
///   undone, `runIsLive` in `src/wire.ts` reads a finished run as live and the composer offers
///   **Stop** for a run that is over, permanently.
/// - **`abandoned`.** [`crate::commands::stop_run`] has nothing to write it with either, so the
///   stop is remembered **in memory for this launch only** (`crate::state::Ready`). After a
///   restart a stopped run reads `approved` again and one further press of Stop re-marks it.
///   That is a real gap, not a design; it closes the day the store grows a status op.
///
/// The stored value is otherwise passed through, including a stored `done` or `abandoned` that a
/// future writer puts there.
pub(crate) fn run_status(plan: &PlanRow, phases: &[PhaseRow], stopped: bool) -> &'static str {
    if stopped {
        return "abandoned";
    }
    if !phases.is_empty() && phases.iter().all(|p| p.state == PhaseState::Green) {
        return "done";
    }
    plan.status.as_slug()
}

impl RunView {
    /// Assemble one run from the rows the store holds for it.
    ///
    /// `orders` is parallel to `phases`: `orders[i]` are the work orders of `phases[i]`.
    pub(crate) fn new(
        plan: &PlanRow,
        phases: &[PhaseRow],
        orders: &[Vec<WorkOrderRow>],
        unknowns: &[UnknownRow],
        stopped: bool,
    ) -> Self {
        Self {
            plan_id: plan.id.clone(),
            project_id: plan.project_id.clone(),
            goal: plan.goal.clone(),
            status: run_status(plan, phases, stopped),
            revision: plan.revision,
            created_at_ms: to_millis(plan.created_at),
            approved_at_ms: plan.approved_at.map(to_millis),
            phases: phases
                .iter()
                .enumerate()
                .map(|(i, p)| PhaseView::new(p, orders.get(i).map_or(&[][..], Vec::as_slice)))
                .collect(),
            unknowns: unknowns.iter().map(UnknownView::from).collect(),
        }
    }
}

/// One intent nothing has answered.
///
/// `kind` is a **pass-through slug, not a closed set on the wire** — the same treatment
/// `permission_mode` gets, and the opposite of `mcp` — because a build that adds a kind must not
/// break an older webview.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct IntentView {
    /// The id minted before the effect.
    pub intent_id: String,
    /// What was about to happen, as the stored slug, whatever this build makes of it.
    pub kind: String,
    /// Always the literal `"unknown"`. See [`IntentView::from`].
    pub state: &'static str,
    /// The session, once one was known.
    pub session_id: Option<String>,
    /// Owning project, when the effect belonged to one.
    pub project_id: Option<String>,
    /// When the row was opened.
    pub opened_at_ms: i64,
    /// What the effect acts on: a worktree path, a branch, a ref, a request id.
    pub subject: Option<String>,
    /// The command and the value that decided it, bounded by the store.
    pub evidence: Option<String>,
}

impl From<&IntentRecord> for IntentView {
    /// **`state` is the literal `"unknown"` for an `open` row too**, and that is the contract's
    /// own shape rather than a rounding: `unsettled_intents` returns `open` and `unknown` rows,
    /// `src/wire.ts` types `IntentState` as the single value `"unknown"`, and the two say the
    /// same operational thing — the harness cannot tell whether the effect happened. An `open`
    /// row is one nothing ever settled; a closed `unknown` one is a row a postcondition or the
    /// owner could not resolve. Neither authorizes anything.
    fn from(row: &IntentRecord) -> Self {
        Self {
            intent_id: row.id.clone(),
            kind: row.kind.as_str().to_owned(),
            state: "unknown",
            session_id: row.session_id.as_ref().map(|s| s.as_str().to_owned()),
            project_id: row.project_id.clone(),
            opened_at_ms: to_millis(row.opened_at),
            subject: row.subject.clone(),
            evidence: row.evidence.clone(),
        }
    }
}

/// What the turn-start command hands back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct TurnStarted {
    /// The id the session's events will carry.
    pub turn_id: String,
}

/// One window of the front end's own frame-rate meter.
///
/// Round-tripped verbatim: it is deserialized from the webview and appended to
/// `<data_dir>/frame-stats.ndjson` as one line.
///
/// Every field is `f64`, counts included. JavaScript has one number type, and a `u64` field that
/// receives `3.0000000001` from a `performance.now()` derivation fails the whole command with an
/// argument-deserialization error the operator cannot act on. Precision is irrelevant here.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct FrameStats {
    /// Start of the measurement window.
    pub window_start_ms: f64,
    /// The display's refresh rate as the page measured it.
    pub hz: f64,
    /// Frames observed in the window.
    pub frames: f64,
    /// Frames the page believes it missed.
    pub dropped: f64,
    /// Median frame time.
    pub p50_ms: f64,
    /// 95th-percentile frame time.
    pub p95_ms: f64,
    /// 99th-percentile frame time.
    pub p99_ms: f64,
    /// Worst frame time in the window.
    pub worst_ms: f64,
    /// Longest run of consecutive dropped frames.
    pub longest_drop_run: f64,
    /// DOM node count at the end of the window.
    pub dom_nodes: f64,
}

/// One paint the page timed, on its way to `<data_dir>/paint.ndjson`.
///
/// Internally tagged on `"kind"` in snake_case, the way `Event` is tagged on `"type"` in
/// `crates/core/src/event.rs`.
///
/// Every number here is `f64` for the same reason [`FrameStats`] gives: JavaScript has one number
/// type, and a `u64` field that receives `3.0000000001` out of a `performance.now()` derivation
/// fails the whole command with an argument-deserialization error the operator cannot act on.
/// That applies to anything count-shaped that is ever added here, not just to durations.
///
/// The instrument that produces these is `src/paint.ts`; the shapes are fixed by
/// `docs/plans/ipc-contract.md`.
// see docs/research/perceived-performance.md §5.3.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum PaintReport {
    /// The page's first contentful paint, as `performance.timeOrigin + entry.startTime`.
    ///
    /// There is no `first-paint` entry in this WebKit — only `first-contentful-paint`
    /// (**measured**, §5.3) — and this is a **render** timestamp, not a presentation timestamp:
    /// `LargestContentfulPaint.presentationTime` "always returns null" here, so the photons land
    /// some frames after this number.
    Fcp {
        /// Epoch milliseconds of the first contentful paint.
        epoch_ms: f64,
    },
    /// One interaction → painted span: a `performance.mark`, a double `requestAnimationFrame`
    /// after the commit that paints the result, then a `performance.measure`.
    ///
    /// `label` is what names a budget at the call site — B4 (session switch), B6 (scrollback
    /// filled in), B7 (button acknowledged) in `docs/vision.md` §9. All three are still guesses;
    /// this variant is the instrument that could turn one into a number, and nothing calls it yet.
    Interaction {
        /// The call site's name for the interaction.
        label: String,
        /// Epoch milliseconds at the mark.
        start_epoch_ms: f64,
        /// Milliseconds from the mark to the frame after the one that painted the result.
        duration_ms: f64,
    },
}

/// One line of `<data_dir>/paint.ndjson`: the page's report plus the clock it is measured against.
///
/// `process_start_epoch_ms` rides on every line so `main()` → FCP is recomputable from the file
/// alone, without re-running anything. `main_to_fcp_ms` is the subtraction done for the reader; it
/// is never the only copy of the answer, because a derived number with its inputs discarded cannot
/// be checked.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct PaintLine {
    /// Epoch milliseconds at the top of `main()` (`crate::mark_process_start`).
    pub process_start_epoch_ms: f64,
    /// `epoch_ms - process_start_epoch_ms` for an `fcp` line; `null` for anything else.
    pub main_to_fcp_ms: Option<f64>,
    /// The report exactly as the page sent it.
    #[serde(flatten)]
    pub report: PaintReport,
}

/// The models this build offers, cheapest first, with the CLI's own aliases after them.
///
/// Sources, all checked on 2026-09-02:
/// - `claude-api` skill "Current Models" table (cached 2026-06-24): `claude-fable-5-1`,
///   `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5` at $1/$5 per MTok — the cheapest
///   model on the list, which is why it is the default here.
/// - `strings` over the installed CLI (`~/.local/share/claude/versions/2.1.258`) lists both
///   `claude-haiku-4-5` and `claude-haiku-4-5-20251001`; the undated id is the one this harness
///   pins. It is the string the live spike ran 11 sessions with
///   (`docs/research/claude-direct-spike.md`) and the one `crates/core/tests/claude_adapter.rs`
///   defaults to, and the `claude-api` skill says never to append a date suffix to a model id.
/// - `claude --help` (2.1.258): *"Provide an alias for the latest model (e.g. 'fable', 'opus',
///   or 'sonnet') or a model's full name"*; the binary's own literal set is
///   `"fable" "haiku" "opus" "opus[1m]" "sonnet" "sonnet[1m]"`.
///
/// The `initialize` response carries the account's own model list (`docs/vision.md` §4), but it is
/// not wired through the driver yet, so this is a fixed list.
pub(crate) fn models() -> Vec<ModelInfo> {
    let rows: [(&str, &str, bool); 8] = [
        ("claude-haiku-4-5", "Haiku 4.5 — cheapest", true),
        ("claude-sonnet-5", "Sonnet 5", false),
        ("claude-opus-5", "Opus 5", false),
        ("claude-fable-5-1", "Fable 5.1 — most expensive", false),
        ("haiku", "haiku (CLI alias, latest)", false),
        ("sonnet", "sonnet (CLI alias, latest)", false),
        ("opus", "opus (CLI alias, latest)", false),
        ("fable", "fable (CLI alias, latest)", false),
    ];
    rows.iter()
        .map(|(id, label, is_default)| ModelInfo {
            id: (*id).to_owned(),
            label: (*label).to_owned(),
            is_default: *is_default,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exactly_one_model_is_the_default_and_it_is_the_cheapest_one() {
        let models = models();
        let defaults: Vec<&ModelInfo> = models.iter().filter(|m| m.is_default).collect();
        assert_eq!(defaults.len(), 1, "exactly one default");
        assert_eq!(defaults[0].id, "claude-haiku-4-5");
    }

    /// `mcp` crosses the wire as a bare slug, `"off"` or `"inherit"`, next to the four fields
    /// the contract already pins. see docs/plans/ipc-contract.md "### set_project_mcp".
    #[test]
    fn a_project_view_carries_its_mcp_policy_as_a_bare_string() {
        let row = ProjectRow {
            id: "p1".to_owned(),
            name: "brigadier".to_owned(),
            root_path: "/repo".into(),
            created_at: UNIX_EPOCH + std::time::Duration::from_millis(1_700_000_000_000),
            mcp: McpPolicy::Inherit,
        };
        let json = serde_json::to_string(&ProjectView::from(&row)).expect("ser");
        assert_eq!(
            json,
            r#"{"id":"p1","name":"brigadier","root_path":"/repo","created_at_ms":1700000000000,"mcp":"inherit"}"#
        );
        let off = ProjectView::from(&ProjectRow {
            mcp: McpPolicy::Off,
            ..row
        });
        assert!(serde_json::to_string(&off)
            .expect("ser")
            .ends_with(r#""mcp":"off"}"#));
    }

    #[test]
    fn the_default_flag_is_named_default_on_the_wire() {
        let json = serde_json::to_string(&models()[0]).expect("ser");
        assert!(json.contains(r#""default":true"#), "{json}");
        assert!(json.contains(r#""id":"claude-haiku-4-5""#), "{json}");
    }

    #[test]
    fn an_fcp_report_round_trips_tagged_on_kind() {
        let report = PaintReport::Fcp {
            epoch_ms: 1_788_355_265_312.0,
        };
        let json = serde_json::to_string(&report).expect("ser");
        assert_eq!(json, r#"{"kind":"fcp","epoch_ms":1788355265312.0}"#);
        assert_eq!(
            serde_json::from_str::<PaintReport>(&json).expect("de"),
            report
        );
    }

    #[test]
    fn an_interaction_report_round_trips_tagged_on_kind() {
        let report = PaintReport::Interaction {
            label: "session_switch".to_owned(),
            start_epoch_ms: 1_788_355_265_312.0,
            duration_ms: 42.5,
        };
        let json = serde_json::to_string(&report).expect("ser");
        assert!(
            json.starts_with(r#"{"kind":"interaction","label":"session_switch""#),
            "{json}"
        );
        assert_eq!(
            serde_json::from_str::<PaintReport>(&json).expect("de"),
            report
        );
    }

    /// Every number field is `f64`, so a value that arrived as a `performance.now()` derivation
    /// rather than an integer deserializes instead of failing the whole command.
    #[test]
    fn a_count_shaped_number_with_a_fractional_tail_still_deserializes() {
        let json = r#"{"kind":"interaction","label":"b7","start_epoch_ms":1788355265312.0,"duration_ms":3.0000000001}"#;
        let report = serde_json::from_str::<PaintReport>(json).expect("de");
        match report {
            PaintReport::Interaction { duration_ms, .. } => {
                assert!((duration_ms - 3.0).abs() < 1e-6, "{duration_ms}");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn a_paint_line_carries_the_raw_inputs_beside_the_delta() {
        let line = PaintLine {
            process_start_epoch_ms: 1_788_355_265_000.0,
            main_to_fcp_ms: Some(312.0),
            report: PaintReport::Fcp {
                epoch_ms: 1_788_355_265_312.0,
            },
        };
        let json = serde_json::to_string(&line).expect("ser");
        assert!(
            json.contains(r#""process_start_epoch_ms":1788355265000.0"#),
            "{json}"
        );
        assert!(json.contains(r#""main_to_fcp_ms":312.0"#), "{json}");
        assert!(json.contains(r#""kind":"fcp""#), "{json}");
        assert!(json.contains(r#""epoch_ms":1788355265312.0"#), "{json}");
    }

    /* --------------------------------------------------------------- the run */

    fn plan() -> PlanRow {
        let mut plan = PlanRow::new(
            "pl-1",
            "p1",
            "ship the run surface",
            UNIX_EPOCH + std::time::Duration::from_millis(1_700_000_000_000),
        );
        plan.status = brigadier_store::plan::PlanStatus::Approved;
        plan.approved_at = Some(UNIX_EPOCH + std::time::Duration::from_millis(1_700_000_001_000));
        plan
    }

    fn phase(id: &str, ordinal: u32, state: PhaseState) -> PhaseRow {
        let mut row = PhaseRow::new(id, "pl-1", ordinal, format!("phase {ordinal}"));
        row.state = state;
        row
    }

    /// The store has no op that writes `plans.status = 'done'`, so a finished run would read
    /// `approved` — and `runIsLive` in `src/wire.ts` would offer **Stop** for a run that is over,
    /// for good.
    #[test]
    fn every_phase_green_is_what_makes_a_run_done() {
        let phases = [
            phase("ph1", 0, PhaseState::Green),
            phase("ph2", 1, PhaseState::Green),
        ];
        assert_eq!(run_status(&plan(), &phases, false), "done");
    }

    #[test]
    fn one_phase_short_of_green_is_still_the_stored_status() {
        let phases = [
            phase("ph1", 0, PhaseState::Green),
            phase("ph2", 1, PhaseState::Blocked),
        ];
        assert_eq!(run_status(&plan(), &phases, false), "approved");
        // A plan with no phases yet is not finished either: the planner call has not landed.
        assert_eq!(run_status(&plan(), &[], false), "approved");
    }

    /// The stop the store cannot record. `abandoned` outranks everything, including a plan that
    /// went green after the owner pressed Stop — the run is over either way, and `abandoned` is
    /// the one that says a human ended it.
    #[test]
    fn a_stop_this_launch_recorded_reads_abandoned() {
        assert_eq!(run_status(&plan(), &[], true), "abandoned");
        let green = [phase("ph1", 0, PhaseState::Green)];
        assert_eq!(run_status(&plan(), &green, true), "abandoned");
    }

    /// The whole shape, against the field names `src/wire.ts` was written from.
    #[test]
    fn a_run_view_carries_the_contracts_field_names() {
        let mut ph = phase("ph1", 0, PhaseState::Green);
        ph.definition_of_done = "the gate exits 0".to_owned();
        ph.verify_command = Some("sh verify.sh".to_owned());
        ph.attempts = 2;
        ph.base_sha = Some("aaa".to_owned());
        ph.commit_sha = Some("bbb".to_owned());
        ph.last_exit_code = Some(0);
        ph.last_evidence = Some("gate green".to_owned());

        let mut order = WorkOrderRow::new("ph1/o1", "ph1", "write the thing");
        order.owned_paths_json = r#"["src/a.rs","src/b.rs"]"#.to_owned();
        order.branch = Some("brigadier/abcd1234".to_owned());
        order.worktree_path = Some(std::path::PathBuf::from(
            "/repo/.brigadier/worktrees/abcd1234",
        ));
        order.report = Some("done".to_owned());

        let unknown = UnknownRow::new(
            "un-1",
            "pl-1",
            brigadier_store::plan::UnknownBin::Owner,
            "one pull request per phase?",
            UNIX_EPOCH,
        );

        let view = RunView::new(&plan(), &[ph], &[vec![order]], &[unknown], false);
        let json = serde_json::to_string(&view).expect("ser");
        for key in [
            r#""plan_id":"pl-1""#,
            r#""project_id":"p1""#,
            r#""status":"done""#,
            r#""revision":0"#,
            r#""created_at_ms":1700000000000"#,
            r#""approved_at_ms":1700000001000"#,
            r#""phase_id":"ph1""#,
            r#""ordinal":0"#,
            r#""definition_of_done":"the gate exits 0""#,
            r#""verify_command":"sh verify.sh""#,
            r#""attempts":2"#,
            r#""base_sha":"aaa""#,
            r#""commit_sha":"bbb""#,
            r#""last_exit_code":0"#,
            r#""last_evidence":"gate green""#,
            r#""order_id":"ph1/o1""#,
            r#""owned_paths":["src/a.rs","src/b.rs"]"#,
            r#""state":"pending""#,
            r#""branch":"brigadier/abcd1234""#,
            r#""unknown_id":"un-1""#,
            r#""bin":"owner""#,
            r#""skipped_for_just_go":false"#,
        ] {
            assert!(json.contains(key), "{key} missing from {json}");
        }
    }

    /// `docs/vision.md` §6, enforced rather than remembered: the owner runs on his own
    /// subscription and is never billed per token, so a dollar figure on this wire would be a
    /// number he is never charged. `SessionView` carries one; none of the run shapes may.
    #[test]
    fn no_run_shape_carries_a_dollar_figure() {
        let view = RunView::new(
            &plan(),
            &[phase("ph1", 0, PhaseState::Running)],
            &[vec![WorkOrderRow::new("ph1/o1", "ph1", "t")]],
            &[],
            false,
        );
        let json = serde_json::to_string(&view).expect("ser");
        for word in ["cost", "usd", "dollar", "price", "spend"] {
            assert!(
                !json.to_lowercase().contains(word),
                "{word} appears in {json}"
            );
        }
    }

    /// A phase with no verify command renders the null; nothing substitutes a placeholder for a
    /// gate that does not exist.
    #[test]
    fn a_phase_with_no_gate_says_so_on_the_wire() {
        let json =
            serde_json::to_string(&PhaseView::new(&phase("ph1", 0, PhaseState::Pending), &[]))
                .expect("ser");
        assert!(json.contains(r#""verify_command":null"#), "{json}");
        assert!(json.contains(r#""orders":[]"#), "{json}");
    }

    /// The paths column is bounded JSON text and may be the store's oversized placeholder, so it
    /// is read lossily: no paths rather than a failed command.
    #[test]
    fn unparseable_owned_paths_read_as_none_rather_than_failing() {
        let mut order = WorkOrderRow::new("ph1/o1", "ph1", "t");
        order.owned_paths_json = r#"{"type":"oversized"}"#.to_owned();
        assert!(WorkOrderView::from(&order).owned_paths.is_empty());
    }

    #[test]
    fn an_intent_view_passes_its_kind_through_and_always_reads_unknown() {
        let row = brigadier_store::intents::IntentRecord {
            id: "i1".to_owned(),
            run_id: "r1".to_owned(),
            // A kind from a build newer than this one: printed as itself, never collapsed.
            kind: brigadier_store::intents::IntentKind::new("some_future_kind"),
            state: brigadier_store::IntentState::Open,
            project_id: Some("p1".to_owned()),
            session_id: None,
            opened_at: UNIX_EPOCH + std::time::Duration::from_millis(1_700_000_000_000),
            closed_at: None,
            subject: Some("/repo/.brigadier/worktrees/abcd1234".to_owned()),
            baseline: None,
            detail_json: "{}".to_owned(),
            outcome: None,
            evidence: None,
        };
        let json = serde_json::to_string(&IntentView::from(&row)).expect("ser");
        assert!(json.contains(r#""kind":"some_future_kind""#), "{json}");
        // `open` on the row; `unknown` on the wire, which is the only value `src/wire.ts` types.
        assert!(json.contains(r#""state":"unknown""#), "{json}");
        assert!(json.contains(r#""opened_at_ms":1700000000000"#), "{json}");
        assert!(json.contains(r#""session_id":null"#), "{json}");
    }

    #[test]
    fn an_interaction_line_has_no_fcp_delta() {
        let line = PaintLine {
            process_start_epoch_ms: 1_788_355_265_000.0,
            main_to_fcp_ms: None,
            report: PaintReport::Interaction {
                label: "b4".to_owned(),
                start_epoch_ms: 1_788_355_266_000.0,
                duration_ms: 17.0,
            },
        };
        let json = serde_json::to_string(&line).expect("ser");
        assert!(json.contains(r#""main_to_fcp_ms":null"#), "{json}");
    }
}
