# Native performance verification — 2026-09-09

**Checkpoint at the owner’s explicit request; native rendering gate is not green. Not merged or installed.**

Current worktree base: `d3f5bea` (includes keep-awake and the later ownership/approval fixes). Current source passes all six functional/build gates: 810 Rust tests, 12 ignored; 559 frontend tests; clippy, docs, typecheck and standard app/DMG build all exit 0. Controlled startup now passes at 239.55 ms p50 release / 266.13 ms debug (ten samples each). Native rendering still fails after the live-history correction: 3 misses release, 12 debug; detailed full results below. No result has been filtered or relabeled as passing.

Base: `0b585df` on main, which includes composer merge `a8ef758`. Work is isolated in the `e2ce` worktree. The separate keep-awake task has uncommitted changes in the main checkout; those have not been changed here.

## Changes and evidence

- **Source-verified measurement defect:** a constant 33.33 ms callback interval became a passing 30 Hz display under the old p10/p50 inference. The meter now uses the fixed 60 Hz requirement. It records rAF timestamps rather than post-drain wall-clock differences, keeps foreground stalls longer than a second, retains terminal/partial windows, rejects interrupted or short captures, and persists raw intervals. Seven regression tests cover the relevant failure cases. This strengthens the existing threshold; it does not reduce the workload.
- **Source-verified startup defect:** the one-shot FCP report used `AppState`, which can still be pending. A native baseline rendered its workspace but never recorded FCP. Reporting now uses the launch data directory, available before provider/store readiness.
- **Measured startup trace:** one instrumented baseline launch reached setup exit at 175.0 ms, page-load finish at 237.4 ms, DOMContentLoaded at 287.7 ms, and FCP at 309.7 ms after main entry. This identifies a frontend loading interval; it is not a JavaScript CPU profile.
- **Startup change:** the existing readable logo/status is available in initial HTML and replaced by React. The loading status no longer waits through a 600 ms zero-opacity delay. The browser's FCP observer remains unchanged. This is startup feedback, **not workspace readiness**; no artificial dwell or delayed initialization was introduced.
- **Fixture correction:** every burn gets a fresh repository under the isolated application's data directory. Session-start events use that repository instead of an obsolete captured cwd. Replay events and the configured 10 × 200 events/second × 60 seconds remain unchanged.
- The composer, Auto/Custom controls, archive/settings behavior and database schema are unchanged by this task. Their automated suites pass. Native functional verification after final integration remains required.

API and source findings: [native timing research](../research/native-performance-timing-2026-09-09.md). The historical [feed rendering recommendation](../research/feed-rendering.md) now marks adaptive cadence inference as retired.

## Measurements so far

Host: Apple M4 Pro; macOS 26.6.2 (25G83); built-in display only; AC power. `scripts/measure-native-display.swift` observed selected mode 120 Hz, nominal period 200000/24000000 seconds, running actual period 0.00833333646 seconds, and maximum FPS 120. This is independent panel evidence. The repository's acceptance target remains 60 Hz. rAF opportunities are not compositor presentation acknowledgements.

| Release startup experiment | Complete FCP samples | Pre-spawn p50 | Minimum | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Instrumentation-only baseline | 10/10 | 326.61 ms | 309.37 ms | 1184.08 ms |
| Initial HTML status + immediate loading state | 10/10 | 284.78 ms | 248.48 ms | 1182.68 ms |

Raw samples: [before](../performance/2026-09-09/startup-before.json), [after experiment](../performance/2026-09-09/startup-after-experiment.json). Every sample, including the slow first launch, is retained. These are repeated launches with warm caches, not cache-cleared startup. Pre-spawn includes process-creation overhead and is a conservative exec approximation. Native/browser epoch subtraction is approximate; measured wall/monotonic drift was under 0.21 ms.

**The after experiment is provisional:** it used a temporary always-on-top window, and the first launcher did not independently reject screen lock. The final harness now checks lock state; the final benchmark configuration uses ordinary window behavior. Repeat startup with stable display settings and then on the final installed build before calling the startup gate complete.

