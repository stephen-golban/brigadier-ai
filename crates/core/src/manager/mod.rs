//! The session manager: live sessions, Chats and their workers.
//!
//! It turns the conversation log into running CLI sessions and back:
//!
//! - one orchestrator CLI session per Brigadier session ([`conversation`]), which only talks
//!   and calls the Brigadier MCP tools ([`tools`]);
//! - workers, one CLI session per task, in their own worktrees ([`workers`]), whose accepted
//!   work lands as one reviewed commit ([`landing`]);
//! - one CLI session per Chat, with no orchestrator and no workers;
//! - the cards the user answers ([`cards`]), the grants the sessions hold, and the lifecycle
//!   (hibernate, archive, restore, delete) with the cleanup of everything they create
//!   ([`lifecycle`]).
//!
//! Every CLI session is disposable: the conversation stream is the truth, and a session that
//! is gone (hibernated with its files cleaned up, archived, crashed) is started again from it.

mod cards;
mod conversation;
mod instructions;
mod landing;
mod lifecycle;
mod prompts;
mod secrets;
mod tools;
mod workers;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use brigadier_git::Git;
use brigadier_providers::{BoxFuture, ProviderKind};
use tokio_util::task::TaskTracker;

use crate::model::{
    Conversation, ConversationId, ConversationKind, EnvironmentRequest, ProjectId, RepoInfo, Setup,
    SetupRequest,
};
use crate::runtime::{Runtime, Spawner};
use crate::tools::{GateAnswer, Grants, Role, ToolCall, ToolHost, ToolReply};
use crate::work::TaskId;
use crate::{Core, Error, Result};

pub use conversation::SendOutcome;

use self::cards::Waiters;
use self::conversation::ConvLive;
use self::workers::TaskLive;

/// Where the session manager finds what it hands to CLI sessions.
#[derive(Debug, Clone)]
pub struct ManagerConfig {
    /// The running `brigadierd`: CLIs start `brigadierd mcp` as their Brigadier MCP server.
    pub daemon_exe: PathBuf,
    /// The outward-command gate's shims, put first on every worker's PATH.
    pub gate_dir: Option<PathBuf>,
}

pub struct SessionManager {
    me: Weak<SessionManager>,
    core: Arc<Core>,
    runtime: Arc<Runtime>,
    spawner: Spawner,
    config: ManagerConfig,
    git: Git,
    data_dir: PathBuf,
    grants: Grants,
    convs: Mutex<HashMap<ConversationId, Arc<ConvLive>>>,
    tasks: Mutex<HashMap<TaskId, Arc<TaskLive>>>,
    /// Held while a new-worktree session's own worktree is created, so parallel first tasks
    /// create it once.
    session_worktrees: tokio::sync::Mutex<()>,
    waiters: Waiters,
    admitting: AtomicBool,
    background: TaskTracker,
}

impl SessionManager {
    /// Starts the manager. Conversations come back to life lazily, on their next message.
    pub async fn start(
        core: Arc<Core>,
        runtime: Arc<Runtime>,
        spawner: Spawner,
        config: ManagerConfig,
    ) -> Result<Arc<Self>> {
        let env = runtime.cli_env().clone();
        let git = Git::new(
            env.which("git").unwrap_or_else(|| PathBuf::from("git")),
            env.vars(),
        );
        {
            let git = git.clone();
            match tokio::task::spawn_blocking(move || git.version()).await {
                Ok(Ok(version)) => tracing::info!(%version, "git found"),
                Ok(Err(err)) => tracing::warn!(error = %err, "git is unusable; sessions will fail"),
                Err(err) => tracing::warn!(error = %err, "checking git failed"),
            }
        }
        let data_dir = runtime.platform().paths().data_dir.clone();
        let manager = Arc::new_cyclic(|me| Self {
            me: me.clone(),
            core,
            runtime,
            spawner,
            config,
            git,
            data_dir,
            grants: Grants::default(),
            convs: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            session_worktrees: tokio::sync::Mutex::new(()),
            waiters: Waiters::default(),
            admitting: AtomicBool::new(true),
            background: TaskTracker::new(),
        });
        manager.install_worktree_remover();
        manager.recover().await;
        manager.start_hibernation_timer();
        Ok(manager)
    }

    /// Grants held by live CLI sessions.
    pub fn grants(&self) -> &Grants {
        &self.grants
    }

    pub fn core(&self) -> &Arc<Core> {
        &self.core
    }

    /// Ends every live CLI session (their work stays in the log, ready to continue).
    pub async fn shutdown(&self) {
        self.admitting.store(false, Ordering::Release);
        let tasks: Vec<Arc<TaskLive>> = self.tasks_lock().values().cloned().collect();
        let convs: Vec<Arc<ConvLive>> = self.convs_lock().values().cloned().collect();
        let mut closing = tokio::task::JoinSet::new();
        for task in tasks {
            closing.spawn(async move { task.close_cli().await });
        }
        for conv in convs {
            closing.spawn(async move { conv.close_cli().await });
        }
        closing.join_all().await;
        self.background.close();
    }

