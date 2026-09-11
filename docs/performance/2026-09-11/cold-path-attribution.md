# Cold-path attribution — the first-transcript rendering hitch (2026-09-11)

What this is: an attribution of the first-transcript hitch from the diagnostic traces already in the tree, for the
implementer of **P4a**. Ordered by `docs/plans/efficiency-plan-review-2026-09-11.md` **B2** (the hitch is
misattributed), with **B1** (a failing capture is not a pass) and **B11** (no capture records its source) as
constraints. Provenance for the files is `docs/performance/2026-09-11/baseline-manifest.md`.

Nothing was built, run or installed for this file. Every number is extracted programmatically from a JSON already in
the tree, by a throwaway Python script; every claim is marked **[measured]**, **[derived]** (computed from two
measured fields) or **[asserted]** (read off source, not seen in a trace).

**Bottom line.** The cold hitch is **the first transcript mount commit and the first history round trip**, not the
Markdown chunk. `markdown-module` resolves **15–21 ms after the last dropping frame** in three of four usable traces
and lands in a frame that drops **zero** vsyncs. The Worker/labels hypothesis is **untestable from these files**: the
Worker did not exist in any traced binary.

---

## 1. Method

### What produces the numbers

| Producer | What it writes |
|---|---|
| `src/perfDiagnostics.ts:50-54` | `traceEvent(kind, detail)` → `{t: performance.now(), k, d}`, appended to `diagnostics.trace`. Inert unless `VITE_REACT_PROFILE === "1"` (`:4`) **and** a capture is open. |
| `src/fps.ts:93` | `traceEvent("frame", dt)` once per sampled rAF callback — `t` is the callback's `performance.now()`, `d` the interval since the previous one. This is the rAF interval series, on the same clock as every other stamp. |
| `src/hooks/useConversationHistory.ts:50,53,57,62` | `history-request` / `history-response` / `turns-request` / `turns-response`, either side of each awaited invoke. |
| `src/components/Markdown.tsx:41-45` | `markdown-module`, in the `.then` of the `lazy(() => import("./MarkdownContent"))` — i.e. after fetch **and** parse **and** evaluate. |
| `src/feedStore.ts:588,590,606,609,626` | `drain` (`d` = rows drained this frame), `notify` (`d` = listener count), and `markRenderUpdate()`. |
| `src/perfDiagnostics.ts:66-81` | `render-update`: a `MessageChannel` macrotask posted from inside the rAF callback; `d` is "everything the engine did after our callback returned" — the file marks that **[asserted]**, not measured, and it cannot be split into layout vs an interleaved task. |
| `src/perfDiagnostics.ts:25-40` | React scheduler spans, by intercepting `console.timeStamp` — `Render` / `Commit` on the `scheduler` track, plus per-component `Components ⚛` aggregates. |
| `src/components/Burn.tsx:43,44,69` | `resetDiagnostics()` then `fps.startCapture()` at run start; `getDiagnostics()` into `capture.diagnostics` at the end. Sessions start **after** the capture opens (`:48`), so windows 0–3 are the cold path. |
| `scripts/measure-native-profile.py` | Wraps `measure-native-burn.py` and additionally runs `/usr/bin/sample` against the WebContent pid, writing `<label>-attribution.json` and `<label>-sample.txt`. **Neither of those files is in this tree** — only the burn JSON is. The native sample that would have named a GC symbol is not available. |

### Schema found in the capture files **[measured]**

Top level: `activation_exit, capture, console_locked_after, delivery_audit, pass, pid, producer_delivery,
sleep_assertion_alive`. **No `source` field in any of the eight** — B11 holds.

`capture`: `clockOffsetMs, delivery, diagnostics, finalVisibility, idleWindow, initialVisibility, profiling, summary,
supportedEntryTypes, userAgent, windows, workload`.

