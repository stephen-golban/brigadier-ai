//! Launches `brigadierd` genuinely detached from the app (own session / process group, no
//! inherited stdio), so it outlives the app and keeps long sessions running.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use brigadier_sandbox::{Platform, SpawnSpec};
use tokio::sync::Mutex;

/// Don't relaunch more often than this while a fresh daemon is still starting up.
const RELAUNCH_COOLDOWN: Duration = Duration::from_secs(3);

pub struct Launcher {
    platform: Arc<dyn Platform>,
    extra_env: Vec<(String, String)>,
    last_launch: Mutex<Option<Instant>>,
}

impl Launcher {
    pub fn new(platform: Arc<dyn Platform>, extra_env: Vec<(String, String)>) -> Self {
        Self {
            platform,
            extra_env,
            last_launch: Mutex::new(None),
        }
    }

    /// The sidecar sits next to the app executable, both in dev and inside the bundle.
    fn sidecar() -> std::io::Result<PathBuf> {
        let exe = std::env::current_exe()?;
        let dir = exe
            .parent()
            .ok_or_else(|| std::io::Error::other("executable has no parent directory"))?;
        Ok(dir.join(format!("brigadierd{}", std::env::consts::EXE_SUFFIX)))
    }

    /// Starts the daemon unless one was launched moments ago. The daemon's own instance lock
    /// makes a redundant launch harmless: the second process exits immediately.
    pub async fn ensure_launched(&self) -> Result<(), String> {
        let mut last = self.last_launch.lock().await;
        if last.is_some_and(|at| at.elapsed() < RELAUNCH_COOLDOWN) {
            return Ok(());
        }
        let program = Self::sidecar().map_err(|err| format!("locating brigadierd: {err}"))?;
        let mut spec = SpawnSpec::new(program)
            .arg("--data-dir")
            .arg(self.platform.paths().data_dir.as_os_str());
        for (key, value) in &self.extra_env {
            spec = spec.env(key, value);
        }
        let platform = self.platform.clone();
        let child = tokio::task::spawn_blocking(move || platform.processes().spawn_detached(&spec))
            .await
            .map_err(|err| err.to_string())?
            .map_err(|err| format!("launching brigadierd: {err}"))?;
        *last = Some(Instant::now());
        let pid = child.pid();
        tracing::info!(pid, "launched brigadierd");

        // Reap the process when it exits so it never lingers as a zombie while the app runs.
        std::thread::Builder::new()
            .name("brigadierd-reaper".into())
            .spawn(move || match child.wait() {
                Ok(status) => tracing::info!(pid, %status, "brigadierd exited"),
                Err(err) => tracing::warn!(pid, error = %err, "waiting for brigadierd failed"),
            })
            .map_err(|err| err.to_string())?;
        Ok(())
    }
}
