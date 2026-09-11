//! Durable task configuration. Native executions never own these selections.
use crate::{error::AppError, state::AppState};
use brigadier_core::{
    driver::{DriverKind, PermissionMode},
    event::SessionId,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Mutex};
use tauri::{Emitter, State};

static WRITE: Mutex<()> = Mutex::new(());
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionSelection {
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Preferences {
    pub mode: String,
    pub permission: String,
    pub manual: ExecutionSelection,
    pub isolated: bool,
    pub base_branch: Option<String>,
    #[serde(default)]
    pub new_branch: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            mode: "auto".into(),
            permission: "approve".into(),
            manual: ExecutionSelection::default(),
            isolated: true,
            base_branch: None,
            new_branch: None,
            workspace_path: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderChange {
    pub id: String,
    pub previous_provider: String,
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub timestamp: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskSettings {
    pub session_id: String,
    pub project_id: String,
    pub mode: String,
    pub permission: String,
    pub execution: ExecutionSelection,
    pub isolated: bool,
    pub base_branch: Option<String>,
    #[serde(default)]
    pub new_branch: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    pub changes: Vec<ProviderChange>,
}
#[derive(Default, Serialize, Deserialize)]
struct SettingsFile {
    #[serde(default)]
    projects: BTreeMap<String, Preferences>,
    #[serde(default)]
    tasks: BTreeMap<String, TaskSettings>,
}
fn load(state: &AppState) -> Result<SettingsFile, AppError> {
    match std::fs::read(state.get()?.data_dir.join("task-settings.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| AppError::io(e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SettingsFile::default()),
        Err(e) => Err(e.into()),
    }
}
fn write(state: &AppState, settings: &SettingsFile) -> Result<(), AppError> {
    crate::note_files::atomic_write(
        &state.get()?.data_dir.join("task-settings.json"),
        &serde_json::to_vec(settings).map_err(|e| AppError::io(e.to_string()))?,
    )
}
pub(crate) fn native_permission(policy: &str) -> Result<PermissionMode, AppError> {
    match policy {
        "ask" => Ok(PermissionMode::Ask),
        "approve" => Ok(PermissionMode::Approve),
        "full" => Ok(PermissionMode::Full),
        _ => Err(AppError::invalid_argument(
            "Choose ask, approve, or full permissions",
        )),
    }
}
fn validate_mode(mode: &str) -> Result<(), AppError> {
    if matches!(mode, "auto" | "custom") {
        Ok(())
    } else {
        Err(AppError::invalid_argument("Choose Auto or Custom"))
    }
}
pub(crate) fn validate_selection(
    state: &AppState,
    selection: &ExecutionSelection,
) -> Result<(), AppError> {
    let driver = state
        .get()?
        .supervisor
        .registered_drivers()
        .into_iter()
        .find(|d| d.kind().as_str() == selection.provider)
        .ok_or_else(|| {
            AppError::invalid_argument(
                "The selected provider is unavailable. Choose a connected provider.",
            )
        })?;
    let instance = driver.instance_id();
    if selection.provider == "codex" {
        let models = brigadier_core::codex::capabilities::models(instance.as_str());
        if let Some(model) = &selection.model {
            let row = models.iter().find(|m| &m.id == model).ok_or_else(|| {
                AppError::invalid_argument(
                    "The selected model is unavailable in the current provider catalog",
                )
            })?;
            if selection
                .effort
                .as_ref()
                .is_some_and(|e| !row.efforts.contains(e))
            {
                return Err(AppError::invalid_argument(
                    "The selected model does not support this effort",
                ));
            }
        }
    } else if selection.provider == "claude-code" {
        let models = brigadier_core::claude::capabilities::models(instance.as_str());
        if let Some(model) = &selection.model {
            if !models.is_empty()
                && !models
                    .iter()
                    .any(|m| &m.id == model || &m.resolved == model)
            {
                return Err(AppError::invalid_argument(
                    "The selected model is unavailable in the current provider catalog",
                ));
            }
        }
        brigadier_core::claude::capabilities::validate_effort(
            selection.model.as_deref(),
            selection.effort.as_deref(),
        )?;
    }
    Ok(())
}
/// Automatic routing uses connected adapters and their observed model defaults. Manual picks
/// are never an output destination for this computation.
pub(crate) fn resolve_auto(
    state: &AppState,
    preferred: Option<&ExecutionSelection>,
) -> Result<ExecutionSelection, AppError> {
    let drivers = state.get()?.supervisor.registered_drivers();
    let available = |d: &&std::sync::Arc<dyn brigadier_core::driver::ProviderDriver>| {
        brigadier_core::allowance::blocked_provider(d.kind().as_str()).is_none()
    };
    let driver = preferred
        .and_then(|p| {
            drivers
                .iter()
                .filter(available)
                .find(|d| d.kind().as_str() == p.provider)
        })
        .or_else(|| drivers.iter().find(available))
        .ok_or_else(|| {
            AppError::new(
                "usage_waiting",
                "No connected provider currently has available allowance",
            )
        })?;
    let instance = driver.instance_id();
    let (model, effort) = if driver.kind().as_str() == "codex" {
        let models = brigadier_core::codex::capabilities::models(instance.as_str());
        let selected = models
            .iter()
            .find(|m| m.is_default)
            .or_else(|| models.first());
        (
            selected.map(|m| m.id.clone()),
            selected.and_then(|m| m.efforts.iter().find(|e| e.as_str() == "high").cloned()),
        )
    } else {
        (None, None)
    };
    Ok(ExecutionSelection {
        provider: driver.kind().to_string(),
        model,
        effort,
    })
}
#[tauri::command]
pub(crate) async fn project_composer_preferences(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Preferences, AppError> {
    Ok(load(state.inner())?
        .projects
        .remove(&project_id)
        .unwrap_or_default())
}
#[tauri::command]
pub(crate) async fn save_project_composer_preferences(
    project_id: String,
    preferences: Preferences,
    state: State<'_, AppState>,
) -> Result<Preferences, AppError> {
    validate_mode(&preferences.mode)?;
    native_permission(&preferences.permission)?;
    if state
        .get()?
        .supervisor
        .project(&project_id)
        .await?
        .is_none()
    {
        return Err(AppError::invalid_argument("Project no longer exists"));
    }
    // Preserve unavailable remembered choices so setup can expose and repair them explicitly.
    let _lock = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = load(state.inner())?;
    all.projects.insert(project_id, preferences.clone());
    write(state.inner(), &all)?;
    Ok(preferences)
}
pub(crate) async fn read(state: &AppState, id: &str) -> Result<TaskSettings, AppError> {
    if let Some(task) = load(state)?.tasks.remove(id) {
        return Ok(task);
    }
    let row = state
        .get()?
        .supervisor
        .session(&SessionId::new(id))
        .await?
        .ok_or_else(|| AppError::invalid_argument("Task no longer exists"))?;
    Ok(TaskSettings {
        session_id: id.into(),
        project_id: row.project_id.unwrap_or_default(),
        mode: "custom".into(),
        permission: match row.permission_mode.as_deref() {
            Some("auto" | "approve") => "approve",
            Some("bypass-permissions" | "full") => "full",
            _ => "ask",
        }
        .into(),
        execution: ExecutionSelection {
            provider: row
                .driver_kind
                .map(|k| k.to_string())
                .unwrap_or_else(|| "claude-code".into()),
            model: row.model,
            effort: row.effort,
        },
        isolated: row.worktree_path.is_some(),
        base_branch: row.branch,
        new_branch: None,
        workspace_path: None,
        changes: vec![],
    })
}
pub(crate) async fn initialize(
    state: &AppState,
    id: &str,
    mode: &str,
    permission: &str,
    base_branch: Option<String>,
    new_branch: Option<String>,
    workspace_path: Option<String>,
) -> Result<(), AppError> {
    let mut task = read(state, id).await?;
    task.mode = mode.into();
    task.permission = permission.into();
    task.base_branch = base_branch;
    task.new_branch = new_branch;
    task.workspace_path = workspace_path;
    let _lock = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = load(state)?;
    all.tasks.insert(id.into(), task);
    write(state, &all)
}
#[tauri::command]
pub(crate) async fn task_execution_settings(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<TaskSettings, AppError> {
    read(state.inner(), &session_id).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SettingsUpdate {
    pub mode: String,
    pub permission: String,
    pub execution: ExecutionSelection,
}
fn apply_update(task: &mut TaskSettings, update: SettingsUpdate) -> Result<(), AppError> {
    validate_mode(&update.mode)?;
    native_permission(&update.permission)?;
    if task.mode == "custom" && update.mode == "auto" {
        return Err(AppError::invalid_argument(
            "A started Custom task cannot return to Auto",
        ));
    }
    if update.mode == "custom" && task.execution.provider != update.execution.provider {
        task.changes.push(ProviderChange {
            id: uuid::Uuid::new_v4().to_string(),
            previous_provider: task.execution.provider.clone(),
            provider: update.execution.provider.clone(),
            model: update.execution.model.clone(),
            effort: update.execution.effort.clone(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        });
    }
    task.mode = update.mode;
    task.permission = update.permission;
    if task.mode == "custom" {
        task.execution = update.execution;
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn update_task_execution_settings(
    session_id: String,
    mut settings: SettingsUpdate,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<TaskSettings, AppError> {
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    let mut task = read(state.inner(), &session_id).await?;
    if task.mode == "auto"
        && settings.mode == "custom"
        && settings.execution.provider == task.execution.provider
    {
        if let Some(row) = state
            .get()?
            .supervisor
            .session(&SessionId::new(&session_id))
            .await?
        {
            if row
                .driver_kind
                .as_ref()
                .is_some_and(|k| k.as_str() == settings.execution.provider)
            {
                if settings.execution.model.is_none() {
                    settings.execution.model = row.model;
                }
                if settings.execution.effort.is_none() {
                    settings.execution.effort = row.effort;
                }
            }
        }
    }
    if settings.mode == "custom" {
        // Same reason as `prepare_dispatch` below: the registry `validate_selection` reads is
        // where Codex's lazily registered driver lands (`crate::state::ensure_codex`), and
        // switching a task to Codex is one of the ways a launch first names it.
        if settings.execution.provider == "codex" {
            crate::state::ensure_codex(state.get()?).await;
        }
        validate_selection(state.inner(), &settings.execution)?;
    }
    apply_update(&mut task, settings)?;
    {
        let _lock = WRITE.lock().unwrap_or_else(|e| e.into_inner());
        let mut all = load(state.inner())?;
        let prefs = all.projects.entry(task.project_id.clone()).or_default();
        prefs.mode = task.mode.clone();
        prefs.permission = task.permission.clone();
        if task.mode == "custom" {
            prefs.manual = task.execution.clone();
        }
        all.tasks.insert(session_id, task.clone());
        write(state.inner(), &all)?;
    }
    let _ = app.emit("task-execution-settings", &task);
    Ok(task)
}
/// Called with the task lifecycle lock before a subsequent owner/peer turn. A new native
/// execution receives the bounded Rust checkpoint, never the preceding native transcript.
pub(crate) async fn prepare_dispatch(
    state: &AppState,
    id: &str,
    snapshot: Option<ExecutionSelection>,
) -> Result<(), AppError> {
    crate::composer::require_running(id)?;
    let mut task = read(state, id).await?;
    let selection = match snapshot {
        Some(s) => s,
        None if task.mode == "auto" => resolve_auto(state, Some(&task.execution))?,
        None => task.execution.clone(),
    };
    // Resume and peer dispatch both land here, and either can be the first thing in a launch to
    // name Codex — whose driver is registered on demand.
    if selection.provider == "codex" {
        crate::state::ensure_codex(state.get()?).await;
    }
    validate_selection(state, &selection)?;
    state
        .get()?
        .supervisor
        .restart_execution(
            &SessionId::new(id),
            &DriverKind::new(&selection.provider),
            selection.model.clone(),
            selection.effort.clone(),
            native_permission(&task.permission)?,
            crate::peers::resume_env(id)?,
        )
        .await?;
    if task.mode == "auto" {
        if task.execution.provider != selection.provider {
            task.changes.push(ProviderChange {
                id: uuid::Uuid::new_v4().to_string(),
                previous_provider: task.execution.provider.clone(),
                provider: selection.provider.clone(),
                model: selection.model.clone(),
                effort: selection.effort.clone(),
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            });
        }
        task.execution = selection;
        {
            let _lock = WRITE.lock().unwrap_or_else(|e| e.into_inner());
            let mut all = load(state)?;
            all.tasks.insert(id.into(), task.clone());
            write(state, &all)?;
        }
        crate::composer::emit_execution_settings(&task);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn task() -> TaskSettings {
        TaskSettings {
            session_id: "s".into(),
            project_id: "p".into(),
            mode: "auto".into(),
            permission: "approve".into(),
            execution: ExecutionSelection {
                provider: "claude-code".into(),
                model: None,
                effort: None,
            },
            isolated: true,
            base_branch: Some("main".into()),
            new_branch: None,
            workspace_path: None,
            changes: vec![],
        }
    }
    #[test]
    fn takeover_is_one_way_and_locked_setup_survives_settings_changes() {
        let mut t = task();
        let execution = ExecutionSelection {
            provider: "codex".into(),
            model: Some("catalog-model".into()),
            effort: Some("high".into()),
        };
        apply_update(
            &mut t,
            SettingsUpdate {
                mode: "custom".into(),
                permission: "ask".into(),
                execution: execution.clone(),
            },
        )
        .unwrap();
        assert_eq!(t.execution, execution);
        assert_eq!(t.changes.len(), 1);
        assert_eq!(t.base_branch.as_deref(), Some("main"));
        assert!(apply_update(
            &mut t,
            SettingsUpdate {
                mode: "auto".into(),
                permission: "full".into(),
                execution
            }
        )
        .is_err());
        assert_eq!(t.mode, "custom");
        assert_eq!(t.permission, "ask");
    }
    #[tokio::test]
    async fn local_branch_selection_changes_git_and_missing_branch_preserves_checkout() {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            &["init", "-b", "main"][..],
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
            ][..],
            &["branch", "alternate"][..],
        ] {
            crate::workspace::git(dir.path(), args).await.unwrap();
        }
        crate::composer_workspaces::checkout(dir.path(), Some("alternate"), None)
            .await
            .unwrap();
        assert_eq!(
            String::from_utf8(
                crate::workspace::git(dir.path(), &["branch", "--show-current"])
                    .await
                    .unwrap()
            )
            .unwrap()
            .trim(),
            "alternate"
        );
        assert!(
            crate::composer_workspaces::checkout(dir.path(), Some("missing"), None)
                .await
                .is_err()
        );
        assert_eq!(
            String::from_utf8(
                crate::workspace::git(dir.path(), &["branch", "--show-current"])
                    .await
                    .unwrap()
            )
            .unwrap()
            .trim(),
            "alternate"
        );
    }

    #[test]
    fn preferences_round_trip_and_automatic_choices_are_separate() {
        let mut all = SettingsFile::default();
        all.projects.insert("p".into(), Preferences::default());
        let mut t = task();
        t.execution.provider = "codex".into();
        all.tasks.insert("s".into(), t);
        let restored: SettingsFile =
            serde_json::from_slice(&serde_json::to_vec(&all).unwrap()).unwrap();
        assert_eq!(restored.projects["p"].manual.provider, "");
        assert_eq!(restored.tasks["s"].execution.provider, "codex");
        assert_eq!(restored.projects["p"].permission, "approve");
    }
}
