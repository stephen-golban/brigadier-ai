//! Provider-native edit/rewind and current context. See rewind-context-2026-09-05.md.
use crate::{error::AppError, state::AppState};
use brigadier_core::{event::SessionId, session::NativeControl};
use brigadier_store::chat::ChatItem;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::State;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RewindPreview {
    ticket: String,
    conversation: bool,
    reason: Option<String>,
    files: Vec<String>,
    files_available: bool,
    has_file_changes: bool,
    files_reason: Option<String>,
}
struct Plan {
    session: String,
    target: ChatItem,
    latest_uuid: String,
    through_seq: u64,
    workspace: Option<brigadier_core::checkpoint::RestorePlan>,
    created: Instant,
}
static PLANS: OnceLock<Mutex<HashMap<String, Plan>>> = OnceLock::new();
static APPLY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn items(state: &AppState, id: &str) -> Result<Vec<ChatItem>, AppError> {
    let mut all = Vec::new();
    let mut after = 0;
    loop {
        let page = state
            .get()?
            .store()
            .chat_items(id.to_owned(), after)
            .await?;
        if page.is_empty() {
            return Ok(all);
        }
        after = page.last().unwrap().seq;
        all.extend(page);
        if all.len() >= 2000 {
            return Ok(all);
        }
    }
}

