# get-bb/bb — competitor dissection and what to take from it

2026-09-09. https://github.com/get-bb/bb, https://getbb.app. MIT.

Marking, as in `docs/vision.md`: **[measured]** = read at the cited `file:line`, run, or counted.
**[asserted]** = their docs, marketing, an issue report, or an inference from absence. bb source was
read by three subagents this pass; one constant was re-fetched by hand and is flagged. **Nobody ran
bb.** Every bb behaviour below is source, shipped docs, or a user's issue report — none observed.
brigadier's own state is `scratchpad/bb/04-brigadier-today.md` at `c4d9d29`; only what runs is
credited, never vision.

---

## 1. Bottom line

- bb is a multi-provider, multi-machine agent *chat harness*: Electron + Node + SQLite, threads that
  spawn child threads, per-thread git worktrees, plugins for tasks/workflows/automations. **[measured]**
- bb is **not** a non-accumulating lead. There is no manager role, no plan object, no exit-code gate,
  no owned-paths partition, and nothing automatic happens when a context fills. **[measured]**
- Verdict on overlap: bb owns the surface area brigadier does not want (hosts, mobile, account pools,
  marketplace) and has not built the one thing brigadier claims (a harness that owns the plan and
  rents windows). The overlap is the *chat client half* of brigadier — which is the half a stranger
  currently sees. **[asserted]**
- Do next, in order: (1) land the usage gauge — poll `api/oauth/usage` the way bb does, and stop
  dropping `rate_limit_event` at `crates/core/src/claude/adapter.rs:587`; (2) make the loop the
  product in the UI and collapse the two orchestration stories into one tree; (3) make a run
  survivable — hash-keyed step replay plus durable attempt counts, borrowed from bb's workflows and
  retry plugins.

## 2. What bb is — facts

- Created 2026-02-24, last push 2026-09-08; **5,521 commits**, **3,438 stars**, 429 forks, 449 open
  issues, 47 releases. **[measured]**
- Top committer is a bot account, `codex`, with **2,803 commits** — more than half the history and
  ahead of ymichael (1,284) and SawyerHood (1,056). They ship agent-written code as the norm. **[measured]**
- TypeScript **35.1 MB**, zero Rust. pnpm/turbo monorepo. Electron shell (`apps/desktop`) supervising a
  Node server (better-sqlite3, HTTP + WebSocket), a per-machine host daemon, a web app, a `bb` CLI, and
  an Expo mobile client. **[measured]**
- Distribution: macOS arm64 dmg (desktop-v0.42.1, 2026-09-05), Linux AppImage alpha, `npx bb-app@latest`,
  Windows via WSL2; nightly channel. **[measured]**
- Licence MIT. Telemetry **on by default**, opt out with `BB_TELEMETRY=false`. **[asserted]** (their docs)
- Pricing: free, runs on the user's own provider subscription — same economics as brigadier, plus
  optional getbb.app cloud accounts for `bb connect`. **[measured]**

## 3. How bb is built

### (a) Provider layer

- Claude via `@anthropic-ai/claude-agent-sdk ^0.3.245`, `query()` with `canUseTool` (`get-bb/bb:plugins/provider-claude-code/src/bridge/sdk-session.ts`, `.../bridge.ts:38,2342`). Codex via `codex app-server`; Cursor and others via ACP (`get-bb/bb:packages/provider-bridge-acp`); plus Pi. **[measured]**
- The SDK spawns `claude --output-format stream-json --verbose --input-format stream-json` and bundles its own 199 MB binary. **[measured]** bb's Claude path is brigadier's path with a Node layer in it; direct stdio (`crates/core/src/claude/process.rs:118-160`) is the same protocol without the dependency, and `docs/research/acp.md:577` already recorded "do not adopt" for ACP on 2026-09-05.
- Provider is fixed at thread creation: "a provider session IS the conversation and no other provider can continue one it never started" (`thread-default-policy.ts`). **[measured]**

### (b) Thread lifecycle

- DB status enum is six values: `pending | idle | starting | active | stopping | error` (`get-bb/bb:packages/domain/src/thread-lifecycle.ts`). **[measured]**
- A literal transition table `THREAD_LIFECYCLE` driven by a CAS single-writer `applyThreadLifecycleEvent`; events are only `run.preparing | run.started | run.succeeded | run.failed | stop.requested | stop.settled`, each with supersession predicates (`notArchived`, `notDeleted`) checked inside the writer's transaction; an absent cell is a logged `illegal-transition` no-op, not an error. **[measured]**
- The client sees a wider derived enum, `ThreadRuntimeDisplayStatus` = those six plus `provisioning | host-reconnecting | waiting-for-host` (`get-bb/bb:packages/domain/src/thread.ts:36-47`), computed server-side and pushed as `status-changed`. **[measured]**
- **There is no manager.** `Thread` has no `kind`/`role`; only `parentThreadId`, `sourceThreadId`, `originKind`, `visibility` (`:391-411`); `get-bb/bb:docs/system-overview.md` still says "standard or manager" and is stale. Parenthood is that one nullable column plus counts on list rows (`ThreadActivityState{activeWorkflowCount,…}`), so a parent with live children renders `idle`. **[measured]**

### (c) Parent/child threads

