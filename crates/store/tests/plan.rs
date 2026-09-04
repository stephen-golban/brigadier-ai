//! The plan store through the handle: round trips, the transitions an upsert cannot express, and
//! the records `docs/vision.md` §8 and §4 step 5 exist to keep.

use std::time::{Duration, SystemTime};

use brigadier_core::driver::McpPolicy;
use brigadier_core::event::SessionId;
use brigadier_store::schema::{PLAN_TEXT_LIMIT, SUMMARY_JSON_LIMIT};
use brigadier_store::{
    Error, PhaseRow, PhaseState, PlanRevisionRow, PlanRow, PlanStatus, ProjectRow, SessionRow,
    Store, UnknownBin, UnknownRow, UnknownState, WorkOrderRow, WorkOrderState,
};

fn ms(n: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_millis(n)
}

/// A store with one project, ready for a plan.
async fn open(dir: &std::path::Path) -> Store {
    let store = Store::open(dir).expect("open");
    store
        .handle()
        .upsert_project(ProjectRow {
            id: "p1".to_owned(),
            name: "job-portal".to_owned(),
            root_path: "/r".into(),
            created_at: ms(1),
            mcp: McpPolicy::Off,
        })
        .await
        .expect("project");
    store
}

/// A plan, its checklist, its unknowns and its work orders — written once, read back whole, in
/// the shape the plan card of `docs/vision.md` §9 renders.
#[tokio::test]
async fn a_plan_and_its_checklist_round_trip() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path()).await;
    let h = store.handle();

    h.upsert_plan(PlanRow::new("pl1", "p1", "build a job portal", ms(10)))
        .await
        .expect("plan");
    for (n, title) in ["schema + auth", "API routes", "landing page"].iter().enumerate() {
        let mut phase = PhaseRow::new(format!("ph{n}"), "pl1", n as u32, *title);
        phase.definition_of_done = format!("{title} works end to end");
        phase.verify_command = if n == 2 { None } else { Some("npm test".to_owned()) };
        h.upsert_phase(phase).await.expect("phase");
    }
    h.upsert_unknown(UnknownRow::new(
        "u1",
        "pl1",
        UnknownBin::Owner,
        "who posts jobs?",
        ms(11),
    ))
    .await
    .expect("unknown");
    let mut order = WorkOrderRow::new("wo1", "ph0", "write the schema");
    order.session_id = Some(SessionId::new("s1"));
    order.owned_paths_json = r#"["src/db/**"]"#.to_owned();
    order.state = WorkOrderState::Dispatched;
    order.worktree_path = Some("/tmp/wt".into());
    order.branch = Some("phase-0".to_owned());
    order.dispatched_at = Some(ms(12));
    h.upsert_work_order(order).await.expect("work order");
    h.flush().await.expect("flush");

    let plan = h.current_plan("p1").await.expect("read").expect("a plan");
    assert_eq!(plan.id, "pl1");
    assert_eq!(plan.goal, "build a job portal");
    assert_eq!(plan.status, PlanStatus::Draft, "an unapproved plan is a draft");
    assert_eq!(plan.approved_at, None);
    assert_eq!(plan.revision, 0);

    let phases = h.phases("pl1").await.expect("phases");
    assert_eq!(phases.len(), 3);
    assert_eq!(
        phases.iter().map(|p| p.ordinal).collect::<Vec<_>>(),
        vec![0, 1, 2],
        "phases come back in ordinal order"
    );
    assert_eq!(phases[1].title, "API routes");
    assert_eq!(phases[1].verify_command.as_deref(), Some("npm test"));
    assert_eq!(
        phases[2].verify_command, None,
        "a phase with no verify command says so, rather than pretending to have one"
    );
    assert_eq!(phases[0].state, PhaseState::Pending);
    assert_eq!(phases[0].attempts, 0);

    let unknowns = h.unknowns("pl1").await.expect("unknowns");
    assert_eq!(unknowns.len(), 1);
    assert_eq!(unknowns[0].bin, UnknownBin::Owner);
    assert_eq!(unknowns[0].state, UnknownState::Open);
    assert!(!unknowns[0].skipped_for_just_go);

    let orders = h.work_orders("ph0").await.expect("orders");
    assert_eq!(orders.len(), 1);
    assert_eq!(orders[0].session_id.as_ref().map(|s| s.as_str()), Some("s1"));
    assert_eq!(orders[0].owned_paths_json, r#"["src/db/**"]"#);
    assert_eq!(orders[0].state, WorkOrderState::Dispatched);
    assert_eq!(orders[0].worktree_path.as_deref(), Some(std::path::Path::new("/tmp/wt")));
    assert_eq!(orders[0].branch.as_deref(), Some("phase-0"));
    assert!(h.work_orders("ph1").await.expect("orders").is_empty());
    store.close().await.expect("close");
}

