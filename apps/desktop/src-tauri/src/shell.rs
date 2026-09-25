//! Window, menu-bar item and quit ordering.
//!
//! Closing the window hides it (and the Dock icon on macOS); the app and `brigadierd` keep
//! running in the menu bar. Quit (menu-bar item, Cmd+Q or a system quit) asks the daemon to
//! drain and exit, waits for its acknowledgement, then exits the app.

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::Duration;

use brigadier_ipc::app::{BridgeEvent, RunningChat};
use tauri::image::Image;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::AppState;

pub const MAIN_WINDOW: &str = "main";
const TRAY: &str = "brigadier";
/// Menu ids of the "Running" list's items: this, then the conversation's id.
const RUNNING_ITEM: &str = "running:";
/// Longest title the "Running" list shows before cutting it with "…".
const RUNNING_TITLE_CHARS: usize = 48;
/// Longest the app waits for the daemon to acknowledge a quit. Covers the daemon's bounded
/// ending of CLI sessions (exit grace, process-group reap, last events stored) before its
/// store drains; the daemon finishes quitting on its own if this runs out.
const QUIT_TIMEOUT: Duration = Duration::from_secs(10);

static QUITTING: AtomicBool = AtomicBool::new(false);
static IN_MENU_BAR: AtomicBool = AtomicBool::new(false);
/// The code the process exits with once the event loop returns. Tauri's runtime turns
/// `app.exit(code)` into a plain exit, so the event loop itself always reports 0.
static EXIT_CODE: AtomicI32 = AtomicI32::new(0);

pub fn is_quitting() -> bool {
    QUITTING.load(Ordering::Acquire)
}

pub fn exit_code() -> i32 {
    EXIT_CODE.load(Ordering::Acquire)
}

/// The menu-bar item's menu: open, the conversations running now (ChatGPT's "Running"), quit.
fn tray_menu(app: &AppHandle, running: &[RunningChat]) -> tauri::Result<Menu<tauri::Wry>> {
    let open_item = MenuItemBuilder::with_id("open", "Open Brigadier").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit Brigadier").build(app)?;
    let mut menu = MenuBuilder::new(app).item(&open_item).separator();
    if !running.is_empty() {
        let heading = MenuItemBuilder::with_id("running", "Running")
            .enabled(false)
            .build(app)?;
        menu = menu.item(&heading);
        for chat in running {
            let title = if chat.title.chars().count() > RUNNING_TITLE_CHARS {
                let cut: String = chat.title.chars().take(RUNNING_TITLE_CHARS - 1).collect();
                format!("{}…", cut.trim_end())
            } else {
                chat.title.clone()
            };
            let item =
                MenuItemBuilder::with_id(format!("{RUNNING_ITEM}{}", chat.id), title).build(app)?;
            menu = menu.item(&item);
        }
        menu = menu.separator();
    }
    menu.item(&quit_item).build()
}

/// Lists `running` under "Running" in the menu-bar item's menu.
pub fn set_running(app: &AppHandle, running: &[RunningChat]) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY) else {
        return Ok(());
    };
    tray.set_menu(Some(tray_menu(app, running)?))
}

pub fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app, &[])?;
    TrayIconBuilder::with_id(TRAY)
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("Brigadier")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => quit(app, 0),
            id => {
                if let Some(conversation_id) = id.strip_prefix(RUNNING_ITEM) {
                    show_main(app);
                    if let Some(state) = app.try_state::<AppState>() {
                        state.bridge.emit(BridgeEvent::OpenConversation {
                            conversation_id: conversation_id.to_owned(),
                        });
                    }
                }
            }
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
    EXIT_CODE.store(code, Ordering::Release);
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
