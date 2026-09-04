# STATUS — where the brigadier harness actually stands

Last updated 2026-09-04. **This is the file to read first.** It says what is built, what is proven,
what is broken, and what will bite you. The product it is building toward is `docs/vision.md`.

**§1 and §3 are the freshest sections in this file**: both were rewritten on 2026-09-04 against a
six-gate run at `c884767`. §§2, 4, 5, 6, 7 and the landmine list were revised earlier the same day
against the research files behind them. **Every section is dated by its own text** — read the commit
a claim names before quoting it.

No invented progress. A feature "works" only after it has been run. One line per fact, a path or a
number instead of an adjective, and what was not checked is said outright.

---

## 1. The tree right now

`main` at `c884767` ("docs: the layout fixes confirmed in WKWebView, and one claim that could not
be"), plus the commit carrying this file, which changes documentation only. On that parent tree
`git status --porcelain` printed nothing — **the working tree is otherwise clean**, nothing staged
and nothing pending the owner's approval. **[measured]** 2026-09-04.

**This section named `3e5c3fd` until this revision, and that was 36 commits stale, not seven** —
`git rev-list --count 3e5c3fd..HEAD` is **36** **[measured]**, two days behind. **16** of those
commits carry the date 2026-09-04 **[measured]**.

The **seven** commits after `1b18909` (`fix:`, clippy dead-code in `claude-spike` `session.rs`,
included per binary via `#[path]`) are the last session's output. Oldest first:

- `dc52f07` `docs:` — `docs/research/intent-records.md`, 583 lines: migration 3's `intents` table,
  an intent-kind → postcondition table, a three-outcome reconciler that never retries an `unknown`.
  **Design only, no code. Unimplemented.** It records that `respond` writes the decision to the
  child's stdin at `crates/core/src/claude/adapter.rs:960` and only emits `RequestResolved` at
  `:968`, so the one path `docs/plans/ipc-contract.md` calls the safety boundary is the one effect
  with no pre-record. **[source]**
- `10c123f` `docs:` — `docs/research/thinking-control.md`, 425 lines: the CLI starts every session
  at thinking `{type:"adaptive"}` and degrades that to `{type:"enabled", budget_tokens: N}` for a
  model with no adaptive mode, so a `claude-haiku-4-5` child thinks although `build_argv` asks for
  nothing. Read out of the 2.1.260 binary; **no live request was made** (`claude --version` and
  `--help` only). **[source]**
- `2657c71` `docs:` — `docs/research/visual-checks-2026-09-04.md`, 418 lines: the 800x500 minimum
  holds but three CSS rules break it, and the 60 Hz feed number re-measured on the 28 px row.
  **[source]**
- `47632b2` `docs:` — §§2, 4, 5, 6, 7 and the landmine list of this file revised; §1 and §3 left
  stale on purpose. This revision is the debt that line took on. **[source]**
- `e780fbd` `feat:` — harness children get thinking off by default, through the environment.
  `ThinkingPolicy` (`Off` \| `Inherit`, `Off` the default) on `SpawnSpec`, `StartSession` and
  `ResumeSession`; `Off` contributes `MAX_THINKING_TOKENS=0`, `Inherit` sets nothing at all.
  `build_command` split out of `spawn`; the four env steps are ordered and **the order is the
  contract**. 5 tests, **296 → 301** **[source]**. `build_argv` is unchanged, asserted byte for
  byte by a test. **Not measured: that the CLI turns thinking off in response** — the child's
  environment is pinned by tests, the CLI's handling is read from the 2.1.260 binary and the vendor
  docs, and only a live run settles it. **`crates/claude-spike` builds its own `Command` and does
  not pick this up — every spike binary still spawns a thinking-on child.**
- `f807e0e` `feat:` — W4-D2, the verbose toggle, plus four layout defects fixed. `FeedRowWire`
  carries `k`, the eleven-value union mirroring `brigadier_store::FeedKind`; terse is the default
  and hides exactly `k === "text"`; `visibleRows` filters on `k !== "text"` and nothing else, so
  `unknown` survives by construction. 6 tests, **131 → 137** **[source]**. Bundle **273.98 → 274.87
  kB JS, 25.17 → 27.11 kB CSS** **[source]**, out of that commit's own message and **not
  re-measured at the intermediate commit**.
- `c884767` `docs:` — `docs/research/visual-checks-2026-09-04.md` §8, 226 lines: the real-WKWebView
  confirmation of `f807e0e`'s fixes, on an unlocked screen with no spend (`pgrep -x claude`
  byte-identical before and after, no session started). **[source]**

The "everything uncommitted at `2327bb9`" paragraph was re-checked rather than assumed and all
three of its bullets are still literally true **[measured]** 2026-09-04 — the Bash classifier
committed at `21d2375`, and 12 `s8-*`/`s9-*`/`s10-*` NDJSON fixtures on disk under
`crates/claude-spike/fixtures/` with `git ls-files` counting the same 12 — but it describes a tree
36 commits gone and is no longer load-bearing. The one fact §7 still rests on:
**`crates/supervisor/src/handoff.rs` does not exist on disk and
`git log --oneline -1 -- crates/supervisor/src/handoff.rs` prints nothing**; the handoff wall was
dropped at `a415bb9`. See §7.

**The "measured at `2327bb9`" fallback is now the exception, not the rule.** §3's gate figures are
`c884767`, this run. §4 carries rows measured on 2026-09-03 and 2026-09-04 that name their own
commits — `spawn-split.md`, `perceived-performance.md`, `flood-baseline.md` at `c78a089`,
`visual-checks-2026-09-04.md` at `1b18909`. What the fallback still covers is only the rows that
name no later commit and no date: the four undated ones at the foot of §4's table — search-results
median, whole-repo symbol map rebuild, raw NDJSON, provider transcripts.

## 2. Built, and what proved each row

The evidence column's *kind* varies, so read it before quoting a row. `f1b911f`, `b2c1a4c` and
`8351335` are live runs against a real `claude` 2.1.258 child. `crates/proc/tests/`,
`crates/core/tests/claude_adapter.rs` and the **seven** front-end suites under `src/` — `App`,
`components/Feed`, `components/Sidebar`, `feedStore`, `index.css`, `paint`, `providers/ThemeProvider`,
counted 2026-09-04, up from five — are test suites in this tree, not live runs.
`docs/research/persistence.md` and `feed-rendering.md` are research documents — a document, not a
run. `7f03eb5` cites nothing at all. **No row is a live-`claude`-child proof unless
its evidence says so.**

