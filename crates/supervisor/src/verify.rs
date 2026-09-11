//! The gate: run a phase's verify command and read its **real exit code**.
//!
//! `docs/vision.md` calls this the gate — *"the gate is a real exit code"* — and the whole point
//! of the file is that no model ever reports it. A child can claim a phase is done; only the
//! number this module returns settles it.
//!
//! Three things here are load-bearing and each of them was arrived at by measurement rather than
//! by taste:
//!
//! - **`stdin` is [`Stdio::null`].** An interactive prompt inside a verify command must reach EOF
//!   and die, not wedge an unattended run forever.
//! - **`pipefail` is probed, never assumed.** `/bin/sh` on this machine is bash in `sh` mode and
//!   takes `set -o pipefail`; a `dash` `sh` answers `set: Illegal option -o pipefail` at exit 2,
//!   so a blanket prefix would turn a green gate red. The probe is [`GateEnv::pipefail`].
//! - **The timeout kills the process group, not the pid.** `cargo test` spawns children.
//!   `brigadier_proc::sweep::kill_group_sync` already does group kill and is used rather than
//!   reimplemented.
//!
//! And one that is not about the command at all: **`PATH` is resolved deliberately.** A
//! Finder-launched macOS app gets `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, in which `cargo` and
//! `npm` are both **missing** while `git` is present (**measured**,
//! `docs/research/gate-environment.md` §2). Without [`GateEnv::resolve`] a double-clicked
//! brigadier runs `cargo test` and gets exit 127 — which is why 127 has its own reason slug and
//! reads as *the plan named a command this machine does not have*, never as *the code is broken*.
//!
//! The output never comes back through this API. It goes to one file, interleaved, and
//! [`GateResult`] carries the path to it and not a byte of its content
//! (`docs/research/orchestration-loop.md` §6.4).
// see docs/research/orchestration-loop.md §6 for the design and its measured exit-code table, and
// docs/research/gate-environment.md §4 for the PATH rules this file implements.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use brigadier_core::event::SessionId;
use serde::Serialize;
use tokio::process::Command;

use crate::tracker::ProcessTracker;

/// How long [`GateEnv::resolve`] waits for `$SHELL -l -i -c` before giving up on it.
///
/// The measurement behind the number is weak on purpose and says so: that shell returned
/// somewhere **between 5 s and 13 s** on this machine, sampled twice under load
/// (`docs/research/gate-environment.md` §3, **measured**, weakly). Anything under 5 s therefore
/// guarantees the fallback and throws away the only source that finds `npm`; 13 s of stall on the
/// launch path is not acceptable. 10 s sits inside the measured band — an **asserted** bound, not
/// a measurement — and on a loaded machine it will sometimes fall back, which is why
/// [`PathSource`] is recorded rather than assumed.
pub const PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Grace between `SIGTERM` and `SIGKILL` when a timed-out gate's process group is killed.
///
/// The same value the orphan sweep uses, and it comes with the same caveat: it was measured
/// against `sleep` and `sh`, not against a build system (`docs/research/orphan-sweep.md` §5).
pub const KILL_GRACE: Duration = brigadier_proc::sweep::DEFAULT_GRACE;

/// Toolchain directories no shell startup file on this machine exports, appended to whatever
/// `PATH` was resolved, in this order, and **only if they exist on disk**.
///
/// `~/.cargo/bin` is first because it is the one that is missing from every measured source:
/// not the GUI default, not `$SHELL -l -c`, not `$SHELL -l -i -c`
/// (`docs/research/gate-environment.md` §3, **measured**). This is the one place in brigadier
/// where a hardcoded path list is the correct answer, because the alternative is a gate that
/// cannot run this repository's own verify command.
const WELL_KNOWN_BIN_DIRS: &[&str] = &[
    ".cargo/bin",
    ".local/bin",
    ".bun/bin",
    ".volta/bin",
    "go/bin",
];

/// Absolute toolchain directories appended on the same terms as [`WELL_KNOWN_BIN_DIRS`].
const WELL_KNOWN_ABS_BIN_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
];

/// Where the `PATH` a gate runs with came from, so a 127 can be explained rather than guessed at.
///
/// `docs/research/gate-environment.md` §4 rule 1: *never inherit the launch PATH and hope*.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PathSource {
    /// `$SHELL -l -i -c 'printf %s "$PATH"'` answered inside [`PATH_PROBE_TIMEOUT`]. The only
    /// measured source that finds `npm` on this machine.
    LoginShell,
    /// The login shell did not answer in time and the harness's own `PATH` was used instead.
    /// The likeliest reason a toolchain is missing.
    LoginShellTimedOut,
    /// There was no login shell to ask — no `$SHELL`, or it could not be spawned — so the
    /// harness's own `PATH` was used.
    Inherited,
    /// The caller supplied a `PATH` outright. Tests, and any future explicit configuration.
    Explicit,
}

/// Why a gate run ended the way it did. A closed set, and four of the five are red.
///
/// The distinction that matters is [`CommandNotFound`](Self::CommandNotFound): it is a **plan
/// defect** — the plan named a command this machine does not have — and it must never be
/// presented to the owner as *the code is broken*
/// (`docs/research/gate-environment.md` §4 rule 4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GateReason {
    /// Exit 0. The only green.
    Passed,
    /// A non-zero exit that is not 127. The verify command ran and said no.
    Failed,
    /// Exit 127: `sh` could not find the program. A plan defect, not a code defect.
    CommandNotFound,
    /// The process was killed by a signal, so `std::process::ExitStatus::code` was `None`.
    /// **Red, never green** — an OOM-killed test run has no code and must not be read as a pass.
    Signalled,
    /// The deadline expired and the process **group** was killed.
    TimedOut,
}

impl GateReason {
    /// Whether the gate went green. Only [`Passed`](Self::Passed) does.
    #[must_use]
    pub fn is_green(self) -> bool {
        matches!(self, Self::Passed)
    }

    /// The stable slug the plan card, the feed line and the lead call all use.
    #[must_use]
    pub fn slug(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::CommandNotFound => "command_not_found",
            Self::Signalled => "signalled",
            Self::TimedOut => "timed_out",
        }
    }
}

/// The environment every gate on this launch runs in: one resolved `PATH` and one `pipefail`
/// answer, both bought once.
///
/// Resolving is not free — [`PATH_PROBE_TIMEOUT`] is ten seconds in the worst case — so this is
/// built once per launch and shared. Both facts it holds are about the machine, not about the
/// phase, so nothing here changes between gate runs.
#[derive(Clone)]
pub struct GateEnv {
    shell: PathBuf,
    path: OsString,
    path_source: PathSource,
    pipefail: bool,
    /// The app's pid tracker, when there is one. A gate child is in its own process group and
    /// outlives a force-quit exactly as a session's child does, so it gets the same record and
    /// the same next-start sweep (`docs/research/lifecycle-bounds-audit-2026-09-11.md` §3 gap 2).
    tracker: Option<Arc<dyn ProcessTracker>>,
}

