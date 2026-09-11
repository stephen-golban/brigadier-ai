# Codex thread rebuild — render gate, 2026-09-11

What this answers: does `ui/codex-thread` (HEAD `c34e229`) still meet the `CLAUDE.md` §4 render gate —
exec → first contentful paint **≤ 295 ms p50**, and 60 Hz with **0** dropped vsyncs — and what did the
rebuild do to the pre-existing 60 Hz failure?

Both arms were **built and measured back to back on this machine today**, uncontended by any build.
Baseline is the merge-base `f94c9ef`, not a recorded figure. Every number below carries the command
that produced it and its n. §8 is what I did not check.

Superseded: the contended figures in `docs/performance/codex-css-paint-spike-2026-09-11.md` §3–§4
(237.93 ms p50, 4 dropped vsyncs). Those were upper bounds taken under a foreign release build; this
document replaces them with uncontended measurements of both arms.

---

## 1. Verdict

| gate | baseline `f94c9ef` | branch `c34e229` | verdict |
| --- | ---: | ---: | --- |
| exec → FCP **p50 ≤ 295 ms** | **239.73 ms** (n=80) | **250.16 ms** (n=80) | **PASS** both, ~45 ms headroom |
| 60 Hz, **0 dropped vsyncs** | **5** median (n=8, range 4–6) | **4** median (n=5, range 4–5) | **FAIL** both |

- **The paint budget is met.** 250.16 ms p50 on the branch, 44.8 ms inside the 295 ms gate. All 20
  startup series — 10 per arm — returned the harness's own `"pass": true` and exit 0.
- **The 60 Hz gate still fails, and the miss is pre-existing.** The merge-base drops a median of 5
  vsyncs per 63-second burn with none of the rebuild present. The branch drops a median of 4.
- **The rebuild did not fix the 60 Hz failure.** It moved the median from 5 to 4 — one drop, one-sided
  permutation p = 0.075 at n=8 vs n=5, i.e. not separable. Read it as *unchanged*, not improved. §5
  gives a reason to discount even the apparent improvement.
- ~~**A delivery regression turned up that is not a frame number.** The branch's front end ingests
  **11.18%** fewer terse rows than the producer emitted (12,210 rows short, reproducibly), against
  **0.07%** on the baseline. Neither arm is a valid *acceptance* result — both fail the harness's
  delivery audit — but the branch fails it far harder, and it is new. §5.~~
  **Withdrawn 2026-09-11, see §5's correction.** There is no delivery regression: 12,143 of the
  12,210 are `usage-windows` envelopes that carry no feed row and the harness counted as rows, and
  the other 67 are the batcher's own reported `rowsDropped` (the baseline's 81, unchanged in kind).
  Both arms still fail the acceptance audit on `rowsDropped != 0`, which is pre-existing.

---

## 2. Machine and contention

Apple M4 Pro, 14 cores, 24 GB, macOS 26.6.2 (25G83), built-in display, console **unlocked** for every
run (`ioreg -n Root -d1 -a` → `IOConsoleLocked=False`, re-checked by both harnesses per launch and
recorded as `console_locked_after: false` in every capture).

This machine is **shared** and was not quiet by default. Three distinct interferences appeared and are
handled explicitly rather than averaged away:

1. **Foreign release builds** from `/private/tmp/brigadier-performance-fix-20260911`, driven by a
   Codex session — `npm run tauri build`, `cargo build --release`, `cargo test --workspace`, arriving
   roughly every 6–8 minutes. A 5-second sampler (`runners/watch.sh` → `contention.log`) logged the
   process list and 1-minute load for the whole session, so every run is attributable.
2. **`SkyComputerUseServer`** (`~/.codex/computer-use`, another agent driving the GUI) plus Playwright
   Chromium. This occludes the measured window; WKWebView then stops issuing rAF callbacks and
   `src/fps.ts` latches `interrupted = true`. **10 of 31 burn attempts were lost this way** and are
   excluded — the harness flags them itself, they are not a judgement call.
3. **Spotlight (`mds_stores`) at 145–157% CPU**, load average 25, from 14:06 to ~14:17 — triggered by
   the 7.7 GB of build output this exercise created under `/private/tmp`. Runs were gated behind it.

Accepted runs are listed with their window, foreign-process sample count and mean 1-minute load in §3
and §4. A run counted as clean only when **zero** foreign-build samples fell inside its window and the
harness did not flag it interrupted. `src/fps.ts` and `src/components/Burn.tsx` are **byte-identical**
between the two arms (`git diff f94c9ef..HEAD -- src/fps.ts src/components/Burn.tsx` is empty), so both
arms are measured by the same instrument.

