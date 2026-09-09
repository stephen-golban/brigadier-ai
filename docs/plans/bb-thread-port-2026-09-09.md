# bb thread port — plan and standing orders

2026-09-09. Owner decision after a grill session: **route 3**. Port get-bb/bb's hand-rolled thread
timeline and TipTap composer into brigadier, abandon the assistant-ui Elements migration. Owner's
reason, verbatim: "i just checked the assistant-ui migration and it looks like absolute shit".

This file is the contract for an **unattended** run driven by a manager thread inside the bb IDE
(Fable 5.1). The owner is asleep. Nothing in here is a question; every ambiguity resolves toward
this file, then toward bb's observed behaviour, then toward `docs/vision.md`. Never wait for the
owner.

Base commit: `c4d9d29`. bb source pinned at root SHA `4749527` (`https://github.com/get-bb/bb`,
MIT).

## 0. Read first, in this order

1. `docs/research/bb.md` — the dissection; §3(m) is the UI stack, §6 the borrow list, §11 what was
   never verified. **Nobody has run bb.**
2. `docs/research/bb-ui-stack.md` — every widget, path and version in detail.
3. `docs/research/bb-brigadier-today.md` — what brigadier actually has at `c4d9d29`.
4. `docs/vision.md` §6 (usage windows), §9 (UI rules: approvals never optimistic, everything
   else may be), `docs/STATUS.md` §4 (paint budgets) and §7 (landmines).
5. `docs/research/feed-rendering.md` §2 and `docs/research/tauri-runtime.md` §4 — the one-channel,
   one-rAF, fixed-ring substrate the timeline must sit on.
6. `CLAUDE.md` — research before any library call; every claim measured or asserted.

If `docs/research/bb.md` is missing from your working tree you are in a worktree cut before the docs
were committed: copy `docs/research/bb*.md` and `docs/plans/bb-thread-port-*.md` from
`/Users/stephen/Development/brigadier-ai/` into your tree and commit them first as
`docs: bb dissection and thread port plan`.

## 1. Settled decisions (the grill, 12 questions, all agreed)

