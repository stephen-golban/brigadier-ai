//! Choosing the provider, model and reasoning effort for each piece of work (docs/PLAN.md §6
//! Phase 5). The orchestrator's own vendor is never an input (§2 principle 3): a query carries
//! the task, what each provider can offer now, the user's rules and what outcomes taught.
//!
//! # Registry
//!
//! `registry/models.json` ([`Registry`]) records per model its tier, strengths per task category
//! (0–10: how well suited it is, weighing quality against cost), area modifiers (±2), efforts,
//! context window and modalities. The app ships a copy ([`Registry::bundled`]) and the daemon
//! downloads newer revisions ([`Registry::parse`], [`Registry::is_newer_than`]). Every copy
//! passes the same bounds (see [`load`]'s docs): no Fable, efforts only up to `high`, only CLIs
//! Brigadier drives, only capabilities their adapters implement.
//!
//! # Merge
//!
//! [`merge()`] joins each CLI's live list with the registry: a model is **curated** (its own
//! entry), **inherited** (a newer member of a family entry, `gpt-6.1-sol` from `sol`),
//! **researched** (placed by a research note, within ±2 of unrated) or **unknown** (tier
//! unrated, strength 5). Fable models are listed but excluded.
//!
//! # Eligibility
//!
//! A model may take a task when all of these hold ([`decide`]):
//! - it isn't Fable, and its provider is logged in;
//! - **no confirmed limit**: a provider limit (usage window, spend control, credits), a window
//!   that limits it at 97% used, or its own scoped bucket used up. A limit is a hard exclusion,
//!   never a large penalty;
//! - it isn't excluded by the query (it or its provider just failed on the task);
//! - no applicable `never` rule names it, and every applicable `only` rule allows it;
//! - it meets the task's needs (image input, image generation, context window);
//! - its tier is at or above the task's quality floor ([`default_floor`]);
//! - for reviews, its vendor differs from the author's when another vendor can review; else a
//!   different model of the same vendor reviews, and the reason says so.
//!
//! # Score
//!
//! `strength(category) + mean area modifier + learned adjustment − quota penalty − load penalty
//! + trial bonus`, less small penalties for a legacy model (−1) and an inherited one not yet
//! proven here (−0.25). The learned adjustment ([`learn()`]) is a Beta-shrunk success rate
//! against the registry prior, capped at ±2.5. The quota penalty ([`forecast`]) is 0 below a
//! projected 70% and rises smoothly to 6 at a projected 100%; each running worker on the
//! provider costs 0.25 (at most 1.5). A `prefer` rule wins whenever its target is eligible, over
//! a pin too. Effort is the registry's default for the category (else low for scouting and
//! checks, medium for research, implementation and orchestration, high for reviews and merges),
//! fitted to what the model accepts and never above `high`.
//!
//! # Trials
//!
//! An unknown or researched model with fewer than 3 outcomes may run scouting, research and
//! verification — never implementation, reviews, merges or orchestration — when the query holds
//! a trial slot (the caller gives at most 1 in 5 low-risk tasks one) and it meets the task's
//! needs. Until then this is the only way it runs, whatever its tier; the trial path stands in
//! for the floor check, with a +4 bonus. After its trial, a researched model is scored like any
//! other; an unknown one waits for research to place it (it stays unrated, below every floor).
//!
//! # Overrides
//!
//! `never`, `prefer` and `only` rules ([`OverrideRule`]) apply by project, category and area.
//! They beat scores, balancing and pins, and hold during fallback: when every model an `only`
//! rule allows is unavailable, the task waits, naming the rule and the limit.
//!
//! # Quota heat and balancing
//!
//! Each window's rate of use gives a forecast at its reset; a provider is Warm at a projected
//! 70%, Hot at 90% (or 85% used), Limited at a limit or 97% used ([`forecast`]). The penalty
//! shifts new work to the other provider as a window heats up; when that changes the vendor,
//! the explanation says `balancing` and the reason names the window.
//!
//! # Waiting
//!
//! With nothing eligible, [`decide`] returns [`Decision::Wait`] with the earliest reset among
//! the models kept out only by a limit (none when no reset would help). Fallback is the same
//! call with the failed provider or model excluded and the same floor, areas and rules.
//!
//! # Tie order
//!
//! Scores that tie follow the Phase 3 table's vendor order, then each CLI's own order (newest
//! first). Write work starts on Claude and read-only work on Codex, so in a typical session the
//! two draw on different quotas and every write lands on a vendor whose change the other
//! reviews:
//!
//! | Category       | Ties go to    |
//! |----------------|---------------|
//! | Scout          | Codex, Claude |
//! | Research       | Codex, Claude |
//! | Implement      | Claude, Codex |
//! | Review         | Codex, Claude |
//! | Merge          | Claude, Codex |
//! | Verify         | Codex, Claude |
//! | Chat           | Claude, Codex |
//! | Orchestrate    | Claude, Codex |
//!
//! # Phase 3 API
//!
//! [`route`] and [`fallback`] keep the Phase 3 static table (family words `opus`, `sonnet`,
//! `haiku`, `astra`, `sol`, `luna`) until the core moves to [`decide`]. The registry's strengths
//! reproduce the table's choices when every provider is cool and idle.

