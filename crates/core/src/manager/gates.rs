//! Gates: the independent checks every accepted change passes before it lands (PLAN §6
//! Phase 6, built in, always on).
//!
//! A gate round runs, in parallel and on one candidate commit, a reviewer from another vendor
//! (two for risky work, on different models) and a verifier that runs the project's checks
//! and proves each "done when" criterion of the task. Each member's result is recorded against
//! its round, and the round is decided once every member has one:
//!
//! - **All passed:** the change lands (after the user's click under "Ask for approval").
//! - **Changes needed** (a reviewer asked for them, or a criterion is unmet): Brigadier sends
//!   the worker the findings itself and gates its next report again, at most [`FIX_ROUNDS`]
//!   times. Then the orchestrator decides.
//! - **Not verified** (checks that couldn't run, criteria left unchecked): a second verifier
//!   on another model tries once. If it can't either, nothing lands: the task waits, ready to
//!   land, with what blocks it.
//! - **No result** (a member failed or was stopped, or the verifier changed its checkout):
//!   nothing lands, and the orchestrator hears why.
//!
//! A newer candidate (a fix, or a replay onto a target that moved) opens a new round, with a
//! new verification; results of an older round are ignored.

use brigadier_git::Oid;
use brigadier_router::Author;

use super::conversation::Envelope;
use super::{SessionManager, blocking, git_error};
use crate::model::ModelChoice;
use crate::work::{
    Gate, GateLink, GateMember, GateOutcome, GateOwner, GateResult, GateRole, InjectionKind,
    Report, ReviewRecord, ReviewVerdict, Task, TaskId, TaskKind, TaskState, WaitingSource,
};
use crate::{Error, Result};

/// Times Brigadier sends a task back with a gate's findings before the orchestrator decides.
pub(crate) const FIX_ROUNDS: u32 = 2;
/// Gate rounds one task may go through (fixes, retries, replays) before Brigadier gives up.
const MAX_ROUNDS: u32 = 8;
/// A change this big (lines added and removed, or files) gets two reviewers.
const RISKY_LINES: u32 = 400;
const RISKY_FILES: usize = 15;

/// What a new gate round checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Recheck {
    /// Reviewers and a verifier: a new candidate.
    Full,
    /// A verifier only: the same change, already reviewed, on a new commit (a clean replay
    /// onto a target that moved) or verified again after a verifier couldn't.
    Verify,
}

/// Why a gate round could not open.
pub(crate) enum NotOpened {
    /// The worker's fix round changed nothing: the orchestrator decides.
    Unchanged,
    Error(Error),
}

impl From<Error> for NotOpened {
    fn from(err: Error) -> Self {
        Self::Error(err)
    }
}

impl SessionManager {
    /// How many reviewers check a change: two for risky work (a step of a risky plan, a task
    /// asked to run at the highest quality, or a big change), one otherwise. The Phase 6
    /// fusion panel (more reviewers and an analyst) is decided here too.
    async fn panel_size(&self, task: &Task) -> usize {
        let big = task.candidate.as_ref().is_some_and(|candidate| {
            candidate.diff_stat.insertions + candidate.diff_stat.deletions > RISKY_LINES
                || candidate.diff_stat.files.len() > RISKY_FILES
        });
        let highest = task.floor >= brigadier_router::QualityTier::Frontier;
        let risky_plan = self
            .core
            .board(&task.conversation_id)
            .await
            .is_ok_and(|board| {
                board.plans.values().any(|plan| {
                    plan.risky
                        && plan
                            .steps
                            .iter()
                            .any(|step| step.task_id.as_ref() == Some(&task.id))
                })
            });
        if big || highest || risky_plan { 2 } else { 1 }
    }

    /// Opens a new gate round on the task's candidate. `unreported` lists tracked changes the
    /// worker didn't report; `retry` says why an earlier verifier couldn't check the change.
    /// `relanding`: the user already approved this change (a clean replay); it lands as soon
    /// as the round passes.
    pub(crate) async fn open_gate(
        &self,
        task: &Task,
        unreported: Vec<String>,
        recheck: Recheck,
        retry: Option<(String, Author)>,
    ) -> std::result::Result<(), NotOpened> {
        let held = self.gates.lock().await;
        let task = self.task_by_id(&task.conversation_id, &task.id).await?;
        let candidate = task
            .candidate
            .clone()
            .ok_or_else(|| Error::Invalid("no candidate".into()))?;
        let round = task.gate.as_ref().map_or(1, |gate| gate.round + 1);
        if round > MAX_ROUNDS {
            return Err(Error::Invalid(format!(
                "Its change was checked {MAX_ROUNDS} times without landing; nothing landed. Look at the last findings and decide."
            ))
            .into());
        }
        // A fix round that changed nothing would only be checked to the same end.
        if let Some(previous) = &task.gate
            && previous.outcome == Some(GateOutcome::Failed)
            && let Some(before) = &previous.commit
            && self.same_tree(&task, before, &candidate.commit).await
        {
            return Err(NotOpened::Unchanged);
        }
        let author = Author {
            provider: task.route.choice.provider,
            model: task.route.choice.model.clone(),
        };
        let owner = GateOwner::Task {
            task_id: task.id.clone(),
        };
        let reviewers = match recheck {
            Recheck::Full => self.panel_size(&task).await,
            Recheck::Verify => 0,
        };
        let plan = plan_note(&task, self.wrote_plan(&task).await);
        let mut members: Vec<GateMember> = Vec::new();
        let mut started: Vec<Task> = Vec::new();
        let mut checking: Vec<Author> = Vec::new();
        let opened: Result<Option<ReviewRecord>> = async {
            let mut first = None;
            for index in 0..reviewers {
                let review = self
                    .create_task(
                        &task.conversation_id,
                        if index == 0 {
                            format!("Review task-{}", task.number)
                        } else {
                            format!("Second review of task-{}", task.number)
                        },
                        TaskKind::Review,
                        review_spec(&task, &candidate.commit, &unreported, plan.as_deref()),
                        None,
                        Some(author.clone()),
                        checking.clone(),
                        Some(GateLink {
                            owner: owner.clone(),
                            round,
                            role: GateRole::Review,
                        }),
                        Some(task.clone()),
                        Vec::new(),
                        // It reviews the change where the change is.
                        Some(task.areas.clone()),
                        None,
                        Vec::new(),
                    )
                    .await?;
                checking.push(Author {
                    provider: review.route.choice.provider,
                    model: review.route.choice.model.clone(),
                });
                if first.is_none() {
                    first = Some(ReviewRecord {
                        task_id: review.id.clone(),
                        commit: candidate.commit.clone(),
                        verdict: None,
                        cross_vendor: review.route.choice.provider != author.provider,
                    });
                }
                members.push(GateMember {
                    task_id: review.id.clone(),
                    role: GateRole::Review,
                    result: None,
                    avoid: Vec::new(),
                });
                started.push(review);
            }
            let verify = self
                .create_task(
                    &task.conversation_id,
                    format!("Verify task-{}", task.number),
                    TaskKind::Verify,
                    verify_spec(
                        &task,
                        &candidate.commit,
                        retry.as_ref().map(|(why, _)| why),
                        plan.as_deref(),
                    ),
                    None,
                    Some(author.clone()),
                    retry.iter().map(|(_, before)| before.clone()).collect(),
                    Some(GateLink {
                        owner: owner.clone(),
                        round,
                        role: GateRole::Verify,
                    }),
                    Some(task.clone()),
                    Vec::new(),
                    Some(task.areas.clone()),
                    // Proving a change takes a capable model, not a light one.
                    Some(brigadier_router::QualityTier::Strong),
                    Vec::new(),
                )
                .await?;
            members.push(GateMember {
                task_id: verify.id.clone(),
                role: GateRole::Verify,
                result: None,
                // A hand-off of the second verifier avoids the first one too.
                avoid: retry
                    .iter()
                    .map(|(_, before)| ModelChoice {
                        provider: before.provider,
                        model: before.model.clone(),
                        effort: None,
                        fast: None,
                    })
                    .collect(),
            });
            started.push(verify);
            Ok(first)
        }
        .await;
        let first = match opened {
            Ok(first) => first,
            Err(err) => {
                // Nothing half-started keeps running. Stopped outside the lock: a stopped
                // member's missing result is recorded under it.
                drop(held);
                for member in started {
                    let _ = Box::pin(self.stop_task(member.id)).await;
                }
                return Err(err.into());
            }
        };
        let relanding = recheck == Recheck::Verify && retry.is_none();
        let retrying = retry.is_some();
        self.update_task(&task.conversation_id, &task.id, |t| {
            t.gate = Some(Gate {
                round,
                commit: Some(candidate.commit.clone()),
                members,
                outcome: None,
                relanding,
                retry: retrying,
                findings: Vec::new(),
            });
            if let Some(first) = first {
                t.review = Some(first);
            }
            t.state = TaskState::Reviewing;
            t.blocked_reason = None;
        })
        .await?;
        Ok(())
    }

