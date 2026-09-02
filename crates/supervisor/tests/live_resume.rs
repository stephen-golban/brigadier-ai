//! Resume of an ended session, end to end against a **live** `claude` child.
//!
//! Ignored by default: it spawns the real binary and spends the owner's money. Run it
//! deliberately, once:
//!
//! ```text
//! export PATH="$HOME/.cargo/bin:$PATH"
//! CLAUDE_BIN="$(command -v claude)" \
//!   cargo test -p brigadier-supervisor --test live_resume -- --ignored --nocapture
//! ```
//!
//! What it proves, in one harness row and two children:
//!
//! 1. the CLI really continues the conversation — the second child answers a question only the
//!    first child's transcript could answer (`docs/research/resume.md` §5 measured this from a
//!    fixture; this measures it through the harness);
//! 2. the envelope `seq` is seeded from `sessions.last_event_seq`, so every row the resumed
//!    child writes lands **after** the old ones and no old row is rewritten — the silent
//!    corruption `docs/research/resume.md` §7 ranks first among the risks;
//! 3. the row is reused, not re-minted, and its `ended_at`/`exit_code` are cleared while live.
//!
//! The `Live` harness, `wait_for` and the cost reporting are copied from
//! `crates/supervisor/tests/live_approvals.rs` rather than shared: an integration test is its own
//! binary, and a shared helper module would couple two tests that spend money independently.
// see docs/research/resume.md §2 (flag recipe), §5 (what the first init after a resume reports),
// §7 (the data model and the seq rule) and "Measured 2026-09-02".

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use brigadier_core::claude::{ClaudeDriver, ClaudeDriverConfig, CLAUDE_CODE};
use brigadier_core::driver::{DriverKind, PermissionMode, StartSession};
use brigadier_core::event::{Envelope, Event, RequestKind, SessionId};
use brigadier_core::session::Decision;
use brigadier_store::Store;
use brigadier_supervisor::{FeedRowWire, Supervisor, SupervisorConfig, VecSink};
use serde_json::Value;
use tempfile::TempDir;

/// The word the first child is told to remember. Nothing but the transcript can carry it into
/// the second child, so its reappearance is the whole proof that the resume worked.
const SECRET: &str = "pelican";

/// Turn 1, before the session is ended. Deliberately answerable with no tool at all.
const REMEMBER_PROMPT: &str = "Remember the word \"pelican\". Reply with only the word OK.";

/// Turn 2, after the resume. Only the resumed transcript can answer it.
const RECALL_PROMPT: &str =
    "What word did I ask you to remember? Reply with only that word, nothing else.";

/// What an unexpected approval is answered with. No tool call is expected on either turn, so
/// anything that opens is a wrong-tool retry and is denied on sight rather than left parked —
/// the CLI has no prompt timeout, and an unanswered request wedges the turn for the full 600 s
/// park deadline. see docs/research/approvals.md §4 "Timeout".
const DENY_REASON: &str = "denied by brigadier resume test";

/// The only model this test is allowed to spend on.
const MODEL: &str = "claude-haiku-4-5";

/// Ceiling on one live run, matching `live_approvals.rs`. Two short turns should come in well
/// under it; the bound is the spend cap, not the proof.
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

    fn data_dir(&self) -> PathBuf {
        self.sup.data_dir().to_owned()
    }

    /// Move whatever the sink has collected into `seen`, and hand back the new arrivals.
    fn drain(&mut self) -> Vec<Envelope> {
        let fresh: Vec<Envelope> = self.sink.take().into_iter().flat_map(|b| b.signals).collect();
        self.seen.extend(fresh.iter().cloned());
        fresh
    }

    /// Poll until a signal matches, or fail with what was seen instead.
    ///
    /// Matches against `seen`, not only against the new arrivals: `turn-started` can reach the
    /// sink before `session-started` does, so a caller that waits for one after having already
    /// drained the other would hang forever.
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

    /// Every envelope the raw log holds for `session_id`, as JSON.
    ///
    /// A resume reopens the same file in append mode, so this is one continuous transcript across
    /// both children. see `crates/store/src/ndjson.rs` `RawLog::open`.
    fn raw_log(&self, session_id: &SessionId) -> Vec<Value> {
        let path = self.data_dir().join("raw").join(format!("{}.ndjson", session_id.as_str()));
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("raw log {}: {e}", path.display()));
        text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
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

