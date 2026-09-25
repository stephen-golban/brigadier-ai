//! Brigadier desktop shell.
//!
//! The React UI runs in the system webview. This process is its only link to `brigadierd`:
//! it launches the daemon detached, keeps an authenticated connection to it, and bridges
//! requests and the live event feed to the webview. It also owns the window, the menu-bar item
//! and the quit order.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod browser;
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
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

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

/// Asks for a folder with the system picker; `None` when the user cancels. The dialog plugin
/// is used from here only: the webview gets no dialog permissions of its own.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, starting: Option<String>) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Choose a folder");
    if let Some(window) = app.get_webview_window(shell::MAIN_WINDOW) {
        dialog = dialog.set_parent(&window);
    }
    if let Some(starting) = starting.filter(|dir| std::path::Path::new(dir).is_dir()) {
        dialog = dialog.set_directory(starting);
    }
    dialog.pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    let folder = rx.await.ok().flatten()?.into_path().ok()?;
    Some(folder.display().to_string())
}

/// Saves an artifact where the user picks in the system save dialog, offering `file_name`.
/// `false` when they cancel. Scripts use the `saveArtifact` request with a path instead.
#[tauri::command]
async fn save_artifact(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    file_name: String,
) -> Result<bool, IpcError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save to…")
        .set_file_name(&file_name);
    if let Some(window) = app.get_webview_window(shell::MAIN_WINDOW) {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx
        .await
        .ok()
        .flatten()
        .and_then(|path| path.into_path().ok())
    else {
        return Ok(false);
    };
    state
        .bridge
        .request(Request::SaveArtifact {
            id,
            path: path.display().to_string(),
        })
        .await?;
    Ok(true)
}

/// Opens an artifact with the system's default app for its type (a copy of it, named
/// `file_name`).
#[tauri::command]
async fn open_artifact(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    file_name: String,
) -> Result<(), IpcError> {
    let internal = |message: String| IpcError {
        code: brigadier_ipc::protocol::ErrorCode::Internal,
        message,
    };
    let Response::OpenArtifact { path } = state
        .bridge
        .request(Request::OpenArtifact { id, file_name })
        .await?
    else {
        return Err(internal("unexpected response".into()));
    };
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|err| internal(format!("could not open it: {err}")))
}

/// Opens a folder (a session's working directory) in the system file manager, or with the
/// app named `with` ("Terminal" on macOS).
#[tauri::command]
fn open_folder(app: tauri::AppHandle, path: String, with: Option<String>) -> Result<(), IpcError> {
    app.opener()
        .open_path(path, with.as_deref())
        .map_err(|err| IpcError {
            code: brigadier_ipc::protocol::ErrorCode::Internal,
            message: format!("could not open it: {err}"),
        })
}

/// Opens a web link in the user's browser. Only http and https: the thread's links come from
/// models and must not launch other handlers.
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), IpcError> {
    let invalid = |message: String| IpcError {
        code: brigadier_ipc::protocol::ErrorCode::Invalid,
        message,
    };
    let scheme = url
        .split_once(':')
        .map(|(scheme, _)| scheme.to_ascii_lowercase());
    if !matches!(scheme.as_deref(), Some("http" | "https")) {
        return Err(invalid(format!("only web links open: {url}")));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| IpcError {
            code: brigadier_ipc::protocol::ErrorCode::Internal,
            message: format!("could not open it: {err}"),
        })
}

/// Shows a file (a file link in an answer) selected in the system file manager.
#[tauri::command]
fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), IpcError> {
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|err| IpcError {
            code: brigadier_ipc::protocol::ErrorCode::Internal,
            message: format!("could not show it: {err}"),
        })
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
        // A new page in the app's webview knows none of the Browser tabs' pages: drop them.
        .on_page_load(|webview, payload| {
            if webview.label() == shell::MAIN_WINDOW
                && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                let _ = webview.app_handle().run_on_main_thread(browser::close_all);
            }
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
            smoke_finish,
            pick_folder,
            save_artifact,
            open_artifact,
            open_folder,
            open_url,
            reveal_path,
            browser::browser_open,
            browser::browser_navigate,
            browser::browser_place,
            browser::browser_go,
            browser::browser_close
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|err| {
            eprintln!("brigadier: failed to start: {err}");
            std::process::exit(1);
        });

    app.run_return(|app, event| match event {
        // Cmd+Q and other user-initiated exits go through the orderly quit.
        RunEvent::ExitRequested { api, code, .. } if code.is_none() && !shell::is_quitting() => {
            api.prevent_exit();
            shell::quit(app, 0);
        }
        RunEvent::Exit => shell::quit_on_exit(app),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => shell::show_main(app),
        _ => {}
    });
    // The code the quit asked for, so smoke failures reach CI.
    std::process::exit(shell::exit_code());
}
