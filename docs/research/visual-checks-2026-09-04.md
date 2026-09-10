# Visual checks, 2026-09-04 — the 800x500 minimum, and the feed's scroll FPS re-measured

Two checks the machine's screen lock had killed twice. Both were run with the screen unlocked and
the lock state probed on either side. Every claim below is tagged **[measured]**, **[source]**,
**[documented]** or **[asserted]**; §7 says what was not checked.

Repo at `1b18909`. No file in `src/`, `crates/` or `src-tauri/` was edited for this work — §6
carries the proposed changes as proposals, not edits.

---

## 0. Lock state, and the environment

`CGSSessionScreenIsLocked` absent means unlocked; `True` means locked
(`ioreg -n Root -d1 -a`, `IOConsoleUsers`).

| when | probe | result |
|---|---|---|
| 12:10:20, before anything | explicit | `locked = None`, `onconsole = True` **[measured]** |
| 12:13, before the first screenshot | explicit | `locked = None` **[measured]** |
| 12:24:26, before burn run 1 | explicit | `locked = None` **[measured]** |
| 12:25:35, after burn run 1 | explicit | `locked = None` **[measured]** |
| 12:26:38 – 12:29:33, runs 2 and 3 | implicit | `System Events` returned `frontmost = brigadier` on every 10 s poll, 12 polls; cross-app AX is blocked on a locked screen, so the screen was unlocked throughout **[measured]** + **[asserted]** |
| ~12:32, after everything | explicit | `locked = None`, `onconsole = True` **[measured]** |

No measurement was taken with the screen locked. **[measured]**

Machine: macOS 26.5.2 (25F84), built-in Liquid Retina XDR, 3456x2234 native, `devicePixelRatio 2`.
**[measured]**

Spend: `pgrep -x claude` before `22589 30298`, after `22589 30298` — **no new persistent `claude`
child**. **[measured]** The dev log carries three `claude resolved` lines, which are the
`claude --version` probes from `setup` and `probeClaude` (`src-tauri/src/state.rs:180`); no session
was started, no API call was made, and `cargo test --ignored` was never run. **[measured]**

---

## 1. The six gates, run once on this tree

Every exit code captured on the command itself, not through a pipe.

| gate | exit | result |
|---|---|---|
| `cargo test --workspace` | **0** | 296 passed, 0 failed, **6 ignored** (the ones that spawn a real `claude`; `--ignored` was not passed) **[measured]** |
| `cargo clippy --workspace --all-targets -- -D warnings` | **0** | no warnings; incremental, `Finished dev profile in 0.50s` **[measured]** |
| `cargo doc --workspace --no-deps` | **0** | `target/doc/brigadier_lib/index.html` + 9 files **[measured]** |
| `npm test` | **0** | 7 files, **131 tests** passed, 1.59 s **[measured]** |
| `npx tsc --noEmit` | **0** | no output **[measured]** |
| `npm run tauri build -- --features burn` | **0** | `brigadier.app` + `brigadier_0.1.0_aarch64.dmg` **[measured]** |

Bundle, from the build's own reporter: **[measured]**

| artefact | raw | gzip |
|---|---|---|
| `dist/index.html` | 0.39 kB | 0.26 kB |
| `dist/assets/index-csGyHcPi.css` | **25.17 kB** | 5.81 kB |
| `dist/assets/event-BqZi0_jf.js` (lazy chunk) | 1.38 kB | 0.67 kB |
| `dist/assets/index-C6HFYllm.js` | **273.98 kB** | 86.64 kB |

Rust release compile 17.76 s; vite build 431 ms; 53 modules.

---

## 2. Check 1 — the app at its 800x500 minimum

### 2.1 Method, and which half of each claim is real

- **Primary, the real window.** The release `brigadier.app`, resized to exactly 800x500 with
  `System Events`, captured with `screencapture -x -R<frame>` (1600x1000 px at dpr 2) and measured
  by pixel analysis. This is WKWebView and the real Rust feed. **[measured]**
