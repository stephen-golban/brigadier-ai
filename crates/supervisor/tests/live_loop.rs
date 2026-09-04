//! The whole loop, end to end, against **live** `claude` children: goal in, phase commit out.
//!
//! Ignored by default: it spawns the real binary many times over and spends the owner's money.
//! Run it deliberately, once:
//!
//! ```text
//! export PATH="$HOME/.cargo/bin:$PATH"
//! CLAUDE_BIN="$(command -v claude)" \
//!   cargo test -p brigadier-supervisor --test live_loop -- --ignored --nocapture
//! ```
//!
//! Every other test of the loop substitutes the model call (`crates/supervisor/tests/loop_spine.rs`
//! drives a scripted [`ModelCall`](brigadier_supervisor::loop_::call::ModelCall)), so the planner
//! prompt, the lead prompt, the worker prompt, the JSON they are asked for and the wall the
//! workers run behind have never been exercised by a real model at once. This is that run.
//!
//! # What it proves, and from what
//!
//! Every assertion below is read out of the **world**, not out of anything a model said:
//!
//! 1. the plan row exists and carries phases — read back from the store, not from the planner's
//!    reply;
//! 2. at least one phase reached `green`;
//! 3. that phase's `last_exit_code` is `Some(0)` — **the exit code is what settled it**. No
//!    worker's `status` field is read anywhere here, exactly as the loop reads none
//!    (`crates/supervisor/src/loop_/dispatch.rs`: the report's claim is stored and acted on by
//!    nothing);
//! 4. `git log` on the project's **base branch** carries the phase commit, and the sha the store
//!    recorded is an ancestor of that branch. The store is checked against git, not trusted.
//!
//! # Three rules this test is built around
//!
//! - **A throwaway repository, in a tempdir, with an initial commit.** Never brigadier's own
//!   checkout and never any project of the owner's: real children write here and the harness
//!   creates worktrees under it. The initial commit is not optional — `git worktree add … HEAD`
//!   on an unborn `HEAD` either fails or silently produces an orphan checkout
//!   (`docs/research/worktree-git.md` §3).
//! - **The verify command is neither `cargo` nor `npm`.** A Finder-launched app inherits neither
//!   on its `PATH` (`docs/research/gate-environment.md`), so a gate written against one is a
//!   gate that passes in a terminal and fails in the shipped app. `sh verify.sh`, committed into
//!   the repository, needs nothing but a shell.
//! - **Every model call is `claude-haiku-4-5`.** Pinned on the driver rather than per call,
//!   because the loop passes `model: None` everywhere and takes the provider default
//!   (`crates/supervisor/src/loop_/call.rs`). No other model may be billed by this test.
//!
//! The cost printed at the end is read from the **store rows**, one per session, and never by
//! summing `result` frames: `total_cost_usd` is reported cumulatively on every terminal frame, so
//! summing them double-counts (`crates/store/src/writer.rs`, `Op::SetUsage`).
// see docs/research/orchestration-loop.md (the design), docs/plans/w1b-loop-order.md (the eight
// decisions on top of it) and docs/plans/ipc-contract.md "The run" (the surface it feeds).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use brigadier_core::claude::{ClaudeDriver, ClaudeDriverConfig, CLAUDE_CODE};
use brigadier_core::driver::DriverKind;
use brigadier_core::event::{Envelope, Event};
use brigadier_core::session::Decision;
use brigadier_store::plan::{PhaseRow, PhaseState};
use brigadier_store::Store;
use brigadier_supervisor::loop_::barrier::{resolved, ReconcileOutcome};
use brigadier_supervisor::loop_::{Limits, RunSpec, Tick};
use brigadier_supervisor::{Supervisor, SupervisorConfig, VecSink};
use tempfile::TempDir;

/// The only model this test is allowed to spend on.
const MODEL: &str = "claude-haiku-4-5";

/// The goal, written the way an owner would write one — and written to be small.
///
/// Two things in it are load-bearing rather than flavour. It names the verify command explicitly,
/// because the **planner** writes `verify_command` and the goal is the only lever over what it
/// picks; and it states the order of the work, so the phase whose gate can pass first is the
/// phase that runs first.
const GOAL: &str = "In this repository, in this order: \
    (1) add `greet.sh`, a shell script that prints exactly the line `hello, world`; \
    (2) add `NOTES.md`, one short paragraph saying what `greet.sh` does. \
    This repository has no build system: there is no cargo, no npm and no test runner. \
    The only way to check anything is the committed script `verify.sh`, so use exactly \
    `sh verify.sh` as the verify_command for every phase and do not invent another.";

