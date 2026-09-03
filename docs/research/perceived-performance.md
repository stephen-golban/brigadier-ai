# Perceived performance: cold start, session switch, first paint

Date: 2026-09-02. Scope: everything about feeling instant that is **not** streaming a live feed —
launching the app, opening a session that already has history, showing an action before Rust
confirms it, what to cache between launches, and how to measure any of it on macOS.

Assumes and does not repeat: `substrate.md` (the renderer is the wall; coalesce per frame;
virtualize; never markdown per token), `feed-rendering.md` (virtualizer choice, rAF ingestion, row
cost, batch caps, honest FPS), `tauri-runtime.md` §3–§4 (Channel semantics, the 8192-byte
threshold, ordering, drop), `persistence.md` (what SQLite holds; raw traffic goes to NDJSON).

Tags: **[measured]** run on this machine today, command and number shown · **[documented]** vendor
docs, URL + fetch date · **[source]** read in crate/app source, file:line · **[asserted]** reasoned,
not verified.

## Environment

| Thing | Value | How |
|---|---|---|
| macOS / WebKit / Safari | 26.5.2 (25F84) / 21624.2.5.11.8 / 26.5.2 | `sw_vers`, `Info.plist` **[measured]** |
| CPU / display | Apple M4 Pro / Liquid Retina XDR (ProMotion) | `system_profiler` **[measured]** |
| `tauri` / `wry` | 2.11.5 / 0.55.1 | `Cargo.lock` **[source]** |
| Binary under test | `target/release/bundle/macos/brigadier.app`, 17,453,888 B, built 2026-09-02 13:26, adhoc/linker-signed | `ls -la`, `codesign -dv` **[measured]** |
| Frontend bundle | `dist/assets/index-li7tr5BN.js` 258,493 B raw / 81,140 gzip / 70,640 brotli-11; CSS 12,693 / 3,071 / 2,664 | `wc -c`, `gzip -9`, `brotli -q 11` **[measured]** |
| `claude` on PATH | `/Users/stephen/.local/bin/claude` → 2.1.258, a **native arm64 Mach-O**, not a Node script | `file`, `--version` **[measured]** |
| SQLite | `sqlite3` CLI 3.51.0 (Apple); app links rusqlite `bundled` 3.53.2 | **[measured]** / `persistence.md` |
| Owner's live database | 1,613,824 B main + 218,392 B WAL, 394 pages @ 4096, 10,037 feed rows, 23 sessions, 2 projects | copied read-only to scratchpad, `sqlite3` **[measured]** |

Every app launch below ran with `HOME` redirected to a scratchpad directory, so `app_local_data_dir()`
resolved outside the owner's data directory and nothing in it was written. The owner's database was
copied, never opened in place.

---

## Budgets

The numbers the app should be held to. "Status" says whether the figure is a measurement of today's
build, a measurement of a component with the rest reasoned, or a guess with nothing behind it.

| Budget | Target | Today | Status |
|---|---|---|---|
| **B1** exec → window on screen with a **painted shell** (not a blank rectangle) | **≤ 200 ms** | **287–295 ms p50**, n=19 across three arms — **~90 ms over budget** and ~100 ms above the arithmetic it replaces. Today those pixels are still React's, not a shell's, so this is the floor the shell has to beat, not the shell's own number | **[measured]** end to end (§1.4) |
| **B2** exec → shell showing the real project/session list | **≤ 350 ms** | **292 ms p50** (155 exec→setup done, +137 to the frontend's first IPC round trip); **replicated at 290.5 p50, n=7**, on a busier machine, with the Rust half at 150.2 against the recorded 155.3–166.4 | **[measured]** (§1.2, replicated §1.4) |
| **B3** exec → shell, first-ever launch (migrations run) | ≤ 400 ms | **291.3 ms p50**, n=7 — supersedes the 314 ms single sample. **Migrations turned out not to be measurably expensive**: 291.3 first-ever against 290.5 warm | **[measured]**, n=7 (§1.4) |
| **B4** click a session → its last screenful painted | **≤ 100 ms p95** | **p50 32.5 ms, range 22–144, n=14** — 13 of 14 under 100 ms; the one over is the first selection of the run, which also mounts the thread surface. **No p95: n=14 cannot support one.** And the budget barely bites — the path is constant-work by construction (§2.7) | **[measured]** (§2.7) |
| **B5** …of which the Rust half (queue + query + serialize) | **≤ 16 ms p95** | **≤ 8.2 ms** worst case measured (§2.2, §2.4) | **[measured]** |
| **B6** click → the rest of the 500-row scrollback filled in | ≤ 250 ms | unmeasured | **guess** — and now the one that matters, because §2.7 shows the cost B4 was written to catch lives here. No call site exists |
| **B7** any button → visible acknowledgement | **≤ 100 ms** | unmeasured | **guess**, grounded in the 0.1 s literature (§3.1). The instrument now exists and is proven (§2.7); this has no call site |
| **B8** frame budget while any of the above happens | **16.67 ms** | 60 Hz confirmed in a real Tauri window | **[measured]** (§5.4) |

**Two of the eight (B6, B7) are unmeasured guesses**, down from three. The instrumentation in §5.3
exists, has been run for paints (§1.4) and now for an interaction: B4 got the first
`beginInteraction` call site at `a0901e5` and is a number (§2.7). B6 and B7 are guesses for a
sharper reason than before — **not "no instrument", but "no call site"**. The instrument is built
and demonstrated; nothing calls it from those two paths. Do not quote them as results.

B1 and B2 are separate on purpose. A window that is on screen with a static shell early and fills in
its list at ~290 ms reads as instant. A window that stays blank until then does not, and that is
what ships today (§1.3) — with the correction that "early" is now known to be ~287–295 ms rather
than the ~190 ms this document once estimated (§1.4).

---

## 1. Cold start

### 1.1 What actually happens at launch, in order

All of this is `tauri` 2.11.5 source, read in the vendored crate at
`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`.

- **The window and webview are created before your `setup` closure runs.** `App::setup` is one
  function: it builds every configured window (`app.rs:2524-2526`), calls
  `app.manager.assets.setup(app)` (`:2528`, a no-op — `lib.rs:313-317`), and only then calls the
  user closure (`:2530-2532`). **[source]**
- Navigation is issued synchronously at window-build time: `wry-0.55.1/src/wkwebview/mod.rs:652-654`
  → `:835` `self.webview.loadRequest(&request)`. `loadRequest` **schedules**; WebKit needs the main
  run loop to progress before anything loads. **[source]**
- All of this runs on the main thread inside the first turn of the event loop:
  `tauri-runtime-wry-2.11.4/src/lib.rs:4173-4174` maps tao's `StartCause::Init` to `RunEvent::Ready`,
  and `app.rs:1418-1429` calls `setup(&mut self)` at `:1424` **before** emitting `RunEvent::Ready` at
  `:1427`. **[source]**
- Plugins initialize **synchronously, on the main thread, at the end of `Builder::build()`** —
  before `run()` is called at all. `app.rs:2440` `initialize_plugins(handle)` →
  `plugin.rs:906-914` → `:999-1012` calls `plugin.initialize` directly. Nine core plugins are
  registered at `app.rs:1238-1251`. `Builder::plugin` itself only pushes into a `Vec`
  (`app.rs:1850-1852`). **[source]**
- **Therefore: a `block_on` inside `setup` stalls the main thread and the event loop at the exact
  moment the window exists and `loadRequest` has already fired.** `async_runtime.rs:272-275` →
  `:132` `Runtime::Tokio(r) => r.block_on(task)` parks the calling thread. Nothing paints, no
  `tauri://` scheme task is serviced, and `RunEvent::Ready` does not fire, until it returns.
  **[source]**
- This app does exactly that: `src-tauri/src/lib.rs:90` `tauri::async_runtime::block_on(state::build(data_dir))`.
  `state::build` (`src-tauri/src/state.rs:208-243`) does `create_dir_all`, `Store::open` (flock,
  migration ladder, pragmas, approval expiry, stale-session settle), `open_pid_dir` + `sweep`
  (which can `SIGTERM` a process group and wait `DEFAULT_GRACE` = 400 ms), and
  `probe(&supervisor).await`, which spawns `claude --version` and awaits it. **[source]**
- The frontend is served from `tauri://localhost` in a bundled build (`manager/mod.rs:353-367`;
  `manager/webview.rs:447,467`), and the scheme handler is **asynchronous** — it `spawn`s onto the
  tokio runtime rather than reading assets on the main thread (`protocol/tauri.rs:98-104`).
  **[source]**
- Assets are embedded brotli-compressed at **quality 9** in release
  (`tauri-codegen-2.6.3/src/embedded_assets.rs:290-302`, `:376-384`) and decompressed **per request
  at runtime** into a `Vec::with_capacity(compressed_len)` — sized to the compressed length, so a
  258 KB JS bundle reallocates repeatedly while inflating
  (`tauri-utils-2.9.3/src/assets.rs:168-177`). The `compression` feature is on by default and this
  repo does not disable it (`tauri-2.11.5/Cargo.toml:84-91`; `src-tauri/Cargo.toml` has
  `features = []` with no `default-features = false`). **[source]** Nobody has published a cost for
  this and it was not measured here.
- **There is no "first paint" signal anywhere in Tauri or wry.** The only load event is
  `PageLoadEvent` (`tauri-runtime-2.11.3/src/webview.rs:84-89`), and on macOS wry maps `Started` to
  `didCommitNavigation` and `Finished` to `didFinishNavigation`
  (`wry-0.55.1/src/wkwebview/navigation.rs:17-25`, `:39-46`) — i.e. roughly window `load`, not
  DOMContentLoaded and not paint. A grep of the whole `tauri-2.11.5/src` for
  `first paint|did_first|content_loaded|DOMContentLoaded` finds nothing relevant. The readiness
  signal has to come from the frontend by `invoke`. **[source]**

### 1.2 Measured breakdown

> This section is component measurement plus arithmetic. **§1.4 observed the same launch end to end
> in the real binary, and the arithmetic here was ~100 ms optimistic.** The `setup` and IPC figures
> below replicated; the ~38 ms navigation-start → FCP estimate did not.

Six launches of the release bundle, `HOME` redirected, `RUST_LOG=info`. Two `tracing` lines bracket
the interesting part: `brigadier started` is the last statement of `setup`
(`src-tauri/src/lib.rs:91`), and the **second** `claude resolved` line is the frontend's
`probeClaude()` on mount (`src/App.tsx:115-116`) having completed a full JS → IPC → Rust → JS round
trip. `tracing_subscriber::fmt` stamps microseconds, so the deltas are real.

```
python3 scratchpad/measure.py     # Popen the binary, poll its stdout, parse the timestamps
```

| Scenario | exec → `setup` done | exec → frontend's first IPC round trip |
|---|---|---|
| First-ever launch (empty data dir, migrations) | 175.3 ms | 314.1 ms |
| Warm, small data dir (n=5) | **155.3 / 166.4 / 153.5 / 157.1 / 161.7 ms** | **294 / 302 / 282 / 290 / 288 ms** |
| Owner's real 1.6 MB DB + 218 KB WAL copied in (n=5) | 163.7 / 176.0 / 179.1 / 173.7 / 161.6 ms | 300.7 / 315.6 / 307.7 / 308.8 / 300.0 ms |
| `claude` removed from `PATH` — no subprocess spawned (n=5) | 143.6 / 147.0 / 152.4 / 146.1 / 147.1 ms | 270.6 / 277.7 / 280.3 / 278.1 / 277.0 ms |

Differences, p50 against the warm baseline: **[measured]**

- opening a real database instead of an empty one: **+15 ms**
- the `claude --version` probe: **+11 ms**. On its own, `claude --version` is p50 7.6 ms, p95 8.0 ms
  over 20 runs, and it is a native arm64 binary, not a Node script — the cheap case. A user whose
  `claude` is an npm shim would pay Node startup here instead, on the main thread, blocking paint.
  **[measured]** + **[asserted]**
- So `setup` itself is roughly **30 ms of the 155 ms**. The other ~125 ms is dyld + Rust init +
  Tauri build + window/webview creation, all before `setup` starts.

That ~125 ms was then measured directly, in isolation, with a 44-line Swift program that creates an
`NSWindow` + `WKWebView` and loads a page over loopback HTTP (`scratchpad/fcp.swift`, built with
`swiftc -O`). It records `Date().timeIntervalSince1970*1000` at start and reads
`performance.timeOrigin` from the page; the difference is **window + WKWebView construction up to
navigation start**:

| Page | window+webview → navStart | FCP after navStart | domInteractive | load |
|---|---|---|---|---|
| Static shell, 400 bytes of HTML+CSS (n=5) | 103.4 / 101.8 / 101.6 / 92.9 / 98.0 ms | **20–28 ms**, p50 26 | 4–6 ms | 5–7 ms |
| **This app's real `dist/`** — 258 KB JS, 12.7 KB CSS, React 19 (n=5) | 116.5 / 94.9 / 107.7 / 101.6 / 115.8 ms | **29–40 ms**, p50 38 | 4–7 ms | 11–18 ms |

The app's React tree really rendered — `document.body.innerText` came back as
`"brigadier ✎ New session ◈ Approvals 1 pending Projects…"` with 253 DOM nodes, because with no
Tauri present `bridge()` falls through to `src/mock.ts`. **[measured]**

**The headline: the whole React 19 + 258 KB bundle costs about 12 ms of first contentful paint over
a 400-byte static page. WKWebView construction costs ~100 ms.** The JS bundle is not the cold-start
problem, and shrinking it is not the lever.

Caveats on that table: it is loopback HTTP, not `tauri://localhost`, so it excludes the brotli
inflate and the custom-scheme handler; it is a bare `NSWindow`, not a tao window with a menu bar;
and the second and later runs served the JS from WebKit's memory cache (`transferSize: 0`) while
still paying full parse and execute.

### 1.3 What moves it, ranked

1. **Get `setup` off the main thread.** `state::build` is ~30 ms today, but its worst case is
   unbounded: `sweep` may `SIGTERM` an orphaned process group and wait `DEFAULT_GRACE` = 400 ms
   (`crates/proc/src/sweep.rs:290-293`; `DEFAULT_GRACE` = 400 ms at `crates/proc/src/sweep.rs:32`), and `claude --version` is
   whatever the user's install costs. Every millisecond of it is a millisecond the webview cannot
   paint, because the window already exists by then (§1.1). Tauri's own splashscreen guide shows the
   shape verbatim — *"Spawn setup as a non-blocking task so the windows can be created and ran while
   it executes"*, `spawn(setup(app.handle().clone()))` — **[documented]**
   https://v2.tauri.app/learn/splashscreen/ (fetched 2026-09-02). Note the same page's inline comment
   *"Runs before the main loop, so no windows are yet created"* is **wrong** for 2.11.5 per
   `app.rs:2524-2526`; take the code, not the comment.
   The cost of moving it: `AppState` becomes "still starting" for a window of time and every command
   must have an answer for that — which it nearly does already, since `AppState` is a two-valued
   ready/failed enum (`state.rs:74-77`) and needs only a third arm.
2. **Paint a static shell from `index.html`, before React.** FCP of a static page is 20–28 ms; FCP
   of the React app is 29–40 ms; but both are measured from navigation start, and navigation start is
   gated by however long `setup` blocks. Putting the sidebar frame, the header and an empty thread
   column in `index.html` as literal markup — same colours, same geometry — means the first paint is
   the app's own shell rather than white, and React hydrating over it is invisible. This is worth
   more than it looks: it converts the *entire* remaining startup into "the list is filling in"
   rather than "nothing is there".
3. **Set `app.windows[].backgroundColor`.** **[documented]** https://schema.tauri.app/config/2
   (fetched 2026-09-02): *"Set the window and webview background color."* This is the documented fix
   for the white flash before first paint, it costs one config line, and it is the difference between
   a white rectangle and a window that already looks like the app during the ~130 ms before FCP.
   Tauri #6027 (CLOSED) is the dark-mode-white-flash report this option answers. **[source]** (state
   verified via `gh api`)
