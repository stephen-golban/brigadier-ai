//! Intent records: the barrier, the close guard, the bound, and the retention sweep.
//!
//! `docs/research/intent-records.md` §8.1 is the plan. Items 1, 2, 3 and 9 are here; items 4–8
//! belong to the reconciler, which lives in `crates/supervisor/` and needs `git` subprocesses.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

use brigadier_core::event::SessionId;
use brigadier_store::intents::INTENT_RETENTION;
use brigadier_store::schema::INTENT_DETAIL_LIMIT;
use brigadier_store::{
    IntentKind, IntentOutcome, IntentRow, IntentState, KnownIntentKind, ProjectRow, Store,
    StoreConfig,
};

/// Set on the re-executed test binary to turn `the_child_half_of_the_barrier_test` from a no-op
/// into the crash harness. Its value is the arm: `flush` or `no-flush`.
const BARRIER_ARM: &str = "BRIGADIER_INTENT_BARRIER_ARM";

/// The data directory the child opens.
const BARRIER_DIR: &str = "BRIGADIER_INTENT_BARRIER_DIR";

/// What the child exits with. Not 1 and not 101, which are libtest's own failure codes, so the
/// parent can tell "the child crashed where we told it to" from "the child's test failed".
const BARRIER_EXIT: i32 = 42;

/// A batch window long enough that no batch can commit on the deadline during the test.
///
/// This is what makes the no-flush arm deterministic rather than a race with the default 250 ms
/// window: with 30 s on the clock, anything that reached disk got there because someone forced a
/// commit — `intent_open` for the intent row, `flush()` for the project row — and for no other
/// reason. `intent_open` returning at all inside a 30 s window is itself the proof that it ends
/// the window rather than waiting it out.
const BARRIER_WINDOW: Duration = Duration::from_secs(30);

const BARRIER_INTENT_ID: &str = "i-barrier";

/// A project upserted *after* the intent, and never flushed in the `no-flush` arm.
const BARRIER_PROJECT_ID: &str = "p-after-the-barrier";

fn store(dir: &Path, window: Duration) -> Store {
    Store::open_with(dir, StoreConfig { batch_window: window, feed_cap: 500 }).expect("open")
}

fn row(id: &str, kind: KnownIntentKind, at: SystemTime) -> IntentRow {
    IntentRow::new(id, kind, at)
}

fn ms(n: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_millis(n)
}

// ---------------------------------------------------------------------------------------------
// Item 1 — the barrier. The one assertion the whole design rests on.
// ---------------------------------------------------------------------------------------------

/// The child half. A no-op in an ordinary `cargo test` run: it does its work only when the parent
/// re-executed this binary with [`BARRIER_ARM`] set.
///
/// It cannot be an in-process drop of a [`Store`], which is why this test spawns at all: `Drop`
/// sends `Op::Shutdown` and the batch carrying it commits (`crates/store/src/lib.rs`), so an
/// in-process test would find the row there whether or not anyone flushed.
#[test]
fn the_child_half_of_the_barrier_test() {
    let Ok(arm) = std::env::var(BARRIER_ARM) else { return };
    let dir = std::env::var(BARRIER_DIR).expect("the parent sets the data directory");
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    rt.block_on(async {
        let store = store(Path::new(&dir), BARRIER_WINDOW);
        let mut intent = row(BARRIER_INTENT_ID, KnownIntentKind::WorktreeAdd, ms(1_000));
        intent.subject = Some("/tmp/wt".to_owned());
        intent.baseline = Some("deadbeef".to_owned());
        store.handle().intent_open(intent).await.expect("intent_open");
        // An ordinary fire-and-forget op, sent after the intent's own commit: it is still a
        // `Vec<Op>` entry on the writer thread, and only the flush arm turns it into a row.
        store
            .handle()
            .upsert_project(ProjectRow {
                id: BARRIER_PROJECT_ID.to_owned(),
                name: "after the barrier".to_owned(),
                root_path: "/r".into(),
                created_at: ms(1_001),
                mcp: brigadier_core::driver::McpPolicy::Off,
            })
            .await
            .expect("upsert_project");
        if arm == "flush" {
            store.handle().flush().await.expect("flush");
        }
        // Leave the way a crash does: no `Drop`, no `Shutdown`, no commit on the way out. The
        // writer thread is parked in `recv_timeout` with 30 s left on its window.
        std::process::exit(BARRIER_EXIT);
    });
}

