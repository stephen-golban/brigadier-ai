# codex-ui-kit CSS — paint-budget spike, 2026-09-11

What this answers: does vendoring the chosen codex-ui-kit CSS subset (~151 KB unminified) break the
`CLAUDE.md` §4 render gate — exec → first contentful paint **≤ 295 ms p50**, and 60 Hz with **0**
dropped vsyncs?

Every number below is **measured** with the command shown, on the worktree
`/Users/stephen/Development/brigadier-ai.worktrees/codex-thread` (branch `ui/codex-thread`, from
`main` at `ea8d705`). No number here is inferred from byte counts. §7 is what I did not check.

**Read §1 before quoting any absolute number.** Every sample was taken while another worker's Rust
release build was, or may have been, running on this machine. The A/B deltas survive that; the
absolute p50s are upper bounds.

---

## 1. Contention — the caveat on every absolute number

**Measured by the lead, not by me:** at ~03:2x, pids 17685 (`npm run tauri build`, `CODEX_CI=1`) and
18827 (`cargo build --bins --features tauri/custom-protocol --release`) were running from a different
worktree (`/private/tmp/brigadier-performance-fix-20260911`). By the time I checked (03:30) both pids
were gone, so I could not read their start time with `ps -o lstart=`; their start is therefore
**unknown**, and the only fact established is that a release build was running at 03:17 or later.

My measurement windows, from the harness's own per-launch log mtimes:

| arm | window | contention |
| --- | --- | --- |
| baseline series 1, full series 1, both burns, minus-FileChange | 03:09–03:16 | unknown — foreign build may already have started |
| tokens-only, baseline series 2–5, full series 2–5 | 03:17–03:21 | **inside the confirmed window** |
| match-DOM arms | 03:24–03:27 | overlaps the lead's ~03:2x observation |

**Treat all of it as contended.** Consequences, stated plainly:

- Absolute p50s are **upper bounds**. A quiet machine can only make them smaller, never larger, so
  "the baseline passes 295 ms" and "the full kit CSS passes 295 ms" are both *conservative*
  conclusions — they cannot be overturned by removing contention.
- The A/B deltas are far more robust than the absolutes, because the arms were **interleaved within
  minutes** (baseline, full, baseline, full …). A background load that varies on a timescale longer
  than one 40-second series moves both arms together. That is why §3 reports a paired, bootstrapped
  delta and an explicitly measured noise floor rather than a difference of two isolated medians.
- **The clean re-run did not happen, and no quiet number exists.** At 03:33 the Mac's console locked
  (`IOConsoleLocked=True`), and both `scripts/measure-native-startup.py` and
  `scripts/measure-native-burn.py` refuse to run locked, by design: all 19 re-run series returned
  `{"p50_ms": null, "pass": false}` with the single sample `"console locked before launch"`. A
  waiter parked for the unlock (`<scratchpad>/spike-perf/wait-and-run.sh`) was itself killed at 04:01
  with exit 144, still locked, having produced **zero** valid samples. Every
  `<scratchpad>/spike-perf/startup-q*.json` is a locked-refusal stub, not data; there are no
  `burn-q*.json` at all. **§3–§6 are the contended numbers and there is nothing cleaner behind
  them.**

  To settle it, on an unlocked foreground desktop with `pgrep -f "cargo |rustc|tauri build"` empty,
  run `<scratchpad>/spike-perf/quiet-run.sh` (19 interleaved series, ~15 min, all bundles already
  frozen and built) followed by `resetdata.sh; burn.sh qbaseline` and `resetdata.sh; burn.sh qfull`
  (~5 min). That also picks up the three `frozen-mdt-*.app` bundles that close the §5 gap.

  Those bundles live in the session scratchpad (1.9 GB, 23 × 44 MB) and are deliberately **not**
  checked in. If the scratchpad is gone, each one rebuilds in 66–104 s from §2's recipe: swap the one
  `@import` line in `src/index.css` between `spike-{full,nofilechange,tokensonly}.css` (or delete it
  for the baseline arm), re-inject `docs/performance/2026-09-11-css-spike/matching-dom.html` into
  `index.html`'s `#root` for the §5 arms, build, freeze. The runners are checked in beside it under
  `runners/`; they carry absolute scratchpad paths and need those repointed first.

---

## 2. Method, exactly

`npm install` in the worktree: exit **0**. esbuild's and fsevents' postinstalls are still unapproved
(`npm warn allow-scripts`); `node -e "require('esbuild')"` loads anyway and every `vite build` below
exited 0, so `npm approve-scripts` was **not** needed here.