- Spawn from the agent's own shell tool: `bb thread spawn --parent-thread <id>` / `--parent-self` (`get-bb/bb:apps/cli/src/commands/thread/spawn.ts:92-112,281-282,414-448`). There is **no** spawn MCP tool; `packages/plugin-sdk/src/claude-task-tools.ts` is dead code; `apps/cli/src/commands/manager.ts:4-9` is a stub reading "Manager threads were replaced by parent threads." **[measured]**
- Storage: `parentThreadId` → `threads.id ON DELETE SET NULL`, index `threads_parent_idx` (`get-bb/bb:packages/db/src/schema.ts:533,569`). **[asserted]** — cited once, not re-read this pass.
- **Notification batching, re-fetched by hand today:** `get-bb/bb:apps/server/src/services/threads/child-thread-notifications.ts:73` `CHILD_THREAD_TURN_NOTIFICATION_BATCH_DELAY_MS = 2_000`, `:77` `CHILD_THREAD_TERMINAL_OUTPUT_EXCERPT_CHAR_LIMIT = 4_000`, timer at `:397`, entry points `queueChildThreadTurnNotificationBestEffort` `:439` and `…NeedsAttentionNotificationBestEffort` `:458`. **[measured, by me]** The prior report's constant name and line were both wrong; the numbers were right.
- Outcomes render from `get-bb/bb:packages/templates/src/templates/system-message-child-thread-outcome-batch.md` and `-needs-attention.md`, injected as `[bb system]` turns into the parent. **[measured]**
- Steering: `bb thread tell` (`--mode steer|queue|auto`, steer default, lands mid-turn), `bb thread wait` (default `--status idle`, 1,200 s), `thread list --parent-thread`, `count --parent`, `show [--git-diff]`. **[measured]**
- Permission inheritance (`thread-default-policy.ts`): requested flag → last execution → parent's mode → project default, then `clampPermissionModeToCeiling` makes a **live** parent's mode a hard ceiling, then a clamp to what the provider supports. Modes `accept-edits | auto | full`. The user never approves a spawn; `child-thread-confirmation.ts` is 44 lines and only guards archive/delete of a parent with children (409 `child_threads_confirmation_required`). **[measured]**
- The doctrine is one skill injected as a synthetic Claude Code plugin `bb-global-skills` (`plugins/provider-claude-code/src/bridge/skill-plugins.ts`). Its whole content: `thread-operation.md:5-14` "Use one clear owner per task… Let threads work after spawning. Do not poll with shell sleeps"; `thread-creation.md:160-162` "objective, constraints, expected deliverable, validation to perform, and what to report back". **[measured]**
- **Absent from that doctrine:** how many children, how to size a slice, worktree-per-child as a rule, how to review a child's diff, how to merge. **[measured]** That is the delegation product, and bb does not ship it.

### (d) Tasks plugin

- Own SQLite DB via `bb.storage.database()` (`get-bb/bb:plugins/tasks/db/schema.ts`): folders, projects (`prefix UNIQUE`, `next_task_number`), tasks (`UNIQUE(project_id,number)` → the `BB-1` key, `parent_task_id`, `position REAL`, status `backlog|todo|in_progress|in_review|done|canceled`), labels, comments, attachments, `task_threads` (`live_status starting|working|idle|completed|failed`), `presets`, and a `task_list_revision` table whose triggers invalidate list cursors. **[measured]**
- **Presets** bundle `provider_id, model_id, reasoning_level, permission_mode, instructions, builtin, environment_kind ('project-default'|'new-worktree'), base_branch, machine_id` — one row is a whole execution profile. **[measured]**
- Delegate RPC (`get-bb/bb:plugins/tasks/delegate/index.ts`): `delegate({taskId, presetId, extraInstructions?}) → {threadId}`; `buildSeedPrompt` at `:102` assembles Description / Project context / Sub-tasks / Attachments / Recent comments / report-back contract; then `bb.sdk.threads.spawn({...})`, upsert `task_threads.liveStatus="starting"`, backlog/todo → `in_progress` with system comments `:433-441`. **[measured]**
- **Report-back contract**, verbatim at `:118`: "You are working on task ${key}. Use the bb tasks CLI: comment substantive updates … set status when done (`bb tasks update ${key} --status in_review`)". **[measured]**
- Self-pickup without delegation: `bb tasks attach KEY` (via `BB_THREAD_ID`), `update --status`, `comment --notify`, `detach`. **[measured]**
- `delegate` does **not** set `parentThreadId` — tasks delegation and parent/child threads are two mechanisms that do not know about each other. **[measured]**

### (e) Worktrees and environments

- Environments are **plugins** against an experimental contract (`get-bb/bb:packages/plugin-sdk/src/environment-provider.ts`); core owns launch, retry, cancellation, retirement, teardown. First-party: project-checkout, git-worktree, personal-workspace. **[measured]**
- Creation `["worktree","add","-B",branchName,targetPath,baseBranch]` (`get-bb/bb:plugins/environment-git-worktree/host/worktree.ts:601`; reuse path `:575`) under a metadata lock plus a ref-mutation lock for the pre-fetch. Layout `<BB_DATA_DIR>/plugins/environment-git-worktree/host-data/worktrees/<thread-id>/<repo-name>`. **[measured]**
- Naming `` `${branchPrefix}${slug}-${threadId}` `` (`apps/server/src/services/threads/thread-create-helpers.ts:31`), slug from the generated title. **[measured]**
- Base branch `{kind:"default"}` or `{kind:"named"}`; default prefers `origin/<default>` when the local default is equal-or-behind, and bb fetches the remote base before `worktree add`; `--base-branch` is rejected without `--new-environment worktree` (`spawn.ts:132`). **[measured]**
- Hooks `.bb-env-setup.sh` / `.bb-env-teardown.sh` at repo root, run by core only when `create` returned `ownsPath: true`; `env bash <script>`, stdin closed, **15-min timeout each**, output into the provisioning transcript. **Env is sanitised — `NODE_ENV` and all `BB_*` removed, and no `BB_PROJECT_ID`/`BB_ENVIRONMENT_ID`/`BB_SOURCE_PATH` injected.** Non-zero setup fails provisioning and the worktree is removed. **[measured]**
- `.worktreeinclude` (gitignore syntax, committed) copies untracked files after `worktree add`, before setup; copies only, never overwrites tracked files. **[measured]**
- Retirement: deleting the last thread removes it at once; archiving starts a **5-minute** grace (`environment-provider.ts:100`), then teardown script → SIGTERM/SIGKILL **every process whose cwd is inside the worktree** → `git worktree remove --force`. **The branch is kept, not merged, not archived.** **[measured]**
- **Two threads can share one worktree by design** ("a coding thread and a review thread in the same worktree"; `tests/integration/fake/multi-thread/shared-environment.test.ts`); nothing partitions files, only events and transcripts are isolated. The one mutex is path admission for branch switching: `workspace_busy`, "Cannot checkout branch while another thread is using this workspace" (`apps/server/src/services/environments/path-admission.ts`). **[measured]**
- bb **never creates a PR**: `packages/host-workspace/src/git-host.ts` shells `gh pr view` and `gh pr ready|merge`; creating and pushing is left to the agent. **[asserted]** — no `pr create` found, but the code search was rate-limited mid-sweep.
- Commit is a button/CLI action with an LLM-written message (`apps/server/src/routes/environments.ts:40,671`, `generateCommitMessage`, fallback `"bb: automated commit"`); no auto-commit on turn end was found. **[measured/asserted]**

### (f) Hosts, machines, `bb connect`

