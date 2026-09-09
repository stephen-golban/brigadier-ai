# brigadier

A desktop harness that supervises Claude Code sessions across several local projects at once.
Tauri v2: a Rust core, a React + TypeScript frontend. macOS today.

**What it is today:** a multi-session Claude Code client with an IDE. A sidebar of projects with
their sessions nested, a thread per session, inline tool approvals that are never optimistic, one
git worktree per session, resume onto the same session row, a file tree, Monaco editor tabs, diffs,
source control, notes, an xterm terminal dock, and session review/rewind. Launch runs a cinematic
intro with a 10 s audio track (`src/Launch.tsx`).

**What it is trying to be:** a lead that never accumulates. The Rust harness owns the goal, the
plan, the progress and the thread; model windows are rented per decision and thrown away. The thread
is permanent, no context ever is. The full argument is in **[`docs/vision.md`](docs/vision.md)**.
That is the direction, not the product yet.

## Status, honestly

The substrate is built and live-proven: process supervision, the stdio control protocol spoken
directly from Rust, a sqlite store, a virtualized feed, worktrees, resume, approvals end to end, and
two concurrent sessions on one project.

The autonomous loop exists (`crates/supervisor/src/loop_/` — plan, dispatch, gate, commit) and has
run live **once**, n=1, driven from a test, not through the UI. In the app it is reachable only as a
collapsed "Automation history" panel shown when no session is selected.

Not built: the usage gauge and the reserve (`rate_limit_event` is dropped in a pass-through arm in
`crates/core/src/claude/adapter.rs`, and `unifiedWindows` is stored nowhere), grilling, research
dispatch, worker pre-authorization, cleanup with snapshots. Built but barely surfaced: the loop, the
plan/progress store (`plans`, `phases`, `plan_revisions`, `unknowns`, `work_orders` in
`crates/store/src/schema.rs`) and model routing (`crates/supervisor/src/loop_/routing.rs`).

Two orchestration models coexist and are not unified: the loop's work orders, and peer sessions
delegating to each other over an app-owned stdio MCP server (`src-tauri/src/peers.rs`,
`src-tauri/src/peer_sessions.rs`, `src-tauri/src/peer_mcp.rs`).

Tests, last recorded full run 2026-09-08: **670 Rust passed, 8 ignored** and **375 front-end
passed** (`docs/plans/submission-diagnostics-2026-09-08.md`). A recorded claim, not re-run for this
README. Strict clippy was green at `e0f1375` (2026-09-04), went red on 2026-09-08, and is claimed
green again in that same report — claimed, not verified. Run the gate before quoting it.

**[`docs/STATUS.md`](docs/STATUS.md) is the file to read first** — what is proven, the measured
numbers, the known defects and the landmine list. Its §§1–3 are dated 2026-09-04 and describe a UI
replaced twice since; the defect count in §5 is dated the same day and STATUS's own header says it
has gone stale. §4 (numbers) and §7 (landmines) stand. Every landmine there was bought with either
real money on a live model or a bug that reached a review.

## The thread and the composer

The current thread surface is `src/components/ThreadView.tsx`, built on assistant-ui.

It is being replaced by a port of get-bb/bb's thread timeline and TipTap composer — bb's structure,
brigadier's row kinds. The contract is
[`docs/plans/bb-thread-port-2026-09-09.md`](docs/plans/bb-thread-port-2026-09-09.md); read it before
touching either.

## Layout

| path | what |
|---|---|
| `crates/core` | provider-agnostic types, the Claude adapter, worktrees, the Bash classifier |
| `crates/claude-wire` | the stdio control protocol, on the wire |
| `crates/proc` | process supervision, process groups, orphan sweeping |
| `crates/store` | sqlite persistence; raw traffic goes to rotating NDJSON, not sqlite |
| `crates/supervisor` | sessions, worktrees, resume — the layer the app talks to |
| `crates/supervisor/src/loop_` | the non-accumulating loop: plan, dispatch, gate, commit |
| `crates/claude-spike` | research vehicle. Spikes against the real binary; captures fixtures |
| `src/` | React + TypeScript frontend (Vite) |
| `src-tauri/` | the Tauri shell and command layer, including the peer MCP server |
| `docs/vision.md` | what brigadier is for, and every decision behind it |
| `docs/STATUS.md` | where it actually stands. Read first |
| `docs/plans/` | dated plans and reports; `docs/plans/ipc-contract.md` is the binding IPC contract |
| `docs/research/` | one file per question, every claim tagged measured / documented / asserted |

## Requirements

Node, a Rust toolchain, and your own authenticated `claude` install. **The `claude` binary is never
bundled** — brigadier resolves it from `PATH` or an explicit path and enforces a minimum version
(`2.1.257`, `crates/core/src/claude/binary.rs`). It runs on your subscription; brigadier has no API
key and no account of its own.

brigadier's own licence is unsettled — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). `licenses/` carries other projects' texts only.

## Develop

```sh
npm install          # may need: npm approve-scripts --allow-scripts-pending
npm run tauri dev
npm run tauri build
```

## Gates

Six gates plus the paint burn, all of them in `CLAUDE.md` §4. They must be green before a commit,
and this file does not duplicate them.

Live tests are `#[ignore]`d. Five spend real usage on your own account; `flood_baseline` spends
nothing (it replays a fixture and spawns no `claude`). `docs/STATUS.md` §3 lists which is which and
what each one cost. Run one at a time:

```sh
CLAUDE_BIN="$(command -v claude)" cargo test -p brigadier-supervisor --test <name> -- --ignored --nocapture
CLAUDE_BIN="$(command -v claude)" cargo test -p brigadier-core --test claude_adapter -- --ignored --nocapture
```

`live_pong` lives in `brigadier-core`, so the first command alone cannot reach it. `live_approvals`
rewrites `crates/claude-spike/fixtures/s7-can-use-tool-write.ndjson` on every run; `git checkout` it
afterwards unless the capture changed on purpose.

## How to work on this

Contributors and agent sessions: read `CLAUDE.md`. It is the operating rule set, and its §1 —
research before any library, API, version pin or flag — overrides the rest.

No invented progress. A feature works only after it has been run. Report a weaker result as weaker,
and say what was not checked.