/// The owner approves the envelope once. A second approval does not move the timestamp the
/// autonomous run is authorized by, and an upsert of the goal does not walk it back to draft.
#[tokio::test]
async fn approval_is_stamped_once_and_an_upsert_cannot_move_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path()).await;
    let h = store.handle();
    h.upsert_plan(PlanRow::new("pl1", "p1", "build a job portal", ms(10))).await.expect("plan");
    h.plan_approved("pl1".to_owned(), ms(20)).await.expect("approve");
    h.plan_approved("pl1".to_owned(), ms(30)).await.expect("approve again");
    h.flush().await.expect("flush");

    let plan = h.plan("pl1").await.expect("read").expect("row");
    assert_eq!(plan.status, PlanStatus::Approved);
    assert_eq!(plan.approved_at, Some(ms(20)), "the second approval is a no-op");

    // Restating the goal must not reset the envelope.
    let mut restated = PlanRow::new("pl1", "p1", "build a job portal, with payments", ms(10));
    restated.status = PlanStatus::Draft;
    restated.approved_at = None;
    h.upsert_plan(restated).await.expect("upsert");
    h.flush().await.expect("flush");

    let plan = h.plan("pl1").await.expect("read").expect("row");
    assert_eq!(plan.goal, "build a job portal, with payments", "the goal is rewritten");
    assert_eq!(plan.status, PlanStatus::Approved, "the approval is not");
    assert_eq!(plan.approved_at, Some(ms(20)));
    store.close().await.expect("close");
}

/// `docs/vision.md` §8: brigadier may rewrite phases inside the approved goal, **recording what
/// changed and why** — and a revision that moved a definition of done is flagged, because that
/// one escalates to fusion and then to the owner.
#[tokio::test]
async fn a_revision_records_why_and_flags_a_moved_definition_of_done() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path()).await;
    let h = store.handle();
    h.upsert_plan(PlanRow::new("pl1", "p1", "goal", ms(10))).await.expect("plan");

    let mut first = PlanRevisionRow::new("r1", "pl1", 1, ms(20), "split phase 2 in two");
    first.change_json = r#"{"added":["ph3"]}"#.to_owned();
    h.plan_revised(first).await.expect("revision");

    let mut second = PlanRevisionRow::new("r2", "pl1", 2, ms(30), "auth is now OAuth-only");
    second.moved_definition_of_done = true;
    h.plan_revised(second).await.expect("revision");
    h.flush().await.expect("flush");

    let revisions = h.plan_revisions("pl1").await.expect("revisions");
    assert_eq!(revisions.len(), 2);
    assert_eq!(revisions[0].reason, "split phase 2 in two");
    assert!(!revisions[0].moved_definition_of_done);
    assert_eq!(revisions[1].reason, "auth is now OAuth-only");
    assert!(revisions[1].moved_definition_of_done, "the one that escalates is flagged");

    let plan = h.plan("pl1").await.expect("read").expect("row");
    assert_eq!(plan.revision, 2, "the counter and the newest revision row agree");
    store.close().await.expect("close");
}

