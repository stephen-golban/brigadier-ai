//! Worker hand-off by size (PLAN.md §7): a worker whose context passes the hand-off size
//! continues in a fresh session of the same model, in the same worktree, instead of sending an
//! ever larger context with every request.
//!
//! - **Only between turns.** When a worker's context passes the size mid-turn, it is asked (a
//!   steer) to finish the step it is in and end its turn with a handoff note. The fresh session
//!   starts when that turn ends. A message for a worker that is between turns (or hibernated)
//!   with a context past the size starts the fresh session at once, without a new note: the
//!   worker's report and transcript carry what it did.
//! - **Nothing is lost.** Brigadier writes `<scratch>/handoff/`: note.md (the worker's own note),
//!   spec.md, progress.md and diff.patch as a fallback hand-off writes them, and transcript.md,
//!   every message, command and tool call of the task in full, as Brigadier recorded them. The
//!   fresh session gets the note and the last messages word for word, and searches the rest.
//! - **Same model, same attempt.** It is not a reroute: the task keeps its model, attempt and
//!   access. A limit or error hand-on still wins when both are due.

use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::Arc;

use brigadier_providers::{ItemStatus, NoticeLevel, ProviderEvent, Role, TurnInput};
use brigadier_store::StreamPage;

use super::SessionManager;
use super::conversation::Cli;
use super::workers::TaskLive;
use crate::model::{DomainEvent, TaskId, streams};
use crate::work::Task;
use crate::{Error, Result, knowledge};

/// Worker events read per page for the transcript.
const EVENTS_PAGE: u32 = 2_000;
/// The previous session's last messages the fresh one gets word for word.
const TAIL_MESSAGES: usize = 6;
/// … each up to this many bytes (the rest is in transcript.md).
const TAIL_MESSAGE_BYTES: usize = 8_000;

/// The steer that asks a worker to end its turn with a handoff note.
fn wrap_up_prompt(tokens: i64) -> String {
    format!(
        "[Brigadier] Your context is now about {}k tokens, so Brigadier will continue this task in \
a fresh session of the same model, in the same worktree, with your full transcript kept on disk. \
If the task is done apart from its report, call submit_report now as usual. Otherwise finish the \
step you are in, but don't start another command or edit, and end your turn with a handoff note \
for the fresh session instead of a report. Write it in plain text under these headings: Goal and \
state; Decisions made (each with its reason); Commitments to the orchestrator; Done and verified; \
Next steps. Include anything you found or ruled out that isn't in the code. At most about 800 \
words. Don't call submit_report for this.",
        tokens / 1_000
    )
}

impl SessionManager {
    /// The worker context at which a worker is handed over, when the setting is on.
    pub(crate) fn worker_handoff_at(&self) -> Option<i64> {
        let usage = self.core.settings().usage;
        usage
            .worker_handoff
            .then(|| knowledge::worker_handoff_tokens(usage.worker_handoff_tokens))
    }

    /// A worker reported its context size: past the hand-off size mid-turn, it is asked to wrap
    /// up with a handoff note.
    pub(crate) async fn worker_context(&self, live: &Arc<TaskLive>, cli: &Arc<Cli>, tokens: i64) {
        if !live.note_context(tokens, self.worker_handoff_at()).await {
            return;
        }
        tracing::info!(task = %live.id, tokens, "asking the worker to wrap up for a hand-off");
        self.record_worker_event(
            &live.id,
            ProviderEvent::Notice {
                level: NoticeLevel::Info,
                message: format!(
                    "Context at about {}k tokens: asked the worker to end its turn with a \
                     handoff note, so a fresh session can continue.",
                    tokens / 1_000
                ),
            },
        )
        .await;
        // Not from inside the worker's event pump: a steer may wait on the CLI.
        let cli = cli.clone();
        self.spawn(async move {
            if let Err(err) = cli
                .session
                .steer(TurnInput::text(wrap_up_prompt(tokens)))
                .await
            {
                tracing::warn!(error = %err, "could not ask the worker to wrap up");
            }
        });
    }

    /// The worker's context is past the hand-off size (after a restart, from its recorded
    /// events).
    pub(crate) async fn worker_over_handoff(&self, live: &Arc<TaskLive>, id: &TaskId) -> bool {
        let Some(at) = self.worker_handoff_at() else {
            return false;
        };
        let context = match live.context().await {
            Some(tokens) => Some(tokens),
            None => self.last_worker_context(id).await,
        };
        context.is_some_and(|tokens| tokens >= at)
    }

    /// The last context size the worker's latest CLI session reported.
    async fn last_worker_context(&self, id: &TaskId) -> Option<i64> {
        let page = self
            .core
            .store()
            .read_stream(
                streams::task(id),
                StreamPage {
                    before: None,
                    kinds: vec!["worker.event".into()],
                    limit: EVENTS_PAGE,
                },
            )
            .await
            .ok()?;
        for stored in page {
            match serde_json::from_str::<DomainEvent>(stored.payload.get()) {
                Ok(DomainEvent::WorkerEvent {
                    event: ProviderEvent::ContextSize { used_tokens, .. },
                    ..
                }) => return Some(used_tokens),
                Ok(DomainEvent::WorkerEvent {
                    event: ProviderEvent::SessionStarted { .. },
                    ..
                }) => return None,
                _ => {}
            }
        }
        None
    }

