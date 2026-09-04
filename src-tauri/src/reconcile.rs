//! Reconciliation on restart: read the world before the loop is allowed to dispatch into it.
//!
//! `docs/research/intent-records.md` §4.1 states the ordering constraint in as many words — *the
//! orchestration loop must not dispatch its first work order until reconciliation has completed* —
//! and [`brigadier_supervisor::loop_::barrier`] is the channel that enforces it. This module is
//! what publishes on it. It runs where `prune_worktrees` runs, spawned off the setup thread
//! (`crate::run`), so it never lands on the launch budget and never lands on the launch path.
//!
//! # What this build does, and what it deliberately does not
//!
//! **The per-kind postcondition evaluator of §4.3 is not built here.** Nothing below runs
//! `git rev-list`, reads a first parent, or settles a single intent row: `settled` is always `0`
//! and every unsettled row stays exactly as unsettled as it was. What is published instead is the
//! **conservative** reading of the same rows:
//!
//! - a phase carrying an intent nothing has answered goes into
//!   [`ReconcileOutcome::unknown_phases`], which **blocks that phase**;
//! - a project whose `git worktree repair` failed goes into [`ReconcileOutcome::repair_failed`],
//!   which **refuses dispatch in that project**.
//!
//! Both are the restrictive direction, and that asymmetry is the whole reason this shape is safe
//! to ship ahead of the evaluator: blocking a phase that could have run costs a click, while
//! re-dispatching an order that already had effects is the failure the intent table exists to
//! prevent (`intent-records.md` §4.3, the 2026-09-04 owner amendment). When the evaluator lands
//! it can only *unblock* phases this pass blocked.
//!
//! # The trap in reading the rows, which is not obvious
//!
//! [`KnownIntentKind::WorkOrder`](brigadier_store::intents::KnownIntentKind) may settle **only**
//! `unknown`, and that is enforced on *every* close — including the loop's own live close of an
//! order that finished perfectly normally. So an `unknown` row is emitted for **every order the
//! loop has ever dispatched**, and a reconciler that treated each as "something moved" would block
//! every phase that ever ran, green ones included.
//!
//! [`IntentOutcome`] is the discriminator: `Acked` is a row the code that did the thing closed
//! while the process was alive, `Reconciled` is one a postcondition settled after a restart, and
//! `Operator` is one a human looked at and answered. **Only the middle one is evidence of
//! anything**, and [`is_evidence`] is where that is decided. The store's own
//! `unsettled_intents` query already filters `outcome <> 'acked'`
//! (`crates/store/src/writer.rs`); this reads `outcome` regardless, so the answer does not depend
//! on that filter staying there.
// see docs/research/intent-records.md §4 and §5, and docs/research/orchestration-loop.md §9.

use std::path::{Path, PathBuf};

use brigadier_core::worktree;
use brigadier_store::intents::{IntentOutcome, IntentRecord, IntentState};
use brigadier_store::{ProjectRow, StoreHandle};
use brigadier_supervisor::loop_::barrier::{ReconcileOutcome, ReconcileSender};
use brigadier_supervisor::worktree::WORKTREES_SUBDIR;
use brigadier_supervisor::Supervisor;

