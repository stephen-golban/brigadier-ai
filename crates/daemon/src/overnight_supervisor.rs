//! Restarting the daemon during an overnight run (PLAN.md §10.10), macOS only.
//!
//! While a run is active, a per-user LaunchAgent owned by this data directory keeps a
//! **standby** daemon (`brigadierd --standby`) alive: it waits on the single-instance lock and
//! becomes the daemon as soon as the running one dies (a crash, a kill), which then resumes
//! the run. Its KeepAlive follows a marker file in the data directory that exists only while a
//! run is active, so launchd never brings Brigadier back once the run is over, nor after an
//! orderly quit (which removes the marker: a deliberate stop is not undone). The label carries
//! a hash of the data directory, and debug builds a label of their own, so a test daemon never
//! touches the installed app's agent. Nothing here needs administrator rights. Linux and
//! Windows have no supervisor: a run resumes when the app or daemon next starts.

use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::server::Daemon;

/// The marker launchd's KeepAlive follows.
pub fn marker(data_dir: &Path) -> PathBuf {
    data_dir.join("overnight-active")
}

/// An orderly quit: the run resumes when Brigadier next starts, not through launchd.
pub fn on_quit(data_dir: &Path) {
    let _ = std::fs::remove_file(marker(data_dir));
}

/// Keeps the agent and its marker in step with whether a run is active, every half minute.
pub async fn keep_in_step(
    daemon: Arc<Daemon>,
    data_dir: PathBuf,
    stop: CancellationToken,
) -> anyhow::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tokio::select! {
                () = stop.cancelled() => return Ok(()),
                _ = tick.tick() => {}
            }
            let active = daemon.sessions.overnight_active();
            let dir = data_dir.clone();
            if let Err(err) =
                tokio::task::spawn_blocking(move || mac::reconcile(&dir, active)).await?
            {
                tracing::warn!(error = %format!("{err:#}"), "could not keep the overnight supervisor in step");
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (daemon, data_dir);
        stop.cancelled().await;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use anyhow::Context as _;

    /// Written into every plist this module makes: a file without it isn't ours to touch.
    const OWNED: &str = "<!-- brigadier-overnight-supervisor -->";

    fn label(data_dir: &Path) -> String {
        // FNV-1a: stable across builds, so a newer daemon finds an older one's agent.
        let hash = data_dir
            .to_string_lossy()
            .bytes()
            .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
                (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
            });
        let build = if cfg!(debug_assertions) { "debug." } else { "" };
        format!("ai.brigadier.overnight.{build}{hash:016x}")
    }

    fn plist_path(label: &str) -> anyhow::Result<PathBuf> {
        let home = std::env::var_os("HOME").context("HOME is not set")?;
        Ok(PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{label}.plist")))
    }

    fn domain() -> String {
        use std::os::unix::fs::MetadataExt as _;
        // The user's own home directory belongs to them: its owner is this user's id.
        let uid = std::env::var_os("HOME")
            .and_then(|home| std::fs::metadata(home).ok())
            .map_or(0, |meta| meta.uid());
        format!("gui/{uid}")
    }

    fn loaded(label: &str) -> bool {
        Command::new("/bin/launchctl")
            .args(["print", &format!("{}/{label}", domain())])
            .output()
            .is_ok_and(|out| out.status.success())
    }

    /// Whether this process is the agent's own job (then unloading it would end this daemon).
    fn is_the_job(label: &str) -> bool {
        std::env::var("XPC_SERVICE_NAME").is_ok_and(|name| name == label)
    }

    fn escape(text: &str) -> String {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    fn plist(label: &str, exe: &Path, data_dir: &Path) -> String {
        let marker = super::marker(data_dir);
        let log = data_dir.join("logs").join("overnight-supervisor.log");
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
{OWNED}
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>--data-dir</string>
    <string>{data}</string>
    <string>--standby</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>PathState</key>
    <dict><key>{marker}</key><true/></dict>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
            label = escape(label),
            exe = escape(&exe.to_string_lossy()),
            data = escape(&data_dir.to_string_lossy()),
            marker = escape(&marker.to_string_lossy()),
            log = escape(&log.to_string_lossy()),
        )
    }

    pub fn reconcile(data_dir: &Path, active: bool) -> anyhow::Result<()> {
        let label = label(data_dir);
        let path = plist_path(&label)?;
        let ours =
            |path: &Path| std::fs::read_to_string(path).is_ok_and(|text| text.contains(OWNED));
        if active {
            std::fs::write(super::marker(data_dir), b"")?;
            let exe = std::env::current_exe().context("finding this daemon's program")?;
            let wanted = plist(&label, &exe, data_dir);
            if path.exists() && !ours(&path) {
                anyhow::bail!(
                    "{} exists and isn't Brigadier's; leaving it",
                    path.display()
                );
            }
            if std::fs::read_to_string(&path).ok().as_deref() != Some(wanted.as_str()) {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                // Written whole, then moved into place.
                let partial = path.with_extension("plist.partial");
                std::fs::write(&partial, wanted)?;
                std::fs::rename(&partial, &path)?;
            }
            if !loaded(&label) {
                let out = Command::new("/bin/launchctl")
                    .args(["bootstrap", &domain()])
                    .arg(&path)
                    .output()?;
                if !out.status.success() {
                    anyhow::bail!(
                        "launchctl bootstrap failed: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    );
                }
                tracing::info!(label, "overnight supervisor loaded");
            }
        } else {
            let _ = std::fs::remove_file(super::marker(data_dir));
            if !ours(&path) {
                return Ok(());
            }
            // The agent's own job keeps running until it quits; another daemon unloads it.
            if !is_the_job(&label) && loaded(&label) {
                let _ = Command::new("/bin/launchctl")
                    .args(["bootout", &format!("{}/{label}", domain())])
                    .output();
                tracing::info!(label, "overnight supervisor unloaded");
            }
            let _ = std::fs::remove_file(&path);
        }
        Ok(())
    }
}