    /// Continues `task` in a fresh session of the same model: closes its CLI (between turns),
    /// writes the hand-off files, and starts the new session with `note`, the last messages and
    /// `pending` (a message still to act on). Boxed: the worker it starts can come back here,
    /// and a recursive future must name its `Send` bound.
    pub(crate) fn hand_over_worker<'a>(
        &'a self,
        live: &'a Arc<TaskLive>,
        task: &'a Task,
        note: Option<String>,
        pending: Option<String>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(self.hand_over(live, task, note, pending))
    }

    async fn hand_over(
        &self,
        live: &Arc<TaskLive>,
        task: &Task,
        note: Option<String>,
        pending: Option<String>,
    ) -> Result<()> {
        let _handing = live.reroute.lock().await;
        let tokens = match live.context().await {
            Some(tokens) => Some(tokens),
            None => self.last_worker_context(&task.id).await,
        };
        live.close_cli().await;
        let task = self.task_by_id(&task.conversation_id, &task.id).await?;
        if task.state.is_final() {
            return Ok(());
        }
        let (dir, has_diff) = self.write_handoff_files(&task).await?;
        let (transcript, tail) = self.worker_transcript(&task.id).await;
        // A turn that ended before the ask reached it has no note: its last message is in the
        // tail anyway.
        let note = note.filter(|note| note.to_lowercase().contains("next steps"));
        {
            let (dir, note) = (dir.clone(), note.clone());
            super::blocking(move || {
                let io =
                    |err: std::io::Error| Error::Invalid(format!("writing the hand-off: {err}"));
                std::fs::write(dir.join("transcript.md"), transcript).map_err(io)?;
                match note {
                    Some(note) => std::fs::write(dir.join("note.md"), note).map_err(io)?,
                    None => match std::fs::remove_file(dir.join("note.md")) {
                        Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
                            return Err(io(err));
                        }
                        _ => {}
                    },
                }
                Ok(())
            })
            .await?;
        }
        let text = handover_text(
            &task,
            &dir,
            tokens,
            note.is_some(),
            has_diff,
            &tail,
            pending,
        );
        let size = tokens.map_or_else(String::new, |tokens| {
            format!(" at about {}k tokens", tokens / 1_000)
        });
        self.record_worker_event(
            &task.id,
            ProviderEvent::Notice {
                level: NoticeLevel::Info,
                message: format!(
                    "Continued in a fresh session of the same model{size}; the hand-off is in {}.",
                    dir.display()
                ),
            },
        )
        .await;
        tracing::info!(task = %task.id, ?tokens, with_note = note.is_some(), "worker handed over to a fresh session");
        let subject = match &task.subject {
            Some(id) => self.task_by_id(&task.conversation_id, id).await.ok(),
            None => None,
        };
        let workspace = task
            .workspace
            .as_ref()
            .ok_or_else(|| Error::Invalid("the task has no workspace".into()))?;
        let files = self
            .worker_files(&task, &PathBuf::from(&workspace.scratch))
            .await;
        // Stopped meanwhile (the user's stop button): nothing starts again.
        if self
            .task_by_id(&task.conversation_id, &task.id)
            .await
            .is_ok_and(|task| task.state.is_final())
        {
            return Ok(());
        }
        live.allow_revival().await;
        live.clear_transient().await;
        self.launch_worker(
            live,
            &task,
            subject.as_ref(),
            brigadier_providers::Origin::New,
            TurnInput { text, files },
        )
        .await
    }

    /// Every recorded event of the task's workers, in full, oldest first, and their last
    /// messages.
    async fn worker_transcript(&self, id: &TaskId) -> (String, Vec<String>) {
        let mut events: Vec<ProviderEvent> = Vec::new();
        let mut before = None;
        loop {
            let page = self
                .core
                .store()
                .read_stream(
                    streams::task(id),
                    StreamPage {
                        before,
                        kinds: vec!["worker.event".into()],
                        limit: EVENTS_PAGE,
                    },
                )
                .await
                .unwrap_or_default();
            let Some(oldest) = page.last() else {
                break;
            };
            before = Some(oldest.stream_seq);
            let full = page.len() == EVENTS_PAGE as usize;
            events.extend(page.iter().filter_map(|stored| {
                match serde_json::from_str::<DomainEvent>(stored.payload.get()) {
                    Ok(DomainEvent::WorkerEvent { event, .. }) => Some(event),
                    _ => None,
                }
            }));
            if !full {
                break;
            }
        }
        events.reverse();
        let mut text = String::from(
            "# The task's full transcript\n\nEvery message, command and tool call so far, oldest \
             first, as Brigadier recorded them (long command and tool outputs are clipped where \
             the CLI clipped them).\n",
        );
        let mut tail: Vec<String> = Vec::new();
        for event in &events {
            if let ProviderEvent::Message {
                role: Role::Assistant,
                text: said,
                ..
            } = event
            {
                tail.push(said.clone());
            }
            transcript_entry(&mut text, event);
        }
        let tail = tail.split_off(tail.len().saturating_sub(TAIL_MESSAGES));
        (text, tail)
    }
}

