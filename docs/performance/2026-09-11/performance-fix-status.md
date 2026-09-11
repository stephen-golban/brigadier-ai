# Timestamp and transcript performance fix

The initial transcript trace contains 7–8 ms of synchronous locale formatting on the UI thread. Actual history pages now prepare timestamp labels in a dedicated Worker alongside their existing turn-metadata request, then publish the complete page. Worker failure falls back to the original locale formatting. No prewarming, postponed transcript mount, filtered intervals or relaxed benchmark threshold is used.

The remaining changes retain unchanged transcript adapters, callbacks, sidebar controls and timestamp labels through feed updates. User-message Markdown links retain keyboard focus across busy-state changes. A burn-only visibility lease fixes missing first events before the generated project becomes selected. Sidebar tooltips intentionally share Base UI's single-hint group; opening and leaving delays remain zero and 100 ms.

## Verification and limits

- Native Worker: 1 prepared minute label, 0 synchronous labels, 0 worker failures. [Raw native capture](burn-worker-labels.json).
- That capture started and ended hidden. Its frame-rate and delivery results are invalid; **the current source has no valid zero-drop certification**.
- Last visible complete-delivery baseline: 5 dropped opportunities, 55 ms worst frame, 20 ms worst-window p95. [Raw baseline](burn-full-feed.json). This predates the Worker and final callback/grouping changes.
- 700 frontend tests passed before the Worker change; 36 relevant timestamp, history and transcript tests passed afterward. TypeScript passed.
- Unchanged Rust source: 822 tests passed, 12 ignored; strict Clippy and rustdoc passed.
- The normal production build and strict deep signature verification passed. [Source, binary and icon hashes](timestamp-fix-manifest.json).
- Earlier-source startup measured 243.8125 ms p50 over ten valid launches. Current-source startup has not been certified.

Rejected containment/unopened-tooltip experiments and other intermediate captures remain preserved under `/tmp/brigadier-release-20260911`; their outcomes are recorded in the research note. They establish no passing gate.

## Delivery status

Complete signed bundle: `/tmp/brigadier-release-20260911/Brigadier-timestamp-fix.app`.

After reviewing the unresolved performance result and research, the user explicitly requested committing these changes, merging our branches/worktrees into main, removing our remaining branches/worktrees, and coordinating the remaining issue with the task "Reduce Brigadier CPU usage". This authorizes integration of the current work; it does not establish a passing performance result. That task received the findings but reports that the user's STOP instruction remains in effect, so further diagnosis and app installation are pending resumption. No further benchmark or full-suite run is required for this handoff. Production app data and protected design backups are unchanged; the installed app has not been replaced by this integration.

## 2026-09-11 review outcome

An adversarial review of the follow-on efficiency plan is at `docs/plans/efficiency-plan-review-2026-09-11.md`;
its P0 recovery work landed as `baseline-manifest.md` (source, toolchain, machine, and every capture in this
directory bound to its numbers and the commit that added it) and `timer-inventory.md` beside this file.

- The 45 ms shared-clock capture the plan quotes was only in `/tmp`. It is now `burn-shared-clock.json` here,
  with seventeen other recovered captures; the manifest's table says which are valid and which are not.
- **The 60 Hz zero-drop gate has never passed in this repository's history.** All 36 burn JSONs under
  `docs/performance/` that carry a rendering summary report `summary.pass: false`. The best run recorded is
  `docs/performance/2026-09-10/ship-release-burn.json`: `total_dropped: 2`, `worst_ms: 29`, 63 windows,
  `interrupted: false`, `pass: false` — verified by reading that file, not quoted from a note.
- `scripts/measure-native-burn.py` and `scripts/measure-native-startup.py` now stamp a `source` object
  (`head`, `dirty`, `dirty_files`, `branch`, `build_flags`, `captured_at`) into every result. Captures taken
  before today carry none; their revision binding rests on the manifest.
- Nothing above is a new measurement. No build, benchmark, profile or app run was performed for it.
