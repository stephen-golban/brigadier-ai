# assistant-ui design kit — can it replace our controls?

Researched 2026-09-10. Every claim below is tagged **[M]** measured (read in source, fetched from a
registry, or executed here) or **[A]** asserted (inferred, not proven). Sources are primary: the
assistant-ui docs site, the `assistant-ui/assistant-ui` GitHub tree, the npm registry, the Base UI
docs, and two experiments run in the scratchpad.

## Summary

**[M]** "assistant-ui design" is not an npm library. It is a copy-paste component kit that lives in the
monorepo package `@assistant-ui/ui` (`packages/ui`), which is marked `"private": true, "version":
"0.0.0"` and is **not published** — `https://registry.npmjs.org/@assistant-ui%2fui` returns
`{"error":"Not found"}`. The npm search for `assistant-ui` returns 25 packages and none of them is the
design kit.

**[M]** The kit ships as **identical twins**: `packages/ui/src/components/react/ui/base/*.tsx` (Base UI)
and `.../radix/*.tsx` (Radix, via the monolithic `radix-ui` package). `design.md` states the rule
verbatim: "Base is the standard and the radix twin mirrors it markup for markup. A new component lands
in both or it does not land." The docs pages under `/design/components/*` show the **base** twin.

**[M]** The base twin is built on **`@base-ui/react` 1.8.0** (MIT, published 2026-09-04, repo
`mui/base-ui`, directory `packages/react`). Note the package name: the old `@base-ui-components/react`
stopped at `1.0.0-rc.0` (2025-12-04); the shipping name today is `@base-ui/react`.

**[M]** The shadcn registry at `https://r.assistant-ui.com/registry.json` (151 items) does **not** serve
the design kit's controls. There is no `button.json`, `tooltip.json`, `dialog.json`, `kbd.json` or
`switch.json` — all 404. The only `registry:ui` items it serves are `badge`, `select`, `tabs`,
`accordion`, `dot-matrix`, `number-roll`, `diff-viewer`, `direction`, and those are the **Radix**
twins (`dependencies: ["class-variance-authority","radix-ui"]`). Our `components.json` points at
`https://r.assistant-ui.com/styles/{style}/{name}.json`, which is **404** — that route is stale.

**[M]** So the only supported acquisition path for Button/IconButton is: install `@base-ui/react` +
`class-variance-authority`, then copy the source. The docs say exactly that: *"Copy the source into
`components/ui/button.tsx`."*

**[M]** `lucide-react` is a real internal dependency of the kit, but **not of Button**. 22 of the 35
base files are lucide-free; 12 import it. Full list below.

**[M]** The kit is Tailwind v4-native (`@theme inline`, `@custom-variant`, `@source`) and requires
`tw-animate-css`, not `tailwindcss-animate`.

**Bottom line [A]:** the kit is adoptable — it is MIT source you copy, and Base UI coexists with our
`radix-ui` package (assistant-ui itself depends on both). But it is written against the **full shadcn
token set**, and our `@theme static` block deletes Tailwind's colour and radius namespaces
(`--color-*: initial`, `--radius-*: initial`). Adopting the kit means adding a token bridge first;
without it the copied files compile clean and render unstyled. That is measured, not guessed (see
Landmine 1).

## Install recipe

There is no `npx assistant-ui add button` and no `npx shadcn add https://r.assistant-ui.com/button.json`.

```sh
npm i @base-ui/react class-variance-authority
# optional, per component:
npm i lucide-react            # only for the 12 files listed below
npm i tw-animate-css          # required for the animate-in / fade-in-0 / zoom-in-95 utilities
npm i cmdk                    # command palette only
npm i sonner next-themes      # toast only
npm i react-shiki             # code-block / command-tabs only
```

Then copy files from
`https://raw.githubusercontent.com/assistant-ui/assistant-ui/main/packages/ui/src/components/react/ui/base/<name>.tsx`
into `src/components/ui/<name>.tsx` **[M]** — verified 200 for all 35 names.

Each file imports `cn` from `@/lib/utils`. Upstream that is `export { cn } from "cn";` (the `cn` npm
package 0.2.6, MIT, "drop-in replacement for clsx + tailwind-merge") **[M]**. Our
`src/lib/utils.ts` already exports a `cn` built from `clsx` + `tailwind-merge`, so the import resolves
unchanged and no new dependency is needed **[M]** — our `tsconfig.json` maps `@/*` to `./src/*`.

License: repo `assistant-ui/assistant-ui` is **MIT** **[M]**.

## Dependency table

