//! Routing v2 in the manager (PLAN.md §6 Phase 5): what [`brigadier_router::decide`] needs,
//! gathered from the runtime (logins, the quota monitor, the registry, each CLI's model list)
//! and `routing.sqlite` (outcomes and research), and what its decision becomes on a task.

use std::sync::Arc;

use brigadier_router::{
    Area, Author, Decision, Exclusion, Learned, MergedModel, Needs, Pin, Preview, ProviderState,
    QualityTier, Query, Registry, Routed, TaskCategory,
};

use super::SessionManager;
use crate::model::{ModelChoice, ProjectId};
use crate::work::Route;

/// One in this many low-risk tasks may go to a model on trial.
const TRIAL_EVERY: u64 = 5;
/// `routing.sqlite` meta key counting low-risk tasks, for trial slots.
const TRIAL_COUNTER: &str = "trial_counter";

/// A routing question, as the manager asks it.
pub(crate) struct Ask<'a> {
    pub category: TaskCategory,
    pub areas: &'a [Area],
    pub floor: QualityTier,
    pub needs: Needs,
    pub pin: Option<Pin>,
    /// The pin binds: a hand-off or a resume stays with the pinned vendor, or waits.
    pub hold_pin: bool,
    pub avoid: Option<Author>,
    /// The models already checking the change (a second reviewer, a verifier).
    pub distinct_from: Vec<Author>,
    pub exclude: &'a [Exclusion],
    pub project_id: Option<&'a ProjectId>,
    /// Whether it may go to a model on trial.
    pub trial: Trial,
}

/// A routing question's claim on the trial slots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Trial {
    /// A task being started: it takes the next slot (the counter moves on).
    Take,
    /// A preview of the next task: it looks at the next slot without taking it.
    Peek,
    /// A task that took a slot when created and waited to start: it still holds it.
    Held,
    /// A fallback or a stand-in: no trial.
    Never,
}

/// What routing knows now, beyond the question.
pub(crate) struct Inputs {
    pub registry: Arc<Registry>,
    pub models: Vec<MergedModel>,
    pub learned: Vec<Learned>,
    pub providers: Vec<ProviderState>,
}

impl SessionManager {
    /// Every provider as routing sees it now.
    pub(crate) fn provider_states(&self, now: i64) -> Vec<ProviderState> {
        brigadier_providers::ProviderKind::ALL
            .into_iter()
            .map(|provider| ProviderState {
                provider,
                logged_in: self.runtime.overview(provider).is_some_and(|overview| {
                    overview
                        .status
                        .as_ref()
                        .is_some_and(|status| status.logged_in)
                }),
                quota: self.runtime.provider_usage(provider, now),
            })
            .collect()
    }

    /// The registry, the merged catalog, what `project`'s outcomes taught and the providers'
    /// states.
    pub(crate) async fn routing_inputs(&self, project: Option<&ProjectId>, now: i64) -> Inputs {
        let registry = self.runtime.registry().current();
        let catalogs: Vec<(
            brigadier_providers::ProviderKind,
            Vec<brigadier_providers::ModelInfo>,
        )> = brigadier_providers::ProviderKind::ALL
            .into_iter()
            .map(|provider| {
                let models = self
                    .runtime
                    .overview(provider)
                    .and_then(|overview| overview.models)
                    .map(|catalog| catalog.models)
                    .unwrap_or_default();
                (provider, models)
            })
            .collect();
        let catalogs: Vec<(
            brigadier_providers::ProviderKind,
            &[brigadier_providers::ModelInfo],
        )> = catalogs
            .iter()
            .map(|(provider, models)| (*provider, models.as_slice()))
            .collect();
        let (outcomes, research) = match self.runtime.routing_store() {
            Some(store) => (
                store.outcomes(None).await.unwrap_or_default(),
                store.research().await.unwrap_or_default(),
            ),
            None => (Vec::new(), Vec::new()),
        };
        let counts = brigadier_router::outcome_counts(&outcomes);
        let models = brigadier_router::merge(&registry, &catalogs, &research, &counts);
        let learned = match project {
            Some(project) => {
                let own: Vec<_> = outcomes
                    .into_iter()
                    .filter(|outcome| outcome.project_id == project.0)
                    .collect();
                brigadier_router::learn(&own, &models, &registry)
            }
            None => Vec::new(),
        };
        Inputs {
            registry,
            models,
            learned,
            providers: self.provider_states(now),
        }
    }

