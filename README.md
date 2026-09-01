# brigadier

A desktop harness for supervising coding-agent CLI sessions across several projects
at once. Tauri v2: a Rust core, a React + TypeScript frontend.

## Status: scaffold

This repo was reset on 2026-09-01. The previous brigadier — a CLI that installed a
CLAUDE.md block plus two Claude Code hooks — is gone. Its documentation is kept
under `docs/legacy/` and `brigadier-guide.md` because it describes the behaviour the
new thing is meant to have; its code is not here.

What exists right now: `npm run tauri dev` builds and opens **one empty window**.
That is all. There is no supervisor, no project sidebar, no database, no agent
running anywhere. Nothing in this repo talks to a coding agent yet.

## Layout

| path | what |
| --- | --- |
| `src/` | React + TypeScript frontend (Vite) |
| `src-tauri/` | Rust core and Tauri config |
| `sidecar/` | reserved for a Node sidecar hosting `@anthropic-ai/claude-agent-sdk` — a stub, wired to nothing |
| `docs/research/` | research behind the harness design |
| `docs/legacy/` | the previous CLI's docs, superseded, kept as the behavioural spec |
| `brigadier-guide.md` | how brigadier is supposed to behave |

## Develop

Requires Node and a Rust toolchain.

```sh
npm install
npm run tauri dev     # dev window
npm run tauri build   # bundle
```

## Where the old code went

Archived outside this repo, with its full git history, at
`~/.brigadier/archive/brigadier-v0.4/`. The SDK worker and the run/plan modules are
also extracted as loose files in `~/.brigadier/archive/old-src/`.