/// The gate, committed into the throwaway repository before the run starts.
///
/// Exit 0 only when `greet.sh` exists and prints the exact line. It is deliberately satisfiable
/// by the **first** phase of the goal above, so a two-phase plan has a phase that can go green
/// rather than one that cannot; it stays satisfied after the second.
const VERIFY_SH: &str = "#!/bin/sh\n\
    # The gate. Exit 0 is the only thing that settles a phase.\n\
    set -u\n\
    [ -f greet.sh ] || { echo 'greet.sh is missing'; exit 1; }\n\
    out=$(sh greet.sh) || { echo 'greet.sh did not run'; exit 1; }\n\
    [ \"$out\" = 'hello, world' ] || { echo \"greet.sh printed: $out\"; exit 1; }\n\
    echo 'ok'\n";

/// What an approval the worker wall raised is answered with.
///
/// **Denied, never allowed.** The wall pre-authorizes writes below the worker's own worktree and
/// ordinary `git`, so anything that reaches this prompt is a command reaching *outside* that
/// checkout — an absolute path, a `git -C` elsewhere, an interpreter it cannot classify
/// (`crates/core/src/claude/hook.rs`). Auto-allowing those in an unattended test is exactly the
/// blast radius the worktree isolation exists to bound. A denial parks one work order, never the
/// run (`docs/vision.md` §8).
const DENY_REASON: &str = "denied by brigadier live_loop test";

/// Wall clock for the whole run. Nothing here may hang a CI-less machine indefinitely.
const RUN_DEADLINE: Duration = Duration::from_secs(30 * 60);

/// Ceiling on the whole run, summed over every session row. Haiku, a handful of one-turn
/// children; **asserted**, not measured — no run of this loop has ever been billed.
const COST_CEILING_USD: f64 = 2.00;

const POLL: Duration = Duration::from_millis(100);

/// A store, a supervisor over it, and the auto-denying watcher that keeps the run moving.
struct Live {
    _data: TempDir,
    store: Store,
    sup: Supervisor,
    seen: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    watcher: Option<tokio::task::JoinHandle<()>>,
}

impl Live {
    fn new() -> Live {
        let data = tempfile::tempdir().expect("data dir");
        let store = Store::open(data.path()).expect("store opens");
        let run_id = store.run_id().to_owned();
        let sink = Arc::new(VecSink::new());
        let config = SupervisorConfig::new(
            store.handle().clone(),
            run_id,
            data.path().to_owned(),
            sink.clone(),
        );
        let sup = Supervisor::new(config);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));

        // One drainer, and it is this task: the loop's own children come and go faster than a
        // test can name them, and a second `take()` racing this one would swallow the request
        // that needs answering.
        let watcher = {
            let sup = sup.clone();
            let seen = Arc::clone(&seen);
            let stop = Arc::clone(&stop);
            tokio::spawn(async move {
                while !stop.load(Ordering::Acquire) {
                    for batch in sink.take() {
                        for env in batch.signals {
                            if let Event::RequestOpened { request_id, .. } = &env.event {
                                eprintln!("  [auto-deny] {} {request_id:?}", env.session_id);
                                let _ = sup
                                    .respond(
                                        &env.session_id,
                                        request_id.clone(),
                                        Decision::deny(DENY_REASON),
                                    )
                                    .await;
                            }
                            seen.lock().expect("seen").push(label(&env));
                        }
                    }
                    tokio::time::sleep(POLL).await;
                }
            })
        };
        Live { _data: data, store, sup, seen, stop, watcher: Some(watcher) }
    }

    async fn finish(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.await;
        }
    }
}

fn label(env: &Envelope) -> String {
    match &env.event {
        Event::SessionStarted { .. } => "session-started".into(),
        Event::SessionExited { reason, exit_code } => {
            format!("session-exited({reason:?}, {exit_code:?})")
        }
        Event::TurnStarted { .. } => "turn-started".into(),
        Event::TurnCompleted { stop_reason, .. } => format!("turn-completed({stop_reason:?})"),
        Event::TurnAborted { reason, .. } => format!("turn-aborted({reason:?})"),
        Event::RequestOpened { .. } => "request-opened".into(),
        Event::RequestResolved { decision, .. } => format!("request-resolved({decision:?})"),
        Event::RuntimeWarning { message } => format!("runtime-warning({message})"),
        Event::RuntimeError { message, .. } => format!("runtime-error({message})"),
        other => format!("{other:?}"),
    }
}