| thing | commit | evidence |
|---|---|---|
| process supervision, orphan sweep, process-group kill | — | `crates/proc/tests/` |
| the stdio control protocol, direct from Rust | — | `docs/research/claude-direct-spike.md`, 7/7 scenarios |
| sqlite store, rotating NDJSON for raw traffic | — | `docs/research/persistence.md` |
| virtualized feed, rAF ingestion, honest FPS | — | `docs/research/feed-rendering.md` |
| approvals end to end (`can_use_tool`) | `f1b911f` | deny reached the model as an errored `tool_result`; allow ran the real command; a `Write` denied with no file written |
| resume onto the same session row | `b2c1a4c` | recall answer `pelican`; rows continued past the old `last_event_seq` |
| one git worktree per session | `b2c1a4c` | branch `brigadier/<8 hex>`; resume from a worktree cwd works |
| two live sessions on one project | `8351335` | interleaved feed ordered, counters correct, `shutdown_with(10s)` drained both in 581 ms |
| UI restyle — palette only | `41e030f` | the measured palette lives in `src/index.css` with its `[measured]` tags inline. **The "ChatGPT-shaped shell" claim is withdrawn**: the owner looked at it on 2026-09-02 and said it "looks nothing like ChatGPT, more like a year 1999 app". A measured palette is colour and nothing else. Being replaced in phase-4 W4. |
| data-dir lock, batcher shrink | `7f03eb5` | — |
| every `result` frame reaches the store | `ce833c5` | four fixture tests, `crates/core/tests/claude_adapter.rs:626,667,702,760`, against real captures (`s9`, `f-b-fanout`) — not a live-child proof. §5 item 9. |
| a front-end test runner | `ad5a4a7` | 27 tests, `src/feedStore.test.ts`, `npm test` (Vitest + jsdom + Testing Library). They pin `src/feedStore.ts` only: the rAF drain's coalescing and its stop, the `ROW_CAP` 2000 head-trim on both rings, the `seedRows` two-pointer merge (order, `q` interleave, `q`-collision, reference stability, idempotence, ROW_CAP on the union, project ring untouched), cost taking the latest turn's cumulative figure and never summing, `seedSessions`' end/cost reconciliation, counter throttling at `COUNTER_FLUSH_MS`, array-reference stability, and the unknown-projects list. Not a live-child proof and not a UI proof. |
| the app can time its own paints | `1c8b6f6` | **38** tests, `src/paint.test.ts`, and a build — **24 → 38** since that commit, re-derived 2026-09-04 from `npx vitest run --reporter=json` **[measured]** (§3). `src/paint.ts` observes `first-contentful-paint` and reports it over `report_paint` (`docs/plans/ipc-contract.md`). Since run for real: `paint.ndjson` works end to end in a real window and `main_to_fcp_ms` matched its own `tracing` line on all 19 runs (`docs/research/perceived-performance.md` §1.4). **The interaction half has since run**, and this line is corrected: `a0901e5` gave `beginInteraction` its first and only call site (`src/App.tsx:351`), so it is no longer tree-shaken, and **B4 is a measured number** (§4). **B6 and B7 still have no call site at all** — grepped 2026-09-04, that one site is the only non-test caller in `src/`. |
| the measured palette as oklch `@theme` tokens | `3e5c3fd` | 18 of 18 colour tokens round-trip hex→oklch→hex bit-exact and all 8 annotated contrast pairs re-derive to within 0.0017, verified twice independently (`docs/research/oklch-tokens.md`, and `frontend-stack.md` §2.6 arrived at the same ratios first). Unit tests and a build only — **nothing has been looked at in a running window.** |
| MCP off by default, per-project opt-in | `9ca7ee2` | `McpPolicy` (`off` \| `inherit`) in `crates/core/src/driver.rs`; `--strict-mcp-config` pinned in the argv tests of `crates/core/src/claude/process.rs`; store migration 2 (`user_version` 2 to 3, `projects.mcp TEXT NOT NULL DEFAULT 'off'`), which **switched every existing project to `off` on 2026-09-03**, the owner's two live projects included, and each can opt back in per project; supervisor passes the project row's policy on start and on resume (`crates/supervisor/src/lib.rs`, recording-driver test); command `set_project_mcp(project_id, mcp)` and `ProjectView.mcp` (`docs/plans/ipc-contract.md`). Tests only, no live child: the `mcp_servers: []` proof is `spawn-split.md` §1. **Both migrations have now run on the owner's own data directory, not only on tempdir replicas** — **[measured]** 2026-09-04, read-only against `~/Library/Application Support/ai.brigadier.app/brigadier.sqlite`: `PRAGMA user_version` is **3**, both live projects read `mcp='off'`, and all **10,037** pre-migration feed rows read `kind='unknown'` with none reading `'sys'`, so migration 1's corrected default (`959bd0c`, fixed at `1d23df9`) landed on real data and no row has been written since. The replica tests remain the only *proof* of behaviour (`crates/store/src/schema.rs::migration_2_switches_a_pre_existing_project_to_off`, `crates/store/tests/schema.rs`); nothing records which projects were switched and which chose, so render `off` as a state, not a decision. **The UI toggle is not built**; nothing in `src/` calls `set_project_mcp` — grepped 2026-09-04. |
| the shell, and the first interaction timed | `a0901e5` | 28 new tests (`src/App.test.tsx` 10, `src/components/Sidebar.test.tsx` 18) plus a real window: the sidebar, project collapse and session selection were **driven by hand**, and 14 selections were timed through `beginInteraction` into `paint.ndjson` (**B4**, §4). `ThemeProvider` is now mounted (`src/main.tsx:22`). Seven AA failures were found and fixed in the process — see the landmine below. |
| the feed reads as a thread, not a log table | `864a2fe` | the timestamp column, the raw `seq` column and the zebra stripes are gone; 13 px sans at `ROW_H` 28, a rule at clock-minute boundaries only, zero accent at rest, and a 1.4.11 failure on the jump pill's border (1.585:1) fixed on the way. `src/components/Feed.test.tsx` and `src/index.css.test.ts` are new suites; the second gates that every class in markup has a hand-written rule. **Nothing here has been seen rendered**, and the blur test that decides whether it answers the owner's "year 1999 app" verdict has not been run. Those test counts and CSS figures have since been re-run — the six gates at `c884767` on 2026-09-04 give `src/components/Feed.test.tsx` **20** and `src/index.css.test.ts` **8**, inside 137 across 7 files, and CSS **27.11 kB** **[measured]**; §3 carries the run. |
| the launch decomposed stage by stage, and the page half split | `6db9f6e`; the `dcl` stage at `8293342` and `62e6717`; the numbers at `8b286f5` | `BRIGADIER_TRACE=1` signposts in `src-tauri/src/trace.rs`, 12 warm launches on 2026-09-03 plus 5 more (1 cold, 4 warm) on 2026-09-04 after the `dcl` stage landed. Measured, not inferred: `state::build` inside `setup` is **8.1 ms** p50, not the missing ~100 ms; Tauri's own window creation before our setup closure, `builder_built` to `setup_entry`, is **108.7 ms** p50 warm and **420 ms** cold, so a cold launch is slow there and not in the page; `page_load_finished` to FCP, 83.3 ms undivided, splits into **49.6 ms** fetch plus parse and **28.5 ms** React mount plus render, so the scheme-plus-brotli attribution has a 49.6 ms ceiling and not a 100 ms one. `RLIMIT_NOFILE` is now raised at startup (launchd hands a GUI launch **256**). `docs/research/launch-signposts.md`. **Caveats that matter, and every one of them qualifies a number above it:** (a) **every 2026-09-04 figure was taken with the display locked** (`CGSSessionScreenIsLocked=1`), and that run's exec → FCP of **288.8 ms** landing inside the established 287–295 ms band is **weak evidence that the lock did not move FCP, not proof**; (b) the **28.5 ms mount half is n=4 with a 60.0 ms outlier** against a 23–29 cluster, and both its endpoints are page-relative timestamps clamped to 1 ms — **do not plan against 28.5**; the **49.6 ms fetch-and-parse half is the tight one** (four samples inside 1.5 ms) and the 64/36 verdict rests on it; (c) the `RLIMIT_NOFILE` raise was verified **under a simulated `ulimit -n 256` from a shell, never from an actual Finder launch** — `launchctl limit maxfiles` of 256 is the evidence that the Finder case needs the raise, and the Finder case itself has never been run with stderr captured; (d) no run used a cold OS file cache (`sudo purge` needs sudo); (e) nothing here is a p95 — n=12 warm and n=4 for the split. |