/// **Item 1.** `intent_open()` is the barrier: it returns only once the row is committed.
///
/// Two arms, each a real process that dies without unwinding. The intent row survives **both**,
/// with no flush behind it — that is the guarantee. The project row sent immediately after it
/// survives only the arm that flushed, which is what proves the intent row's survival is the
/// barrier's doing and not the writer committing of its own accord.
///
/// The wall clock is the third assertion and it is not decoration. The child's window is
/// [`BARRIER_WINDOW`] — 30 s — so a build where `intent_open` waits the window out rather than
/// ending it would still leave the row on disk and still pass the two assertions above, on a
/// child that took half a minute to exit. Timing them is what tells the two apart.
#[tokio::test]
async fn an_intent_row_is_committed_before_intent_open_returns() {
    for (arm, project_survives) in [("flush", true), ("no-flush", false)] {
        let dir = tempfile::tempdir().expect("tempdir");
        let exe = std::env::current_exe().expect("this test binary");
        let started = std::time::Instant::now();
        let status = Command::new(&exe)
            .args(["--exact", "--test-threads", "1", "the_child_half_of_the_barrier_test"])
            .env(BARRIER_ARM, arm)
            .env(BARRIER_DIR, dir.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("re-execute this test binary as the crash harness");
        let elapsed = started.elapsed();
        assert_eq!(
            status.code(),
            Some(BARRIER_EXIT),
            "the {arm} child must exit where we told it to, not fail its own assertions"
        );
        assert!(
            elapsed < BARRIER_WINDOW / 2,
            "{arm}: the child took {elapsed:?} of a {BARRIER_WINDOW:?} window, so its row \
             reaching disk is the coalescing deadline's doing and not the barrier's"
        );

        // The child held the data-dir lock and the process is gone, so this reopen also proves
        // the flock was released by process exit.
        let reopened = store(dir.path(), Duration::from_millis(250));
        let found = reopened.handle().unsettled_intents().await.expect("read");
        assert_eq!(found.len(), 1, "{arm}: the intent row must be on disk, got {found:?}");
        let got = &found[0];
        assert_eq!(got.id, BARRIER_INTENT_ID);
        assert_eq!(got.state, IntentState::Open, "a survived row is still open");
        assert_eq!(got.kind.known(), Some(KnownIntentKind::WorktreeAdd));
        assert_eq!(got.baseline.as_deref(), Some("deadbeef"), "the baseline survives too");
        assert!(!got.run_id.is_empty(), "the launch that opened it is named");

        let projects = reopened.handle().list_projects().await.expect("read");
        assert_eq!(
            projects.iter().any(|p| p.id == BARRIER_PROJECT_ID),
            project_survives,
            "{arm}: an op behind no barrier must survive only a flush, got {projects:?}"
        );
        reopened.close().await.expect("close");
    }
}

/// **Item 1, the other half.** A failed insert is the caller's answer, not a log line.
///
/// `intents.project_id` is `REFERENCES projects(id)` and foreign keys are on, so an intent naming
/// a project that does not exist cannot be inserted. Until the result channel, `apply_batch`
/// logged the violation, skipped it, committed the batch anyway and woke every `flush()` waiter
/// with success — so a caller could be told its intent was recorded, cause the effect, and leave
/// no row behind. That is the unrecorded-effect window this table exists to close.
#[tokio::test]
async fn intent_open_answers_a_failed_insert_with_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store(dir.path(), Duration::from_millis(250));

    let mut orphan = row("i-orphan", KnownIntentKind::PhaseCommit, ms(1));
    orphan.project_id = Some("p-that-was-never-created".to_owned());
    let err = store.handle().intent_open(orphan).await.expect_err("the foreign key must be told");
    assert!(err.to_string().contains("FOREIGN KEY"), "{err}");
    // `flush()` still answers `Ok`, which is exactly why the error had to come back above.
    store.handle().flush().await.expect("flush");
    assert!(
        store.handle().unsettled_intents().await.expect("read").is_empty(),
        "nothing was written, and nothing said so before this fix"
    );

    // The other way the statement fails: `intents` has no `ON CONFLICT`, so an id twice is an
    // error rather than a silent rewrite of the first row's baseline.
    store.handle().intent_open(row("i1", KnownIntentKind::Spawn, ms(2))).await.expect("open");
    let err = store
        .handle()
        .intent_open(row("i1", KnownIntentKind::Spawn, ms(3)))
        .await
        .expect_err("a duplicate id must be told");
    assert!(err.to_string().contains("UNIQUE"), "{err}");

    // And a failed op does not abort its batch or the writer: the next open still lands.
    store.handle().intent_open(row("i2", KnownIntentKind::Spawn, ms(4))).await.expect("open");
    let ids: Vec<String> = store
        .handle()
        .unsettled_intents()
        .await
        .expect("read")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(ids, vec!["i1".to_owned(), "i2".to_owned()]);
    store.close().await.expect("close");
}