/// Every assistant-text summary in the raw log, oldest first.
fn assistant_texts(lines: &[Value]) -> Vec<String> {
    lines
        .iter()
        .filter_map(|line| {
            let event = line.get("event")?;
            if event.get("type")? != "item-completed" {
                return None;
            }
            if event.pointer("/kind/type")? != "assistant-text" {
                return None;
            }
            Some(event.get("summary")?.as_str()?.to_owned())
        })
        .collect()
}

/// A throwaway git repo for the child. **Never the brigadier checkout**: the resumed session is a
/// real Claude Code session with a real cwd, and the transcript it writes is keyed by that path.
fn project_dir() -> PathBuf {
    let root = std::env::var("BRIGADIER_LIVE_CWD")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("brigadier-live-resume"));
    std::fs::create_dir_all(&root).expect("project dir");
    if !root.join(".git").exists() {
        let _ = std::process::Command::new("git")
            .arg("init")
            .arg("--quiet")
            .current_dir(&root)
            .status();
    }
    ensure_initial_commit(&root);
    root
}

/// `Supervisor::start_session` refuses a repository with no commits (`WorktreeUnbornHead`), so a
/// reused throwaway repo must have one. Made without depending on the user's global git config,
/// and only when `HEAD` does not already resolve — a fresh `git init` and a repo left over from a
/// previous run both land here.
fn ensure_initial_commit(root: &Path) {
    let has_head = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--verify", "HEAD"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if has_head {
        return;
    }
    let _ = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "user.name=brigadier", "-c", "user.email=brigadier@example.invalid"])
        .arg("-c")
        .arg("commit.gpgsign=false")
        .args(["add", "-A"])
        .status();
    let _ = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "user.name=brigadier", "-c", "user.email=brigadier@example.invalid"])
        .arg("-c")
        .arg("commit.gpgsign=false")
        .args(["commit", "--quiet", "-m", "init", "--allow-empty"])
        .status();
}

