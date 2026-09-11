# The ~40 ms window-2 frame in the burn — 2026-09-11

What this answers: `docs/performance/codex-thread-burn-2026-09-11.md` §5 found a single ~40 ms frame
in the burn's window 2 in **13 of 13** accepted runs across two arms, dominating the 60 Hz gate's
failure. This file says what that frame is, on what evidence, and what to do about it.

**No burn was run for this file.** Two independent blockers, both recorded in §6: the machine's
console was locked for the whole session, and `scripts/measure-native-burn.py` refuses a locked
console by design; then captures on this machine were frozen by the coordinator for another
session's window. Everything below is therefore extracted from captures **already in this tree**,
plus five frozen build arms that are ready to run the moment captures are released (§7).

Every claim is marked **[measured]** (computed from a capture file in this tree), **[derived]**
(computed from two measured fields) or **[asserted]** (read off source, not seen in a trace).

---

## 1. Bottom line

**The ~40 ms frame is the first transcript mount — React rendering and committing the `ThreadView →
Transcript → TranscriptRuntime → AssistantRuntimeProvider → Thread` subtree for the first time, the
history round trip that lands on top of it, and the engine's style/layout/paint of the ~100 DOM nodes
it inserts — all landing inside two consecutive rAF callbacks while the feed drain is still running
at 2 000 rows/s in the same callbacks.** It is not one 40 ms thing; it is three things that queue up
behind each other in two frames.

It is a **cold-start cost, paid once per app launch.** In **17 valid captures across four days and at
least five different binaries, 61 of 68 dropped vsyncs — 90% — fall in the first 3.5 seconds of the
capture** ([measured], §2). Nothing about the steady-state feed drops frames: in ten of the
seventeen, the run drops **nothing at all** after 3.5 s.

Two candidates that have been named in the past are **measurably not it**: the 286 KB MarkdownContent
chunk (now preloaded at `App.tsx` + 1500 ms, and already exculpated by trace in
`docs/performance/2026-09-11/cold-path-attribution.md` §3), and feed-drain volume (the row spike
*follows* the long frames — it is the backlog they created).

**A material caveat that changes how the 13-run result should be read.** The two arms in
`codex-thread-burn-2026-09-11.md` are `f94c9ef` and `c34e229`, and **neither contains `1b77f1c`**
("Cold-path history fetch, idle-silent feed drain, listener-first subscriptions"), which is on
`main` today — verified with `git merge-base --is-ancestor` [measured]. `1b77f1c` moves the first
`historyPage` invoke into the *render* that mounts the transcript (`useConversationHistory.ts`'s
`useMemo(() => beginFirstPage(...))`), which is precisely the serial 20 ms this attribution indicts.
**No capture in this tree measures HEAD.** The 13-run figure is a pre-fix number.

---

## 2. Where the drops are — every valid capture in the tree

Full output: `2026-09-11-burn-frame/cluster-localisation.txt`. Rule is `src/fps.ts`'s own,
`dropped = max(0, round(dt / 16.67) − 1)`. "rel" is ms from capture start, reconstructed as
`cumsum(intervals_ms)`. A capture is listed only if it is valid for rendering (`interrupted: false`,
≥ 60 windows) and ran the pinned workload — all seventeen carry
`{sessions: 10, rowsPerSec: 200, durationS: 60, fixture: "s1-handshake-and-turn"}` [measured].

