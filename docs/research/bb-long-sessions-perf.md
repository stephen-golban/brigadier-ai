# get-bb/bb — long sessions, usage, reliability, performance

Detailed subagent report, 2026-09-09, feeding `docs/research/bb.md`. Claims are marked as in that file: read in source = measured; everything else asserted. Nobody ran bb.

---
# bb: long sessions, context limits, performance (2026-09-09)

All paths relative to `get-bb/bb@main`. "read in source" = I read the file; "inferred" = deduced.

## 1. Context limits

**bb never triggers compaction on its own. It observes the provider's and exposes a manual button.** (read in source)

- Compaction is a *translated provider signal*, not a bb policy. `plugins/provider-claude-code/src/delta-translation.ts:624`:
  `if (statusMessage.success && statusMessage.data.status === "compacting")` → opens a `compaction` timeline item; the matching `compact_boundary` system message emits `{ kind: "context.compacted" }` (:660-668). Same file handles `api_retry` (:605) and `model_fallback` (:672).
- Manual only: `CHANGELOG.md:507` — "Type `/compact` in the composer to compact a thread that has grown too long. Codex, Claude Code, Pi, and OpenCode support it. Cursor and other custom ACP agents do not. Agents can do the same with `bb thread compact`." The recording `packages/provider-bridge-protocol/recordings/claude-code/compaction/runtime→bridge.ndjson:4` is literally a `turn/start` whose input text is `"/compact"`. No threshold, no scheduler, no auto-trigger found. (read in source; absence = inferred from greps for `autoCompact`, which hits only `provider-pi` fixtures)
- **Context meter is real and per-thread.** `apps/app/src/components/thread/timeline/ThreadContextWindowIndicator.tsx` draws a donut + popover: `{usedTokens} / {modelContextWindow} tokens`, `{leftPercent}% left`; tone thresholds `usedPercent >= 90 → destructive`, `>= 75 → warning` (:42-47). Purely cosmetic — no action fires.
- Token math: `plugins/provider-claude-code/src/sdk-extraction.ts:345`
  `toClaudeCurrentContextTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, taken from the **assistant** message's usage (`extractClaudeRequestContextTokens`, :312). Window from `result.modelUsage[model].contextWindow`, floored by a hint table: `DEFAULT_CLAUDE_CONTEXT_WINDOW = 200_000`, `LARGE_CLAUDE_CONTEXT_WINDOW = 1_000_000` for models ending `[1m]` or in `{best, claude-fable-5, claude-mythos-5, fable, …}` (:76-84, :376-388). The emitted event is always `estimated: true` (:308).
- Handoff = **fork**, not summarise. `packages/templates/src/templates/bb-guide-threads.md:87-113`: `bb thread fork <source-thread-id> [--source-seq-end <seq>] [--agent-context-seed <text>]` — "Forks clone the source provider session on the same machine and inherit the source conversation in their timeline." Also `bb thread clear <id>`: "reset its active timeline and model context in place while keeping the same BB thread, workspace, durable event history" (`apps/server/src/services/threads/thread-context-clear.ts`; only allowed when `status === "idle" || "error"`, :31). Neither summarises; there is no LLM-written handoff.

## 2. Memory plugin (`plugins/memory/`) — read in source

- Own SQLite store (plugin-private, append-only migrations), scopes **global** and **current project**; project is the default, global must be explicit.
- Injection: "an automatically injected, 3,900-character summary catalog through `bb.agents.contributeInstructions`" (`README.md`), refreshed "at every thread start / turn submission". Catalog holds **summaries only**; full records are pulled on demand.
- Agent-written, via CLI only — no native tools: `bb memory add|search|get|update|forget|catalog|history` (`skills/memory/SKILL.md`). FTS5 keyword search; embeddings and background reflection "deliberately deferred". Prompt-injection/secret-pattern rejection. Fields: kind, tags, importance, pinning, provenance, version history.
- Recommends disabling provider-native memory to avoid two stores.

## 3. Session persistence and resume — read in source

- The provider session id is the Claude Code session UUID. `plugins/provider-claude-code/src/bridge/sdk-session.ts:264` passes `resume: resumeSessionId` into the Agent SDK `Options`, plus `persistSession: true` and `settingSources: ["user","project","local"]` (:243-245). So **the transcript of record for the model is Claude Code's own session file**; bb replays nothing into the model.
- bb's SQLite holds the *display* timeline: an append-only `events` table per thread (`docs/system-overview.md`, `packages/db/src/schema.ts`). SQLite pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=-262144` (256 MB), `mmap_size=1 GiB`, `busy_timeout=5000` (`packages/db/src/connection.ts:44-46,161-167`).
- **Idle processes are killed and resumed.** `apps/host-daemon/src/app.ts:66-67`: `IDLE_PROVIDER_SESSION_REAP_AFTER_MS = 30 * 60 * 1000`, swept every 5 min; only threads whose runtime config says `sessionRestorable` are reaped (`packages/agent-runtime/src/runtime.ts:843`). Next prompt calls `runtime.resumeThread` → adapter command `thread/resume` (:1858) → SDK `resume`.
- Bridge restarts also auto-resume every hosted thread on that process, but are **deferred while any thread on the process is mid-turn** (`runtime.ts:960-1020`).
- **If `claude` dies mid-turn**: `apps/host-daemon/src/runtime-manager.ts:1106-1146` emits `turn/completed status:"failed"` plus `system/error code:"provider_process_exited"` for each thread with an active turn; threads with only a pending turn start get just the `system/error`. Nothing auto-retries a crash — retry is user/plugin-driven (§6).