// ---------------------------------------------------------------------------------------------
// Item 3 — slug handling through SQLite, not just through the parser.
// ---------------------------------------------------------------------------------------------

/// **Item 3, the half this level can prove.** A settled row leaves the unsettled list, and a
/// `kind` slug this build does not know keeps its own name rather than being collapsed.
///
/// It deliberately does **not** claim anything about an unknown `state` slug: nothing on the
/// public handle can write one — every op takes a typed [`IntentState`] — so a test at this level
/// that says it does would be asserting against a slug it never wrote. The restrictive read of an
/// unknown `state` is proved where a raw slug can actually be inserted, in
/// `intents::tests::an_unknown_intent_state_slug_reads_back_unknown`.
#[tokio::test]
async fn a_settled_intent_leaves_the_unsettled_list_and_an_unknown_kind_keeps_its_name() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store(dir.path(), Duration::from_millis(250));
    store
        .handle()
        .intent_open(row("i1", KnownIntentKind::PhaseCommit, ms(1)))
        .await
        .expect("open");
    store.handle().flush().await.expect("flush");

    store
        .handle()
        .intent_close(
            "i1".to_owned(),
            IntentState::Done,
            IntentOutcome::Reconciled,
            None,
            None,
            ms(2),
        )
        .await
        .expect("close");
    store.handle().flush().await.expect("flush");

    let mut row2 = row("i2", KnownIntentKind::Spawn, ms(3));
    row2.kind = IntentKind::new("db_migrate");
    store.handle().intent_open(row2).await.expect("open");
    store.handle().flush().await.expect("flush");

    let unsettled = store.handle().unsettled_intents().await.expect("read");
    assert_eq!(unsettled.len(), 1, "the settled row is not unsettled: {unsettled:?}");
    assert_eq!(unsettled[0].id, "i2");
    assert_eq!(
        unsettled[0].kind.as_str(),
        "db_migrate",
        "a kind this build does not know keeps its own name"
    );
    assert_eq!(unsettled[0].kind.known(), None);
    store.close().await.expect("close");
}

/// Every settled value round-trips through SQLite, including the `not_done` a reconciler writes
/// and the `operator` outcome a human's answer carries.
#[tokio::test]
async fn a_settled_intent_carries_its_state_outcome_and_evidence_back() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store(dir.path(), Duration::from_millis(250));
    let session = SessionId::new("s-lossy");
    // `worktree_add`, not `work_order`: a `work_order` may settle only `unknown`, and the write
    // path now holds it to that. The downgrade is pinned two tests down.
    let mut with_session = row("i2", KnownIntentKind::WorktreeAdd, ms(2));
    with_session.session_id = Some(session.clone());
    store.handle().intent_open(with_session).await.expect("open");
    store
        .handle()
        .intent_close(
            "i2".to_owned(),
            IntentState::NotDone,
            IntentOutcome::Operator,
            Some("git rev-list --count -> 0".to_owned()),
            None,
            ms(3),
        )
        .await
        .expect("close");
    store.handle().flush().await.expect("flush");

    let rows = store.handle().session_intents(session).await.expect("read");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, IntentState::NotDone);
    assert_eq!(rows[0].outcome, Some(IntentOutcome::Operator));
    assert_eq!(rows[0].evidence.as_deref(), Some("git rev-list --count -> 0"));
    store.close().await.expect("close");
}

// ---------------------------------------------------------------------------------------------
// The close guard, and the bound.
// ---------------------------------------------------------------------------------------------

