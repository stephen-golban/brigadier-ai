# Button codemod — delete `src/components/controls/button.tsx`

2026-09-11. Prepared on `ui/followups`. Three parallel workers execute §5 from §3–§4; nobody
deletes the adapter until all three land (§6).

## 1. What is being removed

`src/components/controls/button.tsx` is a thin adapter over the kit Button
(`src/components/ui/button.tsx`, a verbatim upstream copy). It owns six things, all of which have
now been relocated so the adapter can go:

| adapter behaviour | replacement |
| --- | --- |
| `variant` alias map (`primary`→`default`, `danger`→`destructive`) | call site passes the kit name |
| default `variant="ghost"`, default `size="sm"` | call site passes them explicitly — **the kit defaults to `variant="default" size="default"`** |
| `isDisabled`, `onPress`, `isIconOnly`, `iconStyle` | call site uses `disabled` / `onClick` / `size` |
| `STANDARD_ICON_BUTTON`, `XS_ICON_BUTTON_RADIUS`, the icon-ink model, the `aria-pressed` fill | `iconButtonBox` / `iconButton` / `iconButtonXs` / `iconButtonInk` / `labelledButtonIcons` / `toggleButton` in `src/lib/surfaces.tsx` |
| the `.button` class and `data-icon-button` / `data-variant` markers | `[data-slot="button"]` (emitted by the kit Button, `src/components/ui/button.tsx:51`) and the `icon-button` class carried by the `iconButton` / `iconButtonXs` recipes — CSS already converted, §4 |
| `data-autofocus={props.autoFocus \|\| undefined}` | the call site sets `data-autofocus="true"` itself — one site, §3.9 |

Not carried over, because nothing consumes it: `data-variant` (grep for it in `src/**/*.css`
returns nothing) and `iconStyle` (zero real call sites; `controls/overlay.tsx` only swallows the
prop name for its `Dropdown.Item`).

Not carried over, because Base UI already does it: the adapter's `type = "button"` default.
`node_modules/@base-ui/react/internals/use-button/useButton.js:184` merges `type: 'button'` for a
native button before the site's own props, so an explicit `type="submit"` still wins. *(asserted
from the installed source; not re-checked in a browser.)*

## 2. The recipes (already added — do not re-add)

In `src/lib/surfaces.tsx`. Values are byte-identical to the adapter's; import with
`import { iconButton, … } from "@/lib/surfaces";`

```ts
iconButtonInk        = "text-text-secondary hover:text-text [&_svg]:text-current"
iconButtonBox        = "size-6 min-w-6 p-1 rounded-[var(--radius-icon-button)] [&_svg:not([class*='size-'])]:size-4"
iconButton           = "icon-button " + iconButtonBox + " " + iconButtonInk
iconButtonXs         = "icon-button rounded-[var(--radius-icon-button-xs)] " + iconButtonInk
labelledButtonIcons  = "[&_svg]:text-text-secondary"
toggleButton         = "aria-pressed:bg-selected aria-pressed:text-text"
```

**Two standard-box recipes, and which one a site takes.** `iconButtonBox` is byte-identical to the
adapter's old `STANDARD_ICON_BUTTON` — geometry only, no ink, no marker class. `iconButton` is
that string plus the `icon-button` marker plus `iconButtonInk`, and it is what every call site
that went **through the adapter** must use, because that is what the adapter emitted.

`iconButtonBox` is for the one file that never went through the adapter and imported
`STANDARD_ICON_BUTTON` on its own: `src/components/assistant-ui/elements/tooltip-icon-button.tsx`
(§5, P3). Giving it `iconButton` would be a change, not a port — it would repaint the markdown
code-block Copy button with `text-text-secondary hover:text-text` and pull it into the
`.icon-button[data-slot="button"]` reduced-motion rule at `src/index.css:1054`. Corrected
2026-09-11 after the blind review; the P3 instruction in §5 below is superseded by this paragraph.

