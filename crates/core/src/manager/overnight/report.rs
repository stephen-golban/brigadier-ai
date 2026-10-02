//! The morning report (PLAN.md §10.11): one message at the end of the run, rendered from the
//! run's records, never from a model's memory of it. Its first three lines say the outcome,
//! where the work is and what waits on the user; then each phase with every criterion and its
//! evidence, the commits (which are verified, which are partial work), what was decided for the
//! user, what waits on them, and what went wrong or was cut short.
//!
//! It is written once: its message has a stable id per run segment, looked for before it is
//! appended, and the run records it after. A crash in between finds the message on recovery
//! and only records it. The notification the report comes with is queued on the run at the
//! same time; the app delivers it as Brigadier and acknowledges it.

use super::super::{SessionManager, blocking, git_error};
use crate::board::Board;
use crate::model::{DomainEvent, Setup};
use crate::now_ms;
use crate::overnight::{
    CriterionStatus, Deadline, OvernightPhase, OvernightRun, PhaseState, RunNotification,
    StopReason,
};
use crate::work::{DecisionSource, RequestState, UserRequest, WaitingSource};

/// Commits listed in the report, at most.
const COMMITS: usize = 60;

impl SessionManager {
    /// Writes the run's report into its conversation, once, and queues its notification.
    pub(crate) async fn write_run_report(&self, run: &OvernightRun) {
        let _held = self.overnight.reporting.lock().await;
        let id = &run.conversation_id;
        let board = match self.core.board(id).await {
            Ok(board) => board,
            Err(err) => {
                tracing::warn!(run = %run.id, error = %err, "could not read the run for its report");
                return;
            }
        };
        let Some(run) = board.runs.get(&run.id) else {
            return;
        };
        if run.report_message_id.is_some() {
            return;
        }
        let message_id = format!("run-report-{}", run.id);
        // Search every branch, including messages older than the active thread's page. A
        // crash after append must not duplicate the report after a branch switch.
        let written = match self.core.all_messages(id).await {
            Ok(messages) => messages
                .into_iter()
                .find(|message| message.id == message_id),
            Err(err) => {
                tracing::warn!(run = %run.id, error = %err, "could not reconcile the report");
                return;
            }
        };
        let commits = self.run_commits(run).await;
        let mut text = render(run, &board, &commits);
        text.push_str(&self.run_usage(run, &board).await);
        if let Some(message) = &written {
            // Reconciliation uses the text already posted, not newly rendered facts.
            text = self.full_text(message).await;
        }
        let outcome: Vec<String> = text.split("\n\n").take(3).map(str::to_owned).collect();
        let outcome: Option<[String; 3]> = outcome.try_into().ok();
        if written.is_none() {
            let request_id = format!("run-{}-report", run.id.short());
            let now = now_ms();
            let request = self
                .core
                .record_conversation(
                    id,
                    vec![DomainEvent::RequestUpdated {
                        request: UserRequest {
                            id: request_id.clone(),
                            conversation_id: id.clone(),
                            preview: format!("Overnight report · {}", run.name),
                            state: RequestState::Done,
                            started_at_ms: now,
                            ended_at_ms: Some(now),
                            steered_into: None,
                            steered_after: None,
                            undo: None,
                        },
                    }],
                )
                .await;
            if let Err(err) = request {
                tracing::warn!(run = %run.id, error = %err, "could not file the run's report");
                return;
            }
            if let Err(err) = self
                .core
                .append_assistant_message(
                    id.clone(),
                    message_id.clone(),
                    text.clone(),
                    None,
                    Some(request_id),
                )
                .await
            {
                tracing::warn!(run = %run.id, error = %err, "could not write the run's report");
                return;
            }
        }
        let notification = RunNotification {
            id: format!("run-notice-{}", run.id),
            title: notification_title(run),
            body: notification_body(run, &board),
            created_at_ms: now_ms(),
            delivered_at_ms: None,
            delivery_error: None,
        };
        let _change = self.overnight.changes.lock().await;
        let Ok(board) = self.core.board(id).await else {
            return;
        };
        let Some(mut now) = board.runs.get(&run.id).cloned() else {
            return;
        };
        if now.generation != run.generation || now.report_message_id.is_some() {
            return;
        }
        now.report_message_id = Some(message_id);
        now.report_outcome = outcome;
        if now.notification.is_none() {
            now.notification = Some(notification);
        }
        if let Err(err) = self.record_run(&now).await {
            tracing::warn!(run = %run.id, error = %err, "could not record the report/outbox; will reconcile it");
        }
    }