| Package | Version pinned by the kit | License | Needed for | Conflict with us? |
| --- | --- | --- | --- | --- |
| `@base-ui/react` | `^1.8.0` (`packages/ui/package.json`) **[M]** | MIT **[M]** | every base twin except pure-CSS ones | No. Different package from `radix-ui`; assistant-ui's own `packages/ui` depends on **both** **[M]** |
| `class-variance-authority` | `^0.7.1` **[M]** | Apache-2.0 **[M]** | button, badge, tabs, sidebar, diff-viewer, callout | New dep for us |
| `lucide-react` | `^1.41.0` **[M]** | ISC **[A]** (not checked) | 12 of 35 base files | **We are removing it** — see the icon section |
| `cn` | `^0.2.6` **[M]** | MIT **[M]** | `@/lib/utils` upstream | Not needed; we already have `cn` |
| `tw-animate-css` | `^1.4.0` (docs app) **[M]** | MIT **[M]** | `animate-in`, `fade-in-0`, `zoom-in-95`, `slide-in-from-*` | New dep |
| `cmdk` | `^1.1.1` **[M]** | MIT **[M]** | `command.tsx` only | Optional |
| `sonner` + `next-themes` | `^2.0.8` / `^0.4.6` **[M]** | MIT **[M]** | toast only | Optional; `next-themes` is Next-flavoured but framework-agnostic **[A]** |
| `react-shiki` | `^0.11.1` **[M]** | MIT **[A]** | code-block, command-tabs | We already ship `shiki` directly |
| `tw-shimmer` | — **[M]** | — | elements shimmer | Already in our `package.json` |
| `radix-ui` | `^1.6.7` **[M]** | MIT **[A]** | the radix twin only | Already ours at `^1.6.7` — exact match |

Base UI peer deps **[M]**: `react ^17 || ^18 || ^19`, `react-dom ^17 || ^18 || ^19`,
`@types/react ^17 || ^18 || ^19`, plus **optional** `date-fns ^4` and `@date-fns/tz ^1.2` (calendar
only). Our React is `^19.1.0` — inside range **[M]**.

Base UI runtime deps **[M]**: `@babel/runtime ^7.29.7`, `@base-ui/utils 0.4.0`, `@floating-ui/utils`,
`@floating-ui/react-dom ^2.1.9`, `use-sync-external-store ^1.6.0`. `sideEffects: false` **[M]**.

`tailwindcss-animate` (last published 2023-08-28) is the v3-era plugin and is **not** used **[M]**;
`tw-animate-css` is its v4 replacement.

## Component table

`base/` holds 35 files **[M]** (listed from the GitHub contents API). "Docs page" means a page exists
at `/design/components/<name>`.