/// A phase attempt clears what an upsert cannot clear, and the gate's real exit code settles it.
#[tokio::test]
async fn a_second_attempt_clears_the_first_attempts_gate_result() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path()).await;
    let h = store.handle();
    h.upsert_plan(PlanRow::new("pl1", "p1", "goal", ms(10))).await.expect("plan");
    let mut phase = PhaseRow::new("ph0", "pl1", 0, "schema + auth");
    phase.verify_command = Some("npm test".to_owned());
    h.upsert_phase(phase).await.expect("phase");

    h.phase_attempt_started("ph0".to_owned(), ms(20)).await.expect("attempt");
    h.phase_settled(
        "ph0".to_owned(),
        PhaseState::Blocked,
        Some(1),
        Some("2 failing".to_owned()),
        None,
        ms(30),
    )
    .await
    .expect("settle");
    h.flush().await.expect("flush");

    let red = &h.phases("pl1").await.expect("phases")[0];
    assert_eq!(red.state, PhaseState::Blocked);
    assert_eq!(red.attempts, 1);
    assert_eq!(red.started_at, Some(ms(20)));
    assert_eq!(red.ended_at, Some(ms(30)));
    assert_eq!(red.last_exit_code, Some(1));
    assert_eq!(red.last_evidence.as_deref(), Some("2 failing"));

    // Second attempt. The stale red result must be gone while it is running, or the loop reads a
    // phase as failed while a worker is still in it.
    h.phase_attempt_started("ph0".to_owned(), ms(40)).await.expect("attempt");
    h.flush().await.expect("flush");
    let running = &h.phases("pl1").await.expect("phases")[0];
    assert_eq!(running.state, PhaseState::Running);
    assert_eq!(running.attempts, 2);
    assert_eq!(running.started_at, Some(ms(20)), "the first start time is kept");
    assert_eq!(running.ended_at, None, "a running phase carries no end time");
    assert_eq!(running.last_exit_code, None, "nor a stale exit code");
    assert_eq!(running.last_evidence, None, "nor stale evidence");

    h.phase_settled("ph0".to_owned(), PhaseState::Green, Some(0), None, Some("abc123".to_owned()), ms(50))
        .await
        .expect("settle");
    h.flush().await.expect("flush");
    let green = &h.phases("pl1").await.expect("phases")[0];
    assert_eq!(green.state, PhaseState::Green);
    assert_eq!(green.last_exit_code, Some(0), "0 is the only value that means green");
    assert_eq!(green.commit_sha.as_deref(), Some("abc123"));

    // An upsert of the phase's content leaves the progress alone.
    let mut restated = PhaseRow::new("ph0", "pl1", 0, "schema + auth + roles");
    restated.verify_command = Some("npm test -- --run".to_owned());
    h.upsert_phase(restated).await.expect("upsert");
    h.flush().await.expect("flush");
    let after = &h.phases("pl1").await.expect("phases")[0];
    assert_eq!(after.title, "schema + auth + roles");
    assert_eq!(after.verify_command.as_deref(), Some("npm test -- --run"));
    assert_eq!(after.state, PhaseState::Green, "an upsert is not a transition");
    assert_eq!(after.attempts, 2);
    store.close().await.expect("close");
}

/// `docs/vision.md` §4 step 5: *"'Just go' is always one click away, and skipping is recorded —
/// when a phase later fails on a question that was waved off, the thread can say which one."*
/// That sentence is this table's reason to exist.
#[tokio::test]
async fn just_go_records_which_question_was_waved_off() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path()).await;
    let h = store.handle();
    h.upsert_plan(PlanRow::new("pl1", "p1", "goal", ms(10))).await.expect("plan");
    h.upsert_unknown(UnknownRow::new("u1", "pl1", UnknownBin::Owner, "auth model?", ms(11)))
        .await
        .expect("unknown");
    h.upsert_unknown(UnknownRow::new(
        "u2",
        "pl1",
        UnknownBin::Research,
        "is this library maintained?",
        ms(12),
    ))
    .await
    .expect("unknown");

    // The owner clicks "just go" on the first; research answers the second to a file.
    h.unknown_settled("u1".to_owned(), UnknownState::Skipped, None, None, true, ms(20))
        .await
        .expect("skip");
    h.unknown_settled(
        "u2".to_owned(),
        UnknownState::Answered,
        Some("maintained; last release 2026-08".to_owned()),
        Some("docs/research/lib.md".into()),
        false,
        ms(21),
    )
    .await
    .expect("answer");
    h.flush().await.expect("flush");

    let rows = h.unknowns("pl1").await.expect("unknowns");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].state, UnknownState::Skipped);
    assert!(rows[0].skipped_for_just_go, "the thread can name the question that was waved off");
    assert_eq!(rows[0].settled_at, Some(ms(20)));
    assert_eq!(rows[1].state, UnknownState::Answered);
    assert!(!rows[1].skipped_for_just_go);
    assert_eq!(rows[1].answer.as_deref(), Some("maintained; last release 2026-08"));
    assert_eq!(
        rows[1].findings_path.as_deref(),
        Some(std::path::Path::new("docs/research/lib.md")),
        "research findings go to a file; the store holds the pointer"
    );

    // A late settle does not overwrite a real answer.
    h.unknown_settled("u2".to_owned(), UnknownState::Skipped, None, None, true, ms(22))
        .await
        .expect("late");
    h.flush().await.expect("flush");
    let rows = h.unknowns("pl1").await.expect("unknowns");
    assert_eq!(rows[1].state, UnknownState::Answered, "the answered row is guarded");
    assert!(!rows[1].skipped_for_just_go);
    store.close().await.expect("close");
}

