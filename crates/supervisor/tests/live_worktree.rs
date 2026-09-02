//! One git worktree per session, end to end against a **live** `claude` child.
//!
//! Ignored by default: it spawns the real binary and spends the owner's money. Run it
//! deliberately, once:
//!
//! ```text
//! export PATH="$HOME/.cargo/bin:$PATH"
//! CLAUDE_BIN="$(command -v claude)" \
//!   cargo test -p brigadier-supervisor --test live_worktree -- --ignored --nocapture
//! ```
//!
//! What it proves, in one throwaway repository:
//!
//! 1. the child really runs in `<project>/.brigadier/worktrees/<id>` on `brigadier/<id>`, and the
//!    session row records both;
//! 2. the `info/exclude` rule holds — the main tree stays clean with a worktree nested inside it,
//!    which is the difference between that and a staged `160000` gitlink
//!    (`docs/research/worktree-git.md` §1);
//! 3. **`--resume` finds the transcript when `cwd` is a worktree.** §6 of the brief predicts a
//!    *different* transcript directory for the worktree path and notes the CLI has searched other
//!    projects since 2.1.223 — documented, never measured. This is the measurement;
//! 4. `cleanup_worktree` removes the checkout and leaves the branch.
//!
//! The `Live` harness, `wait_for` and the cost reporting are copied from
//! `crates/supervisor/tests/live_resume.rs` rather than shared: an integration test is its own
//! binary, and a shared helper module would couple two tests that spend money independently.
// see docs/research/worktree-git.md §1, §3, §6, §7 and "Measured 2026-09-02".

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use brigadier_core::claude::{ClaudeDriver, ClaudeDriverConfig, CLAUDE_CODE};
use brigadier_core::driver::{DriverKind, PermissionMode, StartSession};
use brigadier_core::event::{Envelope, Event, RequestKind, SessionId};
use brigadier_core::session::Decision;
use brigadier_store::Store;
use brigadier_supervisor::worktree::{BRANCH_PREFIX, EXCLUDE_PATTERN, WORKTREES_SUBDIR};
use brigadier_supervisor::{Supervisor, SupervisorConfig, VecSink};
use tempfile::TempDir;

/// Turn 1. Deliberately answerable with no tool at all, so no approval should ever open.
const FIRST_PROMPT: &str = "Reply with only the word OK.";

/// Turn 2, after the resume. Same shape, and it only completes if the child came back up.
const SECOND_PROMPT: &str = "Reply with only the word OK again.";

/// What an unexpected approval is answered with. No tool call is expected on either turn, so
/// anything that opens is a wrong-tool retry and is denied on sight rather than left parked —
/// the CLI has no prompt timeout, and an unanswered request wedges the turn for the full 600 s
/// park deadline. see docs/research/approvals.md §4 "Timeout".
const DENY_REASON: &str = "denied by brigadier worktree test";

/// The only model this test is allowed to spend on.
const MODEL: &str = "claude-haiku-4-5";

/// Ceiling on one live run, matching `live_resume.rs`.
const COST_CEILING_USD: f64 = 0.08;

const TURN_TIMEOUT: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(50);

/// A store, a supervisor over it, and every signal envelope seen so far.
struct Live {
    _data: TempDir,
    store: Store,
    sink: Arc<VecSink>,
    sup: Supervisor,
    seen: Vec<Envelope>,
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
        Live { _data: data, store, sink, sup, seen: Vec::new() }
    }

    fn drain(&mut self) {
        let fresh: Vec<Envelope> = self.sink.take().into_iter().flat_map(|b| b.signals).collect();
        self.seen.extend(fresh);
    }

    /// Poll until a signal matches, or fail with what was seen instead.
    ///
    /// Matches against everything seen so far, not only the new arrivals: `turn-started` can
    /// reach the sink before `session-started` does.
    // see docs/research/claude-direct-spike.md — ordering on the signal stream is not guaranteed.
    async fn wait_for(
        &mut self,
        what: &str,
        within: Duration,
        session_id: &SessionId,
        mut pred: impl FnMut(&Envelope) -> bool,
    ) -> Envelope {
        let deadline = Instant::now() + within;
        let mut next = 0usize;
        loop {
            self.drain();
            while next < self.seen.len() {
                let env = self.seen[next].clone();
                next += 1;
                if pred(&env) {
                    return env;
                }
                if let Event::RequestOpened { request_id, kind, .. } = &env.event {
                    eprintln!("  [auto-deny] unexpected request {request_id:?}: {kind:?}");
                    let _ = self
                        .sup
                        .respond(session_id, request_id.clone(), Decision::deny(DENY_REASON))
                        .await;
                }
            }
            assert!(
                Instant::now() < deadline,
                "timed out after {within:?} waiting for {what}; saw {}",
                self.seen.iter().map(|e| label(&e.event)).collect::<Vec<_>>().join(", ")
            );
            tokio::time::sleep(POLL).await;
        }
    }
}

