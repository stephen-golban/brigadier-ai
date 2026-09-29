//! Routing v2: choosing a model for one task from the merged catalog, the quota view, outcomes
//! and the user's rules. See the crate docs for the design; this module is its implementation.

use std::borrow::Cow;

use brigadier_providers::{LimitKind, ProviderKind};

use crate::explain::{Alternative, Explanation, Factor};
use crate::forecast::{LIMITED_USED, active_limit, quota_penalty, window_applies};
use crate::learn::{is_model, learned_for};
use crate::load::clamp_effort;
use crate::merge::from_entry;
use crate::outcome::Learned;
use crate::overrides::{OverrideEffect, OverrideRule, OverrideTarget};
use crate::quota::ProviderQuota;
use crate::registry::{Capability, MergedModel, Modality, ModelStatus, QualityTier, Registry};
use crate::{Area, Author, Pin, TaskCategory, name, table};

/// Added to a trial model's score on a task holding a trial slot.
pub const TRIAL_BONUS: f64 = 4.0;
/// Taken from a model's score per worker already running on its provider.
pub const LOAD_PENALTY: f64 = 0.25;
pub const MAX_LOAD_PENALTY: f64 = 1.5;
/// Taken from an older model the CLI keeps beside a newer one.
pub const LEGACY_PENALTY: f64 = 1.0;
/// Taken from a model that inherits a family entry until it has outcomes here.
pub const INHERITED_PENALTY: f64 = 0.25;
/// Outcomes after which an inherited model no longer pays [`INHERITED_PENALTY`].
const INHERITED_PROVEN: u32 = 3;
/// The context window assumed for a model whose window nobody knows.
pub const ASSUMED_CONTEXT_WINDOW: i64 = 128_000;
/// Scores this close count as a tie.
const TIE: f64 = 1e-6;
/// The reason sentence stops adding notes past this length.
const REASON_BUDGET: usize = 180;

/// What a task needs from its model.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Needs {
    /// It sends images.
    pub image_input: bool,
    /// It makes images (Codex only).
    pub image_generation: bool,
    /// The context it needs, in tokens (a hand-off after a context-window error asks for more
    /// than the failed model had).
    pub context_tokens: Option<i64>,
}

/// A provider or one model that must not take the task (it just failed on it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exclusion {
    pub provider: ProviderKind,
    /// One model (its id or concrete model); `None`: every model of the provider.
    pub model: Option<String>,
}

/// One provider as routing sees it now.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderState {
    pub provider: ProviderKind,
    /// Installed and logged in.
    pub logged_in: bool,
    /// The quota monitor's view; `None` before the first read.
    pub quota: Option<ProviderQuota>,
}

/// One routing question (routing v2).
#[derive(Debug, Clone)]
pub struct Query<'a> {
    pub category: TaskCategory,
    pub areas: &'a [Area],
    /// The least capable model it may run on (see [`default_floor`]).
    pub floor: QualityTier,
    pub needs: Needs,
    /// A provider, model or effort asked for by the orchestrator or the user.
    pub pin: Option<Pin>,
    /// For reviews: the model that wrote the change.
    pub avoid: Option<Author>,
    /// Providers or models that just failed on this task.
    pub exclude: &'a [Exclusion],
    /// The user's rules (global and per project); those for another project, category or area
    /// are skipped here.
    pub overrides: &'a [OverrideRule],
    pub project_id: Option<&'a str>,
    /// Workers each provider runs now.
    pub running: &'a [(ProviderKind, u32)],
    /// This task may go to a model on trial (the caller gives at most 1 in 5 low-risk tasks a
    /// slot).
    pub trial_slot: bool,
    pub providers: &'a [ProviderState],
    /// The merged catalog ([`crate::merge`]), every provider, in each CLI's order.
    pub models: &'a [MergedModel],
    pub registry: &'a Registry,
    /// What this project's outcomes taught ([`crate::learn`]).
    pub learned: &'a [Learned],
    pub now_ms: i64,
}

/// Where a task runs, and why.
#[derive(Debug, Clone, PartialEq)]
pub struct Routed {
    pub provider: ProviderKind,
    /// The model id to pass to the CLI.
    pub model: String,
    /// The reasoning effort; `None` for the model's default (or a model without effort levels).
    pub effort: Option<String>,
    /// One short sentence for the worker card.
    pub reason: String,
    pub explanation: Explanation,
    /// For reviews: whether the reviewer's vendor differs from the author's.
    pub cross_vendor: Option<bool>,
    /// It runs as a trial of a new model.
    pub trial: bool,
    pub tier: QualityTier,
}

/// Nothing the task may use is available: it waits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Waiting {
    /// What it waits for ("Claude's 5-hour window is used up (resets in 2h 10m)").
    pub reason: String,
    /// The earliest reset that could let it run, when known.
    pub resets_at_ms: Option<i64>,
    /// The user rule that keeps it from other models, if one does (its text).
    pub rule: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Run(Routed),
    Wait(Waiting),
}

/// The quality floor a task of this category gets unless the orchestrator raises it.
pub fn default_floor(category: TaskCategory) -> QualityTier {
    match category {
        TaskCategory::Implement
        | TaskCategory::Review
        | TaskCategory::Merge
        | TaskCategory::Orchestrate => QualityTier::Strong,
        TaskCategory::Research => QualityTier::Standard,
        TaskCategory::Scout | TaskCategory::Verify | TaskCategory::Chat => QualityTier::Light,
    }
}