| capture | binary era | total dropped | dropping frames in the first 3.5 s (rel ms, dt) | after 3.5 s |
| --- | --- | ---: | --- | --- |
| `2026-09-10/ship-release-burn` | 2026-09-10 rel. | 2 | 83 / 29; **2034 / 29** | none |
| `2026-09-10/final-release-burn` | 2026-09-10 rel. | 2 | **1976 / 37; 2008 / 32** | none |
| `2026-09-10/peer-noop-acceptance-1` | 2026-09-10 rel. | 2 | **2126 / 30; 2161 / 35** | none |
| `2026-09-10/live-history-release-burn-1` | 2026-09-10 rel. | 3 | **1945 / 27; 1978 / 33** | 8763 / 28 |
| `2026-09-11/burn-owner-ready` | 915debf era | 3 | **2240 / 26; 2284 / 44** | none |
| `2026-09-11/burn-raised` | 915debf era | 3 | **2373 / 35; 2416 / 43** | none |
| `2026-09-11/profile-before` (traced) | 915debf era | 3 | **2339 / 36; 2380 / 41** | 41111 / 26 |
| `2026-09-11/burn-layout-candidate` | 915debf era | 4 | 1045 / 30; **2407 / 41; 2458 / 51** | none |
| `2026-09-11-css-spike/burn-baseline` | css spike | 4 | 1002 / 31; **2246 / 41; 2290 / 44** | none |
| `2026-09-11-thread-burn/burn-branch-b6` | `c34e229` | 4 | 983 / 26; **2077 / 37; 2120 / 43** | none |
| `2026-09-11-thread-burn/burn-baseline-b6` | `f94c9ef` | 5 | 974 / 25; **2075 / 43; 2120 / 45** | none |
| `2026-09-11/burn-shared-clock` | 915debf era | 5 | 1032 / 29; **2278 / 41; 2323 / 45** | 53046 / 27 |
| `2026-09-11/burn-full-feed` | 915debf era | 5 | 1047 / 30; **2345 / 45; 2400 / 55** | none |
| `2026-09-11-css-spike/burn-full` | css spike | 5 | 998 / 28; **2086 / 37; 2128 / 42** | 47824 / 25 |
| `2026-09-11/cold-six` (traced) | 915debf era | 6 | 1047 / 30; **2346 / 46; 2407 / 61** | none |
| `2026-09-11/profile-fresh-six` (traced) | 915debf era | 6 | 1032 / 30; **2295 / 43; 2347 / 52** | 31810 / 25 |
| `2026-09-11/floating-profile` | 915debf era | 6 | 1052 / 31; **2410 / 38; 2460 / 50** | 54432 / 28; 59832 / 27 |

**[measured]** Three facts fall straight out of that table:

1. **The bolded pair is in 17 of 17.** Every single valid capture in the tree, on every binary, has
   **two consecutive long frames between rel 1.9 s and rel 2.5 s**. Nothing else in the burn is
   reproducible at all.
2. **90% of all drops are cold.** 61 of 68 dropped vsyncs fall before rel 3.5 s. Ten of the
   seventeen runs drop **nothing** after 3.5 s; the seven late misses are isolated, 25–28 ms, one
   vsync each, scattered from window 8 to window 59 with no common position.
3. **There is a second, smaller cluster at rel ~1.0 s** — one 25–31 ms frame, one dropped vsync —
   present in 11 of 17. `docs/performance/2026-09-11/cold-path-attribution.md` §3 attributes it by
   React span to the **workbench/sidebar shell mount** and it is not the transcript.

An aside the table makes visible and that nobody has named: **the cold pair got worse between
2026-09-10 and 2026-09-11.** On the four 2026-09-10 release captures the pair is 27–37 ms and costs
**2 drops**; on the eleven 2026-09-11 captures it is 37–61 ms and costs **3–5**. The workload is
identical. **[measured]**, but the contention state of the 2026-09-10 runs is not recorded in those
files, so this is an observation and not yet a bisected regression.

---

## 3. What is inside the two frames — method (i), the React/IPC trace

Three captures in the tree carry a `VITE_REACT_PROFILE=1` diagnostic bundle: React scheduler
`Render`/`Commit` spans, a `performance.now()` trace (`frame`, `drain`, `notify`,
`history-request`/`-response`, `turns-request`/`-response`, `markdown-module`) and a `MessageChannel`
end-of-frame probe (`render-update`). Full dump: `2026-09-11-burn-frame/trace-attribution.txt`.

`profile-before.json` is the only one with a full 63 s trace. Its two dropping frames end at rel
2339 (36 ms) and rel 2381 (41 ms). Reading its spans and stamps on one clock **[measured]**:

**Frame 1, rel 2303 → 2339, 36 ms, 1 dropped.**

| rel ms | what |
| ---: | --- |
| 2303 | the previous callback: `drain` d=27 rows, `notify` d=**1** listener |
| 2308 | `render-update` d=5 — the engine finished the previous frame |
| 2309 → 2320 | **`Render` 11 ms** — the first transcript subtree |
| 2320 → 2325 | **`Commit` 5 ms** |
| 2329 | `history-request` — the hook's effect, 4 ms after the commit ends |
| 2331 → 2338 | `Render` 3 + `Commit` 2 + `Render` 1 — cascading passes off the mount |
| 2338 | `history-response` d=3, `turns-request` d=3 |
| **2339** | frame ends. `notify` is now d=**4** listeners, not 1 |

**Frame 2, rel 2339 → 2381, 41 ms, 1 dropped.**

| rel ms | what |
| ---: | --- |
| 2339 → 2346 | `Render` 3 + `Commit` 4 |
| 2339 → 2360 | **21 ms with no span and no stamp — the `chatTurns` await**, serial after the mount |
| 2360 → 2372 | **`Render` 12 ms** — the `setItems` publish of the first page |
| 2372 → 2376 | **`Commit` 4 ms** |
| 2381 | frame ends; `drain` d=**115** rows — the backlog the two stalls created |
| 2390 | `render-update` d=**51 ms** — everything the engine did after the callback returned |

