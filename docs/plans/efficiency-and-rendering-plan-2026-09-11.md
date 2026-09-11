# Brigadier efficiency and rendering implementation plan

**Status: proposal for adversarial review. No implementation is authorized by this document alone.** The owner requested this plan, will obtain an adversarial review from Claude Fable 5.1, and will return before implementation resumes. Writing this plan does not lift that boundary.

Date: 2026-09-11. Baseline: `95577c3ee95aeafe59ca1a67e4410886fd3875b3` on `main` and `origin/main`, plus the explicitly identified untested working-tree patch below. Revalidate the baseline on resumption; file locations in this plan are repository-relative and line numbers in older research may have shifted.

## 1. Outcome and constraints

Make Brigadier consume less local CPU and memory, remain responsive during parallel work, and avoid making agent tasks slower. Include the unresolved first-transcript rendering hitch handed over by **“Finish performance gate and update Brigadier”**, task `01a08ff8-f9d7-71a3-b51c-e616d132fd88`. Finish with an honestly validated production build and, after implementation resumes and the release gate passes, update the installed application.

The owner normally runs two or three sessions, each with one to five subagents. This is the representative workload, not a request to limit it.

Non-negotiable constraints:

- Preserve model, reasoning effort, CLI/subagent concurrency, permissions, relevant context, and access to needed tools/files. Do not introduce resource governors, CPU quotas, lower priorities, concurrency caps, forced compaction, reduced reasoning, or blanket MCP/hook disabling.
- Preserve every required verification check. Caching may avoid recomputation only when its validity is established; it must not turn an unverified result into a pass.
- Preserve immediate approval/control handling, truthful status, durable history, worktree isolation, editing, terminal behavior, and user-directed scrolling. Approval cards resolve only after the authoritative resolution event.
- Preserve the current UI/design and the prior task's accepted fixes. No framework migration, visual redesign, broad transcript rewrite, new semantic codebase index, or Node sidecar.
- Optimize work owned by Brigadier. Do not claim we can transparently repair closed-source provider internals or intercept every native tool call. Do not silently rewrite arbitrary shell commands.
- Measure useful work: CPU-seconds and elapsed time per successfully completed task, not CPU percentage alone. Lower CPU from slower execution is not success.
- Do not promise that unrestricted local builds, browsers, or local models generate no heat. Attribute harness overhead separately from useful tool work.

## 2. Starting state and handoff

### Already merged; preserve rather than redo

Commit `95577c3` incorporates narrower transcript subscriptions; stable external-store adapters, message converters, callbacks and row props; shared/coalesced source lookups; unchanged polling payload identity; a shared tooltip provider; timestamp-label preparation in a lazy Worker alongside history loading; and a burn-only visibility lease preserving initial feed events before project discovery.

These changes are not proof that the remaining rendering problem is fixed. The handoff reports functional checks/builds, with different checks run against different intermediate revisions. Do not combine those into a new claim that every gate passed against the current source.

### Remaining rendering issue

- A valid visible shared-clock capture reported five missed 60-Hz animation-callback opportunities in roughly one minute, worst callback interval **45 ms**, mostly on first transcript appearance.
- A different, earlier complete-delivery capture in `docs/performance/2026-09-11/performance-fix-status.md` reports five missed opportunities and **55 ms** worst interval. These are separate captures. Bind every number to its raw file/revision; never merge them into one result.
- Later Worker captures were hidden and therefore invalid for rendering acceptance. Worker-label instrumentation showed execution of the new path, not a zero-drop rendering pass.
- rAF spacing is a scheduling indicator, not compositor presentation evidence. Hidden/occluded/inactive-document behavior invalidates the capture; the recordings do not establish why the window became hidden.
- `src/App.tsx` still subscribes to the entire `store.getState()` snapshot and rebuilds filtered sessions, order and sidebar props. Background status changes can therefore cause shell/list work despite memoized rows.
- The existing burn uses ten sessions at 200 events/second each, repeating a nine-event handshake/turn sequence: approximately 22 cycles and 44 busy-state flips per second per session. Repeated session-start events also change ordering timestamps. It has no ordinary sustained text-delta stream. Retain this adversarial test and add a representative stream; do not weaken the existing gate.
- The synthetic assistant-ui runtime provides viewport behavior while actual rows render directly. Its removal is an optional experiment only if a short trace attributes meaningful cost to it. An older approximately 3-ms subtree observation does not explain an entire 45-ms interval.

### Unfinished patch and artifacts

