//! Outcome learning: what a project's outcomes say about each model per task category, and how
//! far that moves the model's registry strength there.
//!
//! **Which outcomes count.** Stopped tasks say nothing about the model and are ignored. A
//! hand-off (its window ran out mid-task) says nothing about quality either: it counts only
//! towards the model's quota use. Everything else is a quality sample.
//!
//! **Quality.** Each sample scores `q` in 0..=1:
//! - a change that landed, or a read-only task that finished: 1; rejected or failed: 0;
//! - review pass rate: −0.2 when its first review asked for changes;
//! - rework rounds: −0.1 per round it was sent back, at most −0.3;
//! - verification results: −0.3 when the project's checks failed on its work (not for verify
//!   tasks themselves, whose result is the checks', not the model's).
//!
//! The registry strength `s` (0–10) is the prior, as a success rate `s / 10` worth
//! [`PRIOR_WEIGHT`] pseudo-samples (a Beta prior). With `n` samples scoring `Σq`, the posterior
//! rate is `(PRIOR_WEIGHT·s/10 + Σq) / (PRIOR_WEIGHT + n)`, and the quality term is its distance
//! from the prior back on the 0–10 scale. Six perfect runs lift a strength-9 model by 0.5; six
//! failures drop it by 4.5, capped below.
//!
//! **Cost.** Two small terms, relative to the median of every model's outcomes in the same
//! category of the project (needs at least [`MIN_COST_SAMPLES`] there):
//! - time: the model's median duration against the category's, `−0.25 × log2(ratio)` clamped
//!   to ±0.25 (twice as slow: −0.25; half the time: +0.25);
//! - quota: the same on its median share of the provider's shortest window per task, or its
//!   median tokens when no share is recorded (hand-offs included here).
//!
//! Each cost term is shrunk like the quality term (`m / (m + PRIOR_WEIGHT)` for `m` samples of
//! it), so a single fast run moves little.
//!
//! The adjustment is the sum, capped at ±[`MAX_ADJUSTMENT`].

use std::collections::BTreeMap;

use brigadier_providers::ProviderKind;

use crate::TaskCategory;
use crate::merge::{UNRATED_STRENGTH, counts_for_quality};
use crate::outcome::{Learned, Outcome, OutcomeResult};
use crate::registry::{MergedModel, Registry};

/// Pseudo-samples the registry prior is worth.
pub const PRIOR_WEIGHT: f64 = 6.0;
/// The most outcomes can move a strength, either way.
pub const MAX_ADJUSTMENT: f64 = 2.5;
/// The most each cost term (time, quota) can move a strength, either way.
pub const MAX_COST_TERM: f64 = 0.25;
/// Outcomes a category needs in the project before cost is compared against its median.
pub const MIN_COST_SAMPLES: usize = 3;

const REVIEW_FAILED_FIRST: f64 = 0.2;
const PER_REWORK_ROUND: f64 = 0.1;
const MAX_REWORK: f64 = 0.3;
const CHECKS_FAILED: f64 = 0.3;

/// What one project's outcomes teach, per (provider, model, category). `models` and `registry`
/// supply each model's registry strength as the prior (a model neither knows starts at 5).
pub fn learn(outcomes: &[Outcome], models: &[MergedModel], registry: &Registry) -> Vec<Learned> {
    let mut groups: BTreeMap<(String, String, TaskCategory), Vec<&Outcome>> = BTreeMap::new();
    for outcome in outcomes {
        if outcome.result == OutcomeResult::Stopped {
            continue;
        }
        groups
            .entry((
                outcome.provider.to_string(),
                outcome.model.to_ascii_lowercase(),
                outcome.category,
            ))
            .or_default()
            .push(outcome);
    }

    // Category medians in this project, across every model.
    let mut durations: BTreeMap<TaskCategory, Vec<f64>> = BTreeMap::new();
    let mut quota: BTreeMap<TaskCategory, Vec<f64>> = BTreeMap::new();
    let mut tokens: BTreeMap<TaskCategory, Vec<f64>> = BTreeMap::new();
    for outcome in outcomes {
        if outcome.result == OutcomeResult::Stopped {
            continue;
        }
        if counts_for_quality(outcome.result) && outcome.duration_ms > 0 {
            durations
                .entry(outcome.category)
                .or_default()
                .push(outcome.duration_ms as f64);
        }
        if let Some(share) = outcome.quota_percent.filter(|share| share.is_finite()) {
            quota.entry(outcome.category).or_default().push(share);
        }
        if outcome.tokens > 0 {
            tokens
                .entry(outcome.category)
                .or_default()
                .push(outcome.tokens as f64);
        }
    }

    groups
        .into_values()
        .map(|group| {
            let first = group[0];
            let prior = prior_strength(
                models,
                registry,
                first.provider,
                &first.model,
                first.category,
            );
            learned(
                &group,
                prior,
                durations.get(&first.category),
                quota.get(&first.category),
                tokens.get(&first.category),
            )
        })
        .collect()
}

/// What was learned about a model in a category, if anything.
pub fn learned_for<'l>(
    learned: &'l [Learned],
    model: &MergedModel,
    registry: &Registry,
    category: TaskCategory,
) -> Option<&'l Learned> {
    learned.iter().find(|learned| {
        learned.provider == model.provider
            && learned.category == category
            && is_model(model, registry, &learned.model)
    })
}

