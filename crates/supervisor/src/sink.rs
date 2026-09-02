//! Where a finished [`FeedBatch`] goes.
//!
//! The trait is deliberately **synchronous and non-blocking**, because the only implementation
//! that matters wraps `tauri::ipc::Channel::send`, which is itself synchronous and fire-and-forget
//! into tao's event-loop queue.
// see docs/research/tauri-runtime.md §3 — `eval_script` returns `Ok(())` whether or not the UI
// thread is keeping up; there is no backpressure signal to propagate here.

use std::sync::Mutex;

use crate::wire::FeedBatch;

/// Why a batch could not be handed over.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SinkError {
    /// Nobody is listening: the webview never subscribed, or it went away.
    #[error("feed sink is closed")]
    Closed,
    /// The transport refused it.
    #[error("{0}")]
    Rejected(String),
}

/// One frame's worth of feed traffic, handed to whatever is downstream.
///
/// Implementations must not block: the flusher task calls this on the runtime, once per project
/// per animation frame.
pub trait FeedSink: Send + Sync + 'static {
    /// Deliver one message. Errors are logged by the caller and never fail a session.
    fn send(&self, batch: FeedBatch) -> Result<(), SinkError>;
}

/// A sink that keeps everything, for tests.
#[derive(Debug, Default)]
pub struct VecSink {
    batches: Mutex<Vec<FeedBatch>>,
}

impl VecSink {
    /// An empty sink.
    pub fn new() -> Self {
        Self::default()
    }

    /// Every batch sent so far, in order.
    pub fn batches(&self) -> Vec<FeedBatch> {
        crate::lock(&self.batches).clone()
    }

    /// Take everything sent so far, leaving the sink empty.
    pub fn take(&self) -> Vec<FeedBatch> {
        std::mem::take(&mut crate::lock(&self.batches))
    }

    /// How many messages have been sent.
    pub fn len(&self) -> usize {
        crate::lock(&self.batches).len()
    }

    /// True when nothing has been sent.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl FeedSink for VecSink {
    fn send(&self, batch: FeedBatch) -> Result<(), SinkError> {
        crate::lock(&self.batches).push(batch);
        Ok(())
    }
}
