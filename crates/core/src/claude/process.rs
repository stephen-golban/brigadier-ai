//! Spawning the `claude` child and killing it — including its grandchildren.
//!
//! Three things here are load-bearing and each is measured somewhere else:
//!
//! * **The argv is the SDK's, verbatim.** `docs/research/cli-protocol.md` §1 lists the base flags
//!   in the SDK's own order and `docs/research/claude-direct-spike.md` "Exact argv" shows the same
//!   line working against a live account. `--print` is never passed.
//! * **The environment is inherited, never cleared.** `docs/research/sidecar-spike.md` landmine 3:
//!   `USER` must survive or the Keychain lookup fails and the CLI reports "Not logged in".
//! * **The child gets its own process group.** `docs/research/tauri-runtime.md` §5: killing the
//!   direct child leaves the CLI's tool subprocesses alive, macOS has no `PR_SET_PDEATHSIG`, and
//!   the recommended shape is `process_group(0)` plus `killpg(SIGTERM)` then `SIGKILL`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};

use crate::driver::{DriverError, McpPolicy, PermissionMode, ThinkingPolicy};

/// Grace period between `SIGTERM` and `SIGKILL` on a process group.
// see docs/research/agent-sdk.md §10 — the SDK's own close path waits 2000 ms after EOF before
// SIGTERM; we are already past EOF by the time `kill` is called, so 2 s is the whole grace.
pub const KILL_GRACE: Duration = Duration::from_secs(2);

/// `CLAUDE_CODE_ENTRYPOINT`, set exactly as the SDK sets it.
// see docs/research/cli-protocol.md §1 and docs/research/claude-direct-spike.md "Exact environment".
const ENTRYPOINT: (&str, &str) = ("CLAUDE_CODE_ENTRYPOINT", "sdk-ts");

/// Variables removed from the inherited environment before the child sees them.
///
/// The first two are the SDK's own deletions (`sdk.mjs:46496-46497`). The rest are what Claude
/// Code injects into the children of its own Bash tool: if Brigadier is itself launched from
/// inside a Claude Code session, leaving them would nest our child inside that session.
// see docs/research/claude-direct-spike.md "Exact environment" — `session.rs:HARNESS_VARS`.
const STRIPPED_VARS: &[&str] = &[
    "NODE_OPTIONS",
    "DEBUG",
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
];

/// Everything that varies between one spawn and the next.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnSpec {
    /// Resolved `claude` binary.
    pub binary: PathBuf,
    /// Working directory for the child; the host is never `chdir`ed.
    pub cwd: PathBuf,
    /// Model slug, when the caller pins one.
    pub model: Option<String>,
    /// Validated reasoning effort, forwarded without substitution.
    pub effort: Option<String>,
    /// Permission mode. **Always** passed as `--permission-mode`, never omitted.
    pub permission_mode: PermissionMode,
    /// Provider session id to reopen, for a resume.
    pub resume: Option<String>,
    /// Resume history under a fresh provider id.
    pub fork: bool,
    /// `CLAUDE_CONFIG_DIR`, the account boundary. `HOME` is never touched.
    // see docs/research/agent-sdk.md §9 and docs/research/provider-driver.md.
    pub config_dir: Option<PathBuf>,
    /// Whether this child inherits the user's MCP servers. [`McpPolicy::Off`] is the default and
    /// is the only variant that emits a flag.
    pub mcp: McpPolicy,
    /// Whether this child does extended thinking. [`ThinkingPolicy::Off`] is the default and is
    /// the only variant that sets anything — `MAX_THINKING_TOKENS=0`, an environment entry and
    /// never a flag, applied before `env_overrides` so a caller can still override it by name.
    // see docs/research/thinking-control.md §8 and [`ThinkingPolicy`] for why off is the default.
    pub thinking: ThinkingPolicy,
    /// Extra environment layered on top of the inherited set, as values.
    pub env_overrides: BTreeMap<String, String>,
}

