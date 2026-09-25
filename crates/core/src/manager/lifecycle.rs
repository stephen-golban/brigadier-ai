//! The lifecycle of sessions and Chats (PLAN §5): hibernate, archive, restore, delete, and
//! the recovery after Brigadier was quit or crashed.
//!
//! - **Hibernate** (automatic when idle, or on request): the conversation's CLI sessions
//!   stop and their temp files go. The CLI session files stay, so the next message resumes
//!   it; if they are gone, it starts over from Brigadier's transcript.
//! - **Archive**: workers stop (unfinished work kept as a WIP commit on its task branch),
//!   every CLI session ends, and everything recorded in the cleanup ledger for the
//!   conversation is removed: worktrees, scratch folders, CLI session files, processes.
//!   Transcript, tasks, artifacts and branches stay; restoring starts a new CLI session from
//!   the transcript.
//! - **Delete**: archive, optionally delete the branches Brigadier created for it, then purge
//!   its streams and the blobs nothing else references.
//! - **Recovery**: after a restart, work that was running has lost its CLI: tasks end (their
//!   work kept), cards nobody waits for expire, and the ledger finishes every cleanup.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use super::conversation::Envelope;
use super::{SessionManager, blocking, git_error};
use crate::model::{
    Conversation, ConversationId, ConversationKind, Environment, Lifecycle, Setup, streams,
};
use crate::work::{InjectionKind, TaskState};
use crate::{Error, Result, now_ms};

/// How often idle conversations are checked for hibernation.
const HIBERNATE_CHECK: Duration = Duration::from_secs(60);

impl SessionManager {
    /// Lets the cleanup ledger remove the worktrees it records.
    pub(super) fn install_worktree_remover(&self) {
        let git = self.git.clone();
        self.runtime.ledger().set_worktree_remover(Arc::new(
            move |repo: PathBuf, path: PathBuf| {
                let git = git.clone();
                Box::pin(async move {
                    tokio::task::spawn_blocking(move || {
                        match git.open(&repo) {
                            Ok(repo) => {
                                let same = |a: &std::path::Path| {
                                    a == path || a.canonicalize().ok() == path.canonicalize().ok()
                                };
                                let registered = repo
                                    .worktrees()
                                    .map_err(|err| err.to_string())?
                                    .iter()
                                    .any(|w| same(&w.path));
                                if registered || !path.exists() || same(repo.root()) {
                                    repo.remove_worktree(&path, true)
                                        .map_err(|err| err.to_string())
                                } else {
                                    // Git already let go of it (a removal that failed halfway);
                                    // what is left is the folder Brigadier created and recorded.
                                    std::fs::remove_dir_all(&path).map_err(|err| err.to_string())
                                }
                            }
                            // The repository itself is gone: only the folder is left to remove.
                            Err(_) if !path.exists() => Ok(()),
                            Err(_) => std::fs::remove_dir_all(&path).map_err(|err| err.to_string()),
                        }
                    })
                    .await
                    .map_err(|err| err.to_string())?
                })
            },
        ));
    }

