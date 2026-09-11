# Codex desktop **conversation thread** — exact design tokens (dark theme)

Measured design tokens for Codex Desktop's conversation timeline (dark theme only), read directly out of
the shipping Electron app's bundled CSS/JS. Gathered 2026-09-10. Method: read-only static analysis of the
app bundle — the app was never launched, no screenshots were taken, and no computed styles were read; every
value traces to a grep-able line in the (beautified, session-local) extracted bundle source. Nothing in
`/Applications` and nothing in `brigadier-ai` / `brigadier-ai.worktrees` was modified.

**Authority.** This file is authoritative for Codex Desktop `26.903.61454`'s actual pixel values, colours,
spacing, radii, type scale and motion timing on the conversation thread — every row marked **M** (measured)
below is a direct read of shipped source, not an inference. Where this file disagrees with `codex-ui-kit.md`
(an independent, runtime-observed replica of the same app), **this file is authoritative**: its newest
recorded build observation is `26.901.51231`, older than the `26.903.61454` bundle read here; §12 below is
the full disagreement table. This file is NOT authoritative for the `codex app-server` protocol's data model
or the reference client's behaviour — see `codex-thread-anatomy.md` for that — nor for which brigadier
component should be built from these tokens — see `codex-thread-row-mapping.md`.

**Target:** the Codex surface inside `/Applications/ChatGPT.app` —
`app/package.json` `name: "openai-codex-electron"`, `productName: "Codex"`, `version: 26.903.61454` (**M**,
`app/package.json`).

**Scope:** the timeline only — user message, assistant answer, "Worked for N" turn header, activity /
exploration groups, command rows, file-change card, approval card, reasoning/thinking, subagent rows,
queued/steer strip, notices, motion, and the colour ramp behind all of it. The sidebar is covered by the
sibling document `docs/research/codex-sidebar.md` and is not repeated here except where a token is shared.

---

## 0. Method, citations, and how to reproduce

The extraction behind this file unpacked the Electron app's `asar` archive and beautified the renderer
bundles with `npx --yes prettier@3 --parser babel|css <file>`, then grepped the beautified tree for the DOM
hooks the app itself uses (e.g. `grep -rl 'data-content-search-turn-key' app/webview/assets/`) to find the
lazily-loaded chunks that carry the live Codex timeline (it is not in the two top-level renderer bundles —
those hold only shell/chrome). The two top-level bundles are `app-initial.{css,js}` and
`app-primary.{css,js}`; the thread-specific chunks found by grep include (bundle-relative names under
`webview/assets/`, sizes at extraction time): `local-conversation-thread-*.js` (353 KB → 23,210 lines),
`local-conversation-turn-*.js` (47 KB → 3,216 lines), `local-conversation-thread-turn-entries-*.js`,
`local-conversation-page-*.js`, `subagent-activity-chip-group-*.js` (30,046 lines — despite the name, this
chunk carries the user bubble, activity rows, file-change card, patch summary, compaction notice and
subagent chips) with its CSS module `subagent-activity-chip-group-*.css` (the user-bubble styles),
`thread-scroll-layout-*.js`/`.css`, `agent-activity-item-*.js`, `queued-message-list-*.js`,
`thread-virtualizer-*.js`, `conversation-markdown-*.js`, `code-diff-*.js`, `notice-*.js`,
`chatgpt-code-block-*.js`, and `thread-app-shell-chrome-*.js`/`.css`.

The beautified copies (both the two top-level bundles and the thread-specific chunks) were written to a
session-local scratchpad directory that does not persist; they are not part of this repository. **Citation
form below is `pretty/<file>:<line>`**, where `<file>` is one of the beautified copies named above — this
citation form is kept because it is grep-able against a fresh extraction of the same app version
(`openai-codex-electron` `26.903.61454`) done the same way: unpack the `asar`, beautify with the prettier
command above, and the line numbers should match exactly for an unchanged build. Bundle-relative paths (as
opposed to `pretty/`-prefixed citations) are given as `webview/assets/<name>`. A sibling extraction of the
sidebar-only bundles exists at `docs/research/codex-sidebar.md` §0, covering the same app version; some
values below (§9.2) were cross-checked against that extraction's re-implementation of the theme-generator
functions rather than re-derived from scratch.

**Marking.** Every row is **M** (measured — read out of the shipped CSS/JS, with a grep-able citation) or
**I** (inferred — arithmetic or reasoning on top of measured values). Nothing is a guess dressed as a fact.
No screenshots were taken and the app was never launched; this is a static read.

**The palette warning from the sidebar doc applies here too.** The `.electron-dark` stylesheet block is a
fallback; at runtime Codex computes the whole `--color-*` palette in JS from a four-field seed and writes it
as inline custom properties on `<html>` (`zY(documentElement, tokens)`, `pretty/app-initial.js:345661`;
class toggle `e.classList.toggle('electron-dark', …)` at `:345735`, so **both** are present and the inline
ones win for the names the generator writes). §9 lists which names the generator writes and which fall
through to the stylesheet.

---

## 1. The thread column: width, padding, rhythm

| Property | Value | Source | M/I |
|---|---|---|---|
| Content column | `mx-auto w-full max-w-(--thread-content-max-width) browser:max-w-(--thread-body-max-width) px-toolbar` | `pretty/app-primary.js:339172–339176` (`v3 = X(…, Yyr)`, `Yyr = 'px-toolbar'`) | M |
| `--thread-content-max-width` (electron) | **48rem = 768px** | `pretty/app-initial.css:34930` (inside `:is([browser],[chrome-extension],[electron]) body`) | M |
| `--padding-toolbar` | `calc(var(--spacing) * 4)` = **16px** (`--spacing: 0.25rem`) | `pretty/app-initial.css:35110`, `:2057` | M |
| ⇒ horizontal padding | **16px each side**, column capped at 768px, centred | derived | I |
| Scroll container | `thread-scroll-container overflow-x-hidden overflow-y-auto [overflow-anchor:none] [scroll-padding-bottom:var(--thread-scroll-padding-bottom,0px)] [container-name:thread-content] [container-type:inline-size]` + `h-full electron:[scrollbar-gutter:stable_both-edges] pt-(--thread-content-top-inset) [--thread-sticky-header-top:calc(var(--spacing)*8)] flex flex-col-reverse` | `pretty/thread-scroll-layout-74b7b284e43f.js:975–986` | M |
| Scroll direction | `flex flex-col-reverse` — the timeline is **bottom-anchored by layout**, not by scripted scrolling | same | M |
| Content wrapper | `relative flex flex-1 shrink-0 flex-col` + the width class above + `pb-8 has-[[data-compact-status-slot-clearance]]:pb-0` → **32px bottom pad** | `pretty/thread-scroll-layout-74b7b284e43f.js:996–1002` | M |
| Scroll marker for the timeline | attribute `data-app-action-timeline-scroll` | `pretty/app-initial.js:139227`, `:139245` | M |
| Turn element | `<div class="contents" data-content-search-turn-key=…>` — **`display: contents`**, so a turn adds no box and no gap of its own | `pretty/local-conversation-thread-b5c1b90153e1.js:17341–17343` | M |
| Vertical rhythm **inside** a turn | explicit spacer divs, not `gap`: `<div aria-hidden class="w-full" style="height: var(--conversation-item-gap, 16px)">`, or `var(--conversation-grouped-item-gap, 4px)` for a grouped run | `pretty/app-initial.js:328392–328410` (`Rca`) | M |
| `--conversation-item-gap` / `--conversation-grouped-item-gap` | **16px / 4px** | `pretty/app-initial.css:35139–35140` | M |
| Item wrapper (`Hca`) | `flex flex-col` + default `gap-2 pt-2 pb-1`; grouped `gap-[var(--conversation-grouped-item-gap,4px)] pt-1`; indented `ps-6` (**24px**) | `pretty/app-initial.js:328434–328440` | M |
| Bubble/row container (`tca`) | `min-w-0 text-size-chat py-0`; `padding="offset"` variant adds `relative overflow-visible py-0` | `pretty/app-initial.js:328366–328380` | M |
| Between assistant sub-blocks | `flex flex-col gap-3` (12px) is the recurring grouping class in the turn body | `pretty/local-conversation-turn-d75f99f4366a.js:2108, 2124, 2360, 2411` | M |
| Turn-to-turn gap | per-entry `gapBeforePx`, falling back to a `gapPx` prop passed to the virtualiser | `pretty/thread-virtualizer-4f61d89b50be.js:5, 17` | M — **the concrete default `gapPx` for the local Codex thread was not located** (see §12) |
| Probe element that fixes the max column width for wide blocks | `._Probe_3b6sy_1 { max-width: calc(max(var(--thread-content-max-width), var(--markdown-wide-block-max-width) + 8rem) + var(--padding-toolbar)*2); height:0; visibility:hidden; margin-inline:auto }` | `pretty/thread-scroll-layout-26a32b412ec3.css:2–15` | M |
| `--markdown-wide-block-max-width` | 56rem (electron body) / 64rem (`:root` default) | `pretty/app-initial.css:34936`, `:2742` | M |

---

## 2. Type scale for the thread

The whole timeline is sized off **one** variable, `--codex-chat-font-size`, which the user can change from
settings.

| Token | Chain | Electron dark value | Source | M/I |
|---|---|---|---|---|
| `--codex-chat-font-size` | `var(--vscode-chat-font-size, var(--vscode-font-size, 13px))` → `--vscode-chat-font-size: var(--vscode-font-size)` → `var(--text-base)` | **14px** | `pretty/app-initial.css:35131–35134`, `:34944–34946`, `:2072` | M |
| `--codex-chat-code-font-size` | `var(--vscode-chat-editor-font-size, var(--vscode-editor-font-size, 12px))` → `var(--text-sm)`, and `--text-sm` is overridden to 13px for electron | **13px** | `:35135–35138`, `:34945`, `:34911` | M |
| user override | main→renderer message `chat-font-settings` writes `--vscode-chat-font-size` / `--vscode-chat-editor-font-size` inline on `<html>` as `${px}px` | — | `pretty/app-initial.js:471021–471030` | M |
| `.text-size-chat` | `font-size: var(--codex-chat-font-size)` | 14px | `pretty/app-initial.css:14916` | M |
| `.text-size-chat-sm` | `calc(var(--codex-chat-font-size) - 1px)` | 13px | `:14919` | M |
| `.text-size-code` | `var(--codex-chat-code-font-size)` | 13px | `:14922` | M |
| `.text-size-code-sm` | `calc(… - 1px)` | 12px | `:14925` | M |
| chat line-height utility | `.leading-[calc(var(--codex-chat-font-size)_+_8px)]` | **22px** | `:15048–15050` | M |
| `--diffs-font-size` / `-line-height` | `var(--vscode-editor-font-size, 12px)` / `calc(var(--diffs-font-size,12px) * 1.8)` | **13px / 23.4px** | `:35142–35143` | M |
| `--diffs-font-family` | `var(--font-mono)` | `ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` | `:35141`, `:34940–34942` | M |
| body font | `font-family: var(--vscode-font-family)` (= `inherit` in electron ⇒ `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`), `font-weight: var(--vscode-font-weight)` = **430** | | `:35181–35183`, `:33613`, `:34913` | M |
| `--text-xs / -sm / -base / -lg` (electron) | 12 / **13** / 14 / 16px | `:34912`, `:34911`, `:2072`, `:2074` | M |
| `--leading-snug/-normal/-relaxed` | 1.375 / 1.5 / **1.625** | `:2095–2097` | M |
| icon sizes | `icon-3xs` 10 · `icon-xxs` 12 · `icon-2xs` **14** (`--icon-secondary-size`) · `icon-xs` **16** (`--icon-size`) · `icon-sm` 18 · `icon-base` 20 · `icon-md` 24 · `icon-lg` 28 | `:1724–1754` | M |

