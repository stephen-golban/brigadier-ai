//! Bounded local frontend diagnostics; no conversation payloads or remote telemetry.
use std::io::Write;
use tauri::Manager;

static WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command]
pub(crate) async fn report_frontend_error(
    app: tauri::AppHandle,
    message: String,
    stack: String,
) -> Result<(), String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("frontend-errors.ndjson");
        let full = path.metadata().is_ok_and(|m| m.len() >= 256 * 1024);
        let mut file = std::fs::OpenOptions::new().create(true).write(true)
            .append(!full).truncate(full).open(path)?;
        let record = serde_json::json!({
            "at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
            "message": message.chars().take(2000).collect::<String>(),
            "stack": stack.chars().take(8000).collect::<String>(),
        });
        writeln!(file, "{record}")?;
        file.flush()
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}
