//! The 10-agent burn, dev builds only.
//!
//! Ten real sessions cost ten API bills, are not reproducible, and their event rate is not a
//! dial. The thing under test is Channel → rAF → React → DOM, so this drives
//! [`ReplayDriver`] instead: a captured NDJSON fixture, replayed through the *real* adapter
//! translation, the *real* batcher and the *real* `tauri::ipc::Channel`.
// see docs/research/feed-rendering.md §4 "The 10-agent burn harness" and
// crates/supervisor/src/replay.rs.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use brigadier_core::driver::{DriverKind, StartSession};
use brigadier_core::event::Event;
use brigadier_supervisor::replay::{MAX_ROWS_PER_SEC, MIN_ROWS_PER_SEC, REPLAY};
use brigadier_supervisor::ReplayDriver;

use crate::error::AppError;
use crate::state::AppState;

/// Upper bound on a single burn, so a mistyped `duration_s` cannot wedge the app for an hour.
const MAX_DURATION: Duration = Duration::from_secs(300);

/// Upper bound on concurrent fake sessions.
const MAX_SESSIONS: usize = 64;

/// Register a replay driver on `fixture`, start `sessions` sessions, and return.
///
/// The kill is a spawned timer, not part of this call: `src/components/Burn.tsx` re-enables its
/// button when the invoke resolves, so holding the promise for the whole run would freeze the
/// control for the length of the burn.
pub(crate) async fn run(
    state: &AppState,
    sessions: usize,
    rows_per_sec: f64,
    duration_s: f64,
    fixture: &str,
) -> Result<(), AppError> {
    let duration = validate(sessions, rows_per_sec, duration_s)?;

    let path = fixture_path(fixture)?;
    let loaded = ReplayDriver::from_fixture(&path).await?;
    // Keep each replay workspace with its isolated app data. Captured session-started
    // events must not redirect the UI to the capture author's obsolete directory.
    let ready = state.get()?;
    let root = ready.data_dir.join("burn-fixtures").join(uuid::Uuid::new_v4().to_string());
    prepare_workspace(&root).await?;
    let script = relocate_script(loaded.script(), &root);
    let script_len = script.len();
    let driver = ReplayDriver::new(script).with_rate(rows_per_sec);
    let supervisor = ready.supervisor.clone();
    supervisor.register_driver(Arc::new(driver.clone()));
    let delivery_path = ready.data_dir.join("burn-delivery.json");
    let started_at = std::time::Instant::now();

    let project = supervisor.add_project(root.clone()).await?;

    let kind = DriverKind::new(REPLAY);
    let mut started = Vec::with_capacity(sessions);
    for _ in 0..sessions {
        match supervisor.start_session(&project.id, &kind, StartSession::new(&root)).await {
            Ok(id) => started.push(id),
            Err(e) => {
                // Kill what did start rather than leaving half a burn running.
                for id in &started {
                    let _ = supervisor.kill(id).await;
                }
                return Err(AppError::from(e));
            }
        }
    }
    tracing::info!(
        sessions = started.len(),
        rows_per_sec,
        script_len,
        fixture = %path.display(),
        seconds = duration.as_secs_f64(),
        "burn started"
    );

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(duration).await;
        for id in &started {
            if let Err(e) = supervisor.kill(id).await {
                tracing::warn!(session_id = id.as_str(), error = %e, "burn session would not die");
            }
        }
        // The driver was registered for this burn alone. Leaving it filed would accumulate one
        // dead `ReplayDriver` per burn under the same key; the next burn registers its own
        // before it starts anything, so nothing depends on this one still being there.
        supervisor.unregister_driver(&kind);
        let delivery = serde_json::json!({
            "sessionIds": started.iter().map(|id| id.as_str()).collect::<Vec<_>>(),
            "emitted": driver.emitted(), "elapsedMs": started_at.elapsed().as_millis(),
            "rowsPerSec": rows_per_sec, "durationS": duration.as_secs_f64(), "scriptLen": script_len,
        });
        if let Err(error) = std::fs::write(&delivery_path, delivery.to_string()) {
            tracing::error!(%error, "burn delivery report failed");
        }
        tracing::info!(sessions = started.len(), "burn finished");
    });
    Ok(())
}

