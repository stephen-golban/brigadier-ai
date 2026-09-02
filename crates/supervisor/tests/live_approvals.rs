//! Approvals end to end against a **live** `claude` child, driven through [`Supervisor`].
//!
//! Ignored by default: it spawns the real binary and spends the owner's money. Run it deliberately:
//!
//! ```text
//! export PATH="$HOME/.cargo/bin:$PATH"
//! CLAUDE_BIN=$(which claude) BRIGADIER_LIVE_CWD=/tmp/approvals-proj \
//!   cargo test -p brigadier-supervisor --test live_approvals -- --ignored --nocapture
//! ```
//!
//! What it proves, in one session and three turns:
//!
//! 1. the `PreToolUse` policy's `permissionDecision: "ask"` produces a real `can_use_tool` frame
//!    for `Bash` — the one link `docs/research/approvals.md` §11 listed as never measured;
//! 2. a deny reaches the model as a `tool_result` with `is_error: true` carrying our reason, and
//!    the command never ran;
//! 3. an allow on a second turn runs the command and the real stdout comes back;
//! 4. a `Write` prompt has the same envelope, captured as a fixture.
//!
//! Cost is read from the store's `sessions.cost_usd_cumulative`, not from the wire, so the number
//! reported is the one the harness persisted.
// see docs/research/approvals.md §5 (the hook lever), §8 (the prompt) and "Measured 2026-09-02"
// (the results of this test).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use brigadier_core::claude::{ClaudeDriver, ClaudeDriverConfig, CLAUDE_CODE};
use brigadier_core::driver::{DriverKind, PermissionMode, StartSession};
use brigadier_core::event::{Envelope, Event, RequestKind, SessionId};
use brigadier_core::session::Decision;
use brigadier_store::Store;
use brigadier_supervisor::{Supervisor, SupervisorConfig, VecSink};
use serde_json::Value;
use tempfile::TempDir;

/// The turn-1 and turn-2 prompt. Naming the tool and the literal command removes the model's
/// freedom to reach for `Read` or `Glob`; "exactly one" suppresses the retry-with-a-variant
/// behaviour that would open a second prompt mid-test.
// see docs/research/approvals.md §8.
const BASH_PROMPT: &str = "Run exactly one Bash command: ls -1. Report only the number of lines \
                           it printed. Do not use any other tool, and do not run any other command.";

/// The turn-3 prompt: the same shape for a tool with no capture in `crates/claude-spike/fixtures`.
const WRITE_PROMPT: &str = "Use the Write tool to create a file named hello.txt containing the \
                            word hi. Do not use any other tool.";

/// What the operator "clicks deny" with. It must come back verbatim in the `tool_result`.
const DENY_REASON: &str = "denied by brigadier test";

/// The three files the throwaway project holds, so `ls -1` prints exactly three lines and the
/// allow leg has something unmistakable to look for.
const PROJECT_FILES: [&str; 3] = ["alpha.txt", "beta.txt", "gamma.txt"];

/// The only model this test is allowed to spend on.
const MODEL: &str = "claude-haiku-4-5";

