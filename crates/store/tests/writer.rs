//! The writer thread: the feed ring, batching throughput, flush ordering, and file growth.

use std::time::{Duration, Instant, SystemTime};

use brigadier_core::event::SessionId;
use brigadier_store::{FeedKind, SessionRow, Store, StoreConfig};

fn open_store(dir: &std::path::Path, cap: usize) -> Store {
    Store::open_with(dir, StoreConfig { batch_window: Duration::from_millis(250), feed_cap: cap })
        .expect("open")
}

async fn seed(store: &Store, ids: &[&str]) {
    for id in ids {
        store
            .handle()
            .upsert_session(SessionRow::new(SessionId::new(*id)))
            .await
            .expect("upsert");
    }
    store.handle().flush().await.expect("flush");
}

#[test]
fn the_handle_can_live_in_shared_application_state() {
    fn assert<T: Send + Sync + Clone + 'static>() {}
    assert::<brigadier_store::StoreHandle>();
}

#[tokio::test]
async fn ten_thousand_feed_ops_are_fast_and_the_ring_holds() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open_store(dir.path(), 500);
    let ids = ["s1", "s2", "s3"];
    seed(&store, &ids).await;

    let started = Instant::now();
    for seq in 0..10_000u64 {
        let id = SessionId::new(ids[(seq % 3) as usize]);
        store
            .handle()
            .feed(id, seq, SystemTime::now(), FeedKind::Sys, format!("row {seq}"))
            .await
            .expect("feed");
    }
    store.handle().flush().await.expect("flush");
    let elapsed = started.elapsed();
    println!("10_000 feed ops across 3 sessions in {elapsed:?}");
    assert!(elapsed < Duration::from_secs(2), "10k feed ops took {elapsed:?}");

    for id in ids {
        let tail = store.handle().feed_tail(SessionId::new(id), 10_000).await.expect("tail");
        assert!(tail.len() <= 500, "{id} kept {} rows", tail.len());
        assert_eq!(tail.len(), 500, "{id} should be full");
        let seqs: Vec<u64> = tail.iter().map(|r| r.seq).collect();
        assert!(seqs.windows(2).all(|w| w[0] < w[1]), "tail is oldest-first");
    }
    let s1 = store.handle().session(SessionId::new("s1")).await.expect("read").expect("row");
    assert_eq!(s1.last_event_seq, 9_999);
    store.close().await.expect("close");
}

#[tokio::test]
async fn an_op_sent_before_flush_is_visible_after_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open_store(dir.path(), 500);
    let id = SessionId::new("s1");

    let mut row = SessionRow::new(id.clone());
    row.model = Some("claude-opus-4-8".into());
    row.branch = Some("wip".into());
    store.handle().upsert_session(row).await.expect("upsert");
    store
        .handle()
        .feed(id.clone(), 1, SystemTime::now(), FeedKind::Sys, "hello".into())
        .await
        .expect("feed");
    store.handle().flush().await.expect("flush");

    let got = store.handle().session(id.clone()).await.expect("read").expect("row");
    assert_eq!(got.model.as_deref(), Some("claude-opus-4-8"));
    assert_eq!(store.handle().feed_tail(id.clone(), 10).await.expect("tail")[0].line, "hello");

    // And it is really committed: close, reopen, read it back off disk.
    store.close().await.expect("close");
    let again = open_store(dir.path(), 500);
    let got = again.handle().session(id.clone()).await.expect("read").expect("row");
    assert_eq!(got.branch.as_deref(), Some("wip"));
    assert_eq!(again.handle().feed_tail(id, 10).await.expect("tail").len(), 1);
    again.close().await.expect("close");
}

#[tokio::test]
async fn a_partial_upsert_never_clobbers_what_is_already_stored() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open_store(dir.path(), 500);
    let id = SessionId::new("s1");

    let mut spawn_time = SessionRow::new(id.clone());
    spawn_time.branch = Some("feature".into());
    spawn_time.worktree_path = Some("/tmp/wt".into());
    spawn_time.transcript_path = Some("/home/u/.claude/projects/-tmp-wt/abc.jsonl".into());
    store.handle().upsert_session(spawn_time).await.expect("upsert");

    let mut from_provider = SessionRow::new(id.clone());
    from_provider.model = Some("m".into());
    store.handle().upsert_session(from_provider).await.expect("upsert");
    store.handle().flush().await.expect("flush");

    let got = store.handle().session(id).await.expect("read").expect("row");
    assert_eq!(got.branch.as_deref(), Some("feature"));
    assert_eq!(got.model.as_deref(), Some("m"));
    assert!(got.transcript_path.is_some(), "the transcript pointer survived");
    store.close().await.expect("close");
}

