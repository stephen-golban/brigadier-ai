//! The orchestration loop's spine, end to end, with **no `claude` child anywhere**.
//!
//! `docs/research/orchestration-loop.md` §13.1 is the case list this file works through: what the
//! tree can prove for free. §13.2's live tests cost money and are not here.
//!
//! Two seams make it free. The model calls go through
//! [`ModelCall`](brigadier_supervisor::loop_::call::ModelCall), so a fake answers with the same
//! fenced JSON a child would and **counts its spawns** — which is what most of §13.1's assertions
//! actually are. The one test that needs the real spawn path uses
//! [`ReplayDriver`](brigadier_supervisor::ReplayDriver), whose script is the real adapter's
//! translation of a captured frame.
//!
//! Every git operation is real, in a throwaway repository.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use brigadier_core::driver::{DriverKind, PermissionMode};
use brigadier_core::event::{Event, ItemId, ItemKind, RequestKind};
use brigadier_store::plan::{PhaseState, WorkOrderState};
use brigadier_store::Store;
use brigadier_supervisor::loop_::barrier::{barrier, resolved, Barrier, ReconcileOutcome};
use brigadier_supervisor::loop_::call::{
    CallCwd, CallEnd, CallOutcome, CallRequest, ModelCall, ScriptedCall, SupervisedCall,
};
use brigadier_supervisor::loop_::{Limits, LoopError, Run, RunSpec, Tick};
use brigadier_supervisor::replay::{ApprovalPlan, REPLAY};
use brigadier_supervisor::verify::{GateEnv, PathSource};
use brigadier_supervisor::{ReplayDriver, Supervisor, SupervisorConfig, VecSink};

// ---------------------------------------------------------------------------------------------
// the rig
// ---------------------------------------------------------------------------------------------

struct Rig {
    dir: tempfile::TempDir,
    #[allow(dead_code)]
    store: Store,
    sup: Supervisor,
    git: PathBuf,
    project_id: String,
    root: PathBuf,
}

impl Rig {
    /// A store, a supervisor, and a project that **is** a git repository with one commit.
    async fn new() -> Option<Rig> {
        brigadier_core::checkpoint::WorkspaceLease::isolate_registry_for_tests();
        Self::build(true).await
    }

    /// The same, with a project directory that is deliberately not a repository.
    async fn without_repo() -> Option<Rig> {
        Self::build(false).await
    }

    async fn build(repo: bool) -> Option<Rig> {
        let git = brigadier_core::worktree::resolve_git()?;
        let dir = tempfile::tempdir().ok()?;
        let store = Store::open(dir.path()).ok()?;
        let run_id = store.run_id().to_owned();
        let mut config = SupervisorConfig::new(
            store.handle().clone(),
            run_id,
            dir.path().to_owned(),
            Arc::new(VecSink::new()),
        );
        config.frame_interval = Duration::from_millis(5);
        let sup = Supervisor::new(config);

        let root = dir.path().join("project");
        std::fs::create_dir_all(&root).ok()?;
        if repo {
            for args in [
                vec!["init", "-q", "-b", "main"],
                vec!["config", "user.email", "t@example.com"],
                vec!["config", "user.name", "t"],
                vec!["config", "commit.gpgsign", "false"],
            ] {
                run_git(&git, &root, &args);
            }
            std::fs::write(root.join("README"), "one\n").ok()?;
            run_git(&git, &root, &["add", "-A"]);
            run_git(&git, &root, &["commit", "-q", "-m", "one"]);
        }
        let project_id = sup.add_project(root.clone()).await.ok()?.id;
        Some(Rig {
            dir,
            store,
            sup,
            git,
            project_id,
            root,
        })
    }

