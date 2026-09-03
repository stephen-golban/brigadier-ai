# STATUS — where the brigadier harness actually stands

Last updated 2026-09-02. **This is the file to read first.** It says what is built, what is proven,
what is broken, and what will bite you. The product it is building toward is `docs/vision.md`.

No invented progress. A feature "works" only after it has been run. One line per fact, a path or a
number instead of an adjective, and what was not checked is said outright.

---

## 1. The tree right now

`main` at `3e5c3fd` ("style: the measured palette becomes oklch tokens on Tailwind 4"), plus the
commit carrying this file, which changes documentation only. **The working tree is otherwise
clean.** Nothing is staged and nothing is pending the owner's approval.

Everything that was uncommitted at `2327bb9` has since landed or been dropped:

- `crates/core/src/wall/` (the Bash classifier) is committed at `21d2375`.
- the fixtures `crates/claude-spike/fixtures/s8-*`, `s9-*`, `s10-*` (12 NDJSON captures) are committed.
- `crates/supervisor/src/handoff.rs` never reached a commit and no longer exists on disk; the handoff
  wall was dropped at `a415bb9`. `git log --oneline -1 -- crates/supervisor/src/handoff.rs` prints
  nothing. See §7.

**Most numbers below were measured at `2327bb9` and nobody has re-measured them.** Only §3's gate
figures are `3e5c3fd`. Anything else that says "measured" was measured at `2327bb9` unless it cites
one of the `s8-*`/`s9-*`/`s10-*` fixtures or names a later commit.

## 2. Built, and what proved each row

The evidence column's *kind* varies, so read it before quoting a row. `f1b911f`, `b2c1a4c` and
`8351335` are live runs against a real `claude` 2.1.258 child. `crates/proc/tests/`,
`crates/core/tests/claude_adapter.rs` and the five front-end suites under `src/` are test suites in
this tree, not live runs.
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
| the app can time its own paints | `1c8b6f6` | 24 tests, `src/paint.test.ts`, and a build. `src/paint.ts` observes `first-contentful-paint` and reports it over `report_paint` (`docs/plans/ipc-contract.md`). Since run for real: `paint.ndjson` works end to end in a real window and `main_to_fcp_ms` matched its own `tracing` line on all 19 runs (`docs/research/perceived-performance.md` §1.4). **The interaction half has still never run** — `beginInteraction` has no caller anywhere and is tree-shaken out of the bundle, so B4/B6/B7 are untouched. |
| the measured palette as oklch `@theme` tokens | `3e5c3fd` | 18 of 18 colour tokens round-trip hex→oklch→hex bit-exact and all 8 annotated contrast pairs re-derive to within 0.0017, verified twice independently (`docs/research/oklch-tokens.md`, and `frontend-stack.md` §2.6 arrived at the same ratios first). Unit tests and a build only — **nothing has been looked at in a running window.** |
| the shell, and the first interaction timed | `a0901e5` | 28 new tests (`src/App.test.tsx` 10, `src/components/Sidebar.test.tsx` 18) plus a real window: the sidebar, project collapse and session selection were **driven by hand**, and 14 selections were timed through `beginInteraction` into `paint.ndjson` (**B4**, §4). `ThemeProvider` is now mounted (`src/main.tsx:22`). Seven AA failures were found and fixed in the process — see the landmine below. |

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
resolved, so `pending_approvals` returns empty and the dock never opens. That is still the largest
thing unverified about the token layer, and only a live approval closes it.

## 3. Gates at `a0901e5`

All six run by the lead under its own hand, exit codes captured directly:

```
cargo test --workspace                                exit 0  283 passed, 0 failed, 5 ignored
cargo clippy --workspace --all-targets -- -D warnings exit 0  0 warnings
cargo doc --workspace --no-deps                       exit 0  0 warnings
npm test                                              exit 0  94 passed, 5 files
npx tsc --noEmit                                      exit 0
npm run tauri build                                   exit 0  .app + .dmg
```

The 94 are `feedStore.test.ts` 27, `paint.test.ts` 24, `components/Sidebar.test.tsx` 18,
`providers/ThemeProvider.test.tsx` 15 and `App.test.tsx` 10.

Bundle at `a0901e5`: **272.71 kB JS + a 1.38 kB lazy chunk / 26.91 kB CSS**, from 263.28 / 21.89 at
`3e5c3fd` and 262.69 / 12.69 at `ad5a4a7`. The JS figure now includes the interaction half of
`src/paint.ts`, which `a0901e5` gave its first importer; before that it was tree-shaken out and the
263.28 kB figure was the FCP half alone (`docs/plans/ipc-contract.md`, `### report_paint`). The CSS
growth from 12.69 is almost entirely Tailwind preflight — the token layer itself was **+0.54 kB**,
and Tailwind adds **zero** JS (`docs/research/oklch-tokens.md` §5). The earlier `~258 kB JS` line is
superseded.

**One warm FCP sample at `a0901e5` came back at 375.9 ms**, against the 287–295 ms p50 (n=19)
recorded at the smaller bundle. One sample against a distribution, and the same run's cold launch
(801.9 ms) matches an earlier cold outlier (755.9 ms), so the regression is **neither attributable
to the bundle growth nor ruled out**. Re-running the n=19 three-arm treatment
(`docs/research/perceived-performance.md` §1.4) is what would settle it. B1's figure is unchanged.

The 5 ignored are the live tests. Run one at a time:

```
CLAUDE_BIN="$(command -v claude)" cargo test -p brigadier-supervisor --test <name> -- --ignored --nocapture
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
| window refresh rate | 60 Hz over 1,513 one-second samples | same |
| search results, median | 127 tokens (8.2% of tool tokens; `Read` is 73%) | `codebase-index.md` |
| whole-repo symbol map rebuild | 145 ms | same |
| raw NDJSON on this machine | 66 MB / 23 sessions | `worktree-cleanup.md` |
| provider transcripts on this machine | **3.0 GB** | same |

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
  renders. `@source not "../docs"` in `src/index.css:27` is the guard; delete it and all eight come
  back. `docs/research/oklch-tokens.md` §6.
- **An edit to a tree-shaken export moves the bundle by zero bytes**, which is indistinguishable
  from a build that did not run. `beginInteraction` in `src/paint.ts` is in that state today. Check
  a string literal the minifier cannot rename, never an identifier.
  `docs/plans/ipc-contract.md`, `### report_paint`.
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