#[tauri::command]
pub(crate) async fn session_context(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Value, AppError> {
    let id = SessionId::new(session_id);
    let pending = state.get()?.store().rewind_pending(id.to_string()).await?;
    if pending {
        return Ok(
            json!({"available":false,"reason":"Rewind outcome requires reconciliation","rewindPending":true}),
        );
    }
    match state
        .get()?
        .supervisor
        .native_control(&id, NativeControl::ContextSummary)
        .await
    {
        Ok(value) => {
            let used = value.get("totalTokens").and_then(Value::as_u64);
            let limit = value
                .get("maxTokens")
                .and_then(Value::as_u64)
                .filter(|n| *n > 0);
            if let (Some(used), Some(limit)) = (used, limit) {
                Ok(
                    json!({"available":true,"used":used,"limit":limit,"model":value.get("model"),"estimated":true,"sampledAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()}),
                )
            } else {
                Ok(
                    json!({"available":false,"reason":"Provider did not report a current context estimate"}),
                )
            }
        }
        Err(e) => Ok(json!({"available":false,"reason":e.to_string()})),
    }
}

/// Confirmation follows completed file editing operations in the discarded span.
/// A planned/denied/failed edit is not a change. Shell/MCP effects cannot be inferred
/// from tool names or prose, and an empty native dry run does not prove a clean span.
fn has_file_changes(history: &[ChatItem], target_seq: u64) -> bool {
    use brigadier_core::event::ItemKind;
    history.iter().filter(|i| i.seq >= target_seq).any(|call| {
        let ItemKind::ToolCall { name } = &call.kind else {
            return false;
        };
        if !matches!(
            name.as_str(),
            "Edit" | "Write" | "MultiEdit" | "NotebookEdit"
        ) {
            return false;
        }
        // Ignore an explicitly identical replacement, even if a provider accepts it.
        if let Some(input) = call
            .body
            .find('{')
            .and_then(|at| serde_json::from_str::<Value>(&call.body[at..]).ok())
        {
            if name == "Edit"
                && input.get("old_string").is_some()
                && input.get("old_string") == input.get("new_string")
            {
                return false;
            }
        }
        history.iter().any(|result| result.seq >= target_seq && matches!(
            &result.kind,
            ItemKind::ToolResult { tool_call_id, is_error: false } if tool_call_id == &call.id
        ))
    })
}

#[tauri::command]
pub(crate) async fn preview_rewind(
    session_id: String,
    item_id: String,
    state: State<'_, AppState>,
) -> Result<RewindPreview, AppError> {
    let id = SessionId::new(&session_id);
    let sup = &state.get()?.supervisor;
    let history = items(state.inner(), &session_id).await?;
    let target = history
        .iter()
        .find(|i| {
            i.id == item_id
                && matches!(i.kind, brigadier_core::event::ItemKind::UserText)
                && i.parent_id.is_none()
        })
        .cloned()
        .ok_or_else(|| AppError::invalid_argument("Message is no longer in this conversation"))?;
    if crate::peers::is_peer_input(state.inner(), &target).await? {
        return Err(AppError::invalid_argument("Peer-authored input cannot be edited or rewound as an owner message. Send a new owner message instead."));
    }
    let latest = history
        .iter()
        .rev()
        .find(|i| {
            matches!(i.kind, brigadier_core::event::ItemKind::UserText) && i.parent_id.is_none()
        })
        .and_then(|i| i.provider_uuid.clone());
    let mut preview = RewindPreview {
        ticket: uuid::Uuid::new_v4().to_string(),
        conversation: false,
        reason: None,
        files: vec![],
        files_available: false,
        has_file_changes: has_file_changes(&history, target.seq),
        files_reason: None,
    };
    if target.provider_uuid.is_none() || latest.is_none() {
        preview.reason = Some("This older message has no verified provider checkpoint ID. New messages support native editing.".into());
        return Ok(preview);
    }
    if !sup.is_live(&id) {
        preview.reason = Some("Resume this session before editing a message.".into());
        return Ok(preview);
    }
    if state
        .get()?
        .store()
        .rewind_pending(session_id.clone())
        .await?
    {
        preview.reason = Some(
            "A previous rewind has an unconfirmed outcome; history is preserved for recovery."
                .into(),
        );
        return Ok(preview);
    }
    if state.claude_status()?.version != "2.1.261" {
        preview.reason = Some("Native conversation rewind has not been verified for this installed Claude CLI version.".into());
        return Ok(preview);
    }
    preview.conversation = true;
    let turns = history
        .iter()
        .filter(|i| {
            i.seq >= target.seq
                && i.parent_id.is_none()
                && matches!(i.kind, brigadier_core::event::ItemKind::UserText)
        })
        .map(|i| i.provider_uuid.clone().unwrap_or_default())
        .collect();
    let workspace = match sup.checkpoint_preview(&id, turns).await {
        Ok(plan) => {
            preview.files = plan.changes.iter().map(|c| c.path.clone()).collect();
            preview.has_file_changes = !plan.changes.is_empty();
            if plan.conflicts.is_empty() {
                preview.files_available = true;
                Some(plan)
            } else {
                preview.files_reason = Some(format!(
                    "Conflicting manual edits: {}",
                    plan.conflicts.join(", ")
                ));
                None
            }
        }
        Err(e) => {
            preview.files_reason = Some(e.to_string());
            None
        }
    };
    let mut plans = PLANS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    plans.retain(|_, p| p.created.elapsed() < Duration::from_secs(300));
    if plans.len() >= 10 {
        plans.clear();
    }
    plans.insert(
        preview.ticket.clone(),
        Plan {
            workspace,
            session: session_id,
            target,
            latest_uuid: latest.unwrap(),
            through_seq: history.last().map_or(0, |i| i.seq),
            created: Instant::now(),
        },
    );
    Ok(preview)
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RewindScope {
    Conversation,
    ConversationAndFiles,
}

#[tauri::command]
pub(crate) async fn apply_rewind(
    ticket: String,
    scope: RewindScope,
    text: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, AppError> {
    let _guard = APPLY.lock().await;
    let plan = PLANS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&ticket)
        .ok_or_else(|| {
            AppError::invalid_argument("Press Send again to refresh the rewind preview")
        })?;
    crate::peers::require_conversation(&plan.target.session_id)?;
    if plan.created.elapsed() > Duration::from_secs(300) {
        return Err(AppError::invalid_argument(
            "Press Send again to refresh the rewind preview",
        ));
    }
    if crate::peers::is_peer_input(state.inner(), &plan.target).await? {
        return Err(AppError::invalid_argument(
            "Peer-authored input cannot be edited as an owner message",
        ));
    }
    let id = SessionId::new(&plan.session);
    let sup = &state.get()?.supervisor;
    let history = items(state.inner(), &plan.session).await?;
    let latest = history
        .iter()
        .rev()
        .find(|i| {
            matches!(i.kind, brigadier_core::event::ItemKind::UserText) && i.parent_id.is_none()
        })
        .and_then(|i| i.provider_uuid.as_deref());
    if latest != Some(&plan.latest_uuid)
        || !history.iter().any(|i| i.id == plan.target.id)
        || history.last().map_or(0, |i| i.seq) != plan.through_seq
    {
        return Err(AppError::invalid_argument(
            "Conversation changed; press Send again to review the updated span",
        ));
    }
    if matches!(scope, RewindScope::ConversationAndFiles) {
        let workspace = plan
            .workspace
            .ok_or_else(|| AppError::invalid_argument("This span has no complete restore plan"))?;
        let draft = text
            .filter(|t| !t.trim().is_empty())
            .ok_or_else(|| AppError::invalid_argument("Edited message is required"))?;
        let row = sup
            .session(&id)
            .await?
            .ok_or_else(|| AppError::invalid_argument("Session no longer exists"))?;
        let contextual = crate::workbench_data::contextualize(
            &state.get()?.data_dir,
            row.project_id.as_deref().unwrap_or(""),
            &draft,
        )?;
        let (passive, message_ids) = crate::peers::passive(id.as_str()).unwrap_or_default();
        let input = brigadier_core::session::TurnInput::text(format!("{contextual}{passive}"));
        let op = brigadier_store::checkpoint::WorkspaceRewind {
            id: ticket.clone(),
            session: plan.session,
            workspace: workspace.current.root.to_string_lossy().into_owned(),
            phase: "preview".into(),
            plan: workspace,
            draft,
            target_id: plan.target.id,
            target_uuid: plan.target.provider_uuid.unwrap(),
            latest_uuid: plan.latest_uuid,
            through_seq: None,
            paths_started: 0,
            new_turn: None,
            error: None,
        };
        let workspace_root = op.workspace.clone();
        let sup = sup.clone();
        // The durable transaction outlives webview navigation/cancellation.
        let outcome = tokio::spawn(async move { sup.checkpoint_rewind_send(op, input).await })
            .await
            .map_err(|e| AppError::new("rewind_unconfirmed", e.to_string()))?;
        let turn = match outcome {
            Ok(turn) => turn,
            Err(e) => {
                let pending = state
                    .get()?
                    .store()
                    .workspace_rewinds(workspace_root)
                    .await?
                    .iter()
                    .any(|o| {
                        o.id == ticket
                            && !matches!(
                                o.phase.as_str(),
                                "complete" | "rolled-back" | "rewound-unsent"
                            )
                    });
                return Err(AppError::new(
                    if pending {
                        "rewind_unconfirmed"
                    } else {
                        "rewind_refused"
                    },
                    e.to_string(),
                ));
            }
        };
        let _ = crate::peers::acknowledge(&message_ids);
        return Ok(
            json!({"rewound":true,"recoveryId":ticket,"filesRestored":true,"sent":true,"turnId":turn}),
        );
    }
    state
        .get()?
        .store()
        .prepare_rewind(ticket.clone(), plan.session.clone(), plan.target.id.clone())
        .await?;
    // From this point, cancellation/transport failure leaves a durable pending record. Both send
    // and resume refuse until reconciled; never repeat an operation of unknown outcome.
    let target_uuid = plan.target.provider_uuid.unwrap();
    let reply = sup.native_control(&id, NativeControl::RewindConversation { target_uuid: target_uuid.clone(), last_seen_uuid: plan.latest_uuid }).await.map_err(|e| AppError::new("rewind_unconfirmed", format!("Rewind outcome unconfirmed: {e}. Saved history is retained; sending is paused. Recovery ID: {ticket}")))?;
    if reply.get("rewound").and_then(Value::as_bool) != Some(true) {
        if reply.get("rewound").and_then(Value::as_bool) != Some(false) {
            return Err(AppError::new(
                "rewind_unconfirmed",
                "Provider did not confirm rewind. Saved history is retained; sending is paused.",
            ));
        }
        state
            .get()?
            .store()
            .finish_rewind(ticket.clone(), None)
            .await?;
        sup.native_control(&id, NativeControl::FinishRewind).await?;
        return Err(AppError::new(
            "rewind_refused",
            reply
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Provider refused rewind"),
        ));
    }
    if reply.get("targetMessageUuid").and_then(Value::as_str) != Some(target_uuid.as_str()) {
        return Err(AppError::new("rewind_unconfirmed", "Provider confirmed a different rewind target; sending is paused and saved history is retained"));
    }
    let through = reply
        .get("brigadier_seq")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            AppError::new(
                "rewind_unconfirmed",
                "Rewind succeeded but local cursor is missing; sending is paused",
            )
        })?;
    state
        .get()?
        .store()
        .finish_rewind(ticket.clone(), Some(through))
        .await?;
    sup.native_control(&id, NativeControl::FinishRewind).await?;
    Ok(json!({"rewound":true,"recoveryId":ticket,"filesRestored":false}))
}

#[tauri::command]
pub(crate) async fn session_activity(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Value, AppError> {
    let id = SessionId::new(session_id);
    state
        .get()?
        .supervisor
        .native_control(&id, NativeControl::Activity)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub(crate) async fn rewind_history(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Value, AppError> {
    let records = state
        .get()?
        .store()
        .rewind_records(session_id.clone())
        .await?;
    let row = state
        .get()?
        .supervisor
        .session(&SessionId::new(&session_id))
        .await?;
    let workspace = if let Some(root) = row.and_then(|r| r.cwd) {
        state
            .get()?
            .store()
            .workspace_rewinds(root.to_string_lossy().into_owned())
            .await?
    } else {
        vec![]
    };
    Ok(
        json!({"records":records,"workspaceOperations":workspace.iter().map(|o|json!({"id":o.id,"phase":o.phase,"draft":o.draft,"error":o.error})).collect::<Vec<_>>(),"recoveryRoot":state.get()?.data_dir.join("checkpoints")}),
    )
}
#[tauri::command]
pub(crate) async fn rewind_history_items(
    session_id: String,
    rewind_id: String,
    after: i64,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, AppError> {
    state
        .get()?
        .store()
        .rewind_items(session_id, rewind_id, after)
        .await
        .map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(id: &str, seq: u64, kind: brigadier_core::event::ItemKind) -> ChatItem {
        ChatItem {
            session_id: "s".into(),
            id: id.into(),
            seq,
            at: 0,
            kind,
            body: String::new(),
            parent_id: None,
            provider_uuid: None,
        }
    }
    #[test]
    fn confirmation_requires_successful_edits_in_the_affected_span() {
        use brigadier_core::event::ItemKind;
        let call = item(
            "edit",
            4,
            ItemKind::ToolCall {
                name: "Edit".into(),
            },
        );
        let success = item(
            "result",
            5,
            ItemKind::ToolResult {
                tool_call_id: "edit".into(),
                is_error: false,
            },
        );
        let failed = item(
            "failed",
            5,
            ItemKind::ToolResult {
                tool_call_id: "edit".into(),
                is_error: true,
            },
        );
        assert!(!has_file_changes(&[item("user", 2, ItemKind::UserText)], 2));
        assert!(!has_file_changes(std::slice::from_ref(&call), 2));
        assert!(!has_file_changes(&[call.clone(), failed], 2));
        assert!(!has_file_changes(&[call.clone(), success.clone()], 6));
        assert!(has_file_changes(&[call.clone(), success.clone()], 2));
        let mut nested = call.clone();
        nested.parent_id = Some("agent".into());
        assert!(has_file_changes(&[nested, success.clone()], 2));
        let mut noop = call;
        noop.body = r#"Edit: {"old_string":"same","new_string":"same"}"#.into();
        assert!(!has_file_changes(&[noop, success], 2));
        assert!(!has_file_changes(
            &[
                item(
                    "read",
                    4,
                    ItemKind::ToolCall {
                        name: "Read".into()
                    }
                ),
                item(
                    "read-result",
                    5,
                    ItemKind::ToolResult {
                        tool_call_id: "read".into(),
                        is_error: false
                    }
                )
            ],
            2
        ));
    }
}

#[tauri::command]
pub(crate) async fn recover_workspace_rewind(
    session_id: String,
    operation: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let root = state
        .get()?
        .supervisor
        .session(&SessionId::new(session_id))
        .await?
        .and_then(|r| r.cwd)
        .ok_or_else(|| AppError::invalid_argument("Session workspace is unavailable"))?;
    state
        .get()?
        .supervisor
        .checkpoint_recover(root, operation)
        .await
        .map_err(AppError::from)
}
