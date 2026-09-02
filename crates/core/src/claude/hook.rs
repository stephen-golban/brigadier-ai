//! The `PreToolUse` hook seam.
//!
//! Why a hook at all, when `can_use_tool` exists: the spike measured `can_use_tool` being
//! shadowed twice over — once by the user's `~/.claude/settings.json` `defaultMode`, and again,
//! even with the mode pinned to `default`, by the **built-in read-only Bash command set**, which
//! auto-approved a bare `echo` without ever putting a frame on the wire. That set is static and
//! **not configurable** (`ls`, `cat`, `echo`, `pwd`, `head`, `tail`, `grep`, `find`, `wc`,
//! `which`, `diff`, `stat`, `du`, `cd`, read-only `git`), and it skips the prompt **in every
//! mode**. It is not the model-based classifier, which is a separate, billable thing bound to
//! `--permission-mode auto`. A `PreToolUse` hook fired on that same `echo`.
// see docs/research/approvals.md §1(b) (documented, quoting
// https://code.claude.com/docs/en/permissions#read-only-commands) and
// docs/research/claude-direct-spike.md "The two shadows over `can_use_tool`" (measured), and
// docs/research/agent-sdk.md §3 — "To gate *every* call regardless of mode and rules, the
// documented answer is a `PreToolUse` hook".
//!
//! Two policies live here. [`AskGatedTools`] is what the harness ships: it answers
//! `permissionDecision: "ask"` for the tools that can change the world, which is the one lever
//! that forces a `can_use_tool` prompt past the read-only set. [`AllowAll`] answers `{}` — "no
//! opinion", **not** allow — which is what the spike proved the CLI accepts (scenario 6: the tool
//! proceeded and `can_use_tool` followed); it is kept for replay and for tests that must not
//! change the fixture's behaviour.
// see docs/research/approvals.md §5 for the four decisions the 2.1.258 binary's own zod schema
// accepts (`allow|deny|ask|defer`, measured with `strings`) and §7 gap 1 for why `{}` is not a gate.

use std::collections::BTreeSet;
use std::sync::Arc;

use claude_wire::HookJsonOutput;
use serde_json::{json, Value};

/// Callback id registered in the `initialize` handshake and echoed back on every
/// `hook_callback`.
// see docs/research/claude-direct-spike.md, `fixtures/s6-hook-callback.sent.ndjson`.
pub const PRE_TOOL_USE_CALLBACK_ID: &str = "brigadier_pre_tool_use";

/// The tools [`AskGatedTools::default`] prompts for: everything that writes.
///
/// Read-only tools (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `TodoWrite`, …) are left to
/// the CLI's own flow — prompting for them would put a card in front of the operator several
/// times a turn and train them to click allow.
pub const GATED_TOOLS: &[&str] = &["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"];

/// The reason [`AskGatedTools::default`] hands the CLI, shown next to the prompt.
pub const DEFAULT_ASK_REASON: &str = "brigadier gates this tool";

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

/// No opinion, always: answers `{}` and lets the CLI's normal flow decide.
///
/// **Not an allow.** `permissionDecision` is optional in the CLI's schema, so an empty
/// `hookSpecificOutput` falls through to deny rules, ask rules, the permission mode and allow
/// rules — which for a read-only Bash command means no prompt at all. The name is historical.
// see docs/research/approvals.md §5 (fall-through for an empty object is asserted, not stated
// verbatim in the docs) and §7 gap 1.
#[derive(Clone, Copy, Debug, Default)]
pub struct AllowAll;

impl HookPolicy for AllowAll {
    fn pre_tool_use(&self, _tool_name: Option<&str>, _input: &Value) -> HookJsonOutput {
        // `{}` — every field is `skip_serializing_if = "Option::is_none"`. This is the exact
        // body the spike sent and the CLI accepted.
        HookJsonOutput::default()
    }
}

/// Answers `permissionDecision: "ask"` for a named set of tools and `{}` for everything else.
///
/// This is the harness's gate. `"ask"` is the only documented lever that reaches a tool call the
/// permission machinery would otherwise auto-approve: hooks run **before** deny rules, ask rules,
/// the permission mode and allow rules, and `"ask"` prompts the user to confirm. A tool that is
/// not in the set gets `{}` and is never held up.
///
/// An absent tool name never matches — a callback the harness cannot identify falls through
/// rather than gating everything.
// see docs/research/approvals.md §5 (documented evaluation order, and the 2.1.258 zod schema
// measured out of the binary: `hookEventName`, `permissionDecision`, `permissionDecisionReason`).
#[derive(Clone, Debug)]
pub struct AskGatedTools {
    tools: BTreeSet<String>,
    reason: String,
}

