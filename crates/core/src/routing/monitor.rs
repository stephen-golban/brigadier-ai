//! The quota monitor: every provider's usage windows as the CLIs report them, merged over
//! time, with the sample history the rolling estimates are made from.
//!
//! - **Sources.** A read (`get_usage`, `account/rateLimits/read`) replaces what is known; a
//!   running session's rate-limit events update the windows they name
//!   ([`QuotaSnapshot::merge`]).
//! - **Limits lift on time.** A used-up window's limit counts until its reset time; then the
//!   window reads as unused until the next read says otherwise. A spend control or a credits
//!   stop is lifted only by a fresh read.
//! - **History.** A sample is kept when a window's use changes, and every half hour while it
//!   does not, in memory for the estimates and in `routing.sqlite` across launches.
//! - **Polling.** The runtime reads each logged-in provider every 5 minutes while sessions
//!   report activity, every 30 minutes otherwise, and just after a known reset.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use brigadier_providers::{LimitHit, LimitKind, ProviderKind, QuotaSnapshot, QuotaSource};
use brigadier_router::QuotaSample;

use super::store::{HISTORY_MS, RoutingStore, StoredSample};

/// A provider that reported activity this recently counts as in use (polled more often).
const BUSY_FOR_MS: i64 = 10 * 60 * 1000;
const POLL_BUSY: Duration = Duration::from_secs(5 * 60);
const POLL_IDLE: Duration = Duration::from_secs(30 * 60);
/// A read this long after a known reset sees the new window.
const AFTER_RESET: Duration = Duration::from_secs(30);
const MIN_POLL: Duration = Duration::from_secs(30);
/// An unchanged window still gets a sample this often, so a quiet stretch shows as flat.
const SAMPLE_UNCHANGED_MS: i64 = 30 * 60 * 1000;
/// Changes smaller than this (in percentage points) are not new samples.
const SAMPLE_EPSILON: f64 = 0.05;

#[derive(Default)]
struct Tracked {
    quota: Option<QuotaSnapshot>,
    /// Samples per window id, oldest first, for the last [`HISTORY_MS`].
    history: HashMap<String, VecDeque<QuotaSample>>,
    /// When a running session last reported this provider's quota.
    last_event_ms: i64,
    /// Development builds: a limit injected to exercise fallback, held until its reset.
    #[cfg(debug_assertions)]
    injected: Option<LimitHit>,
}

pub struct QuotaMonitor {
    store: Option<Arc<RoutingStore>>,
    state: Mutex<HashMap<ProviderKind, Tracked>>,
}

impl QuotaMonitor {
    /// A monitor over `store`, with the history it holds loaded.
    pub async fn load(store: Option<Arc<RoutingStore>>, now_ms: i64) -> Arc<Self> {
        let mut state: HashMap<ProviderKind, Tracked> = HashMap::new();
        if let Some(store) = &store {
            if let Err(err) = store.prune(now_ms).await {
                tracing::warn!(error = %err, "could not prune the quota history");
            }
            match store.samples_since(now_ms - HISTORY_MS).await {
                Ok(samples) => {
                    for stored in samples {
                        state
                            .entry(stored.provider)
                            .or_default()
                            .history
                            .entry(stored.window)
                            .or_default()
                            .push_back(stored.sample);
                    }
                }
                Err(err) => tracing::warn!(error = %err, "could not load the quota history"),
            }
        }
        Arc::new(Self {
            store,
            state: Mutex::new(state),
        })
    }

    fn state(&self) -> MutexGuard<'_, HashMap<ProviderKind, Tracked>> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes in a provider's report and answers what is known now. New samples are stored in
    /// the background.
    pub fn note(&self, incoming: &QuotaSnapshot, now_ms: i64) -> QuotaSnapshot {
        let (current, samples) = {
            let mut state = self.state();
            let tracked = state.entry(incoming.provider).or_default();
            if incoming.source == QuotaSource::Event {
                tracked.last_event_ms = now_ms;
            }
            match &mut tracked.quota {
                Some(known) => known.merge(incoming),
                None => tracked.quota = Some(incoming.clone()),
            }
            let samples = sample(tracked, incoming.provider, now_ms);
            (current(tracked, now_ms), samples)
        };
        if let Some(store) = &self.store
            && !samples.is_empty()
        {
            let store = store.clone();
            tokio::spawn(async move {
                if let Err(err) = store.add_samples(samples).await {
                    tracing::warn!(error = %err, "could not store quota samples");
                }
            });
        }
        current.unwrap_or_else(|| incoming.clone())
    }

    /// What is known about a provider's quota now: limits past their reset lifted, windows past
    /// their reset read as unused.
    pub fn current(&self, provider: ProviderKind, now_ms: i64) -> Option<QuotaSnapshot> {
        self.state()
            .get(&provider)
            .and_then(|tracked| current(tracked, now_ms))
    }

