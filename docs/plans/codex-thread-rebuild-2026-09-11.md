# Thread rebuild — Codex structure on assistant-ui, implementation plan

Written 2026-09-11 on `ui/codex-thread` (worktree
`/Users/stephen/Development/brigadier-ai.worktrees/codex-thread`), surveyed at `ea8d705`.
**Amended 2026-09-11 after an adversarial review — read "Amendments" below before anything else.**

Every claim is **[M]** measured (I read the file or the transcript today) or **[A]** asserted
(inference or someone else's document carried forward). §9 lists what was not checked.

**Base — this branch is behind `main`.** `ui/codex-thread` is at `ea8d705`; `main` moved to
`f94c9ef` when `codex/cli-updates` merged as `c9c1353`. `git diff --stat ea8d705 f94c9ef` touches six
files — `src-tauri/src/lib.rs`, `src-tauri/src/updates.rs`, `src/softwareUpdates.ts`,
`src/softwareUpdates.test.tsx`, `src/components/SoftwareUpdates.tsx`,
`src/components/SoftwareUpdates.test.tsx` — **none on the thread path**, so every survey number in §1
survives the rebase. **[M]** **Rebase `ui/codex-thread` onto `f94c9ef` (or whatever `main` is at the
time) before phase 2 starts. Phase 5's burn baseline must be taken on that base: a baseline taken at
`ea8d705` is invalid** (§7.2, phase 5 step 1).

Background reports, all read. **Their permanent home is `docs/research/` in this worktree**; the
session scratchpad they were drafted in is session-scoped, is not in git, and must not be cited:

| file | what it is | authority |
|---|---|---|
| `docs/research/codex-thread-anatomy.md` | the Codex thread's structure, from the `codex app-server` protocol and OpenAI's open reference client | **structure** |
| `docs/research/codex-thread-tokens.md` | design tokens read out of the shipped ChatGPT.app `26.903.61454` bundle | **pixels** — beats the kit wherever they disagree |
| `docs/research/codex-thread-row-mapping.md` | the 18-row comparison table, the assistant-ui registry closure, the vendoring-script run | component picks |
| `docs/research/codex-ui-kit.md` | dissection of MIT `codex-ui-kit` @ `9f3af2c3a6386d4ea05f8b3f2c1051ae1a50789d` | kit inventory |
| `docs/research/cli-steer-and-exit-codes.md` | 6 driven runs of `claude 2.1.267` — steering, exit codes, partial messages, rate limits | **wire facts** |
| `docs/research/thread-render-path-2026-09-10.md` | thread survey at `61e8576` — **stale**, six commits behind; §1 below supersedes it | superseded |

Earlier drafts of this plan cited scratchpad names. The mapping, scratchpad name → repository file,
for anyone reading one: `codex-anatomy-digest.md` → `docs/research/codex-thread-anatomy.md`;
`thread-plan-prep.md` → `docs/research/codex-thread-row-mapping.md`; `codex-ui-kit-research.md` →
`docs/research/codex-ui-kit.md`; `protocol-probe.md` →
`docs/research/cli-steer-and-exit-codes.md`; `brigadier-thread-survey.md` →
`docs/research/thread-render-path-2026-09-10.md`; `codex-thread-tokens.md` keeps its name. Section
numbers carry over except for the probe, whose `Q1/Q2/Q3` are that file's `§1/§2/§3`.
All six are **untracked** in this worktree today and must be committed with the rebase. **[M]**

**Session-local artefacts that are simply gone, and what replaced them.** The six driven-run
transcripts (`transcripts/*.jsonl`) — every finding taken from them survives in
`docs/research/cli-steer-and-exit-codes.md` §§1–3, and this plan now cites that file's sections rather than a frame
offset. The beautified ChatGPT.app bundle (`pretty/`) behind every pixel value — the values survive
in `docs/research/codex-thread-tokens.md`. The assistant-ui registry snapshot — its closure survives in
`docs/research/codex-thread-row-mapping.md` §1. The `codex-ui-kit` clone — re-clonable at the pinned commit.
`vendor-codex-ui-kit.mjs` and its `vendored-preview/` output — the script's CLI, its flags, its
refusals and its measured run survive in `docs/research/codex-thread-row-mapping.md` §3 (`:587-711`), so it can be
rewritten from that section; see phase 3R's inputs, which no longer name a scratchpad path.

---

## 0. Amendments — 2026-09-11, after adversarial review

An adversarial review of this plan returned twelve findings, eight of them verified against the tree;
the lead independently re-verified the first two. What changed, and why:

1. **§4.2 was wrong and is rewritten; §4 is un-frozen.** The plan claimed streaming already reaches
   the UI and that lifting one TypeScript gate was the whole change. Deltas reach SQLite, but
   **nothing tells the frontend**: `crates/store/src/feed.rs:180` returns `None` for
   `Event::ContentDelta` inside `terse_line`, so no row and no `counters.total` increment
   (`crates/supervisor/src/batcher.rs:178-179`); `batcher.rs:44-58` `is_signal` omits `ContentDelta`,
   so no `lastEventSeq`; `crates/store/src/chat.rs:197-214` only appends to the item body; and
   `conversation-state-changed` is emitted from one place only, `src-tauri/src/composer.rs:169`, a
   composer mutation. `getSessionCursor` therefore never moves and no refetch fires. **[M]** §4.2 is
   now a real Rust work item (a coalesced per-session delta counter) in phase 2, with the matching
   item and tests in phase 3. **D15 is rewritten.**
2. **The base was stale.** §7.2 analysed a worktree that no longer exists and a branch already merged;
   it is rewritten, and the burn baseline is re-stated (header, phase 5).
3. **Interim prose (finding 3).** §4.2's one-line recipe is replaced by a behaviour requirement plus
   three named tests; phase 3 chooses the mechanism.
4. **Two "expired" notions (finding 4).** §3 row 12 conflated them. The kit's approval prop surface is
   now **extended** (a third decision value and a dismiss action) rather than the notions collapsed;
   `ApprovalResolution` keeps its own markup and its literal summary string.
5. **The read-only path (finding 5).** `TranscriptRuntime.tsx:7` filters non-text parts out, so the
   new `data-*` rows would render nothing in the nested `ThreadView` at `SubagentsPanel.tsx:77`. Added
   to phase 4 as required work with its own check, and flagged as colliding with the
   `codex/transcript-performance` worktree's uncommitted edits to that file.
6. **Ownership (finding 6).** `THIRD_PARTY_NOTICES.md` moved off phase 3R (a phase-1 attribution
   worker already wrote it); `licenses/base-ui-MIT.txt` and the unreferenced `licenses/radix-ui-MIT.txt`
   moved onto it; `SubagentsPanel.tsx`, `Markdown.tsx` and `RunCard.tsx` named in phase 4; phase 3's
   dependency on phase 2's `src/wire.ts` stated plainly with a way to proceed.
7. **Citations.** Nine wrong `path:line` pointers fixed and each re-read in the file:
   `approvalHistory.ts` → `src/components/approvalHistory.ts` (§1.4, landmine 12); `feed.rs:118` →
   `:114`/`:125`/`:180` (§1.7, §9); `docs/STATUS.md:688-697` → `:799-805`, `:703-706` → `:814-817`,
   `:707-713` → `:822-824` (landmines 13–14, D10, phase 5); `threadProjection.ts:174` → `:175`,
   `:199` → `:201`, `:204` → `:208`; `useConversationHistory.ts:74` → `:73` (§1.6). §1.9's
   `src/index.css` line map was re-measured and is **correct as it stands** (1,317 lines, `:root`
   `:30`) — the review read it while a spike `@import` was temporarily in the file; §1.9 now says so.
   One of the review's own corrections was wrong and is **not** applied: `activitySummary(group)` is
   `WorkTrace.tsx:187`, as this plan already said — `sed -n '187p'` returns
   `const label = activitySummary(group);`. **[M]**
8. **Row 19 added:** the `user-input` `RequestKind`, deferred with its reason and its trigger.
9. **Identity hazard:** usage windows no longer go on the React snapshot (§4.3, phase 3 item 2).
10. **Evidence base:** every scratchpad citation repointed at `docs/research/` (header, §§1–4).

---

## 1. What is actually in the tree — re-survey at `ea8d705`

The survey in the scratchpad was taken at `61e8576`. Since then `d46a367` (vendored icons, dark-only),
`216d45e` (UI controls onto assistant-ui's design kit on Base UI), `a4e46eb` (Codex sidebar), `052fa0f`
and `ea8d705` (Button codemod) landed. Everything below was re-read today.

### 1.1 Render chain

```
src/App.tsx:1256   <ThreadView requests={<Approvals … /> @:1260} sessionId … />   (inside ProjectWorkbench)
  ThreadView.tsx:88    <Transcript key={sessionId} … />
    ThreadView.tsx:359   <TranscriptRuntime sessionId messages busy loaded readOnly>
      ThreadView.tsx:360   <PeerTaskCardScope rows … >
        ThreadView.tsx:361   <Thread viewportRef={scroll} …>        ← src/components/assistant-ui/elements/thread.tsx (64 lines)
          ThreadView.tsx:403-467  visibleRows.map(...)              ← hand-written row dispatch
            :415 <WorkTrace …>                    row.type === "work"
            :433 <UserMessage …>                  row.item.kind.type === "user-text"
            :448 <ChatPanelAssistantMessage …>    everything else
              :454 <ChangedFilesCard …>           when row.final && turn
```

`SubagentsPanel.tsx` is **not** on this path: `ProjectWorkbench.tsx:1423` mounts it as a sibling of
`ThreadView`, and `SubagentsPanel.tsx:77` mounts a *second, nested* `ThreadView` for the selected
worker. **[M]**

| file | lines |
|---|---|
| `src/App.tsx` | 1335 |
| `src/components/ThreadView.tsx` | 618 |
| `src/components/WorkTrace.tsx` | 409 |
| `src/components/Approvals.tsx` | 333 |
| `src/components/TranscriptRuntime.tsx` | 31 |
| `src/threadProjection.ts` | 323 |
| `src/feedStore.ts` | 966 |
| `src/wire.ts` | 724 |
| `src/conversationHistory.ts` | 13 |
| `src/index.css` | 1317 |

### 1.2 The row dispatch, and the empty runtime

There is **no switch**. Dispatch is a ternary chain at `ThreadView.tsx:414-464` over exactly two row
types. The `ThreadRow` union is two members (`threadProjection.ts:9-23`) **[M]**:

```ts
| { type: "message"; id; item: ChatItem; final?: boolean }
| { type: "work";    id; nodes: TraceNode[]; running; canCollapse; failures; count;
                     status; startedAt?; latestProgress?; durationMs? }
```

`TranscriptRuntime` is fed inert content (`ThreadView.tsx:323-335`) **[M]**:

```ts
content: row.type === "message" ? [{ type: "text", text: row.item.body }] : [],
```

— every `work` row gets `content: []`. The header comment at `:321-322` says so outright: *"The
runtime owns only viewport behavior."*

Other pinned behaviours in that file **[M]**:

- user clamp `:553-554` — `text.length > 480 || text.split("\n").length > 8` → `line-clamp-5` (`:560`),
  "Show more"/"Show less" at `:567-578`.
- user bubble `:557` — `ChatPanelUserMessage className="max-w-[85%] bg-elevated px-4 py-3 text-sm … sm:max-w-[75%]"`.
- changed files `:453-462`, only under `row.final && turn`, from `useSessionChanges(sessionId)` (`:229`).
- stop label `:491-493`, rendered *after the last row* when `!busy && lastStop && lastStop !== "end-turn"`;
  `stopLabel()` at `:502-513`.
- global thinking indicator `:488-490`, shown when `busy` and no work row is `running`.
- virtualization `:316` — `const virtualized = rows.length > 60 && !hasApprovals;`, `:317-319`
  `useVirtualizer({ estimateSize: () => 140, overscan: 6, enabled: virtualized })`, scroll element is
  the same `viewportRef` the aui `Thread` owns.
- scroll restore `:344-350` + `:365-380`, `localStorage` keys `brigadier:scroll:<id>` / `brigadier:expanded:<id>`.

### 1.3 `WorkTrace.tsx`

- 1 s tick only while live: `:58-64` `if (!row.running || row.startedAt == null) return;` then
  `setInterval(…, 1000)`. **[M]**
- turn header text is already Codex's vocabulary: `:72-81` `outcome` ∈ Working / Failed / You stopped /
  Stopped / Worked, `:82` `summary = outcome + (duration && (!running || elapsed >= 1000) ? " for|after " + duration : "")`.
  **No 60 s rule, and no `· done 3:04 PM` half.** **[M]**
- batching `:153-162` — adjacent nodes merge only if both are `tool-call`, not an agent, childless and
  carry no `actionRequests` entry. Label `activitySummary(group)` (`:187`), live label `activeWorkLabel(group)`.
- cap `:147` `useState(40)`, `:150` uncapped while an approval is pending, `:163-168` "Show earlier
  activity" / "Show more activity", +40 per click.
- `activitySummary` (`threadProjection.ts:283-308`) already produces the Codex sentence — "Edited
  files, read files, ran a command" — with a conservative `activityCategory` (`:265-281`) that maps
  `cat|head|tail|sed -n` → Read files and `rg|grep|find|ls` → Searched files. **[M]**

### 1.4 Approvals — two different "expired"

`Approvals.tsx` carries two representations, and conflating them is the single easiest way to break
the rule **[M]**:

| | source | meaning | lines |
|---|---|---|---|
| `approval.expired: boolean` | `ApprovalView.expired` (`wire.ts:431`) → `feedStore.ts:887` → `ApprovalItem` (`feedStore.ts:170`) | **still open but unanswerable** — the run that parked it is gone; card renders Dismiss-only | `Approvals.tsx:120`, `:259-270` |
| `decision === null` on a *resolved* history row | `ApprovalHistoryItem.decision: Decision \| null` (`src/components/approvalHistory.ts:5`) | **resolved with no decision recorded** — the third state | `Approvals.tsx:325`, label at `:328`, copy at `:330` |

Matching happens in `ThreadView.tsx`, not `Approvals.tsx`: `:301` pending and `:302` resolved, both on
`kind.type === "tool-permission" && kind.tool_call_id === node.item.id`, iterated over
`flattenTrace(row.nodes)` (`:300`). **[M]**

### 1.5 `TranscriptRuntime.tsx` (31 lines)

It owns **runtime selection**, not the viewport. `:10` read-only →
`AuiProvider + ReadonlyThreadProvider`; `:13-31` writable → `useExternalStoreRuntime({ messages,
convertMessage: m => m, isRunning: busy, isLoading: !loaded, onNew → bridge().sendTurn,
onCancel → bridge().interrupt })` inside `AssistantRuntimeProvider`. No virtualizer here. **[M]**

### 1.6 How bodies reach the UI — refetch, not push

`src/hooks/useConversationHistory.ts` **[M]**. Three triggers call `changed()`: a `store.subscribe`
callback comparing `store.getSessionCursor(sessionId)` (`:95-98`), the Tauri push event
`conversation-state-changed` (`:99`, emitted from `src-tauri/src/composer.rs:169`), and window `focus`
(`:100`). `changed()` schedules `read('updates')` after **100 ms**, or 80 ms when a read was already in
flight (`:36-39,86`). `read()` calls `workspaceApi.historyPage(sessionId, {after:cursor})`
(`src/workspaceApi.ts:105-112`) then `workspaceApi.chatTurns(...)` (`:113-114`). Bodies come from
**SQLite, by refetch** — there is no fixed poll on the body path. Two identity guards exist because a
fresh array re-rendered the whole transcript: `EMPTY_ITEMS`/`EMPTY_TURNS` (`:13-14`) and the
`JSON.stringify` turn compare (`:73`). Separately, `feedStore.ts:630-635` has a 250 ms `drainTimer`
fallback on the *rows* path (WKWebView pauses rAF when occluded), and `desktopApi.ts:129` polls session
changes every 3.5 s.

`src/conversationHistory.ts` is 13 lines — just `mergeHistory`.

Type locations, because they are not where a reader expects: `Event`, `ItemKind` and `Envelope` are in
`src/wire.ts` (`:104-149`, `:58-69`, `:164-173`); **`ChatItem` and `ChatTurn` are in
`src/workspaceApi.ts` (`:29-38`, `:40-47`)**, with `HistoryPage` at `:39`. The signal path and the body
path are distinct wire shapes from distinct commands. **[M]**

### 1.7 The wire, and the gaps — corrected three times

**Streaming deltas reach SQLite and stop there. Nothing tells the frontend a body grew.** The stale
survey said deltas never reach the store, which is wrong; this plan's first two drafts then said they
reach the UI, which is also wrong. The persistence half below is verified; the delivery half is the
gap, and closing it is a Rust work item (§4.2, phase 2 item 5). All of the following was read today
**[M]**:

- `crates/core/src/claude/adapter.rs:645-709` `on_stream` — `content_block_start` for `text`/`thinking`
  mints a synthetic id `"{session}:stream:{start_seq}:{generation}:{parent}:{index}"` and emits
  `Event::item_started`; `content_block_delta` emits `Event::ContentDelta { item_id, text }` bounded to
  128 KiB. `input_json_delta`, `signature_delta`, `content_block_stop`, `message_delta`, `message_stop`
  are dropped.
- `adapter.rs:711-735` `completed_block_id` **reuses the same streamed id** when the complete
  non-partial `assistant` frame lands, correlating by (parent, kind, message id) and taking the lowest
  stream index — so the completed body *replaces* the streamed one on the same row.
- `crates/store/src/feed.rs:294-296` `apply` dispatches **every** `Event::ContentDelta` to
  `StoreHandle::chat_content_delta` (`crates/store/src/writer.rs:369-372`).
- `crates/store/src/chat.rs:197-214` `append_delta` appends `text` to the existing `chat_items.body`,
  bumps the row's `seq`, and bumps `sessions.last_event_seq`. It is **replay-safe**: the `SELECT` is
  guarded by `seq<?3` plus a `chat_rewinds` exclusion, and
  `crates/store/tests/history_pages.rs:61-62` calls it **twice with the same envelope** and asserts
  the body is `"Message 2100 streamed"` — appended once.
- **And there the chain stops.** `src/feedStore.ts:689-692` `getSessionCursor` returns
  `` `${rowsTotal}:${lastEventSeq}:${busy}` ``, and a delta moves **none of the three**:
  - `crates/store/src/feed.rs:180` — `Event::ContentDelta { .. } => return None,` inside `terse_line`,
    documented as deliberate at `:145` (*"a fragment of a line already summarised by its item"*). So
    `crates/supervisor/src/batcher.rs:178-179`'s `if let Some(line) = terse_line(…) { counters.total
    += 1; … }` never fires, and `counters.total` is the only source of `rows_total`
    (`batcher.rs:229-231`). **`rowsTotal` does not move.**
  - `crates/supervisor/src/batcher.rs:44-58` `is_signal` does not list `ContentDelta`, and only
    signals advance `lastEventSeq` (`feedStore.ts:372-375`). **`lastEventSeq` does not move.**
  - `busy` moves on turn boundaries only.
  - The only other refetch trigger, `conversation-state-changed`
    (`src/hooks/useConversationHistory.ts:99`), is emitted from exactly one place,
    `src-tauri/src/composer.rs:169`, inside a composer-state mutation. Never on a delta.

  `crates/store/src/feed.rs:114` `kind` *does* class a `ContentDelta` as `FeedKind::Text` (`:125`),
  but `kind` is only called where `terse_line` returned a line (`batcher.rs:178-182`), so that arm is
  unreachable for a delta today.

So there is **no streaming wire gap and no streaming store gap, and a streaming *delivery* gap**. What
the user would see if the projection gate were lifted with nothing else changed: `content_block_start`
emits `ItemStarted`, which does produce a terse line (`feed.rs:175`) and one refetch ~100 ms later,
catching the first fragment; then silence, because `ItemUpdated` also returns `None` (`feed.rs:176`);
then the whole body at `ItemCompleted`/`TurnCompleted`. A long final answer with no interleaved tool
calls — the case streaming exists for — shows a frozen stub and then snaps. §4.2 closes this with a
coalesced per-session delta counter; `src/feedStore.ts` still needs no `content-delta` case in its
signal switch (`:377-462`), because the delta enters the snapshot as a counter, not as a row.

**The second half of the change is one line of projection policy** — `src/threadProjection.ts:174-178`
**[M]**:

```ts
let answerStart = meaningful.length;                // :174
if (!running) {                                     // :175 ← while running, answer is EMPTY
  while (answerStart > 0 && prose(meaningful[answerStart - 1]!)) answerStart--;
}
```

with the comment at `:172-173`: *"Claude's current normalized items have no commentary/final channel.
Only trailing main-session prose is a candidate answer; never infer one mid-run."* While the turn runs,
all prose stays inside the `work` row and surfaces only as `latestProgress` (`:208`, the last prose
node); `ThreadView.tsx:488-490` draws a global `ThinkingIndicator` instead. **This is a deliberate
decision, not an oversight**, and the comment is a warning about ordering, not about cost: lifting the
gate is what §4.2 and phase 3 do, under the three tests named there.

The other three gaps, all confirmed at `ea8d705` **[M]**:

| gap | evidence |
|---|---|
| **Bash exit code** | `ItemKind::ToolResult` carries only `{ tool_call_id, is_error }` (`wire.ts:62`). The CLI emits the code *only* as the literal first line of `tool_result.content` (`docs/research/cli-steer-and-exit-codes.md` §2). |
| **Usage window** | `rate_limit_event` is decoded at `crates/claude-wire/src/message.rs:81-82,871-876` as an untyped `rate_limit_info: Option<Value>` and consumed at `crates/core/src/claude/adapter.rs:613-630`, which calls `capabilities::record_usage` → `allowance::record` and emits a `RuntimeWarning` **only** when `status == "rejected"`. `grep -rn "rate_limit\|unifiedWindows\|utilization" src/` → **zero hits**. It does not cross the IPC boundary. |
| **Lifecycle rows** | `feedStore.ts:437-441` `session-compacted` sets only `lastMessage`; `:443-450` `runtime-warning`; `:452-461` `runtime-error` (status `failed` only when `fatal`); `:396-405` `session-exited`. None becomes a timeline row. |

Also true and useful: `feedStore.ts:414` stores `costUsd: e.cost_usd_cumulative` on `SessionRuntime`, and
**nothing in `src/` renders a dollar figure** — `grep -rn "total_cost_usd\|costUSD\|USD" src/` → zero.
`RunCard.tsx:32-34` carries the rule in a comment. **[M]**

### 1.8 Design system after the migration

- `src/components/ui/` — **28 files**, all Base UI copies of assistant-ui's design kit at `1a5da0f`
  (`src/components/ui/UPSTREAM.md`). `button` (58), `collapsible` (21), `skeleton` (13), `textarea` (18),
  `tooltip` (81), `dialog` (160), `avatar` (109), `kbd` (28), `sidebar` (713), … Every shadcn leaf the
  assistant-ui registry needs already exists. **[M]**
- `src/components/controls/` — 26 files (19 component `.tsx`, 2 `.ts` helpers, 5 tests), a
  brigadier-owned second layer over `ui/`: `overlay` 609, `sidebar` 529, `modal` 232, `search-dialog`
  139, `tabs` 137, `tooltip` 128, `native-menu.ts` 110, `disclosure` 88, `dialog` 80, `command` 48,
  `status` 43, `checkbox` 44, `details` 38, `collapsible` 37, `menu` 33, `native-menu-image.ts` 32,
  `input` 30, `textarea` 27, `kbd` 24, `sidebar-reveal` 23, `button-group` 10. Note
  `controls/dialog.tsx` re-exports pieces of `controls/modal.tsx`, **not** `ui/dialog.tsx`. **[M]**
- `src/components/assistant-ui/elements/` — 21 files + `elements.css` (73). Mostly brigadier-written
  shims: `markdown-text` 275, `message-actions` 139, `chat-panel` 130, `tool-call` 128,
  `reasoning-panel` 104, `syntax-highlighter` 83, `tooltip-icon-button` 76, `thread` 64, `composer` 54,
  `agent-plan` 52, `thinking-indicator` 42, `agent-status` 30, then stubs: `approval-card` 25,
  `artifact-card` 25, `subagent-list` 13, `background-inbox` 13, `checkpoint-history` 12,
  `todo-list` 8, `recommendation-card` 8, `agent-handoff` 7. **[M]**
- **Icons**: `src/icons/` has 75 glyphs + `index.ts` + `LICENSE.md` + `manifest.json` (78 entries),
  vendored from `@openai/apps-sdk-ui` by `scripts/vendor-icons.mjs`. **`lucide-react` and
  `@phosphor-icons/react` are absent from `package.json`** — the only `lucide` strings left in `src/`
  are prose in `UPSTREAM.md` and a comment at `WorkTrace.test.tsx:182` recording that the old
  `.lucide-check` assertion was replaced. **[M]**
- **`radix-ui` is gone from `package.json` entirely.** `@base-ui/react ^1.8.0` is the headless base;
  `src/components/ui/collapsible.tsx` imports `@base-ui/react/collapsible`. The ban in `CLAUDE.md` §5
  is now trivially satisfied, and `THIRD_PARTY_NOTICES.md`'s "Radix UI — MIT" section (which claimed
  "the installed shadcn Collapsible uses `radix-ui` 1.6.7") was **stale**. **Already fixed** by the
  phase-1 attribution worker in the uncommitted +63/−3 diff on that file, which also pre-registers
  the whole `## codex-ui-kit — MIT` section (§5, phase 3R). No phase in this plan edits that file.
  What the same diff *leaves* open — `licenses/base-ui-MIT.txt` and the now-unreferenced
  `licenses/radix-ui-MIT.txt` — is phase 3R's. **[M]**
- `components.json` — `"style": "base-nova"`, registry
  `https://r.assistant-ui.com/styles/{style}/{name}.json`. Base UI flavour is already selected. **[M]**

### 1.9 CSS token vocabulary — what the kit gets renamed **to**

`src/index.css` (1317 lines) is Tailwind v4: `@import "tailwindcss" source(none)` (`:1`),
`@source "./**/*.tsx"` (`:9`), `@import "tw-animate-css"` (`:4`), `@import "./focus-reset.css"` (`:5`).
Dark-only: `:root` carries dark values directly and there is **no light branch**; the
`@custom-variant dark (&:is(.dark *))` at `:15` exists but the palette never forks. **[M]**

Four layers, in this order:

1. **`:root` shadcn layer (`:30-186`)** — `--radius`, `--tint`, `--background #181818`,
   `--foreground #e3e3e3`, `--card #2b2b2b`, `--card-foreground`, `--popover #2b2b2b`,
   `--popover-foreground`, `--code-surface #1f1f1f`, `--primary #e3e3e3`, `--primary-foreground`,
   `--secondary rgba(255,255,255,.08)`, `--secondary-foreground`, `--muted rgba(255,255,255,.2)`,
   `--muted-foreground #a1a1a1`, `--accent rgba(255,255,255,.14)`, `--accent-foreground`,
   `--destructive #e07a7a`, `--border rgba(255,255,255,.08)`, `--input #2a2a2a`, `--ring #3b82f6`,
   `--chart-1…5`.
   Then the sidebar block (`:77-119`): `--sidebar rgb(40,40,40)`, `--sidebar-foreground #dfdfdf`,
   `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-accent rgba(255,255,255,.078)`,
   `--sidebar-accent-foreground`, `--sidebar-border rgba(255,255,255,.084)`, `--sidebar-ring
   rgba(131,195,255,.76)`, `--sidebar-width 275px`, `--sidebar-width-min 240px`, `--sidebar-row-height
   30px`, `--sidebar-row-radius`, `--sidebar-row-padding-x 8px`, `--sidebar-row-gap 3px`,
   `--sidebar-group-gap 8px`, `--sidebar-section-gap 16px`, `--sidebar-indent 28px`,
   `--sidebar-icon-size 16px`, `--sidebar-text-idle rgba(223,223,223,.85)`, `--sidebar-text-muted
   rgba(255,255,255,.498)`, `--sidebar-icon-active rgba(255,255,255,.904)`, `--sidebar-font-size 14px`,
   `--sidebar-font-weight 430`, `--sidebar-line-height 1.5`.
   Then `--tooltip*` (`:128-130`), `--settings-*` 17 tokens (`:138-154`), `--shadow-ink*` (`:160-163`),
   `--ansi-*` 15 (`:170-184`).
2. **`@theme inline` (`:190-250`)** — `--font-sans`, `--font-display`, `--font-mono`,
   `--tracking-hero`, `--tracking-section`, `--font-weight-hero`, then `--color-*` bindings for every
   shadcn name above, then `--shadow-2xs…2xl` all forced to `0 0 #0000`.
3. **`@theme static` (`:260-408`)** — `--spacing: 4px`; semantic colours `--color-canvas`,
   `--color-elevated`, `--color-sidebar`, `--color-input`, `--color-input-shell`, `--color-hairline`,
   `--color-hover`, `--color-selected`, `--color-pressed`, `--color-text`, `--color-text-secondary`,
   `--color-text-tertiary #7f7f7f`, `--color-text-disabled #676767`, `--color-attention`,
   `--color-warn #ef8c57`, `--color-ok #74b58a`, `--color-error`, `--color-backdrop`,
   `--color-menu-glass`, `--color-glass-edge`, `--color-shadow`, `--color-on-accent`,
   `--color-file-{ts,js,style,markup,doc,rust,media,text,unknown}`,
   `--color-starter-{explore,build,review,fix}`;
   radii `--radius-xs 4 / sm 6 / md 10 / lg 16 / xl 20 / 2xl 28 / 3xl 36 / full 9999 / none / page`,
   then semantic aliases `--radius-document, -surface, -thread, -capsule, -pill, -control,
   -control-lg, -icon-button, -icon-button-xs, -row, -row-action, -popover, -dialog, -tooltip,
   -keycap, -composer, -card, -tab, -chip, -thumbnail, -bubble, -badge, -glyph`;
   `--shadow-overlay`.
4. **`@layer base` (`:411+`)** and component CSS below.

Other `.css` under `src/`: `focus-reset.css`, `intro.css`, `window-chrome.css`,
`components/thread-context.css`, `components/settings.css`, `components/software-updates.css`,
`components/session-provisioning.css`, `vscode-panels/panels.css`,
`components/assistant-ui/elements/elements.css`.

**These line numbers are volatile while phase 1 runs.** They are the **committed** file: 1,317 lines;
`:root` `:30`; `@custom-variant dark` `:15`; `--sidebar` `:77`; `@theme inline` `:190`;
`@theme static` `:260`; `@layer base` `:413`. **[M]** The paint spike's throwaway two-line `@import`
was observed being removed and re-added at `:6-7` within the same hour on 2026-09-11 (arm
`spike-nofilechange.css` at the last check), and every number below shifts by **+2** while it is
there. **A phase-4 worker computes insertion offsets from the file, not from this section**, and
checks §5's spike-removal precondition first.

**Decision this settles:** the vendored kit's `--codex-ui-*` prefix is renamed to **`--thread-*`**,
declared in one block on `:root` in `src/index.css`, following the `--sidebar-*` precedent set by
`docs/research/codex-sidebar.md` §9. Colour tokens alias the existing `--color-*` layer wherever a
match exists; only genuinely new values (the diff greens/reds, the approval surface) get literals.

### 1.10 Virtualization

`@tanstack/react-virtual` is pinned `3.14.10` in `package.json` and used in exactly one live place:
`ThreadView.tsx:7,316-320`, under `rows.length > 60 && !hasApprovals`, with a full un-virtualized
fallback path when the flag is false. The only other call site, `Feed.tsx:123,237-240`, is dead. **[M]**

### 1.11 Tests that pin thread behaviour

| file | lines | `it(`/`test(` | assertion style |
|---|---|---|---|
| `src/components/ThreadView.test.tsx` | 552 | **19** | mixed — roles/text plus `querySelector` on `.aui-viewport`, `[data-message-id]`, `.aui-message` |
| `src/threadProjection.test.ts` | 359 | **16** | pure data — row types, ids, counts |
| `src/components/WorkTrace.test.tsx` | 260 | **9** | roles/text; `:182` records that the old `.lucide-check` class assertion was deliberately replaced |
| `src/components/Approvals.test.tsx` | 85 | **7** | roles/text (`getByRole("button", {name:/Allow/})`, "Expired") |
| `src/components/TranscriptRuntime.test.tsx` | 30 | **2** | runtime state via `useAui()` |
| `src/feedStore.test.ts` | 1078 | **47** | pure data |
| `src/components/RunCard.test.tsx` | 537 | **18** | roles/text; pins the no-dollar rule |
| `src/components/SubagentsPanel.test.tsx` | 124 | **5** | roles/text |
| `src/components/AgentElements.test.tsx` | 44 | **3** | element smoke tests |
| `src/dependency-hygiene.test.ts` | 37 | **1** | asserts no `cmdk`/`prompt-kit` in `package.json` or in any `src/**/*.tsx?` import, and that `src/components/ui/collapsible.tsx` exists |
| **`src/components/Feed.test.tsx`** | 579 | **26** | **tests dead code** |
| **`src/feedGroups.test.ts`** | 257 | **18** | **tests dead code** |

**`Feed.tsx` + `feedGroups.ts` are still dead.** `feedGroups.ts` has exactly one non-test importer,
`Feed.tsx:125`; `Feed.tsx` has **none** — `feedStore.ts:32` says so in its own comment: *"`src/components/Feed.tsx`
is the only real consumer and has no non-test importer."* 44 tests pin code the app never mounts. **[M]**

---

## 2. Decisions in force

Nine came with the order and are not re-litigated. D10–D20 are mine, each with a one-line reason.

| # | decision | why |
|---|---|---|
| **D1** | assistant-ui is the runtime and skeleton: `ExternalStoreRuntime`, `ThreadPrimitive` viewport/scroll, message parts including `data-*` parts routed by name. Hand-written row JSX goes away; rows become parts. | `ThreadMessageLike.content` accepts `{type:"data-<name>", data}` auto-converted to a `DataMessagePart`, routed by `components.data.by_name`; `thread.aui.tsx:441` already has `case "data": return part.dataRendererUI` (`docs/research/codex-ui-kit.md` §2.3, `docs/research/codex-thread-row-mapping.md` §0 (`:31-63`)). |
| **D2** | codex-ui-kit components are **vendored** for the rows where assistant-ui has no runtime-wired equivalent. The prep report's picks stand: 10 kit / 4 aui / 3 hybrid / 1 hand-built / 1 deferred. | 21 of 28 assistant-ui "elements" are a docs-site gallery taking `words`+`visibleWords`-style demo props and cannot be driven by a runtime without rewriting their prop surface (`docs/research/codex-thread-row-mapping.md` §0 (`:31-63`)). |
| **D3** | Codex **structure and geometry**, brigadier's own token names and font stack. **No OpenAI brand assets, fonts, logos or artwork.** The kit's five subagent avatar SVGs are OpenAI copyright and are not vendored. | `codex-ui-kit/src/assets/subagents/README.md` says the artwork "remains copyright OpenAI … not relicensed under the repository's MIT license"; the kit's `SOURCES.md` says do not ship OpenAI brand assets. The vendoring script already refuses `src/assets/**` (`docs/research/codex-thread-row-mapping.md` §3). |
| **D4** | Dark only. | `src/index.css` has no light branch at `ea8d705` **[M]**. |
| **D5** | Keep the Lexical composer (`src/components/composer/`, `PromptInput.tsx`). Reskin only. | `docs/plans/composer-redesign-2026-09-09.md:3` — delivered 2026-09-09 with six gates green. Do not take the kit's `AgentComposer`/`ComposerDock`. |
| **D6** | In scope: streaming text; Bash exit codes; compaction/error/exit/rate-limit rows; usage-window gauge; subagents inline **and** in a panel; queue + steer; "Worked for" only over 60 s with the done-time always; thinking as a collapsed "Thought for Ns"; exploration groups merging Read/Glob/Grep/LS; per-edit +A/−D from tool input. | the order. |
| **D7** | Approvals keep their semantics **exactly**: never optimistic, card clears only on `request-resolved`, resolved-with-no-decision is `Expired`. assistant-ui's `tool-fallback` optimistic `disabled={submitted}` is **not** adopted. | `CLAUDE.md` §5, `docs/vision.md` §9. `tool-fallback.aui.tsx:379` + 8 `disabled=` sites (`docs/research/codex-thread-row-mapping.md` §1, "Three specific landmines found in the registry source" (`:154-178`), landmine 1). |
| **D8** | Usage windows, never dollars. No dollar figure anywhere, though `result.total_cost_usd` is on the wire and `SessionRuntime.costUsd` holds it. | `docs/vision.md` §6; `RunCard.tsx:32-34`. |
| **D9** | `radix-ui` monolith only; no individual `@radix-ui/react-*`. **Now moot** — `radix-ui` left `package.json` in the Base UI migration; everything is `@base-ui/react`. | §1.8 **[M]**. |
| **D10** | **Token namespace is `--thread-*`**, one block on `:root` in `src/index.css`, aliasing the existing `--color-*` / `--radius-*` layer wherever a match exists. No `--codex-ui-*` name survives vendoring; no parallel palette. | Precedent: the sidebar port used `--sidebar-*` and mapped onto existing tokens (`docs/research/codex-sidebar.md` §9). Two palettes doubles the contrast-pair surface that `docs/STATUS.md:822-824` already found six failures in. |
| **D11** | **No `corner-shape: superellipse()`.** The 1.25 radius scale is folded into the literal px values (md 10 · lg 12.5 · xl 15 · 2xl 20/22 · 3xl 25); the squircle shape is not drawn. | Same deviation the sidebar port took, for the same reason — WKWebView support unverified (`docs/research/codex-sidebar.md` §9 "Deviations"). |
| **D12** | Kit CSS ships as a **per-component extraction** written to `src/components/thread/thread.css` and imported from `src/index.css`, never the kit's 566 KB `styles.css`. The extraction's paint cost is measured **before** any component is wired. | 566 KB against a 287–295 ms p50 exec→FCP budget already ~90 ms over is the one item that can kill the plan on evidence (`docs/research/codex-ui-kit.md` Part 3, open question 3 (`:533`), and `:277`; `docs/STATUS.md:344`). Measured extraction for the recommended set: 127,480 B CSS + 24,931 B tokens; **90,376 + 24,931** without `FileChange.tsx` (`docs/research/codex-thread-row-mapping.md` §3). |
| **D13** | **The Bash exit code becomes a typed wire field, parsed once in Rust.** TypeScript never regexes a tool body. Until the field lands, `exitCode` stays `undefined` — never inferred from `is_error`. | The CLI emits it only as text (`docs/research/cli-steer-and-exit-codes.md` §2). One parser in one language beats a regex duplicated on both sides of the IPC boundary, and `crates/store/src/feed.rs::kind` is already the precedent for "Rust owns the discriminator". |
| **D14** | **Compaction, runtime error/warning and session exit become synthetic `ChatItem`s written by the Rust store**, not a seq-keyed TypeScript overlay. | An overlay is a second ordering authority that does not survive a reload, and it is exactly how `Feed.tsx` became a parallel path nobody maintains (§1.11). `crates/store/src/chat.rs:135` is the single place to extend. |
| **D15** *(rewritten 2026-09-11)* | **Streaming needs one additive wire field and no new delivery path: a coalesced per-session delta counter.** Deltas already reach SQLite; nothing tells the frontend (§1.7). `SessionCounter` gains `deltas`, bumped in `batcher::push` and flushed with the counters that already ride every frame; `getSessionCursor` folds it in; `threadProjection.ts:175`'s `if (!running)` gate is then lifted so trailing prose renders as an in-flight answer row. **Do not** add `Event::ContentDelta` to `is_signal`. | The persistence half is verified: `feed.rs:294-296` → `writer.rs:369-372` → `chat.rs:197-214`, replay-guarded at `:201`, pinned by `crates/store/tests/history_pages.rs:61-62`. The delivery half was not: a delta produces no terse row (`feed.rs:180`) and no signal (`batcher.rs:44-58`), so `getSessionCursor` never moves. A counter is the cheapest fix that respects landmine 10 — the counter is already in every frame's message, so a delta adds a number, not a message. An envelope per token would be the exact flood the burn harness simulates. Full shape and cost in §4.2. |
| **D16** | The approval **chrome** is the kit's `ApprovalRequest`; the **state machine** in `Approvals.tsx` is untouched. `tool-fallback.aui.tsx` is not vendored at all. | `ApprovalRequest` takes `decision` and `loading` as host props, so the card can only show what the store says Rust confirmed; `decisionLabel` is how the third state prints "Expired" even though `ApprovalDecision` is a closed union (`docs/research/codex-thread-row-mapping.md` §2 row 12 (`:412-440`)). |
| **D17** | **Do not change the scroll owner.** `ThreadPrimitive.Viewport` keeps `viewportRef`, and `@tanstack/react-virtual` keeps its current condition. Any change here is measured in phase 5, not assumed. | assistant-ui's own virtualization guide says the built-in auto-scroll assumes every message is mounted and fights a virtualizer; WebKit 26.5 has no `overflow-anchor` (`docs/research/feed-rendering.md:186-192`); `ThreadView.test.tsx` reads the literal `.aui-viewport` class. Swapping scroll owners is the riskiest available change for zero visual gain. |
| **D18** | `src/components/Feed.tsx`, `src/feedGroups.ts` and their 44 tests are **deleted** in phase 5. | Dead at `ea8d705`, proven in §1.11, and `feedStore.ts:32` already documents it. |
| **D19** | **Subagents get no avatar artwork.** A name chip (initial + colour seeded from the worker id, reusing the `--color-file-*` hue set) stands in for the kit's `SubagentAvatar`. Progress stays **indeterminate**. | D3 forbids the artwork; `docs/research/chatgpt-subagents-and-brigadier-design-2026-09-09.md:271` already ruled that a fabricated completion fraction marks the wrong worker complete. |
| **D20** | Vendoring writes `licenses/codex-ui-kit-MIT.txt` and a `## codex-ui-kit — MIT` section in `THIRD_PARTY_NOTICES.md`, carrying the MIT text (`Copyright (c) 2026 JaminZhou`), the source commit, the prefix rename, and the verbatim "not affiliated with, sponsored by, or endorsed by OpenAI" notice. | `licenses/` + `THIRD_PARTY_NOTICES.md` is the established pattern for vendored source (three entries exist today) **[M]**. |

---

## 3. Target row catalogue — 19 kinds, two deferred

Column key: **src** = what produces it today · **impl** = aui element / vendored kit component /
hand-built · **shape** = the message-part or props contract · **tokens** = from `docs/research/codex-thread-tokens.md`.

Global geometry, every row inherits it (`docs/research/codex-thread-tokens.md` §1, §2, §13) **[M]**:

```
--thread-max-width      768px   (48rem)        --thread-item-gap        16px  (spacer div, not gap)
--thread-pad-x          16px                   --thread-grouped-gap      4px
--thread-pad-bottom     32px                   --thread-indent          24px  (ps-6 on nested bodies)
--thread-font-size      14px    --thread-line-height 22px   --thread-font-weight 430
--thread-font-size-sm   13px    --thread-md-line     22.75px (14 × 1.625)
--thread-code-size      13px    --thread-code-line   20px
--thread-md-space        3.5px  (= 14/4; the whole markdown rhythm)
```

Turns are `display: contents`; **all vertical rhythm is explicit spacer `<div>`s**, never `gap` on a
turn wrapper. The timeline is bottom-anchored by `flex-col-reverse` layout, not by scripted scrolling.
Activity rows have **no hover fill** — the only feedback is text 60 % → 100 %, the chevron fading in,
and the `+A −D` numbers *gaining* colour.

---

**1. User message** — *hybrid*
`src`: `ChatItem` with `kind.type === "user-text"` and no `parent_id` (`threadProjection.ts:231-235`).
`impl`: aui `MessagePrimitive` for identity / `data-message-id` / the edit composer; kit
`AgentMessage`'s bubble CSS; brigadier's existing clamp verbatim.
`shape`: an ordinary `role:"user"` message with one `text` part.
`collapsed`: clamped to 5 lines over 480 chars or 8 lines, "Show more".
`tokens`: right-aligned, **max-width 70 %** of the column, **radius 22 px**, padding **10 px × 16 px**,
background `color-mix(in oklab, #dfdfdf 5%, transparent)`, text `#dfdfdf`, 14 px/22.75 px. Action rail
below: `flex-row-reverse`, gap 4 px, 12 px text, `opacity-0 → 100` on `group-hover`/`focus-within`.
Today's `max-w-[85%] … px-4 py-3 sm:max-w-[75%]` (`ThreadView.tsx:557`) is wrong on all four numbers.
*Landmine*: the CLI never echoes user text (`docs/research/cli-steer-and-exit-codes.md` §1), so the optimistic row is the only
row and the client's id is the only id.

**2. Assistant answer (final, and streaming)** — *aui shell + brigadier's markdown*
`src`: trailing root `assistant-text` merged at `threadProjection.ts:216-222`. **Under §4.2 this row
also becomes the in-flight answer**, appearing with `streaming: true` and `final` unset while the turn
runs, then gaining the completed body on the same item id when it ends — no remount.
`impl`: aui `AssistantMessage` + `MessagePrimitive.GroupedParts`. **Do not take the kit's
`AgentMarkdown`** (1450 lines, pulls `react-markdown` + `highlight.js` + KaTeX) — brigadier already has
`src/components/Markdown.tsx` with a lazy chunk and `shiki`.
`tokens`: markdown root `--markdown-space 3.5px`; `p + p` 14 px; list indent 22.75 px, item indent
5.25 px; `h1` 21/28, `h2` 17.5/24.5, `h3` 15.75/24.5, `h4` 14/21; hr margin 24.5 px; code block
margin-block 17.5 px, radius 20 px, border `rgba(255,255,255,.042)`, fill `rgba(255,255,255,.052)`,
pad 16 px (20 px ≥768 px), `<code>` 13 px/20 px; inline code radius 6 px, pad 1 px 6 px, size `.92em`;
tables 13 px. Action row `mt-1.5 h-5 gap-0.5`.

**3. Commentary (interim prose)** — *hand-built*
`src`: mid-turn prose folded into the `work` row — `answerStart` stays at the end while the turn runs
(`threadProjection.ts:174-179`), so everything lands in `activity`; only trailing text is promoted,
and only once the turn stops (`:175-178`). Nothing on the wire says "commentary" — the projection
infers it positionally, which is why §4.2 makes *which* prose is promoted a tested behaviour.
`impl`: a `{ type: "data-commentary", data: { text } }` part rendered into the turn group's persistent
slot (kit `ActivityTimeline.persistentContent`).
`tokens`: assistant body type; the working line stays up after commentary and hides after the final
answer (`docs/research/codex-thread-anatomy.md` §3).

**4. Reasoning / thinking** — *aui*
`src`: `ChatItem` `kind.type === "thinking"`.
`impl`: aui `reasoning` element over `elements-reasoning` (fade mask, scroll-lock, per-part streaming
status), replacing `src/components/assistant-ui/elements/reasoning-panel.tsx` (104 lines).
`collapsed`: **"Thought for Ns"**, chevron hidden until hover.
`expanded`: body through the ordinary bubble container at `text-secondary`.
`tokens`: header `group flex items-center gap-1.5` (6 px), chevron `icon-2xs` 14 px,
`opacity-0 → group-hover:opacity-100`, `rotate-90` when open, `transition duration-relaxed` 0.3 s.
*Landmine*: empty-bodied thinking nodes are **deleted** and replaced by their children
(`threadProjection.ts:162-164`); the aui grouping must not resurrect them. On haiku with
`MAX_THINKING_TOKENS=0` there are no thinking blocks at all, and with thinking on the text can be
empty with only a signature (`docs/research/cli-steer-and-exit-codes.md` §3) — render nothing rather than an empty disclosure.

**5. Turn header — "Worked for"** — *kit `TurnDuration`*
`src`: `ChatTurn.started_at/ended_at/status` → `row.durationMs` (`threadProjection.ts:203-207`),
already ticking at `WorkTrace.tsx:58-64`.
`impl`: kit `TurnDuration` with brigadier's own label render-props. **Do not use aui
`message-timing`** — it returns `null` unless the runtime measured a token stream, and brigadier's
bodies come from a SQLite page.
`shape`: `{ status: "working"|"worked"|"stopped", startedAtMs?, completedAtMs?, durationMs? }`.
**New behaviour (D6):** "Worked for N" renders **only when the turn exceeded 60 s**; the **done time
always** renders (`· done 3:04 PM`, `· done Mar 3 at 3:04 PM` on other days).
`tokens`: `<span class="text-text/60 tabular-nums">` = `#dfdfdf` at 60 %; 1000 ms tick while working;
below the label a `w-full border-t border-default` hairline in `rgba(255,255,255,.084)`; the whole row
animates `{opacity, height}` at **300 ms `cubic-bezier(.19,1,.22,1)`**. Hover is **text-only** —
`ghostMuted` sets `hover:bg-transparent`; the label brightens 60 % → 100 %. Chevron `icon-2xs` 14 px at
`text-text/40`, `rotate-0 → rotate-90`, 0.15 s.

**6. Exploration group / activity fold** — *hybrid*
`src`: `TraceNode[]` batching at `WorkTrace.tsx:153-162`; sentence from `activitySummary`
(`threadProjection.ts:283-308`); live label from `activeWorkLabel` (`:310-323`).
`impl`: aui `MessagePrimitive.GroupedParts` + `groupPartByType` supplies `part.indices`/`part.status`;
kit `ActivityTimeline` + `AgentActivity` draw it, through `thread.aui.tsx`'s `ThreadComponents.ToolGroup`
override slot. **Do not take aui's `tool-group` trigger copy** — "N tool calls" is a count, not Codex's
sentence.
`shape`: `ActivityTimeline { summary: ReactNode, collapsedCount?, persistentContent?, preToggleContent?,
showToggle?, open/defaultOpen/onOpenChange }`; each row `AgentActivity { kind: command|file-change|
reasoning|search|subagent|tool|generic, status, summary, detail?, indicator?, disclosureMode }`.
Merge rule (`docs/research/codex-thread-anatomy.md` §3): a new call joins the open group **only if every action in it
is read/list/search**; the group closes when any other row appears; consecutive reads collapse with
duplicates removed. brigadier classifies by tool name — Read/Glob/Grep/LS → exploration — because there
is no server-side `commandActions[]`.
`tokens`: header `inline-flex items-center gap-1.5` (icon↔label **6 px**), label↔chevron **4 px**,
14 px, `text-text/60`; a full-bleed absolutely-positioned `<button class="absolute inset-0 rounded-md">`
is the hit target; body indent `ps-6` = **24 px**; expanding scrolls to keep the header still for
**350 ms** or until the first wheel/touch/pointer/key event. Verb tense flips on completion:
Running→Ran, Exploring→Explored, Calling→Called, Searching→Searched.

**7. Command execution** — *kit `CommandExecution` + `CommandOutput`*
`src`: `tool-call` named Bash, paired with its `tool-result` at `threadProjection.ts:122-135`; the
command string is inside the tool input (`activityCategory` already parses it, `:265-281`).
`impl`: kit.
`shape`: `{ command, status: AgentItemStatus|"interrupted"|"background-running"|"background-finished",
exitCode?: number, durationMs?/startedAtMs?/completedAtMs?, cwd?, summary?, detail?, footer? }`;
`CommandOutput { stream: "stdout"|"stderr", copyText, onCopy, emptyLabel }`.
`collapsed`: `• Ran <cmd>` with the command in `font-mono` inside the header.
`expanded`: scrollable `<pre><code>` with top/bottom scroll fades.
`tokens`: output cap **20 lines** (`collapsedLineCount = 20`; 2 in the compact summary), collapsed box
`maxHeight: "{n}lh"` re-measured and rounded **up** so a code block is never cut mid-block; trailing
`…` ellipsis when the cap > 2; toggle `mt-1.5 self-start text-size-chat text-codex-description`,
"Show more"/"Show less"; offscreen focusables get `inert` + `aria-hidden`. Non-zero exit → red.
*Depends on*: §4's exit-code field (D13). Per-call duration is derivable from `ChatItem.at` on call and
result; nothing computes it today.
*Landmine*: stdout and stderr **cannot** be shown in separate panes on failure — they are already
merged, stderr after stdout with no delimiter, by the time the frame is written.

**8. File-change card** — *kit `FileChangeGroup` only*
`src`: `desktopApi.changes(sessionId)` per-turn `files[]` with `added`/`deleted`, polled every 3.5 s
(`desktopApi.ts:129`), attached only under a final answer (`ThreadView.tsx:453-462`). **New (D6):**
per-edit `+A/−D` derived from the Edit/Write tool *input* so an edit row carries its own numbers
without waiting for the poll.
`impl`: kit `FileChangeGroup` + `FileChangeStats` + `StatusIndicator`, hand-extracted after the script
runs. **Do not vendor the rest of `FileChange.tsx`** — `FileReview`, `FileReviewWorkspace` (491 lines),
`FileRevertErrorDialog` drag in `Dialog.tsx` (355) and `InteractivePrimitives.tsx` (1312) and cost
**+37,104 bytes of CSS**, and brigadier has no per-file `diffText` to put in the expanded body anyway.
`tokens`: card `rounded-lg` = **12.5 px**, 1 px `rgba(255,255,255,.084)`, `overflow-hidden`; header
`px-2.5 py-0.5` (10/2 px), 13 px, fill `rgba(255,255,255,.078)` at 60 %, text
`rgba(255,255,255,.398)`; body `rgb(40,40,40)`; **16 px** between file cards.
Diff stat: `+A` **`#40c977`**, `−D` **`#fa423e`** — *coloured at rest on the card* (`variant="color"`),
but **colourless until hover on an activity row** (`variant="agent-activity"`), and hovering a file
link inside the row suppresses the brighten entirely. Tints `rgba(64,201,119,.23)` /
`rgba(250,66,62,.23)`.
*Not found in the bundle*: a Review or Undo button pair on this card — the only header control is copy
(`docs/research/codex-thread-tokens.md` §7, §14). Do not invent one.

**9. MCP / tool call** — *hybrid, leaning kit*
`src`: `tool-call` + `tool-result` paired at `threadProjection.ts:122-135` (the result's own node is
suppressed by design).
`impl`: a named tool renderer taking aui part props (`args`, `result`, `status`, `approval`,
`respondToApproval`) and drawing them with kit `ToolCallCard` / `McpToolCallGroup`. **`tool-fallback.aui.tsx`
is not vendored at all** (D16) — write a small brigadier fallback instead.
`shape`: `ToolCallCard { name, source?, status, summary?, result?, error?, errorPresentation:
"alert"|"output", rawOutput?, structuredContent?, accessory?, activeLabel/completedLabel/failedLabel,
collapsible, open? }`.
`tokens`: activity-row tokens (row 6); result text `text-text/30` under a `text-text/60` question.

**10. Web / code search** — *kit `SearchActivity`*
`src`: no `ItemKind` variant — Claude Code's `Grep`/`Glob`/`WebSearch`/`WebFetch` arrive as ordinary
`tool-call`s. A tool-name → component map gets this free; **no wire change**.
`shape`: `{ kind: "code"|"web", query?, path?, entries: {id, detail, completed?, faviconUrl?}[],
status, onEntryOpen? }`.
`tokens`: activity row + magnifier icon; verb phrase "Searched the web for …".

**11. Subagent rows** — *kit `SubagentActivity` + `SubagentActivityGroup`, no avatars*
`src`: `ItemKind::Subagent { task_id, subagent_type, description }` folded at
`threadProjection.ts:106-115` with cycle detection at `:140-156`.
`impl`: kit chips inline in the thread; the existing `SubagentsPanel.tsx` (5 tests) stays as the panel —
**do not take the kit's `SubagentPanel`**, and do not take `SubagentAvatar` (D3/D19).
`shape`: `SubagentActivityGroup { items: {id, name?, activityStatus: "active"|"updated"|"interrupted"|
"done", status?, statusSummary?}[], maxVisible?, statusLabel?, animateEntrance?, onOpen? }`.
`tokens`: `flex items-start gap-1.5`, 14 px/20 px; chip strip `h-5` with 6 px gaps; **at most 4 chips**
rendered, names for the first 2 when >3 agents; chip entrance `0.28s cubic-bezier(.23,1,.32,1)`,
inert under reduced motion; nested-agent rail `ps-6` (24 px indent) with a 4 px rounded rail in
`--color-border` and 24 px between entries. `additions`/`deletions` stay undefined; progress stays
indeterminate.
*Structural mismatch to keep in view*: Codex subagents are first-class threads with a `parentThreadId`;
Claude Code's surface as a `Task` `tool_use` in the parent stream.

**12. Approval card** — *kit `ApprovalRequest`, brigadier's state machine untouched*
`src`: pending from `store.approvals`, resolved from `composer_approval_history`, matched by
`kind.tool_call_id === node.item.id` (`ThreadView.tsx:301-302`).
`impl`: kit `ApprovalRequest` + `ApprovalCommandPreview` + `ApprovalFilePreview`, **for the pending
card only**. `decision` and `loading` are **host props** — `loading` means "sent, awaiting
`request-resolved`", and there is no local `submitted` state anywhere.
`shape` (kit's own, as vendored): `{ title, description?, details?, reason?, kind?, decision?:
"pending"|"approved"|"rejected", decisionLabel?, loading?, disabled?, onApprove?, onReject?,
approveLabel?/rejectLabel?, approveShortcutLabel?/rejectShortcutLabel?, showShortcutHints?,
disableHotkeys?, scopedApproveAction?, presentation: "composer"|"default", autoFocus? }`.

**The two "expired" notions stay separate (§1.4, landmine 5), and the kit's prop surface is *extended*
rather than the notions collapsed. [M]** That surface as shipped can express neither of them: it has
no dismiss action and its `decision` union has no third member.

- **`approval.expired` — open but unanswerable.** Today: `Approvals.tsx:120` `const readOnly =
  approval.expired;` → a **Dismiss-only** card at `:259-270`, plus the `expired: no longer answerable`
  chip at `:199-203`. The vendored `ApprovalRequest` gains, as a brigadier modification recorded in
  `src/components/thread/UPSTREAM.md`: a third `decision` value `"expired"`, and an `onDismiss?` /
  `dismissLabel?` pair rendered in place of approve/reject when it is set. `disabled: true` alone is
  **not** sufficient — a disabled Approve/Deny pair is a card the operator cannot clear.
- **`decision === null` on a resolved row — resolved with no decision.** This is **not** an
  `ApprovalRequest` at all. `ApprovalResolution` (`Approvals.tsx:322-332`) keeps its own markup, its
  `<details>/<summary>` structure and its summary string **verbatim**: `` `${expired ? "Expired" :
  allowed ? "Approved" : "Denied"} · ${name}` `` (`:328`), with the body copy at `:330`.
  `src/components/Approvals.test.tsx:69-76` asserts the literal `Expired · MCP · brigadier` and the
  `/No approval decision was recorded/` body; **both must pass unmodified.** If a row-catalogue choice
  cannot satisfy that, phase 4 says so in its report and stops — it does not edit the test.
- `decisionLabel` is therefore **not** how the third state prints. It stays available for the pending
  card's own labels and is never used to migrate a receipt into a request.
`tokens`: **radius 25 px**, background **`rgb(45,45,45)`**, 1 px `rgba(255,255,255,.084)`; header pad
`16 16 12`, actions pad `8 16 16`, gap 8 px; title 14 px/500/20 px, subtitle 13 px
`rgba(255,255,255,.498)`. Buttons **28 px tall**, 8 px side pad, 13 px/18 px: Approve `primary` = fill
`#dfdfdf`, label `rgb(45,45,45)`, hover `#dfdfdf` at 80 %; Deny/Always-allow `outline` = fill
`rgba(255,255,255,.032)`, hover `rgba(255,255,255,.078)`. **Enter approves, Escape denies**; hotkeys
suppressed while focus is inside `input, textarea, [contenteditable]`, and `autoFocus` is conditional
on the same check. Keycap chip: 16 px tall, min 16 px wide, radius 10 px, `currentColor` at 10 %,
12 px/16 px, 6 px side pad; hidden below container `md`.
*Audit required*: the kit installs **global Enter/Escape handlers** scoped to the topmost surface and
does outside-click dismiss. Both must be checked against the Lexical composer's key handling;
`disableHotkeys` exists for exactly that.

**13. Compaction notice** — *kit `ThreadContextOptimization`*
`src`: **missing today** — `session-compacted` only sets `lastMessage` (`feedStore.ts:437-441`).
Needs D14's synthetic `ChatItem`.
`shape`: `{ mode: "automatic"|"manual"|"work", status: "running"|"completed", label?, icon? }`.
`tokens`: **not a banner** — an ordinary activity row with an `icon shrink-0 text-text/60`; completed
renders plain text, in-progress renders inside the shimmer wrapper. Copy: *Context compacted* /
*Compacting context*; *Context automatically compacted* / *… compacting*.

**14. Error / interrupted notice** — *kit `Notices` + `ThreadInterruptionSummary`*
`src`: interrupted **exists** (`session.lastStop` → `stopLabel`, `ThreadView.tsx:491-493`);
`runtime-error`/`runtime-warning` are store-only (`feedStore.ts:443,452`) — a fatal error is invisible
in the transcript. Needs D14.
`shape`: `StatusBanner { tone: "neutral"|"info"|"warning"|"error", layout, heading?, icon?, actions[],
onDismiss? }`; `InlineNotice { tone, icon?, shimmering?, trailingContent?, wrap? }`;
`ThreadInterruptionSummary { durationMs, stoppedLabel? }`.
`tokens`: in-thread error card `rounded-lg border border-default bg-surface px-4 py-3 text-sm
text-secondary` with a `mb-2 font-medium text-default` title; inline status strip `flex items-center
justify-center gap-2 px-4 py-1 text-sm text-secondary` with an `icon-xs`. Interrupt copy:
*Interrupting* / *Interrupted* / *Failed to interrupt*, plus the divider's *You stopped after {time}*.

**15. Queued / steer strip** — *kit `QueuedPromptList` into the existing composer*
`src`: the durable Rust queue via `composerApi` + `useDurableComposer`; 13 queue tests.
`shape`: `{ items: {id, text, status?, attachmentSummary?}[], interrupted?, queueingEnabled?, onDelete?,
onEdit?, onReorder?(activeId, overId), onResume?, onSendNow?, onQueueingChange? }`.
`tokens`: list `max-h-[30dvh]`, **1 px** between rows, vertical fade mask, hidden scrollbar; rows
`px-2.5 py-0.5` (10/2 px), 14 px, min height 28 px, `rgba(255,255,255,.498)`; drag handle activates
after **6 px**; message text `line-clamp-1 leading-5 text-secondary`; interrupted header *Queue paused
because you interrupted* + *Resume*, followed by a `border-t border-subtle`. Rail: 13 px inline margin,
0.3 s transition forced to 0 s under reduced motion, `border-start radius 20 px` when placed above.
**Measured reality check (`docs/research/cli-steer-and-exit-codes.md` §1):** a `user` frame written mid-turn is **steered into
the running turn**, not queued — the assistant answers it before the first `result`, with
`queued_turn_count: 0` and nothing on the wire announcing a queued state. `still_queued`/`cancelled`
came back **empty in both directions** even when a message was demonstrably pending. So brigadier's
queue is brigadier's own durable queue, and the only real wire distinction is:
plain `interrupt` = "stop, then do the thing I just said"; `interrupt` with `cancel_queued: true` =
"stop and forget it". That is the Esc / Esc-Esc split.

**16. Review banners** — *deferred*
No brigadier concept, no data, no component. Codex's `>> Code review started <<` bracket rows are not
drawn by either library. Out of scope.

**17. Usage-window gauge** — *aui `elements-quota-banner`, adapted*
`src`: **missing end to end** — see §4.3.
`impl`: aui `elements-quota-banner` with `upgradeLabel`/`onUpgrade` **deleted**.
`shape`: `{ used, limit, unit, resetsIn }` — no currency anywhere. Feed it `five_hour.utilization`
(a 0–1 fraction) and `resetsAt` (unix seconds). Two windows: 5-hour and 7-day.
`reads`: **`getUsageWindows(sessionId)` through its own `useSyncExternalStore`, not `getState()`** —
the windows deliberately do not live on the React snapshot (§4.3, landmine 12). This component is the
only subscriber; a re-render here must not be a re-render of the shell.
Do **not** take `context-display` (`composer-redesign-2026-09-09.md:11` forbids building the
experience around a filling context window) and do **not** take the kit's `UsageSettings` (it prints a
plan price and a credit balance).
*Reserve*: `docs/vision.md` §6 sets a reserve near 80 %; the gauge must make that line visible.
*Contradiction to record*: `docs/vision.md` §6 says exactly **one** `rate_limit_event` fires **per
session** at 804–984 ms; `docs/research/cli-steer-and-exit-codes.md` §3 measured **one per turn** at t ≈ 1.0–2.5 s. The probe is
newer and used the current CLI (2.1.267). Treat "at least one per turn, early" as the safe reading and
make the UI idempotent under repeats.

