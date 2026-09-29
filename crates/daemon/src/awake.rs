//! Keeps the computer awake: while agents work, always, or never (the `keepAwake` setting),
//! and optionally with the lid closed (`keepAwakeLidClosed`).
//!
//! - macOS: `caffeinate -i -s -w <pid>` holds the idle and system sleep assertions and ends
//!   with the daemon. No assertion stops a closed lid from sleeping the computer, so the lid
//!   option sets `pmset disablesleep 1` instead, through a sudoers rule that allows only
//!   `pmset disablesleep 0` and `1`, installed once behind an administrator prompt. That
//!   setting outlives the process (and a reboot), so a marker file records it before it is
//!   set, a guard process restores it if the daemon dies, and startup restores what a crash
//!   left behind.
//! - Linux: `systemd-inhibit` blocks idle and sleep, and the lid switch when asked.
//! - Windows: `SetThreadExecutionState` from a thread of its own; the lid follows the power
//!   plan.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use brigadier_core::manager::SessionManager;
use brigadier_core::{Core, KeepAwake};
use brigadier_ipc::protocol::{KeepAwakeStatus, LidClosed};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// How often the setting and the agents' work are checked again.
const CHECK_EVERY: Duration = Duration::from_secs(10);

pub struct Awake {
    core: Arc<Core>,
    sessions: Arc<SessionManager>,
    data_dir: PathBuf,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    blocker: Option<Blocker>,
    #[cfg(target_os = "macos")]
    lid: Option<lid::Held>,
    /// Whether the sudoers rule lets the lid option work without a password; unknown until
    /// first needed.
    #[cfg(target_os = "macos")]
    authorized: Option<bool>,
    error: Option<String>,
    /// Shut down: nothing keeps the computer awake any more, whatever the settings say.
    stopped: bool,
}

