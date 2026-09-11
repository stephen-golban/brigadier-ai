//! Per-project, per-frame coalescing: the only flow control in the system.
//!
//! Rust is the only place backpressure can be applied. The event channel from an adapter is
//! bounded and blocks the adapter's stdout read when a consumer falls behind, but from here on
//! there is nothing: `tauri::ipc::Channel::send` is fire-and-forget into an unbounded event-loop
//! queue and returns `Ok(())` whether or not the webview is keeping up. So this is where rows are
//! coalesced into one message per animation frame, split under the 8 KB `eval` cliff, and dropped
//! when the operator is not looking at the project.
// see docs/research/tauri-runtime.md §3 (no backpressure, 8192-byte cliff, one oversized message
// head-of-line blocks every later one) and docs/research/feed-rendering.md §4 (batch arithmetic).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use brigadier_core::event::{Envelope, Event};
use brigadier_store::feed::{kind, terse_line};

use crate::lock;
use crate::sink::FeedSink;
use crate::wire::{FeedBatch, FeedRowWire, SessionCounter};

/// Ceiling on one serialized message. Tauri's own threshold is 8192; the slack absorbs the
/// difference between our arithmetic and any future field.
// see docs/research/feed-rendering.md §4 — "re-check `serialized.len() < 8000` before every send".
pub const MAX_MESSAGE_BYTES: usize = 8000;

/// Ceiling on rows in one message, independent of bytes.
pub const MAX_ROWS_PER_MESSAGE: usize = 24;

/// Rows one project may hold between frames before the oldest start falling off.
pub const PROJECT_ROW_CAP: usize = 2000;

/// Signals one project may hold between frames. Signals are rare; a backlog this deep means the
/// sink is gone.
pub const PROJECT_SIGNAL_CAP: usize = 2000;

/// The default frame interval: one batch per animation frame at 60 Hz.
pub const DEFAULT_FRAME_INTERVAL: Duration = Duration::from_millis(16);

/// True for the events the contract calls signals: the ones the UI must see whether or not the
/// project is visible, because they change state rather than describing progress.
// see docs/plans/ipc-contract.md "Feed channel" for the closed list.
pub fn is_signal(event: &Event) -> bool {
    matches!(
        event,
        Event::SessionStarted { .. }
            | Event::SessionExited { .. }
            | Event::TurnStarted { .. }
            | Event::TurnCompleted { .. }
            | Event::TurnAborted { .. }
            | Event::RequestOpened { .. }
            | Event::RequestResolved { .. }
            | Event::SessionCompacted { .. }
            | Event::RuntimeError { .. }
            | Event::RuntimeWarning { .. }
    )
}

#[derive(Debug, Default)]
struct Counters {
    total: u64,
    dropped: u64,
    /// A `SessionStarted` was seen for this session.
    started: bool,
    /// A `SessionExited` was seen for it.
    ended: bool,
}

impl Counters {
    /// True once the batcher has watched this session's whole lifetime, which is the only case
    /// where dropping its counters loses nothing: the final counter went out with the same frame
    /// that carried the exit signal, and no further event can arrive for it.
    ///
    /// A session the batcher never saw *start* is deliberately not finished — a test driver, or
    /// any producer whose start predates the batcher — because its counters are the only record
    /// of it there is.
    fn finished(&self) -> bool {
        self.started && self.ended
    }
}

#[derive(Debug, Default)]
struct ProjectAccum {
    rows: VecDeque<FeedRowWire>,
    signals: VecDeque<Envelope>,
    counters: BTreeMap<String, Counters>,
    /// Sessions touched since the last flush; only these get a counter in the next message.
    touched: BTreeSet<String>,
}

impl ProjectAccum {
    fn pending(&self) -> bool {
        !self.rows.is_empty() || !self.signals.is_empty() || !self.touched.is_empty()
    }

    /// Drop the counters of every session whose whole lifetime is over, and say whether anything
    /// at all is left worth keeping the project's entry for.
    ///
    /// Called at the end of a tick, after the frame has been drained, so anything removed here
    /// has already crossed the sink.
    fn prune(&mut self) -> bool {
        self.counters.retain(|_, c| !c.finished());
        self.pending() || !self.counters.is_empty()
    }
}

