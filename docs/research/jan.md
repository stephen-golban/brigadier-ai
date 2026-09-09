# janhq/jan as a UI reference: what "just copy-paste from it" would actually mean

Date: 2026-09-02. Question: the owner wants `https://github.com/janhq/jan` as the visual and
architectural reference for brigadier's UI. What does that cost, and what transfers?

**Pinned commit.** Everything below was read in a shallow-then-unshallowed clone of
`https://github.com/janhq/jan` at **`9e12b2a80edb98a2776637f4ab2c5bee953c5cb3`**
(2026-08-29, "Merge pull request #8799 from janhq/thinhlpg/feat-8730-context-command").
Jan's own version markers at that SHA: `src-tauri/Cargo.toml:3` = `0.8.4`,
`web-app/package.json:4` = `0.7.6`. All `file:line` citations are relative to the repo root of
that clone.

Tags: **[measured]** — the file was opened and the cited line read at that SHA. **[asserted]** —
reasoned from what was read, not itself verified. Nothing here was benchmarked: Jan was never
built or run (see §8).

---

## Bottom line up front

Three findings, in the order they should change a decision.

1. **The licence does not block anything.** Jan is **Apache-2.0**, permissive, not copyleft. A
   closed-source desktop app may copy its source, keeping the notices. §1 has the one wrinkle.
2. **Its long-thread rendering is the opposite of ours and must not be copied.** Jan renders every
   message in a thread with a plain `.map`, with no virtualiser
   (`web-app/src/routes/threads/$threadId.tsx:1733`) **[measured]**. Every message in a 4,000-turn
   thread is a mounted DOM subtree — each one a full markdown renderer with Shiki, KaTeX and
   Mermaid attached. brigadier's feed is virtualised to ~40 nodes regardless of length
   (`docs/research/feed-rendering.md` §4; `src/components/Feed.tsx:55`). **This is the part of
   Jan's architecture that would not transfer, and it is precisely the part the "longest sessions
   on the market" claim rests on.**
3. **Its multi-session state, by contrast, is good and does transfer.** Jan keeps every live
   session's engine in a store keyed by session id, not in the mounted route
   (`web-app/src/stores/chat-session-store.ts:25-26`) **[measured]**, so sessions keep streaming
   while another is on screen. That is the right shape for "many projects supervised at once" — with
   the caveat in §5 that only one thread is ever *rendered* at a time.

Net: **take the shell, the components and the state shape; do not take the thread renderer.**

---

## 1. Licence

**Apache License 2.0.** Permissive. Not copyleft. `LICENSE:7` **[measured]**:

```
Licensed under the Apache License, Version 2.0 (the "License");
```

The file is an 18-line pointer notice (`Copyright 2025 Menlo Research`, `LICENSE:3`) rather than
the full Apache text, plus one line that is not part of the Apache licence at all
(`LICENSE:19`) **[measured]**:

```
Attribution is requested in user-facing documentation and materials, where appropriate.
```

"Requested", not "required" — it reads as a courtesy ask, not an added term. `README.md:174` and
`CONTRIBUTING.md:254` both restate "Apache 2.0" **[measured]**.

### What that means for a closed-source app

Reporting what the licence text permits; **not legal advice, and the owner should decide.**

- **(a) Copying source — permitted.** Apache-2.0 §2 grants a perpetual, irrevocable copyright
  licence to reproduce, prepare derivative works of, and distribute the work in source or object
  form. There is no reciprocal obligation: derivative works may be closed-source and distributed
  under different terms. The conditions in §4 are the ones that attach: keep the licence text with
  any copy, keep existing copyright/patent/attribution notices, and mark files you changed. In
  practice that is a `THIRD_PARTY_NOTICES` / about-box entry naming Jan and Menlo Research, and a
  copy of Apache-2.0 shipped with the app. §3 also grants a patent licence that terminates if you
  sue over patents in the work.
