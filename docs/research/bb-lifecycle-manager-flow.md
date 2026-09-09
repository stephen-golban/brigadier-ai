# get-bb/bb — thread lifecycle, manager, user flow

Detailed subagent report, 2026-09-09, feeding `docs/research/bb.md`. Claims are marked as in that file: read in source = measured; everything else asserted. Nobody ran bb.

---
# bb: thread lifecycle, model selection, the manager, and the user flow

All paths are `get-bb/bb@main`. "read in source" = I fetched and read that file.

## 1. Thread lifecycle — read in source

There is **no** `managing` / `running` / `completed` / `failed` / `needs attention` status. The DB
status enum is six values: `pending | idle | starting | active | stopping | error`
(`packages/domain/src/thread-lifecycle.ts`, `.../thread-status.ts`). The state machine is a literal
transition table `THREAD_LIFECYCLE` consumed by a CAS single-writer
`applyThreadLifecycleEvent` in `@bb/db`; events are only
`run.preparing | run.started | run.succeeded | run.failed | stop.requested | stop.settled`, each with
"supersession predicates" (`notArchived`, `notDeleted`) checked inside the writer's transaction. An
absent cell is a logged no-op (`illegal-transition`), not an error. The rendered diagram is
`docs/lifecycle-diagrams.md` (generated). Key edges: `pending -run.preparing-> starting`;
`starting|active -run.succeeded-> idle`, `-run.failed-> error`, `-stop.requested-> stopping`;
`error -run.preparing-> starting` (retry). Comment in the table: *"a pending thread has no session
for a turn to start in, so a turn event arriving here is a bug, not a shortcut."*

The **client** sees a wider derived enum: `ThreadRuntimeDisplayStatus = threadStatusValues +
"provisioning" | "host-reconnecting" | "waiting-for-host"`
(`packages/domain/src/thread.ts:36-47`), computed server-side in
`apps/server/src/services/threads/thread-runtime-display.ts` and pushed as a `status-changed`
notification from `.../threads/lifecycle-outcome.ts`. A comment notes an older derived `held` status
was deleted. So "idle" = a real thread status meaning no turn in flight; a never-run thread is
`pending`. Turn start/end and interrupts live in `.../threads/thread-lifecycle.ts` (1,890 lines):
`requestThreadStart`, `prepareReadyThreadTurnCommand`, `settleTurnSubmitCommandResult`,
`requestThreadStopForCurrentState`, `finalizeStoppedThread`, `interruptActiveThreadsForHost`.
`run.failed` is the *only* path into `error`, and it is what fires the `turn.failed` plugin event.

**"Managing" is not a state.** Parenthood is one nullable column (`parentThreadId`) plus
`ThreadActivityState { activeWorkflowCount, activeBackgroundAgentCount, activeBackgroundCommandCount,
activePlanModeCount, activeGoalCount }` on list rows — counts, not a status. *Inferred*: the sidebar
renders children as a disclosure tree (`SidebarChildToggleChevron.tsx`, `ProjectThreadTree`), and a
parent with live children just looks `idle`.

## 2. Model / provider / mode selection — read in source

Picker fields (`apps/app/src/components/promptbox/NewThreadComposer.tsx`, ~1,630 lines): provider,
model, `reasoningLevel`, `serviceTier`, `permissionMode`, environment selection value, machine
(`EnvironmentMachineSelection`), plus base branch for a new worktree. Same set on the CLI
(`bb thread spawn --provider --model --reasoning-level --service-tier --permission-mode --machine
--new-environment worktree --base-branch`).

Defaults ladder (`.../threads/project-execution-defaults.ts` + `thread-default-policy.ts`): explicit
flags → live parent thread's execution → **remembered per-project defaults** (`ProjectExecutionDefaults`
row: providerId, model, reasoningLevel, permissionMode, serviceTier) → provider-reported default model
on the target machine. Defaults are re-remembered only for app-origin creates on a fresh environment
(`shouldRememberProjectExecutionDefaults` skips `environment.type === "reuse"`). Provider is chosen
once and is **immutable**: *"it is immutable afterwards, because a provider session IS the
conversation and no other provider can continue one it never started."* Product defaults: reasoning
`medium`, permission `auto` (guide text); `bb guide threads` says the fallback provider is **Codex**.