| Component | Exports | Primitive | lucide? | Docs page |
| --- | --- | --- | --- | --- |
| `button` | `Button`, `buttonVariants` | `@base-ui/react/button` | no | yes |
| `badge` | `Badge`, `badgeVariants` | `useRender` + `mergeProps` | no | yes |
| `input` | `Input` | `@base-ui/react/input` | no | yes |
| `textarea` | `Textarea` | native `<textarea>` | no | **no page** |
| `label` | `Label` | Base UI | no | **no page** |
| `kbd` | `Kbd`, `KbdGroup` | native `<kbd>` | no | yes |
| `switch` | `Switch` (sizes `sm`/`default`) | `@base-ui/react/switch` | no | yes |
| `separator` | `Separator` | `@base-ui/react/separator` | no | yes |
| `skeleton` | `Skeleton` | plain div | no | yes |
| `collapsible` | `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` | `@base-ui/react/collapsible` | no | yes |
| `tooltip` | `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider` | `@base-ui/react/tooltip` | no | yes |
| `popover` | `Popover`, `PopoverTrigger`, `PopoverContent`, `PopoverHeader`, `PopoverTitle`, `PopoverDescription` | `@base-ui/react/popover` | no | yes |
| `dialog` | `Dialog`, `DialogTrigger`, `DialogPortal`, `DialogOverlay`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription`, `DialogClose` | `@base-ui/react/dialog` | **yes** (`XIcon`) | yes |
| `sheet` | `Sheet`, `SheetTrigger`, `SheetClose`, `SheetContent`, `SheetHeader`, `SheetFooter`, `SheetTitle`, `SheetDescription` | `@base-ui/react/dialog` | **yes** (`XIcon`) | yes |
| `dropdown-menu` | `DropdownMenu*` (13 exports incl. `CheckboxItem`, `RadioGroup`, `Sub*`, `Shortcut`) | `@base-ui/react/menu` | **yes** | yes |
| `select` | `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`, `SelectGroup`, `SelectLabel`, `SelectSeparator`, `SelectScrollUp/DownButton` | `@base-ui/react/select` | **yes** | yes |
| `combobox` | `Combobox*` (13 exports) | `@base-ui/react/combobox` | **yes** | yes |
| `command` | `Command`, `CommandDialog`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandShortcut`, `CommandSeparator` | `cmdk` | **yes** (`SearchIcon`) | **no page** |
| `tabs` | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`, `tabsListVariants` | `@base-ui/react/tabs` | no | yes |
| `accordion` | `Accordion`, `AccordionItem`, `AccordionTrigger`, `AccordionContent` | `@base-ui/react/accordion` | **yes** | yes |
| `avatar` | `Avatar`, `AvatarImage`, `AvatarFallback`, `AvatarGroup`, `AvatarGroupCount`, `AvatarBadge` | `@base-ui/react/avatar` | no | yes |
| `breadcrumb` | `Breadcrumb*` (7 exports) | `useRender` | **yes** | yes |
| `navigation-menu` | `NavigationMenu*` (9 exports) | `@base-ui/react/navigation-menu` | no | **no page** |
| `sidebar` | `Sidebar*` (~25 exports) + `sidebar.test.tsx` | `useRender` | **yes** (`PanelLeftIcon`) | **no page** |
| `sonner` | `Toaster` | `sonner` + `next-themes` | **yes** (5 icons) | yes (as "Toast") |
| `table` | table primitives | native `<table>` | no | yes |
| `definition-list` | dl primitives | native | no | yes |
| `steps` | numbered rail | native | no | yes |
| `callout` | prose aside | native | no | yes |
| `code-block` | shiki code sheet | `react-shiki` | **yes** (`CheckIcon`,`CopyIcon`) | yes |
| `command-tabs` | multi-dialect install command | `react-shiki` | **yes** | yes |
| `diff-viewer` | `DiffViewer*` + 3 cva exports | native + `diff`/`parse-diff` | no | yes |
| `dot-matrix` | `DotMatrix`, `dotMatrixStates` | native | no | yes |
| `number-roll` | `NumberRoll` | native | no | yes |

### Does not exist in the base twin **[M]**

`checkbox`, `radio-group`, `scroll-area`, `slider`, `progress`, `toggle` / `toggle-group`,
`context-menu`, `hover-card`, `alert-dialog`, `card`, `alert`, `calendar`, `chart`, `carousel`,
`drawer`, `form`, `field`, `input-otp`, `input-group`, `button-group`, `pagination`, `resizable`,
`spinner`, `menubar`, `native-select`, `aspect-ratio`, `empty`, `item`.

All of those **do** exist in the `radix/` twin (64 files) **[M]**, so the radix twin is much more
complete than the base twin today. There is no `IconButton` component in either twin — the icon button
is `Button` with `size="icon" | "icon-xs" | "icon-sm" | "icon-lg"` **[M]**.

The **Scrollbar** docs page is not a component at all: its sample imports
`ScrollArea as ScrollAreaPrimitive from "radix-ui"` and the page says "The scrollbar ships with the
assistant-ui thread styles" **[M]**. It is a styling recipe, and it is Radix.

## Button / IconButton API

**[M]** Verbatim from `packages/ui/src/components/react/ui/base/button.tsx` (matches the docs page).

```tsx
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group/button focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive \
aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 \
inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding \
text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:ring-1 \
active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-1 \
[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  { variants: { variant: { ... }, size: { ... } },
    defaultVariants: { variant: "default", size: "default" } },
);

