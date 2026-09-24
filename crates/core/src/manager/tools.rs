//! The Brigadier MCP tools, answered. Orchestrator tools return at once; their outcomes
//! arrive later as envelopes. Every reply the orchestrator reads is logged as a context
//! injection.

use brigadier_providers::ProviderKind;

use super::SessionManager;
use super::prompts;
use super::workers::route_label;
use crate::model::{ConversationId, PermissionLevel, Setup};
use crate::tools::{OrchestratorCall, ToolReply, WorkerCall};
use crate::work::{
    ApprovalSubject, AttachmentRef, CardId, InjectionKind, Plan, PlanApprover, PlanState, PlanStep,
    QuestionKind, TaskId, TaskKind,
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
                            "a review task needs `subject`: the task whose change it reviews".into(),
                        ));
                    }
                    (None, _) => None,
                };
                if args.kind == TaskKind::Review
                    && subject.as_ref().is_some_and(|s| s.candidate.is_none() && s.report.is_none())
                {
                    return Err(Error::Invalid("the subject task has nothing to review yet".into()));
                }
                let pin = pin(args.provider.as_deref(), args.model, args.effort)?;
                let attachments = self.find_attachments(id, &args.attachments).await?;
                let avoid = subject
                    .as_ref()
                    .filter(|_| args.kind == TaskKind::Review)
                    .map(|s| brigadier_router::Author {
                        provider: s.route.choice.provider,
                        model: s.route.choice.model.clone(),
                    });
                let task = self
                    .create_task(id, args.title, args.kind, args.spec, pin, avoid, subject, attachments)
                    .await?;
                Ok(format!(
                    "Started task-{} ({:?}) on {}: {}. Its report arrives later as a message; don't wait for it.",
                    task.number,
                    task.kind,
                    route_label(&task),
                    task.route.reason
                ))
            }
            OrchestratorCall::MessageWorker(args) => {
                let task = self.find_task(id, &args.task).await?;
                self.message_worker(id, &task, args.text).await
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
                self.open_question(id, task_id, QuestionKind::Orchestrator, args.question, args.options)
                    .await?;
                Ok("Asked the user. The answer arrives later as a message; carry on with anything that doesn't depend on it.".into())
            }
            OrchestratorCall::ReadReport(args) => {
                let task = self.find_task(id, &args.task).await?;
                let report = task
                    .report
                    .as_ref()
                    .ok_or_else(|| Error::Invalid(format!("task-{} has not reported yet", task.number)))?;
                Ok(prompts::report_envelope(&task, report, &route_label(&task)))
            }
            OrchestratorCall::ReadArtifact(args) => {
                let limit = args.limit.unwrap_or(ARTIFACT_PAGE_MAX).min(ARTIFACT_PAGE_MAX);
                let offset = args.offset.unwrap_or(0);
                let (bytes, total) = self.core.read_blob_range(args.id.clone(), offset, limit).await?;
                let text = match std::str::from_utf8(&bytes) {
                    Ok(text) => text.to_owned(),
                    // A page may end inside a character.
                    Err(err) if err.error_len().is_none() => {
                        String::from_utf8_lossy(&bytes[..err.valid_up_to()]).into_owned()
                    }
                    Err(_) => return Ok(format!("{} is not text ({total} bytes).", args.id)),
                };
                let end = offset + text.len() as u64;
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
            OrchestratorCall::QueryBrain(_) => Ok(
                "The Project Brain is not available yet in this version of Brigadier. Delegate a scout task to find this out.".into(),
            ),
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
                let task = self.find_task(id, &args.task).await?;
                self.accept_task(id, task, args.commit_message).await
            }
            OrchestratorCall::FinishSession(args) => self.finish_session(id, args.message).await,
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
        };
        match result {
            Ok(text) => ToolReply::ok(text),
            Err(err) => ToolReply::error(err.to_string()),
        }
    }

    /// Under "Ask for approval", write tasks wait for an approved plan, and for the user's
    /// decision on a newer plan still open.
    async fn check_plan_gate(&self, id: &ConversationId) -> Result<()> {
        let conversation = self.core.conversation(id)?;
        let Some(Setup::Session { permission, .. }) = conversation.setup else {
            return Ok(());
        };
        if permission != PermissionLevel::AskForApproval {
            return Ok(());
        }
        let board = self.core.board(id).await?;
        if let Some(open) = board
            .plans
            .values()
            .find(|plan| matches!(plan.state, PlanState::Proposed | PlanState::InReview { .. }))
        {
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
        if args.steps.is_empty() {
            return Err(Error::Invalid("a plan needs at least one step".into()));
        }
        let conversation = self.core.conversation(id)?;
        let permission = match conversation.setup {
            Some(Setup::Session { permission, .. }) => permission,
            _ => PermissionLevel::ApproveForMe,
        };
        let board = self.core.board(id).await?;
        // A new plan replaces the ones still open.
        for plan in board.plans.values() {
            if matches!(plan.state, PlanState::Proposed | PlanState::InReview { .. }) {
                let mut plan = plan.clone();
                plan.state = PlanState::Superseded;
                plan.decided_at_ms = Some(now_ms());
                self.store_plan(&plan).await?;
            }
        }
        let mut plan = Plan {
            id: CardId::generate(),
            conversation_id: id.clone(),
            position: 0,
            title: args.title,
            steps: args
                .steps
                .into_iter()
                .map(|step| PlanStep {
                    title: step.title,
                    detail: step.detail,
                    task_id: None,
                })
                .collect(),
            risky: args.risky,
            state: PlanState::Proposed,
            created_at_ms: now_ms(),
            decided_at_ms: None,
        };
        match (permission, plan.risky) {
            (PermissionLevel::AskForApproval, _) => {
                self.store_plan(&plan).await?;
                Ok("The plan is shown to the user. Wait for their decision (it arrives as a message) before starting implement or merge tasks.".into())
            }
            (_, false) => {
                plan.state = PlanState::Approved {
                    by: PlanApprover::Brigadier,
                };
                plan.decided_at_ms = Some(now_ms());
                self.store_plan(&plan).await?;
                Ok("Approved on the user's behalf. Go ahead.".into())
            }
            (_, true) => {
                self.store_plan(&plan).await?;
                let review = self.start_plan_review(id, &plan).await?;
                plan.state = PlanState::InReview {
                    task_id: review.id.clone(),
                };
                self.store_plan(&plan).await?;
                Ok(format!(
                    "The plan is risky, so an independent reviewer (task-{}) checks it before Brigadier approves it on the user's behalf. The outcome arrives as a message; don't start write tasks before it.",
                    review.number
                ))
            }
        }
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
        let page = self.core.list_messages(id.clone(), None, 500).await?;
        let mut found = Vec::new();
        for wanted in ids {
            let attachment = page
                .messages
                .iter()
                .flat_map(|message| message.attachments.iter())
                .find(|attachment| &attachment.id == wanted)
                .cloned()
                .ok_or_else(|| {
                    Error::NotFound(format!("attachment {wanted} in this conversation"))
                })?;
            found.push(attachment);
        }
        Ok(found)
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
