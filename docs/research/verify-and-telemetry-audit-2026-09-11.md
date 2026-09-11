# P7 audit — `verify.rs`, cancellation ownership, provider telemetry, session startup

**Date** 2026-09-11. **Scope** the P7 that survives review B8: a `verify.rs` audit plus telemetry.
The prompt-construction half is deleted (`docs/plans/efficiency-plan-review-2026-09-11.md:167-189`).
**Method** read-only. Nothing was built, run, or executed; a performance capture was running on this
machine. Every claim below is tagged:

- **[verified]** — read off the source at the cited `file:line` in this worktree
  (`/Users/stephen/Development/brigadier-ai.worktrees/perf-efficiency`, branch
  `perf/efficiency-p3-p5b-p6`, tip `c8da07b`).
- **[measured]** — a number produced by a run recorded elsewhere in the tree, quoted with its source.
  **No number in this file was measured by this audit.**
- **[asserted]** — inference from the code, not observed.

Another worker's uncommitted edits to `src-tauri/src/{keep_awake,composer,sink,peer_sessions}.rs`
were present and are excluded; nothing cited here is in those files.

---

## 1. How a phase's `verify_command` is run

### 1.1 The mechanism

`crates/supervisor/src/verify.rs` is one public entry point, `run(env, req)` at `:287`, over a
`GateRequest { command, cwd, log_path, timeout }` (`:216-230`). **[verified]**

| Property | Where | What it does |
| --- | --- | --- |
| Shell | `verify.rs:320` | `Command::new(env.shell()).arg("-c").arg(script)`. The shell is `$SHELL`, falling back to `/bin/sh` (`loop_/mod.rs:897-899`). |
| pipefail | `verify.rs:312-317`, probe at `:450-468` | `set -o pipefail\n` is prefixed **only** if a probe of that shell exited 0. Separator is a newline, not `;`, so a leading comment or heredoc survives. |
| PATH | `verify.rs:478-494`, `:496-531`, `:537-552` | `$SHELL -l -i -c 'printf %s "$PATH"'` under a 10 s timeout (`PATH_PROBE_TIMEOUT`, `:50`), falling back to the inherited `PATH`; then well-known toolchain dirs that exist on disk are appended (`:537-552`). The source is recorded as `PathSource::{LoginShell,LoginShellTimedOut,Inherited,Explicit}` (`:86-100`) so a later 127 is explainable. |
| Other env | `verify.rs:326-341` | Inherits, then overrides `PATH`, `LC_ALL=C`, `LANGUAGE=`, `GIT_TERMINAL_PROMPT=0`, `CI=1`, and `env_remove("MAX_THINKING_TOKENS")`. `CI=1` is flagged in-file as **asserted**, not verified for this repo's runners. |
| stdin | `verify.rs:343` | `Stdio::null()`. An interactive prompt EOFs instead of wedging. |
| Output | `verify.rs:309-310`, `:344-345` | One `File::create(log_path)` plus a `try_clone`; both fds share one file description, so stdout and stderr interleave in write order. **Output is never piped into the harness and never capped** — the cap is that `GateResult` carries only `log_path` (`:236-253`), not a byte of content. |
| Process group | `verify.rs:349` | `process_group(0)` on unix, so pid == pgid. |
| Timeout | `verify.rs:355-378` | `tokio::time::timeout(req.timeout, child.wait())`; on expiry `kill_group` then `child.wait()` to reap, and the reason is `TimedOut` with `exit_code: None`. |
| Exit-code capture | `verify.rs:381-392` | `status.code()`: `Some(0)` → `Passed`; `Some(127)` → `CommandNotFound` (a plan defect, its own slug); other `Some` → `Failed`; `None` (signalled) → `Signalled`, **red**. Only `Passed` is green (`:120-124`). |

`GateEnv` (`:142-212`) holds the resolved `PATH` + `pipefail` answer and is documented as "built once
per launch and shared" (`:139-141`). **It is not built once per launch in practice** — see §5(a1).

### 1.2 Exclusion: two gates cannot share a tree

`run_owned` takes `WorkspaceLease::acquire(&req.cwd)` as its first act (`verify.rs:301-302`).
`acquire` is `Mode::Exclusive` (`crates/core/src/checkpoint/lease.rs:32-34`) and uses **non-blocking**
`try_lock` (`lease.rs:114-120`): a second acquirer gets an `Err`, not a wait. The lock key set covers
the path itself (exclusive) and each ancestor (shared) (`lease.rs:103-108`), so:

- two gates on the **same** worktree cannot run concurrently — the second returns
  `std::io::Error` from `verify::run` and is surfaced by `run_gate` as a `LoopError::Io`, **not** as a
  red `GateResult`; **[verified]**
