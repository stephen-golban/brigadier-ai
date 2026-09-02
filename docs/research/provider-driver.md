# t3code provider adapter SPI — prior art for our driver/adapter split

Extends `docs/research/t3code.md`; does not repeat it. Scope: the provider SPI only.
Source: github.com/pingdotgg/t3code, commit **`692eb1a5792b9930959b19805acf2bf2611318c9`** (main, read 2026-09-02).
All `file:line` are relative to that repo at that SHA. Line numbers in the earlier `t3code.md` are from an
older SHA and have drifted by ~20 lines in `ClaudeAdapter.ts`.

Path aliases used below: `PD` = `apps/server/src/provider/ProviderDriver.ts`, `PA` =
`apps/server/src/provider/Services/ProviderAdapter.ts`, `CA` =
`apps/server/src/provider/Layers/ClaudeAdapter.ts`, `CX` =
`apps/server/src/provider/Layers/CodexAdapter.ts`, `PR` = `packages/contracts/src/providerRuntime.ts`.

---

## 1. `ProviderDriver.ts` — the interface, verbatim

169 lines total (`PD:1-169`). Reproduced in full minus imports:

```ts
export interface ProviderDriverMetadata {
  /** Human-readable name for the driver itself (e.g. "Codex"). */
  readonly displayName: string;
  /**
   * Whether the driver may be instantiated more than once concurrently.
   * Defaults to `true`. Set to `false` for drivers that wrap a global
   * resource (e.g. a single desktop app socket) — the registry then
   * rejects multi-instance configurations with a clear error.
   */
  readonly supportsMultipleInstances?: boolean;
}

/**
 * One materialized provider instance. Held by the registry, looked up by
 * `instanceId`, torn down by closing the scope it was created in.
 *
 * The three "shape" fields are captured closures owned by this instance —
 * stopping one instance cannot affect another, and starting a second
 * instance of the same driver does not reach into the first instance's
 * state.
 */
export interface ProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly snapshot: ServerProviderShape;
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly textGeneration: TextGeneration.TextGeneration["Service"];
}

export interface ProviderContinuationIdentity {
  readonly driverKind: ProviderDriverKind;
  readonly continuationKey: string;
}

export function defaultProviderContinuationIdentity(input: {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
}): ProviderContinuationIdentity {
  return {
    driverKind: input.driverKind,
    continuationKey: `${input.driverKind}:instance:${input.instanceId}`,
  };
}

/**
 * Inputs the registry passes to a driver's `create` function.
 *
 * `config` is the typed payload — already decoded by the registry through
 * `driver.configSchema`. Drivers never decode their own raw envelope.
 */
export interface ProviderDriverCreateInput<Config> {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly environment: ProviderInstanceEnvironment;
  readonly enabled: boolean;
  readonly config: Config;
}

/**
 * Driver SPI — registered as a plain value, not a Layer.
 *
 * `Config` is whatever the driver decoded from
 * `ProviderInstanceConfig.config`. `R` is the union of infrastructure
 * services the driver depends on; the registry layer aggregates `R` across
 * all registered drivers and the runtime supplies them.
 *
 * `create` is responsible for *all* per-instance state — process handles,
 * pubsub topics, refs, file watchers — and must release them when its
 * scope closes. Two calls to `create` with different `instanceId` /
 * `config` MUST yield instances with no shared mutable state.
 */
export interface ProviderDriver<Config, R = never> {
  readonly driverKind: ProviderDriverKind;
  readonly metadata: ProviderDriverMetadata;
  /**
   * Decoder for the opaque `ProviderInstanceConfig.config` envelope. The
   * registry runs this exactly once per (re)load of an instance; a decode
   * failure is surfaced as `ProviderDriverError` and downgraded to an
   * unavailable shadow snapshot.
   *
   * The `Encoded` parameter is intentionally left as `unknown` (not
   * `Config`) so schemas with `withDecodingDefault` / transformations — where
   * the encoded shape differs from the decoded shape — satisfy the SPI
   * without casts. The registry only ever decodes `unknown` envelopes here,
   * so the precise encoded type is irrelevant at this boundary.
   *
   * Using `Codec` rather than `Schema` pins `DecodingServices = never` — if
   * we used `Schema<Config>`, the erased `any` in `AnyProviderDriver` would
   * widen `DecodingServices` to `unknown` and poison the R channel of every
   * caller of `decodeUnknownEffect`.
   */
  readonly configSchema: Schema.Codec<Config, unknown>;
  /**
   * Default config payload used when the legacy
   * `ServerSettings.providers.<kind>` entry is empty or when the driver
   * is auto-bootstrapped without user configuration. Returning a typed
   * default keeps the migration path simple — no special-casing needed
   * to construct a "blank" instance.
   */
  readonly defaultConfig: () => Config;
  /**
   * Materialize one instance. The returned effect runs in a scope owned
   * by the registry; closing that scope releases every resource the
   * driver opened. Failures become unavailable shadow snapshots — the
   * driver MUST NOT throw defects.
   */
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<ProviderInstance, ProviderDriverError, R | Scope.Scope>;
}

/**
 * Heterogeneous-array convenience: the registry stores drivers as
 * `ReadonlyArray<AnyProviderDriver<R>>` where `R` is the union of all
 * registered drivers' env requirements.
 */
export type AnyProviderDriver<R = never> = ProviderDriver<any, R>;
```

Module doc `PD:1-23` states the design intent explicitly: not a `Context.Service` because "tags are
singleton-per-runtime and we need many instances of the same driver"; the only Effect service is
`ProviderInstanceRegistry`, which owns `Map<InstanceId, ProviderInstance>`.

### Types it references

- `ProviderDriverKind` — an **open** branded slug, not a closed union (`packages/contracts/src/providerInstance.ts:70`); pattern `^[a-zA-Z][a-zA-Z0-9_-]*$`, ≤64 chars (`:49,53-56`). Unknown drivers must parse and degrade, never crash (`:16-28`).
- `ProviderInstanceId` — separately branded routing key, same slug rules (`providerInstance.ts:82`). Threads/sessions/events reference instance ids, never driver kinds (`:10-14`).
- `ProviderInstanceEnvironment` — `ReadonlyArray<{name, value, sensitive, valueRedacted?}>` (`providerInstance.ts:104-113`), per-instance env vars.
- `ServerProviderShape` (the snapshot leg) — `{maintenanceCapabilities, getSnapshot, refresh, streamChanges}` (`apps/server/src/provider/Services/ServerProvider.ts:6-11`).
- `ProviderAdapterShape<TError>` (the session leg) — `PA:47-135`, reproduced below.
- `TextGeneration["Service"]` — commit-message/PR/branch/title generation (`apps/server/src/textGeneration/TextGeneration.ts`), a **required** field on every instance (`PD:73`).

### `ProviderAdapterShape` — the actual per-session SPI

```ts
export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";           // PA:28
export interface ProviderAdapterCapabilities { readonly sessionModelSwitch: ProviderSessionModelSwitchMode }  // PA:30-35
export interface ProviderThreadTurnSnapshot { readonly id: TurnId; readonly items: ReadonlyArray<unknown> }   // PA:37-40
export interface ProviderThreadSnapshot { readonly threadId: ThreadId; readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot> } // PA:42-45

export interface ProviderAdapterShape<TError> {
  readonly provider: ProviderDriverKind;                                              // PA:51
  readonly capabilities: ProviderAdapterCapabilities;                                 // PA:52
  readonly startSession: (input: ProviderSessionStartInput) => Effect.Effect<ProviderSession, TError>;         // PA:57-59
  readonly sendTurn: (input: ProviderSendTurnInput) => Effect.Effect<ProviderTurnStartResult, TError>;          // PA:64-66
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;                 // PA:71
  readonly respondToRequest: (threadId, requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => Effect.Effect<void, TError>; // PA:76-80
  readonly respondToUserInput: (threadId, requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) => Effect.Effect<void, TError>; // PA:85-89
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;          // PA:94
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;         // PA:99
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;                // PA:104
  readonly readThread: (threadId) => Effect.Effect<ProviderThreadSnapshot, TError>;   // PA:109
  readonly rollbackThread: (threadId, numTurns: number) => Effect.Effect<ProviderThreadSnapshot, TError>; // PA:114-117
  readonly uploadFeedback?: (input: ProviderUploadFeedbackInput) => Effect.Effect<ProviderUploadFeedbackResult, TError>; // PA:122-124
  readonly stopAll: () => Effect.Effect<void, TError>;                                // PA:129
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;                         // PA:134
}
```

Start/turn/session value types (`packages/contracts/src/provider.ts`):
- `ProviderSession` `:34-51` — `{provider, providerInstanceId?, status, runtimeMode, cwd?, model?, threadId, resumeCursor?, activeTurnId?, createdAt, updatedAt, lastError?}`; status ∈ `connecting|ready|running|error|closed` (`:26-32`).
- `ProviderSessionStartInput` `:53-66` — `{threadId, provider?, providerInstanceId?, cwd?, title?, modelSelection?, resumeCursor?, approvalPolicy?, sandboxMode?, runtimeMode}`.
- `ProviderSendTurnInput` `:68-79` — `{threadId, input?, attachments?, modelSelection?, interactionMode?}`; caps 120k chars / 8 attachments (`orchestration.ts:157-158`).
- `ProviderTurnStartResult` `:81-86` — `{threadId, turnId, resumeCursor?}`.
- `ProviderApprovalDecision` `orchestration.ts:140-147` — `accept | acceptForSession | acceptAlways | decline | cancel`.
- `ApprovalRequestId` — branded entity id (`baseSchemas.ts:128`).
- Adapter error union `apps/server/src/provider/Errors.ts` — Validation `:8`, SessionNotFound `:25`, SessionClosed `:41`, Request `:57`, Process `:74`.

