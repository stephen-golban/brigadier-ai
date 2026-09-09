//! Runtime model and quota information observed from app-server, scoped to account instance.
use super::rpc::{protocol, Rpc};
use crate::driver::DriverError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
/// A model advertised by the connected CLI, including supported effort values.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Model {
    /// Exact provider selection id.
    pub id: String,
    /// Provider display name.
    pub label: String,
    /// Advertised reasoning efforts.
    pub efforts: Vec<String>,
    /// Provider-designated default.
    pub is_default: bool,
}
static MODELS: OnceLock<Mutex<HashMap<String, Vec<Model>>>> = OnceLock::new();
static USAGE: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
/// Last successful live model discovery, or empty when unknown.
pub fn models(instance: &str) -> Vec<Model> {
    MODELS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(instance)
        .cloned()
        .unwrap_or_default()
}
/// Last observed rate limits, or None when unavailable.
pub fn usage(instance: &str) -> Option<Value> {
    USAGE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(instance)
        .cloned()
}
pub(crate) fn record_usage(instance: &str, value: Value) {
    crate::allowance::record("codex", instance, value.clone());
    USAGE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(instance.into(), value);
}
pub(crate) async fn discover(rpc: &mut Rpc, instance: &str) -> Result<Vec<Model>, DriverError> {
    let mut rows = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let result = rpc
            .request(
                "model/list",
                serde_json::json!({"limit":100,"cursor":cursor,"includeHidden":false}),
            )
            .await?;
        for row in result["data"]
            .as_array()
            .ok_or_else(|| protocol("Codex model/list omitted data"))?
        {
            if let Some(id) = row["model"].as_str().or_else(|| row["id"].as_str()) {
                rows.push(Model {
                    id: id.into(),
                    label: row["displayName"].as_str().unwrap_or(id).into(),
                    efforts: row["supportedReasoningEfforts"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|e| e["reasoningEffort"].as_str().map(str::to_owned))
                        .collect(),
                    is_default: row["isDefault"].as_bool().unwrap_or(false),
                });
            }
        }
        let next = result["nextCursor"].clone();
        if next.is_null() {
            break;
        }
        if next == cursor || rows.len() > 1000 {
            return Err(protocol("Codex model pagination did not terminate"));
        }
        cursor = next;
    }
    MODELS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(instance.into(), rows.clone());
    Ok(rows)
}
pub(crate) fn validate(
    rows: &[Model],
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<(), DriverError> {
    let chosen = match model {
        Some(id) => Some(rows.iter().find(|r| r.id == id).ok_or_else(|| {
            protocol(format!(
                "Codex model {id:?} is not in the connected account catalog"
            ))
        })?),
        None => rows.iter().find(|r| r.is_default),
    };
    if let Some(effort) = effort {
        if !chosen.is_some_and(|r| r.efforts.iter().any(|e| e == effort)) {
            return Err(protocol(format!(
                "Codex effort {effort:?} is not supported by the selected model"
            )));
        }
    }
    Ok(())
}

/// Refresh models and account allowance from a fresh read-only CLI connection.
/// This can lift a known allowance wait without reopening or restarting stopped tasks.
pub async fn refresh(binary: &std::path::Path, instance: &str) -> Result<(), DriverError> {
    let mut rpc = Rpc::spawn(binary, &std::env::temp_dir(), &Default::default()).await?;
    let result = async {
        rpc.initialize().await?;
        discover(&mut rpc, instance).await?;
        if let Ok(usage) = rpc
            .request("account/rateLimits/read", serde_json::json!({}))
            .await
        {
            record_usage(instance, usage);
        }
        Ok(())
    }
    .await;
    rpc.kill().await;
    result
}
