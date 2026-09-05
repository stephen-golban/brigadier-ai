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
mod cleanup;
mod commands;
mod commit_message;
mod conversation;
mod error;
mod note_files;
mod peer_mcp;
mod peers;
mod reconcile;
mod search;
mod session_changes;
mod sink;
mod source_control;
mod state;
mod terminal;
mod trace;
mod tracker;
mod views;
mod workbench_data;
mod workspace;
pub use peers::cli as peer_cli;

use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use brigadier_proc::DEFAULT_GRACE;
use tauri::{Manager, RunEvent};

use crate::state::AppState;

/// Epoch milliseconds at the top of `main()`, the `T0` every paint number is measured against.
///
/// A `OnceLock` rather than managed state because it must be written before `tauri::Builder`
/// exists, and because [`run`] carries `#[cfg_attr(mobile, tauri::mobile_entry_point)]`, which
/// fixes its signature — there is nowhere to thread a parameter through.
static PROCESS_START_EPOCH_MS: OnceLock<f64> = OnceLock::new();

/// Stamp the process-start clock. Called as the **first statement of `main()`**, and again at the
/// top of [`run`] so a path that never goes through `main()` (the mobile entry point, a test
/// harness) gets a later-but-honest value rather than a panic. First write wins.
///
/// The number is epoch milliseconds as `f64`, which is directly comparable to the page's
/// `performance.timeOrigin`: **documented** W3C High Resolution Time defines `timeOrigin` as the
/// duration from the estimated monotonic time of the Unix epoch, and
/// `Date.now() - timeOrigin === performance.now()` held to the millisecond in a real `WKWebView`
/// on this machine (**measured**, `docs/research/perceived-performance.md` §5.3).
///
/// **What this measures, honestly: `main()` entry → first contentful paint, not `posix_spawn` →
/// FCP.** The dyld/pre-main segment is invisible from inside the process and cannot be recovered
/// afterwards: `DYLD_PRINT_STATISTICS` no longer exists in dyld on macOS 26.5 — it is absent from
/// the binary's string table, not merely disabled (**measured**, §5.1) — and
/// `ps -o lstart=` is second-granularity. Any launch-profiling recipe that starts with
/// `DYLD_PRINT_STATISTICS` is stale advice.
pub fn mark_process_start() {
    // The monotonic twin of the stamp below, and the zero every `BRIGADIER_TRACE` line is
    // measured from. Both are "first write wins", so a second call changes neither.
    crate::trace::arm();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    let _ = PROCESS_START_EPOCH_MS.set(now);
}

