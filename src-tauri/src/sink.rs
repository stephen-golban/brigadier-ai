//! The one [`FeedSink`] that matters: a `tauri::ipc::Channel` the webview handed us.
//!
//! The channel is stored behind a `std::sync::Mutex<Option<_>>` and **replaced**, never added to.
//! A webview reload wipes the JS callback registry, so every later `send` on the old channel
//! returns `Ok(())`, logs one `console.warn` in a page that no longer exists, and drops the
//! payload. There is no way to detect that from Rust, so the front end's `subscribe_feed` call on
//! mount is the only signal that a *new* document is ready — and it must overwrite whatever is
//! here.
// see docs/research/tauri-commands.md §6.1, and §6 for `Channel<T>: Clone + Send + Sync`.

use std::sync::{Mutex, MutexGuard, PoisonError};

use brigadier_supervisor::{FeedBatch, FeedSink, SinkError};
use tauri::ipc::Channel;

/// Holds at most one live feed channel.
#[derive(Default)]
pub(crate) struct ChannelSink {
    channel: Mutex<Option<Channel<FeedBatch>>>,
}

// `tauri::ipc::Channel` is two boxed closures and an id; it has no `Debug`.
impl std::fmt::Debug for ChannelSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChannelSink").field("subscribed", &self.lock().is_some()).finish()
    }
}

impl ChannelSink {
    /// A sink with nobody listening yet.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Install `channel`, dropping any previous one.
    ///
    /// Idempotent by construction, which React 19 StrictMode's double-invoked effects require.
    pub(crate) fn replace(&self, channel: Channel<FeedBatch>) {
        *self.lock() = Some(channel);
    }

    /// Whether a channel is currently installed. Tests and diagnostics only.
    #[cfg(test)]
    pub(crate) fn is_subscribed(&self) -> bool {
        self.lock().is_some()
    }

    /// A poisoned lock guards one `Option<Channel>`; carrying on with it beats taking the app
    /// down mid-feed.
    fn lock(&self) -> MutexGuard<'_, Option<Channel<FeedBatch>>> {
        self.channel.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl FeedSink for ChannelSink {
    fn send(&self, batch: FeedBatch) -> Result<(), SinkError> {
        crate::peer_sessions::notify();
        // Clone out of the guard before sending: `Channel::send` reaches into the event loop and
        // must not run with this mutex held.
        let channel = self.lock().clone();
        match channel {
            Some(channel) => {
                channel.send(batch).map_err(|e| SinkError::Rejected(e.to_string()))
            }
            None => Err(SinkError::Closed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unsubscribed_sink_reports_closed_rather_than_swallowing_the_batch() {
        let sink = ChannelSink::new();
        assert!(!sink.is_subscribed());
        assert_eq!(sink.send(FeedBatch::empty("p1")), Err(SinkError::Closed));
    }
}
