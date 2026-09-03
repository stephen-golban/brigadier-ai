//! The flood baseline: eight ordinary synthetic sessions, one flooding at the batch cap, one
//! raising a permission request, across three projects.
//!
//! This is an instrument, not a gate, so it is `#[ignore]`d and prints its numbers. Run it with
//!
//! ```text
//! cargo test -p brigadier-supervisor --test flood_baseline -- --ignored --nocapture
//! ```
//!
//! No `claude` process is spawned: every session is a [`ReplayDriver`] over a captured NDJSON
//! fixture, and the fixture's own script is produced by driving the real Claude adapter over
//! duplex pipes. see `docs/research/flood-baseline.md` for the method and the results, and
//! `docs/research/feed-rendering.md` §4 for the batch arithmetic the flood rate comes from.
//!
//! What it measures, and where each number is taken:
//!
//! - **Approval latency** — from the instant the driver parks the request
//!   ([`RaisedApproval::at`]) to the instant the batch carrying its `request-opened` signal
//!   reaches the sink. The sink is the Rust side of `tauri::ipc::Channel::send`; everything past
//!   it (eval, rAF drain, React commit, paint) is **not** measured here.
//! - **Durable backlog** — the round trip of a store read. Reads and writes share one thread
//!   (`crates/store/src/writer.rs`), so a read's latency *is* the depth of the write queue ahead
//!   of it, in time. No counter had to be added for this.
//! - **Lost rows** — the rows the store holds against the rows the producer emitted,
//!   reconstructed exactly from the script rather than counted approximately.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use brigadier_core::driver::{DriverKind, StartSession};
use brigadier_core::event::{Event, RequestKind, SessionId};
use brigadier_core::session::Decision;
use brigadier_store::feed::terse_line;
use brigadier_store::Store;
use brigadier_supervisor::batcher::{MAX_MESSAGE_BYTES, MAX_ROWS_PER_MESSAGE};
use brigadier_supervisor::replay::ApprovalPlan;
use brigadier_supervisor::{FeedBatch, FeedSink, ReplayDriver, SinkError, Supervisor,
    SupervisorConfig};

/// Rows per second for a session that is behaving normally.
const ORDINARY_ROWS_PER_SEC: f64 = 20.0;

/// Rows per second for the flooder: exactly the batch cap.
///
/// `MAX_ROWS_PER_MESSAGE` rows per message, one message per 16 ms frame, is 24 / 0.016 = 1500
/// rows/s. A flood at this rate keeps every frame's first message exactly full.
// see docs/research/feed-rendering.md §4 "Batch size".
const FLOOD_ROWS_PER_SEC: f64 = 1500.0;

/// Ordinary sessions.
const ORDINARY_SESSIONS: usize = 8;

/// How long the flood runs.
const FLOOD: Duration = Duration::from_secs(20);

/// How long after the flood stops the store is watched for a backlog that will not drain.
const SETTLE: Duration = Duration::from_secs(6);

/// How long into the flood the permission request is raised.
const APPROVAL_AT: Duration = Duration::from_secs(10);

/// How often the store is probed.
const PROBE_EVERY: Duration = Duration::from_millis(100);

/// The gate: the approval must reach the UI within this.
const APPROVAL_BUDGET: Duration = Duration::from_millis(100);

/// The store's per-session feed ring (`StoreConfig::feed_cap`), which trims deliberately.
const FEED_CAP: usize = 500;

/// A sink that stamps every batch with the instant it arrived.
#[derive(Debug, Default)]
struct StampSink {
    batches: Mutex<Vec<(Instant, FeedBatch)>>,
}

impl StampSink {
    fn take(&self) -> Vec<(Instant, FeedBatch)> {
        std::mem::take(&mut self.batches.lock().expect("sink lock"))
    }
}

impl FeedSink for StampSink {
    fn send(&self, batch: FeedBatch) -> Result<(), SinkError> {
        self.batches.lock().expect("sink lock").push((Instant::now(), batch));
        Ok(())
    }
}

fn fixture(stem: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../claude-spike/fixtures/{stem}.ndjson"))
}