/// The argv the CLI is spawned with, in the SDK's own order.
///
/// `--permission-mode` is pinned unconditionally. The spike proved that leaving it out lets the
/// user's `~/.claude/settings.json` `defaultMode` shadow the whole approval gate — with
/// `"defaultMode": "bypassPermissions"` no `can_use_tool` frame reaches the wire at all and an
/// allow and a deny scenario are indistinguishable.
// see docs/research/claude-direct-spike.md "The two shadows over `can_use_tool`" and
// docs/research/cli-protocol.md §1 for the flag order.
//
// No `--settings '{"permissions":{"ask":[...]}}'` is injected. Every tool call is gated by the
// `PreToolUse` hook registered in `initialize` instead, whose policy answers
// `permissionDecision: "ask"` for the tools that write; the spike measured that hook firing on
// the very `echo` the CLI had already auto-approved (scenario 6). What auto-approved that `echo`
// is the CLI's **built-in read-only Bash command set** — a static, non-configurable list (`ls`,
// `cat`, `echo`, `pwd`, `head`, `tail`, `grep`, `find`, `wc`, `which`, `diff`, `stat`, `du`,
// `cd`, read-only `git`) that skips the prompt **in every mode** — and *not* a classifier. The
// model-based classifier is a different mechanism, `--permission-mode auto` only and billable.
// An ask rule does override the read-only set, which is why the alternative below works.
// see docs/research/approvals.md §1(b) (documented) and §7 gap 1.
//
// `--strict-mcp-config` is passed under [`McpPolicy::Off`], which is the default, and no
// `--mcp-config` is supplied for external servers. App-managed interactive sessions may
// explicitly configure the internal brigadier peer server (workbench research brief). Measured: the
// `system/init` frame reports `mcp_servers: []` on all six `off` runs and both of the owner's
// servers connected on all six `on` runs, and the flag is worth 751.5 ms of the 1,395 ms median
// spawn to `system/init`. `claude --help` on 2.1.259, this machine: "--strict-mcp-config  Only
// use MCP servers from --mcp-config, ignoring all other MCP configurations".
// [`McpPolicy::Inherit`] passes neither flag and the CLI loads the user's configuration as it
// does for an interactive session. Owner decision 2026-09-03: off by default, per-project opt-in.
// see docs/research/spawn-split.md §1, §2 and §6, and docs/vision.md §3.
//
// No `--setting-sources=` either, so the user's `~/.claude/settings.json` is still loaded.
// Harmless today — the owner's file carries no `Bash` allow rule — but a user `allow` rule for a
// gated tool would shadow the hook's `ask` and the approvals panel would silently go quiet, with
// no error anywhere. Deliberate for now: pinning the sources would also drop the user's own
// hooks and MCP servers, which the harness has no mandate to disable. 2.1.248's `--restricted`
// is the blunter form of the same lever.
// see docs/research/approvals.md §7 gap 4 (decision recorded, not exercised).
pub fn build_argv(spec: &SpawnSpec) -> Vec<String> {
    let mut argv = vec![
        "--output-format".to_owned(),
        "stream-json".to_owned(),
        "--verbose".to_owned(),
        "--input-format".to_owned(),
        "stream-json".to_owned(),
    ];
    if let Some(model) = &spec.model {
        argv.push("--model".to_owned());
        argv.push(model.clone());
    }
    if let Some(effort) = &spec.effort {
        argv.extend(["--effort".to_owned(), effort.clone()]);
    }
    argv.push("--include-partial-messages".to_owned());
    argv.push("--permission-prompt-tool".to_owned());
    argv.push("stdio".to_owned());
    if let Some(token) = &spec.resume {
        // One argument with `=`, the 0.3.257 shape, not the two-argument 0.3.159 shape.
        // see docs/research/claude-direct-spike.md "Exact argv".
        argv.push(format!("--resume={token}"));
        if spec.fork {
            argv.push("--fork-session".to_owned());
        }
    }
    // Before `--permission-mode`, which is where the SDK emits it too.
    // see docs/research/cli-protocol.md §1 for the conditional-flag order.
    if spec.mcp == McpPolicy::Off {
        argv.push("--strict-mcp-config".to_owned());
    }
    // Native Agent/Task sessions bypass Brigadier ownership, Stop and shared limits.
    // The installed CLI accepts comma-separated deny names (`claude --help`).
    if spec.env_overrides.contains_key("BRIGADIER_PEER_TOKEN") {
        argv.extend(["--disallowedTools".to_owned(), "Agent,Task".to_owned()]);
    }
    if let Some(executable) = spec.env_overrides.get("BRIGADIER_EXECUTABLE") {
        if spec.env_overrides.contains_key("BRIGADIER_PEER_TOKEN") {
            argv.push("--mcp-config".to_owned());
            argv.push(serde_json::json!({"mcpServers":{"brigadier":{"type":"stdio","command":executable,"args":["--peer-mcp"]}}}).to_string());
        }
    }
    argv.push("--permission-mode".to_owned());
    argv.push(spec.permission_mode.as_cli_flag().to_owned());
    argv
}