---

## 3. Method, exactly

Both arms are **release** builds with `--features burn`, bundled as `.app`, frozen before the next
build so no build can replace an earlier arm's executable.

```sh
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR=/private/tmp/brig-burn-20260911/target-{base,branch}
VITE_BURN=1 npm run tauri build -- --features burn \
  --config /private/tmp/brig-burn-20260911/tauri.json --bundles app
```

- baseline: `build_label=baseline exit=0 seconds=83`, then `cp -Rc` freeze, `freeze_exit=0`
- branch:   `build_label=branch exit=0 seconds=86`, then `cp -Rc` freeze, `freeze_exit=0`

(`docs/performance/2026-09-11-thread-burn/build-{baseline,branch}.exit`, exit codes read off the
command, not through a pipe.)

The baseline tree is `git archive f94c9ef | tar -x` into `/private/tmp/brig-burn-20260911/baseline`
with `node_modules` APFS-cloned from the worktree — **not** a `git worktree add`, so nothing was
written to `/Users/stephen/Development/brigadier-ai` or to this branch's working tree.
`git diff --stat f94c9ef..HEAD -- package.json package-lock.json Cargo.toml Cargo.lock` is empty, so
the two arms share an identical dependency graph and the same `node_modules`. The `/private/tmp` tree
and both target dirs were deleted afterwards.

Isolated identifier `ai.brigadier.perf.cssspike` and a disposable data directory reset before every
burn; the real `ai.brigadier.app` data was never touched (`measure-native-burn.py` refuses that
directory outright).

What actually got measured differs as expected — the branch's render-blocking entry stylesheet is
**225,821 B** against the baseline's **149,436 B** (+76,385), and its lazy `App` chunk is 1,350,638 B
against 1,276,479 B:

```
base   149436 dist/assets/index-Cpq2rTMI.css      branch 225821 dist/assets/index-DVUUOm_O.css
base  1276479 dist/assets/App-n2uFpA2H.js         branch 1350638 dist/assets/App-BO0kswyy.js
```

### Startup (exec → FCP)

```sh
python3 scripts/measure-native-startup.py \
  /private/tmp/brig-burn-20260911/frozen-<arm>.app/Contents/MacOS/brigadier \
  --activate-helper /private/tmp/brig-burn-20260911/activate-native-benchmark \
  --paint-log "$HOME/Library/Application Support/ai.brigadier.perf.cssspike/paint.ndjson" \
  --output /private/tmp/brig-burn-20260911/out/startup-<arm>-s<N>.json --runs 10
```

Ten series of 10 launches per arm, **interleaved** (baseline s1, branch s1, baseline s2, …) so drift
between the arms is minimised — the whole matched set ran in 9 minutes, 13:22:38–13:31:53. Every one
of the 20 series exited **0** with `"pass": true`. `pre_spawn_to_fcp_ms` is the repo's documented
conservative approximation of exec → FCP; FCP is the boot shell in `index.html`, not workspace
readiness.

### Burn (60 Hz)

```sh
python3 scripts/measure-native-burn.py \
  /private/tmp/brig-burn-20260911/frozen-<arm>.app/Contents/MacOS/brigadier \
  --activate-helper /private/tmp/brig-burn-20260911/activate-native-benchmark \
  --data-dir "$HOME/Library/Application Support/ai.brigadier.perf.cssspike" \
  --output /private/tmp/brig-burn-20260911/out/burn-<arm>-<label>.json
```

Documented workload, unchanged and verified in every capture: 10 sessions × 200 rows/s × 60 s, fixture
`s1-handshake-and-turn`, `?burn=auto`, `profiling: false`, `diagnostics: null`. Runs alternated
between arms; the second half also alternated which arm went first, to rule out an ordering effect
(§5). Wrappers: `runners/{build,startup,burn,gburn,rburn,final,resetdata,watch}.sh`.

---

## 4. Startup — the numbers

All samples retained, including each series' cold first launch (1.0–1.8 s, which dominates any p95
computed with it). "warm" drops launch 0 of each series. Eight series per arm are clean; s5 and s10
are reported separately because a foreign build (s5) and a foreign `cargo test` (baseline s10) fell
inside their windows.

| arm | n | p50 | p95 | min | max | warm n | warm p50 | warm p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline `f94c9ef`, 8 quiet series | 80 | **239.73** | 288.02 | 213.64 | 801.74 | 72 | 239.73 | 287.90 |
| branch `c34e229`, 8 quiet series | 80 | **250.16** | 288.58 | 211.70 | 861.63 | 72 | 250.16 | 287.97 |

