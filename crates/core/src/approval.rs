//! The approval park: requests the provider blocked on, and the decisions that unblock them.
//!
//! The mechanism is t3code's — mint our own request id, park a one-shot, resolve it by id —
//! with the two things they left out: a deadline, and a mandatory teardown fan-out.
// see docs/research/provider-driver.md §6 #5 (copy the park) and #25 (their park has no
// deadline on either provider, which is a wedged turn); docs/research/agent-sdk.md §3 says the
// same of the SDK itself: "permission prompts have no park deadline".

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::event::{RequestId, RequestKind};
use crate::session::{Decision, RespondError};

/// Deny reason delivered to a waiter whose deadline passed.
pub const TIMEOUT_REASON: &str = "timeout";

/// Deny reason delivered when a request id is opened twice.
pub const DUPLICATE_REASON: &str = "duplicate request id";

/// How many settled request ids are remembered, so a late answer gets a real error.
const DONE_HISTORY: usize = 512;

/// A request that is open right now, in the shape persistence needs to re-render it.
// see docs/research/persistence.md §6 — a reload must be able to re-show a pending prompt.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PendingApproval {
    /// The parked request.
    pub request_id: RequestId,
    /// What is being asked; the tool input inside is already excerpted.
    pub kind: RequestKind,
    /// When it was parked, on the wire as milliseconds since the Unix epoch.
    #[serde(with = "crate::event::millis")]
    pub opened_at: SystemTime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Disposition {
    Resolved,
    Cancelled,
    TimedOut,
}

#[derive(Debug)]
struct Parked {
    kind: RequestKind,
    opened_at: SystemTime,
    /// Which park a timer belongs to. A timer armed for epoch `n` must not fire on the park that
    /// re-used the same id after `n` was resolved.
    epoch: u64,
    tx: oneshot::Sender<Decision>,
}

#[derive(Debug, Default)]
struct Inner {
    parked: HashMap<RequestId, Parked>,
    settled: HashMap<RequestId, Disposition>,
    history: VecDeque<RequestId>,
    /// Monotonic across the whole table, never reset; the next park takes this value.
    next_epoch: u64,
}

impl Inner {
    fn settle(&mut self, id: RequestId, how: Disposition) {
        self.settled.insert(id.clone(), how);
        self.history.push_back(id);
        while self.history.len() > DONE_HISTORY {
            if let Some(old) = self.history.pop_front() {
                self.settled.remove(&old);
            }
        }
    }
}

/// Every request parked for one session. Clone-cheap; all clones share one table.
#[derive(Clone, Debug, Default)]
pub struct ApprovalTable {
    inner: Arc<Mutex<Inner>>,
}

impl ApprovalTable {
    /// An empty table.
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic elsewhere must not wedge the park; recover the state rather than unwrap.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Park `request_id` and hand back the waiter.
    ///
    /// With `timeout`, the waiter receives `Deny { reason: "timeout" }` when the deadline passes.
    /// The table emits no event of its own; the adapter emits `RequestResolved`.
    /// `None` is allowed, and is why [`ApprovalTable::cancel_all`] on teardown is mandatory.
    /// Re-opening a live id resolves the *new* waiter with [`DUPLICATE_REASON`] and leaves the
    /// original park intact.
    ///
    /// **A timeout needs a Tokio runtime.** The deadline is a `tokio::spawn`ed timer; called off a
    /// runtime there is nothing to spawn onto, so the timer is *not* armed — the park behaves as
    /// if `timeout` were `None` and a `tracing::warn` says so. Panicking instead would make a
    /// bookkeeping call fatal.
    pub fn open(
        &self,
        request_id: RequestId,
        kind: RequestKind,
        timeout: Option<Duration>,
    ) -> oneshot::Receiver<Decision> {
        let (tx, rx) = oneshot::channel();
        let epoch;
        {
            let mut inner = self.lock();
            if inner.parked.contains_key(&request_id) {
                drop(inner);
                let _ = tx.send(Decision::deny(DUPLICATE_REASON));
                return rx;
            }
            epoch = inner.next_epoch;
            inner.next_epoch += 1;
            inner.parked.insert(
                request_id.clone(),
                Parked { kind, opened_at: SystemTime::now(), epoch, tx },
            );
        }
        if let Some(after) = timeout {
            match tokio::runtime::Handle::try_current() {
                Ok(handle) => {
                    let table = self.clone();
                    handle.spawn(async move {
                        tokio::time::sleep(after).await;
                        table.time_out(&request_id, epoch);
                    });
                }
                Err(_) => tracing::warn!(
                    request_id = request_id.as_str(),
                    "no Tokio runtime; approval timeout not armed"
                ),
            }
        }
        rx
    }

