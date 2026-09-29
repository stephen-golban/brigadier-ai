//! Quota estimates: where each usage window is heading, how hot a provider runs, and what that
//! costs a model's routing score. Pure: the daemon's quota monitor keeps the samples and calls
//! these with the time.
//!
//! - **Rate:** an exponentially weighted average of Δused/Δt over the last hour for windows of
//!   5 hours or less, the last day for longer ones (a window of unknown length counts as short).
//!   Samples are taken as a step function (the monitor stores a value when it changes), so the
//!   value at the start of the look-back is the last sample before it. A drop of more than a
//!   point is a reset and that interval is skipped; smaller drops count as no use. Recent
//!   intervals weigh more (time constant: a third of the look-back).
//! - **Forecast:** `projected_at_reset = used + rate × time left`, and "runs out at" when that
//!   passes 100. Absent until the samples span 10 minutes (short windows) or an hour.
//! - **Heat:** Limited when a limit names the window or it is 97% used; Hot when projected at 90%
//!   or 85% used; Warm when projected at 70%; else Cool. A provider's heat is its hottest
//!   provider-wide window (Limited while a limit is set); a window scoped to one model counts only
//!   for that model ([`window_applies`]).
//! - **Penalty:** 0 below a projected 70%, rising smoothly (smoothstep) to [`MAX_QUOTA_PENALTY`]
//!   at 100%. A confirmed limit is never a penalty: routing excludes the model outright.

use brigadier_providers::{LimitHit, LimitKind, QuotaSnapshot, QuotaWindow};

use crate::quota::{Forecast, Heat, ProviderQuota, QuotaSample, WindowState};
use crate::registry::{MergedModel, ModelStatus, Registry};
use crate::table;

/// Windows up to this long use the short look-back.
pub const SHORT_WINDOW_MINUTES: i64 = 300;
const SHORT_LOOKBACK_MS: i64 = 60 * 60 * 1000;
const LONG_LOOKBACK_MS: i64 = 24 * 60 * 60 * 1000;
const SHORT_MIN_SPAN_MS: i64 = 10 * 60 * 1000;
const LONG_MIN_SPAN_MS: i64 = 60 * 60 * 1000;
/// A fall of more than this many points between samples is a reset, not use.
const RESET_DROP: f64 = 1.0;
const HOUR_MS: f64 = 3_600_000.0;

/// Used share at which a window counts as used up.
pub const LIMITED_USED: f64 = 97.0;
pub const HOT_USED: f64 = 85.0;
pub const HOT_PROJECTED: f64 = 90.0;
pub const WARM_PROJECTED: f64 = 70.0;
/// The largest quota penalty, at a projected 100% or more.
pub const MAX_QUOTA_PENALTY: f64 = 6.0;

/// One window's state from its samples (any order; the monitor's history for this window) and
/// its current reading, taken at `observed_at_ms`. `limited`: a provider limit names it.
pub fn window_state(
    window: &QuotaWindow,
    samples: &[QuotaSample],
    observed_at_ms: i64,
    limited: bool,
    now_ms: i64,
) -> WindowState {
    let forecast = forecast(window, samples, observed_at_ms, now_ms);
    let projected = forecast.map_or(window.used_percent, |f| f.projected_at_reset);
    WindowState {
        window: window.clone(),
        forecast,
        heat: heat(window.used_percent, projected, limited),
    }
}

/// A provider's quota as routing sees it: each window's state, and the provider's limit unless
/// it has expired (a usage window's limit lifts at its reset; a spend control or credits only by
/// a fresh read, which replaces the snapshot). `history` pairs a window id with its samples.
pub fn provider_quota(
    snapshot: &QuotaSnapshot,
    history: &[(&str, &[QuotaSample])],
    now_ms: i64,
) -> ProviderQuota {
    let limit = active_limit(snapshot.limit.as_ref(), now_ms).cloned();
    let windows: Vec<WindowState> = snapshot
        .windows
        .iter()
        .map(|window| {
            let samples = history
                .iter()
                .find(|(id, _)| *id == window.id)
                .map_or(&[][..], |(_, samples)| *samples);
            let limited = limit
                .as_ref()
                .is_some_and(|limit| limit.window.as_deref() == Some(window.id.as_str()));
            window_state(window, samples, snapshot.observed_at_ms, limited, now_ms)
        })
        .collect();
    let heat = if limit.is_some() {
        Heat::Limited
    } else {
        windows
            .iter()
            .filter(|state| state.window.model.is_none())
            .map(|state| state.heat)
            .max()
            .unwrap_or(Heat::Cool)
    };
    ProviderQuota {
        provider: snapshot.provider,
        windows,
        limit,
        heat,
        observed_at_ms: Some(snapshot.observed_at_ms),
    }
}

/// A limit still in force at `now_ms`.
pub fn active_limit(limit: Option<&LimitHit>, now_ms: i64) -> Option<&LimitHit> {
    limit.filter(|limit| {
        !(limit.kind == LimitKind::UsageWindow
            && limit.resets_at_ms.is_some_and(|reset| reset <= now_ms))
    })
}