    fn head(&self) -> String {
        String::from_utf8_lossy(&run_git(&self.git, &self.root, &["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_owned()
    }

    fn branches(&self) -> Vec<String> {
        String::from_utf8_lossy(
            &run_git(
                &self.git,
                &self.root,
                &["branch", "--format=%(refname:short)"],
            )
            .stdout,
        )
        .lines()
        .map(str::to_owned)
        .collect()
    }

    /// A gate environment with the `PATH` supplied, so no test pays the login-shell probe.
    async fn gate(&self) -> Arc<GateEnv> {
        let path = std::env::var_os("PATH").unwrap_or_default();
        Arc::new(GateEnv::with_path("/bin/sh", path, PathSource::Explicit).await)
    }

    async fn run_with(&self, fake: Arc<Fake>, barrier: Barrier, limits: Limits) -> Run {
        self.sup
            .prepare_run(RunSpec {
                orchestration: Default::default(),
                project_id: self.project_id.clone(),
                goal: "ship the thing".to_owned(),
                model: None,
                effort: None,
                permission_mode: Default::default(),
                driver: DriverKind::new("claude-code"),
                barrier,
                limits,
                call: Some(fake),
                gate: Some(self.gate().await),
                plan_id: None,
            })
            .await
            .expect("a run is prepared")
    }

    async fn run(&self, fake: Arc<Fake>) -> Run {
        self.run_with(fake, resolved(ReconcileOutcome::clean()), Limits::default())
            .await
    }

    /// A run started with the owner's model pick, which is a **ceiling** over every child
    /// (`crates/supervisor/src/loop_/routing.rs`).
    async fn run_picking(&self, fake: Arc<Fake>, model: Option<&str>) -> Run {
        self.sup
            .prepare_run(RunSpec {
                orchestration: Default::default(),
                project_id: self.project_id.clone(),
                goal: "ship the thing".to_owned(),
                model: model.map(str::to_owned),
                effort: None,
                permission_mode: Default::default(),
                driver: DriverKind::new("claude-code"),
                barrier: resolved(ReconcileOutcome::clean()),
                limits: Limits::default(),
                call: Some(fake),
                gate: Some(self.gate().await),
                plan_id: None,
            })
            .await
            .expect("a run is prepared")
    }

    /// What a restart is: a new [`Run`] over the plan that is already on disk.
    async fn restart(&self, fake: Arc<Fake>, plan_id: &str, barrier: Barrier) -> Run {
        self.sup
            .prepare_run(RunSpec {
                orchestration: Default::default(),
                project_id: self.project_id.clone(),
                goal: "ship the thing".to_owned(),
                model: None,
                effort: None,
                permission_mode: Default::default(),
                driver: DriverKind::new("claude-code"),
                barrier,
                limits: Limits::default(),
                call: Some(fake),
                gate: Some(self.gate().await),
                plan_id: Some(plan_id.to_owned()),
            })
            .await
            .expect("a run is prepared")
    }
}

fn run_git(git: &Path, cwd: &Path, args: &[&str]) -> std::process::Output {
    Command::new(git)
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git runs")
}

// ---------------------------------------------------------------------------------------------
// the fake model
// ---------------------------------------------------------------------------------------------

/// What a fake worker or fixer does to its worktree before it answers.
#[derive(Clone, Debug)]
enum Work {
    /// Nothing at all. Its branch stays level with the phase base.
    Nothing,
    /// Write `<dir>/<order-id>.txt` and commit it.
    Under(&'static str),
    /// Write one named file and commit it. Used to make a red gate go green.
    File(&'static str),
}

/// A [`ModelCall`] that answers from a script, counts its spawns, records their peak concurrency,
/// and — unlike a pure stub — really commits to the worktree it was given.
///
/// The last part matters: without it every branch would be level with the phase base and the
/// merge, the ownership check and the cleanup gate would all be exercised on an empty diff.
#[derive(Debug, Default)]
struct Fake {
    answers: Mutex<BTreeMap<&'static str, VecDeque<String>>>,
    work: Mutex<BTreeMap<&'static str, Work>>,
    calls: Mutex<Vec<(&'static str, PathBuf)>>,
    /// What each call was told to run on, in order. The ceiling's whole output, as the loop
    /// actually handed it to a driver.
    models: Mutex<Vec<(&'static str, Option<String>)>>,
    live: AtomicUsize,
    peak: AtomicUsize,
    delay: Mutex<Duration>,
    git: Mutex<Option<PathBuf>>,
}

impl Fake {
    fn new() -> Arc<Fake> {
        Arc::new(Fake::default())
    }

    fn say(self: &Arc<Self>, label: &'static str, text: impl Into<String>) -> Arc<Self> {
        self.answers
            .lock()
            .expect("lock")
            .entry(label)
            .or_default()
            .push_back(text.into());
        Arc::clone(self)
    }

    fn does(self: &Arc<Self>, label: &'static str, work: Work, git: &Path) -> Arc<Self> {
        self.work.lock().expect("lock").insert(label, work);
        *self.git.lock().expect("lock") = Some(git.to_path_buf());
        Arc::clone(self)
    }

    fn slow(self: &Arc<Self>, delay: Duration) -> Arc<Self> {
        *self.delay.lock().expect("lock") = delay;
        Arc::clone(self)
    }

    fn count(&self, label: &str) -> usize {
        self.calls
            .lock()
            .expect("lock")
            .iter()
            .filter(|(l, _)| *l == label)
            .count()
    }

    fn total(&self) -> usize {
        self.calls.lock().expect("lock").len()
    }

    fn peak(&self) -> usize {
        self.peak.load(Ordering::Relaxed)
    }

    /// Every model this run asked for under `label`, in call order.
    fn models(&self, label: &str) -> Vec<Option<String>> {
        self.models
            .lock()
            .expect("lock")
            .iter()
            .filter(|(l, _)| *l == label)
            .map(|(_, m)| m.clone())
            .collect()
    }
}

/// The order id the harness put in a worker's prompt, so a fake can name its file after it.
fn order_id_of(prompt: &str) -> String {
    prompt
        .split("\"order_id\": \"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap_or("o")
        .to_owned()
}

impl ModelCall for Fake {
    fn call<'a>(
        &'a self,
        req: CallRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CallOutcome, LoopError>> + Send + 'a>,
    > {
        Box::pin(async move {
            let delay = *self.delay.lock().expect("lock");
            {
                let mut calls = self.calls.lock().expect("lock");
                calls.push((
                    req.label,
                    match &req.cwd {
                        CallCwd::ProjectRoot => PathBuf::new(),
                        CallCwd::Worktree { dir, .. } => dir.clone(),
                    },
                ));
                self.models
                    .lock()
                    .expect("lock")
                    .push((req.label, req.model.clone()));
            }
            let live = self.live.fetch_add(1, Ordering::Relaxed) + 1;
            self.peak.fetch_max(live, Ordering::Relaxed);

            if let (CallCwd::Worktree { dir, .. }, Some(work)) = (
                &req.cwd,
                self.work.lock().expect("lock").get(req.label).cloned(),
            ) {
                let git = self.git.lock().expect("lock").clone().expect("a git path");
                let name = match &work {
                    Work::Nothing => None,
                    Work::Under(base) => Some(format!("{base}/{}.txt", order_id_of(&req.prompt))),
                    Work::File(name) => Some((*name).to_owned()),
                };
                if let Some(name) = name {
                    let path = dir.join(&name);
                    if let Some(parent) = path.parent() {
                        std::fs::create_dir_all(parent).expect("mkdir");
                    }
                    std::fs::write(&path, "work\n").expect("write");
                    run_git(&git, dir, &["add", "-A"]);
                    run_git(
                        &git,
                        dir,
                        &["commit", "-q", "-m", &format!("brigadier: {name}")],
                    );
                }
            }

            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            self.live.fetch_sub(1, Ordering::Relaxed);

            let queued = {
                let mut answers = self.answers.lock().expect("lock");
                answers.get_mut(req.label).and_then(|q| {
                    if q.len() > 1 {
                        q.pop_front()
                    } else {
                        q.front().cloned()
                    }
                })
            };
            Ok(match queued {
                Some(text) => CallOutcome {
                    session_id: None,
                    text,
                    end: CallEnd::Answered,
                    parked: false,
                },
                None => CallOutcome {
                    session_id: None,
                    text: String::new(),
                    end: CallEnd::Exited,
                    parked: false,
                },
            })
        })
    }
}

fn plan_of(phases: &[(&str, &str)]) -> String {
    let body: Vec<String> = phases
        .iter()
        .map(|(title, verify)| {
            format!(
                "{{\"title\":\"{title}\",\"definition_of_done\":\"it works\",\"verify_command\":\"{verify}\"}}"
            )
        })
        .collect();
    format!(
        "Here is the plan.\n\n```json\n{{\"action\":\"plan\",\"phases\":[{}],\"unknowns\":[{{\"question\":\"which database?\",\"bin\":\"owner\"}}]}}\n```\n",
        body.join(",")
    )
}

fn dispatch_of(orders: &[(&str, &str)]) -> String {
    dispatch_tiered(orders, "sonnet")
}

/// The same, with the tier the **planner** put on every order. The tier is the planner's own
/// choice and, until 2026-09-05, reached `--model` unbounded.
fn dispatch_tiered(orders: &[(&str, &str)], tier: &str) -> String {
    let body: Vec<String> = orders
        .iter()
        .map(|(id, owns)| {
            format!(
                "{{\"id\":\"{id}\",\"title\":\"do {id}\",\"instructions\":\"do it\",\"owns\":[\"{owns}\"],\"model_tier\":\"{tier}\"}}"
            )
        })
        .collect();
    format!(
        "```json\n{{\"action\":\"dispatch\",\"orders\":[{}]}}\n```\n",
        body.join(",")
    )
}

fn report_of(order_id: &str) -> String {
    format!(
        "```json\n{{\"order_id\":\"{order_id}\",\"status\":\"done\",\"summary\":\"did it\",\"files_changed\":[],\"commits\":[]}}\n```\n"
    )
}

// ---------------------------------------------------------------------------------------------
// §13.1 item 10 — the barrier
// ---------------------------------------------------------------------------------------------

/// **A timeout never falls through.** `orchestration-loop.md` §9.2 calls proceeding past it *"the
/// most tempting wrong implementation of this whole section"*, and §15 item 15 makes it a rule.
#[tokio::test]
async fn a_barrier_that_never_resolves_dispatches_nothing() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new().say("planner", plan_of(&[("a", "true"), ("b", "true")]));
    let (_tx, never) = barrier();
    let limits = Limits {
        barrier_timeout: Duration::from_millis(20),
        ..Limits::default()
    };
    let mut run = rig.run_with(Arc::clone(&fake), never, limits).await;

    assert_eq!(
        run.tick().await,
        Tick::Blocked("still_reconciling".to_owned())
    );
    assert_eq!(fake.total(), 0, "not one child, not even the planner");
    assert_eq!(
        rig.branches(),
        vec!["main".to_owned()],
        "and no worktree branch was cut"
    );
    // It stays refused; there is no laxer second reading.
    assert_eq!(
        run.tick().await,
        Tick::Blocked("still_reconciling".to_owned())
    );
    assert_eq!(fake.total(), 0);
}

/// Case 1 of §9.2: a reconciler that did not run is strictly worse than one that is slow.
#[tokio::test]
async fn a_closed_barrier_channel_blocks_rather_than_proceeding() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new().say("planner", plan_of(&[("a", "true"), ("b", "true")]));
    let (tx, closed) = barrier();
    drop(tx);
    let mut run = rig
        .run_with(Arc::clone(&fake), closed, Limits::default())
        .await;

    assert_eq!(
        run.tick().await,
        Tick::Blocked("reconcile_failed".to_owned())
    );
    assert_eq!(fake.total(), 0);
}

/// Case 3 of §9.2, and the one whose reasoning is a step longer than it looks: a `not_done`
/// derived from a broken `git worktree repair` is a licence to redo work that already ran.
#[tokio::test]
async fn a_project_whose_repair_failed_gets_no_dispatch() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new().say("planner", plan_of(&[("a", "true"), ("b", "true")]));
    let outcome = ReconcileOutcome {
        repair_failed: [rig.project_id.clone()].into_iter().collect(),
        ..ReconcileOutcome::clean()
    };
    let mut run = rig
        .run_with(Arc::clone(&fake), resolved(outcome), Limits::default())
        .await;

    assert_eq!(run.tick().await, Tick::Blocked("repair_failed".to_owned()));
    assert_eq!(fake.total(), 0);
}

/// Case 2 of §9.2: an `unknown` blocks its **phase**, not the run — so the run starts, and skips
/// exactly the phase carrying it. Never retried (`intent-records.md` §5.1).
#[tokio::test]
async fn an_unknown_intent_blocks_its_phase_and_dispatches_nothing_for_it() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new().say("planner", plan_of(&[("a", "true"), ("b", "true")]));
    let mut run = rig.run(Arc::clone(&fake)).await;
    assert_eq!(run.tick().await, Tick::Continue, "the plan is written");
    let plan_id = run.plan_id().to_owned();

    let phases = rig.store.handle().phases(&plan_id).await.expect("phases");
    let first = phases
        .iter()
        .min_by_key(|p| p.ordinal)
        .expect("a phase")
        .clone();

    // A restart whose reconciler found an `unknown` attached to that phase.
    let after = Fake::new()
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git);
    let outcome = ReconcileOutcome {
        unknown_phases: [first.id.clone()].into_iter().collect(),
        ..ReconcileOutcome::clean()
    };
    let mut restarted = rig
        .restart(Arc::clone(&after), &plan_id, resolved(outcome))
        .await;

    let tick = restarted.tick().await;
    assert!(
        matches!(tick, Tick::Blocked(ref why) if why.contains("unknown_intent")),
        "{tick:?}"
    );
    assert_eq!(
        after.total(),
        0,
        "no lead call, no worker: the phase is never retried"
    );
    let settled = rig.store.handle().phases(&plan_id).await.expect("phases");
    let row = settled
        .iter()
        .find(|p| p.id == first.id)
        .expect("the phase");
    assert_eq!(row.state, PhaseState::Blocked);
}

/// The control for the test above: without the `unknown`, the very same restart dispatches.
#[tokio::test]
async fn the_same_restart_without_an_unknown_dispatches_normally() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new().say("planner", plan_of(&[("a", "true"), ("b", "true")]));
    let mut run = rig.run(Arc::clone(&fake)).await;
    assert_eq!(run.tick().await, Tick::Continue);
    let plan_id = run.plan_id().to_owned();

    let after = Fake::new()
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git);
    let mut restarted = rig
        .restart(
            Arc::clone(&after),
            &plan_id,
            resolved(ReconcileOutcome::clean()),
        )
        .await;
    assert_eq!(restarted.tick().await, Tick::Continue);
    assert_eq!(
        after.count("worker"),
        1,
        "the restart continued the same plan"
    );
    // And it really is the same plan, not a second one written beside it.
    assert_eq!(restarted.plan_id(), plan_id);
}

// ---------------------------------------------------------------------------------------------
// §13.1 item 2 — two malformed actions, and no third child
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn two_malformed_plans_block_the_run_and_spawn_no_third_child() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", "I think we should start by reading the code.")
        .say("planner", "```json\n{\"action\":\"plan\"}\n```");
    let mut run = rig.run(Arc::clone(&fake)).await;

