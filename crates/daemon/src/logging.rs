use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::writer::MakeWriterExt;

/// Environment variable with a `tracing` filter, e.g. `brigadier=debug`.
const FILTER_ENV: &str = "BRIGADIER_LOG";
const KEPT_LOG_FILES: usize = 7;

/// Structured JSON logs in daily files under `logs_dir`, written by a background thread so
/// logging never blocks the runtime. In the foreground, logs also go to stderr.
pub fn init(logs_dir: &Path, foreground: bool) -> anyhow::Result<WorkerGuard> {
    std::fs::create_dir_all(logs_dir)?;
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("brigadierd")
        .filename_suffix("log")
        .max_log_files(KEPT_LOG_FILES)
        .build(logs_dir)?;
    let (file, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_env(FILTER_ENV).unwrap_or_else(|_| EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt()
        .json()
        .with_current_span(false)
        .with_thread_names(true)
        .with_env_filter(filter);
    if foreground {
        builder.with_writer(file.and(std::io::stderr)).init();
    } else {
        builder.with_writer(file).init();
    }

    // Panics anywhere (any thread, any task) are recorded before the default hook runs.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        tracing::error!(
            thread = thread.name().unwrap_or("unnamed"),
            panic = %info,
            "panic"
        );
        default_hook(info);
    }));
    Ok(guard)
}
