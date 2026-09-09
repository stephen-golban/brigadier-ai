# get-bb/bb — UI stack and thread widgets

Detailed subagent report, 2026-09-09, feeding `docs/research/bb.md`. Claims are marked as in that file: read in source = measured; everything else asserted. Nobody ran bb.

---
# bb (get-bb/bb) — frontend dissection

All versions **read in source** from `package.json` at `main` (root SHA `4749527`). Repo is
pnpm + turbo, `packageManager: pnpm@9.15.0`, node >=22.19.

## 1. App stack — `apps/app/package.json` (`@bb/app`)

- **Framework**: React `^19.0.0` + react-dom 19, Vite `^8.0.12`, `babel-plugin-react-compiler ^1.0.0`
  (React Compiler on), TypeScript via `npm:@typescript/typescript6@^6.0.2`.
- **Router**: `react-router-dom ^7.1.0`. **No** Next.js.
- **State**: `jotai ^2.19.0` + `jotai-family ^1.0.1`, `@tanstack/react-query ^5.62.0`. No zustand/redux.
- **Transport**: `partysocket ^1.1.16` (WebSocket), `zod ^4.3.6` (pinned `4.3.6` by root override).
- **Styling**: Tailwind **v4** (`tailwindcss ^4.3.0`, `@tailwindcss/vite ^4.3.0`), `tw-animate-css`,
  `class-variance-authority`, `clsx`, `tailwind-merge`, `lightningcss`. No CSS modules/vanilla-extract.
- **Components**: shadcn-style local kit in `packages/shared-ui/src/components/ui/*` over **Radix**
  (~30 `@radix-ui/react-*` packages, each re-exported as a subpath in `packages/shared-ui/package.json`).
  Not Base UI / Ark / an npm shadcn package.
- **Icons**: `lucide-react ^1.23.0` **and** `@hugeicons/react ^1.1.6` + `@hugeicons/core-free-icons ^4.1.3`
  (shared-ui `icon.tsx` / `icon-registry.ts`).
- **Markdown**: `react-markdown ^10.1.0` + `remark-gfm`, `remark-breaks`, `remark-math`,
  `remark-directive`, `rehype-raw`, `rehype-sanitize`, `rehype-katex`, `katex`, `unist-util-visit`,
  `mermaid ^11.15.0`, `remend 1.3.1` (streaming-markdown repair).
- **Highlighting**: `sugar-high ^2.0.1` (`apps/app/src/components/ui/markdown-code-highlight.ts`).
  **No shiki, no prism, no highlight.js.**
- **Diff**: `@pierre/diffs ^1.2.9` (+ patch in root `patchedDependencies`), `@pierre/trees ^1.0.0-beta.3`.
- **Terminal**: `@xterm/xterm 6.1.0-beta.292` + addons fit / webgl / web-links / unicode11; `ansi-to-html`.
- **Editor**: composer is **TipTap 3** (`@tiptap/react|core|pm|starter-kit|suggestion|extension-mention|
  extension-placeholder ^3.26.0`). Monaco exists only as an optional plugin: `plugins/monaco-editor`
  → `monaco-editor ^0.56.0`. No CodeMirror.
- **Virtualisation**: `@tanstack/react-virtual ^3.14.2`.
- **Forms**: `react-hook-form ^7.80.0` + `@hookform/resolvers ^5.4.0` + zod. **Dates**: `date-fns ^4.4.0`,
  `react-day-picker ^10.0.1`. **Toasts**: `sonner ^1.7.4` (patched). **Command palette**: `cmdk ^1.1.1`.
  **DnD**: `@dnd-kit/core ^6.3.1` + sortable/utilities. **Panels**: `react-resizable-panels ^2.1.7`.
  **Charts**: `recharts ^2.15.4`. Also `vaul`, `embla-carousel-react`, `input-otp`, `usehooks-ts`,
  `nanoid`, `@fontsource-variable/inter`. Storybook is **Ladle** (`@ladle/react ^5.0.3`).
- **Animation**: no framer-motion/`motion` dependency — CSS only (`tw-animate-css`,
  `shared-ui/src/components/ui/motion.ts`).

## 2. Thread UI: hand-rolled (read in source)

No `assistant-ui`, no `ai-elements`, no Vercel `ai` SDK, no `streamdown`, no chat kit anywhere —
GitHub code search over `get-bb/bb` for `assistant-ui` and `ai-elements` returned **zero hits**, and
`apps/app/package.json` lists none. The timeline is built from Radix + Tailwind primitives on top of
a first-party projection library `packages/thread-view` (pure TS, deps: `@bb/domain`,
`@bb/server-contract`, `zod` only — no React), plus `@bb/client-core` and `@bb/core-ui`.

## 3. Thread widgets (`apps/app/src/components/thread/`)

Top ones:

- `timeline/ThreadTimelineRows.tsx` (2,291 lines) — the renderer: `switch (row.kind)` →
  bundle/step summary, turn, work, system, conversation; memoised rows, Radix `useComposedRefs`.
