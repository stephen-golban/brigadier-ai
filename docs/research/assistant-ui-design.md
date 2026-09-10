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

---

## Applied 2026-09-10

The foundation landed on branch `ui/design-system`. Everything below is **[M]** measured in this
tree unless tagged otherwise.

**Upstream commit:** `assistant-ui/assistant-ui@1a5da0f272668cf313e5213e49aa70e0f987de6d`
(default branch `main`, authored 2026-09-10T03:45:37Z), directory
`packages/ui/src/components/react/ui/base/`. The path had not moved. Recorded in
`src/components/ui/UPSTREAM.md`.

**Installed:** `@base-ui/react@1.8.0`, `class-variance-authority@0.7.1`, `tw-animate-css@1.4.0`.
The `cn` npm package was **not** installed; `src/lib/utils.ts` already exports one and every copied
file imports `cn` from `@/lib/utils`, which `tsconfig.json` and `vite.config.ts` both map to `src/`.

**Copied, byte-identical to upstream, zero deviations:** `button`, `tooltip`, `kbd`, `separator`,
`skeleton`, `badge`, `avatar`, `input`, `textarea`, `switch`, `label`. None imports `lucide-react`.
Only `button` is wired in.

### Landmine 1 reproduced and closed, here

Built with `@tailwindcss/cli@4.3.3` against `src/index.css`, same source tree both times — the only
difference is the token bridge:

| Utility | Before (with `--color-*: initial`) | After |
| --- | --- | --- |
| `.bg-primary` | not emitted | emitted (`background-color: var(--primary)`) |
| `.text-muted-foreground` | not emitted | emitted (`color: var(--muted-foreground)`) |
| `.rounded-xl` | not emitted | emitted (as `.rounded-xl!`, the one live usage; `0.75rem`) |
| `.bg-hover` | emitted | emitted |
| `.text-text-secondary` | emitted | emitted |
| `.animate-in` | not emitted | emitted |

Output grew 86,892 B → 100,852 B raw, 14,432 B → 16,185 B gzip.

### Token mapping

Decision 1 says the kit's **names** are the source of truth and the app's current dark look is
preserved. So the kit's slots are filled with brigadier's existing hex values, and the 26
`--color-*` tokens become aliases of those slots. Kit tokens with no brigadier counterpart keep
upstream's value.

| brigadier token | → kit token | value | note |
| --- | --- | --- | --- |
| `--color-canvas` | `--background` | `#181818` | |
| `--color-text` | `--foreground` | `#e3e3e3` | |
| `--color-elevated` | `--popover` (`--card` shares it) | `#2b2b2b` | menus, dialogs, slabs |
| `--color-input-shell` | `--code-surface` | `#1f1f1f` | |
| `--color-input` | `--input` | `#2a2a2a` | the kit uses `--input` only for `disabled:bg-input/50`; brigadier's solid field fill wins the slot |
| `--color-hover` | `--muted` | `rgba(255,255,255,0.05)` | the kit's ghost/outline hover fill |
| `--color-selected` | `--accent` | `rgba(255,255,255,0.08)` | `--secondary` carries the same value |
| `--color-hairline` | `--border` | `rgba(255,255,255,0.08)` | |
| `--color-text-secondary` | `--muted-foreground` | `#a1a1a1` | |
| `--color-attention` | `--ring` | `#3b82f6` | upstream's dark `--ring` is a neutral grey; brigadier's focus colour replaces it |
| `--color-error` | `--destructive` | `#e07a7a` | upstream's is `oklch(0.704 0.191 22.216)`, far more saturated |
| `--color-sidebar` | `--sidebar` | `#202020` | same name, same job, one declaration |
| — | `--primary` / `--primary-foreground` | `#e3e3e3` / `#181818` | matches the existing `.rename-save` treatment |
| — | `--secondary-foreground`, `--card-foreground`, `--popover-foreground`, `--accent-foreground` | `#e3e3e3` | |
| — | `--sidebar-primary` / `-ring` | `#3b82f6` | |
| — | `--sidebar-accent` / `-border` | `rgba(255,255,255,0.08)` | |
| — | `--chart-1` … `--chart-5` | upstream's dark values | no counterpart |
| — | `--tint` | `106` | inert: brigadier's neutrals are hex, so only the chart ramp would use it |
| `--color-pressed` | — | `rgba(255,255,255,0.12)` | literal kept; no kit counterpart |
| `--color-text-tertiary` | — | `#7f7f7f` | literal kept; the kit has one secondary ink, brigadier has three |
| `--color-text-disabled` | — | `#676767` | literal kept |
| `--color-warn` | — | `#ef8c57` | literal kept |
| `--color-ok` | — | `#74b58a` | literal kept |
| `--color-backdrop` | — | `rgba(0,0,0,0.5)` | literal kept |
| `--color-menu-glass`, `--color-glass-edge`, `--color-sidebar-tint`, `--color-sidebar-glass`, `--color-sidebar-blue`, `--color-sidebar-teal`, `--color-shadow` | — | unchanged | the vibrancy set has no kit counterpart |
| `--color-accent` | **collides** | `var(--ring)` = `#3b82f6` | see below |

