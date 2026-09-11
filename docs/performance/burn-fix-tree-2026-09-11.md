# The burn on the fix tree — 2026-09-11

Arm measured: the **working tree** of `/Users/stephen/Development/brigadier-ai.worktrees/fix-2026-09-11`,
branch `fix/locks-trap-rowscope-2026-09-11` over HEAD `462c6bf`, uncommitted. `src/components/ThreadView.tsx`
is on the render path and changed, so `docs/performance/burn-frame-2026-09-11.md`'s numbers — taken on
`462c6bf` and older binaries — do not transfer. Comparison arm: `frozen-accept.app`, the previous worker's
frozen release build of clean HEAD `462c6bf`, run on the same machine in the same session, interleaved with
the fix runs so machine drift cannot be mistaken for an arm difference.

Every number below is **[measured]** off a capture file in `2026-09-11-burn-frame/fix-tree/`. Exit codes are
read off the command, not through a pipe. Nothing is carried over from a previous round.

---

## 1. Gate verdict

**FAIL on the 60 Hz half. PASS on the paint half.**

- **Dropped vsyncs, fix tree: median 4 over n = 5 valid runs** — 3, 3, 4, 6, 6. The gate requires **0**. **FAIL.**
- **exec → first contentful paint, fix tree: p50 = 243.4 ms** over 10 valid launches, harness `pass: true`.
  The gate allows ≤ 295 ms. **PASS**, with 52 ms of headroom.
- Comparison, HEAD `462c6bf`: median 3.5 drops over n = 2 valid runs — 3, 4. **HEAD fails the same half.**

The fix tree is **not measurably better than HEAD** on dropped vsyncs, and the point estimate is worse
(median 4 vs 3.5), but n = 5 against n = 2 with per-run values of 3–6 and 3–4 means the distributions
overlap almost entirely. **This session does not separate the two arms.** Read this as "the fix tree did not
fix the burn, and n is too small to say more", not as "the fix tree regressed the burn".

Every drop sits in the two cold clusters — one frame of 25–31 ms at rel ≈ 0.97–1.11 s, and a pair of
27–52 ms frames at rel ≈ 1.99–2.13 s, in windows 1 and 2. That is exactly the shape
`burn-frame-2026-09-11.md` §2 attributes to the first workbench-shell mount and the first transcript mount.
Beyond rel 3.5 s, three of the seven valid runs carry one isolated 25–26 ms frame and four carry nothing.
**The steady-state feed drops nothing in this tree.**

---

## 2. Build

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cd /Users/stephen/Development/brigadier-ai.worktrees/fix-2026-09-11
VITE_BURN=1 npm run tauri build -- --features burn \
  --config /private/tmp/brig-frame-20260911/tauri.json --bundles app
