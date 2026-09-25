//! `brigadierd`: the Brigadier core process.
//!
//! Launched detached by the app, it keeps running when the window closes so long sessions
//! continue. Lifecycle:
//!
//! 1. Take the single-instance lock (released by the OS if we crash).
//! 2. Open the store, bind the IPC endpoint, publish the per-launch token.
//! 3. Serve until SIGTERM/SIGINT, a client's `shutdown`, or a fatal failure.
//! 4. Orderly quit: stop accepting, end every CLI session and store its last events, stop
//!    admitting writes, commit everything queued, acknowledge the client that asked, close
//!    connections, remove the token, exit 0.
//!
//! A critical task or the store writer dying is logged and exits with code 70 instead.
//!
//! The same binary has two more jobs, chosen before any of the above runs:
//!
//! - `brigadierd mcp`: the stdio bridge CLI sessions start for the Brigadier MCP tools
//!   ([`bridge`]);
//! - started through a command-gate link (`git`, `gh`, `npm`, …): the outward-command gate
//!   ([`gate`]).

mod bridge;
mod gate;
mod logging;
mod metrics;
mod server;
mod supervisor;
mod terminals;
mod upgrade;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use brigadier_core::Core;
use brigadier_core::manager::{ManagerConfig, SessionManager};
use brigadier_core::runtime::{Runtime, Spawner};
use brigadier_ipc::protocol::{DaemonInfo, PROTOCOL_VERSION};
use brigadier_ipc::{Listener, Token};
use brigadier_sandbox::{InstanceLock, Platform, PlatformOptions};
use brigadier_store::{CHECKPOINT_INTERVAL, Store, StoreConfig};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::metrics::Metrics;
use crate::server::Daemon;
use crate::supervisor::Supervisor;

/// Exit code for an internal failure (EX_SOFTWARE).
const EXIT_FATAL: u8 = 70;
/// How long connections get to receive their goodbye after the store drained.
const CLOSE_GRACE: Duration = Duration::from_secs(2);
const READERS: usize = 4;
const RUNTIME_WORKERS: usize = 2;

