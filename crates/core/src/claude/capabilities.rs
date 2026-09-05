//! Account-visible models from the CLI initialize response, never inferred from screenshots.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
#[derive(Clone, Debug, Serialize, Deserialize)]
/// One model advertised by an initialized CLI instance.
pub struct Model {
    /// CLI selection value.
    pub id: String,
    /// CLI display name.
    pub label: String,
    /// Resolved provider model identifier, when supplied.
    pub resolved: String,
}
static MODELS: OnceLock<Mutex<HashMap<String, Vec<Model>>>> = OnceLock::new();
/// Most recent initialized model list for this provider instance.
pub fn models(instance: &str) -> Vec<Model> {
    MODELS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(instance)
        .cloned()
        .unwrap_or_default()
}
pub(crate) fn record(instance: &str, response: &serde_json::Value) {
    let Some(rows) = response.get("models").and_then(|v| v.as_array()) else {
        return;
    };
    let rows: Vec<Model> = rows
        .iter()
        .filter_map(|r| {
            Some(Model {
                id: r.get("value")?.as_str()?.to_owned(),
                label: r.get("displayName")?.as_str()?.to_owned(),
                resolved: r
                    .get("resolvedModel")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned(),
            })
        })
        .take(100)
        .collect();
    if !rows.is_empty() {
        MODELS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(instance.to_owned(), rows);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn initialize_models_are_scoped_to_instance() {
        record(
            "capabilities-test-a",
            &serde_json::json!({"models":[{"value":"haiku","displayName":"Haiku","resolvedModel":"claude-haiku-4-5"},{"broken":true}]}),
        );
        let found = models("capabilities-test-a");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].resolved, "claude-haiku-4-5");
        assert!(models("capabilities-test-b").is_empty());
    }
}
