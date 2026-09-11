# Baseline manifest — P0, 2026-09-11

What this pins: the source, the toolchain, the machine, and every raw capture kept under
`docs/performance/2026-09-11/`. It records provenance; it certifies nothing. No build, benchmark or app
run was performed to produce it — every number below is read out of a file, a lockfile, or a read-only
command.

Written on branch `perf/efficiency-2026-09-11` in the worktree
`/Users/stephen/Development/brigadier-ai.worktrees/perf-efficiency`. Review that ordered it:
`docs/plans/efficiency-plan-review-2026-09-11.md` (B11, B3).

## Source

| Item | Value |
|---|---|
| Baseline commit | `95577c3ee95aeafe59ca1a67e4410886fd3875b3` ("Reduce transcript render work and prepare timestamp labels off-thread") |
| Branch | `perf/efficiency-2026-09-11` |
| Tree state | dirty — the batcher patch plus this package's own files; every untracked plan/research note listed by `git status --porcelain` |

### The working-tree batcher patch

`git diff --stat -- crates/supervisor/src/batcher.rs` on this branch:

```
 crates/supervisor/src/batcher.rs | 111 ++++++++++++++++++++++++++++++++++++---
 1 file changed, 104 insertions(+), 7 deletions(-)
```

- `git patch-id --stable` of that diff: `203e1e50ff02558900c68afaf1f537b6c0fe956a`.
- File SHA-256 of the patched `crates/supervisor/src/batcher.rs`:
  `5285229d5b86088cebebed8d488f1b7c23b76bca0ca964ca9229b6ea5e0c91b8`.
- **This is not the patch the plan describes.** `docs/plans/efficiency-and-rendering-plan-2026-09-11.md` §2
  cites patch ID `df4f0086f73ba0a5df87537adba59ca47169a80d`; that ID belongs to the backup
  `/tmp/brigadier-release-20260911/other-task-batcher-before-merge.patch`, which is 25 insertions / 6
  deletions. The worktree patch is a later, larger version that already carries the review's B7
  corrections (deadline-anchored `sleep_until`, signal-drop counter and warning, the `set_visible_projects`
  no-wake invariant documented). Diff and backup are **not** identical; treat the plan's patch ID as stale.
  Not checked: whether anything builds or passes with it, and whether the loop tests B7 asks for exist.
- **Snapshot, not a fixed point.** A concurrent P1 worker is editing `crates/supervisor/src/batcher.rs`
  and `docs/plans/ipc-contract.md` in this same worktree; the stat, patch ID and file hash above were
  taken on 2026-09-11 and will move as that work lands.

## Toolchain, dependencies and provider

| Item | Value | Source |
|---|---|---|
| `claude --version` | `2.1.268 (Claude Code)` | run read-only in this worktree |
| tokio | 1.53.1 | `Cargo.lock:4670-4671` |
| tauri | 2.11.5 | `Cargo.lock:4251-4252` |
| notify | **absent** | `grep '^name = "notify' Cargo.lock` → 0 matches; no watcher crate is in the lockfile |
| rustc / cargo | 1.98.1 (48a229cea 2026-09-01) / 1.98.1 (797e8a9bc 2026-08-05) | `rustc --version`, `cargo --version` |
| node / npm | v24.18.0 / 11.16.0 | `node --version`, `npm --version` |

The shell's `claude` is one binary; per the plan's own caution this is not proof that every running session
used it. Nothing here records per-session CLI versions — that needs a live session and was not done.

## Machine

| Item | Value |
|---|---|
| macOS | 26.6.2 (build 25G83) |
| CPU | Apple M4 Pro, 14 logical cores |
| Memory | 25769803776 bytes (24 GiB) |

## Capture binding

Every `.json` under `docs/performance/2026-09-11/`. Numbers extracted programmatically from each file
(`capture.summary`, `capture.initialVisibility` / `finalVisibility`, `delivery_audit.pass`); "Added by" is
`git log --diff-filter=A --format=%h -- <file>`, and "this branch" means the file arrives with this
uncommitted P0 change.

