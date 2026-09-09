//! Where a phase is, **re-derived from the store** rather than remembered.
//!
//! `docs/plans/w1b-loop-order.md` §1 D4: the persisted phase state is the store's four-value
//! [`PhaseState`] and nothing more. `orchestration-loop.md` §1.1 draws a twelve-state machine;
//! putting twelve values in a column would be a second source of truth for something the
//! `work_orders` and `intents` rows already answer, and the two would drift. So the finer states
//! live in memory inside one tick and this module is how a fresh launch works out where it is.
//!
//! Everything here is **pure**: rows in, a verdict out, no I/O and no clock. That is what makes
//! the crash-by-crash cases cheap to test.
// see docs/research/orchestration-loop.md §1 and docs/plans/w1b-loop-order.md §1 D4, §7.4.

use brigadier_store::plan::{PhaseRow, PhaseState, WorkOrderRow, WorkOrderState};

use crate::loop_::barrier::ReconcileOutcome;

/// Why a phase will not be worked on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlockReason {
    /// An intent attached to this phase settled `unknown`. Never retried
    /// (`docs/research/intent-records.md` §5.1).
    UnknownIntent,
    /// The store already has the phase at [`PhaseState::Blocked`], with whatever evidence put it
    /// there.
    Recorded(Option<String>),
    /// A previous launch died with work orders dispatched, and there is no sound way to tell
    /// whether they had effects.
    ///
    /// **This is the honest limit on unattended crash recovery, and it is enforced at the store's
    /// write.** `crates/store/src/intents.rs` holds `work_order` to settling only `unknown` —
    /// an owner decision of 2026-09-04 — because `rev-list --count` plus a dirty count is not a
    /// sufficient test for *"nothing happened"*: a worker that ran `npm install`, wrote above the
    /// worktree root, or made and reverted its own changes leaves both at baseline and would read
    /// `not_done`, which would authorize re-dispatching an order that already had effects. So
    /// there is no `not_done` for a work order and therefore **no re-dispatch branch anywhere in
    /// this loop**. The cost is that a crash with orders in flight blocks those phases until the
    /// owner settles each intent by hand.
    OrdersInFlight(Vec<String>),
    /// The phase has no verify command, so it cannot go green through a gate.
    ///
    /// The store makes `verify_command` nullable precisely so the loop can **see** this rather
    /// than fabricate a command (`crates/store/src/plan.rs`).
    NoVerifyCommand,
}

impl BlockReason {
    /// A stable slug for a feed line and the plan card.
    #[must_use]
    pub fn slug(&self) -> &'static str {
        match self {
            Self::UnknownIntent => "unknown_intent",
            Self::Recorded(_) => "recorded",
            Self::OrdersInFlight(_) => "orders_in_flight",
            Self::NoVerifyCommand => "no_verify_command",
        }
    }
}

/// What the loop should do with one phase, given only what is in the store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PhaseStage {
    /// Nothing has been dispatched. Ask the lead what to do.
    Ready,
    /// Every order this phase dispatched has settled. Merge them, gate the combination.
    Collected,
    /// Green, committed, finished.
    Done,
    /// Will not be worked on. Only the owner leaves this state.
    Blocked(BlockReason),
}

impl PhaseStage {
    /// Whether the loop may spawn anything for this phase.
    #[must_use]
    pub fn is_open(&self) -> bool {
        matches!(self, Self::Ready | Self::Collected)
    }
}