The gate is two separate instruments, both driven from `scripts/`, both requiring an unlocked
foreground desktop:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR=<scratchpad>/spike-target
VITE_BURN=1 npm run tauri build -- --features burn \
  --config <scratchpad>/spike-perf/tauri.json --bundles app          # exit 0, 66–104 s

python3 scripts/measure-native-startup.py \
  '<scratchpad>/spike-perf/frozen-<label>.app/Contents/MacOS/brigadier' \
  --activate-helper <scratchpad>/spike-perf/activate-native-benchmark \
  --paint-log "$HOME/Library/Application Support/ai.brigadier.perf.cssspike/paint.ndjson" \
  --output <scratchpad>/spike-perf/startup-<label>.json --runs 10

python3 scripts/measure-native-burn.py \
  '<scratchpad>/spike-perf/frozen-<label>.app/Contents/MacOS/brigadier' \
  --activate-helper <scratchpad>/spike-perf/activate-native-benchmark \
  --data-dir "$HOME/Library/Application Support/ai.brigadier.perf.cssspike" \
  --output <scratchpad>/spike-perf/burn-<label>.json
```

Wrappers that record the exit code off the command itself (never through a pipe):
`<scratchpad>/spike-perf/{build,startup,burn,freeze,resetdata,quiet-run,wait-and-run}.sh`.

- **Release, not debug.** `--bundles app` release build with `--features burn`. Every build exited
  **0** (`<scratchpad>/spike-perf/build-*.exit`).
- Isolated identifier `ai.brigadier.perf.cssspike`, disposable data directory, onboarding seeded, the
  real `ai.brigadier.app` data untouched. Data, WebKit and cache dirs reset before each burn.
- Each build's bundle is **frozen** (`cp -Rc`) before the next build, so a later build cannot replace
  an earlier arm's executable.
- The Rust target dir is an APFS clone of the main checkout's `target/release` (1.8 s), so only the
  workspace crates recompiled. The main checkout was read, never written.
- `exec → FCP` is really **pre-spawn → FCP** (the launcher stamps epoch and monotonic time
  immediately before `Popen`), the repo's documented conservative approximation. FCP is the boot
  shell in `index.html`, not workspace readiness.

### What was vendored, and the one deviation

Re-ran the prior worker's script, unchanged, against the pinned commit:

```sh
node <scratchpad>/vendor-codex-ui-kit.mjs --source <scratchpad>/codex-ui-kit \
  --components AgentMessage,TurnDuration,ActivityTimeline,AgentActivity,StatusIndicator,\
CommandExecution,McpToolCallGroup,ToolCallCard,SearchActivity,SubagentActivity,\
ApprovalRequest,Notices,ThreadState,FileChange \
  --follow-imports --var-prefix "--cdx-" --class-prefix "cdx-" --dest <scratchpad>/spike-css-full