- `crates/supervisor/src/batcher.rs` contains an **unstaged, untested** event-driven flusher patch applied before STOP. It adds a Tokio watch revision and replaces the periodic timer with a notification-triggered sleep/flush. Audit it as a candidate, not an accepted implementation.
- The other task restored that patch after merging with stable patch ID `df4f0086f73ba0a5df87537adba59ca47169a80d`. Backup: `/tmp/brigadier-release-20260911/other-task-batcher-before-merge.patch`. Revalidate before relying on either file.
- Four research notes remain untracked: `agent-efficiency-findings-2026-09-11.md`, `agent-resource-complaints-other-2026-09-11.md`, `agent-throughput-efficiency-2026-09-11.md`, and `local-resource-control-2026-09-11.md`, all under `docs/research/`.
- Prior candidate: `/tmp/brigadier-release-20260911/Brigadier-timestamp-fix.app`. Installed application was not replaced. Temporary artifacts are evidence, not the future release source of truth.
- Other task removed its performance worktrees and branches. `ui/codex-thread` and its worktree belong to separate work and must remain untouched.
- Artifact cleanup was audited, not executed: `/tmp/brigadier-cleanup-audit.md`, `/tmp/brigadier-release-20260911/apply-audited-cleanup.py`, and `cleanup-delete-candidates.json`. Re-audit any proposed deletion against current paths and protected favorite/design/backup hashes; never run the old script blindly.

## 3. Evidence and implementation boundaries

The research supports removing idle loops, repeated scans, cumulative rendering/copying, stale retry loops, and leaked processes. Claude's `Grep` already uses ripgrep. Native structured CLI transport already exists in Brigadier. MCP schema deferral does not necessarily defer process startup. Provider prompt caching preserves matching context but does not necessarily reduce local serialization/upload work.

Implementation references:

- [Agent findings and priorities](../research/agent-efficiency-findings-2026-09-11.md)
- [Other-agent complaints and merged fixes](../research/agent-resource-complaints-other-2026-09-11.md)
- [Throughput mechanisms and cache limits](../research/agent-throughput-efficiency-2026-09-11.md)
- [Event-driven direction](../research/local-resource-control-2026-09-11.md)
- [Rendering attribution and subscription issue](../research/rendering-fix-direction-2026-09-11.md)
- [Scroll replacement obligations](../research/transcript-scroll-alternatives-2026-09-11.md)
- [Rendering history, including rejected experiments](../research/transcript-runtime-performance.md)
- [Handoff verification/status](../performance/2026-09-11/performance-fix-status.md)
- [Binding IPC contract](ipc-contract.md), `CLAUDE.md`, and `docs/vision.md`.

Before coding a new external API, verify its installed/current documentation and record the exact contract. Proposed native watch backend: `notify::RecommendedWatcher`; dependency/version/backend selection still needs verification before addition. Tokio watch/Notify semantics, Tauri subscriptions, Git worktree discovery, and assistant-ui interfaces require the same check. Existing documentation in deleted temporary worktrees must be resolved against installed sources in the active checkout.

The later cache/runtime experiments have explicit decision gates. A defensible finding that a provider offers no safe integration closes that experiment with evidence; it does not justify silently replacing native behavior or claiming an unimplemented benefit.

## 4. Target architecture

```text
CLI structured output ──> provider adapter ──> durable processing
                                      └──> display accumulator ──> Tauri channel
                                                                   │
                                                   keyed frontend snapshots
                                                shell / list / row / transcript

Successful app mutations ──> domain revisions ──> small invalidation events
Native filesystem events ──> scoped dirty sets ──> shared refresh service
                                                     │
                                 authoritative snapshots + matching revisions

PTY reader / exit ──> bounded byte stream + cursor ──> terminal subscriber
```

Transport is not storage. Provider sequence numbers/durable records establish history; event revisions establish freshness. Broadcast invalidations may coalesce, but durable transitions and terminal output must not be mistaken for disposable invalidations.

### Shared invariants

1. Subscribe successfully before fetching the initial snapshot. Await native listener readiness; merely calling an async `listen()` first is insufficient.
2. Snapshots carry a domain key, process epoch and revision captured consistently with the data. A backend restart changes epoch. An older response cannot overwrite a newer event/snapshot.
3. One in-flight read per key. Invalidation during a read records a dirty generation and causes one follow-up; it is never ignored because `fetching` is true. Continuous invalidation must not postpone the first publish forever.
4. Backend mutation events are emitted after successful persistence/state publication. Rollback/error does not publish a false success. Keep read→refresh→write→event feedback bounded.
5. Unchanged complete snapshots retain identity. Comparisons include every semantically relevant field; no comparator may hide new approvals, errors, callbacks, ordering changes or task settings.
6. Domain subscriptions are disposed when unused; late responses are rejected after session changes/unmount. React StrictMode and webview reload must not leak listeners or background tasks.
7. Unknown/stale/error is explicit. Watch failure, overflow, reattachment and reconnect trigger resynchronization. Do not present stale cache data as current.
8. Coalescing limits app presentation/duplicate reads, not CLI execution. Required controls bypass discretionary scheduling. No unbounded queue is introduced to create an artificial throughput win.

