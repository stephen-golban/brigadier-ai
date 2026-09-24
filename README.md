# Brigadier

A free, open-source (MIT), local-first desktop app for long-running AI coding sessions. You talk
to one orchestrator; it plans, delegates to workers from the CLIs on your machine, reviews their
work and reports back. The design and build plan live in [docs/PLAN.md](docs/PLAN.md).

Status: Phase 3 (the orchestrator loop: sessions, workers in worktrees, landing, plain Chats).

## Layout

```
crates/        Rust workspace (see PLAN.md §3)
  core/          domain model, catalog projection, session manager
  store/         SQLite WAL event store (single writer, read pool), blob store
  ipc/           authenticated local IPC + protocol types (exported to TypeScript)
  sandbox/       OS abstraction: paths, private files, processes, credentials, shell, sandbox
  providers/     Provider trait, normalized events, Claude and Codex adapters, replay fixtures
  git/           git engine: worktrees, snapshots, candidates, guarded landing
  mcp-server/    the Brigadier MCP server the orchestrator and workers talk to
  router/        static routing table (task kind → vendor, model, effort)
  daemon/        brigadierd
  …              crates for later phases
apps/desktop/  Tauri 2 shell (src-tauri/) and the React UI (src/)
registry/      curated model registry, published from this repository (Phase 5)
docs/          plan and design notes
```

## Requirements

- Rust 1.98.1 (pinned in `rust-toolchain.toml`; rustup installs it on first use)
- Node 24+ and pnpm 12.6.0 (`packageManager` in `package.json`)
- Tauri 2 platform prerequisites: https://v2.tauri.app/start/prerequisites/

## Develop

```sh
pnpm install
pnpm tauri dev          # builds and stages brigadierd, starts Vite and the app
```

The app launches `brigadierd` detached; closing the window keeps both running in the menu bar.
Quit from the menu-bar item (or Cmd+Q) to stop the daemon too.

Data lives in `~/Library/Application Support/Brigadier` (`%LOCALAPPDATA%\Brigadier`,
`~/.local/share/brigadier`). Set `BRIGADIER_DATA_DIR` to use a throwaway directory; each data
directory gets its own daemon.

## Verify

```sh
cargo fmt --all --check
cargo run -p brigadier-ipc --bin gen-ts      # regenerate TS bindings after protocol changes
pnpm typecheck && pnpm lint && pnpm build
pnpm --filter @brigadier/desktop stage-sidecar --debug
cargo clippy --workspace --all-targets -- -D warnings
```

`pnpm lint` includes `brigadier/no-raw-design-values`: component code may only use theme tokens
(no raw colors, arbitrary Tailwind values or numeric inline styles). Raw values live only in
`apps/desktop/src/styles/tokens.css`.

Launch smoke check against the performance budgets (PLAN.md §4):

```sh
pnpm tauri build
BRIGADIER_DATA_DIR=$(mktemp -d) target/release/bundle/macos/Brigadier.app/Contents/MacOS/brigadier --smoke
```

It prints a JSON report (also written to `BRIGADIER_SMOKE_REPORT` if set) and exits non-zero if
a budget for an implemented feature is missed. `BRIGADIER_BUDGET_TOLERANCE` multiplies timing
budgets only; CI uses 3 on shared runners, locally it is 1. The cold-start note breaks the time
down into milestones (ms since process start: webview, script, connected, catalog, paint), and
the frame-gap note says when the longest gap fell and which event flush cost the most.

In CI, after one warm-up launch that is never judged, the app is launched three times, each with
a fresh data directory, and `apps/desktop/scripts/judge-smoke.mjs` judges them:

- cold start by the **median** of the three, against the same limit (1 s × tolerance);
- every other check on the first launch, exactly as the app judged it.

All three reports, with their milestones, are printed in the log and kept in the combined
report artifact. This is because, on shared runners, most of a cold start passes before the page
even loads, while the platform creates the window and webview. That part swings by seconds
between identical launches, for example on the same code:

| Launch | webview | script | connected | catalog | paint (cold start) |
|---|---|---|---|---|---|
| macOS runner | 2299 | 2630 | 2661 | 2846 | 2909 |
| Windows runner | 3191 | 3329 | 3353 | 3590 | 3599 |
| Local Mac | 234 | 307 | 312 | 341 | 349 |

On Windows the same shell code measured anywhere from 1080 ms to 3599 ms across runs.

## Providers

Brigadier drives the `claude` and `codex` CLIs already installed and logged in on your machine,
found on your login shell's `PATH`. It never reads their credentials, and it changes their
config only to undo what a session made Codex add (see below). What a session makes a CLI write (Claude's transcript and task files, Codex's rollout) is
removed when the session is closed or archived.

- Claude Code runs as one persistent `claude -p --input-format stream-json --output-format
  stream-json` process per session.
- Codex runs as one `codex app-server` per session, over stdio JSON-RPC. The Rust bindings in
  `crates/providers/src/codex/protocol.rs` are generated from the installed CLI's schema. After
  a Codex upgrade, regenerate them:

  ```sh
  cargo run -p brigadier-providers --features codegen --bin gen-codex -- "$(command -v codex)"
  ```