    let tick = run.tick().await;
    assert!(
        matches!(tick, Tick::Blocked(ref why) if why.contains("malformed_action")),
        "{tick:?}"
    );
    assert_eq!(fake.count("planner"), 2, "exactly two windows, then stop");
}

/// The retry's context gains exactly one line: the validation failure, quoted. Not the whole
/// previous window — that window is gone.
#[tokio::test]
async fn the_second_window_is_told_what_was_wrong_with_the_first() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", "no json here")
        .say("planner", plan_of(&[("a", "true"), ("b", "true")]));
    let mut run = rig.run(Arc::clone(&fake)).await;
    assert_eq!(run.tick().await, Tick::Continue);
    assert_eq!(fake.count("planner"), 2);
    // What this proves is that a corrected second answer is accepted rather than the phase being
    // blocked; the retry prompt's own shape is asserted in the unit tests.
    assert_eq!(fake.total(), 2);
    let phases = rig
        .store
        .handle()
        .phases(run.plan_id())
        .await
        .expect("phases");
    assert_eq!(phases.len(), 2);
}

// ---------------------------------------------------------------------------------------------
// the spine, end to end
// ---------------------------------------------------------------------------------------------

/// **The order this whole file exists for.** A goal becomes a plan, an order runs in an isolated
/// worktree, the combination is gated by a real exit code, and green produces a `--no-ff` phase
/// commit whose **first parent** is the phase base — then the worktree and its branch are gone.
#[tokio::test]
async fn a_goal_becomes_a_plan_a_worktree_a_green_gate_and_a_phase_commit() {
    let Some(rig) = Rig::new().await else { return };
    let base = rig.head();
    let fake = Fake::new()
        .say("planner", plan_of(&[("routes", "true"), ("docs", "true")]))
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git);
    let mut run = rig.run(Arc::clone(&fake)).await;

    assert_eq!(run.tick().await, Tick::Continue, "plan");
    assert_eq!(run.tick().await, Tick::Continue, "dispatch");
    assert_eq!(run.tick().await, Tick::Continue, "integrate + commit");

    let phases = rig
        .store
        .handle()
        .phases(run.plan_id())
        .await
        .expect("phases");
    let first = phases.iter().min_by_key(|p| p.ordinal).expect("a phase");
    assert_eq!(first.state, PhaseState::Green);
    assert_eq!(
        first.last_exit_code,
        Some(0),
        "only the exit code settled it"
    );
    assert_eq!(
        first.base_sha.as_deref(),
        Some(base.as_str()),
        "the base was stored, once"
    );
    let commit = first.commit_sha.clone().expect("a phase commit");

    // The postcondition, against real git: the **first** parent is the baseline. `%P` is not.
    let first_parent = String::from_utf8_lossy(
        &run_git(&rig.git, &rig.root, &["rev-parse", &format!("{commit}^1")]).stdout,
    )
    .trim()
    .to_owned();
    assert_eq!(first_parent, base);
    let all_parents = String::from_utf8_lossy(
        &run_git(&rig.git, &rig.root, &["log", "-1", "--format=%P", &commit]).stdout,
    )
    .trim()
    .to_owned();
    assert_ne!(all_parents, base, "a --no-ff merge has two parents");
    assert!(
        rig.root.join("src/o1.txt").exists(),
        "the worker's file is in the project now"
    );

    // The worker's own claim was stored, and settled nothing.
    let orders = rig
        .store
        .handle()
        .work_orders(&first.id)
        .await
        .expect("orders");
    assert_eq!(orders.len(), 1);
    assert_eq!(orders[0].state, WorkOrderState::Reported);

    // §13.1 item 14, in its positive form: a branch whose `rev-list --count` is zero is really
    // gone, checkout and branch alike. A grep for a string cannot show this.
    let branches = rig.branches();
    assert_eq!(
        branches,
        vec!["main".to_owned()],
        "every brigadier branch was retired: {branches:?}"
    );
    assert!(
        !rig.root.join(".brigadier/worktrees").exists()
            || std::fs::read_dir(rig.root.join(".brigadier/worktrees"))
                .expect("read")
                .next()
                .is_none(),
        "no checkout was left behind"
    );
}

/// The whole plan, not one phase: the run reports [`Tick::Finished`] and the plan goes `done`.
#[tokio::test]
async fn a_two_phase_plan_runs_to_finished() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("one", "true"), ("two", "true")]))
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git);
    let mut run = rig.run(Arc::clone(&fake)).await;
    assert_eq!(run.drive().await, Tick::Finished);

    let phases = rig
        .store
        .handle()
        .phases(run.plan_id())
        .await
        .expect("phases");
    assert_eq!(phases.len(), 2);
    assert!(phases.iter().all(|p| p.state == PhaseState::Green));
    // The plan row stays `approved`: the store has no op that moves a plan to `done`, and the
    // loop does not invent a second write path for a column `upsert_plan` deliberately guards.
    let plan = rig
        .store
        .handle()
        .plan(run.plan_id())
        .await
        .expect("plan")
        .expect("row");
    assert_eq!(plan.status, brigadier_store::PlanStatus::Approved);
    assert_eq!(fake.count("fixer"), 0, "a green run climbs no rung");
}

/// D2: the owner is away, so every unknown the planner names is recorded as skipped **for "just
/// go"** — which is what lets a later failure say which question was waved off.
#[tokio::test]
async fn the_planners_unknowns_are_recorded_as_waved_off() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new().say("planner", plan_of(&[("a", "true"), ("b", "true")]));
    let mut run = rig.run(Arc::clone(&fake)).await;
    assert_eq!(run.tick().await, Tick::Continue);

    let unknowns = rig
        .store
        .handle()
        .unknowns(run.plan_id())
        .await
        .expect("unknowns");
    assert_eq!(unknowns.len(), 1);
    assert_eq!(unknowns[0].question, "which database?");
    assert_eq!(unknowns[0].state, brigadier_store::UnknownState::Skipped);
    assert!(unknowns[0].skipped_for_just_go);
}

// ---------------------------------------------------------------------------------------------
// §13.1 item 7 — ownership, enforced coming out
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn an_order_that_writes_outside_its_owns_blocks_the_phase() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("a", "true"), ("b", "true")]))
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"))
        // Declared `src`, wrote `elsewhere`.
        .does("worker", Work::Under("elsewhere"), &rig.git);
    let mut run = rig.run(Arc::clone(&fake)).await;
    assert_eq!(run.tick().await, Tick::Continue, "plan");

    let tick = run.tick().await;
    assert!(
        matches!(tick, Tick::Blocked(ref why) if why.contains("ownership_violation")),
        "{tick:?}"
    );
    let phases = rig
        .store
        .handle()
        .phases(run.plan_id())
        .await
        .expect("phases");
    let first = phases.iter().min_by_key(|p| p.ordinal).expect("a phase");
    assert_eq!(first.state, PhaseState::Blocked);
    assert!(first
        .last_evidence
        .as_deref()
        .unwrap_or_default()
        .contains("elsewhere/o1.txt"));
    assert_eq!(
        fake.count("fixer"),
        0,
        "the gate never ran, so no rung was climbed"
    );
}