fn label(event: &Event) -> String {
    match event {
        Event::SessionStarted { provider_session_id, .. } => {
            format!("session-started({provider_session_id})")
        }
        Event::SessionExited { reason, exit_code } => {
            format!("session-exited({reason:?}, {exit_code:?})")
        }
        Event::TurnStarted { .. } => "turn-started".into(),
        Event::TurnCompleted { stop_reason, .. } => format!("turn-completed({stop_reason:?})"),
        Event::TurnAborted { reason, .. } => format!("turn-aborted({reason:?})"),
        Event::RequestOpened { kind: RequestKind::ToolPermission { tool_name, .. }, .. } => {
            format!("request-opened(tool-permission:{tool_name})")
        }
        Event::RequestOpened { .. } => "request-opened".into(),
        Event::RequestResolved { decision, .. } => format!("request-resolved({decision:?})"),
        Event::RuntimeWarning { message } => format!("runtime-warning({message})"),
        Event::RuntimeError { message, .. } => format!("runtime-error({message})"),
        other => format!("{other:?}"),
    }
}

fn is_turn_completed(env: &Envelope) -> bool {
    matches!(env.event, Event::TurnCompleted { .. })
}

/// Synchronous git, for setup and for assertions the harness itself must not be trusted to make.
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

/// A throwaway git repository with one commit. **Never the brigadier checkout**: a real child
/// runs here, and the worktree this test creates is deleted with the directory.
fn project_repo() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path().join("project");
    std::fs::create_dir(&root).expect("mkdir project");
    git(&root, &["init", "-q", "-b", "main", "."]);
    std::fs::write(root.join("README.md"), "brigadier live worktree test\n").expect("write");
    git(&root, &["add", "README.md"]);
    git(&root, &["commit", "-qm", "init"]);
    (dir, root)
}

