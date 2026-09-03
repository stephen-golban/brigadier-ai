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

use brigadier_core::driver::{DriverKind, PermissionMode, StartSession};
use brigadier_core::event::{RequestId, SessionId};
use brigadier_core::session::Decision;
use brigadier_supervisor::{ApprovalView, FeedBatch, FeedRowWire, WorktreeCleanup};
use tauri::ipc::Channel;
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;
use crate::views::{
    AppInfo, ClaudeStatus, FrameStats, ModelInfo, PaintLine, PaintReport, ProjectView, SessionView,
    TurnStarted,
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
    Ok(crate::views::models())
}

/// Every project, oldest first.
#[tauri::command]
pub(crate) async fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectView>, AppError> {
    let rows = state.get()?.supervisor.list_projects().await?;
    Ok(rows.iter().map(ProjectView::from).collect())
}

/// Record a project rooted at `path`. An existing tree returns its existing row.
#[tauri::command]
pub(crate) async fn add_project(
    path: String,
    state: State<'_, AppState>,
) -> Result<ProjectView, AppError> {
    let row = state.get()?.supervisor.add_project(PathBuf::from(path)).await?;
    Ok(ProjectView::from(&row))
}

/// Every session, newest first.
#[tauri::command]
pub(crate) async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionView>, AppError> {
    let rows = state.get()?.supervisor.list_sessions().await?;
    Ok(rows.iter().map(SessionView::from).collect())
}

/// Start a Claude session in a project's root and send `prompt` as its first turn.
#[tauri::command]
pub(crate) async fn start_session(
    project_id: String,
    prompt: String,
    model: Option<String>,
    permission_mode: String,
    state: State<'_, AppState>,
) -> Result<SessionView, AppError> {
    // Fail with the code the UI has a remedy for. Without this the supervisor answers
    // `NoDriver` → `driver`, which tells the operator nothing about the missing install.
    state.claude_status()?;

    let supervisor = &state.get()?.supervisor;
    let project = supervisor
        .project(&project_id)
        .await?
        .ok_or_else(|| AppError::new("no_such_project", format!("no project {project_id}")))?;

    let mut req = StartSession::new(project.root_path);
    req.prompt = Some(prompt);
    req.model = model;
    // An unmodelled mode is passed through verbatim rather than rejected; the CLI owns the
    // vocabulary. see crates/core/src/driver.rs `PermissionMode`.
    req.permission_mode = PermissionMode::from(permission_mode.as_str());

    let session_id = supervisor.start_session(&project_id, &DriverKind::new(CLAUDE_CODE), req).await?;
    session_view(state.inner(), &session_id).await
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
    // Same reason as `start_session`: the supervisor would answer `NoDriver` → `driver`, which
    // tells the operator nothing about a missing install.
    state.claude_status()?;
    let session_id = SessionId::new(session_id);
    let session_id = state.get()?.supervisor.resume_session(&session_id).await?;
    session_view(state.inner(), &session_id).await
}

/// Queue a user turn on a live session.
#[tauri::command]
pub(crate) async fn send_turn(
    session_id: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<TurnStarted, AppError> {
    let turn_id =
        state.get()?.supervisor.send_turn(&SessionId::new(session_id), text).await?;
    Ok(TurnStarted { turn_id: turn_id.into_inner() })
}

/// Answer a parked permission request.
#[tauri::command]
pub(crate) async fn respond(
    session_id: String,
    request_id: String,
    decision: Decision,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state
        .get()?
        .supervisor
        .respond(&SessionId::new(session_id), RequestId::new(request_id), decision)
        .await?;
    Ok(())
}

/// End the current turn; the session survives.
#[tauri::command]
pub(crate) async fn interrupt(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state.get()?.supervisor.interrupt(&SessionId::new(session_id)).await?;
    Ok(())
}

/// Ask the session to end. The exit arrives on the feed, not from this call.
#[tauri::command]
pub(crate) async fn end_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state.get()?.supervisor.end_session(&SessionId::new(session_id)).await?;
    Ok(())
}

/// Kill the session's process group.
#[tauri::command]
pub(crate) async fn kill(session_id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    state.get()?.supervisor.kill(&SessionId::new(session_id)).await?;
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

/// The newest `n` feed rows for a session, oldest first — what a fresh mount replays before it
/// switches to live batches.
#[tauri::command]
pub(crate) async fn feed_tail(
    session_id: String,
    n: usize,
    state: State<'_, AppState>,
) -> Result<Vec<FeedRowWire>, AppError> {
    Ok(state.get()?.supervisor.feed_tail(&SessionId::new(session_id), n).await?)
}

/// Every unanswered approval, oldest first, each marked resumable or expired.
#[tauri::command]
pub(crate) async fn pending_approvals(
    state: State<'_, AppState>,
) -> Result<Vec<ApprovalView>, AppError> {
    Ok(state.get()?.supervisor.pending_approvals().await?)
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
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
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
/// The one `interaction` label that is a launch signpost rather than a budget span.
///
/// Namespaced with `trace:` so it can never collide with a B4/B6/B7 label, which are the names of
/// budgets in `docs/vision.md` §9 and are written verbatim by their call sites.
const TRACE_DCL_LABEL: &str = "trace:dcl";

#[tauri::command]
pub(crate) async fn report_paint(
    report: PaintReport,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    use std::io::Write;

    let path = state.get()?.data_dir.join("paint.ndjson");
    let process_start_epoch_ms = crate::process_start_epoch_ms();
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
        // The `DOMContentLoaded` signpost, carried on the `interaction` variant rather than a new
        // wire shape: the page has one timestamp and no duration, which is exactly what a span of
        // zero length is, and `src/wire.ts` and `views.rs` therefore need no change.
        //
        // **Inert until the frontend half lands.** Nothing sends this label today — the emitter is
        // three lines in `src/paint.ts`, spelled out in `docs/research/launch-signposts.md`, and
        // `src/` belongs to another session. It is here first so that landing the emitter is a
        // one-file change with no Rust rebuild of the contract behind it.
        //
        // Only reached when `BRIGADIER_TRACE` is on; `stage_at_epoch_ms` is a cached `bool` load
        // otherwise. The line still goes to `paint.ndjson` either way, as every report does.
        PaintReport::Interaction { label, start_epoch_ms, .. } if label == TRACE_DCL_LABEL => {
            crate::trace::stage_at_epoch_ms("dcl", *start_epoch_ms);
            None
        }
        PaintReport::Interaction { .. } => None,
    };

    let line_struct = PaintLine { process_start_epoch_ms, main_to_fcp_ms, report };
    let mut line = serde_json::to_vec(&line_struct)
        .map_err(|e| AppError::invalid_argument(format!("paint report would not serialize: {e}")))?;
    line.push(b'\n');
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
    file.write_all(&line)?;
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
        Err(AppError::invalid_argument("burn is compiled out; build with --features burn"))
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