Native burn attempts all used 10 sessions, 200 rows/second each, for 60 seconds. None is a valid passing result:

| Attempt | Result |
| --- | --- |
| Initial background window | No rAF samples; invalid |
| Foreground attempt | Hidden during capture; 47 windows; 1,938 missed target opportunities; worst 94 ms; invalid |
| Temporary always-on-top attempt | Hidden during capture; 27 windows; 3,312 missed target opportunities; worst 28,373 ms; invalid |

Raw interrupted captures: [baseline attempt](../performance/2026-09-09/burn-interrupted-baseline.json), [after attempt](../performance/2026-09-09/burn-interrupted-after.json). No windows were filtered out to manufacture a pass.

**Confirmed external interference:** the owner's concurrent keep-awake test intentionally changed AC display sleep from two hours to one minute and, with explicit owner authorization, stopped this task's one-hour caffeinate process. The task's agent confirmed this and subsequently confirmed the Mac was locked. It is waiting for the owner to unlock before restoring the prior setting. Native acceptance is paused until restoration is verified. These interrupted runs do not diagnose a foreground rendering bottleneck.

## Functional gates

Measured before integration with the keep-awake task:

| Gate | Result |
| --- | --- |
| `cargo test --workspace` | Exit 0; 802 passed, 12 ignored across 43 reported suites |
| `cargo clippy --workspace --all-targets -- -D warnings` | Exit 0 |
| `cargo doc --workspace --no-deps` | Exit 0 |
| `npm test` | Exit 0; 555 passed in 68 files |
| `npx tsc --noEmit` | Exit 0 |
| Isolated release app build with burn enabled | Exit 0 |
| Default `npm run tauri build` | Exit 0; ordinary macOS app and DMG built |
| `git diff --check` | Exit 0 |

## Reproducible workflow

Use a unique application identifier and its matching disposable data directory. Never burn against `ai.brigadier.app`. The script refuses that normal data-directory name. Build before timing; do not run builds, HMR edits, screen capture, UI tools or profilers during an acceptance run.