Models are **probed live, not declared in a manifest**:
`plugins/provider-claude-code/src/bridge/model-list.ts` runs `query({prompt:".", maxTurns:0})` against
the Agent SDK and reads `initialization.models`, memoised with a TTL. A static catalog
(`model-catalog-data.ts`) supplies display names/descriptions and per-model default reasoning effort
(`low|medium|high|xhigh|ultracode|max`; `DEFAULT_CLAUDE_CODE_MODEL = "claude-opus-5[1m]"`). Extra
models come from top-level `customModels` in `config.json` (no CLI; edit JSON and restart).
Service tier: `fast | default`.

**Model can change mid-thread**: `bb thread update <id> --model --reasoning-level` sets a *sticky*
model validated against the provider's catalog, applied on the next turn; `bb thread tell --model`
overrides one turn. Provider cannot change.

Machines carry `maxPermissionMode` (default `full`) — a per-machine ceiling settable only in the UI.

## 3. Who is the manager — confirmed, read in source

**Confirmed: no manager role.** `Thread` has no `kind`/`role` field
(`packages/domain/src/thread.ts:391-411`); only `parentThreadId`, `sourceThreadId`, `originKind`,
`visibility`. `docs/system-overview.md` still says threads are "standard or manager" — that doc is
**stale**. Any thread becomes a manager by passing `--parent-self` / `--parent-thread`.

The doctrine lives in `apps/server/src/services/skills/builtin-skills/bb-cli/references/`:
- `thread-operation.md:5-14`: *"Use one clear owner per task. Spawn independent tasks separately when
  parallel work is useful. Let threads work after spawning. Do not poll with shell sleeps, repeated
  log reads, or repeated status reads."*
- `thread-creation.md:160-162`: *"Give spawned threads clear prompts: objective, constraints,
  expected deliverable, validation to perform, and what to report back."*