`className` order is always **recipe first, the site's own string last** — the same order the
adapter used, so tailwind-merge still resolves a deliberate override (`size-8`, `p-0`,
`rounded-full`) in the site's favour. Use `cn()` from `@/lib/utils` whenever there is more than
one string.

## 3. The mechanical recipe, prop by prop

### 3.1 The import

```diff
-import { Button } from "./controls/button";
+import { Button } from "@/components/ui/button";
```

Relative spellings in the tree today are `"./controls/button"`, `"../controls/button"`,
`"./components/controls/button"`, `'./controls/button'` (single quotes),
`"@/components/controls/button"`. Normalise all of them to `@/components/ui/button`. Add
`import { cn } from "@/lib/utils";` and the `@/lib/surfaces` import only where §3.5–§3.8 actually
need them.

### 3.2 Defaults — do this on every single call site

The adapter defaulted `variant="ghost"` and `size="sm"`. The kit defaults to `variant="default"`
(a filled primary button) and `size="default"` (32px). **A call site that omitted either prop
must now pass it explicitly**, or it silently changes from a small ghost button to a large filled
one:

```diff
-<Button onClick={…}>Cancel</Button>
+<Button variant="ghost" size="sm" onClick={…}>Cancel</Button>
```

This is the single highest-risk step. Every converted `<Button>` ends up with an explicit
`variant` and an explicit `size` unless §3.4 assigns the size.

### 3.3 `variant`

| adapter | kit |
| --- | --- |
| `variant="primary"` | `variant="default"` |
| `variant="danger"` | `variant="destructive"` |
| `secondary` / `outline` / `ghost` / `link` | unchanged |
| omitted | `variant="ghost"` (§3.2) |

There is no `variant="danger"` Button call site today — the one hit for `variant="danger"`
(`src/components/SourceControl.tsx:340`) is a `Dropdown.Item`, not a Button. Leave it alone.

### 3.4 `size` and `isIconOnly`

`iconOnly` in the adapter meant `isIconOnly || size.startsWith("icon")`.

| adapter props | kit props | className additions |
| --- | --- | --- |
| `size="sm"` or omitted, no `isIconOnly` | `size="sm"` | §3.6 |
| `size="lg"`, no `isIconOnly` | `size="lg"` | §3.6 |
| `size="icon"` | `size="icon"` | `cn(iconButton, …)` |
| `isIconOnly` (size omitted or `sm`) | `size="icon"` | `cn(iconButton, …)` |
| `isIconOnly size="lg"` | `size="icon-lg"` | `cn(iconButtonInk, …)` — no box recipe, `icon-lg` is a deliberate 36px. **Zero call sites today.** |
| `size="icon-xs"` | `size="icon-xs"` | `cn(iconButtonXs, …)` |

Delete the `isIconOnly` prop itself; it is not a kit prop.

### 3.5 `iconStyle`

Drop it. `iconStyle="bare"` has no call site and no CSS keys on `[data-icon-button="bare"]`.

### 3.6 Icon ink on labelled buttons

The adapter gave **every** button `[&_svg]:text-text-secondary`, and icon-only buttons then
overrode it with `[&_svg]:text-current` (tailwind-merge, later wins). To keep the look identical,
add `labelledButtonIcons` to every **labelled** button that has an svg child — an icon in a row
with text, e.g. `<Button …><Plus /> New session</Button>`:

```diff
-<Button onClick={…}><Plus /> New session</Button>
+<Button variant="ghost" size="sm" className={labelledButtonIcons} onClick={…}><Plus /> New session</Button>
```

A labelled button with no svg child anywhere in its subtree needs nothing. When in doubt, add it:
the class is inert with no svg. Icon-only buttons must **not** get it — `iconButton` /
`iconButtonXs` already carry `iconButtonInk`, which is what the adapter resolved to.

