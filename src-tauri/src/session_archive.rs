//! Durable session archive and conservative, configurable expiry.
use crate::{error::AppError, state::AppState};
use brigadier_core::event::SessionId;
use brigadier_supervisor::Supervisor;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};
use tauri::{Emitter, Manager, State};
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const DAY: u64 = 86_400_000;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Settings {
    pub auto_delete: bool,
    pub retention_days: u32,
    pub delete_worktrees: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_delete: true,
            retention_days: 7,
            delete_worktrees: true,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub archived_at: u64,
    pub needs_review: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Data {
    pub settings: Settings,
    pub entries: BTreeMap<String, Entry>,
    pub deleted: Vec<String>,
    migrated: bool,
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn read(dir: &Path) -> Result<Data, AppError> {
    match std::fs::read(dir.join("session-retention.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| AppError::io(e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Data::default()),
        Err(e) => Err(e.into()),
    }
}
fn save(dir: &Path, data: &Data) -> Result<(), AppError> {
    crate::note_files::atomic_write(
        &dir.join("session-retention.json"),
        &serde_json::to_vec(data).map_err(|e| AppError::io(e.to_string()))?,
    )
}
pub(crate) fn require_active(dir: &Path, id: &str) -> Result<(), AppError> {
    if read(dir)?.entries.contains_key(id) {
        return Err(AppError::invalid_argument(
            "Reopen this archived session from History before continuing it",
        ));
    }
    Ok(())
}
fn expired(entry: &Entry, settings: &Settings, at: u64) -> bool {
    settings.auto_delete
        && at.saturating_sub(entry.archived_at) >= u64::from(settings.retention_days) * DAY
}
#[tauri::command]
pub(crate) async fn archive_load(
    legacy: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Data, AppError> {
    let _lock = LOCK.lock().await;
    let ready = state.get()?;
    let mut data = read(&ready.data_dir)?;
    if !data.migrated {
        for id in legacy.unwrap_or_default() {
            if ready
                .supervisor
                .session(&SessionId::new(&id))
                .await?
                .is_some()
                && !ready.supervisor.is_live(&SessionId::new(&id))
            {
                data.entries.entry(id).or_insert(Entry {
                    archived_at: now(),
                    needs_review: None,
                });
            }
        }
        data.migrated = true;
        save(&ready.data_dir, &data)?;
    }
    Ok(data)
}
#[tauri::command]
pub(crate) async fn archive_set(
    session_id: String,
    archived: bool,
    state: State<'_, AppState>,
) -> Result<Data, AppError> {
    let _creation = crate::peers::CREATION.lock().await;
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    let _lock = LOCK.lock().await;
    let ready = state.get()?;
    let id = SessionId::new(&session_id);
    if ready.supervisor.session(&id).await?.is_none() {
        return Err(AppError::invalid_argument("Session no longer exists"));
    }
    let mut data = read(&ready.data_dir)?;
    if archived {
        let origins = crate::peers::snapshot().unwrap_or_default().origins;
        let mut ids = vec![session_id];
        loop {
            let children: Vec<_> = origins
                .iter()
                .filter(|(child, parent)| ids.contains(parent) && !ids.contains(child))
                .map(|(id, _)| id.clone())
                .collect();
            if children.is_empty() {
                break;
            }
            ids.extend(children);
        }
        ready
            .supervisor
            .stop_sessions_for_trash(&ids.iter().map(SessionId::new).collect::<Vec<_>>(), None)
            .await?;
        crate::terminal::close_sessions(&ids);
        for id in ids {
            data.entries.entry(id).or_insert(Entry {
                archived_at: now(),
                needs_review: None,
            });
        }
    } else {
        data.entries.remove(&session_id);
    }
    save(&ready.data_dir, &data)?;
    Ok(data)
}
#[tauri::command]
pub(crate) async fn archive_settings(
    settings: Settings,
    state: State<'_, AppState>,
) -> Result<Data, AppError> {
    if !(1..=36500).contains(&settings.retention_days) {
        return Err(AppError::invalid_argument(
            "Retention must be between 1 and 36500 days",
        ));
    }
    let _lock = LOCK.lock().await;
    let dir = &state.get()?.data_dir;
    let mut data = read(dir)?;
    if data.settings.delete_worktrees != settings.delete_worktrees {
        for entry in data.entries.values_mut() {
            entry.needs_review = None;
        }
    }
    data.settings = settings;
    save(dir, &data)?;
    Ok(data)
}
async fn purge(
    sup: &Supervisor,
    id: &str,
    delete_worktree: bool,
    force: bool,
) -> Result<(), AppError> {
    let sid = SessionId::new(id);
    let Some(record) = sup.session(&sid).await? else {
        return Ok(());
    };
    if sup.is_live(&sid) {
        return Err(AppError::invalid_argument("Session is still running"));
    }
    if delete_worktree {
        if let Some(path) = &record.worktree_path {
            if sup.list_sessions().await?.iter().any(|s| {
                s.session_id != sid
                    && (s.worktree_path.as_ref() == Some(path) || s.cwd.as_ref() == Some(path))
            }) {
                return Err(AppError::invalid_argument(
                    "Another session still uses this worktree",
                ));
            }
            let outcome = sup.cleanup_worktree(&sid, force).await?;
            if !outcome.removed {
                return Err(AppError::invalid_argument(format!(
                    "Worktree needs review: {:?} ({} changed files, {} unique commits)",
                    outcome.blocked, outcome.dirty_files, outcome.commits
                )));
            }
        }
    }
    sup.delete_session(&sid, false).await?;
    crate::peers::forget_sessions(&[id.to_owned()])?;
    Ok(())
}
fn retired(data: &mut Data, id: &str) {
    data.entries.remove(id);
    if !data.deleted.iter().any(|item| item == id) {
        data.deleted.push(id.to_owned());
    }
    if data.deleted.len() > 1000 {
        data.deleted.drain(..data.deleted.len() - 1000);
    }
}
#[tauri::command]
pub(crate) async fn archive_delete(
    session_id: String,
    delete_worktree: bool,
    force: bool,
    state: State<'_, AppState>,
) -> Result<Data, AppError> {
    let _creation = crate::peers::CREATION.lock().await;
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    let _lock = LOCK.lock().await;
    let ready = state.get()?;
    let mut data = read(&ready.data_dir)?;
    if !data.entries.contains_key(&session_id) {
        return Err(AppError::invalid_argument(
            "Only archived sessions can be deleted from History",
        ));
    }
    purge(&ready.supervisor, &session_id, delete_worktree, force).await?;
    retired(&mut data, &session_id);
    save(&ready.data_dir, &data)?;
    Ok(data)
}
pub(crate) fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let result: Result<(), AppError> = async {
                let _creation = crate::peers::CREATION.lock().await;
                let _lifecycle = crate::peers::LIFECYCLE.lock().await;
                let _lock = LOCK.lock().await;
                let state = app.state::<AppState>();
                let ready = state.get()?;
                let mut data = read(&ready.data_dir)?;
                let due: Vec<_> = data
                    .entries
                    .iter()
                    .filter(|(_, e)| e.needs_review.is_none() && expired(e, &data.settings, now()))
                    .map(|(id, _)| id.clone())
                    .collect();
                if due.is_empty() {
                    return Ok(());
                }
                for id in due {
                    match purge(
                        &ready.supervisor,
                        &id,
                        data.settings.delete_worktrees,
                        false,
                    )
                    .await
                    {
                        Ok(()) => retired(&mut data, &id),
                        Err(e) => {
                            if let Some(entry) = data.entries.get_mut(&id) {
                                entry.needs_review = Some(e.message);
                            }
                        }
                    }
                    save(&ready.data_dir, &data)?;
                }
                let _ = app.emit("archive-changed", ());
                Ok(())
            }
            .await;
            if let Err(e) = result {
                tracing::warn!("Archive cleanup: {}", e.message);
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expiry_obeys_defaults_disable_and_custom_days() {
        let entry = Entry {
            archived_at: DAY,
            needs_review: None,
        };
        let mut settings = Settings::default();
        assert!(settings.delete_worktrees);
        assert!(!expired(&entry, &settings, 8 * DAY - 1));
        assert!(expired(&entry, &settings, 8 * DAY));
        settings.auto_delete = false;
        assert!(!expired(&entry, &settings, 100 * DAY));
        settings.auto_delete = true;
        settings.retention_days = 30;
        assert!(!expired(&entry, &settings, 30 * DAY));
        assert!(expired(&entry, &settings, 31 * DAY));
    }
    #[test]
    fn retention_does_not_overwrite_the_legacy_archive_format() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = br#"{"migrated":true,"archives":["legacy"],"removedProjects":[],"jobs":[]}"#;
        std::fs::write(dir.path().join("session-archive.json"), legacy).unwrap();
        let data = read(dir.path()).unwrap();
        assert!(!data.migrated);
        assert_eq!(data.settings.retention_days, 7);
        save(dir.path(), &data).unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("session-archive.json")).unwrap(),
            legacy
        );
        assert!(dir.path().join("session-retention.json").exists());
    }
    #[test]
    fn records_settings_and_review_reasons_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let mut data = Data::default();
        data.settings.delete_worktrees = false;
        data.entries.insert(
            "s".into(),
            Entry {
                archived_at: DAY,
                needs_review: Some("Uncommitted changes".into()),
            },
        );
        save(dir.path(), &data).unwrap();
        let mut loaded = read(dir.path()).unwrap();
        assert!(!loaded.settings.delete_worktrees);
        assert_eq!(loaded.entries["s"].archived_at, DAY);
        assert!(loaded.entries["s"].needs_review.is_some());
        retired(&mut loaded, "s");
        assert!(loaded.entries.is_empty());
        assert_eq!(loaded.deleted, ["s"]);
    }
    fn git(root: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .current_dir(root)
            .args([
                "-c",
                "user.name=Archive test",
                "-c",
                "user.email=archive@example.invalid",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn expiry_preserves_dirty_and_unique_work_and_respects_keep_worktrees() {
        use brigadier_store::{SessionRow, Store};
        use brigadier_supervisor::{SupervisorConfig, VecSink};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("file"), "original").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "initial"]);
        let data = dir.path().join("data");
        std::fs::create_dir(&data).unwrap();
        let store = Store::open(&data).unwrap();
        let sup = Supervisor::new(SupervisorConfig::new(
            store.handle().clone(),
            store.run_id(),
            &data,
            std::sync::Arc::new(VecSink::new()),
        ));
        let project = sup.add_project(root.clone()).await.unwrap();
        for name in ["clean", "dirty", "unique", "keep"] {
            let path = root.join(".brigadier/worktrees").join(name);
            git(
                &root,
                &[
                    "worktree",
                    "add",
                    "-b",
                    &format!("brigadier/{name}"),
                    path.to_str().unwrap(),
                    "main",
                ],
            );
            let sid = SessionId::new(name);
            let mut row = SessionRow::new(sid.clone());
            row.project_id = Some(project.id.clone());
            row.cwd = Some(path.clone());
            row.worktree_path = Some(path.clone());
            row.branch = Some(format!("brigadier/{name}"));
            store.handle().upsert_session(row).await.unwrap();
            store.handle().flush().await.unwrap();
            if name != "clean" {
                std::fs::write(path.join("file"), "valuable changes").unwrap();
            }
            if name == "unique" {
                git(&path, &["commit", "-am", "unique work"]);
            }
            let result = purge(&sup, name, name != "keep", false).await;
            if name == "dirty" || name == "unique" {
                assert!(result.is_err(), "unsafe cleanup succeeded: {name}");
                assert!(sup.session(&sid).await.unwrap().is_some());
                assert_eq!(
                    std::fs::read_to_string(path.join("file")).unwrap(),
                    "valuable changes"
                );
            } else {
                result.unwrap();
                assert!(sup.session(&sid).await.unwrap().is_none());
                assert_eq!(path.exists(), name == "keep");
            }
        }
        assert_eq!(
            std::fs::read_to_string(root.join("file")).unwrap(),
            "original"
        );
        store.close().await.unwrap();
    }
}
