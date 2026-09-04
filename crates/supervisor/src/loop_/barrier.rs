//! The reconciliation barrier: nothing spawns until the reconciler has read the world.
//!
//! `docs/research/intent-records.md` §4.1 states the constraint in as many words — *the
//! orchestration loop must not dispatch its first work order until reconciliation has completed*
//! — and `docs/research/orchestration-loop.md` §9 says why each of the failure cases is different
//! from the others.
//!
//! **The type is a [`tokio::sync::watch`] channel and that is a decision, not a taste.**
//! `intent-records.md` §4.1 offers `Notify` or an awaited `JoinHandle`. `Notify` is
//! *edge*-triggered: a `notified()` awaited after the notification fired misses it, and
//! reconciliation is spawned off the setup path the way `prune_worktrees` is
//! (`src-tauri/src/lib.rs`), so it may well finish before the loop exists. A `watch` is
//! *level*-triggered — a late reader sees the value immediately — and unlike a `JoinHandle` it
//! can be read by more than one consumer, which the UI's own `unsettled_intents` command will
//! want.
//!
//! **A timeout never falls through.** [`BarrierWait::TimedOut`] dispatches nothing and reports
//! *still reconciling*. `orchestration-loop.md` §9.2 calls proceeding past it *"the most tempting
//! wrong implementation of this whole section"*, and §15 item 15 makes it a rule.
// see docs/research/orchestration-loop.md §9 and docs/plans/w1b-loop-order.md §7.

use std::collections::BTreeSet;
use std::time::Duration;

use tokio::sync::watch;

/// What reconciliation found, as the loop needs to act on it.
///
/// Deliberately three separate facts rather than one "ok / not ok" flag: §9.2's whole point is
/// that collapsing them is the bug. A closed channel stops the run; an `unknown` row stops one
/// phase; a failed `git worktree repair` stops one **project**, and for a reason that is not
/// obvious — see [`ReconcileOutcome::repair_failed`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReconcileOutcome {
    /// Phases carrying an intent that settled `unknown`. Each is skipped; the run continues.
    ///
    /// `intent-records.md` §5.1: an `unknown` on a `work_order` or a `phase_commit` **blocks its
    /// phase, never the run**, and is never retried.
    pub unknown_phases: BTreeSet<String>,
    /// Projects whose `git worktree repair` failed. The loop refuses to dispatch in these.
    pub repair_failed: BTreeSet<String>,
    /// How many rows reconciliation settled, for the one feed line the loop writes about it.
    pub settled: usize,
}

impl ReconcileOutcome {
    /// A clean pass: everything settled, nothing unknown, no repair failure.
    #[must_use]
    pub fn clean() -> Self {
        Self::default()
    }

    /// Whether this project's worktree repair failed, which forbids dispatch in it.
    ///
    /// The reasoning is one step longer than it looks and is worth keeping written down.
    /// `intent-records.md` §7 records that a renamed project plus a failed repair *"leaves every
    /// path-based postcondition reading `not_done` for worktrees that exist"* — and `not_done` is
    /// the **one** outcome that authorizes a re-dispatch. So a `not_done` derived from a broken
    /// repair is a licence to redo work that already ran. Refusing is the only safe reading.
    #[must_use]
    pub fn repair_failed(&self, project_id: &str) -> bool {
        self.repair_failed.contains(project_id)
    }

    /// Whether this phase carries an `unknown` intent and must be skipped.
    #[must_use]
    pub fn phase_is_unknown(&self, phase_id: &str) -> bool {
        self.unknown_phases.contains(phase_id)
    }
}

/// The writing half. Held by the reconciler; dropping it without sending is a failure the loop
/// can see.
#[derive(Debug)]
pub struct ReconcileSender(watch::Sender<Option<ReconcileOutcome>>);

impl ReconcileSender {
    /// Publish the outcome. Every current and future [`Barrier`] sees it.
    pub fn publish(&self, outcome: ReconcileOutcome) {
        // A closed receiver is not an error here: the run may already have been stopped.
        let _ = self.0.send(Some(outcome));
    }
}

/// The reading half, held by a run.
#[derive(Clone, Debug)]
pub struct Barrier(watch::Receiver<Option<ReconcileOutcome>>);

/// A barrier that has not been resolved, and the handle that resolves it.
#[must_use]
pub fn barrier() -> (ReconcileSender, Barrier) {
    let (tx, rx) = watch::channel(None);
    (ReconcileSender(tx), Barrier(rx))
}

/// A barrier that is already resolved. For a launch with nothing to reconcile, and for tests.
#[must_use]
pub fn resolved(outcome: ReconcileOutcome) -> Barrier {
    let (tx, rx) = watch::channel(Some(outcome));
    // Deliberately leaked into the receiver's lifetime: a resolved barrier has no sender to
    // outlive, and dropping `tx` here would be indistinguishable from a reconciler that died.
    // `watch` keeps the last value after the sender drops, and `wait` reads the value before it
    // reads the closure, so this is safe — the test below pins that ordering.
    drop(tx);
    Barrier(rx)
}