### 3.7 `aria-pressed`

The adapter applied `aria-pressed:bg-selected aria-pressed:text-text` to **icon-only buttons
only**. Add `toggleButton` to an icon-only button that carries `aria-pressed`; do **not** add it
to a labelled one.

Icon-only `aria-pressed` sites today, all in `src/components/ProjectWorkbench.tsx` (P2):

- `:1189` — the Files / Search / Changes strip (`<Button size="icon">` opens at `:1174`, inside a `.map`)
- `:1201` — Subagents (`size="icon"`, all on one line)
- `:1207` — Terminal (`<Button size="icon">` opens at `:1202`)

Labelled `aria-pressed` sites that must **not** gain it: `src/components/Feed.tsx:289`,
`src/components/DocumentTab.tsx:379`, `src/components/CommitPreferences.tsx:39,45`,
`src/components/SessionPreferences.tsx:62,68`, `src/components/ProjectWorkbench.tsx:1066`
(`.session-title`). Line numbers are pre-codemod; re-grep rather than trusting them after an edit.

### 3.8 `isDisabled` and `onPress`

```diff
-isDisabled={busy}
+disabled={busy}
```

```diff
-onPress={onCancel}
+onClick={onCancel}
```

The adapter chained both: it called `onClick` first, then `onPress()` **only if the handler did
not call `preventDefault()`**. **If a site passes both**, merge into one handler that preserves
that order and guard:

```tsx
onClick={(event) => { existingOnClick(event); if (!event.defaultPrevented) existingOnPress(); }}
```

No site does today — the only `onPress` Button call sites are
`src/components/ConfirmDialog.tsx:81, 89, 96`, none of which also passes `onClick`. Note the
signature change: `onPress` took no argument, `onClick` receives the event. `onPress={() => f()}`
becomes `onClick={() => f()}`; `onPress={f}` where `f` takes an argument would newly receive the
event — check each of the three.

### 3.9 `autoFocus`

The adapter emitted `data-autofocus={props.autoFocus || undefined}`, and
`src/components/controls/modal.tsx:98` and `src/components/controls/overlay.tsx:360` find the
initial focus target with `'[data-autofocus="true"], [autofocus]'`. React does not render the
`autofocus` attribute on the client, so the `data-` marker is the one that works. Add it wherever
a Button passes `autoFocus`:

```diff
-<Button autoFocus variant="secondary" isDisabled={busy} onPress={onCancel}>
+<Button autoFocus data-autofocus="true" variant="secondary" size="sm" disabled={busy} onClick={onCancel}>
```

One site: `src/components/ConfirmDialog.tsx:78` (P1). Every other `autoFocus` in `src/` is on an
`Input` / `CommandInput`, which keep their own marker in `src/components/controls/input.tsx:23`.
`controls/modal.tsx` and `controls/overlay.tsx` themselves need no change.

### 3.10 Everything else

`data-*`, `aria-*`, `title`, `key`, `ref`, `style`, `type` pass through unchanged — the kit
Button spreads them onto Base UI's `Button`, which forwards to the DOM node.

### 3.11 Worked example

```diff
-import { Button } from "./controls/button";
+import { cn } from "@/lib/utils";
+import { Button } from "@/components/ui/button";
+import { iconButton, toggleButton } from "@/lib/surfaces";
…
 <Button
-  size="icon"
+  variant="ghost"
+  size="icon"
+  className={cn(iconButton, toggleButton, "relative")}
   aria-label="Terminal"
   aria-pressed={open}
-  isDisabled={!project}
-  onPress={toggle}
-  className="relative"
+  disabled={!project}
+  onClick={toggle}
 >
   <Terminal width={18} height={18} />
 </Button>
```

## 4. CSS — already converted, do not redo

`src/index.css` and `src/components/settings.css` were converted on this branch. Every
conversion preserves the old selector's specificity exactly.

