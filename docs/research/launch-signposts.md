# Launch signposts: where the 300 ms actually goes

Date: 2026-09-03. Scope: the cold-start path only, from `main()` to first contentful paint, stage
by stage. Answers two competing unmeasured attributions: one is dead, the other loses its
100 ms ceiling and keeps an 83 ms one it shares with React.

Tags: **[measured]** run on this machine today, command and number shown; **[source]** read in
crate or app source, file:line; **[documented]** vendor docs; **[asserted]** reasoned, not
verified.

## Why

`perceived-performance.md` §1.4 measured exec to FCP at 287 to 295 ms p50 (n=19) against a 200 ms
budget, and attributed roughly 100 ms of it **by elimination** to the `tauri://localhost` scheme
handler plus the brotli inflate. That file's own "Not checked" list says neither was ever timed.
**[source]** `perceived-performance.md:1015-1024`.

`panel-review-2026-09-03.md` §4(c) named a competing candidate, also untimed:
`tauri::async_runtime::block_on(state::build(data_dir))` runs inside `setup`, on the main thread,
after the window exists. **[source]** `src-tauri/src/lib.rs:162`. Its §5 flip table said: over
50 ms, move it off the main thread; under 20 ms, go after the scheme response instead.

Two hypotheses, no number between them. This file is the number.

## The instrument

- `src-tauri/src/trace.rs` prints one stderr line per stage, `brigadier-trace ms=<x> stage=<name>`,
  gated on `BRIGADIER_TRACE=1`. **[source]** `src-tauri/src/trace.rs:76-114`.
- Zero is `main()` entry, stamped by `trace::arm()` from `mark_process_start()`, which `main()`
  calls as its first statement. **[source]** `src-tauri/src/lib.rs:63-73`, `src-tauri/src/main.rs:9`.
- With the variable unset the binary prints nothing: 0 matching lines over a full launch.
  **[measured]**
- Rust stages use a monotonic `Instant`; the one page stage (`fcp`) arrives as epoch milliseconds
  through the existing `report_paint` command and is converted against the same `main()` stamp.
  **[source]** `src-tauri/src/commands.rs:347`, `src-tauri/src/trace.rs:93-98`. That crosses
  from the monotonic clock to the wall clock, which is stated rather than hidden; over a 300 ms
  launch the difference is not measurable.
- `page_load_started` is wry's `didCommitNavigation` and `page_load_finished` is
  `didFinishNavigation`. **[source]** `wry-0.55.1/src/wkwebview/navigation.rs:17-46`.
- **There is no signpost for the first `tauri://localhost` request, and none was faked.** Claiming
  `"tauri"` with `Builder::register_uri_scheme_protocol` **replaces** the built-in asset protocol
  rather than wrapping it: the built-in is installed only when the app has not claimed the name.
  **[source]** `tauri-2.11.5/src/manager/webview.rs:267-277`. The per-request hook
  `on_web_resource_request` exists only on `WebviewBuilder` and `WebviewWindowBuilder`
  (**[source]** `tauri-2.11.5/src/webview/mod.rs:487`), and this app's window comes from
  `tauri.conf.json`, not from a builder. `page_load_started` is the first stage after that
  response, not before it.
- **The `DOMContentLoaded` stage exists and has fired**, but it landed after the n=12 run below:
  the guard is `src-tauri/src/commands.rs:332-337` and the emitter is `src/paint.ts`, the frontend
  session's. **No number in the n=12 table includes it**; its own numbers are the 2026-09-04 section,
  and the three defects it took to get there are at the bottom.

## Method

- Binary: `target/release/bundle/macos/brigadier.app/Contents/MacOS/brigadier`, 17,600,912 B,
  built 2026-09-03 15:54 from `815c9d9` plus the working tree of this order. `npm run tauri build`,
  exit 0. **[measured]**
- 12 warm launches, one at a time, `HOME` redirected to a scratchpad directory so
  `app_local_data_dir()` resolves outside the owner's data directory, `RUST_LOG=info`,
  `BRIGADIER_TRACE=1`, the same scratchpad `HOME` reused across runs. This is arm A2 of §1.4.
  **[measured]**
- Each run is killed with `SIGTERM` after the `fcp` line, and the set of `pgrep -x claude` pids is
  compared before and after. **Zero leaked `claude` processes on all 12 runs.** **[measured]**