impl Default for AskGatedTools {
    fn default() -> Self {
        Self::new(GATED_TOOLS.iter().copied())
    }
}

impl AskGatedTools {
    /// Gate exactly `tools`, with [`DEFAULT_ASK_REASON`].
    pub fn new<S: Into<String>>(tools: impl IntoIterator<Item = S>) -> Self {
        Self {
            tools: tools.into_iter().map(Into::into).collect(),
            reason: DEFAULT_ASK_REASON.to_owned(),
        }
    }

    /// Replace the `permissionDecisionReason` sent with every `ask`.
    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = reason.into();
        self
    }

    /// The gated set, sorted.
    pub fn tools(&self) -> impl Iterator<Item = &str> {
        self.tools.iter().map(String::as_str)
    }

    /// Whether a tool name is gated. `None` is never gated.
    pub fn gates(&self, tool_name: Option<&str>) -> bool {
        tool_name.is_some_and(|name| self.tools.contains(name))
    }
}

impl HookPolicy for AskGatedTools {
    fn pre_tool_use(&self, tool_name: Option<&str>, _input: &Value) -> HookJsonOutput {
        if !self.gates(tool_name) {
            return HookJsonOutput::default();
        }
        HookJsonOutput {
            hook_specific_output: Some(json!({
                "hookEventName": "PreToolUse",
                "permissionDecision": "ask",
                "permissionDecisionReason": self.reason,
            })),
            ..HookJsonOutput::default()
        }
    }
}

/// A shared policy, as the adapter holds it.
pub type SharedHookPolicy = Arc<dyn HookPolicy>;

/// [`AllowAll`], boxed.
pub fn allow_all() -> SharedHookPolicy {
    Arc::new(AllowAll)
}

/// [`AskGatedTools::default`], boxed. The policy every [`ClaudeDriver`](crate::claude::ClaudeDriver)
/// starts with.
pub fn ask_gated_tools() -> SharedHookPolicy {
    Arc::new(AskGatedTools::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_all_serializes_to_the_empty_object_the_cli_accepted() {
        let out = AllowAll.pre_tool_use(Some("Bash"), &serde_json::json!({"command": "echo hi"}));
        assert_eq!(serde_json::to_string(&out).expect("ser"), "{}");
    }

    /// The exact bytes that go back on a `hook_callback` for a gated tool. Field casing is the
    /// whole point: the 2.1.258 binary's zod schema is
    /// `{hookEventName: x("PreToolUse"), permissionDecision: …optional(), permissionDecisionReason:
    /// …optional()}` and a snake_case key is silently ignored, not rejected.
    // see docs/research/approvals.md §5 (measured with `strings` over 2.1.258).
    #[test]
    fn a_gated_tool_asks_in_the_cli_spelling() {
        let policy = AskGatedTools::default().with_reason("brigadier gates this tool");
        let out = policy.pre_tool_use(Some("Bash"), &serde_json::json!({"command": "ls -1"}));
        assert_eq!(
            serde_json::to_string(&out).expect("ser"),
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"brigadier gates this tool"}}"#
        );
    }

    #[test]
    fn an_ungated_tool_and_an_unnamed_callback_both_fall_through() {
        let policy = AskGatedTools::default();
        for name in [Some("Read"), Some("Glob"), Some("Grep"), Some("WebFetch"), Some("TodoWrite")] {
            let out = policy.pre_tool_use(name, &Value::Null);
            assert_eq!(serde_json::to_string(&out).expect("ser"), "{}", "{name:?} must not ask");
        }
        // An absent name must not be treated as a match for anything.
        assert_eq!(
            serde_json::to_string(&policy.pre_tool_use(None, &Value::Null)).expect("ser"),
            "{}"
        );
    }

    #[test]
    fn the_default_set_is_every_tool_that_writes() {
        let policy = AskGatedTools::default();
        assert_eq!(
            policy.tools().collect::<Vec<_>>(),
            ["Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"]
        );
        for tool in GATED_TOOLS {
            assert!(policy.gates(Some(tool)), "{tool} must be gated");
        }
    }

    #[test]
    fn a_custom_set_gates_only_what_it_names() {
        let policy = AskGatedTools::new(["Write"]).with_reason("writes only");
        assert!(policy.gates(Some("Write")));
        assert!(!policy.gates(Some("Bash")));
        let out = policy.pre_tool_use(Some("Write"), &Value::Null);
        let json: Value = serde_json::to_value(&out).expect("ser");
        assert_eq!(json["hookSpecificOutput"]["permissionDecisionReason"], "writes only");
    }
}