/// The process-start clock, in epoch milliseconds.
///
/// Stamps it on first read if nothing did, so this can never be a panic or a sentinel the operator
/// has to interpret; a value stamped here is late, and the delta computed from it is a floor.
pub(crate) fn process_start_epoch_ms() -> f64 {
    if PROCESS_START_EPOCH_MS.get().is_none() {
        mark_process_start();
    }
    *PROCESS_START_EPOCH_MS.get().unwrap_or(&0.0)
}

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
    // Idempotent; `main()` has already done this. It is here so an entry point that skips
    // `main()` still has a clock rather than a panic.
    mark_process_start();
    trace::stage("main");
    // Before `tauri::Builder` exists and long before any `claude` child: the limit a spawned
    // process inherits is the one in force at its `fork`, so raising it after the first spawn
    // would leave that child on the old value. see `trace::raise_file_limit`.
    trace::raise_file_limit();
    init_tracing();
    trace::stage("tracing_ready");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // The native folder picker behind "Add project", and nothing else: no message, ask or
        // save dialog is called anywhere in `src/`. `docs/research/tauri-dialog.md`.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            cleanup::session_discard,
            session_changes::session_changes,
            session_changes::session_diff,
            session_changes::session_apply_preview,
            session_changes::session_undo_preview,
            session_changes::session_apply,
            session_changes::session_apply_history,
            cleanup::session_cleanup_status,
            cleanup::session_cleanup_retry,
            commands::probe_claude,
            commands::list_models,
            commands::list_projects,
            commands::add_project,
            commands::set_project_mcp,
            commands::list_sessions,
            peers::peer_snapshot,
            peers::peer_decide,
            commit_message::generate_commit_message,
            source_control::workspace_git_action,
            source_control::workspace_git_details,
            search::workspace_search,
            search::workspace_replace,
            search::workspace_save,
            workbench_data::workbench_load,
            workbench_data::notes_folder_save,
            workbench_data::desktop_settings_save,
            workbench_data::note_save,
            workbench_data::note_delete,
            workbench_data::commit_settings_save,
            workbench_data::peer_settings_save,
            commands::start_session,
            commands::resume_session,
            commands::send_turn,
            commands::respond,
            commands::interrupt,
            commands::end_session,
            commands::kill,
            commands::cleanup_worktree,
            commands::delete_session,
            commands::delete_project,
            commands::feed_tail,
            commands::chat_items,
            conversation::session_context,
            conversation::session_activity,
            conversation::rewind_history,
            conversation::rewind_history_items,
            conversation::preview_rewind,
            conversation::apply_rewind,
            conversation::recover_workspace_rewind,
            workspace::workspace_entries,
            workspace::workspace_file,
            workspace::workspace_git,
            workspace::workspace_diff,
            terminal::terminal_info,
            terminal::terminal_open,
            terminal::terminal_read,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            commands::pending_approvals,
            commands::start_run,
            commands::current_run,
            commands::stop_run,
            commands::unsettled_intents,
            commands::settle_intent,
            commands::subscribe_feed,
            commands::set_visible_projects,
            commands::record_frame_stats,
            commands::report_paint,
            commands::burn,
        ])
        // `PageLoadEvent::Started` is `didCommitNavigation` and `Finished` is
        // `didFinishNavigation` (**source**, `wry-0.55.1/src/wkwebview/navigation.rs:17-46`), both
        // delivered on the main thread. So `page_load_started` is *after* the first
        // `tauri://localhost/` scheme response has been received and committed, not before it —
        // there is no hook before that. Registering `"tauri"` with
        // `Builder::register_uri_scheme_protocol` would **replace** the built-in asset protocol
        // rather than wrap it (`tauri-2.11.5/src/manager/webview.rs:267-277` only installs the
        // built-in when the app has not claimed the name), and `on_web_resource_request` exists
        // only on `WebviewBuilder`, which this app does not use — its window comes from
        // `tauri.conf.json`. The first-request signpost therefore does not exist and is not faked.
        .on_page_load(|_webview, payload| match payload.event() {
            tauri::webview::PageLoadEvent::Started => trace::stage("page_load_started"),
            tauri::webview::PageLoadEvent::Finished => trace::stage("page_load_finished"),
        })
        .setup(|app| {
            trace::stage("setup_entry");
            // `setup` runs on `RuntimeRunEvent::Ready`, after the window exists, on the main
            // thread — which is *not* a runtime thread, so `block_on` is legal here and is what
            // `Supervisor::new` needs (it spawns the per-frame flusher).
            // see docs/research/tauri-commands.md §4.1 and §5.
            let data_dir = match app.path().app_local_data_dir() {
                Ok(dir) => dir,
                Err(e) => {
                    let msg = format!("no application data directory: {e}");
                    tracing::error!("{msg}");
                    app.manage(AppState::failed(crate::error::AppError::io(msg)));
                    return Ok(());
                }
            };
            match tauri::async_runtime::block_on(state::build(data_dir)) {
                Ok(ready) => {
                    tracing::info!(?ready, "brigadier started");
                    // `git worktree prune` per project, off the setup thread. A worktree
                    // directory deleted by hand stays in `git worktree list` as prunable and
                    // blocks the next `add` at the same path; prune never touches a branch
                    // (**measured**), and every failure inside is a `warn`, so nothing here can
                    // hold or fail startup.
                    // see docs/research/worktree-git.md §4.
                    //
                    // Reconciliation goes in the same task, **after** the prune and never beside
                    // it. Both call `git worktree repair`, and the two verbs do not commute: a
                    // `prune` that lands before a `repair` removes the entry, after which repair
                    // answers `error: unable to locate repository` with no way back
                    // (**measured**, `crates/supervisor/src/worktree.rs::prune_project`). Run
                    // concurrently, that race would turn a renamed project folder into a
                    // `repair_failed` that refuses every run in it. One task, in order, costs
                    // nothing — both passes are two `git` calls per project — and the barrier is
                    // published either way, because a sender dropped without publishing is what
                    // the loop reads as `reconcile_failed`.
                    // see docs/research/intent-records.md §4.1 and §4.2 step 1.
                    let supervisor = ready.supervisor.clone();
                    let store = ready.store().clone();
                    let sender = ready.take_reconcile_sender();
                    tauri::async_runtime::spawn(async move {
                        supervisor.prune_worktrees().await;
                        let Some(sender) = sender else { return };
                        reconcile::run(&supervisor, &store, sender).await;
                    });
                    app.manage(AppState::ready(ready));
                    if let Err(e) = peers::start(app.handle().clone()) {
                        tracing::error!("Peer communication unavailable: {}", e.message);
                    }
                    if let Err(e) = cleanup::start(app.handle().clone()) {
                        tracing::error!("Session cleanup unavailable: {}", e.message);
                    }
                }
                Err(err) => {
                    // Never `?`: an Err out of `setup` panics the process, and a read-only home
                    // directory — or a second instance on one data directory — must produce a
                    // window that says so.
                    tracing::error!(code = %err.code, message = %err.message, "startup failed");
                    app.manage(AppState::failed(err));
                }
            }
            // A terminal's `kill -TERM` (or ctrl-C on `tauri dev`) does not raise any `RunEvent`
            // at all — measured: the exit hook below runs no code — so the sessions are lost and
            // the next launch marks them failed. Route both signals into `AppHandle::exit`, which
            // does raise them.
            spawn_signal_hook(app.handle().clone());
            trace::stage("setup_exit");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    // Before `setup`, not after. `Builder::build` constructs the app and returns; the user's
    // `setup` closure runs later, from inside `run`, on `RuntimeRunEvent::Ready` — and tauri's own
    // `setup` creates the configured windows *first* and calls the closure second
    // (**source**, `tauri-2.11.5/src/app.rs:1424`, `:2521-2535`). So the window exists before
    // `setup_entry` and the ordering of these lines is `builder_built` → `setup_entry`.
    trace::stage("builder_built");

    app.run(|handle, event| match event {
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
        tracing::info!(
            signal = received,
            "signal received; quitting through the exit hook"
        );
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