### Driver shape in practice

Drivers are ~160-250 lines each (`ClaudeDriver` 246, `CodexDriver` 232, `CursorDriver` 188, `GrokDriver` 164,
`OpenCodeDriver` 211); adapters are 1.2k-4.8k. `CursorDriver.ts:94-188` is the clearest template: `create`
resolves services, calls `mergeProviderInstanceEnvironment(environment)` (`:111`), builds a continuation
identity (`:112-115`), calls `makeCursorAdapter(config, {environment, nativeEventLogger, instanceId})`
(`:128-132`), `makeCursorTextGeneration` (`:133`), a snapshot/probe (`:135-174`), and returns the plain
`ProviderInstance` record (`:176-186`). Adapter factories are closure factories returning an Effect, not
Layers: `makeClaudeAdapter(claudeSettings, options?)` `CA:1675-1678`, `makeCodexAdapter(codexConfig, options?)`
`CX:1645-1648`. `instanceId` defaults to the driver kind when unset (`CA:1679`, `CX:1649`) — a legacy shim.

Registry: `BUILT_IN_DRIVERS` is a plain array of five drivers (`apps/server/src/provider/builtInDrivers.ts:47-53`);
`BuiltInDriversEnv` is the union of their `R`s (`:35-40`). `ProviderInstanceRegistryLive` decodes the envelope
once and runs `create` in a fresh child scope per instance, storing `{instance, scope, entry}` (`:71-75`);
`reconcile` diffs config maps and tears down only changed instances (`:24-31`, `:94-96`). Unknown driver or
failed decode ⇒ an `"unavailable"` shadow snapshot, never a crash (`:7-20`).
`ProviderAdapterRegistry` is a stateless facade doing dynamic lookups (`Layers/ProviderAdapterRegistry.ts:33-47`).

---

## 2. How the Claude adapter implements it

`CA` is 4,753 lines at this SHA. All state is per-adapter or per-session closure; nothing is module-level mutable.

### The `query()` call

- `query` imported `CA:11`; called once at `CA:1710` inside the default `createQuery` closure `CA:1704-1713`, cast `as ClaudeQueryRuntime` (`CA:1713`).
- `createQuery` is injectable via `options.createQuery` (`CA:334-337`, `CA:1705`) — the test seam. Real invocation `CA:4370-4383` inside `Effect.try`, failure → `ProviderAdapterProcessError` (`CA:4376-4382`).
- `queryOptions` assembled at `CA:4303-4343`. Provenance of each key: `cwd`←input `:4304`; `model`←`resolveClaudeCatalogApiModelId` `:4255-4257,4305`; `pathToClaudeCodeExecutable`←resolved once per adapter `CA:1690-1693`, used `:4306`; `systemPrompt:{type:"preset",preset:"claude_code"}` hardcoded `:4307`; `settingSources:["user","project","local"]` module const `CA:1221-1225`, used `:4308`; `effort` `:4275-4279,4311-4315`; `permissionMode` from `runtimeMode` (`auto-accept-edits→acceptEdits`, `auto→auto`, `full-access→bypassPermissions`) `:4280-4285,4316`; `allowDangerouslySkipPermissions:true` only under bypass `:4317-4319`; `settings:{alwaysThinkingEnabled,fastMode,ultracode,autoCompactWindow}` `:4286-4293,4320`; `resume` `:4321`; `sessionId` (fresh UUIDv4 when not resuming) `:4322`; `includePartialMessages:true` hardcoded `:4323`; `canUseTool` `:4324`/`:4236-4237`; `onUserDialog` `:4238-4241`; `supportedDialogKinds:["resume_return"]` `:4326`; `env` `:4327`; `additionalDirectories:[cwd, attachmentsDir]` `:4299-4302,4328`; `extraArgs` from `parseCliArgs(launchArgs).flags` `:4244,4329`; `mcpServers["t3-code"]` `:4294,4330-4342`.
- **No `AbortController` is created by the adapter.** `grep -c "new AbortController" CA` = 0; `abortSignal` is never in `queryOptions`. The only `AbortSignal` is the SDK-supplied `callbackOptions.signal` inside `canUseTool`/`onUserDialog` (`CA:3867,3946,4049,4175,4180`). Cancellation is `context.query.close()` (`CA:3681`) + `Fiber.interrupt(streamFiber)` (`CA:3749`); comment `CA:3678-3679` says the SDK closes stdin then escalates SIGTERM→SIGKILL.

### Streaming input iterable

- Backed by an Effect `Queue`, not a raw push array: `Queue.unbounded<PromptQueueItem>()` `CA:3838`, then `Stream.fromQueue → filter(type==="message") → map(item.message) → catchCause(interrupts→empty) → Stream.toAsyncIterable` `CA:3839-3846`; passed as `prompt` `CA:4373`.
- `PromptQueueItem = {type:"message",message} | {type:"terminate"}` `CA:120-127`. **`"terminate"` is dead** — the only offer site emits `type:"message"` (`CA:4612-4614`).
- A second `sendTurn` offers into the live queue (`CA:4612-4615`); no new query. If a non-synthetic turn is live it is a **steer** — same `turnId`, no new `turn.started` (`CA:4519-4528,4569-4570`). A stale synthetic turn is closed first (`CA:4526-4528`).
- Query already ended: `sendTurn` calls `requireSession` first (`CA:4509`), which fails `SessionNotFound` (thread gone from `sessions`) or `SessionClosed` (`context.stopped || status==="closed"`) — `CA:3781-3802`. Teardown deletes the session (`CA:3776-3778`) and `Queue.shutdown`s the prompt queue (`CA:3744`). Offer failures map to a request error (`CA:4615`).
- The prompt stream swallows interrupt-only causes rather than failing (`CA:3842-3844`).

### SDK message → canonical event

Top-level dispatch `switch (message.type)` at `CA:3570` inside `handleSdkMessage` `CA:3558-3608`; `system` subtype switches at `CA:3124` (silently-consumed undeclared subtypes) and `CA:3131` (typed union); stream-event if-chains at `CA:2432,2449,2505,2603,2685`.

| SDK message | canonical event(s) | site |
|---|---|---|
| any msg with durable `session_id`, first time | `thread.started` | `CA:2010` (guard `:1996-2001`, `:351-361`) |
| `command_lifecycle` | dropped | `CA:3566` |
| `stream_event`/`message_delta` | `thread.token-usage.updated` | `CA:2442`→`:2097` |
| `stream_event`/`content_block_delta` text/thinking | `content.delta` (`assistant_text`/`reasoning_text`) | `CA:2480`, kind `:1353-1355` |
| `stream_event`/`content_block_delta` `input_json_delta` | `item.updated` (+`turn.plan.updated` for TodoWrite) | `CA:2543,2582` |
| `stream_event`/`content_block_start` text | none (registers block) | `CA:2605-2609,1837-1847` |
| `stream_event`/`content_block_start` tool_use/server_tool_use/mcp_tool_use | `item.started` | `CA:2654` |
| `stream_event`/`content_block_stop` (text) | `content.delta` fallback + `item.completed{assistant_message}` | `CA:2690`→`:1887,1918` |
| `user` (tool_result) | `item.updated` → optional `content.delta` (`command_output`/`file_change_output`) → `item.completed`; `turn.plan.updated` on task results | `CA:2734,2764,2788,2855`→`:2181` |
| `assistant` with `parent_tool_use_id` | dropped (refines subagent model) | `CA:2880-2902` |
| `assistant` with no active turn | synthetic `turn.started` | `CA:2929` |
| `assistant` with `ExitPlanMode` | `turn.proposed.completed` | `CA:2967`→`:2146` |
| `result` | `runtime.error` only if failed, then `turn.completed` (+`item.completed` per in-flight tool, `thread.token-usage.updated`) | `CA:2996-3012`, `:3008,3011`→`:2313,2358,2365` |
| `system/init` | `session.configured` | `CA:3135` |
| `system/status` | `session.state.changed` (`waiting` if compacting else `running`) | `CA:3144` |
| `system/compact_boundary` | `thread.token-usage.updated` + `thread.state.changed{compacted}` | `CA:3157,3171` |
| `system/hook_started|hook_progress|hook_response` | `hook.started`/`hook.progress`/`hook.completed` | `CA:3181,3192,3204` |
| `system/task_started` | `task.started` | `CA:3265` |
| `system/task_progress` | `task.progress` (+ per-member from `workflow_progress`) | `CA:3301,3062` |
| `system/task_updated` | `task.updated` | `CA:3332` |
| `system/task_notification` | `task.completed` | `CA:3360` |
| `system/files_persisted` | `files.persisted` | `CA:3376` |
| `system/thinking_tokens` | dropped | `CA:3395-3396` |
| `system/api_retry` | `session.state.changed{running}` | `CA:3404` |
| `system/session_state_changed` | `session.state.changed` | `CA:3415` |
| `system/notification` | `runtime.warning`, only at high/immediate priority | `CA:3430-3432` |
| `system/permission_denied` | `tool.denied` | `CA:3446` |
| `system/mirror_error` | `runtime.error` | `CA:3456` |
| `system/background_tasks_changed|vcs_state_changed|code_change_published` | dropped (undeclared wire subtypes) | `CA:3125-3128` |
| `system/model_refusal_fallback|local_command_output|plugin_install|commands_changed|memory_recall|elicitation_complete` | dropped | `CA:3436-3442` |
| `system`/unknown | `runtime.warning` | `CA:3470` |
| `tool_progress` | `tool.progress` | `CA:3503` |
| `tool_use_summary` | `tool.summary` | `CA:3520` |
| `auth_status` | `auth.status` | `CA:3536` |
| `rate_limit_event` | `account.rate-limits.updated` | `CA:3549` |
| `prompt_suggestion` | dropped | `CA:3593-3594` |

