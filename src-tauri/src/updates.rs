//! Release checks and explicit, verified updates of registered CLI installations.
use crate::{error::AppError, state::AppState};
use serde::Serialize;
use std::{ffi::OsStr, path::Path, process::Stdio, time::Duration};
use tauri::State;

// Serialize installers even when invoked from multiple windows.
static UPDATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static UPDATE_ENV: tokio::sync::OnceCell<brigadier_supervisor::verify::GateEnv> =
    tokio::sync::OnceCell::const_new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SoftwareUpdate {
    id: String,
    provider: String,
    label: String,
    installed_version: Option<String>,
    latest_version: Option<String>,
    update_available: bool,
    release_url: Option<String>,
    error: Option<String>,
}

fn version(value: &str) -> Option<semver::Version> {
    value
        .split_whitespace()
        .find_map(|part| semver::Version::parse(part.trim_start_matches('v')).ok())
}

fn newer(installed: Option<&str>, latest: &str) -> Option<bool> {
    Some(version(latest)? > version(installed?)?)
}

async fn installed_version(binary: &Path, path: &OsStr) -> Result<semver::Version, AppError> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(binary)
            .arg("--version")
            .env("PATH", path)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| AppError::io("CLI version check timed out."))??;
    if output.status.success() {
        if let Some(version) = version(&String::from_utf8_lossy(&output.stdout)) {
            return Ok(version);
        }
    }
    Err(AppError::io("Could not verify the installed CLI version."))
}

async fn run_update(
    binary: &Path,
    path: &OsStr,
    target: &semver::Version,
    timeout: Duration,
) -> Result<String, AppError> {
    // An auto-updater or another window may already have installed the requested version.
    let before = installed_version(binary, path).await?;
    if before >= *target {
        return Ok(before.to_string());
    }
    let mut command = tokio::process::Command::new(binary);
    command
        .arg("update")
        .env("PATH", path)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if let Some(home) = std::env::var_os("HOME") {
        command.current_dir(home);
    }
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| {
            AppError::io("CLI update timed out. Check its installation before retrying.")
        })??;
    if !output.status.success() {
        let output = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout),
        );
        let detail: String = output.trim().chars().take(4000).collect();
        return Err(AppError::io(format!("CLI updater failed. {detail}")));
    }
    // Exit zero is insufficient: unsupported installation methods can print instructions
    // without changing anything. Verify the same executable the driver actually launches.
    let installed = installed_version(binary, path).await?;
    if installed < *target {
        return Err(AppError::io(format!(
            "The updater finished, but the connected CLI is still {installed}; expected {target} or newer. Check its update channel or package manager."
        )));
    }
    Ok(installed.to_string())
}

#[tauri::command]
pub(crate) async fn update_software(
    state: State<'_, AppState>,
    id: String,
    target_version: String,
) -> Result<String, AppError> {
    let _guard = UPDATE_LOCK
        .try_lock()
        .map_err(|_| AppError::io("A CLI update is already running."))?;
    let target = semver::Version::parse(&target_version)
        .map_err(|_| AppError::invalid_argument("Invalid target version."))?;
    let driver = state
        .get()?
        .supervisor
        .registered_drivers()
        .into_iter()
        .find(|driver| driver.instance_id().to_string() == id)
        .ok_or_else(|| AppError::invalid_argument("The connected CLI was not found."))?;
    if !matches!(driver.kind().to_string().as_str(), "codex" | "claude-code") {
        return Err(AppError::invalid_argument(
            "Updates are not supported for this CLI.",
        ));
    }
    let binary = driver
        .describe()
        .binary_path
        .ok_or_else(|| AppError::invalid_argument("The CLI has no installed binary."))?;
    let env = UPDATE_ENV
        .get_or_init(|| brigadier_supervisor::verify::GateEnv::resolve("/bin/sh"))
        .await;
    // Finder launches have a minimal PATH. Include both the user's environment and this
    // installation's bin directory so the updater can find node/npm or its package manager.
    let path = std::env::join_paths(
        binary
            .parent()
            .into_iter()
            .map(Path::to_path_buf)
            .chain(std::env::split_paths(env.path())),
    )
    .map_err(|e| AppError::io(e.to_string()))?;
    run_update(&binary, &path, &target, Duration::from_secs(300)).await
}

async fn check(client: &reqwest::Client, row: &mut SoftwareUpdate, endpoint: &str, field: &str) {
    let result = async {
        let response = client.get(endpoint).send().await?.error_for_status()?;
        response.json::<serde_json::Value>().await
    }
    .await;
    match result {
        Ok(data) => {
            if let Some(latest) = data[field].as_str() {
                row.latest_version = Some(latest.trim_start_matches('v').to_owned());
                match newer(row.installed_version.as_deref(), latest) {
                    Some(available) => row.update_available = available,
                    None => row.error = Some("Installed version could not be compared.".into()),
                }
            } else {
                row.error = Some("Release version is unavailable.".into());
            }
        }
        Err(error) => {
            row.error = Some(if error.status() == Some(reqwest::StatusCode::NOT_FOUND) {
                "No public release is available to check.".into()
            } else {
                "Could not check for updates. Try again later.".into()
            })
        }
    }
}

