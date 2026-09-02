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
4. Read `docs/vision.md` (what we are building) and `docs/STATUS.md` (what exists, what is broken,
   and the landmine list) before anything else. Then check the existing briefs:
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
- **The Agent SDK is not used.** Rust speaks the CLI's stdio control protocol directly.
  `docs/research/agent-sdk.md` documents that SDK for its wire shapes only — never read it as an
  instruction to add a dependency, and note it is wrong about `Stop` (see `docs/STATUS.md` §6).
- Never `claude -p` for driving sessions: headless mode has no multi-turn stdin and cannot answer a
  permission prompt programmatically.
- The old brigadier CLI (CLAUDE.md-plus-hooks wall) is dead; a harness enforces directly.
- "One-shot an entire project in one session" is not achievable and is not promised. Sell
  continuity across sessions: fresh sessions, progress files, a git commit per phase.
- `docs/research/substrate.md` recommends Electron in its bottom line; that recommendation is
  overridden by the owner. Its measurements still stand.
- The `claude` binary is never bundled. The harness depends on the user's own install, resolved
  from `PATH` or an explicit path, checked against a minimum version; if it is missing the UI says
  so. Owner decision 2026-09-02.

Settled with the owner on 2026-09-02, in full in `docs/vision.md`:

- **No accumulating session.** The Rust harness owns goal, plan, progress and thread; model windows
  are rented per decision and thrown away. There is no long-lived host child whose context fills.
- **Usage windows, never dollars.** brigadier runs on the user's own subscription, so a dollar
  figure would be a number they are never billed. `rate_limit_event.unifiedWindows` is the gauge,
  free on the event stream. A reserve near 80% keeps the user's own Claude Code working.
- **Fusion for judgement, single owner for actions** — except at a red gate, where the exit code is
  an objective judge and two worktrees may race.
- **Claude Code only for v1.** Codex deferred, and cross-vendor failover deferred with it. The
  provider layer stays a trait. `gemini`, `opencode`, `qwen`, `copilot`, Cursor come later.
- **No codebase index** (`docs/research/codebase-index.md`). A ~1,500-token brief from git instead.
  Content-address with blob OIDs; mtime keying misses on 100% of files in a fresh worktree.
- **`brigadier-guide.md` is deleted**, along with the installable-CLI product it described. Do not
  reintroduce `brigadier install`, CLAUDE.md `@` imports, or hook entries in `.claude/settings.json`.
  Recoverable at `2327bb9` if the reasoning is ever needed.
- Approvals are never optimistic in the UI. Everything else may be.

## 3. The sidecar is dead

There is no Node sidecar and none is planned. If one is ever needed again, the proven bun recipe and
its five landmines are in `docs/research/sidecar-spike.md`.

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
