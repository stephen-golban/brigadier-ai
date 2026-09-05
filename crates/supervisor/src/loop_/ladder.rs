//! The red-gate ladder: **rung 1, then rung 3.**
//!
//! Rung 2 is deliberately absent, and this is the seam where it would go.
//! `docs/research/orchestration-loop.md` §16 names rung 2 *"the weakest claim in this document"*
//! in as many words: `docs/vision.md` §5's whole argument for fusion is that *a differently-trained
//! model has different blind spots*, and `CLAUDE.md` §2 settles **Claude Code only for v1**, so
//! two Claude arms do not have different blind spots and rung 2 is two spawns of pure cost if the
//! claim is wrong. Nothing measured says otherwise in either direction
//! (`docs/plans/w1b-loop-order.md` §1 D3).
//!
//! The consequence to carry forward: the child ceiling for a red phase is **N + 1** — N workers
//! and one fixer — and **two** gate executions. `orchestration-loop.md` §14's `N + 3` is stale.
//!
//! ## Rung 1
//!
//! One fresh child, the original order's phase, and what failed. It works **in the per-phase
//! integration worktree**, so there is nothing to re-merge and the gate re-runs in place.
//!
//! It gets the gate's output **as a file it can read with its own tools**, copied into its own
//! tree at `.brigadier/gate-<attempt>.log` **before** its baseline `dirty_count` is captured. That
//! ordering is load-bearing: `dirty_count` passes `--ignored=matching` and
//! `--untracked-files=all`, so any harness file inside a worktree counts toward it, and a file
//! created after the baseline would read as work the fixer did (`orchestration-loop.md` §4.2).
//! The harness pays zero tokens for it and the fixer pays only for what it chooses to read.
// see docs/research/orchestration-loop.md §7 and docs/vision.md §5.

use std::path::{Path, PathBuf};

use brigadier_core::driver::ThinkingPolicy;
use brigadier_store::plan::PhaseRow;

use crate::loop_::call::{CallCwd, CallRequest};
use crate::loop_::{git, LoopError, Run};
use crate::verify::GateResult;

/// Where the gate's log is put inside the fixer's own worktree.
pub const FIXER_LOG_DIR: &str = ".brigadier";

/// What rung 1 did, so rung 3 can say it.
#[derive(Clone, Debug)]
pub struct Attempt {
    /// The integration branch's sha **before** the fixer touched anything.
    ///
    /// Recorded so `git reset --hard <sha>` undoes a fixer that made things worse. The loop does
    /// **not** run that reset itself: `orchestration-loop.md` §7 rung 3 requires that the
    /// branches still holding each attempt's work survive for the owner to look at, and throwing
    /// the fixer's diff away would contradict it. The sha is handed over instead.
    pub before_sha: String,
    /// Where the gate's output was put inside the fixer's worktree.
    pub log_in_worktree: PathBuf,
    /// How the fixer's own call ended.
    pub end: String,
}

/// Rung 1: one fresh fixer in the integration worktree, told exactly what failed. **One attempt.**
pub(super) async fn rung_one(
    run: &Run,
    phase: &PhaseRow,
    integration: &Path,
    branch: &str,
    gate: &GateResult,
) -> Result<Attempt, LoopError> {
    let before_sha = git::rev_parse(&run.git, integration, "HEAD").await?;

    // Before the baseline, never after. The fixer's own `dirty_count` must see this file at
    // both ends, so that only its *content* is what changed.
    let log_in_worktree =
        copy_log_into(integration, &gate.log_path, phase.attempts.max(1)).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "could not put the gate log in the fixer's worktree");
            gate.log_path.clone()
        });

    let outcome = run
        .call
        .call(CallRequest {
            project_id: run.project.id.clone(),
            label: "fixer",
            cwd: CallCwd::Worktree {
                dir: integration.to_path_buf(),
                branch: Some(branch.to_owned()),
            },
            prompt: fixer_prompt(&run.goal, phase, gate, &log_in_worktree),
            turn_deadline: run.limits.worker_turn_deadline,
            quiet_deadline: run.limits.worker_quiet_deadline,
            thinking: ThinkingPolicy::Inherit,
            // A fixer is diagnosis, not transcription: with no pick it takes the provider default
            // rather than a tier, which is `docs/vision.md` §6's judgement lane. With a pick, the
            // pick — a ceiling bounds the fixer like everything else (`loop_/routing.rs`).
            model: run.ceiling.judgement(),
            permission_mode: run.permission_mode.clone(),
        })
        .await?;

    Ok(Attempt {
        before_sha,
        log_in_worktree,
        end: outcome.end.slug().to_owned(),
    })
}

