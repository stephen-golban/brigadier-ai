//! Launch choreography owns one transparent window; app state initializes independently.
//! API and geometry evidence: docs/research/cosmic-bridge-native-2026-09-06.md.
use crate::{
    error::AppError,
    state::AppState,
    workbench_data::{self, Data},
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{window::Color, Manager, State};

const COVER: &str = "launch-cover";
const WORKSPACE_COLOR: Color = Color(24, 24, 27, 255);

pub(crate) struct LaunchState {
    dir: PathBuf,
    desktop_reveal: AtomicBool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preferences {
    name: String,
    completed: bool,
    intro_seen: bool,
    music: bool,
    desktop_reveal: bool,
}
fn preferences(data: &Data, desktop_reveal: bool) -> Preferences {
    let name = if data.name_confirmed {
        workbench_data::validate_name(&data.display_name).unwrap_or_default()
    } else {
        String::new()
    };
    Preferences {
        completed: data.welcome_completed && !name.is_empty(),
        name,
        intro_seen: data.intro_seen,
        music: data.launch_music.unwrap_or(true),
        desktop_reveal,
    }
}
pub(crate) fn setup(app: &tauri::AppHandle, dir: PathBuf) -> Result<(), AppError> {
    let prefs = workbench_data::launch_update(&dir, |d| Ok(preferences(d, false)));
    let reveal = prefs.as_ref().is_ok_and(|p| !p.completed);
    app.manage(LaunchState {
        dir,
        desktop_reveal: AtomicBool::new(false),
    });
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::io("Main window unavailable"))?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            let _ = discard_cover(&handle);
        }
    });
    let mut desktop_reveal = false;
    if reveal {
        if let Some(monitor) = window
            .current_monitor()
            .map_err(native)?
            .or(window.primary_monitor().map_err(native)?)
        {
            // The backdrop covers the display, including the wallpaper behind the Dock.
            // work_area() is reserved for the normal workspace window below.
            window.set_decorations(false).map_err(native)?;
            window.set_shadow(false).map_err(native)?;
            window.set_resizable(false).map_err(native)?;
            window.set_size(*monitor.size()).map_err(native)?;
            window.set_position(*monitor.position()).map_err(native)?;
            desktop_reveal = true;
        }
    }
    app.state::<LaunchState>()
        .desktop_reveal
        .store(desktop_reveal, Ordering::Release);
    if !desktop_reveal {
        restore(&window, false)?;
        window
            .set_background_color(Some(WORKSPACE_COLOR))
            .map_err(native)?;
    }
    window.show().map_err(native)?;
    window.set_focus().map_err(native)?;
    Ok(())
}
fn native(e: tauri::Error) -> AppError {
    AppError::io(e.to_string())
}
fn restore(window: &tauri::WebviewWindow, position: bool) -> Result<(), AppError> {
    restore_controls(window)?;
    restore_geometry(window, position)
}
fn restore_controls(window: &tauri::WebviewWindow) -> Result<(), AppError> {
    // Tao captures resizable in its queued decoration mask. Set it first or that
    // mask later disables the green button again. See intro-window-controls research.
    window.set_resizable(true).map_err(native)?;
    window.set_decorations(true).map_err(native)?;
    window.set_shadow(true).map_err(native)?;
    Ok(())
}
fn restore_geometry(window: &tauri::WebviewWindow, position: bool) -> Result<(), AppError> {
    if let Some(monitor) = window
        .current_monitor()
        .map_err(native)?
        .or(window.primary_monitor().map_err(native)?)
    {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let width = (area.size.width as f64 / scale - 100.).min(1280.).max(600.);
        let height = (area.size.height as f64 / scale - 100.).min(800.).max(400.);
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(native)?;
        if position {
            // Decorations have settled before this handoff branch runs. Keep the
            // content centered on the display, matching the intro's visible card.
            let inner = window.inner_position().map_err(native)?;
            let outer = window.outer_position().map_err(native)?;
            let titlebar = (inner.y - outer.y).max(0);
            window
                .set_position(tauri::PhysicalPosition::new(
                    monitor.position().x
                        + ((monitor.size().width as f64 - width * scale) / 2.) as i32,
                    monitor.position().y
                        + ((monitor.size().height as f64 - height * scale) / 2.) as i32
                        - titlebar,
                ))
                .map_err(native)?;
        } else {
            window.center().map_err(native)?;
        }
    }
    Ok(())
}
fn after_native_updates(work: impl FnOnce() + Send + 'static) {
    // run_on_main_thread alone is not a barrier: Tao queues NSWindow setters even
    // when invoked on that thread. GCD FIFO ordering lets their changes apply first.
    #[cfg(target_os = "macos")]
    dispatch2::DispatchQueue::main().exec_async(work);
    #[cfg(not(target_os = "macos"))]
    work();
}
fn create_cover(
    app: &tauri::AppHandle,
    main: &tauri::WebviewWindow,
) -> Result<tauri::Window, AppError> {
    let scale = main.scale_factor().map_err(native)?;
    let size = main.inner_size().map_err(native)?;
    let origin = main.inner_position().map_err(native)?;
    let width = (size.width as f64 / scale - 100.).min(1280.);
    let height = (size.height as f64 / scale - 100.).min(800.);
    // A native, opaque NSWindow has its own backing surface. A DOM cover inside
    // the resizing WKWebView cannot protect against that webview being invalidated.
    // No webview is created here, so the cover has no asynchronous page load.
    let cover = tauri::WindowBuilder::new(app, COVER)
        .title("Brigadier transition")
        .visible(false)
        .decorations(false)
        .transparent(false)
        .background_color(WORKSPACE_COLOR)
        .shadow(false)
        .resizable(false)
        .focusable(false)
        .focused(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .inner_size(width, height)
        .build()
        .map_err(native)?;
    // An independent cover stays still when main moves; a child window would move
    // with its parent. Physical coordinates preserve placement across display scales.
    cover
        .set_position(tauri::PhysicalPosition::new(
            origin.x + ((size.width as f64 - width * scale) / 2.) as i32,
            origin.y + ((size.height as f64 - height * scale) / 2.) as i32,
        ))
        .map_err(native)?;
    Ok(cover)
}

fn discard_cover(app: &tauri::AppHandle) -> Result<(), AppError> {
    if let Some(cover) = app.get_window(COVER) {
        cover.destroy().map_err(native)?;
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn launch_preferences(state: State<'_, LaunchState>) -> Result<Preferences, AppError> {
    workbench_data::launch_update(&state.dir, |d| {
        Ok(preferences(d, state.desktop_reveal.load(Ordering::Acquire)))
    })
}
#[derive(Serialize)]
pub(crate) struct Status {
    ready: bool,
    error: Option<String>,
}
#[tauri::command]
pub(crate) fn launch_status(state: State<'_, AppState>) -> Status {
    match state.get() {
        Ok(_) => Status {
            ready: true,
            error: None,
        },
        Err(e) if e.code == "startup_pending" => Status {
            ready: false,
            error: None,
        },
        Err(e) => Status {
            ready: false,
            error: Some(e.message),
        },
    }
}
#[tauri::command]
pub(crate) fn launch_seen(state: State<'_, LaunchState>) -> Result<(), AppError> {
    workbench_data::launch_update(&state.dir, |d| {
        d.intro_seen = true;
        Ok(())
    })
}
#[tauri::command]
pub(crate) fn launch_music(music: bool, state: State<'_, LaunchState>) -> Result<(), AppError> {
    workbench_data::launch_update(&state.dir, |d| {
        d.launch_music = Some(music);
        Ok(())
    })
}
#[tauri::command]
pub(crate) fn launch_complete(
    name: String,
    state: State<'_, LaunchState>,
) -> Result<Preferences, AppError> {
    let name = workbench_data::validate_name(&name)?;
    workbench_data::launch_update(&state.dir, |d| {
        d.display_name = name;
        d.name_confirmed = true;
        d.intro_seen = true;
        d.welcome_completed = true;
        Ok(preferences(d, state.desktop_reveal.load(Ordering::Acquire)))
    })
}
#[tauri::command]
pub(crate) async fn launch_finish(app: tauri::AppHandle) -> Result<(), AppError> {
    let state = app.state::<LaunchState>();
    let completed =
        workbench_data::launch_update(&state.dir, |d| Ok(preferences(d, false).completed))?;
    if !completed {
        return Err(AppError::invalid_argument("Enter your name to continue"));
    }
    app.state::<AppState>().get()?;
    if !state.desktop_reveal.load(Ordering::Acquire) {
        return Ok(());
    }
    let handle = app.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("main") else {
            let _ = tx.send(Err(AppError::io("Main window unavailable")));
            return;
        };
        let cover = match create_cover(&handle, &window) {
            Ok(cover) => cover,
            Err(error) => {
                let _ = discard_cover(&handle);
                let _ = tx.send(Err(error));
                return;
            }
        };
        after_native_updates(move || {
            if let Err(error) = cover
                .show()
                .map_err(native)
                .and_then(|_| restore_controls(&window))
            {
                let _ = discard_cover(&handle);
                let _ = tx.send(Err(error));
                return;
            }
            after_native_updates(move || {
                if let Err(error) = restore_geometry(&window, true) {
                    let _ = discard_cover(&handle);
                    let _ = tx.send(Err(error));
                    return;
                }
                after_native_updates(move || {
                    // Main no longer needs transparency once the desktop intro is over.
                    // Its native backing color also protects subsequent workspace repaints.
                    let result = window
                        .set_background_color(Some(WORKSPACE_COLOR))
                        .map_err(native);
                    if result.is_ok() {
                        handle
                            .state::<LaunchState>()
                            .desktop_reveal
                            .store(false, Ordering::Release);
                    }
                    if result.is_err() {
                        let _ = discard_cover(&handle);
                    }
                    let _ = tx.send(result);
                });
            });
        });
    })
    .map_err(native)?;
    rx.await.map_err(|e| AppError::io(e.to_string()))?
}
#[tauri::command]
pub(crate) async fn launch_reveal(app: tauri::AppHandle) -> Result<(), AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = discard_cover(&handle);
        // Acknowledge only after the native cover removal has applied. The renderer
        // retains its solid surface until then, so the fade starts at full opacity.
        after_native_updates(move || {
            let _ = tx.send(result);
        });
    })
    .map_err(native)?;
    rx.await.map_err(|e| AppError::io(e.to_string()))?
}
#[tauri::command]
pub(crate) fn launch_restart(app: tauri::AppHandle) {
    app.request_restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completion_needs_an_explicit_valid_name() {
        let mut d = Data::default();
        d.display_name = "macos-user".into();
        d.welcome_completed = true;
        assert!(!preferences(&d, false).completed);
        d.name_confirmed = true;
        assert!(preferences(&d, false).completed);
        d.display_name = " \t ".into();
        assert!(!preferences(&d, false).completed);
    }
    #[test]
    fn preferences_persist_without_overwriting_unrelated_settings() {
        let dir = tempfile::tempdir().unwrap();
        workbench_data::launch_update(dir.path(), |d| {
            d.project_names.insert("p".into(), "Project".into());
            d.intro_seen = true;
            d.launch_music = Some(false);
            Ok(())
        })
        .unwrap();
        workbench_data::launch_update(dir.path(), |d| {
            d.display_name = workbench_data::validate_name("  Stephen  ")?;
            d.name_confirmed = true;
            d.welcome_completed = true;
            Ok(())
        })
        .unwrap();
        let saved = workbench_data::launch_update(dir.path(), |d| Ok(d.clone())).unwrap();
        assert_eq!(saved.project_names["p"], "Project");
        assert_eq!(saved.display_name, "Stephen");
        let p = preferences(&saved, false);
        assert!(p.completed && p.intro_seen);
        assert!(!p.music);
    }
    #[test]
    fn invalid_names_are_rejected() {
        for name in ["", " \t\n", "A\nB"] {
            assert!(workbench_data::validate_name(name).is_err());
        }
        assert_eq!(workbench_data::validate_name("  李 明  ").unwrap(), "李 明");
    }
}
