//! Read-only release checks. Updating installed binaries remains an explicit user action.
use crate::{error::AppError, state::AppState};
use serde::Serialize;
use std::time::Duration;
use tauri::State;

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
}
