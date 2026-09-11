# Codex-style thread — component sourcing and row mapping

Row-by-row build plan for restyling brigadier's conversation thread toward Codex's look: for each of
Codex's 18 row kinds, compares the matching assistant-ui registry component against the matching
`codex-ui-kit` component, picks one (or neither), and checks the pick against what brigadier's tree actually
has data for. Gathered 2026-09-10, against `main` @ `61e8576` — the same commit as
`thread-render-path-2026-09-10.md`; see that file's staleness warning for what has moved since (the
`src/components/...` file/line citations below are from that same pre-migration commit). Method: read the
assistant-ui component registry (live-fetched, and saved to a session-local scratchpad — not part of this
repository; re-fetchable from `https://r.assistant-ui.com/`), read `codex-ui-kit`'s source directly at
commit `9f3af2c3a6386d4ea05f8b3f2c1051ae1a50789d` (re-clonable at that commit), and wrote and ran a
vendoring script against the recommended component picks to get real byte counts. Every claim below is
tagged **MEASURED** (ran it or read the file) or **ASSERTED** (inference, someone else's doc, or a
judgement). Below, `<scratchpad>` denotes that session-local directory. "What I did not check" is §5.

**Authority.** This file is authoritative for: which assistant-ui registry component and which
`codex-ui-kit` component (if either) best serves each of Codex's 18 row kinds, the concrete vendoring
byte-cost numbers for the recommended set, and the ten open questions a build order needs answered before
work starts. It is **not** authoritative for Codex's row taxonomy itself (see `codex-thread-anatomy.md`),
for pixel-exact Codex Desktop values (see `codex-thread-tokens.md`), for `codex-ui-kit`'s licensing terms
(see `codex-ui-kit.md`), or for the current state of brigadier's own thread code (see
`thread-render-path-2026-09-10.md` and its staleness warning).

Source material used, all read: `codex-ui-kit.md`, `codex-thread-anatomy.md`,
`thread-render-path-2026-09-10.md`, the live assistant-ui registry, the local `codex-ui-kit` clone at
`9f3af2c3a6386d4ea05f8b3f2c1051ae1a50789d`, and the `ui/design-system` worktree (read-only; nothing there was
modified).

---

## 0. Two findings that reframe the plan

**(a) assistant-ui ships two disjoint component families under one `elements/` folder.** MEASURED, by
reading all 39 extracted source files.

| family | file suffix | how it gets data | design substrate | example |
|---|---|---|---|---|
| **runtime-bound** | `*.aui.tsx` | reads assistant-ui state (`useAuiState`, `MessagePrimitive`, `useMessageTiming`, part props) | shadcn leaves under `@/components/ui/*` (Base UI on this project) | `thread.aui.tsx`, `tool-fallback.aui.tsx`, `tool-group.aui.tsx`, `reasoning.aui.tsx`, `message-timing.aui.tsx`, `context-display.aui.tsx`, `markdown-text.tsx` |
| **presentational showcase** | plain `.tsx` | flat scalar props the *caller* animates — `words: readonly string[]`, `visibleWords: number`, `count`, `progress: readonly number[]`, `cycle` | a string-constant sheet, `elements/surfaces.tsx` (`paper`, `field`, `inkButton`, `mono`, …) — no shadcn, no Base UI | `message-pair`, `tool-call`, `terminal-block`, `approval-card`, `subagent-list`, `agent-status`, `code-diff`, all 20 others |

The second family is the docs-site gallery. `MessagePair` takes `words`+`visibleWords` and slices
with `take()`; `TerminalBlock` takes `lines`+`visibleCount` and hard-codes `exit 0`;
`SubagentList` takes `progress: readonly number[]` of literal percentages;
`ScrollAnchor` runs its own `setInterval` appending demo messages. Every one is capped at
`max-w-sm` / `max-w-md` / `max-w-xs`. **None of them can be driven by a runtime without a rewrite of
their prop surface.** They are a *look*, not a component library — which is exactly how they should
be treated in this plan: read them for spacing/type/colour decisions, do not install them expecting
wiring.

Only 7 of the 28 requested names resolve to something runtime-bound.

**(b) `data-*` message parts are a real, documented seam.** MEASURED
(`docs/runtimes/custom/external-store.md:727`, `docs/primitives/message.md:126,164,439`):
`ThreadMessageLike.content` accepts `{ type: "data-<name>", data: {...} }`, auto-converted to a
`DataMessagePart`, routed by `components.data.by_name` or read as `part.dataRendererUI` in the
children API. `thread.aui.tsx:441` already has `case "data": return part.dataRendererUI;`. So
brigadier's custom rows (approval card, changed-files card, compaction notice, peer bubbles, the
"Worked for" trace) can be first-class parts inside a real `MessagePrimitive` message, instead of
the current arrangement where `TranscriptRuntime` is fed `content: []` for every work row
(`ThreadView.tsx:314-326`) and the rows are hand-written JSX beside the runtime.

---

## 1. Registry read — MEASURED

**Style.** `components.json` on `ui/design-system` is `"style": "base-nova"` with
`"@assistant-ui": "https://r.assistant-ui.com/styles/{style}/{name}.json"` — already correct
(MEASURED, read the file). `https://www.assistant-ui.com/docs/base-ui.md`: any style whose name
starts with `base-` selects the Base UI flavour. MEASURED: `base-nova`, `base-new-york` and
`base-default` return **byte-identical** payloads for `thread`, `tool-fallback`, `message-timing`,
`context-display` and `elements-approval-card` (compared by sha1). The style name selects flavour
only, not visual style. `nova` (Radix) differs for `thread`, `message-timing`, `context-display`,
`elements-approval-card`; `tool-fallback` is identical in both flavours.

**Naming.** 21 of the 28 requested names 404 at their bare name and resolve under an
`elements-` prefix (`elements-approval-card`, `elements-tool-call`, …). Seven resolve bare:
`thread`, `message-timing`, `reasoning`, `tool-fallback`, `tool-group`, `context-display`,
`markdown-text` — and those seven are exactly the runtime-bound family. MEASURED.

Raw payloads saved to `<scratchpad>/aui-registry/*.json` (39 files, including the transitively
resolved dependencies). Extracted sources at `<scratchpad>/aui-src/<registry-name>/`.

### The table

