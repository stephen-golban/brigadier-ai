# `src/components/ui/` — vendored UI kit provenance

These files are a **manual copy**, not a dependency. `@assistant-ui/ui` is `"private": true,
"version": "0.0.0"` and unpublished, and `r.assistant-ui.com` serves no route for them
(`docs/research/assistant-ui-design.md`, Landmine 3). There is no update path, no changelog and no
semver: to refresh a file, re-fetch it at a newer SHA/version and re-read this table.

Two sources, both manual copies:

- **assistant-ui kit** — `assistant-ui/assistant-ui` (MIT), directory
  `packages/ui/src/components/react/ui/base/`. Raw URL shape:
  `https://raw.githubusercontent.com/assistant-ui/assistant-ui/<sha>/packages/ui/src/components/react/ui/base/<name>.tsx`.
  The kit ships identical twins — `base/` on `@base-ui/react` and `radix/` on the monolithic
  `radix-ui`. brigadier takes the **base** twin, which is the one the docs pages show.
- **shadcn registry** — `https://ui.shadcn.com/r/styles/base-nova/<name>.json`, fetched through
  `npx shadcn@latest add …`. `shadcn init` was **not** run
  (`docs/research/shadcn-base-ui.md` §Install recipe); `components.json` was hand-written and pins
  style `base-nova`.

Copied 2026-09-10 in two passes (the 1a foundation, then the leaf controls).

## Files

