# STATUS — where the brigadier harness actually stands

Last updated 2026-09-02. **This is the file to read first.** It says what is built, what is proven,
what is broken, and what will bite you. The product it is building toward is `docs/vision.md`.

No invented progress. A feature "works" only after it has been run. One line per fact, a path or a
number instead of an adjective, and what was not checked is said outright.

---

## 1. The tree right now

`main` at `2327bb9`. **The working tree is dirty and nothing is staged.** Another session produced
this and is holding it pending the owner's approval:

- modified: `crates/claude-spike/src/{main,session}.rs`, `crates/supervisor/src/{error,lib,worktree}.rs`
- new: `crates/claude-spike/src/wall.rs`, `crates/core/src/wall/` (the Bash classifier, 1,831 lines,
  37 tests), `crates/supervisor/src/handoff.rs` (**parked — see §5**)
- new fixtures: `crates/claude-spike/fixtures/s8-*`, `s9-*`, `s10-*` (12 NDJSON captures)

Anything below that says "measured" was measured at `2327bb9` unless it cites one of those fixtures.

## 2. Built and live-proven

Proven against a real `claude` 2.1.258 child, not asserted:

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

**Never clicked in a real window:** the Resume button, the branch chip and the cleanup flow are
wired and exercised only by the browser mock. **There is no front-end test runner at all**, so every
claim about front-end wiring in this file was verified by reading. That is the largest unverified
surface in the repo and phase-4 W4-A closes it before the frontend is rebuilt.

## 3. Gates at `2327bb9`

```
cargo test --workspace                                209 passed, 0 failed, 5 ignored
cargo clippy --workspace --all-targets -- -D warnings exit 0
cargo doc --workspace --no-deps                       0 warnings
npx tsc --noEmit && npm run build                     ~258 kB JS
npm run tauri build                                   target/release/bundle/macos/brigadier.app
```

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
| spawn → `system/init` | **1,981 ms** | `claude-direct-spike.md` |
| spawn → `initialize` response | 719 ms | same |
| stdin closed → exit 0 | 571 ms | same |
| exec → real project list (p50) | **292 ms** | `perceived-performance.md` |
| WKWebView construction alone | ~100 ms | same |
| React 19 + 258 kB bundle, FCP cost over a 400-byte page | ~12 ms | same |
| window refresh rate | 60 Hz over 1,513 one-second samples | same |
| search results, median | 127 tokens (8.2% of tool tokens; `Read` is 73%) | `codebase-index.md` |
| whole-repo symbol map rebuild | 145 ms | same |
| raw NDJSON on this machine | 66 MB / 23 sessions | `worktree-cleanup.md` |
| provider transcripts on this machine | **3.0 GB** | same |

## 5. Defects — what was found, and what is left

Eight were found on 2026-09-02 by research agents. **Seven are fixed**; one is open. Verified
against the code on 2026-09-02, not against a report.

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
   shell, outside every approval prompt. `core.fsmonitor` set to a command ran the same way.
   Mitigated by blanking `smudge`/`clean`/`process` per filter and disabling `core.fsmonitor`.
7. **`prepare` accepted two inputs it should refuse** — a project root that is itself a linked
   worktree, and repos with submodules. Both now typed refusals
   (`crates/core/src/worktree.rs:92,106,121`). 36 worktree tests.
8. **`src/feedStore.ts` discarded the 500-row seed** whenever a live batch won the race. Fixed at
   `53c3491` with a two-pointer merge keyed on the envelope `seq`.

**Still open — one:**

- **The `Agent` tool runs subagents asynchronously and the adapter drops the second `result`.** One
  user message produced two `result` frames; `on_result` takes `self.open_turn` and returns early on
  the second (`crates/core/src/claude/adapter.rs:678-681`). A turn reads complete when a subagent
  *launches*, and the second result's cost never reaches the store. `docs/vision.md` §6 routes around
  this path by design — brigadier spawns workers as its own children — so it is not load-bearing for
  the product, but any session where the model reaches for `Agent` itself under-reports, and silent
  under-counting on a usage-window product is the failure mode you cannot see from outside.

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
- `docs/vision.md` §6 originally claimed fan-out pays N equally-sized worker windows plus a
  coordinator. **Wrong**: a subagent's window is 42% *smaller* than a harness-spawned child's.
  Corrected 2026-09-02; the conclusion survived, the mechanism did not.
- `docs/research/agent-sdk.md` documents an SDK the harness does not use. Rust speaks the CLI's
  control protocol directly. Read it for wire shapes, never as an instruction to add a dependency.

## 7. Dead ends — do not rebuild these

- **The handoff wall** (refuse `send_turn` past 700k) is parked and must not be committed. Two
  independent reasons: `docs/vision.md` removes the accumulating session so it could never fire, and
  it was counting the wrong number anyway — `modelUsage` is cumulative across turns, so summing the
  four counters gives lifetime spend, not context footprint. It would have fired after ~7 turns on a
  session using 100k of a 1M window. `context_status` survives as telemetry.
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


