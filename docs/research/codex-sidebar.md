# Codex desktop sidebar — exact design tokens (dark theme)

Researched 2026-09-10 against the shipping app bundle. Read-only; nothing in `/Applications` was modified.

**Target:** OpenAI Codex desktop UI, which ships inside `/Applications/ChatGPT.app` (Electron 42.3.0,
`app/package.json` `name: "openai-codex-electron"`, `productName: "Codex"`, `version: 26.903.61454`).

**Purpose:** let a builder reproduce the Codex sidebar in brigadier's Tauri shell without guessing.

---

## 0. How to reproduce this extraction, and how to read the citations

```sh
npx --yes @electron/asar extract /Applications/ChatGPT.app/Contents/Resources/app.asar ./app
npx --yes prettier@3 --parser css  ./app/webview/assets/app-initial-49fc08c26651.css > pretty/app-initial.css
npx --yes prettier@3 --parser css  ./app/webview/assets/app-primary-d815831c9bad.css > pretty/app-primary.css
npx --yes prettier@3 --parser babel ./app/webview/assets/app-initial-1b87ae739476.js > pretty/app-initial.js
npx --yes prettier@3 --parser babel ./app/webview/assets/app-primary-e25aaf15dbaf.js > pretty/app-primary.js
npx --yes prettier@3 --parser babel ./app/.vite/build/main-D87AK7lw.js               > pretty/main.js
```

Everything lives in the scratchpad at
`/private/tmp/claude-501/-Users-stephen-Development-brigadier-ai/6b8c7823-87dc-4947-b48d-7e6f4a385cd5/scratchpad/`.

**Citation form.** The shipped files are minified onto one or a few lines, so line numbers alone would be
useless. Every citation below is `<bundle-relative path> → pretty/<file>:<line>`, where the second half is the
line in the prettier-beautified copy listed above. Bundle-relative paths are relative to the extracted asar
root (`webview/…`, `.vite/build/…`).

**Marking.** Every row is tagged **M** (measured — read out of the CSS/JS, or sampled from a screenshot with a
stated method) or **I** (inferred — reasoned, not read). Nothing here is a guess dressed as a fact.

**A warning that changes everything below.** The stylesheet's `.electron-dark` block is only a *fallback*.
At runtime Codex computes its whole colour palette in JS from a four-field seed and writes it as **inline
custom properties on `<html>`** (`zY(documentElement, tokens)`,
`webview/assets/app-initial-1b87ae739476.js → pretty/app-initial.js:345661`). Those inline values win over the
stylesheet. §2 gives both. Where they differ, the runtime value is the one the user sees — and the runtime
value is what matches the owner's screenshots to the pixel (see §7).

---

## 1. Window setup: vibrancy, transparency, focus

| What | Value | Source | M/I |
|---|---|---|---|
| Window `titleBarStyle` (macOS) | `hiddenInset` | `.vite/build/main-D87AK7lw.js → pretty/main.js:152616` | M |
| `trafficLightPosition` | `{ x: 16, y: Math.round((46*zoom - 14)/2) }` → `{x:16, y:16}` at zoom 1 | `pretty/main.js:151310` | M |
| `vibrancy` (macOS) | `'menu'` — **not** `'sidebar'`, `'under-window'` or `'fullscreen-ui'`. Applied only when the user's "opaque window surface" setting is off. | `pretty/main.js:152620` (`...(t ? {} : { vibrancy: 'menu' })`) | M |
| `visualEffectState` | **never set** — Electron's default (`followWindow`) applies | grepped all of `.vite/build/*` | M |
| `transparent` | not set for the main window (only for `quickChat`) | `pretty/main.js:152618` | M |
| `backgroundColor` | `#00000000` when translucent; `#000000` (dark) / `#f9f9f9` (light) when opaque | `pretty/main.js:151292–151294`, `152530–152543` | M |
| `backgroundMaterial` | `'mica'` on win32 only; `null` on darwin | `pretty/main.js:152530–152543` | M |
| Windows/Linux | `titleBarStyle:'hidden'` + `titleBarOverlay {color:'#00000000', symbolColor: dark?'#ffffff':'#1f1f1f', height: round(36*zoom)}` | `pretty/main.js:152627–152632`, `151313` | M |
| Renderer root background | `[data-codex-window-type="electron"] { background: 0 0 }` → transparent | `webview/assets/app-initial-49fc08c26651.css → pretty/app-initial.css:34910` | M |
| Renderer `body` background | `[data-codex-window-type="electron"]:not([data-codex-window-chrome="application-menu"]) body { background: 0 0 }` | `pretty/app-initial.css:34991` | M |
| Opaque escape hatch | class `.electron-opaque` on the root → `background-color: var(--color-background-surface-under)`. Toggled from a **user setting**, not from focus. | `pretty/app-initial.css:35058`; toggle at `pretty/app-initial.js:425125` | M |

### The sidebar's own background

```css
[data-codex-window-type="electron"]:not([data-codex-window-chrome="application-menu"])
  :is([data-app-shell-unified-tab-strip="true"],
      .app-shell-left-panel:not([data-app-shell-left-panel-appearance="content-surface"])) {
  background: var(--color-surface-tertiary);                                   /* fallback  */
  background: color-mix(in srgb, var(--color-surface-tertiary) 70%, transparent); /* @supports */
}
```
`pretty/app-initial.css:35004–35023` — **M**

So: **the sidebar is a 70 %-alpha tint of `--color-surface-tertiary` painted over the macOS `menu` vibrancy
material.** In the default dark theme `--color-surface-tertiary` resolves at runtime to `rgb(40, 40, 40)`, so
the tint is `rgba(40, 40, 40, 0.7)` (**M**, §2). There is also a right-edge bleed pseudo-element so the tint
continues under the rounded content pane:

```css
.app-shell-left-panel:not([…content-surface])::after {
  inset: 0 calc(-1 * var(--radius-2xl)) 0 auto;
  width: var(--radius-2xl); background: inherit; position: absolute; pointer-events: none;
}
```
`pretty/app-initial.css:35044–35052` — **M**

### What happens when the window loses focus

Entirely native, nothing in CSS. On `blur`/`hide` the main process re-runs `applyWindowBackdrop`:

```js
e.setBackgroundColor(a),
o != null && e.setBackgroundMaterial(o),
process.platform === `darwin` && e.setVibrancy(KRe(t, i));
```
`pretty/main.js:152301–152319`, with `KRe(t,i) = i || I9(t) ? null : 'menu'` (`:152545`) and
`URe({appearance, isFocused, platform}) = !isFocused && !I9(appearance) && platform === 'darwin'` (`:152499`).
Handlers: `P.on('focus'|'blur'|'show'|'hide', ne)` (`:151939–151960`). — **M**

Net effect: **unfocused ⇒ `setVibrancy(null)` + an opaque `backgroundColor`; the translucency stops sampling
the desktop and the sidebar flattens.** The renderer is told (`electron-window-focus-changed`) but *ignores*
it — the handler is an explicit no-op at `pretty/app-initial.js:471591`. There is no `:window-inactive`,
`data-window-active` or equivalent anywhere in the renderer or the CSS. — **M**

Screenshot corroboration (§7): focused over a colourful desktop the sidebar samples it (`rgb(42,53,58)`);
unfocused it is a flat `rgb(34,34,34)`.

### Fullscreen / traffic-light inset

| Step | Value | Source | M/I |
|---|---|---|---|
| Main → renderer | `{type:'window-fullscreen-changed', isFullScreen}` on `enter-full-screen`/`leave-full-screen` | `pretty/main.js:151932–151938` | M |
| Renderer stores it | atom `g1`, default `false` | `pretty/app-initial.js:471588`, `372897` | M |
| Inset table | `default {left:0,right:0}`, `mac.legacy {left:82,right:0}` (≤10.15), `mac.modern {left:92,right:0}` | `pretty/app-initial.js:372998–373005` | M |
| Selection | `A$a(isFullScreen, overlayRect)`: **`if (isFullScreen) return {left:0,right:0}`**; otherwise macOS ⇒ the static 82/92 guess (parsed from the UA string), win/linux ⇒ live `navigator.windowControlsOverlay.getTitlebarAreaRect()` | `pretty/app-initial.js:372923–372941`, `372913` | M |
| CSS var written | `--spacing-token-safe-header-left: ${rect.left / zoom + 6}px` (and `…-right: ${rect.right/zoom}px`) | `pretty/app-initial.js:378378` | M |
| Consumer | `._FloatingHeader_ihb90_2 { height: var(--height-toolbar); padding-inline-start: max(var(--spacing-token-safe-header-left), 0.5rem); padding-inline-end: 8px }` | `pretty/app-initial.css:1152–1158` | M |

