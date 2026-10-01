//! "Decided for you" and "Waiting on you": what the session's summary tells the user about
//! the work Brigadier runs on their behalf (built in, always on).
//!
//! - **Decided for you.** Under "Approve for me" and "Full access", each decision Brigadier
//!   takes in the user's place is logged with why: a plan approved, sent back for revision or
//!   turned down; a change landed after its checks, sent back with their findings, held
//!   because it couldn't be verified, or handed to the orchestrator; a permission a worker
//!   asked for declined. The orchestrator notes its own judgement calls (`note_for_user`), and
//!   the stall watchdog its actions ([`SessionManager::decided_for_task`]).
//! - **Waiting on you.** What only the user can do: a worker's `needs_user` lines, what a
//!   change's checks need from the user first, what the orchestrator notes, and cards left
//!   unanswered (the watchdog, with [`WaitingSource::Card`]). An item is listed once per
//!   source and text, and keeps its request waiting while other work goes on. It is over when
//!   the user clicks Done (the orchestrator hears it), or without them: when its card
//!   settles, its task is stopped or reports again without it, or the change it held lands.

use super::SessionManager;
use super::conversation::Envelope;
use crate::board::Board;
use crate::model::{ConversationId, DomainEvent, PermissionLevel};
use crate::sessions::one_line;
use crate::work::{
    CardId, CardState, Decision, DecisionSource, InjectionKind, Plan, PlanState, ResolvedBy, Task,
    TaskState, WaitingItem, WaitingSource,
};
use crate::{Error, Result, now_ms};

/// The longest line a decision or a waiting item keeps.
const LINE_CHARS: usize = 300;
/// The longest reason a decision keeps.
const WHY_CHARS: usize = 600;

impl SessionManager {
    /// Logs a decision Brigadier took on the user's behalf. Under "Ask for approval" the user
    /// takes them, so nothing is logged.
    pub(crate) async fn decided_for_you(
        &self,
        conversation_id: &ConversationId,
        request_id: Option<String>,
        source: DecisionSource,
        what: String,
        why: String,
    ) {
        if self.permission(conversation_id) == PermissionLevel::AskForApproval {
            return;
        }
        self.record_decision(conversation_id, request_id, source, what, why)
            .await;
    }

    /// Logs a decision about a task (its landing, a fix round, a declined permission, a
    /// watchdog action), under the task's request.
    pub(crate) async fn decided_for_task(&self, task: &Task, what: String, why: String) {
        let request = self
            .request_for(&task.conversation_id, Some(&task.id))
            .await;
        self.decided_for_you(
            &task.conversation_id,
            request,
            DecisionSource::Task {
                task_id: task.id.clone(),
            },
            what,
            why,
        )
        .await;
    }

    /// Logs a decision about a plan, under the plan's request.
    pub(crate) async fn decided_for_plan(&self, plan: &Plan, what: String, why: String) {
        self.decided_for_you(
            &plan.conversation_id,
            plan.request_id.clone(),
            DecisionSource::Plan {
                plan_id: plan.id.clone(),
            },
            what,
            why,
        )
        .await;
    }

    /// Records a decision, whatever the permission level (the orchestrator's own notes).
    pub(crate) async fn record_decision(
        &self,
        conversation_id: &ConversationId,
        request_id: Option<String>,
        source: DecisionSource,
        what: String,
        why: String,
    ) {
        let decision = Decision {
            id: uuid::Uuid::now_v7().to_string(),
            request_id,
            source,
            what: one_line(&what, LINE_CHARS),
            why: one_line(&why, WHY_CHARS),
            at_ms: now_ms(),
            position: 0,
        };
        if let Err(err) = self
            .core
            .record_conversation(
                conversation_id,
                vec![DomainEvent::DecidedForYou { decision }],
            )
            .await
        {
            tracing::warn!(conversation = %conversation_id, error = %err, "could not record a decision");
        }
    }

    /// Lists something only the user can do, or rewords the open item with the same key.
    /// Returns whether a new item was listed.
    pub(crate) async fn wait_on_user(
        &self,
        conversation_id: &ConversationId,
        request_id: Option<String>,
        source: WaitingSource,
        what: &str,
    ) -> Result<bool> {
        let what = one_line(what, LINE_CHARS);
        if what.is_empty() {
            return Err(Error::Invalid("say what the user must do".into()));
        }
        let added = {
            let _held = self.waiting.lock().await;
            let board = self.core.board(conversation_id).await?;
            let key = waiting_key(&source, &what);
            let (item, added) = match board.waiting.values().find(|open| open.key == key) {
                Some(open) if open.what == what => return Ok(false),
                Some(open) => (
                    WaitingItem {
                        what,
                        ..open.clone()
                    },
                    false,
                ),
                None => (
                    WaitingItem {
                        id: uuid::Uuid::now_v7().to_string(),
                        request_id,
                        source,
                        key,
                        what,
                        created_at_ms: now_ms(),
                    },
                    true,
                ),
            };
            self.core
                .record_conversation(conversation_id, vec![DomainEvent::WaitingOnYou { item }])
                .await?;
            added
        };
        self.settle_requests(conversation_id).await;
        Ok(added)
    }