#[derive(Debug, Default)]
struct State {
    projects: BTreeMap<String, ProjectAccum>,
    /// `None` until the UI says otherwise, which means "everything is visible".
    visible: Option<BTreeSet<String>>,
    #[cfg(any(debug_assertions, feature = "burn"))]
    capture_projects: BTreeMap<String, usize>,
}

impl State {
    fn is_visible(&self, project_id: &str) -> bool {
        #[cfg(any(debug_assertions, feature = "burn"))]
        if self.capture_projects.contains_key(project_id) {
            return true;
        }
        match &self.visible {
            None => true,
            Some(set) => set.contains(project_id),
        }
    }
}

struct Inner {
    state: Mutex<State>,
    sink: Arc<dyn FeedSink>,
}

/// One project's traffic for one tick, taken out from under the lock before anything is packed.
struct Frame {
    project_id: String,
    rows: Vec<FeedRowWire>,
    signals: Vec<Envelope>,
    counters: Vec<SessionCounter>,
}

/// Accumulates envelopes and hands the sink at most one message per project per frame.
///
/// Cheap to clone; every clone feeds the same accumulator.
#[derive(Clone)]
pub struct Batcher {
    inner: Arc<Inner>,
}

/// Keeps a diagnostic project's complete row stream enabled until capture ends.
#[cfg(any(debug_assertions, feature = "burn"))]
pub struct CaptureProject {
    inner: Weak<Inner>,
    project_id: String,
}

#[cfg(any(debug_assertions, feature = "burn"))]
impl Drop for CaptureProject {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            let mut state = lock(&inner.state);
            if let Some(count) = state.capture_projects.get_mut(&self.project_id) {
                *count -= 1;
                if *count == 0 {
                    state.capture_projects.remove(&self.project_id);
                }
            }
        }
    }
}

impl std::fmt::Debug for Batcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = lock(&self.inner.state);
        f.debug_struct("Batcher")
            .field("projects", &state.projects.len())
            .field("visible", &state.visible)
            .finish_non_exhaustive()
    }
}

impl Batcher {
    /// A batcher feeding `sink`. Nothing ticks until [`Batcher::spawn_flusher`] is called.
    pub fn new(sink: Arc<dyn FeedSink>) -> Self {
        Self { inner: Arc::new(Inner { state: Mutex::new(State::default()), sink }) }
    }

    /// Account for one envelope. Never awaits, never serializes, never touches the sink.
    ///
    /// The row is dropped here rather than downstream when its project is not visible, so an
    /// unwatched project costs one counter increment per event and nothing else.
    pub fn push(&self, project_id: &str, env: &Envelope) {
        let mut state = lock(&self.inner.state);
        let visible = state.is_visible(project_id);
        let session = env.session_id.as_str().to_owned();
        let accum = state.projects.entry(project_id.to_owned()).or_default();
        accum.touched.insert(session.clone());
        let counters = accum.counters.entry(session).or_default();
        match &env.event {
            Event::SessionStarted { .. } => counters.started = true,
            Event::SessionExited { .. } => counters.ended = true,
            _ => {}
        }

        if let Some(line) = terse_line(&env.event) {
            counters.total += 1;
            if visible {
                let row =
                    FeedRowWire::new(&env.session_id, env.seq, env.at, kind(&env.event), line);
                if accum.rows.len() >= PROJECT_ROW_CAP {
                    accum.rows.pop_front();
                    counters.dropped += 1;
                }
                accum.rows.push_back(row);
            } else {
                counters.dropped += 1;
            }
        }

        if is_signal(&env.event) {
            // The copy that crosses the IPC boundary never carries the provider payload excerpt:
            // one measured excerpt was 4,279 bytes, so two signals alone would cross the cliff.
            // see docs/research/tauri-commands.md §9. `feed::apply` and the raw log still see the
            // envelope whole; only this copy is stripped.
            let mut signal = env.clone();
            signal.raw = None;
            if accum.signals.len() >= PROJECT_SIGNAL_CAP {
                accum.signals.pop_front();
            }
            accum.signals.push_back(signal);
        }
    }

    /// Replace the visible set. Rows for anything outside it are dropped and counted; signals and
    /// counters keep flowing.
    pub fn set_visible_projects(&self, ids: Vec<String>) {
        lock(&self.inner.state).visible = Some(ids.into_iter().collect());
    }

