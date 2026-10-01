//! The stall watchdog (built in, always on): work that stopped moving is moved on, and the
//! user hears what only they can unblock.
//!
//! - **Silent workers.** Only a worker mid-turn is watched: its task starting or running, a
//!   turn under way in a CLI that is attached, and nothing it waits for (its question to the
//!   orchestrator, a permission card, quota). Reported, reviewing, ready-to-land, paused,
//!   blocked, hibernated and stopping workers are never touched; gate members (reviewers and
//!   verifiers) are workers like any other while they run. Silence is measured from the
//!   worker's last event, or the start of its turn.
//!   - Silent for [`Timing::silent`] (or [`Timing::command`] while one of its commands or
//!     tool calls runs): it is nudged, a steer asking it to carry on or report.
//!   - Still silent [`Timing::after_nudge`] later: it continues in a fresh session of the
//!     same model with its hand-off ([`super::worker_handoff`]), its stuck turn closed.
//!   - Stalled again in the same attempt: another model takes the task over
//!     (`ErrorKind::Stalled`, which counts toward the error hand-offs' cap).
//! - **Dead workers.** A running task whose CLI is gone or no longer runs (for
//!   [`Timing::grace`], and nothing is handing it on) is handed to another model at once.
//! - **Stuck gates.** A round whose members all have a result but that was never decided is
//!   decided; a member that ended without recording its result has it recorded.
//! - **Stuck cards.** A card the user left unanswered for [`Timing::card`] is listed under
//!   "Waiting on you" (over when the card is answered or expires), with one desktop
//!   notification.
//!
//! Each action is checked against the CLI session it was decided for, so a session that
//! moved on meanwhile is never closed, and each is logged under "Decided for you". A debug
//! build scales every threshold with `BRIGADIER_STALL_SECS` (the silence before a nudge, in
//! seconds), so the watchdog can be tried live.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use brigadier_providers::{ErrorKind, NoticeLevel, ProviderEvent};

use super::SessionManager;
use super::worker_handoff::Handover;
use super::workers::TaskLive;
use crate::board::Board;
use crate::model::{ConversationId, Lifecycle};
use crate::now_ms;
use crate::work::{
    ApprovalSubject, AttemptEnd, CardId, CardState, Gate, GateOwner, PlanState, QuestionKind, Task,
    TaskId, TaskState, WaitingSource,
};

/// The silence before a nudge, in seconds; every other threshold follows from it.
const UNIT_SECS: u64 = 10 * 60;

/// How long things may stay still before the watchdog acts, in ms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Timing {
    /// A worker mid-turn silent this long is nudged.
    pub silent: i64,
    /// … this long while one of its commands or tool calls runs.
    pub command: i64,
    /// Still silent this long after the nudge: a fresh session.
    pub after_nudge: i64,
    /// A card unanswered this long waits on the user.
    pub card: i64,
    /// What a hand-off or a result being recorded may take before a task without a running
    /// CLI, or a member that ended without its result, counts as stuck.
    pub grace: i64,
    /// How often the watchdog looks.
    pub tick: Duration,
}

impl Timing {
    /// The thresholds in force: 10 minutes of silence (40 while a command runs), 10 more after
    /// the nudge, 30 for a card. A debug build takes `BRIGADIER_STALL_SECS` instead of the
    /// 10 minutes.
    pub(crate) fn current() -> Self {
        if cfg!(debug_assertions)
            && let Some(secs) = std::env::var("BRIGADIER_STALL_SECS")
                .ok()
                .and_then(|value| value.trim().parse::<u64>().ok())
                .filter(|secs| *secs > 0)
        {
            return Self::scaled(secs);
        }
        Self::scaled(UNIT_SECS)
    }

    fn scaled(unit_secs: u64) -> Self {
        let unit = i64::try_from(unit_secs.min(24 * 60 * 60)).unwrap_or(0) * 1_000;
        let tick = u64::try_from(unit / 4).unwrap_or(0).clamp(5_000, 60_000);
        Self {
            silent: unit,
            command: unit * 4,
            after_nudge: unit,
            card: unit * 3,
            grace: (unit / 5).max(1_000),
            tick: Duration::from_millis(tick),
        }
    }
}

