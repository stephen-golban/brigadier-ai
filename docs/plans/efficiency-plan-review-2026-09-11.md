# Adversarial review: efficiency and rendering plan (2026-09-11)

Reviewed: `docs/plans/efficiency-and-rendering-plan-2026-09-11.md` against `main` at `95577c3` plus the unstaged
`crates/supervisor/src/batcher.rs` patch. Reviewer: Claude Fable 5.1 as lead, with six read-only subagents (batcher
audit with a throwaway worktree build, timer inventory, rendering audit, backend audit, external-source research,
research-note consistency). Every `file:line` below was reported by a subagent and the load-bearing ones were re-read
by the lead; each finding is tagged **verified** (read in source or docs) or **hypothesis**.

What was executed: `cargo test -p brigadier-supervisor` and `cargo clippy -p brigadier-supervisor --all-targets -- -D
warnings` in a scratch worktree, with and without the batcher patch. All four runs exit 0. Nothing else was built, run,
profiled or installed. The main checkout is untouched apart from one new research file,
`docs/research/efficiency-plan-external-facts-2026-09-11.md`, written by the research subagent per CLAUDE.md §1 rule 3.

Not checked: any runtime cost of any timer (no measurements taken); whether `Composer` and `SubagentsPanel` are mounted
during the burn; whether the 45 ms capture's binary matches `95577c3`; Tauri Channel ordering across its 8192-byte
size boundary (read from source, not measured); FSEvents event volume under a dependency install (no watcher built).

## Verdict in one paragraph

The plan is well-constrained and most of its polling claims are accurate, but it cannot close the handed-over
rendering hitch as written: P4 attacks steady-state fan-out while the misses cluster in the first three seconds, where
the source itself names a 286 KB lazy Markdown chunk as the stall candidate and P4 never mentions it. Its definition of
done accepts a "valid" capture, which a failing capture satisfies, and the 60 Hz zero-drop gate has never passed on
any build in this repository. Three packages (P3, P6 agent-side, P7 prompt half) audit seams that do not exist. The
largest idle frontend timer is absent from the inventory. The batcher patch is safe but regresses cadence and has zero
test coverage of the loop it introduces. Eleven blocking revisions follow, then nonblocking ones, owner questions, and a
revised order.

## Blocking revisions

### B1. Definition of done accepts a failing rendering capture — §9, P4 exit, §6 (verified)

- Plan line 195 closes P4 on "a valid rendering result"; line 353 closes the whole plan on "valid results". *Valid* is
  not *passing*. `src/fps.ts:222-227` requires `dropped === 0` in every one-second window for 60 windows.
- Every burn JSON under `docs/performance/2026-09-09`, `2026-09-10`, `2026-09-11` (24 files) has `summary.pass =
  false`. Best ever: `2026-09-10/ship-release-burn.json`, 2 dropped, worst 29 ms. `docs/STATUS.md` §4 records the
  same. The plan implies a pass is the bar and then defines done so a failure qualifies.
- `src/feedStore.ts:28-32` records measured 26–33 ms JSC GC frames; one such frame fails the gate on its own.
- **Failure scenario:** P9 installs a build with a "valid" 3-drop capture and the handoff obligation is marked closed.
- **Correction:** §9 must say either "the gate passes" or "the gate fails with N drops, the attributed cause, and a
  named blocker", and P9's install decision must state which of the two it requires. That is an owner decision (Q1).
- **Acceptance:** the final capture JSON's `summary.pass` is quoted in the release note verbatim.

### B2. P4 misattributes the cold hitch; the named candidate is absent — P0, P4 (verified)

- Misses in the two valid captures sit in windows 1–2 (`burn-full-feed.json`: 1 + 4; the `/tmp` shared-clock capture:
  1 + 3, plus one at window 52). Windows 1–2 are the first transcript mount because `src/components/Burn.tsx:87`
  starts sessions after capture opens.
- `src/components/Markdown.tsx:36-44`: "`./MarkdownContent` is a 286 KB built chunk; its fetch, parse and evaluation
  is a candidate for the stall on the first transcript mount." Rendered at `ThreadView.tsx:460` and `:570`. P4 does not
  mention it and a subscription refactor cannot touch it.
- `src/hooks/useConversationHistory.ts:77`: `JSON.stringify(old) === JSON.stringify(recorded)` over the full turns
  array on every history response, main thread; the same file records 534–544 responses per 63 s run.