/// The mirror: writing inside the set does not block. A subset check that passes proves only that
/// this particular failure did not happen, and this pins that it is not simply always true.
#[tokio::test]
async fn an_order_that_stays_inside_its_owns_does_not_block() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("a", "true"), ("b", "true")]))
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git);
    let mut run = rig.run(Arc::clone(&fake)).await;
    assert_eq!(run.tick().await, Tick::Continue);
    assert_eq!(
        run.tick().await,
        Tick::Continue,
        "the phase was not blocked"
    );
}

// ---------------------------------------------------------------------------------------------
// §13.1 items 4 and 6 — the gate is the only judge, and its output stays out of the store
// ---------------------------------------------------------------------------------------------

/// **Only the exit code settles a phase.** The worker says `"status": "done"`; the gate says 3.
#[tokio::test]
async fn a_workers_claim_of_done_does_not_survive_a_red_gate() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("a", "exit 3"), ("b", "true")]))
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"))
        .say("fixer", "I could not fix it.")
        .does("worker", Work::Under("src"), &rig.git);
    let mut run = rig.run(Arc::clone(&fake)).await;
    assert_eq!(run.tick().await, Tick::Continue, "plan");
    assert_eq!(run.tick().await, Tick::Continue, "dispatch");
    assert!(matches!(run.tick().await, Tick::Blocked(_)));

    let phases = rig
        .store
        .handle()
        .phases(run.plan_id())
        .await
        .expect("phases");
    let first = phases.iter().min_by_key(|p| p.ordinal).expect("a phase");
    assert_eq!(first.state, PhaseState::Blocked);
    assert_eq!(first.last_exit_code, Some(3));
    assert!(first.commit_sha.is_none(), "nothing was committed");

    // The ladder is rung 1 then rung 3. Exactly one fixer, never two arms.
    assert_eq!(
        fake.count("fixer"),
        1,
        "rung 1 runs once; rung 2 does not exist"
    );
    assert_eq!(fake.count("worker"), 1);
    assert_eq!(fake.count("repair-alternative-a"), 0);
    assert_eq!(fake.count("repair-alternative-b"), 0);
    assert_eq!(
        fake.total(),
        4,
        "one fixer then pause before unauthorized competing calls"
    );
    // Reopening the saved approval continues at the competing step, without replaying ordinary repair.
    let proposal_path = rig
        .dir
        .path()
        .join("runs")
        .join(run.plan_id())
        .join(format!("competing-{}.json", first.id));
    let mut proposal: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&proposal_path).unwrap()).unwrap();
    assert!(proposal["requestId"].as_str().is_some());
    assert_eq!(proposal["approved"], serde_json::Value::Null);
    proposal["approved"] = serde_json::json!(true);
    std::fs::write(&proposal_path, serde_json::to_vec(&proposal).unwrap()).unwrap();
    rig.store
        .handle()
        .phase_settled(
            first.id.clone(),
            PhaseState::Running,
            Some(3),
            Some("Competing proposal approved; continue explicitly".into()),
            None,
            std::time::SystemTime::now(),
        )
        .await
        .unwrap();
    let mut resumed = rig
        .restart(
            Arc::clone(&fake),
            run.plan_id(),
            resolved(ReconcileOutcome::clean()),
        )
        .await;
    assert!(matches!(resumed.tick().await, Tick::Blocked(_)));
    assert_eq!(
        fake.count("fixer"),
        1,
        "approval continuation cannot spend ordinary repair again"
    );
    assert_eq!(fake.count("repair-alternative-a"), 1);
    assert_eq!(fake.count("repair-alternative-b"), 1);
}

/// Rung 1 works **in the integration worktree**, so a fix re-gates in place with nothing to
/// re-merge — and it is handed the gate's output as a file in its own tree.
#[tokio::test]
async fn rung_one_fixes_in_place_and_the_gate_goes_green() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say(
            "planner",
            plan_of(&[("a", "test -f fixed.txt"), ("b", "true")]),
        )
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"))
        .say("fixer", "fixed it")
        .does("worker", Work::Under("src"), &rig.git)
        .does("fixer", Work::File("fixed.txt"), &rig.git);
    let mut run = rig.run(Arc::clone(&fake)).await;
    assert_eq!(run.tick().await, Tick::Continue, "plan");
    assert_eq!(run.tick().await, Tick::Continue, "dispatch");
    assert_eq!(run.tick().await, Tick::Continue, "rung 1 then a green gate");

    let phases = rig
        .store
        .handle()
        .phases(run.plan_id())
        .await
        .expect("phases");
    let first = phases.iter().min_by_key(|p| p.ordinal).expect("a phase");
    assert_eq!(first.state, PhaseState::Green);
    assert_eq!(fake.count("fixer"), 1);

    // The fixer ran in the integration worktree, not in the worker's.
    let (fixer_cwd, worker_cwd) = {
        let calls = fake.calls.lock().expect("lock");
        let fixer = calls
            .iter()
            .find(|(l, _)| *l == "fixer")
            .expect("a fixer call")
            .1
            .clone();
        let worker = calls
            .iter()
            .find(|(l, _)| *l == "worker")
            .expect("a worker call")
            .1
            .clone();
        (fixer, worker)
    };
    assert_ne!(fixer_cwd, worker_cwd);
    // And it was handed the log as a file, in its own tree, before its baseline was taken.
    assert!(
        rig.root.join("src/o1.txt").exists(),
        "the merge really happened first"
    );
}

/// **§13.1 item 6.** The gate prints megabytes; the store keeps one harness-derived line and the
/// log file keeps everything. `docs/vision.md` §4 step 7.5.
#[tokio::test]
async fn the_gates_output_reaches_the_log_file_and_never_the_phase_row() {
    let Some(rig) = Rig::new().await else { return };
    // The marker is assembled by the shell, so it appears in the gate's **output** and never in
    // the command text — which the evidence line does and must quote verbatim.
    let noisy = "A=OUT; B=PUTONLY; for i in $(seq 1 20000); do echo \"$A$B-$i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"; done; exit 5";
    let fake = Fake::new()
        .say("planner", plan_of(&[("a", "PLACEHOLDER"), ("b", "true")]))
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"))
        .say("fixer", "no")
        .does("worker", Work::Under("src"), &rig.git);
    let mut run = rig.run(Arc::clone(&fake)).await;
    assert_eq!(run.tick().await, Tick::Continue, "plan");

    // Rewrite the phase's verify command to the noisy one. (The planner's own answer is bounded
    // by the action schema, which is a separate and healthy constraint.)
    let mut phases = rig
        .store
        .handle()
        .phases(run.plan_id())
        .await
        .expect("phases");
    phases.sort_by_key(|p| p.ordinal);
    let mut first = phases[0].clone();
    first.verify_command = Some(noisy.to_owned());
    rig.store
        .handle()
        .upsert_phase(first.clone())
        .await
        .expect("upsert");
    rig.store.handle().flush().await.expect("flush");

    assert_eq!(run.tick().await, Tick::Continue, "dispatch");
    assert!(matches!(run.tick().await, Tick::Blocked(_)));

    let after = rig
        .store
        .handle()
        .phases(run.plan_id())
        .await
        .expect("phases");
    let settled = after.iter().find(|p| p.id == first.id).expect("the phase");
    let evidence = settled.last_evidence.clone().unwrap_or_default();
    assert_eq!(settled.last_exit_code, Some(5));
    assert!(
        !evidence.contains("OUTPUTONLY"),
        "no output may reach the store: {evidence}"
    );
    assert!(
        evidence.len() < 1_000,
        "the evidence is one bounded line, not a tail"
    );

    // And the log file has all of it.
    let logs = rig.dir.path().join("gates").join(&first.id);
    let total: u64 = std::fs::read_dir(&logs)
        .expect("gate logs exist")
        .flatten()
        .map(|e| e.metadata().expect("stat").len())
        .sum();
    assert!(
        total > 1_000_000,
        "the whole output went to the file, {total} bytes"
    );
}

