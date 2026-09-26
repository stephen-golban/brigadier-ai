//! User requests: what one user message set in motion, and when it is over.
//!
//! A request works while its turn runs, while an envelope or message for it waits for a turn,
//! or while a task it started runs. It waits while something it opened needs the user (a
//! card, a paused worker, a landing on hold). Otherwise it is done, or stopped or failed when
//! its last turn ended that way. A done request works again when new work for it arrives
//! (a late report, a worker's question), so its block in the thread stays one block.

use super::SessionManager;
use super::conversation::Envelope;
use super::prompts;
use crate::board::Board;
use crate::model::{ConversationId, ConversationKind};
use crate::work::{CardState, PlanState, RequestState, Task, TaskId, TaskState};

impl SessionManager {
    /// The request new work is filed under: the task's, else the running turn's, else the
    /// conversation's newest.
    pub(crate) async fn request_for(
        &self,
        conversation_id: &ConversationId,
        task_id: Option<&TaskId>,
    ) -> Option<String> {
        if let Some(task_id) = task_id
            && let Ok(task) = self.task_by_id(conversation_id, task_id).await
            && task.request_id.is_some()
        {
            return task.request_id;
        }
        if let Ok(conv) = self.conv(conversation_id)
            && let Some(request) = conv.running_request().await
        {
            return Some(request);
        }
        let board = self.core.board(conversation_id).await.ok()?;
        board.latest_request().map(|request| request.id.clone())
    }

    /// The request a task moves to when the running turn acts on it for a later request than
    /// its own: what follows (its landing, the answer) then belongs to the request that asked.
    pub(crate) async fn later_request_for(
        &self,
        conversation_id: &ConversationId,
        task: &Task,
    ) -> Option<String> {
        let running = self.conv(conversation_id).ok()?.running_request().await?;
        let Some(own) = &task.request_id else {
            return Some(running);
        };
        if *own == running {
            return None;
        }
        let board = self.core.board(conversation_id).await.ok()?;
        let started = |id: &str| {
            board
                .requests
                .get(id)
                .map(|request| (request.started_at_ms, &request.id))
        };
        (started(&running)? > started(own)?).then_some(running)
    }

    /// The newest request, while the answer the thread shows for it still works or waits: it,
    /// or a request it was steered into, has a turn, a worker or a card going. A follow-up
    /// sent now may belong to that answer.
    pub(crate) async fn working_request(&self, conversation_id: &ConversationId) -> Option<String> {
        let board = self.core.board(conversation_id).await.ok()?;
        let latest = board.latest_request()?;
        let mut request = Some(latest);
        // A steer chain is short; the bound only guards against a cycle in stored data.
        for _ in 0..board.requests.len() {
            let Some(of) = request else {
                break;
            };
            if matches!(of.state, RequestState::Working | RequestState::Waiting) {
                return Some(latest.id.clone());
            }
            request = of
                .steered_into
                .as_deref()
                .and_then(|into| board.requests.get(into));
        }
        None
    }

    /// Brings every request of the conversation up to date with what runs and waits.
    pub(crate) async fn settle_requests(&self, conversation_id: &ConversationId) {
        let Ok(board) = self.core.board(conversation_id).await else {
            return;
        };
        if board.requests.is_empty() {
            return;
        }
        let Ok(conv) = self.conv(conversation_id) else {
            return;
        };
        let activity = conv.request_activity().await;
        for request in board.requests.values() {
            let id = request.id.as_str();
            let outcome = activity.outcomes.get(id);
            let state = if activity.running.as_deref() == Some(id)
                || (activity.carried.contains(id) && outcome.is_none())
                || tasks_in(&board, id, |state| {
                    matches!(
                        state,
                        TaskState::Queued
                            | TaskState::Starting
                            | TaskState::Running
                            | TaskState::Reviewing
                    )
                }) {
                RequestState::Working
            } else if needs_user(&board, id) {
                RequestState::Waiting
            } else if tasks_in(&board, id, |state| state == TaskState::Blocked) {
                // Blocked on the orchestrator's answer (a gate's card makes it Waiting).
                RequestState::Working
            } else if let Some(outcome) = outcome {
                outcome.clone()
            } else if matches!(
                request.state,
                RequestState::Stopped | RequestState::Failed { .. }
            ) {
                request.state.clone()
            } else {
                RequestState::Done
            };
            if let Err(err) = self.core.update_request(conversation_id, id, state).await {
                tracing::debug!(conversation = %conversation_id, error = %err, "could not update a request");
            }
        }
        // A session's answer that ended with no turn after it (a worker the user stopped):
        // the follow-up waiting for it goes now.
        let waiting = conv.kind == ConversationKind::Session
            && activity.running.is_none()
            && activity.carried.is_empty()
            && !board.queue.paused
            && board.queue.items.first().is_some_and(|item| !item.deciding);
        if waiting && self.working_request(conversation_id).await.is_none() {
            self.kick(&conv);
        }
    }

