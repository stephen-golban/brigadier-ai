//! The `PreToolUse` hook seam.
//!
//! Why a hook at all, when `can_use_tool` exists: the spike measured `can_use_tool` being
//! shadowed twice over — once by the user's `~/.claude/settings.json` `defaultMode`, and again,
//! even with the mode pinned to `default`, by the CLI's own command-safety classifier, which
//! auto-approved a bare `echo` without ever putting a frame on the wire. A `PreToolUse` hook
//! fired on that same `echo`.
// see docs/research/claude-direct-spike.md "The two shadows over `can_use_tool`" (measured) and
// docs/research/agent-sdk.md §3 — "To gate *every* call regardless of mode and rules, the
// documented answer is a `PreToolUse` hook".
//!
//! Nothing here decides anything yet. [`AllowAll`] answers `{}` — continue — for every call,
//! which is what the spike proved works (scenario 6: the tool proceeded and `can_use_tool`
//! followed). The trait is the seam the harness's own rules plug into later.

use std::sync::Arc;

use claude_wire::HookJsonOutput;
use serde_json::Value;

/// Callback id registered in the `initialize` handshake and echoed back on every
/// `hook_callback`.
// see docs/research/claude-direct-spike.md, `fixtures/s6-hook-callback.sent.ndjson`.
pub const PRE_TOOL_USE_CALLBACK_ID: &str = "brigadier_pre_tool_use";

/// One `PreToolUse` decision.
///
/// Synchronous on purpose: this is policy the harness already knows, not a question for the
/// operator. A question for the operator is a `can_use_tool` prompt, which parks in the
/// [`crate::approval::ApprovalTable`] with a deadline. A hook that blocked on a human would wedge
/// the turn with no timeout.
pub trait HookPolicy: Send + Sync + 'static {
    /// Decide what to answer a `PreToolUse` callback.
    ///
    /// `tool_name` and `input` come out of the callback's `input` object (`HookInput`); either
    /// can be absent, and an absent name must not be treated as a match for anything.
    fn pre_tool_use(&self, tool_name: Option<&str>, input: &Value) -> HookJsonOutput;
}

/// The default policy: continue, always.
#[derive(Clone, Copy, Debug, Default)]
pub struct AllowAll;

impl HookPolicy for AllowAll {
    fn pre_tool_use(&self, _tool_name: Option<&str>, _input: &Value) -> HookJsonOutput {
        // `{}` — every field is `skip_serializing_if = "Option::is_none"`. This is the exact
        // body the spike sent and the CLI accepted.
        HookJsonOutput::default()
    }
}

/// A shared policy, as the adapter holds it.
pub type SharedHookPolicy = Arc<dyn HookPolicy>;

/// [`AllowAll`], boxed.
pub fn allow_all() -> SharedHookPolicy {
    Arc::new(AllowAll)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_all_serializes_to_the_empty_object_the_cli_accepted() {
        let out = AllowAll.pre_tool_use(Some("Bash"), &serde_json::json!({"command": "echo hi"}));
        assert_eq!(serde_json::to_string(&out).expect("ser"), "{}");
    }
}