mod areas;
pub mod decide;
mod explain;
pub mod forecast;
pub mod learn;
pub mod load;
pub mod merge;
mod outcome;
mod overrides;
mod quota;
mod registry;
mod table;

use brigadier_providers::{ModelInfo, ProviderKind};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use table::{Entry, Pick, Tier};

pub use areas::infer_areas;
pub use decide::{
    Decision, Exclusion, Needs, ProviderState, Query, Routed, Waiting, allows_trials, decide,
    default_floor, rule_text, targets,
};
pub use explain::{Alternative, Explanation, Factor};
pub use forecast::{
    active_limit, heat, provider_quota, quota_penalty, window_applies, window_state,
};
pub use learn::{learn, learned_for};
pub use load::{MAX_REGISTRY_BYTES, Parsed, RegistryError};
pub use merge::{OutcomeCount, TRIAL_OUTCOMES, merge, outcome_counts};
pub use outcome::{Learned, Outcome, OutcomeResult};
pub use overrides::{OverrideEffect, OverrideRule, OverrideTarget};
pub use quota::{Forecast, Heat, ProviderQuota, QuotaSample, WindowState};
pub use registry::{
    Capability, MergedModel, Modalities, Modality, ModelMatch, ModelStatus, QualityTier, Registry,
    RegistryInfo, RegistryModel, RegistrySource, ResearchNote, TrialState,
};

/// What a piece of work is, for routing. Mirrors the core's task kinds plus plain Chats and
/// the orchestrator itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TaskCategory {
    /// Looks around the repository and answers a question.
    Scout,
    /// Reads docs and the web.
    Research,
    /// Changes code; lands as one commit.
    Implement,
    /// Reviews another task's candidate commit or a plan.
    Review,
    /// Resolves conflicts between a task and its target branch.
    Merge,
    /// Runs the project's checks.
    Verify,
    /// A plain conversation with the model (no orchestrator, no workers).
    Chat,
    /// A session's orchestrator: plans, delegates and reviews, never does the work itself.
    Orchestrate,
}

impl TaskCategory {
    pub const ALL: [TaskCategory; 8] = [
        TaskCategory::Scout,
        TaskCategory::Research,
        TaskCategory::Implement,
        TaskCategory::Review,
        TaskCategory::Merge,
        TaskCategory::Verify,
        TaskCategory::Chat,
        TaskCategory::Orchestrate,
    ];
}

/// The part of a codebase a task touches, for user rules ("never use X for frontend") and
/// per-area strengths. Named by the orchestrator (`delegate_task`), else derived from the
/// paths its spec names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Area {
    /// UI code, styles and markup.
    Frontend,
    /// Services, libraries, application logic.
    Backend,
    /// Build, CI, containers, deployment.
    Infra,
    /// Documentation.
    Docs,
    /// Tests.
    Tests,
}

impl Area {
    pub const ALL: [Area; 5] = [
        Area::Frontend,
        Area::Backend,
        Area::Infra,
        Area::Docs,
        Area::Tests,
    ];
}

impl std::fmt::Display for TaskCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(table::row(*self).purpose)
    }
}

/// What one provider can offer right now.
#[derive(Debug, Clone, PartialEq)]
pub struct Availability {
    pub provider: ProviderKind,
    /// Installed, logged in and not at a usage limit.
    pub usable: bool,
    /// Its live model catalog, in the CLI's order. Empty when not fetched yet.
    pub models: Vec<ModelInfo>,
}

/// A provider, model or effort asked for by the orchestrator (`delegate_task`) or the user.
/// Every part is optional; what is left out is routed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Pin {
    pub provider: Option<ProviderKind>,
    /// A model id from the provider's list, an alias (`opus`) or a family name (`sol`). A model
    /// alone also picks its provider.
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// The model that wrote the change a review is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Author {
    pub provider: ProviderKind,
    /// Its model id; `None` for the CLI's default model.
    pub model: Option<String>,
}

