# Brigadier delivery efficiency

2026-09-09. Scope: Rust driving the user's Claude Code CLI. Documentation and source review only; no live trials, downloads, or measured savings. Recommendations below are hypotheses to validate against completed, correct work.

## Verified external guidance

- **Keep routine context small.** Claude Code includes CLAUDE.md in every request; skill descriptions are present initially and full instructions load when used. Subagents isolate their context, but supplied subagent skills load fully at launch. Move specialized workflow detail out of always-loaded instructions while retaining essential constraints. [Anthropic feature context costs](https://code.claude.com/docs/en/features-overview#context-cost-by-feature).
- **Give precise work and verification targets.** Anthropic recommends bounded tasks and executable success criteria. Planning adds overhead for obvious small edits; it is useful for uncertain approaches. For Brigadier, supply relevant paths and an exact targeted check, then retain required final gates. This proposed packaging has not been benchmarked here. [Claude Code best practices](https://code.claude.com/docs/en/best-practices).
- **Reduce noisy tool results.** Anthropic recommends specific prompts, limiting unnecessary MCP servers, and keeping verbose research/test work outside the main conversation. Extra agents also consume their own tokens; context isolation is not proof of lower total usage. For Brigadier, return test status and relevant failures, with full logs available on demand; preserve real exit codes and diagnostics. [Claude Code usage management](https://code.claude.com/docs/en/costs).
- **Choose model and reasoning effort for the task.** CLI `--effort` and `CLAUDE_CODE_EFFORT_LEVEL` exist; supported levels depend on model. Lower effort trades capability for speed and lower usage, so restrict it to straightforward work and preserve escalation. The same effort name is not equivalent across models. Verify the user's installed CLI and actual applied settings before wiring changes. [Model configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level).
- **Caching already exists.** Claude Code automatically caches matching request prefixes. Keep model, effort, and stable instructions fixed within a task where practical. Changing models rebuilds the cache; effort behavior depends on model/provider. Compaction requires a summarization call and replaces the conversation prefix. Fresh sessions and compaction have overhead, so use natural task boundaries rather than resetting after every action. Native subagents warm their own cache, separate from the parent's. These facts do not establish cache sharing between Brigadier's independently spawned sessions. [Prompt caching](https://code.claude.com/docs/en/prompt-caching).
- **Separate token totals from subscription usage.** Pro/Max session dollar estimates are not subscription bills. Track uncached input, cache writes, cache reads, and output separately; also observe the subscription windows users actually depend on. A smaller raw token total alone does not establish a proportional increase in subscription capacity. [Usage accounting](https://code.claude.com/docs/en/costs#using-the-usage-command).

## Current Brigadier findings

Source findings verified by the coordinating local review, not performance measurements:

- `crates/supervisor/src/action.rs` defines a minimum of two phases; `plan.rs` enforces the minimum in its planner prompt. This imposes structure even on small work.
- `plan.rs` explicitly says the planned approximately 1,500-token repository brief is not implemented. `dispatch.rs::worker_prompt` carries goal, phase, instructions, and owned paths, without a repository brief or explicit verification-command field.
- `plan.rs::lead_prompt` already avoids carrying worker transcripts and logs, and requests parallel orders. `call.rs::SupervisedCall` starts a fresh session per decision. Avoid adding redundant parallel discovery or more unnecessary lead decisions.
- Routing already has model ceilings; `dispatch.rs::tier_thinking` disables thinking for low/mid tiers and inherits it for high tiers. Model routing is not a missing feature to introduce from scratch.
- `crates/core/src/event.rs::Usage` separates token categories. `crates/supervisor/src/lib.rs` distinguishes lifetime usage from context footprint.

## Suggested order, unmeasured

1. Add a small-job route that can use one implementation phase instead of requiring two.
2. Build a bounded task brief from git, manifests, relevant entry points, constraints, and verification commands. Cache reusable facts by content identity and invalidate changed facts.
3. Trim repeated instructions and redundant discovery; return concise tool summaries without hiding failures.
4. Use parallel workers only for independent useful work. Preserve required final checks while running targeted checks during iteration.
5. Evaluate total elapsed time, subscription-window consumption where observable, separate token categories, retries, and final correctness per completed task. Include all workers, planning, and verification. Do not promise a saving percentage before representative measurements.

No runtime configuration or product code was changed by this research.

## Portability across models and providers

There is no universal guarantee that reducing context or orchestration improves every model's speed, usage, or correctness. Compatibility of the harness and measured quality of the model are separate requirements.

**Verified protocol example:** ACP negotiates versions and capabilities at initialization, treats omitted capabilities as unsupported, and defines baseline session methods plus optional extensions. Its tool-call protocol supports explicit permission requests. This is evidence for capability-driven adapters, not evidence that Brigadier implements ACP or that all agents expose identical controls. [ACP v1 initialization](https://agentclientprotocol.com/protocol/v1/initialization), [ACP v1 tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls).

**Current source finding:** `crates/core/src/driver.rs::ProviderDriver` provides an abstraction, but `crates/supervisor/src/action.rs::ModelTier` names Opus/Sonnet/Haiku, and `crates/supervisor/src/loop_/call.rs` imports Claude hook policy. The supervisor is not provider-independent today.

**Proposed boundary:** Keep task briefs, work ownership, test selection, result validation, and scheduling in the shared harness. Put model identifiers, effort controls, permissions, context limits, caching behavior, and usage interpretation behind provider capabilities. Omit unsupported optional tuning; reject workflows when an adapter cannot enforce required permissions. Never assume token counts or reasoning-level names mean the same thing across providers.

**Proposed acceptance checks:** Test adapter contracts for lifecycle, cancellation, permission decisions, errors, and usage accounting. Separately run repeated, same-task baseline-versus-change comparisons within each supported model/version, using independent correctness checks and recording elapsed time, retries, and separate usage categories. Enable an optimization only for configurations where evidence supports it; retain the baseline elsewhere. These checks limit regressions but cannot prove future universal performance. This research adds no second provider or new test artifacts.
