# Brigadier

A free, open-source (MIT), local-first desktop app for long-running AI coding sessions. You talk
to one orchestrator; it plans, delegates to workers from the CLIs on your machine, reviews their
work and reports back. The design and build plan live in [docs/PLAN.md](docs/PLAN.md).

Status: Phase 1 (foundations).

## Layout

```
crates/        Rust workspace (see PLAN.md §3)
  core/          domain model, catalog projection, session manager
  store/         SQLite WAL event store (single writer, read pool), blob store
  ipc/           authenticated local IPC + protocol types (exported to TypeScript)
  sandbox/       OS abstraction: paths, private files, processes, credentials, shell, sandbox
  daemon/        brigadierd
  …              crates for later phases
apps/desktop/  Tauri 2 shell (src-tauri/) and the React UI (src/)
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
budgets only; CI uses 3 on shared runners, locally it is 1.

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
