//! The worker runtime: one CLI session per task.
//!
//! A task goes in; Brigadier routes it to a model (the static table in `crates/router`, where
//! the orchestrator's vendor is not an input), gives it a workspace, and starts the worker:
//!
//! - **Workspace.** Write tasks get a worktree on a new task branch, read tasks a detached
//!   worktree, research tasks none. Worktrees start from the session branch's latest commit
//!   (new-worktree mode) or the picked branch's (local checkout). In a dirty local checkout
//!   the user is asked once whether workers see the uncommitted changes; if so, workers start
//!   from a snapshot commit of them, and only the worker's own changes ever land.
//! - **Scratch folder** outside the repository, which is also the worker's TMPDIR. Everything
//!   is recorded in the cleanup ledger under `task:<id>` before it is created, including any
//!   process running inside those folders.
//! - **Access** per task (B12): repository read or write, scratch write and network
//!   independently, inside the OS sandbox unless the session has Full access. Outward
//!   commands go through the gate on PATH at every level.
//! - **Instructions**: the role and task prompt, plus the repository's `CLAUDE.md` and
//!   `AGENTS.md` whichever vendor runs it ([`super::instructions`]).
//! - **Secrets**: the project's gitignored env files are copied in, and their values are
//!   redacted from everything the worker produces.
//!
//! The worker streams its events to `task:<id>` (never to the orchestrator), may block on
//! `ask_orchestrator`, and ends with `submit_report`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use brigadier_git::{Oid, PatchOutcome, WorktreeSpec};
use brigadier_providers::policy::{self, ApprovalMode, Route as PolicyRoute};
use brigadier_providers::{
    Access, ApprovalDecision, ApprovalRequest, Artifact, Decider, InputFile, Origin, ProviderEvent,
    ProviderKind, SessionSpec, Started, ToolSet, TurnInput, TurnStatus,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::conversation::{Cli, Envelope, safe_file_name};
use super::{SessionManager, blocking, git_error, instructions, prompts, secrets};
use crate::model::{
    ConversationId, DomainEvent, Environment, ModelChoice, PermissionLevel, Setup, streams,
};
use crate::runtime::{is_delta, merge_delta};
use crate::tools::Role;
use crate::work::{
    ApprovalSubject, ArtifactKind, ArtifactRef, AttachmentRef, InjectionKind, QuestionKind,
    RepoAccess, Report, Route, Task, TaskId, TaskKind, TaskState, TaskWorkspace, WorkerAccess,
};
use crate::{Error, Result, now_ms};

/// Text deltas arriving within this window are stored as one event.
const DELTA_WINDOW: Duration = Duration::from_millis(30);
/// The CLIs' own limit on a worker's MCP calls: effectively none, since Codex does not cancel
/// a call it timed out; Brigadier bounds `ask_orchestrator` itself.
const WORKER_TOOL_TIMEOUT_SECS: u64 = 24 * 60 * 60;
/// How long `ask_orchestrator` waits for the orchestrator's answer.
const QUESTION_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// Report size cap: about 800 tokens.
pub(crate) const REPORT_MAX_BYTES: usize = 3_600;
/// Largest file a report may attach as an artifact.
const ARTIFACT_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// The folder in a worker's scratch folder for files meant for the orchestrator or the user.
const OUTPUTS_DIR: &str = "outputs";

/// A worker's outputs folder.
pub(crate) fn outputs_dir(scratch: &Path) -> PathBuf {
    scratch.join(OUTPUTS_DIR)
}

/// What a task's workspace is made of, once prepared.
#[derive(Debug, Clone)]
pub(crate) struct Workspace {
    pub repo: PathBuf,
    /// The task's worktree, if it has one.
    pub worktree: Option<PathBuf>,
    pub branch: Option<String>,
    /// The commit the worker started from (a snapshot commit when it saw uncommitted changes).
    pub base: Option<Oid>,
    /// `base` is a snapshot of the user's uncommitted changes.
    pub on_snapshot: bool,
    /// The branch accepted work lands on.
    pub target: Option<String>,
    pub scratch: PathBuf,
}

#[derive(Default)]
struct TaskLiveState {
    cli: Option<Arc<Cli>>,
    /// The worker waits on `ask_orchestrator`.
    question: Option<oneshot::Sender<String>>,
    /// A turn is running.
    busy: bool,
    /// Asked once to submit its report after a turn ended without one.
    nudged: bool,
    stopping: bool,
    access: Option<Access>,
    /// Where the worker's CLI runs (a command without its own cwd runs here).
    cwd: Option<PathBuf>,
    redactor: Option<Arc<brigadier_providers::redact::Redactor>>,
}

/// A task's live worker.
pub(crate) struct TaskLive {
    pub id: TaskId,
    pub conversation_id: ConversationId,
    state: tokio::sync::Mutex<TaskLiveState>,
}

impl TaskLive {
    fn new(id: TaskId, conversation_id: ConversationId) -> Self {
        Self {
            id,
            conversation_id,
            state: tokio::sync::Mutex::new(TaskLiveState::default()),
        }
    }

    /// Ends the worker's CLI session (interrupting first; Codex keeps running its current
    /// command after an interrupt, so the session is closed, which ends its process tree).
    pub async fn close_cli(&self) {
        let cli = {
            let mut state = self.state.lock().await;
            state.stopping = true;
            state.question = None;
            state.cli.take()
        };
        if let Some(cli) = cli {
            let _ = tokio::time::timeout(Duration::from_secs(2), cli.session.interrupt()).await;
            cli.session.close().await;
            cli.ended.cancelled().await;
        }
    }

    /// After a deliberate close (hibernation) the worker may be started again.
    pub async fn allow_revival(&self) {
        let mut state = self.state.lock().await;
        state.stopping = false;
        state.busy = false;
    }

    pub async fn redactor(&self) -> Option<Arc<brigadier_providers::redact::Redactor>> {
        self.state.lock().await.redactor.clone()
    }

    pub async fn cwd(&self) -> Option<PathBuf> {
        self.state.lock().await.cwd.clone()
    }
}

impl SessionManager {
    fn task_live(&self, task: &Task) -> Arc<TaskLive> {
        self.tasks_lock()
            .entry(task.id.clone())
            .or_insert_with(|| {
                Arc::new(TaskLive::new(task.id.clone(), task.conversation_id.clone()))
            })
            .clone()
    }

    /// The session's permission level.
    pub(crate) fn permission(&self, id: &ConversationId) -> PermissionLevel {
        match self.core.conversation(id).map(|c| c.setup) {
            Ok(Some(Setup::Session { permission, .. })) => permission,
            _ => PermissionLevel::ApproveForMe,
        }
    }

    /// How many workers each provider runs now, so parallel work spreads across vendors.
    fn running_workers(&self) -> Vec<(ProviderKind, u32)> {
        let mut claude = 0;
        let mut codex = 0;
        for live in self.tasks_lock().values() {
            match live
                .state
                .try_lock()
                .ok()
                .and_then(|s| s.cli.as_ref().map(|c| c.provider))
            {
                Some(ProviderKind::Claude) => claude += 1,
                Some(ProviderKind::Codex) => codex += 1,
                None => {}
            }
        }
        vec![(ProviderKind::Claude, claude), (ProviderKind::Codex, codex)]
    }

    pub(crate) fn existing_task_live(&self, id: &TaskId) -> Option<Arc<TaskLive>> {
        self.tasks_lock().get(id).cloned()
    }

    /// A task of the conversation by its reference: `task-3`, `3`, or its id.
    pub(crate) async fn find_task(
        &self,
        conversation_id: &ConversationId,
        reference: &str,
    ) -> Result<Task> {
        let reference = reference.trim();
        let number = reference
            .trim_start_matches("task-")
            .trim_start_matches('#')
            .parse::<u32>()
            .ok();
        let tasks = self.core.tasks(conversation_id).await?;
        tasks
            .into_iter()
            .find(|task| Some(task.number) == number || task.id.0 == reference)
            .ok_or_else(|| Error::NotFound(format!("{reference} (use list_tasks)")))
    }

    pub(crate) async fn task_by_id(
        &self,
        conversation_id: &ConversationId,
        id: &TaskId,
    ) -> Result<Task> {
        let board = self.core.board(conversation_id).await?;
        board
            .tasks
            .get(id)
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("task {id}")))
    }

    /// Changes a task and records it.
    pub(crate) async fn update_task(
        &self,
        conversation_id: &ConversationId,
        id: &TaskId,
        change: impl FnOnce(&mut Task),
    ) -> Result<Task> {
        let mut task = self.task_by_id(conversation_id, id).await?;
        change(&mut task);
        task.updated_at_ms = now_ms();
        self.core
            .record_conversation(
                conversation_id,
                vec![DomainEvent::TaskUpdated {
                    task: Box::new(task.clone()),
                }],
            )
            .await?;
        Ok(task)
    }

    pub(crate) async fn set_task_state(
        &self,
        conversation_id: &ConversationId,
        id: &TaskId,
        state: TaskState,
    ) -> Result<Task> {
        self.update_task(conversation_id, id, |task| {
            task.state = state;
            if state != TaskState::Blocked {
                task.blocked_reason = None;
            }
        })
        .await
    }

    /// Marks a task blocked (with why) or running again.
    pub(crate) async fn set_task_blocked(&self, id: &TaskId, reason: Option<String>) {
        let Some(live) = self.existing_task_live(id) else {
            return;
        };
        let result = self
            .update_task(&live.conversation_id, id, |task| {
                if task.state.is_final() {
                    return;
                }
                match &reason {
                    Some(reason) => {
                        task.state = TaskState::Blocked;
                        task.blocked_reason = Some(reason.clone());
                    }
                    None if task.state == TaskState::Blocked => {
                        task.state = TaskState::Running;
                        task.blocked_reason = None;
                    }
                    None => {}
                }
            })
            .await;
        if let Err(err) = result {
            tracing::debug!(task = %id, error = %err, "could not update a task");
        }
    }

    /// Creates a task and starts its worker in the background.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn create_task(
        &self,
        conversation_id: &ConversationId,
        title: String,
        kind: TaskKind,
        spec: String,
        pin: Option<brigadier_router::Pin>,
        avoid: Option<brigadier_router::Author>,
        subject: Option<Task>,
        attachments: Vec<AttachmentRef>,
    ) -> Result<Task> {
        self.admit()?;
        let conversation = self.core.conversation(conversation_id)?;
        let Some(Setup::Session { permission, .. }) = &conversation.setup else {
            return Err(Error::Invalid("tasks belong to a session".into()));
        };
        let available = self.availability();
        let running = self.running_workers();
        let cross_checked = avoid.is_some();
        let choice = brigadier_router::route(&brigadier_router::RouteRequest {
            category: category(kind),
            available: &available,
            pin,
            avoid,
            running: &running,
        })
        .map_err(|err| Error::Invalid(err.to_string()))?;
        let choice = cheap_for_development(choice, &available);
        let reason = match (cross_checked, choice.cross_vendor) {
            (true, Some(false)) => format!(
                "{} (not cross-vendor: only one vendor is available)",
                choice.reason
            ),
            _ => choice.reason.clone(),
        };
        let number = self.core.next_task_number(conversation_id).await?;
        let now = now_ms();
        let task = Task {
            id: TaskId::generate(),
            conversation_id: conversation_id.clone(),
            number,
            position: 0,
            title: title.trim().to_owned(),
            kind,
            spec,
            access: access_for(kind, *permission),
            route: Route {
                choice: ModelChoice {
                    provider: choice.provider,
                    model: choice.model.clone(),
                    effort: choice.effort.clone(),
                },
                reason,
            },
            state: TaskState::Queued,
            subject: subject.as_ref().map(|task| task.id.clone()),
            plan: None,
            attachments,
            workspace: None,
            report: None,
            candidate: None,
            review: None,
            landed: None,
            blocked_reason: None,
            error: None,
            kept: None,
            outputs: Vec::new(),
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.core
            .record_conversation(
                conversation_id,
                vec![DomainEvent::TaskUpdated {
                    task: Box::new(task.clone()),
                }],
            )
            .await?;
        let live = self.task_live(&task);
        let manager = self.arc();
        let started = task.clone();
        self.spawn(async move {
            if let Err(err) = manager.start_worker(&live, started.clone(), subject).await {
                manager.worker_failed(&started, &err.to_string()).await;
            }
        });
        Ok(task)
    }

    async fn start_worker(
        &self,
        live: &Arc<TaskLive>,
        task: Task,
        subject: Option<Task>,
    ) -> Result<()> {
        let conversation_id = task.conversation_id.clone();
        self.set_task_state(&conversation_id, &task.id, TaskState::Starting)
            .await?;
        let owner = format!("task:{}", task.id);
        let workspace = self
            .prepare_workspace(&owner, &task, subject.as_ref())
            .await?;
        let task = self
            .update_task(&conversation_id, &task.id, |t| {
                t.workspace = Some(TaskWorkspace {
                    worktree: workspace
                        .worktree
                        .as_ref()
                        .map(|p| p.to_string_lossy().into_owned()),
                    branch: workspace.branch.clone(),
                    base: workspace.base.as_ref().map(|oid| oid.0.clone()),
                    on_snapshot: workspace.on_snapshot,
                    target: workspace.target.clone(),
                    scratch: workspace.scratch.to_string_lossy().into_owned(),
                });
            })
            .await?;
        let files = self.worker_files(&task, &workspace.scratch).await;
        self.launch_worker(
            live,
            &task,
            subject.as_ref(),
            Origin::New,
            TurnInput {
                text: "Start the task.".into(),
                files,
            },
        )
        .await
    }

    /// Starts (or resumes) the worker's CLI session in the task's prepared workspace and sends
    /// it `first`.
    async fn launch_worker(
        &self,
        live: &Arc<TaskLive>,
        task: &Task,
        subject: Option<&Task>,
        origin: Origin,
        first: TurnInput,
    ) -> Result<()> {
        let conversation_id = task.conversation_id.clone();
        let owner = format!("task:{}", task.id);
        let recorded = task
            .workspace
            .clone()
            .ok_or_else(|| Error::Invalid("the task has no workspace".into()))?;
        let conversation = self.core.conversation(&conversation_id)?;
        let Some(Setup::Session { repo, .. }) = &conversation.setup else {
            return Err(Error::Invalid("tasks belong to a session".into()));
        };
        let workspace = Workspace {
            repo: PathBuf::from(repo),
            worktree: recorded.worktree.map(PathBuf::from),
            branch: recorded.branch,
            base: recorded.base.map(Oid),
            on_snapshot: recorded.on_snapshot,
            target: recorded.target,
            scratch: PathBuf::from(recorded.scratch),
        };
        let project = conversation
            .project_id
            .as_ref()
            .and_then(|id| self.core.project(id).ok());
        let secret_files = project
            .as_ref()
            .map(|p| p.prefs.secret_files.clone())
            .unwrap_or_default();
        let mut secret_values = match (&workspace.worktree, &origin) {
            (Some(worktree), Origin::New) => {
                secrets::copy_secrets(self, &owner, &workspace.repo, worktree, &secret_files)
                    .await?
            }
            _ => secrets::values(&workspace.repo, &secret_files).await,
        };

        let provider = task.route.choice.provider;
        let write = task.kind.writes();
        // Codex cannot run with a read-only cwd: a read-only Codex worker works from its
        // scratch folder and reads the worktree by path.
        let cwd = match (&workspace.worktree, provider, write) {
            (Some(worktree), ProviderKind::Claude, _) | (Some(worktree), _, true) => {
                worktree.clone()
            }
            _ => workspace.scratch.clone(),
        };
        let repo_note = match (&workspace.worktree, write) {
            (Some(worktree), true) => format!(
                "Your worktree (a checkout of the repository on branch `{}`): {}\nYour scratch folder: {}",
                workspace.branch.clone().unwrap_or_default(),
                worktree.display(),
                workspace.scratch.display()
            ),
            (Some(worktree), false) => format!(
                "A read-only checkout of the repository: {}\nYour scratch folder (writable): {}",
                worktree.display(),
                workspace.scratch.display()
            ),
            (None, _) => format!(
                "There is no repository checkout for this task. Your scratch folder: {}",
                workspace.scratch.display()
            ),
        };
        let outputs = outputs_dir(&workspace.scratch);
        let repo_note = format!(
            "{repo_note}\nYour outputs folder (files for the orchestrator and the user): {}",
            outputs.display()
        );
        blocking(move || {
            std::fs::create_dir_all(&outputs).map_err(|err| Error::Invalid(err.to_string()))
        })
        .await?;
        let native = match &workspace.worktree {
            Some(worktree) => instructions::for_worker(provider, worktree).await,
            None => String::new(),
        };
        let extra = match (&task.kind, subject) {
            (TaskKind::Review, Some(subject)) => self.review_brief(subject).await,
            (TaskKind::Merge, Some(subject)) => self.merge_brief(subject).await,
            _ => String::new(),
        };
        let prompt = prompts::worker(task, &repo_note, &native, &extra);

        let access = self.worker_access(task, &workspace, &cwd);
        let worker_grant = self.grants.issue(
            &owner,
            Role::Worker {
                conversation_id: conversation_id.clone(),
                task_id: task.id.clone(),
            },
        );
        let gate_grant = self.grants.issue(
            &owner,
            Role::Gate {
                conversation_id: conversation_id.clone(),
                task_id: Some(task.id.clone()),
            },
        );
        // B7: the grants are secrets too.
        secret_values.push(worker_grant.clone());
        secret_values.push(gate_grant.clone());
        let redactor = secrets::redactor(secret_values);
        let spec = SessionSpec {
            cwd: cwd.clone(),
            model: task.route.choice.model.clone(),
            effort: task.route.choice.effort.clone(),
            origin,
            access: access.clone(),
            append_system_prompt: Some(prompt),
            mcp_servers: vec![self.brigadier_server(worker_grant, WORKER_TOOL_TIMEOUT_SECS)],
            tools: ToolSet::Default,
            env: vec![
                ("BRIGADIER_GATE".into(), gate_grant),
                (
                    "TMPDIR".into(),
                    workspace.scratch.to_string_lossy().into_owned(),
                ),
            ],
            path_prepend: self.config.gate_dir.iter().cloned().collect(),
            record_to: None,
            redactor: redactor.clone(),
            owned_cwd: true,
        };
        let Started { session, events } =
            match self.runtime.start_hosted(&owner, provider, spec).await {
                Ok(started) => started,
                Err(err) => {
                    self.grants.revoke_owner(&owner);
                    return Err(err);
                }
            };
        let cli = Arc::new(Cli {
            provider,
            model: task.route.choice.clone(),
            session,
            owner,
            ended: CancellationToken::new(),
        });
        {
            let mut state = live.state.lock().await;
            state.cli = Some(cli.clone());
            state.access = Some(access);
            state.cwd = Some(cwd);
            state.redactor = redactor;
            state.busy = true;
            state.stopping = false;
        }
        let manager = self.arc();
        let pumped = (live.clone(), cli.clone());
        self.spawn(async move { manager.pump_worker(pumped.0, pumped.1, events).await });
        self.set_task_state(&conversation_id, &task.id, TaskState::Running)
            .await?;
        cli.session
            .send(first)
            .await
            .map_err(|err| Error::Provider(err.to_string()))
    }

    /// Starts a worker whose CLI session stopped (the conversation hibernated) again,
    /// resuming its CLI session.
    async fn revive_worker(&self, live: &Arc<TaskLive>, task: &Task, text: String) -> Result<()> {
        let native_id = self.last_worker_native_id(&task.id).await.ok_or_else(|| {
            Error::Invalid(format!(
                "task-{} cannot be resumed; delegate a new task",
                task.number
            ))
        })?;
        let subject = match &task.subject {
            Some(id) => self.task_by_id(&task.conversation_id, id).await.ok(),
            None => None,
        };
        self.update_task(&task.conversation_id, &task.id, |t| {
            t.candidate = None;
            t.review = None;
        })
        .await?;
        self.launch_worker(
            live,
            task,
            subject.as_ref(),
            Origin::Resume { native_id },
            TurnInput {
                text,
                files: Vec::new(),
            },
        )
        .await
    }

    async fn last_worker_native_id(&self, id: &TaskId) -> Option<String> {
        let page = self
            .core
            .store()
            .read_stream(
                streams::task(id),
                brigadier_store::StreamPage {
                    before: None,
                    kinds: vec!["worker.event".into()],
                    limit: 1_000,
                },
            )
            .await
            .ok()?;
        page.into_iter().find_map(|stored| {
            match serde_json::from_str::<DomainEvent>(stored.payload.get()) {
                Ok(DomainEvent::WorkerEvent {
                    event: ProviderEvent::SessionStarted { native_id, .. },
                    ..
                }) => Some(native_id),
                _ => None,
            }
        })
    }

    /// B12: what the worker may touch.
    fn worker_access(&self, task: &Task, workspace: &Workspace, cwd: &Path) -> Access {
        if task.access.unsandboxed {
            return Access::Full;
        }
        // A worker working from its scratch folder writes there (Codex needs a writable cwd);
        // one in a worktree writes to the worktree only for write tasks.
        let in_scratch = cwd == workspace.scratch;
        let write_cwd = in_scratch || task.kind.writes();
        let mut writable_roots = if in_scratch {
            Vec::new()
        } else {
            vec![workspace.scratch.clone()]
        };
        if task.kind == TaskKind::Verify
            && let Some(worktree) = &workspace.worktree
        {
            // Checks write build output inside the checkout; nothing from it lands.
            writable_roots.push(worktree.clone());
        }
        let run_dir = self.runtime.platform().paths().run_dir.clone();
        Access::Scoped {
            write_cwd,
            writable_roots,
            network: task.access.network,
            deny_read: vec![run_dir],
            unix_sockets: self.socket_path().into_iter().collect(),
        }
    }

    /// Creates the task's scratch folder and worktree, recorded in the ledger first.
    async fn prepare_workspace(
        &self,
        owner: &str,
        task: &Task,
        subject: Option<&Task>,
    ) -> Result<Workspace> {
        let conversation = self.core.conversation(&task.conversation_id)?;
        let Some(Setup::Session {
            repo, environment, ..
        }) = &conversation.setup
        else {
            return Err(Error::Invalid("tasks belong to a session".into()));
        };
        let scratch = self.owned_dir("scratch", &task.id.0);
        self.prepare_owned_dir(owner, &scratch).await?;
        let repo = PathBuf::from(repo);
        if task.access.repo == RepoAccess::None {
            return Ok(Workspace {
                repo,
                worktree: None,
                branch: None,
                base: None,
                on_snapshot: false,
                target: None,
                scratch,
            });
        }
        let target = self
            .ensure_target(&task.conversation_id, &repo, environment)
            .await?;
        // Reviews and checks look at the candidate commit; a merge task continues from the
        // conflicting task's work (kept as a WIP commit on its branch).
        let (base, start, on_snapshot) = match (task.kind, subject) {
            (TaskKind::Review | TaskKind::Verify, Some(subject)) if subject.candidate.is_some() => {
                let commit = Oid(subject
                    .candidate
                    .as_ref()
                    .map(|c| c.commit.clone())
                    .unwrap_or_default());
                (commit.clone(), commit, false)
            }
            (TaskKind::Merge, Some(subject)) => {
                let (base, start) = self.merge_start(subject).await?;
                (base, start, false)
            }
            _ => {
                let (base, on_snapshot) = self
                    .worker_base(&task.conversation_id, &repo, &target)
                    .await?;
                (base.clone(), base, on_snapshot)
            }
        };
        let project = conversation
            .project_id
            .as_ref()
            .map(|id| id.0.clone())
            .unwrap_or_else(|| "none".into());
        let worktree = self.owned_dir("worktrees", &project).join(format!(
            "task-{}-{}",
            task.number,
            &task.id.0[task.id.0.len() - 8..]
        ));
        let branch = task
            .kind
            .writes()
            .then(|| task_branch(&task.conversation_id, task.number, &task.title));
        let ledger = self.runtime.ledger();
        ledger
            .record(
                owner,
                Artifact::Worktree {
                    repo: repo.to_string_lossy().into_owned(),
                    path: worktree.to_string_lossy().into_owned(),
                },
            )
            .await?;
        ledger
            .record(
                owner,
                Artifact::ProcessesIn {
                    dir: worktree.to_string_lossy().into_owned(),
                },
            )
            .await?;
        let (git, repo_path, path, spec) = (
            self.git.clone(),
            repo.clone(),
            worktree.clone(),
            match &branch {
                Some(name) => WorktreeSpec::NewBranch {
                    name: name.clone(),
                    start: start.clone(),
                },
                None => WorktreeSpec::Detached { at: start.clone() },
            },
        );
        blocking(move || {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|err| Error::Invalid(err.to_string()))?;
            }
            let repo = git.open(&repo_path).map_err(git_error)?;
            repo.add_worktree(&path, spec)
                .map(|_| ())
                .map_err(git_error)
        })
        .await?;
        Ok(Workspace {
            repo,
            worktree: Some(worktree),
            branch,
            base: Some(base),
            on_snapshot,
            target: Some(target),
            scratch,
        })
    }

    /// The branch accepted work lands on, created for a new-worktree session on first use
    /// (with the session's own worktree).
    pub(crate) async fn ensure_target(
        &self,
        conversation_id: &ConversationId,
        repo: &Path,
        environment: &Environment,
    ) -> Result<String> {
        match environment {
            Environment::LocalCheckout { branch } => Ok(branch.clone()),
            Environment::NewWorktree { base, branch, path } => {
                if path.is_some() {
                    return Ok(branch.clone());
                }
                // Parallel first tasks: one creates the worktree, the others then find it.
                let _creating = self.session_worktrees.lock().await;
                let conversation = self.core.conversation(conversation_id)?;
                if let Some(Setup::Session {
                    environment: Environment::NewWorktree { path: Some(_), .. },
                    ..
                }) = &conversation.setup
                {
                    return Ok(branch.clone());
                }
                let owner = format!("session:{conversation_id}");
                let project = conversation
                    .project_id
                    .as_ref()
                    .map(|id| id.0.clone())
                    .unwrap_or_else(|| "none".into());
                let worktree = self
                    .owned_dir("worktrees", &project)
                    .join(format!("session-{}", conversation_id.short()));
                self.runtime
                    .ledger()
                    .record(
                        &owner,
                        Artifact::Worktree {
                            repo: repo.to_string_lossy().into_owned(),
                            path: worktree.to_string_lossy().into_owned(),
                        },
                    )
                    .await?;
                let (git, repo_path, path, base_name, name) = (
                    self.git.clone(),
                    repo.to_owned(),
                    worktree.clone(),
                    base.clone(),
                    branch.clone(),
                );
                blocking(move || {
                    let repo = git.open(&repo_path).map_err(git_error)?;
                    if let Some(parent) = path.parent() {
                        std::fs::create_dir_all(parent)
                            .map_err(|err| Error::Invalid(err.to_string()))?;
                    }
                    let spec = match repo.branch_tip(&name).map_err(git_error)? {
                        Some(_) => WorktreeSpec::Branch { name },
                        None => WorktreeSpec::NewBranch {
                            name,
                            start: repo.branch_commit(&base_name).map_err(git_error)?,
                        },
                    };
                    repo.add_worktree(&path, spec)
                        .map(|_| ())
                        .map_err(git_error)
                })
                .await?;
                if let Some(Setup::Session {
                    repo,
                    permission,
                    orchestrator,
                    workers_see_uncommitted,
                    ..
                }) = conversation.setup
                {
                    self.core
                        .set_setup(
                            conversation_id.clone(),
                            Setup::Session {
                                repo,
                                environment: Environment::NewWorktree {
                                    base: base.clone(),
                                    branch: branch.clone(),
                                    path: Some(worktree.to_string_lossy().into_owned()),
                                },
                                permission,
                                orchestrator,
                                workers_see_uncommitted,
                            },
                        )
                        .await?;
                }
                Ok(branch.clone())
            }
        }
    }

    /// Where workers start: the target's tip, or a snapshot of the user's uncommitted changes
    /// on top of it when the user chose to show them (local checkout only; then `true`).
    async fn worker_base(
        &self,
        conversation_id: &ConversationId,
        repo: &Path,
        target: &str,
    ) -> Result<(Oid, bool)> {
        let (git, repo_path, branch) = (self.git.clone(), repo.to_owned(), target.to_owned());
        let (tip, dirty, current) = blocking(move || {
            let repo = git.open(&repo_path).map_err(git_error)?;
            let tip = repo
                .branch_tip(&branch)
                .map_err(git_error)?
                .ok_or_else(|| Error::Invalid(format!("branch {branch} does not exist")))?;
            let state = repo.state().map_err(git_error)?;
            Ok((tip, state.dirty_files, state.current_branch))
        })
        .await?;
        let conversation = self.core.conversation(conversation_id)?;
        let Some(Setup::Session {
            environment: Environment::LocalCheckout { branch },
            workers_see_uncommitted,
            ..
        }) = conversation.setup
        else {
            return Ok((tip, false));
        };
        // Uncommitted changes matter only when they sit on the target branch.
        if dirty.is_empty() || current.as_deref() != Some(branch.as_str()) {
            return Ok((tip, false));
        }
        let see = match workers_see_uncommitted {
            Some(see) => see,
            None => self.ask_about_uncommitted(conversation_id, dirty).await?,
        };
        if !see {
            return Ok((tip, false));
        }
        let (git, repo_path) = (self.git.clone(), repo.to_owned());
        blocking(move || {
            let repo = git.open(&repo_path).map_err(git_error)?;
            Ok(repo
                .snapshot_uncommitted()
                .map_err(git_error)?
                .map(|snapshot| (snapshot.commit, true))
                .unwrap_or((tip, false)))
        })
        .await
    }

    /// Asks once whether workers see the user's uncommitted changes; tasks wait for it.
    async fn ask_about_uncommitted(
        &self,
        conversation_id: &ConversationId,
        files: Vec<String>,
    ) -> Result<bool> {
        // Only one card at a time: later tasks wait for the same answer.
        let board = self.core.board(conversation_id).await?;
        let open = board.questions.values().find(|q| {
            q.answer.is_none() && matches!(q.kind, QuestionKind::UncommittedChanges { .. })
        });
        let rx = match open {
            Some(question) => self.waiters_for_question(question.id.clone()),
            None => {
                let shown: Vec<String> = files.iter().take(50).cloned().collect();
                let (_, rx) = self
                    .open_question(
                        conversation_id,
                        None,
                        QuestionKind::UncommittedChanges { files: shown },
                        format!(
                            "Your checkout has {} uncommitted change{}. Should workers see them? They are never committed either way.",
                            files.len(),
                            if files.len() == 1 { "" } else { "s" }
                        ),
                        vec!["Yes, show them to workers".into(), "No, use the last commit".into()],
                    )
                    .await?;
                rx
            }
        };
        rx.await.map_err(|_| {
            Error::Invalid("the question about uncommitted changes was withdrawn".into())
        })?;
        let conversation = self.core.conversation(conversation_id)?;
        Ok(matches!(
            conversation.setup,
            Some(Setup::Session {
                workers_see_uncommitted: Some(true),
                ..
            })
        ))
    }

    fn waiters_for_question(
        &self,
        id: crate::work::CardId,
    ) -> oneshot::Receiver<super::cards::CardAnswer> {
        self.waiters.register(id)
    }

    /// The user's attachments the task was given, written into its scratch folder.
    async fn worker_files(&self, task: &Task, scratch: &Path) -> Vec<InputFile> {
        let mut files = Vec::new();
        for attachment in &task.attachments {
            let Ok(hash) = attachment.id.parse::<brigadier_store::BlobHash>() else {
                continue;
            };
            let Ok(Some(bytes)) = self.core.store().blobs().get(hash).await else {
                continue;
            };
            let path = scratch
                .join("attachments")
                .join(safe_file_name(&attachment.name));
            let target = path.clone();
            let written = blocking(move || {
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|err| Error::Invalid(err.to_string()))?;
                }
                std::fs::write(&target, bytes).map_err(|err| Error::Invalid(err.to_string()))
            })
            .await;
            if written.is_ok() {
                files.push(InputFile {
                    path,
                    name: attachment.name.clone(),
                    mime: attachment.mime.clone(),
                });
            }
        }
        files
    }

    /// Stores a worker's events on `task:<id>`, answering its approvals on the way.
    async fn pump_worker(
        self: Arc<Self>,
        live: Arc<TaskLive>,
        cli: Arc<Cli>,
        mut events: mpsc::Receiver<ProviderEvent>,
    ) {
        let mut deltas: Vec<ProviderEvent> = Vec::new();
        let mut deadline: Option<tokio::time::Instant> = None;
        loop {
            let flush_at = async {
                match deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                event = events.recv() => match event {
                    Some(event) if is_delta(&event) => {
                        merge_delta(&mut deltas, event);
                        deadline.get_or_insert_with(|| tokio::time::Instant::now() + DELTA_WINDOW);
                    }
                    Some(event) => {
                        deadline = None;
                        self.record_worker_events(&live.id, std::mem::take(&mut deltas)).await;
                        let exited = matches!(event, ProviderEvent::Exited { .. });
                        self.on_worker_event(&live, &cli, event).await;
                        if exited {
                            break;
                        }
                    }
                    None => break,
                },
                () = flush_at => {
                    deadline = None;
                    self.record_worker_events(&live.id, std::mem::take(&mut deltas)).await;
                }
            }
        }
        self.record_worker_events(&live.id, deltas).await;
        self.grants.revoke_owner(&cli.owner);
        let stopping = {
            let mut state = live.state.lock().await;
            if state.cli.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cli)) {
                state.cli = None;
            }
            state.busy = false;
            state.question = None;
            state.stopping
        };
        cli.ended.cancel();
        if !stopping
            && let Ok(task) = self.task_by_id(&live.conversation_id, &live.id).await
            && !task.state.is_final()
            && task.report.is_none()
        {
            self.worker_failed(&task, "The worker's CLI exited before it reported.")
                .await;
        }
    }

    async fn on_worker_event(&self, live: &Arc<TaskLive>, cli: &Arc<Cli>, event: ProviderEvent) {
        match &event {
            ProviderEvent::ApprovalRequested { request } => {
                let request = request.clone();
                self.record_worker_event(&live.id, event).await;
                self.route_worker_approval(live, cli, request).await;
                return;
            }
            ProviderEvent::RateLimits { quota } => {
                self.runtime.note_quota_snapshot(quota.clone()).await;
            }
            _ => {}
        }
        let completed = match &event {
            ProviderEvent::TurnCompleted { status, .. } => Some(*status),
            _ => None,
        };
        let error = match &event {
            ProviderEvent::Error { error } if !error.will_retry => Some(error.message.clone()),
            _ => None,
        };
        self.record_worker_event(&live.id, event).await;
        if let Some(message) = error {
            self.update_task(&live.conversation_id, &live.id, |task| {
                task.error = Some(message);
            })
            .await
            .ok();
        }
        if let Some(status) = completed {
            self.worker_turn_completed(live, cli, status).await;
        }
    }

    async fn worker_turn_completed(
        &self,
        live: &Arc<TaskLive>,
        cli: &Arc<Cli>,
        status: TurnStatus,
    ) {
        let nudge = {
            let mut state = live.state.lock().await;
            state.busy = false;
            if state.stopping {
                return;
            }
            let nudge = !state.nudged;
            state.nudged = true;
            nudge
        };
        let Ok(task) = self.task_by_id(&live.conversation_id, &live.id).await else {
            return;
        };
        if task.state == TaskState::Paused || task.state.is_final() {
            return;
        }
        if task.report.is_some() && task.state != TaskState::Running {
            // Reported; the worker waits (write tasks can be sent back to fix things).
            if !task.kind.writes() {
                // Not from inside the worker's own event pump: closing waits for it.
                let manager = self.arc();
                self.spawn(async move { manager.finish_read_task(&task).await });
            }
            return;
        }
        if status == TurnStatus::Interrupted {
            return;
        }
        if nudge {
            live.state.lock().await.busy = true;
            let sent = cli
                .session
                .send(TurnInput {
                    text: "You ended your turn without calling submit_report. If the task is done or you cannot continue, call submit_report now; otherwise continue working.".into(),
                    files: Vec::new(),
                })
                .await;
            if sent.is_ok() {
                return;
            }
        }
        let reason = task
            .error
            .clone()
            .unwrap_or_else(|| "The worker stopped without a report.".into());
        let manager = self.arc();
        self.spawn(async move { manager.worker_failed(&task, &reason).await });
    }

    /// B7 for worker approvals: routed by the task's access; anything else asks the user.
    async fn route_worker_approval(
        &self,
        live: &Arc<TaskLive>,
        cli: &Arc<Cli>,
        request: ApprovalRequest,
    ) {
        let access = live
            .state
            .lock()
            .await
            .access
            .clone()
            .unwrap_or(Access::ReadOnly);
        let mut route = policy::route(&request, &access, ApprovalMode::Delegated);
        let outward = request.command.as_deref().is_some_and(policy::is_outward);
        // Approve for me stays sandboxed and stops only for what only the user can decide:
        // Brigadier declines anything else outside the task's access on the user's behalf.
        // Outward actions always ask.
        if route == PolicyRoute::AskUser
            && !outward
            && self.permission(&live.conversation_id) != PermissionLevel::AskForApproval
        {
            route = PolicyRoute::Deny;
        }
        match route {
            PolicyRoute::Allow | PolicyRoute::Deny => {
                let decision = if route == PolicyRoute::Allow {
                    ApprovalDecision::Allow
                } else {
                    ApprovalDecision::Deny {
                        message: "Declined by Brigadier: stay inside your sandbox (your worktree and scratch folder). If the task truly needs more, say so in your report.".into(),
                    }
                };
                if let Err(err) = cli
                    .session
                    .answer(request.id.clone(), decision.clone())
                    .await
                {
                    tracing::warn!(task = %live.id, error = %err, "could not answer an approval");
                    return;
                }
                self.record_worker_resolution(&live.id, request.id, decision, Decider::Policy)
                    .await;
            }
            PolicyRoute::AskUser => {
                let what = request
                    .command
                    .clone()
                    .unwrap_or_else(|| request.tool.clone());
                if let Err(err) = self
                    .open_approval(
                        &live.conversation_id,
                        Some(live.id.clone()),
                        ApprovalSubject::Cli { request },
                    )
                    .await
                {
                    tracing::warn!(task = %live.id, error = %err, "could not open an approval card");
                    return;
                }
                self.set_task_blocked(&live.id, Some(format!("Waiting for approval: {what}")))
                    .await;
            }
        }
    }

    /// Passes the user's answer to the worker's CLI.
    pub(crate) async fn answer_worker_approval(
        &self,
        task_id: &TaskId,
        approval_id: String,
        decision: ApprovalDecision,
    ) -> Result<()> {
        let live = self
            .existing_task_live(task_id)
            .ok_or_else(|| Error::Invalid("the worker has ended".into()))?;
        let cli = live
            .state
            .lock()
            .await
            .cli
            .clone()
            .ok_or_else(|| Error::Invalid("the worker has ended".into()))?;
        cli.session
            .answer(approval_id.clone(), decision.clone())
            .await
            .map_err(|err| Error::Provider(err.to_string()))?;
        self.record_worker_resolution(task_id, approval_id, decision, Decider::User)
            .await;
        self.set_task_blocked(task_id, None).await;
        Ok(())
    }

    pub(crate) async fn record_worker_event(&self, task_id: &TaskId, event: ProviderEvent) {
        self.record_worker_events(task_id, vec![event]).await;
    }

    async fn record_worker_events(&self, task_id: &TaskId, events: Vec<ProviderEvent>) {
        if events.is_empty() {
            return;
        }
        let stream = streams::task(task_id);
        let events = events
            .into_iter()
            .map(|event| {
                (
                    stream.clone(),
                    DomainEvent::WorkerEvent {
                        task_id: task_id.clone(),
                        event,
                    },
                )
            })
            .collect();
        if let Err(err) = self.core.record(events).await {
            tracing::debug!(task = %task_id, error = %err, "could not store worker events");
        }
    }

    /// `ask_orchestrator`: blocks the worker until the orchestrator answers.
    pub(crate) async fn worker_question(
        &self,
        conversation_id: &ConversationId,
        task_id: &TaskId,
        question: String,
    ) -> Result<String> {
        let live = self
            .existing_task_live(task_id)
            .ok_or_else(|| Error::Invalid("the task has ended".into()))?;
        let task = self.task_by_id(conversation_id, task_id).await?;
        let question = self.redact_for(&live, &question).await;
        let (tx, rx) = oneshot::channel();
        live.state.lock().await.question = Some(tx);
        self.set_task_blocked(task_id, Some(format!("Asked the orchestrator: {question}")))
            .await;
        self.deliver(
            conversation_id,
            Envelope {
                kind: InjectionKind::WorkerQuestion,
                label: format!("question from task-{}", task.number),
                task_id: Some(task_id.clone()),
                text: format!(
                    "[question from task-{} \"{}\"]\n{question}\n[/question] Answer it with message_worker (task-{}); the worker waits.",
                    task.number, task.title, task.number
                ),
            },
        )
        .await;
        let answer = tokio::time::timeout(QUESTION_TIMEOUT, rx).await;
        self.set_task_blocked(task_id, None).await;
        match answer {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(_)) => Err(Error::Invalid(
                "the question was withdrawn (the task ended)".into(),
            )),
            Err(_) => {
                live.state.lock().await.question = None;
                Err(Error::Invalid(
                    "The orchestrator did not answer within an hour. Continue with your best judgement and say so in the report.".into(),
                ))
            }
        }
    }

    /// `submit_report`: stores the worker's final report and hands it on.
    pub(crate) async fn worker_report(
        &self,
        conversation_id: &ConversationId,
        task_id: &TaskId,
        input: crate::tools::SubmitReport,
    ) -> Result<String> {
        let live = self
            .existing_task_live(task_id)
            .ok_or_else(|| Error::Invalid("the task has ended".into()))?;
        let task = self.task_by_id(conversation_id, task_id).await?;
        if task.state.is_final() {
            return Err(Error::Invalid("the task has already ended".into()));
        }
        let size = input.summary.len()
            + [
                &input.changes,
                &input.decisions,
                &input.verification,
                &input.open_questions,
            ]
            .iter()
            .flat_map(|items| items.iter())
            .map(|item| item.len() + 3)
            .sum::<usize>();
        if size > REPORT_MAX_BYTES {
            return Err(Error::Invalid(format!(
                "The report is {size} bytes; the limit is about {REPORT_MAX_BYTES} (≈800 tokens). Move the details into files in your scratch folder, attach them as artifacts, and submit a shorter report."
            )));
        }
        let scratch = task
            .workspace
            .as_ref()
            .map(|w| PathBuf::from(&w.scratch))
            .ok_or_else(|| Error::Invalid("the task has no workspace".into()))?;
        let mut artifacts = Vec::new();
        for artifact in &input.artifacts {
            artifacts.push(self.store_file_artifact(&live, &scratch, artifact).await?);
        }
        if let Some(diff) = self.diff_artifact(&live, &task).await {
            artifacts.push(diff);
        }
        let report = Report {
            summary: self.redact_for(&live, &input.summary).await,
            changes: input.changes.clone(),
            decisions: self.redact_all(&live, &input.decisions).await,
            verification: self.redact_all(&live, &input.verification).await,
            open_questions: self.redact_all(&live, &input.open_questions).await,
            verdict: input.verdict,
            artifacts,
            submitted_at_ms: now_ms(),
        };
        let task = self
            .update_task(conversation_id, task_id, |task| {
                task.report = Some(report.clone());
                task.state = TaskState::Reported;
                task.blocked_reason = None;
            })
            .await?;
        live.state.lock().await.nudged = true;
        if task.kind == TaskKind::Review && self.review_in_landing(&task).await {
            self.review_reported(&task).await;
        } else {
            let route = route_label(&task);
            self.deliver(
                conversation_id,
                Envelope {
                    kind: InjectionKind::Report,
                    label: format!("report task-{}", task.number),
                    task_id: Some(task.id.clone()),
                    text: prompts::report_envelope(&task, &report, &route),
                },
            )
            .await;
        }
        Ok("Report received. Your part is done: end your turn now.".into())
    }

    /// A file from the worker's scratch folder, stored as an artifact.
    async fn store_file_artifact(
        &self,
        live: &Arc<TaskLive>,
        scratch: &Path,
        input: &crate::tools::ArtifactInput,
    ) -> Result<ArtifactRef> {
        let path = {
            let given = PathBuf::from(&input.path);
            if given.is_absolute() {
                given
            } else {
                scratch.join(given)
            }
        };
        let (scratch_dir, file) = (scratch.to_owned(), path.clone());
        let bytes = blocking(move || {
            let real = std::fs::canonicalize(&file)
                .map_err(|err| Error::Invalid(format!("{}: {err}", file.display())))?;
            let root = std::fs::canonicalize(&scratch_dir)
                .map_err(|err| Error::Invalid(err.to_string()))?;
            if !real.starts_with(&root) {
                return Err(Error::Invalid(format!(
                    "{} is outside your scratch folder",
                    file.display()
                )));
            }
            let meta = std::fs::metadata(&real).map_err(|err| Error::Invalid(err.to_string()))?;
            if meta.len() > ARTIFACT_MAX_BYTES {
                return Err(Error::Invalid(format!(
                    "{} is larger than 8 MB",
                    file.display()
                )));
            }
            std::fs::read(&real).map_err(|err| Error::Invalid(err.to_string()))
        })
        .await?;
        let mime = mime_for(&path);
        let bytes = match (std::str::from_utf8(&bytes), live.redactor().await) {
            (Ok(text), Some(redactor)) => redactor.redact(text).into_owned().into_bytes(),
            _ => bytes,
        };
        let size = bytes.len() as u64;
        let hash = self.core.store().blobs().put(bytes).await?;
        Ok(ArtifactRef {
            id: hash.to_string(),
            title: input.title.clone(),
            kind: if mime.starts_with("image/") {
                ArtifactKind::Screenshot
            } else if mime == "text/markdown" {
                ArtifactKind::Note
            } else {
                ArtifactKind::File
            },
            mime,
            bytes: size,
            file_name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
        })
    }

    /// The worker's changes so far, as a diff artifact (write tasks).
    async fn diff_artifact(&self, live: &Arc<TaskLive>, task: &Task) -> Option<ArtifactRef> {
        let workspace = task.workspace.as_ref()?;
        if !task.kind.writes() {
            return None;
        }
        let (git, path, base) = (
            self.git.clone(),
            PathBuf::from(workspace.worktree.as_ref()?),
            Oid(workspace.base.clone()?),
        );
        let diff = blocking(move || {
            let worktree = git.open_worktree(&path).map_err(git_error)?;
            worktree.diff_from(&base).map_err(git_error)
        })
        .await
        .ok()?;
        if diff.is_empty() {
            return None;
        }
        let diff = self.redact_for(live, &diff).await;
        let bytes = diff.into_bytes();
        let size = bytes.len() as u64;
        let hash = self.core.store().blobs().put(bytes).await.ok()?;
        Some(ArtifactRef {
            id: hash.to_string(),
            title: format!("Diff of task-{}", task.number),
            kind: ArtifactKind::Diff,
            mime: "text/x-diff".into(),
            bytes: size,
            file_name: Some(format!("task-{}.diff", task.number)),
        })
    }

    async fn redact_all(&self, live: &Arc<TaskLive>, items: &[String]) -> Vec<String> {
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            out.push(self.redact_for(live, item).await);
        }
        out
    }

    pub(crate) async fn redact_for(&self, live: &Arc<TaskLive>, text: &str) -> String {
        match live.redactor().await {
            Some(redactor) => redactor.redact(text).into_owned(),
            None => text.to_owned(),
        }
    }

    /// `message_worker`: answers a blocking question, steers a running worker, or sends a
    /// reported worker back to work.
    pub(crate) async fn message_worker(
        &self,
        conversation_id: &ConversationId,
        task: &Task,
        text: String,
    ) -> Result<String> {
        let live = self.task_live(task);
        let mut state = live.state.lock().await;
        if let Some(waiter) = state.question.take() {
            let _ = waiter.send(text);
            return Ok(format!("Answered task-{}; it continues.", task.number));
        }
        if task.state.is_final() {
            return Err(Error::Invalid(format!("task-{} has ended", task.number)));
        }
        let Some(cli) = state.cli.clone() else {
            drop(state);
            self.revive_worker(
                &live,
                task,
                format!("Message from the orchestrator:\n{text}"),
            )
            .await?;
            return Ok(format!(
                "task-{} is working on it; a new report will follow.",
                task.number
            ));
        };
        let input = TurnInput {
            text: format!("Message from the orchestrator:\n{text}"),
            files: Vec::new(),
        };
        if state.busy {
            cli.session
                .steer(input)
                .await
                .map_err(|err| Error::Provider(err.to_string()))?;
            return Ok(format!("Sent to task-{} (it is working).", task.number));
        }
        if task.state.is_final() {
            return Err(Error::Invalid(format!("task-{} has ended", task.number)));
        }
        state.busy = true;
        state.nudged = false;
        drop(state);
        cli.session
            .send(input)
            .await
            .map_err(|err| Error::Provider(err.to_string()))?;
        self.update_task(conversation_id, &task.id, |task| {
            task.state = TaskState::Running;
            task.candidate = None;
            task.review = None;
        })
        .await?;
        Ok(format!(
            "task-{} is working on it; a new report will follow.",
            task.number
        ))
    }

    /// Stops a worker for good (`stop_worker`, or the user's stop button). Unfinished changes
    /// are kept on the task branch as a WIP commit.
    pub async fn stop_task(&self, task_id: TaskId) -> Result<()> {
        let conversation_id = self.conversation_of_task(&task_id).await?;
        let task = self.task_by_id(&conversation_id, &task_id).await?;
        if task.state.is_final() {
            return Ok(());
        }
        if let Some(live) = self.existing_task_live(&task_id) {
            live.close_cli().await;
        }
        self.dispose_task(&task, TaskState::Stopped).await;
        Ok(())
    }

    /// Restores a task's kept patch as a new branch on its target branch's current tip.
    pub async fn restore_kept_work(&self, task_id: TaskId) -> Result<crate::work::RestoreOutcome> {
        use crate::work::{KeptWork, RestoreOutcome};
        let conversation_id = self.conversation_of_task(&task_id).await?;
        let task = self.task_by_id(&conversation_id, &task_id).await?;
        let Some(KeptWork::Diff { artifact, restored }) = &task.kept else {
            return Err(Error::Invalid("this task kept no patch".into()));
        };
        if let Some(branch) = restored {
            return Err(Error::Invalid(format!("already restored as {branch}")));
        }
        let workspace = task
            .workspace
            .as_ref()
            .ok_or_else(|| Error::Invalid("the task has no workspace".into()))?;
        let target = workspace
            .target
            .clone()
            .ok_or_else(|| Error::Invalid("the task has no target branch".into()))?;
        let name = workspace
            .branch
            .clone()
            .unwrap_or_else(|| task_branch(&conversation_id, task.number, &task.title));
        let hash = artifact
            .id
            .parse()
            .map_err(|_| Error::Invalid(format!("{} is not an artifact id", artifact.id)))?;
        let patch = self
            .core
            .store()
            .blobs()
            .get(hash)
            .await?
            .ok_or_else(|| Error::NotFound("the saved patch".into()))?;
        let repo = self.task_repo(&task)?;
        let message = format!(
            "task-{} {} (restored from its saved patch)",
            task.number, task.title
        );
        let git = self.git.clone();
        let outcome = blocking(move || {
            let repo = git.open(&repo).map_err(git_error)?;
            let tip = repo
                .branch_tip(&target)
                .map_err(git_error)?
                .ok_or_else(|| Error::Invalid(format!("branch {target} does not exist")))?;
            // The task branch's own name while it is free.
            let mut branch = name.clone();
            let mut n = 1;
            while repo.branch_tip(&branch).map_err(git_error)?.is_some() {
                n += 1;
                branch = format!("{name}-restored-{n}");
            }
            Ok(
                match repo
                    .branch_from_patch(&branch, &tip, &patch, &message)
                    .map_err(git_error)?
                {
                    PatchOutcome::Applied { commit } => RestoreOutcome::Restored {
                        branch,
                        commit: commit.0,
                    },
                    PatchOutcome::Conflicts { paths } => RestoreOutcome::Conflicts { paths },
                    PatchOutcome::Failed { reason } => RestoreOutcome::Failed { reason },
                },
            )
        })
        .await?;
        if let RestoreOutcome::Restored { branch, .. } = &outcome {
            let branch = branch.clone();
            self.update_task(&conversation_id, &task_id, |t| {
                if let Some(KeptWork::Diff { restored, .. }) = &mut t.kept {
                    *restored = Some(branch);
                }
            })
            .await?;
        }
        Ok(outcome)
    }

    /// Pauses a worker: its turn is interrupted, the session stays.
    pub async fn pause_task(&self, task_id: TaskId) -> Result<()> {
        let conversation_id = self.conversation_of_task(&task_id).await?;
        let live = self
            .existing_task_live(&task_id)
            .ok_or_else(|| Error::Invalid("the worker has ended".into()))?;
        let cli = live.state.lock().await.cli.clone();
        if let Some(cli) = cli {
            cli.session
                .interrupt()
                .await
                .map_err(|err| Error::Provider(err.to_string()))?;
        }
        self.set_task_state(&conversation_id, &task_id, TaskState::Paused)
            .await?;
        if live
            .state
            .lock()
            .await
            .cli
            .as_ref()
            .is_some_and(|c| c.provider == ProviderKind::Codex)
        {
            self.notice(
                &conversation_id,
                brigadier_providers::NoticeLevel::Info,
                "Codex finishes the command it is running before it pauses.",
            )
            .await;
        }
        Ok(())
    }

    /// Resumes a paused worker.
    pub async fn resume_task(&self, task_id: TaskId) -> Result<()> {
        let conversation_id = self.conversation_of_task(&task_id).await?;
        let live = self
            .existing_task_live(&task_id)
            .ok_or_else(|| Error::Invalid("the worker has ended".into()))?;
        let cli = {
            let mut state = live.state.lock().await;
            state.busy = true;
            state.nudged = false;
            state.cli.clone()
        }
        .ok_or_else(|| Error::Invalid("the worker has ended".into()))?;
        self.set_task_state(&conversation_id, &task_id, TaskState::Running)
            .await?;
        cli.session
            .send(TurnInput {
                text: "Continue the task.".into(),
                files: Vec::new(),
            })
            .await
            .map_err(|err| Error::Provider(err.to_string()))
    }

    pub(crate) async fn conversation_of_task(&self, task_id: &TaskId) -> Result<ConversationId> {
        if let Some(live) = self.existing_task_live(task_id) {
            return Ok(live.conversation_id.clone());
        }
        for conversation in self.core.catalog().conversations {
            if let Ok(board) = self.core.board(&conversation.id).await
                && board.tasks.contains_key(task_id)
            {
                return Ok(conversation.id);
            }
        }
        Err(Error::NotFound(format!("task {task_id}")))
    }

    /// A worker failed: the task ends and the orchestrator hears why.
    pub(crate) async fn worker_failed(&self, task: &Task, reason: &str) {
        if let Some(live) = self.existing_task_live(&task.id) {
            live.close_cli().await;
        }
        let _ = self
            .update_task(&task.conversation_id, &task.id, |t| {
                t.error = Some(reason.to_owned());
            })
            .await;
        self.dispose_task(task, TaskState::Failed).await;
        self.deliver(
            &task.conversation_id,
            Envelope {
                kind: InjectionKind::TaskFailed,
                label: format!("task-{} failed", task.number),
                task_id: Some(task.id.clone()),
                text: format!("[failed task-{} \"{}\"] {reason}", task.number, task.title),
            },
        )
        .await;
    }

    /// A read task reported: its worker and workspace go.
    async fn finish_read_task(&self, task: &Task) {
        if let Some(live) = self.existing_task_live(&task.id) {
            live.close_cli().await;
        }
        self.dispose_task(task, TaskState::Done).await;
    }

    /// Ends a task: unfinished changes are kept (B15), then everything recorded under
    /// `task:<id>` is removed. Branches with unlanded work stay; a task branch with nothing to
    /// keep goes with the worktree.
    pub(crate) async fn dispose_task(&self, task: &Task, state: TaskState) {
        if let Some(live) = self.existing_task_live(&task.id) {
            live.close_cli().await;
        }
        let (kept, drop_branch) = match state {
            TaskState::Stopped | TaskState::Failed => self.keep_unfinished(task).await,
            // A write task that ends done changed nothing that could land.
            TaskState::Done => (None, true),
            // A landed branch is deleted once the landing checked it is merged.
            _ => (None, false),
        };
        let result = self
            .update_task(&task.conversation_id, &task.id, |t| {
                t.state = state;
                t.blocked_reason = None;
                if kept.is_some() {
                    t.kept = kept;
                }
            })
            .await;
        if let Err(err) = result {
            tracing::warn!(task = %task.id, error = %err, "could not record the task's end");
        }
        let owner = format!("task:{}", task.id);
        self.grants.revoke_owner(&owner);
        let leftovers = self.runtime.ledger().dispose(&owner).await;
        if !leftovers.is_clean() {
            tracing::warn!(task = %task.id, ?leftovers, "some of the task's leftovers will be retried at the next launch");
        }
        if drop_branch {
            self.drop_task_branch(task).await;
        }
        self.tasks_lock().remove(&task.id);
    }

    /// B15: a worker's unfinished changes survive the removal of its worktree, as a WIP commit
    /// on its task branch. Work that sits on the user's uncommitted changes (when they let
    /// workers see them) is replayed onto the target without them; if it overlaps them, it is
    /// kept as a diff artifact instead, because their content must never stay in a commit.
    ///
    /// Also says whether the task branch goes with the worktree: when it holds no work, or when
    /// it is built on the uncommitted changes and its work is safely stored as a diff.
    async fn keep_unfinished(&self, task: &Task) -> (Option<crate::work::KeptWork>, bool) {
        enum Unfinished {
            None,
            Commit(Oid),
            Overlaps { paths: Vec<String>, head: Oid },
        }
        let Some(workspace) = task.workspace.as_ref() else {
            return (None, false);
        };
        let (Some(path), Some(branch)) = (workspace.worktree.as_ref(), workspace.branch.clone())
        else {
            return (None, false);
        };
        let (git, path) = (self.git.clone(), PathBuf::from(path));
        let message = format!(
            "WIP: task-{} {} (unfinished, kept by Brigadier)",
            task.number, task.title
        );
        let base = workspace.base.clone().map(Oid);
        let on_snapshot = workspace.on_snapshot;
        let result = blocking(move || {
            let worktree = git.open_worktree(&path).map_err(git_error)?;
            worktree.commit_wip(&message).map_err(git_error)?;
            let head = worktree.head().map_err(git_error)?;
            let Some(base) = base.filter(|base| *base != head) else {
                return Ok(Unfinished::None);
            };
            if !on_snapshot {
                return Ok(Unfinished::Commit(head));
            }
            Ok(
                match worktree.drop_snapshot(&base, &message).map_err(git_error)? {
                    Ok(commit) => Unfinished::Commit(commit),
                    Err(paths) => Unfinished::Overlaps { paths, head },
                },
            )
        })
        .await;
        match result {
            Ok(Unfinished::None) => (None, true),
            Ok(Unfinished::Commit(commit)) => (
                Some(crate::work::KeptWork::Branch {
                    branch,
                    commit: commit.0,
                }),
                false,
            ),
            Ok(Unfinished::Overlaps { paths, head }) => match self.kept_diff(task).await {
                Some(artifact) => {
                    tracing::info!(task = %task.id, ?paths, "unfinished work overlaps the user's uncommitted changes; kept as a diff");
                    (
                        Some(crate::work::KeptWork::Diff {
                            artifact,
                            restored: None,
                        }),
                        true,
                    )
                }
                None => {
                    // Losing the work would be worse: the branch stays, on the snapshot.
                    tracing::error!(task = %task.id, "could not store the unfinished work as a diff; its branch stays, on the user's uncommitted changes");
                    (
                        Some(crate::work::KeptWork::Branch {
                            branch,
                            commit: head.0,
                        }),
                        false,
                    )
                }
            },
            Err(err) => {
                tracing::warn!(task = %task.id, error = %err, "could not keep unfinished work as a commit");
                match self.kept_diff(task).await {
                    Some(artifact) => (
                        Some(crate::work::KeptWork::Diff {
                            artifact,
                            restored: None,
                        }),
                        on_snapshot,
                    ),
                    None => (None, false),
                }
            }
        }
    }

    /// The task's diff as an artifact, read back from the blob store to be sure it is there.
    async fn kept_diff(&self, task: &Task) -> Option<ArtifactRef> {
        let artifact = self.diff_artifact(&self.task_live(task), task).await?;
        let hash = artifact.id.parse().ok()?;
        match self.core.store().blobs().get(hash).await {
            Ok(Some(bytes)) if bytes.len() as u64 == artifact.bytes => Some(artifact),
            other => {
                tracing::warn!(task = %task.id, found = ?other.map(|b| b.map(|b| b.len())), "the stored diff does not read back");
                None
            }
        }
    }

    /// Deletes the task branch once its worktree is gone.
    async fn drop_task_branch(&self, task: &Task) {
        let Some(branch) = task.workspace.as_ref().and_then(|w| w.branch.clone()) else {
            return;
        };
        let Ok(repo) = self.task_repo(task) else {
            return;
        };
        let git = self.git.clone();
        let result = blocking(move || {
            let repo = git.open(&repo).map_err(git_error)?;
            match repo.branch_tip(&branch).map_err(git_error)? {
                Some(tip) => repo.delete_branch_at(&branch, &tip).map_err(git_error),
                None => Ok(()),
            }
        })
        .await;
        if let Err(err) = result {
            tracing::warn!(task = %task.id, error = %err, "could not delete the task branch");
        }
    }
}

