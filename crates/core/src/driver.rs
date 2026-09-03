//! The provider driver: a plain value, N instances, no singleton and no global registry.
//!
// see docs/research/provider-driver.md §6 #1 — a record, not a DI service; tags are
// singleton-per-runtime and two Claude accounts need two coexisting instances.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::event::{InstanceId, SessionId};
use crate::session::SessionHandle;

/// A boxed, `Send` future. Hand-rolled so the crate needs no `async_trait` and no `futures`.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The whole registry: a list of drivers the app happens to hold.
// see docs/research/provider-driver.md §6 #1 — t3code's `BUILT_IN_DRIVERS` is a plain array too.
pub type DriverRegistry = Vec<Arc<dyn ProviderDriver>>;

/// An open slug naming a kind of provider, e.g. `claude-code`.
///
/// Open, not a closed enum: an unknown kind must parse and degrade, never crash.
// see docs/research/provider-driver.md §6 #3 — pattern `^[a-zA-Z][a-zA-Z0-9_-]*$`, <= 64 chars.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DriverKind(String);

impl DriverKind {
    /// Wrap a slug. Never fails; check [`DriverKind::is_well_formed`] to warn instead.
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    /// Borrow the slug.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// True when the slug matches `^[a-zA-Z][a-zA-Z0-9_-]*$` and is at most 64 chars.
    pub fn is_well_formed(&self) -> bool {
        let mut chars = self.0.chars();
        matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            && self.0.len() <= 64
    }
}

impl std::fmt::Display for DriverKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// What to show the operator about one driver instance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriverInfo {
    /// Human-readable name, e.g. "Claude Code".
    pub display_name: String,
    /// Resolved provider binary, when one has been located.
    pub binary_path: Option<PathBuf>,
    /// Provider version string as reported by the binary.
    pub version: Option<String>,
    /// Which account this instance is bound to.
    // see docs/research/agent-sdk.md §9 — `CLAUDE_CONFIG_DIR` is the account boundary, never `HOME`.
    pub account_label: Option<String>,
}

/// How much the provider should ask before acting.
///
/// On the wire this is **always a bare string**, including [`PermissionMode::Other`]: an
/// unmodelled mode is `"someFutureMode"`, not `{"other":"someFutureMode"}`, so a value
/// round-trips through persistence and through the CLI's own vocabulary unchanged. The modelled
/// variants use this crate's kebab-case spelling (`"dont-ask"`);
/// [`PermissionMode::as_cli_flag`] is the Claude spelling (`"dontAsk"`).
///
/// Not injective: `Other("default")` deserializes back as [`PermissionMode::Default`]. That is
/// the intended collapse — the same mode should not have two representations.
///
/// Claude Code 2.1.258 accepts **seven** values and every one of them is modelled here.
/// `claude --help` lists six and omits `default`, because the docs make `manual` its alias; both
/// spellings are accepted by the binary, so [`PermissionMode::Manual`] is kept distinct from
/// [`PermissionMode::Default`] rather than collapsed — it is what the operator chose, and the CLI
/// resolves the alias itself.
// see docs/research/approvals.md §3 — `claude --help` and option-validation probes on 2.1.258
// (measured) plus https://code.claude.com/docs/en/cli-reference (documented) for the alias.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum PermissionMode {
    /// Ask per the provider's own rules. The documented starting mode for an SDK-driven session.
    #[default]
    Default,
    /// Documented alias for [`PermissionMode::Default`]; requires Claude Code 2.1.200 or later.
    Manual,
    /// Auto-approve edits inside the workspace.
    AcceptEdits,
    /// Plan only; take no action.
    Plan,
    /// Model-based command classification decides. **Billable on API accounts** — the classifier
    /// is a separate Sonnet call, and it is the only mode that runs one; the built-in read-only
    /// Bash list is static and applies in every mode.
    // see docs/research/approvals.md §1(b).
    Auto,
    /// Act without asking, but stop short of what `bypassPermissions` waves through.
    DontAsk,
    /// Ask for nothing. Dangerous, and it silently disables our approval UI.
    BypassPermissions,
    /// A provider-specific mode we do not model, passed through verbatim.
    Other(String),
}

impl PermissionMode {
    /// This crate's own wire spelling: kebab-case for the modelled modes, verbatim otherwise.
    pub fn as_wire_str(&self) -> &str {
        match self {
            Self::Default => "default",
            Self::Manual => "manual",
            Self::AcceptEdits => "accept-edits",
            Self::Plan => "plan",
            Self::Auto => "auto",
            Self::DontAsk => "dont-ask",
            Self::BypassPermissions => "bypass-permissions",
            Self::Other(s) => s,
        }
    }