4. **Do not reach for `"visible": false` + `show()`.** It is documented
   (**[documented]** https://schema.tauri.app/config/2, `visible` default `true`;
   `WebviewWindow::show()` at `webview/webview_window.rs:2207` **[source]**) and it is what the
   splashscreen guide uses — but tauri **#15652** is OPEN: *"Window created visible:false can
   permanently stop receiving events — listen() resolves but never fires; undeliverable
   EvaluateScript is silently discarded."* **[source]** (state verified via `gh api` 2026-09-02).
   For an app whose entire UI is a `Channel` stream, a window that silently stops receiving evals is
   the worst possible failure. Items 2 and 3 get most of the same benefit with none of that risk.
5. **Nothing here is a bundle-size problem.** The only optimisation page Tauri publishes is
   https://v2.tauri.app/concept/size/ ("App Size"), which is exclusively about binary bytes and says
   nothing about startup; there is no startup-performance page at all. **[documented]** (fetched
   2026-09-02). Turning off `compression` to skip the brotli inflate is the one size-adjacent knob
   with a plausible startup effect, and its size is unmeasured — do not do it on a hunch.
6. **Known-issue watch, not a technique:** tauri **#15517** is OPEN — *"[macOS 26 Tahoe] tao 0.35.3
   panics in did_finish_launching — Tauri 2.11.2 GUI window opens blank"*. Same OS, adjacent
   version. **[source]** (verified via `gh api`)

---

### 1.4 Observed end to end, in the real binary — and B1 misses

The paint instrumentation §5.3 asked for exists (`src/paint.ts`, `report_paint`, `1c8b6f6`) and the
app has now been launched with it. Release binary, `RUST_LOG=info`, one launch at a time, quit
cleanly between runs. **Every run captured both metrics simultaneously**, so they are comparable
run-for-run: §5.2's own recipe (exec → `brigadier started`, exec → 2nd `claude resolved`) and the
new `main_to_fcp_ms` from `paint.ndjson`. n=19. All **[measured]**.