Per-series p50, in run order (s1–s4, s6–s9):

- baseline: 226.3, 276.5, 273.3, 236.7, 252.2, 281.9, 228.4, 229.5
- branch:   257.3, 281.8, 239.0, 235.5, 278.1, 278.0, 221.9, 229.6

Contended series, kept out of the pooled figures: baseline s5 239.51, s10 236.35; branch s5 259.20,
s10 233.63 (n=10 each).

**The delta is not resolvable.** Bootstrap on warm samples, 20,000 resamples:

| comparison | median delta | 95% CI |
| --- | ---: | --- |
| branch − baseline | **+10.81 ms** | [−7.92, +22.76] |
| noise floor — baseline's own 2nd half vs 1st | −5.98 ms | [−35.50, +19.23] |

Paired the other way, by matched series: the eight per-series warm-p50 differences are +33.4, +6.5,
−30.9, −0.2, +21.8, −7.6, −7.5, +0.2 — **mean +1.96 ms, median +0.03 ms, sd 19.54 ms**. Three of eight
pairs go the *other* way. The series-to-series swing on this machine (baseline alone ranges 226–282 ms)
is larger than any difference between the arms.

**Gate verdict: PASS.** Branch p50 250.16 ms, 44.8 ms inside the 295 ms budget. The honest statement on
the delta is that the rebuild's cost to FCP is somewhere between about −8 ms and +23 ms and cannot be
separated from this harness's drift at n=80 per arm. Branch warm p95 is 287.97 ms — under 295, but
only by 7 ms, and p95 is not the gate.

---

## 5. The burn — dropped vsyncs

Accepted runs: harness not `interrupted`, zero foreign-build samples inside the window,
`activation_exit: 0`, `console_locked_after: false`, `sleep_assertion_alive: true`, `profiling: false`,
`diagnostics: null`, workload exactly as expected, duration 63.2–63.6 s over 63–64 one-second windows.

| arm | run | mean load1 | **dropped** | worst frame | worst window p95 | longest drop run | max DOM |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | b1 | 3.77 | 6 | 42 ms | 21 ms | 2 | 469 |
| baseline | b3 | 4.38 | 5 | 48 ms | 28 ms | 3 | 469 |
| baseline | b5 | 4.99 | 5 | 40 ms | 23 ms | 2 | 469 |
| baseline | b6 | 3.16 | 5 | 45 ms | 22 ms | 2 | 469 |
| baseline | b7 | 2.75 | 5 | 39 ms | 25 ms | 3 | 469 |
| baseline | b8 | 5.29 | 5 | 44 ms | 25 ms | 3 | 469 |
| baseline | v1 | 5.62 | 4 | 38 ms | 29 ms | 3 | 469 |
| baseline | v2 | 5.98 | 4 | 43 ms | 22 ms | 2 | 469 |
| **baseline** | **n=8** | | **median 5**, mean 4.88, range 4–6 | | | | |
| branch | b3 | 3.47 | 4 | 44 ms | 23 ms | 2 | 474 |
| branch | b5 | 3.98 | 4 | 56 ms | 20 ms | 2 | 474 |
| branch | b6 | 3.55 | 4 | 43 ms | 22 ms | 2 | 474 |
| branch | v1 | 4.07 | 4 | 42 ms | 24 ms | 2 | 474 |
| branch | v2 | 3.09 | 5 | 42 ms | 25 ms | 3 | 473 |
| **branch** | **n=5** | | **median 4**, mean 4.20, range 4–5 | | | | |

**Gate verdict: FAIL, both arms.** The gate is zero drops. Neither arm gets there.

**Did the rebuild improve, worsen or leave unchanged the pre-existing failure? Unchanged.** The number
behind it: baseline median **5** dropped vsyncs (n=8), branch median **4** (n=5); mean difference 0.67
drops in the branch's favour, exact one-sided permutation test **p = 0.0746** over all 1,287 splits.
That does not clear any reasonable bar, and the arms' ranges overlap (baseline 4–6, branch 4–5). The
brief's recorded pre-existing figure of 4 drops sits at the bottom of the baseline's own uncontended
range — it was not a floor.

**Where the drops are, in both arms.** Every accepted run's drops are concentrated in the burn's first
three one-second windows. Window 2 — the third second — drops frames in **13 of 13** runs: 3–4 frames
in twelve of them (2 in baseline b5), with a worst frame of 38–56 ms:

```
baseline b6 [(w0, 1, 25 ms), (w2, 4, 45 ms)]      branch b6 [(w0, 1, 26 ms), (w2, 3, 43 ms)]
baseline v2 [(w2, 4, 43 ms)]                      branch v1 [(w1, 1, 25 ms), (w2, 3, 42 ms)]
```

