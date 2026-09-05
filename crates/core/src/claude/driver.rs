//! [`ClaudeDriver`]: one materialized Claude Code instance.
//!
//! A plain value, N of them per process, no singleton and no global registry. Two drivers with
//! different `CLAUDE_CONFIG_DIR`s are two accounts and must coexist in one process, so nothing
//! here touches process-global state: no `set_var`, no `chdir`, no `HOME` override.
// see docs/research/provider-driver.md and docs/research/agent-sdk.md §9 —
// `CLAUDE_CONFIG_DIR` is the one variable that partitions keychain item, transcripts, settings
// and memory.

use std::path::PathBuf;
use std::time::Duration;

use crate::claude::adapter::{connect, AdapterConfig};
use crate::claude::binary::{probe_binary, MIN_VERSION};
use crate::claude::hook::{ask_gated_tools, SharedHookPolicy};
use crate::claude::process::{account_label, spawn, SpawnSpec};
use crate::driver::{
    BoxFuture, DriverError, DriverInfo, DriverKind, HookOverride, ProviderDriver, ResumeSession,
    Resumed, StartSession,
};
use crate::event::{InstanceId, SessionId};
use crate::session::SessionHandle;

/// The slug every Claude Code instance reports from [`ProviderDriver::kind`].
pub const CLAUDE_CODE: &str = "claude-code";

/// Default deadline on a parked permission prompt.
///
/// Neither the CLI nor the SDK has one — "permission prompts have no park deadline" — so an
/// unanswered prompt is a wedged turn until something fires. Ten minutes is long enough for a
/// human to come back to the window and short enough that a forgotten session ends.
// see docs/research/agent-sdk.md §3 and docs/research/provider-driver.md §6 #25.
pub const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);

/// How one Claude Code instance is configured. One value per account.
#[derive(Clone, Debug)]
pub struct ClaudeDriverConfig {
    /// This instance's routing key. Never defaults to the driver kind.
    pub instance_id: InstanceId,
    /// Explicit binary path; `None` walks `PATH` for `claude`.
    pub binary: Option<PathBuf>,
    /// Minimum acceptable `claude --version`, as `X.Y.Z`.
    pub min_version: String,
    /// `CLAUDE_CONFIG_DIR` for every child. **The account boundary; `HOME` is never touched.**
    pub config_dir: Option<PathBuf>,
    /// What to show the operator.
    pub display_name: String,
    /// Model slug used when a request does not pin one.
    pub default_model: Option<String>,
    /// Deadline on a parked permission prompt; `None` parks forever.
    pub approval_timeout: Option<Duration>,
}

impl ClaudeDriverConfig {
    /// A config for `instance_id` with every default in place.
    pub fn new(instance_id: impl Into<InstanceId>) -> Self {
        Self {
            instance_id: instance_id.into(),
            binary: None,
            min_version: MIN_VERSION.to_owned(),
            config_dir: None,
            display_name: "Claude Code".to_owned(),
            default_model: None,
            approval_timeout: Some(DEFAULT_APPROVAL_TIMEOUT),
        }
    }
}

/// One Claude Code instance: a resolved binary, a version, an account, and a hook policy.
///
/// The hook policy defaults to [`AskGatedTools`](crate::claude::AskGatedTools), because nothing
/// else makes the CLI ask: with no `ask` decision the built-in read-only Bash set runs `ls` with
/// no prompt in every mode and the approvals panel stays empty.
// see docs/research/approvals.md §0 and §7 gap 1.
#[derive(Clone)]
pub struct ClaudeDriver {
    config: ClaudeDriverConfig,
    binary: PathBuf,
    version: String,
    hook_policy: SharedHookPolicy,
}

impl std::fmt::Debug for ClaudeDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeDriver")
            .field("instance_id", &self.config.instance_id)
            .field("binary", &self.binary)
            .field("version", &self.version)
            .field("config_dir", &self.config.config_dir)
            .finish_non_exhaustive()
    }
}

impl ClaudeDriver {
    /// Resolves the binary, runs `claude --version` once, and enforces `min_version`.
    ///
    /// # Errors
    /// [`DriverError::BinaryNotFound`] when `claude` is neither configured nor on `PATH`,
    /// [`DriverError::VersionTooOld`] when the install predates `min_version`, and
    /// [`DriverError::Protocol`] when `--version` fails or prints nothing.
    pub async fn probe(config: ClaudeDriverConfig) -> Result<ClaudeDriver, DriverError> {
        let (binary, version) = probe_binary(config.binary.as_deref(), &config.min_version).await?;
        Ok(ClaudeDriver { config, binary, version, hook_policy: ask_gated_tools() })
    }