### Radii (electron, `corner-shape: superellipse(1.5)` branch taken)

`--radius-*-base` sm .375rem · md .5rem · lg .625rem · xl .75rem · 2xl 1rem · 3xl 1.25rem · 4xl 1.5rem
(`pretty/app-initial.css:2688–2694`, **M**). Under `@supports (corner-shape: superellipse(1.5))` the root
sets `--corner-radius-scale: 1.25` and multiplies md…4xl (`:35155–35166`, **M**), and
`.rounded-md/.rounded-lg/.rounded-xl/.rounded-2xl/.rounded-3xl/.rounded-4xl` all take
`corner-shape: var(--codex-corner-shape)` (`:35171–35178`, **M**).

⇒ effective: **md 10px · lg 12.5px · xl 15px · 2xl 20px · 3xl 25px · 4xl 30px**, drawn as squircles; `sm`
stays **6px** (it is *not* in the scaled list) (**I**, arithmetic certain, `@supports` gate reasoned — Electron 42
ships Chromium ≳144 and `corner-shape` landed in Chrome 139).

Note `[data-codex-window-type="browser"]` overrides the *bases* (sm .25 · md .375 · lg .5 · 3xl 1.5 · 4xl 2rem,
`:34904–34908`) and sets scale back to 1 — those are **browser** values, not desktop ones (**M**, enclosing
selector verified programmatically).

---

## 3. User message

### 3.1 Bubble

The bubble class string, verbatim (`pretty/subagent-activity-chip-group-2a2be347c052.js:2167–2174`) — **M**:

```
bg-user-message text-user-message max-w-(--user-chat-width) min-w-0 overflow-hidden break-words
px-(--thread-content-margin) [&_.contain-inline-size]:[contain:initial]
+ Zg.bubble
+ (compact ? Zg.compactMessageBubble : —)
+ (compact ? py-2 : py-2.5)
+ (temporary ? Zg.temporaryBubble : rounded-2xl)
+ (!hasContent ? leading-none : —)
```
rendered as `<div data-user-message-bubble class="… relative text-start [cursor-interaction]" onDoubleClick=edit>`
(`:2237–2246`).

`Zg.bubble` = `._bubble_11ymf_1` (`pretty/subagent-activity-chip-group-48f5d9abd486.css:2–6`) — **M**:

```css
._bubble_11ymf_1 {
  --user-chat-width: 70%;
  --radius-2xl: calc(var(--spacing) * 5.5);   /* 22px, shadows the global 20px */
  --thread-content-margin: calc(var(--spacing) * 4);   /* 16px */
}
```

| Property | Value | Source | M/I |
|---|---|---|---|
| Alignment | **right** — outer row is `group flex w-full flex-col items-end justify-end gap-1`, bubble row `relative mb-2 flex w-full justify-end` | `pretty/subagent-activity-chip-group-2a2be347c052.js:2562`, `:2331` | M |
| Max width | **70%** of the column | CSS module above | M |
| Background | `--color-background-user-message` = `color-mix(in oklab, var(--color-text) 5%, transparent)` ⇒ **`#dfdfdf` @ 5%** in dark | `pretty/app-initial.css:2404–2413`; runtime writes the same string, `pretty/app-initial.js:345787` | M |
| Text colour | `--color-text-user-message` = `var(--color-text)` = **`#dfdfdf`** | `pretty/app-initial.css:2260`; runtime `pretty/app-initial.js:345788` | M |
| Radius | `rounded-2xl` with the local `--radius-2xl: 22px` and `corner-shape: superellipse(1.5)` ⇒ **22px squircle** | CSS module + `:35171–35178` | M (values) / I (squircle gate) |
| Padding | `px-(--thread-content-margin)` **16px**, `py-2.5` **10px** (compact: 12px / 8px) | class string + CSS module | M |
| Font | `text-size-chat` inherited from `tca` ⇒ 14px; markdown line-height 22.75px (`14 × 1.625`) | §2, §4 | I |
| Temporary (unsent) variant | `._temporaryBubble_11ymf_33 { border-radius: var(--radius-2xl); corner-shape: round }` + an absolutely-positioned SVG `<rect>` outline, `stroke-opacity .4`, `stroke-width 1`, `stroke-dasharray "8 8"`, `vector-effect: non-scaling-stroke`, corner radius `calc(min(var(--radius-2xl), 50cqmin) - 0.5px)` | CSS module `:33–46`; JS `:2247–2266` | M |
| Compact (quick-chat) variant | `--user-chat-width: min(456px, 100%)`, `--radius-2xl: 16px`, `--thread-content-margin: 12px`, `corner-shape: superellipse(1)`, `width: fit-content`; its markdown gets `--markdown-line-height: calc(var(--markdown-font-size) + 6px)` and `letter-spacing: -0.01em` | CSS module `:7–31` | M |
| Empty message | `<div class="mb-px text-size-chat text-codex-description">(No content)</div>` | JS `:2130–2137` | M |
| Long message collapse | wrapped in the collapsible (§8): default cap **20 lines**, ellipsis `…` | `pretty/app-initial.js:326213–326215` | M |

### 3.2 Hover / action rail under the bubble

| Property | Value | Source | M/I |
|---|---|---|---|
| Chip row | `flex flex-row-reverse items-center gap-1`, hidden (`hidden`) unless there is something to show | `pretty/subagent-activity-chip-group-2a2be347c052.js:2513` | M |
| Chip style | `text-codex-description text-xs` (12px) | `:2585` | M |
| Chips | "References prior conversation", "Review mode", "PR fix", "Auto resolve conflicts", "{n} comments" | `:2392–2455` | M |
| Action group | `me-1 ms-1 flex items-center gap-2` + `opacity-0 group-focus-within:opacity-100 group-hover:opacity-100` | `:2470–2476` | M |
| Buttons | `flex turn-action-controls items-center gap-0.5`; icons `icon-xs` (16px); Button `color="ghost" size="icon"` | `:2493–2512` | M |
| `size="icon"` resolved | `electron:p-1 electron:[&>svg]:icon-sm flex items-center justify-center p-0.5` — 4px pad, 18px icon in Electron | `pretty/app-initial.js:215868` | M |
| Copy affordance | `Copy message` → `Copied` aria-label swap, check icon replaces copy icon | `:2178–2205` | M |
| Reaction badge | `relative flex size-7 items-center justify-center rounded-full border-2 border-surface`, anchored `absolute -end-0.5 -bottom-0.5 translate-x-1/4 translate-y-1/4` | `:2302–2325` | M |

---

## 4. Assistant answer (markdown)

Root element: `<div dir="auto" data-markdown-text-style data-markdown-text-tone class="_MarkdownRoot_15pu8_178 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">`
(`pretty/app-initial.js:336170–336181`, **M**).

Local variables (`pretty/app-initial.css:654–678`) — **M**:

```css
._MarkdownRoot_15pu8_178 {
  --markdown-host-font-size:       var(--codex-chat-font-size);        /* 14px */
  --markdown-host-small-font-size: var(--codex-chat-code-font-size);   /* 13px */
  --markdown-font-size:            var(--markdown-host-font-size);
  --markdown-line-height:          calc(var(--markdown-font-size) * var(--leading-relaxed));  /* 14 × 1.625 = 22.75px */
  --markdown-small-font-size:      max(var(--markdown-host-small-font-size), calc(var(--markdown-font-size) * 0.875));  /* max(13, 12.25) = 13px */
  --markdown-space:                calc(var(--markdown-font-size) / 4);   /* 3.5px */
  --text-primary:  currentColor;
  --border-medium: var(--color-border-strong);
  --border-light:  var(--color-border-subtle);
  color: var(--color-text);
  font-size: var(--markdown-font-size);
  line-height: var(--markdown-line-height);
  overflow-wrap: anywhere;
}
```

`--markdown-space` = **3.5px** is the unit the whole markdown rhythm is built on (**I**, arithmetic).

### 4.1 Block rhythm (all **M**, `pretty/app-initial.css:465–650`, `:867`)

| Rule | Value | Resolved @14px |
|---|---|---|
| `._Paragraph_` | `margin: 0 0 var(--markdown-space)` | 0 0 3.5px |
| `MarkdownRoot > p:not(:first-child)` | `margin-top: calc(--markdown-space * 2)` | 7px |
| `MarkdownRoot > p + p` | `margin-block: calc(--markdown-space * 4)` | **14px** |
| `p + ul/ol` | `margin-top: 0` | 0 |
| `ul/ol + heading` | `margin-top: calc(--markdown-space * 4)` | 14px |
| `._List_` | `margin: 0; padding-inline-start: var(--markdown-line-height)` | 22.75px indent |
| `._ListItem_` | `padding-inline-start: calc(--markdown-space * 1.5)` | 5.25px |
| `li > p + p` | `margin-top: calc(--markdown-space * 4)` | 14px |
| `li::marker` | `color: var(--text-primary)` (= currentColor), `font-weight: var(--font-weight-semibold)` (600) | |
| nested list markers | disc → circle → square | |
| `._Blockquote_` | `padding-inline-start: calc(--markdown-space * 6)` (21px), `padding-block: calc(*2)` (7px), `line-height: calc(*6)` (21px), transparent background, `::after` rail `width: var(--markdown-space)` (3.5px), `border-radius: calc(/2)`, `background: var(--border-medium)` | |
| `._HorizontalRule_` | `margin: calc(--markdown-space * 7) 0` (24.5px), `border-top: 1px solid var(--border-medium)` | |
| `._CodeBlock_` | `margin-block: calc(--markdown-space * 5)` | **17.5px** |
| `._MermaidBlock_` | `margin-block: calc(--markdown-space * 2)` | 7px |

### 4.2 Heading scale (**M**, `:488–518`)

`._Heading_ { font-weight: var(--font-weight-semibold) }` = 600.

| | font-size | line-height | margin |
|---|---|---|---|
| h1 | `--markdown-font-size × 1.5` = **21px** | `--markdown-space × 8` = 28px | `0 0 calc(space*2)` = 0 0 7px |
| h2 | `× 1.25` = **17.5px** | `× 7` = 24.5px | `calc(space*4) 0 space` = 14px 0 3.5px |
| h3 | `× 1.125` = **15.75px** | `× 7` = 24.5px | 14px 0 3.5px |
| h4 | `× 1` = 14px | `× 6` = 21px | `calc(space*4) 0 0` = 14px 0 0 |
| h5, h6 | 14px | `--markdown-line-height` = 22.75px | 0 |

`h4 + p { margin-top: 0 }` (**M**, `:508–510`).