- `useConversationHistory.ts:58-61`: the timestamp Worker result is awaited with `Promise.all` before the page is
  published, so Worker startup is on the critical path. P4 names this one.
- `ThreadView.tsx:330-331, 423`: first virtualizer measurement of every mounted row. P4 touches it only inside the
  conditional viewport experiment.
- Not candidates: no web fonts (`index.html` uses system stacks); Monaco and xterm load outside the measured path.
- **Correction:** split P4 into P4a (cold path) and P4b (subscription fan-out). P4a: after P0's trace, preload the
  Markdown chunk once the launch is idle and before any transcript exists (a module preload is production code, not
  hidden prewarming, but it must land after first contentful paint or it eats the 295 ms budget); replace the
  stringify comparison with a seq-range or identity comparison; decide from the trace whether label preparation may
  publish the page first and patch labels in. P4b stays as written.
- **Acceptance:** cold trace shows the `markdown-module` stamp resolving before the first transcript mount; startup p50
  unchanged; a visible capture with zero misses in windows 0–3.

**Measured update (2026-09-11, after the review):** `docs/performance/2026-09-11/cold-path-attribution.md` analysed the
six recovered diagnostic traces. The Markdown chunk is exculpated: `markdown-module` resolves 15–21 ms *after* the last
dropping frame in three of four traces, inside a frame that drops nothing. The cold hitch is two clusters. Cluster A at
about 1.0 s is a 29–31 ms shell mount frame (`Sidebar`/`ProjectWorkbench`/`Tabs`), one drop, in five of six captures;
that belongs to P4b. Cluster B at 2.3–2.5 s is two or three frames of 36–61 ms, three to five drops, in eight of eight
captures: the first transcript mount commit (`ThreadView→Transcript→TranscriptRuntime→AssistantRuntimeProvider`,
13 ms render + 7 ms commit), the first history round trip (`history-request` fires 3 ms after the commit ends, and the
first `turns` await is 17–34 ms against a steady-state mean of about 1 ms), and the `turns-response` merge. All eight
files predate the timestamp Worker (no `capture.timestampPreparation` key), so the labels-on-critical-path cost is
untested; HEAD added that await to a path already inside a dropping frame. P4a therefore targets, in order: publish the
page before labels resolve; start the history fetch in parallel with the mount; replace the stringify comparison; and
only then preload the Markdown chunk, as a demoted item worth one late frame. The late single-drop misses (25–28 ms) sit
in the measured JSC GC band and remain unproved.

### B3. The largest idle timer is missing from the inventory — P2, P5 (verified)

- `src/feedStore.ts:630-635`: `scheduleDrain()` arms a `requestAnimationFrame` and a 250 ms `setTimeout`; `drain()`
  re-arms unconditionally at `:577-579` after cancelling both. `store.start()` runs once at `src/App.tsx:329`. With zero
  sessions that is roughly 60 + 4 wakeups per second for the app's lifetime. Neither P2's table nor P5 lists it.
- The 250 ms fallback is deliberate (comment at `:631-633`: WKWebView pauses rAF when occluded; approvals must still
  catch up). Removing it outright would break approval delivery when occluded.
- `src-tauri/src/sink.rs:58` calls `peer_sessions::notify()` on every feed batch. Two always-on tasks select on
  that watch: `src-tauri/src/keep_awake.rs:117-120`, and the composer queue-drain loop at `src-tauri/src/composer.rs:108,129`
  (spawned at `lib.rs:345`), which takes a lock and scans state per batch. Keep-awake therefore wakes at batch rate
  during streaming and, when enabled, issues one `NativeControl::Activity` RPC per live session per pass (`:93-105`).
  This is the plan's own risk 2 already present. P5 frames it only as "the old activity poll".
- **Correction:** add both to P2/P5. Drain: arm only when the queue is non-empty; keep the 250 ms fallback only while
  something is pending. Keep-awake: subscribe to an activity-transition edge, not the batch notify.
- **Acceptance:** with the store started and no sessions, a test hook counts zero drain wakeups over 10 s; an occluded
  window still receives an approval within 250 ms of its arrival.

### B4. Listen-after-fetch is the current code in three places, and the framework does not cover it — P2 (verified)