function Button({ className, variant = "default", size = "default", ...props }:
  ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <ButtonPrimitive data-slot="button"
    className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
export { Button, buttonVariants };
```

### Variants **[M]**

| Variant | Classes |
| --- | --- |
| `default` | `bg-primary text-primary-foreground hover:bg-primary/80` |
| `outline` | `bg-muted/70 text-foreground hover:bg-muted aria-expanded:bg-muted dark:bg-muted/50 dark:hover:bg-muted border-transparent` |
| `secondary` | `bg-secondary text-secondary-foreground aria-expanded:bg-secondary hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]` |
| `ghost` | `hover:bg-muted hover:text-foreground aria-expanded:bg-muted dark:hover:bg-muted/50` |
| `destructive` | `bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 …` |
| `link` | `text-primary underline-offset-4 hover:underline` (present in source; the docs API table **omits** it) |

### Sizes **[M]**

| Size | Height / box | Radius override | Icon size forced |
| --- | --- | --- | --- |
| `xs` | `h-6` `px-2` `text-xs` | `rounded-[min(var(--radius-md),10px)]` | `size-3` |
| `sm` | `h-7` `px-2.5` `text-[0.8rem]` | `rounded-[min(var(--radius-md),12px)]` | `size-3.5` |
| `default` | `h-8` `px-3` `text-sm` | base `rounded-lg` | `size-4` |
| `lg` | `h-9` `px-2.5` | base `rounded-lg` | `size-4` |
| `icon` | `size-8` | base `rounded-lg` | `size-4` |
| `icon-xs` | `size-6` | `rounded-[min(var(--radius-md),10px)]` | `size-3` |
| `icon-sm` | `size-7` | `rounded-[min(var(--radius-md),12px)]` | `size-4` |
| `icon-lg` | `size-9` | base `rounded-lg` | `size-4` |

`icon-lg` is in the source but is **missing from the docs API table** **[M]**.

### Props **[M]**

`ButtonPrimitive.Props` — from the Base UI Button docs:

| Prop | Type | Default |
| --- | --- | --- |
| `render` | `ReactElement \| function` | — |
| `nativeButton` | `boolean` | `true` |
| `focusableWhenDisabled` | `boolean` | `false` |
| `disabled` | `boolean` | `false` |
| `className` | `string \| (state) => string` | — |
| `style` | `CSSProperties \| (state) => CSSProperties` | — |

Plus native `<button>` props. Data attribute: `data-disabled`.

- **There is no `asChild`.** Base UI's composition prop is `render` **[M]**.
- **There is no loading state.** No `loading` / `isPending` / spinner anywhere in `button.tsx` **[M]**.
  The kit has no `spinner` in the base twin either.
- Contextual selectors the button reacts to **[M]**: `aria-expanded` (menu/popover triggers get the
  hover fill while open), `aria-invalid`, `aria-haspopup` (suppresses the 1px press translate),
  `has-data-[icon=inline-start|inline-end]` (asymmetric padding when an icon slot is present), and
  `in-data-[slot=button-group]` (radius normalises inside a button group — but `button-group` exists
  only in the **radix** twin).

### Tokens Button alone needs **[M]**

`--color-primary`, `--color-primary-foreground`, `--color-secondary`, `--color-secondary-foreground`,
`--color-muted`, `--color-foreground`, `--color-destructive`, `--color-ring`, `--color-border`,
`--radius-lg`, `--radius-md`, plus the `dark` variant.

## Token table

The kit's closed token set, read from `apps/docs/styles/globals.css` **[M]**. Mapping column is
**[A]** — a proposal, not something upstream sanctions.

| Their token | Used as | Our candidate |
| --- | --- | --- |
| `--background` | `bg-background` — page ground | `--color-canvas` |
| `--foreground` | `text-foreground`, hairlines via `/10` | `--color-text` |
| `--card` / `--card-foreground` | slabs | `--color-elevated` / `--color-text` |
| `--popover` / `--popover-foreground` | dialog, popover, menu ground | `--color-elevated` / `--color-text` |
| `--primary` | filled button ground | `--color-accent` (kit uses a near-white neutral in dark, not a hue — decide deliberately) |
| `--primary-foreground` | filled button ink | `--color-canvas` |
| `--secondary` / `--secondary-foreground` | second-weight button | `--color-elevated` / `--color-text` |
| `--muted` | `bg-muted` — ghost/outline hover fill, input ground | `--color-hover` (hover) and `--color-input` (fields) — **one token doing two jobs for us** |
| `--muted-foreground` | secondary ink, placeholder | `--color-text-secondary` |
| `--accent` / `--accent-foreground` | menu-item hover | `--color-selected` / `--color-text` |
| `--destructive` | error state | `--color-error` |
| `--border` | `border-border`, `bg-border` (separator) | `--color-hairline` |
| `--input` | disabled field ground | `--color-input` |
| `--ring` | `focus-visible:ring-ring/50` | `--color-attention` |
| `--code-surface` | code slab fill | `--color-input-shell` |
| `--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-border`, `--sidebar-ring` | sidebar only | `--color-sidebar` + our text/hairline set; skip unless we copy `sidebar.tsx` |
| `--chart-1` … `--chart-5` | data viz only | not needed |
| `--tint` (`106`) | the one hue knob for every neutral | not applicable; our neutrals are hex |
| `--radius` (`0.5rem`) | root, feeds `--radius-lg` | new |
| `--radius-page` `0` / `--radius-document` `6px` | paper vs printed matter | new |
| `--radius-sm` `0.375rem` | kbd, inline code, smallest icon button | ours is `4px` — close |
| `--radius-md` / `--radius-control` `0.5rem` | button, input | ours is `10px` — **differs** |
| `--radius-lg` `var(--radius)` = `0.5rem` | Button's base radius | ours is `16px` — **differs badly** |
| `--radius-surface` `0.625rem` | menu, popover, tooltip | new |
| `--radius-xl` `0.75rem` | dialog, toast | new (ours does not define `--radius-xl` at all) |
| `--radius-2xl` `1rem`, `--radius-3xl` `1.5rem` | Tailwind compat only | new |
| `--radius-thread` `1rem` | composer + user bubble | ours is `--radius-composer: 28px` |
| `--radius-capsule` / `--radius-pill` `9999px` | switch, avatar, dot | new |
| `--font-sans`, `--font-display`, `--font-mono` | type roles | we have sans + mono; no display face |
| `--tracking-hero`, `--tracking-section`, `--font-weight-hero` | headings | marketing only |
| `--page-width` (`80rem`) | `--container-7xl` | marketing only |
| `--shadow-2xs` … `--shadow-2xl` | **all set to `0 0 #0000`** — shadows are zeroed globally, only floating surfaces lift | we define `--shadow-overlay` |
| `--animate-shimmer` | `tw-shimmer` sweep | already ours |