`capture.windows[i]`: `window_start_ms` (wall-clock `Date.now()` at window open), `intervals_ms` (every raw rAF
interval in the window), `frames, dropped, p50_ms, p95_ms, p99_ms, worst_ms, longest_drop_run, dom_nodes, hidden,
focused, interrupted, drain_worst_ms`.

`capture.diagnostics`: `timeOriginMs, spans, renders, components, counters, trace, traceDropped, resources`. There are
**no** long-task, GC, layout or paint entries — `PerformanceObserver.supportedEntryTypes` in this WebKit carries no
`longtask`, no `long-animation-frame`, no `element` (`src/paint.ts:21-24`, marked measured there), and
`diagnostics.resources` is **empty (0 entries) in all five traced files**, so no chunk fetch or parse duration is
recorded anywhere.

### Clock alignment **[derived]**

`resetDiagnostics()` and `fps.startCapture()` run in the same tick (`Burn.tsx:43-44`), so trace `t` and the window
series share one origin. Capture start in `performance.now()` terms is
`windows[0].window_start_ms − diagnostics.timeOriginMs`. Every "rel ms" below is relative to that. Where a trace
exists, the rAF series is taken from the `frame` entries directly; where it does not, it is rebuilt from
`window_start_ms + cumsum(intervals_ms)`. The two agree to ±1 ms where both exist.

"Dropped" uses the gate's own rule, `src/fps.ts:120`: `max(0, round(dt / 16.67) − 1)`. A 24 ms frame is late and
drops **nothing**; a 26 ms frame drops one.

### Which binary produced which file — two content-derived discriminators **[derived]**

No capture stamps its source, so provenance is reconstructed from the files themselves and cross-checked against
`baseline-manifest.md`:

- `markdown-module` exists in all five traced files. That stamp was added in **915debf**
  (`git log -- src/components/Markdown.tsx`). So every traced binary is **≥ 915debf**.
- `capture.timestampPreparation` is written by `Burn.tsx:70`, added in **95577c3** (HEAD). The key is **absent** from
  all five traced files, from `burn-shared-clock.json`, from `burn-full-feed.json`, from `floating-profile.json`,
  `burn-raised.json` and `burn-quiet-session.json`. It is **present only in `burn-worker-labels.json`**
  (`{workerLabels: 1, synchronousLabels: 0, workerFailures: 0}`). So every traced binary and both acceptance captures
  are **< 95577c3**.

**Consequence:** every capture analysed here was produced by a binary at or about **915debf**, before the timestamp
Worker landed. At 915debf, `useConversationHistory`'s line between `turns-request` and `turns-response` was a bare
`await workspaceApi.chatTurns(...)` — verified with `git show 915debf:src/hooks/useConversationHistory.ts`. There was
no `Promise.all`, no `prepareTimestampLabels`. The only capture from a Worker-carrying binary,
`burn-worker-labels.json`, is invalid for rendering (hidden → hidden, 3 369 dropped, 9 windows).

---

## 2. Per-file timelines

Rel ms from capture start. "Dropping interval" = an rAF interval that missed ≥ 1 vsync by the gate's own rule. The
five key stamps are the **first** occurrence of each, which is the first transcript mount.

### Valid captures (visible throughout, not interrupted, 64 windows)

#### `cold-six.json` — traced, 6 dropped, worst 61 ms

| rel ms | event | detail |
|---|---|---|
| 1047 | **dropping interval** dt 30 ms, window 1 | 1 dropped |
| 2344 | `history-request` | inside the frame `[2301, 2347]` |
| 2347 | **dropping interval** dt 46 ms, window 2 | 2 dropped |
| 2363 | `history-response` (d=2) / `turns-request` (d=2) | inside `[2347, 2408]` |
| 2380 | `turns-response` (d=1) | inside `[2347, 2408]` |
| 2408 | **dropping interval** dt 61 ms, window 2 | 3 dropped |
| 2423 | `markdown-module` | frame `[2409, 2433]`, dt 24 ms, **0 dropped** |
| — | no further dropping interval in 63 s | |