    /// Whether the worker wrote a plan (plan.md in its outputs folder) before a big change.
    async fn wrote_plan(&self, task: &Task) -> bool {
        let Some(workspace) = &task.workspace else {
            return false;
        };
        let plan =
            super::outputs::outputs_dir(std::path::Path::new(&workspace.scratch)).join("plan.md");
        tokio::fs::metadata(&plan)
            .await
            .is_ok_and(|meta| meta.is_file() && meta.len() > 0)
    }

    /// Whether two commits of the task's repository hold the same files.
    async fn same_tree(&self, task: &Task, a: &str, b: &str) -> bool {
        let Ok(repo) = self.task_repo(task) else {
            return false;
        };
        let (git, a, b) = (self.git.clone(), a.to_owned(), b.to_owned());
        blocking(move || {
            let repo = git.open(&repo).map_err(git_error)?;
            let a = repo.tree_of(&a).map_err(git_error)?;
            let b = repo.tree_of(&b).map_err(git_error)?;
            Ok(a == b)
        })
        .await
        .unwrap_or(false)
    }

    /// A gate member reported. Called while its report is recorded, before its turn ends, so
    /// a verifier's checkout is still there to compare with the commit it checked.
    pub(crate) async fn gate_member_reported(&self, member: &Task) {
        let Some(link) = member.gate_link.clone() else {
            return;
        };
        let task_id = match &link.owner {
            GateOwner::Task { task_id } => task_id,
            GateOwner::Plan { plan_id } => {
                self.plan_member_done(member, plan_id, &link, None).await;
                return;
            }
        };
        let Some(report) = &member.report else {
            return;
        };
        let result = match link.role {
            GateRole::Review => review_result(report),
            GateRole::Verify => match self.verifier_changes(member).await {
                Some(changed) => GateResult::NoResult {
                    reason: format!(
                        "The verifier (task-{}) changed what it checked ({changed}), so its result was discarded.",
                        member.number
                    ),
                },
                None => {
                    // It covers at least the criteria the worker listed.
                    let listed = self
                        .task_by_id(&member.conversation_id, task_id)
                        .await
                        .ok()
                        .and_then(|owner| owner.report)
                        .map_or(0, |report| report.done_when.len());
                    verify_result(report, listed)
                }
            },
        };
        self.record_gate_result(member, task_id, &link, result)
            .await;
    }

    /// A gate member failed or was stopped before its result.
    pub(crate) async fn gate_member_failed(&self, member: &Task, reason: &str) {
        let Some(link) = member.gate_link.clone() else {
            return;
        };
        let task_id = match &link.owner {
            GateOwner::Task { task_id } => task_id,
            GateOwner::Plan { plan_id } => {
                self.plan_member_done(member, plan_id, &link, Some(reason))
                    .await;
                return;
            }
        };
        let result = GateResult::NoResult {
            reason: format!(
                "The {} (task-{}) gave no result: {reason}",
                role_name(link.role),
                member.number
            ),
        };
        self.record_gate_result(member, task_id, &link, result)
            .await;
    }

    /// What a verifier changed in its checkout: tracked files, a new file git doesn't ignore,
    /// or another commit. `None` when its checkout is still exactly the commit it checked.
    async fn verifier_changes(&self, member: &Task) -> Option<String> {
        let workspace = member.workspace.as_ref()?;
        let worktree = std::path::PathBuf::from(workspace.worktree.clone()?);
        let base = Oid(workspace.base.clone()?);
        let git = self.git.clone();
        blocking(move || {
            let worktree = git.open_worktree(&worktree).map_err(git_error)?;
            if worktree.head().map_err(git_error)? != base {
                return Ok(Some("its checkout is on another commit".to_owned()));
            }
            Ok(checkout_changes(
                &worktree.changes(&base).map_err(git_error)?,
            ))
        })
        .await
        .unwrap_or_else(|err| Some(format!("its checkout could not be read: {err}")))
    }