**Still never clicked in a real window:** the **Resume button** and the **branch chip**. The cleanup
flow and the approvals dock have not been driven either, and none of the four has a test. What
*has* now been driven by hand, at `a0901e5`: the sidebar, project collapse, and session selection —
so that part of the paragraph is retired.

**Three things have never been observed at all**, each covered by tests and each unseen:

- the **pulsing busy dot** — nothing has been running while anyone was looking;
- the **collapsed-project run marker** — every session in the owner's store is `failed` or `exited`,
  so no project has ever had a live child under it;
- the **empty-session `cancel()` branch** — the smallest real session in the store is 6 rows.

**`pre`, `ul` and `li` are still unexercised under Tailwind preflight.** They exist only in
`src/components/Approvals.tsx`, and the store holds exactly one approval row which is already
resolved, so `pending_approvals` returns empty and the dock never opens. Both halves re-checked
2026-09-04 **[measured]**: five `<pre>`/`<ul>`/`<li>` occurrences in `src/`, all in that one file,
and `SELECT count(*) FROM approvals` is 1 with `resolved_at` set. That is still the largest
thing unverified about the token layer, and only a live approval closes it.

## 3. Gates at `c884767`

All six run by the lead under its own hand on 2026-09-04 against a clean tree, exit codes captured
on the command itself and not through a pipe. Every line **[measured]**:

```
cargo test --workspace                                exit 0  301 passed, 0 failed, 6 ignored
cargo clippy --workspace --all-targets -- -D warnings exit 0  0 warnings
cargo doc --workspace --no-deps                       exit 0  0 warnings
npm test                                              exit 0  137 passed, 7 files
npx tsc --noEmit                                      exit 0
npm run tauri build                                   exit 0  .app + .dmg
```

The 301 is the sum of 31 `test result:` lines across the workspace. The 137, re-derived today from
`npx vitest run --reporter=json` rather than carried forward: `paint.test.ts` **38**,
`feedStore.test.ts` **27**, `components/Feed.test.tsx` **20**, `components/Sidebar.test.tsx` **19**,
`providers/ThemeProvider.test.tsx` **15**, `App.test.tsx` **10**, `index.css.test.ts` **8** — 137
across 7 files. The old line naming `paint.test.ts` 24 and `Sidebar` 18 is superseded:
`paint.test.ts` grew **24 → 38**, `Sidebar` **18 → 19**, and `components/Feed.test.tsx` and
`index.css.test.ts` are the two suites that did not exist at `a0901e5`.

**What this gate run does not prove.** It is a build and a test run: no live `claude` child was
spawned, and **none of the six gates exercises the UI in a window.**

Bundle at `c884767`, read off the `vite build` line of the gate run: **274.87 kB JS + a 1.38 kB
lazy chunk / 27.11 kB CSS**, gzip **86.90 / 0.67 / 6.12** **[measured]**. From **272.71 / 26.91 at
`a0901e5`** — **+2.16 kB JS and +0.20 kB CSS over 31 commits** — and 263.28 / 21.89 at `3e5c3fd`,
262.69 / 12.69 at `ad5a4a7` before that. The JS figure includes the interaction half of
`src/paint.ts`, which `a0901e5` gave its first importer; before that it was tree-shaken out and the
263.28 kB figure was the FCP half alone (`docs/plans/ipc-contract.md`, `### report_paint`). The CSS
growth from 12.69 is almost entirely Tailwind preflight — the token layer itself was **+0.54 kB**,
and Tailwind adds **zero** JS (`docs/research/oklch-tokens.md` §5). The earlier `~258 kB JS` line is
superseded.

**One warm FCP sample at `a0901e5` came back at 375.9 ms**, against the 287–295 ms p50 (n=19)
recorded at the smaller bundle. One sample against a distribution, and the same run's cold launch
(801.9 ms) matches an earlier cold outlier (755.9 ms), so the regression is **neither attributable
to the bundle growth nor ruled out** — and the bundle has since grown a further 2.16 kB JS while
the n=19 three-arm treatment still has not been re-run, so that one sample stands exactly where it
did. Re-running that treatment (`docs/research/perceived-performance.md` §1.4) is what would settle
it. B1's figure is unchanged.

**The 6 ignored are not six live tests, and the difference is money.** From
`grep -rn '#\[ignore' crates`, 2026-09-04 **[measured]**:

- **Five spend on a live account:** `live_pong` (`crates/core/tests/claude_adapter.rs:1080`),
  `live_resume` (`crates/supervisor/tests/live_resume.rs:255`), `live_approvals` (`:270`),
  `live_worktree` (`:189`), `live_two_sessions` (`:239`).
