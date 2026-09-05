//! The orchestration loop: plan a goal, dispatch orders, gate the combination, commit on green.
//!
//! `docs/plans/phase-4.md` calls this *"the loop. This is the product."* Everything above it in
//! this crate only ever spawns a child when the owner presses a button; this module is the thing
//! that spawns on its own initiative, and every rule in it about *what must be true before a
//! spawn* is load-bearing rather than tidy.
//!
//! ## The spine
//!
//! ```text
//! barrier ─▶ plan ─▶ dispatch ─▶ collect ─▶ integration merge ─▶ gate
//!                                                                 │
//!                            green ─▶ --no-ff phase commit ─▶ cleanup ─▶ next phase
//!                              red ─▶ rung 1 (one fixer, in place) ─▶ gate
//!                                                                 └▶ rung 3: block, diagnose
//! ```
//!
//! ## Five things this loop must never do, and where each is enforced
//!
//! 1. **Never treat "the worker committed something" as "the worker finished the order".** A
//!    `work_order` intent can settle only `unknown` (`crates/store/src/intents.rs`), so there is
//!    no re-dispatch branch anywhere here — see
//!    [`state::BlockReason::OrdersInFlight`].
//! 2. **Never let a model's self-reported success settle a phase.** Only the exit code does; the
//!    report's `status` field is stored as a claim and read by nothing
//!    ([`dispatch::Collected`]).
//! 3. **Never put the verify command's output in the thread.** One harness-derived line; the
//!    output goes to a file, and to the rung-1 fixer as a file in its own worktree
//!    ([`ladder`], [`green`]).
//! 4. **Never use `git`'s `cherry` subcommand.** The only sound signal is `git rev-list --count base..branch`
//!    ([`git::rev_list_count`]), and branch deletion is `-d`, never `-D`.
//! 5. **Never spawn before the barrier resolves, and never fall through a barrier timeout**
//!    ([`barrier`]).
//!
//! ## What is deliberately not here
//!
//! - **Rung 2 of the red-gate ladder.** `orchestration-loop.md` §16 names it the weakest claim in
//!   that document: `docs/vision.md` §5's argument for fusion is that *a differently-trained
//!   model has different blind spots*, and with Claude Code only for v1 there is no such model.
//!   The ladder is rung 1 → rung 3 (`docs/plans/w1b-loop-order.md` §1 D3), so the child ceiling
//!   for a red phase is **N + 1**, not the `N + 3` the stale line in `orchestration-loop.md` §14
//!   still gives.
//! - **Cross-phase concurrency.** Phases run in order; see [`state::current`].
//! - **`review` and `replan`.** Both are in [`crate::action`]'s validated set and neither is
//!   executed here; a lead call that returns one blocks its phase with a named slug rather than
//!   being quietly ignored.
// see docs/research/orchestration-loop.md (the design), docs/plans/w1b-loop-order.md (the eight
// decisions taken on top of it), and docs/plans/ipc-contract.md "The run" (the wire shapes).

pub mod barrier;
pub mod call;
pub mod dispatch;
pub mod git;
pub mod green;
pub mod ladder;
pub mod plan;
pub mod routing;
pub mod state;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use brigadier_core::driver::DriverKind;
use brigadier_store::plan::{PhaseRow, PhaseState, PlanRow};
use brigadier_store::ProjectRow;

use crate::action::{Action, ActionError};
use crate::loop_::barrier::{Barrier, BarrierWait, ReconcileOutcome};
use crate::loop_::call::{SharedCall, SupervisedCall};
use crate::loop_::routing::Ceiling;
use crate::loop_::state::{BlockReason, PhaseStage, RunState};
use crate::verify::GateEnv;
use crate::{lock, Supervisor, SupervisorError};

/// How many workers may run at once, by default.
///
/// **An assumption, and it should be read as one.** `intent-records.md` §6 assumes four orders per
/// phase and `docs/vision.md` §9's mock shows three; neither is a measurement. It is not a cost
/// control — *"parallelism is token-neutral"* (`docs/vision.md` §6) — it is a bound on how far the
/// usage reserve can be drawn down between two samples, and on how many concurrent builds the
/// machine will take. Neither has been measured.
pub const DEFAULT_CONCURRENCY: usize = 4;

/// How long the loop waits for reconciliation before reporting *still reconciling*.
///
/// **Asserted.** On expiry the loop dispatches nothing; it never proceeds
/// (`orchestration-loop.md` §9.2).
pub const DEFAULT_BARRIER_TIMEOUT: Duration = Duration::from_secs(60);

