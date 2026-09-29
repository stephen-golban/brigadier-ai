//! Brigadier's own token use, per turn, for the Usage page.

use brigadier_providers::{ProviderKind, TokenUsage};

use super::SessionManager;
use crate::model::{ConversationId, ProjectId};
use crate::now_ms;
use crate::routing::{TokenMeter, TurnUsage};
use crate::work::TaskId;

/// Whose turn a token report belongs to.
pub(crate) enum TokenOwner<'a> {
    /// A conversation's model (orchestrator or Chat), or its handoff fork.
    Conversation(&'a ConversationId),
    /// A task's worker.
    Task(&'a ConversationId, &'a TaskId),
    /// A Brain job of a project.
    Project(&'a ProjectId),
    /// Brigadier's own upkeep for no conversation or project (researching a new model).
    Upkeep,
}

impl SessionManager {
    /// Records what the turn just reported used, from `meter`'s view of the CLI session's
    /// running totals.
    pub(crate) fn note_tokens(
        &self,
        meter: &TokenMeter,
        provider: ProviderKind,
        model: Option<&str>,
        owner: TokenOwner<'_>,
        total: &TokenUsage,
    ) {
        let Some(used) = meter.delta(total) else {
            return;
        };
        let Some(store) = self.runtime.routing_store().cloned() else {
            return;
        };
        let project_of = |id: &ConversationId| {
            self.core
                .conversation(id)
                .ok()
                .and_then(|conversation| conversation.project_id)
                .map(|id| id.0)
        };
        let (conversation_id, project_id, task_id) = match owner {
            TokenOwner::Conversation(id) => (Some(id.0.clone()), project_of(id), None),
            TokenOwner::Task(id, task) => {
                (Some(id.0.clone()), project_of(id), Some(task.0.clone()))
            }
            TokenOwner::Project(project) => (None, Some(project.0.clone()), None),
            TokenOwner::Upkeep => (None, None, None),
        };
        let turn = TurnUsage {
            at_ms: now_ms(),
            provider,
            model: model.unwrap_or("default").to_owned(),
            conversation_id,
            project_id,
            task_id,
            input: used.input_tokens,
            cached_input: used.cached_input_tokens,
            cache_write: used.cache_write_tokens,
            output: used.output_tokens,
        };
        self.spawn(async move {
            if let Err(err) = store.add_turn(turn).await {
                tracing::warn!(error = %err, "could not record a turn's token use");
            }
        });
    }
}