**18. Jump to latest / scroll anchoring** — *aui*
`ThreadPrimitive.ScrollToBottom` + `ThreadPrimitive.Viewport turnAnchor="top"`, which
`src/components/assistant-ui/elements/thread.tsx` already uses. May be dressed with the kit's
`ThreadFloatingButton` chrome (a pure presentational button). Per D17 nothing structural changes here.

**19. `user-input` request — a provider question** — *deferred, with its trigger* **[M]**
`src`: `RequestKind` has a member no row in Codex's catalogue corresponds to:
`src/wire.ts:81` `| { type: "user-input"; prompt: string; options: string[] }`, mirroring
`crates/core/src/event.rs:459-464`. It is **not dead code, but it is unproduced**: the only
constructions in the tree are test helpers (`crates/core/src/approval.rs:224` inside `mod tests`,
`crates/core/src/event.rs:770` inside the `#[cfg(test)]` block at `:519`). No adapter path emits one,
because the Claude Code control protocol has no "ask the operator a question" request that brigadier
maps to it; it exists for a future provider (`docs/vision.md`'s provider trait).
*What happens today if one arrived*, contrary to the review that flagged this: it is **not** invisible.
`feed::terse_line` gives it a row (`crates/store/src/feed.rs:185`, `question · {prompt}`); the store
opens it like any request; `Approvals.tsx` renders the heading `question` (`:191`) and the body
`<pre>{kind.prompt}</pre>` plus an `options:` line (`:247-253`); and because `ThreadView.tsx:301-302`
matches only `tool-permission` kinds, it falls through to the tail render at `ThreadView.tsx:495`,
which draws every unmatched pending request under the transcript.
*Deferred, and why*: it can only be answered allow/deny — there is no "pick option *k*" decision on
`Decision` (`wire.ts:84-86`, *"there is deliberately no `allow-always`"*), so a real multiple-choice
row needs a wire decision that does not exist. **Trigger to un-defer**: the first provider that emits
`RequestKind::UserInput`, at which point it needs a `Decision` variant carrying the chosen option and
a row of its own. Until then phase 4 must not remove the tail-render fallback that keeps it reachable.

This makes the catalogue **19 entries, two of them deferred** (row 16 review banners, row 19
`user-input`). Every other union member is accounted for: `ItemKind`'s six (`src/wire.ts:58-69`) map
to rows 1/2/4/7/9/11, and the `Event` union's fourteen (`:104-149`) to rows 5/13/14 plus §4.4, with
`item-updated` deliberately silent.

### 3.1 The shimmer, once, for every row that uses it

Working line, compaction-in-progress and any "still running" label share one treatment
(`docs/research/codex-thread-tokens.md` §11.1) **[M]**. It is **not a blinking dot**: a sweep over the label text,
**600 ms delay before the first sweep, 1000 ms per sweep, repeating every 4000 ms**, painted with
`background-clip: text` + transparent fill and a `linear-gradient(90deg, #0000 0%, #000 20% 30%,
#0000 50% 100%)` mask translated ±50 % → ±125 %. Label is `14px / 22px`, truncating, `select-none`.
The whole cadence returns early under `prefers-reduced-motion`, and both keyframe sets carry
`animation: none` in a reduced-motion media query. Hovering kills it.

Motion tokens: `--thread-duration-basic .15s`, `--thread-duration-relaxed .3s`,
`--thread-ease-enter cubic-bezier(.19,1,.22,1)`, `--thread-ease-exit cubic-bezier(.8,0,.4,1)`,
`--thread-ease-enter-snappy cubic-bezier(.23,1,.32,1)`.

---

## 4. The wire contract

Pinned here so the Rust worker (phase 2) and the TypeScript worker (phase 3) build against the same
shapes concurrently. **Any change to this section is a change to `docs/plans/ipc-contract.md` and to
`src/wire.ts` in the same commit.** Rust is the source of truth for every discriminator
(`crates/store/src/feed.rs::kind` is the precedent).

**§4.2 was rewritten on 2026-09-11** after the review showed the old version told phase 2 not to build
the one piece streaming needs. This section is settled, not frozen: a worker who finds it wrong files
a question and stops, exactly as the review did — that is how this amendment exists.

### 4.1 Bash exit code — new field on `ItemKind::ToolResult`

**Measured shape of the input** (`docs/research/cli-steer-and-exit-codes.md` §2, `transcripts/exitcode.jsonl:39,45`):

```jsonc
// failure, exit 3
{"type":"user","message":{"role":"user","content":[
   {"type":"tool_result","content":"Exit code 3\nout\nerr","is_error":true,"tool_use_id":"toolu_…"}]},
 "tool_use_result":"Error: Exit code 3\nout\nerr"}          // ← a STRING on failure

// success
{"type":"user","message":{"role":"user","content":[
   {"type":"tool_result","content":"ok","is_error":false,"tool_use_id":"toolu_…"}]},
 "tool_use_result":{"stdout":"ok","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}
```

Facts that bind the implementation **[M]**:

- There is **no numeric exit-code field anywhere**. `exitCode`, `exit_code`, `returnCode`: 0 hits across
  all six transcripts. The only carrier is the literal first line `Exit code 3\n` of
  `tool_result.content`.
- `is_error` sits on the **content block**, not the frame.
- stderr is concatenated **after** stdout in the same `content` string with **no delimiter**.
- `tool_use_result` (snake_case; `toolUseResult` camelCase: 0 hits) is a frame-level **sibling of
  `message`** and its type is unstable — it **must** be typed `object | string`:
  success → `{stdout, stderr, interrupted, isImage, noOutputExpected}`; non-zero exit → the string
  `"Error: " + content`; interrupted tool → the string `"User rejected tool use"`.

**Rust (phase 2).** In `crates/claude-wire`, type the sibling as
`#[serde(default)] tool_use_result: Option<ToolUseResult>` where

```rust
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ToolUseResult {
    Structured { stdout: Option<String>, stderr: Option<String>, interrupted: Option<bool>,
                 #[serde(rename = "isImage")] is_image: Option<bool>,
                 #[serde(rename = "noOutputExpected")] no_output_expected: Option<bool> },
    Message(String),
}
```

In `crates/core/src/event.rs`, extend the variant — **additive, both fields optional**:

```rust
ItemKind::ToolResult {
    tool_call_id: ItemId,
    is_error: bool,
    /// Parsed from the literal first line `Exit code N\n` of the result body. `None` when the body
    /// carries no such line — never inferred from `is_error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    /// Set when the result was produced by an interrupt rather than by the command failing.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    interrupted: bool,
}
```

The parser is one function, `^Exit code (\d+)\n` anchored at byte 0 of `content`, applied only when
`is_error` is true, with a pinned unit test for: exit 3, exit 0, absent line, a body that merely
mentions the phrase later, and a non-Bash tool. `interrupted` is true when `tool_use_result` is the
string `"User rejected tool use"`.

**TypeScript.** `src/wire.ts:62` becomes

```ts
| { type: "tool-result"; tool_call_id: string; is_error: boolean;
    exit_code?: number | null; interrupted?: boolean }