The setup used `/tmp/brigadier-perf-e2ce/tauri.json` with these overrides (the repository's ordinary window settings otherwise apply):

```json
{
  "identifier": "ai.brigadier.perf.e2ce",
  "productName": "Brigadier Perf",
  "app": { "windows": [{
    "label": "main", "title": "Brigadier Perf", "url": "index.html?burn=auto",
    "visible": false, "transparent": true, "theme": "Dark", "decorations": true,
    "titleBarStyle": "Overlay", "hiddenTitle": true,
    "width": 1280, "height": 800, "minWidth": 800, "minHeight": 500
  }] }
}
```

Seed **only that identifier's** `workbench.json` with completed onboarding:

```json
{"displayName":"Performance Fixture","nameConfirmed":true,"welcomeCompleted":true,"introSeen":true,"launchMusic":false}
```

```sh
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR=/tmp/brigadier-perf-e2ce/target
VITE_BURN=1 npm run tauri build -- --features burn \
  --config /tmp/brigadier-perf-e2ce/tauri.json --bundles app

swift scripts/measure-native-display.swift
python3 scripts/measure-native-startup.py \
  '/tmp/brigadier-perf-e2ce/target/release/bundle/macos/Brigadier Perf.app/Contents/MacOS/brigadier' \
  --activate-helper /tmp/brigadier-perf-e2ce/activate-native-benchmark \
  --paint-log "$HOME/Library/Application Support/ai.brigadier.perf.e2ce/paint.ndjson" \
  --output /tmp/brigadier-perf-e2ce/startup.json --runs 10
python3 scripts/measure-native-burn.py \
  '/tmp/brigadier-perf-e2ce/target/release/bundle/macos/Brigadier Perf.app/Contents/MacOS/brigadier' \
  --activate-helper /tmp/brigadier-perf-e2ce/activate-native-benchmark \
  --data-dir "$HOME/Library/Application Support/ai.brigadier.perf.e2ce" \
  --output /tmp/brigadier-perf-e2ce/burn.json
```

The burn script runs the native executable, keeps display/system sleep inhibited only for that child, waits for the automatic replay, saves the complete capture and terminates only its own child. The automatic replay starts twenty seconds after the harness mounts; exact-PID activation must complete during preparation. An optional `&profile=1` URL records worst synchronous feed-drain cost per window; profiling captures are not acceptance results. The capture also records the prior idle window, visibility/focus, raw intervals, user agent and paint-entry support.

For debug/Vite, use the same overrides under a second identifier (`ai.brigadier.perf.e2ce.debug`) with `build.devUrl` set to `http://localhost:1422`. Build using `TAURI_CONFIG` set to the JSON override and `cargo build -p brigadier`; start `VITE_BURN=1 npm run dev -- --port 1422` and wait for Vite readiness before launching `target/debug/brigadier`. No Rust watcher is involved. Do not edit frontend files during the series. **Debug/Vite measurements are still pending.**

## Remaining work

1. Unlock and restoration of the two-hour display timeout completed; keep-awake commit `1846f8b` integrated without conflicts.
2. Run clean foreground release and debug/Vite startup/burn series; profile any remaining foreground failure separately, fix it, and repeat the unchanged workload.
3. Verify composer and archive/settings natively after integration with current main.
4. Rerun required gates on the integrated source; commit and merge only when verified.
5. Build and replace `/Applications/Brigadier.app` without backups, verify launch and installed startup, and remove only this task's fixtures/worktree.

The installed app and the owner's data have not been replaced or edited by this task.

## Integrated continuation — 2026-09-10

Integrated main commit `1846f8b` without conflicts. The source task confirmed that its build/test and UI activity had stopped. On the integrated source, Rust workspace tests, frontend tests, TypeScript, full Clippy, rustdoc, and the isolated benchmark app/DMG build exited 0. The ordinary production app and DMG build also exited 0.

Three further native captures remain **invalid**, with all raw intervals retained:

| Capture | Initial / final visibility | Duration | Dropped opportunities | Worst interval |
| --- | --- | ---: | ---: | ---: |
| Executable runner, integrated source | Hidden during capture; console unlocked, sleep assertion alive | 63,624 ms | 2,874 | 20,243 ms |
| App-controller launch diagnostic | Hidden / hidden | 64,030 ms | 3,268 | 18,905 ms |
| Window raised, coordinate Burn click | Visible and focused / hidden and focused | 63,960 ms | 2,686 | 14,362 ms |

The last capture establishes that initial activation alone did not keep the document visible. It does not establish why WebKit later classified it as hidden. The owner subsequently confirmed using other apps during the capture, so these runs cannot isolate foreground rendering performance. No competing builds or profiling ran during these captures. The app-controller and coordinate-click runs are diagnostics, with UI observation at initiation; they are not substituted for the automated acceptance result. No valid rendering pass, merge, or installation is claimed.


**Visible foreground result:** after the owner agreed to leave the window unobstructed, the integrated release capture completed with `interrupted=false`, unlocked console and a live sleep assertion. It failed the rendering gate: **63,501 ms**, **62 windows**, **2,499 missed 60 Hz opportunities**, **105 ms worst interval**. The pre-burn idle window had 60 callbacks and zero missed opportunities; loaded windows sampled here delivered approximately 19–25 callbacks/second. Initial focus was false, final focus true, and visibility remained true throughout. The window was raised at initiation; this timing overlap means a subsequent automated acceptance repeat is still required. Each run's workload repository was fresh, but earlier fixture projects remained in the isolated app data (maximum DOM nodes 1,562); profiling and a clean-data repeat are pending. These results disprove a foreground rendering pass; they do not identify the responsible CPU work.


**Clean-data feed-drain diagnostic:** after clearing only the isolated benchmark identifier's data and seeding completed onboarding, ran the unchanged 10 × 200 rows/s × 60 s workload with `&profile=1`. The console stayed unlocked, sleep assertion remained live, and document visibility stayed true (`interrupted=false`). Initial focus was false; final focus was true. This profiling capture is explicitly excluded from acceptance. It recorded **63,416 ms**, **62 windows**, **2,488 missed opportunities**, **106 ms worst interval**, and **1,116 maximum DOM nodes**. The median of per-window maximum synchronous drain costs was **1 ms**; the maximum over the whole run was **4 ms**. Draining includes store mutation and subscriber notification, but excludes subsequent React rendering and browser layout/paint. These measurements narrow the investigation beyond the synchronous drain; they do not attribute stalls to a specific component. Raw evidence: `../performance/2026-09-09/release-profile-clean.json`.

Next diagnostic should measure React commit/subtree costs and native WebContent CPU stacks separately. Source inspection identifies broad signal-driven App/Sidebar/Transcript updates, per-event read-marker storage writes, and unchanged history publications as candidates; no optimization is credited before a controlled repeat. The latest source audit and exact native sampling procedure are in `../research/native-performance-timing-2026-09-09.md`.


## Recovery and diagnostic continuation — 2026-09-10

At initial inspection the performance worktree was detached at `1846f8b`, with fourteen modified tracked files and the six untracked source/report files plus nine captures listed above. While read-only inspection was ongoing, an external session removed the entire `e2ce` directory. The owner confirmed other sessions were running. Main still had only its unrelated untracked delivery-efficiency research file.

Recovered the tracked edits from Git's retained `AUTO_MERGE` tree `72ab73088a6d3ffa6c8ca4d3223e96142c214d96`; no tracked-source edits occurred after that tree in the original task history. Recovered the untracked scripts/tests/reports by replaying only recorded literal text writes/replacements from the original task and its research subagent, and the nine captures from their surviving `/tmp/brigadier-perf-e2ce/` originals. The restored changed-file list matches initial inspection. Recovery script and hashes are retained under `/tmp/brigadier-perf-e2ce/recover-source.py` and this task's tool history. Main, installed application and real user data were not altered.

Diagnostic instrumentation uses a separate `VITE_REACT_PROFILE=1` production React renderer, buffered React timing spans and counters; see [verified profiling setup](../research/native-react-profiling-2026-09-10.md). The harness preparation delay is now twenty seconds, with activation before capture. Producer emission totals and frontend session counters will establish actual workload delivery. These changes are not yet measured or accepted.

The first diagnostic build exited 1 (TypeScript syntax error in the new root wrapper); corrected the trailing JSX comma. Its log is retained as `react-profile-build.log`. The subsequent build and native diagnostics remain pending.


**Post-hoc delivery evidence:** read only the retained isolated diagnostic database before any reset. Ten session `last_event_seq` values sum to **121,464**, range **12,001–12,281**. This is consistent with sequential session creation and the sixty-second kill timer starting after the final session starts (`src-tauri/src/burn.rs`); it is not proof of simultaneous ten-session delivery for exactly sixty seconds. Raw session metadata is retained in `/tmp/brigadier-perf-e2ce/previous-profile-stored-delivery.json`. The next diagnostic records the producer counter directly and the final frontend session counters rather than relying solely on configuration. No previous FPS sample is discarded or reclassified as passing.

The second profiling release build exited **0**, Rust release build 1m07s, frontend build 27.39s. Recovered meter/feed-store tests exited **0**, **37 passed** in two files. Logs: `react-profile-build-2.log`, `recovered-meter-tests.log`. The operator foreground request is pending; no new timed run has started.


**First React-profile attempt — invalid harness activation:** after owner confirmation, launched the diagnostic with fresh isolated app-support/WebKit/cache data. `open -a` spawned a second benchmark instance (PIDs 86985 and 86990), with two new WebContent PIDs (86993 and 86996). The sampler correctly refused ambiguous process attribution. The producer completed (121,776 emissions over 61,842 ms including staggered startup), but no frontend capture file was exported. The new detailed component spans could exceed the pre-existing 2 MB capture limit; that explanation is a source-identified risk, not a measured error message from this run. The original capture limit remains unchanged. Both task-owned benchmark processes were terminated; installed Brigadier was untouched. Harness exit 1; wrapper exit 0 only means its orchestration script completed. Saved failed result and PID inventory in `docs/performance/2026-09-10/`.

Remedies: activation now uses a precompiled exact-PID AppKit helper and requires stable foreground observation, with twenty seconds of harness preparation. Diagnostic component timing is aggregated by component while root render samples and React commit spans remain buffered; raw frame intervals are retained unchanged. A diagnostic-export failure now retries a minimal capture containing all raw frame windows and the export error. The revised profiling build exited 0 (frontend 24.21s, Rust release 43.48s). Corrected diagnostic run awaits foreground confirmation.


**Corrected React/WebContent diagnostic (before native fix):** exact-PID activation succeeded (native PID 11395), one new WebContent PID 11402 was observed, and its 15-second native stack sample exited 0. No hidden-window interruption occurred. Capture covered **63,475 ms**, **2,512** missed 60 Hz opportunities, **299 ms** worst interval. This was a profiling run, not acceptance. Initial document focus was false, final true despite successful native activation; document visibility stayed visible. The initial idle window had sixty callbacks, zero misses, worst 18 ms. DOM maximum 504 with fresh WebKit/cache preferences; older runs used different persisted UI state and larger DOM counts, so do not attribute that DOM reduction to a performance fix.

Buffered React evidence: **2,708 root Profiler callbacks**, render actual duration **2 ms p50, ~4 ms p95, 19 ms max**, 4,650 ms total (nested component totals overlap and must not be summed). React commit spans total 2,321 ms; p50 ~2 ms, p95 3 ms, one 280 ms maximum. App/Sidebar/Transcript component-span counts were 1,738/1,737/1,701. **869** store rebuilds, **812** read-state persistence writes, **223** history responses, only **4** empty responses. Empty history responses therefore do not explain the sustained failure in this workload.

Native WebContent evidence: **10,514 of 12,535 main-thread stack samples (~83.9%)** were waiting in the run loop's Mach message receive, not executing React or layout. This is sampled wall-clock residency, not a precise CPU benchmark. It contradicts an assertion that WebContent computation saturates this capture. Trace and attribution JSON are retained under `docs/performance/2026-09-10/` (native text compressed with gzip).

Actual delivery: producer and ten raw NDJSON logs agree on **121,623 total envelopes** (including terminal events); each session received 12,001–12,305 over 60,008–61,546 ms. Sequential worktree creation gives early sessions extra run time. Frontend ingestion saw **19,079 terse rows**, while each session reported approximately **8,663 backend row drops** and was still behind the terminal sequence at capture end. This is a delivery failure as well as a frame failure; requested configuration alone cannot pass acceptance. Per-second event bins and event kinds are preserved in `react-profile-before-2-raw-delivery.json`.

**Source-identified native mechanism under test:** `ChannelSink::send` calls `peer_completion::observe_signals` before sending the feed. Each turn completion calls `peers::change` twice; even ordinary sessions absent from both assignments and subagents cause cloned state to be serialized, a temporary file written, `sync_all`, rename, and peer-state notifications. `peer_snapshot` is a synchronous Tauri command that takes the same mutex; the frontend filters equal results but still requests them. The ordinary replay leaves peer data unchanged. A native-process sample and controlled before/after comparison are still required before assigning a measured share of the stalls to this path.

Implemented a guarded peer mutation whose eligibility predicate runs under the mutation mutex. Terminal assignment updates run only for registered assignments, completion receipts only for registered subagents. Their existing durable write and notification path is preserved. Existing unconditional changes, including startup persistence, remain unconditional. Added regressions for unowned events performing no writes, owned mutations reaching disk and memory, and failed writes not publishing in-memory state. Focused peer tests exited **0**, **25 passed**. This fix remains unverified against the performance gate and uncommitted.

**Guarded-persistence diagnostic:** profiling build exited **0**. Exact-PID activation (54449) and 15-second native `sample` exited **0**. Full visible capture: **63,233 ms**, **7** missed opportunities in two of 63 windows, worst **72 ms**. The strict gate still fails. Source change between diagnostic builds was the guarded peer mutation; profiling instrumentation and requested workload were unchanged. Producer/raw logs agree on **121,069** envelopes; frontend received **107,614/107,614** canonical terse rows, zero reported drops, and all ten terminal sequences. Previously it ingested only 19,079 rows and remained behind terminal state. This intervention supports no-op durable peer writes as a major cause of the sustained failure; the precise pre-fix native mutex-wait fraction was not sampled.

After-fix React work increased with restored delivery: 10,976 root callbacks, 11,196 ms total actual render time (maximum 10 ms); 4,355 React commit spans totaling 5,666 ms, maximum 3 ms. App/Sidebar/Transcript span counts 6,628/6,680/6,495. Native main thread waited in Mach receive in 10,618/11,788 samples (~90.1% sampled wall residency); the sample starts after the two failing early windows and cannot explain their precise cause. No frontend speculative optimization is credited. Raw capture, native sample, PID attribution and per-session delivery evidence are retained under `docs/performance/2026-09-10/peer-noop-after*`.

**Stricter workload audit:** one last-started session produced 11,977 workload events plus its terminal event over 60,000 ms. The synthetic replay's `Delay` tick mode can reduce actual delivered rate after lateness. Changed only that synthetic timer to `Burst`, retaining original deadlines/catching up; see the cited Tokio research. No provider events, frame thresholds, UI, capture windows or stalls are reduced. Early sessions still run longer during sequential native worktree preparation; all of that extra work remains captured and reported. The acceptance harness now additionally requires ten distinct sessions, contiguous durable sequences matching the producer total, at least 12,000 workload events and 60,000 ms per session, zero backend drops, terminal frontend sequences, matching terse-row counters and total ingestion, successful exact-PID activation, and no React/drain profiling. The prior after-fix diagnostic fails this stronger delivery audit as well as the frame gate; it is retained rather than excluded.

**Unprofiled acceptance 1:** isolated release build exited **0**. After foreground confirmation, exact-PID activation succeeded and capture stayed visible/unlocked for **63,315 ms**. **FAIL:** 2 missed opportunities, consecutive 30/35 ms intervals in window 2 (thread selection/mount after the tenth session starts), worst p95 23 ms; all other windows met the frame clauses. Full capture retained in `peer-noop-acceptance-1.json`. Delivery audit **passed**: 121,521 producer envelopes matched contiguous raw logs, each session delivered at least 12,000 workload events over at least 60,000 ms, every terse row reached frontend ingestion, no backend drops, all terminal sequences observed. Profiling was disabled and diagnostics null. No screenshots, UI automation, sampling, builds or HMR ran during capture.

Follow-up frontend correction targets measured excess updates, not a claimed explanation of the exact two stalls: read-marker notifications previously scheduled fresh App state for every viewed-session event. `useAttention` now exposes a stable primitive snapshot of badge outcomes through `useSyncExternalStore`, while every sequence is still persisted and approvals remain authoritative. The unchanged-badge path does not schedule another App render. Transcript's saved scroll initializer now runs once per keyed mount rather than evaluating localStorage on every render. The targeted test verifies 99 viewed-event advances produce exactly 99 parent-driven renders, preserve the latest persisted read sequence, keep the task read after leaving, and show subsequent unread activity and pending approvals. Full frontend tests exit **0**, 557 tests/68 files; typecheck exit **0**. Native comparison remains pending.

Main advanced to `d3f5bea` (ownership/approval and completed-transcript fixes). Preserved tracked performance edits in Git stash `4f29cedc2bf8cffc36c786c12680ea443f30ed0b` plus `/tmp/brigadier-perf-e2ce/before-main-d3f5bea.patch`, fast-forwarded this detached worktree, then reapplied the exact stash without conflicts. All performance edits and untracked evidence remain; main itself and its unrelated research file were not modified. Pre-integration gates: Rust tests exit 0 (807 passed, 12 ignored); clippy exit 0; cargo doc exit 0; frontend tests exit 0 (557 passed); typecheck exit 0. All six gates are being repeated against the integrated source.

All six gates passed on `d3f5bea` plus the peer/attention/scroll changes: direct exits recorded in `/tmp/brigadier-perf-e2ce/integrated-d3f5-gates.json`, including the standard `npm run tauri build` (99.61 s). Frontend: 558 tests. A subsequent source/diagnostic review found another required correction, so these results are not asserted as final for the history change below.

**Measured live-history starvation:** after peer feed recovery the same profiling capture reported only **2 history responses in 63 seconds**, versus 223 in the stalling baseline. Source confirms `changed()` clears/restarts a 100 ms trailing debounce for each ~16 ms feed update, indefinitely postponing live transcript refresh. A complete IPC delivery audit alone therefore does not establish live ThreadView work. Changed this to schedule one refresh at the first notification and coalesce subsequent notifications without moving its deadline; in-flight requests still queue one follow-up and older-history browsing remains isolated. Regression drives notifications every 20 ms for three seconds and requires continued history updates before the stream stops, final catch-up, frozen older browsing and restored latest mode. Targeted history/attention tests exit 0. The burn now records the actually mounted transcript's history responses and final item sequence. Acceptance additionally requires ongoing refreshes (at least 60), exactly one mounted transcript and its final item sequence matching the raw canonical item stream. Prior captures lack this stronger audit and remain preserved as historical failures.


## Prepared controlled comparison after live-history correction

The six direct exits and two benchmark build exits are preserved in `docs/performance/2026-09-10/live-history-gates.json`. Standard build: 93.58 seconds; isolated release build: 69.99 seconds; debug binary: 16.91 seconds. Neither build has been installed. Release benchmark bundle is frozen at `/tmp/brigadier-perf-e2ce/LiveHistoryAcceptance.app` so subsequent debug builds cannot replace its executable.

Startup launcher now activates the exact spawned PID during the original pre-spawn measurement interval (the clock is never moved forward), rejects failed activation, and refuses to overwrite a saved series. Ten launches are required, with every sample retained and p50 computed only for a complete valid series. Burn uses fresh isolated support/WebKit/cache directories after the startup series, keeping real app data untouched. Debug uses identifier `ai.brigadier.perf.e2ce.debug`, port 1422, disabled HMR updates and filesystem watching; the verified configuration is in the profiling research note. Release captures run before starting Vite. All builds finish before foreground confirmation.

Commands for the prepared release (same structure for debug binary, identifier and log path):

```sh
python3 scripts/measure-native-startup.py \
  '/tmp/brigadier-perf-e2ce/LiveHistoryAcceptance.app/Contents/MacOS/brigadier' \
  --activate-helper /tmp/brigadier-perf-e2ce/activate-native-benchmark \
  --paint-log "$HOME/Library/Application Support/ai.brigadier.perf.e2ce/paint.ndjson" \
  --output /tmp/brigadier-perf-e2ce/live-history-release-startup-1.json --runs 10
python3 scripts/measure-native-burn.py \
  '/tmp/brigadier-perf-e2ce/LiveHistoryAcceptance.app/Contents/MacOS/brigadier' \
  --activate-helper /tmp/brigadier-perf-e2ce/activate-native-benchmark \
  --data-dir "$HOME/Library/Application Support/ai.brigadier.perf.e2ce" \
  --output /tmp/brigadier-perf-e2ce/live-history-release-burn-1.json
```

The wrapper `/tmp/brigadier-perf-e2ce/run-controlled-comparison.py` resets only the two explicit benchmark identifiers, runs release startup/burn, starts the prepared Vite server, then runs debug startup/burn and stops only its server. It continues comparisons after a failed measurement and records each direct exit; it does not discard failures. The four-minute foreground request is pending.

**Controlled comparison completed after owner confirmation:** ten repeated launches per build; all samples retained, all exact-PID activations succeeded. Release pre-spawn→FCP **239.55 ms p50** (range 222.55–1,067.35 ms); debug/Vite **266.13 ms p50** (range 262.77–1,961.86 ms). Both complete startup series pass ≤295 ms. Cold first samples were not excluded. These are controlled repeated launches with warm caches after the first sample, initial HTML status FCP, not workspace readiness. Raw samples and direct exits are in `live-history-{release,debug}-startup-1.json` and `controlled-comparison-exits.json`.

Release burn: **63,135 ms**, visible/unlocked, **3 missed opportunities**, worst **33 ms**, p95 maximum 21 ms. Two misses cluster at initial thread mount (window 1), one 28 ms interval in window 8. **FAIL**. Actual producer/raw counts 121,259; 107,783 terse rows ingested, all terminal sequences and selected transcript final item sequence reached. Transcript fetched **534** responses rather than the previous starvation count of 2. The delivery audit nevertheless fails its literal raw timestamp-span clause: the last session has 12,001 workload events plus exit, but first-to-terminal wall timestamps differ by **59,999 ms**. This run remains failed and preserved; the one-millisecond duration interpretation needs explicit treatment, not silent sample removal.

Debug/Vite burn: **63,377 ms**, visible/unlocked, **12 missed opportunities**, worst **44 ms**, p95 maximum 24 ms. **FAIL**. Producer/raw counts 121,475; 107,975 terse rows ingested; full delivery audit passes, with **539** selected-transcript refreshes and its final item sequence reached. Vite HMR and filesystem watching were disabled; no builds, screenshots, automation or profiling occurred during either acceptance burn.

**Native controls, separate non-acceptance run:** used the frozen isolated release bundle and only disposable replay chats. Verified new-chat Auto→Custom exposes provider/model/effort controls; selecting low effort updates the composer, resetting restores the provider default, and selecting Auto hides Custom controls. Existing replay chats correctly advertise Custom, with Auto available only for new tasks. Archived completed fixture `Session b72a07`, observed it in Settings → Archived chats, and restored it. Enabled keep-awake in General, quit/relaunched, verified it remained enabled, then restored it off. No real chat/provider turn was sent; native approval decisions and actual idle-lock behavior were not re-exercised here (automated approval suites and prior keep-awake native evidence remain separate). The automatic burn during this UI/build session is explicitly **invalid for performance conclusions** and its raw capture is preserved as `native-controls-burn-invalid.json`. The app was closed after checks; installed application and real identifier data untouched.

The early-stall diagnostic release build exited **0**. It includes source-version-matched React timing plus resource timestamps and will sample the unique WebContent process beginning around 22 seconds after spawn, covering initial thread mount rather than only steady state. Foreground request pending; no further acceptance result claimed.


## Owner-requested checkpoint and handoff

The owner requested committing the work so far and either resolving the remaining rendering failures or providing a continuation prompt. This checkpoint preserves the fixes, strengthened harness, passing six functional/build gates, and every recorded failed or invalid capture. It is explicitly **not** a native-performance acceptance or authorization to install a failing build. Remaining measured blocker: initial ThreadView mount intervals and isolated later intervals miss the fixed 60 Hz budget; their residual cause is not yet established. The prepared early WebContent/React diagnostic has not run. No additional quiet foreground window is assumed. Main, installed app, real user data, benchmark builds and the performance worktree are preserved for continuation. Historical “pending” and “uncommitted” entries above describe their point in the investigation; this section and the opening status describe the checkpoint.
