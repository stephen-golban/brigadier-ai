//! `brigadierd quit [--data-dir PATH]`: asks the daemon of a data directory to quit the orderly
//! way (as the app's Quit does) and waits until its process is gone. For
//! `scripts/uninstall.sh`, which must stop a daemon before removing what it owns.
//!
//! Exit codes: 0 it quit, 3 no daemon was running there, 1 it could not be asked or did not
//! quit in time (the caller may then fall back to SIGTERM, which quits the same way).

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use brigadier_ipc::protocol::{ClientFrame, ClientInfo, Outcome, Request, ServerFrame};
use brigadier_sandbox::PlatformOptions;

/// Exit code when nothing was running.
const NOT_RUNNING: u8 = 3;
/// How long the daemon gets to end its sessions and commit its writes.
const QUIT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long its process then gets to exit.
const EXIT_TIMEOUT: Duration = Duration::from_secs(10);

pub fn main(mut args: impl Iterator<Item = OsString>) -> ExitCode {
    let mut data_dir: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        match (arg.to_str(), args.next()) {
            (Some("--data-dir"), Some(dir)) => data_dir = Some(dir.into()),
            _ => {
                eprintln!("usage: brigadierd quit [--data-dir PATH]");
                return ExitCode::from(2);
            }
        }
    }
    let platform = match brigadier_sandbox::native(PlatformOptions { data_dir }) {
        Ok(platform) => platform,
        Err(err) => {
            eprintln!("brigadierd quit: {err}");
            return ExitCode::FAILURE;
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("brigadierd quit: {err}");
            return ExitCode::FAILURE;
        }
    };
    let data_dir = platform.paths().data_dir.display().to_string();
    let client = ClientInfo {
        name: "brigadierd quit".into(),
        pid: std::process::id(),
    };
    let connected = runtime.block_on(brigadier_ipc::connect(&*platform, client));
    let (mut connection, daemon, _) = match connected {
        Ok(connected) => connected,
        Err(err) if not_running(&err) => {
            println!("no daemon is running for {data_dir}");
            return ExitCode::from(NOT_RUNNING);
        }
        Err(err) => {
            eprintln!("brigadierd quit: could not reach the daemon for {data_dir}: {err}");
            return ExitCode::FAILURE;
        }
    };
    let asked = runtime.block_on(async {
        connection
            .writer
            .write(&ClientFrame::Request {
                id: 1,
                request: Request::Shutdown,
            })
            .await?;
        tokio::time::timeout(QUIT_TIMEOUT, async {
            loop {
                match connection.reader.read::<ServerFrame>().await? {
                    Some(ServerFrame::Response { id: 1, result }) => {
                        return Ok::<_, brigadier_ipc::Error>(matches!(result, Outcome::Ok { .. }));
                    }
                    // Closing without an answer still means it is quitting.
                    Some(ServerFrame::Closing) | None => return Ok(true),
                    Some(_) => {}
                }
            }
        })
        .await
        .unwrap_or(Ok(false))
    });
    match asked {
        Ok(true) => {}
        Ok(false) => {
            eprintln!(
                "brigadierd quit: the daemon (pid {}) did not quit in time",
                daemon.pid
            );
            return ExitCode::FAILURE;
        }
        Err(err) => {
            eprintln!("brigadierd quit: {err}");
            return ExitCode::FAILURE;
        }
    }
    let processes = platform.processes();
    let deadline = std::time::Instant::now() + EXIT_TIMEOUT;
    while processes.is_alive(daemon.pid) {
        if std::time::Instant::now() > deadline {
            eprintln!(
                "brigadierd quit: the daemon (pid {}) is still running",
                daemon.pid
            );
            return ExitCode::FAILURE;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("the daemon for {data_dir} (pid {}) quit", daemon.pid);
    ExitCode::SUCCESS
}

/// Nothing listens there: no token, no socket, or a socket nobody accepts on.
fn not_running(err: &brigadier_ipc::Error) -> bool {
    match err {
        brigadier_ipc::Error::Io(err) => matches!(
            err.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
        ),
        _ => false,
    }
}