/// A valid disposable repository avoids exercising an unrelated workspace-error path.
async fn prepare_workspace(root: &std::path::Path) -> Result<(), AppError> {
    std::fs::create_dir_all(root)?;
    for args in [
        vec!["init", "--quiet", "--initial-branch=main", "--template="],
        vec!["-c", "user.name=Performance Fixture", "-c", "user.email=perf@example.invalid",
             "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Fixture"],
    ] {
        let output = tokio::process::Command::new("git")
            .current_dir(root)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("GIT_CONFIG_GLOBAL", root.join(".no-global-git-config"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(args).output().await?;
        if !output.status.success() {
            return Err(AppError::io(String::from_utf8_lossy(&output.stderr).into_owned()));
        }
    }
    Ok(())
}

/// Rewrite only fixture workspace metadata, preserving every event and its rate.
fn relocate_script(script: &[Event], root: &std::path::Path) -> Vec<Event> {
    script.iter().cloned().map(|mut event| {
        if let Event::SessionStarted { cwd, .. } = &mut event {
            *cwd = root.to_path_buf();
        }
        event
    }).collect()
}

/// Check the three numbers a burn is asked for, and return the run length they mean.
///
/// Every one of these is typed by hand into a dev panel, so each is a panic waiting to happen:
/// `Duration::from_secs_f64` aborts the process on a value that overflows, on a negative, and on
/// a NaN. The clamp is on the `f64`, not on the resulting `Duration` — `from_secs_f64(1e30)`
/// panics long before a `.min(MAX_DURATION)` could look at it.
fn validate(sessions: usize, rows_per_sec: f64, duration_s: f64) -> Result<Duration, AppError> {
    if sessions == 0 || sessions > MAX_SESSIONS {
        return Err(AppError::invalid_argument(format!(
            "sessions must be 1..={MAX_SESSIONS}, got {sessions}"
        )));
    }
    if !duration_s.is_finite() || duration_s <= 0.0 {
        return Err(AppError::invalid_argument(format!(
            "duration_s must be positive, got {duration_s}"
        )));
    }
    if !rows_per_sec.is_finite() || !(MIN_ROWS_PER_SEC..=MAX_ROWS_PER_SEC).contains(&rows_per_sec) {
        return Err(AppError::invalid_argument(format!(
            "rows_per_sec must be {MIN_ROWS_PER_SEC}..={MAX_ROWS_PER_SEC}, got {rows_per_sec}"
        )));
    }
    Ok(Duration::from_secs_f64(duration_s.min(MAX_DURATION.as_secs_f64())))
}

/// Resolve `<repo>/crates/claude-spike/fixtures/<fixture>.ndjson`.
///
/// `CARGO_MANIFEST_DIR` is `src-tauri/`, so the repo root is its parent. This only ever runs in a
/// debug build, which is always run from the tree it was compiled in.
fn fixture_path(fixture: &str) -> Result<PathBuf, AppError> {
    if fixture.is_empty() || fixture.contains(['/', '\\']) || fixture.contains("..") {
        return Err(AppError::invalid_argument(format!(
            "fixture must be a bare stem, got {fixture:?}"
        )));
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| AppError::io("CARGO_MANIFEST_DIR has no parent"))?
        .to_path_buf();
    let path = repo.join("crates/claude-spike/fixtures").join(format!("{fixture}.ndjson"));
    if !path.is_file() {
        return Err(AppError::invalid_argument(format!("no fixture at {}", path.display())));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_fresh_fixture_is_a_repository_with_a_commit() {
        let root = tempfile::tempdir().unwrap();
        prepare_workspace(root.path()).await.unwrap();
        let output = tokio::process::Command::new("git")
            .args(["rev-parse", "--verify", "HEAD"])
            .current_dir(root.path()).output().await.unwrap();
        assert!(output.status.success());
    }

    #[test]
    fn a_replay_uses_its_fresh_workspace_without_changing_other_events() {
        let script = vec![Event::SessionStarted {
            provider_session_id: "fixture".into(), model: "fixture".into(),
            cwd: PathBuf::from("/old/disposable/path"), capabilities: vec![], resume_token: None,
        }];
        let root = tempfile::tempdir().unwrap();
        let relocated = relocate_script(&script, root.path());
        assert_eq!(relocated.len(), script.len());
        match &relocated[0] {
            Event::SessionStarted { cwd, model, .. } => {
                assert_eq!(cwd, root.path());
                assert_eq!(model, "fixture");
                assert!(cwd.is_dir());
            }
            _ => panic!("event kind changed"),
        }
    }

    #[test]
    fn a_fixture_stem_may_not_escape_the_fixtures_directory() {
        assert!(fixture_path("../../etc/passwd").is_err());
        assert!(fixture_path("a/b").is_err());
        assert!(fixture_path("").is_err());
    }

    #[test]
    fn a_huge_duration_is_capped_rather_than_overflowing_a_duration() {
        // The panic this pins: `Duration::from_secs_f64(1e30)` aborts before any `.min` runs.
        assert_eq!(validate(1, 50.0, 1e30).expect("capped"), MAX_DURATION);
        assert_eq!(validate(1, 50.0, f64::MAX).expect("capped"), MAX_DURATION);
        assert_eq!(validate(1, 50.0, 2.0).expect("in range"), Duration::from_secs(2));
    }

    #[test]
    fn the_three_burn_numbers_are_all_bounded() {
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(validate(1, 50.0, bad).is_err(), "duration_s {bad}");
        }
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY, 1e-320, 1e6] {
            assert!(validate(1, bad, 1.0).is_err(), "rows_per_sec {bad}");
        }
        assert!(validate(0, 50.0, 1.0).is_err(), "no sessions");
        assert!(validate(MAX_SESSIONS + 1, 50.0, 1.0).is_err(), "too many sessions");
        assert_eq!(
            validate(1, 50.0, 1.0).expect("valid").as_secs_f64(),
            1.0
        );
    }

    #[test]
    fn the_spike_fixtures_are_where_the_burn_expects_them() {
        let path = fixture_path("s1-handshake-and-turn").expect("fixture resolves");
        assert!(path.is_file(), "{}", path.display());
    }
}