- two gates in **sibling** worktrees under one project root are permitted (each takes exclusive on
  its own key, shared on the shared ancestors), which is exactly what `docs/vision.md:147-152`'s
  red-gate fusion needs; **[verified]**
- a gate in `<root>/.brigadier/worktrees/<id>` (`crates/supervisor/src/worktree.rs:31`) holds a
  **shared** lock on the project-root key, so it excludes any `WorkspaceLease::acquire(project_root)`
  — e.g. `src-tauri/src/source_control.rs:68-69`, `src-tauri/src/composer_workspaces.rs:192` — for the
  gate's whole duration. **[verified]**

Side note, not a P7 item: every `WorkspaceLease::open` does a full `read_dir` of the lock registry
(`~/.brigadier/workspace-locks-v1`) with a 100,000-entry bound (`lease.rs:147-152`), on every acquire.
Cost is O(entries in that directory) syscalls per gate run, per git status, per terminal open.
**[verified]**, size unmeasured.

### 1.3 How results are recorded

- **Store.** `green::integrate` returns `Outcome::{Green,Red}` and `loop_/mod.rs:788-830` writes one
  row via `phase_settled(id, state, exit_code, evidence, commit_sha, at)`
  (`crates/store/src/writer.rs:728-745`). Columns are `phases.last_exit_code` and
  `phases.last_evidence` (`crates/store/src/plan.rs:342`). No `GateResult` is persisted; `GateResult`
  derives `Serialize` but nothing in the non-test tree serialises it. **[verified]**
- **Wire.** `PhaseView` carries `verify_command`, `last_exit_code`, `last_evidence`
  (`src-tauri/src/views.rs:222,248`; `docs/plans/ipc-contract.md:756`). The contract's own rule: the
  verify command's output "goes to a file and to a worker's window, **never into the thread**"
  (`ipc-contract.md:779-782`), and the UI clamps `last_evidence` to one line / 120 chars
  (`ipc-contract.md:866-869`).
- **Files.** `<data_dir>/gates/<phase_id>/<attempt>.log` (`loop_/mod.rs:888-895`); the competing-arms
  record at `<...>/<attempt>.alternatives.json` (`ladder.rs:411-414`); review reports at
  `<...>/<attempt>.review-<uuid>.json` (`review.rs:86-88`). Cleanup removes
  `<data_dir>/gates/<phase_id>/` per phase (`ipc-contract.md:547`).

### 1.4 Every place a gate can run — and the one duplicate

Five call sites of `super::run_gate`, all inside one `integrate` of one phase: **[verified]**

| # | Site | cwd | log attempt | When |
| --- | --- | --- | --- | --- |
| 1 | `green.rs:124` | integration worktree | `attempt` | always |
| 2 | `green.rs:173` | same integration worktree | `attempt+1` | after the rung-1 ordinary repair |
| 3 | `ladder.rs:366` (index 0) | alternative-A worktree | `attempt+2` | rung-2 arm A |
| 4 | `ladder.rs:366` (index 1) | alternative-B worktree | `attempt+3` | rung-2 arm B |
| 5 | `green.rs:237` | the **winner's** worktree | `attempt+4` | final validation of the selected arm |

Sites 1–4 each run on a different tree state, or after a fixer wrote to the tree. They are not
duplicates.

**Site 5 is a concrete duplicate of site 3 or 4** for the winning arm: same `command`
(`phase.verify_command`, threaded unchanged), same `cwd` (`integration = winner.path`,
`green.rs:234`), same `GateEnv` (`env` is passed by reference into `competing` at `green.rs:206` and
reused at `green.rs:237`). Between the two runs, on that same worktree, only these happen:
`git status --porcelain --untracked-files=all` asserted empty (`ladder.rs:377-383`); two reviewer
calls and a review judge in that worktree under `PermissionMode::Plan` with a "Read only: do not
edit" prompt (`review.rs:55,66,76`); and a selection judge in `CallCwd::ProjectRoot`
(`ladder.rs:404-408`). **[verified]** that no harness code writes to the winner's tree in between;
**[asserted]** that the reviewer children do not, since that rests on the CLI honouring Plan mode and
on the prompt, neither of which is enforced here.

That is the only duplicate found. It is also the run the plan explicitly protects — "Keep final
integration validation and honest per-request evidence"
(`docs/plans/efficiency-and-rendering-plan-2026-09-11.md:239`). See §5(a2) for the only form in which
joining it would be defensible, and the evidence that would be needed first.

**No duplicate exists anywhere else.** Specifically:

- The app exposes **no** command that runs a verify command. Every non-test reference to
  `verify_command` outside the loop is a display or validation path
  (`src-tauri/src/views.rs:222,248`, `src/components/RunCard.tsx:123-130`,
  `crates/supervisor/src/action.rs:776-785,858`). **[verified]**
- A red phase is written `PhaseState::Blocked` (`loop_/mod.rs:809-826`) and `state::derive` returns
  `Blocked(Recorded(..))` for it thereafter (`loop_/state.rs:96-98`), so the loop never re-gates a
  blocked phase on its own. **[verified]**
- Only one run may be live per launch (`src-tauri/src/commands.rs:961-969`), so two runs cannot gate
  the same project concurrently. **[verified]**
- A crash mid-gate leaves the phase `Collected`; on restart `integrate` runs again, but it first
  builds a **fresh** integration worktree via `prepare_from` (`green.rs:88-90`), so the second gate is
  not the same tree instance. Joining it would require trusting a cross-launch identity claim; not
  proposed. **[verified]**

**No generic test-result cache is proposed.** The plan forbids one by default
(`efficiency-and-rendering-plan-2026-09-11.md:239`) and nothing here earns an exception.

---

## 2. Cancellation ownership

**Stop is per-run, and a gate's kill is scoped to its own process group.** **[verified]**

1. `RunHandle::stop` (`loop_/mod.rs:422-432`) persists a `stopped` marker file and sets one
   `Arc<AtomicBool>` created per `Run` (`loop_/mod.rs:998-1004,1028`). `Supervisor::stop_run(plan_id)`
   resolves exactly one handle by plan id (`loop_/mod.rs:1050-1058`).
2. `run_gate` (`loop_/mod.rs:1074-1092`) polls `run.stop` and, when set, returns
   `ErrorKind::Interrupted` and **drops** the `verify::run` future.
3. Dropping it drops the oneshot **sender** created at `verify.rs:289`. The gate itself runs in a
   detached `tokio::spawn` (`verify.rs:290`) whose `select!` arm (`verify.rs:357-360`) observes the
   closed receiver and calls `kill_group(&mut child, pid)` then `child.wait()`.
4. `kill_group` (`verify.rs:423-443`) calls `brigadier_proc::sweep::kill_group_sync(pgid, KILL_GRACE)`
   where `pgid` is the child's own pid, because it was spawned with `process_group(0)`
   (`verify.rs:349`). SIGTERM, grace, SIGKILL, over that group only. On failure it falls back to
   `child.start_kill()`. **The kill is scoped to the verify's own group.**

**Can one waiter kill another's check?** No path found. **[verified]**

- Only one live run per launch (`commands.rs:961`), and the stop flag is per plan.
- `RunHandle::cancel` (`loop_/mod.rs:440-452`) aborts the orchestration task. Its two callers are
  ownership-scoped: deleting a session that a run owns (`crates/supervisor/src/lib.rs:1994`), and
  removing a project whose plan it is (`lib.rs:2226`). An abort drops the same future chain and lands
  on the same group kill.
- The two rung-2 arms run **serially** in one `for index in 0..2` loop (`ladder.rs:348`), not
  concurrently, so there are never two gates with two waiters inside one phase.
- Cross-run collision is prevented by exclusion, not by killing: the second `WorkspaceLease::acquire`
  errors (§1.2). No code anywhere signals another gate's group.

**Two gaps, both real:**

- **G1 — a cancelled gate's kill is unobserved.** Once `verify::run`'s future is dropped the detached
  task is nobody's: no `JoinHandle` is retained (`verify.rs:290-292` drops it with the future), so the
  loop proceeds while `kill_group_sync`'s TERM→grace→KILL is still in flight, holding the
  `WorkspaceLease` on that worktree (`verify.rs:301`). A caller that immediately re-acquires the same
  cwd can fail. **[verified]** structurally; **[asserted]** as to whether any caller does.
- **G2 — the gate's process group is not registered with the orphan sweep.** `verify.rs` contains no
  reference to `PidTracker` or a pid record (grep: 0 hits). The startup sweep
  (`src-tauri/src/state.rs:18`, `brigadier_proc::sweep::sweep`) only judges pid **records**
  (`crates/proc/src/sweep.rs:262`). A force-quit during `cargo test` therefore leaks that group and
  nothing at next launch reaps it. **[verified]** — this is a P8 item, recorded here because it is the
  verify path.