**The one collision: `--color-accent`.** brigadier means the brand blue by it (5 `var(--color-accent)`
sites in `src/components/composer/composer.css` and `attachments.css`); the kit means the menu-item
hover fill. Both want the same Tailwind theme key. brigadier's meaning was kept, so
`--color-accent` is **not** declared in the `@theme inline` bridge. Nothing breaks today — the only
copied file that reaches for `bg-accent` is `badge.tsx`, on an anchor-badge hover that is unused —
but `dropdown-menu`, `select` and `command` all style their hover row with
`bg-accent text-accent-foreground`, so the order that copies them must first rewrite those 5 CSS
sites to `var(--ring)` and hand `--color-accent` back to the kit.

### Emission mechanics: `@theme inline` does not emit the variable

**[M]** With `@theme inline { --color-input: var(--input) }`, Tailwind emits
`.bg-input { background-color: var(--input) }` and **never emits `--color-input` itself**. That is
fine for utilities and fatal for the ~15 hand-written CSS files that read `var(--color-input)` and
that Tailwind never scans (only `src/index.css` is the entry). `--color-sidebar` and `--color-input`
therefore live in the `@theme static` legacy block, not in the inline bridge. A script that walks
every `var()` in `src/**/*.{css,tsx,ts}` against the built stylesheet reports **0 unresolved names**.

**[A], not measured here:** `src/lib/theme.ts` feeds `--color-*` to Monaco through
`getComputedStyle().getPropertyValue()`, which now returns aliases. Per CSS Custom Properties §3 the
computed value of a custom property is its specified value *with variables substituted*, so a browser
returns `#181818`; jsdom does not substitute, so `src/lib/theme.test.ts` now resolves the one hop
itself. This has not been checked in a real webview.

### Radius mapping

`:root { font-size: 14px }` is set in `@layer base`, so **every `rem` in this app is 14px, not 16px**.
The kit's scale is `rem`; it was copied verbatim rather than pinned to px, so it lands 12.5% under
upstream's intent.

| | before | kit token | kit value | effective px here |
| --- | --- | --- | --- | --- |
| `--radius-sm` | `4px` | `--radius-sm` | `0.375rem` | 5.25px |
| `--radius-md` | `10px` | `--radius-md`, `--radius-control` | `0.5rem` | 7px |
| `--radius-lg` | `16px` | `--radius-lg` = `var(--radius)` | `0.5rem` | 7px |
| — | — | `--radius-surface` | `0.625rem` | 8.75px |
| — | — | `--radius-xl` | `0.75rem` | 10.5px |
| — | — | `--radius-2xl`, `--radius-thread` | `1rem` | 14px |
| — | — | `--radius-3xl` | `1.5rem` | 21px |
| — | — | `--radius-capsule`, `--radius-pill` | `9999px` | — |
| — | — | `--radius-page`, `--radius-none` | `0` | — |
| — | — | `--radius-document` | `var(--radius-sm)` | 5.25px |
| `--radius-composer` | `28px` | (`--radius-thread` is 1rem) | kept literal | 28px |

Live effect: `rounded-md` 28 sites 10px → 7px, `rounded-lg` 7 sites 16px → 7px, `rounded-sm` 2 sites
4px → 5.25px, plus `var(--radius-lg)` twice in `src/index.css` (the sidebar peek corner).

### Deviations from upstream

In `src/index.css` (the copied files themselves have none):

1. Colour values are brigadier's, per decision 1 — see the table above.
2. Dark-only: upstream's `.dark { }` block's roles are declared straight on `:root`; there is no light
   block and no `.light` override. `@custom-variant dark (&:is(.dark *))` is kept and both
   `index.html` and `src/main.tsx` put a static `dark` class on `<html>`, so every `dark:` rule in the
   copied files resolves against the class rather than the OS preference.
3. `--color-accent` is omitted from the inline bridge (the collision above).
4. `--color-sidebar` and `--color-input` moved from the inline bridge to the static block so the
   variables are emitted for hand-written CSS.
5. `--font-sans` keeps brigadier's system stack; `--font-display` aliases it, because this app has one
   face and upstream's display face is a marketing choice.
6. `--spacing: 4px` is kept. Tailwind's default is `0.25rem`, which is 3.5px at this root size.
7. `@import "tailwindcss" source(none)` plus the two explicit `@source` lines are kept — upstream has
   no equivalent, and dropping them makes Tailwind scan `node_modules`.
8. Upstream's marketing-only tokens (`--page-width`, `--container-7xl`, the fumadocs `--color-fd-*`
   bridge, the `tailwind-scrollbar` and typography plugins, the collapsible/accordion keyframes) are
   not copied.
9. Added from the kit's `@layer base`: `#root { isolation: isolate }` (Base UI's documented popup
   requirement — upstream wraps the app in `.root` instead), `:focus-visible { box-shadow: none }`,
   and the `body[data-scroll-locked]` reset.
10. `@custom-variant data-open` / `data-closed` are copied verbatim.

## Elements 2026-09-10 — buttons onto the kit, `dark:` retired

Scope: `src/components/assistant-ui/elements/**` and `src/lib/surfaces.tsx`. Measured unless marked
asserted.

### What changed