- **Secondary, and weaker.** Headless Chromium 152 (Dia's bundled binary, its own scratch profile)
  against `npm run dev` with the **mock** bridge, viewport emulated at 800x468, driven over CDP for
  exact `getBoundingClientRect` / `getComputedStyle` / `scrollWidth`. **Chromium is not WKWebView
  and the mock is not the Rust feed.** Every number sourced here says so. **[measured]**

`src-tauri/tauri.conf.json` was **not** edited to force a size.

### 2.2 The viewport at an 800x500 window: **800 x 468 CSS px**

The macOS title bar is **32.0 pt** tall. Measured on the real window at x = 150 pt: `#181818`
(title bar) to y 31.5 pt, `#3A3B3B` (sidebar ground) from y 32.0 pt. **[measured]** Cross-checked:
the sidebar brand strip then occupies viewport y 0–52, which is exactly `--head-h: 52px`
(`src/index.css:196`). **[measured]**

So the CSS breakpoints see **468 px of height, not 500**. Window size and viewport size are not the
same number and must not be quoted interchangeably.

### 2.3 The 960 px rule fires, and the sidebar is 220 px — confirmed

- Real window: the sidebar / thread boundary is at **pt x = 220.0** exactly, at three sampled rows.
  **[measured]**
- Chromium at vw 800: `--sidebar-w` computes to `220px`; `matchMedia("(max-width: 960px)").matches`
  is `true`; `matchMedia("(max-width: 1200px)").matches` is `true`; `.sidebar` rect is 0 → 220.
  **[measured]**

`src/index.css:1769` is doing its job. The `.side-branch .prefix` `sr-only` rule is also live — the
real window shows `73fb34e3` with no `brigadier/` prefix at 800 px and `brigadier/73fb34e3` at
1280 px. **[measured]**

### 2.4 `--content-max` is not collapsed, but the feed loses both gutters

`--content-max` stays **712px** at every width. **[measured]** At vw 800 the thread pane is 580 px,
so `.feed-sizer` (`width: 100%; max-width: var(--content-max)`, `src/index.css:1120-1125`) resolves
to 580 px with computed `padding-left: 0px`, `padding-right: 0px`. **[measured]**

The consequence, measured in both the real window and Chromium: **feed rows run flush from the
sidebar divider to the window's right edge.**

| viewport | pane | `.feed-sizer` rect | left gutter | right gutter |
|---|---|---|---|---|
| 800 | 220 → 800 | 220 → 800 | **0** | **0** |
| 932 | 220 → 932 | 220 → 932 | **0** | **0** |
| 1280 | 276 → 1280 | 422 → 1134 | 146 | 146 |

**[measured]** (Chromium.) Confirmed on the real window: feed row ink begins at pt 220.5, i.e. half
a point off the divider, and the ellipsis of a truncated row lands at pt 798.5 of an 800 pt window.
**[measured]**

Every other block in the pane is inset: `.thread-head` computes `padding-left: 16px`, the approval
card and the dock sit at 235–236. **[measured]** So the feed is the one element that touches both
edges. The threshold is a **932 px window** — below it, the pane is narrower than 712 px and the
margins vanish.

`.feed-count` is inset `max(16px, …)` = 16 px at this width (`src/index.css:1097`), so the row
count floats 16 px in from an edge the rows it labels are touching. **[measured]**

### 2.5 The feed collapses to 1.39 rows when an approval is pending

Thread children at vw 800 / vh 468, measured: **[measured]** (Chromium + mock)

| child | top | bottom | height | why |
|---|---|---|---|---|
| `.thread-head` | 0 | 52 | 52 | `--head-h` |
| `.feed` | 52 | 111.5 | **59.5** | whatever is left |
| `.approvals` | 111.5 | 308 | **196.5** | `max-height: 42vh` (`src/index.css:1296`), 42% of 468 |
| `.dock` | 308 | 468 | **160** | fixed, `flex: 0 0 auto` (`src/index.css:1413`) |

52 + 196.5 + 160 = 408.5 of 468. `.feed-scroller` is left **39.5 px = 1.39 rows** of a 28 px pitch,
against a `.feed-sizer` 38,976 px tall. The top visible row is cut through the middle of its
glyphs. **[measured]** (screenshot: `chrome-800x468-fpsoff.png`)

With no approval pending the arithmetic is 468 − 52 − 160 = 256 px = **8.4 rows**, which is what the
real window shows — 8 rows of a 48-row session. **[measured]**

`.approvals` is `flex: 0 0 auto`, so it cannot yield; `.feed` has no `min-height`, so it absorbs the
entire squeeze.

### 2.6 Turning the frame meter on at 800 px destroys the header

**Reproduced in the real release window at 800x500.** After clicking the `fps` pill, the header
shows only the meter capsule — `60 Hz · p50 17 · p95 18 · p99 18 · worst 18 ms · 0 dropped (run 0)
· dom 123 · r…` — clipped at the window's right edge, and the project title `brigadier-ai` and its
path are **gone from the header entirely**. **[measured]** (screenshot: `tauri-800x500-fpson.png`)

Chromium gives the arithmetic at vw 800: **[measured]**

- `.head-id` rect 236 → 236, **width 0**
- `.fps` rect 248 → 1005.3, **width 757.3**
- `documentElement.scrollWidth − clientWidth = 205` — the page scrolls horizontally

Cause: `src/index.css:1635` `.fps { flex: 0 0 auto }` plus `src/index.css:1643`
`white-space: nowrap`. The meter refuses to shrink and `.head-id` is the only flex item that can,
so it is starved to zero. **[measured]**

With the meter **off** there is no horizontal overflow at any size tested:
`documentElement.scrollWidth === clientWidth === 800`, and no element's rect exceeds the viewport.
**[measured]** The meter is off by default in a release build (`src/fps.ts` `readEnabled`, default
`import.meta.env.DEV`), so this is a defect a user reaches by clicking the pill, not one they meet
on launch.

### 2.7 Verdict on Check 1

**Usable, not correct.** Nothing is unreachable — the composer's `textarea` is at 232 → 788 x
358 → 412 with the Start button visible, both breakpoints fire, the sidebar is the intended 220 px,
there is no body scroll in either axis with the meter off, and `--content-max` is intact.
**[measured]** Three things are wrong at this size and one of them (2.6) is visible in the shipped
binary.

---

## 3. Check 2 — the feed's scroll FPS, re-measured on the 28 px row

### 3.1 The claim under test, and why it was stale

`docs/STATUS.md:145` says *"window refresh rate | 60 Hz over 1,513 one-second samples"*, sourced to
`perceived-performance.md:927`. `src/components/Feed.tsx:21`, `src/App.tsx:112`,
`docs/plans/phase-4.md:183` and `src/components/Feed.test.tsx:14` all restate it, three of them as
*"~110 DOM nodes at 60 Hz over 1,513 samples"* — a **refresh-rate** measurement quoted as a
**feed** metric. `docs/research/panel-review-2026-09-03.md:127` already caught one reviewer making
that exact conflation.

The evidence file had moved on before this order was written:
`~/Library/Application Support/ai.brigadier.app/frame-stats.ndjson` held **1,686** windows, not
1,513, and its last window is `2026-09-03T14:24:05`. **[measured]** The 28 px row landed at
`864a2fe`, **2026-09-04 01:39:07** (`git log -S'ROW_H = 28' -- src/components/Feed.tsx`).
**[measured]** So **every one of the 1,686 windows predates the markup it is quoted about.**

### 3.2 The build this was measured on — a debug build, and why

**Debug.** `npm run tauri dev`: debug Rust profile, vite dev server, React development build,
unminified.

The reason is a defect in its own right. `src/App.tsx:493` gates the Burn panel on
`import.meta.env.DEV`, so a production `vite build` strips it: `grep -c "burn harness"
dist/assets/index-C6HFYllm.js` = **0**, `grep -c "rows/s each"` = **0**. The Rust side is present —
`strings target/release/brigadier` hits `burn started`, `brigadier-burn` and the
`rowsPerSec durationS fixture` argument names. **[measured]** So `--features burn` compiles a
command the shipped UI has no way to call, and running the load generator in a release build would
require editing `src/App.tsx`, which this order forbids.

Both halves of the debug build are **strictly worse** than what ships. A clean pass under it would
have been a strong result; the near-pass below is therefore an upper bound on how bad the shipped
build is, and says nothing stronger. **[asserted]**

### 3.3 The load, and proof it landed

Burn panel defaults, which are `feed-rendering.md` §4's own signature: **10 sessions x 200 rows/s
each x 60 s, fixture `s1-handshake-and-turn`**. Confirmed in the dev log:

```
09:28:28 burn started sessions=10 rows_per_sec=200.0 script_len=7 seconds=60.0
09:29:28 burn finished sessions=10
```

**[measured]** Window 1280x800 (viewport 1280x768). The feed was scrolled throughout with synthetic
pixel scroll-wheel events at ~105/s over the scroller, direction flipped every 0.5 s, 6,546 events
in 62 s. **[measured]** The app was verified `frontmost` at six 10-second polls during the run.
**[measured]**

Delivered: the overlay's cumulative counters went 102,842 rows / 7,854 batches → **205,785 rows /
15,741 batches**, i.e. **~102,900 rows in 60 s = ~1,715 rows/s**, 86% of the 2,000/s nominal.
**[measured]** The feed reported `2000 rows (capped at 2000)` and a `Jump to latest` pill, which is
the proof the scroll actually detached the view from the tail. **[measured]**

### 3.4 The numbers — run 3, the verified run

62 one-second windows, read out of `frame-stats.ndjson` by `window_start_ms`, not off the overlay.

| metric | value |
|---|---|
| one-second windows | **62** |
| `hz` | **60 in all 62**; `hz_source = p50` in 0 windows |
| frames per window | median 60, min 57, max 61 |
| `p50_ms` | median **17.0**, min 17.0, max 17.0 |
| `p95_ms` | median **18.0**, p95 18.0, max 18.0 |
| `p99_ms` | median 18.0, p95 19.0, **max 83.0** |
| `worst_ms` | median 18.0, p95 19.0, **max 83.0** |
| dropped vsyncs | **4 total**, all in one window |
| longest drop run | **1** |
| `dom_nodes` | median **505**, min 471, max 509 |
| `fps.windowPasses` | **61 / 62** |

The one failure: `12:28:59` — `dropped = 4` and `worst 83.0 ms > 3 x 16.67 = 50.00 ms`
(`p50 17, p95 18, dom 505`). **[measured]** `p95` never failed in any window: 18.0 is inside the
18.33 ms limit everywhere.

The Burn panel's own verdict for the same run, which is `fps.summarise` over its own capture:

```
FAIL · 61 windows · min 60 Hz (budget 16.67 ms, p95 limit 18.33 ms) · worst window p95 18 ms ·
worst frame 83 ms · dropped 5 · longest drop run 1 · dom 509 · hz from p50 in 0 window(s)
```

**[measured]** (screenshot: `run3-summary.png`). It counts 61 windows and 5 drops against my 62 and
4 because its capture starts at the click and mine started 2.5 s later and ran 4.5 s past the burn.
Both fail, and they fail on the same window.

### 3.5 Two control runs, for shape

| run | load | windows | hz | p50 | p95 | dropped | worst | dom median | pass |
|---|---|---|---|---|---|---|---|---|---|
| 1 | burn + scroll, **front-most not verified** | 58 | 60 | 17.0 | 18.0 | 12 in 4 windows | 98 | 448 | 54/58 |
| 2 | **scroll only**, static 2,000-row feed, no burn | 66 | 60 | 17.0 | 18.0 | 2 in 1 window | 28 | 455 | 65/66 |
| 3 | burn + scroll, front-most verified | 62 | 60 | 17.0 | 18.0 | 4 in 1 window | 83 | 505 | 61/62 |

**[measured]** Run 1 must be discounted: another application was in front of the window by the end
of it, so an unknown share of its scroll events went elsewhere. Run 2 says scrolling on its own is
essentially clean — one window, two drops, worst frame 28 ms. **The drops come from the ingest, not
from the scroll.** **[measured]** + **[asserted]**

### 3.6 `dom_nodes`, and what the 28 px row actually cost

The 110 median and the 505 median are **not comparable**: `dom_nodes` is
`document.getElementsByTagName("*").length` (`src/fps.ts:182`) — the whole document, sidebar
included — and 110 came from the owner's idle browsing while 505 is a 10-session burn with 20 burn
sessions and a project tree in the sidebar. Comparable figures on the current markup, read off the
meter at idle with an empty feed:

- **123** — release build, 800x500 window **[measured]**
- **139** — debug build, 1280x800 window **[measured]**

Against the historical idle median of 110, the current markup is 13–29 nodes heavier at idle, which
is sidebar content, not the row.

The row itself is now **2 DOM nodes**:

```html
<div class="feed-row" title="…" style="height: 28px; transform: translateY(38136px);">
  <span class="feed-line">tool Bash done · cargo check · finished in 2s</span>
</div>
```

3 when it carries a `.feed-mark`. 23 rendered rows cost **47 nodes** under `.feed-sizer`.
**[measured]** (Chromium + mock at 1280x768; the markup is the same in both engines.) The
virtualizer is holding and the "fewer spans" claim in `Feed.tsx`'s header is true.

### 3.7 Verdict on Check 2

- **60 Hz: holds, and is now measured on the current markup.** 62 of 62 windows report `hz 60` with
  `p50 17.0 ms`. The 16.67 ms budget stands; the ProMotion trap in `perceived-performance.md` §5.4
  is still the right call. **[measured]**
- **"1,513 one-second samples": superseded as a citation.** The file is at 1,833 lines now and was
  at 1,686 before this run; the 1,513 slice ended `2026-09-02T13:49:44`, and every window in the
  file predates `864a2fe`. Quote "60 Hz over 62 windows under a 10-session burn, 2026-09-04"
  instead, or re-derive from the file. **[measured]**
- **"dom_nodes median 110": superseded, and it was never a feed metric.** 123 / 139 at idle on the
  current markup, 505 under a 10-session burn. **[measured]**
- **The burn does not pass its own gate.** 61/62 windows pass `fps.windowPasses`; one drops 4
  vsyncs with an 83 ms frame. Under `feed-rendering.md` §4's rule — a run passes only when **every**
  window passes — **this run is a FAIL**, and the panel says so in red. On a **debug** build, so
  this is not yet a statement about the shipped binary. **[measured]**

---

## 4. Screenshots and raw data

All under
`/private/tmp/claude-501/-Users-stephen-Development-brigadier-ai/3b5a9ba6-b409-416a-b79a-b3e74e2d2676/scratchpad/`:

| file | what |
|---|---|
| `tauri-800x500.png` | real release window, 800x500, empty feed |
| `tauri-800x500-burn.png` | same, burn project selected |
| `tauri-800x500-session.png` | same, a 48-row session — 8 rows visible, rows flush to both edges |
| `tauri-800x500-fpson.png` | same, meter on — the header title is gone (§2.6) |
| `chrome-800x468-fpsoff.png` | Chromium + mock, 800x468, approval open — feed is a 39.5 px sliver |
| `chrome-800x500.png`, `chrome-932x600.png`, `chrome-1280x768.png` | the gutter progression (§2.4) |
| `dev-1280x800.png`, `dev-burnpanel.png` | debug build and the burn panel defaults |
| `run3-panel.png`, `run3-summary.png`, `run3-overlay.png` | run 3 running, its FAIL verdict, its ingest counters |
| `run2-t10..t60.png` | run 2, front-most evidence |
| `run1-windows.json`, `run2-windows.json`, `run3-windows.json` | the per-window `FrameStats` slices |
| `cargo-test.log`, `cargo-clippy.log`, `cargo-doc.log`, `npm-test.log`, `tsc.log`, `tauri-build.log`, `exit-codes.txt` | §1 |

No script was left in the repo.

---

## 5. Side effects of running this

- The two burns added **20 synthetic sessions** to the `burn` project in
  `~/Library/Application Support/ai.brigadier.app/brigadier.sqlite`, plus their rows. Not cleaned
  up. **[measured]**
- `frame-stats.ndjson` grew from 1,686 to **1,833** lines. Any future citation of a window count in
  that file must say which slice it means. **[measured]**
- `target/release/bundle/` now holds a `brigadier.app` and a `.dmg` built **with `--features
  burn`** — not a shipping artefact. **[measured]**

---

## 6. Proposed source changes — proposals, not edits

None of these were made. Each is one line of CSS except the last.

1. **`src/index.css:1120-1125`, `.feed-sizer`** — the feed has no side gutter on any window
   narrower than 932 px, including the enforced minimum (§2.4). Add
   `box-sizing: border-box; padding-inline: 16px;` (or `max-width: min(var(--content-max), 100% -
   32px)`). Safe: below 1200 px `src/index.css:1729-1735` already moves `.feed-mark` inline, so
   nothing is positioned in the margin that padding would collide with; above 1200 px the margins
   exist and the padding never binds. Fixes the `.feed-count` mismatch at `src/index.css:1097` for
   free.
2. **`src/index.css:1635` + `:1643`, `.fps`** — `flex: 0 0 auto` with `white-space: nowrap` starves
   `.head-id` to width 0 and overflows the page by 205 px at vw 800, hiding the thread title in the
   shipped binary (§2.6). Change to `flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow:
   ellipsis;`, or render only `hz` + `dropped` below the 1200 px breakpoint.
3. **`src/index.css:1296`, `.approvals { max-height: 42vh }`** with `src/index.css:1413`'s fixed
   160 px `.dock` — at the minimum height the feed is left 59.5 px, 1.39 rows (§2.5). Either give
   `.feed` a `min-height` of ~112 px (4 rows) and make `.approvals` `flex: 0 1 auto`, or cap it at
   `min(42vh, calc(100vh - 324px))`.
4. **`src/App.tsx:493`** — `dev={import.meta.env.DEV ? <Burn … /> : undefined}` makes the `burn`
   cargo feature unreachable: a release build compiles the Rust command and ships no UI that can
   call it (§3.2). If `--features burn` is meant to be usable, the panel needs the same kind of gate
   the meter has (a `localStorage` flag, or a build-time `define`), so a release-profile burn can be
   measured without editing source.
5. **`docs/STATUS.md:145`** and the four restatements at `src/components/Feed.tsx:21`,
   `src/App.tsx:112`, `src/components/Feed.test.tsx:14`, `docs/plans/phase-4.md:183` — the
   "60 Hz / 1,513 samples / 110 DOM nodes" sentence is a refresh-rate measurement quoted as a feed
   metric, and its evidence predates the markup it describes. §3.7 has the replacements.

---

## 7. What was NOT checked

> **Superseded 2026-09-10: brigadier is dark-only.** The light palette and the theme switch were
> removed by owner decision, so "no light mode" below is no longer a gap — there is no light mode
> to check. Everything else in this section stands.

- **No release-profile burn.** Every Check-2 number is a **debug** Rust binary served by the vite
  dev server, i.e. a React development build and unminified JS. Reaching a release burn needs the
  change proposed at §6.4. The shipped binary's scroll FPS under load is **unmeasured**.
- **Chromium is not WKWebView.** §2.4's viewport sweep, §2.5's thread-child heights, §2.6's
  `scrollWidth` arithmetic and §3.6's per-row node count are Chromium 152 against the **mock**
  bridge. The claims that were also reproduced in the real WKWebView window say so explicitly; the
  rest are the weaker result and should be read as such.
- **No live approval in the real window at 800x500.** §2.5's 42vh arithmetic was measured in
  Chromium and confirmed only against the CSS, not against a real pending approval in the Tauri
  window.
- **The failing window was not diagnosed.** Whether the 83 ms frame at `12:28:59` is GC, a batch
  spike, the `osascript` front-most poll that fires every 10 s, or something in the debug build, was
  not established. It was not reproduced deliberately.
- **n = 1 for the verified burn.** Run 3 is a single 62-window run. Run 1 is the same load with an
  unverified front-most and is discounted. There is no distribution across repeats.
- **Only one row-count regime.** The feed was capped at 2,000 rows throughout; behaviour at
  `feed_cap` orders of magnitude larger is unmeasured.
- **One display, one scale.** Everything is `devicePixelRatio 2` on the built-in panel. Nothing was
  checked at dpr 1, on an external display, or at a non-default macOS text size.
- **Widths between 960 and 1200 px** were sampled at exactly one point (932, which is below 960).
  The 960–1200 band, where the sidebar is 276 px and the mark is inline, was not examined.
- **No light mode, no `prefers-reduced-motion`, no keyboard-only or VoiceOver pass** at the minimum
  size.
- **`cargo clippy` and `cargo doc` ran incrementally** (0.50 s and 0.21 s) off the artefacts
  `cargo test` had just built. Exit 0 with `-D warnings` is the gate and it passed, but neither was
  a from-scratch compile.

---

## 2026-09-04, later: confirmed (or not) in WKWebView

§2's three CSS defects were fixed and measured in **headless Chromium against the mock**. This
section re-measures them in the **real release WKWebView window against the real Rust feed**, and
adds a fourth check the fix wave introduced (the verbose toggle). Nothing was fixed here; two new
observations are reported, not repaired.

### 8.0 Lock state, build identity, and spend

| when | probe | result |
|---|---|---|
| 13:02:42, before anything | explicit | `locked = None`, `onConsole = True` **[measured]** |
| 13:15:43, after everything | explicit | `locked = None`, `onConsole = True` **[measured]** |
| 13:03–13:15, between | implicit | every `System Events` AX call against `brigadier` returned real geometry; cross-app AX is blocked on a locked screen **[measured]** + **[asserted]** |

No measurement was taken with the screen locked. **[measured]**

**No rebuild.** The existing release bundle already matched the tree, so it was used as-is:

| artefact | mtime |
|---|---|
| `target/release/bundle/macos/brigadier.app/…/brigadier` | 2026-09-04 **13:01:21** |
| `dist/assets/index-tV-irQDV.css`, `index-DNofJyHN.js` | 2026-09-04 **13:01:03** |
| newest file under `src/` (`src/index.css`) | 2026-09-04 **12:58:46** |

**[measured]** The bundle post-dates every source file. The four rules are in the shipped CSS
verbatim (`grep` on `dist/assets/index-tV-irQDV.css`): **[measured]**

```css
.feed-sizer{width:100%;max-width:min(var(--content-max),calc(100% - 32px));margin:0 auto;position:relative}
.fps{text-overflow:ellipsis;…min-width:0;max-width:55%;…white-space:nowrap;…flex:0 auto;…overflow:hidden}
.feed{flex-direction:column;flex:auto;min-height:132px;padding-top:20px;display:flex;position:relative}
.approvals{width:100%;max-width:var(--thread-max);flex-direction:column;flex:0 auto;min-height:0;max-height:42vh;…}
```

(`flex:0 auto` is the minifier's spelling of `flex: 0 1 auto`; `flex:auto` of `1 1 auto`.)
`VITE_BURN` was unset for this build, so the burn panel is absent
(`grep -c "burn harness" dist/assets/index-DNofJyHN.js` = **0**) — not needed here. **[measured]**

**Spend: none.** `pgrep -x claude` before `22589 30298`, after `22589 30298`, byte-identical.
**[measured]** No session was started, no turn was sent, `cargo test -- --ignored` was never run.
The store is byte-equal in content on both sides of the run — `feed` **20,037** rows, `sessions`
**43**, `approvals` **1** before and after. **[measured]**

### 8.1 Method — AX geometry, not pixels

The earlier run measured by pixel analysis of screenshots. This one reads geometry straight out of
the accessibility tree (`System Events` → `position`/`size` of each element, in screen points),
which is exact rather than inferred, and cross-checks two of the numbers against pixels.

The window was pinned at screen `(100, 100)` throughout, so **viewport x = screen x − 100**. The
WKWebView's AX scroll area reports `position (100, 132)`, `size 800 x 468` at an 800x500 window —
which **confirms §2.2 independently**: the title bar is 32 pt and the CSS viewport is
**800 x 468**, not 800 x 500. **[measured]**

Session used for every measurement below: `e5b117f8-3f73-4825-9530-48c712a80e24` (sidebar
`73fb34e3`), a real 24-row session of the `brigadier-ai` project. **[measured]**

Screenshots (dpr 2) under
`/private/tmp/claude-501/-Users-stephen-Development-brigadier-ai/3b5a9ba6-b409-416a-b79a-b3e74e2d2676/scratchpad/`:
`v1-launch.png`, `v2-session-73fb34e3.png`, `v3-verbose-on-unknownsession.png`,
`v4-burn-verbose-on.png`, `v5-burn-verbose-off.png`, `v6-unknown-terse.png`, `v7-unknown-terse.png`,
`v8-1280x800.png`, `v9-final-800x500.png`.

### 8.2 Claim 1 — `.feed-sizer` gutters: **CONFIRMED**, and at four widths

`.feed-sizer` box, `.feed-band` right edge, in viewport px: **[measured]**

| window | viewport | sidebar | pane | `.feed-sizer` | left gutter | right gutter | `.feed-band` right |
|---|---|---|---|---|---|---|---|
| 800x500 | 800x468 | 220 | 220 → 800 | **236 → 784** (548) | **16** | **16** | **784** |
| 932x600 | 932x568 | 220 | 220 → 932 | **236 → 916** (680) | **16** | **16** | **916** |
| 1000x700 | 1000x668 | 276 | 276 → 1000 | **292 → 984** (692) | **16** | **16** | **984** |
| 1280x800 | 1280x768 | 276 | 276 → 1280 | **422 → 1134** (712) | 146 | 146 | **1134** |

Claimed `0 / 0` → `16 / 16`: **confirmed exactly**, and the band's right edge equals the sizer's
right edge at **all four** widths, including 1280 where the `min()` term stops binding and
`--content-max` takes over. §2.4's "the ellipsis of a truncated row lands at pt 798.5 of an 800 pt
window" is gone: the row box now ends at **784.0**, and pixel analysis of `v2-session-73fb34e3.png`
puts the row separator rule at pt **236.0 → 784.0** and the count's last glyph ink at pt **783.0**.
**[measured]**

The real window and Chromium **agree to the pixel** here. **[measured]**

### 8.3 Claim 2 — `.fps` and `.head-id`: **CONFIRMED** (with one caveat on the overflow half)

At viewport 800 the `.thread-head` content box is `236 → 784` = **548 px**, `gap: 12px`.
**[measured]**

| element | claimed | measured (AX) | measured (pixels) |
|---|---|---|---|
| `.head-id` | 0 → **~234** | **234** (548 − 12 − 302) | line-1 ink 237.0 → 453.5 |
| `.fps` | shrinkable | **303** wide, right edge **785** | border box pt **482.5 → 784.0** = **301.5** |
| `55%` cap | — | 55% × 548 = **301.4** — the cap is binding, to 0.1 px | — |
| meter ellipsis | yes | AX name is the full 101-char string, drawn clipped | visible in `v9-final-800x500.png` |

`.head-id` recovering to **234** against a claim of **~234** is the strongest single result in this
section: this is the one defect §2.6 had reproduced in a real release window, and the real window
now gives the number the Chromium fix predicted. **[measured]**

**The overflow half is confirmed by element geometry, not by `scrollWidth`.** No element's box
exceeds the viewport at any of the four widths — the widest, `.fps`, ends at viewport **785 / 800**
and at **1264 / 1280**. **[measured]** But `documentElement.scrollWidth` cannot be read: this is a
release build with no `devtools` feature (`src-tauri/Cargo.toml`), so there is no inspector, and
`body { overflow: hidden }` (`src/index.css:250-254`) means **the absence of a horizontal scrollbar
is not evidence about overflow** — `AXHorizontalScrollBar` is `missing value` at every width, and
would be with or without the fix. So "**199 px → 0**" is confirmed as "no box overflows the
viewport", and the `scrollWidth` figure itself stays a Chromium number. **[measured]** +
**[asserted]**

**The meter did not need to be turned on.** It was already on at launch — `src/fps.ts` `readEnabled`
persists to `localStorage`, and the earlier run left it enabled. The pill was therefore never
clicked; the meter was live in every screenshot from `v1-launch.png` onward. **[measured]**

### 8.4 Claim 3 — `.feed { min-height: 132px }` + `.approvals { flex: 0 1 auto }`: **COULD NOT TEST**

Exactly as the order predicted. The store holds **one** approval row,
`e5b117f8-…:approval:1`, and it is **resolved** (`resolved_at` is not null), so `pending_approvals`
returns empty and the dock never opens. **[measured]** The sidebar renders `Approvals` as static
text with no count, and no `.approvals` element exists in the AX tree at any point in this run.
**[measured]**

Opening it would need either a live session (which costs the owner money and was forbidden) or a
write to the owner's database (forbidden). **Neither was done. The 59.5 px → 132 px claim is
unconfirmed in WKWebView and remains a Chromium-plus-mock result.** **[measured]** = nothing.

What *can* be said: both rules are present in the shipped CSS (§8.0), and with no approval open at
800x500 the feed shows **8 rows** and is nowhere near its 132 px floor, so the new `min-height`
changes nothing in the state that was reachable. **[measured]**

### 8.5 Claim 4 — the verbose toggle and the 10,037 `unknown` rows: **CONFIRMED**

The store's kind histogram, over all 20,037 rows: **[measured]**

| kind | rows |
|---|---|
| `unknown` | **10,037** |
| `think` | 3,326 |
| `text` | 3,326 |
| `sys` | 1,683 |
| `turn` | 1,665 |
| everything else (`tool`, `user`, `sub`, `appr`, `warn`, `err`) | **0** |

**An `unknown` row survives both settings.** The `brigadier-ai` project's three sessions hold 37
rows and **all 37 are `kind='unknown'`**. Selecting `73fb34e3` (24 of them) and reading the count
out of the AX tree: **[measured]**

| setting | `aria-pressed` | count reads |
|---|---|---|
| terse (default) | `verbose=0` | **`24 rows`** |
| verbose | `verbose=1` | **`24 rows`** |

Not one of the 24 is hidden under either setting. That is the serious defect the order was hunting
and it is **not present**.

**And the toggle is not a no-op.** Burn session `02632d21-…` (sidebar `8b0374`), whose stored rows
are 33% `text`: **[measured]**

| setting | count reads | hidden |
|---|---|---|
| verbose | **`48 rows`** | 0 |
| terse | **`33 of 48 rows`** | **15** model-prose rows |

15/48 = 31%, against 166/500 = 33% `text` in that session's stored rows — the filter removes
`text` and nothing else. The count reports both numbers whenever they differ, so a feed with holes
in it says so. `v5-burn-verbose-off.png` shows the terse view holding only `sys`, `think` and
`turn` lines. **[measured]**

### 8.6 The `err` and `appr` treatments are exercised by **no row at all**

The order asked whether any real row reaches `.feed-line.bad` / `.feed-line.ask`, given that
`src/mock.ts` pushes a `request-opened` signal with no feed row. The answer is worse than "not in
the mock":

- **The owner's store contains 0 rows of kind `err` and 0 of kind `appr`**, out of 20,037.
  **[measured]** Every row that *reads* like one — this session's `approval asked · Bash` and
  `approval allowed`, visible in `v8-1280x800.png` — is stored as `unknown`, because it predates
  migration 1, and renders as ordinary grey body text with no weight. **[measured]**
- `src/mock.ts`'s own header now says the same thing about itself: `turn`, `warn`, `err`,
  `unknown` and `appr` "have no source here". **[source]**

So both per-kind treatments have been verified only by forcing a class, in either engine. Neither
has ever been drawn from a stored row. **[measured]**

### 8.7 Two observations — reported, not fixed

1. **`max-width: 55%` truncates the frame meter at the default window size, where it used to fit
   whole.** `src/index.css:1787-1792`. At 1280x800 the header content box is 972 px and the meter's
   `nowrap` string is ~757 px — it would have fitted with 203 px left for `.head-id`. The cap gives
   it **535 px** (55% × 972) and it renders as
   `60 Hz · p50 17 · p95 18 · p99 18 · worst 18 ms · 0 dropped (run 0) · dom 1…`, losing `dom` and
   `rows … in … batches`. **[measured]** (`v8-1280x800.png`.) The CSS comment argues for exactly
   this trade — "the meter is diagnostic and the title is content" — so it is a deliberate cost,
   not a bug; it is recorded because §2.6's fix was justified by an 800 px failure and the price is
   paid at **every** width, including the 1280x800 default. A `min()` against the meter's own
   content, or the "render only `hz` + `dropped` below 1200 px" alternative §6.2 already named,
   would pay it only where it is needed.
2. **The window vanished from the AX window list during a rapid resize loop and `open -a` would not
   bring it back.** After four `set size` calls in ~10 s, `count of windows` returned **0** while
   the process (pid 96835, started 13:03:56) stayed alive and `AXHidden` was `false`;
   `AXWindows` still held one entry. Recovered by clicking `Window ▸ brigadier`. **[measured]**
   **Not reproduced, and not attributable to this diff** — it is an AppleScript-driven resize
   sequence no user performs, and nothing in the CSS or TS diff touches window management. Noted
   only so the next run that sees it knows it has been seen. All measurements above were retaken
   after the recovery.

### 8.8 What was NOT checked in this section

> **Superseded 2026-09-10: brigadier is dark-only.** "No light mode" below is no longer a gap.

- **Claim 3, at all.** §8.4. No approval was opened, in any engine, in a real window.
- **`documentElement.scrollWidth` in WKWebView.** §8.3. No devtools in a release build; the overflow
  result is element-geometry-only.
- **The pre-fix baseline was not re-measured.** The "before" numbers (0 px `.head-id`, 0/0 gutters,
  ink at pt 798.5) are quoted from §2.4 and §2.6, not re-derived; the tree was not reverted.
- **`.feed-line.bad` and `.feed-line.ask` were not seen rendered.** §8.6. No row of either kind
  exists to draw.
- **The frame meter's numbers were not re-measured.** `p50 17 / p95 18` appear in the screenshots
  because the meter was already on; no burn was run, no window was captured, §3 is untouched.
- **One display, one scale, dark mode only.** dpr 2, built-in panel, default text size. No light
  mode, no `prefers-reduced-motion`, no keyboard-only or VoiceOver pass.
- **Widths sampled at four points** (800, 932, 1000, 1280) and heights at four (500, 600, 700, 800).
  Nothing between, and nothing above 1280.
- **No gate was re-run.** `cargo test`, `clippy`, `tsc`, `npm test` were not executed in this
  section; §1's exit codes are from the earlier run on this same tree.
