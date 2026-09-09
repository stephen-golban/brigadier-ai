//! Observed account allowance, persisted independently of disposable provider processes.
//! Absence is unknown. A passed reset permits a probe; it does not claim fresh usage data.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

/// A provider explicitly rejected work or reported an exhausted window.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Waiting {
    /// Exact provider adapter.
    pub provider: String,
    /// Observed account/CLI instance; shared by all descendants using it.
    pub instance: String,
    /// Provider supplied Unix seconds. None requires a new observation/manual probe.
    pub reset_at: Option<u64>,
    /// Time the actual provider signal was received.
    pub observed_at: u64,
}
#[derive(Default)]
struct Registry {
    path: Option<PathBuf>,
    waiting: BTreeMap<String, Waiting>,
}
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
fn registry() -> std::sync::MutexGuard<'static, Registry> {
    REGISTRY
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Load the last observed exhausted accounts before any task dispatch.
pub fn configure(data_dir: &Path) -> std::io::Result<()> {
    let path = data_dir.join("provider-allowance.json");
    let mut state = registry();
    if state.path.as_ref() == Some(&path) {
        return Ok(());
    }
    state.waiting = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(std::io::Error::other)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(e) => return Err(e),
    };
    state.path = Some(path);
    Ok(())
}
fn persist(state: &Registry) -> std::io::Result<()> {
    let Some(path) = &state.path else {
        return Ok(());
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(&state.waiting).map_err(std::io::Error::other)?;
    use std::io::Write;
    let mut file = std::fs::File::create(&tmp)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    std::fs::rename(tmp, path)
}

/// Receive actual provider usage payloads. Unknown shapes never fabricate allowance.
pub fn record(provider: &str, instance: &str, raw: Value) {
    let Some(reset) = exhausted(&raw) else {
        if !explicitly_available(&raw) {
            return;
        }
        let mut state = registry();
        state.waiting.remove(&format!("{provider}/{instance}"));
        if let Err(error) = persist(&state) {
            tracing::error!(%error, "could not persist provider allowance");
        }
        return;
    };
    let mut state = registry();
    let key = format!("{provider}/{instance}");
    // A later structured denial often omits the reset already observed in the account window.
    // Keep that concrete future boundary instead of replacing it with an indefinite wait.
    let reset = reset.or_else(|| {
        state
            .waiting
            .get(&key)
            .and_then(|w| w.reset_at)
            .filter(|t| *t > now())
    });
    state.waiting.insert(
        key,
        Waiting {
            provider: provider.into(),
            instance: instance.into(),
            reset_at: reset,
            observed_at: now(),
        },
    );
    if let Err(error) = persist(&state) {
        tracing::error!(%error, "could not persist provider allowance");
    }
}

/// A known exhausted exact account, unless its observed reset has passed.
pub fn blocked(provider: &str, instance: &str) -> Option<Waiting> {
    registry()
        .waiting
        .get(&format!("{provider}/{instance}"))
        .filter(|w| w.reset_at.is_none_or(|t| t > now()))
        .cloned()
}
/// Conservative guard for callers whose adapter resolves its configured account internally.
pub fn blocked_provider(provider: &str) -> Option<Waiting> {
    registry()
        .waiting
        .values()
        .filter(|w| w.provider == provider && w.reset_at.is_none_or(|t| t > now()))
        .max_by_key(|w| w.reset_at.unwrap_or(u64::MAX))
        .cloned()
}

fn reset(v: &Value) -> Option<u64> {
    ["resetsAt", "resetAt", "reset_at"]
        .iter()
        .find_map(|k| v.get(*k).and_then(Value::as_u64))
}
// Some(None) is exhausted with unknown reset; None means no exhaustion evidence.
fn exhausted(v: &Value) -> Option<Option<u64>> {
    let mut found = Vec::new();
    let denied = v
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|s| matches!(s, "rejected" | "denied" | "rate_limited"))
        || v.get("codexErrorInfo")
            .and_then(Value::as_str)
            .is_some_and(|s| matches!(s, "usageLimitExceeded" | "rateLimitExceeded"));
    if denied
        || v.get("usedPercent")
            .and_then(Value::as_f64)
            .is_some_and(|n| n >= 100.0)
        || v.get("utilization")
            .and_then(Value::as_f64)
            .is_some_and(|n| n >= 1.0)
    {
        found.push(reset(v));
    }
    match v {
        Value::Object(map) => {
            for child in map.values() {
                if let Some(r) = exhausted(child) {
                    found.push(r);
                }
            }
        }
        Value::Array(rows) => {
            for child in rows {
                if let Some(r) = exhausted(child) {
                    found.push(r);
                }
            }
        }
        _ => {}
    }
    if found.is_empty() {
        None
    } else {
        // Rejected wrappers often carry the reset only in the exhausted child window.
        Some(found.into_iter().flatten().max().or_else(|| reset(v)))
    }
}
fn explicitly_available(v: &Value) -> bool {
    if v.get("status").and_then(Value::as_str) == Some("allowed") {
        return true;
    }
    if v.get("usedPercent")
        .and_then(Value::as_f64)
        .is_some_and(|n| n.is_finite() && (0.0..100.0).contains(&n))
    {
        return true;
    }
    match v {
        Value::Object(map) => map.values().any(explicitly_available),
        Value::Array(rows) => rows.iter().any(explicitly_available),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_is_not_zero_and_only_exhausted_windows_define_reset() {
        assert_eq!(exhausted(&serde_json::json!({"rateLimits":null})), None);
        assert!(!explicitly_available(
            &serde_json::json!({"usedPercent":null})
        ));
        let raw = serde_json::json!({"rateLimits":{"primary":{"usedPercent":100,"resetsAt":200},"secondary":{"usedPercent":10,"resetsAt":900}}});
        assert_eq!(exhausted(&raw), Some(Some(200)));
        assert_eq!(
            exhausted(&serde_json::json!({"status":"rejected"})),
            Some(None)
        );
        assert_eq!(
            exhausted(&serde_json::json!({"codexErrorInfo":"usageLimitExceeded"})),
            Some(None)
        );
        assert_eq!(
            exhausted(&serde_json::json!({"codexErrorInfo":"rateLimitExceeded"})),
            Some(None)
        );
        assert_eq!(
            exhausted(&serde_json::json!({"codexErrorInfo":"sessionBudgetExceeded"})),
            None
        );
        assert_eq!(
            exhausted(
                &serde_json::json!({"status":"rejected","unifiedWindows":{"five_hour":{"utilization":1.0,"resetsAt":300}}})
            ),
            Some(Some(300))
        );
    }
    #[test]
    fn observed_reset_releases_only_a_probe_and_later_denial_keeps_known_boundary() {
        let future = now() + 60;
        record(
            "test-allowance",
            "account",
            serde_json::json!({"usedPercent":100,"resetsAt":future}),
        );
        record(
            "test-allowance",
            "account",
            serde_json::json!({"codexErrorInfo":"usageLimitExceeded"}),
        );
        assert_eq!(
            blocked("test-allowance", "account").unwrap().reset_at,
            Some(future)
        );
        assert_eq!(blocked("test-allowance", "unrelated-account"), None);
        record(
            "test-allowance",
            "account",
            serde_json::json!({"usedPercent":100,"resetsAt":1}),
        );
        assert_eq!(blocked("test-allowance", "account"), None);
        assert_eq!(blocked("unknown-provider", "unknown-account"), None);
    }
    #[test]
    fn exhausted_state_survives_disk_round_trip_with_unknown_reset() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = Registry {
            path: Some(dir.path().join("allowance.json")),
            ..Default::default()
        };
        let waiting = Waiting {
            provider: "codex".into(),
            instance: "account".into(),
            reset_at: None,
            observed_at: 123,
        };
        state
            .waiting
            .insert("codex/account".into(), waiting.clone());
        persist(&state).unwrap();
        let loaded: BTreeMap<String, Waiting> =
            serde_json::from_slice(&std::fs::read(state.path.unwrap()).unwrap()).unwrap();
        assert_eq!(loaded.get("codex/account"), Some(&waiting));
    }
}