#### `profile-before.json` — traced for the full 63 s, 3 dropped, worst 41 ms

| rel ms | event | detail |
|---|---|---|
| (none) | no window-1 miss; worst interval in `[900, 1200]` is 18 ms | |
| 2329 | `history-request` | inside `[2303, 2339]` |
| 2338 | `history-response` (d=3) / `turns-request` (d=3) | inside `[2303, 2339]` |
| 2340 | **dropping interval** dt 36 ms, window 2 | 1 dropped |
| 2360 | `turns-response` (d=0) | inside `[2340, 2381]` |
| 2381 | **dropping interval** dt 41 ms, window 2 | 1 dropped |
| 2399 | `markdown-module` | frame `[2380, 2401]`, dt 21 ms, **0 dropped** |
| 41111 | **dropping interval** dt 26 ms, window 40 | 1 dropped — see §4 |

#### `profile-fresh-six.json` — traced for the first 6.0 s only, 6 dropped, worst 52 ms

| rel ms | event | detail |
|---|---|---|
| 1033 | **dropping interval** dt 30 ms, window 1 | 1 dropped |
| 2286 | `history-request` | inside `[2253, 2296]` |
| 2294 | `history-response` (d=2) / `turns-request` (d=2) | inside `[2253, 2296]` |
| 2296 | **dropping interval** dt 43 ms, window 2 | 2 dropped |
| 2327 | `turns-response` (d=1) | inside `[2295, 2347]` |
| 2348 | **dropping interval** dt 52 ms, window 2 | 2 dropped |
| 2369 | `markdown-module` | frame `[2347, 2371]`, dt 24 ms, **0 dropped** |
| 31811 | **dropping interval** dt 25 ms, window 31 | 1 dropped — trace already ended, unattributable |

#### `floating-profile.json` — `diagnostics` is `{exportError: "burn capture exceeds 2 MB"}`, no trace. 6 dropped

| rel ms | dt | window | dropped |
|---|---|---|---|
| 1052 | 31 | 1 | 1 |
| 2410 | 38 | 2 | 1 |
| 2460 | 50 | 2 | 2 |
| 54433 | 28 | 54 | 1 |
| 59833 | 27 | 59 | 1 |

#### `burn-shared-clock.json` — the 45 ms headline capture, **no diagnostics**. 5 dropped

| rel ms | dt | window | dropped |
|---|---|---|---|
| 1032 | 29 | 1 | 1 |
| 2277 | 41 | 2 | 1 |
| 2322 | 45 | 2 | 2 |
| 53045 | 27 | **52** | 1 |

#### `burn-full-feed.json` — the 55 ms capture, **no diagnostics**. 5 dropped

| rel ms | dt | window | dropped |
|---|---|---|---|
| 1047 | 30 | 1 | 1 |
| 2345 | 45 | 2 | 2 |
| 2400 | 55 | 2 | 2 |

### Invalid captures — stamps usable for ordering, interval numbers are not rendering results

#### `profile-current.json` — went hidden at ~42 s; 31 windows, 2 028 dropped

| rel ms | event | detail |
|---|---|---|
| 1049 | dropping interval dt 45 ms, window 1 | 2 dropped |
| 2254 | `history-request` | inside `[2220, 2267]` |
| 2266 | `history-response` / `turns-request` | inside `[2220, 2267]` |
| 2267 | dropping interval dt 47 ms, window 2 | 2 dropped |
| 2300 | `turns-response` | inside `[2266, 2324]` |
| 2325 | dropping interval dt 58 ms, window 2 | 2 dropped |
| 2346 | `markdown-module` | frame `[2324, 2350]`, dt 26 ms, **1 dropped** — the only file where it is |
| 2351 | dropping interval dt 26 ms, window 2 | 1 dropped |
| 42284 / 63460 | 14 862 ms / 18 853 ms | window hidden; rAF suspended, not a frame |