Not message-driven: `session.started` `CA:4436`, `session.configured` `:4447`, `session.state.changed{ready}` `:4466`, `turn.started` `:4594`, `request.opened` `:4136`, `request.resolved` `:4189`/`:3718`, `user-input.requested` `:3915`, `user-input.resolved` `:3963`, `task.completed{stopped}` `:3699`, `session.exited` `:3763`.

### `canUseTool` round trip

- Registered as `queryOptions.canUseTool` `CA:4324`; the JS callback `CA:4236-4237` is `runPromise(canUseToolEffect(...))` where `runPromise = Effect.runPromiseWith(runtimeContext)` captured per session at `CA:3836` from `Effect.context<never>()` `CA:3834`.
- Short-circuits before any approval, in order (`canUseToolEffect` `CA:4073-4234`): no context → `deny` `:4079-4084`; `AskUserQuestion` → separate user-input path `:4089-4091`; `ExitPlanMode` → emit `turn.proposed.completed` then **always `deny`** `:4093-4113`; **`runtimeMode === "full-access"` → unconditional `allow`, no approval event at all** `:4115-4121`.
- `ApprovalRequestId` minted from `crypto.randomUUIDv4` (`CA:4123`, generator `:1719-1730`) — **not** the SDK tool-use id.
- Park: `Deferred.make<ProviderApprovalDecision>()` `CA:4126`; `PendingApproval{requestType, detail, suggestions, decision}` `CA:164-169,4127-4132`; `request.opened` emitted **before** the map insert `:4135-4165`; then `Deferred.await` `:4184`.
- Map: `pendingApprovals: Map<ApprovalRequestId, PendingApproval>` created per session `CA:3848`, also hung on the context `:290,4414`.
- Answer: `respondToRequest` `CA:4653-4668` → `requireSession` → `get(requestId)` → unknown id fails `ProviderAdapterRequestError` `:4658-4662` → `delete` + `Deferred.succeed` `:4665-4666`.
- Return to SDK: `accept`/`acceptForSession` → `{behavior:"allow", updatedInput, updatedPermissions?}` `CA:4212-4224`; anything else → `{behavior:"deny", message}` `:4227-4233`.
- **`acceptAlways` is in the contract but unhandled in the Claude adapter** — only `"accept"` and `"acceptForSession"` allow (`CA:4212`); `acceptAlways` falls through to deny. `acceptForSession` re-scopes SDK suggestions to `destination:"session"`, or synthesizes `{type:"addRules", rules:[{toolName}], behavior:"allow", destination:"session"}` `CA:182-200,4218-4221`.
- **No timeout.** A pending approval waits forever. `[asserted]` grep for `timeout`/`Schedule` in `CA` yields only the prose comment at `CA:3678`.
- Abort: SDK signal listener `onAbort` deletes the entry and resolves `"cancel"` `CA:4167-4177`, with a late-listener race re-check `if (signal.aborted) onAbort()` `:4180-4182`.
- Teardown: `stopSessionInternal` walks `pendingApprovals`, `Deferred.succeed(…, "cancel")` and emits `request.resolved{decision:"cancel"}` each, then `.clear()` `CA:3714-3732`; pending user-inputs get `pending.cancel` `:3736-3738`. `interruptTurn`/`stopSession`/finalizer all funnel here `:4632,4690,4723-4731`.
- **There is no hooks-based `PreToolUse` path.** `grep "PreToolUse\|hooks"` over `CA` → zero; no `hooks` key in `queryOptions` `CA:4303-4343`. Hooks appear only as *observation* (`system/hook_*` → `hook.*`, `CA:3178-3214`). `canUseTool` is the sole approval channel; nothing coexists with it.
- Parallel channel for `AskUserQuestion`: `pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>` `CA:202-207,3849`, own Deferred + `cancel` `:3894-3910`, settled by `respondToUserInput` `:4670-4685`, returns `{behavior:"allow", updatedInput:{questions,answers}}` `:3994-4000`. Question `id` is deliberately the full question text `:3874-3881`.

### `result`, errors, abort

- `handleResultMessage` `CA:2996-3012`; status via `turnStatusFromResult` `:1338-1351` — `success`→completed, `isInterruptedResult`→interrupted, error text containing `"cancel"`→cancelled, else failed. Interrupt detection keys on `terminal_reason ∈ {aborted_tools, aborted_streaming}` `:439-442` plus error-text heuristics `:446-457`.
- Only `failed` emits `runtime.error` `CA:3007-3009`; `[ede_diagnostic]`-prefixed errors are stripped from the user-facing message `:428-433`. `runtime.error` emitter `:2030-2054` with `class:"provider_error"`.
- **Failed Effects are reserved for caller-facing API misuse and plumbing**, never for model/stream failures: Validation on wrong provider `CA:3808-3812` and uninitialized thread `:1778-1782`; Process on query construction `:4376` and `query.close()` `:3683`; Request on unknown approval/user-input ids `:4658,4676` and `setModel`/`setPermissionMode` `:4535,4560,4565`; SessionNotFound/Closed `:3787,3795`. SDK stream faults land in the forked `streamFiber` `:4478-4494` and become events via `handleStreamExit` `:3639-3670`.
- `handleStreamExit`: interrupt-shaped cause → `completeTurn(interrupted)` `CA:3648-3651`; else `runtime.error` + `completeTurn(failed)` `:3653-3661`; clean end with a live turn → `completeTurn(interrupted, "Claude runtime stream ended.")` `:3663-3665`; always ends in `stopSessionInternal(emitExitEvent:true)` `:3667-3669`.
- **`interruptTurn` neither calls SDK `interrupt()` nor aborts a controller** — it is `requireSession` + `stopSessionInternal` `CA:4626-4634`; comment `:4629-4631` "Stop is a hard session boundary for Claude". `interrupt` is not a member of `ClaudeQueryRuntime` `:324-329`. Emitted on interrupt: `task.completed{stopped}` per live task `:3699`, `request.resolved{cancel}` per pending approval `:3718`, `turn.completed{interrupted,"Session stopped."}` `:3741`→`:2365`, `session.exited{graceful}` `:3763-3773`; the thread is then removed from `sessions` `:3776-3778`, so the session is unusable afterwards.

### Resume

- Every SDK message with a durable `session_id` sets `context.resumeSessionId` `CA:2003` and calls `updateResumeCursor` `:2004`; hook messages excluded as non-durable `:351-361,1999`.
- Cursor shape `{threadId, resume, resumeSessionAt, turnCount}` `CA:1799-1810`; `resumeSessionAt` = last assistant message `uuid` `:2899,2992`. Refreshed on each assistant message, `completeTurn` `:2393`, `rollbackThread` `:4648`. Returned from `sendTurn` `:4620-4622`.
- Restart: `readClaudeResumeState` `CA:3828`, parser `:676-712` — `resume` accepted **only if `isUuid`** `:699`; synthetic `claude-thread-*` ids rejected `:347-349,689`. `resume` and a fresh `sessionId` are mutually exclusive `:4321-4322,3831`. `resumeSessionAt` round-trips in the cursor but is **never passed to the SDK** (`lastAssistantUuid` seeded from it at `:4427`).

### Binary + env