/// Whether `name` (an id or the concrete model an alias resolves to) is this model.
pub(crate) fn is_model(model: &MergedModel, registry: &Registry, name: &str) -> bool {
    model.id.eq_ignore_ascii_case(name)
        || model
            .registry_key
            .as_deref()
            .filter(|_| model.status == crate::ModelStatus::Curated)
            .and_then(|key| registry.entry(key))
            .is_some_and(|entry| {
                entry
                    .matches
                    .ids
                    .iter()
                    .any(|id| id.eq_ignore_ascii_case(name))
            })
}

fn prior_strength(
    models: &[MergedModel],
    registry: &Registry,
    provider: ProviderKind,
    model: &str,
    category: TaskCategory,
) -> f64 {
    models
        .iter()
        .find(|merged| merged.provider == provider && is_model(merged, registry, model))
        .and_then(|merged| merged.strengths.get(&category).copied())
        .unwrap_or(UNRATED_STRENGTH)
}

fn learned(
    group: &[&Outcome],
    prior: f64,
    category_durations: Option<&Vec<f64>>,
    category_quota: Option<&Vec<f64>>,
    category_tokens: Option<&Vec<f64>>,
) -> Learned {
    let first = group[0];
    let quality: Vec<&&Outcome> = group
        .iter()
        .filter(|outcome| counts_for_quality(outcome.result))
        .collect();
    let n = quality.len() as f64;

    let scores: f64 = quality.iter().map(|outcome| sample_score(outcome)).sum();
    let p0 = (prior / 10.0).clamp(0.0, 1.0);
    let posterior = (PRIOR_WEIGHT * p0 + scores) / (PRIOR_WEIGHT + n);
    let quality_term = (posterior - p0) * 10.0;

    let succeeded = quality
        .iter()
        .filter(|outcome| matches!(outcome.result, OutcomeResult::Landed | OutcomeResult::Done))
        .count() as f64;
    let rate = |values: Vec<bool>| {
        (!values.is_empty())
            .then(|| values.iter().filter(|passed| **passed).count() as f64 / values.len() as f64)
    };
    let review_pass_rate = rate(
        quality
            .iter()
            .filter_map(|o| o.review_passed_first)
            .collect(),
    );
    let verification_pass_rate = rate(quality.iter().filter_map(|o| o.verification).collect());
    let avg_rework = (n > 0.0).then(|| {
        quality
            .iter()
            .map(|o| f64::from(o.rework_rounds))
            .sum::<f64>()
            / n
    });

    let own_durations: Vec<f64> = quality
        .iter()
        .filter(|o| o.duration_ms > 0)
        .map(|o| o.duration_ms as f64)
        .collect();
    let own_quota: Vec<f64> = group
        .iter()
        .filter_map(|o| o.quota_percent.filter(|share| share.is_finite()))
        .collect();
    let own_tokens: Vec<f64> = group
        .iter()
        .filter(|o| o.tokens > 0)
        .map(|o| o.tokens as f64)
        .collect();

    let time_term = cost_term(&own_durations, category_durations);
    let quota_term = if own_quota.is_empty() {
        cost_term(&own_tokens, category_tokens)
    } else {
        cost_term(&own_quota, category_quota)
    };

    Learned {
        provider: first.provider,
        model: first.model.clone(),
        category: first.category,
        samples: u32::try_from(quality.len()).unwrap_or(u32::MAX),
        success_rate: if n > 0.0 { succeeded / n } else { 0.0 },
        review_pass_rate,
        avg_rework,
        verification_pass_rate,
        median_duration_ms: median(&own_durations).map(|ms| ms as i64),
        median_tokens: median(&own_tokens).map(|tokens| tokens as i64),
        adjustment: (quality_term + time_term + quota_term).clamp(-MAX_ADJUSTMENT, MAX_ADJUSTMENT),
    }
}

/// One sample's quality score (see the module docs).
fn sample_score(outcome: &Outcome) -> f64 {
    if !matches!(outcome.result, OutcomeResult::Landed | OutcomeResult::Done) {
        return 0.0;
    }
    let mut score = 1.0;
    if outcome.review_passed_first == Some(false) {
        score -= REVIEW_FAILED_FIRST;
    }
    score -= (f64::from(outcome.rework_rounds) * PER_REWORK_ROUND).min(MAX_REWORK);
    if outcome.verification == Some(false) && outcome.category != TaskCategory::Verify {
        score -= CHECKS_FAILED;
    }
    score.clamp(0.0, 1.0)
}

/// A cost term: cheaper than the category median is positive (see the module docs).
fn cost_term(own: &[f64], category: Option<&Vec<f64>>) -> f64 {
    let Some(category) = category.filter(|values| values.len() >= MIN_COST_SAMPLES) else {
        return 0.0;
    };
    let (Some(own_median), Some(category_median)) = (median(own), median(category)) else {
        return 0.0;
    };
    if own_median <= 0.0 || category_median <= 0.0 {
        return 0.0;
    }
    let m = own.len() as f64;
    let raw = (-MAX_COST_TERM * (own_median / category_median).log2())
        .clamp(-MAX_COST_TERM, MAX_COST_TERM);
    raw * m / (m + PRIOR_WEIGHT)
}

fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    Some(if sorted.len().is_multiple_of(2) {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    } else {
        sorted[mid]
    })
}