- `src/App.tsx:393-398`: `void refresh()` then `listen("archive-changed")`; `src/peerApi.ts:94-95` and
  `src/providerCatalog.ts:70-75` have the same order. `listen` is itself async. Today the 5 s / 30 s / 15 s polls hide
  the lost-event window; removing them without reordering reopens it.
- Tauri v2 documents nothing about events emitted before a listener registers: no buffering, no replay (research file
  §3). Plan invariant 1 is right and has no framework support.
- Tauri `Channel::send` routes payloads above 8192 B through an unbounded `ChannelDataIpcQueue`; queued data can be
  lost on Rust-side drop. Relevant to P1 frame splitting and P5's terminal stream.
- The feed already does it right: `src/App.tsx:330` subscribes before the snapshot; `batcher.rs:315-320` subscribes
  then marks changed if anything is pending. Use that shape.
- **Correction:** make "await listener readiness, then fetch, then reconcile" the first step of every P2 row, before
  any poll is removed. Add a P5 note that terminal frames must stay under the 8192 B eval path or accept the queue.
- **Acceptance:** a test emits between the fetch resolving and the listener registering; the UI shows the new state
  without a poll.

### B5. P3 is net-new, and notify 8.2.0 does not do what P3 assumes — P3 (verified, research file §1)

- `notify` is not in `Cargo.lock`; there is no watcher in `src-tauri/` or `crates/`. P3 is a new dependency and a new
  subsystem, not a refactor. Adding it is an owner decision (Q2).
- notify 8.2.0 on macOS uses FSEvents and never calls `FSEventStreamSetExclusionPaths`; excluding `node_modules` or
  `target` is post-hoc callback filtering only. P3 line 163 already suspects this; it is confirmed.
- notify 8.2.0 never passes `kFSEventStreamCreateFlagWatchRoot`, so a renamed or deleted watched root emits nothing;
  P3's "root rename/delete" handling has no signal to hook. Fixed only on the 9.0.0 release candidate.
- Latency is hardcoded to 0 with `NoDefer`; there is no OS coalescing window. Every storm arrives raw.
- Apple documents `MustScanSubDirs` as requiring a rescan of every path on the stream, not one root. P3's "invalidate
  the affected cache" is wrong; the whole stream is affected.
- `.git/index.lock`, `ORIG_HEAD` and `packed-refs` writes are reported (FileEvents flag); no documented ignore advice.
- The throughput note recommended Git's fsmonitor (`agent-throughput-efficiency-2026-09-11.md:13`) and the plan dropped
  it. Worktree discovery already uses `--git-common-dir` correctly (`crates/core/src/worktree.rs:645-660, 830-840`);
  `git rev-parse --git-path <name>` resolves per-worktree versus common paths automatically.
- **Correction:** P3 becomes a spike with a decision gate: measure raw FSEvents volume during `npm install` in a
  watched root with post-hoc filtering, and compare with fsmonitor or a bounded status poll for Git freshness. Only
  after the numbers does the owner decide on the dependency.
- **Acceptance:** spike report with event counts per second, CPU-seconds of the filter, and the rescan policy.

### B6. Nine checkpoint commits with gates "applicable to that checkpoint" break the six-gate rule — §7, P9 (verified)

- Plan line 257: complete gates "once at final integration"; line 327: nine commit boundaries with "gates applicable to
  that checkpoint". CLAUDE.md §4: all six gates green before every commit. Eight commits would ship without them.
- **Correction:** either all six gates at every commit boundary, or fewer and larger commits. Owner decision (Q3).

### B7. The batcher patch is safe but not acceptable as-is — P1 (verified, tested)

- No lost wakeup, no retained sender, no lock-order issue, correct subscribe-then-check startup; tokio 1.53.1 has every
  API used. Test and clippy exit 0 with and without the patch.
- Cadence regression: old `interval` with `MissedTickBehavior::Delay` fires every `interval` regardless of flush time;
  the patch sleeps then flushes, so sustained period is `interval + flush`. First-event latency after idle goes from a
  mean of `interval/2` to always `interval`. The doc comment at `batcher.rs:309` ("Flush within `interval`") is false in
  the worst case. The plan's "sleep-after-flush" (line 120) names code that is not there; it is sleep-before-flush.