- `ClaudeSettings.binaryPath` `packages/contracts/src/settings.ts:423-429`; `homePath` = "CLAUDE_CONFIG_DIR path" `:430-438`; also `customModels`, `launchArgs`, `autoCompactWindow` `:439-467`.
- `resolveClaudeSdkExecutablePath` `Drivers/ClaudeExecutable.ts:61-89`: non-Windows returns the configured value **unchanged** `:64-66`. Windows resolves PATH/PATHEXT via `SpawnExecutableResolution` `:68-70` and follows a `.cmd|.bat|.ps1` shim to `node_modules/@anthropic-ai/claude-code/bin/claude.exe` then `cli.js` `:23-26,77-82`, else warns and returns the original `:84-88`. Rationale (the SDK spawns without a shell and has no `shell:true` escape hatch) `:46-60`.
- Generic CLI path (probes, text generation) uses `resolveSpawnCommand` `packages/shared/src/shell.ts:639-668` — non-Windows is a pass-through `:645-647`; Windows resolves and sets `shell:true` only for `.cmd`/`.bat` `:659-667`.
- **The only env var t3code sets for Claude is `CLAUDE_CONFIG_DIR`** `Drivers/ClaudeHome.ts:33`, and only when `homePath` is non-empty `:22-23`. Explicit comment `:27-32`: overriding `HOME` relocates the macOS keychain lookup so the CLI reports "Not logged in".
- **Zero process-global env mutation in the entire server.** `grep -rE 'process\.env\.[A-Za-z_0-9]+ *=[^=]|process\.env\[[^]]+\] *=[^=]' apps/server/src` (excluding tests) = 0 matches. Env is threaded as values: `mergeProviderInstanceEnvironment(environment, baseEnv = process.env)` copies `{...baseEnv}` `apps/server/src/provider/ProviderInstanceEnvironment.ts:11-15`, and the host env itself is an Effect service (`HostProcessEnvironment`, `shell.ts:649`).

### SDK drift

- Pinned `"@anthropic-ai/claude-agent-sdk": "^0.3.170"` `apps/server/package.json:25` — a caret on a 0.x package, so 0.3.x minors float in.
- Compile-time guard: `message satisfies never` exhaustiveness at `CA:3598` (top level) and `CA:3468` (system subtypes) — a new SDK message type breaks typecheck rather than silently degrading. Comments `:3596-3597,3463-3467`.
- Runtime fallback: `emitRuntimeWarning(describeUnknownSdkMessage(...))` `CA:3600-3603,3470-3473`, plus a hand-maintained allowlist of undeclared-but-real wire subtypes consumed silently `:3114-3129`.
- **Nothing asserts the SDK package version at runtime.** The only version check is on the *CLI*: `claude --version` shelled at `Layers/ClaudeProvider.ts:427-429`, parsed `:473`, turned into upgrade advisories `:500,554`, behind a 5-minute TTL cache in the driver `Drivers/ClaudeDriver.ts:63,166-173,184`.
- Account identity is discovered by a **query that never yields**: `probeClaudeCapabilities` `Layers/ClaudeProvider.ts:315-370` starts a `query` whose prompt generator only awaits the abort signal (`:331-334`, comment "This prevents any prompt from reaching the Anthropic API"), reads `await q.initializationResult()` `:337`, and pulls `account.{email,subscriptionType,tokenSource,apiProvider}` + slash commands `:343-356`. Probe options `:175-209`: `persistSession:false`, `settings:{disableAllHooks:true}` (it fires every few minutes, so SessionStart hooks would run on every health check), `allowedTools:[]`, `mcpServers:{}`, `strictMcpConfig:true`, `ENABLE_CLAUDEAI_MCP_SERVERS:"false"`, `FORCE_CODE_TERMINAL:undefined`, `CLAUDE_CODE_AUTO_CONNECT_IDE:"0"`. 25 s timeout, raised from 8 s because Bedrock init is slower `:158-162`. **This is the cleanest available "which account is this?" probe and we should copy it.**
- `ClaudeCapabilitiesProbe.test.ts` exists in `Layers/` with no matching module — the code under test lives in `ClaudeProvider.ts`.

### Claude no-ops

- `uploadFeedback` — **absent from the returned object** `CA:4733-4752`; optional in the shape `PA:122`.
- `rollbackThread` — **local-only**: splices `context.turns` in memory and re-stamps the cursor, tells the CLI nothing `CA:4643-4651`. Claude's own history is untouched.
- `readThread` — returns only the turns this process accumulated `CA:4636-4641`→`:1775-1791`; a resumed session reads back empty/partial.
- `respondToUserInput` — real, not a stub `CA:4670-4685`.
- `capabilities` is one key: `{sessionModelSwitch:"in-session"}` `CA:4735-4737`.
- `ClaudeAdapterShape` adds nothing over `ProviderAdapterShape<ProviderAdapterError>` `Services/ClaudeAdapter.ts:19`; the Context tag was deliberately removed `:4-9`.

---

## 3. How the Codex adapter implements the same interface

`CX` is 2,037 lines + `CodexSessionRuntime.ts` (`CSR`) which does the JSON-RPC work.

### Process + transport

- One `codex app-server` child **per session (per threadId)**, not per adapter — `CSR:1189-1208`. Claude, by contrast, spawns per session through the SDK.
- Args `["app-server", ...tokenized launchArgs, ...appServerArgs]` `codexLaunchArgs.ts:13-16,42-48`, assembled `CSR:1184`. `launchArgs` precedence: env `T3CODE_CODEX_LAUNCH_ARGS` > config > `""` (`codexLaunchArgs.ts:3-8`).
- Framing: **NDJSON over stdin/stdout**, hand-scanned for `\n` (`packages/effect-codex-app-server/src/protocol.ts:398-421`; stdio adapter `_internal/stdio.ts:13-22`). JSON-RPC ids are a monotonic integer counter (`protocol.ts:166`). No ports, no sockets.
- Handle ownership: the spawn is scoped to a `Scope.make("sequential")` the **adapter** mints per session (`CX:1718`, handed in `:1725`, used `CSR:1161,1200`), with a `sessionScopeTransferred` flag so a half-built scope is released on start failure (`CX:1718-1722,1786`). `forceKillAfter: "2 seconds"` (`CSR:55,1195`).
- Teardown: `stopSessionInternal → runtime.close → Scope.close → Fiber.interrupt(eventFiber)` (`CX:1963-1974`); `runtime.close` settles parked approvals, emits `session/closed`, closes the scope, shuts both queues (`CSR:2272-2291`). Adapter scope release calls `stopAll` (`CX:2001-2007`).
- Unexpected exit watched on a forked fiber → `session/exited` (`CSR:2204-2229`); stderr is line-buffered, ANSI-stripped, level-classified and re-emitted as `process/stderr` (`CSR:2171-2202`, classifier `:650-668`).

### startSession / sendTurn

- `initialize` → `initialized` → `thread/start`|`thread/resume` (`CSR:2233,2234,2238-2246`, helper `:691-728`). Client identity hardcoded `t3code_desktop`, `experimentalApi: true` (`CodexProvider.ts:308-319`).
- **The canonical `ThreadId` is never sent to Codex.** The Codex conversation id lives in `session.resumeCursor = {threadId: providerThreadId}` (`CSR:2254`), read back by `readResumeCursorThreadId` (`:487-491,2262-2270`); every later RPC uses that. The adapter re-narrows the `Schema.Unknown` cursor with a runtime guard (`CX:1695-1697,73`; schema `CSR:69-71`).
- Resume is best-effort: a "thread not found"-class error falls back to a fresh `thread/start` (`CSR:670-676,718-726`).
- `sendTurn` → RPC `turn/start` through the **raw/untyped** channel (`CSR:2325`) because the generated `V2TurnStartParams` lacks `collaborationMode`; a local `fieldsAssign` patch stands in, with a `TODO` (`CSR:130-139`). Response decoded by hand (`:2326-2334`).
- **`turnId` is minted by the Codex server** (`TurnId.make(response.turn.id)`, `CSR:2335`); Claude mints a local UUIDv4 (`CA:4569`). The same field on the same interface has two different authorities.
- `activeTurnId` is deliberately not overwritten when a turn is live, because Codex queues follow-ups and `turn/interrupt` only accepts the active id (`CSR:2336-2343`).
- `config/mcpServer/reload` fires before every turn when MCP is configured (`CSR:2299-2307`).

### Event mapping (dispatch entry `mapToRuntimeEvents` `CX:770`)

Notification → canonical, with dispatch lines in `CX`: `session/connecting` 905 and `session/ready` 918 → `session.state.changed`; `session/exited`,`session/closed` 944 → `session.exited`; `thread/started` 961; `thread/status/changed|archived|unarchived|closed|compacted` 982 → `thread.state.changed`; `thread/name/updated` 1005 → `thread.metadata.updated`; `thread/tokenUsage/updated` 1035; `turn/started` 1053; `turn/completed` 1068; `turn/aborted` 1081; `turn/plan/updated` 1097; `turn/diff/updated` 1118; `item/started` 1127 (→ `mapItemLifecycle` 466-504); `item/completed` → `turn.proposed.completed` for plan items 1146 else `item.completed` 1153; `item/reasoning/summaryPartAdded` and `item/commandExecution/terminalInteraction` → `item.updated` 1164; `item/plan/delta` → `turn.proposed.delta` 1183; five delta families → `content.delta` with distinct `streamKind` (`agentMessage` 1200 `assistant_text`, `commandExecution/outputDelta` 1221 `command_output`, `fileChange/outputDelta` 1242 `file_change_output`, `reasoning/summaryTextDelta` 1263, `reasoning/textDelta` 1282); `item/mcpToolCall/progress` → `tool.progress` 1300; any `kind:"request"` → `request.opened` 866; `serverRequest/resolved` → `request.resolved` 1320; `model/rerouted` 1352; `deprecationNotice` 1370; `configWarning` 1387; `account/updated` 1407; `account/rateLimits/updated` 1422; `mcpServer/oauthLogin/completed` 1441; five `thread/realtime/*` 1462-1530; `error` 1545 and `process/stderr` 1562/1571 → `runtime.warning`/`runtime.error`; `windows/worldWritableWarning` 1587; `windowsSandbox/setupCompleted` 1610/1621; `kind:"error"` 784. The whole `collabAgent/*` family maps to `task.*` (started 557,596; updated 573,583,614,634,650,663,672,761; progress 716,747).