**So the toggle button's left offset is `98px` in a normal macOS window (92 + 6) and collapses to
`max(6px, 8px) = 8px` in fullscreen.** Note the `+6` constant means the variable never actually reaches 0.
`setWindowButtonVisibility` is never called. — **M**

In the *docked* (non-floating) sidebar the traffic-light row is instead reserved by a plain drag spacer above
the header: `<div className="h-toolbar w-full shrink-0 draggable" />` (`pretty/app-initial.js:414514`, 46px) —
or the `paddingTop` prop on `LeftPanel` in the newer resizable layout (`pretty/app-initial.js:374842`). — **M**

---

## 2. Global tokens (dark)

### 2a. The runtime theme generator (this is what actually renders)

Default dark seed (`pretty/app-initial.js:346072`):
`{ accent: '#339cff', contrast: 60, ink: '#ffffff', surface: '#181818', opaqueWindows: false }` — **M**

Derivation: `rCa()` (`:345745`) normalises contrast via `dCa()` (`:346021`) → `0.6`; `uCa()` (`:345934`)
builds the dark ramp; `sCa()` (`:345782`) maps it to `--color-*` names; `zY()` (`:345661`) writes them inline
on `<html>`. I re-implemented those four functions verbatim
(`scratchpad/theme.js`) and ran them. Output — **M** (computed from the shipped code, not sampled):

| `--color-*` token | resolved dark value | note |
|---|---|---|
| `--color-background-surface` | `#181818` | the seed surface |
| `--color-background-surface-under` | `#141414` | |
| `--color-background-editor-opaque` | `rgb(40, 40, 40)` | **this is the sidebar tint colour** |
| `--color-background-panel` | `#232323` | |
| `--color-background-control-opaque` | `rgb(45, 45, 45)` | **tooltip background** |
| `--color-background-control` | `rgba(45, 45, 45, 0.96)` | |
| `--color-background-elevated-primary` | `rgba(54, 54, 54, 0.96)` | menus |
| `--color-background-elevated-primary-opaque` | `rgb(54, 54, 54)` | |
| `--color-background-elevated-secondary` | `rgba(255, 255, 255, 0.032)` | |
| `--color-background-elevated-secondary-opaque` | `#282828` | |
| `--color-background-button-secondary` | `rgba(255, 255, 255, 0.052)` | |
| `--color-background-button-secondary-hover` | `rgba(255, 255, 255, 0.078)` | **the hover/active pill** |
| `--color-background-button-secondary-active` | `rgba(255, 255, 255, 0.12)` | |
| `--color-background-button-tertiary-hover` | `rgba(255, 255, 255, 0.068)` | |
| `--color-border` | `rgba(255, 255, 255, 0.084)` | |
| `--color-border-heavy` | `rgba(255, 255, 255, 0.156)` | |
| `--color-border-light` | `rgba(255, 255, 255, 0.042)` | |
| `--color-border-focus` | `rgba(131, 195, 255, 0.76)` | |
| `--color-icon-primary` | `rgba(255, 255, 255, 0.904)` | |
| `--color-icon-secondary` | `rgba(255, 255, 255, 0.71)` | |
| `--color-icon-tertiary` | `rgba(255, 255, 255, 0.51)` | |
| `--color-text-foreground` | `var(--gray-150)` = `#dfdfdf` | the built-in dark preset takes this branch (`lCa()` true) |
| `--color-text-foreground-secondary` | `rgba(255, 255, 255, 0.71)` | |
| `--color-text-foreground-tertiary` | `rgba(255, 255, 255, 0.498)` | |
| `--color-text-accent` | `rgb(131, 195, 255)` | |

The static `.electron-dark` stylesheet fallbacks (used only if the JS never runs) are close but not identical:
`--color-background-surface: var(--gray-900)` = `#181818` (`pretty/app-initial.css:16538`),
`--color-background-editor-opaque: var(--gray-800)` = `#212121` (`:16569`),
`--color-background-button-secondary-hover: #ffffff14` (`:16645`),
`--color-border: #ffffff14` (`:16830`),
`--color-text-foreground: var(--gray-150)` = `#dfdfdf` (`:16758`),
`--color-icon-primary: #ffffffe6` (`:16792`). — **M**

The grey ramp (identical in light and dark; only which step a semantic token points at changes),
`pretty/app-initial.css:2128–2146` — **M**:
`--gray-0 #ffffff · 50 #f9f9f9 · 75 #f3f3f3 · 100 #ededed · 150 #dfdfdf · 200 #cdcdcd · 250 #b9b9b9 ·
300 #afafaf · 400 #8f8f8f · 500 #5d5d5d · 550 #4f4f4f · 600 #414141 · 650 #393939 · 700 #303030 ·
750 #282828 · 800 #212121 · 900 #181818 · 950 #131313 · 1000 #0d0d0d`

### 2b. Semantic aliases the sidebar actually uses

Every `--color-*` semantic name reaches the runtime palette through a VS Code–named bridge scoped to
`:is([data-codex-window-type="browser"|"chrome-extension"|"electron"])` at `pretty/app-initial.css:33612–33860`.
Resolved chains (all **M**):

| CSS name used in markup | chain | dark value |
|---|---|---|
| `--color-text` (`.text-default`) | `--vscode-foreground` → `--color-text-foreground` | `#dfdfdf` |
| `--color-text` **inside the sidebar `<nav>`** | `._Navigation_1ej6d_2 { --color-text: color-mix(in oklab, var(--color-background-primary-solid) 85%, transparent) }`, and `--color-background-primary-solid: var(--vscode-foreground)` | `rgba(223, 223, 223, 0.85)` |
| `--color-text-secondary` | `color-mix(in srgb, var(--vscode-foreground) 65%, transparent)` | `rgba(223, 223, 223, 0.65)` |
| `--color-text-tertiary` | `--vscode-descriptionForeground` → `--color-text-foreground-tertiary` | `rgba(255, 255, 255, 0.498)` |
| `--color-text-emphasis` | `--vscode-list-activeSelectionForeground` → `--color-text-foreground` | `#dfdfdf` (100 %) |
| `--color-codex-description` | `--vscode-descriptionForeground` | `rgba(255, 255, 255, 0.498)` |
| `--color-codex-icon-active` | `--vscode-list-activeSelectionIconForeground` → `--color-icon-primary` | `rgba(255, 255, 255, 0.904)` |
| `--color-background-primary-ghost-hover` | `--vscode-list-hoverBackground` → `--color-background-button-secondary-hover` | `rgba(255, 255, 255, 0.078)` |
| `--color-surface` | `--color-background-surface` | `#181818` |
| `--color-surface-tertiary` | `--vscode-editor-background` → `--color-background-editor-opaque` | `rgb(40, 40, 40)` |
| `--color-surface-elevated-secondary` | `--vscode-dropdown-background` → `--color-background-control-opaque` | `rgb(45, 45, 45)` |
| `--color-border` / `-subtle` / `-strong` | direct / `--color-border-light` / `--color-border-heavy` | `.084` / `.042` / `.156` white |
| `--color-token-foreground` | `--vscode-foreground` | `#dfdfdf` |

Key lines: `pretty/app-initial.css:2208` (`--color-text`), `:2213`+`:2218` (secondary), `:2227` (tertiary),
`:2209` (emphasis), `:2402` (primary-solid), `:2383` (ghost-hover), `:2342/2348/2350` (surfaces),
`:2555/2558` (codex-description / icon-active), `:2802` (token-foreground);
bridge at `:33619, 33622, 33652, 33846, 33884, 33885, 33889`;
sidebar `<nav>` override at `webview/assets/app-primary-d815831c9bad.css → pretty/app-primary.css:3204–3215`.

### 2c. Typography