### 4.3 Inline code (**M**, `pretty/app-initial.css:4887–4908`; element at `pretty/app-initial.js:343141–343146`, `<span class="inline-markdown" data-markdown-copy="inline-code">`)

```css
.inline-markdown {
  box-decoration-break: clone;
  background: color-mix(in srgb, var(--color-background-primary-ghost-hover) 60%, var(--color-text) 6%);
  border-radius: 6px;
  display: inline;
  font-family: var(--font-mono);
  overflow-wrap: anywhere; word-break: break-word;
  padding: 1px 6px;
  font-size: 0.92em;                      /* 12.88px at 14px */
}
```
Fallback when `color-mix` is unsupported: flat `var(--color-background-primary-ghost-hover)`.
Dark: `--color-background-primary-ghost-hover` = `rgba(255,255,255,0.078)` (§9), so the chip is that at 60%
plus `#dfdfdf` at 6% — a barely-lifted grey (**I**, arithmetic on measured tokens).

### 4.4 Fenced code block (**M**)

Root (`pretty/app-initial.js:329777–329784`, classes assembled at `:329660–329676`):

```
relative
w-full min-w-0 overflow-clip contain-inline-size        (variant "default")
rounded-(--radius-3xl-base) border border-subtle bg-secondary-soft-alpha
eua.Surface                                              → ._Surface_1f1nx_1 { corner-shape: superellipse(1.1) }
data-theme="dark"|"light"
```

| Part | Value | Source | M/I |
|---|---|---|---|
| Radius | `--radius-3xl-base` = **1.25rem = 20px**, *unscaled* (the class uses the `-base` token directly) with `corner-shape: superellipse(1.1)` | `pretty/app-initial.js:329664`; `pretty/app-initial.css:361–363`, `:2693` | M |
| Border | `border-subtle` = `--color-border-subtle` = `--color-border-light` = `rgba(255,255,255,0.042)` | §9 | M |
| Background | `bg-secondary-soft-alpha` = `--color-background-secondary-soft-alpha` → `--vscode-textCodeBlock-background` → `--color-background-button-secondary` = **`rgba(255,255,255,0.052)`** | `pretty/app-initial.css:2448–2450`, `:33634`; value §9 | M |
| Header bar | `flex items-center font-sans text-sm select-none min-h-12 gap-2 py-1.5 ps-4 pe-1.5 font-medium text-default md:ps-5` | `pretty/app-initial.js:329826–329829`, `:329849–329852` | M |
| Sticky header | `._StickyActionBar_1f1nx_10 { top: calc(-1px - var(--thread-sticky-header-top,0px)); background-color: var(--color-surface); background-image: linear-gradient(var(--color-background-secondary-soft-alpha), …) }` | `pretty/app-initial.css:367–374` | M |
| `--thread-sticky-header-top` (electron) | `calc(var(--spacing)*8)` = **32px** | `pretty/thread-scroll-layout-74b7b284e43f.js:977` | M |
| Code pane padding | `p-4 md:px-5` (16px, 20px inline ≥768px); with a title bar: `px-4 pt-0 pb-3 md:px-5` | `pretty/app-initial.js:329743` | M |
| `<code>` | `block text-size-code` (13px) + `._CodeContent_1f1nx_6 { line-height: max(1.5em, calc(var(--spacing)*5)) }` = max(19.5px, 20px) = **20px** | `pretty/app-initial.js:329747–329752`; `pretty/app-initial.css:364–366` | M |
| Wrap | `whitespace-pre!` normally, `whitespace-pre-wrap!` when wrapping is forced | `pretty/app-initial.js:329880` | M |
| Placeholder (streaming) | `._CodeBlockPlaceholder_15pu8_593 { border-radius: var(--radius-3xl-base); background: var(--color-background-secondary-soft-alpha); padding: calc(--markdown-space * 4) (14px); font-size: var(--markdown-small-font-size) (13px); line-height: calc(--markdown-space * 5) (17.5px); overflow-x:auto }` | `pretty/app-initial.css:874–881` | M |
| Preview variant | `group/code-snippet rounded-lg border border-default bg-transparent`, pane `max-h-[calc(15lh+var(--spacing)*4)]` | `pretty/app-initial.js:329662`, `:329745` | M |

### 4.5 Tables (**M**, `pretty/app-initial.css:734–870`)

`font-size: var(--markdown-small-font-size)` (13px); wrapper bleeds `var(--thread-content-margin, 24px)` into
the gutters; header cell `border-bottom: 1px solid var(--border-medium)`, `padding-block: calc(space*2)` (7px),
`line-height: calc(space*4)` (14px), weight 600; body cell `padding-block: calc(space*2.5)` (8.75px), row
separator `1px solid var(--border-light)`; column min/max widths are fractions of
`--thread-content-max-width` in 24ths (sm 4–6, md 6–8, lg 8–12, xl 14–18).

### 4.6 Assistant action row

`mt-1.5 flex turn-action-controls h-5 items-center justify-start gap-0.5 browser:-ms-0.5 browser:mt-3 electron:-translate-x-1 extension:-translate-x-1.5 [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-ring [&_button]:focus-visible:ring-offset-0`
(`pretty/subagent-activity-chip-group-2a2be347c052.js:7839`, **M**) — 6px top margin, 20px tall, 2px gaps,
shifted 4px left in Electron. Trailing meta: `ms-1.5 flex h-full items-center gap-1.5 text-xs leading-5 text-tertiary`
with a `h-3 border-s border-default` separator (`:7855–7868`, **M**). The `.turn-action-controls` CSS rules at
`pretty/app-initial.css:5055–5080` are scoped `:where([data-codex-window-type="browser"] …)` and therefore
**do not apply in the desktop app** (**M**).

---

## 5. Turn header — "Working for …" / "Worked for …" / "You stopped after …"

### 5.1 The label

```js
<span class="text-text/60 tabular-nums">{label}</span>
```
`pretty/app-initial.js:327616–327618` — **M**. Messages (**M**):

| status | id | text |
|---|---|---|
| working, elapsed ≥ 1000ms | `localConversation.workingFor` | `Working for {time}` (`:327568`) |
| working, elapsed < 1000ms | `localConversation.working` | `Working` (`:327574`) |
| worked | `localConversation.workedFor.v2` | `Worked for {time}` (`:327590`) |
| stopped | `localConversation.userStoppedAfter` | `You stopped after {time}` (`:327605`) |
| collapsed, no duration | `localConversation.previousMessagesSummary` | `{count, plural, one {# previous message} other {# previous messages}}` (`:327828`) |

The elapsed clock ticks on a **1000 ms** `setInterval` while `status === 'working'` and `completedAtMs == null`
(`pretty/app-initial.js:327737`, `:327484–327493`) — **M**.

### 5.2 The divider row (`oca`, `pretty/app-initial.js:327651–327712`) — **M**

```
tca padding="offset"
└ motion.div  initial {opacity:0, height:0} → animate {opacity:1, height:'auto', transitionEnd:{overflow}}
              transition tea, style {overflow:hidden}
  └ div.flex.min-h-0.flex-col.items-start.gap-2.text-size-chat.text-secondary  [+ overflow-hidden when no accessory]
    ├ (leadingAccessory ? <div class="flex items-start gap-2">[accessory, label]</div> : label)
    └ <div class="w-full border-t border-default" />        ← the hairline under the header
```

`tea = { duration: 0.3, ease: [0.19, 1, 0.22, 1] }` (`pretty/app-initial.js:316608`) — **M**.

A second variant used when the turn is collapsible adds `pt-1 text-size-chat text-secondary` above the same
`w-full border-t border-default` rule (`pretty/app-initial.js:327952–327958`) — **M**.

### 5.3 The collapse control (`pca`, `pretty/app-initial.js:327844–327950`) — **M**

| Property | Value |
|---|---|
| Outer | `<div class="text-size-chat text-secondary"><div class="flex w-full items-center">…` |
| Toggle button | Button `className="max-w-full text-size-chat" color="ghostMuted" radius="small" size="inline" aria-expanded` |
| ⇒ resolved | `ghostMuted` = `enabled:hover:bg-transparent data-[state=open]:bg-transparent hover:text-default border-transparent`; `radius small` = `rounded-md` (10px); `size inline` = `border-0 p-0` (`pretty/app-initial.js:215827`, `:215880`, `:215884`) |
| Chevron | `icon-2xs text-text/40 transition-transform duration-basic` + `rotate-0` collapsed / `rotate-90` expanded ⇒ **14px, `#dfdfdf` @40%, 0.15s** |
| Denied-action badge | second inline button, `ms-auto text-size-chat text-secondary`, `ghostMuted`, `radius small`, `size inline`, wrapped in a tooltip; label `{count, plural, one {# denied action} other {# denied actions}}` |

**Hover state.** There is no background change: `ghostMuted` explicitly sets `hover:bg-transparent`, and the
only hover feedback is `hover:text-default` — the label brightens from `text-text/60` to `--color-text`
(**M**, `pretty/app-initial.js:215827`).

---

## 6. Activity rows (Explored / Ran / Edited / Read / Searched / Listed)

### 6.1 Structure

The activity item (`Pca`, `pretty/app-initial.js:328272–328373`) renders — **M**:

```
tca padding="offset"                                  ← relative overflow-visible py-0, text-size-chat
└ div.flex.min-w-0.flex-col
  ├ header  span.group/activity-header.relative.inline-flex.max-w-full.min-w-0.items-center.gap-1.self-start
  │   ├ <button class="absolute inset-0 cursor-interaction rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset">   ← full-bleed hit target
  │   ├ Cca  "pointer-events-none relative shrink truncate text-size-chat [&_a]:pointer-events-auto [&_button]:pointer-events-auto"
  │   │      Cca itself = span.inline-flex.min-w-0.gap-1.5 (+ items-center | items-start)
  │   │      ├ span.contents.text-text/60          ← the icon slot
  │   │      └ span.min-w-0.flex-1.truncate.text-text/60
  │   │             [&_.loading-shimmer-pure-text]:align-top  [&_*:not(button)]:!text-text/60
  │   ├ accessory
  │   └ span.pointer-events-none.relative > chevron
  └ body
```