- A "machine" is a host daemon (`get-bb/bb:apps/host-daemon`) dialling **out** to the server over an authenticated reconnecting WebSocket; enrollment via `bb machine join-code` + `install-machine.sh`; launchd/systemd with `--auto-update` (5 s→5 min backoff). Per-machine `maxPermissionMode` (default Full Access) caps any thread on it, UI-only. **[measured]**
- The wire (`packages/host-daemon-contract/src/commands.ts`, 2,123 lines of zod) carries `thread.start/turn.submit/stop`, `host.read_file/write_file/list_paths`, `project.inspect/clone`, `environment.hook.run`, `provider.usage`, `workspace.status/diff/commit/pull_request`. **File contents, diffs and prompts all cross the socket.** **[measured]**
- `bb connect` is a Cloudflare Worker tunnel (`apps/connect`, `packages/tunnel-client`); the server holds it and exposes `https://<handle>.getbb.app`, gated to the owner's getbb.app account. **[measured]**

### (g) Model and provider selection

- Models are **probed live, not declared**: `plugins/provider-claude-code/src/bridge/model-list.ts` runs `query({prompt:".", maxTurns:0})` and reads `initialization.models`, memoised with a TTL; a static catalog supplies display names and per-model default reasoning effort; `DEFAULT_CLAUDE_CODE_MODEL = "claude-opus-5[1m]"`; extra models only via `customModels` in `config.json`, no CLI. **[measured]**
- Defaults ladder: explicit flags → live parent's execution → remembered per-project defaults (`ProjectExecutionDefaults`) → provider-reported default; re-remembered only for app-origin creates on a fresh environment. **[measured]**
- Mid-thread `bb thread update <id> --model --reasoning-level` sets a sticky model applied next turn; `bb thread tell --model` overrides one turn; provider never changes. **[measured]**

### (h) Long sessions

- **bb never triggers compaction; it observes the provider's and exposes a manual button.** `plugins/provider-claude-code/src/delta-translation.ts:624` turns the CLI's `compacting` status into a timeline item, `compact_boundary` emits `{kind:"context.compacted"}` `:660-668`; manual is `/compact` in the composer or `bb thread compact`, and the recording is literally a `turn/start` whose input text is `"/compact"`. Greps for `autoCompact` hit only `provider-pi` fixtures. **[measured/asserted]**
- Context meter `apps/app/src/components/thread/timeline/ThreadContextWindowIndicator.tsx` — donut plus popover, `{usedTokens}/{modelContextWindow}`, tone `>=90 destructive`, `>=75 warning` `:42-47`. **Purely cosmetic; no action fires.** **[measured]**
- Token math `input + cache_read + cache_creation` from the assistant message (`sdk-extraction.ts:345,312`); window from `result.modelUsage[model].contextWindow` floored by a hint table (200k default, 1M for `[1m]` models); the event is always `estimated: true`. **[measured]**
- Handoff is **fork, not summary**: `bb thread fork <id> [--source-seq-end] [--agent-context-seed]` clones the provider session on the same machine; `bb thread clear` resets timeline and model context in place, only when `status === idle|error` (`thread-context-clear.ts:31`). No LLM-written handoff exists. **[measured]**
- Resume: the provider session id is the Claude Code session UUID, passed as `resume` with `persistSession: true` (`sdk-session.ts:243-245,264`). **The model's transcript of record is Claude Code's own session file; bb replays nothing.** **[measured]**
- Idle kill `IDLE_PROVIDER_SESSION_REAP_AFTER_MS = 30 * 60 * 1000`, swept every 5 min, only for `sessionRestorable` runtimes (`apps/host-daemon/src/app.ts:66-67`); the next prompt calls `thread/resume`. **[measured]**
- Death mid-turn: `runtime-manager.ts:1106-1146` emits `turn/completed status:"failed"` plus `system/error code:"provider_process_exited"`. **Nothing auto-retries a crash.** **[measured]**
- Memory is a plugin with its own SQLite, a 3,900-character injected summary catalog, FTS5 search, agent-written through `bb memory add|search|…` only; embeddings deliberately deferred. **[measured]**

### (i) Usage and account pool

- **Two independent sources.** Polled HTTP `CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"` (`plugins/provider-claude-code/src/bridge/provider-maintenance.ts:30`) with the user's own OAuth token from the macOS keychain or `~/.claude/.credentials.json` `:275-289`, header `anthropic-beta: oauth-2025-04-20`, 15 s timeout, parsed as `five_hour`/`seven_day` `{utilization, resets_at}` plus a `limits[]` array of per-model windows `:451-476`. Stream event `provider/rateLimits/updated`, built from the CLI's `rate_limit_event.rate_limit_info` (`delta-translation.ts:302-338`). **[measured]**
- Schema `plugins/provider-usage/usage-schema.ts`: `windows: [{label, usedPercent, resetsAt, cost:{usedUsdCents, limitUsdCents} | null}]`, tone `>=95 critical, >=80 warning` `:70-81`. **Dollars are in the schema, and there is no user-settable reserve.** **[measured]**
- Account pool (`plugins/account-pool/`): a local hub serving Anthropic Messages and OpenAI Responses endpoints, with `claude` pointed at its base URL. "An account is skipped … at or above the switch threshold … defaults to **98 percent** of a window"; `bb pool config set switchThreshold`. Accounts run sequentially by priority, new conversations advance and **stay** on the fallback after recovery, session pins expire at 30 idle minutes, 4,096 MRU pins. **[measured]** The reserve semantics are the inverse of brigadier's: pool to keep **bb** running, not to protect the human's quota.

### (j) Reliability

- `plugins/provider-retry/src/retry-policy.ts`: `MAX_RETRY_ATTEMPTS = 5` (dispatch plus four), `RESET_BUFFER_MS = 15_000`, `RESET_JITTER_MS = 30_000` ("every thread blocked on one account hears about the same reset"), `OVERLOAD_RETRY_BASE_MS = 5_000` doubling, `DEFAULT_MAXIMUM_WAIT_MS = 6 h`. Decline reasons `not-retryable | no-rate-limit-state | not-resettable | beyond-maximum-wait | attempts-exhausted`. **Credit/spend limits are never retried**; `blockedWindowResetAtMs` takes the **latest** blocked window; **the attempt number rides the turn row, so the cap survives a server restart.** **[measured]**
- Manual `bb thread retry <id>` re-sends the failed turn verbatim; 409 `no_failed_turn` / `retry_already_queued`. **[measured]**
- Watchdog (`packages/agent-runtime/src/runtime.ts:265-288`): threshold 120,000 ms, polled every 15,000 ms, emits `provider_turn_start_timeout`. **It only warns — it does not kill or retry.** **[measured]**

### (k) Performance

