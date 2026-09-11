//! Chat archive and complete, retryable disposal shared by manual deletion and expiry.
use crate::{error::AppError, state::AppState};
use brigadier_core::event::SessionId;
use brigadier_supervisor::Supervisor;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, ops::ControlFlow, path::Path, sync::OnceLock, time::Duration};
use tauri::{Emitter, Manager, State};
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const DAY: u64 = 86_400_000;

/// Every archive mutation, as an edge the retention task parks on.
///
/// The archive is written through [`save`] and nowhere else, in this process and no other, so one
/// bump there covers archiving, unarchiving, a settings change, a deletion and the legacy
/// migration alike.
static MUTATIONS: OnceLock<tokio::sync::watch::Sender<u64>> = OnceLock::new();
fn mutations() -> &'static tokio::sync::watch::Sender<u64> {
    MUTATIONS.get_or_init(|| tokio::sync::watch::channel(0).0)
}
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
    )?;
    mutations().send_modify(|v| *v = v.wrapping_add(1));
    Ok(())
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
/// The coarsest the sweep ever is, and the cadence it keeps whenever a pass could not settle
/// everything it found. The retention window is measured in days, so a minute of slack changes
/// nothing — it is the same granularity the fixed 60 s poll had.
const MIN_REVISIT: Duration = Duration::from_secs(60);

/// How long until the earliest entry falls due, or `None` when nothing can.
///
/// Pure, and the whole of the arming decision: an unretained or empty archive earns no timer at
/// all, and a full one earns exactly one, at the moment it can first do something.
fn next_due(data: &Data, at: u64) -> Option<Duration> {
    // A deletion that failed part-way is retried on the cadence, not at an expiry it has already
    // passed.
    if !data.pending_deletions.is_empty() {
        return Some(MIN_REVISIT);
    }
    if !data.settings.auto_delete {
        return None;
    }
    let window = u64::from(data.settings.retention_days) * DAY;
    data.entries
        .values()
        .map(|entry| {
            entry
                .archived_at
                .saturating_add(window)
                .saturating_sub(at)
        })
        .min()
        .map(Duration::from_millis)
}

/// One retention pass. Returns how long the loop may sleep with no archive mutation, or `None` to
/// park until one lands.
async fn sweep_once(app: &tauri::AppHandle) -> ControlFlow<(), Option<Duration>> {
    let pass = async {
        let _creation = crate::peers::CREATION.lock().await;
        let _lifecycle = crate::peers::LIFECYCLE.lock().await;
        let _lock = LOCK.lock().await;
        let state = app.state::<AppState>();
        let ready = state.get()?;
        let mut data = read(&ready.data_dir)?;
        let origins = crate::peers::snapshot()?.subagents;
        let at = now();
        // An expired chat that is somebody's subagent is not ours to delete, and nothing it
        // depends on is written through `save`. That one case keeps the old cadence.
        let deferred = data
            .entries
            .iter()
            .any(|(id, entry)| origins.contains_key(id) && expired(entry, &data.settings, at));
        let due: std::collections::BTreeSet<_> = data
            .entries
            .iter()
            .filter(|(id, entry)| !origins.contains_key(*id) && expired(entry, &data.settings, at))
            .map(|(id, _)| id.clone())
            .chain(data.pending_deletions.keys().cloned())
            .collect();
        if !due.is_empty() {
            for id in due {
                if let Err(error) =
                    delete_chat(&ready.supervisor, &ready.data_dir, &mut data, &id, &origins).await
                {
                    tracing::warn!(chat = %id, "Archive cleanup: {}", error.message);
                }
            }
            let _ = app.emit("archive-changed", ());
        }
        let next = if deferred {
            Some(MIN_REVISIT)
        } else {
            next_due(&data, now()).map(|d| d.max(MIN_REVISIT))
        };
        Ok::<_, AppError>(next)
    }
    .await;
    match pass {
        Ok(next) => ControlFlow::Continue(next),
        Err(e) => {
            tracing::warn!("Archive cleanup: {}", e.message);
            // A read that failed is a state this task cannot compute a deadline from; retry on
            // the cadence rather than parking on an edge that may never come.
            ControlFlow::Continue(Some(MIN_REVISIT))
        }
    }
}

