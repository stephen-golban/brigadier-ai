# CLAUDE.md — brigadier-ai

A Tauri v2 desktop harness for Claude Code sessions. **Today** it is a multi-session Claude Code client with one git
worktree per session, non-optimistic approvals, a Monaco workbench and a terminal dock. **What it is for** is a lead
that never accumulates (`docs/vision.md`). The gap between those two sentences is the project.

## 1. The one rule that overrides everything: research the web before doing anything

The model's training data is stale. Its instincts about libraries, APIs, versions, flags and pricing are frequently
wrong. This project was already saved three times by research contradicting a confident model answer:

- The model asserted the Claude Agent SDK's `canUseTool` callback does not fire. It does; t3code uses it in production
  (`docs/research/t3code.md`). The old brigadier repo's measurements file recorded the opposite; it is not in this tree.
- The model recommended spawning `claude -p`. Headless CLI mode has no multi-turn stdin and cannot answer a permission
  prompt programmatically; it would have killed the interactive UI, discovered in week three instead of hour one.
- The model treated Tauri's Node-sidecar packaging as a probable blocker, citing real issues. A spike proved those
  issues are `pkg`-specific and obsolete; bun compiles it in one command.

Mandatory rules:

1. Before any design decision, library choice, API call, version pin, or flag: invoke the `research` skill or delegate
   a research subagent. Never answer from memory. Never say "typically" or "usually" about someone else's API.
2. Before writing code against any external interface: read its current docs. Confirm the flag, option, field and
   package names exist today.
3. Write every finding to `docs/research/<topic>.md` and cite that file when acting on it. A decision with no research
   file behind it is not a decision yet.
4. Read `docs/vision.md` (what we are building) and `docs/STATUS.md` (what exists, what is broken, and the landmine
   list) before anything else — but STATUS §§1–3 are dated 2026-09-04 and describe a UI replaced twice since; its §4
   numbers and §7 landmines stand. Then the briefs:
   - `docs/research/bb-brigadier-today.md` — what this tree actually contains, dated 2026-09-09.
   - `docs/research/long-sessions.md` — context limits, compaction, caching, what ends a session.
   - `docs/research/t3code.md` — dissection of pingdotgg/t3code, closest prior art.
   - `docs/research/substrate.md` — measured IPC/rendering numbers, the real bottleneck.
   - `docs/research/sidecar-spike.md` — proven Tauri sidecar wiring and its landmines.
5. Mark every claim as measured or asserted, and say what was not checked. A blog post is not a benchmark.
6. When research contradicts the plan, the research wins; say so in one line rather than quietly changing course.

## 2. Settled decisions — do not re-litigate

- Tauri v2, Rust core. Electron explicitly rejected by the owner on performance and minimalism grounds. Rust speaks the
  Claude Code CLI's stdio control protocol directly with `tokio::process` (`docs/research/claude-direct-spike.md`, 7/7
  scenarios); there is no Node sidecar, deleted by the owner 2026-09-02 (recipe in `docs/research/sidecar-spike.md`).
- **The Agent SDK is not used.** Rust speaks the CLI's stdio control protocol directly. `docs/research/agent-sdk.md`
  documents that SDK for its wire shapes only — never read it as an instruction to add a dependency, and note it is
  wrong about `Stop` (see `docs/STATUS.md` §6).
- Never `claude -p` for driving sessions: headless mode has no multi-turn stdin and cannot answer a permission prompt
  programmatically.
- The old brigadier CLI (CLAUDE.md-plus-hooks wall) is dead; a harness enforces directly.
- "One-shot an entire project in one session" is not achievable and is not promised. Sell continuity across sessions:
  fresh sessions, progress files, a git commit per phase.
- `docs/research/substrate.md` recommends Electron in its bottom line; that recommendation is overridden by the owner.
  Its measurements still stand.
- The `claude` binary is never bundled. The harness depends on the user's own install, resolved from `PATH` or an
  explicit path, checked against a minimum version; if it is missing the UI says so. Owner decision 2026-09-02.

Settled with the owner on 2026-09-02, in full in `docs/vision.md`:

- **No accumulating session.** The Rust harness owns goal, plan, progress and thread; model windows are rented per
  decision and thrown away. There is no long-lived host child whose context fills.
- **Usage windows, never dollars.** brigadier runs on the user's own subscription, so a dollar figure would be a number
  they are never billed. `rate_limit_event.unifiedWindows` is the gauge, free on the event stream. A reserve near 80%
  keeps the user's own Claude Code working.
- **Fusion for judgement, single owner for actions** — except at a red gate, where the exit code is an objective judge
  and two worktrees may race.
- **Claude Code only for v1.** Ship one working provider before a second. Codex deferred, cross-vendor failover with it;
  the provider layer stays a trait. Codex, Cursor and Grok will need no sidecar when their turn comes (`codex app-server`
  JSON-RPC and ACP over stdio are language-agnostic from Rust). `gemini`, `opencode`, `qwen`, `copilot`, Cursor later.
- **No codebase index** (`docs/research/codebase-index.md`). A ~1,500-token brief from git instead. Content-address
  with blob OIDs; mtime keying misses on 100% of files in a fresh worktree.
- **The `brigadier-guide` doc is deleted**, along with the installable-CLI product it described. Do not reintroduce
  `brigadier install`, CLAUDE.md `@` imports, or hook entries in `.claude/settings.json`. Recoverable at `2327bb9`.
- Approvals are never optimistic in the UI. Everything else may be.
- **2026-09-10: the bb thread port is cancelled.** Both plan files are deleted; recoverable from git history at
  `713fbc9`. The thread stays on the assistant-ui-based `src/components/ThreadView.tsx`. Generic UI controls — buttons,
  icon buttons, menus, dialogs — move to assistant-ui's design library on Base UI, per
  `docs/research/assistant-ui-design.md`, which is in this tree. No jotai, no TanStack Query still holds.

## 3. The sidecar is dead

There is no Node sidecar and none is planned. If one is ever needed again, the proven bun recipe and its five landmines
are in `docs/research/sidecar-spike.md`.

## 4. Verify

Six gates. All six must be green before a commit, each exit code read off the command itself and not through a pipe.
"Green" is a claim until you have re-run the gate yourself.

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo doc --workspace --no-deps
npm test
npx tsc --noEmit
npm run tauri build
```

Any change on the `src/` render path also runs the burn (`VITE_BURN=1`, `src/components/Burn.tsx`): exec → first
contentful paint **≤ 295 ms p50**, and 60 Hz with **0** dropped-vsync failures. `npm install` may need
`npm approve-scripts --allow-scripts-pending` for esbuild's postinstall.

## 5. Landmines for a fresh session

- Approvals are never optimistic (`docs/vision.md` §9): the card clears only on `request-resolved`, and a resolved row
  with no decision is a third state, `Expired`. Reference behaviour: `src/App.tsx`, `src/feedStore.ts`. Do not improve it.
- `radix-ui` is the monolithic package here; never add individual `@radix-ui/react-*` packages.
- `--strict-mcp-config` and `--permission-mode` last are pinned in `crates/core/src/claude/process.rs`.
- The paint budget is exec → first contentful paint **287–295 ms p50** at `c4d9d29` (`docs/STATUS.md` §4), and every
  burn number so far is a debug build.
- `git worktree remove` without `--force` deletes gitignored files and exits 0; the filter-driver neutralisation in
  `crates/core/src/worktree.rs` is deliberate (`docs/STATUS.md` §7).
- Usage windows, never dollars: the product shows no dollar figure, whatever a test harness prints.
- The `claude` binary is never bundled; it is the user's own install, resolved and version-checked.
- A clean tree plus green tests is not "green" — `cargo clippy -D warnings` is one of the six gates.
- The full list is `docs/STATUS.md` §7 and the section under it; read it before touching the store, git or the render path.

## 6. How to work

No invented progress. Never claim a feature works before it has been run. Report a weaker result as weaker. One line per
fact, a path or a number instead of an adjective, the remedy on the same line as the problem, and say what was not checked.