- Every launch spawns `claude --version` twice, once from `state::build` and once from the
  frontend's mount-time `probeClaude()`. No session, no API call. **[source]**
  `src-tauri/src/state.rs:182`, `perceived-performance.md:274-277`.
- Script: `scratchpad/measure.py`, raw per-run stages in `scratchpad/runs.json`. Not in the repo.
- **Cold was not measured.** A cold OS file cache needs `sudo purge`, which fails without sudo
  (**[documented]** `man purge`; **[measured]** `perceived-performance.md` §5.5). Every number
  below is warm.
- Load average was 4.68 to 4.89 through the run, with another agent's `cargo check` compiling
  concurrently. Comparable to §1.4's 2.36 to 6.34, and on the high side of it. **[measured]**

## The table

n=12, warm, all values milliseconds since `main()` entry. "Segment" is the cost of reaching that
stage from the one above it. All **[measured]**.

| stage | cumulative p50 | cumulative worst | segment p50 | segment worst |
|---|---|---|---|---|
| `main` | 0.0 | 0.5 | . | . |
| `rlimit_nofile` | 0.0 | 1.1 | 0.0 | 0.6 |
| `tracing_ready` | 0.1 | 1.6 | 0.0 | 0.5 |
| `builder_built` | 37.7 | 44.9 | 37.6 | 43.4 |
| `setup_entry` | 146.5 | 178.5 | **108.7** | 135.3 |
| `state_build_start` | 146.7 | 178.7 | 0.2 | 0.6 |
| `data_dir_ready` | 146.8 | 178.7 | 0.0 | 0.0 |
| `store_open` | 147.5 | 180.8 | 0.8 | 4.5 |
| `pid_sweep` | 147.6 | 181.0 | 0.0 | 0.2 |
| `supervisor_new` | 147.6 | 181.3 | 0.0 | 0.3 |
| `claude_probe` | 155.0 | 192.2 | 7.3 | 11.1 |
| `state_build_end` | 155.0 | 192.2 | 0.0 | 0.0 |
| `setup_exit` | 155.0 | 192.5 | 0.0 | 0.3 |
| `page_load_started` | 211.3 | 272.4 | **55.6** | 79.8 |
| `page_load_finished` | 214.2 | 275.5 | 2.9 | 3.2 |
| `fcp` | 299.6 | 366.9 | **83.3** | 112.9 |

Totals, same 12 runs, p50 (min to max). All **[measured]**.

| interval | p50 | range |
|---|---|---|
| exec to `main` (pre-main, from the shell clock against `process_start_epoch_ms`) | 5.3 | 4.6 to 8.7 |
| exec to FCP | **305.3** | 290.6 to 375.4 |
| `main` to FCP | 299.6 | 285.3 to 366.9 |
| `state::build` start to end | **8.1** | 7.8 to 15.9 |
| whole `setup` closure, entry to exit | 8.4 | 8.0 to 16.8 |
| `state_build_end` to FCP (the `brigadier started` window) | 145.6 | 130.2 to 176.2 |

The 12 stage p50s sum to 296.3 against a 299.6 p50 for `fcp`, so the decomposition accounts for the
launch and there is no unlabelled remainder. **[measured]**

Cross-check against the prior work: 305.3 ms p50 exec to FCP here against 287 to 295 ms p50 in
§1.4, and 5.3 ms pre-main here against 4.9 ms there. Same distribution, ~13 ms higher, on a machine
that also had a Rust compile running. **[measured]**

## What this settles

1. **`state::build` is 8.1 ms p50, 15.9 ms worst.** The panel's flip threshold was 50 ms to move it
   off the main thread and 20 ms to stop looking at it. It is under both. **[measured]**
2. **`state::build` overlaps the 132 to 141 ms `brigadier started` to FCP window by exactly zero
   milliseconds.** `brigadier started` is logged on the line after `block_on` returns
   (**[source]** `src-tauri/src/lib.rs:164`), so the window begins where `state::build` ends. The
   whole of `state::build` sits before the window, and the window measured here is 145.6 ms p50
   (130.2 to 176.2), consistent with the 132 to 141 ms §1.4 recorded. **[measured]**