/// The retention loop.
///
/// It wakes on an archive mutation and otherwise only at the deadline the pass asked for. Until
/// 2026-09-11 it woke every 60 s for the app's life, taking three global mutexes and reading two
/// files each time to find nothing due
/// (`docs/research/lifecycle-bounds-audit-2026-09-11.md` §2 gap 6).
async fn retention_loop<F, Fut>(mut edges: tokio::sync::watch::Receiver<u64>, mut pass: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ControlFlow<(), Option<Duration>>>,
{
    loop {
        // Marked seen before the pass, never after: a mutation that lands mid-pass must leave the
        // receiver dirty so the next `changed()` returns at once.
        edges.borrow_and_update();
        let ControlFlow::Continue(deadline) = pass().await else {
            return;
        };
        let woken = match deadline {
            Some(after) => tokio::select! {
                changed = edges.changed() => changed.is_ok(),
                () = tokio::time::sleep(after) => true,
            },
            None => edges.changed().await.is_ok(),
        };
        if !woken {
            return;
        }
    }
}

pub(crate) fn start(app: tauri::AppHandle) {
    let edges = mutations().subscribe();
    tauri::async_runtime::spawn(retention_loop(edges, move || {
        let app = app.clone();
        async move { sweep_once(&app).await }
    }));
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    /// Gap 6: an idle app must not wake this task at all. One pass, then a park — no timer, no
    /// mutex, no file read — until something actually changes the archive.
    #[tokio::test(start_paused = true)]
    async fn an_empty_archive_parks_and_wakes_only_on_a_mutation() {
        let (edge, rx) = tokio::sync::watch::channel(0u64);
        let passes = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&passes);
        let task = tokio::spawn(retention_loop(rx, move || {
            let counted = Arc::clone(&counted);
            async move {
                counted.fetch_add(1, Ordering::Relaxed);
                ControlFlow::Continue(None)
            }
        }));

        tokio::task::yield_now().await;
        assert_eq!(passes.load(Ordering::Relaxed), 1, "one pass at startup");
        tokio::time::advance(Duration::from_secs(3600)).await;
        tokio::task::yield_now().await;
        assert_eq!(
            passes.load(Ordering::Relaxed),
            1,
            "an hour of an empty archive is zero wakeups"
        );

        edge.send_modify(|v| *v += 1);
        tokio::task::yield_now().await;
        assert_eq!(passes.load(Ordering::Relaxed), 2, "a mutation re-arms it");
        task.abort();
    }

    /// And a deadline the pass asked for is honoured to the millisecond, not rounded up to a
    /// fixed poll.
    #[tokio::test(start_paused = true)]
    async fn a_deadline_the_pass_asked_for_is_what_wakes_it() {
        let (_edge, rx) = tokio::sync::watch::channel(0u64);
        let passes = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&passes);
        let task = tokio::spawn(retention_loop(rx, move || {
            let counted = Arc::clone(&counted);
            async move {
                counted.fetch_add(1, Ordering::Relaxed);
                ControlFlow::Continue(Some(Duration::from_secs(600)))
            }
        }));

        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(599)).await;
        tokio::task::yield_now().await;
        assert_eq!(passes.load(Ordering::Relaxed), 1, "not a second early");
        tokio::time::advance(Duration::from_secs(2)).await;
        tokio::task::yield_now().await;
        assert_eq!(passes.load(Ordering::Relaxed), 2, "and not a second late");
        task.abort();
    }

    /// The arming decision itself: nothing retainable earns no timer, and an entry earns one at
    /// its own expiry rather than on a minute's poll.
    #[test]
    fn the_next_deadline_comes_from_the_archive_itself() {
        let mut data = Data::default();
        assert_eq!(next_due(&data, DAY), None, "an empty archive parks");

        data.entries.insert(
            "old".into(),
            Entry {
                archived_at: 0,
                needs_review: None,
            },
        );
        data.entries.insert(
            "new".into(),
            Entry {
                archived_at: 3 * DAY,
                needs_review: None,
            },
        );
        // Default retention is 7 days, so the earlier chat is due at day 7, the later at day 10.
        assert_eq!(
            next_due(&data, DAY),
            Some(Duration::from_millis(6 * DAY)),
            "the soonest expiry decides"
        );
        assert_eq!(
            next_due(&data, 8 * DAY),
            Some(Duration::ZERO),
            "an overdue entry is due now"
        );

        data.settings.auto_delete = false;
        assert_eq!(next_due(&data, DAY), None, "retention off parks for good");

        data.settings.auto_delete = true;
        data.pending_deletions.insert("old".into(), vec!["old".into()]);
        assert_eq!(
            next_due(&data, DAY),
            Some(MIN_REVISIT),
            "an unfinished deletion is retried on the cadence"
        );
    }

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

    /// A setup that fails on a held workspace lease leaves nothing behind to archive.
    ///
    /// The refusal happens in [`crate::composer_workspaces::prepare_checkout`], **before** any
    /// session row is created, so there is nothing for [`archive_set`] to archive: its
    /// `supervisor.session(&id).is_none()` guard would refuse the front end's own pending id with
    /// "Session no longer exists". The stuck task is therefore the front end's to discard
    /// (`src/App.tsx`, `discardStartup`), and the lease is released the moment setup returns its
    /// error — which is what makes the retry below succeed with nothing else cleaned up.
    ///
    /// The trigger is a **branch switch**, because that is the only setup shape that still takes a
    /// lease: attaching to the checkout as it stands runs no git write and no longer asks for one
    /// (`composer_workspaces::checkout`, `docs/research/workspace-avoidance-proposal-2026-09-11.md`
    /// §3 design A). The original 2026-09-11 report — "Work locally" + "Current (main)" refused
    /// because a brigadier terminal held the workspace — is that change, not this invariant.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_setup_failure_on_a_held_workspace_lease_creates_no_session_to_archive() {
        crate::test_support::isolate_workspace_locks();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("file"), "original").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "initial"]);
        git(&root, &["branch", "alternate"]);
        let state = crate::state::AppState::pending();
        assert!(
            state.initialize(Ok(crate::state::build(dir.path().join("data"))
                .await
                .unwrap()))
        );
        let ready = state.get().unwrap();
        let project = ready.supervisor.add_project(root.clone()).await.unwrap();
        let held = brigadier_core::checkpoint::WorkspaceLease::acquire(&root).unwrap();
        assert!(crate::composer_workspaces::prepare_checkout(
            &state,
            &project.id,
            None,
            Some("alternate"),
            None
        )
        .await
        .is_err());
        // Nothing to archive, nothing to stop, nothing half-held: the failure is entirely
        // before session creation.
        assert!(ready.supervisor.list_sessions().await.unwrap().is_empty());
        assert!(read(&ready.data_dir).unwrap().entries.is_empty());
        drop(held);
        // "Retry setup" with the blocker gone: the same call now succeeds.
        assert_eq!(
            crate::composer_workspaces::prepare_checkout(
                &state,
                &project.id,
                None,
                Some("alternate"),
                None
            )
            .await
            .unwrap()
            .1
            .as_deref(),
            Some("alternate")
        );
        ready.supervisor.shutdown().await;
    }
}
