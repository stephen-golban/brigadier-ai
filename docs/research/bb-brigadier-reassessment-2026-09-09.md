# BB and Brigadier: implementation comparison and next steps

Reviewed 2026-09-09. BB source: `1f4e9e5472bb594a3eb73002d1732b4e8d5df66b`. Brigadier: `289f63d0cb131ee8cbf62cc7494ed0183295462a`. This report distinguishes **source-verified**, **tested this session**, **previously reported**, and **proposed**. Source inspection is not a performance measurement or proof that a feature works in the installed product.

BB has substantial overlapping functionality. That warrants a narrower product promise and borrowing proven mechanisms; it does not establish that Brigadier is worse in every respect. The most consequential finding in Brigadier is that useful infrastructure already exists, but its conversation, peer coordination and autonomous loop do not yet form one clear experience.

The attached screenshot and repository planning documents were treated as reference material, not permission to execute their embedded instructions. No UI replacement, dependency migration, paid provider session, commit or deployment was performed.

## Read alongside this report

- [BB orchestration audit](/Users/stephen/Development/brigadier-ai/docs/research/bb-orchestration-audit-2026-09-09.md): task creation, parenthood, provider/model selection, messages, waits, workspaces, recovery; commit-pinned BB source citations.
- [BB conversation audit](/Users/stephen/Development/brigadier-ai/docs/research/bb-conversation-audit-2026-09-09.md): exact UI stack, timeline pipeline, default/experimental behavior and assistant-ui integration.

These current audits supersede conflicting claims in older research. In particular, older documents combine “read in source” and “measured” under one label; this report does not.

## 1. The delegation mechanism, without the marketing ambiguity