/// Whether a category is low-risk work a model on trial may take.
pub fn allows_trials(category: TaskCategory) -> bool {
    matches!(
        category,
        TaskCategory::Scout | TaskCategory::Research | TaskCategory::Verify
    )
}

/// The effort a category runs at when the registry names none.
fn category_effort(category: TaskCategory) -> Option<&'static str> {
    match category {
        TaskCategory::Scout | TaskCategory::Verify => Some("low"),
        TaskCategory::Research | TaskCategory::Implement | TaskCategory::Orchestrate => {
            Some("medium")
        }
        TaskCategory::Review | TaskCategory::Merge => Some("high"),
        TaskCategory::Chat => None,
    }
}

// ----- candidates ----------------------------------------------------------------------------

/// Why a model can't take the task, in the order they are checked.
#[derive(Debug, Clone, PartialEq)]
enum Block {
    /// It (or its provider) just failed on this task.
    Excluded(String),
    /// A user rule removes it (`never`, or outside every `only`).
    Rule(String),
    /// It can't do what the task needs.
    Needs(String),
    /// Below the task's quality floor.
    Floor(String),
    /// Its provider isn't logged in.
    Unavailable(String),
    /// A confirmed limit: a hard exclusion until the reset.
    Limit {
        why: String,
        resets_at_ms: Option<i64>,
    },
    /// The review's author vendor, while another vendor can review.
    Author(String),
}

impl Block {
    fn why(&self) -> &str {
        match self {
            Block::Excluded(why)
            | Block::Rule(why)
            | Block::Needs(why)
            | Block::Floor(why)
            | Block::Unavailable(why)
            | Block::Author(why)
            | Block::Limit { why, .. } => why,
        }
    }
}

struct Candidate<'q> {
    model: Cow<'q, MergedModel>,
    /// Built from the registry: its CLI's list isn't loaded yet.
    unchecked: bool,
    trial: bool,
    block: Option<Block>,
    base: f64,
    factors: Vec<Factor>,
    score: f64,
    /// The quota penalty in `score`, and the window behind it.
    penalty: f64,
    penalty_window: Option<String>,
    /// The load penalty in `score`, and what it says.
    load: f64,
    load_note: Option<String>,
    learned: Option<&'q Learned>,
    /// A preferred target of an applicable `prefer` rule (its text).
    preferred: Option<String>,
}

impl Candidate<'_> {
    fn eligible(&self) -> bool {
        self.block.is_none()
    }

    fn label(&self) -> String {
        format!("{} {}", name(self.model.provider), self.model.id)
    }
}

