//! Merge into the integration worktree, gate the combination, and — only on a real exit 0 —
//! commit the phase and clean up.
//!
//! ## Why an integration worktree and not the project root
//!
//! The verify command has to run against the **combination**: four orders that each pass alone
//! can fail together, and catching that is what the gate is for. It cannot run in a worker's own
//! worktree either, because that carries the worker's uncommitted dirt and is about to be thrown
//! away. So the order is **collect → merge each order into the integration branch → gate**, and a
//! merge conflict at that step is a red gate with its own reason — diagnosed as a *partitioning*
//! failure rather than as a test failure (`orchestration-loop.md` §6.1).
//!
//! ## The one step that must be intent-recorded
//!
//! Everything before the phase commit is confined to worktrees the loop can throw away;
//! everything after it is bookkeeping a reconciler can re-derive. The merge into base is the only
//! place the loop could repeat an effect that is already in the repository, so it takes a
//! `phase_commit` intent, opened and committed before the merge is attempted.
//!
//! **Its postcondition compares the FIRST parent.** `%P` lists every parent and a `--no-ff` phase
//! merge has two, so a postcondition comparing the whole `%P` string reads `unknown` on every
//! phase this loop ever commits — the design would halt the loop on its own successful work, on
//! the happy path, every phase (**measured** on git 2.50.1,
//! `docs/research/intent-records.md` §10.2b). And the **fast-forward case produces no merge commit
//! at all**, which is handled here rather than read as a failure.
//!
//! ## Cleanup
//!
//! Snapshot, then remove, and only where nothing can be lost. **`git`'s `cherry` subcommand appears nowhere**:
//! it reports work unmerged after a squash-merge and reports it *merged* when it was applied
//! upstream and then reverted (**measured**, `docs/research/worktree-cleanup.md` §§2.2–2.4). The
//! only sound signal is `git rev-list --count base..branch == 0`, and branch deletion is **`-d`,
//! never `-D`**.
// see docs/research/orchestration-loop.md §§6 and 8.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use brigadier_core::worktree::{delete_branch, remove, RemoveForce};
use brigadier_store::plan::PhaseRow;
use brigadier_store::{IntentOutcome, IntentRow, IntentState, KnownIntentKind};

use crate::loop_::{git, ladder, LoopError, Run};
use crate::verify::{GateRequest, GateResult};
use crate::worktree::prepare_from;

/// How a phase's integration ended.
#[derive(Clone, Debug)]
pub enum Outcome {
    /// The gate exited 0 and the phase commit landed.
    Green {
        /// The merge commit, or the base's own tip when the merge was a fast-forward.
        commit_sha: Option<String>,
        /// The bounded line the plan card keeps.
        evidence: String,
    },
    /// The gate did not exit 0, on either attempt. Nothing was committed and nothing was deleted.
    Red {
        /// The gate's exit code, or `None` when it was signalled.
        exit_code: Option<i32>,
        /// The bounded diagnosis.
        evidence: String,
    },
}