    /// The value Claude Code's `--permission-mode` flag and its `set_permission_mode` control
    /// request expect.
    // see docs/research/approvals.md §3 — the CLI's set is
    // `default|manual|acceptEdits|plan|auto|dontAsk|bypassPermissions`, camelCase, so an
    // unmodelled mode has to travel verbatim or commander rejects it with the choice list.
    pub fn as_cli_flag(&self) -> &str {
        match self {
            Self::Default => "default",
            Self::Manual => "manual",
            Self::AcceptEdits => "acceptEdits",
            Self::Plan => "plan",
            Self::Auto => "auto",
            Self::DontAsk => "dontAsk",
            Self::BypassPermissions => "bypassPermissions",
            Self::Other(s) => s,
        }
    }
}

impl std::fmt::Display for PermissionMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_wire_str())
    }
}

impl From<&str> for PermissionMode {
    fn from(s: &str) -> Self {
        match s {
            "default" => Self::Default,
            "manual" => Self::Manual,
            "accept-edits" => Self::AcceptEdits,
            "plan" => Self::Plan,
            "auto" => Self::Auto,
            "dont-ask" => Self::DontAsk,
            "bypass-permissions" => Self::BypassPermissions,
            other => Self::Other(other.to_owned()),
        }
    }
}

impl Serialize for PermissionMode {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_wire_str())
    }
}

impl<'de> Deserialize<'de> for PermissionMode {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Self::from(String::deserialize(d)?.as_str()))
    }
}

/// Whether a harness-spawned child inherits the user's MCP servers.
///
/// **Off by default; a project opts in.** Owner decision 2026-09-03, on measured grounds: MCP
/// server startup is 751.5 ms of the 1,395 ms median spawn to `system/init` with the owner's two
/// servers connected, against 643.5 ms with `--strict-mcp-config`, and the whole of that wait
/// lands after the `initialize` reply, where the CLI's own turn clock does not count it. The
/// counter-cost of switching it off is $0.00016 and 1,824 prompt tokens per turn. CLI 2.1.259.
// see docs/research/spawn-split.md §1, §2 and §6 (measured).
///
/// Two variants and no third. A file-path variant — `--strict-mcp-config --mcp-config <file>`,
/// naming only the servers a project declares — is the obvious follow-up and is deliberately not
/// built here: `spawn-split.md` §8 records that only the empty case was ever run, so the loading
/// arm of that flag pair is unproven on this machine.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum McpPolicy {
    /// No MCP server loads. The child is spawned with `--strict-mcp-config` and **no**
    /// `--mcp-config`, so the allowed set is empty; `system/init` then reports `mcp_servers: []`,
    /// measured on all six `off` runs in `docs/research/spawn-split.md` §1.
    #[default]
    Off,
    /// Neither flag is passed, so the CLI loads the user's and the project's own MCP
    /// configuration exactly as it does for an interactive session.
    Inherit,
}

impl McpPolicy {
    /// The slug stored in `projects.mcp` and carried on the wire. The set is closed: `off` and
    /// `inherit`, nothing else.
    pub fn as_slug(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Inherit => "inherit",
        }
    }

    /// Parse a slug. `None` for anything outside the closed set, so a caller can refuse it.
    pub fn from_slug(s: &str) -> Option<Self> {
        match s {
            "off" => Some(Self::Off),
            "inherit" => Some(Self::Inherit),
            _ => None,
        }
    }

    /// Parse a slug, falling back to [`McpPolicy::Off`].
    ///
    /// The lossy read is for *stored* values only. An unrecognised slug means a row written by a
    /// build that knows a policy this one does not, and the safe reading of an unknown policy is
    /// the restrictive one: no server loads, rather than the user's whole set silently loading.
    pub fn from_slug_lossy(s: &str) -> Self {
        Self::from_slug(s).unwrap_or_default()
    }
}

impl std::fmt::Display for McpPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_slug())
    }
}

impl Serialize for McpPolicy {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_slug())
    }
}

impl<'de> Deserialize<'de> for McpPolicy {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Self::from_slug(&s).ok_or_else(|| {
            serde::de::Error::custom(format!("unknown mcp policy {s:?}; expected off or inherit"))
        })
    }
}

