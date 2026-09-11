# Timer inventory — P0, 2026-09-11

Every recurring wakeup in the shipped app: `setInterval`, recursive `setTimeout`, `requestAnimationFrame`
loops, and the Rust `interval`/`sleep`/`sleep_until` loops. Taken from
`docs/plans/efficiency-plan-review-2026-09-11.md` (B3 and "Nonblocking improvements") and then **re-verified
line by line in this worktree** at `95577c3` plus the working-tree batcher patch; the corrections are called
out under the table. Periods are read from the source, not measured. Nothing here is a measurement of cost:
no run, build or profile was performed for this file.

"Idle" means: does it keep firing when the app is open, nothing is streaming and the user is doing nothing.

## Frontend

| # | Site | Period | Idle? | Disposition | Package |
|---|---|---|---|---|---|
| 1 | `src/feedStore.ts:630-635` `scheduleDrain` — `requestAnimationFrame` **and** a 250 ms `setTimeout`; re-armed unconditionally by `drain()` at `:577-579`; started once at `src/App.tsx:329` | ~60/s + 4/s | **yes** | Replace: arm only while the queue is non-empty; keep the 250 ms fallback only while something is pending (it exists because WKWebView pauses rAF when occluded and approvals must still land — comment at `:632-633`) | P2 |
| 2 | `src/App.tsx:394` archive refresh | 5 s | yes | Remove after `archive-changed` producer coverage. Fix order first: `void refresh()` at `:393` precedes `listen(...)` at `:398` | P2 |
| 3 | `src/App.tsx:978` run refresh, `RUN_POLL_MS` = 1000 (`src/App.tsx:107`) | 1 s | no — only while a run is live (`runLive` guard at `:977`) | Keep as a documented deadline until plan/phase commits publish an edge; `docs/plans/ipc-contract.md:679-683` already diagnoses it | P2 (last) |
| 4 | `src/App.tsx:530` unknown-project re-fetch, `UNKNOWN_PROJECT_REFETCH_MS` = 250 (`:78`) | one-shot | no | Keep — a self-cancelling coalescer, not a poll | — |
| 5 | `src/components/Sidebar.tsx:260` workbench load | 2.5 s | yes | Replace with the shared workbench snapshot + persisted-mutation invalidation | P2 |
| 6 | `src/components/ProjectWorkbench.tsx:332` workbench data load | 3 s | yes, while the workbench is mounted | Same shared snapshot; it already listens for `workbench-data-changed` at `:333` | P2 |
| 7 | `src/components/ProjectWorkbench.tsx:410` Git status refresh (the read at `:393-403`) | 5 s | yes, while a project is open | Bounded poll that arms only while visible and dirty/live, pending the P3 spike's numbers | P3 spike → P2 |
| 8 | `src/components/NewSession.tsx:57` workspace-options refresh | 5 s | yes, while the composer is mounted | Replace with discovery/mutation events; also refreshes on `focus` (`:56`) | P2 |
| 9 | `src/providerCatalog.ts:74` catalogue poll, `POLL_MS` = 15000 (`:28`); retry ladder `RETRY_DELAYS_MS` = [300, 900, 1500, 1500] (`:24`, armed at `:46`) | 15 s | **no** — `stopPolling()` at `:60` once settled; forever only with no CLI installed | Keep, deprioritised. `listen(REFRESHED_EVENT)` at `:75` registers after `read()` at `:70` — reorder | P2 (last) |
| 10 | `src/peerApi.ts:97` peer snapshot | 30 s | yes | Remove after `peer-state-changed` covers live activity; `fetch()` at `:94` precedes `listen` at `:95` — reorder | P2 |
| 11 | `src/desktopApi.ts:129` session changes, recursive | 3.5 s | yes | One shared per-session snapshot first: the hook is mounted three times per session — `ThreadView.tsx:231`, `SessionCard.tsx:23`, `SessionReview.tsx:161` — so two of the three wakeups go before any event work | P2 |
| 12 | `src/desktopApi.ts:174` cleanup jobs, recursive | 2 s | **yes** — armed for the app's lifetime at `App.tsx:1082` | Replace with a job-transition event. The backend is not polling: `src-tauri/src/cleanup.rs:136-190` drains a queue and returns, emitting nothing | P2 |
| 13 | `src/components/SessionContext.tsx:38` context read, recursive | 8 s busy / 30 s idle | per mounted session card | Replace with a context-changed edge or fold into the shared session snapshot | P2/P5 |
| 14 | `src/components/AgentsPanel.tsx:65` subagent activity, recursive | 2 s per open subagent | while the panel is open | Replace with the peer activity edge | P2/P5 |
| 15 | `src/components/TerminalView.tsx:157-160` `terminal_read` re-arm — 0 ms after a full 8192-byte read, else 50 ms; backend is the polled command `src-tauri/src/terminal.rs:299-312` | 50 ms | while a terminal is mounted | Replace with a Tauri Channel driven by the PTY reader; keep frames under the 8192-byte eval path or accept `ChannelDataIpcQueue` | P5 |
| 16 | `src/components/TerminalView.tsx:165-174` snapshot persist + CWD (`workbenchApi.terminalInfo` → `terminal.rs:370-390`, `lsof` with a 2 s timeout) | 3 s | while a terminal is mounted | Dirty-triggered coalesced persist; CWD stays a bounded check with an honest freshness claim | P5 |
| 17 | `src/components/WorkTrace.tsx:62` elapsed clock | 1 s | no — `row.running` guard at `:60` | Keep; share one visible clock across rows | P5 |
| 18 | `src/softwareUpdates.ts:64`, period `interval` = 15 min (`:20`) | 15 min | yes | Keep — a remote service with no push; also refreshes on `focus` | P5 |
| 19 | `src/Launch.tsx:79` readiness poll, recursive | 150 ms | no — stops at `status.ready` | Keep | — |
| 20 | `src/Launch.tsx:174` greeting hold | one-shot 200/1400 ms | no | Keep | — |
| 21 | `src/components/CosmicField.tsx:177` rAF draw loop | ~60/s | while the launch surface is mounted and reduced-motion is off | Spike: confirm it is unmounted once the workspace is up, then keep | P5 |
| 22 | `src/hooks/useConversationHistory.ts:39` history-update coalescer | 100 ms one-shot per burst | no | Keep — a debounce. P4a owns what happens *inside* the read (`:58-61` Worker on the critical path, `:77` full-array `JSON.stringify` compare) | P4a |
| 23 | `src/attention.ts:228` durable read-marker flush | one-shot `flushDelayMs` | no | Keep — batches ~45 durable writes/s down; see the comment at `:220-224` | — |
| 24 | `src/timestampLabels.ts:79` Worker-failure timeout | one-shot 1 s | no | Keep | — |
| 25 | `src/components/Burn.tsx:87` auto-start hold | one-shot 20 s | burn harness only (`VITE_BURN`) | Keep | — |
| 26 | `src/paint.ts:389` interaction-span timeout, `INTERACTION_TIMEOUT_MS` | one-shot per span | no | Keep | — |
| 27 | `src/mock.ts:467` mock feed tick | 16 ms | mock/demo path, never the desktop app | Keep | — |