- **The sixth costs nothing.** `eight_ordinary_one_flood_one_approval_across_three_projects`
  (`crates/supervisor/tests/flood_baseline.rs:137`), added at `96a66a2`, **spawns no `claude`
  process** — every session is a `ReplayDriver` over a captured NDJSON fixture. It is `#[ignore]`d
  because it is a ~30 s instrument, not a gate.

Say which you mean: a reader who believes all six cost money will avoid the one that does not, and
a reader who believes none do will spend.

Run one at a time. The old single command named `-p brigadier-supervisor` only and was incomplete —
`live_pong` lives in `brigadier-core`:

```
CLAUDE_BIN="$(command -v claude)" cargo test -p brigadier-supervisor --test <name> -- --ignored --nocapture
CLAUDE_BIN="$(command -v claude)" cargo test -p brigadier-core --test claude_adapter -- --ignored --nocapture
```

Live costs, from the store row: `live_approvals` ~$0.046, `live_resume` ~$0.031,
`live_worktree` ~$0.030, `live_two_sessions` ~$0.053, plus the older `live_pong`. The protocol spike
runs cost **$0.111336, under their $0.15 cap** — an earlier report of $0.160698 and an $0.011 overrun
was wrong. `result.total_cost_usd` is **cumulative**, so a run emitting two `result` frames was
double-counted; the correction was verified against the fixture's own `cacheReadInputTokens`
(72,567 → 115,395 across the two frames). W0-D itself cost **$0.186289 against a $0.15 cap, 24%
over** — a warm prefix saves cost but not the per-turn re-read.

`live_approvals` rewrites `crates/claude-spike/fixtures/s7-can-use-tool-write.ndjson` on every run;
`git checkout` it afterwards unless the capture changed on purpose.

> These are dollar figures from `total_cost_usd` on an account. **The product does not show dollars**
> — see `docs/vision.md` §6. They are here because they are what the test harness prints.

## 4. Measured numbers worth knowing

| number | value | source |
|---|---|---|
| spawn → `system/init`, MCP-off (n=5, 2026-09-02) | **569–656 ms**, median **645 ms**; measured from `spawned_at` to the first `system/init` with `--strict-mcp-config` set (`crates/claude-spike/src/bin/fanout.rs:97,120,157`) | `crates/claude-spike/fixtures/f-warm.summary.json:151`, `f-a.summary.json:151,309,467`, `f-b.summary.json:504` |
| spawn → `system/init`, MCP-on (n=1) | **1,981 ms**, both of the user's MCP servers (`higgsfield`, `pencil`) connecting | `claude-direct-spike.md:107` |
| spawn → `system/init`, MCP on/off medians (n=6 pairs, 2026-09-03) | **1,395.0 ms on, 643.5 ms off, delta +751.5 ms** | `docs/research/spawn-split.md:105`, `crates/claude-spike/fixtures/spawn-split/` |
| spawn → `initialize` response | 719 ms, from that same MCP-on run; MCP-independent per `spawn-split.md:104,113` (median delta 38.5 ms, inside the noise); the five fan-out summaries carry no equivalent handshake figure | `claude-direct-spike.md:106` |
| stdin closed → exit 0 | 571 ms | same |
| exec → real project list (p50) | **292 ms**; replicated **290.5 ms**, n=7 | `perceived-performance.md` §1.2, §1.4 |
| **exec → first contentful paint (p50, 3 arms, n=19)** | **287–295 ms** — B1's ≤ 200 ms budget missed by ~90 ms | `perceived-performance.md` §1.4 |
| first-ever launch with migrations, exec → first IPC (p50, n=7) | **291.3 ms**, against 290.5 warm — migrations cost nothing measurable | same |
| the owner's real 1.6 MB data dir vs a warm empty one | **+1.1 ms**, inside the spread | same |
| exec → `main()` entry | **~4.9 ms** (p50 of 19, range 4.1–6.4) — the invisible pre-main segment | same |
| `brigadier started` → FCP | **132–141 ms**, against a 38 ms estimate | same |
| **click session → last screenful painted (B4)** | **p50 32.5 ms**, range 22–144, n=14; 13 of 14 under the 100 ms budget. **No p95 — n=14 cannot support one.** Capped rather than fast: `TAIL_ROWS = 48` means a 500-row session measured 25 ms | `perceived-performance.md` §2.7 |
| `beginInteraction`'s own floor | **~33 ms** at 60 Hz (its double-`requestAnimationFrame`); 8 of the 14 B4 samples sit within one frame of it | same |
| WKWebView construction alone | ~100 ms | same |
| React 19 + 258 kB bundle, FCP cost over a 400-byte page | ~12 ms | same |
| window refresh rate | **60 Hz in 62 of 62 one-second windows**, `p50_ms` **17.0** in every one, on the 28 px row at `1b18909`. **[measured]** The "1,513 samples" citation is **superseded**; caveats and corrections beneath this table | `visual-checks-2026-09-04.md` §3 |
| approval park → sink, 10 synthetic sessions with one flooder (n=5, `c78a089`) | **3.2 / 4.2 / 10.6 / 14.2 / 14.9 ms** against a 100 ms gate. **Measured to the Rust sink and no further** — the `eval` hop, the rAF drain, the React commit and the paint are not in it | `flood-baseline.md` §0, §2 |
| store read round trip during a 1,500 rows/s flood (n=5, `c78a089`) | p50 **2.30–2.89 ms**, p95 up to **8.66**, worst **9.82**; a sixth run, discarded for an unrelated model defect, reached **43.22**. **Debug build, five other agents' builds running.** It exceeds §2.3's 8.03 ms worst case, and only a release build on an idle machine reproducing it reopens trap 5 | same |
| the same flood test re-run at `1d23df9` | during-flood read worst **8.58 ms**, gate 3 `lost=0`, `max_message_bytes` **7,997** | **no research file records this run** — `flood-baseline.md` documents only the five `c78a089` runs above, so this row is its only record and carries no method beside it |
| search results, median | 127 tokens (8.2% of tool tokens; `Read` is 73%) | `codebase-index.md` |
| whole-repo symbol map rebuild | 145 ms | same |
| raw NDJSON on this machine | 66 MB / 23 sessions | `worktree-cleanup.md` |
| provider transcripts on this machine | **3.0 GB** | same |

**What qualifies the refresh-rate row, and it does not fit in a cell.** Measured at `1b18909`,
recorded at `2657c71`, under a 10-session × 200 rows/s × 60 s burn with the feed scrolled
throughout: 62 of 62 one-second windows report `hz 60`, `p50_ms` **17.0** in every one, and
`hz_source = p50` in none of them. **[measured]**