| requested | registry name | file installed (lines) | npm deps (transitive) | registryDependencies -> leaf shadcn | Radix-individual? |
|---|---|---|---|---|---|
| `thread` | `thread` | `components/assistant-ui/elements/thread.aui.tsx` (650) | @assistant-ui/react, **lucide-react**, **zustand**, class-variance-authority, @assistant-ui/react-markdown, remark-gfm, tw-shimmer | button, skeleton, attachment, dialog, tooltip, avatar, tooltip-icon-button, use-attachment-src, file, follow-up-suggestions, image, markdown-text, use-copy-to-clipboard, reasoning, elements-reasoning, collapsible, tool-fallback, textarea, tool-group | no |
| `message-pair` | `elements-message-pair` | `components/assistant-ui/elements/message-pair.tsx` (96) | **lucide-react**, tw-shimmer | elements-surfaces, elements-range | no |
| `message-actions` | `elements-message-actions` | `components/assistant-ui/elements/message-actions.tsx` (125) | **lucide-react**, tw-shimmer | elements-surfaces | no |
| `message-timing` | `message-timing` | `components/assistant-ui/elements/message-timing.aui.tsx` (105) | @assistant-ui/react | tooltip | no |
| `message-queue` | `elements-message-queue` | `components/assistant-ui/elements/message-queue.tsx` (91) | **lucide-react**, tw-shimmer | elements-surfaces | no |
| `reasoning` | `reasoning` | `components/assistant-ui/elements/reasoning.aui.tsx` (121) | @assistant-ui/react, **lucide-react**, class-variance-authority, tw-shimmer, @assistant-ui/react-markdown, remark-gfm | elements-reasoning, collapsible, markdown-text, tooltip-icon-button, tooltip, button, use-copy-to-clipboard | no |
| `thinking-indicator` | `elements-thinking-indicator` | `components/assistant-ui/elements/thinking-indicator.tsx` (44) | tw-shimmer | elements-surfaces | no |
| `tool-call` | `elements-tool-call` | `components/assistant-ui/elements/tool-call.tsx` (89) | **lucide-react**, tw-shimmer | elements-surfaces, collapsible | no |
| `tool-fallback` | `tool-fallback` | `components/assistant-ui/elements/tool-fallback.aui.tsx` (754) | @assistant-ui/react, **lucide-react**, tw-shimmer | button, collapsible, textarea | no |
| `tool-group` | `tool-group` | `components/assistant-ui/elements/tool-group.aui.tsx` (231) | @assistant-ui/react, **lucide-react**, class-variance-authority, tw-shimmer | collapsible | no |
| `tool-timeline` | `elements-tool-timeline` | `components/assistant-ui/elements/tool-timeline.tsx` (121) | **lucide-react**, tw-shimmer | elements-surfaces, elements-range, collapsible | no |
| `tool-error` | `elements-tool-error` | `components/assistant-ui/elements/tool-error.tsx` (97) | **lucide-react**, tw-shimmer | elements-surfaces | no |
| `approval-card` | `elements-approval-card` | `components/assistant-ui/elements/approval-card.tsx` (124) | **lucide-react**, tw-shimmer | elements-surfaces | no |
| `permission-grant` | `elements-permission-grant` | `components/assistant-ui/elements/permission-grant.tsx` (113) | **lucide-react**, tw-shimmer | elements-surfaces | no |
| `terminal-block` | `elements-terminal-block` | `components/assistant-ui/elements/terminal-block.tsx` (110) | **lucide-react**, tw-shimmer | elements-surfaces, elements-range | no |
| `code-diff` | `elements-code-diff` | `components/assistant-ui/elements/code-diff.tsx` (84) | tw-shimmer | elements-surfaces | no |
| `reviewable-diff` | `elements-reviewable-diff` | `components/assistant-ui/elements/reviewable-diff.tsx` (154) | **lucide-react**, tw-shimmer | elements-surfaces, elements-code-diff | no |
| `subagent-list` | `elements-subagent-list` | `components/assistant-ui/elements/subagent-list.tsx` (122) | **lucide-react**, tw-shimmer | elements-surfaces, elements-range | no |
| `agent-status` | `elements-agent-status` | `components/assistant-ui/elements/agent-status.tsx` (75) | **lucide-react**, tw-shimmer | elements-surfaces | no |
| `stopped-run` | `elements-stopped-run` | `components/assistant-ui/elements/stopped-run.tsx` (70) | **lucide-react**, tw-shimmer | elements-surfaces | no |
| `scroll-anchor` | `elements-scroll-anchor` | `components/assistant-ui/elements/scroll-anchor.tsx` (140) | **lucide-react**, tw-shimmer | elements-surfaces | no |
| `context-display` | `context-display` | `components/assistant-ui/elements/context-display.aui.tsx` (124) | @assistant-ui/react, **@assistant-ui/ai-sdk** | elements-context-display, tooltip | no |
| `quota-banner` | `elements-quota-banner` | `components/assistant-ui/elements/quota-banner.tsx` (99) | tw-shimmer | elements-surfaces, elements-range | no |
| `error-state` | `elements-error-state` | `components/assistant-ui/elements/error-state.tsx` (77) | **lucide-react**, tw-shimmer | elements-surfaces | no |
| `day-separator` | `elements-day-separator` | `components/assistant-ui/elements/day-separator.tsx` (77) | tw-shimmer | elements-surfaces | no |
| `markdown-text` | `markdown-text` | `components/assistant-ui/elements/markdown-text.tsx` (269) | @assistant-ui/react, @assistant-ui/react-markdown, **lucide-react**, remark-gfm | tooltip-icon-button, tooltip, button, use-copy-to-clipboard | no |
| `streaming-text` | `elements-streaming-text` | `components/assistant-ui/elements/streaming-text.tsx` (76) | — | elements-range | no |
| `composer` | `elements-composer` | `components/assistant-ui/elements/composer.tsx` (660) | **lucide-react**, tw-shimmer | elements-surfaces, elements-range | no |

### De-duplicated npm additions for the whole 28-name set

Against `package.json` on `ui/design-system` (MEASURED, read):

| package | status | pulled in by |
|---|---|---|
| `@assistant-ui/react` | **already a dependency** (0.15.18) | most |
| `@assistant-ui/react-markdown` | **already** (^0.14.14) | `markdown-text`, `reasoning` |
| `remark-gfm` | **already** (^4.0.1) | `markdown-text` |
| `class-variance-authority` | **already** (^0.7.1) | `tool-group`, `elements-reasoning`, `file`, `image` |
| `tw-shimmer` | **already** (^0.4.12) | `elements-surfaces` and everything importing it |
| `lucide-react` | **NEW — and removed on purpose** | 21 of 28 components |
| `zustand` | **NEW** | only `use-attachment-src`, reached via `attachment` ← `thread` |
| `@assistant-ui/ai-sdk` | **NEW** | only `context-display.aui.tsx` (`useThreadTokenUsage`) |

**Radix ban: no violation anywhere.** MEASURED — I grepped every one of the 39 extracted files for
`@radix-ui/react-`, `radix-ui` and `@base-ui`: **zero hits**. The headless coupling lives entirely
inside the shadcn leaf components (`@/components/ui/{button,skeleton,collapsible,textarea,tooltip,dialog,avatar}`),
all seven of which already exist on `ui/design-system` (MEASURED, `ls src/components/ui/`). Adding
any of these 28 adds **no** Radix package, individual or monolithic.

**The real dependency problems are the three NEW rows, and all three are avoidable:**

- `lucide-react` was deliberately deleted from `package.json` on `ui/design-system` and replaced by
  52 icons vendored into `src/icons/` from `@openai/apps-sdk-ui` (MEASURED: `package.json` has no
  `lucide-react` and no `@phosphor-icons/react`; `scripts/vendor-icons.mjs` exists). Every vendored
  assistant-ui file needs its lucide imports rewritten. ASSERTED: this is a mechanical
  import-swap, roughly 15 distinct icon names across the set
  (`Copy, RefreshCw, Check, ChevronRight, ChevronDown, ChevronLeft, AlertCircle, CircleAlert, Loader2, Loader, Terminal, KeyRound, X, ArrowDown, ArrowUp, ArrowRight, Square, RotateCw, RotateCcw, Pause, ThumbsUp, ThumbsDown, Ellipsis, MoreHorizontal, Pencil, Mic, Download`).
  Note `src/icons/` has 52 icons; whether it covers all of those was **not** checked.
- `zustand` enters only through `attachment` → `use-attachment-src`. Vendor `thread.aui.tsx` without
  the attachment slots and it never arrives. (brigadier's composer already owns attachments —
  `src/components/composer/AttachmentPreview.tsx`, `useAttachmentImports.ts`.)
- `@assistant-ui/ai-sdk` enters only through `context-display.aui.tsx`. The **base**
  `elements-context-display` takes `usage: TokenUsage` and `modelContextWindow: number` as plain
  props (MEASURED, read `elements-context-display/context-display.tsx:19-101`), so it can be fed
  from `SessionRuntime.usage` with no new package. Use the base, not the `.aui` wrapper.

### Three specific landmines found in the registry source — MEASURED

1. **`tool-fallback.aui.tsx` disables its approval buttons optimistically.**
   `const [submitted, setSubmitted] = useState(false)` at `:379`, then `disabled={submitted}` on
   every control at `:495, 506, 552, 561, 595, 607, 653, 662`, set the moment the user clicks and
   reverted only if the send *throws*. The card itself unmounts only when the runtime reports
   `approval.approved !== undefined || approval.resolution !== undefined` (`:384-388`), so the
   *card* is non-optimistic but the *controls* are not. Against `CLAUDE.md` §5 / `vision.md` §9 this
   is a judgement call, not an automatic fail — see open question Q4.
2. **`elements-approval-card` hard-codes `Finished with exit 0`** in its `done` branch and takes no
   exit-code prop (`approval-card.tsx:110-113`). This is precisely the adaptation
   `docs/research/chatgpt-subagents-and-brigadier-design-2026-09-09.md:274` demands. MEASURED.
3. **`message-timing.aui.tsx` renders `null` unless the runtime measured the stream**
   (`useMessageTiming()`, `if (timing?.totalStreamTime === undefined) return null`). brigadier's
   bodies come from a SQLite page, not a token stream (`thread-render-path-2026-09-10.md` §5), so this
   component will render nothing in brigadier as installed. Its per-turn duration must come from
   `ChatTurn.started_at/ended_at` instead.