3. **`state::build` is nonetheless fully serialized ahead of the page load.** `setup_entry` is
   146.5 and `page_load_started` is 211.3, and `setup` runs on the main thread, so nothing in the
   webview overlaps it. Moving it off the main thread would therefore return real time, and the
   real time it would return is 8.1 ms p50. **[measured]**
4. **The "~100 ms scheme handler plus brotli inflate" attribution is unsupported as stated, and is
   not disproved below 83 ms.** Where those costs cannot be: the 55.6 ms `setup_exit` to
   `page_load_started` segment, which carries `index.html` at 390 bytes, one response, nothing to
   inflate. **[measured]** Where they must be: inside the 83.3 ms `page_load_finished` to `fcp`
   segment, together with React parse, mount and first render. **[measured]** Their share of that
   83.3 ms is **not measured** and this instrument does not divide it. The reason they sit there
   rather than between the two page-load stages: `page_load_finished` is `didFinishNavigation`, and
   at 2.9 ms after commit, for a document whose only script is a deferred 271.29 kB ES module, it
   cannot be the `load` event, so the subresource fetch and the inflate have not happened yet when
   it fires. **[asserted]**, from that arithmetic, not from a WebKit source read. The net effect on
   the original claim: it loses its 100 ms ceiling and gains an 83.3 ms one that it shares with
   React, and splitting that segment is the measurement that decides it. **That split has since
   been measured** and is in the 2026-09-04 section below: 49.6 ms fetch plus parse against
   28.5 ms mount plus render, so the scheme handler and the inflate share a **49.6 ms** ceiling,
   not 83.3.
5. **The largest single segment is before any of our code runs in the window's lifetime.**
   `builder_built` to `setup_entry` is 108.7 ms p50, 36% of the launch. That interval is tauri's
   own `setup` creating the configured window, `WebviewWindowBuilder::from_config(...).build()`,
   before it calls our closure. **[source]** `tauri-2.11.5/src/app.rs:2521-2535`, `:1424`. It is
   the first in-app measurement of the ~100 ms WKWebView construction figure §1.2 had only from a
   minimal Swift program. **[measured]**
6. **The 400 ms sweep grace never fired.** `pid_sweep` reported `swept=0` on all 12 runs and cost
   0.0 ms p50, 0.2 ms worst. The hazard in §1.2 stays a source read, not an observed one, exactly
   as `perceived-performance.md` already said. **[measured]**
7. **`Store::open` is not a launch cost.** 0.8 ms p50, 4.5 ms worst, warm, migrations already
   applied. **[measured]**
8. **`claude --version` is 7.3 ms p50, 11.1 ms worst**, and is 90% of `state::build`. Against a
   native arm64 `claude` only; the npm-shim case is still unmeasured. **[measured]**

## 2026-09-04: the 83.3 ms is split, and the `dcl` stage fired

Run by the **frontend session**, 2026-09-04, five launches with `BRIGADIER_TRACE=1`, one cold and
four warm, after the `dcl` emitter landed in `src/paint.ts`. All figures below are theirs and all
are **[measured]**.

**`stage=dcl` printed on all five launches and `dcl-approx` on none**, so
`domContentLoadedEventStart` was populated everywhere the instrument read it and the fourth recipe
below is the one that works. One warm launch verbatim, milliseconds since `main()`:

| stage | ms |
|---|---|
| `setup_exit` | 156.018 |
| `page_load_started` | 200.818 |
| `page_load_finished` | 203.778 |
| `dcl` | 254.046 |
| `fcp` | 282.046 |

Warm medians, n=4, of the segment that was undivided until now:

| half | p50 | samples |
|---|---|---|
| `page_load_finished` to `dcl`, subresource fetch plus parse | **49.6** | 50.1 / 48.8 / 49.0 / 50.3 |
| `dcl` to `fcp`, React mount plus first render | **28.5** | 60.0 / 23.0 / 29.0 / 28.0 |
| total | 78.1 | against 83.3 undivided on 2026-09-03 |

**Fetch plus parse is the larger half, roughly 64/36.** So inlining the assets into one scheme
response, or trimming the bundle (now 273.98 kB), targets the larger half and is worth **up to
about 50 ms**, not 83 and not 28.