- Zero coverage: no test calls `spawn_flusher` (sole caller `crates/supervisor/src/lib.rs:463`); all 13 batcher tests
  are sync and call `flush_once`. The only cadence instrument, `crates/supervisor/tests/flood_baseline.rs`, is
  `#[ignore]`d at `:137`. The green suite proves nothing about the loop.
- `batcher.rs:236-238` pops the oldest signal at `PROJECT_SIGNAL_CAP` with no counter, unlike rows (`:221`). Signals
  drop silently. P1 asks for this guarantee and does not name the site.
- The `#[cfg(test)] flushes` counter is written and never read. Clippy passes because a field access counts as a use,
  but P1's exit text calling it "purposeful" is false until a test reads it.
- The visibility filter lives in `push`, not `flush_once`, so `set_visible_projects` needs no wake today. That is
  undocumented and breaks silently if the filter ever moves.
- P1 changes the "16 ms tick in Rust" line at `docs/plans/ipc-contract.md:57` and does not own that file. The contract
  also fixes the 8000-byte assert and the 24-row split (`:58-59`); P1's test list omits splitting.
- **Correction:** anchor the sleep to a deadline set after the previous flush (`sleep_until(last_flush + interval)`),
  which restores the period and makes the first row after idle go out immediately; count signal drops; fix the doc
  comment; document the no-wake invariant at `:247`; add loop tests under `#[tokio::test(start_paused = true)]`
  (`test-util` is already a dev-dependency); add the contract file to P1's owned files.
- **Acceptance:** paused-clock tests for data-before-subscribe, push-during-drain, sustained period equal to
  `interval`, last-owner drop terminates the task, no flush while idle; un-ignore or replicate the flood baseline's
  p100 latency check.

### B8. P6 agent-side reuse and P7's prompt half audit seams that do not exist — P6, P7 (verified)

- `crates/core/src/claude/adapter.rs:418-423` sends `InitializeRequest { hooks, ..Default::default() }`. No
  `--append-system-prompt` in argv, no prompt assembly anywhere. There is nothing to audit for "unnecessary mutations
  to stable instructions".
- `src-tauri/src/peer_mcp.rs:36-114` is a real app-owned MCP server with 14 orchestration tools and no read, grep or
  search tool; it is injected only when the peer token is set (`process.rs:162-163`) and `--strict-mcp-config` is the
  default. Native Grep would not route to it anyway (research file §5). P6's "existing app-owned tool path" has
  transport and no tool; its escape hatch is the only reachable outcome, so close it now rather than after an
  experiment.
- The `q.paths` post-filter claim is literally true (`src-tauri/src/search.rs:229` inside the walk at `:198-207`),
  but `paths` is populated from one place, `src/vscode-panels/workspace.ts:189`, the "only open editors" toggle. The
  win is real and small.
- `--bare` exists in CLI 2.1.268 but never reads OAuth or the keychain and needs an API key. Rule it out on the
  subscription-only decision, not on startup cost.
- The verify seam P7 hedges about is real and stronger than assumed: `crates/supervisor/src/verify.rs` runs the phase
  gate with true exit codes, a pipefail probe, PATH resolution and process-group timeout kill, consumed by
  `crates/supervisor/src/loop_/green.rs:44,80-86`. P7 should audit that and nothing else.
- Provider telemetry is already parsed (`adapter.rs:2164-2165`, `claude-wire/src/message.rs:81-82`). Two traps: the
  CLI's per-step `usage` excludes subagents (use the result message's `modelUsage`), and `unifiedWindows` appears in no
  public doc; it is an unversioned surface this repo depends on.
- **Correction:** delete P7's prompt-construction paragraph; reduce P6 to the `q.paths` visit plus in-flight
  deduplication and close agent-side reuse with the citation above; keep P7 as a `verify.rs` audit plus telemetry.

### B9. Two P5 "preserve" items are new behaviour, and "cleanup polling" is misdescribed — P2, P5 (verified)

- `src/components/TerminalView.tsx:117-121`: remount restores the snapshot and prints "Restored output. Starting a
  fresh shell." The plan's "a hidden terminal must retain its process" is a feature request, not preservation.
  Owner decision (Q4).
- Delivery today is a polled command, `terminal_read` at `src-tauri/src/terminal.rs:299-312`, re-armed at 0 ms on a
  full 8192-byte read and 50 ms otherwise (`TerminalView.tsx:157-160`). The Channel pattern P5 wants already exists
  for the feed (`src-tauri/src/sink.rs:14-50`, `src/bridge.ts:231,287`).