/// Routes one task. See the crate docs for the rules.
///
/// **Fallback** is this same call with the failed provider or model in [`Query::exclude`] and
/// the task's floor, areas and rules unchanged: nothing below the floor is ever taken, and a
/// user rule holds during fallback too (an `only` rule whose models are all unavailable makes the
/// task wait, naming the rule).
pub fn decide(query: &Query) -> Decision {
    let rules: Vec<&OverrideRule> = query
        .overrides
        .iter()
        .filter(|rule| applies(rule, query))
        .collect();
    let only: Vec<&OverrideRule> = rules
        .iter()
        .copied()
        .filter(|rule| rule.effect == OverrideEffect::Only)
        .collect();
    let mut candidates = candidates(query);
    for candidate in &mut candidates {
        assess(candidate, query, &rules, &only);
    }

    // Reviews: another vendor when one can take it, else a different model of the same one.
    let mut notes: Vec<String> = Vec::new();
    let mut cross_vendor = None;
    if let Some(author) = &query.avoid {
        let other_vendor = candidates
            .iter()
            .any(|c| c.eligible() && c.model.provider != author.provider);
        if other_vendor {
            cross_vendor = Some(true);
            for candidate in &mut candidates {
                if candidate.eligible() && candidate.model.provider == author.provider {
                    candidate.block = Some(Block::Author(format!(
                        "{} wrote the change under review",
                        name(author.provider)
                    )));
                }
            }
        } else if candidates.iter().any(|c| c.eligible()) {
            cross_vendor = Some(false);
            let is_author = |c: &Candidate| {
                author
                    .model
                    .as_deref()
                    .is_some_and(|model| is_model(&c.model, query.registry, model))
            };
            let others = candidates.iter().any(|c| c.eligible() && !is_author(c));
            if others {
                for candidate in &mut candidates {
                    if candidate.eligible() && is_author(candidate) {
                        candidate.block =
                            Some(Block::Author("it wrote the change under review".to_owned()));
                    }
                }
                notes.push(format!(
                    "not cross-vendor: only {} is available, so another of its models reviews",
                    name(author.provider)
                ));
            } else {
                notes.push(format!(
                    "not cross-vendor: only {} is available, and only the author's model can \
                     review",
                    name(author.provider)
                ));
            }
        }
    }

    if !candidates.iter().any(Candidate::eligible) {
        return Decision::Wait(waiting(query, &candidates, &only));
    }

    // Order: score, then the table's vendor order, then each CLI's own order.
    let order = table::row(query.category).order;
    let rank = |c: &Candidate| {
        order
            .iter()
            .position(|p| *p == c.model.provider)
            .unwrap_or(2)
    };
    let mut ranked: Vec<usize> = (0..candidates.len())
        .filter(|i| candidates[*i].eligible())
        .collect();
    ranked.sort_by(|a, b| {
        let (a, b) = (&candidates[*a], &candidates[*b]);
        b.score
            .partial_cmp(&a.score)
            .filter(|_| (a.score - b.score).abs() > TIE)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(rank(a).cmp(&rank(b)))
    });

    // A pin, then a `prefer` rule, else the top score. Rules beat pins.
    let mut chosen = ranked[0];
    let mut why: Option<String> = None;
    let mut pinned_pick = false;
    let mut rule_text: Option<String> = None;
    if let Some(pin) = &query.pin {
        if let Some(index) = pinned(query, pin, &candidates, &mut notes) {
            chosen = index;
            why = Some("as requested".to_owned());
            pinned_pick = true;
        } else if pin.model.is_none()
            && let Some(provider) = pin.provider
        {
            match ranked
                .iter()
                .copied()
                .find(|i| candidates[*i].model.provider == provider)
            {
                Some(index) => {
                    chosen = index;
                    why = Some(format!("{} as requested", name(provider)));
                    pinned_pick = true;
                }
                None => notes.push(format!(
                    "{} was asked for, but {}",
                    name(provider),
                    provider_block(&candidates, provider)
                )),
            }
        }
    }
    if let Some(index) = ranked
        .iter()
        .copied()
        .find(|i| candidates[*i].preferred.is_some())
    {
        if why.is_some() && index != chosen {
            notes.push(format!(
                "{} was asked for, but your rule prefers {}",
                candidates[chosen].label(),
                candidates[index].label()
            ));
        }
        chosen = index;
        pinned_pick = false;
        rule_text = candidates[index].preferred.clone();
        why = rule_text.as_ref().map(|rule| format!("your rule: {rule}"));
    } else if !only.is_empty() {
        rule_text = Some(join_rules(&only));
    }

    let pick = &candidates[chosen];
    if why.is_none() && pick.trial {
        let outcomes = pick.model.trial.map_or(0, |trial| trial.outcomes);
        why = Some(format!(
            "a trial of a new model on low-risk work ({outcomes} of {} runs so far)",
            crate::merge::TRIAL_OUTCOMES
        ));
    }
    // Balancing: without quota penalties, another provider would have won.
    let unpenalized = ranked
        .iter()
        .copied()
        .max_by(|a, b| {
            let (a, b) = (&candidates[*a], &candidates[*b]);
            (a.score + a.penalty)
                .total_cmp(&(b.score + b.penalty))
                .then(rank(b).cmp(&rank(a)))
        })
        .unwrap_or(chosen);
    // (Only when the score chose: a pin or a rule is not balancing.)
    let balancing = why.is_none()
        && candidates[unpenalized].model.provider != pick.model.provider
        && candidates[unpenalized].penalty > 0.0;
    // Context worth a clause when there is room: the window balancing avoids, or a limit that
    // kept a better model out.
    // Spreading: without load penalties, another provider would have won.
    let unloaded = ranked
        .iter()
        .copied()
        .max_by(|a, b| {
            let (a, b) = (&candidates[*a], &candidates[*b]);
            (a.score + a.load)
                .total_cmp(&(b.score + b.load))
                .then(rank(b).cmp(&rank(a)))
        })
        .unwrap_or(chosen);
    let context = if balancing {
        candidates[unpenalized].penalty_window.clone()
    } else if why.is_none() && candidates[unloaded].model.provider != pick.model.provider {
        candidates[unloaded].load_note.clone()
    } else {
        limited_rival(&candidates, pick, rank)
    };

    let tie = ranked
        .iter()
        .filter(|i| **i != chosen)
        .any(|i| (candidates[*i].score - pick.score).abs() <= TIE);
    let why = why.unwrap_or_else(|| score_why(query, pick, tie, rule_text.as_deref()));

    let effort = effort(query, pick, &mut notes);
    let explanation = Explanation {
        score: Some(round(pick.score)),
        factors: pick.factors.clone(),
        alternatives: alternatives(&candidates, &ranked, chosen, pinned_pick, rank),
        rule: rule_text,
        trial: pick.trial,
        balancing,
    };
    let mut reason = format!(
        "{} {}{} for {}: {why}",
        name(pick.model.provider),
        pick.model.id,
        effort
            .as_deref()
            .map(|effort| format!(" ({effort})"))
            .unwrap_or_default(),
        table::row(query.category).purpose,
    );
    if pick.unchecked {
        notes.push(format!(
            "unchecked: {}'s model list isn't loaded yet",
            name(pick.model.provider)
        ));
    }
    // Notes about the request (a pin, a review staying with its vendor, the effort) always
    // show; the context clause only when it fits.
    for note in notes {
        reason.push_str("; ");
        reason.push_str(&note);
    }
    // Balancing always names the window it avoids (the explanation says so too).
    if let Some(context) = context
        && (balancing || reason.len() + context.len() + 3 <= REASON_BUDGET)
    {
        reason.push_str("; ");
        reason.push_str(&context);
    }
    reason.push('.');

    Decision::Run(Routed {
        provider: pick.model.provider,
        model: pick.model.id.clone(),
        effort,
        reason,
        explanation,
        cross_vendor,
        trial: pick.trial,
        tier: pick.model.tier,
    })
}