| File | Worst ms | Dropped | Duration ms | `interrupted` | Visibility initial → final | Windows | `summary.pass` | Delivery audit | Added by | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| `burn-dark-icon.json` | 63059 | 3783 | 63059 | true | hidden → hidden | 1 | false | fail — transcript final item seq | this branch | invalid: never visible |
| `burn-final-fresh.json` | 62880 | 3772 | 63679 | true | visible → hidden | 1 | false | fail — transcript refreshed < 60× | this branch | invalid: went hidden |
| `burn-fixed.json` | 52 | 11 | 63496 | false | visible → visible/focused | 64 | false | pass | this branch | |
| `burn-fresh-session.json` | 44807 | 2693 | 63586 | true | visible → hidden | 19 | false | fail — frontend row count/drop mismatch | this branch | invalid: went hidden |
| `burn-full-feed.json` | 55 | 5 | 63534 | false | visible → visible | 64 | false | pass | 95577c3 | the 55 ms capture the handoff cites |
| `burn-grouped-tooltip.json` | 18271 | 1256 | 63707 | true | hidden → visible | 45 | false | pass | this branch | invalid: started hidden |
| `burn-layout-candidate.json` | 51 | 4 | 63599 | false | visible → visible | 64 | false | pass | this branch | |
| `burn-lazy-tooltip.json` | 53 | 7 | 63546 | false | visible → visible | 64 | false | pass | this branch | rejected lazy-tooltip experiment |
| `burn-owner-ready-fix.json` | 4195 | 258 | 63376 | true | visible → visible/focused | 59 | false | pass | this branch | invalid: interrupted |
| `burn-owner-ready.json` | 44 | 3 | 63430 | false | visible → visible/focused | 64 | false | pass | this branch | |
| `burn-quiet-session.json` | 47 | 10 | 63467 | false | visible → visible/focused | 64 | false | fail — frontend row count/drop mismatch | this branch | |
| `burn-raised.json` | 43 | 3 | 63555 | false | visible → visible | 64 | false | pass | f112a24 | |
| `burn-shared-clock.json` | 45 | 5 | 63470 | false | visible → visible | 64 | false | pass | this branch | **the 45 ms headline capture, recovered from `/tmp` by this package** |
| `burn-ui-fix.json` | 50091 | 3009 | 63407 | true | visible → visible | 15 | false | pass | this branch | invalid: interrupted |
| `burn-uninterrupted.json` | 3282 | 198 | 63581 | true | visible → hidden | 60 | false | pass | f112a24 | invalid despite the name: `interrupted: true` |
| `burn-worker-labels.json` | 40628 | 3369 | 63104 | true | hidden → hidden | 9 | false | fail — transcript final item seq | 95577c3 | the Worker-instrumentation run; invalid for rendering |
| `burn.json` | 42513 | 2552 | 63493 | true | visible → visible | 22 | false | pass | f112a24 | invalid: interrupted |
| `cold-profile.json` | 43006 | 3621 | 63421 | true | hidden → hidden | 5 | false | pass | this branch | diagnostics attached |
| `cold-six.json` | 61 | 6 | 63534 | false | visible → visible/focused | 64 | false | pass | this branch | diagnostics attached |
| `floating-profile.json` | 50 | 6 | 63589 | false | visible → visible/focused | 64 | false | pass | this branch | diagnostics: `exportError` only |
| `profile-before.json` | 41 | 3 | 63519 | false | visible → visible/focused | 64 | false | pass | this branch | diagnostics attached |
| `profile-current.json` | 18853 | 2028 | 63460 | true | visible → hidden | 31 | false | fail — transcript final item seq | this branch | diagnostics attached |
| `profile-fresh-six.json` | 52 | 6 | 63486 | false | visible → visible | 64 | false | fail — frontend row count/drop mismatch | this branch | diagnostics attached |
| `startup-uninterrupted.json` | — | — | — | — | — | — | — | — | f112a24 | startup run: p50 270.6 ms, `pass` true |
| `startup.json` | — | — | — | — | — | — | — | — | f112a24 | startup run: p50 308.5 ms, `pass` false |
| `timestamp-fix-manifest.json` | — | — | — | — | — | — | — | — | 95577c3 | build manifest, not a capture |

Reading the table:

- **`summary.pass` is `false` in every row, and in every burn JSON in this repository's history** — 2026-09-09,
  2026-09-10 and 2026-09-11, all 36 files that carry a rendering summary. The 60 Hz zero-drop gate has never passed here. The best run ever
  recorded is `docs/performance/2026-09-10/ship-release-burn.json`: 2 dropped, worst 29 ms, `pass: false`.
  Two other runs also dropped 2 (`2026-09-10/final-release-burn.json`, worst 37 ms;
  `2026-09-10/peer-noop-acceptance-1.json`, worst 35 ms).
- `interrupted: true`, a hidden initial or final visibility, or a window count far below 60 means the
  capture is invalid for rendering acceptance regardless of its numbers. Eleven rows above are in that state.
- "Delivery audit" is the runner's `delivery_audit.pass`, an independent check of producer → durable
  envelopes → UI counters. It passes on several captures whose rendering result is invalid; the two verdicts
  are separate and must not be merged.
- The six `profile-*` / `cold-*` / `floating-profile` files carry `capture.diagnostics`, which the runner's
  own pass rule rejects (`capture.get("diagnostics") is None`). They are diagnostic traces, not acceptance
  runs, and they are large: `profile-before.json` alone is 4.2 MB, and the six together are 8.42 MiB.
- `capture.profiling` is `false` in all of them; the size is the attached diagnostics payload.

## Release-build evidence for the 2026-09-11 captures

`docs/STATUS.md` §4 says every burn number in the project is a debug build. That is no longer true of these
captures, and the evidence is indirect, so it is written out here rather than asserted:

- The build logs beside each capture in `/tmp/brigadier-release-20260911/` (for example
  `shared-clock-perf-build.log`, `worker-perf-build.log`) run `tauri build --features burn --bundles app`
  and finish at `target/release/bundle/macos/Brigadier Perf.app` — a release profile, not `--debug`.
- `src/App.tsx:119` gates the burn UI on `import.meta.env.DEV || import.meta.env.VITE_BURN === "1"`, and
  `VITE_*` is a build-time literal substitution, so a release bundle that produced a burn capture at all
  must have been built with `VITE_BURN=1`.
- **[asserted, not measured]** No capture file records its own build flags — that is exactly the gap the
  `source` stamp below closes for future runs. The logs are not in this tree; `/tmp` is volatile.

## Provenance stamping from here on

`scripts/measure-native-burn.py` and `scripts/measure-native-startup.py` now write a top-level `source`
object into every result JSON: `head`, `dirty`, `dirty_files`, `branch`, `build_flags`, `captured_at`
(ISO-8601 UTC). Neither runner builds, so `build_flags` records the environment and arguments the runner
itself used and says so; it is not evidence that the binary was built with `VITE_BURN=1`. The pass rules are
untouched by the stamp. Every capture in the table above predates the stamp and therefore carries no
`source` — their revision binding rests on git add-time and on this file.

## Not checked

- Nothing was built, run, profiled or installed for this manifest.
- No cold-open WebKit trace was taken; that half of P0 is interactive and belongs to a separate order.
- Whether any listed capture's binary matches the commit it is filed under. `timestamp-fix-manifest.json`
  is the only file in the directory that records a binary hash.
