# Thread render path — brigadier tree survey (2026-09-10, main @ 61e8576)

> **STALE — read this warning before anything else.** This survey was taken at `main` @ `61e8576` on
> 2026-09-10. `main` has since moved to `ea8d705` through a design-system migration: icons were vendored
> (Tailwind/lucide/`@phosphor-icons` usage replaced by `src/icons/`), the app went dark-only (the light theme
> was removed), generic UI controls (buttons, menus, dialogs) moved to assistant-ui's design kit on Base UI,
> a Codex-styled sidebar landed, and a Button codemod ran across the tree. **Anything below about specific
> components, controls, icons or CSS classes is stale and must be re-verified against the current tree
> before being relied on.** The facts about data flow (§1's Rust→IPC→store diagram), the event/row-kind
> unions (§2), and the store's behaviour (`feedStore.ts`) are architectural and more likely to still hold,
> but were not re-checked at `ea8d705` either.

A survey of brigadier's own thread-rendering code, read directly off the tree: file inventory, data flow,
row-kind coverage, assistant-ui usage, the composer boundary, performance constraints, and the tests that
pin current behaviour. Gathered 2026-09-10 by reading the source directly. No file in the repo was modified.

**Authority.** This file is authoritative for what `main` @ `61e8576` contained: which files render the
thread, how a `FeedRowWire`/`ChatItem` becomes a `ThreadRow`, which row kinds are rendered vs. dropped, which
of assistant-ui's "Elements" are actually wired to a runtime, the measured paint/frame numbers at that
commit, and the tests that pin thread behaviour. It is explicitly **not** authoritative for the tree's
current state — see the staleness warning above — and it is not authoritative for Codex's own row taxonomy
or pixel values; see `codex-thread-anatomy.md` and `codex-thread-tokens.md` for those. §9's row-kind gap list
is the input `codex-thread-row-mapping.md` builds its component picks against.

---

## 1. Thread render path today

### Files

| File | Lines | Purpose | Main exports |
|---|---|---|---|
| `src/App.tsx` | 1165 | App shell. Owns feed subscription (`:261 store.pushBatch`), approval rows, session selection. Mounts `<ThreadView>` at `:1091` with `requests={<Approvals …/>}` at `:1093`, and `<Dock>` (the composer) at `:1116`, both inside `<ProjectWorkbench>` `:1044`. | `App` |
| `src/components/ThreadView.tsx` | 608 | **The thread.** `ThreadView` `:60` picks `Transcript` `:199` or `NewConversation` `:108`. `Transcript` does all the work: history hook, projection, approval matching, virtualization, row switch `:394-457`, and `UserMessage` `:509`. | `ThreadView` |
| `src/hooks/useConversationHistory.ts` | 107 | Fetches the transcript. `workspaceApi.historyPage` + `workspaceApi.chatTurns` over IPC, debounced 100 ms/80 ms (`:36-39`), retriggered by `store.getSessionCursor` changes `:95-98` and by the `conversation-state-changed` Tauri event `:99`. | `useConversationHistory`, `getHistoryDelivery` |
| `src/conversationHistory.ts` | 13 | `mergeHistory` only: id-keyed merge, `HISTORY_WINDOW = 600` cap `:3`. | `HISTORY_WINDOW`, `mergeHistory` |
| `src/threadProjection.ts` | 323 | Pure projection `ChatItem[] → ThreadRow[]`. Turn flushing, tool-call/result pairing, subagent folding by `task_id`, activity labels, duration formatting. | `ThreadRow`, `TraceNode`, `projectThread` `:89`, `flattenTrace` `:78`, `traceLabel` `:34`, `isAgent` `:25`, `traceFailed` `:81`, `workDuration` `:249`, `activitySummary` `:283`, `activeWorkLabel` `:310` |
| `src/components/WorkTrace.tsx` | 417 | Renders a `type:"work"` row: the "Worked for 3m" collapsible heading `:89`, `TraceList` `:154` (adjacent-tool batching `:161-170`), `TraceBatch` `:220`, `TraceEntry` `:241`, `conciseAction` `:370`, `ActivityIcon` `:403`. Caps at 40 groups with a "Show more activity" button `:171`. | `WorkTrace` |
| `src/components/TranscriptRuntime.tsx` | 31 | assistant-ui runtime shim. `useExternalStoreRuntime` `:14` for writable sessions; `ReadonlyThreadProvider` `:10` for peer/subagent views. | `TranscriptRuntime` |
| `src/components/assistant-ui/elements/thread.tsx` | 65 | Viewport adapter: `ThreadPrimitive.Root/Viewport/ViewportFooter/ScrollToBottom` `:22-49`, plus a hand-rolled `ReadonlyViewport` `:57` for the read-only case. | `Thread` |
| `src/components/Approvals.tsx` | 327 | Approval cards + `ApprovalResolution` `:317` (the resolved/Expired receipt). | `Approvals`, `ApprovalResolution`, `ApprovalRow`, `ApprovalsProps` |
| `src/components/approvalHistory.ts` | 31 | `useApprovalHistory` — `composer_approval_history` IPC, refetched on the `brigadier-approval-response` window event `:27`. | `useApprovalHistory`, `approvalHistoryApi`, `ApprovalHistoryItem` |
| `src/components/Markdown.tsx` / `MarkdownContent.tsx` | 61 / 63 | `Markdown` lazy-loads a **286 KB chunk** (`Markdown.tsx:36-45`) that wraps assistant-ui's `MarkdownText` in `TextMessagePartProvider`. | `Markdown`, `CopyButton` / default `memo(MarkdownContent)` |
| `src/feedStore.ts` | 966 | The event store. Ring buffers of `FeedRowWire` (`ROW_CAP = 2000` `:82`), `SessionRuntime` per session `:129`, `ApprovalItem[]` `:163`, rAF-drained `useSyncExternalStore` snapshot. | `pushBatch`, `subscribe`, `getState`, `getSessionCursor`, `getSessionRows`, `seedApprovals`, `dismissApproval`, … |
| `src/feedGroups.ts` | 287 | Fold/tone logic for the **activity-feed pane**. | `buildFeed` `:230`, `isFailure` `:126`, `FeedLine`, `FeedView`, `FeedTone` |
| `src/components/Feed.tsx` | 483 | The virtualized activity-feed pane. | `Feed` |

**`Feed.tsx` and `feedGroups.ts` are dead in the app.** The only importer of `Feed` is its own test (`src/components/Feed.test.tsx:156`, a dynamic `import("./Feed")`); `src/feedStore.ts:32` says so in a comment ("`Feed.tsx` is the only real consumer and has no non-test importer"), and `docs/research/native-performance-timing-2026-09-09.md:100` records it as measured. ~770 lines plus 44 tests pin a surface nobody sees.

### Data flow

```
Rust  Envelope{seq,at,session_id,event:Event}  (crates/core/src/event.rs)
  │
  ├─ FeedBatch{rows:FeedRowWire[], signals:Envelope[], counters} ── Tauri channel
  │     └─ src/App.tsx:261  store.pushBatch
  │           └─ src/feedStore.ts  applyBatch:474 / applySignal:369  → ring buffers + SessionRuntime
  │                 ├─ rebuildState:545 → drain:574 (rAF) → notify:637
  │                 │     └─ useSyncExternalStore  → App, Transcript (ThreadView.tsx:229), Composer, Sidebar
  │                 └─ getSessionCursor:689  ← the live, un-throttled token
  │                       └─ useConversationHistory.ts:95  subscribe → schedule(100ms)
  │
  └─ SQLite chat_items / chat_turns  (crates/store/src/chat.rs:114, :9)
        └─ IPC  conversation_history_page + chat_turns   (workspaceApi.ts:105, :113)
              └─ useConversationHistory  → mergeHistory (600-item window)
                    → items: ChatItem[],  turns: ChatTurn[]
                          └─ projectThread(items, busy, turns, lastStop)   ThreadView.tsx:269
                                → ThreadRow[]
                                    ├─ virtualizer (rows>60 && no pending approvals)  ThreadView.tsx:307-311
                                    └─ row switch ThreadView.tsx:394
                                          ├─ "work"        → <WorkTrace>
                                          ├─ "message"/user→ <UserMessage> + ProviderChangeDivider + date label
                                          └─ "message"/asst→ <ChatPanelAssistantMessage><Markdown> + <ChangedFilesCard>
```

Two independent transports feed one screen: the **feed channel** (bounded one-line rows + signals) only tells the thread *when* to refetch; the **transcript bodies** come from a separate SQLite-backed IPC page. There is no push path for message bodies.

---

## 2. Row kinds

### The projection's row union — `src/threadProjection.ts:9-23`

```ts
export type ThreadRow =
  | { type: "message"; id: string; item: ChatItem; final?: boolean }
  | { type: "work"; id: string; nodes: TraceNode[]; running: boolean; canCollapse: boolean;
      failures: number; count: number; status: ChatTurn["status"] | "unknown";
      startedAt?: number; latestProgress?: ChatItem; durationMs?: number };
```

Two row types. Everything else is a nested `TraceNode` (`:3-8`) inside a `work` row.

### The underlying item union — `src/wire.ts:58-69`

```ts
export type ItemKind =
  | { type: "assistant-text" }
  | { type: "thinking" }
  | { type: "tool-call"; name: string }
  | { type: "tool-result"; tool_call_id: string; is_error: boolean }
  | { type: "user-text" }
  | { type: "subagent"; task_id: string; subagent_type: string | null; description: string | null };
```

Six kinds. Mirrored in Rust at `crates/core/src/event.rs`; persisted as `ChatItem` (`crates/store/src/chat.rs:114`).

### The feed-pane union (separate, currently unrendered) — `src/wire.ts:193-204`

`"turn" | "tool" | "text" | "think" | "user" | "sub" | "appr" | "warn" | "err" | "sys" | "unknown"`. Closed set, pinned on the Rust side (`crates/store/tests/feed.rs::kind_is_pinned_for_every_variant`); `unknown` must never be filtered or restyled (10,037 pre-migration rows — `wire.ts:186-191`).

### What is rendered vs dropped

| Concept | Where it comes from | How it appears | Dropped? |
|---|---|---|---|
| user text | `user-text` with no `parent_id` | Own `message` row; flushes the open turn (`threadProjection.ts:231-235`). Right-aligned bubble, 5-line clamp over 480 chars/8 lines (`ThreadView.tsx:543`), time + copy + edit. | rendered |
| assistant answer | trailing `assistant-text` at root with no children, only when `!running` (`:174-178`) | Merged into one `message` row, bodies joined with `\n\n` (`:216-222`), `final` set when not interrupted. | rendered |
| assistant progress prose | same kind, mid-turn | Folded into the `work` row as a `TraceNode`; empty bodies dropped (`:171`). | folded |
| thinking | `thinking` | `ReasoningPanel` inside the trace (`WorkTrace.tsx:266`). **Empty-bodied thinking nodes are deleted and replaced by their children** (`threadProjection.ts:162-164`). | partly dropped |
| tool_use / tool_result | `tool-call` + `tool-result` | Paired: the result is attached as `node.result` and its own node is suppressed (`:122-135`). One `ToolCall` disclosure with request/result. Adjacent independent childless calls batch into one row (`WorkTrace.tsx:161-170`). | result row dropped by design |
| tool failure | `tool-result.is_error` | `traceFailed` `:81`; counted into `row.failures`, shown as "· N failures" in the heading (`WorkTrace.tsx:99-104`). | rendered |
| subagents | `subagent{task_id}` **or** `tool-call` named `agent`/`task`/`mcp__brigadier__create_session` (`isAgent` `:25-33`) | All items sharing a `task_id` fold into one node, extras become `node.updates` (`:106-115`); children nest by `parent_id` with cycle detection `:140-156`. Label from `description`/`title`. Icon `WorkflowIcon`. | rendered |
| turn boundaries | `ChatTurn{start_seq,end_seq,started_at,ended_at,status}` from `chat_turns` IPC | Drive `row.status`, `startedAt`, `durationMs`; a turn change mid-stream forces a flush (`:237-240`). Rendered as "Worked for 3m 12s" / "Failed" / "You stopped" (`WorkTrace.tsx:80-89`). | rendered |
| stop reason | `session.lastStop` from `turn-completed` | `stopLabel` `ThreadView.tsx:492`; a `.turn-state` div after the last row, only when not `end-turn` (`:481-483`). | rendered |
| approvals | `store.approvals` (pending) + `composer_approval_history` IPC (resolved) | **Never optimistic.** Pending cards are matched to the owning tool node by `kind.tool_call_id === node.item.id` (`ThreadView.tsx:292`) and injected right after that `ToolCall` (`WorkTrace.tsx:365`). Resolved ones render `ApprovalResolution`. Third state: `decision === null` → **"Expired"** (`Approvals.tsx:320-323`). Unmatched cards fall through to the bottom of the thread (`ThreadView.tsx:484-485`). | rendered |
| compaction | `Event{type:"session-compacted"}` | **Never reaches the thread.** Only `ItemStarted/Updated/Completed` become `ChatItem`s (`crates/store/src/chat.rs:135`). It sets `SessionRuntime.lastMessage = "context compacted (manual\|auto)"` (`feedStore.ts:437-439`), which the sidebar shows. | dropped from thread |
| runtime-error / runtime-warning | `Event` `:148-149` | Same: store-only (`feedStore.ts:443,452`), `lastMessage` + a `runtimeWarnings` counter. Not a thread row. | dropped from thread |
| session-exited | `Event` `:113` | Store-only (`exitCode`, `endedAtMs`). | dropped from thread |
| rate_limit_event | Decoded in Rust (`crates/claude-wire/src/message.rs:81`, `crates/core/src/claude/adapter.rs:614`, `crates/core/src/allowance.rs:141`) | **Not on the `Event` wire union at all.** It surfaces only as the composer's "Waiting for `<provider>` usage · resets …" line (`Composer.tsx:82`). No window gauge anywhere in `src/`. | not in thread |
| per-turn file changes | `desktopApi.changes(sessionId)`, polled every 3.5 s (`desktopApi.ts:129`) | `ChangedFilesCard` under a final answer row (`ThreadView.tsx:443-452`, `SessionReview.tsx:14`): "Edited N files +A −D". | rendered |
| provider change | `taskSettings` `settings.changes` | `ProviderChangeDivider` placed before a user message (`ThreadView.tsx:418`, `composer/providerChangePlacement.ts`). | rendered |
| peer / cross-session messages | `peerApi` | `PeerMessages`, `PeerIncomingMessage`, `PeerDeliveryReceipt`, `LinkedTaskCards` (`ThreadView.tsx:460`, `WorkTrace.tsx:144-149`). | rendered |
| task progress | `task_checkpoint` IPC + `task-checkpoint` event | `TaskProgress` — a `<details>` todo list pinned above the rows (`TaskProgress.tsx:20`). | rendered |

---

## 3. assistant-ui usage

`package.json:15-17`: `@assistant-ui/react` **0.15.18** (pinned), `@assistant-ui/react-lexical` **0.2.12** (pinned), `@assistant-ui/react-markdown` **^0.14.14**. Installed: `node_modules/@assistant-ui/{core,react,react-lexical,react-markdown,store,tap}`.

Every import site (grep `@assistant-ui`, 5 files in `src/`):

| Import | Site |
|---|---|
| `AssistantRuntimeProvider`, `ReadonlyThreadProvider`, `AuiProvider`, `AuiConfig`, `useExternalStoreRuntime`, `ThreadMessage`, `ThreadMessageLike` | `src/components/TranscriptRuntime.tsx:2` |
| `ThreadPrimitive` | `src/components/assistant-ui/elements/thread.tsx:3` |
| `TextMessagePartProvider` | `src/components/MarkdownContent.tsx:4` |
| `ThreadMessageLike` (type) | `src/components/ThreadView.tsx:16` |
| `useAui` | `src/components/TranscriptRuntime.test.tsx:3` |
| `MarkdownTextPrimitive` etc. from `@assistant-ui/react-markdown` | `src/components/assistant-ui/elements/markdown-text.tsx:11`, `syntax-highlighter.tsx:5` |
| `$createDirectiveNode`, `DirectiveNode`, `DirectiveChipProvider` from `@assistant-ui/react-lexical` | `src/components/composer/RichPromptEditor.tsx:22` |

**Yes, there is an ExternalStoreRuntime adapter** — `TranscriptRuntime.tsx:14`, fed a `ThreadMessageLike[]` built in `ThreadView.tsx:314-326` that carries **only** `id`, `role` and the message text; every `work` row is projected to `content: []`. So the runtime knows nothing about tools, approvals or activity.

**The thread is not rendered via `MessagePrimitive`.** Only `ThreadPrimitive.Root/Viewport/ViewportFooter/ScrollToBottom` are used, purely for scroll behaviour (`elements/thread.tsx:22-49`); the header comment says so: *"The runtime owns only viewport behavior… so its synthetic startup message cannot enter our renderer"* (`ThreadView.tsx:312-313`). The rows themselves are hand-written JSX inside `ThreadView.tsx:394-457`.

**assistant-ui "Elements" are vendored, not installed** — 23 files in `src/components/assistant-ui/elements/` (~1,000 lines total), header: *"Installed from assistant-ui Elements (MIT); Brigadier theme and integration extensions"* (`chat-panel.tsx:1`). Several are stubs: `agent-handoff.tsx` 7 lines, `todo-list.tsx` 8, `recommendation-card.tsx` 8, `subagent-list.tsx` 13, `background-inbox.tsx` 13, `checkpoint-history.tsx` 12. The real ones: `markdown-text.tsx` 275, `message-actions.tsx` 138, `chat-panel.tsx` 131, `tool-call.tsx` 126, `reasoning-panel.tsx` 104, `syntax-highlighter.tsx` 91 (Shiki).

**Smoking gun for "looks awful":** `ChatPanel` is a *small chat widget* — `h-[270px] w-full max-w-md rounded-[24px]` (`chat-panel.tsx:15`) — and `thread.tsx:23` overrides it with `h-auto min-h-0 min-w-0 max-w-none flex-1 rounded-none border-0`. `ChatPanelAssistantMessage` is `text-xs max-w-[85%] text-text/70` (`chat-panel.tsx:64`) and `ThreadView.tsx:438` overrides it with `w-full max-w-none text-sm text-text`. Every class in the base element is fought by a class at the call site.

**No Base UI dependency.** `node_modules/@base-ui-components` does not exist; nothing in `package.json` mentions Base UI. Design-library controls today are `radix-ui@^1.6.7` (monolith) hand-wrapped in `src/components/controls/*` (29 files) plus a one-file `src/components/ui/collapsible.tsx`. Icons are split three ways: `lucide-react@^1.42.0`, `@phosphor-icons/react@^2.1.10`, and hand-drawn `src/components/icons.tsx`/`NavigationIcons.tsx`. Markdown deps: `react-markdown@^10.1.0`, `remark-gfm`, `remark-breaks`, `shiki@^4.4.3`.

---

## 4. Composer

`src/components/Dock.tsx` (89 lines) is the host: `NewSession` before a session exists `:62`, `Composer` after `:71`.

`src/components/Composer.tsx` (179 lines) is the composer proper — durable queue, Stop/Continue, slash commands, permission and provider/model/effort controls, an "Approval needed · View action ↑" strip `:145`. It uses `composerApi` (durable Rust queue), `useDurableComposer`, `useTaskExecutionSettings`, `useProviderCatalog`, `feedStore` (for the pending-approval strip), and `EditMessage`.

`src/components/PromptInput.tsx` (200) wraps `src/components/composer/RichPromptEditor.tsx` (15 KB), which **is Lexical-based**: `@lexical/react` `LexicalComposer`/`RichTextPlugin`/`HistoryPlugin`/`ListPlugin`/`MarkdownShortcutPlugin` (`:3-10`), `@lexical/{code,rich-text,list,link,markdown}` all pinned `0.49.0`, plus `DirectiveNode`/`DirectiveChipProvider` from `@assistant-ui/react-lexical:22`. `src/components/composer/editorSource.ts` serializes the editor state back to markdown.

**It is finished.** `docs/plans/composer-redesign-2026-09-09.md:3` — "approved by the owner on 2026-09-09". `docs/plans/composer-redesign-verification-2026-09-09.md` records delivery with all six gates green (`cargo test` 767, `npm test` 532/64 files, `tauri build` exit 0). Supporting parts under `src/components/composer/`: `ExecutionControls.tsx` (12.6 KB), `TaskSetupRail.tsx` (10.8 KB), `useDurableComposer.ts`, `useAttachmentImports.ts`, `AttachmentPreview.tsx`, `ProviderChangeDivider.tsx`, `composer.css` (17 KB). ~60 composer tests across 9 files.

**A thread rebuild should leave the composer alone.** It is a separate, recently-shipped subtree with its own CSS and tests; its only thread coupling is the approval-strip scroll-into-view (`Composer.tsx:145`) and `ChangedFilesCard`.

---

## 5. Performance constraints

**Paint budget.** B1 exec → painted shell: target **≤200 ms**, measured **287–295 ms p50, n=19** — ~90 ms over (`docs/research/perceived-performance.md:42`). Re-measured 2026-09-10: median **326.6 ms**, n=10, range 309.4–1184.1 (`docs/research/native-performance-timing-2026-09-09.md:78`). B4 click-session → last screenful painted: **32.5 ms p50, n=14**, budget ≤100 ms p95, "constant-work by construction" because of `TAIL_ROWS=48` (`perceived-performance.md:45`). Stage split: Tauri window creation 108.7 ms p50 warm, `state::build` 8.1 ms, page-load→FCP 83.3 ms of which fetch+parse 49.6 and React mount 28.5 (n=4 — the doc says do not plan against 28.5) (`perceived-performance.md:275-304`).

**Frame gate.** Every 1-second window must satisfy `dropped==0 && p95≤1.1×(1000/hz) && worst≤3×(1000/hz)` (`docs/research/feed-rendering.md:522-527`). 2026-09-04 debug run: 62/62 windows at hz 60, p50 17.0 ms, but **4 dropped vsyncs** in one window and `windowPasses` failed **1 of 62**; a no-ingest control passed 65/66 — **the drops come from ingest, not scroll** (`docs/STATUS.md:362-371`).

**The current thread fails the gate.** 2026-09-10 release burn, 10 sessions × 200 ev/s × 60 s, against `ThreadView`→`Transcript`: **2,499 missed 60 Hz opportunities**, worst/p95 **105 ms**, DOM nodes 1,299→1,562 — *"a rendering failure with an independently fixed budget"* (`docs/research/native-performance-timing-2026-09-09.md:98`).

**Virtualization.** `@tanstack/react-virtual` pinned `3.14.10` (`package.json:35`), chosen in `docs/research/feed-rendering.md:582-588` for `anchorTo:'end'` tail-follow. Live in the thread at `ThreadView.tsx:308-311` — but **conditionally**: `const virtualized = rows.length > 60 && !hasApprovals` (`:307`). Any open approval un-virtualizes the whole transcript. `estimateSize: () => 140` for rows whose real heights range from a one-line tool call to a full markdown answer. The other virtualized list, `Feed.tsx:282`, is not mounted by the app.

**Bottleneck — measured vs asserted.** Measured: the 2,499-frame failure above. Measured-but-not-reproduced: "3,655 store rebuilds, 6,628 App renders, 2,853 `readPersistence` calls", carried from a parent diagnostic and not re-run (`docs/research/native-react-profiling-2026-09-10.md:146`). **Asserted** (source-read, never profiled): broad signal-driven React updates — `feedStore.patch` replaces the whole session snapshot; `App` and `Transcript` both subscribe to the entire snapshot; `Sidebar`/`Dock`/`ThreadView` are not memoized; `useAttention` touches `localStorage` synchronously (`native-performance-timing-2026-09-09.md:100-112`). **No React Profiler or `xctrace` run has ever been executed** — both 2026-09-10 docs say so explicitly (`native-react-profiling-2026-09-10.md:3`).

**Render-path landmines.**
- 8192-byte Tauri Channel cliff: an oversized message detours through `fetch` and head-of-line-blocks every later one; batches capped at 24 rows (`feed-rendering.md:474-497`, `wire.ts:230`).
- WebKit 26.5 has **no `overflow-anchor`** — a head-drop must adjust `scrollTop` manually before paint (`feed-rendering.md:186-192`).
- `useSyncExternalStore` snapshots must be cached immutable references; a fresh object per `getSnapshot()` defeats the `Object.is` skip (`native-react-profiling-2026-09-10.md:142-144`). The tree already carries three hand-written guards for exactly this: `EMPTY_ITEMS`/`EMPTY_TURNS` (`useConversationHistory.ts:13-14`), `sameHistory` JSON compare (`approvalHistory.ts:16`), and the `JSON.stringify` diff in `useSessionChanges` (`desktopApi.ts:117-125`). All three exist because a fresh array re-rendered the whole mounted transcript.
- Tailwind's oxide scanner walks Markdown prose, not the module graph — naming a utility class in a doc ships it (`STATUS.md:688-697`).
- Contrast is a property of a *pair*: 48 pairs were swept and six new failures found (`STATUS.md:707-713`).
- Every burn number in the docs is a **debug** build unless `VITE_BURN=1` release was run — none has been (`STATUS.md:529-544`).
- `dom_nodes` counts the whole document, not the thread (`STATUS.md:373-377`).
- jsdom 30.0.1 has no `PerformanceObserver` and no `matchMedia`; a paint test written against the real observer passes vacuously (`STATUS.md:703-706`).

---

## 6. Tests that pin thread behaviour

**Pure logic — survives any visual rebuild untouched:**

| File | Tests | Pins |
|---|---|---|
| `src/threadProjection.test.ts` | 16 | `projectThread`: folds progress + tool output under one parent while the final answer stays a row (`:38-57`); row ids stable across streaming→completion (`:199-207`); duration derived from recorded turns (`:209-262`). |
| `src/conversationHistory.test.ts` | 3 | `mergeHistory`: streaming ids replaced not duplicated, stale updates ignored, window bounded (`:5-14`). |
| `src/feedStore.test.ts` | 47 | Store only — header says "never markup… does not move in the frontend rewrite". No `render` anywhere. |
| `src/feedGroups.test.ts` | 18 | `buildFeed`: a failed result keeps `tone:"bad"` and never folds (`:95-119`); an unanswered approval never folds (`:133-147`). **Pins the dead feed pane.** |
| `src/components/composer/{attachmentImports,providerChangePlacement}.test.ts` | 4 | Pure. |
| `src/paint.test.ts` (38), `renderDiagnostics.test.ts` (1), `perfDiagnostics.test.ts` (6) | 45 | Instrumentation, not DOM. |

**DOM-coupled — will need rewriting:**

| File | Tests | Pins / coupling |
|---|---|---|
| `src/components/ThreadView.test.tsx` | 18 | Heaviest. Folds intermediate prose into "Worked" while keeping edit/file actions and `data-message-id` order (`:108-147`); backward paging bounds mounted rows to <40 (`:385-399`); a pending approval renders as `approval-<id>` **immediately after** its `[data-trace-id]` tool call (`:418-432`); a collapsed ancestor expands so a nested pending approval stays reachable (`:457-468`); scroll restore reads the literal `.aui-viewport` class (`:490-507`). |
| `src/components/Approvals.test.tsx` | 7 | The three-state lifecycle: pending card survives until `request-resolved` (`:39-56`); `ApprovalResolution` folds only once `resolved` and keeps permission separate from execution success (`:58-67`); an expired receipt says neither Approved nor Denied (`:69-76`). |
| `src/components/approvalHistory.test.tsx` | 3 | `useApprovalHistory` does not re-render on an identical IPC result (`:23-30, 43-55`). |
| `src/components/WorkTrace.test.tsx` | 9 | Trace starts collapsed, failures stay discoverable, agent progress nests under its own `[data-trace-id]` (`:81-124`). Asserts on the literal icon class `.lucide-check` (`:175-182`) — breaks if lucide goes. |
| `src/components/TranscriptRuntime.test.tsx` | 2 | A read-only worker transcript rejects `composer().setText/send()` (`:18-30`). |
| `src/components/Feed.test.tsx` | 26 | Rows render `l` verbatim and never `q`; virtualizer keeps <200 mounted for 5,000 rows (`:273-281`); `unknown` rows survive every filter (`:409-422`). **All of it pins a component the app does not mount.** |
| `src/components/AgentElements.test.tsx` | 3 | `SessionCard`/`WorkerSummary`/`RecommendationCard`: background-results dropdown lists only completed sessions (`:11-22`). |
| `src/components/SubagentsPanel.test.tsx` | 5 | Nested worker conversations; read-marker vs live cursor (`:77-124`). Mocks `ThreadView` and `Composer`. |
| `src/components/RunCard.test.tsx` | 18 | "no gate" phases render no placeholder `<code>` (`:227-260`); `state:"unknown"` shows blocked, never in-progress (`:333-370`); **no dollar figure anywhere** (`:455-480`). |
| `src/components/peer/{PeerMessages,PeerAttachmentPreviews,PeerTaskCardScope}.test.tsx` | 10 | Peer bubbles, lazy attachments, one card/receipt per retry keyed on `[data-message-id]`/`[data-task-id]`. |
| `src/components/PromptInput.test.tsx` | 9 | Per-project draft isolation, IME-safe Enter, Markdown never renders `<script>` or `javascript:` (`:76-93`), large-paste staging. |
| `src/components/composer/*.test.tsx` | ~56 | queue (13), ExecutionControls (18), attachments (10), RichPromptEditor (9, asserts `.prompt-bold`/`.prompt-code-block`), TaskSetupRail (5), nativeAttachments (3, keys off `.composer-surface` + `getBoundingClientRect`). |
| `src/App.test.tsx` | 21 | `describe("the B4 paint span")` times painting the selected session's rows through the real shell (`:371-477`); nested cross-project approval routing (`:728-746`). |
| `src/App.run.test.tsx` | 4 | Automation history stays collapsed and out of chat (`:230-263`). |
| `src/components/assistant-ui/elements/syntax-highlighter.test.tsx` | 3 | Unknown-language and late-result fallbacks stay readable. |

Rough total in the blast radius: **~120 tests across ~20 files**, of which ~88 are behaviour-on-roles-and-text (survivable if the new UI keeps equivalent labels) and ~6 are hard class-name assertions.

---

## 7. The other worktree — `ui/design-system`

One commit ahead of main: **`af65dec` "Vendor Apps SDK UI icons, go dark-only, cancel the bb thread port"**. Diffstat: **159 files, +4,882 / −1,535**.

It also has **uncommitted work in progress right now** (`git status` in that worktree): modified `components.json`, `package.json`, `package-lock.json`, `index.html`, `src/index.css`, `src/components/controls/button.tsx`, `src/components/assistant-ui/elements/composer.tsx`; deleted `src/components/assistant-ui/elements/surfaces.tsx`; and **untracked new shadcn/Base UI components** — `src/components/ui/{button,input,badge,avatar,kbd,label,separator,skeleton}.tsx` plus `UPSTREAM.md`. That session is mid-flight on the control layer.

**Dependency changes** (`package.json`): removes `@phosphor-icons/react` and `lucide-react` from dependencies; adds `@openai/apps-sdk-ui@^0.2.2` as a **devDependency** — used only by the new `scripts/vendor-icons.mjs` (177 lines) to vendor **52 icon components into `src/icons/`** with a `manifest.json` and `LICENSE.md`. No Base UI in the committed `package.json`; the in-progress uncommitted work is adding `@base-ui/react` (both new research docs target `@base-ui/react@1.8.0`, not the retired `@base-ui-components/react`).

**Also on that branch:** the light theme is gone — `src/providers/ThemeProvider.tsx` and its test deleted, `src/main.tsx` sets a static `dark` root class, 31 lines removed from `src/index.css`.

**New research docs it carries** (none exist on `main`):
- `docs/research/codex-sidebar.md` (632 lines) — a token-exact extraction of Codex's dark UI from `/Applications/ChatGPT.app` (Electron 42.3.0, `openai-codex-electron` 26.903.61454), with the runtime-JS theme generator, semantic aliases, typography, radius/spacing, and a per-element table. **It covers the sidebar only** — §§4.1–4.10 are panel shell, top chrome, nav rows, project/thread rows, footer, tooltip, collapsed state. There is nothing in it about the conversation timeline, turn cards, or the composer. A "Codex-style thread" has no measured reference in this tree yet.
- `docs/research/assistant-ui-design.md` (549) — the assistant-ui design kit is **not published to npm** (`@assistant-ui/ui` is `private:true, version 0.0.0`); it is copy-paste source over `@base-ui/react@1.8.0`; the registry route in our `components.json` is stale (404).
- `docs/research/shadcn-base-ui.md` (585) — shadcn ships Base UI variants of the whole set at the same `@base-ui/react@1.8.0`, with an `iconLibrary` switch that can emit `@phosphor-icons/react` imports; `shadcn init` must never be run in this repo.
- `docs/research/apps-sdk-ui-icons.md` (634).

**Files it touches that a thread rebuild would also touch — direct write-conflict surface:** `src/components/ThreadView.tsx` (−/+20), `src/components/WorkTrace.tsx` (24), `src/components/Composer.tsx` (6), `src/components/PromptInput.tsx` (8), `src/components/Feed.tsx` (57), `src/components/SessionReview.tsx` (6), and all of `src/components/assistant-ui/elements/*` (thread, chat-panel, tool-call, reasoning-panel, markdown-text, message-actions, approval-card, artifact-card, agent-plan, agent-status, syntax-highlighter), plus `src/components/controls/*` and `src/index.css`. **Almost every file the thread rebuild owns is being edited on that branch right now.**

**Conclusion:** the thread rebuild must sit **on top of** `ui/design-system`, not beside it. Most of its diff is a mechanical icon-import swap (`lucide-react`/`@phosphor-icons` → `src/icons/`), which a rebuild would have to redo file-by-file if it forks from `main`.

---

## 8. Decisions in docs that bind a thread rebuild

Ordered by force.

1. **The bb thread port is cancelled for good, 2026-09-10.** "Both plan files are deleted; recoverable from git history at `713fbc9`. **The thread stays on the assistant-ui-based `src/components/ThreadView.tsx`.** Generic UI controls — buttons, icon buttons, menus, dialogs — move to assistant-ui's design library on Base UI, per `docs/research/assistant-ui-design.md`… No jotai, no TanStack Query still holds." — `CLAUDE.md` §2 as amended on `ui/design-system` (`git show af65dec -- CLAUDE.md`). **Not yet on `main`; `main`'s CLAUDE.md still says the opposite** ("assistant-ui Elements is abandoned… a port of get-bb/bb's").
2. **Approvals are never optimistic; `decision === null` is a third state, `Expired`.** "The dock resolves only when Rust confirms the decision reached the model… this one is the safety boundary" — `docs/vision.md:351-354`. Restated as a landmine in the cancelled plan (`docs/plans/bb-thread-port-2026-09-09.md:139-141`) and in `CLAUDE.md` §5. Reference behaviour is `src/App.tsx` + `src/feedStore.ts`, "do not improve it."
3. **Usage windows, never dollars.** "A subscription user is never billed per token, so a dollar figure would be a lie in the user's favour, which is still a lie." — `docs/vision.md:162-166`; the gauge is `rate_limit_event.unifiedWindows` with a reserve near 80% (`vision.md:162-197`). Pinned by a test (`RunCard.test.tsx:455-480`).
4. **Every optimistic entry is retired by a specific matched echo, never by "the operation finished"** — `docs/vision.md:356-360`, citing VS Code #332087.
5. **radix-ui monolith, never individual `@radix-ui/react-*` packages** — `CLAUDE.md` §5; costed at +159.91 kB raw / +50.85 kB gzip for 8 components in `docs/research/frontend-stack.md:487-505`.
6. **No jotai, no TanStack Query** — survives the cancellation, restated in the amended `CLAUDE.md` §2.
7. **Keep the existing substrate; do not insert another store.** "Retain assistant-ui while implementing and measuring one complete conversation path… styling dissatisfaction alone does not establish that the library is unsuitable" — `docs/research/bb-brigadier-reassessment-2026-09-09.md:94`; and "complete the path from provider events to the conversation instead of inserting another independent store" (`:73`). Also records that bb's own virtualized thread is experimental and disabled by default upstream (`:75`).
8. **The Elements→surface mapping, with three named adaptations** — `docs/research/chatgpt-subagents-and-brigadier-design-2026-09-09.md:259-279`: SubagentList's prefix-completion count must not mark the wrong worker complete; **ApprovalCard's Done state shows a successful exit value without accepting an exit-code prop and must be adapted so a failed command cannot render as exit-zero**; MessageQueue must bind to the durable Rust queue, not a competing in-memory array.
9. **The composer spec is approved and delivered** — `docs/plans/composer-redesign-2026-09-09.md:3`, verified in `composer-redesign-verification-2026-09-09.md`. It also binds the thread's neighbours: "The composer has no lifetime token gauge or routine compaction control", and "Do not build the experience around a filling lifetime-context window, routine transcript compaction or relay handoffs" (`composer-redesign-2026-09-09.md:11`).
10. **The 2026-09-06 ChatGPT redesign is already shipped**, and its thread decisions are in force: "Reference dark palette, rounded user bubbles, message times and copy/edit placement, long-message folding, peer attribution, concise nested action disclosures and recorded per-turn file cards. Conversation/Activity, verbose and FPS controls are removed." — `docs/plans/chatgpt-redesign-implementation-2026-09-06.md:20-22`. Every one of those is visible in `ThreadView.tsx` today.
11. **`unknown` feed rows are never filtered or restyled** — `src/wire.ts:186-191` (10,037 pre-migration rows); pinned by `Feed.test.tsx:409-422` and by a Rust test.
12. **bb's UI stack is not Base UI** — a local shadcn-style kit over ~30 individual `@radix-ui/react-*` packages (`docs/research/bb-ui-stack.md:20-22`). Irrelevant now that the port is cancelled, but it is why the "borrow bb's controls" idea is dead.

**Which decisions name Codex or ChatGPT as a model:**
- The cancelled bb plan modelled its right-rail context card "on the Codex app's" (`docs/plans/bb-thread-port-2026-09-09.md:44`) — cancelled with the rest of that plan.
- `docs/research/chatgpt-subagents-and-brigadier-design-2026-09-09.md:79` binds to **OpenAI's public Codex architecture doc** (thread → turns → typed items) as the behavioural contract, explicitly disclaiming access to Codex's private component internals. This is the closest thing to a live "Codex-style" mandate.
- `docs/plans/chatgpt-redesign-implementation-2026-09-06.md` — the ChatGPT-shaped redesign that already shipped.
- `docs/research/codex-sidebar.md` (on `ui/design-system` only) — measured Codex tokens, **sidebar only, nothing on the thread**.

---

## 9. Row-kind gap list — what a Codex-style thread would need and does not have

| Presentational concept | Status today | Where the data would have to come from |
|---|---|---|
| **"Worked for N seconds" per turn** | **Exists.** `ChatTurn.started_at`/`ended_at` → `row.durationMs` (`threadProjection.ts:203-207`), rendered at `WorkTrace.tsx:89`. Live ticking via a 1 s `setInterval` (`:66-72`). | — |
| **Per-turn grouping** | **Exists but is one flat "work" row per turn.** No sub-steps, no per-tool timing. `chat_turns` gives only start/end/status for the whole turn. | Store derivation: per-node timestamps are already on `ChatItem.at`; a per-node duration needs `result.at − item.at`, computable in `projectThread` today with no new IPC. |
| **Command exit codes** | **Missing.** `ItemKind::ToolResult` carries only `is_error: bool` (`wire.ts:62`). The exit code lives inside the tool-result `body` text, unparsed. Called out as an adaptation requirement at `chatgpt-subagents-and-brigadier-design-2026-09-09.md:274`. | Rust: add a field to `ItemKind::ToolResult` in `crates/core/src/event.rs` (a wire-contract change, mirrored in `wire.ts` and `docs/plans/ipc-contract.md`), **or** a store-side parse of the body. `Event::SessionExited.exit_code` exists but is the *session's*, not a command's. |
| **File-diff summaries** | **Exists, partially.** `desktopApi.changes` gives per-turn `files[]` with `added`/`deleted` counts; rendered as `ChangedFilesCard` "Edited N files +A −D" (`SessionReview.tsx:36-44`). **Polled every 3.5 s** (`desktopApi.ts:129`), not pushed, and only attached under a *final answer* row (`ThreadView.tsx:443`). | Existing IPC. A live inline diff per edit tool call would need the tool input parsed or a new per-item IPC. |
| **Per-tool-call elapsed time** | **Missing.** `ChatItem.at` is present on both call and result, so it is derivable, but nothing computes or shows it. | Store derivation in `projectThread`. No new data. |
| **Token / context-window usage in-thread** | **Missing from the thread.** `Usage{input,output,cache_read,cache_creation,context_window}` arrives on `turn-completed` (`wire.ts:88-94`) and is stored on `SessionRuntime.usage` (`feedStore.ts:152`). No UI reads `context_window` (grep: only mock and tests). | Existing store field. Note `docs/plans/composer-redesign-2026-09-09.md:11` forbids building the experience around a filling context window. |
| **Usage-window gauge (the vision's headline gauge)** | **Missing end to end.** `rate_limit_event` is decoded in Rust (`crates/claude-wire/src/message.rs:81`, `crates/core/src/claude/adapter.rs:614`) and drives `allowance.rs`, but **is not on the `Event` union** in `crates/core/src/event.rs` / `src/wire.ts`. The only UI trace is the composer's "Waiting for `<provider>` usage · resets …" (`Composer.tsx:82`), sourced from `composerApi` state, not the event stream. | **New IPC / new `Event` variant.** This is the largest gap between `docs/vision.md` §6 and the tree. |
| **Compaction marker in the timeline** | **Missing.** `session-compacted` never becomes a `ChatItem` (`crates/store/src/chat.rs:135` projects only `ItemStarted/Updated/Completed`); it only sets `lastMessage` (`feedStore.ts:437-439`). | Either a synthetic `ChatItem` written by the Rust store, or a store-derived overlay keyed on `Envelope.seq` and merged into `ThreadRow[]` by seq. |
| **Errors / warnings in the timeline** | **Missing.** Same as compaction — `runtime-error`/`runtime-warning` are store-only (`feedStore.ts:443,452`). A fatal error is invisible in the transcript. | Same two options. |
| **Session lifecycle markers (started / exited / resumed)** | **Missing from the thread.** `session-started`/`session-exited` set `SessionRuntime` fields only. | Same. |
| **Per-worker progress percentage** | **Missing.** `ItemKind::Subagent` carries `task_id`/`subagent_type`/`description` — no progress, no completion fraction. `chatgpt-subagents-and-brigadier-design-2026-09-09.md:271` requires an indeterminate presentation rather than a fabricated one. | New Rust field, or leave indeterminate. |
| **Streaming / typing state per row** | **Partial.** `content-delta` exists on the wire (`wire.ts:144`) but the thread never sees it: bodies come from the SQLite page, and `crates/store/src/chat.rs:134` notes "only completed items have authoritative content in the current Claude adapter." The UI shows a global `ThinkingIndicator` instead (`ThreadView.tsx:478`). | Would need a push path for bodies — currently the biggest structural difference from a Codex-style thread. |
| **Stable measured row heights for virtualization** | **Weak.** `estimateSize: () => 140` (`ThreadView.tsx:309`) for rows ranging one line to a full markdown answer; virtualization disables entirely whenever an approval is open (`:307`). | Store derivation (a per-row height cache) or a different windowing strategy. |
| **Attribution / avatar per message** | **Missing.** No author field on `ChatItem` beyond `kind`; peer messages are inferred by `peerMessageContent` (`peerPresentation.ts`). | Store derivation from peer data (already partly done). |

**One-line summary of the gap:** durations, per-turn grouping and file-diff summaries already have data. Exit codes, compaction/error/lifecycle markers in the timeline, and the usage-window gauge do not — the first needs a wire-contract change or a body parse, the second needs synthetic items or a seq-keyed overlay, and the third needs a new `Event` variant that Rust already has the source data for.

## See also

- `codex-thread-anatomy.md` — the Codex row taxonomy §9's gap list is compared against.
- `codex-thread-tokens.md` / `codex-ui-kit.md` — pixel values and candidate components for a restyle.
- `codex-thread-row-mapping.md` — the row-by-row build plan built directly on top of §9's gap list, with a
  "New brigadier data needed" column that answers each gap row here.
- `cli-steer-and-exit-codes.md` — confirms the exit-code gap (`ItemKind::ToolResult` carries only
  `is_error: bool`) against the live Claude Code CLI wire, and records that no queueing state exists to
  parallel Codex's steer strip.