    /// Preserve the actual capture workload even while UI project selection changes.
    #[cfg(any(debug_assertions, feature = "burn"))]
    pub fn capture_project(&self, project_id: &str) -> CaptureProject {
        *lock(&self.inner.state)
            .capture_projects
            .entry(project_id.to_owned())
            .or_default() += 1;
        CaptureProject {
            inner: Arc::downgrade(&self.inner),
            project_id: project_id.to_owned(),
        }
    }

    /// Drain every project with something pending and send it, splitting under the byte cap.
    ///
    /// A project with nothing pending sends nothing at all — an idle app is silent.
    pub fn flush_once(&self) {
        let drained = {
            let mut state = lock(&self.inner.state);
            let mut out: Vec<Frame> = Vec::new();
            for (project_id, accum) in state.projects.iter_mut() {
                if !accum.pending() {
                    continue;
                }
                let rows: Vec<FeedRowWire> = accum.rows.drain(..).collect();
                let signals: Vec<Envelope> = accum.signals.drain(..).collect();
                let mut counters = Vec::with_capacity(accum.touched.len());
                for session_id in std::mem::take(&mut accum.touched) {
                    let c = accum.counters.entry(session_id.clone()).or_default();
                    counters.push(SessionCounter {
                        session_id,
                        rows_total: c.total,
                        rows_dropped: c.dropped,
                    });
                }
                out.push(Frame { project_id: project_id.clone(), rows, signals, counters });
            }
            // Nothing here is unbounded on purpose: one entry per project ever seen, and inside
            // it one counter per session ever seen, would both grow for the life of the app. A
            // project whose sessions have all ended and whose buffers are empty is forgotten in
            // the same tick, and its map entry goes with it. Nothing about the message shape or
            // the caps changes — this runs after the frame is drained.
            // see docs/research/feed-rendering.md §4 for the caps this must not touch.
            state.projects.retain(|_, accum| accum.prune());
            out
        };

        for Frame { project_id, rows, signals, counters } in drained {
            for message in pack(&project_id, rows, signals, counters) {
                if let Err(e) = self.inner.sink.send(message) {
                    tracing::debug!(error = %e, project_id, "feed sink refused a batch");
                }
            }
        }
    }

    /// Tick `flush_once` every `interval` until the last [`Batcher`] is dropped.
    ///
    /// The task holds a weak reference on purpose: it is the app's own lifetime that ends it, and
    /// nothing has to remember to stop it.
    pub fn spawn_flusher(&self, interval: Duration) -> tokio::task::JoinHandle<()> {
        let weak = Arc::downgrade(&self.inner);
        let interval = if interval.is_zero() { DEFAULT_FRAME_INTERVAL } else { interval };
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let Some(inner) = Weak::upgrade(&weak) else { return };
                Batcher { inner }.flush_once();
            }
        })
    }

    /// Cumulative `(rows_total, rows_dropped)` for one session, for tests and instrumentation.
    ///
    /// `None` once the session has both started and exited and a tick has run: its last counter
    /// was delivered with its exit signal, and the entry is then dropped rather than kept for the
    /// life of the app.
    pub fn counters(&self, project_id: &str, session_id: &str) -> Option<(u64, u64)> {
        let state = lock(&self.inner.state);
        let accum = state.projects.get(project_id)?;
        let c = accum.counters.get(session_id)?;
        Some((c.total, c.dropped))
    }

    /// Rows sitting in one project's buffer right now.
    pub fn buffered_rows(&self, project_id: &str) -> usize {
        lock(&self.inner.state).projects.get(project_id).map_or(0, |a| a.rows.len())
    }

    /// Projects the accumulator still holds an entry for, for tests and instrumentation.
    pub fn tracked_projects(&self) -> Vec<String> {
        lock(&self.inner.state).projects.keys().cloned().collect()
    }
}