**Dropped vsyncs: 4 across the 62 windows**, all inside one window (that window: `dropped = 4`,
`worst 83 ms`), longest drop run **1**; `fps.windowPasses` failed **1 of 62**, so the run does
**not** pass its own gate. A control run with the same scroll and **no ingest** passed **65 of 66**
at worst 28 ms — **the drops come from the ingest, not from the scroll**, which is the useful half
of the result. **[measured]**

**`dom_nodes` median 505** under that load, and **the old median of 110 was never a feed metric**:
`dom_nodes` is `document.getElementsByTagName("*").length` (`src/fps.ts:182`), the whole document,
sidebar included. Idle on the current markup it is **123** (release build, 800x500) and **139**
(debug build, 1280x800); the feed row itself is now **2 DOM nodes** and 23 rendered rows cost
**47 nodes** under `.feed-sizer`, so the virtualizer is holding. **[measured]**

**The "1,513 one-second samples" citation is superseded, not merely dated**: `864a2fe` changed
`ROW_H` **18 → 28** at 2026-09-04 01:39 and the sample file's last pre-existing window is
2026-09-03 14:24, so **every sample behind that number predates the markup it described**.
**[measured]**

**Two caveats travel with the new number or it is worth no more than the old one.** It is **n = 1**
— one verified 62-window run, no distribution across repeats. And it is a **debug build**:
`src/App.tsx:119` gates the Burn panel on `BURN_UI`
(`const BURN_UI = import.meta.env.DEV || import.meta.env.VITE_BURN === "1";`), and
`import.meta.env.VITE_*` is a build-time literal substitution, so with that variable unset the
expression folds to `false` and a release `vite build` strips the only UI that can call the command
`--features burn` compiles, which means **every burn number this project has is a debug-build
number**. **[measured]** `VITE_BURN=1` now makes a release burn reachable and **no release burn has
been run**, so the debug-build caveat on this number stands. A debug Rust binary, a vite dev server
and a React development build are each strictly slower than what ships, so the near-pass is an
**upper bound on badness, not a release result**; the shipped binary's scroll FPS under load is
unmeasured. **[asserted]**

## 5. Defects — what was found, and what is left

Nine are listed and **all nine are fixed**: eight found on 2026-09-02 by research agents, plus
item 8, which was fixed during phase 4 (`53c3491`). Verified against the code on 2026-09-02, not
against a report.

Fixed:

1. **`git worktree repair` was absent entirely** — after a project folder was renamed, `repair`
   recovers every worktree, but startup `prune` ran and made recovery impossible. Now called
   (`crates/core/src/worktree.rs:442`).
2. **A crash mid-`worktree add` left a `locked initializing` entry only `remove -f -f` could clear**,
   and `remove()` passed at most one `--force`. Now a `RemoveForce` rung passes 0, 1 or 2
   (`crates/core/src/worktree.rs:392-400,487-489`).
3. **`removed: true` could be a lie** — `git worktree remove` exits 0 and leaves every file on disk
   in the moved-project state. Now set only after `path.exists()` says the directory is gone
   (`crates/supervisor/src/worktree.rs:545`).
4. **Unforced remove ignored commits** — a clean worktree with five unpushed commits removed with
   exit 0. Now counted as `commits`, against `live_branch`, and refused.
5. **Safety decisions read `sessions.branch`** rather than the live checkout. Now read from
   `git worktree list --porcelain` (14 call sites), with `live_branch` on the wire.
6. **SECURITY: `git worktree add` executed the repository's own filter drivers.** Fixed at
   `5d71793`. The escalation found while fixing is worse than first described: a worktree's `.git`
   is a *file*, so there is no per-worktree config, and `git config --local` from inside a session's
   worktree writes the **main** repository's `.git/config`. An agent in one session could plant a
   driver with an ordinary git command and have the next session's worktree creation run it as
   shell, outside every approval prompt. `core.fsmonitor` set to a command ran the same way — at
   `worktree add` itself and again at every later `git status`. Mitigated by blanking **four** keys,
   not three — `smudge`, `clean`, `process` and `required` — on every filter the **effective**
   config defines, and setting `core.fsmonitor` to `false`, through `GIT_CONFIG_*` on `add`,
   `repair`, `remove` and `dirty_count` (`crates/core/src/worktree.rs:185,220,318,437,473,720`).
   **`required` is not belt-and-braces.** **[measured]**, on a **hand-set**
   `filter.evil.required = true`: with only the three command keys blanked, `worktree add` exits
   **128** with `fatal: f.txt: smudge filter evil failed`, and adding `required=false` returns it to
   exit 0 (`docs/research/gitattributes.md` §3; `crates/core/src/worktree.rs:177-185`). Delete that
   key as redundant and the failure names smudge filters rather than the deletion. The enumeration
   reads system + global + local + `include.path` (**[measured]**, §3, verified against an
   `include.path`-defined driver). **git-lfs is not installed on this machine** (`gitattributes.md`
   §6), so two clauses beside that are **[asserted]**, reasoned from the config keys and never
   observed here: that `git lfs install --local` is what writes `filter.lfs.required = true` in the
   wild, and the accepted consequence that a globally defined `lfs` driver is blanked too, so LFS
   content arrives in a new worktree as pointer files with `git lfs pull` inside it the cure.
   Installing git-lfs and re-running §3's case would settle both. `required` is set to `"false"`
   rather than `""` for readability in a `ps` listing, not for correctness — an empty value is read
   as false either way (**[documented]**, `git(1)` on `-c foo.bar=`, via
   `crates/core/src/worktree.rs:187-190`).
7. **`prepare` accepted two inputs it should refuse** — a project root that is itself a linked
   worktree, and repos with submodules. Both now typed refusals
   (`crates/core/src/worktree.rs:92,106,121`). 36 worktree tests.
8. **`src/feedStore.ts` discarded the 500-row seed** whenever a live batch won the race. Fixed at
   `53c3491` with a two-pointer merge keyed on the envelope `seq`.
9. **The adapter dropped every `result` after the first**, so an async `Agent` subagent's cost never
   reached the store: `on_result` took `self.open_turn` and returned early, under-counting `s9` by
   13.5% and `f-b-fanout` by 54.3%. Now a `system/init` with no open turn mints a continuation turn
   (`crates/core/src/claude/adapter.rs:588`), which also keeps `busy` true across the subagent
   phase, and a `result` with no open turn mints one too
   (`crates/core/src/claude/adapter.rs:740-748`), so no frame is dropped even if that alternation
   ever breaks. A minted turn is marked as such and a `SendTurn` **pre-empts** it rather than being
   refused (`crates/core/src/claude/adapter.rs:982-1022`), so an `init` that no `result` follows
   cannot lock the operator out; an operator's own turn still refuses a second send. Four fixture
   tests, `crates/core/tests/claude_adapter.rs:626,667,702,760`; each fails on the code it was
   written against.
   Three accepted regressions, all in the comments at those lines: `busy` flickers false → true
   between a `result` and the next `init`; one feed row is written per `result` frame, so a
   fan-out message now writes four "turn done" lines instead of one; and across a pre-emption the
   in-flight `result` closes the operator's turn rather than the minted one, so turn attribution
   is approximate while the cumulative cost stays exact.