| Property | Value | Source | M/I |
|---|---|---|---|
| Gap icon↔label | `gap-1.5` = **6px** | `pretty/app-initial.js:328084` (`Cca`) | M |
| Gap label↔chevron | `gap-1` = **4px** | `:328331` | M |
| Font size | `text-size-chat` = **14px** | `:328345` | M |
| Dim text | `text-text/60` = `color-mix(in oklab, var(--color-text) 60%, transparent)` = **`#dfdfdf` @ 60%** | `:328318`; `pretty/app-initial.css:15907–15913` | M |
| Icon colour | same `text-text/60`, via `<span class="contents text-text/60">` | `:328302` | M |
| Hover brighten | `[@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:!text-default` on the label **and** `…:[&_*:not(button)]:!text-default` on its children — i.e. hovering the row promotes everything to `--color-text`, **unless the pointer is on a file link** | `:328310–328317` | M |
| Chevron (`yca`) | `icon-2xs shrink-0 text-text/60 opacity-0 … transition-transform duration-relaxed`, `rotate-90 opacity-100` when expanded; becomes `opacity-100 text-default` on group hover or focus-visible | `:328042–328052` | M |
| ⇒ chevron | **14px, hidden until hover, 0.3s rotate** | derived | I |
| Non-collapsible header (`Dca`) | `group/activity-header inline-flex min-w-0 max-w-full self-start items-center gap-1 p-0 text-start`; when collapsible adds `cursor-interaction rounded-md bg-transparent focus-visible:px-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:ring-inset` | `:328171–328186` | M |
| Body indent | `ps-6` = **24px** on the `Hca` wrapper when `indent` is set | `:328437` | M |
| Body of a Q&A-style activity | `flex flex-col gap-3 pt-1 pb-0.5`, each entry `flex flex-col gap-1` with question `text-size-chat whitespace-pre-wrap text-text/60` and answer `text-size-chat text-text/30` | `pretty/subagent-activity-chip-group-2a2be347c052.js:14182`, `:14300–14310` | M |
| Scroll-anchoring on expand | expanding scrolls the timeline to keep the header still (`gca`), driven by a `ResizeObserver` on the `[data-turn-key]` ancestor, cancelled after **350 ms** or on the first wheel/touchmove/pointerdown/keydown | `pretty/app-initial.js:327984–328016`, `_ca = 350` | M |
| Summary-text variant | `text-size-chat text-text/40 group-hover/activity-header:text-default`, icon `icon-xs shrink-0 text-text/60` | `pretty/agent-activity-item-4dc42308eda2.js:596`, `:613–616` | M |
| Dimmest summary variant | `min-w-0 truncate text-text/30 group-hover/activity-header:text-default` | `pretty/subagent-activity-chip-group-2a2be347c052.js:8244` | M |
| Command text | `<span class="font-mono">{command}</span>` inside the header | `pretty/subagent-activity-chip-group-2a2be347c052.js:8934`, `:13811` | M |
| Row label copy | `Ran`, `Ran {command}`, `Ran {command} in {elapsed}`, `Running command`, `Running command for {elapsed}`, `Read files`, `Searched the web`, `Listed`, `Edited`, `Edited {filename}`, `Updated`, `Read chat terminal` | `:1181, 3472, 3527, 4471, 8741, 10366–10608, 12670, 13289, 13365, 16903` | M |
| File-path links | `data-agent-activity-file-link` marks them; they opt out of the row-hover brighten (see above) | `:328311` | M |

### 6.2 Diff tints on an activity row (**M**)

An "Edited"-style row carries an inline `+A −D` stat plus a coloured dot:

```jsx
<div class="flex items-center gap-1.5">
  <DiffStat class="text-size-chat-sm" linesAdded linesRemoved variant="agent-activity" />
  <span class="block size-1.5 rounded-full bg-chart-red/70" />     {/* deletion marker */}
</div>
…
  <span class="block size-1.5 rounded-full bg-chart-blue/70" />    {/* addition marker, r.type === 'add' */}
```
`pretty/subagent-activity-chip-group-2a2be347c052.js:13525–13570`.

The stat component (`esa`, `pretty/app-initial.js:326481–326560`) — **M**:

| | |
|---|---|
| Wrapper | `inline-flex items-center gap-1 leading-none disambiguated-digits tabular-nums tracking-tight` |
| `+N` span | `flex shrink-0 items-center` + variant class |
| variant `color` | `text-codex-git-added` / `text-codex-git-deleted` — always coloured |
| variant `monochrome` | `text-tertiary` for both |
| variant `agent-activity` | **colourless at rest**; colour appears only on `[@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:text-codex-git-added` / `-deleted` |
| messages | `+{linesAdded}` / `−{linesRemoved}` (`wham.message.modal.repoAndDiffStats.linesAdded`) |
| size in activity rows | `text-size-chat-sm` = **13px** |

Colours (**M**, chain verified end to end):
`--color-codex-git-added` → `--vscode-gitDecoration-addedResourceForeground` → `--color-decoration-added`
(`pretty/app-initial.css:2573–2578`, `:34758`, `:34762`), and the runtime writes
`--color-decoration-added: theme.semanticColors.diffAdded`, `--color-decoration-deleted: …diffRemoved`
(`pretty/app-initial.js:345843–345844`). Both built-in dark seeds carry the same pair
(`:345650–345656`, `:346075–346084`):

* **added `#40c977`**, **deleted `#fa423e`**.

Derived surface tints, also runtime-written (`:345845–345852`, helpers `mCa`/`HY` at `:345998`, `:346006`):
`--color-editor-added = rgba(64, 201, 119, 0.23)`, `--color-editor-deleted = rgba(250, 66, 62, 0.23)` in dark
(0.15 in light) — **M** (arithmetic on measured code).

`bg-chart-red` = `--color-chart-red` → `--vscode-charts-red` → `--color-accent-red`, which the runtime
generator does **not** write, so it falls to `.electron-dark { --color-accent-red: var(--red-300) }` =
**`#ff6764`** (`pretty/app-initial.css:2310`, `:33822`, `:16824`, `:2165`) — **M**.
`bg-chart-blue` = `--color-accent-blue`, which the runtime **does** write from `theme.accent` = **`#339cff`**
for the built-in dark preset (`pretty/app-initial.js:345795`, `:346073`) — **M**.

### 6.3 Output cap and "Show more"

Component `voa` (`pretty/app-initial.js:325965–326182`) — **M**:

| Property | Value |
|---|---|
| Default `collapsedLineCount` | **20** (`Coa = 20`, `:326213`) |
| Cap in the activity/steering summary | **2** (`qb = 2`, `pretty/subagent-activity-chip-group-2a2be347c052.js:8380`) |
| Collapsed box | `overflow-hidden` with inline `maxHeight: "{n}lh"`, then re-measured in a layout effect and rounded **up** so a code block is never cut mid-block (`querySelectorAll('[data-markdown-copy="code-block"]')`) |
| Trailing ellipsis | a separate `<span aria-hidden class="block">…</span>` when `collapsedLineCount > 2` |
| Uncollapsible threshold | content height must exceed collapsed height by more than `poa = 1` px |
| Container | `relative w-full min-w-0 text-size-chat`, outer `flex flex-col items-end gap-1` |
| Toggle button | `mt-1.5 self-start text-size-chat text-codex-description`, Button `color="ghostMuted" size="inline"`, `aria-expanded` |
| Toggle chevron | `icon-2xs`, `rotate-180` when expanded |
| Labels | `Show more` / `Show less` (`codex.userMessage.showMore` / `.showLess`) |
| Offscreen a11y | collapsed-out focusables get `inert` + `aria-hidden`, tracked with an `IntersectionObserver` at `threshold: 1` |

Other caps seen in the thread (**M**, same chunk): inline diff preview `max-h-60` (240px) or `max-h-25`
(100px) in short view (`:13940`); embedded code container `!p-2 max-h-40 vertical-scroll-fade-mask` (160px,
`:14043`); review-comment popover `max-h-96 overflow-y-auto px-4 py-3` (`:5770`); tool-detail tooltip
`max-h-48 overflow-auto rounded-md bg-primary-soft px-3 py-2 font-mono text-xs whitespace-pre` (`:6349`).

---

## 7. File-change card

Component `VC` (`pretty/subagent-activity-chip-group-2a2be347c052.js:13789–13920`) — **M**:

| Part | Class / value |
|---|---|
| Card | `border-default flex flex-col overflow-hidden rounded-lg border` ⇒ 1px `rgba(255,255,255,0.084)`, **radius-lg = 12.5px squircle**, clipped |
| Header | `flex items-center justify-between gap-2 border-b border-default bg-background-primary-ghost-hover/60 px-2.5 py-0.5 text-size-chat-sm text-codex-description/80` ⇒ 10px/2px padding, 13px text, header fill `rgba(255,255,255,0.078) @ 60%`, text `rgba(255,255,255,0.498) @ 80%` |
| Header left | `flex min-w-0 items-center gap-2` — filename button + `+A −D` |
| Filename | Button `allowShrink color="ghostMuted" size="inline"`, class `max-w-full text-start hover:underline` (+ `cursor-default no-underline` when not openable), inner `<span class="truncate">{basename}</span>`, tooltip shows the full path in `font-mono` |
| Diff stat | `<DiffStat class="text-size-chat-sm" linesAdded linesRemoved />` — **variant defaults to `color`**, so here `+A` is `#40c977` and `−D` is `#fa423e` at rest (unlike the activity-row variant) |
| Header right | copy button, `iconOnly`, `iconClassName="icon-2xs"` (14px) |
| Body | `<div class="bg-surface-tertiary">` = **`rgb(40, 40, 40)`** |
| Body content | the unified-diff renderer, `composer-diff-simple-line overflow-y-auto` + `max-h-60` (or `max-h-25` in short view), `diffStyle: 'unified'`, `hunkSeparators: 'simple'` |
| Multi-file list gap | `flex flex-col gap-[var(--conversation-patch-file-gap,var(--conversation-item-gap,16px))]` ⇒ **16px** between file cards | `:13076` |
| Per-file expand control | Button `color="ghostMuted" size="inline"` with a disclosure chevron, aria-label `Toggle diff for {fileName}` | `:13707–13725` |
| Row wrapper | `flex min-w-0 items-center gap-1 text-size-chat text-codex-description/80`, trailing slot `ms-1 flex items-center gap-1 transition-opacity duration-basic` | `:13735`, `:13746` |
| Declined-by-auto-review state | `File change declined by auto-review: {file}`, filename in `text-secondary` | `:13473–13483` |
| Diff surface tokens | `--diffs-font-family: var(--font-mono)`, `--diffs-font-size: 13px`, `--diffs-line-height: calc(size*1.8)` = 23.4px, `--diffs-gap-block: 0`, `--diffs-min-number-column-width: 4ch`, `--diffs-addition-color-override: var(--color-codex-git-added)`, `--diffs-deletion-color-override: var(--color-codex-git-deleted)` | `pretty/app-initial.css:35141–35147` |

**Not found:** a "Review" or "Undo" button pair on this card. The header's only trailing control is *copy*;
expansion is a chevron; there is a per-file **Toggle diff**. `Undo` does not appear in these chunks. See §12.

---

## 8. Approval card

### 8.1 Shell (**M**, `pretty/app-primary.js:369366–369670`)

```
a8  "flex flex-col overflow-hidden rounded-3xl border border-default bg-surface-elevated-secondary
     text-default focus:outline-none"
    + "@container/approval-card"  data-codex-approval-surface
├ header block   "flex min-w-0 flex-col gap-2 px-4 pt-4 pb-3"     (role="alert" aria-atomic)
│   └ JMr        "flex min-w-0 flex-col gap-2"
│       ├ headerContent  "flex items-center gap-2 text-size-chat-sm leading-5 font-normal text-secondary"
│       └ "flex min-w-0 flex-col gap-0.5"
│           ├ title      "min-w-0 leading-5 wrap-anywhere text-size-chat font-medium text-default"
│           │            (secondary variant: "text-size-chat-sm font-normal text-secondary")
│           └ subtitle   "text-size-chat-sm text-codex-description"
├ body (command / diff / details)
└ <form class="flex items-center gap-2 px-4 pt-2 pb-4 @max-md/approval-card:flex-col @max-md/approval-card:items-stretch">
    ├ leadingAction  Button color="outline" size="composer" allowShrink   ("Always allow")
    └ <div class="ms-auto flex min-w-0 items-center gap-2 @max-md/…:ms-0 @max-md/…:w-full @max-md/…:flex-col @max-md/…:items-stretch">
        ├ Deny    Button color="outline"  size="composer"
        └ Approve Button color="primary"  size="composer" type="submit" autoFocus
```