/// Hand-written because [`ProcessTracker`] is not `Debug`: whether one is attached is the only
/// thing about it this type can usefully print.
impl std::fmt::Debug for GateEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GateEnv")
            .field("shell", &self.shell)
            .field("path", &self.path)
            .field("path_source", &self.path_source)
            .field("pipefail", &self.pipefail)
            .field("tracked", &self.tracker.is_some())
            .finish()
    }
}

impl GateEnv {
    /// The `sh` every verify command is run through.
    #[must_use]
    pub fn shell(&self) -> &Path {
        &self.shell
    }

    /// The `PATH` handed to every verify command.
    #[must_use]
    pub fn path(&self) -> &OsStr {
        &self.path
    }

    /// Where that `PATH` came from.
    #[must_use]
    pub fn path_source(&self) -> PathSource {
        self.path_source
    }

    /// Whether [`Self::shell`] accepted `set -o pipefail`, **probed** rather than assumed.
    ///
    /// When this is false the prefix is not applied and a pipeline reports its **last** command,
    /// which is the `tail` trap: `false | true` exits 0 (**measured**). That is a worse gate, and
    /// it is still better than the alternative — a blanket prefix under a `dash` `sh` exits 2 on
    /// every command and turns a green gate red.
    #[must_use]
    pub fn pipefail(&self) -> bool {
        self.pipefail
    }

    /// Resolve the launch environment: a deliberate `PATH`, then one `pipefail` probe.
    ///
    /// Call once per launch and keep the result. `shell` is `/bin/sh` in production; the
    /// parameter exists so a test can point it at a stub that rejects `-o pipefail`.
    pub async fn resolve(shell: impl Into<PathBuf>) -> Self {
        let (path, path_source) = resolved_path().await;
        Self::with_path(shell, path, path_source).await
    }

    /// Record every gate child under `tracker`, so a force-quit mid-`cargo test` is recoverable.
    ///
    /// Without one the gate still runs and its own timeout still kills its group; what is lost is
    /// the pid record the next launch's sweep reads.
    #[must_use]
    pub fn with_tracker(mut self, tracker: Arc<dyn ProcessTracker>) -> Self {
        self.tracker = Some(tracker);
        self
    }

    /// [`Self::resolve`] with the `PATH` supplied rather than discovered.
    ///
    /// The `pipefail` probe still runs: it is a fact about the shell, and the shell is what the
    /// caller is usually overriding.
    pub async fn with_path(
        shell: impl Into<PathBuf>,
        path: OsString,
        path_source: PathSource,
    ) -> Self {
        let shell = shell.into();
        let pipefail = probe_pipefail(&shell, &path).await;
        Self {
            shell,
            path,
            path_source,
            pipefail,
            tracker: None,
        }
    }
}

/// One gate run, described.
#[derive(Clone, Debug)]
pub struct GateRequest {
    /// The phase's **stored** verify command, verbatim. The harness never invents one.
    pub command: String,
    /// The per-phase integration worktree. **Never the project root**, and never a live worker's
    /// worktree, which carries that worker's uncommitted dirt
    /// (`docs/research/orchestration-loop.md` §6.1).
    pub cwd: PathBuf,
    /// Where stdout and stderr are interleaved, conventionally
    /// `<data_dir>/gates/<phase_id>/<attempt>.log`. Parent directories are created.
    pub log_path: PathBuf,
    /// Wall-clock deadline. On expiry the process **group** is killed and the reason is
    /// [`GateReason::TimedOut`].
    pub timeout: Duration,
}

/// What the gate found. **Carries no output** — only the path to it.
///
/// A bounded tail was considered and rejected: it is the beginning of the thread accumulating
/// output, and the one window that actually needs the output — the rung-1 fixer — can read the
/// file with its own tools at zero cost to the harness
/// (`docs/research/orchestration-loop.md` §6.4).
#[derive(Clone, Debug, Serialize)]
pub struct GateResult {
    /// The command as it was stored and as it was run, before any `pipefail` prefix.
    pub command: String,
    /// The real exit code, or `None` when the process was signalled. `None` is **red**.
    pub exit_code: Option<i32>,
    /// The signal that killed it, when there was one.
    pub signal: Option<i32>,
    /// Why it ended.
    pub reason: GateReason,
    /// Wall clock from spawn to reap.
    pub duration: Duration,
    /// Where the interleaved output went.
    pub log_path: PathBuf,
    /// Whether `set -o pipefail` was prefixed. False means a pipeline in `command` reported only
    /// its last stage, and the plan card should say so.
    pub pipefail: bool,
}

impl GateResult {
    /// Whether the phase may go green on this run.
    #[must_use]
    pub fn is_green(&self) -> bool {
        self.reason.is_green()
    }

    /// The single harness-derived line the thread is allowed to carry, `docs/vision.md` §9's
    /// shape. No tail, no excerpt.
    #[must_use]
    pub fn feed_line(&self, phase_label: &str) -> String {
        match self.exit_code {
            Some(0) => format!("{phase_label} green — {} exited 0.", self.command),
            Some(code) => format!("{phase_label} red — {} exited {code}.", self.command),
            None => format!(
                "{phase_label} red — {} was killed ({}).",
                self.command,
                self.reason.slug()
            ),
        }
    }
}

/// How long a gate waits for another gate on the same worktree to release its workspace lease.
///
/// The case this exists for is a **cancelled** gate: dropping [`run`]'s future leaves the real
/// work in a detached task that is still killing its process group, and that task holds the
/// lease until it returns. A stop followed at once by a restart would otherwise fail on a lease
/// that is milliseconds from being released
/// (`docs/research/verify-and-telemetry-audit-2026-09-11.md` §2 G1). Comfortably longer than
/// `SIGTERM` + [`KILL_GRACE`] + `SIGKILL` + reap; a gate that is genuinely still running is
/// still refused, one bound later.
pub const LEASE_HANDOVER_BOUND: Duration = Duration::from_secs(5);

/// Gate runs that have not yet released their workspace lease: `cwd` → run id → *was this run
/// cancelled*. Plus the edge that fires whenever one of them lets go of a tree.
type InFlightGates = (
    Mutex<HashMap<PathBuf, HashMap<u64, bool>>>,
    tokio::sync::watch::Sender<u64>,
);
static IN_FLIGHT: OnceLock<InFlightGates> = OnceLock::new();
static NEXT_RUN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
fn in_flight() -> &'static InFlightGates {
    IN_FLIGHT.get_or_init(|| (Mutex::new(HashMap::new()), tokio::sync::watch::channel(0).0))
}
#[cfg(test)]
fn in_flight_count(cwd: &Path) -> usize {
    in_flight()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(cwd)
        .map_or(0, HashMap::len)
}
/// Whether a **cancelled** run still holds this tree. Nothing else earns a wait: a gate that is
/// genuinely running is refused at once, exactly as before.
fn releasing(cwd: &Path) -> bool {
    in_flight()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(cwd)
        .is_some_and(|runs| runs.values().any(|cancelled| *cancelled))
}