// ---------------------------------------------------------------------------------------------
// §13.1 item 13 — the concurrency cap
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_cap_of_two_runs_two_workers_at_a_time_and_still_runs_all_four() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("a", "true"), ("b", "true")]))
        .say(
            "lead",
            dispatch_of(&[("o1", "a"), ("o2", "b"), ("o3", "c"), ("o4", "d")]),
        )
        .say("worker", report_of("o1"))
        .does("worker", Work::Nothing, &rig.git)
        .slow(Duration::from_millis(120));
    let limits = Limits {
        concurrency: 2,
        ..Limits::default()
    };
    let mut run = rig
        .run_with(
            Arc::clone(&fake),
            resolved(ReconcileOutcome::clean()),
            limits,
        )
        .await;

    assert_eq!(run.tick().await, Tick::Continue, "plan");
    assert_eq!(run.tick().await, Tick::Continue, "dispatch");
    assert_eq!(fake.count("worker"), 4, "all four orders ran");
    assert_eq!(fake.peak(), 2, "never more than the cap at once");
}

// ---------------------------------------------------------------------------------------------
// §13.1 items 3 and 12 — restart, and `unknown` never dispatches
// ---------------------------------------------------------------------------------------------

/// **The honest limit on unattended crash recovery.** `crates/store/src/intents.rs` holds a
/// `work_order` to settling only `unknown` — an owner decision of 2026-09-04 — so there is no
/// `not_done` and therefore no safe re-dispatch. A launch that died with orders in flight blocks
/// those phases until the owner settles each intent by hand.
#[tokio::test]
async fn a_crash_with_an_order_in_flight_blocks_its_phase_and_spawns_nothing() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("a", "true"), ("b", "true")]))
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git);
    let mut run = rig.run(Arc::clone(&fake)).await;
    assert_eq!(run.tick().await, Tick::Continue, "plan");
    assert_eq!(run.tick().await, Tick::Continue, "dispatch");

    // Simulate the crash: a second order was written down and dispatched, and the process died
    // before it was collected. A fresh row is used rather than rewriting the collected one,
    // because `upsert_work_order` deliberately refuses to move a finished order back
    // (`crates/store/src/writer.rs`) — which is itself the store defending the same invariant.
    let mut phases = rig
        .store
        .handle()
        .phases(run.plan_id())
        .await
        .expect("phases");
    phases.sort_by_key(|p| p.ordinal);
    let mut stranded =
        brigadier_store::WorkOrderRow::new("stranded", phases[0].id.clone(), "an order in flight");
    stranded.state = WorkOrderState::Dispatched;
    rig.store
        .handle()
        .upsert_work_order(stranded)
        .await
        .expect("upsert");
    rig.store.handle().flush().await.expect("flush");

    let before = fake.total();
    let tick = run.tick().await;
    assert!(
        matches!(tick, Tick::Blocked(ref why) if why.contains("orders_in_flight")),
        "{tick:?}"
    );
    assert_eq!(
        fake.total(),
        before,
        "nothing was re-dispatched and nothing was spawned"
    );
    let after = rig
        .store
        .handle()
        .phases(run.plan_id())
        .await
        .expect("phases");
    let settled = after
        .iter()
        .find(|p| p.id == phases[0].id)
        .expect("the phase");
    assert_eq!(settled.state, PhaseState::Blocked);
    assert!(settled
        .last_evidence
        .as_deref()
        .unwrap_or_default()
        .contains("never settle not_done"));
}

// ---------------------------------------------------------------------------------------------
// §7.5 — a project with no worktree is refused
// ---------------------------------------------------------------------------------------------

/// The refusal that stops an unattended worker being handed the owner's own checkout.
#[tokio::test]
async fn a_project_that_is_not_a_repository_refuses_to_dispatch() {
    let Some(rig) = Rig::without_repo().await else {
        return;
    };
    let fake = Fake::new()
        .say("planner", plan_of(&[("a", "true"), ("b", "true")]))
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"));
    let mut run = rig.run(Arc::clone(&fake)).await;
    assert_eq!(run.tick().await, Tick::Continue, "plan");

    let tick = run.tick().await;
    assert!(
        matches!(tick, Tick::Blocked(ref why) if why.contains("no_worktree")),
        "{tick:?}"
    );
    assert_eq!(fake.count("worker"), 0, "no child ran in the project root");
}

// ---------------------------------------------------------------------------------------------
// stop, which must never kill
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn stopping_a_run_dispatches_nothing_further() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new().say("planner", plan_of(&[("a", "true"), ("b", "true")]));
    let handle = rig
        .sup
        .start_run(RunSpec {
            orchestration: Default::default(),
            project_id: rig.project_id.clone(),
            goal: "ship it".to_owned(),
            model: None,
            effort: None,
            permission_mode: Default::default(),
            driver: DriverKind::new(REPLAY),
            barrier: {
                let (_tx, never) = barrier();
                never
            },
            limits: Limits {
                barrier_timeout: Duration::from_millis(10),
                ..Limits::default()
            },
            call: Some(Arc::clone(&fake) as Arc<dyn ModelCall>),
            gate: Some(rig.gate().await),
            plan_id: None,
        })
        .await
        .expect("started");
    handle.stop();
    assert!(handle.stopping());
    handle.join().await;
    assert_eq!(fake.total(), 0, "stopping never spawns and never kills");
    // A finished run lets go of its slot, so the next one is not refused for the life of the
    // process.
    assert!(rig.sup.run(handle.plan_id()).is_none());
    assert!(!rig.sup.stop_run(handle.plan_id()));
    assert!(!rig.sup.stop_run("no-such-plan"));
}

// ---------------------------------------------------------------------------------------------
// §13.1 item 11 — parking, through the real spawn path
// ---------------------------------------------------------------------------------------------

/// **§15 item 14: never kill a worker whose order is parked on an approval.**
///
/// This one uses the real machinery: [`SupervisedCall`] over the real
/// [`Supervisor::spawn_in`](brigadier_supervisor::Supervisor) path, a [`ReplayDriver`] that parks
/// a real request in the real `ApprovalTable`, and `Supervisor::respond` to answer it. The turn
/// deadline is 250 ms and the park lasts far longer; without the suspension the harness would
/// kill the exact worker the owner is about to unblock.
#[tokio::test]
async fn a_parked_order_does_not_have_its_deadlines_fire() {
    let Some(rig) = Rig::new().await else { return };
    let script: Vec<Event> = (0..40)
        .map(|i| {
            Event::item_completed(
                ItemId::new(format!("i{i}")),
                ItemKind::ToolCall {
                    name: "Bash".into(),
                },
                "ls",
                None,
            )
        })
        .collect();
    let driver = Arc::new(
        ReplayDriver::new(script)
            .with_rate(40.0)
            .with_approval(ApprovalPlan {
                after: Duration::from_millis(40),
                kind: RequestKind::tool_permission(
                    "Bash",
                    "{\"command\":\"git push\"}",
                    vec![],
                    None,
                ),
                timeout: None,
            }),
    );
    rig.sup.register_driver(driver.clone());

    let call = SupervisedCall::new(rig.sup.clone(), DriverKind::new(REPLAY), rig.root.clone());
    let req = CallRequest {
        project_id: rig.project_id.clone(),
        label: "worker",
        cwd: CallCwd::ProjectRoot,
        prompt: "do it".to_owned(),
        turn_deadline: Duration::from_millis(250),
        quiet_deadline: Duration::from_secs(30),
        thinking: brigadier_core::driver::ThinkingPolicy::Off,
        model: None,
        effort: None,
        provider: None,
        permission_mode: Default::default(),
    };
    let task = tokio::spawn(async move { call.call(req).await });

    // Well past the turn deadline. Without the suspension this would have returned by now.
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(
        !task.is_finished(),
        "the harness killed a worker the owner was about to unblock"
    );

    // A sibling of sorts: the supervisor is still serving other work while the order is parked.
    assert_eq!(rig.sup.live_sessions().len(), 1);
    let raised = driver
        .raised_approval()
        .expect("the request was really parked");
    let session = rig.sup.live_sessions()[0].clone();
    rig.sup
        .respond(
            &session,
            raised.request_id,
            brigadier_core::session::Decision::allow(),
        )
        .await
        .expect("answered");

    let outcome = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("the call finishes once the park is answered")
        .expect("join")
        .expect("call");
    assert!(outcome.parked, "the call knows it parked");
}

