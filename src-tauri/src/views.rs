//! The serde shapes the commands return, verbatim from `docs/plans/ipc-contract.md`.
//!
//! Every timestamp is milliseconds since the Unix epoch with a `_ms` suffix; every id is a
//! string. Nothing here is a re-modelling of a core type for its own sake — `Usage`,
//! `ApprovalView`, `FeedRowWire` and `Envelope` cross the wire in their own crates' shapes.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use brigadier_core::driver::McpPolicy;
use brigadier_core::event::Usage;
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
        let off = ProjectView::from(&ProjectRow { mcp: McpPolicy::Off, ..row });
        assert!(serde_json::to_string(&off).expect("ser").ends_with(r#""mcp":"off"}"#));
    }

    #[test]
    fn the_default_flag_is_named_default_on_the_wire() {
        let json = serde_json::to_string(&models()[0]).expect("ser");
        assert!(json.contains(r#""default":true"#), "{json}");
        assert!(json.contains(r#""id":"claude-haiku-4-5""#), "{json}");
    }

    #[test]
    fn an_fcp_report_round_trips_tagged_on_kind() {
        let report = PaintReport::Fcp { epoch_ms: 1_788_355_265_312.0 };
        let json = serde_json::to_string(&report).expect("ser");
        assert_eq!(json, r#"{"kind":"fcp","epoch_ms":1788355265312.0}"#);
        assert_eq!(serde_json::from_str::<PaintReport>(&json).expect("de"), report);
    }

    #[test]
    fn an_interaction_report_round_trips_tagged_on_kind() {
        let report = PaintReport::Interaction {
            label: "session_switch".to_owned(),
            start_epoch_ms: 1_788_355_265_312.0,
            duration_ms: 42.5,
        };
        let json = serde_json::to_string(&report).expect("ser");
        assert!(json.starts_with(r#"{"kind":"interaction","label":"session_switch""#), "{json}");
        assert_eq!(serde_json::from_str::<PaintReport>(&json).expect("de"), report);
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
            report: PaintReport::Fcp { epoch_ms: 1_788_355_265_312.0 },
        };
        let json = serde_json::to_string(&line).expect("ser");
        assert!(json.contains(r#""process_start_epoch_ms":1788355265000.0"#), "{json}");
        assert!(json.contains(r#""main_to_fcp_ms":312.0"#), "{json}");
        assert!(json.contains(r#""kind":"fcp""#), "{json}");
        assert!(json.contains(r#""epoch_ms":1788355265312.0"#), "{json}");
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