| old selector | new selector | file:line (post-edit) |
| --- | --- | --- |
| `.button[data-icon-button="standard"]` (in `@media (prefers-reduced-motion)`) | `.icon-button[data-slot="button"]` | `src/index.css:1054` |
| `.workbench-tab .button[data-icon-button="standard"]` | `.workbench-tab .icon-button[data-slot="button"]` | `src/index.css:1104` |
| `.workbench-tab .button[data-icon-button="standard"] svg` | `.workbench-tab .icon-button[data-slot="button"] svg` | `src/index.css:1111` |
| `.workbench-panel-actions > .button` | `.workbench-panel-actions > [data-slot="button"]` | `src/index.css:1122` |
| `.workbench-panel-actions > .button > svg` | `.workbench-panel-actions > [data-slot="button"] > svg` | `src/index.css:1123` |
| `.welcome-starter.button` | `.welcome-starter[data-slot="button"]` | `src/index.css:1171`, `:1173` |
| `.session-title.button` | `.session-title[data-slot="button"]` | `src/index.css:1177`, `:1179`, `:1217` |
| `.session-title.button[aria-pressed="true"]` | `.session-title[data-slot="button"][aria-pressed="true"]` | `src/index.css:1178` |
| `.settings-back.button` | `.settings-back[data-slot="button"]` | `src/components/settings.css:28`, `:84` |
| `.settings-nav-item.button` | `.settings-nav-item[data-slot="button"]` | `src/components/settings.css:71`, `:83` |
| `.archive-delete-all.button` | `.archive-delete-all[data-slot="button"]` | `src/components/settings.css:112`, `:121` |
| `.archive-filter.button` | `.archive-filter[data-slot="button"]` | `src/components/settings.css:171`, `:181`, `:186`, `:352` |
| `.archive-group-heading .button` | `.archive-group-heading [data-slot="button"]` | `src/components/settings.css:209` |
| `.archive-row-delete.button` | `.archive-row-delete[data-slot="button"]` | `src/components/settings.css:248`, `:253`, `:254` |
| `.archive-unarchive.button` | `.archive-unarchive[data-slot="button"]` | `src/components/settings.css:257`, `:264`, `:376` |

**Still to convert — P3 owns these two files:**

| old selector | new selector | file:line |
| --- | --- | --- |
| `.setup-menu-back.button` | `.setup-menu-back[data-slot="button"]` | `src/components/composer/setup-rail.css:10` |
| `.brigadier-composer .composer-send.button` (+ ` svg`, `:hover:not(:disabled)`, `:disabled`) | `.brigadier-composer .composer-send[data-slot="button"]` | `src/components/composer/composer.css:38–41` |

Notes:

- `[data-slot="button"]` is emitted only by `src/components/ui/button.tsx:51`; `src/focus-reset.css:121`
  already keys on it, so this is the established marker.
- `icon-button` had no CSS rule before this change. It appears as a decorative class at
  `src/components/ProjectWorkbench.tsx:1048` and `:1224`, both of which are icon-only standard
  boxes anyway, so keying on it is semantically correct — but a worker who adds `icon-button` to
  a non-icon button inside `.workbench-tab` would shrink it to 16px. Only the recipes add it.
- No test asserts on `.button`, `data-icon-button` or `data-variant`.

## 5. Partition — three workers, no shared file

Find every site with `grep -rln "controls/button" src` (50 hits; 45 are real imports, the other
five are prose mentions in `src/components/controls/disclosure.tsx:20`,
`src/components/controls/input.tsx:8`, `src/components/controls/native-menu.test.tsx:235`,
`src/components/assistant-ui/elements/message-actions.tsx:39` and
`src/components/ui/UPSTREAM.md:31,78,133`). Narrow to real importers with
`grep -rln 'import .*controls/button' src` — note the tree mixes single and double quotes, so
`grep -rlnE "import .*controls/button['\"]" src` is the safe form.