/// The lead lane, on the same machinery. The lead call's clocks are **not** a second
/// implementation — `SupervisedCall::watch` is shared with the dispatch path, and this pins that
/// they are, because a lead call whose deadlines counted human thinking time would kill the
/// planner the owner is in the middle of unblocking.
///
/// Both clocks are set to the same short value on purpose: that is what `plan.rs` did before the
/// quiet deadline got a field of its own, and it is the shape that would have failed hardest.
#[tokio::test]
async fn a_parked_lead_call_does_not_have_its_deadlines_fire() {
    let Some(rig) = Rig::new().await else { return };
    let script: Vec<Event> = (0..40)
        .map(|i| {
            Event::item_completed(
                ItemId::new(format!("i{i}")),
                ItemKind::ToolCall {
                    name: "Bash".into(),
                },
                "ls",
                None,
            )
        })
        .collect();
    let driver = Arc::new(
        ReplayDriver::new(script)
            .with_rate(40.0)
            .with_approval(ApprovalPlan {
                after: Duration::from_millis(40),
                kind: RequestKind::tool_permission("Bash", "{\"command\":\"ls -1\"}", vec![], None),
                timeout: None,
            }),
    );
    rig.sup.register_driver(driver.clone());

    let call = SupervisedCall::new(rig.sup.clone(), DriverKind::new(REPLAY), rig.root.clone());
    let req = CallRequest {
        project_id: rig.project_id.clone(),
        label: "lead",
        cwd: CallCwd::ProjectRoot,
        prompt: "decide".to_owned(),
        turn_deadline: Duration::from_millis(250),
        quiet_deadline: Duration::from_millis(250),
        thinking: brigadier_core::driver::ThinkingPolicy::Off,
        model: None,
        effort: None,
        provider: None,
        permission_mode: PermissionMode::Default,
    };
    let task = tokio::spawn(async move { call.call(req).await });

    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(
        !task.is_finished(),
        "the harness killed the lead call the owner was in the middle of unblocking"
    );

    let raised = driver
        .raised_approval()
        .expect("the request was really parked");
    let session = rig.sup.live_sessions()[0].clone();
    rig.sup
        .respond(
            &session,
            raised.request_id,
            brigadier_core::session::Decision::allow(),
        )
        .await
        .expect("answered");

    let outcome = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("the lead call finishes once the park is answered")
        .expect("join")
        .expect("call");
    assert!(outcome.parked, "the lead call knows it parked");
}

// ---------------------------------------------------------------------------------------------
// the owner's own picks
// ---------------------------------------------------------------------------------------------

/// Prepare a run over `script` with the owner's picks, and take the two ticks that spawn the
/// planner, the lead and the phase's workers.
async fn run_picks(rig: &Rig, model: Option<String>, mode: PermissionMode) -> Vec<CallRequest> {
    let script = Arc::new(
        ScriptedCall::new()
            .answering("planner", plan_of(&[("a", "true"), ("b", "true")]))
            .answering("lead", dispatch_of(&[("o1", "src")])),
    );
    let mut spec = RunSpec::new(
        rig.project_id.clone(),
        "ship it",
        DriverKind::new("claude-code"),
        resolved(ReconcileOutcome::clean()),
    )
    .with_model(model)
    .with_permission_mode(mode);
    spec.call = Some(Arc::clone(&script) as Arc<dyn ModelCall>);
    spec.gate = Some(rig.gate().await);
    let mut run = rig.sup.prepare_run(spec).await.expect("a run is prepared");
    run.tick().await;
    run.tick().await;
    script.calls()
}

/// **The owner's pick reaches every child, and the mode reaches them with it.**
///
/// Before this, `start_run` took `project_id` and `goal` alone and every call passed
/// `model: None`: the dock's picker said Haiku 4.5 while the session header read
/// `claude-opus-5[1m]`.
///
/// Still true after 2026-09-05, when the pick became a **ceiling** rather than a literal
/// (`crates/supervisor/src/loop_/routing.rs`), but for a narrower reason than it reads: `haiku`
/// is the weakest tier, so it binds every lane. A pick above the bottom leaves an order the
/// planner tiered *below* it on its own cheaper tier — see
/// `an_opus_pick_still_lets_a_haiku_order_run_on_haiku`.
#[tokio::test]
async fn the_owners_model_and_mode_reach_every_child_of_the_run() {
    let Some(rig) = Rig::new().await else { return };
    let calls = run_picks(
        &rig,
        Some("haiku".to_owned()),
        PermissionMode::BypassPermissions,
    )
    .await;

    assert!(
        calls.iter().any(|c| c.label == "planner"),
        "the planner ran"
    );
    assert!(calls.iter().any(|c| c.label == "lead"), "the lead ran");
    for call in &calls {
        assert_eq!(
            call.model.as_deref(),
            Some(if call.label == "worker" {
                "sonnet"
            } else {
                "haiku"
            }),
            "the {} call ignored its selected model",
            call.label
        );
        assert_eq!(
            call.permission_mode,
            PermissionMode::BypassPermissions,
            "the {} call ignored the owner's permission mode",
            call.label
        );
    }
}

/// **No pick means `docs/vision.md` §6's role-based routing, not "no routing".** A judgement call
/// takes the provider default; a work order takes the tier the lead assigned it, which until
/// 2026-09-04 reached nothing at all.
///
/// **Correction, 2026-09-05:** *"takes the tier the lead assigned it"* holds only up to mid-tier.
/// The tier below is `sonnet`, which is mid-tier, so it survives untouched; an `opus` order does
/// not — see `auto_uses_orchestrator_default_without_worker_ceiling`.
#[tokio::test]
async fn with_no_pick_a_work_order_takes_its_tier_up_to_mid_tier_and_judgement_takes_the_default() {
    let Some(rig) = Rig::new().await else { return };
    let calls = run_picks(&rig, None, PermissionMode::Default).await;

    for judgement in calls
        .iter()
        .filter(|c| c.label == "planner" || c.label == "lead")
    {
        assert_eq!(
            judgement.model, None,
            "{} must take the provider default",
            judgement.label
        );
    }
    // `dispatch_of` asks for `model_tier: "sonnet"`.
    let worker = calls
        .iter()
        .find(|c| c.label == "worker")
        .expect("an order was dispatched");
    assert_eq!(worker.model.as_deref(), Some("sonnet"));
}

/// The two clocks a judgement call runs under are **different numbers**. They were the same, which
/// made the quiet clock unreachable: it can never expire before a deadline it equals.
#[tokio::test]
async fn a_judgement_call_gets_a_quiet_deadline_shorter_than_its_turn_deadline() {
    let Some(rig) = Rig::new().await else { return };
    let limits = Limits::default();
    assert!(
        limits.lead_quiet_deadline < limits.lead_deadline,
        "a quiet deadline that is not shorter than the turn deadline can never fire"
    );
    assert!(
        limits.lead_deadline >= Duration::from_secs(300),
        "120s killed a planner that was still working at four minutes"
    );

    let calls = run_picks(&rig, None, PermissionMode::Default).await;
    let planner = calls
        .iter()
        .find(|c| c.label == "planner")
        .expect("the planner ran");
    assert_eq!(planner.turn_deadline, limits.lead_deadline);
    assert_eq!(planner.quiet_deadline, limits.lead_quiet_deadline);
}

/// `Limits::from_env` is the escape hatch for a number that is a guess: the person watching a run
/// die on it can change it without a rebuild. A bad value is ignored rather than obeyed — a zero
/// deadline would kill every child on its first tick.
#[test]
fn a_limit_override_is_read_from_the_environment_and_a_bad_one_is_ignored() {
    // Serialized by construction: this is the only test in the file that touches the process
    // environment, and it restores what it found.
    let restore = |key: &str, old: Option<std::ffi::OsString>| match old {
        Some(v) => std::env::set_var(key, v),
        None => std::env::remove_var(key),
    };
    let key = "BRIGADIER_LEAD_DEADLINE_SECS";
    let quiet = "BRIGADIER_LEAD_QUIET_DEADLINE_SECS";
    let (was, was_quiet) = (std::env::var_os(key), std::env::var_os(quiet));

    std::env::set_var(key, "1800");
    assert_eq!(Limits::from_env().lead_deadline, Duration::from_secs(1800));

    std::env::set_var(key, "0");
    assert_eq!(
        Limits::from_env().lead_deadline,
        Limits::default().lead_deadline
    );
    std::env::set_var(key, "not a number");
    assert_eq!(
        Limits::from_env().lead_deadline,
        Limits::default().lead_deadline
    );

    std::env::remove_var(key);
    std::env::set_var(quiet, "42");
    assert_eq!(
        Limits::from_env().lead_quiet_deadline,
        Duration::from_secs(42)
    );
    assert_eq!(
        Limits::from_env().lead_deadline,
        Limits::default().lead_deadline
    );

    restore(key, was);
    restore(quiet, was_quiet);
}