/// What the watchdog knows of a task's live worker ([`TaskLive::watch`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct WorkerWatch {
    /// The CLI session at work ([`TaskLive::generation`]).
    pub generation: u64,
    /// A CLI is attached and its process runs.
    pub alive: bool,
    /// A turn is under way.
    pub busy: bool,
    /// Its CLI is being closed on purpose (a stop, a hand-off).
    pub stopping: bool,
    /// It waits on its question to the orchestrator.
    pub question: bool,
    /// One of its commands or tool calls runs.
    pub command_running: bool,
    pub last_event_ms: i64,
    /// When the watchdog nudged this CLI session.
    pub nudged_at_ms: Option<i64>,
    /// Fresh sessions the watchdog started for stalls in the current attempt.
    pub stalls: u32,
    /// Since when the task is live without a running CLI.
    pub orphaned_at_ms: Option<i64>,
    /// Nothing is routing it again or handing it over right now.
    pub reroute_free: bool,
}

/// What the watchdog does about a worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StallVerdict {
    /// Ask it whether it is stuck (a steer).
    Nudge,
    /// Continue in a fresh session of the same model.
    HandOver,
    /// Hand the task to another model.
    Replace(Replaced),
}

/// Why another model takes a task over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Replaced {
    /// Its CLI is gone, or no longer runs.
    Exited,
    /// It stalled again after a fresh session.
    Stalled,
}

/// What to do about the worker of a task in `state` (`quota_wait`: it waits for quota;
/// `card_open`: a permission card of it waits for the user), as `watch` saw it at `now`.
pub(crate) fn stall_verdict(
    state: TaskState,
    quota_wait: bool,
    card_open: bool,
    watch: &WorkerWatch,
    timing: &Timing,
    now: i64,
) -> Option<StallVerdict> {
    if !matches!(state, TaskState::Starting | TaskState::Running) || quota_wait || watch.stopping {
        return None;
    }
    if !watch.alive {
        // A starting task is still getting its CLI; a running one lost it.
        let lost = state == TaskState::Running
            && watch.reroute_free
            && watch
                .orphaned_at_ms
                .is_some_and(|since| now - since >= timing.grace);
        return lost.then_some(StallVerdict::Replace(Replaced::Exited));
    }
    if !watch.busy || watch.question || card_open {
        return None;
    }
    // A nudge counts until the worker shows it works again.
    if let Some(nudged) = watch
        .nudged_at_ms
        .filter(|nudged| *nudged >= watch.last_event_ms)
    {
        if now - nudged < timing.after_nudge {
            return None;
        }
        return Some(if watch.stalls > 0 {
            StallVerdict::Replace(Replaced::Stalled)
        } else {
            StallVerdict::HandOver
        });
    }
    let quiet = if watch.command_running {
        timing.command
    } else {
        timing.silent
    };
    (now - watch.last_event_ms >= quiet).then_some(StallVerdict::Nudge)
}

/// What is wrong with a gate round nobody decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GateStuck {
    /// Every member has a result.
    Undecided,
    /// These members ended (at least `grace` ago) without their result.
    Lost(Vec<TaskId>),
}

/// Whether `gate`, still waited on, is stuck at `now`, its members found in `tasks`.
pub(crate) fn gate_stuck(
    gate: &Gate,
    tasks: &HashMap<TaskId, Task>,
    now: i64,
    grace: i64,
) -> Option<GateStuck> {
    if gate.outcome.is_some() || gate.members.is_empty() {
        return None;
    }
    let lost: Vec<TaskId> = gate
        .members
        .iter()
        .filter(|member| member.result.is_none())
        .map(|member| member.task_id.clone())
        .collect();
    if lost.is_empty() {
        return Some(GateStuck::Undecided);
    }
    let lost: Vec<TaskId> = lost
        .into_iter()
        .filter(|id| {
            tasks
                .get(id)
                .is_some_and(|task| task.state.is_final() && now - task.updated_at_ms >= grace)
        })
        .collect();
    (!lost.is_empty()).then_some(GateStuck::Lost(lost))
}

/// A card the user left unanswered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StuckCard {
    pub card_id: CardId,
    pub request_id: Option<String>,
    /// What the user is to do, in plain words.
    pub what: String,
}