## 5. Work packages and order

### P0 — Freeze baseline, establish attribution, and pin contracts

**Files:** performance scripts, `docs/performance/`, research notes, IPC contract; inspect the restored batcher patch without accepting it.

After implementation resumption, preserve the dirty patch and research notes in a task-owned checkout, without reverting other work. Record exact source hashes, dependencies, actual per-session CLI versions, build flags and app identity. The shell previously reported Claude 2.1.268; that is not proof every running session uses it.

Recover the known valid raw captures. Take one short cold-open WebKit Frames/Timelines diagnostic separating scripting, layout and paint, with history/Worker/first-render milestones. Keep initial mounting and full transcript content in the measured path. Diagnostic instrumentation is not an acceptance score.

Create an inventory of all recurring checks, their owners, producers, freshness requirements and replacement events. Include recursive `setTimeout`, not just `setInterval`. Establish counts for idle wakeups, workbench/Git reads, shell/list/row commits, IPC bytes, and terminal reads. Instrumentation must be disabled or negligible in production.

**Exit:** reproducible baseline manifest, timer inventory, and attributed next rendering target. If tracing is unavailable, distinguish that diagnostic limit from the separately source-proven broad subscription defect; do not claim a root cause for the 45-ms event.

### P1 — Complete and verify the event-driven feed flusher

**Files:** `crates/supervisor/src/batcher.rs`, supervisor sink/lifecycle, relevant tests.

Audit the restored candidate for startup races, dropped-owner behavior, retained senders, lock ordering, and changes during flushing. Schedule a single deadline when pending data arrives; do no periodic flush work while empty. Preserve the existing maximum batching interval under sustained traffic rather than allowing a debounce to reset indefinitely.

Do not promise a strict real-time 16-ms bound: executor scheduling and serialization add latency. Verify whether the candidate's sleep-after-flush reduces throughput relative to the current cadence. Preserve correct drop behavior for invisible display rows, authoritative control delivery, counters and the burn visibility lease. Ensure no error/approval signal can disappear silently on buffer overflow; define recovery from durable state separately from coalescible display progress.

Keep channel writes outside locks. Last-owner drop must terminate a sleeping receiver without a permanently retained sender. Consider shutdown during an armed deadline and queued-but-unflushed final state explicitly. Avoid broadcast wakeups on changes that produce no observable pending work if the current semantics allow it.

**Tests:** data before subscription, push during subscription setup, burst coalescing, push during drain/send, hidden-project counters/signals, sustained flood, empty idle, last-owner drop, sink failure, shutdown and final event delivery. Use controlled clocks for scheduling tests and real replay for throughput.

**Exit:** no periodic empty flushes; no lost required events; same or better delivery latency/throughput; lifecycle tests pass. Test-only flush counters are purposeful diagnostics, not an unused addition.

### P2 — Publish authoritative domain changes and share frontend reads

**Backend owners:** workbench data, navigation/archive, peers, plan/phase/work-order persistence, checkpoints/session changes, cleanup, provider discovery. **Frontend:** `workbenchApi.ts`, `workspaceApi.ts`, `peerApi.ts`, `desktopApi.ts`, `providerCatalog.ts`, `App.tsx`, `ProjectWorkbench.tsx`, `Sidebar.tsx`, `NewSession.tsx` and domain hooks.

Add a small domain event/revision contract rather than invalidating every view for every feed token. Publish plan changes after their store commit, not after each transcript write. Cover peer/background/CLI-origin mutations as well as UI commands. Stop-run state and other authoritative in-memory changes need their own publication edge. Preserve current approval ordering.

Build shared stores for workbench, keyed worktree status, peer data, relevant session changes and catalog state where actual consumers overlap. Coalesce overlapping fetches and dirty events, cache stable failures such as non-Git/missing HEAD until relevant invalidation, and retain loading/error semantics. Never cache a transient authentication/network failure as a permanent empty catalog.

Replace these audited paths only after producer coverage exists:

| Current path | Replacement |
|---|---|
| Sidebar workbench load, 2.5 s; workbench data load, 3 s | Shared workbench snapshot and persisted mutation/external-note invalidations |
| Workbench Git refresh, 5 s | Per-worktree filesystem/Git invalidation plus explicit mutation completion |
| App archive refresh, 5 s | Complete `archive-changed` coverage, subscription-ready snapshot and focus recovery |
| Peer snapshot, 30 s | Complete `peer-state-changed` coverage and dirty-during-read recovery |
| Run refresh, 1 s | Committed plan/phase/work-order/intent changes plus stop/reconcile state |
| Session changes, recursive 3.5-s timeout | Checkpoint/rewind/commit changes and shared per-session snapshot |
| Cleanup polling | Cleanup job transition events, with persisted initial job snapshot |
| New-session refresh, 5 s; catalog retries/15-s poll | Discovery lifecycle/CLI update events, explicit refresh and installation-path changes where reliably observable |

