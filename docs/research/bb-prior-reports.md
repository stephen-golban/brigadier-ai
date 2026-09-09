# get-bb/bb — competitive read, Tasks plugin, parent/child threads, ACP vs SDK vs direct stdio

Detailed subagent report, 2026-09-09, feeding `docs/research/bb.md`. Claims are marked as in that file: read in source = measured; everything else asserted. Nobody ran bb.

---
# Prior research reports on get-bb/bb (2026-09-09), gathered by three subagents

## Report 1 — competitive read

- Repo: MIT, created 2026-02-24, last push 2026-09-08, 5,521 commits, 3,438 stars, 429 forks, 449 open issues, 47 releases. Latest stable desktop-v0.42.1 (2026-09-05); nightly channel. Top contributor is a bot account `codex` (2,803 commits) ahead of ymichael (1,284) and SawyerHood (1,056).
- Language: TypeScript 35.1 MB, zero Rust. pnpm/turbo monorepo.
- Architecture: Electron shell (apps/desktop, electron-builder) supervising a Node server (SQLite/better-sqlite3, HTTP + WebSocket) + per-machine host-daemon + web app + `bb` CLI + Expo mobile client. Multi-host, remote-capable.
- Drives Claude via @anthropic-ai/claude-agent-sdk ^0.3.245, query() with canUseTool (plugins/provider-claude-code/src/bridge/sdk-session.ts, bridge.ts:38,2342). Codex via `codex app-server`; Cursor/others via ACP (packages/provider-bridge-acp); plus Pi.
- Downloadable today (macOS arm64 dmg, Linux AppImage alpha, `npx bb-app@latest`, Windows via WSL2). Telemetry on by default, opt out BB_TELEMETRY=false. Free, runs on user's own provider subscription.
- Pillars vs brigadier: no non-accumulating harness (coordinator was a "manager" thread, an LLM conversation — docs/system-overview.md); usage windows exist (system.usageLimits -> windows[{usedPercent,resetsAt}] in plugins/provider-usage) but schema also carries cost{usedUsdCents,limitUsdCents}; account-pool switches accounts at 98% to keep bb running (opposite of brigadier's 80% human reserve); no fusion/cross-model judge found; no exit-code red gate or worktree racing found (workflows plugin retries/caches steps); per-thread managed worktrees with setup/teardown (docs/worktrees.md) but no owned-paths partitioning; memory/tasks/workflows resume via long-lived thread; cloud accounts, remote hosts, mobile.
- bb has that brigadier lacks: multi-provider today, plugin/marketplace SDK, CLI + HTTP API + mobile, remote hosts/tunnels, multi-account pooling, GitHub/tasks/automations/scheduling, shipping installers.
- Not verified: 86 KB bridge.ts and apps/server not read in full; bb never run.

## Report 2 — Tasks plugin and parent/child threads

Q1 Tasks plugin (plugins/tasks/): own SQLite DB via bb.storage.database(); migrations plugins/tasks/db/schema.ts. Tables: folders, projects (prefix UNIQUE, next_task_number, linked_bb_project_id), tasks (id, project_id, number, title, description, status, priority, due_date, parent_task_id, position REAL, created_at, updated_at; UNIQUE(project_id,number) -> BB-1 key; status in backlog/todo/in_progress/in_review/done/canceled; priority urgent/high/medium/low/none), labels/task_labels, comments, attachments, task_threads (task_id, thread_id GLOB 'thr_*', preset_name, title, live_status in starting/working/idle/completed/failed), presets (provider_id, model_id, reasoning_level, permission_mode, instructions, builtin, environment_kind 'project-default'|'new-worktree', base_branch, machine_id). task_list_revision table + triggers invalidate list cursors.
Creation: UI (views/manage/new-task-dialog.tsx), CLI `bb tasks create --project PROD --title ... --priority high`, agents via same CLI (plugins/tasks/cli/index.ts, 2140 lines). No dedicated agent tool.
Delegation (plugins/tasks/delegate/index.ts): RPC delegate({taskId, presetId, extraInstructions?}) -> {threadId}. buildSeedPrompt (index.ts:102-) with Description / Project context / Sub-tasks / Attachments / Recent comments / Report-back contract: "You are working on task ${key}. Use the bb tasks CLI: comment substantive updates ... set status when done (bb tasks update ${key} --status in_review)" (index.ts:118). Then bb.sdk.threads.spawn({projectId, environment, providerId, model, reasoningLevel, serviceTier, permissionMode, title, prompt}), upserts task_threads liveStatus "starting"; if status backlog/todo -> in_progress + system comments (index.ts:433-441). delegate does NOT set parentThreadId — tasks delegation and parent/child threads are separate mechanisms.
Agent self-pickup: `bb tasks attach KEY` (BB_THREAD_ID), `bb tasks update KEY --status in_review`, `bb tasks comment --notify`, `bb tasks detach`. Skill plugins/tasks/skills/tasks/SKILL.md; references/delegation.md covers presets (`bb tasks preset create --provider codex --model gpt-5.6-sol --reasoning high`). Command table README.md:68-85.

Q2 Spawn-and-manage: the `bb` CLI from the agent's shell tool, not an MCP tool. apps/cli/src/commands/manager.ts:4-9 stub: "Manager threads were replaced by parent threads. Use `bb thread spawn --parent-thread <id>` ... `bb thread list --parent-thread <id>`". apps/cli/src/commands/thread/spawn.ts:281-282 `--parent-thread <id>` and `--parent-self` (:92-112), calls sdk.threads.spawn({..., parentThreadId, providerId, model, permissionMode, environment}) (:414-448). Cross-provider: `--provider codex|cursor|pi|...`.
Storage: packages/db/src/schema.ts:533 parentThreadId references threads.id onDelete set null; index threads_parent_idx (:569).
Notification: pushed system message. apps/server/src/services/threads/child-thread-notifications.ts: queueChildThreadTurnNotificationBestEffort (:439) batches over CHILD_THREAD_BATCH_DELAY_MS=2000 (:71), injects rendered template via queueParentSystemMessage; child's last output up to CHILD_THREAD_TERMINAL_OUTPUT_EXCERPT_CHAR_LIMIT=4000. Templates packages/templates/src/templates/system-message-child-thread-outcome-batch.md and -needs-attention.md. Blocked children notify via queueChildThreadNeedsAttentionNotificationBestEffort (:458). Blocking `bb thread wait <id>` (20 min default).
Skill teaching delegation: apps/server/src/services/skills/builtin-skills/bb-cli/references/thread-creation.md (:32 root unless --parent-thread; :129-145 permission inheritance, parent mode hard ceiling; :140-145 --parent-self) and thread-operation.md:4-14 ("One clear owner per task… Let threads work after spawning. Do not poll with shell sleeps"; `bb thread tell` to steer).
Not found: no spawn_thread MCP tool; plugins/provider-claude-code/src/bridge/tool-proxy-mcp.ts is a generic in-process MCP server for plugin dynamic tools. packages/plugin-sdk/src/claude-task-tools.ts is dead code. Not read: child-thread-confirmation.ts, server spawn route, child-thread tree UI.

## Report 3 — ACP / SDK vs direct stdio

- Anthropic SDK overview: SDK is Python and TypeScript only; other languages should run the CLI as a subprocess. The SDK spawns `claude` with `--output-format stream-json --verbose --input-format stream-json`, NDJSON per line; bundles its own 199 MB binary (optionalDependencies); pathToClaudeCodeExecutable overrides. Python SDK also subprocess.
- ACP: JSON-RPC 2.0 over stdio. Native: Gemini CLI, Cursor CLI, Goose, Qwen Code, opencode. Adapter-only: Claude, Codex. Claude 2.1.265 has no ACP. Zed's claude-code-acp adapter depends on the Agent SDK 0.3.257. Rust crate agent-client-protocol 2.1.0 exists.
- t3code: SDK query() with canUseTool; ACP only for Cursor/Grok/Antigravity. bb: same pattern.
- Liability: control_request/control_response/can_use_tool undocumented, no stability promise. Mitigations in brigadier: capabilities on init, scripts/cli-drift.mjs. Envelope byte-identical across 289 SDK releases (secondhand census).
- Prior art: HumanLayer CodeLayer (Tauri + Go daemon, claudecode-go, stream-json); unofficial Rust/Go crates.
- brigadier docs/research/acp.md:577 already records "do not adopt" on 2026-09-05.