/// Everything needed to open a new session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartSession {
    /// Working directory for the child; never `chdir` the host.
    pub cwd: PathBuf,
    /// First user turn, sent as soon as the session is up.
    pub prompt: Option<String>,
    /// Model slug; `None` takes the provider default.
    pub model: Option<String>,
    /// Initial permission mode.
    pub permission_mode: PermissionMode,
    /// Env vars layered onto the inherited environment, as values, never via `set_var`.
    // see docs/research/provider-driver.md §6 #6 — zero process-global env mutation.
    pub env_overrides: BTreeMap<String, String>,
    /// Whether this child inherits the user's MCP servers. Defaults to [`McpPolicy::Off`].
    pub mcp: McpPolicy,
    /// Capacity of the bounded event channel; see [`SessionHandle`].
    pub event_buffer: usize,
}

/// Default event-channel capacity when a caller has no opinion.
pub const DEFAULT_EVENT_BUFFER: usize = 256;

impl StartSession {
    /// A start request for `cwd` with provider defaults everywhere else.
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            prompt: None,
            model: None,
            permission_mode: PermissionMode::Default,
            env_overrides: BTreeMap::new(),
            mcp: McpPolicy::default(),
            event_buffer: DEFAULT_EVENT_BUFFER,
        }
    }
}

/// The harness-side continuation of a session that already exists in the store.
///
/// The two fields belong together and are useless apart, which is why they are a struct rather
/// than two optional fields on [`ResumeSession`]: reusing the row without continuing the
/// numbering is the silent-corruption case.
///
/// `feed`'s primary key is `(session_id, seq)` and its insert is `ON CONFLICT DO UPDATE`, so an
/// adapter that restarts at `seq = 1` on an existing row does not error — it rewrites the oldest
/// rows of the old conversation in place, and the ring's trim then deletes the genuinely new
/// ones. Seeding [`Resumed::start_seq`] from `sessions.last_event_seq` is what prevents that.
// see docs/research/resume.md §7 — "the seq seeding is not optional, and its failure is silent".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resumed {
    /// The harness session row to continue. Reused, never minted afresh: the provider keeps one
    /// id across a plain resume, so one harness row per provider session is the honest mapping.
    pub session_id: SessionId,
    /// Highest envelope `seq` the store already holds for that row. The adapter's first
    /// envelope after the resume is `start_seq + 1`.
    pub start_seq: u64,
}

/// Everything needed to reopen an existing provider session.
// see docs/research/agent-sdk.md §5 — the token is the provider's session id, resumable cross-cwd.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResumeSession {
    /// Provider resume token, from `SessionStarted.resume_token`.
    pub token: String,
    /// The harness row this resume continues. `None` mints a fresh session id and starts the
    /// envelope numbering at zero, which is what a caller with no store behind it wants.
    pub resumed: Option<Resumed>,
    /// Working directory for the child.
    pub cwd: PathBuf,
    /// First user turn after the resume completes.
    pub prompt: Option<String>,
    /// Model slug; `None` takes the provider default.
    pub model: Option<String>,
    /// Initial permission mode.
    pub permission_mode: PermissionMode,
    /// Env vars layered onto the inherited environment.
    pub env_overrides: BTreeMap<String, String>,
    /// Whether this child inherits the user's MCP servers. A resume carries the same policy a
    /// start does; nothing about reopening a conversation changes what the child may reach.
    pub mcp: McpPolicy,
    /// Capacity of the bounded event channel.
    pub event_buffer: usize,
}

impl ResumeSession {
    /// A resume request for `token` in `cwd` with provider defaults everywhere else.
    pub fn new(token: impl Into<String>, cwd: impl Into<PathBuf>) -> Self {
        let base = StartSession::new(cwd);
        Self {
            token: token.into(),
            resumed: None,
            cwd: base.cwd,
            prompt: base.prompt,
            model: base.model,
            permission_mode: base.permission_mode,
            env_overrides: base.env_overrides,
            mcp: base.mcp,
            event_buffer: base.event_buffer,
        }
    }
}

/// Why a driver could not start or resume a session.
#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    /// The provider binary was not on disk or not on `PATH`.
    #[error("provider binary not found: {0}")]
    BinaryNotFound(String),
    /// The binary is older than the driver supports.
    // see docs/research/agent-sdk.md §1 — SDK patch equals CLI patch; drift is silent data loss.
    #[error("provider version {found} is older than the required {required}")]
    VersionTooOld {
        /// Version reported by the binary.
        found: String,
        /// Minimum this driver accepts.
        required: String,
    },
    /// The child process could not be spawned.
    #[error("failed to spawn {binary}")]
    Spawn {
        /// Path we tried to spawn.
        binary: String,
        /// The OS error.
        #[source]
        source: std::io::Error,
    },
    /// The child spoke, but not the protocol we expect.
    #[error("protocol error: {0}")]
    Protocol(String),
    /// No usable credential for this instance's account.
    #[error("not logged in: {0}")]
    NotLoggedIn(String),
    /// Anything else from the OS.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// One materialized provider instance. Held by value; started and stopped independently.