- Timeline virtualised with `@tanstack/react-virtual ^3.14.2`; `TIMELINE_WINDOW_OVERSCAN_ITEMS = 8`, `TIMELINE_WINDOW_MAX_MEASUREMENTS = 2_000`, windowing only above 20 items; server budget `timelineWindowEventBudget: 1_500` events (`packages/domain/src/feature-flags.ts:11`). A synthetic 10,000-event thread must project every page under `SYNTHETIC_CEILING_MS = 1_500`. **[measured]**
- Transport: host daemon → server as event batches → SQLite rows → `hub.notifyThread(threadId, ["events-appended"])` over WebSocket; **the socket carries change notifications, not content**, and the app refetches timeline pages over HTTP. **[measured/asserted]** — the "no per-token frame" half is inferred.
- Pruning (`event-pruning.ts:59-63`) keeps active 1,000 / idle 300 / archived 120; an active prune needs ≥250 new seq and a ≥30 s gap; output truncation threshold 32 KB retaining 2 KB head + 2 KB tail. SQLite: WAL, `synchronous=NORMAL`, `cache_size=-262144` (256 MB), `mmap_size=1 GiB`, `busy_timeout=5000`. **[measured]**
- `EnvironmentReadCache` with in-flight dedupe: status TTL **3 s**, pull-request TTL **10 s** (`workspace-read-cache.ts:113-139`), invalidated by daemon change events. **[measured]**
- FS watching: @parcel/watcher in a **forked subprocess**, debounce **75 ms**, max wait **500 ms**, retry 250 ms→30 s, ignoring `.git`, `node_modules` and everything `git status --ignored=matching` reports; fingerprints suppress no-op pushes; the client re-debounces before invalidating queries. **[measured]**
- Open pain, their users' numbers **[asserted]** (issue reports, not maintainer benchmarks): #1131 synchronous SQLite on the event loop froze all clients **11.2 s** on a 1.7 GB db, static TTFB 2 ms → 7.3 s, `events` 1,447 MB of which `commandExecution.aggregatedOutput` 815 MB, "the sweep reclaims ~0"; #1749 the 1,500-event budget assumes 0.06 ms/event against a measured **0.479 ms/event** p50 (p90 0.964, max 5.55) over 541 samples and "532 logged slow builds totalling 155 seconds of blocked event loop"; #2534 unbounded usage-event pruning blocked the loop **371 s** (319 MB db, 85,076 events); #1660 host process at **77 GB RSS** froze the machine with 88 orphaned dev processes in deleted worktrees, in-flight turns dying, recovered by `bb thread fork --workspace reuse`; #1303 opening a thread fires ~19 API requests.

### (l) Workflows, automations, notifications

- `plugins/workflows` (opt-in, off by default): an orchestration script in a **QuickJS** sandbox with no fs, shell, network, clock or randomness; `agent(...)` fans out to hidden bb threads, optionally with a JSON-Schema-constrained result. **Durability is the interesting part:** runs and *ordered* agent calls persist in the plugin's SQLite, and on restart the script re-evaluates from the top while successful calls are **replayed by a SHA-256 key until the first divergence** (longest-unchanged prefix), parallel calls carrying deterministic invocation-order identities; the first edited/new/failed/null call and its whole suffix re-run live. Settings cap active runs, agent concurrency, call budget, run timeout and retention. **[measured]**
- `plugins/automations`: cron-or-one-shot, agent mode (new thread, re-prompt, or a new worktree per run) or script mode (bash/node/python on the server machine). Guardrail: threads an automation starts cannot create automations. **[measured]**
- Notifications are a plugin: Expo push, web `Notification`, desktop; per-channel switches for "asks a question / finishes a turn / stops on an error", suppressed for read/archived/hidden threads. No Telegram anywhere. **[measured]**

### (m) UI stack and thread widgets

