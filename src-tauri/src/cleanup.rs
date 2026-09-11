//! Durable, explicitly requested session disposal. UI acknowledgement does not wait on Git.
use crate::{error::AppError, state::AppState};
use brigadier_core::event::SessionId;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::Path};
use tauri::{Emitter, Manager, State};
static QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Every persisted queue transition, carrying the same snapshot `session_cleanup_status` returns
/// so a listener needs no second fetch. Named like `archive-changed` and `peer-state-changed`.
pub(crate) const CHANGED_EVENT: &str = "cleanup-changed";
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
/// The seam that makes "persist, then announce" testable without an `AppHandle`: the real
/// implementation is the one below, and the tests substitute a recorder.
pub(crate) trait Notify {
    fn cleanup_changed(&self, jobs: &[Job]);
}

impl Notify for tauri::AppHandle {
    fn cleanup_changed(&self, jobs: &[Job]) {
        let _ = self.emit(CHANGED_EVENT, jobs);
    }
}

/// The only way the queue file is written. The event follows a durable write and never precedes
/// one, so a listener that trusts the payload can never be ahead of what a restart would find.
fn persist(notify: &impl Notify, dir: &Path, jobs: &[Job]) -> Result<(), AppError> {
    save(dir, jobs)?;
    notify.cleanup_changed(jobs);
    Ok(())
}

/// The worker's queue transition, split out from the `AppHandle` half so the order of the two
/// outcomes is a unit test rather than an integration one. Success removes the job; failure parks
/// it with the error, where it stays until `session_cleanup_retry` clears it.
fn settle(mut jobs: Vec<Job>, id: &str, result: Result<(), String>) -> Vec<Job> {
    match result {
        Ok(()) => jobs.retain(|j| j.id != id),
        Err(message) => {
            if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
                j.error = Some(message);
            }
        }
    }
    jobs
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
    let origins = crate::peers::snapshot().unwrap_or_default().subagents;
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
    persist(&app, &ready.data_dir, &jobs)?;
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
    persist(&app, &state.get()?.data_dir, &jobs)?;
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
    persist(&app, &ready.data_dir, &jobs)?;
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
            let Ok(jobs) = read(&ready.data_dir) else {
                return;
            };
            let jobs = settle(jobs, &job.id, result.map_err(|e| e.message));
            // Announces the removal, the parked error, and — when this was the last runnable job —
            // the drained queue, all as the one snapshot the frontend renders.
            if let Err(e) = persist(&app, &ready.data_dir, &jobs) {
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
    /// A recorder that reads the queue file back at announce time. `save` is the only writer, so
    /// an announcement carrying a snapshot the file does not hold would mean the event went out
    /// first — review invariant 4.
    struct Recorder {
        dir: std::path::PathBuf,
        seen: std::cell::RefCell<Vec<(Vec<Job>, Vec<Job>)>>,
    }
    impl Notify for Recorder {
        fn cleanup_changed(&self, jobs: &[Job]) {
            let on_disk = read(&self.dir).expect("the write happened before the announcement");
            self.seen.borrow_mut().push((jobs.to_vec(), on_disk));
        }
    }
    impl Recorder {
        fn new(dir: &Path) -> Self {
            Self {
                dir: dir.to_path_buf(),
                seen: std::cell::RefCell::new(Vec::new()),
            }
        }
        /// One `(id, error)` pair per job, per announcement, in announcement order.
        fn announcements(&self) -> Vec<Vec<(String, Option<String>)>> {
            self.seen
                .borrow()
                .iter()
                .map(|(payload, on_disk)| {
                    assert_eq!(
                        serde_json::to_string(payload).unwrap(),
                        serde_json::to_string(on_disk).unwrap(),
                        "the announced snapshot is not what the queue file holds"
                    );
                    payload
                        .iter()
                        .map(|j| (j.id.clone(), j.error.clone()))
                        .collect()
                })
                .collect()
        }
    }

    fn job(id: &str, error: Option<&str>) -> Job {
        Job {
            id: id.into(),
            sessions: vec![format!("{id}-session")],
            error: error.map(str::to_string),
        }
    }

    #[test]
    fn every_transition_announces_after_the_write_and_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let recorder = Recorder::new(dir.path());
        // queued (session_discard)
        persist(&recorder, dir.path(), &[job("a", None)]).unwrap();
        // a second queued
        persist(&recorder, dir.path(), &[job("a", None), job("b", None)]).unwrap();
        // failed: the worker parks the job with its error
        let parked = settle(
            read(dir.path()).unwrap(),
            "a",
            Err("worktree locked".into()),
        );
        persist(&recorder, dir.path(), &parked).unwrap();
        // retry requested: session_cleanup_retry clears the error in place
        let mut retried = read(dir.path()).unwrap();
        retried.iter_mut().for_each(|j| j.error = None);
        persist(&recorder, dir.path(), &retried).unwrap();
        // succeeded and removed
        let rest = settle(read(dir.path()).unwrap(), "a", Ok(()));
        persist(&recorder, dir.path(), &rest).unwrap();
        // drained to empty
        let empty = settle(read(dir.path()).unwrap(), "b", Ok(()));
        persist(&recorder, dir.path(), &empty).unwrap();

        assert_eq!(
            recorder.announcements(),
            vec![
                vec![("a".into(), None)],
                vec![("a".into(), None), ("b".into(), None)],
                vec![
                    ("a".to_string(), Some("worktree locked".to_string())),
                    ("b".into(), None)
                ],
                vec![("a".into(), None), ("b".into(), None)],
                vec![("b".into(), None)],
                vec![],
            ]
        );
        assert!(read(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn a_write_that_fails_announces_nothing() {
        let dir = tempfile::tempdir().unwrap();
        // A regular file where `atomic_write` needs a folder: `create_dir_all` refuses.
        let blocked = dir.path().join("not-a-folder");
        std::fs::write(&blocked, b"").unwrap();
        let recorder = Recorder::new(dir.path());
        assert!(persist(&recorder, &blocked, &[job("a", None)]).is_err());
        assert!(recorder.seen.borrow().is_empty());
    }

    #[test]
    fn a_failed_job_is_parked_rather_than_retried_by_the_worker() {
        let jobs = vec![job("a", None), job("b", None)];
        let parked = settle(jobs, "a", Err("locked".into()));
        assert_eq!(parked[0].error.as_deref(), Some("locked"));
        assert_eq!(parked.len(), 2);
        // The worker only ever picks a job with no error, so a parked job is not re-run.
        assert!(parked
            .iter()
            .find(|j| j.error.is_none())
            .is_some_and(|j| j.id == "b"));
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
