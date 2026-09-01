# Long-session architecture — research brief

Question asked: can a harness run sessions long enough to "one-shot an entire project"?

## Verdict

No. "One-shot an entire project in a single session" is marketing for an orchestrated
series of sessions that feels like one. Anthropic's own published reference design for
long-running coding agents is **fresh sessions + files as connective tissue + a git
commit per phase** — not one long session.
https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

Sell **continuity across sessions**, not session length. The honest claim is "the
project finishes unattended."

## What actually ends or degrades a session

| Mechanism | Limit / symptom |
|---|---|
| Context exhaustion | 1M tokens (Opus 5, Fable 5, Sonnet 5, Opus 4.7+, Sonnet 4.6); 200K Haiku 4.5 and older |
| Auto-compact quality loss | "specific instructions from early in the conversation may not be preserved" |
| Context rot | Recall accuracy falls as tokens rise — degrades BEFORE the hard limit |
| Tool-result bloat | "thousands of tokens in a single turn" |
| Cost growth | Full history resent every request; a one-line question in an all-day session bills the whole conversation |
| Cache expiry | First message after a gap > TTL reprocesses everything uncached |
| Rate limits | Org-level, per model class. RPM + ITPM + OTPM. Spend-cap 429 has no retry-after and always fails |
| Subscription caps | Rolling 5-hour + weekly window, shared across Claude Code + chat |
| Loop stops | error_max_turns, error_max_budget_usd, error_during_execution, stop_reason "refusal" |

## Auto-compaction — what is controllable

Automatic, inside the bundled CLI. Emits SystemMessage subtype `compact_boundary`
(TS: `SDKCompactBoundaryMessage`).

Thresholds: default = model context limit, except Sonnet 4.6 / Opus 4.6 / Opus 4.8 /
Opus 5 on a 200K window compact at 200K; **Sonnet 5 at ~967K**.