Also worth knowing: `thread.aui.tsx` message roots carry
`[content-visibility:auto] [contain-intrinsic-size:auto_200px]` (`:388, :548`) — browser-level
render skipping that partly substitutes for the `@tanstack/react-virtual` pass, and is likely
cheaper than the current `estimateSize: () => 140` guess. NOT measured in WebKit 26.5.

---

## 2. Row comparison — Codex row kind × assistant-ui × codex-ui-kit

Both sides read from source, not from names. aui files under `<scratchpad>/aui-src/`; kit files under
`<scratchpad>/codex-ui-kit/src/components/`. "Fidelity" is judged against the ASCII mocks and prose in
`codex-thread-anatomy.md` — which is itself explicit that the desktop app's visuals are undocumented,
so every fidelity call here is **ASSERTED**.

Legend for the pick column: **aui** = install the assistant-ui component · **kit** = vendor the
codex-ui-kit component · **hybrid** = aui owns the wiring, kit owns the chrome · **hand-built** = neither.

---

### 1. User message

- **aui** — `thread/thread.aui.tsx:539-570` `UserMessage`. MEASURED: `MessagePrimitive.Root` in a
  2-col grid, bubble `bg-muted text-foreground rounded-xl px-4 py-2 wrap-break-word empty:hidden`,
  `UserMessageAttachments` above, a hover action bar absolutely positioned to the **left** of the
  bubble, `[content-visibility:auto]`. Expects: a runtime message with `role:"user"`.
  Edit is `EditComposer`, swapped in on `s.message.composer.isEditing`.
- **kit** — `AgentMessage.tsx:22-91` (178 lines). Props `{role, status, children, actions?,
  attachments?, metadata?, editable?, highlighted?, onEdit?}`. Renders
  `<article data-role data-status>` with `codex-ui-agent-message__content[data-user-message-bubble]`,
  double-click / Enter / Space to edit, a `metadata`+`actions` footer.
- **Fidelity** — aui: good, the right-aligned rounded bubble is the ChatGPT/Codex desktop shape; its
  action bar hangs left of the bubble rather than below it. kit: closer — `metadata` is the slot the
  timestamp belongs in, `highlighted` is the jump-target state, and `data-role`/`data-status` are
  token-styled rather than utility-styled. Neither has brigadier's 5-line clamp over 480 chars /
  8 lines (`ThreadView.tsx:543`), which is a shipped decision from the 2026-09-06 redesign.
- **Pick: hybrid.** aui `MessagePrimitive` for identity, `data-message-id` ordering and the edit
  composer (18 tests assert on those, `ThreadView.test.tsx`); kit's `codex-ui-agent-message` CSS for
  the bubble; brigadier's existing clamp kept verbatim.
- **Data: exists.** `user-text` `ChatItem` with no `parent_id` (`threadProjection.ts:231-235`).

### 2. Assistant answer (final)

- **aui** — `thread.aui.tsx:381-480` `AssistantMessage`: `MessagePrimitive.GroupedParts` +
  `MarkdownText` + `AssistantActionBar` (copy / reload / export-markdown) + `BranchPicker` +
  `MessageError`. `markdown-text.tsx` is 269 lines over `@assistant-ui/react-markdown`.
- **kit** — `AgentMessage role="assistant"` + `AgentMarkdown.tsx` (1450 lines). MEASURED: pulls
  `react-markdown` + `remark-gfm` statically and `rehype-katex` + `remark-math` dynamically when it
  sees `$$`; `CodeBlock` lazily imports `highlightCode.ts` (`highlight.js`) behind an
  IntersectionObserver.
- **Fidelity** — a wash on the message shell. On markdown, brigadier already has a lazy 286 KB
  markdown chunk (`Markdown.tsx:36-45`) and `shiki` for highlighting; `AgentMarkdown` would be a
  third markdown stack.
- **Pick: aui shell, brigadier's own markdown.** Do not take `AgentMarkdown` — it duplicates a
  subsystem brigadier has already paid for and adds KaTeX + highlight.js.
- **Data: exists.** Trailing root `assistant-text` merged at `threadProjection.ts:216-222`.

### 3. Commentary (interim assistant prose)

- **aui** — **nothing.** There is no `phase` concept anywhere in the registry; `groupPartByType` can
  coalesce adjacent text parts but cannot tell commentary from a final answer.
- **kit** — no dedicated component either, but `ActivityTimeline`'s `persistentContent` /
  `preToggleContent` slots (`ActivityTimeline.tsx:26-102`) are designed for exactly this: content
  that stays visible outside the collapsible.
- **Fidelity** — the digest (L394) says the distinction is carried by `agentMessage.phase`, not by
  layout, and that "how they differ visually on desktop" is undocumented (L852).
- **Pick: hand-built,** as a `data-commentary` part rendered into the turn group's persistent slot.
- **Data: exists but the distinction is positional.** brigadier folds mid-turn prose into the `work`
  row (`threadProjection.ts:171`) and treats only the trailing text as final (`:174-178`). Nothing on
  the wire says "commentary"; the projection infers it. Good enough — but a later provider change
  breaks the inference.

### 4. Reasoning

- **aui** — `reasoning/reasoning.aui.tsx` (120 lines) over `elements-reasoning/reasoning.tsx`
  (329 lines): `ReasoningRoot / Trigger / Content / Text / Fade`, a `cva` variant set, a fade mask,
  `useScrollLock` during the disclosure animation, and `group-reasoning` grouping already wired in
  `thread.aui.tsx:418-434`. Streaming state read from `s.message.parts[i].status`.
- **kit** — `AgentReasoning.tsx` (74 lines): `{status:"running"|"completed", label?, open?,
  defaultOpen?, onOpenChange?, children}` over a native `<details>/<summary>` with a chevron.
- **Fidelity** — Codex desktop 26.602 shows a blinking "Thinking" label and **no visible summaries**
  (digest L411); both of these are disclosures, so both are the IDE-extension shape, not the desktop
  one. aui's is richer (fade, scroll-lock, per-part streaming); kit's is 74 lines and token-styled.
- **Pick: aui.** It is the only one wired to part-level streaming, and the grouping is free.
  brigadier already ships a `ReasoningPanel` (`elements/reasoning-panel.tsx`, 104 lines) to replace.
- **Data: exists.** `thinking` `ChatItem`. Landmine: empty-bodied thinking nodes are **deleted** and
  replaced by their children (`threadProjection.ts:162-164`) — the aui grouping must not resurrect them.

### 5. Turn header — "Worked for"

- **aui** — `message-timing/message-timing.aui.tsx` (104 lines) is the only timing component and it
  reads `useMessageTiming()`, returning `null` when `totalStreamTime === undefined`. MEASURED:
  brigadier's bodies come from a SQLite page, never a token stream, so **this renders nothing in
  brigadier.** `tool-group.aui.tsx:100` labels its trigger `"N tool calls"` — a count, not a duration.
- **kit** — `TurnDuration.tsx` (97 lines): `{status:"working"|"worked"|"stopped", durationMs?,
  startedAtMs?, completedAtMs?, workingLabel?/workedLabel?/stoppedLabel?: (time)=>ReactNode}`,
  one `<span data-status>`, a 1 s interval while working. Text: "Working" / "Working for Xs" /
  "Worked for Xs" / "You stopped after Xs".
- **Fidelity** — aui ✗ (wrong data source entirely). kit ✓✓ — this is the Codex string, and the
  render-prop labels let brigadier keep its own wording. Missing vs the digest: the "· done 3:04 PM"
  half, and the rule that "Worked for" only appears above 60 s (L620-625).
- **Pick: kit.**
- **Data: exists.** `ChatTurn.started_at/ended_at/status` → `row.durationMs`
  (`threadProjection.ts:203-207`), already rendered at `WorkTrace.tsx:89` with a live 1 s tick
  (`:66-72`) — the same mechanism `TurnDuration` implements, so this is a straight swap.

### 6. Exploration group / activity fold

- **aui** — the *mechanism* is `MessagePrimitive.GroupedParts` + `groupPartByType`
  (`docs/guides/part-grouping.md`), and an inline `groupBy` may branch on `part.parentId` — which
  matches brigadier's `TraceNode` parent nesting. The *chrome* is `tool-group.aui.tsx` (230 lines):
  Collapsible, `useScrollLock`, `cva` outline/ghost/muted, trigger = loader + `"N tool calls"` + count.