| Token | Electron value | Source | M/I |
|---|---|---|---|
| `--font-sans-default` | `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | `pretty/app-initial.css:2675` (inside `:root, :host`) | M |
| `--font-sans` | `var(--vscode-font-family, var(--font-sans-default))` | `:2028` | M |
| `--vscode-font-family` (electron) | `inherit` | `:33613` | M |
| `--font-openai-sans` | `"OpenAI Sans", var(--font-sans-default)`; faces bundled as `OpenAISans-Regular-c56711d328c4.woff2` (400) and `OpenAISans-Medium-7b9c963f9063.woff2` (500) | `:2678`, `:33526–33538` | M |
| `body` | `font-family: var(--vscode-font-family); font-weight: var(--vscode-font-weight)` | `:35181–35187` | M |
| `--vscode-font-weight` (electron) | **`430`** — a variable-font weight between Regular and Medium | `:34909` | M |
| `--text-xs` | `12px` (electron override of the base `11px`) | `:34912` / base `:2068` | M |
| `--text-sm` | `13px` (electron override of the base `12px`) | `:34911` / base `:2070` | M |
| `--text-base` | `14px` | `:2072` | M |
| `--text-lg` | `16px` | `:2074` | M |
| line-heights | `xs 1.333 · sm 1.429 · base 1.5 · lg 1.556` | `:2069, 2071, 2073, 2075` | M |
| weights | normal 400 · medium 500 · semibold 600 | `:2087–2089` | M |
| letter-spacing | no per-size letter-spacing tokens exist; `--text-tracking` is set to `0em` by a utility class (`:20286`), `--tracking-tight/-normal/-wide = -0.025em / 0 / 0.025em` (`:2091–2093`) | | M |

**Practical read for a builder:** sidebar rows are the system UI font (SF on macOS) at **14 px / weight 430 /
line-height 1.5**. Only the app-name dropdown uses OpenAI Sans.

### 2d. Radius, spacing, transitions

| Token | Value | Source | M/I |
|---|---|---|---|
| `--spacing` | `0.25rem` (4px) | `pretty/app-initial.css:2057` | M |
| `--radius-*-base` | sm `0.375rem` · md `0.5rem` · lg `0.625rem` · xl `0.75rem` · 2xl `1rem` · 3xl `1.25rem` | `:2687–2693` | M |
| `--corner-radius-scale` | `1` by default; **`1.25`** inside `@supports (corner-shape: superellipse(1.5))` | `:2685`, `:35157` | M |
| `--codex-corner-shape` | `superellipse(1.5)` (electron) / `round` (browser window) | `:35158`, `:35169` | M |
| ⇒ effective radii in Codex desktop | sm 7.5px · md 10px · lg **12.5px** · xl 15px · 2xl **20px**, all drawn as squircles | derived | I (arithmetic is certain; the `@supports` gate is not directly observable — but Electron 42 ships Chromium ≳144 and `corner-shape` landed in Chrome 139, so it is taken) |
| `--radius-button-toolbar` | `var(--radius-lg)` = 12.5px | `:2721` | M |
| `--transition-duration-basic` / `-relaxed` | `0.15s` / `0.3s` | `:2735–2736` | M |
| `--cubic-enter` / `--cubic-exit` | `cubic-bezier(0.19,1,0.22,1)` / `cubic-bezier(0.8,0,0.4,1)` | `:2733–2734` | M |
| `--height-toolbar` / `-sm` / `-pane` | `46px` / `36px` / `40px` | `:2707–2709` | M |
| `--spacing-token-button-composer` | `calc(var(--spacing)*7)` = **28px** (electron) | `:2717` | M |
| `--spacing-button-toolbar-inline` | `8px` | `:2720` | M |
| icon sizes | `icon-2xs` 14px · `icon-xs` 16px · `icon-sm` 18px · `icon-base` 20px · `icon-md` 24px · `icon-lg` 28px · `icon-disclosure` 14px · `icon-leading` 16px | `:1728–1755`, `:5132`, `:5387` | M |
| `--icon-leading-size` (electron) | `16px` | `:2671` | M |
| `--border-width-hairline` | `0.5px` | `:2697` | M |
| `--elevation-sidebar` | `0 0 0 0.5px var(--color-border-strong), 0 3px 7.5px #00000008, 0 0 16px #00000005` | `:35085` | M |

Sidebar open/close animation: a motion spring `{ type:'spring', duration: 0.5, bounce: 0.1 }`
(`pretty/app-initial.js:202125`, applied through `lM → v2n → Pu(…, Kj)` at `:202347/202502`). Section
expand/collapse: `{ duration: 0.3, ease: [0.19, 1, 0.22, 1] }` (`pretty/app-initial.js:316608`). — **M**

---

## 3. Sidebar geometry, resizing and persistence

| Property | Value | Source | M/I |
|---|---|---|---|
| Width token | `--spacing-token-sidebar: clamp(240px, var(--codex-sidebar-preferred-width, 275px), min(520px, calc(100vw - 320px)))` | `pretty/app-initial.css:2712–2716` | M |
| Default width | **275px** | same; also `cM()` returns `275` for a non-finite stored value, `pretty/app-initial.js:202311` | M |
| Min width | **240px** | `cM(): Math.max(240, …)`, `pretty/app-initial.js:202311` | M |
| Max width | **520px**, further clamped to `shellWidth − 240` | `Z0n = 520`, `pretty/app-initial.js:202318` | M |
| Resizable | yes — pointer drag on a 16px hit strip at the right edge, plus keyboard (`ArrowLeft/Right/Home/End`) via `role="separator"` | `pretty/app-initial.js:371793` (`GQa`), `372060` (`YQa`) | M |
| Handle geometry | `w-4` (16px) hit area, `-translate-x-2`/`translate-x-2` so it straddles the edge; `cursor-col-resize` | `pretty/app-initial.js:372190–372194` | M |
| Handle visual | a 1px full-height line, `bg-gradient-to-b from-transparent via-text/25 to-transparent`, `opacity-0` at rest → `opacity-100` on `group-hover/panel-resizer`, active, or focus-visible | `pretty/app-initial.js:372099–372110` | M |
| Collapse threshold | dragging below `240px` collapses the sidebar instead of resizing | `pretty/app-initial.js:374874–374882` | M |
| Persistence key | `"sidebar-width"` (`Q0n`), written on `onResizeEnd` through the app's persisted-atom store | `pretty/app-initial.js:202318`, `202305–202310` | M — key and clamp read from source; that the store is literally `localStorage` was **not** confirmed |
| Collapsed | `pM` atom false; the panel animates to width 0 with the spring in §2d | `pretty/app-initial.js:202347` | M |
| Keyboard | ⌘B (`toggleSidebar` command, `codex.command.toggleSidebar`) | `pretty/app-initial.js:8651920` region / `pretty/app-initial.js:202360` | M |

Local overrides that the sidebar sets on itself (`.sidebar-navigation`, `pretty/app-initial.css:19997–20003`) — **M**:

```css
.sidebar-navigation {
  --height-token-mode-switch: 32px;
  --height-token-nav-row: 30px;
  --height-token-row: var(--height-token-nav-row);
  --padding-row-cell-x: 8px;
  --padding-row-x: 8px;
  --radius-token-row: 10px;
}
```

(The `<body>`-level formula `--height-token-nav-row: calc(var(--text-base)*1.5 + var(--padding-row-y)*2)`
= 31px at `pretty/app-initial.css:34925` is shadowed inside the sidebar by the flat `30px` above.
`--padding-row-y` is `calc(var(--spacing)*1.25)` = **5px**, `pretty/app-initial.css:34924`.)

---

## 4. Element-by-element token table

Structure, top to bottom:

```
aside.app-shell-left-panel                       ← 70 % tint over vibrancy, resize handle at its right edge
└ div  (h-toolbar drag spacer / paddingTop)      ← 46 px, reserves the traffic-light row
└ div.sidebar-navigation
  ├ nav._Navigation_1ej6d_2                      ← --color-text dimmed to 85 %
  │ ├ header  (px-row-x, pb 8 px, gap-2)
  │ │ ├ row 1: [toggle] [back] [forward]
  │ │ └ row 2: [Codex ⌄]                [search] [bell]
  │ └ scroll area (gap-4 between sections, mb = footer height)
  │   ├ section: New chat / Pull requests / Scheduled / Plugins / Explore   (gap-px)
  │   ├ section: "Projects" header  →  folder rows  →  nested thread rows
  │   └ section: "Recents" header (collapsed)
  └ footer (absolute, inset-x-0 bottom-0, z-20)
```