| layer | bb |
|---|---|
| Framework | React `^19.0.0` + react-dom 19, Vite `^8.0.12`, `babel-plugin-react-compiler ^1.0.0` on |
| Router | `react-router-dom ^7.1.0`; no Next.js |
| State | `jotai ^2.19.0` + `jotai-family ^1.0.1`, `@tanstack/react-query ^5.62.0`; no zustand, no redux |
| Transport | `partysocket ^1.1.16`, `zod` pinned `4.3.6` by a root override |
| Styling | Tailwind **v4** (`^4.3.0` + `@tailwindcss/vite`), `tw-animate-css`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lightningcss` |
| Primitives | shadcn-style local kit over ~30 `@radix-ui/react-*`, each re-exported as a subpath of `packages/shared-ui` |
| Icons | `lucide-react ^1.23.0` **and** `@hugeicons/react ^1.1.6` + `@hugeicons/core-free-icons ^4.1.3` |
| Markdown | `react-markdown ^10.1.0`, remark-gfm/breaks/math/directive, rehype-raw/sanitize/katex, `mermaid ^11.15.0`, `remend 1.3.1` |
| Highlighting | `sugar-high ^2.0.1`; no shiki, no prism, no highlight.js |
| Diffs | `@pierre/diffs ^1.2.9` (patched) + `@pierre/trees ^1.0.0-beta.3` |
| Terminal | `@xterm/xterm 6.1.0-beta.292` + fit / webgl / web-links / unicode11, `ansi-to-html` |
| Composer | TipTap 3 (`^3.26.0`); `monaco-editor ^0.56.0` only inside the optional `plugins/monaco-editor`; no CodeMirror |
| Virtualisation | `@tanstack/react-virtual ^3.14.2` |
| Forms | `react-hook-form ^7.80.0` + `@hookform/resolvers ^5.4.0` + zod |
| Misc | `sonner`, `cmdk`, `@dnd-kit/core`, `react-resizable-panels`, `recharts`, `date-fns`, `react-day-picker`, `vaul`; stories are Ladle, not Storybook |
| Desktop | `electron 41.7.0`, `electron-builder ^26.15.7`, `electron-updater ^6.8.3` |

- Versions read from `get-bb/bb:apps/app/package.json` and `get-bb/bb:apps/desktop/package.json` at root SHA `4749527`; pnpm 9.15.0, node >=22.19. **[measured]**
- The thread UI is **hand-rolled**: no `assistant-ui`, no `ai-elements`, no Vercel `ai` SDK, no `streamdown`, no shiki, no Monaco in the thread, no framer-motion (CSS animation only, `shared-ui/src/components/ui/motion.ts`) — Radix + Tailwind over a first-party projection library `get-bb/bb:packages/thread-view`, whose entire dependency list is `@bb/domain`, `@bb/server-contract` and `zod`, with no React. **[measured]**
- Rows are a zod union in `get-bb/bb:packages/server-contract/src/thread-timeline.ts`: `TimelineRow = TimelineSourceRow | TimelineTurnRow`, source rows `conversation | work | system`. **[measured]**
- 15 work kinds: `command | tool | file-change | web-search | web-fetch | image-generation | image-view | file-read | search | plan-steps | extension | approval | question | delegation | workflow`; 10 system ops from `generic` and `reasoning` to `compaction`, `context-clear` and `provider-unhandled`; `get-bb/bb:packages/thread-view/src/timeline-view.ts` adds the view rows `step-summary` and `bundle-summary`. **[measured]**
- Dispatch is a **switch, not a registry**, twice — `row.kind` at `get-bb/bb:apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx:1153`, then `row.workKind` at `.../timeline/TimelineRowDetails.tsx:234` — both ending in `assertNever(row)`; `delegation` recurses into child rows, and six kinds render `null` as header-only. **[measured]**
- A plugin may replace a row's body and only its body: `.../timeline/PluginTimelineRendererBody.tsx`. **[measured]**

Top widgets under `get-bb/bb:apps/app/src/components/thread/`, all **[measured]**:

- `timeline/ThreadTimelineRows.tsx` — 2,291 lines, the row renderer, memoised rows, Radix `useComposedRefs`.
- `timeline/TimelineWindowedItems.tsx` — `useVirtualizer`, overscan 8, windowing only above 20 items, 2,000-entry LRU height cache.
- `timeline/ConversationMessageContent.tsx` — 730 lines; bubbles via `MarkdownPreview`, a streaming-markdown split plus `remend` repair, mentions, attachments, `MessageActionBar`.
- `timeline/TimelineReasoningDetail.tsx` / `TimelineReasoningExpansion.tsx` — thinking blocks.
- `timeline/TimelineFileDiffBlock.tsx` — `parsePatchFiles` from `@pierre/diffs` → `components/git-diff/GitDiffCard.tsx`, lazy-mounted.
- `timeline/ThreadContextWindowIndicator.tsx` — hand-drawn SVG donut (`2*PI*r` dashoffset) in a Radix popover; no chart library.
- `pending-interactions/ThreadPendingInteractionBanner.tsx` — the approval prompt: `MarkdownPreview`, `UserQuestionAnswerForm`, a plugin composer slot.
- `terminal/ThreadTerminalView.tsx` — xterm 6 beta, fit addon, Radix context menu.
- `../promptbox/PromptBoxInternal.tsx` — TipTap `useEditor`, mention pills, attachments, voice recording, and a banner stack of todo / goal / workflow / queued-messages / model-fallback cards.

- Desktop shell `get-bb/bb:apps/desktop` (v0.42.1, mac + linux only): Electron 41.7.0, packaged by electron-builder, updated by electron-updater (`src/desktop-auto-update.ts`), native menus in `src/menu.ts`, `safeStorage` credentials, and an embedded BrowserView browser driven over CDP (`desktop-browser-*.ts`). **[measured]**
- Not found in that shell: no tray, no `setAsDefaultProtocolClient` / `open-url` deep links, no desktop notifications — web `Notification` lives in the app and push is a plugin. **[asserted]** — code search returned zero, no file-by-file read.
- Against brigadier: bb owns a 2,291-line hand-rolled switch and carries no chat-kit dependency at all; brigadier's current bet runs the other way, migrating conversations onto assistant-ui Elements (`assistant-ui-conversation-migration-2026-09-09.md` plus three sibling plans, all uncommitted at `c4d9d29`). **[measured]** **Superseded 2026-09-09**: that bet was abandoned and all five uncommitted assistant-ui plan docs were deleted at `036a219`; see `docs/plans/bb-thread-port-2026-09-09.md` decision 2.
- That is a contrast, not a recommendation: neither approach was measured against the other, and nothing here says which is right for a harness whose row kinds are the harness's own.

## 4. Pillar table

| brigadier vision pillar | bb | evidence |
|---|---|---|
| A lead that never accumulates | **no** | no manager role, no plan object; a parent is an ordinary accumulating thread (`packages/domain/src/thread.ts:391-411`) **[measured]** |
| Usage windows, never dollars | **partial** | windows exist (`usage-schema.ts`), but the same schema carries `cost{usedUsdCents,limitUsdCents}` **[measured]** |
| ~80% reserve for the human | **no** | hard-coded display tones 80/95; pool switches at **98%** to keep bb running **[measured]** |
| Fusion for judgement | **no** | no judge, critic or second-opinion path found **[asserted]**, grep-level |
| Exit-code red gate, two worktrees race | **no** | workflows retries and caches steps; no gate, no race **[measured]** |
| Worktree per work order, disjoint paths | **partial** | per-thread worktrees, but two threads share one by design and nothing partitions files **[measured]** |
| Approvals never optimistic | **unknown** | pending-interaction banner + persisted interactions exist; the optimistic question was not examined **[asserted]** |
| Approval parks one order, not the run | **partial** | each thread blocks alone, but there is no run to park **[asserted]** |
| No codebase index, ~1,500-token git brief | **yes-ish** | no index; instead a 3,900-char memory catalog injected per turn **[measured]** |
| Local only, no accounts | **no** | hosts, tunnels, getbb.app accounts, mobile push **[measured]** |
| Claude Code only v1 | **no** | Claude, Codex, Cursor, Pi, ACP today **[measured]** |
| Harness-derived one-line status | **no** | status is a thread lifecycle enum; the narrative is model prose **[measured]** |
| Commit per phase, merge back | **no** | commit is a manual button; no merge, no `pr create` **[measured/asserted]** |
| Direct children beat fan-out | **agrees in practice** | children are real threads with their own processes, not in-session subagents **[measured]** |

## 5. What brigadier does better today — only what runs

- **Direct stdio, no SDK and no Node.** `crates/core/src/claude/process.rs:118-160` builds the argv itself;
  bb carries `@anthropic-ai/claude-agent-sdk` and a 199 MB bundled binary. One fewer vendor between the
  harness and the protocol.
- **`--permission-mode` pinned last, `--strict-mcp-config` by default.** A user's `defaultMode:
  bypassPermissions` cannot silence approvals; bb's equivalent is a UI-only per-machine ceiling.
- **Approvals resolve only on the echo.** `App.tsx:769-774` changes nothing locally; the card clears on
  `request-resolved` (`feedStore.ts:270-271`), and a resolved row with `decision_json = NULL` is an explicit
  third state, `Expired`. bb's optimism here is unexamined, but bb has no equivalent of that third state.
- **A real disposable-window loop exists in code and has run.** `crates/supervisor/src/loop_/` — plan,
  dispatch, green, ladder, barrier, state, routing, verify, action — with disjoint path ownership validated
  in `action.rs`. bb has no such object at all.
- **A merge-and-commit gate exists.** `loop_/green.rs` merges, runs the gate and commits; bb never merges.
- **Filter-driver neutralisation around every worktree call** (`5d71793`, `docs/research/gitattributes.md`) —
  a cross-session RCE class bb has not been shown to consider.
- **One IPC channel, rAF-drained, fixed 2,000-row rings** (`src-tauri/src/sink.rs`, `src/feedStore.ts`)
  against bb's WebSocket-notify plus HTTP-refetch and 19 requests per thread open.
- **Tauri 8.6 MiB / 172 MB RAM vs Electron 244 MiB / 409 MB** (`docs/research/substrate.md`) against bb's
  Electron shell and a user-reported 77 GB RSS host.
- Not better, honestly: bb ships installers on three platforms, drives four providers, and has 5,521 commits
  to brigadier's 110.

## 6. What brigadier should borrow — prioritised

1. **Poll the OAuth usage endpoint (accept, M).** bb reads `https://api.anthropic.com/api/oauth/usage` with the
   user's own token from the keychain or `~/.claude/.credentials.json`, `anthropic-beta: oauth-2025-04-20`, 15 s
   timeout. Vision §6 records the constraint that exactly one `rate_limit_event` fires per session at 804–984 ms
   and reports utilization *before* that session's spend — a poll removes that constraint entirely and gives a
   reading while parked, which a per-dispatch gate needs and cannot otherwise get. Lands in a new
   `crates/core/src/usage.rs` poller plus the gauge in `src/components/` and the sidebar footer.