/// Workers return reports, not transcripts — and a bounded one, because nothing caps this table.
#[tokio::test]
async fn a_work_order_keeps_a_bounded_report_and_is_settled_once() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path()).await;
    let h = store.handle();
    h.upsert_plan(PlanRow::new("pl1", "p1", "goal", ms(10))).await.expect("plan");
    h.upsert_phase(PhaseRow::new("ph0", "pl1", 0, "schema")).await.expect("phase");
    let mut order = WorkOrderRow::new("wo1", "ph0", "write the schema");
    order.state = WorkOrderState::Dispatched;
    order.dispatched_at = Some(ms(12));
    h.upsert_work_order(order).await.expect("order");

    let transcript = "x".repeat(PLAN_TEXT_LIMIT * 3);
    h.work_order_finished(
        "wo1".to_owned(),
        WorkOrderState::Reported,
        Some(transcript.clone()),
        ms(40),
    )
    .await
    .expect("finish");
    h.flush().await.expect("flush");

    let got = &h.work_orders("ph0").await.expect("orders")[0];
    assert_eq!(got.state, WorkOrderState::Reported);
    assert_eq!(got.finished_at, Some(ms(40)));
    let report = got.report.as_deref().expect("a report");
    assert!(report.len() <= PLAN_TEXT_LIMIT, "the report is {} bytes", report.len());
    assert!(report.len() < transcript.len(), "a transcript-sized value is truncated");

    // A late duplicate cannot overwrite the report that was actually returned.
    h.work_order_finished("wo1".to_owned(), WorkOrderState::Failed, Some("nope".to_owned()), ms(50))
        .await
        .expect("late");
    h.flush().await.expect("flush");
    let got = &h.work_orders("ph0").await.expect("orders")[0];
    assert_eq!(got.state, WorkOrderState::Reported);
    assert_eq!(got.finished_at, Some(ms(40)));
    assert_ne!(got.report.as_deref(), Some("nope"));

    // A partial upsert does not clear what dispatch recorded.
    let mut partial = WorkOrderRow::new("wo1", "ph0", "write the schema");
    partial.state = WorkOrderState::Reported;
    h.upsert_work_order(partial).await.expect("upsert");
    h.flush().await.expect("flush");
    let got = &h.work_orders("ph0").await.expect("orders")[0];
    assert_eq!(got.dispatched_at, Some(ms(12)), "COALESCE keeps what the first upsert knew");
    store.close().await.expect("close");
}

