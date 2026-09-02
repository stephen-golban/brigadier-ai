# brigadier harness — phase 3: a session that survives and can be steered

Read `CLAUDE.md` first. Its first section is the one rule that overrides everything: research the
web before any design decision, library choice, API call, version pin or flag; write findings to
`docs/research/<topic>.md`; cite the file when you act. Check the existing briefs before buying new
research. Then read `docs/plans/ipc-contract.md` (the binding webview ↔ Rust contract) and this file.

## Where things stand (phase 2 committed on `main`)

- **Proven live, 2026-09-02, on the owner's machine:** the app starts a real Claude Code 2.1.258
  session from the UI on `claude-haiku-4-5`, streams its feed, stores the turn, and on Cmd-Q ends the
  child gracefully (368 ms, exit 0, row `exited`, raw log flushed, pid file removed). Two pong runs
  cost $0.0301 and $0.0041 (the second reused the prompt cache). Cmd-Q with ten live replay sessions
  drained all ten in 22 ms with nothing killed.
- **Measured feed under load (WKWebView, release-profile Rust, 10 replay sessions at 200 rows/s
  each, rows rendered):** p95 17–21 ms with 27 of 30 windows at or under 18 ms, worst frame 35 ms,
  20 dropped frames out of 1,854 in 8 windows, DOM flat at 545 nodes. Against the gate
  (0 dropped in every window, p95 ≤ 1.1 × budget) that is a **fail on the dropped clause by about
  1 %**; it is recorded as "near the bar, not at it". The gate was not loosened.
- **Gates at HEAD:** `cargo test --workspace` 177 passed, 0 failed, 1 ignored (`live_pong`);
  clippy `-D warnings` clean in debug and in `--release --features burn`; rustdoc 0 warnings;
  `npm run build` ~250 kB JS; `npm run tauri build` → `target/release/bundle/macos/brigadier.app`.
  `cargo` is at `~/.cargo/bin` (not on PATH in agent shells); `rustfmt` is not installed.
- **Crates:** `crates/core` (events, driver trait, session handle with `pid`, approvals, worktree
  module — built and tested but **unused**, Claude driver), `crates/claude-wire`, `crates/store`
  (SQLite: projects, sessions, ring-capped feed, approvals; settles stale sessions and expires
  approvals at open; `RawLog` NDJSON per session), `crates/supervisor` (managed sessions, per-frame
  batcher under 8,000 B and 24 rows per message, graceful `shutdown_with`, `ReplayDriver` from the
  spike fixtures), `crates/proc` (pid files, `proc_pidinfo` identity, group liveness by
  enumeration, startup sweep in one grace period, exit kill with identity re-check; the only
  `unsafe`), `src-tauri` (18 commands, `Channel` sink, shutdown on `RunEvent::Exit` because macOS
  Cmd-Q never emits `ExitRequested` — `docs/research/tauri-commands.md` §12 — SIGTERM/SIGINT hook,
  `burn` behind `--features burn` or debug), `src/` (feed on TanStack Virtual 3.14.10, approvals,
  sidebar with self-healing project list, new-session form, composer, FPS meter, browser mock).
- **Research briefs:** `agent-sdk.md`, `cli-protocol.md`, `claude-direct-spike.md`,
  `feed-rendering.md`, `long-sessions.md`, `orphan-sweep.md`, `persistence.md`,
  `provider-driver.md`, `sidecar-spike.md`, `substrate.md`, `t3code.md`, `tauri-commands.md`,
  `tauri-runtime.md`.

## Settled decisions (see `CLAUDE.md` §2; do not reopen)

Tauri v2, Rust core, direct stdio protocol, no sidecar. Never `claude -p`. Claude adapter first. The
`claude` binary is never bundled. Default model `claude-haiku-4-5`; the owner is under real
financial pressure, report every live run's cost from the store's `cost_usd_cumulative`.

## Landmines already paid for (do not rediscover)

- macOS Cmd-Q → `RunEvent::Exit` only; `ExitRequested` never fires (tao has no
  `applicationShouldTerminate`). Shutdown must run in the `Exit` arm; blocking there is legal.