Two cautions on those two halves, and they are not equal. The fetch half is tight: four samples
inside 1.5 ms. **The mount half is weak.** n=4, one sample is an outlier at 60.0 against a 23 to 29
cluster, and its values are integers because both endpoints are page-relative timestamps clamped to
1 ms. It needs more samples before anyone plans against 28.5.

**The cold run corrects a figure this file quoted.** Its page half split 27.6 / 46.0 for 73.6 ms
total, in the same order as the table above, which is **not inflated at all** against the warm 78.1.
The cold run inverts the warm ratio between the two halves, and it is one sample. The whole cold
penalty sat somewhere else: `builder_built` to `setup_entry` was **420 ms** cold against about 104
warm. **A cold launch is slow in Tauri's window creation, not in the page.**

**The 2026-09-03 numbers replicated**, on a tree that had since taken the feed redesign and bundle
growth: `builder_built` to `setup_entry` 104.2 against 108.7, `state::build` 9.3 against 8.1,
`setup_exit` to `page_load_started` 45.0 against 55.6, `main` to `fcp` 283.9, exec to FCP about
288.8 with 4.9 ms pre-main. That is inside the 287 to 295 ms band §1.4 recorded, so **neither the
feed redesign nor the bundle growth regressed the launch.**

**`paint.ndjson` gained no `trace:` line across the five launches, and that check is no longer
vacuous**: the five `stage=dcl` lines prove the reports reached `report_paint`, so the file staying
clean is the writer-side exclusion working rather than nothing having been sent.

**One caveat, and it is not small: every number in this run was taken with the display locked**
(`CGSSessionScreenIsLocked=1`). FCP is a render timestamp and not a presentation one, so a locked
display need not move it, but landing inside the warm band is weak evidence rather than proof that
it did not. The 800x500 layout check and feed scroll FPS were not measured in this run either.

**Incidental, for whoever writes the next launch order:** `npm run tauri build` needs
`PATH="$HOME/.cargo/bin:$PATH"` when it is run from a non-interactive shell.

## File descriptors

`panel-review-2026-09-03.md` §4(d) found no `setrlimit` anywhere in the tree. `src-tauri/src/trace.rs:139-171`
now raises the soft `RLIMIT_NOFILE` toward the hard limit, capped at 65,536, from
`src-tauri/src/lib.rs:104`, before `tauri::Builder` exists and before any child is spawned.

- `nix` 0.31.3 was already in the workspace and in `Cargo.lock`; only its `resource` feature is
  new. `src-tauri` is `#![deny(unsafe_code)]`, so `libc::setrlimit` (an unsafe extern fn) could not
  be called from this crate at all. **[source]** `crates/proc/Cargo.toml:27`,
  `src-tauri/src/lib.rs:21`.
- From a login shell the raise is a no-op here: `old=1048576 new=1048576 hard=9223372036854775807
  outcome=already_high` on all 12 runs. **[measured]**
- From launchd, which is how a Finder or `open` launch inherits its limits, it is not:
  `launchctl limit maxfiles` is **256**. **[measured]** Under `ulimit -n 256` the app reports
  `rlimit_nofile old=256 new=65536 hard=9223372036854775807 outcome=raised`. **[measured]**
- The cap exists because macOS refuses any soft limit above `kern.maxfilesperproc`, 92,160 on this
  machine (**[measured]** `sysctl`), with `EINVAL`, even though the hard limit reads as
  `RLIM_INFINITY`. A refusal descends through 24,576, 10,240 and 4,096 and is a `warn`, never
  fatal. **[source]** `src-tauri/src/trace.rs:182-188`.
- Windows is a no-op with a named line, `outcome=not_unix`. **[source]** `src-tauri/src/trace.rs:173-176`.

## Recommendation

**Neither of the two options the panel's flip table offered is worth taking on these numbers, and a
third one it did not list is.**

- Moving `state::build` off the main thread behind a ready event: **no.** It buys 8.1 ms p50,
  15.9 ms worst, against a 90 ms budget miss, and it costs a ready-event protocol plus a window of
  commands that must answer "not yet". Revisit only if `claude --version` gets slow, which is the
  one part of it that could: an npm-shim `claude` is unmeasured and would land here.
