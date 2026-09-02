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

use crate::event::InstanceId;
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
/// unmodelled mode is `"dontAsk"`, not `{"other":"dontAsk"}`, so a value round-trips through
/// persistence and through the CLI's own vocabulary unchanged. The four modelled variants use
/// this crate's kebab-case spelling; [`PermissionMode::as_cli_flag`] is the Claude spelling.
///
/// Not injective: `Other("default")` deserializes back as [`PermissionMode::Default`]. That is
/// the intended collapse — the same mode should not have two representations.
// see docs/research/agent-sdk.md §7 — Claude's set is
// `default|acceptEdits|bypassPermissions|plan|dontAsk|auto`; the rest ride in `Other`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum PermissionMode {
    /// Ask per the provider's own rules.
    #[default]
    Default,
    /// Auto-approve edits inside the workspace.
    AcceptEdits,
    /// Plan only; take no action.
    Plan,
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
            Self::AcceptEdits => "accept-edits",
            Self::Plan => "plan",
            Self::BypassPermissions => "bypass-permissions",
            Self::Other(s) => s,
        }
    }

    /// The value Claude Code's `--permission-mode` flag and its `set_permission_mode` control
    /// request expect.
    // see docs/research/agent-sdk.md §7 — the CLI's set is
    // `default|acceptEdits|bypassPermissions|plan|dontAsk|auto`, camelCase, so an unmodelled
    // mode has to travel verbatim or the CLI rejects it.
    pub fn as_cli_flag(&self) -> &str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::Plan => "plan",
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
            "accept-edits" => Self::AcceptEdits,
            "plan" => Self::Plan,
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
            event_buffer: DEFAULT_EVENT_BUFFER,
        }
    }
}

/// Everything needed to reopen an existing provider session.
// see docs/research/agent-sdk.md §5 — the token is the provider's session id, resumable cross-cwd.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResumeSession {
    /// Provider resume token, from `SessionStarted.resume_token`.
    pub token: String,
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
    /// Capacity of the bounded event channel.
    pub event_buffer: usize,
}

impl ResumeSession {
    /// A resume request for `token` in `cwd` with provider defaults everywhere else.
    pub fn new(token: impl Into<String>, cwd: impl Into<PathBuf>) -> Self {
        let base = StartSession::new(cwd);
        Self {
            token: token.into(),
            cwd: base.cwd,
            prompt: base.prompt,
            model: base.model,
            permission_mode: base.permission_mode,
            env_overrides: base.env_overrides,
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
        // `Other` is a bare string on the wire, not an externally tagged object.
        assert_eq!(
            serde_json::to_string(&PermissionMode::Other("dontAsk".into())).expect("ser"),
            r#""dontAsk""#
        );
    }

    #[test]
    fn permission_mode_round_trips_through_a_bare_string() {
        for mode in [
            PermissionMode::Default,
            PermissionMode::AcceptEdits,
            PermissionMode::Plan,
            PermissionMode::BypassPermissions,
            PermissionMode::Other("dontAsk".into()),
            PermissionMode::Other("auto".into()),
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
        // see docs/research/agent-sdk.md §7.
        assert_eq!(PermissionMode::Default.as_cli_flag(), "default");
        assert_eq!(PermissionMode::AcceptEdits.as_cli_flag(), "acceptEdits");
        assert_eq!(PermissionMode::Plan.as_cli_flag(), "plan");
        assert_eq!(PermissionMode::BypassPermissions.as_cli_flag(), "bypassPermissions");
        assert_eq!(PermissionMode::Other("dontAsk".into()).as_cli_flag(), "dontAsk");
        assert_eq!(PermissionMode::AcceptEdits.to_string(), "accept-edits");
    }

    #[test]
    fn requests_default_to_a_bounded_buffer() {
        let s = StartSession::new("/w");
        assert_eq!(s.event_buffer, DEFAULT_EVENT_BUFFER);
        assert!(s.env_overrides.is_empty());
        let r = ResumeSession::new("tok", "/w");
        assert_eq!(r.token, "tok");
        assert_eq!(r.event_buffer, DEFAULT_EVENT_BUFFER);
    }

    #[test]
    fn driver_error_messages_name_the_remedy() {
        let e = DriverError::VersionTooOld { found: "2.1.1".into(), required: "2.1.257".into() };
        assert_eq!(e.to_string(), "provider version 2.1.1 is older than the required 2.1.257");
    }
}
