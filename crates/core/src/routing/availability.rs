//! Which agents and models the user lets Brigadier use, as the Providers and Routing pages
//! set them:
//!
//! - An agent switched off ([`Settings::disabled_providers`]) and a model made unavailable
//!   ([`Settings::hidden_models`]) are out of every picker and get no work at all, routed or
//!   in the background. Conversations already running keep their model.
//! - Whether the orchestrator may hand a model worker tasks is a `never` rule for the worker
//!   kinds of work ([`worker_rule`]): a Chat's stand-in and an orchestrator are left alone.
//! - A model seen after its agent's first list ([`Settings::known_models`]) starts with that
//!   rule, so it gets no work until the user allows it; its agent's first list is taken as
//!   known, so turning this on (or signing in) changes nothing for the models already there.

use brigadier_providers::ProviderKind;
use brigadier_router::{
    MergedModel, OverrideEffect, OverrideRule, OverrideTarget, ProviderState, TaskCategory,
};

use crate::model::{ModelChoice, ModelRef, SETTINGS_VERSION, Settings};

/// The kinds of work the orchestrator hands to workers: what the Routing page's switch is
/// about. Not `chat` (a Chat's stand-in) or `orchestrate`.
pub const WORKER_CATEGORIES: [TaskCategory; 6] = [
    TaskCategory::Scout,
    TaskCategory::Research,
    TaskCategory::Implement,
    TaskCategory::Review,
    TaskCategory::Merge,
    TaskCategory::Verify,
];

/// The agent isn't switched off.
pub fn provider_on(settings: &Settings, provider: ProviderKind) -> bool {
    !settings.disabled_providers.contains(&provider)
}

/// The model may be used at all: its agent is on and the model isn't made unavailable.
pub fn model_available(settings: &Settings, provider: ProviderKind, id: &str) -> bool {
    provider_on(settings, provider)
        && !settings
            .hidden_models
            .iter()
            .any(|model| model.provider == provider && model.id == id)
}

/// Whether a new conversation may start on `choice` (or switch to it), with why not in plain
/// words. A choice without a model (the CLI's own default) asks only about its agent.
pub fn check_choice(settings: &Settings, choice: &ModelChoice) -> Result<(), String> {
    let agent = choice.provider.label();
    if !provider_on(settings, choice.provider) {
        return Err(format!(
            "{agent} is switched off. Turn it on in Settings › Providers."
        ));
    }
    match choice.model.as_deref() {
        Some(id) if !model_available(settings, choice.provider, id) => Err(format!(
            "{id} isn't available. Turn it on in Settings › Providers."
        )),
        _ => Ok(()),
    }
}

/// How the id of a [`worker_rule`] Brigadier added for a model it just saw starts: the Routing
/// page tags that model "New" until the user turns its switch.
pub const NEW_MODEL_RULE: &str = "new-model-";

/// The rule keeping a model it just saw from worker tasks everywhere, the rule the Routing
/// page's switch turns off and on (the switch writes its own id).
pub fn worker_rule(provider: ProviderKind, id: &str, now_ms: i64) -> OverrideRule {
    OverrideRule {
        id: format!("{NEW_MODEL_RULE}{}", uuid::Uuid::now_v7()),
        effect: OverrideEffect::Never,
        target: OverrideTarget::Model {
            provider,
            id: id.to_owned(),
        },
        categories: WORKER_CATEGORIES.to_vec(),
        areas: Vec::new(),
        project_id: None,
        created_at_ms: now_ms,
    }
}

/// Whether `rule` is [`worker_rule`] for this model.
pub fn is_worker_rule(rule: &OverrideRule, provider: ProviderKind, id: &str) -> bool {
    rule.effect == OverrideEffect::Never
        && matches!(&rule.target, OverrideTarget::Model { provider: p, id: m } if *p == provider && m == id)
        && rule.categories.len() == WORKER_CATEGORIES.len()
        && WORKER_CATEGORIES
            .iter()
            .all(|category| rule.categories.contains(category))
        && rule.areas.is_empty()
        && rule.project_id.is_none()
}

/// The settings with the models of `provider`'s list recorded as known, or `None` when all
/// of them already are. Each model seen after the agent's first list gets [`worker_rule`].
pub fn note_models(
    settings: &Settings,
    provider: ProviderKind,
    ids: &[String],
    now_ms: i64,
) -> Option<Settings> {
    let first_list = !settings
        .known_models
        .iter()
        .any(|model| model.provider == provider);
    let mut next = settings.clone();
    for id in ids {
        if next
            .known_models
            .iter()
            .any(|model| model.provider == provider && &model.id == id)
        {
            continue;
        }
        next.known_models.push(ModelRef {
            provider,
            id: id.clone(),
        });
        if !first_list
            && !next
                .routing_overrides
                .iter()
                .any(|rule| is_worker_rule(rule, provider, id))
        {
            next.routing_overrides
                .push(worker_rule(provider, id, now_ms));
        }
    }
    (next != *settings).then_some(next)
}

/// Saved settings brought up to [`SETTINGS_VERSION`], or `None` when they already are.
///
/// Version 1: an agent switched off before used to be a `never` rule for the whole agent,
/// everywhere, for all work; such a rule becomes the agent switched off. Every other rule
/// stays as it is.
pub fn migrate(settings: &Settings) -> Option<Settings> {
    if settings.settings_version >= SETTINGS_VERSION {
        return None;
    }
    let mut next = settings.clone();
    if settings.settings_version < 1 {
        next.routing_overrides.retain(|rule| {
            let OverrideTarget::Vendor { provider } = rule.target else {
                return true;
            };
            let off = rule.effect == OverrideEffect::Never
                && rule.categories.is_empty()
                && rule.areas.is_empty()
                && rule.project_id.is_none();
            if off && !next.disabled_providers.contains(&provider) {
                next.disabled_providers.push(provider);
            }
            !off
        });
    }
    next.settings_version = SETTINGS_VERSION;
    Some(next)
}