- **kit** — `ActivityTimeline.tsx` (102 lines) `{summary: ReactNode, collapsedCount?,
  persistentContent?, preToggleContent?, showToggle?, open/defaultOpen/onOpenChange}` for the fold,
  and `AgentActivity.tsx` (184 lines) for each row inside it: `{kind: command|file-change|reasoning|
  search|subagent|tool|generic, status, summary, detail?, description?, indicator?, disclosureMode:
  "button"|"details"|"overlay-button"}`. `AgentActivity` is the kit's base disclosure — `ToolCallCard`,
  `SearchActivity`, `McpToolCallGroup`, `CommandExecution` and `FileChange` all compose it.
- **Fidelity** — aui ✓ for grouping, ✗ for shape: a bare count is not Codex's sentence
  ("Edited 3 files, explored 2 files, 2 searches", digest L443). kit ✓✓: `summary` takes any
  sentence and `persistentContent` is where the live working line goes.
- **Pick: hybrid.** `thread.aui.tsx`'s `ThreadComponents.ToolGroup` override slot exists precisely
  for this — aui supplies `part.indices` and `part.status`, kit's `ActivityTimeline`+`AgentActivity`
  draw it. One caveat: taking any `AgentActivity` descendant pulls `AgentActivity` + `StatusIndicator`.
- **Data: exists.** brigadier already computes the sentence (`activitySummary`
  `threadProjection.ts:283`, `activeWorkLabel` `:310`) and batches adjacent childless calls
  (`WorkTrace.tsx:161-170`), capping at 40 groups with a "Show more activity" button (`:171`).

### 7. Command execution

- **aui** — `tool-fallback/tool-fallback.aui.tsx` (753 lines) is generic: `statusIconMap`,
  `formatToolDuration`, args/result/error blocks, `formatUnknownValue` JSON dumping, plus the
  approval sub-tree. `elements-terminal-block` (109 lines) looks the part but is a showcase: props
  `{command, lines: readonly string[], visibleCount: number, done: boolean, variant}` and a
  hard-coded `exit 0` string (`terminal-block.tsx:54-58`).
- **kit** — `CommandExecution.tsx:117-320` (whole file 431 lines): `{command, status:
  AgentItemStatus|"interrupted"|"background-running"|"background-finished", exitCode?: number,
  durationMs?/startedAtMs?/completedAtMs?, cwd?, shellLabel?, summary?, compactDetail?, detail?,
  footer?, hideRawCommand?, copyCommandText?, onCopyCommand?, open?/onOpenChange?}` over
  `AgentActivity`, with a live duration tick and a footer that says Success / Exit code N / Pending /
  Stopped. Plus `CommandOutput` `{stream:"stdout"|"stderr", copyText, onCopy, emptyLabel}` — a
  scrollable `<pre><code>` with top/bottom scroll fades and auto-scroll.
- **Fidelity** — kit ✓✓, a direct model of the protocol's `commandExecution` item down to
  `interrupted` and the background-terminal states (digest L437-451). aui ✗✗ for the showcase block,
  ✓ for tool-fallback but shaped as a JSON dump.
- **Pick: kit.**
- **Data: partly missing.** The command string lives inside the `tool-call` input (parseable).
  **`exitCode` is not on the wire** — `ItemKind::ToolResult` carries only `is_error: bool`
  (`wire.ts:62`); the exit code sits unparsed inside the result body. Per-command duration is
  derivable from `ChatItem.at` on call and result but nothing computes it. Both are in the survey's
  gap list; the first needs a wire-contract change in `crates/core/src/event.rs` **or** a store-side
  body parse. Until then `exitCode` must be left `undefined`, not guessed — the `is_error` boolean
  can drive `status:"failed"` and nothing more.

### 8. File change card

- **aui** — `elements-code-diff` (83 lines): `{filename, additions, deletions, lines: DiffLine[],
  cycle: number}` — `cycle` exists only to re-key the demo's animation loop.
  `elements-reviewable-diff` (153 lines): per-hunk keep/discard with an `Apply N` button. Both are
  showcase components; neither reads a runtime.
- **kit** — inside `FileChange.tsx` (1639 lines): `FileChangeGroup` `{changes:
  FileChangeGroupItem[]{path, change:"added"|"modified"|"deleted"|"renamed", additions?, deletions?,
  previousPath?}, summary?, detail?, status?, onOpenFile?}`; `FileChange` `{path, change, additions,
  deletions, diffText?, showDiffDetails?, onCopyDiff?, onOpenFile?, open?}`; `FileDiff` `{lines:
  FileDiffLine[], layout:"split"|"unified", size, wrapLines, renderContent?}`.
- **Fidelity** — kit ✓✓: "Edited N files (+A −R)" with per-file rows and `old → new` renames is
  exactly digest L456-470. aui ✗.
- **Pick: kit — `FileChangeGroup` + `FileChange` only.** The rest of that file is the Codex **review
  pane**: `FileReview`, `FileReviewWorkspace` (491 lines, 7 `useState`, 4 `useLayoutEffect`, custom
  keyboard nav), `FileRevertErrorDialog`. Those are out of scope and drag in `Dialog.tsx` (355) and
  `InteractivePrimitives.tsx` (1312). MEASURED: including `FileChange.tsx` costs **+37,104 bytes of
  CSS** and +3 files over the same set without it. The vendoring script's allow-list is per-file, so
  this needs a manual dead-export trim after vendoring — see Q7.
- **Data: exists, partially.** `desktopApi.changes(sessionId)` gives per-turn `files[]` with
  `added`/`deleted` counts (`SessionReview.tsx:36-44`), **polled every 3.5 s**
  (`desktopApi.ts:129`) and attached only under a final answer row (`ThreadView.tsx:443-452`).
  Per-file `diffText` does not exist, so `FileChange`'s expanded body has nothing to show —
  vendor `FileChangeGroup` first and leave `FileChange`/`FileDiff` for when a diff IPC exists.

### 9. MCP / tool call

- **aui** — `tool-fallback.aui.tsx` (753 lines) is the strongest runtime-bound component in the set:
  it owns `addResult`, `resume`, `respondToApproval`, `status`, `interrupt`, a declared-option list,
  free-text answers, a confirm step, error rendering and a duration. It is also the only path by
  which a `ToolCallMessagePart` reaches a renderer at all when no named tool UI is registered.
- **kit** — `ToolCallCard.tsx` (206 lines) `{name, source?, status, summary?, result?, error?,
  errorPresentation:"alert"|"output", rawOutput?, onViewRawOutput?, structuredContent?, accessory?,
  activeLabel/completedLabel/failedLabel, collapsible, open?}`; `McpToolCallGroup.tsx` (102 lines)
  `{name, source?, status, icon?, open?}` with a built-in MCP glyph and a "Using X integration" →
  "Used X integration" label flip.
- **Fidelity** — kit ✓✓ for the Codex verb flip (Calling → Called, digest L475-483) and the "show
  raw output" affordance that stands in for the transcript view. aui ✓ for capability, ✗ for shape —
  it renders args as a `<pre>` JSON blob.
- **Pick: hybrid, leaning kit.** Register a named tool renderer that takes the aui part props
  (`args`, `result`, `status`, `approval`, `respondToApproval`) and draws them with kit
  `ToolCallCard` / `McpToolCallGroup`. Keep `tool-fallback.aui.tsx` only as the last-resort renderer
  for unknown tools, and only after the approval fix in Q4.
- **Data: exists.** `tool-call` + `tool-result` paired at `threadProjection.ts:122-135`, the result's
  own node suppressed by design.

### 10. Web search

- **aui** — **nothing.** (`elements/web-search` exists in the docs index but was not in the brief's
  list and was not fetched; NOT CHECKED.)
- **kit** — `SearchActivity.tsx` (167 lines) `{kind:"code"|"web", query?, path?, entries:
  SearchActivityEntry[]{id, detail, completed?, favicon?, faviconUrl?}, status, onEntryOpen?}` over
  `AgentActivity`, with a magnifier icon and a computed verb phrase.
- **Fidelity** — kit ✓✓, and it covers Codex's *code* search too, which brigadier's Grep/Glob tools
  map onto more usefully than web search does.
- **Pick: kit.**
- **Data: missing as a kind, present as tool calls.** `ItemKind` has no search variant
  (`wire.ts:58-69`). Claude Code's `Grep`/`Glob`/`WebSearch`/`WebFetch` arrive as ordinary
  `tool-call`s, so a name→component map in the tool renderer gets this for free. No wire change needed.