```

Both optional, so a build that predates the Rust change still type-checks. **TypeScript never parses a
tool body.** Until the field lands, the UI leaves `exitCode` undefined.

### 4.2 Streaming deltas — **one additive counter field, and a tested projection change**

**Rewritten 2026-09-11. The previous version of this subsection was wrong** and told phase 2 not to
build the one missing piece; §1.7 carries the corrected evidence. What is true, and what is not:

- **True, verified.** `Event::ContentDelta { item_id, text }` exists on both sides
  (`crates/core/src/event.rs:263`, `src/wire.ts:144`); the adapter emits it from `stream_event`-wrapped
  `content_block_delta` (`adapter.rs:691-705`); the store persists it, `feed.rs:294-296` →
  `writer.rs:369-372` → `chat.rs:197-214`, appending to `chat_items.body`, replay-guarded by `seq<?3`
  at `:201` and pinned by `crates/store/tests/history_pages.rs:61-62`.
- **False, and the reason this section changed.** The refetch path does **not** deliver it. A delta
  produces no terse row (`feed.rs:180`), so `rowsTotal` does not move; it is not a signal
  (`batcher.rs:44-58`), so `lastEventSeq` does not move; `conversation-state-changed` fires only from
  `src-tauri/src/composer.rs:169`. `getSessionCursor` never changes and no refetch is scheduled.

**Do not** add `Event::ContentDelta` to `is_signal`. One envelope per token on a channel with an
asserted `< 8000` byte per-message check and a 0-dropped-vsync gate is exactly the flood the burn
harness simulates (landmine 10). The fix is a **coalesced counter bump** instead.

#### 4.2.1 The counter — Rust, phase 2

`SessionCounter` (`crates/supervisor/src/wire.rs:69-76`) gains one field:

```rust
pub struct SessionCounter {
    pub session_id: String,
    pub rows_total: u64,
    pub rows_dropped: u64,
    /// Content deltas seen for this session, ever. A cursor, not a quantity anyone reads: it exists
    /// so the UI can tell that a body grew without a row or a signal being spent on each fragment.
    pub deltas: u64,
}
```

- **Where it is incremented.** `crates/supervisor/src/batcher.rs::push` (`:165-191`), in the same
  `match &env.event` that already sets `started`/`ended` (`:172-176`):
  `Event::ContentDelta { .. } => counters.deltas += 1`. It is **not** inside the
  `if let Some(line) = terse_line(…)` block (`:178`), which a delta never enters, and it is
  incremented **whether or not the project is visible** — the same rule `counters.total` follows, so
  an invisible project's session still shows a grown body the moment it is looked at again.
- **How it coalesces.** It does not need new coalescing: `flush_once` already emits **one**
  `SessionCounter` per touched session per frame (`:229-233`), so a frame carrying 40 deltas carries
  one counter whose `deltas` advanced by 40. `Counters` is per-session and pruned with the session
  (`:60-79`, `prune` at `:102-105`); nothing new is retained.
- **What it costs.** Zero extra messages and zero extra rows. One `u64` in a struct that already
  ships in every frame a session is touched in: `"deltas":1234` is ~16 bytes of JSON per touched
  session per frame, inside the existing `MAX_MESSAGE_BYTES = 8000` / `MAX_ROWS_PER_MESSAGE = 24`
  packing (`batcher.rs:26,29`). At a realistic rate — a 600-token answer arriving as ~600 text
  deltas over ~20 s, i.e. ~30 deltas/s against a 16 ms frame (`DEFAULT_FRAME_INTERVAL`, `:39`) — that
  is **at most one counter per frame either way**, so the whole turn's streaming costs the bytes it
  would have cost anyway plus one integer per frame. Compare the rejected alternative: promoting
  `ContentDelta` to a signal would ship ~600 envelopes, each carrying its text, at ≥ 8000 bytes per
  message it is several messages per frame — the 8 KB cliff, hit 600 times a turn. **[A]** the delta
  rate; the byte arithmetic and the caps are **[M]**.

#### 4.2.2 How the frontend reads it — TypeScript, phase 2 mirror + phase 3 store

```ts
// src/wire.ts — the mirror. `deltas` is OPTIONAL on the TS side even though Rust always writes it,
// so `src/feedStore.test.ts`'s existing counter literals still type-check unmodified.
export interface SessionCounter { session_id: string; rows_total: number; rows_dropped: number;
                                  deltas?: number }
