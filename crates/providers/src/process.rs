//! A CLI child process Brigadier talks to over stdio.
//!
//! The child leads its own process group, so ending it ends everything it started. Three tasks
//! serve it: stdout is split into lines and handed to the adapter, stderr keeps a short tail for
//! error reports, and a waiter reaps the child, then kills whatever is left of its group.

use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use brigadier_sandbox::{Platform, SpawnSpec};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, watch};

use crate::record::{Direction, Recorder};
use crate::{Error, Result};

/// Stdout lines buffered between the reader and the adapter.
const STDOUT_LINES: usize = 256;
const STDERR_TAIL_LINES: usize = 40;
/// After a forced kill, how long to wait for the child to be reaped.
const REAP_WAIT: Duration = Duration::from_secs(2);

/// How a CLI process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Exit {
    pub code: Option<i32>,
}

pub struct CliProcess {
    pid: u32,
    started_at_ms: Option<f64>,
    platform: Arc<dyn Platform>,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    exit: watch::Receiver<Option<Exit>>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    recorder: Option<Arc<Recorder>>,
}

/// A running CLI and the lines it prints.
pub struct Spawned {
    pub process: Arc<CliProcess>,
    pub stdout: mpsc::Receiver<String>,
}

/// Spawns `spec` with piped stdio in its own process group.
pub fn spawn(
    platform: Arc<dyn Platform>,
    spec: &SpawnSpec,
    recorder: Option<Arc<Recorder>>,
) -> Result<Spawned> {
    let mut command = tokio::process::Command::from(platform.processes().piped_command(spec));
    command.stdin(Stdio::piped()).kill_on_drop(false);
    let mut child = command
        .spawn()
        .map_err(|err| Error::Spawn(format!("{}: {err}", spec.program.display())))?;
    let pid = child
        .id()
        .ok_or_else(|| Error::Spawn("the process exited immediately".into()))?;
    let started_at_ms = platform.processes().start_time_ms(pid).ok();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");

    let (lines_tx, lines) = mpsc::channel(STDOUT_LINES);
    let out_recorder = recorder.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(recorder) = &out_recorder {
                recorder.record(Direction::Out, &line);
            }
            if lines_tx.send(line).await.is_err() {
                break;
            }
        }
    });

    let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
    let tail = stderr_tail.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            tracing::debug!(pid, stderr = %line, "cli stderr");
            let mut tail = tail.lock().unwrap_or_else(|p| p.into_inner());
            if tail.len() == STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    });

    let (exit_tx, exit) = watch::channel(None);
    let reaper = platform.clone();
    tokio::spawn(async move {
        let status = child.wait().await;
        // The CLI may have left children behind in its group (background shells, servers).
        let _ = reaper.processes().kill_group(pid);
        let code = status.ok().and_then(|status| status.code());
        tracing::debug!(pid, code, "cli process exited");
        exit_tx.send_replace(Some(Exit { code }));
    });

    Ok(Spawned {
        process: Arc::new(CliProcess {
            pid,
            started_at_ms,
            platform,
            stdin: tokio::sync::Mutex::new(stdin),
            exit,
            stderr_tail,
            recorder,
        }),
        stdout: lines,
    })
}

impl CliProcess {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn started_at_ms(&self) -> Option<f64> {
        self.started_at_ms
    }

    pub fn is_running(&self) -> bool {
        self.exit.borrow().is_none()
    }

    /// Writes one line (a newline is appended) to the CLI's stdin.
    pub async fn write_line(&self, line: &str) -> Result<()> {
        let mut stdin = self.stdin.lock().await;
        let pipe = stdin.as_mut().ok_or(Error::Closed)?;
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        if let Err(err) = pipe.write_all(&bytes).await {
            *stdin = None;
            return Err(if err.kind() == std::io::ErrorKind::BrokenPipe {
                Error::Closed
            } else {
                err.into()
            });
        }
        pipe.flush().await?;
        if let Some(recorder) = &self.recorder {
            recorder.record(Direction::In, line);
        }
        Ok(())
    }

    /// Resolves once the process has exited and been reaped.
    pub async fn exited(&self) -> Exit {
        let mut exit = self.exit.clone();
        match exit.wait_for(Option::is_some).await {
            Ok(exit) => exit.expect("checked by wait_for"),
            // The waiter task is gone; the process was reaped with it.
            Err(_) => Exit { code: None },
        }
    }

    /// The last lines the CLI wrote to stderr.
    pub fn stderr_tail(&self) -> Option<String> {
        let tail = self.stderr_tail.lock().unwrap_or_else(|p| p.into_inner());
        (!tail.is_empty()).then(|| tail.iter().cloned().collect::<Vec<_>>().join("\n"))
    }

    /// Ends the process: closes stdin (both CLIs exit on EOF), waits up to `grace`, then kills
    /// its process tree and waits for the reap. Bounded by `grace` plus [`REAP_WAIT`].
    pub async fn shutdown(&self, grace: Duration) -> Exit {
        self.stdin.lock().await.take();
        if let Ok(exit) = tokio::time::timeout(grace, self.exited()).await {
            return exit;
        }
        tracing::info!(
            pid = self.pid,
            "cli did not exit in time; killing its process tree"
        );
        if let Err(err) = self.platform.processes().kill_tree(self.pid) {
            tracing::warn!(pid = self.pid, error = %err, "could not kill the cli process tree");
        }
        tokio::time::timeout(REAP_WAIT, self.exited())
            .await
            .unwrap_or(Exit { code: None })
    }
}

/// Output of a short-lived CLI command.
pub struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a short CLI command (`--version`, `auth status`) to completion, killing its process
/// group if it takes longer than `timeout`.
pub async fn run(
    platform: &Arc<dyn Platform>,
    spec: &SpawnSpec,
    timeout: Duration,
) -> Result<Output> {
    let mut command = tokio::process::Command::from(platform.processes().piped_command(spec));
    command.stdin(Stdio::null());
    let child = command
        .spawn()
        .map_err(|err| Error::Spawn(format!("{}: {err}", spec.program.display())))?;
    let pid = child.id();
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(output) => {
            let output = output?;
            Ok(Output {
                code: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            })
        }
        Err(_) => {
            if let Some(pid) = pid {
                let _ = platform.processes().kill_tree(pid);
            }
            Err(Error::Timeout("the command"))
        }
    }
}