    /// A task reported what only the user can do (its `needs_user`, `source`
    /// [`WaitingSource::Task`]) or what its change's checks need from them first
    /// ([`WaitingSource::Landing`]): each line is listed once, and the task's open items of
    /// that source the new list no longer names are over. Returns how many lines are listed.
    pub(crate) async fn sync_waiting(
        &self,
        task: &Task,
        source: WaitingSource,
        lines: &[String],
    ) -> usize {
        let request = self
            .request_for(&task.conversation_id, Some(&task.id))
            .await;
        let changed = {
            let _held = self.waiting.lock().await;
            let Ok(board) = self.core.board(&task.conversation_id).await else {
                return 0;
            };
            let open: Vec<WaitingItem> = board
                .waiting
                .values()
                .filter(|item| item.source == source)
                .cloned()
                .collect();
            let (listed, gone) = report_waits(&source, &open, lines, request, now_ms(), || {
                uuid::Uuid::now_v7().to_string()
            });
            let events: Vec<DomainEvent> = listed
                .into_iter()
                .map(|item| DomainEvent::WaitingOnYou { item })
                .chain(gone.into_iter().map(|id| DomainEvent::WaitingResolved {
                    id,
                    by: ResolvedBy::Brigadier,
                }))
                .collect();
            if events.is_empty() {
                false
            } else if let Err(err) = self
                .core
                .record_conversation(&task.conversation_id, events)
                .await
            {
                tracing::warn!(task = %task.id, error = %err, "could not list what waits for the user");
                false
            } else {
                true
            }
        };
        if changed {
            self.settle_requests(&task.conversation_id).await;
        }
        distinct_lines(lines).len()
    }

    /// A task ended: what its change's checks waited for is over, and what its reports listed
    /// is too when it was stopped.
    pub(crate) async fn task_ended_waiting(&self, task: &Task, state: TaskState) {
        let over = |source: &WaitingSource| match source {
            WaitingSource::Landing { task_id } => *task_id == task.id,
            WaitingSource::Task { task_id } => *task_id == task.id && state == TaskState::Stopped,
            _ => false,
        };
        if self
            .resolve_where(&task.conversation_id, |item| over(&item.source))
            .await
        {
            self.settle_requests(&task.conversation_id).await;
        }
    }

    /// Items whose card was answered or expired are over. Returns whether any was, before
    /// the conversation's requests are settled.
    pub(crate) async fn settle_card_waits(
        &self,
        conversation_id: &ConversationId,
        board: &Board,
    ) -> bool {
        let settled = |item: &WaitingItem| matches!(&item.source, WaitingSource::Card { card_id } if !card_open(board, card_id));
        if !board.waiting.values().any(settled) {
            return false;
        }
        self.resolve_where(conversation_id, settled).await
    }

    /// Marks the open items `over` picks done by Brigadier. Returns whether any was.
    async fn resolve_where(
        &self,
        conversation_id: &ConversationId,
        over: impl Fn(&WaitingItem) -> bool,
    ) -> bool {
        let _held = self.waiting.lock().await;
        let Ok(board) = self.core.board(conversation_id).await else {
            return false;
        };
        let events: Vec<DomainEvent> = board
            .waiting
            .values()
            .filter(|item| over(item))
            .map(|item| DomainEvent::WaitingResolved {
                id: item.id.clone(),
                by: ResolvedBy::Brigadier,
            })
            .collect();
        if events.is_empty() {
            return false;
        }
        match self.core.record_conversation(conversation_id, events).await {
            Ok(_) => true,
            Err(err) => {
                tracing::warn!(conversation = %conversation_id, error = %err, "could not resolve what waited for the user");
                false
            }
        }
    }