/// `IntentClose` is `WHERE id = ?1 AND state = 'open'`, so a close that races the reconciler
/// cannot overwrite a settled row — the guard `Op::ApprovalResolved` already uses.
#[tokio::test]
async fn closing_an_already_settled_intent_does_not_overwrite_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store(dir.path(), Duration::from_millis(250));
    let session = SessionId::new("s1");
    let mut intent = row("i1", KnownIntentKind::MergeToBase, ms(1));
    intent.session_id = Some(session.clone());
    store.handle().intent_open(intent).await.expect("open");
    store
        .handle()
        .intent_close(
            "i1".to_owned(),
            IntentState::Done,
            IntentOutcome::Acked,
            Some("merge-base --is-ancestor -> 0".to_owned()),
            None,
            ms(2),
        )
        .await
        .expect("first close");
    store.handle().flush().await.expect("flush");

    // The reconciler arrives late with a different answer.
    store
        .handle()
        .intent_close(
            "i1".to_owned(),
            IntentState::Unknown,
            IntentOutcome::Reconciled,
            Some("a second opinion".to_owned()),
            None,
            ms(3),
        )
        .await
        .expect("second close");
    store.handle().flush().await.expect("flush");

    let rows = store.handle().session_intents(session).await.expect("read");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, IntentState::Done, "the settled answer stands");
    assert_eq!(rows[0].outcome, Some(IntentOutcome::Acked));
    assert_eq!(rows[0].evidence.as_deref(), Some("merge-base --is-ancestor -> 0"));
    assert_eq!(rows[0].closed_at, Some(ms(2)), "and so does the time it settled");
    store.close().await.expect("close");
}

/// **The narrowing is enforced at the write, not merely documented.**
///
/// Closing a `work_order` as `not_done` authorizes re-dispatching an order that already had
/// effects, and the operator command that settles an intent takes `"done" | "not_done"` straight
/// from a human clicking a button. So the store downgrades it to `unknown` — the restrictive
/// reading, which is never retried — and records what was asked for in `evidence`. A kind whose
/// postcondition *can* prove "not done" is left exactly as the caller wrote it.
#[tokio::test]
async fn a_work_order_closed_not_done_settles_unknown_and_a_worktree_add_does_not() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store(dir.path(), Duration::from_millis(250));
    let session = SessionId::new("s1");
    for (id, kind) in [
        ("i-order", KnownIntentKind::WorkOrder),
        ("i-tree", KnownIntentKind::WorktreeAdd),
    ] {
        let mut intent = row(id, kind, ms(1));
        intent.session_id = Some(session.clone());
        store.handle().intent_open(intent).await.expect("open");
        store
            .handle()
            .intent_close(
                id.to_owned(),
                IntentState::NotDone,
                IntentOutcome::Operator,
                Some("rev-list --count -> 0".to_owned()),
                None,
                ms(2),
            )
            .await
            .expect("close");
    }
    store.handle().flush().await.expect("flush");

    let rows = store.handle().session_intents(session).await.expect("read");
    let of = |id: &str| rows.iter().find(|r| r.id == id).expect("row").clone();

    let order = of("i-order");
    assert_eq!(order.state, IntentState::Unknown, "not_done would authorize a re-dispatch");
    let evidence = order.evidence.expect("the downgrade is recorded");
    assert!(
        evidence.starts_with("requested not_done; work_order settles unknown only"),
        "{evidence}"
    );
    assert!(evidence.ends_with("rev-list --count -> 0"), "the caller's evidence survives it");
    assert_eq!(order.outcome, Some(IntentOutcome::Operator), "only the state is overridden");
    assert_eq!(order.closed_at, Some(ms(2)), "the row is settled, not left open for a retry");

    let tree = of("i-tree");
    assert_eq!(tree.state, IntentState::NotDone, "a kind that can prove it is left alone");
    assert_eq!(tree.evidence.as_deref(), Some("rev-list --count -> 0"), "and gets no note");
    store.close().await.expect("close");
}

// ---------------------------------------------------------------------------------------------
// What `unsettled_intents` means: rows a human still has to decide about.
// ---------------------------------------------------------------------------------------------

