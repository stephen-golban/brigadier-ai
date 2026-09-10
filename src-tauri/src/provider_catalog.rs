//! Selectable providers come from registered adapters, never guessed model families.
use crate::{error::AppError, state::AppState};
use serde::Serialize;
use tauri::{Emitter, State};

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

/// Set for as long as one background refresh is in flight, so a composer that reads the catalogue
/// on mount, on focus and on its retry timer queues one refresh rather than four.
static REFRESHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// When the last background refresh finished. `None` until one has.
static LAST_REFRESH: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
/// The cycle this breaks: a finished refresh emits [`REFRESHED_EVENT`], the client re-reads on it,
/// and **every** read asks for a refresh — which would re-spawn `codex` and the Claude handshake
/// forever, with nobody watching. The event-driven re-read lands milliseconds after the emit, well
/// inside this window, so it starts nothing; a window `focus` seconds later still refreshes.
const REFRESH_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(2);
/// Records the finish time and clears [`REFRESHING`] even if the refresh panics; a stuck flag
/// would freeze the catalogue at whatever the cache held for the rest of the launch.
struct RefreshGuard;
impl Drop for RefreshGuard {
    fn drop(&mut self) {
        if let Ok(mut last) = LAST_REFRESH.lock() {
            *last = Some(std::time::Instant::now());
        }
        REFRESHING.store(false, std::sync::atomic::Ordering::Release);
    }
}
/// `Some` for the caller that won the claim, `None` while another refresh holds it or one finished
/// less than `cooldown` ago. Written as an `if` rather than `bool::then_some`, which would
/// construct the guard on the losing branch and then drop it — clearing the winner's flag.
fn claim_refresh_after(cooldown: std::time::Duration) -> Option<RefreshGuard> {
    let cooling = LAST_REFRESH
        .lock()
        .ok()
        .and_then(|last| *last)
        .is_some_and(|at| at.elapsed() < cooldown);
    if cooling || REFRESHING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        None
    } else {
        Some(RefreshGuard)
    }
}
fn claim_refresh() -> Option<RefreshGuard> {
    claim_refresh_after(REFRESH_COOLDOWN)
}

/// Discovery runs **behind** the answer, never in front of it.
///
/// A cold Claude capability cache costs a full CLI handshake — spawn → `initialize` response
/// **719 ms** measured, `docs/STATUS.md` §4, plus the teardown — and every launch starts cold,
/// because the cache is an in-process
/// `OnceLock` (`crates/core/src/claude/capabilities.rs`). Awaiting it here made the composer's
/// first read resolve after the preferences it is checked against, which is the false
/// "execution settings are unavailable" banner in `docs/research/execution-settings-banner.md`.
/// The caller re-reads, and [`REFRESHED_EVENT`] is what tells it when: without it the hook's
/// bounded retry can spend its budget before the handshake lands and settle on an empty
/// catalogue, with nothing to wake it but a window `focus` the user never generates at launch.
/// `orchestration::discover` keeps its own global mutex.
fn refresh_behind_the_answer(app: tauri::AppHandle, supervisor: brigadier_supervisor::Supervisor) {
    let Some(guard) = claim_refresh() else { return };
    tauri::async_runtime::spawn(async move {
        // Declared before the guard so it drops **after** it: the flag is clear and the cooldown
        // stamped before the client is told to look again. The emit says "discovery is no longer
        // running", never "discovery succeeded" — the client re-reads and judges the payload for
        // itself — and it is a `Drop` so an unwind still wakes it.
        let _emit = EmitOnDrop(app);
        let _guard = guard;
        if let Err(error) = brigadier_supervisor::orchestration::discover(&supervisor).await {
            tracing::debug!(%error,"Connected model discovery incomplete; retaining observations");
        }
        for driver in supervisor.registered_drivers() {
            if driver.kind().as_str() != "codex" {
                continue;
            }
            // Unconditional, unlike `discover`: this is also how the Codex usage window is
            // re-read, so it must run even when the model list is already cached.
            let Some(binary) = driver.describe().binary_path else {
                continue;
            };
            if let Err(error) = brigadier_core::codex::capabilities::refresh(
                &binary,
                driver.instance_id().as_str(),
            )
            .await
            {
                tracing::debug!(%error,"Codex catalog refresh unavailable; retaining last observation");
            }
        }
    });
}

/// Emitted from the app handle when a background refresh finishes, success or failure. The
/// composer's catalogue hook (`src/providerCatalog.ts`) listens for it and re-reads regardless of
/// its retry budget.
pub(crate) const REFRESHED_EVENT: &str = "provider-catalog-refreshed";

/// The emit is a `Drop` for the same reason [`RefreshGuard`] is: a refresh that unwinds must still
/// wake the client, or the catalogue stays empty until the user focuses the window.
struct EmitOnDrop(tauri::AppHandle);
impl Drop for EmitOnDrop {
    fn drop(&mut self) {
        let _ = self.0.emit(REFRESHED_EVENT, ());
    }
}

#[tauri::command]
pub(crate) async fn provider_catalog(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<ProviderCatalogEntry>, AppError> {
    refresh_behind_the_answer(app, state.get()?.supervisor.clone());
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
        // The Codex refresh spawns the `codex` binary; it belongs behind the answer with
        // discovery, not in front of it. This read is the cache it fills.
        let codex = driver.kind().as_str() == "codex";
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `REFRESHING` and `LAST_REFRESH` are process-global; the harness runs these two in parallel
    /// threads by default, where one test's held claim is the other's "not idle".
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// The composer reads this command on mount, on window focus, on a retry timer and on
    /// [`REFRESHED_EVENT`]. Each read asks for a refresh; only one may run, and the flag must come
    /// back even so. `Duration::ZERO` takes the cooldown out of the way — it is the subject of the
    /// next test, and the two share process-global state.
    #[test]
    fn one_refresh_runs_at_a_time_and_the_claim_is_returned() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let first = claim_refresh_after(std::time::Duration::ZERO)
            .expect("an idle catalog hands out the claim");
        assert!(
            claim_refresh_after(std::time::Duration::ZERO).is_none(),
            "a second read must not start a second discovery"
        );
        drop(first);
        assert!(
            claim_refresh_after(std::time::Duration::ZERO).is_some(),
            "the claim must return once the refresh is done, or the catalog freezes"
        );
    }

    /// The feedback loop: a finished refresh emits `provider-catalog-refreshed`, the client
    /// re-reads, and the re-read asks for a refresh. Without the cooldown that is unbounded, and
    /// each turn of it spawns the `codex` binary.
    #[test]
    fn a_refresh_that_just_finished_does_not_start_another() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        drop(claim_refresh_after(std::time::Duration::ZERO).expect("idle catalog"));
        assert!(
            claim_refresh().is_none(),
            "the event-driven re-read must not start a second discovery, or the loop never ends"
        );
    }
}