- `CX:931` maps `session/started` → `session.started`, but that branch is **unreachable**: the runtime only ever emits `session/connecting`, `session/ready`, `session/closed`, `session/exited` (`CSR:2232,2258,2283,2218`).

### Approvals — mechanically the same park

- Handlers registered for exactly **four** server→client request methods: `item/commandExecution/requestApproval` `CSR:1918`, `item/fileChange/requestApproval` `:1974`, `mcpServer/elicitation/request` `:2032`, `item/tool/requestUserInput` `:2097`. Everything else falls to `handleUnknownServerRequest → methodNotFound` (`CSR:2147-2149`).
- Two maps, keyed differently: `pendingApprovalsRef: Ref<Map<ApprovalRequestId, PendingApproval>>` (`CSR:1164`, shape `:270-277`) and `approvalCorrelationsRef` keyed by the **Codex-side** `approvalId ?? itemId` (`CSR:1165`, populated `:1937-1946`, consumed only to enrich `serverRequest/resolved` then deleted `:1816-1835`).
- The `ApprovalRequestId` is a fresh UUIDv4 minted per approval (`CSR:1920,1976,2065,2099`) — **not** the JSON-RPC request id. The JSON-RPC id stays implicit inside the suspended handler continuation (`protocol.ts:271`).
- `jsonRpcId` is written onto `PendingApproval` (`CSR:1929,1987,2055`) and **never read** anywhere in `apps/server/src` — dead field. `[asserted]` (grep).
- Park: `Deferred.await(decision)` with `Effect.ensuring` cleanup `CSR:1959-1967,2017-2025,2084-2092`; user-input twin `:2125-2133`.
- Answer: `respondToRequest` `CSR:2417-2445` — lookup `:2419`, not-found error `:2421`, delete `:2425-2429`, `Deferred.succeed` `:2430`, then a **synthetic** `item/requestApproval/decision` notification `:2431-2444` which the adapter turns into `request.resolved` (`CX:891`). Adapter passthrough `CX:1932-1940`.
- `acceptAlways → acceptForSession` downgrade on the command path (`CSR:1968-1970`, verified). Claude drops `acceptAlways` to deny (`CA:4212`). **Neither provider actually implements the contract's `acceptAlways`.**
- Close settles every parked deferred with `"cancel"`/`{}` so no handler leaks (`CSR:1392-1412`, called `:2277-2278`) — same shape as Claude's `CA:3714-3732`.
- Verdict: the Deferred-park is a **genuine shared abstraction**, arrived at independently over an in-process SDK callback and an out-of-process JSON-RPC request. Copy it.

### Method-by-method: what is real where

| method | Codex | Claude |
|---|---|---|
| `rollbackThread` | real RPC `thread/rollback` `CX:1896-1919`→`CSR:2394-2406` | in-memory `context.turns.splice` only, no RPC `CA:4643-4651` |
| `readThread` | real RPC `thread/read` `CX:1882-1894`→`CSR:2386-2393` | in-process turns only `CA:4636-4641`; empty after resume |
| `uploadFeedback` | real RPC `feedback/upload` `CX:1921-1930`→`CSR:2407-2416`; re-typed non-optional `Services/CodexAdapter.ts:19-22` | **absent** from the returned object `CA:4733-4752`; guarded at `ProviderService.ts:1131,1145` |
| `interruptTurn` | real per-turn `turn/interrupt` + bounded fan-out to live child threads `CSR:2353-2385` | ignores `_turnId`, tears down the session `CA:4626-4634` |
| `respondToUserInput` | real `CX:1942-1954` | real `CA:4670-4685` |
| `capabilities.sessionModelSwitch` | `"in-session"` `CX:2011-2013` | `"in-session"` `CA:4736` |

Nothing is a stub for Codex; all thirteen members are real. `uploadFeedback` is the only genuinely
provider-specific method, and the shape models that honestly as an optional member. `rollbackThread`
and `readThread` are the opposite case — same signature, but Codex crosses the process boundary while
Claude fakes it locally, so a caller cannot reason about either from the type alone.

### Where the shared interface forced a shim for Codex

- **Ignored outright** (never referenced in `CX:1669-1858`): `approvalPolicy` (`provider.ts:62`) and `sandboxMode` (`:63`) — Codex derives both from `runtimeMode` instead (`CSR:493-527,546-565`); `title` (`:59`); `providerInstanceId` (`:57`) — the adapter uses its captured `boundInstanceId` (`CX:1649`).
- `resumeCursor: Schema.Unknown` in three places (`provider.ts:45,61,84`) — two distinct identities (canonical `ThreadId`, Codex conversation id) smuggled through an untyped hole, re-narrowed at every read (`CX:1695`, `CSR:487-491`).
- `ProviderThreadSnapshot.items: ReadonlyArray<unknown>` (`PA:39`) — Codex has a fully typed item union (`CSR:152-154,183-186`) **erased to `unknown`** at the boundary (`CX:1890-1893,1914-1917`).
- `ProviderUploadFeedbackResult.feedbackId` (`provider.ts:119-121`) — Codex has no feedback id, so it returns the *thread id* under that name: `Effect.map(({threadId}) => ({feedbackId: threadId}))` (`CX:1924`, verified; server response is `{threadId}` `_generated/schema.gen.ts:37803`).
- `attachments` — non-image attachments silently discarded (`CX:1825-1832`).
- `modelSelection` honored only when `instanceId === boundInstanceId`, else silently dropped (`CX:1683-1685,1699-1701,1836-1848`).
- `ProviderUserInputAnswers = Record<String, Unknown>` (`orchestration.ts:153`) — re-shaped in both directions: single-element arrays collapsed to scalars inbound (`CX:338-347`), re-expanded outbound with a dedicated failure type (`CSR:248-257,2136-2142,2454`).
- `CanonicalItemType` is derived by **string sniffing** — camelCase/punctuation normalized then substring-matched (`CX:210-240`). Not a mapping table: a new Codex item type silently becomes `"unknown"` and is dropped (`:479-481`).
- `CanonicalRequestType` is a method-string switch (`CX:298-321`, verified) with **six unreachable arms**: `applyPatchApproval`, `execCommandApproval`, `item/tool/call`, `account/chatgptAuthTokens/refresh`, `item/permissions/requestApproval`, and `item/fileRead/requestApproval` (the last not even in the protocol method table). They are in the generated meta table (`_generated/meta.gen.ts:110-115`) but have no handler registration.
- The multi-agent `collabAgent/*` family is **synthetic** — invented by the runtime (`CSR:1329,1466,1528,1609-1708`) with untyped `Record<string, unknown>` payloads re-parsed field-by-field with `typeof` guards (`CX:514-768`), and it smuggles a UI-layer field `timelineBypass: true` (`CX:549`) through the "canonical" contract.
- `ProviderSession.status` does not model Codex's queued-follow-up state; worked around by the `activeTurnId ?? turnId` trick (`CSR:2336-2343`).

### Codex binary + env

- `codexConfig.binaryPath` → `CX:1691` → `CSR:1185`; default is the bare string `"codex"` (OS PATH lookup), `makeBinaryPathSetting("codex")` `settings.ts:364`, fallback `:305-315`. Windows-only resolution via `resolveSpawnCommand` (`CSR:1185-1188`).
- `CODEX_HOME` is set **per-child, in the spawn env only** (`CSR:1179-1182`), with manual `~` expansion because `spawn` does not shell-expand env values (comment `:1175-1177`). Same in the probe (`CodexProvider.ts:329-338`).
- Zero `process.env.X =` in production code (grep over `apps/server/src` hits only tests). `process.env` is read in three places only: `codexLaunchArgs.ts:7`, `CX:1690` (`process.cwd()`), `CX:1706`.

---

## 4. The canonical event schema

Lives in `packages/contracts/src/providerRuntime.ts` (1,219 lines). Envelope + discriminated union;
each member is `{...ProviderRuntimeEventBase.fields, type: <literal>, payload: <struct>}`.

**Base**, on every event (`PR:252-267`): `eventId: EventId`, `provider: ProviderDriverKind`,
`providerInstanceId?: ProviderInstanceId`, `threadId: ThreadId`, `createdAt: IsoDateTime`,
`turnId?`, `itemId?: RuntimeItemId`, `requestId?: RuntimeRequestId`,
`providerRefs?: {providerTurnId?, providerItemId?, providerRequestId?}` (`PR:46-50`),
`raw?: {source, method?, messageType?, payload: unknown}` (`PR:34-39`). `raw.source` is a closed
literal naming the wire protocol — `codex.app-server.notification|request`, `codex.eventmsg`,
`claude.sdk.message`, `claude.sdk.permission`, `codex.sdk.thread-event`, `opencode.sdk.event`,
`acp.jsonrpc`, and a template literal `acp.${string}.extension` (`PR:22-31`).

