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
  **[source]** `src-tauri/src/commands.rs:324`, `src-tauri/src/trace.rs:93-98`. That crosses
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
- **There is no `DOMContentLoaded` stage yet.** Its Rust half is in the tree and inert
  (`src-tauri/src/commands.rs:344-347`); the emitter is three lines in `src/paint.ts`, which
  belongs to another session. No number below includes it. Details at the bottom of this file.

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
   React, and splitting that segment is the measurement that decides it.
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
- Inlining HTML, JS and CSS into one scheme response: **not decidable on these numbers.** Whatever
  it would save comes out of the 83.3 ms `page_load_finished` to `fcp` segment, which this
  instrument does not divide between scheme delivery, inflate and React. It cannot come out of the
  55.6 ms first response, which already serves one 390-byte document. Split the 83.3 ms first;
  building against an undivided number is exactly how the 100 ms attribution happened.
- The two segments that carry the launch are `builder_built` to `setup_entry` at 108.7 ms (window
  and WKWebView construction, before our code) and `page_load_finished` to `fcp` at 83.3 ms
  (subresource fetch plus React mount, not separated by this instrument). Together they are 64% of
  the launch. **The next measurement is the split of that 83.3 ms**, which needs the
  `DOMContentLoaded` stage below, whose Rust half has landed and whose page half has not; until it
  exists, "shrink the bundle" and "speed up the handler" are the same unresolved 83 ms.
- The 108.7 ms is a second, independent confirmation of trap 2 in `perceived-performance.md`: a
  splash window is a second WKWebView, and this is the measured price of the first one.
  **[measured]**

## The `dcl` stage: Rust half landed, page half outstanding

The receiving end is in the tree and inert. `src-tauri/src/commands.rs:311` names the label and
`:344-347` is the guarded arm that turns it into a `dcl` signpost. Nothing sends that label today,
so the arm is never taken. **[source]**

No wire change was needed on either side: `DOMContentLoaded` is one timestamp with no duration,
which is what the existing `interaction` variant already carries, so `src/wire.ts` and
`src-tauri/src/views.rs` are untouched. The label is namespaced `trace:` so it cannot collide with
a B4, B6 or B7 budget name.

The outstanding half is three lines in `src/paint.ts`, which belongs to another session. Inside
`startPaintInstrumentation`, after the observer is installed:

    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.domContentLoadedEventEnd > 0) {
      report({
        kind: "interaction",
        label: "trace:dcl",
        start_epoch_ms: performance.timeOrigin + nav.domContentLoadedEventEnd,
        duration_ms: 0,
      });
    }

`PerformanceNavigationTiming` is present in this WKWebView (**[measured]**,
`perceived-performance.md` §5.3), and the observer already runs after DCL in practice because FCP
follows it, so no extra listener is needed. Cost when tracing is off: one extra `invoke` per
launch, on a path that is already past `page_load_finished`. Whether that extra invoke perturbs the
FCP number is **[asserted]** to be negligible and **not measured**.

## Not checked

- **Cold start was not measured.** `sudo purge` is unavailable to this session, so every number is
  warm. The 12 runs also share one warm scratchpad `HOME`; first-ever launch (arm A1) and the
  owner's real data directory (arm B) were not re-run.
- **n=12 supports a median and a worst, not a p95.** No number here answers a p95 budget.
- **The 83.3 ms from `page_load_finished` to `fcp` is not decomposed.** Subresource fetch through
  the scheme handler, brotli inflate of the 271.29 kB bundle, React parse, mount and first render
  are all inside it, in one undivided number.
- **`page_load_finished`'s exact WebKit meaning was not established** beyond wry calling it from
  `didFinishNavigation`. At 2.9 ms after commit, for a document whose only script is a deferred
  271 kB ES module, it is almost certainly not the `load` event. Do not read it as one.
- **The scheme handler was still never timed on its own.** This file confines its cost to the
  83.3 ms `page_load_finished` to `fcp` segment and rules it out of the 55.6 ms first response, so
  the 100 ms attribution loses its ceiling. It does not replace it with a measurement of the
  handler, and it does not separate the handler from the inflate or from React inside that 83.3 ms.
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