    /// After a restart: nothing runs any more, so running tasks end, stale cards expire, and
    /// cleanups that could not finish before (worktrees need the git engine) finish now.
    pub(super) async fn recover(&self) {
        self.runtime.ledger().sweep().await;
        for conversation in self.core.catalog().conversations {
            let Ok(tasks) = self.core.tasks(&conversation.id).await else {
                continue;
            };
            for task in tasks.into_iter().filter(|task| !task.state.is_final()) {
                match task.state {
                    // Its worktree is intact; the worker resumes when sent back to work.
                    TaskState::Reported | TaskState::ReadyToLand if task.kind.writes() => continue,
                    // A read task that reported is done.
                    TaskState::Reported => {
                        self.dispose_task(&task, TaskState::Done).await;
                        continue;
                    }
                    // The landing was interrupted: accept it again.
                    TaskState::Reviewing | TaskState::AwaitingApproval if task.kind.writes() => {
                        let _ = self
                            .update_task(&conversation.id, &task.id, |t| {
                                t.state = TaskState::Reported;
                                t.candidate = None;
                                t.review = None;
                            })
                            .await;
                        // The orchestrator was promised the landing's outcome as a message.
                        self.deliver(
                            &conversation.id,
                            Envelope {
                                kind: InjectionKind::Decision,
                                label: format!("landing task-{}", task.number),
                                task_id: Some(task.id.clone()),
                                text: format!(
                                    "[not landed task-{} \"{}\"] Brigadier restarted before the landing finished; nothing landed. Call accept_task for task-{} again.",
                                    task.number, task.title, task.number
                                ),
                            },
                        )
                        .await;
                        continue;
                    }
                    _ => {}
                }
                let _ = self
                    .update_task(&conversation.id, &task.id, |t| {
                        t.error = Some("Brigadier quit while this task was running.".into());
                    })
                    .await;
                self.dispose_task(&task, TaskState::Stopped).await;
            }
            self.expire_stale_cards(&conversation.id).await;
            // Nothing runs any more: what was working is over or waits for the user.
            self.settle_requests(&conversation.id).await;
        }
    }

    /// Hibernates conversations idle for longer than the setting.
    pub(super) fn start_hibernation_timer(&self) {
        let manager = self.me.clone();
        self.spawn(async move {
            let mut tick = tokio::time::interval(HIBERNATE_CHECK);
            tick.tick().await;
            loop {
                tick.tick().await;
                let Some(manager) = manager.upgrade() else {
                    return;
                };
                if manager.admit().is_err() {
                    return;
                }
                manager.hibernate_idle().await;
            }
        });
    }

    async fn hibernate_idle(&self) {
        let minutes = self.core.settings().hibernate_after_minutes;
        if minutes == 0 {
            return;
        }
        let cutoff = now_ms() - i64::from(minutes) * 60_000;
        let convs: Vec<_> = self.convs_lock().values().cloned().collect();
        for conv in convs {
            let Some(since) = conv.idle_since_ms().await else {
                continue;
            };
            if since > cutoff || conv.is_busy().await || self.has_running_workers(&conv.id).await {
                continue;
            }
            if let Err(err) = self.hibernate(conv.id.clone()).await {
                tracing::debug!(conversation = %conv.id, error = %err, "could not hibernate");
            }
        }
    }

    async fn has_running_workers(&self, id: &ConversationId) -> bool {
        self.core.tasks(id).await.is_ok_and(|tasks| {
            tasks.iter().any(|task| {
                matches!(
                    task.state,
                    TaskState::Queued
                        | TaskState::Starting
                        | TaskState::Running
                        | TaskState::Blocked
                        | TaskState::Reviewing
                        | TaskState::AwaitingApproval
                )
            })
        })
    }