/// Split one frame's traffic into messages that each serialize under [`MAX_MESSAGE_BYTES`].
///
/// The accounting is exact rather than estimated: `serde_json`'s compact output for an array is
/// its elements' own encodings joined by one comma, so a batch's length is the empty batch's
/// length plus every element's length plus one separator per element after the first in its
/// array. Each finished message is then re-serialized once and checked, so the guarantee does not
/// rest on that argument holding for a field somebody adds later.
fn pack(
    project_id: &str,
    rows: Vec<FeedRowWire>,
    signals: Vec<Envelope>,
    counters: Vec<SessionCounter>,
) -> Vec<FeedBatch> {
    let mut packer = Packer::new(project_id);
    for c in counters {
        packer.add(Item::Counter(c));
    }
    for s in signals {
        packer.add(Item::Signal(Box::new(s)));
    }
    for r in rows {
        packer.add(Item::Row(r));
    }
    packer.finish()
}

enum Item {
    Row(FeedRowWire),
    Signal(Box<Envelope>),
    Counter(SessionCounter),
}

struct Packer {
    base: usize,
    len: usize,
    current: FeedBatch,
    out: Vec<FeedBatch>,
}

impl Packer {
    fn new(project_id: &str) -> Self {
        let current = FeedBatch::empty(project_id);
        let base = serde_json::to_vec(&current).map(|v| v.len()).unwrap_or(MAX_MESSAGE_BYTES);
        Self { base, len: base, current, out: Vec::new() }
    }

    fn close(&mut self) {
        if !self.current.is_empty() {
            let empty = FeedBatch::empty(self.current.project_id.clone());
            let finished = std::mem::replace(&mut self.current, empty);
            self.out.push(finished);
        }
        self.len = self.base;
    }

    fn add(&mut self, item: Item) {
        let encoded = match &item {
            Item::Row(r) => serde_json::to_vec(r),
            Item::Signal(s) => serde_json::to_vec(s.as_ref()),
            Item::Counter(c) => serde_json::to_vec(c),
        };
        // A value serde cannot encode — a non-finite `f64` in a provider's accounting is the one
        // way this happens — would poison the whole message at the Tauri boundary. Drop the one
        // element instead, loudly.
        let Ok(encoded) = encoded else {
            tracing::warn!("dropped a feed element that would not serialize");
            return;
        };

        let separator = |non_empty: bool| usize::from(non_empty);
        let cost = |batch: &FeedBatch| match &item {
            Item::Row(_) => encoded.len() + separator(!batch.rows.is_empty()),
            Item::Signal(_) => encoded.len() + separator(!batch.signals.is_empty()),
            Item::Counter(_) => encoded.len() + separator(!batch.counters.is_empty()),
        };

        let row_full =
            matches!(item, Item::Row(_)) && self.current.rows.len() >= MAX_ROWS_PER_MESSAGE;
        if row_full || self.len + cost(&self.current) > MAX_MESSAGE_BYTES {
            self.close();
        }
        self.len += cost(&self.current);
        match item {
            Item::Row(r) => self.current.rows.push(r),
            Item::Signal(s) => self.current.signals.push(*s),
            Item::Counter(c) => self.current.counters.push(c),
        }
    }

    fn finish(mut self) -> Vec<FeedBatch> {
        self.close();
        let mut checked = Vec::with_capacity(self.out.len());
        for batch in self.out {
            verify(batch, &mut checked);
        }
        checked
    }
}

/// Last line of defence: measure the finished message and halve it if the arithmetic was wrong.
fn verify(batch: FeedBatch, out: &mut Vec<FeedBatch>) {
    let size = serde_json::to_vec(&batch).map(|v| v.len()).unwrap_or(usize::MAX);
    if size < MAX_MESSAGE_BYTES {
        out.push(batch);
        return;
    }
    let splittable = batch.rows.len() + batch.signals.len() + batch.counters.len() > 1;
    if !splittable {
        tracing::warn!(bytes = size, "a single feed element exceeds the channel's fast path");
        out.push(batch);
        return;
    }
    let FeedBatch { project_id, mut rows, mut signals, mut counters } = batch;
    let tail = FeedBatch {
        project_id: project_id.clone(),
        rows: rows.split_off(rows.len() / 2),
        signals: signals.split_off(signals.len() / 2),
        counters: counters.split_off(counters.len() / 2),
    };
    let mut head = FeedBatch { project_id, rows, signals, counters };
    // A halving that leaves one side empty makes no progress, and recursing on the other side is
    // the same batch again — an infinite loop, on the one path that exists to stop bad arithmetic.
    // Unreachable while `splittable` holds and `split_off` halves each of the three vectors, so it
    // is a guard, not a case: take the oversized message and say so.
    if head.is_empty() || tail.is_empty() {
        tracing::warn!(
            bytes = size,
            rows = head.rows.len() + tail.rows.len(),
            "an oversized batch would not split; sending it whole"
        );
        head.rows.extend(tail.rows);
        head.signals.extend(tail.signals);
        head.counters.extend(tail.counters);
        out.push(head);
        return;
    }
    verify(head, out);
    verify(tail, out);
}

