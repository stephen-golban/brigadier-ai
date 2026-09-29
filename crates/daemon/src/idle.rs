//! The daemon quits on its own once nobody uses it: no app has been connected for
//! [`IDLE_EXIT`] and nothing runs (no turn or worker, Brain job, index scan, download,
//! terminal or dictation, and keeping awake isn't set to "Always"). The daemon keeps running
//! when the window closes so that unattended work goes on (PLAN.md §3), but once that work is
//! done and the app is gone (quit, or crashed), nothing would ever end it. The app launches it
//! again when it starts.

use std::sync::Arc;
use std::time::{Duration, Instant};

use brigadier_core::KeepAwake;
use tokio_util::sync::CancellationToken;

use crate::server::Daemon;

/// How long the daemon waits with no app connected before it quits, once nothing runs.
const IDLE_EXIT: Duration = Duration::from_secs(30 * 60);
/// How often it looks.
const CHECK_EVERY: Duration = Duration::from_secs(60);

/// What runs now, said plainly; empty when nothing does.
pub async fn running(daemon: &Daemon) -> Vec<String> {
    let mut running = Vec::new();
    if daemon.sessions.agents_working().await {
        running.push("a turn or a worker".to_owned());
    }
    running.extend(daemon.sessions.brain_work());
    match daemon.terminals.count() {
        0 => {}
        1 => running.push("a terminal".to_owned()),
        n => running.push(format!("{n} terminals")),
    }
    running.extend(daemon.dictation.work());
    if daemon.core.settings().keep_awake == KeepAwake::Always {
        running.push("keeping the computer awake (Always)".to_owned());
    }
    running
}

/// Asks the daemon to quit once no app has been connected for [`IDLE_EXIT`] and nothing runs.
pub async fn exit_when_idle(daemon: Arc<Daemon>, stop: CancellationToken) -> anyhow::Result<()> {
    let wait = idle_exit();
    let every = CHECK_EVERY.min(wait);
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut alone_since: Option<Instant> = None;
    loop {
        tokio::select! {
            () = stop.cancelled() => return Ok(()),
            _ = tick.tick() => {}
        }
        if daemon.metrics.clients() > 0 {
            alone_since = None;
            continue;
        }
        // Uninstalled, and the app went without asking this daemon to quit (it crashed): the
        // finisher waits for this daemon before it removes the rest.
        if daemon.uninstall.started() {
            let _ = daemon.quit.try_send("uninstalled, and no app is connected");
            return Ok(());
        }
        let since = *alone_since.get_or_insert_with(Instant::now);
        if since.elapsed() < wait || !running(&daemon).await.is_empty() {
            continue;
        }
        let _ = daemon
            .quit
            .try_send("no app connected for a while and nothing running");
        return Ok(());
    }
}

/// [`IDLE_EXIT`], or in a debug build `BRIGADIER_IDLE_EXIT_SECS` (to verify it without
/// waiting half an hour).
fn idle_exit() -> Duration {
    #[cfg(debug_assertions)]
    if let Some(secs) = std::env::var("BRIGADIER_IDLE_EXIT_SECS")
        .ok()
        .and_then(|secs| secs.parse::<u64>().ok())
    {
        return Duration::from_secs(secs.max(1));
    }
    IDLE_EXIT
}
