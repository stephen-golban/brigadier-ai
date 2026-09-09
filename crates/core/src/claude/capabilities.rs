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

/// Reject effort settings the adapter cannot faithfully deliver. CLI vocabulary was
/// checked against the installed binary; Haiku explicitly ignores effort.
pub fn validate_effort(
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<(), crate::driver::DriverError> {
    let Some(effort) = effort else { return Ok(()) };
    if !["low", "medium", "high", "xhigh", "max"].contains(&effort) {
        return Err(crate::driver::DriverError::Protocol(format!(
            "unsupported Claude effort {effort:?}"
        )));
    }
    if model.is_some_and(|m| m.to_ascii_lowercase().contains("haiku")) {
        return Err(crate::driver::DriverError::Protocol(
            "the selected Haiku model does not support effort".into(),
        ));
    }
    Ok(())
}

static USAGE: OnceLock<Mutex<HashMap<String, serde_json::Value>>> = OnceLock::new();
/// Last observed provider usage windows. None means unknown, never unlimited.
pub fn usage(instance: &str) -> Option<serde_json::Value> {
    USAGE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(instance)
        .cloned()
}
pub(crate) fn record_usage(instance: &str, info: serde_json::Value) {
    crate::allowance::record("claude-code", instance, info.clone());
    USAGE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(instance.to_owned(), info);
}

#[cfg(test)]
mod effort_tests {
    use super::*;
    #[test]
    fn unsupported_effort_is_rejected_instead_of_silently_ignored() {
        assert!(validate_effort(Some("haiku"), Some("high")).is_err());
        assert!(validate_effort(Some("opus"), Some("ultra")).is_err());
        assert!(validate_effort(Some("opus"), Some("xhigh")).is_ok());
        assert!(validate_effort(Some("haiku"), None).is_ok());
    }
    #[test]
    fn unknown_usage_is_not_zero_and_observed_windows_survive() {
        assert_eq!(usage("absent-provider"), None);
        let info = serde_json::json!({"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.15,"resetsAt":1900000000}}});
        record_usage("usage-test", info.clone());
        assert_eq!(usage("usage-test"), Some(info));
    }
}

/// A real prompt command advertised by a particular initialized session.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCommand {
    /// Native CLI command name without slash.
    pub name: String,
    /// Native command help text.
    pub description: String,
    /// CLI argument hint. Empty means no argument support is advertised.
    pub argument_hint: String,
}
static COMMANDS: OnceLock<Mutex<HashMap<String, Vec<PromptCommand>>>> = OnceLock::new();
/// Session-scoped command catalog; project-specific skills never leak across sessions.
pub fn commands(session: &str) -> Vec<PromptCommand> {
    COMMANDS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(session)
        .cloned()
        .unwrap_or_default()
}
pub(crate) fn record_commands(session: &str, response: &serde_json::Value) {
    let Some(rows) = response["commands"].as_array() else {
        return;
    };
    let commands = rows
        .iter()
        .filter_map(|row| {
            let name = row["name"].as_str()?;
            if name.is_empty()
                || !name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
            {
                return None;
            }
            Some(PromptCommand {
                name: name.into(),
                description: crate::event::bounded(
                    row["description"]
                        .as_str()
                        .unwrap_or("Native CLI prompt command"),
                    1000,
                ),
                argument_hint: crate::event::bounded(
                    row["argumentHint"].as_str().unwrap_or(""),
                    200,
                ),
            })
        })
        .take(256)
        .collect();
    let mut registry = COMMANDS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if registry.len() >= 512 && !registry.contains_key(session) {
        if let Some(old) = registry.keys().next().cloned() {
            registry.remove(&old);
        }
    }
    registry.insert(session.into(), commands);
}

#[cfg(test)]
mod command_tests {
    use super::*;
    #[test]
    fn command_catalog_is_session_scoped_and_retains_argument_contract() {
        record_commands(
            "commands-a",
            &serde_json::json!({"commands":[{"name":"echo","description":"Echo","argumentHint":"<marker>"},{"name":"invalid path","description":"ignored"}]}),
        );
        record_commands(
            "commands-b",
            &serde_json::json!({"commands":[{"name":"other","argumentHint":""}]}),
        );
        assert_eq!(commands("commands-a").len(), 1);
        assert_eq!(commands("commands-a")[0].argument_hint, "<marker>");
        assert_eq!(commands("commands-b")[0].name, "other");
        assert!(commands("commands-missing").is_empty());
    }
}