/// Merge, gate, and on green commit and clean up.
pub(super) async fn integrate(run: &mut Run, phase: &PhaseRow) -> Result<Outcome, LoopError> {
    let store = &run.sup.inner.store;
    let orders = store.work_orders(&phase.id).await?;
    let branches: Vec<String> = orders.iter().filter_map(|o| o.branch.clone()).collect();
    let root = run.project.root_path.clone();
    let base_sha = match &phase.base_sha {
        Some(sha) => sha.clone(),
        None => git::rev_parse(&run.git, &root, "HEAD").await?,
    };
    // `derive` refuses a phase with no verify command before it ever reaches here; this is the
    // second lock on the same door, because fabricating a command is the one thing the nullable
    // column exists to prevent.
    let Some(command) = phase.verify_command.clone().filter(|c| !c.trim().is_empty()) else {
        return Ok(Outcome::Red {
            exit_code: None,
            evidence: "no verify command: this phase cannot go green through a gate".to_owned(),
        });
    };

    let prepared =
        prepare_from(&root, Some(&base_sha)).await?.ok_or_else(|| LoopError::NoWorktree(root.clone()))?;
    let integration = prepared.path.clone();
    let integration_branch = prepared.branch.clone();
    let phase_label = format!("Phase {}", phase.ordinal + 1);

    // ---- merge every order into the combination -------------------------------------------
    for branch in &branches {
        let message = format!("brigadier: {} into {phase_label}", branch);
        match git::merge_no_ff(&run.git, &integration, branch, &message).await {
            Ok(git::Merged::Commit | git::Merged::AlreadyUpToDate) => {}
            Ok(git::Merged::Conflict) => {
                let evidence = format!(
                    "merge_conflict: {branch} does not merge into the phase's integration \
                     branch; this is a partitioning failure, not a test failure"
                );
                tracing::warn!(phase_id = %phase.id, branch, "{evidence}");
                prepared.roll_back().await;
                return Ok(Outcome::Red { exit_code: None, evidence });
            }
            Err(e) => {
                prepared.roll_back().await;
                return Err(LoopError::Git(e));
            }
        }
    }

    // ---- the gate, and the only thing that settles a phase --------------------------------
    let attempt = phase.attempts.max(1);
    let env = run.gate_env().await;
    let first = crate::verify::run(
        &env,
        &GateRequest {
            command: command.clone(),
            cwd: integration.clone(),
            log_path: run.gate_log(&phase.id, attempt),
            timeout: run.limits.gate_timeout,
        },
    )
    .await?;
    tracing::info!("{}", first.feed_line(&phase_label));

    let mut before_fix = None;
    let mut gate = first;
    if !gate.is_green() {
        // Rung 1: one fresh fixer, in place. Rung 2 is deliberately absent — see [`ladder`].
        let fix =
            ladder::rung_one(run, phase, &integration, &integration_branch, &gate).await?;
        before_fix = Some(fix.before_sha.clone());
        let env = run.gate_env().await;
        gate = crate::verify::run(
            &env,
            &GateRequest {
                command: command.clone(),
                cwd: integration.clone(),
                log_path: run.gate_log(&phase.id, attempt + 1),
                timeout: run.limits.gate_timeout,
            },
        )
        .await?;
        tracing::info!("{}", gate.feed_line(&phase_label));
    }

    if !gate.is_green() {
        // Rung 3. Nothing is deleted: every branch that holds an attempt's work survives for the
        // owner to look at, the integration branch included.
        let diagnosis = ladder::Diagnosis {
            command,
            exit_code: gate.exit_code,
            reason: gate.reason.slug(),
            attempts: attempt + u32::from(before_fix.is_some()),
            log_path: gate.log_path.clone(),
            branches: branches
                .iter()
                .cloned()
                .chain(std::iter::once(integration_branch.clone()))
                .collect(),
            before_fix,
        };
        tracing::warn!("{}", diagnosis.thread_line(&phase_label));
        return Ok(Outcome::Red {
            exit_code: gate.exit_code,
            evidence: diagnosis.evidence(),
        });
    }

    // ---- green: the phase commit ----------------------------------------------------------
    let commit = commit_phase(run, phase, &integration_branch, &phase_label).await?;
    let commit_sha = match commit {
        Committed::Landed(sha) => Some(sha),
        Committed::Refused(evidence) => {
            return Ok(Outcome::Red { exit_code: gate.exit_code, evidence })
        }
    };

    // ---- cleanup, and never before the merge landed ---------------------------------------
    let base_branch = git::current_branch(&run.git, &root).await?.unwrap_or_else(|| "HEAD".into());
    let mut removed = 0usize;
    for order in &orders {
        if let (Some(path), Some(branch)) = (&order.worktree_path, &order.branch) {
            removed +=
                usize::from(retire(run, path, branch, &base_branch).await.unwrap_or(false));
        }
    }
    removed += usize::from(
        retire(run, &integration, &integration_branch, &base_branch).await.unwrap_or(false),
    );

    let evidence = format!("{} {removed} worktree(s) removed", gate.feed_line(&phase_label));
    Ok(Outcome::Green { commit_sha, evidence })
}

/// What the merge into base did.
enum Committed {
    /// The phase's commit is in the base branch, and this is its sha.
    Landed(String),
    /// It is not, and this says why.
    Refused(String),
}