The dominant cost is a single ~40 ms frame in the burn's start-of-stream transient, when ten sessions
spin up at 200 rows/s. It is present with none of the rebuild's code in the build. After window 4 the
branch drops **nothing at all** in all five accepted runs; the baseline drops 1–3 late frames in four
of its eight. That is the only respect in which the branch looks better, and the next paragraph is why
it should not be credited.

**The reason not to credit the branch's lower count.** Both arms fail the harness's delivery audit, but
not equally, and the branch's failure is new:

| arm | sessions with row count/drop mismatch | producer rows | frontend `rowsIn` | deficit |
| --- | ---: | ---: | ---: | ---: |
| baseline b6 | 3 of 10 | 107,912 | 107,831 | 81 (**0.075%**) |
| baseline v2 | 3 of 10 | 107,918 | 107,839 | 79 (0.073%) |
| branch b6 | **10 of 10** | 109,262 | 97,052 | 12,210 (**11.18%**) |
| branch v2 | **10 of 10** | 109,252 | 97,042 | 12,210 (11.18%) |

The branch also raises an error class the baseline never does — `Mounted transcript has not received
its final item sequence` — in **all five** accepted runs, and `Producer count differs from durable
envelopes` in one. The 12,210-row deficit reproduces to the row across runs and is spread evenly over
all ten sessions (~1,221 each), so it is systematic, not a timing artifact.

**Correction, 2026-09-11 (diagnosed after this document was written): there is no delivery
regression. The harness's row rule was stale.** `scripts/measure-native-burn.py` derived the
producer's row count by excluding a hard-coded `{turn-started, content-delta, item-updated}`, and
this branch added a fourth event that carries no feed row — `Event::UsageWindows`, for which
`brigadier_store::feed::terse_line` returns `None` (`crates/store/src/feed.rs`). Counted off this
document's own evidence, per session:

| arm | harness "rows" | `usage-windows` | real terse rows | batcher `rowsDropped` | frontend `rowsIn` |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline b6 | 107,912 | 0 | 107,912 | 81 | **107,831** |
| branch b6 | 109,262 | 12,143 | 97,119 | 67 | **97,052** |

`real terse rows − rowsDropped == rowsIn` **exactly** on both arms, and every one of the branch's
ten sessions has `rowsTotal == rows − usage-windows` to the row. The 12,210 splits as 12,143
non-rows plus the 67 the batcher itself reports dropping at its buffer cap — the same pre-existing
class as the baseline's 81. **No row was lost; nothing is missing from what a user sees.**

`Mounted transcript has not received its final item sequence` is the same staleness: `session-exited`
now mints a `Notice` chat item at its own seq (`crates/store/src/chat.rs`), so the UI's
`lastItemSeq` was 12002 against the harness's item-events-only maximum of 11999 — the transcript was
**ahead**, not behind. Both rules are now named constants pinned against the Rust source by
`crates/store/tests/feed.rs` `the_burn_harness_row_rule_matches_terse_line` and
`…_item_seq_rule_matches_chat_project`. The §5 delivery-audit paragraph below stands as what was
measured on the day; its conclusion does not.

**The paragraph that follows still stands, for a different reason.** The branch's front end does
render ~10% fewer rows in the same 60 seconds, and that is by construction, not by loss: the replay
driver emits at a fixed ~200 *events* per second, the branch spends one of every ~10 on a
`usage-windows` envelope that carries no row, and so it completes 12,144 turns against the
baseline's 13,492 (`item-started` per turn is 3.0 in both arms; total events 121,406 vs 121,404).
Less row work per second is still less row work, so the branch's one-drop advantage is still not
evidence of better frame pacing.

A front end that ingests 11% fewer rows has 11% less work to do. **The branch's one-drop advantage is
therefore not evidence of better frame pacing**, and this document does not claim it as such. The
delivery deficit is a finding in its own right: it is a regression against the merge-base, it is
reproducible, and it means neither burn is a valid *acceptance* result — the frame counters are
comparable only in the weak sense that both runs failed the same audit, and the branch failed it worse.
I did not diagnose its cause; that is outside this measurement's scope.

**Excluded runs, with the reason, so the exclusions can be audited** (all 31 attempts are in
`2026-09-11-thread-burn/burn/all-runs-summary.json` with their `interrupted` flag, visibility states
and per-window drop lists):