### 11. Subagent rows

- **aui** — `elements-subagent-list` (121 lines), showcase. Props `{agents: SubagentItem[]{name,
  model}, completedCount: number, progress: readonly number[], showSummary, summaryAgent}` — it
  fabricates a per-agent percentage bar from a literal array. `docs/research/chatgpt-subagents-and-brigadier-design-2026-09-09.md:271`
  already ruled that brigadier must present sub-agent progress as **indeterminate** and that the
  prefix-completion count marks the wrong worker complete.
- **kit** — `SubagentActivity.tsx` (835 lines): `SubagentActivity` `{item: SubagentActivityItem
  {id, name?, activityStatus:"active"|"updated"|"interrupted"|"done", status?, statusSummary?},
  onOpen?}`; `SubagentActivityGroup` `{items, maxVisible?, statusLabel?, animateEntrance?, onOpen?}`
  rendering a chip row + "and N others"; `SubagentSummary` `{items: SubagentItem[]{name, model,
  status, additions?, deletions?, lastMessage?, timestamp?}, onOpenSubagent?}`; plus `SubagentPanel`,
  `SubagentTranscriptHeader`, `SubagentAvatar`.
- **Fidelity** — kit ✓✓: `SubagentActivityGroup` is literally "• Waiting for 2 agents / └ Robie
  [explorer]" (digest L512-523), and its status vocabulary is indeterminate by construction. aui ✗ —
  it violates a standing brigadier decision.
- **Pick: kit — `SubagentActivity` + `SubagentActivityGroup` only.**
  **Do not take `SubagentAvatar`.** MEASURED: `src/assets/subagents/README.md` says those five SVGs
  were captured from a running Codex Desktop `26.825.51511` and "The upstream artwork remains
  copyright OpenAI… not relicensed under the repository's MIT license"; the kit's own `SOURCES.md`
  says "Do not ship OpenAI or Codex logos, fonts, sounds, illustrations, or other brand assets." The
  vendoring script now **refuses** `src/assets/**` unless explicitly overridden.
  Skip `SubagentPanel` too — brigadier has `SubagentsPanel.tsx` with 5 tests.
- **Data: exists, no progress fraction.** `ItemKind::Subagent{task_id, subagent_type, description}`
  folded at `threadProjection.ts:106-115` with cycle detection at `:140-156`. `SubagentItem.status`
  maps onto brigadier's active/completed; leave `additions`/`deletions` undefined.

### 12. Approval card

- **aui** — two options, both wrong:
  `elements-approval-card` (123 lines) `{state:"request"|"running"|"done"|"denied", command, title,
  subtitle, onAllowOnce/onAlwaysAllow/onDeny}` — four states, no expired, and its `done` branch
  prints the literal string **"Finished with exit 0"** with no exit-code prop (`:110-113`).
  `tool-fallback.aui.tsx`'s `ToolFallbackApproval` (`:360-670`) is runtime-bound and capable, but
  sets `submitted` on click and drives `disabled={submitted}` on every control (8 sites).
- **kit** — `ApprovalRequest.tsx:125-605` (whole file 735 lines): `{title, description?, details?,
  reason?, identity?, identityIcon?, kind?, decision?: "pending"|"approved"|"rejected",
  decisionLabel?, loading?, disabled?, onApprove?, onReject?, approveLabel?/rejectLabel?,
  approveShortcutLabel?/rejectShortcutLabel?, showShortcutHints?, disableHotkeys?,
  scopedApproveAction?: {label, onClick, info?}, leadingAction?, presentation:"composer"|"default",
  autoFocus?}`. Plus `ApprovalCommandPreview` `{command, collapsedLines?, forceCollapsible?}` and
  `ApprovalFilePreview` `{fileName, directory?, additions?, deletions?}`.
- **Fidelity** — kit ✓✓ and, more importantly, **structurally compatible with the non-optimistic
  rule**: `decision` is a host-controlled prop, so the card shows a decision only when brigadier's
  store says Rust confirmed it. `decisionLabel` overrides the badge text, which is how the third
  state — `decision === null` → **Expired** (`Approvals.tsx:320-323`) — gets rendered even though
  `ApprovalDecision` is a closed three-member union in `types.ts`. aui's showcase card cannot express
  Expired at all and lies about the exit code.
- **Pick: kit for the chrome, brigadier's `Approvals.tsx` state machine untouched.** This is the
  hardest landmine in the tree (`CLAUDE.md` §5 / `vision.md` §9, "do not improve it") and 7 tests
  pin it (`Approvals.test.tsx`). Two things to watch: `ApprovalRequest` installs **global Enter /
  Escape hotkeys** scoped to the topmost surface and does outside-click dismiss — both must be
  audited against brigadier's composer key handling, and `disableHotkeys` exists for that.
- **Data: exists.** Pending from `store.approvals`, resolved from `composer_approval_history`, matched
  to the owning tool node by `kind.tool_call_id === node.item.id` (`ThreadView.tsx:292`).

### 13. Compaction notice

- **aui** — nothing shaped like it; `elements-error-state` is the nearest and is wrong.
- **kit** — `ThreadState.tsx`: `ThreadContextOptimization` `{mode:"automatic"|"manual"|"work",
  status:"running"|"completed", label?, icon?}` — an icon+label wrapped in `LoadingShimmer` while
  running; `ThreadContextEvent` adds a "Working" label and a rule above it.
- **Fidelity** — kit ✓✓, this is "• Context compacted · 12s" (digest L528-537), including the
  running-with-its-own-timer state.
- **Pick: kit.**
- **Data: missing from the thread.** `session-compacted` never becomes a `ChatItem` —
  `crates/store/src/chat.rs:135` projects only `ItemStarted/Updated/Completed`; the event only sets
  `SessionRuntime.lastMessage` (`feedStore.ts:437-439`). Needs either a synthetic `ChatItem` written
  by the Rust store or a seq-keyed overlay merged into `ThreadRow[]`. Same fix serves rows 14 and 15.

### 14. Error / interrupted notice

- **aui** — `elements-error-state` (76 lines) `{title, detail, retrying, onRetry}` — showcase, but
  the prop surface is trivially wireable. `thread.aui.tsx`'s `MessageError` renders
  `ErrorPrimitive.Root` for runtime-reported message errors.
- **kit** — `Notices.tsx` (437 lines): `StatusBanner` `{tone:"neutral"|"info"|"warning"|"error",
  layout:"horizontal"|"vertical"|"icon", heading?, icon?, actions: StatusBannerAction[], onDismiss?}`;
  `SystemErrorNotice` (StatusBanner fixed to icon/error/role=alert); `StreamNotice`
  `{status:"reconnecting"|"failed", reconnectAttempt?, reconnectMaxAttempts?, onRetry?, serverBusy?,
  additionalDetails?}`; `InlineNotice` `{tone, icon?, shimmering?, trailingContent?, wrap?}`.
  `ThreadState.tsx`: `ThreadInterruptionSummary` `{durationMs, stoppedLabel?}` (composes
  `TurnDuration`), `ThreadRenderError` `{title?, onRetry?}`.
- **Fidelity** — kit ✓✓ across the whole family, and `ThreadInterruptionSummary` is
  "■ Conversation interrupted" exactly. `InlineNotice`'s rule-flanked strip is the Codex row shape.
- **Pick: kit.**
- **Data: split.** Interrupted **exists** — `session.lastStop` → `stopLabel` (`ThreadView.tsx:492`),
  rendered after the last row only when the stop is not `end-turn` (`:481-483`).
  `runtime-error` / `runtime-warning` are **store-only** (`feedStore.ts:443,452`): a fatal error is
  currently invisible in the transcript. Same overlay fix as row 13.

### 15. Queued / steer strip

- **aui** — `elements-message-queue` (90 lines) `{running: string, queued: QueuedMessage[]{id,text},
  onCancel?}`. Showcase, but this is the one element whose prop surface is already the right shape:
  a live-dot header, an "N queued · sends when this finishes" strip, and a numbered cancellable list.
