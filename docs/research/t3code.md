# T3 Code — architecture dissection

https://github.com/pingdotgg/t3code — MIT, 21,305 stars, active (6 nightlies on 2026-09-01).
TypeScript 92.6 MB. pnpm monorepo, Effect-TS spine. ~1,827 non-test source files.
Local clone used for this audit was in the session scratchpad (ephemeral — re-clone if needed).

## Shell
Electron 43.4.1 (`apps/desktop/package.json:26`), electron-builder, Clerk auth.
macOS arm64 dmg **149.8 MB**; Windows exe 170.1 MB.
Four surfaces on one core: `apps/desktop` (138 TS files), `apps/web` (~874), `apps/mobile` (564),
`apps/server` (643). `npx t3@latest` runs server + local web with no install.

Electron main does NOT host the server in-process — it spawns it as a child
(`apps/desktop/src/backend/DesktopBackendManager.ts:443,493`), pooled by `DesktopBackendPool.ts`.
That is why orphaned `t3 serve` processes are a filed bug (#2614).

Native bits: `native/resource-monitor` (Rust + sysinfo, JSON sidecar),
`native/libghostty-vt` (Ghostty's VT parser headers, pinned `9f62873`).

## How it drives the CLIs — the important part
**Never `claude -p`. Never terminal scraping.** Structured protocol per provider, one file per CLI.

| Provider | Mechanism | Call site |
|---|---|---|
| Claude | official `@anthropic-ai/claude-agent-sdk` ^0.3.170, `query({prompt, options})` where prompt is an `AsyncIterable<SDKUserMessage>` (**streaming input**) | `apps/server/src/provider/Layers/ClaudeAdapter.ts:1712` |
| Codex | `codex app-server` + generated client | `codexLaunchArgs.ts:13`, `CodexSessionRuntime.ts:1185-1196`, pkg `packages/effect-codex-app-server/` (code-generated via `@effect/openapi-generator`) |
| Cursor, Grok | **ACP (Agent Client Protocol)** over stdio; Cursor args are literally `["acp"]` | `provider/acp/AcpSessionRuntime.ts:341-366`, `CursorAcpSupport.ts:42`, pkg `packages/effect-acp/` |
| OpenCode | spawn `opencode serve`, wait for stdout "opencode server listening", then HTTP via `@opencode-ai/sdk/v2` | `provider/opencodeRuntime.ts:5-14,80,547-558` |

`node-pty ^1.1.0` exists but ONLY backs the user-facing embedded terminal
(`apps/server/src/terminal/{PtyAdapter,NodePtyAdapter,BunPtyAdapter}.ts`), not agent driving.

Windows gotcha worth stealing: `provider/Drivers/ClaudeExecutable.ts` — the SDK spawns without a
shell and without PATHEXT resolution, so bare `claude` or an npm `.cmd` shim fails `spawn EINVAL`;
they resolve the shim down to `node_modules/@anthropic-ai/claude-code/bin/claude.exe` or `cli.js`.

## Approvals — canUseTool DOES fire
`ClaudeAdapter.ts:4074` registers a `canUseTool` handler → `:4124-4131` mints an `ApprovalRequestId`
and a `Deferred<ProviderApprovalDecision>` → `:4136` emits `request.opened` → `:4166` registers in
`pendingApprovals` → `:4183` `Deferred.await` → `:4187` emits `request.resolved`.
Abort resolves the Deferred with `"cancel"` (`:4172`) with a guard for the already-aborted race.
Answer path: RPC `ThreadApprovalRespondCommand{requestId, decision}`
(`packages/contracts/src/orchestration.ts:949-954`) → `ProviderService.respondToRequest`
(`Layers/ProviderService.ts:865`) → per-adapter `respondToRequest` (Claude:4635, Codex:1932,
Cursor:1086, Grok:1940, OpenCode:3125). Interface at `Services/ProviderAdapter.ts:76-88`.
Teardown fans cancellations to every pending approval (`ClaudeAdapter.ts:3716-3736`).
Pending approvals are persisted (`projection_pending_approvals`) so a reload still shows the prompt.

**This contradicts `docs/measurements.md` M2-M4 in brigadier-ai, which recorded canUseTool never
firing. Re-measure before designing around the hooks callback instead.**

## State
`node:sqlite` (native, NOT better-sqlite3) — `persistence/NodeSqliteClient.ts`; Bun path uses
`@effect/sql-sqlite-bun` (`Layers/Sqlite.ts:19-22`). WAL + `busy_timeout=5000` because CLI and
server write from separate processes. DB at `$T3CODE_HOME/userdata/state.sqlite`. 43 migrations.

**Event-sourced CQRS**: append-only `orchestration_events`
(`Migrations/001_OrchestrationEvents.ts:8-22`, `stream_id`/`stream_version` optimistic concurrency)
is truth; `projection_*` tables rebuilt by replay on boot (`orchestration/Services/ProjectionPipeline.ts`).
Projections: projects, threads (= sessions, nullable `worktree_path`), thread_messages, turns,
pending_approvals, provider_session_runtime.

Raw CLI traffic goes to rotating NDJSON, not the DB — `Layers/EventNdjsonLogger.ts`, three streams
(native/canonical/orchestration), per-thread under `logs/provider/`, 10 MB x 10 files, 512 MB cap,
14-day age; streaming deltas filtered by `shouldPersist` (:191-239).

Worktrees are **opt-in per thread**: `ThreadEnvMode = "local" | "worktree"`
(`packages/contracts/src/environment.ts:27-28`), default `"local"` (`settings.ts:688-689`).
`git worktree add -b <ref> <path> <refName>` at `vcs/GitVcsDriverCore.ts:2830-2835`,
path `$T3CODE_HOME/worktrees/<repo>/<branch>`.
Resume: `provider_session_runtime.resume_cursor_json` holds the provider session id;
`ClaudeAdapter.ts:683` `readClaudeResumeState` feeds `resume: <session_id>` back into the SDK.
No global cap on concurrent sessions found.

## UI
React 19.2.6 + React Compiler, TanStack Router, Tailwind v4. State = `@effect/atom-react` (not
TanStack Query) + zustand for composer drafts.
Transport: **Effect RPC over WebSocket, JSON serialization** —
`packages/client-runtime/src/rpc/session.ts:136-181`. Shared schemas in `packages/contracts/src/rpc.ts`.
Timeline: `apps/web/src/components/chat/MessagesTimeline.tsx` (2,564 lines), virtualized with
`@legendapp/list` (`LegendList`, line 42/626).
Backpressure: local cache writes `Stream.debounce("500 millis")` (`state/threads.ts:206-210`);
server-config fanout is a **sliding** PubSub of 64 (drop-oldest, `session.ts:190`);
`@tanstack/react-pacer` Debouncer in `ChatView.tsx:58`; rAF batching for scroll sync.
Many-session strategy: per-thread `Atom.family` with idle TTL —
`state/threadDetail.ts:76-119` + `threadRetention.ts:3` (`THREAD_STATE_IDLE_TTL_MS = 5 min`);
background threads tear down their streams after 5 idle minutes; the sidebar subscribes to a light
`threadStatusAtomFamily`, not message state.
Sidebar `apps/web/src/components/Sidebar.tsx` is **4,011 lines**; `ChatView.tsx` is **7,593 lines**.
Those file sizes are a warning, not a model.

## The abstraction worth stealing
`apps/server/src/provider/ProviderDriver.ts` — a plain-value driver SPI, deliberately NOT an Effect
service, because tags are singleton-per-runtime and they need N instances of one driver (two Claude
accounts at once).

    ProviderDriver<Config, R> = { driverKind, metadata{displayName, supportsMultipleInstances},
      configSchema, defaultConfig(), create(input) -> Effect<ProviderInstance, …, R|Scope> }
    ProviderInstance = { instanceId, driverKind, continuationIdentity, snapshot, adapter, textGeneration }

Registry decodes the opaque config envelope once (`Layers/ProviderRegistry.ts`) and owns
`Map<InstanceId, ProviderInstance>` (`Layers/ProviderInstanceRegistryLive.ts`).
Per-CLI code splits: thin `Drivers/*Driver.ts` (lifecycle, binary resolution) + fat
`Layers/*Adapter.ts` (protocol -> canonical events). ClaudeAdapter 4,735 lines, OpenCode 3,285,
Grok 2,046, Codex 2,037, Cursor 1,193.

Model picker: `ModelManifest.ts` ships a bundled `model-manifest.json` but **refetches it at runtime
from raw.githubusercontent.com on main** (1 h TTL, 5 min retry backoff, 10 s timeout, failure never
fails a provider check) — a new model ships with a commit, not a release.
Options are declarative: `packages/contracts/src/model.ts` defines `SelectProviderOptionDescriptor`
/ `BooleanProviderOptionDescriptor`, so each CLI advertises its own settings and the UI renders
them generically.

## Where it hurts — the opening
- **#5110** per-chunk assistant persistence: progressive live-output lag; `state.sqlite` measured
  282 KB -> 218 MB (~773x) in 25 h, and deleting threads does not purge events.
- **#8648** desktop backend SIGABRT / V8 OOM after 9-18 h. **#7075** Codex resume exhausts heap on
  large histories. **#5248** systemd-oomd kills the whole scope on Linux.
- **#4596** reopening a thread with a large event backlog freezes the UI; replay called quadratic.
- **#8118** controls unresponsive in long-running threads. **#2644** threads stuck "working..."
  indefinitely (15 comments). **#4713** stop is a no-op on a stuck thread.
- **#2343** "[Critical] T3Code forgets complete session history".
- **#4650** context meter ratchets up, never reflects `/compact` (a `Math.max` bug).
- **#5681** Codex subagent progress floods ingestion and delays UNRELATED threads — cross-session
  isolation is imperfect.
- **#695** (20 comments) "significantly slower than Codex for the same task", 20+ min vs 3m24s.
- **#2614** orphaned `t3 serve` processes. **#7475** node-pty native build silently skipped.

Two structural causes behind most of that: **an unbounded append-only event log with no retention or
compaction**, and **per-chunk writes on the hot streaming path**. Both are cheap to avoid if you
decide up front what you will not keep.

## The gap
**There is no adversarial-review feature.** `apps/server/src/review/ReviewService.ts` is 141 lines of
git-diff review; grep for adversarial/critic/second-opinion across server, web and packages returns
nothing. Whatever you build there has no prior art in this repo.

## Not checked
No benchmark, no build, no run. Did not read `apps/mobile`, `infra/relay`, or the Tailscale/SSH
remote-access packages. Whether raw token deltas are coalesced before hitting React state:
unverified. Concurrent-session cap: none found, but grep-level only.
