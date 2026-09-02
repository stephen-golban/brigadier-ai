# Tauri v2 Node-sidecar spike: wiring, landmines, measurements

Date: 2026-09-02
Status: measured on the spike; the spike code was not kept in the repo.

## Result

Real Claude Agent SDK output reached Rust through a Tauri v2 sidecar, both in dev and in a
bundled `.app`. The commonly cited risk for Tauri + Node sidecars (tauri-docs#3442, tauri#8564) is
specific to `pkg`-based bundling and is obsolete for this project: it does not apply when the
sidecar is built with bun.

## Build

Built with `bun build --compile`. Half the size of a Node SEA binary, one command, and the
resulting binary is auto linker-signed on macOS. The SDK itself ships
`@anthropic-ai/claude-agent-sdk/extract` (`extractFromBunfs`) specifically to support this
packaging path.

Command used:

```
bun build --compile --target=bun-darwin-arm64 sidecar.mjs --outfile build/sidecar-bun
```

## Tauri wiring

- The staged binary must be named `binaries/sidecar-aarch64-apple-darwin` on disk (Tauri's
  target-triple sidecar naming convention).
- `tauri.conf.json`:

```json
"bundle": {
  "active": true,
  "targets": "app",
  "externalBin": ["binaries/sidecar"]
}
```

- Rust side:

```rust
let (mut rx, mut child) = app.shell().sidecar("sidecar")?.spawn()?;
child.write(b"{\"prompt\":\"...\"}\n")?;
while let Some(ev) = rx.recv().await {
    if let CommandEvent::Stdout(buf) = ev {
        // NDJSON, one event per line
    }
}
```

- Rust-side `spawn()` needs no capability file entry. Tauri stages the external binary into the
  bundle automatically.

## Measurements (release `.app`, warm, median of 5 runs)

- `spawn()` returns: 1–2 ms.
- First stdout line: 64–87 ms.
- First real SDK event (`system/init`): 692–851 ms.
- Full trivial turn (one prompt, no tools): ~2.5–3.0 s.
- First-ever launch of a freshly built binary: 1030–1255 ms (one-time Gatekeeper scan), then it
  drops to the warm numbers above on subsequent launches.

Sizes:

- Sidecar (bun build): 62.0 MB.
- Sidecar (Node SEA, for comparison): 115.9 MB.
- Rust binary: 11.6 MB.
- `.app` total: 127.6 MB.

## Landmines

### 1. `pathToClaudeCodeExecutable` is mandatory in a bundle

The SDK resolves its platform package via `createRequire(import.meta.url).resolve(...)`. Inside a
single-file bundle there is no `node_modules` to resolve against, so this throws:

```
Native CLI binary for darwin-arm64 not found.
```

Fix: pass an absolute path via `pathToClaudeCodeExecutable`. The SDK spawns it directly when the
path has no `.js`/`.mjs`/`.ts`/`.tsx`/`.jsx` extension.

### 2. With esbuild ESM→CJS, `--define:import.meta.url` is mandatory

esbuild rewrites `import.meta.url` to `undefined` when converting ESM to CJS. The SDK calls
`createRequire(import.meta.url)` at module top level, so this throws `ERR_INVALID_ARG_VALUE` at
load time — before any SDK option can help. Bun does not have this problem; this landmine is
esbuild-specific.

### 3. `USER` must be in the sidecar's environment

Credentials live in the macOS Keychain (`Claude Code-credentials`), not a file — there is no
`~/.claude/.credentials.json`. With a cleared environment the SDK returns
`Not logged in · Please run /login` and `total_cost_usd: 0`. Bisected: `USER` alone fixes it,
`LOGNAME` alone does not. Never `.env_clear()` the sidecar `Command`.

### 4. `src-tauri/icons/icon.png` must exist before the first build

Its absence hard-fails `tauri::generate_context!`.

## readline `close` landmine (not bundling-specific)

readline's `close` event fires when Rust closes stdin. Exiting the process on that event kills
any in-flight queries. Refcount pending work and only exit once the count reaches zero.

## No native modules needed

`sdk.mjs` was inspected: zero `worker_threads`, zero `.node` addons, zero `process.dlopen`. All 13
dynamic `import()` calls in it are static string literals of node builtins — nothing that defeats
bundling.

## Configuration used in the spike

`pathToClaudeCodeExecutable` was pointed at the user's existing install:
`/Users/stephen/.local/bin/claude` (version 2.1.252).

## Untested by this spike

- Developer ID signing, notarization and stapling. The `.app` built here is ad-hoc signed only; a
  downloaded, quarantined build is where real signing problems would surface, and that path was
  not exercised.
- Intel/x64 and Windows/Linux target triples.
- Long-running or concurrent sessions.
- Cancellation.
- Backpressure on high-volume streams.
- Session resume.
- Anything beyond one single-turn, no-tool prompt.

## Open questions (unresolved)

1. Ship `claude` inside the app, or depend on the user's own install? The SDK's bundled binary is
   188 MB, which would take the `.app` to roughly 316 MB.
2. Does the Node sidecar earn its 62 MB, or could Rust speak the CLI's NDJSON stdio protocol
   directly? Not evaluated by this spike — doing so means owning an undocumented protocol.