/// The percentile of an already-sorted slice, nearest-rank.
fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let i = ((sorted.len() as f64) * p) as usize;
    sorted[i.min(sorted.len() - 1)]
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Every `seq` a session running `script` from seq 0 would have written a feed row at, given that
/// its last envelope, `exit_seq`, was the replay's own `SessionExited`.
///
/// Not an estimate: `terse_line` is the same function `feed::apply` uses to decide whether an
/// event contributes a row at all, and the replay cycles the script by index.
///
/// `exit_seq` is handled separately and always counts. The terminal event is **not** in the
/// script — `from_fixture` filters `SessionExited` out and the replay mints its own — so folding
/// it into the `(seq - 1) % len` mapping charges it against whatever script slot it happens to
/// land on. That is what a first cut of this function did, and it under-counted by exactly one
/// row on the sessions whose exit landed on a `ContentDelta`.
fn expected_row_seqs(script: &[Event], exit_seq: u64) -> Vec<u64> {
    let mut seqs: Vec<u64> = (1..exit_seq)
        .filter(|seq| {
            let i = ((seq - 1) as usize) % script.len();
            terse_line(&script[i]).is_some()
        })
        .collect();
    debug_assert!(terse_line(&Event::SessionExited {
        reason: brigadier_core::event::ExitReason::Killed,
        exit_code: None,
    })
    .is_some());
    seqs.push(exit_seq);
    seqs
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "a measurement, ~30 s; run it deliberately"]
async fn eight_ordinary_one_flood_one_approval_across_three_projects() {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = Store::open(dir.path()).expect("store opens");
    let run_id = store.run_id().to_owned();
    let sink = Arc::new(StampSink::default());
    let config = SupervisorConfig::new(
        store.handle().clone(),
        &run_id,
        dir.path().to_owned(),
        sink.clone(),
    );
    // The app's own frame interval, untouched.
    let frame_interval = config.frame_interval;
    let sup = Supervisor::new(config);

    // Three projects.
    let mut projects = Vec::new();
    for name in ["alpha", "beta", "gamma"] {
        let root = dir.path().join(name);
        std::fs::create_dir_all(&root).expect("project dir");
        projects.push(sup.add_project(root).await.expect("project added").id);
    }

    // The script every session replays, and the permission request one of them raises: both are
    // the real adapter's translation of a real capture, not hand-written events.
    let ordinary = ReplayDriver::from_fixture(fixture("s1-handshake-and-turn"))
        .await
        .expect("s1 loads");
    let script = ordinary.script().to_vec();
    let asked = ReplayDriver::from_fixture(fixture("s2-can-use-tool-allow"))
        .await
        .expect("s2 loads");
    let kind: RequestKind = asked
        .script()
        .iter()
        .find_map(|e| match e {
            Event::RequestOpened { kind, .. } => Some(kind.clone()),
            _ => None,
        })
        .expect("the s2 capture's can_use_tool becomes a RequestOpened");
    let RequestKind::ToolPermission { tool_name, .. } = &kind else {
        panic!("the capture asks for a tool permission");
    };
    println!("approval kind from the s2 capture: tool_name={tool_name}");

    let ordinary_kind = DriverKind::new("replay-ordinary");
    let flood_kind = DriverKind::new("replay-flood");
    let approval_kind = DriverKind::new("replay-approval");

    let flood_driver = Arc::new(
        ReplayDriver::new(script.clone())
            .with_kind(flood_kind.clone())
            .with_instance_id("replay:flood")
            .with_rate(FLOOD_ROWS_PER_SEC),
    );
    let approval_driver = Arc::new(
        ReplayDriver::new(script.clone())
            .with_kind(approval_kind.clone())
            .with_instance_id("replay:approval")
            .with_rate(ORDINARY_ROWS_PER_SEC)
            .with_approval(ApprovalPlan {
                after: APPROVAL_AT,
                kind: kind.clone(),
                // The app's own park deadline is 600 s; nothing here runs that long.
                timeout: None,
            }),
    );
    sup.register_driver(Arc::new(
        ordinary.with_kind(ordinary_kind.clone()).with_rate(ORDINARY_ROWS_PER_SEC),
    ));
    sup.register_driver(flood_driver.clone());
    sup.register_driver(approval_driver.clone());

    // alpha and beta carry four ordinary sessions each; gamma carries the flood and the one
    // session that raises a prompt, so the prompt competes with the flood for its own project's
    // frame.
    let start = Instant::now();
    let mut ordinary_ids = Vec::new();
    for i in 0..ORDINARY_SESSIONS {
        let project = &projects[i % 2];
        let id = sup
            .start_session(project, &ordinary_kind, StartSession::new(dir.path()))
            .await
            .expect("ordinary session starts");
        ordinary_ids.push((project.clone(), id));
    }
    let flood_id = sup
        .start_session(&projects[2], &flood_kind, StartSession::new(dir.path()))
        .await
        .expect("flood session starts");
    let approval_id = sup
        .start_session(&projects[2], &approval_kind, StartSession::new(dir.path()))
        .await
        .expect("approval session starts");

    // Probe the store while the flood runs and after it stops. A read shares the writer's thread,
    // so its round trip is the write queue's depth in time.
    let probe_session = flood_id.clone();
    let handle = store.handle().clone();
    let probes: Arc<Mutex<Vec<(f64, f64)>>> = Arc::new(Mutex::new(Vec::new()));
    let probe_sink = probes.clone();
    let probe_start = start;
    let probe = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(PROBE_EVERY);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            let t = Instant::now();
            let _ = handle.feed_tail(probe_session.clone(), 1).await;
            let latency = ms(t.elapsed());
            probe_sink
                .lock()
                .expect("probe lock")
                .push((ms(probe_start.elapsed()), latency));
        }
    });

    tokio::time::sleep(FLOOD).await;
    let flood_stopped_at = ms(start.elapsed());
    sup.kill(&flood_id).await.expect("flood session dies");
    tokio::time::sleep(SETTLE).await;
    probe.abort();

    // ---------------------------------------------------------------- gate 1: the approval

    let raised = approval_driver.raised_approval().expect("the plan was raised");
    let stamped = sink.take();
    let mut approval_latency: Option<f64> = None;
    for (at, batch) in &stamped {
        let carries = batch.signals.iter().any(|e| {
            matches!(&e.event, Event::RequestOpened { request_id, .. } if *request_id == raised.request_id)
        });
        if carries {
            approval_latency = Some(ms(at.saturating_duration_since(raised.at)));
            break;
        }
    }
    let approval_latency = approval_latency.expect("the request-opened signal crossed the sink");

    // It is answerable, not merely visible: this is the same call the UI's allow button makes.
    let pending = sup.pending_approvals().await.expect("approvals read");
    let listed = pending.iter().find(|a| a.request_id == raised.request_id);
    let answerable = listed.map(|a| !a.expired).unwrap_or(false);
    let respond_ok =
        sup.respond(&approval_id, raised.request_id.clone(), Decision::allow()).await.is_ok();

    // ---------------------------------------------------------------- gate 2: durable backlog

    let probes = probes.lock().expect("probe lock").clone();
    let during: Vec<f64> = probes
        .iter()
        .filter(|(t, _)| *t < flood_stopped_at)
        .map(|(_, l)| *l)
        .collect();
    let after: Vec<f64> = probes
        .iter()
        .filter(|(t, _)| *t >= flood_stopped_at)
        .map(|(_, l)| *l)
        .collect();
    let tail: Vec<f64> = probes
        .iter()
        .filter(|(t, _)| *t >= flood_stopped_at + 2000.0)
        .map(|(_, l)| *l)
        .collect();
    let sorted = |v: &[f64]| {
        let mut s = v.to_vec();
        s.sort_by(|a, b| a.partial_cmp(b).expect("no NaN"));
        s
    };
    let (ds, as_, ts) = (sorted(&during), sorted(&after), sorted(&tail));

    // ---------------------------------------------------------------- gate 3: lost rows

    // Stop everything, then flush: a row still in the writer's queue is not a lost row.
    for (_, id) in &ordinary_ids {
        let _ = sup.kill(id).await;
    }
    let _ = sup.kill(&approval_id).await;
    tokio::time::sleep(frame_interval * 8).await;
    store.handle().flush().await.expect("store flushes");
    let final_batches = sink.take();

    // The last envelope seq each session reached, from its own `SessionExited` signal.
    let mut last_seq: BTreeMap<String, u64> = BTreeMap::new();
    let mut max_bytes = 0usize;
    let mut worst_rows = 0usize;
    let mut messages = 0usize;
    let mut rows_delivered = 0u64;
    let mut counters: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for (_, batch) in stamped.iter().chain(final_batches.iter()) {
        messages += 1;
        max_bytes = max_bytes.max(serde_json::to_vec(batch).expect("serializes").len());
        worst_rows = worst_rows.max(batch.rows.len());
        rows_delivered += batch.rows.len() as u64;
        for c in &batch.counters {
            counters.insert(c.session_id.clone(), (c.rows_total, c.rows_dropped));
        }
        for signal in &batch.signals {
            if matches!(signal.event, Event::SessionExited { .. }) {
                last_seq.insert(signal.session_id.as_str().to_owned(), signal.seq);
            }
        }
    }

    // Every pure-script session: the store must hold exactly the tail of what it emitted.
    let mut lost = 0i64;
    let mut trimmed = 0i64;
    let mut checked = 0usize;
    let mut report = Vec::new();
    let pure: Vec<(String, SessionId)> = ordinary_ids
        .iter()
        .map(|(_, id)| ("ordinary".to_owned(), id.clone()))
        .chain(std::iter::once(("flood".to_owned(), flood_id.clone())))
        .collect();
    for (label, id) in &pure {
        let Some(&seq) = last_seq.get(id.as_str()) else {
            report.push(format!("{label} {id}: no SessionExited signal seen"));
            continue;
        };
        let expected = expected_row_seqs(&script, seq);
        let stored = store.handle().feed_tail(id.clone(), usize::MAX).await.expect("feed read");
        let stored_seqs: Vec<u64> = stored.iter().map(|r| r.seq).collect();
        let keep = expected.len().min(FEED_CAP);
        let want: Vec<u64> = expected[expected.len() - keep..].to_vec();
        trimmed += (expected.len() - keep) as i64;
        if stored_seqs != want {
            lost += (want.len() as i64) - (stored_seqs.len() as i64);
            report.push(format!(
                "{label} {id}: expected {} rows (of {} emitted), store has {}",
                want.len(),
                expected.len(),
                stored_seqs.len()
            ));
        }
        checked += 1;
    }

    let flood_rows = counters.get(flood_id.as_str()).copied();
    let total_emitted = flood_driver.emitted() + approval_driver.emitted();

    // ---------------------------------------------------------------- report

    let gate1 = approval_latency <= ms(APPROVAL_BUDGET);
    // No growing backlog: the last four seconds of the settle window must be back at the idle
    // cost of a read, an order of magnitude under the frame interval.
    let gate2 = pct(&ts, 1.0) <= ms(frame_interval);
    let gate3 = lost == 0;

    println!("\n=== flood baseline ===");
    println!("frame_interval_ms      {}", ms(frame_interval));
    println!("flood_rows_per_sec     {FLOOD_ROWS_PER_SEC}");
    println!("ordinary_rows_per_sec  {ORDINARY_ROWS_PER_SEC} x {ORDINARY_SESSIONS}");
    println!("flood_seconds          {}", FLOOD.as_secs());
    println!("messages               {messages}");
    println!("max_message_bytes      {max_bytes} (cap {MAX_MESSAGE_BYTES})");
    println!("max_rows_per_message   {worst_rows} (cap {MAX_ROWS_PER_MESSAGE})");
    println!("rows_delivered_to_sink {rows_delivered}");
    println!("flood_counter          {flood_rows:?}  (rows_total, rows_dropped)");
    println!("envelopes_emitted      {total_emitted} (flood + approval drivers)");
    println!();
    println!("GATE 1 approval visible  {}  {approval_latency:.2} ms (budget {} ms)",
        if gate1 { "PASS" } else { "FAIL" }, ms(APPROVAL_BUDGET));
    println!("  answerable={answerable} respond_ok={respond_ok} listed={}", listed.is_some());
    println!("GATE 2 no growing backlog {}", if gate2 { "PASS" } else { "FAIL" });
    println!("  store read round trip, ms");
    println!("    during flood  n={:4} p50 {:8.2} p95 {:8.2} p99 {:8.2} worst {:8.2}",
        ds.len(), pct(&ds, 0.50), pct(&ds, 0.95), pct(&ds, 0.99), pct(&ds, 1.0));
    println!("    after  flood  n={:4} p50 {:8.2} p95 {:8.2} p99 {:8.2} worst {:8.2}",
        as_.len(), pct(&as_, 0.50), pct(&as_, 0.95), pct(&as_, 0.99), pct(&as_, 1.0));
    println!("    +2 s onward   n={:4} p50 {:8.2} p95 {:8.2} p99 {:8.2} worst {:8.2}",
        ts.len(), pct(&ts, 0.50), pct(&ts, 0.95), pct(&ts, 0.99), pct(&ts, 1.0));
    println!("  decay after the flood stopped, ms since stop -> read ms");
    for (t, l) in probes.iter().filter(|(t, _)| *t >= flood_stopped_at).take(20) {
        println!("    {:8.0} {:8.2}", t - flood_stopped_at, l);
    }
    println!("GATE 3 no lost rows      {}  sessions_checked={checked} lost={lost} ring_trimmed={trimmed}",
        if gate3 { "PASS" } else { "FAIL" });
    for line in &report {
        println!("  {line}");
    }
    println!("=== end ===\n");

    // Structural invariants, which are not the gates and must hold whatever the numbers say.
    assert!(max_bytes < MAX_MESSAGE_BYTES, "a message crossed the eval cliff");
    assert!(worst_rows <= MAX_ROWS_PER_MESSAGE, "a message carried too many rows");
    assert_eq!(checked, ORDINARY_SESSIONS + 1, "every pure-script session was reconstructed");

    sup.shutdown_with(Duration::from_secs(5)).await;
    store.close().await.expect("store closes");
}