/// The cards of `board` unanswered for `after` at `now` that were never listed for the user
/// (once they mark one done, it isn't listed again).
pub(crate) fn stuck_cards(board: &Board, now: i64, after: i64) -> Vec<StuckCard> {
    let listed = |card: &CardId| {
        let prefix = format!("card:{card}|");
        board
            .waits_listed
            .iter()
            .any(|key| key.starts_with(&prefix))
    };
    let old = |created: i64| now - created >= after;
    let task_name = |task: &Option<TaskId>| {
        task.as_ref()
            .and_then(|id| board.tasks.get(id))
            .map_or_else(|| "a worker".to_owned(), |t| format!("task-{}", t.number))
    };
    let mut stuck = Vec::new();
    for approval in board.approvals.values() {
        if approval.state != CardState::Pending
            || !old(approval.created_at_ms)
            || listed(&approval.id)
        {
            continue;
        }
        let what = match &approval.subject {
            ApprovalSubject::Cli { request } => format!(
                "Allow or decline what {} asked for: {}",
                task_name(&approval.task_id),
                request.command.as_deref().unwrap_or(&request.tool)
            ),
            ApprovalSubject::OutwardCommand { argv, .. } => {
                format!("Allow or decline the command: {}", argv.join(" "))
            }
            ApprovalSubject::Landing { task_id, .. } => format!(
                "Approve or decline landing {}",
                task_name(&Some(task_id.clone()))
            ),
            ApprovalSubject::FinishSession { branch, base, .. } => {
                format!("Approve or decline merging {branch} into {base}")
            }
            ApprovalSubject::Action { action, .. } => format!("Approve or decline: {action}"),
        };
        stuck.push(StuckCard {
            card_id: approval.id.clone(),
            request_id: approval.request_id.clone(),
            what,
        });
    }
    for question in board.questions.values() {
        if question.answer.is_some()
            || question.answered_at_ms.is_some()
            || !old(question.created_at_ms)
            || listed(&question.id)
        {
            continue;
        }
        let what = match &question.kind {
            QuestionKind::Orchestrator => format!("Answer the question: {}", question.text),
            QuestionKind::UncommittedChanges { .. } => {
                "Answer whether workers see your uncommitted changes".to_owned()
            }
        };
        stuck.push(StuckCard {
            card_id: question.id.clone(),
            request_id: question.request_id.clone(),
            what,
        });
    }
    // A plan in review waits for its reviewers, not the user.
    for plan in board.plans.values() {
        if plan.state != PlanState::Proposed || !old(plan.created_at_ms) || listed(&plan.id) {
            continue;
        }
        stuck.push(StuckCard {
            card_id: plan.id.clone(),
            request_id: plan.request_id.clone(),
            what: format!("Approve or decline the plan \u{201c}{}\u{201d}", plan.title),
        });
    }
    stuck.sort_by(|a, b| a.card_id.0.cmp(&b.card_id.0));
    stuck
}

/// A duration as people say it ("10 minutes", "45 seconds").
pub(crate) fn spoken(ms: i64) -> String {
    let secs = (ms / 1_000).max(0);
    let (n, unit) = if secs < 60 {
        (secs, "second")
    } else {
        ((secs + 30) / 60, "minute")
    };
    format!("{n} {unit}{}", if n == 1 { "" } else { "s" })
}

impl SessionManager {
    /// Starts the watchdog's rounds.
    pub(super) fn start_watchdog(&self) {
        let manager = self.me.clone();
        let timing = Timing::current();
        self.spawn(async move {
            let mut tick = tokio::time::interval(timing.tick);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            tick.tick().await;
            loop {
                tick.tick().await;
                let Some(manager) = manager.upgrade() else {
                    return;
                };
                if manager.admit().is_err() {
                    return;
                }
                manager.watch(&timing).await;
            }
        });
    }