/// Merge the integration branch into the project's base branch as one `--no-ff` phase commit,
/// under a `phase_commit` intent.
async fn commit_phase(
    run: &Run,
    phase: &PhaseRow,
    integration_branch: &str,
    phase_label: &str,
) -> Result<Committed, LoopError> {
    let root = run.project.root_path.clone();
    let Some(base_branch) = git::current_branch(&run.git, &root).await? else {
        return Ok(Committed::Refused(
            "the project's checkout is on a detached HEAD; refusing to commit a phase onto it"
                .to_owned(),
        ));
    };
    let baseline = git::rev_parse(&run.git, &root, &base_branch).await?;
    let message = format!("{phase_label}: {}", phase.title);

    let intent_id = uuid::Uuid::new_v4().to_string();
    let mut intent =
        IntentRow::new(intent_id.clone(), KnownIntentKind::PhaseCommit, SystemTime::now());
    intent.project_id = Some(run.project.id.clone());
    intent.subject = Some(base_branch.clone());
    // The sha the postcondition's **first-parent** comparison is measured against. The intended
    // message rides in `detail_json` rather than being packed into this field, because both are
    // needed and a single string that has to be split is a parser waiting to be got wrong.
    intent.baseline = Some(baseline.clone());
    intent.detail_json = serde_json::json!({
        "message": message,
        "phase_id": phase.id,
        "branch": integration_branch,
    })
    .to_string();
    run.sup.inner.store.intent_open(intent).await?;

    let merged = git::merge_no_ff(&run.git, &root, integration_branch, &message).await?;
    let (state, sha, evidence) = match merged {
        git::Merged::Commit => {
            // **The first parent, never `%P`.** A `--no-ff` merge has two parents and `%P` lists
            // both, so comparing the whole field reads `unknown` on the happy path, every phase.
            let sha = git::rev_parse(&run.git, &root, &base_branch).await?;
            let first = git::first_parent(&run.git, &root, &sha).await?;
            let subject = git::subject(&run.git, &root, &sha).await?;
            if first.as_deref() == Some(baseline.as_str()) && subject == message {
                let line = format!("phase commit {} landed", short(&sha));
                (IntentState::Done, Some(sha), line)
            } else {
                (
                    IntentState::Unknown,
                    Some(sha.clone()),
                    format!(
                        "the top commit of {base_branch} is {} with subject {subject:?}, \
                         which is not the phase commit this loop intended",
                        short(&sha)
                    ),
                )
            }
        }
        // The fast-forward case, which produces **no merge commit at all**. Handled, not read as
        // a failure: the work is already in the base and the phase is done.
        git::Merged::AlreadyUpToDate => {
            let sha = git::rev_parse(&run.git, &root, &base_branch).await?;
            let contained =
                git::is_ancestor(&run.git, &root, integration_branch, &base_branch).await?;
            if contained {
                (
                    IntentState::Done,
                    Some(sha.clone()),
                    format!("already in {base_branch} at {}; no merge commit was needed", short(&sha)),
                )
            } else {
                (
                    IntentState::Unknown,
                    Some(sha),
                    format!("git reported {base_branch} up to date, but it does not contain {integration_branch}"),
                )
            }
        }
        git::Merged::Conflict => (
            IntentState::NotDone,
            None,
            format!(
                "merge_conflict: {integration_branch} does not merge into {base_branch}; \
                 nothing was committed"
            ),
        ),
    };
    run.sup
        .inner
        .store
        .intent_close(
            intent_id,
            state,
            IntentOutcome::Acked,
            Some(evidence.clone()),
            None,
            SystemTime::now(),
        )
        .await?;

    match (state, sha) {
        (IntentState::Done, Some(sha)) => Ok(Committed::Landed(sha)),
        _ => Ok(Committed::Refused(evidence)),
    }
}

/// Snapshot, then remove a worktree and its branch — **only** where nothing can be lost.
///
/// Returns whether the checkout was removed. Three rules, each with a measurement behind it:
///
/// 1. Anything uncommitted is committed to the branch **first**, so a removal can never take work
///    with it (`docs/vision.md` §8's snapshot-then-remove).
/// 2. The checkout goes only when `git rev-list --count <base>..<branch>` is **0**. Non-zero
///    proves nothing, so it is never read as "safe to delete"; it is read as "keep it".
/// 3. Branch deletion is **`-d`**. `-D` would delete a branch git itself says is not fully
///    merged, which is the one refusal worth keeping.
async fn retire(
    run: &Run,
    worktree: &Path,
    branch: &str,
    base_branch: &str,
) -> Result<bool, LoopError> {
    if !worktree.is_dir() {
        return Ok(false);
    }
    let root = run.project.root_path.clone();
    if !removable(&run.git, &root, worktree, branch, base_branch).await? {
        return Ok(false);
    }

    let intent_id = uuid::Uuid::new_v4().to_string();
    let mut intent =
        IntentRow::new(intent_id.clone(), KnownIntentKind::WorktreeRemove, SystemTime::now());
    intent.project_id = Some(run.project.id.clone());
    intent.subject = Some(worktree.display().to_string());
    intent.baseline = Some(branch.to_owned());
    run.sup.inner.store.intent_open(intent).await?;

    let outcome = remove(&run.git, &root, worktree, RemoveForce::No).await;
    let gone = outcome.is_ok() && !worktree.exists();
    if gone {
        // `-d`, never `-D`: the count above already proved the branch holds nothing, and if git
        // disagrees it is git that is right.
        if let Err(e) = delete_branch(&run.git, &root, branch, false).await {
            tracing::warn!(branch, error = %e, "the checkout went but the branch did not");
        }
    }
    run.sup
        .inner
        .store
        .intent_close(
            intent_id,
            if gone { IntentState::Done } else { IntentState::NotDone },
            IntentOutcome::Acked,
            Some(match &outcome {
                Ok(()) => format!("rev-list --count {base_branch}..{branch} == 0; removed"),
                Err(e) => format!("git refused: {e}"),
            }),
            None,
            SystemTime::now(),
        )
        .await?;
    Ok(gone)
}

