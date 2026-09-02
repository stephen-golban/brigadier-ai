//! The shapes that cross the IPC boundary, verbatim from `docs/plans/ipc-contract.md`.
//!
//! Nothing here knows about Tauri. The Tauri layer above takes a [`FeedBatch`] and hands it to a
//! `tauri::ipc::Channel`; this crate's only obligation is that every message it produces
//! serializes to fewer than [`crate::batcher::MAX_MESSAGE_BYTES`] bytes.

use std::time::{SystemTime, UNIX_EPOCH};

use brigadier_core::event::{Envelope, RequestId, SessionId};
use brigadier_store::{ApprovalRecord, FeedRow};
use serde::{Deserialize, Serialize};

/// Milliseconds since the Unix epoch, the only timestamp shape on the wire.
///
/// Saturates rather than erring: a clock far enough out for this to matter has already broken
/// everything else.
pub(crate) fn to_millis(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

/// One terse feed row, short-keyed.
///
/// The keys are one character each because they are paid for once per row, and a frame is capped
/// by *bytes* rather than by rows.
// see docs/research/feed-rendering.md §4 — 237 B per row against 285 B for the verbose keys.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedRowWire {
    /// Session id.
    pub s: String,
    /// Per-session sequence number.
    pub q: u64,
    /// Emission time, milliseconds since the Unix epoch.
    pub t: i64,
    /// The bounded one-line summary from `brigadier_store::feed::terse_line`.
    pub l: String,
}

impl FeedRowWire {
    /// Build a row from the parts an [`Envelope`] carries.
    pub fn new(session_id: &SessionId, seq: u64, at: SystemTime, line: String) -> Self {
        Self { s: session_id.as_str().to_owned(), q: seq, t: to_millis(at), l: line }
    }
}

impl From<&FeedRow> for FeedRowWire {
    fn from(row: &FeedRow) -> Self {
        Self::new(&row.session_id, row.seq, row.at, row.line.clone())
    }
}

/// How many rows one session has produced and how many of those never reached the webview.
///
/// Both fields are cumulative for the life of the process, not per frame: a counter is sent only
/// in the frames where a session was touched, so a per-frame delta would be unreadable on the
/// other side. `delivered = rows_total - rows_dropped`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCounter {
    /// Which session.
    pub session_id: String,
    /// Every row this session has produced, delivered or not.
    pub rows_total: u64,
    /// Rows that were never delivered: the project was invisible, or the buffer overflowed.
    pub rows_dropped: u64,
}

/// One batch of feed traffic for one project, sized to stay on Tauri's `eval` fast path.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FeedBatch {
    /// Which project these rows belong to.
    pub project_id: String,
    /// Terse rows, in `seq` order per session. Empty when the project is not visible.
    pub rows: Vec<FeedRowWire>,
    /// Signal envelopes, delivered whatever the visibility, always with `raw` stripped.
    pub signals: Vec<Envelope>,
    /// One entry per session touched in this frame.
    pub counters: Vec<SessionCounter>,
}

impl FeedBatch {
    /// An empty batch for `project_id`.
    pub fn empty(project_id: impl Into<String>) -> Self {
        Self {
            project_id: project_id.into(),
            rows: Vec::new(),
            signals: Vec::new(),
            counters: Vec::new(),
        }
    }

    /// True when there is nothing in it worth sending.
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty() && self.signals.is_empty() && self.counters.is_empty()
    }
}

/// One approval as the UI needs it: enough to render the prompt, plus whether it can still be
/// answered.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApprovalView {
    /// Our id for the parked request.
    pub request_id: RequestId,
    /// The session that parked it.
    pub session_id: SessionId,
    /// When it was opened, milliseconds since the Unix epoch.
    pub opened_at_ms: i64,
    /// What is being asked. `None` when the stored payload was too large to keep verbatim and
    /// the store replaced it with its `{"type":"oversized"}` stand-in.
    pub kind: Option<brigadier_core::event::RequestKind>,
    /// Nothing is listening any more: the record belongs to a previous launch, or its session is
    /// no longer live in this one.
    // see docs/research/persistence.md §6 — `run_id` is the only honest discriminator.
    pub expired: bool,
    /// It already has an answer recorded.
    pub resolved: bool,
}

impl ApprovalView {
    /// Render one stored record against the current launch.
    pub fn from_record(record: &ApprovalRecord, expired: bool) -> Self {
        Self {
            request_id: record.request_id.clone(),
            session_id: record.session_id.clone(),
            opened_at_ms: to_millis(record.opened_at),
            kind: record.kind(),
            expired,
            resolved: record.resolved_at.is_some(),
        }
    }
}