    /// One round: the live conversations' workers, gates and cards.
    async fn watch(&self, timing: &Timing) {
        let lives: Vec<Arc<TaskLive>> = self.tasks_lock().values().cloned().collect();
        let mut conversations: HashSet<ConversationId> =
            self.convs_lock().keys().cloned().collect();
        conversations.extend(lives.iter().map(|live| live.conversation_id.clone()));
        for conversation_id in conversations {
            if self
                .core
                .conversation(&conversation_id)
                .is_ok_and(|conversation| conversation.lifecycle == Lifecycle::Archived)
            {
                continue;
            }
            let Ok(board) = self.core.board(&conversation_id).await else {
                continue;
            };
            let now = now_ms();
            for live in lives
                .iter()
                .filter(|live| live.conversation_id == conversation_id)
            {
                if let Some(task) = board.tasks.get(&live.id) {
                    self.watch_worker(live, task, &board, timing, now).await;
                }
            }
            self.watch_gates(&board, timing, now).await;
            self.watch_cards(&conversation_id, &board, timing, now)
                .await;
        }
    }

    /// Acts on a worker that stopped moving.
    async fn watch_worker(
        &self,
        live: &Arc<TaskLive>,
        task: &Task,
        board: &Board,
        timing: &Timing,
        now: i64,
    ) {
        if task.state.is_final() {
            return;
        }
        let card_open = board.approvals.values().any(|approval| {
            approval.task_id.as_ref() == Some(&task.id) && approval.state == CardState::Pending
        });
        let watch = live.watch(now).await;
        let Some(verdict) = stall_verdict(
            task.state,
            task.quota_wait.is_some(),
            card_open,
            &watch,
            timing,
            now,
        ) else {
            return;
        };
        let silent = now - watch.last_event_ms;
        let n = task.number;
        match verdict {
            StallVerdict::Nudge => {
                let text = format!(
                    "[Brigadier] Nothing has come from you for {}. If a command is hanging, stop it and run it again with a timeout, or in the background. If you are stuck, say why in submit_report. Otherwise carry on.",
                    spoken(silent)
                );
                if !live.nudge_stall(watch.generation, text).await {
                    return;
                }
                tracing::info!(task = %task.id, silent, "nudged a silent worker");
                self.watchdog_notice(
                    task,
                    format!(
                        "No activity for {}: asked the worker to carry on or report.",
                        spoken(silent)
                    ),
                )
                .await;
                self.decided_for_task(
                    task,
                    format!("Nudged task-{n}: no activity for {}", spoken(silent)),
                    "A worker silent this long is usually stuck on a command; it was asked to carry on or report what stops it.".into(),
                )
                .await;
            }
            StallVerdict::HandOver => {
                if !live.claim_stall(watch.generation).await {
                    return;
                }
                tracing::info!(task = %task.id, silent, "a silent worker continues in a fresh session");
                self.watchdog_notice(
                    task,
                    format!(
                        "Still no activity after the nudge ({} in all): a fresh session takes over.",
                        spoken(silent)
                    ),
                )
                .await;
                self.decided_for_task(
                    task,
                    format!("Restarted task-{n} in a fresh session: it stayed silent after a nudge"),
                    format!(
                        "It had shown no activity for {}. The same model continues from its hand-off, with its changes kept.",
                        spoken(silent)
                    ),
                )
                .await;
                let manager = self.arc();
                let (live, task) = (live.clone(), task.clone());
                let from = watch.generation;
                self.spawn(async move {
                    if let Err(err) = manager
                        .hand_over_worker(
                            &live,
                            &task,
                            from,
                            None,
                            None,
                            Handover::Stalled { silent },
                        )
                        .await
                    {
                        let reason = format!("The task could not continue after it stalled: {err}");
                        manager.worker_failed(&task, &reason).await;
                    }
                });
            }
            StallVerdict::Replace(why) => {
                let Some(cutoff) = live.claim_replace(watch.generation).await else {
                    return;
                };
                let (end, what, because) = match why {
                    Replaced::Stalled => (
                        AttemptEnd::Error {
                            kind: ErrorKind::Stalled,
                            message: format!(
                                "The worker went silent for {} again after a fresh session.",
                                spoken(silent)
                            ),
                        },
                        format!("Gave task-{n} to another model: it stalled twice"),
                        "It went silent again after a nudge and a fresh session of the same model.",
                    ),
                    Replaced::Exited => (
                        AttemptEnd::Error {
                            kind: ErrorKind::Process,
                            message: "The worker's CLI stopped running before it reported.".into(),
                        },
                        format!("Gave task-{n} to another model: its CLI had stopped"),
                        "Its CLI stopped running before it reported.",
                    ),
                };
                tracing::info!(task = %task.id, ?why, "handing a stuck task to another model");
                self.watchdog_notice(task, format!("{because} Another model takes over."))
                    .await;
                self.decided_for_task(task, what, because.into()).await;
                let manager = self.arc();
                let live = live.clone();
                // A model cut off meanwhile hands on for that.
                let end = cutoff.unwrap_or(end);
                self.spawn(async move { manager.hand_off(&live, end).await });
            }
        }
    }