```

1. `feedStore.applyBatch`'s counters loop (`src/feedStore.ts:516-526`) stores `c.deltas ?? 0` on the
   live session map beside `rowsTotal`/`rowsDropped`, under the same "did it move" guard.
2. `getSessionCursor` (`:689-692`) folds it in:
   `` `${rowsTotal}:${lastEventSeq}:${deltas}:${busy}` ``. It reads the **live map**, which the drain
   updates on the frame the counter arrives, so the token is already at frame resolution.
3. One new dirty flag beside `signalsDirty` (`:237-240`) — call it `deltasDirty` — set when a
   counter's `deltas` moved, and added to the `else if (signalsDirty || rowsChanged)` arm at
   `:608-611`. This wakes `subscribe` callbacks **without rebuilding the snapshot**, exactly as a
   signal does. `countersDirty` alone must **not** be used for this: it is throttled to
   `COUNTER_FLUSH_MS = 500` (`:107`, `:599`) and `src/feedStore.test.ts:463` pins a held counter as
   silent — that test must keep passing, so a batch whose only movement is `rows_total` stays silent
   while a batch whose `deltas` moved notifies.
4. `useConversationHistory`'s subscriber (`src/hooks/useConversationHistory.ts:95-98`) then sees a
   changed token and calls `changed()`, which debounces **100 ms** (`:36-39`, 80 ms when a read was
   already in flight). So prose grows at ~100 ms granularity, the same granularity the rest of the
   body path already runs at, and the refetch count for a 20 s streaming turn is bounded by ~200
   `historyPage`+`chatTurns` pairs — the burn already sustains 534–544 history responses in 63 s
   (`useConversationHistory.ts:92-93`, **[M]** there), so this is inside measured territory, and
   phase 5's burn is where it is proven rather than asserted.
5. `deltas` is a cursor, not a rendered field: nothing may draw it. It arrives on the counters path,
   so it inherits `rowsTotal`'s throttling into the React snapshot and needs no `CURSOR_FIELDS` entry
   (`:119-122` documents exactly this distinction).

**Both halves ship together or neither does.** The counter with no projection change streams nothing
visible; the projection change with no counter renders a stub that never grows. §5 sequences them:
phase 2 owns 4.2.1, phase 3 owns 4.2.2 items 1–4 and §4.2.3, and phase 3 cannot prove its streaming
test without phase 2's field — see phase 3's "depends on phase 2" note.

Raw event vocabulary the CLI emits under `--include-partial-messages`, recorded here so nobody has to
re-measure it (`docs/research/cli-steer-and-exit-codes.md` §3): every partial is
`{"type":"stream_event","event":{…},"session_id","parent_tool_use_id","uuid"}` wrapping a raw
Anthropic event — `message_start`, `content_block_start` (`content_block.type` ∈ text | tool_use |
thinking), `content_block_delta` (`delta.type` ∈ `text_delta` | `input_json_delta` | `thinking_delta` |
`signature_delta`), `content_block_stop`, `message_delta`, `message_stop`. brigadier's adapter handles
`text` and `thinking` only. **The complete non-partial `assistant` frame is also emitted** — the
adapter's `completed_block_id` reuse (`adapter.rs:711-735`) plus the `ON CONFLICT … DO UPDATE SET
body=excluded.body WHERE excluded.seq > chat_items.seq` upsert (`chat.rs:190-193`) is what keeps that
from double-printing. Neither may be weakened.

#### 4.2.3 The projection — behaviour, not a recipe. Phase 3 chooses the mechanism.

The second half is in `src/threadProjection.ts`. The gate to lift is
`:175` `if (!running) {` (the comment above it is `:172-173`, `let answerStart = meaningful.length;`
is `:174`), so that trailing main-session prose becomes an answer row **while the turn is still
running**, marked in-flight rather than `final`:

```ts
| { type: "message"; id: string; item: ChatItem; final?: boolean; streaming?: boolean }
```

**Lifting the gate naively is wrong, and the plan previously under-stated this.** "Trailing" is only
knowable at the end of a turn: the instant the first prose node arrives it *is* last, so it is
promoted; when the next tool call lands it is no longer last and is pulled back into the `work` row;
a later prose node then appears under a different id. That is the jump the rule claims to forbid, and
it is what the code comment means by *"never infer one mid-run"*. The mechanism is phase 3's to
choose — candidates include keying on the id currently being streamed (the adapter's synthetic
`"{session}:stream:…"` id, `adapter.rs:646-690` (`on_stream`, the id minted at `:670`), which `completed_block_id` reuses at `:711-735`), or
gating on the counter of §4.2.1, or a "promoted once, never demoted" latch per turn. **What is not
negotiable is the behaviour below, and the three tests.**

Required behaviour:

1. **Trailing prose may render as a streaming answer while a turn runs**, and its row must not move
   between the activity group and the answer position as tool calls arrive. A row that appears,
   disappears and reappears under another id is a failure, not a cosmetic defect.
2. **`canCollapse` must not flip mid-run.** It is `threadProjection.ts:201` —
   `canCollapse: activity.length > 0 && answer.length > 0 && !interrupted`. Promoting prose makes
   `answer.length > 0` true while running, and `WorkTrace.tsx:66`
   (`open = hasPendingApproval || !row.canCollapse || expanded.has(row.id)`) then **collapses the live
   activity list mid-turn**. This needs a code change — `&& !running` or equivalent — not only a test.
3. **`final` stays false until the turn stops.** It is `threadProjection.ts:221` —
   `rows.push({ type: "message", id: item.id, item, final: !interrupted })`; while running,
   `status === "running"` so `interrupted` is false and `final` is **true** today, which would drag
   `ChangedFilesCard` (`ThreadView.tsx:453`) onto a streaming answer. Name the expression that
   changes in the report.
4. When the turn ends, the same item id carries the completed body — the row identity does not
   change, so React does not remount the answer.
5. Only **top-level, childless** `assistant-text` is ever a candidate (the existing `prose()`
   predicate at `:167-170`). Nested or tool-owned prose is never promoted.

Required tests (phase 3 definition of done; all three named in the report with their file and line):

- **T1 — prose grows without a turn boundary.** A running turn whose trailing prose body lengthens
  across two projections yields **one** `message` row, stable id, `streaming: true`, `final` unset —
  with **no** `TurnCompleted`/`turn-completed` anywhere in the fixture. This is the test that proves
  streaming, and it is the one the old plan did not ask for.
- **T2 — no jump.** Prose, then a tool call, then more prose, all while running: the first prose does
  not leave and re-enter the answer position, and the row ids the projection emits for the sequence
  are asserted explicitly.
- **T3 — a running turn does not collapse itself.** With an answer row present and `running: true`,
  `canCollapse` is false, so `WorkTrace.tsx:66` keeps the live activity open.

The global `ThinkingIndicator` (`ThreadView.tsx:488-490`) then shows only while no prose has arrived
yet, which is what Codex's working line does (`docs/research/codex-thread-anatomy.md` §3, `:72`: the
working line is hidden while answer text is revealing).

### 4.3 `rate_limit_event` — a new `Event` variant

**Measured frame** (`docs/research/cli-steer-and-exit-codes.md` §3; the same shape `docs/vision.md` §6 quotes):

```jsonc
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed","resetsAt":1789068000,"rateLimitType":"five_hour",
  "overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,
  "unifiedWindows":{"five_hour":{"utilization":0.25,"resetsAt":1789068000},
                    "seven_day":{"utilization":0.16,"resetsAt":1789556400}}},
 "uuid":"…","session_id":"…"}