/// **An order that finished normally is not something the owner has to look at.**
///
/// `work_order` may settle only `unknown` — the owner's 2026-09-04 narrowing, and it is right —
/// so `hold_to_settleable` writes `unknown` even on the loop's *live* close of an order that
/// completed perfectly. While `unsettled_intents` filtered on `state` alone, that made it return
/// a row for **every order of every phase that ever ran**: the plan card would have offered the
/// owner a list of everything that worked, and a reconciler applying "an `unknown` blocks its
/// phase" would have blocked every phase that ever dispatched an order.
///
/// `outcome` is the discriminator, and it was already in the row. `acked` means the code that did
/// the thing closed it while the process was still running — a deliberate answer, not a missing
/// one.
#[tokio::test]
async fn an_order_closed_live_is_settled_business_and_leaves_the_unsettled_list() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store(dir.path(), Duration::from_millis(250));
    let session = SessionId::new("s1");
    let mut intent = row("i-ran-fine", KnownIntentKind::WorkOrder, ms(1));
    intent.session_id = Some(session.clone());
    store.handle().intent_open(intent).await.expect("open");

    // Exactly what the loop does when a worker returns a report: close it live, acked.
    store
        .handle()
        .intent_close(
            "i-ran-fine".to_owned(),
            IntentState::Done,
            IntentOutcome::Acked,
            Some("worker reported".to_owned()),
            None,
            ms(2),
        )
        .await
        .expect("close");
    store.handle().flush().await.expect("flush");

    let unsettled = store.handle().unsettled_intents().await.expect("read");
    assert!(
        unsettled.is_empty(),
        "an order the loop closed itself is not the owner's to decide: {unsettled:?}"
    );

    // The row is filtered, not lost: it still reads `unknown`, because `work_order` cannot say
    // more than that, and the session's own view still shows it.
    let rows = store.handle().session_intents(session).await.expect("read");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, IntentState::Unknown, "the narrowing still applies to the state");
    assert_eq!(rows[0].outcome, Some(IntentOutcome::Acked), "and `acked` is what excused it");
    store.close().await.expect("close");
}

/// **The other half, and the only half that is evidence of anything.**
///
/// Two rows nobody acked: one a postcondition settled `unknown` after a crash
/// (`reconciled` — it read the world and could not tell), and one nothing ever closed at all,
/// carried across a restart. Both are the owner's to decide, and both must survive the filter
/// that removes the live acks above.
#[tokio::test]
async fn a_reconciled_unknown_and_a_row_nobody_closed_both_stay_on_the_list() {
    let dir = tempfile::tempdir().expect("tempdir");
    let session = SessionId::new("s1");
    {
        let first = store(dir.path(), Duration::from_millis(250));
        for id in ["i-reconciled", "i-never-closed"] {
            let mut intent = row(id, KnownIntentKind::WorkOrder, ms(1));
            intent.session_id = Some(session.clone());
            first.handle().intent_open(intent).await.expect("open");
        }
        // What a reconciler writes after a crash: it read the world and could not tell.
        first
            .handle()
            .intent_close(
                "i-reconciled".to_owned(),
                IntentState::Unknown,
                IntentOutcome::Reconciled,
                Some("rev-list --count -> 0, dirty 0".to_owned()),
                None,
                ms(2),
            )
            .await
            .expect("close");
        // `i-never-closed` is left exactly as a killed process leaves one.
        first.close().await.expect("close");
    }

    let second = store(dir.path(), Duration::from_millis(250));
    let mut ids: Vec<String> = second
        .handle()
        .unsettled_intents()
        .await
        .expect("read")
        .into_iter()
        .map(|r| r.id)
        .collect();
    ids.sort();
    assert_eq!(
        ids,
        vec!["i-never-closed".to_owned(), "i-reconciled".to_owned()],
        "a post-crash finding and a row nobody answered are both the owner's to decide"
    );

    let rows = second.handle().unsettled_intents().await.expect("read");
    let of = |id: &str| rows.iter().find(|r| r.id == id).expect("row").clone();
    assert_eq!(of("i-reconciled").outcome, Some(IntentOutcome::Reconciled));
    assert_eq!(of("i-never-closed").outcome, None, "an open row has no outcome to be excused by");
    assert_eq!(of("i-never-closed").state, IntentState::Open);
    second.close().await.expect("close");
}