    /// The user marked an item done (Done on the summary card): the orchestrator hears it.
    pub async fn resolve_waiting(&self, conversation_id: ConversationId, id: String) -> Result<()> {
        let (item, board) = {
            let _held = self.waiting.lock().await;
            let board = self.core.board(&conversation_id).await?;
            let item = board
                .waiting
                .get(&id)
                .cloned()
                .ok_or_else(|| Error::Invalid("That item is already done.".into()))?;
            self.core
                .record_conversation(
                    &conversation_id,
                    vec![DomainEvent::WaitingResolved {
                        id,
                        by: ResolvedBy::User,
                    }],
                )
                .await?;
            (item, board)
        };
        let number = |task_id: &crate::work::TaskId| board.tasks.get(task_id).map(|t| t.number);
        let next = match &item.source {
            WaitingSource::Task { task_id } => number(task_id)
                .map(|n| format!(" (task-{n} listed it as something only the user can do)"))
                .unwrap_or_default(),
            WaitingSource::Landing { task_id } => number(task_id)
                .map(|n| format!(" The checks of task-{n}'s change waited for it: call accept_task for task-{n} again to verify and land it."))
                .unwrap_or_default(),
            WaitingSource::Card { .. } | WaitingSource::Orchestrator => String::new(),
        };
        self.deliver_for(
            &conversation_id,
            Envelope {
                kind: InjectionKind::Decision,
                label: "user did".into(),
                task_id: None,
                text: format!("[decision] The user did: {}{next}", item.what),
            },
            item.request_id.clone(),
        )
        .await;
        self.settle_requests(&conversation_id).await;
        Ok(())
    }
}

/// Whether a card still waits for the user.
fn card_open(board: &Board, card: &CardId) -> bool {
    board
        .approvals
        .get(card)
        .is_some_and(|approval| approval.state == CardState::Pending)
        || board
            .questions
            .get(card)
            .is_some_and(|question| question.answer.is_none() && question.answered_at_ms.is_none())
        || board.plans.get(card).is_some_and(|plan| {
            matches!(plan.state, PlanState::Proposed | PlanState::InReview { .. })
        })
}

