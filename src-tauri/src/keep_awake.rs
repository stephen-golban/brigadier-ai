//! A bounded macOS power assertion, owned by the backend rather than a webview.
//!
//! The task below is edge-driven. It wakes when the number of working sessions changes or the
//! preference is toggled ([`crate::peer_sessions::subscribe_activity`]), and — only while an
//! assertion is actually held — at that assertion's renewal deadline. Disabled, or enabled with
//! nothing working, it parks on the watch with no timer armed at all.
//!
//! Until 2026-09-11 it instead woke every two seconds *and* on every feed batch (up to 60 a
//! second while a session streamed), and each pass issued one `NativeControl::Activity` RPC per
//! live session to ask what the event stream had already said. It now asks nothing on an
//! ordinary pass; see [`crate::peer_sessions::Activity`] for why the derived answer is the same
//! answer. The one exception is the renewal: the feed that answer is derived from is lossy
//! (`brigadier_supervisor::batcher`'s per-project buffer drops its oldest signal when full), and
//! a dropped `TurnCompleted` would hold the machine awake for ever, so while — and only while —
//! an assertion is held, each 45 s renewal re-asks the provider about the sessions the model
//! still calls working ([`crate::peer_sessions::verify_busy`]).
use crate::error::AppError;
use std::{
    future::Future,
    pin::Pin,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tauri::Manager;

/// Re-derive the activity model from the providers, for the sessions it believes are working.
///
/// Behind an indirection so the task below stays drivable by a unit test: production hands it
/// [`crate::peer_sessions::verify_busy`], a test hands it a closure over its own watch.
type Verify = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// A `caffeinate -diu -t 60` lease is renewed once it is this old. Unchanged: the renewal is the
/// only deadline this module has, and it is the reason the parked task ever arms a timer.
const RENEW_AFTER: Duration = Duration::from_secs(45);

#[derive(Default, Clone)]
pub(crate) struct KeepAwake(Arc<Mutex<Controller>>);
impl KeepAwake {
    /// A poisoned lock guards one optional child process; carrying on with it beats taking the
    /// app down.
    fn lock(&self) -> MutexGuard<'_, Controller> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

struct Controller {
    enabled: bool,
    stopped: bool,
    assertion: Option<Assertion>,
    /// Replaced in tests so a unit test never has to hold a real power assertion.
    spawn: fn() -> std::io::Result<Child>,
    /// How many times the task loop has run a pass. Tests read it to prove a park.
    #[cfg(test)]
    passes: usize,
}
impl Default for Controller {
    fn default() -> Self {
        Self {
            enabled: false,
            stopped: false,
            assertion: None,
            spawn: caffeinate,
            #[cfg(test)]
            passes: 0,
        }
    }
}
struct Assertion {
    child: Child,
    /// `tokio::time::Instant`, so the renewal deadline is the same clock the task sleeps on —
    /// including a test's paused one. Outside a runtime it is `std::time::Instant::now()`
    /// (`tokio-1.53.1/src/time/clock.rs:284`).
    started: tokio::time::Instant,
}
impl Drop for Assertion {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
// -u otherwise expires after five seconds. Renew before the one-minute lease
// expires; -w also releases it if Brigadier crashes. No system settings change.
fn caffeinate() -> std::io::Result<Child> {
    Command::new("/usr/bin/caffeinate")
        .args(["-diu", "-t", "60", "-w", &std::process::id().to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}
impl Controller {
    /// Bring the assertion in line with `working`, and report how long until the next renewal is
    /// due. `None` means nothing is held, so there is no deadline to wake for.
    fn reconcile(&mut self, working: bool) -> Result<Option<Duration>, AppError> {
        if !self.enabled || self.stopped || !working {
            self.assertion = None;
            return Ok(None);
        }
        if let Some(assertion) = &mut self.assertion {
            let age = assertion.started.elapsed();
            // A `try_wait` that errors tells us nothing about the child, and an assertion that
            // may already be dead is worth less than the respawn below: treat it as expired.
            if age < RENEW_AFTER && matches!(assertion.child.try_wait(), Ok(None)) {
                return Ok(Some(RENEW_AFTER - age));
            }
        }
        let child = (self.spawn)()?;
        self.assertion = Some(Assertion {
            child,
            started: tokio::time::Instant::now(),
        });
        Ok(Some(RENEW_AFTER))
    }
}

pub(crate) fn set_enabled(app: &tauri::AppHandle, enabled: bool) {
    let service = app.state::<KeepAwake>();
    let mut controller = service.lock();
    controller.enabled = enabled;
    if !enabled {
        controller.assertion = None;
    }
    drop(controller);
    crate::peer_sessions::notify_keep_awake();
}

pub(crate) fn stop(app: &tauri::AppHandle) {
    if let Some(service) = app.try_state::<KeepAwake>() {
        let mut controller = service.lock();
        controller.stopped = true;
        controller.assertion = None;
        drop(controller);
        // The task parks without a timer, so shutdown has to wake it to let it return.
        crate::peer_sessions::notify_keep_awake();
    }
}

pub(crate) fn start(app: tauri::AppHandle, enabled: bool) {
    set_enabled(&app, enabled);
    let service = app.state::<KeepAwake>().inner().clone();
    let verify: Verify = Arc::new(move || -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let app = app.clone();
        Box::pin(async move {
            if let Ok(ready) = app.state::<crate::state::AppState>().get() {
                crate::peer_sessions::verify_busy(ready).await;
            }
        })
    });
    tauri::async_runtime::spawn(run(
        service,
        crate::peer_sessions::subscribe_activity(),
        verify,
    ));
}

/// The task body. It holds no Tauri handle and reaches the provider only through `verify`, so a
/// test drives it directly over a local watch.
async fn run(
    service: KeepAwake,
    mut edges: tokio::sync::watch::Receiver<crate::peer_sessions::Activity>,
    verify: Verify,
) {
    loop {
        // The model is fed by a lossy transport (`peer_sessions::reconcile`), and a dropped
        // `TurnCompleted` would otherwise hold this machine awake for ever. So before renewing a
        // lease — and only then, which is at most once per 45 s and only while one is actually
        // held — ask the provider about each session the model calls working. A model nothing
        // backs is cleared, the edge that clears it is read below, and the lease is released.
        //
        // Keyed on the lease's own age rather than on which arm of the park woke us: under a
        // stream of edges the renewal timer never gets to fire, and that is exactly the busy app
        // this has to stay honest in.
        let due = {
            let controller = service.lock();
            controller
                .assertion
                .as_ref()
                .is_some_and(|a| a.started.elapsed() >= RENEW_AFTER)
        };
        if due {
            verify().await;
        }
        // Mark the current value seen *before* deciding on it: an edge that lands during the
        // decision leaves the receiver dirty, so `changed()` returns at once rather than
        // stranding the task on a stale answer.
        let working = edges.borrow_and_update().busy > 0;
        let renew = {
            let mut controller = service.lock();
            #[cfg(test)]
            {
                controller.passes += 1;
            }
            if controller.stopped {
                return;
            }
            let working = controller.enabled && working;
            match controller.reconcile(working) {
                Ok(next) => next,
                // Nothing is held and a session is working, so this is the one case that keeps a
                // timer without an assertion: retry on the renewal cadence rather than on the
                // next edge, which may be a whole turn away. Only reachable while enabled.
                Err(error) => {
                    tracing::warn!(%error, "Could not keep the machine awake");
                    Some(RENEW_AFTER)
                }
            }
        };
        let woken = match renew {
            // Holding a 60-second lease: renew at 45 seconds even if nothing else happens.
            Some(after) => tokio::select! {
                changed = edges.changed() => changed.is_ok(),
                _ = tokio::time::sleep(after) => true,
            },
            // Nothing is held — disabled, stopped, or no session working. No timer.
            None => edges.changed().await.is_ok(),
        };
        if !woken {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peer_sessions::Activity;
    use std::time::Instant;

    fn sleeper() -> std::io::Result<Child> {
        Command::new("/bin/sleep")
            .arg("120")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    }
    fn service(enabled: bool) -> KeepAwake {
        let service = KeepAwake::default();
        let mut controller = service.lock();
        controller.enabled = enabled;
        controller.spawn = sleeper;
        drop(controller);
        service
    }
    /// The task under test asks nothing unless a test says what the answer is.
    fn no_verify() -> Verify {
        Arc::new(|| -> Pin<Box<dyn Future<Output = ()> + Send>> { Box::pin(async {}) })
    }
    /// A verification that counts, and answers with whatever `answer` does to the watch.
    fn verifier(
        asks: &Arc<std::sync::atomic::AtomicUsize>,
        answer: impl Fn() + Send + Sync + 'static,
    ) -> Verify {
        let asks = Arc::clone(asks);
        Arc::new(move || -> Pin<Box<dyn Future<Output = ()> + Send>> {
            asks.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            answer();
            Box::pin(async {})
        })
    }
    fn asked(asks: &Arc<std::sync::atomic::AtomicUsize>) -> usize {
        asks.load(std::sync::atomic::Ordering::Relaxed)
    }
    fn held() -> Controller {
        Controller {
            enabled: true,
            assertion: Some(Assertion {
                child: sleeper().unwrap(),
                started: tokio::time::Instant::now(),
            }),
            ..Default::default()
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_creates_and_releases_native_assertions() {
        let mut controller = Controller {
            enabled: true,
            ..Default::default()
        };
        controller.reconcile(true).unwrap();
        let marker = format!(
            "pid {}(caffeinate)",
            controller.assertion.as_ref().unwrap().child.id()
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let output = Command::new("/usr/bin/pmset")
                .args(["-g", "assertions"])
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&output.stdout);
            let lines: Vec<_> = text.lines().filter(|line| line.contains(&marker)).collect();
            if [
                "PreventUserIdleSystemSleep",
                "PreventUserIdleDisplaySleep",
                "UserIsActive",
            ]
            .iter()
            .all(|kind| lines.iter().any(|line| line.contains(kind)))
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Native assertions were not created: {text}"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        controller.reconcile(false).unwrap();
        let output = Command::new("/usr/bin/pmset")
            .args(["-g", "assertions"])
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&output.stdout).contains(&marker));
    }

    #[test]
    fn holds_one_assertion_and_releases_on_idle_disable_or_shutdown() {
        for reason in ["idle", "disabled", "shutdown"] {
            let mut controller = held();
            let pid = controller.assertion.as_ref().unwrap().child.id();
            assert!(controller.reconcile(true).unwrap().is_some());
            assert_eq!(controller.assertion.as_ref().unwrap().child.id(), pid);
            controller.enabled = reason != "disabled";
            controller.stopped = reason == "shutdown";
            assert!(controller.reconcile(reason != "idle").unwrap().is_none());
            assert!(controller.assertion.is_none());
        }
    }

    /// The default-off preference costs nothing at all: no RPC, no timer, no wake.
    #[tokio::test(start_paused = true)]
    async fn disabled_parks_with_no_wakeups() {
        let service = service(false);
        let (tx, rx) = tokio::sync::watch::channel(Activity::default());
        let task = tokio::spawn(run(service.clone(), rx, no_verify()));
        tokio::time::sleep(Duration::from_secs(3600)).await;
        assert_eq!(service.lock().passes, 1, "a disabled task must not tick");
        assert!(service.lock().assertion.is_none());
        // Even a busy session must not wake a disabled task into an assertion.
        tx.send_modify(|a| a.busy = 3);
        tokio::time::sleep(Duration::from_secs(3600)).await;
        assert_eq!(service.lock().passes, 2);
        assert!(service.lock().assertion.is_none());
        drop(tx);
        task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn enabled_with_nothing_working_parks_with_no_wakeups() {
        let service = service(true);
        let (tx, rx) = tokio::sync::watch::channel(Activity::default());
        let task = tokio::spawn(run(service.clone(), rx, no_verify()));
        tokio::time::sleep(Duration::from_secs(3600)).await;
        assert_eq!(service.lock().passes, 1);
        assert!(service.lock().assertion.is_none());
        drop(tx);
        task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_busy_edge_takes_the_lease_renews_at_45s_and_an_idle_edge_releases_it() {
        let service = service(true);
        let (tx, rx) = tokio::sync::watch::channel(Activity::default());
        let task = tokio::spawn(run(service.clone(), rx, no_verify()));
        tokio::time::sleep(Duration::from_secs(10)).await;
        assert!(service.lock().assertion.is_none());

        tx.send_modify(|a| a.busy = 1);
        tokio::time::sleep(Duration::from_secs(1)).await;
        let first = service.lock().assertion.as_ref().unwrap().child.id();

        // Held, so one timer is armed — and it is the renewal deadline, not a poll.
        tokio::time::sleep(Duration::from_secs(43)).await;
        assert_eq!(service.lock().passes, 2, "no tick before the renewal is due");
        assert_eq!(service.lock().assertion.as_ref().unwrap().child.id(), first);

        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(service.lock().passes, 3);
        let renewed = service.lock().assertion.as_ref().unwrap().child.id();
        assert_ne!(renewed, first, "the 60 s lease is renewed at 45 s");

        // A second busy session is not a second assertion.
        tx.send_modify(|a| a.busy = 2);
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(service.lock().assertion.as_ref().unwrap().child.id(), renewed);

        tx.send_modify(|a| a.busy = 0);
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(service.lock().assertion.is_none());
        let parked = service.lock().passes;
        tokio::time::sleep(Duration::from_secs(3600)).await;
        assert_eq!(service.lock().passes, parked, "released, so no timer remains");
        drop(tx);
        task.await.unwrap();
    }

    /// Toggling the preference is not a session edge, and must still be acted on at once.
    #[tokio::test(start_paused = true)]
    async fn the_preference_edge_takes_and_releases_the_lease_without_a_session_edge() {
        let service = service(false);
        let (tx, rx) = tokio::sync::watch::channel(Activity { busy: 1, epoch: 0 });
        let task = tokio::spawn(run(service.clone(), rx, no_verify()));
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(service.lock().assertion.is_none());

        service.lock().enabled = true;
        tx.send_modify(|a| a.epoch += 1);
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(service.lock().assertion.is_some());

        service.lock().enabled = false;
        tx.send_modify(|a| a.epoch += 1);
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(service.lock().assertion.is_none());

        service.lock().stopped = true;
        tx.send_modify(|a| a.epoch += 1);
        task.await.unwrap();
    }

    /// A `TurnCompleted` the transport dropped would otherwise hold this machine awake for ever.
    /// At the renewal — and only there — the provider is asked, and a model nothing backs is
    /// cleared rather than believed.
    #[tokio::test(start_paused = true)]
    async fn a_stuck_busy_model_is_re_asked_at_the_renewal_and_the_lease_released() {
        let service = service(true);
        let (tx, rx) = tokio::sync::watch::channel(Activity { busy: 1, epoch: 0 });
        let asks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        // The provider answers idle, so `peer_sessions::reconcile` drops the record and the
        // count it republishes is zero.
        let idle = {
            let tx = tx.clone();
            verifier(&asks, move || tx.send_modify(|a| a.busy = 0))
        };
        let task = tokio::spawn(run(service.clone(), rx, idle));

        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(service.lock().assertion.is_some());
        assert_eq!(asked(&asks), 0, "nothing is asked while the lease is fresh");

        tokio::time::sleep(Duration::from_secs(46)).await;
        assert_eq!(asked(&asks), 1, "one verification, at the renewal");
        assert!(
            service.lock().assertion.is_none(),
            "a model nothing backs releases the machine"
        );

        // Released, so no timer remains and nothing is asked again.
        let parked = service.lock().passes;
        tokio::time::sleep(Duration::from_secs(3600)).await;
        assert_eq!(asked(&asks), 1);
        assert_eq!(service.lock().passes, parked);

        service.lock().stopped = true;
        tx.send_modify(|a| a.epoch += 1);
        task.await.unwrap();
    }

    /// And a session that really is working keeps its lease: the verification is a correction,
    /// not a second opinion that overrides the event stream.
    #[tokio::test(start_paused = true)]
    async fn a_verification_that_confirms_the_work_keeps_the_lease() {
        let service = service(true);
        let (tx, rx) = tokio::sync::watch::channel(Activity { busy: 1, epoch: 0 });
        let asks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let task = tokio::spawn(run(service.clone(), rx, verifier(&asks, || {})));

        tokio::time::sleep(Duration::from_secs(1)).await;
        let first = service.lock().assertion.as_ref().unwrap().child.id();

        tokio::time::sleep(Duration::from_secs(46)).await;
        assert_eq!(asked(&asks), 1);
        let renewed = service.lock().assertion.as_ref().unwrap().child.id();
        assert_ne!(renewed, first, "the lease is renewed, not dropped");

        tokio::time::sleep(Duration::from_secs(45)).await;
        assert_eq!(asked(&asks), 2, "one verification per renewal, not per wake");
        assert!(service.lock().assertion.is_some());

        service.lock().stopped = true;
        tx.send_modify(|a| a.epoch += 1);
        task.await.unwrap();
    }

    /// An edge is not a renewal: a busy app that keeps moving must not turn the verification
    /// into a round trip per event.
    #[tokio::test(start_paused = true)]
    async fn an_activity_edge_alone_asks_the_provider_nothing() {
        let service = service(true);
        let (tx, rx) = tokio::sync::watch::channel(Activity { busy: 1, epoch: 0 });
        let asks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let task = tokio::spawn(run(service.clone(), rx, verifier(&asks, || {})));
        for _ in 0..50 {
            tx.send_modify(|a| a.epoch += 1);
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        assert_eq!(asked(&asks), 1, "one renewal fell inside 50 s, and only one");
        service.lock().stopped = true;
        tx.send_modify(|a| a.epoch += 1);
        task.await.unwrap();
    }

}