    /// Branches and state of a repository, for the composer's pickers.
    pub async fn repo_info(&self, path: String) -> Result<RepoInfo> {
        let git = self.git.clone();
        blocking(move || {
            let repo = git.open(Path::new(&path)).map_err(git_error)?;
            let state = repo.state().map_err(git_error)?;
            let root = repo.root().to_string_lossy().into_owned();
            Ok(RepoInfo {
                name: Path::new(&root)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| root.clone()),
                path: root,
                current_branch: state.current_branch,
                dirty: !state.dirty_files.is_empty(),
                branches: state
                    .branches
                    .into_iter()
                    .map(|branch| crate::model::BranchInfo {
                        name: branch.name,
                        commit: branch.commit.0,
                        checked_out_at: branch
                            .checked_out_at
                            .map(|path| path.to_string_lossy().into_owned()),
                    })
                    .collect(),
            })
        })
        .await
    }

    /// Creates a session or Chat. A local-checkout session asked to start on a new branch gets
    /// that branch created from `create_from` first.
    pub async fn create_conversation(
        &self,
        kind: ConversationKind,
        project_id: Option<ProjectId>,
        title: Option<String>,
        setup: Option<SetupRequest>,
    ) -> Result<Conversation> {
        if let Some(SetupRequest::Session {
            repo,
            environment:
                EnvironmentRequest::LocalCheckout {
                    branch,
                    create_from: Some(from),
                },
            ..
        }) = &setup
        {
            let (git, repo, branch, from) =
                (self.git.clone(), repo.clone(), branch.clone(), from.clone());
            blocking(move || {
                let repo = git.open(Path::new(&repo)).map_err(git_error)?;
                let start = repo.resolve(&from).map_err(git_error)?;
                repo.create_branch(&branch, &start).map_err(git_error)
            })
            .await?;
        }
        let id = ConversationId::generate();
        let setup = setup.map(|request| Setup::from_request(request, &id));
        self.core
            .create_conversation(id, kind, project_id, title, setup)
            .await
    }

    fn arc(&self) -> Arc<Self> {
        self.me
            .upgrade()
            .expect("the session manager is alive while in use")
    }

    fn spawn(&self, task: impl std::future::Future<Output = ()> + Send + 'static) {
        let task = self.background.track_future(task);
        (self.spawner)(Box::pin(task));
    }

    fn admit(&self) -> Result<()> {
        if self.admitting.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(Error::Invalid("Brigadier is shutting down".into()))
        }
    }

    fn convs_lock(&self) -> MutexGuard<'_, HashMap<ConversationId, Arc<ConvLive>>> {
        self.convs.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn tasks_lock(&self) -> MutexGuard<'_, HashMap<TaskId, Arc<TaskLive>>> {
        self.tasks.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The live state of a conversation, created on first use.
    fn conv(&self, id: &ConversationId) -> Result<Arc<ConvLive>> {
        let conversation = self.core.conversation(id)?;
        let mut convs = self.convs_lock();
        Ok(convs
            .entry(id.clone())
            .or_insert_with(|| Arc::new(ConvLive::new(conversation.id.clone(), conversation.kind)))
            .clone())
    }

    /// `<data>/<area>/<id>`: a Brigadier-owned folder.
    fn owned_dir(&self, area: &str, id: &str) -> PathBuf {
        self.data_dir.join(area).join(id)
    }

    /// The IPC socket CLIs' sandboxes must be able to reach (the MCP bridge and gate).
    fn socket_path(&self) -> Option<PathBuf> {
        match &self.runtime.platform().paths().ipc_endpoint {
            brigadier_sandbox::IpcEndpoint::UnixSocket(path) => Some(path.clone()),
            #[allow(unreachable_patterns)]
            _ => None,
        }
    }

    fn provider_usable(&self, kind: ProviderKind) -> bool {
        self.runtime.overview(kind).is_some_and(|overview| {
            overview
                .status
                .as_ref()
                .is_some_and(|status| status.logged_in)
                && overview
                    .quota
                    .as_ref()
                    .is_none_or(|quota| quota.limit.is_none())
        })
    }
}

impl ToolHost for SessionManager {
    fn role(&self, grant: &str) -> Option<Role> {
        self.grants.resolve(grant)
    }

    fn call(&self, grant: &str, call: ToolCall) -> BoxFuture<'_, ToolReply> {
        let role = self.grants.resolve(grant);
        let manager = self.arc();
        Box::pin(async move {
            let Some(role) = role else {
                return ToolReply::error("This grant is not valid (the session ended).");
            };
            match (role, call) {
                (Role::Orchestrator { conversation_id }, ToolCall::Orchestrator(call)) => {
                    manager.orchestrator_call(conversation_id, call).await
                }
                (
                    Role::Worker {
                        conversation_id,
                        task_id,
                    },
                    ToolCall::Worker(call),
                ) => manager.worker_call(conversation_id, task_id, call).await,
                _ => ToolReply::error("This tool is not available to this session."),
            }
        })
    }

    fn ask_outward(
        &self,
        grant: &str,
        argv: Vec<String>,
        cwd: String,
    ) -> BoxFuture<'_, GateAnswer> {
        let role = self.grants.resolve(grant);
        let manager = self.arc();
        Box::pin(async move {
            match role {
                Some(Role::Gate {
                    conversation_id,
                    task_id,
                }) => {
                    manager
                        .ask_outward_command(conversation_id, task_id, argv, cwd)
                        .await
                }
                _ => GateAnswer::Deny {
                    message: "Brigadier does not know this session, so it cannot ask you.".into(),
                },
            }
        })
    }
}

/// Runs blocking work (git, file copies) off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|err| Error::Invalid(format!("background work failed: {err}")))?
}

fn git_error(err: brigadier_git::Error) -> Error {
    match err {
        brigadier_git::Error::NotARepository(path) => {
            Error::Invalid(format!("{} is not a git repository", path.display()))
        }
        other => Error::Invalid(other.to_string()),
    }
}