| Property | Value | M/I |
|---|---|---|
| Radius | `rounded-3xl` = `--radius-3xl` = 1.25rem × 1.25 = **25px**, `corner-shape: superellipse(1.5)` | I (arithmetic on measured tokens) |
| Border | 1px `--color-border` = `rgba(255,255,255,0.084)` | M |
| Background | `bg-surface-elevated-secondary` = `--color-surface-elevated-secondary` → `--vscode-dropdown-background` → `--color-background-control-opaque` = **`rgb(45, 45, 45)`** | M |
| Padding | header `16px 16px 12px`, actions `8px 16px 16px`, gap 8px | M |
| Title | 14px / 500 / `--color-text` (`#dfdfdf`), line-height 20px | M |
| Subtitle | 13px / `--color-codex-description` = `rgba(255,255,255,0.498)` | M |
| Reason row | `<dl class="@container">` with `[--detail-row-font-size:var(--codex-chat-font-size)]`, label "Reason"; a `flex flex-col gap-1` wraps reason + details | M |
| Responsive | at container width < `md` the button row stacks full-width and centres its labels (`@max-md/approval-card:*`) | M |

### 8.2 Buttons

`size="composer"` resolves to `h-token-button-composer px-(--padding-button-composer-inline,calc(var(--spacing)*2)) py-0 text-(length:--text-button-composer,var(--text-sm)) leading-(--line-height-button-composer,18px)`
(`pretty/app-initial.js:215846`, **M**), and `--spacing-token-button-composer` is `calc(var(--spacing)*7)` =
**28px** in Electron (`pretty/app-initial.css:2717`; the `calc(--spacing*9)` = 36px value at `:34892` is inside the `[data-codex-window-type="browser"]` block and does not apply) ⇒ **28px tall, 8px side padding,
13px text, 18px line-height** (**I**).

| Button | `color` | Resolved (dark) | M/I |
|---|---|---|---|
| **Allow once** (primary) | `primary` | `border-default bg-primary-solid enabled:hover:bg-text/80 data-[state=open]:bg-text/80 text-primary-solid` ⇒ fill `--color-background-primary-solid` = `--vscode-foreground` = **`#dfdfdf`**, label `--color-text-primary-solid` = `--vscode-dropdown-background` = **`rgb(45,45,45)`**, hover fill `#dfdfdf @ 80%` | M |
| **Deny** | `outline` | `border-default bg-primary-soft-alpha enabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border` ⇒ 1px `rgba(255,255,255,.084)`, fill `--color-background-primary-soft-alpha` = `--color-background-elevated-secondary` = **`rgba(255,255,255,0.032)`**, hover **`rgba(255,255,255,0.078)`** | M |
| **Always allow** (leading) | `outline` | same as Deny; wrapped in a tooltip; `allowShrink`, label truncates | M |
| Radius | `--radius-button-toolbar`-style default: `$ir[size]`; `size="composer"` uses the default radius map (`far`: `full` `rounded-full`, `large` `rounded-lg`, `small` `rounded-md`) unless `radius` is passed — none is here | M (map at `pretty/app-initial.js:215886–215890`) / **the default `$ir[x]` table was not read**, see §12 |
| Scoped-approve split button | when a scoped action exists, Approve becomes a split button (`primaryClassName="min-w-0 overflow-hidden @max-md/…:flex-1 …"`) with a menu carrying "Allow once" and "Allow this conversation" / "Allow all edits" / "Allow similar commands" | M (`pretty/app-primary.js:369593–369640`, `:397726–397790`) |

### 8.3 Keyboard hints

| | |
|---|---|
| Approve | **Enter** — command `approval.approve`, `electron: { defaultKeybindings: [{ key: 'Enter' }] }` (`pretty/app-initial.js:314836–314841`) — **M** |
| Deny | **Escape** — command `approval.decline`, `[{ key: 'Escape' }]` (`:314843–314849`) — **M** |
| Hint chip | `<kbd aria-hidden class="inline-flex h-4 min-w-4 items-center justify-center rounded-md border-0 bg-current/10 px-1.5 py-0 font-sans text-xs leading-4 text-current shadow-none">` + `text-primary-solid` (on the primary button) or `text-default group-hover:bg-text/15` (secondary) (`pretty/app-primary.js:362813–362840`) — **M** |
| ⇒ chip | 16px tall, min 16px wide, radius-md **10px**, background = **currentColor @ 10%**, 12px/16px text, 6px side padding — **I** |
| Hints hidden when narrow | `@max-md/approval-card:hidden` on the chip wrappers — **M** (`pretty/app-primary.js:369407`, `:369536`) |
| Hotkeys suppressed | when focus is inside `input, textarea, [contenteditable]`; autoFocus on Approve is likewise conditional on that check — **M** (`:369383–369389`) |
| Countdown pill (auto-dismiss) | `inline-flex h-5 min-w-8 shrink-0 items-center justify-center rounded-full bg-text-info/10 px-1.5 text-xs leading-none font-medium text-info`, message `{seconds}s`, ticked every 1000 ms — **M** (`pretty/app-primary.js:364983–365000`) |

### 8.4 Position

`ApprovalCard` is a plain card component with no positioning of its own — the caller places it. It is
registered as `ApprovalCard` in a component map (`pretty/app-primary.js:393096`, `:394347`, `:394667`) and
instantiated at four call sites (`:395656`, `:397711`, `:397862`, `:405497`, `:405640`). The composer rail
(§10) is the docking mechanism the thread uses for anything pinned above the composer. **Which of inline vs
docked applies to each approval type was not resolved from the bundle** — see §12.

---

## 9. Colour ramp and semantic tokens (dark)

### 9.1 Raw ramp (identical light/dark; only which step a semantic token points at changes)

`pretty/app-initial.css:2128–2205` — **M**:

```
--gray-0 #ffffff · 50 #f9f9f9 · 75 #f3f3f3 · 100 #ededed · 150 #dfdfdf · 200 #cdcdcd · 250 #b9b9b9
· 300 #afafaf · 400 #8f8f8f · 500 #5d5d5d · 550 #4f4f4f · 600 #414141 · 650 #393939 · 700 #303030
· 750 #282828 · 800 #212121 · 900 #181818 · 950 #131313 · 1000 #0d0d0d
--green-300 #40c977 · --green-500 #00a240
--red-300 #ff6764 · --red-400 #fa423e · --red-500 #e02e2a · --red-600 #ba2623
--orange-300 #ff8549 · --orange-400 #fb6a22
--yellow-300 #ffd240 · --purple-300 #ad7bf9 · --blue-300 #339cff
```

### 9.2 Runtime dark palette

Built-in dark seed `{ accent: '#339cff', contrast: 60, ink: '#ffffff', surface: '#181818', opaqueWindows: false,
semanticColors: { diffAdded: '#40c977', diffRemoved: '#fa423e', skill: '#ad7bf9' } }`
(`pretty/app-initial.js:346071–346085`) — **M**. (A second preset exists,
`{ accent: '#3a83f7', accentSource: 'chatgpt', ink: '#ededed', surface: '#000000', opaqueWindows: true }` at
`:345645–345658`, with the *same* diff colours — **M**.)

Resolved dark values, **reused from the sibling sidebar document §2a** (which re-implemented `rCa`/`uCa`/`sCa`/`zY`
verbatim and ran them) and re-verified here for the tokens the thread uses:

| Token | Dark value |
|---|---|
| `--color-background-surface` | `#181818` |
| `--color-background-surface-under` | `#141414` |
| `--color-background-editor-opaque` | `rgb(40, 40, 40)` |
| `--color-background-control-opaque` | `rgb(45, 45, 45)` |
| `--color-background-control` | `rgba(45, 45, 45, 0.96)` |
| `--color-background-elevated-secondary` | `rgba(255, 255, 255, 0.032)` |
| `--color-background-button-secondary` | `rgba(255, 255, 255, 0.052)` |
| `--color-background-button-secondary-hover` | `rgba(255, 255, 255, 0.078)` |
| `--color-border` | `rgba(255, 255, 255, 0.084)` |
| `--color-border-light` | `rgba(255, 255, 255, 0.042)` |
| `--color-border-heavy` | `rgba(255, 255, 255, 0.156)` |
| `--color-border-focus` | `rgba(131, 195, 255, 0.76)` |
| `--color-text-foreground` | `#dfdfdf` |
| `--color-text-foreground-tertiary` | `rgba(255, 255, 255, 0.498)` |
| `--color-text-accent` | `rgb(131, 195, 255)` |
| `--color-decoration-added` / `-deleted` | `#40c977` / `#fa423e` |
| `--color-editor-added` / `-deleted` | `rgba(64,201,119,0.23)` / `rgba(250,66,62,0.23)` |

### 9.3 Semantic aliases the thread uses (all chains **M**)