- `#[tauri::command]` functions must be `pub(crate)` with crate-unique names; a `pub` command at the
  crate root does not compile. App commands need no capability entry as long as
  `src-tauri/permissions/` does not exist.
- A `Channel::send` after a webview reload is silently dropped; the front end re-subscribes on mount
  (StrictMode double-mounts in dev, harmless).
- An `Envelope` with a `raw` excerpt is ~4.3 KB; signals on the feed channel are sent with `raw`
  stripped. Keep every message under 8,000 B.
- The FPS meter's `hz` must snap to 120/60/30; a rounded p10 once produced 70 Hz and false reds.
- A process group outlives its leader; liveness is by group enumeration; a `setsid` grandchild
  escapes `killpg`. Never kill on a start-time mismatch.
- `USER` must survive in the child env. `CLAUDE_CONFIG_DIR` is the account boundary, never `HOME`.
- `system/init` arrives once per turn. Cost on `result` is cumulative. Interrupted `result` is
  `error_during_execution`; branch on `terminal_reason` first.
- The burn creates its own `burn` project under the temp dir; the sidebar self-heals from batches
  for unknown project ids.

## This phase, in order

1. **Approvals end to end, for real.** Research first: what `can_use_tool` looks like for `Bash`
   and `Write` on CLI 2.1.258 today (`docs/research/cli-protocol.md`, `claude-direct-spike.md` s2/s3
   fixtures), and how `PreToolUse` hook gating interacts with the pinned `--permission-mode`
   (`crates/core/src/claude/hook.rs` is allow-all today). Then: start a real session whose prompt
   forces one tool call (`Run \`ls\` and report the count`), see the prompt in the approvals panel,
   **deny** it, confirm the model saw the denial, then run a second turn and **allow**, confirm the
   tool ran. Cost bar: under $0.05 per attempt on Haiku. Persisted approvals across a webview reload
   (`pending_approvals`) verified in the same run.
2. **Resume.** Wire `resume_session` (proven at protocol level, s5 fixture) to a "resume" action on
   an exited session using the stored `resume_token`; the resumed session keeps its history in the
   feed (`feed_tail` on select). Research the `--resume` vs `--fork-session` semantics before wiring.
3. **Worktree per session.** `crates/core/src/worktree.rs` is built and tested (add/list/remove/
   prune/delete_branch by shelling out; a failed `add` leaks the branch on git 2.50.1). New session
   gets a branch `brigadier/<short-id>` and a worktree under `<project>/.brigadier/worktrees/`,
   `cwd` points at it, the sidebar shows the branch, `end`/`kill` offers cleanup. Research: git
   worktree behaviour with the repo's own ignore rules and `.gitignore` for the worktree dir.
4. **Two live sessions on one project.** Feed interleaved by time, sidebar counters and costs per
   session correct, both end gracefully on Cmd-Q. Never exercised with real children.
5. **Carry-overs:** `settle_stale_sessions` is unscoped (two app instances on one data dir fight;
   decide whether to support that or to lock the data dir); batcher per-project maps never shrink;
   a native folder picker (`tauri-plugin-dialog`, research first) instead of a typed path; the
   1 % dropped frames under burn (profile before changing anything: is it the two Channel messages
   per frame from the 24-row cap, or the DOM?).
6. **Not in this phase:** other providers, one-shotting, signing or notarization.

## Verify

    export PATH="$HOME/.cargo/bin:$PATH"
    cd /Users/stephen/Development/brigadier-ai
    git log --oneline | head -3
    cargo test --workspace
    cargo clippy --workspace --all-targets -- -D warnings
    npm run tauri build
    # dev with the burn compiled into release-profile Rust:
    npm run tauri dev -- --release --features burn

## How to work

Lead plans, decomposes into owned-path work orders, delegates to `Agent` subagents concurrently,
reviews every diff in full, calls a blind adversarial review for wide or risky changes, runs the
gates itself, and commits only after the owner's explicit approval. No invented progress; a feature
"works" only after it has been run. One line per fact, a path or a number instead of an adjective,
the remedy on the same line as the problem, say what was not checked. Label synthetic feeds loudly:
the owner audits spend and a realistic-looking mock reads as real usage.