/// One routing question.
#[derive(Debug, Clone)]
pub struct RouteRequest<'a> {
    pub category: TaskCategory,
    pub available: &'a [Availability],
    pub pin: Option<Pin>,
    /// For reviews: route away from this vendor, or at least from this model.
    pub avoid: Option<Author>,
    /// Workers each provider is running now, for spreading parallel work. Missing providers
    /// count as zero; an empty slice makes ties follow the table order.
    pub running: &'a [(ProviderKind, u32)],
}

/// Where the work runs, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub provider: ProviderKind,
    /// The model id to pass to the CLI; `None` for the CLI's default.
    pub model: Option<String>,
    /// The reasoning effort; `None` for the model's default.
    pub effort: Option<String>,
    /// A short sentence for the worker card ("why this model").
    pub reason: String,
    /// For reviews (`avoid` set): whether the reviewer's vendor differs from the author's.
    pub cross_vendor: Option<bool>,
}

/// No provider can take the work.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "no provider can take this {category} work: Claude and Codex are both unavailable (not \
     logged in or at their usage limit)"
)]
pub struct NoRoute {
    pub category: TaskCategory,
}

/// Routes one piece of work. See the crate docs for the table and the rules.
pub fn route(request: &RouteRequest) -> Result<Choice, NoRoute> {
    let row = table::row(request.category);
    let usable: Vec<ProviderKind> = row
        .order
        .into_iter()
        .filter(|provider| find(request.available, *provider).is_some_and(|a| a.usable))
        .collect();
    if usable.is_empty() {
        return Err(NoRoute {
            category: request.category,
        });
    }
    let pin = request.pin.clone().unwrap_or_default();
    let mut notes: Vec<String> = Vec::new();

    // 1. Reviews go to the vendor that did not write the change, when it is usable.
    let mut candidates = usable.clone();
    let mut cross_vendor = None;
    if let Some(author) = &request.avoid {
        let others: Vec<ProviderKind> = usable
            .iter()
            .copied()
            .filter(|provider| *provider != author.provider)
            .collect();
        if others.is_empty() {
            cross_vendor = Some(false);
        } else {
            cross_vendor = Some(true);
            candidates = others;
        }
    }

    // 2. A pinned provider (or the provider of a pinned model), if allowed.
    let pinned = pin.provider.or_else(|| {
        let name = pin.model.as_deref()?;
        ProviderKind::ALL.into_iter().find(|provider| {
            find(request.available, *provider)
                .is_some_and(|a| table::find_named(&a.models, name).is_some())
        })
    });
    let provider = match pinned {
        Some(wanted) if candidates.contains(&wanted) => wanted,
        Some(wanted) => {
            let fallback = pick_by_load(&candidates, request.running);
            if usable.contains(&wanted) {
                notes.push(format!(
                    "{} was asked for, but it wrote the change under review",
                    name(wanted)
                ));
            } else {
                notes.push(format!(
                    "{} was asked for, but it is unavailable (not logged in or at its usage limit)",
                    name(wanted)
                ));
            }
            fallback
        }
        None => {
            let chosen = pick_by_load(&candidates, request.running);
            if let Some(note) = vendor_note(request, &usable, &candidates, chosen, cross_vendor) {
                notes.push(note);
            }
            chosen
        }
    };
    let models = find(request.available, provider)
        .map(|a| a.models.as_slice())
        .unwrap_or_default();

    // 3. The model: a pin for this provider, else the table, never the author's own model when
    //    a review stays with its vendor (unless it is the only model there is).
    let excluded = match (&request.avoid, cross_vendor) {
        (Some(author), Some(false)) => Some(author_identity(author, models)),
        _ => None,
    };
    let wants_model = pin.model.is_some() && pinned.is_none_or(|wanted| wanted == provider);
    let pinned_model = if wants_model {
        pinned_model(models, pin.model.as_deref(), provider, &mut notes)
    } else {
        None
    };
    // A pinned model still runs at the row's effort unless the pin says otherwise.
    let row_effort = row.entries(provider).first().and_then(|entry| entry.effort);
    let unchecked = pin.model.clone().filter(|name| {
        models.is_empty() && pin.provider == Some(provider) && !table::names_fable(name)
    });
    let (info, model_id, entry_effort, model_why) = match (pinned_model, unchecked) {
        (Some(model), _) => (
            Some(model),
            Some(model.id.clone()),
            row_effort,
            "as requested".to_owned(),
        ),
        // No catalog to check the name against: trust the pin.
        (None, Some(name)) => (
            None,
            Some(name),
            row_effort,
            "as requested (unchecked: the model list isn't loaded yet)".to_owned(),
        ),
        (None, None) => {
            let (model, effort, why) = table_model(row, provider, models, excluded.as_deref());
            (model, model.map(|model| model.id.clone()), effort, why)
        }
    };
    if let (Some(author), Some(false)) = (&request.avoid, cross_vendor) {
        let author_model = author.model.as_deref().unwrap_or("its default model");
        let same = info.is_some() && info.map(table::identity) == excluded;
        notes.push(if info.is_none() {
            format!(
                "not a cross-vendor review: {} is the only vendor available",
                name(provider)
            )
        } else if same && pinned_model.is_some() {
            "not a cross-vendor review: the author's own model reviews its change, as requested"
                .to_owned()
        } else if same {
            format!(
                "not a cross-vendor review: {} is the only vendor available and has no other \
                 model, so the author's model reviews its own change",
                name(provider)
            )
        } else {
            format!(
                "not a cross-vendor review: {} is the only vendor available, so a different \
                 model than the author's ({author_model}) reviews",
                name(provider)
            )
        });
    }

    // 4. The effort: the pin's, else the entry's; capped at `high` and at what the model takes.
    let wanted = pin.effort.as_deref().or(entry_effort);
    let (effort, lowered) = table::fit_effort(info, wanted);
    if lowered && pin.effort.is_some() {
        notes.push(format!(
            "effort lowered from {} to {}",
            pin.effort.as_deref().unwrap_or_default(),
            effort.as_deref().unwrap_or("the default")
        ));
    }

    Ok(Choice {
        provider,
        reason: sentence(
            provider,
            model_id.as_deref(),
            effort.as_deref(),
            row.purpose,
            &model_why,
            &notes,
        ),
        model: model_id,
        effort,
        cross_vendor,
    })
}