**Shared vocabularies** (`PR:52-148`): `RuntimeSessionState` = starting|ready|running|waiting|stopped|error;
`RuntimeThreadState` = active|idle|archived|closed|compacted|error; `RuntimeTurnState` =
completed|failed|interrupted|cancelled; `RuntimeItemStatus` = inProgress|completed|failed|declined;
`RuntimeContentStreamKind` = assistant_text|reasoning_text|reasoning_summary_text|plan_text|command_output|file_change_output|unknown;
`RuntimeErrorClass` = provider_error|transport_error|permission_error|validation_error|unknown;
`CanonicalItemType` (`:118-131`) = user_message|assistant_message|reasoning|plan|<7 tool lifecycle types>|review_entered|review_exited|context_compaction|error|unknown, where
`TOOL_LIFECYCLE_ITEM_TYPES` (`:105-113`) = command_execution|file_change|mcp_tool_call|dynamic_tool_call|collab_agent_tool_call|web_search|image_view;
`CanonicalRequestType` (`:133-148`) = command_execution_approval|file_read_approval|file_change_approval|apply_patch_approval|exec_command_approval|mcp_elicitation_approval|tool_user_input|dynamic_tool_call|auth_tokens_refresh|unknown.

**The 49 event types**, with payload fields and the payload's definition line:

| type | payload | `PR:` |
|---|---|---|
| `session.started` | `message?`, `resume?: unknown` | 269 |
| `session.configured` | `config: Record<string,unknown>` | 275 |
| `session.state.changed` | `state: RuntimeSessionState`, `reason?`, `detail?` | 280 |
| `session.exited` | `reason?`, `recoverable?`, `exitKind?: graceful\|error` | 287 |
| `thread.started` | `providerThreadId?` | 294 |
| `thread.state.changed` | `state: RuntimeThreadState`, `detail?` | 299 |
| `thread.metadata.updated` | `name?`, `metadata?` | 305 |
| `thread.token-usage.updated` | `usage: ThreadTokenUsageSnapshot` (16 fields incl. `usedTokens`, `maxTokens?`, cached/reasoning splits, `lastX` deltas, `compactsAutomatically?`, `autoCompactThreshold?`) | 331 (snapshot 310-329) |
| `thread.realtime.started` | `realtimeSessionId?` | 336 |
| `thread.realtime.item-added` | `item: unknown` | 341 |
| `thread.realtime.audio.delta` | `audio: unknown` | 346 |
| `thread.realtime.error` | `message` | 351 |
| `thread.realtime.closed` | `reason?` | 356 |
| `turn.started` | `model?`, `effort?` | 361 |
| `turn.completed` | `state: RuntimeTurnState`, `stopReason?`, `usage?`, `modelUsage?`, `totalCostUsd?`, `errorMessage?` | 367 |
| `turn.aborted` | `reason` | 377 |
| `turn.plan.updated` | `explanation?`, `plan: Array<{step, status: pending\|inProgress\|completed}>` | 388 (step 382) |
| `turn.proposed.delta` | `delta: string` | 394 |
| `turn.proposed.completed` | `planMarkdown` | 399 |
| `turn.diff.updated` | `unifiedDiff: string` | 404 |
| `item.started` / `item.updated` / `item.completed` | `ItemLifecyclePayload`: `itemType: CanonicalItemType`, `status?`, `title?`, `detail?`, `data?: unknown`, `agentId?`, `parentToolUseId?` | 409-423 |
| `content.delta` | `streamKind: RuntimeContentStreamKind`, `delta: string`, `contentIndex?`, `summaryIndex?` | 425 |
| `request.opened` | `requestType: CanonicalRequestType`, `detail?`, `appName?`, `options?: Array<ProviderApprovalOption>`, `args?: unknown` | 433 |
| `request.resolved` | `requestType`, `decision?: string`, `resolution?: unknown` | 442 |
| `user-input.requested` | `questions: Array<{id, header, question, options: Array<{label, description}>, multiSelect}>` | 466 (question 452) |
| `user-input.resolved` | `answers: Record<string,unknown>` | 471 |
| `task.started` | `taskId: RuntimeTaskId`, `description?`, + agent-linkage fields | 594 |
| `task.progress` | `taskId`, `description`, `summary?`, `usage?`, `typedUsage?: RuntimeTaskUsage`, `lastToolName?`, `status?`, `error?`, + linkage | 613 |
| `task.updated` | `taskId`, `status?: RuntimeTaskStatus`, `description?`, `error?`, `endedAt?`, `isBackgrounded?`, + linkage | 632 |
| `task.completed` | `taskId`, `status: completed\|failed\|stopped`, `summary?`, `usage?`, `typedUsage?`, + linkage | 643 |
| `hook.started` | `hookId`, `hookName`, `hookEvent` | 653 |
| `hook.progress` | `hookId`, `output?`, `stdout?`, `stderr?` | 660 |
| `hook.completed` | `hookId`, `outcome: success\|error\|cancelled`, `output?`, `stdout?`, `stderr?`, `exitCode?` | 668 |
| `tool.progress` | `toolUseId?`, `toolName?`, `summary?`, `elapsedSeconds?`, `taskId?`, `parentToolUseId?` | 678 |
| `tool.summary` | `summary`, `precedingToolUseIds?` | 689 |
| `tool.denied` | `toolName`, `toolUseId?`, `reason?`, `agentId?` | 763 |
| `auth.status` | `isAuthenticating?`, `output?: string[]`, `error?` | 695 |
| `account.updated` | `account: unknown` | 702 |
| `account.rate-limits.updated` | `rateLimits: unknown` | 707 |
| `mcp.status.updated` | `status: unknown` | 712 |
| `mcp.oauth.completed` | `success`, `name?`, `error?` | 717 |
| `model.rerouted` | `fromModel`, `toModel`, `reason` | 724 |
| `config.warning` | `summary`, `details?`, `path?`, `range?` | 731 |
| `deprecation.notice` | `summary`, `details?` | 739 |
| `files.persisted` | `files: Array<{filename, fileId}>`, `failed?: Array<{filename, error}>` | 745 |
| `runtime.warning` | `message`, `detail?` | 771 |
| `runtime.error` | `message`, `class?: RuntimeErrorClass`, `detail?` | 777 |

`RuntimeTaskUsage` (`PR:477-489`) and `RuntimeTaskStatus` (`PR:600-611` = pending|running|waiting|idle|completed|failed|cancelled|interrupted) are the subagent vocabulary. A doc comment
at `PR:473-476` records that "Claude reports per-activation deltas; Codex reports cumulative totals —
the merge strategy is provider-specific and lives in client-runtime": the schema unified the shape but
not the semantics.

Union at `PR:1144-1197`; `ProviderRuntimeEvent = ProviderRuntimeEventV2` (`:1197`). Six legacy aliases
are kept at `:1202-1215` (`MessageDelta→ContentDelta`, `ToolStarted→ItemStarted`, `ApprovalRequested→RequestOpened`, …).

**Schema bug to not copy:** the `ProviderRuntimeEventType` literal list (`PR:150-199`) has **48**
entries; the actual union (`PR:1144-1197`) has **49** members. `tool.denied` has a `*Type` const
(`PR:248`), a payload (`:763`), a struct (`:1123-1128`) and is in the union (`:1191`) but is **absent
from the literal list**. Two sources of truth for "the set of event types", already drifted.

### Who emits what

Regex count of literal `type: "..."` sites in non-test adapter sources (approximate — helper-constructed
emissions may be missed):

| provider | canonical types emitted |
|---|---|
| Claude (`CA`) | 34 |
| Codex (`CX` + `CSR`) | 37 |
| Cursor + Grok (`CursorAdapter`, `GrokAdapter`, `provider/acp/*`) | 13 |
| OpenCode (`OpenCodeAdapter`, `opencodeRuntime.ts`) | 15 |

Single-provider types — **24 of 49, roughly half the vocabulary, is provider-specific**:
- Claude-only: `session.configured`, `auth.status`, `files.persisted`, `hook.started`, `hook.progress`, `hook.completed`, `item.started`, `task.completed`, `tool.denied`, `tool.summary`.
- Codex-only: `account.updated`, `config.warning`, `deprecation.notice`, `mcp.oauth.completed`, `model.rerouted`, `thread.metadata.updated`, `turn.aborted`, `turn.diff.updated`, `turn.proposed.delta`, and the five `thread.realtime.*`.
- Emitted by nobody: `mcp.status.updated` (`PR:191`).
- ACP (Cursor/Grok) and OpenCode contribute **zero** unique types — they are strict subsets.

The genuinely shared core is small: `session.started/state.changed/exited`, `thread.started`,
`turn.started/completed`, `item.*`, `content.delta`, `request.opened/resolved`,
`user-input.requested/resolved`, `runtime.warning/error`. **That ~15-event core is the template worth
copying; the other 34 are one provider's protocol leaking into a shared contract.**

---

## 5. Where the SPI design hurts

New relative to `docs/research/t3code.md`; the #5110 sqlite-growth story is covered there and only the
new detail appears here.

**One unbounded PubSub for every instance.** `ProviderService` fans in every adapter's `streamEvents`
through a single `PubSub.unbounded<ProviderRuntimeEvent>()` (`Layers/ProviderService.ts:234`), with one
forked `Stream.runForEach` per instance (`:390-397`). Unbounded means no backpressure and no drop
policy: one chatty session's events queue without limit ahead of every other session's, which is the
structural shape of the "#5681 Codex subagent progress delays unrelated threads" complaint. Nothing in
the SPI gives a per-instance or per-thread budget.

