//! Window, menu-bar item and quit ordering.
//!
//! Closing the window hides it (and the Dock icon on macOS); the app and `brigadierd` keep
//! running in the menu bar. Quit (menu-bar item, Cmd+Q or a system quit) asks the daemon to
//! drain and exit, waits for its acknowledgement, then exits the app.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use brigadier_ipc::app::BridgeEvent;
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::AppState;

pub const MAIN_WINDOW: &str = "main";
/// Longest the app waits for the daemon to acknowledge a quit.
const QUIT_TIMEOUT: Duration = Duration::from_secs(5);

static QUITTING: AtomicBool = AtomicBool::new(false);
static IN_MENU_BAR: AtomicBool = AtomicBool::new(false);

pub fn is_quitting() -> bool {
    QUITTING.load(Ordering::Acquire)
}

pub fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_item = MenuItemBuilder::with_id("open", "Open Brigadier").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit Brigadier").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open_item)
        .separator()
        .item(&quit_item)
        .build()?;
    TrayIconBuilder::with_id("brigadier")
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("Brigadier")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => quit(app, 0),
            _ => {}
        })
        .build(app)?;
    IN_MENU_BAR.store(true, Ordering::Release);
    Ok(())
}

/// Closing the window hides it when the menu-bar item can bring it back; without one (a
/// desktop with no tray host) closing quits.
pub fn close_main(app: &AppHandle) {
    if IN_MENU_BAR.load(Ordering::Acquire) {
        hide_main(app);
    } else {
        quit(app, 0);
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

pub fn show_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    notify_visibility(app, true);
}

pub fn hide_main(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.hide();
    }
    // A menu-bar app has no Dock icon while its window is closed.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    notify_visibility(app, false);
}

fn notify_visibility(app: &AppHandle, visible: bool) {
    if let Some(state) = app.try_state::<AppState>() {
        state.bridge.emit(BridgeEvent::WindowVisibility { visible });
    }
}

/// Orderly quit: the daemon drains and acknowledges, then the app exits with `code`.
pub fn quit(app: &AppHandle, code: i32) {
    if QUITTING.swap(true, Ordering::AcqRel) {
        return;
    }
    if let Some(window) = main_window(app) {
        let _ = window.hide();
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        stop_daemon(&app).await;
        app.exit(code);
    });
}

/// The process is already exiting without an orderly quit: on macOS, `terminate:` (the app
/// menu's Quit, the Dock, AppleScript, logout) skips `ExitRequested` and only surfaces as
/// `RunEvent::Exit`. Runs the same drain-and-acknowledge before the process goes away.
pub fn quit_on_exit(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::block_on(stop_daemon(app));
}

async fn stop_daemon(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let bridge = state.bridge.clone();
    if bridge.shutdown_daemon(QUIT_TIMEOUT).await {
        tracing::info!("brigadierd drained and acknowledged the quit");
    } else {
        tracing::warn!("brigadierd did not acknowledge the quit");
    }
}
