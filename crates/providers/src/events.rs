//! The event stream of a session, redacted on the way out.

use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::model::ProviderEvent;
use crate::redact::{EventRedactor, Redactor};

/// Sends a session's events to its listener. Every event passes the session's redactor first,
/// which may hold a delta back (it could end in the start of a secret) and release it later.
pub(crate) struct Events {
    tx: mpsc::Sender<ProviderEvent>,
    redactor: Option<Mutex<EventRedactor>>,
}

impl Events {
    pub(crate) fn new(tx: mpsc::Sender<ProviderEvent>, redactor: Option<Arc<Redactor>>) -> Self {
        Self {
            tx,
            redactor: EventRedactor::new(redactor).map(Mutex::new),
        }
    }

    /// Sends `event`, redacted. Returns `false` once nobody listens any more.
    pub(crate) async fn send(&self, event: ProviderEvent) -> bool {
        let Some(redactor) = &self.redactor else {
            return self.tx.send(event).await.is_ok();
        };
        let mut out = Vec::with_capacity(1);
        redactor
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .apply(event, &mut out);
        let mut delivered = true;
        for event in out {
            delivered &= self.tx.send(event).await.is_ok();
        }
        delivered
    }
}
