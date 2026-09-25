//! A conversation's board: its tasks, cards, queue and run state, folded from the
//! conversation's stream. Messages are not kept here; they are paged from the store.

use std::collections::HashMap;

use crate::model::{DomainEvent, MessageRole, Notice, StreamingMessage};
use crate::work::{
    Approval, CardId, MessageQueue, Plan, Question, RunState, Task, TaskId, UserRequest, WorkerStep,
};

/// Notices kept per conversation.
const NOTICES_KEPT: usize = 20;

/// Event kinds the board is folded from (everything on a conversation stream but messages).
pub(crate) const KINDS: &[&str] = &[
    "conversation.run",
    "conversation.notice",
    "task.updated",
    "approval.updated",
    "question.updated",
    "plan.updated",
    "queue.changed",
    "request.updated",
    "worker.step",
    "conversation.branch",
];

#[derive(Debug, Default, Clone)]
pub(crate) struct Board {
    pub(crate) tasks: HashMap<TaskId, Task>,
    pub(crate) approvals: HashMap<CardId, Approval>,
    pub(crate) questions: HashMap<CardId, Question>,
    pub(crate) plans: HashMap<CardId, Plan>,
    pub(crate) requests: HashMap<String, UserRequest>,
    /// Every worker step, in stream order.
    pub(crate) worker_steps: Vec<WorkerStep>,
    pub(crate) queue: MessageQueue,
    pub(crate) run: RunState,
    /// The request the running turn serves.
    pub(crate) run_request: Option<String>,
    /// The last message of the branch shown, and the stream sequence that set it.
    pub(crate) head: Option<(String, i64)>,
    pub(crate) streaming: Option<StreamingMessage>,
    pub(crate) notices: Vec<Notice>,
}

impl Board {
    /// Applies an event stored at `stream_seq` in the conversation's stream. An object's
    /// position is the stream sequence of the event that first recorded it.
    pub(crate) fn apply(&mut self, event: &DomainEvent, stream_seq: i64) {
        match event {
            DomainEvent::TaskUpdated { task } => {
                let position = self
                    .tasks
                    .get(&task.id)
                    .map_or(stream_seq, |known| known.position);
                let mut task = (**task).clone();
                task.position = position;
                self.tasks.insert(task.id.clone(), task);
            }
            DomainEvent::ApprovalUpdated { approval } => {
                let position = self
                    .approvals
                    .get(&approval.id)
                    .map_or(stream_seq, |known| known.position);
                let mut approval = approval.clone();
                approval.position = position;
                self.approvals.insert(approval.id.clone(), approval);
            }
            DomainEvent::QuestionUpdated { question } => {
                let position = self
                    .questions
                    .get(&question.id)
                    .map_or(stream_seq, |known| known.position);
                let mut question = question.clone();
                question.position = position;
                self.questions.insert(question.id.clone(), question);
            }
            DomainEvent::PlanUpdated { plan } => {
                let position = self
                    .plans
                    .get(&plan.id)
                    .map_or(stream_seq, |known| known.position);
                let mut plan = plan.clone();
                plan.position = position;
                self.plans.insert(plan.id.clone(), plan);
            }
            DomainEvent::QueueChanged { queue, .. } => self.queue = queue.clone(),
            DomainEvent::RunStateChanged {
                state, request_id, ..
            } => {
                self.run = *state;
                self.run_request.clone_from(request_id);
                if *state != RunState::Running {
                    self.streaming = None;
                }
            }
            DomainEvent::RequestUpdated { request } => {
                self.requests.insert(request.id.clone(), request.clone());
            }
            DomainEvent::WorkerStepped { step } => {
                let mut step = step.clone();
                step.position = stream_seq;
                self.worker_steps.push(step);
            }
            DomainEvent::BranchSwitched { head, .. } => {
                self.head = Some((head.clone(), stream_seq));
            }
            DomainEvent::ConversationNotice { notice, .. } => {
                self.notices.push(notice.clone());
                if self.notices.len() > NOTICES_KEPT {
                    self.notices.remove(0);
                }
            }
            DomainEvent::MessageDelta {
                message_id, text, ..
            } => match &mut self.streaming {
                Some(streaming) if streaming.message_id == *message_id => {
                    streaming.text.push_str(text);
                }
                _ => {
                    self.streaming = Some(StreamingMessage {
                        message_id: message_id.clone(),
                        text: text.clone(),
                        request_id: self.run_request.clone(),
                    });
                }
            },
            DomainEvent::MessageAppended { message } => {
                // A new message continues the branch shown.
                self.head = Some((message.id.clone(), stream_seq));
                if message.role == MessageRole::Assistant
                    && self
                        .streaming
                        .as_ref()
                        .is_some_and(|streaming| streaming.message_id == message.id)
                {
                    self.streaming = None;
                }
            }
            _ => {}
        }
    }

    pub(crate) fn next_task_number(&self) -> u32 {
        self.tasks
            .values()
            .map(|task| task.number)
            .max()
            .unwrap_or(0)
            + 1
    }

    pub(crate) fn sorted_tasks(&self) -> Vec<Task> {
        let mut tasks: Vec<Task> = self.tasks.values().cloned().collect();
        tasks.sort_by_key(|task| task.position);
        tasks
    }

    pub(crate) fn sorted_approvals(&self) -> Vec<Approval> {
        let mut approvals: Vec<Approval> = self.approvals.values().cloned().collect();
        approvals.sort_by_key(|approval| approval.position);
        approvals
    }

    pub(crate) fn sorted_questions(&self) -> Vec<Question> {
        let mut questions: Vec<Question> = self.questions.values().cloned().collect();
        questions.sort_by_key(|question| question.position);
        questions
    }

    pub(crate) fn sorted_requests(&self) -> Vec<UserRequest> {
        let mut requests: Vec<UserRequest> = self.requests.values().cloned().collect();
        requests.sort_by(|a, b| a.started_at_ms.cmp(&b.started_at_ms).then(a.id.cmp(&b.id)));
        requests
    }

    /// The newest request, which work without a request of its own is filed under.
    pub(crate) fn latest_request(&self) -> Option<&UserRequest> {
        self.requests
            .values()
            .max_by(|a, b| a.started_at_ms.cmp(&b.started_at_ms).then(a.id.cmp(&b.id)))
    }

    pub(crate) fn sorted_plans(&self) -> Vec<Plan> {
        let mut plans: Vec<Plan> = self.plans.values().cloned().collect();
        plans.sort_by_key(|plan| plan.position);
        plans
    }
}