- **kit** — `ComposerAuxiliary.tsx:779-938` `QueuedPromptList` (MEASURED, read):
  `{items: readonly QueuedPrompt[]{id, text: ReactNode, status?, attachmentSummary?}, interrupted?,
  queueingEnabled?, onDelete?, onEdit?, onReorder?(activeId, overId), onResume?, onSendNow?,
  onQueueingChange?}` — drag-reorderable rows with Alt+Arrow keyboard reordering. Also
  `ComposerDock` `{composer, context?, queue?}` and `ComposerModeIndicator`
  `{kind:"goal"|"plan"|"review"|"custom", label, onClear}`. `AgentComposer` (662 lines) is the whole
  input; `ComposerPlanProgress` (208) is the goal-mode ring.
- **Fidelity** — kit ✓✓, and better than I expected: `QueuedPromptList` is purely presentational over
  a caller-owned array, so binding it to the durable Rust queue is the natural usage, not a
  workaround. `onSendNow`/`onEdit`/`onResume` map onto Codex's "⌥+↑ edit last queued message" and
  "esc to interrupt and send immediately" (digest L671-680). aui's `elements-message-queue` is the
  right shape but strictly less capable.
- **Pick: kit `QueuedPromptList` only, dropped into the existing composer.** Do not take
  `AgentComposer` or `ComposerDock`: `docs/plans/composer-redesign-2026-09-09.md:3` says the composer
  was approved and delivered 2026-09-09 with all six gates green, and the survey's recommendation is
  that a thread rebuild leaves it alone. The standing decision
  (`chatgpt-subagents-and-brigadier-design-2026-09-09.md`) is that the queue binds to the durable
  Rust queue, not a competing in-memory list — which `QueuedPromptList` satisfies by construction.
- **Data: exists.** `composerApi` durable queue + `useDurableComposer`; 13 queue tests.
  Codex's **steer** (`turn/steer`, Enter steers / Tab queues) has no brigadier analogue at all.

### 16. Review banners

- **aui** — nothing.
- **kit** — `AutomaticApprovalReview` (102 lines) `{status:"aborted"|"approved"|"denied"|
  "inProgress"|"timedOut", riskLevel?, rationale?, summary?, action?}`; and the `FileReview*` family.
- **Fidelity** — the kit's `AutomaticApprovalReview` is a *different* concept from Codex's
  `enteredReviewMode`/`exitedReviewMode` bracket rows (`>> Code review started <<`, digest L542-551).
  Nothing on either side draws the bracket.
- **Pick: defer.** No brigadier concept, no data, no component.
- **Data: missing entirely.**

### 17. Context meter / usage window

- **aui** — `elements-context-display` (453 lines): `ContextDisplayRoot/Ring/Bar/Text/Trigger/Content`
  with `{modelContextWindow: number, usage: TokenUsage{totalTokens, inputTokens, cachedInputTokens,
  outputTokens, reasoningTokens}, resetKey?}`, severity thresholds and a colour ramp. MEASURED: the
  **base** takes `usage` as a prop; only `context-display.aui.tsx` needs `@assistant-ui/ai-sdk`.
  Separately, `elements-quota-banner` (98 lines) `{used, limit, unit, resetsIn, upgradeLabel,
  onUpgrade}` — a "N left · resets in X" meter with **no currency anywhere**.
- **kit** — `UsageSettings.tsx` (425 lines) is a settings page (plan card, credits, `role=progressbar`
  limit groups). It prints a plan **price** and a credit balance. Not a thread element, and its
  vocabulary is the one brigadier has ruled out.
- **Fidelity** — `elements-quota-banner` is the closest existing thing to the vision's usage-window
  gauge (`vision.md:162-197`). `elements-context-display` is a per-thread context ring, which
  `composer-redesign-2026-09-09.md:11` explicitly forbids building the experience around.
- **Pick: aui `elements-quota-banner`, adapted** — delete `upgradeLabel`/`onUpgrade` (brigadier sells
  no upgrade and shows no dollars; `RunCard.test.tsx:455-480` pins that). Do **not** take
  `context-display` or the kit's `UsageSettings`.
- **Data: missing end to end.** `rate_limit_event.unifiedWindows` is decoded in Rust
  (`crates/claude-wire/src/message.rs:81`, `crates/core/src/claude/adapter.rs:614`) and drives
  `allowance.rs`, but **is not on the `Event` union** in `crates/core/src/event.rs` / `src/wire.ts`.
  This is the single largest gap between `vision.md` §6 and the tree and needs a new `Event` variant.
  `context_window` does exist on `SessionRuntime.usage` (`feedStore.ts:152`) and nothing reads it.

### 18. Jump to latest / scroll anchoring

- **aui** — `ThreadPrimitive.ScrollToBottom` inside `thread.aui.tsx:220-232`, and
  `ThreadPrimitive.Viewport turnAnchor="top"` — the real, runtime-bound path, and the one brigadier
  already uses (`src/components/assistant-ui/elements/thread.tsx:22-49`).
  `elements-scroll-anchor` (139 lines) is a showcase that runs its own `setInterval` appending
  demo messages — unusable.
- **kit** — `AgentThreadViewport` (`AgentThread.tsx:80-291`, forwardRef) `{autoFollow?,
  defaultFollowing?, followKey?, followThreshold?, latestOrigin:"end"|"start", onFollowingChange?,
  topInset?, footer?}` with programmatic-vs-user scroll detection and a `prefers-reduced-motion`
  check; `ThreadFloatingButton` `{show, working?, onClick}`; `ThreadVirtualizedPlaceholder`
  `{estimatedHeight}`.
- **Fidelity** — kit's viewport is more capable (reverse origin, follow key). But WebKit 26.5 has no
  `overflow-anchor` (`feed-rendering.md:186-192`), brigadier's scroll restore reads the literal
  `.aui-viewport` class in a test (`ThreadView.test.tsx:490-507`), and swapping scroll owners is the
  single riskiest change available for zero visual gain.
- **Pick: aui.** Optionally dress it with kit's `ThreadFloatingButton` chrome, which is a pure
  presentational button.
- **Data: exists.**

---

### Summary of picks

| # | Row | Pick | New brigadier data needed |
|---|---|---|---|
| 1 | User message | hybrid (aui wiring, kit CSS, brigadier clamp) | none |
| 2 | Assistant answer | aui shell + brigadier markdown | none |
| 3 | Commentary | hand-built `data-` part | none (inferred positionally today) |
| 4 | Reasoning | aui | none |
| 5 | Turn header "Worked for" | **kit** `TurnDuration` | none |
| 6 | Exploration group | hybrid (aui `GroupedParts` → kit `ActivityTimeline`+`AgentActivity`) | none |
| 7 | Command execution | **kit** `CommandExecution` + `CommandOutput` | **exit code** (wire change or body parse); per-call duration (derivable) |
| 8 | File change card | **kit** `FileChangeGroup` (not `FileChange`/`FileReview*` yet) | per-file `diffText`; push instead of a 3.5 s poll |
| 9 | MCP / tool call | hybrid (aui part props → kit `ToolCallCard`/`McpToolCallGroup`) | none |
| 10 | Web search | **kit** `SearchActivity` | none (map by tool name) |
| 11 | Subagent rows | **kit** `SubagentActivity`+`Group`, **no avatars** | none (progress stays indeterminate) |
| 12 | Approval card | **kit** `ApprovalRequest` + previews, brigadier state machine | none |
| 13 | Compaction notice | **kit** `ThreadContextOptimization` | synthetic item or seq-keyed overlay |
| 14 | Error / interrupted | **kit** `Notices` + `ThreadInterruptionSummary` | same overlay, for `runtime-error`/`warning` |
| 15 | Queued / steer strip | **kit** `QueuedPromptList` into the existing composer | none (steer itself has no analogue) |
| 16 | Review banners | defer | everything |
| 17 | Context meter / usage window | **aui** `elements-quota-banner`, upgrade CTA removed | **new `Event` variant** for `rate_limit_event` |
| 18 | Jump to latest | **aui** `ThreadPrimitive` | none |

Ten picks are kit, four are aui, three are hybrid, one hand-built and one deferred. Of the 18 rows,
**11 need no new brigadier data at all**; the four that do are exit codes, a timeline overlay for
compaction/error/lifecycle markers, per-file diff text, and the usage-window `Event` variant — the
same four the survey's gap list already named.

---

## 3. Vendoring script — `<scratchpad>/vendor-codex-ui-kit.mjs`

Node built-ins only; no dependencies; `--help` prints the header block.