## 4. Streaming and rendering

- Path (read in source + inferred): host daemon → server as **event batches** (`apps/server/src/internal/events.ts`, `hostDaemonEventBatchRequestSchema`) → rows appended to SQLite → `hub.notifyThread(threadId, ["events-appended"], …)` over WebSocket (:315). The WS carries **change notifications, not content**: `apps/app/src/hooks/useWebSocket.ts` just feeds `createRealtimeCacheEffects`, which invalidates React Query; the app then refetches timeline pages over HTTP. Token deltas are assembled server-side (`packages/provider-bridge-protocol/src/assembler/delta-assembler.ts`) — no per-token socket frame. (the "no per-token frame" part is inferred)
- Virtualised list: `@tanstack/react-virtual ^3.14.2` (`apps/app/package.json:71`), used by `apps/app/src/components/thread/timeline/TimelineWindowedItems.tsx` — `TIMELINE_WINDOW_OVERSCAN_ITEMS = 8`, `TIMELINE_WINDOW_MAX_MEASUREMENTS = 2_000`, windowing only above `TIMELINE_WINDOWING_MIN_ITEM_COUNT = 20`.
- Server-side budget: `packages/domain/src/feature-flags.ts:11` `timelineWindowEventBudget: 1_500` events per build.
- Event pruning (`apps/server/src/services/system/event-pruning.ts:59-63`): keep-recent `active 1_000 / idle 300 / archived 120`; active prune needs ≥250 new seq and ≥30 s gap; prunable types are `thread/contextWindowUsage/updated`, `thread/tokenUsage/updated`, `turn/diff/updated`, `item/backgroundTask/progress`. Large tool output is truncated at read time in SQL (`packages/db/src/data/event-output-truncation.ts`) and swept at `COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS = 32 * 1024`, retaining 2 KB head + 2 KB tail (`packages/db/src/retained-event-output.ts:4-6`).
- Perf regression test: `apps/server/test/provider-corpus/timeline-perf.test.ts:40-41` — a synthetic 10,000-event thread must project every page under `SYNTHETIC_CEILING_MS = 1_500`; per-stage baselines for `event-query / event-json-decode / thread-view-projection / …`.
- **Known perf pain, quoted from issues** (read in source):
  - #1131 (open) "Synchronous SQLite on the event loop: one cold query froze all clients for 11s on a 1.7GB bb.db" — "stalled the server event loop for **11.2 seconds**", static `/` TTFB 2 ms → 7.3 s; `events` = 1,447 MB of 1.7 GB, `item/completed` 913 MB of which 815 MB is `commandExecution.aggregatedOutput`; the 32 KB truncation threshold "almost nothing qualifies, so the sweep reclaims ~0".
  - #1749 (open) "timelineWindowEventBudget assumes 0.06ms/event; measured 0.479ms/event on a 4-core host" — 541 samples, p50 0.479, p90 0.964, max 5.55 ms/event; "532 logged slow builds totalling 155 seconds of blocked event loop".
  - #2534 (closed) "Unbounded usage-event pruning blocked the server event loop for 371 seconds" (bb 0.40.0; 319 MB db, 85,076 events).
  - #1660 (open) "bb host process grew to 77GB RSS and froze the machine" — macOS Apple Silicon, one day of heavy multi-thread use; 88 orphaned dev processes in deleted managed worktrees. In-flight turns died; recovered with `bb thread fork --workspace reuse`.
  - #1777 (closed) "bb gets very slow with long threads"; #1075 (closed) terminal slow under sustained output; #1303 (open) "Opening a thread fires ~19 API requests".
  - No documented Electron memory footprint found.

## 5. Usage / rate limits

- **Two independent sources.** (read in source)
  1. Polled HTTP: `plugins/provider-claude-code/src/bridge/provider-maintenance.ts:30` `CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"`, called with the user's own OAuth access token read from the macOS keychain or `~/.claude/.credentials.json` (:275-289), header `anthropic-beta: oauth-2025-04-20`, 15 s timeout. Response parsed as `five_hour` / `seven_day` `{utilization, resets_at}` plus a `limits[]` array of per-model scoped windows → labels "Current session" / "Weekly limit" (:451-476). Plan label derived from `rateLimitTier` `max_(\d+)x`.
  2. Stream event: `provider/rateLimits/updated` (`apps/server/src/internal/events.ts:236`), built by `normalizeClaudeRateLimits` from the CLI's `rate_limit_event.rate_limit_info` — `{status, overageStatus, rateLimitType, resetsAt}` → `{status: allowed|warning|blocked|rejected, kind: credits|subscription-window|unknown, windows[], overageStatus}` (`delta-translation.ts:302-338`).