    /// Records a watchdog action in the task's transcript.
    async fn watchdog_notice(&self, task: &Task, message: String) {
        self.record_worker_event(
            &task.id,
            ProviderEvent::Notice {
                level: NoticeLevel::Warning,
                message,
            },
        )
        .await;
    }

    /// Settles gate rounds whose members all ended without the round being decided.
    async fn watch_gates(&self, board: &Board, timing: &Timing, now: i64) {
        let rounds = board
            .tasks
            .values()
            .filter(|task| task.state == TaskState::Reviewing)
            .filter_map(|task| task.gate.as_ref().map(|gate| (Some(task), gate)))
            .chain(
                board
                    .plans
                    .values()
                    .filter(|plan| {
                        matches!(plan.state, PlanState::Proposed | PlanState::InReview { .. })
                    })
                    .filter_map(|plan| plan.gate.as_ref().map(|gate| (None, gate))),
            );
        for (owner, gate) in rounds {
            match gate_stuck(gate, &board.tasks, now, timing.grace) {
                Some(GateStuck::Undecided) => {
                    // Plan rounds are decided with their last result, in one write.
                    let Some(task) = owner else {
                        continue;
                    };
                    if self.resettle_gate(task).await {
                        tracing::info!(task = %task.id, round = gate.round, "settled a gate round left undecided");
                        self.decided_for_task(
                            task,
                            format!(
                                "Acted on the checks of task-{}: they had all finished",
                                task.number
                            ),
                            "Every check had a result, but the round was never decided.".into(),
                        )
                        .await;
                    }
                }
                Some(GateStuck::Lost(members)) => {
                    for id in members {
                        let Some(member) = board.tasks.get(&id) else {
                            continue;
                        };
                        tracing::info!(member = %member.id, "recording the result of a gate member that ended without it");
                        if member.report.is_some() && member.state == TaskState::Done {
                            self.gate_member_reported(member).await;
                        } else {
                            self.gate_member_failed(member, "it ended without a result")
                                .await;
                        }
                        let of = match &member.gate_link.as_ref().map(|link| &link.owner) {
                            Some(GateOwner::Task { task_id }) => board
                                .tasks
                                .get(task_id)
                                .map(|t| format!("task-{}", t.number)),
                            Some(GateOwner::Plan { plan_id }) => board
                                .plans
                                .get(plan_id)
                                .map(|p| format!("the plan \u{201c}{}\u{201d}", p.title)),
                            None => None,
                        }
                        .unwrap_or_else(|| "a change".into());
                        self.decided_for_task(
                            member,
                            format!(
                                "Counted the result of task-{}, a check of {of}",
                                member.number
                            ),
                            "It had ended, but its result never reached the round, which waited for it.".into(),
                        )
                        .await;
                    }
                }
                None => {}
            }
        }
    }

    /// Lists the cards the user left unanswered for long under "Waiting on you", each with
    /// one desktop notification.
    async fn watch_cards(
        &self,
        conversation_id: &ConversationId,
        board: &Board,
        timing: &Timing,
        now: i64,
    ) {
        for card in stuck_cards(board, now, timing.card) {
            let added = self
                .wait_on_user(
                    conversation_id,
                    card.request_id.clone(),
                    WaitingSource::Card {
                        card_id: card.card_id.clone(),
                    },
                    &card.what,
                )
                .await;
            match added {
                Ok(true) => {
                    tracing::info!(conversation = %conversation_id, card = %card.card_id, "a card waits on the user");
                    notify_desktop("Brigadier is waiting for you", &card.what);
                }
                Ok(false) => {}
                Err(err) => {
                    tracing::warn!(conversation = %conversation_id, error = %err, "could not list a card for the user");
                }
            }
        }
    }
}

