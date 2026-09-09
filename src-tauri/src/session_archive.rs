//! Chat archive and complete, retryable disposal shared by manual deletion and expiry.
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
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_delete: true,
            retention_days: 7,
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
    pending_deletions: BTreeMap<String, Vec<String>>,
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
            "Unarchive this chat in Settings before continuing it",
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
    let origins = crate::peers::snapshot()?.subagents;
    let ids = chat_ids(&session_id, &origins)?;
    let mut data = read(&ready.data_dir)?;
    if data.pending_deletions.contains_key(&session_id) {
        return Err(AppError::invalid_argument("Chat deletion is in progress"));
    }
    if archived {
        ready
            .supervisor
            .stop_sessions_for_trash(&ids.iter().map(SessionId::new).collect::<Vec<_>>(), None)
            .await?;
        crate::terminal::close_sessions(&ids);
        let archived_at = data
            .entries
            .get(&session_id)
            .map_or_else(now, |entry| entry.archived_at);
        for id in ids {
            data.entries.entry(id).or_insert(Entry {
                archived_at,
                needs_review: None,
            });
        }
    } else {
        for id in ids {
            data.entries.remove(&id);
        }
    }
    save(&ready.data_dir, &data)?;
    Ok(data)
}
/// Agent lifecycle calls already hold LIFECYCLE and have stopped this execution tree.
/// Ordinary created chats and user forks are not execution children.
pub(crate) async fn archive_stopped(
    ready: &crate::state::Ready,
    target: &str,
) -> Result<(), AppError> {
    let _lock = LOCK.lock().await;
    let mut data = read(&ready.data_dir)?;
    let workers = crate::peers::snapshot()?.subagents;
    for id in crate::cleanup::descendants([target.to_owned()].into(), &workers) {
        if data.pending_deletions.contains_key(&id) {
            return Err(AppError::invalid_argument("Chat deletion is in progress"));
        }
        data.entries.entry(id).or_insert(Entry {
            archived_at: now(),
            needs_review: None,
        });
    }
    save(&ready.data_dir, &data)
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
    data.settings = settings;
    save(dir, &data)?;
    Ok(data)
}
fn chat_ids(id: &str, origins: &BTreeMap<String, String>) -> Result<Vec<String>, AppError> {
    if origins.contains_key(id) {
        return Err(AppError::invalid_argument(
            "Manage subagents through their parent chat",
        ));
    }
    Ok(crate::cleanup::descendants([id.to_owned()].into(), origins))
}

async fn purge(sup: &Supervisor, ids: &[String]) -> Result<(), AppError> {
    sup.mark_deleting(&ids.iter().map(SessionId::new).collect::<Vec<_>>());
    crate::terminal::close_sessions(ids);
    for id in ids {
        sup.discard_session(&SessionId::new(id)).await?;
    }
    crate::peers::forget_sessions(ids)?;
    Ok(())
}

