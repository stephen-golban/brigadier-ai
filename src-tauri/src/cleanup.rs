//! Durable, explicitly requested session disposal. UI acknowledgement does not wait on Git.
use crate::{error::AppError, state::AppState};
use brigadier_core::event::SessionId;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::Path};
use tauri::{Manager, State};
static QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static WORKER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Job {
    pub id: String,
    pub sessions: Vec<String>,
    pub error: Option<String>,
}
fn read(dir: &Path) -> Result<Vec<Job>, AppError> {
    match std::fs::read(dir.join("session-cleanup.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| AppError::io(e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}
fn save(dir: &Path, jobs: &[Job]) -> Result<(), AppError> {
    crate::note_files::atomic_write(
        &dir.join("session-cleanup.json"),
        &serde_json::to_vec(jobs).map_err(|e| AppError::io(e.to_string()))?,
    )
}
pub(crate) fn descendants(
    mut ids: BTreeSet<String>,
    origins: &std::collections::BTreeMap<String, String>,
) -> Vec<String> {
    loop {
        let next: Vec<_> = origins
            .iter()
            .filter(|(child, parent)| ids.contains(*parent) && !ids.contains(*child))
            .map(|(child, _)| child.clone())
            .collect();
        if next.is_empty() {
            break;
        }
        ids.extend(next);
    }
    // Deepest first so a child's shared-folder references cannot outlive its owning parent.
    let mut ids: Vec<_> = ids.into_iter().collect();
    ids.sort_by_key(|id| {
        let mut seen = BTreeSet::new();
        let mut at = id;
        while let Some(parent) = origins.get(at) {
            if !seen.insert(at.clone()) {
                break;
            }
            at = parent;
        }
        std::cmp::Reverse(seen.len())
    });
    ids
}
#[tauri::command]
pub(crate) async fn session_cleanup_status(
    state: State<'_, AppState>,
) -> Result<Vec<Job>, AppError> {
    let _guard = QUEUE.lock().await;
    read(&state.get()?.data_dir)
}
#[tauri::command]
pub(crate) async fn session_discard(
    ids: Vec<String>,
    all: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Job, AppError> {
    let _creation = crate::peers::CREATION.lock().await;
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    let _queue = QUEUE.lock().await;
    let ready = state.get()?;
    let ids = if all {
        ready
            .supervisor
            .list_sessions()
            .await?
            .into_iter()
            .map(|s| s.session_id.to_string())
            .collect()
    } else {
        ids
    };
    let origins = crate::peers::snapshot().unwrap_or_default().origins;
    let sessions = descendants(ids.into_iter().collect(), &origins);
    if sessions.is_empty() {
        return Err(AppError::invalid_argument("No sessions selected"));
    }
    let mut jobs = read(&ready.data_dir)?;
    let job = Job {
        id: uuid::Uuid::new_v4().to_string(),
        sessions,
        error: None,
    };
    jobs.push(job.clone());
    save(&ready.data_dir, &jobs)?;
    ready
        .supervisor
        .mark_deleting(&job.sessions.iter().map(SessionId::new).collect::<Vec<_>>());
    launch(app);
    Ok(job)
}
#[tauri::command]
pub(crate) async fn session_cleanup_retry(
    id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let _queue = QUEUE.lock().await;
    let mut jobs = read(&state.get()?.data_dir)?;
    if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
        job.error = None;
    }
    save(&state.get()?.data_dir, &jobs)?;
    launch(app);
    Ok(())
}
pub(crate) fn start(app: tauri::AppHandle) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    let ready = state.get()?;
    let mut jobs = read(&ready.data_dir)?;
    for job in &mut jobs {
        job.error = None;
        ready
            .supervisor
            .mark_deleting(&job.sessions.iter().map(SessionId::new).collect::<Vec<_>>());
    }
    save(&ready.data_dir, &jobs)?;
    launch(app);
    Ok(())
}
fn launch(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _worker = WORKER.lock().await;
        loop {
            let state = app.state::<AppState>();
            let Ok(ready) = state.get() else {
                return;
            };
            let job = {
                let _queue = QUEUE.lock().await;
                match read(&ready.data_dir) {
                    Ok(jobs) => jobs.into_iter().find(|j| j.error.is_none()),
                    Err(e) => {
                        tracing::error!("Cleanup queue: {}", e.message);
                        return;
                    }
                }
            };
            let Some(job) = job else {
                return;
            };
            let result: Result<(), AppError> = async {
                let _creation = crate::peers::CREATION.lock().await;
                let _lifecycle = crate::peers::LIFECYCLE.lock().await;
                crate::terminal::close_sessions(&job.sessions);
                // Remove queued messages before process termination so delivery cannot resume work.
                crate::peers::forget_sessions(&job.sessions)?;
                for id in &job.sessions {
                    ready
                        .supervisor
                        .discard_session(&SessionId::new(id))
                        .await?;
                }
                Ok(())
            }
            .await;
            let _queue = QUEUE.lock().await;
            let Ok(mut jobs) = read(&ready.data_dir) else {
                return;
            };
            match result {
                Ok(()) => jobs.retain(|j| j.id != job.id),
                Err(e) => {
                    if let Some(j) = jobs.iter_mut().find(|j| j.id == job.id) {
                        j.error = Some(e.message);
                    }
                }
            }
            if let Err(e) = save(&ready.data_dir, &jobs) {
                tracing::error!("Cleanup persistence: {}", e.message);
                return;
            }
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn descendant_disposal_is_bounded_and_children_first() {
        let origins = [
            ("child".into(), "parent".into()),
            ("grandchild".into(), "child".into()),
            ("other".into(), "unrelated".into()),
        ]
        .into();
        assert_eq!(
            descendants(["parent".into()].into(), &origins),
            vec!["grandchild", "child", "parent"]
        );
    }
    #[test]
    fn failed_job_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        save(
            dir.path(),
            &[Job {
                id: "job".into(),
                sessions: vec!["s".into()],
                error: Some("locked".into()),
            }],
        )
        .unwrap();
        assert_eq!(
            read(dir.path()).unwrap()[0].error.as_deref(),
            Some("locked")
        );
    }
}