struct Args {
    data_dir: Option<PathBuf>,
    foreground: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        data_dir: None,
        foreground: false,
    };
    let mut iter = std::env::args_os().skip(1);
    while let Some(arg) = iter.next() {
        match arg.to_str() {
            Some("--data-dir") => {
                args.data_dir = Some(iter.next().ok_or("--data-dir needs a path")?.into());
            }
            Some("--foreground") => args.foreground = true,
            Some("--version") => {
                println!("brigadierd {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            _ => return Err(format!("unknown argument {arg:?}")),
        }
    }
    Ok(args)
}

fn main() -> ExitCode {
    // A command-gate shim (`git`, `gh`, … linked to this binary): decide and exec before any
    // runtime, logging or store exists, so ungated commands pay almost nothing.
    #[cfg(unix)]
    if let Some(program) = gate::shim_program() {
        return gate::run_shim(program);
    }
    // `brigadierd mcp`: the stdio MCP bridge a CLI session starts.
    if std::env::args_os().nth(1).is_some_and(|arg| arg == "mcp") {
        return bridge::run(std::env::args_os().skip(2));
    }
    let args = match parse_args() {
        Ok(args) => args,
        Err(err) => {
            eprintln!(
                "brigadierd: {err}\nusage: brigadierd [--data-dir PATH] [--foreground]\n       brigadierd mcp [--data-dir PATH]"
            );
            return ExitCode::from(2);
        }
    };
    let platform = match brigadier_sandbox::native(PlatformOptions {
        data_dir: args.data_dir,
    }) {
        Ok(platform) => platform,
        Err(err) => {
            eprintln!("brigadierd: {err}");
            return ExitCode::from(EXIT_FATAL);
        }
    };
    let _log_guard = match logging::init(&platform.paths().logs_dir, args.foreground) {
        Ok(guard) => guard,
        Err(err) => {
            eprintln!("brigadierd: cannot initialize logging: {err:#}");
            return ExitCode::from(EXIT_FATAL);
        }
    };
    match start(platform) {
        Ok(code) => code,
        Err(err) => {
            tracing::error!(error = %format!("{err:#}"), "brigadierd failed");
            ExitCode::from(EXIT_FATAL)
        }
    }
}

fn start(platform: Arc<dyn Platform>) -> anyhow::Result<ExitCode> {
    let paths = platform.paths().clone();
    // Transcripts and the token live here: nobody but the current user may read them.
    for dir in [&paths.data_dir, &paths.run_dir] {
        platform
            .private_fs()
            .create_private_dir(dir)
            .with_context(|| format!("creating {}", dir.display()))?;
    }
    let Some(_lock) = InstanceLock::try_acquire(&paths.lock_path).context("instance lock")? else {
        tracing::info!("another brigadierd owns this data directory; exiting");
        return Ok(ExitCode::SUCCESS);
    };
    // Workers' outward commands are gated through these shims; without them they would run
    // unasked, so failing to create them is fatal.
    gate::install(&paths.data_dir).context("creating the command gate")?;
    let started_at_ms = brigadier_core::now_ms();
    tracing::info!(
        pid = std::process::id(),
        version = env!("CARGO_PKG_VERSION"),
        data_dir = %paths.data_dir.display(),
        "brigadierd starting"
    );

    // Opening and migrating the store is blocking work; do it before the runtime exists.
    let store = Store::open(StoreConfig {
        db_path: paths.db_path.clone(),
        blobs_dir: paths.blobs_dir.clone(),
        readers: READERS,
    })
    .context("opening the event store")?;
    let token = Token::generate().context("generating the IPC token")?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(RUNTIME_WORKERS)
        .thread_name("brigadierd-rt")
        .enable_all()
        .build()
        .context("starting the async runtime")?;
    let info = DaemonInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        protocol: PROTOCOL_VERSION,
        pid: std::process::id(),
        platform: platform.name().into(),
        started_at_ms,
        data_dir: paths.data_dir.display().to_string(),
    };
    let code = runtime.block_on(serve(platform.clone(), store, token, info));
    runtime.shutdown_timeout(Duration::from_secs(1));

    if let Err(err) = std::fs::remove_file(&paths.token_path) {
        tracing::warn!(error = %err, "could not remove the IPC token");
    }
    tracing::info!(code = ?code, "brigadierd stopped");
    Ok(code)
}

async fn serve(
    platform: Arc<dyn Platform>,
    store: Store,
    token: Token,
    info: DaemonInfo,
) -> ExitCode {
    match run(platform, store, token, info).await {
        Ok(code) => code,
        Err(err) => {
            tracing::error!(error = %format!("{err:#}"), "brigadierd failed");
            ExitCode::from(EXIT_FATAL)
        }
    }
}