#[cfg(test)]
mod tests {
    use super::*;
    use brigadier_core::event::{InstanceId, ItemId, ItemKind, SessionId, Usage};

    fn envelope(seq: u64, event: Event) -> Envelope {
        Envelope::new(seq, InstanceId::new("i"), SessionId::new("s1"), event)
    }

    fn started() -> Event {
        Event::SessionStarted {
            provider_session_id: "abc".into(),
            model: "m".into(),
            cwd: std::path::PathBuf::from("/w"),
            capabilities: Vec::new(),
            resume_token: None,
        }
    }

    fn exited() -> Event {
        Event::SessionExited {
            reason: brigadier_core::event::ExitReason::Graceful,
            exit_code: Some(0),
        }
    }

    fn row_event(seq: u64) -> Envelope {
        envelope(
            seq,
            Event::item_completed(
                ItemId::new(format!("item-{seq}")),
                ItemKind::ToolCall { name: "Bash".into() },
                &"x".repeat(400),
                None,
            ),
        )
    }

    fn sink() -> (Batcher, Arc<crate::sink::VecSink>) {
        let sink = Arc::new(crate::sink::VecSink::new());
        (Batcher::new(sink.clone()), sink)
    }

    #[test]
    fn an_idle_frame_sends_nothing() {
        let (batcher, sink) = sink();
        batcher.flush_once();
        assert!(sink.is_empty());
    }

    #[test]
    fn every_message_stays_under_the_cliff_and_the_row_cap() {
        let (batcher, sink) = sink();
        for seq in 0..500 {
            batcher.push("p", &row_event(seq));
        }
        batcher.flush_once();
        let batches = sink.take();
        assert!(batches.len() > 1, "500 fat rows cannot fit in one message");
        let mut rows = 0;
        for b in &batches {
            let size = serde_json::to_vec(b).map(|v| v.len()).unwrap_or(usize::MAX);
            assert!(size < MAX_MESSAGE_BYTES, "message of {size} bytes");
            assert!(b.rows.len() <= MAX_ROWS_PER_MESSAGE, "{} rows", b.rows.len());
            rows += b.rows.len();
        }
        assert_eq!(rows, 500, "no row is lost to the split");
    }

    #[test]
    fn rows_keep_their_order_across_the_split() {
        let (batcher, sink) = sink();
        for seq in 0..100 {
            batcher.push("p", &row_event(seq));
        }
        batcher.flush_once();
        let seqs: Vec<u64> =
            sink.take().iter().flat_map(|b| b.rows.iter().map(|r| r.q)).collect();
        assert_eq!(seqs, (0..100).collect::<Vec<_>>());
    }