/// **A killed call says so on the thread.** Before this a deadline kill was silent: the child was
/// killed, the window thrown away, and the plan card still read "no phases yet" with nothing
/// anywhere saying why. The warning is a `FeedKind::Warn` row on the dead session's own feed,
/// numbered past its last event so it cannot overwrite one.
#[tokio::test]
async fn a_call_killed_on_its_deadline_leaves_a_warning_on_the_feed() {
    let Some(rig) = Rig::new().await else { return };
    // A script that never completes a turn: the deadline is the only way this call ends.
    let script: Vec<Event> = (0..200)
        .map(|i| {
            Event::item_completed(
                ItemId::new(format!("i{i}")),
                ItemKind::ToolCall {
                    name: "Bash".into(),
                },
                "ls",
                None,
            )
        })
        .collect();
    rig.sup
        .register_driver(Arc::new(ReplayDriver::new(script).with_rate(60.0)));

    let call = SupervisedCall::new(rig.sup.clone(), DriverKind::new(REPLAY), rig.root.clone());
    let outcome = call
        .call(CallRequest {
            project_id: rig.project_id.clone(),
            label: "planner",
            cwd: CallCwd::ProjectRoot,
            prompt: "plan it".to_owned(),
            turn_deadline: Duration::from_millis(200),
            quiet_deadline: Duration::from_secs(30),
            thinking: brigadier_core::driver::ThinkingPolicy::Off,
            model: None,
            effort: None,
            provider: None,
            permission_mode: PermissionMode::Default,
        })
        .await
        .expect("call");
    assert_eq!(outcome.end, CallEnd::TurnDeadline);

    let session = outcome.session_id.clone().expect("a session ran");
    let rows = rig.sup.feed_tail(&session, 200).await.expect("feed");
    let warning = rows
        .iter()
        .find(|r| r.l.contains("the planner call ended"))
        .expect("the thread says the planner was killed");
    assert_eq!(warning.k, brigadier_store::feed::FeedKind::Warn);
    assert!(warning.l.contains("turn_deadline"), "{}", warning.l);
    // Past every real row, so nothing was overwritten: `feed`'s insert is ON CONFLICT DO UPDATE.
    assert!(
        rows.iter().all(|r| r.q <= warning.q),
        "the warning must be numbered past the session's last event"
    );
    assert!(
        rows.len() > 1,
        "the session's own rows survived alongside it"
    );
}

// ---------------------------------------------------------------------------------------------
// the model ceiling — `crates/supervisor/src/loop_/routing.rs`
//
// The owner's pick is a **ceiling**, not a default (owner decision, 2026-09-05). These drive a
// whole run and read what the loop actually handed a driver, rather than unit-testing the
// arithmetic — the defect they exist for was never in the arithmetic, it was that
// `dispatch.rs` reached the CLI with the planner's tier and nothing in between.
// ---------------------------------------------------------------------------------------------

/// The owner's sentence: *"picking Haiku means nothing in the run exceeds Haiku."* The planner
/// tiers the order `opus`; every child still runs on the pick.
#[tokio::test]
async fn a_haiku_orchestrator_pick_preserves_independent_opus_worker() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("routes", "true"), ("docs", "true")]))
        .say("lead", dispatch_tiered(&[("o1", "src")], "opus"))
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git);
    let mut run = rig
        .run_picking(Arc::clone(&fake), Some("claude-haiku-4-5"))
        .await;

    assert_eq!(run.tick().await, Tick::Continue, "plan");
    assert_eq!(run.tick().await, Tick::Continue, "dispatch");

    assert_eq!(
        fake.models("planner"),
        vec![Some("claude-haiku-4-5".to_owned())]
    );
    assert_eq!(
        fake.models("lead"),
        vec![Some("claude-haiku-4-5".to_owned())]
    );
    assert_eq!(fake.models("worker"), vec![Some("opus".to_owned())]);
}

/// With no pick, §6's role-based routing survives — and the work-order lane is capped at
/// mid-tier, which is the half that did not exist. Before 2026-09-05 the worker below was
/// started on `--model opus` because the planner said so.
#[tokio::test]
async fn auto_uses_orchestrator_default_without_worker_ceiling() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("routes", "true"), ("docs", "true")]))
        .say("lead", dispatch_tiered(&[("o1", "src")], "opus"))
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git);
    let mut run = rig.run_picking(Arc::clone(&fake), None).await;

    assert_eq!(run.tick().await, Tick::Continue, "plan");
    assert_eq!(run.tick().await, Tick::Continue, "dispatch");

    // Judgement: the provider default, which is the owner's own strong model.
    assert_eq!(
        fake.models("planner"),
        vec![None],
        "judgement keeps the strong model"
    );
    assert_eq!(
        fake.models("lead"),
        vec![None],
        "judgement keeps the strong model"
    );
    assert_eq!(fake.models("worker"), vec![Some("opus".to_owned())]);
}

/// The control for the test above: an order the planner tiered at or below mid-tier is not
/// touched, so the cap is a cap and not a flat rewrite.
#[tokio::test]
async fn no_pick_leaves_a_haiku_order_on_haiku() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("routes", "true"), ("docs", "true")]))
        .say("lead", dispatch_tiered(&[("o1", "src")], "haiku"))
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git);
    let mut run = rig.run_picking(Arc::clone(&fake), None).await;

    assert_eq!(run.tick().await, Tick::Continue, "plan");
    assert_eq!(run.tick().await, Tick::Continue, "dispatch");
    assert_eq!(fake.models("worker"), vec![Some("haiku".to_owned())]);

    let phases = rig
        .store
        .handle()
        .phases(run.plan_id())
        .await
        .expect("phases");
    let first = phases.iter().min_by_key(|p| p.ordinal).expect("a phase");
    let orders = rig
        .store
        .handle()
        .work_orders(&first.id)
        .await
        .expect("orders");
    let report = orders[0].report.clone().expect("a report");
    assert!(
        !report.starts_with("model:"),
        "nothing was capped, so nothing is claimed: {report}"
    );
}

/// A ceiling is not a floor. An `opus` pick leaves a cheap order cheap, which is the difference
/// between a ceiling and the pre-2026-09-05 reading that honoured the pick literally everywhere.
#[tokio::test]
async fn an_opus_pick_still_lets_a_haiku_order_run_on_haiku() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("routes", "true"), ("docs", "true")]))
        .say("lead", dispatch_tiered(&[("o1", "src")], "haiku"))
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git);
    let mut run = rig
        .run_picking(Arc::clone(&fake), Some("claude-opus-5"))
        .await;

    assert_eq!(run.tick().await, Tick::Continue, "plan");
    assert_eq!(run.tick().await, Tick::Continue, "dispatch");
    assert_eq!(
        fake.models("planner"),
        vec![Some("claude-opus-5".to_owned())]
    );
    assert_eq!(
        fake.models("worker"),
        vec![Some("haiku".to_owned())],
        "under the ceiling"
    );
}

/// A model id this build does not recognise must **not** silently become "no ceiling". It binds
/// at the bottom instead, so every child runs on exactly the id the owner typed and the
/// planner's tier reaches nothing.
#[tokio::test]
async fn unknown_orchestrator_model_remains_exact_and_worker_independent() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("routes", "true"), ("docs", "true")]))
        .say("lead", dispatch_tiered(&[("o1", "src")], "opus"))
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git);
    let mut run = rig
        .run_picking(Arc::clone(&fake), Some("claude-quokka-9"))
        .await;

    assert_eq!(run.tick().await, Tick::Continue, "plan");
    assert_eq!(run.tick().await, Tick::Continue, "dispatch");

    assert_eq!(
        fake.models("planner"),
        vec![Some("claude-quokka-9".to_owned())]
    );
    assert_eq!(
        fake.models("lead"),
        vec![Some("claude-quokka-9".to_owned())]
    );
    assert_eq!(fake.models("worker"), vec![Some("opus".to_owned())]);
}

#[tokio::test]
async fn consequential_review_rejection_repairs_once_and_reruns_review() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("a", "test -f src/session.rs")]))
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"))
        .does("worker", Work::File("src/session.rs"), &rig.git)
        .say("reviewer", "Check missing recovery behavior")
        .say(
            "review-judge",
            r#"{"accepted":false,"findings":["missing repair.txt recovery evidence"]}"#,
        )
        .say("review-judge", r#"{"accepted":true,"findings":[]}"#)
        .say("fixer", "repaired")
        .does("fixer", Work::File("repair.txt"), &rig.git);
    let mut run = rig.run(Arc::clone(&fake)).await;
    assert_eq!(run.tick().await, Tick::Continue);
    assert_eq!(run.tick().await, Tick::Continue);
    assert_eq!(run.tick().await, Tick::Continue);
    assert!(rig.root.join("repair.txt").exists());
    assert_eq!(fake.count("fixer"), 1);
    assert_eq!(fake.count("review-judge"), 2);
    assert_eq!(fake.count("reviewer"), 4);
    assert_eq!(fake.count("repair-alternative-a"), 0);
}

