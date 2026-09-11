# Keeping Brigadier responsive under parallel agent load

Date: 2026-09-11. This is a source audit and proposed design, **not a CPU/thermal profile or a measured performance improvement**. No live provider calls or load benchmarks were run.

Follow-up web research: [agent complaints, verified fixes, and throughput-preserving priorities](agent-efficiency-findings-2026-09-11.md). Claude's native Grep already uses ripgrep; optimize search scope/repetition and harness work before assuming an engine replacement will help.

**Owner direction, updated 2026-09-11:** preserve CLI execution speed and concurrency. Optimize Brigadier's own overhead through event-driven updates, shared caches, bounded rendering, and lifecycle cleanup. The earlier governor, expensive-tool permits, and Quiet/Balanced profiles are withdrawn proposals; do not introduce CLI throttling or subagent limits for this work. Existing unrelated policy limits are not changed by this note. This can reduce harness overhead but cannot guarantee a cool machine while unrestricted local tools use its CPU.

## Documented controls and limits

Anthropic acknowledges high resource consumption on large codebases and recommends reducing context, restarting between major tasks, ignoring large build directories, and using `--safe-mode` to isolate plugins, MCP servers, and hooks. These are diagnostic leads, not proof of what heats this Mac. [Claude Code troubleshooting](https://code.claude.com/docs/en/troubleshooting#high-cpu-or-memory-usage)

Claude Code v2.1.217+ documents `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, a positive integer with default 20 per session. It rejects new `Agent` spawns while full; it does not queue them. Ultracode is exempt; `/subtask` and resumes can exceed the limit; workflow agents and teammates use separate limits. `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` disables nested delegation. These are supplemental controls, not an enforceable machine budget. Brigadier must check the installed version and supported capabilities before relying on them. [Subagent limits and nesting](https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit)

Apple exposes thermal state and change notifications through `ProcessInfo`. Its guidance recommends reducing CPU/GPU/I/O at serious pressure and minimizing work at critical pressure. Older or unsupported systems may report nominal even when thermal awareness is unavailable, so thermal state cannot be the sole signal. [Apple thermal guidance](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/RespondToThermalStateChanges.html)

Apple recommends event-driven work, caching, and object reuse; frequent timers wake otherwise idle systems, and unseen UI updates waste energy. QoS expresses scheduling importance rather than a CPU consumption ceiling. [CPU scheduling](https://developer.apple.com/documentation/xcode/scheduling-cpu-work-efficiently), [timers](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/Timers.html), [best practices](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/BestPractices.html), [QoS](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/PrioritizeWorkAtTheTaskLevel.html)

## Current source audit

These are structural observations supplied by the parallel local audit; they are not measured hotspots.

| Finding | Source | Implication |
| --- | --- | --- |
| Default concurrency is 4; peer admissions count the current root; loop semaphore is per run. | `crates/supervisor/src/orchestration.rs:38`, `src-tauri/src/peer_orchestration.rs:445`, `crates/supervisor/src/loop_/dispatch.rs:87` | Several roots can multiply local activity. |
| No thermal, memory-pressure, or `setpriority` integration found in the Rust search. | Local source search | Admission is not currently pressure-aware. |
| Batch flusher defaults to 16 ms and ticks even when empty. | `crates/supervisor/src/batcher.rs:38,260` | Candidate for an event-triggered, one-shot flush. |
| Sidebar polls workbench every 2.5 s; workbench has 3 s and 5 s refresh paths. | `src/components/Sidebar.tsx:258`, `src/components/ProjectWorkbench.tsx:328,406` | Coalesce refreshes and use events/visibility gating. |
| Provider uses piped stdio and its own process group; process owner has normal shutdown and startup orphan sweep. | `crates/core/src/claude/process.rs:237,265`, `crates/proc` | Existing lifecycle foundation; immediate cleanup after app force-quit still needs verification/design. |
| Keep-awake defaults off; when enabled it uses `caffeinate -diu` under a lease and polls every 2 s. | `src-tauri/src/workbench_data.rs:96`, `src-tauri/src/keep_awake.rs:49,120` | Revisit assertion scope and event-driven lease updates. |
| Idle reported workers already retire. | `src-tauri/src/peer_sessions.rs:298–367` | Extend existing lifecycle controls rather than introducing a second retirement mechanism. |

## Revised implementation: event-driven harness, full-speed CLIs

**[documented]** Tauri v2 provides small broadcast events and channels optimized for ordered streaming. Use events for invalidation and channels for agent output. A local WebSocket server is unnecessary for this architecture. [Tauri Rust-to-frontend communication](https://v2.tauri.app/develop/calling-frontend/)

**[documented]** Native macOS file events can coalesce or drop changes; subtree/full rescans and root-change recovery are required in those cases. Register watches before the initial scan and reconcile events received during it. [Apple FSEvents guidance](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html)

**[source]** The feed already uses `Channel<FeedBatch>` (`src-tauri/src/sink.rs`, `commands.rs::subscribe_feed`). The problem is partly scheduling above the transport, not a missing push transport. Sidebar and workbench already listen for the browser-local `workbench-data-changed` event, but backend and external changes need complete coverage before deleting their timers. Archive refresh already has an `archive-changed` listener plus a five-second poll (`src/App.tsx`). Run polling explicitly compensates for a missing phase-transition signal (`src/App.tsx::RUN_POLL_MS`).

**[asserted: proposed design, not implemented]**

1. Publish workspace/settings invalidations after successful persistence. One shared frontend store fetches the changed snapshot once and notifies subscribers; components do not each fetch it. Cover every mutation path, not only UI handlers.
2. Detect external file and Git changes with scoped native filesystem watches. Include linked-worktree Git metadata and the configured notes directory. Coalesce bursts, exclude irrelevant generated trees, and recompute only affected cached views. Watcher notifications invalidate state; they are not the durable source of truth. Resynchronize on overflow, watcher restart, frontend reconnect, and focus return.
3. Replace the always-running 16 ms feed timer with a wakeup when data arrives and a single pending flush deadline. Batch display updates while streaming, sleep when empty, preserve lifecycle/control delivery, and verify there are no lost wakeups or stale subscriptions. This limits UI work, not CLI execution.
4. Emit run/phase transition notifications at the state owner. Update the IPC contract to replace the documented run poll. Use provider activity events for keep-awake status, retaining only a required lease-renewal deadline while enabled and working.
5. Subscribe before loading a versioned initial snapshot; reconcile revisions to avoid missed changes during startup. Remove listeners on teardown and restore subscriptions after webview reload. Keep explicit refresh/recovery paths; do not blindly remove polls before their replacement covers all producers.
6. Bound logs, display queues and cached transcripts; render only visible content. Continue draining and persisting CLI output independently of rendering. If measured sustained input exceeds persistence capacity, document that bottleneck rather than claiming buffering can absorb unlimited output without backpressure.

Deadline timers, stream batching, and user-visible elapsed-time counters can remain when they serve active work. The target is no repeated state checks when nothing changed, not a blanket prohibition on timers. No runtime changes have been made.

## Proposed release gates

Use a declared baseline Mac on battery and AC, comparing equivalent direct CLI and Brigadier workloads: idle, streaming, and 3 sessions × 5 subagents with expensive tools. Include descendants, MCP/browser workers, and WebKit. Separate application overhead from task execution.

- Idle CPU below 1% of one core averaged over 10 minutes; no empty 16 ms flush wakeups.
- Streaming: no lost durable events or control signals, bounded display queues with progress coalescing, p95 input response below 100 ms at a stated event rate.
- Two-hour soak: publish peak memory; growth below 10% over the final hour after warmup.
- Verify event delivery across mutations, external edits, reloads, and watcher recovery; race-test startup snapshots and stream wakeups; verify owned-descendant cleanup.
- Hold CLI configuration and concurrency constant. Report elapsed work time, CPU time, peak RSS, UI latency, and time in serious/critical thermal states. Require no statistically meaningful task-throughput regression in repeated equivalent runs.

These are proposed targets, not achieved measurements. Optimize and measure harness overhead separately from unrestricted CLI/tool work; do not promise elimination of heat from that work.