/// Start, end, resume, and prove the second child continued the first one's conversation without
/// disturbing a single row it wrote.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "spawns the real claude binary and spends money on a live account"]
async fn live_resume_continues_the_conversation_and_the_feed() {
    let Ok(binary) = std::env::var("CLAUDE_BIN") else {
        eprintln!("CLAUDE_BIN unset; skipping");
        return;
    };
    let cwd = project_dir();
    assert!(
        !cwd.join("Cargo.toml").exists() && !cwd.join("src-tauri").exists(),
        "{} looks like a real checkout; this test must run in a throwaway tree",
        cwd.display()
    );

    let mut config = ClaudeDriverConfig::new("claude-code:live-resume");
    config.binary = Some(PathBuf::from(binary));
    // Pinned, not configurable: no other model may be billed by this test.
    config.default_model = Some(MODEL.to_owned());
    let driver = ClaudeDriver::probe(config).await.expect("claude probes");
    eprintln!("claude {} at {}", driver.version(), driver.binary().display());

    let mut live = Live::new();
    live.sup.register_driver(Arc::new(driver));
    let project = live.sup.add_project(cwd.clone()).await.expect("project added");

    // ---- the first child ------------------------------------------------------------------
    let mut req = StartSession::new(cwd.clone());
    req.prompt = Some(REMEMBER_PROMPT.to_owned());
    req.model = Some(MODEL.to_owned());
    req.permission_mode = PermissionMode::Default;
    let session_id = live
        .sup
        .start_session(&project.id, &DriverKind::new(CLAUDE_CODE), req)
        .await
        .expect("session starts");
    eprintln!("session {}", session_id.as_str());

    live.wait_for("turn 1 to complete", TURN_TIMEOUT, &session_id, is_turn_completed).await;
    live.sup.end_session(&session_id).await.expect("end_session");
    live.wait_for("the first child to exit", TURN_TIMEOUT, &session_id, |e| {
        matches!(e.event, Event::SessionExited { .. })
    })
    .await;
    live.store.handle().flush().await.expect("store flushed");

    let ended = live.sup.session(&session_id).await.expect("read").expect("row");
    let old_seq = ended.last_event_seq;
    let before: Vec<FeedRowWire> = live.sup.feed_tail(&session_id, 1000).await.expect("tail");
    let token = ended.resume_token.clone().expect("the first child named its provider session");
    eprintln!(
        "ended: status={:?} exit_code={:?} old_seq={old_seq} rows={} token={token}",
        ended.status,
        ended.exit_code,
        before.len()
    );
    assert!(old_seq > 0, "the first child must have written feed rows");
    assert!(ended.ended_at.is_some(), "an ended session carries an end time");
    let instance_before = ended.instance_id.clone();

    // ---- the resume -----------------------------------------------------------------------
    let resumed = live.sup.resume_session(&session_id).await.expect("resume_session");
    assert_eq!(resumed, session_id, "the harness row is reused, never re-minted");
    assert!(live.sup.is_live(&session_id), "the resumed child is in the live map");

    // The row is readable the moment `resume_session` returns, before a single event has come
    // back: `session_resumed` cleared the ending in the same call.
    live.store.handle().flush().await.expect("store flushed");
    let running = live.sup.session(&session_id).await.expect("read").expect("row");
    let instance_after = running.instance_id.clone();
    eprintln!(
        "resumed: status={:?} ended_at={:?} exit_code={:?} instance {:?} -> {:?}",
        running.status, running.ended_at, running.exit_code, instance_before, instance_after
    );
    assert_eq!(running.ended_at, None, "a live session must not carry an end time");
    assert_eq!(running.exit_code, None, "nor a stale exit code");

    // ---- the recall turn --------------------------------------------------------------------
    //
    // The turn comes *before* the wait for `session-started`, not after it. `system/init` fires
    // once per turn rather than once per process, so a resumed child that has been asked nothing
    // never announces itself and a test that waited first would hang.
    // see docs/research/resume.md §5 and docs/research/claude-direct-spike.md scenario 1.
    let before_texts = assistant_texts(&live.raw_log(&session_id)).len();
    live.sup.send_turn(&session_id, RECALL_PROMPT).await.expect("recall turn queued");
    let started = live
        .wait_for("the resumed child to announce its session", TURN_TIMEOUT, &session_id, |e| {
            matches!(e.event, Event::SessionStarted { .. }) && e.seq > old_seq
        })
        .await;
    if let Event::SessionStarted { provider_session_id, .. } = &started.event {
        assert_eq!(
            provider_session_id, &token,
            "a plain resume keeps the provider's own session id; only --fork-session mints one"
        );
    }
    live.wait_for("the recall turn to complete", TURN_TIMEOUT, &session_id, |e| {
        is_turn_completed(e) && e.seq > old_seq
    })
    .await;

    let texts = assistant_texts(&live.raw_log(&session_id));
    let answer = texts[before_texts..]
        .iter()
        .find(|t| t.to_lowercase().contains(SECRET))
        .unwrap_or_else(|| {
            panic!("the resumed child did not recall {SECRET:?}: {:?}", &texts[before_texts..])
        });
    eprintln!("recall answer: {answer}");

    // ---- the seq rule, which is the point ---------------------------------------------------
    live.store.handle().flush().await.expect("store flushed");
    let after: Vec<FeedRowWire> = live.sup.feed_tail(&session_id, 1000).await.expect("tail");
    assert!(after.len() > before.len(), "the resume wrote new rows: {} -> {}", before.len(), after.len());
    assert_eq!(
        &after[..before.len()],
        &before[..],
        "every pre-resume row must be byte-identical after the resume"
    );
    let first_new = after[before.len()].q;
    assert!(
        after[before.len()..].iter().all(|r| r.q > old_seq),
        "every post-resume row must land after the old ones: {:?}",
        &after[before.len()..]
    );
    eprintln!("old_seq={old_seq} first_new_seq={first_new} rows {} -> {}", before.len(), after.len());

    // ---- end, and account for it -------------------------------------------------------------
    live.sup.end_session(&session_id).await.expect("end_session");
    live.wait_for("the resumed child to exit", TURN_TIMEOUT, &session_id, |e| {
        matches!(e.event, Event::SessionExited { .. }) && e.seq > old_seq
    })
    .await;
    live.store.handle().flush().await.expect("store flushed");

    let row = live.sup.session(&session_id).await.expect("read").expect("row");
    eprintln!(
        "cost_usd_cumulative={:.6} usage={:?} status={:?} exit_code={:?} last_event_seq={}",
        row.cost_usd_cumulative, row.usage, row.status, row.exit_code, row.last_event_seq
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