- CWD is `lsof -a -p <pid> -d cwd` per call with a 2 s timeout (`terminal.rs:374-390`). P5's caution is right.
- "Cleanup polling" is a frontend 2 s recursive timeout (`src/desktopApi.ts:174`, armed for the app's lifetime at
  `App.tsx:1082`) against a backend worker that drains a queue and returns, emitting nothing
  (`src-tauri/src/cleanup.rs:136-190`). The fix is a job-transition event plus removing the timer; the table's wording
  suggests a backend poll that does not exist.

### B10. The third approval state is missing from the comparator invariant — §4 invariant 5 (verified)

- `docs/plans/ipc-contract.md:618-622`: a resolved row with no decision is a third state, `Expired`. CLAUDE.md §5
  lists it as a landmine. The word does not appear in the plan. Invariant 5 enumerates comparator hazards without it.
- **Correction:** add "resolved-without-decision" to invariant 5 and to P4's approval test list.

### B11. The headline number lives in `/tmp`, and no capture records its source — §2, P0 (verified)

- The 45 ms / 5-miss capture is `/tmp/brigadier-release-20260911/burn-shared-clock.json`, not in the tree. It exists
  today. `docs/performance/2026-09-11/burn-full-feed.json` is the 55 ms capture, visible, misses in windows 1–2 only.
- No burn JSON carries a source hash or dirty-tree flag; only `timestamp-fix-manifest.json` does. Binding capture to
  revision rests on git add-time.
- `scripts/measure-native-burn.py:26` calls `2026-09-10/live-history-release-burn-1.json` "the recorded passing run";
  that file's rendering summary is `pass: false, dropped: 3`. The comment means delivery bins, and misleads.
- **Correction:** P0 copies the shared-clock capture into `docs/performance/2026-09-11/` and the burn runner stamps
  `git rev-parse HEAD`, dirty state and build flags into every JSON. Fix the script comment.

## Nonblocking improvements

- **Three whole-snapshot subscribers, not one.** `src/components/Composer.tsx:57` and `SubagentsPanel.tsx:30` use
  `useSyncExternalStore(feed.subscribe, feed.getState)` alongside `App.tsx:194`. `rebuildState()` at
  `feedStore.ts:545-561` allocates a fresh root object each rebuild, so none can bail. `Sidebar` is not memoised
  (`Sidebar.tsx:165`). P4b must list all three.
- **Keyed listeners need a new store API.** `feedStore.ts:658` exposes one global `subscribe` over one `Set`; `notify()`
  at `:637-639` calls every listener. P4b is a store change, not a call-site change; size it that way.
- **Unlisted timers** (add to the P2 exit inventory): `src-tauri/src/session_archive.rs:306` 60 s retention sweep,
  always on; `src/components/SessionContext.tsx:38` 8 s / 30 s; `src/components/AgentsPanel.tsx:65` 2 s per open
  subagent; `crates/core/src/codex/adapter.rs:205` 100 ms per live Codex session; `src/Launch.tsx:79` 150 ms
  self-terminating; `src/components/CosmicField.tsx:177` rAF. Legitimate deadline timers to keep and document:
  `src-tauri/src/approval_policy.rs:158` (250 ms, bounded by a 90 s deadline), `src-tauri/src/peer_sessions.rs:273`.
- **Rows the table overstates.** Run refresh (`App.tsx:978`) runs only while a run is live and
  `docs/plans/ipc-contract.md:679-683` already diagnoses it; cite that. The catalogue poll stops itself once settled
  (`providerCatalog.ts:53,66`) and only runs forever with no CLI installed. The peer poll is already covered for every
  persisted mutation (`src-tauri/src/peers.rs:220`); what remains uncovered is live activity folded into the snapshot
  (`peer_sessions.rs:118-132`), a hypothesis worth one measurement.
- **Session changes timer is mounted three times per session** (`ThreadView.tsx:231`, `SessionCard.tsx:23`,
  `SessionReview.tsx:161`); a shared per-session snapshot removes two of them before any event work.
- **`archive-changed` has two emitters** (`session_archive.rs:299`, `peers.rs:1394`) and none of the four UI commands
  emit; the window self-publishes. A second window or a CLI-origin change is uncovered. This is the concrete gap P2
  should name.
