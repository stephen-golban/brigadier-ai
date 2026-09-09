//! A bounded macOS power assertion, owned by the backend rather than a webview.
use crate::{error::AppError, state::AppState};
use brigadier_core::session::NativeControl;
use std::{
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Default)]
pub(crate) struct KeepAwake(Mutex<Controller>);
#[derive(Default)]
struct Controller {
    enabled: bool,
    stopped: bool,
    assertion: Option<Assertion>,
}
struct Assertion {
    child: Child,
    started: Instant,
}
impl Drop for Assertion {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Controller {
    fn reconcile(&mut self, working: bool) -> Result<(), AppError> {
        if !self.enabled || self.stopped || !working {
            self.assertion = None;
            return Ok(());
        }
        if let Some(assertion) = &mut self.assertion {
            if assertion.started.elapsed() < Duration::from_secs(45)
                && assertion.child.try_wait()?.is_none()
            {
                return Ok(());
            }
        }
        // -u otherwise expires after five seconds. Renew before the one-minute lease
        // expires; -w also releases it if Brigadier crashes. No system settings change.
        let child = Command::new("/usr/bin/caffeinate")
            .args(["-diu", "-t", "60", "-w", &std::process::id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        self.assertion = Some(Assertion {
            child,
            started: Instant::now(),
        });
        Ok(())
    }
}

pub(crate) fn set_enabled(app: &tauri::AppHandle, enabled: bool) {
    let service = app.state::<KeepAwake>();
    let mut controller = service.0.lock().unwrap_or_else(|e| e.into_inner());
    controller.enabled = enabled;
    if !enabled {
        controller.assertion = None;
    }
    crate::peer_sessions::notify();
}

pub(crate) fn stop(app: &tauri::AppHandle) {
    if let Some(service) = app.try_state::<KeepAwake>() {
        let mut controller = service.0.lock().unwrap_or_else(|e| e.into_inner());
        controller.stopped = true;
        controller.assertion = None;
    }
}

pub(crate) fn start(app: tauri::AppHandle, enabled: bool) {
    set_enabled(&app, enabled);
    tauri::async_runtime::spawn(async move {
        let mut changes = crate::peer_sessions::subscribe();
        loop {
            let enabled = {
                let service = app.state::<KeepAwake>();
                let controller = service.0.lock().unwrap_or_else(|e| e.into_inner());
                if controller.stopped {
                    return;
                }
                controller.enabled
            };
            let mut working = false;
            if enabled {
                let state = app.state::<AppState>();
                if let Ok(ready) = state.get() {
                    for id in ready.supervisor.live_sessions() {
                        let activity = tokio::time::timeout(
                            Duration::from_secs(1),
                            ready
                                .supervisor
                                .native_control(&id, NativeControl::Activity),
                        )
                        .await;
                        if matches!(activity, Ok(Ok(ref value)) if value["status"] == "Working") {
                            working = true;
                            break;
                        }
                    }
                }
            }
            if let Err(error) = app
                .state::<KeepAwake>()
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .reconcile(working)
            {
                tracing::warn!(%error, "Could not keep the machine awake");
            }
            tokio::select! {
                _ = changes.changed() => {},
                _ = tokio::time::sleep(Duration::from_secs(2)) => {},
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn held() -> Controller {
        Controller {
            enabled: true,
            stopped: false,
            assertion: Some(Assertion {
                child: Command::new("/bin/sleep").arg("60").spawn().unwrap(),
                started: Instant::now(),
            }),
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_creates_and_releases_native_assertions() {
        let mut controller = Controller {
            enabled: true,
            ..Default::default()
        };
        controller.reconcile(true).unwrap();
        let marker = format!(
            "pid {}(caffeinate)",
            controller.assertion.as_ref().unwrap().child.id()
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let output = Command::new("/usr/bin/pmset")
                .args(["-g", "assertions"])
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&output.stdout);
            let lines: Vec<_> = text.lines().filter(|line| line.contains(&marker)).collect();
            if [
                "PreventUserIdleSystemSleep",
                "PreventUserIdleDisplaySleep",
                "UserIsActive",
            ]
            .iter()
            .all(|kind| lines.iter().any(|line| line.contains(kind)))
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Native assertions were not created: {text}"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        controller.reconcile(false).unwrap();
        let output = Command::new("/usr/bin/pmset")
            .args(["-g", "assertions"])
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&output.stdout).contains(&marker));
    }

    #[test]
    fn holds_one_assertion_and_releases_on_idle_disable_or_shutdown() {
        for reason in ["idle", "disabled", "shutdown"] {
            let mut controller = held();
            let pid = controller.assertion.as_ref().unwrap().child.id();
            controller.reconcile(true).unwrap();
            assert_eq!(controller.assertion.as_ref().unwrap().child.id(), pid);
            controller.enabled = reason != "disabled";
            controller.stopped = reason == "shutdown";
            controller.reconcile(reason != "idle").unwrap();
            assert!(controller.assertion.is_none());
        }
    }
}