| File | Source | SHA / version | Deviations |
| --- | --- | --- | --- |
| `avatar.tsx` | kit `base/avatar.tsx` | `1a5da0f` | none — byte-identical |
| `badge.tsx` | kit `base/badge.tsx` | `1a5da0f` | none — byte-identical |
| `button.tsx` | kit `base/button.tsx` | `1a5da0f` | none — byte-identical |
| `checkbox.tsx` | shadcn `https://ui.shadcn.com/r/styles/base-nova/checkbox.json` | `shadcn@4.21.0` | `from "cn"` → `@/lib/utils`; `CheckIcon` from `lucide-react` → `Check` from `src/icons`; the CLI's `<CheckIcon\n  />` line break collapsed. |
| `collapsible.tsx` | kit `base/collapsible.tsx` | `1a5da0f` | none — byte-identical. **Overwrote** the pre-port `radix-ui` file of the same name; export names `Collapsible` / `CollapsibleTrigger` / `CollapsibleContent` are unchanged, so its four importers compile untouched. Its state attributes changed with it — see Rules below. |
| `combobox.tsx` | kit `base/combobox.tsx` | `1a5da0f` | two. (1) `import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react"` → `Check` / `ChevronDown` / `X` from `@/icons`. (2) `ComboboxContent`'s `Pick` of positioner props is widened with `collisionPadding` / `collisionAvoidance`, exactly as `popover.tsx`'s was and for the same reason — `SelectMenu.tsx` passes the 8px window margin and `fallbackAxisSide: 'none'` so a composer popover can never swing out to the perpendicular axis. Copied 2026-09-11. It is **not** in the shadcn registry, so `npx shadcn add` cannot fetch it; the raw-GitHub URL at the SHA is the only pin (`docs/research/assistant-ui-composer.md`, Landmine C). Wired: `SelectMenu.tsx` uses `Combobox`, `ComboboxContent`, `ComboboxInput`, `ComboboxList`, `ComboboxItem`, `ComboboxGroup`, `ComboboxLabel`, `ComboboxCollection`, `ComboboxEmpty`; `ComboboxValue`, `ComboboxTrigger`, `ComboboxClear` and `ComboboxSeparator` have no call site — the kit's `ComboboxTrigger` is the 24px chevron box that lives *inside* an input, and this app's trigger is the composer pill, so `SelectMenu` renders `ComboboxPrimitive.Trigger` through the kit `Button` at the retired adapter's old defaults (`variant="ghost" size="sm"`, `SelectMenu.tsx:171-189`) instead. |
| `command.tsx` | kit `base/command.tsx` | `1a5da0f` | heavy, and hand-authored rather than copied. `cmdk` removed (see Not taken), `CommandDialog` removed (upstream's needs `@/components/ui/dialog`), `data-[selected=true]:bg-accent` → `aria-selected:bg-selected`. Geometry, spacing, ink and every `data-slot` name are upstream's. |
| `dialog.tsx` | kit `base/dialog.tsx` | `1a5da0f` | two: `import { XIcon } from "lucide-react"` → `import { X as XIcon } from "@/icons"`, and the built-in close button gained `aria-label="Close"` (upstream names it with an `sr-only` span; `src/index.css`'s `.rename-session-dialog > button[aria-label="Close"]` positions it by that attribute). |
| `dropdown-menu.tsx` | kit `base/dropdown-menu.tsx` | `1a5da0f` | two, both icons: `import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react"` → `import { Check as CheckIcon, ChevronRight as ChevronRightIcon } from "@/icons"`, and `DropdownMenuRadioItem`'s `<CircleIcon className="size-2 fill-current" />` → `<span className="size-2 rounded-full bg-current" />` because `src/icons/` has no circle glyph. `DropdownMenuRadioItem` has no call site. |
| `field.tsx` | shadcn `https://ui.shadcn.com/r/styles/base-nova/field.json` | `shadcn@4.21.0` | `from "cn"` → `@/lib/utils`; added `import type * as React from "react"` — upstream uses `React.ComponentProps` in 10 places with no React import, which only typechecks by accident. |
| `input.tsx` | kit `base/input.tsx` | `1a5da0f` | none — byte-identical |
| `kbd.tsx` | kit `base/kbd.tsx` | `1a5da0f` | none — byte-identical |
| `label.tsx` | kit `base/label.tsx` | `1a5da0f` | none. `shadcn add field` pulled it as a registry dependency and overwrote it; restored to the kit copy. The two versions differ only in `cn`'s import path, quote style and class order, and `field.tsx` reads neither's internals. |
| `popover.tsx` | kit `base/popover.tsx` | `1a5da0f` | two on `PopoverContent`: it is a `React.forwardRef` passing the ref to `Popover.Popup` (upstream is a plain function), and its `Pick` of positioner props is widened with `collisionPadding` / `collisionAvoidance`, which `controls/overlay.tsx` uses to reproduce the pre-port overlay's hand-run placement: an 8px margin off the window, and `fallbackAxisSide: 'none'` so a `side="top"` composer popover can never swing out to the perpendicular axis. `collisionBoundary` was in this `Pick` on 2026-09-10 and was removed the same day — see the comment in `controls/overlay.tsx`; Base UI applies one boundary to both axes and to `flip()`, so confining a composer popover to `.composer-surface` flipped it sideways across the text area. |
| `scroll-area.tsx` | shadcn `https://ui.shadcn.com/r/styles/base-nova/scroll-area.json` | `shadcn@4.21.0` | `from "cn"` → `@/lib/utils`; dropped the unused `import * as React` (TS6133 under this repo's `noUnusedLocals`). Not wired in. |
| `select.tsx` | kit `base/select.tsx` | `1a5da0f` | `lucide-react`'s `CheckIcon` / `ChevronDownIcon` / `ChevronUpIcon` → `Check` / `ChevronDown` / `ChevronUp` from `src/icons`. Nothing else. Not wired in — see Not taken. |
| `separator.tsx` | kit `base/separator.tsx` | `1a5da0f` | none. Same `shadcn add field` overwrite and restore as `label.tsx`. |
| `skeleton.tsx` | kit `base/skeleton.tsx` | `1a5da0f` | none — byte-identical |
| `sheet.tsx` | kit `base/sheet.tsx` | `1a5da0f` | one: `import { XIcon } from "lucide-react"` → `import { X as XIcon } from "@/icons"`. Nothing else. Copied 2026-09-10 only because the kit's `sidebar.tsx` imports it for its mobile branch; brigadier never renders that branch — `controls/sidebar.tsx`'s `Sidebar` substitutes its own `Modal` on mobile — so this file is dead weight kept so `sidebar.tsx` can stay a verbatim copy. Delete both together if the sidebar ever stops being a copy. |
| `sidebar.tsx` | kit `base/sidebar.tsx` | `1a5da0f` | one: `import { PanelLeftIcon } from "lucide-react"` → `import { Sidebar as PanelLeftIcon } from "@/icons"`. Nothing else — verified by reversing the substitution and diffing against the raw fetch. Copied 2026-09-10. Only parts of it are wired: `SidebarProvider` (controlled, for its context and its single ⌘B), `Sidebar` in its `collapsible="none"` form, `SidebarTrigger`, `SidebarInset`, `SidebarHeader`/`Content`/`Footer`, `SidebarGroup`/`GroupLabel`/`GroupContent`, `SidebarMenu`/`MenuItem`/`MenuButton`/`MenuAction`/`MenuSub`. Unused: `SidebarInput`, `SidebarSeparator`, `SidebarGroupAction`, `SidebarMenuBadge`, `SidebarMenuSkeleton`, `SidebarRail` (brigadier's export of that name returns `null`; resizing is `LayoutResizer`), `SidebarMenuSubButton` (an `<a>`; brigadier's rows are `<button>`s). |
| `sonner.tsx` | kit `base/sonner.tsx` | `1a5da0f` | two forced. (1) `next-themes` dropped; brigadier is dark-only (`index.html` and `src/main.tsx` stamp a static `dark` class), so `theme="dark"` is a literal. (2) the `icons={{…}}` override dropped — all five glyphs were `lucide-react`; sonner's own inline SVGs stand in. The `toastOptions.classNames` block is upstream's, verbatim. Not wired in. |
| `spinner.tsx` | shadcn `https://ui.shadcn.com/r/styles/base-nova/spinner.json` | `shadcn@4.21.0` | rewritten. Upstream is one `<Loader2Icon className="size-4 animate-spin">`; there is no lucide here and the vendored `@openai/apps-sdk-ui` set has no circular loader, so the 3/4 ring is drawn in the file as one inline `<path>` (lucide's `loader-circle` geometry). `data-slot`, `role="status"`, `aria-label="Loading"` and the `cn("size-4 animate-spin", …)` call are upstream's. `React.ComponentProps` → an imported `ComponentProps`. |
| `switch.tsx` | kit `base/switch.tsx` | `1a5da0f` | none — byte-identical |
| `tabs.tsx` | kit `base/tabs.tsx` | `1a5da0f` | none — byte-identical |
| `textarea.tsx` | kit `base/textarea.tsx` | `1a5da0f` | none — byte-identical |
| `toggle.tsx` | shadcn `https://ui.shadcn.com/r/styles/base-nova/toggle.json` | `shadcn@4.21.0` | `from "cn"` → `@/lib/utils`. Not wired in. Still carries upstream's Radix-era `data-[state=on]:bg-muted` alongside the `aria-pressed:bg-muted` that actually fires; left as upstream ships it. |
| `toggle-group.tsx` | shadcn `https://ui.shadcn.com/r/styles/base-nova/toggle-group.json` | `shadcn@4.21.0` | `from "cn"` → `@/lib/utils`. Not wired in. |
| `tooltip.tsx` | kit `base/tooltip.tsx` | `1a5da0f` | one: `TooltipContent` gained a `showArrow` prop (default `true`, so upstream's behaviour is the default) that gates `TooltipPrimitive.Arrow`. Upstream's arrow is a `bg-foreground` square rotated 45°, invisible only because upstream's popup is `bg-foreground` too; brigadier's panel is `glass-surface bg-elevated` (`controls/tooltip.tsx`), against which the arrow renders as a white diamond hanging off the panel — the owner reported it 2026-09-10. Both call sites (`controls/tooltip.tsx`, `assistant-ui/elements/tooltip-icon-button.tsx`) pass `showArrow={false}`; no call site draws an arrow. Opting out rather than restyling keeps the arrow's geometry upstream's for whenever a non-glass tooltip wants it. Its `data-[state=delayed-open]:` classes are Radix leftovers upstream ships next to the `data-open:` ones that fire here; left verbatim. |

`1a5da0f` is `1a5da0f272668cf313e5213e49aa70e0f987de6d`, default branch `main`, authored
2026-09-10T03:45:37Z.

Upstream already imports `cn` from `@/lib/utils`, which `tsconfig.json` maps to `src/lib/utils.ts`,
so the kit copies needed no import rewrite and the `cn` npm package is **not** installed. No file in
this directory imports `lucide-react`.

## Dependencies

| Package | Version | Why |
| --- | --- | --- |
| `@base-ui/react` | `^1.8.0` | what `packages/ui/package.json` pins; the base twin's primitives |
| `class-variance-authority` | `^0.7.1` | every `*Variants` export |
| `tw-animate-css` | `^1.4.0` | `animate-in` / `fade-in-0` / `zoom-in-95` / `slide-in-from-*` |
| `sonner` | `2.0.8` | the kit's `sonner.tsx` is a wrapper over it. Zero runtime dependencies of its own; peers are React 18/19. |

`shadcn add` installed `cn@^0.2.6` as a side effect (every generated file imports `cn` from that npm
package). It was **uninstalled** and the six imports rewritten to `@/lib/utils`, as
`docs/research/shadcn-base-ui.md` §3 prescribes and as the kit copies already do. `radix-ui` was
removed 2026-09-10 with the last Radix import; nothing under `src/` imports it.

## Wired in

`button.tsx` (imported directly by 57 files across `src/`; the `controls/button.tsx` adapter that used to
stand in front of it was deleted 2026-09-11 — `docs/plans/button-codemod-2026-09-11.md`, and its
brigadier-specific class recipes now live in `src/lib/surfaces.tsx`), `checkbox.tsx` +
`field.tsx` (`controls/checkbox.tsx`), `combobox.tsx` (`SelectMenu.tsx`), `collapsible.tsx` (`controls/collapsible.tsx`,
`controls/disclosure.tsx`, `elements/tool-call.tsx`, `elements/reasoning-panel.tsx`), `command.tsx`
(`controls/command.tsx`), `dialog.tsx` (`controls/modal.tsx`, and through it `controls/dialog.tsx`),
`dropdown-menu.tsx` + `popover.tsx` (`controls/overlay.tsx`, `controls/menu.tsx`), `input.tsx`
(`controls/input.tsx`), `kbd.tsx` (`controls/kbd.tsx`), `spinner.tsx` (`controls/status.tsx`),
`tabs.tsx` (`controls/tabs.tsx`), `textarea.tsx` (`controls/textarea.tsx`), `tooltip.tsx`
(`controls/tooltip.tsx`, `elements/tooltip-icon-button.tsx`), `sidebar.tsx`
(`controls/sidebar.tsx`). Each `controls/` file is a thin
adapter that keeps the export names and props its call sites already use.

Not wired in: `avatar`, `badge`, `label`, `scroll-area`, `select`, `separator`, `sheet`,
`skeleton`, `sonner`, `switch`, `toggle`, `toggle-group`.

Two facts about these files that bit during the port, both measured:

- **They do not forward a ref.** `DropdownMenuContent`, `DropdownMenuSubContent` and
  `DialogContent` are plain function components; a `ref` passed to them never reaches the Base UI
  popup. Ordinary props (`aria-label`, `data-*`, `initialFocus`) do. The adapters therefore find
  their popup by a `data-overlay` marker attribute rather than by ref. **`PopoverContent` is the
  exception** — it was rewritten here as a `forwardRef` and does reach the popup — but
  `controls/overlay.tsx` shares one lookup across the dialog and menu paths, so it uses the marker
  regardless.
- **`SidebarProvider` hard-codes `--sidebar-width: 16rem` inline** on the wrapper div, which is
  224px against this app's 14px root and beats any `:root` default. `controls/sidebar.tsx` merges
  Codex's 275px in ahead of a caller's own `style`, which is how `App.tsx`'s resized width still
  wins.
- **`useRender`'s `state` becomes `data-*`.** `SidebarMenuButton`'s `active: isActive` emits a
  bare `data-active` when true and *omits the attribute* when false — not `data-active="false"`.
  `src/index.css` selects it as `[data-active]:not([data-active="false"])` so either spelling
  works, and `controls/sidebar.test.tsx` pins which one is emitted.
- **`w-(--anchor-width)` on `DropdownMenuContent`** sizes the menu to its trigger, which is wrong
  for an icon-button trigger. `controls/overlay.tsx` overrides it with `w-auto`.

## Not copied, and why

`accordion`, `breadcrumb`, `code-block`, `command-tabs`,
`navigation-menu`, `table`, `steps`, `callout`, `definition-list`, `diff-viewer`, `dot-matrix`,
`number-roll`. (`sheet` and `sidebar` were on this list until 2026-09-10 and `combobox` until 2026-09-11; all three are copied now.) `alert-dialog` does not exist in the base twin at all
(`docs/research/assistant-ui-design.md`, "Does not exist in the base twin"); nothing needs one —
`controls/dialog.tsx` takes `role="alertdialog"` as a prop and no call site passes it.

- **`cmdk`.** The kit's `command.tsx` is a `cmdk` skin. `src/dependency-hygiene.test.ts:28-38`
  asserts `cmdk` is absent from `package.json` and unimported anywhere under `src/`, and `cmdk@1.1.1`
  depends on four individual `@radix-ui/react-*` packages (`react-dialog`, `react-id`,
  `react-primitive`, `react-compose-refs`), which `CLAUDE.md` §5 forbids. `ui/command.tsx` is the
  kit's command with plain elements underneath; `controls/search-dialog.tsx` keeps driving the
  active row through `aria-activedescendant`, unchanged.
- **`select.tsx` is copied but not wired.** `SelectMenu.tsx` went to `combobox.tsx` instead, on
  2026-09-11: Base UI `Select` has no filter input at all, and three of `SelectMenu`'s eight
  call sites pass `searchable` (Pickers' model, CommitPreferences' commit-message model,
  TaskSetupRail's starting point). The `role="button"` trigger plus `role="searchbox"` filter
  this bullet used to defend is gone with `controls/listbox.tsx`; both queries in
  `src/components/PromptInput.test.tsx` were rewritten to the roles Base UI actually emits, which
  `src/components/SelectMenu.test.tsx` measures.
- **`button-group`.** `controls/button-group.tsx` is ten lines and its one consumer
  (`SourceControl.tsx:503`) already hand-joins the segments with `!gap-0` + `rounded-r-none`.
  shadcn's version applies its own radius/border joining through `in-data-[slot=button-group]`
  variants and pulls `separator`; adopting it means re-tuning the call site for no visual gain.

## Rules

- The kit is Tailwind v4-native and depends on the token bridge at the top of `src/index.css`. Without
  it these files compile clean and render unstyled — no build error, no type error.
- Base UI's composition prop is `render`, not `asChild`, and its state attributes are
  `data-open` / `data-closed` / `data-checked`, not Radix's `data-state`. Collapsible is the trap:
  Root and Panel emit `data-open` / `data-closed`, but **Trigger emits only `data-panel-open`**
  (`@base-ui/react/collapsible/trigger/CollapsibleTriggerDataAttributes`). `src/index.css` defines
  `@custom-variant data-open` / `data-closed` to accept either spelling; there is no such bridge for
  the trigger.
- Base UI publishes a collapsible's measured height as `--collapsible-panel-height`, not Radix's
  `--radix-collapsible-content-height`.