**One non-gap worth naming:** `run_gate` uses a 50 ms `tokio::time::sleep` poll of the stop flag for
the entire wall-clock duration of the gate (`loop_/mod.rs:1088-1091`), and the run loop has a second
50 ms poll (`loop_/mod.rs:551`). Over a multi-minute `cargo test --workspace` that is ~20 wakeups/s on
a task with nothing to do. It is correctness-neutral and belongs to P2's timer inventory, not P7.
**[verified]**; cost unmeasured.

---

## 3. Telemetry

### 3.1 Where it is parsed

| Field | Parsed at | Note |
| --- | --- | --- |
| `rate_limit_event` | `crates/claude-wire/src/message.rs:95-96` (cites `sdk.d.ts:4842`) | typed variant |
| `rate_limit_info.unifiedWindows` | `crates/core/src/claude/adapter.rs:2295-2328` (`usage_windows`) | open key set; an entry missing `utilization` or `resetsAt` is skipped; `utilization` is clamped to 0..1 and a non-finite value is refused, not clamped |
| `modelUsage` → `inputTokens`/`outputTokens`/`cacheReadInputTokens`/`cacheCreationInputTokens`/`contextWindow` | `adapter.rs:2485-2497` | summed **across models within one `result`** |
| `usage.cache_read_input_tokens` / `cache_creation_input_tokens` (snake_case) | `adapter.rs:2500-2510` | fallback only, when `modelUsage` is absent or empty |
| `total_cost_usd` | `adapter.rs:2413,2429,2446,2456-2459` | passed through untouched |
| `unifiedWindows` for the allowance gate | `crates/core/src/allowance.rs:135-152` (`exhausted`) | |
| last-observed window blob, per instance | `crates/core/src/claude/capabilities.rs:92-109` | `usage()` returns `Option`; doc at `:93`: "None means unknown, never unlimited" |

### 3.2 Is per-turn `usage` summed in a way that double-counts or misses subagents?

**Not within a `result`, and not across `result` frames — the known risk is on resume.** **[verified]**

- `ResultView::usage` prefers `modelUsage` and only falls back to the main-loop `usage` object
  (`adapter.rs:2479-2510`). The doc comment at `:2479-2483` states the exact reason B8 asks for:
  `modelUsage` "includes subagents, sidechains and compaction, where `usage` is main-loop-only", every
  number is cumulative for the session, and it is read from the latest `result`, **never summed across
  frames**. This matches `docs/research/efficiency-plan-external-facts-2026-09-11.md:305-312`.
  **P7's trap #1 is already closed in code.**
- No per-**step** / per-assistant-message `usage` is accumulated anywhere: the only writer of
  `Event::TurnCompleted { usage }` is `on_result` (`adapter.rs:1338-1344`).
- **The live double-count risk is `Accrued::rebase`.** On a resumed session the supervisor adds the
  row's stored totals to every `TurnCompleted` (`crates/supervisor/src/lib.rs:224-256`). The adapter's
  own doc records the interaction and calls it an accepted, unguarded risk: a stray `result` with no
  open turn used to be discarded and is now translated into a minted turn (`adapter.rs:1310-1323`), so
  "a replayed or duplicated frame carrying a previous child's cumulative figure therefore **doubles**
  the row… On a usage-window product an over-count trips the 80% reserve early, which is the direction
  that costs the owner his own Claude Code. No fixture produces such a frame; nothing guards it"
  (`adapter.rs:1297-1302`). **[verified]** that the text and both code paths exist; **[asserted]**, per
  that same comment, that no capture produces the frame.
- Related and documented, not a defect: `supervisor::context_size` sums input + output + both cache
  counters (`lib.rs:180-186`) and is **lifetime spend, not a context footprint**; its doc says
  subagent turns are not excluded because nothing in the store distinguishes them
  (`lib.rs:163-177`). One consumer, `lib.rs:1792`.
- One-per-session caveat: `docs/vision.md:192-197` records **[measured]** that exactly one
  `rate_limit_event` fires per session, at 804–984 ms, reporting utilization *before* that session's
  own spend. `crates/core/src/event.rs:352` says "Arrives once per turn, early." Those two sentences
  disagree; the vision file cites a measurement and the event doc does not. **Flagged, not resolved.**

### 3.3 Is anything shown in dollars?

**No dollar figure is rendered anywhere.** **[verified]** by grep over `src/` and `crates/` for
`usd`, `cost`, `$`:

- Rust: `Event::TurnCompleted.cost_usd_cumulative` exists (`event.rs:217`) and reaches
  `SessionView::cost_usd_cumulative` (`src-tauri/src/views.rs:134,156`). `views.rs:164-168` states the
  rule and `views.rs:798-814` is a test that asserts no run shape serialises any of
  `cost|usd|dollar|price|spend`.