```

`utilization` is a **0–1 fraction** at two-decimal resolution (1 % is the finest reading available);
`resetsAt` is **unix seconds**. It arrives once per turn, early (t ≈ 1.0–2.5 s).

Today it is decoded as an untyped `Value` (`crates/claude-wire/src/message.rs:876`) and consumed only
by `capabilities::record_usage` → `allowance::record`, plus a `RuntimeWarning` when
`status == "rejected"` (`adapter.rs:613-630`). **Phase 2 adds the typed variant and emits it:**

```rust
Event::UsageWindows {
    status: String,                 // "allowed" | "rejected" | anything future
    windows: Vec<UsageWindow>,      // one entry per key present in unifiedWindows, order preserved
}
pub struct UsageWindow {
    pub name: String,               // "five_hour" | "seven_day" | a future key, passed through
    pub utilization: f64,           // 0.0–1.0
    pub resets_at: i64,             // unix seconds
}
```

```ts
// src/wire.ts, added to the Event union
| { type: "usage-windows"; status: string;
    windows: { name: string; utilization: number; resets_at: number }[] }
```

Rules this shape encodes: the window **set is open** — a future `unifiedWindows` key must appear rather
than be dropped, so the UI renders what it is given and does not switch on a closed enum. `status`
stays a string for the same reason. There is **no cost field, and none is ever added.**

It is a **signal** (`is_signal` gains `Event::UsageWindows { .. }`) — the gauge must update whether or
not the project is visible. One envelope per turn is negligible against the byte budget. The existing
`RuntimeWarning`-on-rejected behaviour stays; the new variant is additive.

**Where the windows live on the TypeScript side — decided here so phase 3 does not choose at build
time.** They must **not** go on `SessionRuntime`. `SessionRuntime` is the React snapshot
(`StoreState.sessions`), and `windows: UsageWindow[]` is a fresh array on every turn, so writing it
through `patch()` defeats `Object.is` and re-renders every consumer of `getState()` — the sidebar and
the shell, not just the gauge. That is landmine 12 applied to a rendered field, and adding it to
`CURSOR_FIELDS` would be wrong for the opposite reason: the gauge *does* draw it, so it must not be
throttled to the 500 ms counter tick.

Instead: a **module-scope map outside the snapshot**, the shape the row rings already use
(`sessionRows`, read through `getSessionRows` at `src/feedStore.ts:694-697`), with the
cached-reference discipline of `useConversationHistory.ts:13-14` and
`src/components/approvalHistory.ts:16`; `feedStore.ts:119-122` documents why a non-rendered cursor
goes on the counters path and a rendered value must not. Exposed as

```ts
export function getUsageWindows(sessionId: SessionId): readonly UsageWindow[]  // cached reference
```

returning the **same array reference** until the values actually change (element-wise compare, the
`same()` helper at `src/feedStore.ts:529-535`), read by the gauge through
`useSyncExternalStore(subscribe, () => getUsageWindows(id))`. One small component subscribes; nothing
else re-renders. The reserve line (default 80 %) is read from settings per `docs/vision.md` §6, not
hard-coded.

### 4.4 Lifecycle rows — synthetic `ChatItem`s from the Rust store

Per D14, `crates/store/src/chat.rs::project` gains four new branches, each producing a `ChatItem` with
a **deterministic synthetic id** so a replay cannot duplicate it:

| event | `ItemKind` | id | body |
|---|---|---|---|
| `Event::SessionCompacted { trigger, pre_tokens }` | `Notice { level: "info", code: "compacted" }` | `"{session}:notice:compacted:{seq}"` | `"{trigger}"`, `pre_tokens` in the kind |
| `Event::RuntimeWarning { message }` | `Notice { level: "warning", code: "runtime" }` | `"{session}:notice:warning:{seq}"` | the message, bounded |
| `Event::RuntimeError { message, fatal }` | `Notice { level: fatal ? "fatal" : "error", code: "runtime" }` | `"{session}:notice:error:{seq}"` | the message, bounded |
| `Event::SessionExited { reason, exit_code }` | `Notice { level: "info", code: "exited" }` | `"{session}:notice:exited:{seq}"` | `"{reason}"`, `exit_code` in the kind |

```rust
ItemKind::Notice { level: NoticeLevel, code: String, detail: Option<serde_json::Value> }
```

```ts
| { type: "notice"; level: "info" | "warning" | "error" | "fatal";
    code: string; detail?: unknown }