| File | Change |
| --- | --- |
| `message-actions.tsx` | 5 raw `<button className={ghostButton}>` → `@/components/ui/button` at `variant="ghost" size="icon-sm"`; local className narrowed to `rounded-full text-text/45`. |
| `chat-panel.tsx` | Send button → kit `Button` at default variant, `size="icon-sm"`, `className="rounded-full"`; `inkButton` import dropped. |
| `tooltip-icon-button.tsx` | Now kit `Button` (`variant="ghost" size="icon"`) inside kit `Tooltip`/`TooltipTrigger render={…}`/`TooltipContent`. |
| `thread.tsx` | `controls/button` → `@/components/ui/button`; `isIconOnly size="sm"` → `size="icon"`. |
| `surfaces.tsx` | `ghostButton` and `inkButton` deleted; six `dark:` sites collapsed. |
| `reasoning-panel.tsx`, `thinking-indicator.tsx` | `dark:bg-attention` deleted (equal to base). |

### `dark:` decisions

The app is dark-only (`<html class="dark">`, `@custom-variant dark (&:is(.dark *))`), so a `dark:`
variant is either dead weight or the only value that ever paints.

| Site | Before | After | Rule |
| --- | --- | --- | --- |
| `surfaces.paper` | `bg-canvas … dark:bg-elevated` | `bg-elevated …` | dark value wins |
| `surfaces.floating` | `bg-canvas … dark:bg-elevated` | `bg-elevated …` | dark value wins |
| `surfaces.field` | `bg-text/[0.04] dark:bg-text/[0.06]` | `bg-text/[0.06]` | dark value wins |
| `surfaces.fieldInteractive` | `bg-text/[0.04] hover:bg-text/[0.07] dark:bg-text/[0.06] dark:hover:bg-text/[0.09]` | `bg-text/[0.06] hover:bg-text/[0.09]` | dark values win (two sites) |
| `surfaces.ghostButton` | `… dark:hover:bg-text/[0.09]` | recipe deleted | superseded by the kit's `ghost` |
| `surfaces.live` | `text-attention dark:text-attention` | `text-attention` | identical, variant dropped |
| `message-actions` ×2 | `bg-text/[0.06] text-text/90 dark:bg-text/[0.09]` | `bg-text/[0.09] text-text/90` | dark value wins |
| `thread.tsx` ×2 | `bg-canvas dark:bg-canvas` | `bg-canvas` | identical, variant dropped |
| `reasoning-panel.tsx` | `bg-attention dark:bg-attention` | `bg-attention` | identical, variant dropped |
| `thinking-indicator.tsx` | `bg-attention … dark:bg-attention` | `bg-attention …` | identical, variant dropped |

12 sites, not the 14 the brief estimated; `tool-call.tsx` carries no `dark:` variant.

**Measured**, `npx @tailwindcss/cli@4.3.3 -i src/index.css -o …` before and after: the only selectors
that disappear are the ones deleted on purpose — `dark:bg-{attention,canvas,elevated}`,
`dark:bg-text/[0.06]`, `dark:bg-text/[0.09]`, `dark:text-attention`, `dark:hover:bg-text/[0.09]`,
`bg-text/[0.04]`, `hover:bg-text/[0.06]`, `hover:bg-text/[0.07]`, `hover:opacity-90`,
`focus-visible:ring-text/20`, `transition-[canvas-color,color,scale]`, `disabled:opacity-30`. Every
replacement (`bg-text/[0.06]`, `hover:bg-text/[0.09]`, `bg-text/[0.09]`, `bg-elevated`,
`text-text/45`, `text-ok`, `place-items-center`, `bg-primary`, `hover:bg-primary/80`,
`dark:hover:bg-muted/50`) is present in the new output. Caveat: the two runs are not a clean A/B —
another worker landed new `src/components/ui/**` files between them, which is why the output grew
from 100,852 to 126,160 bytes and 764 to 918 selectors. Nothing *disappeared*, which is the claim.

### `src/lib/surfaces.tsx` exports

Retired: `ghostButton`, `inkButton` (nothing in `src/` imports either; `WorkTrace.tsx` takes only
`ShimmerLabel`). Kept: `paper`, `floating`, `field`, `fieldInteractive`, `pressable`, `collapsePanel`,
`live`, `mono`, `codeScroll`, `codeSurface`, `iconSwap{,In,Out}`, `labelSwap{,In,Out}`,
`ShimmerLabel`, `SwapLabel`.

### Upstream

**Measured.** The registry index is `https://r.assistant-ui.com/registry.json` (151 items); item URLs
are `https://r.assistant-ui.com/<item>.json`. `https://r.assistant-ui.com/index.json` and the bare
root both 404. Source at SHA `1a5da0f272668cf313e5213e49aa70e0f987de6d` lives at
`packages/ui/src/components/react/assistant-ui/elements/<name>.tsx` (155 files); `apps/registry` holds
only generation scaffolding. Every registry item installs to `components/assistant-ui/elements/<name>.tsx`.

All 20 local elements have an upstream counterpart — **none is Brigadier-invented**. 16 carry the
`elements-` registry prefix; four (`markdown-text`, `syntax-highlighter`, `thread`,
`tooltip-icon-button`) are older core items with no prefix. `thread`'s upstream source file is
`elements/thread.aui.tsx`.