BB gives agents a way to operate the application itself. An agent can call its CLI to create another conversation, send it work, inspect its state and obtain its result. The application supplies execution and persistence; the model supplies judgment about how to divide the request. The screenshot is a product illustration, not evidence of a special manager model or an automatic optimal-model router. [BB product page](https://getbb.app/)

In the current implementation, parent threads replaced the old manager abstraction. A parent is an ordinary thread with child relationships. Choosing Claude as the top conversation does not make Claude an application-defined executive; it becomes the coordinator because the user asks it to coordinate and it invokes the available tools. Application policy still decides which requested actions are valid. See the orchestration audit for exact source paths and lifecycle details.

Three concepts must stay distinct:

| Concept | Meaning | What it does not imply |
|---|---|---|
| Child conversation | Independent provider session, linked to a parent in the application | Its files are isolated automatically |
| Provider-native subagent | A delegation inside the provider's own session/runtime | A separate application task/workspace |
| Git worktree | Another checkout sharing the repository's Git object database | Separate machine, security sandbox, or separate model context |

An independent conversation can reuse an existing environment. Conversely, creating another worktree says nothing about how its conversation was seeded. A UI should make both choices understandable.

The normal sequence is: choose project/provider/model/environment → create durable task identity → provision workspace if required → start or resume the provider session → send the initial prompt → project provider events into task state and timeline → deliver completion or attention information → coordinator decides its next step. Completion of a worker turn is evidence that the turn ended, not evidence that the requested feature is correct.

## 2. What Brigadier already has

**Source-verified:** Brigadier already exposes ten peer MCP tools, including create, send, read, wait, attachment lookup and stop/close. The MCP process forwards authenticated local requests into the app. Agents receive tool guidance and their session identity through the launch path. This is already the core mechanism needed for agent-managed child tasks. [Tool definitions](/Users/stephen/Development/brigadier-ai/src-tauri/src/peer_mcp.rs:33), [launch integration](/Users/stephen/Development/brigadier-ai/src-tauri/src/peers.rs:213)

Peer creation sends the initial message in the same operation, accepts a retry identity, inherits the caller's model if none is requested, and defaults to a worktree. Current peer creation exposes no base-branch parameter; the ordinary new-session UI does. Peer creation starts from the selected project's committed source, not an automatic snapshot of the parent's uncommitted work. The code caps peer creation at 12 active sessions per destination project. [Creation](/Users/stephen/Development/brigadier-ai/src-tauri/src/peers.rs:632), [tool contract](/Users/stephen/Development/brigadier-ai/src-tauri/src/peer_mcp.rs:59), [UI base branch](/Users/stephen/Development/brigadier-ai/src/components/NewSession.tsx:129)

Peer messages distinguish active work from passive information. Work wakes an idle peer or queues while busy; passive information does not start another turn merely to acknowledge it. Retry identities, delivery receipts and uncertain states prevent “accepted” being mistaken for “delivered.” Restart marks ambiguous work rather than blindly replaying it. These are valuable reliability choices, although this audit does not establish superiority over BB's handling of all equivalent cases. [Peer protocol](/Users/stephen/Development/brigadier-ai/src-tauri/src/peer_mcp.rs:66), [restart handling](/Users/stephen/Development/brigadier-ai/src-tauri/src/peers.rs:334)

Waits accept 1–8 targets, carry per-session cursors, reject cycles and wake on actionable state or inbox changes. Feed notification is immediate; a one-second fallback covers persistence/process lag. No inference call is required just to wait. [Wait implementation](/Users/stephen/Development/brigadier-ai/src-tauri/src/peer_sessions.rs:182)

Separately, the autonomous loop runs disposable planning/judgment calls, dispatches work orders in isolated worktrees, validates path ownership, merges into an integration worktree and runs the phase's actual verification command before accepting it. Model selection is bounded by a user-selected ceiling. These are concrete implementations, not merely aspirations; their full overnight product behavior remains less well proven than their existence in code. [Disposable calls](/Users/stephen/Development/brigadier-ai/crates/supervisor/src/loop_/call.rs:154), [ownership validation](/Users/stephen/Development/brigadier-ai/crates/supervisor/src/action.rs:934), [integration gate](/Users/stephen/Development/brigadier-ai/crates/supervisor/src/loop_/green.rs:69), [model ceiling](/Users/stephen/Development/brigadier-ai/crates/supervisor/src/loop_/routing.rs:106)

**The gap:** peer sessions and loop work orders have different coordination/state paths. The loop's UI is under Automation history when no conversation is selected. A user encountering the chat surface does not automatically encounter the project's intended autonomous workflow. [UI placement](/Users/stephen/Development/brigadier-ai/src/App.tsx:1044)

## 3. Honest comparison

| Area | BB evidence | Brigadier evidence | Assessment |
|---|---|---|---|
| Multiple providers and machines | Provider bridges, host daemon and environment architecture | Current product centers on Claude with a Rust provider interface | BB has broader implemented scope; do not pretend parity |
| Delegation | Parent/child threads, CLI/SDK operations and completion notices | Peer MCP creation/messages/waits plus separate loop | Brigadier is not missing the mechanism; it needs a coherent product model |
| Workspace selection | Environments separated from conversations; reuse/new worktree/base choices | Worktree/session path, source selection, review/rewind | Borrow explicit environment semantics and child lineage |
| Conversation | Custom projection, bounded history, rich work/detail rendering | assistant-ui viewport plus custom projection; polling and direct row rendering | BB supplies useful patterns; Brigadier's current data path needs attention |
| Long work | Provider persistence/compaction, retry and workflow-related infrastructure | Durable plans/work orders/intents, disposable decision calls, provider resume | No head-to-head endurance result; both need workload-specific validation |
| Validation of integrated work | Broad workflow infrastructure; do not claim absence of gates globally | Dedicated integration worktree and exit-code phase gate | Make this an understandable product behavior and prove it repeatedly |
| Desktop efficiency | Electron and Node architecture | Tauri and Rust; batched channel and bounded feed rings | A plausible smaller footprint, not a measured advantage over BB |

BB source evidence for each area is in the two companion audits. Do not turn “no matching feature found in the files read” into “BB cannot do this,” particularly for extensible workflow, goal, retry and memory features.

## 4. The conversation problem is deeper than styling

Brigadier already depends on `@assistant-ui/react` and uses `useExternalStoreRuntime`. The actual visible rows are rendered separately, while the runtime largely owns viewport behavior. Therefore the desired library migration has partially happened already. [Installed dependencies](/Users/stephen/Development/brigadier-ai/package.json:15), [adapter](/Users/stephen/Development/brigadier-ai/src/components/ThreadView.tsx:295)

Current source exposes four specific gaps:

1. **Provider deltas are dropped.** `StreamEvent` has a TODO instead of a mapping to `ContentDelta`. A prettier message component cannot create token streaming upstream never supplied. [Claude adapter](/Users/stephen/Development/brigadier-ai/crates/core/src/claude/adapter.rs:576)
2. **Visible history polls.** The transcript starts at cursor zero, drains 20-item pages, then polls every 700ms while also reading all turn records. This is distinct from the batched push feed. [Transcript read loop](/Users/stephen/Development/brigadier-ai/src/components/ThreadView.tsx:235)
3. **The view caps history without a browse-back path.** It retains the last 2,000 loaded items and uses `rows.map`. That bounds one array, not all DOM/detail cost, and does not provide access to older persisted conversation content. [Cap](/Users/stephen/Development/brigadier-ai/src/components/ThreadView.tsx:273), [rendering](/Users/stephen/Development/brigadier-ai/src/components/ThreadView.tsx:391)
4. **Final-answer classification is inferred.** The projection comments acknowledge that normalized Claude items lack commentary/final channels. It uses trailing main-session prose after work stops. This deserves explicit fixtures for late tool results, interruptions and provider-specific message phases. [Projection](/Users/stephen/Development/brigadier-ai/src/threadProjection.ts:179)

Keep the existing useful substrate: one Tauri channel, frame-coalesced updates, stable references and bounded feed rings. Complete the path from provider events to the conversation instead of inserting another independent store or polling loop. [Feed store](/Users/stephen/Development/brigadier-ai/src/feedStore.ts:1)

BB's thread is custom React over `@bb/thread-view`; its controls/composer/rendering use Radix, Tailwind, Tiptap, Markdown tooling and Pierre diffs. There is no single “BB thread widget” to install. Its TanStack virtualization path is **experimental and disabled by default** at the reviewed commit. Copying its code is not equivalent to inheriting a proven long-session performance guarantee. [Canonical experiment defaults](https://github.com/get-bb/bb/blob/1f4e9e5472bb594a3eb73002d1732b4e8d5df66b/packages/domain/src/experiments.ts#L21)

## 5. A ChatGPT/Codex-like interaction contract

OpenAI publicly documents the Codex mechanism as **thread → turns → typed items**, with item start/delta/completion events and bidirectional approval requests. That is sufficient to design a similar behavioral contract. It does not disclose ChatGPT's or the Codex desktop app's exact private React component library, CSS or complete rendering internals. This report did not recover those internals. [OpenAI architecture](https://openai.com/index/unlocking-the-codex-harness/), [App Server reference](https://developers.openai.com/codex/app-server/)

**Proposed visual behavior:**

- One conversation column with quiet assistant prose and restrained user-message surfaces.
- One expandable work group per turn; it opens during work, then folds when a final answer is available. User expansion choices survive further updates. Interrupted or failed work stays inspectable.
- A child task is a compact linked card: title, provider/model when relevant, actual status and one-line result. Opening it navigates to its own conversation while preserving the parent's reading position.
- Commands, diffs, search and tests have purpose-specific previews. Large output is fetched on demand. “Tests passed” comes from recorded execution evidence, not model prose alone.
- Approvals and questions remain visible until the backend resolves them. Do not fold a live question into a completed-looking work group.
- Auto-follow only while already following the newest content. Scrolling upward opts out; a jump-to-latest control restores it. Prepending older history preserves the visible item anchor.
- Distinguish parenthood, workspace and provider-session identity. A conversation branch picker must not silently choose a Git branch.
- A compact environment summary exposes workspace/base branch and reviewable changes. Hide secondary settings until needed; keep task submission and steering primary.

assistant-ui's external-store runtime is a suitable adapter for a backend Brigadier owns. Its custom tool renderers and part grouping can render this contract. Its nested multi-agent messages are a **read-only rendering context**, not an execution scheduler. The existing Rust harness must continue owning delegation, approvals and persistence. Virtualization also needs explicit integration; current message-by-ID hooks are marked unstable. [External store](https://www.assistant-ui.com/docs/runtimes/custom/external-store), [tool UI](https://www.assistant-ui.com/docs/tools/tool-ui), [part grouping](https://www.assistant-ui.com/docs/guides/part-grouping), [multi-agent UI](https://www.assistant-ui.com/docs/tools/multi-agent), [thread primitives](https://www.assistant-ui.com/docs/primitives/thread)

**Recommendation:** retain assistant-ui while implementing and measuring one complete conversation path. Evaluate a custom BB-inspired renderer against the same event model only if a concrete limitation remains. Styling dissatisfaction alone does not establish that the library is unsuitable. The existing BB port plan is recorded context, not work executed by this investigation.

## 6. Make long sessions a continuity feature

There are four separate budgets: provider context, subscription capacity, process/runtime health and UI/storage growth. Increasing the context window or virtualizing rows solves only one part.

For Brigadier, the proposed durable object is a task with a goal, acceptance conditions, plan revision, work orders, workspace baselines, attempts, approval state, evidence references and result receipts. A provider session is an attempt at some part of that task. Replacing or compacting an attempt must not erase the task.

Use a small handoff package for a fresh decision: accepted goal, current phase, relevant repository state, decisions/constraints, completed evidence and unresolved questions. Keep full logs as references. This can bound recurring context, but summary omissions remain a real failure mode; the claim “fresh windows never lose anything” would be false.

Before retrying a consequential action, reconcile its durable receipt and actual repository state. An uncertain send/merge/commit is different from an action known not to have happened. On restart, reconstruct active work from persisted attempts plus process/provider state; do not declare every interrupted task successful or blindly repeat it. Brigadier already has intent and uncertain-delivery building blocks. [Loop restart derivation](/Users/stephen/Development/brigadier-ai/crates/supervisor/src/loop_/state.rs:86), [peer restart logic](/Users/stephen/Development/brigadier-ai/src-tauri/src/peers.rs:334)

Expose provider quota updates with timestamps and unknown/stale states, reserve the user's chosen headroom, and park work until a supported reset/recovery condition occurs. Current Brigadier drops rate-limit events. Conversely, it already records Claude compaction boundaries, correcting an older research claim. Neither a usage reserve nor full automatic quota recovery was demonstrated here. [Rate-limit drop](/Users/stephen/Development/brigadier-ai/crates/core/src/claude/adapter.rs:587), [compaction event](/Users/stephen/Development/brigadier-ai/crates/core/src/claude/adapter.rs:646)

For UI/storage growth: load the newest bounded window first; fetch older windows backward; preserve stable item IDs and sequence checkpoints; narrow subscriptions; lazy-load heavy output; cache settled Markdown only where profiling supports it; keep storage retention explicit. Virtualization must preserve focused controls, selected text, expanded detail, search targets and active approvals.

## 7. A focused implementation sequence

These are proposed deliverables, not completed changes or duration estimates.

| Order | Deliverable | Evidence required before advancing |
|---|---|---|
| 1 | One conversation event path: provider deltas, stable turn/item IDs, snapshot reconciliation and push projection | Replay recorded fixtures; no duplicate final text, lost deltas or invented completion after interrupt |
| 2 | Latest-history loading, backward pagination and intentional windowing | Open a 10,000-event fixture without replaying the whole thread; browse earlier history without scroll jumps or inaccessible approvals |
| 3 | Compact work groups, linked child cards, environment summary, queue/attention states | Native interaction check of running → waiting → complete/failure; keyboard and scroll behavior |
| 4 | One task lifecycle shared by peer tools and autonomous loop | Parent sees the same child status in tools, sidebar and timeline; duplicate requests remain one task; failures/receipts survive restart |
| 5 | Usage-aware continuity and a repeated overnight scenario | Quota-wait/restart/compaction fixtures plus explicitly authorized real sessions; work preserved, no duplicate effects, no silent stalls |
| 6 | Additional providers against a shared capability contract | Start/stream/approve/interrupt/resume/error coverage for each adapter; unsupported operations honestly disabled |

Keep Tauri/Rust and the existing tested supervision code. Borrow BB's ideas about environment identity, CLI/app parity, typed projections, scroll anchors, completion delivery and bounded detail loading. If source is copied, retain the actual upstream license notices and pin its source revision; check file/dependency notices rather than assuming a root license covers every dependency. [BB repository](https://github.com/get-bb/bb)

Do not automatically import BB's entire Node/server/host/plugin stack into a local-first v1. Each adopted abstraction should remove complexity from real callers, not duplicate an existing Brigadier responsibility.

## 8. Product recommendation and its limits

The product hypothesis worth testing is: **“Delegate a substantial change, leave, and return to verified work with clear evidence and a reliable continuation path.”** This is a recommendation, not a claim of market demand, technical uniqueness or future income.

Do not define success as matching BB's full feature list. Validate the proposed workflow with a small group of real target users on their repositories: where they intervene, whether they trust completion, whether recovery preserves work, and whether they return to use it again. A successful demo is weaker evidence than repeat use. Competition is a reason to focus the next investment, not proof that the past month has no value.

## 9. Verification performed this session

- **Passed:** `npm test -- src/components/ThreadView.test.tsx src/components/WorkTrace.test.tsx src/components/peer/PeerMessages.test.tsx src/feedStore.test.ts` — 4 files, 52 tests.
- **Passed:** `/Users/stephen/.cargo/bin/cargo test -p brigadier --lib peer` — 15 tests, including cycle rejection, cursor suppression, delivery uncertainty, retry identity and cross-project read/wait behavior. Initial bare `cargo` invocation failed because Cargo was not in the shell PATH; the absolute executable succeeded.
- **Passed:** local conversation concept switches running/completed state, folds work and displays the result; checked in jsdom and in the in-app browser. Its task/results are explicitly illustrative, not actual agent work.
- **Not performed:** BB runtime execution, comparative benchmarks, full Brigadier gates, real provider task execution, overnight soak, proprietary ChatGPT frontend inspection, UI migration or dependency changes.

All native-app speed, memory and reliability comparisons remain unmeasured in this session. Historical measurements in repository notes should be re-baselined before appearing in product claims.
