# P8 lifecycle and memory-bounds audit — 2026-09-11

Read-only audit for work package **P8** of `docs/plans/efficiency-and-rendering-plan-2026-09-11.md`
(§5, "Bound memory and close lifecycle leaks"; §8 risks 11, 12, 13). No file in the tree was
modified, nothing was built, nothing was run: every claim below is from reading source in
`/Users/stephen/Development/brigadier-ai.worktrees/perf-efficiency` at branch
`perf/efficiency-p3-p5b-p6`, including another worker's uncommitted edits to
`src-tauri/src/keep_awake.rs`, `composer.rs`, `sink.rs`, `peer_sessions.rs`, read as current.

Tags: **[verified]** — read in the source at the cited line, in this tree, today.
**[hypothesis]** — reasoned from what was read; the failure was not reproduced or measured.
Nothing here is **[measured]**; no process was started for this audit.

Prior evidence relied on:
`docs/research/orphan-sweep.md` (measurements 1–20, darwin 25.5.0, 2026-09-02),
`docs/research/efficiency-plan-external-facts-2026-09-11.md` §7 (macOS process-group and
`EVFILT_PROC|NOTE_EXIT` documentation),
`docs/plans/efficiency-plan-review-2026-09-11.md` B8/B9.

---

## 1. Caches and registries, and what bounds them

### 1.1 `src/feedStore.ts`

| Structure | Line | Growth bound | Eviction | Freed by |
|---|---|---|---|---|
| `sessionRows` ring `buf` | `:277`, `:357-362` | `ROW_CAP + RING_SLACK` = 4,000 `FeedRowWire` per session | head `splice` once `buf > 4000`, back to 2,000 | `dropSession` `:1258` |
| `projectRows` ring `buf` | `:278`, `:357-362` | same, per project | same | `dropProject` `:1294` |
| ring `snap` | `:368-380` | one trimmed copy ≤ `ROW_CAP` per ring | replaced on next read after an append | with the ring |
| `sessions` (runtimes) | `:279` | one `SessionRuntime` per session id the feed ever mentioned | none | `dropSession`/`dropProject` only |
| `sessionDeltas` | `:146` | one `number` per session id | none | `:1260`, `:1288` |
| `usageWindows` | `:160`, `:174-179` | one array per session id, replaced field-wise when values move (`:163-172`) | none | `:1259`, `:1287` |
| `approvals` | `:280` | one per open request | `request-resolved` `:535`; session/project drop `:1263`, `:1291` | as noted |
| `listeners` | `:281`, `:953-955` | one per `useSyncExternalStore` mount | `delete` in the returned unsubscribe | unmount |
| `selectorListeners` | `:290`, `:976-993` | one entry per `subscribeTo`/`useFeedSelector` mount | `delete` in the returned unsubscribe `:992` | unmount |
| `knownProjects` / `unknownProjects` | `:293-294` | one id each | `:1131`, `:1295-1296` | project delete |
| `deletedSessions` / `deletedProjects` | `:575-576` | **unbounded** | **none** | **never** |

**[verified] Gap 1 — `deletedSessions` / `deletedProjects` are tombstones with no eviction.**
`src/feedStore.ts:575-576` declares them, `:1244`, `:1280`, `:1284` add to them, and nothing in the
file removes from them — there is no `resetStore` export and no expiry. Two costs, and the second
is the larger:

- retention: one session-id string per session ever deleted, for the window's life. Small.
- **per-batch CPU, permanently**: `applyBatch` at `:581-586` rebuilds every incoming batch —
  a spread plus three `Array.filter` passes over `rows`, `signals` and `counters` — on *every*
  batch for the rest of the session, as soon as `deletedSessions.size > 0`. At the benchmark's
  ~60 batches/s that is three array allocations per batch forever, to filter against ids no live
  producer will ever emit again. The Rust batcher stops sending for a deleted session within one
  tick of `mark_deleting` (`src-tauri/src/cleanup.rs:198` closes terminals and
  `crates/supervisor` marks the sessions), so the filter is load-bearing only for the batches
  already in flight.

*Smallest fix*: evict a tombstone once no batch has mentioned it — e.g. record the `lastEventSeq`
(or a drain counter) at which the id was added, and drop it on the first drain where
`buffer.length === 0` two drains later; or simply clear both sets in `drain()` when the buffer is
empty and the deletion is at least one `COUNTER_FLUSH_MS` old. *Test*: delete a session, drain an
empty buffer twice, assert `applyBatch` no longer rebuilds the batch object (identity of the
`FeedBatch` passed in is preserved) and that a resurrected row for that id is still refused for
one tick after the delete.

**[verified] Already bounded**: `sessions`, `sessionRows`, `usageWindows`, `sessionDeltas` are all
keyed by session id and all four are removed together in `dropSession` (`:1257-1260`) and
`dropProject` (`:1285-1288`). A session that *ends* is deliberately kept (it is still a sidebar
row); this is retention by design, not a leak.

**[verified]** The drain loop arms only while it has work: `armWork` `:827-831` arms one `rAF`
plus a `DRAIN_FALLBACK_MS` timer, `rearm` `:869` and the `"fold"` state arm one `setTimeout` for
the `COUNTER_FLUSH_MS` remainder, and an empty drain arms nothing. An idle window costs no timer.

### 1.2 `src/workbenchStore.ts`

**[verified] Bounded.** `listeners` `:68` is a `Set` cleared entry-by-entry in the unsubscribe
`:221-224`; the last unsubscribe calls `stop()` `:202-216`, which removes both window listeners,
clears the interval, cancels the first-load `rAF`+`setTimeout` pair, bumps `epoch` and **drops the
cached payload**. `epoch` `:74` and `publishRevision` `:86` are monotonic JS numbers, not maps.
The one retained object is `serialized` `:67` — a full `JSON.stringify` of the whole
`WorkbenchData` (notes, global settings, per-project settings), held for as long as a consumer is
subscribed. That is O(workbench size), not O(time). No unbounded key.