2. **Stop dropping `rate_limit_event` (accept, S).** `crates/core/src/claude/adapter.rs:587` passes it through;
   `crates/claude-wire/src/message.rs:876` leaves the payload `Option<Value>`. Type `unifiedWindows`, store it,
   emit it. This is the free half of item 1 and it is a one-file change plus a store column.
3. **Report-back contract in the work-order prompt (accept, S).** bb's seed prompt names the exact command the
   agent must run to report (`plugins/tasks/delegate/index.ts:118`). brigadier's dispatch already asks for
   reports; make the contract literal — the deliverable, the verify command, and the one call that closes the
   order — in `crates/supervisor/src/loop_/dispatch.rs`. Cheapest quality win on this list.
4. **Hash-keyed step replay (accept, M/L).** bb's workflows plugin persists ordered agent calls and replays them
   by SHA-256 key until the first divergence, giving parallel calls deterministic invocation-order identities.
   brigadier's loop is a plan of phases and work orders — a far better fit than a JS script — and this makes an
   interrupted overnight run resumable without re-spending. Lands in `crates/supervisor/src/loop_/state.rs` plus
   a `work_orders` key column in `crates/store`. Key on the order's content and the phase's inputs, never mtime
   (vision §7 landmine).
5. **Retry policy numbers and durable attempt counts (accept, M).** Take 5 attempts, 15 s reset buffer, 30 s
   jitter, 5 s doubling overload base, 6 h maximum wait, never retry a spend limit, and **the attempt number on
   the durable row so the cap survives a restart**. The jitter matters for the same reason it does for bb: every
   parked order hears about the same reset. Lands beside `loop_/ladder.rs`, whose rung 1 is already "fresh worker,
   same order, told what failed".
6. **Child-outcome notification batching (accept, S).** 2,000 ms batch window, 4,000-char terminal-output excerpt,
   one rendered system message per batch. brigadier's `src-tauri/src/peers.rs` / `peer_sessions.rs` deliver an
   inbox per peer; batching bounds the wake-up tax that vision §6 measured as **82,190 tokens for three wake-up
   messages, more than one whole direct child**. This is the single most directly transferable mechanism bb has.
7. **Execution presets (accept, M).** bb's `presets` row bundles provider, model, reasoning, permission mode,
   instructions, environment kind and base branch. brigadier already picks all of these separately in
   `src/components/NewSession.tsx` + `Pickers.tsx`, and `loop_/routing.rs` already routes by role. Store a named
   profile per role (judgement / work order / lookup) so routing is data, not code, and so the owner can see the
   one visible tier vision §6 promises. Do **not** copy bb's per-task preset UI; brigadier's unit is the work order.
8. **Teardown process kill by cwd (accept, S).** Before `git worktree remove`, SIGTERM/SIGKILL every process whose
   cwd is inside the worktree. `crates/proc` already sweeps orphaned process groups at startup, which is the wrong
   end of the problem: bb #1660 counted **88 orphaned dev processes** in deleted worktrees. Lands in
   `crates/core/src/worktree.rs` next to the existing `--force` landmine.
9. **`workspace_busy` admission mutex (accept, S).** One named error when a second actor wants a path another is
   using, plus a refusal when the tree is dirty, mid-merge, detached or unborn. STATUS already records a peer
   worktree fix that used committed HEAD to dodge a parent checkout lock — that is the same bug class, patched
   once. Lands in `crates/supervisor/src/worktree.rs`.
10. **Context donut thresholds 75/90 (accept, S, narrow).** brigadier already has a per-session context meter
    (`SessionContext.tsx`, polled 8 s busy / 30 s idle); take the two tones and nothing else. Note what it is for:
    the chat half of the product. In the loop, a window at 75% means a work order was sized wrong, and the honest
    response is a decomposition warning, not a compaction.
11. **`EnvironmentReadCache` + forked debounced watcher (reject the cache, accept the debounce, S).** Vision §9 is
    explicit that this data layer is fast enough that caching is a liability — the tail query is 0.145 ms at
    10,000 rows and 0.142 ms at 1,000,000. A 3 s TTL on git status buys nothing here and adds a stale-copy bug on
    every branch switch. What is worth taking is the *shape* around it: debounce 75 ms / max wait 500 ms and a
    fingerprint that suppresses no-op invalidations, if and when a watcher replaces today's 8 s poll. Not measured
    for brigadier; do not build it before measuring the poll.
12. **`thread fork` as handoff (reject as a product feature).** brigadier already has the mechanism
    (`--resume` + `--fork-session`, `crates/supervisor/src/worktree.rs`, `fork.rs`), and vision §9 rules out
    forking in v1 because it multiplies exactly the session clutter the owner prunes. bb forks *because* it has no
    other handoff — its own users reach for `bb thread fork --workspace reuse` to recover from a crash. A harness
    that owns the plan does not need a conversation clone.