/// **The plan card's one button, end to end.**
///
/// `docs/research/intent-records.md` §5.4: *"the plan card offers exactly one action, and only
/// when the phase is blocked on it: mark done / mark not done, after the owner has looked at the
/// diff."* A phase is blocked on a row reading `unknown`, and `unknown` is not `open` — so routing
/// that answer through `intent_close`, whose `UPDATE` is guarded on `state = 'open'`, matched zero
/// rows, returned `Ok(())`, and left the owner pressing a button that did nothing.
///
/// Three assertions, and each one is a separate way the button was broken:
/// the write lands; the narrowing still binds the owner (a `work_order` cannot be marked `done`,
/// by anyone); and the row leaves the list, so pressing the button once is enough.
#[tokio::test]
async fn the_owner_can_settle_an_unknown_by_hand_and_it_stays_settled() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store(dir.path(), Duration::from_millis(250));
    let session = SessionId::new("s1");
    let mut intent = row("i-blocked", KnownIntentKind::WorkOrder, ms(1));
    intent.session_id = Some(session.clone());
    store.handle().intent_open(intent).await.expect("open");
    // A crash leaves it open; the reconciler reads the world and cannot tell. Now the phase is
    // blocked on it and the card shows the owner a button.
    store
        .handle()
        .intent_close(
            "i-blocked".to_owned(),
            IntentState::Unknown,
            IntentOutcome::Reconciled,
            Some("rev-list --count -> 0, dirty 0".to_owned()),
            None,
            ms(2),
        )
        .await
        .expect("close");
    store.handle().flush().await.expect("flush");
    assert_eq!(
        store.handle().unsettled_intents().await.expect("read").len(),
        1,
        "the row is the owner's to decide before they decide it"
    );

    // The owner looks at the diff and clicks *mark done*.
    store
        .handle()
        .intent_settled_by_operator(
            "i-blocked".to_owned(),
            IntentState::Done,
            Some("I read the diff; the schema is there".to_owned()),
            ms(3),
        )
        .await
        .expect("settle");
    store.handle().flush().await.expect("flush");

    let rows = store.handle().session_intents(session).await.expect("read");
    assert_eq!(rows.len(), 1);
    let got = &rows[0];
    assert_eq!(got.outcome, Some(IntentOutcome::Operator), "a person answered, not a postcondition");
    assert_eq!(got.closed_at, Some(ms(3)), "and the write landed at all, which it did not before");
    assert_eq!(
        got.state,
        IntentState::Unknown,
        "a work_order is held to `unknown` whoever asks — a button does not outrank the narrowing"
    );
    let evidence = got.evidence.as_deref().expect("evidence");
    assert!(evidence.contains("operator answered done"), "the human's answer is recorded: {evidence}");
    assert!(evidence.contains("I read the diff"), "and so is what they said: {evidence}");

    assert!(
        store.handle().unsettled_intents().await.expect("read").is_empty(),
        "a question the owner has answered is not one the owner still has to answer"
    );
    store.close().await.expect("close");
}

/// The door the operator path was told to keep shut: [`intent_close`]'s `state = 'open'` guard is
/// what makes a live close idempotent and stops a late or duplicate close from resurrecting a row
/// somebody already settled. Adding a way to move a settled row must not have loosened it.
#[tokio::test]
async fn the_ordinary_close_still_refuses_a_row_that_is_not_open() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store(dir.path(), Duration::from_millis(250));
    let session = SessionId::new("s1");
    let mut intent = row("i1", KnownIntentKind::WorktreeAdd, ms(1));
    intent.session_id = Some(session.clone());
    store.handle().intent_open(intent).await.expect("open");
    store
        .handle()
        .intent_close(
            "i1".to_owned(),
            IntentState::Done,
            IntentOutcome::Acked,
            Some("git worktree list -> present".to_owned()),
            None,
            ms(2),
        )
        .await
        .expect("first close");
    store.handle().flush().await.expect("flush");

    // A duplicate close arriving late, with a different answer, on a row that is no longer `open`.
    store
        .handle()
        .intent_close(
            "i1".to_owned(),
            IntentState::NotDone,
            IntentOutcome::Reconciled,
            Some("a second opinion".to_owned()),
            None,
            ms(3),
        )
        .await
        .expect("late close");
    // And the operator path's own guard, on a row that carries a real answer: `done` is an answer,
    // and this op does not overwrite answers.
    store
        .handle()
        .intent_settled_by_operator(
            "i1".to_owned(),
            IntentState::NotDone,
            Some("changed my mind".to_owned()),
            ms(4),
        )
        .await
        .expect("operator settle");
    store.handle().flush().await.expect("flush");

    let rows = store.handle().session_intents(session).await.expect("read");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, IntentState::Done, "the settled answer stands");
    assert_eq!(rows[0].outcome, Some(IntentOutcome::Acked));
    assert_eq!(rows[0].evidence.as_deref(), Some("git worktree list -> present"));
    assert_eq!(rows[0].closed_at, Some(ms(2)), "and so does the time it settled");
    store.close().await.expect("close");
}