    /// Builds a driver from an already-known binary and version, without spawning anything.
    ///
    /// For a caller that probed elsewhere, and for tests that need a driver without a CLI on the
    /// machine. It performs **no** version check — [`ClaudeDriver::probe`] is the checked path.
    pub fn with_version(
        config: ClaudeDriverConfig,
        binary: impl Into<PathBuf>,
        version: impl Into<String>,
    ) -> ClaudeDriver {
        ClaudeDriver {
            config,
            binary: binary.into(),
            version: version.into(),
            hook_policy: ask_gated_tools(),
        }
    }

    /// Replaces the `PreToolUse` policy. The default is
    /// [`AskGatedTools`](crate::claude::AskGatedTools); [`AllowAll`](crate::claude::AllowAll) is
    /// the opt-out that answers `{}` and gates nothing.
    pub fn with_hook_policy(mut self, policy: SharedHookPolicy) -> Self {
        self.hook_policy = policy;
        self
    }

    /// This instance's configuration.
    pub fn config(&self) -> &ClaudeDriverConfig {
        &self.config
    }

    /// The resolved binary.
    pub fn binary(&self) -> &std::path::Path {
        &self.binary
    }

    /// The `claude --version` line measured at construction.
    pub fn version(&self) -> &str {
        &self.version
    }

    /// Spawns a child and hands the adapter its pipes. Shared by start and resume, which differ
    /// by `--resume=<id>` and by whether `resumed` names a harness row to continue.
    ///
    /// `resumed` is `None` for a cold start: a fresh session id, envelope numbering from zero.
    /// `Some` reuses the caller's id and seeds the numbering from `start_seq`, which is what
    /// keeps a resumed child's feed rows from overwriting the old conversation's.
    // see docs/research/resume.md §7 and §8 gaps 1-2.
    ///
    /// `hooks` is the request's own `PreToolUse` policy; [`HookOverride::inherit`] falls back to
    /// this driver's. The fallback is what keeps the operator's hand-started sessions on
    /// [`AskGatedTools`](crate::claude::AskGatedTools) while a loop-dispatched worker runs under
    /// a [`WorkerWall`](crate::claude::WorkerWall) bound to its own worktree.
    async fn open(
        &self,
        spec: SpawnSpec,
        prompt: Option<String>,
        event_buffer: usize,
        resumed: Option<Resumed>,
        hooks: &HookOverride,
    ) -> Result<SessionHandle, DriverError> {
        let (session_id, start_seq) = match resumed {
            Some(Resumed { session_id, start_seq }) => (session_id, start_seq),
            None => (SessionId::new(uuid::Uuid::new_v4().to_string()), 0),
        };
        let child = spawn(&spec)?;
        let pid = child.pid;
        let adapter = AdapterConfig {
            instance_id: self.config.instance_id.clone(),
            session_id,
            cwd: spec.cwd.clone(),
            model: spec.model.clone(),
            approval_timeout: self.config.approval_timeout,
            prompt,
            event_buffer,
            start_seq,
        };
        let mut handle = connect(
            adapter,
            child.stdout,
            child.stdin,
            child.exit,
            child.kill,
            hooks.resolve(&self.hook_policy),
        )
        .await?;
        // The child is its own process group leader (`process.rs`), so this pid is also the pgid
        // an orphan sweeper signals.
        handle.pid = pid;
        Ok(handle)
    }
}