```

Byte-for-byte the previous worker's `build.sh` recipe with `SRC` repointed at this worktree: isolated
identifier `ai.brigadier.perf.cssspike`, window URL `index.html?burn=auto` — **no `?preroll`**, so the
acceptance arm's pre-roll instrument is inert. Every capture records `prerollMs: 0`; verified in all twelve.

**Build exit code 0, 80 seconds**, read off `fix-tree/build-fix.exit`. Frozen with `cp -Rc` to
`/private/tmp/brig-frame-20260911/frozen-fix.app`. The five pre-existing arms in that directory were not
overwritten.

---

## 3. Per-run table — fix tree (`frozen-fix.app`)

| run | valid | dropped vsyncs | longest frame ms (window) | windows | dropping frames (rel ms / dt ms) | `pgrep` b/a | load1 b/a | locks b/a |
| --- | --- | ---: | --- | ---: | --- | ---: | --- | --- |
| `f1` | **no** — `hidden` from w27 | 2158 | 35932 (w27) | 28 | 968 / 32; 2023 / 36; 2060 / 37; **63218 / 35932** | 1/1 | 4.13/2.10 | **1638 → 0** |
| `f2` | yes | 6 | 52 (w1) | 63 | 1085 / 50; 1111 / 26; 2032 / 52; 2061 / 29 | 0/0 | 2.22/2.55 | 0 → 0 |
| `f3` | yes | 6 | 43 (w1) | 63 | 980 / 26; 2014 / 43; 2046 / 32; 2075 / 29; 7897 / 26 | 0/0 | 2.66/3.43 | 0 → 0 |
| `f4` | **no** — `hidden` from w0 | 3779 | 63006 (w0) | 1 | 63006 / 63006 | 0/0 | 3.43/3.89 | 0 → 0 |
| `f5` | **no** — `hidden` from w0 | 3780 | 63013 (w0) | 1 | 63013 / 63013 | 0/0 | 2.97/3.27 | 0 → 0 |
| `f6` | yes | 3 | 34 (w1) | 63 | 2007 / 34; 2040 / 33; 62548 / 25 | 0/0 | 3.27/2.54 | 0 → 0 |
| `f7` | yes | 4 | 36 (w1) | 63 | 982 / 25; 2009 / 36; 2036 / 27; 2132 / 25 | 0/0 | 3.94/2.58 | 0 → 0 |
| `f8` | yes | 3 | 33 (w1) | 63 | 971 / 25; 1994 / 33; 2025 / 31 | 0/0 | 2.58/2.15 | 0 → 0 |

**n = 5 valid. Drops 3, 3, 4, 6, 6 — median 4. Longest frame 33, 34, 36, 43, 52 ms — median 36 ms.**

## 4. Per-run table — HEAD `462c6bf` (`frozen-accept.app`)

| run | valid | dropped vsyncs | longest frame ms (window) | windows | dropping frames (rel ms / dt ms) | `pgrep` b/a | load1 b/a | locks b/a |
| --- | --- | ---: | --- | ---: | --- | ---: | --- | --- |
| `a1` | yes | 3 | 40 (w1) | 63 | 986 / 26; 2017 / 40; 2053 / 36 | 0/0 | 2.55/2.66 | 0 → 0 |
| `a2` | **no** — `hidden` from w0 | 3803 | 63407 (w0) | 1 | 63407 / 63407 | 0/0 | 3.89/2.97 | 0 → 0 |
| `a3` | yes | 4 | 39 (w1) | 63 | 983 / 26; 2013 / 39; 2049 / 36; 7899 / 25 | 0/0 | 2.54/3.94 | 0 → 0 |

**n = 2 valid. Drops 3, 4 — median 3.5. Longest frame 39, 40 ms.**

Every listed run, both arms: `activation_exit: 0`; console unlocked before launch and `console_locked_after:
false`; workload exactly `{sessions: 10, rowsPerSec: 200, durationS: 60, fixture: "s1-handshake-and-turn"}`;
`prerollMs: 0`; `profiling: false`; `diagnostics: null`; delivery audit `pass: true` with no errors. The
harness's own `pass` is `false` for every run, since it requires zero drops.

Run order, interleaved: `f1`, paint series, `f2`, `a1`, `f3`, `f4`, `a2`, `f5`, `f6`, `a3`, `f7`, `f8`.
`f7` and `f8` were added mid-session to lift the fix arm back to n = 5 after three runs were lost.

---

## 5. Four runs were thrown away, and why

`f1`, `f4`, `a2` and `f5` are **invalid**. `src/fps.ts:45,88` sets `interrupted` when `document.hidden` is
true at any sample, and `fps.ts:312` stamps that flag onto every window retroactively. In all four the app's
window was occluded by another application and rAF stopped:

- `f1` ran normally for 27 s, then went `hidden` at 18:04:15 for **35.9 s** — a single interval scoring
  2 155 "dropped" vsyncs. That is an occlusion artefact, not a stall: the run's Rust log has **no activity at
  all** between 15:03:50Z and 15:04:49Z, so the app was not blocked, the window was covered.
- `f4`, `a2` and `f5` are worse: `hidden` from **window 0**, one window, a single 63 s interval. The app
  never reached the foreground. Three consecutive runs, 18:11 → 18:14. `lsappinfo front` at 18:11 named a
  browser (`Dia`) as frontmost.
- `f6` at 18:14 came back clean, and `a3`, `f7`, `f8` after it. The condition cleared on its own.

`activate-native-benchmark` returned 0 on every one of the four — it raises the app, but something re-raised
over it. **The harness was not defeated and no run was retried to improve a number.** The four are reported
as lost. This is the session's largest cost: it is why the accept arm is n = 2 instead of the n = 3 launched,
and why two extra fix runs had to be queued.

---

## 6. Lock-file delta — `~/.brigadier/workspace-locks-v1`

Counted with `ls ~/.brigadier/workspace-locks-v1 | wc -l`:

- **Before the first launch, 18:03:23: 1 638 files.**
- **After the first run `f1`, ~18:05: 0 files.**
- Every run from `f2` onward: 0 before, 0 after.
- **After the last run, 18:20: 0 files.**

**Net delta: −1 638.** The directory emptied across the first app launch of this build and stayed at zero
across 10 further burn launches and 10 startup launches. Nothing was deleted by hand.

Two cautions against over-reading it. First, the app ran against the isolated data dir
`~/Library/Application Support/ai.brigadier.perf.cssspike`, yet the count that moved is the shared
`~/.brigadier/workspace-locks-v1`. Second, the previous worker recorded this same counter moving
436 → 447 → 263 → 19 while it launched nothing at all (`burn-frame-2026-09-11.md` §6). A single before/after
pair across one launch **cannot prove the registry sweep is what emptied it** — only that it went 1 638 → 0
across that launch and then held at zero.

---

## 7. Paint — exec → first contentful paint

`scripts/measure-native-startup.py`, 10 launches of `frozen-fix.app`, `BRIGADIER_TRACE=1`, paint read from
the app's own `paint.ndjson`:

**p50 = 243.4 ms. `pass: true`. 10 of 10 samples valid.**

Samples, ms: 270.6, 223.4, 250.9, 253.0, 223.3, 218.3, 223.6, 243.2, 245.3, 243.6.

`startup_label=s1 exit=0`; load1 2.10 before, 2.22 after; no build process running. The harness's own caveats
stand: warm-cache launches, pre-spawn includes launch-call overhead, and FCP is not presentation. This is
well inside the 287–295 ms p50 band recorded at `c4d9d29` (`docs/STATUS.md` §4), though those were debug
builds and this is release, so the two are not directly comparable.

---

## 8. Commands used

```sh
# before every capture
ioreg -n Root -d1 -a | grep -A1 IOConsoleLocked          # <false/> each time
pgrep -f "cargo build|tauri build|vite|cargo test|clippy|vitest|rustc"
uptime; sysctl -n vm.loadavg
ls ~/.brigadier/workspace-locks-v1 | wc -l

