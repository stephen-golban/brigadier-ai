# sidecar/ — reserved, not implemented

This slot is for a **Node sidecar** that will host [`@anthropic-ai/claude-agent-sdk`].

## Why a sidecar at all

The agent SDK is a Node package. The Rust core cannot call it in-process, so the
supervisor will spawn a Node process, talk to it over stdio, and treat it as one
more supervised child alongside the raw CLI sessions.

## What lives here eventually

- A Node entrypoint that owns one or more SDK sessions.
- A line-delimited JSON protocol over stdin/stdout: the Rust core sends prompts and
  control messages, the sidecar streams back events.
- Whatever packaging step turns that entrypoint into a single binary Tauri can ship
  as an [external binary] (`bundle.externalBin` in `src-tauri/tauri.conf.json`).

## Status

**Nothing is wired.** `tauri.conf.json` declares no `externalBin`, the Rust side
spawns nothing, and there is no `package.json` in this directory. Packaging is being
proven separately; do not assume any of the above is settled until it lands here.

Prior art worth reading before writing this: the old brigadier's SDK worker, archived
at `~/.brigadier/archive/old-src/worker.ts` — it has the binary-discovery and
environment-scrubbing logic that a sidecar will need again.

[`@anthropic-ai/claude-agent-sdk`]: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
[external binary]: https://tauri.app/develop/sidecar/