    /// Records a member's result in its round and, once the round is decided, acts on it.
    async fn record_gate_result(
        &self,
        member: &Task,
        owner: &TaskId,
        link: &GateLink,
        result: GateResult,
    ) {
        let decided = {
            let _held = self.gates.lock().await;
            let Ok(task) = self.task_by_id(&member.conversation_id, owner).await else {
                return;
            };
            let Some(mut gate) = task.gate.clone() else {
                return;
            };
            // A result of an older or closed round, or for a task no longer waiting on it.
            if gate.round != link.round
                || gate.outcome.is_some()
                || task.state != TaskState::Reviewing
            {
                return;
            }
            let Some(slot) = gate
                .members
                .iter_mut()
                .find(|known| known.task_id == member.id)
            else {
                return;
            };
            if slot.result.is_some() {
                return;
            }
            let verdict = match &result {
                GateResult::Passed => Some(ReviewVerdict::Approve),
                GateResult::Failed { .. } => Some(ReviewVerdict::RequestChanges),
                _ => None,
            };
            slot.result = Some(result);
            if gate.members.iter().all(|m| m.result.is_some()) {
                gate.outcome = Some(outcome_of(&gate.members));
            }
            let updated = self
                .update_task(&task.conversation_id, &task.id, |t| {
                    t.gate = Some(gate.clone());
                    if let Some(review) = t.review.as_mut()
                        && review.task_id == member.id
                    {
                        review.verdict = verdict;
                    }
                })
                .await;
            match updated {
                Ok(task) if gate.outcome.is_some() => Some(task),
                _ => None,
            }
        };
        if let Some(task) = decided {
            let manager = self.arc();
            self.spawn(async move { manager.gate_decided(task).await });
        }
    }

    /// Acts on a decided round. Boxed with a named type: acting on a round can stop and
    /// start gate members, whose results come back here.
    fn gate_decided(&self, task: Task) -> brigadier_providers::BoxFuture<'_, ()> {
        Box::pin(self.act_on_gate(task))
    }

    async fn act_on_gate(&self, task: Task) {
        let Some(gate) = task.gate.clone() else {
            return;
        };
        // The task moved on meanwhile (stopped, sent back, a newer round): nothing to do.
        if !self
            .task_by_id(&task.conversation_id, &task.id)
            .await
            .is_ok_and(|now| round_current(&task, &now) && now.gate == task.gate)
        {
            return;
        }
        let members = self.member_tasks(&task, &gate).await;
        match gate.outcome {
            Some(GateOutcome::Passed) => {
                let landed = if gate.relanding {
                    self.land_task(&task).await
                } else {
                    self.approve_and_land(&task).await
                };
                if let Err(err) = landed {
                    self.landing_problem(&task, &err.to_string(), TaskState::Reported)
                        .await;
                }
            }
            Some(GateOutcome::Failed) => {
                let findings = findings_text(&gate, &members);
                self.send_back_or_escalate(&task, &findings, false).await;
            }
            Some(GateOutcome::Unverified) => {
                let reasons = unverified_reasons(&gate);
                // A verifier that gave up gets a second opinion from another model, once.
                let verifier = gate
                    .members
                    .iter()
                    .find(|m| m.role == GateRole::Verify)
                    .and_then(|m| members.iter().find(|t| t.id == m.task_id));
                if !gate.retry
                    && let Some(verifier) = verifier
                {
                    let before = Author {
                        provider: verifier.route.choice.provider,
                        model: verifier.route.choice.model.clone(),
                    };
                    match self
                        .open_gate(
                            &task,
                            Vec::new(),
                            Recheck::Verify,
                            Some((reasons.clone(), before)),
                        )
                        .await
                    {
                        Ok(()) => return,
                        Err(NotOpened::Error(err)) => {
                            self.landing_problem(&task, &err.to_string(), TaskState::Reported)
                                .await;
                            return;
                        }
                        Err(NotOpened::Unchanged) => {}
                    }
                }
                // What only the user can do before the checks can run is listed for them.
                let user_only: Vec<String> = gate
                    .members
                    .iter()
                    .filter(|m| m.role == GateRole::Verify)
                    .filter_map(|m| members.iter().find(|t| t.id == m.task_id))
                    .filter_map(|t| t.report.as_ref())
                    .flat_map(|report| report.needs_user.iter().cloned())
                    .collect();
                let listed = self
                    .sync_waiting(
                        &task,
                        WaitingSource::Landing {
                            task_id: task.id.clone(),
                        },
                        &user_only,
                    )
                    .await;
                let next = if listed > 0 {
                    format!(
                        "Only the user can unblock it; it is listed for them under Waiting on you:\n{}\nYou hear when they mark it done; then call accept_task for task-{} again to verify and land it.",
                        user_only
                            .iter()
                            .map(|line| format!("- {line}"))
                            .collect::<Vec<_>>()
                            .join("\n"),
                        task.number
                    )
                } else {
                    format!(
                        "If only the user can unblock this (a key, a sign-in, a tool to install), ask them. Once it is fixed, call accept_task for task-{} again to verify and land it.",
                        task.number
                    )
                };
                self.decided_for_task(
                    &task,
                    format!(
                        "Held task-{} \u{201c}{}\u{201d}: its change could not be verified",
                        task.number, task.title
                    ),
                    format!("Nothing lands unverified. {}", one_line_findings(&reasons)),
                )
                .await;
                self.landing_problem(
                    &task,
                    &format!(
                        "Its change could not be verified, so nothing landed:\n{reasons}\n{next}"
                    ),
                    TaskState::ReadyToLand,
                )
                .await;
            }
            Some(GateOutcome::NoResult) => {
                let reasons = no_result_reasons(&gate);
                let _ = self
                    .update_task(&task.conversation_id, &task.id, |t| t.landing = None)
                    .await;
                self.decided_for_task(
                    &task,
                    format!(
                        "Did not land task-{}: its checks could not finish",
                        task.number
                    ),
                    one_line_findings(&reasons),
                )
                .await;
                self.landing_problem(
                    &task,
                    &format!(
                        "The checks of its change could not finish; nothing landed.\n{reasons}\nIf that is temporary, call accept_task for task-{} again. If it needs the user (a sign-in, a key), tell them what failed instead of retrying.",
                        task.number
                    ),
                    TaskState::Reported,
                )
                .await;
            }
            Some(GateOutcome::Superseded) | None => {}
        }
    }

    /// The tasks of a round's members.
    async fn member_tasks(&self, task: &Task, gate: &Gate) -> Vec<Task> {
        let mut found = Vec::new();
        for member in &gate.members {
            if let Ok(member) = self
                .task_by_id(&task.conversation_id, &member.task_id)
                .await
            {
                found.push(member);
            }
        }
        found
    }

    /// Sends the worker the gate's findings to fix, or (rounds used up, a fix that changed
    /// nothing, or work the orchestrator took back) hands the decision to the orchestrator.
    pub(crate) async fn send_back_or_escalate(&self, task: &Task, findings: &str, unchanged: bool) {
        if task.landing.is_some() && task.fix_rounds < FIX_ROUNDS && !unchanged {
            let text = format!(
                "Independent checks of your change found problems, so nothing landed. Fix each one in this worktree, verify the fix for real, then call submit_report again with a complete report (all fields, as before).\n{findings}"
            );
            let sent = match self
                .update_task(&task.conversation_id, &task.id, |t| t.fix_rounds += 1)
                .await
            {
                Ok(task) => {
                    self.message_worker(&task.conversation_id, &task, text, "Brigadier")
                        .await
                }
                Err(err) => Err(err),
            };
            match sent {
                Ok(_) => {
                    self.decided_for_task(
                        task,
                        format!(
                            "Sent task-{} back to fix what its checks found (fix {} of {FIX_ROUNDS})",
                            task.number,
                            task.fix_rounds + 1
                        ),
                        one_line_findings(findings),
                    )
                    .await;
                    return;
                }
                Err(err) => {
                    tracing::warn!(task = %task.id, error = %err, "could not send a task back with its findings");
                }
            }
        }
        let task = self
            .update_task(&task.conversation_id, &task.id, |t| {
                t.landing = None;
                t.state = TaskState::Reported;
                t.blocked_reason = None;
            })
            .await
            .unwrap_or_else(|_| task.clone());
        let tried = match (unchanged, task.fix_rounds) {
            (true, _) => "Its change is the same one these findings are about (a fix that changed nothing, or the same change accepted again), so it was not checked again. Decide: send it back with guidance (message_worker), stop it, or ask the user.".to_owned(),
            (false, 0) => format!(
                "Send task-{} back with message_worker to fix this, then accept it again.",
                task.number
            ),
            (false, rounds) => format!(
                "Brigadier sent it back {rounds} time{} with the findings and they are still there. Decide: send it back with guidance (message_worker), stop it, or ask the user.",
                if rounds == 1 { "" } else { "s" }
            ),
        };
        let why = match (unchanged, task.fix_rounds) {
            (true, _) => {
                "Its change is the same one its checks found these problems in.".to_owned()
            }
            (false, 0) => "Its checks found problems.".to_owned(),
            (false, rounds) => format!(
                "The problems were still there after {rounds} fix round{}.",
                if rounds == 1 { "" } else { "s" }
            ),
        };
        self.decided_for_task(
            &task,
            format!(
                "Did not land task-{}: the orchestrator decides what happens next",
                task.number
            ),
            format!("{why} {}", one_line_findings(findings)),
        )
        .await;
        self.announcing(&task).await;
        self.deliver(
            &task.conversation_id,
            Envelope {
                kind: InjectionKind::Report,
                label: format!("checks of task-{}", task.number),
                task_id: Some(task.id.clone()),
                text: format!(
                    "[checks task-{}] Changes needed; nothing landed.\n{findings}\n[/checks] {tried}",
                    task.number
                ),
            },
        )
        .await;
    }

    /// The worker's fix changed nothing: the orchestrator gets the last round's findings.
    pub(crate) async fn escalate_unchanged(&self, task: &Task) {
        let findings = self.gate_findings(task).await;
        self.send_back_or_escalate(task, &findings, true).await;
    }

    /// The findings of the task's last gate round, member by member.
    pub(crate) async fn gate_findings(&self, task: &Task) -> String {
        match &task.gate {
            Some(gate) => {
                let members = self.member_tasks(task, gate).await;
                findings_text(gate, &members)
            }
            None => String::new(),
        }
    }

    /// Stops a task's open gate round (the task was stopped): its members' work is moot.
    pub(crate) async fn close_gate(&self, task: &Task) {
        let open: Vec<TaskId> = {
            let _held = self.gates.lock().await;
            let Some(gate) = task.gate.clone().filter(|gate| gate.outcome.is_none()) else {
                return;
            };
            let _ = self
                .update_task(&task.conversation_id, &task.id, |t| {
                    if let Some(gate) = t.gate.as_mut() {
                        gate.outcome = Some(GateOutcome::Superseded);
                    }
                })
                .await;
            gate.members
                .iter()
                .filter(|m| m.result.is_none())
                .map(|m| m.task_id.clone())
                .collect()
        };
        for member in open {
            // Boxed: stopping a member records its missing result, which reaches this gate.
            let _ = Box::pin(self.stop_task(member)).await;
        }
    }

    /// Who a checking task must not be, for a hand-off to another model. A gate member: the
    /// author of the change, the models of the round's other reviewers, and those it was
    /// told to avoid. A review or verification the orchestrator delegated itself: the author
    /// of its subject.
    pub(crate) async fn gate_avoid(&self, member: &Task) -> (Option<Author>, Vec<Author>) {
        let Some(link) = &member.gate_link else {
            return (self.subject_author(member).await, Vec::new());
        };
        let task_id = match &link.owner {
            GateOwner::Task { task_id } => task_id,
            GateOwner::Plan { plan_id } => {
                return self.plan_gate_avoid(member, plan_id, link.round).await;
            }
        };
        let Ok(board) = self.core.board(&member.conversation_id).await else {
            return (None, Vec::new());
        };
        let Some(owner) = board.tasks.get(task_id) else {
            return (None, Vec::new());
        };
        let others = match owner.gate.as_ref().filter(|g| g.round == link.round) {
            Some(gate) => member_avoids(gate, &member.id, link.role, |id| {
                board.tasks.get(id).map(|t| author_of(&t.route.choice))
            }),
            None => Vec::new(),
        };
        (Some(author_of(&owner.route.choice)), others)
    }

    /// The author of the change a review or verification task checks.
    async fn subject_author(&self, task: &Task) -> Option<Author> {
        if !matches!(task.kind, TaskKind::Review | TaskKind::Verify) {
            return None;
        }
        let subject = self
            .task_by_id(&task.conversation_id, task.subject.as_ref()?)
            .await
            .ok()?;
        Some(author_of(&subject.route.choice))
    }
}

