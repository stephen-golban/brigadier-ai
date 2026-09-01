//! brigadier — desktop harness for supervising coding-agent CLI sessions.
//!
//! Nothing is wired yet. This builds and opens one empty window. The supervisor,
//! the project sidebar, the SQLite store and the Node sidecar (see `sidecar/`)
//! are all still to come.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