### 4.1 Panel shell

| Property | Value | Source | M/I |
|---|---|---|---|
| classes | `app-shell-left-panel pointer-events-auto relative flex overflow-visible` | `webview/assets/app-initial-1b87ae739476.js → pretty/app-initial.js:374832` | M |
| width | inline `style.width` from the animated width atom; docked legacy variant uses `w-token-sidebar` = `--spacing-token-sidebar` | `pretty/app-initial.js:374841`, `414511` | M |
| background | `rgba(40,40,40,0.7)` over the `menu` vibrancy (see §1) | `pretty/app-initial.css:35004` | M |
| inner scroll wrapper | `relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden sidebar-navigation` | `webview/assets/app-primary-e25aaf15dbaf.js → pretty/app-primary.js:333501` | M |
| scroll area | `vertical-scroll-fade-mask relative isolate mb-[var(--sidebar-footer-height)] flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden scroll-pb-[var(--padding-row-x)] pb-row-x [--radius-token-row:10px] [contain:layout_paint]` → **16px between sections**, 8px bottom pad | `pretty/app-primary.js:328636` | M |
| footer height fed back | `--sidebar-footer-height` set inline from a measured ref | `pretty/app-primary.js:332958` | M |
| `nav` element | `._Navigation_1ej6d_2 { --color-text: color-mix(in oklab, var(--color-background-primary-solid) 85%, transparent); anchor-name: --codex-sidebar-customization-width; flex:1; min-height:0; display:flex; flex-direction:column }` | `pretty/app-primary.css:3204–3222` | M |

### 4.2 Top chrome — row 1 (toggle, back, forward)

| Property | Value | Source | M/I |
|---|---|---|---|
| header wrapper | `relative z-10 flex shrink-0 flex-col gap-2 px-row-x pb-(--sidebar-scroll-header-spacing)` → 8px side padding, **8px gap between the two rows**, 8px bottom padding | `pretty/app-primary.js:141672`; spacing default 8px at `pretty/app-initial.css:14580` + `pretty/app-primary.css:3130` | M |
| header scrolled state | adds `after:… after:h-[0.5px] after:bg-text/10` hairline | `pretty/app-primary.js:141668` | M |
| row 1 container | `flex items-center gap-1` (4px) | `pretty/app-initial.js:372752` | M |
| toggle button | Button `color="ghost" size="toolbar" uniform focusRing="inset"`, extra class `group/sidebar-trigger` | `pretty/app-initial.js:372622`, `372792–372804` | M |
| ⇒ resolved | 28 × 28 (`--spacing-token-button-composer`), `aspect-square … !px-0`, `rounded-lg` (12.5px squircle) because `size==='toolbar' && uniform` | `pretty/app-initial.js:215723`, `:215731` | M |
| toggle idle colour | `text-tertiary` = `rgba(255,255,255,0.498)` | `pretty/app-initial.js:215822` | M |
| toggle hover bg | `enabled:hover:bg-primary-ghost-hover` = `rgba(255,255,255,0.078)` | same | M |
| toggle icon | `icon-xs` = 16px | `pretty/app-initial.js:372605` | M |
| back / forward | same `b$a` toolbar button; forward is the back asset with `-scale-x-100` | `pretty/app-initial.js:372698–372730` | M |
| disabled state | `disabled:opacity-40 disabled:cursor-default` | `pretty/app-initial.js:215748` | M |
| whole header is draggable | the spacer above it is `draggable` (`-webkit-app-region: drag`); buttons inside carry `no-drag` | `pretty/app-initial.css:20016–20021`; `pretty/app-initial.js:215747` | M |

### 4.3 Top chrome — row 2 (app-name dropdown, search, bell)

| Property | Value | Source | M/I |
|---|---|---|---|
| row container | `ms-2 flex items-center pe-1` | `pretty/app-primary.js:333350` | M |
| right group | `ms-auto flex items-center gap-1` | `pretty/app-primary.js:333359` | M |
| app-name button | `-ms-2 h-8 min-w-0 rounded-xl px-2 !text-[17px] !leading-6 font-medium focus-visible:ring-2 focus-visible:ring-ring`, `color="ghostActive"`, `focusRing="inset"` | `pretty/app-primary.js:149380` | M |
| ⇒ resolved | 32px tall, 8px side padding, radius-xl = 15px squircle; `ghostActive` = `text-default` + `hover:bg-primary-ghost-hover` | `pretty/app-initial.js:215829` | M |
| app-name label | `truncate font-openai-sans font-semibold` → **OpenAI Sans 600, 17px / 24px, `#dfdfdf`** | `pretty/app-primary.js:149273` | M |
| dropdown chevron | `icon-2xs shrink-0 text-tertiary` → 14px, `rgba(255,255,255,0.498)` | `pretty/app-primary.js:149372` | M |
| search button | Button `color="ghost" size="compact" uniform`, icon `icon-leading` (16px), animated icon key `sidebar-search` | `pretty/app-primary.js:146134–146152` | M |
| ⇒ resolved | `h-6` = 24 × 24, `rounded-lg` (12.5px), `text-tertiary`, hover `rgba(255,255,255,0.078)` | `pretty/app-initial.js:215843` (`compact: h-6 px-2 py-0 text-xs leading-4`) | M |
| bell / Activity | component `kkn` rendered with **no `mode` prop** ⇒ `mode: 'toggle'`; delegates to `Akn`, which picks Button `color = active ? 'accentSubtle' : 'ghost'`, `size = 'compact'`, icon `Pn` idle / `zue` when threads need attention | `pretty/app-primary.js:333364`, `147917`, `147967–147978` | M |
| ⇒ resolved | `h-6` = 24px tall, 8px side padding, `rounded-lg` (12.5px), `text-tertiary`, hover `rgba(255,255,255,0.078)`; icon asset **`bell-light-20`** | `pretty/app-initial.js:215843`, `252184` | M |
| the third header slot | `FSn` is **not** a bell — it is the browser-tab media indicator (camera/mic/audio), normally absent | `pretty/app-primary.js:134987`, `134659` | M |
| `.sidebar-icon-button` | `24 × 24; border-radius: var(--radius-md)` (10px squircle); `padding: 4px !important` | `pretty/app-initial.css:5093–5099` | M |
| `.sidebar-hover-icon-tint` | `color: color-mix(in oklab, var(--color-token-foreground) 50%, transparent)` = `rgba(223,223,223,0.5)`; **full `#dfdfdf` on hover/focus-visible** | `pretty/app-initial.css:15293–15307` | M |

### 4.4 Nav rows — New chat, Pull requests, Scheduled, Plugins, Explore

The shared component is `SK` (`pretty/app-primary.js:124247`). Its class string, verbatim
(`pretty/app-primary.js:124354–124366`) — **M**:

```
sidebar-item relative h-[var(--height-token-row)] cursor-interaction shrink-0 items-center
overflow-hidden text-start text-sm disabled:cursor-not-allowed disabled:opacity-50
+ flex w-full
+ gap-2 px-[var(--padding-row-cell-x,var(--padding-row-x))] py-row-y
+ (isActive ? bg-primary-ghost-hover : hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover)
```