/// Wall clock for one lead or planner call.
///
/// **Still an assumption, but no longer a blind one.** The previous value was 120 s, asserted
/// while `orchestration-loop.md` §2.5 admitted *"nothing in this repo has measured a lead-call
/// turn, because no lead call has ever run."* One has now: on 2026-09-04 the owner's first real
/// run spawned a planner that explored his repository with roughly twenty `Bash` calls and was
/// **still working productively when the 120 s clock killed it** — `exit 143`, at about four
/// minutes of wall time including the approvals it was parked on. **[measured, n = 1]**
///
/// 600 s is that observation with room over it: about 2.5x the longest stretch anyone has seen a
/// judgement call stay useful for, and still an order of magnitude under
/// [`DEFAULT_WORKER_TURN_DEADLINE`], which is what a call that builds and tests gets. It is not a
/// measurement of where a lead call stops being productive; nobody has measured that.
///
/// Time parked on an approval does not count against it — `SupervisedCall::watch` suspends both
/// clocks while a request is open (`docs/vision.md` §15 item 14) — so this is 600 s of the child
/// actually working.
///
/// Override without a rebuild: `BRIGADIER_LEAD_DEADLINE_SECS`. See [`Limits::from_env`].
pub const DEFAULT_LEAD_DEADLINE: Duration = Duration::from_secs(600);

/// No envelope of **any** kind from a lead or planner call within this and it is killed.
/// **Asserted.**
///
/// This is where the old 120 s went, and it is the clock that number always fitted. Until now a
/// lead call was given `quiet_deadline == turn_deadline`, which makes the quiet clock unreachable:
/// it can never expire before the turn clock it equals, so a wedged child was only ever caught at
/// the end of the whole turn. Two minutes of a judgement call saying *nothing at all* is the
/// wedged case; two minutes of it working is not.
///
/// Half [`DEFAULT_WORKER_QUIET_DEADLINE`], because a judgement call runs no builds — the long
/// silences a worker is allowed are a `cargo build`, and this lane has none.
///
/// Override without a rebuild: `BRIGADIER_LEAD_QUIET_DEADLINE_SECS`.
pub const DEFAULT_LEAD_QUIET_DEADLINE: Duration = Duration::from_secs(300);

/// No `TurnCompleted` from a worker within this and it is interrupted, then killed. **Asserted.**
pub const DEFAULT_WORKER_TURN_DEADLINE: Duration = Duration::from_secs(45 * 60);

/// No envelope of any kind from a worker within this. Catches a child that is alive and wedged,
/// which the turn deadline sees only at its end. **Asserted.**
pub const DEFAULT_WORKER_QUIET_DEADLINE: Duration = Duration::from_secs(10 * 60);

/// How long a phase's verify command may run before its process **group** is killed. **Asserted.**
pub const DEFAULT_GATE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// The bounds a run works inside. Every one is an assumption; none has been measured.
#[derive(Clone, Debug)]
pub struct Limits {
    /// Workers in flight at once, within one phase. Parked orders do not count against it.
    pub concurrency: usize,
    /// How long to wait on the reconciliation barrier.
    pub barrier_timeout: Duration,
    /// Wall clock for a planner or lead call. Time parked on an approval does not count.
    pub lead_deadline: Duration,
    /// Silence from a planner or lead call that means it is wedged. **Must be shorter than
    /// [`Limits::lead_deadline`]** or it can never fire.
    pub lead_quiet_deadline: Duration,
    /// Wall clock for one worker's turn.
    pub worker_turn_deadline: Duration,
    /// Silence from a worker that means it is wedged.
    pub worker_quiet_deadline: Duration,
    /// Wall clock for the verify command.
    pub gate_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            concurrency: DEFAULT_CONCURRENCY,
            barrier_timeout: DEFAULT_BARRIER_TIMEOUT,
            lead_deadline: DEFAULT_LEAD_DEADLINE,
            lead_quiet_deadline: DEFAULT_LEAD_QUIET_DEADLINE,
            worker_turn_deadline: DEFAULT_WORKER_TURN_DEADLINE,
            worker_quiet_deadline: DEFAULT_WORKER_QUIET_DEADLINE,
            gate_timeout: DEFAULT_GATE_TIMEOUT,
        }
    }
}

