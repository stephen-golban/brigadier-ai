//! Two **live** `claude` children on one project at the same time, driven through [`Supervisor`].
//!
//! Ignored by default: it spawns two real binaries and spends the owner's money. Run it
//! deliberately, once:
//!
//! ```text
//! export PATH="$HOME/.cargo/bin:$PATH"
//! CLAUDE_BIN="$(command -v claude)" \
//!   cargo test -p brigadier-supervisor --test live_two_sessions -- --ignored --nocapture
//! ```
//!
//! Every other live test drives one child. Concurrency is the whole product claim — "supervises
//! multiple coding-agent CLI sessions" — and it had never been exercised against real children.
//! What this proves, in one project and two sessions:
//!
//! 1. two children are live **at the same time**: `live_sessions()` holds both ids on at least
//!    one poll, recorded as the maximum concurrent count rather than inferred afterwards;
//! 2. the interleaved feed is well formed — one project's [`FeedBatch`] carries rows from both
//!    sessions, `t` never goes backwards inside a batch, and each session's `q` strictly
//!    increases in delivery order;
//! 3. the per-session counters account for every row: the last [`SessionCounter`] for a session
//!    reports exactly as many `rows_total` as rows were delivered for it, and nothing dropped;
//! 4. the two sessions are independent — each answers only its own prompt (ALPHA / BRAVO) and
//!    each carries its own non-zero cumulative cost;
//! 5. [`Supervisor::shutdown_with`] ends both gracefully: both rows land on `Exited` with exit
//!    code 0 and the live map is empty.
//!
//! The `Live` harness, `wait_for`-style polling and the cost reporting are copied from
//! `crates/supervisor/tests/live_resume.rs` rather than shared: an integration test is its own
//! binary, and a shared helper module would couple tests that spend money independently.
// see docs/research/approvals.md §4 "Timeout" (why an unexpected request is denied on sight) and
// docs/research/claude-direct-spike.md (ordering on the signal stream is not guaranteed).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use brigadier_core::claude::{ClaudeDriver, ClaudeDriverConfig, CLAUDE_CODE};
use brigadier_core::driver::{DriverKind, PermissionMode, StartSession};
use brigadier_core::event::{Envelope, Event, RequestKind, SessionId};
use brigadier_core::session::Decision;
use brigadier_store::{SessionStatus, Store};
use brigadier_supervisor::{FeedBatch, Supervisor, SupervisorConfig, VecSink};
use serde_json::Value;
use tempfile::TempDir;

/// Session A's only turn. One word, no tool, nothing to negotiate.
const PROMPT_A: &str = "Reply with only the word ALPHA.";
/// Session B's only turn. Distinct from A's so a crossed transcript is visible, not inferred.
const PROMPT_B: &str = "Reply with only the word BRAVO.";

/// The word each session must produce.
const WORD_A: &str = "ALPHA";
const WORD_B: &str = "BRAVO";

/// What an unexpected approval is answered with. No tool call is expected on either turn, so
/// anything that opens — a memory-file `Write`, a stray `Read` — is denied on sight rather than
/// left parked: the CLI has no prompt timeout, and an unanswered request wedges the turn for the
/// full park deadline.
const DENY_REASON: &str = "denied by brigadier two-sessions test";

/// The only model this test is allowed to spend on.
const MODEL: &str = "claude-haiku-4-5";

/// Ceiling on one session in one live run, matching `live_approvals.rs` and `live_resume.rs`.
const COST_CEILING_USD: f64 = 0.08;

const TURN_TIMEOUT: Duration = Duration::from_secs(180);
/// How long to keep draining the sink after `shutdown_with` returns, so the flusher's last tick
/// lands before the batches are inspected.
const DRAIN_AFTER_SHUTDOWN: Duration = Duration::from_secs(3);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(50);