/// `BRIGADIER_ROUTE_CHEAP=1` (development and verification runs only): after routing picks
/// the vendor, use its cheapest model at low effort.
fn cheap_for_development(
    mut choice: brigadier_router::Choice,
    available: &[brigadier_router::Availability],
) -> brigadier_router::Choice {
    if std::env::var_os("BRIGADIER_ROUTE_CHEAP").is_none_or(|value| value != "1") {
        return choice;
    }
    let family = match choice.provider {
        ProviderKind::Claude => "haiku",
        ProviderKind::Codex => "luna",
    };
    let model = available
        .iter()
        .filter(|a| a.provider == choice.provider)
        .flat_map(|a| a.models.iter())
        .find(|m| m.id.contains(family))
        .map(|m| m.id.clone())
        .unwrap_or_else(|| family.to_owned());
    choice.model = Some(model);
    choice.effort = (choice.provider == ProviderKind::Codex).then(|| "low".to_owned());
    choice.reason = format!("{} (cheapest model: BRIGADIER_ROUTE_CHEAP)", choice.reason);
    choice
}

/// The router's category for a task kind.
fn category(kind: TaskKind) -> brigadier_router::TaskCategory {
    use brigadier_router::TaskCategory;
    match kind {
        TaskKind::Scout => TaskCategory::Scout,
        TaskKind::Research => TaskCategory::Research,
        TaskKind::Implement => TaskCategory::Implement,
        TaskKind::Review => TaskCategory::Review,
        TaskKind::Merge => TaskCategory::Merge,
        TaskKind::Verify => TaskCategory::Verify,
    }
}