#### `cold-profile.json` — hidden → hidden throughout; 5 windows, 3 621 dropped

rAF is suspended for a hidden window, so window 0 is a single 17 382 ms "interval" and there are only 184 samples in
63 s. The stamps still land on the same clock and in the same order — `history-request` 2155, `history-response`
2165, `turns-request` 2165, `turns-response` 2183, `markdown-module` 2215 — which corroborates the ordering below,
and nothing else.

---

## 3. Attribution verdict

### Two clusters, not one

**Cluster A — window 1, rel 1032–1052, one interval of 29–31 ms, 1 dropped vsync.** Present in **5 of 6 valid
captures** (absent in `profile-before.json`). **No history, turns or markdown stamp is anywhere near it** — the
earliest is `history-request` at 2254–2344, i.e. **+1 210 to +1 300 ms later**. The React spans immediately inside
and before it name the shell, not the transcript: in `cold-six.json`, `Render` 1019→1021 and 1022→1026 over
`App / SidebarProvider / Sidebar / SidebarContent / SidebarGroup`, then `Render` 1030→1034 + `Commit` 1034→1037 over
`App / SidebarInset / ProjectWorkbench / Root / Tabs$1 / CompositeList`. Drain rows in that frame are 6 and 10 — the
feed is idle. **[measured]** Cluster A is the **workbench/sidebar shell mount**. It is not the transcript and P4a as
scoped does not touch it.

**Cluster B — window 2, rel 2267–2460, two or three consecutive intervals of 36–61 ms, 3–5 dropped vsyncs.** Present
in **8 of 8** captures, valid and invalid. This is the first transcript mount, and it is the hitch.

### What is inside Cluster B, in order **[measured]**

Taking `cold-six.json` as the clearest, with the other traces agreeing to within ±40 ms on every offset:

| rel ms | What the trace and spans show |
|---|---|
| 2321 → 2334 | `Render` 13 ms: `App → SidebarInset → ProjectWorkbench → Tabs$1 → ThreadView` (2324→2332, 8 ms) `→ Transcript` (8 ms) `→ TranscriptRuntime` (7 ms) `→ AssistantRuntimeProviderImpl` (5 ms) `→ Thread / ThreadPrimitive.Root / ChatPanel` (2 ms) |
| 2334 → 2341 | `Commit` 7 ms |
| 2344 | `history-request` — the hook's effect fires at the end of that commit |
| **2347** | **frame ends: 46 ms interval, 2 dropped.** The 36 ms from the last `render-update` (2308) to `history-request` (2344) carries no stamp: it is that mount render + commit |
| 2363 | `history-response` (+19 ms IPC), `turns-request` same ms |
| 2380 | `turns-response` (**+17 ms**) |
| 2380 → 2392 | `Render` 12 ms, `Transcript` 2380→2391 (11 ms) — the `setItems` commit |
| 2392 → 2396 | `Commit` 4 ms |
| 2402 | `render-update` **d = 55 ms** — post-callback engine work (style/layout/paint **plus** anything interleaved; `perfDiagnostics.ts:56-60` says this cannot be split) |
| **2408** | **frame ends: 61 ms interval, 3 dropped** |
| 2423 | `markdown-module`, in a 24 ms frame, **0 dropped** |
| 2433 onwards | frames back to 24, 15, 13, 14, 12, 16 ms |

### Candidate-by-candidate, with the measured delta