- *Window occluded mid-run, harness flagged `interrupted`* (10): baseline r3, v3; branch b2, b4, b7,
  b8, r2, r3, v1-t1, v4. These report 316–3,800 drops with worst frames of 5.2–63.4 s — the signature
  of rAF stopping, not of a stutter. `initialVisibility`/`finalVisibility` show `hidden: true` on the
  affected runs. Cause is §2's GUI-automation agent.
- *Foreign build inside the window* (6): baseline b2 (6 drops), b4 (10), r1 (17), v4 (4); branch b1
  (5), v3 (5).
- *Foreign load arriving in the tail* (1): branch r1, 39 drops. Its drops are confined to windows
  50–62 while windows 3–49 are clean, and a foreign build was sampled six seconds after the run ended.
  Reported here rather than silently dropped.

An initial 8 clean runs split 0-of-8 interrupted on the baseline against 4-of-8 on the branch, which
looked like a branch-specific defect. Reversing the order (branch first) produced an interrupted
*baseline* run, and the correlation with `SkyComputerUseServer` activity held for both arms. It is
environmental.

---

## 6. What this supersedes

`docs/performance/codex-css-paint-spike-2026-09-11.md` §1 says its absolute numbers are contended
upper bounds and that no quiet re-run exists. It now does, against a different and better baseline —
the merge-base rather than a CSS-stripped build of the same tree:

| figure | spike (contended) | here (uncontended) |
| --- | ---: | ---: |
| baseline p50 | 237.93 ms | 239.73 ms |
| baseline dropped vsyncs | 4 (n=1) | median 5, range 4–6 (n=8) |
| branch/full-CSS p50 | 241.74 ms | 250.16 ms |
| branch/full-CSS dropped vsyncs | 5 (n=1) | median 4, range 4–5 (n=5) |

The spike's absolutes held up: contention had moved them by ~2 ms, not by tens. Its central conclusion
— the CSS fits the FCP budget — survives, and the 60 Hz miss it called pre-existing is confirmed
pre-existing at n=8 rather than n=1.

---

## 7. Evidence

`docs/performance/2026-09-11-thread-burn/`:

- `startup/` — all 20 startup series JSON, every launch retained, both arms.
- `startup-analysis.txt` — pooled stats, bootstraps and per-series detail reproduced in §4.
- `burn/all-runs-summary.json` — all 31 burn attempts: summary, visibility, delivery-audit errors,
  per-window drop lists.
- `burn/burn-{baseline,branch}-b6.json` — two full captures with raw frame intervals, one per arm.
- `contention.log` — 5-second samples of load and foreign build processes across the whole session.
- `final.log`, `build-{baseline,branch}.exit` — run windows and build exit codes.
- `runners/` — every wrapper script and the isolated `tauri.json`.

The frozen `.app` bundles, the archived baseline tree and both cargo target dirs (7.7 GB under
`/private/tmp/brig-burn-20260911`) were deleted after the evidence above was copied out. Rebuilding
them is §3's recipe, ~85 s per arm.

---

## 8. What I did not check

- **The other five gates.** Not re-run here; the brief records them green on this branch. This document
  measures only the render gate.
- ~~**The cause of the 11.18% row-ingest deficit** (§5). Measured and reproduced, not diagnosed.~~
  **Closed** by §5's correction: the harness's row rule was stale, not the delivery path.
- ~~**Whether the 12,210 missing rows change what a user sees.**~~ **Closed**: no row was missing.
  `real terse rows − rowsDropped == rowsIn` exactly on both arms, and `rowsTotal` matches the real
  row count in all ten branch sessions. What is still unchecked is whether the **67** rows the
  batcher itself reports dropping at its buffer cap — a pre-existing behaviour, 81 on the baseline —
  are visible to a user; the store reports them honestly as `rowsDropped` and the audit already
  fails on them.
- **n=5 on the branch burn arm.** Ten further branch attempts were lost to window occlusion. A
  one-drop difference is not resolvable at n=8 vs n=5 and I do not claim it is.
- **A truly idle machine.** Accepted runs had mean 1-minute load 2.75–5.98 from the desktop session
  (WindowServer, browsers, other agents). No foreign *build* was inside any accepted window, but this
  was never a single-user quiet box.
- **Debug builds.** Release only, both arms.
- **The paint budget under a real thread DOM.** FCP is the boot shell; the rebuilt thread is not on
  screen at first paint. The CSS spike's §5 matching-DOM arms were not repeated against the real
  ported components.
- **Custom-property inheritance** (`[data-codex-ui]`), still unmeasured — carried over from the CSS
  spike's §7.
- **Repeat builds.** One build per arm; build-to-build variance in the bundled output was not sampled.
