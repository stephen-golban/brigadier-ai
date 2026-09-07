//! Onboarding and the workspace share one fixed native window.
//! API and geometry evidence: docs/research/cosmic-bridge-native-2026-09-06.md.
use crate::{
    error::AppError,
    state::AppState,
    workbench_data::{self, Data},
};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{window::Color, Manager, State};

const WORKSPACE_COLOR: Color = Color(24, 24, 27, 255);

pub(crate) struct LaunchState {
    dir: PathBuf,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preferences {
    name: String,
    completed: bool,
    intro_seen: bool,
    music: bool,
}
fn preferences(data: &Data) -> Preferences {
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
    }
}
pub(crate) fn setup(app: &tauri::AppHandle, dir: PathBuf) -> Result<(), AppError> {
    app.manage(LaunchState { dir });
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::io("Main window unavailable"))?;
    // Configure the final window while it is still hidden. No onboarding action
    // may change its native style, backing surface, size, or position afterward.
    window
        .set_background_color(Some(WORKSPACE_COLOR))
        .map_err(native)?;
    if let Some(monitor) = window
        .current_monitor()
        .map_err(native)?
        .or(window.primary_monitor().map_err(native)?)
    {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let width = (area.size.width as f64 / scale - 100.).clamp(800., 1280.);
        let height = (area.size.height as f64 / scale - 100.).clamp(500., 800.);
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(native)?;
    }
    window.center().map_err(native)?;
    window.show().map_err(native)?;
    window.set_focus().map_err(native)?;
    Ok(())
}
fn native(e: tauri::Error) -> AppError {
    AppError::io(e.to_string())
}

fn reset_preferences(dir: &std::path::Path) -> Result<(), AppError> {
    workbench_data::launch_update(dir, |data| {
        data.display_name.clear();
        data.name_confirmed = false;
        data.welcome_completed = false;
        data.intro_seen = false;
        Ok(())
    })
}

/// Reset only onboarding data. The existing window and app process stay intact.
#[tauri::command]
pub(crate) fn launch_reset(state: State<'_, LaunchState>) -> Result<(), AppError> {
    reset_preferences(&state.dir)
}

#[tauri::command]
pub(crate) fn launch_preferences(state: State<'_, LaunchState>) -> Result<Preferences, AppError> {
    workbench_data::launch_update(&state.dir, |d| Ok(preferences(d)))
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
        Ok(preferences(d))
    })
}
#[tauri::command]
pub(crate) fn launch_restart(app: tauri::AppHandle) {
    app.request_restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reset_preserves_notes_and_unrelated_preferences() {
        let dir = tempfile::tempdir().unwrap();
        workbench_data::launch_update(dir.path(), |data| {
            data.display_name = "Stephen".into();
            data.name_confirmed = true;
            data.welcome_completed = true;
            data.intro_seen = true;
            data.launch_music = Some(false);
            data.notes.push(workbench_data::Note {
                id: "keep-note".into(),
                content: "Keep this note".into(),
                ..Default::default()
            });
            data.project_names
                .insert("project".into(), "My project".into());
            Ok(())
        })
        .unwrap();
        reset_preferences(dir.path()).unwrap();
        let saved = workbench_data::launch_update(dir.path(), |data| Ok(data.clone())).unwrap();
        assert!(saved.display_name.is_empty());
        assert!(!saved.name_confirmed && !saved.welcome_completed && !saved.intro_seen);
        assert_eq!(saved.launch_music, Some(false));
        assert_eq!(saved.notes[0].content, "Keep this note");
        assert_eq!(saved.project_names["project"], "My project");
    }
    #[test]
    fn completion_needs_an_explicit_valid_name() {
        let mut d = Data::default();
        d.display_name = "Mac User".into();
        d.welcome_completed = true;
        assert!(!preferences(&d).completed);
        d.name_confirmed = true;
        assert!(preferences(&d).completed);
        d.display_name = " \t ".into();
        assert!(!preferences(&d).completed);
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
        let p = preferences(&saved);
        assert!(p.completed && p.intro_seen);
        assert!(!p.music);
    }
    #[test]
    fn invalid_names_are_rejected() {
        for name in [
            "", " \t\n", "A\nB", "A\u{1c}", "A7", "A-B", "李 明", "Иван", "A💥",
        ] {
            assert!(workbench_data::validate_name(name).is_err());
        }
        assert_eq!(
            workbench_data::validate_name("  Ștefan José  ").unwrap(),
            "Ștefan José"
        );
    }
}