**P1 — `src/components/[A-M]*.tsx` and their tests (15 importers)**
`ActionDialog.tsx`, `AgentsPanel.tsx`, `Approvals.tsx`, `ArchivedSessions.tsx`,
`ArchiveSettings.tsx`, `Burn.tsx`, `ChangesFileList.tsx`, `CommitPreferences.tsx`, `Composer.tsx`,
`ConfirmDialog.tsx`, `DesktopSettings.tsx`, `DocumentTab.tsx`, `EditProjectDialog.tsx`,
`Feed.tsx`, `MarkdownContent.tsx`.
Carries §3.9 (`ConfirmDialog.tsx:78`) and §3.8's three `onPress` sites.
`Burn.tsx` is on the render path — re-run the burn if its markup changes shape.

**P2 — `src/components/[N-Z]*.tsx` and `src/*.tsx` (26 importers)**
`NavigationHistoryControls.tsx`, `NewSession.tsx`, `NotesLibrary.tsx`, `ProjectWorkbench.tsx`,
`PromptInput.tsx`, `ResetOnboardingButton.tsx`, `RewindHistory.tsx`, `RunCard.tsx`,
`SelectMenu.tsx`, `SessionCard.tsx`, `SessionContext.tsx`, `SessionMenu.tsx`,
`SessionPreferences.tsx`, `SessionProvisioning.tsx`, `SessionReview.tsx`, `Sidebar.tsx`,
`SourceControl.tsx`, `SubagentsPanel.tsx`, `TerminalDock.tsx`, `ThreadView.tsx`, `Toasts.tsx`,
`TrashLibrary.tsx`, `VscodePanels.tsx`, `WorkspaceTools.tsx`, `WorkTrace.tsx`, `src/App.tsx`.
Carries every `toggleButton` site (§3.7) and the workbench-tab close button
(`ProjectWorkbench.tsx:1144`), which `src/index.css:1104` sizes to 16px through `icon-button`.
`App.tsx` touches the approvals path — approvals are never optimistic; do not restructure, only
rename props.

**P3 — `src/components/{assistant-ui,composer,controls,peer}/**` (4 importers + 2 CSS files)**
`assistant-ui/elements/tooltip-icon-button.tsx` (swap
`import { STANDARD_ICON_BUTTON } from "@/components/controls/button"` for
`import { iconButtonBox } from "@/lib/surfaces"` — **`iconButtonBox`, not `iconButton`**, see §2 —
and rename the one use at `:40`),
`assistant-ui/elements/recommendation-card.tsx`, `composer/TaskSetupRail.tsx`,
`composer/ExecutionControls.tsx`, plus the two CSS conversions at the end of §4. Also update the
prose in `controls/disclosure.tsx:20`, `controls/input.tsx:8` and `controls/native-menu.test.tsx:235`
that names `controls/button.tsx`.
P3 does **not** touch `controls/button.tsx` itself, `controls/modal.tsx` or `controls/overlay.tsx`.

Nobody edits `src/lib/surfaces.tsx`, `src/index.css` or `src/components/settings.css` — done.

## 6. Finishing

Only after all three partitions are green:

1. `grep -rn 'controls/button' src` must return prose only.
2. Delete `src/components/controls/button.tsx`.
3. Fix the two prose mentions in `src/components/ui/UPSTREAM.md:78` and `:133`.

## 7. Gates

`npx tsc --noEmit`, `npm test`, and — because this is the `src/` render path —
`VITE_BURN=1` (`src/components/Burn.tsx`): exec → first contentful paint ≤ 295 ms p50 and 0
dropped-vsync failures. Per `CLAUDE.md` §4 the full six gates apply before the commit.

Highest-value visual checks after landing, because they are where a missed default (§3.2) shows
first: the workbench topbar strip and tab close buttons, the settings sidebar and archive rows,
the welcome starters, the composer send button, and any dialog footer.