**[verified] Already bounded**: the 3 s `setInterval` `:166` is cleared on `visibilitychange` to
hidden (`onVisibility` `:173-180`) and re-armed on show, so a backgrounded window wakes zero times.

### 1.3 `src/hooks/useConversationHistory.ts`

- `historyDelivery` `:20` — a `Map` keyed by session id, **written only under
  `import.meta.env.VITE_BURN === "1"`** (`:139-144`) and deleted in the effect cleanup `:195`.
  **[verified] bounded.**
- `firstPage` `:38` — a single slot holding `{key, page: Promise<HistoryPage>, claimed, released}`.
  `releaseFirstPage` `:57-59` only *marks* it released; the slot and therefore the resolved
  `HistoryPage` (one page of `ChatItem`s for the last-mounted transcript) stay reachable until the
  next `beginFirstPage` overwrites them. **[verified]** one page, not a growing set; after the last
  transcript unmounts it is retained indefinitely. Low severity, real: *smallest fix*, null the
  slot in `releaseFirstPage` when `claimed && released` and no new key has claimed it; *test*, mount
  then unmount a transcript and assert `firstPage` is null.
- `labelPatch` `:86` — a `Map<seq, number>` rebuilt per effect run (`setLabelPatch(EMPTY_LABEL_PATCH)`
  at `:97`) and only ever given keys drawn from `windowItems` `:186-192`. **[verified]** bounded by
  the mounted window size, reset on every `[sessionId, revision]` change.

### 1.4 `src/timestampLabels.ts`

**[verified] The label cache is pruned, at 2,048 entries, FIFO**: `:41`,
`labels.delete(labels.keys().next().value!)` on insert when `labels.size >= 2048` and the key is
new. `pending` `:7` and `inFlight` `:8` are both drained by `finish` `:67-73`, which every reply
path and `failWorker` `:75-81` reaches. `changeListeners` `:12` is unsubscribed from
`useConversationHistory.ts:195` (`unpatch`).

**[verified] Gap 2 — one slow worker reply permanently disables label preparation for the window.**
`:109` arms `setTimeout(failWorker, 1000)` per request; `failWorker` sets `unavailable = true`
`:77` and terminates the worker `:78`, and `prepareTimestampLabels` returns immediately for the rest
of the window (`:84`). This is the *correct* shape for a stable failure state — no retry storm —
but it is permanent and silent: one 1 s hiccup under load costs every later row its prepared label
and forces the synchronous fallback on the main thread thereafter. The counter
`preparation.workerFailures` `:16` records it and nothing surfaces it.
*Smallest fix*: distinguish timeout from `onerror` — on a timeout, finish the pending request and
keep the worker, and only set `unavailable` after N consecutive timeouts. *Test*: a worker stub
that answers after 1.2 s; assert the next `prepareTimestampLabels` still posts to a worker, and
that three consecutive timeouts do disable it.

### 1.5 `src/sessionNavigation.ts`

**[verified] Bounded at two entries.** `parsed` `:29` is keyed by the two fixed localStorage keys
(`titlesKey`, `archivedKey`) and each entry holds `{raw, value}` for the current raw string only
(`:30-37`); a write from any source changes `raw` and replaces the entry. The *values* grow with the
number of named/archived sessions, which is the stored data, not a cache. `subscribe` `:42-49` adds
and removes both window listeners symmetrically.

### 1.6 `src-tauri/src/terminal.rs`

**[verified] Bounded, and the tightest-bounded component in this audit.**

- Registry cap: `spawn_profile` refuses at 12 terminals, `:335-339`.
- Ring: `RING_BYTES = 1 MiB` `:43`, enforced in `Stream::push` `:128-137` (oldest bytes discarded,
  `out.dropped` counted). Worst case 12 MiB total.
- Forwarder thread: started only by `Stream::subscribe` `:158-168`, and only if
  `forwarding.swap(true)` was false — so a **second subscribe replaces the channel and does not
  start a second thread** (`:161-167`). It returns on `closed`, on channel rejection, or after the
  exit frame (`forward` `:211-260`, `stop` `:173-180`).
- Channel replacement: `*installed = Some(channel)` + `epoch.fetch_add` `:159-163`. A webview
  reload therefore **replaces**, never accumulates. Same contract as the feed sink
  (`src-tauri/src/sink.rs:38-40`).
- Reader thread ends on EOF/error `:370-381`; waiter thread ends after `child.wait()` `:382-386`
  and drops the `WorkspaceLease` there.
- `Terminal::drop` `:265-289`: `mark(closed)` first (so a parked forwarder on an already-exited
  shell still returns), then `killpg(SIGHUP)` of the foreground group, `killer.kill()`, and
  `killpg(SIGKILL)` of the shell's own group.

**[verified] Gap 3 — the localStorage terminal snapshot is never removed when a tab is closed.**
`TerminalView.tsx:108` keys the snapshot `brigadier:terminal:${tabId}`; `tabId` is a
`crypto.randomUUID()` minted per new terminal tab (`components/ProjectWorkbench.tsx:579-585`).
The only removal in the tree is `src/sessionLocalData.ts:41`, reached when the owning **session**
is deleted or archive-purged. Closing a terminal tab, or reloading into a new layout, orphans the
key permanently. Each value is `serialize.serialize({scrollback: 200})` — 200 lines of xterm
output *with SGR escapes* (`TerminalView.tsx:124`), so tens of KiB each.
Consequence **[hypothesis]**: once the origin's localStorage quota is reached, `setItem` throws;
`TerminalView.tsx:126-128` swallows it (`/* bounded recovery is best effort */`), so terminal
crash-recovery stops working with no message — and every *other* localStorage writer in the app
(drafts, layouts, scroll positions, `sessionNavigation` titles) starts failing at the same moment.
*Smallest fix*: remove `brigadier:terminal:${tab.id}` wherever a tab is removed from a layout, the
same place `documentKey(tab)` is already removed (`ProjectWorkbench.tsx:145`, `:694`).
*Test*: open a terminal tab, write output, close the tab, assert
`localStorage.getItem("brigadier:terminal:<id>")` is null.

