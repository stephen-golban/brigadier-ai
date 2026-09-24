# Brigadier

A free, open-source (MIT), local-first desktop app for long-running AI coding sessions. You talk
to one orchestrator; it plans, delegates to workers from the CLIs on your machine, reviews their
work and reports back. The design and build plan live in [docs/PLAN.md](docs/PLAN.md).

Status: Phase 2 (provider adapters for Claude Code and Codex).

## Layout

```
crates/        Rust workspace (see PLAN.md §3)
  core/          domain model, catalog projection, session manager
  store/         SQLite WAL event store (single writer, read pool), blob store
  ipc/           authenticated local IPC + protocol types (exported to TypeScript)
  sandbox/       OS abstraction: paths, private files, processes, credentials, shell, sandbox
  providers/     Provider trait, normalized events, Claude and Codex adapters, replay fixtures
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
found on your login shell's `PATH`. It never reads their credentials. What a session makes a
CLI write (Claude's transcript and task files, Codex's rollout and the trust entry Codex adds to
`~/.codex/config.toml` for a new folder) is removed when you close the session.

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

Known limitation: a Codex session with workspace access runs under Codex's `on-request`
approval policy. Codex then runs outward commands such as `git push` or a package publish
inside its sandbox without asking, so they are not gated. The Inspector shows a warning on these
sessions. Claude sessions route them to you as approval requests.

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