impl Limits {
    /// [`Limits::default`] with every bound the environment names overlaid, in **seconds**.
    ///
    /// Every default here is an assumption and one of them has already killed a run that was
    /// working. A number that is a guess should be changeable by the person watching it fail,
    /// without a rebuild; that is all this is.
    ///
    /// | variable | field |
    /// |---|---|
    /// | `BRIGADIER_CONCURRENCY` | [`Limits::concurrency`] — a count, not seconds |
    /// | `BRIGADIER_BARRIER_TIMEOUT_SECS` | [`Limits::barrier_timeout`] |
    /// | `BRIGADIER_LEAD_DEADLINE_SECS` | [`Limits::lead_deadline`] |
    /// | `BRIGADIER_LEAD_QUIET_DEADLINE_SECS` | [`Limits::lead_quiet_deadline`] |
    /// | `BRIGADIER_WORKER_TURN_DEADLINE_SECS` | [`Limits::worker_turn_deadline`] |
    /// | `BRIGADIER_WORKER_QUIET_DEADLINE_SECS` | [`Limits::worker_quiet_deadline`] |
    /// | `BRIGADIER_GATE_TIMEOUT_SECS` | [`Limits::gate_timeout`] |
    ///
    /// A variable that is unset, unparseable or zero is **ignored** and the default stands: a
    /// typo must not silently give a run a zero deadline, which would kill every child on its
    /// first tick. A rejected value is logged so it is not silently ignored either.
    #[must_use]
    pub fn from_env() -> Self {
        let mut limits = Self::default();
        if let Some(n) = env_positive("BRIGADIER_CONCURRENCY") {
            limits.concurrency = usize::try_from(n).unwrap_or(limits.concurrency);
        }
        if let Some(d) = env_secs("BRIGADIER_BARRIER_TIMEOUT_SECS") {
            limits.barrier_timeout = d;
        }
        if let Some(d) = env_secs("BRIGADIER_LEAD_DEADLINE_SECS") {
            limits.lead_deadline = d;
        }
        if let Some(d) = env_secs("BRIGADIER_LEAD_QUIET_DEADLINE_SECS") {
            limits.lead_quiet_deadline = d;
        }
        if let Some(d) = env_secs("BRIGADIER_WORKER_TURN_DEADLINE_SECS") {
            limits.worker_turn_deadline = d;
        }
        if let Some(d) = env_secs("BRIGADIER_WORKER_QUIET_DEADLINE_SECS") {
            limits.worker_quiet_deadline = d;
        }
        if let Some(d) = env_secs("BRIGADIER_GATE_TIMEOUT_SECS") {
            limits.gate_timeout = d;
        }
        limits
    }
}

/// A duration in whole seconds from the environment, or `None`.
fn env_secs(key: &str) -> Option<Duration> {
    env_positive(key).map(Duration::from_secs)
}

/// A strictly positive `u64` from the environment, or `None` — unset, unparseable or zero.
fn env_positive(key: &str) -> Option<u64> {
    let raw = std::env::var(key).ok()?;
    match raw.trim().parse::<u64>() {
        Ok(0) | Err(_) => {
            tracing::warn!(key, value = %raw, "ignoring an unusable limit override");
            None
        }
        Ok(n) => {
            tracing::info!(key, value = n, "limit overridden from the environment");
            Some(n)
        }
    }
}