/// Work out where a phase is from its row, its orders and what reconciliation found.
///
/// The order of the tests is the priority order, and the first two are deliberately ahead of the
/// stored state: an `unknown` intent overrides a row that still says `running`, because the row
/// was written *behind* reality and the intent is the record of what reality might be.
#[must_use]
pub fn derive(
    phase: &PhaseRow,
    orders: &[WorkOrderRow],
    reconciled: &ReconcileOutcome,
) -> PhaseStage {
    if reconciled.phase_is_unknown(&phase.id) {
        return PhaseStage::Blocked(BlockReason::UnknownIntent);
    }
    match phase.state {
        PhaseState::Green => return PhaseStage::Done,
        PhaseState::Blocked => {
            return PhaseStage::Blocked(BlockReason::Recorded(phase.last_evidence.clone()))
        }
        PhaseState::Pending | PhaseState::Running => {}
    }
    if phase.verify_command.as_deref().is_none_or(str::is_empty) {
        return PhaseStage::Blocked(BlockReason::NoVerifyCommand);
    }
    let in_flight: Vec<String> = orders
        .iter()
        .filter(|o| {
            matches!(
                o.state,
                WorkOrderState::Pending | WorkOrderState::Dispatched | WorkOrderState::Unknown
            )
        })
        .map(|o| o.id.clone())
        .collect();
    if !in_flight.is_empty() {
        return PhaseStage::Blocked(BlockReason::OrdersInFlight(in_flight));
    }
    if orders.is_empty() {
        PhaseStage::Ready
    } else {
        PhaseStage::Collected
    }
}

/// The phase the run is on: the lowest ordinal that is not [`PhaseStage::Done`].
///
/// **Phases run in order and there is no cross-phase concurrency.** `orchestration-loop.md` §11
/// names phases-in-order as the conservative default *"if the plan store does not carry the data
/// to compute phase independence"* — and it does not: `crates/store/src/plan.rs` has no
/// dependency edge and no per-phase `owns` union. So *"park one order, not the run"* delivers
/// concurrency **within** a phase and not across phases, which is less than `docs/vision.md` §8
/// promises. That gap belongs to a plan-store column, not to a runtime guess
/// (`docs/plans/w1b-loop-order.md` §1 D5).
///
/// The consequence to be clear about: a blocked phase stops the run, because the run cannot step
/// over it.
#[must_use]
pub fn current<'a>(phases: &'a [PhaseRow], stages: &'a [PhaseStage]) -> Option<usize> {
    let mut order: Vec<usize> = (0..phases.len()).collect();
    order.sort_by_key(|&i| phases[i].ordinal);
    order.into_iter().find(|&i| stages[i] != PhaseStage::Done)
}