/// Chat fallback after a usage limit: the other vendor's closest model (same class as `from`'s,
/// else the `category` row's pick), keeping `from`'s effort where the model accepts it.
/// `None` when the other vendor is not usable.
pub fn fallback(
    from: &Choice,
    category: TaskCategory,
    available: &[Availability],
) -> Option<Choice> {
    let to = ProviderKind::ALL
        .into_iter()
        .find(|provider| *provider != from.provider)?;
    let target = find(available, to).filter(|a| a.usable)?;
    let source_models = find(available, from.provider)
        .map(|a| a.models.as_slice())
        .unwrap_or_default();
    let source = match from.model.as_deref() {
        Some(id) => table::find_named(source_models, id),
        None => table::find_default(source_models, None),
    };
    let tier = source
        .and_then(|model| Tier::of(from.provider, model))
        // Not in the catalog (or none loaded): classify the id itself.
        .or_else(|| Tier::of_names(from.provider, from.model.as_deref()?, None));

    let row = table::row(category);
    let (model, effort_wanted, why) = match tier
        .and_then(|tier| table::find_tier(to, &target.models, tier, None).map(|m| (tier, m)))
    {
        Some((_, model)) => {
            let what = from.model.as_deref().unwrap_or("its default model");
            (
                Some(model),
                from.effort.as_deref(),
                format!(
                    "the closest match to {} {what}, which is at its usage limit",
                    name(from.provider)
                ),
            )
        }
        None => {
            let (model, effort, _) = table_model(row, to, &target.models, None);
            (
                model,
                from.effort.as_deref().or(effort),
                format!("{} is at its usage limit", name(from.provider)),
            )
        }
    };
    let (effort, _) = table::fit_effort(model, effort_wanted);
    let model_id = model.map(|model| model.id.clone());
    Some(Choice {
        provider: to,
        reason: sentence(
            to,
            model_id.as_deref(),
            effort.as_deref(),
            row.purpose,
            &why,
            &[],
        ),
        model: model_id,
        effort,
        // Switching vendors flips whether a review is cross-vendor.
        cross_vendor: from.cross_vendor.map(|cross| !cross),
    })
}

// ----- helpers ------------------------------------------------------------------------------

fn find(available: &[Availability], provider: ProviderKind) -> Option<&Availability> {
    available.iter().find(|a| a.provider == provider)
}

/// The short vendor name used in reasons.
fn name(provider: ProviderKind) -> &'static str {
    match provider {
        ProviderKind::Claude => "Claude",
        ProviderKind::Codex => "Codex",
    }
}

/// The candidate with the fewest running workers; ties keep the table order.
fn pick_by_load(candidates: &[ProviderKind], running: &[(ProviderKind, u32)]) -> ProviderKind {
    let load = |provider: ProviderKind| {
        running
            .iter()
            .find(|(kind, _)| *kind == provider)
            .map_or(0, |(_, count)| *count)
    };
    candidates
        .iter()
        .copied()
        .min_by_key(|provider| load(*provider))
        .unwrap_or(candidates[0])
}

