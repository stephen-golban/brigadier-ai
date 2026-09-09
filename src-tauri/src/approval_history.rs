//! Confirmed approval outcomes for inline conversation cards, independent of execution success.
use crate::{error::AppError, state::AppState};
use brigadier_core::{event::SessionId, session::Decision};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub(crate) struct ApprovalHistory {
    #[serde(flatten)]
    approval: brigadier_supervisor::wire::ApprovalView,
    decision: Option<Decision>,
}

#[tauri::command]
pub(crate) async fn composer_approval_history(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ApprovalHistory>, AppError> {
    let ready = state.get()?;
    let id = SessionId::new(&session_id);
    let row = ready
        .supervisor
        .session(&id)
        .await?
        .ok_or_else(|| AppError::invalid_argument("Session no longer exists"))?;
    crate::peer_sessions::require_target(ready, &row)?;
    let pending = ready.supervisor.pending_approvals().await?;
    Ok(ready
        .store()
        .approvals(id)
        .await?
        .iter()
        .map(|record| {
            let expired = if record.resolved_at.is_some() {
                record.decision_json.is_none()
            } else {
                pending
                    .iter()
                    .find(|p| p.request_id == record.request_id)
                    .is_none_or(|p| p.expired)
            };
            ApprovalHistory {
                approval: brigadier_supervisor::wire::ApprovalView::from_record(record, expired),
                decision: record
                    .decision_json
                    .as_deref()
                    .and_then(|json| serde_json::from_str(json).ok()),
            }
        })
        .collect())
}
