//! Selectable providers come from registered adapters, never guessed model families.
use crate::{error::AppError, state::AppState};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCatalogEntry {
    id: String,
    label: String,
    instance_id: String,
    version: Option<String>,
    models: Vec<ProviderModel>,
    efforts: Vec<String>,
    model_catalog_known: bool,
    usage: Option<serde_json::Value>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderModel {
    id: String,
    resolved_id: Option<String>,
    label: String,
    efforts: Vec<String>,
}

#[tauri::command]
pub(crate) async fn provider_catalog(
    state: State<'_, AppState>,
) -> Result<Vec<ProviderCatalogEntry>, AppError> {
    let mut catalog = Vec::new();
    for driver in state.get()?.supervisor.registered_drivers() {
        let info = driver.describe();
        let claude = driver.kind().as_str() == "claude-code";
        let efforts: Vec<String> = if claude {
            vec!["low", "medium", "high", "xhigh", "max"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        } else {
            vec![]
        };
        let rows = if claude {
            brigadier_core::claude::capabilities::models(driver.instance_id().as_str())
        } else {
            vec![]
        };
        let codex = driver.kind().as_str() == "codex";
        if codex {
            if let Some(binary) = info.binary_path.as_ref() {
                if let Err(error) = brigadier_core::codex::capabilities::refresh(
                    binary,
                    driver.instance_id().as_str(),
                )
                .await
                {
                    tracing::debug!(%error,"Codex catalog refresh unavailable; retaining last observation");
                }
            }
        }
        let codex_rows = if codex {
            brigadier_core::codex::capabilities::models(driver.instance_id().as_str())
        } else {
            vec![]
        };
        let known = !rows.is_empty() || !codex_rows.is_empty();
        let mut models: Vec<ProviderModel> = rows
            .into_iter()
            .map(|m| ProviderModel {
                efforts: if m.id.contains("haiku") || m.resolved.contains("haiku") {
                    vec![]
                } else {
                    efforts.clone()
                },
                id: m.id,
                resolved_id: Some(m.resolved),
                label: m.label,
            })
            .collect();
        models.extend(codex_rows.into_iter().map(|m| ProviderModel {
            id: m.id,
            resolved_id: None,
            label: m.label,
            efforts: m.efforts,
        }));
        let efforts = if codex {
            models
                .iter()
                .flat_map(|m| m.efforts.clone())
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect()
        } else {
            efforts
        };
        catalog.push(ProviderCatalogEntry {
            id: driver.kind().to_string(),
            instance_id: driver.instance_id().to_string(),
            label: info.display_name,
            version: info.version,
            models,
            efforts,
            model_catalog_known: known,
            usage: if claude {
                brigadier_core::claude::capabilities::usage(driver.instance_id().as_str())
            } else if codex {
                brigadier_core::codex::capabilities::usage(driver.instance_id().as_str())
            } else {
                None
            },
        });
    }
    Ok(catalog)
}