    /// Provider-separated observed usage. Window percentages are account snapshots, not
    /// this run's bill. Only turns belonging to this segment's tasks/lead are counted.
    async fn run_usage(&self, run: &OvernightRun, board: &Board) -> String {
        let mut text = String::from("\n### Provider usage\n");
        let start = run.started_at_ms.unwrap_or(run.created_at_ms);
        let end = run.finished_at_ms.unwrap_or_else(now_ms);
        for provider in brigadier_providers::ProviderKind::ALL {
            let turns = match self.runtime.routing_store() {
                Some(store) => store.turns_since(provider, start).await.ok(),
                None => None,
            };
            let Some(turns) = turns else {
                text.push_str(&format!(
                    "- {}: usage records unavailable.\n",
                    provider.label()
                ));
                continue;
            };
            let mut tokens = 0;
            let mut counted = 0;
            for turn in turns.into_iter().filter(|turn| turn.at_ms <= end) {
                let belongs = match turn.task_id.as_ref() {
                    Some(task_id) => board.tasks.values().any(|task| {
                        &task.id.0 == task_id
                            && task
                                .run
                                .as_ref()
                                .is_some_and(|context| context.run_id == run.id)
                    }),
                    None => turn.conversation_id.as_deref() == Some(run.conversation_id.0.as_str()),
                };
                if belongs {
                    tokens += turn.input + turn.cached_input + turn.cache_write + turn.output;
                    counted += 1;
                }
            }
            text.push_str(&format!(
                "- {}: {tokens} recorded tokens in {counted} turns (including cached input).\n",
                provider.label()
            ));
        }
        if let Ok(view) = self.usage_view(None).await {
            text.push_str("Account windows at report time (include other activity):\n");
            for provider in view.providers {
                if let Some(quota) = provider.quota {
                    for window in quota.windows {
                        text.push_str(&format!(
                            "- {} · {}: {:.1}% used; reset {}.\n",
                            provider.provider.label(),
                            window.window.label,
                            window.window.used_percent,
                            window
                                .window
                                .resets_at_ms
                                .map_or_else(|| "unknown".into(), |at| at.to_string())
                        ));
                    }
                }
            }
        }
        text
    }

    /// The app showed a run's notification.
    pub async fn ack_overnight_notification(
        &self,
        conversation_id: crate::model::ConversationId,
        run_id: crate::model::OvernightRunId,
        notification_id: String,
    ) -> crate::Result<()> {
        let board = self.core.board(&conversation_id).await?;
        let run = board
            .runs
            .get(&run_id)
            .cloned()
            .ok_or_else(|| crate::Error::NotFound(format!("overnight run {run_id}")))?;
        let _held = self.overnight.changes.lock().await;
        let board = self.core.board(&conversation_id).await?;
        let Some(mut now) = board.runs.get(&run.id).cloned() else {
            return Ok(());
        };
        match now.notification.as_mut() {
            Some(notice) if notice.id == notification_id && notice.delivered_at_ms.is_none() => {
                notice.delivered_at_ms = Some(now_ms());
                notice.delivery_error = None;
            }
            _ => return Ok(()),
        }
        self.record_run(&now).await
    }

    /// An OS refusal is durable and visible while the notification stays pending.
    pub async fn fail_overnight_notification(
        &self,
        conversation_id: crate::model::ConversationId,
        run_id: crate::model::OvernightRunId,
        notification_id: String,
        error: String,
    ) -> crate::Result<()> {
        let _held = self.overnight.changes.lock().await;
        let board = self.core.board(&conversation_id).await?;
        let Some(mut run) = board.runs.get(&run_id).cloned() else {
            return Ok(());
        };
        let Some(notice) = run.notification.as_mut() else {
            return Ok(());
        };
        if notice.id != notification_id
            || notice.delivered_at_ms.is_some()
            || notice.delivery_error.as_ref() == Some(&error)
        {
            return Ok(());
        }
        notice.delivery_error = Some(error.chars().take(1000).collect());
        self.record_run(&run).await
    }