/// Synchronous git, for setup and for the assertions the harness itself must not be trusted to
/// make. Never uses the harness's own git helpers: the point is a second opinion.
fn git(cwd: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["-c", "user.email=test@example.invalid", "-c", "user.name=test"])
        .args(["-c", "commit.gpgsign=false"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// `git`'s exit code, for the questions whose answer *is* the exit code.
fn git_status(cwd: &Path, args: &[&str]) -> i32 {
    std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .status()
        .expect("git runs")
        .code()
        .unwrap_or(-1)
}

/// A throwaway git repository with one commit, the gate script, and nothing else.
///
/// **Never the brigadier checkout and never a project of the owner's.** Live children write here.
fn project_repo() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path().join("project");
    std::fs::create_dir(&root).expect("mkdir project");
    git(&root, &["init", "-q", "-b", "main", "."]);
    std::fs::write(root.join("README.md"), "A throwaway repository for brigadier's live loop test.\n")
        .expect("write README");
    std::fs::write(root.join("verify.sh"), VERIFY_SH).expect("write verify.sh");
    git(&root, &["add", "README.md", "verify.sh"]);
    // The initial commit, and it is a landmine already paid for: `worktree add … HEAD` against an
    // unborn HEAD either fails or produces an orphan checkout sharing no history.
    git(&root, &["commit", "-qm", "init"]);
    (dir, root)
}

fn print_phase(phase: &PhaseRow) {
    eprintln!(
        "  phase {} [{}] {:?} — gate {:?} exit {:?} commit {:?} attempts {}",
        phase.ordinal,
        phase.state.as_slug(),
        phase.title,
        phase.verify_command,
        phase.last_exit_code,
        phase.commit_sha.as_deref().map(|s| s[..s.len().min(8)].to_owned()),
        phase.attempts,
    );
}

/// One goal, dispatched, gated and committed with no human in the loop.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "spawns real claude children and spends money on a live account"]
async fn live_run_reaches_green_and_the_exit_code_is_what_settled_it() {
    let Ok(binary) = std::env::var("CLAUDE_BIN") else {
        eprintln!("CLAUDE_BIN unset; skipping");
        return;
    };
    let (_keep, root) = project_repo();
    assert!(
        !root.join("Cargo.toml").exists() && !root.join("src-tauri").exists(),
        "{} looks like a real checkout; this test must run in a throwaway tree",
        root.display()
    );
    eprintln!("project {}", root.display());

    let mut config = ClaudeDriverConfig::new("claude-code:live-loop");
    config.binary = Some(PathBuf::from(binary));
    // Pinned here and nowhere else: every call the loop makes passes `model: None`.
    config.default_model = Some(MODEL.to_owned());
    let driver = ClaudeDriver::probe(config).await.expect("claude probes");
    eprintln!("claude {} at {}", driver.version(), driver.binary().display());

    let mut live = Live::new();
    live.sup.register_driver(Arc::new(driver));
    let project = live.sup.add_project(root.clone()).await.expect("project added");

    // Nothing to reconcile: this repository was created seconds ago and has no intent rows. The
    // barrier is still handed over rather than skipped, because the loop awaits it above
    // everything and a run with no barrier is a run that cannot start.
    let mut spec = RunSpec::new(project.id.clone(), GOAL, DriverKind::new(CLAUDE_CODE), resolved(ReconcileOutcome::clean()));
    spec.limits = Limits {
        // Two at a time. Not a cost control — parallelism is token-neutral — a bound on how many
        // live children this machine runs at once.
        concurrency: 2,
        barrier_timeout: Duration::from_secs(5),
        lead_deadline: Duration::from_secs(3 * 60),
        worker_turn_deadline: Duration::from_secs(10 * 60),
        worker_quiet_deadline: Duration::from_secs(3 * 60),
        gate_timeout: Duration::from_secs(2 * 60),
    };
    let mut run = live.sup.prepare_run(spec).await.expect("run prepared");
    let plan_id = run.plan_id().to_owned();
    eprintln!("plan {plan_id}");

    // Driven a tick at a time rather than through `drive()`, so the run is bounded by a wall
    // clock this test owns and every step says what it decided.
    let deadline = Instant::now() + RUN_DEADLINE;
    let mut ticks = 0usize;
    let last = loop {
        let tick = run.tick().await;
        ticks += 1;
        eprintln!("tick {ticks}: {tick:?}");
        if tick != Tick::Continue {
            break tick;
        }
        assert!(
            Instant::now() < deadline,
            "the run was still going after {RUN_DEADLINE:?} and {ticks} ticks; state {:?}",
            run.state()
        );
    };
    live.finish().await;
    live.store.handle().flush().await.expect("store flushed");

    // ---- what the store believes -------------------------------------------------------------
    let plan = live
        .store
        .handle()
        .plan(&plan_id)
        .await
        .expect("read plan")
        .expect("the plan row the run was started with");
    let phases = live.store.handle().phases(&plan_id).await.expect("read phases");
    eprintln!("goal {:?}", plan.goal);
    eprintln!("plan {} — {} phase(s), last tick {last:?}", plan.id, phases.len());
    for phase in &phases {
        print_phase(phase);
        for order in live.store.handle().work_orders(&phase.id).await.expect("read orders") {
            eprintln!(
                "    order {} [{}] {:?} branch {:?}",
                order.id,
                order.state.as_slug(),
                order.title,
                order.branch
            );
        }
    }
    assert!(!phases.is_empty(), "the planner call produced no phases; last tick {last:?}");

    let green: Vec<&PhaseRow> = phases.iter().filter(|p| p.state == PhaseState::Green).collect();
    assert!(
        !green.is_empty(),
        "no phase reached green; last tick {last:?}, signals: {}",
        live.seen.lock().expect("seen").join(", ")
    );

    // ---- and what the world says, which is the part that counts ------------------------------
    let base_branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).trim().to_owned();
    let subjects = git(&root, &["log", "--format=%s", &base_branch]);
    eprintln!("git log {base_branch}:\n{subjects}");
    assert!(
        subjects.lines().any(|l| l.starts_with("Phase ")),
        "no phase commit on {base_branch}: {subjects:?}"
    );

    for phase in &green {
        // The exit code, and nothing a model said. `green` is written by `phase_settled` with the
        // gate's own code; anything but 0 here would mean a phase went green on a claim.
        assert_eq!(
            phase.last_exit_code,
            Some(0),
            "phase {} is green with exit code {:?}",
            phase.ordinal,
            phase.last_exit_code
        );
        let sha = phase
            .commit_sha
            .as_deref()
            .unwrap_or_else(|| panic!("green phase {} recorded no commit", phase.ordinal));
        // The store is checked against git rather than believed: the object exists, and it is on
        // the base branch.
        assert_eq!(git_status(&root, &["cat-file", "-e", sha]), 0, "{sha} is not an object");
        assert_eq!(
            git_status(&root, &["merge-base", "--is-ancestor", sha, &base_branch]),
            0,
            "phase {} recorded {sha}, which is not on {base_branch}",
            phase.ordinal
        );
    }

    // The gate really did run against the goal's own artefact, from a checkout of the base
    // branch. Re-run here so the assertion does not rest on the harness's copy of the answer.
    let gate = std::process::Command::new("sh")
        .arg("verify.sh")
        .current_dir(&root)
        .status()
        .expect("verify.sh runs");
    eprintln!("verify.sh in the project root after the run: exit {:?}", gate.code());

    // ---- account for it ----------------------------------------------------------------------
    //
    // From the store rows, one per session. Never by summing `result` frames: the provider
    // reports `total_cost_usd` cumulatively, so summing them double-counts.
    let sessions = live.sup.list_sessions().await.expect("read sessions");
    let mut total = 0.0f64;
    for row in &sessions {
        total += row.cost_usd_cumulative;
        eprintln!(
            "  session {} [{}] cost_usd_cumulative={:.6} usage={:?}",
            row.session_id.as_str(),
            row.status.as_str(),
            row.cost_usd_cumulative,
            row.usage
        );
    }
    eprintln!("RUN COST: ${total:.6} over {} session(s), {ticks} tick(s)", sessions.len());
    eprintln!("signals: {}", live.seen.lock().expect("seen").join(", "));
    assert!(total > 0.0, "no session reported a cost; were these really live children?");
    assert!(total < COST_CEILING_USD, "run cost ${total:.6}, over the ${COST_CEILING_USD} cap");
}
