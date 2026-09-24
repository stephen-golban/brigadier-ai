use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use brigadier_store::{NewEvent, Retention, Store, StreamPage};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{
    Catalog, Conversation, ConversationId, ConversationKind, DomainEvent, Message, MessagePage,
    MessageRole, Project, ProjectId, Settings, streams,
};
use crate::projection::Projection;
use crate::{Error, Result, now_ms};

const MAX_NAME_CHARS: usize = 200;
/// Messages longer than this keep only a preview inline; the full text goes to the blob store.
const INLINE_TEXT_BYTES: usize = 64 * 1024;
const PREVIEW_BYTES: usize = 4 * 1024;
const TITLE_CHARS: usize = 60;
const NEW_SESSION_TITLE: &str = "New session";
const NEW_CHAT_TITLE: &str = "New chat";
/// Diagnostic probes kept on disk; older ones are trimmed as new ones arrive.
const PROBES_KEPT: u32 = 10_000;
const MAX_PROBES: u32 = 5_000;
const CATALOG_PAGE: u32 = 1_000;

/// A synthetic event burst started by [`Core::probe_burst`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProbeBurst {
    pub burst_id: String,
    pub count: u32,
    pub interval_ms: u32,
}

/// The session manager. Validates commands, records them as events, and keeps the catalog
/// projection current.
pub struct Core {
    store: Store,
    projection: Mutex<Projection>,
}