- TypeScript: the field stops at the store. `src/wire.ts:189,436` types it; `src/feedStore.ts:219,506`
  and `:1195` keep `costUsd` on `SessionRuntime`. **No `.tsx` reads `costUsd`** — the only non-store
  hits are `src/sessionStartup.ts:49` (initialiser) and `src/feedStore.test.ts`.
- `src/components/UsageWindows.tsx:74-81` states the invariant at the one place that could break it:
  "`total_cost_usd` exists on the provider's wire and stops at `src/wire.ts`. No currency is formatted
  here, and the component takes no cost input that could be."
- `Event::UsageWindows` itself has no cost field and `event.rs:352-354` forbids adding one.

### 3.4 Is `unifiedWindows` handled with an explicit unknown state when absent?

**Partly. The Rust side is explicit; the UI expresses unknown as absence.** **[verified]**

- Parse: absent `unifiedWindows` → empty vec, never a zeroed window (`adapter.rs:2308-2310`).
- Emit: `adapter.rs:714-716` emits `Event::UsageWindows` **only** `if !windows.is_empty()`. Absent
  telemetry therefore produces no event at all.
- Allowance gate: `allowance.rs:2` — "Absence is unknown"; `exhausted` (`:135-152`) fires only on
  explicit evidence (`status` in `rejected|denied|rate_limited`, `codexErrorInfo`, `usedPercent >= 100`,
  `utilization >= 1.0`). Absent data never blocks and never reads as free.
- Last-observed registry: `capabilities::usage` returns `Option`, documented "None means unknown,
  never unlimited" (`capabilities.rs:93-94`), with a test named
  `unknown_usage_is_not_zero_and_observed_windows_survive` (`capabilities.rs:121-127`).
- **UI:** `UsageWindows.tsx:91-93` — `if (lead === null) return null;` with the comment "No reading yet
  is not '0% used'." Correct, but the unknown state is **invisible**: the gauge simply is not there,
  and nothing tells the owner whether that means "no reading yet" or "component missing".
- **The window signal is not persisted.** `crates/store/src/feed.rs:242` returns `None` for
  `Event::UsageWindows` — it is a live signal, not a feed row — and `src/feedStore.ts:1259,1287` drops
  it when the session goes. So after a restart the gauge is blank until a new session emits one, even
  though `capabilities::usage` and `provider-allowance.json` still hold the last reading.
- **The 80% reserve is drawn but not enforced.** `RESERVE = 0.8` exists only in
  `src/components/UsageWindows.tsx:14` and is used only for the gauge's mark, label and "past reserve"
  text (`:54,60-61,94,101,109-110,129`). Grep for `reserve` across `crates/core/src`,
  `crates/supervisor/src` and `src-tauri/src` returns **no dispatch gate** — the only matches are
  unrelated (`tokio::mpsc::reserve`, `preserve`, session turn reservation). `docs/vision.md:186-190`
  describes the reserve as a per-dispatch gate ("narrowing concurrency as it approaches and parking
  below it"); `docs/vision.md:198-201` calls it "a **per-dispatch gate, not a live control loop**".
  **That gate does not exist in this tree.** Only full exhaustion (`utilization >= 1.0`,
  `allowance.rs:149-151`) has any effect. **[verified]** — out of P7's scope to fix; recorded because
  P7 was asked where the telemetry surfaces and this is where it does not.

---

## 4. MCP / hook / status-script startup

### 4.1 What the harness injects

`crates/core/src/claude/process.rs:124-168`, `build_argv`, in the SDK's own order: **[verified]**

```
--output-format stream-json --verbose --input-format stream-json
[--model M] [--effort E]
--include-partial-messages --permission-prompt-tool stdio
[--resume=<id> [--fork-session]]
[--strict-mcp-config]                       # iff spec.mcp == McpPolicy::Off (the default)
[--disallowedTools Agent,Task]              # iff BRIGADIER_PEER_TOKEN is in env_overrides
[--mcp-config {"mcpServers":{"brigadier":{"type":"stdio","command":$BRIGADIER_EXECUTABLE,"args":["--peer-mcp"]}}}]
--permission-mode <kebab>                   # always last
```

- `--strict-mcp-config` and `--permission-mode` last are pinned, as CLAUDE.md §5 records. The argv
  order is asserted by tests at `process.rs:542-560,621-637`.
- **Hooks are in-band, not processes.** The whole hook payload is
  `{"PreToolUse":[{"matcher":"","hookCallbackIds":[PRE_TOOL_USE_CALLBACK_ID]}]}` sent inside
  `initialize` (`crates/core/src/claude/adapter.rs:477-488`). One callback id, `matcher: ""` so it
  fires for every tool. **No hook command, no hook script, no `.claude/settings.json` entry, and no
  status script anywhere in the tree.** This is B8's "nothing to audit" for prompt/hook mutation
  (`efficiency-plan-review-2026-09-11.md:168-170`). **[verified]**
- No `--settings` and no `--setting-sources` are passed, deliberately (`process.rs:117-123`), so the
  user's own settings, hooks and MCP servers still load unless `--strict-mcp-config` suppresses the
  MCP half.
- `--bare` is not used and must not be: it never reads OAuth or the keychain and needs an API key,
  which conflicts with the settled subscription-only decision
  (`efficiency-plan-external-facts-2026-09-11.md:341-347`). **Closed on auth, not on startup cost.**

### 4.2 Is any of it redundant per session?

**No.** **[verified]**

- The peer MCP server is injected only when `BRIGADIER_PEER_TOKEN` is set, and that token is a fresh
  UUID minted per session in `peers::prepare` (`src-tauri/src/peers.rs:287-292`), alongside a
  per-session `BRIGADIER_PEER_ENDPOINT`. **It cannot be pooled across sessions**: the token is the
  session's identity. `src-tauri/src/peer_mcp.rs` carries 14 orchestration tools and no read/grep/
  search tool, so there is nothing there for a provider-side search to route through — B8's close of
  P6's agent-side reuse (`efficiency-plan-review-2026-09-11.md:172-176`) stands unchanged.
- The one piece of harness-authored **prompt** text: `peers::prepare` prepends ~7.2 KB of
  `orchestration_instructions()` to the session's **first** user prompt (`peers.rs:287,301-311`,
  instructions at `peers.rs:288-289`). It is written once, at the head of the conversation, and never
  mutated mid-session, so it sits inside the cacheable prefix rather than invalidating it. This is the
  single qualification to B8's "no prompt assembly anywhere"; the conclusion is unchanged.