| Candidate | Consistent across files? | Strongest measured delta |
|---|---|---|
| **First transcript mount commit** (`ThreadView` → `Transcript` → `TranscriptRuntime` → `AssistantRuntimeProvider`) | **Yes — 4 of 4 traced files.** `history-request` falls **inside** a dropping frame in every one | `cold-six`: the frame ending 2347 is 46 ms / 2 dropped, and 36 ms of it is unstamped mount work (last `render-update` 2308 → `history-request` 2344). React spans put `Render` 13 ms + `Commit` 7 ms inside it |
| **`turns-response` / history merge** | **Yes — 4 of 4.** `turns-response` falls **inside** a dropping frame in every one | `cold-six`: inside the 61 ms / 3-dropped frame `[2347, 2408]`, which also carries `Transcript` `Render` 12 ms + `Commit` 4 ms and a 55 ms `render-update` |
| **The `turns` await itself** | **Yes — 5 of 5.** First wait 17 / 22 / 33 / 34 / 18 ms against a steady-state mean of 1.03 / 0.98 / 0.67 / 0.91 / 0.99 ms and a post-first maximum of 3 ms | `profile-current`: **+34 ms** on the first call, **34×** the run's mean. On these binaries this is a cold `chatTurns` invoke **alone** — no Worker existed |
| **Worker / labels wait** | **Not testable.** `prepareTimestampLabels` landed at 95577c3; every traced binary is < 95577c3 | — (see §4) |
| **`markdown-module` resolution** | **No — inconsistent, and mostly exculpatory.** It resolves **after** the last dropping frame in 3 of 4 traced files | `cold-six` **+15 ms after**, `profile-before` **+18 ms after**, `profile-fresh-six` **+21 ms after**, each in a frame of 21–24 ms that drops **0**. Only `profile-current` (an invalid capture) puts it inside a 26 ms / 1-dropped frame, a **−5 ms** delta |
| **First virtualizer measurement** | **Cannot be separated.** `ThreadView.tsx:329` gates virtualisation on `rows.length > 60 && !hasApprovals`; `dom_nodes` peaks at 469–616 in these captures, so the fixture's transcript is under the threshold and the virtualizer is `enabled: false`. Its `measureElement` (`:423`) is therefore not in these traces at all | — |
| **Feed drain volume** | **Ruled out.** Drain rows per frame are steady at 21–28 through the whole approach to the cluster, then spike to 78 / 115 / 118 **at and after** the long frames. 61 ms at the fixture's 1 707 rows/s is ~104 rows — the spike is the backlog the stall created | **[derived]** |

**Verdict.** The dominant, reproducible cold hitch is the **first transcript mount commit and the first history
round trip that immediately follows it** — one 36–47 ms frame for the mount, one 41–61 ms frame for the response,
merge, `turns` await and `setItems` commit. B2 is right that P4's subscription refactor cannot touch it, and right
that P4a is the correct split. B2's **named** candidate, the 286 KB Markdown chunk, is **measurably not the stall**:
it resolves after the dropping frames and its own frame drops nothing in three of four traces.

---

## 4. What is not attributable

**The late single-frame misses.** Every valid capture except `burn-full-feed.json` and `cold-six.json` has one or two
isolated late misses long after the cold path:

| File | rel ms | dt | window | dropped |
|---|---|---|---|---|
| `burn-shared-clock.json` | 53045 | 27 | **52** | 1 |
| `profile-before.json` | 41111 | 26 | 40 | 1 |
| `profile-fresh-six.json` | 31811 | 25 | 31 | 1 |
| `floating-profile.json` | 54433 / 59833 | 28 / 27 | 54 / 59 | 1 / 1 |

The window-52 miss the review asks about is in `burn-shared-clock.json`, which carries **no diagnostics at all** —
**unattributed**, and unattributable from that file.

**One of them is traced.** `profile-before.json`'s window-40 miss is the only late miss in a file with full 63 s trace
coverage. Its frame is `[41085, 41112]`, 26 ms. Inside it: `drain` d=26, `notify` d=4, a 3 ms `Render` at
41085→41088, a `render-update` d=7 at 41092 — and then **20 ms with no trace entry, no React span, no IPC stamp and
no commit**. **[measured]** Nothing instrumented ran.