/// The models a gate member must differ from besides the author: a reviewer, the round's
/// other reviewers; any member, the models it was told to avoid when it started.
fn member_avoids(
    gate: &Gate,
    member: &TaskId,
    role: GateRole,
    model_of: impl Fn(&TaskId) -> Option<Author>,
) -> Vec<Author> {
    let mut avoid = Vec::new();
    for other in &gate.members {
        if &other.task_id == member {
            avoid.extend(other.avoid.iter().map(author_of));
        } else if role == GateRole::Review
            && other.role == GateRole::Review
            && let Some(model) = model_of(&other.task_id)
        {
            avoid.push(model);
        }
    }
    avoid
}

fn author_of(choice: &ModelChoice) -> Author {
    Author {
        provider: choice.provider,
        model: choice.model.clone(),
    }
}

/// Whether the round decided on `decided` (the task when its round ended, or when its
/// landing was approved) still speaks for the task as it is `now`: the same round on the same
/// commit, and the task still landing (not stopped, sent back or landed meanwhile).
pub(super) fn round_current(decided: &Task, now: &Task) -> bool {
    let (Some(then), Some(gate)) = (&decided.gate, &now.gate) else {
        return false;
    };
    gate.round == then.round
        && gate.commit == then.commit
        && matches!(
            now.state,
            TaskState::Reviewing | TaskState::AwaitingApproval
        )
}

/// How the task's last checks ended, when they ended without landing (changes needed, or
/// checks that could not finish) and nothing changed since: the worker was not sent back
/// (which voids the candidate), so accepting it again checks the same change.
pub(super) fn checks_stand(task: &Task) -> Option<GateOutcome> {
    let outcome = task.gate.as_ref()?.outcome.clone()?;
    (matches!(outcome, GateOutcome::Failed | GateOutcome::NoResult) && task.candidate.is_some())
        .then_some(outcome)
}