| Arm | condition | n | `main_to_fcp_ms` p50 (min–max) | exec → frontend's first IPC round trip, p50 |
|---|---|---|---|---|
| **A1** | fresh empty `HOME` per run — first-ever launch, migrations run (B3's condition) | 7 | **289.8** (274.8–316.4) | **291.3** |
| **A2** | one reused scratchpad `HOME`, warm (B2's condition) | 7 | **282.0** (272.6–380.5) | **290.5** |
| **B** | the owner's real `HOME` — 1.6 MB SQLite, ~10k feed rows, 23 sessions, 2 projects | 5 | **283.1** (277.9–293.7) | **288.4** |

**These are loaded-machine numbers, not quiet-machine ones.** Load average ran 2.36 → 6.34 across
the arms, with a VM, an Android emulator, two Expo servers, two iOS simulators and Docker helpers
alive throughout. Arm B ran under the highest load and was the fastest. A2 runs 5 and 6 were visibly
perturbed and were **kept, not dropped** — the 380.5 max is one of them.

What it establishes:

1. **A single 756 ms sample from the first-ever launch was noise.** Arm B is that exact condition
   and its p50 is 283.1 — the 756 is 2.7× its own condition's median and 2.0× above the max of all
   19 runs. Both halves of that launch were inflated by the same factor (Rust 2.5×, webview 2.9×),
   which is contention's signature; a slow database or a long `worktree prune` would have inflated
   the Rust half alone. **[asserted]** — by elimination; the neighbour set was never reproduced.
2. **The real data directory costs approximately nothing.** Arm B 283.1 against warm scratchpad
   282.0 — **1.1 ms**, inside the spread.
3. **Migrations cost approximately nothing.** A1 first-ever 291.3 against A2 warm 290.5. The 400 ms
   B3 budget was set expecting they would be expensive. They are not.
4. **The two metrics are comparable on this build, empirically rather than by definition.** `main()`
   starts **~4.9 ms** after exec (p50 over 19 runs, range 4.1–6.4), so the invisible pre-main segment
   is ~5 ms, not the ~25 ms §1.2's arithmetic assumed. And FCP lands within ~3 ms of the frontend's
   first IPC round trip in every arm (p50 −1.5 / −2.1 / −2.9 ms, range −7.0 to +8.4), because
   `probeClaude()` on mount and the FCP report fire in the same React mount tick. **This equivalence
   is a property of today's frontend, not a guarantee**: if `probeClaude()` ever moves off mount it
   breaks, and W4-C / W4-D rewrite exactly that code.

**B1 does not survive.** Adding the ~4.9 ms pre-main segment to `main_to_fcp_ms` gives **exec → FCP
of 287–295 ms p50 across all three arms** — roughly **100 ms above this document's own ~190 ms
arithmetic** and **~90 ms above the ≤ 200 ms budget**.

The decomposition says where it went, and this document predicted it against itself. The estimate
assumed **38 ms** from navigation start to FCP; measured `brigadier started` → FCP is
**132–141 ms** **[measured]**. "Not checked" already said *"The `tauri://localhost` path was never
measured"* — every FCP figure behind that 38 ms came from loopback HTTP in a bare `NSWindow`,
excluding the
custom-scheme handler and the brotli-quality-9 inflate of the bundle. **That unmeasured cost now
looks like it is worth roughly 100 ms** — **[asserted]**, by elimination, not a measurement of the
scheme handler itself. The 132–141 ms it has to explain is **[measured]**.

**2026-09-03, per-stage signposts bound that attribution and refute it as stated.**
`docs/research/launch-signposts.md` decomposes the same launch stage by stage, n=12 warm, release
build, `BRIGADIER_TRACE=1`; its table carries every number here. `state::build`, the `block_on`
inside `setup`, is **8.1 ms** p50, so it is not the missing ~100 ms **[measured]**. Tauri's own
window creation before our setup closure runs, `builder_built` to `setup_entry`, is **108.7 ms**
p50, the first in-app measurement of the ~100 ms WKWebView figure **[measured]**. `setup_exit` to
`page_load_started` is **55.6 ms** p50 and delivers only a 390-byte `index.html`, so the inflate
cannot be there **[measured]**. `page_load_started` to `page_load_finished` is **2.9 ms**, though
that stage is almost certainly not the `load` event **[measured]**. `page_load_finished` to FCP is
**83.3 ms** p50, undivided, and holds the scheme fetch and the inflate of the 271.29 kB bundle
together with React parse, mount and first render **[measured]**. So the scheme-plus-brotli
attribution above is unsupported as stated: its cost is confined to at most that 83.3 ms segment,
and its actual share of it is unmeasured. exec to FCP was **305.3 ms** p50 in that run, consistent
with the 287–295 ms above under concurrent build load **[measured]**.

**2026-09-04, the frontend session split the last undivided segment.** Five launches with
`BRIGADIER_TRACE=1`, one cold and four warm, after the `dcl` signpost (`DOMContentLoaded`, reported
through `report_paint`) landed in `src/paint.ts`; `stage=dcl` printed on all five. Warm medians,
n=4: `page_load_finished` → `dcl`, the subresource fetch plus parse, is **49.6 ms**, and `dcl` →
FCP, React mount plus first render, is **28.5 ms**, for 78.1 ms against the 83.3 ms this section
called undivided **[measured]**. **Fetch plus parse is the larger half, roughly 64/36**, so the
scheme-plus-inflate share above has a **49.6 ms** ceiling rather than an 83.3 ms one, and inlining
the assets or trimming the bundle (now 273.98 kB) is worth up to about 50 ms, not 83. The
2026-09-03 figures replicated on a tree that had since taken the feed redesign and the bundle
growth: `builder_built` → `setup_entry` 104.2 against 108.7, `state::build` 9.3 against 8.1,
`setup_exit` → `page_load_started` 45.0 against 55.6, `main` → FCP 283.9, exec → FCP about 288.8
with 4.9 ms pre-main, inside the 287–295 ms band **[measured]**. That run's cold launch also
corrects the shape of a cold penalty: its page half was 27.6 + 46.0 = 73.6 ms, not inflated, while
`builder_built` → `setup_entry` was **420 ms** cold against about 104 warm — **a cold launch is slow
in Tauri's window creation, not in the page** **[measured]**. Three caveats carried verbatim: the
mount half is **n=4 with an outlier** (60.0 / 23.0 / 29.0 / 28.0) and both endpoints are
page-relative timestamps clamped to 1 ms, so 28.5 is not a number to plan against; the fetch half is
tight by comparison, four samples inside 1.5 ms; and **every figure in the run was taken with the
display locked** (`CGSSessionScreenIsLocked=1`), which FCP being a render rather than a presentation
timestamp does not fully excuse — landing inside the warm band is weak evidence, not proof, that the
lock did not move it. Full table and method in `docs/research/launch-signposts.md`.

Two things that stay true: today's first contentful paint is **React's, not a static shell's**, so
B1's target is not yet the thing being measured — W3-C now has a measured starting line and a real
gap to close rather than a flattering estimate. And **a launch is not zero-`claude`**: each one
spawns `claude --version` twice, once from `setup` and once from the frontend's mount-time
`probeClaude` (`src-tauri/src/state.rs:180`). No session, no API call, no cost.

`paint.ndjson` works end to end in a real window — the instrument had never been run before this —
and `main_to_fcp_ms` matched its own `tracing` line on **every one of 19 runs**. **[measured]**

**Open question, one sample, do not act on it.** The `a0901e5` run recorded a warm FCP of
**375.9 ms** against the 287–295 ms p50 above. The bundle grew over the same interval, from
263.28 kB to **272.71 kB JS plus a 1.38 kB lazy chunk / 26.91 kB CSS**. That is one sample against a
distribution, and the same run's cold launch (**801.9 ms**) matches the earlier run's cold outlier
(755.9 ms), so the regression is **neither attributable to the bundle growth nor ruled out**. What
would settle it is the n=19 three-arm treatment above, re-run. **B1's row is unchanged on the
strength of one sample**, deliberately.

---

## 2. Opening a session with a long history

### 2.1 There is no long history in SQLite, by design — and that is the answer

The premise "a thread may hold tens of thousands of events" is true of the *provider stream* and
false of *our database*. `StoreConfig::feed_cap` is **500** (`crates/store/src/lib.rs:100`) and
`trim_feed` deletes below the cap **in the same transaction that inserts**
(`trim_feed`, `crates/store/src/writer.rs:601-612`). The owner's live database proves it holds: 10,037 feed rows
across 23 sessions, and every one of the top sessions has **exactly 500**. **[measured]**

So "the last screenful in one cheap query" is not a thing to build. It already exists, and the rest
of §2 is about the three places the cheap query is *not* the cost.

Where the deep history actually lives, per `persistence.md`: our own rotating NDJSON under
`<data_dir>/raw/`, and Claude Code's own transcript at
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` — which the CLI sweeps after
`cleanupPeriodDays` (default 30). Reading either is a **file-scan feature with a different latency
class**, not part of first paint. Design it as "load older" that yields, never as something the
switch waits on. **[asserted]**

### 2.2 The query shape is already optimal — measured

`feed` is `PRIMARY KEY (session_id, seq) WITHOUT ROWID` (`crates/store/src/schema.rs:88-94`), so the
table *is* the index and it is already in `(session_id, seq)` order. `EXPLAIN QUERY PLAN` on the
shipped statement: **[measured]**

```
sqlite3 brigadier.sqlite "EXPLAIN QUERY PLAN SELECT session_id,seq,at,line FROM feed
                          WHERE session_id='…' ORDER BY seq DESC LIMIT 500;"
`--SEARCH feed USING PRIMARY KEY (session_id=?)
```

No `USE TEMP B-TREE FOR ORDER BY`, no separate index, no row lookup — the `ORDER BY seq DESC` is
free because it walks the primary key backwards.

Timings, on the owner's real database and on a synthetic 1,000,000-row / 152 MB feed table with the
same schema (50 sessions × 20,000 rows), Python's `sqlite3` module 3.51.0: **[measured]**

| Table | Query | p50 | p95 |
|---|---|---|---|
| Real DB, 10k rows | `LIMIT 50` | 0.018 ms | 0.019 ms |
| Real DB, 10k rows | `LIMIT 200` | 0.062 ms | 0.068 ms |
| Real DB, 10k rows | `LIMIT 500` | **0.145 ms** | 0.151 ms |
| **1M rows, 152 MB** | `LIMIT 500`, warm | **0.142 ms** | 0.146 ms |
| **1M rows, 152 MB** | `LIMIT 500`, fresh connection each time (cold SQLite page cache) | 0.283 ms | 0.414 ms |
| **1M rows, 152 MB** | keyset page-back: `AND seq < ? ORDER BY seq DESC LIMIT 500` | **0.141 ms** | 0.163 ms |
| **1M rows, 152 MB** | `LIMIT 500 OFFSET 19000` | 0.315 ms | 0.351 ms |

Three conclusions:

- The tail read is **the same cost at 10,000 rows and at 1,000,000** — `SEARCH … USING PRIMARY KEY`
  is `O(log n)` plus 500 sequential rows. Raising `feed_cap` costs disk, not latency.
- **Reverse pagination is already free and its shape is keyset, not `OFFSET`.**
  `WHERE session_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3` plans identically
  (`SEARCH feed USING PRIMARY KEY (session_id=? AND seq<?)`) and costs the same 0.14 ms whatever the
  cursor. `OFFSET` was only 2× worse here because a `WITHOUT ROWID` scan is cheap, but it grows with
  the offset and keyset does not. Use the cursor. **[measured]**
- The one query in the read path that is **not** index-shaped is `list_sessions`
  (`writer.rs:213-222`): `SELECT … FROM sessions ORDER BY started_at DESC, id ASC` plans as
  `SCAN sessions` + `USE TEMP B-TREE FOR ORDER BY`. At 23 sessions that is nothing. At a few thousand
  it is a sort on the startup path, and it costs one `CREATE INDEX sessions_recent ON sessions(started_at DESC, id)`
  to remove. **[measured]** + **[asserted]**

### 2.3 Reads share the writer thread — measured, and it is fine

Every read goes through `StoreHandle::query`, which posts an `Op::Query` to the **single writer
thread** and is executed inside that thread's transaction (`StoreHandle::query`, `writer.rs:172-182`; `apply_batch`, `:390-419`). Two
things make that survivable, and one number settles it:

- A `Query` **closes the 250 ms coalescing window immediately** — the writer loop's condition is
  `while !matches!(batch.last(), Some(Op::Query(_) | Op::Flush(_) | Op::Shutdown))`
  (`writer.rs:331`). A read never waits for the batch window it happened to land in. **[source]**
- It can still queue behind an *in-flight* `apply_batch`. Measured, with the app's real schema,
  pragmas, 10 sessions, insert-plus-`trim_feed` per session per batch, one transaction:
  **[measured]**

| Batch (per 250 ms window) | commit p50 | p95 | max |
|---|---|---|---|
| 10 sessions × 5 rows (steady state, ~20 rows/s each) | 0.27 ms | 0.31 ms | 0.32 ms |
| 10 sessions × 50 rows (200 rows/s each) | 0.78 ms | 3.57 ms | 3.64 ms |
| 10 sessions × 500 rows (**burn**: 2000 rows/s each) | 5.32 ms | 7.89 ms | 8.03 ms |

  `PRAGMA incremental_vacuum(256)` between batches (`writer.rs:352`) measured **0.01 ms**. A
  pathological one-shot trim — dropping 19,500 rows from one session in a single transaction — was
  13.9 ms, and that only happens if `feed_cap` is lowered on an existing database.

**So the entire Rust half of a session switch is ≤ 8.2 ms even under the heaviest load the burn
harness can produce** (worst-case in-flight batch 8.03 ms + 0.15 ms query). Budget B5 is met with
2× headroom, and a separate read-only connection is **not** worth adding. Design attention belongs
on the other side of the IPC boundary.

### 2.4 The 8192-byte cliff applies to command responses, not just Channels — and `feed_tail(500)` is 10× over it

`tauri-runtime.md` §3 establishes the threshold for `Channel::send`. It applies **identically to the
return value of a `#[tauri::command]`**: the invoke response path is `Channel::from_callback_fn`,
whose match arm is the same constant — `InvokeResponseBody::Json(json_string) if json_string.len() <
MAX_JSON_DIRECT_EXECUTE_THRESHOLD` (8192) goes through `eval`; anything larger is parked in
`ChannelDataIpcQueue` and pulled back by a **second** internal invoke
(`plugin:__TAURI_CHANNEL__|fetch`). `tauri-2.11.5/src/ipc/channel.rs:35-39`, `:244-284`. **[source]**

Serialized sizes of the real wire shape (`FeedRowWire { s, q, t, l }`, `src/wire.ts:177-182`),
computed from the owner's actual feed rows: **[measured]**

| `feed_tail(n)` | bytes | bytes/row | over 8192? |
|---|---|---|---|
| 24 | 3,838 | 159.9 | no |
| **48** | **7,694** | 160.3 | **no** |
| 100 | 15,987 | 159.9 | yes |
| **500 (what ships today, `src/App.tsx:40`)** | **80,241** | 160.5 | **yes, ~10×** |

Line bytes in the real data: p50 48, p95 148, max 148 (`FEED_LINE_LIMIT` is 200,
`crates/store/src/feed.rs:24`).

**Recommendation: split the read in two.** `feed_tail(session, 48)` for first paint — 7,694 bytes,
under the threshold, one `eval`, no second round trip, and 48 rows at `ROW_H = 18`
(`src/components/Feed.tsx:25`) is a full 800 px viewport plus the `overscan: 12`. Then, after the
first commit paints, `feed_tail(session, 500)` to fill the scrollback behind the reader. The second
call still crosses the threshold, but it is off the critical path and nobody is looking at it.
**[measured]** + **[asserted]**

Unlike a `Channel`, an oversized *command response* does not head-of-line block anything —
`from_callback_fn` passes `None` for the on-drop callback and sends no `index`
(`channel.rs:246`, `:282`) — so the cost is one extra IPC round trip, not a stall. **[source]**

### 2.5 Two bugs in today's switch path

- **The history is dropped whenever a live row wins the race.** `seedRows` returns early if the
  session already has any rows: `if (existing !== undefined && existing.length > 0) return;`
  (`src/feedStore.ts:543-548`). Selecting a *live* session makes its project visible, so batched
  rows start arriving immediately, while `feedTail` is still in flight (`src/App.tsx:170-178`). If
  one batch lands first, the 500-row tail is discarded and the reader sees three rows of scrollback
  instead of five hundred. The fix is a merge on `seq`, not an early return — the rows are already
  keyed `${r.s}#${r.q}` for the virtualizer (`Feed.tsx:68-71`), so the ordering key exists.
  **[source]**
- **Switching back re-fetches and then throws the result away.** The effect is keyed on
  `selectedSessionId` with no memo of what has already been seeded, so returning to a session pays
  the full 80 KB two-hop response and then hits the same early return. `src/App.tsx:170-178` +
  `feedStore.ts:543-548`. **[source]**

Both are cheap to fix and both are on the critical path of B4.

### 2.6 Avoiding layout thrash when history and live rows arrive together

The virtualizer is `@tanstack/react-virtual` with `anchorTo: 'end'`, `followOnAppend: 'auto'`,
`scrollEndThreshold: 24`, `useFlushSync: false` (`src/components/Feed.tsx:55-72`) — which
`feed-rendering.md` §1 establishes handles both tail-follow and head-drop re-anchoring, the latter
mattering because WebKit 26.5 has no `overflow-anchor`. Two additions specific to *this* moment:

- **Seed and live must be one commit, not two.** Push the tail into the same module-level buffer the
  Channel writes to and let the existing rAF drain commit it (`feedStore.ts:133-135`, `:392-397`).
  Calling `seedRows` directly outside the drain is a second synchronous commit in the same frame,
  which is exactly the "count grew, last key changed" transition `followOnAppend` inspects — running
  it twice against two different counts is how the tail detaches for no visible reason. **[asserted]**
- **`directDomUpdates: true` is recommended by `feed-rendering.md` and is not set today**
  (`Feed.tsx:55-72`). Its documented constraint is that it is *"intended to be set once at mount"*
  and that toggling it at runtime leaves stale inline styles — which is an argument for keying the
  `Feed` component on `sessionId` so a switch remounts the virtualizer with a clean measurement
  cache rather than mutating one in place. **[source]** (`feed-rendering.md` §1) + **[asserted]**
- A switch changes `count` from N to M with every key different. Remounting on `key={sessionId}`
  makes that one mount rather than one reconciliation of 500 rows against 500 different rows, and it
  resets `scrollOffset` to the bottom, which is where a freshly opened thread should be anyway.
  **[asserted]**

---

### 2.7 Observed: B4 is a number, and its budget barely means anything

The shell landed at `a0901e5` with the first `beginInteraction` call site in the repo
(`src/App.tsx`, label `b4-session-painted`). Measured in a real window against the owner's real data
directory, 14 selections across sessions holding 6 to 500 stored rows, every line written to
`paint.ndjson`. All **[measured]**.

```
22 23 25 25 25 26 32 33 36 36 37 39 57 144
n = 14 · min 22 ms · p50 32.5 ms · max 144 ms · 13 of 14 under 100 ms
```

**No p95 appears here and none should be computed.** The budget is written as ≤ 100 ms p95 and
**n=14 cannot support a p95** — at that size the statistic is an order statistic of two or three
samples and moves by tens of milliseconds on one run. The median and the range are what 14 samples
answer. The single sample over budget, 144 ms, is the **first selection of the run**, which also
pays for mounting the thread surface; every later selection landed 22–57 ms.

**The finding is not the number. B4 is close to constant-work by construction, so the budget is
nearly meaningless as written.** `TAIL_ROWS = 48` (`src/App.tsx:68`) caps what a selection paints,
so there is no large-scrollback regime for B4 to be slow in:

- a session with **500 stored rows measured 25 ms** — faster than the median;
- the floor is the double-`requestAnimationFrame` inside `beginInteraction` itself, **~33 ms at
  60 Hz**, and **8 of the 14 samples sit within one frame of it**. A good part of what B4 measures
  is the instrument's own two frames, not the app's work.

This is trap 6 and §2.4 showing up in the budget table: the 48-row cap was chosen because
`feed_tail(session, 500)` is 80,241 bytes against an 8192-byte threshold for data the user cannot
see, and the same decision is why B4 has no slow case to find. **The cost B4 was written to catch
lives in B6** — "the rest of the 500-row scrollback filled in, ≤ 250 ms" — which still has no
call site and is still a guess.

So do not read "B4: 32.5 ms against a 100 ms budget" as *the session-switch path is fast*. Read it
as **the session-switch path is capped, and this is what the cap costs.** Whether the uncapped part
is fast is B6's question and is unanswered.

**The instrument's honesty guarantee was demonstrated end to end**, not reasoned. Re-selecting an
already-selected row starts a span whose layout effect can never run, because React skips the
re-render. After 7 seconds, **zero lines were added** to `paint.ndjson` — the span was dropped
rather than reported against an unrelated later paint. That is `INTERACTION_TIMEOUT_MS`
(`src/paint.ts:132`) doing exactly what its comment claims, observed. **[measured]**

---

## 3. Optimistic UI for agent actions

### 3.1 The thresholds, and where they come from

Read in the primary sources, not in summaries of them.

- **[documented]** Miller, *Response time in man-computer conversational transactions*, AFIPS FJCC
  1968, vol. 33, p. 271, Topic 1: *"This response should be immediate and perceived as a part of the
  mechanical action induced by the operator. **Time delay: No more than 0.1 second.**"* p. 273, for a
  request: *"the acknowledgment should be within **two seconds**… For an impromptu, complex request,
  the delay may extend to five seconds."* p. 277: *"captivity of more than **15 seconds**… can
  readily become a demoralizer… If, therefore, response delays of more than 15 seconds will occur,
  the system had better be designed to **free the user from physical and mental captivity, so that he
  can turn to other activities**."*
- **[documented]** Miller's own caveat, same page, and it is rarely quoted: these are *"the best
  calculated guesses by the author, a behavioral scientist… They should, indeed, be verified by
  extended systems studies… the reader should accept the parameters cited as **indicative rather than
  conclusive**."* The most-cited numbers in interaction design were never measured. Treat them as
  budgets, not physics.
- **[documented]** Card, Robertson & Mackinlay, CHI'91, p. 183, Table 3: perceptual processing
  **0.1 s**, immediate response **1 s**, unit task **10 s** — and the design rule they draw from it,
  *"we attempt to have agents provide status feedback at intervals no longer than this constant"*
  (the 1 s one), explicitly modelled on conversational backchannels.
- **[documented]** Nielsen, nngroup.com/articles/response-times-3-important-limits/ (1993), the
  familiar 0.1 / 1 / 10 s. And nngroup.com/articles/website-response-times/ (2010): *"The 3
  response-time limits are the same today as when I wrote about them in 1993."* The canonical source
  declines to revise them.
- **[documented]** Google, web.dev/articles/rail (updated 2020-06-10): *"0 to 100 ms: Respond to user
  actions within this time window and users feel like the result is immediate"*, with a **50 ms**
  budget for the input handler so the paint still fits.
- **[documented]** Liu & Heer, *The Effects of Interactive Latency on Exploratory Visual Analysis*,
  InfoVis 2014: *"an additional delay of **500 ms** incurs significant costs, decreasing user
  activity and data set coverage… increased latency reduces the rate at which users make
  observations, draw generalizations and generate hypotheses"* — and §6.2, *"**6 out of 16 subjects
  did not report a noticeable difference** in terms of system responsiveness."* This is the one that
  matters most for a supervision harness: latency degraded the work of users who could not perceive
  it. "Nobody will notice" is not a defence.
- **[documented]** Apple HIG, *Loading*: *"Show something as soon as possible. If you make people
  wait for loading to complete before displaying anything, they can interpret the lack of content as
  a problem with your app… consider showing placeholder text, graphics, or animations as content
  loads."* Apple publishes **no numeric threshold** anywhere on these pages — "a moment or two" is
  the whole of it.
- **[documented]** Apple HIG, *Feedback*: *"because people typically expect their action or task to
  succeed, they only need to know when it doesn't."* That sentence is the licence for optimistic UI,
  from the platform vendor.
- **[documented]** Apple HIG, *Alerts*: *"**Avoid displaying alerts for common, undoable actions,
  even when they're destructive.** … when people take an uncommon destructive action that they can't
  undo, it's important to display an alert."* The rule turns on **undoability**, not destructiveness.
- **[documented]** Apple HIG, *Progress indicators*: *"All progress indicators are transient"*;
  *"People tend to associate a stationary indicator with a stalled process or a frozen app"*;
  macOS-specific, *"Avoid labeling a spinning progress indicator."*
- Calibration from shipping desktop code, for how long an app waits before admitting it is working:
  VS Code arms `ProgressLocation.Window` on a **150 ms** timer and then holds it for a **150 ms**
  floor (`progressService.ts:102`, `:127-146`), holds a notification for **800 ms**
  (`:425-431`, *"to reduce the chance of the notification flashing up and hiding"*), arms the
  activity-badge at **300 ms** (`:473-491`), and gives the file explorer **500 ms** before it shows
  anything (`explorerService.ts:217,230`). All **[source]** at commit `9dfde22`.

The synthesis for this app: **anything under ~100 ms needs no feedback at all; 100 ms–1 s needs the
control to change state but not a spinner; past ~1 s the app owes a running acknowledgement; past
~10 s it owes the user their attention back.** No spinner before ~150 ms, and once shown, hold it.

### 3.2 The state of the art in exactly this problem

VS Code ships an agent-session host with a **compile-time-exhaustive table of which transitions a
client may apply before the backend confirms**, and its five entries map one-to-one onto ours.
`src/vs/platform/agentHost/common/state/protocol/action-origin.generated.ts:325+`, commit `9dfde22`
**[source]**; doc comment: *"Exhaustive map indicating which action types may be dispatched by
clients. Adding a new action to StateAction without adding it here is a compile error."*

| VS Code action | client-dispatchable |
|---|---|
| `session/ready`, `session/creationFailed` | **false** — server only |
| `chat/turnStarted` | **true** |
| `chat/toolCallConfirmed` | **true** (but `toolCallAuthRequired` / `authResolved` are false) |
| `session/chatRemoved`, `root/activeSessionsChanged` | **false** |
| `session/isArchivedChanged` | **true** |
| `chat/turnCancelled` | **true** (but `chat/turnComplete` is **false**) |
| `chat/delta`, `chat/responsePart`, `chat/toolCallStart`, `chat/error`, `chat/usage` | **false**, uniformly |

That last row is the principle in one line: **a client may optimistically assert its own intent; it
may never optimistically assert the child process's output.** Note also the asymmetry on cancel —
the *request* is client-dispatchable, the *outcome* is not. The UI says "Stopping…", never "Stopped".
And `chat/usage` — the spend counter — is server-only, which is the answer to whether a
cost-incurring number may ever be guessed.

Two structural ideas worth stealing, both **[source]**:

- **Expose both states.** `agentSubscription.ts:33-46`: `value` is *"the optimistic state (confirmed
  + pending replayed)"*, `verifiedValue` is *"The server-confirmed state with no pending optimistic
  actions applied."* Both are on the interface.
- **Rollback is a protocol message, not an exception.** `agentHostStateManager.ts:1615-1633`
  `rejectClientAction` *"Emits an ActionEnvelope that carries the original ActionOrigin and a
  rejectionReason so the originating client can reconcile (roll back) its optimistic write-ahead
  action through the normal path… The reducer is deliberately NOT run."* And
  `agentSubscription.ts:469-489`: *"A rejected envelope must never mutate confirmed state — it only
  rolls back the originating client's matching optimistic action."*

And the warning that comes with it, which is **our exact feed shape**: microsoft/vscode **#332087**
(open, 2026-08-22) *"Agent host: responses render only at turn end because the optimistic turn start
is never retired"* — the client applies `chat/turnStarted` optimistically and holds it until the
backend echoes the originating `clientSeq`; the host never sends it, so *"replaying a turn start
resets `activeTurn` to a fresh empty turn"* and 2,432 characters painted in one update at **19.4 s**
after 17 deltas had already arrived. PR **#332122** is open and unmerged. **[source]**
**An optimistic entry that outlives its retirement trigger does not just look wrong, it masks the
live stream underneath it** — the opposite of what it was added for.

Three more, briefly:

- **Zed** (`crates/acp_thread/src/acp_thread.rs`, commit `a24cafa`) puts the flag in the model, not
  the view: `UserMessage { protocol_id: Option<MessageId>, client_id, **is_optimistic: bool** }`
  (`:294`), inserts the user message with `is_optimistic: true` inside `run_turn` **before the git
  checkpoint is taken** (`:3672-3684`), and rolls back by **truncation** — on a refusal with no
  completed tool call, `this.entries.truncate(user_msg_ix)` and emit `EntriesRemoved`
  (`:3848-3860`). If a tool call already completed it does not truncate. **[source]**
- **matrix-js-sdk** (commit `28c0775`) is the reference local-echo state machine: six states
  (`event-status.ts:21-38`), an **enforced** `ALLOWED_TRANSITIONS` table that throws on an illegal
  edge (`room.ts:4029-4036`, `:3006-3009`), the echo inserted before any network call
  (`client.ts:2876-2891`), reconciled **in place** on success rather than removed and re-added
  (`room.ts:2916-2948`), and — the part worth copying — **head-of-line blocking by design**: a new
  pending event is forced to `NOT_SENT` if any earlier one already failed, *"Setting event as
  NOT_SENT due to messages in the same state"* (`room.ts:2804-2807`). A failure leaves the message in
  place with a badge; only an explicit cancel removes it. **[source]**
- Element's presentation of that failure is two-tier: a quiet per-message red mark plus one aggregate
  banner with bulk *Retry all* / *Delete all* (`ReceiptAdapter.tsx:83-100`,
  `RoomStatusBarView.tsx:258-303`, commit `638b541`). **[source]**

The terminals disagree with each other, and only half of one is worth copying. wezterm awaits the
PTY before the pane exists at all (`mux/src/domain.rs:59-70`, commit `4fbd6b8`) — so it *cannot*
show a placeholder — but on failure it does the right thing: *"Show the error to the user in the new
pane"*, `write!(writer, "{err:#}")`, *"and return a dummy pane that has exited"* (`:631-658`). The
error lands **inside the surface the user asked for**, already dead, with no dialog. Alacritty does
the reverse — `window.set_visible(true)` (`display/mod.rs:490`) precedes `tty::new()`
(`window_context.rs:201`), so a failed spawn flashes a window that vanishes with only
`error!("Could not open window")` behind it. Copy wezterm's failure surface; copy neither one's
ordering. **[source]** (the alacritty half is a code-order inference, never run)

### 3.3 The verdict per transition, for this app

Latencies are from `claude-direct-spike.md`'s measured fixtures unless noted.

| Transition | Measured latency | Optimistic? | What to show immediately | Rollback |
|---|---|---|---|---|
| **Start a session** | spawn → `initialize` `control_response` **719 ms**; spawn → `system/init` **1981 ms**; plus a `git worktree add` | **No** | The **real** `Starting` row, which already exists (`schema.rs:114-124`) and is what the supervisor writes (`supervisor/src/lib.rs:525`) | n/a — nothing was guessed |
| **Send a turn** | one line to the child's stdin; first `assistant` frame **2070 ms**, `result` **2501 ms** | **Yes** | The user's text in the thread, marked pending | Keep the text, mark it failed; do not truncate |
| **Approve / deny** | resolves an in-memory park; park deadline **600 s** (`driver.rs:28-33`) | **Yes, conditionally** | Dismiss the card | Re-open the card with the error |
| **Interrupt** | `control_response` **1 ms** after the write; `result` `aborted_streaming` at **2076 ms** | **Pointless** | Disable the button | n/a |
| **End session** | stdin closed → `exit 0` in **571 ms** | **No** | An `ending` affordance; the exit arrives on the feed | n/a |
| **Kill** | fixture killed mid-stream at 2139 ms; zero `result` frames | **No** | Disable, then let the feed report | n/a |
| **Remove a worktree** | irreversible; discards uncommitted work | **Never** | The dry-run answer | n/a |

The reasoning, and the parts that are specific to us:

- **Start a session is the one transition where the honest state already exists, so optimism would be
  a downgrade.** `SessionStatus::Starting` is *"Spawned, no `SessionStarted` seen yet"*
  (`crates/store/src/schema.rs:114-124`), the supervisor writes it at spawn
  (`crates/supervisor/src/lib.rs:525`), and `start_session` returns the `SessionView` carrying it.
  Matching VS Code's `session/ready: false`. What is worth changing is *when the sidebar row
  appears*: `Supervisor::start_session` awaits `worktree::prepare` **and** the driver handshake before
  it returns (`crates/supervisor/src/lib.rs:497-512`), so the row does not exist in the UI for most of
  a second. Insert a local row at click time keyed by a client id, in the `Starting` state — that is
  not optimism about the *outcome*, it is honesty about the *attempt*. And it needs
  VS Code's other half: an explicit failure action. `start_session` already returns distinguishable
  codes (`claude_not_installed`, `no_such_project`, `driver`, worktree failures —
  `src-tauri/src/commands.rs:88-115`), so the row can become "failed to start: &lt;reason&gt;" **in
  place** rather than vanishing — which is exactly wezterm's dead-pane-with-the-error-in-it, and the
  opposite of alacritty's vanishing window. Miller's 15-second rule applies here and nowhere else in
  this app: a spawn that runs long must leave the user free to do something else, so the sidebar and
  every other session stay live while one row says `Starting`.
- **Send a turn is the clearest yes, and it is the one with the known trap.** All three references
  echo it locally. Take Zed's placement — the flag on the model (`is_optimistic`), not a view state —
  and matrix's failure semantics — the failed turn **stays in the thread** with a badge, because the
  user's typed text is the thing they would lose. Take matrix's head-of-line rule too: with a failed
  turn pending, block the next one rather than letting turn N+1 reach a child that never saw turn N.
  And take VS Code #332087 as the specification of the bug to avoid: **the retirement trigger is the
  echo of `TurnStarted.turn_id`** (`src-tauri/src/commands.rs:142-152` already returns
  `TurnStarted { turn_id }`), matched against the feed, and it is emphatically **not** "the turn
  finished". Retire on match; if the id never comes back, retire on the session's next terminal
  frame and mark it unknown.
- **Approving is optimistic only while the park is alive.** The answer path is in-memory or it does
  not exist (`persistence.md` §6), so `run_id == current_run_id` is the whole test. Dismissing a card
  whose `run_id` belongs to a lost launch shows the user an approval they did not give — the
  element-web **#15039** failure exactly: *"Element would local echo redact the message… **As a
  result of this misleading UI, it took us a while to work out that there was nothing wrong with
  redactions**"* (open since 2020). `persistence.md` §6 already requires an expired prompt to render
  read-only; optimistic dismissal must be gated on the same predicate. Second guard, from element-web
  **#10036** (*"rapidly changing powerlevel breaks due to local echo being out of sync with remote
  state"*): approvals arrive queued, so serialise the optimistic answers rather than computing each
  against stale confirmed state. **[source]**
- **Interrupt does not need optimism, it needs a disabled button — and the word "Stopping".** The
  spike measured the `control_response` at **2071 ms** against a write at **2070 ms** — one
  millisecond, comfortably inside Miller's 0.1 s, so a local echo is machinery for a problem that
  does not exist. But the *acknowledgement* is not the *outcome*: the aborted `result` frame did not
  arrive until **2076 ms**, and VS Code encodes the same asymmetry by making `chat/turnCancelled`
  client-dispatchable while `chat/turnComplete` is server-only. Say "Stopping…" until the terminal
  frame lands, never "Stopped".
- **Nothing destructive is optimistic, and this app already got that right.** `cleanup_worktree` with
  `force = false` is a **dry run**: a dirty worktree comes back `{ removed: false, dirty_files: N,
  branch }` with *"nothing touched"*, and only a second call with `force = true` discards those N
  entries (`src-tauri/src/commands.rs:199-227`). That is Apple's rule — alert when the destructive
  action is uncommon and not undoable — implemented in the protocol rather than in a dialog. Keep it,
  and do not add an undo window in front of it: the shortest undo window in any of the shipping code
  read here is ~5 s (Zed's autohide toast, `notifications.rs:196-198`), Gmail's send-cancellation
  choices are **[documented]** *"5, 10, 20, or 30 seconds"*, and none of that is compatible with a
  `git worktree remove`.
- **There is no "delete a session" command at all.** The IPC surface is `end_session`, `kill`,
  `cleanup_worktree` (`src-tauri/src/lib.rs:54-75`). When one is added, VS Code's split is the model:
  **archive is client-dispatchable, removal is not** (`session/isArchivedChanged: true` vs
  `session/chatRemoved: false`). A reversible hide can be instant; a delete that also drops feed rows
  through `ON DELETE CASCADE` cannot.

One rule underneath all of it, from VS Code **#167744** (*"Optimistically staged files are inactive
but clickable while status is running… **This causes extra confusion as there is no progress
indicator**"*): **an optimistic entity must be either fully interactive or visibly not-yet-real.**
"Looks real, ignores clicks" is worse than waiting. **[source]**

---

## 4. Caching between launches

The test for every candidate is the same: **what does a stale copy cost, and can the app tell it is
stale?** A cache whose staleness is silent is not a cache, it is a bug with a latency benefit.

### 4.1 Worth it

- **Window geometry.** `tauri-plugin-window-state` **2.4.1** (2025-10-27, crates.io **[source]**).
  Its plugin `setup` reads `.window-state.json` from `app_config_dir()` synchronously
  (`src/lib.rs:396-398`), which per §1.1 runs during `Builder::build()` — *before* the window exists,
  so it does not delay paint. Geometry is applied in `on_window_ready` (`:407-413`), i.e. **after**
  the window is on screen: expect a visible resize/reposition unless the window starts hidden.
  Restoring the size the user chose is worth that; it is the single most "the app remembered me"
  signal there is. `StateFlags::default()` is `all()` (`:62-67`), which includes `VISIBLE` — pin the
  flags explicitly to `SIZE | POSITION | MAXIMIZED | FULLSCREEN` rather than taking the default.
  **[source]**
  Its one real defect: state is written **only** on `RunEvent::Exit` (`:503-505`). A crash, a
  `kill -9`, or an OS restart loses the geometry silently. `AppHandleExt::save_window_state`
  (`:115`, `:121`) is public — call it on `WindowEvent::Resized`/`Moved`, debounced, if that matters.
  **[source]**
- **The last-opened project and session.** Today the app has no memory: on mount it selects
  `projectList[0]` unconditionally (`src/App.tsx:112`) and no session at all. Two `meta` rows
  (`crates/store/src/schema.rs:108`, `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  are all this needs, and staleness is self-correcting: if the id no longer resolves, fall back to
  `projectList[0]`. It is also what lets §1.3's static shell paint the *right* sidebar rather than a
  generic one. **[source]** + **[asserted]**
- **Scroll position per session.** Not persisted; cheap; and its staleness is bounded by the same
  500-row ring the rows themselves live in. Store the `seq` at the top of the viewport, not a pixel
  offset — the ring drops rows off the head, so a pixel offset means something different on the next
  launch and a `seq` does not. **[asserted]**
- **The `claude` probe result.** `probe_claude` is deliberately uncached *within* a launch
  (`src-tauri/src/commands.rs:48-55` — the operator's remedy is to install it and press the button),
  and that is right. But it is currently run **twice per launch**: once in `state::build`
  (`state.rs:236`) and again from the frontend on mount (`src/App.tsx:115-116`), each spawning a
  subprocess, the first one on the main thread. 11 ms measured (§1.2) for the second copy of an
  answer already in managed state. Have the mount read `claude_status()` (which exists,
  `state.rs:161-163`) and keep `probe_claude` for the button. **[source]** + **[measured]**

### 4.2 Not worth it

- **A rendered thread snapshot.** The whole read is 0.145 ms and the whole payload is 80 KB (§2.2,
  §2.4). Serialising HTML or a virtualizer measurement cache to disk to avoid 0.145 ms of SQLite is
  a losing trade before you count the invalidation. See Traps.
- **The feed rows themselves, in a second store.** They are already in SQLite, already capped,
  already ordered by the primary key. A second copy is a second thing to expire.

### 4.3 Needs a freshness contract, or don't

- **Per-project recon facts** — file tree, framework detection, package manager, test command. These
  are the expensive ones (a file walk of a large repo) and therefore the tempting ones, and they are
  the ones that go stale invisibly: the user switches branches, runs `npm install`, deletes a
  directory, and the harness is confidently wrong with no error anywhere. If it is cached at all it
  needs a cheap validator recorded alongside it — the repo's `HEAD` sha and branch, plus the `mtime`
  of the manifest the fact was derived from — checked on read, with a miss recomputing rather than
  warning. Anything without a validator should be recomputed on demand. **[asserted]**
  Worth noting the app already reaches for git state per session (`branch`, `worktree_path` on
  `SessionRow`, `crates/store/src/schema.rs`) and already prunes worktrees off the setup thread
  (`src-tauri/src/lib.rs:99-102`) — the pattern of "do the filesystem work in the background and let
  the UI be briefly ignorant" is established here and is the right one to extend.

---

## 5. Measurement

### 5.1 Process launch: what macOS still gives you

- **`DYLD_PRINT_STATISTICS` is gone.** `DYLD_PRINT_STATISTICS=1` and
  `DYLD_PRINT_STATISTICS_DETAILS=1` produce **no output at all** on macOS 26.5, on an adhoc-signed
  local binary and on this app's bundle. The mechanism still works — `DYLD_PRINT_LIBRARIES=1` and
  `DYLD_PRINT_ENV=1` both print — and
  `strings -a /usr/lib/dyld | grep -o 'DYLD_[A-Z_]*' | sort -u` shows the variable **does not exist
  in the dyld binary**. Do not plan around it. **[measured]**
- Even if it existed: **[documented]** `man dyld` — *"If System Integrity Protection is enabled,
  these environment variables are ignored when executing binaries protected by System Integrity
  Protection"* (`csrutil status` → enabled, **[measured]**), and a hardened-runtime bundle needs
  `com.apple.security.cs.allow-dyld-environment-variables` — *"This causes the macOS dynamic linker
  (dyld) to read from environment variables that begin with DYLD_"*, **[documented]**
  developer.apple.com entitlement reference, fetched 2026-09-02.
- **`xctrace` has an `App Launch` template** (`xcrun xctrace list templates` **[measured]**;
  Instruments 16.0 (17F113)) and it runs without sudo. Its `life-cycle-period` table is the launch
  metric. **Landmine, measured:** against both TextEdit and Calculator, xctrace printed
  `Target app exited, ending recording…` after 2.5–5 s and the exported table had exactly one row,
  `"Initializing - Process Creation"` — LaunchServices re-launches the bundle and xctrace loses the
  target. Treat App Launch as **unproven** for a Tauri app until someone gets a full phase list out
  of it. Second landmine: `--output` must precede `--launch`, or it lands in the target's argv.
  **[measured]**
- **`os_signpost` from the shell works, no sudo, no entitlement** — `/usr/bin/log emit --type
  signpost-begin --subsystem … --signpost-id 42`, then `log show --signpost --style compact --last
  2m --predicate 'subsystem == "…"'`, prints millisecond-stamped begin/end pairs. **[measured]**
  **[documented]** `man log`: *"--signpost-id id … used with signpost-begin and signpost-end types to
  create matching pairs for performance measurement intervals"*.
- **`log show` can see the app reach WindowServer but there is no first-frame predicate.** A 12 s
  capture around an `open -a` gave, in order: `launchservices:open` `LAUNCH: Asking CSUI to launch`,
  `SkyLight` `server port`, `SkyLight.processes:Lifecycle` `[CreateApplication]: Process creation`,
  `SkyLight.processes:Focus` `[SetFrontProcess]` — 79 ms end to end. Grepping the capture for
  window-ordered-in / surface-attached / frame found nothing. So the honest ceiling from outside the
  process is *"connected to WindowServer"*, not *"painted"*. **[measured]**
- **You cannot recover exec time after the fact.** `ps -p <pid> -o lstart=` is second-granularity and
  `sysctl kern.proc.pid.<pid>` does not exist on this machine. Record `T0` in the shell before exec,
  or take `SystemTime::now()` as the first statement of `main()`. **[measured]**

### 5.2 The recipe this document used, and the one to ship

What produced §1.2 needs no code change and should stay in the toolbox:

```sh
# scratchpad/measure.py, abridged
t0 = time.time(); p = subprocess.Popen([APP], env={**os.environ, "HOME": FAKE, "RUST_LOG": "info"})
# poll the child's stdout for the tracing lines; parse the RFC3339 timestamps
#   "brigadier started"            -> setup finished
#   2nd "claude resolved"          -> the frontend mounted and completed an IPC round trip
```

It works because two existing `tracing::info!` calls happen to bracket the interval
(`src-tauri/src/lib.rs:92`, `src-tauri/src/state.rs:189`) and because `probe_claude` is deliberately
re-run on every call rather than cached (`src-tauri/src/commands.rs:48-55`). **[measured]**

### 5.3 First paint from inside the webview

What exists in WebKit 26.5, verified against MDN `browser-compat-data` `main` and then confirmed in
a real `WKWebView` on this machine:

| API | Safari (BCD) | In our WKWebView |
|---|---|---|
| `PerformancePaintTiming` | 14.1 | present **[measured]** |
| `paint` entry `first-contentful-paint` | 14.1 | present, e.g. `startTime: 20` **[measured]** |
| `paint` entry **`first-paint`** | **false** | **absent** **[measured]** |
| `PerformanceNavigationTiming` (`responseStart`, `domInteractive`, `domContentLoadedEventEnd`, `loadEventEnd`) | 15 | present **[measured]** |
| `performance.timeOrigin` | 15 | present **[measured]** |
| `LargestContentfulPaint` | **26.2** | present; `presentationTime` is exposed but *"always returns `null`"* **[documented]** BCD |
| `PerformanceElementTiming` | **false** | absent **[measured]** |

`PerformanceObserver.supportedEntryTypes` in the real WKWebView came back as
`["event","first-input","largest-contentful-paint","mark","measure","navigation","paint","resource"]`
— no `element`, no `layout-shift`, and (as `feed-rendering.md` §3 already established) no `longtask`
and no `long-animation-frame`. **[measured]**

Two landmines: LCP is only readable through a **buffered** observer
(`new PerformanceObserver(cb).observe({type:'largest-contentful-paint', buffered:true})`);
`getEntriesByType('largest-contentful-paint')` returns `[]`. And with `loadHTMLString(_:baseURL:)`
the navigation entry is `null` — a real URL load is required, which `tauri://localhost` is, but
verify rather than assume. **[measured]**

**Bridging the Rust clock to the page clock.** **[documented]** W3C High Resolution Time:
`timeOrigin` is *"the duration from the estimated monotonic time of the Unix epoch to timeOrigin"*.
Confirmed numerically in the probe: `Date.now() - timeOrigin === performance.now()` to the
millisecond (`1788355265312 - 1788355262250 = 3062 = performance.now()`). **[measured]** So it is
directly comparable to `SystemTime::now().duration_since(UNIX_EPOCH)`. Ship this:

1. First statement of `main()`: `let t0_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64()*1000.0;`
   into managed state.
2. Frontend, once the FCP entry lands: `invoke('report_paint', { fcpEpochMs: performance.timeOrigin + entry.startTime })`.
3. Rust logs `fcpEpochMs - t0_ms` = **`main()` entry → first contentful paint**, in the same NDJSON
   `record_frame_stats` already writes to.

Honest limits: this measures `main()` to FCP, not `posix_spawn` to FCP — the dyld/pre-main segment is
invisible and `DYLD_PRINT_STATISTICS` can no longer fill the gap (§5.1); `timeOrigin` rests on an
*estimate* of the monotonic time of the epoch, so an NTP step mid-launch corrupts the subtraction
(negligible over 300 ms, but not exact); and FCP is a render timestamp, not a presentation
timestamp — `presentationTime` is `null` in WebKit 26.5, so the photons land some frames later.

**Session switch (B4) uses the same clock and no new API.** `performance.mark('switch')` on the
click, then a `requestAnimationFrame` inside a `requestAnimationFrame` after the commit that paints
the rows — the second callback runs after the rendering update that drew them — and
`performance.measure`. `mark`/`measure` are Safari 11+ and show up in Web Inspector's timeline.
**[documented]** BCD. This is the instrument that turns B4 from a guess into a number.

### 5.4 The frame budget is 16.67 ms, measured

`feed-rendering.md` §3c left open whether a real Tauri window on this machine runs rAF at 60 or
120 Hz, and said measuring it was the first thing the burn harness should do. It has been measured.
`~/Library/Application Support/ai.brigadier.app/frame-stats.ndjson` holds **1,513** one-second
windows from the owner's own runs: `p50_ms` is **17.0 in every single window** (median 17.0, p95
17.0, max 17.0). **The window runs at 60 Hz.** **[measured]**

The `hz` histogram in that file is `{60: 777, 70: 732, 80: 4}`, which is the p10-on-a-sub-multiple
rounding bug `feed-rendering.md` §3c already diagnosed and fixed in `src/fps.ts`; the file predates
the fix. `p50_ms = 17.0` everywhere is the un-buggy evidence. Other totals in the same file: 221
dropped vsyncs across 1,513 seconds, `dom_nodes` median 110 / max 575 — the virtualizer is holding.

### 5.5 SQLite timing, honestly

- `sqlite3` CLI `.timer on` prints `real 0.000` for anything sub-millisecond — useless at our scale.
  Loop the query N times and take percentiles (what §2.2 does), or time it from Rust with `Instant`.
  **[measured]**
- `.eqp on` prints the plan before each statement; `.eqp full` adds bytecode. **[measured]**
- Defaults on this build that change cold-read numbers: `page_size` 4096, `cache_size` 2000 pages
  (~8 MB), **`mmap_size` 0** (memory-mapped I/O off), `journal_mode` `delete`, `synchronous` FULL.
  Set `journal_mode=WAL` before measuring or the numbers describe a database the app never opens.
  **[measured]**
- A truly cold read needs `sudo purge` — `/usr/sbin/purge` exists, **[documented]** `man purge`:
  *"force disk cache to be purged (flushed and emptied)… can be used to approximate initial boot
  conditions with a cold disk buffer cache"* — and it **fails without sudo**
  (`Unable to purge disk buffers: Operation not permitted`). The "cold" row in §2.2 is a fresh SQLite
  *connection* (empty page cache) with the OS file cache still warm, and is labelled as such. A real
  cold-boot read is **unmeasured**. **[measured]**

---

## Traps

Ideas in this space that look right and are not.

1. **Shrinking the JS bundle to speed up launch.** Measured: React 19 plus the whole 258 KB bundle
   costs ~12 ms of FCP over a 400-byte static page, against ~100 ms for WKWebView construction
   (§1.2). Code-splitting the app would buy single-digit milliseconds and cost a loading state.
2. **A splash window.** It is the documented Tauri pattern
   (**[documented]** v2.tauri.app/learn/splashscreen/) and it is the wrong shape here: a second
   window is a second WKWebView, and WKWebView construction is the ~100 ms that dominates the launch.
   You would pay the cost twice to hide it once. The same page says as much in its own words — a
   splashscreen signals slow startup, and the fix is to be fast. Paint the shell in `index.html`
   instead (§1.3).
3. **`"visible": false` until the frontend says it is ready.** tauri **#15652** (OPEN): a window
   created with `visible: false` *"can permanently stop receiving events — listen() resolves but
   never fires; undeliverable EvaluateScript is silently discarded."* Our entire UI is `eval`-
   delivered `Channel` traffic. **[source]**
4. **Caching a rendered thread snapshot.** The tail query is 0.145 ms at 10k rows and 0.142 ms at
   1,000,000 (§2.2). A snapshot cache saves nothing measurable and introduces a copy that is stale
   the instant the session emits one more row — which, for a live session, is immediately. The only
   version of this that is not a trap is caching *scroll position*, which is not a snapshot.
5. **Adding a second read-only SQLite connection to get reads off the writer thread.** WAL makes it
   legal and the design instinct is right, but measured, the writer never holds a read for more than
   8.03 ms even at 10 sessions × 2000 rows/s (§2.3), and `Op::Query` already closes the coalescing
   window early (`writer.rs:331`). It buys ≤ 8 ms of tail latency for a second connection to keep
   consistent. Revisit only if `feed_cap` grows by an order of magnitude.
   Nearly rediscovered 2026-09-03: an order to add the second connection was issued from a code
   reading of `writer.rs:329-335` before §2.3 was re-read, and withdrawn the same day. Read §2.3
   before proposing it again.
6. **`feed_tail(session, 500)` as the first-paint read.** 80,241 bytes, ~10× the 8192-byte threshold,
   so it takes the `ChannelDataIpcQueue` + second-invoke path (§2.4) for data the user cannot see —
   only ~44 rows fit the viewport. It is not a *stall* (command responses carry no index and block
   nothing), but it is a wasted round trip on the one path that has a 100 ms budget.
7. **Caching per-project recon facts without a validator.** A file tree or framework guess captured
   at branch A and shown at branch B is wrong with no error and no way for the user to know. Record
   `HEAD` and the manifest `mtime` beside it, or recompute (§4.3).
8. **`DYLD_PRINT_STATISTICS` as a launch-profiling plan.** It no longer exists in dyld on macOS 26.5
   — not disabled, absent from the binary's string table (§5.1). Any recipe that starts with it is
   stale advice.
9. **Assuming a 120 Hz frame budget on this ProMotion display.** Measured: 1,513 one-second windows
   in a real Tauri window all report `p50_ms = 17.0`. The budget is 16.67 ms (§5.4). Halving it on a
   spec-sheet assumption manufactures dropped frames that never happened — `feed-rendering.md` §3c
   documents that exact self-inflicted wound.
10. **Reporting `RunEvent::Ready` as "the app launched".** It is event-loop readiness and it fires
    *before* the webview has painted (`app.rs:1424-1428`) — and, in this app, only after `setup`'s
    `block_on` has returned. It is a fine internal marker and a dishonest headline number.
11. **An optimistic entry whose retirement trigger is "the operation finished".** VS Code **#332087**
    is the whole lesson: a `chat/turnStarted` that is never retired gets *replayed over confirmed
    state on every confirmed action*, so `activeTurn.responseParts` reads as empty however many
    deltas have landed — 17 deltas were swallowed and 2,432 characters painted in one update at
    **19.4 s**. An optimistic layer built to make streaming feel faster ended up hiding it entirely.
    The trigger must be a specific echo (our `TurnStarted.turn_id`), matched, with a fallback that
    marks the entry unknown rather than leaving it pending. **[source]**
12. **Optimistically confirming a destructive operation.** element-web **#15039** (open since 2020):
    Element locally echoed a redaction against a server that 404'd the endpoint, and *"as a result of
    this misleading UI, it took us a while to work out that there was nothing wrong with redactions
    over federation or even on the server."* An optimistic delete does not merely mislead the user,
    it misleads the people debugging the backend. **[source]**
13. **An optimistic row that looks live and ignores clicks.** VS Code **#167744**: *"Once an item
    moved between staging its buttons become dead clicks. This causes extra confusion as there is no
    progress indicator."* Fully interactive or visibly not-yet-real; nothing between. **[source]**
14. **A stale optimistic marker nobody clears.** Zed shipped optimistic git staging and **reverted
    it** — PR **#45175**, merged 2025-12-18: *"This caused a regression because the additional pending
    hunks don't get cleared."* Same shape as #332087, in a different codebase, two years apart. If
    you cannot name the line that clears the flag, do not set it. **[source]**
15. **An undo window in front of `cleanup_worktree`.** The shortest undo window in any shipping code
    read here is ~5 s (Zed's autohide toast), Gmail offers *"5, 10, 20, or 30 seconds"*
    **[documented]**, and VS Code's undo is unbounded rather than timed. None of that composes with a
    `git worktree remove` that discards uncommitted work. The dry-run that already ships
    (`force = false` → `{ removed: false, dirty_files: N }`) is the correct pattern; do not replace
    it with a countdown.

---

## Not checked

- **The paint instrumentation now exists and has been run** (§1.4), so B1 is no longer inferred —
  it was observed end to end and **missed its budget by ~90 ms**. What the instrument has *not*
  done is time an interaction: `beginInteraction` has no call site, so it is tree-shaken out of the
  shipped bundle. **B4, B6 and B7 still have nothing behind them at all.**
- **§1.4 is one machine, one binary, one display, and a loaded one.** No arm ran on a quiet machine.
- **Nothing in §1.4 ran with a cold OS file cache.** `sudo purge` needs sudo and was unavailable.
- **The 756 ms outlier's diagnosis is by elimination.** That specific neighbour set was never
  reproduced, so "contention" is **[asserted]** from the two halves inflating by the same factor,
  not from a controlled repeat.
- **n=5–7 per arm supports a median, not a p95.** No budget expressed as a p95 is answered by §1.4.
- **n=14 supports a median, not a p95, and B4's budget is written as a p95.** §2.7 reports a median
  and a range for that reason; the p95 that budget asks for has not been measured and no number in
  this file should be quoted as one.
- **The `a0901e5` FCP regression is one sample.** 375.9 ms warm against a 287–295 ms p50, with a
  cold launch that matches an earlier cold outlier. Not attributed, not ruled out (§1.4).
- **B4's 14 selections were one session set on one machine.** No cold file cache, no second
  operator's data directory, and the first-selection cost (144 ms) was observed once, not
  characterised.
- The binary measured was built 2026-09-02 13:26 and predates nothing in `git log`, but it was not
  rebuilt for this work — no build was run, because `dist/` and `target/` are outside the one path
  this document owns.
- **The `tauri://localhost` path was never measured directly**, and §1.4 is why that now matters:
  all §1.2 FCP numbers come from loopback HTTP in a bare `NSWindow`, which excludes the
  brotli-quality-9 inflate (`tauri-utils-2.9.3/src/assets.rs:168-177`) and the custom-scheme
  handler, and the gap between that 38 ms estimate and the measured 132–141 ms is **~100 ms**.
  Attributing that gap to the scheme handler and the inflate is **[asserted]**, by elimination —
  neither was timed on its own. Whether disabling the `compression` feature is worth anything is
  still **unmeasured**, and no published number exists.
  The 2026-09-03 signposts in `docs/research/launch-signposts.md` still do not time the handler on
  its own, but they bound it: its cost lies inside either the 55.6 ms first response or the 83.3 ms
  subresource-plus-mount segment, and the ~100 ms attribution is ruled out **[measured]**.
- The ~100 ms WKWebView construction figure is from a minimal Swift program, not from tao's window
  creation with a menu bar, an activation policy and Tauri's init scripts. It is a floor, not the
  app's actual cost.
- Nothing was measured with a cold OS file cache: `sudo purge` was unavailable (§5.5). The "cold"
  SQLite row is a cold *connection*, not a cold disk.
- The `sweep` worst case (a `SIGTERM` fan-out plus a 400 ms grace inside `setup`) was **not**
  reproduced — the pid directory was empty on every run. It is a source-read hazard, not an observed
  one.
- `claude --version` was measured only against a native arm64 binary. The npm-shim case, which is
  the slow one and the one that would visibly block paint, was not measured.
- SQLite timings used Python's `sqlite3` 3.51.0, not rusqlite's bundled 3.53.2, and not through
  rusqlite's `prepare_cached` + `query_map` row mapping. Row-mapping and `serde` cost in Rust is
  additional and unmeasured.
- The Tauri invoke round-trip itself — JS `invoke` → command → response — has no measurement here or
  anywhere in the Tauri tree (`substrate.md` and `tauri-runtime.md` both say so). Every B4/B6 number
  is a guess until it is measured.
- `xctrace`'s App Launch template was never driven to a full phase breakdown for a Tauri app.
- Windows and Linux: nothing. `app_data_dir` vs `app_local_data_dir` differ only on Windows, the
  8192-byte threshold's comment cites WebView2 measurements we did not reproduce, and WebKitGTK is a
  different renderer.
- **Nothing in §3 measures this app.** Every latency in §3.3 comes from `claude-direct-spike.md`'s
  fixtures, and every delay constant comes from someone else's codebase. No optimistic-UI change was
  built, and no user was shown one.
- The composite latency of `start_session` — `worktree::prepare` plus the driver handshake — was not
  isolated. 719 ms (spawn → `initialize` `control_response`) and 1981 ms (spawn → `system/init`) are
  the spike's numbers for the child, not for the command's round trip, and the `git worktree add` on
  top of them is unmeasured.
- Ng et al., UIST 2012 (touch latency perceptible near 1 ms) could not be retrieved — ACM returned
  403 and no open mirror was found. It is cited nowhere above for that reason.
- Alacritty's visible-window-before-`tty::new` ordering is a code-order inference; nobody ran it and
  nobody measured whether the flash is perceptible.
- Apple's HIG publishes **no numeric latency threshold** on any page read here. Every number in §3.1
  comes from Miller, Card et al., Nielsen, RAIL or Liu & Heer — and Miller's own text calls his
  "indicative rather than conclusive".
- macOS Mail's undo-send default duration was not verified; only Gmail's published set of choices is
  quoted.
- element-web's failure-presentation files were read by a delegate and spot-checked, not read in
  full here; the matrix-js-sdk citations were verified directly.
