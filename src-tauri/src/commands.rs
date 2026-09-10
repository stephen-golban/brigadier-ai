//! Every `#[tauri::command]` in the app, one module, unique identifiers.
//!
//! Three rules from `docs/research/tauri-commands.md` shape this file and are not negotiable:
//!
//! - Commands live in a submodule and are `pub(crate)`. A `pub` command in `lib.rs` is two
//!   `E0255`s per command; a *private* command in a submodule is an `E0603` at the
//!   `generate_handler!` site. Identifiers must be unique crate-wide (§1.6).
//! - Every command here is `async`. A sync command body runs on the thread that delivered the
//!   IPC message — the same thread draining the `eval` queue that carries the feed — so anything
//!   touching the store or a lock belongs on the runtime (§1.1).
//! - `State<'_, AppState>` needs the explicit lifetime in an `async fn`, and an async command
//!   with a borrowed argument must return `Result` (§1.2). Every one of these does.
//!
//! Argument names are snake_case in Rust; Tauri looks them up as lowerCamelCase, which is what
//! `src/bridge.ts` sends (§1.4, and `docs/plans/ipc-contract.md` "Conventions").

use std::path::PathBuf;

use brigadier_core::driver::{DriverKind, McpPolicy, PermissionMode, StartSession};
use brigadier_core::event::{RequestId, SessionId};
use brigadier_core::session::Decision;
use brigadier_supervisor::{
    ApprovalView, FeedBatch, FeedRowWire, ProjectDeletion, SessionDeletion, WorktreeCleanup,
};
use tauri::ipc::Channel;
use tauri::State;

use brigadier_store::intents::IntentState;
use brigadier_store::plan::{PhaseRow, PhaseState, UnknownRow, WorkOrderRow};
use brigadier_supervisor::loop_::RunSpec;
use brigadier_supervisor::SupervisorError;

use crate::error::AppError;
use crate::state::{AppState, Ready};
use crate::views::{
    AppInfo, ClaudeStatus, FrameStats, IntentView, ModelInfo, PaintLine, PaintReport, ProjectView,
    RunView, SessionView, TurnStarted,
};

/// The kind every session this phase starts is driven by.
const CLAUDE_CODE: &str = "claude-code";