/// Whether the task's candidate, as it is now, passed its gate: only that commit may land.
pub(super) fn candidate_passed(task: &Task) -> bool {
    task.gate.as_ref().is_some_and(|gate| {
        gate.outcome == Some(GateOutcome::Passed)
            && gate.commit.is_some()
            && gate.commit.as_deref() == task.candidate.as_ref().map(|c| c.commit.as_str())
    })
}

/// A change bigger than this (files, or lines added and removed) is planned first: the
/// implement worker writes plan.md before it starts (see `prompts::worker`).
const PLANNED_FILES: usize = 3;
const PLANNED_LINES: u32 = 150;

/// What the gate checks about the worker's plan: the change against plan.md when there is
/// one, and a big change without one.
fn plan_note(task: &Task, wrote_plan: bool) -> Option<String> {
    if wrote_plan {
        return Some("The worker wrote a plan first (plan.md, below): check the change against it. Each planned step should be done, and anything outside the plan needs a reason.".into());
    }
    let stat = &task.candidate.as_ref()?.diff_stat;
    let lines = stat.insertions + stat.deletions;
    (task.kind == TaskKind::Implement && (stat.files.len() > PLANNED_FILES || lines > PLANNED_LINES))
        .then(|| {
            format!(
                "This change is big ({} files, {lines} lines) and the worker wrote no plan.md, which it was asked to do for a change of more than {PLANNED_FILES} files or about {PLANNED_LINES} lines. Name that under risks in your report, and check its scope with extra care: every part must be needed by the task.",
                stat.files.len()
            )
        })
}

/// What a reviewer reads first.
fn review_spec(task: &Task, commit: &str, unreported: &[String], plan: Option<&str>) -> String {
    let mut spec = format!(
        "Review the candidate commit {} of task-{} (\"{}\"). Decide whether it may land: it must do what the task asked, correctly, without slop, stray files or unverified claims.",
        short(commit),
        task.number,
        task.title
    );
    if !unreported.is_empty() {
        spec.push_str(&format!(
            "\nThe worker did not report these tracked changes; check they belong to the task: {}.",
            unreported.join(", ")
        ));
    }
    if let Some(plan) = plan {
        spec.push_str(&format!("\n{plan}"));
    }
    spec.push_str("\nEnd with submit_report and a verdict: approve, or requestChanges with the exact issues in open_questions.");
    spec
}

/// What a verifier reads first.
fn verify_spec(task: &Task, commit: &str, retry: Option<&String>, plan: Option<&str>) -> String {
    let mut spec = format!(
        "Verify the candidate commit {} of task-{} (\"{}\") independently, before it may land. Your checkout is at that commit.
1. Find every \"done when\" criterion: the task's below, those in the orchestrator's later messages to the worker, and each one the worker listed in its report. For each one, produce your own evidence: run the command and quote the decisive line, or read the code and say where. The worker's claims are not evidence.
2. Run the project's checks the way the project runs them (see its README, package scripts, Makefile and CI config): typecheck, lint, build, the existing tests, and a runtime smoke check where the project has one. Install missing dependencies in this checkout first.
3. Check hygiene: files the commit should not hold (logs, scratch notes, debug output, secrets, generated junk), debug code left in, and changes the task didn't ask for.
4. Change no tracked file and add no source file: build output goes only into the project's ignored folders. Brigadier compares your checkout with the commit after your report and discards a verification that changed it.
5. Workers often decide too early that a check can't run. Never do that yourself: before you call a check not run, try it, then try another way (install what is missing, use the project's own scripts, read how CI runs it). Name each command you tried and quote its error.",
        short(commit),
        task.number,
        task.title
    );
    let gave_up: Vec<&String> = task
        .report
        .iter()
        .flat_map(|report| &report.done_when)
        .filter(|line| !matches!(criterion_status(line), Some(Status::Met)))
        .collect();
    if !gave_up.is_empty() {
        spec.push_str("\nThe worker did not show these as met; check each one yourself first:");
        for line in gave_up {
            spec.push_str(&format!("\n- {line}"));
        }
    }
    if let Some(plan) = plan {
        spec.push_str(&format!("\n{plan}"));
    }
    if let Some(why) = retry {
        spec.push_str(&format!(
            "\nAn earlier verifier could not check this change:\n{why}\nFind a way to run what it couldn't."
        ));
    }
    spec.push_str(
        "\nEnd with submit_report. done_when: one line per criterion, for every criterion (the task's and the worker's, never fewer lines than the worker listed): \"[met] criterion: your evidence\", \"[not met] criterion: what fails\", or \"[not checked] criterion: the command you tried and its error\"; a check you did not run yourself is never [met]. checks: passed (every check you ran passed), failed (a check ran and failed), notRun (the project has checks but they could not run, after you tried; a check stopped by a missing key, sign-in or service is notRun, not failed), or noChecks (the project has no checks you could run). Put each problem the worker must fix in open_questions, and nothing else: any line there sends the change back to the worker. If a check can't run until the user does something only they can (a key, a sign-in, a paid account), say exactly what under needs_user.",
    );
    spec
}

/// A "done when" line's status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Met,
    NotMet,
    NotChecked,
}

/// A line without its list marker: "- ", "* ", "• ", "2. " or "2) ".
fn without_marker(line: &str) -> &str {
    let line = line.trim_start_matches(['-', '*', '•', ' ', '\t']);
    let number = line.trim_start_matches(|c: char| c.is_ascii_digit());
    match number.strip_prefix(['.', ')']) {
        Some(rest) if number.len() < line.len() => rest.trim_start(),
        _ => line,
    }
}

/// The status a "done when" line starts with ("[met] …"), and whether evidence follows.
fn criterion_status(line: &str) -> Option<Status> {
    let line = without_marker(line).to_lowercase();
    if line.starts_with("[met]") {
        Some(Status::Met)
    } else if line.starts_with("[not met]") {
        Some(Status::NotMet)
    } else if line.starts_with("[not checked]") {
        Some(Status::NotChecked)
    } else {
        None
    }
}

/// The text after a "done when" line's status.
fn criterion_text(line: &str) -> &str {
    let line = without_marker(line);
    line.find(']').map_or(line, |end| line[end + 1..].trim())
}

/// The evidence a "done when" line gives after its criterion ("[met] criterion: evidence",
/// or a dash instead of the colon), if any.
fn criterion_evidence(line: &str) -> Option<&str> {
    let text = criterion_text(line);
    let at = [": ", " — ", " – ", " - ", " -> ", " => "]
        .iter()
        .filter_map(|separator| text.find(separator).map(|at| at + separator.len()))
        .min()?;
    Some(text[at..].trim()).filter(|evidence| evidence.chars().any(char::is_alphanumeric))
}