**Still open: none.** No timer was added — `on_exit` (`crates/core/src/claude/adapter.rs:1126`) is
the only backstop for an `init` with no `result`. That this is sufficient is **[asserted]**, not
measured: `docs/research/async-subagent-results.md` tags the same claim `[asserted]` and voids it
if a capture ever shows an `init` with no matching `result` outside the kill path (`s7-kill`), in
which case a timer is required. `docs/research/unprompted-init.md` states the open question, the
three uncaptured paths that could produce one, and the live spike that would settle it.

**Still none of the nine — but the nine are no longer the whole defect record.** Found and fixed
since 2026-09-02, each by an instrument reading could not replace: three that only a rendered pixel
could find (`ccc8955` — an inset `box-shadow` rail whose *subtractive* paint tinted 496 device
pixels per row edge, a branch chip needing 141 px in a 119 px slot, and a comment certifying a fit
it never checked); `feed.kind`'s migration default corrected from `'sys'` to `'unknown'` before it
reached real data (`1d23df9`); and the `dcl` signpost's first three recipes, each of which shipped
and never fired (`0ddfe7b`, `62e6717`; `docs/research/launch-signposts.md` names all three). What
`ccc8955` left unobserved is in its own message: the surviving status bar's pixels have never been
scanned and the narrow layout after the prefix yields has never been rendered.

**Four more, found 2026-09-04 at the enforced 800x500 minimum** (`docs/research/visual-checks-2026-09-04.md`
§2, §3.2). **All four landed at `f807e0e`, and three of the four were confirmed in a real WKWebView
window at `c884767`** **[source]**. The diagnoses below are the record as found and stand unchanged;
each item's fix and its confirmation status follow it. Three are one CSS rule each; the fourth is a
build gate.

1. **`src/index.css:1120-1125`, `.feed-sizer` has no horizontal padding**, so feed rows run flush to
   the window's right edge on every window narrower than **932 px** while `.thread-head` stays inset
   16 px — real-window ink from **pt 220.5 to pt 798.5 of 800**. **[measured]** Remedy:
   `box-sizing: border-box; padding-inline: 16px` (or `max-width: min(var(--content-max), 100% - 32px)`),
   which also fixes `.feed-count`'s `max(16px, …)` inset at `src/index.css:1097` floating 16 px in
   from an edge the rows it labels are touching. **Fixed at `f807e0e`** with
   `max-width: min(var(--content-max), calc(100% - 32px))` and **not** `padding` — padding insets the
   content and leaves the box at the pane edge, which would float `.feed-count` inside the ink it
   labels. **Confirmed in a real window** at `c884767`: gutters **0/0 → 16/16**, and the band flush
   with the sizer at **800, 932, 1000 and 1280**. **[source]**
2. **`src/index.css:1634`, `.fps` at `flex: 0 0 auto` (`:1635`) with `white-space: nowrap` (`:1643`)
   starves `.head-id` to width 0** and overflows the page by **205 px** at viewport width 800 —
   **reproduced in a real release window**: turning the meter on makes the thread title and its path
   vanish from the header. **[measured]** Remedy: `flex: 0 1 auto; min-width: 0; overflow: hidden;
   text-overflow: ellipsis`, or render only `hz` + `dropped` below the 1200 px breakpoint. Reached by
   clicking the pill, not met on launch — the meter is off by default in a release build. **Fixed at
   `f807e0e`** with `flex: 0 1 auto; min-width: 0; overflow: hidden`. **Confirmed in a real window**
   at `c884767`: `.head-id` **0 px → 234.6 px**, `.fps` **301.4 px** against a predicted 301.4. The
   `max-width: 55%` refinement sits inside `@media (max-width: 1200px)` and not everywhere, because
   it costs 120 px of meter text at the default 1280 and buys nothing there. **[source]** **One
   methodological correction against this item itself, and it matters: the 205 px overflow figure
   cannot be confirmed in WKWebView either way** — `body { overflow: hidden }`
   (`src/index.css:250-254`) means no scrollbar appears with or without the fix, so its absence
   proves nothing.
3. **`src/index.css:1296`, `.approvals { max-height: 42vh }` over the fixed 160 px `.dock`
   (`src/index.css:1413`) leaves the feed 59.5 px — 1.39 rows** at viewport height 468, the top
   visible row cut through its glyphs; `.approvals` is `flex: 0 0 auto` so it cannot yield and `.feed`
   has no `min-height`, so the feed absorbs the whole squeeze. **[measured]** (Chromium + mock; not
   reproduced against a real pending approval in the Tauri window.) Remedy: give `.feed` a
   `min-height` of ~112 px and make `.approvals` `flex: 0 1 auto`, or cap it at
   `min(42vh, calc(100vh - 324px))`. **Fixed at `f807e0e`**: `.feed` gained `min-height: 132px` and
   `.approvals` became shrinkable. **132, not the 112 proposed on the line above** — `box-sizing` is
   `border-box` and `.feed` carries a 20 px band, so 112 would have been 3.28 rows. **[source]**
   **Still unconfirmed in a real window**: the store's one approval is resolved, `pending_approvals`
   is empty, and forcing it means writing to the owner's database, which was refused. The number
   stays a **Chromium-plus-mock** result and must be labelled as one.
4. **`src/App.tsx:493` gates the Burn panel on `import.meta.env.DEV`**, so a release `vite build`
   strips it — `grep -c "burn harness" dist/assets/index-*.js` is **0** while
   `strings target/release/brigadier` hits `burn started`, i.e. `--features burn` compiles a command
   the shipped UI has no way to call, and **every burn number this project has is a debug-build
   number**. **[measured]** Remedy: give the panel the same kind of gate the meter has (a
   `localStorage` flag, or a build-time `define`) so a release-profile burn can be measured without
   editing source. **The remedy shipped at `f807e0e`, and this item's citation is stale in both path
   and expression** — **[measured]** 2026-09-04 against the source, the gate is no longer
   `src/App.tsx:493` on `import.meta.env.DEV` but **`src/App.tsx:119`**,
   `const BURN_UI = import.meta.env.DEV || import.meta.env.VITE_BURN === "1";`.
   `import.meta.env.VITE_*` is a build-time literal substitution, so an unset variable folds the
   expression to `false` and Rollup drops the panel exactly as `DEV` did. **The consequence this
   item draws is unchanged: every burn number this project has is still a debug-build number**,
   because `VITE_BURN=1 npm run tauri build -- --features burn` makes a release burn *reachable* and
   **nobody has run one**. Both halves are needed and independent — the Cargo feature compiles the
   Rust command, the variable ships the button.

