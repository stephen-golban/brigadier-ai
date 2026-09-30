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
  - Triggers at about 150–200k tokens, between turns only, or when a new message arrives after the session's cache has expired (§7 item 3).
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
- **Routing page:** per kind of work, Automatic (the live ranking and why) or Manual (the user's ordered models and efforts, tried top-down; "Only these" waits for them instead of falling to others), everywhere or per project, with area overrides. `never`/`only` rules and Brigadier's hard rules still apply to a Manual list; it waives only the default quality floor, and beats `prefer` rules, pins that don't bind, balancing and trials.
- **Providers and Routing pages:** Providers switches each agent on or off and chooses which of its models are **available** (in every model picker and on Routing); an agent off or a model unavailable gets no work at all, background jobs included, while conversations already running keep their model. Routing chooses which available models the orchestrator **may give worker tasks to**. A model seen after its agent's first list starts available but gets no worker tasks, trials included, until the user allows it on Routing (user decision 2026-10-01).
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
- **Settings:** density (Compact / Normal), default orchestrator model and effort, default permission level, test toggle, secrets list, routing (rules and manual rankings, on the Routing page), plugins, skills, local models, enrichment toggle.
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

## 7. Token economy (rewritten 2026-09-30 from measurements; savers built behind settings, three on by default)

**Goal:** Teams that use AI all day stop running out of Claude and Codex usage, without losing context or slowing down, and sessions run as long as the user wants without the model losing track. Brigadier does this by itself in every session.

**Rules**
- **No budgets or caps.** Nothing stops, throttles or interrupts work to save usage.
- **Context is never dropped silently.** A fresh CLI session under a Brigadier session or task is allowed (rebirth, hand-off), because the Brigadier session goes on and what the old CLI session knew is carried over: a handoff note, the decisions, the last messages word for word, and the full transcript on disk. Cutting or summarizing inside a running CLI session without that is not.
- **Lossless.** What leaves the model's view stays retrievable, and the model is told where.
- **Judged per completed task.** A change is turned on by default only when completed tasks show less usage at equal quality: the share of each quota window used, the calls, rework, verification and whether any decision was lost. Results stay separate per provider and project. Fewer tokens per call that cause extra calls later are a loss (cutting tool output by 38% raised one bill by 7%: [arXiv 2607.12161](https://arxiv.org/abs/2607.12161)).

**What the usage is made of** (re-measured 2026-09-30: 25,930 Claude Code calls over 30 days on one heavy user's machine, 98.6% Opus 5.5, 85% of it Brigadier development; weighted by Opus 5.5 API prices, since neither vendor publishes how subscription limits weigh tokens, so every share is an estimate)
- Cache reads 59.4%, one-hour cache writes 19.3%, five-minute writes 5.2%, output 16.1%.
- **Context size is the whole game:** 57.7% of usage comes from calls made at 200–500k tokens of context, 25.3% at 100–200k. Every call re-reads the whole context.
- Tool results are about 30% (Bash 20.6%: mostly successful file reads with `sed`, `cat` and `grep`). Build, test and lint output is under 1%.
- Output: thinking 32%, tool-call inputs 37.5%, visible prose 5.6%.
- Hand-run sessions: median 4 and mean 21 calls per user message; 66% of messages come within 5 minutes, 3.1% after more than an hour. Brigadier's orchestrator: 1.7 calls per message, about 1.6k tokens of growth per message.
- The fixed start of a fresh session is shared through the cache across sessions: a second new session with the same flags within the hour writes 0 tokens and reads it all.

**The six outside tools and the Brain** (full study: the 2026-09-30 token-tools report)
- **None is integrated.** headroom rewrites requests through a local proxy (not allowed on subscription sign-in, and its lossy transforms cut file reads the model asked for; 0.45% lossless). RTK saves 0.21% on our mix and its hook grants permissions from the user's own settings. Graft and graphify add about 1.1% if their hooks run every session. caveman's rules cost more to carry than they save. ponytail's rules are about 0.2–0.4% of writes.
- **Borrowed:** four of ponytail's rules for writing less code (item 4), a plain-English voice in our own words that keeps caveman's brevity without its slang and without its name, plus the unslop checklist's rules against over-compression (item 5). Worth borrowing later: headroom's lossless JSON-table folding for large MCP output, RTK's per-command digests for an output store (item 8), Graft's ranking for plain-language code questions in `crates/index`.
- **The Brain stays.** Neither Graft nor graphify stores decisions, conventions, provenance or rebirth briefings; on code questions plain `rg` beats both on exact names. The finding that matters: workers made 0 calls to Brigadier's code tools in 30 days, because the worker prompt never named them (item 4).

**Built (2026-09-30), each behind a switch under Settings → Usage → "Use less usage"**
- **On by default** (the user's decision, 2026-09-30): rebirth when the cache has expired, lean worker tools and code pointers.
- **Off by default:** concise replies and build rules. The worker hand-off stays off until one long real task confirms its saving.
- A saved settings file from before a switch existed takes that switch's default.

1. **Measurement.** Per-task usage already lands in `routing.sqlite` (`turn_usage`: input, cached input, cache writes and output per turn, by task and conversation) and quota readings in `quota_samples`. The A/B harness drives a debug daemon with its own data directory over IPC and compares arms on the same tasks. Still to build: a per-task report in the Inspector, and cache writes split by cause.
2. **Hand long workers to a fresh session** (`workerHandoff`, size `workerHandoffTokens`, default 160k). Workers are where the 200–500k calls are. Once a worker's context passes the size mid-turn, it is asked to finish its current step and end its turn with a handoff note; a fresh session of the same model continues in the same worktree with the note, the last six messages word for word, any pending message, and `<scratch>/handoff/` (spec, progress log, diff and the whole transcript). A message for a worker between turns past the size starts the fresh session at once. It never happens inside a tool call, and it keeps the task's model and attempt. Replayed on the real sessions, a hand-off at 160k saved an estimated 13.2% of usage (16.2% at 100k, 10.2% at 300k).
3. **Rebirth an orchestrator when its cache has expired** (`rebirthWhenCacheExpired`, Claude only). An orchestrator idle past its one-hour cache would rewrite its whole history at 2× on resume. While the cache is still warm (at 5/6 of its lifetime) a fork writes a checkpoint handoff note; if the next message comes after the cache expired, the orchestrator is reborn from the usual briefing plus that note instead of resuming. Without a checkpoint that covers the last request, it resumes as before. The last request is tracked per native session and recovered from the orchestrator log after a restart. Codex stays off until its cache lifetime through the app-server is measured. Modelled saving: about 20% of orchestrator usage over a 50-message session (an estimate).
   - The checkpoint's fork keeps the cache warm. Measured on Claude Code 2.1.285: a fork at 50 minutes read the whole history from the cache and wrote its own few tokens at the one-hour lifetime. Twenty minutes later, a resume of the parent read all 23.9k from the cache, while a control session without a fork had to write 19.4k again. So the cache counts as expired only one lifetime after the checkpoint. This was checked live with a 240 s debug lifetime. A turn at 285 s resumed and read 12.2k from the cache, writing 49 tokens. A turn at 541 s was reborn from the checkpoint and kept a commitment from the first message.
   - **Proposal, not built: keep the cache warm on purpose.** A tiny fork call refreshes the cache for another hour, at about 0.05× the context. A rebirth costs about 2× a 20k briefing. At a 150k context that is about 7.5k per hour kept warm against about 45k for one rebirth, so keeping it warm pays for gaps up to about six hours. Past that, rebirth wins. This needs the user's view on background calls while nobody is working.
4. **Lean worker tools and pointers** (`leanWorkerTools`, `codePointers`, `buildRules`).
   - Claude workers start without 16 built-in tools they never use: 15.0k → 10.1k tokens at the start of every request (measured on Claude Code 2.1.285), an estimated 1.6% of usage. Codex keeps Brigadier's current flags: a leaner Codex prompt lost the shared cache (0 cached tokens against 11.4k), so it cost more.
   - Workers are told to find code with `code_search`, `code_refs` and `project_map` before grepping or reading whole files, and Brain answers name each hit's files.
   - Implement and merge workers reuse what exists, add nothing the task doesn't need, update every caller of what they change, and never simplify away validation or security checks.
5. **Concise replies** (`conciseReplies`). Plain, short, normal English in whole sentences for the orchestrator and worker reports. Measured on 5 prompts × 2 runs on Sonnet 5, no terse wording saved output tokens (the run-to-run spread for the same prompt was up to 3×), so this is about readability, not usage, and stays off unless the user wants the style.

**A/B on real Brigadier tasks (2026-09-30).** A debug daemon ran each arm on its own copy of the repository at 49bdf1c, with an Opus 5.5 orchestrator and workers pinned by a routing rule. n is 1 per arm, so every usage difference below is a direction, not a measurement.
- **Worker hand-off, quality.** H1 was a docs task: a glossary of 10 types, then a follow-up from the orchestrator adding 4 more "in the same format and order you chose". It ran with the size lowered to 25–27k so the hand-off had to fire.
  - Codex (gpt-6.1-sol): one hand-off with a note.
  - Claude (Opus 5.5): two hand-offs. One was mid-turn with a note; the other was between turns, carrying the follow-up.
  - In both, the worker's own format and sort-order decisions and its commitments survived every seam. The file had 14 correct entries and a correct report, the same as without a hand-off.
  - The note also carried an honesty point: a check that had failed to run must not be reported as passed.
  - A worker already done when asked to wrap up reported instead of handing over, as the steer allows.
- **Worker hand-off, usage.** At a 25–27k size it costs more: each fresh session writes its start to the cache again. Claude came to 107k weighted vs 72k without a hand-off; Codex to 92k uncached input vs 23k. That is expected, because a hand-off only pays where the context is large. The saving estimate stays the transcript replay: about −13% of usage at 160k. It needs a long real task to confirm.
- **Savers (lean tools, code pointers, build rules, concise).** Two scout questions with known answers, each arm on Claude (Sonnet 5 worker) and Codex. Every answer was correct in every arm.
  - Claude with savers: the first request went from 30.7k to 26.0k tokens, and calls fell from 20 to 12. Weighted worker usage fell by about 13% (177k to 153k).
  - Codex with savers: calls went from 9 to 11, uncached input from 49k to 39k and cached input from 190k to 193k. So there is no clear change: Codex keeps its default tools, and the rest is prompt text.
- **Concise voice.** 5 prompts, 2 runs each, on Sonnet 5 with `claude -p`. No terse wording saved output. Ours with the unslop rules came out at +39% output tokens, inside a run-to-run spread of up to 3× for the same prompt.
- **Rebirth when the cache has expired.** 3 of 3 live rounds on a debug daemon with a 10-minute debug lifetime passed. Each wrote a checkpoint while the cache was warm, was reborn with trigger `cacheExpired`, and kept a commitment made in the first message, 8 to 24 exchanges back and far outside the verbatim tail.

**Proposals that need the user's decision**
- **Fresh `claude -p` / `codex exec` per user message: no, as a default.** For the orchestrator (about 2 calls per message) a 50-message session costs about 2.5× more than resuming, and every message is a lossy seam. It pays only for long agentic turns, and the worker hand-off (item 2) captures that saving at one seam per 160k instead of one per message. The stripped fixed start the idea relies on is item 4.
- **Replacing the Brain with Graft or graphify: no.** Keep the Brain; borrow Graft's plain-question ranking into `crates/index`.
- **Turning savers on by default:** decided (see Built). Lean worker tools, code pointers and rebirth when the cache has expired are on. The worker hand-off at 160k comes on after one long real task confirms the replay's saving; its quality held in every test. Concise replies (style only) and build rules (no evidence either way yet) stay off.

**Not doing, and why**
- Output caps, per-step token limits and history trimming break the rules above.
- Lossy prompt compression and request-rewriting proxies (headroom): lossy, and not allowed on subscription sign-in.
- Batch APIs are discounted only on API billing.
- Stripping Codex's fixed start further: it loses the shared cache.
- `--bare` for Claude: it needs an API key, so it doesn't work on a subscription.

**Next, in order**
1. Per-task usage in the Inspector, and cache writes by cause.
2. A lossless command-output store (RTK's digests, full output kept with an ID), for projects with heavy build and test output.
3. Precise, batched reads from the code index (outline, one symbol, a line range).
4. Thinking: effort per step where the model keeps its cache across effort changes; per task elsewhere.

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
| A CLI changes its MCP protocol under us (2026-09-30: Claude Code 2.1.285 began offering MCP 2026-07-28, which requires cache fields on `tools/list`; without them every session started with no Brigadier tools) | Set every field the newest protocol requires. Check that a session's Brigadier tools loaded (the CLI's MCP log, or a tool missing from its init event), and say so in the Inspector instead of letting the orchestrator run without them. |

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
| — | Token economy (2026-09-28, revised 2026-09-30; superseded by the next row): no budgets and no shortening sessions; lossless reductions judged per completed task on quality plus observed quota-window use; in order: measure first, precise and batched reads, a lean stable fixed start, thinking (effort per step where the cache survives), cache-aware idle with rebirth instead of resume when the cache is cold, a terse orchestrator voice (caveman), a command-output store (own filters, a Brigadier `run` tool for Codex), cheap-model digests; no fresh session per user message (§7) |
| — | Token economy rewritten from measurements (2026-09-30, §7): context size is the lever (58% of usage at 200–500k); none of headroom, Graft, RTK, ponytail, caveman or graphify is integrated (techniques borrowed); the Brain stays; built behind settings, off until completed tasks show equal quality: worker hand-off to a fresh session at a size (default 160k), orchestrator rebirth when its cache has expired (Claude only), lean Claude worker tools, code-tool pointers, build rules, a plain-English concise voice (readability, no measured saving). On by default after the A/B (the user, 2026-09-30): rebirth when the cache has expired, lean worker tools, code pointers; the worker hand-off after one long real task confirms its saving; concise replies and build rules off. Proposal for the user: no fresh session per user message as the default |