- `timeline/TimelineRowDetails.tsx` — `WorkRowBody`, `switch (row.workKind)` (see §4).
- `timeline/TimelineWindowedItems.tsx` — `useVirtualizer` from `@tanstack/react-virtual`,
  overscan 8, windowing only above 20 items, LRU height cache (2,000 entries).
- `timeline/ConversationMessageContent.tsx` (730 lines) — user/assistant bubbles via
  `MarkdownPreview` (`components/ui/markdown-preview.tsx` = ReactMarkdown + remark/rehype), streaming
  split (`streaming-markdown-split.ts`), `remend`, mentions, attachments, `MessageActionBar`.
- `timeline/TimelineFileDiffBlock.tsx` — `parsePatchFiles` from `@pierre/diffs` → `GitDiffCard`
  (`components/git-diff/GitDiffCard.tsx`); lazy via `LazyTimelineFileDiffBlock.tsx`.
- `timeline/ThreadContextWindowIndicator.tsx` — hand-drawn SVG donut (`2*PI*r` dashoffset,
  destructive tint ≥90%) inside a Radix `Popover` with a hover hook.
- `pending-interactions/ThreadPendingInteractionBanner.tsx` — approval/permission prompt; shadcn
  `Button`/`Icon`, `MarkdownPreview`, `UserQuestionAnswerForm`, plugin composer slot.
- `terminal/ThreadTerminalView.tsx` — xterm 6 beta + fit addon + Radix context menu, themed.
- `timeline/TimelineReasoningDetail.tsx` / `TimelineReasoningExpansion.tsx` — thinking blocks.
- `../promptbox/PromptBoxInternal.tsx` — TipTap `useEditor`, mention pills
  (`editor/prompt-mention-extension.ts`, `mentions/MentionMenu.tsx`), attachments, voice
  (`VoiceRecordingBar`/`WaveformVisualizer`), banner stack: `ThreadTodoCard`, `ThreadGoalCard`,
  `ThreadWorkflowCard`, `QueuedMessagesList`, `ThreadModelFallbackCard`.
- Also: `toc/ThreadTableOfContents.tsx`, `timeline/TimelineSelectionMenu.tsx`,
  `timeline/TerminalOutputBlock.tsx`, `timeline/PluginTimelineRendererBody.tsx` (plugins can replace
  a row body), `WorkspaceChangesList.tsx`.

## 4. Timeline data flow (read in source)

Types live in `packages/server-contract/src/thread-timeline.ts` (zod + inferred TS):

`TimelineRow = TimelineSourceRow | TimelineTurnRow`;
`TimelineSourceRow = TimelineConversationRow | TimelineWorkRow | TimelineSystemRow`.
`TimelineWorkRow` union: `command | tool | file-change | web-search | web-fetch | image-generation |
image-view | file-read | search | plan-steps | extension | approval | question | delegation | workflow`.
System ops: `generic | reasoning | compaction | context-clear | parent-change | thread-provisioning |
thread-interrupted | provider-unhandled | warning | deprecation`.
`packages/thread-view/src/timeline-view.ts` adds view rows `step-summary` / `bundle-summary` and
`ThreadTimelineViewRow`. Dispatch is a **switch, not a registry**, twice: `row.kind` in
`ThreadTimelineRows.tsx:1153`, then `row.workKind` in `TimelineRowDetails.tsx:234`, both ending in
`assertNever(row)`. `delegation` renders nested child rows recursively; `approval`, `web-search`,
`web-fetch`, `file-read`, `search`, `image-generation` return `null` (header-only rows).

## 5. Desktop shell (`apps/desktop`, v0.42.1, mac + linux only)

`electron 41.7.0`, `electron-builder ^26.15.7` (+ `electron-builder-squirrel-windows`),
`electron-updater ^6.8.3` (`src/desktop-auto-update.ts`, `desktop-update-*.ts`). Native menus in
`src/menu.ts` (New Tab / Reopen Closed Tab / New Thread / Settings…, a Server menu listing bb Connect
servers). Also `desktop-context-menu.ts`, `window-state.ts`, embedded BrowserView browser + CDP
adapter (`desktop-browser-*.ts`), `safeStorage` credentials, log viewer window.

## Not found / not checked

- **No tray** and **no `setAsDefaultProtocolClient` / `open-url` deep links** in `apps/desktop`
  (code search returned zero) — asserted from search, not from reading every file.
- Notifications: none in `apps/desktop`; web `Notification` in `apps/app/src/lib/notifications/
  notification-store.ts` and a `plugins/push-notifications` package — not read.
- Usage/rate-limit card: only `settings/UsageLimitsSettingsSection.tsx` and a `plugins/provider-usage`
  package found; no in-thread usage card located.
- No compaction-boundary *component* found; compaction is a `system` row `operationKind: "compaction"`
  rendered by the generic system detail block.
- Slash commands: routed through `components/commands/AppCommandProvider` from the composer; not read.