/// How a wait on the barrier ended. Three of the four dispatch nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BarrierWait {
    /// Reconciliation completed. The outcome still decides which phases and projects are open.
    Ready(ReconcileOutcome),
    /// The sender was dropped without publishing: the reconciler panicked, or its task was
    /// cancelled. **Dispatch nothing.** A reconciler that did not run is strictly worse than one
    /// that is slow (`orchestration-loop.md` §9.2 case 1).
    SenderDropped,
    /// The bound expired. **Dispatch nothing**, and say *still reconciling* rather than
    /// proceeding (§9.2's closing rule, §15 item 15).
    TimedOut(Duration),
}

impl Barrier {
    /// The outcome if it is already published, without waiting. Level-triggered: this is what a
    /// `Notify` could not do.
    #[must_use]
    pub fn peek(&self) -> Option<ReconcileOutcome> {
        self.0.borrow().clone()
    }

    /// Wait up to `within` for reconciliation to complete.
    ///
    /// The order of the three checks is load-bearing. A sender that published and *then* dropped
    /// has both delivered its value and closed the channel, and `changed()` reports only the
    /// closure — so the value is read first, and again after a closure, before the closure is
    /// reported as a failure. Reading them the other way round turns a successful reconciliation
    /// into `Blocked(reconcile_failed)` whenever the reconciler is tidy enough to drop its
    /// handle.
    pub async fn wait(&mut self, within: Duration) -> BarrierWait {
        if let Some(outcome) = self.peek() {
            return BarrierWait::Ready(outcome);
        }
        let listen = async {
            loop {
                if self.0.changed().await.is_err() {
                    // Closed. The value may still have landed in the same instant.
                    return match self.peek() {
                        Some(outcome) => BarrierWait::Ready(outcome),
                        None => BarrierWait::SenderDropped,
                    };
                }
                if let Some(outcome) = self.peek() {
                    return BarrierWait::Ready(outcome);
                }
            }
        };
        match tokio::time::timeout(within, listen).await {
            Ok(done) => done,
            Err(_) => BarrierWait::TimedOut(within),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome_with_unknown(phase: &str) -> ReconcileOutcome {
        ReconcileOutcome {
            unknown_phases: [phase.to_owned()].into_iter().collect(),
            ..ReconcileOutcome::clean()
        }
    }

    /// The property a `Notify` does not have, and the reason for the whole type choice: the
    /// reconciler finishes **before** the loop exists, and the loop still sees the answer.
    #[tokio::test]
    async fn a_reader_that_arrives_after_the_publish_still_sees_it() {
        let (tx, mut rx) = barrier();
        tx.publish(outcome_with_unknown("p3"));
        // Not merely late: the sender is gone entirely by the time anybody reads.
        drop(tx);
        let got = rx.wait(Duration::from_millis(50)).await;
        assert_eq!(got, BarrierWait::Ready(outcome_with_unknown("p3")));
    }

    #[tokio::test]
    async fn a_sender_dropped_without_publishing_is_a_failure_not_a_timeout() {
        let (tx, mut rx) = barrier();
        drop(tx);
        assert_eq!(rx.wait(Duration::from_secs(30)).await, BarrierWait::SenderDropped);
    }

    #[tokio::test]
    async fn a_barrier_nobody_resolves_times_out_and_never_reports_ready() {
        let (_tx, mut rx) = barrier();
        let within = Duration::from_millis(20);
        assert_eq!(rx.wait(within).await, BarrierWait::TimedOut(within));
        // And it stays timed out: there is no second, laxer reading.
        assert_eq!(rx.wait(within).await, BarrierWait::TimedOut(within));
    }

    #[tokio::test]
    async fn a_publish_that_arrives_during_the_wait_is_picked_up() {
        let (tx, mut rx) = barrier();
        let task = tokio::spawn(async move { rx.wait(Duration::from_secs(5)).await });
        tokio::time::sleep(Duration::from_millis(10)).await;
        tx.publish(ReconcileOutcome::clean());
        assert_eq!(task.await.expect("join"), BarrierWait::Ready(ReconcileOutcome::clean()));
    }

    #[tokio::test]
    async fn a_pre_resolved_barrier_needs_no_live_sender() {
        let mut rx = resolved(outcome_with_unknown("p1"));
        assert_eq!(
            rx.wait(Duration::from_millis(1)).await,
            BarrierWait::Ready(outcome_with_unknown("p1"))
        );
    }

    #[test]
    fn the_two_scopes_are_separate_questions() {
        let outcome = ReconcileOutcome {
            unknown_phases: ["p2".to_owned()].into_iter().collect(),
            repair_failed: ["proj-b".to_owned()].into_iter().collect(),
            settled: 3,
        };
        assert!(outcome.phase_is_unknown("p2"));
        assert!(!outcome.phase_is_unknown("p1"));
        assert!(outcome.repair_failed("proj-b"));
        assert!(!outcome.repair_failed("proj-a"));
    }
}