/// Copy the gate's log into `<worktree>/.brigadier/gate-<attempt>.log`.
///
/// A copy rather than a hard link: the two may be on different filesystems, and a link would let
/// a fixer that opened the file for writing corrupt the harness's own record of the failure.
fn copy_log_into(
    worktree: &Path,
    log: &Path,
    attempt: u32,
) -> std::io::Result<PathBuf> {
    let dir = worktree.join(FIXER_LOG_DIR);
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(format!("gate-{attempt}.log"));
    // An absent log is not a failure: the gate may have died before it opened one, and the fixer
    // is better off with an empty file it can read than with a path that does not exist.
    match std::fs::copy(log, &dest) {
        Ok(_) => Ok(dest),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::write(&dest, b"")?;
            Ok(dest)
        }
        Err(e) => Err(e),
    }
}

/// Rung 3: stop, and hand the owner a real diagnosis.
///
/// Everything `orchestration-loop.md` §7 rung 3 requires the plan card to carry, minus the two
/// things this tree cannot supply and which are named rather than guessed at:
///
/// - **every attempt's history.** `PhaseRow` stores **one** `last_exit_code` and one
///   `last_evidence` and has no per-attempt table, so after a restart only the last attempt can
///   be reconstructed. Closing that is a schema change, not a runtime guess
///   (`docs/plans/w1b-loop-order.md` §7.6).
/// - **the first failing assertion.** Nothing here extracts one, and the card says so rather than
///   guessing.
#[derive(Clone, Debug)]
pub struct Diagnosis {
    /// The phase's own verify command, verbatim.
    pub command: String,
    /// The gate's exit code, or `None` when it was signalled.
    pub exit_code: Option<i32>,
    /// The gate's reason slug.
    pub reason: &'static str,
    /// How many attempts the phase has had.
    pub attempts: u32,
    /// Where the output is. **The path, never the contents.**
    pub log_path: PathBuf,
    /// Branches still holding each attempt's work. Nothing is deleted.
    pub branches: Vec<String>,
    /// The sha to `git reset --hard` back to, when rung 1 ran.
    pub before_fix: Option<String>,
}

impl Diagnosis {
    /// The one line the thread gets: `Phase 3 blocked — cargo test --workspace exited 101 after
    /// 2 attempts.`
    ///
    /// **No tail and no excerpt.** `docs/vision.md` §4 step 7.5: the verify command's output goes
    /// to a worker's window, never into the thread.
    #[must_use]
    pub fn thread_line(&self, phase_label: &str) -> String {
        let outcome = match self.exit_code {
            Some(code) => format!("exited {code}"),
            None => format!("ended {}", self.reason),
        };
        format!(
            "{phase_label} blocked — {} {outcome} after {} attempt{}.",
            self.command,
            self.attempts,
            if self.attempts == 1 { "" } else { "s" }
        )
    }

    /// The bounded evidence the phase row keeps, which is what the plan card reads back after a
    /// restart.
    #[must_use]
    pub fn evidence(&self) -> String {
        let mut out = format!(
            "{} {} ({}), {} attempt(s); log {}",
            self.command,
            self.exit_code.map_or_else(|| "signalled".to_owned(), |c| format!("exited {c}")),
            self.reason,
            self.attempts,
            self.log_path.display()
        );
        if !self.branches.is_empty() {
            out.push_str("; work kept on ");
            out.push_str(&self.branches.join(", "));
        }
        if let Some(sha) = &self.before_fix {
            out.push_str("; pre-fix ");
            out.push_str(&sha[..sha.len().min(12)]);
        }
        out.push_str("; no failing assertion was extracted");
        out
    }
}