- Surfacing: `plugins/provider-usage` card, `bb settings usage --json`, `sdk.system.usageLimits()`; schema `plugins/provider-usage/usage-schema.ts` — `windows: [{label, usedPercent, resetsAt, cost: {usedUsdCents, limitUsdCents} | null}]`. `providerUsageTone` colours **≥95 critical, ≥80 warning** (:70-81). No user-settable reserve; those are hard-coded display thresholds.
- **Account pool** (`plugins/account-pool/`): a local hub serving an Anthropic Messages and an OpenAI Responses endpoint; bb hands `claude` a base URL pointing at the hub. "An account is skipped for a request when it is at or above the switch threshold or in error. The threshold defaults to 98 percent of a window" (`PLUGIN_OVERVIEW.md`). Configurable: `bb pool config set switchThreshold <value>` — "must be greater than 0 and at most 1" (`skills/account-pool/references/accounts-and-routing.md`). Accounts run sequentially by priority; new conversations advance to the next eligible account and **stay on the fallback even when an earlier account recovers**; existing conversations stay pinned; session pins expire after 30 idle minutes, 4,096 MRU pins retained; OAuth quota refreshes on add/enable and every 5 min while idle. Per-model-family buckets (`familyWeekly`) detour only that family. So the reserve semantics are the *opposite* of brigadier's: pool to keep bb running, not to protect the human's own quota.

## 6. Reliability

- `plugins/provider-retry/` (read in source), `src/retry-policy.ts`: `MAX_RETRY_ATTEMPTS = 5` ("original dispatch plus at most four retries"), `RESET_BUFFER_MS = 15_000`, `RESET_JITTER_MS = 30_000` ("Every thread blocked on one account hears about the same reset… nothing tracks which accounts are exhausted, by design"), `OVERLOAD_RETRY_BASE_MS = 5_000` with doubling, `DEFAULT_MAXIMUM_WAIT_MS = 6 h` (setting: 6 h / 24 h / no limit). Decline reasons: `not-retryable | no-rate-limit-state | not-resettable | beyond-maximum-wait | attempts-exhausted`. **Credit/spend limits are never retried.** `blockedWindowResetAtMs` takes the **latest** blocked window (5-hour vs weekly). Attempt number rides the turn row, so the cap survives a server restart.
- Manual: `bb thread retry <id>` re-sends the failed turn's original message verbatim, attempt 2 = first retry; 409 `no_failed_turn` / `retry_already_queued` (`…/builtin-skills/bb-cli/references/failure-recovery.md`). Server side `apps/server/src/services/threads/turn-retry.ts` (fetched, not read line-by-line).
- **Watchdog on stuck threads** (read in source): `packages/agent-runtime/src/runtime.ts:265-288` — threshold `120_000 ms` default, polled every `15_000 ms`, emits `system/provider-turn-watchdog` with code `provider_turn_start_timeout`: "The provider accepted a turn but did not start it within Ns. The request may be stalled; stopping the thread interrupts it." It **only warns**; it does not kill or retry.
- "Failed" = `turn/completed status:"failed"` + thread `status: "error"`; produced by provider result errors, hard rate-limit rejections (`isHardClaudeRateLimitRejection`, `delta-translation.ts:340`), and unexpected process exit (§3).
- In-flight turns do **not** survive a host crash: #1660 records them dying, recovered manually via fork.

## Not verified

- Never ran bb; every number above is from source, tests, or issue reports — none measured by me.
- `apps/server/src/services/threads/turn-retry.ts` (256 lines) and `plugins/memory/server.ts` (1,182 lines) fetched but only skimmed/greped.
- `plugins/provider-claude-code/src/bridge/bridge.ts` (86 KB) not read; the exact per-turn lifecycle (one long-lived `query()` per thread vs one per turn) is inferred from `sdk-session.ts` + the resume recording, not confirmed.
- Did not confirm whether the WebSocket ever carries message content (I read only `useWebSocket.ts`, not `lib/ws.ts` or the server hub).
- No Electron RSS figure found anywhere in docs; did not search release notes exhaustively.
- Did not verify whether `provider/rateLimits/updated` feeds the same UI card as the polled `/api/oauth/usage` snapshot, or a separate banner.
- Did not check whether `bb thread fork` copies the Claude Code session file on disk or asks the CLI to fork it.
- Issue quotes are user-reported measurements on self-hosted instances, not maintainer benchmarks.