### 4.3 What the harness itself spawns

Per **app launch** (not per session): **[verified]**

| Spawn | Where | Cost |
| --- | --- | --- |
| `claude --version` | `crates/core/src/claude/binary.rs:33-40` via `ClaudeDriver::probe` at `src-tauri/src/state.rs:272`, called from `state.rs:338` (build) and `state.rs:203` (`probe_claude`, re-probe) | 1 process, plus 1 more on every explicit re-probe |
| `codex --version` | `crates/core/src/codex/mod.rs:59-66` | 1 process |
| `codex` app-server RPC child | `crates/core/src/codex/mod.rs:74` (`Rpc::spawn`), killed at `:87` after `initialize` + `account/read` + capability discovery + `account/rateLimits/read` | 1 process, spawned at launch **even if Codex is never used** |
| `$SHELL -l -i -c 'printf %s "$PATH"'` | `verify.rs:496-531` | up to 10 s, once per `GateEnv` — see §5(a1) for how many `GateEnv`s exist |
| `sh -c 'set -o pipefail'` | `verify.rs:450-468` | 1 process per `GateEnv` |

Per **session start** with a worktree, happy path, `prepare_named`
(`crates/supervisor/src/worktree.rs:430-537`): **12 git processes plus 1 `claude`.** **[verified]** by
reading each helper; **[asserted]** that no path adds more.

| Step | Line | git processes |
| --- | --- | --- |
| `is_repo` → `git_common_dir` | `:444` / `core/worktree.rs:634-636,645` | 1 |
| `show_toplevel` | `:461` | 1 |
| `main_worktree_of` → `show_toplevel` **again** + `git_common_dir` **again** | `:475` / `core/worktree.rs:831-834` | 2 |
| `has_commits` (`rev-parse --verify HEAD`) | `:483` | 1 |
| `has_submodules` (`submodule status`) | `:497` | 1 |
| `check_ref_format` | `:510` | 1 |
| `resolve_commit` (`rev-parse --verify <rev>^{commit}`) | `:514` | 1 |
| `add_or_rollback` → `filter_neutralising_env` (`config --list --name-only -z`) | `:522` / `core/worktree.rs:222-234` | 1 |
| `add_or_rollback` → `worktree add` | `core/worktree.rs:318-342` | 1 |
| `add_or_rollback` → `worktree list --porcelain -z` | `core/worktree.rs:345` | 1 |
| **Total** | | **12** |

Then 1 `claude` child (`process.rs:234`). With peers enabled the CLI itself spawns one
`$BRIGADIER_EXECUTABLE --peer-mcp` — a second copy of the harness binary, per session, not poolable.