/// Where the whole run is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunState {
    /// The barrier has not resolved. Nothing has been spawned.
    AwaitingReconcile,
    /// Working.
    Running,
    /// Every phase is [`PhaseStage::Done`].
    Finished,
    /// Stopped, with a reason. Only the owner leaves this.
    Blocked(String),
    /// The owner asked for it to stop. In-flight orders were allowed to finish.
    Stopped,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn phase(state: PhaseState) -> PhaseRow {
        let mut row = PhaseRow::new("ph1", "plan1", 0, "a phase");
        row.state = state;
        row.verify_command = Some("true".to_owned());
        row
    }

    fn order(id: &str, state: WorkOrderState) -> WorkOrderRow {
        let mut row = WorkOrderRow::new(id, "ph1", "an order");
        row.state = state;
        row
    }

    #[test]
    fn a_fresh_phase_with_no_orders_is_ready() {
        let stage = derive(&phase(PhaseState::Pending), &[], &ReconcileOutcome::clean());
        assert_eq!(stage, PhaseStage::Ready);
    }

    #[test]
    fn every_order_settled_means_merge_and_gate() {
        let orders = [
            order("o1", WorkOrderState::Reported),
            order("o2", WorkOrderState::Failed),
        ];
        let stage = derive(
            &phase(PhaseState::Running),
            &orders,
            &ReconcileOutcome::clean(),
        );
        assert_eq!(stage, PhaseStage::Collected);
    }

    /// The crash case, and the whole of §7.4: a launch that died with orders dispatched has no
    /// re-dispatch branch to take, because `work_order` can never settle `not_done`.
    #[test]
    fn a_dispatched_order_from_a_dead_launch_blocks_its_phase() {
        let orders = [
            order("o1", WorkOrderState::Reported),
            order("o2", WorkOrderState::Dispatched),
        ];
        let stage = derive(
            &phase(PhaseState::Running),
            &orders,
            &ReconcileOutcome::clean(),
        );
        assert_eq!(
            stage,
            PhaseStage::Blocked(BlockReason::OrdersInFlight(vec!["o2".into()]))
        );
        assert!(!stage.is_open(), "nothing may be spawned for it");
    }

    #[test]
    fn an_order_at_unknown_blocks_rather_than_being_repeated() {
        let orders = [order("o1", WorkOrderState::Unknown)];
        let stage = derive(
            &phase(PhaseState::Running),
            &orders,
            &ReconcileOutcome::clean(),
        );
        assert_eq!(
            stage,
            PhaseStage::Blocked(BlockReason::OrdersInFlight(vec!["o1".into()]))
        );
    }

    #[test]
    fn an_unknown_intent_beats_a_row_that_still_says_running() {
        let reconciled = ReconcileOutcome {
            unknown_phases: ["ph1".to_owned()].into_iter().collect(),
            ..ReconcileOutcome::clean()
        };
        // The row and its orders both look perfectly healthy.
        let orders = [order("o1", WorkOrderState::Reported)];
        assert_eq!(
            derive(&phase(PhaseState::Running), &orders, &reconciled),
            PhaseStage::Blocked(BlockReason::UnknownIntent)
        );
    }

    #[test]
    fn a_phase_with_no_verify_command_is_blocked_not_passed() {
        let mut row = phase(PhaseState::Pending);
        row.verify_command = None;
        assert_eq!(
            derive(&row, &[], &ReconcileOutcome::clean()),
            PhaseStage::Blocked(BlockReason::NoVerifyCommand)
        );
        row.verify_command = Some(String::new());
        assert_eq!(
            derive(&row, &[], &ReconcileOutcome::clean()),
            PhaseStage::Blocked(BlockReason::NoVerifyCommand)
        );
    }

    #[test]
    fn a_green_phase_stays_done_whatever_its_orders_say() {
        let mut row = phase(PhaseState::Green);
        row.ended_at = Some(SystemTime::now());
        let orders = [order("o1", WorkOrderState::Dispatched)];
        assert_eq!(
            derive(&row, &orders, &ReconcileOutcome::clean()),
            PhaseStage::Done
        );
    }

    #[test]
    fn the_run_is_on_the_lowest_ordinal_that_is_not_done() {
        let mut phases: Vec<PhaseRow> = (0..3)
            .map(|i| {
                let mut p = PhaseRow::new(format!("ph{i}"), "plan1", i, "t");
                p.verify_command = Some("true".to_owned());
                p
            })
            .collect();
        // Out of order in the vector, in order by ordinal.
        phases.swap(0, 2);
        let stages = vec![PhaseStage::Ready, PhaseStage::Done, PhaseStage::Done];
        // ordinals are now [2, 1, 0]; index 2 holds ordinal 0 and is Done, index 1 ordinal 1 Done,
        // index 0 ordinal 2 Ready.
        assert_eq!(current(&phases, &stages), Some(0));

        let all_done = vec![PhaseStage::Done; 3];
        assert_eq!(current(&phases, &all_done), None);
    }

    /// D5's consequence, said out loud in a test: a blocked phase stops the run rather than being
    /// stepped over.
    #[test]
    fn a_blocked_phase_is_still_the_current_phase() {
        let phases: Vec<PhaseRow> = (0..2)
            .map(|i| PhaseRow::new(format!("ph{i}"), "plan1", i, "t"))
            .collect();
        let stages = vec![
            PhaseStage::Blocked(BlockReason::UnknownIntent),
            PhaseStage::Ready,
        ];
        assert_eq!(current(&phases, &stages), Some(0));
    }
}
