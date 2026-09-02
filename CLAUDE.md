# CLAUDE.md — brigadier-ai

A Tauri v2 desktop harness that supervises multiple coding-agent CLI sessions.

## 1. The one rule that overrides everything: research the web before doing anything

The model's training data is stale. Its instincts about libraries, APIs, versions, flags and
pricing are frequently wrong. This project was already saved three times by research
contradicting a confident model answer:

- The model asserted the Claude Agent SDK's `canUseTool` callback does not fire. It does; t3code
  uses it in production at `apps/server/src/provider/Layers/ClaudeAdapter.ts:4074`. The old repo's
  own `docs/measurements.md` had recorded the wrong conclusion.
- The model recommended spawning `claude -p`. Research showed headless CLI mode has no multi-turn
  stdin and cannot answer a permission prompt programmatically; it would have killed the
  interactive UI, discovered in week three instead of hour one.
- The model treated Tauri's Node-sidecar packaging as a probable blocker, citing real issues. A
  spike proved those issues are `pkg`-specific and obsolete; bun compiles it in one command.

Mandatory rules:

1. Before any design decision, library choice, API call, version pin, or flag: invoke the
   `research` skill or delegate a research subagent. Never answer from memory. Never say
   "typically" or "usually" about someone else's API.
2. Before writing code against any external interface: read its current docs. Confirm the flag,
   option, field and package names exist today.
3. Write every finding to `docs/research/<topic>.md` and cite that file when acting on it. A
   decision with no research file behind it is not a decision yet.
4. Check the existing briefs first:
   - `docs/research/long-sessions.md` — context limits, compaction, caching, what ends a session.
   - `docs/research/t3code.md` — dissection of pingdotgg/t3code, closest prior art.
   - `docs/research/substrate.md` — measured IPC/rendering numbers, the real bottleneck.
   - `docs/research/sidecar-spike.md` — proven Tauri sidecar wiring and its landmines.
5. Mark every claim as measured or asserted, and say what was not checked. A blog post is not a
   benchmark.
6. When research contradicts the plan, the research wins; say so in one line rather than quietly
   changing course.

## 2. Settled decisions — do not re-litigate

- Tauri v2, Rust core. Electron explicitly rejected by the owner on performance and minimalism
  grounds. Rust speaks the Claude Code CLI's stdio control protocol directly with `tokio::process`
  (`docs/research/claude-direct-spike.md`, 7/7 scenarios); there is no Node sidecar. The owner
  deleted the sidecar stub on 2026-09-02; if it is ever needed again the bun recipe is in
  `docs/research/sidecar-spike.md`.
- Codex, Cursor and Grok need no sidecar (`codex app-server` JSON-RPC and ACP over stdio are
  language-agnostic from Rust).
- Claude Code adapter first; other providers later. Ship one working provider before adding a
  second.
- Never `claude -p` for driving sessions. Use the Agent SDK `query()` with an
  `AsyncIterable<SDKUserMessage>` prompt (streaming input mode).
- The old brigadier CLI (CLAUDE.md-plus-hooks wall) is dead; a harness enforces directly.
- "One-shot an entire project in one session" is not achievable and is not promised. Sell
  continuity across sessions: fresh sessions, progress files, a git commit per phase.
- `docs/research/substrate.md` recommends Electron in its bottom line; that recommendation is
  overridden by the owner. Its measurements still stand.
- The `claude` binary is never bundled. The harness depends on the user's own install, resolved
  from `PATH` or an explicit path, checked against a minimum version; if it is missing the UI says
  so. Owner decision 2026-09-02.

## 3. Sidecar landmines (summary; full detail in `docs/research/sidecar-spike.md`)

- `pathToClaudeCodeExecutable` is mandatory in a bundle.
- With esbuild ESM→CJS, `--define:import.meta.url` is mandatory; bun avoids this.
- `USER` must be in the sidecar env (Keychain credentials). Never `.env_clear()` the sidecar
  Command.
- `src-tauri/icons/icon.png` must exist before the first build.
- readline `close` fires when Rust closes stdin; exiting on it kills in-flight queries. Refcount
  pending work.

## 4. Verify

```
cd /Users/stephen/Development/brigadier-ai
git log --oneline
cd src-tauri && cargo check
cd .. && npm run tauri build
```

Note: `npm install` may need `npm approve-scripts --allow-scripts-pending` for esbuild's
postinstall.

## 5. How to work

No invented progress. Never claim a feature works before it has been run. Report a weaker result
as weaker. One line per fact, a path or a number instead of an adjective, the remedy on the same
line as the problem, and say what was not checked.