Do not delete a fallback for an unsupported external producer until a reliable replacement or explicitly documented degraded refresh policy exists. A provider installation after launch must still be discoverable. Startup `pending`, discovery `running`, successful `empty`, and `failed` are distinct states.

**Tests:** subscription initialization races, same-key concurrent consumers, invalidation during fetch, stale response after key switch, reconnect/epoch reset, failed write, background mutation, unchanged identity, error recovery, and post-unmount disposal. Verify only one read per shared invalidation and no stale UI after replacing polling.

**Exit:** each removed poll has complete event/recovery coverage, with the revised IPC contract and an inventory of any intentional remaining timers.

### P3 — Native filesystem watches with bounded refresh work

**Files:** proposed `src-tauri/src/workspace_events.rs` (name subject to existing module seams), workspace/Git/notes services and app lifecycle.

One owned watch service manages reference-counted roots for active/cached workspaces and configured notes directories. Discover linked-worktree administration/common Git paths using supported Git commands, not an assumption that `.git` is a directory. Cover shared refs/config and worktree-specific HEAD/index/files; deduplicate overlapping subscriptions.

Register before the initial scan. Native events invalidate affected roots/path sets. Coalesce file storms with one in-flight refresh and a follow-up dirty generation; use a maximum delay so continuous writes do not starve refresh. Avoid self-trigger loops from Git's own lock/index refresh, cache writes, app logs, and database/WAL activity. Do not solve that by ignoring changes to meaningful index/HEAD state.

Distinguish automatic background discovery exclusions from tool access. Generated/dependency trees may be excluded from automatic scans where semantics permit; tracked files, explicitly opened files, ignored-file queries, and relevant configuration must remain accessible. Respect symlink boundaries, cycles, permissions and deleted/replaced roots. Filtering a callback does not prove that the OS watcher avoided traversing that subtree; measure native watch behavior.

On overflow/`need_rescan`, watch error, root rename/delete, ignore/config change, or uncertain state, invalidate the affected cache broadly and rescan deliberately. Examine rescan flags before filtering individual paths. Reattachment must not create infinite rapid retries. Focus/reconnect/manual refresh provides a recovery path, not proof that an unavailable watcher is healthy.

**Tests:** external edits, atomic saves, create/delete/rename, notes-folder change, ignore change, two dirty worktrees at the same commit, ref/index changes, symlink cycles, install/relink storm, overflow, access loss and root replacement. Count scans to verify coalescing without asserting one scan during endless writes.

**Exit:** correct external-change freshness and bounded scans/retained subscriptions; no always-on workspace-wide crawl.

### P4 — Resolve the handed-over rendering issue

**Files:** `src/App.tsx`, `src/feedStore.ts`, `src/components/Sidebar.tsx`, selected-session hooks, `ThreadView.tsx`; conditional `TranscriptRuntime.tsx`/viewport integration.

Replace the broad shell subscription with stable cached domain snapshots and keyed listeners:

- Shell reads navigation/selection and only aggregates it actually displays.
- Session list reads ordered visible IDs and relevant grouping/filter/sort fields.
- Each row reads its own title/status/attention and needed relationship data.
- Selected transcript reads its own rows/runtime state.
- Approval and error surfaces subscribe to their authoritative domains independently.

Build sidebar titles/order/session projections at their owner with stable identities. Changes to one row must not rebuild all row objects or unrelated terminal docks. Real title/order/filter changes still update the list; real global badges may update a small aggregate consumer. Do not freeze recency semantics or hide lifecycle changes to make the artificial burn easier.

Separate keyed notification fan-out from snapshot identity: callbacks for every subscriber on every event can still cost CPU even if React skips rendering. Reuse prior narrow transcript/source lookup work. Memoized snapshots must obey `useSyncExternalStore`; `startTransition` is not an external-store scheduling fix.

Address the first-open cost identified in P0. Inspect Worker readiness/fallback and whether waiting for labels creates a new critical-path delay. Preserve locale/time-zone/midnight behavior and visible labels; do not prewarm hidden content or exclude the initial mount from capture.

