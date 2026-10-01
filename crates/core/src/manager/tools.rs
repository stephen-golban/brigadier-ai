//! The Brigadier MCP tools, answered. Orchestrator tools return at once; their outcomes
//! arrive later as envelopes. Every reply the orchestrator reads is logged as a context
//! injection.

use brigadier_providers::ProviderKind;

use super::SessionManager;
use super::prompts;
use super::workers::route_label;
use crate::model::{ConversationId, DomainEvent, PermissionLevel, Setup};
use crate::tools::{OrchestratorCall, ToolReply, WorkerCall};
use crate::work::{
    ApprovalSubject, AttachmentRef, CardId, InjectionKind, OrchestratorStep, OrchestratorStepKind,
    Plan, PlanApprover, PlanState, PlanStep, QuestionKind, Task, TaskId, TaskKind,
};
use crate::{Error, Result, now_ms};

/// Largest slice `read_artifact` returns.
const ARTIFACT_PAGE_MAX: u32 = 16_000;

impl SessionManager {
    pub(crate) async fn orchestrator_call(
        &self,
        conversation_id: ConversationId,
        call: OrchestratorCall,
    ) -> ToolReply {
        let name = call.name();
        let is_artifact = matches!(call, OrchestratorCall::ReadArtifact(_));
        let reply = match self.run_orchestrator_call(&conversation_id, call).await {
            Ok(text) => ToolReply::ok(text),
            Err(err) => ToolReply::error(err.to_string()),
        };
        self.log_injection(
            &conversation_id,
            if is_artifact {
                InjectionKind::Artifact
            } else {
                InjectionKind::ToolResult
            },
            name.into(),
            None,
            reply.text.len(),
        )
        .await;
        reply
    }

