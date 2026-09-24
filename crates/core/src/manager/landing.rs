//! Landing accepted work: each accepted write task becomes one clean, reviewed commit on the
//! right branch (PLAN §6 Phase 3; corrections B4, B5, B6, B11).
//!
//! 1. **Build the candidate on the current target tip** (`prepare_candidate`): the worker's
//!    whole work since its base, replayed in its worktree. Conflicts go back to the
//!    orchestrator (send the worker back, or delegate a `merge` task).
//! 2. **Litter guard**: only the worker's reported files and tracked changes are staged; logs,
//!    scratch notes, debug scripts and stray files are left out and listed. Unreported tracked
//!    changes are kept and flagged to the reviewer.
//! 3. **Commit** with a normal `git commit` (the repository's hooks run, the user's identity).
//! 4. **Review** by a model from the other vendor (a `review` task over that exact commit and
//!    the worker's verification). Enforced here, whatever the orchestrator asks. If only one
//!    vendor is available, another model of the same vendor reviews, and the card says so.
//! 5. **Approval**: under "Ask for approval" the user approves the landing on a card.
//! 6. **Land** fast-forward only, never over uncommitted, untracked or ignored files, and only
//!    if the target is still where it was (the git engine checks it right before mutating).
//!    If the target moved, the candidate is replayed on the new tip; unless that replay was
//!    clean and touched none of the same paths, it is reviewed again. Anything unsafe leaves
//!    the task "ready to land" with nothing changed.
//!
//! Finishing a new-worktree session merges the session branch into its base the same way,
//! after the user's one click.

use std::path::{Path, PathBuf};

use brigadier_git::{
    CommitOutcome, LandBlock, LandOutcome, LandRequest, MergeOutcome, Oid, PrepareOutcome,
    RebaseOutcome, litter,
};
use brigadier_providers::{ApprovalDecision, ProviderKind};

use super::cards::CardAnswer;
use super::conversation::Envelope;
use super::{SessionManager, blocking, git_error};
use crate::model::{ConversationId, Environment, PermissionLevel, Setup};
use crate::work::{
    ApprovalSubject, Candidate, DiffStat, ExcludedFile, FileStat, InjectionKind, Plan,
    PlanApprover, PlanState, ReviewRecord, ReviewVerdict, Task, TaskKind, TaskState,
};
use crate::{Error, Result, now_ms};

/// How often a landing chases a moving target before it gives up for now.
const LAND_ATTEMPTS: usize = 3;
/// Diffs up to this size are given to the reviewer inline.
const INLINE_DIFF_BYTES: usize = 24_000;

impl SessionManager {
    /// `accept_task`: starts the landing pipeline and returns at once.
    pub(crate) async fn accept_task(
        &self,
        conversation_id: &ConversationId,
        task: Task,
        message: String,
    ) -> Result<String> {
        if !task.kind.writes() {
            return Err(Error::Invalid(format!(
                "task-{} is a {:?} task: only implement and merge tasks land",
                task.number, task.kind
            )));
        }
        let message = message.trim().to_owned();
        if message.is_empty() {
            return Err(Error::Invalid("the commit message is empty".into()));
        }
        match task.state {
            TaskState::Reported => {}
            TaskState::ReadyToLand if task.candidate.is_some() => {}
            state => {
                return Err(Error::Invalid(format!(
                    "task-{} is {state:?}; only a reported task can be accepted",
                    task.number
                )));
            }
        }
        let retry = task.state == TaskState::ReadyToLand;
        let task = self
            .update_task(conversation_id, &task.id, |t| {
                t.state = TaskState::Reviewing;
                t.blocked_reason = None;
            })
            .await?;
        let number = task.number;
        let manager = self.arc();
        self.spawn(async move {
            let result = if retry {
                manager.land_task(&task).await
            } else {
                manager.build_and_review(&task, message).await
            };
            if let Err(err) = result {
                manager
                    .landing_problem(&task, &err.to_string(), TaskState::Reported)
                    .await;
            }
        });
        Ok(if retry {
            format!("Landing task-{number} again; the outcome arrives as a message.")
        } else {
            format!(
                "Accepted task-{number}. Brigadier builds its commit and has it reviewed by another vendor's model; the outcome arrives as a message."
            )
        })
    }