**[M]** Beyond the semantic set, some components reach for **raw Tailwind palette colours**:
`--color-blue-400/500/600`, `--color-green-400/500/600/700`, `--color-amber-400/500/600`,
`--color-red-400/500/600`, `--color-purple-400/500/600`, `--color-emerald-500`, plus `text-white`,
`bg-black`, `text-current`. Files: `dot-matrix.tsx`, `diff-viewer.tsx`, `sonner.tsx`, `callout.tsx`,
`steps.tsx`, `badge.tsx` (destructive uses `text-white`). Our `--color-*: initial` deletes every one of
them (measured, Landmine 1). `design.md` forbids raw `gray-*`/`zinc-*` in chrome but clearly permits
these hues in product/state content.

## Theming

**[M]** Setup, verbatim shape from `apps/docs/styles/globals.css`:

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));
@custom-variant data-open  (&:where([data-state="open"],  [data-open]:not([data-open="false"])));
@custom-variant data-closed (&:where([data-state="closed"], [data-closed]:not([data-closed="false"])));

@theme inline {
  --radius-lg: var(--radius);
  --color-background: var(--background);
  --color-primary: var(--primary);
  /* …one --color-X: var(--X) line per semantic token… */
  --shadow-sm: 0 0 #0000;   /* every shadow zeroed */
}

:root { --radius: 0.5rem; --tint: 106; --background: oklch(0.992 0.002 var(--tint)); /* … */ }
.dark { --background: oklch(0.17 0.003 var(--tint)); /* … */ }
```

- **Tailwind v4 `@theme` is the native mechanism** **[M]**. The kit is `@theme inline` + raw
  `:root`/`.dark` custom properties — exactly shadcn's v4 layout. It has no `tailwind.config`.
- **Radius is one knob** **[M]**: `--radius: 0.5rem` on `:root` feeds `--radius-lg`; the semantic
  aliases (`--radius-control`, `--radius-surface`, `--radius-xl`, `--radius-thread`, `--radius-capsule`)
  are absolute values, not derived. To change the global roundness the owner changes `--radius`, then
  the semantic aliases individually. There is no shadcn-style `calc(var(--radius) - 2px)` ladder here.
- **`tw-animate-css` is required, `tailwindcss-animate` is not** **[M]**. Measured: with a bare
  `@import "tailwindcss"`, `animate-in` / `fade-in-0` / `zoom-in-95` / `slide-in-from-top-2` are **not
  emitted**; after adding `@import "tw-animate-css"` all four are emitted.
- `@custom-variant data-open` / `data-closed` are the kit's own bridge between Radix `data-state` and
  Base UI `data-open` attributes **[M]** — copy both or every open/close animation is dead in the base
  twin, which uses `data-open:` / `data-closed:` throughout (`dialog.tsx`, `popover.tsx`, `tooltip.tsx`).
- The kit also relies on `@source "../../../packages/ui/src";` to scan the component files **[M]**. We
  use `@source "./**/*.tsx"` under `source(none)`, which already covers `src/components/ui/`.

## Dark mode

**[M]** The kit is **`.dark`-class-based**: `@custom-variant dark (&:is(.dark *))` plus a `.dark { … }`
block redefining every semantic custom property. Not `prefers-color-scheme`. Not `@custom-variant dark`
without an argument. It also uses `next-themes` in the docs app to toggle the class, but that is app
plumbing, not a kit requirement **[A]**.

**Minimal dark-only setup for brigadier [A]:**

1. Define the semantic tokens once at `:root` with the **dark** values. Skip the `.dark` block entirely.
2. Still declare `@custom-variant dark (&:is(.dark *))` **and put `class="dark"` on `<html>`** —
   otherwise every `dark:`-prefixed rule in the copied files silently does nothing. There are 20+ such
   rules in button/input/textarea/badge alone **[M]**. The alternative (strip every `dark:` prefix from
   the copied source) is a permanent divergence from upstream and makes future re-copies painful.
3. Our current `src/index.css` is dark-first with a `:root.light` override and has **no `dark` variant
   defined at all** **[M]**. Under Tailwind v4's default, `dark:` compiles to
   `@media (prefers-color-scheme: dark)` — so today a copied component's `dark:` rules would fire off
   the user's OS setting, not our theme. That is a silent wrong-by-default.

## Base UI specifics that bite

- **`render`, not `asChild`** **[M]**. `<Button render={<a href="…" />}>Link</Button>`. For non-primitive
  components the kit exposes it through `useRender` + `mergeProps` (see `badge.tsx`).
- **`nativeButton` warns at runtime** **[M], executed here**. Rendering `<Button render={<a/>}>` logs:
  *"Base UI: A component that acts as a button expected a native `<button>` because the `nativeButton`
  prop is true. … Use a real `<button>` in the `render` prop, or set `nativeButton` to `false`."* The
  element still renders. Any anchor-as-button needs `nativeButton={false}`.
- **Popup anatomy is 3 levels, not 1** **[M]**: `Portal > Positioner > Popup` (+ optional `Arrow`).
  Radix is `Portal > Content`. Every port of a Radix popover/tooltip/menu gains a wrapper. The kit puts
  `className="isolate z-50"` on the **Positioner** and `z-50` again on the Popup.
- **Root `isolation: isolate` is a documented requirement** **[M]**, from
  `https://base-ui.com/react/overview/quick-start`: wrap the app in `<div className="root">{children}</div>`
  with `.root { isolation: isolate; }` — *"This way, popups always appear above the page contents, and
  any `z-index` property in your styles won't interfere with them."* The same page adds
  `body { position: relative; }` for iOS 26+ Safari backdrops (irrelevant to a Tauri macOS build **[A]**).