| Local file | Registry item | Brigadier extensions vs upstream |
| --- | --- | --- |
| `agent-handoff.tsx` | `elements-agent-handoff` | not diffed |
| `agent-plan.tsx` | `elements-agent-plan` | not diffed |
| `agent-status.tsx` | `elements-agent-status` | not diffed |
| `approval-card.tsx` | `elements-approval-card` | not diffed |
| `artifact-card.tsx` | `elements-artifact-card` | not diffed |
| `background-inbox.tsx` | `elements-background-inbox` | rewritten against `BackgroundRun`; rows are `.element-list-row` CSS, not Tailwind |
| `chat-panel.tsx` | `elements-chat-panel` | brigadier tokens; send button now kit `Button` (upstream keeps `inkButton`) |
| `checkpoint-history.tsx` | `elements-checkpoint-history` | rewritten against `Checkpoint`; `.element-list-row` CSS |
| `composer.tsx` | `elements-composer` | not diffed |
| `markdown-text.tsx` | `markdown-text` (core) | brigadier `SyntaxHighlighter`, `Copy`/`Check` from `src/icons` |
| `message-actions.tsx` | `elements-message-actions` | **diverges**: upstream still uses `ghostButton` + raw `<button>` and `text-emerald-500`; ours is kit `Button` + `text-ok`, plus optional `copyLabel` and optional `onReactionChange`/`onRegenerate`/`onMore` (upstream requires all four) |
| `reasoning-panel.tsx` | `elements-reasoning-panel` | brigadier tokens, `dark:` removed |
| `recommendation-card.tsx` | `elements-recommendation-card` | not diffed |
| `subagent-list.tsx` | `elements-subagent-list` | rewritten against `SubagentItem`; `.subagent-row` CSS |
| `syntax-highlighter.tsx` | `syntax-highlighter` (core) | local test at `syntax-highlighter.test.tsx` |
| `thinking-indicator.tsx` | `elements-thinking-indicator` | brigadier tokens, `dark:` removed |
| `thread.tsx` | `thread` (core, `thread.aui.tsx`) | wholly local: wraps `ChatPanel` + `ThreadPrimitive.Viewport`, adds the `ReadonlyViewport` fallback for `ReadonlyThreadProvider` |
| `todo-list.tsx` | `elements-todo-list` | not diffed |
| `tool-call.tsx` | `elements-tool-call` | brigadier `Collapsible`, `SwapLabel`, `ShimmerLabel` |
| `tooltip-icon-button.tsx` | `tooltip-icon-button` (core) | **converges**: upstream is `Button variant="ghost" size="icon"` inside kit Tooltip, which is now ours. Remaining deltas — upstream wraps in its own `TooltipProvider delayDuration={0}`, defaults `side="bottom"`, adds `aui-button-icon size-6 p-1 active:scale-90` and `Slot.Slottable`; ours keeps a native `title` and exports the extra `MessageAction` label wrapper |

Not verified: the twelve rows marked "not diffed" — upstream existence and path were confirmed by
fetching the registry item, but their bodies were not compared line by line. Do not overwrite a local
element from the registry without doing that diff first; several of these are rewrites, not themes.

