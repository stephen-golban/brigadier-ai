# STATUS — where the brigadier harness actually stands

**2026-09-09: docs cleanup.** 43 superseded markdown files deleted (41 SUPERSEDED + 1 MISLEADING
`heroui-assistant-ui-redesign.md` + `worktree-defects.md`, merged first);
six measurements moved out of them before deletion — two rows into §4 (checkpoint capture
primitives, sidebar geometry), the picker dead end into §7, the `set_decorations`/`set_resizable`
ordering defect into the landmine list, the worktree re-measurements into §5 item 3 / §6 and
`docs/research/worktree-cleanup.md` §1.19, and the safe-Rust primitives table into
`docs/research/git-message-checkpoints-2026-09-05.md`. See git log.

Submission fix: **2026-09-08**. ThreadView now handles assistant-ui optimistic messages without
custom row metadata, fixing the reproduced startup render exception. React error recovery/local diagnostics and visible
submission-pending states added. Peer-created worktrees now use committed HEAD to avoid parent
checkout lock conflicts. See
[evidence and limits](plans/submission-diagnostics-2026-09-08.md).

Session coordination update: **2026-09-08**. Cross-project discovery, session reads, queued messages,
creation, and bounded waits are implemented. See [behavior, verification, and limits](plans/session-coordination-implementation-2026-09-08.md).

Latest desktop update: **2026-09-06**. The confirmed desktop redesign, file-backed Notes,
background session disposal, isolated workspace inheritance/apply, and checkpoint rewind
are implemented. Read [the implementation and verification report](plans/chatgpt-redesign-implementation-2026-09-06.md)
for current behavior, tests, build output and limits. The older sections below are dated
historical records and do not describe the current desktop layout or schema (now version 9).

Historical baseline: last updated 2026-09-04. **This is the file to read first.** It says what is built, what is proven,
what is broken, and what will bite you. The product it is building toward is `docs/vision.md`.

**§§1, 2 and 3 are the freshest sections in this file**: all three were rewritten on 2026-09-04
against a six-gate run at `e0f1375`, after that day's unattended run landed four commits on `main`.
§§4, 5, 6 and 7 were revised earlier the same day against the research files behind them and were
**not** re-derived here, and **§5's "Still open: none" has since gone false** —
`docs/plans/report-2026-09-04.md` §4 and §5 name three defects found today that §5 does not carry,
one of them verified and deliberately not fixed. The landmine list gained one line in this revision
and is otherwise as it was. **Every section is dated by its own text** — read the commit a claim
names before quoting it.

`docs/plans/report-2026-09-04.md` is the lead's own account of that run and is the longer record;
this file does not restate it.

No invented progress. A feature "works" only after it has been run. One line per fact, a path or a
number instead of an adjective, and what was not checked is said outright.

---

## 1. The tree right now

