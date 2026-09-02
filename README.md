# brigadier

A desktop harness that supervises coding-agent CLI sessions across several local projects at once.
Tauri v2: a Rust core, a React + TypeScript frontend. macOS today.

**What it is trying to be:** a lead that never accumulates. The Rust harness owns the goal, the
plan, the progress and the thread; model windows are rented per decision and thrown away. The thread
is permanent, no context ever is. The full argument is in **[`docs/vision.md`](docs/vision.md)**.

## Status, honestly

**The substrate is built and live-proven. The product on top of it is not built.**

Working, against a real `claude` 2.1.258 child: process supervision, the stdio control protocol
spoken directly from Rust, a sqlite store, a virtualized feed, one git worktree per session, resume
onto the same session row, tool approvals end to end, and two concurrent sessions on one project.
209 tests pass; clippy is clean at `-D warnings`; `npm run tauri build` produces a `.app`.

Not built: the orchestration loop, the plan and progress store, grilling, research dispatch, the
usage gauge and reserve, model routing, worker pre-authorization, cleanup with snapshots.

**[`docs/STATUS.md`](docs/STATUS.md) is the file to read first** — what is proven, the measured
numbers, eight known unfixed defects (one of them a security hole), and the landmine list. Every
entry in that list was bought with either real money on a live model or a bug that reached a review.

## Layout

| path | what |
|---|---|
| `crates/core` | provider-agnostic types, the Claude adapter, the Bash classifier |
| `crates/claude-wire` | the stdio control protocol, on the wire |
| `crates/proc` | process supervision, process groups, orphan sweeping |
| `crates/store` | sqlite persistence; raw traffic goes to rotating NDJSON, not sqlite |
| `crates/supervisor` | sessions, worktrees, resume — the layer the app talks to |
| `crates/claude-spike` | research vehicle. Spikes against the real binary; captures fixtures |
| `src/` | React + TypeScript frontend (Vite) |
| `src-tauri/` | the Tauri shell and command layer |
| `docs/vision.md` | what brigadier is for, and every decision behind it |
| `docs/STATUS.md` | where it actually stands. Read first |
| `docs/plans/` | the current phase plan and the binding IPC contract |
| `docs/research/` | one file per question, every claim tagged measured / documented / asserted |

## Requirements

Node, a Rust toolchain, and your own authenticated `claude` install. **The `claude` binary is never
bundled** — brigadier resolves it from `PATH` or an explicit path and checks a minimum version. It
runs on your subscription; brigadier has no API key and no account of its own.

## Develop

```sh
npm install          # may need: npm approve-scripts --allow-scripts-pending
npm run tauri dev
npm run tauri build
```

## Gates

Everything below must be green before a commit.

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo doc --workspace --no-deps
npx tsc --noEmit && npm run build
npm run tauri build
```

Live tests are `#[ignore]` because they spend real usage against your own account. Run one at a time:

```sh
CLAUDE_BIN="$(command -v claude)" \
  cargo test -p brigadier-supervisor --test live_approvals -- --ignored --nocapture
```

## How to work on this

Research before any API decision, library choice, version pin or flag — the model's instincts about
someone else's API are stale and this project has been saved by research contradicting a confident
answer more than once. Findings go to `docs/research/<topic>.md`, and a decision cites the file it
rests on. See `CLAUDE.md` §1; it is the rule that overrides the others.

No invented progress. A feature works only after it has been run. Report a weaker result as weaker,
and say what was not checked.
