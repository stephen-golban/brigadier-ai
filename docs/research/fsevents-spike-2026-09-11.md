# FSEvents spike for P3 — measured, 2026-09-11

Run under the lead's decision 2 in `docs/plans/efficiency-plan-review-2026-09-11.md`: **`notify` is not added to this
repository.** This file is the measurement that decision asked for, so the lead can decide whether the dependency ever
lands. Nothing in this tree depends on `notify`; the spike lives outside the repo and its clones were deleted.

Every number below is **measured** on this machine unless tagged otherwise. Claims carried over from
`docs/research/efficiency-plan-external-facts-2026-09-11.md` §1 are tagged and, where this spike contradicts them, the
contradiction is stated in the same line.

## 0. Rig

- Hardware: Apple M4 Pro, 14 cores, 24 GB. macOS 26.6.2 (build 25G83), arm64. [measured]
- Toolchain: rustc 1.98.1, cargo 1.98.1, git 2.50.1 (Apple Git-155), node v24.18.0, npm 11.16.0. [measured]
- Spike crate: one binary, `notify = "8.2"` + `libc = "0.2"`, release profile, built outside the repo with
  `CARGO_TARGET_DIR` inside the spike directory. Resolved `notify 8.2.0` (crates.io `max_stable_version` = 8.2.0,
  `max_version` = 9.0.0-rc.5, re-verified 2026-09-11). [measured]
- Spike `Cargo.lock` SHA-256 `623a85de7aafe4391af39d85588db497e5be87c3cfb34e9337f9da6d04071bdf`; 27 packages locked
  (`notify`, `notify-types 2.1.0`, `fsevent-sys 4.1.0`, `bitflags`, `log`, `walkdir`, `same-file`, `libc`). [measured]
- Watched root: a `git clone --local --no-hardlinks` of this repo, 157 MB, 1303 tracked files, 44 209 working-tree
  files after `npm ci --ignore-scripts` (577 lockfile packages). [measured]
- The watcher counts every `notify::Event`, buckets per whole second, sums path-string bytes, keeps a distinct-path
  set, classifies paths under `node_modules/`, `target/`, `.git/`, counts `Event::need_rescan()`, and reads its own
  CPU with `getrusage(RUSAGE_SELF)`. The workload runs as a child process, so its CPU is **not** in the watcher's
  figure. [measured]
- `npm ci --ignore-scripts` was used throughout, so esbuild's postinstall never ran; the real `npm install` would emit
  **more** events than the 160 k reported here, not fewer. [measured choice, stated so the number reads as a floor]
- Not checked: Rosetta or Intel hardware; a network or case-sensitive volume; more than one watched root per stream;
  `notify-debouncer-full`; the 9.0.0 release candidate; behaviour under memory pressure; any Brigadier code path.

## 1. Event volume per workload