/// What routing may consider: the models of agents switched on that aren't made unavailable,
/// and an agent switched off as if signed out (so its registry models aren't offered either).
pub fn routable(
    settings: &Settings,
    models: &[MergedModel],
    providers: &[ProviderState],
) -> (Vec<MergedModel>, Vec<ProviderState>) {
    let models = models
        .iter()
        .filter(|model| model_available(settings, model.provider, &model.id))
        .cloned()
        .collect();
    let providers = providers
        .iter()
        .map(|state| ProviderState {
            logged_in: state.logged_in && provider_on(settings, state.provider),
            ..state.clone()
        })
        .collect();
    (models, providers)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn an_agents_first_list_is_known_without_rules() {
        let settings = Settings::default();
        let next = note_models(&settings, ProviderKind::Claude, &ids(&["opus", "haiku"]), 1)
            .expect("the models are new");
        assert_eq!(next.known_models.len(), 2);
        assert!(next.routing_overrides.is_empty());
    }

    #[test]
    fn a_model_seen_later_gets_no_worker_tasks() {
        let settings = note_models(
            &Settings::default(),
            ProviderKind::Claude,
            &ids(&["opus"]),
            1,
        )
        .expect("the models are new");
        let next = note_models(&settings, ProviderKind::Claude, &ids(&["opus", "fresh"]), 2)
            .expect("fresh is new");
        assert_eq!(next.routing_overrides.len(), 1);
        let rule = &next.routing_overrides[0];
        assert!(is_worker_rule(rule, ProviderKind::Claude, "fresh"));
        assert!(rule.id.starts_with(NEW_MODEL_RULE));
        assert!(!rule.categories.contains(&TaskCategory::Chat));
        assert!(!rule.categories.contains(&TaskCategory::Orchestrate));
        // Seen again: nothing changes, and a rule the user removed stays removed.
        let mut allowed = next.clone();
        allowed.routing_overrides.clear();
        assert!(note_models(&allowed, ProviderKind::Claude, &ids(&["opus", "fresh"]), 3).is_none());
    }

    #[test]
    fn another_agents_first_list_is_known_too() {
        let settings = note_models(
            &Settings::default(),
            ProviderKind::Claude,
            &ids(&["opus"]),
            1,
        )
        .expect("the models are new");
        let next =
            note_models(&settings, ProviderKind::Codex, &ids(&["sol"]), 2).expect("sol is new");
        assert!(next.routing_overrides.is_empty());
    }

    #[test]
    fn the_old_agent_switch_becomes_the_agent_off() {
        let off = OverrideRule {
            id: "off".into(),
            effect: OverrideEffect::Never,
            target: OverrideTarget::Vendor {
                provider: ProviderKind::Codex,
            },
            categories: Vec::new(),
            areas: Vec::new(),
            project_id: None,
            created_at_ms: 0,
        };
        let scoped = OverrideRule {
            id: "reviews".into(),
            categories: vec![TaskCategory::Review],
            ..off.clone()
        };
        let settings = Settings {
            routing_overrides: vec![off, scoped.clone()],
            settings_version: 0,
            ..Settings::default()
        };
        let next = migrate(&settings).expect("version 0 converts");
        assert_eq!(next.disabled_providers, vec![ProviderKind::Codex]);
        assert_eq!(next.routing_overrides, vec![scoped]);
        assert_eq!(next.settings_version, SETTINGS_VERSION);
        assert!(migrate(&next).is_none());
    }

    #[test]
    fn a_new_conversation_needs_an_available_model() {
        let settings = Settings {
            disabled_providers: vec![ProviderKind::Codex],
            hidden_models: vec![ModelRef {
                provider: ProviderKind::Claude,
                id: "haiku".into(),
            }],
            ..Settings::default()
        };
        let choice = |provider, model: Option<&str>| ModelChoice {
            provider,
            model: model.map(str::to_owned),
            effort: None,
            fast: None,
        };
        assert!(check_choice(&settings, &choice(ProviderKind::Claude, Some("opus"))).is_ok());
        assert!(check_choice(&settings, &choice(ProviderKind::Claude, None)).is_ok());
        let hidden = check_choice(&settings, &choice(ProviderKind::Claude, Some("haiku")));
        assert!(hidden.is_err_and(|why| why.contains("haiku")));
        let off = check_choice(&settings, &choice(ProviderKind::Codex, None));
        assert!(off.is_err_and(|why| why.contains("Codex is switched off")));
    }

    #[test]
    fn unavailable_models_and_agents_off_are_not_routable() {
        let settings = Settings {
            disabled_providers: vec![ProviderKind::Codex],
            hidden_models: vec![ModelRef {
                provider: ProviderKind::Claude,
                id: "haiku".into(),
            }],
            ..Settings::default()
        };
        assert!(model_available(&settings, ProviderKind::Claude, "opus"));
        assert!(!model_available(&settings, ProviderKind::Claude, "haiku"));
        assert!(!model_available(&settings, ProviderKind::Codex, "sol"));
        let states = [
            ProviderState {
                provider: ProviderKind::Claude,
                logged_in: true,
                quota: None,
            },
            ProviderState {
                provider: ProviderKind::Codex,
                logged_in: true,
                quota: None,
            },
        ];
        let (_, providers) = routable(&settings, &[], &states);
        assert!(providers[0].logged_in);
        assert!(!providers[1].logged_in);
    }
}