**The fan-in throws instead of failing.** `correlateRuntimeEventWithInstance` (`ProviderService.ts:195-213`)
`throw`s a plain `Error` when an adapter emits the wrong `provider` or a foreign `providerInstanceId` —
a defect inside a forked fiber, not a typed failure. A misbehaving driver kills its subscription fiber
rather than being quarantined.

**The one admitted singleton is the log writer, and the reason is honest.** `ProviderEventLoggers`
(`Layers/ProviderEventLoggers.ts:43-49`) exists as a tag specifically because "multiple driver instances
per kind (`codex_personal`, `codex_work`) must share one underlying log store — opening N writers
against the same rotating file would race the rotation logic" (`:14-18`). Per-instance log isolation was
traded away for rotation safety. If we want per-account log files we must solve rotation first.

**`capabilities` is a fake abstraction today.** `sessionModelSwitch` is the only capability, its
`"unsupported"` arm (`PA:28`) has **zero inhabitants** — all five adapters declare `"in-session"`
(`CA:4736`, `CX:2011-2013`, `CursorAdapter.ts:1178`, `GrokAdapter.ts:2031`, `OpenCodeAdapter.ts:3267`) —
so both consumer branches in `ProviderCommandReactor.ts:717,818` are dead. A capability that
discriminates nothing is worse than no capability: it looks like a negotiation point and isn't one.

**Same signature, different guarantees.** `readThread` and `rollbackThread` are real RPCs for Codex
(`CX:1882-1919`) and in-memory illusions for Claude (`CA:4636-4651`) and Cursor
(`CursorAdapter.ts:1128-1141`, a literal `ctx.turns.splice`). A caller holding a `ProviderAdapterShape`
cannot tell whether a rollback reached the provider. That is the single worst leak in the interface:
the type says "supported", the behavior says "sometimes cosmetic".

**Three legs are welded onto one record.** `ProviderInstance` requires `snapshot`, `adapter` **and**
`textGeneration` (`PD:71-73`), all non-optional. A driver that only runs sessions must still ship a
commit-message generator and a health-probe/model-catalog snapshot. And `TextGenerationProvider` is a
**closed** union `"codex" | "claudeAgent" | "cursor" | "grok" | "opencode"`
(`apps/server/src/textGeneration/TextGeneration.ts:11`), directly contradicting the open-slug
`ProviderDriverKind` invariant the contracts layer goes to lengths to preserve.

**Binary path resolution is a no-op on POSIX.** Both `resolveClaudeSdkExecutablePath`
(`Drivers/ClaudeExecutable.ts:64-66`) and the generic `resolveSpawnCommand` (`packages/shared/src/shell.ts:645-647`)
return the configured string unchanged off Windows. Default is the bare name (`"claude"`, `"codex"` —
`settings.ts:364,423`), so on macOS/Linux resolution is entirely the OS PATH of the server process.
There is no version pinning, no "which claude did we actually run" recorded on the session. All the
resolution logic is Windows shim-chasing.

**Per-account isolation is opt-in and fails open.** For Claude the sole isolation mechanism is
`CLAUDE_CONFIG_DIR` from `ClaudeSettings.homePath` (`Drivers/ClaudeHome.ts:22-33`); `HOME` is
deliberately not touched because that breaks the macOS keychain OAuth lookup (`:27-32`). When
`homePath` is empty, `makeClaudeEnvironment` returns `resolvedBaseEnv` **by reference** (`:21,23`) —
which is `process.env` itself — and `resolveClaudeHomePath` falls back to `NodeOS.homedir()` (`:14`),
so `makeClaudeContinuationGroupKey` yields the identical `claude:home:<homedir>` for both instances
(`:37-42`). Two "separate" Claude accounts silently collapse into one continuation group sharing
`~/.claude`. Codex is worse: `continuationKey` is `codex:home:${sharedHomePath}` in **both** modes
(`Drivers/CodexHomeLayout.ts:55` and `:64`, verified) — it ignores `shadowHomePath` entirely, so the
personal-vs-work separation the shadow-home feature exists to provide does not reach the identity key.
And in `authOverlay` mode only `auth.json` and `models_cache.json` stay private (`:32`); `sessions`,
`archived_sessions`, **`sqlite`**, `shell_snapshots`, `worktrees`, `skills`, `plugins`, `cache`, `logs`
and `mcp-oauth-locks` are symlinked to the shared home (`:19-30`, linked `:394-408`). Two accounts
write one state DB and one OAuth lock dir.

**One genuine module-global in the session path.** `apps/server/src/mcp/McpProviderSession.ts:12` is a
module-level `Map<ThreadId, McpProviderSessionConfig>` (verified). The value carries
`providerInstanceId` (`:7`) but the **key does not, and the read does not check it** (`:18`), so
whichever instance asks for a threadId gets that thread's MCP endpoint and bearer token — injected into
the child's env at `CX:1707` and into `queryOptions.mcpServers` at `CA:4294,4330-4342`.

**Approvals never time out, on either provider.** No timeout on the Claude park (`[asserted]`: grep for
`timeout`/`Schedule` in `CA` returns only a prose comment at `:3678`) and none on the Codex park
(`CSR:1959-1967`). The only escapes are an explicit answer, an SDK abort signal (`CA:4167-4177`), or
session teardown (`CA:3714-3732`, `CSR:1392-1412`). A separate `ProviderSessionReaper` sweeps sessions
idle for 30 min every 5 min (`Layers/ProviderSessionReaper.ts:17-18`), which is the only backstop.

**Neither provider implements `acceptAlways`.** It is in the contract (`orchestration.ts:140-147`),
Codex downgrades it to `acceptForSession` (`CSR:1968-1970`), Claude falls through to deny (`CA:4212`).

**SDK drift is handled by the type checker, not by the runtime.** `"@anthropic-ai/claude-agent-sdk": "^0.3.170"`
(`apps/server/package.json:25`) is a caret on a 0.x package, so 0.3.x minors float in unpinned. The real
guard is `message satisfies never` exhaustiveness at `CA:3598` and `CA:3468` — a new SDK message type
breaks the build. At runtime an unknown message becomes a `runtime.warning` (`CA:3600-3603`), and there
is a hand-maintained allowlist of undeclared-but-real wire subtypes consumed silently (`CA:3114-3129`),
which is the tell that they are chasing an unstable surface. **Nothing asserts the SDK package version
at runtime**; the only version check is shelling `claude --version` (`Layers/ClaudeProvider.ts:427-429`)
for upgrade advisories, behind a 5-minute TTL cache (`Drivers/ClaudeDriver.ts:63,166-173`).

**What they persist per canonical event.** Ingestion (`orchestration/Layers/ProviderRuntimeIngestion.ts`,
2,110 lines) **drops every `content.delta` whose `streamKind` is not `assistant_text`** before doing
anything else (`:1502-1504`) — reasoning, command output and file-change output deltas are never
persisted at all, only streamed. Assistant text is then gated on `AssistantDeliveryMode`: `buffered`
unless `enableLegacyTokenStreaming` is set (`:1699-1702`), and that setting **defaults to `false`**
(`packages/contracts/src/settings.ts:659-661`), so buffered is the shipping default. Buffered deltas
accumulate in an Effect `Cache` (capacity 20,000, TTL 120 min — `:96-97,912-913`) and only spill a
`thread.message.assistant.delta` command when the buffer exceeds `MAX_BUFFERED_ASSISTANT_CHARS = 24_000`
(`:102,1089-1097,1704-1707`). That is the actual shape of the #5110 fix: **one DB write per 24 kB of
assistant text instead of one per token**, with a bounded in-memory cache in front.

**Dead code accumulating in the SPI's seams** — a smell worth watching in our own: `PromptQueueItem`'s
`"terminate"` arm is never constructed (`CA:120-127` vs the only offer site `:4612-4614`);
`PendingApproval.jsonRpcId` is written three times and never read (`CSR:1929,1987,2055`, `[asserted]`
grep); six `CanonicalRequestType` arms are unreachable because no handler is registered for them
(`CX:298-321` vs `CSR:1918,1974,2032,2097` + `handleUnknownServerRequest` `:2147-2149`, verified);
`CX:931`'s `session/started` branch is unreachable; `Layers/ClaudeCapabilitiesProbe.test.ts` tests code
that lives in `ClaudeProvider.ts` and has no matching module; `mcp.status.updated` is a canonical event
nobody emits; and adapter factories still default `instanceId` to the driver kind (`CA:1679`, `CX:1649`),
a migration shim that keeps the old one-instance-per-kind assumption alive in the type system.

---

## 6. Copy / adapt / reject