    #[test]
    fn a_signal_crosses_with_its_raw_excerpt_stripped() {
        let (batcher, sink) = sink();
        let raw = "z".repeat(4 * 1024);
        let env = envelope(
            1,
            Event::TurnCompleted {
                turn_id: brigadier_core::event::TurnId::new("t1"),
                stop_reason: brigadier_core::event::StopReason::EndTurn,
                usage: Usage::default(),
                cost_usd_cumulative: 0.01,
            },
        )
        .with_raw(&raw);
        assert!(env.raw().is_some(), "the envelope carries a 4 KB excerpt going in");
        batcher.push("p", &env);
        batcher.flush_once();
        let batches = sink.take();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].signals.len(), 1);
        assert_eq!(batches[0].signals[0].raw(), None, "the sink copy carries no raw excerpt");
        let text = serde_json::to_string(&batches[0]).unwrap_or_default();
        assert!(!text.contains("zzzz"), "no excerpt bytes on the wire");
        assert!(text.len() < MAX_MESSAGE_BYTES);
    }

    #[test]
    fn two_fat_signals_still_fit_because_raw_is_gone() {
        let (batcher, sink) = sink();
        let raw = "z".repeat(4 * 1024);
        for seq in 0..2 {
            batcher.push("p", &envelope(seq, Event::TurnStarted { turn_id: "t1".into() }).with_raw(&raw));
        }
        batcher.flush_once();
        for b in sink.take() {
            let size = serde_json::to_vec(&b).map(|v| v.len()).unwrap_or(usize::MAX);
            assert!(size < MAX_MESSAGE_BYTES, "{size} bytes");
        }
    }

    #[test]
    fn an_invisible_project_drops_rows_and_keeps_signals() {
        let (batcher, sink) = sink();
        batcher.set_visible_projects(vec!["other".into()]);
        for seq in 0..10 {
            batcher.push("p", &row_event(seq));
        }
        batcher.push("p", &envelope(99, Event::RuntimeWarning { message: "w".into() }));
        batcher.flush_once();
        let batches = sink.take();
        assert_eq!(batches.len(), 1);
        assert!(batches[0].rows.is_empty(), "no rows for an invisible project");
        assert_eq!(batches[0].signals.len(), 1, "signals ignore visibility");
        let counter = &batches[0].counters[0];
        // The warning is both a signal and a row, so 11 rows were offered and 11 dropped.
        assert_eq!(counter.rows_total, 11);
        assert_eq!(counter.rows_dropped, 11);
    }

    #[test]
    fn capture_keeps_rows_from_first_event_through_selection_changes_and_releases() {
        let (batcher, sink) = sink();
        batcher.set_visible_projects(vec!["chats".into()]);
        let first = batcher.capture_project("p");
        let second = batcher.capture_project("p");
        batcher.push("p", &row_event(1));
        batcher.set_visible_projects(vec![]);
        drop(first);
        batcher.push("p", &row_event(2));
        batcher.push("other", &row_event(3));
        batcher.flush_once();
        let batches = sink.take();
        assert_eq!(
            batches
                .iter()
                .flat_map(|b| &b.rows)
                .map(|r| r.q)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(
            batches
                .iter()
                .find(|b| b.project_id == "p")
                .unwrap()
                .counters[0]
                .rows_dropped,
            0
        );
        drop(second);
        batcher.push("p", &row_event(4));
        batcher.flush_once();
        assert!(sink.take().iter().all(|b| b.rows.is_empty()));
        batcher.set_visible_projects(vec!["p".into()]);
        batcher.push("p", &row_event(5));
        batcher.flush_once();
        assert_eq!(sink.take().iter().flat_map(|b| &b.rows).count(), 1);
    }

    #[test]
    fn the_row_buffer_is_capped_and_the_overflow_is_counted() {
        let (batcher, sink) = sink();
        for seq in 0..(PROJECT_ROW_CAP as u64 + 50) {
            batcher.push("p", &row_event(seq));
        }
        assert_eq!(batcher.buffered_rows("p"), PROJECT_ROW_CAP);
        batcher.flush_once();
        let batches = sink.take();
        let delivered: usize = batches.iter().map(|b| b.rows.len()).sum();
        assert_eq!(delivered, PROJECT_ROW_CAP);
        let counter = batches
            .iter()
            .flat_map(|b| b.counters.iter())
            .find(|c| c.session_id == "s1")
            .cloned()
            .unwrap_or_default();
        assert_eq!(counter.rows_total, PROJECT_ROW_CAP as u64 + 50);
        assert_eq!(counter.rows_dropped, 50);
        // The oldest rows are the ones that went.
        assert_eq!(batches[0].rows[0].q, 50);
    }

    /// The arithmetic `docs/research/feed-rendering.md` §4 predicts, measured here rather than
    /// assumed: 24 rows of worst-case 200-byte lines in one message, with headroom.
    ///
    /// `k` (added 2026-09-03) costs `,"k":"unknown"` — 14 bytes at the longest slug in the type —
    /// so 24 rows cost 336 bytes more than they did. `unknown` is measured here as the
    /// conservative bound even though a *batched* row can never carry it: batch rows come from
    /// `feed::kind`, whose longest output is `think` at 12 bytes. The measurement below is the
    /// check that matters; the row count is not re-derived from the table.
    #[test]
    fn a_full_frame_of_worst_case_rows_measures_what_the_research_predicted() {
        let rows: Vec<FeedRowWire> = (0..MAX_ROWS_PER_MESSAGE)
            .map(|i| FeedRowWire {
                s: "01J8Z3K2QK9V0V7T7QF2W3N4B5".to_owned(),
                q: i as u64,
                t: 1_756_800_000_000,
                l: "x".repeat(200),
                // The longest slug in the closed set, so the frame is measured at its worst.
                k: brigadier_store::FeedKind::Unknown,
            })
            .collect();
        let batch = FeedBatch {
            project_id: "01J8Z3K2QK9V0V7T7QF2W3N4B6".to_owned(),
            rows,
            signals: Vec::new(),
            counters: Vec::new(),
        };
        let size = serde_json::to_vec(&batch).map(|v| v.len()).unwrap_or(usize::MAX);
        eprintln!("24 rows x 200-byte lines = {size} bytes");
        assert!(size < MAX_MESSAGE_BYTES, "{size} bytes");
        assert!(size > 5_000, "the measurement is of a full frame, not an empty one: {size}");
    }

    /// The maps are per-project and per-session and nothing ever removed from them, so a long
    /// launch paid for every project and every session it had ever seen. A project whose sessions
    /// have all ended and whose buffers are empty is forgotten at the end of the tick.
    #[test]
    fn a_project_whose_sessions_have_all_ended_is_forgotten_at_the_end_of_the_tick() {
        let (batcher, sink) = sink();
        batcher.push("p", &envelope(1, started()));
        batcher.push("p", &row_event(2));
        batcher.flush_once();
        assert_eq!(batcher.tracked_projects(), vec!["p".to_owned()], "a live session is kept");
        assert!(batcher.counters("p", "s1").is_some());
        assert!(!sink.take().is_empty());

        batcher.push("p", &envelope(3, exited()));
        batcher.flush_once();

        // The exit's own frame still carried the session's final counter...
        let last = sink.take();
        let counter = last
            .iter()
            .flat_map(|b| b.counters.iter())
            .find(|c| c.session_id == "s1")
            .cloned()
            .expect("the exit frame carries the session's last counter");
        assert_eq!(counter.rows_total, 3, "started + item + exited all made rows");
        assert_eq!(counter.rows_dropped, 0);

        // ...and only then is the entry gone, project and all.
        assert!(batcher.tracked_projects().is_empty(), "{:?}", batcher.tracked_projects());
        assert_eq!(batcher.counters("p", "s1"), None);
        assert_eq!(batcher.buffered_rows("p"), 0);

        // An idle tick over an empty map is still silent.
        batcher.flush_once();
        assert!(sink.is_empty());
    }

    /// The counterpart: one session ending does not take the project's other sessions with it.
    #[test]
    fn a_project_with_one_live_session_left_is_kept() {
        let (batcher, sink) = sink();
        for id in ["s1", "s2"] {
            batcher.push("p", &Envelope::new(1, InstanceId::new("i"), SessionId::new(id), started()));
        }
        batcher.push(
            "p",
            &Envelope::new(2, InstanceId::new("i"), SessionId::new("s1"), exited()),
        );
        batcher.flush_once();
        let _ = sink.take();

        assert_eq!(batcher.tracked_projects(), vec!["p".to_owned()]);
        assert_eq!(batcher.counters("p", "s1"), None, "the ended session's entry is dropped");
        assert!(batcher.counters("p", "s2").is_some(), "the live one is not");
    }

    /// A session the batcher never saw start keeps its counters: they are the only record of it,
    /// and `Batcher::counters` is how a test reads back what a whole run produced.
    #[test]
    fn a_session_that_never_announced_a_start_keeps_its_counters() {
        let (batcher, sink) = sink();
        batcher.push("p", &row_event(1));
        batcher.push("p", &envelope(2, exited()));
        batcher.flush_once();
        let _ = sink.take();
        assert_eq!(batcher.counters("p", "s1").map(|(t, _)| t), Some(2));
        assert_eq!(batcher.tracked_projects(), vec!["p".to_owned()]);
    }

    #[test]
    fn counters_are_sent_only_for_sessions_touched_this_frame() {
        let (batcher, sink) = sink();
        batcher.push("p", &row_event(0));
        batcher.flush_once();
        assert_eq!(sink.take()[0].counters.len(), 1);
        batcher.flush_once();
        assert!(sink.is_empty(), "an untouched project is silent");
    }
}
