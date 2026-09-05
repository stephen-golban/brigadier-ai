use crate::{error::AppError, state::AppState};
use brigadier_core::event::SessionId;
use tauri::State;
#[tauri::command]
pub(crate) async fn session_changes(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<brigadier_supervisor::checkpoints::SessionChanges, AppError> {
    Ok(state
        .get()?
        .supervisor
        .session_changes(&SessionId::new(session_id))
        .await?)
}
#[tauri::command]
pub(crate) async fn session_diff(
    session_id: String,
    turn: Option<String>,
    path: String,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    Ok(state
        .get()?
        .supervisor
        .session_diff(&SessionId::new(session_id), turn, path)
        .await?)
}
#[tauri::command]
pub(crate) async fn session_apply_preview(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<brigadier_store::checkpoint::WorkspaceApply, AppError> {
    Ok(state
        .get()?
        .supervisor
        .preview_apply(&SessionId::new(session_id))
        .await?)
}
#[tauri::command]
pub(crate) async fn session_apply(
    session_id: String,
    ticket: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    Ok(state
        .get()?
        .supervisor
        .apply_to_project(&SessionId::new(session_id), ticket)
        .await?)
}
#[tauri::command]
pub(crate) async fn session_apply_history(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<brigadier_store::checkpoint::WorkspaceApply>, AppError> {
    Ok(state.get()?.store().workspace_applies(session_id).await?)
}
#[tauri::command]
pub(crate) async fn session_undo_preview(
    session_id: String,
    turn: String,
    state: State<'_, AppState>,
) -> Result<brigadier_store::checkpoint::WorkspaceApply, AppError> {
    Ok(state
        .get()?
        .supervisor
        .preview_undo(&SessionId::new(session_id), turn)
        .await?)
}