**Conditional viewport experiment:** only if attribution shows material runtime/measurement overhead, try removing the synthetic message representation while retaining suitable AUI context for Markdown. Preserve virtualization, initial bottom intent, restored mid-history position, user scroll-away, resize/attachment/expanded-card changes, accessible Jump to latest, sticky footer, focus and writable/read-only behavior. Prevent ResizeObserver/write feedback. The existing read-only viewport is not a ready equivalent. Reject the experiment if it lacks a measurable gain or breaks those invariants.

Do not repeat rejected containment/lazy-tooltip experiments absent new evidence. The shared tooltip design already merged is the baseline. Do not add custom memo comparators that ignore callback changes.

**Tests:** unrelated session updates leave shell/list snapshots stable when their fields did not change; only affected row subscribers fire; actual reordering works; approval delivery is immediate; callback navigation remains current; keyboard focus survives updates; restore/follow/resize/jump behavior is intact. Then compare the same cold-open event and both representative/adversarial native captures.

**Exit:** attributed cold-path correction, isolated update paths, and a valid rendering result for the final candidate. Source cleanup alone cannot close this package as “hitch fixed.”

### P5 — Terminal streaming and legitimate deadline timers

**Files:** `src/components/TerminalView.tsx`, terminal backend, `workspaceApi.ts`, `keep_awake.rs`, elapsed/status display hooks.

Terminal output currently uses recursive reads every 50 ms and periodic snapshot/CWD work every 3 s. Replace reads with a Tauri channel driven by the PTY reader and a distinct process-exit signal. Preserve byte ordering, UTF-8 boundaries, cursor/reconnect behavior, drain-before-exit reporting, current overflow notices and terminal write/resize ordering. A hidden terminal must retain its process and recover its view without rerunning the shell.

Define one stream owner per terminal, bounded retention, last-consumed cursors and subscription replacement after reload. Do not replace polling with an unbounded IPC queue. Reconnection must not duplicate output or lose the retained tail. Snapshot persistence should be dirty-triggered and coalesced, with an appropriate maximum durability deadline while output is changing and a pagehide/teardown flush. Zero output means no repeated full terminal serialization.

CWD has no universally reliable event from arbitrary shells. Prefer supported shell integration; otherwise retain an explicitly justified bounded check while relevant, or refresh on defined interactions without misrepresenting freshness. Do not promise universal event-only CWD tracking.

Keep-awake follows provider activity/settings transitions; a lease-renewal deadline remains only while an assertion is active. Preserve the existing default-off preference and scope of assertion unless the owner changes it. Confirm activity events cover native background work before removing the old activity poll.

Elapsed-time displays, retries, update checks and actual deadlines are not all polling bugs. Share visible clocks where useful, stop them when settled/hidden, and retain scheduled update checks for remote services lacking push. List each remaining timer and why it exists.

**Tests:** idle PTY causes no reads; split byte chunks; large output; overflow; reconnect; hidden/unmounted view; completion with final bytes; input/resize ordering; shell exit; snapshot recovery; keep-awake enter/leave/renew/disable. Test CWD fallback honestly.

**Exit:** idle terminal drain polling removed, active streaming correct and bounded, and intentional timers documented.

### P6 — Reduce scans and safely share factual computations

**Files:** `src-tauri/src/search.rs`, workspace read services, app-owned agent tool integration where supported.

First implement the source-proven explicit-path improvement: searches with `q.paths` currently filter within a full root walk. Visit the selected candidates directly where the existing contract allows it, preserving normalization, ignore/hidden rules, symlink/permission boundaries, duplicate handling, multiline/Unicode locations, output caps and replacement checks. An explicit-path optimization must not silently change which files match.

Keep ripgrep as the preferred shell-search tool for applicable agent guidance; Claude native Grep already uses it. Supply scoped path/type guidance, filename-only discovery and compatible multi-pattern searches where appropriate. Preserve an expansion path when results are incomplete. Do not intercept or text-rewrite arbitrary `grep` commands.

Measure before replacing Brigadier's `ignore`/`regex` implementation with an external `rg` or another crate. Compare equal semantics and cold/warm workloads. Avoid adding a semantic index.

Deduplicate identical in-flight app reads/searches. Add bounded settled caching first for immutable blobs; key by content and tool/query semantics. Mutable search caches require workspace generation plus changes to dirty/untracked files, ignore rules, scope, options and engine version. Commit SHA, path/mtime, or a short TTL alone is insufficient. Uncertain watcher state invalidates reuse. If edits overlap execution, do not publish/cache mixed-state results as a verified snapshot; retry or mark them stale with a bounded policy.

Cache successful read computations, not agent conclusions or independent reviews. Required provider integration is explicit: adding an MCP search service does not make native Grep use it. Ship agent-side reuse only through an existing/supported app-owned tool path with observable adoption and unchanged permissions/results. Otherwise deliver the app-side savings and document that native provider searches remain provider-owned.