    /// Steps 1–4: candidate, litter guard, commit, review task.
    async fn build_and_review(&self, task: &Task, message: String) -> Result<()> {
        let workspace = task
            .workspace
            .clone()
            .ok_or_else(|| Error::Invalid("the task has no workspace".into()))?;
        let worktree = PathBuf::from(
            workspace
                .worktree
                .clone()
                .ok_or_else(|| Error::Invalid("the task has no worktree".into()))?,
        );
        let base = Oid(workspace
            .base
            .clone()
            .ok_or_else(|| Error::Invalid("the task has no base".into()))?);
        let target = workspace
            .target
            .clone()
            .ok_or_else(|| Error::Invalid("the task has no target branch".into()))?;
        let repo = self.task_repo(task)?;
        let reported = task
            .report
            .as_ref()
            .map(|r| r.changes.clone())
            .unwrap_or_default();

        let git = self.git.clone();
        let (repo_path, path, branch) = (repo.clone(), worktree.clone(), target.clone());
        let commit_message = message.clone();
        let built = blocking(move || {
            let repo = git.open(&repo_path).map_err(git_error)?;
            let onto = repo
                .branch_tip(&branch)
                .map_err(git_error)?
                .ok_or_else(|| Error::Invalid(format!("branch {branch} does not exist")))?;
            let worktree = git.open_worktree(&path).map_err(git_error)?;
            let changes = match worktree
                .prepare_candidate(&base, &onto)
                .map_err(git_error)?
            {
                PrepareOutcome::Prepared { changes } => changes,
                PrepareOutcome::Conflicts { paths } => return Ok(Built::Conflicts { onto, paths }),
            };
            let reported: Vec<String> = reported.iter().map(|p| normalize(p)).collect();
            let mut include = Vec::new();
            let mut excluded = Vec::new();
            let mut unreported = Vec::new();
            for (change, verdict) in litter::classify(&changes, &reported) {
                match verdict {
                    litter::Verdict::Keep => {
                        if !change.untracked && !is_reported(&change.path, &reported) {
                            unreported.push(change.path.clone());
                        }
                        include.push(change.path);
                    }
                    litter::Verdict::Exclude { reason } => excluded.push(ExcludedFile {
                        path: change.path,
                        reason,
                    }),
                }
            }
            match worktree
                .commit_candidate(&include, &commit_message)
                .map_err(git_error)?
            {
                CommitOutcome::Committed { commit, diff_stat } => {
                    let diff = repo.diff(&onto, &commit).map_err(git_error)?;
                    Ok(Built::Committed {
                        onto,
                        commit,
                        diff_stat,
                        excluded,
                        unreported,
                        diff,
                    })
                }
                CommitOutcome::HookFailed { output } => Ok(Built::HookFailed { output }),
                CommitOutcome::Empty => Ok(Built::Empty { excluded }),
            }
        })
        .await?;

        match built {
            Built::Conflicts { onto, paths } => {
                self.landing_problem(
                    task,
                    &format!(
                        "Its changes conflict with the current `{target}` ({}) in: {}. Send task-{} back with message_worker to merge `{target}` into its worktree and resolve the conflicts, or delegate a merge task with subject task-{}.",
                        short(&onto),
                        paths.join(", "),
                        task.number,
                        task.number
                    ),
                    TaskState::Reported,
                )
                .await;
            }
            Built::HookFailed { output } => {
                self.landing_problem(
                    task,
                    &format!(
                        "The repository's commit hooks refused the commit:\n{}\nSend task-{} back with message_worker to fix this.",
                        clip(&output, 3_000),
                        task.number
                    ),
                    TaskState::Reported,
                )
                .await;
            }
            Built::Empty { excluded } => {
                let note = if excluded.is_empty() {
                    String::new()
                } else {
                    format!(
                        " Left out as litter: {}.",
                        excluded
                            .iter()
                            .map(|e| e.path.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                };
                self.dispose_task(task, TaskState::Done).await;
                self.deliver(
                    &task.conversation_id,
                    Envelope {
                        kind: InjectionKind::Decision,
                        label: format!("task-{} empty", task.number),
                        task_id: Some(task.id.clone()),
                        text: format!("[nothing to land task-{}] The task changed nothing that could be committed.{note}", task.number),
                    },
                )
                .await;
            }
            Built::Committed {
                onto,
                commit,
                diff_stat,
                excluded,
                unreported,
                diff,
            } => {
                let live = self.existing_task_live(&task.id);
                let redactor = match live {
                    Some(live) => live.redactor().await,
                    None => None,
                };
                let diff = match redactor {
                    Some(redactor) => redactor.redact(&diff).into_owned(),
                    None => diff,
                };
                let diff_bytes = diff.len() as u64;
                let hash = self.core.store().blobs().put(diff.into_bytes()).await?;
                let candidate = Candidate {
                    commit: commit.0.clone(),
                    onto: onto.0.clone(),
                    message: message.clone(),
                    diff_stat: diff_stat_of(&diff_stat),
                    excluded,
                    diff: Some(crate::work::ArtifactRef {
                        id: hash.to_string(),
                        title: format!("Candidate commit of task-{}", task.number),
                        kind: crate::work::ArtifactKind::Diff,
                        mime: "text/x-diff".into(),
                        bytes: diff_bytes,
                    }),
                };
                let task = self
                    .update_task(&task.conversation_id, &task.id, |t| {
                        t.candidate = Some(candidate);
                        // Later work of this worker is relative to the candidate's parent.
                        if let Some(workspace) = t.workspace.as_mut() {
                            workspace.base = Some(onto.0.clone());
                            workspace.on_snapshot = false;
                        }
                    })
                    .await?;
                self.start_review(&task, unreported).await?;
            }
        }
        Ok(())
    }

    /// B6: the mandatory review of a candidate, by the other vendor.
    async fn start_review(&self, task: &Task, unreported: Vec<String>) -> Result<()> {
        let candidate = task
            .candidate
            .clone()
            .ok_or_else(|| Error::Invalid("no candidate".into()))?;
        let mut spec = format!(
            "Review the candidate commit {} of task-{} (\"{}\"). Decide whether it may land: it must do what the task asked, correctly, without slop, stray files or unverified claims.",
            short(&Oid(candidate.commit.clone())),
            task.number,
            task.title
        );
        if !unreported.is_empty() {
            spec.push_str(&format!(
                "\nThe worker did not report these tracked changes; check they belong to the task: {}.",
                unreported.join(", ")
            ));
        }
        spec.push_str("\nEnd with submit_report and a verdict: approve, or requestChanges with the exact issues in open_questions.");
        let review = self
            .create_task(
                &task.conversation_id,
                format!("Review task-{}", task.number),
                TaskKind::Review,
                spec,
                None,
                Some(brigadier_router::Author {
                    provider: task.route.choice.provider,
                    model: task.route.choice.model.clone(),
                }),
                Some(task.clone()),
                Vec::new(),
            )
            .await?;
        let cross_vendor = review.route.choice.provider != task.route.choice.provider;
        self.update_task(&task.conversation_id, &task.id, |t| {
            t.review = Some(ReviewRecord {
                task_id: review.id.clone(),
                commit: candidate.commit.clone(),
                verdict: None,
                cross_vendor,
            });
        })
        .await?;
        Ok(())
    }

    /// What a reviewer reads about the change: the task, the worker's report, the diff.
    pub(crate) async fn review_brief(&self, subject: &Task) -> String {
        let mut text = format!(
            "\n\nThe task it implements (task-{}):\n{}",
            subject.number, subject.spec
        );
        if let Some(report) = &subject.report {
            text.push_str(&format!(
                "\n\nThe worker's report:\n{}\n{}",
                report.summary,
                report
                    .verification
                    .iter()
                    .map(|v| format!("- verified: {v}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
        if let Some(candidate) = &subject.candidate {
            if !candidate.excluded.is_empty() {
                text.push_str("\n\nLeft out of the commit as litter:");
                for file in &candidate.excluded {
                    text.push_str(&format!("\n- {} ({})", file.path, file.reason));
                }
            }
            text.push_str(&format!(
                "\n\nYour checkout is at the candidate commit; its parent is {}. See the change with `git show --stat HEAD` and `git diff HEAD~1`.",
                short(&Oid(candidate.onto.clone()))
            ));
            if let Some(diff) = &candidate.diff
                && diff.bytes as usize <= INLINE_DIFF_BYTES
                && let Ok(text_diff) = self.core.read_blob_text(diff.id.clone()).await
            {
                text.push_str(&format!("\n\nThe diff:\n```diff\n{text_diff}\n```"));
            }
        }
        text
    }

    /// What a merge worker reads: which task's work to reconcile with which branch tip.
    pub(crate) async fn merge_brief(&self, subject: &Task) -> String {
        let target = subject
            .workspace
            .as_ref()
            .and_then(|w| w.target.clone())
            .unwrap_or_default();
        format!(
            "\n\nThis worktree holds task-{}'s work (\"{}\") as a commit. Merge the current `{target}` into it (`git merge {target}`), resolve every conflict keeping both sides' intent, make sure it builds, and report the files you touched. Brigadier squashes the result into one commit.\n\nThe original task:\n{}",
            subject.number, subject.title, subject.spec
        )
    }

    /// A merge task starts from the conflicting task's work, kept as a WIP commit.
    pub(crate) async fn merge_start(&self, subject: &Task) -> Result<(Oid, Oid)> {
        let workspace = subject
            .workspace
            .clone()
            .ok_or_else(|| Error::Invalid(format!("task-{} has no workspace", subject.number)))?;
        let base = Oid(workspace
            .base
            .ok_or_else(|| Error::Invalid("no base".into()))?);
        let path = match workspace.worktree {
            Some(path) => PathBuf::from(path),
            None => {
                return Err(Error::Invalid(format!(
                    "task-{} has no worktree",
                    subject.number
                )));
            }
        };
        let git = self.git.clone();
        let message = format!("WIP: task-{} before merging", subject.number);
        let head = blocking(move || {
            let worktree = git.open_worktree(&path).map_err(git_error)?;
            worktree.commit_wip(&message).map_err(git_error)?;
            worktree.head().map_err(git_error)
        })
        .await?;
        Ok((base, head))
    }

    /// Whether a review task's report belongs to a landing or a plan review.
    pub(crate) async fn review_in_landing(&self, review: &Task) -> bool {
        let Ok(board) = self.core.board(&review.conversation_id).await else {
            return false;
        };
        board
            .tasks
            .values()
            .any(|t| t.review.as_ref().is_some_and(|r| r.task_id == review.id))
            || board.plans.values().any(
                |p| matches!(&p.state, PlanState::InReview { task_id } if *task_id == review.id),
            )
    }

    /// A landing's or plan's reviewer reported.
    pub(crate) async fn review_reported(&self, review: &Task) {
        let Ok(board) = self.core.board(&review.conversation_id).await else {
            return;
        };
        let verdict = review.report.as_ref().and_then(|r| r.verdict);
        let summary = review
            .report
            .as_ref()
            .map(|r| {
                let mut text = r.summary.clone();
                for issue in &r.open_questions {
                    text.push_str(&format!("\n- {issue}"));
                }
                text
            })
            .unwrap_or_default();
        if let Some(plan) = board
            .plans
            .values()
            .find(|p| matches!(&p.state, PlanState::InReview { task_id } if *task_id == review.id))
            .cloned()
        {
            self.plan_reviewed(plan, review, verdict, summary).await;
            return;
        }
        let Some(task) = board
            .tasks
            .values()
            .find(|t| t.review.as_ref().is_some_and(|r| r.task_id == review.id))
            .cloned()
        else {
            return;
        };
        let _ = self
            .update_task(&task.conversation_id, &task.id, |t| {
                if let Some(record) = t.review.as_mut() {
                    record.verdict = verdict;
                }
            })
            .await;
        if verdict != Some(ReviewVerdict::Approve) {
            let task = self
                .set_task_state(&task.conversation_id, &task.id, TaskState::Reported)
                .await
                .unwrap_or(task);
            self.deliver(
                &task.conversation_id,
                Envelope {
                    kind: InjectionKind::Report,
                    label: format!("review of task-{}", task.number),
                    task_id: Some(task.id.clone()),
                    text: format!(
                        "[review task-{} by task-{} ({})] Changes requested; nothing landed.\n{summary}\n[/review] Send task-{} back with message_worker to fix this, then accept it again.",
                        task.number,
                        review.number,
                        super::workers::route_label(review),
                        task.number
                    ),
                },
            )
            .await;
            return;
        }
        let manager = self.arc();
        self.spawn(async move {
            if let Err(err) = manager.approve_and_land(&task).await {
                manager
                    .landing_problem(&task, &err.to_string(), TaskState::Reported)
                    .await;
            }
        });
    }

    /// Step 5 (the user's approval under "Ask for approval"), then step 6.
    async fn approve_and_land(&self, task: &Task) -> Result<()> {
        let conversation = self.core.conversation(&task.conversation_id)?;
        let permission = match conversation.setup {
            Some(Setup::Session { permission, .. }) => permission,
            _ => PermissionLevel::ApproveForMe,
        };
        if permission == PermissionLevel::AskForApproval {
            let candidate = task
                .candidate
                .clone()
                .ok_or_else(|| Error::Invalid("no candidate".into()))?;
            self.set_task_state(&task.conversation_id, &task.id, TaskState::AwaitingApproval)
                .await?;
            let (_, rx) = self
                .open_approval(
                    &task.conversation_id,
                    Some(task.id.clone()),
                    ApprovalSubject::Landing {
                        task_id: task.id.clone(),
                        branch: task
                            .workspace
                            .as_ref()
                            .and_then(|w| w.target.clone())
                            .unwrap_or_default(),
                        diff_stat: candidate.diff_stat.clone(),
                    },
                )
                .await?;
            match rx.await {
                Ok(CardAnswer::Decision(ApprovalDecision::Allow)) => {}
                Ok(CardAnswer::Decision(ApprovalDecision::Deny { message })) => {
                    self.set_task_state(&task.conversation_id, &task.id, TaskState::Reported)
                        .await?;
                    self.deliver(
                        &task.conversation_id,
                        Envelope {
                            kind: InjectionKind::Decision,
                            label: format!("landing task-{} declined", task.number),
                            task_id: Some(task.id.clone()),
                            text: format!(
                                "[decision] The user declined landing task-{}{}. Nothing landed.",
                                task.number,
                                if message.trim().is_empty() {
                                    String::new()
                                } else {
                                    format!(": {message}")
                                }
                            ),
                        },
                    )
                    .await;
                    return Ok(());
                }
                _ => return Err(Error::Invalid("the landing approval was withdrawn".into())),
            }
        }
        self.land_task(task).await
    }

    /// Step 6: lands the candidate, chasing a target that moved.
    async fn land_task(&self, task: &Task) -> Result<()> {
        let mut task = self.task_by_id(&task.conversation_id, &task.id).await?;
        for _ in 0..LAND_ATTEMPTS {
            let candidate = task
                .candidate
                .clone()
                .ok_or_else(|| Error::Invalid("no candidate".into()))?;
            let target = task
                .workspace
                .as_ref()
                .and_then(|w| w.target.clone())
                .ok_or_else(|| Error::Invalid("no target branch".into()))?;
            let (git, repo) = (self.git.clone(), self.task_repo(&task)?);
            let request = LandRequest {
                branch: target.clone(),
                expected_tip: Oid(candidate.onto.clone()),
                commit: Oid(candidate.commit.clone()),
            };
            let outcome = blocking(move || {
                git.open(&repo)
                    .map_err(git_error)?
                    .land(&request)
                    .map_err(git_error)
            })
            .await?;
            match outcome {
                LandOutcome::Landed { new_tip } => {
                    self.landed(&task, &target, &new_tip).await;
                    return Ok(());
                }
                LandOutcome::Blocked(LandBlock::TipMoved { actual }) => {
                    let worktree = task
                        .workspace
                        .as_ref()
                        .and_then(|w| w.worktree.clone())
                        .map(PathBuf::from)
                        .ok_or_else(|| Error::Invalid("no worktree".into()))?;
                    let (git, old, new) = (
                        self.git.clone(),
                        Oid(candidate.onto.clone()),
                        actual.clone(),
                    );
                    let commit = Oid(candidate.commit.clone());
                    let rebased = blocking(move || {
                        git.open_worktree(&worktree)
                            .map_err(git_error)?
                            .rebase_candidate(&commit, &old, &new)
                            .map_err(git_error)
                    })
                    .await?;
                    match rebased {
                        RebaseOutcome::Rebased { commit, clean_fast } => {
                            task = self
                                .update_task(&task.conversation_id, &task.id, |t| {
                                    if let Some(c) = t.candidate.as_mut() {
                                        c.commit = commit.0.clone();
                                        c.onto = actual.0.clone();
                                    }
                                    if let Some(w) = t.workspace.as_mut() {
                                        w.base = Some(actual.0.clone());
                                        w.on_snapshot = false;
                                    }
                                })
                                .await?;
                            if !clean_fast {
                                // B11: the replay touched paths the target also changed.
                                self.set_task_state(
                                    &task.conversation_id,
                                    &task.id,
                                    TaskState::Reviewing,
                                )
                                .await?;
                                return self.start_review(&task, Vec::new()).await;
                            }
                        }
                        RebaseOutcome::Conflicts { paths } => {
                            self.landing_problem(
                                &task,
                                &format!(
                                    "`{target}` moved and now conflicts with it in: {}. Send task-{} back with message_worker to merge `{target}` and resolve them, or delegate a merge task with subject task-{}.",
                                    paths.join(", "),
                                    task.number,
                                    task.number
                                ),
                                TaskState::Reported,
                            )
                            .await;
                            return Ok(());
                        }
                    }
                }
                LandOutcome::Blocked(block) => {
                    self.landing_problem(
                        &task,
                        &format!(
                            "It is ready to land, but landing now is not safe: {block} Nothing was changed. Call accept_task for task-{} again once that is resolved.",
                            task.number
                        ),
                        TaskState::ReadyToLand,
                    )
                    .await;
                    return Ok(());
                }
            }
        }
        self.landing_problem(
            &task,
            "The target branch kept moving while Brigadier tried to land. Call accept_task again.",
            TaskState::ReadyToLand,
        )
        .await;
        Ok(())
    }

    async fn landed(&self, task: &Task, target: &str, new_tip: &Oid) {
        let _ = self
            .update_task(&task.conversation_id, &task.id, |t| {
                t.landed = Some(new_tip.0.clone());
            })
            .await;
        // The task branch is fully on the target now; it was Brigadier's, so it goes too.
        let branch = task.workspace.as_ref().and_then(|w| w.branch.clone());
        self.dispose_task(task, TaskState::Landed).await;
        if let (Some(branch), Ok(repo)) = (branch, self.task_repo(task)) {
            let git = self.git.clone();
            let into = target.to_owned();
            let deleted = blocking(move || {
                let repo = git.open(&repo).map_err(git_error)?;
                // `git branch -d` would compare with the main checkout's HEAD, which is not
                // the target in a new-worktree session; the merge check here is the real one.
                // Deleted only at the tip found merged: a commit added since then stays.
                if let Some(tip) = repo.branch_tip(&branch).map_err(git_error)?
                    && repo.is_merged(&branch, &into).map_err(git_error)?
                {
                    repo.delete_branch_at(&branch, &tip).map_err(git_error)?;
                }
                Ok(())
            })
            .await;
            if let Err(err) = deleted {
                tracing::warn!(task = %task.id, error = %err, "could not delete the landed task branch");
            }
        }
        let review = task
            .review
            .as_ref()
            .map(|r| {
                if r.cross_vendor {
                    "reviewed by another vendor"
                } else {
                    "reviewed by another model of the same vendor (only one vendor was available)"
                }
            })
            .unwrap_or("reviewed");
        self.deliver(
            &task.conversation_id,
            Envelope {
                kind: InjectionKind::Decision,
                label: format!("landed task-{}", task.number),
                task_id: Some(task.id.clone()),
                text: format!(
                    "[landed task-{}] Commit {} is on `{target}` ({review}).",
                    task.number,
                    short(new_tip)
                ),
            },
        )
        .await;
    }

    /// Something stopped a landing: the task goes to `state` and the orchestrator hears why.
    async fn landing_problem(&self, task: &Task, reason: &str, state: TaskState) {
        let _ = self
            .update_task(&task.conversation_id, &task.id, |t| {
                t.state = state;
                t.blocked_reason = (state == TaskState::ReadyToLand).then(|| reason.to_owned());
            })
            .await;
        self.deliver(
            &task.conversation_id,
            Envelope {
                kind: InjectionKind::Decision,
                label: format!("landing task-{}", task.number),
                task_id: Some(task.id.clone()),
                text: format!(
                    "[not landed task-{} \"{}\"] {reason}",
                    task.number, task.title
                ),
            },
        )
        .await;
    }

    /// `finish_session`: merges the session branch into its base after the user's click.
    pub(crate) async fn finish_session(
        &self,
        id: &ConversationId,
        message: Option<String>,
    ) -> Result<String> {
        let conversation = self.core.conversation(id)?;
        let Some(Setup::Session {
            repo,
            environment: Environment::NewWorktree { base, branch, .. },
            ..
        }) = conversation.setup
        else {
            return Err(Error::Invalid(
                "this session works on a local checkout: its commits are already on the picked branch".into(),
            ));
        };
        let open: Vec<String> = self
            .core
            .tasks(id)
            .await?
            .iter()
            .filter(|t| t.kind.writes() && !t.state.is_final())
            .map(|t| format!("task-{}", t.number))
            .collect();
        if !open.is_empty() {
            return Err(Error::Invalid(format!(
                "write tasks are still open: {}. Land or stop them first.",
                open.join(", ")
            )));
        }
        let message = message
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| format!("Merge {branch} into {base}"));
        let (git, repo_path, base_name, branch_name) = (
            self.git.clone(),
            PathBuf::from(&repo),
            base.clone(),
            branch.clone(),
        );
        let prepared = blocking(move || {
            let repo = git.open(&repo_path).map_err(git_error)?;
            let outcome = repo
                .prepare_merge(&base_name, &branch_name, &message)
                .map_err(git_error)?;
            match outcome {
                MergeOutcome::Ready {
                    commit,
                    base_tip,
                    fast_forward,
                } => {
                    let tip = repo
                        .branch_tip(&branch_name)
                        .map_err(git_error)?
                        .ok_or_else(|| Error::Invalid("the session branch is gone".into()))?;
                    let commits = repo.count_commits(&base_tip, &tip).map_err(git_error)?;
                    let stat = repo.diff_stat(&base_tip, &commit).map_err(git_error)?;
                    Ok(Ok((commit, base_tip, tip, fast_forward, commits, stat)))
                }
                MergeOutcome::Conflicts { paths } => Ok(Err(paths)),
            }
        })
        .await?;
        let (commit, base_tip, session_tip, _fast_forward, commits, stat) = match prepared {
            Ok(ready) => ready,
            Err(paths) => {
                return Err(Error::Invalid(format!(
                    "`{branch}` conflicts with the current `{base}` in: {}. Delegate a merge task that merges `{base}` into the session's work, land it, then finish again.",
                    paths.join(", ")
                )));
            }
        };
        if commits == 0 {
            return Err(Error::Invalid(format!(
                "`{branch}` has no commits that `{base}` lacks"
            )));
        }
        let (approval, rx) = self
            .open_approval(
                id,
                None,
                ApprovalSubject::FinishSession {
                    branch: branch.clone(),
                    base: base.clone(),
                    commits,
                    diff_stat: diff_stat_of(&stat),
                },
            )
            .await?;
        let manager = self.arc();
        let id = id.clone();
        self.spawn(async move {
            let text = match rx.await {
                Ok(CardAnswer::Decision(ApprovalDecision::Allow)) => {
                    let (git, repo_path, session_branch) =
                        (manager.git.clone(), PathBuf::from(&repo), branch.clone());
                    let request = LandRequest {
                        branch: base.clone(),
                        expected_tip: base_tip,
                        commit,
                    };
                    // What the user approved is the session branch as it was: work that landed
                    // on it while the card was open would be left out.
                    let landing = blocking(move || {
                        let repo = git.open(&repo_path).map_err(git_error)?;
                        if repo.branch_tip(&session_branch).map_err(git_error)? != Some(session_tip) {
                            return Ok(None);
                        }
                        repo.land(&request).map(Some).map_err(git_error)
                    });
                    match landing.await {
                        Ok(None) => format!("[not finished] `{branch}` changed after the user was asked. Nothing was merged; call finish_session again."),
                        Ok(Some(LandOutcome::Landed { new_tip })) => format!(
                            "[finished] The user approved: `{branch}` ({commits} commit{}) is merged into `{base}` at {}.",
                            if commits == 1 { "" } else { "s" },
                            short(&new_tip)
                        ),
                        Ok(Some(LandOutcome::Blocked(block))) => format!("[not finished] Merging `{branch}` into `{base}` is not safe now: {block} Nothing was changed; call finish_session again."),
                        Err(err) => format!("[not finished] Merging failed: {err}. Nothing was changed."),
                    }
                }
                Ok(CardAnswer::Decision(ApprovalDecision::Deny { message })) => format!(
                    "[decision] The user did not merge `{branch}` into `{base}`{}.",
                    if message.trim().is_empty() { String::new() } else { format!(": {message}") }
                ),
                _ => {
                    manager
                        .settle_approval(&approval, crate::work::CardState::Expired { reason: "withdrawn".into() })
                        .await;
                    return;
                }
            };
            manager
                .deliver(
                    &id,
                    Envelope {
                        kind: InjectionKind::Decision,
                        label: "finish session".into(),
                        task_id: None,
                        text,
                    },
                )
                .await;
        });
        Ok("Asked the user to approve merging the session branch; the outcome arrives as a message.".into())
    }

    /// A risky plan under "Approve for me" gets one review by another vendor first.
    pub(crate) async fn start_plan_review(&self, id: &ConversationId, plan: &Plan) -> Result<Task> {
        let orchestrator = match self.core.conversation(id)?.setup {
            Some(Setup::Session { orchestrator, .. }) => brigadier_router::Author {
                provider: orchestrator.provider,
                model: orchestrator.model,
            },
            _ => brigadier_router::Author {
                provider: ProviderKind::Claude,
                model: None,
            },
        };
        let mut spec = format!(
            "Review this plan before it is carried out. Check it against the repository (read-only): is it sound, complete, and the simplest thing that works? Are there risks, missing steps or wrong assumptions?\n\nPlan: {}\n",
            plan.title
        );
        for (index, step) in plan.steps.iter().enumerate() {
            spec.push_str(&format!("{}. {}", index + 1, step.title));
            if let Some(detail) = &step.detail {
                spec.push_str(&format!(" — {detail}"));
            }
            spec.push('\n');
        }
        spec.push_str("\nEnd with submit_report and a verdict: approve, or requestChanges with the exact issues in open_questions.");
        self.create_task(
            id,
            format!("Review plan: {}", plan.title),
            TaskKind::Review,
            spec,
            None,
            Some(orchestrator),
            None,
            Vec::new(),
        )
        .await
    }

    async fn plan_reviewed(
        &self,
        mut plan: Plan,
        review: &Task,
        verdict: Option<ReviewVerdict>,
        summary: String,
    ) {
        let approved = verdict == Some(ReviewVerdict::Approve);
        plan.state = if approved {
            PlanState::Approved {
                by: PlanApprover::Review,
            }
        } else {
            PlanState::Rejected {
                message: Some(summary.clone()),
            }
        };
        plan.decided_at_ms = Some(now_ms());
        if let Err(err) = self.store_plan(&plan).await {
            tracing::warn!(plan = %plan.id, error = %err, "could not record a plan review");
        }
        let text = if approved {
            format!(
                "[decision] The plan \"{}\" was reviewed by task-{} ({}) and approved on the user's behalf. Go ahead.\n{summary}",
                plan.title,
                review.number,
                super::workers::route_label(review)
            )
        } else {
            format!(
                "[decision] The reviewer (task-{}, {}) did not approve the plan \"{}\":\n{summary}\nRevise it and propose it again.",
                review.number,
                super::workers::route_label(review),
                plan.title
            )
        };
        self.deliver(
            &plan.conversation_id,
            Envelope {
                kind: InjectionKind::Decision,
                label: "plan review".into(),
                task_id: Some(review.id.clone()),
                text,
            },
        )
        .await;
    }

    pub(super) fn task_repo(&self, task: &Task) -> Result<PathBuf> {
        match self.core.conversation(&task.conversation_id)?.setup {
            Some(Setup::Session { repo, .. }) => Ok(PathBuf::from(repo)),
            _ => Err(Error::Invalid("tasks belong to a session".into())),
        }
    }
}

enum Built {
    Conflicts {
        onto: Oid,
        paths: Vec<String>,
    },
    HookFailed {
        output: String,
    },
    Empty {
        excluded: Vec<ExcludedFile>,
    },
    Committed {
        onto: Oid,
        commit: Oid,
        diff_stat: brigadier_git::DiffStat,
        excluded: Vec<ExcludedFile>,
        unreported: Vec<String>,
        diff: String,
    },
}

fn diff_stat_of(stat: &brigadier_git::DiffStat) -> DiffStat {
    DiffStat {
        files: stat
            .files
            .iter()
            .map(|file| FileStat {
                path: file.path.clone(),
                insertions: file.insertions,
                deletions: file.deletions,
                binary: file.binary,
            })
            .collect(),
        insertions: stat.insertions,
        deletions: stat.deletions,
    }
}

/// A repo-relative path as reported (`./a/b`, `a/b/`) → `a/b`.
fn normalize(path: &str) -> String {
    let path = path.trim().trim_start_matches("./").trim_end_matches('/');
    Path::new(path).to_string_lossy().into_owned()
}

fn is_reported(path: &str, reported: &[String]) -> bool {
    reported.iter().any(|r| {
        path == r || path.starts_with(&format!("{r}/")) || r.ends_with(&format!("/{path}"))
    })
}

fn short(oid: &Oid) -> String {
    oid.0.chars().take(10).collect()
}

fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}