/// The fixer's whole window: the order's phase, what failed, and where to read it.
fn fixer_prompt(goal: &str, phase: &PhaseRow, gate: &GateResult, log: &Path) -> String {
    let outcome = match gate.exit_code {
        Some(code) => format!("exited {code}"),
        None => format!("was killed ({})", gate.reason.slug()),
    };
    format!(
        "You are fixing a failed gate in an autonomous coding harness.\n\
         \n\
         You are in the phase's **integration** worktree: every work order for this phase is\n\
         already merged here. Fix it in place; there is nothing to re-merge.\n\
         \n\
         The run's goal:\n\n{goal}\n\
         \n\
         The phase: {title}\n\
         Done when: {dod}\n\
         \n\
         The gate is `{command}`. It {outcome}, reason `{reason}`.\n\
         Its full output is in your own worktree at {log} — read it with your own tools; it was\n\
         not put in this prompt on purpose.\n\
         \n\
         Make the gate pass. Do not change the gate: a change to a verify command is a change to\n\
         what \"done\" means and is not yours to make. Commit your fix on this branch.\n\
         \n\
         The harness re-runs the gate itself when you are finished. Your own report of success\n\
         settles nothing.\n",
        title = phase.title,
        dod = phase.definition_of_done,
        command = gate.command,
        reason = gate.reason.slug(),
        log = log.display(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use crate::verify::GateReason;

    fn gate(exit: Option<i32>, reason: GateReason) -> GateResult {
        GateResult {
            command: "cargo test --workspace".to_owned(),
            exit_code: exit,
            signal: None,
            reason,
            duration: Duration::from_secs(1),
            log_path: PathBuf::from("/data/gates/ph1/1.log"),
            pipefail: true,
        }
    }

    fn phase() -> PhaseRow {
        let mut row = PhaseRow::new("ph1", "plan", 2, "API routes");
        row.definition_of_done = "the routes answer".to_owned();
        row.verify_command = Some("cargo test --workspace".to_owned());
        row.attempts = 2;
        row
    }

    /// `docs/vision.md` §9's shape, and the rule that goes with it: one harness-derived line, no
    /// tail, no excerpt.
    #[test]
    fn the_thread_line_carries_the_exit_code_and_no_output() {
        let d = Diagnosis {
            command: "cargo test --workspace".into(),
            exit_code: Some(101),
            reason: "failed",
            attempts: 2,
            log_path: PathBuf::from("/data/gates/ph1/2.log"),
            branches: vec!["brigadier/aa11".into()],
            before_fix: Some("0123456789abcdef".into()),
        };
        assert_eq!(
            d.thread_line("Phase 3"),
            "Phase 3 blocked — cargo test --workspace exited 101 after 2 attempts."
        );
        assert!(!d.thread_line("Phase 3").contains("/data/gates"));
    }

    #[test]
    fn a_signalled_gate_says_so_rather_than_inventing_a_code() {
        let d = Diagnosis {
            command: "cargo test".into(),
            exit_code: None,
            reason: "signalled",
            attempts: 1,
            log_path: PathBuf::from("/l"),
            branches: vec![],
            before_fix: None,
        };
        assert_eq!(d.thread_line("Phase 1"), "Phase 1 blocked — cargo test ended signalled after 1 attempt.");
    }

    #[test]
    fn the_evidence_carries_the_log_path_and_admits_what_it_could_not_extract() {
        let d = Diagnosis {
            command: "cargo test".into(),
            exit_code: Some(101),
            reason: "failed",
            attempts: 2,
            log_path: PathBuf::from("/data/gates/ph1/2.log"),
            branches: vec!["brigadier/aa11".into(), "brigadier/bb22".into()],
            before_fix: Some("0123456789abcdef0".into()),
        };
        let e = d.evidence();
        assert!(e.contains("/data/gates/ph1/2.log"));
        assert!(e.contains("brigadier/aa11, brigadier/bb22"), "nothing is deleted: {e}");
        assert!(e.contains("pre-fix 0123456789ab"));
        assert!(e.contains("no failing assertion was extracted"));
    }

    /// §6.4: the fixer is the one window that gets the output, and it gets it as a **path**.
    #[test]
    fn the_fixer_is_told_where_the_log_is_and_is_not_handed_its_contents() {
        let prompt = fixer_prompt(
            "ship it",
            &phase(),
            &gate(Some(101), GateReason::Failed),
            Path::new("/wt/.brigadier/gate-2.log"),
        );
        assert!(prompt.contains("/wt/.brigadier/gate-2.log"));
        assert!(prompt.contains("exited 101"));
        assert!(prompt.contains("integration"));
        assert!(prompt.contains("Do not change the gate"));
        assert!(prompt.contains("settles nothing"));
    }

    #[test]
    fn a_signalled_gate_reaches_the_fixer_as_killed_not_as_a_zero() {
        let prompt = fixer_prompt(
            "g",
            &phase(),
            &gate(None, GateReason::TimedOut),
            Path::new("/wt/.brigadier/gate-1.log"),
        );
        assert!(prompt.contains("was killed (timed_out)"));
        assert!(!prompt.contains("exited 0"));
    }

    /// The ordering §4.2 makes load-bearing: the file exists before the baseline is taken, so
    /// only its content changes afterwards.
    #[test]
    fn the_log_lands_in_the_worktree_and_an_absent_log_becomes_an_empty_file() {
        let wt = tempfile::tempdir().expect("tempdir");
        let src = wt.path().join("src.log");
        std::fs::write(&src, b"boom\n").expect("write");
        let dest = copy_log_into(wt.path(), &src, 2).expect("copy");
        assert_eq!(dest, wt.path().join(".brigadier/gate-2.log"));
        assert_eq!(std::fs::read(&dest).expect("read"), b"boom\n");

        let missing = copy_log_into(wt.path(), Path::new("/nope/nothing.log"), 3).expect("copy");
        assert!(missing.exists());
        assert_eq!(std::fs::metadata(&missing).expect("stat").len(), 0);
    }
}
