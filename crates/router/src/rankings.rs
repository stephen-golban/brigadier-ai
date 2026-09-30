//! The user's manual rankings: per kind of work (and optionally per area and project), an
//! ordered list of models routing tries top-down instead of scoring. See the crate docs for
//! where they stand among the other rules.

use brigadier_providers::ProviderKind;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::overrides::OverrideTarget;
use crate::{Area, TaskCategory, table};

/// One kind of work's ranking, or an area override of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Ranking {
    pub id: String,
    pub category: TaskCategory,
    /// Tasks touching any of these areas (an area override); empty: the kind of work's own row.
    #[serde(default)]
    pub areas: Vec<Area>,
    /// Only in this project; absent: everywhere.
    #[serde(default)]
    pub project_id: Option<String>,
    /// The list decides. Off: routing scores models here (a project's row can be Automatic
    /// while the one everywhere is Manual); the list is kept for switching back.
    pub manual: bool,
    /// Tried top-down.
    #[serde(default)]
    pub entries: Vec<RankedEntry>,
    /// Only these: when none of them can take the task, it waits for them instead of going to
    /// another model.
    #[serde(default)]
    pub only: bool,
    pub updated_at_ms: i64,
}

/// One place in a ranking.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RankedEntry {
    /// One model; a family (its newest model that can run); or a vendor (its best-scored
    /// model that can run).
    pub target: OverrideTarget,
    /// The reasoning effort; absent: routing's effort for the kind of work. Never above `high`.
    #[serde(default)]
    pub effort: Option<String>,
}

/// How a manual ranking decided (or failed to decide) a choice, kept with the routing
/// explanation so a worker card shows it as it was.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RankingUse {
    /// The ranking as the user would name it ("your implementation ranking for frontend").
    pub text: String,
    /// The place that ran the task (1-based); absent when no ranked model could take it.
    pub position: Option<u32>,
    /// Places in the list.
    pub places: u32,
    /// Only these: the task waits rather than go to other models.
    pub only: bool,
    /// The places above the one that ran (all of them when none did), each with why it was
    /// passed over.
    pub skipped: Vec<RankedPlace>,
}

/// One place of a ranking as routing found it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RankedPlace {
    /// 1-based.
    pub position: u32,
    pub target: OverrideTarget,
    /// The model it comes to, when one can run (a family's newest, a vendor's best).
    pub model: Option<String>,
    /// It took the task.
    pub chosen: bool,
    /// Why it can't take the task, when it can't.
    pub why: Option<String>,
    /// When the limit that keeps it out resets, if a limit does.
    pub resets_at_ms: Option<i64>,
}

/// The ranking that applies to a task, if any: the most specific of those for its category,
/// project and areas (a project's before one everywhere, an area override before the row),
/// the first in the list among equals. An area override that is switched off doesn't apply; a
/// row that is switched off does (routing scores there).
pub fn ranking_for<'a>(
    rankings: &'a [Ranking],
    category: TaskCategory,
    areas: &[Area],
    project_id: Option<&str>,
) -> Option<&'a Ranking> {
    let specificity = |ranking: &Ranking| {
        u8::from(ranking.project_id.is_some()) * 2 + u8::from(!ranking.areas.is_empty())
    };
    let mut best: Option<&Ranking> = None;
    for ranking in rankings {
        let applies = ranking.category == category
            && ranking
                .project_id
                .as_deref()
                .is_none_or(|project| project_id == Some(project))
            && (ranking.areas.is_empty()
                || (ranking.manual && ranking.areas.iter().any(|area| areas.contains(area))));
        if applies && best.is_none_or(|best| specificity(ranking) > specificity(best)) {
            best = Some(ranking);
        }
    }
    best
}

/// "your implementation ranking for frontend in this project".
pub fn ranking_text(ranking: &Ranking) -> String {
    let mut text = format!("your {} ranking", table::row(ranking.category).purpose);
    if !ranking.areas.is_empty() {
        text.push_str(" for ");
        text.push_str(&crate::decide::areas_text(&ranking.areas));
    }
    if ranking.project_id.is_some() {
        text.push_str(" in this project");
    }
    text
}

/// A ranked place as the user would name it: "Claude opus (newest)", "any Codex model".
pub fn target_text(target: &OverrideTarget) -> String {
    let name = |provider: ProviderKind| provider.label();
    match target {
        OverrideTarget::Vendor { provider } => format!("any {} model", name(*provider)),
        OverrideTarget::Family { provider, family } => {
            format!("{} {family} (newest)", name(*provider))
        }
        OverrideTarget::Model { provider, id } => format!("{} {id}", name(*provider)),
    }
}
