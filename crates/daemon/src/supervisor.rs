use std::future::Future;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_metrics::TaskMonitor;
use tokio_util::sync::CancellationToken;

/// A poll longer than this held a runtime worker hostage: a stall (§4).
pub const SLOW_POLL: Duration = Duration::from_millis(10);

/// Spawns every daemon task under one [`TaskMonitor`] (so poll times are measured for all of
/// them) and turns the failure of a critical task into a daemon exit.
#[derive(Clone)]
pub struct Supervisor {
    monitor: TaskMonitor,
    shutdown: CancellationToken,
    fatal: mpsc::Sender<String>,
}

impl Supervisor {
    pub fn new(shutdown: CancellationToken) -> (Self, mpsc::Receiver<String>) {
        let (fatal, fatal_rx) = mpsc::channel(8);
        let monitor = TaskMonitor::builder()
            .with_slow_poll_threshold(SLOW_POLL)
            .with_long_delay_threshold(SLOW_POLL)
            .clone()
            .build();
        (
            Self {
                monitor,
                shutdown,
                fatal,
            },
            fatal_rx,
        )
    }

    pub fn monitor(&self) -> &TaskMonitor {
        &self.monitor
    }

    pub fn shutdown_token(&self) -> &CancellationToken {
        &self.shutdown
    }

    /// Spawns an instrumented task whose failure only affects itself.
    pub fn spawn<F>(&self, task: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        tokio::spawn(self.monitor.instrument(task))
    }

    /// Spawns an instrumented task the daemon cannot run without. If it fails, panics or ends
    /// before shutdown began, the daemon logs it and exits non-zero rather than limping on.
    pub fn spawn_critical<F>(&self, name: &'static str, task: F)
    where
        F: Future<Output = anyhow::Result<()>> + Send + 'static,
    {
        let handle = tokio::spawn(self.monitor.instrument(task));
        let shutdown = self.shutdown.clone();
        let fatal = self.fatal.clone();
        self.spawn(async move {
            let outcome = handle.await;
            if shutdown.is_cancelled() {
                return;
            }
            let reason = match outcome {
                Ok(Ok(())) => format!("{name} stopped unexpectedly"),
                Ok(Err(err)) => format!("{name} failed: {err:#}"),
                Err(err) if err.is_panic() => format!("{name} panicked"),
                Err(err) => format!("{name} was cancelled: {err}"),
            };
            let _ = fatal.try_send(reason);
        });
    }
}