/// What this launch is, and where it keeps its state.
///
/// Also the startup health check: when the store would not open, this returns
/// `AppError { code: "store", .. }` carrying the reason, which is the only place the front end
/// can learn that the app came up broken.
#[tauri::command]
pub(crate) async fn app_info(state: State<'_, AppState>) -> Result<AppInfo, AppError> {
    let ready = state.get()?;
    Ok(AppInfo {
        run_id: ready.run_id.clone(),
        data_dir: ready.data_dir.display().to_string(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    })
}

/// Re-run `claude --version` and register the driver if it passes.
///
/// Re-probed on every call rather than cached: the operator's remedy for
/// `claude_not_installed` is to install it and press the button again.
#[tauri::command]
pub(crate) async fn probe_claude(state: State<'_, AppState>) -> Result<ClaudeStatus, AppError> {
    state.probe_claude().await
}

/// The models a new session may pin. A fixed list; see [`crate::views::models`] for the sources.
#[tauri::command]
pub(crate) async fn list_models(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, AppError> {
    state.get()?;
    let available = brigadier_core::claude::capabilities::models(crate::state::CLAUDE_INSTANCE);
    if available.is_empty() {
        return Ok(crate::views::models());
    }
    Ok(available
        .into_iter()
        .map(|m| ModelInfo {
            is_default: m.id == "default",
            id: m.id,
            label: m.label,
        })
        .collect())
}

/// Every project, oldest first.
#[tauri::command]
pub(crate) async fn list_projects(
    state: State<'_, AppState>,
) -> Result<Vec<ProjectView>, AppError> {
    let rows = state.get()?.supervisor.list_projects().await?;
    Ok(rows.iter().map(ProjectView::from).collect())
}

/// Record a project rooted at `path`. An existing tree returns its existing row.
#[tauri::command]
pub(crate) async fn add_project(
    path: String,
    state: State<'_, AppState>,
) -> Result<ProjectView, AppError> {
    let row = crate::navigation::open_project(PathBuf::from(path), state.get()?).await?;
    Ok(ProjectView::from(&row))
}

/// Set whether a project's children inherit the user's MCP servers: `"off"` or `"inherit"`.
///
/// The slug set is closed, so anything else is `invalid_argument` rather than a pass-through;
/// unlike `permission_mode`, the CLI does not own this vocabulary, the harness does. Takes effect
/// on the project's next start or resume; a running child keeps what it was spawned with. A
/// project reading `off` may be migration 2's doing rather than a choice
/// (`crates/store/src/schema.rs`).
// see docs/research/spawn-split.md §6 and docs/plans/ipc-contract.md "### set_project_mcp".
#[tauri::command]
pub(crate) async fn set_project_mcp(
    project_id: String,
    mcp: String,
    state: State<'_, AppState>,
) -> Result<ProjectView, AppError> {
    let policy = McpPolicy::from_slug(&mcp).ok_or_else(|| {
        AppError::new(
            "invalid_argument",
            format!("unknown mcp policy {mcp:?}; expected off or inherit"),
        )
    })?;
    let row = state
        .get()?
        .supervisor
        .set_project_mcp(&project_id, policy)
        .await?;
    Ok(ProjectView::from(&row))
}

/// Every session, newest first.
#[tauri::command]
pub(crate) async fn list_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<SessionView>, AppError> {
    let rows = state.get()?.supervisor.list_sessions().await?;
    Ok(rows.iter().map(SessionView::from).collect())
}

pub(crate) fn require_provider(state: &AppState, provider: &str) -> Result<(), AppError> {
    if provider == CLAUDE_CODE {
        state.claude_status()?;
    }
    if !state
        .get()?
        .supervisor
        .registered_drivers()
        .iter()
        .any(|driver| driver.kind().as_str() == provider)
    {
        return Err(AppError::invalid_argument(
            "Requested provider is not connected",
        ));
    }
    Ok(())
}

/// Start a Claude session in a project's root and send `prompt` as its first turn.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Named arguments are the existing Tauri IPC contract.
pub(crate) async fn start_session(
    project_id: String,
    prompt: String,
    model: Option<String>,
    permission_mode: String,
    provider: Option<String>,
    options: Option<AgentOptions>,
    isolated: Option<bool>,
    base_branch: Option<String>,
    attachment_ids: Option<Vec<String>>,
    request_id: Option<String>,
    composer_mode: Option<String>,
    composer_permission: Option<String>,
    new_branch: Option<String>,
    workspace_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<SessionView, AppError> {
    let _creation = crate::peers::CREATION.lock().await;
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    // Identity belongs to authored selections, never mutable automatic routing results.
    let initial_request = serde_json::json!({"composerMode":composer_mode,"composerPermission":composer_permission,"prompt":prompt,"model":model,"permissionMode":permission_mode,"provider":provider,"effort":options.as_ref().and_then(|o|o.effort.as_deref()),"isolated":isolated,"baseBranch":base_branch,"newBranch":new_branch,"workspacePath":workspace_path,"attachmentIds":attachment_ids});
    let mode = composer_mode.as_deref().unwrap_or("custom");
    if !matches!(mode, "auto" | "custom") {
        return Err(AppError::invalid_argument("Choose Auto or Custom"));
    }
    let policy = composer_permission.unwrap_or_else(|| {
        match permission_mode.as_str() {
            "auto" | "approve" => "approve",
            "bypass-permissions" | "full" => "full",
            _ => "ask",
        }
        .into()
    });
    let permission_mode = crate::task_settings::native_permission(&policy)?.to_string();
    let selection = if mode == "auto" {
        crate::task_settings::resolve_auto(state.inner(), None)?
    } else {
        crate::task_settings::ExecutionSelection {
            provider: provider.unwrap_or_else(|| CLAUDE_CODE.into()),
            model,
            effort: options.and_then(|o| o.effort).filter(|e| e != "auto"),
        }
    };
    crate::task_settings::validate_selection(state.inner(), &selection)?;
    let provider = selection.provider;
    let model = selection.model;
    let options = Some(AgentOptions {
        effort: selection.effort,
    });
    let isolated = if workspace_path.is_some() {
        Some(false)
    } else {
        isolated
    };
    let remembered_branch = base_branch.clone();
    require_provider(state.inner(), &provider)?;
    if let Some(waiting) = brigadier_core::allowance::blocked_provider(&provider) {
        return Err(AppError::new(
            "usage_limit",
            format!(
                "Provider allowance exhausted; reset: {:?}. Your selected model remains unchanged.",
                waiting.reset_at
            ),
        ));
    }
    if let Some(key) = request_id.as_deref() {
        if let Some(id) = crate::composer::begin_initial(&project_id, key, initial_request)? {
            return session_view(state.inner(), &SessionId::new(id)).await;
        }
    }
    let receipt_project = project_id.clone();
    let mut dispatch_started = false;
    let result = start_session_attempt(
        project_id,
        prompt,
        model,
        permission_mode,
        provider,
        options,
        isolated,
        base_branch,
        None,
        Some(InitialComposer {
            mode: mode.to_owned(),
            permission: policy.clone(),
            base_branch: remembered_branch,
            new_branch,
            workspace_path,
        }),
        attachment_ids.unwrap_or_default(),
        state.clone(),
        &mut dispatch_started,
    )
    .await;
    if let Some(key) = request_id.as_deref() {
        crate::composer::finish_initial(
            &receipt_project,
            key,
            result
                .as_ref()
                .map(|v| v.session_id.clone())
                .map_err(Clone::clone),
            dispatch_started,
        )?;
    }
    result
}

// Caller holds CREATION across validation and spawn (including agent-created sessions).
#[allow(clippy::too_many_arguments)] // Mirrors the Tauri command boundary above.
pub(crate) async fn start_session_locked(
    project_id: String,
    prompt: String,
    model: Option<String>,
    permission_mode: String,
    provider: String,
    options: Option<AgentOptions>,
    isolated: Option<bool>,
    base_branch: Option<String>,
    peer: Option<crate::peers::PeerStart>,
    attachment_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<SessionView, AppError> {
    let mut dispatch_started = false;
    start_session_attempt(
        project_id,
        prompt,
        model,
        permission_mode,
        provider,
        options,
        isolated,
        base_branch,
        peer,
        None,
        attachment_ids,
        state,
        &mut dispatch_started,
    )
    .await
}

struct InitialComposer {
    mode: String,
    permission: String,
    base_branch: Option<String>,
    new_branch: Option<String>,
    workspace_path: Option<String>,
}

#[allow(clippy::too_many_arguments)]
async fn start_session_attempt(
    project_id: String,
    prompt: String,
    model: Option<String>,
    permission_mode: String,
    provider: String,
    options: Option<AgentOptions>,
    isolated: Option<bool>,
    base_branch: Option<String>,
    peer: Option<crate::peers::PeerStart>,
    composer_configuration: Option<InitialComposer>,
    attachment_ids: Vec<String>,
    state: State<'_, AppState>,
    dispatch_started: &mut bool,
) -> Result<SessionView, AppError> {
    crate::navigation::require_available(
        &state.get()?.data_dir,
        crate::navigation::Kind::Project,
        &project_id,
    )?;
    // Fail with the code the UI has a remedy for. Without this the supervisor answers
    // `NoDriver` → `driver`, which tells the operator nothing about the missing install.
    require_provider(state.inner(), &provider)?;
    if let Some(waiting) = brigadier_core::allowance::blocked_provider(&provider) {
        return Err(AppError::new(
            "usage_limit",
            format!(
                "Provider allowance exhausted; reset: {:?}. Your selected model remains unchanged.",
                waiting.reset_at
            ),
        ));
    }

    let supervisor = &state.get()?.supervisor;
    let project = supervisor
        .project(&project_id)
        .await?
        .ok_or_else(|| AppError::new("no_such_project", format!("no project {project_id}")))?;

    let peer_source = if let Some(peer) = peer.as_ref() {
        supervisor
            .session(&SessionId::new(&peer.from))
            .await?
            .filter(|row| row.project_id.as_deref() == Some(project_id.as_str()))
            .and_then(|row| row.worktree_path.or(row.cwd))
            .unwrap_or_else(|| project.root_path.clone())
    } else {
        project.root_path.clone()
    };
    let mut req = StartSession::new(project.root_path);
    req.display_prompt = Some(
        peer.as_ref()
            .map(|peer| peer.text.clone())
            .unwrap_or_else(|| prompt.clone()),
    );
    req.attachments =
        crate::conversation_data::attachments(state.inner(), &project_id, attachment_ids).await?;
    if prompt.trim().is_empty() && req.attachments.is_empty() {
        return Err(AppError::invalid_argument("A message or image is required"));
    }
    if crate::conversation_data::slash_invocation(&prompt) && !req.attachments.is_empty() {
        return Err(AppError::invalid_argument(
            "Send images with a prompt, not a slash command",
        ));
    }
    let referenced = crate::session_references::contextualize(state.inner(), &prompt).await?;
    req.prompt = Some(crate::conversation_data::contextualize(
        state.inner(),
        &project_id,
        &referenced,
    )?);
    req.model = model;
    // An unmodelled mode is passed through verbatim rather than rejected; the CLI owns the
    // vocabulary. see crates/core/src/driver.rs `PermissionMode`.
    req.permission_mode = PermissionMode::from(permission_mode.as_str());
    // Brigadier's selected policy applies equally in a shared checkout and worktree.
    // The supervisor's legacy fallback treats shared checkouts as a judgement lane.
    if matches!(
        req.permission_mode,
        PermissionMode::Ask | PermissionMode::Approve | PermissionMode::Full
    ) {
        req.hook_policy =
            brigadier_core::driver::HookOverride::new(brigadier_core::claude::hook::policy_for(
                &req.permission_mode,
                &brigadier_core::claude::hook::HookScope::Interactive {
                    root: req.cwd.clone(),
                },
            ));
    }
    if provider == CLAUDE_CODE {
        apply_agent_options(&mut req, options.as_ref())?;
    } else {
        req.effort = options.and_then(|o| o.effort).filter(|e| e != "auto");
        req.thinking = brigadier_core::driver::ThinkingPolicy::Inherit;
    }

    let title = prompt
        .lines()
        .next()
        .unwrap_or("Session")
        .chars()
        .take(100)
        .collect();
    let peer_token = crate::peers::prepare(&mut req)?;
    if let Some(worker) = peer.as_ref().filter(|p| p.subagent) {
        req.prompt = Some(format!("{}\n\nThis execution is an internal subagent owned by {}. Execute the assignment; send missing decisions and results to that owner. You are not a user conversation. Never ask the user to message you directly or create separate conversations.", req.prompt.as_deref().unwrap_or(""), worker.from));
    }
    // Bind authenticated provenance and attachment ownership before the initial input is sent.
    let initial_input = (
        req.prompt.take().unwrap_or_default(),
        std::mem::take(&mut req.attachments),
    );
    let session_id = if let Some(baseline) = peer.as_ref().and_then(|p| p.baseline.clone()) {
        supervisor
            .start_peer_session_at(&project_id, &DriverKind::new(&provider), req, baseline)
            .await?
    } else if peer.is_some() {
        supervisor
            .start_peer_session_from(
                &project_id,
                &DriverKind::new(&provider),
                req,
                isolated.unwrap_or(true),
                peer_source,
            )
            .await?
    } else {
        let new_branch = composer_configuration
            .as_ref()
            .and_then(|c| c.new_branch.clone());
        let workspace_path = composer_configuration
            .as_ref()
            .and_then(|c| c.workspace_path.as_deref());
        let workspace = if isolated == Some(false) {
            Some(
                crate::composer_workspaces::prepare_checkout(
                    state.inner(),
                    &project_id,
                    workspace_path,
                    base_branch.as_deref(),
                    new_branch.as_deref(),
                )
                .await?,
            )
        } else {
            None
        };
        supervisor
            .start_project_session_selected(
                &project_id,
                &DriverKind::new(&provider),
                req,
                isolated.unwrap_or(true),
                base_branch,
                new_branch,
                workspace,
            )
            .await?
    };
    let result = async {
        crate::task_memory::initialize(state.inner(), session_id.as_str(), &prompt)?;
        if let Some(InitialComposer {
            mode,
            permission,
            base_branch: branch,
            new_branch,
            workspace_path,
        }) = composer_configuration
        {
            crate::task_settings::initialize(
                state.inner(),
                session_id.as_str(),
                &mode,
                &permission,
                branch,
                new_branch,
                workspace_path,
            )
            .await?;
        }
        let receipt = peer
            .as_ref()
            .map(|peer| crate::peers::record_initial(peer, session_id.as_str()))
            .transpose()
            .map_err(|e| {
                AppError::new(
                    "peer_creation_unknown",
                    format!(
                        "Task {} was created but provenance persistence failed: {}",
                        session_id, e.message
                    ),
                )
            })?;
        crate::peers::record_baseline(state.inner(), session_id.as_str()).await?;
        let title = peer
            .as_ref()
            .map(|peer| peer.title.clone())
            .unwrap_or(title);
        crate::peers::bind(peer_token, session_id.as_str(), Some(title))?;
        if let Some(peer) = peer.as_ref() {
            state
                .get()?
                .store()
                .retain_attachments(
                    session_id.to_string(),
                    peer.attachments.iter().map(|a| a.id.clone()).collect(),
                )
                .await?;
            if let Err(error) = crate::composer::require_running(&peer.from) {
                if let Some(receipt) = receipt.as_ref() {
                    crate::peers::finish_initial(&receipt.id, Err(error.clone()))?;
                }
                return Err(error);
            }
        }
        if let Some(receipt) = receipt.as_ref() {
            crate::peers::mark_delivery_attempt(&receipt.id)?;
        }
        // All validation, workspace capture and metadata binding precede this boundary.
        // A failed attempt before it is safe to retry with the same logical request ID.
        let (text, attachments) = initial_input;
        let text = crate::task_memory::with_context(state.inner(), session_id.as_str(), text)?;
        crate::composer::require_running(session_id.as_str())?;
        *dispatch_started = true;
        let result = supervisor
            .send_input(
                &session_id,
                brigadier_core::session::TurnInput {
                    text,
                    display_text: Some(
                        peer.as_ref()
                            .map(|peer| peer.text.clone())
                            .unwrap_or(prompt),
                    ),
                    attachments,
                    ..Default::default()
                },
            )
            .await;
        match result {
            Ok(turn) => {
                if let Some(receipt) = receipt {
                    crate::peers::finish_initial(&receipt.id, Ok(turn.to_string()))?;
                }
            }
            Err(e) => {
                let error = AppError::from(e);
                if let Some(receipt) = receipt {
                    crate::peers::finish_initial(&receipt.id, Err(error.clone()))?;
                }
                return Err(error);
            }
        }
        session_view(state.inner(), &session_id).await
    }
    .await;
    if result.is_err() {
        let _ = supervisor.kill(&session_id).await;
    }
    result
}

/// Continue an ended session: the same row, the same feed, a new child.
///
/// Takes only the session id. `SessionView` gains no field for this: `provider_session_id`
/// already carries the value the stored resume token is derived from, so there is nothing new to
/// keep in sync, and the front end's Resume predicate is
/// `provider_session_id !== null && (status === "exited" || status === "failed")`.
///
/// Errors the front end branches on: `not_resumable` (no stored token, still live, or a status
/// that is neither `exited` nor `failed` — the message says which), `no_such_session`,
/// `claude_not_installed` / `claude_too_old`, and `driver` when the child will not come up.
// see docs/research/resume.md §8 gaps 7 and 11, and docs/plans/ipc-contract.md "Commands".
#[tauri::command]
pub(crate) async fn resume_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<SessionView, AppError> {
    crate::peers::require_conversation(&session_id)?;
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    crate::session_archive::require_active(&state.get()?.data_dir, &session_id)?;
    crate::navigation::require_available(
        &state.get()?.data_dir,
        crate::navigation::Kind::Session,
        &session_id,
    )?;
    // Same reason as `start_session`: the supervisor would answer `NoDriver` → `driver`, which
    // tells the operator nothing about a missing install.

    crate::task_settings::prepare_dispatch(state.inner(), &session_id, None).await?;
    session_view(state.inner(), &SessionId::new(session_id)).await
}

/// Branch provider history into a new, idle session and isolated Git workspace.
#[tauri::command]
pub(crate) async fn fork_session(
    session_id: String,
    new_worktree: Option<bool>,
    state: State<'_, AppState>,
) -> Result<SessionView, AppError> {
    crate::peers::require_conversation(&session_id)?;
    let _creation = crate::peers::CREATION.lock().await;
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    let runtime = state.get()?;
    crate::navigation::require_available(
        &runtime.data_dir,
        crate::navigation::Kind::Session,
        &session_id,
    )?;

    let mut request = StartSession::new(".");
    let token = crate::peers::prepare(&mut request)?;
    let id = runtime
        .supervisor
        .fork_session_in(
            &SessionId::new(session_id.clone()),
            request.env_overrides,
            new_worktree.unwrap_or(true),
        )
        .await?;
    let title = crate::peers::snapshot()?
        .titles
        .get(&session_id)
        .cloned()
        .unwrap_or_else(|| "Session".into());
    crate::peers::bind(token, id.as_str(), Some(format!("Fork of {title}")))?;
    crate::peers::record_fork(id.as_str(), &session_id)?;
    session_view(state.inner(), &id).await
}

/// Queue a user turn on a live session.
#[tauri::command]
pub(crate) async fn send_turn(
    session_id: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<TurnStarted, AppError> {
    crate::peers::require_conversation(&session_id)?;
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    crate::conversation_data::send_locked(state.inner(), session_id, text, vec![]).await
}

/// Answer a parked permission request.
#[tauri::command]
pub(crate) async fn respond(
    session_id: String,
    request_id: String,
    decision: Decision,
    conversation_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    crate::peers::require_response_owner(&session_id, conversation_id.as_deref())?;
    state
        .get()?
        .supervisor
        .respond(
            &SessionId::new(session_id),
            RequestId::new(request_id),
            decision,
        )
        .await?;
    Ok(())
}

/// End the current turn; the session survives.
#[tauri::command]
pub(crate) async fn interrupt(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state
        .get()?
        .supervisor
        .interrupt(&SessionId::new(session_id))
        .await?;
    Ok(())
}

/// Ask the session to end. The exit arrives on the feed, not from this call.
#[tauri::command]
pub(crate) async fn end_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state
        .get()?
        .supervisor
        .end_session(&SessionId::new(session_id))
        .await?;
    Ok(())
}

/// Kill the session's process group.
#[tauri::command]
pub(crate) async fn kill(session_id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    let _guard = crate::peers::LIFECYCLE.lock().await;
    crate::peers::cancel_pending(&session_id)?;
    state
        .get()?
        .supervisor
        .kill(&SessionId::new(session_id))
        .await?;
    Ok(())
}

/// Remove an ended session's git worktree, keeping its branch.
///
/// Explicit, never automatic: nothing on `end_session` or `kill` touches a worktree, because a
/// resumed session needs it as its `cwd`.
///
/// `force = false` asks the question. A worktree with uncommitted work comes back as
/// `{ removed: false, dirty_files: N, branch }` with **nothing touched**; calling again with
/// `force = true` discards those N entries and removes the checkout. The branch survives either
/// way — no path here deletes one — and after a removal the session's `cwd` no longer exists, so
/// resuming it will fail.
///
/// Errors the front end branches on: `session_running` (a child is still on the other end),
/// `no_such_session`, `invalid_argument` (the session has no worktree at all), and `worktree`
/// for a git failure.
// see docs/research/worktree-git.md §4 and docs/plans/ipc-contract.md "Worktrees".
#[tauri::command]
pub(crate) async fn cleanup_worktree(
    session_id: String,
    force: bool,
    state: State<'_, AppState>,
) -> Result<WorktreeCleanup, AppError> {
    Ok(state
        .get()?
        .supervisor
        .cleanup_worktree(&SessionId::new(session_id), force)
        .await?)
}

/// Delete Brigadier session history, stopping its process and preserving all worktree files.
#[tauri::command]
pub(crate) async fn delete_session(
    session_id: String,
    force: bool,
    state: State<'_, AppState>,
) -> Result<SessionDeletion, AppError> {
    Ok(state
        .get()?
        .supervisor
        .delete_session(&SessionId::new(session_id), force)
        .await?)
}

/// Remove a project and its history from Brigadier, preserving the repository and worktrees.
#[tauri::command]
pub(crate) async fn delete_project(
    project_id: String,
    force: bool,
    state: State<'_, AppState>,
) -> Result<ProjectDeletion, AppError> {
    Ok(state
        .get()?
        .supervisor
        .delete_project(&project_id, force)
        .await?)
}

/// The newest `n` feed rows for a session, oldest first — what a fresh mount replays before it
/// switches to live batches.
#[tauri::command]
pub(crate) async fn feed_tail(
    session_id: String,
    n: usize,
    state: State<'_, AppState>,
) -> Result<Vec<FeedRowWire>, AppError> {
    Ok(state
        .get()?
        .supervisor
        .feed_tail(&SessionId::new(session_id), n)
        .await?)
}

/// Every unanswered approval, oldest first, each marked resumable or expired.
#[tauri::command]
pub(crate) async fn pending_approvals(
    state: State<'_, AppState>,
) -> Result<Vec<ApprovalView>, AppError> {
    Ok(state.get()?.supervisor.pending_approvals().await?)
}

/* ------------------------------------------------------------------- the run
 *
 * `docs/plans/ipc-contract.md` "The run". Five commands: one approved goal, one plan, and a loop
 * that dispatches, gates and commits without a human. Nothing here reports a dollar figure, and
 * nothing here may grow one (`docs/vision.md` §6).
 */

/// Start a run: one goal in plain English becomes a plan the loop works through.
///
/// **Nothing is spawned by this call.** `Supervisor::start_run` writes and approves the plan row,
/// then starts a task whose first tick waits on the reconciliation barrier — so a run started
/// before reconciliation finishes waits rather than dispatching into a repository nothing has
/// read (`docs/research/intent-records.md` §4.1).
///
/// Errors the front end branches on: `no_such_project`, `invalid_argument` (an empty goal, or no
/// `git` on `PATH`), `run_already_live`, and `claude_not_installed` / `claude_too_old` when there
/// is no binary to spawn children with.
///
/// **A restart continues the plan rather than writing a second one** — see [`resumable`].
///
/// `model` and `permission_mode` are the owner's picks and both are **optional**, so a caller that
/// sends neither gets exactly the previous behaviour. They were absent until now, which meant the
/// dock's own pickers reached nothing: every child took the CLI's default model, and every child
/// ran under `AskGatedTools` whatever mode was showing — the planner that prompted the owner for
/// twenty consecutive `Bash` calls.
///
/// * `model` — `None` leaves `docs/vision.md` §6's role-based routing in charge; `Some` is
///   honoured by **every** child of the run. See [`RunSpec::model`].
/// * `permission_mode` — a bare string in the CLI's own vocabulary; an unmodelled value passes
///   through verbatim rather than being rejected here. It reaches the `--permission-mode` flag
///   **and** the `PreToolUse` policy, and in the project root it never removes the write gate
///   (`docs/research/permission-modes.md` §4).
#[tauri::command]
pub(crate) async fn start_run(
    project_id: String,
    goal: String,
    model: Option<String>,
    permission_mode: Option<String>,
    provider: Option<String>,
    effort: Option<String>,
    state: State<'_, AppState>,
) -> Result<RunView, AppError> {
    let _creation = crate::peers::CREATION.lock().await;
    crate::navigation::require_available(
        &state.get()?.data_dir,
        crate::navigation::Kind::Project,
        &project_id,
    )?;
    // Same reason `start_session` does it: without this the supervisor answers `NoDriver` →
    // `driver`, which tells the operator nothing about a missing install — and a run spawns
    // children on its own initiative, so the honest failure has to arrive at the button.
    let provider = provider
        .ok_or_else(|| AppError::invalid_argument("Choose the orchestrator provider explicitly"))?;
    require_provider(state.inner(), &provider)?;
    let ready = state.get()?;
    let goal = goal.trim().to_owned();
    if goal.is_empty() {
        return Err(AppError::invalid_argument("a run needs a goal"));
    }
    ready
        .supervisor
        .project(&project_id)
        .await?
        .ok_or_else(|| AppError::new("no_such_project", format!("no project {project_id}")))?;
    // One run at a time, across every project: `Supervisor::prepare_run` enforces the same rule
    // and this is only the version that reaches the UI with the contract's own code. The front
    // end reads `draft` and `approved` as live and offers **Stop** over both, so it does not
    // normally get here.
    if let Some(live) = ready.supervisor.runs().into_iter().find(|r| !r.stopping()) {
        return Err(AppError::new(
            "run_already_live",
            format!(
                "run {} is already live; stop it before starting another",
                live.plan_id()
            ),
        ));
    }

    let mut spec = RunSpec::new(
        project_id.clone(),
        goal.clone(),
        DriverKind::new(&provider),
        ready.barrier.clone(),
    )
    .with_model(model.filter(|m| !m.trim().is_empty()))
    .with_permission_mode(
        permission_mode
            .as_deref()
            .map_or(PermissionMode::Default, PermissionMode::from),
    );
    // Every bound a run works inside is an assumption, and one of them has already killed a
    // planner that was working. `from_env` lets the person watching it fail change it without a
    // rebuild; with nothing set it is `Limits::default()`.
    spec.effort = effort.filter(|e| e != "auto");
    spec.orchestration =
        crate::workbench_data::peer_settings(&ready.data_dir, &project_id)?.execution_policy();
    spec.limits = brigadier_supervisor::loop_::Limits::from_env();
    spec.limits.concurrency = spec.limits.concurrency.min(spec.orchestration.concurrency);
    if let Some(plan_id) = resumable(ready, &project_id, &goal).await? {
        tracing::info!(
            plan_id,
            project_id,
            "continuing an unfinished plan rather than writing a new one"
        );
        ready.clear_stopped(&plan_id)?;
        ready.supervisor.clear_run_stop(&plan_id)?;
        spec = spec.resuming(plan_id);
    }
    let handle = ready.supervisor.start_run(spec).await.map_err(run_error)?;

    let plan_id = handle.plan_id().to_owned();
    run_view(ready, &plan_id).await?.ok_or_else(|| {
        AppError::store(format!(
            "run {plan_id} started but the store has no plan row for it"
        ))
    })
}

/// The newest plan for a project, live or finished, or `null` when there has never been one.
///
/// The plan card polls this once a second while a run is live: this contract names exactly one
/// signal edge, `runtime-warning`, and it does not fire when a phase goes green.
#[tauri::command]
pub(crate) async fn current_run(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Option<RunView>, AppError> {
    let ready = state.get()?;
    let Some(plan) = ready.store().current_plan(&project_id).await? else {
        return Ok(None);
    };
    run_view(ready, &plan.id).await
}

/// Stop dispatching. **This never kills a worker mid-order.**
///
/// A worker killed part-way leaves a worktree whose `work_order` intent can only ever settle
/// `unknown`, which blocks its phase permanently — so the cheap-looking implementation of "stop"
/// is the one that poisons the plan (`docs/research/intent-records.md` §5.1). In-flight orders
/// finish and are collected; nothing new is dispatched after the current step.
///
/// **The plan is *not* moved to `abandoned` in the store, because the store has no op that
/// could.** Its only status transition is `plan_approved`. The stop is remembered in memory for
/// this launch and [`crate::views::run_status`] reports it; after a restart the plan reads
/// `approved` again and one more press of Stop re-marks it. Errors: `no_such_plan`.
#[tauri::command]
pub(crate) async fn stop_run(plan_id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    let ready = state.get()?;
    ready
        .store()
        .plan(&plan_id)
        .await?
        .ok_or_else(|| AppError::new("no_such_plan", format!("no plan {plan_id}")))?;
    // `false` here is not a failure: the plan exists but no task of *this* launch is driving it,
    // which is what a plan left behind by a previous launch looks like. The stop is still
    // recorded, so the surface stops offering to stop a run that is not running.
    ready.mark_stopped(&plan_id)?;
    let was_live = ready.supervisor.stop_run(&plan_id);
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    let proposals = ready.data_dir.join("runs").join(&plan_id);
    if proposals.is_dir() {
        for entry in std::fs::read_dir(proposals)? {
            let path = entry?.path();
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("competing-") && n.ends_with(".json"))
            {
                let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)
                    .map_err(|e| AppError::io(e.to_string()))?;
                v["approved"] = serde_json::Value::Null;
                v["requestId"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
                crate::note_files::atomic_write(
                    &path,
                    &serde_json::to_vec(&v).map_err(|e| AppError::io(e.to_string()))?,
                )?;
            }
        }
    }
    tracing::info!(
        plan_id,
        was_live,
        "run stopped; cancelling in-flight owned calls"
    );
    Ok(())
}

/// Every intent nothing has answered, oldest first. **Not scoped to a project**, matching the
/// command's own signature: an intent left by a run in another repository stays on screen.
#[tauri::command]
pub(crate) async fn unsettled_intents(
    state: State<'_, AppState>,
) -> Result<Vec<IntentView>, AppError> {
    unsettled(state.get()?).await
}

/// [`unsettled_intents`] without the Tauri wrapper: the exact list the webview receives.
async fn unsettled(ready: &Ready) -> Result<Vec<IntentView>, AppError> {
    let rows = ready.store().unsettled_intents().await?;
    Ok(rows.iter().map(IntentView::from).collect())
}

/// The owner's answer to one unsettled intent, after they have looked at the diff.
///
/// The managed state is named `app` here and not `state` because **`state` is the contract's own
/// argument name** for the settlement (`"done"` | `"not_done"`), and Tauri looks arguments up by
/// parameter name. `State<'_, AppState>` is resolved by type, so the rename costs nothing.
///
/// Errors: `no_such_intent`, `invalid_argument`, and `store` for the one case in [`settle`] that
/// must never be answered `Ok(())`.
#[tauri::command]
pub(crate) async fn settle_intent(
    intent_id: String,
    state: String,
    app: State<'_, AppState>,
) -> Result<(), AppError> {
    settle(app.get()?, &intent_id, &state).await
}

/// [`settle_intent`] without the Tauri wrapper, so the whole of it is reachable from a test.
///
/// Goes through `StoreHandle::intent_settled_by_operator`, **not** `intent_close`. The two are
/// different doors on purpose (`crates/store/src/writer.rs`): `intent_close` is guarded on
/// `state = 'open'` so a late or duplicate close cannot resurrect a settled row, and the rows this
/// button exists for read `unknown`. The operator path is guarded on `state IN ('open', 'unknown')`
/// — every row the owner can be looking at, and nothing that already carries a real answer.
///
/// **A `work_order` answered *done* still lands on `unknown`, and that is a success, not a
/// failure.** `hold_to_settleable` applies to the owner too; the narrowing is the owner's own
/// decision of 2026-09-04 and a button does not outrank it. What changes is that the row now
/// carries `outcome = 'operator'` and evidence naming what the human said, and **drops off
/// `unsettled_intents`** — the list stops asking a question a person has answered. That is what
/// stops this being a no-op; the state word is not.
///
/// **The write is verified before this answers `Ok(())`.** `intent_settled_by_operator` is
/// fire-and-forget — `apply_batch` logs and skips a statement that fails — and its `UPDATE` can
/// still match nothing if something settled the row between the read above and the write. So the
/// list is re-read afterwards (`Op::Query` runs inside the same transaction as everything queued
/// before it, so no flush is needed) and a row still on it is reported as `store` rather than
/// swallowed. A button that reports success and did nothing is the same class of defect as an
/// approvals dock showing a decision that never landed.
async fn settle(ready: &Ready, intent_id: &str, state: &str) -> Result<(), AppError> {
    let settlement = match state {
        "done" => IntentState::Done,
        "not_done" => IntentState::NotDone,
        other => {
            return Err(AppError::invalid_argument(format!(
                "not a settlement: {other:?}; expected done or not_done"
            )));
        }
    };
    let rows = ready.store().unsettled_intents().await?;
    // A row that is not on the list is either one that never existed or one somebody has already
    // answered; neither is a question this command can answer, and `no_such_intent` is the code
    // the contract gives both.
    if !rows.iter().any(|r| r.id == intent_id) {
        return Err(AppError::new(
            "no_such_intent",
            format!("no unsettled intent {intent_id}"),
        ));
    }
    ready
        .store()
        .intent_settled_by_operator(
            intent_id.to_owned(),
            settlement,
            Some(format!("the owner looked at this and marked it {state}")),
            std::time::SystemTime::now(),
        )
        .await?;
    if ready
        .store()
        .unsettled_intents()
        .await?
        .iter()
        .any(|r| r.id == intent_id)
    {
        return Err(AppError::store(format!(
            "intent {intent_id} is still unsettled after the operator write; nothing was recorded"
        )));
    }
    tracing::info!(intent_id, settlement = %state, "intent settled by the owner");
    Ok(())
}

/// The plan the loop should continue instead of writing a new one, if there is one.
///
/// A fresh plan for a goal that is already half-committed would re-plan work that is in the
/// repository, which is what `RunSpec::plan_id` exists to prevent — *"this is what a restart
/// is"*. The rule is deliberately narrow, because the opposite mistake is worse:
///
/// - the goal must match the stored one **verbatim** (trimmed). A different goal is a different
///   run and gets its own plan; the goal is immutable for a run
///   (`orchestration-loop.md` §10 invariant 1), so it is never written over;
/// - a plan whose every phase is `green` is finished and is never reopened.
///
/// A plan the owner stopped is still resumable: pressing Start again on the same goal is a
/// request to continue, not to start over.
async fn resumable(
    ready: &Ready,
    project_id: &str,
    goal: &str,
) -> Result<Option<String>, AppError> {
    let Some(plan) = ready.store().current_plan(project_id).await? else {
        return Ok(None);
    };
    if plan.goal.trim() != goal {
        return Ok(None);
    }
    let phases = ready.store().phases(&plan.id).await?;
    if !phases.is_empty() && phases.iter().all(|p| p.state == PhaseState::Green) {
        return Ok(None);
    }
    Ok(Some(plan.id))
}

/// One plan, its phases, each phase's orders and the plan's unknowns, in wire shape.
async fn run_view(ready: &Ready, plan_id: &str) -> Result<Option<RunView>, AppError> {
    let Some(plan) = ready.store().plan(plan_id).await? else {
        return Ok(None);
    };
    let phases: Vec<PhaseRow> = ready.store().phases(&plan.id).await?;
    let mut orders: Vec<Vec<WorkOrderRow>> = Vec::with_capacity(phases.len());
    for phase in &phases {
        orders.push(ready.store().work_orders(&phase.id).await?);
    }
    let unknowns: Vec<UnknownRow> = ready.store().unknowns(&plan.id).await?;
    let mut view = RunView::new(
        &plan,
        &phases,
        &orders,
        &unknowns,
        ready.is_stopped(&plan.id),
    );
    if matches!(view.status, "draft" | "approved")
        && !ready
            .supervisor
            .run(&plan.id)
            .is_some_and(|run| run.active())
    {
        view.status = "abandoned";
    }
    Ok(Some(view))
}

/// `SessionLive` out of a run start is the contract's `run_already_live`, not `session_running`.
///
/// The supervisor has one code table and reuses `SessionLive` for "a run is already live"; the
/// two have opposite remedies on screen — end a session, versus stop a run — so the finer code
/// wins here exactly as `claude_not_installed` wins over `driver` in [`crate::error`].
fn run_error(e: SupervisorError) -> AppError {
    match &e {
        SupervisorError::SessionLive(_) => AppError::new("run_already_live", e.to_string()),
        _ => AppError::from(e),
    }
}

/// Install the feed channel. Called on mount and again after every webview reload.
///
/// Replaces whatever was there. A reload leaves the old channel alive from Rust's side but its
/// callback id is gone from the page, so every `send` on it silently vanishes — this call is the
/// only signal that a new document is ready to receive.
// see docs/research/tauri-commands.md §6.1.
#[tauri::command]
pub(crate) async fn subscribe_feed(
    on_batch: Channel<FeedBatch>,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state.get()?.sink.replace(on_batch);
    tracing::debug!("feed channel installed");
    Ok(())
}

/// Rows for projects outside this list are dropped in Rust and counted; signals still flow.
#[tauri::command]
pub(crate) async fn set_visible_projects(
    project_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state.get()?.supervisor.set_visible_projects(project_ids);
    Ok(())
}

/// Append one window of the page's frame-rate meter to `<data_dir>/frame-stats.ndjson`.
///
/// The file is append-only and never read back by the app; it is the evidence behind the honest
/// FPS numbers in `docs/research/feed-rendering.md` and the 60 Hz row in `docs/STATUS.md` §4, and
/// it is small enough not to need rotation.
#[tauri::command]
pub(crate) async fn record_frame_stats(
    stats: FrameStats,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    use std::io::Write;

    let path = state.get()?.data_dir.join("frame-stats.ndjson");
    let mut line = serde_json::to_vec(&stats)
        .map_err(|e| AppError::invalid_argument(format!("frame stats would not serialize: {e}")))?;
    line.push(b'\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    file.write_all(&line)?;
    Ok(())
}

/// Append one paint the page timed to `<data_dir>/paint.ndjson`, and log `main()` → FCP once.
///
/// **A sibling file, not `frame-stats.ndjson`.** `docs/research/perceived-performance.md` §5.3
/// step 3 suggests reusing that file; this deviates deliberately. `frame-stats.ndjson` holds 1,513
/// homogeneous `FrameStats` lines and is the evidence base for the 60 Hz claim in
/// `docs/STATUS.md` §4 and §5.4 of the research file — a line of a different shape in it breaks
/// every reader of that evidence. A second file costs nothing.
///
/// Append-only and never read back by the app, exactly like its sibling.
///
/// The `fcp` arm also emits one `tracing::info!` carrying the `main()` → FCP delta, so the launch
/// recipe in §5.2 — which already parses the `RUST_LOG=info` stream for `brigadier started` —
/// picks the number up with no new plumbing.
///
/// **A `trace:`-prefixed `interaction` is a launch signpost, not a paint, and never reaches the
/// file** — see [`TRACE_LABEL_PREFIX`].
#[tauri::command]
pub(crate) async fn report_paint(
    report: PaintReport,
    state: State<'_, crate::launch::LaunchState>,
) -> Result<(), AppError> {
    use std::io::Write;

    // FCP can precede provider/store initialization. Its one-shot report must not
    // disappear behind AppState's startup_pending error.
    std::fs::create_dir_all(&state.dir)?;
    let path = state.dir.join("paint.ndjson");
    let process_start_epoch_ms = crate::process_start_epoch_ms();

    // A launch signpost leaves through stderr and **returns before the file write**, so no
    // `duration_ms: 0` line ever lands in `paint.ndjson`.
    //
    // The alternative — write it and ask every reader to filter — is the weaker guard. A zero-
    // length span is indistinguishable from a real one to anything that takes a percentile of
    // `duration_ms`, and today `paint.ndjson` has **no reader at all** to teach: nothing in
    // `src-tauri/`, no `scripts/` directory, and no shell or Python recipe in `docs/` reads it
    // (`docs/plans/ipc-contract.md:320` states the append-only intent). A future reader written
    // against this file therefore cannot get it wrong, because the hazard is not in the file.
    //
    // Matching on the prefix, not on one label, so a second signpost needs no change here. The
    // stage name is the label with the prefix stripped: `trace:dcl` becomes `dcl`.
    if let PaintReport::Interaction {
        label,
        start_epoch_ms,
        ..
    } = &report
    {
        if let Some(stage) = label.strip_prefix(TRACE_LABEL_PREFIX) {
            crate::trace::stage_at_epoch_ms(stage, *start_epoch_ms);
            return Ok(());
        }
    }

    let main_to_fcp_ms = match &report {
        PaintReport::Fcp { epoch_ms } => {
            let delta = epoch_ms - process_start_epoch_ms;
            // `main()` entry → first contentful paint. Not `posix_spawn` → FCP (the pre-main
            // segment is invisible), and FCP is a render timestamp, not a presentation one.
            tracing::info!(main_to_fcp_ms = delta, "first contentful paint");
            // The last signpost of the launch, on the same zero as every `BRIGADIER_TRACE` line.
            // It arrives on the page's clock, not the monotonic one — see `crate::trace`.
            crate::trace::stage_at_epoch_ms("fcp", *epoch_ms);
            Some(delta)
        }
        // Every `trace:` label already returned above, so this arm is only ever a budget span.
        PaintReport::Interaction { .. } => None,
    };

    let line_struct = PaintLine {
        process_start_epoch_ms,
        main_to_fcp_ms,
        report,
    };
    let mut line = serde_json::to_vec(&line_struct).map_err(|e| {
        AppError::invalid_argument(format!("paint report would not serialize: {e}"))
    })?;
    line.push(b'\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    file.write_all(&line)?;
    Ok(())
}

/// The namespace that marks an `interaction` label as a launch signpost rather than a budget span.
///
/// Held apart from B4, B6 and B7, which are names of budgets in `docs/vision.md` §9 and are written
/// verbatim by their call sites. A signpost carries one timestamp and `duration_ms: 0`, which is
/// what the `interaction` variant already expresses, so it needs no new wire shape and neither
/// `src/wire.ts` nor `views.rs` changes.
///
/// **The emitter is `src/paint.ts` and belongs to the frontend session**, not to this crate. Two
/// labels come through it: `trace:dcl`, whose timestamp is the browser's own
/// `domContentLoadedEventStart` or `domContentLoadedEventEnd`, and `trace:dcl-approx`, whose
/// timestamp is the `DOMContentLoaded` handler's turn in the task queue and is used only where
/// there is no navigation entry to read. Nothing here has to know which: the prefix is stripped
/// and the remainder becomes the stage name, so the stderr line says `stage=dcl` or
/// `stage=dcl-approx` and the reader can tell the two clocks apart.
///
/// `docs/research/launch-signposts.md` records what the page must send, the HTML Standard §13.2.7
/// step order it follows from, and the defects in the earlier recipes written for it.
const TRACE_LABEL_PREFIX: &str = "trace:";

/// Persist a complete raw benchmark capture separately from ordinary frame telemetry.
#[tauri::command]
pub(crate) async fn record_burn_capture(
    capture: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    if !cfg!(any(debug_assertions, feature = "burn")) {
        return Err(AppError::invalid_argument("burn is compiled out"));
    }
    let bytes = serde_json::to_vec(&capture).map_err(|e| AppError::invalid_argument(e.to_string()))?;
    if bytes.len() > 2_000_000 {
        return Err(AppError::invalid_argument("burn capture exceeds 2 MB"));
    }
    let path = state.get()?.data_dir.join("burn-capture.json");
    std::fs::write(path, bytes)?;
    Ok(())
}

/// The 10-agent burn: `sessions` replay drivers fed from a captured fixture, through the real
/// batcher and the real channel, for `duration_s` seconds.
///
/// Dev builds only. In a release build it is registered but refuses, so the front end gets an
/// honest `invalid_argument` instead of "command not found".
#[tauri::command]
#[cfg_attr(not(any(debug_assertions, feature = "burn")), allow(unused_variables))]
pub(crate) async fn burn(
    sessions: usize,
    rows_per_sec: f64,
    duration_s: f64,
    fixture: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    #[cfg(any(debug_assertions, feature = "burn"))]
    {
        crate::burn::run(state.inner(), sessions, rows_per_sec, duration_s, &fixture).await
    }
    #[cfg(not(any(debug_assertions, feature = "burn")))]
    {
        Err(AppError::invalid_argument(
            "burn is compiled out; build with --features burn",
        ))
    }
}

/// Read one session back out of the store in wire shape.
///
/// The row is written before `start_session` returns, so this cannot miss; a `None` here would
/// mean the store lost a write, which is worth naming rather than papering over.
pub(crate) async fn session_view(
    state: &AppState,
    session_id: &SessionId,
) -> Result<SessionView, AppError> {
    match state.get()?.supervisor.session(session_id).await? {
        Some(record) => Ok(SessionView::from(&record)),
        None => Err(AppError::store(format!(
            "session {session_id} was started but the store has no row for it"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brigadier_store::intents::{IntentOutcome, IntentRow, KnownIntentKind};
    use std::time::SystemTime;

    /// A real [`Ready`] over a throwaway data directory.
    ///
    /// `state::build` is the app's own startup path and is Tauri-free, so this is the whole thing
    /// the commands run against. It probes `claude --version` on the way through — one child, no
    /// session and no API call, exactly as a launch does — and stores the result either way, so a
    /// machine with no `claude` on `PATH` runs these tests unchanged.
    async fn ready() -> (tempfile::TempDir, Ready) {
        let dir = tempfile::tempdir().expect("data dir");
        let ready = crate::state::build(dir.path().to_owned())
            .await
            .expect("state builds");
        (dir, ready)
    }

    /// One `work_order` intent in the state a reconciler's postcondition leaves it: held to
    /// `unknown` by the kind's settleable set, with `outcome = 'reconciled'`.
    async fn unknown_work_order(ready: &Ready, id: &str) {
        let mut intent = IntentRow::new(id, KnownIntentKind::WorkOrder, SystemTime::now());
        intent.subject = Some("/repo/.brigadier/worktrees/abcd1234".to_owned());
        intent.detail_json = r#"{"order_id":"o1","phase_id":"ph1"}"#.to_owned();
        ready
            .store()
            .intent_open(intent)
            .await
            .expect("intent opened");
        ready
            .store()
            .intent_close(
                id.to_owned(),
                IntentState::Unknown,
                IntentOutcome::Reconciled,
                Some("rev-list --count -> 1".to_owned()),
                None,
                SystemTime::now(),
            )
            .await
            .expect("intent closed");
    }

    /// The button the plan card offers, on the row it exists for.
    ///
    /// A `work_order` marked *done* by hand still reads `unknown` — `hold_to_settleable` applies
    /// to the owner too — so the thing that proves the button works is not the state word. It is
    /// that the row **leaves the list**: a question a person has answered is not one they are
    /// asked again.
    #[tokio::test]
    async fn settling_an_unknown_work_order_takes_it_off_the_list() {
        let (_dir, ready) = ready().await;
        unknown_work_order(&ready, "i1").await;

        let before = unsettled(&ready).await.expect("read");
        assert_eq!(before.len(), 1, "{before:?}");
        assert_eq!(before[0].intent_id, "i1");
        assert_eq!(before[0].kind, "work_order");
        // The wire's only value, and what the plan card renders.
        assert_eq!(before[0].state, "unknown");

        settle(&ready, "i1", "done")
            .await
            .expect("the owner's answer is recorded");

        let after = unsettled(&ready).await.expect("read");
        assert!(
            after.is_empty(),
            "the answered intent is still being asked about: {after:?}"
        );
    }

    /// `not_done` goes down the same path. The store still holds a `work_order` to `unknown`;
    /// what is recorded is that a human answered, and the row goes.
    #[tokio::test]
    async fn not_done_settles_the_same_way() {
        let (_dir, ready) = ready().await;
        unknown_work_order(&ready, "i2").await;
        settle(&ready, "i2", "not_done").await.expect("recorded");
        assert!(unsettled(&ready).await.expect("read").is_empty());
    }

    /// Answering the same row twice is not a second question: it is gone from the list, and the
    /// contract's code for a row this command cannot answer is `no_such_intent`.
    #[tokio::test]
    async fn a_row_that_is_not_on_the_list_is_no_such_intent() {
        let (_dir, ready) = ready().await;
        unknown_work_order(&ready, "i3").await;
        settle(&ready, "i3", "done").await.expect("recorded");

        let again = settle(&ready, "i3", "done")
            .await
            .expect_err("a second answer is refused");
        assert_eq!(again.code, "no_such_intent", "{again}");
        let never = settle(&ready, "nope", "done")
            .await
            .expect_err("an unknown id is refused");
        assert_eq!(never.code, "no_such_intent", "{never}");
    }

    /// Neither `allow` nor `deny` nor anything else: an unsettled intent is not a permission
    /// question. Checked before the row is looked up, so a bad verb never reaches the store.
    #[tokio::test]
    async fn only_done_and_not_done_are_settlements() {
        let (_dir, ready) = ready().await;
        unknown_work_order(&ready, "i4").await;
        for verb in ["allow", "deny", "DONE", ""] {
            let e = settle(&ready, "i4", verb).await.expect_err("refused");
            assert_eq!(e.code, "invalid_argument", "{verb:?}: {e}");
        }
        assert_eq!(
            unsettled(&ready).await.expect("read").len(),
            1,
            "the row was touched"
        );
    }

    /// An `open` row — what a launch that died mid-order leaves — is settleable by the same
    /// button, and the operator path's wider guard is what makes both work.
    #[tokio::test]
    async fn an_intent_nothing_ever_closed_settles_too() {
        let (_dir, ready) = ready().await;
        let mut intent = IntentRow::new("i5", KnownIntentKind::WorktreeAdd, SystemTime::now());
        intent.subject = Some("/repo/.brigadier/worktrees/abcd1234".to_owned());
        ready
            .store()
            .intent_open(intent)
            .await
            .expect("intent opened");
        assert_eq!(unsettled(&ready).await.expect("read").len(), 1);

        settle(&ready, "i5", "done").await.expect("recorded");
        assert!(unsettled(&ready).await.expect("read").is_empty());
    }
}

/// Selected-thread content is fetched separately from the small activity channel.
#[tauri::command]
pub(crate) async fn chat_items(
    session_id: String,
    after: u64,
    state: State<'_, AppState>,
) -> Result<Vec<brigadier_store::chat::ChatItem>, AppError> {
    Ok(state.get()?.store().chat_items(session_id, after).await?)
}

#[tauri::command]
pub(crate) async fn conversation_history_page(
    session_id: String,
    before: Option<u64>,
    after: Option<u64>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<brigadier_store::chat::HistoryPage, AppError> {
    if before.is_some() && after.is_some() {
        return Err(AppError::invalid_argument(
            "Use either before or after, not both",
        ));
    }
    Ok(state
        .get()?
        .store()
        .conversation_history_page(session_id, before, after, limit.unwrap_or(60))
        .await?)
}

/// Recorded lifecycle boundaries for the selected conversation.
#[tauri::command]
pub(crate) async fn chat_turns(
    session_id: String,
    start: Option<u64>,
    end: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Vec<brigadier_store::chat::ChatTurn>, AppError> {
    if start.is_some() || end.is_some() {
        let (start, end) = (start.unwrap_or(0), end.unwrap_or(i64::MAX as u64));
        if start > end {
            return Err(AppError::invalid_argument(
                "History range start must not exceed its end",
            ));
        }
        Ok(state
            .get()?
            .store()
            .chat_turns_in_range(session_id, start, end)
            .await?)
    } else {
        Ok(state.get()?.store().chat_turns(session_id).await?)
    }
}

/// Options accepted for a new Claude child. Unknown knobs fail instead of silently doing nothing.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AgentOptions {
    pub(crate) effort: Option<String>,
}
fn apply_agent_options(
    req: &mut StartSession,
    options: Option<&AgentOptions>,
) -> Result<(), AppError> {
    // Interactive chat follows the selected model's thinking default. Harness lanes keep
    // their own per-role policy; this function is called only by start_session.
    req.thinking = brigadier_core::driver::ThinkingPolicy::Inherit;
    let Some(effort) = options.and_then(|options| options.effort.as_deref()) else {
        return Ok(());
    };
    if !["auto", "low", "medium", "high", "xhigh", "max"].contains(&effort) {
        return Err(AppError::invalid_argument("Unsupported effort level"));
    }
    let model = req.model.as_deref().unwrap_or("");
    if model.contains("haiku")
        || model.contains("sonnet-4-5")
        || model.contains("opus-4-1")
        || model.contains("opus-4-0")
    {
        return Err(AppError::invalid_argument(
            "This model does not support effort",
        ));
    }
    req.effort = if effort == "auto" {
        None
    } else {
        Some(effort.to_owned())
    };
    req.env_overrides
        .insert("CLAUDE_CODE_EFFORT_LEVEL".to_owned(), effort.to_owned());
    Ok(())
}

#[cfg(test)]
mod agent_option_tests {
    use super::*;
    #[test]
    fn effort_is_forwarded_and_unsupported_controls_fail() {
        let mut request = StartSession::new("/tmp");
        request.model = Some("claude-opus-5".into());
        apply_agent_options(&mut request, None).unwrap();
        assert_eq!(
            request.thinking,
            brigadier_core::driver::ThinkingPolicy::Inherit
        );
        apply_agent_options(
            &mut request,
            Some(&AgentOptions {
                effort: Some("high".into()),
            }),
        )
        .unwrap();
        assert_eq!(
            request
                .env_overrides
                .get("CLAUDE_CODE_EFFORT_LEVEL")
                .unwrap(),
            "high"
        );
        request.model = Some("claude-haiku-4-5".into());
        assert!(apply_agent_options(
            &mut request,
            Some(&AgentOptions {
                effort: Some("high".into())
            })
        )
        .is_err());
        assert!(serde_json::from_str::<AgentOptions>(r#"{"speed":"fast"}"#).is_err());
    }
}

/// User-only approval of the exact saved competing-work proposal. Does not resume a stopped run.
#[tauri::command]
pub(crate) async fn decide_run_competing(
    plan_id: String,
    phase_id: String,
    request_id: String,
    allow: bool,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    for id in [&plan_id, &phase_id] {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(AppError::invalid_argument("Invalid plan or phase identity"));
        }
    }
    let ready = state.get()?;
    if ready.is_stopped(&plan_id) || ready.supervisor.run(&plan_id).is_some_and(|r| r.stopping()) {
        return Err(AppError::invalid_argument(
            "Task is stopped; continue explicitly before approving more work",
        ));
    }
    let path = ready
        .data_dir
        .join("runs")
        .join(&plan_id)
        .join(format!("competing-{phase_id}.json"));
    let mut v: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path)?).map_err(|e| AppError::io(e.to_string()))?;
    if v["requestId"].as_str() != Some(request_id.as_str()) {
        return Err(AppError::invalid_argument(
            "This approval was cancelled or replaced; reload the current proposal",
        ));
    }
    if v["approved"].as_bool().is_some_and(|old| old != allow) {
        return Err(AppError::invalid_argument(
            "This proposal was already resolved differently",
        ));
    }
    let phase = ready
        .store()
        .phases(&plan_id)
        .await?
        .into_iter()
        .find(|p| p.id == phase_id)
        .ok_or_else(|| AppError::invalid_argument("Phase does not belong to this plan"))?;
    if v["criteria"] != phase.definition_of_done
        || v["verifyCommand"] != serde_json::json!(phase.verify_command)
    {
        return Err(AppError::invalid_argument(
            "Requirements changed; continue to prepare a new proposal",
        ));
    }
    if !phase
        .last_evidence
        .as_deref()
        .is_some_and(|e| e.starts_with("Competing implementations require user approval"))
        && v["approved"] != true
    {
        return Err(AppError::invalid_argument(
            "This phase is not waiting for this approval",
        ));
    }
    v["approved"] = serde_json::json!(allow);
    crate::note_files::atomic_write(
        &path,
        &serde_json::to_vec(&v).map_err(|e| AppError::io(e.to_string()))?,
    )?;
    if allow && phase.state == brigadier_store::plan::PhaseState::Blocked {
        if ready.is_stopped(&plan_id) {
            return Err(AppError::invalid_argument(
                "Task stopped before approval could take effect",
            ));
        }
        ready
            .store()
            .phase_settled(
                phase_id,
                brigadier_store::plan::PhaseState::Running,
                phase.last_exit_code,
                Some("Competing proposal approved; continue explicitly".into()),
                None,
                std::time::SystemTime::now(),
            )
            .await?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn read_run_competing(
    plan_id: String,
    phase_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, AppError> {
    for id in [&plan_id, &phase_id] {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(AppError::invalid_argument("Invalid plan or phase identity"));
        }
    }
    let path = state
        .get()?
        .data_dir
        .join("runs")
        .join(plan_id)
        .join(format!("competing-{phase_id}.json"));
    serde_json::from_slice(&std::fs::read(path)?).map_err(|e| AppError::io(e.to_string()))
}