**Tests:** result parity against the baseline, selected-path visit counts, differing dirty worktrees, writes during read, ignore/config changes, nonexistent/inaccessible files, hidden-file expansion, symlink escape, cache bounds/eviction, cancellation and waiter independence. Record bytes/entries scanned and end-to-end lookup latency.

**Exit:** selected-path searches avoid unrelated traversal with equal results; caches cannot return false absence/stale content; no claimed native-tool speedup without evidence.

### P7 — Preserve computation and provider-cache reuse

**Files:** existing verify/build integration, prompt construction, MCP/provider lifecycle and telemetry; exact seams selected from the audit.

Audit repeated build/test invocations first. Prefer the repository's existing incremental/compiler/task cache. Do not install a new build system or create a generic test-result cache by default. Join duplicate deterministic validation only when command, source including dirty files, dependency graph, toolchain, environment, configuration and required artifacts are equivalent. Define cancellation ownership so one waiting agent cannot kill another's required check. Unknown inputs, flaky/network tests, side effects and different environments bypass reuse. Keep final integration validation and honest per-request evidence.

Audit prompt construction for unnecessary mutations to stable instructions/tool definitions. Keep dynamic task progress separate without removing information or changing instruction precedence. Preserve user-requested model/effort/settings changes even if they invalidate a cache. Use provider cache-read/cache-write telemetry where available; unknown is not zero. Do not add API caching flags the subscription CLI does not expose. Record output quality/validation parity and first-response/completion time rather than claiming reduced local CPU from provider caching alone.

Measure MCP/hook/status-script/LSP startup and duplicate residency. Reuse only supported, correctly isolated resources; some MCP servers hold session-specific state and cannot be pooled safely. Keep all required functionality/discovery available. No blanket `--bare`, disabled hooks, model reductions, fresh-session churn or tool removal. Existing MCP-off measurements are not a full-capability optimization result. Starting additional language servers is conditional on net benefit and ownership/isolation.

**Exit:** safe supported reuse is implemented and measured, or an explicit evidence-backed no-op decision identifies why no compatible reuse exists. No unsupported transparent provider interception or universal speedup claim.

### P8 — Bound memory and close lifecycle leaks

Audit new caches, keyed subscriptions, native watcher handles, Worker lifetimes, terminal buffers, full transcript copies, provider stdout/stderr/log rotation, retry loops and child processes. Preserve existing idle-worker retirement, normal process-group shutdown and startup orphan sweep; do not introduce a second competing owner.

Extend cleanup only where observed gaps exist. Distinguish completed idle workers from parents responsible for active descendants. Reap owned completed tools while preserving durable history, uncommitted work and resumability. A macOS process group does not automatically guarantee cleanup of descendants that detach; document and test actual ownership coverage. Immediate force-quit cleanup requires an independently surviving mechanism and a separate verified design; the current next-start orphan sweep is not that guarantee.

For persistent retry errors, model stable failed/unknown states and retry on relevant changes or bounded deadlines. Do not use a high-frequency health monitor to fix idle CPU. Low-cost event counters and on-demand diagnostics should attribute app/provider/tool work without exposing prompt content or credentials.

**Exit:** bounded retention and listener/task counts during a soak, correct cancellation/normal-exit cleanup, explicit crash limitations, no indiscriminate process killing or destructive workspace cleanup.

### P9 — Integrated validation, release, and the remaining handoff obligations

Run the matrix below against one identified final candidate. Fix attributed failures and rerun affected checks; do not repeat every broad test after every small edit. The repository's complete gates run once at final integration and again only when subsequent changes invalidate their coverage.

Build normal production output without benchmark/profile flags. Record source/build/binary hashes and signature verification. Confirm the installed destination/version before replacing it; preserve app data and a rollback bundle. Do not install the old timestamp candidate as if it includes this plan's changes. Installation follows implementation resumption and a passing release decision, not this plan-writing turn. Active sessions must be allowed to settle or be handled under the owner's direction; do not terminate productive work merely to install.

Perform one focused installed-app smoke check: startup, project/session navigation, streaming, approvals, external-file refresh, terminal, cold transcript and scrolling. Keep evidence and concise release notes describing remaining limits.

Revalidate the earlier artifact cleanup audit after the new evidence/rollback bundle is preserved. Delete only confirmed task-owned generated artifacts authorized by the owner; retain favorite designs, protected backups, untracked user work, shared dependencies and other tasks' branches/worktrees. No recursive cleanup derived solely from an old temporary manifest. Record retained and removed paths.

**Exit:** verified installed build or a specifically documented release blocker; no false zero-drop claim; handoff diagnosis/validation/app-update obligations explicitly closed or marked outstanding.