Two of those 12 are exact repeats issued microseconds apart against an unchanged tree — see §5(a3).
`ensure_excluded` is **not** in this path; it runs from `add_project` only, and says so
(`crates/supervisor/src/worktree.rs:589-601`).

---

## 5. Conclusions

### (a) Safe, supported reuse — what exists, and what could be added

**a0 — what already exists and needs nothing.**
The exclusion design already prevents the class of duplicate P7 worried about: two gates cannot run on
one tree at all (`verify.rs:301`, `lease.rs:114-120`), the loop never re-gates a blocked phase
(`loop_/state.rs:96-98`), and only one run is live per launch (`commands.rs:961`). Telemetry already
uses `modelUsage` over per-step `usage` (`adapter.rs:2479-2510`), so no sum to fix. **Evidence needed:
none — cited above.**

**a1 — resolve the login-shell `PATH` once per process, not once per `Run` and again for updates.**
`Run::gate_env` caches into `self.gate`, which is per `Run` (`loop_/mod.rs:874-886,345`), and no caller
ever supplies `spec.gate` (grep over `src-tauri/src`: `RunSpec` is built at `commands.rs:971` and
`gate` is never set). `src-tauri/src/updates.rs:9,128` keeps a **separate** `OnceCell<GateEnv>` on
`/bin/sh`. So the 10 s worst-case `$SHELL -l -i -c` probe can be paid twice or more per launch. The
shells differ (`$SHELL` vs `/bin/sh`, `loop_/mod.rs:897-899` vs `updates.rs:128`), so the whole
`GateEnv` cannot be shared — but `resolve_path()` (`verify.rs:478-494`) is a fact about the machine,
not the shell, and can be. Shape: one process-wide `OnceCell<(OsString, PathSource)>` feeding
`GateEnv::with_path` at both sites.
**Evidence needed before landing:** wall-clock of the probe on this machine (the in-file number is
5–13 s sampled twice under load, `verify.rs:41-49`, **[measured] weakly**); a test that the
`PathSource` recorded is still the one the probe produced; `cargo test --workspace` + `clippy -D
warnings` green. **Risk:** low; `pipefail` stays per-shell, so no behaviour moves.

**a2 — the one joinable gate, and the guard it would need.**
Site 5 (`green.rs:237`) re-runs the winning arm's own gate (§1.4). A defensible join is **not** a
cache: it is a same-process equality check inside `integrate` — skip site 5 **only if** all of
(i) same command string, (ii) same `cwd`, (iii) same `GateEnv` instance, (iv) `git rev-parse HEAD`
unchanged since the arm's gate, and (v) `git status --porcelain --untracked-files=all` byte-identical
to the empty listing already asserted at `ladder.rs:377-383`, re-taken immediately before the skip.
Any mismatch, or any inability to read (iv)/(v), runs the gate.
**Evidence needed before landing:** a test that a reviewer child which *does* write to the arm's tree
forces the gate to run; a test that a non-empty status forces it; confirmation that `PermissionMode::
Plan` on a worktree child cannot write (today this is asserted from the prompt at `review.rs:56` and
the mode at `:66`, not from a measurement); and the owner's call on whether a saved
`cargo test --workspace` is worth weakening "final integration validation"
(`efficiency-and-rendering-plan-2026-09-11.md:239`). **Recommendation: do not take it.** The saved run
is the last thing standing between a judge's pick and a phase commit, the guard is five conditions
where one wrong answer commits unverified code, and the win is one gate run on the rarest path in the
loop (rung 2, reached only after an ordinary repair already failed). Record it as found-and-declined
rather than implement it.

**a3 — drop two redundant git reads from session startup.**
`prepare_named` calls `is_repo` (→`git_common_dir`) at `:444` and `show_toplevel` at `:461`, then
`main_worktree_of` at `:475` re-runs **both** (`core/worktree.rs:831-833`). Two pure-read git
processes per session start, same tree, same instant. Shape: read `toplevel` and `common` once and
pass them into a `main_worktree_from(toplevel, common)`, leaving `main_worktree_of`'s public signature
for other callers. This is inside the measured spawn path — `docs/vision.md:345-347` records
**[measured]** 1,395 ms with the user's MCP servers / 643.5 ms without, so 2 of 12 git processes is a
real slice of the non-CLI part.
**Evidence needed before landing:** before/after wall-clock of `prepare_named` alone over ≥20 runs on
one repo; the existing worktree tests green, including the linked-worktree and non-root refusals
(`worktree.rs:461-478` are safety checks — the refusals must be byte-identical); six gates.