/// Counts one gate run as holding `cwd` for as long as it lives. Created by [`run`] **before**
/// the task is spawned, so a cancellation can always find the entry, and dropped by that task
/// after its lease — the edge it fires means the lease is already released.
struct InFlight {
    cwd: PathBuf,
    id: u64,
}
impl InFlight {
    fn enter(cwd: &Path) -> Self {
        let id = NEXT_RUN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        in_flight()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(cwd.to_path_buf())
            .or_default()
            .insert(id, false);
        Self {
            cwd: cwd.to_path_buf(),
            id,
        }
    }
}
impl Drop for InFlight {
    fn drop(&mut self) {
        {
            let mut live = in_flight().0.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(runs) = live.get_mut(&self.cwd) {
                runs.remove(&self.id);
                if runs.is_empty() {
                    live.remove(&self.cwd);
                }
            }
        }
        in_flight().1.send_modify(|v| *v = v.wrapping_add(1));
    }
}

/// Marks a run cancelled the instant [`run`]'s future is dropped — synchronously, in the
/// canceller's own context, so a restart issued on the next line cannot miss it.
///
/// This is the observable half of G1: the detached task is still killing its process group and
/// still holds the lease, and this is what says so.
struct CancelMark {
    cwd: PathBuf,
    id: u64,
    armed: bool,
}
impl CancelMark {
    fn arm(in_flight: &InFlight) -> Self {
        Self {
            cwd: in_flight.cwd.clone(),
            id: in_flight.id,
            armed: true,
        }
    }
    fn disarm(mut self) {
        self.armed = false;
    }
}
impl Drop for CancelMark {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Some(cancelled) = in_flight()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&self.cwd)
            .and_then(|runs| runs.get_mut(&self.id))
        {
            *cancelled = true;
        }
    }
}

/// Take the workspace lease, waiting up to `bound` only for a **cancelled** gate on the same tree
/// to finish its kill and let go.
///
/// Exclusion is unchanged: a live gate's refusal is returned immediately, and a cancelled one
/// that will not let go is refused once `bound` has passed.
async fn acquire_workspace(
    cwd: &Path,
    bound: Duration,
) -> std::io::Result<brigadier_core::checkpoint::WorkspaceLease> {
    let deadline = Instant::now() + bound;
    let mut edges = in_flight().1.subscribe();
    loop {
        let refusal = match brigadier_core::checkpoint::WorkspaceLease::acquire(cwd) {
            Ok(lease) => return Ok(lease),
            Err(e) => e,
        };
        let left = deadline.saturating_duration_since(Instant::now());
        if !releasing(cwd) || left.is_zero() {
            return Err(std::io::Error::other(refusal));
        }
        if tokio::time::timeout(left, edges.changed()).await.is_err() {
            return Err(std::io::Error::other(refusal));
        }
    }
}

/// Names one gate child in the pid registry. Unique per launch, and no session id can collide
/// with it.
static NEXT_GATE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// One tracked gate child, untracked whatever ends the run — pass, fail, timeout or cancel.
struct TrackedGate {
    tracker: Arc<dyn ProcessTracker>,
    id: SessionId,
}
impl TrackedGate {
    fn track(tracker: &Arc<dyn ProcessTracker>, pid: u32, binary: &Path, cwd: &Path) -> Self {
        let id = SessionId::new(format!(
            "gate-{}",
            NEXT_GATE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        tracker.track(&id, pid, binary, cwd);
        Self {
            tracker: Arc::clone(tracker),
            id,
        }
    }
}
impl Drop for TrackedGate {
    fn drop(&mut self) {
        self.tracker.untrack(&self.id);
    }
}

/// Run one verify command and return its real exit code.
///
/// # Errors
/// [`std::io::Error`] only when the run could not be **started**: the log file would not open, or
/// the shell would not spawn. Every outcome of a command that actually ran — including 127, a
/// signal and a timeout — comes back as an `Ok(GateResult)` with a reason slug, because those are
/// results, not failures of the harness.
pub async fn run(env: &GateEnv, req: &GateRequest) -> std::io::Result<GateResult> {
    let env = env.clone();
    let req = req.clone();
    let (cancel, receiver) = tokio::sync::oneshot::channel::<()>();
    // Registered here rather than inside the task, so the mark below always has an entry to set
    // even if this future is dropped before the task is first polled.
    let in_flight = InFlight::enter(&req.cwd);
    let cancelled = CancelMark::arm(&in_flight);
    let task = tokio::spawn(async move {
        let _in_flight = in_flight;
        run_owned(&env, &req, receiver).await
    });
    let result = task.await.map_err(std::io::Error::other)?;
    cancelled.disarm();
    drop(cancel);
    result
}
async fn run_owned(
    env: &GateEnv,
    req: &GateRequest,
    mut cancel: tokio::sync::oneshot::Receiver<()>,
) -> std::io::Result<GateResult> {
    // The registry entry is the caller's (`run`), and is dropped only once this task returns —
    // which is what lets the *next* gate on this tree wait for a cancelled run's lease instead
    // of failing on it.
    let _lease = acquire_workspace(&req.cwd, LEASE_HANDOVER_BOUND).await?;
    if let Some(parent) = req.log_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // One file, two dup'd descriptors. A `dup` shares the file *description*, so the two streams
    // share one offset and interleave in the order they were written — which is the whole reason
    // the output is not piped into the harness and re-serialised.
    let log = std::fs::File::create(&req.log_path)?;
    let log_err = log.try_clone()?;

    let script = if env.pipefail {
        // A newline, not a `;`: a verify command that begins with a comment or a heredoc must not
        // be swallowed by the prefix.
        format!("set -o pipefail\n{}", req.command)
    } else {
        req.command.clone()
    };

    let mut cmd = Command::new(&env.shell);
    cmd.arg("-c").arg(&script);
    cmd.current_dir(&req.cwd);
    // The environment is inherited and then overridden, rather than cleared: a verify command is
    // somebody's build, and `HOME`, `TMPDIR` and `USER` are load-bearing for every build system
    // there is. What is set below is the part brigadier has an opinion about.
    cmd.env("PATH", &env.path)
        // stderr stays parseable under any locale, the same reason every git call in this tree
        // pins it (`crates/core/src/worktree.rs`).
        .env("LC_ALL", "C")
        .env("LANGUAGE", "")
        // A verify command that touches git must not open a credential prompt.
        .env("GIT_TERMINAL_PROMPT", "0")
        // **asserted**, not verified for this repository's runners: the convention is that `CI`
        // makes many runners non-interactive and uncoloured. `docs/research/gate-environment.md`
        // §5 says explicitly that it did not improve on this and nothing here does either.
        .env("CI", "1")
        // This is not a model call. The MCP flags are argv-level and simply absent here; the
        // thinking lever is an environment variable, so it has to be removed rather than omitted.
        // see docs/research/thinking-control.md §4b.
        .env_remove("MAX_THINKING_TOKENS");
    // The single most important line in the file: an interactive prompt must EOF, not wedge the
    // run (`docs/research/orchestration-loop.md` §6.2).
    cmd.stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    // Own process group, so the timeout can reach the children `cargo test` spawns rather than
    // orphaning them behind a dead `sh`.
    #[cfg(unix)]
    cmd.process_group(0);

    let started = Instant::now();
    let mut child = cmd.spawn()?;
    let pid = child.id();
    // The record the next launch's sweep reads. Dropped on every exit path below, so a gate that
    // ended normally leaves nothing behind for the sweep to judge.
    let _tracked = match (&env.tracker, pid) {
        (Some(tracker), Some(pid)) => Some(TrackedGate::track(tracker, pid, &env.shell, &req.cwd)),
        _ => None,
    };

    let waited = tokio::select! {
        waited=tokio::time::timeout(req.timeout,child.wait())=>waited,
        _=&mut cancel=>{
            kill_group(&mut child,pid).await;let _=child.wait().await;
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted,"Verification cancelled"));
        }
    };
    let status = match waited {
        Ok(status) => status?,
        Err(_) => {
            kill_group(&mut child, pid).await;
            // Reap, so the timed-out gate leaves no zombie behind. The status is discarded: the
            // reason is the timeout, not whatever signal ended it.
            let _ = child.wait().await;
            return Ok(GateResult {
                command: req.command.clone(),
                exit_code: None,
                signal: None,
                reason: GateReason::TimedOut,
                duration: started.elapsed(),
                log_path: req.log_path.clone(),
                pipefail: env.pipefail,
            });
        }
    };
    let duration = started.elapsed();