**Size match.** All five late misses are 25–28 ms and each drops exactly one vsync, isolated, with normal frames
either side. `src/feedStore.ts:28-32` records, measured, a 40 s native sample finding **360 ms of synchronous JSC GC**
(`EdenGCActivityCallback::doCollection` / `FullGCActivityCallback::doCollection` through
`Heap::collectInMutatorThread` → `stopThePeriphery`) **"landing as isolated 26–33 ms frames"**. The observed 25–28 ms
sits inside that band and has the same shape. **[asserted]** — the capture schema has no GC marker, `supportedEntryTypes`
has no `longtask`, and the `/usr/bin/sample` output that would name the symbol
(`scripts/measure-native-profile.py:32`, `<label>-sample.txt`) is **not in this tree**. The match is consistent, not
proved.

### What these traces cannot tell us at all

1. **No compositor presentation.** `src/fps.ts:1-6`: rAF timestamps are rendering *opportunities*, not presentation
   acknowledgements. Nothing here says a pixel reached the screen late, only that a callback ran late.
2. **No long-task, GC, layout or paint events.** This WebKit's `supportedEntryTypes` has no `longtask`, no
   `long-animation-frame`, no `element` (`src/paint.ts:21-24`). Everything called "diagnostics" here is React
   scheduler spans, React Profiler tuples, hand-placed `traceEvent` stamps and counters. A pause with no instrumented
   cause is simply blank.
3. **No resource timings.** `diagnostics.resources` is empty (0 entries) in all five traced files, so the
   MarkdownContent chunk's fetch and parse durations are **not recorded** — only the instant its promise resolved.
   The chunk's cost can be bounded by the frame it lands in (21–26 ms) but not measured.
4. **`render-update` is not paint.** `perfDiagnostics.ts:56-60` marks it asserted: it is "everything the engine did
   after our callback returned", which includes any interleaved task. The 55 ms value in Cluster B cannot be split
   into layout versus the history continuation.
5. **Diagnostics overhead is unquantified.** These are `VITE_REACT_PROFILE=1` builds paying a `console.timeStamp`
   interception, a React `Profiler`, a `MessageChannel` round trip and 4–5 `traceEvent` pushes *per frame*. Traced
   captures dropped 3–6; untraced ones dropped 5–6 — the same order, so the overhead is not dominant, but it has not
   been isolated and Cluster B's absolute millisecond values are upper bounds.
6. **Two traces are truncated and one is internally inconsistent.** `cold-six.json` and `profile-fresh-six.json` carry
   only the first ~6.0 s of a 63 s capture (357 `frame` entries against 3 807–3 809 frames actually sampled) with
   `traceDropped: 0`. In `profile-fresh-six.json` the counters disagree with the trace outright — 542 history
   responses and 3 650 state rebuilds counted, 34 and 307 traced. Cause not determined. Both files are usable **only**
   for the first 6 s, which happens to be the region this attribution needs; neither can speak to anything later.
7. **Two files are hidden-window captures.** `cold-profile.json` (hidden throughout) and `profile-current.json` (went
   hidden at ~42 s) have rAF suspended; their multi-second "intervals" are not frames. Their stamps corroborate
   ordering and nothing else.
8. **No capture records its source.** `'source' in capture_file` is **false** for all eight — B11 confirmed. Binding
   rests on `baseline-manifest.md` plus the two content discriminators in §1: `markdown-module` present → ≥ 915debf;
   `timestampPreparation` key absent → < 95577c3.
9. **The Worker is not in any of them.** Consequence of (8): the labels-on-the-critical-path hypothesis the review
   names at `useConversationHistory.ts:58-61` **cannot be confirmed or refuted by these files**. What they do show is
   the *rest* of that await, and that it was already inside a dropping frame before the Worker was added to it.
10. **The workload is not a real scrollback.** `s1-handshake-and-turn`, 10 sessions × 200 rows/s, `dom_nodes` peaking
    at 469–616. The virtualizer never engages (`ThreadView.tsx:329` needs > 60 rows), so nothing here measures the
    500-row transcript the budgets are written against.

---

## 5. P4a, in priority order