| Property | Value | Source | M/I |
|---|---|---|---|
| row height | **30px** (`--height-token-row` ← `--height-token-nav-row`) | `pretty/app-initial.css:19999–20000` | M |
| horizontal padding | **8px** (`--padding-row-cell-x`) | `pretty/app-initial.css:20001` | M |
| vertical padding | 5px (`py-row-y`, `--padding-row-y`) | `pretty/app-initial.css:34924` | M |
| gap icon↔label | **8px** (`gap-2`) | `pretty/app-primary.js:124357` | M |
| row radius | `.sidebar-item { border-radius: var(--radius-lg); corner-shape: var(--codex-corner-shape) }` → **12.5px squircle** | `pretty/app-initial.css:9953–9956` | M |
| gap between rows | **1px** (`flex flex-col gap-px` on the section body) | `pretty/app-primary.js:124594` | M |
| hover background | `rgba(255, 255, 255, 0.078)` | §2b | M |
| active background | *the same* `rgba(255, 255, 255, 0.078)` — Codex does not use a stronger active fill for the default variant | `pretty/app-primary.js:124325` (`C = 'bg-primary-ghost-hover'`) | M |
| accent variant (unused in the sidebar) | `bg-text-info/10 hover:bg-text-info/15`, label `text-info` | `pretty/app-primary.js:124322–124327` | M |
| label wrapper | `flex min-w-0 items-center text-base gap-2` → **14px** | `pretty/app-primary.js:124398` | M |
| label colour, idle | `text-default` = `--color-text` = `rgba(223, 223, 223, 0.85)` *inside the nav* | §2b | M |
| label colour, active | `text-emphasis` = `#dfdfdf` (opaque, brighter) | `pretty/app-primary.js:124326`, §2b | M |
| label truncation | `text-fade-truncate` — a gradient mask, **not** an ellipsis (`text-overflow: clip` + `mask-image: linear-gradient(to right, #000 calc(100% - 1rem), transparent)`) | `pretty/app-initial.css:4746–4760` | M |
| icon slot | `flex icon-leading-slot w-4 shrink-0 items-center justify-center` → 16px box, `--icon-size: 16px` | `pretty/app-primary.js:124409`; `pretty/app-initial.css:5132` | M |
| icon size | `icon-xs` = 16px | `pretty/app-primary.js:124376` | M |
| icon colour, idle | inherits the label colour (`currentColor`) | — | I |
| icon colour, active | `text-codex-icon-active` = `rgba(255, 255, 255, 0.904)` | `pretty/app-primary.js:124324`, §2b | M |
| `cursor` | `--cursor-interaction: default` in Electron — **no pointer cursor on rows** | `pretty/app-initial.css:34982` | M |
| trailing "+" on *New chat* | Quick-chat Button, `color="ghost" size="compact" uniform` (24 × 24, radius-lg) inside a `pe-1` wrapper; outer row becomes `flex items-center gap-1` | `pretty/app-primary.js:147420–147452` | M |

### 4.5 Section header ("Projects", "Recents")

Component `CK` (`pretty/app-primary.js:124560`) — **M**:

| Property | Value | Source |
|---|---|---|
| header row | `group/nav-section-title flex items-center justify-between gap-2` + `pe-0.5 ps-2` → 8px lead, 2px trail | `pretty/app-primary.js:124607` |
| title text | `text-base font-medium text-tertiary opacity-75` → **14px / 500 / `rgba(255,255,255,0.498)` × 0.75 ≈ white 37 %** | `pretty/app-primary.js:124615` |
| toggle button | `group/section-toggle flex min-w-0 flex-1 items-center gap-1 rounded-md py-0.5 pe-1 text-start` → radius-md 10px, 2px block padding, 4px gap to chevron | `pretty/app-primary.js:299180` |
| disclosure chevron | `icon-disclosure` = **14px**, `sidebar-hover-icon-tint` (`rgba(223,223,223,0.5)`, full on hover), `-rotate-90` when collapsed, `rotate-0` when open | `pretty/app-primary.js:299201–299208`; `pretty/app-initial.css:5387` |
| chevron visibility | `opacity-0` at rest; `opacity-100` on group hover / focus-visible, **and permanently when the section is collapsed** (`showCollapsedChevron`) — this is why "Recents ›" shows its chevron and "Projects" does not | `pretty/app-primary.js:299204` |
| body spacing | section wrapper `flex flex-col gap-1`; body `flex flex-col gap-px`; `pt-1` under the title | `pretty/app-primary.js:124594–124596`, `124655` |
| section wrapper | `relative px-row-x` (8px), drag opacity `opacity-20` while reordering | `pretty/app-primary.js:299497` |
| collapse animation | height+opacity, `{duration: 0.3, ease: [0.19,1,0.22,1]}` | `pretty/app-primary.js:124674` |

Verified against the screenshot: "Explore" row centre → "Projects" title centre = 15 + 16 + 12.5 = **43.5px**,
matching the measured 80 image-px at the derived 1.839 scale (§7). — **M**

### 4.6 Project rows (folder icon) and nested thread rows

| Property | Value | Source | M/I |
|---|---|---|---|
| folder row wrapper | `group/folder-row flex items-center justify-between overflow-hidden text-default` | `pretty/app-primary.js:152045` | M |
| disabled folder row | adds `text-codex-description` | `pretty/app-primary.js:152041` | M |
| nesting | each depth level wraps in `flex min-w-0 flex-1 ps-7` → **28px per level** | `pretty/app-primary.js:152039–152042` | M |
| ⇒ nested thread text x-offset | 8px row padding + 28px indent = **36px** from the sidebar's left edge | derived; confirmed by pixel measurement (§7) | M |
| thread row | `group relative cursor-interaction text-sm hover:bg-primary-ghost-hover` + `h-[var(--height-token-row)]` + `sidebar-item` + `focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring` | `pretty/app-primary.js:138354–138371` | M |
| selected thread pill | `bg-primary-ghost-hover` = `rgba(255,255,255,0.078)`, radius 12.5px squircle, full row width minus the 8px side padding | `pretty/app-primary.js:138358` | M |
| open-menu state | `has-[[aria-haspopup=menu][aria-expanded=true]]:bg-primary-ghost-hover` | `pretty/app-primary.js:138356` | M |
| disabled thread row | `opacity-60` | `pretty/app-primary.js:138359` | M |
| drag ghost | `sidebar-item cursor-grabbing bg-primary-ghost-hover` | `pretty/app-primary.js:146270` | M |
| drop indicator (active) | `rounded-[10px] bg-surface-secondary/40 ring-1 ring-inset ring-border` | `pretty/app-primary.js:326574` | M |
| title | inner `flex min-w-0 flex-1 items-center gap-0.5`; the label uses the same 14px `text-base` inherited scale | `pretty/app-primary.js:151995` | M |
| trailing meta slot | `flex shrink-0 items-center pe-2 empty:hidden` | `pretty/app-primary.js:152005` | M |
| project list cap | 5 projects before "show more" (`maxItems: 5`) | `pretty/app-primary.js:326660` | M |

### 4.7 "No chats" placeholder

| Property | Value | Source | M/I |
|---|---|---|---|
| classes | `text-codex-description opacity-50 px-8 py-1 text-base` | `pretty/app-primary.js:304725`, `305280` | M |
| ⇒ resolved | 14px, colour `rgba(255,255,255,0.498)` × 0.5 ≈ **white 25 %**, 32px left inset (aligns with nested titles), 4px block padding | derived | M |
| project-list empty variant | `px-[var(--padding-row-cell-x,var(--padding-row-x))] py-2 text-base text-codex-description opacity-50` | `pretty/app-primary.js:306687`, `327362` | M |
| "Projects couldn't be loaded" | `px-[…] py-1.5 text-sm text-codex-description` | `pretty/app-primary.js:326629` | M |

### 4.8 Footer (avatar, e-mail, Voice, help)

| Property | Value | Source | M/I |
|---|---|---|---|
| footer container | `[container-type:inline-size] relative w-full shrink-0`, positioned `absolute inset-x-0 bottom-0 z-20` | `pretty/app-primary.js:330747`, `333516` | M |
| top hairline | `pointer-events-none absolute inset-x-0 top-0 z-10 border-t-hairline border-default` → **0.5px, `rgba(255,255,255,0.084)`** | `pretty/app-primary.js:330700`; `pretty/app-initial.css:10432` | M |
| row | `flex h-toolbar items-center gap-2 px-row-x` → **46px tall**, 8px gap, 8px side padding | `pretty/app-primary.js:330751` | M |
| profile button | `flex h-[var(--height-token-row)] min-w-0 cursor-interaction items-center sidebar-item text-start text-base text-default outline-none hover:bg-primary-ghost-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring` + `flex-1 gap-2 px-[var(--padding-row-cell-x,var(--padding-row-x))]` | `pretty/app-primary.js:131332`, `131328` | M |
| ⇒ resolved | 30px tall pill, 8px padding, 8px gap, 14px label `text-default`, radius 12.5px | derived | M |
| e-mail label | `min-w-0 flex-1 truncate` — real ellipsis here, not the fade mask | `pretty/app-primary.js:131320` | M |
| avatar | `<Avatar size="xs">` | `pretty/app-primary.js:131364` | M (prop) / the pixel size of `xs` was **not found** |
| Voice button | Button `color="ghost" size="toolbar"` with icon + "Voice" label; wrapped in a tooltip | `pretty/app-primary.js:330714–330731` | M |
| ⇒ resolved | 28px tall, 8px side padding, `text-sm` 13px, `text-tertiary`, radius-button-toolbar 12.5px | `pretty/app-initial.js:215871` | M |
| trailing group | `flex items-center gap-1 empty:hidden` (Voice + help) | `pretty/app-primary.js:330755` | M |