/// A reviewer's result.
pub(super) fn review_result(report: &Report) -> GateResult {
    match report.verdict {
        Some(ReviewVerdict::Approve) => GateResult::Passed,
        Some(ReviewVerdict::RequestChanges) => GateResult::Failed {
            findings: if report.open_questions.is_empty() {
                vec![report.summary.clone()]
            } else {
                report.open_questions.clone()
            },
        },
        None => GateResult::NoResult {
            reason: "The reviewer gave no verdict.".into(),
        },
    }
}

/// A verifier's result. It passed only when every "done when" criterion is shown met with
/// evidence (at least as many as the worker listed, `listed`), the project's checks passed
/// (or it has none), and it found nothing for the worker to fix.
fn verify_result(report: &Report, listed: usize) -> GateResult {
    use crate::work::ChecksResult;
    let mut unmet = Vec::new();
    let mut unchecked = Vec::new();
    let mut met = 0;
    for line in &report.done_when {
        match criterion_status(line) {
            Some(Status::Met) if criterion_evidence(line).is_some() => met += 1,
            Some(Status::Met) => unchecked.push(format!("{line} (no evidence given)")),
            Some(Status::NotMet) => unmet.push(line.clone()),
            Some(Status::NotChecked) | None => unchecked.push(line.clone()),
        }
    }
    // Every criterion shown met, at least as many as the worker listed.
    let all_met = met > 0 && unchecked.is_empty() && report.done_when.len() >= listed;
    let checks_failed = report.checks == Some(ChecksResult::Failed);
    // It was told to put each problem the worker must fix in open_questions.
    if !unmet.is_empty() || !report.open_questions.is_empty() || (checks_failed && !all_met) {
        let mut findings = unmet;
        findings.extend(report.open_questions.iter().cloned());
        if findings.is_empty() {
            findings.push(format!("The checks failed: {}", report.summary));
        }
        return GateResult::Failed { findings };
    }
    let reason = if checks_failed {
        // A failing check tied to no criterion and nothing named to fix (an optional check
        // that needs a key nobody set): nothing for the worker to fix, and not proof either.
        Some(format!(
            "A check failed, though every \"done when\" criterion is met and it named nothing to fix: {}",
            report.summary
        ))
    } else if met == 0 {
        Some("It showed no \"done when\" criterion met with evidence.".to_owned())
    } else if !unchecked.is_empty() {
        Some(format!("Left unchecked: {}", unchecked.join("; ")))
    } else if report.done_when.len() < listed {
        Some(format!(
            "It covered {} \"done when\" criteria; the worker listed {listed}, so some were not checked.",
            report.done_when.len()
        ))
    } else {
        match report.checks {
            Some(ChecksResult::Passed | ChecksResult::NoChecks) => None,
            Some(ChecksResult::NotRun) => Some(format!(
                "The project's checks could not run: {}",
                report.summary
            )),
            None => Some("It did not say whether the project's checks ran.".to_owned()),
            Some(ChecksResult::Failed) => unreachable!("handled above"),
        }
    };
    match reason {
        None => GateResult::Passed,
        Some(reason) => GateResult::Unverified { reason },
    }
}

/// How a round with every result in ended.
pub(super) fn outcome_of(members: &[GateMember]) -> GateOutcome {
    let results = || members.iter().filter_map(|m| m.result.as_ref());
    if results().any(|r| matches!(r, GateResult::NoResult { .. })) {
        GateOutcome::NoResult
    } else if results().any(|r| matches!(r, GateResult::Failed { .. })) {
        GateOutcome::Failed
    } else if results().any(|r| matches!(r, GateResult::Unverified { .. })) {
        GateOutcome::Unverified
    } else {
        GateOutcome::Passed
    }
}

/// A round's findings, member by member, for the worker or the orchestrator.
fn findings_text(gate: &Gate, members: &[Task]) -> String {
    let mut text = String::new();
    for member in &gate.members {
        let who = members.iter().find(|t| t.id == member.task_id).map_or_else(
            || role_name(member.role).to_owned(),
            |t| {
                format!(
                    "{} (task-{}, {})",
                    role_name(member.role),
                    t.number,
                    super::workers::route_label(t)
                )
            },
        );
        match &member.result {
            Some(GateResult::Failed { findings }) => {
                text.push_str(&format!("\nFrom the {who}:"));
                for finding in findings {
                    text.push_str(&format!("\n- {finding}"));
                }
            }
            Some(GateResult::Unverified { reason }) => {
                text.push_str(&format!("\nThe {who} could not check everything: {reason}"));
            }
            _ => {}
        }
    }
    text.trim_start().to_owned()
}