    /// A window's samples since `since_ms`, oldest first.
    pub fn history(&self, provider: ProviderKind, window: &str, since_ms: i64) -> Vec<QuotaSample> {
        self.state()
            .get(&provider)
            .and_then(|tracked| tracked.history.get(window))
            .map(|samples| {
                samples
                    .iter()
                    .filter(|sample| sample.at_ms >= since_ms)
                    .copied()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// How long until the providers should be read again.
    pub fn next_poll(&self, now_ms: i64) -> Duration {
        let state = self.state();
        let busy = state
            .values()
            .any(|tracked| now_ms - tracked.last_event_ms < BUSY_FOR_MS);
        let mut wait = if busy { POLL_BUSY } else { POLL_IDLE };
        let resets = state
            .values()
            .filter_map(|tracked| tracked.quota.as_ref())
            .flat_map(|quota| {
                quota
                    .windows
                    .iter()
                    .filter_map(|window| window.resets_at_ms)
                    .chain(quota.limit.as_ref().and_then(|limit| limit.resets_at_ms))
            })
            .filter(|at| *at > now_ms);
        for at in resets {
            let until =
                Duration::from_millis(u64::try_from(at - now_ms).unwrap_or(0)) + AFTER_RESET;
            wait = wait.min(until);
        }
        wait.max(MIN_POLL)
    }

    /// Takes in a limit a session's error reported (a CLI can say it is at its limit without
    /// a rate-limit notification): the provider counts as limited until the limit's reset, or,
    /// when the error didn't say, until a read shows it clear.
    pub fn note_limit(
        &self,
        provider: ProviderKind,
        limit: LimitHit,
        now_ms: i64,
    ) -> QuotaSnapshot {
        let incoming = {
            let state = self.state();
            let windows = state
                .get(&provider)
                .and_then(|tracked| tracked.quota.as_ref())
                .map(|quota| quota.windows.clone())
                .unwrap_or_default();
            QuotaSnapshot {
                provider,
                windows,
                limit: Some(limit),
                observed_at_ms: now_ms,
                source: QuotaSource::Event,
            }
        };
        self.note(&incoming, now_ms)
    }

    /// Development builds: makes `provider` refuse work as `limit` says until its reset, so
    /// no read can clear it early.
    #[cfg(debug_assertions)]
    pub fn inject(&self, provider: ProviderKind, limit: LimitHit) {
        self.state().entry(provider).or_default().injected = Some(limit);
    }
}

/// The known quota with the time applied.
fn current(tracked: &Tracked, now_ms: i64) -> Option<QuotaSnapshot> {
    let mut quota = tracked.quota.clone()?;
    for window in &mut quota.windows {
        if window.resets_at_ms.is_some_and(|at| at <= now_ms) {
            window.used_percent = 0.0;
            window.resets_at_ms = None;
        }
    }
    if quota.limit.as_ref().is_some_and(|limit| {
        limit.kind == LimitKind::UsageWindow && limit.resets_at_ms.is_some_and(|at| at <= now_ms)
    }) {
        quota.limit = None;
    }
    #[cfg(debug_assertions)]
    if let Some(injected) = &tracked.injected
        && injected.resets_at_ms.is_none_or(|at| at > now_ms)
    {
        quota.limit = Some(injected.clone());
        if let Some(window) = quota
            .windows
            .iter_mut()
            .find(|window| injected.window.as_deref() == Some(window.id.as_str()))
        {
            window.used_percent = 100.0;
            window.resets_at_ms = injected.resets_at_ms;
        }
    }
    Some(quota)
}

/// New samples for the windows of `tracked`'s quota, added to its history.
fn sample(tracked: &mut Tracked, provider: ProviderKind, now_ms: i64) -> Vec<StoredSample> {
    let Some(quota) = &tracked.quota else {
        return Vec::new();
    };
    let mut stored = Vec::new();
    for window in &quota.windows {
        let history = tracked.history.entry(window.id.clone()).or_default();
        let due = history.back().is_none_or(|last| {
            (last.used_percent - window.used_percent).abs() >= SAMPLE_EPSILON
                || now_ms - last.at_ms >= SAMPLE_UNCHANGED_MS
        });
        if !due {
            continue;
        }
        let sample = QuotaSample {
            at_ms: now_ms,
            used_percent: window.used_percent,
        };
        history.push_back(sample);
        while history
            .front()
            .is_some_and(|first| first.at_ms < now_ms - HISTORY_MS)
        {
            history.pop_front();
        }
        stored.push(StoredSample {
            provider,
            window: window.id.clone(),
            sample,
            resets_at_ms: window.resets_at_ms,
        });
    }
    stored
}