### 4.9 Tooltip ("Toggle sidebar ⌘B")

| Property | Value | Source | M/I |
|---|---|---|---|
| container | `w-fit text-sm whitespace-normal break-words select-none z-50 rounded-2xl border border-default bg-surface-elevated-secondary text-default px-2 py-1.5 pointer-events-none` | `pretty/app-initial.js:269812–269834` | M |
| ⇒ resolved | 13px text `#dfdfdf`; bg **`rgb(45, 45, 45)`**; 1px border `rgba(255,255,255,0.084)`; radius-2xl = **20px squircle**; padding 8px × 6px | §2a/§2b | M — bg verified by pixel sample (§7) |
| inverse variant (unused here) | `border-text bg-primary-solid text-primary-solid` | `pretty/app-initial.js:269830` | M |
| body layout | `flex gap-2 items-center` → **8px between label and keycap** | `pretty/app-initial.js:269613` | M |
| keycap chip | `<kbd class="inline-flex !rounded-md !border-0 !bg-current/10 !font-sans !text-xs !text-current !shadow-none !px-1.5 !py-0.5 !leading-none">` | `pretty/app-initial.js:268914–268935` | M |
| ⇒ resolved | radius-md **10px**; background = **currentColor at 10 %** (so it tracks the tooltip's text colour, not a fixed grey); 12px text, same colour as the label; padding 6px × 2px | derived | M |
| placement | `side: 'top'`, `align: 'center'`, `sideOffset: 2`, collision padding 8px, `maxWidth: min(20rem, available, 100vw-16px)` | `pretty/app-initial.js:269253–269258`, `269742`, `269847` | M |
| the observed tooltip is `side: 'top'`? | the screenshot shows it **below** the trigger — Floating-UI flipped it because there is no room above | screenshot 1 | I |

### 4.10 Collapsed state top bar

Screenshot 2: `[toggle] [new chat] │ [folder] Thread title`.

| Property | Value | Source | M/I |
|---|---|---|---|
| bar | `._FloatingHeader_ihb90_2 { height: var(--height-toolbar); flex-shrink:0; align-items:center; padding-inline-start: max(var(--spacing-token-safe-header-left), 0.5rem); padding-inline-end: 8px; display:flex }` | `pretty/app-initial.css:1152–1158` | M |
| ⇒ resolved | 46px tall; left padding **98px** windowed / **8px** fullscreen (§1) | derived | M |
| tint | `--header-tint: var(--codex-titlebar-tint, transparent)` | `pretty/app-initial.css:1146–1150` | M |
| content row | `pointer-events-none relative flex h-full min-w-0 flex-1 isolate items-center gap-1.5 overflow-hidden [contain:layout_paint]` + `ps-2` + `pe-2` → **6px gaps** | `pretty/app-initial.js:374220–374229` | M |
| vertical divider | `<div aria-hidden className="h-3 w-px shrink-0 bg-border" />` inside a `flex shrink-0 items-center gap-1.5` → **12px × 1px, `rgba(255,255,255,0.084)`, 6px on each side** | `pretty/app-initial.js:369848–369851` | M |
| buttons | same `oP` toolbar buttons as §4.2 (28 × 28, ghost) | — | M |
| app-shell header shell | `pointer-events-none fixed z-30 flex h-toolbar min-w-0 items-center draggable` + `inset-x-0 top-0` | `pretty/app-initial.js:374176` | M |

---

## 5. Icons

Codex ships its sidebar icons as **inline React SVG factories inside the bundle**. Most go through an internal registry `fP({ name, canvas:{width,height,viewBox,frame}, inkBounds,
visualBounds, paint:{kind:'monochrome'}, optical:{shape,bounds,center,insets,anchors},
capabilities:['icon'], body })`, wrapped for animation by `gP()`. A few are bare inline `jsx('svg', …)`
factories with no registry entry. — **M**

| Element | identifier | registry name | viewBox | def (`pretty/app-initial.js`) | use |
|---|---|---|---|---|---|
| Sidebar toggle, open | `d1` (inline) | — | `0 0 20 20` | 372326 | `pretty/app-initial.js:372608` |
| Sidebar toggle, closed | `i$a` (inline) | — | `0 0 20 20` | 372307 | `:372596` |
| Sidebar toggle, closed + unread dot | `t$a` (inline; 2nd path filled `var(--color-background-info-solid)`) | — | `0 0 16 16` | 372280 | `:372565` |
| Sidebar toggle, brand mark | `d$a` (inline) | — | `0 0 20 20` | 372417 | `:372593` |
| Back / forward | `G1r` | `arrow-left-lg-light-16` | `0 0 16 16` | 251214 / body 251257 | `:372710`, `:372718` (forward = same asset + `-scale-x-100`) |
| New chat | `F5r` → `Zti = gP(F5r)` → `Vze` | `square-and-pencil-light-20` | `0 0 20 20` | 260311 / 260354 | `pretty/app-primary.js:124372`, key `sidebar-new-chat` |
| Pull requests | `Z8r` → `Iti` → `Qge` | `pull-request-open-light-16` | `0 0 16 16` | 259400 / 259443 | `pretty/app-primary.js:143209` |
| Scheduled | `FJs` → `YMe` | (inline binding; duplicate registered copy near 253716) | `0 0 16 16` | 502847 / 502857 | `pretty/app-primary.js:143271`, key `sidebar-tasks` |
| Plugins | `n2` → `_v` | (inline) | `0 0 16 16` | 390454 / 390465 | `pretty/app-primary.js:59509`, key `sidebar-plugins` |
| Explore ("…") | `y4r` → `Pei` → `wh` | `ellipsis-horizontal-light-16` | `0 0 16 16` | 254555 / 254598 | `pretty/app-primary.js:135734`, key `sidebar-more` |
| Project folder | `Y4r` → `Hei` → `ty` | `folder-light-16` | `0 0 16 16` | 255291 / 255333 | `pretty/app-primary.js:302826` (size map `{16: ty, 20: Zde}` at 353066) |
| Search | `r6r` → `oti` → `PCe` | `magnifying-glass-lg-light-16` | `0 0 16 16` | 256769 / 256812 | `pretty/app-primary.js:146188`, key `sidebar-search` |
| Bell / Activity | `k0r` → `rei` → `Pn` | `bell-light-20` | `0 0 20 20` | 252184 | `pretty/app-primary.js:147967` |
| Disclosure chevron | `_da` → `vit` → `OD` | (inline) | `0 0 20 21` | 271180 / 271189 | `pretty/app-primary.js:299201`, class `icon-disclosure` |

Split chunks that name the same icons: `webview/assets/sidebar-new-chat-icon-0fd80fc7b9c5.js`,
`sidebar-tasks-icon-9402a5a4bccf.js`, `sidebar-plugins-icon-be5a1502d451.js`,
`sidebar-projects-icon-67042664aebc.js`, `sidebar-search-icon-3b13a7c0c06e.js`,
`sidebar-library-icon-261fcff961c3.js`, `sidebar-more-icon-eace1b6cd43a.js`,
`sidebar-open-nhB2DGWY-48e3f6b154d6.js`, `sidebar-close-DAkb7EIE-6b8c700a19c4.js`. — **M**

### These are **not** `@openai/apps-sdk-ui` icons

Diffed against the real published tarball (`@openai/apps-sdk-ui` 0.2.2, unpacked at
`scratchpad/pkg/package/dist/es/components/Icon/svg/`). — **M**

- Every one of the extracted `d` prefixes was grepped against every file in that directory: **zero matches**.
- The nearest-named counterparts differ in both geometry and convention:
  `Search` (apps-sdk-ui `viewBox 0 0 24 24`, `width/height "1em"`, `d="M10.875 4.5C7.35418…"`) versus
  `magnifying-glass-lg-light-16` (`0 0 16 16`, fixed 16px, `d="M7.32849 1.91016…"`);
  `Folder` (`0 0 20 20`, `d="M1.66669 5…"`) versus `folder-light-16` (`0 0 16 16`, `d="M5.55933 2.14136…"`);
  likewise `PullRequestOpen`, `PencilSquare`, `Plugin`.
- Different systems entirely: apps-sdk-ui icons are bare `(props) => _jsx("svg", {width:"1em", …})` with no
  metadata; Codex's are registry entries with optical bounds and anchors, plus an animation wrapper.
- Different naming: kebab-case with an explicit pixel suffix (`folder-light-16`) versus size-agnostic
  PascalCase (`Folder`).
- No copy of the package is bundled: `app/package.json` — no hits; `app-primary.js` — no hits; `app-initial.js`
  — one hit, the documentation URL `https://developers.openai.com/apps-sdk` at `pretty/app-initial.js:284286`.

**Verdict: unrelated implementation.** Do not expect `docs/research/apps-sdk-ui-icons.md` to describe what
Codex draws. If brigadier wants this exact look, the icons have to be traced or redrawn — they are OpenAI's
internal desktop icon set, not the public Apps SDK one.

The animated variants are keyed by the `sidebar-*` names above and rendered through `Bgn`
(`pretty/app-primary.js:124382`); a static fallback is used in the browser build. — **M**

---

## 6. A minimal recipe for brigadier

Concrete values, dark theme, ready to paste into a token file:

```
--sidebar-bg:            rgba(40, 40, 40, 0.70)   /* over a macOS "menu" vibrancy layer */
--sidebar-bg-opaque:     rgb(40, 40, 40)          /* if you don't do vibrancy            */
--sidebar-row-height:    30px
--sidebar-row-radius:    12.5px                   /* superellipse(1.5) if you can        */
--sidebar-row-pad-x:     8px
--sidebar-row-gap:       1px
--sidebar-section-gap:   16px
--sidebar-icon-size:     16px
--sidebar-indent:        28px
--sidebar-hover:         rgba(255, 255, 255, 0.078)
--sidebar-active:        rgba(255, 255, 255, 0.078)   /* same fill; the label brightens  */
--sidebar-text:          rgba(223, 223, 223, 0.85)
--sidebar-text-active:   #dfdfdf
--sidebar-text-muted:    rgba(255, 255, 255, 0.498)
--sidebar-section-label: rgba(255, 255, 255, 0.498) at opacity .75, 14px/500
--sidebar-placeholder:   rgba(255, 255, 255, 0.498) at opacity .50, 14px
--sidebar-border:        rgba(255, 255, 255, 0.084)
--sidebar-font:          -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
--sidebar-font-size:     14px
--sidebar-font-weight:   430
--sidebar-line-height:   1.5
--sidebar-width:         275px  (min 240, max min(520, 100vw - 320))
--tooltip-bg:            rgb(45, 45, 45)
--tooltip-radius:        20px
--tooltip-pad:           6px 8px
--keycap-bg:             currentColor @ 10%,  radius 10px, 12px text, 2px 6px pad
--toolbar-button:        28×28, radius 12.5px, ghost = rgba(255,255,255,0.498)
```

Two behaviours worth copying and easy to miss:

1. **The label, not the fill, carries the active state.** Hover and selected use the identical
   `rgba(255,255,255,0.078)`; what changes is the text going from 85 % to 100 % and the icon to 90 % white.
2. **Long row labels fade, they don't ellipsise** (`text-fade-truncate`, a 1rem gradient mask). The footer
   e-mail is the exception and does use `truncate`.

---

## 7. Cross-check against the owner's screenshots

The four supplied paths on the Desktop no longer exist; the copies in
`/Users/stephen/.claude/image-cache/6b8c7823-87dc-4947-b48d-7e6f4a385cd5/` were used
(`1.png` open + hovered toggle with tooltip, `2.png` collapsed, `3.png` open on a coloured desktop,
`4.png` unfocused). All are crops rescaled to 2000px tall, so absolute pixel sizes are only usable via a
derived scale.

**Scale derivation (M).** Nav rows in `1.png` repeat every 57 image-px; the code says 30px row + 1px gap = 31,
so scale = 57 / 31 = **1.839**.

| Check | Predicted | Measured in the image | Verdict |
|---|---|---|---|
| Selected-thread pill height | 30px | 55 image-px ÷ 1.839 = 29.9px | ✔ |
| Pill width / side inset | sidebar − 2 × 8px | 467 ÷ 1.839 = 254px inside a 270px sidebar ⇒ 8px each side | ✔ |
| Nested thread text inset | 8 + 28 = 36px | thread rows start ~66 image-px ÷ 1.839 ≈ 36px | ✔ |
| Section header offset | 43.5px between "Explore" and "Projects" centres | 80 image-px ÷ 1.839 = 43.5px | ✔ |
| Hover/active pill alpha | `rgba(255,255,255,0.078)` | pill `rgb(42,42,42)` on a `rgb(24,24,24)` ground ⇒ α = (42−24)/(255−24) = **0.0779** | ✔ exact |
| Tooltip background | `rgb(45, 45, 45)` | sampled `rgb(45, 45, 45)` | ✔ exact — this is the evidence that the **runtime** palette, not the stylesheet fallback (`#181818`), is what renders |
| Sidebar is translucent | tint over vibrancy | `1.png` (dark desktop) `rgb(24,24,24)`; `3.png` (coloured desktop) **`rgb(42,53,58)`** — a blue cast that no opaque grey could produce | ✔ |
| Unfocused flattens | vibrancy → null, opaque backdrop | `4.png` `rgb(34,34,34)`, flat, no colour cast | ✔ qualitatively |

**Where the screenshots and the arithmetic disagree.** The exact composited pixel cannot be predicted from
`0.7 × rgb(40,40,40)` alone: focused-on-dark reads `rgb(24,24,24)`, which is *below* `0.7 × 40 = 28`, and
unfocused reads `rgb(34,34,34)`, which is above it. macOS vibrancy is not a plain source-over composite (the
material applies its own blend), so **do not treat any single sampled grey as "the" sidebar colour.** The
token is the 70 % tint; the rendered grey depends on the desktop behind it.

Sidebar width in `1.png`/`3.png` measures ≈ 270px against the 275px default — within the crop's error, or the
owner had nudged the handle. Not treated as a discrepancy.

---

## 8. Not found / not checked

- **Full `d` path data per icon.** §5 gives each icon's identifier, registry name, viewBox and definition line;
  the paths themselves were not transcribed into this file. Pull them from the cited lines when you need them.
- **The 20px folder sibling `Zde`.** Only the 16px `folder-light-16` variant (the one used on project rows) was
  traced.
- **Avatar `size="xs"` in pixels.** The prop is confirmed; the size map was not located in either bundle.
- **`--codex-titlebar-tint`.** Referenced by the floating header and the app-shell header; its value was never
  located, so it is presumably `transparent` by default (the `var()` fallback).
- **Whether `corner-shape: superellipse()` is actually supported by this Electron build.** Electron 42 →
  Chromium ≳ 144 and the property shipped in Chrome 139, so the `@supports` branch is taken and radii scale by
  1.25 — but this was reasoned, not observed at runtime.
- **Sidebar-width persistence backend.** The key `"sidebar-width"` and the 240/275/520 clamp are read from
  source; that the store is literally `window.localStorage` was not confirmed.
- **`accentSource: 'chatgpt'` accent injection** (`KSa()`), which can replace `--color-accent-*` at runtime.
  Irrelevant to the sidebar greys, not chased.
- **Light theme.** Out of scope by request; the same generator produces it via `cCa()`
  (`pretty/app-initial.js:345872`) from `{ ink:'#1a1c1f', surface:'#ffffff', contrast:45 }`.
- **Windows/Linux sidebar appearance** beyond the `mica` / `titleBarOverlay` facts in §1.
- **Anything requiring the app to be running.** No DevTools inspection was done; every value here comes from
  the shipped source or from sampling the owner's PNGs.

---

## 9. Applied — 2026-09-10

The values above were applied to brigadier's sidebar on 2026-09-10 (branch `ui/sidebar`, worker 2A).
Visual treatment only: no row was added, removed or reordered. Dark-only. The kit's own
`sidebar.tsx` was copied first (`src/components/ui/sidebar.tsx`, assistant-ui/assistant-ui
`1a5da0f272668cf313e5213e49aa70e0f987de6d`, `packages/ui/src/components/react/ui/base/sidebar.tsx`,
one line changed: lucide's `PanelLeftIcon` → brigadier's `Sidebar` glyph), and
`src/components/controls/sidebar.tsx` was rebuilt on it.

### Where each number lives

| Codex value (§) | brigadier | Emitted CSS |
|---|---|---|
| sidebar surface `rgb(40,40,40)` at 70% over `menu` vibrancy (§1) | `--sidebar` + a `color-mix` | `:root[data-sidebar-vibrancy="true"] .app-navigation { background: color-mix(in srgb, var(--sidebar) 70%, transparent) }` |
| unfocused ⇒ flat opaque (§1) | `data-window-focused="false"` on `<html>` | `:root[data-window-focused="false"] .app-navigation { background: var(--sidebar) }` |
| vibrancy material `menu`, state `followWindow` (§1) | `src/hooks/use-sidebar-vibrancy.ts` | `setEffects({ effects: [Effect.Menu], state: EffectState.FollowsWindowActiveState })` |
| text 14px / 430 / 1.5 (§2c) | `--sidebar-font-*` | `.app-navigation { font-size: var(--sidebar-font-size); font-weight: var(--sidebar-font-weight); line-height: var(--sidebar-line-height) }` with `--sidebar-font-size: 14px; --sidebar-font-weight: 430; --sidebar-line-height: 1.5` |
| idle label `rgba(223,223,223,.85)` (§2b) | `--sidebar-text-idle` | `.app-navigation .navigation-row { color: var(--sidebar-text-idle) }` |
| active label `#dfdfdf` (§2b) | `--sidebar-accent-foreground` | `.app-navigation .navigation-row[data-active]:not([data-active="false"]) { color: var(--sidebar-accent-foreground) }` |
| muted `rgba(255,255,255,.498)` (§2a) | `--sidebar-text-muted` | `.app-navigation .navigation-section-title { color: var(--sidebar-text-muted); opacity: .75 }`, `.navigation-empty { color: var(--sidebar-text-muted); opacity: .5 }` |
| hover **and** active pill `rgba(255,255,255,.078)` (§4.4) | `--sidebar-accent`, one selector for both | `.app-navigation .navigation-row:hover, .app-navigation .navigation-row[data-active]:not([data-active="false"]) { background: var(--sidebar-accent) }` |
| row radius 12.5px (§2d) | `--sidebar-row-radius` | `.app-navigation .navigation-row { border-radius: var(--sidebar-row-radius) }`, `--sidebar-row-radius: 12.5px` |
| row height 30px, padding 8px (§4.4) | `--sidebar-row-height`, `--sidebar-row-padding-x` | `.app-navigation .navigation-row { height: var(--sidebar-row-height); padding-block: 0; padding-inline: var(--sidebar-row-padding-x) }` |
| 1px between rows (§4.4) | `--sidebar-row-gap` | `.app-navigation .navigation-rows { display: flex; flex-direction: column; gap: var(--sidebar-row-gap) }` |
| 16px between sections (§4.1) | `--sidebar-section-gap` | `.navigation-content { display: flex; flex-direction: column; gap: var(--sidebar-section-gap) }` |
| section 8px side inset, pill = width − 2×8 (§4.5, §7) | on the section, not the row | `.navigation-section { padding-inline: var(--sidebar-row-padding-x) }` |
| nested thread text at 36px (§4.6) | 8px + 28px | `.app-navigation .navigation-sessions .navigation-row { padding-inline-start: calc(var(--sidebar-row-padding-x) + var(--sidebar-indent)) }` |
| icons 16px (§4.4) | `--sidebar-icon-size` | `.app-navigation .navigation-row svg { width: var(--sidebar-icon-size); height: var(--sidebar-icon-size); color: inherit }` |
| active icon `rgba(255,255,255,.904)` (§2b) | `--sidebar-icon-active` | `.app-navigation .navigation-row[data-active]:not([data-active="false"]) svg { color: var(--sidebar-icon-active) }` |
| label fades, does not ellipsise (§6) | `.text-fade-truncate` | `mask-image: linear-gradient(to right, #000 calc(100% - 16px), transparent)` — 16px literal, because Codex's `1rem` is 16px and this app's root is 14px |
| width 275 / min 240 (§3) | `--sidebar-width`, `--sidebar-width-min` | `.sidebar-shell { width: var(--sidebar-width, 275px) }`; the kit provider's inline `16rem` is overridden with `275px` in `controls/sidebar.tsx` |
| toolbar button 28 × 28, radius-lg (§4.2) | `.chrome-button` | `.workspace-chrome .chrome-button { width: 28px; height: 28px; border-radius: var(--sidebar-row-radius) }` |
| header icon buttons 24 × 24, radius-md (§4.3) | `.navigation-icon-button` | `.app-navigation .navigation-icon-button { width: 24px; height: 24px; border-radius: 10px }` |
| collapsed bar: toggle · pencil · 1px divider · folder · title (§4.10) | `SidebarProvider`'s chrome | `.chrome-divider { width: 1px; height: 12px; background: var(--sidebar-border) }`, gaps 6px |
| footer 46px, 8px padding, hairline (§4.8) | `.navigation-footer` | `.navigation-footer { height: 46px; padding-inline: var(--sidebar-row-padding-x); border-top: 1px solid var(--sidebar-border) }` |
| tooltip `rgb(45,45,45)`, radius 20px, 1px `rgba(255,255,255,.084)`, 13px, 6 × 8px (§4.9) | `.tooltip-pill` | `[data-slot="tooltip-content"].tooltip-pill { border: 1px solid var(--sidebar-border); border-radius: 20px; background: rgb(45,45,45); padding: 6px 8px; font-size: 13px }` |
| keycap `currentColor` @10%, radius 10px, 12px (§4.9) | `[data-slot="tooltip-content"] kbd` | `background: color-mix(in srgb, currentColor 10%, transparent); border-radius: 10px; font-size: 12px; padding: 2px 6px` |

### Deviations from Codex, and why

- **Glyphs are brigadier's `src/icons`.** Codex's are its own registry SVGs (§5) and were not
  traced; shapes differ, sizes do not.
- **No `corner-shape: superellipse()`.** §2d's 1.25 radius scale is already folded into the 12.5px
  and 20px numbers; the squircle *shape* is not drawn. WKWebView's support was not checked.
- **The panel is not resized from a 16px edge strip (§3).** brigadier resizes from
  `LayoutResizer` (worker 2B); the clamp (275 / 240 / min(520, 100vw−320)) is the same.
- **Collapsed chrome is a fixed `calc(var(--window-controls-inset) + 244px)`**, not content-sized,
  so `.project-topbar` can reserve exactly that much and never overlap it. The workbench header's
  own copy of the session title is hidden while the sidebar is collapsed — two copies of the same
  string side by side is worse than either. Its `⋯` session menu stays.
- **`--sidebar-ring`** carries Codex's `--color-border-focus` but is inert: focus indicators are
  disabled app-wide (owner, 2026-09-10).
- **Section-header ink** is `--sidebar-text-muted` at `opacity: .75`, i.e. the two-step form Codex
  uses, rather than a pre-multiplied literal.

### Not verified

- No screenshot comparison was run. Every row above is the CSS this tree emits
  (`npx @tailwindcss/cli@4.3.3 -i src/index.css -o out.css`), not a rendered pixel.
- `font-weight: 430` is emitted; that macOS actually renders a 430 step rather than snapping to
  400 was **not** observed here.
- The vibrancy path (`Effect.Menu`, `FollowsWindowActiveState`, `onFocusChanged`) is exercised
  only by `src/hooks/use-sidebar-vibrancy.test.tsx` against a mocked `@tauri-apps/api/window`. It
  has not been run in a real window.