    let exit_code = status.code();
    let signal = signal_of(&status);
    let reason = match exit_code {
        Some(0) => GateReason::Passed,
        // `sh` answers 127 for "command not found". The plan named a command this machine does
        // not have; that is a plan defect and it gets its own slug so it never reads as a code
        // defect. **measured**, `docs/research/orchestration-loop.md` §6.3.
        Some(127) => GateReason::CommandNotFound,
        Some(_) => GateReason::Failed,
        // No code means a signal, and a signal is red. An OOM-killed `cargo test` lands here.
        None => GateReason::Signalled,
    };
    // The `PATH` this ran with could not reach the command. It may be the plan's fault, and it
    // may be a toolchain installed since the probe; the next gate re-asks rather than repeating
    // this answer for the rest of the process's life.
    if reason == GateReason::CommandNotFound {
        forget_resolved_path().await;
    }

    Ok(GateResult {
        command: req.command.clone(),
        exit_code,
        signal,
        reason,
        duration,
        log_path: req.log_path.clone(),
        pipefail: env.pipefail,
    })
}

#[cfg(unix)]
fn signal_of(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn signal_of(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

/// Kill the timed-out gate's process **group**, not its pid.
///
/// `crates/proc/` exists for exactly this problem and already does `SIGTERM`, wait, `SIGKILL`
/// over a whole group, so it is used rather than reimplemented. The child was spawned with
/// `process_group(0)`, so its pid is its pgid.
async fn kill_group(child: &mut tokio::process::Child, pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pgid) = pid {
        let outcome = tokio::task::spawn_blocking(move || {
            brigadier_proc::sweep::kill_group_sync(pgid, KILL_GRACE)
        })
        .await;
        match outcome {
            Ok(o) if !o.still_alive => return,
            Ok(o) => tracing::warn!(
                pgid,
                escalated = o.escalated,
                "gate process group survived the kill; falling back to killing the leader"
            ),
            Err(e) => tracing::warn!(pgid, error = %e, "gate group kill task failed"),
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
    // Belt and braces on every platform, and the only path on non-unix.
    let _ = child.start_kill();
}

/// Ask the shell whether it takes `set -o pipefail`, once.
///
/// **measured**: `/bin/sh` here is GNU bash 3.2.57(1) in `sh` mode and exits 0;
/// `/bin/dash -c 'set -o pipefail; false|true'` exits **2** with `set: Illegal option -o
/// pipefail`. Assuming rather than probing would turn every gate under a `dash` `sh` red.
async fn probe_pipefail(shell: &Path, path: &OsStr) -> bool {
    let mut cmd = Command::new(shell);
    cmd.arg("-c")
        .arg("set -o pipefail")
        .env("PATH", path)
        .env("LC_ALL", "C")
        .env("LANGUAGE", "")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match cmd.status().await {
        Ok(status) => status.success(),
        // A shell that will not spawn is a much larger problem than pipefail, and it will be
        // reported by the first gate run. Refusing the prefix is the safe answer either way.
        Err(e) => {
            tracing::warn!(shell = %shell.display(), error = %e, "pipefail probe could not run");
            false
        }
    }
}

/// The one probe result for this process, or `None` until the first resolve.
///
/// The probe is a fact about the **machine**, not about the shell a caller runs commands through
/// (`docs/research/verify-and-telemetry-audit-2026-09-11.md` §5 a1), so a `GateEnv` on `$SHELL`
/// and one on `/bin/sh` share it while each keeps its own `pipefail` answer. Before 2026-09-11
/// it was paid once per `Run` and again for the updater — up to
/// [`PATH_PROBE_TIMEOUT`] each time.
static RESOLVED_PATH: tokio::sync::Mutex<Option<(OsString, PathSource)>> =
    tokio::sync::Mutex::const_new(None);

/// The machine's resolved `PATH` and where it came from, probed at most once per process **once
/// a login shell has answered**.
///
/// Concurrent callers serialize on the cache rather than each spawning a login shell: the first
/// pays the probe, the rest wait for it.
///
/// A fallback answer is deliberately **not** cached. `LoginShellTimedOut` under momentary load,
/// or `Inherited` before `$SHELL` is set, is a snapshot of a bad moment; caching it would make
/// that moment this process's `PATH` for the rest of its life, and the only symptom is gates
/// that cannot find `npm`. The cost is that a machine that keeps timing out re-pays up to
/// [`PATH_PROBE_TIMEOUT`] per gate — ten seconds against a gate that runs a build, and against a
/// launch that would otherwise be permanently wrong.
pub async fn resolved_path() -> (OsString, PathSource) {
    resolved_path_from(resolve_path()).await
}

async fn resolved_path_from(
    probe: impl std::future::Future<Output = (OsString, PathSource)>,
) -> (OsString, PathSource) {
    let mut slot = RESOLVED_PATH.lock().await;
    if let Some(cached) = slot.as_ref() {
        return cached.clone();
    }
    let resolved = probe.await;
    if resolved.1 == PathSource::LoginShell {
        *slot = Some(resolved.clone());
    }
    resolved
}

/// Discard the cached probe so the next [`resolved_path`] asks the machine again.
///
/// Called by [`run`] on a gate that exited 127: the plan named a command this `PATH` cannot
/// reach, and a toolchain installed after the probe — `rustup`, `nvm`, a fresh `brew install` —
/// is exactly the case where asking again is worth up to [`PATH_PROBE_TIMEOUT`]. Nothing calls it
/// on a timer, and a gate that finds its command never pays for it.
pub async fn forget_resolved_path() {
    *RESOLVED_PATH.lock().await = None;
}

/// Resolve a `PATH` for gates, deliberately, once.
///
/// The ladder is `docs/research/gate-environment.md` §4: ask `$SHELL -l -i -c` under a timeout,
/// fall back to the inherited `PATH` when it does not answer, then append the well-known
/// toolchain directories that no shell startup exports — `~/.cargo/bin` first — that exist on
/// disk. `-l` alone is not enough: it reads `.zprofile` and not `.zshrc`, and `.zshrc` is where
/// this machine's node toolchain lives (**measured**).
async fn resolve_path() -> (OsString, PathSource) {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let (base, source) = match login_shell_path().await {
        LoginShellPath::Found(p) => (OsString::from(p), PathSource::LoginShell),
        LoginShellPath::TimedOut => (inherited, PathSource::LoginShellTimedOut),
        LoginShellPath::Unavailable => (inherited, PathSource::Inherited),
    };
    (append_well_known(&base), source)
}

/// What the login-shell probe produced. `TimedOut` is kept distinct from `Unavailable` because
/// they explain a later 127 differently.
enum LoginShellPath {
    Found(String),
    TimedOut,
    Unavailable,
}

async fn login_shell_path() -> LoginShellPath {
    let Some(shell) = std::env::var_os("SHELL") else {
        return LoginShellPath::Unavailable;
    };
    let mut cmd = Command::new(&shell);
    // `-i` is what costs — an interactive shell with no tty runs the owner's whole interactive
    // startup, 5–13 s here — and it is also the only thing that reads `.zshrc`. `stdin` is null
    // rather than a tty precisely so it cannot block on a prompt; the timeout is the second net.
    cmd.args(["-l", "-i", "-c", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            tracing::warn!(shell = ?shell, error = %e, "login shell would not spawn; using the inherited PATH");
            return LoginShellPath::Unavailable;
        }
    };
    match tokio::time::timeout(PATH_PROBE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) if out.status.success() => {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_owned();
            if path.is_empty() {
                LoginShellPath::Unavailable
            } else {
                LoginShellPath::Found(path)
            }
        }
        Ok(Ok(_)) | Ok(Err(_)) => LoginShellPath::Unavailable,
        Err(_) => {
            tracing::warn!(
                timeout_ms = PATH_PROBE_TIMEOUT.as_millis() as u64,
                "login shell did not print a PATH in time; using the inherited one"
            );
            LoginShellPath::TimedOut
        }
    }
}

/// Append [`WELL_KNOWN_BIN_DIRS`] and [`WELL_KNOWN_ABS_BIN_DIRS`] that exist on disk, preserving
/// order and dropping duplicates. Nothing is ever removed from the resolved `PATH`.
fn append_well_known(base: &OsStr) -> OsString {
    let mut entries: Vec<PathBuf> = std::env::split_paths(base).collect();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let candidates = WELL_KNOWN_BIN_DIRS
        .iter()
        .filter_map(|rel| home.as_ref().map(|h| h.join(rel)))
        .chain(WELL_KNOWN_ABS_BIN_DIRS.iter().map(PathBuf::from));
    for dir in candidates {
        if dir.is_dir() && !entries.iter().any(|e| e == &dir) {
            entries.push(dir);
        }
    }
    std::env::join_paths(entries).unwrap_or_else(|_| base.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tempdir with a log directory and a place to put `sh` scripts.
    struct Rig {
        dir: tempfile::TempDir,
    }

    impl Rig {
        fn new() -> Self {
            Self {
                dir: tempfile::tempdir().expect("tempdir"),
            }
        }

        fn at(&self, name: &str) -> PathBuf {
            self.dir.path().join(name)
        }

        fn req(&self, command: &str) -> GateRequest {
            GateRequest {
                command: command.to_owned(),
                cwd: self.dir.path().to_path_buf(),
                log_path: self.at("gate.log"),
                timeout: Duration::from_secs(30),
            }
        }

        fn log(&self) -> String {
            std::fs::read_to_string(self.at("gate.log")).expect("log file")
        }
    }

    /// `/bin/sh`, with `PATH` supplied so no test ever pays for the login-shell probe.
    async fn sh_env() -> GateEnv {
        GateEnv::with_path(
            "/bin/sh",
            OsString::from("/usr/bin:/bin:/usr/sbin:/sbin"),
            PathSource::Explicit,
        )
        .await
    }

    /// The same shell with the `pipefail` prefix forced off, so the pipeline rows of the measured
    /// table can be asserted in both directions.
    async fn sh_env_no_pipefail() -> GateEnv {
        let mut env = sh_env().await;
        env.pipefail = false;
        env
    }

    // ---- the six measured rows of docs/research/orchestration-loop.md §6.3 ----

    /// Row 1, the baseline. `sh -c 'exit 7'` → 7.
    #[tokio::test]
    async fn exit_seven_is_seven_and_red() {
        let rig = Rig::new();
        let out = run(&sh_env().await, &rig.req("exit 7")).await.expect("ran");
        assert_eq!(out.exit_code, Some(7));
        assert_eq!(out.reason, GateReason::Failed);
        assert!(!out.is_green());
    }

    /// Row 2, the `tail` trap: without `pipefail` a pipeline reports its **last** command, so
    /// `false | true` exits 0 and a gate that trusted it would go green on a failing build.
    #[tokio::test]
    async fn a_pipeline_without_pipefail_reports_its_last_command() {
        let rig = Rig::new();
        let out = run(&sh_env_no_pipefail().await, &rig.req("false | true"))
            .await
            .expect("ran");
        assert_eq!(out.exit_code, Some(0), "the measured tail trap");
        assert!(out.is_green());
        assert!(!out.pipefail);
    }

    /// Row 3: the same pipeline under `set -o pipefail` on this machine's `/bin/sh` (GNU bash
    /// 3.2.57(1) in `sh` mode) exits 1. This is the row that makes the prefix worth applying.
    #[tokio::test]
    async fn a_pipeline_with_pipefail_reports_the_failing_stage() {
        let env = sh_env().await;
        if !env.pipefail() {
            // A machine whose `/bin/sh` is dash has nothing to assert here; the dash behaviour is
            // covered by `a_shell_that_rejects_pipefail_gets_no_prefix`.
            return;
        }
        let rig = Rig::new();
        let out = run(&env, &rig.req("false | true")).await.expect("ran");
        assert_eq!(out.exit_code, Some(1));
        assert_eq!(out.reason, GateReason::Failed);
    }

    /// Row 5: `kill -9 $$` leaves `ExitStatus::code() == None`. **Red, never green.**
    #[tokio::test]
    async fn a_signalled_command_has_no_code_and_is_red() {
        let rig = Rig::new();
        let out = run(&sh_env().await, &rig.req("kill -9 $$"))
            .await
            .expect("ran");
        assert_eq!(out.exit_code, None, "a signalled process has no exit code");
        assert_eq!(out.reason, GateReason::Signalled);
        assert!(!out.is_green());
        #[cfg(unix)]
        assert_eq!(out.signal, Some(9));
    }

    /// Row 6: 127 is a **plan defect** and gets its own slug. This is the exact code a
    /// Finder-launched brigadier gets for `cargo test`
    /// (`docs/research/gate-environment.md` §2, **measured**).
    #[tokio::test]
    async fn command_not_found_is_one_hundred_and_twenty_seven_with_its_own_slug() {
        // A 127 discards the cached `PATH`, which the two probe tests below own.
        let _serial = PATH_CACHE.lock().await;
        let rig = Rig::new();
        let out = run(&sh_env().await, &rig.req("nosuchprogram_xyz"))
            .await
            .expect("ran");
        assert_eq!(out.exit_code, Some(127));
        assert_eq!(out.reason, GateReason::CommandNotFound);
        assert_eq!(out.reason.slug(), "command_not_found");
        assert!(!out.is_green());
    }

    /// And that discard is the point: a tool installed after the probe is otherwise unreachable
    /// for the rest of the process's life, because the `PATH` that cannot see it is cached.
    #[tokio::test]
    async fn a_gate_that_cannot_find_its_command_discards_the_cached_path() {
        let _serial = PATH_CACHE.lock().await;
        forget_resolved_path().await;
        let primed = resolved_path_from(async {
            (OsString::from("/stub/bin"), PathSource::LoginShell)
        })
        .await;
        assert_eq!(primed.1, PathSource::LoginShell);

        let rig = Rig::new();
        let out = run(&sh_env().await, &rig.req("nosuchprogram_xyz"))
            .await
            .expect("ran");
        assert_eq!(out.reason, GateReason::CommandNotFound);

        let after = resolved_path_from(async {
            (OsString::from("/stub/reprobed"), PathSource::LoginShell)
        })
        .await;
        assert_eq!(
            after.0,
            OsString::from("/stub/reprobed"),
            "the next gate asks the machine again"
        );

        // A gate that *does* find its command leaves the cache alone.
        let green = run(&sh_env().await, &rig.req("printf ok")).await.expect("ran");
        assert!(green.is_green());
        assert_eq!(
            resolved_path_from(async { (OsString::from("/stub/third"), PathSource::LoginShell) })
                .await
                .0,
            OsString::from("/stub/reprobed")
        );
        forget_resolved_path().await;
    }

    /// Row 4, the dash row, via a stub `sh` that answers `set: Illegal option -o pipefail` at
    /// exit 2. The probe must see that and apply **no prefix**, and the gate must not be
    /// reddened by it.
    #[tokio::test]
    async fn a_shell_that_rejects_pipefail_gets_no_prefix_and_is_not_reddened() {
        let rig = Rig::new();
        let stub = rig.at("dashish-sh");
        std::fs::write(
            &stub,
            "#!/bin/sh\n\
             case \"$2\" in *pipefail*) echo 'set: Illegal option -o pipefail' >&2; exit 2;; esac\n\
             exec /bin/sh -c \"$2\"\n",
        )
        .expect("write stub");
        make_executable(&stub);

        let env = GateEnv::with_path(
            &stub,
            OsString::from("/usr/bin:/bin:/usr/sbin:/sbin"),
            PathSource::Explicit,
        )
        .await;
        assert!(!env.pipefail(), "the probe must notice the refusal");

        let out = run(&env, &rig.req("printf ok")).await.expect("ran");
        assert_eq!(out.exit_code, Some(0), "no prefix, so nothing to reject");
        assert!(out.is_green());
        assert!(!out.pipefail);
        let log = rig.log();
        assert_eq!(log, "ok");
        assert!(
            !log.contains("Illegal option"),
            "the prefix must never have been applied"
        );
    }

    #[tokio::test]
    async fn cancellation_kills_the_writer_before_releasing_its_workspace() {
        let rig = Rig::new();
        let req = rig.req("(sleep 0.2; touch escaped) & printf ready > ready; sleep 30");
        let env = sh_env().await;
        let task = tokio::spawn(async move { run(&env, &req).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !rig.at("ready").exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(brigadier_core::checkpoint::WorkspaceLease::acquire(rig.dir.path()).is_err());
        task.abort();
        let _ = task.await;
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(lease) =
                    brigadier_core::checkpoint::WorkspaceLease::acquire(rig.dir.path())
                {
                    drop(lease);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!rig.at("escaped").exists());
    }

    // ---- the timeout ----

    /// A script that sleeps past the deadline is killed and reads `timed_out`, not `signalled`.
    #[tokio::test]
    async fn a_command_that_outlives_its_deadline_is_timed_out() {
        let rig = Rig::new();
        let mut req = rig.req("sleep 30");
        req.timeout = Duration::from_millis(300);
        let out = run(&sh_env().await, &req).await.expect("ran");
        assert_eq!(out.reason, GateReason::TimedOut);
        assert_eq!(out.exit_code, None);
        assert!(!out.is_green());
        assert!(
            out.duration < Duration::from_secs(10),
            "the kill must not wait for the sleep"
        );
    }

    /// The kill reaches the **group**: a grandchild that would outlive the shell is dead too.
    ///
    /// The proof is a marker file the grandchild only writes if it survives, which needs no
    /// process introspection and cannot be confused by pid reuse.
    #[tokio::test]
    async fn the_timeout_kills_the_process_group_not_the_pid() {
        let rig = Rig::new();
        let marker = rig.at("survived");
        let script = format!("(sleep 2; : > {}) &\nsleep 30\n", marker.display());
        let mut req = rig.req(&script);
        req.timeout = Duration::from_millis(300);

        let out = run(&sh_env().await, &req).await.expect("ran");
        assert_eq!(out.reason, GateReason::TimedOut);

        // Well past the grandchild's own sleep. If the kill had reached only the shell, the
        // orphan would have been reparented and would have written the marker by now.
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert!(
            !marker.exists(),
            "a child that outlived the shell was left running: {} exists",
            marker.display()
        );
    }

    // ---- the output ----

    /// 10 MB of output goes to the file and nowhere else: [`GateResult`] has no field for it, and
    /// nothing derived from it carries a byte.
    #[tokio::test]
    async fn ten_megabytes_of_output_goes_to_the_file_and_nowhere_else() {
        let rig = Rig::new();
        // ~10.6 MiB of a distinctive marker from one `awk`, and no build system anywhere near
        // it: these are the tests that pin §6's argument and they must not need one.
        // The marker is concatenated by `awk` so that the literal never appears in the command
        // string itself — the command *is* carried on the result, verbatim, and only the output
        // must not be.
        let script =
            "awk 'BEGIN{ line=\"\"; for (i = 0; i < 10; i++) line = line \"GATE\" \"NOISE-\"; \
                      for (j = 0; j < 105000; j++) print line }'; exit 3";
        let out = run(&sh_env().await, &rig.req(script)).await.expect("ran");
        assert_eq!(out.exit_code, Some(3));

        let bytes = std::fs::metadata(rig.at("gate.log"))
            .expect("log exists")
            .len();
        assert!(
            bytes >= 10 * 1024 * 1024,
            "expected >= 10 MiB in the log, got {bytes}"
        );

        let head = {
            use std::io::Read;
            let mut buf = [0u8; 64];
            let mut f = std::fs::File::open(rig.at("gate.log")).expect("open log");
            let n = f.read(&mut buf).expect("read log");
            String::from_utf8_lossy(&buf[..n]).into_owned()
        };
        assert!(
            head.contains("GATENOISE"),
            "the marker should be in the log: {head}"
        );

        let serialised = serde_json::to_string(&out).expect("serialises");
        assert!(
            !serialised.contains("GATENOISE"),
            "the gate result must carry the log path, never the output: {serialised}"
        );
        assert!(
            serialised.len() < 4096,
            "the gate result is {} bytes; it is bounded by its own fields, not by the output",
            serialised.len()
        );
        assert!(out.feed_line("Phase 3").contains("exited 3"));
        assert!(!out.feed_line("Phase 3").contains("GATENOISE"));
    }

    /// Both streams land in one file, in the order they were written. Interleaving is the reason
    /// the output is not piped through the harness.
    #[tokio::test]
    async fn stdout_and_stderr_interleave_into_one_file() {
        let rig = Rig::new();
        let out = run(
            &sh_env().await,
            &rig.req("printf one; printf two >&2; printf three"),
        )
        .await
        .expect("ran");
        assert!(out.is_green());
        assert_eq!(rig.log(), "onetwothree");
    }

    /// `stdin` is null, so a command that reads it sees EOF rather than wedging the run.
    #[tokio::test]
    async fn stdin_is_closed_rather_than_left_open() {
        let rig = Rig::new();
        let mut req = rig.req("read line; echo \"got:[$line]\"");
        req.timeout = Duration::from_secs(5);
        let out = run(&sh_env().await, &req).await.expect("ran");
        assert_ne!(
            out.reason,
            GateReason::TimedOut,
            "an unread stdin must not hang the gate"
        );
        assert_eq!(rig.log(), "got:[]\n");
    }

    // ---- the environment ----

    #[tokio::test]
    async fn the_gate_environment_is_the_one_that_was_promised() {
        let rig = Rig::new();
        let out = run(
            &sh_env().await,
            &rig.req(
                "echo \"LC_ALL=$LC_ALL\"; echo \"CI=$CI\"; \
                 echo \"GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT\"; \
                 echo \"MTT=${MAX_THINKING_TOKENS:-unset}\"; : > cwd-marker",
            ),
        )
        .await
        .expect("ran");
        assert!(out.is_green());
        let log = rig.log();
        assert!(log.contains("LC_ALL=C"), "{log}");
        assert!(log.contains("CI=1"), "{log}");
        assert!(log.contains("GIT_TERMINAL_PROMPT=0"), "{log}");
        assert!(log.contains("MTT=unset"), "this is not a model call: {log}");
        // The gate runs in the integration worktree, never the project root. Asserted with a
        // file rather than with `pwd`, whose builtin trusts an inherited `$PWD`.
        assert!(
            rig.at("cwd-marker").exists(),
            "the gate did not run in the worktree it was given"
        );
    }

    /// The well-known toolchain directories are appended when they exist and never duplicated,
    /// and nothing already on the `PATH` is removed.
    #[test]
    fn well_known_directories_are_appended_without_duplicates() {
        let base = OsString::from("/usr/bin:/bin");
        let out = append_well_known(&base);
        let entries: Vec<PathBuf> = std::env::split_paths(&out).collect();
        assert_eq!(entries[0], PathBuf::from("/usr/bin"));
        assert_eq!(entries[1], PathBuf::from("/bin"));
        let mut seen = entries.clone();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), entries.len(), "no duplicates: {entries:?}");
        for e in &entries {
            assert!(e.is_absolute(), "{e:?}");
        }
        // Appending twice is a no-op, which is what makes caching the answer safe.
        assert_eq!(append_well_known(&out), out);
    }

    /// Every reason slug is stable and distinct: they reach the plan card and the lead call.
    #[test]
    fn reason_slugs_are_the_closed_set() {
        let all = [
            GateReason::Passed,
            GateReason::Failed,
            GateReason::CommandNotFound,
            GateReason::Signalled,
            GateReason::TimedOut,
        ];
        let slugs: Vec<&str> = all.iter().map(|r| r.slug()).collect();
        assert_eq!(
            slugs,
            [
                "passed",
                "failed",
                "command_not_found",
                "signalled",
                "timed_out"
            ]
        );
        assert_eq!(
            all.iter().filter(|r| r.is_green()).count(),
            1,
            "only exit 0 is green"
        );
    }

    /// The one signal `docs/research/worktree-cleanup.md` §§2.1–2.4 measured as sound is
    /// `rev-list --count`; the tool it replaces reports squash-merged work as unmerged and
    /// reverted work as merged. This asserts it never comes back.
    ///
    /// The needle is assembled at runtime so that this test does not fail on its own source.
    #[test]
    fn the_forbidden_merge_check_appears_nowhere_in_supervisor_src() {
        let needle = format!("{} {}", "git", "cherry");
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        walk(&src, &mut |file| {
            if let Ok(text) = std::fs::read_to_string(file) {
                if text.contains(&needle) {
                    offenders.push(file.display().to_string());
                }
            }
        });
        assert!(
            offenders.is_empty(),
            "`{needle}` is banned: it reports squash-merged work as unmerged and reverted work as \
             merged. Use `rev-list --count base..branch == 0`. Found in: {offenders:?}"
        );
    }

    fn walk(dir: &Path, f: &mut impl FnMut(&Path)) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, f);
            } else {
                f(&path);
            }
        }
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path).expect("metadata").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).expect("chmod");
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}

    // ---- the workspace lease, and the gate's own pid record ----

    /// A tracker that records what it was told, so a test can read the registry the real one
    /// writes to disk.
    #[derive(Default)]
    struct RecordingTracker {
        live: Mutex<Vec<String>>,
        seen: Mutex<Vec<(String, u32)>>,
    }
    impl RecordingTracker {
        fn live(&self) -> Vec<String> {
            self.live.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
        fn seen(&self) -> Vec<(String, u32)> {
            self.seen.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
    }
    impl ProcessTracker for RecordingTracker {
        fn track(&self, session_id: &SessionId, pid: u32, _binary: &Path, _cwd: &Path) {
            self.live
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(session_id.to_string());
            self.seen
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((session_id.to_string(), pid));
        }
        fn untrack(&self, session_id: &SessionId) {
            self.live
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|id| id != session_id.as_str());
        }
        fn shutdown_sync(&self, _grace: Duration) {}
    }

    /// G2: the gate child gets a pid record while it runs and none once it is over, so a
    /// force-quit mid-`cargo test` is recoverable and a normal exit leaves the sweep nothing.
    #[tokio::test]
    async fn a_gate_child_is_recorded_while_it_runs_and_forgotten_when_it_ends() {
        let tracker = Arc::new(RecordingTracker::default());
        let env = sh_env()
            .await
            .with_tracker(Arc::clone(&tracker) as Arc<dyn ProcessTracker>);
        let rig = Rig::new();

        // The command reads the registry from inside the run, which is the only moment a record
        // is supposed to exist.
        let probe = Arc::clone(&tracker);
        let during = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            probe.live()
        });
        let out = run(&env, &rig.req("sleep 0.4")).await.expect("ran");
        assert!(out.is_green());

        let live = during.await.expect("probe");
        assert_eq!(live.len(), 1, "the running gate must have one record: {live:?}");
        assert!(
            live[0].starts_with("gate-"),
            "the record is namespaced away from session ids: {live:?}"
        );
        assert!(
            tracker.live().is_empty(),
            "a gate that ended normally must leave no record: {:?}",
            tracker.live()
        );
        let seen = tracker.seen();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].1 > 1, "the recorded pid is the shell's own");
    }

    /// A timed-out gate is untracked too: the record must not outlive the group it names.
    #[tokio::test]
    async fn a_timed_out_gate_leaves_no_pid_record() {
        let tracker = Arc::new(RecordingTracker::default());
        let env = sh_env()
            .await
            .with_tracker(Arc::clone(&tracker) as Arc<dyn ProcessTracker>);
        let rig = Rig::new();
        let mut req = rig.req("sleep 30");
        req.timeout = Duration::from_millis(200);

        let out = run(&env, &req).await.expect("ran");
        assert_eq!(out.reason, GateReason::TimedOut);
        assert_eq!(tracker.seen().len(), 1, "it was recorded at spawn");
        assert!(tracker.live().is_empty(), "and forgotten at the kill");
    }

    /// G1: a stop followed immediately by a restart must not fail on the lease the cancelled
    /// gate's detached kill is still holding.
    ///
    /// Dropping [`run`]'s future is exactly what `run_gate` does when the stop flag is set.
    #[tokio::test]
    async fn a_cancelled_gate_hands_the_workspace_to_the_next_one() {
        let rig = Rig::new();
        let env = sh_env().await;
        let long = rig.req("sleep 30");

        let mut cancelled = Box::pin(run(&env, &long));
        assert!(
            tokio::time::timeout(Duration::from_millis(400), &mut cancelled)
                .await
                .is_err(),
            "the gate should still be running when it is cancelled"
        );
        drop(cancelled);

        let out = tokio::time::timeout(
            LEASE_HANDOVER_BOUND + Duration::from_secs(2),
            run(&env, &rig.req("printf ok")),
        )
        .await
        .expect("the restart must not hang")
        .expect("the workspace must be free for the restart");
        assert_eq!(out.exit_code, Some(0));
        assert_eq!(rig.log(), "ok");
        assert_eq!(
            in_flight_count(rig.dir.path()),
            0,
            "both runs released the tree"
        );
    }

    /// Exclusion is unchanged: a gate that really is running still refuses a second one, and
    /// refuses it promptly rather than after the handover bound.
    #[tokio::test]
    async fn a_second_gate_on_a_live_tree_is_still_refused() {
        let rig = Rig::new();
        let env = sh_env().await;
        let live = rig.req("sleep 3");
        let mut first = Box::pin(run(&env, &live));
        assert!(
            tokio::time::timeout(Duration::from_millis(400), &mut first)
                .await
                .is_err()
        );

        let started = Instant::now();
        let second = run(&env, &rig.req("printf no")).await;
        assert!(second.is_err(), "two gates must not share one worktree");
        assert!(
            started.elapsed() < LEASE_HANDOVER_BOUND,
            "a live gate is refused on the lease, not waited out: {:?}",
            started.elapsed()
        );
        drop(first);
    }

    // ---- the shared PATH probe ----

    /// Serializes the two tests that share the process-wide `PATH` cache. Async-aware because
    /// everything they hold it across is an `await`.
    static PATH_CACHE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// a1: one login-shell probe per process, however many `GateEnv`s ask for it.
    #[tokio::test]
    async fn the_path_probe_runs_once_per_process() {
        let _serial = PATH_CACHE.lock().await;
        forget_resolved_path().await;
        let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let probe = || {
            let probes = Arc::clone(&probes);
            async move {
                probes.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                (OsString::from("/stub/bin"), PathSource::LoginShell)
            }
        };

        let first = resolved_path_from(probe()).await;
        let second = resolved_path_from(probe()).await;
        assert_eq!(first, second);
        assert_eq!(first.0, OsString::from("/stub/bin"));
        assert_eq!(first.1, PathSource::LoginShell);
        assert_eq!(
            probes.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "the second caller must reuse the first probe"
        );
        forget_resolved_path().await;
    }

    /// And the explicit refresh does re-probe.
    #[tokio::test]
    async fn forgetting_the_path_probes_again() {
        let _serial = PATH_CACHE.lock().await;
        forget_resolved_path().await;
        let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let probe = || {
            let probes = Arc::clone(&probes);
            async move {
                let n = probes.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                (OsString::from(format!("/stub/{n}")), PathSource::LoginShell)
            }
        };
        assert_eq!(resolved_path_from(probe()).await.0, OsString::from("/stub/0"));
        assert_eq!(resolved_path_from(probe()).await.0, OsString::from("/stub/0"));
        forget_resolved_path().await;
        assert_eq!(resolved_path_from(probe()).await.0, OsString::from("/stub/1"));
        assert_eq!(
            probes.load(std::sync::atomic::Ordering::Relaxed),
            2,
            "exactly one probe before the refresh and one after"
        );
        forget_resolved_path().await;
    }

    /// Only a login-shell answer is cached. A fallback is a snapshot of a bad moment — a loaded
    /// machine, a shell that had not been set yet — and caching it makes that moment permanent.
    #[tokio::test]
    async fn a_fallback_path_is_never_cached_and_the_next_gate_re_probes() {
        let _serial = PATH_CACHE.lock().await;
        for source in [PathSource::LoginShellTimedOut, PathSource::Inherited] {
            forget_resolved_path().await;
            let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let probe = || {
                let probes = Arc::clone(&probes);
                async move {
                    let n = probes.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    (OsString::from(format!("/stub/{n}")), source)
                }
            };
            assert_eq!(resolved_path_from(probe()).await.0, OsString::from("/stub/0"));
            assert_eq!(
                resolved_path_from(probe()).await.0,
                OsString::from("/stub/1"),
                "{source:?} must not be this process's PATH for ever"
            );
            assert_eq!(probes.load(std::sync::atomic::Ordering::Relaxed), 2);
            // And the moment a login shell does answer, that answer is kept.
            let good = resolved_path_from(async {
                (OsString::from("/stub/good"), PathSource::LoginShell)
            })
            .await;
            assert_eq!(good.0, OsString::from("/stub/good"));
            assert_eq!(resolved_path_from(probe()).await.0, OsString::from("/stub/good"));
        }
        forget_resolved_path().await;
    }
}