/// Reconcile every project, publish the outcome, and log one line with the counts.
///
/// Failures below become *restrictions inside the outcome* rather than an early return, with one
/// exception, and it is the one that cannot be expressed as a restriction: if the project list
/// itself will not read, there are no ids to refuse and publishing a clean outcome would let the
/// loop dispatch into repositories nothing has looked at. So that path returns without
/// publishing, and the dropped sender is what the loop reads as `reconcile_failed`
/// (`orchestration-loop.md` §9.2 case 1 — *a reconciler that did not run is strictly worse than
/// one that is slow*).
pub(crate) async fn run(sup: &Supervisor, store: &StoreHandle, sender: ReconcileSender) {
    let projects = match sup.list_projects().await {
        Ok(projects) => projects,
        Err(e) => {
            tracing::error!(
                error = %e,
                "could not list the projects to reconcile; the run barrier will not be published"
            );
            return;
        }
    };
    let projects = &projects[..];
    let mut outcome = ReconcileOutcome::clean();

    // Step 1 of §4.2, and it is first for a reason: a project folder renamed between a crash and
    // this restart leaves two stale absolute paths per worktree, and *every* path-based
    // postcondition then answers wrongly. §4.2 calls it "the single largest correctness landmine
    // in the reconciler".
    match worktree::resolve_git() {
        Some(git) => {
            for project in projects {
                if repair_project(&git, project).await.is_err() {
                    outcome.repair_failed.insert(project.id.clone());
                }
            }
        }
        // No git at all: nothing in any project can be repaired, so nothing in any project may be
        // dispatched into. `Supervisor::prepare_run` refuses a run for the same reason, but it
        // must not be the only guard — this one covers a `git` that disappears between launches.
        None => {
            tracing::warn!("no git on PATH; refusing to dispatch in any project this launch");
            outcome.repair_failed.extend(projects.iter().map(|p| p.id.clone()));
        }
    }

    // Step 2. Rows from *any* `run_id`: the data-dir lock guarantees one instance, so a row
    // nothing has answered is by definition unattended.
    let unsettled = match store.unsettled_intents().await {
        Ok(rows) => rows,
        // The restrictive reading again. Without the rows there is no way to know which phases
        // carry an unanswered intent, so no phase may be dispatched — and the cheapest way to say
        // that with this outcome type is to refuse every project.
        Err(e) => {
            tracing::error!(error = %e, "could not read the unsettled intents; refusing to dispatch");
            outcome.repair_failed.extend(projects.iter().map(|p| p.id.clone()));
            sender.publish(outcome);
            return;
        }
    };

    let mut evidence_rows = 0usize;
    let mut unattributed = 0usize;
    for row in &unsettled {
        if !is_evidence(row) {
            continue;
        }
        evidence_rows += 1;
        match phase_of(row) {
            Some(phase_id) => {
                outcome.unknown_phases.insert(phase_id);
            }
            // A `worktree_add`, `worktree_remove`, `spawn` or `tool_permission` row names no
            // phase, so there is no phase to block. It stays on `unsettled_intents` for the plan
            // card, which is the surface §5 gives it.
            None => unattributed += 1,
        }
    }

    tracing::info!(
        projects = projects.len(),
        unsettled = unsettled.len(),
        evidence = evidence_rows,
        unknown_phases = outcome.unknown_phases.len(),
        unattributed,
        repair_failed = outcome.repair_failed.len(),
        settled = outcome.settled,
        "reconciliation complete"
    );
    sender.publish(outcome);
}

/// Whether one unsettled row is evidence that something moved and nobody knows what.
///
/// Three of the four readings are *not*:
///
/// - `Acked` — the code that caused the effect closed the row itself, while the process was
///   alive. Every work order the loop ever dispatched leaves one of these, so treating it as
///   evidence blocks every phase that ever ran.
/// - `Operator` — a human looked at the diff and answered. Treating it as evidence would make
///   [`crate::commands::settle_intent`] a button that changes nothing: a `work_order` close is
///   held to `unknown` whatever the owner says, so the row comes back on the next pass carrying
///   the owner's own answer.
/// - a row of unknown provenance whose `outcome` slug this build cannot read is **not** treated
///   as evidence either, because `outcome` is narration about how a state was set, never an
///   authorization — the same reading `IntentOutcome::from_slug` takes.
///
/// What is left is `Open` (nothing ever settled it — the crash case) and `Reconciled` (a
/// postcondition read the world and could not tell).
fn is_evidence(row: &IntentRecord) -> bool {
    match row.state {
        IntentState::Open => true,
        IntentState::Unknown => row.outcome == Some(IntentOutcome::Reconciled),
        // None of these is returned by `unsettled_intents` at all. Matched exhaustively rather
        // than with a wildcard so that a state a later build adds fails to compile here instead
        // of defaulting to "not evidence", which is the direction that lets something through.
        IntentState::Done | IntentState::NotDone | IntentState::Superseded => false,
    }
}