    /// Deliver a decision to a parked waiter.
    pub fn resolve(
        &self,
        request_id: &RequestId,
        decision: Decision,
    ) -> Result<(), RespondError> {
        let mut inner = self.lock();
        if let Some(parked) = inner.parked.remove(request_id) {
            inner.settle(request_id.clone(), Disposition::Resolved);
            drop(inner);
            // The waiter may already have been dropped; the request is settled either way.
            let _ = parked.tx.send(decision);
            return Ok(());
        }
        match inner.settled.get(request_id) {
            Some(Disposition::Resolved) => Err(RespondError::AlreadyResolved),
            Some(Disposition::Cancelled | Disposition::TimedOut) => Err(RespondError::Expired),
            None => Err(RespondError::Unknown),
        }
    }

    /// Deny every open request with `reason`. Mandatory on teardown: an untimed park with no
    /// waiter left is a turn that never ends.
    pub fn cancel_all(&self, reason: &str) {
        let mut inner = self.lock();
        let drained: Vec<(RequestId, Parked)> = inner.parked.drain().collect();
        for (id, _) in &drained {
            inner.settle(id.clone(), Disposition::Cancelled);
        }
        drop(inner);
        for (_, parked) in drained {
            let _ = parked.tx.send(Decision::deny(reason));
        }
    }

    /// Every request open right now, oldest first.
    pub fn pending(&self) -> Vec<PendingApproval> {
        let inner = self.lock();
        let mut out: Vec<PendingApproval> = inner
            .parked
            .iter()
            .map(|(request_id, parked)| PendingApproval {
                request_id: request_id.clone(),
                kind: parked.kind.clone(),
                opened_at: parked.opened_at,
            })
            .collect();
        out.sort_by(|a, b| {
            a.opened_at.cmp(&b.opened_at).then_with(|| a.request_id.cmp(&b.request_id))
        });
        out
    }