Configurable: `/autocompact 500k`, `claude --autocompact 500k`, setting
`autoCompactWindow`, env `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (env wins). Range 100K–1M.
`CLAUDE_CODE_DISABLE_1M_CONTEXT=1` forces 200K.

SDK options that exist: `maxTurns`, `maxBudgetUsd` (includes subagent spend, needs
Claude Code >= v2.1.217), `taskBudget: { total }` (alpha — the model is told the budget
and paces itself), `effort: low|medium|high|xhigh|max`, `resume`, `continue`,
`forkSession`, `sessionId`, `persistSession`, `sessionStore`, `resumeSessionAt`
(resume at a message UUID), `resumeDropsTurn`.

**PreCompact hook** (`trigger: manual | auto`) is the ONLY programmatic seam into
compaction. Hooks run in your process and do not consume context.

Does NOT exist: any `contextManagement` / `compactionControl` / `autoCompact` SDK
option; no `/context` equivalent (open issue claude-agent-sdk-python#507).

Microcompact (clears stale tool results without a model call) is real but undocumented
— treat mechanism claims as unverified.

## Raw Messages API long-horizon features (not in the Agent SDK)

- **Context editing** — beta `context-management-2025-06-27`.
  `clear_tool_uses_20250919`: trigger (default 100,000 input tokens), keep (default 3),
  `clear_at_least`, `exclude_tools`, `clear_tool_inputs`.
  `clear_thinking_20251015`: keep "all" or N turns. Must be listed first when combined.
- **Server-side compaction** — beta `compact-2026-01-12`, `{type: "compact_20260112"}`.
  Default trigger 150,000 input tokens, minimum 50,000. `pause_after_compaction`,
  `instructions`. You must append `response.content` (the compaction block), not just
  text, or state is silently lost.
- **Memory tool** — `{"type":"memory_20250818","name":"memory"}`, client-side,
  `/memories` prefix. TS helpers `betaMemoryTool`, `BetaLocalFilesystemMemoryTool`.
  Its system prompt says: "ASSUME INTERRUPTION: Your context window might be reset at
  any moment." Documented multisession software-development pattern: initializer writes
  a progress log + feature checklist; each later session reads first, updates at end.
- **Subagent offloading** — subagent starts fresh, sees none of the parent's turns; only
  its final response returns. Anthropic's research system returned ~1,000–2,000-token
  condensed summaries.

## Prompt caching — the actual throughput moat

- TTLs: ephemeral = 5 min; `ttl: "1h"` = 1 hour. Max 4 breakpoints/request.
  Writes 1.25x (5m) / 2x (1h); reads 0.1x. Break-even 2 requests (5m), 3 (1h).
- Lifetime measured from the START of the writing request. A read refreshes the timer
  free — a loop whose turns finish under 5 min keeps the cheap TTL warm indefinitely.
- Minimum cacheable prefix is non-monotonic: 512 (Opus 5, Fable 5), 1024 (Opus 4.8,
  Sonnet 5/4.6/4.5), 2048 (Opus 4.7), 4096 (Opus 4.6/4.5, Haiku 4.5). Below it, silent
  no-cache with `cache_creation_input_tokens: 0`.
- Invalidators (prefix match, order tools -> system -> messages): any byte change,
  CHANGING THE TOOL SET, SWITCHING MODEL, editing top-level system mid-session,
  timestamps/UUIDs/unsorted JSON in the prefix.
- **`cache_read_input_tokens` do not count toward ITPM** (except Haiku 3.5). Anthropic's
  example: 2M ITPM at 80% hit rate ~= 10M effective input tokens/min.

### Harness rules that follow
1. Freeze the system prompt; sort the tool list deterministically.
2. Inject per-turn state as a mid-conversation `{"role":"system"}` message (works on
   Opus 5 / Opus 4.8 / Fable 5 / Mythos 5; **400s on Sonnet 5**) rather than editing
   top-level system.
3. A fork or summarizer call must copy the parent's system, tools and model VERBATIM or
   it misses the parent cache entirely.
4. Use `clear_at_least` so context edits don't shred the cache every turn.
5. Verify with `usage.cache_read_input_tokens`.

## Patterns that exceed one context window

| Pattern | Documented failure mode |
|---|---|
| Subagent fan-out, summary-only return (+90.2% over single-agent Opus 4; ~15x chat token burn; token usage explains 80% of performance variance) | 50+ subagents for trivial queries; sequential instead of parallel; duplicated work from vague delegation |
| Handoff/relay between fresh sessions | Agents one-shotting everything; declaring done prematurely; broken undocumented state; marking features complete without end-to-end tests |
| External memory / plan files (claude-progress.txt + JSON feature checklist + init.sh) | Agents editing the checklist beyond the allowed field — needs explicit guardrails |
| Git commit per phase as checkpoint/rollback | — |

## Concurrency under one account

- Agent teams use **~7x** the tokens of a standard session (each teammate has its own
  context window). Gated behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
- Isolation: `claude --worktree <name>` / `-w`; `WorktreeCreate` / `WorktreeRemove` hooks.
- Rate limits are org-level and per model class — parallel sessions on DIFFERENT models
  draw from separate buckets. This is exploitable.
- Subscriptions share one 5-hour + weekly allowance across all sessions.
  `autoContinueAtUsageLimit` (v2.1.234+) waits for reset and resumes.
- Unverified (blogs/forums, not Anthropic): "most run 2-5 agents in parallel"; "5+ hits
  rate limits"; Max 20x 5-hour cap exhausted in ~70 min (claude-code#41788).

## Leverage, ranked

1. Cache discipline the CLI can't do — frozen prefix, deterministic tool order,
   mid-conversation system injections, verbatim-prefix forks. Cache reads dodge ITPM.
2. Own the handoff instead of trusting auto-compact — PreCompact hook to archive,
   structured progress/plan files, forkSession + resumeSessionAt for branch-and-retry,
   git commit per phase.
3. Fan out to subagents only where breadth justifies ~15x tokens; budget with
   maxBudgetUsd, pace with taskBudget.
4. Sell continuity across sessions.

## Not checked

- Agent SDK source for undocumented compaction options (docs only).
- Empirical degradation vs context length on this workload.
- 2026 subscription rate-limit numbers (blog-sourced only).