| Class used in markup | chain | dark value | key lines |
|---|---|---|---|
| `text-default` | `--color-text` → `--vscode-foreground` → `--color-text-foreground` | `#dfdfdf` | css `:15678`, `:2208`, `:33619` |
| `text-secondary` | `--color-text-secondary` = `color-mix(in srgb, var(--vscode-foreground) 65%, transparent)` | `rgba(223,223,223,0.65)` | `:15792`, `:2213–2221` |
| `text-tertiary` | `--color-text-tertiary` → `--vscode-descriptionForeground` → `--color-text-foreground-tertiary` | `rgba(255,255,255,0.498)` | `:15816`, `:2227` |
| `text-codex-description` | `--color-codex-description` → `--vscode-descriptionForeground` | `rgba(255,255,255,0.498)` | `:2555` |
| `text-codex-description/80` | 80% of the above | `rgba(255,255,255,0.398)` | `:15334–15345` |
| `text-text/30 · /40 · /55 · /60 · /70` | `color-mix(in oklab, var(--color-text) N%, transparent)` | `#dfdfdf` at N% | `:15883–15920` |
| `text-emphasis` | `--color-text-emphasis` → `--vscode-list-activeSelectionForeground` → `--color-text-foreground` | `#dfdfdf` | `:2209` |
| `text-info` | `--color-text-info` → `--vscode-textLink-foreground` → `--color-text-accent` | `rgb(131,195,255)` | `:2247`, `:33625` |
| `bg-user-message` | `--color-background-user-message` = `color-mix(in oklab, var(--color-text) 5%, transparent)` | `#dfdfdf` @ 5% | `:13182`, `:2404–2413` |
| `bg-primary-ghost-hover` / `bg-background-primary-ghost-hover` | `--color-background-primary-ghost-hover` → `--vscode-list-hoverBackground` → `--color-background-button-secondary-hover` | `rgba(255,255,255,0.078)` | `:12515`, `:2383` |
| `bg-secondary-soft-alpha` | `--color-background-secondary-soft-alpha` → `--vscode-textCodeBlock-background` → `--color-background-button-secondary` | `rgba(255,255,255,0.052)` | `:12545`, `:2448`, `:18777` |
| `bg-primary-soft-alpha` | `--color-background-primary-soft-alpha` → `--color-background-elevated-secondary` | `rgba(255,255,255,0.032)` | `:34937` |
| `bg-primary-soft` | `--color-background-primary-soft` → `--vscode-input-background` → `--color-background-control` | `rgba(45,45,45,0.96)` | `:12518`, `:2351`, `:33828` |
| `bg-surface` | `--color-surface` → `--color-background-surface` | `#181818` | `:2342` |
| `bg-surface-secondary` | `--color-surface-secondary` → `--vscode-sideBar-background` → `--color-background-surface-under` | `#141414` | `:2343`, `:34310` |
| `bg-surface-tertiary` | `--color-surface-tertiary` → `--vscode-editor-background` → `--color-background-editor-opaque` | `rgb(40,40,40)` | `:12715`, `:2348` |
| `bg-surface-elevated-secondary` | `--color-surface-elevated-secondary` → `--vscode-dropdown-background` → `--color-background-control-opaque` | `rgb(45,45,45)` | `:2350`, `:33846` |
| `bg-primary-solid` / `text-primary-solid` | `--color-background-primary-solid` = `--vscode-foreground`; `--color-text-primary-solid` = `--vscode-dropdown-background` | `#dfdfdf` / `rgb(45,45,45)` | `:2402`, `:2261` |
| `border-default` | `--color-border` | `rgba(255,255,255,0.084)` | `:10834` |
| `border-subtle` | `--color-border-subtle` → `--color-border-light` | `rgba(255,255,255,0.042)` | `:10873`, `:2522–2533` |
| `border-strong` | `--color-border-strong` → `--color-border-heavy` | `rgba(255,255,255,0.156)` | `:2535–2547` |
| `ring-ring` | `--color-ring` → `--vscode-focusBorder` → `--color-border-focus` | `rgba(131,195,255,0.76)` | `:2552`, `:33624` |
| `text-codex-git-added` / `-deleted` | see §6.2 | `#40c977` / `#fa423e` | `:2573–2578` |
| `bg-chart-blue` / `bg-chart-red` | `--color-accent-blue` (runtime) / `--color-accent-red` (stylesheet) | `#339cff` / `#ff6764` | `:2306`, `:2310`, `:16824–16829` |

---

## 10. Queued / steer strip above the composer

### 10.1 The rail

`V_r` (`pretty/app-primary.js:336165–336230`) — **M**:

```
<div data-composer-rail data-composer-rail-placement="above|below"
     class="relative flex min-w-0 flex-col empty:contents  _rail_e8rl5_1  [border-border/80 _attached_e8rl5_26]" >
```

`pretty/app-primary.css:3223–3330` — **M**:

| Rule | Value |
|---|---|
| `._rail_` | `--composer-rail-transition-duration: var(--transition-duration-relaxed)` (**0.3s**), `margin-inline: var(--home-composer-inline-inset)` (`calc(var(--spacing)*3.25)` = **13px**, `pretty/app-initial.css:35112`) |
| reduced motion | `:root[data-reduced-motion="true"] ._rail_` and `@media (prefers-reduced-motion: reduce) :root:not([data-reduced-motion="false"]) ._rail_` ⇒ duration **0s** |
| `._attached_` | `--composer-rail-tuck: 0px; --composer-rail-overlap: 0px; top: 0; overflow: clip;` transition on `margin-top, margin-bottom, top` at the rail duration with `var(--ease-enter)`; `corner-shape: var(--codex-corner-shape)` under `@supports` |
| placement `above` | `margin-bottom: calc((tuck + overlap) * -1)`, `border-start-*-radius: var(--radius-2xl)` = **20px**; `::after` border `1px 1px 0`; first item's top border goes transparent |
| placement `below` | `margin-top: calc(tuck * -1)`, `border-end-*-radius: var(--radius-2xl)`; `::after` border `0 1px 1px` |
| `::after` | full-inset pseudo-border, `border-color: inherit` (`border-border/80` ⇒ `--color-border` @ 80% = `rgba(255,255,255,0.067)`), `opacity: 0` → `1` only when a non-`controls` rail item is present, transitioned at the rail duration |
| tuck | `--composer-rail-tuck: var(--spacing)` (**4px**) when a `[data-composer-rail-item="present"]` exists; otherwise `top: var(--spacing)` |
| `._item_` | `border-color: color-mix(in oklab, var(--color-border) 80%, transparent)`; inline borders forced transparent inside `._attached_` |
| `._target_` | `display: contents` (the portal landing site, `data-above-composer-attached-portal`) |

### 10.2 Rail rows

`q_r` (`pretty/app-primary.js:336305–336480`) — **M**:

```
row       "group flex min-w-0 items-center justify-between gap-2 px-2.5 py-0.5 text-size-chat"
          (+ "w-full cursor-interaction rounded-[inherit] text-start focus:outline-none
              focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" when clickable)
left      "flex min-h-token-button-composer min-w-0 flex-1 items-center gap-2 text-codex-description"
icon slot "flex h-4 shrink-0 items-center justify-center"
title     "min-w-0 flex-1 overflow-hidden py-1 leading-5 wrap-anywhere"   (+ "max-[220px]:hidden" when hideTitleWhenNarrow)
meta      "max-w-full min-w-0 truncate text-codex-description"
right     "flex shrink-0 items-center gap-1"
```
⇒ **10px side padding, 2px block padding, 14px text, min row height 28px, `rgba(255,255,255,0.498)` text**
(**I**, from `--spacing-token-button-composer` = 28px).

### 10.3 Queued-message list

`pretty/queued-message-list-a94e8fdd0b7d.js` — **M**:

| Property | Value | line |
|---|---|---|
| List | `vertical-scroll-fade-mask hide-scrollbar flex max-h-[30dvh] flex-col gap-px overflow-x-hidden overflow-y-auto` — **1px between rows, capped at 30 % of the viewport** | 312 |
| Interrupted header | a `Rail.Row` with `Queue paused because you interrupted`, icon `icon-2xs text-text-tertiary/70`, action `Resume` with `icon-2xs shrink-0`; followed by `<div class="border-t border-subtle" aria-hidden>` | 137–169 |
| Drag handle | `relative -ms-2.5 flex h-4 cursor-grab items-center justify-center ps-2.5 active:cursor-grabbing`, drag activates after **6px** (`activationConstraint: { distance: 6 }`) | 391, 790 |
| Message text | `line-clamp-1 max-h-lh min-w-0 self-center leading-5 text-secondary` | 473 |
| Attachment thumb | `composer-attachment-surface size-6 shrink-0 rounded border border-strong object-cover` (24px) | 455 |
| Failure marker | `mt-0.5 inline-flex shrink-0` + `icon-2xs text-warning` | 442–443 |
| Row content | `flex min-w-0 items-start gap-1.5` | 489 |
| Action icons | all `icon-2xs` (14px) | 543, 598, 623 |
| Menu items | `text-codex-description`; labels `Retry`, `Steer`, `Submit without interrupting the model`, `Delete queued message`, `Edit message`, `Open in side chat`, `Turn on/off queueing` | 523–710, 957–962 |
| Row animation | a `motion.div` with `initial/animate/exit` + `transition`, class `overflow-visible` | 754–765 |

### 10.4 In-progress floating pill (todo / live diff, above the composer)

`pretty/local-conversation-turn-d75f99f4366a.js:986–1180` — **M**. Portalled to the thread's
`data-in-progress-fixed-content` slot (`relative col-start-1 row-start-1 h-8 self-end`):

```
outer   "absolute inset-x-0 bottom-1 flex min-h-7 items-center justify-center gap-2 pb-1"
        motion: initial {opacity:0, y:4} → animate {opacity:1, y:0} → exit {opacity:0, y:4}
mid     "flex w-full max-w-(--thread-content-max-width) min-w-0 justify-center"
        > motion.div layout="size" class="relative z-10 w-fit max-w-full min-w-0 overflow-hidden rounded-3xl"
pill    "flex w-max max-w-full min-w-0 items-center gap-2 rounded-3xl border border-border/80
         bg-background-primary-soft/70 px-3 py-1.5 text-default backdrop-blur-sm"
```
⇒ radius **25px squircle**, 1px `rgba(255,255,255,0.067)`, fill `rgba(45,45,45,0.96) @ 70%` behind a blur,
12px/6px padding, 8px item gap (**I**, arithmetic on measured tokens).

---

## 11. Reasoning, shimmer, notices, subagents, motion

### 11.1 Thinking / working line

There is **no blinking dot** — it is a shimmer sweep over the label text.

| Layer | Value | Source | M/I |
|---|---|---|---|
| Placeholder wrapper | `inline-flex max-w-full min-w-0 items-center overflow-hidden text-text/60 [&_*:not(button)]:!text-text/60`; label `min-w-0 flex-1 truncate select-none` (`invisible` while not yet visible); spacer `h-4 w-0 shrink-0` when no icon | `pretty/local-conversation-turn-d75f99f4366a.js:2680–2712` | M |
| Label class | `text-size-chat leading-[calc(var(--codex-chat-font-size)_+_8px)] select-none truncate` ⇒ **14px / 22px** | `pretty/app-initial.js:327115–327120` | M |
| Messages | `Thinking` (`thinkingShimmer.default`), `Typing…` (`thinkingShimmer.typing`) | `pretty/app-initial.js:327128–327132`; `pretty/local-conversation-turn-d75f99f4366a.js:2894–2900` | M |
| Shimmer element | `<span class="loading-shimmer-pure-text _cadencedShimmer_a3m57_1 …">{text}<span aria-hidden class="_cadencedShimmerSweep_"><span class="_cadencedShimmerHighlight_">{text}</span></span></span>` | `pretty/app-initial.js:327063–327092` | M |
| Base shimmer CSS | `--loading-shimmer-default-duration: 2s`; text painted with `background-clip: text` + `-webkit-text-fill-color: transparent`; `animation: loading-shimmer var(--loading-shimmer-duration, 2s) steps(48, end) infinite`; `background-size: 50% 200%`; keyframes `background-position: -100% 0 → 250% 0` | `pretty/app-initial.css:1487–1585`, `:35211–35218` | M |
| Shimmer colours (dark) | `--shimmer-text-secondary: color-mix(in srgb, var(--text-primary) 45%, transparent)` where `--text-primary: var(--color-codex-description)`; `--shimmer-contrast: #0009` under `.dark` | `:1535–1552` | M — note the `.dark` branch is what defines the dark values; whether `.dark` is on the root **was not confirmed** (the Electron root uses `.electron-dark`) |
| Cadenced overlay | `._cadencedShimmer_` neutralises the base gradient (`text-fill-color: currentColor`, `animation: none`) and paints `color: var(--shimmer-text-secondary) !important`, with `._cadencedShimmerHighlight_` at `var(--shimmer-contrast) !important`; the sweep is a mask `linear-gradient(90deg, #0000 0%, #000 20% 30%, #0000 50% 100%)` translated ±50 %→±125 % | `pretty/app-initial.css:288–352` | M |
| Cadence | first sweep **600 ms** after mount, each sweep **1000 ms** (`steps(48, end)`, one iteration), repeating every **4000 ms** | `pretty/app-initial.js:327044–327050`, constants `Fsa=600, Nsa=1000, Psa=4000` at `:327164–327166` | M |
| Reduced motion | the cadence effect returns early if `matchMedia('(prefers-reduced-motion: reduce)').matches`; both the base shimmer and the cadenced keyframes also have `@media (prefers-reduced-motion: reduce) { animation: none }` | `pretty/app-initial.js:327027–327032`; css `:1586–1591`, `:337–343` | M |
| Legacy inverted variant | `.loading-shimmer-pure-text-inverted` — 5s `steps(120, end)`, 0.5s delay | css `:1432–1465` | M |
| Hover kill | `.loading-shimmer:hover { -webkit-text-fill-color: var(--text-primary); background: none; animation: none }` | css `:1594–1598` | M |