    /// Fires the deadline armed by [`ApprovalTable::open`]. A no-op unless the park still open
    /// under `request_id` is the very one the timer was armed for: an id resolved and re-opened
    /// gets a fresh epoch, and the stale timer must not touch it.
    fn time_out(&self, request_id: &RequestId, epoch: u64) {
        let mut inner = self.lock();
        match inner.parked.get(request_id) {
            Some(parked) if parked.epoch == epoch => {}
            _ => return,
        }
        let Some(parked) = inner.parked.remove(request_id) else {
            return;
        };
        inner.settle(request_id.clone(), Disposition::TimedOut);
        drop(inner);
        let _ = parked.tx.send(Decision::deny(TIMEOUT_REASON));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(n: &str) -> RequestKind {
        RequestKind::UserInput { prompt: n.to_owned(), options: Vec::new() }
    }

    fn denied(d: &Decision) -> &str {
        match d {
            Decision::Deny { reason, .. } => reason,
            Decision::Allow { .. } => panic!("expected a denial, got {d:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn resolve_delivers_the_decision() {
        let table = ApprovalTable::new();
        let rx = table.open(RequestId::new("r1"), ask("q"), None);
        assert_eq!(table.pending().len(), 1);
        table.resolve(&RequestId::new("r1"), Decision::allow()).expect("resolves");
        assert_eq!(rx.await.expect("waiter woken"), Decision::allow());
        assert!(table.pending().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn double_resolve_is_reported_not_swallowed() {
        let table = ApprovalTable::new();
        let _rx = table.open(RequestId::new("r1"), ask("q"), None);
        table.resolve(&RequestId::new("r1"), Decision::allow()).expect("first resolve");
        assert_eq!(
            table.resolve(&RequestId::new("r1"), Decision::allow()),
            Err(RespondError::AlreadyResolved)
        );
        assert_eq!(
            table.resolve(&RequestId::new("never"), Decision::allow()),
            Err(RespondError::Unknown)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn timeout_denies_the_waiter_and_later_answers_are_expired() {
        let table = ApprovalTable::new();
        let rx = table.open(RequestId::new("r1"), ask("q"), Some(Duration::from_secs(30)));
        let decision = rx.await.expect("waiter woken by the deadline");
        assert_eq!(denied(&decision), TIMEOUT_REASON);
        assert!(table.pending().is_empty());
        assert_eq!(
            table.resolve(&RequestId::new("r1"), Decision::allow()),
            Err(RespondError::Expired)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_answer_before_the_deadline_wins() {
        let table = ApprovalTable::new();
        let rx = table.open(RequestId::new("r1"), ask("q"), Some(Duration::from_secs(30)));
        table.resolve(&RequestId::new("r1"), Decision::allow()).expect("resolves");
        assert_eq!(rx.await.expect("waiter woken"), Decision::allow());
        tokio::time::advance(Duration::from_secs(60)).await;
        assert_eq!(
            table.resolve(&RequestId::new("r1"), Decision::allow()),
            Err(RespondError::AlreadyResolved),
            "a fired timer must not overwrite a real answer"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_stale_timer_does_not_time_out_a_reopened_id() {
        let table = ApprovalTable::new();
        let first = table.open(RequestId::new("r"), ask("a"), Some(Duration::from_millis(120)));
        // Let the timer task reach its `sleep`: an unpolled task registers no deadline, and
        // `advance` would then move time *before* the timer starts and never fire it.
        tokio::task::yield_now().await;
        table.resolve(&RequestId::new("r"), Decision::allow()).expect("first resolve");
        assert_eq!(first.await.expect("first waiter woken"), Decision::allow());

        let mut second = table.open(RequestId::new("r"), ask("b"), None);
        tokio::time::advance(Duration::from_millis(200)).await;
        tokio::task::yield_now().await;

        assert_eq!(
            second.try_recv(),
            Err(oneshot::error::TryRecvError::Empty),
            "the first park's timer fired on the second park"
        );
        assert_eq!(table.pending().len(), 1);
        table.resolve(&RequestId::new("r"), Decision::allow()).expect("second park is still live");
        assert_eq!(second.await.expect("second waiter woken"), Decision::allow());
    }

    #[test]
    fn open_with_a_timeout_off_a_runtime_does_not_panic() {
        // `tokio::spawn` panics with no reactor; `open` must degrade to an untimed park instead.
        let table = ApprovalTable::new();
        let joined = std::thread::spawn(move || {
            let rx = table.open(RequestId::new("r"), ask("a"), Some(Duration::from_millis(1)));
            assert_eq!(table.pending().len(), 1, "the park is live, just untimed");
            table.resolve(&RequestId::new("r"), Decision::allow()).expect("resolves");
            rx.blocking_recv().expect("waiter woken")
        })
        .join();
        assert_eq!(joined.expect("open must not panic off a runtime"), Decision::allow());
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_all_fans_out_and_later_answers_are_expired() {
        let table = ApprovalTable::new();
        let a = table.open(RequestId::new("r1"), ask("a"), None);
        let b = table.open(RequestId::new("r2"), ask("b"), None);
        assert_eq!(table.pending().len(), 2);

        table.cancel_all("session torn down");

        assert_eq!(denied(&a.await.expect("r1 woken")), "session torn down");
        assert_eq!(denied(&b.await.expect("r2 woken")), "session torn down");
        assert!(table.pending().is_empty());
        assert_eq!(
            table.resolve(&RequestId::new("r1"), Decision::allow()),
            Err(RespondError::Expired)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_duplicate_id_does_not_steal_the_original_park() {
        let table = ApprovalTable::new();
        let first = table.open(RequestId::new("r1"), ask("a"), None);
        let dup = table.open(RequestId::new("r1"), ask("b"), None);
        assert_eq!(denied(&dup.await.expect("duplicate answered at once")), DUPLICATE_REASON);
        assert_eq!(table.pending().len(), 1);
        table.resolve(&RequestId::new("r1"), Decision::allow()).expect("original still parked");
        assert_eq!(first.await.expect("original woken"), Decision::allow());
    }

    #[tokio::test(start_paused = true)]
    async fn pending_is_ordered_and_serializable() {
        let table = ApprovalTable::new();
        let _a = table.open(RequestId::new("r1"), ask("a"), None);
        tokio::time::advance(Duration::from_millis(5)).await;
        let _b = table.open(RequestId::new("r2"), ask("b"), None);
        let pending = table.pending();
        assert_eq!(
            pending.iter().map(|p| p.request_id.as_str()).collect::<Vec<_>>(),
            ["r1", "r2"]
        );
        let json = serde_json::to_string(&pending[0]).expect("serializes");
        assert!(json.contains(r#""request_id":"r1""#), "{json}");
        assert!(json.contains(r#""type":"user-input""#), "{json}");
        let back: PendingApproval = serde_json::from_str(&json).expect("deserializes");
        assert_eq!(back.request_id, RequestId::new("r1"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_dropped_waiter_still_settles_the_request() {
        let table = ApprovalTable::new();
        drop(table.open(RequestId::new("r1"), ask("a"), None));
        table.resolve(&RequestId::new("r1"), Decision::allow()).expect("settles anyway");
        assert_eq!(
            table.resolve(&RequestId::new("r1"), Decision::allow()),
            Err(RespondError::AlreadyResolved)
        );
    }
}