`surfaces.tsx` itself is upstream `elements-surfaces` (installed here at `src/lib/surfaces.tsx`, not
the registry's `components/assistant-ui/elements/surfaces.tsx`). Retiring `ghostButton`/`inkButton` is
a **deliberate divergence**: a future `npx shadcn add elements-message-actions` would drag both back.

## Applied 2026-09-10 (2) — owner radius raise, focus indicator removed

Two owner decisions taken after looking at the running app. Both are in `src/index.css`; one also
touches `src/components/controls/button.tsx`. Everything below is **measured** from
`npx @tailwindcss/cli@4.3.3 -i src/index.css -o out.css`, not asserted.

### Radius: every named step +2px

| token | before | after |
| --- | --- | --- |
| `--radius` | 16px | 18px |
| `--radius-sm` | 4px | 6px |
| `--radius-md` | 10px | 12px |
| `--radius-lg` | 16px | 18px |
| `--radius-surface` | 10px | 12px |
| `--radius-xl` | 12px | 14px |

`--radius-composer` (28px) and the `9999px` pill/capsule steps are untouched, as are the steps with
no call site (`--radius-control`, `--radius-2xl`, `--radius-thread`, `--radius-3xl`), which still
carry upstream's rem literals. Emitted:

```css
.rounded-sm { border-radius: 6px; }
.rounded-md { border-radius: 12px; }
.rounded-lg { border-radius: 18px; }
.rounded-xl { border-radius: 14px; }
```

`src/components/controls/button.tsx`: `STANDARD_ICON_BUTTON` went `rounded-[8px]` → `rounded-[10px]`.

**The kit's corner clamp bites.** `src/components/ui/button.tsx` sizes `xs` and `icon-xs` and
`src/components/ui/toggle-group.tsx` `data-[size=sm]` pin `rounded-[min(var(--radius-md),10px)]`.
With `--radius-md` at 12px that is `min(12px, 10px)` = 10px, so those three stay at the old value
while every sibling moved to 12. The `min(var(--radius-md),12px)` variants (`sm`, `icon-sm`, toggle
`sm`) are fine — they now resolve to 12px, which is the intended +2.

Only `icon-xs` has call sites (`Toasts.tsx:102`, `ArchivedSessions.tsx:229,298`), all through the
adapter, so only it was corrected — in the adapter, never in the copied kit file:

```ts
export const XS_ICON_BUTTON_RADIUS = "rounded-[12px]";
```

appended after the kit's variant string, where `cn`'s tailwind-merge resolves the two `rounded-`
classes in its favour. The adapter's own `size="icon"` path is unaffected: kit `icon` is plain
`size-8` and `STANDARD_ICON_BUTTON`'s `rounded-[10px]` replaces the base `rounded-lg`.

### Focus: no outline, no ring, anywhere

Owner decision, and an accepted accessibility regression — keyboard focus has no visible indicator
in this app. Recorded again in `docs/STATUS.md` §7 so a future session does not "fix" it.

One unlayered block in `src/index.css`, placed after `@layer base` and before the first component
rule. Unlayered is the whole trick: Tailwind's utilities sit in `@layer utilities`, and an unlayered
author rule wins over a layered one regardless of specificity, so not one `focus-visible:` class had
to be deleted from `src/components/ui/`.

```css
*, *::before, *::after { outline: none !important; }
:focus, :focus-visible, [data-focus-visible] { outline: none; }

[class*="focus-visible:ring"]:focus-visible:not([aria-invalid="true"]),
[class*="focus-visible:ring"][data-focus-visible]:not([aria-invalid="true"]) {
  --tw-ring-color: transparent;
  --tw-ring-shadow: 0 0 #0000;
}

:where([data-slot="button"], [data-slot="badge"], [data-slot="input"], [data-slot="textarea"],
       [data-slot="select-trigger"], [data-slot="tabs-trigger"]):focus-visible:not([aria-invalid="true"]) {
  border-color: transparent;
}
[data-slot="checkbox"]:focus-visible:not([aria-invalid="true"]),
[data-slot="toggle"]:focus-visible:not([aria-invalid="true"]) { border-color: var(--color-input); }
[data-slot="checkbox"][data-checked]:focus-visible:not([aria-invalid="true"]),
[data-slot="switch"][data-checked]:focus-visible:not([aria-invalid="true"]) { border-color: var(--primary); }
[data-slot="switch"][data-unchecked]:focus-visible:not([aria-invalid="true"]) {
  border-color: color-mix(in oklab, var(--foreground) 20%, transparent);
}
```

**Why that neutralises the ring, measured.** At tailwindcss 4.3.3 a ring *width* utility sets the
shadow variable and the five-part composite, and a ring *colour* utility sets only the colour
variable:

```css
.focus-visible\:ring-\[3px\]:focus-visible {
  --tw-ring-shadow: var(--tw-ring-inset,) 0 0 0 calc(3px + var(--tw-ring-offset-width)) var(--tw-ring-color, currentcolor);
  box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);
}
.focus-visible\:ring-ring\/50:focus-visible {
  --tw-ring-color: var(--ring);
  @supports (color: color-mix(in lab, red, red)) {
    --tw-ring-color: color-mix(in oklab, var(--ring) 50%, transparent);
  }
}
```

`focus-visible:ring-1` (the kit Button's) is the same shape with `1px`. Overwriting both variables
from the unlayered block leaves the `box-shadow` composite in place — so a real `shadow-*` on a
focused element still paints — and renders the ring slot as `0 0 #0000`. Overwriting `box-shadow`
itself would have been the blunt alternative and would have eaten those shadows. `--tw-ring-shadow`
is declared `@property … initial-value: 0 0 #0000`, so the value written back is the initial one.

**Why `border-color` needed nine names.** `focus-visible:border-ring` emits
`border-color: var(--ring)` — a 1px blue edge, a focus indicator by any other name. It cannot be
neutralised generically because the value to restore is whatever each component's resting border
was. Seven of the nine kit files carrying the class rest at `border-transparent` (`button`, `badge`,
`input`, `textarea`, `select` trigger, `tabs` trigger — plus `toggle`'s default variant, which has
no border width at all); `checkbox` and `toggle`'s `outline` variant rest at `border-input`; and
`switch` rests at `data-checked:border-primary` / `data-unchecked:border-foreground/20`. Each is put
back to its own value. `:where()` keeps the seven-way selector from out-weighing the rest; weight is
irrelevant anyway, since unlayered beats layered.

**`aria-invalid` is excluded on purpose.** `aria-invalid:ring-1` and `aria-invalid:ring-destructive/20`
set the same two variables from `[aria-invalid="true"]`, and validation is not focus. Without the
`:not()`, focusing an invalid field would erase its destructive ring.

**Why the `[class*="focus-visible:ring"]` gate exists.** The first draft of this block was
ungated — `:focus-visible { --tw-ring-shadow: 0 0 #0000 }` — and that is wrong. All rings on an
element share the one `--tw-ring-shadow` slot, and five kit surfaces draw a decorative hairline with
a **non-focus** ring: `ring-1 ring-foreground/10` on `popover-content` (`popover.tsx:59`),
`dialog-content` (`dialog.tsx:56`), `select-content` (`select.tsx:73`) and the sonner toast body
(`sonner.tsx:22`), and `ring-2 ring-background` on `avatar` (`avatar.tsx:62,78,94`). Base UI focuses
a popup when it opens, so the ungated rule erased those hairlines the instant a dialog took focus.
Gating on the literal class string separates the two cleanly: checked 2026-09-10 by enumerating every
`ring-` occurrence in `src/`, **no element in this tree carries both a static ring and a
`focus-visible:ring`**, and the five surfaces above carry no focus-ring class at all.

**Not checked / known limits.** A future focus ring written `focus:ring-*` instead of
`focus-visible:ring-*` slips past the gate; so would one applied through a `group-*`/`peer-*` variant
on an element with no `focus-visible:ring` class of its own. No `data-[focus-visible]:` utility is
emitted from this tree today — that half of the selector is there for Base UI parts that may start
setting the attribute, and it is untested. `grep -rn 'inset-ring' src/` is empty, so
`--tw-inset-ring-shadow` was left alone. There are no skip links; the two `.sr-only` labels
(`src/Launch.tsx:378`, `src/components/Sidebar.tsx:751`) label inputs and never take focus, so no
outline escape hatch was needed. Nothing here was checked against a real screen reader, and no
keyboard-only pass was run in the built app — the evidence is the emitted CSS, `npx tsc --noEmit`,
`npm test` and `npm run build`, nothing more.

## Applied 2026-09-11 — the theme owns every corner and every colour

**Owner decision.** One theme edit must drive the whole app. Before this pass the radius scale was
in the `@theme inline` bridge and roughly forty surfaces pinned their own px corner beside it; the
tooltip, the settings shell, the file tree, the terminal palette and the welcome starters carried
raw hex. Measured with
`grep -rnE 'rounded-\[[0-9.]+px\]|border-radius: *[0-9.]+px' src --include='*.tsx' --include='*.css' | grep -v 'src/components/ui/'`
(60 hits before, 0 after) and the matching colour grep.

### Two layers, both in `@theme static`

`@theme static` and not `@theme inline`: `inline` prunes a theme variable no *utility* mentions, and
the semantic names below are read as `var(--radius-row)` from hand-written CSS and from
`rounded-[var(--radius-…)]` arbitrary values — neither counts as a mention. `static` emits every
name. Both layers still land on `:root` in the emitted stylesheet (verified against
`npx @tailwindcss/cli@4.3.3 -i src/index.css -o out.css`; the block is `:root` inside `@layer theme`).

**Layer 1 — the scale, now monotonic.** The pre-2026-09-11 scale had `--radius-xl` (12px) *below*
`--radius-lg` (16px), which is not a scale.

| step | before | after | who moved with it |
| --- | --- | --- | --- |
| `--radius-xs` | — (new) | 4px | `--radius-row-action`, `--radius-chip` |
| `--radius-sm` | 4px | **6px** | `rounded-sm` × 5: `controls/kbd.tsx`, `controls/overlay.tsx:450` menu row, `WorkTrace.tsx:117`, kit `command.tsx:127`, kit `tooltip.tsx` kbd. Also `--radius-document`. |
| `--radius-md` | 10px | 10px | unchanged; still read by the kit's four `rounded-[min(var(--radius-md),Npx)]` clamps |
| `--radius-lg` | 16px | 16px | unchanged |
| `--radius-xl` | 12px | **20px** | `rounded-xl` × 4: kit `sonner.tsx:22`, kit `command.tsx:28`, kit `sidebar.tsx:301` inset, `controls/command.tsx:31` dialog |
| `--radius-2xl` | 1rem = 14px | **28px** | no `rounded-2xl` call site |
| `--radius-3xl` | 1.5rem = 21px | **36px** | no call site |
| `--radius-full` | — (new; `--radius-capsule`/`--radius-pill` were 9999px) | 9999px | `rounded-full` × 27, value unchanged |
| `--radius-surface` | 10px | `var(--radius-md)` = 10px | kit popover/dropdown/select/tooltip |
| `--radius-thread` | 1rem = 14px | `var(--radius-lg)` = 16px | no call site |
| `--radius`, `--radius-capsule`, `--radius-pill`, `--radius-document` | literals | `var()` of the scale | — |

`--radius-control` was upstream's `0.5rem` with no call site in this tree; it is repurposed as the
semantic control corner below.

**Layer 2 — the semantic layer.** Every entry is a `var()` of the scale, never a px literal. A call
site names the surface, never the number.

| token | scale ref | px | surfaces |
| --- | --- | --- | --- |
| `--radius-control` | `md` | 10 | buttons, inputs |
| `--radius-control-lg` | `lg` | 16 | the 48px onboarding field |
| `--radius-icon-button` | `sm` | 6 | `STANDARD_ICON_BUTTON` (24px box) |
| `--radius-icon-button-xs` | `sm` | 6 | `XS_ICON_BUTTON_RADIUS` |
| `--radius-row` | `md` | 10 | sidebar rows, toolbar buttons, menu rows |
| `--radius-row-action` | `xs` | 4 | the 20px hover action inside a sidebar row |
| `--radius-popover` | `md` | 10 | popovers, dropdowns, menus |
| `--radius-dialog` | `lg` | 16 | dialogs |
| `--radius-tooltip` | `xl` | 20 | the tooltip pill |
| `--radius-keycap` | `sm` | 6 | the keycap inside a tooltip |
| `--radius-composer` | `2xl` | 28 | the composer shell and the chat panel |
| `--radius-card` | `lg` | 16 | cards, grouped-row panels, error panels |
| `--radius-tab` | `sm` | 6 | workbench tabs |
| `--radius-chip` | `xs` | 4 | inline code, directive chips |
| `--radius-thumbnail` | `sm` | 6 | attachment thumbnails |
| `--radius-bubble` | `xl` | 20 | the peer chat bubble |
| `--radius-badge` | `full` | 9999 | count badges, segmented pills |
| `--radius-glyph` | `calc(xs / 2)` | 2 | the composer's 12px stop square — a glyph, not a surface |

### Surface deltas — old px → token → new px

`--sidebar-row-radius` is now `var(--radius-row)`. **Codex's measured 12.5px row corner
(`docs/research/codex-sidebar.md` §4.4) is therefore no longer matched exactly; the match is now
"nearest scale step", 10px.** The same wording applies to every 8px, 9px, 11px, 12px and 23px
corner below: they were never steps on any scale.

| surface | old | token | new |
| --- | --- | --- | --- |
| sidebar row / group / project row | 12.5 | `--radius-row` | 10 |
| sidebar header + footer toolbar button | 10 | `--radius-row` | 10 |
| sidebar row hover action | 8 | `--radius-row-action` | **4** |
| standard icon button (`controls/button.tsx`) | 8 | `--radius-icon-button` | **6** |
| `icon-xs` button (`controls/button.tsx`) | 10 | `--radius-icon-button-xs` | **6** |
| tooltip pill | 20 | `--radius-tooltip` | 20 |
| tooltip keycap | 10 | `--radius-keycap` | **6** |
| workbench tab | 7 | `--radius-tab` | 6 |
| workbench change-count badge | 999 | `--radius-badge` | 9999 |
| welcome starter card | 14 | `--radius-card` | **16** |
| rename dialog | 22 | `--radius-dialog` | **16** |
| rename dialog input / buttons | 9 / 10 | `--radius-control` | 10 |
| onboarding name input (`intro.css`) | 16 | `--radius-control-lg` | 16 |
| welcome continue button (`intro.css`) | 7 | `--radius-control` | **10** |
| launch error panel (`intro.css`) | 16 | `--radius-card` | 16 |
| settings nav search / delete-all / unarchive | 10 | `--radius-control` | 10 |
| settings nav item | 8 | `--radius-row` | **10** |
| archive search field | 20 | `--radius-xl` | 20 |
| archive rows panel | 16 | `--radius-card` | 16 |
| thread-context panel | 20 | `--radius-xl` | 20 |
| peer bubble | 18 | `--radius-bubble` | **20** |
| peer task group | 12 | `--radius-card` | **16** |
| peer task button / icon tile | 9 / 8 | `--radius-control` / `--radius-row` | 10 |
| attachment thumbnail | 6 | `--radius-thumbnail` | 6 |
| setup menu option | 11 | `--radius-row` | 10 |
| setup popover input | 9 | `--radius-control` | 10 |
| `.element-surface` | 10 | `--radius-surface` | 10 |
| inline code / directive chip | 4 | `--radius-chip` | 4 |
| composer format menu | 10 | `--radius-popover` | 10 |
| composer suggestions / attachment preview | 12 | `--radius-popover` | **10** |
| composer suggestion option / permission option / model row | 7 / 12 / 10 | `--radius-row` | 10 |
| composer attachment pill | 9 | `--radius-control` | 10 |
| composer queue (base / open override) | 16 / 20 | `--radius-card` / `--radius-xl` | 16 / 20 |
| composer queue edit field | 6 | `--radius-sm` | 6 |
| composer stop symbol | 2 | `--radius-glyph` | 2 |
| **composer shell `.brigadier-composer`** | **23** | `--radius-composer` | **28** |
| composer control | 18 | `--radius-xl` | **20** |
| composer setup rail / popover / effort track | 20 | `--radius-xl` | 20 |
| execution provider pills | 999 | `--radius-full` | 9999 |
| effort level button | 5 | `--radius-xs` | **4** |
| execution exact input | 8 | `--radius-control` | **10** |
| composer approval strip | 12 | `--radius-md` | **10** |
| file tree row (`WorkspaceTools.tsx`) | 8 | `--radius-row` | **10** |
| file filter input (`WorkspaceTools.tsx`) | 12 | `--radius-control` | **10** |
| notes panels ×3 (`NotesLibrary.tsx`) | 12 | `--radius-card` | **16** |
| chat panel (`elements/chat-panel.tsx`) | 24 | `--radius-composer` | **28** |
| monaco inputbox/button (`vscode-panels/panels.css`) | 4 | `--radius-xs` | 4 |
| search-editor overlay (`vscode-panels/panels.css`) | 8 | `--radius-md` | **10** |

The composer shell is the loudest one: `.brigadier-composer` (unlayered) was overriding the
`rounded-composer` utility on the *same element*, so `--radius-composer: 28px` was dead and the
composer wore 23px. Both now read the token.

### Colour tokens added

On `:root` (`src/index.css`):

- `--tooltip: var(--popover)`, `--tooltip-foreground: var(--sidebar-foreground)`,
  `--tooltip-border: var(--border)`. Codex measures the pill at `rgb(45,45,45)` (§4.9) and
  `--popover` is `#2b2b2b` = `rgb(43,43,43)`; two units apart, so the tooltip is unified onto the
  popover surface rather than carrying a fourth near-identical grey. The measured
  `rgba(255,255,255,.084)` edge unifies onto `--border` (`rgba(255,255,255,.08)`) for the same
  reason. **Owner-directed; this is a value change of 2/255 on the surface and 0.004 alpha on the edge.**
- `--settings-*` (17 tokens) — the settings shell's own desaturated-teal family, every one of them a
  literal in `src/components/settings.css` until now. Values carried over unchanged except
  `--settings-search`, whose `#2b2b2b` **is** `--popover` and now says so.
- `--focus-edge: #578cdd` — the rename dialog's focus border. Deliberately **not** folded into
  `--ring` (`#3b82f6`): that is a different blue, and unifying it is an owner decision, not a cleanup.
- `--shadow-ink-weak|-soft|(none)|-strong` — the four `#0001`-family alphas every drop shadow was
  writing for itself, named by weight, values identical (`#0001` = `#00000011`, and so on).
- `--ansi-*` (15 tokens) — the xterm palette that lived as hex literals in
  `src/components/TerminalView.tsx`. The component now reads them off `:root` and passes
  `undefined` rather than a literal when a token is absent, so xterm keeps its own default and no
  stale copy of a colour survives in the file. `brightBlack` still tracks `--color-text-secondary`.

In `@theme static` (`--color-*`, so `bg-`/`text-` utilities also resolve):

- `--color-on-accent: #ffffff` — ink or fill that must stay pure white on a coloured or dark
  ground: the change-count badge and the effort slider's knob. `--primary-foreground` is the dark
  ink and cannot serve.
- `--color-file-ts|js|style|markup|doc|rust|media|text|unknown` — the nine file-type inks from
  `WorkspaceTools.tsx`'s table, consumed as `style={{ color: "var(--color-file-…)" }}`.
  `--color-file-text` and `--color-file-unknown` are `var()`s of existing tokens; the rest keep
  their values.
- `--color-starter-explore|build|review|fix` — the four welcome-starter accents from `ThreadView.tsx`.

Stale `var(--token, #literal)` fallbacks were stripped from `thread-context.css` (10) and
`composer.css` (16). A fallback literal silently defeats a theme edit, and several were already
wrong — `var(--color-elevated, #292929)` when `--color-elevated` is `#2b2b2b`.

### What is deliberately still a literal

- **`0 0 #0000`** in `src/index.css` and `src/focus-reset.css` — Tailwind's own "no shadow"
  sentinel for `--tw-ring-shadow` / `--shadow-*`, not a colour.
- **`border-radius: 50%`** on the composer send button, spinner, range thumb, effort ticks and the
  workbench tab's close button — a shape, not a step on a scale.
- **Comments.** `controls/input.tsx:15`, `controls/tooltip.tsx:23`, `focus-reset.css:152-153` and
  several in `src/index.css` quote measured upstream values in prose. They are documentation of
  what was measured, not live declarations.
- **`src/intro.css` / `CosmicField.tsx`.** Nothing was left: the three `var(--color-canvas, #181818)`
  fallbacks were stripped and the three corners tokenised. `CosmicField.tsx` is a GLSL shader and
  carries no hex at all — its `radius=` is a signed-distance field, not a corner.

### Not checked

No visual pass in the built app. The evidence is the four gates below, the emitted stylesheet, and
the greps — nothing was looked at. The scale re-order moves five `rounded-sm` call sites and four
`rounded-xl` call sites that no work order named; a screenshot pass is the missing half.

## Applied 2026-09-11 (2) — the Button adapter is deleted

The "Button / IconButton API" table above was written to justify a shim; the shim is gone.
`src/components/controls/button.tsx` is deleted and all 202 `<Button>` call sites outside
`src/components/ui/` now import the kit Button (`@/components/ui/button`) directly, per
`docs/plans/button-codemod-2026-09-11.md`. The six things the adapter owned were relocated rather
than dropped: the variant alias map (`primary`→`default`, `danger`→`destructive`) is spelled at the
call site; the brigadier icon-box geometry and ink are class recipes in `src/lib/surfaces.tsx`
(`iconButton`, `iconButtonXs`, `iconButtonInk`, `labelledButtonIcons`, `toggleButton`), byte-identical
to the strings the adapter emitted and always `cn()`-composed *before* the site's own `className` so
tailwind-merge still resolves a deliberate override in the site's favour; `isDisabled` / `onPress` /
`isIconOnly` / `iconStyle` became `disabled` / `onClick` / `size="icon"` / nothing; the `.button`
class and the `data-icon-button` / `data-variant` markers became `[data-slot="button"]` (emitted at
`src/components/ui/button.tsx:51`) plus the `icon-button` class the box recipes carry, converted
selector for selector at identical specificity across four stylesheets; and `data-autofocus` is now
set by the one Button that needs it. The section's own §"Props **[M]**" measurement stands — what
changed is the conclusion drawn from it. **The live hazard this leaves behind** is the default flip:
the adapter defaulted `variant="ghost" size="sm"`, the kit defaults to `variant="default"`
(filled primary) at `size="default"` (32px), and a `<Button>` that omits either prop compiles
cleanly while rendering as a large filled button. Every call site is explicit today, checked by
parsing all 202 opening tags rather than by grep (multi-line tags defeat `grep '<Button>'`); keep it
that way. Not checked: no visual pass and no burn run, so the paint budget is unverified here.