**The minimum itself works, and that is the larger half of the result.** Both breakpoints fire, the
sidebar is exactly **220 pt** in the real window, `--content-max` is intact at **712 px**, the
composer's `textarea` and its Start button are reachable, and there is **no scroll in either axis**
with the meter off. **[measured]** Usable, not correct.

**An 800x500 window is a 800 x 468 CSS viewport.** The macOS title bar measures **32.0 pt** — real
window, `#181818` to y 31.5 pt and the sidebar ground from y 32.0 pt, cross-checked because the brand
strip then occupies viewport y 0–52, exactly `--head-h: 52px` (`src/index.css:196`). **[measured]**
Window size and viewport size are not the same number and must not be quoted interchangeably: the CSS
breakpoints see 468 px of height, not 500.

**Resolved by the owner, 2026-09-03 — `--color-text-muted-side` now passes AA.** It was
`#a3a3a3` / `oklch(0.7155 0 0)`, **4.456:1** on `--color-sidebar-bg` (`#3a3b3b`), missing WCAG AA's
4.5:1 for normal text by 0.044. The owner chose `#a5a5a5` / `oklch(0.7219 0 0)`, which is
**4.563:1** — **[measured]**, re-derived from the oklch value the app actually ships, by the same
script that produced the 18-token table and at the same L 4dp / C 5dp / H 2dp. (The source hex
gives 4.562; the shipped value is the one quoted.) Both hexes round-trip exact. The token keeps its
`[contrast]` tag: it is still a deliberate departure from the measured reference palette, now one
that passes.

**Why this stays in the log after the number is fixed.** The token carried `[contrast]` because
somebody had *already* found this exact problem and *already* lightened it once — `#848484` →
`#a3a3a3` — then stopped 0.044 short and recorded "4.6:1" in a comment. The comment asserted a pass;
the arithmetic was a fail; and it survived exactly as long as the comment was trusted instead of
recomputed. **Two of the other three ratios in that same comment block were also wrong.** The rule
is re-derive, never trust an annotation: `docs/research/oklch-tokens.md` §4 has the full account and
every ratio, including `#848484`'s rejected value re-deriving to **3.005:1**, which matches what was
recorded.

**Not verified: `#a5a5a5` has not been looked at.** The arithmetic is checked; "visually
indistinguishable from `#a3a3a3`" is the owner's judgement, not a comparison against the reference
screenshot. And the pixel on screen will be the **Display P3 conversion** of `#a5a5a5`, not
`#a5a5a5` — the sidebar is the vibrancy-dependent surface and the least predictable one to eyeball.

**Not a defect, checked and dismissed:** `tauri.conf.json`'s `"targets": "all"` was reported as
falsely claiming cross-platform support. It does not. **[measured]** — on this machine that setting
produced only `target/release/bundle/macos/brigadier.app` and
`dmg/brigadier_0.1.0_aarch64.dmg`; no `.deb`, `.msi` or AppImage. `"all"` is host-scoped, meaning
every bundle format for the platform being built on. Leave it alone.

## 6. Corrections to existing research

- `docs/research/long-sessions.md` says rate limits are "per model class" with separate buckets per
  model. The measured `rate_limit_event` frame carries `unifiedWindows` with only `five_hour` and
  `seven_day`. **Stale.**
- `docs/research/agent-sdk.md` says `Stop`'s output is `additionalContext?` and the conversation
  continues. Measured otherwise: the bounce comes from **top-level `decision`/`reason`**, not from
  inside `hookSpecificOutput`. **Wrong.**
- **`result.total_cost_usd` is cumulative across `result` frames within a run.** Summing them
  double-counts. Any cost table built by adding `result` frames is wrong; verify against
  `cacheReadInputTokens`, which is monotonic.
- **One user message can produce N `result` frames** — N=4 measured on `f-b-fanout`, from a single
  `type:"user"` frame — because a finished background subagent makes the CLI run a turn the harness
  never sent; `system/init` and `result` then alternate one-for-one in 14 of the 16 captures, the
  other two being `s7-kill` (an `init` with no `result`) and `s7-can-use-tool-write` (neither).
  `docs/research/async-subagent-results.md`.
- `docs/vision.md` §6 originally claimed fan-out pays N equally-sized worker windows plus a
  coordinator. **Wrong**: a subagent's window is 42% *smaller* than a harness-spawned child's.
  Corrected 2026-09-02; the conclusion survived, the mechanism did not.
- `docs/research/agent-sdk.md` documents an SDK the harness does not use. Rust speaks the CLI's
  control protocol directly. Read it for wire shapes, never as an instruction to add a dependency.

## 7. Dead ends — do not rebuild these

- **The handoff wall** (refuse `send_turn` past 700k) was dropped at `a415bb9` and must not be
  rebuilt. Two independent reasons: `docs/vision.md` removes the accumulating session so it could
  never fire, and it was counting the wrong number anyway — `modelUsage` is cumulative across turns,
  so summing the four counters gives lifetime spend, not context footprint. It would have fired
  after ~7 turns on a session using 100k of a 1M window. `context_status` survives as telemetry.
- **A codebase index.** See `docs/research/codebase-index.md` and `docs/vision.md` §7.
- **The installable CLI** — `brigadier install`, CLAUDE.md `@` imports, hook entries in
  `.claude/settings.json`, `~/.brigadier/handoffs/`. Deleted with `brigadier-guide.md` on
  2026-09-02; recoverable at `2327bb9`.
- **A Node sidecar.** Deleted 2026-09-02. The bun recipe survives in
  `docs/research/sidecar-spike.md` if it is ever needed again.

## Landmines already paid for (do not rediscover)

- macOS Cmd-Q → `RunEvent::Exit` only; `ExitRequested` never fires. Shutdown runs in the `Exit` arm.
- `#[tauri::command]` functions must be `pub(crate)` with crate-unique names.
- A `Channel::send` after a webview reload is silently dropped; the front end re-subscribes.
- An `Envelope` with `raw` is ~4.3 KB; signals go out with `raw` stripped; every message < 8,000 B.
- The FPS meter's `hz` must snap to 120/60/30.
- A process group outlives its leader; liveness is by group enumeration; never kill on a
  start-time mismatch. `USER` must survive in the child env; `CLAUDE_CONFIG_DIR` is the account
  boundary, never `HOME`.