- **State attributes differ** **[M]**: Base UI emits `data-open` / `data-closed` / `data-checked` /
  `data-unchecked` / `data-disabled` / `data-horizontal` / `data-vertical`; Radix emits
  `data-state="open|closed|checked"` / `data-orientation`. Any of our tests or CSS that assert on
  `data-state` will not match a Base UI component.
- **Sides are logical** **[M]**: `side="inline-start" | "inline-end"` alongside `left`/`right`, and the
  kit's tooltip/popover styles carry RTL-aware `rtl:` rules.
- **Focus** **[M]**: the kit sets `:focus-visible { box-shadow: none; }` globally in `@layer base` and
  draws focus with `focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:border-ring`. Copying
  a component without that global reset gives you a doubled focus ring **[A]**.
- **Scroll-lock workaround** **[M]**: the kit ships a `body[data-scroll-locked] { margin-right: 0
  !important; padding-right: 0 !important; overflow: visible !important; --removed-body-scroll-bar-size:
  0px !important; }` block. Without it, opening a dialog shifts the layout.
- SSR: not relevant to us. The files carry `"use client"` directives, which Vite ignores **[A]**.

## Compatibility with our stack

**Vitest + jsdom: measured, and it works with no polyfills.** I installed `@base-ui/react@1.8.0`,
`react@19.1.0`, `vitest@4.1.11`, `jsdom@30.0.1`, `@testing-library/react@16.3.3` in a scratch project
with a bare `environment: "jsdom"` config — **no setup file, no `ResizeObserver` / `PointerEvent` /
`scrollIntoView` shim** — and ran six tests: Button renders; Button `render`-composes an anchor; Dialog
opens on click; Menu opens on click; Tooltip opens on hover; Select opens on click. **6 passed, 0
failed, 661 ms.** **[M]**

Corroborating **[M]**: `packages/ui/vitest.config.ts` upstream is also plain `environment: "jsdom"` with
no `setupFiles`, and it runs `sidebar.test.tsx`.

Base UI's own suite does use two jsdom accommodations, in `test/setupVitest.ts` **[M]**:
`globalThis.BASE_UI_ANIMATIONS_DISABLED = true` (a documented global escape hatch) and a
`requestAnimationFrame` → `setTimeout` shim gated on a jsdom user agent. Neither was needed for the six
cases above, but `BASE_UI_ANIMATIONS_DISABLED` is worth knowing about if an exit animation ever makes a
test flaky **[A]**.

**Bundle size: measured with esbuild 0.25.10, `--bundle --minify --format=esm`, React external.** **[M]**

| Entry | Minified | Gzip |
| --- | --- | --- |
| `@base-ui/react/button` alone | 7,727 B | **3,202 B** |
| button + tooltip + dialog + menu + popover + select + switch + separator + collapsible + tabs + avatar + input + useRender | 258,332 B | **84,764 B** |

Tree-shaking works: the button subpath pulls 3 KB gzip, not the whole library. The 9.6 MB unpacked npm
tarball is source + CJS + ESM + types + docs and is not what ships **[M]**. For scale, the whole
control set above costs ~85 KB gzip — real, but a Tauri app serves it from disk **[A]**.

**Radix coexistence:** no conflict. `radix-ui` and `@base-ui/react` are unrelated packages with
disjoint imports; assistant-ui's own `packages/ui` depends on both at the versions we already have
(`radix-ui ^1.6.7` — an exact match with our `package.json`) **[M]**.

## Icons

**[M]** The kit ships **no icon set of its own**. `packages/ui/components.json` declares
`"iconLibrary": "lucide"`, and 12 of the 35 base files import `lucide-react`:

| File | Icons imported |
| --- | --- |
| `accordion.tsx` | `ChevronDownIcon` |
| `breadcrumb.tsx` | `ChevronRightIcon`, `MoreHorizontalIcon` |
| `code-block.tsx` | `CheckIcon`, `CopyIcon` |
| `combobox.tsx` | `CheckIcon`, `ChevronDownIcon`, `XIcon` |
| `command-tabs.tsx` | `CheckIcon`, `CopyIcon` |
| `command.tsx` | `SearchIcon` |
| `dialog.tsx` | `XIcon` |
| `dropdown-menu.tsx` | `CheckIcon`, `ChevronRightIcon`, `CircleIcon` |
| `select.tsx` | `CheckIcon`, `ChevronDownIcon`, `ChevronUpIcon` |
| `sheet.tsx` | `XIcon` |
| `sidebar.tsx` | `PanelLeftIcon` |
| `sonner.tsx` | `CircleCheckIcon`, `InfoIcon`, `Loader2Icon`, `OctagonXIcon`, `TriangleAlertIcon` |