- Notably **absent**: any guidance on how many children, how to size a slice, worktree-per-child as a
  rule, how to review a child's diff, or how to merge. Worktrees are a flag (`--new-environment
  worktree`), and the only review advice is `bb thread show <id> --git-diff` and *"For review or fix
  pipelines, get the environment ID from `bb thread show --json`, then spawn the follow-up with
  `--environment <id>` so it sees the same files."* Merging is a human/PR action
  (`bb environment pull-request ready|draft|merge`).

Manager command surface: `spawn`, `tell` (`--mode steer|queue|auto`, steer is default and lands
mid-turn), `wait` (default `--status idle`, 1,200 s), `list --parent-thread`, `count --parent <id|none>`,
`show [--git-diff]`, `log`, `output`, `interactions list|show|approve|deny|grant|answer|respond`,
`queue *`, `stop`, `retry`, `archive`, `update --model/--parent-thread/--visibility`, `fork`,
`edit-message`, `terminal *`, `open`/`pane`.

**Injection**: not a system prompt. `apps/server/src/services/skills/injected-skills.ts` resolves
builtin + plugin + project + shared SKILL.md trees; for Claude Code,
`plugins/provider-claude-code/src/bridge/skill-plugins.ts` writes a synthetic **Claude Code plugin**
(`.claude-plugin/plugin.json`, name `bb-global-skills`) in a temp dir with `skills` symlinked to the
root. So the agent gets `bb-cli` as a normal progressive-disclosure skill.

## 4. Child-thread confirmation — read in source (misleading filename)

`apps/server/src/services/threads/child-thread-confirmation.ts` is **44 lines and has nothing to do
with approving spawns**. It is `requireChildThreadsConfirmation({action:"archive"|"delete", confirmed,
thread})`: if the thread has non-deleted children and `confirmed` is false it throws
`409 child_threads_confirmation_required`. **The user never approves a spawn.** Permission inheritance
is in `thread-default-policy.ts`: requested flag → last execution → parent's mode → project default;
then for a *live* parent (`isManagedChildThread` requires the parent to still be live)
`clampPermissionModeToCeiling` makes the parent's mode a hard ceiling. `resolveSupportedPermissionMode`
further clamps to what the provider supports. Modes: `accept-edits`, `auto`, `full` (plan mode separate).

## 5. User flow — read in source (UI files listed, most not read line by line)

Sidebar of projects → sections → thread rows, children under a disclosure chevron; hidden threads
(plugin/workflow workers) excluded unless `--include-hidden`. Attention surfaces as: a pending-interaction
banner in the thread (`components/thread/pending-interactions/ThreadPendingInteractionBanner.tsx`,
`PendingInteractionShell`, `user-questions/UserQuestionInteractionContent.tsx`), `hasPendingInteraction`
on each list row, a favicon dot (`layout/faviconAttentionDot.ts`), and a clock/failure glyph for
`queuedWork: "none"|"waiting"|"failed"`. Diff review is the right-panel `secondary-panel/git-diff/*`
plus `GitDiffCard`; merge is via the environment's pull request. Notifications are a plugin
(`plugins/push-notifications`): Expo mobile push, web `Notification`, and desktop, per-channel switches,
"agent asks a question / finishes a turn / stops on an error", combined when simultaneous, suppressed
for read/archived/hidden threads. **No Telegram anywhere in the tree.** No onboarding flow found —
only `apps/app/src/views/RootComposeEmptyWelcome.tsx`.

Parent-facing signalling (prior report, corroborated): `packages/templates/.../
system-message-child-thread-outcome-batch.md` and `-needs-attention.md`, both injected as `[bb system]`
turns into the parent, the latter reading *"{{threadMention}} needs help. … Review the blocker. If you
can resolve it from existing context, reply to the thread with guidance. Otherwise, ask the user."*

## 6. Automations and workflows — read in source (PLUGIN_OVERVIEW.md + workflows README)

**`plugins/automations`**: cron-or-one-shot scheduler. Two modes — *agent* (start a new thread,
re-prompt an existing one, or make a new worktree per run, with its own provider/model/reasoning/
permission pick) and *script* (stored bash/sh/node/python3 run on the bb **server** machine, recording
stdout/stderr/exit code). Sidebar panel with run history; `bb automation create|list|show|update|pause|
resume|run|runs|delete`. Guardrail: *"Threads that an automation starts cannot create automations."*

**`plugins/workflows`** (opt-in, off by default): a JavaScript orchestration script executed in a
**QuickJS** sandbox with no fs/shell/network/clock/randomness; `agent(...)` calls fan out to ordinary
(hidden) bb threads with normal tools and permissions, optionally with a JSON-Schema-constrained
structured result (`bb_workflow_result`). Durability is the interesting part: runs and *ordered* agent
calls persist in the plugin's own SQLite; on restart the script re-evaluates from the top and
successful calls are **replayed by a SHA-256 key until the first divergence** (longest-unchanged-prefix),
with parallel calls given deterministic invocation-order identities so concurrency doesn't break replay;
the first edited/new/failed/cancelled/null-result call and its whole suffix re-run live. Ajv schema
validation happens in Node with a deliberately restricted keyword subset. UI: a live run card in chat
via a trusted `::workflow-preview{run="wfr_…"}` directive, a composer status card, and a phase/worker
inspector panel linking each worker to its thread. Settings cap active runs, agent concurrency, call
budget, run timeout, and retention.

## Not verified

- `packages/db/src/schema.ts` threads table columns — **not read this pass** (parentThreadId at :533 and
  `threads_parent_idx` at :569 come from the prior report, not re-checked).
- `applyThreadLifecycleEvent` itself (in `@bb/db`) — not read; only its transition table and callers.
- `thread-lifecycle.ts` bodies (1,890 lines) — only the exported function names were read, so exactly how
  a steer interrupts an in-flight turn is **inferred** from CLI docs, not from code.
- No UI file was read end to end except `SidebarChildToggleChevron.tsx`; the sidebar/attention/diff/merge
  description is from filenames plus `NewThreadComposer.tsx` greps → treat §5 layout claims as inferred.
- `bb thread wait`/`list`/`spawn` implementations under `apps/cli/src/commands/thread/` were fetched but
  read only via the generated `bb guide threads` template, which the repo's own tests are said to enforce
  against the CLI.
- Codex/Cursor/Pi model listing not checked (only `provider-claude-code`); there is no `listModels` string
  in the tree, so the plugin-SDK method name is unconfirmed — the Claude bridge exports
  `listClaudeCodeBridgeModels` returning `AvailableModel[]` from `@get-bb/plugin-sdk/provider-bridge`.
- bb never run; nothing here is observed behaviour.