/// Snapshot anything uncommitted, then answer whether the branch may be deleted.
///
/// **The whole cleanup decision, in one place, so nothing else can have an opinion about it.**
/// The rule is `git rev-list --count <base>..<branch> == 0`, and its asymmetry is the point:
/// *0 means nothing to lose, always; non-zero proves nothing.* So a non-zero count is read as
/// "keep it", never as "it was not merged".
///
/// **`git`'s `cherry` subcommand is the alternative and it is measurably wrong in both directions.** It reports
/// three `+` for three commits squashed into one upstream commit, and `-` for work that was
/// applied upstream and then reverted — the second of which authorizes deleting the only
/// remaining copy of that work (`docs/research/worktree-cleanup.md` §§2.2–2.4, **measured** on
/// git 2.50.1). The test below builds that exact case and pins the two answers apart.
pub async fn removable(
    git_bin: &Path,
    repo: &Path,
    worktree: &Path,
    branch: &str,
    base_branch: &str,
) -> Result<bool, git::GitError> {
    if uncommitted(git_bin, worktree).await? {
        // Snapshot, then remove — never the other way round. Best effort: a snapshot that will
        // not commit leaves the count non-zero and the worktree standing, which is the safe
        // direction.
        let _ = git::run(git_bin, worktree, &["add", "-A"]).await;
        let _ = git::run(
            git_bin,
            worktree,
            &["commit", "-q", "-m", "brigadier: snapshot before cleanup"],
        )
        .await;
    }
    let count = git::rev_list_count(git_bin, repo, base_branch, branch).await?;
    if count != 0 {
        tracing::info!(branch, count, "keeping the worktree: its branch still holds work");
    }
    Ok(count == 0)
}

/// Whether a worktree holds tracked or untracked changes worth snapshotting.
///
/// Deliberately **not** `dirty_count`, which passes `--ignored=matching`: a worktree whose only
/// "dirt" is a `target/` directory has nothing to commit, and `git commit` on nothing fails. This
/// asks the narrower question the snapshot actually needs answered.
async fn uncommitted(git_bin: &Path, worktree: &Path) -> Result<bool, git::GitError> {
    let out =
        git::run(git_bin, worktree, &["status", "--porcelain", "--untracked-files=all"]).await?;
    Ok(!out.stdout.trim().is_empty())
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(12)]
}

/// Where a phase's gate logs live, for a caller that wants to name one without a [`Run`].
#[must_use]
pub fn gate_log_path(data_dir: &Path, phase_id: &str, attempt: u32) -> PathBuf {
    data_dir.join("gates").join(phase_id).join(format!("{attempt}.log"))
}