/// Start in a worktree, resume in the same worktree, then clean it up and keep the branch.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "spawns the real claude binary and spends money on a live account"]
async fn live_session_runs_in_a_worktree_resumes_there_and_cleans_up() {
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

    let mut config = ClaudeDriverConfig::new("claude-code:live-worktree");
    config.binary = Some(PathBuf::from(binary));
    // Pinned, not configurable: no other model may be billed by this test.
    config.default_model = Some(MODEL.to_owned());
    let driver = ClaudeDriver::probe(config).await.expect("claude probes");
    eprintln!("claude {} at {}", driver.version(), driver.binary().display());

    let mut live = Live::new();
    live.sup.register_driver(Arc::new(driver));

    // ---- project add writes the exclude rule, once -------------------------------------------
    let project = live.sup.add_project(root.clone()).await.expect("project added");
    let exclude = std::fs::read_to_string(root.join(".git").join("info").join("exclude"))
        .expect("info/exclude");
    assert!(
        exclude.lines().any(|l| l.trim() == EXCLUDE_PATTERN),
        "info/exclude does not carry {EXCLUDE_PATTERN}: {exclude:?}"
    );

    // ---- the first child ----------------------------------------------------------------------
    let mut req = StartSession::new(root.clone());
    req.prompt = Some(FIRST_PROMPT.to_owned());
    req.model = Some(MODEL.to_owned());
    req.permission_mode = PermissionMode::Default;
    let session_id = live
        .sup
        .start_session(&project.id, &DriverKind::new(CLAUDE_CODE), req)
        .await
        .expect("session starts");
    eprintln!("session {}", session_id.as_str());

    live.store.handle().flush().await.expect("store flushed");
    let started = live.sup.session(&session_id).await.expect("read").expect("row");
    let worktree_path = started.worktree_path.clone().expect("the row records a worktree");
    let branch = started.branch.clone().expect("the row records a branch");
    eprintln!("worktree {} on {branch}", worktree_path.display());

    assert_eq!(started.cwd.as_deref(), Some(worktree_path.as_path()), "cwd is the worktree");
    let id = branch.strip_prefix(BRANCH_PREFIX).expect("branch is namespaced").to_owned();
    assert_eq!(id.len(), 8, "short id is eight characters: {id}");
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    assert_eq!(
        canon(&worktree_path),
        canon(&root.join(WORKTREES_SUBDIR).join(&id)),
        "worktree is not <root>/{WORKTREES_SUBDIR}/{id}"
    );
    assert!(worktree_path.join("README.md").is_file(), "the worktree is checked out at HEAD");
    let listed = git(&root, &["branch", "--list", &branch]);
    assert!(listed.contains(&branch), "git does not list {branch}: {listed:?}");

    // The exclude rule under load: a worktree nested in the main tree, and the main tree clean.
    let status = git(&root, &["status", "--porcelain"]);
    assert!(status.trim().is_empty(), "the main tree is dirty: {status:?}");

    live.wait_for("turn 1 to complete", TURN_TIMEOUT, &session_id, is_turn_completed).await;
    live.sup.end_session(&session_id).await.expect("end_session");
    live.wait_for("the first child to exit", TURN_TIMEOUT, &session_id, |e| {
        matches!(e.event, Event::SessionExited { .. })
    })
    .await;
    live.store.handle().flush().await.expect("store flushed");

    let ended = live.sup.session(&session_id).await.expect("read").expect("row");
    let old_seq = ended.last_event_seq;
    assert!(old_seq > 0, "the first child must have written feed rows");
    assert!(
        ended.resume_token.is_some(),
        "the first child never named its provider session, so the resume cannot be measured"
    );

    // ---- the measurement: does --resume find a transcript keyed on a worktree cwd? ------------
    //
    // §6 of the brief: the project key is `cwd.replace(/[^a-zA-Z0-9]/g, "-")`, so the worktree
    // gets its own transcript directory. Whether the CLI finds it on resume is the open question.
    let resumed = live.sup.resume_session(&session_id).await.expect("resume_session");
    assert_eq!(resumed, session_id, "the harness row is reused, never re-minted");
    live.store.handle().flush().await.expect("store flushed");
    let running = live.sup.session(&session_id).await.expect("read").expect("row");
    assert_eq!(
        running.cwd.as_deref(),
        Some(worktree_path.as_path()),
        "the resumed child must run in the same worktree"
    );
    assert_eq!(running.worktree_path.as_deref(), Some(worktree_path.as_path()));
    assert_eq!(running.branch, Some(branch.clone()));

    // The turn comes *before* the wait: `system/init` fires once per turn, not once per process,
    // so a resumed child that has been asked nothing never announces itself.
    // see docs/research/resume.md §5.
    live.sup.send_turn(&session_id, SECOND_PROMPT).await.expect("second turn queued");
    live.wait_for("the resumed turn to complete", TURN_TIMEOUT, &session_id, |e| {
        is_turn_completed(e) && e.seq > old_seq
    })
    .await;
    eprintln!("RESUME FROM A WORKTREE CWD: worked (a turn completed on the resumed child)");

    live.sup.end_session(&session_id).await.expect("end_session");
    live.wait_for("the resumed child to exit", TURN_TIMEOUT, &session_id, |e| {
        matches!(e.event, Event::SessionExited { .. }) && e.seq > old_seq
    })
    .await;
    live.store.handle().flush().await.expect("store flushed");

    // ---- cleanup: the checkout goes, the branch stays -----------------------------------------
    // The same view `cleanup_worktree` counts through, so a refusal here explains itself: the
    // unforced remove would delete ignored files too, and this is what the count sees.
    // see docs/research/worktree-git.md "Review round 2".
    let dirty = git(
        &worktree_path,
        &["status", "--porcelain", "--ignored=matching", "--untracked-files=all"],
    );
    eprintln!("worktree status before cleanup (ignored included): {dirty:?}");
    let cleaned = live.sup.cleanup_worktree(&session_id, false).await.expect("cleanup_worktree");
    eprintln!("cleanup: {cleaned:?}");
    // `blocked` says which rung refused, and `Commits` is the one to expect if this script ever
    // grows a prompt that makes the model commit: an unforced cleanup now refuses commits that no
    // other ref holds, not just working-tree dirt.
    // see docs/research/worktree-cleanup.md §2.6 rung 1.
    assert!(
        cleaned.removed,
        "a clean worktree with no commits of its own must be removable without force: {cleaned:?}"
    );
    assert_eq!(cleaned.commits, 0, "the session committed nothing: {cleaned:?}");
    assert_eq!(cleaned.branch, branch);
    assert!(!worktree_path.exists(), "the checkout is still on disk");
    let listed = git(&root, &["branch", "--list", &branch]);
    assert!(listed.contains(&branch), "cleanup deleted the branch: {listed:?}");

    // ---- account for it -----------------------------------------------------------------------
    let row = live.sup.session(&session_id).await.expect("read").expect("row");
    eprintln!(
        "cost_usd_cumulative={:.6} usage={:?} status={:?} last_event_seq={}",
        row.cost_usd_cumulative, row.usage, row.status, row.last_event_seq
    );
    eprintln!(
        "signals: {}",
        live.seen.iter().map(|e| label(&e.event)).collect::<Vec<_>>().join(", ")
    );
    assert!(row.cost_usd_cumulative > 0.0, "a live turn must have cost something");
    assert!(
        row.cost_usd_cumulative < COST_CEILING_USD,
        "run cost ${:.6}, over the ${COST_CEILING_USD} cap",
        row.cost_usd_cumulative
    );
}
