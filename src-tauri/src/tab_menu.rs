//! Native accelerators must target tabs before AppKit consumes Cmd+W as Close Window.
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem as Item, Submenu},
    Emitter,
};
pub(crate) fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(
                app,
                "new-session-tab",
                "New Session",
                true,
                Some("CmdOrCtrl+T"),
            )?,
            &MenuItem::with_id(
                app,
                "new-terminal-tab",
                "New Terminal",
                true,
                Some("Ctrl+Shift+`"),
            )?,
            &MenuItem::with_id(
                app,
                "new-files-tab",
                "Show Files",
                true,
                Some("CmdOrCtrl+Alt+F"),
            )?,
            &MenuItem::with_id(
                app,
                "close-active-tab",
                "Close Tab",
                true,
                Some("CmdOrCtrl+W"),
            )?,
            #[cfg(not(target_os = "macos"))]
            &Item::quit(app, None)?,
        ],
    )?;
    let session = Submenu::with_items(
        app,
        "Session",
        true,
        &[
            &MenuItem::with_id(
                app,
                "session-rename",
                "Rename",
                true,
                Some("CmdOrCtrl+Alt+R"),
            )?,
            &MenuItem::with_id(
                app,
                "session-pin",
                "Pin / Unpin",
                true,
                Some("CmdOrCtrl+Alt+P"),
            )?,
            &MenuItem::with_id(
                app,
                "session-archive",
                "Archive",
                true,
                Some("CmdOrCtrl+Shift+A"),
            )?,
        ],
    )?;
    let terminal = Submenu::with_items(
        app,
        "Terminal",
        true,
        &[
            &MenuItem::with_id(
                app,
                "toggle-terminal",
                "Toggle Terminal",
                true,
                Some("Ctrl+`"),
            )?,
            &MenuItem::with_id(
                app,
                "toggle-terminal-panel",
                "Toggle Panel",
                true,
                Some("CmdOrCtrl+J"),
            )?,
            &MenuItem::with_id(
                app,
                "split-terminal",
                "Split Terminal",
                true,
                Some("CmdOrCtrl+Backslash"),
            )?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &Item::undo(app, None)?,
            &Item::redo(app, None)?,
            &Item::separator(app)?,
            &Item::cut(app, None)?,
            &Item::copy(app, None)?,
            &Item::paste(app, None)?,
            &Item::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&Item::fullscreen(app, None)?])?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&Item::minimize(app, None)?, &Item::maximize(app, None)?],
    )?;
    let menu = Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "Brigadier",
                true,
                &[
                    &Item::about(app, None, None)?,
                    &Item::separator(app)?,
                    &Item::services(app, None)?,
                    &Item::separator(app)?,
                    &Item::hide(app, None)?,
                    &Item::hide_others(app, None)?,
                    &Item::separator(app)?,
                    &Item::quit(app, None)?,
                ],
            )?,
            &file,
            &edit,
            &session,
            &terminal,
            &view,
            &window,
        ],
    )?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if let Some(action) = event.id().as_ref().strip_prefix("session-") {
            let _ = app.emit("native-session-action", action);
            return;
        }
        let name = match event.id().as_ref() {
            "toggle-terminal" | "toggle-terminal-panel" => "native-toggle-terminal",
            "split-terminal" => "native-split-terminal",
            "close-active-tab" => "native-close-tab",
            "new-session-tab" => "native-new-session",
            "new-terminal-tab" => "native-new-terminal",
            "new-files-tab" => "native-new-files",
            _ => return,
        };
        let _ = app.emit(name, ());
    });
    Ok(())
}