- Inlining HTML, JS and CSS into one scheme response, or trimming the bundle: **decidable now, and
  worth up to about 50 ms.** The 2026-09-04 section splits the segment this bullet said could not be
  divided: subresource fetch plus parse is 49.6 ms p50 and React mount plus render is 28.5 ms, so
  the work targets the larger half. It still cannot come out of the 55.6 ms first response, which
  already serves one 390-byte document. Do not quote 83, and do not quote 28.
- The two segments that carry the launch are `builder_built` to `setup_entry` at 108.7 ms (window
  and WKWebView construction, before our code) and `page_load_finished` to `fcp` at 83.3 ms
  (subresource fetch plus React mount, not separated by this instrument). Together they are 64% of
  the launch. **The split of that 83.3 ms was the next measurement and it has been taken**: 49.6 ms
  fetch plus parse, 28.5 ms mount plus render (2026-09-04, below). "Shrink the bundle" and "speed up
  the handler" now name the same 49.6 ms half, and are no longer the same question as "make React
  mount faster".
- The 108.7 ms is a second, independent confirmation of trap 2 in `perceived-performance.md`: a
  splash window is a second WKWebView, and this is the measured price of the first one.
  **[measured]**

## The `dcl` stage: both halves landed, and what it took

Both ends are in the tree and the stage has fired (2026-09-04, five launches for five, above).
`src-tauri/src/commands.rs:374` names the `trace:` namespace and
`src-tauri/src/commands.rs:332-337` is the guard that turns a label in it into a signpost; the
emitter is `src/paint.ts` and belongs to the frontend session. **[source]**

No wire change was needed on either side: `DOMContentLoaded` is one timestamp with no duration,
which is what the existing `interaction` variant already carries, so `src/wire.ts` and
`src-tauri/src/views.rs` are untouched. The wire shape is exactly:

    {"kind":"interaction","label":"trace:dcl",
     "start_epoch_ms": <timeOrigin + domContentLoadedEventEnd>, "duration_ms": 0}

**A `trace:`-prefixed report never reaches `paint.ndjson`.** The arm returns before the file write,
so a `duration_ms: 0` signpost cannot be folded into an interaction percentile by anything that
later reads that file. Matching is on the prefix, not on the one label, and the stage name is the
label with the prefix stripped. **[source]** `src-tauri/src/commands.rs:332-337`.

### The emitter, and the three defects in this file's earlier recipes

**This is the fourth version of the same recipe. Each earlier one was written from the previous
reading rather than from the step order, and each shipped.** Version one read
`performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd` synchronously at the top of
`startPaintInstrumentation` and reported only when it was above zero; the bundle is a deferred ES
module (`dist/index.html`, `<script type="module">`), the module body runs before
`DOMContentLoaded`, the field reads 0, and nothing was ever sent. Version two added a listener but
gated it on `document.readyState === "loading"`, a gate a deferred module script can never pass, and
then asked the handler to re-read `domContentLoadedEventEnd`, which is written after the handlers
return. **Version three fixed both of those and was still holed, at one instant: after
`DOMContentLoaded` has dispatched and before step 6.3 runs.** In that window `readyState` is
`interactive` and `domContentLoadedEventEnd` is still 0, so its branch 1 skipped on the zero and its
branch 2 attached a listener for an event that had already fired. Nothing reported, again. In
production the stage did not fire until the fourth version below: the run that found this hole
reported `page_load_finished` to FCP as 142.2 ms, undivided, on a cold n=1 launch. **That cold
figure is superseded** by the 2026-09-04 section above, which split its own cold launch into 27.6
plus 46.0 for 73.6 ms and put the cold penalty in `builder_built` to `setup_entry` at 420 ms
instead. **[measured]**

The spec says exactly why, in HTML Standard §13.2.7 "The end", the steps run once the user agent
stops parsing. **[documented]**, fetched 2026-09-04:

- Step 3, "Update the current document readiness to `"interactive"`", runs **before** step 5,
  which is the loop that executes the list of scripts that will execute when the document has
  finished parsing. A deferred module body therefore always observes `"interactive"`, never
  `"loading"`.
- Step 6 queues one task whose substeps are, in order: 6.1 "Set the Document's load timing info's
  DOM content loaded event start time to the current high resolution time", 6.2 "Fire an event
  named `DOMContentLoaded` at the Document object", 6.3 "Set the Document's load timing info's DOM
  content loaded event end time to the current high resolution time".