// Persist the whole chat before touching its first child. A crash or partial filesystem
// failure must retain enough information to retry, even after child rows have gone.
async fn delete_chat(
    sup: &Supervisor,
    dir: &Path,
    data: &mut Data,
    id: &str,
    origins: &BTreeMap<String, String>,
) -> Result<(), AppError> {
    if !data.pending_deletions.contains_key(id) {
        let ids = chat_ids(id, origins)?;
        data.pending_deletions.insert(id.to_owned(), ids);
        save(dir, data)?;
    }
    let ids = data.pending_deletions[id].clone();
    match purge(sup, &ids).await {
        Ok(()) => {
            crate::navigation::forget_sessions(dir, &ids)?;
            for member in ids {
                retired(data, &member);
            }
            data.pending_deletions.remove(id);
            save(dir, data)?;
            Ok(())
        }
        Err(error) => {
            if let Some(entry) = data.entries.get_mut(id) {
                entry.needs_review = Some(error.message.clone());
            }
            save(dir, data)?;
            Err(error)
        }
    }
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
    state: State<'_, AppState>,
) -> Result<Data, AppError> {
    let _creation = crate::peers::CREATION.lock().await;
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    let _lock = LOCK.lock().await;
    let ready = state.get()?;
    let mut data = read(&ready.data_dir)?;
    if !data.entries.contains_key(&session_id) {
        return Err(AppError::invalid_argument(
            "Only archived chats can be deleted here",
        ));
    }
    let origins = crate::peers::snapshot()?.subagents;
    delete_chat(
        &ready.supervisor,
        &ready.data_dir,
        &mut data,
        &session_id,
        &origins,
    )
    .await?;
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
                let origins = crate::peers::snapshot()?.subagents;
                let due: std::collections::BTreeSet<_> = data
                    .entries
                    .iter()
                    .filter(|(id, entry)| {
                        !origins.contains_key(*id) && expired(entry, &data.settings, now())
                    })
                    .map(|(id, _)| id.clone())
                    .chain(data.pending_deletions.keys().cloned())
                    .collect();
                if due.is_empty() {
                    return Ok(());
                }
                for id in due {
                    if let Err(error) =
                        delete_chat(&ready.supervisor, &ready.data_dir, &mut data, &id, &origins)
                            .await
                    {
                        tracing::warn!(chat = %id, "Archive cleanup: {}", error.message);
                    }
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
        data.settings.auto_delete = false;
        data.entries.insert(
            "s".into(),
            Entry {
                archived_at: DAY,
                needs_review: Some("Uncommitted changes".into()),
            },
        );
        save(dir.path(), &data).unwrap();
        let mut loaded = read(dir.path()).unwrap();
        assert!(!loaded.settings.auto_delete);
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
    async fn disposal_removes_dirty_and_unique_worktrees_and_preserves_the_repository() {
        use brigadier_store::{SessionRow, Store};
        use brigadier_supervisor::{SupervisorConfig, VecSink};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
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
        for name in ["clean", "dirty", "unique"] {
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
            purge(&sup, &[name.to_string()]).await.unwrap();
            assert!(sup.session(&sid).await.unwrap().is_none());
            assert!(!path.exists());
            let branch = std::process::Command::new("git")
                .current_dir(&root)
                .args([
                    "show-ref",
                    "--verify",
                    &format!("refs/heads/brigadier/{name}"),
                ])
                .output()
                .unwrap();
            assert!(!branch.status.success());
        }
        assert_eq!(
            std::fs::read_to_string(root.join("file")).unwrap(),
            "original"
        );
        store.close().await.unwrap();
    }
    #[test]
    fn chat_operations_include_all_descendants_but_reject_independent_workers() {
        let origins = [
            ("child".into(), "root".into()),
            ("grandchild".into(), "child".into()),
        ]
        .into();
        assert_eq!(
            chat_ids("root", &origins).unwrap(),
            ["grandchild", "child", "root"]
        );
        assert!(chat_ids("child", &origins).is_err());
    }

    #[test]
    fn old_worktree_retention_switch_cannot_disable_complete_deletion() {
        let settings: Settings = serde_json::from_str(
            r#"{"autoDelete":true,"retentionDays":7,"deleteWorktrees":false}"#,
        )
        .unwrap();
        assert!(settings.auto_delete);
        assert!(!serde_json::to_string(&settings)
            .unwrap()
            .contains("deleteWorktrees"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn chat_deletion_preserves_a_worktree_used_by_another_chat() {
        use brigadier_store::{SessionRow, Store};
        use brigadier_supervisor::{SupervisorConfig, VecSink};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("file"), "original").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "initial"]);
        let data_dir = dir.path().join("data");
        let store = Store::open(&data_dir).unwrap();
        let sup = Supervisor::new(SupervisorConfig::new(
            store.handle().clone(),
            store.run_id(),
            &data_dir,
            std::sync::Arc::new(VecSink::new()),
        ));
        let project = sup.add_project(root.clone()).await.unwrap();
        let path = root.join(".brigadier/worktrees/shared");
        git(
            &root,
            &[
                "worktree",
                "add",
                "-b",
                "brigadier/shared",
                path.to_str().unwrap(),
                "main",
            ],
        );
        std::fs::write(path.join("file"), "shared edits").unwrap();
        for name in ["parent", "child", "other"] {
            let mut row = SessionRow::new(SessionId::new(name));
            row.project_id = Some(project.id.clone());
            row.cwd = Some(path.clone());
            row.worktree_path = Some(path.clone());
            row.branch = Some("brigadier/shared".into());
            store.handle().upsert_session(row).await.unwrap();
        }
        store.handle().flush().await.unwrap();
        let mut archive = Data::default();
        for name in ["parent", "child"] {
            archive.entries.insert(
                name.into(),
                Entry {
                    archived_at: 1,
                    needs_review: None,
                },
            );
        }
        let origins = [("child".into(), "parent".into())].into();
        delete_chat(&sup, &data_dir, &mut archive, "parent", &origins)
            .await
            .unwrap();
        assert!(archive.entries.is_empty());
        assert!(archive.deleted.contains(&"child".to_string()));
        assert!(sup
            .session(&SessionId::new("parent"))
            .await
            .unwrap()
            .is_none());
        assert!(sup
            .session(&SessionId::new("child"))
            .await
            .unwrap()
            .is_none());
        assert!(sup
            .session(&SessionId::new("other"))
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            std::fs::read_to_string(path.join("file")).unwrap(),
            "shared edits"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("file")).unwrap(),
            "original"
        );
        // Once its final owner goes, the exclusive checkout is removed too.
        purge(&sup, &["other".into()]).await.unwrap();
        assert!(!path.exists());
        store.close().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn partial_deletion_persists_children_for_retry_and_never_deletes_the_repository() {
        use brigadier_store::{SessionRow, Store};
        use brigadier_supervisor::{SupervisorConfig, VecSink};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("file"), "keep").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "initial"]);
        let data_dir = dir.path().join("data");
        let store = Store::open(&data_dir).unwrap();
        let sup = Supervisor::new(SupervisorConfig::new(
            store.handle().clone(),
            store.run_id(),
            &data_dir,
            std::sync::Arc::new(VecSink::new()),
        ));
        let project = sup.add_project(root.clone()).await.unwrap();
        let mut parent = SessionRow::new(SessionId::new("parent"));
        parent.project_id = Some(project.id.clone());
        parent.cwd = Some(root.clone());
        parent.worktree_path = Some(root.clone()); // invalid ownership must fail closed
        parent.branch = Some("brigadier/parent".into());
        store.handle().upsert_session(parent.clone()).await.unwrap();
        store
            .handle()
            .upsert_session(SessionRow::new(SessionId::new("child")))
            .await
            .unwrap();
        store.handle().flush().await.unwrap();
        let mut data = Data::default();
        for name in ["parent", "child"] {
            data.entries.insert(
                name.into(),
                Entry {
                    archived_at: 1,
                    needs_review: None,
                },
            );
        }
        let origins = [("child".into(), "parent".into())].into();
        assert!(delete_chat(&sup, &data_dir, &mut data, "parent", &origins)
            .await
            .is_err());
        assert!(sup
            .session(&SessionId::new("child"))
            .await
            .unwrap()
            .is_none());
        assert_eq!(std::fs::read_to_string(root.join("file")).unwrap(), "keep");
        let mut recovered = read(&data_dir).unwrap();
        assert_eq!(recovered.pending_deletions["parent"], ["child", "parent"]);
        assert!(recovered.entries["parent"].needs_review.is_some());
        let path = root.join(".brigadier/worktrees/parent");
        git(
            &root,
            &[
                "worktree",
                "add",
                "-b",
                "brigadier/parent",
                path.to_str().unwrap(),
                "main",
            ],
        );
        parent.cwd = Some(path.clone());
        parent.worktree_path = Some(path.clone());
        store.handle().upsert_session(parent).await.unwrap();
        store.handle().flush().await.unwrap();
        delete_chat(&sup, &data_dir, &mut recovered, "parent", &origins)
            .await
            .unwrap();
        assert!(recovered.pending_deletions.is_empty());
        assert!(recovered.entries.is_empty());
        assert_eq!(recovered.deleted, ["child", "parent"]);
        assert!(!path.exists());
        assert!(root.join("file").exists());
        store.close().await.unwrap();
    }
}