/// **A kind this build cannot name settles `unknown`**, through the real write path.
///
/// `IntentKind` is a pass-through slug on read, and that used to mean an unnameable kind was
/// passed through on *settlement* too — so `work_oder`, one letter from `work_order`, could be
/// closed `not_done` while `work_order` itself is forbidden from it. `not_done` is the value the
/// loop acts on: it authorizes re-dispatching an order that may already have written files.
#[tokio::test]
async fn a_typo_in_a_kind_cannot_settle_not_done_or_done() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store(dir.path(), Duration::from_millis(250));
    let session = SessionId::new("s1");
    for (id, state) in [("i-not-done", IntentState::NotDone), ("i-done", IntentState::Done)] {
        let mut intent = row(id, KnownIntentKind::WorkOrder, ms(1));
        intent.kind = IntentKind::new("work_oder");
        intent.session_id = Some(session.clone());
        store.handle().intent_open(intent).await.expect("open");
        store
            .handle()
            .intent_close(
                id.to_owned(),
                state,
                IntentOutcome::Operator,
                Some("rev-list --count -> 0".to_owned()),
                None,
                ms(2),
            )
            .await
            .expect("close");
    }
    store.handle().flush().await.expect("flush");

    let rows = store.handle().session_intents(session).await.expect("read");
    assert_eq!(rows.len(), 2);
    for got in &rows {
        assert_eq!(got.kind.as_str(), "work_oder", "the slug itself is still not collapsed");
        assert_eq!(got.state, IntentState::Unknown, "{}: a kind we cannot check settles unknown", got.id);
        assert_ne!(got.state, IntentState::NotDone, "which would authorize a re-dispatch");
        assert_ne!(got.state, IntentState::Done, "and which would call an effect taken");
        let evidence = got.evidence.as_deref().expect("the downgrade is recorded");
        assert!(evidence.contains("kind work_oder is not one this build knows"), "{evidence}");
        assert!(evidence.ends_with("rev-list --count -> 0"), "the caller's evidence survives");
    }
    store.close().await.expect("close");
}

/// An oversized `detail_json` — a `Write` approval carries a whole file body — is replaced by the
/// placeholder, not stored. `intents` has no ring to cap it, so the bound is the cap.
#[tokio::test]
async fn an_oversized_intent_detail_is_replaced_not_stored() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store(dir.path(), Duration::from_millis(250));
    let body = "z".repeat(INTENT_DETAIL_LIMIT * 2);
    let mut intent = row("i1", KnownIntentKind::ToolPermission, ms(1));
    intent.detail_json = format!(r#"{{"tool":"Write","body":"{body}"}}"#);
    store.handle().intent_open(intent).await.expect("open");
    store.handle().flush().await.expect("flush");

    let rows = store.handle().unsettled_intents().await.expect("read");
    let stored = &rows[0].detail_json;
    assert!(stored.len() <= INTENT_DETAIL_LIMIT, "detail_json is {} bytes", stored.len());
    assert!(stored.contains("\"oversized\""), "{stored}");
    assert!(!stored.contains(&body), "the file body is not in the database");
    store.close().await.expect("close");
}

// ---------------------------------------------------------------------------------------------
// Item 9 — retention.
// ---------------------------------------------------------------------------------------------

/// **Item 9.** A `done` row older than the cutoff is swept at open; an `unknown` row of the same
/// age is not, because it is the only record that something may have happened and nobody has
/// looked yet.
#[tokio::test]
async fn retention_sweeps_settled_intents_and_never_an_unknown_one() {
    let dir = tempfile::tempdir().expect("tempdir");
    let old = SystemTime::now() - INTENT_RETENTION - Duration::from_secs(60 * 60);
    let recent = SystemTime::now() - Duration::from_secs(60);

    let first = store(dir.path(), Duration::from_millis(250));
    let session = SessionId::new("s1");
    for (id, state) in [
        ("old-done", IntentState::Done),
        ("old-not-done", IntentState::NotDone),
        ("old-unknown", IntentState::Unknown),
    ] {
        let mut intent = row(id, KnownIntentKind::WorktreeAdd, old);
        intent.session_id = Some(session.clone());
        first.handle().intent_open(intent).await.expect("open");
        first
            .handle()
            .intent_close(
                id.to_owned(),
                state,
                IntentOutcome::Reconciled,
                None,
                None,
                old,
            )
            .await
            .expect("close");
    }
    // Settled, but inside the window.
    let mut fresh = row("new-done", KnownIntentKind::WorktreeAdd, recent);
    fresh.session_id = Some(session.clone());
    first.handle().intent_open(fresh).await.expect("open");
    first
        .handle()
        .intent_close(
            "new-done".to_owned(),
            IntentState::Done,
            IntentOutcome::Acked,
            None,
            None,
            recent,
        )
        .await
        .expect("close");
    // Never closed at all: `closed_at` is NULL, so no cutoff comparison can be true.
    let mut still_open = row("old-open", KnownIntentKind::WorktreeAdd, old);
    still_open.session_id = Some(session.clone());
    first.handle().intent_open(still_open).await.expect("open");
    first.close().await.expect("close");

    let second = store(dir.path(), Duration::from_millis(250));
    let mut ids: Vec<String> =
        second.handle().session_intents(session).await.expect("read").into_iter()
            .map(|r| r.id)
            .collect();
    ids.sort();
    assert_eq!(
        ids,
        vec!["new-done".to_owned(), "old-open".to_owned(), "old-unknown".to_owned()],
        "only settled rows past the cutoff are swept"
    );
    second.close().await.expect("close");
}