## 6. Validation matrix and performance acceptance

### Correctness gates

The usual final commands from `CLAUDE.md` remain:

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo doc --workspace --no-deps
npm test
npx tsc --noEmit
npm run tauri build
```

Read each exit code directly. No live provider test runs merely because an ignored test exists; use fixture replay by default. If actual provider calls are needed for workload equivalence, record their scope and consumption and use the owner's existing authorization only as applicable. Avoid parallel compilations during performance captures.

### Workloads

| Workload | What it must establish |
|---|---|
| Idle, no running jobs, visible and hidden separately | No empty feed/PTY polling; bounded background work; stable memory |
| Original ten-session, 200-events/s lifecycle burn | Existing adversarial behavior retained; full expected delivery; approval/control correctness |
| Sustained text/tool deltas with long history | Representative streaming, no full-transcript recopy on every delta, responsive typing |
| Three sessions with one to five subagents each | Unchanged concurrency/configuration and useful completion throughput |
| Cold first transcript and warm reopen | Actual first-open hitch fixed; no hidden prewarming or shifted measurement window |
| Dependency-install/file-event storm | Coalesced bounded refresh, correct eventual state, no runaway scanners |
| Two dirty worktrees and concurrent edits | Cache/search/status isolation and freshness |
| PTY flood, quiet terminal, reconnect and exit | Ordered bounded output, no idle reads, final-byte preservation |
| Two-hour repeated workload/soak | Bounded caches/listeners/processes and stable retained memory after warmup |
| Failure cases: watcher loss, failed Git, failed persistence, frontend reload | Explicit recovery without tight loops or false current/success state |

Measure app Rust process, relevant WebKit/Worker processes, CLI and descendants separately. Record CPU-seconds, wall time, memory footprint/RSS definitions, swap/pressure, wakeups, scan counts/bytes, IPC volume, render fan-out and task validity. Do not sum incomparable memory measurements or call aggregate multi-core percentages a percentage of the entire machine.

### Targets and interpretation

- Existing startup target: exec to first contentful paint **≤295 ms p50** under the documented startup harness. Record build type and cold/warm state; old debug and new release results are not interchangeable.
- Existing native rendering requirement remains the current **60-Hz zero-missed-opportunity gate**, with full required delivery and no excluded first-open interval. Name it accurately as rAF-based unless a separate presentation instrument is used. Inspect the actual script's rules before freezing the acceptance manifest.
- Proposed added idle target: total attributed Brigadier app/WebKit CPU below **1% of one core averaged over ten minutes** with no jobs. It is a target, not an achieved result or universal device guarantee.
- Proposed input target: p95 input-to-paint below **100 ms** at the declared workload; does not replace the stricter existing frame gate. Use an appropriate measured endpoint rather than a Rust sink timestamp.
- Proposed soak target: after warmup, less than **10% retained-memory growth over the final hour** plus published absolute peak and verified cache/process bounds. A percentage alone can hide an excessive baseline or slow leak; inspect trend and retained allocations.
- Throughput: same required checks/results, same model/effort/tools/concurrency, and no meaningful regression in paired cold/warm runs. Define the regression tolerance using measured baseline variance before evaluating the optimization. Deterministic local replays provide attribution; variable live-model runs do not prove a small percentage gain.
- Improvements to one layer do not excuse lost events, stale snapshots, weaker validation or deferred visible work.

All new numerical targets are reviewable proposals. Existing gates must not be weakened to make this work pass.

### Bounded diagnosis protocol

Start from a named hypothesis and a short targeted trace, not another indiscriminate minute-long burn. Make one attributable change and rerun that check. Run the full gate when the localized result justifies it.

Capture manifest: exact source and dirty patch hashes, binary/build flags, OS/hardware, power/display setup, workload/event counts, visibility transitions, capture duration and profiling state. Invalid hidden/occluded or incomplete-delivery captures are neither passes nor evidence for a speculative cause.

After two invalid captures for the same reason, stop repeating that method and investigate visibility/delivery/instrumentation explicitly. Do not change the benchmark workload, prewarm the measured path, postpone mounting, filter bad intervals, or claim a best-of-many passing run. Record every attempt and its validity. Do not keep the user occupied with open-ended repeated “leave the desktop untouched” requests.

Inspector traces are diagnostic. Acceptance uses the ordinary instrumented gate/normal production path as specified; separately measure instrumentation overhead. Use the existing startup sample count and predeclare repeated rendering/completion comparisons. Report variation and failures, not only a favorable median.

## 7. Dependency order, checkpoints and rollback

Recommended sequence: **P0 → P1 → P2/P3 → P4 → P5 → P6 → P7 → P8 → P9**. The P0 cold trace happens before additional cold-render experiments. P4 subscription work can proceed after its event/snapshot contracts are fixed without waiting for agent-side cache experiments. Each package has its own focused regression checks.

Suggested commit boundaries: baseline/contracts; feed scheduling; domain events/shared stores; filesystem watches; scoped UI subscriptions/cold fix; terminal stream; search/cache changes; verified reuse/lifecycle work; final evidence/release. Commit only after required coverage and any repository gates applicable to that checkpoint. Never use these boundaries to imply an unvalidated feature is complete.

Keep changes reversible. Use existing read paths as recovery while migrating each domain; remove redundant fallback timers only after replacement coverage passes. Do not keep both old polling and new listeners permanently active. Avoid feature flags that become undocumented permanent alternatives. Roll back the responsible package on a correctness regression; preserve raw evidence for diagnosis.

At each checkpoint record: behavior changed, evidence, measured cost before/after if available, tests, known limits, and next dependency. Unsupported experiments are explicitly closed as such. Do not silently omit P7/P8 because their safe integration is harder than removing a timer.

## 8. Risks the adversarial reviewer must examine

1. Event emitted before commit, subscription-ready race, stale snapshot after a later event, or invalidation lost during an in-flight read.
2. Notifications move from a timer to an equally expensive token/event fan-out; file storms or Git self-writes trigger infinite refreshes.
3. Batcher watch receivers retain an owner, lose startup/final events, or reduce sustained cadence by serializing sleep after costly flush work.
4. Control signals share a lossy display queue; “coalescing” silently drops approvals, terminal bytes or lifecycle transitions.
5. Cache identity excludes untracked/dirty files, ignore rules, environment or worktree metadata; direct-path search changes permissions or match coverage.
6. Global shell fan-out persists behind selector-looking APIs; changed status/order/attention is accidentally hidden by memoization.
7. Native rendering claim confuses rAF scheduling with screen presentation; hidden captures, changed fixtures, old binaries or shifted cold work create a false pass.
8. Worker/runtime changes add latency or break locale/scroll/focus behavior; an unmeasured runtime rewrite repeats prior speculative work.
9. Build/test sharing suppresses required independent validation, shares mutable outputs, or lets one waiter cancel another's task.
10. MCP/provider pooling leaks session state or disables capabilities; prompt reordering changes semantics/precedence; a claimed native-tool cache has no real consumer.
11. Terminal event streaming creates unbounded buffering, duplicate output after reload, missing exit tails or weakened recovery durability.
12. Watcher/API availability, network filesystems and arbitrary shell CWD limit event coverage; degraded behavior is concealed.
13. Crash cleanup assumes all descendants remain in a process group or relies on the dead parent to run cleanup.
14. The release uses an intermediate binary, installs while productive jobs are running, or executes a stale cleanup manifest that removes protected artifacts.
15. “Everything implemented” means speculative optimizations were forced in despite no safe capability-preserving route. Conversely, conditional work is used as an excuse to skip supported improvements without evidence.

## 9. Definition of done

The implementation is complete only when event/snapshot correctness, rendering, search semantics, terminal behavior and lifecycle checks pass; required optimizations are measured or explicitly closed with evidence; useful throughput and full AI capability remain intact; the current-source native gates have valid results; and the installed production build and cleanup/handoff status are accurately recorded.

Until the owner returns with the adversarial review and resumes implementation: **deliver this plan only. Preserve the unstaged batcher patch and all other work. No source edits, builds, profiling, installation or cleanup.**

## 10. Review request for Claude Fable 5.1

> Adversarially review this plan against the actual repository at the stated baseline and the accompanying research/performance evidence. Do not implement it. The owner requires full model capability, reasoning, tool/context access and agent concurrency, with reduced harness overhead and equal or better useful throughput. Include the handed-over first-transcript rendering hitch; it is not certified fixed.
>
> Identify concrete correctness holes, unsupported assumptions, scope gaps, needless complexity, impossible guarantees, and measurement flaws. For each finding, cite the plan section and source/code when available, give a failure scenario, severity, minimal correction, and an acceptance test. Distinguish verified defects from hypotheses and explain which phases should change order. Examine especially event/snapshot races, watch storms, dirty-worktree caches, control/terminal loss, external-store fan-out, cold-render attribution, validation sharing, and release artifact identity.
>
> Do not propose smaller models, less reasoning, fewer agents, arbitrary CPU limits, skipped tests, destructive cleanup, or changing the benchmark to manufacture a pass. Assess whether each conditional experiment has a sufficient evidence gate and whether every mandatory deliverable is feasible. End with: blocking revisions, nonblocking improvements, unresolved questions that actually require the owner, and a revised execution order if warranted. No generic approval statement; make the review actionable for the implementing agent.