impl Core {
    /// Rebuilds the catalog from the event log.
    pub async fn load(store: Store) -> Result<Arc<Self>> {
        let mut projection = Projection::default();

        let mut after = 0;
        loop {
            let page = store
                .read_stream_since(streams::CATALOG.into(), after, CATALOG_PAGE)
                .await?;
            for event in &page {
                projection.apply(&decode(event)?, event.at_ms);
                after = event.stream_seq;
            }
            if page.len() < CATALOG_PAGE as usize {
                break;
            }
        }

        let latest_settings = store
            .read_stream(
                streams::SETTINGS.into(),
                StreamPage {
                    limit: 1,
                    ..StreamPage::default()
                },
            )
            .await?;
        if let Some(event) = latest_settings.first() {
            projection.apply(&decode(event)?, event.at_ms);
        }

        // Last activity per conversation comes from the head of its message stream.
        let prefix = streams::conversation(&ConversationId(String::new()));
        for head in store.stream_heads(prefix.clone()).await? {
            let id = ConversationId(head.stream[prefix.len()..].to_owned());
            projection.touch(&id, head.at_ms);
        }

        Ok(Arc::new(Self {
            store,
            projection: Mutex::new(projection),
        }))
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn catalog(&self) -> Catalog {
        self.projection().catalog()
    }

    pub async fn create_project(&self, name: String) -> Result<Project> {
        let project = Project {
            id: ProjectId::generate(),
            name: clean_name(&name, "project name")?,
            created_at_ms: now_ms(),
        };
        self.record(vec![(
            streams::CATALOG.into(),
            DomainEvent::ProjectCreated {
                project: project.clone(),
            },
        )])
        .await?;
        Ok(project)
    }

    pub async fn create_conversation(
        &self,
        kind: ConversationKind,
        project_id: Option<ProjectId>,
        title: Option<String>,
    ) -> Result<Conversation> {
        match (kind, &project_id) {
            (ConversationKind::Session, None) => {
                return Err(Error::Invalid("a session belongs to a project".into()));
            }
            (ConversationKind::Chat, Some(_)) => {
                return Err(Error::Invalid("a chat is outside any project".into()));
            }
            (ConversationKind::Session, Some(id))
                if !self.projection().projects.contains_key(id) =>
            {
                return Err(Error::NotFound(format!("project {id}")));
            }
            _ => {}
        }
        let title = match title {
            Some(title) => clean_name(&title, "title")?,
            None => match kind {
                ConversationKind::Session => NEW_SESSION_TITLE.into(),
                ConversationKind::Chat => NEW_CHAT_TITLE.into(),
            },
        };
        let now = now_ms();
        let conversation = Conversation {
            id: ConversationId::generate(),
            kind,
            project_id,
            title,
            pinned_at_ms: None,
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.record(vec![(
            streams::CATALOG.into(),
            DomainEvent::ConversationCreated {
                conversation: conversation.clone(),
            },
        )])
        .await?;
        Ok(conversation)
    }

    pub async fn rename_conversation(
        &self,
        id: ConversationId,
        title: String,
    ) -> Result<Conversation> {
        self.conversation(&id)?;
        let title = clean_name(&title, "title")?;
        self.record(vec![(
            streams::CATALOG.into(),
            DomainEvent::ConversationRenamed {
                id: id.clone(),
                title,
            },
        )])
        .await?;
        self.conversation(&id)
    }

    pub async fn set_pinned(&self, id: ConversationId, pinned: bool) -> Result<Conversation> {
        let current = self.conversation(&id)?;
        if current.pinned_at_ms.is_some() == pinned {
            return Ok(current);
        }
        self.record(vec![(
            streams::CATALOG.into(),
            DomainEvent::ConversationPinned {
                id: id.clone(),
                pinned_at_ms: pinned.then(now_ms),
            },
        )])
        .await?;
        self.conversation(&id)
    }

    /// Appends a user message. The first message of an untitled conversation names it.
    pub async fn append_message(&self, id: ConversationId, text: String) -> Result<Message> {
        let conversation = self.conversation(&id)?;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(Error::Invalid("message is empty".into()));
        }

        let (inline, blob) = if text.len() > INLINE_TEXT_BYTES {
            let hash = self.store.blobs().put(text.clone().into_bytes()).await?;
            (
                prefix(&text, PREVIEW_BYTES).to_owned(),
                Some(hash.to_string()),
            )
        } else {
            (text.clone(), None)
        };
        let message = Message {
            id: uuid::Uuid::now_v7().to_string(),
            conversation_id: id.clone(),
            // Assigned by the store; the stream sequence is the message position.
            seq: 0,
            role: MessageRole::User,
            text: inline,
            blob,
            created_at_ms: now_ms(),
        };

        let mut events = vec![(
            streams::conversation(&id),
            DomainEvent::MessageAppended {
                message: message.clone(),
            },
        )];
        let untitled = matches!(
            conversation.title.as_str(),
            NEW_SESSION_TITLE | NEW_CHAT_TITLE
        );
        if untitled {
            events.push((
                streams::CATALOG.into(),
                DomainEvent::ConversationRenamed {
                    id: id.clone(),
                    title: title_from(trimmed),
                },
            ));
        }
        let stored = self.record(events).await?;
        Ok(Message {
            seq: stored[0],
            ..message
        })
    }

    /// Messages before `before` (a message `seq`), oldest first.
    pub async fn list_messages(
        &self,
        id: ConversationId,
        before: Option<i64>,
        limit: u32,
    ) -> Result<MessagePage> {
        self.conversation(&id)?;
        let limit = limit.clamp(1, brigadier_store::MAX_PAGE - 1);
        let mut events = self
            .store
            .read_stream(
                streams::conversation(&id),
                StreamPage {
                    before,
                    kinds: vec!["message.appended".into()],
                    // One extra row tells us whether there is an older page.
                    limit: limit + 1,
                },
            )
            .await?;
        let has_more = events.len() > limit as usize;
        events.truncate(limit as usize);
        events.reverse();
        let messages = events
            .iter()
            .map(|event| match decode(event)? {
                DomainEvent::MessageAppended { message } => Ok(Message {
                    seq: event.stream_seq,
                    ..message
                }),
                _ => Err(Error::Invalid(format!(
                    "event {} is not a message",
                    event.seq
                ))),
            })
            .collect::<Result<_>>()?;
        Ok(MessagePage { messages, has_more })
    }

    /// Full text of a message stored in the blob store.
    pub async fn read_blob_text(&self, hash: String) -> Result<String> {
        let hash = hash.parse()?;
        let bytes = self
            .store
            .blobs()
            .get(hash)
            .await?
            .ok_or_else(|| Error::NotFound("blob".into()))?;
        String::from_utf8(bytes).map_err(|_| Error::Invalid("blob is not text".into()))
    }

    pub async fn update_settings(&self, settings: Settings) -> Result<Settings> {
        self.record(vec![(
            streams::SETTINGS.into(),
            DomainEvent::SettingsChanged {
                settings: settings.clone(),
            },
        )])
        .await?;
        Ok(settings)
    }

    /// Prepares a burst of `count` diagnostic events, `interval_ms` apart, through the normal
    /// write path; clients time each one from ingest to paint. The caller spawns the returned
    /// future.
    pub fn probe_burst(
        self: &Arc<Self>,
        count: u32,
        interval_ms: u32,
    ) -> Result<(ProbeBurst, impl Future<Output = ()> + Send + 'static)> {
        if count == 0 || count > MAX_PROBES {
            return Err(Error::Invalid(format!(
                "probe count must be 1..={MAX_PROBES}"
            )));
        }
        let burst = ProbeBurst {
            burst_id: uuid::Uuid::now_v7().to_string(),
            count,
            interval_ms: interval_ms.min(1_000),
        };
        let core = self.clone();
        let spec = burst.clone();
        let run = async move {
            let period = Duration::from_millis(spec.interval_ms.max(1).into());
            let mut ticker = tokio::time::interval(period);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            for index in 0..spec.count {
                ticker.tick().await;
                let event = DomainEvent::Probe {
                    burst_id: spec.burst_id.clone(),
                    index,
                    count: spec.count,
                };
                let result = async {
                    let new = to_new_event(streams::DIAGNOSTICS.into(), &event)?;
                    let retention = Retention {
                        keep_last: PROBES_KEPT,
                    };
                    core.store.append_with(vec![new], Some(retention)).await?;
                    Ok::<_, Error>(())
                }
                .await;
                if let Err(err) = result {
                    tracing::warn!(error = %err, "probe burst stopped");
                    break;
                }
            }
        };
        Ok((burst, run))
    }

    fn projection(&self) -> MutexGuard<'_, Projection> {
        // The projection holds no invariants a panic could break mid-update.
        self.projection
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn conversation(&self, id: &ConversationId) -> Result<Conversation> {
        self.projection()
            .conversations
            .get(id)
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("conversation {id}")))
    }

    /// Appends events atomically, applies them to the projection, and returns each event's
    /// stream sequence.
    async fn record(&self, events: Vec<(String, DomainEvent)>) -> Result<Vec<i64>> {
        let new = events
            .iter()
            .map(|(stream, event)| to_new_event(stream.clone(), event))
            .collect::<Result<Vec<_>>>()?;
        let stored = self.store.append(new).await?;
        let mut projection = self.projection();
        for ((_, event), stored) in events.iter().zip(&stored) {
            projection.apply(event, stored.at_ms);
        }
        Ok(stored.iter().map(|event| event.stream_seq).collect())
    }
}

fn to_new_event(stream: String, event: &DomainEvent) -> Result<NewEvent> {
    Ok(NewEvent::new(stream, event.kind(), now_ms(), event)?)
}

fn decode(event: &brigadier_store::StoredEvent) -> Result<DomainEvent> {
    serde_json::from_str(event.payload.get()).map_err(|source| Error::Corrupt {
        seq: event.seq,
        source,
    })
}

fn clean_name(name: &str, what: &str) -> Result<String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(Error::Invalid(format!("{what} is empty")));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(Error::Invalid(format!(
            "{what} is longer than {MAX_NAME_CHARS} characters"
        )));
    }
    Ok(name)
}

fn title_from(text: &str) -> String {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(text);
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= TITLE_CHARS {
        line
    } else {
        let mut title: String = line.chars().take(TITLE_CHARS - 1).collect();
        title.push('…');
        title
    }
}

/// The longest prefix of `text` that fits in `bytes` without splitting a character.
fn prefix(text: &str, bytes: usize) -> &str {
    let mut end = bytes.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