So the 36 ms frame is ~22 ms of React plus 5 ms of carried-over engine work plus the drain; the
41 ms frame is a 21 ms serial IPC wait plus 16 ms of React, and it hands the engine a **51 ms**
post-callback bill for laying out and painting the new transcript DOM.

**Corroboration on the same clock, two more captures.** `profile-fresh-six` and `cold-six` put
`history-request` **inside** a dropping frame and `turns-response` **inside** the next one, 4 traces
of 4 including the invalid `profile-current`. The first `turns-request → turns-response` wait is
**17 / 22 / 33 / 34 / 18 ms** against a steady-state mean of **0.67–1.03 ms** over 534–544 responses
in the same runs — a 17–34× cold-call penalty [measured].

**A step change, not a spike.** React work per 200 ms in `profile-before` runs at 24–26 ms before
the mount, jumps to 73–79 ms across rel 2200–3000, and then settles at **58.8 ms per 200 ms**
(~29% of the main thread) for the rest of the run [measured]. The mount does not just cost two
frames; it raises the floor. The two dropped frames are the transition, not the whole bill.

**Two candidates the trace rules out.**

- **MarkdownContent.** `markdown-module` resolves 15–21 ms *after* the last dropping frame in three
  of four traces, in a frame that drops zero. On HEAD it is preloaded 1500 ms after the App mount
  effect (`src/App.tsx:486`), i.e. ~18.5 s *before* the capture even opens, since `?burn=auto` waits
  20 s (`src/components/Burn.tsx`). It cannot be in window 2 at all on HEAD. **[measured + asserted]**
- **Drain volume.** `drain` is a steady 23–29 rows per frame through the whole approach to the
  cluster and spikes to 115 only in the *second* long frame — the backlog, not the cause. **[measured]**

**One caution about the prior attribution's favourite file.** `cold-six.json`'s span durations sum to
**511 ms of React inside a 200 ms bucket** — impossible as wall time [derived]. Its
`console.timeStamp` interception is evidently double-counting. Its *ordering* is usable; its
*durations* are not, and `docs/performance/2026-09-11/cold-path-attribution.md` §3 quotes them as
milliseconds. `profile-before.json` does not have this problem (24–79 ms per 200 ms bucket) and is
the file this document leans on.

---

## 4. Why the mount happens 2.3 s into the capture at all — method (ii), the harness path

Read off source, corroborated by `dom_nodes` per window **[measured + asserted]**:

`src/components/Burn.tsx` opens the capture and *then* calls `onBurn`. `App.tsx`'s `runBurn`
(`src/App.tsx:1096`) does, in order: `bridge().burn(args)` → `refreshProjects()` → `chooseProject()`
→ `listSessions()` → `seedSessions()` → `setSelectedSessionId(newest)`. Rust's `burn::run`
(`src-tauri/src/burn.rs`) loads the fixture, prepares a workspace, `add_project`s it and starts ten
sessions **sequentially** before returning. The data dir is wiped before every run
(`runners/resetdata.sh`), so at capture start the app has **no project and no session at all**.

`dom_nodes` at each window close traces the consequence exactly, and the same three-step shape
appears in every capture [measured]:

| | idle sample | window 0 | window 1 | window 2 | window 3 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `burn-shared-clock` | 181 | 181 | 358 | **469** | 459 |
| `burn-baseline-b6` | 181 | 322 | 358 | **460** | 461 |
| `burn-branch-b6` | 181 | 322 | 358 | **466** | 469 |

+141 nodes when the project arrives and the workbench shell mounts (cluster at rel ~1.0 s), +36 when
the ten sessions reach the sidebar, then **+102 to +111 when the transcript mounts** — in window 2,
in the same window as the two long frames. The DOM delta and the React spans name the same event.

**So the gate, as built, measures a cold first-project-plus-first-transcript mount that the product
pays once per launch, inside the window it grades for sustained 60 Hz.** That is a real cost and
worth fixing; it is also not "the feed cannot keep up", which is what a reader of "the burn drops
5 vsyncs" would assume.

---

## 5. The fix, not built

Nothing was changed on the render path, because nothing could be re-measured (§6). What the evidence
supports, in order of expected gain:

