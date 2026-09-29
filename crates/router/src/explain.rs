//! Why a model was chosen: the short line on the worker card and the breakdown behind it.

use brigadier_providers::ProviderKind;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One part of a model's score.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Factor {
    /// What it is ("registry strength for implementation", "5 of 6 reviews passed first time
    /// here", "Codex's weekly window projected at 94%").
    pub label: String,
    /// What it added to (or took from) the score.
    pub delta: f64,
}

/// A model that was considered and not chosen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Alternative {
    pub provider: ProviderKind,
    pub model: String,
    /// Its score, when it was eligible.
    pub score: Option<f64>,
    /// Why it lost or was not eligible ("scored lower", "below the task's quality floor",
    /// "your rule: never for frontend", "Claude's 5-hour window is used up until 21:10").
    pub why_not: String,
}

/// The reasoning behind a routing choice, for the worker card's details.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Explanation {
    /// The chosen model's score.
    pub score: Option<f64>,
    pub factors: Vec<Factor>,
    /// The runners-up, best first (a few).
    pub alternatives: Vec<Alternative>,
    /// A user rule decided or constrained the choice (its text).
    pub rule: Option<String>,
    /// The model runs as a trial (an unrated model on a low-risk task).
    pub trial: bool,
    /// Quota balancing moved the work away from a hot provider.
    pub balancing: bool,
}
