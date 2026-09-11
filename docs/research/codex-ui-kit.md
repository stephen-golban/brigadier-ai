# codex-ui-kit vs assistant-ui elements

Comparison of two candidate sources for a Codex-styled thread UI: `JaminZhou/codex-ui-kit` (an independent,
unofficial replica of Codex Desktop's React components) and assistant-ui's own component registries
(brigadier's existing runtime). Gathered 2026-09-10. Method: cloned `codex-ui-kit` at commit
`9f3af2c3a6386d4ea05f8b3f2c1051ae1a50789d` (2026-09-08 22:00:34 +0800) into a session-local scratchpad
directory — not part of this repository; reproduce by re-cloning at that commit — and read its source, tests
and docs directly; assistant-ui docs read via `https://www.assistant-ui.com/llms.txt` and the `.md` pages it
indexes. Every claim below is marked **MEASURED** (read the file / fetched the page on the gathering date)
or **ASSERTED** (inference or unverified). Sources cited inline.

**Authority.** This file is authoritative for what each library ships today — component inventory, licence
terms, dependency graph, theming contract, and the trade-offs between vendoring `codex-ui-kit` and restyling
assistant-ui's elements. It is **not** authoritative for Codex Desktop's actual pixel values: `codex-ui-kit`
is a runtime-observed replica, not the shipped app, and where it disagrees with the real Codex Desktop
bundle, **the bundle is authoritative** — `codex-ui-kit`'s newest recorded build observation is
`26.901.51231`, while `codex-thread-tokens.md` reads bundle `26.903.61454` (newer); see that file's §12 for
the full disagreement table. See `codex-thread-anatomy.md` for the protocol structure neither UI library
encodes, and `codex-thread-row-mapping.md` for the per-row component picks this comparison feeds into.

---

## Part 1 — codex-ui-kit

### 1.1 What it is

**MEASURED.** It is a **source-only React component library**, built to be published to npm but **not published**.
- `package.json` has `"name": "codex-ui-kit"`, `"version": "0.1.0"`, `"private": true`, `"publishConfig": {"access":"public"}`,
  `main/module/types` → `./dist/…`, and exports `.`, `./styles.css`, `./tokens.css`.
- `README.md`: *"The repository is public and the package baseline is `0.1.0`, but the npm package has **not** been published."*
  and *"The package is not yet available from npm. To explore the current public source: git clone …"*
- **MEASURED:** `https://registry.npmjs.org/codex-ui-kit` returns `{"error":"Not found"}`. Nothing is on npm.
- It is **not** a shadcn-style copy-paste registry — there is no `registry.json`, no per-component JSON, no CLI.
  It is a single ESM package with one barrel (`src/index.ts`, 54 re-exports) and two stylesheets.
- There **is** a Vite demo/showcase (`demo/`, `pnpm dev`, deployed at https://jaminzhou.com/codex-ui-kit/), an Electron
  playground, and a private "codex-app" playground that drives the real Codex app-server protocol.
- So today, consuming it means **vendoring the source** (copy `src/` in) or building the package locally.

### 1.2 License

**MEASURED.** `LICENSE` is the verbatim **MIT** license text (SPDX: `MIT`), `Copyright (c) 2026 JaminZhou`.
`package.json` also declares `"license": "MIT"`. Attribution requirement is the standard MIT clause: the copyright
notice and permission notice must be included in all copies or substantial portions.

Additional non-legal notices you should carry (**MEASURED**, `README.md` / `SOURCES.md`):
- *"This is an unofficial, independently developed open-source project for the public Codex ecosystem. It is not
  affiliated with, sponsored by, or endorsed by OpenAI. Codex and OpenAI are trademarks of OpenAI."*
- `SOURCES.md` boundaries: no OpenAI/Codex logos, fonts, sounds or illustrations shipped; do not present as official.
- **MEASURED:** the font token `--codex-ui-font-openai-sans: "OpenAI Sans", …` (`src/tokens.css:70`) *names* OpenAI Sans
  but the package does not redistribute it; it falls back to the native system stack. If you want the exact Codex
  typography you must license the font yourself. **Not checked:** whether OpenAI Sans is licensable at all.

**The five subagent avatar SVGs are excluded from the MIT grant.** MEASURED, quoting
`src/assets/subagents/README.md` verbatim: those five files — `lattice.svg`, `orbit.svg`, `pinwheel.svg`,
`sprout.svg`, `sunbeam.svg` — "were captured from the rendered Codex Desktop `26.825.51511` (`7377`)
interface on 2026-09-01 … The upstream artwork remains copyright OpenAI. No ownership is claimed, and these
observed assets are not relicensed under the repository's MIT license." The kit's own `SOURCES.md` states
the boundary directly: "Do not ship OpenAI or Codex logos, fonts, sounds, illustrations, or other brand
assets." Do not vendor `src/assets/subagents/**` (or any other OpenAI/Codex brand asset) into brigadier —
brigadier needs its own subagent artwork. No OpenAI brand assets, fonts, logos, sounds or illustrations are
to be shipped, full stop.

**Trademark risk (ASSERTED, not legal advice):** the package name, all 399 CSS variables, and every class use the
`codex-ui-` prefix. Vendoring it into a shipped product carries a "looks like OpenAI Codex" trade-dress question that
MIT does not answer. That is a product decision, not a technical one.

### 1.3 Stack — package.json verbatim

**MEASURED.**

```json
"peerDependencies": { "react": ">=18", "react-dom": ">=18" },
"dependencies": {
  "highlight.js": "11.12.0",
  "katex": "0.16.45",
  "react-markdown": "10.1.0",
  "rehype-katex": "7.0.1",
  "remark-gfm": "4.0.1",
  "remark-math": "6.0.0"
},
"devDependencies": {
  "@arethetypeswrong/cli": "0.18.5", "@testing-library/react": "^16.3.2",
  "@types/react": "^19.2.18", "@types/react-dom": "^19.2.5",
  "axe-core": "4.13.0", "happy-dom": "^20.14.0",
  "pixelmatch": "7.2.0", "pngjs": "7.0.0", "publint": "0.3.24",
  "puppeteer-core": "25.10.0", "react": "^19.2.8", "react-dom": "^19.2.8",
  "typescript": "^7.0.2", "vite": "^8.2.1", "vitest": "^5.0.0"
},
"packageManager": "pnpm@11.7.0", "type": "module"
```

- **React:** peer `>=18`; dev/test on React 19.2. `COMPATIBILITY.md` claims React 18 and React 19 both supported,
  React 19 with the full suite, React 18 with a packed-package type check + SSR smoke. **MEASURED** (claim read;
  I did **not** run their CI).
- **TypeScript:** yes, all `.tsx`. Emits `.d.ts` with explicit `.js` specifiers, checked with `publint` + `attw`
  under both `Bundler` and `NodeNext`. ESM-only.
- **Styling: hand-written plain CSS. No Tailwind at all.** `grep -ril tailwind` over the repo returns **zero** hits
  (MEASURED). `src/styles.css` is 24,055 lines / 566 KB; `src/tokens.css` is 27 KB with **399** `--codex-ui-*`
  custom properties. No CSS modules, no vanilla-extract, no CSS-in-JS. Classes are literal strings
  (`"codex-ui-thread"`, `"codex-ui-tool-call__label"`).
- **Headless base: none.** No Radix, no Base UI, no Headless UI, no Ark. `grep -ri 'radix\|base-ui\|headlessui'`
  over package manifests returns zero. Menus, popovers, tooltips, selects and dialogs are hand-rolled in
  `InteractivePrimitives.tsx` (1,312 lines) and `Dialog.tsx` (355 lines), with their own portal/inert/scroll-lock
  helpers in `src/internal/` (`documentScrollLock.ts`, `inert.ts`, `overlayEnvironment.ts`, `surfacePortalOwner.ts`,
  `surfaceBlocked.ts`).
- **Icons: none as a dependency.** Icons are inline `<svg>` literals inside components (e.g. `ToolIcon()` and
  `RawOutputIcon()` in `ToolCallCard.tsx`). The only asset files are 5 subagent SVGs in `src/assets/subagents/`.
- **Animation: none as a dependency.** 35 `@keyframes` blocks in `styles.css`; 20 `@container` queries.
- **Total runtime import surface (MEASURED, grep of all non-relative imports in `src/`):** `react`, `react-dom`,
  `react-markdown`, `remark-gfm`, and 46 `highlight.js/lib/languages/*` modules plus `highlight.js/lib/core`.
  `katex` / `rehype-katex` / `remark-math` are declared deps; `styles.css` line 2 does `@import "katex/dist/katex.min.css"`.
  (I did **not** trace where `rehype-katex`/`remark-math` are wired — likely a host-supplied plugin option in
  `AgentMarkdown`; **not checked**.)

### 1.4 Component inventory (`src/components`, 54 files, 30,068 lines)

**MEASURED** (`wc -l`). "Thread" = belongs in a chat/session timeline. "Chrome" = app shell / settings / other.

| File | Lines | Purpose | Kind |
|---|---:|---|---|
| `AgentThread.tsx` | 336 | `AgentThread` (section, width narrow/wide/full), `AgentTurn`, **`AgentThreadViewport`** (auto-follow scroller), `ThreadVirtualizedPlaceholder`, `ActivityGroup` | **Thread** |
| `ConversationThreadShell.tsx` | 229 | Thread header + body + composer dock layout | **Thread** |
| `AgentMessage.tsx` | 178 | User/assistant message row | **Thread** |
| `AgentMarkdown.tsx` | 1,450 | Markdown renderer: `AgentMarkdown`, `InlineCode`, `CodeBlock`, highlight hook-in | **Thread** |
| `AgentReasoning.tsx` | 74 | Collapsible "Thinking"/"Thought" `<details>` block | **Thread** |
| `AgentPlan.tsx` | 135 | Agent plan checklist | **Thread** |
| `ProposedPlan.tsx` | 192 | Proposed-plan card | **Thread** |
| `AgentActivity.tsx` | 184 | Base activity row (indicator + summary + disclosure) all activity cards build on | **Thread** |
| `ActivityTimeline.tsx` | 102 | Collapsible "N previous messages" turn timeline with persistent content + summary slot | **Thread** |
| `ToolCallCard.tsx` | 206 | One tool call: name, status, summary, result / error / structured JSON, raw-output button | **Thread** |
| `McpToolCallGroup.tsx` | 102 | Grouped MCP tool calls | **Thread** |
| `CommandExecution.tsx` | 431 | Command block: command, streaming output tail, exit status, duration (`CommandExecution`, `CommandOutput`) | **Thread** |
| `SearchActivity.tsx` | 167 | Web/file search activity row | **Thread** |
| `BrowserActivity.tsx` | 146 | Browser-tool activity row | **Thread** |
| `SubagentActivity.tsx` | 835 | Delegated-agent timeline, summary, wide list, nested transcript panel | **Thread** |
| `ApprovalRequest.tsx` | 735 | **Approval card**: request → allow/deny → resolved states, options menu, scoped file approvals | **Thread** |
| `AutomaticApprovalReview.tsx` | 102 | Automatic-review lifecycle states | **Thread** |
| `FileChange.tsx` | 1,639 | `FileChange`, `FileChangeGroup`, `FileDiff`, `FileReview`, `FileReviewWorkspace`, `FileRevertErrorDialog`; +/− stats, hunk/addition/deletion line kinds | **Thread** |
| `TurnDuration.tsx` | 97 | "Working for 1m 15s" / "Worked for …" live timer + `formatTurnDuration` | **Thread** |
| `ThreadState.tsx` | 379 | Loading, thinking, skeleton, render-error, context-optimization states | **Thread** |
| `Notices.tsx` | 437 | Status banners, inline notices, stream notices, working-directory notice | **Thread** |
| `ConversationEvents.tsx` | 160 | Mixed event stream composition | **Thread** |
| `AgentComposer.tsx` | 662 | Composer: **plain `<textarea>`** with autosize, attachments, modes, send/stop | **Thread** |
| `ComposerAuxiliary.tsx` | 938 | Composer dock, context controls, attachments, mentions, queued prompts | **Thread** |
| `ComposerPlanProgress.tsx` | 208 | Plan progress strip above the composer | **Thread** |
| `ThreadNavigation.tsx` | 592 | Message navigation / jump-to controls | **Thread** |
| `ThreadSummaryPanel.tsx` | 375 | Thread-summary popover with collapsible sections + change deltas | **Thread** |
| `ThreadOverflowMenu.tsx` | 174 | Thread "…" menu | **Thread** |
| `StatusIndicator.tsx` | 27 | Status dot | **Thread** |
| `ResourceSurfaces.tsx` | 1,201 | Resource cards, citations, sources, generated-image galleries | **Thread** (adjacent) |
| `AppShell.tsx` | 2,973 | Sidebar + main + side/bottom panel shell, resizable tracks | Chrome |
| `SettingsSurfaces.tsx` | 3,044 | Full settings shell/search/preferences | Chrome |
| `ProjectConversationRouting.tsx` | 1,922 | Project index, new-chat destination, worktree selectors | Chrome |
| `InteractivePrimitives.tsx` | 1,312 | Buttons, icon buttons, menus, selects, popovers, tooltips | Chrome |
| `PullRequestSurfaces.tsx` | 1,154 | PR list/detail/checks/reviewers/threads | Chrome |
| `KeyboardVoiceSettings.tsx` | 829 | Keyboard + voice settings | Chrome |
| `ScheduledTasks.tsx` | 739 | Scheduled runs | Chrome |
| `McpSettings.tsx` | 729 | MCP server manager | Chrome |
| `TerminalPanel.tsx` | 638 | Multi-session terminal tabs | Chrome |
| `PluginDetail.tsx` | 449 | Plugin detail page | Chrome |
| `IntegrationCatalog.tsx` | 438 | Integrations catalog | Chrome |
| `UsageSettings.tsx` | 425 | Usage & billing | Chrome |
| `WorktreeSetupStatus.tsx` | 406 | Worktree setup status | Chrome |
| `WorkspaceSelection.tsx` | 400 | Workspace picker | Chrome |
| `Dialog.tsx` | 355 | Modal dialog | Chrome |
| `AppNotifications.tsx` | 350 | Portalled global notifications | Chrome |
| `WorktreeSettingsPage.tsx` | 319 | Worktree settings | Chrome |
| `SkillDetail.tsx` | 242 | Skill detail | Chrome |
| `BrowserWorkspacePanel.tsx` | 180 | Browser panel | Chrome |
| `ThreadOverflow…`/`AppRouteOutlet.tsx` | 161 | Route outlet | Chrome |
| `BranchCreationDialog.tsx` | 153 | Branch creation | Chrome |
| `AppServerCrashRecovery.tsx` | 151 | Crash recovery | Chrome |
| `AppWindowChrome.tsx` | 135 | Window chrome | Chrome |
| `EnvironmentSurfaces.tsx` | 71 | Local environments | Chrome |

Roughly **11.5k lines of thread-related components** and ~18.5k of chrome. Plus `src/highlightCode.ts` (46 languages
registered on `highlight.js/lib/core`) and 87 test files / 24,128 test lines.

### 1.5 Is there a real thread container?

**MEASURED — yes, but not virtualized.** `AgentThreadViewport` (`src/components/AgentThread.tsx`) is a real scroller:
- `autoFollow` with a `followThreshold` (default 24px), `defaultFollowing`, `onFollowingChange`, `followKey`.
- Disarms follow on `keydown`/`pointerdown`/`touchstart`/`wheel`, re-arms when the user returns to the latest edge.
- Supports `latestOrigin: "end" | "start"` — a reverse-origin (column-reverse-style) thread where the newest content
  sits at `scrollTop 0` — and preserves distance-from-latest across an origin flip in `useLayoutEffect`.
- Honours `prefers-reduced-motion` when programmatically scrolling.
- `footer` slot and a `topInset` CSS variable.
- **Grouping:** `AgentTurn` (`spacing: "grouped" | "standard"`) and `ActivityGroup` are containers you fill yourself;
  `ActivityTimeline` collapses "N previous messages" behind a disclosure.
- **Virtualization: no.** There is only `ThreadVirtualizedPlaceholder`, an `aria-hidden` fixed-height spacer div
  (`data-virtualized-turn-content="true"`) that a host virtualizer can render for unmounted turns. The kit provides
  no virtualizer, no measurement, no windowing.

So: leaf pieces **and** a container, but the container is a scroll/follow manager, not a list renderer. You still own
the message→component mapping loop.

### 1.6 Theming

**MEASURED.**
- All colour/typography/spacing is CSS custom properties prefixed `--codex-ui-` (399 of them in `tokens.css`),
  declared on `:root, [data-codex-ui]`. Raw ramps (`--codex-ui-gray-0…1000`, blue/green/orange/red/yellow) plus
  semantic tokens plus a `--codex-ui-code-syntax-{light,dark}-*` set for highlight.js.
- Light/dark: `[data-theme="light"]` (line 264), `[data-theme="dark"]` (line 389), and
  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` (lines 518–519). System-following
  by default, overridable per subtree. This is exactly the three-state pattern.
- `COMPATIBILITY.md`: *"Do not depend on private class structure; only `--codex-ui-*` custom properties are part of
  the theming contract."* — so retheming is supported, restyling by class is not.
- `styles.css` has **no global resets** — `grep -E '^(html|body|\*|:root)' src/styles.css` returns nothing;
  `box-sizing: border-box` is scoped to an explicit list of `.codex-ui-*` selectors. It will not fight Tailwind
  preflight. (MEASURED.)

### 1.7 Fidelity — does it mimic Codex Desktop or ChatGPT web?

**MEASURED: Codex Desktop, and to an unusual degree.**

Evidence I read:
- `SOURCES.md` states the method: read-only inspection of a locally installed Codex Desktop distribution including its
  packaged Renderer assets; record taxonomy/behaviour/measurements *without copying source*; independently implement.
  Raw extracted files stay out of the repo.
- `research/` holds 17 build-fingerprinted observation files (`26.707.72221.md` … `26.901.51231.md`), an
  `UI_INVENTORY.md` with a 5-rung evidence ladder (`package_observed` → `runtime_observed` → `implemented` →
  `browser_verified` → `electron_verified`), and `VISUAL_ASSETS.md` describing a machine-checked manifest of **120
  exact visual primitives** with viewBox, rendered size, resolved style and canonical SHA-256 per primitive.
- Current baseline is Codex Desktop `26.825.51511` (build `7377`), with the `app.asar` SHA-256 recorded.
- **432 PNG visual baselines** in `playgrounds/codex-app/tests/visual/baselines/`.
- I opened two of them (MEASURED, images below described from direct view):
  - `mixed-file-review.png` — full app: left sidebar (Codex ▾, New chat, Pull requests, Sites, Scheduled, Plugins,
    Pinned, Projects, Recents, account row), centre thread with a right-aligned user bubble, an "Edited 4 files /
    Review changes ↗" card with per-file `+1 −1` stats and Undo/Review buttons, a right-hand unified-diff review pane
    with tinted add/remove lines and `@@` hunk headers, and a composer reading "Do anything" with a `+`,
    "Approve for me", a model picker ("5.6 Sol Extra High ▾") and a circular ↑ send button.
  - `approval-current-pending.png` — "Working for 1m 15s ▾" turn summary, a `Running touch …` command row, and a
    bottom approval card titled "Terminal" with `Deny [Esc]` / `Allow once [⏎]` buttons.
  This is a Codex Desktop replica, not a ChatGPT-web look.
- Honesty markers are unusually strong and cut the other way too: `README.md` — *"The current components are a partial
  coding-agent UI foundation, not a complete Codex Desktop reconstruction"*; 73 of 91 surface groups have current-build
  observation, 7 are previous-build regression evidence, **11 are still unsampled**. `PARITY.md` opens with
  *"This document no longer claims that the repository has complete Codex Desktop parity."*

**Not checked:** I did not run the demo or diff a baseline against a real Codex Desktop install. The fidelity judgement
above rests on the committed baselines and the author's own documentation.

### 1.8 Maintenance signal

**MEASURED** (`gh api repos/JaminZhou/codex-ui-kit`, today):

| Signal | Value |
|---|---|
| Stars | **0** |
| Forks | 0 |
| Open issues | 0 |
| Created | 2026-07-14 |
| Last push | 2026-09-08 (2 days ago) |
| Archived | no |
| Contributors | `JaminZhou` 248 commits, `dependabot[bot]` 7 |
| PR numbering | recent merges are `#280`, `#279`, `#278`… — ~280 PRs in ~8 weeks |
| npm | not published |

Read: a **solo author, two months old, extremely productive, zero external users**. It has CI, CodeQL, a11y gates
(axe-core, WCAG A/AA/2.2), Electron acceptance harness, publint/attw, and 87 test files — engineering discipline far
above the star count. But bus factor 1, no release, pre-1.0 API explicitly allowed to break
(`COMPATIBILITY.md`: *"Public APIs may change before 1.0"*), and no community to inherit it.

### 1.9 Compatibility with brigadier's stack

**MEASURED unless noted.**

| Concern | Verdict |
|---|---|
| Tailwind 4 vs 3 | **Non-issue.** The kit uses zero Tailwind. Its CSS coexists; no preflight collision (no global selectors). |
| React 19.1 | Fine. Peer `>=18`, dev-tested on 19.2. |
| `@radix-ui/react-*` ban | **Fully satisfied** — the kit imports no Radix at all. (Note `@assistant-ui/react@0.15.18` itself depends on the **monolith** `radix-ui@^1.6.7`, which is the package brigadier already allows.) |
| Peer deps | Only `react` / `react-dom`. |
| New runtime deps if vendored | `highlight.js@11.12.0`, `react-markdown@10.1.0`, `remark-gfm@4.0.1`, plus `katex@0.16.45` + `rehype-katex` + `remark-math` if you keep the math path. **Conflict risk:** brigadier already has `@assistant-ui/react-markdown@^0.14`, which is its own markdown stack — two markdown renderers unless you pick one. |
| ESM-only | Fine for Vite. |
| Browser features required | `ResizeObserver`, `MutationObserver`, `inert`, container queries, `color-mix()`. Tauri v2 uses the system WebView — WKWebView on macOS. **ASSERTED / not checked:** all five are available in current WKWebView; `inert` and `color-mix()` are the ones worth verifying on the oldest macOS brigadier supports. |
| Bundle weight | `styles.css` is 566 KB unminified (24,055 lines) covering the *whole* app surface. Tree-shaking does not apply to CSS: importing `codex-ui-kit/styles.css` ships all of it. **Relevant to the 287–295 ms first-contentful-paint budget** in `docs/STATUS.md` §4 — this is the single biggest measured risk for route B and I did **not** measure its effect. |
| Composer | Plain `<textarea>` with manual autosize. Does **not** interoperate with `@assistant-ui/react-lexical`; you would keep one or the other. |
| Consumption model | No npm package → vendor the source, pin a commit, and own it. |

### 1.10 Code & diff rendering

**MEASURED.**
- Highlighter: **highlight.js 11.12.0**, `lib/core` with 46 languages explicitly registered in `src/highlightCode.ts`
  (bash, diff, rust, typescript, python, …), plus `hljs.highlightAuto` when no language is given, and an alias
  `wolfram → mathematica`. Throws `Unknown language: …` on an unregistered name. Colours come from
  `--codex-ui-code-syntax-{light,dark}-*` tokens, not an hljs theme stylesheet.
- Markdown: `react-markdown@10.1.0` + `remark-gfm`; KaTeX CSS imported by `styles.css`.
- Diff: **its own renderer**, `FileChange.tsx` (1,639 lines) — line kinds `"addition" | "deletion" | "hunk" | …` with
  `+`/`−` prefixes, per-file `additions`/`deletions` counts, `FileDiff`, `FileReview`, `FileReviewWorkspace`,
  `FileChangeGroup`, `FileRevertErrorDialog`. No `diff2html`, no `react-diff-viewer`. **Not checked:** whether it
  parses unified diff text or expects pre-parsed hunks.

---

## Part 2 — assistant-ui, current state

Entry point: https://www.assistant-ui.com/llms.txt (fetched today).

### 2.1 Versions — **you are current, not lagging**

**MEASURED** (npm registry, today):

| Package | dist-tag latest | Published | Yours |
|---|---|---|---|
| `@assistant-ui/react` | **0.15.18** | 2026-09-03T14:26Z | 0.15.18 ✅ |
| `@assistant-ui/react-markdown` | **0.14.14** | 2026-09-03T14:24Z | `^0.14` ✅ |
| `@assistant-ui/react-lexical` | **0.2.12** | 2026-09-03T14:24Z | 0.2.12 ✅ |

0.15.18 is the newest release; the previous was 0.15.17 on 2026-08-27. There are **no breaking changes since 0.15.18**
because there is nothing after it. The last breaking migration was **v0.15** itself
(https://www.assistant-ui.com/docs/migrations/v0-15.md — drops v0.12-era legacy runtime hooks, the deprecated tools
map, and the `"mcp-app"` group key; scope accessors become …). Note `@assistant-ui/react-ui` is dead weight — latest
`0.2.1` from 2025-10-17, and the CLI docs say *"the historical v0.8 UI package split … is incompatible with current
runtime versions. Do not run `codemod v0-8/ui-package-split`."*

`@assistant-ui/react-lexical@0.2.12` is **not deprecated** (npm `deprecated` field is null), depends on
`lexical@^0.49.0` / `@lexical/react` / `@lexical/utils`, and is published in lockstep with core. **But** it has no
docs page of its own in `llms.txt` — it appears only inside
https://www.assistant-ui.com/docs/guides/mentions.md §"Textarea vs Lexical", which frames it as the *optional* path:

> | | Textarea (default) | Lexical |
> | **Input component** | `ComposerPrimitive.Input` | `LexicalComposerInput` |
> | **Dependencies** | None | `@assistant-ui/react-lexical`, `lexical`, `@lexical/react` |

Lexical buys atomic inline mention *chips*; the textarea path gets the same directive text and the same trigger
popover with zero extra deps. Maintained, but clearly the secondary lane.

### 2.2 "Elements" today

**MEASURED.** There are **two** registries, both shadcn-CLI-installed copy-paste source, both Tailwind:

1. **Design library** — https://www.assistant-ui.com/design/components/*.md — 30 generic components:
   Accordion, Avatar, Badge, Breadcrumb, Button, Callout, **Code Block**, Collapsible, Combobox, Command Tabs,
   Definition List, Dialog, **Diff Viewer** ("unified or split diffs, line by line"), Dot Matrix, Dropdown Menu,
   Input, Kbd, Number Roll, Popover, Scrollbar, Select, Separator, Sheet, Skeleton, Steps, Switch, Table, Tabs,
   Toast, Tooltip.
2. **Elements** — https://www.assistant-ui.com/elements/*.md — **~120 AI/agent-specific** components. The
   Codex-relevant ones: `thread`, `thread-list`, `thread-list-sidebar`, `message-pair`, `message-actions`,
   `message-branches`, `message-timing`, `message-queue`, `composer` (+ `composer-attachments`, `composer-context`,
   `composer-mentions`, `composer-model-picker`, `composer-slash-commands`, `composer-trigger-popover`,
   `composer-voice`), `reasoning`, `reasoning-effort`, `tool-call`, `tool-error`, `tool-fallback`, **`tool-group`**,
   `tool-timeline`, **`approval-card`**, `permission-grant`, **`terminal-block`**, **`code-diff`**,
   `reviewable-diff`, **`file-tree`**, `code-runner`, **`subagent-list`**, `agent-plan`, `agent-status`,
   `agent-card`, `agent-handoff`, `todo-list`, `thinking-indicator`, `scroll-anchor`, `streaming-text`,
   `stopped-run`, `checkpoint-history`, `background-inbox`, `context-display`, `context-breakdown`, `cost-meter`,
   `quota-banner`, `connection-state`, `elicitation-form`, `markdown-text`, `shiki-highlighter`,
   `syntax-highlighter` (Prism), `mermaid-diagram`, `math-block`, `trace-waterfall`, `flow-graph`, `job-progress`,
   `empty-state`, `error-state`, `guardrail-notice`, `day-separator`, `conversation-search`, `mcp-config`,
   `mcp-server-panel`, `logos`, `orb`, `web-preview`, `web-search`, `computer-use`, `canvas-split`, `artifact-card`.

**Base UI vs Radix (MEASURED, https://www.assistant-ui.com/docs/base-ui.md):** the registry serves *both* flavours
from one host. `components.json` gets
`"registries": {"@assistant-ui": "https://r.assistant-ui.com/styles/{style}/{name}.json"}`; styles whose name starts
with `base-` get Base UI, everything else gets Radix; the plain `https://r.assistant-ui.com/{name}.json` URL is the
Radix fallback. `@assistant-ui/react`'s own primitives accept **both** Radix `asChild` and Base UI `render`.

**Install:** `npx assistant-ui@latest add thread` / `npx shadcn@latest add @assistant-ui/composer-trigger-popover`,
or the raw registry URL. Files land at `components/assistant-ui/elements/<name>.aui.tsx`.

**MEASURED — the dependency problem for brigadier.** I fetched the actual registry JSON:

```
GET https://r.assistant-ui.com/thread.json
  dependencies:         ['@assistant-ui/react', 'lucide-react']
  registryDependencies: ['button', 'skeleton', 'https://r.assistant-ui.com/attachment.json', …
                         reasoning.json, tool-fallback.json, tool-group.json, markdown-text.json, …]
GET https://r.assistant-ui.com/tool-group.json
  dependencies:         ['@assistant-ui/react', 'lucide-react', 'class-variance-authority', 'tw-shimmer']
  registryDependencies: ['collapsible']
```

and the source of `tool-group.aui.tsx` imports `{ Collapsible, CollapsibleContent, CollapsibleTrigger } from
"@/components/ui/collapsible"` and `cn` from `@/lib/utils`, with Tailwind classes throughout
(`rounded-lg border py-3`, `bg-muted/30`, `group/tool-group`).

So route A brings: **shadcn/ui base components** (`button`, `skeleton`, `collapsible`, `textarea`) — and shadcn's
Radix flavour of `collapsible` is `@radix-ui/react-collapsible`, an **individual `@radix-ui/react-*` package, which
CLAUDE.md bans**. Two escapes, both **MEASURED as available**: (a) use the `base-*` style flavour, whose
`collapsible` is Base UI (`@base-ui/react`) — the registry JSON for `styles/base-nova/tool-group.json` is otherwise
identical; or (b) hand-write the four shadcn shims against the `radix-ui` monolith yourself. Either way you also add
`lucide-react`, `class-variance-authority`, `tw-shimmer`, and shadcn's `--muted`/`--muted-foreground` token layer.

### 2.3 ExternalStoreRuntime — can it carry brigadier's row kinds?

Source: https://www.assistant-ui.com/docs/runtimes/custom/external-store.md and
https://www.assistant-ui.com/docs/primitives/message.md. **MEASURED.**

**Message part model** (message.md §"Part Types") — three kinds, and the table is explicit that only one grows:

| Kind | Parts | Grows by |
|---|---|---|
| Modality | `text`, `image`, `file` | Never |
| Provider channel | `reasoning`, `source`, `tool-call`, `generative-ui` | Never |
| **Extensibility** | **`data`** | **Freely, through `name`** |

> *"Anything that is not a modality the model consumes or a channel it emits is a `data` part, routed by `name`."*

```tsx
<MessagePrimitive.Parts components={{ data: { by_name: { citation: MyCitation }, Fallback: MyDataFallback } }} />
```

And `ThreadMessageLike.content` (external-store.md §API reference) *"Supports `data-*` prefixed types
(e.g. `{ type: "data-workflow", data: {...} }`) which are automatically converted to `DataMessagePart`."*

**Answers:**
- Custom message part types → **yes**, via `data` parts named by you. An approval card is
  `{ type: "data-approval", data: {...} }`; a subagent group, a command block, an expired-approval row likewise.
- Tool-call parts with results → **yes**. `onAddToolResult(options)` patches the matching `tool-call` part by
  `toolCallId`; *"The runtime automatically matches tool results to their tool calls by `toolCallId`."*
- Reasoning parts → **yes**, first-class `reasoning` part type.
- Multiple tool calls interleaved with text and reasoning in one message → **yes**; that is exactly what
  `MessagePrimitive.GroupedParts` + `groupPartByType` exist for
  (https://www.assistant-ui.com/docs/guides/chain-of-thought.md).
- Per-message metadata for duration/steps → **partly.** `ThreadMessageLike.metadata?: object` is documented as
  *"Additional message metadata (steps, custom fields)"* — so you can carry your own duration. There is also a
  first-party but **experimental** `useMessageTiming()` returning `totalStreamTime`, `tokensPerSecond`, TTFT
  (https://www.assistant-ui.com/docs/guides/message-timing.md, marked *"This feature is experimental. The
  `useMessageTiming()` API and the set of tracked fields may change"*), with a `message-timing` element.

**Also relevant to brigadier's approval semantics:** `isSendDisabled` blocks sending while keeping the input usable;
`onResumeToolCall({ toolCallId, payload })` is documented for *"resuming a suspended tool call (used with
human-in-the-loop tool execution)"*; the `approval-card` element's runtime path uses a tool call that
*"carries an `approval` object until the user answers"* with `respondToApproval`
(https://www.assistant-ui.com/elements/approval-card.md). That is the non-optimistic shape brigadier needs, though
the third "Expired" state is yours to add.

### 2.4 Thread primitives

Source: https://www.assistant-ui.com/docs/primitives/thread.md and
https://www.assistant-ui.com/docs/guides/virtualization.md. **MEASURED.**

- `ThreadPrimitive.Viewport` auto-scrolls to the bottom as content streams **unless the user scrolled up**;
  `autoScroll={false}` disables it. Three event-specific controls: `scrollToBottomOnRunStart` (default true),
  `scrollToBottomOnInitialize` (true), `scrollToBottomOnThreadSwitch` (true).
- `turnAnchor="top"` pins the user's message to the top with the response flowing below — the modern reading layout,
  and what the `Thread` element uses by default. `topAnchorMessageClamp={{ tallerThan, visibleHeight }}` clamps long
  user messages. `autoScroll` defaults to `true` for `turnAnchor="bottom"` and `false` for `"top"`.
- `ViewportFooter` sticks to the bottom and registers its height with the auto-scroll system — where the composer goes.
- `ThreadPrimitive.Messages` takes a **children render function** `({ message }) => …` (the `components` map by role
  is the older API; `MessageByIndex` and `Unstable_MessageById` take a `components` prop with `UserMessage`/
  `AssistantMessage`).
- **Virtualization: assistant-ui does not ship one.** Verbatim: *"assistant-ui does not ship a virtualized thread
  component; this guide shows the supported composition"* — `@tanstack/react-virtual`, `unstable_useThreadMessageIds`
  + `ThreadPrimitive.Unstable_MessageById`, padding spacers rather than absolute positioning, **and you must own the
  scroll element instead of using `ThreadPrimitive.Viewport`** (the built-in auto-scroll assumes every message is
  mounted and fights the virtualizer). Runnable example: `examples/with-virtualized-thread` in the monorepo. The
  guide's own advice is *"Do you need this? Probably not"* — the default kit uses `content-visibility: auto` +
  `contain-intrinsic-size`. Both `unstable_useThreadMessageIds` and `Unstable_MessageById` are flagged experimental.
- `MessagePrimitive.Parts` children render function exposes `part.toolUI` and `part.dataRendererUI`; resolution order
  is `tools.Override` → globally registered toolkit tools → `tools.by_name[toolName]` → `tools.Fallback` →
  `part.toolUI`. `tools.by_name` and `Fallback` live on the **deprecated** `components` prop; the non-deprecated path
  is registering `render` on a toolkit entry, or branching in the children function.

### 2.5 Codex-like / grouped-work-steps patterns

**MEASURED.**
- There is **no Codex clone**. The published clone examples are ChatGPT, Claude, Gemini, Grok, Perplexity
  (https://www.assistant-ui.com/examples.md).
- There **is** a first-party collapsible-work-steps stack, which is the same idea:
  - `MessagePrimitive.GroupedParts` + `groupPartByType({ reasoning: ["group-chainOfThought","group-reasoning"],
    "tool-call": ["group-chainOfThought","group-tool"] })` — nested groups, one collapsible "thinking" section
    (https://www.assistant-ui.com/docs/guides/chain-of-thought.md).
  - `ChainOfThoughtPrimitive` (https://www.assistant-ui.com/docs/primitives/chain-of-thought.md) — legacy but present.
  - `tool-group` element: *"A collapsible runtime wrapper around consecutive tool calls in one assistant turn"*,
    label "3 tool calls" / "1 tool call", spinner while any is running, staggered fade-in, scroll-lock during the
    height change, `variant: outline | ghost | muted`, controlled or uncontrolled
    (https://www.assistant-ui.com/elements/tool-group.md).
  - `tool-timeline`: *"A whole working session summarized as verbs, targets, and file stats."*
  - Grouping is arbitrary: `groupBy` is any function returning group keys, including from `part.metadata`
    (https://www.assistant-ui.com/docs/guides/part-grouping.md §"Group by Custom Metadata"), plus
    `Unstable_PartsGroupedByParentId` for subagent trees.
- **Closest prior art in the ecosystem:** `@assistant-ui/react-opencode`
  (https://www.assistant-ui.com/docs/runtimes/opencode/overview.md) — a runtime for the OpenCode *coding agent*,
  layered on ExternalStoreRuntime + RemoteThreadList, with first-class permission/question flows and **sub-agent
  conversations** projected into `ToolCallMessagePart.messages`, rendered with `MessagePartPrimitive.Messages`.
  It is at **v0.0.3 and flagged experimental**. Not directly usable (brigadier speaks the Claude Code CLI protocol),
  but it proves the part model carries a coding agent's shapes, and is worth reading before designing the store.

---

## Part 3 — Verdict

### Route A — assistant-ui primitives + elements/design library, restyled to Codex

| | |
|---|---|
| **Free** | Runtime already wired (you have 0.15.18). `Thread`, `thread-list`, `thread-list-sidebar`, `message-pair`, `message-actions`, `message-branches`, `composer` + attachments/mentions/slash/model-picker, `reasoning`, `tool-call`/`tool-fallback`/`tool-group`/`tool-error`/`tool-timeline`, `approval-card`, `permission-grant`, `terminal-block`, `code-diff`, `reviewable-diff`, `file-tree`, `subagent-list`, `agent-plan`, `agent-status`, `todo-list`, `context-display`/`context-breakdown`/`quota-banner`, `scroll-anchor`, `stopped-run`, `empty-state`, `error-state`, `markdown-text`, `shiki-highlighter`, `mermaid-diagram`, plus 30 generic design components incl. `diff-viewer` and `code-block`. Auto-scroll, `turnAnchor="top"`, grouping, branching, a11y. |
| **Hand-built** | **All of the Codex look.** Every element is shadcn-token-styled generic-AI-chat; nothing is Codex-shaped. You would restyle ~25 elements against a Codex token set you derive yourself. Also: the Codex turn-summary ("Working for 1m 15s ▾" collapsing the turn's activity), the command block's tail-following long output, the Expired approval third state, the file-review workspace pane. |
| **Licence** | Apache-2.0/MIT-class OSS you already depend on; copy-paste source is yours after `add`. **Not checked:** assistant-ui's exact registry licence text. |
| **New deps** | `lucide-react`, `class-variance-authority`, `tw-shimmer`, shadcn `button`/`skeleton`/`collapsible`/`textarea` shims + `@/lib/utils` `cn` + shadcn token layer. **Radix flavour pulls individual `@radix-ui/react-*` — banned.** Use the `base-*` flavour (`@base-ui/react`) or write the four shims against the `radix-ui` monolith. |
| **Maintenance** | Low. Active first-party project, weekly releases, versioned migrations, deprecation policy, codemods, docs MCP endpoint. |
| **Fidelity to Codex** | **Low out of the box; whatever you invest thereafter.** ~35–55% after a serious styling pass, per my read of the element anatomies vs. the Codex baselines. Unmeasured estimate. |

### Route B — assistant-ui primitives + codex-ui-kit components

| | |
|---|---|
| **Free** | The Codex look itself, at a fidelity nobody else has: 11.5k lines of thread components, 399 design tokens, 432 pixel baselines, light/dark/compact/reduced-motion, a11y-gated. Approval card with Deny[Esc]/Allow once[⏎], command execution with duration and tail, file-change/diff/review surfaces, subagent timeline + nested transcript, turn duration, activity timeline, thread summary panel, composer dock. Zero Tailwind conflict, zero Radix conflict. |
| **Hand-built** | **All of the wiring.** codex-ui-kit is protocol-neutral props only — it has no runtime, no store, no message model. You write the entire adapter from brigadier's feed store / assistant-ui parts to these props, and the render loop `AgentThreadViewport` does not give you. You must also pick one markdown stack and one composer (its `<textarea>` vs `react-lexical`), and either drop the 566 KB stylesheet on the paint budget or extract the subset you use. Virtualization is a placeholder div and nothing else. |
| **Licence** | MIT — keep `LICENSE` + copyright notice. Plus the unaffiliated-with-OpenAI notice, no OpenAI brand assets, and OpenAI Sans only if you license it. **Trade-dress question is real and unresolved.** |
| **New deps** | `highlight.js`, `react-markdown@10`, `remark-gfm` (+ `katex`, `rehype-katex`, `remark-math` if you keep math) — **overlapping** `@assistant-ui/react-markdown`. Or vendor only the components you need and cut the markdown path. |
| **Maintenance** | **High.** Bus factor 1, 0 stars, 2 months old, unpublished, pre-1.0 API explicitly allowed to break. Vendoring means you own it: pin a commit and expect to maintain the fork. |
| **Fidelity to Codex** | **High immediately.** 70–85% on the thread surface, by direct comparison of the committed baselines against the Codex Desktop shapes they document. Unmeasured estimate; I did not diff against a real Codex install. |

### Recommendation

**Route B, vendored — but only the thread subset, and only pending acceptance of the trade-dress and
bus-factor risks below.** The two routes are not competing for the same job. assistant-ui is the *runtime*, and brigadier already has
it at the current version with a part model (`data` parts by name, `GroupedParts` by arbitrary key, tool parts with
results, reasoning parts, message metadata) that carries every row kind brigadier needs — none of that is in question
and none of it should be replaced. What is in question is the *pixels*, and there assistant-ui's elements give you a
generic AI-chat look you would spend weeks pushing toward Codex, while codex-ui-kit already contains the answer,
measured against 17 fingerprinted Codex Desktop builds and locked with 432 pixel baselines, under MIT, with no
Tailwind and no Radix to fight. The honest shape of the work is: keep assistant-ui's runtime and primitives, copy
codex-ui-kit's *thread* components (`AgentThread`, `AgentMessage`, `AgentActivity`, `ActivityTimeline`,
`ToolCallCard`, `CommandExecution`, `ApprovalRequest`, `FileChange`, `SubagentActivity`, `AgentReasoning`,
`TurnDuration`, `ThreadState`, `Notices` — about 11.5k lines) plus the `--codex-ui-*` token layer, drop the 18.5k
lines of app chrome and settings, drop its composer in favour of the existing lexical one, drop its markdown stack in
favour of `@assistant-ui/react-markdown`, and render those leaves from `MessagePrimitive.Parts` / `GroupedParts`
instead of from `AgentThreadViewport`. That leaves the CSS: extract only the rules the kept components use, because
importing all 566 KB against a 287–295 ms first-contentful-paint budget is the one thing in this plan that could
fail outright, and I did not measure it.

### Three open questions

1. **Trade dress.** MIT covers the code. It does not cover shipping a product whose thread is a pixel-level replica of
   OpenAI Codex Desktop, with a token layer named `--codex-ui-*` and a font token naming OpenAI Sans. Is "looks
   exactly like Codex" the actual goal, or is it "looks as considered as Codex"? Those buy very different plans.
2. **Fork ownership.** codex-ui-kit is one person, two months old, zero users, unpublished, pre-1.0 and explicitly
   allowed to break. Vendoring is a permanent fork. Is brigadier willing to own ~11.5k lines of someone else's CSS-heavy
   React, or does it want a dependency it can `npm update`?
3. **The paint budget.** 566 KB of stylesheet against a 287–295 ms p50 exec→FCP gate. Either someone measures the
   subset extraction before committing to route B, or the budget gets renegotiated. This is the one item that can
   kill the plan on evidence rather than judgement, and it is unmeasured today.

---

## What I did not check

- Did not run codex-ui-kit's demo, tests, build, or any of its six `check:*` gates; did not install its dependencies.
- Did not measure bundle size, CSS-subset size, or paint impact of `styles.css` under brigadier's burn harness.
- Did not diff a codex-ui-kit baseline against a real Codex Desktop install; the fidelity read is from committed
  baseline PNGs (2 of 432 viewed directly) plus the author's documentation.
- Did not verify `inert`, `color-mix()` or `@container` support in the WKWebView versions brigadier targets.
- Did not read `AgentMarkdown.tsx`, `ApprovalRequest.tsx`, `SubagentActivity.tsx` or `FileChange.tsx` in full — only
  their exported shapes and line kinds.
- Did not trace where `rehype-katex` / `remark-math` are wired in codex-ui-kit.
- Did not confirm whether `FileChange`/`FileDiff` parses unified-diff text or requires pre-parsed hunks.
- Did not read assistant-ui's registry licence text, `docs/api-reference/primitives/thread.md`, the OpenCode
  quickstart/hooks pages, or `examples/with-virtualized-thread` source.
- Did not verify shadcn's Base UI `collapsible` package name by fetching it (inferred from
  `npm install @assistant-ui/react @base-ui/react class-variance-authority` in the mentions guide).
- The npmjs.com website returned HTTP 403 to WebFetch; all version data came from `registry.npmjs.org` instead.
- jaminzhou.com/codex-ui-kit/ is a JS SPA and returned only a title to WebFetch; I did not render it.

## See also

- `codex-thread-tokens.md` — the authoritative pixel values when this file's `codex-ui-kit` reading disagrees
  with the shipped Codex Desktop bundle (§12 of that file).
- `codex-thread-anatomy.md` — the `codex app-server` protocol structure and row taxonomy, which neither
  library here encodes.
- `codex-thread-row-mapping.md` — the row-by-row build plan that uses this comparison to pick a component
  (assistant-ui, codex-ui-kit, both, or neither) for each of Codex's 18 row kinds, including a real vendoring
  run with byte counts.