/// What makes two items the same: their source, and their text in lower case, without
/// punctuation or bullets and with single spaces.
pub(crate) fn waiting_key(source: &WaitingSource, text: &str) -> String {
    let source = match source {
        WaitingSource::Card { card_id } => format!("card:{card_id}"),
        WaitingSource::Task { task_id } => format!("task:{task_id}"),
        WaitingSource::Landing { task_id } => format!("landing:{task_id}"),
        WaitingSource::Orchestrator => "orchestrator".to_owned(),
    };
    let words: Vec<String> = text
        .split_whitespace()
        .map(|word| {
            word.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|word| !word.is_empty())
        .collect();
    format!("{source}|{}", words.join(" "))
}

/// A report's lines, trimmed and on one line each, without blanks or repeats of one item.
fn distinct_lines(lines: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    lines
        .iter()
        .map(|line| one_line(line.trim().trim_start_matches(['-', '*', ' ']), LINE_CHARS))
        .filter(|line| !line.is_empty())
        .filter(|line| seen.insert(waiting_key(&WaitingSource::Orchestrator, line)))
        .collect()
}

/// What a source's new list of lines makes of its open items: the items to list (new ones,
/// and open ones reworded) and the ids of open items it no longer names.
fn report_waits(
    source: &WaitingSource,
    open: &[WaitingItem],
    lines: &[String],
    request_id: Option<String>,
    now: i64,
    mut new_id: impl FnMut() -> String,
) -> (Vec<WaitingItem>, Vec<String>) {
    let mut listed = Vec::new();
    let mut named = std::collections::HashSet::new();
    for what in distinct_lines(lines) {
        let key = waiting_key(source, &what);
        named.insert(key.clone());
        match open.iter().find(|item| item.key == key) {
            Some(item) if item.what == what => {}
            Some(item) => listed.push(WaitingItem {
                what,
                ..item.clone()
            }),
            None => listed.push(WaitingItem {
                id: new_id(),
                request_id: request_id.clone(),
                source: source.clone(),
                key,
                what,
                created_at_ms: now,
            }),
        }
    }
    let gone = open
        .iter()
        .filter(|item| !named.contains(&item.key))
        .map(|item| item.id.clone())
        .collect();
    (listed, gone)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::work::TaskId;

    fn task_source() -> WaitingSource {
        WaitingSource::Task {
            task_id: TaskId("t1".into()),
        }
    }

    fn lines(items: &[&str]) -> Vec<String> {
        items.iter().map(|line| (*line).to_owned()).collect()
    }

    fn ids() -> impl FnMut() -> String {
        let mut next = 0;
        move || {
            next += 1;
            format!("w{next}")
        }
    }

    #[test]
    fn the_key_ignores_case_punctuation_and_spacing_but_not_the_source() {
        let source = task_source();
        assert_eq!(
            waiting_key(&source, "Set STRIPE_KEY in `.env`."),
            waiting_key(&source, "- set  stripe_key in .env")
        );
        assert_ne!(
            waiting_key(&source, "Set STRIPE_KEY in .env"),
            waiting_key(&WaitingSource::Orchestrator, "Set STRIPE_KEY in .env")
        );
        assert_ne!(
            waiting_key(&source, "Sign in to npm"),
            waiting_key(&source, "Sign in to GitHub")
        );
    }

    #[test]
    fn a_report_lists_each_line_once() {
        let (listed, gone) = report_waits(
            &task_source(),
            &[],
            &lines(&[
                "Set STRIPE_KEY in .env",
                "- set stripe_key in .env.",
                "  ",
                "Push the branch",
            ]),
            Some("r1".into()),
            5,
            ids(),
        );
        assert!(gone.is_empty());
        let what: Vec<&str> = listed.iter().map(|item| item.what.as_str()).collect();
        assert_eq!(what, ["Set STRIPE_KEY in .env", "Push the branch"]);
        assert!(
            listed
                .iter()
                .all(|item| item.request_id.as_deref() == Some("r1"))
        );
        assert_eq!(listed[0].id, "w1");
        assert_eq!(listed[0].created_at_ms, 5);
    }

    #[test]
    fn a_repeat_report_keeps_the_item_and_one_that_drops_it_ends_it() {
        let source = task_source();
        let (open, _) = report_waits(
            &source,
            &[],
            &lines(&["Set STRIPE_KEY in .env", "Push the branch"]),
            None,
            1,
            ids(),
        );
        // The same lines again: nothing new.
        let (listed, gone) = report_waits(
            &source,
            &open,
            &lines(&["Set STRIPE_KEY in .env", "Push the branch"]),
            None,
            2,
            ids(),
        );
        assert!(listed.is_empty() && gone.is_empty());
        // Reworded: the open item is updated in place.
        let (listed, gone) = report_waits(
            &source,
            &open,
            &lines(&["set stripe_key in .env!", "Push the branch"]),
            None,
            2,
            ids(),
        );
        assert!(gone.is_empty());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, open[0].id);
        assert_eq!(listed[0].created_at_ms, 1);
        assert_eq!(listed[0].what, "set stripe_key in .env!");
        // A later report without it: it is over.
        let (listed, gone) =
            report_waits(&source, &open, &lines(&["Push the branch"]), None, 3, ids());
        assert!(listed.is_empty());
        assert_eq!(gone, [open[0].id.clone()]);
        let (_, gone) = report_waits(&source, &open, &[], None, 3, ids());
        assert_eq!(gone.len(), 2);
    }

    #[test]
    fn a_card_item_is_open_only_while_its_card_waits() {
        use crate::work::{Question, QuestionKind};
        let card = CardId("q1".into());
        let mut board = Board::default();
        assert!(!card_open(&board, &card));
        let mut question = Question {
            id: card.clone(),
            conversation_id: ConversationId("c1".into()),
            task_id: None,
            request_id: None,
            position: 0,
            kind: QuestionKind::Orchestrator,
            text: "Which region?".into(),
            options: Vec::new(),
            recommended: None,
            answer: None,
            created_at_ms: 0,
            answered_at_ms: None,
        };
        board.questions.insert(card.clone(), question.clone());
        assert!(card_open(&board, &card));
        question.answer = Some("eu".into());
        board.questions.insert(card.clone(), question);
        assert!(!card_open(&board, &card));
    }

    #[test]
    fn the_board_keeps_open_items_and_every_decision() {
        let item = WaitingItem {
            id: "w1".into(),
            request_id: Some("r1".into()),
            source: WaitingSource::Orchestrator,
            key: waiting_key(&WaitingSource::Orchestrator, "Sign in to npm"),
            what: "Sign in to npm".into(),
            created_at_ms: 1,
        };
        let mut board = Board::default();
        board.apply(&DomainEvent::WaitingOnYou { item: item.clone() }, 3);
        assert_eq!(board.sorted_waiting(), [item]);
        board.apply(
            &DomainEvent::WaitingResolved {
                id: "w1".into(),
                by: ResolvedBy::User,
            },
            4,
        );
        assert!(board.waiting.is_empty());
        board.apply(
            &DomainEvent::DecidedForYou {
                decision: Decision {
                    id: "d1".into(),
                    request_id: None,
                    source: DecisionSource::Orchestrator,
                    what: "Kept the old API".into(),
                    why: String::new(),
                    at_ms: 2,
                    position: 0,
                },
            },
            5,
        );
        assert_eq!(board.decisions.len(), 1);
        assert_eq!(board.decisions[0].position, 5);
    }

    #[test]
    fn stored_events_read_back() {
        let event: DomainEvent = serde_json::from_value(serde_json::json!({
            "type": "decidedForYou",
            "decision": {
                "id": "d1",
                "source": { "type": "task", "taskId": "t1" },
                "what": "Landed task-1",
                "atMs": 1,
            },
        }))
        .expect("a decision");
        let DomainEvent::DecidedForYou { decision } = event else {
            panic!("not a decision");
        };
        assert!(decision.why.is_empty() && decision.request_id.is_none());
        let event: DomainEvent = serde_json::from_value(serde_json::json!({
            "type": "waitingResolved",
            "id": "w1",
            "by": "user",
        }))
        .expect("a resolution");
        assert_eq!(event.kind(), "waiting.resolved");
    }
}
