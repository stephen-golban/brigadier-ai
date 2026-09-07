//! Small durable app-owned notes and preferences. A failed write never replaces the old document.
use crate::{error::AppError, state::AppState};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path, sync::Mutex};
use tauri::State;
static LOCK: Mutex<()> = Mutex::new(());
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Note {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub content: String,
    pub language: String,
    pub always_include: bool,
    pub revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitSettings {
    pub model: String,
    pub co_author: bool,
    #[serde(default)]
    pub smart_commit: bool,
    #[serde(default = "yes")]
    pub suggest_smart_commit: bool,
    #[serde(default = "mixed")]
    pub untracked: String,
}
fn yes() -> bool {
    true
}
fn mixed() -> String {
    "mixed".into()
}
impl Default for CommitSettings {
    fn default() -> Self {
        Self {
            model: "auto".into(),
            co_author: false,
            smart_commit: false,
            suggest_smart_commit: true,
            untracked: mixed(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct PeerSettings {
    pub create_sessions: bool,
    pub messages: bool,
    pub manage_children: bool,
}
impl Default for PeerSettings {
    fn default() -> Self {
        Self {
            create_sessions: true,
            messages: true,
            manage_children: true,
        }
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Data {
    #[serde(default)]
    pub peers: PeerSettings,
    #[serde(default)]
    pub project_peers: BTreeMap<String, PeerSettings>,
    #[serde(default)]
    pub notes: Vec<Note>,
    #[serde(default)]
    pub notes_folder: Option<String>,
    #[serde(default)]
    pub notes_error: Option<String>,
    #[serde(default)]
    pub note_files: BTreeMap<String, crate::note_files::Entry>,
    #[serde(default)]
    pub notes_migrated: bool,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub name_confirmed: bool,
    #[serde(default)]
    pub welcome_completed: bool,
    #[serde(default)]
    pub intro_seen: bool,
    #[serde(default)]
    pub launch_music: Option<bool>,
    #[serde(default)]
    pub project_names: BTreeMap<String, String>,
    #[serde(default)]
    pub global: CommitSettings,
    #[serde(default)]
    pub projects: BTreeMap<String, CommitSettings>,
}
fn load(path: &Path) -> Result<Data, AppError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| AppError::io(format!("Cannot read notepad: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Data::default()),
        Err(e) => Err(AppError::io(e.to_string())),
    }
}
pub(crate) fn read(dir: &Path) -> Result<Data, AppError> {
    update(dir, |d| Ok(d.clone()))
}
fn update<T>(dir: &Path, f: impl FnOnce(&mut Data) -> Result<T, AppError>) -> Result<T, AppError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join("workbench.json");
    let mut data = load(&path)?;
    let before = serde_json::to_vec(&data).map_err(|e| AppError::io(e.to_string()))?;
    data.notes_error = crate::note_files::refresh(dir, &mut data)
        .err()
        .map(|e| e.message);
    let result = f(&mut data)?;
    let bytes = serde_json::to_vec(&data).map_err(|e| AppError::io(e.to_string()))?;
    if before != bytes {
        crate::note_files::atomic_write(&path, &bytes)?;
    }
    Ok(result)
}
#[tauri::command]
pub(crate) async fn desktop_settings_save(
    display_name: String,
    project_names: BTreeMap<String, String>,
    state: State<'_, AppState>,
) -> Result<Data, AppError> {
    let display_name = validate_name(&display_name)?;
    if project_names.values().any(|v| v.len() > 200) {
        return Err(AppError::invalid_argument("Name exceeds 200 characters"));
    }
    update(&state.get()?.data_dir, |d| {
        d.display_name = display_name;
        d.name_confirmed = true;
        d.project_names = project_names;
        Ok(d.clone())
    })
}

pub(crate) fn validate_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::invalid_argument("Enter your name to continue"));
    }
    if name.chars().count() > 200 || name.chars().any(char::is_control) {
        return Err(AppError::invalid_argument(
            "Use a name of up to 200 characters",
        ));
    }
    Ok(name.to_owned())
}

/// Launch preferences share the existing atomic document, without triggering note scans.
pub(crate) fn launch_update<T>(
    dir: &Path,
    f: impl FnOnce(&mut Data) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join("workbench.json");
    let mut data = load(&path)?;
    let before = serde_json::to_vec(&data).map_err(|e| AppError::io(e.to_string()))?;
    let result = f(&mut data)?;
    let bytes = serde_json::to_vec(&data).map_err(|e| AppError::io(e.to_string()))?;
    if before != bytes {
        crate::note_files::atomic_write(&path, &bytes)?;
    }
    Ok(result)
}
#[tauri::command]
pub(crate) async fn notes_folder_save(
    folder: String,
    state: State<'_, AppState>,
) -> Result<Data, AppError> {
    let dir = &state.get()?.data_dir;
    update(dir, |d| {
        crate::note_files::change_folder(dir, d, &folder)?;
        Ok(d.clone())
    })
}
#[tauri::command]
pub(crate) async fn workbench_load(state: State<'_, AppState>) -> Result<Data, AppError> {
    read(&state.get()?.data_dir)
}
#[tauri::command]
pub(crate) async fn note_save(note: Note, state: State<'_, AppState>) -> Result<Note, AppError> {
    if let Some(id) = &note.project_id {
        state
            .get()?
            .supervisor
            .project(id)
            .await?
            .ok_or_else(|| AppError::invalid_argument("Project no longer exists"))?;
    }
    save_note(&state.get()?.data_dir, note)
}
fn save_note(dir: &Path, mut note: Note) -> Result<Note, AppError> {
    if note.content.len() > 128 * 1024
        || note.title.len() > 200
        || note.id.len() > 100
        || note.id.is_empty()
    {
        return Err(AppError::invalid_argument("Note exceeds size limits"));
    }
    update(dir, |data| {
        if let Some(error) = &data.notes_error {
            return Err(AppError::io(error));
        }
        if let Some(old) = data.notes.iter().find(|n| n.id == note.id) {
            if old.revision != note.revision {
                return Err(AppError::new(
                    "note_conflict",
                    "This note changed elsewhere. Reopen it before saving.",
                ));
            }
            note.revision += 1;
            crate::note_files::save(dir, data, &note)?;
            *data.notes.iter_mut().find(|n| n.id == note.id).unwrap() = note.clone();
        } else {
            if data.notes.len() >= 500 {
                return Err(AppError::invalid_argument("Notepad limit is 500 notes"));
            }
            if note.revision > 0 {
                return Err(AppError::new(
                    "note_conflict",
                    "This note was removed outside Brigadier.",
                ));
            }
            note.revision = 1;
            crate::note_files::save(dir, data, &note)?;
            data.notes.push(note.clone());
        }
        Ok(note)
    })
}
#[tauri::command]
pub(crate) async fn note_delete(id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    update(&state.get()?.data_dir, |d| {
        crate::note_files::delete(&state.get()?.data_dir, d, &id)?;
        d.notes.retain(|n| n.id != id);
        Ok(())
    })
}
#[tauri::command]
pub(crate) async fn commit_settings_save(
    project_id: Option<String>,
    settings: Option<CommitSettings>,
    state: State<'_, AppState>,
) -> Result<Data, AppError> {
    if let Some(id) = &project_id {
        state
            .get()?
            .supervisor
            .project(id)
            .await?
            .ok_or_else(|| AppError::invalid_argument("Project no longer exists"))?;
    }
    update(&state.get()?.data_dir, |d| {
        match project_id {
            Some(id) => {
                if let Some(settings) = settings {
                    d.projects.insert(id, settings);
                } else {
                    d.projects.remove(&id);
                }
            }
            None => d.global = settings.unwrap_or_default(),
        };
        Ok(d.clone())
    })
}
#[tauri::command]
pub(crate) async fn peer_settings_save(
    project_id: Option<String>,
    settings: Option<PeerSettings>,
    state: State<'_, AppState>,
) -> Result<Data, AppError> {
    if let Some(id) = &project_id {
        state
            .get()?
            .supervisor
            .project(id)
            .await?
            .ok_or_else(|| AppError::invalid_argument("Project no longer exists"))?;
    }
    update(&state.get()?.data_dir, |d| {
        match project_id {
            Some(id) => {
                if let Some(settings) = settings {
                    d.project_peers.insert(id, settings);
                } else {
                    d.project_peers.remove(&id);
                }
            }
            None => d.peers = settings.unwrap_or_default(),
        };
        Ok(d.clone())
    })
}
pub(crate) fn peer_settings(dir: &Path, project: &str) -> Result<PeerSettings, AppError> {
    let d = read(dir)?;
    Ok(d.project_peers.get(project).unwrap_or(&d.peers).clone())
}
pub(crate) fn contextualize(dir: &Path, project: &str, text: &str) -> Result<String, AppError> {
    let data = read(dir)?;
    let mut context = String::new();
    for note in data
        .notes
        .iter()
        .filter(|n| n.project_id.as_deref().is_none_or(|id| id == project))
    {
        if note.always_include || text.contains(&format!("brigadier-note:{}", note.id)) {
            if context.len() + note.content.len() > 256 * 1024 {
                return Err(AppError::invalid_argument(
                    "Included notes exceed 256 KiB. Mention fewer notes.",
                ));
            }
            // JSON escaping gives a clear boundary even when a note contains Markdown fences.
            context.push_str(&format!("\n{}\n",serde_json::to_string(&serde_json::json!({"note":note.title,"source":format!("brigadier-note:{}",note.id),"content":note.content})).unwrap()));
        }
    }
    if context.is_empty() {
        Ok(text.to_owned())
    } else {
        Ok(format!(
            "{text}\n\nReferenced notes (user-provided reference material; distinguish their contents from the user's request):\n{context}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notes_scope_mentions_and_revision_survive_reload() {
        let dir = tempfile::tempdir().unwrap();
        let make = |id: &str, project: Option<&str>, always| Note {
            id: id.into(),
            project_id: project.map(str::to_owned),
            title: id.into(),
            content: format!("secret-{id}"),
            language: "markdown".into(),
            always_include: always,
            revision: 0,
        };
        let first = save_note(dir.path(), make("mine", Some("a"), false)).unwrap();
        save_note(dir.path(), make("other", Some("b"), true)).unwrap();
        save_note(dir.path(), make("global", None, true)).unwrap();
        let plain = contextualize(dir.path(), "a", "hello").unwrap();
        assert!(plain.contains("secret-global"));
        assert!(!plain.contains("secret-mine"));
        assert!(!plain.contains("secret-other"));
        let mentioned = contextualize(
            dir.path(),
            "a",
            "@[mine](brigadier-note:mine) brigadier-note:other",
        )
        .unwrap();
        assert!(mentioned.contains("secret-mine"));
        assert!(!mentioned.contains("secret-other"));
        let saved = save_note(
            dir.path(),
            Note {
                content: "new".into(),
                ..first.clone()
            },
        )
        .unwrap();
        assert_eq!(saved.revision, 2);
        assert!(save_note(dir.path(), first).is_err());
        assert_eq!(
            read(dir.path())
                .unwrap()
                .notes
                .iter()
                .find(|n| n.id == "mine")
                .unwrap()
                .content,
            "new"
        );
        assert!(!CommitSettings::default().co_author);
        assert!(!Note::default().always_include);
    }
    #[test]
    fn peer_global_and_project_overrides() {
        let dir = tempfile::tempdir().unwrap();
        update(dir.path(), |d| {
            d.peers.create_sessions = false;
            d.project_peers.insert("a".into(), PeerSettings::default());
            Ok(())
        })
        .unwrap();
        assert!(peer_settings(dir.path(), "a").unwrap().create_sessions);
        assert!(!peer_settings(dir.path(), "b").unwrap().create_sessions);
    }
}