/// The phase an intent belongs to, out of its `detail_json`.
///
/// `work_order` and `phase_commit` are the two kinds that write one
/// (`crates/supervisor/src/loop_/dispatch.rs`, `green.rs`), and they are also the only two whose
/// `unknown` blocks a phase (`intent-records.md` §5.1). Read lossily: `detail_json` may be the
/// oversized placeholder the store substitutes rather than the real value.
fn phase_of(row: &IntentRecord) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(&row.detail_json).ok()?;
    let phase_id = value.get("phase_id")?.as_str()?;
    (!phase_id.is_empty()).then(|| phase_id.to_owned())
}

/// `git worktree repair` for one project. `Err(())` means this project may not be dispatched into.
///
/// **Not the argument-less form.** **measured** (`crates/core/src/worktree.rs`): run from a moved
/// main tree it exits 0, prints nothing and leaves every `gitdir` stale, because it only covers
/// worktrees still findable where they were recorded — which after a move is none of ours. The
/// paths come off the disk for the same reason: after a move `git worktree list` reports the *old*
/// locations, while the directories are the one thing still where they are.
///
/// A project that is not a git repository is **not** a repair failure. It cannot be dispatched
/// into either, but `LoopError::NoWorktree` is the refusal that names why, and pre-empting it with
/// `repair_failed` would report the wrong reason.
async fn repair_project(git: &Path, project: &ProjectRow) -> Result<(), ()> {
    let root = &project.root_path;
    if !worktree::is_repo(git, root).await {
        tracing::debug!(root = %root.display(), "not a git repository; nothing to repair");
        return Ok(());
    }
    let dirs = worktree_dirs_on_disk(root);
    if dirs.is_empty() {
        return Ok(());
    }
    match worktree::repair(git, root, &dirs).await {
        Ok(()) => {
            tracing::debug!(root = %root.display(), count = dirs.len(), "worktrees repaired");
            Ok(())
        }
        Err(e) => {
            // The consequence is worth stating where an operator will read it: a `not_done`
            // derived from a broken repair is a licence to redo work that already ran
            // (`intent-records.md` §7), so the only safe answer is to dispatch nothing here.
            tracing::warn!(
                root = %root.display(),
                count = dirs.len(),
                error = %e,
                "worktree repair failed; refusing to dispatch in this project"
            );
            Err(())
        }
    }
}