1. **Already on `main`, unmeasured: `1b77f1c`'s render-phase first page.** `beginFirstPage` in a
   `useMemo` issues `historyPage` from the mounting render instead of the post-commit effect, so the
   IPC overlaps the 11 ms `Render` + 5 ms `Commit` instead of following them. On these traces that
   removes a serial ~20 ms from frame 2's critical path. **Expected: 1–2 of the 3–5 cold drops.**
   **[asserted]** — no capture in this tree contains it. This is the single most valuable capture to
   schedule (§7).
2. **Do not publish the first page in the same frame as a feed drain.** Frame 2 carries the 12 ms
   `setItems` render, a 4 ms commit, a 115-row drain and then hands the engine 51 ms of layout. The
   contained change is to let the first `setItems` land on its own frame — the total work is
   unchanged but 40 ms spread over three 16 ms frames drops **zero** vsyncs where 40 ms in one drops
   two. **Expected: frame 2 under the two-vsync line.** Site: `useConversationHistory`'s `read()`
   publish, or `feedStore`'s drain deciding not to apply a batch on a frame that already has a
   pending transcript publish. **[asserted]** — this is a pacing argument from §3's numbers, not a
   measured one.
3. **Cut the mount render itself.** 11 ms of `Render` for `ThreadView → Transcript →
   TranscriptRuntime → WritableTranscriptRuntime → AssistantRuntimeProviderImpl → AuiProvider →
   Thread → ChatPanel` is four provider layers before one row renders, and
   `diagnostics.components` puts `Transcript` top of the list at `maxMs 12.00` over 4 157 renders.
   This is the largest single number in the cluster and the least contained change.

**Explicitly not worth doing on this evidence:** anything to the MarkdownContent chunk (§3), and
anything to the virtualizer — `ThreadView.tsx` gates virtualisation on `rows.length > 60`, the
fixture's transcript peaks at 469–616 DOM nodes, so `measureElement` is not in any of these traces.

---

## 6. What was actually run here, and what stopped it

**Builds — five arms, all green, all frozen.** `2026-09-11-burn-frame/build-*.exit`, exit codes read
off the command. Recipe and wrappers in `2026-09-11-burn-frame/runners/`.

| arm | source | window URL | build exit | seconds |
| --- | --- | --- | ---: | ---: |
| `accept` | clean HEAD `462c6bf` | `index.html?burn=auto` | 0 | 132 |
| `prof` | clean HEAD + `VITE_REACT_PROFILE=1` | `index.html?burn=auto` | 0 | 86 |
| `ctl` | HEAD + the §6 pre-roll instrument | `index.html?burn=auto` | 0 | 72 |
| `pre1500` | HEAD + pre-roll instrument | `…&preroll=1500` | 0 | 67 |
| `pre4000` | HEAD + pre-roll instrument | `…&preroll=4000` | 0 | 67 |

All are release builds, `--features burn`, `VITE_BURN=1`, isolated identifier
`ai.brigadier.perf.cssspike`, frozen with `cp -Rc` so no later build can replace them. They live at
`/private/tmp/brig-frame-20260911/frozen-<arm>.app` and are ~2 minutes to rebuild from
`runners/build2.sh` if that directory is swept.

**Burn runs — one attempt, refused, zero launches.**

| run | arm | exit | reason | pgrep before/after | load1 | locks before/after |
| --- | --- | ---: | --- | --- | ---: | --- |
| a0 | accept | 1 | `Mac is locked; unlock before a native rendering measurement` | 4 / 4 | 12.53 | 19 / 19 |

`ioreg -n Root -d1 -a` → `IOConsoleLocked = True` on every check across the whole session (first
check to last, ~70 minutes). The harness refuses before launching the binary, which is correct and
was not defeated. Then the coordinator froze captures on this machine for another session's window,
and the staged run sequence (`runners/autorun2.sh`, 12 runs across the five arms) was **disarmed**
before it could fire.

**Lock-file delta: 0 for my runs, and the counter is not mine to read.**
`~/.brigadier/workspace-locks-v1` went 436 → 447 → 263 → 19 over the session while I launched
**nothing**; the only movement bracketing my one attempt is 19 → 19. The count is being driven by
the sibling worktree's `cargo test` runs, not by app launches, so it cannot be used to audit this
harness's leak without isolating it from concurrent test runs. Nothing was swept.