| Workload | Events | Peak/s | Mean/s | Distinct paths | Path bytes | Filtered share | Watcher CPU | Rescans |
|---|---|---|---|---|---|---|---|---|
| (a) idle 60 s, no `node_modules` | 0 | 0 | 0 | 0 | 0 | — | 0.012 s | 0 |
| (a2) idle 30 s, 44 209 files present | 0 | 0 | 0 | 0 | 0 | — | 0.010 s | 0 |
| (b) `npm ci --ignore-scripts`, n=6 | 160 076 median | **85 470** median | 18 084–18 214 | 42 163 | 33.0 MB median | **100.0 % `node_modules`** | 0.259 s median | 0,0,1,2,0,0 |
| (b') same, filter only (no distinct set), n=3 | 159 625 median | 84 828 median | — | — | — | 100.0 % | **0.217 s median** | 0,3,0 |
| (c) `cargo build -p brigadier-proc`, n=3 | 3 553–3 608 | 1 399–1 553 | 546–591 | 930–931 | 0.75 MB | **99.8 % `target/`** | 0.020 s | 0 |
| (d) 20 × (`git commit --allow-empty` + `git status`) | 877 | 488 | 162 | 70 | 0.14 MB | **100 % `.git/`** | 0.011 s | 0 |
| (e) 100 atomic saves (write temp + `rename`) | 600 | 372 | 129 | **101** | 0.09 MB | 0 % | 0.016 s | 0 |

- The `npm ci` storm is not smooth: per-second buckets for one run were `[1076, 74369, 67791, 18791]`. A watcher sees
  ~74 k events in a single second. [measured] Remedy: any consumer must coalesce before it allocates per event.
- (b) peaked at **91 871 events/s** across the six runs; the lowest peak was 63 646/s. [measured]
- (b) delivered **33 MB of path strings in under 4 s** for 42 163 distinct files. [measured] Remedy: classify on the
  borrowed `&Path` and drop; never build an owned `String` per event (the distinct-path set is what costs the extra
  0.04 CPU-s and 12 MB of RSS between rows (b) and (b')).
- Post-hoc filtering costs **~1.4 µs per event** (0.217 s / 159 625). [measured] The filter is cheap; the volume is not.
- (e) produced **6 events per atomic save** — 100 `Create` + 500 `Modify`, no `Remove` — and **101 distinct paths**,
  because each temp name is distinct. [measured] Remedy: a per-path cache keyed on the event path will accrue one dead
  key per save; key the cache on the final path and treat `Modify(Name(_))` as the trigger.
- (d) is entirely `.git/` self-traffic: 144 `index.lock` events, 40 `.git/index`, 20 `HEAD`, 214 under `refs/`/`logs/`,
  ~44 events per commit+status pair. [measured]

## 2. Does watching slow the producer?

Child wall time, same clone shape, alternating runs:

| Workload | Watched (ms, sorted) | Unwatched (ms, sorted) |
|---|---|---|
| `npm ci --ignore-scripts`, n=6 | 3570, 3598, 3686, 3732, 3892, **6160** | 3404, 3432, 3516, 3612, 3742, **6457** |
| `cargo build -p brigadier-proc`, n=3 | 3004, 3284, 3444 | 3130, 3348, 3369 |

- Medians: npm 3709 watched vs 3564 unwatched (+4 %); cargo 3284 watched vs 3348 unwatched (−2 %). Each distribution
  carries one >6 s outlier, watched and unwatched alike. **No slowdown is demonstrated beyond run-to-run noise**, and
  the sample is too small to bound a 4 % effect. [measured, weak]
- `Watcher::watch(root, Recursive)` returned in **1.7 ms** on the 44 209-file tree: the FSEvents backend performs no
  initial crawl. [measured]
- Watcher RSS: 7.1 MB idle, 7.8 MB peak during the storm with filtering only, 19.9 MB when the distinct-path set was
  retained. [measured]
- **Delivery latency**, write to `Event` in the consumer's channel, n=30 single writes 150 ms apart into the watched
  tree: min 9.6 ms, **p50 11.9 ms**, p90 12.0 ms, max 12.5 ms. [measured] The tight clustering near 12 ms is the
  kernel's own FSEvents tick; `notify` 8.2.0 already asks for `latency: 0.0` with `NoDefer`, so ~12 ms is the floor,
  not a configurable window.

## 3. Git self-writes are reported

- `.git/index.lock` (144 events in (d), 9 in (d2)), `.git/index`, `.git/HEAD`, `.git/refs/**`, `.git/logs/**` all
  arrive. [measured — confirms external-facts §1.8, which had this as asserted]
- `ORIG_HEAD` (1 event) and `packed-refs` (2 events) arrive, produced by `git reset --hard HEAD~3` and
  `git pack-refs --all`. [measured — the two paths §1.8 could not test]
- Remedy: a watcher must suppress its own Git-induced traffic in Rust. `notify` 8.2.0 sets neither
  `kFSEventStreamCreateFlagIgnoreSelf` nor `MarkSelf` [documented, external-facts §1.8], and in any case the writer is
  the `git` child process, not the app, so `IgnoreSelf` would not have covered it.

## 4. Root rename, delete and replacement — correction to external-facts §1.5

§1.5 concluded "a renamed or deleted watched root produces no root-changed signal". That is right about the *flag* and
wrong about the *signal*. Measured, with a control write first to prove the stream was live:

- **Rename the watched root**: three events on the root path itself — `Create(Folder)`, `Modify(Name(Any))`,
  `Modify(Metadata(Extended))`, all with `flag = None`. A write inside the renamed directory one second later produced
  **nothing**. [measured]
- **Delete the watched root**: `Create(Folder)`, `Remove(Folder)`, `Modify(Metadata(Extended))` on the root path.
  [measured]
- **Replace the watched root** (rename away, `mkdir` a fresh directory at the same path): the rename triple arrives,
  then writes into the **new** directory at the old path are delivered normally, and writes into the moved-away old
  directory are not. [measured]
- Reading: FSEvents with `FileEvents` reports the root's own directory entry as a file-level event, so 8.2.0 does have
  a usable signal without `WatchRoot` — but it is `Modify(Name(Any))`/`Remove(Folder)` on the root path, never
  `Flag::RootChanged`, and the watch silently follows the **path**, not the inode. Remedy: on any event whose path
  equals a watched root, re-`stat` the root and compare device+inode before trusting the watch.
- Not checked: rename of an ancestor of the watched root; the 9.0.0-rc `WatchRoot` behaviour.

## 5. Rescans

- `need_rescan()` fired in **3 of 9** watched `npm ci` runs, 1–3 times per run; never during idle, cargo, git or
  atomic-save workloads. [measured]
- So a dependency install alone is enough to make FSEvents drop buffered events on this machine. [measured] Combined
  with external-facts §1.4 (a rescan is stream-wide, not path-scoped) [documented], the remedy is: one rescan
  invalidates every root on that stream, and the recovery path must be a bounded Git re-query, not a tree crawl.

## 6. Git fsmonitor

- `git fsmonitor--daemon status` runs and reports correctly (exit 1 "not watching", exit 0 "is watching"), so the
  built-in daemon is compiled into Apple Git-155. `git help config` documents `core.fsmonitor` as "enable the built-in
  file system monitor daemon for this working directory". [measured]
- Enabled in the throwaway clone only; the real repository and its worktrees were never configured, and the daemon was
  stopped and `core.fsmonitor` unset at the end (`git config --list --local | grep fsmonitor` → empty). [measured]

`git status` wall time, n=10 each, after a warm run, on the clone (1303 tracked, 44 209 working-tree files):

| Variant | fsmonitor off | fsmonitor on |
|---|---|---|
| `git status --porcelain --no-optional-locks` | p50 **6.4 ms** (min 6.1, max 6.6) | p50 **6.2 ms** (min 5.8, max 7.3) |
| `git status --porcelain` | p50 **10.1 ms** (min 9.8, max 10.7) | p50 **12.0 ms** (min 10.7, max 12.6) |

- **fsmonitor buys nothing on a repository this size** — 0.2 ms inside the noise band on the lock-free form, and 1.9 ms
  *worse* on the form that writes the index. [measured] Its documented win is on trees with 100 k+ *tracked* files;
  this repo has 1303.
- The daemon is a real process: 5.0 MB RSS at rest, 11.3 MB after one `npm ci`, `--ipc-threads=8`, **one per
  worktree**, and it burned **0.14 CPU-s** watching that one `npm ci`. [measured] That is the same order as the spike
  watcher's 0.217 s, i.e. adopting fsmonitor would not avoid the FSEvents cost, only move it into another process.
- `git status --porcelain --no-optional-locks` on the **real** main checkout (266 781 working-tree files, 1303 tracked)
  is p50 **6.2 ms** — the gitignored `node_modules/` and `target/` trees are never descended into. [measured]

## 7. What a bounded poll costs

CPU seconds charged to the child, n=20 each, real main checkout:

| Command | CPU/call | Wall/call |
|---|---|---|
| `git status --porcelain --no-optional-locks` | **5.75 ms** | 7.52 ms |
| `git status --porcelain=v2 --branch --no-optional-locks` | 5.48 ms | 7.07 ms |
| `git rev-parse HEAD` | **5.77 ms** | 7.52 ms |

- `git rev-parse HEAD` costs the same as a full `status`, so on a repository this size **the poll's cost is process
  spawn, not the status walk**. [measured] Remedy: batching several queries into one `git` invocation is worth more
  than making any single query cheaper, and shrinking the poll's *work* is worthless.
- A 5 s poll per worktree is 5.75 ms / 5000 ms = **0.115 % of one core**, or **4.1 CPU-s per hour per worktree**.
  Five visible worktrees: 0.58 % of one core. [measured, arithmetic]
- The `notify` watcher at idle cost 0.010 CPU-s per 30 s = **1.2 CPU-s per hour**, independent of worktree count.
  [measured] It is ~3.4× cheaper than one 5 s poll at idle and ~17× cheaper than five.
- One `npm ci` costs the watcher 0.217 CPU-s, the equivalent of **38 poll invocations** — about 3 minutes of 5 s
  polling on one worktree. [measured, arithmetic]

## 8. Recommendation — facts for the lead's decision

1. **Idle cost favours the watcher, by about 3× per worktree and more as worktrees multiply.** 1.2 CPU-s/hour for one
   watcher against 4.1 CPU-s/hour for each 5 s `git status` poll. [measured]
2. **Storm cost is small in CPU and large in events.** 160 k events and 33 MB of path strings in under 4 s, peaking at
   85 k/s, for 0.217 CPU-s. The risk is not CPU; it is any per-event allocation, any per-event lock, any per-event IPC
   hop to the webview. [measured]
3. **Post-hoc filtering works and is what P3 would get.** 100 % of `npm ci` events and 99.8 % of `cargo build` events
   fall under `node_modules/` or `target/`; the filter costs 1.4 µs/event. But the OS still delivered all 160 k of them
   — `notify` 8.2.0 never calls `FSEventStreamSetExclusionPaths` [documented, external-facts §1.3], so the exclusion is
   a consumer-side discard, not an avoided traversal. [measured]
4. **FSEvents drops events under exactly the workload Brigadier will meet.** A rescan fired in 3 of 9 `npm ci` runs,
   and a rescan is stream-wide. A watcher therefore cannot be the only freshness mechanism; it needs a Git re-query
   fallback, which is the poll it was meant to replace. [measured + documented]
5. **fsmonitor does not cover the Git-status freshness case here.** It is available in Apple Git-155, it costs one
   8-thread daemon and 0.14 CPU-s per install storm per worktree, and it changes `git status` p50 by 0.2 ms on this
   repository — inside noise. It answers "is the index stale", never "did the branch, HEAD or a ref change", which is
   what the workbench displays. [measured] Adopting it would add a per-worktree daemon for no measured gain.
6. **The poll's cost is `fork`/`exec`, and that reframes the trade.** 5.75 ms CPU whether the command is `status` or
   `rev-parse`. A poll that arms only while the workbench is visible and the worktree is dirty or a session is live —
   the lead's current standing decision — and that batches its queries into one `git` invocation, lands near
   4 CPU-s/hour/worktree in the worst case and zero the rest of the time. [measured, arithmetic]
7. **Root identity is a live hazard either way.** A renamed root yields three events on the root path and then silence;
   a replaced root yields events for a different directory at the same path, with no flag to distinguish it. Any
   watcher must re-`stat` device+inode on a root-path event. [measured — external-facts §1.5's "no signal" is too
   strong; the signal exists, the flag does not.]
8. **Net:** the measured case for `notify` is an idle-CPU case (~3 CPU-s/hour/worktree saved) plus lower latency on
   external edits, bought with a new dependency, a storm-coalescing layer, a `.git` self-write suppressor, a
   stream-wide rescan fallback that re-runs the Git query anyway, and a root-inode check. The measured case against
   fsmonitor is unconditional on this repository: no gain, one daemon per worktree. **Nothing here forces the
   dependency.** The 5 s gated poll costs 0.115 % of a core per active worktree, which is the number the lead should
   weigh against that list. [measured]

The latency gap is real and measured: **11.9 ms p50** for a watcher against up to 5000 ms for a 5 s poll (p50 2500 ms).
Not checked, and it is the one thing that could overturn item 8: whether that gap is visible to the owner in the
workbench. No end-to-end user-visible latency was measured in this spike — only channel delivery inside one process.