## Backend

| # | Site | Period | Idle? | Disposition | Package |
|---|---|---|---|---|---|
| 28 | `src-tauri/src/keep_awake.rs:117-120` — `select!` on the `peer_sessions` watch (subscribed at `:79`) or a 2 s sleep; when enabled, one `NativeControl::Activity` RPC per live session per pass (`:93-105`) | 2 s, **plus one wake per feed batch** | yes (2 s floor); at batch rate while streaming | Subscribe to an activity-**transition** edge, not the batch notify. The wake comes from `src-tauri/src/sink.rs:58` `peer_sessions::notify()`, called on every `FeedSink::send` | P5 |
| 29 | `src-tauri/src/composer.rs:129` — same shape: `select!` on the same watch (subscribed at `:108`) or a 2 s sleep, then a scan of every queued conversation at `:110-127` | 2 s, **plus one wake per feed batch** | **yes** — spawned unconditionally at `src-tauri/src/lib.rs:345` | Same edge treatment as #28. **Not in the review's inventory**: `sink.rs:58` has two subscribers, not one | P5 (with #28) |
| 30 | `src-tauri/src/session_archive.rs:306` archive retention sweep | 60 s | **yes** — always on | Keep as a documented deadline. Note for P2: its `archive-changed` emit at `:299` is reached only when something was deleted (early return at `:288-290`), and the other emitter is `src-tauri/src/peers.rs:1394` | P2 (document) |
| 31 | `src-tauri/src/approval_policy.rs:158` cancellation tick, bounded by `REVIEW_DEADLINE` at `:156` | 250 ms | no — only during an approval review | Keep — a real deadline | — |
| 32 | `src-tauri/src/peer_sessions.rs:273` readiness fallback, `sleep_until(min(deadline, now + 1 s))` | ≤ 1 s | no — bounded by `deadline` at `:267` | Keep | — |
| 33 | `src-tauri/src/peers.rs:1594` peer-message delivery retry, bounded by the deadline at `:1591` | 1 s | no | Keep | — |
| 34 | `crates/core/src/codex/adapter.rs:205` `interval(100 ms)` per live Codex session | 100 ms | no — per live session only | Spike before touching: it is a provider event loop, and Codex is deferred for v1 | P5 (document) |
| 35 | `crates/supervisor/src/batcher.rs:383` `sleep_until(next)` — the working-tree patch's deadline-anchored flusher, replacing the old `interval` tick | one flush per pending burst | **no** — nothing runs while the feed is idle | This is P1's subject; audit and test, do not re-derive. Line number is a snapshot: a concurrent P1 worker is editing this file | P1 |
| 36 | `crates/supervisor/src/replay.rs:308` load-generator ticker | 1/`rows_per_sec` | burn/replay only | Keep — the benchmark's own producer | — |