/// How hot a window runs, from its used and projected shares.
pub fn heat(used: f64, projected: f64, limited: bool) -> Heat {
    if limited || used >= LIMITED_USED {
        Heat::Limited
    } else if projected >= HOT_PROJECTED || used >= HOT_USED {
        Heat::Hot
    } else if projected >= WARM_PROJECTED {
        Heat::Warm
    } else {
        Heat::Cool
    }
}

/// The score penalty for a window projected at `projected` percent at its reset.
pub fn quota_penalty(projected: f64) -> f64 {
    if projected < WARM_PROJECTED {
        return 0.0;
    }
    let t = ((projected - WARM_PROJECTED) / (100.0 - WARM_PROJECTED)).min(1.0);
    MAX_QUOTA_PENALTY * t * t * (3.0 - 2.0 * t)
}

/// Whether a window limits this model: provider-wide windows limit every model; a scoped one
/// names its model by id, by the concrete id an alias resolves to (the registry entry's ids), or
/// by family word (Claude's `opus`, Codex's `gpt-5.6-luna`).
pub fn window_applies(window: &QuotaWindow, model: &MergedModel, registry: &Registry) -> bool {
    let Some(scope) = window.model.as_deref().map(str::trim) else {
        return true;
    };
    if scope.is_empty() || scope.eq_ignore_ascii_case(&model.id) {
        return true;
    }
    let entry = model
        .registry_key
        .as_deref()
        .and_then(|key| registry.entry(key));
    // The entry's ids name this model only when it is the entry's own (curated); an inherited
    // newer version is not the model a window for the entry's id limits.
    let own_entry = entry.filter(|_| model.status == ModelStatus::Curated);
    own_entry.is_some_and(|entry| {
        entry
            .matches
            .ids
            .iter()
            .any(|id| id.eq_ignore_ascii_case(scope))
    }) || model
        .family
        .as_deref()
        .is_some_and(|family| family.eq_ignore_ascii_case(scope))
        || (table::words(scope).count() == 1 && table::has_word(&model.id, scope))
}

/// Where a window is heading, if its samples say enough.
fn forecast(
    window: &QuotaWindow,
    samples: &[QuotaSample],
    observed_at_ms: i64,
    now_ms: i64,
) -> Option<Forecast> {
    let short = window
        .window_minutes
        .is_none_or(|minutes| minutes <= SHORT_WINDOW_MINUTES);
    let (lookback, min_span) = if short {
        (SHORT_LOOKBACK_MS, SHORT_MIN_SPAN_MS)
    } else {
        (LONG_LOOKBACK_MS, LONG_MIN_SPAN_MS)
    };
    let cutoff = now_ms - lookback;
    let mut sorted: Vec<QuotaSample> = samples
        .iter()
        .copied()
        .filter(|sample| sample.at_ms <= now_ms && sample.used_percent.is_finite())
        .collect();
    sorted.sort_by_key(|sample| sample.at_ms);

    let mut points: Vec<QuotaSample> = Vec::new();
    if let Some(anchor) = sorted.iter().rev().find(|sample| sample.at_ms <= cutoff) {
        points.push(QuotaSample {
            at_ms: cutoff,
            used_percent: anchor.used_percent,
        });
    }
    points.extend(sorted.iter().filter(|sample| sample.at_ms > cutoff));
    if observed_at_ms > cutoff && observed_at_ms <= now_ms {
        match points.last() {
            Some(last) if last.at_ms > observed_at_ms => {}
            Some(last) if last.at_ms == observed_at_ms => {
                points.pop();
                points.push(QuotaSample {
                    at_ms: observed_at_ms,
                    used_percent: window.used_percent,
                });
            }
            _ => points.push(QuotaSample {
                at_ms: observed_at_ms,
                used_percent: window.used_percent,
            }),
        }
    }
    let (first, last) = (points.first()?, points.last()?);
    if points.len() < 2 || last.at_ms - first.at_ms < min_span {
        return None;
    }

    let tau = lookback as f64 / 3.0;
    let mut rate: Option<f64> = None;
    for pair in points.windows(2) {
        let dt = (pair[1].at_ms - pair[0].at_ms) as f64;
        let used = pair[1].used_percent - pair[0].used_percent;
        if dt <= 0.0 || used < -RESET_DROP {
            continue;
        }
        let this = used.max(0.0) / (dt / HOUR_MS);
        let alpha = 1.0 - (-dt / tau).exp();
        rate = Some(rate.map_or(this, |rate| rate + alpha * (this - rate)));
    }
    let rate = rate?;
    let used = window.used_percent;
    let hours_left = window
        .resets_at_ms
        .map(|reset| ((reset - now_ms).max(0)) as f64 / HOUR_MS);
    let projected = used + rate * hours_left.unwrap_or(0.0);
    let runs_out_at_ms = (rate > 0.0 && projected > 100.0).then(|| {
        let hours = ((100.0 - used) / rate).max(0.0);
        now_ms + (hours * HOUR_MS) as i64
    });
    Some(Forecast {
        rate_per_hour: rate,
        projected_at_reset: projected,
        runs_out_at_ms,
        samples: u32::try_from(points.len()).unwrap_or(u32::MAX),
    })
}