/// A spawned CLI, split into the pieces the adapter drives.
#[derive(Debug)]
pub struct Spawned {
    /// The child's stdin; the adapter writes one JSON line per frame.
    pub stdin: ChildStdin,
    /// The child's stdout; one JSON line per frame.
    pub stdout: ChildStdout,
    /// Resolves once, when the child has exited.
    pub exit: oneshot::Receiver<ExitInfo>,
    /// Asks the supervisor task to kill the child's process group.
    pub kill: KillHandle,
    /// The child's pid, which is also its process-group id on unix.
    pub pid: Option<u32>,
}

/// How a child process ended.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExitInfo {
    /// Exit code, when the child exited normally rather than on a signal.
    pub code: Option<i32>,
}

/// Asks a spawned child's supervisor task to tear the process group down.
///
/// Clone-cheap and independent of the [`tokio::process::Child`], which lives inside the
/// supervisor task so `wait()` and `kill()` never contend for it.
#[derive(Clone, Debug)]
pub struct KillHandle {
    tx: mpsc::Sender<()>,
}

impl KillHandle {
    /// Builds a handle and the receiver a supervisor task listens on. Public so a test can drive
    /// the adapter without a real process.
    pub fn channel() -> (KillHandle, mpsc::Receiver<()>) {
        let (tx, rx) = mpsc::channel(1);
        (KillHandle { tx }, rx)
    }

    /// Requests the kill. Idempotent, never blocks, and a dead supervisor is not an error — the
    /// child is already gone in that case.
    pub fn kill(&self) {
        let _ = self.tx.try_send(());
    }
}