// ---------------------------------------------------------------------------------------------
// Round trip and cascade.
// ---------------------------------------------------------------------------------------------

/// Everything the reconciler will read, written once and read back whole.
///
/// The `ON DELETE CASCADE` that takes an intent with its session or project is proved against a
/// raw connection in `intents::tests`, because nothing on [`Store`] deletes a session.
#[tokio::test]
async fn an_intent_round_trips_with_every_column_it_carries() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store(dir.path(), Duration::from_millis(250));
    let session = SessionId::new("s1");
    store
        .handle()
        .upsert_project(ProjectRow {
            id: "p1".to_owned(),
            name: "job-portal".to_owned(),
            root_path: "/r".into(),
            created_at: ms(1),
            mcp: brigadier_core::driver::McpPolicy::Off,
        })
        .await
        .expect("project");

    let mut intent = row("i1", KnownIntentKind::WorktreeRemove, ms(10));
    intent.project_id = Some("p1".to_owned());
    intent.session_id = Some(session.clone());
    intent.subject = Some("/tmp/wt".to_owned());
    intent.baseline = Some("branch=wip dirty=3".to_owned());
    intent.detail_json = r#"{"reason":"phase 2 merged"}"#.to_owned();
    store.handle().intent_open(intent).await.expect("open");
    store.handle().flush().await.expect("flush");

    let got = store.handle().session_intents(session.clone()).await.expect("read");
    assert_eq!(got.len(), 1);
    let got = &got[0];
    assert_eq!(got.project_id.as_deref(), Some("p1"));
    assert_eq!(got.session_id.as_ref(), Some(&session));
    assert_eq!(got.subject.as_deref(), Some("/tmp/wt"));
    assert_eq!(got.baseline.as_deref(), Some("branch=wip dirty=3"));
    assert_eq!(got.detail_json, r#"{"reason":"phase 2 merged"}"#);
    assert_eq!(got.state, IntentState::Open);
    assert_eq!(got.outcome, None, "an open row has no outcome");
    assert_eq!(got.opened_at, ms(10));
    store.close().await.expect("close");
}

/// An intent opened before the session id exists — `worktree::prepare` runs first — and named on
/// close, which is the whole reason `IntentClose` carries a `session_id` at all.
#[tokio::test]
async fn an_intent_opened_before_the_session_id_exists_is_named_on_close() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store(dir.path(), Duration::from_millis(250));
    store.handle().intent_open(row("i1", KnownIntentKind::WorktreeAdd, ms(1))).await.expect("open");
    store.handle().flush().await.expect("flush");
    assert_eq!(store.handle().unsettled_intents().await.expect("read")[0].session_id, None);

    let session = SessionId::new("s-minted-later");
    store
        .handle()
        .intent_close(
            "i1".to_owned(),
            IntentState::Done,
            IntentOutcome::Acked,
            Some("git worktree list -> present".to_owned()),
            Some(session.clone()),
            ms(2),
        )
        .await
        .expect("close");
    store.handle().flush().await.expect("flush");

    let rows = store.handle().session_intents(session.clone()).await.expect("read");
    assert_eq!(rows.len(), 1, "the id landed on close: {rows:?}");
    assert_eq!(rows[0].session_id.as_ref(), Some(&session));
    assert_eq!(rows[0].state, IntentState::Done);
    store.close().await.expect("close");
}