13. **A `brigadier` CLI as the agent-facing surface (reject the whole; take one idea).** bb's entire delegation
    story is "the CLI from the shell tool", which buys provider-independence and progressive disclosure through a
    skill file. brigadier already has the better version: an app-owned stdio MCP server with nine typed tools
    (`src-tauri/src/peer_mcp.rs`), no second binary on `PATH`, no install step, no shell quoting. The one thing bb
    has that brigadier does not is **the doctrine written down where the agent reads it** — and even bb's is thin
    (§3c). Write brigadier's delegation doctrine as an injected skill; skip the CLI.
14. **Account pool (reject).** See §7.

## 7. Where brigadier should NOT follow bb

- **The accumulating parent thread.** bb's manager is an ordinary LLM conversation that grows with every child
  outcome injected into it. That is the exact failure `docs/vision.md` §1-2 exists to remove, and the wake-up tax
  is measured: 133,858 coordinator tokens, 50.1% of a fan-out arm's whole bill.
- **98% pool switching.** Settled: the reserve near 80% is headroom for the human's own Claude Code, not a cost
  control. bb's threshold optimises the opposite objective, and multi-account pooling is an accounts feature in a
  product that has no accounts (vision §11).
- **Dollars in the usage schema.** `usage-schema.ts` carries `cost{usedUsdCents,limitUsdCents}`; a subscription
  user is never billed per token. Settled, vision §6.
