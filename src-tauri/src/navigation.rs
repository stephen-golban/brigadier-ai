//! App navigation metadata and reversible tombstones. Trashing never removes files or history.
use crate::{error::AppError, state::AppState};
use brigadier_core::event::SessionId;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::Mutex,
};
use tauri::State;
static FILE_LOCK: Mutex<()> = Mutex::new(());
static MUTATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    Project,
    Session,
    Note,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrashEntry {
    pub kind: Kind,
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub session_ids: Vec<String>,
    pub trashed_at: u64,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Data {
    pub project_colors: BTreeMap<String, String>,
    pub pinned_sessions: Vec<String>,
    pub trash: Vec<TrashEntry>,
}
fn load(dir: &Path) -> Result<Data, AppError> {
    match std::fs::read(dir.join("navigation.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| AppError::io(e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Data::default()),
        Err(e) => Err(e.into()),
    }
}
pub(crate) fn read(dir: &Path) -> Result<Data, AppError> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load(dir)
}
fn update(dir: &Path, f: impl FnOnce(&mut Data) -> Result<(), AppError>) -> Result<Data, AppError> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut data = load(dir)?;
    f(&mut data)?;
    crate::note_files::atomic_write(
        &dir.join("navigation.json"),
        &serde_json::to_vec(&data).map_err(|e| AppError::io(e.to_string()))?,
    )?;
    Ok(data)
}
impl Data {
    pub fn hidden(&self, kind: &Kind, id: &str) -> bool {
        self.trash.iter().any(|t| {
            (&t.kind == kind && t.id == id)
                || (*kind == Kind::Session && t.session_ids.iter().any(|s| s == id))
        })
    }
}
pub(crate) fn require_available(dir: &Path, kind: Kind, id: &str) -> Result<(), AppError> {
    if read(dir)?.hidden(&kind, id) {
        return Err(AppError::new(
            "in_trash",
            "Restore this item from Trash first",
        ));
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn navigation_load(state: State<'_, AppState>) -> Result<Data, AppError> {
    read(&state.get()?.data_dir)
}

/// Opening a folder restores its saved project, including its history. Independently
/// trashed sessions stay in Trash. Serialize with trash/purge so an add cannot be lost.
pub(crate) async fn open_project(
    path: std::path::PathBuf,
    ready: &crate::state::Ready,
) -> Result<brigadier_store::ProjectRow, AppError> {
    let _mutation = MUTATION.lock().await;
    let row = ready.supervisor.add_project(path).await?;
    if read(&ready.data_dir)?.hidden(&Kind::Project, &row.id) {
        update(&ready.data_dir, |d| {
            d.trash
                .retain(|t| !(t.kind == Kind::Project && t.id == row.id));
            Ok(())
        })?;
    }
    Ok(row)
}
#[tauri::command]
pub(crate) async fn navigation_customize(
    kind: String,
    id: String,
    value: Option<String>,
    state: State<'_, AppState>,
) -> Result<Data, AppError> {
    if id.is_empty() || id.len() > 200 {
        return Err(AppError::invalid_argument("Invalid item"));
    }
    let dir = &state.get()?.data_dir;
    match kind.as_str() {
        "name" => {
            let name = value.unwrap_or_default().trim().to_owned();
            if name.is_empty() || name.chars().count() > 200 {
                return Err(AppError::invalid_argument(
                    "Use a project name of 1–200 characters",
                ));
            }
            crate::workbench_data::launch_update(dir, |d| {
                d.project_names.insert(id, name);
                Ok(())
            })?;
            read(dir)
        }
        "color" => {
            let colors = ["red", "orange", "amber", "green", "blue", "violet", "pink"];
            if value
                .as_ref()
                .is_some_and(|v| !colors.contains(&v.as_str()))
            {
                return Err(AppError::invalid_argument("Invalid project color"));
            }
            update(dir, |d| {
                if let Some(value) = value {
                    d.project_colors.insert(id, value);
                } else {
                    d.project_colors.remove(&id);
                }
                Ok(())
            })
        }
        "pin" => update(dir, |d| {
            d.pinned_sessions.retain(|s| s != &id);
            if value.is_some() {
                d.pinned_sessions.push(id);
            }
            Ok(())
        }),
        _ => Err(AppError::invalid_argument("Unknown customization")),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preview {
    pub entry: TrashEntry,
    pub running: Vec<String>,
}
async fn preview(kind: Kind, id: String, ready: &crate::state::Ready) -> Result<Preview, AppError> {
    let sessions = ready.supervisor.list_sessions().await?;
    let mut ids = BTreeSet::new();
    let (title, project_id) = match kind {
        Kind::Project => {
            let project = ready
                .supervisor
                .project(&id)
                .await?
                .ok_or_else(|| AppError::invalid_argument("Project no longer exists"))?;
            ids.extend(
                sessions
                    .iter()
                    .filter(|s| s.project_id.as_deref() == Some(&id))
                    .map(|s| s.session_id.to_string()),
            );
            let names = crate::workbench_data::read(&ready.data_dir)?.project_names;
            (
                names.get(&id).cloned().unwrap_or(project.name),
                Some(id.clone()),
            )
        }
        Kind::Session => {
            let s = sessions
                .iter()
                .find(|s| s.session_id.as_str() == id)
                .ok_or_else(|| AppError::invalid_argument("Session no longer exists"))?;
            ids.insert(id.clone());
            let titles = crate::peers::snapshot().unwrap_or_default().titles;
            (
                titles
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| format!("Session {id}")),
                s.project_id.clone(),
            )
        }
        Kind::Note => {
            let data = crate::workbench_data::read(&ready.data_dir)?;
            let n = data
                .notes
                .iter()
                .find(|n| n.id == id)
                .ok_or_else(|| AppError::invalid_argument("Note no longer exists"))?;
            (n.title.clone(), n.project_id.clone())
        }
    };
    let origins = crate::peers::snapshot().unwrap_or_default().subagents;
    loop {
        let children: Vec<_> = origins
            .iter()
            .filter(|(child, parent)| {
                ids.contains(*parent)
                    && !ids.contains(*child)
                    && sessions.iter().any(|s| s.session_id.as_str() == *child)
            })
            .map(|(child, _)| child.clone())
            .collect();
        if children.is_empty() {
            break;
        }
        ids.extend(children);
    }
    let running = ids
        .iter()
        .filter(|id| ready.supervisor.is_live(&SessionId::new(*id)))
        .cloned()
        .collect();
    Ok(Preview {
        entry: TrashEntry {
            kind,
            id,
            title,
            project_id,
            session_ids: ids.into_iter().collect(),
            trashed_at: 0,
        },
        running,
    })
}
#[tauri::command]
pub(crate) async fn trash_preview(
    kind: Kind,
    id: String,
    state: State<'_, AppState>,
) -> Result<Preview, AppError> {
    preview(kind, id, state.get()?).await
}
#[tauri::command]
pub(crate) async fn trash_move(
    kind: Kind,
    id: String,
    expected_sessions: Vec<String>,
    expected_running: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Data, AppError> {
    let _mutation = MUTATION.lock().await;
    let _creation = crate::peers::CREATION.lock().await;
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    let ready = state.get()?;
    if read(&ready.data_dir)?.hidden(&kind, &id) {
        return read(&ready.data_dir);
    }
    let mut plan = preview(kind, id, ready).await?;
    if plan.entry.session_ids.iter().collect::<BTreeSet<_>>() != expected_sessions.iter().collect()
    {
        return Err(AppError::new(
            "trash_changed",
            "Affected sessions changed. Review Move to Trash again.",
        ));
    }
    if plan.running.iter().any(|id| !expected_running.contains(id)) {
        return Err(AppError::new(
            "trash_changed",
            "A session started running. Review Move to Trash again.",
        ));
    }
    ready
        .supervisor
        .stop_sessions_for_trash(
            &plan
                .entry
                .session_ids
                .iter()
                .map(SessionId::new)
                .collect::<Vec<_>>(),
            if plan.entry.kind == Kind::Project {
                Some(plan.entry.id.as_str())
            } else {
                None
            },
        )
        .await?;
    crate::terminal::close_sessions(&plan.entry.session_ids);
    plan.entry.trashed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    update(&ready.data_dir, |d| {
        d.trash.push(plan.entry);
        Ok(())
    })
}
#[tauri::command]
pub(crate) async fn trash_restore(
    kind: Kind,
    id: String,
    state: State<'_, AppState>,
) -> Result<Data, AppError> {
    let _mutation = MUTATION.lock().await;
    update(&state.get()?.data_dir, |d| {
        if let Some(entry) = d.trash.iter().find(|t| t.kind == kind && t.id == id) {
            if kind != Kind::Project
                && entry
                    .project_id
                    .as_ref()
                    .is_some_and(|p| d.hidden(&Kind::Project, p))
            {
                return Err(AppError::invalid_argument(
                    "Restore the parent project first",
                ));
            }
        }
        d.trash.retain(|t| !(t.kind == kind && t.id == id));
        Ok(())
    })
}
#[tauri::command]
pub(crate) async fn trash_purge(
    kind: Kind,
    id: String,
    state: State<'_, AppState>,
) -> Result<Data, AppError> {
    let _mutation = MUTATION.lock().await;
    let _creation = crate::peers::CREATION.lock().await;
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    let ready = state.get()?;
    let data = read(&ready.data_dir)?;
    let entry = data
        .trash
        .iter()
        .find(|t| t.kind == kind && t.id == id)
        .ok_or_else(|| AppError::invalid_argument("Item is not in Trash"))?
        .clone();
    match kind {
        Kind::Note => {
            crate::workbench_data::remove_note(&ready.data_dir, &id)?;
        }
        Kind::Session | Kind::Project => {
            for sid in &entry.session_ids {
                if ready
                    .supervisor
                    .session(&SessionId::new(sid))
                    .await?
                    .is_some()
                {
                    ready
                        .supervisor
                        .delete_session(&SessionId::new(sid), false)
                        .await?;
                }
            }
            if kind == Kind::Project && ready.supervisor.project(&id).await?.is_some() {
                ready.supervisor.delete_project(&id, false).await?;
            }
        }
    }
    update(&ready.data_dir, |d| {
        d.trash.retain(|t| {
            !(t.kind == kind && t.id == id)
                && !(t.kind == Kind::Session && entry.session_ids.contains(&t.id))
        });
        d.pinned_sessions.retain(|s| !entry.session_ids.contains(s));
        if kind == Kind::Project {
            d.project_colors.remove(&id);
        }
        Ok(())
    })
}

/// Archived chat disposal removes navigation references without touching project entries.
pub(crate) fn forget_sessions(dir: &Path, ids: &[String]) -> Result<(), AppError> {
    update(dir, |data| {
        data.pinned_sessions.retain(|id| !ids.contains(id));
        data.trash
            .retain(|entry| entry.kind != Kind::Session || !ids.contains(&entry.id));
        for entry in &mut data.trash {
            entry.session_ids.retain(|id| !ids.contains(id));
        }
        Ok(())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn opening_a_trashed_folder_restores_its_original_project_and_preserves_history() {
        use brigadier_core::driver::{ProviderDriver, StartSession};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("keep.txt"), "saved work").unwrap();
        let ready = crate::state::build(dir.path().join("data")).await.unwrap();
        let original = open_project(root.clone(), &ready).await.unwrap();
        let driver = brigadier_supervisor::ReplayDriver::new(vec![]);
        let kind = driver.kind();
        ready
            .supervisor
            .register_driver(std::sync::Arc::new(driver));
        let session = ready
            .supervisor
            .start_session(&original.id, &kind, StartSession::new(&root))
            .await
            .unwrap();
        update(&ready.data_dir, |data| {
            data.trash.push(TrashEntry {
                kind: Kind::Project,
                id: original.id.clone(),
                title: original.name.clone(),
                project_id: Some(original.id.clone()),
                session_ids: vec![session.to_string()],
                trashed_at: 1,
            });
            data.trash.push(TrashEntry {
                kind: Kind::Session,
                id: "separately-trashed".into(),
                title: "Separate task".into(),
                project_id: Some(original.id.clone()),
                session_ids: vec!["separately-trashed".into()],
                trashed_at: 1,
            });
            data.trash.push(TrashEntry {
                kind: Kind::Project,
                id: "other-project".into(),
                title: "Other project".into(),
                project_id: Some("other-project".into()),
                session_ids: vec![],
                trashed_at: 1,
            });
            Ok(())
        })
        .unwrap();
        assert!(read(&ready.data_dir)
            .unwrap()
            .hidden(&Kind::Project, &original.id));
        for _ in 0..3 {
            let reopened = open_project(root.join("."), &ready).await.unwrap();
            assert_eq!(reopened.id, original.id);
        }
        let restored = read(&ready.data_dir).unwrap();
        assert!(!restored.hidden(&Kind::Project, &original.id));
        assert!(!restored.hidden(&Kind::Session, session.as_str()));
        assert!(restored.hidden(&Kind::Session, "separately-trashed"));
        assert!(restored.hidden(&Kind::Project, "other-project"));
        assert_eq!(ready.supervisor.list_projects().await.unwrap().len(), 1);
        assert!(ready.supervisor.session(&session).await.unwrap().is_some());
        assert_eq!(
            std::fs::read_to_string(root.join("keep.txt")).unwrap(),
            "saved work"
        );
        ready.supervisor.shutdown().await;
    }
    #[test]
    fn tombstones_persist_and_project_restore_preserves_separately_trashed_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = TrashEntry {
            kind: Kind::Project,
            id: "p".into(),
            title: "Project".into(),
            project_id: Some("p".into()),
            session_ids: vec!["s".into()],
            trashed_at: 1,
        };
        update(tmp.path(), |d| {
            d.trash.push(entry);
            Ok(())
        })
        .unwrap();
        assert!(read(tmp.path()).unwrap().hidden(&Kind::Session, "s"));
        update(tmp.path(), |d| {
            d.trash.push(TrashEntry {
                kind: Kind::Session,
                id: "s".into(),
                title: "Session".into(),
                project_id: Some("p".into()),
                session_ids: vec!["s".into()],
                trashed_at: 2,
            });
            d.trash.retain(|t| t.kind != Kind::Project);
            Ok(())
        })
        .unwrap();
        let restored = read(tmp.path()).unwrap();
        assert!(!restored.hidden(&Kind::Project, "p"));
        assert!(restored.hidden(&Kind::Session, "s"));
    }
    #[test]
    fn trashed_notes_keep_their_files_and_are_excluded_from_prompt_context_until_restored() {
        let tmp = tempfile::tempdir().unwrap();
        let note = crate::workbench_data::Note {
            id: "n".into(),
            title: "Ideas".into(),
            content: "saved content".into(),
            always_include: true,
            revision: 1,
            ..Default::default()
        };
        let mut data = crate::workbench_data::Data::default();
        crate::note_files::save(tmp.path(), &mut data, &note).unwrap();
        data.notes.push(note);
        std::fs::write(
            tmp.path().join("workbench.json"),
            serde_json::to_vec(&data).unwrap(),
        )
        .unwrap();
        let entry = TrashEntry {
            kind: Kind::Note,
            id: "n".into(),
            title: "Ideas".into(),
            project_id: None,
            session_ids: vec![],
            trashed_at: 1,
        };
        update(tmp.path(), |d| {
            d.trash.push(entry);
            Ok(())
        })
        .unwrap();
        assert!(crate::workbench_data::read(tmp.path())
            .unwrap()
            .notes
            .is_empty());
        assert!(!crate::workbench_data::contextualize(tmp.path(), "p", "hi")
            .unwrap()
            .contains("saved content"));
        assert!(require_available(tmp.path(), Kind::Note, "n").is_err());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("notes/Ideas.md")).unwrap(),
            "saved content"
        );
        update(tmp.path(), |d| {
            d.trash.clear();
            Ok(())
        })
        .unwrap();
        assert!(crate::workbench_data::contextualize(tmp.path(), "p", "hi")
            .unwrap()
            .contains("saved content"));
        crate::workbench_data::remove_note(tmp.path(), "n").unwrap();
        assert!(!tmp.path().join("notes/Ideas.md").exists());
    }
    #[test]
    fn corrupt_metadata_is_not_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("navigation.json"), "broken").unwrap();
        assert!(update(tmp.path(), |_| Ok(())).is_err());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("navigation.json")).unwrap(),
            "broken"
        );
    }
}
