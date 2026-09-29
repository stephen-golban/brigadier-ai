# Brigadier — Build Plan

> Status: agreed design, 2026-09-24. Source of truth for how Brigadier is built.
> Scope: 10 phases from empty repo to signed macOS release plus Windows and Linux builds.

## 1. What Brigadier is

Brigadier is a free, open-source (MIT), local-first desktop app for long-running AI coding sessions. It plays the same role as [bb](https://github.com/get-bb/bb), but is designed to be faster, lighter, and smarter about context, routing, and quality.

The user talks to exactly one **orchestrator**. The orchestrator never does work itself. It plans, delegates to **workers**, talks to them, reviews their results, and reports back. Workers are models from any CLI installed on the machine (Claude Code and Codex first; opencode, Cursor, Qwen and local models later), chosen by skill rather than vendor. To the orchestrator, workers feel like its own subagents. The user can watch workers but never talks to them directly.

### Where Brigadier beats bb (by design)

| Area | bb today | Brigadier |
|---|---|---|
| Context | Delegates compaction to each CLI; child results truncated to 4k chars | Project Brain (knowledge graph) + invisible orchestrator rebirth; no compaction, ever |
| Routing | None; model comes from flags, parent, or project defaults | Layered capability registry + outcome learning + user overrides |
| Fallback | Retries the same provider; no cross-provider failover | Proactive quota balancing + mid-task cross-provider handoff with a quality floor |
| Review | One fixed "review with agent" prompt | Risk-tiered, always cross-vendor; fusion panel + analyst for risky work |
| Freshness | None | Mandatory freshness check against current official docs, cached in the Brain |
| MCP / skills | Each CLI uses its own config | One registry, injected into any vendor per task |
| Runtime | Node server + daemon, sync SQLite stalls, memory leaks | Rust core, single-writer async store, bounded memory |
| Security | Unauthenticated local HTTP API | Authenticated local IPC only; OS sandbox for workers |
| Cleanup | Leaked worktrees and processes; teardown can retry forever | Cleanup ledger per session; everything Brigadier creates is removed; crash sweep on launch |
| Claude integration | Agent SDK (conflicts with Anthropic subscription terms) | The user's own unmodified `claude` binary |
| Platforms | macOS arm64, Linux alpha, no Windows | Universal macOS, then Windows and Linux |

## 2. Core principles

1. **The orchestrator only talks.** It never reads the repo, runs commands, or edits files. Everything goes through workers, and scouts do the looking.
2. **Brigadier owns the truth.** The canonical transcript, task graph, and knowledge live in Brigadier's store. Every CLI session, orchestrator included, is disposable and replaceable.
3. **No vendor preference.** The orchestrator's vendor is excluded from routing inputs.
4. **No AI slop.** Every change is reviewed cross-vendor and verified for real. The final report says exactly what was verified and how.
5. **Never stale.** Anything touching third-party APIs is checked against current docs first.
6. **No new tests by default.** Verification is real: typecheck, lint, build, the existing suite, and a runtime smoke check. Test writing is a toggle. This applies to Brigadier's own development too.
7. **Performance is a feature.** It is enforced by the budgets in §4, not hoped for.
8. **Local-first and private.** No Brigadier backend, no accounts, no telemetry (crash reports opt-in only).
9. **Leave no litter.** Brigadier removes everything it created: worktrees, CLI session files, scratchpads, temp files, processes, and ports. Only task-relevant changes ever reach a commit, and nothing Brigadier didn't create is ever touched.

## 3. Architecture overview

```
┌──────────────────────────── Brigadier.app (Tauri 2) ────────────────────────────┐
│  React UI (system webview)  ── authenticated local IPC ──┐   Menu-bar / tray    │
└──────────────────────────────────────────────────────────┼──────────────────────┘
                                                           │
┌──────────────────────────── brigadierd (Rust core) ──────┴──────────────────────┐
│ Session manager ─ Orchestrator runtime ─ Worker pool ─ Router ─ Quota monitor   │
│ Project Brain (graph + FTS + embeddings) ─ Static code index (tree-sitter)      │
│ Event store (SQLite WAL, single writer) ─ Git/worktree manager ─ Review engine  │
│ Plugin/skill registry ─ Brigadier MCP server ─ Sandbox & OS abstraction         │
└───────┬───────────────────────┬────────────────────────┬─────────────────────────┘
        │ stream-json (stdio)   │ JSON-RPC (app-server)  │ ACP / OpenAI-compatible
   claude (user's binary)     codex app-server       opencode · cursor · qwen · local
```

- **`brigadierd`** is a separate Rust process. The Tauri app launches it, and it keeps running when the window closes (menu bar), so long and unattended sessions continue. It uses Tokio for async work. Blocking work (SQLite, git, indexing) runs on dedicated threads, never on the async runtime.
- **IPC** runs over a Unix domain socket (a named pipe on Windows) with a per-launch secret token. The UI receives a streamed event feed and sends commands. There is no TCP listener by default.
- **Event store:** SQLite in WAL mode. One dedicated writer thread batches appends; there is a read-connection pool. Events are append-only per session. Large payloads (worker transcripts, diffs, screenshots) go to a content-addressed blob store on disk.
- **Data location:** `~/Library/Application Support/Brigadier/`, behind a platform-paths abstraction. Brains are stored per project there, never in the repo.
- **Repo layout** (Cargo workspace plus a pnpm workspace):
  ```
  crates/
    core/        # session manager, orchestrator runtime, worker pool, domain model
    store/       # event store, blob store, migrations
    ipc/         # authenticated local IPC, protocol types (also exported to TS)
    providers/   # adapter trait + claude, codex, acp, openai-compatible adapters
    brain/       # knowledge graph, freshness, retrieval, rebirth briefings
    index/       # static code index (tree-sitter, manifests, service map)
    router/      # capability registry, outcome learning, quota balancing, fallback
    review/      # review tiers, fusion panel, verification pipeline
    git/         # worktrees, session branches, merges, GitHub integration
    registry/    # MCP/plugin/skill registry, config importers/watchers
    sandbox/     # OS abstraction: sandbox, paths, credentials, spawn, shell
    mcp-server/  # Brigadier MCP server (orchestrator + worker tools)
    daemon/      # brigadierd binary
  apps/desktop/  # Tauri 2 shell + React UI
  registry/      # curated model registry (JSON), published via GitHub
  docs/
  ```
- **UI stack:** React 19, Vite, Tailwind 4, and assistant-ui as the complete UI kit.
  - We adopt their design system ([design.md](https://www.assistant-ui.com/design.md)) and their primitives and [elements](https://www.assistant-ui.com/elements), copied into the repo using the **Radix flavor**, and adapt them to our liking.
  - Components run on **ExternalStoreRuntime** over our own state.
  - All icons come from the `@openai/apps-sdk-ui` icon set; lucide is replaced everywhere.
- **Theme:**
  - **Dark only.** One global theme owns every token: color pairs, surfaces, borders, radii, type, spacing, control heights, and pill, button, icon-button, and icon sizes.
  - **Density: Compact / Normal.** A global setting that switches the size and spacing tokens, so the whole app tightens or loosens at once.
  - Copied assistant-ui components are rewritten onto these tokens and keep no hard-coded colors or sizes. A lint rule rejects raw colors and arbitrary pixel values in component code.

## 4. Performance budgets (enforced from Phase 1, reported in the Inspector)

| Metric | Target |
|---|---|
| Core idle RSS | < 60 MB |
| Core RSS with 20 active workers | < 300 MB, excluding the CLI processes themselves |
| App cold start to interactive | < 1 s |
| Event ingest to UI paint | < 50 ms p95 |
| UI with 20 streaming worker cards | 60 fps, no long tasks > 50 ms |
| Async-runtime stalls | None > 10 ms (all blocking I/O off-runtime) |
| Brain query (orchestrator tool) | < 50 ms p95 |
| Static index of a 100k-file repo | < 60 s, incremental afterwards |

## 5. Key domain concepts

- **Project:** a workspace of one or more repos. It owns one **Project Brain** and a service map.
- **Session:** one orchestrator conversation in a project. It can live indefinitely, and several sessions can run at once. Its environment is chosen in the composer:
  - **Local checkout:** reviewed task commits land directly on the branch you pick, in your own checkout. Workers still use temporary worktrees for parallel work, created from that branch's latest commit. Your uncommitted changes are never overwritten, and Brigadier asks whether workers should see them.
  - **New worktree:** you pick a base branch, and the session gets its own worktree on a new branch. Worker worktrees are created from the session branch and merge back into it. When the work is done, the session branch merges into the base branch after your one-click go-ahead.
  - In both modes Brigadier's git engine performs merges on the orchestrator's instruction, and a merge worker resolves conflicts.
- **Chat:** a plain conversation outside any project, listed under "Chats" in the sidebar. It is **not** a Brigadier session: there is no orchestrator and no workers. You talk directly to the model you picked. Chats get:
  - web search and attachments;
  - plugins and connectors from the registry;
  - the Personal Brain as memory;
  - automatic fallback when a limit is hit;
  - image generation, quietly routed to Codex and shown inline.

  A chat runs in a scratch folder, with no repo and no code editing.
- **Sidebar:** New chat and Search, then navigation items (Plugins, Scheduled, Usage), then Pinned, then **Projects** (folders with their sessions nested), then **Chats**.
- **Lifecycle** (applies to both sessions and chats):
  - **Hibernate:** automatic when idle. CLI processes stop and temp files are cleaned up, but the session stays in the sidebar, ready to continue.
  - **Archive:** hidden in an Archived view. Workers stop and all leftovers are cleaned up. The transcript and artifacts are kept, so the session is restorable; the orchestrator restarts from the Brain and the transcript. Unmerged branches are kept.
  - **Delete:** permanent. It asks what to do with unmerged branches, and has a "forget what the Brain learned from this session" checkbox, off by default.
- **Permission level** (composer picker, remembered per project):
  - **Ask for approval:** you approve every plan and every change. Sandboxed.
  - **Approve for me** (default): Brigadier approves on your behalf, sandboxed.
    - Small tasks just go.
    - Big, risky, or architectural plans get a stricter fusion-panel review instead of your approval.
    - It stops only for questions only you can answer (product choices, unclear requirements). The affected task waits while other tasks continue.
  - **Full access:** Approve for me without the OS sandbox, shown with an orange warning pill.

  At every level, actions that affect the outside world (push, deploy, publish, remote DB or cloud, credentials) always ask.
- **Cleanup ledger:** Brigadier records every file, directory, process, and port each spawned CLI session creates, including worktrees; Claude transcripts, todos, shell snapshots, paste cache, and file history for that session; Codex thread records; temp folders; dev servers; and headless browsers. They are removed when a task finishes, when a session is archived or deleted, and by a crash-recovery sweep on every launch. Brigadier deletes only what it recorded, never your own CLI sessions.
- **Task:** a unit of delegated work in the session's task graph. It has a type (scout, research, implement, review, merge, verify), a quality floor, an assigned model, and a status.
- **Worker:** a CLI session running one task, in its own git worktree for write tasks. It returns a **structured report**: summary, changes, decisions, verification, open questions, and artifact references. The report is capped at about 800 tokens, and details stay in artifacts.
- **Artifact:** full worker transcript, diff, command output, screenshot, or research note. It is stored in the blob store and retrievable by the orchestrator on demand.
- **Personal Brain:** a small global store of user preferences that applies across projects.

## 6. The phases

Each phase lists its **goal**, **deliverables**, **key design**, and **done when** (verified live in the app or Inspector, not with test suites).

---

### Phase 1 — Foundations

**Goal:** A running skeleton with the architecture, performance discipline, and cross-platform abstraction in place.

**Deliverables**
- Cargo and pnpm workspaces, with the crate layout from §3.
- `brigadierd` with Tokio runtime, structured logging, and a crash-safe lifecycle. Launched by the Tauri app, it survives window close, and there is a menu-bar item.
- Authenticated IPC (socket + per-launch token) with a typed protocol; TS types are generated from Rust.
- Event store (single-writer SQLite WAL, migrations, blob store) and platform paths.
- An OS abstraction trait covering sandbox, paths, credential storage (Keychain), process spawn, and shell. macOS is implemented; Windows and Linux have compiling stubs.
- **Theme foundation:**
  - The assistant-ui design system is copied in (Radix flavor), with a dark-only token set and Compact / Normal density tokens.
  - A lint rule bans raw colors and arbitrary pixel values.
  - apps-sdk-ui icons replace lucide.
- **Bare-bones desktop UI:**
  - A sidebar with Projects (sessions nested) and Chats.
  - A session view using assistant-ui Thread and Composer on ExternalStoreRuntime.
- **Inspector panel** (developer view) showing the live event stream, process list, and performance metrics against the §4 budgets.
- CI on macOS, Windows, and Linux: build, lint, and a launch smoke check on all three.
- Signed and notarized macOS dev build (bundle ID `ai.brigadier.app`, universal, macOS 14+).

**Done when:** The app launches in under 1 s. You can create a project and session and type messages that persist across app restarts. Switching density visibly tightens every control, and no component carries a hard-coded color or size. The Inspector shows live metrics within budget. CI is green on all three OSes.

---

### Phase 2 — Provider adapters (Claude + Codex)

**Goal:** Brigadier can drive both installed CLIs reliably and knows everything about their state.

**Deliverables**
- A `Provider` trait covering start/resume/fork sessions, send turns, steer and interrupt, stream normalized events, list models, and read usage and limits.
- **Claude adapter.** It spawns the user's own unmodified `claude` binary with `-p --input-format stream-json --output-format stream-json --include-partial-messages --verbose`. Model, effort, permission mode, MCP config (`--mcp-config` + `--strict-mcp-config`), appended system prompt and session id are passed as flags, and the process is persistent per session. It never uses the Agent SDK and never touches OAuth tokens. The adapter parses `rate_limit_event`, the assistant `error` field, and `system`/`result` subtypes.
- **Codex adapter:** `codex app-server` over stdio JSON-RPC, with typed bindings from `generate-json-schema`. It uses `thread/*`, `turn/*` (including steer and interrupt), `model/list`, `account/rateLimits/read` + `updated`, `codexErrorInfo`, approval requests, and image-generation items.
- A normalized event model: messages, reasoning summaries, tool calls, commands, file changes, usage, context size, rate limits, and errors.
- Auth detection (`claude auth status --json`, `codex login status`) with clear "log in to X" guidance.
- Live model discovery and a local cache.
- Sandbox and permission mapping. Workers run full-auto inside their worktree under each CLI's OS sandbox (Seatbelt), with network on. Approval requests are routed to Brigadier: Claude via its permission-prompt tool, Codex via `requestApproval`.
- **Replay fixtures:** recorded real sessions that the Inspector can replay to debug adapter parsing.

**Done when:** From the Inspector you can start a raw Claude session and a raw Codex session, stream them, steer them, and interrupt them. Both show live model lists and remaining quota. A simulated usage-limit event is detected and classified correctly.

---

### Phase 3 — The orchestrator loop (first end-to-end flow)

**Goal:** A real session: you talk to the orchestrator, it delegates to Claude and Codex workers, and work lands as commits.

**Deliverables**
- **Orchestrator runtime.** It runs a CLI session with **no built-in tools**, only the Brigadier MCP server. For Claude, built-in tools are disabled and MCP is strict. For Codex, the sandbox is read-only and Brigadier declines every exec or file-change approval. System instructions define the orchestrator role.
- **Brigadier MCP tools for the orchestrator:** `delegate_task`, `message_worker`, `stop_worker`, `ask_user`, `read_report`, `read_artifact`, `query_brain` (stub until Phase 4), `propose_plan`, `request_approval`.
- **Worker runtime.**
  - Task spec goes in, a worktree is created from the session branch's latest state, the worker session runs, progress events stream, and a structured report plus artifacts come back.
  - Workers can ask the orchestrator blocking questions through a worker-side MCP tool.
  - Workers honor the repo's `CLAUDE.md` / `AGENTS.md` whatever their vendor, and do not load the user's personal CLI hooks or plugins.
- **Non-blocking orchestration.** The user can chat at any time. Worker results queue up as events for the orchestrator's next turn, and only final reports and blocking questions enter its context.
- **Git flow:** the two session environments from §5.
  - **Local checkout:** commits land on the picked branch.
  - **New worktree:** a session branch created from the picked base, merged into the base after one-click approval.
  - Worker worktrees are used in both modes.
  - Each accepted task becomes one clean, reviewed commit.
  - Uncommitted changes are never overwritten.
  - PRs always need confirmation.
- **Permission levels:** Ask for approval / Approve for me (default) / Full access, as described in §5, plus the always-ask list for outward-facing actions.
- **Secrets:** a per-project list of gitignored env files copied into worktrees, with values redacted in the UI, logs, and Brain.
- **Composer** (BB parity), built from assistant-ui composer elements:
  - project picker, including "no project", which makes it a Chat;
  - local checkout vs new worktree;
  - branch picker, with "New branch…";
  - permission level;
  - attachments;
  - reasoning effort;
  - provider and model.

  The model and effort choice is resolved in this order: session choice, then the project's remembered choice, then the global default in Settings. The permission level is remembered per project.
- **Message queue:** assistant-ui's Message queue element, extended with:
  - **Steer** (send now into the running turn), delete, a ⋯ menu with edit, and drag to reorder;
  - an editing state and attachment summaries;
  - "Queue paused because you interrupted → Resume";
  - no Queue/Steer setting: a Chat queues what is sent while it replies (Steer sends one in now); a session's orchestrator sorts what is sent while an answer works, joining it to that answer or keeping it queued for its own turn.
- **Chats:** plain conversations directly with the picked model, with web search, attachments, and fallback. Plugins and image generation are added in Phase 7, and memory in Phase 4.
- **Cleanup and lifecycle:**
  - The cleanup ledger, and the pre-commit litter guard, which strips scratch notes, debug scripts, logs, and stray files unrelated to the task.
  - Workers get a scratch folder outside the repo.
  - Crash-recovery sweep on launch.
  - Hibernate, archive, and delete as described in §5.
- **UI:**
  - Worker cards (expandable live transcript, stop/pause).
  - Approval cards.
  - @-mention of worker cards.
  - A plan card.
- Simple routing for now: a static table choosing between Claude and Codex models.

**Done when:** "Add feature X" in a real repo goes all the way through, in both local-checkout and worktree modes. Parallel Claude and Codex workers run in separate worktrees, reports come back, commits land on the right branch, and approvals work. Queued messages can be steered, edited, and reordered. A plain Chat works. After archiving a session, no worktrees, CLI session files, or processes from it remain. The Inspector shows the orchestrator's context growing only by messages and reports.

---

### Phase 4 — Project Brain and the context engine → **self-hosting starts**

**Goal:** Near-infinite sessions, with the orchestrator answering from knowledge instead of re-scouting.

**Deliverables**
- **Static code index** (Rust, no model usage):
  - File tree, tree-sitter symbols and cross-references, package manifests, scripts, and the service map from compose files and manifests.
  - Incremental updates via a file watcher.
  - Exposed to scouts as a fast search tool.
- **Brain graph:**
  - **Node types:** module/service, file summary, decision, convention, preference, task, report, research (dated), contract.
  - Edges between nodes.
  - Retrieval via SQLite FTS5 plus embeddings (local model, or the cheapest cloud fallback).
  - Every node records its provenance: which worker, which session, which commit.
- **Staleness:** file content hashes are tracked, and changed files mark dependent nodes stale.
- **Skeleton pass** on project add, using a cheap model for a few minutes. It records the purpose of each module, the stack, conventions, and the run/build/verify recipe.
- **Idle-quota enrichment** (toggle, on by default). When a usage window is about to reset with quota left over, Brigadier spends it deepening the Brain.
- **Orchestrator rebirth.**
  - Triggers at about 150–200k tokens, between turns only, or when a new message arrives after the session's cache has expired (§7 item 5).
  - The outgoing orchestrator writes a handoff note.
  - The new session gets a briefing of about 15–25k tokens built from the Brain, the handoff note, and the last N messages verbatim.
  - It can search the full transcript on demand.
  - The user sees nothing.
- **Personal Brain:** global preferences, which also serve as memory in Chats (shown with assistant-ui Memory chips), plus an optional export of conventions to `AGENTS.md`.
- **Inspector:** Brain graph viewer, orchestrator context meter, rebirth log.

**Done when:** A session goes through at least 3 rebirths while working on Brigadier itself, with no loss of decisions and no user-visible seams. Repeated questions are answered from the Brain without a scout. **From here on, Brigadier is developed with Brigadier.**

---

### Phase 5 — Routing and resilience

**Goal:** The best model for each task, and sessions that never stall on limits.

**Deliverables**
- **Curated capability registry** (`registry/models.json`). For each model it records vendor, CLI, effort levels, context window, modalities (e.g. image generation is Codex-only), strengths per task category, and a quality tier. The app auto-updates it from the GitHub repo.
- **Live discovery merge:** new models appear automatically. Unknown models are researched (release notes, benchmarks) and tried out on low-risk tasks.
- **Outcome learning:** Brigadier tracks results per model and task category on each project (review pass rate, rework rounds, verification results, time, quota used) and adjusts scores.
- **User overrides:** rules such as "never use X for frontend". Overrides always win.
- **Routing explanation** on every worker card ("why this model").
- **Quota monitor:** Claude's 5-hour and weekly windows, and Codex's primary and secondary windows. Rolling usage estimates, with **proactive balancing** that shifts work to other providers when a window runs hot.
- **Fallback:**
  - Each task has a **quality floor**.
  - On a limit or error, Brigadier hands off mid-task to the best eligible model, in the same worktree, with the task spec, progress log, and current diff.
  - If nothing eligible is left, that task pauses and shows the reset time while other tasks continue.
  - The orchestrator falls back through rebirth.
  - A temporary fallback never overwrites the user's saved model choice.
- **Usage dashboard** in the UI.

**Done when:** Claude and Codex workers are chosen for sensible, explained reasons. A forced Claude limit mid-task hands off to Codex and the task completes. The dashboard reflects real quota windows.

---

### Phase 6 — Quality engine

**Goal:** No AI slop: everything reviewed, verified, and up to date.

**Deliverables**
- **Review tiers, scaled to risk:**
  - Trivial changes get one reviewer from a different vendor.
  - Large, risky, or architectural work, including its plan, gets the **fusion panel**: parallel independent reviewers from different vendors, plus an analyst that reports consensus, contradictions, gaps, unique insights, and blind spots.
  - Confirmed issues go back to the original worker to fix.
  - `/fuse` forces a full panel, and when Brigadier approves on your behalf (Approve for me, Full access), risky plans always get the stricter panel.
- **Verification pipeline** (per project, learned into the Brain):
  - Typecheck, lint, and build.
  - The existing test suite. If a change breaks an existing test, the worker fixes the code; it edits the test only for an intended behaviour change.
  - A runtime smoke check: start the app, hit endpoints, or run a headless browser with screenshots attached for reviewers.
  - The final report states exactly what was verified.
- **Test-writing toggle:** per project (off by default), with a per-session override. When on, workers write only focused, meaningful tests.
- **Freshness check:**
  - Any task touching a third-party library, API, SDK, CLI, or service triggers a research scout, which checks official docs and changelogs.
  - Results are stored as dated Brain nodes with a TTL of about 7 days and are invalidated when a version changes.
  - New dependencies use the latest stable version.
  - Existing dependencies are coded to the installed version; upgrades are suggested, never applied silently.
  - Every prompt includes today's date and each model's knowledge cutoff.

**Done when:** A risky feature gets a fusion-reviewed plan and diff, with issues caught and fixed. The smoke-check screenshot shows up in the review. A stale-API scenario (a library changed after the model's cutoff) is caught by the freshness check.

---

### Phase 7 — Plugins, skills, local models, more providers

**Goal:** Every capability on the machine, available to every vendor.

**Deliverables**
- **Unified registry:**
  - **Plugins screen:** MCP servers and connectors, each with its own auth, on/off switch, and permissions.
  - **Skills screen:** `~/.agents/skills` is the canonical folder, plus `<repo>/.agents/skills`.
- **Importers and watchers** for Claude (`~/.claude.json`, `.mcp.json`, `~/.claude/skills`, plugins), Codex (`~/.codex/config.toml`, skills, plugins), Claude Desktop, and Cursor. Brigadier never edits their configs.
- **Per-task injection:** each worker gets only the relevant plugins and skills, via `--mcp-config` for Claude and config overrides for Codex. The orchestrator sees only a catalog.
- **Vendor-exclusive built-ins** such as Codex image generation and computer-use are exposed as router capabilities. Generated images are saved into the project where the user chooses.
- **Local models** via an OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp):
  - Helper jobs: titles, commit messages, report→node summaries, embeddings, classification, and a second check on redaction.
  - Trivial worker tasks, via opencode.
  - **Local-only mode** per project.
- **ACP adapter** covering opencode, Cursor (`cursor-agent acp`) and Qwen, with quirk handling per vendor.
- Image and screenshot attachments everywhere, routed to vision-capable models.
- **Chats get the full set:** plugins and connectors from the registry, and image generation routed quietly to Codex and shown inline, even when chatting with Claude.

**Done when:** An MCP server configured only in Claude is used by a Codex worker. A skill from `~/.agents/skills` is applied to a Codex task. A local model handles titles and summaries. opencode works as a worker if it is installed.

---

### Phase 8 — Multi-repo projects and GitHub

**Goal:** Microservices and the full dev loop.

**Deliverables**
- **Multi-repo workspaces:** a project spans several repos, with one Brain and a service map. Services are nodes and contracts are edges (HTTP, events, shared types).
- **Contract-first changes across services:** the contract task comes first, then per-service workers run in parallel, and one reviewer checks both sides of each contract.
- **Impact analysis:** a contract change automatically plans follow-up tasks for its consumers.
- **Session branches** only in the repos a session touches, with **linked PRs**.
- A cross-service smoke check using the learned "run the system" recipe (compose, scripts, ports).
- A **merge worker** for conflicts between workers, followed by re-review.
- **GitHub integration** via `gh`: PR creation (with confirmation), review comments into the session, CI status, and "fix failing CI".

**Done when:** A change spanning two services in two repos lands contract-first with linked PRs. A red CI run on a PR is fixed by a session.

---

### Phase 9 — Product UI

**Goal:** Turn the bare-bones app into the product.

**Deliverables**
- **A full design pass on the assistant-ui design system and elements**, adapted to our dark theme and density tokens. Element mapping:
  - Worker cards: Subagent list, Task card, Agent status.
  - Approvals: Approval card, Permission grant.
  - Plans: Agent plan, Todo list.
  - Fallback notices: Handoff.
  - Usage: Quota banner, Cost meter.
  - Inspector: Context breakdown, Trace waterfall, Tool timeline.
  - Task-graph panel: Flow graph.
  - Diffs: Code diff, Reviewable diff.
  - Files and terminal: File tree, Terminal block.
  - Embedded browser: Web preview.
  - Plugins screen: MCP config dialog, Server panel.
  - Automations: Schedule card.
  - Personal Brain: Memory chips.
  - Sidebar: Thread list sidebar, Thread search.
  - Also: Command palette, and Model selector with reasoning effort.
- Session view polish: streaming performance at the §4 budgets, virtualized timeline, and lazy-loaded worker transcripts.
- **Diff viewer** with "select lines → add to chat".
- **Terminal** (xterm.js over a PTY from the core).
- **File tree and viewer** (read-only), plus "Open in Cursor / VS Code / Zed".
- **Embedded browser** with element annotation ("fix this"), shared with the smoke checks.
- **Task-graph panel**, which replaces a kanban board.
- **Native notifications:** approval needed, worker blocked, session done, limit hit.
- **Automations:** scheduled or recurring sessions that run under Approve for me.
- **Settings:** density (Compact / Normal), default orchestrator model and effort, default permission level, test toggle, secrets list, routing overrides, plugins, skills, local models, enrichment toggle.
- The Inspector stays available as a developer view.

**Done when:** A full day of real work on Brigadier happens in the app without falling back to a terminal, at the performance budgets.

---

### Phase 10 — Release: macOS, then Windows and Linux

**Goal:** Ship.

**Deliverables**
- **macOS:**
  - Signed and notarized universal DMG (Developer ID).
  - Homebrew cask.
  - Tauri signed updater with Stable and Nightly channels, published from GitHub Releases.
- **Windows:**
  - A real sandbox implementation: Codex's native sandbox, and Claude with WSL guidance where needed.
  - Credential storage and paths.
  - A signed MSI or NSIS installer.
- **Linux:** AppImage and .deb, with a WebKitGTK compatibility pass.
- **Performance hardening:** benchmark report against bb (memory, CPU, latency, and context per feature).
- **Docs:** install, first project, concepts (orchestrator, Brain, routing), privacy.
- Optional crash reporting (opt-in).
- MIT license and contribution guide.

**Done when:** Public v1.0 release on all three OSes, with the auto-updater verified end to end on macOS.

## 7. Token economy (planned, not yet scheduled)

**Goal:** Teams that use AI all day stop running out of Claude and Codex usage, without losing context or slowing down. Brigadier does this automatically in every session, so nobody has to change how they work.

**Rules**
- **No budgets or caps.** Nothing stops, throttles or interrupts work to save usage.
- **No shortening sessions.** Earlier compaction, smaller context windows and ending sessions sooner all lose context and invite hallucination. They are not the fix.
- **Lossless.** Whatever leaves the model's view stays exactly retrievable, and the model is told where it is. Nothing is cut silently.
- **Judged per completed task.** A change ships only if usage per successfully completed task goes down at equal quality. Fewer tokens in one call that cause extra calls later are a loss. An independent study found that cutting tool output by 38% raised the bill by 7%, because agents made up for it with extra steps ([arXiv 2607.12161](https://arxiv.org/abs/2607.12161)).
  - Usage is measured as the provider reports it: the share of each quota window a task used, and how often work hit a limit.
  - Results are kept separate per provider and per project. API price ratios are only a first estimate.

**What the usage is made of**

These numbers are provisional. They come from two measurements on one heavy user's machine, weighted by Anthropic's API price ratios. Neither vendor publishes how its subscription limits weigh each token type. Both measurements cover Claude Code sessions the user ran by hand, not workers run by Brigadier. They pick the order below. They do not decide what ships.

- **All projects** (2026-09-28: 30 days, 15,830 Claude Code calls, cache reads weighted at 0.1×):
  - Every call re-sends the whole conversation. 73% of usage is those cache reads, 16% is cache writes and 11% is output.
  - 62% of usage came from calls made at 200k–500k tokens of context.
- **Brigadier's own sessions** (2026-09-30: 30 days, 19,656 calls, 98% Opus 5.5). This time each model's own cache price is used, and Opus 5.5 reads its cache at 0.05×:
  - Cache reads are 61%, cache writes 23% (almost all at the 1-hour price of 2×) and output 16.5%.
  - A token that enters the context costs as much when written as 40 later re-reads. So what enters the context matters as much as how long it stays.
- **The re-read context:** about one third fixed or uncounted (system prompt, tools, instructions, images), one third the model's own earlier output, and one third tool results.
- **The fixed start of a session:** a median of 21k tokens. Carried through every call, it is up to 10% of usage.
- **The model's output:** 65% thinking, 21% shell commands, 9% written files and 3.7% visible prose. Earlier thinking stays in the context and is re-read on every later call.
- **Tool results** are about 24% of usage:
  - The costly ones are successful file reads through the shell (`sed` 26%, `cat` 22%, `grep` 13% of the shell-output cost).
  - Failed commands are 2%, and build and test logs very little.
  - Reading lines already read earlier in the same session is 0.01% of usage.
- **Idle gaps:** a full re-cache after more than an hour idle is 2.4% of usage. Gaps under an hour cost nothing, because Claude Code keeps a subscription session's cache for one hour.
- **Orientation** (listing folders, git status and log, reading README and plan docs before the first edit) is about 3%.
- **Codex** shows the same shape (59.5M cached input tokens against 3.4M uncached).

**Work, in order**
1. **Measure it.** This comes first, because every item below is judged by it.
   - Record usage per task, model and step: the context size at each call, cache writes by cause (new content, idle gap, prefix change, CLI upgrade), and the cache hit rate per CLI version.
   - Estimate token costs with each model's own cache prices.
   - The ship gate is not the token estimate. It is completed-task quality plus the quota monitor's own readings (Phase 5): the share of each quota window used per completed task, and how often work hit a limit.
   - Keep a baseline per provider and per project, and compare before and after each change, so a CLI release that breaks caching is caught.
   - Record merge and conflict-fixing tasks separately, so overlapping parallel work shows up.
2. **Precise, batched reads.**
   - Worker tools backed by the static code index (Phase 4) return only what is needed: a file's outline, one symbol's source, references with their lines, or a line range.
   - A batched read returns several files or searches in one call, with a result per item.
   - This makes each read smaller and removes model calls, which cost a full re-read of the context each.
   - A worker's task spec carries a short map of the area it works in: files, symbols, and the run and verify recipe from the Brain. The whole-project map stays a tool (`project_map`), not part of every prompt.
   - Re-reads are too rare to be worth a "you already have this" reply.
3. **A lean, stable fixed start.**
   - Each role gets only the built-in tools it uses, and each task only the plugins and skills it needs (Phase 7). Tool search stays on, so other tools load only when asked for, and nothing is out of reach.
   - Brigadier's own tool descriptions stay short.
   - Everything Brigadier controls stays the same for a session's whole life, including across hibernation and resume: its appended prompt, settings, plugin set and order, and tool descriptions. Parts that change, such as the date, go after the CLI's dynamic boundary.
   - Some cache misses come from the CLI itself, such as a CLI upgrade or its own start-of-session snapshots. Brigadier can't prevent these. Item 1 measures and reports them.
   - Plugins are not added or removed inside a running session. A change of model starts a new worker or a rebirth, since each model has its own cache.
4. **Thinking.**
   - Choose the effort level per step where the model keeps its cache across effort changes. Current Claude Code docs say Opus 5.5, Sonnet 5.5 and Fable 5.1 do, on a subscription or an API key, but not through Bedrock, Google Cloud or a gateway.
   - On models, sign-in methods or CLI versions where an effort change rebuilds the cache, effort is chosen once per task.
   - Item 1 checks the cache hit rate observed after each effort change, and switches a combination to per-task if it misses.
   - Research whether the CLIs can keep old thinking out of the re-read context without losing anything the model concluded. Anthropic's API has `clear_thinking_20251015`, but clearing rebuilds the cache from that point, and no Claude Code setting for it was found up to 2.1.285. It pays only if the thinking removed outweighs the rebuild.
5. **Cache-aware idle.**
   - Hibernation and resume keep Brigadier's part of the request unchanged (item 3), so coming back within the cache lifetime can read the cache.
   - **Rebirth instead of resume when the cache is cold.**
     - When a hibernated or idle session gets a new message after its cache has expired, Brigadier rebirths the CLI session instead of resuming it. The rebirth is the one from Phase 4: a briefing from the Brain, the handoff note, the last N messages verbatim, and the full transcript searchable on demand.
     - The cache lifetime is one hour for a Claude main session on a subscription. Item 1 measures the real value per CLI.
     - Resuming a cold session would write the whole history into the cache again at the write price anyway, so rebirth loses nothing it wasn't already going to pay for.
     - The Brigadier session itself goes on unchanged. Only the disposable CLI session underneath is replaced, as with any rebirth.
     - Rough numbers at Opus 5.5 prices (read 0.05×, one-hour write 2×), for a 150k history and 5 calls per turn:
       - Cold: resuming costs about 330k token-equivalents (300k to rewrite the history, plus re-reads). Rebirth costs about 45k (a 20k briefing written at 2×, plus re-reads).
       - Warm: a fresh session per message costs more than resuming until the history reaches about 800k divided by the calls per turn. At 5 calls per turn that is about 160k, which matches the existing 150–200k rebirth trigger.
     - Evidence: full re-caches after gaps of more than an hour were 2.4% of usage in hand-run development sessions. The orchestrator's share may be higher, since it spends most of its time waiting on the user.
     - Later, tune the 150–200k rebirth trigger from item 1's measured calls per turn and idle gaps.
     - Implementation note: `claude -p --no-session-persistence` and `codex exec --ephemeral` exist on the installed CLIs (Claude Code 2.1.285, codex-cli 0.158.0), so short-lived side sessions leave no transcript files. The Codex adapter uses app-server, whose equivalent is unverified.
   - For gaps where the cache is still warm but about to expire, a measured experiment: refreshing the cache with a tiny side call on a copy of the session, so the real transcript is untouched.
   - No saving is assumed. Forks and other side calls default to a five-minute cache lifetime, while a subscription's main conversation gets one hour. So the experiment must establish:
     - which lifetime the side call's cache writes actually get;
     - what the side call costs in full;
     - whether the main session's next request after the gap really reads the cache.
   - It is built only if those numbers show a gain per completed task.
   - A Brigadier session is never ended or shrunk because it is idle. Nothing it knew is lost.
6. **Terse orchestrator voice.**
   - The orchestrator's chat and internal notes follow the caveman skill ([JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman)). Its skill text is MIT and is bundled with its notice. The setting gets its own name, since the project restricts use of its name.
   - Worker task specs stay structured and complete: goal, scope, constraints, relevant files, acceptance checks.
   - Visible prose is only 3.7% of output, so the direct saving is small.
7. **Command-output store.**
   - Output from noisy local commands (tests, builds, linters, package installs, CI and container logs, `git fetch` progress) goes through one small Brigadier wrapper.
   - The wrapper stores the full stdout and stderr in the blob store, under the owning session's cleanup-ledger entry, before it prints anything.
   - The model sees:
     - the exit status;
     - the failures with their locations;
     - a count of what was left out (for example "312 passing tests not shown");
     - an ID it can read exact lines from or search through.
   - Permissions:
     - The wrapper never touches outward or approval-gated commands: push, publish, deploy, remote database or cloud, credentials, and anything else §5 says always asks. These run exactly as written and go through the normal approval.
     - Only commands on a fixed list of local families are rewritten.
     - Permission is decided on the original command, and the hook never grants approval itself. Claude checks permission on the rewritten command, and Brigadier answers every permission prompt (`--permission-prompt-tool stdio`). So Brigadier unwraps the command and decides on the original.
     - The wrapper checks the original command against the same policy again, and refuses to run anything the policy says must ask.
     - It runs inside the same OS sandbox as the command would have.
   - Claude workers:
     - Brigadier supplies its own `PreToolUse` hook in the settings it passes with `--settings`. Workers load only project settings plus Brigadier's (`--setting-sources project`), so the user's personal hooks still never run.
     - The hook rewrites a matching command to the wrapper (`updatedInput`). Because the wrapper runs the command, failing commands are covered too. Claude's `PostToolUse` output replacement misses them.
   - Codex workers:
     - Brigadier turns off Codex hooks today, because turning them on would also load the user's personal hooks.
     - Codex runs a hook only once its exact definition is trusted, unless it comes from a managed source or the session passes `--dangerously-bypass-hook-trust`. It also requires an explicit allow for a rewrite, which would bypass approval.
     - So Codex workers get the wrapper as a Brigadier tool (`run`): same store, same digest, same policy check.
     - Hooks on Codex are used only if a test on the installed version shows Brigadier can load just its own hook, with no personal hooks and without the rewrite granting approval.
   - Checking that it worked:
     - Every wrapper run records the worker's tool call it served. For each command that matched the list, Brigadier checks that the record exists.
     - If it doesn't (the hook was missing, untrusted or broken), Brigadier marks the hook as not working for that CLI version. From then on, that session and later ones get the Brigadier `run` tool, and the worker is told to use it for these commands.
     - Output is never lost either way: a command that wasn't wrapped just shows its full output as before.
   - Safety rules:
     - Unknown commands pass through unchanged.
     - The digest is never longer than the original.
     - File contents, search hits and diffs a model asked for are never replaced.
   - Large results from Brigadier's own tools follow the same pattern.
   - The open-source RTK project (Apache-2.0) is a reference for per-command filters. Unlike it, we always keep the raw output, not only on failure.
   - On Brigadier's own sessions this would save about 1% of usage at most. It matters more in projects with heavy test and build output.
8. **Cheap-model digests for non-code reads.**
   - Long docs, logs, web pages and worker transcripts are read by a cheap model instead of the worker, which gets back only the part it asked about. The source stays in the blob store with an ID, so the worker can still read it in full.
   - The digest uses a local model (Phase 7) or the cheapest model of an installed CLI (Claude, Codex, opencode).
   - Code reads stay with item 2: the index is exact and free.
   - A digest pays only when it keeps text out of a long session. Every CLI call also carries that CLI's own system prompt and tools, so short reads stay direct, and the cutoff is set from item 1's numbers.
   - Cheap cloud models still count against the user's plan limits, and opencode's free cloud models send code to third parties. So local models come first, and cloud models need the user's consent.

**Not doing, and why**
- Output caps, per-step token limits and history trimming break the rules above.
- Lossy prompt compression, and answering from a cache of similar past questions, lose information. Coding turns almost never repeat anyway.
- Batch APIs are discounted only on API billing, not on subscriptions.
- A fresh `claude -p` or `codex` session for every user message (considered 2026-09-30). It costs more than resuming while the cache is warm, and it breaks "No shortening sessions". Rebirth happens only at the size trigger or when the cache is cold (item 5).

---

## 8. Risks and open items

| Risk | Mitigation |
|---|---|
| Anthropic's terms for third-party use of subscriptions change | Run only the user's own unmodified `claude` binary, and never handle tokens. Watch the policy, and support API-key auth as an alternative. |
| `codex app-server` is marked experimental; its API may change | Generate bindings from the installed version's schema, detect the version, and isolate everything in the adapter crate. |
| Codex orchestrator cannot fully disable its built-in tools | Use a read-only sandbox, and have Brigadier decline every approval. Verify in Phase 2, and prefer a Claude orchestrator if needed. |
| Rebirth loses unrecorded nuance | Handoff note, verbatim recent messages, full transcript search. The Inspector compares before/after. |
| Model names and capabilities change fast | Live discovery, a curated registry updated independently of app releases, and the freshness check. |
| Windows sandboxing is weaker | Sandbox trait from Phase 1. Use WSL for Claude where required. Clearly document Windows limitations. |
| WebKitGTK quirks on Linux | CI launch checks from Phase 1 and a dedicated compatibility pass in Phase 10. |

## 9. Decision log (grilling session, 2026-09-23)

| # | Decision |
|---|---|
| Q1 | Public, free, MIT, local-first; no backend or accounts; open-core possible later |
| Q2 | Pure orchestrator + scouts + Project Brain + rebirth instead of compaction |
| Q3 | Autonomy modes; irreversible and outward-facing actions always confirm (levels finalized in Q27) |
| Q4 | Layered routing: curated + discovery + outcome learning + overrides |
| Q5 | Proactive quota balancing + mid-task cross-provider fallback with a quality floor |
| Q6 | Risk-tiered, cross-vendor review; fusion panel for risky work and plans |
| Q7 | Worktrees per worker; accepted tasks land as clean commits (branch semantics superseded by Q23) |
| Q8 | Workers visible as read-only live cards; redirect via the orchestrator |
| Q9 | Mandatory freshness check, cached in the Brain |
| Q10 | No new tests by default, real verification; test-writing toggle |
| Q11 | One plugin/skill registry, injected into any vendor per task |
| Q12 | Tauri 2 + Rust core |
| Q13 | One Brain per project, shared live across sessions, + Personal Brain; stored outside the repo |
| Q14 | Projects span multiple repos; service map, contract-first changes, impact analysis |
| Q15 | Full auto inside the OS sandbox; short always-ask list; secrets redacted |
| Q16 | Bare-bones app + Inspector from day one; self-host from Phase 4 |
| Q17 | Orchestrator model: session picker → per-project remembered choice → global default |
| Q18 | Brain seeding: static index + skeleton pass + lazy learning + idle-quota enrichment |
| Q19 | Local models as free helpers + trivial workers + local-only mode |
| Q20 | Feature scope per the table (diff, terminal, files, browser, GitHub, usage, automations, notifications); side chats later dropped in favor of Chats (Q24) |
| Q21 | MIT, no telemetry, universal macOS 14+, DMG + Homebrew, signed updater, `ai.brigadier.app` |
| Q22 | Cross-platform core from day one; Windows and Linux ship in Phase 10 |
| Q23 | Composer environment: Local checkout (commits on the picked branch) or New worktree (session branch from the picked base, merged into it on approval); worker worktrees in both |
| Q24 | Chats are plain conversations with the picked model (no orchestrator), under "Chats" in the sidebar |
| Q25 | Archive (hidden, cleaned up, restorable) / Delete (permanent, Brain knowledge kept by default); idle sessions hibernate |
| Q26 | One permission picker combining autonomy and sandbox; outward actions always ask (levels finalized in Q27) |
| Q27 | Levels: Ask for approval / Approve for me (default; stricter fusion review approves big plans on your behalf; stops only for questions only you can answer) / Full access (no sandbox, orange pill) |
| — | Additions (2026-09-24): leave-no-litter cleanup ledger and litter guard; BB-parity composer; message queue (steer, edit, reorder, pause/resume); a sidebar with Projects and Chats; assistant-ui design system + elements as the full UI kit; dark-only theme with Compact / Normal density, everything token-driven |
| — | Token economy (2026-09-28, revised 2026-09-30): no budgets and no shortening sessions; lossless reductions judged per completed task on quality plus observed quota-window use; in order: measure first, precise and batched reads, a lean stable fixed start, thinking (effort per step where the cache survives), cache-aware idle with rebirth instead of resume when the cache is cold, a terse orchestrator voice (caveman), a command-output store (own filters, a Brigadier `run` tool for Codex), cheap-model digests; no fresh session per user message (§7) |