    async fn run_orchestrator_call(
        &self,
        id: &ConversationId,
        call: OrchestratorCall,
    ) -> Result<String> {
        match call {
            OrchestratorCall::DelegateTask(args) => {
                if args.kind.writes() {
                    self.check_plan_gate(id).await?;
                }
                let subject = match (&args.subject, args.kind) {
                    (Some(reference), _) => Some(self.find_task(id, reference).await?),
                    (None, TaskKind::Review) => {
                        return Err(Error::Invalid(
                            "a review task needs `subject`: the task whose change it reviews"
                                .into(),
                        ));
                    }
                    // Brigadier prepares a merge from the conflicting task's work; with no
                    // task there is nothing to prepare, and the worker can't merge by itself.
                    (None, TaskKind::Merge) => {
                        return Err(Error::Invalid(
                            "a merge task needs `subject`: the task whose work conflicts with \
                             the session's branch"
                                .into(),
                        ));
                    }
                    (None, _) => None,
                };
                if args.kind == TaskKind::Review
                    && subject
                        .as_ref()
                        .is_some_and(|s| s.candidate.is_none() && s.report.is_none())
                {
                    return Err(Error::Invalid(
                        "the subject task has nothing to review yet".into(),
                    ));
                }
                if let Some(step) = args.step {
                    self.plan_step(id, step).await?;
                }
                let pin = pin(args.provider.as_deref(), args.model, args.effort)?;
                let areas = task_areas(&args.areas)?;
                let floor = match args.quality.as_deref().map(str::trim) {
                    None | Some("" | "normal") => None,
                    Some("high") => Some(brigadier_router::QualityTier::Frontier),
                    Some(other) => {
                        return Err(Error::Invalid(format!(
                            "unknown quality \"{other}\": use \"high\" or leave it out"
                        )));
                    }
                };
                let needs = if args.image_generation {
                    vec![brigadier_router::Capability::ImageGeneration]
                } else {
                    Vec::new()
                };
                let attachments = self.find_attachments(id, &args.attachments).await?;
                let avoid = subject
                    .as_ref()
                    .filter(|_| args.kind == TaskKind::Review)
                    .map(|s| brigadier_router::Author {
                        provider: s.route.choice.provider,
                        model: s.route.choice.model.clone(),
                    });
                let task = self
                    .create_task(
                        id,
                        args.title,
                        args.kind,
                        args.spec,
                        pin,
                        avoid,
                        Vec::new(),
                        None,
                        subject,
                        attachments,
                        areas,
                        floor,
                        needs,
                    )
                    .await?;
                if let Some(step) = args.step {
                    // A task that redoes a step takes it over.
                    let (mut plan, index) = self.plan_step(id, step).await?;
                    plan.steps[index].task_id = Some(task.id.clone());
                    self.store_plan(&plan).await?;
                }
                if let Some(wait) = &task.quota_wait {
                    return Ok(format!(
                        "Created task-{} ({:?}), but no model it may use can take it now: {}. It \
                         starts on its own when one can (after a reset, or when the user changes \
                         their routing); its report arrives later as a message. The user sees \
                         it waiting, so don't announce it: if nothing else is needed now, reply \
                         with exactly {} and nothing else.",
                        task.number,
                        task.kind,
                        wait.reason,
                        prompts::QUIET
                    ));
                }
                Ok(format!(
                    "Started task-{} ({:?}) on {}: {}. Its report arrives later as a message; don't wait for it. \
                     The user sees the worker live, so don't announce it: if nothing else is \
                     needed now, reply with exactly {} and nothing else.",
                    task.number,
                    task.kind,
                    route_label(&task),
                    task.route.reason,
                    prompts::QUIET
                ))
            }
            OrchestratorCall::MessageWorker(args) => {
                let mut task = self.find_task(id, &args.task).await?;
                // A later request's turn hands the worker its question: the report that
                // answers it, and the reply after it, belong to the request that asked.
                if !task.state.is_final()
                    && let Some(later) = self.later_request_for(id, &task).await
                {
                    task = self
                        .update_task(id, &task.id, |task| task.request_id = Some(later))
                        .await?;
                    self.settle_requests(id).await;
                }
                let reply = self.message_worker(id, &task, args.text.clone()).await?;
                // The orchestrator steers it now: Brigadier no longer lands it on its own.
                self.update_task(id, &task.id, |task| {
                    task.messages.push(args.text);
                    task.landing = None;
                })
                .await?;
                self.orchestrator_step(id, OrchestratorStepKind::Messaged { task_id: task.id })
                    .await;
                Ok(reply)
            }
            OrchestratorCall::RouteFollowUp(args) => {
                self.route_follow_up(id, &args.follow_up, args.joins).await
            }
            OrchestratorCall::StopWorker(args) => {
                let task = self.find_task(id, &args.task).await?;
                self.stop_task(task.id.clone()).await?;
                Ok(format!("Stopped task-{}.", task.number))
            }
            OrchestratorCall::AskUser(args) => {
                let task_id = match &args.task {
                    Some(reference) => Some(self.find_task(id, reference).await?.id),
                    None => None,
                };
                self.open_question(
                    id,
                    task_id,
                    QuestionKind::Orchestrator,
                    args.question,
                    args.options,
                    args.recommended,
                )
                .await?;
                Ok("Asked the user. The answer arrives later as a message; carry on with anything that doesn't depend on it.".into())
            }
            OrchestratorCall::ReadReport(args) => {
                let (task, here) = self.find_report(id, &args.task).await?;
                let report = task.report.as_ref().ok_or_else(|| {
                    Error::Invalid(format!("task-{} has not reported yet", task.number))
                })?;
                let mut text = prompts::report_envelope(&task, report, &route_label(&task));
                let step = if here {
                    OrchestratorStepKind::ReadReport { task_id: task.id }
                } else {
                    text = format!("[from another session of this project]\n{text}");
                    OrchestratorStepKind::ReadArtifact {
                        name: format!(
                            "the report \u{201c}{}\u{201d} from another session",
                            task.title
                        ),
                    }
                };
                self.orchestrator_step(id, step).await;
                Ok(text)
            }
            OrchestratorCall::ReadArtifact(args) => {
                self.check_artifact(id, &args.id).await?;
                let limit = args
                    .limit
                    .unwrap_or(ARTIFACT_PAGE_MAX)
                    .min(ARTIFACT_PAGE_MAX);
                let offset = args.offset.unwrap_or(0);
                let (bytes, total) = self
                    .core
                    .read_blob_range(args.id.clone(), offset, limit)
                    .await?;
                let text = match std::str::from_utf8(&bytes) {
                    Ok(text) => text.to_owned(),
                    // A page may end inside a character.
                    Err(err) if err.error_len().is_none() => {
                        String::from_utf8_lossy(&bytes[..err.valid_up_to()]).into_owned()
                    }
                    Err(_) => return Ok(format!("{} is not text ({total} bytes).", args.id)),
                };
                let end = offset + text.len() as u64;
                // Paging on through the same artifact is one read.
                if offset == 0 {
                    let name = self.artifact_name(id, &args.id).await;
                    self.orchestrator_step(id, OrchestratorStepKind::ReadArtifact { name })
                        .await;
                }
                Ok(format!(
                    "[artifact {} bytes {offset}–{end} of {total}]\n{text}{}",
                    args.id,
                    if end < total {
                        format!("\n[more: read_artifact with offset {end}]")
                    } else {
                        String::new()
                    }
                ))
            }
            OrchestratorCall::QueryBrain(args) => {
                self.query_brain_tool(id, args.query, args.history.unwrap_or(false), args.page)
                    .await
            }
            OrchestratorCall::Remember(args) => self.remember_tool(id, args).await,
            OrchestratorCall::SearchTranscript(args) => self.search_transcript_tool(id, args).await,
            OrchestratorCall::ProposePlan(args) => self.propose_plan(id, args).await,
            OrchestratorCall::RequestApproval(args) => {
                self.open_approval(
                    id,
                    None,
                    ApprovalSubject::Action {
                        action: args.action,
                        details: args.details,
                    },
                )
                .await?;
                Ok("Asked the user. The decision arrives later as a message.".into())
            }
            OrchestratorCall::AcceptTask(args) => {
                self.check_plan_mode(id)?;
                let task = self.find_task(id, &args.task).await?;
                let task_id = task.id.clone();
                let reply = self.accept_task(id, task, args.commit_message).await?;
                self.orchestrator_step(id, OrchestratorStepKind::Accepted { task_id })
                    .await;
                Ok(reply)
            }
            OrchestratorCall::FinishSession(args) => {
                self.check_plan_mode(id)?;
                self.finish_session(id, args.message).await
            }
            OrchestratorCall::ListTasks => {
                let tasks = self.core.tasks(id).await?;
                if tasks.is_empty() {
                    return Ok("No tasks yet.".into());
                }
                Ok(tasks
                    .iter()
                    .map(|task| {
                        format!(
                            "task-{} {:?} {:?} on {}: {}{}",
                            task.number,
                            task.kind,
                            task.state,
                            route_label(task),
                            task.title,
                            task.blocked_reason
                                .as_ref()
                                .map(|r| format!(" ({r})"))
                                .unwrap_or_default()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
        }
    }

    /// Files a row for the thread under the request the orchestrator serves.
    pub(crate) async fn orchestrator_step(&self, id: &ConversationId, kind: OrchestratorStepKind) {
        let step = OrchestratorStep {
            request_id: self.request_for(id, None).await,
            kind,
            at_ms: now_ms(),
            position: 0,
        };
        if let Err(err) = self
            .core
            .record_conversation(id, vec![DomainEvent::OrchestratorStepped { step }])
            .await
        {
            tracing::warn!(conversation = %id, error = %err, "could not store an orchestrator step");
        }
    }

    /// The task `reference` names for `read_report`: one of this session's (by number or id),
    /// else, by its id, one of another session of the same project (as a Brain answer names
    /// it). Whether it is this session's comes with it.
    async fn find_report(&self, id: &ConversationId, reference: &str) -> Result<(Task, bool)> {
        match self.find_task(id, reference).await {
            Ok(task) => return Ok((task, true)),
            Err(Error::NotFound(_)) => {}
            Err(err) => return Err(err),
        }
        let wanted = TaskId(reference.trim().to_owned());
        for other in self.project_conversations(id) {
            if let Ok(board) = self.core.board(&other).await
                && let Some(task) = board.tasks.get(&wanted)
            {
                return Ok((task.clone(), false));
            }
        }
        Err(Error::Invalid(format!(
            "{reference} is not a task of this session or of another session of this project. Task numbers (task-3) are this session's; a report from another session is read by the task id its Brain answer names (\"from report <id>\")."
        )))
    }

    /// `read_artifact` reads what a report of this project stored (its artifacts and
    /// outputs, a kept patch), from this session or another of the project; nothing else in
    /// the store.
    async fn check_artifact(&self, id: &ConversationId, artifact: &str) -> Result<()> {
        let names = |task: &Task| {
            task.report
                .iter()
                .flat_map(|report| &report.artifacts)
                .chain(&task.outputs)
                .chain(task.kept.iter().filter_map(|kept| match kept {
                    crate::work::KeptWork::Diff { artifact, .. } => Some(artifact),
                    _ => None,
                }))
                .any(|known| known.id == artifact)
        };
        for conversation in std::iter::once(id.clone()).chain(self.project_conversations(id)) {
            if let Ok(board) = self.core.board(&conversation).await
                && board.tasks.values().any(names)
            {
                return Ok(());
            }
        }
        Err(Error::Invalid(format!(
            "{artifact} is not an artifact of a report in this project. Use an id a report, read_report or query_brain gave you."
        )))
    }

    /// The project's other conversations (sessions of the same project), newest first.
    fn project_conversations(&self, id: &ConversationId) -> Vec<ConversationId> {
        let Some(project) = self.core.conversation(id).ok().and_then(|c| c.project_id) else {
            return Vec::new();
        };
        let mut others: Vec<_> = self
            .core
            .catalog()
            .conversations
            .into_iter()
            .filter(|c| c.id != *id && c.project_id.as_ref() == Some(&project))
            .collect();
        others.sort_by_key(|c| std::cmp::Reverse(c.updated_at_ms));
        others.into_iter().map(|c| c.id).collect()
    }

    /// An artifact's title from the report that lists it, else "an artifact".
    async fn artifact_name(&self, id: &ConversationId, artifact: &str) -> String {
        let Ok(board) = self.core.board(id).await else {
            return "an artifact".into();
        };
        board
            .tasks
            .values()
            .filter_map(|task| task.report.as_ref())
            .flat_map(|report| &report.artifacts)
            .chain(board.tasks.values().flat_map(|task| &task.outputs))
            .find(|known| known.id == artifact)
            .map_or_else(|| "an artifact".into(), |known| known.title.clone())
    }

    pub(crate) async fn worker_call(
        &self,
        conversation_id: ConversationId,
        task_id: TaskId,
        call: WorkerCall,
    ) -> ToolReply {
        let result = match call {
            WorkerCall::AskOrchestrator(args) => {
                self.worker_question(&conversation_id, &task_id, args.question)
                    .await
            }
            WorkerCall::SubmitReport(args) => {
                self.worker_report(&conversation_id, &task_id, args).await
            }
            WorkerCall::CodeSearch(args) => self.code_search_tool(&conversation_id, args).await,
            WorkerCall::CodeRefs(args) => self.code_refs_tool(&conversation_id, args).await,
            WorkerCall::ProjectMap => self.project_map_tool(&conversation_id).await,
        };
        match result {
            Ok(text) => ToolReply::ok(text),
            Err(err) => ToolReply::error(err.to_string()),
        }
    }

    /// The latest approved plan and the index of its step `number` (from 1).
    async fn plan_step(&self, id: &ConversationId, number: u32) -> Result<(Plan, usize)> {
        let board = self.core.board(id).await?;
        let plan = board
            .plans
            .values()
            .filter(|plan| matches!(plan.state, PlanState::Approved { .. }))
            .max_by_key(|plan| plan.created_at_ms)
            .cloned()
            .ok_or_else(|| Error::Invalid("`step` needs an approved plan; there is none".into()))?;
        let index = (number as usize)
            .checked_sub(1)
            .filter(|index| *index < plan.steps.len())
            .ok_or_else(|| {
                Error::Invalid(format!(
                    "the plan \"{}\" has steps 1 to {}; there is no step {number}",
                    plan.title,
                    plan.steps.len()
                ))
            })?;
        Ok((plan, index))
    }

    /// In plan mode nothing changes until the user approves a plan: write tasks, accepting
    /// and finishing are refused, whatever the permission level.
    fn check_plan_mode(&self, id: &ConversationId) -> Result<()> {
        if self.plan_mode(id) {
            return Err(Error::Invalid(
                "Plan mode is on: change nothing yet. Scouts and research may look around; call propose_plan and wait for the user's decision. Implement and merge tasks, accept_task and finish_session work again once the user approves a plan.".into(),
            ));
        }
        Ok(())
    }

    /// Under "Ask for approval", write tasks wait for an approved plan, and for the user's
    /// decision on a newer plan still open.
    async fn check_plan_gate(&self, id: &ConversationId) -> Result<()> {
        self.check_plan_mode(id)?;
        let conversation = self.core.conversation(id)?;
        let Some(Setup::Session { permission, .. }) = conversation.setup else {
            return Ok(());
        };
        if permission != PermissionLevel::AskForApproval {
            return Ok(());
        }
        let board = self.core.board(id).await?;
        if let Some(open) = board.plans.values().find(|plan| {
            matches!(
                plan.state,
                PlanState::Proposed | PlanState::InReview { .. } | PlanState::Revising
            )
        }) {
            return Err(Error::Invalid(format!(
                "The plan \"{}\" is waiting for the user's decision: wait for it before starting implement or merge tasks.",
                open.title
            )));
        }
        let approved = board
            .plans
            .values()
            .any(|plan| matches!(plan.state, PlanState::Approved { .. }));
        if approved {
            Ok(())
        } else {
            Err(Error::Invalid(
                "This session asks the user to approve plans first: call propose_plan and wait for the user's decision before starting implement or merge tasks.".into(),
            ))
        }
    }

    async fn propose_plan(
        &self,
        id: &ConversationId,
        args: crate::tools::ProposePlan,
    ) -> Result<String> {
        use super::plan_gates::{adds_or_changes_steps, parse_responses, plan_reviewers};
        if args.steps.is_empty() {
            return Err(Error::Invalid("a plan needs at least one step".into()));
        }
        let conversation = self.core.conversation(id)?;
        let permission = match conversation.setup {
            // In plan mode the user decides the plan, whatever the permission level.
            Some(Setup::Session {
                plan_mode: true, ..
            }) => PermissionLevel::AskForApproval,
            Some(Setup::Session { permission, .. }) => permission,
            _ => PermissionLevel::ApproveForMe,
        };
        let board = self.core.board(id).await?;
        let request_id = self.request_for(id, None).await;
        // A revision names the plan whose review asked for changes and answers each finding.
        let revises = args
            .revises
            .as_deref()
            .map(str::trim)
            .filter(|revises| !revises.is_empty());
        let previous = match revises {
            Some(revises) => {
                let previous = board
                    .plans
                    .get(&CardId(revises.to_owned()))
                    .ok_or_else(|| Error::Invalid(format!("there is no plan {revises}")))?;
                if previous.state != PlanState::Revising {
                    return Err(Error::Invalid(format!(
                        "the plan \"{}\" is not waiting for a revision: `revises` names only a plan whose review asked for changes. Propose this plan without it.",
                        previous.title
                    )));
                }
                Some(previous.clone())
            }
            None => {
                if !args.responses.is_empty() {
                    return Err(Error::Invalid(
                        "`responses` answer the findings of the plan named in `revises`: name it"
                            .into(),
                    ));
                }
                if let Some(revising) = board
                    .plans
                    .values()
                    .find(|p| p.state == PlanState::Revising && p.request_id == request_id)
                {
                    return Err(Error::Invalid(format!(
                        "The plan \"{}\" is being revised after its review: propose the revision with revises: \"{}\" and one response per finding.",
                        revising.title, revising.id
                    )));
                }
                None
            }
        };
        let responses = match &previous {
            Some(previous) => parse_responses(
                &args.responses,
                previous
                    .gate
                    .as_ref()
                    .map_or(&[][..], |gate| gate.findings.as_slice()),
            )
            .map_err(Error::Invalid)?,
            None => Vec::new(),
        };
        let steps: Vec<PlanStep> = args
            .steps
            .into_iter()
            .map(|step| PlanStep {
                title: step.title,
                detail: step.detail,
                task_id: None,
            })
            .collect();
        // A new plan after an approved one of the same request is reviewed again when it adds
        // or changes steps.
        let approved = board
            .plans
            .values()
            .filter(|p| matches!(p.state, PlanState::Approved { .. }) && p.request_id == request_id)
            .max_by_key(|p| p.created_at_ms)
            .filter(|_| previous.is_none());
        let reviewers = plan_reviewers(
            steps.len(),
            args.risky,
            previous.is_some(),
            approved.map(|before| adds_or_changes_steps(&before.steps, &steps)),
        );
        let round = previous
            .as_ref()
            .and_then(|previous| previous.gate.as_ref())
            .map_or(1, |gate| gate.round + 1);
        // A new plan replaces the ones still open (a revision, the plan it revises).
        for plan in board.plans.values() {
            if matches!(
                plan.state,
                PlanState::Proposed | PlanState::InReview { .. } | PlanState::Revising
            ) {
                self.change_plan(id, &plan.id, |plan| {
                    if matches!(
                        plan.state,
                        PlanState::Proposed | PlanState::InReview { .. } | PlanState::Revising
                    ) {
                        plan.state = PlanState::Superseded;
                        plan.decided_at_ms = Some(now_ms());
                    }
                    Ok(())
                })
                .await?;
            }
        }
        let mut plan = Plan {
            id: CardId::generate(),
            conversation_id: id.clone(),
            request_id,
            position: 0,
            title: args.title,
            steps,
            risky: args.risky,
            state: PlanState::Proposed,
            gate: None,
            revises: previous.as_ref().map(|previous| previous.id.clone()),
            responses,
            review_notes: Vec::new(),
            created_at_ms: now_ms(),
            decided_at_ms: None,
        };
        let user_decides = permission == PermissionLevel::AskForApproval;
        if reviewers == 0 {
            if !user_decides {
                plan.state = PlanState::Approved {
                    by: PlanApprover::Brigadier,
                };
                plan.decided_at_ms = Some(now_ms());
            }
            self.store_plan(&plan).await?;
            return Ok(if user_decides {
                "The plan is shown to the user. Wait for their decision (it arrives as a message) before starting implement or merge tasks.".into()
            } else {
                "Approved on the user's behalf. Go ahead, and pass each step's number as `step` when you delegate it.".into()
            });
        }
        self.store_plan(&plan).await?;
        let started = match self
            .open_plan_gate(&plan, round, reviewers, !user_decides)
            .await
        {
            Ok(started) => started,
            Err(err) if user_decides => {
                return Ok(format!(
                    "The plan is shown to the user (its independent review could not start: {err}). Wait for their decision (it arrives as a message) before starting implement or merge tasks."
                ));
            }
            Err(err) => {
                let reason = err.to_string();
                self.change_plan(id, &plan.id, |plan| {
                    if plan.state == PlanState::Proposed {
                        plan.state = PlanState::Rejected {
                            message: Some(format!("The review could not start: {reason}")),
                        };
                        plan.decided_at_ms = Some(now_ms());
                    }
                    Ok(())
                })
                .await?;
                return Err(Error::Invalid(format!(
                    "the plan needs an independent review, which could not start: {reason}"
                )));
            }
        };
        let who = started
            .iter()
            .map(|task| format!("task-{}", task.number))
            .collect::<Vec<_>>()
            .join(" and ");
        let reviewed = if round > 1 {
            format!(
                "The revision goes to the last review round ({round} of {}), by {who}",
                super::plan_gates::PLAN_ROUNDS
            )
        } else if started.len() > 1 {
            format!("The plan is risky, so two independent reviewers ({who}) check it")
        } else {
            format!("An independent reviewer ({who}) checks the plan")
        };
        Ok(if user_decides {
            format!(
                "The plan is shown to the user. {reviewed}; its findings show on the user's card. Wait for the user's decision (it arrives as a message) before starting implement or merge tasks."
            )
        } else {
            format!(
                "{reviewed} before Brigadier approves it on the user's behalf. The outcome arrives as a message; don't start write tasks before it."
            )
        })
    }

    /// The user's attachments in this conversation, by id.
    async fn find_attachments(
        &self,
        id: &ConversationId,
        ids: &[String],
    ) -> Result<Vec<AttachmentRef>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut found: Vec<Option<AttachmentRef>> = vec![None; ids.len()];
        let mut before = None;
        // Newest first, page by page, until every attachment is found or history ends.
        while found.iter().any(Option::is_none) {
            let page = self.core.list_messages(id.clone(), before, 500).await?;
            for attachment in page.messages.iter().flat_map(|m| m.attachments.iter()) {
                for (wanted, slot) in ids.iter().zip(found.iter_mut()) {
                    if slot.is_none() && &attachment.id == wanted {
                        *slot = Some(attachment.clone());
                    }
                }
            }
            match page.messages.first() {
                Some(oldest) if page.has_more => before = Some(oldest.seq),
                _ => break,
            }
        }
        ids.iter()
            .zip(found)
            .map(|(wanted, attachment)| {
                attachment.ok_or_else(|| {
                    Error::NotFound(format!("attachment {wanted} in this conversation"))
                })
            })
            .collect()
    }
}

/// The orchestrator's provider/model/effort override.
fn pin(
    provider: Option<&str>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<Option<brigadier_router::Pin>> {
    let provider = match provider.map(|p| p.trim().to_lowercase()) {
        None => None,
        Some(p) if p.is_empty() => None,
        Some(p) if p == "claude" => Some(ProviderKind::Claude),
        Some(p) if p == "codex" => Some(ProviderKind::Codex),
        Some(p) => {
            return Err(Error::Invalid(format!(
                "unknown provider {p}: use claude or codex"
            )));
        }
    };
    let model = model.filter(|m| !m.trim().is_empty());
    let effort = effort.filter(|e| !e.trim().is_empty());
    if provider.is_none() && model.is_none() && effort.is_none() {
        return Ok(None);
    }
    Ok(Some(brigadier_router::Pin {
        provider,
        model,
        effort,
    }))
}

/// `delegate_task`'s areas; none given: routing infers them from the spec.
fn task_areas(names: &[String]) -> Result<Option<Vec<brigadier_router::Area>>> {
    if names.is_empty() {
        return Ok(None);
    }
    names
        .iter()
        .map(|name| {
            serde_json::from_value(serde_json::Value::String(name.trim().to_lowercase())).map_err(
                |_| {
                    Error::Invalid(format!(
                        "unknown area \"{name}\": use frontend, backend, infra, docs or tests"
                    ))
                },
            )
        })
        .collect::<Result<Vec<_>>>()
        .map(Some)
}
