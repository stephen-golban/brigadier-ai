//! Durable owner submissions. A persisted sending receipt is never replayed after restart.
use crate::{error::AppError, state::AppState};
use brigadier_core::{event::SessionId, session::NativeControl};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Draft {
    pub text: String,
    pub attachment_ids: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueuedTurn {
    pub id: String,
    pub text: String,
    pub attachment_ids: Vec<String>,
    pub status: String,
    pub turn_id: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub execution: Option<crate::task_settings::ExecutionSelection>,
    #[serde(default)]
    pub execution_mode: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreationReceipt {
    pub request: Value,
    pub session_id: Option<String>,
    pub status: String,
    pub error: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComposerState {
    #[serde(default)]
    pub revision: u64,
    pub session_id: String,
    #[serde(default)]
    pub waiting: Option<brigadier_core::allowance::Waiting>,
    pub draft: Draft,
    pub paused: bool,
    pub stopping: bool,
    pub stopped: bool,
    pub queue: Vec<QueuedTurn>,
    #[serde(default)]
    pub creations: BTreeMap<String, CreationReceipt>,
}
struct Service {
    dir: PathBuf,
    states: Mutex<BTreeMap<String, ComposerState>>,
    app: tauri::AppHandle,
}
static SERVICE: OnceLock<Service> = OnceLock::new();
fn service() -> Result<&'static Service, AppError> {
    SERVICE
        .get()
        .ok_or_else(|| AppError::io("Conversation queue is unavailable"))
}
fn recover(states: &mut BTreeMap<String, ComposerState>) {
    for state in states.values_mut() {
        state.stopping = false;
        for creation in state.creations.values_mut() {
            if creation.status == "sending" {
                creation.status = "unknown".into();
                creation.error = Some("Application restarted during initial submission; inspect existing conversations before creating another task.".into());
            }
        }
        if state.stopped || state.queue.iter().any(|q| q.status != "sent") {
            state.paused = true;
        }
        for item in &mut state.queue {
            if item.status == "sending" {
                item.status = "unknown".into();
                item.error = Some("App restarted during delivery. Inspect conversation before replacing this request; it will not be replayed.".into());
            }
        }
    }
}
pub(crate) fn start(app: tauri::AppHandle) -> Result<(), AppError> {
    let dir = app.state::<AppState>().get()?.data_dir.clone();
    let mut states = match std::fs::read(dir.join("composer.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| AppError::io(e.to_string()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(e) => return Err(e.into()),
    };
    recover(&mut states);
    crate::note_files::atomic_write(
        &dir.join("composer.json"),
        &serde_json::to_vec(&states).map_err(|e| AppError::io(e.to_string()))?,
    )?;
    SERVICE
        .set(Service {
            dir,
            states: Mutex::new(states),
            app: app.clone(),
        })
        .map_err(|_| AppError::io("Conversation queue already started"))?;
    tauri::async_runtime::spawn(async move {
        let mut changes = crate::peer_sessions::subscribe();
        loop {
            let ids = match service() {
                Ok(s) => s
                    .states
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .values()
                    .filter(|s| {
                        !s.paused && !s.stopped && s.queue.iter().any(|q| q.status == "queued")
                    })
                    .map(|s| s.session_id.clone())
                    .collect::<Vec<_>>(),
                Err(_) => return,
            };
            for id in ids {
                if let Err(e) = drain_one(&app, &id).await {
                    tracing::warn!("Conversation queue: {}", e.message);
                }
            }
            // Provider/feed changes wake draining; fallback covers events before a subscriber joins.
            tokio::select! { _ = changes.changed() => {}, _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {} }
        }
    });
    Ok(())
}
fn read(id: &str) -> Result<ComposerState, AppError> {
    Ok(service()?
        .states
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .cloned()
        .unwrap_or_else(|| ComposerState {
            session_id: id.into(),
            ..Default::default()
        }))
}
fn change(
    id: &str,
    f: impl FnOnce(&mut ComposerState) -> Result<(), AppError>,
) -> Result<ComposerState, AppError> {
    let s = service()?;
    let mut states = s.states.lock().unwrap_or_else(|e| e.into_inner());
    let mut next = states.clone();
    let item = next.entry(id.into()).or_insert_with(|| ComposerState {
        session_id: id.into(),
        ..Default::default()
    });
    f(item)?;
    item.revision = item.revision.saturating_add(1);
    let result = item.clone();
    crate::note_files::atomic_write(
        &s.dir.join("composer.json"),
        &serde_json::to_vec(&next).map_err(|e| AppError::io(e.to_string()))?,
    )?;
    *states = next;
    drop(states);
    let _ = s.app.emit("composer-state", &result);
    let _ = s
        .app
        .emit("conversation-state-changed", json!({"sessionId":id}));
    crate::peer_sessions::notify();
    Ok(result)
}
/// Creation receipts protect the initial Send from a lost webview response or app restart.
pub(crate) fn begin_initial(
    project: &str,
    key: &str,
    request: Value,
) -> Result<Option<String>, AppError> {
    if key.is_empty() || key.len() > 200 {
        return Err(AppError::invalid_argument(
            "Supply a request ID up to 200 characters",
        ));
    }
    let scope = format!("project:{project}");
    let mut existing = None;
    change(&scope, |s| {
        existing = begin_initial_state(s, key, request)?;
        Ok(())
    })?;
    Ok(existing)
}
fn begin_initial_state(
    s: &mut ComposerState,
    key: &str,
    request: Value,
) -> Result<Option<String>, AppError> {
    if let Some(receipt) = s.creations.get_mut(key) {
        if receipt.request != request {
            return Err(AppError::invalid_argument(
                "Initial request ID already belongs to different input",
            ));
        }
        if receipt.status == "failed" {
            receipt.status = "sending".into();
            receipt.error = None;
            return Ok(None);
        }
        if receipt.status == "sent" {
            return Ok(receipt.session_id.clone());
        }
        return Err(AppError::new("creation_unconfirmed", receipt.error.clone().unwrap_or_else(||"Initial submission outcome is unconfirmed. Inspect existing conversations; this request will not be replayed.".into())));
    }
    s.creations.insert(
        key.into(),
        CreationReceipt {
            request,
            session_id: None,
            status: "sending".into(),
            error: None,
        },
    );
    Ok(None)
}

pub(crate) fn finish_initial(
    project: &str,
    key: &str,
    result: Result<String, AppError>,
    dispatch_started: bool,
) -> Result<(), AppError> {
    change(&format!("project:{project}"), |s| {
        let receipt = s
            .creations
            .get_mut(key)
            .ok_or_else(|| AppError::io("Initial submission receipt missing"))?;
        let accepted = result.is_ok();
        let request = receipt.request.clone();
        finish_initial_receipt(receipt, result, dispatch_started);
        if accepted && request.get("prompt").and_then(Value::as_str) == Some(s.draft.text.as_str())
        {
            let attachments: Vec<String> = serde_json::from_value(
                request
                    .get("attachmentIds")
                    .filter(|v| !v.is_null())
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            )
            .unwrap_or_default();
            if attachments == s.draft.attachment_ids {
                s.draft = Draft::default();
            }
        }
        Ok(())
    })?;
    Ok(())
}

fn finish_initial_receipt(
    receipt: &mut CreationReceipt,
    result: Result<String, AppError>,
    dispatch_started: bool,
) {
    match result {
        Ok(id) => {
            receipt.status = "sent".into();
            receipt.session_id = Some(id);
        }
        Err(error) => {
            receipt.status = if dispatch_started {
                "unknown"
            } else {
                "failed"
            }
            .into();
            receipt.error = Some(error.message);
        }
    }
}

pub(crate) fn emit_execution_settings(settings: &crate::task_settings::TaskSettings) {
    if let Some(service) = SERVICE.get() {
        let _ = service.app.emit("task-execution-settings", settings);
    }
}

/// Authenticated owner-authored task inputs for approval adjudication. Peer messages and
/// model-authored checkpoints are deliberately excluded.
pub(crate) fn owner_instructions(id: &str) -> Result<Vec<String>, AppError> {
    let states = service()?.states.lock().unwrap_or_else(|e| e.into_inner());
    let mut inputs = Vec::new();
    for state in states.values() {
        for receipt in state
            .creations
            .values()
            .filter(|r| r.session_id.as_deref() == Some(id) && r.status == "sent")
        {
            if let Some(prompt) = receipt.request.get("prompt").and_then(Value::as_str) {
                inputs.push(prompt.to_owned());
            }
        }
    }
    if let Some(state) = states.get(id) {
        inputs.extend(
            state
                .queue
                .iter()
                .filter(|q| q.status == "sent")
                .map(|q| q.text.clone()),
        );
    }
    Ok(inputs)
}

pub(crate) fn has_pending(id: &str) -> bool {
    // Migrated direct-user queues never dispatch into internal executions and must not
    // indefinitely block their completion wake or retirement. Their receipts stay on disk.
    if crate::peers::snapshot().is_ok_and(|data| data.subagents.contains_key(id)) {
        return false;
    }
    SERVICE.get().is_some()
        && read(id)
            .map(|s| {
                s.queue
                    .iter()
                    .any(|q| matches!(q.status.as_str(), "queued" | "sending" | "unknown"))
            })
            .unwrap_or(true)
}
pub(crate) fn require_running(id: &str) -> Result<(), AppError> {
    if SERVICE.get().is_some() && read(id)?.stopped {
        return Err(AppError::new(
            "task_stopped",
            "Task is stopped. Resume explicitly to continue.",
        ));
    }
    Ok(())
}
async fn validate(state: &AppState, id: &str, text: &str, ids: &[String]) -> Result<(), AppError> {
    crate::peers::require_conversation(id)?;
    if let Some(project) = id.strip_prefix("project:") {
        crate::navigation::require_available(
            &state.get()?.data_dir,
            crate::navigation::Kind::Project,
            project,
        )?;
        if state.get()?.supervisor.project(project).await?.is_none() {
            return Err(AppError::invalid_argument("Project no longer exists"));
        }
        if text.len() > 1024 * 1024 {
            return Err(AppError::invalid_argument("Message exceeds 1 MiB"));
        }
        crate::conversation_data::attachments(state, project, ids.to_vec()).await?;
        return Ok(());
    }
    crate::session_archive::require_active(&state.get()?.data_dir, id)?;
    crate::navigation::require_available(
        &state.get()?.data_dir,
        crate::navigation::Kind::Session,
        id,
    )?;
    let row = state
        .get()?
        .supervisor
        .session(&SessionId::new(id))
        .await?
        .ok_or_else(|| AppError::invalid_argument("Session no longer exists"))?;
    if text.len() > 1024 * 1024 {
        return Err(AppError::invalid_argument("Message exceeds 1 MiB"));
    }
    crate::conversation_data::attachments(
        state,
        row.project_id.as_deref().unwrap_or(""),
        ids.to_vec(),
    )
    .await?;
    state
        .get()?
        .store()
        .retain_attachments(id.into(), ids.to_vec())
        .await?;
    Ok(())
}
fn enqueue(
    state: &mut ComposerState,
    id: String,
    text: String,
    attachment_ids: Vec<String>,
) -> Result<(), AppError> {
    if let Some(existing) = state.queue.iter().find(|q| q.id == id) {
        if existing.text != text || existing.attachment_ids != attachment_ids {
            return Err(AppError::invalid_argument(
                "Request ID already belongs to a different message",
            ));
        }
        return Ok(());
    }
    if id.is_empty() || id.len() > 200 {
        return Err(AppError::invalid_argument(
            "Supply a request ID up to 200 characters",
        ));
    }
    if text.trim().is_empty() && attachment_ids.is_empty() {
        return Err(AppError::invalid_argument(
            "A message or attachment is required",
        ));
    }
    if state.queue.iter().filter(|q| q.status != "sent").count() >= 100 {
        return Err(AppError::invalid_argument(
            "Queue contains 100 pending messages",
        ));
    }
    if state.draft
        == (Draft {
            text: text.clone(),
            attachment_ids: attachment_ids.clone(),
        })
    {
        state.draft = Draft::default();
    }
    state.queue.push(QueuedTurn {
        id,
        text,
        attachment_ids,
        status: "queued".into(),
        turn_id: None,
        error: None,
        execution: None,
        execution_mode: None,
    });
    Ok(())
}
fn enqueue_selected(
    state: &mut ComposerState,
    id: String,
    text: String,
    attachments: Vec<String>,
    execution: Option<crate::task_settings::ExecutionSelection>,
) -> Result<(), AppError> {
    let existed = state.queue.iter().any(|q| q.id == id);
    enqueue(state, id.clone(), text, attachments)?;
    if !existed {
        state
            .queue
            .iter_mut()
            .find(|q| q.id == id)
            .unwrap()
            .execution = execution;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn composer_state(session_id: String) -> Result<ComposerState, AppError> {
    read(&session_id)
}
#[tauri::command]
pub(crate) async fn save_composer_draft(
    session_id: String,
    text: String,
    attachment_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<ComposerState, AppError> {
    let _lock = crate::peers::LIFECYCLE.lock().await;
    validate(state.inner(), &session_id, &text, &attachment_ids).await?;
    // Reserve attachment bytes before durable draft/queue acceptance; deleting another
    // conversation must not collect files referenced by an unsent owner request.
    if !session_id.starts_with("project:") && !attachment_ids.is_empty() {
        state
            .get()?
            .store()
            .retain_attachments(session_id.clone(), attachment_ids.clone())
            .await?;
    }
    change(&session_id, |s| {
        s.draft = Draft {
            text,
            attachment_ids,
        };
        Ok(())
    })
}
#[tauri::command]
pub(crate) async fn enqueue_conversation_turn(
    session_id: String,
    request_id: String,
    text: String,
    attachment_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<ComposerState, AppError> {
    let _lock = crate::peers::LIFECYCLE.lock().await;
    validate(state.inner(), &session_id, &text, &attachment_ids).await?;
    // Reserve attachment bytes before durable draft/queue acceptance; deleting another
    // conversation must not collect files referenced by an unsent owner request.
    if !session_id.starts_with("project:") && !attachment_ids.is_empty() {
        state
            .get()?
            .store()
            .retain_attachments(session_id.clone(), attachment_ids.clone())
            .await?;
    }
    validate_prompt_command(state.inner(), &session_id, &text, &attachment_ids).await?;
    let settings = crate::task_settings::read(state.inner(), &session_id).await?;
    let execution = (settings.mode == "custom").then_some(settings.execution);
    change(&session_id, |s| {
        enqueue_selected(s, request_id, text, attachment_ids, execution)
    })
}
#[tauri::command]
pub(crate) async fn update_queued_turn(
    session_id: String,
    request_id: String,
    text: String,
    attachment_ids: Vec<String>,
    execution: Option<crate::task_settings::ExecutionSelection>,
    state: State<'_, AppState>,
) -> Result<ComposerState, AppError> {
    let _lock = crate::peers::LIFECYCLE.lock().await;
    validate(state.inner(), &session_id, &text, &attachment_ids).await?;
    // Reserve attachment bytes before durable draft/queue acceptance; deleting another
    // conversation must not collect files referenced by an unsent owner request.
    if !session_id.starts_with("project:") && !attachment_ids.is_empty() {
        state
            .get()?
            .store()
            .retain_attachments(session_id.clone(), attachment_ids.clone())
            .await?;
    }
    if text.trim().is_empty() && attachment_ids.is_empty() {
        return Err(AppError::invalid_argument(
            "A message or attachment is required",
        ));
    }
    validate_prompt_command(state.inner(), &session_id, &text, &attachment_ids).await?;
    if let Some(selection) = &execution {
        crate::task_settings::validate_selection(state.inner(), selection)?;
    }
    change(&session_id, |s| {
        let q = s
            .queue
            .iter_mut()
            .find(|q| q.id == request_id && matches!(q.status.as_str(), "queued" | "failed"))
            .ok_or_else(|| AppError::invalid_argument("Only unsent messages can be edited"))?;
        q.text = text;
        q.attachment_ids = attachment_ids;
        if let Some(selection) = execution {
            q.execution = Some(selection);
            q.execution_mode = Some("custom".into());
        }
        q.status = "queued".into();
        q.error = None;
        Ok(())
    })
}
/// Steering is acknowledged by the active Codex turn. Claude interrupts its current
/// turn and immediately starts a fresh bounded execution with the steering input.
#[tauri::command]
pub(crate) async fn steer_queued_turn(
    session_id: String,
    request_id: String,
    state: State<'_, AppState>,
) -> Result<ComposerState, AppError> {
    let _lock = crate::peers::LIFECYCLE.lock().await;
    require_running(&session_id)?;
    let item = read(&session_id)?
        .queue
        .into_iter()
        .find(|q| q.id == request_id && q.status == "queued")
        .ok_or_else(|| {
            AppError::invalid_argument("Only an unsent queued message can steer active work")
        })?;
    validate(state.inner(), &session_id, &item.text, &item.attachment_ids).await?;
    if crate::conversation_data::slash_invocation(&item.text) {
        return Err(AppError::invalid_argument(
            "Commands cannot steer an active response",
        ));
    }
    let id = SessionId::new(&session_id);
    let sup = &state.get()?.supervisor;
    let row = sup
        .session(&id)
        .await?
        .ok_or_else(|| AppError::invalid_argument("Task no longer exists"))?;
    let activity = sup.native_control(&id, NativeControl::Activity).await?;
    if activity["status"] == "Idle" {
        return Err(AppError::invalid_argument(
            "There is no active response to steer",
        ));
    }
    let attachments = crate::conversation_data::attachments(
        state.inner(),
        row.project_id.as_deref().unwrap_or(""),
        item.attachment_ids.clone(),
    )
    .await?;
    let referenced = crate::session_references::contextualize(state.inner(), &item.text).await?;
    let text = crate::conversation_data::contextualize(
        state.inner(),
        row.project_id.as_deref().unwrap_or(""),
        &referenced,
    )?;
    change(&session_id, |s| {
        s.queue
            .iter_mut()
            .find(|q| q.id == request_id)
            .unwrap()
            .status = "sending".into();
        Ok(())
    })?;
    let result: Result<String,AppError> = match tokio::time::timeout(std::time::Duration::from_secs(20), async {
        if row.driver_kind.as_ref().is_some_and(|k|k.as_str()=="codex") {
            sup.native_control(&id,NativeControl::Steer {message_id:brigadier_core::event::TurnId::new(&request_id),input:brigadier_core::session::TurnInput {text,display_text:Some(item.text.clone()),attachments,..Default::default()}}).await?;
            Ok(request_id.clone())
        } else {
            sup.interrupt(&id).await?;
            let deadline=tokio::time::Instant::now()+std::time::Duration::from_secs(10);
            while sup.is_live(&id) && sup.native_control(&id,NativeControl::Activity).await?["status"] != "Idle" {
                if tokio::time::Instant::now() >= deadline { return Err(AppError::new("send_not_dispatched","The active response has not acknowledged interruption; steering was not delivered")); }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            crate::conversation_data::send_locked_with_execution(state.inner(),session_id.clone(),item.text.clone(),item.attachment_ids.clone(),item.execution.clone()).await.map(|t|t.turn_id)
        }
    }).await { Ok(result) => result, Err(_) => Err(AppError::new("send_unconfirmed","Steering was not acknowledged within 20 seconds. Inspect active work before resolving this receipt.")) };
    change(&session_id, |s| {
        let q = s.queue.iter_mut().find(|q| q.id == request_id).unwrap();
        match &result {
            Ok(turn) => {
                q.status = "sent".into();
                q.turn_id = Some(turn.clone());
                q.error = None;
            }
            Err(e) => {
                q.status = if matches!(
                    e.code.as_str(),
                    "send_not_dispatched" | "invalid_argument" | "not_live"
                ) {
                    "failed"
                } else {
                    "unknown"
                }
                .into();
                q.error = Some(e.message.clone());
                s.paused = true;
            }
        }
        Ok(())
    })?;
    read(&session_id)
}

#[tauri::command]
pub(crate) async fn remove_queued_turn(
    session_id: String,
    request_id: String,
) -> Result<ComposerState, AppError> {
    let _lock = crate::peers::LIFECYCLE.lock().await;
    change(&session_id, |s| {
        if s.queue.iter().any(|q| {
            q.id == request_id && matches!(q.status.as_str(), "sending" | "unknown" | "sent")
        }) {
            return Err(AppError::invalid_argument(
                "Sent or unconfirmed delivery receipts cannot be removed",
            ));
        }
        s.queue.retain(|q| q.id != request_id);
        Ok(())
    })
}
#[tauri::command]
pub(crate) async fn resolve_queued_turn(
    session_id: String,
    request_id: String,
    outcome: String,
) -> Result<ComposerState, AppError> {
    let _lock = crate::peers::LIFECYCLE.lock().await;
    change(&session_id, |s| {
        let q = s
            .queue
            .iter_mut()
            .find(|q| q.id == request_id && q.status == "unknown")
            .ok_or_else(|| AppError::invalid_argument("No uncertain receipt to resolve"))?;
        match outcome.as_str() {
            "delivered" => {
                q.status = "sent".into();
                q.error = None;
            }
            "not-delivered" => {
                q.status = "failed".into();
                q.error = Some(
                    "User verified that this message was not delivered. Edit to retry.".into(),
                );
            }
            _ => {
                return Err(AppError::invalid_argument(
                    "Choose delivered or not-delivered after inspecting the conversation",
                ))
            }
        };
        Ok(())
    })
}
fn continue_state(
    s: &mut ComposerState,
    execution: Option<crate::task_settings::ExecutionSelection>,
) -> Result<(), AppError> {
    if s.stopped && !s.queue.iter().any(|q| q.status != "sent") {
        let draft = s.draft.clone();
        enqueue_selected(s,uuid::Uuid::new_v4().to_string(),"Continue the task from the saved progress. Preserve completed work and follow my existing instructions.".into(),vec![],execution)?;
        s.draft = draft;
    }
    s.paused = false;
    s.stopped = false;
    s.stopping = false;
    Ok(())
}

#[tauri::command]
pub(crate) async fn resume_conversation_queue(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<ComposerState, AppError> {
    let _lock = crate::peers::LIFECYCLE.lock().await;
    validate(state.inner(), &session_id, "", &[]).await?;
    if read(&session_id)?
        .queue
        .iter()
        .any(|q| matches!(q.status.as_str(), "sending" | "unknown"))
    {
        return Err(AppError::new(
            "delivery_unconfirmed",
            "Inspect the conversation and resolve the unconfirmed receipt before resuming",
        ));
    }
    let settings = crate::task_settings::read(state.inner(), &session_id).await?;
    change(&session_id, |s| {
        continue_state(s, (settings.mode == "custom").then_some(settings.execution))
    })
}
/// Orchestrator-only recovery; the caller holds LIFECYCLE and validates ownership/settings.
/// Old direct-user drafts and queued messages remain inspectable but never replay in a worker.
pub(crate) async fn resume_subagent_locked(
    state: &AppState,
    session: &str,
    expected_revision: u64,
) -> Result<(), AppError> {
    crate::session_archive::require_active(&state.get()?.data_dir, session)?;
    let revision=read(session)?.revision;
    if revision!=expected_revision{return Err(AppError::invalid_argument("Worker state changed after approval; inspect the current Stop state"));}
    let id = SessionId::new(session);
    if !state.get()?.supervisor.is_live(&id) {
        state
            .get()?
            .supervisor
            .resume_session_with_env(&id, crate::peers::resume_env(session)?)
            .await?;
    }
    change(session, |s| {
        if s.revision!=revision{return Err(AppError::invalid_argument("Worker state changed during resume; Stop remains authoritative"));}
        s.stopped = false;
        s.stopping = false;
        s.paused = true;
        Ok(())
    })?;
    Ok(())
}

/// Call only with LIFECYCLE held, so no child can be created after intent is recorded.
pub(crate) async fn stop_locked(
    state: &AppState,
    session: &str,
) -> Result<ComposerState, AppError> {
    let origins = crate::peers::snapshot()?.subagents;
    let ids = crate::cleanup::descendants([session.to_owned()].into(), &origins);
    for id in &ids {
        change(id, |s| {
            s.paused = true;
            s.stopped = true;
            s.stopping = true;
            Ok(())
        })?;
        crate::peers::cancel_pending(id)?;
    }
    let mut error = None;
    crate::peers::stop_assignments(&ids)?;
    for id in &ids {
        let id = SessionId::new(id);
        if state.get()?.supervisor.is_live(&id) {
            if let Err(e) = state.get()?.supervisor.kill(&id).await {
                error = Some(AppError::from(e));
            }
        }
    }
    if let Some(e) = error {
        return Err(e);
    }
    for id in &ids {
        change(id, |s| {
            s.stopping = false;
            Ok(())
        })?;
    }
    read(session)
}
#[tauri::command]
pub(crate) async fn stop_conversation_task(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<ComposerState, AppError> {
    // Intent must not wait behind a send acknowledgement. Cancel known groups immediately;
    // after dispatch settles, rescan ownership to include a child that was being created.
    let ids = crate::cleanup::descendants(
        [session_id.clone()].into(),
        &crate::peers::snapshot()?.subagents,
    );
    for id in &ids {
        change(id, |s| {
            s.paused = true;
            s.stopped = true;
            s.stopping = true;
            Ok(())
        })?;
        crate::peers::cancel_pending(id)?;
    }
    crate::peers::stop_assignments(&ids)?;
    for id in &ids {
        let id = SessionId::new(id);
        if state.get()?.supervisor.is_live(&id) {
            let _ = state.get()?.supervisor.kill(&id).await;
        }
    }
    let _lock = crate::peers::LIFECYCLE.lock().await;
    stop_locked(state.inner(), &session_id).await
}
async fn drain_one(app: &tauri::AppHandle, id: &str) -> Result<(), AppError> {
    let _lock = crate::peers::LIFECYCLE.lock().await;
    let current = read(id)?;
    if current.paused
        || current.stopped
        || current
            .queue
            .iter()
            .any(|q| matches!(q.status.as_str(), "sending" | "unknown" | "failed"))
    {
        return Ok(());
    }
    if crate::peers::require_conversation(id).is_err() {
        return Ok(());
    }
    let Some(item) = current.queue.iter().find(|q| q.status == "queued").cloned() else {
        return Ok(());
    };
    let state = app.state::<AppState>();
    let sup = &state.get()?.supervisor;
    let session = SessionId::new(id);
    let execution = match item.execution.clone() {
        Some(selection) => Ok(selection),
        None if item.execution_mode.as_deref() == Some("auto") => {
            crate::task_settings::resolve_auto(state.inner(), None)
        }
        // Legacy queued messages predate mode snapshots; retain their task selection.
        None => crate::task_settings::read(state.inner(), id)
            .await
            .map(|s| s.execution),
    };
    let waiting = match &execution {
        Ok(selection) => brigadier_core::allowance::blocked_provider(&selection.provider),
        Err(_) => sup
            .registered_drivers()
            .iter()
            .find_map(|d| brigadier_core::allowance::blocked_provider(d.kind().as_str())),
    };
    if waiting != current.waiting {
        change(id, |s| {
            s.waiting = waiting.clone();
            Ok(())
        })?;
    }
    if waiting.is_some() {
        return Ok(());
    }
    if sup.is_live(&session) {
        let activity = sup
            .native_control(&session, NativeControl::Activity)
            .await?;
        if activity["status"] != "Idle" {
            return Ok(());
        }
    }
    // Persist the attempt before any provider write. A lost acknowledgement never becomes a retry.
    change(id, |s| {
        s.queue.iter_mut().find(|q| q.id == item.id).unwrap().status = "sending".into();
        Ok(())
    })?;
    let result = if let Err(error) = &execution {
        Err(error.clone())
    } else if let Err(error) = validate_dispatched_command(
        state.inner(),
        id,
        &item.text,
        &item.attachment_ids,
        execution.as_ref().ok().map(|s| s.provider.as_str()),
    )
    .await
    {
        Err(error)
    } else {
        match tokio::time::timeout(std::time::Duration::from_secs(20),crate::conversation_data::send_locked_with_execution(state.inner(),id.to_owned(),item.text.clone(),item.attachment_ids.clone(),Some(execution.unwrap()))).await {
        Ok(result)=>result, Err(_)=>Err(AppError::new("send_unconfirmed","Provider did not acknowledge delivery within 20 seconds. Inspect the conversation before resolving this request."))
    }
    };
    change(id, |s| {
        let q = s.queue.iter_mut().find(|q| q.id == item.id).unwrap();
        match &result {
            Ok(turn) => {
                q.status = "sent".into();
                q.turn_id = Some(turn.turn_id.clone());
            }
            Err(e) => {
                q.status = if matches!(
                    e.code.as_str(),
                    "send_not_dispatched"
                        | "invalid_argument"
                        | "task_stopped"
                        | "not_live"
                        | "session_busy"
                        | "usage_waiting"
                ) {
                    "failed"
                } else {
                    "unknown"
                }
                .into();
                q.error = Some(e.message.clone());
                s.paused = true;
            }
        }
        Ok(())
    })?;
    Ok(())
}
async fn command_catalog(state: &AppState, session_id: &str) -> Result<Vec<Value>, AppError> {
    let provider = if session_id.starts_with("project:") {
        None
    } else {
        Some(
            crate::task_settings::read(state, session_id)
                .await?
                .execution
                .provider,
        )
    };
    command_catalog_for_provider(state, session_id, provider.as_deref()).await
}
async fn command_catalog_for_provider(
    state: &AppState,
    session_id: &str,
    selection: Option<&str>,
) -> Result<Vec<Value>, AppError> {
    if session_id.starts_with("project:") {
        return Ok(vec![]);
    }
    let row = state
        .get()?
        .supervisor
        .session(&SessionId::new(session_id))
        .await?
        .ok_or_else(|| AppError::invalid_argument("Session does not exist"))?;
    let provider = selection.or_else(|| {
        row.instance_id
            .as_ref()
            .map(|i| i.as_str().split(':').next().unwrap_or(""))
    });
    let mut rows = vec![
        json!({"name":"stop","description":"Stop this task and its owned workers","arguments":false,"execution":"control"}),
        json!({"name":"context","description":"Read durable task state","arguments":false,"execution":"control"}),
    ];
    if provider == Some("claude-code") {
        rows.extend(brigadier_core::claude::capabilities::commands(session_id).into_iter().filter(|c|!matches!(c.name.as_str(),"stop"|"context"|"compact")).map(|c|json!({"name":c.name,"description":c.description,"arguments":!c.argument_hint.is_empty(),"argumentHint":c.argument_hint,"execution":"prompt"})));
    }
    Ok(rows)
}
fn validate_advertised_prompt(
    catalog: &[Value],
    text: &str,
    has_attachments: bool,
) -> Result<(), AppError> {
    let text = text.trim();
    let name = text
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_start_matches('/');
    let command = catalog
        .iter()
        .find(|c| c["name"] == name && c["execution"] == "prompt")
        .ok_or_else(|| {
            AppError::invalid_argument(
                "This prompt command is not advertised by the current provider session",
            )
        })?;
    if has_attachments {
        return Err(AppError::invalid_argument(
            "Send attachments with a message, not a CLI command",
        ));
    }
    if command["arguments"] != true && text != format!("/{name}") {
        return Err(AppError::invalid_argument(
            "This CLI command does not advertise argument support",
        ));
    }
    Ok(())
}
async fn validate_prompt_command(
    state: &AppState,
    session_id: &str,
    text: &str,
    attachments: &[String],
) -> Result<(), AppError> {
    if !crate::conversation_data::slash_invocation(text) {
        return Ok(());
    }
    validate_advertised_prompt(
        &command_catalog(state, session_id).await?,
        text,
        !attachments.is_empty(),
    )
}
async fn validate_dispatched_command(
    state: &AppState,
    id: &str,
    text: &str,
    attachments: &[String],
    provider: Option<&str>,
) -> Result<(), AppError> {
    if !crate::conversation_data::slash_invocation(text) {
        return Ok(());
    }
    validate_advertised_prompt(
        &command_catalog_for_provider(state, id, provider).await?,
        text,
        !attachments.is_empty(),
    )
}
#[tauri::command]
pub(crate) async fn composer_commands(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Value, AppError> {
    validate(state.inner(), &session_id, "", &[]).await?;
    Ok(Value::Array(
        command_catalog(state.inner(), &session_id).await?,
    ))
}
#[tauri::command]
pub(crate) async fn execute_composer_command(
    session_id: String,
    command: String,
    state: State<'_, AppState>,
) -> Result<Value, AppError> {
    validate(state.inner(), &session_id, "", &[]).await?;
    let catalog = command_catalog(state.inner(), &session_id).await?;
    let invocation = command.trim();
    let name = invocation.trim_start_matches('/');
    if !catalog
        .iter()
        .any(|c| c["name"] == name && c["execution"] == "control")
    {
        return Err(AppError::invalid_argument(
            "This native command is unsupported or does not accept arguments",
        ));
    }
    match name {
        "stop" => Ok(
            serde_json::to_value(stop_conversation_task(session_id, state).await?)
                .map_err(|e| AppError::io(e.to_string()))?,
        ),
        "context" => serde_json::to_value(crate::task_memory::read(state.inner(), &session_id)?)
            .map_err(|e| AppError::io(e.to_string())),
        _ => Err(AppError::invalid_argument(
            "Command is not supported by the connected adapter",
        )),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_commands_require_current_catalog_and_preserve_advertised_arguments() {
        let catalog = vec![
            json!({"name":"echo","arguments":true,"execution":"prompt"}),
            json!({"name":"status","arguments":false,"execution":"prompt"}),
            json!({"name":"compact","arguments":false,"execution":"control"}),
        ];
        assert!(
            validate_advertised_prompt(&catalog, "/echo literal **code** /path", false).is_ok()
        );
        assert!(validate_advertised_prompt(&catalog, "/status", false).is_ok());
        for command in ["/status extra", "/missing", "/compact"] {
            assert!(validate_advertised_prompt(&catalog, command, false).is_err());
        }
        assert!(validate_advertised_prompt(&catalog, "/echo hi", true).is_err());
    }
    #[test]
    fn idempotent_queue_preserves_newer_draft_and_rejects_key_reuse() {
        let mut s = ComposerState::default();
        s.draft.text = "next draft".into();
        enqueue(&mut s, "a".into(), "hello".into(), vec!["image".into()]).unwrap();
        enqueue(&mut s, "a".into(), "hello".into(), vec!["image".into()]).unwrap();
        assert_eq!(s.queue.len(), 1);
        assert_eq!(s.draft.text, "next draft");
        assert!(enqueue(&mut s, "a".into(), "changed".into(), vec![]).is_err());
    }
    #[test]
    fn explicit_continue_resumes_unfinished_work_once_without_losing_draft_or_queue() {
        let mut s = ComposerState {
            stopped: true,
            paused: true,
            draft: Draft {
                text: "unsent draft".into(),
                attachment_ids: vec!["draft-file".into()],
            },
            ..Default::default()
        };
        continue_state(&mut s, None).unwrap();
        assert_eq!(s.queue.len(), 1);
        assert_eq!(s.queue[0].status, "queued");
        assert_eq!(s.draft.text, "unsent draft");
        assert!(!s.stopped && !s.paused);
        continue_state(&mut s, None).unwrap();
        assert_eq!(s.queue.len(), 1);
        s.stopped = true;
        s.paused = true;
        continue_state(&mut s, None).unwrap();
        assert_eq!(
            s.queue.len(),
            1,
            "existing queued input is the continuation"
        );
    }

    #[test]
    fn queued_custom_selection_survives_retry_restart_and_future_setting_changes() {
        let mut state = ComposerState::default();
        let original = crate::task_settings::ExecutionSelection {
            provider: "codex".into(),
            model: Some("catalog-model".into()),
            effort: Some("high".into()),
        };
        enqueue_selected(
            &mut state,
            "custom".into(),
            "Do this".into(),
            vec!["attachment".into()],
            Some(original.clone()),
        )
        .unwrap();
        enqueue_selected(
            &mut state,
            "custom".into(),
            "Do this".into(),
            vec!["attachment".into()],
            Some(crate::task_settings::ExecutionSelection {
                provider: "claude-code".into(),
                model: None,
                effort: None,
            }),
        )
        .unwrap();
        enqueue_selected(&mut state, "auto".into(), "And this".into(), vec![], None).unwrap();
        let mut states: BTreeMap<String, ComposerState> =
            serde_json::from_slice(&serde_json::to_vec(&BTreeMap::from([("s", state)])).unwrap())
                .unwrap();
        recover(&mut states);
        assert_eq!(states["s"].queue[0].execution, Some(original));
        assert!(states["s"].queue[1].execution.is_none());
        assert!(states["s"].paused);
    }

    #[test]
    fn crash_never_replays_attempted_send_or_resumes_stopped_task() {
        let mut s = ComposerState {
            session_id: "s".into(),
            stopped: true,
            stopping: true,
            ..Default::default()
        };
        enqueue(
            &mut s,
            "a".into(),
            "hello".into(),
            vec!["attachment".into()],
        )
        .unwrap();
        s.queue[0].status = "sending".into();
        let encoded = serde_json::to_vec(&BTreeMap::from([("s".to_owned(), s)])).unwrap();
        let mut states = serde_json::from_slice(&encoded).unwrap();
        recover(&mut states);
        let s = &states["s"];
        assert!(s.stopped && s.paused && !s.stopping);
        assert_eq!(s.queue[0].status, "unknown");
        assert_eq!(s.queue[0].attachment_ids, vec!["attachment"]);
    }
    #[test]
    fn initial_validation_failure_retries_same_identity_after_restart() {
        let mut state = ComposerState::default();
        let request = json!({"prompt":"Implement this", "attachmentIds":["durable-file"]});
        assert!(begin_initial_state(&mut state, "request", request.clone())
            .unwrap()
            .is_none());
        finish_initial_receipt(
            state.creations.get_mut("request").unwrap(),
            Err(AppError::invalid_argument(
                "Workspace changed while checkpointing",
            )),
            false,
        );
        let encoded =
            serde_json::to_vec(&BTreeMap::from([("project:p".to_owned(), state)])).unwrap();
        let mut restored: BTreeMap<String, ComposerState> =
            serde_json::from_slice(&encoded).unwrap();
        recover(&mut restored);
        let state = restored.get_mut("project:p").unwrap();
        assert!(begin_initial_state(state, "request", json!({"prompt":"different"})).is_err());
        assert!(begin_initial_state(state, "request", request.clone())
            .unwrap()
            .is_none());
        finish_initial_receipt(
            state.creations.get_mut("request").unwrap(),
            Ok("created-session".into()),
            true,
        );
        assert_eq!(
            begin_initial_state(state, "request", request).unwrap(),
            Some("created-session".into())
        );
    }

    #[test]
    fn initial_failure_after_dispatch_stays_unknown_even_for_validation_error_code() {
        let mut state = ComposerState::default();
        let request = json!({"prompt":"Implement this"});
        begin_initial_state(&mut state, "request", request.clone()).unwrap();
        finish_initial_receipt(
            state.creations.get_mut("request").unwrap(),
            Err(AppError::invalid_argument("Late provider validation")),
            true,
        );
        assert_eq!(state.creations["request"].status, "unknown");
        assert_eq!(
            begin_initial_state(&mut state, "request", request)
                .unwrap_err()
                .code,
            "creation_unconfirmed"
        );
    }
}