impl Awake {
    pub fn new(core: Arc<Core>, sessions: Arc<SessionManager>, data_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            core,
            sessions,
            data_dir,
            state: Mutex::new(State::default()),
        })
    }

    /// Restores sleep if a crashed daemon left it disabled.
    pub async fn recover(&self) {
        #[cfg(target_os = "macos")]
        lid::recover(&self.data_dir).await;
        #[cfg(not(target_os = "macos"))]
        let _ = &self.data_dir;
    }

    /// Applies the settings every few seconds until `stop`.
    pub async fn run(self: Arc<Self>, stop: CancellationToken) -> anyhow::Result<()> {
        let mut tick = tokio::time::interval(CHECK_EVERY);
        loop {
            tokio::select! {
                () = stop.cancelled() => return Ok(()),
                _ = tick.tick() => {
                    self.apply().await;
                }
            }
        }
    }

    /// Starts or stops keeping awake to match the settings now, and says how it stands.
    pub async fn apply(&self) -> KeepAwakeStatus {
        let settings = self.core.settings();
        let wanted = match settings.keep_awake {
            KeepAwake::Off => false,
            KeepAwake::Always => true,
            KeepAwake::Agents => self.sessions.agents_working().await,
        };
        let mut state = self.state.lock().await;
        let wanted = wanted && !state.stopped;
        let lid_wanted = wanted && settings.keep_awake_lid_closed;
        state.error = None;

        let running = state.blocker.as_mut().is_some_and(Blocker::running);
        let current = state.blocker.as_ref().map(|blocker| blocker.lid);
        if !wanted || !running || current != Some(blocker_lid(lid_wanted)) {
            state.blocker = None;
        }
        if wanted && state.blocker.is_none() {
            match Blocker::start(blocker_lid(lid_wanted)) {
                Ok(blocker) => state.blocker = Some(blocker),
                Err(err) => {
                    tracing::warn!(error = %err, "could not keep the computer awake");
                    state.error = Some(format!("Could not keep the computer awake: {err}"));
                }
            }
        }

        #[cfg(target_os = "macos")]
        self.apply_lid(&mut state, lid_wanted).await;
        status(&mut state).await
    }

    /// Lets the lid option work without asking again, behind one administrator prompt.
    pub async fn set_up_lid_closed(&self) -> KeepAwakeStatus {
        #[cfg(target_os = "macos")]
        {
            let result = lid::set_up().await;
            let mut state = self.state.lock().await;
            state.authorized = None;
            if let Err(err) = result {
                drop(state);
                let mut status = self.apply().await;
                status.error = Some(err);
                return status;
            }
        }
        self.apply().await
    }

    /// Stops keeping awake and restores sleep for good, before the daemon exits (or while
    /// Brigadier is uninstalled).
    pub async fn shutdown(&self) {
        let mut state = self.state.lock().await;
        state.stopped = true;
        state.blocker = None;
        #[cfg(target_os = "macos")]
        if let Some(held) = state.lid.take()
            && let Err(err) = lid::restore(&self.data_dir, held).await
        {
            tracing::warn!(error = %err, "could not restore sleep");
        }
    }

    #[cfg(target_os = "macos")]
    async fn apply_lid(&self, state: &mut State, wanted: bool) {
        let low = if wanted || state.lid.is_some() {
            battery::low().await
        } else {
            None
        };
        if let Some(percent) = low.filter(|_| wanted) {
            state.error = Some(format!(
                "Closing the lid sleeps the computer again: the battery is at {percent}%."
            ));
        }
        let wanted = wanted && low.is_none();
        if !wanted {
            if let Some(held) = state.lid.take()
                && let Err(err) = lid::restore(&self.data_dir, held).await
            {
                tracing::warn!(error = %err, "could not restore sleep");
                state.error = Some(format!("Could not restore sleep: {err}"));
            }
            return;
        }
        // Borrowed from another app that has since let sleep back on: take it over.
        if state.lid.as_ref().is_some_and(|held| !held.owned())
            && lid::sleep_disabled().await == Some(false)
        {
            state.lid = None;
        }
        if state.lid.is_some() {
            return;
        }
        if state.authorized == Some(false) {
            return;
        }
        match lid::disable_sleep(&self.data_dir).await {
            Ok(held) => {
                state.lid = Some(held);
                state.authorized = Some(true);
            }
            Err(err) => {
                tracing::info!(error = %err, "could not disable sleep for the lid");
                state.authorized = Some(false);
            }
        }
    }
}

/// Whether the blocker itself holds the lid (Linux's inhibitor does; elsewhere it doesn't).
fn blocker_lid(lid_wanted: bool) -> bool {
    cfg!(target_os = "linux") && lid_wanted
}