/// A round's findings on one line, for "Decided for you".
fn one_line_findings(findings: &str) -> String {
    findings
        .lines()
        .map(|line| line.trim().trim_start_matches("- "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn unverified_reasons(gate: &Gate) -> String {
    gate.members
        .iter()
        .filter_map(|m| match &m.result {
            Some(GateResult::Unverified { reason }) => Some(format!("- {reason}")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn no_result_reasons(gate: &Gate) -> String {
    gate.members
        .iter()
        .filter_map(|m| match &m.result {
            Some(GateResult::NoResult { reason }) => Some(format!("- {reason}")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn role_name(role: GateRole) -> &'static str {
    match role {
        GateRole::Review => "review",
        GateRole::Verify => "verification",
    }
}

/// What a verifier's checkout holds that its commit doesn't: any changed tracked file and
/// any new file git doesn't ignore, whatever its kind (a check may have used it). Build
/// output goes into ignored folders, which don't count.
fn checkout_changes(changes: &[brigadier_git::Change]) -> Option<String> {
    let paths: Vec<&str> = changes.iter().map(|change| change.path.as_str()).collect();
    (!paths.is_empty()).then(|| format!("it changed {}", paths.join(", ")))
}

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(10)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::work::ChecksResult;

    fn report(done_when: &[&str], checks: Option<ChecksResult>) -> Report {
        Report {
            summary: "Checked.".into(),
            changes: Vec::new(),
            decisions: Vec::new(),
            verification: Vec::new(),
            done_when: done_when.iter().map(|line| (*line).to_owned()).collect(),
            open_questions: Vec::new(),
            risks: Vec::new(),
            needs_user: Vec::new(),
            verdict: None,
            checks,
            artifacts: Vec::new(),
            submitted_at_ms: 0,
        }
    }

    #[test]
    fn every_criterion_met_with_evidence_and_passing_checks_passes() {
        let report = report(
            &[
                "[met] `pnpm test` passes: 41 passed, 0 failed",
                "- [Met] the flag is documented: README.md line 40",
            ],
            Some(ChecksResult::Passed),
        );
        assert_eq!(verify_result(&report, 0), GateResult::Passed);
    }

    #[test]
    fn a_project_without_checks_passes_on_evidence_alone() {
        let report = report(
            &["[met] the page title reads Home: src/app.tsx:12"],
            Some(ChecksResult::NoChecks),
        );
        assert_eq!(verify_result(&report, 0), GateResult::Passed);
    }

    #[test]
    fn checks_that_could_not_run_never_pass() {
        let report = report(
            &["[met] the endpoint returns 200: curl showed 200 OK"],
            Some(ChecksResult::NotRun),
        );
        assert!(matches!(
            verify_result(&report, 0),
            GateResult::Unverified { .. }
        ));
    }

    #[test]
    fn criteria_reported_all_not_run_are_unverified() {
        let report = report(
            &[
                "[not checked] tests pass: could not run pnpm",
                "[not checked] the build works: no time",
            ],
            Some(ChecksResult::NotRun),
        );
        let GateResult::Unverified { reason } = verify_result(&report, 0) else {
            panic!("not unverified");
        };
        assert!(
            reason.contains("no \"done when\" criterion met"),
            "{reason}"
        );
    }

    #[test]
    fn a_met_line_without_evidence_or_status_is_unchecked() {
        let report = report(
            &[
                "[met] tests pass: ok passing",
                "[met] ok",
                "the build works",
            ],
            Some(ChecksResult::Passed),
        );
        let GateResult::Unverified { reason } = verify_result(&report, 0) else {
            panic!("not unverified");
        };
        assert!(reason.contains("[met] ok (no evidence given)"), "{reason}");
        assert!(reason.contains("the build works"), "{reason}");
    }

    #[test]
    fn no_criteria_at_all_is_unverified() {
        assert!(matches!(
            verify_result(&report(&[], Some(ChecksResult::Passed)), 0),
            GateResult::Unverified { .. }
        ));
    }

    #[test]
    fn an_unmet_criterion_or_failed_check_fails_with_findings() {
        let mut failed = report(
            &[
                "[met] lint passes: oxlint 0 warnings",
                "[not met] tests pass: 2 failed in api.test.ts",
            ],
            Some(ChecksResult::Failed),
        );
        failed.open_questions = vec!["Fix the null check in api.ts".into()];
        assert_eq!(
            verify_result(&failed, 0),
            GateResult::Failed {
                findings: vec![
                    "[not met] tests pass: 2 failed in api.test.ts".into(),
                    "Fix the null check in api.ts".into()
                ]
            }
        );
    }

    #[test]
    fn numbered_and_bulleted_criteria_are_read() {
        for line in [
            "2. [met] tests pass: 41 passed",
            "2) [met] tests pass: 41 passed",
            "- [met] tests pass: 41 passed",
            "* [met] tests pass: 41 passed",
            "• [met] tests pass: 41 passed",
            "  10. [Met] tests pass: 41 passed",
        ] {
            assert_eq!(criterion_status(line), Some(Status::Met), "{line}");
            assert_eq!(criterion_evidence(line), Some("41 passed"), "{line}");
        }
        assert_eq!(
            criterion_status("1. [not met] lint passes: 2 errors"),
            Some(Status::NotMet)
        );
        // A number that is not a list marker is not taken for one.
        assert_eq!(criterion_status("2 [met] tests pass: ok"), None);
        let numbered = report(
            &[
                "1. [met] lerp works: test/math.test.js:14",
                "2. [not met] npm test passes: the exports test fails",
            ],
            Some(ChecksResult::Failed),
        );
        assert_eq!(
            verify_result(&numbered, 0),
            GateResult::Failed {
                findings: vec!["2. [not met] npm test passes: the exports test fails".into()]
            }
        );
    }

    #[test]
    fn a_failed_check_with_every_criterion_met_is_unverified_not_failed() {
        let mut optional = report(
            &[
                "[met] isPrime(1) is true: test/primes.test.js:4 passes",
                "[met] npm test passes: 12 passed, 0 failed",
            ],
            Some(ChecksResult::Failed),
        );
        optional.summary = "Integration could not start: CALC_API_TOKEN is missing.".into();
        let GateResult::Unverified { reason } = verify_result(&optional, 2) else {
            panic!("not unverified");
        };
        assert!(reason.contains("CALC_API_TOKEN"), "{reason}");
        // Anything named to fix still fails it.
        optional.open_questions = vec!["Remove debug.log".into()];
        assert!(matches!(
            verify_result(&optional, 2),
            GateResult::Failed { .. }
        ));
        // So does a failed check while a criterion is left unchecked.
        let unchecked = report(
            &[
                "[met] lint passes: 0 warnings",
                "[not checked] tests pass: could not start",
            ],
            Some(ChecksResult::Failed),
        );
        assert!(matches!(
            verify_result(&unchecked, 0),
            GateResult::Failed { .. }
        ));
    }

    #[test]
    fn a_review_without_a_verdict_gives_no_result() {
        let mut review = report(&[], None);
        assert!(matches!(
            review_result(&review),
            GateResult::NoResult { .. }
        ));
        review.verdict = Some(ReviewVerdict::RequestChanges);
        assert_eq!(
            review_result(&review),
            GateResult::Failed {
                findings: vec!["Checked.".into()]
            }
        );
    }

    #[test]
    fn a_round_is_as_good_as_its_worst_member() {
        let member = |result| GateMember {
            task_id: TaskId("t".into()),
            role: GateRole::Review,
            result: Some(result),
            avoid: Vec::new(),
        };
        let unverified = GateResult::Unverified { reason: "x".into() };
        let failed = GateResult::Failed {
            findings: Vec::new(),
        };
        assert_eq!(
            outcome_of(&[member(GateResult::Passed), member(unverified.clone())]),
            GateOutcome::Unverified
        );
        assert_eq!(
            outcome_of(&[member(unverified), member(failed.clone())]),
            GateOutcome::Failed
        );
        assert_eq!(
            outcome_of(&[
                member(failed),
                member(GateResult::NoResult { reason: "x".into() })
            ]),
            GateOutcome::NoResult
        );
    }

    #[test]
    fn any_new_file_counts_as_a_verifier_change() {
        let change = |path: &str, untracked| brigadier_git::Change {
            path: path.into(),
            kind: brigadier_git::ChangeKind::Added,
            untracked,
        };
        assert_eq!(checkout_changes(&[]), None);
        // Not only source: a migration, a script or a page a check could have used.
        assert_eq!(
            checkout_changes(&[change("db/001.sql", true), change("run.sh", true)]),
            Some("it changed db/001.sql, run.sh".into())
        );
        assert_eq!(
            checkout_changes(&[change("src/app.ts", false)]),
            Some("it changed src/app.ts".into())
        );
    }

    #[test]
    fn a_verifier_finding_in_open_questions_fails_an_otherwise_passing_report() {
        let mut found = report(
            &["[met] tests pass: 41 passed, 0 failed"],
            Some(ChecksResult::Passed),
        );
        found.open_questions = vec!["debug.log is committed; remove it".into()];
        assert_eq!(
            verify_result(&found, 1),
            GateResult::Failed {
                findings: vec!["debug.log is committed; remove it".into()]
            }
        );
    }

    #[test]
    fn fewer_criteria_than_the_worker_listed_is_unverified() {
        let short = report(
            &["[met] tests pass: 41 passed, 0 failed"],
            Some(ChecksResult::Passed),
        );
        let GateResult::Unverified { reason } = verify_result(&short, 2) else {
            panic!("not unverified");
        };
        assert!(reason.contains("covered 1"), "{reason}");
        assert!(reason.contains("listed 2"), "{reason}");
        // As many as the worker listed, or more (the task's own), passes.
        assert_eq!(verify_result(&short, 1), GateResult::Passed);
    }

    #[test]
    fn a_met_line_needs_evidence_after_its_criterion_not_just_length() {
        let long = report(
            &[
                "[met] tests pass: 41 passed",
                "[met] the settings page shows the new toggle for dark mode",
            ],
            Some(ChecksResult::Passed),
        );
        let GateResult::Unverified { reason } = verify_result(&long, 0) else {
            panic!("not unverified");
        };
        assert!(reason.contains("(no evidence given)"), "{reason}");
        assert_eq!(
            criterion_evidence("[met] the build works — cargo build finished in 12s"),
            Some("cargo build finished in 12s")
        );
        assert_eq!(
            criterion_evidence("- [met] tests pass - 41 passed"),
            Some("41 passed")
        );
        assert_eq!(criterion_evidence("[met] tests pass:"), None);
        assert_eq!(criterion_evidence("[met] tests pass: -"), None);
        // A colon inside a path is not a separator.
        assert_eq!(criterion_evidence("[met] see src/app.ts:12"), None);
    }

    fn author(model: &str) -> Author {
        Author {
            provider: brigadier_providers::ProviderKind::Codex,
            model: Some(model.into()),
        }
    }

    #[test]
    fn a_gate_member_keeps_avoiding_what_it_started_avoiding() {
        let member = |id: &str, role, avoid: &[&str]| GateMember {
            task_id: TaskId(id.into()),
            role,
            result: None,
            avoid: avoid
                .iter()
                .map(|model| ModelChoice {
                    provider: brigadier_providers::ProviderKind::Codex,
                    model: Some((*model).into()),
                    effort: None,
                    fast: None,
                })
                .collect(),
        };
        let gate = Gate {
            round: 2,
            commit: Some("c2".into()),
            members: vec![
                member("r1", GateRole::Review, &[]),
                member("r2", GateRole::Review, &[]),
                member("v", GateRole::Verify, &["first-verifier"]),
            ],
            outcome: None,
            relanding: false,
            retry: true,
            findings: Vec::new(),
        };
        let model_of = |id: &TaskId| Some(author(&format!("model-of-{}", id.0)));
        // The second verifier: the one that could not check, not the reviewers.
        assert_eq!(
            member_avoids(&gate, &TaskId("v".into()), GateRole::Verify, model_of),
            vec![author("first-verifier")]
        );
        // A reviewer: the other reviewer.
        assert_eq!(
            member_avoids(&gate, &TaskId("r1".into()), GateRole::Review, model_of),
            vec![author("model-of-r2")]
        );
    }

    /// A write task whose round `round` on `commit` ended with `outcome`, now at `state`
    /// with candidate `candidate`.
    fn gated(
        state: TaskState,
        round: u32,
        commit: &str,
        outcome: Option<GateOutcome>,
        candidate: &str,
    ) -> Task {
        let mut task: Task = serde_json::from_value(serde_json::json!({
            "id": "t1",
            "conversationId": "c1",
            "number": 1,
            "position": 0,
            "title": "Add the flag",
            "kind": "implement",
            "spec": "Add the flag.",
            "access": { "repo": "write", "network": false, "unsandboxed": false },
            "route": { "choice": { "provider": "claude", "model": null, "effort": null }, "reason": "" },
            "state": "reviewing",
            "attachments": [],
            "createdAtMs": 0,
            "updatedAtMs": 0
        }))
        .expect("a task");
        task.state = state;
        task.gate = Some(Gate {
            round,
            commit: Some(commit.into()),
            members: Vec::new(),
            outcome,
            relanding: false,
            retry: false,
            findings: Vec::new(),
        });
        task.candidate = Some(crate::work::Candidate {
            commit: candidate.into(),
            onto: "base".into(),
            message: "Add the flag".into(),
            diff_stat: crate::work::DiffStat {
                files: Vec::new(),
                insertions: 1,
                deletions: 0,
            },
            excluded: Vec::new(),
            diff: None,
        });
        task
    }

    #[test]
    fn an_old_approval_never_lands_a_newer_candidate() {
        let passed = Some(GateOutcome::Passed);
        let approved = gated(TaskState::AwaitingApproval, 1, "c1", passed.clone(), "c1");
        assert!(round_current(&approved, &approved));
        assert!(candidate_passed(&approved));
        // Sent back and accepted again: round 2 checks c2 while round 1's card is open.
        let newer = gated(TaskState::Reviewing, 2, "c2", None, "c2");
        assert!(!round_current(&approved, &newer));
        assert!(!candidate_passed(&newer));
        // Sent back, still working: nothing lands.
        let working = gated(TaskState::Running, 1, "c1", passed.clone(), "c1");
        assert!(!round_current(&approved, &working));
        // Stopped meanwhile.
        let stopped = gated(TaskState::Stopped, 1, "c1", passed.clone(), "c1");
        assert!(!round_current(&approved, &stopped));
        // A candidate that is not the commit the round passed.
        let moved = gated(TaskState::Reviewing, 1, "c1", passed, "c3");
        assert!(!candidate_passed(&moved));
    }

    #[test]
    fn checks_that_ended_on_an_unchanged_change_are_not_an_invitation_to_accept_it_again() {
        let failed = gated(
            TaskState::Reported,
            3,
            "c1",
            Some(GateOutcome::Failed),
            "c1",
        );
        assert_eq!(checks_stand(&failed), Some(GateOutcome::Failed));
        let note = super::super::prompts::undecided_note(std::slice::from_ref(&failed));
        assert!(note.contains("will not land it"), "{note}");
        let unfinished = gated(
            TaskState::Reported,
            1,
            "c1",
            Some(GateOutcome::NoResult),
            "c1",
        );
        assert_eq!(checks_stand(&unfinished), Some(GateOutcome::NoResult));
        // Sent back since (its candidate is void), then reported again: a new decision.
        let mut fixed = failed.clone();
        fixed.candidate = None;
        assert_eq!(checks_stand(&fixed), None);
        let note = super::super::prompts::undecided_note(&[fixed]);
        assert!(!note.contains("will not land"), "{note}");
        let passed = gated(
            TaskState::Reported,
            1,
            "c1",
            Some(GateOutcome::Passed),
            "c1",
        );
        assert_eq!(checks_stand(&passed), None);
    }
}