/// A store, a supervisor over it, every batch the sink was handed, and every signal seen.
///
/// Unlike the single-session harnesses this keeps the **whole** batch, not just its signals: the
/// interleaving and the counters are the thing under test here, and both live in the parts that
/// `live_resume.rs` throws away.
struct Live {
    _data: TempDir,
    store: Store,
    sink: Arc<VecSink>,
    sup: Supervisor,
    seen: Vec<Envelope>,
    batches: Vec<FeedBatch>,
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
        Live { _data: data, store, sink, sup, seen: Vec::new(), batches: Vec::new() }
    }

    fn data_dir(&self) -> PathBuf {
        self.sup.data_dir().to_owned()
    }

    /// Move whatever the sink has collected into `batches` and `seen`, in delivery order.
    fn drain(&mut self) {
        for batch in self.sink.take() {
            self.seen.extend(batch.signals.iter().cloned());
            self.batches.push(batch);
        }
    }

    /// Every envelope the raw log holds for `session_id`, as JSON.
    fn raw_log(&self, session_id: &SessionId) -> Vec<Value> {
        let path = self.data_dir().join("raw").join(format!("{}.ndjson", session_id.as_str()));
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("raw log {}: {e}", path.display()));
        text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }

    /// Every feed row the sink was handed, flattened in delivery order.
    fn rows(&self) -> Vec<(usize, brigadier_supervisor::FeedRowWire)> {
        self.batches
            .iter()
            .enumerate()
            .flat_map(|(i, b)| b.rows.iter().cloned().map(move |r| (i, r)))
            .collect()
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

/// `session-id: label` for everything seen so far, for a failure message.
fn transcript(seen: &[Envelope]) -> String {
    seen.iter()
        .map(|e| format!("{}:{}", &e.session_id.as_str()[..8.min(e.session_id.as_str().len())], label(&e.event)))
        .collect::<Vec<_>>()
        .join(", ")
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

/// A throwaway git repo for both children. **Never the brigadier checkout**: these are real
/// Claude Code sessions with a real cwd, and the transcripts they write are keyed by that path.
fn project_dir() -> PathBuf {
    let root = std::env::var("BRIGADIER_LIVE_CWD")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("brigadier-live-two-sessions"));
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

/// Start two children on one project without waiting for either, and account for everything the
/// harness produced while both were running.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "spawns two real claude binaries and spends money on a live account"]
async fn live_two_sessions_run_concurrently_on_one_project() {
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

    let mut config = ClaudeDriverConfig::new("claude-code:live-two-sessions");
    config.binary = Some(PathBuf::from(binary));
    // Pinned, not configurable: no other model may be billed by this test.
    config.default_model = Some(MODEL.to_owned());
    let driver = ClaudeDriver::probe(config).await.expect("claude probes");
    eprintln!("claude {} at {}", driver.version(), driver.binary().display());

    let mut live = Live::new();
    live.sup.register_driver(Arc::new(driver));
    let project = live.sup.add_project(cwd.clone()).await.expect("project added");

    // Before a single row exists, so nothing can be dropped for invisibility. Assertion 3 reads
    // `rows_dropped == 0`, which is only meaningful if the project was visible from row one.
    live.sup.set_visible_projects(vec![project.id.clone()]);

    // ---- both children, without waiting in between ------------------------------------------
    let start = |prompt: &str| {
        let mut req = StartSession::new(cwd.clone());
        req.prompt = Some(prompt.to_owned());
        req.model = Some(MODEL.to_owned());
        req.permission_mode = PermissionMode::Default;
        req
    };
    let kind = DriverKind::new(CLAUDE_CODE);
    let a = live
        .sup
        .start_session(&project.id, &kind, start(PROMPT_A))
        .await
        .expect("session A starts");
    let b = live
        .sup
        .start_session(&project.id, &kind, start(PROMPT_B))
        .await
        .expect("session B starts");
    eprintln!("A = {}\nB = {}", a.as_str(), b.as_str());

    // ---- 1: both live at once, observed rather than inferred --------------------------------
    //
    // `live_sessions()` is sampled on every poll of the same loop that waits for the turns, so
    // the overlap is measured while it is happening. Waiting for A first would serialize the
    // test and destroy the thing it is trying to observe.
    let mut max_live = 0usize;
    let mut saw_both = false;
    let mut done_a = false;
    let mut done_b = false;
    let mut next = 0usize;
    let deadline = Instant::now() + TURN_TIMEOUT;
    loop {
        let now_live = live.sup.live_sessions();
        max_live = max_live.max(now_live.len());
        if now_live.contains(&a) && now_live.contains(&b) {
            saw_both = true;
        }

        live.drain();
        while next < live.seen.len() {
            let env = live.seen[next].clone();
            next += 1;
            if matches!(env.event, Event::TurnCompleted { .. }) {
                if env.session_id == a {
                    done_a = true;
                } else if env.session_id == b {
                    done_b = true;
                }
            }
            if let Event::RequestOpened { request_id, kind, .. } = &env.event {
                eprintln!(
                    "  [auto-deny] {} unexpected request {request_id:?}: {kind:?}",
                    env.session_id.as_str()
                );
                let _ = live
                    .sup
                    .respond(&env.session_id, request_id.clone(), Decision::deny(DENY_REASON))
                    .await;
            }
        }
        if done_a && done_b {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "timed out after {TURN_TIMEOUT:?} waiting for both turns (A done: {done_a}, \
             B done: {done_b}); saw {}",
            transcript(&live.seen)
        );
        tokio::time::sleep(POLL).await;
    }
    eprintln!("max concurrent live sessions: {max_live}; both live at once: {saw_both}");
    assert!(
        saw_both && max_live >= 2,
        "the two children never overlapped: max concurrent live = {max_live}. Either the model \
         answered A before B had spawned, or sessions are being serialized somewhere."
    );

    // ---- shut both down, and time it --------------------------------------------------------
    let shutdown_started = Instant::now();
    live.sup.shutdown_with(SHUTDOWN_GRACE).await;
    let shutdown_elapsed = shutdown_started.elapsed();
    eprintln!("shutdown_with({SHUTDOWN_GRACE:?}) took {shutdown_elapsed:?}");

    // The flusher runs on its own 16 ms tick and is not driven by `shutdown_with`, so the exit
    // rows and the final counters need a few more ticks before the batches are complete.
    let drain_deadline = Instant::now() + DRAIN_AFTER_SHUTDOWN;
    loop {
        live.drain();
        let exits = live
            .seen
            .iter()
            .filter(|e| matches!(e.event, Event::SessionExited { .. }))
            .map(|e| e.session_id.clone())
            .collect::<Vec<_>>();
        if exits.contains(&a) && exits.contains(&b) {
            // One more tick, so the counter that accompanies the exit row is in hand too.
            tokio::time::sleep(POLL).await;
            live.drain();
            break;
        }
        if Instant::now() >= drain_deadline {
            eprintln!("  [warn] only {} exit signals after {DRAIN_AFTER_SHUTDOWN:?}", exits.len());
            break;
        }
        tokio::time::sleep(POLL).await;
    }
    assert!(
        live.sup.live_sessions().is_empty(),
        "sessions still live after shutdown: {:?}",
        live.sup.live_sessions()
    );

    // ---- 2: the interleaved feed ------------------------------------------------------------
    let rows = live.rows();
    eprintln!("{} batches, {} rows", live.batches.len(), rows.len());
    let count_a = rows.iter().filter(|(_, r)| r.s == a.as_str()).count();
    let count_b = rows.iter().filter(|(_, r)| r.s == b.as_str()).count();
    eprintln!("rows: A={count_a} B={count_b}");
    assert!(count_a > 0 && count_b > 0, "both sessions must have written feed rows");

    // Inside one batch the rows are drained from a single per-project queue, so their emission
    // times must not go backwards even though two sessions pushed into it.
    for batch in &live.batches {
        let mut prev: Option<i64> = None;
        for row in &batch.rows {
            if let Some(p) = prev {
                assert!(
                    row.t >= p,
                    "batch {} row {} of session {} went back in time: {} after {p}",
                    batch.project_id,
                    row.q,
                    row.s,
                    row.t
                );
            }
            prev = Some(row.t);
        }
        assert_eq!(batch.project_id, project.id, "one project, one batch stream");
    }

    // Per session, `q` must strictly increase in delivery order: the interleaving may reorder
    // sessions against each other, never a session against itself.
    let mut last_q: BTreeMap<&str, u64> = BTreeMap::new();
    for (batch_ix, row) in &rows {
        if let Some(prev) = last_q.get(row.s.as_str()) {
            assert!(
                row.q > *prev,
                "session {} seq went {} -> {} in batch {batch_ix}",
                row.s,
                prev,
                row.q
            );
        }
        last_q.insert(row.s.as_str(), row.q);
    }
    let batches_with_both = live
        .batches
        .iter()
        .filter(|batch| {
            batch.rows.iter().any(|r| r.s == a.as_str())
                && batch.rows.iter().any(|r| r.s == b.as_str())
        })
        .count();
    eprintln!("batches carrying rows from both sessions: {batches_with_both}");

    // ---- 3: the per-session counters --------------------------------------------------------
    for (session, delivered) in [(&a, count_a), (&b, count_b)] {
        let counter = live
            .batches
            .iter()
            .rev()
            .find_map(|batch| {
                batch.counters.iter().find(|c| c.session_id == session.as_str()).cloned()
            })
            .unwrap_or_else(|| panic!("no counter was ever sent for {}", session.as_str()));
        eprintln!(
            "counter {}: rows_total={} rows_dropped={} delivered={delivered}",
            session.as_str(),
            counter.rows_total,
            counter.rows_dropped
        );
        assert_eq!(
            counter.rows_total, delivered as u64,
            "{} produced {} rows but {delivered} were delivered",
            session.as_str(),
            counter.rows_total
        );
        assert_eq!(counter.rows_dropped, 0, "a visible project must drop nothing");
    }

    // ---- 4 and 5: the two rows ---------------------------------------------------------------
    live.store.handle().flush().await.expect("store flushed");
    let mut total = 0.0f64;
    for (session, word) in [(&a, WORD_A), (&b, WORD_B)] {
        let row = live.sup.session(session).await.expect("read").expect("row");
        eprintln!(
            "{}: status={:?} exit_code={:?} cost_usd_cumulative={:.6} usage={:?} seq={}",
            session.as_str(),
            row.status,
            row.exit_code,
            row.cost_usd_cumulative,
            row.usage,
            row.last_event_seq
        );
        assert_eq!(row.status, SessionStatus::Exited, "{} must end cleanly", session.as_str());
        assert_eq!(row.exit_code, Some(0), "{} must exit 0", session.as_str());
        assert!(
            row.cost_usd_cumulative > 0.0,
            "{} ran a live turn and must have cost something",
            session.as_str()
        );
        assert!(
            row.cost_usd_cumulative < COST_CEILING_USD,
            "{} cost ${:.6}, over the ${COST_CEILING_USD} cap",
            session.as_str(),
            row.cost_usd_cumulative
        );
        total += row.cost_usd_cumulative;

        // The answer, from the feed first and the raw log as the fallback: `terse_line` folds an
        // `assistant-text` item into its row, but only up to `FEED_LINE_LIMIT`.
        let tail = live.sup.feed_tail(session, 1000).await.expect("tail");
        let in_feed = tail.iter().any(|r| r.l.to_uppercase().contains(word));
        let texts = assistant_texts(&live.raw_log(session));
        let in_raw = texts.iter().any(|t| t.to_uppercase().contains(word));
        eprintln!("  {word}: feed={in_feed} raw={in_raw}; assistant said {texts:?}");
        assert!(
            in_feed || in_raw,
            "{} never said {word}; feed rows {:?}",
            session.as_str(),
            tail.iter().map(|r| r.l.clone()).collect::<Vec<_>>()
        );

        // Independence: neither child may have answered the other's prompt.
        let other = if word == WORD_A { WORD_B } else { WORD_A };
        assert!(
            !texts.iter().any(|t| t.to_uppercase().contains(other)),
            "{} answered the other session's prompt ({other}): {texts:?}",
            session.as_str()
        );
    }
    eprintln!("total cost ${total:.6} over two sessions");
    eprintln!("signals: {}", transcript(&live.seen));
}