**a4 — persist the last usage-window reading so the gauge is not blank after a restart.**
Not a duplicate-work item; a correctness-of-display one. `crates/core/src/claude/capabilities.rs:92-109`
and `provider-allowance.json` (`allowance.rs:42-56,58-73,75`) already hold the last reading, but
`crates/store/src/feed.rs:242` drops the event and the UI shows nothing
(`UsageWindows.tsx:91-93`). A stale reading must be labelled stale, never drawn as current.
**Evidence needed:** an owner decision on whether a stale window is better than no window, since
`docs/vision.md:192-197` records **[measured]** that the reading is already pre-spend and coarse
(two decimals, one per session).

### (b) Close as no-op, with the citation that closes each

| Item | Closed by |
| --- | --- |
| A generic test-result / build cache | `efficiency-and-rendering-plan-2026-09-11.md:239` forbids one by default, and §1.4 found exactly one duplicate — which §5(a2) declines. No second build system, no new cache. |
| "Audit prompt construction for unnecessary mutations to stable instructions" | Deleted by B8 (`efficiency-plan-review-2026-09-11.md:187-189`). Confirmed independently: `adapter.rs:477-488` sends `InitializeRequest { hooks, ..Default::default() }`, no `--append-system-prompt` in `build_argv` (`process.rs:124-168`), and the only harness-authored prompt text is written once per session at `peers.rs:301-311`. |
| "Do not add API caching flags the subscription CLI does not expose" | Nothing in `build_argv` touches caching; provider cache telemetry is read-only at `adapter.rs:2492-2493,2505-2506`. Nothing to remove. |
| `--bare` for startup cost | `efficiency-plan-external-facts-2026-09-11.md:341-347`: bare mode never reads OAuth or the keychain and requires an API key. Auth-model conflict with CLAUDE.md §2, not a cost trade. |
| "MCP schema deferral defers process startup" | `efficiency-plan-external-facts-2026-09-11.md:371-378`: **[documented — absent]**, there is no flag that defers a local stdio server's process startup. |
| Pooling the peer MCP server across sessions | Per-session UUID token and endpoint (`peers.rs:288-292`); the server authenticates as that session. The plan's own caveat — "some MCP servers hold session-specific state and cannot be pooled safely" — applies to ours. |
| Disabling hooks to save startup | There is no hook process to disable: one in-band `PreToolUse` callback id (`adapter.rs:477-479`). And the hook is the approval gate (`process.rs:95-105`), which is `docs/vision.md`'s one non-optimistic surface. |
| Status scripts / LSP | Neither exists in this tree. Grep for a status script: 0 hits. The plan's "starting additional language servers is conditional on net benefit" has no seam here. |
| Summing per-step `usage` (double-count / missing subagents) | Already correct: `adapter.rs:2479-2510` prefers `modelUsage` and reads the latest `result` without summing frames. |
| Dollars anywhere in the product | `views.rs:798-814` is an enforcing test; no `.tsx` reads `costUsd`; `UsageWindows.tsx:74-81`. |

### (c) Found, out of P7's scope, recorded so it is not lost

- **G2** (§2): a gate's process group is never registered with the pid tracker, so a force-quit leaks
  `cargo test`. P8.
- **G1** (§2): a cancelled gate's group kill is unobserved and still holds the workspace lease. P8.
- Two 50 ms poll loops in the orchestration path (`loop_/mod.rs:551,1090`). P2's timer inventory.
- `WorkspaceLease::open` does a full registry `read_dir` per acquire (`lease.rs:147-152`).
- The **80% reserve is drawn but not enforced** (§3.4). `docs/vision.md:186-190,198-201` describes a
  per-dispatch gate that does not exist in this tree. This is a product gap, not an efficiency one,
  and it is the largest single thing this audit found.
- `event.rs:352` ("once per turn") contradicts `docs/vision.md:192-197` (**[measured]** once per
  session). One of the two comments is stale.

### What was not checked

Nothing was executed: no build, no test, no gate, no timing. Every duration in this file is quoted
from another file's measurement and is labelled as such. I did not verify that `PermissionMode::Plan`
actually prevents a reviewer child from writing to its worktree — that is the load-bearing assumption
under §5(a2) and it is **[asserted]**. I did not read the store's SQL for `PhaseSettled`, only the
`Op` and the row type. I did not audit the Codex adapter's telemetry beyond noting its parse sites
(`codex/adapter.rs:750`, `codex/mod.rs:81`, `codex/capabilities.rs:126`). I did not count git
processes on the resume or `prepare_from_source` paths, only `prepare_named`. Line numbers are against
tip `c8da07b` with another worker's uncommitted edits present in four `src-tauri` files, none of which
is cited here.