async fn status(state: &mut State) -> KeepAwakeStatus {
    #[cfg(target_os = "macos")]
    let lid_closed = if state.lid.is_some() {
        LidClosed::Active
    } else {
        let authorized = match state.authorized {
            Some(known) => known,
            None => {
                let known = lid::authorized().await;
                state.authorized = Some(known);
                known
            }
        };
        if authorized {
            LidClosed::Ready
        } else {
            LidClosed::NeedsSetup
        }
    };
    #[cfg(target_os = "linux")]
    let lid_closed = if state.blocker.as_ref().is_some_and(|blocker| blocker.lid) {
        LidClosed::Active
    } else {
        LidClosed::Ready
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let lid_closed = LidClosed::Unsupported;
    KeepAwakeStatus {
        active: state.blocker.is_some(),
        lid_closed,
        error: state.error.clone(),
    }
}

/// Holds the computer awake until dropped.
struct Blocker {
    lid: bool,
    #[cfg(unix)]
    child: tokio::process::Child,
    #[cfg(windows)]
    _release: std::sync::mpsc::Sender<()>,
}

impl Blocker {
    #[cfg(target_os = "macos")]
    fn start(lid: bool) -> std::io::Result<Self> {
        let child = tokio::process::Command::new("/usr/bin/caffeinate")
            .args(["-i", "-s", "-w", &std::process::id().to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        Ok(Self { lid, child })
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    fn start(lid: bool) -> std::io::Result<Self> {
        let what = if lid {
            "idle:sleep:handle-lid-switch"
        } else {
            "idle:sleep"
        };
        let child = tokio::process::Command::new("systemd-inhibit")
            .args([
                &format!("--what={what}"),
                "--who=Brigadier",
                "--why=Agents are working",
                "--mode=block",
                "sleep",
                "infinity",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        Ok(Self { lid, child })
    }

    #[cfg(windows)]
    fn start(lid: bool) -> std::io::Result<Self> {
        let (release, released) = std::sync::mpsc::channel::<()>();
        std::thread::Builder::new()
            .name("keep-awake".into())
            .spawn(move || {
                windows::hold();
                // Returns once the sender is dropped.
                let _ = released.recv();
                windows::release();
            })?;
        Ok(Self {
            lid,
            _release: release,
        })
    }

    /// Whether it still holds (a helper process can exit on its own).
    fn running(&mut self) -> bool {
        #[cfg(unix)]
        return matches!(self.child.try_wait(), Ok(None));
        #[cfg(windows)]
        return true;
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod windows {
    use windows_sys::Win32::System::Power::{
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
    };

    pub fn hold() {
        // SAFETY: takes flags only; applies to the calling thread until changed again.
        unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
    }

    pub fn release() {
        // SAFETY: as above.
        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    }
}

#[cfg(target_os = "macos")]
mod battery {
    /// Below this charge, on battery, the lid sleeps the computer again.
    const MIN_PERCENT: u32 = 10;

    /// The charge, when running on battery at or below the minimum.
    pub async fn low() -> Option<u32> {
        let output = tokio::process::Command::new("/usr/bin/pmset")
            .args(["-g", "batt"])
            .output()
            .await
            .ok()?;
        low_in(&String::from_utf8_lossy(&output.stdout))
    }

    pub(super) fn low_in(report: &str) -> Option<u32> {
        if !report.contains("'Battery Power'") {
            return None;
        }
        let percent = report
            .split(|c: char| c.is_whitespace() || c == ';')
            .find_map(|word| word.strip_suffix('%')?.parse::<u32>().ok())?;
        (percent <= MIN_PERCENT).then_some(percent)
    }
}

/// Whether the keep-awake-with-the-lid-closed sudoers rule is installed.
pub fn lid_rule_installed() -> bool {
    #[cfg(target_os = "macos")]
    return lid::rule_installed();
    #[cfg(not(target_os = "macos"))]
    false
}

/// Removes the keep-awake-with-the-lid-closed sudoers rule behind one administrator prompt, if
/// it is installed. What happened, said plainly.
pub async fn remove_lid_rule() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    return lid::remove_rule().await;
    #[cfg(not(target_os = "macos"))]
    Ok("There is no such rule on this system.".into())
}

#[cfg(target_os = "macos")]
mod lid {
    use std::path::{Path, PathBuf};
    use std::process::Stdio;

    const SUDO: &str = "/usr/bin/sudo";
    const PMSET: &str = "/usr/bin/pmset";
    /// Sudo skips files in sudoers.d whose name has a dot, so the rule is checked under
    /// `RULE.new` before it takes effect.
    const RULE: &str = "/etc/sudoers.d/brigadier-lid-closed";

    /// Sleep disabled by this daemon; holds its pid.
    fn marker(data_dir: &Path) -> PathBuf {
        data_dir.join("sleep-disabled")
    }

    /// Sleep disabled, and the guard that restores it if the daemon dies. Not `owned` when
    /// something else (another keep-awake app) had disabled it already: then it is left as is.
    pub struct Held {
        guard: Option<std::process::Child>,
        owned: bool,
    }

    impl Held {
        pub fn owned(&self) -> bool {
            self.owned
        }
    }

    async fn pmset_disablesleep(on: bool) -> Result<(), String> {
        let output = tokio::process::Command::new(SUDO)
            .args(["-n", PMSET, "disablesleep", if on { "1" } else { "0" }])
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|err| err.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
        }
    }

    /// Whether sleep is disabled system-wide now (`SleepDisabled` in `pmset -g`).
    pub async fn sleep_disabled() -> Option<bool> {
        let output = tokio::process::Command::new(PMSET)
            .arg("-g")
            .output()
            .await
            .ok()?;
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .find_map(|line| {
                let mut words = line.split_whitespace();
                (words.next()? == "SleepDisabled").then(|| words.next() == Some("1"))
            })
    }

    /// Whether sleep can be disabled without a password: sets it to what it already is.
    pub async fn authorized() -> bool {
        let Some(current) = sleep_disabled().await else {
            return false;
        };
        pmset_disablesleep(current).await.is_ok()
    }

    /// Installs the sudoers rule behind an administrator prompt.
    pub async fn set_up() -> Result<(), String> {
        let uid = nix::unistd::getuid();
        let rule =
            format!("#{uid} ALL=(root) NOPASSWD: {PMSET} disablesleep 1, {PMSET} disablesleep 0");
        let script = format!(
            "mkdir -p /etc/sudoers.d && echo '{rule}' > {RULE}.new && chmod 0440 {RULE}.new \
             && /usr/sbin/visudo -c -q -f {RULE}.new && mv -f {RULE}.new {RULE} \
             || {{ rm -f {RULE}.new; exit 1; }}"
        );
        let apple_script = format!(
            "do shell script \"{}\" with administrator privileges with prompt \
             \"Brigadier wants to keep working with the lid closed. It asks once; after that \
             it can only turn sleep off and on again.\"",
            applescript_escape(&script)
        );
        let output = tokio::process::Command::new("/usr/bin/osascript")
            .args(["-e", &apple_script])
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|err| err.to_string())?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(if stderr.contains("-128") {
            "The administrator password was not given.".to_owned()
        } else {
            format!("Setting up failed: {}", stderr.trim())
        })
    }

    /// A development build started with `BRIGADIER_LID_RULE_DRY_RUN=<file>` looks at that
    /// stand-in instead of the rule and only says what it would run, so uninstalling can be
    /// tried without touching the rule an installed Brigadier uses.
    fn dry_run() -> Option<PathBuf> {
        if !cfg!(debug_assertions) {
            return None;
        }
        std::env::var_os("BRIGADIER_LID_RULE_DRY_RUN")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
    }

    fn rule_path() -> PathBuf {
        dry_run().unwrap_or_else(|| PathBuf::from(RULE))
    }

    pub fn rule_installed() -> bool {
        std::fs::symlink_metadata(rule_path()).is_ok()
    }

    /// Removes the sudoers rule behind an administrator prompt.
    pub async fn remove_rule() -> Result<String, String> {
        if !rule_installed() {
            return Ok("It wasn't installed.".into());
        }
        if let Some(stand_in) = dry_run() {
            let script = format!("/bin/rm -f {}", stand_in.display());
            tracing::info!(command = %script, "dry run: would remove the lid-closed sudoers rule as administrator");
            return Ok(format!("Dry run: would run “{script}” as administrator."));
        }
        let script = format!("/bin/rm -f {RULE}");
        let apple_script = format!(
            "do shell script \"{}\" with administrator privileges with prompt \
             \"Brigadier is being uninstalled and removes the rule that let it keep your Mac \
             awake with the lid closed.\"",
            applescript_escape(&script)
        );
        let output = tokio::process::Command::new("/usr/bin/osascript")
            .args(["-e", &apple_script])
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|err| err.to_string())?;
        if output.status.success() && !rule_installed() {
            return Ok("Removed.".into());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(if stderr.contains("-128") {
            format!("The administrator password was not given; remove it with: sudo rm {RULE}")
        } else {
            format!(
                "It stays ({}); remove it with: sudo rm {RULE}",
                stderr.trim()
            )
        })
    }

    fn applescript_escape(text: &str) -> String {
        text.replace('\\', "\\\\").replace('"', "\\\"")
    }

    /// Disables sleep system-wide, recording it first so that it is undone even after a crash.
    pub async fn disable_sleep(data_dir: &Path) -> Result<Held, String> {
        if sleep_disabled().await == Some(true) {
            tracing::info!("sleep is already disabled by something else; leaving it to it");
            return Ok(Held {
                guard: None,
                owned: false,
            });
        }
        let marker = marker(data_dir);
        let pid = std::process::id().to_string();
        std::fs::write(&marker, &pid).map_err(|err| err.to_string())?;
        if let Err(err) = pmset_disablesleep(true).await {
            let _ = std::fs::remove_file(&marker);
            return Err(err);
        }
        tracing::info!("sleep disabled for the closed lid");
        Ok(Held {
            guard: spawn_guard(&pid, &marker),
            owned: true,
        })
    }

    /// A process of its own that restores sleep once the daemon is gone, unless a newer
    /// daemon took the marker over.
    fn spawn_guard(pid: &str, marker: &Path) -> Option<std::process::Child> {
        use std::os::unix::process::CommandExt;
        let script = r#"while kill -0 "$1" 2>/dev/null; do sleep 5; done
if [ "$(cat "$2" 2>/dev/null)" = "$1" ]; then /usr/bin/sudo -n /usr/bin/pmset disablesleep 0 && rm -f "$2"; fi"#;
        std::process::Command::new("/bin/sh")
            .args(["-c", script, "brigadier-sleep-guard", pid])
            .arg(marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .inspect_err(|err| tracing::warn!(error = %err, "could not start the sleep guard"))
            .ok()
    }

    /// Enables sleep again; sleeps now if the lid is already closed without an external
    /// display (restoring the setting alone doesn't).
    pub async fn restore(data_dir: &Path, mut held: Held) -> Result<(), String> {
        if !held.owned {
            return Ok(());
        }
        if let Some(mut guard) = held.guard.take() {
            let _ = guard.kill();
            let _ = guard.wait();
        }
        pmset_disablesleep(false).await?;
        let _ = std::fs::remove_file(marker(data_dir));
        tracing::info!("sleep restored");
        if lid_closed_sleeps().await {
            let _ = tokio::process::Command::new(PMSET)
                .arg("sleepnow")
                .output()
                .await;
        }
        Ok(())
    }

    /// Restores what a daemon that died with sleep disabled left behind.
    pub async fn recover(data_dir: &Path) {
        let marker = marker(data_dir);
        if !marker.exists() {
            return;
        }
        match pmset_disablesleep(false).await {
            Ok(()) => {
                let _ = std::fs::remove_file(&marker);
                tracing::info!("restored sleep left disabled by an earlier run");
            }
            Err(err) => tracing::warn!(error = %err, "could not restore sleep left disabled"),
        }
    }

    /// The lid is closed and that would sleep the computer (no external display).
    async fn lid_closed_sleeps() -> bool {
        let Ok(output) = tokio::process::Command::new("/usr/sbin/ioreg")
            .args(["-r", "-k", "AppleClamshellState", "-d", "1"])
            .output()
            .await
        else {
            return false;
        };
        let report = String::from_utf8_lossy(&output.stdout);
        report.contains("\"AppleClamshellState\" = Yes")
            && report.contains("\"AppleClamshellCausesSleep\" = Yes")
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::battery::low_in;

    #[test]
    fn low_battery_only_on_battery_power() {
        let on_battery = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t8%; discharging; 0:20 remaining present: true";
        assert_eq!(low_in(on_battery), Some(8));
        let charged =
            "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t54%; discharging;";
        assert_eq!(low_in(charged), None);
        let plugged = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t5%; charging;";
        assert_eq!(low_in(plugged), None);
    }
}