impl ProviderDriver for ClaudeDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::new(CLAUDE_CODE)
    }

    fn instance_id(&self) -> &InstanceId {
        &self.config.instance_id
    }

    fn describe(&self) -> DriverInfo {
        DriverInfo {
            display_name: self.config.display_name.clone(),
            binary_path: Some(self.binary.clone()),
            version: Some(self.version.clone()),
            account_label: Some(account_label(self.config.config_dir.as_deref())),
        }
    }

    fn start_session(
        &self,
        mut req: StartSession,
    ) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
        Box::pin(async move {
            if req.env_overrides.contains_key("BRIGADIER_PEER_TOKEN") {
                req.hook_policy = crate::driver::HookOverride::new(std::sync::Arc::new(
                    crate::claude::hook::PeerTools(req.hook_policy.resolve(&self.hook_policy)),
                ));
            }
            let spec = SpawnSpec {
                binary: self.binary.clone(),
                cwd: req.cwd,
                model: req.model.or_else(|| self.config.default_model.clone()),
                permission_mode: req.permission_mode,
                resume: None,
                config_dir: self.config.config_dir.clone(),
                mcp: req.mcp,
                thinking: req.thinking,
                env_overrides: req.env_overrides,
            };
            self.open(spec, req.prompt, req.event_buffer, None, &req.hook_policy).await
        })
    }

    /// A plain resume continues the original session id — the CLI does not mint a new one; only
    /// `--fork-session` does.
    // see docs/research/claude-direct-spike.md scenario 5 (measured) and
    // docs/research/agent-sdk.md §5.
    fn resume_session(
        &self,
        mut req: ResumeSession,
    ) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
        Box::pin(async move {
            if req.env_overrides.contains_key("BRIGADIER_PEER_TOKEN") {
                req.hook_policy = crate::driver::HookOverride::new(std::sync::Arc::new(
                    crate::claude::hook::PeerTools(req.hook_policy.resolve(&self.hook_policy)),
                ));
            }
            let spec = SpawnSpec {
                binary: self.binary.clone(),
                cwd: req.cwd,
                model: req.model.or_else(|| self.config.default_model.clone()),
                permission_mode: req.permission_mode,
                resume: Some(req.token),
                config_dir: self.config.config_dir.clone(),
                // A resume is gated exactly like a start; nothing about reopening a conversation
                // widens what the child may reach. see docs/research/spawn-split.md §6.
                mcp: req.mcp,
                // Thinking too: a resumed child is no more entitled to deliberate than a fresh
                // one, and the CLI reads the variable at startup either way.
                thinking: req.thinking,
                env_overrides: req.env_overrides,
            };
            self.open(spec, req.prompt, req.event_buffer, req.resumed, &req.hook_policy).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_accounts_coexist_and_describe_differently() {
        let mut work = ClaudeDriverConfig::new("claude-code:work");
        work.config_dir = Some(PathBuf::from("/Users/x/.claude-work"));
        work.display_name = "Claude Code (work)".into();
        let personal = ClaudeDriverConfig::new("claude-code:personal");

        let a = ClaudeDriver::with_version(work, "/opt/a/claude", "2.1.257 (Claude Code)");
        let b = ClaudeDriver::with_version(personal, "/opt/b/claude", "2.1.260 (Claude Code)");

        assert_eq!(a.kind(), b.kind());
        assert_eq!(a.kind().as_str(), "claude-code");
        assert_ne!(a.instance_id(), b.instance_id());
        assert_ne!(a.describe(), b.describe());
        assert_eq!(a.describe().account_label.as_deref(), Some(".claude-work"));
        assert_eq!(b.describe().account_label.as_deref(), Some("default"));
        assert_eq!(a.describe().binary_path, Some(PathBuf::from("/opt/a/claude")));
        assert_eq!(a.describe().version.as_deref(), Some("2.1.257 (Claude Code)"));
        assert_eq!(a.describe().display_name, "Claude Code (work)");
    }

    /// The default policy is the gate, not the pass-through: a driver built either way answers
    /// `ask` for `Bash`. Without this the approvals panel stays empty on a live run.
    // see docs/research/approvals.md §0.
    #[test]
    fn the_default_hook_policy_asks_for_the_gated_tools() {
        let driver = ClaudeDriver::with_version(
            ClaudeDriverConfig::new("claude-code:default"),
            "/opt/claude",
            "2.1.258 (Claude Code)",
        );
        let out = driver.hook_policy.pre_tool_use(Some("Bash"), &serde_json::Value::Null);
        let json = serde_json::to_value(&out).expect("ser");
        assert_eq!(json["hookSpecificOutput"]["permissionDecision"], "ask");
        let read = driver.hook_policy.pre_tool_use(Some("Read"), &serde_json::Value::Null);
        assert_eq!(serde_json::to_string(&read).expect("ser"), "{}");

        let opted_out = driver.with_hook_policy(crate::claude::hook::allow_all());
        let out = opted_out.hook_policy.pre_tool_use(Some("Bash"), &serde_json::Value::Null);
        assert_eq!(serde_json::to_string(&out).expect("ser"), "{}");
    }

    #[test]
    fn config_defaults_pin_the_measured_version_floor_and_a_park_deadline() {
        let config = ClaudeDriverConfig::new("claude-code:default");
        assert_eq!(config.min_version, "2.1.257");
        assert_eq!(config.approval_timeout, Some(DEFAULT_APPROVAL_TIMEOUT));
        assert!(config.binary.is_none(), "None resolves via a PATH walk");
        assert!(config.config_dir.is_none());
    }
}