/// The command a spawn runs, built and not started.
///
/// Split out of [`spawn`] so the child's *environment* can be pinned by a test the way
/// [`build_argv`] pins its command line — `Command::get_envs` reports exactly the modifications
/// made here, and nothing about the parent environment those modifications sit on.
///
/// The four environment steps are ordered, and the order is the contract:
///
/// 1. `CLAUDE_CODE_ENTRYPOINT`, as the SDK sets it.
/// 2. `STRIPPED_VARS` removed, so a brigadier launched from inside a Claude Code session does
///    not nest its child in that session.
/// 3. `CLAUDE_CONFIG_DIR` and [`SpawnSpec::thinking`] — harness policy, which must land *after*
///    the strip list to be able to override an inherited value of the same name.
/// 4. [`SpawnSpec::env_overrides`] last, so the caller wins over all of it. Reversing 3 and 4
///    would silently drop a caller's own `MAX_THINKING_TOKENS`; reversing 2 and 3 would let the
///    strip list delete a variable the policy had just set.
fn build_command(spec: &SpawnSpec) -> Command {
    let mut cmd = Command::new(&spec.binary);
    cmd.args(build_argv(spec))
        .current_dir(&spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Inherited parent environment, minus the harness variables, plus ours. Never `env_clear`:
    // `USER` must survive. see docs/research/sidecar-spike.md landmine 3.
    cmd.env(ENTRYPOINT.0, ENTRYPOINT.1);
    for key in STRIPPED_VARS {
        cmd.env_remove(key);
    }
    if let Some(dir) = &spec.config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    // Thinking is an environment lever, never a flag: `MAX_THINKING_TOKENS=0` reaches
    // `thinking: {type: "disabled"}` at session start, ahead of the CLI's own `adaptive` default,
    // and `build_argv` is untouched by this. `--effort` is not used and would be discarded on
    // `claude-haiku-4-5` anyway. see docs/research/thinking-control.md §4b and §8.
    if let Some((key, value)) = spec.thinking.env_entry() {
        cmd.env(key, value);
    }
    for (key, value) in &spec.env_overrides {
        cmd.env(key, value);
    }

    // Own process group, so a kill reaches the CLI's tool subprocesses too.
    // see docs/research/tauri-runtime.md §5. Stable since Rust 1.64; safe wrapper, no `unsafe`.
    #[cfg(unix)]
    cmd.process_group(0);

    cmd
}

/// Spawns `claude` per `spec`, draining stderr to `tracing::warn` and supervising the child.
///
/// # Errors
/// [`DriverError::Spawn`] when the process cannot start, [`DriverError::Protocol`] when tokio
/// does not hand back all three pipes (it always does with `Stdio::piped`, but this crate does
/// not `unwrap`).
pub fn spawn(spec: &SpawnSpec) -> Result<Spawned, DriverError> {
    let mut cmd = build_command(spec);

    let mut child = cmd.spawn().map_err(|source| DriverError::Spawn {
        binary: spec.binary.display().to_string(),
        source,
    })?;
    let pid = child.id();

    let missing = |what: &str| DriverError::Protocol(format!("child {what} pipe was not created"));
    let stdin = child.stdin.take().ok_or_else(|| missing("stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| missing("stdout"))?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(drain_stderr(stderr));
    }

    let (kill, mut kill_rx) = KillHandle::channel();
    let (exit_tx, exit) = oneshot::channel();
    tokio::spawn(async move {
        let code = tokio::select! {
            // Both arms are cancel-safe: `Child::wait` and `Receiver::recv` are documented so.
            status = child.wait() => status.ok().and_then(|s| s.code()),
            _ = kill_rx.recv() => {
                terminate(&mut child, pid).await;
                child.wait().await.ok().and_then(|s| s.code())
            }
        };
        let _ = exit_tx.send(ExitInfo { code });
    });

    Ok(Spawned {
        stdin,
        stdout,
        exit,
        kill,
        pid,
    })
}

/// `SIGTERM` the group, then `SIGKILL` it after [`KILL_GRACE`].
async fn terminate(child: &mut tokio::process::Child, pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid.and_then(|p| i32::try_from(p).ok()) {
        use nix::sys::signal::{killpg, Signal};
        use nix::unistd::Pid;
        // The child was spawned with `process_group(0)`, so its pgid equals its pid.
        let group = Pid::from_raw(pid);
        if let Err(e) = killpg(group, Signal::SIGTERM) {
            tracing::debug!(pgid = pid, error = %e, "killpg SIGTERM failed");
        }
        if tokio::time::timeout(KILL_GRACE, child.wait()).await.is_ok() {
            return;
        }
        tracing::warn!(
            pgid = pid,
            "process group survived SIGTERM; escalating to SIGKILL"
        );
        if let Err(e) = killpg(group, Signal::SIGKILL) {
            tracing::debug!(pgid = pid, error = %e, "killpg SIGKILL failed");
        }
        return;
    }
    // Non-unix, or a child with no pid: the direct child is all we can reach.
    // see docs/research/tauri-runtime.md "Not checked" — the Windows job-object equivalent of a
    // process group was not researched, so grandchildren are not covered there.
    let _ = pid;
    let _ = child.start_kill();
}

/// stderr carries no protocol — it was 0 bytes in all seven spike runs — so every line is a
/// warning rather than data.
// see docs/research/cli-protocol.md §1 ("stderr is *not* protocol") and
// docs/research/claude-direct-spike.md "Exact environment".
async fn drain_stderr(stderr: ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) if line.trim().is_empty() => continue,
            Ok(Some(line)) => tracing::warn!(target: "claude.stderr", "{line}"),
            Ok(None) => break,
            Err(e) => {
                tracing::warn!(target: "claude.stderr", "stderr read failed: {e}");
                break;
            }
        }
    }
}