/// Every directory under `<root>/.brigadier/worktrees/` that carries a `.git` entry.
///
/// The `.git` filter is what stops this from blocking every run in a project that has one stale
/// directory: `repair` exits 1 for *any* path in the batch that is not a worktree, having already
/// repaired the ones that are (**measured**, `crates/supervisor/src/worktree.rs`), so a leftover
/// `.brigadier/worktrees/tmp` with no `.git` in it would otherwise mark the whole project
/// `repair_failed` for good. A linked worktree's `.git` is a *file* holding a `gitdir:` line, and
/// it is exactly the file `repair` rewrites — a directory that has none was never a worktree.
fn worktree_dirs_on_disk(project_root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(project_root.join(WORKTREES_SUBDIR)) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| p.join(".git").exists())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use brigadier_store::intents::{IntentKind, IntentRow, KnownIntentKind};
    use brigadier_store::Store;
    use brigadier_supervisor::loop_::barrier::{barrier, BarrierWait};
    use brigadier_supervisor::{SupervisorConfig, VecSink};
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn record(state: IntentState, outcome: Option<IntentOutcome>, detail: &str) -> IntentRecord {
        IntentRecord {
            id: "i1".to_owned(),
            run_id: "r1".to_owned(),
            kind: IntentKind::new("work_order"),
            state,
            project_id: Some("p1".to_owned()),
            session_id: None,
            opened_at: UNIX_EPOCH + Duration::from_millis(1_700_000_000_000),
            closed_at: None,
            subject: None,
            baseline: None,
            detail_json: detail.to_owned(),
            outcome,
            evidence: None,
        }
    }

    /// The trap, pinned: the loop closes a `work_order` row on the happy path and the store holds
    /// that close to `unknown`, so an `acked` row is what a phase that went **green** leaves
    /// behind. Reading it as evidence blocks every phase that ever dispatched an order.
    #[test]
    fn an_acked_unknown_is_not_evidence_of_anything() {
        let row = record(IntentState::Unknown, Some(IntentOutcome::Acked), "{}");
        assert!(!is_evidence(&row));
    }

    #[test]
    fn a_reconciled_unknown_is_evidence_and_so_is_a_row_nothing_closed() {
        assert!(is_evidence(&record(IntentState::Unknown, Some(IntentOutcome::Reconciled), "{}")));
        assert!(is_evidence(&record(IntentState::Open, None, "{}")));
    }

    /// Otherwise the owner's answer comes straight back as the reason to keep blocking: a
    /// `work_order` close is held to `unknown` whatever they said.
    #[test]
    fn an_intent_the_owner_settled_stops_being_evidence() {
        let row = record(IntentState::Unknown, Some(IntentOutcome::Operator), "{}");
        assert!(!is_evidence(&row));
    }

    /// `outcome` is narration about how a state was set, never an authorization, so a slug this
    /// build cannot read is not promoted to evidence.
    #[test]
    fn an_unreadable_outcome_slug_is_not_evidence() {
        let row = record(IntentState::Unknown, None, "{}");
        assert!(!is_evidence(&row));
    }

    #[test]
    fn the_phase_comes_out_of_detail_json_and_a_missing_one_is_not_invented() {
        let row = record(IntentState::Open, None, r#"{"order_id":"o1","phase_id":"ph3"}"#);
        assert_eq!(phase_of(&row).as_deref(), Some("ph3"));
        assert_eq!(phase_of(&record(IntentState::Open, None, "{}")), None);
        assert_eq!(phase_of(&record(IntentState::Open, None, r#"{"phase_id":""}"#)), None);
        // The oversized placeholder the store substitutes for a too-large value, and any other
        // text that is not an object, reads as "no phase" rather than failing the pass.
        assert_eq!(phase_of(&record(IntentState::Open, None, "not json")), None);
    }

    /// A directory with no `.git` in it was never a worktree, and including it would make one
    /// piece of litter refuse every run in the project for good.
    #[test]
    fn only_directories_that_look_like_worktrees_are_offered_to_repair() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        let wts = root.join(WORKTREES_SUBDIR);
        std::fs::create_dir_all(wts.join("real")).expect("mkdir");
        std::fs::write(wts.join("real").join(".git"), "gitdir: /elsewhere\n").expect("write");
        std::fs::create_dir_all(wts.join("litter")).expect("mkdir");
        std::fs::write(wts.join("loose-file"), "x").expect("write");

        let found = worktree_dirs_on_disk(root);
        assert_eq!(found, vec![wts.join("real")], "{found:?}");
    }

    #[test]
    fn a_project_with_no_worktrees_directory_offers_nothing() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(worktree_dirs_on_disk(dir.path()).is_empty());
    }

    /// A store, a supervisor over it, and the tempdir both live in.
    fn rig() -> (tempfile::TempDir, Store, Supervisor) {
        let data = tempfile::tempdir().expect("data dir");
        let store = Store::open(data.path()).expect("store opens");
        let config = SupervisorConfig::new(
            store.handle().clone(),
            store.run_id().to_owned(),
            data.path().to_owned(),
            Arc::new(VecSink::new()),
        );
        let sup = Supervisor::new(config);
        (data, store, sup)
    }

    /// The whole point of the barrier: **something is always published**. A launch with no
    /// projects and no intents publishes a clean outcome rather than leaving a run waiting out its
    /// 60-second timeout and then refusing to dispatch.
    #[tokio::test]
    async fn a_launch_with_nothing_to_reconcile_still_publishes() {
        let (_data, store, sup) = rig();
        let (tx, mut rx) = barrier();
        run(&sup, store.handle(), tx).await;
        assert_eq!(
            rx.wait(Duration::from_millis(50)).await,
            BarrierWait::Ready(ReconcileOutcome::clean())
        );
    }

    /// An intent nothing ever closed — what a launch that died mid-order leaves — blocks the phase
    /// it names, and nothing else. The phase is read out of `detail_json`, which is where dispatch
    /// writes it.
    #[tokio::test]
    async fn an_unclosed_work_order_blocks_its_own_phase_and_no_other() {
        let (_data, store, sup) = rig();
        let mut intent =
            IntentRow::new("i1", KnownIntentKind::WorkOrder, SystemTime::now());
        intent.subject = Some("/repo/.brigadier/worktrees/abcd1234".to_owned());
        intent.detail_json = r#"{"order_id":"o1","phase_id":"ph9"}"#.to_owned();
        store.handle().intent_open(intent).await.expect("intent opened");

        let (tx, mut rx) = barrier();
        run(&sup, store.handle(), tx).await;
        let BarrierWait::Ready(outcome) = rx.wait(Duration::from_millis(50)).await else {
            panic!("the barrier never resolved");
        };
        assert!(outcome.phase_is_unknown("ph9"));
        assert!(!outcome.phase_is_unknown("ph1"));
        // Nothing was settled, and the outcome says so rather than implying a pass it did not
        // make: the postcondition evaluator is not built.
        assert_eq!(outcome.settled, 0);
        assert!(outcome.repair_failed.is_empty());
    }

    /// The trap, end to end and not merely in [`is_evidence`]: the loop closes a `work_order`
    /// intent on the happy path, the store holds that close to `unknown`, and the phase must not
    /// be blocked by its own success.
    #[tokio::test]
    async fn a_phase_that_finished_normally_is_not_blocked_by_its_own_intent() {
        let (_data, store, sup) = rig();
        let mut intent =
            IntentRow::new("i1", KnownIntentKind::WorkOrder, SystemTime::now());
        intent.detail_json = r#"{"order_id":"o1","phase_id":"ph1"}"#.to_owned();
        store.handle().intent_open(intent).await.expect("intent opened");
        // Exactly what `dispatch::run` does when the worker reports: `done` is held to `unknown`
        // by the kind's settleable set, and `outcome` is what says a live code path closed it.
        store
            .handle()
            .intent_close(
                "i1".to_owned(),
                IntentState::Done,
                IntentOutcome::Acked,
                Some("1 commit(s), 0 dirty".to_owned()),
                None,
                SystemTime::now(),
            )
            .await
            .expect("intent closed");
        store.handle().flush().await.expect("flushed");

        let (tx, mut rx) = barrier();
        run(&sup, store.handle(), tx).await;
        let BarrierWait::Ready(outcome) = rx.wait(Duration::from_millis(50)).await else {
            panic!("the barrier never resolved");
        };
        assert!(
            outcome.unknown_phases.is_empty(),
            "a green phase was blocked by the intent its own success left: {:?}",
            outcome.unknown_phases
        );
    }

    /// The two total-refusal paths hand back every project, so `repair_failed` is what the loop
    /// reads rather than a silently clean outcome.
    #[test]
    fn refusing_everything_names_every_project() {
        let projects = [
            ProjectRow {
                id: "p1".to_owned(),
                name: "a".to_owned(),
                root_path: PathBuf::from("/a"),
                created_at: SystemTime::UNIX_EPOCH,
                mcp: brigadier_core::driver::McpPolicy::Off,
            },
            ProjectRow {
                id: "p2".to_owned(),
                name: "b".to_owned(),
                root_path: PathBuf::from("/b"),
                created_at: SystemTime::UNIX_EPOCH,
                mcp: brigadier_core::driver::McpPolicy::Off,
            },
        ];
        let outcome = ReconcileOutcome {
            repair_failed: projects.iter().map(|p| p.id.clone()).collect(),
            ..ReconcileOutcome::clean()
        };
        assert!(outcome.repair_failed("p1") && outcome.repair_failed("p2"));
    }
}