async fn run(
    platform: Arc<dyn Platform>,
    store: Store,
    token: Token,
    info: DaemonInfo,
) -> anyhow::Result<ExitCode> {
    let stopping = CancellationToken::new();
    let closing = CancellationToken::new();
    let (supervisor, mut fatal) = Supervisor::new(stopping.clone());
    let (quit_tx, mut quit_rx) = mpsc::channel(1);
    let (drained_tx, drained_rx) = watch::channel(false);

    let core = Core::load(store.clone())
        .await
        .context("loading the catalog")?;
    let spawner: Spawner = {
        let supervisor = supervisor.clone();
        Arc::new(move |task| {
            supervisor.spawn(task);
        })
    };
    // Also sweeps what a crashed daemon left behind, before any client can start sessions.
    let providers = Runtime::start(core.clone(), platform.clone(), spawner.clone())
        .await
        .context("starting the provider runtime")?;
    let manager_config = ManagerConfig {
        daemon_exe: std::env::current_exe().context("locating brigadierd")?,
        gate_dir: Some(platform.paths().data_dir.join("gate").join("bin")),
    };
    let sessions = SessionManager::start(core.clone(), providers.clone(), spawner, manager_config)
        .await
        .context("starting the session manager")?;
    let metrics = Metrics::start(supervisor.clone(), store.clone(), platform.clone());
    let listener = Listener::bind(&*platform).context("binding the IPC endpoint")?;
    {
        let platform = platform.clone();
        let token = token.clone();
        tokio::task::spawn_blocking(move || {
            token.publish(&*platform, &platform.paths().token_path)
        })
        .await?
        .context("publishing the IPC token")?;
    }

    let daemon = Arc::new(Daemon::new(
        info,
        core,
        providers.clone(),
        sessions,
        store.clone(),
        metrics,
        supervisor.clone(),
        closing.clone(),
        quit_tx,
        drained_rx,
    ));
    supervisor.spawn_critical(
        "ipc accept loop",
        server::accept_loop(daemon.clone(), listener, token),
    );
    supervisor.spawn_critical("wal checkpointer", checkpoint_loop(store.clone()));
    tracing::info!("brigadierd ready");

    let reason = tokio::select! {
        signal = termination_signal() => signal,
        _ = quit_rx.recv() => "quit requested by a client",
        state = store.writer_stopped() => {
            tracing::error!(state = ?state, "store writer stopped; exiting");
            stopping.cancel();
            daemon.terminals.close_all();
            daemon.sessions.shutdown().await;
            providers.shutdown().await;
            return Ok(ExitCode::from(EXIT_FATAL));
        }
        Some(reason) = fatal.recv() => {
            tracing::error!(reason = %reason, "critical task failed; exiting");
            stopping.cancel();
            daemon.terminals.close_all();
            daemon.sessions.shutdown().await;
            providers.shutdown().await;
            return Ok(ExitCode::from(EXIT_FATAL));
        }
    };
    tracing::info!(reason, "shutting down");

    // 1. Stop accepting connections; critical tasks may now end without being fatal.
    stopping.cancel();
    // 2. Stop admitting provider work, end every CLI session (bounded, whole process groups)
    //    and store their last events. Sessions, Chats and workers first: they are hosted by
    //    the provider runtime. The user's terminals end too.
    daemon.terminals.close_all();
    daemon.sessions.shutdown().await;
    providers.shutdown().await;
    // 3. Stop admitting writes and commit everything already queued.
    let drained = store.shutdown().await;
    // 4. Acknowledge the client that asked, then close every connection.
    drained_tx.send_replace(true);
    closing.cancel();
    daemon.connections.close();
    if tokio::time::timeout(CLOSE_GRACE, daemon.connections.wait())
        .await
        .is_err()
    {
        tracing::warn!("connections did not close in time");
    }
    match drained {
        Ok(()) => Ok(ExitCode::SUCCESS),
        Err(err) => {
            tracing::error!(error = %err, "store did not shut down cleanly");
            Ok(ExitCode::from(EXIT_FATAL))
        }
    }
}

/// Requests a PASSIVE WAL checkpoint periodically, but only after new commits.
async fn checkpoint_loop(store: Store) -> anyhow::Result<()> {
    let mut ticker = tokio::time::interval(CHECKPOINT_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_batches = store.stats().committed_batches;
    loop {
        ticker.tick().await;
        let batches = store.stats().committed_batches;
        if batches != last_batches {
            last_batches = batches;
            store.request_checkpoint();
        }
    }
}

/// Resolves on SIGTERM/SIGINT (Unix) or Ctrl-C / system shutdown (Windows).
async fn termination_signal() -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) {
            (Ok(mut term), Ok(mut int)) => tokio::select! {
                _ = term.recv() => "SIGTERM",
                _ = int.recv() => "SIGINT",
            },
            _ => {
                tracing::warn!("signal handlers unavailable");
                std::future::pending().await
            }
        }
    }
    #[cfg(windows)]
    {
        use tokio::signal::windows::{ctrl_c, ctrl_close, ctrl_shutdown};
        // A detached daemon has no console, so these may be unavailable; IPC quit still works.
        let mut c = ctrl_c().ok();
        let mut close = ctrl_close().ok();
        let mut shutdown = ctrl_shutdown().ok();
        tokio::select! {
            Some(_) = async { match c.as_mut() { Some(s) => s.recv().await, None => std::future::pending().await } } => "Ctrl-C",
            Some(_) = async { match close.as_mut() { Some(s) => s.recv().await, None => std::future::pending().await } } => "console closed",
            Some(_) = async { match shutdown.as_mut() { Some(s) => s.recv().await, None => std::future::pending().await } } => "system shutdown",
        }
    }
}