| # | decision | resolution |
|---|---|---|
| 1 | boundary | port the **thread timeline** (row renderer, details, windowing, message content, reasoning, file-diff block + diff card, context donut, pending-interaction banner) and the **composer** (TipTap prompt box, mentions, attachments). Sidebar, source-control panel, Monaco workbench and terminal dock are **untouched** this round; bb's child-chevron sidebar tree is a later order. |
| 2 | assistant-ui | the port replaces `src/components/ThreadView.tsx` and `src/components/MarkdownContent.tsx` outright; the **last** build order deletes `src/components/assistant-ui/` (17 files, 1,235 lines) and the two npm packages `@assistant-ui/react`, `@assistant-ui/react-markdown`. The four uncommitted plan docs `docs/plans/assistant-ui-*-2026-09-09.md` (+ the `.json`) are deleted. The research files `docs/research/assistant-ui-connected-runtime-2026-09-09.md`, `claude-elements-capabilities-2026-09-09.md` stay with a one-line "superseded by the bb port, 2026-09-09, see docs/plans/bb-thread-port-2026-09-09.md" note at the top. |
| 3 | row model | **bb's structure, brigadier's kinds.** Source rows `conversation \| work \| system`, plus `turn` rows; one exhaustive switch on `row.kind`, a second on `row.workKind`, both ending in `assertNever`; a body-override slot kept. Kinds in §3. Projection is a **pure TypeScript module in the webview**, no React, no zod, no Rust change. |
| 4 | data flow | **push, end to end.** Keep the Tauri channel + `src/feedStore.ts` rings + rAF drain. Add a per-session ring of projected rows; hydrate history once from the existing `workspaceApi.chat(sessionId, cursor)` pages; the channel keeps rows current; **delete the 700 ms poll** in `ThreadView.tsx:280`. No jotai, no TanStack Query. |
| 5 | first turn | the moment the user sends: session row appears in the sidebar as `starting`; the timeline replaces the welcome state with the user's message as a **pending turn row** plus one system row ("creating worktree" / "starting claude") driven by events already emitted; the composer stays enabled and a second message **queues**. On `system/init` the pending row becomes the real turn. On spawn failure it becomes an **error row with the reason and a retry**, never a silent revert to the welcome state. Approvals remain non-optimistic. |
| 6 | rendering libs | `sugar-high` replaces shiki (shiki is only used inside the deleted elements dir). Markdown chain: `react-markdown` (already present) + `remark-gfm` + `remark-breaks` (present) + `remark-math` + `rehype-katex` + `rehype-raw` + `rehype-sanitize` + `mermaid` + `remend`; **katex and mermaid load lazily** on the first fence that needs them. Diffs in file-change rows: `@pierre/diffs`; bb carries a pnpm patch for it — read `get-bb/bb:patches/` and either carry the patch or write one line in the report saying why not. Approvals and source-control keep their current rendering. |
| 7 | composer | TipTap 3 prompt box with: **mention pills** for files (backed by the existing file search command in `src-tauri/src/search.rs`) and notes (keep current `brigadier-note:` behaviour from `src/components/PromptInput.tsx:106-118,189,263`); **attachments** by paste and drop — images png/jpeg/gif/webp and text, which `crates/core/src/claude/adapter.rs:1526-1544` already sends; a **queued-messages banner**; a **slash menu** with `/compact` and `/clear` only (`CompactTrigger` exists at `src/wire.ts:47`); **our `RunControl`** (`src/components/Composer.tsx:97`) stays as brigadier's own strip beside the box. **Out:** voice, bb's todo/goal/workflow/model-fallback banners. |
| 8 | peer / work-order rows | rendered as **compact cards**, not containers: title, live status, elapsed, one-line last message; click opens that session. In-session subagents (`ItemKind.subagent`) render as bb's **delegation** container row recursing into child rows. The plan card above the thread is **not** in this port. |
| 8b | context card | a **right-rail card** pinned top-right inside the thread viewport, modelled on the Codex app's: **Environment** (worktree/project path, branch, +added/−removed line count, a commit action that opens the existing source-control panel), **Agents** (subagents + peers + work orders: name, status dot, elapsed; click scrolls to the row or opens the session; subagent names from the Task description). **Sources deferred.** Collapses to icons on narrow widths; hidden when the session has no worktree and no agents. Peer messages render as a **distinct bubble with a "from session X" attribution line**, replacing the generic system row. |
| 9 | attribution | `THIRD_PARTY_NOTICES.md` at repo root with bb's MIT text and the list of ported files; a one-line header on every ported or adapted file: `// Ported from get-bb/bb:<path> @ 4749527 (MIT). See THIRD_PARTY_NOTICES.md`. Design-only borrowings (the projection) get no header. brigadier's own licence stays undecided. |
| 10 | gates | nine, §6. |
| 11 | run mechanics | one worktree, branch `bb-thread-port`; children share it, partitioned by file ownership, parallel only when files do not overlap; one commit per order, prefix `port N:`; **never push**; owner merges after the report. Manager Fable 5.1; build children Opus 5 at high; blind reviews by a fresh Fable child that did not build the order. Stop dispatching at **80 % of the five-hour usage window** and say so. No dollar figures anywhere. |
| 12 | order of work | eight orders, §7; tree runnable after every commit. |

## 2. Target layout

Mirror bb's directory shape so future diffs against upstream stay readable.

```
src/thread-view/                      pure TS projection, no React (design from get-bb/bb:packages/thread-view)
  rows.ts                             TimelineRow union, kinds, assertNever
  project.ts                          Event/ChatItem -> rows, incremental
  project.test.ts                     unit + the 10,000-row ceiling test
src/components/thread/
  timeline/ThreadTimelineRows.tsx     port of get-bb/bb:apps/app/src/components/thread/timeline/ThreadTimelineRows.tsx
  timeline/TimelineRowDetails.tsx     port; switch on workKind
  timeline/TimelineWindowedItems.tsx  port; useVirtualizer, overscan 8, window only >20 items, 2,000-entry height LRU
  timeline/ConversationMessageContent.tsx  port; streaming-markdown split + remend
  timeline/TimelineReasoningDetail.tsx / TimelineReasoningExpansion.tsx  port
  timeline/TimelineFileDiffBlock.tsx  port -> git-diff/GitDiffCard.tsx (@pierre/diffs)
  timeline/ThreadContextWindowIndicator.tsx  port; SVG donut in a Radix popover, tones >=75 warning, >=90 destructive
  timeline/TimelineRowBodySlot.tsx    the body-override slot (bb: PluginTimelineRendererBody.tsx), no plugin system behind it yet
  timeline/PendingTurnRow.tsx         new (decision 5)
  timeline/PeerBubble.tsx             new (decision 8b), replaces src/components/peer/PeerMessages.tsx usage inside the thread
  timeline/AgentCard.tsx              new (decision 8): peer + work-order compact card
  pending-interactions/ThreadPendingInteractionBanner.tsx  port, wired to src/feedStore.ts approvals, non-optimistic
  context-card/ThreadContextCard.tsx  new (decision 8b): Environment + Agents
  git-diff/GitDiffCard.tsx            port of get-bb/bb:apps/app/src/components/git-diff/GitDiffCard.tsx
  ThreadView.tsx                      replaces src/components/ThreadView.tsx (same props contract to App.tsx)
src/components/promptbox/
  PromptBox.tsx                       port of get-bb/bb:apps/app/src/components/promptbox/PromptBoxInternal.tsx, trimmed to decision 7
  mentions/                           file + note mention extensions
  SlashMenu.tsx, QueuedMessagesBanner.tsx, AttachmentStrip.tsx
THIRD_PARTY_NOTICES.md
```