    /// What a turn tells the orchestrator besides user messages: each envelope, labelled when
    /// it belongs to an earlier request than the newest, then what else still runs for the
    /// request.
    pub(super) async fn request_notes(
        &self,
        conversation_id: &ConversationId,
        envelopes: &[(Envelope, Option<String>)],
        request: Option<&str>,
    ) -> Vec<String> {
        if envelopes.is_empty() {
            return Vec::new();
        }
        let Ok(board) = self.core.board(conversation_id).await else {
            return envelopes.iter().map(|(e, _)| e.text.clone()).collect();
        };
        let earlier = match (request, board.latest_request()) {
            (Some(request), Some(latest)) if latest.id != request => {
                board.requests.get(request).map(|of| of.preview.clone())
            }
            _ => None,
        };
        let mut notes: Vec<String> = envelopes
            .iter()
            .map(|(envelope, _)| match &earlier {
                Some(preview) => format!(
                    "[for the user's earlier request: \"{preview}\"]\n{}",
                    envelope.text
                ),
                None => envelope.text.clone(),
            })
            .collect();
        if let (Some(request), Some(last)) = (request, notes.last_mut()) {
            let mut running: Vec<_> = board
                .tasks
                .values()
                .filter(|task| {
                    task.request_id.as_deref() == Some(request)
                        && !task.state.is_final()
                        && task.state != TaskState::Reported
                })
                .collect();
            running.sort_by_key(|task| task.number);
            last.push_str("\n\n");
            if running.is_empty() {
                last.push_str("[nothing else is running for this request]");
            } else {
                let list: Vec<String> = running
                    .iter()
                    .map(|task| {
                        format!("task-{} \"{}\" ({:?})", task.number, task.title, task.state)
                    })
                    .collect();
                last.push_str(&format!(
                    "[still running for this request: {}. Their reports come as later messages. \
                     Act on this message with tools if it needs it. Then, unless the user must \
                     change plans, reply with exactly {} and nothing else: the user already \
                     sees the workers' progress.]",
                    list.join(", "),
                    prompts::QUIET
                ));
            }
        }
        notes
    }
}

/// Whether a task of the request is in a state `matches` accepts.
fn tasks_in(board: &Board, request: &str, matches: impl Fn(TaskState) -> bool) -> bool {
    board
        .tasks
        .values()
        .any(|task| task.request_id.as_deref() == Some(request) && matches(task.state))
}

/// Whether something the request opened waits for the user.
fn needs_user(board: &Board, request: &str) -> bool {
    let of = |id: &Option<String>| id.as_deref() == Some(request);
    board
        .approvals
        .values()
        .any(|a| of(&a.request_id) && a.state == CardState::Pending)
        || board
            .questions
            .values()
            .any(|q| of(&q.request_id) && q.answer.is_none() && q.answered_at_ms.is_none())
        || board.plans.values().any(|p| {
            of(&p.request_id) && matches!(p.state, PlanState::Proposed | PlanState::InReview { .. })
        })
        || tasks_in(board, request, |state| {
            matches!(
                state,
                TaskState::Paused | TaskState::AwaitingApproval | TaskState::ReadyToLand
            )
        })
}