/// One transcript entry, in full.
fn transcript_entry(text: &mut String, event: &ProviderEvent) {
    match event {
        ProviderEvent::SessionStarted { model, .. } => {
            let _ = write!(
                text,
                "\n## A session started ({})\n",
                model.as_deref().unwrap_or("its default model")
            );
        }
        ProviderEvent::Message {
            role, text: said, ..
        } => {
            let who = match role {
                Role::Assistant => "The worker",
                _ => "The worker was told",
            };
            let _ = write!(text, "\n### {who}\n\n{said}\n");
        }
        ProviderEvent::Command {
            command,
            status: ItemStatus::Completed | ItemStatus::Failed,
            exit_code,
            output,
            ..
        } => {
            let code = exit_code.map_or_else(String::new, |code| format!(" (exit {code})"));
            let _ = write!(text, "\n### Ran `{command}`{code}\n");
            if let Some(output) = output.as_deref().filter(|output| !output.trim().is_empty()) {
                let _ = write!(text, "\n```\n{}\n```\n", output.trim_end());
            }
        }
        ProviderEvent::ToolCall {
            name,
            input,
            status: ItemStatus::Completed | ItemStatus::Failed,
            output,
            ..
        } => {
            let _ = write!(text, "\n### Used {name}\n");
            if let Some(input) = input {
                let _ = write!(text, "\nInput: {input}\n");
            }
            if let Some(output) = output.as_deref().filter(|output| !output.trim().is_empty()) {
                let _ = write!(text, "\n```\n{}\n```\n", output.trim_end());
            }
        }
        ProviderEvent::FileChanges {
            changes,
            status: ItemStatus::Completed,
            ..
        } => {
            let paths: Vec<&str> = changes.iter().map(|change| change.path.as_str()).collect();
            let _ = write!(text, "\n### Changed files: {}\n", paths.join(", "));
        }
        ProviderEvent::Error { error } if !error.will_retry => {
            let _ = write!(text, "\n### Stopped by an error\n\n{}\n", error.message);
        }
        ProviderEvent::Notice { message, .. } => {
            let _ = write!(text, "\n### Brigadier\n\n{message}\n");
        }
        _ => {}
    }
}

/// The fresh session's first message.
fn handover_text(
    task: &Task,
    dir: &std::path::Path,
    tokens: Option<i64>,
    has_note: bool,
    has_diff: bool,
    tail: &[String],
    pending: Option<String>,
) -> String {
    let size = tokens.map_or_else(String::new, |tokens| {
        format!(" (about {}k tokens)", tokens / 1_000)
    });
    let mut text = format!(
        "[Brigadier] You are continuing task-{} in a fresh session. Your earlier session's context \
         had grown large{size}, so it was closed between turns to give you room; you are the same \
         model, in the same place, and nothing in the worktree was touched. Its hand-off is in {}: ",
        task.number,
        dir.display()
    );
    if has_note {
        text.push_str("note.md (its own handoff note: read it first), ");
    }
    text.push_str(
        "spec.md (the task and every later instruction from the orchestrator), progress.md (a \
         short log of what it did) and transcript.md (the whole transcript, word for word: search \
         it with rg for any detail instead of redoing work)",
    );
    if task.kind.writes() {
        text.push_str(if has_diff {
            ", and diff.patch (the changes so far, as the worktree holds them). Keep the work \
             already done unless it is wrong, and don't redo it"
        } else {
            ". There are no changes in the worktree yet"
        });
    } else {
        text.push_str(". Don't redo what is done");
    }
    text.push_str(
        ". Decisions and commitments made earlier still hold. Then carry on with the task and \
         report with submit_report as your rules say.",
    );
    if !tail.is_empty() {
        text.push_str("\n\nThe earlier session's last messages, oldest first, word for word:");
        for said in tail {
            let said = if said.len() > TAIL_MESSAGE_BYTES {
                let mut end = TAIL_MESSAGE_BYTES;
                while !said.is_char_boundary(end) {
                    end -= 1;
                }
                format!("{} […cut; the rest is in transcript.md]", &said[..end])
            } else {
                said.clone()
            };
            let _ = write!(text, "\n\n---\n{said}");
        }
        text.push_str("\n\n---");
    }
    if let Some(pending) = pending {
        let _ = write!(text, "\n\nWaiting for you now:\n{pending}");
    }
    text
}