/// Every model routing may consider: the merged catalog (Fable and duplicate aliases of one
/// curated model left out), plus the registry's models for a logged-in provider whose list
/// isn't loaded yet.
fn candidates<'q>(query: &'q Query) -> Vec<Candidate<'q>> {
    let mut models: Vec<(Cow<'q, MergedModel>, bool)> = Vec::new();
    for model in query.models {
        if model.excluded
            || table::names_fable(&model.id)
            || table::names_fable(&model.display_name)
        {
            continue;
        }
        // Claude lists `default` and `opus` for one model: keep the named alias.
        if model.status == ModelStatus::Curated
            && let Some(key) = &model.registry_key
            && let Some(position) = models.iter().position(|(other, _)| {
                other.provider == model.provider
                    && other.status == ModelStatus::Curated
                    && other.registry_key.as_ref() == Some(key)
            })
        {
            if models[position].0.id.eq_ignore_ascii_case("default") {
                models[position] = (Cow::Borrowed(model), false);
            }
            continue;
        }
        models.push((Cow::Borrowed(model), false));
    }
    for state in query.providers {
        let listed = query.models.iter().any(|m| m.provider == state.provider);
        if state.logged_in && !listed {
            for entry in query.registry.entries(state.provider) {
                if let Some(model) = from_entry(entry, state.provider) {
                    models.push((Cow::Owned(model), true));
                }
            }
        }
    }
    models
        .into_iter()
        .map(|(model, unchecked)| Candidate {
            model,
            unchecked,
            trial: false,
            block: None,
            base: 0.0,
            factors: Vec::new(),
            score: 0.0,
            penalty: 0.0,
            penalty_window: None,
            load: 0.0,
            load_note: None,
            learned: None,
            preferred: None,
        })
        .collect()
}

/// Checks one candidate and scores it.
fn assess<'q>(
    candidate: &mut Candidate<'q>,
    query: &'q Query,
    rules: &[&OverrideRule],
    only: &[&OverrideRule],
) {
    let model = candidate.model.clone();
    let vendor = name(model.provider);
    let purpose = table::row(query.category).purpose;

    // A new model (unknown or researched) runs only as a trial until it has enough outcomes.
    let on_trial = matches!(model.status, ModelStatus::Unknown | ModelStatus::Researched)
        && model
            .trial
            .is_some_and(|trial| trial.outcomes < crate::merge::TRIAL_OUTCOMES);
    candidate.trial = on_trial && query.trial_slot && allows_trials(query.category);

    let block = if let Some(exclusion) = query.exclude.iter().find(|ex| {
        ex.provider == model.provider
            && ex
                .model
                .as_deref()
                .is_none_or(|id| is_model(&model, query.registry, id))
    }) {
        Some(Block::Excluded(match exclusion.model {
            Some(_) => "it just failed on this task".to_owned(),
            None => format!("{vendor} just failed on this task"),
        }))
    } else if let Some(rule) = rules.iter().find(|rule| {
        rule.effect == OverrideEffect::Never && targets(&rule.target, &model, query.registry)
    }) {
        Some(Block::Rule(format!("your rule: {}", rule_text(rule))))
    } else if let Some(rule) = only
        .iter()
        .find(|rule| !targets(&rule.target, &model, query.registry))
    {
        // Every applicable `only` rule must allow it.
        Some(Block::Rule(format!("your rule: {}", rule_text(rule))))
    } else if let Some(why) = unmet_need(&model, query.needs) {
        Some(Block::Needs(why))
    } else if on_trial && !candidate.trial {
        let runs = model.trial.map_or(0, |trial| trial.outcomes);
        Some(Block::Floor(format!(
            "a new model on trial: it runs only on scouting, research and checks given a trial \
             slot ({runs} of {} runs so far)",
            crate::merge::TRIAL_OUTCOMES
        )))
    } else if model.tier < query.floor && !candidate.trial {
        Some(Block::Floor(if model.tier == QualityTier::Unrated {
            "not rated yet (new models get trial runs on scouting, research and checks)".to_owned()
        } else {
            format!(
                "below the {} quality floor for {purpose}",
                tier_name(query.floor)
            )
        }))
    } else {
        availability(query, &model)
    };
    candidate.block = block;

    // The score, for the eligible and for the explanation of those that are not.
    let strength = model
        .strengths
        .get(&query.category)
        .copied()
        .unwrap_or(crate::merge::UNRATED_STRENGTH);
    candidate.base = strength;
    let mut factors = vec![Factor {
        label: match model.status {
            ModelStatus::Curated => format!("registry strength for {purpose}"),
            ModelStatus::Inherited => format!(
                "{} family strength for {purpose} (inherited)",
                model.family.as_deref().unwrap_or("its")
            ),
            ModelStatus::Researched => format!("research estimate for {purpose}"),
            ModelStatus::Unknown => "not rated yet (default strength)".to_owned(),
        },
        delta: strength,
    }];
    if !query.areas.is_empty() {
        let modifier = query
            .areas
            .iter()
            .map(|area| model.area_strengths.get(area).copied().unwrap_or(0.0))
            .sum::<f64>()
            / query.areas.len() as f64;
        if modifier != 0.0 {
            factors.push(Factor {
                label: format!("strength for {}", areas_text(query.areas)),
                delta: modifier,
            });
        }
    }
    candidate.learned = learned_for(query.learned, &model, query.registry, query.category);
    if let Some(learned) = candidate.learned
        && learned.adjustment != 0.0
    {
        factors.push(Factor {
            label: evidence(learned),
            delta: learned.adjustment,
        });
    }
    if model.status == ModelStatus::Inherited
        && candidate
            .learned
            .is_none_or(|l| l.samples < INHERITED_PROVEN)
    {
        factors.push(Factor {
            label: "a newer model of its family, not yet curated".to_owned(),
            delta: -INHERITED_PENALTY,
        });
    }
    if model.legacy {
        factors.push(Factor {
            label: "an older model (its CLI lists a newer one)".to_owned(),
            delta: -LEGACY_PENALTY,
        });
    }
    if let Some((penalty, window)) = penalty(query, &model) {
        candidate.penalty = penalty;
        candidate.penalty_window = Some(window.clone());
        factors.push(Factor {
            label: window,
            delta: -penalty,
        });
    }
    let running = query
        .running
        .iter()
        .find(|(provider, _)| *provider == model.provider)
        .map_or(0, |(_, count)| *count);
    if running > 0 {
        let label = format!(
            "{vendor} already runs {running} worker{}",
            if running == 1 { "" } else { "s" }
        );
        candidate.load = (f64::from(running) * LOAD_PENALTY).min(MAX_LOAD_PENALTY);
        candidate.load_note = Some(label.clone());
        factors.push(Factor {
            label,
            delta: -candidate.load,
        });
    }
    if candidate.trial {
        factors.push(Factor {
            label: "trial of a new model".to_owned(),
            delta: TRIAL_BONUS,
        });
    }
    candidate.score = factors.iter().map(|factor| factor.delta).sum();
    for factor in &mut factors {
        factor.delta = round(factor.delta);
    }
    candidate.factors = factors;
    candidate.preferred = rules
        .iter()
        .find(|rule| {
            rule.effect == OverrideEffect::Prefer && targets(&rule.target, &model, query.registry)
        })
        .map(|rule| rule_text(rule));
}

