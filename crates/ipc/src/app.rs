//! Types shared by the desktop shell (Tauri) and its webview. The webview never talks to the
//! daemon directly: the shell is the only IPC client and forwards to the UI over a channel.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::metrics::{BudgetId, DaemonMetrics, LatencySummary};
use crate::protocol::{DaemonInfo, EventEnvelope};

/// Pushed from the shell to the webview.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BridgeEvent {
    /// Connected (or reconnected) to the daemon.
    Connected {
        daemon: DaemonInfo,
        last_seq: i64,
    },
    /// Lost the daemon; the shell is reconnecting (relaunching it if needed).
    Disconnected {
        reason: String,
    },
    Event {
        event: EventEnvelope,
    },
    /// Events were missed; reload state from the daemon.
    Lagged {
        resume_after: i64,
    },
    Metrics {
        metrics: DaemonMetrics,
    },
    /// The window was hidden or shown; pause sampling while hidden.
    WindowVisibility {
        visible: bool,
    },
}

/// Static facts about this app launch.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    /// When the OS started this process, in ms since the Unix epoch.
    pub process_start_ms: f64,
    /// Running the launch smoke check (`--smoke`).
    pub smoke: bool,
    /// Multiplier applied to timing budgets (1 locally, higher on shared CI runners).
    pub budget_tolerance: f64,
}

/// What the webview measured during the smoke check.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UiMeasurements {
    pub idle_rss_bytes: u64,
    pub ingest_to_paint: LatencySummary,
    /// Gaps between animation frames while the burst was painting.
    pub frame_gaps: LatencySummary,
    /// Where the longest frame gap fell and the costliest event flush, to explain a stall.
    pub stall_context: String,
    /// Startup milestones in ms since process start (webview, script, connected, catalog, paint).
    pub startup: String,
    pub probes_expected: u32,
    pub probes_painted: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus {
    Pass,
    Fail,
    /// The budget covers a feature from a later phase.
    NotApplicable,
}

/// One budget evaluated by the smoke check.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BudgetCheck {
    pub id: BudgetId,
    pub metric: String,
    pub target: String,
    pub measured: Option<f64>,
    /// The limit actually applied, tolerance included.
    pub limit: Option<f64>,
    pub status: CheckStatus,
    pub note: String,
}

/// The smoke check's verdict.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SmokeReport {
    pub passed: bool,
    pub platform: String,
    pub budget_tolerance: f64,
    pub cold_start_ms: f64,
    pub checks: Vec<BudgetCheck>,
}