### 11.2 Reasoning treatment

Reasoning is a **collapsible summary**, not a separate styled block:

* In the turn model, a `reasoning` item and a `commentary`-phase `agentMessage` are folded into one `work`
  group; the group's header is the "Worked for …" divider (`wba`, `pretty/app-initial.js:342471–342541`) — **M**.
* The reasoning body renders through the ordinary bubble container with `className="text-secondary"`
  (`pretty/app-initial.js:342446–342450`) — **M**.
* The collapsible-reasoning header is a plain button: `group flex min-w-0 items-center gap-1.5 text-start`
  (+ `cursor-interaction` when toggleable) with a chevron
  `text-tertiary group-hover:text-default icon-2xs flex-shrink-0 transition-[color,opacity,rotate] duration-relaxed opacity-0 group-hover:opacity-100`,
  gaining `opacity-100 rotate-90` when expanded
  (`pretty/subagent-activity-chip-group-2a2be347c052.js:14240–14273`) — **M**.

### 11.3 Notices

| Notice | Treatment | Source | M/I |
|---|---|---|---|
| Context compacted | **not a banner** — an ordinary activity row (`Ms`) with an icon `shrink-0 text-text/60`; completed state renders plain text, in-progress renders inside the shimmer wrapper | `pretty/subagent-activity-chip-group-2a2be347c052.js:8462–8580` | M |
| Copy | `Context compacted` / `Compacting context` (manual); `Optimized the conversation` / `Optimizing the conversation` (Work mode); `Context automatically compacted` / `Context automatically compacting` | `:8519–8565` | M |
| Interrupted | `Interrupting` / `Interrupted` / `Failed to interrupt`, and the turn divider's `You stopped after {time}` | `:12645–12680`; `pretty/app-initial.js:327605` | M |
| Auto-review stop | `Auto-review stopped this…` | `:8197` | M |
| Generic error card in the thread | `rounded-lg border border-default bg-surface px-4 py-3 text-sm text-secondary` with a `mb-2 font-medium text-default` title | `pretty/local-conversation-thread-b5c1b90153e1.js:17441`, `:17464` | M |
| Floating error card (right rail) | same card + `shadow-lg`, `pointer-events-auto`, positioned `absolute top-(--thread-floating-content-top-inset) right-0 bottom-(--thread-floating-content-bottom-inset) z-40` with `pe-4` | `:21240–21248` | M |
| Inline status strip | `flex items-center justify-center gap-2 px-4 py-1 text-sm text-secondary` with an `icon-xs` | `:20127–20135` | M |
| Error text | `text-danger` = `--color-text-danger` → `--vscode-errorForeground` → `--color-text-error` | `:9493`, `:7106`; css `:2249`, `:33621` | M — **`--color-text-error`'s dark value was not resolved** (§12) |

### 11.4 Subagent activity row

`pretty/subagent-activity-chip-group-2a2be347c052.js:29745–29960` — **M**:

| Property | Value |
|---|---|
| Container | `tca padding="offset"` → `<section aria-label class="flex min-w-0 items-start gap-1.5 text-base leading-5 select-none">` ⇒ 6px gap, **14px / 20px** |
| Avatar strip | `inline-flex h-5 shrink-0 items-center gap-1.5` — 20px tall, 6px gaps |
| Avatar | `size-4` = **16px**, seeded generated avatar |
| Chip cap | at most **4** rendered (`TG = 4`); names shown for the first 2 when >3 agents, otherwise for all |
| Chip element | `._chip_jj3nd_1`; clickable chips add `cursor-interaction rounded-sm focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring` |
| Entrance animation | `._chip_[data-animate-entrance] { transform-origin: 0; animation: 0.28s cubic-bezier(0.23,1,0.32,1) both _chip-enter_ }`, keyframes `0% opacity 0, translate(-8px,4px) scale(.92) → 70% opacity 1, translate(1px,-1px) scale(1.02) → 100% identity`; `@media (prefers-reduced-motion: reduce) { animation: none }` | (`pretty/subagent-activity-chip-group-48f5d9abd486.css:78–105`) |
| Sentence | one ICU string, `subagents.activity.summary`, with `<first>/<second>/<third>/<more>` tags; name tags are `inline cursor-interaction rounded-sm text-start hover:text-default focus-visible:outline-2 …`; overflow "{n} more" is a `<button class="inline cursor-interaction rounded-sm hover:text-default …">` |
| Text | `<span aria-live class="min-w-0 break-words">` |
| Delegated-prompt marker | `flex w-full flex-col items-end justify-end gap-1` with a label row `text-size-chat-sm flex items-center gap-1 px-1 py-0.5 text-codex-description` (+ `cursor-interaction rounded-md hover:text-default` when clickable) and the message capped at **2 lines** | `:8300–8380` |
| Nested-agent rail | `relative flex flex-col gap-6 py-2 ps-6 before:absolute before:inset-y-2 before:start-0 before:w-1 before:rounded-sm before:bg-border before:content-['']` ⇒ **24px indent, 4px rail in `--color-border`, 24px between entries** | `:8124` |

### 11.5 Motion tokens

| Token | Value | Source | M/I |
|---|---|---|---|
| `--transition-duration-basic` | `0.15s` | `pretty/app-initial.css:2735` | M |
| `--transition-duration-relaxed` | `0.3s` | `:2736` | M |
| `--cubic-enter` / `--ease-enter` | `cubic-bezier(0.19, 1, 0.22, 1)` | `:2733`, `:2738` | M |
| `--cubic-exit` | `cubic-bezier(0.8, 0, 0.4, 1)` | `:2734` | M |
| `--ease-enter-snappy` | `cubic-bezier(0.23, 1, 0.32, 1)` | `:2739` | M |
| `--ease-basic` | `ease` | `:2737` | M |
| `.duration-basic` / `.duration-relaxed` | bind the two durations | `:18633–18640` | M |
| Turn-header / section expand | `{ duration: 0.3, ease: [0.19, 1, 0.22, 1] }` | `pretty/app-initial.js:316608` | M |
| Subagent chip entrance | `0.28s cubic-bezier(0.23, 1, 0.32, 1)` | chunk CSS above | M |
| Composer rail | `var(--transition-duration-relaxed)` with `var(--ease-enter)`, forced to `0s` under reduced motion | `pretty/app-primary.css:3224–3234` | M |
| Shimmer | see §11.1 | | M |
| Markdown fade-in | `._MarkdownRoot_[data-markdown-animated] :is(._FadeIn_, hr, li, tr, blockquote) { opacity: 0; … }` with `@keyframes _fade-in_15pu8_1 { to { opacity: 1 } }`, image enter `_image-enter_` `opacity 0→1, scale .98→1`, and a `@media (prefers-reduced-motion: reduce)` override | `pretty/app-initial.css:374–394`, `:933–965` | M |
| Reduced-motion switch | the app also honours an explicit `:root[data-reduced-motion="true"\|"false"]` attribute alongside the media query | `pretty/app-primary.css:3227–3234` | M |

---

## 12. Cross-check against the independently measured replica (`codex-ui-kit`)

The kit at `<scratchpad>/codex-ui-kit` is a runtime-observed reimplementation. Its newest recorded build is
**26.901.51231** (`research/26.901.51231.md`); the bundle read here is **26.903.61454**, i.e. **the bundle is
newer**. Where they disagree, the bundle value is the current one — but the kit was measured against a running
app, so a kit value can be right about *rendered* geometry the CSS does not state.

| Thing | Bundle (26.903.61454) | Kit (≤26.901.51231) | Verdict |
|---|---|---|---|
| Thread max width | `--thread-content-max-width: 48rem` | `--codex-ui-thread-content-max-width: 48rem`, `--codex-ui-conversation-thread-content-max-width: 48rem` | **agree** |
| Thread inline padding | `px-toolbar` = 16px | `--codex-ui-conversation-thread-content-inline-inset: 1rem` | **agree** |
| Thread font size | `--codex-chat-font-size` = 14px | `--codex-ui-conversation-thread-font-size: 0.875rem` (14px) — note the kit's *generic* `--codex-ui-font-size-chat` is `1rem`, which is the ChatGPT-web surface, not Codex | **agree** on the Codex thread |
| Thread line-height | `calc(--codex-chat-font-size + 8px)` = 22px for chrome; markdown body `× 1.625` = 22.75px | `--codex-ui-conversation-thread-line-height: 1.375rem` (22px); `--codex-ui-line-height-chat: calc(size + 0.5rem)` (22px) | **agree** on 22px; the kit does **not** model the 22.75px markdown body line-height — bundle is more specific |
| User bubble background | `color-mix(in oklab, var(--color-text) 5%, transparent)` | `color-mix(in srgb, var(--codex-ui-text) 5%, transparent)` | agree on 5%; **colour space differs** (oklab vs srgb) — bundle is authoritative |
| User bubble max width | **70%** (`--user-chat-width` in `._bubble_`) | **77%** (`--codex-ui-user-message-max-width`) | **disagree** — bundle (newer, and read straight from the shipped CSS module) |
| User bubble compact max width | `min(456px, 100%)` | 88% | **disagree** — bundle |
| User bubble radius | `--radius-2xl` locally redefined to `calc(--spacing * 5.5)` = **22px**, squircle | `--codex-ui-radius-message: var(--codex-ui-radius-3xl)` = **20px**, round | **disagree** — bundle |
| User bubble padding | 10px × 16px (`py-2.5` + `--thread-content-margin`) | `0.5rem 0.75rem` = 8px × 12px | **disagree** — bundle |
| Turn gap | `--conversation-item-gap: 16px` (item spacers); turn-level `gapBeforePx` unresolved | `--codex-ui-thread-turn-gap: 0.75rem` (12px); `--codex-ui-conversation-thread-user-turn-gap: 2.125rem` (34px) | **cannot adjudicate** — the kit's 34px user-turn gap is a plausible measurement of the unresolved `gapBeforePx`; record both |
| Assistant action-row gap | `gap-0.5` = 2px | `--codex-ui-conversation-thread-assistant-actions-gap: 0.1875rem` (3px) | **disagree, minor** — bundle |
| Approval card radius | `rounded-3xl` ⇒ 1.25rem × 1.25 = **25px** squircle | `--codex-ui-approval-card-radius: var(--codex-ui-radius-4xl)` = **24px** | **near-agree**; the kit is 1px off and misses `corner-shape` — bundle |
| Approval card, composer presentation | not resolved (§8.4) | `border-radius: 1.5625rem` (25px), `box-shadow: 0 0 0 0.5px color-mix(text 16%), 0 3px 7.5px #0000000a, 0 0 20px #0000000d`, `min-height: 10.125rem`, background `bg-elevated @ 96%` | kit only — matches the sidebar doc's `--elevation-sidebar` shape, so plausible; **treat as kit-only evidence** |
| Approval command max height | not stated in CSS | `--codex-ui-approval-command-max-height: 20rem` | kit only |
| Shimmer duration | `--loading-shimmer-default-duration: 2s` | `--codex-ui-loading-shimmer-duration: 2s` | **agree** |
| Shimmer cadence (600/1000/4000 ms sweep) | measured | not modelled | bundle only |
| Grey ramp, blue/green/red/orange/yellow/purple ramps | `pretty/app-initial.css:2128–2205` | `src/tokens.css:5–45` | **agree**, value for value, on every step both files carry |
| Mono stack | `ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` | identical | **agree** |
| Sans stack | `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | `-apple-system, system-ui, "Segoe UI", sans-serif` | **disagree, minor** (`BlinkMacSystemFont` vs `system-ui`) — bundle |
| Font weight | `--vscode-font-weight: 430` | `--codex-ui-font-weight-shell: 445` (and no 430) | **disagree** — bundle; 430 is verified in the sibling sidebar doc too |
| Radius scale | md 10 · lg 12.5 · xl 15 · 2xl 20 · 3xl 25 · 4xl 30 (× 1.25, squircle) | md 8 · lg 10 · xl 12 · 2xl 16 · 3xl 20 · 4xl 24 (× 1, round) | **disagree** — the kit models the *base* ramp without the desktop `corner-shape` scale; bundle |
| Thread scroll easing | not stated as a token; layout is `flex-col-reverse` | `--codex-ui-thread-scroll-duration: 260ms`, `--codex-ui-thread-scroll-easing: cubic-bezier(0.22,1,0.36,1)` | kit only |
| Dark thread background | `--color-background-surface: #181818` (runtime seed) | `--codex-ui-conversation-thread-background: #171717` | **disagree by 1** — the kit sampled a composited pixel; bundle token is `#181818` |

