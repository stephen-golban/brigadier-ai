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

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::process::Command;

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
#[derive(Clone, Debug)]
pub struct GateEnv {
    shell: PathBuf,
    path: OsString,
    path_source: PathSource,
    pipefail: bool,
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
        let (path, path_source) = resolve_path().await;
        Self::with_path(shell, path, path_source).await
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
    let task = tokio::spawn(async move { run_owned(&env, &req, receiver).await });
    let result = task.await.map_err(std::io::Error::other)?;
    drop(cancel);
    result
}
async fn run_owned(
    env: &GateEnv,
    req: &GateRequest,
    mut cancel: tokio::sync::oneshot::Receiver<()>,
) -> std::io::Result<GateResult> {
    let _lease = brigadier_core::checkpoint::WorkspaceLease::acquire(&req.cwd)
        .map_err(std::io::Error::other)?;
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
        let rig = Rig::new();
        let out = run(&sh_env().await, &rig.req("nosuchprogram_xyz"))
            .await
            .expect("ran");
        assert_eq!(out.exit_code, Some(127));
        assert_eq!(out.reason, GateReason::CommandNotFound);
        assert_eq!(out.reason.slug(), "command_not_found");
        assert!(!out.is_green());
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
}