/// True when `path` names a directory we would hand to `CLAUDE_CONFIG_DIR`.
pub(crate) fn account_label(config_dir: Option<&Path>) -> String {
    config_dir
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "default".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SpawnSpec {
        SpawnSpec {
            binary: PathBuf::from("/usr/local/bin/claude"),
            cwd: PathBuf::from("/w"),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Default,
            resume: None,
            fork: false,
            config_dir: None,
            mcp: McpPolicy::Off,
            thinking: ThinkingPolicy::default(),
            env_overrides: BTreeMap::new(),
        }
    }

    /// Every environment modification [`build_command`] makes, as the child would see them:
    /// `Some` is a value the harness sets, `None` a removal, and a key that is absent from the map
    /// was never touched — which is the only honest reading of "the variable is not set", since
    /// `Command::get_envs` reports the modifications and not the inherited environment they sit on.
    fn env_of(spec: &SpawnSpec) -> BTreeMap<String, Option<String>> {
        let cmd = build_command(spec);
        cmd.as_std()
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect()
    }

    /// The default child is spawned with thinking off, through the environment.
    ///
    /// Not a preference: the CLI starts every session at `{type: "adaptive"}` and degrades that to
    /// `{type: "enabled", budget_tokens: N}` on `claude-haiku-4-5`, which has no adaptive mode, so
    /// without this the harness pays for deliberation on every mechanical turn. Off is that
    /// model's own API default.
    // see docs/research/thinking-control.md §1, §3 and §8.
    #[test]
    fn native_peer_server_is_explicit_without_exposing_credentials_in_argv() {
        let mut request = spec();
        request.env_overrides.insert(
            "BRIGADIER_EXECUTABLE".into(),
            "/Applications/Brigadier App/brigadier".into(),
        );
        request.env_overrides.insert(
            "BRIGADIER_PEER_TOKEN".into(),
            "private-session-token".into(),
        );
        let argv = build_argv(&request);
        assert!(argv.iter().any(|a| a == "--strict-mcp-config"));
        let index = argv.iter().position(|a| a == "--mcp-config").unwrap();
        let config: serde_json::Value = serde_json::from_str(&argv[index + 1]).unwrap();
        assert_eq!(
            config["mcpServers"]["brigadier"]["args"],
            serde_json::json!(["--peer-mcp"])
        );
        assert!(!argv.join(" ").contains("private-session-token"));
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["--disallowedTools", "Agent,Task"]));
        assert!(!build_argv(&spec())
            .iter()
            .any(|arg| arg == "--disallowedTools"));
    }
    #[test]
    fn the_default_child_is_spawned_with_thinking_off() {
        assert_eq!(
            ThinkingPolicy::default(),
            ThinkingPolicy::Off,
            "off is the default policy"
        );
        let env = env_of(&spec());
        assert_eq!(
            env.get(ThinkingPolicy::ENV_VAR),
            Some(&Some("0".to_owned())),
            "MAX_THINKING_TOKENS=0 is what the CLI maps to thinking: {{type: \"disabled\"}}"
        );
        assert_eq!(env.get(ENTRYPOINT.0), Some(&Some(ENTRYPOINT.1.to_owned())));
    }

    /// The opt-in sets **nothing**, so the CLI's own default and the user's own settings decide.
    ///
    /// Absent, not empty: the CLI tests the variable for truthiness before parsing it, so
    /// `MAX_THINKING_TOKENS=` is a third state this policy does not express and must not emit.
    #[test]
    fn an_opted_in_child_sets_no_thinking_variable_at_all() {
        let env = env_of(&SpawnSpec {
            thinking: ThinkingPolicy::Inherit,
            ..spec()
        });
        assert!(
            !env.contains_key(ThinkingPolicy::ENV_VAR),
            "inherit touches the variable in no way: {env:?}"
        );
        assert_eq!(ThinkingPolicy::Inherit.env_entry(), None);
        // And it is not the strip list either — an inherited value must survive.
        assert!(!STRIPPED_VARS.contains(&ThinkingPolicy::ENV_VAR));
    }

    /// `env_overrides` is applied after the strip list and after the policy, so the caller wins
    /// over both. Were that order ever reversed, a stripped key would come back empty-handed and
    /// a caller's own thinking budget would be silently overwritten with `0`.
    #[test]
    fn env_overrides_win_over_the_strip_list_and_over_the_policy() {
        let overrides = BTreeMap::from([
            ("DEBUG".to_owned(), "brigadier".to_owned()),
            (ThinkingPolicy::ENV_VAR.to_owned(), "4096".to_owned()),
        ]);
        let env = env_of(&SpawnSpec {
            env_overrides: overrides,
            ..spec()
        });
        assert_eq!(
            env.get("DEBUG"),
            Some(&Some("brigadier".to_owned())),
            "an override of a stripped key survives, so overrides land last"
        );
        assert_eq!(
            env.get(ThinkingPolicy::ENV_VAR),
            Some(&Some("4096".to_owned())),
            "an explicit budget beats the default policy"
        );
        // A stripped key nobody overrode is still a removal, not a value.
        assert_eq!(env.get("CLAUDECODE"), Some(&None), "{env:?}");
    }

    /// The thinking lever is the environment and only the environment: both policies produce the
    /// same argv, byte for byte, as the shape pinned above. This is the assertion that fails if
    /// anyone moves it to a flag — including `--effort`, which the CLI silently discards on
    /// `claude-haiku-4-5` (`docs/research/thinking-control.md` §4a).
    #[test]
    fn the_thinking_policy_never_reaches_the_argv() {
        let off = build_argv(&spec());
        let inherit = build_argv(&SpawnSpec {
            thinking: ThinkingPolicy::Inherit,
            ..spec()
        });
        assert_eq!(off, inherit);
        assert_eq!(
            off,
            [
                "--output-format",
                "stream-json",
                "--verbose",
                "--input-format",
                "stream-json",
                "--include-partial-messages",
                "--permission-prompt-tool",
                "stdio",
                "--strict-mcp-config",
                "--permission-mode",
                "default",
            ]
        );
        assert!(!off
            .iter()
            .any(|a| a == "--effort" || a.contains(ThinkingPolicy::ENV_VAR)));
    }

    /// The default shape, pinned whole. `--strict-mcp-config` is in it because
    /// [`McpPolicy::Off`] is the default, and no `--mcp-config` follows it — which is what makes
    /// the allowed set empty (`docs/research/spawn-split.md` §1, measured `mcp_servers: []`).
    #[test]
    fn argv_matches_the_spike_and_never_passes_print() {
        let argv = build_argv(&spec());
        assert_eq!(
            argv,
            [
                "--output-format",
                "stream-json",
                "--verbose",
                "--input-format",
                "stream-json",
                "--include-partial-messages",
                "--permission-prompt-tool",
                "stdio",
                "--strict-mcp-config",
                "--permission-mode",
                "default",
            ]
        );
        assert!(!argv.iter().any(|a| a == "--print" || a == "-p"));
        // The flag is exclusive-control only when nothing widens the allowed set again.
        assert!(!argv.iter().any(|a| a == "--mcp-config"));
    }

    /// The opt-in shape, pinned whole: neither flag, so the CLI loads the user's own MCP
    /// configuration exactly as it does interactively. The only difference from the default
    /// shape is the one flag.
    #[test]
    fn argv_under_inherit_passes_neither_mcp_flag() {
        let argv = build_argv(&SpawnSpec {
            mcp: McpPolicy::Inherit,
            ..spec()
        });
        assert_eq!(
            argv,
            [
                "--output-format",
                "stream-json",
                "--verbose",
                "--input-format",
                "stream-json",
                "--include-partial-messages",
                "--permission-prompt-tool",
                "stdio",
                "--permission-mode",
                "default",
            ]
        );
        assert!(!argv
            .iter()
            .any(|a| a == "--strict-mcp-config" || a == "--mcp-config"));
    }

    /// A resumed child is gated the same way a fresh one is: the flag lands after `--resume=`
    /// and before `--permission-mode`, the SDK's own order.
    #[test]
    fn fork_uses_a_new_provider_id_only_with_an_explicit_resume() {
        let argv = build_argv(&SpawnSpec {
            resume: Some("source-id".into()),
            fork: true,
            ..spec()
        });
        assert!(argv.iter().any(|arg| arg == "--resume=source-id"));
        assert!(argv.iter().any(|arg| arg == "--fork-session"));
        assert!(!build_argv(&SpawnSpec {
            fork: true,
            ..spec()
        })
        .iter()
        .any(|arg| arg == "--fork-session"));
        assert!(!build_argv(&SpawnSpec {
            resume: Some("source-id".into()),
            ..spec()
        })
        .iter()
        .any(|arg| arg == "--fork-session"));
    }

    #[test]
    fn a_resumed_child_is_gated_by_the_same_policy() {
        let argv = build_argv(&SpawnSpec {
            resume: Some("8380cdea".into()),
            ..spec()
        });
        let strict = argv
            .iter()
            .position(|a| a == "--strict-mcp-config")
            .expect("off is default");
        let resume = argv
            .iter()
            .position(|a| a == "--resume=8380cdea")
            .expect("resume is passed");
        let mode = argv
            .iter()
            .position(|a| a == "--permission-mode")
            .expect("mode is pinned");
        assert!(resume < strict && strict < mode, "{argv:?}");
    }

    #[test]
    fn argv_pins_the_mode_in_the_cli_spelling_and_carries_model_and_resume() {
        let argv = build_argv(&SpawnSpec {
            effort: None,
            model: Some("claude-haiku-4-5".into()),
            permission_mode: PermissionMode::AcceptEdits,
            resume: Some("8380cdea".into()),
            ..spec()
        });
        assert_eq!(argv[5..7], ["--model", "claude-haiku-4-5"]);
        // One argument with `=`, the 0.3.257 shape.
        assert!(argv.contains(&"--resume=8380cdea".to_owned()));
        let mode = argv
            .iter()
            .position(|a| a == "--permission-mode")
            .expect("mode is pinned");
        assert_eq!(argv[mode + 1], "acceptEdits");
        // No ask rules are injected; the PreToolUse hook is the gate. And the user's settings
        // are still loaded — see the note above `build_argv`.
        assert!(!argv.iter().any(|a| a == "--settings"));
        assert!(!argv.iter().any(|a| a.starts_with("--setting-sources")));
    }

    #[test]
    fn an_unmodelled_mode_reaches_the_flag_verbatim() {
        let argv = build_argv(&SpawnSpec {
            permission_mode: PermissionMode::Other("someFutureMode".into()),
            ..spec()
        });
        assert!(argv
            .windows(2)
            .any(|w| w == ["--permission-mode", "someFutureMode"]));
    }

    #[test]
    fn account_label_is_the_config_dir_basename() {
        assert_eq!(account_label(None), "default");
        assert_eq!(
            account_label(Some(Path::new("/home/me/.claude-work"))),
            ".claude-work"
        );
        assert_eq!(account_label(Some(Path::new("work"))), "work");
    }

    #[tokio::test]
    async fn a_missing_binary_is_a_spawn_error_naming_the_path() {
        let err = spawn(&SpawnSpec {
            binary: PathBuf::from("/nonexistent/claude"),
            cwd: PathBuf::from("."),
            ..spec()
        })
        .expect_err("a missing binary cannot spawn");
        assert!(matches!(err, DriverError::Spawn { .. }), "{err:?}");
        assert!(err.to_string().contains("/nonexistent/claude"), "{err}");
    }

    /// Exercises the real spawn path — process group, supervisor task, exit channel and the
    /// `killpg` escalation — against `/usr/bin/yes`, which ignores the argv and never exits on
    /// its own. `claude` itself is never run by a test.
    // see docs/research/tauri-runtime.md §5 for why the group, not the child, is the target.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_kill_takes_down_the_process_group() {
        let mut child = spawn(&SpawnSpec {
            binary: PathBuf::from("/usr/bin/yes"),
            cwd: PathBuf::from("/"),
            ..spec()
        })
        .expect("yes spawns");
        assert!(
            child.pid.is_some(),
            "the child reports a pid, which is also its pgid"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut child.exit)
                .await
                .is_err(),
            "`yes` does not exit on its own"
        );

        child.kill.kill();
        let info = tokio::time::timeout(KILL_GRACE + Duration::from_secs(2), child.exit)
            .await
            .expect("the group died inside the grace window")
            .expect("the supervisor reported the exit");
        // SIGTERM leaves no exit code, which is how `ExitReason` tells a kill from a clean close.
        assert_eq!(info.code, None, "a signalled child has no exit code");
    }

    #[test]
    fn stripped_vars_cover_the_sdk_deletions_and_the_harness_injections() {
        for key in [
            "NODE_OPTIONS",
            "DEBUG",
            "CLAUDECODE",
            "AI_AGENT",
            "CLAUDE_CODE_SESSION_ID",
        ] {
            assert!(STRIPPED_VARS.contains(&key), "{key} must be stripped");
        }
        // HOME is the account boundary we must never touch (decision 4).
        assert!(!STRIPPED_VARS.contains(&"HOME"));
        assert!(!STRIPPED_VARS.contains(&"USER"));
    }
}