`research/VISUAL_ASSETS.md` and `research/UI_INVENTORY.md` are runtime-observation logs (mounted-turn counts,
scroll offsets, percentage diffs between screenshots), not token sheets; they contain no numeric token that
contradicts the above.

---

## 13. A minimal recipe for brigadier

Dark theme, ready to paste. Every line traces to §1–§11.

```
/* column */
--thread-max-width:        768px          /* 48rem */
--thread-pad-x:            16px
--thread-item-gap:         16px           /* spacer div, not flex gap */
--thread-grouped-gap:      4px
--thread-indent:           24px           /* ps-6 on nested activity bodies */
--thread-pad-bottom:       32px

/* type */
--chat-font:               -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
--chat-font-weight:        430
--chat-size:               14px
--chat-line:               22px           /* chrome rows */
--chat-md-line:            22.75px        /* markdown body: 14 × 1.625 */
--chat-size-sm:            13px
--code-size:               13px
--code-line:               20px
--mono:                    ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace
--md-space:                3.5px          /* = chat-size / 4; the whole markdown rhythm */

/* user bubble */
--user-bubble-bg:          rgba(223,223,223,0.05)
--user-bubble-fg:          #dfdfdf
--user-bubble-radius:      22px           /* superellipse(1.5) if you can */
--user-bubble-pad:         10px 16px
--user-bubble-max-width:   70%
--user-bubble-align:       flex-end

/* activity rows */
--activity-dim:            rgba(223,223,223,0.60)   /* text-text/60 */
--activity-dimmer:         rgba(223,223,223,0.40)
--activity-dimmest:        rgba(223,223,223,0.30)
--activity-hover-fg:       #dfdfdf                  /* whole row brightens, except on a file link */
--activity-icon-gap:       6px
--activity-chevron:        14px, opacity 0 → 1 on hover, rotate 90deg, 0.3s
--activity-collapse-lines: 20             /* 2 in the compact summary */

/* turn header */
--turn-header-fg:          rgba(223,223,223,0.60)   /* + tabular-nums */
--turn-header-rule:        1px solid rgba(255,255,255,0.084)
--turn-header-anim:        300ms cubic-bezier(0.19, 1, 0.22, 1)   /* height + opacity */

/* file-change card */
--card-border:             1px solid rgba(255,255,255,0.084)
--card-radius:             12.5px
--card-header-bg:          rgba(255,255,255,0.047)  /* ghost-hover @ 60% */
--card-header-pad:         2px 10px
--card-header-fg:          rgba(255,255,255,0.398)  /* codex-description @ 80% */
--card-body-bg:            rgb(40,40,40)
--diff-add:                #40c977
--diff-del:                #fa423e
--diff-add-tint:           rgba(64,201,119,0.23)
--diff-del-tint:           rgba(250,66,62,0.23)

/* approval card */
--approval-bg:             rgb(45,45,45)
--approval-radius:         25px
--approval-border:         1px solid rgba(255,255,255,0.084)
--approval-pad-head:       16px 16px 12px
--approval-pad-actions:    8px 16px 16px
--approval-btn-height:     28px
--approval-primary-bg:     #dfdfdf
--approval-primary-fg:     rgb(45,45,45)
--approval-outline-bg:     rgba(255,255,255,0.032)
--approval-outline-hover:  rgba(255,255,255,0.078)
--approval-keycap:         currentColor @ 10%, radius 10px, 12px/16px, 16px tall, 6px pad
--approval-keys:           Enter = approve, Escape = deny

/* code */
--code-block-bg:           rgba(255,255,255,0.052)
--code-block-border:       1px solid rgba(255,255,255,0.042)
--code-block-radius:       20px                    /* superellipse(1.1) */
--code-block-pad:          16px  (20px inline ≥768px)
--inline-code-bg:          color-mix(in srgb, rgba(255,255,255,0.078) 60%, rgba(223,223,223,0.06))
--inline-code-radius:      6px
--inline-code-pad:         1px 6px
--inline-code-size:        0.92em

/* shared */
--border:                  rgba(255,255,255,0.084)
--border-subtle:           rgba(255,255,255,0.042)
--border-strong:           rgba(255,255,255,0.156)
--ghost-hover:             rgba(255,255,255,0.078)
--surface:                 #181818
--surface-tertiary:        rgb(40,40,40)
--surface-elevated:        rgb(45,45,45)
--text:                    #dfdfdf
--text-secondary:          rgba(223,223,223,0.65)
--text-tertiary:           rgba(255,255,255,0.498)
--ring:                    rgba(131,195,255,0.76)
--duration-basic:          0.15s
--duration-relaxed:        0.3s
--ease-enter:              cubic-bezier(0.19, 1, 0.22, 1)
--ease-exit:               cubic-bezier(0.8, 0, 0.4, 1)
--ease-enter-snappy:       cubic-bezier(0.23, 1, 0.32, 1)
```

Five behaviours worth copying and easy to miss:

1. **The timeline is `flex-col-reverse`.** Bottom-anchoring is layout, not scroll scripting.
2. **Turns are `display: contents`.** All vertical rhythm comes from explicit spacer `<div>`s sized by
   `--conversation-item-gap`, never from `gap` on a turn wrapper.
3. **Activity rows have no hover fill.** The `ghostMuted` button variant explicitly sets
   `hover:bg-transparent`; the only feedback is the text going from 60 % to 100 %, the chevron fading in, and
   the `+A −D` numbers *gaining* their colour. And hovering a file link inside the row suppresses all of it.
4. **The working line is a cadenced sweep, not a pulse.** 600 ms delay, 1 s sweep, 4 s period, and the whole
   thing is inert under `prefers-reduced-motion`.
5. **Expanding an activity row scrolls to compensate.** A `ResizeObserver` on the turn keeps the header
   pinned for 350 ms or until the user touches the wheel/keyboard.

---

## 14. Not found / not checked

- **"Review" and "Undo" buttons on the file-change card.** Not present in these chunks: the header carries
  only a copy button, and expansion is a per-file *Toggle diff* chevron. Either the brief's naming differs
  from the shipping UI, or those controls live in a surface I did not locate (the review side-panel is a
  separate chunk, `local-conversation-git-actions-*.js`, not read).
- **Whether the approval card is inline in the timeline or docked above the composer.** `ApprovalCard` is a
  position-free component with four call sites (`pretty/app-primary.js:395656, 397711, 397862, 405497,
  405640`); the composer rail (§10) is the docking mechanism the app has, and the kit records a
  `data-presentation="composer"` variant, but I did not trace a call site to a rail portal.
- **The default turn-to-turn `gapPx`.** `thread-virtualizer` takes it as a prop; the local Codex thread's
  caller minifies the name away and `grep gapPx` finds no match in `local-conversation-thread-*.js`. The kit
  says 34px for a user turn — recorded but unverified.
- **`$ir`, the Button *default* radius map** (used when no `radius` prop is passed). The `far` override map
  (`full`/`large`/`small`) was read; `$ir` was not.
- **`--color-text-error`'s resolved dark value.** The chain `text-danger → --color-text-danger →
  --vscode-errorForeground → --color-text-error` is measured; the leaf is not written by the runtime
  generator and its `.electron-dark` value was not read.
- **Whether the `.dark` class (which the shimmer's dark colours are scoped to) is applied on the Electron
  root.** The root gets `.electron-dark`; if `.dark` is absent the shimmer falls back to
  `--shimmer-contrast: #ffffffbf` and `--shimmer-text-secondary: color-mix(text-primary 55%)`. Both branches
  are recorded in §11.1.
- **`--color-background-info-soft`, `--color-background-status-*`** and other tokens the thread touches only
  in states I did not enumerate.
- **Light theme.** Out of scope by request and not free: the same generator produces it via `cCa()`
  (`pretty/app-initial.js:345872`) from `{ ink: '#1a1c1f', surface: '#ffffff', contrast: 45 }`, with
  `diffAdded: '#00a240'`, `diffRemoved: '#ba2623'`; markdown, spacing and radii are theme-independent, so
  §§1–8 carry over unchanged and only §9 would need re-running.
- **Anything requiring the app to be running.** No screenshots, no DevTools, no computed styles. Every value
  above is read from the shipped source; the two places where a rendered pixel would settle a question are
  flagged in §12.
- **Syntax-highlight token colours** for fenced code. The kit carries a full set
  (`--codex-ui-code-syntax-dark-*`); I did not locate the bundle's own theme to confirm them.

## See also

- `codex-thread-anatomy.md` — the `codex app-server` protocol's data model and the reference client's
  behaviour; this file covers only the desktop app's pixels, not its wire shapes.
- `codex-ui-kit.md` — the independent component library cross-checked against in §12; its licence terms and
  component inventory.
- `codex-thread-row-mapping.md` — the minimal-recipe token set in §13 above feeds directly into that file's
  row-by-row component picks.
- `docs/research/codex-sidebar.md` — the sibling extraction covering the sidebar (not the thread), from the
  same app bundle.