/// B12: repository access, network and sandbox per task kind and permission level.
fn access_for(kind: TaskKind, permission: PermissionLevel) -> WorkerAccess {
    WorkerAccess {
        repo: match kind {
            TaskKind::Research => RepoAccess::None,
            TaskKind::Implement | TaskKind::Merge => RepoAccess::Write,
            TaskKind::Scout | TaskKind::Review | TaskKind::Verify => RepoAccess::Read,
        },
        network: true,
        unsandboxed: permission == PermissionLevel::FullAccess,
    }
}

/// `brigadier/<session>/task-<n>-<slug>`.
fn task_branch(conversation_id: &ConversationId, number: u32, title: &str) -> String {
    let session = conversation_id.short();
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join("-");
    let slug: String = slug.chars().take(40).collect();
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        format!("brigadier/{session}/task-{number}")
    } else {
        format!("brigadier/{session}/task-{number}-{slug}")
    }
}

pub(crate) fn route_label(task: &Task) -> String {
    let choice = &task.route.choice;
    match &choice.model {
        Some(model) => format!("{} {model}", choice.provider.label()),
        None => choice.provider.label().to_owned(),
    }
}

fn mime_for(path: &Path) -> String {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("md") => "text/markdown",
        Some("json") => "application/json",
        Some("diff" | "patch") => "text/x-diff",
        Some("txt" | "log" | "out") => "text/plain",
        _ => "application/octet-stream",
    }
    .into()
}