Total distinct icons: **14**. Substituting apps-sdk-ui equivalents is a 12-file, 14-icon edit **[A]**.

**Lucide-free (22 files)** **[M]**: `avatar`, `badge`, `button`, `callout`, `collapsible`,
`definition-list`, `diff-viewer`, `dot-matrix`, `input`, `kbd`, `label`, `navigation-menu`,
`number-roll`, `popover`, `separator`, `skeleton`, `steps`, `switch`, `table`, `tabs`, `textarea`,
`tooltip`. **Button and IconButton cost us no lucide.**

### Descendant-svg selectors that will resize our icons **[M]**

Our apps-sdk-ui icons are bare `<svg fill="currentColor">` at 24×24 with `1em` sizing. These selectors
set `width`/`height` in CSS, which beats the SVG's `width="1em"` attribute **[A]** — every icon will
snap to the kit's size unless it already carries a `size-*` class.

| File | Selector |
| --- | --- |
| `button.tsx` base | `[&_svg]:pointer-events-none`, `[&_svg]:shrink-0`, `[&_svg:not([class*='size-'])]:size-4` |
| `button.tsx` size `xs` | `[&_svg:not([class*='size-'])]:size-3` |
| `button.tsx` size `sm` | `[&_svg:not([class*='size-'])]:size-3.5` |
| `button.tsx` size `icon-xs` | `[&_svg:not([class*='size-'])]:size-3` |
| `badge.tsx` | `[&>svg]:pointer-events-none`, `[&>svg]:size-3` |
| `kbd.tsx` | `[&_svg:not([class*='size-'])]:size-3` |

The `:not([class*='size-'])` escape hatch is deliberate: **an svg that carries its own `size-4` /
`size-5` class opts out** **[M]**. So the clean adaptation is to give every apps-sdk-ui icon a
`size-*` class at the call site, or to add one inside the icon component itself. `[&_svg]:shrink-0`
and `[&_svg]:pointer-events-none` are unconditional and harmless.

## Landmines

1. **Our `@theme static` reset deletes the utilities the kit is built on — silently.** Measured with
   `@tailwindcss/cli@4.3.3` against a theme block copying our `--color-*: initial; --radius-*: initial`:
   `bg-primary`, `text-primary-foreground`, `bg-muted`, `text-muted-foreground`, `border-border`,
   `ring-ring`, `bg-white`, `text-black`, `bg-blue-500`, **and `rounded-xl`** are all **NOT EMITTED**.
   `rounded-lg`, `rounded-md`, `rounded-sm`, `rounded-full`, `rounded-none`, `size-8` are emitted. **[M]**
   There is no build error and no TypeScript error — the button just renders transparent, unpadded and
   square-ish. Worse than missing: `rounded-lg` *does* emit and resolves to **our 16px**, where the kit
   means 8px, so the button silently comes out as a pill-ish blob. Every semantic colour token the kit
   uses has to be added to our `@theme` before a single file is copied.

2. **`dark:` is dead or wrong in our CSS today.** The kit is `.dark`-class-scoped; our `src/index.css`
   defines no `dark` variant and is dark-first with `:root.light`. **[M]** Tailwind v4's default `dark:`
   is `prefers-color-scheme`, so ~20 `dark:` rules in the copied controls will fire off the user's OS
   setting rather than our theme. Fix before copying: add `@custom-variant dark (&:is(.dark *))` and put
   `class="dark"` on `<html>`, or accept a permanent strip-the-prefixes fork.

3. **There is no package and no registry route — this is a manual, un-versioned copy.** `@assistant-ui/ui`
   is `private: true, version 0.0.0` and unpublished; `r.assistant-ui.com/button.json` (and tooltip,
   dialog, kbd, switch) return **404**; the registry route in our own `components.json`
   (`https://r.assistant-ui.com/styles/{style}/{name}.json`) is **404** and stale. **[M]** Whatever we
   copy is a fork with no update path, no changelog and no semver. Record the source commit.

Further, in descending order:

4. **`animate-in` / `fade-in-0` / `zoom-in-95` / `slide-in-from-*` need `tw-animate-css`.** Measured
   missing without it, emitted with it. Dialog, popover, tooltip, sheet and select all use them. **[M]**
5. **`@custom-variant data-open` / `data-closed` must be copied too**, or every enter/exit animation in
   the base twin is inert. **[M]**
6. **Base UI wants `.root { isolation: isolate }` around the app** for popup stacking. **[M]**
7. **The base twin is incomplete**: no checkbox, radio, scroll-area, slider, progress, toggle, spinner,
   alert-dialog, context-menu, hover-card, card. Any of those has to come from the Radix twin, which
   means the app runs both primitive libraries at once. **[M]**