# build — exit 0, 80 s
2026-09-11-burn-frame/fix-tree/build-fix.sh fix

# one burn run
2026-09-11-burn-frame/fix-tree/burn-fix.sh <fix|accept> <label>
#   -> python3 scripts/measure-native-burn.py <arm>.app/Contents/MacOS/brigadier \
#        --activate-helper /private/tmp/brig-frame-20260911/activate-native-benchmark \
#        --data-dir "$HOME/Library/Application Support/ai.brigadier.perf.cssspike" \
#        --output .../burn-<label>.json

# the paint series
2026-09-11-burn-frame/fix-tree/startup-fix.sh fix s1 10
#   -> python3 scripts/measure-native-startup.py ... --paint-log "$DATA/paint.ndjson" --runs 10
```

Runner scripts, `.exit` files and every raw capture are in `docs/performance/2026-09-11-burn-frame/fix-tree/`.
`md-fix.py` there regenerates the per-run tables; `table-fix.py` dumps one JSON row per run.

---

## 9. Contention

`pgrep -f "cargo build|tauri build|vite|cargo test|clippy|vitest|rustc"` returned **0** before and after every
run except `f1`, where it returned 1 — and that match was this session's own leftover monitor shell
(`pgrep … ; sleep 290`, pid 77655, started 18:00:23), not a build. It expired before `f2`. One idle
`python3 -m http.server 8776` started 18 hours earlier was resident throughout and is not counted. 1-minute
load ran 2.10–4.13 across the session, and the arms were interleaved, so both saw the same range.

---

## 10. Not checked

- **Whether the fix tree differs from HEAD on dropped vsyncs.** n = 5 versus n = 2, ranges 3–6 and 3–4.
  No statistical test was run and none would be meaningful at that n. Separating them needs roughly ten
  valid runs per arm on a desktop that stays un-occluded.
- **What occluded the window in `f1`, `f4`, `a2`, `f5`.** `lsappinfo front` named a browser once, at 18:11.
  No screen recording, no window-server trace. The cause is unproven and the failure is unexplained beyond
  "another window was on top".
- **Whether the registry sweep is what emptied `workspace-locks-v1`.** One launch, one correlation, no
  instrumentation of the sweep and no control build without it. See §6.
- **Any React or IPC trace on this tree.** No `VITE_REACT_PROFILE=1` arm was built or run, so
  `burn-frame-2026-09-11.md` §3's attribution of the 2 s cluster to the transcript mount is **not**
  re-confirmed against these binaries. The clusters land in the same windows at the same offsets, which is
  consistent with it and is not proof of it.
- **The `prof`, `ctl`, `pre1500`, `pre4000` arms** of `burn-frame-2026-09-11.md` §7. None were run. The
  pre-roll bisect that would falsify the cold-mount attribution is still open.
- **The other five gates.** `cargo test`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo doc`, `npm test` and `npx tsc --noEmit` were **not run in this session**. The `npm run tauri build`
  above exited 0, but with the perf `--config` and `--features burn`, so it is not the plain build gate.
- **The real data directory.** Every run used the disposable `ai.brigadier.perf.cssspike` identifier; the
  product's own `ai.brigadier.app` data dir was never touched and its behaviour is unmeasured.
- **Whether any of this is visible to a user.** Unchanged from the prior round: `src/fps.ts:1-6` counts
  rendering opportunities, not presentation acknowledgements. Nothing here says a pixel arrived late.