Keep `src/components/Composer.tsx`'s `RunControl` export; the rest of `Composer.tsx` and
`PromptInput.tsx` is superseded by `promptbox/` and deleted in order 4 once nothing imports it.
`src/threadProjection.ts` (323 lines, `projectThread`, `TraceNode`) is superseded by
`src/thread-view/` in order 2; `src/components/WorkTrace.tsx` (401 lines) goes with it if nothing
else imports it — check `grep -rn WorkTrace src` first.

## 3. Row model

Source rows: `conversation` (user / assistant text), `work` (anything the model did), `system`
(housekeeping). Turn rows wrap a user prompt through its `result`. Every row carries `seq`, `turnId`,
`sessionId`, `at`, and a `status` from `{pending, streaming, done, failed}`.

Work kinds and the mapping from brigadier's wire (`src/wire.ts:58-70` `ItemKind`, tool names from
`tool-call.name`):

| workKind | source |
|---|---|
| `command` | `Bash` |
| `file-change` | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` — carries a unified diff when the tool result has one |
| `file-read` | `Read` |
| `search` | `Grep`, `Glob`, `LS` |
| `web-search` | `WebSearch` |
| `web-fetch` | `WebFetch` |
| `image-generation` | any tool result whose content carries an image the model **produced** (Codex/openai image tools later; today none) |
| `image-view` | `Read` on an image, or a tool result carrying an image the model **read** |
| `plan-steps` | `TodoWrite` / `TaskCreate`/`TaskUpdate` |
| `approval` | a `can_use_tool` control request and its decision (`ApprovalView`, `src/wire.ts:420`) |
| `question` | `AskUserQuestion` |
| `delegation` | `ItemKind.subagent` — container, recurses into the child rows that share its `task_id` |
| `work-order` | a loop work order dispatched from this session (`OrderId`, `src/wire.ts:457`) — compact card |
| `peer` | a peer session spawned/linked from this session (`src-tauri/src/peers.rs` data via `src/peerApi.ts`) — compact card |
| `tool` | any other tool name, generic header-only row |

System operation kinds: `generic`, `reasoning-summary`, `compaction` (from `CompactTrigger`),
`context-clear`, `session-start`, `session-exit` (`ExitReason`), `warning`, `error`,
`peer-message` (rendered by `PeerBubble`), `provider-unhandled` (an event the projection did not
recognise — **never drop an event silently; render it as this row with its raw type**).

Six kinds may render header-only (bb does the same): `search`, `file-read`, `web-search`,
`web-fetch`, `tool`, `plan-steps` when collapsed.

## 4. Data flow

- `feedStore.ts` gains `getThreadRows(sessionId): readonly TimelineRow[]` backed by a per-session
  ring (cap: same `ROW_CAP = 2000` semantics; when the cap trims, the first surviving row is a
  `system/generic` "older history available" row that triggers a page fetch upward).
- Hydration: on session select, page `workspaceApi.chat(sessionId, cursor)` and
  `workspaceApi.chatTurns(sessionId)` **once** to the end, project, seed the ring
  (`seedRows`-style entry point). Then the channel's `signals: Envelope[]` (`FeedBatch`,
  `src/wire.ts:222`) feed `project.ts` incrementally inside the existing rAF drain.
- The projection is incremental: it holds per-session cursor state (open turn, open tool calls by
  `tool_call_id`, open subagents by `task_id`) and emits row inserts/updates, never a full rebuild.
- One `useSyncExternalStore` subscription per thread view, as today; the virtualiser takes the
  ring as an array.

## 5. Landmines

- **Approvals are never optimistic** (`docs/vision.md` §9). The banner clears only on
  `request-resolved`; `decision_json = NULL` is the third state `Expired`. `App.tsx:769-774` and
  `feedStore.ts:270-271` are the reference behaviour. Do not "improve" this.
- `radix-ui` is the **monolithic** package here (`package.json`, `^1.6.7`); bb imports
  `@radix-ui/react-*` individually. Map imports; do not add the individual packages.
- Icons: use `lucide-react` (present). Do not add `@hugeicons/*`. `@phosphor-icons/react` stays
  for existing components.
- Tailwind is **v4** here already; bb's classes port as-is. Do not add `class-variance-authority`
  unless a ported component cannot be expressed without it; prefer `tailwind-merge` (present).
- `tw-animate-css`: bb's `shared-ui/src/components/ui/motion.ts` is CSS-only; port the few
  keyframes needed into `src/index.css`, no framer-motion.
- No zod. bb's row union is zod-derived; ours is plain TS. Do not add zod for this.
- `--strict-mcp-config` and `--permission-mode` last are pinned in `crates/core/src/claude/process.rs:118-160`. Do not touch.
- `@pierre/diffs` is **patched** in bb (`get-bb/bb:package.json` `pnpm.patchedDependencies`). Read the patch before depending on it.
- The paint budget: exec → first contentful paint is **287–295 ms p50** at `c4d9d29`
  (`docs/STATUS.md` §4). Lazy-load katex, mermaid, TipTap extensions that are not needed for the
  first paint. Measure with the existing burn harness (`VITE_BURN=1`, `src/components/Burn.tsx`).
- Rust: touched **only** in order 5 and only to emit a status that already exists in
  `SessionStatus` (`src/wire.ts:258`) if it is not yet on the wire; with a test. Anything more is out
  of scope — write it in the report as a follow-up.
- `git worktree remove --force` and the filter-driver landmines in `docs/STATUS.md` §7 do not
  concern this port; do not go near `crates/core/src/worktree.rs`.
- The `[1m]` context window: the donut's denominator comes from `Usage`/`ModelInfo`
  (`src/wire.ts:88,245`); default 200k, 1M for models whose id carries `[1m]`.

## 6. Gates — nine, all must be run, each reported as run/not run with its exit code

1. `PATH="$HOME/.cargo/bin:$PATH" cargo test --workspace`
2. `cargo clippy --workspace --all-targets -- -D warnings`
3. `cargo doc --workspace --no-deps`
4. `npm test` (vitest)
5. `npx tsc --noEmit`
6. `npm run tauri build`
7. **Synthetic timeline**: a vitest case projecting and windowing **10,000 rows** under a fixed
   ceiling (start at 1,500 ms like bb's; record the measured number; tighten if it is comfortably
   under).
8. **Paint budget**: a release burn; exec → FCP **≤ 295 ms p50** (no worse than the current band),
   60 Hz gate with **0** dropped-vsync failures during a flood. Numbers, not adjectives.
9. **Live smoke** through the installed build: one real session on this repo — first turn with an
   image attachment, an approval, a subagent (`Task`), a file edit rendered as a diff, `/compact`,
   a queued second message — and **two screenshots**: the timeline and the context card, saved to
   `docs/plans/bb-port-smoke-<timestamp>-{timeline,card}.png`. Cost from the store row.

"Green" is a claim until the manager has re-run the gate itself after the child's run.

## 7. Orders

Each order: owned paths, definition of done, evidence to return, a blind review by a fresh Fable
child, then one commit `port N: <title>`. Children that touch disjoint paths run in parallel.

| N | title | owned paths | done when |
|---|---|---|---|
| 1 | foundation | `THIRD_PARTY_NOTICES.md`, `package.json`, `package-lock.json`, `src/thread-view/**` | notices file; deps added (`sugar-high`, `@pierre/diffs` (+patch), `remend`, `remark-math`, `rehype-katex`, `rehype-raw`, `rehype-sanitize`, `mermaid`, `katex`, `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-mention`, `@tiptap/extension-placeholder`, `@tiptap/suggestion` — **verify each name and current version on npm before adding**, write `docs/research/bb-port-deps.md` with the versions and why); `rows.ts` + `project.ts` + tests incl. the 10,000-row ceiling. No visible change. Gates 4, 5, 7. |
| 2 | timeline core | `src/components/thread/timeline/{ThreadTimelineRows,TimelineRowDetails,TimelineWindowedItems,ConversationMessageContent,TimelineReasoningDetail,TimelineReasoningExpansion,TimelineRowBodySlot}.tsx`, `src/components/thread/ThreadView.tsx`, `src/feedStore.ts` (ring + `getThreadRows`), `src/App.tsx` (import swap only), `src/index.css` (keyframes) | old `ThreadView` replaced in place; poll deleted; history hydrates once; streaming text renders via sugar-high + the markdown chain with lazy katex/mermaid; `src/threadProjection.ts` and `WorkTrace.tsx` removed if unreferenced. Gates 4, 5, 6. |
| 3 | rich rows | `src/components/thread/timeline/{TimelineFileDiffBlock,ThreadContextWindowIndicator}.tsx`, `src/components/thread/git-diff/**`, `src/components/thread/pending-interactions/**` | file-change rows show a real diff; donut live with 75/90 tones; approvals in the timeline, non-optimistic, `Expired` third state preserved; `src/components/Approvals.tsx` untouched. Gates 4, 5, 6. |
| 4 | composer | `src/components/promptbox/**`, `src/components/Composer.tsx` (reduce to `RunControl`), `src/components/PromptInput.tsx` (delete), `src/App.tsx` (import swap) | TipTap box with file + note mentions, paste/drop attachments reaching `adapter.rs` unchanged, slash menu (`/compact`, `/clear`), queued banner, `RunControl` alongside; drafts survive session switch as today (`useDraft`). Gates 4, 5, 6. |
| 5 | first turn | `src/components/thread/timeline/PendingTurnRow.tsx`, `src/thread-view/project.ts`, `src/feedStore.ts`; Rust only if a status is missing on the wire (`crates/core/src/claude/adapter.rs`, `crates/supervisor/src/wire.rs`, + test) | decision 5 end to end, verified on a real spawn with an isolated worktree; failure path verified by pointing at a bogus `claude` path. Gates 1–6. |
| 6 | context card + peers | `src/components/thread/context-card/**`, `src/components/thread/timeline/{AgentCard,PeerBubble}.tsx`, `src/components/peer/**` (adapt or delete what the bubble replaces) | Environment + Agents sections live; peer bubble with attribution; peer/work-order compact cards; click targets work. Gates 4, 5, 6. |
| 7 | removal | `src/components/assistant-ui/**` (delete), `src/components/MarkdownContent.tsx` (delete or reduce), `package.json` (drop `@assistant-ui/*`, `shiki`), `docs/plans/assistant-ui-*` (delete), `docs/research/{assistant-ui-connected-runtime,claude-elements-capabilities}-2026-09-09.md` (superseded note) | `grep -rn "assistant-ui\|shiki" src package.json` returns nothing. Gates 4, 5, 6. |
| 8 | proof | `docs/plans/report-bb-port-2026-09-10.md`, `docs/plans/next-session.md`, `docs/plans/bb-port-smoke-*.png`, `docs/STATUS.md` (a dated §0 entry only) | all nine gates run by the manager itself; report in the shape below. |

If an order fails its gate twice: leave it **uncommitted** (stash or a `wip/port-N` branch, named in
the report), record the failing assertion, and continue with any order that does not depend on it.
Dependencies: 2 needs 1; 3, 4 need 2; 5 needs 2 and 4; 6 needs 2; 7 needs 2, 3, 4, 6; 8 last.
So after 2 lands, orders 3, 4 and 6 may run in parallel (disjoint paths).

## 8. Report shape (`docs/plans/report-bb-port-2026-09-10.md`)

One line per fact, a path or a number instead of an adjective, the remedy on the same line as the
problem. Sections: what landed (commit per order); the nine gates, each `run: <exit code, number>`
or `not run: <why>`; the two screenshot paths; usage window at start and end (percent, no dollars);
what was skipped and why; what the blind reviewers found and what was done about each finding;
follow-ups the owner must decide (brigadier's licence, the sidebar tree order, the plan card, Rust
changes deferred). Then update `docs/plans/next-session.md`.

## 9. Not decided here

brigadier's own licence. The sidebar child-chevron tree. The plan card above the thread. Sources in
the context card. Voice. Codex / opencode providers (the row model is ready for them; nothing else
is).