### 1.7 `crates/supervisor/src/batcher.rs`

**[verified] Fully bounded, and it prunes.**

- `PROJECT_ROW_CAP = 2000` `:32`, enforced at `:248-252` (oldest row dropped, `counters.dropped++`).
- `PROJECT_SIGNAL_CAP = 2000` `:36`, enforced at `:265-278`; a drop increments a process-wide
  `signals_dropped` atomic `:288` and logs **once per project** (`warned_signal_drop` `:100-104`).
- `ProjectAccum::prune` `:116-119` drops the counters of every session that both started and ended,
  and `flush_once` `:351` then `retain`s only projects that still have pending data or counters —
  so `state.projects` and its per-session `counters` map are not "one entry per id ever seen".
- The flusher task holds a `Weak<Inner>` and only a `watch::Receiver` (`:390-392`): dropping the
  last `Batcher` ends the loop. No timer runs while the feed is idle (`:400-410`).
- `State::visible` `:151` is replaced wholesale by `set_visible_projects`.

The one residual **[verified]** risk, already documented in the file: a signal drop at
`PROJECT_SIGNAL_CAP` loses an event the UI must see (approvals among them), and the wire shape has
nowhere to carry the count. That is §8 risk 4, not a memory bound.

---

## 2. Listener and task lifetimes

### 2.1 Every frontend `listen(` (Tauri event subscriptions)

| Site | Disposed on unmount | StrictMode-safe | Notes |
|---|---|---|---|
| `src/App.tsx:271-301` (7 `native-*`) | yes — `collect`/`unlisteners` `:256-259`, `:304-309` | yes — `stopped` flag calls `stop()` if unmount won the race `:255` | **[verified]** |
| `src/App.tsx:298` `archive-changed` | yes, same path | yes | **[verified]** |
| `src/providerCatalog.ts:81` | yes `:96` | yes — `if(!live){off();return;}` `:83` | **[verified]** |
| `src/desktopApi.ts:212` `cleanup-changed` | yes `:230-236` | yes — `if (!live) { stop(); return; }` `:222` | **[verified]** |
| `src/peerApi.ts:104` `peer-state-changed` | yes `:116-121` | yes `:107` | **[verified]** |
| `src/composerApi.ts:44` `composer-state` | returns the promise; caller owns it | caller-dependent | **[hypothesis]** — not traced to its consumer |
| `src/taskSettings.ts:35` `task-execution-settings` | returns the promise; caller owns it | caller-dependent | **[hypothesis]** |
| `src/components/TaskProgress.tsx:14` `task-checkpoint` | yes `:16` (`subscription.then(stop=>stop())`) | yes — `live` guard, and the late `stop()` still runs | **[verified]** |
| `src/hooks/useConversationHistory.ts:176` `conversation-state-changed` | yes `:195` | yes | **[verified]** |

**[verified] Gap 4 — a webview reload leaks every Rust-side JS listener registration, for the
process's life.** Tauri 2.11.5 stores JS listeners in
`InnerListeners.js_event_listeners: Mutex<HashMap<WebviewLabel, HashMap<EventName, HashSet<JsHandler>>>>`
(`~/.cargo/registry/src/index.crates.io-*/tauri-2.11.5/src/event/listener.rs:63`). Entries are added
by `listen_js` `:222-237` and removed **only** by `unlisten_js` `:239-252` — i.e. only when the page
calls the unlisten function. There is no navigation or page-load hook that clears the map: grepping
the crate for `PageLoadEvent` finds only the doc example and the public type
(`webview/mod.rs:652-677`), and there is no `unlisten_all_js` anywhere in the crate.
A reload destroys the document without running any React cleanup, so the ~12 registrations above
(7 `native-*`, `archive-changed`, `cleanup-changed`, `peer-state-changed`,
`provider-catalog-refreshed`, `task-execution-settings`, `task-checkpoint`, plus one
`conversation-state-changed` per mounted transcript) are stranded. `emit_js_filter`
(`listener.rs:269-292`) then evals a script for every stale id on every emit, so emit cost grows
linearly with the number of reloads.
*Smallest fix*: hold the app's own `on_page_load` (`PageLoadEvent::Started`) and call
`app.unlisten(id)` for the ids of that webview; or, if the crate offers no per-webview drain,
replace the frontend's global `listen` with a single Rust→JS `Channel` per concern (the pattern
`sink.rs` and `terminal.rs` already use, which is reload-safe by construction).
*Test*: a Rust test that registers a JS listener for label `main`, simulates the page-load hook, and
asserts `has_js_listener` is false; plus a soak assertion (§6c) that emit latency does not grow
across reloads.

**[verified] Reload-safe by construction** (the contrast that makes Gap 4 specific):
`subscribe_feed` (`src-tauri/src/commands.rs:1257-1262`) calls `sink.replace(on_batch)`
(`src-tauri/src/sink.rs:38-40`) — one channel, replaced; and `terminal_subscribe`
(`src-tauri/src/terminal.rs:535-547`) calls `Stream::subscribe`, which replaces the channel and
refuses to start a second forwarder (`:158-168`).

### 2.2 Long-lived frontend timers