Each item names its site, the expected effect, how to verify, and whether the trace supports it.

### 1. Publish the page before labels resolve — `src/hooks/useConversationHistory.ts:58-61`

Take `prepareTimestampLabels(merged)` out of the `Promise.all` that gates `setItems`; fire it and let
`src/components/MessageTimestamp.tsx` patch labels in when it resolves (`src/timestampLabels.ts:24-36` already has a
synchronous fallback that returns the same `time` string, so there is no blank-label state to design).

- **Support: measured, for the await; asserted, for the Worker's share.** The first `turns-request → turns-response`
  wait is **17 / 22 / 33 / 34 / 18 ms** against a steady-state mean of **0.67–1.03 ms** and a post-first maximum of
  3 ms, and in **4 of 4** usable traces `turns-response` lands **inside** a dropping frame. That excess is measured on
  binaries that had **no Worker** — it is a cold `chatTurns` invoke. HEAD adds a first module-`Worker` construction
  (`timestampLabels.ts:64-65`) plus a `postMessage` round trip to the **same** await, so HEAD's critical path is that
  17–34 ms **or more**. **[asserted]** — no trace measures the Worker.
- **Expected effect:** the first-response wait falls toward the 1–2 ms steady-state band; Cluster B loses its second
  frame's blocking component. On these numbers that is 1–3 of the 3–5 vsyncs dropped in windows 0–3.
- **Cost of being wrong:** `burn-worker-labels.json` records `workerLabels: 1, synchronousLabels: 0` — the Worker
  produced **one** label in a 63 s run. There is almost nothing to patch in late.
- **Verify:** one cold trace from a `VITE_REACT_PROFILE=1` build of the change. `turns-request → turns-response` on the
  first response must sit in the same band as the rest of the run, and `capture.timestampPreparation` must show
  `workerFailures: 0`. Then a visible acceptance capture: `summary.total_dropped` in windows 0–3 must fall.

### 2. Cut the first transcript mount's render and commit — `src/components/ThreadView.tsx` (mount path)

This is the largest measured contributor and B2 does not name it.

- **Support: measured.** `cold-six.json`: `Render` 2321→2334 (**13 ms**) + `Commit` 2334→2341 (**7 ms**) for
  `ThreadView → Transcript → TranscriptRuntime → WritableTranscriptRuntime → AssistantRuntimeProviderImpl →
  AssistantProviderInner → AuiProvider → Thread → ChatPanel`, inside the 46 ms / 2-dropped frame; then `Render`
  2380→2392 (**12 ms**) + `Commit` (**4 ms**) for the `setItems` publish inside the 61 ms / 3-dropped frame. 36 ms of
  the first frame carries no stamp other than that mount.
- **Expected effect:** halving the mount render+commit takes the first frame from ~46 ms to under the 33 ms two-vsync
  line; both frames are within one vsync of that line already.
- **What to attack first — asserted, from source:** the runtime stack above is four provider layers deep before a
  single row renders, and `useConversationHistory`'s effect fires its first `history-request` only *after* that
  commit (measured: `history-request` lands 3 ms after the commit ends, 4/4 files). Starting the history fetch before
  or in parallel with the mount removes a serial 20 ms from the critical path outright. That is a listen/fetch
  ordering change of the kind B4 already calls out in three other files.
- **Not this, on the evidence:** `ThreadView.tsx:329-331` and `measureElement` at `:423` are **not** in any of these
  traces — `virtualized` is false at these transcript sizes. Any virtualizer change is unmeasured here and belongs in
  P4b's conditional-viewport experiment, not P4a.
- **Verify:** the `Render`/`Commit` span pair around the first `history-request` in a fresh cold trace, and the
  `Transcript` entry in `diagnostics.components` (`maxMs`). Both must fall; the two Cluster B frames must drop under
  33 ms.

### 3. Replace the double `JSON.stringify` — `src/hooks/useConversationHistory.ts:77`