    /// Stops the conversation's CLI sessions and removes their temp files; it continues on
    /// the next message.
    pub async fn hibernate(&self, id: ConversationId) -> Result<Conversation> {
        let conversation = self.core.conversation(&id)?;
        if conversation.lifecycle == Lifecycle::Archived {
            return Err(Error::Invalid(
                "an archived conversation cannot hibernate".into(),
            ));
        }
        if self.has_running_workers(&id).await {
            return Err(Error::Invalid(
                "workers are still running; stop them or let them finish first".into(),
            ));
        }
        if let Ok(conv) = self.conv(&id) {
            if conv.is_busy().await {
                return Err(Error::Invalid(
                    "a turn is running; interrupt it first".into(),
                ));
            }
            conv.close_cli().await;
        }
        // Reported workers wait idle; they stop too and resume when sent back to work.
        for task in self.core.tasks(&id).await? {
            if !task.state.is_final()
                && let Some(live) = self.existing_task_live(&task.id)
            {
                live.close_cli().await;
                live.allow_revival().await;
            }
        }
        let (owner, area) = conversation_owner(&conversation);
        self.runtime.ledger().end_processes(&owner).await;
        let attachments = self.owned_dir(area, &id.0).join("attachments");
        let _ = blocking(move || match std::fs::remove_dir_all(&attachments) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(Error::Invalid(err.to_string())),
        })
        .await;
        self.set_run(&id, crate::work::RunState::Hibernated, None)
            .await;
        self.core.set_lifecycle(id, Lifecycle::Hibernated).await
    }

    /// Archives a conversation: everything it created goes, except its transcript, tasks,
    /// artifacts and branches.
    pub async fn archive(&self, id: ConversationId) -> Result<Conversation> {
        let conversation = self.core.conversation(&id)?;
        self.wind_down(&conversation).await;
        self.core.set_lifecycle(id, Lifecycle::Archived).await
    }

    /// Stops everything a conversation runs and removes what it created.
    async fn wind_down(&self, conversation: &Conversation) {
        let id = &conversation.id;
        let conv = self.convs_lock().remove(id);
        if let Some(conv) = conv {
            conv.close_cli().await;
        }
        if let Ok(tasks) = self.core.tasks(id).await {
            for task in tasks.into_iter().filter(|task| !task.state.is_final()) {
                if let Some(live) = self.existing_task_live(&task.id) {
                    live.close_cli().await;
                }
                self.dispose_task(&task, TaskState::Stopped).await;
            }
        }
        let (owner, _) = conversation_owner(conversation);
        self.grants.revoke_owner(&owner);
        let mut owners = vec![owner];
        let session_worktree_goes = self.keep_session_changes(conversation).await;
        if session_worktree_goes {
            owners.push(format!("session:{id}"));
        }
        for owner in owners {
            let leftovers = self.runtime.ledger().dispose(&owner).await;
            if !leftovers.is_clean() {
                tracing::warn!(
                    owner,
                    ?leftovers,
                    "some leftovers will be retried at the next launch"
                );
            }
        }
        // Its CLI session files are gone: the next CLI session starts from the transcript.
        self.forget_native_session(id).await;
        self.expire_stale_cards(id).await;
        self.set_run(id, crate::work::RunState::Idle, None).await;
        if let Some(Setup::Session {
            repo,
            environment:
                Environment::NewWorktree {
                    base,
                    branch,
                    path: Some(_),
                    mut start,
                },
            permission,
            orchestrator,
            workers_see_uncommitted,
            plan_mode,
        }) = conversation.setup.clone()
            && session_worktree_goes
        {
            // The session worktree is gone. The branch stays while it holds work the base does
            // not have; a restored session creates it again from the base otherwise.
            if branch.starts_with("brigadier/") {
                let (git, repo, branch, base) = (
                    self.git.clone(),
                    PathBuf::from(&repo),
                    branch.clone(),
                    base.clone(),
                );
                let deleted = blocking(move || {
                    let repo = git.open(&repo).map_err(git_error)?;
                    if let Some(tip) = repo.branch_tip(&branch).map_err(git_error)?
                        && repo.is_merged(&branch, &base).map_err(git_error)?
                    {
                        repo.delete_branch_at(&branch, &tip).map_err(git_error)?;
                        return Ok(true);
                    }
                    Ok(false)
                })
                .await;
                match deleted {
                    // Its work is in the base now: a fork's branch starts there again too.
                    Ok(true) => start = None,
                    Ok(false) => {}
                    Err(err) => {
                        tracing::warn!(conversation = %id, error = %err, "could not delete the merged session branch");
                    }
                }
            }
            let _ = self
                .core
                .set_setup(
                    id.clone(),
                    Setup::Session {
                        repo,
                        environment: Environment::NewWorktree {
                            base,
                            branch,
                            path: None,
                            start,
                        },
                        permission,
                        orchestrator,
                        workers_see_uncommitted,
                        plan_mode,
                    },
                )
                .await;
        }
    }

    /// Changes made in a new-worktree session's own worktree (by the user; landings there are
    /// commits) are kept as a WIP commit on the session branch before the worktree goes. If
    /// they cannot be, the worktree stays, and so does everything in it (`false`).
    async fn keep_session_changes(&self, conversation: &Conversation) -> bool {
        let Some(Setup::Session {
            environment:
                Environment::NewWorktree {
                    path: Some(path), ..
                },
            ..
        }) = &conversation.setup
        else {
            return true;
        };
        let (git, path) = (self.git.clone(), PathBuf::from(path));
        if !path.exists() {
            return true;
        }
        let kept = blocking(move || {
            git.open_worktree(&path)
                .map_err(git_error)?
                .commit_wip("WIP: uncommitted changes in the session worktree (kept by Brigadier)")
                .map_err(git_error)
        })
        .await;
        match kept {
            Ok(Some(commit)) => {
                tracing::info!(conversation = %conversation.id, commit = %commit.0, "kept the session worktree's changes as a WIP commit");
                true
            }
            Ok(None) => true,
            Err(err) => {
                tracing::error!(conversation = %conversation.id, error = %err, "could not keep the session worktree's changes; the worktree stays");
                false
            }
        }
    }

    /// Brings an archived conversation back; its next turn starts from the transcript.
    pub async fn restore(&self, id: ConversationId) -> Result<Conversation> {
        let conversation = self.core.conversation(&id)?;
        if conversation.lifecycle != Lifecycle::Archived {
            return Err(Error::Invalid(
                "only an archived conversation can be restored".into(),
            ));
        }
        if let Ok(conv) = self.conv(&id) {
            conv.mark_reseed().await;
        }
        self.core.set_lifecycle(id, Lifecycle::Active).await
    }

    /// Deletes a conversation for good. Branches Brigadier created for it (task branches, a
    /// `brigadier/` session branch) go only if asked; the user's own branches never do.
    pub async fn delete(&self, id: ConversationId, delete_branches: bool) -> Result<()> {
        let conversation = self.core.conversation(&id)?;
        self.wind_down(&conversation).await;
        let tasks = self.core.tasks(&id).await.unwrap_or_default();
        if delete_branches
            && let Some(Setup::Session {
                repo, environment, ..
            }) = &conversation.setup
        {
            let mut branches: Vec<String> = tasks
                .iter()
                .filter_map(|task| task.workspace.as_ref().and_then(|w| w.branch.clone()))
                .collect();
            if let Environment::NewWorktree { branch, .. } = environment
                && branch.starts_with("brigadier/")
            {
                branches.push(branch.clone());
            }
            let (git, repo) = (self.git.clone(), PathBuf::from(repo));
            blocking(move || {
                let repo = git.open(&repo).map_err(git_error)?;
                for branch in branches {
                    if repo.branch_tip(&branch).map_err(git_error)?.is_some()
                        && let Err(err) = repo.delete_branch(&branch, true)
                    {
                        tracing::warn!(branch, error = %err, "could not delete a branch");
                    }
                }
                Ok(())
            })
            .await?;
        }
        let mut purge = vec![streams::conversation(&id), streams::orchestrator(&id)];
        purge.extend(tasks.iter().map(|task| streams::task(&task.id)));
        self.core.forget_conversation(id.clone()).await?;
        self.convs_lock().remove(&id);
        let store = self.core.store().clone();
        let removed = store.delete_streams(purge).await?;
        match store.gc_blobs().await {
            Ok(stats) => {
                tracing::info!(conversation = %id, removed, ?stats, "conversation deleted")
            }
            Err(err) => tracing::warn!(conversation = %id, error = %err, "could not collect blobs"),
        }
        Ok(())
    }
}

/// The cleanup-ledger owner and data-dir area of a conversation's CLI session.
fn conversation_owner(conversation: &Conversation) -> (String, &'static str) {
    match conversation.kind {
        ConversationKind::Session => (format!("orch:{}", conversation.id), "orch"),
        ConversationKind::Chat => (format!("chat:{}", conversation.id), "chat"),
    }
}
