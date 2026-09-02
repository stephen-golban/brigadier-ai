//! The Claude Code driver: Rust speaks the CLI's `stream-json` stdio protocol directly.
//!
//! No Node, no `@anthropic-ai/claude-agent-sdk`, no `claude -p`. The child is
//! `claude --output-format stream-json --verbose --input-format stream-json
//! --permission-prompt-tool stdio`, and everything below translates between that wire and the
//! canonical [`crate::event`] schema.
//!
//! Settled in `CLAUDE.md` §2 and gated by a spike that passed 7 of 7 scenarios
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
//!   built-in read-only Bash command set would auto-approve. The shipped policy answers
//!   `permissionDecision: "ask"` for the tools that write, which is what makes a `can_use_tool`
//!   prompt appear at all.
//! * [`driver`] — [`ClaudeDriver`], one value per account.
//!
//! # Two shadows the driver has to work around
//!
//! `can_use_tool` alone is not a reliable gate. The spike measured it silently disabled by the
//! user's `~/.claude/settings.json` `defaultMode`, and again — with the mode pinned to `default` —
//! by the CLI's **built-in read-only Bash command set**: a static, non-configurable list (`ls`,
//! `cat`, `echo`, `pwd`, `head`, `tail`, `grep`, `find`, `wc`, `which`, `diff`, `stat`, `du`,
//! `cd`, read-only `git`) that skips the prompt in every mode. It is *not* the model-based
//! classifier, which is `--permission-mode auto` only and billable. So this driver **always**
//! passes `--permission-mode`, and registers a `PreToolUse` hook in the `initialize` handshake
//! whose policy answers `ask` for the gated tools, rather than injecting ask rules.
// see docs/research/approvals.md §1(b) (documented) and
// docs/research/claude-direct-spike.md "The two shadows over `can_use_tool`" (measured).

pub mod adapter;
pub mod binary;
pub mod driver;
pub mod hook;
pub mod process;

pub use adapter::{approval_request_id, connect, AdapterConfig};
pub use binary::{resolve_claude, CLAUDE_BIN, MIN_VERSION};
pub use driver::{ClaudeDriver, ClaudeDriverConfig, CLAUDE_CODE, DEFAULT_APPROVAL_TIMEOUT};
pub use hook::{
    allow_all, ask_gated_tools, AllowAll, AskGatedTools, HookPolicy, SharedHookPolicy,
    DEFAULT_ASK_REASON, GATED_TOOLS, PRE_TOOL_USE_CALLBACK_ID,
};
pub use process::{ExitInfo, KillHandle, SpawnSpec};