```

`crates/store/src/feed.rs::kind` is **total** — a new `ItemKind` variant fails to compile until it is
mapped — so phase 2 must also map `ItemKind::Notice` to a `FeedKind`. It maps to **`sys`** for
`compacted`/`exited`, **`warn`** for `warning`, **`err`** for `error`/`fatal`, matching
`docs/plans/ipc-contract.md`'s table. `feed::terse_line` gains the matching arms.

`threadProjection.ts` gains a third `ThreadRow` member:

```ts
| { type: "notice"; id: string; item: ChatItem; level: NoticeLevel; code: string }
```

`session-started` deliberately gets **no** notice row: `system/init` is re-emitted at the start of every
turn on the same `session_id` (§6), so a row per init would be one per turn.

### 4.5 What does not change

`FeedBatch`, `FeedRowWire`, the 24-row cap, the `< 8000` byte assertion, the
`set_visible_projects` drop rule, `FeedKind`'s closed set and the `unknown` rule
(`docs/plans/ipc-contract.md` "Feed channel") are all untouched. **`SessionCounter` is the one
exception**: it gains `deltas` per §4.2.1 — one additive `u64`, no new message, no new row, and
`docs/plans/ipc-contract.md`'s counter table is updated in the same commit. Also untouched is
`workspaceApi.historyPage` / `chatTurns`: SQLite refetch stays the body path.

Mirroring note for the phase-2 worker: `ItemKind` lives in `src/wire.ts:58-69` and is what §4.1 and
§4.4 change. `ChatItem`/`ChatTurn` live in `src/workspaceApi.ts:29-47` and change only in that
`ChatItem.kind` widens to include the new `ItemKind` members — no field is added to `ChatItem` itself.

---

## 5. Phases as work orders

**Pre-phase-2, and not optional.** Rebase `ui/codex-thread` onto `main` (`f94c9ef` at the time of
writing) and commit, in one commit, the six untracked `docs/research/` files this plan cites plus the
vendoring script phase 3R needs. Nothing below may start on `ea8d705`, and phase 5's burn baseline is
invalid if taken there (header, phase 5 step 1).

Phase 1 (research docs, paint spike) is running under sibling workers who **own `docs/research/`** and
**`src/spike/`**. Nothing below writes to either. They have produced
`docs/research/{codex-thread-anatomy,codex-thread-tokens,codex-thread-row-mapping,codex-ui-kit,cli-steer-and-exit-codes,thread-render-path-2026-09-10}.md`,
a three-arm CSS paint spike under `src/spike/codex-css/`, and the already-written
`THIRD_PARTY_NOTICES.md` attribution (see phase 3R). **Their throwaway hooks move between arms and
between files: within one hour on 2026-09-11 the `src/index.css:6-7` `@import` was removed, a
`<div class="cdx-…">` DOM probe appeared in `index.html` (+2 uncommitted lines), and the `@import`
came back pointing at `spike-nofilechange.css`. Both are marked `codex-css-paint-spike-2026-09-11`.
[M]** That worker is still live, so anything this plan says about *where* the hook is has a shelf
life of hours. **The precondition is therefore stated by property, not by path: before phase 4 starts,
`git status` must show no `src/spike/` and no `codex-css-paint-spike` string anywhere in the tree
(`grep -rn "codex-css-paint-spike" . --exclude-dir=.git` → zero).** `index.html` is owned by no phase;
whoever finds the probe still present reverts that file with `git checkout -- index.html` and says so.

Ownership is by path, and no two concurrently-running phases write the same file. Phase 2 (Rust) and
phase 3 (TypeScript store) run **concurrently** against §4, **with one real dependency**: phase 3's
`usage-windows` and `notice` work consumes types phase 2 adds to `src/wire.ts`, which is phase 2's
exclusive path. Phase 3 does **not** wait for it — it defines the two types locally in
`src/threadProjection.ts` behind a comment naming this section, and deletes the shim in its final
commit once phase 2 has landed, or (lead's call at launch time) runs its items 1, 4, 5, 6 first and
its items 2, 3 after phase 2 commits. Either way phase 3's `npx tsc --noEmit` must be green on its own
tree. Phase 3R (vendoring) runs concurrently because it only adds new files. Phase 4 depends on 2, 3
and 3R. Phase 5 is last and alone.

**Build-system partition:** only one phase at a time may run `npm run tauri build`. Phases 2–4 run
their own narrow gates (`cargo test -p <crate>` / `npx vitest run <file>`); the full six gates are
phase 5's job and phase 5 owns the build lock.

---

### Phase 2 — Rust wire (Opus)

**Goal.** Land §4 on the Rust side, with nothing rendered. Five independent changes, one commit each.

**Owned paths (exclusive).**
```
crates/claude-wire/src/message.rs
crates/core/src/event.rs
crates/core/src/claude/adapter.rs
crates/supervisor/src/batcher.rs
crates/supervisor/src/wire.rs     ← `SessionCounter` gains `deltas` (§4.2.1)
crates/store/src/chat.rs
crates/store/src/feed.rs
crates/*/tests/**
docs/plans/ipc-contract.md
src/wire.ts                       ← the TS mirror ONLY; no other TS file
```

**Inputs.** §4 of this document, verbatim. `docs/research/cli-steer-and-exit-codes.md` for the measured frames.
`docs/plans/ipc-contract.md` "Feed channel" for the signal list, the byte cap and the `FeedKind` rules.

**Work.**
1. `ToolUseResult` as an untagged `object | string` enum; `exit_code` + `interrupted` on
   `ItemKind::ToolResult`; the `^Exit code (\d+)\n` parser with its pinned tests.
2. `Event::UsageWindows` + `UsageWindow`; emit from `adapter.rs`'s `RateLimitEvent` arm, keeping the
   existing `record_usage` and rejected-warning behaviour; add to `is_signal`.
3. `ItemKind::Notice` + the four `chat.rs::project` branches with deterministic ids; map it in
   `feed::kind` (which will not compile until you do) and in `feed::terse_line`.
4. Mirror all of it in `src/wire.ts` (types only, no logic) and in `docs/plans/ipc-contract.md`.
5. **The streaming delivery gap, per §4.2.1.** `SessionCounter` gains `deltas: u64`
   (`crates/supervisor/src/wire.rs:69-76`); `batcher::push` increments it in the existing
   `match &env.event` (`:172-176`), outside the `terse_line` block, visible or not;
   `flush_once` (`:229-233`) carries it with the counter it already sends. Mirror it in `src/wire.ts`
   as **optional** (`deltas?: number`) so `src/feedStore.test.ts`'s counter literals still compile,
   and record it in `docs/plans/ipc-contract.md`'s counter table. **This item is why §4 was
   un-frozen; without it phase 3's streaming work cannot be proven and the feature does not ship.**

**Do not** touch `crates/store/src/chat.rs::append_delta`, `crates/store/src/feed.rs:294-296`, or
`feed::terse_line`'s `None` for `Event::ContentDelta` (`feed.rs:180`), and **do not** add
`Event::ContentDelta` to `is_signal`. §4.2 explains why: persistence already works and one envelope
per token is the 8 KB flood (landmine 10). The delivery gap is closed by item 5's counter, not by a
per-delta message.

**Definition of done.**
- `cargo test --workspace` green; `cargo clippy --workspace --all-targets -- -D warnings` green;
  `cargo doc --workspace --no-deps` green. Exit codes read off the commands, not through a pipe.
- `npx tsc --noEmit` green (the `wire.ts` mirror compiles against untouched consumers because every
  new field is optional).
- `crates/store/tests/feed.rs::kind_is_pinned_for_every_variant` still passes with the new variant.
- `crates/store/tests/history_pages.rs` still passes **unmodified** — it is the streaming guard.

- A Rust test proves the counter: a batch containing N `ContentDelta` envelopes for one session and
  no other event emits **one** `SessionCounter` whose `deltas` advanced by N, **zero** rows and
  **zero** signals — and the same holds when the project is not visible.

**Evidence.** The five commit sha's; the exact `cargo test` / `clippy` invocations and their exit
codes; the exit-code parser's test names and the five cases it covers; the delta-counter test's name
and its assertion; the diff of `src/wire.ts`.

**Explicitly not in this phase.** No renderer, no `feedStore.ts`, no CSS, no `npm run tauri build`.

---

### Phase 3 — store + projection (Opus)

**Goal.** Make every §4 shape reach `ThreadRow[]`, with the current renderer still drawing. No pixels
change in this phase.

**Owned paths (exclusive).**
```
src/feedStore.ts
src/threadProjection.ts
src/hooks/useConversationHistory.ts
src/conversationHistory.ts
src/feedStore.test.ts
src/threadProjection.test.ts
src/hooks/useConversationHistory.test.tsx
```

**Inputs.** §4 (the shapes are settled — do not renegotiate them with phase 2, file a question
instead). §1.6 for the refetch path and its two identity guards. The `useSyncExternalStore` rule
(`docs/research/native-react-profiling-2026-09-10.md:142`): a fresh object per `getSnapshot()`
defeats `Object.is` and re-renders the whole mounted transcript.

**Depends on phase 2, and how to proceed anyway.** Items 2 and 3 consume types phase 2 adds to
`src/wire.ts` (`usage-windows`; the `notice` `ItemKind` member), and item 1's *test* needs phase 2's
`deltas` counter to drive a body that grows without a turn boundary. `src/wire.ts` is phase 2's
exclusive path — do not edit it. Either declare the two types locally at the top of
`src/threadProjection.ts` behind a comment reading *"shim for §4.3/§4.4 until phase 2's `src/wire.ts`
lands; delete then"*, and delete the shim in your final commit; or take items 1, 4, 5, 6 first and
hold 2, 3 until phase 2 commits. Say in the report which you did. For item 1's tests, drive the store
through `pushBatch` with counter literals carrying `deltas` — optional on the TS mirror, so the test
compiles before phase 2 lands and exercises the real path after.

**Work.**
1. **Streaming answer — §4.2.3, behaviour and three tests.** Lift `threadProjection.ts:175`'s
   `if (!running)` gate, add `streaming?: boolean` to the `message` row, and satisfy the five required
   behaviours: no row jumping between the activity group and the answer position; `canCollapse`
   (`:201`) does not flip mid-run; `final` (`:221`) stays false while running; stable item id across
   the turn boundary; only top-level childless prose is a candidate. **The mechanism is yours to
   choose** (§4.2.3 lists candidates). Also do §4.2.2 items 1–4 in `src/feedStore.ts`: `deltas` on the
   live session map, folded into `getSessionCursor`, with a `deltasDirty` notify that does **not**
   rebuild the snapshot and does **not** disturb `src/feedStore.test.ts:463`.
2. `usage-windows` → latest windows per session in a **module-scope map outside the React snapshot**
   with a cached-reference getter, per §4.3. **Not** on `SessionRuntime`, and not in `CURSOR_FIELDS`.
   No dollar field, ever.
3. `ItemKind::Notice` items → the third `ThreadRow` member, ordered by `seq` like every other item.
4. `projectThread` computes **per-tool-call duration** from `result.at − item.at` (the data is already
   on `ChatItem.at` for both call and result; nothing computes it today).
5. `projectThread` computes the **60 s rule** inputs for the turn header: `durationMs` plus a
   `completedAtMs` so the renderer can print `· done 3:04 PM` unconditionally.
6. Parse `+A/−D` per edit from the Edit/Write tool **input** (the same defensive style as
   `activityCategory` at `:265-281`: parse, and on any failure return nothing rather than a guess).

**Definition of done.**
- `npx vitest run src/feedStore.test.ts src/threadProjection.test.ts src/hooks/useConversationHistory.test.tsx`
  green, with new cases for each of the six items above.
- **T1 — prose visibly grows without a turn boundary.** A running turn whose trailing prose body
  lengthens across two projections yields **one** `message` row with a stable id, `streaming: true`,
  `final` unset — **with no turn-completion event anywhere in the fixture**; and when the turn ends
  the same id carries the completed body with `final: true`. A test that only proves the end-of-turn
  case does not satisfy this line.
- **T2 — no jump.** Prose, then a tool call, then more prose, all while running: the first prose does
  not leave and re-enter the answer position; the emitted row ids for the sequence are asserted.
  (This subsumes the old "commentary guard": prose with a tool call after it is not a final answer.)
- **T3 — a running turn does not collapse itself.** `canCollapse` is false while `running` even with
  an answer row present, so `WorkTrace.tsx:66` keeps the live activity open.
- A test proves a `notice` row lands in `seq` order between two message rows.
- A test proves the usage-window getter returns the **same reference** across a notify that did not
  change the values.
- `src/feedStore.test.ts:463` ("are throttled to COUNTER_FLUSH_MS") passes **unmodified**.
- `npx tsc --noEmit` green. The existing 47 + 16 tests still pass unmodified except where a new field
  legitimately changes an expectation — every such change is listed in the report with its reason.

**Evidence.** Test names and counts before/after; the vitest invocation and exit code; the three-line
assertion of T1 quoted verbatim, with the line that proves no turn boundary is in its fixture.

**Explicitly not in this phase.** No component file, no CSS, no vendoring, no build.

---

### Phase 3R — vendor the kit (Sonnet; mechanical, fixed recipe)

Runs concurrently with 2 and 3. It creates new files only.

**Goal.** Get the chosen kit components and their extracted CSS into the tree, renamed, attributed and
compiling — wired to nothing.

**Owned paths (exclusive).**
```
src/components/thread/**            ← new directory, all vendored TSX
src/components/thread/thread.css    ← the extracted + renamed stylesheet
src/components/thread/UPSTREAM.md   ← per-file provenance + brigadier modifications, as ui/UPSTREAM.md does
licenses/codex-ui-kit-MIT.txt
licenses/base-ui-MIT.txt            ← no phase owned it; see below
licenses/radix-ui-MIT.txt           ← decide and act: delete, or keep with a reason
scripts/vendor-codex-ui-kit.mjs     ← committed pre-phase-2, or rewritten from row-mapping §3
```

**`THIRD_PARTY_NOTICES.md` is NOT phase 3R's.** A phase-1 attribution worker owns it and has already
written it: the uncommitted diff (+63/−3 as of 2026-09-11 **[M]**) carries the whole of the old work
item 7 and D20 — the `## codex-ui-kit — MIT` section with the MIT text, the JaminZhou copyright, the
pinned commit, the prefix-rename note, the verbatim non-affiliation sentence and the subagent-SVG
exclusion — and it already corrects the stale Radix entry §1.8 flags. Phase 3R must **not** edit that
file; if a line in it turns out wrong, report it to the lead.

**Two loose ends that file leaves, and that phase 3R now owns.** Its own §`@base-ui/react` entry says
the MIT text is *"not yet copied to `licenses/base-ui-MIT.txt` … out of scope for this edit"*, and
`licenses/` today holds only `assistant-ui-MIT.txt`, `radix-ui-MIT.txt`, `tw-shimmer-MIT.txt` **[M]**.
Base UI is the headless base for all 29 entries of `src/components/ui/` — the repo's largest vendored
dependency with no licence text. Copy it from `node_modules/@base-ui/react/LICENSE`. And
`licenses/radix-ui-MIT.txt` is now unreferenced (`radix-ui` left `package.json`): either delete it and
say so, or keep it with one line saying which shipped artefact still carries Radix code. Do not leave
it undecided a third time.

**Inputs.** `scripts/vendor-codex-ui-kit.mjs`. **Provenance warning:** the script was written in a
session scratchpad that does not survive, and no phase committed it — the pre-phase-2 commit (§5
preamble) must carry it in. If it is already gone, **rewrite it from
`docs/research/codex-thread-row-mapping.md` §3 (`:587-711`)**, which documents its CLI, every flag,
its `src/assets/**` and `@import "katex/…"` refusals, and the run to reproduce; do not invent a
different interface. The kit clone: re-clone `JaminZhou/codex-ui-kit` at commit
`9f3af2c3a6386d4ea05f8b3f2c1051ae1a50789d` into a scratch directory outside the repo — the clone is
never committed. D3, D10, D11, D12, D20.

**Work.**
1. Run the script with `--var-prefix --thread- --class-prefix thread- --follow-imports` for exactly:
   `AgentMessage, TurnDuration, ActivityTimeline, AgentActivity, StatusIndicator, CommandExecution,
   McpToolCallGroup, ToolCallCard, SearchActivity, SubagentActivity, ApprovalRequest, Notices,
   ThreadState` — **and not `FileChange`**.
2. Hand-extract `FileChangeGroup` + `FileChangeStats` from `FileChange.tsx` into one small file. Do not
   bring `FileChange`, `FileDiff`, `FileReview`, `FileReviewWorkspace` or `FileRevertErrorDialog`, and
   do not let `--follow-imports` pull `Dialog.tsx` or `InteractivePrimitives.tsx`.
3. Delete `SubagentAvatar` and every reference to `src/assets/subagents/*` (D3/D19). The script already
   refuses those SVGs; the component will not compile until the reference is gone — that is the
   intended failure, not a bug to work around.
4. Second rename pass: map colour and radius tokens onto the existing `--color-*` / `--radius-*` layer
   (§1.9). Only genuinely new values keep literals — the diff pair `#40c977` / `#fa423e` and their
   `.23` tints, the approval surface `rgb(45,45,45)`, the card body `rgb(40,40,40)`, and the
   `--thread-*` geometry block of §3.
5. Strip `corner-shape` (D11) and confirm the script's `@import "katex/…"` refusal held.
6. Replace every inline `<svg>` glyph that duplicates an existing `src/icons/` glyph with the icon
   import. Report any glyph `src/icons/` does not cover rather than adding a package.
7. `licenses/codex-ui-kit-MIT.txt` (D20's text is already in `THIRD_PARTY_NOTICES.md`; copy the
   licence file itself), `licenses/base-ui-MIT.txt` from `node_modules/@base-ui/react/LICENSE`, and
   the `licenses/radix-ui-MIT.txt` decision. **Do not edit `THIRD_PARTY_NOTICES.md`.**
8. `src/components/thread/UPSTREAM.md`, in the shape `src/components/ui/UPSTREAM.md` uses: per-file
   source path, the pinned commit, and every brigadier modification — including the two
   `ApprovalRequest` extensions §3 row 12 requires (a third `decision` value, `onDismiss`), so phase 4
   inherits a written record rather than rediscovering them.

**Definition of done.**
- `npx tsc --noEmit` green with the new files present and imported by nothing.
- Byte report: extracted CSS, tokens, total, and the share of the kit's 566,682-byte `styles.css`.
  Target for comparison: 90,376 + 24,931 B for the set without `FileChange.tsx`.
- `grep -rn "codex-ui" src/` → zero hits. `grep -rn "corner-shape" src/components/thread/` → zero.
- `grep -rn "lucide" src/components/thread/` → zero.
- No file under `src/components/thread/` references `src/assets/subagents`.
- `src/dependency-hygiene.test.ts` still passes: it asserts `src/components/ui/collapsible.tsx`
  **exists**, and `--follow-imports` is exactly the kind of run that would replace or orphan it.
- `licenses/` holds a text file for every vendored dependency the notices name, `base-ui` included.

**Evidence.** The script's stdout verbatim; the byte table; the four greps with their exit codes; the
`git status` of `licenses/` and the `radix-ui-MIT.txt` decision in one line.

**Explicitly not in this phase.** No wiring, no `src/index.css` edit, no test change, no build.

---

### Phase 4 — render (Opus)

Starts only when 2, 3 and 3R are all committed.

**Goal.** Rows become message parts; the 17 live kinds of §3 draw from real data at the measured geometry.

**Owned paths (exclusive).**
```
src/components/ThreadView.tsx
src/components/WorkTrace.tsx
src/components/TranscriptRuntime.tsx
src/components/Approvals.tsx
src/components/SubagentsPanel.tsx   ← mounts the nested read-only ThreadView (:77); work item 8
src/components/Markdown.tsx         ← row 2 depends on it; reskin only, no new markdown stack
src/components/RunCard.tsx          ← its test is in this phase's DoD, so the component is owned too
src/components/assistant-ui/elements/**
src/components/thread/**            ← handed over from 3R
src/index.css                       ← the --thread-* block and the thread.css import ONLY
src/components/*.test.tsx           ← for the files above
```

**Not owned, and deliberately so.** `src/App.tsx:1256-1260` constructs the `<Approvals>` element that
`ThreadView.tsx:301,314` introspects through `approvalElement.props.approvals` and `cloneElement`.
Phase 4 must keep that contract working **without editing `App.tsx`**; if it genuinely cannot, that is
a question for the lead, not a quiet edit. `src/components/ProjectWorkbench.tsx` is likewise off
limits (§7.1) — rehoming the subagents panel is out of scope.

**Inputs.** §3 row by row. §2 D1, D7, D16, D17, D19. §6 landmines.
`src/components/ui/UPSTREAM.md` for how a vendored component is recorded in this repo, and
`src/components/thread/UPSTREAM.md` for what 3R changed in the kit.

**Work.**
1. `TranscriptRuntime` becomes the real runtime: rows convert to `ThreadMessageLike` with **real parts**
   — `text`, `reasoning`, `tool-call`, and `data-*` parts for approval, notice, changed-files, subagent
   group, commentary and usage. `content: []` disappears. **Preserve the stable `convertMessage`
   identity and the memoized adapter** from the performance worktree (§7).
2. Register the part renderers: `components.data.by_name` for the `data-*` names, a named tool renderer
   per tool family (Bash → `CommandExecution`; Read/Glob/Grep/LS → `SearchActivity`/exploration group;
   Edit/Write → `FileChangeGroup`; Task → subagent; else → brigadier's own small fallback).
3. `GroupedParts` + a `groupBy` branching on `part.parentId` for the exploration fold, drawn by
   `ActivityTimeline` + `AgentActivity` through the `ToolGroup` override slot.
4. Turn header: kit `TurnDuration` with the **60 s rule** and the always-on done time.
5. Approvals, per §3 row 12: kit `ApprovalRequest` chrome for the **pending card only**, driven by the
   untouched `Approvals.tsx` state machine; `decision`/`loading` as host props; the extended
   `"expired"` decision value plus `onDismiss` for `approval.expired`; `ApprovalResolution`
   (`Approvals.tsx:322-332`) keeps its own markup and its `Expired · {name}` summary **verbatim**.
   Audit Enter/Escape against the Lexical composer and pass `disableHotkeys` if they collide — **the
   audit is a deliverable**: name the file and line of the kit's handler, say whether it collides, and
   quote the check that proves it. Keep the tail render at `ThreadView.tsx:495` that draws unmatched
   pending requests (row 19 depends on it).
6. The `--thread-*` block into `src/index.css`, and one `@import "./components/thread/thread.css"`.
7. Usage gauge and queue strip into the composer rail — **reskin only**, `src/components/composer/`
   stays untouched except for the rail mount point.
8. **The read-only path, which the plan previously missed.** `src/components/TranscriptRuntime.tsx:7`
   builds the read-only message array with
   `content: … : m.content.filter(p => p.type === 'text')` — **every non-text part is dropped**. `:10`
   routes read-only sessions through `AuiProvider + ReadonlyThreadProvider`, and
   `src/components/assistant-ui/elements/thread.tsx:20,56-64` gives them a **second, separate
   viewport** (`ReadonlyViewport`) with no `ThreadPrimitive` scope. `SubagentsPanel.tsx:77` mounts
   `ThreadView` with `peers` set, so `readOnly` is true (`ThreadView.tsx:359,362,434`) — the nested
   instance of the thing being rebuilt **is** this path, and so is every archived session. **[M]**
   Carry the same parts through the read-only converter, and verify `ReadonlyViewport` renders them.
   If a part genuinely cannot render without a writable runtime, drop that one part explicitly and
   name it; do not keep a blanket `.filter`.
   *Collision*: the `codex/transcript-performance` worktree has uncommitted edits to this same file
   (§7.1) that split it into `ReadonlyTranscriptRuntime`/`WritableTranscriptRuntime` and hoist
   `convertMessage` to module scope. Take their version first, then change the converter inside it.

**Definition of done.**
- Every one of the 19 rows in §3 renders from real data or is explicitly listed as deferred with its
  reason (rows 16 and 19 are the only pre-approved deferrals).
- `npx vitest run` green for `ThreadView.test.tsx` (19), `WorkTrace.test.tsx` (9),
  `Approvals.test.tsx` (7), `TranscriptRuntime.test.tsx` (2), `AgentElements.test.tsx` (3),
  `SubagentsPanel.test.tsx` (5), `RunCard.test.tsx` (18). A test may change **only** when the
  behaviour it pins deliberately changed, and every such change is named with its reason.
- The three approval tests that pin never-optimistic / `Expired` pass **unmodified**, including
  `src/components/Approvals.test.tsx:69-76`'s literal `Expired · MCP · brigadier`. **If the row
  catalogue cannot satisfy that assertion as written, stop and say so in the report** — the test is
  not the thing that changes.
- **A new `SubagentsPanel.test.tsx` case proves a read-only thread draws a non-text row** (work item
  8): mount the panel on a saved worker whose rows include an approval receipt or a tool call, and
  assert the row is in the DOM. Without this, work item 8 is unproven.
- `ThreadView.test.tsx`'s three `data-trace-id` assertions (`:429`, `:444`, `:467`) either keep passing or
  are re-pointed with a reason: the attribute is set in exactly one place,
  `src/components/assistant-ui/elements/tool-call.tsx:58`, a file this phase replaces.
- `npx tsc --noEmit` green.
- `grep -rn "total_cost_usd\|costUSD\|\\$[0-9]" src/` → zero outside tests and Rust comments.

**Evidence.** Per-file test counts before and after; the list of changed assertions with reasons; the
Enter/Escape audit's verdict with its citation; screenshots are **not** required and **not** accepted
as proof of a gate.

**Known gaps this phase inherits, each of which is a report line rather than a silent risk.** The
600-item history window (`src/conversationHistory.ts:3` `HISTORY_WINDOW = 600`, sliced at `:12`) drops
the head silently, and WebKit has no `overflow-anchor` (landmine 11), so a head-drop with a work row
expanded is a visible jump. `ThreadView.tsx:344-350` restores `scrollTop` once per mount from
`localStorage` and `:318`'s `estimateSize: () => 140` is calibrated to today's rows; both become
approximate when a row is a part. A turn that is mid-stream when the new runtime mounts
(`ThreadView.tsx:88-91` keys `<Transcript … key={sessionId}>`) must still reach `bridge().interrupt`
through the new part pipeline. And eighteen row renderers, most of them third-party source nobody has
run (§9), sit under a single app-level error boundary (`src/components/AppErrorBoundary.tsx`, mounted
at `src/main.tsx`) — **a per-row boundary is cheap and belongs in this phase**; one throw in one
vendored row otherwise takes the whole window. D17 holds: none of this is a licence to change the
scroll owner.

---

### Phase 5 — burn, six gates, dead-code removal (Opus; owns the build lock)

**Goal.** Prove the thing is not slower than what it replaced, and delete what it replaced.

**Owned paths (exclusive).** Everything not owned above, plus `docs/STATUS.md`, `package.json`,
`vite.config.ts`, and the deletions:
```
src/components/Feed.tsx          src/components/Feed.test.tsx
src/feedGroups.ts                src/feedGroups.test.ts
```

**Work.**
1. **Burn first, before any cleanup.** `VITE_BURN=1 npm run tauri build -- --features burn`, then the
   burn panel at 10 sessions × 200 rows/s × 60 s. Record exec → FCP p50 and the frame verdict from
   `fps.windowPasses`. **The baseline is the same measurement on the commit this branch was rebased
   onto — `f94c9ef` or whatever `main` was at rebase time — not `ea8d705`. A baseline taken at
   `ea8d705` is invalid and must be re-taken**: `main` moved two commits during this plan's writing,
   and if `codex/transcript-performance` has landed by then (§7.1, Q1) the baseline must be taken
   *after* it or the rebuild is credited with someone else's gain. State the baseline commit sha in
   the report next to both numbers. If no baseline exists yet, capture it first on a clean worktree at
   that commit. Budget: exec → FCP **≤ 295 ms p50**, and **0** dropped-vsync failures at 60 Hz.
2. Delete `Feed.tsx`, `feedGroups.ts` and their 44 tests (D18). Confirm by grep that nothing imports
   them, including `src/mock.ts:150`'s string reference.
3. Delete whatever phase 4 orphaned under `src/components/assistant-ui/elements/` — list each file with
   the grep that proves it has no importer.
4. The six gates, each exit code read off the command itself:
   ```sh
   export PATH="$HOME/.cargo/bin:$PATH"
   cargo test --workspace
   cargo clippy --workspace --all-targets -- -D warnings
   cargo doc --workspace --no-deps
   npm test
   npx tsc --noEmit
   npm run tauri build
   ```
5. Re-run the contrast sweep over the new `--thread-*` pairs (`docs/STATUS.md:822-824` found six
   failures in 48 pairs last time) and record it.
6. Update `docs/STATUS.md` §4 with the new numbers and §7 with any landmine this work created.

**Definition of done.** All six gates green with their exit codes quoted. Burn inside budget, or a
written verdict that it is not, with the delta and the specific cause — **a failing burn is a result to
report, not a reason to loop.**

**Evidence.** The six commands and their exit codes; the burn summary JSON; the before/after FCP p50
with n for each; the deletion greps; the contrast sweep table.

---

## 6. Landmines

1. **Interrupt is an interruption, not a failure.** An interrupt produces a synthetic **rejected**
   `tool_result` (`is_error: true`, body *"The user doesn't want to proceed with this tool use…"*,
   sibling `tool_use_result: "User rejected tool use"`), **plus** a user text row
   `[Request interrupted by user for tool use]`, **plus** a `result` with `is_error: true`,
   `subtype: "error_during_execution"`, `terminal_reason: "aborted_tools"` (tool running) or
   `"aborted_streaming"` (mid-stream). All of that must render as *You stopped* — never as a failure,
   never as a red exit code. **[M]** `docs/research/cli-steer-and-exit-codes.md` §1(d).
2. **`system/init` is re-emitted at the start of every turn on the same `session_id`.** It is not a
   session-open event and must not reset thread state. `feedStore.ts:378-380` already carries this as
   an open note: `startedAtMs` is re-stamped every turn, so `StoreState.order` means "whoever spoke
   last". Do not add a per-init timeline row. **[M]**
3. **The CLI never echoes user text.** Across six transcripts, inbound `user` frames carrying a text
   block number three, and all three are the CLI's own interrupt markers. The optimistic user row is
   the only row; there is no CLI-assigned id to reconcile against; the client's own id is the only id.
   **[M]** `docs/research/cli-steer-and-exit-codes.md` §1.
4. **Do not re-implement streaming, and do not weaken its two existing guards.** The complete
   non-partial `assistant` frame is emitted *in addition to* the stream. Two things stop it
   double-printing, and both are load-bearing: `completed_block_id`'s id reuse
   (`adapter.rs:711-735`) and the `ON CONFLICT … DO UPDATE SET body=excluded.body WHERE excluded.seq >
   chat_items.seq` upsert (`chat.rs:190-193`), plus `append_delta`'s `seq<?3` replay guard
   (`chat.rs:201`), pinned by `crates/store/tests/history_pages.rs:61-62`. **[M]** Every one of those
   is invisible from the UI and every one of them will look removable to someone reading only
   `ThreadView.tsx`.
5. **Approvals are never optimistic.** The card clears only on `request-resolved`; a resolved row with
   no decision is the third state `Expired`. Do not adopt assistant-ui's `disabled={submitted}`
   pattern. And do not conflate the two "expired" notions of §1.4 — `approval.expired` is *open but
   unanswerable* (a Dismiss-only card), `decision === null` is *resolved with no decision* (a
   receipt). §3 row 12 extends the kit's prop surface to hold both; it does not merge them, and
   `Approvals.test.tsx:69-76` is the assertion that catches a merge.
6. **`git worktree remove` without `--force` deletes gitignored files and exits 0.** The filter-driver
   neutralisation in `crates/core/src/worktree.rs` is deliberate (`docs/STATUS.md` §7). Nothing in this
   plan should touch it; it is here because every session rediscovers it.
7. **The paint budget.** exec → FCP **287–295 ms p50, n=19** at `c4d9d29` (`docs/STATUS.md:344`),
   re-measured **326.6 ms p50, n=10** on 2026-09-10. Every burn number in the docs is a debug build
   unless a `VITE_BURN=1` release build was run. The current thread already **fails** the frame gate:
   2,499 missed 60 Hz opportunities in the 2026-09-10 release burn. Adding ~115 KB of stylesheet to
   that path is the plan's largest single risk (D12).
8. **No dollars.** `SessionRuntime.costUsd` exists (`feedStore.ts:414`) and `result.total_cost_usd` /
   `modelUsage[].costUSD` are on the wire. Nothing renders them. `RunCard.test.tsx` pins it.
9. **`FeedKind`'s `unknown` is the absence of a class, not a class.** Any UI that filters or styles by
   `k` must leave `unknown` rows alone — the owner has 10,037 rows written before migration 1
   (`docs/plans/ipc-contract.md`).
10. **8192-byte Tauri channel cliff.** An oversized message detours through `fetch` and
    head-of-line-blocks every later one. The `serialized.len() < 8000` re-check before every send is
    the binding check (`crates/supervisor/src/batcher.rs:26`). §4.2's refusal to promote
    `ContentDelta` to a signal is what keeps it safe — do not relax that to "make streaming feel
    faster". §4.2.1's counter is the sanctioned alternative: it adds one integer to a message the
    frame already sends, never a message per delta.
11. **WebKit 26.5 has no `overflow-anchor`** (`docs/research/feed-rendering.md:186-192`). A head-drop
    must adjust `scrollTop` manually before paint. This is why D17 refuses to change the scroll owner.
12. **`useSyncExternalStore` snapshots must be cached immutable references.** A fresh object per
    `getSnapshot()` defeats `Object.is` and re-renders the whole mounted transcript. Three hand-written
    guards already exist for exactly this (`useConversationHistory.ts:13-14,73`;
    `src/components/approvalHistory.ts:16`; `desktopApi.ts:117-125`). Do not remove one to simplify a
    diff — and do not *add* a new violation: §4.3 keeps the usage windows off `SessionRuntime` for
    this reason, and phase 3's `deltas` is a counter on the throttled counters path, not a snapshot
    field anything draws.
13. **Tailwind's oxide scanner walks Markdown prose, not the module graph** — naming a utility class in
    a doc ships it (`docs/STATUS.md:799-805`). This plan deliberately writes token names, not utility
    class names, in its prose; keep it that way.
14. **jsdom 30.0.1 has no `PerformanceObserver` and no `matchMedia`.** A paint or reduced-motion test
    written against the real API passes vacuously (`docs/STATUS.md:814-817`). The shimmer's
    reduced-motion behaviour cannot be proved by a unit test.
15. **Focus indicators are disabled app-wide** (owner, 2026-09-10; `src/index.css`'s
    `* { outline: none !important }` and `src/focus-reset.css`). Vendored components' `focus-visible:ring-*`
    classes will be inert. Do not re-enable them to make a kit component look right.
16. **A clean tree plus green tests is not green.** `cargo clippy --workspace --all-targets -- -D warnings`
    is one of the six gates.
17. **A full-bleed hit target with no focus ring and no label is an invisible control.** §3 row 6 puts
    `<button class="absolute inset-0 rounded-md">` over every activity group, and landmine 15 says
    focus indicators are off app-wide. Today's thread carries 6 `aria-`/`role=` occurrences in
    `ThreadView.tsx`, 3 in `WorkTrace.tsx`, 1 in `elements/thread.tsx` **[M]** — phase 4 must not end
    below that count, and every full-bleed toggle needs an accessible name (`aria-label` or an
    `aria-labelledby` pointing at the summary it toggles) and an `aria-expanded`. This is not a
    licence to re-enable focus rings (owner decision, landmine 15); it is a requirement that the
    control be reachable and announced.
18. **Streaming has a delivery half as well as a persistence half.** Landmine 4 forbids weakening the
    persistence guards; it does **not** mean "streaming is done". §4.2.1's counter is what makes a
    growing body visible, and it is phase 2 work. A worker who reads only landmine 4 will conclude
    the opposite — which is exactly what the first draft of this plan did.

---

## 7. Merge risk — the other live worktree

### 7.1 `codex/transcript-performance` — `/private/tmp/brigadier-performance-fix-20260911`

**Re-read 2026-09-11 after the review; it has moved.** Now based at **`f94c9ef`** — current `main`,
two commits *ahead* of this branch — still **uncommitted**: **12 modified files + 5 untracked**,
`+285/−203`. **[M]** (`git -C … status --porcelain`, `git -C … diff --stat`.) The rows below are the
earlier read plus what changed; the two additions matter because they are files phase 4 owns.

| file | their change | collides? | reconciliation |
|---|---|---|---|
| `src/components/TranscriptRuntime.tsx` | **Correction:** a read-only/writable split is *already in the tree* at `ea8d705` (`:10-12`, `WritableTranscriptRuntime` at `:13`) **[M]**; their diff moves the read-only branch into its own `ReadonlyTranscriptRuntime` component so the read-only message array is no longer built on the writable path, and — the genuinely new parts, absent at `ea8d705` where `:16` is still an inline arrow — hoists `const convertMessage = (message) => message` to **module scope** with the comment *"Changing this function's identity invalidates the library's entire message cache"*; wraps `onNew`/`onCancel` in `useCallback` and the whole adapter in `useMemo<ExternalStoreAdapter<…>>`. | **YES — direct.** Phase 4 rewrites this exact file. | **Take their change as the starting point and preserve it.** It is a correctness fix against `@assistant-ui/core`'s `ThreadMessageConverter` cache (their `docs/research/transcript-runtime-performance.md` cites the source file). Phase 4's part-conversion work must keep the module-scope `convertMessage`, the memoized adapter, and the read-only/writable split. Rebuilding this file from `ea8d705`'s 31-line version silently reintroduces the cache invalidation. |
| `src/components/TranscriptRuntime.test.tsx` | +17 lines: one test asserting message-object identity survives parent re-renders and running-state changes, via `useAui()`. | **YES.** | Keep the test verbatim. It is the regression guard for the row above and it must still pass after phase 4. |
| `src/perfDiagnostics.ts` | +1 line: pushes a `track: "component"` span when a component render ≥ 2 ms. | no | Trivial; take whichever lands first. Phase 5 owns this file. |
| `vite.config.ts` | +1 line: `esbuild: reactProfile ? { keepNames: true } : undefined`. | no | Same. Phase 5 owns it. |
| `src/components/Sidebar.tsx`, `src/components/controls/sidebar.tsx`, `src/components/controls/sidebar.test.tsx`, `src/components/SessionCard.tsx` | Memoizes the sidebar context and its callbacks; memoized rows and static actions. 206 + 42 + 26 + 16 lines changed. | **no** — no phase here owns any sidebar file. | Independent. Merges cleanly. |
| `src/components/ProjectWorkbench.tsx` | Extracts a `memo`'d `WorkbenchTerminalDock` so every saved dock's hooks stop running on each feed update (their diagnostic recorded **28,352** `TerminalDock` render spans). | **no** — `ProjectWorkbench.tsx` is owned by no phase here, and the mount point for `ThreadView` (`:1256` region in `App.tsx`) is untouched by their diff. | Independent. But phase 4 must not start editing `ProjectWorkbench.tsx`; if the subagents-panel rehoming tempts it, that is out of scope (constraint 9). |
| `src-tauri/src/views.rs` | 1 line. | no | Independent. |
| `src/hooks/useSessionSources.ts` + `.test.ts` (new) | A `useSessionSources(sessionId, busy, lastTurnId)` hook that keeps unchanged sources visible and guards session switches against stale responses. | no | New file, no conflict. Note it establishes the same "keep the previous reference when the payload is equal" pattern phase 3 must use for the usage-window getter (§4.3). |
| **`src/components/ThreadView.tsx` (+33/−?) and `src/components/ThreadView.test.tsx` (+32)** — *new since the first read* | Not yet read line by line. | **YES — direct.** Phase 4 owns both. | **Read their diff before phase 4 writes a line of `ThreadView.tsx`.** This is now the second file where the two branches collide, and the larger one. Same rule as `TranscriptRuntime.tsx`: take theirs first, then rebuild on top. |
| **`src/App.tsx` (+28/−?), `src/peerApi.ts` (+4)** — *new since the first read* | Not read. | `App.tsx` is owned by **no** phase here (phase 4 is forbidden to edit it). | Watch only. If their `App.tsx` change touches the `<Approvals>` element at `:1256-1260` that `ThreadView.tsx:301,314` introspects, phase 4 must be told before it starts. |
| **`src/components/MessageTimestamp.tsx` + `.test.tsx` (new)** — *new since the first read* | A new component, not read. | **Possible.** It is a thread-row concern in a phase-4 neighbourhood. | Reconcile at merge; if it renders inside a row, §3 must say which row owns it. |

**Does their work overlap or supersede any part of this plan?** Partly, and in our favour:

- It **supersedes nothing** in §3 or §4 — they change no wire shape, no projection, no row kind.
- It **pre-solves** one thing phase 4 would otherwise have had to discover: the ExternalStore adapter
  must be memoized and `convertMessage` must have a stable identity. Phase 4 inherits that.
- It **does not** pre-solve the read-only converter's `.filter(p => p.type === 'text')`
  (`TranscriptRuntime.tsx:7`): their diff carries that line through unchanged. Phase 4 work item 8
  still has to do it, on top of their version of the file.
- It now **collides on a second file**, `ThreadView.tsx`, which was independent at the first read.
- It **raises the bar** for phase 5's burn: the baseline the rebuild is compared against should be
  taken *after* their fix lands, not before, or the rebuild will be credited with their gain. Their own
  doc is explicit that neither of their captures establishes the savings — *"a normal release capture
  is required"*.

**Recommended sequencing.** Land `codex/transcript-performance` on `main` **before** phase 4 starts,
and rebase `ui/codex-thread` onto it. If that is not possible, phase 4's first act is to copy their
`TranscriptRuntime.tsx`, `ThreadView.tsx` and both tests in verbatim, and the eventual merge is
resolved in our favour on those files with their semantics preserved. Either way phase 5's baseline
is taken on whatever tree the burn is measured against, with the sha stated (phase 5 step 1).

### 7.2 `codex/cli-updates` — **merged; no action** *(rewritten 2026-09-11)*

The earlier version of this section analysed
`/Users/stephen/Development/brigadier-ai.worktrees/cli-updates` as a live worktree. **It does not
exist**: `git worktree list` returns three entries and that path is not among them. The branch's work
is on `main` — `c9c1353`, merged at `f94c9ef` — and the six files it touched
(`src-tauri/src/lib.rs`, `src-tauri/src/updates.rs`, `src/softwareUpdates.ts`,
`src/softwareUpdates.test.tsx`, `src/components/SoftwareUpdates.tsx`,
`src/components/SoftwareUpdates.test.tsx`) arrive with the rebase this plan now requires. **[M]**
No collision, no sequencing, nothing to reconcile. The only consequence that survives is the one in
the header: **the base is `f94c9ef`, not `ea8d705`, and the burn baseline follows the base.**

---

## 8. Questions — the five originals are adjudicated; three new ones remain

**Q1 — Does the burn baseline get retaken after the performance fix lands? — ANSWERED (lead,
2026-09-11).** Yes, and the base moved besides. The baseline is taken on the commit this branch is
rebased onto, after `codex/transcript-performance` lands if it lands first; a baseline at `ea8d705`
is invalid either way. Both numbers get reported with their sha, so attribution stays honest.
Written into the header and phase 5 step 1; §7.1 carries the sequencing.

**Q2 — Is ~115 KB of extra stylesheet acceptable against a budget already ~90 ms over? — ANSWERED
(lead, 2026-09-11).** The spike's three-arm result is the answer, and it is a **precondition of phase
4**, not an end gate. If the delta is material, ship the kit CSS per-row behind lazy imports rather
than one sheet; **if it exceeds 20 ms p50, stop and ask.** Measured byte counts stand: 90,376 B
extracted CSS + 24,931 B tokens for the recommended set without `FileChange.tsx`; 127,480 + 24,931
with it. The spike arms are `src/spike/codex-css/`; its throwaway hook has already moved once (§5),
so phase 4's precondition is stated by property — no `src/spike/`, and
`grep -rn "codex-css-paint-spike" .` returns nothing — not by file and line.

**Q3 — "Looks like Codex" cannot be falsified. What is the acceptance bar? — ANSWERED (lead,
2026-09-11): the bar below is the bar.**
`docs/research/codex-thread-anatomy.md` §1 (`:36`, quoting the source page at L842) is explicit that the desktop app's visual design
exists "only as pixels in the closed app". `docs/research/codex-thread-tokens.md` closed much of that gap by reading
the shipped bundle, but nothing was ever rendered or screenshotted, and no reference frames exist.
**The bar is: the 17 live rows of §3 (19 less the two deferred), each rendering the data brigadier
actually has, at the token values cited from `docs/research/codex-thread-tokens.md`, with the six
gates green and the burn delta of Q2 inside budget.** Not "looks like Codex".
`docs/research/codex-thread-anatomy.md` §1 (`:36`, quoting the source page at L842) is explicit that
the desktop app's visual design exists "only as pixels in the closed app";
`docs/research/codex-thread-tokens.md` closed much of that gap by reading the shipped bundle, but
nothing was ever rendered or screenshotted and no reference frames exist. The stated bar is
achievable and checkable; the other is neither.

**Q4 — Steering: does Esc-once vs Esc-twice become a shipped affordance? — ANSWERED (lead,
2026-09-11): no, deferred.** Measured (`docs/research/cli-steer-and-exit-codes.md` §1): plain
`interrupt` = stop, then run the pending message as a new turn; `interrupt` with
`cancel_queued: true` = stop and drop it. The CLI announces neither, and `still_queued`/`cancelled`
are empty in both directions, so the UI cannot show a queued state sourced from the wire. Ship the
durable brigadier queue as the only queue (it already exists), map the composer's stop control to
plain `interrupt`, and defer the Esc-Esc hard-stop. **Do not build a "queued on the CLI" indicator —
there is no signal behind it.**

**Q5 — Does the exit code ship as a wire field? — ANSWERED (lead, 2026-09-11): yes, D13 stands.**
Wire field, parsed once in Rust, in phase 2, **before** any UI work — the alternative is a
provider-specific regex on the TypeScript side that will silently drift, and row 7 would otherwise
ship with a permanently `undefined` prop. It costs `crates/core/src/event.rs` + `src/wire.ts` +
`docs/plans/ipc-contract.md` in lockstep. Until it lands, `exitCode` stays undefined and is **never**
inferred from `is_error`.

### 8.1 New questions this amendment raises

**Q6 — Is ~100 ms refetch granularity the right cost for streaming, or should the delta notify be
throttled?** §4.2.2 wakes `useConversationHistory` at frame resolution and lets its existing 100 ms
debounce set the pace, so a 20 s streaming turn costs roughly 200 `historyPage` + `chatTurns` pairs
against SQLite. The burn sustains 534–544 history responses in 63 s today
(`useConversationHistory.ts:92-93` **[M]**), so this is inside measured territory — but that
measurement was of a synthetic row flood, not of a real turn streaming prose.
**Recommended default:** ship the 100 ms path, and make phase 5's burn report the per-turn refetch
count explicitly. If it is the dominant cost, the cheapest dial is a delta-specific debounce (say
250 ms) inside `changed()`, not a change to the counter. Do not pre-optimise it in phase 2.

**Q7 — Does the `deltas` counter belong in the durable store as well as the frame counter?** As
specified it is process-local: a reload rebuilds bodies from SQLite, which is correct, but the counter
itself restarts at 0 and a session that streamed before the reload shows no delta history. Nothing in
this plan needs that history.
**Recommended default:** no. Keep it a frame counter. If a future feature needs "how much of this
body arrived as a stream", `chat_items.seq` already answers it.

**Q8 — Who owns `index.html` and `src/App.tsx` for the duration?** Neither is in any phase's owned
paths, and both now carry uncommitted changes from other workers (§5, §7.1).
**Recommended default:** phase 5's catch-all owns both, and phases 2–4 treat them as read-only; any
phase that believes it must edit either files a question rather than editing.

---

## 9. What was not checked

- **Nothing was rendered, built, installed or run.** No `npm install`, no `cargo build`, no gate, no
  burn — another worker owns builds in this worktree. Every performance number quoted here is carried
  from `docs/STATUS.md` or `docs/research/`, not re-measured.
- **The streaming claim has now been wrong twice, in opposite directions, and the second error shipped
  in the published plan.** The stale survey said deltas never reach the store; the first draft
  corrected that by reading `crates/store/src/feed.rs:294-296`, `writer.rs:369-372`,
  `chat.rs:197-214` and `crates/store/tests/history_pages.rs:61-62` — all correct — and then
  over-generalised to "streaming already reaches the UI", which is false: `feed.rs:180` and
  `batcher.rs:44-58` leave the frontend un-notified. The adversarial review caught it and the lead
  re-verified it. §1.7 and §4.2 now carry the third version, **phase 2 gained a work item rather than
  losing one**, and the earlier boast that it lost one is deleted. Anyone reading a summary of this
  plan written before 2026-09-11 should discard its streaming section entirely.
  *The general lesson, worth keeping*: three of the four links in that chain verified, and the
  conclusion was drawn before the fourth was read.
- **The kit's runtime behaviour.** Nobody has run `codex-ui-kit`. Its components were read as source
  only, and the vendoring script's run was done in the scratchpad, not in this tree.
- **`src/icons/` coverage** against the glyphs the vendored kit components draw inline. 75 glyphs exist;
  which ones the kit needs was not enumerated.
- **The `@tanstack/react-virtual` × `ThreadPrimitive.Viewport` interaction.** D17 defers it on the
  strength of assistant-ui's own warning; nobody has measured whether the current arrangement actually
  fights, or whether `[content-visibility:auto]` on message roots would do better in WebKit 26.5.
- **`ApprovalRequest`'s global Enter/Escape handlers against the Lexical composer.** Flagged as an
  audit in phase 4; not performed.
- **Whether the usage-window getter of §4.3 defeats any existing snapshot-identity guard.** Designed
  to sit outside the session snapshot; the interaction was reasoned, not tested.
- **`docs/STATUS.md` §§1–3** are dated 2026-09-04 and describe a UI replaced twice since; only its §4
  numbers and §7 landmines were used here.
- **Line numbers quoted from `docs/research/thread-render-path-2026-09-10.md`, `docs/research/codex-thread-anatomy.md` and
  `docs/research/codex-thread-tokens.md`** into files outside this repository were not re-verified; they are those
  documents' citations, carried forward.
- **`crates/store/src/feed.rs::terse_line`** has now been read in full (`:152-200`), which is how the
  `ContentDelta` → `None` arm at `:180` was found. §4.4's claim that a new `ItemKind` needs an arm in
  both functions stands: `feed::kind` is documented as total at `:110-113` and defined at `:114`, and
  `terse_line`'s `match` has no wildcard either.

Added by the 2026-09-11 amendment:

- **The delta rate itself is asserted, not measured.** §4.2.1's "~600 deltas over ~20 s" is an
  estimate; nobody counted `ContentDelta` envelopes in a real turn. The byte arithmetic around it, and
  every cap it is compared against, are measured.
- **The counter design was not run.** No Rust was compiled, no test executed; §4.2.1 is a reading of
  `batcher.rs`, `wire.rs` and `feedStore.ts`, not a working patch.
- **The `codex/transcript-performance` diff was re-read only at the file-and-stat level** on
  2026-09-11. Their new `ThreadView.tsx` (+33), `App.tsx` (+28), `peerApi.ts` (+4) and
  `MessageTimestamp.tsx` changes were **not** read line by line; §7.1 says so in its own rows.
- **`src/spike/`'s three arms were not measured here**, and their throwaway hook moved during this
  amendment (§5) — a live worker owns it, so any statement here about where that hook is has a
  shelf life of hours. The property-based precondition is what phase 4 should trust.
- **The review that produced this amendment was itself checked, not trusted.** Ten of its citation
  corrections were re-read against the tree and applied; one (`WorkTrace.tsx:187` → `:188`) was wrong
  and was not applied. Its finding that a `user-input` request would be "invisible with no way to
  answer" was also wrong in part — `Approvals.tsx:191,247-253` renders it and
  `ThreadView.tsx:495` places it — and row 19 records the accurate version.