/// Why this vendor, when it was not simply pinned.
fn vendor_note(
    request: &RouteRequest,
    usable: &[ProviderKind],
    candidates: &[ProviderKind],
    chosen: ProviderKind,
    cross_vendor: Option<bool>,
) -> Option<String> {
    let other = ProviderKind::ALL.into_iter().find(|p| *p != chosen)?;
    if !usable.contains(&other) {
        return Some(format!(
            "{} is unavailable (not logged in or at its usage limit)",
            name(other)
        ));
    }
    if cross_vendor == Some(true) {
        return Some(format!("{} wrote the change", name(other)));
    }
    let load = |provider: ProviderKind| {
        request
            .running
            .iter()
            .find(|(kind, _)| *kind == provider)
            .map_or(0, |(_, count)| *count)
    };
    if candidates.len() > 1 && load(other) > load(chosen) {
        let count = load(other);
        return Some(format!(
            "{} already runs {count} worker{}",
            name(other),
            if count == 1 { "" } else { "s" }
        ));
    }
    None
}

/// The identity of the author's model, resolved through the catalog when possible.
fn author_identity(author: &Author, models: &[ModelInfo]) -> String {
    let model = match author.model.as_deref() {
        Some(id) => table::find_named(models, id),
        None => table::find_default(models, None),
    };
    match (model, author.model.as_deref()) {
        (Some(model), _) => table::identity(model),
        (None, Some(id)) => id.to_ascii_lowercase(),
        (None, None) => String::new(),
    }
}

/// Resolves a pinned model in this provider's catalog, or explains why it was not used.
fn pinned_model<'m>(
    models: &'m [ModelInfo],
    wanted: Option<&str>,
    provider: ProviderKind,
    notes: &mut Vec<String>,
) -> Option<&'m ModelInfo> {
    let wanted = wanted?;
    match table::find_named(models, wanted) {
        Some(model) if table::is_fable(model) => {
            notes.push(format!(
                "{wanted} was asked for, but Fable models are never used"
            ));
            None
        }
        Some(model) => Some(model),
        None if models.is_empty() => None,
        None => {
            notes.push(format!(
                "{wanted} was asked for, but it is not in {}'s model list",
                name(provider)
            ));
            None
        }
    }
}

/// The row's model for this provider, with its effort and a phrase saying why.
fn table_model<'m>(
    row: &table::Row,
    provider: ProviderKind,
    models: &'m [ModelInfo],
    excluded: Option<&str>,
) -> (Option<&'m ModelInfo>, Option<&'static str>, String) {
    let entries: &[Entry] = row.entries(provider);
    for entry in entries {
        let found = match entry.pick {
            Pick::Tier(tier) => table::find_tier(provider, models, tier, excluded),
            Pick::Default => table::find_default(models, excluded),
        };
        if let Some(model) = found {
            return (Some(model), entry.effort, row.why.to_owned());
        }
    }
    let effort = entries.first().and_then(|entry| entry.effort);
    if let Some(model) = table::find_default(models, excluded) {
        return (
            Some(model),
            effort,
            format!(
                "{}'s default model (no better match in its list)",
                name(provider)
            ),
        );
    }
    if let Some(model) =
        table::routable(models).find(|model| excluded.is_none_or(|ex| table::identity(model) != ex))
    {
        return (
            Some(model),
            effort,
            format!("the first model in {}'s list", name(provider)),
        );
    }
    // Everything left is the excluded model: better the author's model than no review.
    if excluded.is_some() && table::routable(models).next().is_some() {
        return table_model(row, provider, models, None);
    }
    // No catalog yet: the CLI's own default model, at its own default effort.
    (
        None,
        None,
        format!("{}'s model list isn't loaded yet", name(provider)),
    )
}

/// "Codex gpt-6-astra (high) for review: <why>; <notes>."
fn sentence(
    provider: ProviderKind,
    model: Option<&str>,
    effort: Option<&str>,
    purpose: &str,
    why: &str,
    notes: &[String],
) -> String {
    let mut text = String::from(name(provider));
    text.push(' ');
    text.push_str(model.unwrap_or("default model"));
    if let Some(effort) = effort {
        text.push_str(&format!(" ({effort})"));
    }
    text.push_str(&format!(" for {purpose}: {why}"));
    for note in notes {
        text.push_str("; ");
        text.push_str(note);
    }
    text.push('.');
    text
}