- **Telemetry on by default.** Local projects, local CLIs, no phone-home. Settled, vision §11.
- **Electron plus synchronous SQLite on the event loop.** Their four worst open issues are all the same shape
  (#1131 11.2 s freeze on a 1.7 GB db, #1749 0.479 ms/event, #2534 371 s prune, #1660 77 GB RSS). The cheap lesson
  is not "avoid Electron" — that was settled for other reasons — it is **decide retention before the table grows**;
  see §9.
- **Shared worktrees with no partition.** bb explicitly supports two threads in one worktree with nothing
  separating their writes. brigadier's disjoint path ownership per work order (`loop_/action.rs`) is the whole
  reason parallel workers are safe; do not add a "reuse this environment" flag that defeats it.
- **No merge and no PR creation.** bb stops at a branch and a `gh pr merge` shell-out. brigadier's `loop_/green.rs`
  merging behind an exit code is the differentiator; keep it.
- **A thin delegation doctrine.** "One clear owner per task, do not poll with shell sleeps" is the whole of bb's
  guidance. Slice sizing, worktree-per-child, review, and merge are the product.
- **Tasks/projects as a second data model.** bb ships a full issue tracker whose delegate path does not even set
  `parentThreadId`. brigadier has one plan object with phases and work orders; a second hierarchy would be the same
  split it already has between the loop and peers (§8).

## 8. Extremely long sessions

**What bb does when a context fills: nothing automatic.** The donut turns orange at 75% and red at 90% and fires
nothing (`ThreadContextWindowIndicator.tsx:42-47`); compaction happens only when the provider decides or a human
types `/compact`; the handoff is a fork that inherits the whole conversation; an idle process is reaped at 30
minutes and resumed from Claude Code's own session file; a crash mid-turn is a `failed` turn and a manual retry.
**[measured]** So bb's answer to a very long run is the provider's answer plus a meter.

brigadier's claim is stronger and therefore owes evidence: cost per step flat at step 400 as at step 4. That number
has never been produced. The gaps, with the remedy on the line:

- **The usage gauge does not exist.** `rate_limit_event` is dropped in a pass-through arm at
  `crates/core/src/claude/adapter.rs:587`, its payload is deliberately untyped at
  `crates/claude-wire/src/message.rs:876`, and `unifiedWindows` appears nowhere outside
  `crates/claude-spike/src/bin/fanout.rs:311` and fixtures — remedy: type it, store it, emit it, and add the poll
  (§6 items 1-2); until then the vision's one number is absent from the product.
- **The reserve does not exist.** No storage, no 80% line, no per-dispatch gate; `src/components/Composer.tsx:692-701`
  says so in a comment and shows raw token counts instead — remedy: gate `loop_/dispatch.rs` on the stored window
  before every spawn, which is the only place vision §6 says the check belongs.
- **The loop has run once, from a test.** `crates/supervisor/tests/live_loop.rs`, n=1, $0.192433, 106 s, on a
  tempdir throwaway repo, never end-to-end through the UI — remedy: drive one real phase on this repo through the
  window and record the numbers, then repeat it long enough to plot cost per step.
- **The loop is invisible.** `RunCard` is mounted inside a collapsed `<Details>Automation history</Details>` at
  `src/App.tsx:1041-1052`, shown only when no session is selected — remedy: §10.
- **Two orchestration stories, unreconciled.** The loop's work orders (`crates/supervisor/src/loop_/`) and the
  peer-MCP session delegation (`src-tauri/src/peers.rs`, `peer_sessions.rs`, `peer_mcp.rs`, 2026-09-08) both exist,
  both run, and neither knows about the other — remedy: make peers the *transport* the loop dispatches over, or
  demote peers to a chat-only affordance and say so in STATUS; a product cannot ship two answers to "who is the lead".
- **No run survives a restart.** Unverified either way — `loop_/state.rs` exists and was not read this pass —
  remedy: check it, and if the answer is no, item 4 of §6 is the fix.
- **Retention is unwritten.** 66 MB of our own NDJSON and **3.0 GB of provider transcripts** on this machine, and
  `--resume` reads the latter so they cannot be auto-deleted — remedy: write the policy now, while the numbers are
  small, because bb #1131 is what it looks like when you do not.

## 9. Performance

- bb's timeline: 1,500-event build budget against a measured **0.479 ms/event** p50 on a 4-core host, i.e. a budget
  set at 8x optimism, and 532 slow builds totalling 155 s of blocked event loop (#1749). **[asserted]**
- brigadier's substrate: **1.47M msg/s** parsing one NDJSON child, **2.68M msg/s** across ten
  (`docs/research/substrate.md`), one `Channel<FeedBatch>` with rAF drain and fixed 2,000-row rings, approval park →
  sink 3.2–14.9 ms against a 100 ms gate, store read p50 2.30–2.89 ms under a 1,500 rows/s flood. **[measured]**
  Parsing is not brigadier's problem and will not become one.
- brigadier's real gaps, all from STATUS §4: **B1 exec → first contentful paint 287–295 ms p50 (n=19) against a
  ≤200 ms budget, blank for all of it**; 60 Hz held in 62/62 windows but the run **failed its own dropped-vsync gate
  1 of 62**, with the drops attributed to ingest rather than scroll; B6 and B7 are still guesses with no call site;
  **every burn number is a debug build**. **[measured]**
- Concrete, in order: (1) run a release burn — `VITE_BURN=1` now makes it reachable and no release burn exists, so
  the one honest FPS claim is still an upper bound on badness; (2) paint a static shell in `index.html`, since both
  alternatives are closed doors (a splash is a second WKWebView, and `visible: false` hits tauri #15652); (3) add
  the B6/B7 call sites so the two guesses become numbers; (4) write the store retention and output-truncation policy
  before `feed`/`chat_items` grow — bb's `events` table reached 1,447 MB with 815 MB in one aggregated-output field
  and a truncation threshold so high the sweep reclaimed nothing; brigadier's 8,000-byte envelope cap protects the
  wire, not the table.
- Not compared: bb has no published Electron RSS figure, and brigadier has no release-build number, so the
  substrate memory comparison (8.6 MiB / 172 MB vs 244 MiB / 409 MB) is the only side-by-side that exists and it is
  a synthetic harness, not either app.

## 10. A more intuitive flow

bb today: sidebar of projects → sections → thread rows with children under a disclosure chevron
(`SidebarChildToggleChevron.tsx`, `ProjectThreadTree`); attention surfaces as a pending-interaction banner, a
`hasPendingInteraction` flag on the list row, and a favicon dot; the right panel shows the environment's git diff;
a Commit button writes an LLM-drafted message; merging is a PR action elsewhere. **[measured/asserted]** — layout
claims are from filenames plus greps, not a running app.

brigadier today (04 §8): a cinematic launch with a 10 s audio track → sidebar of projects with nested sessions →
dock with model/permission/effort/worktree pickers → `ThreadView` with compact work blocks → inline approval cards
→ an optional IDE workspace. The loop is a collapsed "Automation history" panel visible only when nothing is
selected. A stranger reads the product as a polished multi-session chat client with an IDE bolted on.

Minimal change, in steps, smallest first — no new subsystem, and the plan card is already specified in vision §9:

1. **Promote the run.** Move `RunCard` out of `<Details>Automation history</Details>` (`src/App.tsx:1041-1052`) and
   pin it above the thread as the plan card: phases, done count, current phase, collapsible to one line.
2. **Make dispatch visible as children.** Render a work order's child under its phase in the same tree the sidebar
   already uses for sessions — bb's chevron disclosure, one level, no new concept. This is also where the two
   orchestration stories reconcile: peer sessions and work-order children draw as the same row type or one of them
   is not a first-class thing.
3. **One attention flag per row.** A dot on the session row and the collapsed project row when an approval is
   pending, matching bb's `hasPendingInteraction`; brigadier's approvals dock already holds the state.
4. **Pin the gauge.** Two bars, two countdowns, the reserve line drawn on them, bottom of the sidebar under
   everything (vision §9), once §6 items 1-2 land. This is the change that makes the product legible as "a lead
   that never accumulates" rather than a chat client.
5. **Demote the intro.** A 10 s ambient audio track sits between exec and the one screen whose budget is 200 ms.
   Owner call, not a research finding — but it is the first thing a stranger meets and it argues against every
   number in §9.
6. Keep the commit button (`src/components/SourceControl.tsx`) and the merge gate. bb has neither end of that, and
   it is brigadier's clearest lead.

## 11. Not verified

- **Nobody ran bb.** No build, no install, no observed behaviour; every bb claim is source, shipped docs, or a
  user's issue report.
- `get-bb/bb:plugins/provider-claude-code/src/bridge/bridge.ts` (86 KB) not read; whether one `query()` serves a
  thread or a turn is inferred from `sdk-session.ts` plus a recording.
- `apps/server` not read in full; `turn-retry.ts` (256 lines) and `plugins/memory/server.ts` (1,182 lines) skimmed.
- `packages/db/src/schema.ts` threads columns not re-read this pass; `parentThreadId:533` / `threads_parent_idx:569`
  are secondhand.
- `applyThreadLifecycleEvent`'s body not read — only its transition table and callers. `thread-lifecycle.ts`
  (1,890 lines) read by exported names only, so how a steer interrupts an in-flight turn is inferred from CLI docs.
- No bb UI file read end to end except `SidebarChildToggleChevron.tsx`; §3's sidebar/attention/diff description and
  §10's bb half are inferred from filenames and greps.
- `bb thread wait|list|spawn` implementations read via the generated `bb guide threads` template, not the source.
- No `gh pr create` found, but the code search was rate-limited mid-sweep, so "the agent creates the PR" is inferred.
- `thread-environment-placement.ts` (626 lines) grepped only; machine fallback rules unknown. `worktree-include.ts`,
  `environment-hooks.ts`, `apps/connect` internals and mobile pairing crypto not read.
- Whether bb's WebSocket ever carries message content: only `useWebSocket.ts` was read, not `lib/ws.ts` or the hub.
- Whether `provider/rateLimits/updated` and the polled `/api/oauth/usage` snapshot feed the same card: unchecked.
- Whether `bb thread fork` copies the Claude Code session file or asks the CLI to fork it: unchecked.
- Codex/Cursor/Pi model listing unchecked; only the Claude bridge was read.
- No Electron RSS figure for bb exists in their docs; release notes not searched exhaustively.
- bb issue numbers are users' self-hosted measurements, not maintainer benchmarks.
- On the brigadier side: `crates/supervisor/src/loop_/state.rs` was not read, so whether a run survives an app
  restart is unknown; STATUS §3's six gates are green as **claimed** at `submission-diagnostics-2026-09-08.md` and
  were not re-run for this brief; strict clippy was red at `session-coordination-implementation-2026-09-08.md`.
- Tray, deep links and desktop notifications are absent from `get-bb/bb:apps/desktop` per a code search that returned
  zero hits; no file-by-file read was done, so their absence is asserted, not measured.
- No in-thread usage card was located — only `apps/app/src/components/settings/UsageLimitsSettingsSection.tsx` and a
  `plugins/provider-usage` package; a thread-level card may exist in a file not read.
- The absence of `assistant-ui`, `ai-elements` and `streamdown` rests mainly on `apps/app/package.json`: GitHub code
  search rate-limited this pass, so three of the confirming searches were answered from the manifest alone.