/// **A finished order is history, and an upsert must not rewrite it.**
///
/// The upsert's `ON CONFLICT` rewrote `state` unconditionally, so a stale copy of the plan — a
/// retry, a re-dispatch loop that had not read the report yet — walked a `reported` order back to
/// `dispatched`, and the loop reads exactly that column to decide what still needs running. The
/// same work then runs twice, which is the failure the `intents` table exists to prevent, one
/// table over.
#[tokio::test]
async fn an_upsert_cannot_walk_a_finished_work_order_back() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path()).await;
    let h = store.handle();
    h.upsert_plan(PlanRow::new("pl1", "p1", "goal", ms(10))).await.expect("plan");
    h.upsert_phase(PhaseRow::new("ph0", "pl1", 0, "schema")).await.expect("phase");
    let mut order = WorkOrderRow::new("wo1", "ph0", "write the schema");
    order.owned_paths_json = r#"["src/db/**"]"#.to_owned();
    order.state = WorkOrderState::Dispatched;
    order.dispatched_at = Some(ms(12));
    h.upsert_work_order(order).await.expect("order");
    h.work_order_finished(
        "wo1".to_owned(),
        WorkOrderState::Reported,
        Some("the schema is written".to_owned()),
        ms(40),
    )
    .await
    .expect("finish");
    h.flush().await.expect("flush");

    // A stale upsert: `WorkOrderRow::new` is `pending`, owning nothing, and knows no dispatch.
    let mut stale = WorkOrderRow::new("wo1", "ph0", "write the schema (restated)");
    stale.state = WorkOrderState::Pending;
    h.upsert_work_order(stale).await.expect("upsert");
    h.flush().await.expect("flush");

    let got = &h.work_orders("ph0").await.expect("orders")[0];
    assert_eq!(got.state, WorkOrderState::Reported, "a finished order does not go back to pending");
    assert_ne!(got.state, WorkOrderState::Pending, "which would authorize running it again");
    assert_eq!(got.finished_at, Some(ms(40)), "nor lose the time it finished");
    assert_eq!(got.report.as_deref(), Some("the schema is written"), "nor its report");
    assert_eq!(
        got.owned_paths_json, r#"["src/db/**"]"#,
        "nor the record of what it owned, which is what kept two workers off one file"
    );
    assert_eq!(got.title, "write the schema", "a finished order's title is history too");
    store.close().await.expect("close");
}

/// **A revision with no reason is refused**, not stored and not filled in.
///
/// `plan_revisions.reason` is `TEXT NOT NULL`, which does not mean non-empty; `docs/vision.md` §8
/// wants what changed *and why*, and a revision nobody explained is the thing the table exists to
/// prevent. The refusal is typed, so the caller has to handle it rather than discover later that
/// the row is blank.
#[tokio::test]
async fn a_revision_with_no_reason_is_refused_and_the_counter_does_not_move() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path()).await;
    let h = store.handle();
    h.upsert_plan(PlanRow::new("pl1", "p1", "goal", ms(10))).await.expect("plan");

    for blank in ["", "   \n"] {
        let row = PlanRevisionRow::new("r1", "pl1", 1, ms(20), blank);
        match h.plan_revised(row).await {
            Err(Error::Required { field }) => assert_eq!(field, "plan_revisions.reason"),
            other => panic!("an empty reason must be refused, got {other:?}"),
        }
    }
    h.flush().await.expect("flush");

    assert!(h.plan_revisions("pl1").await.expect("revisions").is_empty(), "nothing was recorded");
    assert_eq!(
        h.plan("pl1").await.expect("read").expect("row").revision,
        0,
        "and the counter did not move, so the history has no hole in it"
    );

    // A real reason still goes through, so the guard is on emptiness and nothing else.
    h.plan_revised(PlanRevisionRow::new("r1", "pl1", 1, ms(20), "split phase 2"))
        .await
        .expect("revision");
    h.flush().await.expect("flush");
    assert_eq!(h.plan_revisions("pl1").await.expect("revisions").len(), 1);
    store.close().await.expect("close");
}