`setTurns(old => JSON.stringify(old) === JSON.stringify(recorded) ? old : recorded)` serialises the full turns array
twice on **every** history response. Replace with a seq-range or identity comparison, as B2 says.

- **Support: asserted, from source and from the counters — not from the cold cluster.** `diagnostics.counters` confirms
  the response volume: **537** (`profile-before`) and **542** (`profile-fresh-six`) history responses in 63 s. But the
  Cluster B frames are attributed above to mount and IPC; this call is not separable in any trace, and the steady-state
  frames after `markdown-module` are already 12–17 ms.
- **Expected effect:** steady-state only, and small. It is in P4a because it is a correctness-preserving one-line
  change on the same file the first two items touch, not because the trace indicts it. Do not claim a cold-path win
  for it.
- **Verify:** dropped vsyncs in windows 3–63 across two captures, and `diagnostics.components["Transcript"].totalMs`.

### 4. Preload the MarkdownContent chunk after first contentful paint — demoted

B2 puts this first. The trace does not.

- **Support: measured, and mostly against.** `markdown-module` resolves **+15 / +18 / +21 ms after** the last dropping
  frame in `cold-six`, `profile-before` and `profile-fresh-six`, and the frame it lands in is 21–24 ms — late, but
  **0 dropped vsyncs**. Only in `profile-current` (invalid: went hidden) does it fall inside a 26 ms / 1-dropped frame.
  So the whole prize is **one late frame, and at most one dropped vsync in one invalid capture**.
- **Still worth doing:** it is cheap and it removes a 21–26 ms frame from the cold path. Do it, and correct the comment
  at `src/components/Markdown.tsx:36-39` that calls the chunk "a candidate for the stall", which this file refutes.
- **Site:** the mount effect in `src/App.tsx:324-345`, in the continuation after its `await Promise.all([...])`
  resolves — the shell has painted and its first data has landed by then. `void import("./components/MarkdownContent")`
  behind a zero-delay `setTimeout`. **Do not** hang it off `src/Launch.tsx:79`, whose 150 ms poll is still running
  *before* the launch scene settles. Whether `requestIdleCallback` exists in this WKWebView has **not been checked**
  and must be confirmed against current WebKit docs before it is used (CLAUDE.md §1); `setTimeout` needs no research.
- **The budget constraint is real:** exec → first contentful paint must stay **≤ 295 ms p50**. Reference points in this
  directory: `startup-uninterrupted.json` p50 **270.6 ms** (pass), `startup.json` p50 **308.5 ms** (fail). The margin
  is 24.4 ms on the good run, and the chunk is 286 KB.
- **Verify, both halves:** (a) `scripts/measure-native-startup.py` — p50 must stay at or below the 270.6 ms reference
  and `pass` must stay true; (b) a cold trace in which `markdown-module` appears **before** the first
  `history-request`, which is B2's own acceptance wording.

### Not in P4a

Cluster A (the 29–31 ms shell-mount miss at rel ~1.04 s, 1 dropped vsync, in 5 of 6 valid captures) is a real,
reproducible miss with a clean React attribution — `App / SidebarProvider / Sidebar / SidebarContent / SidebarGroup`
then `SidebarInset / ProjectWorkbench / Tabs / CompositeList`. It is not the transcript and P4a does not reach it.
It should be booked as its own item rather than absorbed, because after P4a lands it will be a visible share of what
is left.

### What a green run would take, on these numbers

P4a as scoped addresses Cluster B: 3–5 of the 5 dropped vsyncs in `burn-shared-clock.json` and `burn-full-feed.json`.
It does not address Cluster A (1) or the late GC-shaped frame (1 in shared-clock, 0 in full-feed). Per the lead's
decision 1 in the review, a residual of exactly one late 25–28 ms frame attributed to JSC GC is the only
install-eligible failure; a residual that still contains Cluster A is not. Say so in the P4a exit rather than
discovering it at P9.