    /// Notifications of finished runs the app hasn't shown yet, in every session.
    pub async fn pending_overnight_notifications(
        &self,
    ) -> Vec<(
        crate::model::ConversationId,
        crate::model::OvernightRunId,
        RunNotification,
    )> {
        let mut pending = Vec::new();
        for conversation in self.core.catalog().conversations {
            if !matches!(conversation.setup, Some(Setup::Session { .. })) {
                continue;
            }
            let Ok(board) = self.core.board(&conversation.id).await else {
                continue;
            };
            for saved in board.runs.values() {
                // Also reconcile terminal setup failures and a report cut off by persistence.
                if saved.state == crate::overnight::OvernightState::Finished
                    && saved.report_message_id.is_none()
                {
                    self.write_run_report(saved).await;
                }
            }
            let Ok(board) = self.core.board(&conversation.id).await else {
                continue;
            };
            for run in board.runs.values() {
                if let Some(notice) = &run.notification
                    && notice.delivered_at_ms.is_none()
                {
                    pending.push((conversation.id.clone(), run.id.clone(), notice.clone()));
                }
            }
        }
        pending
    }

    /// The run branch's commits since the run's base, newest first.
    async fn run_commits(&self, run: &OvernightRun) -> Vec<(String, String)> {
        let (Some(workspace), Ok(conversation)) = (
            run.workspace.clone(),
            self.core.conversation(&run.conversation_id),
        ) else {
            return Vec::new();
        };
        let Some(Setup::Session { repo, .. }) = conversation.setup else {
            return Vec::new();
        };
        let git = self.git.clone();
        blocking(move || {
            let repo = git.open(std::path::Path::new(&repo)).map_err(git_error)?;
            let Some(tip) = repo.branch_tip(&workspace.branch).map_err(git_error)? else {
                return Ok(Vec::new());
            };
            let mut commits = Vec::new();
            for commit in repo.log(&tip, COMMITS).map_err(git_error)? {
                if commit.commit.0 == workspace.base_commit {
                    break;
                }
                commits.push((commit.commit.0, commit.subject));
            }
            Ok(commits)
        })
        .await
        .unwrap_or_default()
    }
}

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(10)]
}

fn counts(run: &OvernightRun) -> (usize, usize, usize, usize) {
    let worked: Vec<&OvernightPhase> = run
        .phases
        .iter()
        .filter(|phase| phase.state != PhaseState::Skipped)
        .collect();
    let of = |state: PhaseState| worked.iter().filter(|p| p.state == state).count();
    (
        worked.len(),
        of(PhaseState::Verified),
        of(PhaseState::Partial),
        of(PhaseState::Blocked),
    )
}

fn ending(run: &OvernightRun) -> String {
    match &run.stop {
        Some(StopReason::Done) => "finished".into(),
        Some(StopReason::Stopped) => "stopped by you".into(),
        Some(StopReason::Deadline) => "stopped at the deadline".into(),
        Some(StopReason::StopDirective) => "stopped where you asked".into(),
        Some(StopReason::Blocked { phase_id }) => {
            let number = run
                .phase(phase_id)
                .map_or_else(|| "0".to_owned(), |phase| phase.number.to_string());
            format!("stopped early: phase {number} needs you")
        }
        Some(StopReason::Failed { message }) => format!("could not run: {message}"),
        None => "ended".into(),
    }
}

/// The run's own Waiting items, and those of its tasks.
fn waiting<'a>(run: &OvernightRun, board: &'a Board) -> Vec<&'a str> {
    let mut items: Vec<_> = board
        .waiting
        .values()
        .filter(|item| match &item.source {
            WaitingSource::Run { run_id, .. } => run_id == &run.id,
            WaitingSource::Task { task_id } | WaitingSource::Landing { task_id } => board
                .tasks
                .get(task_id)
                .and_then(|task| task.run.as_ref())
                .is_some_and(|context| context.run_id == run.id),
            WaitingSource::Card { .. } | WaitingSource::Orchestrator => item
                .request_id
                .as_deref()
                .is_some_and(|request| request.starts_with(&format!("run-{}-", run.id.short()))),
        })
        .collect();
    items.sort_by_key(|item| item.created_at_ms);
    items.iter().map(|item| item.what.as_str()).collect()
}

fn notification_title(run: &OvernightRun) -> String {
    match &run.stop {
        Some(StopReason::Blocked { .. }) => format!("{}: {}", run.name, ending(run)),
        _ => format!("{} {}", run.name, ending(run)),
    }
}