8. **No loading state on Button** and no `spinner` in the base twin — if our controls have a pending
   state today it has to be rebuilt on top. **[M]**
9. **Base UI popups are `Portal > Positioner > Popup`,** three elements where Radix has two; our
   existing approval-card and menu markup does not translate 1:1. **[M]**
10. **`data-state` assertions in our tests will not match** Base UI's `data-open` / `data-checked`. **[M]**
11. **Shadows are globally zeroed** in the kit's `@theme` (`--shadow-*: 0 0 #0000`) and lift is applied
    only on floating surfaces. Our `--shadow-overlay` survives (it is not in the `--shadow-*` namespace
    the kit zeroes) but the kit's intent conflicts with any ambient shadow we have. **[M]**
12. **`in-data-[slot=button-group]` radius rules in Button reference a `button-group` component that
    exists only in the Radix twin.** Harmless, but dead code in a base-only adoption. **[M]**
13. **The docs pages' "Install the dependencies" lists are incomplete.** `select.md` and `accordion.md`
    list no packages, yet both sources import `@base-ui/react` and `lucide-react`. Trust the GitHub
    source, not the docs' dependency list. **[M]**
14. The kit's `--radius-md` is `0.5rem` (8px) where ours is 10px, and `--radius-lg` is `0.5rem` where
    ours is 16px. The `rounded-[min(var(--radius-md),12px)]` expressions on `sm`/`icon-sm` mean our
    values quietly change button geometry rather than break it. **[M]**

## Not checked

- **The Radix twin's sources.** I read the base twin in full and only listed the radix twin's filenames.
  If we go radix-twin-first (more complete, and it uses the `radix-ui` monolith we already have) that
  is a separate read.
- **`lucide-react` license** — assumed ISC from memory, not fetched.
- **`react-shiki` license** — not fetched.
- **Whether `next-themes` works outside Next.** Assumed yes; not verified. Only affects toast.
- **Whether the design kit's components actually render correctly under our token bridge.** I proved
  which utilities Tailwind emits; I did not build a page with our tokens and look at it.
- **The paint budget.** No burn run. Adding `@base-ui/react` and `tw-animate-css` to the render path
  has an unmeasured effect on the 287–295 ms p50 exec → FCP figure in `docs/STATUS.md` §4.
- **Visual regression against the docs site.** The kit's look depends on the `--tint: 106` oklch sand
  family; mapped onto our neutral hexes it will not look like assistant-ui.com, and I did not evaluate
  whether that matters to the owner.
- **`@assistant-ui/react` 0.15.18 (ours) vs the monorepo's workspace version.** The kit's `elements/`
  components assume the current runtime; our pinned version may lag. Not compared.
- **`nativeButton={false}` accessibility consequences** beyond the warning text.
- **Whether upstream intends to publish `@assistant-ui/ui`.** No roadmap statement found; `design.md`
  itself forbids roadmap tense, so absence of a claim is expected.
- **`sidebar.test.tsx` contents** — I noted it exists as evidence that base components run under bare
  jsdom, but did not read it.
- **Bundle numbers under our actual Vite config.** Measured with standalone esbuild, React external.

## Sources

- `https://www.assistant-ui.com/design.md` (design law, kit roster, token API, traps)
- `https://www.assistant-ui.com/design/components/<name>.md` — all 30 pages fetched, all 200
- `https://www.assistant-ui.com/AGENTS.md`, `https://www.assistant-ui.com/llms.txt`
- `https://github.com/assistant-ui/assistant-ui` — `packages/ui/package.json`,
  `packages/ui/components.json`, `packages/ui/vitest.config.ts`, `packages/ui/src/lib/utils.ts`,
  `packages/ui/src/components/react/ui/{base,radix}/*`, `apps/docs/styles/globals.css`,
  `apps/docs/package.json`. Repo pushed 2026-09-10T04:33Z, default branch `main`, MIT.
- `https://r.assistant-ui.com/registry.json` (151 items), `.../utils.json`, `.../badge.json`
- `https://registry.npmjs.org/` — `@base-ui/react`, `@base-ui-components/react`, `@assistant-ui/*`,
  `cn`, `tw-animate-css`, `tailwindcss-animate`, `class-variance-authority`, `cmdk`, `sonner`,
  `next-themes`
- `https://base-ui.com/react/overview/quick-start`, `https://base-ui.com/react/components/button`
- `https://github.com/mui/base-ui` — `vitest.shared.mts`, `test/setupVitest.ts`
- Experiments run here: a Vitest 4.1.11 + jsdom 30 + React 19.1 render suite against `@base-ui/react`
  1.8.0 (6/6 pass, no polyfills); an esbuild 0.25.10 bundle-size measurement; a
  `@tailwindcss/cli@4.3.3` build against a replica of our `@theme static` reset.
