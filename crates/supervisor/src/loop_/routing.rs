//! An explicit model binds the orchestrator. Workers retain their independent selection.
use crate::action::ModelTier;

/// One independently selected worker model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Routed {
    /// Provider model identifier.
    pub model: Option<String>,
    /// Requested worker tier, retained for legacy plans.
    pub tier: ModelTier,
    /// Compatibility field for persisted historical clamp evidence.
    pub clamp: Option<String>,
}

/// Orchestrator selection. The historical name is retained for source compatibility only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ceiling {
    pick: Option<String>,
}
impl Ceiling {
    /// Normalize Auto without imposing a hidden worker ceiling.
    pub fn new(pick: Option<String>) -> Self {
        Self {
            pick: pick.map(|p| p.trim().to_owned()).filter(|p| !p.is_empty()),
        }
    }
    /// Exact orchestrator model, or the configured provider default.
    pub fn judgement(&self) -> Option<String> {
        self.pick.clone()
    }
    /// Legacy Claude tier choices are independent of the orchestrator model.
    pub fn worker(&self, tier: ModelTier) -> Routed {
        Routed {
            model: Some(tier.as_slug().to_owned()),
            tier,
            clamp: None,
        }
    }
    /// Vendor tier aliases have meaning only for their own provider. Auto on another adapter
    /// must reach that adapter as None, so its configured default resolves the actual model.
    pub fn worker_for_provider(&self, tier: ModelTier, provider: &str) -> Routed {
        let mut routed = self.worker(tier);
        if provider != "claude-code" {
            routed.model = None;
        }
        routed
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_default_never_receives_another_vendors_tier_alias() {
        let selection = Ceiling::new(Some("gpt-exact".into()));
        for tier in ModelTier::ALL {
            assert_eq!(selection.worker_for_provider(tier, "codex").model, None);
            assert_eq!(
                selection.worker_for_provider(tier, "future-provider").model,
                None
            );
            assert_eq!(
                selection
                    .worker_for_provider(tier, "claude-code")
                    .model
                    .as_deref(),
                Some(tier.as_slug())
            );
        }
    }
    #[test]
    fn orchestrator_is_exact_and_workers_are_independent() {
        for pick in [None, Some("haiku"), Some("unknown-exact-model")] {
            let selection = Ceiling::new(pick.map(str::to_owned));
            assert_eq!(selection.judgement().as_deref(), pick);
            for tier in ModelTier::ALL {
                let worker = selection.worker(tier);
                assert_eq!(worker.model.as_deref(), Some(tier.as_slug()));
                assert_eq!(worker.tier, tier);
                assert_eq!(worker.clamp, None);
            }
        }
    }
}