fn unmet_need(model: &MergedModel, needs: Needs) -> Option<String> {
    if needs.image_input && !model.modalities.input.contains(&Modality::Image) {
        return Some("doesn't take images".to_owned());
    }
    if needs.image_generation
        && !model
            .modalities
            .tools
            .contains(&Capability::ImageGeneration)
    {
        return Some("can't generate images".to_owned());
    }
    if let Some(need) = needs.context_tokens {
        let window = model.context_window.unwrap_or(ASSUMED_CONTEXT_WINDOW);
        if window < need {
            return Some(format!(
                "its context window ({}) is smaller than the {} tokens needed",
                tokens_text(window),
                tokens_text(need)
            ));
        }
    }
    None
}

/// Login and confirmed limits: a limit is a hard exclusion, never a penalty.
fn availability(query: &Query, model: &MergedModel) -> Option<Block> {
    let vendor = name(model.provider);
    let Some(state) = query
        .providers
        .iter()
        .find(|s| s.provider == model.provider)
    else {
        return Some(Block::Unavailable(format!("{vendor} is not set up")));
    };
    if !state.logged_in {
        return Some(Block::Unavailable(format!("{vendor} is not logged in")));
    }
    let quota = state.quota.as_ref()?;
    if let Some(limit) = active_limit(quota.limit.as_ref(), query.now_ms) {
        let resets = limit.resets_at_ms.or_else(|| {
            let id = limit.window.as_deref()?;
            let window = quota.windows.iter().find(|w| w.window.id == id)?;
            window.window.resets_at_ms
        });
        let why = match limit.kind {
            LimitKind::SpendControl => {
                format!("{vendor}'s spend control stopped it (until a fresh read shows it clear)")
            }
            LimitKind::Credits => format!("{vendor} is out of credits"),
            LimitKind::UsageWindow => {
                let label = limit.window.as_deref().and_then(|id| {
                    quota
                        .windows
                        .iter()
                        .find(|w| w.window.id == id)
                        .map(|w| w.window.label.clone())
                });
                format!(
                    "{} is used up{}",
                    window_name(vendor, label.as_deref()),
                    resets_text(resets, query.now_ms)
                )
            }
        };
        return Some(Block::Limit {
            why,
            resets_at_ms: if limit.kind == LimitKind::UsageWindow {
                resets
            } else {
                None
            },
        });
    }
    // Every used-up window that limits this model must reset before it runs again.
    let spent: Vec<_> = quota
        .windows
        .iter()
        .filter(|w| window_applies(&w.window, model, query.registry))
        .filter(|w| !has_reset(w.window.resets_at_ms, query.now_ms))
        .filter(|w| w.heat == crate::Heat::Limited || w.window.used_percent >= LIMITED_USED)
        .collect();
    let latest = spent.iter().max_by_key(|w| w.window.resets_at_ms)?;
    let resets = if spent.iter().any(|w| w.window.resets_at_ms.is_none()) {
        None
    } else {
        latest.window.resets_at_ms
    };
    let scoped = latest
        .window
        .model
        .as_deref()
        .filter(|scope| {
            !latest
                .window
                .label
                .to_ascii_lowercase()
                .contains(&scope.to_ascii_lowercase())
        })
        .map(|scope| format!(" for {scope}"))
        .unwrap_or_default();
    Some(Block::Limit {
        why: format!(
            "{} is used up{scoped}{}",
            window_name(vendor, Some(&latest.window.label)),
            resets_text(resets, query.now_ms)
        ),
        resets_at_ms: resets,
    })
}