```
node vendor-codex-ui-kit.mjs --components <a,b,c> --dest <dir> [options]
  --commit <sha>        default 9f3af2c3a6386d4ea05f8b3f2c1051ae1a50789d
  --source <path>       local clone (default ./codex-ui-kit beside the script)
  --remote              ignore the clone, fetch from raw.githubusercontent at --commit
  --var-prefix <p>      replaces --codex-ui-   (default --bg-)
  --class-prefix <p>    replaces codex-ui-     (default bg-)
  --follow-imports      transitively vendor local modules the picks import
  --dry-run
```

What it does, in order: copies the allow-listed files → collects every `codex-ui-*` token that
appears in them → slices `src/styles.css` by class prefix → copies `src/tokens.css` whole →
renames both prefixes → prepends an ATTRIBUTION block to every written file → prints byte counts.

The CSS slicer is a hand-written brace-, string- and comment-aware walker (not a regex over lines):

- splits top-level blocks, then splits each rule's selector list on **top-level** commas only, so
  the 500-selector reset block at the head of `styles.css` contributes only the selectors that
  belong to the vendored components;
- recurses into `@media`, `@container`, `@supports`, `@layer`, `@scope` and keeps the wrapper only
  if something inside survived (MEASURED: `styles.css` has 20 `@container`, 20 `@media`,
  35 `@keyframes`);
- collects `animation` / `animation-name` idents from the kept declarations and carries **only** the
  `@keyframes` those reference;
- a selector containing **no** `codex-ui-*` class at all is kept (global scaffolding); a selector
  that is `codex-ui-`-prefixed but matches nothing wanted is dropped;
- **drops `@import` and says so in a comment** — `styles.css:2` is
  `@import "katex/dist/katex.min.css"`, a `node_modules` path that would silently drag KaTeX into
  the bundle. Carrying it forward would be a landmine, so it is refused rather than rewritten.
- prefix rename order is `--codex-ui-` first, then bare `codex-ui-`, so a custom property does not
  get rewritten by the class rule.

ATTRIBUTION block written at the top of every output file (TSX and CSS): source repo URL, source
file path, source commit, the prefix rename that was applied, the verbatim
"not affiliated with, sponsored by, or endorsed by OpenAI" notice from the kit's `README.md:10`, and
the full MIT licence text with `Copyright (c) 2026 JaminZhou` (MEASURED, read `LICENSE` and
`README.md`). A `LICENSE` file is written into the destination too. SVG assets get no comment header
(a `/* */` block would break the file), which is a known gap — see Q9.

### Measured run

Ran against the recommended kit picks into `<scratchpad>/vendored-preview/`:

```
vendor-codex-ui-kit — local source, commit 9f3af2c3a6386d4ea05f8b3f2c1051ae1a50789d
components requested          14
files copied                  21
    src/components/AgentMessage.tsx
    src/components/TurnDuration.tsx
    src/components/ActivityTimeline.tsx
    src/components/AgentActivity.tsx
    src/components/StatusIndicator.tsx
    src/components/CommandExecution.tsx
    src/components/McpToolCallGroup.tsx
    src/components/ToolCallCard.tsx
    src/components/SearchActivity.tsx
    src/components/SubagentActivity.tsx
    src/components/ApprovalRequest.tsx
    src/components/Notices.tsx
    src/components/ThreadState.tsx
    src/components/FileChange.tsx
    src/types.ts
    src/components/InteractivePrimitives.tsx
    src/internal/surfaceBlocked.ts
    src/components/Dialog.tsx
    src/internal/overlayEnvironment.ts
    src/internal/surfacePortalOwner.ts
    src/internal/documentScrollLock.ts
codex-ui-* tokens used        311
css rules kept                741
css rules dropped             2315
at-rule blocks kept           10
@keyframes carried            23
source styles.css bytes       566682
EXTRACTED CSS BYTES           127480
tokens.css bytes              23344
extracted + tokens bytes      150824
share of source styles.css    22.50%

!! REFUSED — OpenAI-copyright assets, NOT MIT (src/assets/subagents/README.md).
   The importing component will not compile until you supply your own artwork.
    src/assets/subagents/lattice.svg
    src/assets/subagents/orbit.svg
    src/assets/subagents/pinwheel.svg
    src/assets/subagents/sprout.svg
    src/assets/subagents/sunbeam.svg
   Pass --include-openai-assets only if you have decided to ship them anyway.

written to <scratchpad>/vendored-preview
```

**The headline number for the paint-budget gate: 127,480 bytes of extracted CSS**, plus 24,931 bytes
of tokens (the tokens file grows by 1,587 bytes over the source's 23,344 because the prefix rename is
applied and the ATTRIBUTION block is prepended). Total **151,411 bytes** of stylesheet on disk,
unminified and uncompressed, before Tailwind runs. That is 22.5% of the kit's 566,682-byte
`styles.css`, from 741 kept rules out of 3,056, 10 surviving at-rule blocks and 23 carried
`@keyframes`.

Two comparison runs, same script, `--dry-run` (MEASURED):

| set | files | CSS bytes | + tokens |
|---|---|---|---|
| recommended set, `--follow-imports` | 26 | 127,480 | 150,824 |
| same **without `FileChange.tsx`** | 23 | 90,376 | 113,720 |
| `CommandExecution` alone, no follow | 1 | 6,912 | 30,256 |

`FileChange.tsx` alone accounts for **+37,104 bytes** and three extra files (`Dialog.tsx`,
`InteractivePrimitives.tsx`, and their internals) — see open question Q7.

**The script refused the five subagent avatar SVGs**, and this is the most important thing it found.
MEASURED, quoting `src/assets/subagents/README.md` verbatim: those SVGs "were captured from the
rendered Codex Desktop `26.825.51511` (`7377`) interface on 2026-09-01… The upstream artwork remains
copyright OpenAI. No ownership is claimed, and these observed assets are not relicensed under the
repository's MIT license." The kit's own `SOURCES.md` adds "Do not ship OpenAI or Codex logos, fonts,
sounds, illustrations, or other brand assets." So `src/assets/**` is now refused by default with a
loud warning, and `SubagentAvatar` will not compile until brigadier supplies its own artwork —
which is the correct failure. `--include-openai-assets` exists as a deliberate override only.

---

## 4. Open questions — ten, each with a recommendation

**Q1 — Is the CSS budget acceptable, and does the burn gate run before or after the build?**
MEASURED: the recommended kit set extracts **127,480 bytes** of CSS plus **24,931 bytes** of tokens
(151 KB unminified, uncompressed, before Tailwind ever runs). Dropping `FileChange.tsx` cuts it to
**90,376 + 24,931** (115 KB). The current paint budget is exec → FCP **287–295 ms p50** at `c4d9d29`
against a ≤200 ms target it already misses by ~90 ms, and `docs/research/native-performance-timing-2026-09-09.md`
re-measured 326.6 ms p50 on 2026-09-10. Adding 150 KB of stylesheet to a path that is already over
budget is a real risk and no one has measured what it costs.
**Recommendation:** make a burn run a **precondition of the work order**, not a gate at the end —
vendor the CSS into a branch, run `VITE_BURN=1` against an otherwise unchanged tree, and get a
delta number before any component is wired. If the delta is material, ship kit CSS per-row behind
lazy `@import`s rather than one sheet.

**Q2 — Tailwind utilities or kit tokens? The two design systems do not mix.**
MEASURED: aui's runtime-bound components style with Tailwind utilities against shadcn CSS variables
(`bg-muted`, `text-foreground/55`, `rounded-xl`); the kit styles with `codex-ui-*` BEM classes
against `--codex-ui-*` custom properties in a 27 KB token file. Adopting both means two token
vocabularies for the same colours, and `docs/STATUS.md:707-713` records that contrast is a property
of a *pair* — 48 pairs were swept and six new failures found. Two palettes doubles that surface.
**Recommendation:** map the kit's tokens onto brigadier's existing shadcn/Base UI variables at
vendor time (a second rename pass in the script: `--bg-surface-*` → `var(--color-card)` etc.) rather
than shipping a parallel palette. Re-run the contrast sweep afterwards. If the mapping turns out to
be lossy, the alternative — Tailwind-ifying the kit's CSS by hand — is a much larger job and should
be a separate decision.