/// **Every free-text column of the plan tables is bounded at the write** — the claim migration 4
/// makes about itself. Each one is handed a transcript-sized value at once, and each comes back
/// inside the bound.
///
/// The **JSON** columns are the exception that proves the rule: they are **replaced** by the
/// oversized placeholder, never truncated, and what comes back still parses. `bounded()` appends
/// `…`, which turns a JSON document into text that no longer decodes — and `owned_paths_json` is
/// what stops two workers writing the same file, so a value that cannot be parsed is a
/// correctness bug, not a display one.
///
/// All three of the crate's caller-supplied JSON columns are checked here together —
/// `plan_revisions.change_json`, `work_orders.owned_paths_json` and `sessions.summary_json` — so
/// that fixing two of them and leaving the third, which is what happened, fails a test rather
/// than passing review. (`approvals.kind_json` and `intents.detail_json` take the same helper and
/// are proved in `tests/approvals.rs` and `tests/intents.rs`.)
#[tokio::test]
async fn every_free_text_column_is_bounded_and_the_json_columns_still_parse() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path()).await;
    let h = store.handle();
    let huge = "x".repeat(PLAN_TEXT_LIMIT * 3);
    let bound = |column: &str, value: &str| {
        assert!(
            value.len() <= PLAN_TEXT_LIMIT,
            "{column} kept {} bytes, past the {PLAN_TEXT_LIMIT} byte bound",
            value.len()
        );
    };

    h.upsert_plan(PlanRow::new("pl1", "p1", huge.clone(), ms(10))).await.expect("plan");
    let mut phase = PhaseRow::new("ph0", "pl1", 0, huge.clone());
    phase.definition_of_done = huge.clone();
    phase.verify_command = Some(huge.clone());
    phase.base_sha = Some(huge.clone());
    h.upsert_phase(phase).await.expect("phase");
    let mut revision = PlanRevisionRow::new("r1", "pl1", 1, ms(20), huge.clone());
    revision.change_json = format!(r#"{{"added":["{huge}"]}}"#);
    h.plan_revised(revision).await.expect("revision");
    let mut unknown = UnknownRow::new("u1", "pl1", UnknownBin::Owner, huge.clone(), ms(11));
    unknown.findings_path = Some(huge.clone().into());
    h.upsert_unknown(unknown).await.expect("unknown");
    h.unknown_settled(
        "u1".to_owned(),
        UnknownState::Answered,
        Some(huge.clone()),
        Some(huge.clone().into()),
        false,
        ms(21),
    )
    .await
    .expect("settle");
    let mut order = WorkOrderRow::new("wo1", "ph0", huge.clone());
    order.owned_paths_json = format!(r#"["{huge}"]"#);
    order.branch = Some(huge.clone());
    order.worktree_path = Some(huge.clone().into());
    order.state = WorkOrderState::Dispatched;
    h.upsert_work_order(order).await.expect("order");
    h.work_order_finished("wo1".to_owned(), WorkOrderState::Reported, Some(huge.clone()), ms(40))
        .await
        .expect("finish");
    h.phase_settled(
        "ph0".to_owned(),
        PhaseState::Green,
        Some(0),
        Some(huge.clone()),
        Some(huge.clone()),
        ms(50),
    )
    .await
    .expect("settle");
    // Not a plan table, but the third JSON column and the one the first pass missed.
    let session = SessionId::new("s-json");
    let mut row = SessionRow::new(session.clone());
    row.summary_json = Some(format!(r#"{{"last_turn_id":"{huge}"}}"#));
    h.upsert_session(row).await.expect("session");
    h.flush().await.expect("flush");

    bound("plans.goal", &h.plan("pl1").await.expect("read").expect("row").goal);

    let phase = h.phases("pl1").await.expect("phases")[0].clone();
    bound("phases.title", &phase.title);
    bound("phases.definition_of_done", &phase.definition_of_done);
    bound("phases.verify_command", phase.verify_command.as_deref().expect("command"));
    bound("phases.base_sha", phase.base_sha.as_deref().expect("base"));
    bound("phases.commit_sha", phase.commit_sha.as_deref().expect("sha"));
    bound("phases.last_evidence", phase.last_evidence.as_deref().expect("evidence"));

    let revision = h.plan_revisions("pl1").await.expect("revisions")[0].clone();
    bound("plan_revisions.reason", &revision.reason);

    let unknown = h.unknowns("pl1").await.expect("unknowns")[0].clone();
    bound("unknowns.question", &unknown.question);
    bound("unknowns.answer", unknown.answer.as_deref().expect("answer"));
    bound(
        "unknowns.findings_path",
        &unknown.findings_path.as_deref().expect("path").to_string_lossy(),
    );

    let order = h.work_orders("ph0").await.expect("orders")[0].clone();
    bound("work_orders.title", &order.title);
    bound("work_orders.branch", order.branch.as_deref().expect("branch"));
    bound(
        "work_orders.worktree_path",
        &order.worktree_path.as_deref().expect("path").to_string_lossy(),
    );
    bound("work_orders.report", order.report.as_deref().expect("report"));

    let summary = h
        .session(session)
        .await
        .expect("read")
        .expect("row")
        .summary_json
        .expect("a summary");

    for (column, limit, value) in [
        ("plan_revisions.change_json", PLAN_TEXT_LIMIT, &revision.change_json),
        ("work_orders.owned_paths_json", PLAN_TEXT_LIMIT, &order.owned_paths_json),
        ("sessions.summary_json", SUMMARY_JSON_LIMIT, &summary),
    ] {
        assert!(
            value.len() <= limit,
            "{column} kept {} bytes, past its {limit} byte bound",
            value.len()
        );
        assert!(!value.contains(&huge), "{column} still holds the whole payload");
        let parsed: serde_json::Value = serde_json::from_str(value).unwrap_or_else(|e| {
            panic!("{column} is no longer JSON after the bound: {e}; stored {value:?}")
        });
        assert_eq!(
            parsed["type"], "oversized",
            "{column} must be replaced by the placeholder, not truncated: {parsed}"
        );
        assert!(
            parsed["bytes"].as_u64().unwrap_or(0) > huge.len() as u64,
            "{column}'s placeholder must say how big the real value was: {parsed}"
        );
    }
    store.close().await.expect("close");
}

/// **A phase's base commit is stored, not recomputed.** `worktree::prepare` branches from the
/// constant `HEAD`, so once the loop commits per phase, two orders dispatched either side of a
/// phase commit would branch from different bases. The base is recorded when the phase starts and
/// read back afterwards — and a later upsert that does not know it must not clear it.
#[tokio::test]
async fn a_phase_remembers_the_commit_its_work_branches_from() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path()).await;
    let h = store.handle();
    h.upsert_plan(PlanRow::new("pl1", "p1", "goal", ms(10))).await.expect("plan");
    h.upsert_phase(PhaseRow::new("ph0", "pl1", 0, "schema")).await.expect("phase");
    h.flush().await.expect("flush");
    assert_eq!(
        h.phases("pl1").await.expect("phases")[0].base_sha,
        None,
        "a phase nothing has started records no base, rather than a `HEAD` that stands in for one"
    );

    let mut started = PhaseRow::new("ph0", "pl1", 0, "schema");
    started.base_sha = Some("deadbeefcafe".to_owned());
    h.upsert_phase(started).await.expect("phase");
    // The re-plan that follows: new title, and no idea what the base was.
    h.upsert_phase(PhaseRow::new("ph0", "pl1", 0, "schema + auth")).await.expect("phase");
    h.flush().await.expect("flush");

    let phase = &h.phases("pl1").await.expect("phases")[0];
    assert_eq!(phase.title, "schema + auth", "the content an upsert owns is rewritten");
    assert_eq!(
        phase.base_sha.as_deref(),
        Some("deadbeefcafe"),
        "and the base the worktrees were cut from is not"
    );

    // **The assertion that matters**, and the one an upsert supplying `None` cannot make: a later
    // upsert carrying a *different* sha must lose too. A base that can be cleared is a nuisance; a
    // base that can move is the bug the column exists to prevent, because the second order then
    // branches from somewhere the first one did not and the merge is against two bases.
    let mut moved = PhaseRow::new("ph0", "pl1", 0, "schema + auth");
    moved.base_sha = Some("0000000000000000000000000000000000000000".to_owned());
    h.upsert_phase(moved).await.expect("phase");
    h.flush().await.expect("flush");

    let phase = &h.phases("pl1").await.expect("phases")[0];
    assert_eq!(
        phase.base_sha.as_deref(),
        Some("deadbeefcafe"),
        "the first sha that became knowable is the base for good; a later one cannot move it"
    );
    store.close().await.expect("close");
}

/// The newest plan is the live one, so a second goal-run does not leave the card showing the old
/// checklist.
#[tokio::test]
async fn the_current_plan_is_the_newest_one_for_the_project() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path()).await;
    let h = store.handle();
    assert_eq!(h.current_plan("p1").await.expect("read"), None, "no plan yet");

    h.upsert_plan(PlanRow::new("pl1", "p1", "first goal", ms(10))).await.expect("plan");
    h.upsert_plan(PlanRow::new("pl2", "p1", "second goal", ms(20))).await.expect("plan");
    h.flush().await.expect("flush");

    let plan = h.current_plan("p1").await.expect("read").expect("row");
    assert_eq!(plan.id, "pl2");
    assert_eq!(h.current_plan("nobody").await.expect("read"), None);
    store.close().await.expect("close");
}