/// The quota penalty for a model, from the hottest window that limits it.
fn penalty(query: &Query, model: &MergedModel) -> Option<(f64, String)> {
    let state = query
        .providers
        .iter()
        .find(|s| s.provider == model.provider)?;
    let quota = state.quota.as_ref()?;
    quota
        .windows
        .iter()
        .filter(|w| window_applies(&w.window, model, query.registry))
        .filter(|w| !has_reset(w.window.resets_at_ms, query.now_ms))
        .map(|w| {
            let projected = w
                .forecast
                .map_or(w.window.used_percent, |f| f.projected_at_reset);
            (quota_penalty(projected), w, projected)
        })
        .filter(|(penalty, _, _)| *penalty > 0.0)
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(penalty, w, projected)| {
            (
                penalty,
                format!(
                    "{} is projected at {:.0}% by its reset",
                    window_name(name(model.provider), Some(&w.window.label)),
                    projected.min(999.0)
                ),
            )
        })
}

fn has_reset(resets_at_ms: Option<i64>, now_ms: i64) -> bool {
    resets_at_ms.is_some_and(|reset| reset <= now_ms)
}

/// The pinned model, when it may run; otherwise says why not.
fn pinned(
    query: &Query,
    pin: &Pin,
    candidates: &[Candidate],
    notes: &mut Vec<String>,
) -> Option<usize> {
    let wanted = pin.model.as_deref()?.trim();
    if table::names_fable(wanted) {
        notes.push(format!(
            "{wanted} was asked for, but Fable models are never used"
        ));
        return None;
    }
    let found = find_named(query, candidates, pin.provider, wanted);
    match found {
        Some(index) if candidates[index].eligible() => Some(index),
        Some(index) => {
            let why = candidates[index]
                .block
                .as_ref()
                .map_or("it can't take this task", Block::why);
            notes.push(format!("{wanted} was asked for, but {why}"));
            None
        }
        None => {
            notes.push(match pin.provider {
                Some(provider) => {
                    format!(
                        "{wanted} was asked for, but it is not in {}'s model list",
                        name(provider)
                    )
                }
                None => format!("{wanted} was asked for, but no CLI lists it"),
            });
            None
        }
    }
}

/// A model asked for by name: its id, a concrete id its entry claims, an id prefix, or a
/// family word.
fn find_named(
    query: &Query,
    candidates: &[Candidate],
    provider: Option<ProviderKind>,
    wanted: &str,
) -> Option<usize> {
    let lower = wanted.to_ascii_lowercase();
    let pool: Vec<usize> = (0..candidates.len())
        .filter(|i| provider.is_none_or(|p| candidates[*i].model.provider == p))
        .collect();
    // At each step, an eligible match before one that can't run (an older `sol` that can,
    // before the newest one at its limit).
    let first = |test: &dyn Fn(&MergedModel) -> bool| {
        let all: Vec<usize> = pool
            .iter()
            .copied()
            .filter(|i| test(&candidates[*i].model))
            .collect();
        all.iter()
            .copied()
            .find(|i| candidates[*i].eligible())
            .or_else(|| all.first().copied())
    };
    first(&|m| m.id.eq_ignore_ascii_case(wanted))
        .or_else(|| first(&|m| is_model(m, query.registry, wanted)))
        .or_else(|| first(&|m| m.id.to_ascii_lowercase().starts_with(&lower)))
        .or_else(|| {
            first(&|m| {
                !wanted.contains(['-', '.'])
                    && (m
                        .family
                        .as_deref()
                        .is_some_and(|f| f.eq_ignore_ascii_case(wanted))
                        || table::has_word(&m.id, wanted))
            })
        })
}

/// Why none of a provider's models can take the task.
fn provider_block(candidates: &[Candidate], provider: ProviderKind) -> String {
    candidates
        .iter()
        .filter(|c| c.model.provider == provider)
        .filter_map(|c| c.block.as_ref())
        .max_by_key(|block| match block {
            Block::Limit { .. } | Block::Unavailable(_) => 3,
            Block::Author(_) | Block::Excluded(_) | Block::Rule(_) => 2,
            Block::Floor(_) | Block::Needs(_) => 1,
        })
        .map_or_else(
            || format!("{} has no models listed", name(provider)),
            |block| block.why().to_owned(),
        )
}

/// The effort: the pin's, else the registry's for this category, fitted to the model and never
/// above `high`.
fn effort(query: &Query, pick: &Candidate, notes: &mut Vec<String>) -> Option<String> {
    let pinned = query.pin.as_ref().and_then(|pin| pin.effort.as_deref());
    let registry_effort = pick
        .model
        .registry_key
        .as_deref()
        .and_then(|key| query.registry.entry(key))
        .and_then(|entry| entry.default_effort.get(&query.category))
        .and_then(|effort| clamp_effort(effort));
    let wanted = pinned
        .or(registry_effort)
        .or_else(|| category_effort(query.category));
    let (effort, lowered) = table::fit_effort_in(Some(&pick.model.efforts), wanted);
    if lowered && let Some(pinned) = pinned {
        notes.push(format!(
            "effort lowered from {pinned} to {}",
            effort.as_deref().unwrap_or("the default")
        ));
    }
    effort
}

