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
- CMake 3.x or newer and libclang, to build whisper.cpp (dictation's engine; see below).
  macOS has libclang with the Xcode Command Line Tools; on Windows install LLVM, on Linux
  `libclang-dev`.

## Dependency notes

- `wry` (the desktop shell): the Browser tab's page is a plain wry webview laid over the tab, not
  a Tauri one. Tauri gives every webview it makes the app's IPC bridge, init scripts and custom
  protocols (and child webviews need its `unstable` feature); a web page must get none of that.
  The crate is pinned to the release `tauri-runtime-wry` uses, since two copies of wry would
  register the same native classes. Linux has no embedded page: its tab opens pages in the
  system browser.
- `objc2`, `objc2-foundation`, `objc2-web-kit`, `block2` (macOS, the releases wry is built on):
  the Browser tab's page gets its own WebKit UI delegate, because wry's grants every camera and
  microphone request. Ours denies them without a prompt, sends popups to the system browser and
  leaves file uploads to wry's. This module, `apps/desktop/src-tauri/src/browser_ui.rs`, is the
  app shell's one exception to the workspace's `unsafe_code = "deny"` (the sandbox crate's OS
  calls are the only others): calling WebKit through objc2 needs `unsafe`. The `#[allow(unsafe_code)]` sits on that module alone, and each `unsafe` in it says
  why it holds. WebKit asks macOS for the microphone before it asks the delegate, so the page
  also gets a script, before any of its own and in every frame, that takes
  `navigator.mediaDevices`, `getUserMedia` and the speech-recognition APIs away for good
  (`NO_CAPTURE` in `browser.rs`). Windows' WebView2 asks the user itself.
- `whisper-rs` (whisper.cpp), `ureq`, `sha2` (brigadierd): dictation turns speech into text on
  this computer; the audio never leaves it. The composer's webview records the microphone and
  streams 16 kHz PCM to the daemon, which feeds it to a short-lived `brigadierd transcribe`
  process, so the daemon never holds the model. The model (whisper.cpp's `ggml-base-q5_1`,
  60 MB) is downloaded from Hugging Face on first use, at a pinned revision, checked against its
  SHA-256 and kept in the data directory under `models/whisper/`. `.cargo/config.toml` builds
  whisper.cpp for any CPU of the target's kind (`GGML_NATIVE=OFF`); its Rust bindings are
  generated for the target, since the crate's bundled ones don't fit Windows. The approach
  follows OpenWhispr (MIT); no code is copied from it.

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

Workers report through `submit_report`; the orchestrator never sees their messages. Each worker
has an outputs folder in its scratch folder for files meant for the orchestrator or you (full
findings, documents, generated images; a Codex worker's generated images are copied there as they
are made). What it leaves there, and every file its report names or mentions by path, is stored
with the report before the task's folders are removed, so the orchestrator can read it with
`read_artifact` after the task ended. A report that names a file that doesn't exist, one the
worker wrote to a temp folder, or a link out of its scratch folder, is refused with what to do
instead; a worker that writes its findings as a message rather than reporting them has that
message kept and attached to its report. The task card lists the outputs and artifacts with Open
and Save to….

Each project can name gitignored env files (for example `.env.local`) as secrets: they are copied
into each worker's worktree, never committed, and their values are redacted from everything
Brigadier records. Archiving a session removes its worktrees, scratch and temp folders (a Claude
worker's is a short `/tmp/brigadier-<id>`, as Claude's sandbox needs), CLI session files (Codex's
generated images for its threads included) and processes (the whole process tree, detached
children included). Unfinished work is kept as a WIP commit on its task branch. When it
overlaps uncommitted changes you let workers see, it is saved as a patch instead and its branch
is deleted, because your uncommitted changes never stay in a commit; the task card shows the
patch and can restore it as a new branch on the current tip of the target branch (or says where
it conflicts). A task branch with no work of its own, and an
archived session's branch that its base already contains, are deleted too. Anything that could
not be removed is retried at the next launch.

A Chat is a plain conversation with one model and no tools but web search. Text attachments up
to 200 kB go into the message itself (a Chat cannot read files); other attachments are noted.

`BRIGADIER_ROUTE_CHEAP=1` in the daemon's environment makes every worker use its vendor's
cheapest model at low effort. It is for development and verification runs only.

### Outward commands

Pushes, publishes, deploys and cloud commands (`policy::ALWAYS_ASK`) ask you at every permission
level, for both vendors. Claude asks through its permission rules. For Codex, which runs such
commands inside its sandbox without asking, and as a second line for Claude, the daemon puts a
folder of shims (`<data>/gate/bin`: `git`, `gh`, `npm`, `cargo`, `docker`, deploy CLIs, …) first
on each worker's `PATH`. It holds a shim only for the programs you have on your login `PATH`,
checked when a worker starts and before each message it is sent, so a program you don't have
stays missing for workers too (`which` finds nothing, the shell says "command not found"). A
local command runs the real binary straight away; an outward one waits for your answer on the
same approval card. A command Claude already asked about is not asked twice.

The gate guards against accidents, not against a hostile agent:

- a program started by absolute path, a script that finds the real binary itself, or code
  calling an API directly is not seen;
- a program installed while a worker's turn runs is gated from the worker's next message on;
- git aliases are resolved (`-c alias.*=…` included), but a `!` shell alias, an external
  `git-<name>` program (which git runs ahead of an alias of that name) and anything run from
  git's own exec path (hooks) cannot be inspected, so they ask;
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