| # | t3code decision | verdict | why |
|---|---|---|---|
| 1 | `ProviderDriver` as a **plain-value record**, not an Effect service / DI tag (`PD:1-23,119-157`) | **copy** | This is the whole reason we read the repo. Tags are singleton-per-runtime; a record lets N instances of one driver coexist. Their module doc states the rationale better than we would. |
| 2 | `create(input) -> Effect<ProviderInstance, E, R \| Scope>`, all per-instance state owned by the scope (`PD:150-157`) | **copy** | Scope-per-instance gives independent teardown for free. `reconcile` diffing config maps and rebuilding only changed instances (`ProviderInstanceRegistryLive.ts:24-31`) falls straight out of it. |
| 3 | Split `driverKind` (open branded slug) from `instanceId` (routing key) (`providerInstance.ts:70,82`) | **copy** | Two Claude accounts need two ids that are not the driver name. Making `driverKind` an open slug that parses-then-degrades (`:16-28`) is what makes rollbacks and forks safe. |
| 4 | Registry decodes the opaque config envelope once via `configSchema`; decode failure ⇒ an "unavailable" shadow snapshot, never a crash (`PD:122-139`, `ProviderInstanceRegistryLive.ts:7-20`) | **copy** | Drivers never touch `unknown`. A bad config degrades one provider row instead of failing boot. |
| 5 | Approval as a **Deferred park** keyed by a locally-minted `ApprovalRequestId`, resolved by `respondToRequest`, fanned to `"cancel"` on teardown (`CA:4123-4184,3714-3732`; `CSR:1920-1967,2417-2445,1392-1412`) | **copy** | Two teams arrived at the identical mechanism over an in-process callback and an out-of-process JSON-RPC request. Mint our own id rather than reusing the tool-use id or the RPC id. |
| 6 | Per-instance env threaded as **values**; zero `process.env.X =` anywhere in the server (`ProviderInstanceEnvironment.ts:11-15`; grep = 0 hits) | **copy** | Non-negotiable for two accounts in one process. |
| 7 | `CLAUDE_CONFIG_DIR` (not `HOME`) for per-account isolation, with the keychain rationale recorded in-comment (`ClaudeHome.ts:27-33`) | **copy** | A hard-won fact. Overriding `HOME` breaks macOS OAuth. |
| 8 | Capability probe = a `query()` whose prompt generator never yields, read via `initializationResult()` (`ClaudeProvider.ts:315-356`, options `:175-209`) | **copy** | The cleanest "which account am I?" probe available: account email, subscription type, token source, slash commands, and no API call. Steal the option set too — `disableAllHooks`, `allowedTools:[]`, `strictMcpConfig`, `persistSession:false`. |
| 9 | Exhaustiveness `message satisfies never` on the SDK message switch (`CA:3598,3468`) | **copy** | Makes SDK drift a build break instead of silent data loss. Pair it with the `runtime.warning` fallback. |
| 10 | Buffered assistant persistence: drop non-`assistant_text` deltas at ingestion, spill one write per 24 kB (`ProviderRuntimeIngestion.ts:1502,102,1089-1097`) | **copy** | The fix for their own worst bug, already landed and defaulted on (`settings.ts:659-661`). Start here rather than rediscovering it. |
| 11 | Windows shim-chasing for the binary (`ClaudeExecutable.ts:61-89`, `shell.ts:639-668`) | **copy** (if we ship Windows) | The SDK spawns without a shell and without PATHEXT; bare `claude` and npm `.cmd` shims both fail. Otherwise defer. |
| 12 | `ProviderAdapterShape` as the per-session SPI (`PA:47-135`) | **adapt** | The 13-method shape is roughly right, but drop or re-model `readThread`/`rollbackThread` (see #16) and make `capabilities` earn its place (see #17). Keep `streamEvents` as the single output channel. |
| 13 | Canonical event union (`PR:1144-1197`) | **adapt** | Copy the envelope (`eventId`, `provider`, `instanceId`, `threadId`, `turnId?`, `itemId?`, `requestId?`, `providerRefs?`, `raw?` — `PR:252-267`) and the ~15-event shared core. Reject the other 34: half the vocabulary is one provider's protocol in a shared contract, and 24 types have exactly one emitter. |
| 14 | `raw: {source, method?, messageType?, payload}` on every event (`PR:34-39`) | **adapt** | Keeping the untranslated wire payload is right for debugging and for surviving drift. Bound it — theirs is `Schema.Unknown` with no size cap, and it rides into the log/persistence path. |
| 15 | One `PubSub.unbounded` fanning in every instance (`ProviderService.ts:234`) | **reject** | No backpressure, no drop policy, no per-thread budget — the mechanical cause of cross-session interference. Use a bounded per-instance queue with an explicit drop policy for deltas, or fan out per subscriber. |
| 16 | `readThread` / `rollbackThread` with the same signature but per-provider semantics (`CX:1882-1919` real RPC vs `CA:4636-4651` in-memory splice) | **reject** | Either the operation crosses to the provider or it does not. If we need both, they are two differently-named methods, or one method returning "who performed this". |
| 17 | `capabilities: {sessionModelSwitch}` with an uninhabited `"unsupported"` arm (`PA:28-35`) | **reject as-is; adapt the idea** | Don't ship a capability until two providers actually disagree on it. When one does, make the caller handle both arms — dead branches (`ProviderCommandReactor.ts:717,818`) are how the abstraction rots. |
| 18 | `ProviderInstance` welding `snapshot` + `adapter` + `textGeneration` into one required record (`PD:71-73`) | **reject** | Health-probing, session driving and commit-message generation are three lifetimes and three failure modes. Make the extra legs optional, or resolve them from separate registries keyed by `instanceId`. |
| 19 | `resumeCursor: Schema.Unknown` on three contract types (`provider.ts:45,61,84`) | **reject** | It hides two identities (our thread id, the provider's session id) behind an untyped hole that each adapter re-narrows at every read (`CX:1695`, `CSR:487-491`). Make the cursor a per-driver typed associated type, or a tagged union. |
| 20 | `ProviderThreadSnapshot.items: ReadonlyArray<unknown>` (`PA:39`) | **reject** | Erases a fully typed Codex item union at the boundary (`CX:1890-1893`). If the shared type cannot carry it, the method does not belong on the shared interface. |
| 21 | `CanonicalItemType` derived by **substring sniffing** on the provider's type string (`CX:210-240`) | **reject** | A new provider item type silently becomes `"unknown"` and is dropped (`CX:479-481`). Use an explicit table so an unmapped type is a loud warning. |
| 22 | Two sources of truth for the event-type set — a literal list (48) and the union (49), already drifted on `tool.denied` (`PR:150-199` vs `:1144-1197`) | **reject** | Derive the literal list from the union, or drop it. |
| 23 | `continuationKey` that ignores the per-account home (`CodexHomeLayout.ts:55,64`; `ClaudeHome.ts:37-42` when `homePath` is empty) | **reject** | Two accounts collapse into one identity — exactly the failure our design exists to avoid. Our per-account key must be derived from the credential/home actually in use, and must fail loudly when two instances resolve to the same one. |
| 24 | Module-global `Map<ThreadId, …>` for the MCP session (`McpProviderSession.ts:12,18`) | **reject** | Key does not include the instance; the read does not check it. Any shared table on the session path gets `(instanceId, threadId)` as its key. |
| 25 | Approvals with no timeout on either provider (`CA:4184`, `CSR:1959-1967`) | **reject** | A parked `Deferred` with no deadline is a wedged turn. Attach a deadline that resolves to `decline` and emits `request.resolved`. |
| 26 | `acceptAlways` in the contract, implemented by nobody (`orchestration.ts:140-147`; `CSR:1968-1970`, `CA:4212`) | **reject** | Do not ship a decision the adapters silently reinterpret. Either implement it or leave it out. |
| 27 | Adapter factories defaulting `instanceId` to the driver kind (`CA:1679`, `CX:1649`) | **reject** | A migration shim that preserves the one-instance-per-kind assumption inside the new multi-instance design. Make `instanceId` required from day one — we have no legacy to carry. |
| 28 | One shared rotating NDJSON log store for all instances of a kind (`ProviderEventLoggers.ts:14-18`) | **adapt** | Their reason (rotation races) is real. Prefer one file per instance with per-file rotation; if that is too costly, copy their tag and record the trade-off as they did. |

---

## Not checked

- Nothing was built, run, typechecked or benchmarked; this is a read of source at one SHA.
- The per-adapter canonical-event counts in §4 are a **regex count** of literal `type: "..."` sites in
  non-test sources. Events constructed through helpers with a computed `type` would be missed, so treat
  the counts as a floor and the "single-provider" lists as approximate.
- Not read: `GrokAdapter.ts`, `OpenCodeAdapter.ts`, `opencodeRuntime.ts` and `OpenCodeServerOwner.ts`
  beyond greps; `provider/acp/AcpSessionRuntime.ts` internals; `packages/effect-codex-app-server`
  generated client beyond `protocol.ts` and `_internal/stdio.ts`; the client-runtime consumer of these
  events; every `*.test.ts`.
- Not established: whether the unbounded fan-in PubSub (`ProviderService.ts:234`) is in fact what
  #5681 reports — the mechanism is consistent with the symptom, but no issue thread or profile was read.
- Not established: whether `homePath` is populated by default in any shipped settings path, i.e. how
  often the shared-`~/.claude` collapse actually bites in practice.
- `[asserted]` items in §2 and §5 (no `timeout`/`Schedule` in `ClaudeAdapter.ts`; `jsonRpcId` never read)
  come from subagent greps that were not independently re-run.