**Q3 — Does the thread move to real `MessagePrimitive` parts, or stay hand-rolled beside the runtime?**
Today `TranscriptRuntime` gets `content: []` for every `work` row (`ThreadView.tsx:314-326`) and the
rows are hand-written JSX; the header comment says the runtime "owns only viewport behavior". Moving
to `data-*` parts unlocks `GroupedParts`, the `ToolGroup`/`ReasoningGroup` override slots, tool
approval plumbing and `[content-visibility:auto]` — but it is a substantially larger change than
restyling, and it touches `threadProjection.ts` (16 tests) and `ThreadView.test.tsx` (18 tests).
**Recommendation:** yes, move — but as **phase 2**. Phase 1 is a pure restyle of the existing row
switch with kit components, which lands the Codex look without touching the projection. Phase 2 is
the parts migration. Splitting it keeps each phase inside one fresh context and keeps the diff
reviewable.

**Q4 — Does `disabled` on click count as optimistic?**
MEASURED: `tool-fallback.aui.tsx` disables every approval control the moment the user clicks
(`submitted` state, 8 `disabled=` sites), reverting only on a thrown send. The *card* still unmounts
only on runtime confirmation, so this is weaker than the thing `vision.md` §9 forbids ("the card
clears only on `request-resolved`"), but it is still a UI state change ahead of Rust's confirmation.
The kit's `ApprovalRequest` avoids the question entirely: `decision` and `loading` are host props.
**Recommendation:** treat it as a violation and use the kit's card, driven by brigadier's store, with
a `loading` state that means "sent, awaiting `request-resolved`" and no local `submitted`. That
keeps the safety boundary in one place — `Approvals.tsx` — which is where `CLAUDE.md` §5 puts it.

**Q5 — Icons: rewrite lucide imports, or keep lucide as a dev-only shim?**
MEASURED: 21 of 28 registry components import `lucide-react`, which `ui/design-system` deliberately
removed in favour of 52 icons vendored from `@openai/apps-sdk-ui` into `src/icons/`. I counted ~27
distinct lucide names across the set and did **not** verify `src/icons/` covers them.
**Recommendation:** extend `scripts/vendor-icons.mjs` with a lucide-name → vendored-name map and
apply it as a post-processing pass whenever an assistant-ui component is installed, the same way
the codex-ui-kit script applies its prefix rename. Re-adding `lucide-react` "temporarily" is how it
becomes permanent. Also note `WorkTrace.test.tsx:175-182` asserts on the literal class `.lucide-check`
and will break either way.

**Q6 — Which branch does this land on, and how is the conflict with the in-flight `ui/design-system`
work handled?**
MEASURED: `ui/design-system` has ~30 modified and several untracked files right now, including every
file under `src/components/assistant-ui/elements/`, `components.json`, `package.json` and
`src/index.css` — which is almost exactly the thread rebuild's blast radius. `main`'s CLAUDE.md and
`ui/design-system`'s CLAUDE.md still disagree about whether the bb port is alive.
**Recommendation:** the rebuild sits **on top of** `ui/design-system`, in its own worktree branched
from it, and does not start until that branch's uncommitted work is committed. Forking from `main`
means redoing the icon swap file by file.

**Q7 — `FileChange.tsx` is 1639 lines for two wanted exports. Trim it, or wait?**
MEASURED: `FileChangeGroup` (113 lines) and `FileChange` (140 lines) are the wanted parts;
`FileReviewWorkspace` alone is 491 lines and drags `Dialog.tsx` (355) + `InteractivePrimitives.tsx`
(1312) through `--follow-imports`, and the file costs +37 KB of CSS. And brigadier has no per-file
`diffText` to put in `FileChange`'s expanded body anyway.
**Recommendation:** vendor `FileChangeGroup` only, by hand-extracting it plus `FileChangeStats` and
`StatusIndicator` into one small file after the script runs, and skip `FileChange`/`FileDiff`/
`FileReview*` until a diff IPC exists. That drops the CSS delta by roughly a third and removes the
`Dialog`/`InteractivePrimitives` dependency entirely.

**Q8 — Does the exit code become a wire field, or a body parse?**
`ItemKind::ToolResult` carries only `is_error: bool`. `CommandExecution` and the Codex row both want
an integer. A wire field means `crates/core/src/event.rs` + `src/wire.ts` + `docs/plans/ipc-contract.md`
in lockstep; a body parse means a regex over provider-specific output that will silently drift.
**Recommendation:** wire field, and do it **before** the UI work, as its own small Rust work order —
otherwise the UI ships with a permanently `undefined` prop and the row never reaches Codex fidelity.
Until it lands, `exitCode` must be left undefined, never inferred from `is_error`.

**Q9 — Do compaction, runtime errors and lifecycle markers become synthetic `ChatItem`s in Rust, or a
seq-keyed overlay in TypeScript?**
Three of the recommended rows (13, 14, and part of 17) need timeline entries for events that never
become `ChatItem`s today (`crates/store/src/chat.rs:135`). A Rust-side synthetic item makes them
first-class, persistent and pageable; a TS overlay merged by `Envelope.seq` is cheaper but does not
survive a reload and re-introduces a second ordering authority.
**Recommendation:** Rust-side synthetic items. The overlay is the kind of shortcut that becomes the
`Feed.tsx` situation — a parallel path nobody maintains. This is also its own work order, ahead of
the UI.

**Q10 — What is the acceptance bar, given nobody can see the Codex desktop thread?**
`codex-thread-anatomy.md` is explicit (§Not documented anywhere, L840-852) that the desktop app's
visual design exists "only as pixels in the closed app", and recommends screen-recording a throwaway
repo at 60 fps to measure spacing and timings. Without that, "looks like Codex" is unfalsifiable and
the build will churn on taste.
**Recommendation:** either do the recording the digest asks for and pin a small set of reference
frames as the bar, **or** drop the "looks like Codex" framing and state the bar as: the 18 row kinds
in §2, each rendering the data brigadier actually has, in the kit's token vocabulary, with the six
gates green and the burn delta from Q1 inside budget. The second is achievable this week; the first
is a prerequisite for the first.

---

## 5. What I did not check

- **Nothing was rendered.** No component from either side was mounted, styled or screenshotted. All
  fidelity judgements in §2 are read off source and the ASCII mocks in the anatomy digest, and the
  digest itself says the desktop app's actual visual design is undocumented (§Not documented
  anywhere) — so "looks like Codex" is ~60% answerable at best.
- **No paint/frame measurement.** The 40 KB / 120 KB CSS figures are byte counts of extracted text,
  not parse time, not paint time, not a burn run. `[content-visibility:auto]` in `thread.aui.tsx` was
  not tested in WebKit 26.5.
- **`src/icons/` coverage.** I did not open the 52 vendored icons to confirm they cover the ~27
  lucide names the assistant-ui set uses, nor the kit's own icon usage.
- **No npm install, no build, no test run** anywhere — the brief forbids it and I did not.
- **The kit's runtime behaviour.** Nobody has run codex-ui-kit; I read its source only. Its
  `package.json` declares `highlight.js`, `katex`, `react-markdown`, `rehype-katex`, `remark-gfm`,
  `remark-math` — the CSS slicer refuses the KaTeX `@import`, but I did not trace which components
  need `highlight.js` at runtime.
- **The `ui/design-system` worktree's uncommitted work.** `git status` there shows ~30 modified and
  several untracked files mid-flight, including `src/components/assistant-ui/elements/*` and
  `package.json`. I read the files as they stand; they will move.
- **Radix/Base diff for `elements-approval-card`.** I measured that the payloads differ between
  flavours but did not diff the two sources to see what changed.
- I did not verify `docs/` line numbers quoted from `thread-render-path-2026-09-10.md`; those are that
  document's citations, carried forward, not re-checked against the tree.

## See also

- `codex-thread-anatomy.md` — the Codex row taxonomy this file maps components against, and the badges
  (PROTOCOL/TUI/DOCS/REPORTED) behind each fidelity judgement here.
- `codex-thread-tokens.md` — the pixel values a restyle pass would use once a component is picked.
- `codex-ui-kit.md` — the full licence, inventory and route-A/route-B comparison this file's per-row picks
  are drawn from.
- `thread-render-path-2026-09-10.md` — brigadier's current thread code, its data model, and its gap list
  (§9 there), which this file's "New brigadier data needed" column in the picks summary answers directly.
- `cli-steer-and-exit-codes.md` — measured Claude Code CLI behaviour behind row 15's note that "Codex's
  steer has no brigadier analogue at all" and row 7's exit-code gap.
