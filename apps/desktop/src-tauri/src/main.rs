//! Brigadier desktop shell.
//!
//! The React UI runs in the system webview. This process is its only link to `brigadierd`:
//! it launches the daemon detached, keeps an authenticated connection to it, and bridges
//! requests and the live event feed to the webview. It also owns the window, the menu-bar item
//! and the quit order.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod launcher;
mod shell;
mod smoke;

use std::sync::Arc;
use std::sync::Mutex;

use brigadier_ipc::app::{AppInfo, BridgeEvent, SmokeReport, UiMeasurements};
use brigadier_ipc::protocol::{IpcError, Request, Response};
use brigadier_sandbox::{Platform, PlatformOptions};
use tauri::ipc::Channel;
use tauri::{Manager, RunEvent, State, WindowEvent};

use crate::bridge::Bridge;
use crate::launcher::Launcher;

/// Environment variable carrying the timing tolerance (shared with the daemon).
const TOLERANCE_ENV: &str = "BRIGADIER_BUDGET_TOLERANCE";

pub struct AppState {
    pub bridge: Bridge,
    info: AppInfo,
    cold_start_ms: Mutex<Option<f64>>,
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    state.info.clone()
}

#[tauri::command]
async fn ipc_request(state: State<'_, AppState>, request: Request) -> Result<Response, IpcError> {
    state.bridge.request(request).await
}

#[tauri::command]
fn ipc_subscribe(state: State<'_, AppState>, channel: Channel<BridgeEvent>) {
    state.bridge.attach_ui(channel);
}

/// The webview painted its first interactive frame at `paint_ms` (ms since the Unix epoch).
/// Returns cold start: process start to that paint.
#[tauri::command]
fn app_ready(state: State<'_, AppState>, paint_ms: f64) -> f64 {
    let mut cold_start = state.cold_start_ms.lock().expect("cold start lock");
    *cold_start.get_or_insert(paint_ms - state.info.process_start_ms)
}

/// Completes the smoke check with the webview's measurements.
#[tauri::command]
async fn smoke_finish(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    measurements: UiMeasurements,
) -> Result<SmokeReport, IpcError> {
    if !state.info.smoke {
        return Err(IpcError {
            code: brigadier_ipc::protocol::ErrorCode::Invalid,
            message: "not running the smoke check".into(),
        });
    }
    let diagnostics = match state.bridge.request(Request::GetDiagnostics).await? {
        Response::GetDiagnostics { diagnostics } => diagnostics,
        _ => {
            return Err(IpcError {
                code: brigadier_ipc::protocol::ErrorCode::Internal,
                message: "unexpected response".into(),
            });
        }
    };
    let cold_start_ms = state
        .cold_start_ms
        .lock()
        .expect("cold start lock")
        .unwrap_or(f64::INFINITY);
    let report = smoke::evaluate(
        &state.info.platform,
        state.info.budget_tolerance,
        cold_start_ms,
        &measurements,
        &diagnostics,
    );
    smoke::finish(&app, &report);
    Ok(report)
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("BRIGADIER_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let smoke = std::env::args().any(|arg| arg == "--smoke");
    let platform = match brigadier_sandbox::native(PlatformOptions::default()) {
        Ok(platform) => platform,
        Err(err) => {
            eprintln!("brigadier: {err}");
            std::process::exit(1);
        }
    };
    let process_start_ms = platform
        .processes()
        .start_time_ms(std::process::id())
        .unwrap_or_else(|_| brigadier_core::now_ms() as f64);
    let budget_tolerance = std::env::var(TOLERANCE_ENV)
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 1.0)
        .unwrap_or(1.0);
    let info = AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        platform: platform.name().into(),
        process_start_ms,
        smoke,
        budget_tolerance,
    };
    // The daemon applies the same tolerance to its stall threshold.
    let daemon_env = std::env::var(TOLERANCE_ENV)
        .map(|value| vec![(TOLERANCE_ENV.to_owned(), value)])
        .unwrap_or_default();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            shell::show_main(app);
        }))
        .setup(move |app| {
            let launcher = Launcher::new(platform.clone(), daemon_env);
            let bridge = Bridge::start(platform.clone() as Arc<dyn Platform>, launcher);
            app.manage(AppState {
                bridge,
                info,
                cold_start_ms: Mutex::new(None),
            });
            // No menu-bar host (e.g. a bare Linux session) must not stop the app.
            if let Err(err) = shell::install_tray(app.handle()) {
                tracing::warn!(error = %err, "menu-bar item unavailable");
            }
            if smoke {
                smoke::start_watchdog(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == shell::MAIN_WINDOW
                && !shell::is_quitting()
            {
                // Closing the window keeps Brigadier running in the menu bar.
                api.prevent_close();
                shell::close_main(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            ipc_request,
            ipc_subscribe,
            app_ready,
            smoke_finish
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|err| {
            eprintln!("brigadier: failed to start: {err}");
            std::process::exit(1);
        });

    // `run_return` hands back the code passed to `app.exit`, so smoke failures reach CI.
    let code = app.run_return(|app, event| match event {
        // Cmd+Q and other user-initiated exits go through the orderly quit.
        RunEvent::ExitRequested { api, code, .. } if code.is_none() && !shell::is_quitting() => {
            api.prevent_exit();
            shell::quit(app, 0);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => shell::show_main(app),
        _ => {}
    });
    std::process::exit(code);
}