# exit 0
```

**Deviation from the prior run, deliberate:** prefixes are `cdx-` / `--cdx-`, not the script's default
`bg-` / `--bg-`. `bg-` is Tailwind's background-utility prefix and this tree uses 57 distinct `bg-*`
utilities in `src/**/*.tsx`; letting the kit mint its own `bg-*` classes would have restyled the app
under measurement. The rename costs one character per occurrence, so the measured CSS is *slightly
larger* than the `bg-` variant — a conservative direction. Script-reported byte counts, `cdx-` prefix:

| set | rules kept | extracted CSS | tokens.css | total |
| --- | ---: | ---: | ---: | ---: |
| full 14 components (`--follow-imports`) | 741 | 129,624 | 23,973 | **153,597** |
| same minus `FileChange` | 514 | 91,936 | 23,973 | 115,909 |
| tokens only | 0 | — | 23,973 | 23,973 |

That is 22.87% of the kit's 566,682-byte `styles.css`; `FileChange` alone is 37,688 bytes of it.

The CSS was imported into the render path as one line in `src/index.css`, immediately after
`@import "./focus-reset.css";`, so Vite inlines it into the entry stylesheet that `index.html` links
as a parser-created, **render-blocking** `<link rel="stylesheet">` (confirmed in each build's
`dist/index.html`). Nothing is lazy, nothing is tree-shaken. Measured effect on the render-blocking
entry stylesheet:

| arm | `dist/assets/index-*.css` | delta vs baseline |
| --- | ---: | ---: |
| baseline | 149,333 | — |
| tokens only | 178,017 | +28,684 |
| minus `FileChange` | 260,094 | +110,761 |
| full | 294,749 | **+145,416** |

The entry stylesheet nearly doubles. That is the thing being timed.

---

## 3. Baseline and the CSS delta — startup (exec → FCP)

`pre_spawn_to_fcp_ms`, release build, 10 launches per series, **every sample retained including the
cold first launch**. "warm" = the same series with launch 0 dropped; the cold launch is 1.0–1.8 s and
dominates any p95 computed with it. Contended (§1).

| arm | n | p50 | p95 | warm n | warm p50 | warm p95 | min | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A baseline, no kit CSS | 50 | **237.93** | 1027.32 | 45 | 236.48 | 277.62 | 216.20 | 1348.61 |
| B full kit CSS (+145 KB) | 50 | **241.74** | 1049.36 | 45 | 240.55 | 298.35 | 220.99 | 1237.96 |
| C kit CSS minus `FileChange` | 10 | 240.97 | 798.44 | 9 | 238.92 | 272.02 | 223.00 | 1215.53 |
| D kit tokens only | 10 | 236.50 | 763.66 | 9 | 235.39 | 249.41 | 217.54 | 1184.01 |

Per-series p50s, in the order they ran (A and B interleaved):

- A: 239.03, 222.74, 261.09, 238.97, 240.84
- B: 243.20, 237.70, 242.84, 246.09, 254.24

Every one of these 12 series passed the harness's own `p50 <= 295` check (`"pass": true`, exit 0), as
did all six series in §5.

Paired bootstrap on warm samples, 20,000 resamples, median difference with a 95% CI:

| comparison | median delta | 95% CI |
| --- | ---: | --- |
| full kit CSS vs baseline | **+3.92 ms** | [−1.65, +11.08] |
| minus-`FileChange` vs baseline | +2.44 ms | [−11.67, +12.24] |
| tokens only vs baseline | −1.09 ms | [−11.17, +11.13] |
| **noise floor** — baseline's own 2nd half vs its 1st half | **+7.46 ms** | [+0.48, +19.02] |

**The noise floor is bigger than the effect.** Comparing the baseline binary against *itself*, split
in half, moves the median by +7.46 ms; adding 145 KB of render-blocking CSS moves it by +3.92 ms.
The delta is real in sign and direction but is not resolvable above this harness's own drift at
n=45. Stated honestly: **the full kit CSS costs at most ~11 ms of FCP p50 (the CI's upper bound), and
the point estimate is ~4 ms.** Headroom to the 295 ms gate at the measured p50 is ~53 ms.

Dropped frames are a burn concept, not a startup one; there is no dropped-frame number for this
section. See §4.

---

## 4. The burn (60 Hz, dropped vsyncs)

Documented workload, unchanged: 10 sessions × 200 rows/s × 60 s, fixture `s1-handshake-and-turn`,
`?burn=auto`, no profiling, fresh isolated data per run.

| arm | duration | windows | **dropped** | worst frame | worst window p95 | longest drop run | max DOM | interrupted | verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| baseline | 63,438 ms | 64 | **4** | 44 ms | 23 ms | 2 | 469 | false | **FAIL** |
| full kit CSS | 63,266 ms | 64 | **5** | 42 ms | 23 ms | 2 | 469 | false | **FAIL** |

Both: activation exit 0, console unlocked after, sleep assertion alive, `profiling=false`,
`diagnostics=null`, document visible throughout, pre-burn idle window 60–61 callbacks with **0**
dropped. Harness exit 1 for both (the gate requires zero drops).

**The baseline already fails the 60 Hz gate, before any of this work.** 4 dropped vsyncs with no kit
CSS present. The delta from adding 145 KB is 4 → 5 drops and 44 → 42 ms worst frame, i.e. one drop in
either direction — inside the run-to-run spread the repo has already recorded for this workload on
this machine (2, 3, 4, 5 and 12 drops across `docs/performance/2026-09-10/` and
`docs/plans/native-performance-verification-2026-09-09.md`). **100% of the 60 Hz miss is
pre-existing; none of it is attributable to this CSS**, and with n=1 per arm I cannot claim the CSS
costs zero either — only that it is not separable from the existing failure.

**Both burns also failed their delivery audit**, identically and for a reason unrelated to CSS:
`frontend row count/drop mismatch` on 2 of 10 sessions (baseline) and 3 of 10 (full), plus
`Frontend did not ingest every terse row` (107,953 and 107,828 rows ingested). That is a pre-existing
delivery defect in this tree, not something the stylesheet touched. It means neither run is a valid
*acceptance* result; the frame counters are still directly comparable because both runs failed the
same audit in the same way.

---

## 5. Attribution — parse/apply vs selector matching

Separated by changing the DOM, not the stylesheet.

- **Parse/apply, essentially no matching DOM.** §3's startup measurement resolves the stylesheet
  against `index.html`'s 5-element boot shell, which carries no `cdx-` class. §3's answer is
  therefore the parse-and-apply cost: **+3.92 ms [−1.65, +11.08]**.
- **Parse/apply + matching against a representative thread DOM.** I generated a synthetic 460-element
  thread (`<scratchpad>/spike-perf/matching-dom.html`, 43,960 bytes — 460 elements, chosen to match
  the burn's measured 469-node maximum), every element carrying two real kit class names drawn
  round-robin from the 326 distinct `.cdx-*` names in `styles-full.css`. Injected into
  `index.html`'s `#root`, so it is present at FCP. Two arms with **identical DOM**, differing only in
  whether the kit CSS is linked:

| arm | n | p50 | warm n | warm p50 | warm p95 | per-series p50s |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| E match-DOM, no kit CSS | 30 | 238.81 | 27 | 238.18 | 250.13 | 245.12, 236.58, 235.90 |
| F match-DOM, full kit CSS | 30 | **264.78** | 27 | 262.38 | 295.71 | 266.04, 256.33, 269.35 |

Paired bootstrap, warm: **+24.50 ms, 95% CI [+16.70, +32.16]**. Every one of the three interleaved
pairs moved the same way (+20.9, +19.8, +33.5 ms).

**Selector matching dominates, by roughly 5×.** Parse/apply is ~4 ms and not separable from noise;
matching the same stylesheet against 460 elements that actually hit its rules costs ~20 ms more, and
that difference *is* resolvable — its CI clears the +7.46 ms noise floor with room.

Even so, arm F's p50 of **264.78 ms still passes the 295 ms gate**, with ~30 ms of headroom, and this
is a deliberately hostile DOM: the class vocabulary is spread round-robin across all 326 names to
maximise distinct rule matches, whereas a real thread reuses a much smaller set. Treat arm F as an
upper bound on matching cost at this DOM size, not as a prediction of the ported thread.

**One caveat that cuts the other way, and it is not small.** `tokens.css` scopes its 311 custom
properties to `[data-codex-ui]`, an attribute nothing in this tree carries — not the boot shell in
arms B/C/D, and not the synthetic thread in arms E/F. **Custom-property inheritance was therefore
never exercised in any measured arm.** The +24.50 ms is class-selector matching alone. Three further
release bundles exist with `data-codex-ui data-theme="dark"` on the synthetic thread's wrapper
(`frozen-mdt-{nocss,fullcss,nofc}.app`, all built exit 0); the console locked before they could be
measured and never unlocked, so the cost of resolving 311 inherited custom properties across 460
elements is **unknown**
and is the one number this spike is missing. It can only add to the +24.50 ms, so arm F's 264.78 ms
p50 is a lower bound for the token-applied case — 30 ms from the gate.

---

## 6. Verdict

**The vendored CSS fits the FCP budget. No reduction is needed, and I stopped optimising.**

The number behind it: **237.93 ms p50 baseline → 241.74 ms p50 with the full 151 KB set** (n=50 each,
release, contended), a paired median delta of **+3.92 ms** against a **+7.46 ms** measured noise
floor, leaving ~53 ms of headroom under the 295 ms gate. Against a hostile 460-element matching DOM
the worst case measured is **264.78 ms p50** — still ~30 ms inside the gate.

The one thing that could overturn this is the unmeasured custom-property cost in §5: no measured arm
had `[data-codex-ui]` on an ancestor, so the kit's 311 inherited tokens were never resolved. That
cost would have to exceed 30 ms on its own to push the hostile arm past 295 ms. The bundles to settle
it are already built and frozen; measuring them needs an unlocked, quiet machine.

On the pre-existing-vs-added split the brief asks for:

- **exec → FCP is not being missed at all on this machine today.** The brief's 326.6 ms figure is
  superseded: `docs/performance/2026-09-11/startup-uninterrupted.json` records 270.62 ms p50 on
  `main`, and my baseline measures 237.93 ms. Nothing to apportion.
- **The 60 Hz burn gate is being missed, and the miss is entirely pre-existing.** Baseline drops 4
  vsyncs with no kit CSS in the build. Our CSS moved that to 5, inside known run-to-run spread. Do
  not let the thread port be blamed for that failure — and equally, do not let it hide inside it:
  at n=1 per arm the honest statement is that our CSS is *not separable* from the existing failure,
  not that it is free.

What the reductions buy, since they were measured:

- **(b) dropping `FileChange` (−37,688 source bytes, −34,655 in the entry stylesheet)**: +2.44 ms vs
  baseline instead of +3.92 ms. Buys ~1.5 ms of FCP, well inside the noise floor. **Not worth doing
  for performance reasons.** If `FileChange` is dropped, drop it for a product reason.