/// Ceiling on one live run. The 2026-09-02 run measured $0.045850 for the three turns (see
/// docs/research/approvals.md §12), so $0.05 was one cache miss away from a false failure.
const COST_CEILING_USD: f64 = 0.08;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
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
        let fresh: Vec<Envelope> =
            self.sink.take().into_iter().flat_map(|b| b.signals).collect();
        self.seen.extend(fresh.iter().cloned());
        fresh
    }

    /// Poll until a signal matches, or fail with what was seen instead.
    ///
    /// A `RequestOpened` that is not what we are waiting for is **denied on sight** rather than
    /// left parked: the CLI has no prompt timeout, so an unanswered request would wedge the turn
    /// for the full 600 s park deadline and turn a wrong-tool retry into a ten-minute hang.
    // see docs/research/approvals.md §4 "Timeout".
    async fn wait_for(
        &mut self,
        what: &str,
        within: Duration,
        session_id: &SessionId,
        mut pred: impl FnMut(&Envelope) -> bool,
    ) -> Envelope {
        let deadline = Instant::now() + within;
        loop {
            for env in self.drain() {
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
    /// The raw log is the only place `Envelope::raw` survives: the batcher strips it from every
    /// signal it sends, so the wire frames have to be read back off disk.
    // see docs/plans/ipc-contract.md "Feed channel" — signals are sent with `raw: None`.
    fn raw_log(&self, session_id: &SessionId) -> Vec<Value> {
        let path = self.data_dir().join("raw").join(format!("{}.ndjson", session_id.as_str()));
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("raw log {}: {e}", path.display()));
        text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }
}

fn label(event: &Event) -> String {
    match event {
        Event::SessionStarted { .. } => "session-started".into(),
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

/// True for a `request-opened` gating `tool`.
fn is_permission_for(env: &Envelope, tool: &str) -> bool {
    matches!(
        &env.event,
        Event::RequestOpened { kind: RequestKind::ToolPermission { tool_name, .. }, .. }
            if tool_name == tool
    )
}

fn is_turn_completed(env: &Envelope) -> bool {
    matches!(env.event, Event::TurnCompleted { .. })
}

/// The `tool_result` items in the raw log, newest last, as `(is_error, summary, raw)`.
fn tool_results(lines: &[Value]) -> Vec<(bool, String, String)> {
    lines
        .iter()
        .filter_map(|line| {
            let event = line.get("event")?;
            if event.get("type")? != "item-completed" {
                return None;
            }
            let kind = event.get("kind")?;
            if kind.get("type")? != "tool-result" {
                return None;
            }
            Some((
                kind.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                event.get("summary").and_then(Value::as_str).unwrap_or_default().to_owned(),
                line.get("raw").and_then(Value::as_str).unwrap_or_default().to_owned(),
            ))
        })
        .collect()
}

/// Build (or reuse) the throwaway git repo the child runs in. **Never the brigadier checkout.**
fn project_dir() -> PathBuf {
    let root = std::env::var("BRIGADIER_LIVE_CWD")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("brigadier-live-approvals"));
    std::fs::create_dir_all(&root).expect("project dir");
    for name in PROJECT_FILES {
        let path = root.join(name);
        if !path.exists() {
            std::fs::write(&path, format!("{name}\n")).expect("project file");
        }
    }
    // `ls -1` must print exactly three lines, so nothing else may be left lying around.
    let _ = std::fs::remove_file(root.join("hello.txt"));
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

/// Deny, then allow, then a `Write` prompt — one live session, one model, three turns.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "spawns the real claude binary and spends money on a live account"]
async fn live_deny_then_allow_then_write() {
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

    let mut config = ClaudeDriverConfig::new("claude-code:live");
    config.binary = Some(PathBuf::from(binary));
    // Pinned, not configurable: no other model may be billed by this test.
    config.default_model = Some(MODEL.to_owned());
    let driver = ClaudeDriver::probe(config).await.expect("claude probes");
    eprintln!("claude {} at {}", driver.version(), driver.binary().display());

    let mut live = Live::new();
    live.sup.register_driver(Arc::new(driver));
    let project = live.sup.add_project(cwd.clone()).await.expect("project added");

    let mut req = StartSession::new(cwd.clone());
    req.prompt = Some(BASH_PROMPT.to_owned());
    req.model = Some(MODEL.to_owned());
    req.permission_mode = PermissionMode::Default;
    let session_id = live
        .sup
        .start_session(&project.id, &DriverKind::new(CLAUDE_CODE), req)
        .await
        .expect("session starts");
    eprintln!("session {}", session_id.as_str());

    // ---- turn 1: the prompt appears, and a deny reaches the model -------------------------
    let opened = live
        .wait_for("a Bash tool-permission request", REQUEST_TIMEOUT, &session_id, |e| {
            is_permission_for(e, "Bash")
        })
        .await;
    let Event::RequestOpened { request_id, kind, .. } = opened.event.clone() else {
        unreachable!("wait_for matched a request-opened")
    };
    eprintln!("turn 1 request: {kind:?}");
    let pending = live.sup.pending_for(&session_id);
    assert!(
        pending.iter().any(|p| p.request_id == request_id),
        "the request must be parked in the approval table; pending = {pending:?}"
    );

    live.sup
        .respond(&session_id, request_id.clone(), Decision::deny(DENY_REASON))
        .await
        .expect("deny is accepted");
    live.wait_for("turn 1 to complete", TURN_TIMEOUT, &session_id, is_turn_completed).await;

    let after_deny = tool_results(&live.raw_log(&session_id));
    let denied = after_deny
        .iter()
        .find(|(is_error, summary, _)| *is_error && summary.contains(DENY_REASON))
        .unwrap_or_else(|| panic!("no errored tool_result carrying the reason: {after_deny:?}"));
    eprintln!("deny evidence: {}", denied.2);
    assert!(
        denied.2.contains(r#""is_error":true"#),
        "the wire frame must carry is_error: true — {}",
        denied.2
    );
    for (_, summary, raw) in &after_deny {
        for name in PROJECT_FILES {
            assert!(
                !summary.contains(name) && !raw.contains(name),
                "the denied command must not have run, but {name} came back: {raw}"
            );
        }
    }

    // ---- turn 2: the same prompt, allowed -------------------------------------------------
    let before_allow = after_deny.len();
    live.sup.send_turn(&session_id, BASH_PROMPT).await.expect("second turn queued");
    let opened = live
        .wait_for("a second Bash tool-permission request", REQUEST_TIMEOUT, &session_id, |e| {
            is_permission_for(e, "Bash")
        })
        .await;
    let Event::RequestOpened { request_id, .. } = opened.event.clone() else {
        unreachable!("wait_for matched a request-opened")
    };
    live.sup
        .respond(&session_id, request_id, Decision::allow())
        .await
        .expect("allow is accepted");
    live.wait_for("turn 2 to complete", TURN_TIMEOUT, &session_id, is_turn_completed).await;

    let after_allow = tool_results(&live.raw_log(&session_id));
    let allowed = after_allow[before_allow..]
        .iter()
        .find(|(_, _, raw)| PROJECT_FILES.iter().all(|n| raw.contains(n)))
        .unwrap_or_else(|| {
            panic!("no tool_result carrying the real stdout: {:?}", &after_allow[before_allow..])
        });
    eprintln!("allow evidence: {}", allowed.2);
    assert!(!allowed.0, "the allowed command must not report an error: {}", allowed.2);

    // ---- turn 3: a Write prompt, captured and denied ---------------------------------------
    live.sup.send_turn(&session_id, WRITE_PROMPT).await.expect("third turn queued");
    let opened = live
        .wait_for("a Write tool-permission request", REQUEST_TIMEOUT, &session_id, |e| {
            is_permission_for(e, "Write")
        })
        .await;
    let Event::RequestOpened { request_id, .. } = opened.event.clone() else {
        unreachable!("wait_for matched a request-opened")
    };
    let frame = live
        .raw_log(&session_id)
        .into_iter()
        .filter_map(|line| {
            let raw = line.get("raw")?.as_str()?.to_owned();
            let event = line.get("event")?;
            (event.get("type")? == "request-opened"
                && event.pointer("/kind/tool_name")? == "Write")
                .then_some(raw)
        })
        .next_back()
        .expect("the Write request kept its raw frame");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claude-spike/fixtures/s7-can-use-tool-write.ndjson");
    std::fs::write(&fixture, format!("{frame}\n")).expect("fixture written");
    eprintln!("wrote {} ({} bytes)", fixture.display(), frame.len());

    live.sup
        .respond(&session_id, request_id, Decision::deny(DENY_REASON))
        .await
        .expect("deny is accepted");
    live.wait_for("turn 3 to complete", TURN_TIMEOUT, &session_id, is_turn_completed).await;
    assert!(!cwd.join("hello.txt").exists(), "a denied Write must not have created the file");
    let session_cwd = live
        .sup
        .session(&session_id)
        .await
        .expect("session read")
        .expect("the session row exists")
        .cwd
        .expect("session row carries a cwd");
    assert!(
        !session_cwd.join("hello.txt").exists(),
        "a denied Write must not have created the file in the worktree {}",
        session_cwd.display()
    );

    // ---- end, and account for it -----------------------------------------------------------
    live.sup.end_session(&session_id).await.expect("end_session");
    live.wait_for("the session to exit", TURN_TIMEOUT, &session_id, |e| {
        matches!(e.event, Event::SessionExited { .. })
    })
    .await;
    live.store.handle().flush().await.expect("store flushed");

    let row = live
        .sup
        .session(&session_id)
        .await
        .expect("session read")
        .expect("the session row exists");
    eprintln!(
        "cost_usd_cumulative={:.6} usage={:?} status={:?} exit_code={:?}",
        row.cost_usd_cumulative, row.usage, row.status, row.exit_code
    );
    eprintln!(
        "signals: {}",
        live.seen.iter().map(|e| label(&e.event)).collect::<Vec<_>>().join(", ")
    );
    // A hook `ask` that never reached the wire would leave this at 0 and the test would already
    // have failed above; the bound is the spend cap, not the proof.
    assert!(row.cost_usd_cumulative > 0.0, "a live turn must have cost something");
    assert!(
        row.cost_usd_cumulative < COST_CEILING_USD,
        "run cost ${:.6}, over the ${COST_CEILING_USD} cap",
        row.cost_usd_cumulative
    );

    // Every raw `item-completed` for a tool call names the tool the model actually used; nothing
    // outside the prompt's instructions should appear.
    let items = live.raw_log(&session_id);
    let opened_count = items
        .iter()
        .filter(|l| l.pointer("/event/type") == Some(&Value::from("request-opened")))
        .count();
    eprintln!("request-opened frames in the raw log: {opened_count}");
    assert!(opened_count >= 3, "three prompts were driven, saw {opened_count}");
}