/// Why the loop could not do something. Distinct from [`SupervisorError`] because most of these
/// are *decisions* — the loop refusing to act — rather than failures.
#[derive(Debug, thiserror::Error)]
pub enum LoopError {
    /// The project is not a git repository, or `git` is not on `PATH`.
    ///
    /// **A refusal, not a fallback.** `worktree::prepare` answers `Ok(None)` in that case and
    /// `Supervisor::start_session` then leaves the child in the **project root** — which, combined
    /// with the worker wall's pre-authorization of writes below the worktree root, would hand an
    /// unattended worker write access to the owner's own checkout. The single-session fallback is
    /// defensible for a session the owner started and watched; it is not defensible here.
    // see docs/plans/w1b-loop-order.md §7.5.
    #[error("{0} has no git worktree to isolate a worker in; refusing to dispatch")]
    NoWorktree(PathBuf),
    /// A model's answer did not survive validation.
    #[error("the {label} call returned an action this harness will not run: {source}")]
    Action {
        /// Which call it was.
        label: &'static str,
        /// What was wrong with it.
        #[source]
        source: ActionError,
    },
    /// A model's answer never arrived: a deadline, an abort, an exit, or no text at all.
    #[error("the {label} call ended {end} without an answer")]
    NoAnswer {
        /// Which call it was.
        label: &'static str,
        /// The end slug.
        end: String,
    },
    /// A git call the loop depends on failed.
    #[error(transparent)]
    Git(#[from] git::GitError),
    /// The loop needed a plan and the store has none.
    #[error("no plan {0}")]
    NoSuchPlan(String),
    /// An action this loop does not execute. `review` and `replan` are both validated and neither
    /// is implemented; a phase that receives one blocks rather than pretending.
    #[error("the {0} action is validated but not implemented in this build")]
    NotImplemented(&'static str),
    /// Anything the supervisor refused.
    #[error(transparent)]
    Supervisor(#[from] SupervisorError),
    /// The store refused a read or a write.
    #[error(transparent)]
    Store(#[from] brigadier_store::Error),
    /// Something on the filesystem.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl LoopError {
    /// A stable slug, for a feed line and the plan card.
    #[must_use]
    pub fn slug(&self) -> &'static str {
        match self {
            Self::NoWorktree(_) => "no_worktree",
            Self::Action { .. } => "malformed_action",
            Self::NoAnswer { .. } => "no_answer",
            Self::Git(_) => "git",
            Self::NoSuchPlan(_) => "no_such_plan",
            Self::NotImplemented(_) => "not_implemented",
            Self::Supervisor(_) => "supervisor",
            Self::Store(_) => "store",
            Self::Io(_) => "io",
        }
    }
}

/// What one tick of the loop decided.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Tick {
    /// Work happened; call again.
    Continue,
    /// Every phase is green. The run is over.
    Finished,
    /// The owner asked the run to stop, and nothing new was dispatched.
    Stopped,
    /// The run cannot proceed. Only the owner leaves this.
    Blocked(String),
}

/// What to start.
#[derive(Debug)]
pub struct RunSpec {
    /// Which project.
    pub project_id: String,
    /// The owner's stated intent, verbatim. **Immutable for the run**
    /// (`orchestration-loop.md` §10 invariant 1).
    pub goal: String,
    /// The driver every child is started on.
    pub driver: DriverKind,
    /// The model the owner picked for this run, or `None` for role-based routing.
    ///
    /// **`Some` is a ceiling, not a default.** Nothing the run starts — planner, lead, worker,
    /// fixer, reviewer — exceeds it, and a planner asking for a stronger tier is clamped rather
    /// than refused. With no pick, judgement takes the provider default (the owner's own strong
    /// model) and a work order takes its own tier **capped at mid-tier**, per `docs/vision.md` §6
    /// (*"judgement (lead, grill, review, judge) gets the strong model; work orders get
    /// mid-tier"*). Owner decision, 2026-09-05.
    ///
    /// This field says only what the owner picked; every question of *what a given child is
    /// started on* is answered by [`Ceiling`], including what an
    /// id this build does not recognise does. Read that module before changing anything here.
    ///
    /// **Correction, 2026-09-05.** Up to `bf036d6` this doc said `Some` was *"honoured literally,
    /// by every child"*, and explicitly rejected the ceiling reading on the grounds that a picker
    /// governing only some children would be a lie. That is superseded: the pick governs every
    /// child either way — what changed is that it now also *bounds* the planner, which literal
    /// honouring did not. A picker that cannot stop the run spending above it was the larger lie,
    /// and it cost 3× on one measured run (`crates/supervisor/src/loop_/routing.rs`).
    pub model: Option<String>,
    /// The permission mode the owner picked. Reaches the `--permission-mode` flag **and** the
    /// `PreToolUse` policy of every child; see
    /// [`policy_for`](brigadier_core::claude::hook::policy_for).
    pub permission_mode: brigadier_core::driver::PermissionMode,
    /// The reconciliation barrier. Awaited at the top of the first tick, before the plan is read
    /// and before the first `worktree::prepare`.
    pub barrier: Barrier,
    /// The bounds.
    pub limits: Limits,
    /// The model-call seam. `None` builds the real one.
    pub call: Option<SharedCall>,
    /// The resolved gate environment. `None` resolves one on first use, which can cost up to
    /// [`crate::verify::PATH_PROBE_TIMEOUT`].
    pub gate: Option<Arc<GateEnv>>,
    /// An existing plan to continue instead of writing a new one. **This is what a restart is.**
    ///
    /// A fresh launch that mints a second plan for a goal already half-finished would re-plan work
    /// that is already committed, so the caller that reopens a project hands back the plan id it
    /// read from the store. `goal` is still required and is *not* written over the stored one: the
    /// goal is immutable for the run (`orchestration-loop.md` §10 invariant 1).
    pub plan_id: Option<String>,
}

impl RunSpec {
    /// A run of `goal` in `project_id` on `driver`, with everything else defaulted.
    #[must_use]
    pub fn new(
        project_id: impl Into<String>,
        goal: impl Into<String>,
        driver: DriverKind,
        barrier: Barrier,
    ) -> Self {
        Self {
            project_id: project_id.into(),
            goal: goal.into(),
            driver,
            model: None,
            permission_mode: brigadier_core::driver::PermissionMode::Default,
            barrier,
            limits: Limits::default(),
            call: None,
            gate: None,
            plan_id: None,
        }
    }

    /// Continue `plan_id` rather than writing a new plan. What a restart does.
    #[must_use]
    pub fn resuming(mut self, plan_id: impl Into<String>) -> Self {
        self.plan_id = Some(plan_id.into());
        self
    }

    /// Cap every child at `model`. `None` leaves role-based routing in charge; see
    /// [`RunSpec::model`].
    #[must_use]
    pub fn with_model(mut self, model: Option<String>) -> Self {
        self.model = model;
        self
    }

    /// Run every child under `mode`, at the flag **and** at the hook.
    #[must_use]
    pub fn with_permission_mode(
        mut self,
        mode: brigadier_core::driver::PermissionMode,
    ) -> Self {
        self.permission_mode = mode;
        self
    }
}

/// A live run, as the caller holds it.
///
/// Cheap to clone; every clone names the same run.
#[derive(Clone, Debug)]
pub struct RunHandle {
    plan_id: String,
    stop: Arc<AtomicBool>,
    task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl RunHandle {
    /// The plan this run is working through.
    #[must_use]
    pub fn plan_id(&self) -> &str {
        &self.plan_id
    }

    /// Stop dispatching.
    ///
    /// **It does not kill anything.** A worker killed mid-order leaves a worktree whose
    /// `work_order` intent reconciles to `unknown`, which blocks its phase permanently — so the
    /// cheap-looking implementation of "stop" is the one that poisons the plan
    /// (`docs/plans/ipc-contract.md`, "The run"). In-flight orders are allowed to finish and are
    /// collected; nothing new is dispatched after the current step.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }

    /// Whether [`RunHandle::stop`] has been called.
    #[must_use]
    pub fn stopping(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }

    /// Wait for the run's task to finish. Returns immediately if it has already been awaited.
    pub async fn join(&self) {
        let task = lock(&self.task).take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}

/// One run's state and everything it needs to advance.
///
/// Constructed by [`Supervisor::start_run`], and directly by tests that want to drive it one
/// [`Run::tick`] at a time rather than let it run.
pub struct Run {
    sup: Supervisor,
    project: ProjectRow,
    plan_id: String,
    goal: String,
    /// The owner's model pick, read as a ceiling. The only thing that decides what any child of
    /// this run is started on. See [`RunSpec::model`] and [`Ceiling`].
    ceiling: Ceiling,
    /// The owner's permission mode. Reaches every child's flag and every child's hook policy.
    permission_mode: brigadier_core::driver::PermissionMode,
    call: SharedCall,
    limits: Limits,
    barrier: Barrier,
    reconciled: Option<ReconcileOutcome>,
    gate: Option<Arc<GateEnv>>,
    git: PathBuf,
    stop: Arc<AtomicBool>,
    state: RunState,
}

impl std::fmt::Debug for Run {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Run")
            .field("plan_id", &self.plan_id)
            .field("project", &self.project.id)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

impl Run {
    /// The plan being worked through.
    #[must_use]
    pub fn plan_id(&self) -> &str {
        &self.plan_id
    }

    /// Where the run is.
    #[must_use]
    pub fn state(&self) -> &RunState {
        &self.state
    }

    /// Advance until the run finishes, blocks, or is stopped.
    pub async fn drive(&mut self) -> Tick {
        loop {
            let tick = self.tick().await;
            if tick != Tick::Continue {
                return tick;
            }
        }
    }

    /// One step.
    ///
    /// The barrier is awaited **first**, above everything: before the plan is read and before the
    /// first `worktree::prepare`, because a `worktree add` into a repository that has not been
    /// `git worktree repair`ed is the failure `intent-records.md` §4.2 calls *"the single largest
    /// correctness landmine in the reconciler"*.
    pub async fn tick(&mut self) -> Tick {
        if let Some(blocked) = self.await_barrier().await {
            self.state = match &blocked {
                Tick::Blocked(why) => RunState::Blocked(why.clone()),
                _ => self.state.clone(),
            };
            return blocked;
        }
        if self.stop.load(Ordering::Acquire) {
            self.state = RunState::Stopped;
            return Tick::Stopped;
        }
        self.state = RunState::Running;
        match self.step().await {
            Ok(tick) => {
                match &tick {
                    Tick::Finished => self.state = RunState::Finished,
                    Tick::Blocked(why) => self.state = RunState::Blocked(why.clone()),
                    Tick::Stopped => self.state = RunState::Stopped,
                    Tick::Continue => {}
                }
                tick
            }
            Err(e) => {
                let why = format!("{}: {e}", e.slug());
                tracing::error!(plan_id = %self.plan_id, error = %e, "the run stopped");
                self.state = RunState::Blocked(why.clone());
                Tick::Blocked(why)
            }
        }
    }

    /// Resolve the barrier once, or say why the run may not dispatch.
    ///
    /// `Some(Tick::Blocked)` means **nothing was spawned and nothing will be**. Three sub-cases,
    /// and collapsing them is the bug (`orchestration-loop.md` §9.2).
    async fn await_barrier(&mut self) -> Option<Tick> {
        if self.reconciled.is_some() {
            return None;
        }
        self.state = RunState::AwaitingReconcile;
        match self.barrier.wait(self.limits.barrier_timeout).await {
            BarrierWait::Ready(outcome) => {
                // Case 3, and the one that is not obvious: a `not_done` derived from a broken
                // `git worktree repair` is a licence to redo work that already ran.
                if outcome.repair_failed(&self.project.id) {
                    return Some(Tick::Blocked("repair_failed".to_owned()));
                }
                tracing::info!(
                    plan_id = %self.plan_id,
                    settled = outcome.settled,
                    unknown_phases = outcome.unknown_phases.len(),
                    "reconciliation complete; the loop may dispatch"
                );
                self.reconciled = Some(outcome);
                None
            }
            // Case 1. A reconciler that did not run is strictly worse than one that is slow.
            BarrierWait::SenderDropped => Some(Tick::Blocked("reconcile_failed".to_owned())),
            // The rule of §9.2's last paragraph, and §15 item 15. A timeout **never** falls
            // through: the run reports that it is still reconciling and dispatches nothing.
            BarrierWait::TimedOut(within) => {
                tracing::warn!(
                    plan_id = %self.plan_id,
                    seconds = within.as_secs(),
                    "still reconciling; dispatching nothing"
                );
                Some(Tick::Blocked("still_reconciling".to_owned()))
            }
        }
    }

    async fn step(&mut self) -> Result<Tick, LoopError> {
        let store = &self.sup.inner.store;
        let phases = store.phases(&self.plan_id).await?;
        if phases.is_empty() {
            plan::make_plan(self).await?;
            return Ok(Tick::Continue);
        }

        let reconciled = self.reconciled.clone().unwrap_or_default();
        let mut stages = Vec::with_capacity(phases.len());
        for phase in &phases {
            let orders = store.work_orders(&phase.id).await?;
            stages.push(state::derive(phase, &orders, &reconciled));
        }
        let Some(i) = state::current(&phases, &stages) else {
            // **The plan row stays `approved`, and that is the store's shape, not an oversight.**
            // `upsert_plan` rewrites only `goal` on conflict — `status` is a transition with its
            // own op — and the only such op is `plan_approved`. There is no `plan_done`, so
            // nothing here can move a finished plan to `PlanStatus::Done` without inventing a
            // second write path for a column the store deliberately guards. A run is finished
            // when every phase is `green`, which is what the plan card reads anyway.
            let plan = self.plan_row().await?;
            tracing::info!(
                plan_id = %plan.id,
                phases = phases.len(),
                "every phase is green; the run is finished"
            );
            return Ok(Tick::Finished);
        };
        let phase = phases[i].clone();
        match &stages[i] {
            PhaseStage::Done => unreachable!("`current` skips every done phase"),
            PhaseStage::Blocked(why) => {
                self.record_block(&phase, why).await?;
                Ok(Tick::Blocked(format!("phase {}: {}", phase.ordinal, why.slug())))
            }
            PhaseStage::Ready => self.begin_phase(phase).await,
            PhaseStage::Collected => self.integrate(phase).await,
        }
    }

    /// Take a phase from nothing to a set of dispatched-and-collected orders.
    async fn begin_phase(&mut self, mut phase: PhaseRow) -> Result<Tick, LoopError> {
        // Refused before any git work, and before any child: a project with no repository has no
        // worktree to isolate a worker in, and the single-session fallback — run in the project
        // root — would hand an unattended worker the owner's own checkout.
        if !brigadier_core::worktree::is_repo(&self.git, &self.project.root_path).await {
            return Err(LoopError::NoWorktree(self.project.root_path.clone()));
        }
        let store = &self.sup.inner.store;
        // D7: resolve the base **once per phase** and store it. `worktree::prepare` branches from
        // the constant `HEAD`, and `HEAD` moves the moment this loop commits a phase, so two
        // orders dispatched either side of a phase commit would branch from different commits and
        // the merge would then be against two different bases.
        //
        // A base already on the row wins, and it has to: `phases.base_sha` is **write-once**
        // (`COALESCE(phases.base_sha, excluded.base_sha)`, `crates/store/src/writer.rs`), so a
        // re-attempt that read `HEAD` afresh would dispatch against one commit while the store,
        // the merge and the postcondition all named another.
        let base_sha = match &phase.base_sha {
            Some(sha) => sha.clone(),
            None => git::rev_parse(&self.git, &self.project.root_path, "HEAD").await?,
        };
        phase.base_sha = Some(base_sha.clone());
        phase.state = PhaseState::Running;
        store.upsert_phase(phase.clone()).await?;
        store.phase_attempt_started(phase.id.clone(), SystemTime::now()).await?;

        let action = plan::lead_call(self, &phase).await?;
        match action {
            Action::Dispatch(action) => {
                let out = dispatch::run(self, &phase, &base_sha, action.orders).await?;
                // §3.2: ownership is advisory going in and enforced coming out. A path outside
                // an order's declared set **blocks the merge** and goes to the owner; the loop
                // never repairs a partition itself (§15 item 10).
                if !out.violations.is_empty() {
                    let why = BlockReason::Recorded(Some(out.violations.join("; ")));
                    self.record_block(&phase, &why).await?;
                    return Ok(Tick::Blocked(format!(
                        "phase {}: ownership_violation",
                        phase.ordinal
                    )));
                }
                // The anti-spin guard, and it is not theoretical: a phase that dispatches and
                // records nothing derives `Ready` again on the next tick, so without this the
                // loop re-dispatches the same orders forever, spending a lead call and N workers
                // per revolution. A dispatch that left no trace is a defect, not a state.
                if self.sup.inner.store.work_orders(&phase.id).await?.is_empty() {
                    let why = BlockReason::Recorded(Some(
                        "the dispatch recorded no work orders for this phase; refusing to \
                         re-dispatch the same action forever"
                            .to_owned(),
                    ));
                    self.record_block(&phase, &why).await?;
                    return Ok(Tick::Blocked(format!("phase {}: no_orders", phase.ordinal)));
                }
                Ok(Tick::Continue)
            }
            // A lead that wants to gate straight away is answered by the next tick: with no
            // orders the phase derives `Ready` again, so the honest reading is that it declined to
            // dispatch. Blocking is the safe direction — the alternative is a lead call that
            // spins.
            Action::Verify(_) | Action::Merge(_) => {
                let why = BlockReason::Recorded(Some(
                    "the lead asked to gate a phase that has dispatched nothing".to_owned(),
                ));
                self.record_block(&phase, &why).await?;
                Ok(Tick::Blocked(format!("phase {}: nothing_to_gate", phase.ordinal)))
            }
            Action::AskOwner(ask) => {
                let why = BlockReason::Recorded(Some(format!(
                    "{} — {}",
                    ask.question.trim(),
                    ask.why_blocked.trim()
                )));
                self.record_block(&phase, &why).await?;
                Ok(Tick::Blocked(format!("phase {}: ask_owner", phase.ordinal)))
            }
            Action::Plan(_) => Err(LoopError::Action {
                label: "lead",
                source: ActionError::UnknownAction("plan".to_owned()),
            }),
            Action::Review(_) => Err(LoopError::NotImplemented("review")),
            Action::Replan(_) => Err(LoopError::NotImplemented("replan")),
        }
    }

    /// Merge the phase's orders, gate the combination, and act on the **exit code**.
    async fn integrate(&mut self, phase: PhaseRow) -> Result<Tick, LoopError> {
        let outcome = green::integrate(self, &phase).await?;
        match outcome {
            green::Outcome::Green { commit_sha, evidence } => {
                self.sup
                    .inner
                    .store
                    .phase_settled(
                        phase.id.clone(),
                        PhaseState::Green,
                        Some(0),
                        Some(evidence),
                        commit_sha,
                        SystemTime::now(),
                    )
                    .await?;
                Ok(Tick::Continue)
            }
            green::Outcome::Red { exit_code, evidence } => {
                self.sup
                    .inner
                    .store
                    .phase_settled(
                        phase.id.clone(),
                        PhaseState::Blocked,
                        exit_code,
                        Some(evidence.clone()),
                        None,
                        SystemTime::now(),
                    )
                    .await?;
                Ok(Tick::Blocked(format!("phase {}: {evidence}", phase.ordinal)))
            }
        }
    }

    async fn record_block(
        &self,
        phase: &PhaseRow,
        why: &BlockReason,
    ) -> Result<(), brigadier_store::Error> {
        let evidence = match why {
            BlockReason::Recorded(Some(text)) => text.clone(),
            BlockReason::Recorded(None) => why.slug().to_owned(),
            BlockReason::OrdersInFlight(ids) => format!(
                "{} — {} order(s) were in flight when the harness last stopped; \
                 a work order can never settle not_done, so nothing is re-dispatched",
                why.slug(),
                ids.len()
            ),
            other => other.slug().to_owned(),
        };
        tracing::warn!(phase_id = %phase.id, reason = why.slug(), "phase blocked");
        self.sup
            .inner
            .store
            .phase_settled(
                phase.id.clone(),
                PhaseState::Blocked,
                phase.last_exit_code,
                Some(evidence),
                None,
                SystemTime::now(),
            )
            .await
    }

    async fn plan_row(&self) -> Result<PlanRow, LoopError> {
        self.sup
            .inner
            .store
            .plan(&self.plan_id)
            .await?
            .ok_or_else(|| LoopError::NoSuchPlan(self.plan_id.clone()))
    }

    /// The gate environment, resolved once per run and cached.
    async fn gate_env(&mut self) -> Arc<GateEnv> {
        if let Some(gate) = &self.gate {
            return Arc::clone(gate);
        }
        let env = Arc::new(GateEnv::resolve(default_shell()).await);
        tracing::info!(
            path_source = ?env.path_source(),
            pipefail = env.pipefail(),
            "gate environment resolved"
        );
        self.gate = Some(Arc::clone(&env));
        env
    }

    /// Where a phase's gate logs go: `<data_dir>/gates/<phase_id>/<attempt>.log`.
    fn gate_log(&self, phase_id: &str, attempt: u32) -> PathBuf {
        self.sup.data_dir().join("gates").join(phase_id).join(format!("{attempt}.log"))
    }
}

/// `$SHELL`, or `/bin/sh`. The gate's own probe decides what that shell can do.
fn default_shell() -> PathBuf {
    std::env::var_os("SHELL").map_or_else(|| PathBuf::from("/bin/sh"), PathBuf::from)
}

impl Supervisor {
    /// Start a run: one approved goal, one plan, and a loop that dispatches without a human.
    ///
    /// The plan row is written and approved before the task starts, so the returned handle always
    /// names a plan the UI can read. **Nothing is spawned until the reconciliation barrier
    /// resolves** — that happens inside the first tick, after this function has returned.
    ///
    /// # Errors
    /// [`SupervisorError::NoSuchProject`], [`SupervisorError::InvalidArgument`] for an empty goal
    /// or a project that is not a git repository, and [`SupervisorError::SessionLive`] when a run
    /// is already live for that project.
    pub async fn start_run(&self, spec: RunSpec) -> Result<RunHandle, SupervisorError> {
        let mut run = self.prepare_run(spec).await?;
        let handle = RunHandle {
            plan_id: run.plan_id.clone(),
            stop: Arc::clone(&run.stop),
            task: Arc::new(Mutex::new(None)),
        };
        // The entry is removed when the task ends, not left behind: `prepare_run` refuses a
        // second run while one is live, and a finished run that stayed in the map would refuse
        // every later run for the life of the process.
        let inner = Arc::clone(&self.inner);
        let plan_id = run.plan_id.clone();
        let task = tokio::spawn(async move {
            let tick = run.drive().await;
            tracing::info!(plan_id = %run.plan_id, ?tick, "run finished");
            lock(&inner.runs).remove(&plan_id);
        });
        *lock(&handle.task) = Some(task);
        lock(&self.inner.runs).insert(handle.plan_id.clone(), handle.clone());
        Ok(handle)
    }

    /// Everything [`Supervisor::start_run`] does except starting the task.
    ///
    /// The plan row is written and approved; nothing is spawned and no barrier is awaited. A
    /// caller that wants to drive the loop one [`Run::tick`] at a time — a test, or a future
    /// step-through surface — takes this instead of [`Supervisor::start_run`].
    ///
    /// # Errors
    /// As [`Supervisor::start_run`].
    pub async fn prepare_run(&self, spec: RunSpec) -> Result<Run, SupervisorError> {
        if spec.goal.trim().is_empty() {
            return Err(SupervisorError::InvalidArgument("a run needs a goal".to_owned()));
        }
        let project =
            self.project(&spec.project_id).await?.ok_or(SupervisorError::NoSuchProject)?;
        if lock(&self.inner.runs).values().any(|r| !r.stopping()) {
            // One run at a time, per `ipc-contract.md`'s `run_already_live`.
            let live = lock(&self.inner.runs)
                .values()
                .find(|r| !r.stopping())
                .map(|r| r.plan_id.clone())
                .unwrap_or_default();
            return Err(SupervisorError::SessionLive(format!("run {live} is already live")));
        }
        let git = brigadier_core::worktree::resolve_git().ok_or_else(|| {
            SupervisorError::InvalidArgument("no git on PATH; a run cannot isolate a worker".into())
        })?;

        let now = SystemTime::now();
        let plan_id = match spec.plan_id {
            // A restart: the plan, its phases, its unknowns and its committed shas are all
            // already on disk, and re-approving or rewriting any of them would be a second
            // source of truth for a run that is already under way.
            Some(existing) => {
                self.inner
                    .store
                    .plan(&existing)
                    .await?
                    .ok_or_else(|| SupervisorError::InvalidArgument(format!("no plan {existing}")))?;
                existing
            }
            None => {
                let plan_id = uuid::Uuid::new_v4().to_string();
                let row =
                    PlanRow::new(plan_id.clone(), project.id.clone(), spec.goal.trim(), now);
                self.inner.store.upsert_plan(row).await?;
                // The owner started the run, which is the approval `docs/vision.md` §4 step 6
                // describes: one envelope, covering the whole run. Nothing inside it is approved
                // again.
                self.inner.store.plan_approved(plan_id.clone(), now).await?;
                plan_id
            }
        };

        let call: SharedCall = spec.call.unwrap_or_else(|| {
            Arc::new(SupervisedCall::new(
                self.clone(),
                spec.driver.clone(),
                project.root_path.clone(),
            ))
        });
        Ok(Run {
            sup: self.clone(),
            project,
            plan_id,
            goal: spec.goal.trim().to_owned(),
            ceiling: Ceiling::new(spec.model),
            permission_mode: spec.permission_mode,
            call,
            limits: spec.limits,
            barrier: spec.barrier,
            reconciled: None,
            gate: spec.gate,
            git,
            stop: Arc::new(AtomicBool::new(false)),
            state: RunState::AwaitingReconcile,
        })
    }

    /// Stop a live run's dispatching. `false` when no run by that plan id is known.
    ///
    /// **Never kills a worker mid-order.** See [`RunHandle::stop`].
    pub fn stop_run(&self, plan_id: &str) -> bool {
        match lock(&self.inner.runs).get(plan_id) {
            Some(handle) => {
                handle.stop();
                true
            }
            None => false,
        }
    }

    /// The handle for a run this launch started, if it is still known.
    #[must_use]
    pub fn run(&self, plan_id: &str) -> Option<RunHandle> {
        lock(&self.inner.runs).get(plan_id).cloned()
    }

    /// Every run this launch started.
    #[must_use]
    pub fn runs(&self) -> Vec<RunHandle> {
        lock(&self.inner.runs).values().cloned().collect()
    }
}
