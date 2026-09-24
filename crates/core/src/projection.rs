use std::collections::HashMap;

use crate::model::{
    Catalog, Conversation, ConversationId, DomainEvent, Project, ProjectId, Settings,
};

/// In-memory view of the catalog, folded from catalog and settings events.
#[derive(Debug, Default)]
pub(crate) struct Projection {
    pub(crate) projects: HashMap<ProjectId, Project>,
    pub(crate) conversations: HashMap<ConversationId, Conversation>,
    pub(crate) settings: Settings,
}

impl Projection {
    /// Applies a committed event. `at_ms` is the event's ingest time.
    pub(crate) fn apply(&mut self, event: &DomainEvent, at_ms: i64) {
        match event {
            DomainEvent::ProjectCreated { project } => {
                self.projects.insert(project.id.clone(), project.clone());
            }
            DomainEvent::ConversationCreated { conversation } => {
                self.conversations
                    .insert(conversation.id.clone(), conversation.clone());
            }
            DomainEvent::ConversationRenamed { id, title } => {
                if let Some(conversation) = self.conversations.get_mut(id) {
                    conversation.title.clone_from(title);
                    conversation.updated_at_ms = conversation.updated_at_ms.max(at_ms);
                }
            }
            DomainEvent::ConversationPinned { id, pinned_at_ms } => {
                if let Some(conversation) = self.conversations.get_mut(id) {
                    conversation.pinned_at_ms = *pinned_at_ms;
                }
            }
            DomainEvent::MessageAppended { message } => {
                self.touch(&message.conversation_id, message.created_at_ms);
            }
            DomainEvent::SettingsChanged { settings } => {
                self.settings = settings.clone();
            }
            DomainEvent::Probe { .. } => {}
        }
    }

    pub(crate) fn touch(&mut self, id: &ConversationId, at_ms: i64) {
        if let Some(conversation) = self.conversations.get_mut(id) {
            conversation.updated_at_ms = conversation.updated_at_ms.max(at_ms);
        }
    }

    /// Projects newest first; conversations by most recent activity.
    pub(crate) fn catalog(&self) -> Catalog {
        let mut projects: Vec<Project> = self.projects.values().cloned().collect();
        projects.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms).then(a.id.cmp(&b.id)));
        let mut conversations: Vec<Conversation> = self.conversations.values().cloned().collect();
        conversations.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms).then(b.id.cmp(&a.id)));
        Catalog {
            projects,
            conversations,
            settings: self.settings.clone(),
        }
    }
}