`main` at `e0f1375` ("phase 4.4: the run reaches the window, and Add project opens a real folder
picker"). **[measured]** 2026-09-04. `git status --porcelain` printed **8 lines and every one of them
under `docs/`** immediately before this revision — `docs/plans/ipc-contract.md` and
`docs/research/intent-records.md` modified; `docs/plans/autonomous-run-2026-09-04.md`,
`docs/plans/report-2026-09-04.md`, `docs/plans/w1b-loop-order.md`,
`docs/research/gate-environment.md`, `docs/research/orchestration-loop.md` and
`docs/research/tauri-dialog.md` untracked — and this file's own edit makes nine. **No code is
uncommitted**, nothing is staged, and nothing waits on the owner's approval. **[measured]**

**Two committed commit messages cite files that are not committed.** `31e551f` cites
`docs/research/gate-environment.md` and `docs/research/orchestration-loop.md`; both are untracked
above. **[measured]** Remedy: commit `docs/` alongside this revision, or the citations dangle for
anyone who clones the repository.

The **four** commits after `a889525` are one unattended run's output — seven work orders, six
workers, gated once on the final combined tree rather than per commit (`report-2026-09-04.md` §6.2,
which says so and says why). Oldest first:

- `e4f35fb` phase 4.1 — **the store**. Ten defects a blind review found in the uncommitted W1-A
  plan/progress/intents work, plus two a second adversarial pass found. The four that could have
  cost real work: `upsert_work_order` assigned `state = excluded.state` unconditionally, so a stale
  upsert turned a *finished* order back into a dispatched one and the same work ran twice;
  `phases.base_sha` used `COALESCE(excluded, stored)`, so a later non-null value overwrote the base
  the column exists to pin; `bounded()` on JSON columns appended an ellipsis and produced
  unparseable JSON, `owned_paths_json` — the thing that stops two workers writing one file —
  included; `expire_pending_approvals` wrote an unconditional **denial** for every approval a dead
  process left parked. Migration rung 5 adds `phases.base_sha`; **`user_version` goes to 6.**
  10 files, 4,616 insertions. **[source]**
- `bdc5207` phase 4.2 — **the seams the loop needs from core**. `SessionCommands::final_assistant_text(turn_id)`,
  a slot that outlives the adapter, because none of the three existing channels can carry a fenced
  JSON block: `summarize()` takes the first non-empty line and yields the single character `{`, the
  feed stores one pre-rendered line and no body, and `Envelope.raw` is provider JSON the supervisor
  must not parse. `on_decision` stops emitting `RequestResolved` after a failed `write_frame`.
  `WorkerWall` wired as an **allowlist** — a blocklist was written first and a second-vendor review
  found two holes in it. 9 files, 1,314 insertions. **[source]**
- `31e551f` phase 4.3 — **the loop**. Until this commit the only production caller of
  `Supervisor::start_session` was a Tauri command behind a button; nothing in the app started work
  by itself. `verify.rs` (the gate runner), `action.rs` (the strict action schema), `loop_/` (the
  machine). **Proven live once on a throwaway repository** — see §2's row and §3. 16 files, 7,965
  insertions. **[source]**
- `e0f1375` phase 4.4 — **the run reaches the window**. A native directory picker behind
  `Add project`; `tauri-plugin-opener` given the job it was registered for; the run surface and the
  pinned plan card; `start_run`, `current_run`, `stop_run`, `unsettled_intents`, `settle_intent`,
  and the reconciler. 24 files, 4,656 insertions. **Not clicked in a real window** — the commit
  message says so itself. **[source]**

**What is still load-bearing from the seven commits after `1b18909`**, which this section listed in
full until this revision and no longer does:

- `dc52f07`'s `docs/research/intent-records.md` was **design only, unimplemented**. That changed:
  `e4f35fb` implements the `intents` table and the settlement policy, and `bdc5207` closes the gap
  the document named — `respond` writing the decision to stdin and emitting `RequestResolved`
  whether or not the write landed. The document is **modified and uncommitted** in the tree above,
  and `report-2026-09-04.md` §5.1 and §5.2 record two of its claims that have gone false.
- `10c123f`'s `docs/research/thinking-control.md` stands unchanged: the CLI starts every session at
  thinking `{type:"adaptive"}`, so a `claude-haiku-4-5` child thinks although `build_argv` asks for
  nothing. Read out of the 2.1.260 binary; **no live request was made.** **[source]**
- `e780fbd`'s `ThinkingPolicy` (`Off` \| `Inherit`, `Off` the default) is now used by the loop:
  `crates/supervisor/src/loop_/dispatch.rs:341` maps Haiku and Sonnet tiers to `Off` and Opus to
  `Inherit`, and the planner and the ladder's judgement calls opt back in
  (`loop_/plan.rs:123`, `loop_/ladder.rs:85`). **[source]** Still **not measured: that the CLI turns
  thinking off in response** — the child's environment is pinned by tests and only a live run
  settles it. **`crates/claude-spike` still builds its own `Command` and does not pick this up.**
- `f807e0e`'s bundle figures (**274.87 kB JS / 27.11 kB CSS**) are the baseline §3's new numbers are
  measured against. `c884767`'s WKWebView confirmation of that commit's layout fixes is quoted in
  §5 and is unaffected by today's work — **and the CSS it confirmed has since grown 449 lines**
  (`e0f1375`, `src/index.css`), none of it looked at.
- **`crates/supervisor/src/handoff.rs` still does not exist on disk** and
  `git log --oneline -1 -- crates/supervisor/src/handoff.rs` still prints nothing; the handoff wall
  was dropped at `a415bb9`. See §7. **[measured]** 2026-09-04.

The "everything uncommitted at `2327bb9`" paragraph is **retired**: nothing in this file rests on it
any longer. Its three bullets were last re-checked and found literally true on 2026-09-04 (the Bash
classifier committed at `21d2375`; 12 `s8-*`/`s9-*`/`s10-*` NDJSON fixtures under
`crates/claude-spike/fixtures/`, `git ls-files` counting the same 12). **The "36 commits gone"
figure that paragraph carried was wrong** — 36 was the `3e5c3fd` distance, not `2327bb9`'s.
`git rev-list --count 2327bb9..HEAD` is **63** and `3e5c3fd..HEAD` is **41**. **[measured]**
2026-09-04.

**"Measured at `2327bb9`" now covers four rows and nothing else.** §3's gate figures are `e0f1375`.
§4 carries rows measured on 2026-09-03 and 2026-09-04 that name their own commits —
`spawn-split.md`, `perceived-performance.md`, `flood-baseline.md` at `c78a089`,
`visual-checks-2026-09-04.md` at `1b18909`. The fallback still covers only the four undated rows at
the foot of §4's table: search-results median, whole-repo symbol map rebuild, raw NDJSON, provider
transcripts. **None of §4 was re-measured today**, and the bundle has grown 14.8 kB since the launch
numbers in it were taken.

## 2. Built, and what proved each row

The evidence column's *kind* varies, so read it before quoting a row. `f1b911f`, `b2c1a4c` and
`8351335` are live runs against a real `claude` 2.1.258 child; **`31e551f` is the fourth and the
only one where brigadier started the work itself**. `crates/proc/tests/`,
`crates/core/tests/claude_adapter.rs` and the **ten** front-end suites under `src/` — `App`,
`components/Feed`, `components/RunCard`, `components/Sidebar`, `feedStore`, `index.css`, `mock`,
`paint`, `providers/ThemeProvider`, `run`, counted 2026-09-04, up from seven — are test suites in
this tree, not live runs. (`providers/ThemeProvider` was deleted 2026-09-10 with the light theme;
the 2026-09-04 count is left as counted.) `docs/research/persistence.md` and `feed-rendering.md` are research
documents — a document, not a run. `7f03eb5` cites nothing at all. **No row is a live-`claude`-child
proof unless its evidence says so, and exactly four rows say so.**

**Nothing added on 2026-09-04 has been seen in a window.** Every row below dated today is tests plus,
in one case, a Rust integration test that drove a live loop with nobody looking at the UI.

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
| MCP off by default, per-project opt-in | `9ca7ee2` | `McpPolicy` (`off` \| `inherit`) in `crates/core/src/driver.rs`; `--strict-mcp-config` pinned in the argv tests of `crates/core/src/claude/process.rs`; store migration 2 (`user_version` 2 to 3, `projects.mcp TEXT NOT NULL DEFAULT 'off'`), which **switched every existing project to `off` on 2026-09-03**, the owner's two live projects included, and each can opt back in per project; supervisor passes the project row's policy on start and on resume (`crates/supervisor/src/lib.rs`, recording-driver test); command `set_project_mcp(project_id, mcp)` and `ProjectView.mcp` (`docs/plans/ipc-contract.md`). Tests only, no live child: the `mcp_servers: []` proof is `spawn-split.md` §1. **Both migrations have now run on the owner's own data directory, not only on tempdir replicas** — **[measured]** 2026-09-04, read-only against `~/Library/Application Support/ai.brigadier.app/brigadier.sqlite`: `PRAGMA user_version` is **3**, both live projects read `mcp='off'`, and all **10,037** pre-migration feed rows read `kind='unknown'` with none reading `'sys'`, so migration 1's corrected default (`959bd0c`, fixed at `1d23df9`) landed on real data and no row has been written since. **The tree's ladder is now 6, not 3** — `MIGRATIONS` gained rungs 3, 4 and 5 (`intents`, `unknowns`, `phases.base_sha`) and the owner's file is still **3 on disk**, re-confirmed read-only 2026-09-04: 2 projects, 44 sessions, 1 approval, resolved *with* a decision. **[measured]** The first launch after `e0f1375` migrates it 3 → 6 and an older binary then refuses it; see the landmine list. The replica tests remain the only *proof* of behaviour (`crates/store/src/schema.rs::migration_2_switches_a_pre_existing_project_to_off`, `crates/store/tests/schema.rs`); nothing records which projects were switched and which chose, so render `off` as a state, not a decision. **The UI toggle is not built**; nothing in `src/` calls `set_project_mcp` — grepped 2026-09-04. |
| the shell, and the first interaction timed | `a0901e5` | 28 new tests (`src/App.test.tsx` 10, `src/components/Sidebar.test.tsx` 18) plus a real window: the sidebar, project collapse and session selection were **driven by hand**, and 14 selections were timed through `beginInteraction` into `paint.ndjson` (**B4**, §4). `ThemeProvider` is now mounted (`src/main.tsx:22`). Seven AA failures were found and fixed in the process — see the landmine below. |
| the feed reads as a thread, not a log table | `864a2fe` | the timestamp column, the raw `seq` column and the zebra stripes are gone; 13 px sans at `ROW_H` 28, a rule at clock-minute boundaries only, zero accent at rest, and a 1.4.11 failure on the jump pill's border (1.585:1) fixed on the way. `src/components/Feed.test.tsx` and `src/index.css.test.ts` are new suites; the second gates that every class in markup has a hand-written rule. **Nothing here has been seen rendered**, and the blur test that decides whether it answers the owner's "year 1999 app" verdict has not been run. Those test counts and CSS figures have since been re-run — the six gates at `c884767` on 2026-09-04 give `src/components/Feed.test.tsx` **20** and `src/index.css.test.ts` **8**, inside 137 across 7 files, and CSS **27.11 kB** **[measured]**; §3 carries the run. |
| the launch decomposed stage by stage, and the page half split | `6db9f6e`; the `dcl` stage at `8293342` and `62e6717`; the numbers at `8b286f5` | `BRIGADIER_TRACE=1` signposts in `src-tauri/src/trace.rs`, 12 warm launches on 2026-09-03 plus 5 more (1 cold, 4 warm) on 2026-09-04 after the `dcl` stage landed. Measured, not inferred: `state::build` inside `setup` is **8.1 ms** p50, not the missing ~100 ms; Tauri's own window creation before our setup closure, `builder_built` to `setup_entry`, is **108.7 ms** p50 warm and **420 ms** cold, so a cold launch is slow there and not in the page; `page_load_finished` to FCP, 83.3 ms undivided, splits into **49.6 ms** fetch plus parse and **28.5 ms** React mount plus render, so the scheme-plus-brotli attribution has a 49.6 ms ceiling and not a 100 ms one. `RLIMIT_NOFILE` is now raised at startup (launchd hands a GUI launch **256**). `docs/research/launch-signposts.md`. **Caveats that matter, and every one of them qualifies a number above it:** (a) **every 2026-09-04 figure was taken with the display locked** (`CGSSessionScreenIsLocked=1`), and that run's exec → FCP of **288.8 ms** landing inside the established 287–295 ms band is **weak evidence that the lock did not move FCP, not proof**; (b) the **28.5 ms mount half is n=4 with a 60.0 ms outlier** against a 23–29 cluster, and both its endpoints are page-relative timestamps clamped to 1 ms — **do not plan against 28.5**; the **49.6 ms fetch-and-parse half is the tight one** (four samples inside 1.5 ms) and the 64/36 verdict rests on it; (c) the `RLIMIT_NOFILE` raise was verified **under a simulated `ulimit -n 256` from a shell, never from an actual Finder launch** — `launchctl limit maxfiles` of 256 is the evidence that the Finder case needs the raise, and the Finder case itself has never been run with stderr captured; (d) no run used a cold OS file cache (`sudo purge` needs sudo); (e) nothing here is a p95 — n=12 warm and n=4 for the split. |
| **the loop — brigadier spawns a child on its own initiative** | `31e551f` | **The only row in this file behind which there is a live end-to-end run brigadier began by itself.** One plain-English goal in, two `--no-ff` phase commits out, no human in the loop, `claude-haiku-4-5`, on a **throwaway repository the test creates in a tempdir** — not this repo and not the owner's projects. **[measured]** 2026-09-04: the planner produced **2 phases**, each with `sh verify.sh` as its verify command; phase 0 "Create greet.sh" gate exit **0** commit `db80cecf`, phase 1 "Create NOTES.md" gate exit **0** commit `7a279774`, **1 attempt each**; one work order per phase, each in its own worktree on its own branch (`brigadier/6c0dc883`, `brigadier/7a0e1847`); the scratch repo's `main` reads `Phase 2: Create NOTES.md` / `brigadier: brigadier/7a0e1847 into Phase 2` / `Add NOTES.md describing greet.sh` / `Phase 1: Create greet.sh` / `brigadier: brigadier/6c0dc883 into Phase 1` / `Add greet.sh shell script` / `init`; `sh verify.sh` in the project root afterwards exits **0**. **Cost $0.192433**, read from the **store rows** (`cost_usd_cumulative`, one per session) across **5 sessions and 6 ticks** — never by summing `result` frames, which are cumulative. 106.04 s, test exit 0. `pgrep -x claude` **byte-identical before and after** — no child left behind. **What it does not prove, and this is the larger half:** the run was driven **tick by tick from a Rust integration test** (`crates/supervisor/tests/live_loop.rs`), **not through the UI** — nothing in it was clicked. It is **n = 1**: two phases, a trivial goal, one shell script as the gate; it says nothing about a real project, a red gate in the wild, a worker that parks on an approval, or a restart mid-flight. **The rung-1 fixer has never fixed anything live** — the red-gate ladder is tests only. **Four of the five sessions ended `failed` with signal 143**, which is the loop killing its disposable children and is expected, but the session rows read `failed` for children that did their job and will look wrong in the sidebar. Tests beside it: `crates/supervisor/tests/loop_spine.rs` **20**, plus **45** inline across `crates/supervisor/src/loop_/` (`state` 9, `barrier` 6, `git` 6, `green` 6, `ladder` 6, `dispatch` 5, `plan` 5, `call` 2, `mod` **0**) — counted by grepping `#[test]`/`#[tokio::test]`, **[source]**, not a per-suite run. |
| the gate runner — a real exit code, not a model's opinion | `31e551f` | `crates/supervisor/src/verify.rs`, **15** inline tests **[source]**. `sh -c` with **null stdin** so an interactive prompt EOFs rather than wedging the run; stdout and stderr interleaved into one file and never through a pipe; `ExitStatus` read from the child; `code() == None` is red, never green; **127 gets its own slug**, because a plan naming a command this machine lacks is a plan defect and must not read as "the code is broken"; `pipefail` probed rather than assumed, since a blanket prefix turns a green gate red under a dash `sh`; timeout kills the process group. The PATH is resolved deliberately rather than inherited — measured, not defensive: a Finder-launched app gets `/usr/bin:/bin:/usr/sbin:/sbin`, in which **`cargo` and `npm` are both missing** (`docs/research/gate-environment.md`, **untracked**). Green in the live run above; **never run against a red gate live.** |
| the action/report schema and the ownership validator | `31e551f` | `crates/supervisor/src/action.rs`, **32** inline tests **[source]**. Read **strictly** — the opposite of the store's lossy slug convention, because an unrecognised stored value must degrade safely while an unrecognised action must never execute; unknown fields are an error. Ownership is disjoint **by path component, never by string prefix**, so `src/a` and `src/ab` do not collide; an overlapping partition is refused and never repaired, naming which two orders collide on which path. `review` and `replan` validate but do not execute and **block the phase by name** rather than being silently ignored. Tests only. |
| `WorkerWall` — the tool wall an unattended worker runs behind | `bdc5207` | `crates/core/src/claude/hook.rs` (**14** inline tests), `crates/core/src/wall/bash.rs` (**24**), `crates/core/src/wall/tables.rs` **[source]**. It is an **allowlist** and the direction is the point: the wall fails open, so a blocklist's bug is a silent missing refusal while an allowlist's bug is a parked order. A blocklist shipped first and a second vendor found two holes — `cargo test` classifies `Unknown`, not `Mutate`, so it would have parked every worker on its first build; and `git push` is not in `GIT_REMOTE_MUTATE_SUBCOMMANDS`, so the escape check missed the escape it was named for. Both confirmed live before the rewrite. Two guards catch what the classifier cannot: `git` carrying `-C`/`--git-dir`/`--work-tree`, and any rooted path — **including the value after an `=`** — that does not resolve inside the worktree; `GIT_WORK_TREE=/tmp/victim git reset --hard` and `cargo test --target-dir=/tmp/out` both returned `allow` before that. **It is not a sandbox and its rustdoc says so**: the guard reads a command's arguments, not its redirection targets, so `cat </etc/passwd` reads outside the worktree without asking, pinned by a test so the next reader finds it rather than discovers it. The isolation is a git worktree — a containment property (`docs/vision.md` §11). |
| a turn's full final assistant text | `bdc5207` | `SessionCommands::final_assistant_text(turn_id)` (`crates/core/src/session.rs`), bounded, keeping the **tail** because the fenced JSON block is at the end. None of the three existing channels can carry one: `ItemCompleted.summary` runs through `summarize()`, which takes the first non-empty line, so a JSON block arrives as the single character `{`; the feed stores one pre-rendered line and no body; `Envelope.raw` is provider JSON `crates/supervisor` must not parse. **Deliberately not a `Command` variant** — the adapter's run loop exits on child shutdown, so a command-channel read would answer "session is closed" for exactly the one-turn disposable child whose answer the loop reads *after* it exits. The slot outlives the adapter. Tests in `crates/core/tests/claude_adapter.rs` (**26** `#[test]`/`#[tokio::test]` markers there now, up from **20** at `a889525` **[source]**); it also carried the live run above. **Open, verified, not fixed:** `crates/core/src/claude/adapter.rs:1284-1286` (`close_turn_text`) files a turn's accumulated text under whichever turn is *closing*, so across a pre-emption a continuation's text can be returned as another turn's final answer **silently** — the `NotHeld` guard does not fire because the id matches. Not reachable by this loop (a pre-emption needs a second `SendTurn`, and every child the loop spawns is one turn and disposable), so the safety rests on a rule and not on the code. `docs/plans/w1b-loop-order.md` §7.8 has the cheap fix. |
| approvals stop reporting a decision that never landed | `bdc5207` (core), `e4f35fb` (store) | Two lies, both fixed. `on_decision` warned on a failed `write_frame` and then emitted `RequestResolved` **unconditionally**, so the dock showed as landed a decision the child never heard; it now emits a `RuntimeWarning` naming the request and no resolution, and the request expires undelivered, which is the truth. `expire_pending_approvals` wrote an unconditional **denial** for every approval a dead process left parked, so after a crash the dock could say "denied" about a tool that ran; it now writes `decision_json = NULL`, and a resolved row with no decision is a third state, `ApprovalOutcome::Expired` — *neither allowed nor denied* (`crates/store/src/schema.rs`, the column's own comment: "Never written as a deny"). **No UI ever displayed the false denial**: `crates/supervisor/src/wire.rs:138` is `resolved: record.resolved_at.is_some()` and nothing else, and the front end has no field for a stored decision **[source]** — it was in the stored row waiting for its first reader, which the plan card would have been. `docs/vision.md` §9 is the authority. The owner's one real approval was checked and is resolved **with** a decision, so nothing retroactive needed correcting **[measured]**. **The dock itself still has never been driven.** |
| the plan, phase, work-order and intent tables | `e4f35fb` | `crates/store/src/plan.rs` (**8** inline) and `intents.rs` (**12**), `crates/store/tests/plan.rs` (**11**) and `tests/intents.rs` (**16**) **[source]**. Migration rung 5 adds `phases.base_sha`; `user_version` → **6**. `unsettled_intents` means "every intent a human still has to decide about" and excludes `acked` and `operator`; without that it listed every order the loop ever dispatched, because a work order is held to `unknown` on **every** close including a live one — the plan card would have offered the owner a list of everything that worked and a reconciler would have blocked every phase that ever ran. `Op::IntentSettledByOperator` exists because the card's *mark done / mark not done* wrote through `intent_close`, whose `state = 'open'` guard rejects exactly the `unknown` rows the button exists for: it did nothing and returned success. Three tests that were decorative are now real and each was measured failing against the code it names; **two more could not be made non-decorative and say so rather than pretend**. **Known and not decided:** `sweep_settled` deletes only `done`/`not_done`, so **every `work_order` row is unsweepable by construction** — `report-2026-09-04.md` §5.1 puts that at ~48 rows/hour, ~**84 MB/year** of continuous running against a 200 MB warning threshold, and it falsifies the premise `intent-records.md` §6 rests on. Tests only, plus the live run's own rows. |
| a native directory picker behind `Add project` | `e0f1375` | `tauri-plugin-dialog`; the capability grants `dialog:allow-open` and **not** `dialog:default`, because `open` is the only import from that plugin anywhere in `src/` (`src-tauri/capabilities/default.json`, `src/bridge.ts:14`). The typed absolute-path field is kept as the fallback for the mock bridge and the tests. **It inverts the usual warning**: a *misspelled* permission identifier fails `cargo check` with exit 101 from `tauri-build`, measured; only an *omitted* one is the silent runtime failure. `docs/research/tauri-dialog.md`, **untracked**. Covered by `src/components/Sidebar.test.tsx` and `src/mock.test.ts`. **Never clicked.** |
| reveal a project root or a session worktree in Finder | `e0f1375` | `revealItemInDir` from `tauri-plugin-opener` (`src/bridge.ts:186`), which was registered at startup and had **never been called from `src/`** — a dead dependency until this commit. A session whose `worktree_path` is null gets **no control at all** rather than a disabled one: a disabled button says "there is a folder here, you just cannot have it", which would be a lie (`src/components/Sidebar.tsx:254,281,562`). Tests only. **Never clicked.** |
| the run surface and the pinned plan card | `e0f1375` | `src/components/RunCard.tsx` (255 lines), `src/components/Composer.tsx`, `src/App.tsx`; `src/components/RunCard.test.tsx` **18**, `src/run.test.tsx` **8**, `src/mock.test.ts` **17** **[source]**. A goal in plain English starts a run from the composer and the card is pinned above the thread so it never scrolls away — `docs/vision.md` §9 requires that nothing the owner steers with ever does. Four rules the card encodes, each a decision and not styling: a phase with no verify command is marked as unable to go green through a gate, never given a placeholder; the gate's exit code is drawn and its output never is; a work order at `unknown` is drawn as **blocked-needing-a-decision** and never as in progress, because the bare word reads like "still finding out" and means the opposite; and **no dollar figure appears anywhere**, pinned by a test that greps the serialised shapes. The front end was built against the written contract before the Rust existed and resolved seven ambiguities on its own; those answers are now in `docs/plans/ipc-contract.md` — **which is uncommitted** — and Rust matches them rather than the reverse. **Never rendered in a window**, and `src/index.css` grew **449 lines** for it, none of them looked at. |
| the five run commands and the reconciler | `e0f1375` | `start_run`, `current_run`, `stop_run`, `unsettled_intents`, `settle_intent` (`src-tauri/src/commands.rs:293,347,370,389,410`); `src-tauri/src/reconcile.rs` (453 lines), `src-tauri/src/views.rs` (423). The reconciler runs `git worktree repair` **per project first** — a folder renamed between a crash and a restart otherwise makes every path-based postcondition answer wrongly — then publishes the conservative outcome: a phase carrying real unsettled work is blocked, a project whose repair failed is refused. It reads `IntentOutcome` rather than trusting the store's filter, because an `unknown` row is emitted for every order the loop has ever dispatched and `Acked` is not evidence of anything. **The per-kind postcondition evaluator is deferred and the rustdoc says so** — the reconciler settles nothing; blocking a phase that could have run costs a click, re-dispatching an order that already had effects is the failure the intent table exists to prevent. `plans.status` has no transition beyond approval, so `stop_run` records `abandoned` for the current launch only and after a restart the plan reads `approved` again; `done` is derived from *every phase green* rather than stored, so `RunView.status` is partly a computed field (`report-2026-09-04.md` §5.3). Tests only; **the path from a click to a running loop has never been exercised end to end.** |

**Still never clicked in a real window, and the list grew today rather than shrinking.** The
**Resume button**, the **branch chip**, the **cleanup flow** and the **approvals dock** were already
in that state and still are. `e0f1375` added six more: the **folder picker**, the two
**reveal-in-Finder** controls, the **plan card**, the composer's **Start** and the run's **Stop**,
and the **settle buttons**. Every one of the new six has a test; none has been driven by a human.
What *has* been driven by hand, at `a0901e5`: the sidebar, project collapse, and session selection.
**One session at the keyboard closes the largest single gap in this file.**

**Three things had never been observed at all. Re-checked 2026-09-04 against the code, and all three
still hold:**

- the **pulsing busy dot** (`src/components/Sidebar.tsx:268`) — nothing has been running while
  anyone was looking. **Today's live run did not change this**: it ran from a Rust test with no
  window open;
- the **collapsed-project run marker** (`src/components/Sidebar.tsx:540`, `className="dot running"`)
  — every session in the owner's store is `failed` or `exited`, so no project has ever had a live
  child under it. Still 44 sessions and none of them running **[measured]**, and the live run wrote
  into a tempdir data directory, not the owner's;
- the **empty-session `cancel()` branch** (`src/App.tsx:321`) — the smallest real session in the
  store is 6 rows.

**`pre`, `ul` and `li` are still unexercised under Tailwind preflight, and the paragraph that said
they live in one file is now wrong.** Re-grepped 2026-09-04 **[measured]**: **10** non-test
`<pre>`/`<ul>`/`<li>` occurrences in `src/`, across **two** files — five in
`src/components/Approvals.tsx` (all three tags) and five in `src/components/RunCard.tsx` (`ul` and
`li` only, at `:126,148,174,218,220`). Neither has rendered. The dock never opens because the store
holds exactly one approval row and it is already resolved, so `pending_approvals` returns empty; the
plan card has simply never been in a window. **`<pre>` is still confined to `Approvals.tsx`, so the
one tag whose preflight reset is most likely to bite is still gated behind a live approval.** This
remains the largest thing unverified about the token layer.

## 3. Gates at `e0f1375`

All six run by the lead under its own hand on 2026-09-04 against the final combined tree, exit codes
captured on the command itself and not through a pipe. Every line **[measured]**:

```
cargo test --workspace                                exit 0  515 passed, 0 failed, 7 ignored
cargo clippy --workspace --all-targets -- -D warnings exit 0
cargo doc --workspace --no-deps                       exit 0
npm test                                              exit 0  598 passed, 71 files (2026-09-10, ui/design-system 1f57e08)
npx tsc --noEmit                                      exit 0
npm run tauri build                                   exit 0  .app + .dmg
```

**301 → 515 Rust and 137 → 191 front-end across the four commits.** The 191 reconciles exactly
against the source: `paint.test.ts` 38, `components/Sidebar.test.tsx` 27, `feedStore.test.ts` 27,
`components/Feed.test.tsx` 20, `components/RunCard.test.tsx` 18, `mock.test.ts` 17,
`providers/ThemeProvider.test.tsx` 15, `App.test.tsx` 13, `run.test.tsx` 8, `index.css.test.ts` 8 —
**191 across 10 files**, counted by grepping `it(`/`test(` **[source]**, which is a source count and
not a per-suite run. (`providers/ThemeProvider.test.tsx`'s 15 went with the light theme on
2026-09-10; the 2026-09-04 reconciliation is left as counted.) Three suites are new (`RunCard`,
`mock`, `run`), `App` grew 10 → 13 and `Sidebar` 19 → 27, and the other five are unchanged. **The per-suite Rust breakdown was not
re-derived** — the previous "sum of 31 `test result:` lines" figure has no successor here.

**One number in `docs/plans/report-2026-09-04.md` does not reconcile with this file and is not
being overwritten.** That report's §1 says the run started from "340 Rust tests … at `a889525`";
§3 of this file measured **301** on the tree at `c884767`, and `a889525` is a documentation-only
commit, so the committed tree cannot have moved between them. Grepping `#[test]`/`#[tokio::test]`
across `crates/` gives **291** at `a889525` and **482** at HEAD **[source]** — the same shape as
301 → 515, not as 340 → 515. The likeliest reading is that 340 counted the **uncommitted W1-A store
work** that was in the working tree when the run began, and that is **[asserted]**, not checked.
**301 → 515 is what this section uses.**

**What this gate run does not prove, and for the first time one clause of it is covered elsewhere.**
It is a build and a test run. It spawned **no live `claude` child** — but the live loop run recorded
in §2 did, so "nothing here has ever run against a real child" is no longer the whole story for the
supervisor. **The UI half is untouched: none of the six gates exercises the UI in a window, and
nothing in `src/` has been clicked.** The live run went through `crates/supervisor/tests/live_loop.rs`,
not the app.

Bundle at `e0f1375`, read off the `vite build` line of the gate run: **289.67 kB JS + a 1.38 kB lazy
chunk / 32.09 kB CSS**, gzip **91.42 / 6.77** **[measured]**; re-confirmed independently against
`dist/assets/` on disk — `index-JzQyfJrI.js` 289,670 B, `index-B9FBaaNd.css` 32,086 B,
`event-D2Ly66tR.js` 1,382 B **[measured]**. From **274.87 / 27.11 at `c884767`**: **+14.80 kB JS and
+4.98 kB CSS over four commits**. That is a **real-code change and not noise** — `e0f1375` added
`src/components/RunCard.tsx`, `src/wire.ts`, `src/mock.ts` and 449 lines of `src/index.css`, and its
own commit message quotes the same two figures. The lazy chunk is unchanged at 1.38 kB; **the gzip
figure for it was not quoted in this run** and the 0.67 kB reading is carried from `c884767`.
Earlier points on the curve: 272.71 / 26.91 at `a0901e5`, 263.28 / 21.89 at `3e5c3fd`, 262.69 /
12.69 at `ad5a4a7`. The CSS growth from 12.69 was, until today, almost entirely Tailwind preflight —
the token layer itself was **+0.54 kB** and Tailwind adds **zero** JS
(`docs/research/oklch-tokens.md` §5); **the +4.98 kB added today is hand-written rules for the run
surface, not preflight.** The earlier `~258 kB JS` line is superseded.

**One warm FCP sample at `a0901e5` came back at 375.9 ms**, against the 287–295 ms p50 (n=19)
recorded at the smaller bundle. One sample against a distribution, and the same run's cold launch
(801.9 ms) matches an earlier cold outlier (755.9 ms), so the regression is **neither attributable
to the bundle growth nor ruled out** — and the bundle has since grown a further **16.96 kB JS**
(2.16 to `c884767`, then 14.80 to `e0f1375`) while the n=19 three-arm treatment still has not been
re-run, so that one sample stands exactly where it did and the confound is larger than it was.
Re-running that treatment (`docs/research/perceived-performance.md` §1.4) is what would settle it.
B1's figure is unchanged.

**The 7 ignored are three different kinds of thing: five that spend and have not been run, one that
costs nothing, and one that spends and *has* been run.** From `grep -rn '#\[ignore' crates`,
re-derived 2026-09-04 **[measured]**. The old line said 6 and its bare `:270`/`:189`/`:239` line
references read as if four live tests shared one file; they do not, and the paths below are the real
ones:

- **Five spend on a live account and have not been run here:** `live_pong`
  (`crates/core/tests/claude_adapter.rs:1091` — the old `:1080` is stale),
  `live_resume` (`crates/supervisor/tests/live_resume.rs:255`), `live_approvals`
  (`crates/supervisor/tests/live_approvals.rs:270`), `live_worktree`
  (`crates/supervisor/tests/live_worktree.rs:189`), `live_two_sessions`
  (`crates/supervisor/tests/live_two_sessions.rs:239`).
- **One costs nothing.** `eight_ordinary_one_flood_one_approval_across_three_projects`
  (`crates/supervisor/tests/flood_baseline.rs:137`), added at `96a66a2`, **spawns no `claude`
  process** — every session is a `ReplayDriver` over a captured NDJSON fixture. It is `#[ignore]`d
  because it is a ~30 s instrument, not a gate.
- **The seventh is new, it spends, and unlike the other five it has been run.**
  `live_run_reaches_green_and_the_exit_code_is_what_settled_it`
  (`crates/supervisor/tests/live_loop.rs:261`, added at `31e551f`) spawns **real `claude` children**
  and drove the live loop recorded in §2. It cost **$0.192433** over 5 sessions and 6 ticks on
  `claude-haiku-4-5` and took **106.04 s**, exit 0 **[measured]** 2026-09-04. It asserts its
  project root is a throwaway tree (`live_loop.rs:267-271` refuses a root carrying `Cargo.toml` or
  `src-tauri`) and it creates that tree in a tempdir, so it cannot be pointed at a real checkout by
  accident. **It is the most expensive `#[ignore]`d test in the workspace** — more than three times
  `live_two_sessions`.

Say which you mean: a reader who believes all seven cost money will avoid the one that does not, a
reader who believes none do will spend, and a reader who assumes none has been run will not know
that one number in this file came from an account.

Run one at a time. The old single command named `-p brigadier-supervisor` only and was incomplete —
`live_pong` lives in `brigadier-core`:

```
CLAUDE_BIN="$(command -v claude)" cargo test -p brigadier-supervisor --test <name> -- --ignored --nocapture
CLAUDE_BIN="$(command -v claude)" cargo test -p brigadier-core --test claude_adapter -- --ignored --nocapture
```

`live_loop` reads **no environment variable but `CLAUDE_BIN`** (`crates/supervisor/tests/live_loop.rs:262`,
the only `env::var` in the file) **[source]**, so the first command covers it with
`--test live_loop`. It builds its own project in a tempdir; nothing has to be pointed at it.

Live costs, from the store row: `live_loop` **$0.192433** (2026-09-04, 5 sessions, 6 ticks,
`claude-haiku-4-5`) **[measured]**, `live_approvals` ~$0.046, `live_resume` ~$0.031,
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
| checkpoint capture write primitive, 1,000 tiny files (n=1 per mode, Git 2.50.1 Apple Git-155, 357,360 bytes total) | 1,000 individual blocking `hash-object -w --stdin --no-filters` **11,553.8 ms** cold / 6,161.4 ms repeat; one `hash-object --stdin-paths` **5,759.4 ms** cold / 73.9 ms repeat; `fsyncMethod=batch` 5,760.3 / 84.9 ms — no help; one raw blob-only `fast-import --quiet --done` **29.1 ms** cold. Batched `cat-file --batch` readback of all 1,000 blobs **70.6–76.4 ms**. The shipped implementation reported **16,555 ms first / 13,186 ms unchanged**. **Primitive timings, not application capture percentiles**; exclude file preparation and metadata scanning. This is the arithmetic behind `crates/core/src/checkpoint/git.rs` | moved from `checkpoint-integration-2026-09-06.md` on 2026-09-09 (file deleted) |
| sidebar geometry, browser-measured 2026-09-08 | width **264 px**; navigation rows **32 px** high at **10 px** radius; type scale **13 px** navigation / **17 px** text-only wordmark / **14 px** workspace title; 16 px icons at x=12, project and session labels at x=36; **220 ms** sidebar-width transition, **200 ms** intrinsic folder-height transition, reduced-motion override; **24 px** backdrop blur. Later refinements in the same run moved rows to 28 px and the header to 46 px — read the source file's tail before quoting a single number as current. §4's `ROW_H` 28 is the **feed**, not the sidebar | moved from `sidebar-validation.md` on 2026-09-09 (file deleted) |

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
   **Correction, re-measured on git 2.50.1** (moved from `worktree-defects.md` on 2026-09-09,
   now `docs/research/worktree-cleanup.md` §1.19): that exit-0 behaviour holds **only for a relative
   argument**. The absolute path brigadier actually passes gets `fatal: '…' is not a working tree`,
   **exit 128**, and touches nothing. The `path.exists()` defence still ships, because
   `remove -f -f` on a killed `add` can exit **255** while having already unregistered the entry.
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
- `docs/research/worktree-cleanup.md` §1.4 and §5 item 3 above said `git worktree remove` exits 0
  over files it left behind. **Spelling-dependent**: relative argument exits 0, absolute argument
  exits **128** with `fatal: … is not a working tree`. §1.1's `remove -f -f` "exit 0 — the only
  escape" can be **exit 255** with the entry unregistered anyway. `--exclude=` for
  `rev-list --branches` takes the **short** name, and `--all` is the wrong ref set (a stash hides
  unmerged work). All three moved from `worktree-defects.md` on 2026-09-09 into
  `docs/research/worktree-cleanup.md` §1.19; that file was then deleted.

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
- **Warming or preloading the native directory picker.** There is **no supported preload/warmup
  API** in `tauri-plugin-dialog` **2.7.3**: the JS exports are `open`, `save`, `message`, `ask`,
  `confirm`, and `open()` invokes the native dialog immediately; the Rust builder only stores
  configuration fields and the desktop folder-pick schedules `rfd::AsyncFileDialog` on the main
  thread, so constructing a builder is not evidence of warming the OS chooser. Closed 2026-09-06;
  moved from `project-picker-responsiveness-2026-09-06.md` on 2026-09-09 (file
  deleted). Make the Create project modal's first render independent of folder work instead, and do
  not label background configuration as "warming the picker".

- **A focus reset gated on a class-name substring.** The 2026-09-10 block in `src/index.css`
  neutralised rings only for elements matching `[class*="focus-visible:ring"]`. The gate was there
  to spare five kit surfaces that draw a decorative, non-focus `ring-1 ring-foreground/10`
  hairline, but it missed `ui/field.tsx`'s FieldLabel twice over — the class is written
  `has-[>[data-slot=field]]:has-[:focus-visible]:ring-3`, whose literal substring is
  `focus-visible]:ring`, and whose compiled selector is `:has(:focus-visible)`, not
  `:focus-visible`. It also missed everything outside Tailwind. Replaced 2026-09-11 by
  `src/focus-reset.css`, which resets rings on every focus state and instead EXCLUDES the
  decorative slots by `data-slot`. Do not re-express those hairlines as `box-shadow`:
  `controls/overlay.tsx` and `controls/modal.tsx` wrap the kit's popover, dropdown and dialog with
  `ring-0`, so a re-expressed hairline would draw a line this app does not currently have.
  Four focus indicators lived entirely outside that gate and outside Tailwind, and any of them
  could be the outline the owner kept seeing: `.rename-session-dialog input.input:focus` (a solid
  blue border, `src/index.css`), `.note-title-input:focus-visible` (a bottom rule, `src/index.css`),
  `.welcome-name input:focus` (a 3px accent halo, `src/intro.css`), and
  `.layout-resizer:focus-visible::after` (a 2px `var(--ring)` bar, `src/index.css`). Monaco and the
  VS Code workbench paint their own focus edges from theme data that no stylesheet can reach;
  `focusBorder`, `contrastBorder`, `contrastActiveBorder` and the three `list.*Outline` ids are set
  to `#00000000` in `src/components/CodeEditor.tsx` and `src/vscode-panels/runtime.ts`.

- **esbuild's CSS minifier drops an earlier rule when a later rule has a byte-identical selector,
  `!important` notwithstanding.** Measured 2026-09-11: three `!important` overrides in
  `src/focus-reset.css` (`.layout-resizer:focus-visible::after` and its two orientation siblings)
  were present in the Tailwind CLI output and absent from `dist/assets/*.css`, so the blue focus
  bar came back in the production bundle while the dev server looked correct. Every selector in
  `src/focus-reset.css` that also exists verbatim in `src/index.css` or `src/intro.css` therefore
  carries a redundant `:root ` prefix. A CSS override is not proven by the dev server or by the
  Tailwind CLI output alone — grep the built bundle.

- **`selectedProjectId === null` is two states, and the missing-project effect fights one of them.**
  Added 2026-09-11 (`ui/sidebar`). A global "New chat" — the sidebar button, ⌘N, or the welcome
  screen's own row — now starts with **no project picked**, so `App`'s `selectedProjectId` is `null`
  while projects exist. `App.tsx`'s missing-project effect exists to force it back to `projects[0]`
  whenever the id is not in the list, so the unpick is undone on the next render unless the effect
  is told to stand down: that is the whole job of the `projectUnpicked` flag beside it. Do not
  "simplify" it away, and do not persist it — a reload is meant to come back on the remembered
  project (`brigadier:selected-project`). Every explicit pick goes through `chooseProject`, which
  clears the flag; the only two raw `setSelectedProjectId` calls left are the boot restore and the
  missing-project effect itself.
- **One event, two meanings: `brigadier-new-project-session`.** Its `detail` is the project id for
  the project-scoped new chat (a project row's ⋯ menu, its hover pencil), and `null` for the global
  one. `Sidebar.test.tsx` asserts that ⌘N dispatches this event, which is why the global path
  reuses it rather than adding a second. A second press while already unpicked dispatches
  `brigadier-pick-project`, which `TaskSetupRail` answers by clicking its own project trigger —
  `SelectMenu` owns its open state and takes no `isOpen`, so there is nothing else to drive.
- **The composer's project picker must ignore the rail's `disabled`.** `NewSession`'s
  `controlDisabled` includes `!project`, so honouring it would disable the one control that can
  end the unpicked state. `TaskSetupRail` gates that picker on `disabled && !!project` instead.
  Its placeholder is a `value` that matches no option (`PROJECT_PLACEHOLDER`), because `SelectMenu`
  renders `options.find(o => o.value === value)?.label ?? value` — adding a placeholder row to the
  list would make it selectable.

## Landmines already paid for (do not rediscover)

- **Base UI's menus, popovers, dialogs and tooltips (2026-09-10, `ui/design-system`).** Every one
  of these was measured while porting `src/components/controls/` onto the assistant-ui kit; each
  cost at least one wrong turn.
  - **A menu opens one animation frame after `mousedown`.** floating-ui's `useClick` runs
    `event: "mousedown"` and defers `setOpen` through `requestAnimationFrame`, so
    `await user.click(trigger)` followed by a synchronous `getByRole("menuitem")` finds nothing.
    `controls/overlay.tsx` prevents the internal handler with `event.preventBaseUIHandler()` and
    toggles synchronously instead; Base UI's own `click` handler then no-ops because its
    `pointerType` was recorded on `pointerdown`. `Popover` needs none of this — its trigger opens
    from `click`. Do not add the same handler to a popover trigger: it double-toggles and the
    popover never opens.
  - **A dismissed popup stays in the DOM through its exit transition.** Under jsdom that needs
    `globalThis.BASE_UI_ANIMATIONS_DISABLED = true`, which is why `src/test/setup.ts` sets it.
    Without it, roughly a dozen `queryByRole(...)` assertions that follow a close see the closing
    element.
  - **Disabled items stay in the keyboard walk.** `MenuRoot` hard-codes `disabledIndices: []` and
    `useMenuItem` sets `focusableWhenDisabled: true`, so arrow keys land on a disabled row. A
    disabled `Dropdown.Item` therefore renders as a plain `<div role="menuitem" aria-disabled>`
    outside Base UI's composite, which is what the old disabled `<button>` did.
  - **A submenu needs a few frames to settle after Escape.** Reopening it inside that window
    reopens the popup but leaves focus on the trigger.
  - **Submenu triggers open on hover by default, and the hover path arms a safe polygon** that sets
    `pointer-events: none` on everything outside the open popup — which strands a pointer click on
    a sibling row. `controls/overlay.tsx` passes `openOnHover={false}`; brigadier's menus never
    opened a submenu on hover anyway.
  - **The kit's popup components do not forward a ref.** `DropdownMenuContent`,
    `DropdownMenuSubContent` and `DialogContent` are plain functions; a `ref` never reaches the
    popup, while `aria-label`, `data-*` and `initialFocus` do. The adapters find their popup by a
    `data-overlay` marker. `PopoverContent` is the one exception here — it was rewritten as a
    `forwardRef` — but `controls/overlay.tsx` shares one lookup across both paths and uses the
    marker anyway.
  - **`initialFocus` and Base UI's focus restoration both land a frame late.** `controls/modal.tsx`
    also focuses in a layout effect from inside the popup and restores the previous focus in that
    effect's cleanup, because the call sites assert focus synchronously.
  - **Base UI's Escape swallows the key** unless the handler calls
    `eventDetails.allowPropagation()`. Without it, Escape on a menu row that carries a tooltip
    closes the tooltip and leaves the menu open.
  - **A popup and a wrapper cannot both carry the same ARIA role.** Base UI puts `role="menu"` on
    the menu popup and `role="dialog"` on the popover popup, so `Dropdown.Menu` and
    `Popover.Dialog` are passthroughs now and their `aria-label` is lifted onto the popup; two
    nested elements with one role make every `getByRole("menu"|"dialog")` in the suite ambiguous.
  - **`--color-accent` changed meaning, and the name did not.** It used to be brigadier's brand
    blue; it is now the kit's menu-item hover fill (`--color-accent: var(--accent)` =
    `rgba(255,255,255,0.08)`), because the five composer sites that meant blue by it were rewritten
    to `var(--ring)`. The collision is resolved, but the trap is live: any new `bg-accent`,
    `text-accent-foreground` or `var(--color-accent)` written from memory paints a near-transparent
    grey where the author expected `#3b82f6`. Brand blue is `--ring` / `--color-attention`.
  - **Five `rem` sites in the kit are 12.5% short, and that is accepted.** `:root { font-size:
    14px }` makes every `rem` in this app 14px, so the kit's own literals land under upstream's
    intent: `ui/button.tsx:26` and `ui/toggle.tsx:16` `text-[0.8rem]` (11.2px, not 12.8px),
    `ui/select.tsx:73` `max-h-[min(24rem,…)]` / `min-w-[max(8rem,…)]` (336/112px, not 384/128px),
    and `ui/tooltip.tsx:63` `max-w-xs` (280px, not 320px). Left as upstream ships them: `select`
    and `toggle` have no call site, and the two type sizes read correctly at this root. The radius
    scale is **not** in this bucket — `--radius-sm/md/lg`, `--radius-surface` and `--radius-xl` are
    pinned in px in `src/index.css` because brigadier's pre-port corners (4 / 10 / 16px) are the
    reference, and `rem` there shrank `rounded-lg` from 16px to 7px app-wide.

- **`set_decorations` and `set_resizable` are order-dependent on macOS, and the wrong order fails
  silently.** Tao builds the decorated style mask from its *shared* `resizable` state and then
  **queues that mask asynchronously**; a following synchronous `set_resizable(true)` is subsequently
  overwritten by the queued non-resizable mask, so restoring the titlebar silently loses edge
  resizing, zoom and fullscreen. Call `set_resizable(true)` **before** `set_decorations(true)`.
  `set_maximizable(true)` only enables an existing Zoom button and cannot repair the missing
  Resizable bit. Verified against installed `tao-0.35.3/src/platform_impl/macos/window.rs:795–810,
  1342–1376` (Tauri 2.11.5 / tauri-runtime-wry 2.11.4), 2026-09-07. Related: running these setters
  inside `run_on_main_thread` does **not** make them synchronous — Tao's decoration, content-size
  and frame-position helpers always enqueue main-dispatch-queue operations, so an immediate
  titlebar measurement can observe the previous frame. Moved from
  `intro-window-controls-2026-09-07.md` on 2026-09-09 (file deleted).
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
- **The first launch after `e0f1375` migrates the owner's database `user_version` 3 → 6, and that is
  one-way.** `MIGRATIONS` gained rungs 3, 4 and 5 (`intents`, `unknowns`, `phases.base_sha`); the
  file at `~/Library/Application Support/ai.brigadier.app/brigadier.sqlite` is still **3 on disk**
  as of 2026-09-04 (read-only check, `mode=ro`, which does not run migrations: 2 projects, 44
  sessions, 1 approval, genuinely answered) **[measured]**. Once it is 6, **an older brigadier binary
  refuses to open it** — `migrate` returns `Error::Newer { found, known }` rather than opening a file
  it half understands (`crates/store/src/schema.rs:714`, pinned by
  `a_file_from_a_newer_build_is_refused_rather_than_opened` at `:1151`) **[source]** — and launching
  the old build does not undo the migration. Remedy: copy the file before the first launch if you
  want a way back.
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
  `window.matchMedia` at all, so any consumer of it needs a stub —
  `src/test/setup.ts:32` installs the global one, and `src/hooks/use-sidebar-vibrancy.test.tsx:55`
  overrides it per test. `src/paint.test.ts:10-18`, `src/hooks/use-sidebar-vibrancy.ts:9`,
  `src/Launch.tsx:32`. (The former citation, `src/providers/ThemeProvider.test.tsx:16`, was deleted
  with the light theme on 2026-09-10.)
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
- **`@theme inline` declares a utility but does not emit the variable.** Measured with
  `@tailwindcss/cli@4.3.3`, 2026-09-10: `@theme inline { --color-input: var(--input) }` emits
  `.bg-input { background-color: var(--input) }` and no `--color-input` anywhere. Utilities keep
  working; every `var(--color-input)` in a hand-written CSS file silently resolves to nothing.
  Tailwind scans only `src/index.css` — `src/components/**/*.css` are plain files Vite imports — so a
  token read from one of those must live in a **non-inline** `@theme` block. `--color-sidebar` and
  `--color-input` are there for exactly this reason (`docs/research/assistant-ui-design.md`, "Applied
  2026-09-10").
- **`:root { font-size: 14px }` makes every `rem` 14px, not 16px.** The assistant-ui kit's radius and
  type scales are `rem`, so they land 12.5% under upstream's intent: `--radius: 0.5rem` is 7px here,
  not 8px, and the kit button's `sm` size `text-[0.8rem]` is 11.2px, not 12.8px. `--spacing: 4px` is
  pinned in px for the same reason and must stay pinned.
- **`--color-accent` means two different things.** brigadier's is the brand blue (`#3b82f6`, 5
  `var(--color-accent)` sites under `src/components/composer/`); the assistant-ui kit's is the
  menu-item hover fill. brigadier's meaning holds the Tailwind key today and the kit's is omitted from
  the `@theme inline` bridge. Before copying `dropdown-menu`, `select` or `command` — all three style
  the hover row `bg-accent text-accent-foreground` — rewrite those 5 CSS sites to `var(--ring)` and
  give `--color-accent` back to the kit, or every menu hover comes out blue.
- **`src/lib/theme.ts` reads `--color-*` through `getComputedStyle` and feeds Monaco hex.** Those
  tokens are now aliases (`--color-canvas: var(--background)`). A browser substitutes before
  `getComputedStyle` sees it (CSS Custom Properties §3); jsdom does not, which is why
  `src/lib/theme.test.ts` resolves the hop itself. **Asserted, not measured in a real webview** — if
  the editor ever comes up with default colours, this is the first thing to check.
- **`src/components/ui/**` is a manual, un-versioned copy, not a dependency.** `@assistant-ui/ui` is
  `private: true, version 0.0.0` and unpublished, and `r.assistant-ui.com` serves no route for it.
  The source commit is recorded in `src/components/ui/UPSTREAM.md`; without it there is no way to
  diff against upstream. Never run `npx shadcn init` in this repo — it overwrites `src/lib/utils.ts`
  and rewrites the file named by `components.json`'s `tailwind.css`, which is now `src/index.css`.
- **`ghostButton` and `inkButton` are gone from `src/lib/surfaces.tsx` on purpose** (2026-09-10). The
  kit Button's `ghost` and default variants at `size="icon-sm"` are the same two affordances, and
  `src/components/assistant-ui/elements/**` now imports `@/components/ui/button` instead. Both
  recipes still exist upstream in `elements-surfaces`, so `npx shadcn add elements-message-actions`
  (or any other `elements-*` item) will reintroduce them and the raw `<button>` call sites with them.
  Re-port onto the kit rather than restoring the recipes. Detail:
  `docs/research/assistant-ui-design.md` § "Elements 2026-09-10".
- **A `dark:` variant in `src/` is dead or misleading, never both-mode styling.** `<html>` carries a
  static `dark` class and there is no light block, so `dark:X` either duplicates the base utility or
  silently *is* the only value that paints. Twelve such sites were collapsed in the elements and
  `surfaces.tsx` on 2026-09-10; write the dark value on the base utility instead of adding a variant.
- **Elements are not all themed copies — some are rewrites.** All 20 files under
  `src/components/assistant-ui/elements/` have an upstream registry item
  (`https://r.assistant-ui.com/<item>.json`, index at `registry.json`; source at SHA
  `1a5da0f272668cf313e5213e49aa70e0f987de6d` under
  `packages/ui/src/components/react/assistant-ui/elements/`), but `thread.tsx`, `subagent-list.tsx`,
  `background-inbox.tsx` and `checkpoint-history.tsx` are local rewrites against brigadier types,
  and `message-actions.tsx` now diverges deliberately. Never re-install an element over a local file
  without diffing first. The bare registry root and `index.json` both 404; only `registry.json` and
  `<item>.json` resolve.
- **`cmdk` is banned by a test, not just by taste.** `src/dependency-hygiene.test.ts:28-38` asserts
  no dependency matches `/cmdk|prompt-kit/` and no file under `src/` imports from either. The
  assistant-ui kit's `command.tsx` is a `cmdk` skin, and `cmdk@1.1.1` pulls four individual
  `@radix-ui/react-*` packages, which `CLAUDE.md` §5 forbids. `src/components/ui/command.tsx` is
  therefore the kit's command with plain elements underneath and `aria-selected` in place of cmdk's
  `data-selected`; `src/components/controls/search-dialog.tsx` still drives the active row itself.
- **Base UI Collapsible emits `data-open` / `data-closed`, Radix emitted `data-state="open"`.**
  `src/components/ui/collapsible.tsx` moved to Base UI on 2026-09-10, so any
  `data-[state=open]:` utility aimed at it is now dead. `collapsePanel` in `src/lib/surfaces.tsx:38`
  is one such: its expand animation stopped firing for `tool-call.tsx`, `reasoning-panel.tsx` and
  `WorkTrace.tsx` and needs `data-open:` instead. Same trap for every other kit part — `data-active`
  on a tab, `data-checked` on a checkbox, `data-highlighted` on a select item.
- **A Base UI `Tabs.Tab` with `activateOnFocus` selects when anything inside it takes focus.**
  `focusin` bubbles, so a tab's own close button would select the tab it closes.
  `src/components/controls/tabs.tsx` guards with `event.target !== event.currentTarget` and Base
  UI's `event.preventBaseUIHandler()`; `controls-keyboard.test.tsx:140-142` is what catches it.
  `event.stopPropagation()` on the close button is not enough — it only stops the click.
- **Sonner renders in place and keeps a dismissed toast mounted for its 200 ms exit.** Both bite.
  `DesktopSettings` hides the app tree behind it from the accessibility tree, so
  `src/components/Toasts.tsx` portals the `<Toaster>` to `document.body` as the hand-written stack
  did (`App.test.tsx:671`). And a stale toast sits in the DOM beside a fresh one, so the notice
  drops its `role` and takes `aria-hidden` the instant it is dismissed. Sonner's `<li>` carries no
  role of its own — only its `<section>` wrapper is `aria-live` — which is why the notice body owns
  `role="status"` / `role="alert"` and why these go through `toast.custom`, not `toast(msg, {action})`.
- **Sonner's swipe handler calls `event.setPointerCapture`, which jsdom does not implement.** Any
  click inside a toast throws an unhandled `TypeError` in vitest. `dismissible: false` per toast
  skips that whole path and costs nothing here: the row has an explicit dismiss button and never
  had swipe-to-dismiss. It does not affect `toast.dismiss()`.
- **`npx shadcn add field` overwrites `label.tsx` and `separator.tsx`.** They are registry
  dependencies of `field`, and `add --overwrite` takes them without asking. Both are assistant-ui
  kit copies here; back up `src/components/ui/` before any `add` and restore them after. `add` also
  installs the `cn` npm package and writes `import { cn } from "cn"` — uninstall it and rewrite the
  imports to `@/lib/utils` (`docs/research/shadcn-base-ui.md` §3).
- **Keyboard focus is invisible app-wide, on purpose.** Owner decision 2026-09-10: no focus outline
  and no focus ring anywhere. The rules are one unlayered block in `src/index.css` (immediately after
  `@layer base`, before the first component rule) — `outline: none` on `*` and on
  `:focus`/`:focus-visible`/`[data-focus-visible]`; `--tw-ring-color: transparent` and
  `--tw-ring-shadow: 0 0 #0000` on focus, which makes Tailwind's ring box-shadow composite render
  nothing; and per-`data-slot` `border-color` rules that put the nine kit components carrying
  `focus-visible:border-ring` back to their resting border. The ring rule is gated on
  `[class*="focus-visible:ring"]` and that gate must stay: every ring on an element shares one
  `--tw-ring-shadow` slot, and `popover-content`, `dialog-content`, `select-content`, the sonner
  toast and `avatar` draw a decorative hairline with a non-focus `ring-1`/`ring-2`. Base UI focuses
  a popup on open, so an ungated rule erases those hairlines. Unlayered is load-bearing: Tailwind's
  utilities are in `@layer utilities`, and an unlayered author rule beats a layered one whatever the
  specificity, so no `focus-visible:` class had to be deleted from the copied files in
  `src/components/ui/`. Do not "fix" this as an accessibility bug and do not restore the ring; it is
  an accepted a11y regression the owner asked for. `aria-invalid` rings are deliberately excluded
  (`:not([aria-invalid="true"])`) — those are validation, not focus.
- **The kit's `min(var(--radius-md), 10px)` corner clamp bites since the 2026-09-10 radius raise.**
  The owner raised every named radius step by 2px (`--radius-sm` 6, `--radius-md` 12, `--radius-lg`
  18, `--radius-surface` 12, `--radius-xl` 14, `--radius` 18). Two kit sizes cap the corner at 10px
  rather than reading `--radius-md` — `size="xs"` and `size="icon-xs"` in
  `src/components/ui/button.tsx:25,30` and `data-[size=sm]` in
  `src/components/ui/toggle-group.tsx:45` — so they stay at 10px while everything else moved to 12.
  `src/components/controls/button.tsx` corrects the `icon-xs` path with its own
  `XS_ICON_BUTTON_RADIUS = "rounded-[12px]"`, appended after the kit's variant string so
  tailwind-merge keeps it. Fix any future case the same way, in our adapter; `src/components/ui/` is
  a verbatim upstream copy (`src/components/ui/UPSTREAM.md`) and editing it breaks the next
  `shadcn add`. The `xs` text size and the `toggle-group` `sm` size have no call sites today and are
  left alone.
- **Tauri v2 has no fullscreen event (2026-09-10, `ui/sidebar`).** `@tauri-apps/api` **2.11.1**'s
  `window.d.ts` exposes `isFullscreen()`, `onResized()` and `onFocusChanged()` and nothing that
  fires on the fullscreen transition itself. `src/hooks/use-fullscreen.ts` therefore seeds from
  `await isFullscreen()` and re-polls it inside `onResized`. Do not go looking for
  `onFullscreenChanged`; it is not there. [measured: grepped the shipped `.d.ts`]
- **`src/window-chrome.css`'s `--window-controls-inset: 90px` is live even when the drag layer is
  hidden (2026-09-10, `ui/sidebar`).** The rule is `:root:has(.window-drag-region) .app-shell`, and
  the layer is only `display: none`d while the workspace is mounted — `:has()` still matches a
  hidden element. Anything that wants a different inset must out-specify (0,3,0), which is why the
  macOS-fullscreen rule is written `:root:root[data-fullscreen="true"] .app-shell`: the repeated
  `:root` buys (0,4,0) without depending on markup either worker might change, and it wins
  whichever of the two stylesheets the bundler emits last.
- **Never set `position` on a shared class in unlayered CSS (2026-09-10, `ui/sidebar`).**
  `@import "tailwindcss"` puts `absolute` inside `@layer utilities`, and unlayered rules beat every
  layer, so `.layout-resizer { position: relative }` in `src/index.css` would silently un-absolute
  all three splitters. `.layout-resizer` styles only paint; each call site positions itself.
- **`tauri icon` does not produce a byte-reproducible `icon.icns` (2026-09-10, `ui/sidebar`).** Two
  runs from identical input gave two 61,359-byte files differing from offset 10 onward, while every
  PNG under `src-tauri/icons/` and `public/brand/app-icon.svg` came back byte-identical. Diff the
  PNGs and the SVG to decide whether a palette change reached the icons; an `icon.icns` diff on its
  own proves nothing. Revert it rather than committing churn.
- **`scripts/generate-brand.mjs` reads a two-level palette (2026-09-10, `ui/sidebar`).** Since the
  design-kit port, `--color-canvas`/`--color-elevated`/`--color-attention` are `var()` aliases of
  `--background`/`--popover`/`--ring`, so the script's old "match a literal hex under this name"
  regex threw `Missing icon color: attention`. It now collects every `--name: value;` in
  `src/index.css` (first declaration wins) and follows `var(--x)` up to four hops to a colour
  literal, failing loudly on anything else.
- **The sidebar's ink and geometry are Codex's, and they live in CSS, not in classes (2026-09-10,
  `ui/sidebar`).** `docs/research/codex-sidebar.md` §9 is the applied table: every number is a
  `--sidebar-*` token on `:root` and an unlayered rule in `src/index.css`'s sidebar section. The
  unlayered part is load-bearing — `@import "tailwindcss"` puts every utility in
  `@layer utilities`, and a layer loses to an unlayered rule whatever the specificity, which is
  what lets `src/components/ui/sidebar.tsx` stay a verbatim upstream copy (`h-8`, `rounded-md`,
  `text-xs`, `[&_svg]:size-4`, `peer-data-[size=default]/menu-button:top-1.5` and all) while
  brigadier renders 30px rows with a 12.5px corner. Restyle the sidebar in that CSS block; do not
  chase the kit's classes with `!` or with a fork of the copy.
- **Hover and selected are the same fill (2026-09-10, `ui/sidebar`).** Codex uses
  `rgba(255,255,255,.078)` for both; what carries the active state is the label going from
  `rgba(223,223,223,.85)` to `#dfdfdf` and the icon to `rgba(255,255,255,.904)`. A "stronger
  selected fill" is a regression, not an improvement.
- **Row labels fade, they do not ellipsise (2026-09-10, `ui/sidebar`).** `.text-fade-truncate` is a
  16px `mask-image` gradient with `text-overflow: clip`. The 16px is a literal on purpose: Codex's
  `1rem` is 16px and this app's root font size is 14px. The footer account name is the documented
  exception and keeps `truncate`.
- **`useRender`'s `state` emits presence attributes, not `="true"` (2026-09-10, `ui/sidebar`).**
  The kit's `SidebarMenuButton` renders `data-active` bare when active and omits it when not — a
  selector written `[data-active="true"]` matches nothing. `src/index.css` uses
  `[data-active]:not([data-active="false"])`, which accepts either spelling;
  `src/components/controls/sidebar.test.tsx` pins which one Base UI actually emits.
- **One ⌘B listener, not two (2026-09-10, `ui/sidebar`).** The kit's `SidebarProvider` registers
  its own `window` keydown handler. brigadier's provider nests it and dropped its own duplicate:
  two handlers both toggling cancel each other out and the sidebar never moves. Every open/close —
  the shortcut, the trigger click, `toggleSidebar()` — now funnels through `applyOpen` in
  `src/components/controls/sidebar.tsx`, which is also where the "refuse while the settings
  overlay or a dialog is open" guards live.
- **`SidebarProvider` hard-codes `--sidebar-width: 16rem` inline (2026-09-10, `ui/sidebar`).**
  That is 224px against this app's 14px root and it beats any `:root` default, because it is an
  inline style on the element every sidebar rule reads. `controls/sidebar.tsx` merges Codex's
  275px in ahead of a caller's `style`, so `App.tsx`'s stored width still wins. A `:root`
  `--sidebar-width` alone would never be seen.
- **The kit's ghost variant paints `aria-expanded` (2026-09-11, `ui/sidebar`).**
  `src/components/ui/button.tsx:17` carries `aria-expanded:bg-muted aria-expanded:text-foreground`,
  so any button that keeps `aria-expanded` for accessibility wears a filled "selected" box for as
  long as it is expanded. That is what made the sidebar toggle look pressed while the sidebar was
  open. The fix is per-call-site — `className="chrome-button aria-expanded:bg-transparent"` on the
  trigger in `src/components/controls/sidebar.tsx`, which `cn`'s tailwind-merge resolves by
  dropping the kit's `aria-expanded:bg-muted` — not a change to the adapter, which would move every
  menu and popover trigger in the app. The ink half needs no override: the unlayered
  `.workspace-chrome .chrome-button { color }` already beats a `@layer utilities` rule.
- **Hover peek waits 300ms (2026-09-11, `ui/sidebar`).** `PEEK_OPEN_DELAY_MS` in
  `src/components/controls/sidebar.tsx`; it was 180ms and read as instant, so crossing the chrome
  flashed the panel open. Only the opening edge is delayed — `PEEK_CLOSE_DELAY_MS` (160ms, the
  grace period for the toggle→panel gap) and the click toggle are untouched. The two boundary
  tests in `controls/sidebar.test.tsx` drive the pointer with `fireEvent.pointerOver` /
  `pointerOut`, not user-event: React derives `onPointerEnter` / `onPointerLeave` from the over/out
  pair, and user-event's internal awaits hang under `vi.useFakeTimers()` — four tests in that file
  time out at 5s, including two that never touched the clock, because the fake timers survive the
  aborted test.
- **The radius scale moves as a set, and it moved back (2026-09-11, `ui/sidebar`).** The owner's
  2026-09-10 +2px raise was reversed on 2026-09-11: `--radius`/`--radius-lg` 16px, `--radius-sm`
  4px, `--radius-md` 10px, `--radius-surface` 10px, `--radius-xl` 12px, the standard icon button
  8px and `icon-xs` 10px. `--radius-composer` (28px), `--sidebar-row-radius` (12.5px, Codex-
  measured) and the 9999px pills are not part of that set and did not move. `--radius-md` is also
  read by the kit's `rounded-[min(var(--radius-md),10px)]` clamps on `xs` / `icon-xs` / `sm` /
  `icon-sm`, so changing it silently moves four kit sizes; `XS_ICON_BUTTON_RADIUS` in
  `controls/button.tsx` states that corner outright so `icon-xs` follows the owner's number rather
  than the clamp.
- **A corner is a token, never a number (2026-09-11, `ui/sidebar`).** The radius scale and a
  semantic layer above it live in `src/index.css`'s `@theme static` block, and every corner in
  `src/` outside the verbatim kit copy under `src/components/ui/` reads one of them. `@theme
  static` and not `@theme inline` is load-bearing: `inline` prunes a theme variable no *utility*
  mentions, and the semantic names are read as `var(--radius-row)` from hand-written CSS and from
  `rounded-[var(--radius-…)]`, neither of which counts. The scale is monotonic as of this date —
  `--radius-xl` used to be 12px, *below* `--radius-lg`'s 16px — so `rounded-sm` moved 4px → 6px
  (five call sites) and `rounded-xl` 12px → 20px (four). Proof:
  `grep -rnE 'rounded-\[[0-9.]+px\]|border-radius: *[0-9.]+px' src --include='*.tsx' --include='*.css' | grep -v 'src/components/ui/'`
  must stay empty. Full delta table in `docs/research/assistant-ui-design.md`, "Applied 2026-09-11".
- **Codex's 12.5px row corner is now "nearest scale step", not a match (2026-09-11, `ui/sidebar`).**
  `--sidebar-row-radius` is `var(--radius-row)` = 10px. `docs/research/codex-sidebar.md` §4.4 still
  measures 12.5px; that number is now a reference, not the value in the tree. Same for the tooltip
  surface: §4.9 measures `rgb(45,45,45)` and `--tooltip` is `var(--popover)` = `#2b2b2b`, two units
  away, unified on the owner's instruction rather than kept as a fourth near-identical grey.
- **`.brigadier-composer` was silently overriding `rounded-composer` (2026-09-11, `ui/sidebar`).**
  Both sit on the same element (`src/components/PromptInput.tsx:164` puts the class on
  `ComposerBar`, which carries `rounded-composer`), and the unlayered rule in
  `src/components/composer/composer.css` beats the `@layer utilities` one — so `--radius-composer:
  28px` was dead and the composer wore a 23px literal. Both read the token now and the corner moved
  23px → 28px. If a composer corner ever looks wrong, check for an unlayered class fighting a
  utility on the same node before changing the token.
- **A `var(--token, #literal)` fallback defeats a theme edit (2026-09-11, `ui/sidebar`).** 26 of
  them were stripped from `composer.css` and `thread-context.css`; several were already stale —
  `var(--color-elevated, #292929)` when `--color-elevated` is `#2b2b2b`. Every `--color-*` name is
  emitted unconditionally by `@theme static`, so the fallback never fires in the app and only fires
  where the token is genuinely missing, which is exactly where you want to see the breakage.
- **`src/components/TerminalView.tsx` reads its ANSI palette from CSS (2026-09-11, `ui/sidebar`).**
  Sixteen hex literals became `--ansi-*` on `:root`. The reader returns `undefined`, not a literal,
  when a token is missing, so xterm falls back to its own default for that slot — do not
  reintroduce a hardcoded fallback to "be safe"; that is the second copy this change removed.
- **`projectId === null` in the main pane means "no projects at all", not "none picked"
  (2026-09-11, `ui/sidebar`).** `src/App.tsx:409-421` runs whenever `navigation.loaded &&
  projectsLoaded` and forces `selectedProjectId` to `projects[0]` the moment the list is non-empty,
  so the null case survives only while the list is empty (or, for one frame, while it loads). That
  is the state `src/components/WelcomeScreen.tsx` draws — the bb-style mark-plus-action-rows empty
  screen — and `NewConversation` in `src/components/ThreadView.tsx` now only ever sees a real
  project id. Do not add a "pick a project" affordance to that screen on the assumption that
  projects exist behind it; the screen asks `listProjects()` and disables **New chat** when they do
  not. Its three rows call existing paths only — `pickDirectory()` + `addProject()` +
  `brigadier-navigation-changed` (the two calls `App`'s own `pickProject` makes),
  `brigadier-new-chat`, and `brigadier-open-notes`. There is no recent-repos importer and no tour
  to link to, so no row was invented for one.