pub trait ProviderDriver: Send + Sync + 'static {
    /// Which kind of provider this is.
    fn kind(&self) -> DriverKind;

    /// This instance's routing key. Never defaults to [`ProviderDriver::kind`].
    // see docs/research/provider-driver.md §6 #27 — t3code's kind-as-id shim is rejected.
    fn instance_id(&self) -> &InstanceId;

    /// What to show the operator about this instance.
    fn describe(&self) -> DriverInfo;

    /// Open a new session.
    fn start_session(&self, req: StartSession) -> BoxFuture<'_, Result<SessionHandle, DriverError>>;

    /// Reopen an existing provider session.
    fn resume_session(
        &self,
        req: ResumeSession,
    ) -> BoxFuture<'_, Result<SessionHandle, DriverError>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn driver_kind_is_open_and_checkable() {
        assert!(DriverKind::new("claude-code").is_well_formed());
        assert!(DriverKind::new("codex_app_server").is_well_formed());
        assert!(!DriverKind::new("2fast").is_well_formed());
        assert!(!DriverKind::new("has space").is_well_formed());
        assert!(!DriverKind::new("").is_well_formed());
        assert!(!DriverKind::new("a".repeat(65)).is_well_formed());
        // Open: a malformed slug still parses.
        assert_eq!(DriverKind::new("has space").to_string(), "has space");
        assert_eq!(
            serde_json::to_string(&DriverKind::new("claude-code")).expect("ser"),
            r#""claude-code""#
        );
    }

    #[test]
    fn permission_mode_wire_shape() {
        assert_eq!(
            serde_json::to_string(&PermissionMode::default()).expect("ser"),
            r#""default""#
        );
        assert_eq!(
            serde_json::to_string(&PermissionMode::AcceptEdits).expect("ser"),
            r#""accept-edits""#
        );
        // Kebab-case here, camelCase on the flag; the two must not be confused.
        assert_eq!(
            serde_json::to_string(&PermissionMode::DontAsk).expect("ser"),
            r#""dont-ask""#
        );
        assert_eq!(serde_json::to_string(&PermissionMode::Auto).expect("ser"), r#""auto""#);
        assert_eq!(serde_json::to_string(&PermissionMode::Manual).expect("ser"), r#""manual""#);
        // `Other` is a bare string on the wire, not an externally tagged object.
        assert_eq!(
            serde_json::to_string(&PermissionMode::Other("someFutureMode".into())).expect("ser"),
            r#""someFutureMode""#
        );
    }

    #[test]
    fn permission_mode_round_trips_through_a_bare_string() {
        for mode in [
            PermissionMode::Default,
            PermissionMode::Manual,
            PermissionMode::AcceptEdits,
            PermissionMode::Plan,
            PermissionMode::Auto,
            PermissionMode::DontAsk,
            PermissionMode::BypassPermissions,
            // The CLI spelling of a modelled mode is *not* this crate's spelling, so it stays
            // in `Other` and travels verbatim.
            PermissionMode::Other("dontAsk".into()),
            PermissionMode::Other("someFutureMode".into()),
        ] {
            let json = serde_json::to_string(&mode).expect("ser");
            assert!(json.starts_with('"'), "{json} must be a bare string");
            let back: PermissionMode = serde_json::from_str(&json).expect("de");
            assert_eq!(back, mode);
        }
        // The one deliberate collapse: an `Other` spelling a modelled mode folds into it.
        assert_eq!(
            serde_json::from_str::<PermissionMode>(r#""default""#).expect("de"),
            PermissionMode::Default
        );
    }

    #[test]
    fn permission_mode_cli_flags_are_the_camel_case_claude_spelling() {
        // The seven values `claude --permission-mode` accepts on 2.1.258, all seven modelled.
        // see docs/research/approvals.md §3 (measured against the binary's own validation).
        assert_eq!(PermissionMode::Default.as_cli_flag(), "default");
        assert_eq!(PermissionMode::Manual.as_cli_flag(), "manual");
        assert_eq!(PermissionMode::AcceptEdits.as_cli_flag(), "acceptEdits");
        assert_eq!(PermissionMode::Plan.as_cli_flag(), "plan");
        assert_eq!(PermissionMode::Auto.as_cli_flag(), "auto");
        assert_eq!(PermissionMode::DontAsk.as_cli_flag(), "dontAsk");
        assert_eq!(PermissionMode::BypassPermissions.as_cli_flag(), "bypassPermissions");
        assert_eq!(PermissionMode::Other("someFutureMode".into()).as_cli_flag(), "someFutureMode");
        assert_eq!(PermissionMode::AcceptEdits.to_string(), "accept-edits");
        // Kebab on our wire, camel on the flag — the one pair where they differ.
        assert_eq!(PermissionMode::DontAsk.as_wire_str(), "dont-ask");
        assert_eq!(PermissionMode::DontAsk.as_cli_flag(), "dontAsk");
    }

    /// The default is the decision, and it is the restrictive one. A start request nobody has
    /// configured spawns a child with no MCP server at all.
    // see docs/research/spawn-split.md §6 and docs/vision.md §3 (owner decision 2026-09-03).
    #[test]
    fn the_mcp_default_is_off_on_both_request_shapes() {
        assert_eq!(McpPolicy::default(), McpPolicy::Off);
        assert_eq!(StartSession::new("/w").mcp, McpPolicy::Off);
        assert_eq!(ResumeSession::new("tok", "/w").mcp, McpPolicy::Off);
    }

    /// The slug set is closed and pinned: two values, nothing else. A stored slug from a build
    /// that knows a third policy reads back as `off`, never as `inherit`.
    #[test]
    fn the_mcp_slug_set_is_off_and_inherit_and_an_unknown_one_reads_back_off() {
        assert_eq!(McpPolicy::Off.as_slug(), "off");
        assert_eq!(McpPolicy::Inherit.as_slug(), "inherit");
        assert_eq!(McpPolicy::from_slug("off"), Some(McpPolicy::Off));
        assert_eq!(McpPolicy::from_slug("inherit"), Some(McpPolicy::Inherit));
        assert_eq!(McpPolicy::from_slug("everything"), None);
        assert_eq!(McpPolicy::from_slug_lossy("everything"), McpPolicy::Off);
        assert_eq!(McpPolicy::Inherit.to_string(), "inherit");
    }

    /// A bare string on the wire, like `PermissionMode`, and strict on the way in: an unmodelled
    /// policy is a protocol error rather than a silent downgrade.
    #[test]
    fn an_mcp_policy_is_a_bare_string_on_the_wire() {
        assert_eq!(serde_json::to_string(&McpPolicy::Off).expect("ser"), r#""off""#);
        assert_eq!(
            serde_json::from_str::<McpPolicy>(r#""inherit""#).expect("de"),
            McpPolicy::Inherit
        );
        let err = serde_json::from_str::<McpPolicy>(r#""everything""#).expect_err("closed set");
        assert!(err.to_string().contains("off or inherit"), "{err}");
    }

    #[test]
    fn requests_default_to_a_bounded_buffer() {
        let s = StartSession::new("/w");
        assert_eq!(s.event_buffer, DEFAULT_EVENT_BUFFER);
        assert!(s.env_overrides.is_empty());
        let r = ResumeSession::new("tok", "/w");
        assert_eq!(r.token, "tok");
        assert_eq!(r.event_buffer, DEFAULT_EVENT_BUFFER);
        // A resume with no harness row behind it: a fresh id, numbering from zero.
        assert_eq!(r.resumed, None);
    }

    /// Pins the **shape** of the request — that the row and the seq travel together and cannot
    /// be set apart — not that anything honours them. The end-to-end proof that a resumed adapter
    /// actually continues the numbering is
    /// `crates/supervisor/src/lib.rs::a_resumed_session_reuses_its_row_and_continues_its_feed`.
    // see docs/research/resume.md §7.
    #[test]
    fn a_resumed_session_carries_the_row_and_the_seq_together() {
        let mut r = ResumeSession::new("tok", "/w");
        r.resumed = Some(Resumed { session_id: SessionId::new("s1"), start_seq: 42 });
        let resumed = r.resumed.expect("set above");
        assert_eq!(resumed.session_id.as_str(), "s1");
        assert_eq!(resumed.start_seq, 42);
    }

    #[test]
    fn driver_error_messages_name_the_remedy() {
        let e = DriverError::VersionTooOld { found: "2.1.1".into(), required: "2.1.257".into() };
        assert_eq!(e.to_string(), "provider version 2.1.1 is older than the required 2.1.257");
    }
}