**Contention.** Never quiet. `pgrep -f "cargo build|tauri build|vite|cargo test|clippy|vitest|rustc"`
returned 3–4 processes (a sibling worktree's `cargo test`, twice concurrently) for most of the
session, with 1-minute load between 9.8 and 35.8. It was briefly 0 at one point — while the console
was locked.

**The pre-roll instrument, the only code change on the render path's side of the tree.**
`src/components/Burn.tsx` gains `diagnosticPrerollMs(search)`: with `VITE_BURN=1` **and** an explicit
`?preroll=<ms>` in the window's own URL, the burn starts its sessions, waits, and only *then* opens
the capture — so the cold mount happens outside the measured window. It is **0 on every other path**
and the acceptance branch is byte-for-byte the branch it was. The value is written into the capture
as `prerollMs`, so no file can be read back later without saying which arm produced it. This is the
falsifier for §1: if the long frames are the cold mount they leave the capture with it; if they are
the steady-state feed they stay. It is built, frozen at two pre-roll lengths, and **not yet run**.

Files changed on this branch: `src/components/Burn.tsx` (the instrument),
`src/components/Burn.prerollFlag.test.ts` (its gate — the flag must be 0 for anything that is not an
explicitly enabled burn build with an explicit positive `?preroll=`), this file,
`docs/research/webview-profiling-2026-09-11.md`, and `docs/performance/2026-09-11-burn-frame/`.
Nothing on the product render path was touched. `npm test` exit 0 (88 files, 759 tests),
`npx tsc --noEmit` exit 0.

---

## 7. Captures still needed, in priority order

Each is one `runners/burn.sh <arm> <label>` against an already-frozen bundle, ~95 s per run, console
unlocked, `pgrep` empty before and after.

1. **`accept`, n ≥ 5.** The number that does not exist: HEAD's dropped-vsync count. HEAD contains
   `1b77f1c` and `95577c3`; **neither** 13-run arm did. Until this runs, "the 60 Hz gate fails with a
   median of 4–5 drops" is a claim about two commits that are not on `main`.
2. **`prof`, n ≥ 2.** HEAD's trace. Confirms or refutes §5.1 directly: `history-request` must now
   appear **before** the mount `Render` rather than 4 ms after the `Commit`, and the 21 ms unstamped
   `chatTurns` wait in frame 2 must be gone.
3. **`pre4000` vs `ctl`, n ≥ 3 each.** The bisect. If §1 is right, `pre4000` drops ~0 in windows 0–3
   and `ctl` reproduces the pair. If `pre4000` still drops the pair, §1 is wrong and the cause is the
   steady-state feed after all.
4. **`pre1500`, n ≥ 3.** Brackets the cold work's length between 1.5 s and 4 s.

Run them interleaved, not in blocks, so machine drift cannot be mistaken for an arm difference.

---

## 8. Not checked

- **Any number on HEAD.** No burn, no startup series, no FCP measurement was taken. Every figure in
  this document comes from a binary at `f94c9ef`, `c34e229`, `915debf`-era or older. §7 is the list.
- **The pre-roll instrument has never been executed** — it typechecks and builds, and its behaviour
  at `preroll > 0` is unverified at runtime.
- **The Safari Web Inspector Timeline.** Not used. The exact Tauri v2 route (`devtools` Cargo
  feature, `WebviewWindow::open_devtools()`, a macOS private API) and why it was not taken are in
  `docs/research/webview-profiling-2026-09-11.md`. The consequence is that `render-update`'s 51 ms
  remains one number: style, layout and paint cannot be separated from anything interleaved, and
  this WebKit exposes no `longtask`, no `long-animation-frame` and no `element` entry types.
- **`/usr/bin/sample` against the WebContent process.** `scripts/measure-native-profile.py` exists
  and would have been the second, natively independent method; it needs an unlocked console too.
  No native sample in this tree names a symbol inside the cold cluster.
- **Whether the 2026-09-10 → 2026-09-11 worsening of the cold pair (§2) is real.** The workloads are
  identical and the effect is 2 drops versus 3–5, but the 2026-09-10 captures record no contention
  state and carry no `source` stamp, and the difference has not been bisected.
- **Whether any of this is visible to a user.** The burn's cold mount is a synthetic 10-session
  project appearing from nothing. A user opening their first transcript pays the same mount, but not
  at 2 000 rows/s, and `src/fps.ts:1-6` is explicit that these are rendering *opportunities*, not
  presentation acknowledgements — nothing here says a pixel arrived late.
- **The other five gates.** For the pre-roll instrument: `npm test` **exit 0**, 88 files / 759 tests
  passed; `npx tsc --noEmit` **exit 0** — both exit codes read off the command, not through a pipe.
  No cargo gate was run because no Rust changed. `npm run tauri build` is exercised five times by the
  arms in §6 (all exit 0) but not as a gate on a clean tree, and the burn gate itself could not run.
- **The lock-file leak.** Not isolated; see §6. The counter moved by hundreds while I launched
  nothing.