fn notification_body(run: &OvernightRun, board: &Board) -> String {
    let (worked, verified, _, _) = counts(run);
    let waits = waiting(run, board).len();
    let mut body = format!("{verified} of {worked} phases verified");
    if waits > 0 {
        body.push_str(&format!(" · {waits} waiting on you"));
    }
    body
}

/// The report, from the records alone.
fn render(run: &OvernightRun, board: &Board, commits: &[(String, String)]) -> String {
    let (worked, verified, partial, blocked) = counts(run);
    let waits = waiting(run, board);
    let mut text = String::new();
    // 1. The outcome.
    let mut outcome = format!(
        "**{}** {}: {verified} of {worked} phases verified",
        run.name,
        ending(run)
    );
    if partial > 0 {
        outcome.push_str(&format!(", {partial} partial"));
    }
    if blocked > 0 {
        outcome.push_str(&format!(", {blocked} blocked"));
    }
    text.push_str(&outcome);
    text.push_str(".\n\n");
    // 2. Where the work is.
    match &run.workspace {
        Some(workspace) => {
            let after = run.verified_commit.as_ref().map_or(commits.len(), |tip| {
                commits
                    .iter()
                    .take_while(|(commit, _)| commit != tip)
                    .count()
            });
            match &run.verified_commit {
                Some(tip) => text.push_str(&format!(
                    "The work is on `{}` (from `{}`). Merge takes the verified tip `{}`{}.\n\n",
                    workspace.branch,
                    workspace.base,
                    short(tip),
                    if after > 0 {
                        format!(
                            "; the {after} later commit{} {} unverified work and stay{} on the branch",
                            if after == 1 { "" } else { "s" },
                            if after == 1 { "is" } else { "are" },
                            if after == 1 { "s" } else { "" }
                        )
                    } else {
                        String::new()
                    }
                )),
                None => text.push_str(&format!(
                    "The work is on `{}` (from `{}`). Nothing is verified yet, so there is nothing to merge.\n\n",
                    workspace.branch, workspace.base
                )),
            }
        }
        None => text.push_str("No branch was made.\n\n"),
    }
    // 3. What waits on the user.
    match waits.len() {
        0 => text.push_str("Nothing waits on you.\n"),
        1 => text.push_str(&format!("Waiting on you: {}\n", waits[0])),
        n => text.push_str(&format!(
            "{n} things wait on you (listed below); first: {}\n",
            waits[0]
        )),
    }
    // Each phase.
    if let Some(planning) = &run.planning {
        text.push_str(&format!(
            "\n### Phase 0 · Write the plan — {}\n",
            symbol(planning.state)
        ));
        for gap in &planning.gaps {
            text.push_str(&format!("- {gap}\n"));
        }
    }
    for phase in &run.phases {
        text.push_str(&format!(
            "\n### Phase {} · {} — {}\n",
            phase.number,
            phase.name,
            if phase.state == PhaseState::Pending {
                "– not reached".to_owned()
            } else {
                symbol(phase.state).to_owned()
            }
        ));
        if phase.state == PhaseState::Skipped || phase.state == PhaseState::Pending {
            continue;
        }
        for criterion in &phase.done_when {
            let result = phase.criteria.iter().find(|c| c.id == criterion.id);
            let (status, evidence) = match result {
                Some(result) => (status_word(result.status), result.evidence.as_str()),
                None => ("not checked", "No check reached it."),
            };
            text.push_str(&format!(
                "- {} {} ({status}): {}\n",
                criterion.id,
                criterion.text,
                evidence.trim()
            ));
        }
        if let Some(gate) = &phase.gate {
            text.push_str(&format!(
                "- Whole-phase checks: {} round{}, last on `{}`; {} fix round{}.\n",
                gate.round,
                if gate.round == 1 { "" } else { "s" },
                gate.commit.as_deref().map_or("?", short),
                phase.fix_rounds,
                if phase.fix_rounds == 1 { "" } else { "s" }
            ));
            for finding in &gate.findings {
                text.push_str(&format!("  - Finding {}: {}\n", finding.id, finding.text));
            }
        }
        for response in &phase.responses {
            text.push_str(&format!("  - Lead's answer: {response}\n"));
        }
        for gap in &phase.gaps {
            text.push_str(&format!("- Still missing: {gap}\n"));
        }
    }
    // Commits.
    if !commits.is_empty() {
        text.push_str("\n### Commits on the run branch\n");
        let mut verified = run.verified_commit.is_none();
        for (commit, subject) in commits {
            if Some(commit) == run.verified_commit.as_ref() {
                verified = true;
            }
            text.push_str(&format!(
                "- `{}` {}{}\n",
                short(commit),
                subject,
                if verified && run.verified_commit.is_some() {
                    ""
                } else {
                    " (unverified)"
                }
            ));
        }
    }
    // Decided for you.
    let decided: Vec<String> = board
        .decisions
        .iter()
        .filter(|decision| match &decision.source {
            DecisionSource::Run { run_id, .. } => run_id == &run.id,
            DecisionSource::Task { task_id } => board
                .tasks
                .get(task_id)
                .and_then(|task| task.run.as_ref())
                .is_some_and(|context| context.run_id == run.id),
            _ => decision
                .request_id
                .as_deref()
                .is_some_and(|request| request.starts_with(&format!("run-{}-", run.id.short()))),
        })
        .map(|decision| format!("- {}: {}", decision.what, decision.why))
        .collect();
    if !decided.is_empty() {
        text.push_str("\n### Decided for you\n");
        text.push_str(&decided.join("\n"));
        text.push('\n');
    }
    if !waits.is_empty() {
        text.push_str("\n### Waiting on you\n");
        for item in &waits {
            text.push_str(&format!("- {item}\n"));
        }
        text.push_str("Answer them, then say \"continue\" (or press Continue) to pick the run up on the same branch.\n");
    }
    // What went wrong or was cut short.
    let mut risks: Vec<String> = Vec::new();
    for gap in &run.gaps {
        risks.push(format!(
            "{} ({}–{} ms; no work happened then).",
            gap.cause, gap.from_ms, gap.to_ms
        ));
    }
    if let (Deadline::At { time }, finished) = (
        &run.directives.deadline,
        run.finished_at_ms.unwrap_or_else(now_ms),
    ) && finished > time.at_ms
    {
        risks.push(format!(
            "This report is late: it was due at {} and written {} minutes after.",
            time.local_time,
            (finished - time.at_ms) / 60_000
        ));
    }
    let remaining: Vec<String> = run
        .phases
        .iter()
        .filter(|phase| phase.state == PhaseState::Pending && run.selects(phase.number))
        .map(|phase| format!("phase {}", phase.number))
        .collect();
    if !remaining.is_empty() {
        risks.push(format!("Not reached: {}.", remaining.join(", ")));
    }
    for line in &run.directives.ignored {
        risks.push(line.clone());
    }
    if !risks.is_empty() {
        text.push_str("\n### Risks and interruptions\n");
        for risk in &risks {
            text.push_str(&format!("- {risk}\n"));
        }
    }
    if let Some(workspace) = &run.workspace {
        text.push_str(&format!("\nRun worktree and handoffs: `{}`; each worker's kept work and handoff are linked from its task.\n", workspace.path));
    }
    if commits.len() == COMMITS {
        text.push_str("\nThe commit list is limited to the latest 60; inspect the run branch for its full history.\n");
    }
    // Who did the work, folded at the end.
    let mut lineage: Vec<String> = board
        .tasks
        .values()
        .filter(|task| {
            task.run
                .as_ref()
                .is_some_and(|context| context.run_id == run.id)
        })
        .map(|task| {
            format!(
                "- task-{} {} ({:?}, {:?} {}): {:?}",
                task.number,
                task.title,
                task.run.as_ref().map(|c| c.role),
                task.route.choice.provider,
                task.route.choice.model.as_deref().unwrap_or("default"),
                task.state
            )
        })
        .collect();
    lineage.sort();
    if !lineage.is_empty() {
        text.push_str("\n<details><summary>Workers and models</summary>\n\n");
        text.push_str(&lineage.join("\n"));
        text.push_str("\n\n</details>\n");
    }
    text
}

fn symbol(state: PhaseState) -> &'static str {
    match state {
        PhaseState::Verified => "✓ verified",
        PhaseState::Partial => "◐ partial",
        PhaseState::Blocked => "✕ blocked",
        PhaseState::Skipped => "– skipped",
        PhaseState::Pending => "– not reached",
        PhaseState::Running | PhaseState::Checking => "◐ unfinished",
    }
}

fn status_word(status: CriterionStatus) -> &'static str {
    match status {
        CriterionStatus::Met => "met",
        CriterionStatus::NotMet => "not met",
        CriterionStatus::NotRun => "not checked",
        CriterionStatus::Blocked => "needs you",
    }
}