// ----- waiting -------------------------------------------------------------------------------

fn waiting(query: &Query, candidates: &[Candidate], only: &[&OverrideRule]) -> Waiting {
    let rule = (!only.is_empty()).then(|| join_rules(only));
    let purpose = table::row(query.category).purpose;
    // Models kept out only by a limit: the task runs when the first of them resets.
    let limited: Vec<(&str, Option<i64>)> = candidates
        .iter()
        .filter_map(|c| match &c.block {
            Some(Block::Limit { why, resets_at_ms }) => Some((why.as_str(), *resets_at_ms)),
            _ => None,
        })
        .collect();
    let earliest = limited
        .iter()
        .min_by_key(|(_, reset)| reset.unwrap_or(i64::MAX))
        .copied();
    let reason = match (earliest, &rule) {
        (Some((why, _)), Some(rule)) => {
            format!("your rule ({rule}) allows only models at a limit: {why}")
        }
        (Some((why, _)), None) => format!("Waiting for quota: {why}"),
        (None, Some(rule)) => {
            format!("your rule ({rule}) allows no model that can take this {purpose} work")
        }
        (None, None) => {
            if !query.providers.iter().any(|s| s.logged_in) {
                "no provider is logged in".to_owned()
            } else {
                format!(
                    "no available model at the {} tier or above can take this {purpose} work",
                    tier_name(query.floor)
                )
            }
        }
    };
    Waiting {
        reason: capitalize(&reason),
        resets_at_ms: earliest.and_then(|(_, reset)| reset),
        rule,
    }
}

// ----- rules ---------------------------------------------------------------------------------

fn applies(rule: &OverrideRule, query: &Query) -> bool {
    rule.project_id
        .as_deref()
        .is_none_or(|project| query.project_id == Some(project))
        && (rule.categories.is_empty() || rule.categories.contains(&query.category))
        && (rule.areas.is_empty() || rule.areas.iter().any(|area| query.areas.contains(area)))
}

/// Whether a rule's target covers a model.
pub fn targets(target: &OverrideTarget, model: &MergedModel, registry: &Registry) -> bool {
    match target {
        OverrideTarget::Vendor { provider } => model.provider == *provider,
        OverrideTarget::Family { provider, family } => {
            model.provider == *provider
                && (model
                    .family
                    .as_deref()
                    .is_some_and(|own| own.eq_ignore_ascii_case(family))
                    || table::has_word(&model.id, family))
        }
        OverrideTarget::Model { provider, id } => {
            model.provider == *provider && is_model(model, registry, id)
        }
    }
}

/// A rule as the user would say it: "never Claude opus for implementation on frontend".
pub fn rule_text(rule: &OverrideRule) -> String {
    let effect = match rule.effect {
        OverrideEffect::Never => "never",
        OverrideEffect::Prefer => "prefer",
        OverrideEffect::Only => "only",
    };
    let target = match &rule.target {
        OverrideTarget::Vendor { provider } => name(*provider).to_owned(),
        OverrideTarget::Family { provider, family } => format!("{} {family}", name(*provider)),
        OverrideTarget::Model { provider, id } => format!("{} {id}", name(*provider)),
    };
    let mut text = format!("{effect} {target}");
    if !rule.categories.is_empty() {
        let purposes: Vec<&str> = rule
            .categories
            .iter()
            .map(|category| table::row(*category).purpose)
            .collect();
        text.push_str(" for ");
        text.push_str(&purposes.join(", "));
    }
    if !rule.areas.is_empty() {
        text.push_str(" on ");
        text.push_str(&areas_text(&rule.areas));
    }
    text
}

fn join_rules(rules: &[&OverrideRule]) -> String {
    rules
        .iter()
        .map(|rule| rule_text(rule))
        .collect::<Vec<_>>()
        .join("; ")
}

// ----- explanation ---------------------------------------------------------------------------

fn score_why(query: &Query, pick: &Candidate, tie: bool, only: Option<&str>) -> String {
    let purpose = table::row(query.category).purpose;
    let mut evidence = if pick.model.status == ModelStatus::Curated {
        format!("registry {}", number(pick.base))
    } else {
        format!("strength {}", number(pick.base))
    };
    if let Some(learned) = pick.learned.filter(|l| l.adjustment.abs() >= 0.3) {
        evidence.push_str("; ");
        evidence.push_str(&evidence_short(learned));
    }
    if tie {
        evidence.push_str(&format!("; ties go to {} here", name(pick.model.provider)));
    }
    let lead = if only.is_some() {
        format!("the best {purpose} score your rule allows")
    } else {
        format!("the top {purpose} score here")
    };
    format!("{lead} ({evidence})")
}

/// Whether `rival`, unpenalized, would have beaten the pick (on score, or on a tie by vendor
/// order).
fn would_beat(rival: &Candidate, pick: &Candidate, rank: &dyn Fn(&Candidate) -> usize) -> bool {
    let (theirs, ours) = (rival.score + rival.penalty, pick.score);
    theirs > ours + TIE || ((theirs - ours).abs() <= TIE && rank(rival) < rank(pick))
}