/// Whether a gate result may settle a phase green. One place, so nothing else has an opinion.
#[must_use]
pub fn settles_green(gate: &GateResult) -> bool {
    gate.is_green()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use crate::verify::GateReason;

    fn result(exit: Option<i32>, reason: GateReason) -> GateResult {
        GateResult {
            command: "cargo test".to_owned(),
            exit_code: exit,
            signal: None,
            reason,
            duration: Duration::from_secs(1),
            log_path: PathBuf::from("/l"),
            pipefail: true,
        }
    }

    /// §15 item 9, as an assertion: only exit 0 settles a phase. A signalled run has **no** code
    /// and must never read as a pass.
    #[test]
    fn only_exit_zero_settles_a_phase() {
        assert!(settles_green(&result(Some(0), GateReason::Passed)));
        assert!(!settles_green(&result(Some(101), GateReason::Failed)));
        assert!(!settles_green(&result(Some(127), GateReason::CommandNotFound)));
        assert!(!settles_green(&result(None, GateReason::Signalled)));
        assert!(!settles_green(&result(None, GateReason::TimedOut)));
    }

    #[test]
    fn gate_logs_are_per_phase_and_per_attempt() {
        let p = gate_log_path(Path::new("/data"), "ph1", 3);
        assert_eq!(p, PathBuf::from("/data/gates/ph1/3.log"));
    }

    #[test]
    fn a_short_sha_never_panics_on_a_short_string() {
        assert_eq!(short("abc"), "abc");
        assert_eq!(short("0123456789abcdef"), "0123456789ab");
    }

    /// **The case that separates `rev-list` from `git`'s `cherry` subcommand, and the reason it is
    /// banned.** The patch is applied upstream as a *different* commit and then reverted: the
    /// content now exists nowhere but on `side`, and `cherry` says `-` — *already upstream*,
    /// which authorizes deleting the only copy. `rev-list --count` says 1 and keeps it.
    ///
    /// The squash case from `orchestration-loop.md` §13.1 item 9 is not this test, because both
    /// signals refuse there and it therefore separates nothing.
    #[tokio::test]
    async fn work_applied_upstream_and_then_reverted_is_kept_though_cherry_says_otherwise() {
        let Some(repo) = git::tests::Repo::new().await else { return };
        repo.git(&["checkout", "-q", "-b", "side"]).await;
        repo.write("a.txt", "a\n");
        let side_commit = repo.commit("add a").await;
        repo.git(&["checkout", "-q", "main"]).await;
        // Diverge first. Without this the cherry-pick reproduces `side`'s commit byte for byte —
        // same parent, same tree, same message, same timestamps inside one second — and git hands
        // back the *identical* sha, which is a fast-forward and not the case under test.
        repo.write("b.txt", "b\n");
        repo.commit("add b").await;
        // Applied upstream as a different commit, then undone upstream.
        let picked = repo.git(&["cherry-pick", &side_commit]).await;
        assert!(picked.ok(), "the patch must land upstream as a different commit: {picked:?}");
        let reverted = repo.git(&["revert", "--no-edit", "HEAD"]).await;
        assert!(reverted.ok(), "and then be undone upstream: {reverted:?}");

        // git's own answer, and it is wrong for this purpose.
        let cherry = repo.git(&["cherry", "main", "side"]).await;
        assert!(
            cherry.stdout.starts_with('-'),
            "cherry must claim this is already upstream: {cherry:?}"
        );

        // The production decision. `a.txt` is not in main's tree; deleting `side` would lose it.
        assert!(!repo.root().join("a.txt").exists(), "the revert removed it from main");
        let removable =
            removable(&repo.git, repo.root(), repo.root(), "side", "main").await.expect("ask");
        assert!(!removable, "rev-list keeps the only remaining copy of that work");
    }

    /// The positive half, which a grep for a string cannot give: a branch whose count really is
    /// zero really is removable.
    #[tokio::test]
    async fn a_branch_that_holds_nothing_is_removable() {
        let Some(repo) = git::tests::Repo::new().await else { return };
        repo.git(&["checkout", "-q", "-b", "side"]).await;
        repo.write("a.txt", "a\n");
        repo.commit("add a").await;
        repo.git(&["checkout", "-q", "main"]).await;
        repo.git(&["merge", "--no-ff", "--no-edit", "-m", "phase 1", "side"]).await;
        assert!(removable(&repo.git, repo.root(), repo.root(), "side", "main")
            .await
            .expect("ask"));
    }

    /// Snapshot **then** remove: a worktree with uncommitted work has it committed first, which
    /// turns the count non-zero and keeps the checkout. Nothing is ever deleted with work in it.
    #[tokio::test]
    async fn uncommitted_work_is_committed_first_and_then_keeps_its_worktree() {
        let Some(repo) = git::tests::Repo::new().await else { return };
        repo.git(&["checkout", "-q", "-b", "side"]).await;
        repo.git(&["checkout", "-q", "main"]).await;
        // `side` is level with main: without the snapshot it would be removable.
        assert!(removable(&repo.git, repo.root(), repo.root(), "side", "main")
            .await
            .expect("ask"));

        // Now put uncommitted work on `side` in its own checkout.
        let wt = repo.dir.path().join("wt");
        repo.git(&["worktree", "add", "-q", wt.to_str().expect("utf8"), "side"]).await;
        std::fs::write(wt.join("new.txt"), "unsaved\n").expect("write");
        assert!(
            !removable(&repo.git, repo.root(), &wt, "side", "main").await.expect("ask"),
            "the snapshot put work on the branch, so it must not be removed"
        );
        let count =
            git::rev_list_count(&repo.git, repo.root(), "main", "side").await.expect("count");
        assert_eq!(count, 1, "exactly the snapshot commit");
    }
}