- **(c) tokens only (+28,684 in the entry stylesheet)**: −1.09 ms vs baseline, i.e. indistinguishable
  from zero.
- **(a) the full set**: the recommendation. It fits.

The lever that matters, if a lever is ever needed, is **selector matching against the rendered
thread, not stylesheet bytes**. Re-measure arm E/F once real ported rows exist; bytes are the wrong
dial.

---

## 7. What I did not check

- **A quiet machine.** Every sample is contended or possibly contended (§1). The re-run produced no
  valid samples at all — the console locked and stayed locked. Absolute p50s are upper bounds; the
  deltas are paired and interleaved and survive. §1 has the exact command to close this.
- **n=1 per burn arm.** One 63-second burn per configuration. A dropped-frame delta of ±1 is not
  resolvable at n=1; I did not repeat the burns.
- **Custom-property inheritance.** No measured arm carried `[data-codex-ui]`, so the kit's 311 tokens
  were inert everywhere (§5). The three bundles that fix this are built and frozen but unmeasured.
- **The real ported thread.** No codex-ui-kit component renders in this tree. Arm F is a synthetic
  DOM built from the kit's class names, not the kit's components — it exercises selector matching,
  not the components' layout, images, fonts or animations. The 23 carried `@keyframes` were never
  triggered.
- **Debug/Vite.** Release only. `docs/plans/native-performance-verification-2026-09-09.md` records
  debug ~27 ms slower than release on the same source; I did not reproduce that with this CSS.
- **Compression and cold cache.** All launches are warm-cache after the first of each series. The
  entry stylesheet is served from the bundled app, not over a network, so transfer size is not in
  play; I did not measure gzip/brotli sizes because nothing here compresses.
- **The `bg-` prefix variant.** Measured `cdx-` only (§2). The difference is one character per
  occurrence and the `bg-` variant is the smaller of the two.
- **Whether the delivery-audit failure in §4 is new.** I did not bisect it; it reproduced identically
  in both arms and is unrelated to CSS.
- **The other four gates.** `cargo test`, `cargo clippy`, `cargo doc` and `npm test` were not run —
  this spike changed no Rust and no TypeScript. `npx tsc --noEmit` exits **0** on the tree as left
  (§8), and `npm run tauri build` exited 0 all nine times (`<scratchpad>/spike-perf/build-*.exit`).

## 8. What is left in the tree

Kept, untracked, nothing committed:

- `src/spike/codex-css/` — `tokens.css` (25,562 B), `styles-full.css` (131,238 B),
  `styles-nofilechange.css` (93,550 B), the three one-line entry files
  `spike-{full,nofilechange,tokensonly}.css`, and `LICENSE`. CSS only: the kit's `.tsx` files were
  deliberately **not** copied in, so `tsc` and Tailwind's `@source "./**/*.tsx"` never see them.
  This is a throwaway, not the vendoring's final home.

Reverted:

- `src/index.css` — the spike `@import` is removed; the file is byte-identical to its original
  (`diff` clean against `<scratchpad>/spike-perf/index.css.orig`).
- `index.html` — the §5 matching-DOM probe is removed; `git status` reports the file unmodified.
- `npx tsc --noEmit` on the tree as left: exit **0**.

Added, untracked, so the evidence outlives the scratchpad:

- `docs/performance/2026-09-11-css-spike/` (456 KB) — every startup series JSON with all samples
  retained, both full burn captures with their raw frame intervals, `build-exits.txt` (nine builds,
  all exit 0), `vendor-{full,nofc}.txt`, `analysis.txt` (the pooled stats and bootstrap output
  reproduced in §3 and §5), `matching-dom.html` (the §5 probe), and `runners/` (the eight wrapper
  scripts and the isolated `tauri.json`).

Raw evidence not copied in — frozen bundles, per-launch logs, runner scripts — stays in
`<scratchpad>/spike-perf/` =
`/private/tmp/claude-501/-Users-stephen-Development-brigadier-ai/14e67347-0897-4eec-9dd1-f6e922823da6/scratchpad/spike-perf/`:
`startup-*.json` (every launch retained), `burn-{baseline,full}.json` (full captures with raw frame
intervals), `build-*.{log,exit}`, `vendor-{full,nofc}.txt`, `matching-dom.html`, `analysis.txt`, the
23 frozen `.app` bundles, and the runner scripts. The `startup-q*.json` files there are
locked-refusal stubs with no samples — ignore them; §1 says how to produce the real ones.