- `"complete"` is set only at step 9.1, in a later queued task after step 8 has spun the event loop
  until nothing delays the load event.

**The consequence that decides the recipe: 6.1 writes the start time before dispatch and it stays
written, so `domContentLoadedEventStart` is both the timestamp and the "has DCL fired" predicate.**
`domContentLoadedEventEnd` is neither, because it is structurally 0 across the whole interval in
which a handler could observe it. Every earlier version used `end` as the predicate; that is the one
mistake all three share.

Navigation Timing Level 2 §3.3 matches: the `domContentLoadedEventStart` getter returns the
document load timing's DOM content loaded event start time, "measured **before** the user agent
dispatches the `DOMContentLoaded` event", and `domContentLoadedEventEnd` returns the end time,
"measured **after** the user agent completes handling of the `DOMContentLoaded` event".
**[documented]**, fetched 2026-09-04.

Confirmed in a real `WKWebView`, served over HTTP from `127.0.0.1` so a navigation entry exists,
against a page whose only script is `<script type="module">`. Rows 1, 2 and 4 are this session's
probe (`scratchpad/dclprobe/`, the frontend session's harness with `domContentLoadedEventStart`
added); **row 3 is the frontend session's probe of the post-dispatch instant, and is the row that
holed version three**. All **[measured]**, 2026-09-04:

| snapshot | `readyState` | `domContentLoadedEventStart` | `domContentLoadedEventEnd` |
|---|---|---|---|
| module body | `interactive` | 0 | 0 |
| `DOMContentLoaded` handler | `interactive` | 13.0 | 0 |
| **a microtask after dispatch** | `interactive` | **15** | **0** |
| `load` handler | `complete` | 13.0 | 13.0 |

Row 3 is the whole correction: at that instant `end` is 0 and a listener attached there never fires,
so any recipe that keys on `end` reports nothing. `start` is populated in rows 2, 3 and 4 and is 0
only in row 1, which is exactly the shape a predicate needs. Magnitudes are meaningless here (small
pages off localhost, two different runs); the ordering is the result.

What an implementation must do:

1. If `domContentLoadedEventStart > 0`, report `timeOrigin + domContentLoadedEventStart` under label
   `trace:dcl`. This is the whole live path: it covers the handler, every instant after dispatch,
   and a late installation, because step 6.1 has run in all of them and never un-runs.
2. Else if `document.readyState !== "complete"`, add a `{ once: true }` `DOMContentLoaded` listener.
   Inside it, if `domContentLoadedEventStart > 0` report `timeOrigin + domContentLoadedEventStart`
   under `trace:dcl`; otherwise report `timeOrigin + performance.now()` read at handler entry, under
   label **`trace:dcl-approx`**. Never read `domContentLoadedEventEnd` here: step 6.3 has not run
   yet, and that read is what versions one and three died on.
3. Else report nothing.

**With branch 1 keyed on `start`, the `readyState` gate in branch 2 is provably inert wherever a
navigation entry exists, and it is kept as a statement of the impossible case rather than as a
load-bearing test.** Reaching branch 2 means `start` is 0; reaching branch 3 would additionally
require `readyState === "complete"`, which is step 9.1 and runs strictly after step 6.1, so
`complete` with `start` still 0 cannot occur. The one path that does reach branches 2 and 3 in
practice is the case with **no navigation entry at all**, `loadHTMLString(_:baseURL:)`
(**[measured]**, `perceived-performance.md` §5.3), where `start` cannot be read and the spec
argument does not apply. That case is not how this app loads its page, and it is the only reason
steps 2 and 3 exist.

Step 3 is a refusal, not a fallback: at `"complete"` with no readable milestone, any number invented
there would be later than the thing it claims to timestamp, and "a missing number is honest, a wrong
number is not" (`src/paint.ts`) applies.

**The two labels are the honesty field, and they cost nothing to add.** `report_paint` strips the
`trace:` prefix and uses the remainder as the stage name (`src-tauri/src/commands.rs:332-337`), so
the stderr line reads `stage=dcl` or `stage=dcl-approx` and says which clock produced it without a
wire change. `dcl-approx` is the handler's turn in the task queue, not the browser's own milestone.