- **[verified] Gap 5 — `src/App.tsx:251`: a 5 s `setInterval` archive refresh armed for the app's
  lifetime, with no visibility gate.** `useArchiveAndNativeEvents` is mounted once (`say` is a
  `useCallback([], …)` at `App.tsx:499-502`, so the effect never re-runs), and `begin()` `:249-252`
  arms `setInterval(refresh, 5000)` unconditionally. Each tick invokes `syncArchive()`. This is the
  same shape `workbenchStore.ts` already fixed (its interval is cleared on `visibilitychange`,
  `:173-180`). The `archive-changed` event already covers the real transitions (`App.tsx:298`).
  *Smallest fix*: gate the interval on `document.visibilityState`, exactly as `workbenchStore.arm`/
  `disarm` do; or drop it entirely now that the event is subscribed **before** the first refresh.
  *Test*: fake timers, dispatch `visibilitychange` to hidden, advance 30 s, assert `syncArchive` was
  not called.
- **[verified]** `src/peerApi.ts:113` — a 30 s poll, deliberately kept ("removing it waits on the
  producer coverage this reorder is a precondition for", `:98-99`). Bounded cadence, cleared on
  unmount `:118`.
- **[verified]** `src/components/TerminalView.tsx:130-141` — one 3 s snapshot deadline, armed only
  by output or a submitted line, disarmed on fire and on unmount; `terminalTimers()` `:23` exists to
  prove an idle PTY arms nothing.

### 2.3 `tokio::spawn` in `src-tauri/src/lib.rs` and the crates

- **[verified]** `lib.rs:319` (startup) and `:335` (reconcile/prune) run once and complete.
- **[verified]** `lib.rs:416` `spawn_signal_hook` — one task, parked on `SIGTERM`/`SIGINT`, ends the
  process. Not a leak.
- **[verified]** `keep_awake::start` `keep_awake.rs:127` — one task for the app's life, parked on a
  `watch` with **no timer** when nothing is held (`run` `:130-168`, `None` arm at `:165`).
- **[verified]** `composer::start` `composer.rs:109` — one `drain_loop` `:131-157`, edge-driven on
  `peer_sessions::subscribe_queue`, with only the deadline a pass asks for.
- **[verified]** `Batcher::spawn_flusher` `batcher.rs:393` — weak-referenced, ends when the last
  `Batcher` drops.
- **[verified] Gap 6 — `session_archive::start` (`src-tauri/src/session_archive.rs:269-307`) wakes
  every 60 s for the app's life, unconditionally.** Each pass takes three global async mutexes
  (`peers::CREATION`, `peers::LIFECYCLE`, the module `LOCK`), reads the archive JSON from disk, and
  reads `peers::snapshot()`, before finding nothing due and sleeping again (`:306`). On an idle app
  with an empty archive this is 60 wakes an hour plus 120 file reads, for no state that can have
  changed without an event. *Smallest fix*: compute the next expiry from the archive's own entries
  and sleep to that deadline (the archive is only written through this process), waking early on the
  existing `archive-changed` producer. *Test*: an empty archive with fake time — assert one pass,
  then a park with no further disk read for an hour of simulated time.
- **[verified]** `cleanup::launch` `cleanup.rs:174-190` returns when the queue is empty; it is not a
  poll.
- **[verified]** `provider_catalog::refresh_behind_the_answer` `provider_catalog.rs:79-81` is
  claim-guarded (`claim_refresh`) and emits on drop. One task per discovery.

---

## 3. Child processes — who owns them, and what a force-quit leaves

Every child the harness starts, and its coverage:

| Child | Spawned at | Own process group | In `PidTracker` | Reaped on normal exit | Swept at next start |
|---|---|---|---|---|---|
| `claude` / `codex` CLI session | `crates/core/src/claude/process.rs:233-266`, `process_group(0)` at `:265` | **yes** | **yes** — `crates/supervisor/src/lib.rs:1613` | yes — supervisor task `:294-306`; `terminate` `:316-340` does `killpg(TERM)` → `KILL_GRACE` → `killpg(KILL)` | **yes** — `crates/proc/src/sweep.rs:262` via `state.rs:402` |
| approval-policy CLI session | `src-tauri/src/approval_policy.rs:205` | yes (same spawn path) | **yes** | untracked at `:139` | yes |
| commit-message CLI session | `src-tauri/src/commit_message.rs:163` | yes | **yes** | untracked at `:85` | yes |
| peer MCP server (`<exe> --peer-mcp`) | the **CLI** spawns it, from the `--mcp-config` at `process.rs:160-164` | inherits the CLI's group | no (it is not ours to track) | dies with the CLI's group | covered only as a group member |
| `caffeinate -diu -t 60 -w <our pid>` | `src-tauri/src/keep_awake.rs:72-77` | **no** — inherits the app's group | no | yes — `Assertion::drop` `:63-67` kills **and waits** | n/a |
| terminal shell (`$SHELL -l` on a PTY) | `src-tauri/src/terminal.rs:361` | yes — the PTY makes it a session leader | **no** | yes — `Terminal::drop` `:265-289`, and `terminal::shutdown()` from `state.rs:152` | **no** |
| `lsof -a -p <pid> -d cwd` | `terminal.rs:629`, 2 s timeout, `kill_on_drop(true)` | no | no | yes | n/a |
| verify / gate command (`$SHELL -c`) | `crates/supervisor/src/verify.rs:320`, `process_group(0)` at `:349` | **yes** | **no** | yes — timeout kills the *group* `:346-370` | **no** |
| `$SHELL -l -i -c` PATH probe | `verify.rs:451`, `:500` | yes | no | yes, bounded by `PATH_PROBE_TIMEOUT` `:515` | n/a |
| `git` (worktree, status, diff, apply, archive, burn) | `crates/supervisor/src/worktree.rs:362,557,879,900`; `crates/core/src/worktree.rs:914`; `crates/core/src/checkpoint/git.rs:49`; `src-tauri/src/source_control.rs:481`, `workspace.rs:230`, `session_archive.rs:366,437`, `peer_orchestration.rs:570`, `burn.rs:177,255` | no | no | mostly; `kill_on_drop(true)` only at `worktree.rs:388`, `workspace.rs:241`, `source_control.rs:487` | n/a |
| `claude --version` probe | `crates/core/src/claude/binary.rs:33`; `updates.rs:38`, `:66`, `:230` | no | no | yes, all under `tokio::time::timeout` | n/a |

**[verified] Normal quit is covered.** `RunEvent::ExitRequested` and `RunEvent::Exit`
(`src-tauri/src/lib.rs:375-395`) both call `keep_awake::stop` (releasing the assertion) and
`AppState::shutdown_sync` (`state.rs:150-161`), which sets `closing`, calls
`terminal::shutdown()` (`terminal.rs:307-309`, clearing the registry and running every
`Terminal::drop`), then the cooperative `supervisor.shutdown_with(GRACEFUL_EXIT_GRACE)` followed by
the synchronous `killpg` backstop. `RunEvent::Exit` additionally runs `final_sweep`
(`state.rs:171-192`): `PidTracker::shutdown_sync` plus a blocking store flush. `shutdown_sync` is
idempotent by an empty-live-map check `:154-158`, which is what makes the ⌘Q path (`Exit` with no
`ExitRequested`) cost one grace period rather than two.

**[verified] A force-quit (SIGKILL of the app, or a crash) leaves behind, plainly:**

1. **Every CLI session's process group, briefly** — orphaned and reparented to `PPID 1` with its
   pgid intact (`orphan-sweep.md` measurement 11). Recovered by the next launch's startup sweep
   (`state.rs:402`, `crates/proc/src/sweep.rs:262-290`), which matches on the recorded kernel start
   time and refuses to kill a recycled pgid (`SweepAction::StartTimeMismatch`, `sweep.rs:79`).
   This is the designed behaviour, not a gap.
2. **Every terminal shell, permanently** — nothing writes a pid record for a PTY child
   (`terminal.rs:361-394` never calls `tracker.track`), so the startup sweep has nothing to find.
   Up to 12 login shells plus whatever they were running survive until the user kills them by hand.
   **[verified] by absence**: the only `track(` call sites in the tree are
   `crates/supervisor/src/lib.rs:1613`, `src-tauri/src/approval_policy.rs:205`,
   `src-tauri/src/commit_message.rs:163`.
3. **Any running verify/gate command, permanently** — `verify.rs:349` gives it its own group, which
   is what makes the *timeout* kill work, but no pid record is written, so a force-quit mid-`cargo
   test` orphans the whole build tree with no next-start recovery.
4. **Nothing from `caffeinate`** — it is spawned `-w <our pid>` (`keep_awake.rs:74`) and also
   `-t 60`, so it releases itself when the app dies. **[verified]** from the flags; the documented
   `caffeinate(8)` semantics of `-w` were not re-read for this audit.
5. **A grandchild that called `setsid(2)`, permanently** — `orphan-sweep.md` measurement 5 (a
   `setsid`'d Python grandchild survived `killpg` of the parent group and needed `kill -9` by pid)
   and `efficiency-plan-external-facts-2026-09-11.md` §7.1 (`man 2 setsid`: the caller becomes "the
   only process in either the session or the process group"). An MCP server that daemonises, or a
   `nohup`/`disown` inside a Bash tool call, is out of reach of `killpg` **and** of the sweep,
   because its pgid was never recorded. §7.2: there is no `PR_SET_PDEATHSIG` on macOS, and the
   documented substitute — `EVFILT_PROC|NOTE_EXIT` on the parent pid — requires cooperating code
   *inside* the child, which the `claude` binary does not provide. **Not fixable at this layer.**
   P8's own text says so; this audit confirms the code matches the claim.

*Smallest fixes for (2) and (3)*: call `tracker.track(...)` after `spawn_command`
(`terminal.rs:361`) and after the gate child spawns (`verify.rs:352`), with a distinct session-id
namespace (`terminal:<id>`, `gate:<phase>:<attempt>`), and `untrack` in `Terminal::drop` and at the
end of `run_owned`. The tracker already refuses a child in the app's own group
(`crates/proc/src/tracker.rs:85-94`), so a missing `process_group(0)` cannot turn this into a
self-kill. *Test*: the existing `the_timeout_kills_the_process_group_not_the_pid`
(`verify.rs:766`) pattern, extended to assert a pid file exists during the run and is gone after.

---

## 4. Retry loops and stable failure states

**[verified] Gap 7 — `src-tauri/src/peers.rs:1439-1595`: three `continue` paths bypass the loop's
only deadline, one of them at 10 Hz with a provider RPC in it.**
The delivery loop takes `deadline = now + 24h` at `:1437` and checks it at `:1591`, *after* the
inner block. Three paths `continue` before reaching it:

- `:1493-1494` — provider allowance exhausted: `sleep(1s)`, `continue`. Polls once a second for as
  long as the window is blocked, with no bound.
- `:1509-1510` — the owner still has pending composer work: `sleep(100ms)`, `continue`.
- `:1521-1522` — the owner session is not `Idle`: **one
  `native_control(NativeControl::Activity)` RPC to the provider CLI per 100 ms** (`:1512-1517`),
  then `sleep(100ms)`, `continue`.

So a completion waiting on a busy owner issues ten control-protocol round trips a second, for the
whole of that owner's turn, and can never expire. That is the exact shape P8 §5 names ("model
stable failed/unknown states and retry on relevant changes or bounded deadlines").
*Smallest fix*: move the deadline check to the top of the loop body so every path is bounded, and
replace the two owner-busy polls with a wake on `peer_sessions::subscribe_activity()` — the
activity model (`peer_sessions.rs:171-208`) already carries exactly "is this session working",
derived from the same events, and `keep_awake` already consumes it. *Test*: fake time plus a stub
supervisor that reports a busy owner; assert the number of `native_control` calls over 60 simulated
seconds is bounded by the number of activity edges, not by elapsed time, and that a permanently
blocked allowance returns `Peer message expired` at the deadline.

**[verified] Gap 8 — `src/providerCatalog.ts` polls every 15 s forever on a machine with no CLI.**
`RETRY_DELAYS_MS` `:24` is a bounded four-step budget (4.2 s total) — correct. But
`poll = setInterval(read, POLL_MS)` `:93` is cleared only by `stopPolling()` inside the `done`
branch `:62`, and `done = settled(p)` requires at least one provider with a known model catalogue
`:35`. On a machine where `claude` is not installed the catalogue is permanently empty, so the poll
runs for the window's life. Worse, the hook is mounted **per component** — `Composer.tsx:86`,
`NewSession.tsx:34`, `SessionPreferences.tsx:28` — so each concurrently mounted consumer holds its
own poll, its own `provider-catalog-refreshed` subscription and its own `focus` listener.
*Smallest fix*: consolidate into a module store with one subscription and one cadence, exactly as
`workbenchStore.ts` did for `workbench_load`; and stop the poll after N empty reads, leaving
`provider-catalog-refreshed` and `focus` as the wake sources (which is what the comment at `:29-32`
already says they are). *Test*: three mounts, assert one `provider_catalog` invoke per cadence tick,
and that with an always-empty catalogue the poll stops after the documented budget.

**[verified] Bounded, no action:**

- `src/desktopApi.ts:183-206` — cleanup snapshot: two retries (1 s, 5 s) then stop, cancelled by
  dispose and by the first event. Exemplary.
- `src-tauri/src/keep_awake.rs:152-156` — a `caffeinate` spawn failure retries on the 45 s renewal
  cadence rather than on the next edge, while enabled and working. Slow and bounded per tick, but
  unbounded in count; each attempt logs one `tracing::warn!`. **[hypothesis]** on a machine where
  `/usr/bin/caffeinate` is unavailable this is one warn line per 45 s forever — log noise, not CPU.
- `src-tauri/src/composer.rs:131-157` — edge-driven; the only timer is
  `UNREPORTED_RESET_RETRY = 60 s` `:104`, and only for a window whose reset the provider never
  reported.
- `src-tauri/src/composer.rs:686-689` — interrupt-acknowledgement poll at 25 ms, bounded by a 10 s
  deadline and wrapped in a 20 s `tokio::time::timeout` `:674`.
- `src-tauri/src/updates.rs:35-46`, `:66-79` — every CLI invocation is inside a
  `tokio::time::timeout` with `kill_on_drop(true)`; no retry loop at all. The frontend has no
  update timer.
- `crates/core/src/claude/process.rs` — no reconnect loop exists. A session that exits emits
  `SessionExited`; nothing respawns it on a timer.

---

## 5. Log, stdout/stderr and on-disk growth

| Sink | Where | Bound |
|---|---|---|
| Provider **stderr** | `crates/core/src/claude/process.rs:289`, `drain_stderr` `:349-362` | line-by-line into `tracing::warn!(target: "claude.stderr")`. No buffering beyond one line. **[verified]** |
| Provider **stdout** | `process.rs:287` | consumed frame-by-frame by the adapter; never accumulated. **[verified]** |
| `tracing` output | `src-tauri/src/lib.rs:443-452`, `tracing_subscriber::fmt().try_init()` | **destination is the process's stdout, with no file appender and no rotation anywhere in the tree** (grep for `rolling`/`appender`/`with_writer` finds none). In a bundled `.app` launched from Finder that goes to launchd's pipe, not to a file the app can overrun. **[verified] — no rotation is needed because nothing is written to disk; conversely there is no durable log for a post-mortem.** |
| Session NDJSON | `crates/store/src/ndjson.rs:27-31`, `:79-90` | `file-rotate` at `DEFAULT_MAX_BYTES = 16 MiB` × `DEFAULT_KEEP = 4`, gzip after the first rotation. ≤ ~80 MiB per session before compression; deleted with the session (`crates/supervisor/src/removal.rs:68`, `:100`). **[verified] bounded.** |
| `frontend-errors.ndjson` | `src-tauri/src/diagnostics.rs:14-28` | truncated at 256 KiB (`:19-21`); message capped at 2,000 chars, stack at 8,000. **[verified] bounded.** |
| `paint.ndjson` | `src-tauri/src/commands.rs:1300-1340` | **append-only, never rotated, never read back by the app** (`:1308`). One line per B4 interaction span (`src/App.tsx:792`) plus one FCP. A `trace:`-prefixed signpost returns before the write. Growth is per session-switch, ~150 B/line. **[verified] unbounded in principle, slow in practice.** |
| `frame-stats.ndjson` | `src-tauri/src/commands.rs:1276-1297` | append-only, never rotated; one line per FPS-meter window, and the meter only runs while a capture is open (`src/fps.ts` → `feedStore.setFrameSampling` `:899-907`). **[verified] bounded by capture use, not by time.** |
| Terminal snapshots in localStorage | `src/components/TerminalView.tsx:108-128` | 200 serialized scrollback lines per **tab id**, unbounded in tab count — **Gap 3 above**. The live terminal itself keeps `scrollback: 3000` in xterm memory (`:104`), per mounted view, bounded by the 12-terminal cap. |

*Smallest fix for `paint.ndjson`/`frame-stats.ndjson`*: the same truncate-at-size guard
`diagnostics.rs:19-21` already uses. *Test*: write past the threshold, assert the file restarts.

---

## 6. Conclusions

### (a) Verified gaps worth a fix, smallest fix and test

| # | Gap | File:line | Smallest fix | Test |
|---|---|---|---|---|
| 7 | Peer delivery loop: three `continue` paths bypass the 24 h deadline; the owner-busy path issues a provider RPC every 100 ms, forever | `src-tauri/src/peers.rs:1493`, `:1509`, `:1521` vs `:1591` | Move the deadline check to the top of the loop; replace the two owner-busy polls with a wake on `peer_sessions::subscribe_activity()` | Fake time + stub busy owner: `native_control` call count bounded by activity edges, not by elapsed time |
| 4 | Webview reload strands every Rust-side JS listener registration; emit cost grows per reload | `tauri-2.11.5/src/event/listener.rs:63`, `:222-252` (no page-load clear) vs `src/App.tsx:271-301` et al. | Unlisten the webview's ids from an `on_page_load(Started)` hook, or move each concern to a replaced `Channel` as `sink.rs`/`terminal.rs` already do | Register, simulate page load, assert `has_js_listener` false; soak assertion 6c |
| 3 | `brigadier:terminal:<tabId>` localStorage snapshots are never removed on tab close; quota exhaustion silently disables all localStorage recovery | `src/components/TerminalView.tsx:108`, `:124`; only removal is `src/sessionLocalData.ts:41` | Remove the key wherever a tab leaves a layout, beside the existing `documentKey(tab)` removal (`ProjectWorkbench.tsx:145`, `:694`) | Open a terminal tab, write output, close it, assert the key is null |
| 1 | `deletedSessions`/`deletedProjects` never evicted; every later batch pays a spread + three `filter`s forever | `src/feedStore.ts:575-576`, `:581-586` | Evict a tombstone after the buffer has drained empty past the deletion | Delete a session, drain twice, assert `applyBatch` no longer rebuilds the batch |
| 8 | `useProviderCatalog` polls every 15 s forever when no CLI is installed, once **per mounted consumer** | `src/providerCatalog.ts:62`, `:93`; mounted at `Composer.tsx:86`, `NewSession.tsx:34`, `SessionPreferences.tsx:28` | Consolidate into one module store (the `workbenchStore.ts` shape); stop the poll after a bounded number of empty reads | Three mounts, one invoke per tick; empty catalogue stops polling after the budget |
| 5 | 5 s archive `setInterval` for the app's life, no visibility gate | `src/App.tsx:249-252` | Gate on `visibilitychange` as `workbenchStore.ts:173-180` does, or drop it now the event is subscribed first | Fake timers, hide the document, advance 30 s, assert no `syncArchive` |
| 6 | Archive retention task wakes every 60 s unconditionally, taking three global mutexes and two file reads per pass | `src-tauri/src/session_archive.rs:269-307` | Sleep to the next computed expiry instead of a fixed 60 s | Empty archive + fake time: one pass, then no disk read for an hour |
| 2 | Terminal shells and verify/gate children get no pid record, so a force-quit orphans them with no next-start recovery | `src-tauri/src/terminal.rs:361-394`, `crates/supervisor/src/verify.rs:349-352`; `track(` call sites are only `supervisor/lib.rs:1613`, `approval_policy.rs:205`, `commit_message.rs:163` | `tracker.track` after spawn under a namespaced id; `untrack` in `Terminal::drop` and at the end of `run_owned` | Extend `verify.rs:766`'s pattern: pid file exists during the run, gone after |
| — | One slow worker reply disables timestamp preparation permanently and silently | `src/timestampLabels.ts:109`, `:75-81` | Separate timeout from `onerror`; disable only after N consecutive timeouts | Worker stub answering at 1.2 s: next call still posts; three timeouts do disable |
| — | `firstPage` retains one resolved `HistoryPage` after the last transcript unmounts | `src/hooks/useConversationHistory.ts:38`, `:57-59` | Null the slot in `releaseFirstPage` once `claimed && released` | Mount, unmount, assert `firstPage` null |
| — | `paint.ndjson` / `frame-stats.ndjson` append-only with no size guard | `src-tauri/src/commands.rs:1288`, `:1326` | The truncate-at-size guard `diagnostics.rs:19-21` already uses | Write past the threshold, assert restart |

### (b) Already bounded — one line each

- `feedStore` row rings: `ROW_CAP + RING_SLACK` = 4,000 per ring, head-spliced (`:357-362`), snapshot copies trimmed to 2,000 (`:368-380`).
- `feedStore` `sessions`/`usageWindows`/`sessionDeltas`/`approvals`: all keyed by session id and all removed together in `dropSession` (`:1257-1263`) and `dropProject` (`:1285-1296`).
- `feedStore` `listeners` and `selectorListeners`: removed by the unsubscribe each subscribe returns (`:955`, `:992`).
- `feedStore` drain loop: armed only while there is work; an idle window wakes zero times (`:827-831`, `:869`).
- `workbenchStore`: one timer, one in-flight load, listeners and payload all dropped by `stop()` when the last consumer leaves (`:202-216`), and no timer at all while hidden (`:173-180`).
- `timestampLabels` label cache: hard cap 2,048 with FIFO eviction (`:41`); `pending`/`inFlight` drained by `finish` (`:67-73`).
- `sessionNavigation` parse cache: exactly two entries, invalidated by the raw string (`:29-37`).
- `useConversationHistory` `historyDelivery`: burn-build only, deleted on cleanup (`:139-144`, `:195`).
- `terminal.rs`: 12 terminals max (`:335`), 1 MiB ring each (`:43`, `:128-137`), one forwarder thread per stream that a second subscribe replaces rather than duplicates (`:158-168`).
- `terminal.rs` threads: reader ends at EOF (`:370-381`), waiter ends after `wait()` (`:382-386`), forwarder ends on `closed`/channel loss/exit frame (`:211-260`).
- `batcher.rs`: 2,000 rows and 2,000 signals per project with counted drops and a once-per-project warning (`:248-252`, `:265-288`); per-session counters and whole project entries pruned every tick (`:116-119`, `:351`).
- `batcher.rs` flusher: `Weak<Inner>` + `watch::Receiver` only, so it ends with the last `Batcher` and runs no timer while idle (`:390-410`).
- `sink.rs`: one feed channel, replaced on every `subscribe_feed`, never added to (`:38-40`).
- CLI process groups: `process_group(0)` at spawn (`process.rs:265`), `killpg` TERM→grace→KILL on terminate (`:316-340`), pid record written and swept with a kernel-start-time check that refuses a recycled pgid (`crates/proc/src/tracker.rs:78-113`, `sweep.rs:262-290`).
- Normal quit: idempotent two-arm shutdown with one shared grace period, terminals cleared, store flushed (`lib.rs:375-395`, `state.rs:150-192`).
- `caffeinate`: `-t 60 -w <our pid>` so it self-releases on a crash, and `Assertion::drop` kills **and** waits (`keep_awake.rs:72-77`, `:63-67`).
- `keep_awake` task: parks on a watch with no timer whenever nothing is held (`:130-168`).
- `composer` drain loop: edge-driven, one 60 s deadline only for an unreported provider reset (`:104`, `:131-157`).
- `desktopApi` cleanup snapshot: two retries then stop, cancelled by dispose and by the first event (`:183-206`).
- Session NDJSON: 16 MiB × 4 rotations, gzipped, deleted with the session (`crates/store/src/ndjson.rs:27-31`).
- `frontend-errors.ndjson`: truncated at 256 KiB with per-field caps (`diagnostics.rs:19-26`).
- Every provider/git/`lsof`/update subprocess outside the session path runs under an explicit `tokio::time::timeout`.

### (c) What a two-hour soak should assert, so P9 can run it

Sample every 60 s; compare the last 30 min against minutes 20–50 (post-warmup), not against t=0.

**Listener and task counts**
1. `window.__brigadier_listener_count` equivalent: assert the number of live Tauri JS listeners is
   flat. Without an app hook, drive it from Rust — expose `Listeners::has_js_listener`-adjacent
   counts behind `#[cfg(debug_assertions)]`, or count `listen`/`unlisten` calls in `src/bridge.ts`.
   **Must include at least one webview reload in the workload** (Gap 4 is invisible without one).
2. `feedStore` internals: `listeners.size`, `selectorListeners.size`, `sessions.size`,
   `sessionRows.size`, `usageWindows.size`, `sessionDeltas.size`, and — the one that will move —
   `deletedSessions.size`. Assert the first six are flat with session count and that the ring
   `buf.length` never exceeds 4,000.
3. `TerminalView.terminalTimers()` returns to 0 whenever every PTY is quiet for > 3 s.
4. `timestampLabels.getTimestampPreparation()`: `workerFailures` stays 0; `labels.size` never
   exceeds 2,048.
5. Rust task count: `tokio::runtime::Handle::metrics().num_alive_tasks()` (or a manual counter)
   flat between samples with the same number of live sessions.

**Memory**
6. App Rust-process RSS, WebKit `WebContent` RSS and each Worker's RSS sampled **separately** and
   reported separately — the plan's §6 forbids summing incomparable footprints. Assert each is flat
   (≤ 5% drift) over the last 30 minutes.
7. `localStorage` total bytes for the app origin: assert it does not grow monotonically across
   terminal tab open/close cycles (Gap 3).
8. `<data_dir>` total size, and `paint.ndjson` / `frame-stats.ndjson` line counts individually.

**Child pids**
9. `pgrep -P <app pid>` plus a walk of each tracked pgid: assert the set of live pgids equals the
   set of pid files in `<data_dir>/pids`, at every sample.
10. Count of live `claude`, `caffeinate`, `lsof`, `git` and shell processes owned by the user:
    assert `caffeinate` never exceeds 1, `lsof` never exceeds 1 per terminal, and that `git` and
    `claude --version` probes leave nothing behind between samples.
11. A deliberate force-quit at the end (`kill -9` the app), then: enumerate survivors, restart, and
    assert the startup sweep's `trace::stage("pid_sweep")` line reports `swept=N` matching the CLI
    sessions — and **record the terminal shells and any in-flight gate command that survive**, since
    §3 says they will. That number is the honest measure of Gap 2, and the plan's exit criterion
    explicitly asks for "explicit crash limitations" rather than a zero claim.

**Retry-loop attribution**
12. Count `native_control(Activity)` invocations for the whole run (a `tracing` counter is enough).
    With no peer completion pending it should be near zero; with one pending against a busy owner
    it will be ~10/s today (Gap 7) — that delta is the acceptance test for the fix.
13. Count `provider_catalog` invokes: on a machine with the CLI installed, a handful at launch and
    nothing after; on one without, today it is 4 per mounted consumer per minute (Gap 8).

### What was not checked

- Nothing was built, run, or measured. Every "growth" claim is read off constants and control flow.
- `src/composerApi.ts:44` and `src/taskSettings.ts:35` return a `listen` promise to their callers;
  those callers were not traced, so their disposal is **[hypothesis]**, not verified.
- The `caffeinate(8)` man page was not re-read; the `-w`/`-t` semantics are taken from the flags and
  the module's own comment (`keep_awake.rs:69-71`).
- Tauri's `Listeners` map was read at 2.11.5 in the local cargo registry; whether a *webview
  destroy* (as opposed to a reload) drains it was not traced — only that no page-load path does.
- No localStorage quota was measured; the WKWebView limit and the failure mode in Gap 3 are
  **[hypothesis]** from the swallowed `catch` at `TerminalView.tsx:126`.
- `crates/core/src/codex/*` was inventoried for spawns but its adapter's task lifetimes were not
  read line by line; Codex is deferred for v1 (`CLAUDE.md` §2).
- No heap delta was measured for the `RING_SLACK` tradeoff; `feedStore.ts:93-111` already marks its
  own retention arithmetic **[asserted]** and says so.