## Corrections to the review's line numbers

Everything in the review's inventory exists; four citations shifted by a line or name a neighbouring
statement.

- `src/feedStore.ts:629-635` → the function is `:630-635` (`:629` is blank).
- `src/feedStore.ts:577` "re-arms unconditionally" → `:577-579`: `:577-578` cancel the rAF and the timeout,
  `:579` calls `scheduleDrain()`.
- `src/App.tsx:392-398` listen-after-fetch → `:393` is `void refresh()`, `:394` the 5 s interval, `:398` the
  `archive-changed` listener. `:392` is the end of the previous function body.
- `src/providerCatalog.ts:73-75` listen-after-fetch → the fetch is `read()` at `:70`, the poll at `:74`, the
  listener at `:75`; `:71-73` are a comment.
- `src/peerApi.ts:93-95` → exact: `fetch()` at `:94`, `listen` at `:95`.
- Verified unchanged and exact: `src-tauri/src/sink.rs:58`, `keep_awake.rs:93-105` and `:117-120`,
  `session_archive.rs:299` and `:306`, `SessionContext.tsx:38`, `AgentsPanel.tsx:65`,
  `codex/adapter.rs:205`, `Launch.tsx:79`, `CosmicField.tsx:177`, `approval_policy.rs:158`,
  `peer_sessions.rs:273` and `:118-132`, `peers.rs:220` and `:1394`, `ThreadView.tsx:231`,
  `SessionCard.tsx:23`, `SessionReview.tsx:161`, `desktopApi.ts:174`, `App.tsx:1082`, `App.tsx:978`,
  `TerminalView.tsx:117-121` and `:157-160`, `terminal.rs:299-312` and `:374-390` (the `lsof` call is at
  `:374-381`).

## Additions the review did not list

- **#29, `src-tauri/src/composer.rs:129`.** The conversation-queue drain loop subscribes to the same
  `peer_sessions` watch as keep-awake (`peer_sessions.rs:17-22`), so `sink.rs:58` wakes **two** always-on
  backend tasks per feed batch, each taking a lock and scanning state. The review's B3 attributes that wake
  to keep-awake alone.
- **#8 `NewSession.tsx:57`, #16 `TerminalView.tsx:165-174`, #18 `softwareUpdates.ts:64`, #4 `App.tsx:530`,
  #22 `useConversationHistory.ts:39`, #26 `paint.ts:389`, #36 `replay.rs:308`** were not in the review's
  list; the last four are one-shot or bounded and are listed only so the inventory is complete.

## Not checked

- No runtime cost was measured for any timer here. Whether the drain loop's ~64 idle wakeups/s or the two
  2 s backend loops are material is a P0 trace question, and that trace has not been run.
- Whether `CosmicField` is unmounted after launch (#21) was not confirmed in source.
- Test-only and fixture timers under `src/**/*.test.*`, `crates/**/tests/` and
  `src-tauri/src/*_tests.rs` are excluded.
