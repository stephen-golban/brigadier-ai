//! The Claude Code driver: Rust speaks the CLI's `stream-json` stdio protocol directly.
//!
//! No Node, no `@anthropic-ai/claude-agent-sdk`, no `claude -p`. The child is
//! `claude --output-format stream-json --verbose --input-format stream-json
//! --permission-prompt-tool stdio`, and everything below translates between that wire and the
//! canonical [`crate::event`] schema.
//!
//! Decision 1 of `docs/plans/provider-spi.md`, gated by a spike that passed 7 of 7 scenarios
//! against a live account: `can_use_tool` allow and deny, `hook_callback`, `interrupt` with the
//! session surviving, `--resume` onto the original id, and a clean kill.
// see docs/research/claude-direct-spike.md "Bottom line" (measured) and
// docs/research/cli-protocol.md §1-§2 for the protocol itself.
//!
//! # The pieces
//!
//! * [`binary`] — resolve `claude` on `PATH`, check `claude --version` against a floor.
//! * [`process`] — argv, environment, spawn, and a process-group kill that reaches the CLI's own
//!   tool subprocesses.
//! * [`adapter`] — the per-session task: wire → canonical, approvals, commands, teardown.
//! * [`hook`] — the `PreToolUse` seam that sees every tool call, including the ones the CLI's
//!   safe-command classifier would auto-approve.
//! * [`driver`] — [`ClaudeDriver`], one value per account.
//!
//! # Two shadows the driver has to work around
//!
//! `can_use_tool` alone is not a reliable gate. The spike measured it silently disabled by the
//! user's `~/.claude/settings.json` `defaultMode`, and again — with the mode pinned to `default` —
//! by the CLI's own command-safety classifier. So this driver **always** passes
//! `--permission-mode`, and registers a `PreToolUse` hook in the `initialize` handshake rather
//! than injecting ask rules.
// see docs/research/claude-direct-spike.md "The two shadows over `can_use_tool`".

pub mod adapter;
pub mod binary;
pub mod driver;
pub mod hook;
pub mod process;

pub use adapter::{approval_request_id, connect, AdapterConfig};
pub use binary::{resolve_claude, CLAUDE_BIN, MIN_VERSION};
pub use driver::{ClaudeDriver, ClaudeDriverConfig, CLAUDE_CODE, DEFAULT_APPROVAL_TIMEOUT};
pub use hook::{allow_all, AllowAll, HookPolicy, SharedHookPolicy, PRE_TOOL_USE_CALLBACK_ID};
pub use process::{ExitInfo, KillHandle, SpawnSpec};
