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
    /// Global seq of the event that last set each last-writer-wins field. Concurrent writers
    /// can resume in a different order than they committed; an older event must not win.
    title_seqs: HashMap<ConversationId, i64>,
    pinned_seqs: HashMap<ConversationId, i64>,
    settings_seq: i64,
}

impl Projection {
    /// Applies a committed event. `seq` is its global sequence, `at_ms` its ingest time.
    pub(crate) fn apply(&mut self, event: &DomainEvent, seq: i64, at_ms: i64) {
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
                    if latest(&mut self.title_seqs, id, seq) {
                        conversation.title.clone_from(title);
                    }
                    conversation.updated_at_ms = conversation.updated_at_ms.max(at_ms);
                }
            }
            DomainEvent::ConversationPinned { id, pinned_at_ms } => {
                if let Some(conversation) = self.conversations.get_mut(id)
                    && latest(&mut self.pinned_seqs, id, seq)
                {
                    conversation.pinned_at_ms = *pinned_at_ms;
                }
            }
            DomainEvent::MessageAppended { message } => {
                self.touch(&message.conversation_id, message.created_at_ms);
            }
            DomainEvent::SettingsChanged { settings } => {
                if seq >= self.settings_seq {
                    self.settings = settings.clone();
                    self.settings_seq = seq;
                }
            }
            // Raw sessions, the cleanup ledger and providers belong to the runtime.
            DomainEvent::RawSessionCreated { .. }
            | DomainEvent::RawSessionUpdated { .. }
            | DomainEvent::RawEvent { .. }
            | DomainEvent::CleanupRecorded { .. }
            | DomainEvent::CleanupCompleted { .. }
            | DomainEvent::ProviderChecked { .. }
            | DomainEvent::Probe { .. } => {}
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

/// Records `seq` as the field's newest writer; false if a newer event already set it.
fn latest(seqs: &mut HashMap<ConversationId, i64>, id: &ConversationId, seq: i64) -> bool {
    let last = seqs.entry(id.clone()).or_insert(seq);
    if seq < *last {
        return false;
    }
    *last = seq;
    true
}