- **(b) Taking visual design and layout — not governed by this licence at all.** Copyright in
  software covers the code; layout ideas, proportions, spacing and interaction patterns are not
  what a software licence licenses. Reimplementing "sidebar with collapsible project groups, a
  centred thread column, a rounded composer docked at the bottom" from scratch needs no permission
  from Jan and carries no notice obligation. The separate risks there are trade dress and
  trademark — Jan's name, wordmark, logo and its green `--sidebar: #194D24`
  (`web-app/src/index.css:123`) **[measured]** are brand, and Apache-2.0 §6 explicitly does *not*
  grant trademark rights. Do not ship Jan's marks.
- **(c) Depending on it as a package — not available.** `web-app/package.json:3` is
  `"private": true` **[measured]**; the frontend is not published to npm. There is nothing to
  depend on. Vendoring the files is the only route, which is case (a).

### The wrinkle the owner should see

The repo's licence metadata is internally inconsistent, and the inconsistency points at packages
next to the one we want.

| Path | Declared licence | Line |
|---|---|---|
| `LICENSE` (repo root) | Apache-2.0 | `LICENSE:7` |
| `web-app/package.json` (**the frontend we'd copy**) | *no `license` field* | — |
| `core/package.json` | **AGPL-3.0** | `core/package.json:10` |
| `extensions/{download,assistant,rag,vector-db,mlx,llamacpp}-extension` | **AGPL-3.0** | each `package.json` |
| `extensions/conversational-extension` | MIT | `package.json` |
| `src-tauri/Cargo.toml` | MIT | `src-tauri/Cargo.toml:6` |

All **[measured]**.

History explains it. `git log -- LICENSE` **[measured]**:

```
e8ca7f3c 2025-05-20 chore: Jan's code is now under the Apache license (#5042)
ec612fc5 2023-10-25 Change license to AGPL
```

`git show --stat e8ca7f3c` shows that commit changed **one file, `LICENSE`** (198 insertions, 657
deletions) **[measured]**, and `git show e8ca7f3c:core/package.json` still reads
`"license": "AGPL-3.0"` at line 10 **[measured]**. So the AGPL strings are leftovers the
AGPL→Apache relicense did not sweep up — **[asserted]**, since no maintainer statement to that
effect was found in the repo.

Practical consequence, and it is small: **the frontend is clean.** `web-app/` declares no licence
of its own, so the root Apache-2.0 governs it, and `web-app/src/**` is where every component
worth taking lives. Only `core/` (5,355 LOC, the extension/model plumbing) and the model-runner
extensions carry the stale AGPL string, and brigadier has no reason to copy any of them. **If a
copy is limited to `web-app/src/**`, the AGPL fields never come into it.** If the owner wants
belt-and-braces, the ask is one GitHub issue: "are the AGPL-3.0 `license` fields in `core/` and
`extensions/` stale after #5042?"

**No CLA, no dual-licensing note.** Grepping `CONTRIBUTING.md`, `README.md` and `.github/` for
`contributor license agreement`, `CLA`, `dual.licens` and `commercial licens` returns nothing
**[measured]**. There is no CLA bot config and no "commercial licence available" pitch, which is
consistent with a project that has genuinely settled on permissive terms.

---

## 2. Stack

Jan is **the same substrate as brigadier** — Tauri v2 + React 19 + Vite + TypeScript. That is the
happy surprise here and the reason the question is worth asking at all. All **[measured]** from
`package.json`, `web-app/package.json`, `src-tauri/Cargo.toml` and `web-app/vite.config.ts`.

| Concern | Jan | brigadier | Match? |
|---|---|---|---|
| Shell | **Tauri v2** (`@tauri-apps/api` 2.8.0, `@tauri-apps/cli` ^2.7.0) | Tauri v2 (`@tauri-apps/api` ^2) | **yes** |
| Frontend | **React 19.0.0** | React ^19.1.0 | **yes** |
| Build | **Vite 6.3.2**, `@vitejs/plugin-react` | Vite | **yes** |
| Language | **TypeScript 5.9.2** | TypeScript | **yes** |
| List virtualiser | **`@tanstack/react-virtual` 3.13.12** | `@tanstack/react-virtual` 3.14.10 | **same lib** — but see §3, Jan does not use it for the thread |
| State | **zustand 5.0.3** (+ `zustand/middleware` persist, `useShallow`) | plain module store + rAF drain (`src/feedStore.ts`) | different, compatible |
| Styling | **Tailwind CSS 4.1.17** + `@tailwindcss/vite`, oklch tokens, shadcn/ui + Radix | hand-written CSS custom properties, `src/index.css` (1,059 lines) | **no** |
| Router | **`@tanstack/react-router` ^1.121.34**, file-based, codegen'd `routeTree.gen.ts` | none | **no** |
| Icons | `@tabler/icons-react`, `lucide-react` | single Unicode characters (no icon library) | **no** |
| Markdown | `streamdown` (Jan's own fork), `react-markdown`, `shiki`, `katex`, mermaid | none — feed rows are plain text | **no** |
| Motion / misc | `framer-motion`, `sonner`, `vaul`, `next-themes`, `dnd-kit`, `react-resizable-panels` | none | **no** |
| Mobile | Tauri iOS + Android targets (`yarn dev:ios`, `dev:android`) | desktop only | n/a |

Rust side: `src-tauri` is a much larger machine than ours — llama.cpp and MLX runners, an agent
tool plugin, a websearch plugin, a CLI binary, an app-server. Nothing there is a UI reference.

### Scope — what "copy-paste" is being measured against

**[measured]**, `git ls-files` and `wc -l` at the pinned SHA:

| | Jan | brigadier |
|---|---|---|
| Tracked files, whole repo | **2,466** | — |
| Tracked files, frontend | **1,099** (`web-app/`) | **16** (`src/`) |
| Frontend `.ts`/`.tsx` LOC | **134,211** (`web-app/src/`) | **3,644** (`src/`, excl. `index.css`) |
| `.tsx` component files | **308** | 7 |
| Frontend runtime dependencies | **~100** | **5** |
| Other | `core/` 5,355 LOC TS; `src-tauri/` 89,054 LOC Rust | `src/index.css` 1,059 LOC |

**Jan's frontend is roughly 37× brigadier's, on ~20× the dependency count.** "Just copy-paste
from it" cannot mean the app; it can only mean specific files. The honest framing is: Jan is a
parts bin we share a socket with, not a starting point we fork. Adopting even the shell means
adding Tailwind 4, Radix, shadcn's sidebar and an icon set — a real decision about brigadier's
current zero-UI-dependency position, not a copy-paste.

---

## 3. Long-thread rendering — the finding that matters most

**Jan does not virtualise its conversation.** `web-app/src/routes/threads/$threadId.tsx:1733`
**[measured]**:

```tsx
{chatMessages.map((message, index) => {
```

That `.map` is the whole thread renderer. Every message in the array becomes a mounted
`<MessageItem>` (`:1746`). The agentic "Cowork" surface does the identical thing —
`web-app/src/routes/cowork.tsx:613`, `{uiMessages.map((message, i) => (` **[measured]**.

Jan *has* `@tanstack/react-virtual` as a dependency, and uses it in exactly one place: the model
hub's list of downloadable models, `web-app/src/routes/hub/index.tsx:283` **[measured]**. It is
the only `useVirtualizer` call in `web-app/src` — grepping the whole frontend for
`useVirtualizer|useWindowVirtualizer|react-virtual` returns two hits, both in that file
**[measured]**. **They reached for the virtualiser for a model list and did not reach for it for
the conversation.**

What holds the thread together instead is `use-stick-to-bottom`, wrapped as
`web-app/src/components/ai-elements/conversation.tsx:11` **[measured]**. That library is scroll
*anchoring* — it keeps the viewport pinned to the bottom as content grows. It renders nothing and
windows nothing.

### Does it re-render the whole thread per streaming token?

No — and the mitigations are worth stealing even though the architecture is not.

- `MessageItem` is `memo`'d with a **hand-written comparator**,
  `web-app/src/containers/MessageItem.tsx:80` (the `memo(`) and `:779` (the comparator)
  **[measured]**. The comparator bails to `false` — always re-render — for the last message while
  status is `streaming` or `submitted` (`:780-785`), and otherwise compares `message` by reference
  plus five scalar flags (`:786-795`). So during a stream, **one** message re-renders; the older N-1
  return `true` and are skipped, *provided the AI SDK preserves object identity for settled
  messages* — **[asserted]**, not verified, since it depends on `@ai-sdk/react` internals I did not
  read.
- The route component itself still re-renders on every committed update, so the `.map` re-runs and
  allocates N elements and performs N comparator calls per update. At 20 Hz (§4) and N = 4,000
  that is 80,000 comparator calls per second — cheap per call, but strictly O(N) in thread length,
  on the main thread, forever.

### The part that does not survive a long session

The re-render story is fine. **The mount story is not.** All N messages are simultaneously in the
DOM, and a Jan message is not a cheap node: `web-app/src/containers/RenderMarkdown.tsx` (380
lines) mounts `Streamdown` with `remark-gfm`, `remark-math`, `rehype-katex`, a Shiki code block, a
Mermaid renderer and a citation-link resolver, per message **[measured]**, imports at
`RenderMarkdown.tsx:2-28`. Multiply by thousands of turns and the cost is memory and layout, which
no memo comparator touches.

Against our own numbers: `docs/research/feed-rendering.md` §4 records **[measured]** 10 mock
sessions at 2,000 rows/s holding `p50 16.7 ms, p95 16.8 ms, worst 17.7 ms, dropped 0`, with the
explicit steady-state requirement that "rendered DOM node count must stay ~ viewport + 2×overscan"
— about 40 nodes, at any thread length, because `src/components/Feed.tsx:55-67` windows with
`ROW_H = 18`, `overscan: 12`, `measureElement` never called and `useFlushSync: false`
**[measured]**. Jan's node count is unbounded in thread length by construction.

**Verdict: Jan's thread renderer is disqualified for brigadier.** It is a good design for a
consumer chat app where a thread is tens of turns and every turn is prose worth typesetting. It is
the wrong design for a supervisor feed where a session is tens of thousands of terse rows and the
product claim is length. Keep `Feed.tsx`. Not measured: I did not build Jan and scroll a synthetic
10,000-message thread, so "it degrades" is a structural argument, not a benchmark (§8).

---

## 4. Streaming — how a chunk reaches the DOM

Three coalescing stages, and the first is directly worth copying.

1. **A throttle at the source.** Jan uses `@ai-sdk/react`'s `useChat` through a thin wrapper,
   `web-app/src/hooks/use-chat.ts:96-102` **[measured]**, and passes
   **`experimental_throttle: 50`** at `web-app/src/routes/threads/$threadId.tsx:305`
   **[measured]**. That is the AI SDK's built-in update throttle: React state is committed at most
   once per 50 ms (20 Hz) no matter how fast tokens arrive. **It is not per-token React state.**
   Grepping the whole frontend for `throttle` returns exactly those three lines **[measured]** —
   it is the single ingestion dial in the app.

   This is the same insight as brigadier's, one notch coarser. `src/feedStore.ts:2` describes
   "Channel → module buffer → one rAF drain → one commit per frame" and `:355`/`:395` run exactly
   one `requestAnimationFrame` loop for the whole window **[measured]**. Ours commits at display
   cadence (60/120 Hz) and coalesces *across all sessions*; Jan's commits at a fixed 20 Hz for the
   one thread on screen. **Ours is the better mechanism** — rAF cannot commit into a frame that
   is not being painted, whereas a 50 ms timer can fire mid-frame — but Jan's confirms the shape
   from an independent codebase, and 20 Hz is a defensible floor for prose.

2. **A deferred value at the markdown boundary.**
   `web-app/src/containers/RenderMarkdown.tsx:220`, `const deferredContent = useDeferredValue(content)`,
   applied only while streaming (`:221`) **[measured]**. The comment at `:216-219` states the
   intent plainly: React renders the older value while new tokens arrive and skips intermediates
   under load, so "the memoized Streamdown subtree re-renders far less than once per token". It is
   the only `useDeferredValue` in the frontend **[measured]**.

3. **A streaming-specific fast path.** `RenderMarkdown.tsx:223-231` skips `normalizeLatex` while
   streaming because it "is O(n) over the full string and its cache misses every chunk", which
   would make the stream O(n²) in message length **[measured]**. `:254-259` likewise defers HTML
   artifact splitting until the stream completes. These are exactly the kind of asymptotic traps a
   long-session product hits, and Jan has already found and annotated two of them.

The transport is `CustomChatTransport` (`web-app/src/lib/custom-chat-transport.ts`, referenced at
`use-chat.ts:4`), owned per session and held in the store rather than in the component
(`use-chat.ts:33`, "Using a ref here so we can update the model used in the transport without
having to reload the page") **[measured]**. I did not read the transport's body (§8).

---

## 5. Multi-conversation state — the finding that does transfer

**Jan models many concurrent live sessions.** `web-app/src/stores/chat-session-store.ts`
**[measured]**:

- `:25-26` — `sessions: Record<string, ChatSession>` alongside a single `activeConversationId`.
- `:14-22` — each `ChatSession` carries its own `Chat` instance, its own `CustomChatTransport`,
  its own `status`, an `isStreaming` flag, an `unsubscribers` array and a `data` bag of messages,
  tool calls and an id map.
- `:60` — created with `create<ChatSessionState>`, a plain zustand store at module scope.
- `:93-95` — on creation the store registers a status callback on the `Chat`
  (`chat["~registerStatusCallback"]`) so the session's status stays synced **from the store, not
  from a mounted component**.
- `:47-49` — `isSessionBusy` is exported as a standalone helper "for reactive use in components",
  i.e. so a sidebar row can show a spinner for a session that is not on screen.

**The engine lives in the store; the route is only a view of it.** That is the architectural
property brigadier needs for "many projects supervised at once", and it is the single most
valuable thing in this repo for us. A session started, then navigated away from, keeps streaming
into store state — **[asserted]** by construction (the `Chat` is store-owned and its status
callback is store-registered), not verified by running the app.

The agentic Cowork surface goes further and is closer still to our problem shape.
`web-app/src/hooks/useCoworkRun.ts:127-160` **[measured]** is a zustand store whose every field is
keyed by session id: `liveTurns`, `subagents`, `runId`, `pendingAsks` (in-flight permission
questions!), `usage`, `llamacppRuns`, `loadingModels` — all `Record<string, …>`. The comments are
written by someone who hit our exact problem: `:141-147` explains that the global error listener
is "mounted outside Cowork's component tree, so it still sees a session running in the
background". And `:450-454` **[measured]** defines a per-session selector with the reasoning
spelled out:

```
// Per-session selectors, mirroring useAppState's useIsThreadActive — a
// component reading only one session's slice re-renders on that session's
// changes, not on every other session's.
export const useIsSessionActive = (sid: string | undefined) =>
  useCoworkRun((s) => (sid ? s.runId[sid] != null : false))
```

**That selector granularity is the pattern to copy.** With N live sessions, a store that notifies
every subscriber on every session's every update is O(N²) chatter; Jan's answer is a narrow
selector per session. brigadier will need the same discipline the moment the sidebar shows live
status for ten sessions.

Session lists are persisted: `web-app/src/hooks/useCoworkSessions.ts:101-104` wraps the store in
zustand's `persist` with a custom storage that writes "through the Rust settings store"
(`:240-241`), plus a versioned `migrate` (`:247-258`) **[measured]**. Worth knowing that shape
exists; brigadier already has `docs/research/persistence.md` and should not adopt it blind.

### The limit

**One thread is rendered at a time.** The route is `/threads/$threadId`
(`web-app/src/routes/threads/$threadId.tsx`), the store holds one `activeConversationId`
(`chat-session-store.ts:26`), and there is no split view, tab strip or side-by-side thread surface
in `web-app/src/routes/` **[measured]**. Cowork keeps `currentId` and a `sessions: CoworkSession[]`
array (`useCoworkSessions.ts:65`, `:101-117`) with the same single-current model. So: many
sessions **live**, one session **visible**.

If brigadier's "multiple projects at the same time" means many sessions running while one is on
screen and the others show live status in the sidebar, **Jan's model is exactly right and should
be copied**. If it means two or more feeds visibly streaming side by side, **Jan has no answer and
none of its layout code helps** — that is a layout brigadier has to design, and the thing that
makes it viable is precisely our virtualised feed (two windowed feeds cost ~80 DOM nodes; two of
Jan's cost everything).

---

## 6. The shell

Structure, from `web-app/src/routes/__root.tsx` **[measured]**:

- `:53-58` — a `SidebarProvider` from shadcn/ui wraps the app, holding `open`, `defaultWidth` and
  `onWidthChange`, driven by a `useLeftPanel` hook. **The sidebar is user-resizable and its width
  is persisted state**, which brigadier's fixed `--sidebar-w: 276px`
  (`ui-restyle-notes.md` (deleted; not in the repo) §2) is not.
- `:64-71` — a `data-tauri-drag-region` strip, `fixed w-full h-12 z-20 top-0`, so the top of the
  window drags. Directly relevant: `ui-restyle-notes.md` §6 lists "the reference hides its title
  bar and runs the sidebar to the top" as an open item that needs a `src-tauri` change. **Jan
  shows the webview half of that recipe.**
- `:73-78` — `<LeftSidebar />` then `<SidebarInset>` containing `<Outlet />`. Two columns, the
  right one router-driven.
- `:62-63` — `WindowControls` and `WindowResizeGrips`, rendered only on Windows/Linux, with the
  sidebar header reserving space for native controls on macOS
  (`components/left-sidebar/index.tsx:25-29`). A worked answer to a cross-platform titlebar
  problem brigadier will meet.

The sidebar itself, `web-app/src/components/left-sidebar/index.tsx:32` **[measured]**:
`<Sidebar variant="floating" collapsible="offcanvas">`, header + content + `SidebarRail`, composed
of `NavTabs`, `NavMain` / `NavCowork` (swapped by route, `:45`), `NavProjects` and `NavChats`.
Total 1,683 LOC across `components/ui/sidebar.tsx` (859) and the six `left-sidebar/*.tsx` files
**[measured]**. `NavCowork.tsx:51` carries a comment worth the read: each row is its own memoized
component rather than inlined in a `.map`, so one busy session's tick does not re-render the whole
list **[measured]**.

The thread column is `mx-auto w-full md:w-4/5 xl:w-4/6` (`$threadId.tsx:1730`), i.e. a
**proportional** centred column, with the composer below it under the identical class
(`:1888`) so they align **[measured]**. brigadier centres on a fixed `--thread-max: 736px`
instead. Jan's proportional approach is the more robust one on a resizable window; ours is the
more faithful to the ChatGPT reference. Not a copy decision, a taste decision.

### Light scheme — yes, Jan ships one

**Jan is not dark-only.** `web-app/src/index.css:98` defines the full token set on `:root` in
light values (`--background: oklch(1 0 0)`), and `:133` `.dark` overrides them
(`--background: oklch(0.18 0 0)`) **[measured]**. The variant is wired at `:20`,
`@custom-variant dark (&:is(.dark *))`, and the class is toggled in
`web-app/src/providers/ThemeProvider.tsx:9-13` **[measured]**. That provider is worth reading in
full even if nothing else is taken: `:33-35` listens to `prefers-color-scheme`, and `:37-52`
handles the case where WebKitGTK on Linux does *not* track the desktop portal, falling back to a
Rust-side portal read re-emitted as a `theme-changed` event.

brigadier is dark-only today and `ui-restyle-notes.md` §6 records that as deliberate — the
reference has no light mode, so a light scheme "has to be designed, not measured". Jan does not
change that reasoning, but it does supply a working three-state (`auto`/`light`/`dark`) mechanism
if the owner ever wants one. All tokens are **oklch**, which is a better basis for deriving a
light scheme from a dark one than our hex values.

### Reusable vs. tangled

**Genuinely reusable — domain-free, would drop in with only Tailwind + Radix as the cost:**

| File(s) | LOC | Why |
|---|---|---|
| `components/ui/*.tsx` (27 files) | — | Stock shadcn/ui primitives. Better fetched from shadcn upstream than copied from Jan — same code, no attribution question. |
| `components/ui/sidebar.tsx` | 859 | The resizable/collapsible/offcanvas sidebar. The single biggest ready-made win. |
| `components/ai-elements/tool.tsx` | 682 | **Tool-call display**: collapsible header, status, input/output. brigadier's feed shows tool calls; this is the shape, already built. |
| `components/ai-elements/chain-of-thought.tsx` | 438 | Reasoning/step timeline. |
| `components/ai-elements/reasoning.tsx` + `reasoning-timeline.tsx` | 275 | Streaming reasoning block with its own scroll handling. |
| `components/ai-elements/code-block.tsx` | 179 | Shiki code block. |
| `components/ai-elements/shimmer.tsx` | 66 | Streaming-in-progress affordance. |
| `containers/CoworkTodoPanel.tsx`, `CoworkDiffPanel.tsx`, `CoworkAskCard.tsx` | — | **Closest prior art in the repo to brigadier's approvals.** `CoworkAskCard` is a permission/question card; `useCoworkRun.ts:133` holds `pendingAsks` per session. Worth reading before finishing `src/components/Approvals.tsx`. |
| `providers/ThemeProvider.tsx` | 79 | Three-state theme with the Linux portal fix. |
| `hooks/useAutoScroll.ts` | 55 | Small, self-contained bottom-pinning. |

Note `components/ai-elements/` is Vercel's **AI Elements** registry, which Jan has vendored and
modified — it is upstream-available under its own terms **[asserted]**, I did not check Vercel's
licence. Prefer upstream if it matches.

**Tangled into Jan's domain — would have to be gutted, and are not worth it:**

- `containers/DownloadManegement.tsx` [sic], `ModelDownloadAction`, `MlxModelDownloadAction`,
  `DownloadButton`, `ModelSupportStatus`, `ModelInfoHoverCard`, `ModelCombobox`,
  `DropdownModelProvider`, `SamplerPopover`, `ParametersSection`, `Capabilities` — all local-model
  management.
- `routes/hub/**`, `routes/settings/hardware.tsx`, `routes/system-monitor.tsx`,
  `routes/local-api-server/**`, `routes/settings/providers/**`, `routes/settings/extensions.tsx` —
  model hub, GPU/VRAM settings, llama.cpp server control. Nothing for us.
- `MessageItem.tsx` (801 lines) — despite being the obvious target, it is threaded through Jan's
  regenerate/continue/edit/delete/version-switching model, reasoning refs and citation system. Read
  it for the memo comparator at `:779`; do not lift it.
- `providers/DataProvider`, `ExtensionProvider`, `ServiceHubProvider` — Jan's extension
  architecture, and the seam into the AGPL-declared `core/`. Avoid entirely.
- `containers/analytics/**`, `posthog-js`, and the Google Analytics injector in
  `web-app/vite.config.ts:11-43` **[measured]**. If any Jan file is copied, **check it for
  telemetry before it lands** — brigadier should not inherit an analytics call by accident.

One unexpected note: `web-app/src/routes/settings/claude-code.tsx` exists **[measured]**, but it
points the other way — it configures Jan's *local model* as a backend for the user's Claude Code
install (`JAN_CODE_HF_REPO`, `:19`). It does not drive the `claude` CLI's stdio protocol and is
not prior art for brigadier's supervisor. `routes/cowork.tsx` (752 lines) is Jan's own agent loop
against its own tool plugin, not a Claude Code harness.

---

## 7. What to take / what to leave

**Take:**

1. **The store-owned-session shape.** `chat-session-store.ts:14-26` and `useCoworkRun.ts:127-160`.
   Engines in a store keyed by id, routes as views, per-session selectors
   (`useCoworkRun.ts:453`). This is independent confirmation of the architecture brigadier's
   "many projects at once" claim requires, from a shipping app on our exact stack.
2. **The three streaming mitigations.** A fixed-cadence throttle (`$threadId.tsx:305`),
   `useDeferredValue` at the expensive-render boundary (`RenderMarkdown.tsx:220`), and skipping
   O(n) whole-string work while streaming (`RenderMarkdown.tsx:223-231`). We already have (1) in a
   better form; (2) and (3) are new to us and will matter the moment a feed row renders anything
   richer than text.
3. **`components/ui/sidebar.tsx`** — but from shadcn upstream, not from Jan.
4. **`components/ai-elements/tool.tsx` and `chain-of-thought.tsx`** as the design of tool-call and
   reasoning rows, read before we build ours.
5. **The layout recipe**: `data-tauri-drag-region` strip (`__root.tsx:64-71`), sidebar with
   persisted width, per-platform window-control reservation
   (`left-sidebar/index.tsx:25-29`). This closes an open item in `ui-restyle-notes.md` §6.
6. **`ThemeProvider.tsx`** if a light scheme is ever wanted — including the Linux portal fix we
   would otherwise discover the hard way.

**Leave:**

1. **The thread renderer.** `$threadId.tsx:1733`. Non-negotiable — it is the direct opposite of
   the product claim.
2. **`MessageItem.tsx`** as a component (read the comparator, leave the body).
3. **Everything model-management**: hub, downloads, hardware, providers, extensions, `core/`.
4. **Analytics**: `posthog-js` and `vite.config.ts:11-43`.
5. **`@tanstack/react-router`** unless brigadier actually wants routes; today it has none, and a
   router is not free.

**The honest scoping.** "Copy-paste from Jan" is not one decision, it is two. The cheap one — read
their code, steal their patterns, lift four or five self-contained components — is clearly worth
doing and carries no licence risk. The expensive one is that **every one of those components is
Tailwind 4 + Radix + shadcn**, and brigadier today ships five runtime dependencies and 1,059 lines
of hand-written CSS built from measured ChatGPT screenshots (`ui-restyle-notes.md` §1-2). Taking
Jan's components means adopting that stack and re-deriving the measured token table in Tailwind —
a real migration, not a paste. **The design can be borrowed for free; the code cannot.**

---

## 8. What I did not check

- **Nothing was built, run or benchmarked.** No `yarn install`, no `yarn dev`, no bundle. Every
  performance statement about Jan is structural — read from source — not measured. Specifically:
  I did **not** load a 10,000-message thread in Jan and measure frame times, DOM node count or
  heap. The claim "unbounded DOM nodes in thread length" follows from `$threadId.tsx:1733` having
  no windowing, and is as strong as that; "and therefore it is slow at length N" is not measured.
- **Whether `@ai-sdk/react` preserves referential identity for settled messages across updates.**
  The whole memo story in §3 depends on it. I did not read the SDK's internals, and
  `node_modules` was never installed.
- **`lib/custom-chat-transport.ts`** was not read — only its call sites. How chunks arrive from
  Tauri into the transport is therefore unverified.
- **`components/ui/sidebar.tsx` (859 lines)** was not read line by line; its API surface was
  inferred from `left-sidebar/index.tsx` and `__root.tsx`. It is assumed to be stock shadcn/ui —
  **[asserted]**, not diffed against upstream.
- **Vercel AI Elements' licence** was not checked; `components/ai-elements/**` is stated above as
  vendored-and-modified on the strength of its structure, not a verified provenance trail.
- **No legal review.** §1 reports what the licence text says and what the git history shows. The
  AGPL-in-`package.json` inconsistency is a fact; "they are stale leftovers" is an inference from
  `e8ca7f3c` touching only `LICENSE`, not a maintainer statement. **The owner should decide, and
  the one-line de-risk is to open an issue asking.**
- **Trade dress / trademark** was not assessed beyond noting that Apache-2.0 §6 grants no
  trademark rights.
- **`src-tauri/` (89,054 LOC Rust)** was surveyed only for its manifest and window config. Jan's
  Rust side may hold useful patterns (its window/vibrancy setup in particular, given
  `ui-restyle-notes.md` §6's open vibrancy item) and was out of scope here.
- **Jan's git history beyond `LICENSE`** was not examined; I do not know whether the thread
  renderer was ever virtualised and reverted, which would be worth knowing before concluding they
  simply never needed it.
- **No comparison screenshots.** Jan's actual rendered UI was never seen — only its source. Every
  visual statement in §6 is read off class names and CSS tokens, not off a screenshot, which is a
  weaker basis than the measured screenshot method used in `ui-restyle-notes.md` §1.