#[tauri::command]
pub(crate) async fn software_updates(
    state: State<'_, AppState>,
) -> Result<Vec<SoftwareUpdate>, AppError> {
    let client = reqwest::Client::builder()
        .user_agent("Brigadier update check")
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| AppError::io(e.to_string()))?;
    let mut checks = tokio::task::JoinSet::new();
    let app_client = client.clone();
    checks.spawn(async move {
        let mut row = SoftwareUpdate {
            id: "brigadier".into(),
            provider: "brigadier".into(),
            label: "Brigadier".into(),
            installed_version: Some(env!("CARGO_PKG_VERSION").into()),
            latest_version: None,
            update_available: false,
            release_url: Some("https://github.com/stephen-golban/brigadier-ai/releases".into()),
            error: None,
        };
        check(
            &app_client,
            &mut row,
            "https://api.github.com/repos/stephen-golban/brigadier-ai/releases/latest",
            "tag_name",
        )
        .await;
        row
    });
    for driver in state.get()?.supervisor.registered_drivers() {
        let info = driver.describe();
        // Replay drivers are not connected CLIs.
        let Some(binary) = info.binary_path else {
            continue;
        };
        let provider = driver.kind().to_string();
        let endpoint = match provider.as_str() {
            "claude-code" => Some("https://registry.npmjs.org/@anthropic-ai/claude-code/latest"),
            "codex" => Some("https://registry.npmjs.org/@openai/codex/latest"),
            _ => None,
        };
        let mut row = SoftwareUpdate {
            id: driver.instance_id().to_string(),
            provider: provider.clone(),
            label: info.display_name,
            installed_version: info.version,
            latest_version: None,
            update_available: false,
            release_url: match provider.as_str() {
                "claude-code" => Some("https://github.com/anthropics/claude-code/releases".into()),
                "codex" => Some("https://github.com/openai/codex/releases".into()),
                _ => None,
            },
            error: None,
        };
        let client = client.clone();
        checks.spawn(async move {
            let mut command = tokio::process::Command::new(binary);
            command.arg("--version").kill_on_drop(true);
            // Re-read the installed version so external CLI updates are reflected without a restart.
            match tokio::time::timeout(Duration::from_secs(5), command.output()).await {
                Ok(Ok(output)) if output.status.success() => {
                    row.installed_version =
                        version(&String::from_utf8_lossy(&output.stdout)).map(|v| v.to_string());
                }
                _ => {
                    row.installed_version = None;
                    row.error = Some("CLI is unavailable. Check its installation.".into());
                    return row;
                }
            }
            if let Some(endpoint) = endpoint {
                check(&client, &mut row, endpoint, "version").await;
            } else {
                row.error = Some("Update checks are not supported for this CLI.".into());
            }
            row
        });
    }
    let mut rows = Vec::new();
    while let Some(result) = checks.join_next().await {
        rows.push(result.map_err(|e| AppError::io(e.to_string()))?);
    }
    rows.sort_by_key(|row| {
        (
            row.provider != "brigadier",
            row.label.clone(),
            row.id.clone(),
        )
    });
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_cli_versions_without_false_update_indicators() {
        assert_eq!(newer(Some("codex-cli 0.9.0"), "0.10.0"), Some(true));
        assert_eq!(newer(Some("2.1.5 (Claude Code)"), "2.1.5"), Some(false));
        assert_eq!(newer(Some("v2.2.0"), "2.1.5"), Some(false));
        assert_eq!(newer(Some("1.0.0-beta.1"), "1.0.0"), Some(true));
        assert_eq!(newer(None, "1.0.0"), None);
        assert_eq!(newer(Some("unknown"), "1.0.0"), None);
    }

    #[cfg(unix)]
    fn fake_cli(update: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("cli");
        std::fs::write(dir.path().join("version"), "1.0.0").unwrap();
        std::fs::write(&binary, format!(
            "#!/bin/sh\ncd -- \"$(dirname -- \"$0\")\"\ncase \"$1\" in\n--version) cat version ;;\nupdate) {update} ;;\n*) exit 99 ;;\nesac\n"
        )).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, binary)
    }

    #[cfg(unix)]
    async fn update_fixture(binary: &Path) -> Result<String, AppError> {
        run_update(
            binary,
            OsStr::new("/usr/bin:/bin"),
            &semver::Version::new(1, 1, 0),
            Duration::from_secs(5),
        )
        .await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_updater_and_verifies_the_connected_binary() {
        let (_dir, binary) = fake_cli("echo 1.1.0 > version");
        assert_eq!(update_fixture(&binary).await.unwrap(), "1.1.0");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exit_zero_without_installing_is_not_success() {
        let (_dir, binary) = fake_cli("echo 'Please update with your package manager'");
        let error = update_fixture(&binary).await.unwrap_err();
        assert!(error.message.contains("still 1.0.0"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_installer_failures_and_failed_verification() {
        let (_dir, binary) = fake_cli("echo 'Permission denied' >&2; exit 1");
        assert!(update_fixture(&binary)
            .await
            .unwrap_err()
            .message
            .contains("Permission denied"));
        let (_dir, binary) = fake_cli("echo unknown > version");
        assert!(update_fixture(&binary)
            .await
            .unwrap_err()
            .message
            .contains("Could not verify"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn already_installed_version_does_not_run_the_installer() {
        let (dir, binary) = fake_cli("exit 99");
        std::fs::write(dir.path().join("version"), "1.2.0").unwrap();
        assert_eq!(update_fixture(&binary).await.unwrap(), "1.2.0");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_timeout_without_success() {
        let (_dir, binary) = fake_cli("exec sleep 10");
        let result = run_update(
            &binary,
            OsStr::new("/usr/bin:/bin"),
            &semver::Version::new(1, 1, 0),
            Duration::from_millis(50),
        )
        .await;
        assert!(result.unwrap_err().message.contains("timed out"));
    }
}