The Inspector's **Providers** tab shows each CLI's login state, version, live model list and
remaining quota. From it you can start, resume, fork, steer, interrupt, stop and close raw
sessions, answer their approval requests, simulate a usage-limit event and replay recordings.
Recordings are scrubbed of personal data as they are written. The fixtures in
`crates/providers/fixtures/` ship with the app.

## Sessions

A session is one orchestrator (Claude or Codex) with no built-in tools except the Brigadier MCP
server (`brigadierd mcp`, bridged to the daemon's socket). Through it the orchestrator proposes
plans, delegates tasks, answers workers' questions, accepts or rejects reports and finishes the
session; only messages, reports, decisions and tool results enter its context, which the
Inspector's **Orchestrator** tab shows. Workers run in their own worktrees under Brigadier's data
directory, report through the same server, and never block the orchestrator. Every accepted
write task is reviewed by the other vendor, then lands as one commit (with your git identity) on
your checked-out branch (local checkout) or on the session branch `brigadier/<session>/session`
(new worktree), which lands on its base when the session finishes. Landing into your checkout is
a fast-forward only; if you switched branches, the tip moved unexpectedly or an untracked or
ignored file would be overwritten, the task waits as "ready to land" and nothing changes.

Each project can name gitignored env files (for example `.env.local`) as secrets: they are copied
into each worker's worktree, never committed, and their values are redacted from everything
Brigadier records. Archiving a session removes its worktrees, scratch folders, CLI session files
and processes (the whole process tree, detached children included); unfinished work is kept as a
WIP commit on its task branch, or as a diff when it overlaps uncommitted changes you let workers
see. Anything that could not be removed is retried at the next launch.

A Chat is a plain conversation with one model and no tools but web search. Text attachments up
to 200 kB go into the message itself (a Chat cannot read files); other attachments are noted.

`BRIGADIER_ROUTE_CHEAP=1` in the daemon's environment makes every worker use its vendor's
cheapest model at low effort. It is for development and verification runs only.

### Outward commands

Pushes, publishes, deploys and cloud commands (`policy::ALWAYS_ASK`) ask you at every permission
level, for both vendors. Claude asks through its permission rules. For Codex, which runs such
commands inside its sandbox without asking, and as a second line for Claude, the daemon puts a
folder of shims (`<data>/gate/bin`: `git`, `gh`, `npm`, `cargo`, `docker`, deploy CLIs, …) first
on each worker's `PATH`. A local command runs the real binary straight away; an outward one
waits for your answer on the same approval card. A command Claude already asked about is not
asked twice.

The gate guards against accidents, not against a hostile agent:

- a program started by absolute path, a script that finds the real binary itself, or code
  calling an API directly is not seen;
- git aliases are resolved (`-c alias.*=…` included), but a `!` shell alias and anything run
  from git's own exec path (hooks) cannot be inspected, so they ask;
- an external `git-<name>` program takes precedence over an alias of that name and is not
  inspected;
- a command line or directory that is not UTF-8 is denied;
- on Windows there are no shims yet;
- raw sessions started from the Inspector's Providers tab are not gated (the Inspector warns
  on Codex ones).

Claude's sandbox lets network traffic out only as HTTP(S) through its proxy, so a push over
`git://` or `ssh` from a sandboxed Claude worker fails even after you allow it.

### What still depends on trust

- Workers and orchestrators get grants scoped to their role and task, checked on every MCP and
  gate call and revoked when the session ends. UI-only requests (such as answering approvals)
  never accept a grant; they need the IPC token in `<data>/run/`. Claude workers cannot read that
  folder; Codex's sandbox cannot deny reads, so a hostile Codex worker could read the token and
  act as the UI.
- A process that detaches and moves out of Brigadier's folders escapes the cleanup.
- A Codex orchestrator runs read-only with every approval declined. It still has: exec
  (JavaScript in an isolate that can only call its tools), `apply_patch` (each patch is an
  approval request, and Brigadier declines it), the MCP resource tools, `clock__curr_time` and
  `request_user_input` (refused). There is no shell, sub-agent, image, web search or goal tool.
- Codex writes a trust entry into `~/.codex/config.toml` when a thread starts with a writable
  sandbox in a folder you never trusted. Brigadier starts every thread without a sandbox of its
  own and sets it per turn, so Codex writes none. If one ever appears for a folder Brigadier
  created, it is removed through Codex's config API when the session closes, and only while it
  is still exactly `trusted`.

## Build and sign (macOS)

```sh
pnpm tauri build --target universal-apple-darwin
```

The bundle is `ai.brigadier.app`, universal, macOS 14+, hardened runtime. Signing and
notarization are configured only through environment variables and are skipped when unset:

| Variable | Purpose |
|---|---|
| `APPLE_SIGNING_IDENTITY` | Developer ID Application identity |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` | base64 .p12 and its password (CI) |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | notarization with an app-specific password |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` | notarization with an App Store Connect key |

CI reads the same names from repository secrets.

## License

MIT. Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