/// A better model kept out by a limit (or its provider being logged out), if one was.
fn limited_rival(
    candidates: &[Candidate],
    pick: &Candidate,
    rank: impl Fn(&Candidate) -> usize,
) -> Option<String> {
    candidates
        .iter()
        .filter(|c| !c.model.legacy && would_beat(c, pick, &rank))
        .filter(|c| matches!(c.block, Some(Block::Limit { .. } | Block::Unavailable(_))))
        .max_by(|a, b| (a.score + a.penalty).total_cmp(&(b.score + b.penalty)))
        .and_then(|c| c.block.as_ref().map(|block| block.why().to_owned()))
}

/// Up to three models not chosen, most telling first: the runner-up, better models kept out
/// (by a limit, a rule or the floor), the other vendors' best, then the rest.
fn alternatives(
    candidates: &[Candidate],
    ranked: &[usize],
    chosen: usize,
    pinned: bool,
    rank: impl Fn(&Candidate) -> usize,
) -> Vec<Alternative> {
    let pick = &candidates[chosen];
    let unpenalized = |c: &&Candidate| c.score + c.penalty;
    let mut order: Vec<&Candidate> = Vec::new();
    let runners: Vec<&Candidate> = ranked
        .iter()
        .copied()
        .filter(|i| *i != chosen)
        .map(|i| &candidates[i])
        .collect();
    let mut blocked: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| !c.eligible() && !c.model.legacy)
        .collect();
    blocked.sort_by(|a, b| unpenalized(b).total_cmp(&unpenalized(a)));
    order.extend(runners.first());
    order.extend(blocked.iter().filter(|c| would_beat(c, pick, &rank)));
    for provider in ProviderKind::ALL {
        if provider != pick.model.provider {
            order.extend(
                candidates
                    .iter()
                    .filter(|c| c.model.provider == provider && !c.model.legacy)
                    .max_by(|a, b| unpenalized(a).total_cmp(&unpenalized(b))),
            );
        }
    }
    order.extend(runners.iter().copied());
    order.extend(blocked.iter().copied());

    let mut shown: Vec<Alternative> = Vec::new();
    for c in order {
        if shown.len() == 3 {
            break;
        }
        if shown
            .iter()
            .any(|a| a.provider == c.model.provider && a.model == c.model.id)
        {
            continue;
        }
        let why_not = match &c.block {
            Some(block) => block.why().to_owned(),
            None if pick.preferred.is_some() && c.preferred.is_none() => {
                "your rule prefers another model".to_owned()
            }
            None if pinned => "not the model asked for".to_owned(),
            None if (c.score - pick.score).abs() <= TIE => {
                "tied, and ties go the other way here".to_owned()
            }
            None => format!(
                "scored lower ({} vs {})",
                number(c.score),
                number(pick.score)
            ),
        };
        shown.push(Alternative {
            provider: c.model.provider,
            model: c.model.id.clone(),
            score: c.eligible().then(|| round(c.score)),
            why_not,
        });
    }
    shown
}

/// Learned evidence for the factor list.
fn evidence(learned: &Learned) -> String {
    format!("learned here: {}", evidence_short(learned))
}

fn evidence_short(learned: &Learned) -> String {
    let n = learned.samples;
    match (learned.review_pass_rate, learned.verification_pass_rate) {
        (Some(rate), _) => format!(
            "{:.0}% of its reviewed work passed first time over {n} task{}",
            rate * 100.0,
            if n == 1 { "" } else { "s" }
        ),
        _ => {
            let good = (learned.success_rate * f64::from(n)).round() as u32;
            format!(
                "{good} of {n} task{} succeeded",
                if n == 1 { "" } else { "s" }
            )
        }
    }
}

fn window_name(vendor: &str, label: Option<&str>) -> String {
    match label {
        Some(label) if !label.is_empty() => {
            let mut chars = label.chars();
            let first = chars
                .next()
                .map(|c| c.to_lowercase().to_string())
                .unwrap_or_default();
            format!("{vendor}'s {first}{} window", chars.as_str())
        }
        _ => format!("{vendor}'s usage window"),
    }
}

/// " (resets in 2h 10m)".
fn resets_text(resets_at_ms: Option<i64>, now_ms: i64) -> String {
    let Some(reset) = resets_at_ms else {
        return String::new();
    };
    let minutes = ((reset - now_ms).max(0) + 59_999) / 60_000;
    let (days, hours, mins) = (minutes / 1440, (minutes % 1440) / 60, minutes % 60);
    let span = if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {mins}m")
    } else {
        format!("{mins}m")
    };
    format!(" (resets in {span})")
}

fn tier_name(tier: QualityTier) -> &'static str {
    match tier {
        QualityTier::Unrated => "unrated",
        QualityTier::Light => "light",
        QualityTier::Standard => "standard",
        QualityTier::Strong => "strong",
        QualityTier::Frontier => "frontier",
    }
}

fn areas_text(areas: &[Area]) -> String {
    areas
        .iter()
        .map(|area| match area {
            Area::Frontend => "frontend",
            Area::Backend => "backend",
            Area::Infra => "infra",
            Area::Docs => "docs",
            Area::Tests => "tests",
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn tokens_text(tokens: i64) -> String {
    if tokens >= 1_000_000 {
        format!("{}M", number(tokens as f64 / 1_000_000.0))
    } else {
        format!("{}k", tokens / 1000)
    }
}

/// A score for text: one decimal, without a trailing `.0`.
fn number(value: f64) -> String {
    let text = format!("{value:.1}");
    text.strip_suffix(".0").map(str::to_owned).unwrap_or(text)
}

fn round(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}
