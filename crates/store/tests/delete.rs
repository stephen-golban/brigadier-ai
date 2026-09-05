//! Deleting a session, and deleting a project — the cascade map, checked rather than assumed.
//!
//! Every test here writes into a tempdir. The owner's real database at
//! `~/Library/Application Support/ai.brigadier.app/brigadier.sqlite` is never opened.

use std::time::{Duration, SystemTime};

use brigadier_core::approval::PendingApproval;
use brigadier_core::driver::McpPolicy;
use brigadier_core::event::{RequestId, RequestKind, SessionId};
use brigadier_store::feed::FeedKind;
use brigadier_store::{
    IntentRow, KnownIntentKind, PhaseRow, PlanRevisionRow, PlanRow, ProjectRow, SessionRow, Store, UnknownBin,
    UnknownRow, WorkOrderRow, WorkOrderState,
};

fn ms(n: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_millis(n)
}

fn permission(tool: &str) -> RequestKind {
    RequestKind::ToolPermission {
        tool_name: tool.to_owned(),
        input_excerpt: "{}".to_owned(),
        suggestions: Vec::new(),
        tool_call_id: None,
    }
}

/// A project, two sessions under it, feed rows, approvals, intents, and a full plan tree whose
/// one work order names session `s1`.
///
/// The fixture touches **every** table in the cascade map, which is the only way a test of a
/// cascade can fail honestly.
async fn seeded(dir: &std::path::Path) -> Store {
    let store = Store::open(dir).expect("open");
    let h = store.handle();

    h.upsert_project(ProjectRow {
        id: "p1".to_owned(),
        name: "portal".to_owned(),
        root_path: "/r".into(),
        created_at: ms(1),
        mcp: McpPolicy::Off,
    })
    .await
    .expect("project");
    // A second project, so every assertion below can also say what was *not* touched.
    h.upsert_project(ProjectRow {
        id: "p2".to_owned(),
        name: "other".to_owned(),
        root_path: "/other".into(),
        created_at: ms(2),
        mcp: McpPolicy::Off,
    })
    .await
    .expect("second project");

    for (id, project) in [("s1", "p1"), ("s2", "p1"), ("s3", "p2")] {
        let mut row = SessionRow::new(SessionId::new(id));
        row.project_id = Some(project.to_owned());
        row.started_at = Some(ms(10));
        h.upsert_session(row).await.expect("session");
    }
    for (n, id) in ["s1", "s2", "s3"].iter().enumerate() {
        for seq in 1..=3u64 {
            h.feed(
                SessionId::new(*id),
                seq + n as u64 * 100,
                ms(20 + seq),
                FeedKind::Text,
                format!("{id} line {seq}"),
            )
            .await
            .expect("feed");
        }
        h.approval_opened(
            SessionId::new(*id),
            PendingApproval {
                request_id: RequestId::new(format!("r-{id}")),
                kind: permission("Write"),
                opened_at: ms(30),
            },
        )
        .await
        .expect("approval");
        let mut intent = IntentRow::new(format!("i-{id}"), KnownIntentKind::WorktreeAdd, ms(31));
        intent.session_id = Some(SessionId::new(*id));
        h.intent_open(intent).await.expect("intent");
    }
    // One intent hung off the project alone, which no session id would ever find.
    let mut project_intent = IntentRow::new("i-p1", KnownIntentKind::PhaseCommit, ms(32));
    project_intent.project_id = Some("p1".to_owned());
    h.intent_open(project_intent).await.expect("project intent");

    h.upsert_plan(PlanRow::new("pl1", "p1", "build the portal", ms(40))).await.expect("plan");
    h.upsert_phase(PhaseRow::new("ph1", "pl1", 0, "schema")).await.expect("phase");
    h.plan_revised(PlanRevisionRow::new("rev1", "pl1", 1, ms(41), "scope moved"))
        .await
        .expect("revision");
    h.upsert_unknown(UnknownRow::new("u1", "pl1", UnknownBin::Owner, "who posts jobs?", ms(42)))
        .await
        .expect("unknown");
    let mut order = WorkOrderRow::new("wo1", "ph1", "write the schema");
    order.session_id = Some(SessionId::new("s1"));
    order.state = WorkOrderState::Dispatched;
    order.dispatched_at = Some(ms(43));
    h.upsert_work_order(order).await.expect("work order");

    h.flush().await.expect("flush");
    store
}

/// A session's own rows go, and every one of its dependants goes with it.
///
/// The counts are the assertion and not a decoration: SQLite reports nothing about rows a foreign
/// key cascaded, so a delete that returned `changes()` would answer `1` here whether the three
/// feed rows went or stayed.
#[tokio::test]
async fn deleting_a_session_takes_its_feed_approvals_and_intents_with_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = seeded(dir.path()).await;
    let h = store.handle();

    let outcome = h
        .delete_session(SessionId::new("s1"))
        .await
        .expect("delete")
        .expect("the session was there");

    assert_eq!(outcome.rows.sessions, 1);
    assert_eq!(outcome.rows.feed, 3, "three feed rows went with it");
    assert_eq!(outcome.rows.approvals, 1);
    assert_eq!(outcome.rows.intents, 1);
    assert_eq!(outcome.rows.projects, 0, "a session delete never touches a project");
    assert_eq!(outcome.ids.sessions, vec!["s1".to_owned()]);

    assert!(h.session(SessionId::new("s1")).await.expect("read").is_none(), "the row is gone");
    assert!(h.feed_tail(SessionId::new("s1"), 10).await.expect("feed").is_empty());
    assert!(h.approvals(SessionId::new("s1")).await.expect("approvals").is_empty());
    assert!(h.session_intents(SessionId::new("s1")).await.expect("intents").is_empty());

    // The sibling is untouched.
    assert!(h.session(SessionId::new("s2")).await.expect("read").is_some());
    assert_eq!(h.feed_tail(SessionId::new("s2"), 10).await.expect("feed").len(), 3);

    store.close().await.expect("close");
}