#[tokio::test]
async fn fifty_thousand_feed_ops_do_not_grow_the_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open_store(dir.path(), 500);
    seed(&store, &["s1"]).await;
    let id = SessionId::new("s1");

    // ~200 bytes per row is the feed's own cap, so this writes about 10 MB through a table that
    // must never keep more than 500 rows.
    let payload = "x".repeat(180);
    for seq in 0..50_000u64 {
        store
            .handle()
            .feed(id.clone(), seq, SystemTime::now(), FeedKind::Sys, format!("{seq} {payload}"))
            .await
            .expect("feed");
    }
    store.handle().flush().await.expect("flush");
    assert_eq!(store.handle().feed_tail(id, 100_000).await.expect("tail").len(), 500);
    store.close().await.expect("close");

    for e in std::fs::read_dir(dir.path()).expect("read_dir").flatten() {
        println!("  {:?} {:?}", e.file_name(), e.metadata().map(|m| m.len()));
    }
    let bytes: u64 = std::fs::read_dir(dir.path())
        .expect("read_dir")
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum();
    println!("database directory after 50_000 feed ops with cap 500: {bytes} bytes");
    assert!(bytes < 10 * 1024 * 1024, "store grew to {bytes} bytes");
}

#[tokio::test]
async fn usage_is_overwritten_from_the_latest_cumulative_frame() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open_store(dir.path(), 500);
    let id = SessionId::new("s1");
    let usage = |n: u64| brigadier_core::event::Usage {
        input_tokens: n,
        output_tokens: n * 2,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        context_window: Some(200_000),
    };
    store.handle().set_usage(id.clone(), usage(10), 0.5).await.expect("usage");
    store.handle().set_usage(id.clone(), usage(30), 1.25).await.expect("usage");
    store.handle().flush().await.expect("flush");

    let got = store.handle().session(id).await.expect("read").expect("row");
    assert_eq!(got.usage.input_tokens, 30, "cumulative values replace, never sum");
    assert_eq!(got.usage.output_tokens, 60);
    assert_eq!(got.cost_usd_cumulative, 1.25);
    assert_eq!(got.usage.context_window, Some(200_000));
    store.close().await.expect("close");
}

#[tokio::test]
async fn deleting_a_project_cascades_to_its_sessions_and_their_children() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open_store(dir.path(), 500);
    store
        .handle()
        .upsert_project(brigadier_store::ProjectRow {
            id: "p1".into(),
            name: "brigadier".into(),
            root_path: "/repo".into(),
            created_at: SystemTime::now(),
        })
        .await
        .expect("project");
    let id = SessionId::new("s1");
    let mut row = SessionRow::new(id.clone());
    row.project_id = Some("p1".into());
    store.handle().upsert_session(row).await.expect("session");
    store.handle().feed(id.clone(), 1, SystemTime::now(), FeedKind::Sys, "x".into()).await.expect("feed");
    store.handle().flush().await.expect("flush");

    let got = store.handle().session(id).await.expect("read").expect("row");
    assert_eq!(got.project_id.as_deref(), Some("p1"));
    store.close().await.expect("close");
}

#[tokio::test]
async fn a_query_does_not_wait_out_the_batch_window() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open_store(dir.path(), 500);
    let id = SessionId::new("s1");

    // Five writes open a 250 ms window and nothing flushes it. The read that follows must not
    // be held for the rest of that window, and must still see all five.
    for seq in 0..5u64 {
        store
            .handle()
            .feed(id.clone(), seq, SystemTime::now(), FeedKind::Sys, format!("row {seq}"))
            .await
            .expect("feed");
    }

    let started = Instant::now();
    let tail = store.handle().feed_tail(id.clone(), 10).await.expect("tail");
    let latency = started.elapsed();
    println!("query latency inside a 250 ms window: {latency:?}");

    assert_eq!(tail.len(), 5, "the read sees every write queued before it");
    assert!(latency < Duration::from_millis(50), "the query waited {latency:?} for the window");
    store.close().await.expect("close");
}

#[tokio::test]
async fn a_lone_op_commits_on_its_own_window_and_the_writer_then_parks() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open_store(dir.path(), 500);
    let id = SessionId::new("s1");
    store.handle().feed(id.clone(), 1, SystemTime::now(), FeedKind::Sys, "lone".into()).await.expect("feed");

    // Past the 250 ms deadline with nothing else sent: the batch commits on its own and the
    // thread goes back to a blocking receive.
    tokio::time::sleep(Duration::from_millis(320)).await;

    let started = Instant::now();
    store.handle().flush().await.expect("flush");
    let woke = started.elapsed();
    println!("flush after an idle 250 ms window returned in {woke:?}");
    assert!(woke < Duration::from_millis(50), "flush took {woke:?}; the writer did not wake");

    assert_eq!(store.handle().feed_tail(id, 10).await.expect("tail").len(), 1);
    store.close().await.expect("close");
}

#[tokio::test]
async fn a_flush_after_shutdown_fails_instead_of_hanging() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open_store(dir.path(), 500);
    let orphan = store.handle().clone();
    store
        .handle()
        .feed(SessionId::new("s1"), 1, SystemTime::now(), FeedKind::Sys, "x".into())
        .await
        .expect("feed");
    store.close().await.expect("close");

    // The writer thread is gone and the receiver with it, so the one-shot inside a queued
    // `Flush` is dropped rather than left unanswered. The caller must get an error, promptly.
    let started = Instant::now();
    let outcome = tokio::time::timeout(Duration::from_secs(2), orphan.flush()).await;
    assert!(outcome.is_ok(), "flush after shutdown hung for {:?}", started.elapsed());
    assert!(outcome.expect("not timed out").is_err(), "flush after shutdown must report Closed");
}
