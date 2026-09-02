//! The serde shapes the commands return, verbatim from `docs/plans/ipc-contract.md`.
//!
//! Every timestamp is milliseconds since the Unix epoch with a `_ms` suffix; every id is a
//! string. Nothing here is a re-modelling of a core type for its own sake — `Usage`,
//! `ApprovalView`, `FeedRowWire` and `Envelope` cross the wire in their own crates' shapes.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

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
}

impl From<&ProjectRow> for ProjectView {
    fn from(row: &ProjectRow) -> Self {
        Self {
            id: row.id.clone(),
            name: row.name.clone(),
            root_path: path_string(&row.root_path),
            created_at_ms: to_millis(row.created_at),
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
    /// Working directory of the child.
    pub cwd: Option<String>,
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
/// `supportedModels` is not wired on the driver yet, so this is a fixed list
/// (`docs/plans/next-session.md` step 5).
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

    #[test]
    fn the_default_flag_is_named_default_on_the_wire() {
        let json = serde_json::to_string(&models()[0]).expect("ser");
        assert!(json.contains(r#""default":true"#), "{json}");
        assert!(json.contains(r#""id":"claude-haiku-4-5""#), "{json}");
    }
}