/// The one relationship in the schema that is **not** a cascade, and it is deliberate: the plan is
/// the durable thing and must outlive the session that ran it.
///
/// If this ever starts failing because the work order vanished, the fix is to restore
/// `ON DELETE SET NULL`, never to update the test.
// see the migration 4 comment in `crates/store/src/schema.rs` and docs/vision.md §8.
#[tokio::test]
async fn a_deleted_session_leaves_its_work_order_standing_with_a_null_session() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = seeded(dir.path()).await;
    let h = store.handle();

    let outcome = h.delete_session(SessionId::new("s1")).await.expect("delete").expect("was there");
    assert_eq!(outcome.rows.work_orders, 0, "the order was not deleted");
    assert_eq!(outcome.rows.work_orders_orphaned, 1, "it was kept, and the report says so");

    let orders = h.work_orders("ph1").await.expect("orders");
    assert_eq!(orders.len(), 1, "the plan still records that an order was dispatched");
    assert_eq!(orders[0].id, "wo1");
    assert_eq!(orders[0].session_id, None, "and it no longer names a session that is gone");
    assert_eq!(orders[0].state, WorkOrderState::Dispatched, "its state is untouched");

    store.close().await.expect("close");
}

/// Deleting a project takes its sessions with it — and their feed, approvals and intents — plus
/// the whole plan tree.
#[tokio::test]
async fn deleting_a_project_takes_its_sessions_and_its_plan_tree() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = seeded(dir.path()).await;
    let h = store.handle();

    let outcome =
        h.delete_project("p1".to_owned()).await.expect("delete").expect("the project was there");

    assert_eq!(outcome.rows.projects, 1);
    assert_eq!(outcome.rows.sessions, 2, "both sessions of p1");
    assert_eq!(outcome.rows.feed, 6, "three rows each");
    assert_eq!(outcome.rows.approvals, 2);
    assert_eq!(outcome.rows.intents, 3, "two by session, one by project");
    assert_eq!(outcome.rows.plans, 1);
    assert_eq!(outcome.rows.phases, 1);
    assert_eq!(outcome.rows.plan_revisions, 1);
    assert_eq!(outcome.rows.unknowns, 1);
    assert_eq!(outcome.rows.work_orders, 1, "the order went with its phase, this time");
    assert_eq!(
        outcome.rows.work_orders_orphaned, 0,
        "no other project's phase named one of these sessions"
    );

    let mut sessions = outcome.ids.sessions.clone();
    sessions.sort();
    assert_eq!(sessions, vec!["s1".to_owned(), "s2".to_owned()]);
    assert_eq!(outcome.ids.phases, vec!["ph1".to_owned()], "the ids the caller needs for gate logs");

    assert!(h.project("p1").await.expect("read").is_none());
    assert!(h.session(SessionId::new("s1")).await.expect("read").is_none());
    assert!(h.session(SessionId::new("s2")).await.expect("read").is_none());
    assert!(h.current_plan("p1").await.expect("read").is_none());
    assert!(h.phases("pl1").await.expect("read").is_empty());
    assert!(h.work_orders("ph1").await.expect("read").is_empty());
    assert!(h.unknowns("pl1").await.expect("read").is_empty());
    assert!(h.plan_revisions("pl1").await.expect("read").is_empty());
    assert!(h.unsettled_intents().await.expect("read").iter().all(|i| i.id == "i-s3"));

    // The other project is entirely untouched.
    assert!(h.project("p2").await.expect("read").is_some());
    assert!(h.session(SessionId::new("s3")).await.expect("read").is_some());
    assert_eq!(h.feed_tail(SessionId::new("s3"), 10).await.expect("feed").len(), 3);

    store.close().await.expect("close");
}

/// A delete of something that is not there is not a failure: the caller wanted the row gone.
#[tokio::test]
async fn deleting_what_is_not_there_answers_none_rather_than_erring() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = seeded(dir.path()).await;
    let h = store.handle();

    assert!(h.delete_session(SessionId::new("nope")).await.expect("delete").is_none());
    assert!(h.delete_project("nope".to_owned()).await.expect("delete").is_none());
    // And nothing else moved.
    assert!(h.session(SessionId::new("s1")).await.expect("read").is_some());
    assert!(h.project("p1").await.expect("read").is_some());

    store.close().await.expect("close");
}

/// The delete is durable on return — not merely queued.
///
/// `delete_session` answers only after the transaction carrying it has committed, so a store
/// closed the instant it returns still comes back without the session. A fire-and-forget op
/// would leave the row in the file here.
#[tokio::test]
async fn a_delete_is_on_disk_before_it_answers() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = seeded(dir.path()).await;
    store.handle().delete_session(SessionId::new("s1")).await.expect("delete").expect("was there");
    store.close().await.expect("close");

    let reopened = Store::open(dir.path()).expect("reopen");
    assert!(
        reopened.handle().session(SessionId::new("s1")).await.expect("read").is_none(),
        "the delete did not survive the reopen"
    );
    assert!(reopened.handle().session(SessionId::new("s2")).await.expect("read").is_some());
    reopened.close().await.expect("close");
}