- `system/init` arrives **once per turn**, so a resumed session stays `starting` until the first
  turn is sent; `turn-started` can precede `session-started` on the signal stream.
- `hook_callback` frames are answered without an event; hook evidence is
  `decision_reason_type:"hook"` on the next `can_use_tool`. The CLI's built-in read-only Bash set
  (`ls`, `cat`, `echo`, …) never prompts without the hook's `ask`.
- The model may try to `Write` a memory file under `~/.claude/projects/<key>/memory/` on a
  "remember X" prompt; the hook gates it, and a live test must auto-deny it or hang 600 s.
- `feed`'s insert is `ON CONFLICT(session_id, seq) DO UPDATE`: any second writer on a row must
  be seeded past `last_event_seq` or it rewrites history silently.
- `git worktree remove` without `--force` deletes gitignored files and exits 0;
  `status.showUntrackedFiles=no` blinds `--porcelain`. Every git call sets `LC_ALL=C` and
  `-c status.showUntrackedFiles=normal`. A failed `worktree add` leaks its branch on 2.50.1.
- `git rev-parse --git-common-dir` is relative to the `-C` directory. `check-ref-format --branch`
  exits 128 on a bad name. A throwaway repo for a live test needs an initial commit.
- The store's `cost_usd_cumulative` written before `b2c1a4c` under-reports resumed sessions.
- The batcher prunes a session's counters once it saw it start and exit; a resumed session's
  `rows_total` on the wire restarts from zero.
- `crates/proc/tests/orphans.rs` `a_kill_takes_down_the_whole_group` flaked once on 2026-09-02
  (process-group kill timing); passed on every rerun.
- **Tailwind's oxide scanner walks the filesystem, not the module graph, and it reads Markdown.**
  Naming a utility class **in prose** ships it: our own `docs/` emitted 1.44 kB of rules nothing
  renders. `docs/research/oklch-tokens.md` §6. **The remedy has changed and the old one is gone, not
  moved**: the `@source not "../docs"` blacklist failed silently twice (`docs/` prose, then
  `crates/proc/src/pidfile.rs` shipping `.container` for weeks), and a `source("../src")` whitelist
  still left six `.container` rules alive, re-emitted from a comment and from Testing Library's own
  `view.container`. What ships is `@import "tailwindcss" source(none)` plus explicit `@source`
  directives with test files excluded (`src/index.css:82-84,98`, `864a2fe`), gated by
  `src/index.css.test.ts`. The trap was never which directory: **prose and test code are not
  markup.**
- **An edit to a tree-shaken export moves the bundle by zero bytes**, which is indistinguishable
  from a build that did not run. `beginInteraction` in `src/paint.ts` was in that state until
  `a0901e5` gave it its one importer (`src/App.tsx:351`); nothing in `src/` is known to be in it
  today, which is not the same as nothing being in it. Check a string literal the minifier cannot
  rename, never an identifier. `docs/plans/ipc-contract.md`, `### report_paint`.
- **jsdom 30.0.1 has no `PerformanceObserver`**, and what stands in for it under Vitest is Node's
  `perf_hooks` observer, whose `observe({type:"paint"})` **does not throw and never fires** — a test
  written against it passes vacuously. `src/paint.test.ts` stubs its own. jsdom also has no
  `window.matchMedia` at all. `src/paint.test.ts:10-18`, `src/providers/ThemeProvider.test.tsx:16`.
- **A contrast ratio is a property of a *pair*, not of a colour.** `--color-bad`'s comment certifies
  5.84:1 — its ratio on `--color-thread-bg`. A new rule used that same token at 11 px on
  `--color-sidebar-bg` and shipped **3.699:1**. Sweeping all 48 pairs against the ground each rule
  actually paints on found **six more failures, five of them in new hover and selected states** —
  grounds that did not exist when any token was measured. So: a token comment certifies **one**
  pairing and says nothing about any other, and **every interactive state is a new ground that needs
  its own derivation**. Non-text graphics are checked against WCAG 1.4.11's 3:1, not 4.5:1.
- **A launch is not zero-`claude`.** Each one spawns `claude --version` **twice** — once from
  `setup`, once from the frontend's mount-time `probeClaude` (`src-tauri/src/state.rs:180`). No
  session, no API call, no cost. Worth knowing before auditing spend from a process list.
- A `**[measured]**` tag inside a **Rust doc comment** is parsed as an intra-doc link and fails
  `cargo doc`. The tree's Rust convention is the bare `**measured**`
  (`crates/core/src/worktree.rs:76`); the bracketed form is markdown-only.
- **`pgrep -fl claude` is not evidence that no child ran.** It matches the operator's own Claude
  Code sessions, Pen's `mcp-server-*` processes and any shell whose command line merely contains
  the string. Use `pgrep -x claude` and set-diff before against after: **the set not changing is
  the proof, not the set being empty** (`flood-baseline.md` §6, `launch-signposts.md`).
- **A measured dead end can be re-proposed from a code reading and reach a dispatched order.** On
  2026-09-03 an order to move store reads onto a second SQLite connection was issued from a reading
  of `writer.rs:329-335` and withdrawn the same day (`4fc02e1`); the measurement that killed it was
  already written — `docs/research/perceived-performance.md` §2.3 and trap 5, **8.03 ms** worst-case
  read hold at 10 sessions × 2000 rows/s, revisit only if `feed_cap` grows by an order of magnitude.
  Read that file's trap list before ordering any store change.
- **The dev burn writes synthetic sessions into whatever data directory the app is pointed at,
  including the owner's real one.** The 2026-09-04 burn runs went into
  `~/Library/Application Support/ai.brigadier.app/brigadier.sqlite`, which now holds a **`burn`
  project with 40 synthetic sessions** beside **3 real ones** under `brigadier-ai`, and
  `frame-stats.ndjson` grew from 1,686 to **2,080** lines. **[measured]** (read-only `sqlite3` and
  `wc -l`, 2026-09-04). **Nothing was billed** — `pgrep -x claude` was byte-identical before and
  after (`docs/research/visual-checks-2026-09-04.md` §0). Remedy: point the burn at a scratch data
  directory, or expect to prune afterwards. **The rows are not deleted and deleting them is the
  owner's call, not made.** Any citation of a window count in `frame-stats.ndjson` must now say which
  slice it means.