`PerformanceNavigationTiming` is present in this WKWebView (**[measured]**,
`perceived-performance.md` §5.3, and again in the probes above). Cost when tracing is off: one extra
`invoke` per launch, on a path already past `page_load_finished`. Whether that extra invoke perturbs
the FCP number is **[asserted]** to be negligible and **not measured**.

## Readers of `paint.ndjson`

**There are none, and that was checked rather than assumed.** Nothing in `src-tauri/` reads the
file (the only two `OpenOptions` calls in the crate are the two appends); there is no `scripts/`
directory; no shell or Python recipe in `docs/` reads it, including §5.2's launch recipe, which
parses the `RUST_LOG` stream and never the file; and the 14 B4 samples in §2.7 were collected by
hand. `docs/plans/ipc-contract.md:320` states the append-only intent. **[measured]** So the
`trace:` exclusion is enforced at the writer, where it cannot be forgotten, instead of being a rule
every future reader has to be told.

## Not checked

- **The `dcl` stage has now fired in brigadier**, five launches out of five, so the recipe is no
  longer the open question. What is open is the run it fired in: **every number in it was taken with
  the display locked** (`CGSSessionScreenIsLocked=1`), and landing inside the warm band is weak
  evidence rather than proof that the lock did not move FCP.
- **The mount half rests on n=4 with an outlier.** 28.5 ms p50 from 60.0 / 23.0 / 29.0 / 28.0, both
  endpoints clamped to 1 ms because they are page-relative timestamps. The 49.6 ms fetch half is
  tight, four samples inside 1.5 ms; the mount half is not, and should not be planned against.
- **The 800x500 layout check and feed scroll FPS were not measured** in the 2026-09-04 run.
- **Cold start was not measured.** `sudo purge` is unavailable to this session, so every number is
  warm. The 12 runs also share one warm scratchpad `HOME`; first-ever launch (arm A1) and the
  owner's real data directory (arm B) were not re-run.
- **n=12 supports a median and a worst, not a p95.** No number here answers a p95 budget.
- **The 83.3 ms from `page_load_finished` to `fcp` is now split at `dcl` but not below it.**
  Subresource fetch through the scheme handler, the brotli inflate and the HTML and JS parse share
  the 49.6 ms first half, and nothing separates those three from each other; React mount and first
  render are the 28.5 ms second half.
- **`page_load_finished`'s exact WebKit meaning was not established** beyond wry calling it from
  `didFinishNavigation`. At 2.9 ms after commit, for a document whose only script is a deferred
  271 kB ES module, it is almost certainly not the `load` event. Do not read it as one.
- **The scheme handler was still never timed on its own.** This file confines its cost to the
  49.6 ms `page_load_finished` to `dcl` half and rules it out of both the 55.6 ms first response and
  the 28.5 ms mount half, so the 100 ms attribution now has a 49.6 ms ceiling. It still does not
  replace it with a measurement of the handler, and it does not separate the handler from the
  inflate or from the parse inside that 49.6 ms.
- **The 108.7 ms window and WKWebView segment is not decomposed either.** tao window creation,
  WKWebView construction, Tauri's init scripts and the activation policy are one number.
- **Load average was 4.68 to 4.89 with a concurrent Rust compile.** No arm ran on a quiet machine,
  same limitation §1.4 carries.
- **The `claude` binary measured is native arm64 2.1.259.** The npm-shim case, which is the one
  that would visibly block paint inside `state::build`, was not measured.
- **`state::build` was not measured with a non-empty pid directory.** `swept=0` on all 12 runs, so
  the 400 ms grace has still never been observed firing.
- **The `rlimit_nofile` raise was verified under `ulimit -n 256` from a shell, not under a real
  Finder launch.** `launchctl limit maxfiles` of 256 is the evidence that the Finder case needs it;
  the Finder case itself was not run with stderr captured.
- Nothing here ran on Windows or Linux. `RLIMIT_NOFILE` does not exist on Windows and the stage is
  a named no-op; WebKitGTK and WebView2 are different renderers with different page-load semantics.
- The instrument's own cost was not measured. It is 16 `writeln!` calls to an unbuffered stderr
  when enabled and 16 cached-`bool` loads when not; **[asserted]**, not timed.