/// Shows a desktop notification, best effort (macOS and Linux desktops).
fn notify_desktop(title: &str, body: &str) {
    if cfg!(test) {
        return;
    }
    let (title, body) = (title.to_owned(), body.to_owned());
    std::thread::spawn(move || {
        let shown = show_notification(&title, &body);
        if let Err(err) = shown {
            tracing::debug!(error = %err, "could not show a desktop notification");
        }
    });
}

#[cfg(target_os = "macos")]
fn show_notification(title: &str, body: &str) -> std::io::Result<()> {
    let quote = |text: &str| text.replace('\\', "\\\\").replace('"', "\\\"");
    std::process::Command::new("/usr/bin/osascript")
        .args([
            "-e",
            &format!(
                "display notification \"{}\" with title \"{}\"",
                quote(body),
                quote(title)
            ),
        ])
        .output()
        .map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn show_notification(title: &str, body: &str) -> std::io::Result<()> {
    std::process::Command::new("notify-send")
        .args(["--app-name=Brigadier", title, body])
        .output()
        .map(|_| ())
}

#[cfg(not(unix))]
fn show_notification(_title: &str, _body: &str) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::work::{GateMember, GateResult, GateRole};

    const MIN: i64 = 60_000;

    fn timing() -> Timing {
        Timing::scaled(UNIT_SECS)
    }

    /// A worker mid-turn, last heard from at 0.
    fn working() -> WorkerWatch {
        WorkerWatch {
            generation: 1,
            alive: true,
            busy: true,
            reroute_free: true,
            ..WorkerWatch::default()
        }
    }

    fn verdict(state: TaskState, watch: &WorkerWatch, now: i64) -> Option<StallVerdict> {
        stall_verdict(state, false, false, watch, &timing(), now)
    }

    #[test]
    fn the_thresholds_scale_with_one_unit() {
        let t = timing();
        assert_eq!(
            (t.silent, t.command, t.after_nudge, t.card),
            (10 * MIN, 40 * MIN, 10 * MIN, 30 * MIN)
        );
        assert_eq!(t.grace, 2 * MIN);
        assert_eq!(t.tick, Duration::from_secs(60));
        let fast = Timing::scaled(60);
        assert_eq!(
            (fast.silent, fast.command, fast.card, fast.grace),
            (MIN, 4 * MIN, 3 * MIN, 12_000)
        );
        assert_eq!(fast.tick, Duration::from_secs(15));
        assert_eq!(Timing::scaled(1).tick, Duration::from_secs(5));
    }

    #[test]
    fn a_silent_worker_is_nudged_then_handed_over_then_replaced() {
        let mut watch = working();
        assert_eq!(verdict(TaskState::Running, &watch, 9 * MIN), None);
        assert_eq!(
            verdict(TaskState::Running, &watch, 10 * MIN),
            Some(StallVerdict::Nudge)
        );
        assert_eq!(
            verdict(TaskState::Starting, &watch, 10 * MIN),
            Some(StallVerdict::Nudge)
        );
        // Nudged at 10: nothing until 10 minutes later, then a fresh session.
        watch.nudged_at_ms = Some(10 * MIN);
        assert_eq!(verdict(TaskState::Running, &watch, 19 * MIN), None);
        assert_eq!(
            verdict(TaskState::Running, &watch, 20 * MIN),
            Some(StallVerdict::HandOver)
        );
        // A second stall in the same attempt: another model.
        watch.stalls = 1;
        assert_eq!(
            verdict(TaskState::Running, &watch, 20 * MIN),
            Some(StallVerdict::Replace(Replaced::Stalled))
        );
    }

    #[test]
    fn a_worker_that_answers_the_nudge_starts_over() {
        let mut watch = working();
        watch.nudged_at_ms = Some(10 * MIN);
        watch.last_event_ms = 12 * MIN;
        assert_eq!(verdict(TaskState::Running, &watch, 21 * MIN), None);
        assert_eq!(
            verdict(TaskState::Running, &watch, 22 * MIN),
            Some(StallVerdict::Nudge)
        );
    }

    #[test]
    fn a_running_command_gets_longer() {
        let mut watch = working();
        watch.command_running = true;
        assert_eq!(verdict(TaskState::Running, &watch, 39 * MIN), None);
        assert_eq!(
            verdict(TaskState::Running, &watch, 40 * MIN),
            Some(StallVerdict::Nudge)
        );
    }

    #[test]
    fn only_active_busy_turns_are_watched() {
        let late = 3 * 60 * MIN;
        let watch = working();
        for state in [
            TaskState::Queued,
            TaskState::Blocked,
            TaskState::Paused,
            TaskState::Reported,
            TaskState::Reviewing,
            TaskState::AwaitingApproval,
            TaskState::ReadyToLand,
            TaskState::Landed,
            TaskState::Done,
            TaskState::Stopped,
            TaskState::Failed,
        ] {
            assert_eq!(verdict(state, &watch, late), None, "{state:?}");
        }
        // Between turns (a reported worker waiting idle).
        let idle = WorkerWatch {
            busy: false,
            ..working()
        };
        assert_eq!(verdict(TaskState::Running, &idle, late), None);
        // Asked the orchestrator, or waiting on a permission card.
        let asking = WorkerWatch {
            question: true,
            ..working()
        };
        assert_eq!(verdict(TaskState::Running, &asking, late), None);
        let t = timing();
        assert_eq!(
            stall_verdict(TaskState::Running, false, true, &watch, &t, late),
            None
        );
        // Waiting for quota.
        assert_eq!(
            stall_verdict(TaskState::Running, true, false, &watch, &t, late),
            None
        );
        // Being stopped or handed on.
        let stopping = WorkerWatch {
            stopping: true,
            ..working()
        };
        assert_eq!(verdict(TaskState::Running, &stopping, late), None);
        // Hibernated: no CLI, and not running.
        let hibernated = WorkerWatch {
            alive: false,
            busy: false,
            orphaned_at_ms: Some(0),
            ..working()
        };
        assert_eq!(verdict(TaskState::Reported, &hibernated, late), None);
    }

    #[test]
    fn a_running_task_without_its_cli_is_replaced_after_the_grace() {
        let gone = WorkerWatch {
            alive: false,
            orphaned_at_ms: Some(0),
            ..working()
        };
        assert_eq!(verdict(TaskState::Running, &gone, MIN), None);
        assert_eq!(
            verdict(TaskState::Running, &gone, 2 * MIN),
            Some(StallVerdict::Replace(Replaced::Exited))
        );
        // Still starting, or being routed again meanwhile.
        assert_eq!(verdict(TaskState::Starting, &gone, 60 * MIN), None);
        let rerouting = WorkerWatch {
            reroute_free: false,
            ..gone.clone()
        };
        assert_eq!(verdict(TaskState::Running, &rerouting, 60 * MIN), None);
        // Not yet seen without it.
        let unseen = WorkerWatch {
            orphaned_at_ms: None,
            ..gone
        };
        assert_eq!(verdict(TaskState::Running, &unseen, 60 * MIN), None);
    }

    fn task(id: &str, number: u32, state: TaskState, updated: i64) -> Task {
        let mut task: Task = serde_json::from_value(serde_json::json!({
            "id": id,
            "conversationId": "c1",
            "number": number,
            "position": 0,
            "title": "Check the change",
            "kind": "verify",
            "spec": "Verify it.",
            "access": { "repo": "read", "network": false, "unsandboxed": false },
            "route": { "choice": { "provider": "codex", "model": null, "effort": null }, "reason": "" },
            "state": "running",
            "attachments": [],
            "createdAtMs": 0,
            "updatedAtMs": 0
        }))
        .expect("a task");
        task.state = state;
        task.updated_at_ms = updated;
        task
    }

    fn member(id: &str, result: Option<GateResult>) -> GateMember {
        GateMember {
            task_id: TaskId(id.into()),
            role: GateRole::Verify,
            result,
            avoid: Vec::new(),
        }
    }

    fn gate(members: Vec<GateMember>) -> Gate {
        Gate {
            round: 1,
            commit: Some("c1".into()),
            members,
            outcome: None,
            relanding: false,
            retry: false,
            findings: Vec::new(),
        }
    }

    #[test]
    fn a_round_with_every_result_but_no_outcome_is_undecided() {
        let tasks = HashMap::new();
        let full = gate(vec![
            member("m1", Some(GateResult::Passed)),
            member("m2", Some(GateResult::Passed)),
        ]);
        assert_eq!(
            gate_stuck(&full, &tasks, 0, MIN),
            Some(GateStuck::Undecided)
        );
        let mut decided = full;
        decided.outcome = Some(crate::work::GateOutcome::Passed);
        assert_eq!(gate_stuck(&decided, &tasks, 0, MIN), None);
        assert_eq!(gate_stuck(&gate(Vec::new()), &tasks, 0, MIN), None);
    }

    #[test]
    fn a_member_that_ended_without_its_result_is_lost_after_the_grace() {
        let mut tasks = HashMap::new();
        for t in [
            task("m1", 2, TaskState::Done, 0),
            task("m2", 3, TaskState::Running, 0),
            task("m3", 4, TaskState::Failed, 5 * MIN),
        ] {
            tasks.insert(t.id.clone(), t);
        }
        let round = gate(vec![
            member("m1", None),
            member("m2", None),
            member("m3", None),
            member("m4", Some(GateResult::Passed)),
        ]);
        // m2 still runs; m3 ended too recently.
        assert_eq!(
            gate_stuck(&round, &tasks, 6 * MIN, 2 * MIN),
            Some(GateStuck::Lost(vec![TaskId("m1".into())]))
        );
        assert_eq!(
            gate_stuck(&round, &tasks, 7 * MIN, 2 * MIN),
            Some(GateStuck::Lost(vec![
                TaskId("m1".into()),
                TaskId("m3".into())
            ]))
        );
        // Every member without a result still runs: nothing is stuck.
        let running = gate(vec![member("m2", None)]);
        assert_eq!(gate_stuck(&running, &tasks, 60 * MIN, 2 * MIN), None);
    }

    fn approval(id: &str, created: i64, state: CardState) -> crate::work::Approval {
        crate::work::Approval {
            id: CardId(id.into()),
            conversation_id: ConversationId("c1".into()),
            task_id: None,
            request_id: Some("r1".into()),
            position: 0,
            subject: ApprovalSubject::Action {
                action: "Deploy to staging".into(),
                details: String::new(),
            },
            state,
            created_at_ms: created,
            resolved_at_ms: None,
        }
    }

    #[test]
    fn a_card_waits_on_the_user_once_after_half_an_hour() {
        let mut board = Board::default();
        for card in [
            approval("a1", 0, CardState::Pending),
            approval("a2", 10 * MIN, CardState::Pending),
            approval(
                "a3",
                0,
                CardState::Expired {
                    reason: "The task ended".into(),
                },
            ),
        ] {
            board.approvals.insert(card.id.clone(), card);
        }
        let stuck = stuck_cards(&board, 30 * MIN, 30 * MIN);
        assert_eq!(
            stuck,
            [StuckCard {
                card_id: CardId("a1".into()),
                request_id: Some("r1".into()),
                what: "Approve or decline: Deploy to staging".into(),
            }]
        );
        // Listed once (and marked done by the user since): never again.
        let source = WaitingSource::Card {
            card_id: CardId("a1".into()),
        };
        board
            .waits_listed
            .insert(super::super::decisions::waiting_key(
                &source,
                &stuck[0].what,
            ));
        assert!(stuck_cards(&board, 31 * MIN, 30 * MIN).is_empty());
        // a2 is half an hour old by then.
        let later = stuck_cards(&board, 40 * MIN, 30 * MIN);
        assert_eq!(later.len(), 1);
        assert_eq!(later[0].card_id, CardId("a2".into()));
    }

    #[test]
    fn durations_read_as_people_say_them() {
        assert_eq!(spoken(45_000), "45 seconds");
        assert_eq!(spoken(60_000), "1 minute");
        assert_eq!(spoken(100_000), "2 minutes");
        assert_eq!(spoken(10 * MIN), "10 minutes");
        assert_eq!(spoken(2 * MIN), "2 minutes");
        assert_eq!(spoken(1_000), "1 second");
    }
}