- **Recommendations the notes made and the plan dropped:** empty and zero-sized view regression tests
  (`agent-resource-complaints-other-2026-09-11.md:9`); thermal-state reporting (`local-resource-control-2026-09-11.md:15,
  60`); a direct-CLI comparison arm on battery and AC (`:54`); Git fsmonitor (`agent-throughput-efficiency-2026-09-11.md:13`).
- **Term collision.** The contract uses `revision` for `RunView.revision` and `epoch` for Unix milliseconds; invariant
  2 redefines both. Pick new names before they hit the wire.
- **Owner worktree rule.** P0 says "task-owned checkout". The owner's standing rule is a fresh worktree on a branch for
  every run, never the main checkout; say so explicitly.
- **Trim.** §1 lines 13–21, §4 invariants, §8 and §10 restate constraints the packages already carry; roughly 90 lines
  can go without losing an instruction. Keep the P2 table, P1 test list, P3 rescan rules, P4 split, §6 workloads.
- **Stale statements to fix while here.** `docs/STATUS.md` "every burn number is a debug build" is stale; the 2026-09-11
  captures are release builds with `VITE_BURN=1`.

## Decisions taken by the lead (2026-09-11)

The owner sets direction, not these. Each is decided from `docs/vision.md`, `docs/STATUS.md` and CLAUDE.md and binds
the implementing sessions.

1. **Gate policy.** The installed app is replaced only when the 60 Hz gate passes, or when every remaining miss is
   attributed by the cold trace to a JSC GC pause and nothing else. In the second case the release note quotes
   `summary.pass`, the drop count and the trace line, and the hitch stays marked open. Any other residual is a release
   blocker. Reason: the gate is the project's own bar and a GC pause is the one cost the source has already measured.
2. **`notify`.** Not added. P3 is a spike only: measure FSEvents volume during `npm install` under a watched root with
   post-hoc filtering, and check the installed Git for fsmonitor support. Git freshness meanwhile stays on a bounded
   poll that arms only while the workbench is visible and a worktree is dirty or a session is live. The lead decides
   from the spike numbers whether the dependency ever lands. Reason: a dependency with no OS-level exclusion and no
   root-change detection is a new subsystem, not a timer removal.
3. **Commits.** Five, each with all six gates green: P0+P1; P4a+P2; P4b+P5; P3 spike + P6; P7+P8+P9. Never a commit
   with a partial gate set. Reason: CLAUDE.md §4 is not negotiable per checkpoint.
4. **Hidden terminal.** Out of scope. Current restore-then-fresh-shell behaviour is preserved and tested as is. Reason:
   it is a feature, not an efficiency fix, and nothing in the handoff asked for it.
5. **Live provider spend.** None for throughput comparisons. Fixture replay only; the throughput row of the matrix is
   replay-attributed. Reason: usage windows are the owner's currency and a live run proves a small gain poorly.
6. **Artifact cleanup.** Deferred out of this effort entirely. No deletion from the old `/tmp` manifest; a fresh
   re-audit becomes its own order after P9 lands. Reason: it shares no code with any package and only carries risk.

## Revised execution order

1. **P0** as written, plus: copy the `/tmp` shared-clock capture into the tree, stamp source hash and dirty state into
   every burn JSON, run the cold trace, and take the timer inventory from this review's list rather than building one.
2. **P1** with the deadline-anchored sleep, signal-drop counter, loop tests on a paused clock, and the contract line.
3. **P4a cold path** (Markdown chunk, stringify comparison, Worker on the critical path), measured against the same
   cold-open event. This is the handoff obligation and P0's trace points here; it should not wait behind P2.
4. **P2** starting with listener-before-fetch in the three named files, then the idle drain loop, then the shared
   workbench store and the cleanup event. Peer and catalogue rows last; they are mostly covered.
5. **P4b** keyed store subscriptions across all three whole-snapshot consumers.
6. **P5** terminal Channel, keep-awake edge, timer list. Hidden-terminal retention only if Q4 says yes.
7. **P3 spike**, then the owner's Q2 decision, then P3 proper or a documented bounded poll.
8. **P6** `q.paths` visit and in-flight deduplication; agent-side reuse closed by citation.
9. **P7** as a `verify.rs` and telemetry audit; **P8** as written.
10. **P9** with the §9 wording fixed per Q1.