    /// Whether the model `choice` names can run now: its provider ready, and no window that
    /// limits that model used up (a model's own weekly window included). A model routing
    /// doesn't list is judged by its provider. Whether the user switched it off is not asked:
    /// this is about a conversation already running on it.
    pub(crate) async fn choice_available(&self, choice: &ModelChoice) -> bool {
        if !self.provider_ready(choice.provider) {
            return false;
        }
        let Some(id) = choice.model.as_deref() else {
            return true;
        };
        let now = crate::now_ms();
        let inputs = self.routing_inputs(None, now).await;
        inputs
            .models
            .iter()
            .find(|model| {
                model.provider == choice.provider
                    && brigadier_router::is_model(model, &inputs.registry, id)
            })
            .is_none_or(|model| {
                brigadier_router::available(model, &inputs.providers, &inputs.registry, now)
            })
    }

    /// Asks the router.
    pub(crate) async fn decide(&self, ask: &Ask<'_>) -> Decision {
        self.preview(ask).await.0.decision
    }

    /// Asks the router, keeping every model it weighed (the Routing page's live order), and
    /// says whether the question held a trial slot.
    pub(crate) async fn preview(&self, ask: &Ask<'_>) -> (Preview, bool) {
        let now = crate::now_ms();
        let inputs = self.routing_inputs(ask.project_id, now).await;
        let settings = self.core.settings();
        let running = self.running_workers();
        let trial_slot = match ask.trial {
            Trial::Take => self.trial_slot(ask.category, true).await,
            Trial::Peek => self.trial_slot(ask.category, false).await,
            Trial::Held => true,
            Trial::Never => false,
        };
        let project_id = ask.project_id.map(|id| id.0.as_str());
        // Agents switched off and models made unavailable aren't considered at all.
        let (models, providers) =
            crate::routing::availability::routable(&settings, &inputs.models, &inputs.providers);
        let mut preview = brigadier_router::preview(&Query {
            category: ask.category,
            areas: ask.areas,
            floor: ask.floor,
            needs: ask.needs,
            pin: ask.pin.clone(),
            hold_pin: ask.hold_pin,
            avoid: ask.avoid.clone(),
            distinct_from: ask.distinct_from.clone(),
            exclude: ask.exclude,
            overrides: &settings.routing_overrides,
            rankings: &settings.routing_rankings,
            project_id,
            running: &running,
            trial_slot,
            providers: &providers,
            models: &models,
            registry: &inputs.registry,
            learned: &inputs.learned,
            now_ms: now,
        });
        if let Decision::Run(routed) = preview.decision {
            preview.decision = Decision::Run(cheap_for_development(routed, &models));
        }
        (preview, trial_slot)
    }

    /// Whether this low-risk task may go to a model on trial: one in [`TRIAL_EVERY`], counted
    /// across launches. `take`: the task takes the slot (the count moves on); otherwise this
    /// only looks at what the next task would get.
    async fn trial_slot(&self, category: TaskCategory, take: bool) -> bool {
        if !brigadier_router::allows_trials(category) {
            return false;
        }
        let Some(store) = self.runtime.routing_store() else {
            return false;
        };
        let count = store
            .meta(TRIAL_COUNTER)
            .await
            .ok()
            .flatten()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        if take && let Err(err) = store.set_meta(TRIAL_COUNTER, (count + 1).to_string()).await {
            tracing::debug!(error = %err, "could not count the trial slot");
        }
        count % TRIAL_EVERY == 0
    }
}

/// A task's route from the router's choice.
pub(crate) fn route_from(routed: Routed) -> Route {
    Route {
        choice: ModelChoice {
            provider: routed.provider,
            model: Some(routed.model),
            effort: routed.effort,
            fast: None,
        },
        reason: routed.reason,
        explanation: Some(routed.explanation),
    }
}

/// `BRIGADIER_ROUTE_CHEAP=1`, in development builds only (verification runs): after routing
/// picks the vendor, use its cheapest model at low effort. The routing reason is kept and says
/// so.
#[cfg(debug_assertions)]
fn cheap_for_development(mut routed: Routed, models: &[MergedModel]) -> Routed {
    use brigadier_providers::ProviderKind;
    if std::env::var_os("BRIGADIER_ROUTE_CHEAP").is_none_or(|value| value != "1") {
        return routed;
    }
    let family = match routed.provider {
        ProviderKind::Claude => "haiku",
        ProviderKind::Codex => "luna",
    };
    routed.model = models
        .iter()
        .filter(|model| model.provider == routed.provider)
        .find(|model| model.id.contains(family))
        .map_or_else(|| family.to_owned(), |model| model.id.clone());
    routed.effort = (routed.provider == ProviderKind::Codex).then(|| "low".to_owned());
    routed.reason = format!("{} (dev: cheapest model substituted)", routed.reason);
    routed
}

/// Release builds route as the router says.
#[cfg(not(debug_assertions))]
fn cheap_for_development(routed: Routed, _models: &[MergedModel]) -> Routed {
    routed
}