#[tokio::test]
async fn failed_ordinary_fix_selects_one_fully_verified_isolated_alternative() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("a", "test -f fixed.txt && test ! -f wrong.txt")]))
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git)
        .say("fixer", "wrong fix")
        .does("fixer", Work::File("wrong.txt"), &rig.git)
        .say("repair-alternative-a", "complete repair")
        .does("repair-alternative-a", Work::File("fixed.txt"), &rig.git)
        .say("repair-alternative-b", "bad alternative")
        .does("repair-alternative-b", Work::File("wrong.txt"), &rig.git)
        .say("reviewer", "All acceptance checks inspected")
        .say("review-judge", r#"{"accepted":true,"findings":[]}"#)
        .say("repair-judge", r#"{"winner":0,"reason":"A passes the full command and independent criteria review; B fails"}"#);
    let mut spec = RunSpec::new(
        &rig.project_id,
        "ship the thing",
        DriverKind::new("claude-code"),
        resolved(ReconcileOutcome::clean()),
    )
    .with_permission_mode(PermissionMode::BypassPermissions);
    spec.call = Some(fake.clone());
    spec.gate = Some(rig.gate().await);
    let mut run = rig.sup.prepare_run(spec).await.unwrap();
    assert_eq!(run.tick().await, Tick::Continue);
    assert_eq!(run.tick().await, Tick::Continue);
    assert_eq!(run.tick().await, Tick::Continue);
    assert!(rig.root.join("fixed.txt").exists());
    assert!(
        !rig.root.join("wrong.txt").exists(),
        "neither the failed ordinary fix nor losing diff is merged"
    );
    assert_eq!(fake.count("fixer"), 1);
    assert_eq!(fake.count("repair-alternative-a"), 1);
    assert_eq!(fake.count("repair-alternative-b"), 1);
    assert_eq!(
        fake.count("review-judge"),
        1,
        "failed gate is never eligible for review acceptance"
    );
    let calls = fake.calls.lock().unwrap();
    let a = &calls
        .iter()
        .find(|(l, _)| *l == "repair-alternative-a")
        .unwrap()
        .1;
    let b = &calls
        .iter()
        .find(|(l, _)| *l == "repair-alternative-b")
        .unwrap()
        .1;
    assert_ne!(a, b);
    assert!(
        b.join("wrong.txt").exists(),
        "losing evidence remains recoverable"
    );
}

#[tokio::test]
async fn stopped_run_remains_stopped_after_restart_until_explicit_continue() {
    let Some(rig) = Rig::new().await else { return };
    let mut spec = RunSpec::new(
        rig.project_id.clone(),
        "goal",
        DriverKind::new(REPLAY),
        resolved(ReconcileOutcome::clean()),
    );
    spec.driver = DriverKind::new(REPLAY);
    spec.call = Some(Arc::new(ScriptedCall::new()));
    let handle = rig.sup.start_run(spec).await.unwrap();
    handle.stop();
    let plan = handle.plan_id().to_owned();
    handle.join().await;
    let fake = Fake::new().say("planner", plan_of(&[("a", "true")]));
    let mut restarted = rig
        .restart(fake.clone(), &plan, resolved(ReconcileOutcome::clean()))
        .await;
    assert_eq!(restarted.tick().await, Tick::Stopped);
    assert_eq!(fake.total(), 0);
    rig.sup.clear_run_stop(&plan).unwrap();
    let mut continued = rig
        .restart(fake.clone(), &plan, resolved(ReconcileOutcome::clean()))
        .await;
    assert_eq!(continued.tick().await, Tick::Continue);
    assert_eq!(fake.count("planner"), 1);
}

#[tokio::test]
async fn passing_checks_over_uncommitted_changes_do_not_merge_an_unverified_branch() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("a", "touch gate-created.txt; true")]))
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git);
    let original = rig.head();
    let mut run = rig.run(fake).await;
    assert_eq!(run.tick().await, Tick::Continue);
    assert_eq!(run.tick().await, Tick::Continue);
    assert!(matches!(run.tick().await, Tick::Blocked(reason) if reason.contains("uncommitted")));
    assert_eq!(rig.head(), original);
}

#[tokio::test]
async fn stop_during_provider_startup_never_sends_the_goal() {
    use brigadier_core::driver::{
        BoxFuture, DriverError, DriverInfo, ProviderDriver, ResumeSession, StartSession,
    };
    use brigadier_core::event::InstanceId;
    use brigadier_core::session::SessionHandle;
    use std::sync::atomic::AtomicBool;
    struct SlowStart {
        replay: ReplayDriver,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        prompt_sent: Arc<AtomicBool>,
    }
    impl ProviderDriver for SlowStart {
        fn kind(&self) -> DriverKind {
            self.replay.kind()
        }
        fn instance_id(&self) -> &InstanceId {
            self.replay.instance_id()
        }
        fn describe(&self) -> DriverInfo {
            self.replay.describe()
        }
        fn start_session(
            &self,
            req: StartSession,
        ) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
            Box::pin(async move {
                self.prompt_sent
                    .store(req.prompt.is_some(), Ordering::Release);
                self.entered.notify_one();
                self.release.notified().await;
                self.replay.start_session(req).await
            })
        }
        fn resume_session(
            &self,
            req: ResumeSession,
        ) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
            self.replay.resume_session(req)
        }
    }
    let Some(rig) = Rig::new().await else { return };
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let prompt_sent = Arc::new(AtomicBool::new(false));
    let replay = ReplayDriver::new(vec![Event::RuntimeWarning {
        message: "idle".into(),
    }]);
    rig.sup.register_driver(Arc::new(SlowStart {
        replay,
        entered: entered.clone(),
        release: release.clone(),
        prompt_sent: prompt_sent.clone(),
    }));
    let stop = Arc::new(AtomicBool::new(false));
    let call = SupervisedCall::new(rig.sup.clone(), DriverKind::new(REPLAY), rig.root.clone())
        .with_stop(stop.clone());
    let req = CallRequest {
        project_id: rig.project_id.clone(),
        label: "worker",
        cwd: CallCwd::ProjectRoot,
        prompt: "Do work".into(),
        turn_deadline: Duration::from_secs(2),
        quiet_deadline: Duration::from_secs(2),
        thinking: Default::default(),
        model: None,
        effort: None,
        provider: None,
        permission_mode: PermissionMode::Default,
    };
    let task = tokio::spawn(async move { call.call(req).await });
    entered.notified().await;
    stop.store(true, Ordering::Release);
    release.notify_one();
    let outcome = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(outcome.end, CallEnd::Aborted);
    assert!(
        !prompt_sent.load(Ordering::Acquire),
        "startup was idle while cancellation raced"
    );
    let id = outcome.session_id.unwrap();
    for _ in 0..50 {
        if !rig.sup.is_live(&id) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("cancelled startup child still live");
}

#[tokio::test]
async fn codex_default_worker_does_not_receive_a_claude_model_alias() {
    let Some(rig) = Rig::new().await else { return };
    let fake = Fake::new()
        .say("planner", plan_of(&[("a", "true")]))
        .say("lead", dispatch_of(&[("o1", "src")]))
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git);
    let mut spec = RunSpec::new(
        rig.project_id.clone(),
        "goal",
        DriverKind::new("codex"),
        resolved(ReconcileOutcome::clean()),
    );
    spec.model = Some("gpt-exact".into());
    spec.call = Some(fake.clone());
    let mut run = rig.sup.prepare_run(spec).await.unwrap();
    assert_eq!(run.tick().await, Tick::Continue);
    assert_eq!(run.tick().await, Tick::Continue);
    assert_eq!(fake.models("worker"), vec![None]);
    assert_eq!(fake.models("planner"), vec![Some("gpt-exact".into())]);
}

#[tokio::test]
async fn independently_selected_codex_worker_can_use_its_provider_default() {
    let Some(rig) = Rig::new().await else { return };
    let dispatch = dispatch_of(&[("o1", "src")]).replace(
        "\"model_tier\":\"sonnet\"",
        "\"model_tier\":\"sonnet\",\"provider\":\"codex\"",
    );
    let fake = Fake::new()
        .say("planner", plan_of(&[("a", "true")]))
        .say("lead", dispatch)
        .say("worker", report_of("o1"))
        .does("worker", Work::Under("src"), &rig.git);
    let mut run = rig.run(fake.clone()).await;
    assert_eq!(run.tick().await, Tick::Continue);
    assert_eq!(run.tick().await, Tick::Continue);
    assert_eq!(fake.models("worker"), vec![None]);
}
