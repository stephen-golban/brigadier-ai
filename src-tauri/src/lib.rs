//! brigadier — desktop harness for supervising coding-agent CLI sessions.
//!
//! This crate is the Tauri layer and nothing else. The supervisor, the store, the process
//! tracker and the Claude driver all live in `crates/` with no Tauri dependency; what is here is
//! the wiring: managed state (`state`), the IPC surface (`commands`), the two adapters that
//! join the seams (`sink`, `tracker`), and the exit hook that stops this app from orphaning
//! children.
//!
//! Three facts from `docs/research/tauri-commands.md` decide the shape of [`run`]:
//!
//! - `Builder::setup` returning `Err` **panics the process** (§4.1). Everything fallible in
//!   startup is therefore caught and turned into a managed error state that every command
//!   reports; there is no `?` in `setup`.
//! - `Builder::run(context)` is `self.build(context)?.run(|_, _| {})` — it discards every
//!   `RunEvent` (§5). The kill sweep has nowhere to hang without `.build()?.run(|h, e| …)`.
//! - macOS ⌘Q reaches `RunEvent::Exit` **without** `RunEvent::ExitRequested` (§12): AppKit's
//!   `applicationWillTerminate:` calls tao's `AppState::exit`, which emits `LoopDestroyed`
//!   directly and no window is ever destroyed. So the graceful shutdown hangs off *both* arms
//!   and is idempotent, rather than off `ExitRequested` alone.

#![deny(unsafe_code)]

#[cfg(any(debug_assertions, feature = "burn"))]
mod burn;
mod commands;
mod error;
mod sink;
mod state;
mod tracker;
mod views;

use std::time::Duration;

use brigadier_proc::DEFAULT_GRACE;
use tauri::{Manager, RunEvent};

use crate::state::AppState;

/// How long the exit hook gives a process group between `SIGTERM` and `SIGKILL`.
///
/// 400 ms, from `brigadier_proc`. It is spent twice at worst — once on `ExitRequested` with the
/// window still on screen, once on `Exit` with nothing on screen — and both passes signal every
/// group before waiting on any of them, so the cost is one grace period per pass, not one per
/// session. On the ⌘Q path only the `Exit` pass exists, and it pays it once.
const EXIT_GRACE: Duration = DEFAULT_GRACE;

/// Build the app, wire every command, and run the event loop. Never returns.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::probe_claude,
            commands::list_models,
            commands::list_projects,
            commands::add_project,
            commands::list_sessions,
            commands::start_session,
            commands::send_turn,
            commands::respond,
            commands::interrupt,
            commands::end_session,
            commands::kill,
            commands::feed_tail,
            commands::pending_approvals,
            commands::subscribe_feed,
            commands::set_visible_projects,
            commands::record_frame_stats,
            commands::burn,
        ])
        .setup(|app| {
            // `setup` runs on `RuntimeRunEvent::Ready`, after the window exists, on the main
            // thread — which is *not* a runtime thread, so `block_on` is legal here and is what
            // `Supervisor::new` needs (it spawns the per-frame flusher).
            // see docs/research/tauri-commands.md §4.1 and §5.
            let data_dir = match app.path().app_local_data_dir() {
                Ok(dir) => dir,
                Err(e) => {
                    let msg = format!("no application data directory: {e}");
                    tracing::error!("{msg}");
                    app.manage(AppState::failed(msg));
                    return Ok(());
                }
            };
            match tauri::async_runtime::block_on(state::build(data_dir)) {
                Ok(ready) => {
                    tracing::info!(?ready, "brigadier started");
                    app.manage(AppState::ready(ready));
                }
                Err(msg) => {
                    // Never `?`: an Err out of `setup` panics the process, and a read-only home
                    // directory must produce a window that says so.
                    tracing::error!("{msg}");
                    app.manage(AppState::failed(msg));
                }
            }
            // A terminal's `kill -TERM` (or ctrl-C on `tauri dev`) does not raise any `RunEvent`
            // at all — measured: the exit hook below runs no code — so the sessions are lost and
            // the next launch marks them failed. Route both signals into `AppHandle::exit`, which
            // does raise them.
            spawn_signal_hook(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|handle, event| match event {
            // The last window closed, or `AppHandle::exit` was called. The window is still on
            // screen: end the sessions and signal their groups, bounded.
            RunEvent::ExitRequested { .. } => {
                if let Some(state) = handle.try_state::<AppState>() {
                    state.shutdown_sync("ExitRequested", EXIT_GRACE);
                }
            }
            // The only arm macOS ⌘Q reaches (§12). So the graceful shutdown runs here too —
            // idempotent, so the paths that came through `ExitRequested` pay nothing for it —
            // and then the backstop kill and the last store flush. Blocking here is legal and is
            // the point: nothing is on screen any more.
            RunEvent::Exit => {
                if let Some(state) = handle.try_state::<AppState>() {
                    state.shutdown_sync("Exit", EXIT_GRACE);
                    state.final_sweep(EXIT_GRACE);
                }
            }
            _ => {}
        });
}

/// Turn `SIGTERM` and `SIGINT` into a normal quit.
///
/// `AppHandle::exit(code)` is documented as *"Exits the app by triggering [`RunEvent::ExitRequested`]
/// and [`RunEvent::Exit`]"* (`tauri-2.11.5/src/app.rs:573-580`); it calls
/// `RuntimeHandle::request_exit`, which posts `Message::RequestExit(code)` to the event loop
/// (`tauri-runtime-wry-2.11.4/src/lib.rs:2748-2756`), and the loop answers it with
/// `RunEvent::ExitRequested { code: Some(code), .. }` and then `ControlFlow::Exit`
/// (`tauri-runtime-wry-2.11.4/src/lib.rs:4353-4366`). So both passes of the exit hook run, off
/// the main thread, which is where that delivery is guaranteed.
///
/// `tokio::signal` is available because the workspace pins `tokio` with `features = ["full"]`
/// (`Cargo.toml:10`).
#[cfg(unix)]
fn spawn_signal_hook(handle: tauri::AppHandle) {
    use tokio::signal::unix::{signal, SignalKind};

    tauri::async_runtime::spawn(async move {
        let mut term = match signal(SignalKind::terminate()) {
            Ok(stream) => stream,
            Err(e) => {
                tracing::warn!(error = %e, "no SIGTERM handler; a kill will not shut down cleanly");
                return;
            }
        };
        let received = tokio::select! {
            _ = term.recv() => "SIGTERM",
            result = tokio::signal::ctrl_c() => match result {
                Ok(()) => "SIGINT",
                Err(e) => {
                    tracing::warn!(error = %e, "no SIGINT handler");
                    return;
                }
            },
        };
        tracing::info!(signal = received, "signal received; quitting through the exit hook");
        handle.exit(0);
    });
}

/// No signals to hook outside unix; the exit hook is then only reachable through the window.
#[cfg(not(unix))]
fn spawn_signal_hook(_handle: tauri::AppHandle) {}

/// One subscriber, once, filtered by `RUST_LOG` and defaulting to `info`.
///
/// `try_init` rather than `init`: a second call (a test binary, a future mobile entry point)
/// must not abort the process over a log filter.
fn init_tracing() {
    use tracing_subscriber::EnvFilter;

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,brigadier=debug,brigadier_lib=debug"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .try_init();
}
