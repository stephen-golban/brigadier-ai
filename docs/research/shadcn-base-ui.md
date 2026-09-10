# shadcn's Base UI components — can they fill the assistant-ui kit's gaps?

Researched 2026-09-10. Every claim is tagged **[M]** measured (read in source, fetched from the
registry, or executed here) or **[A]** asserted. Companion to
`docs/research/assistant-ui-design.md`, which covers the assistant-ui kit itself.

Primary sources: `ui.shadcn.com` docs (`.md` variants), the shadcn registry JSON, the published
`shadcn@4.21.0` npm tarball (CLI source read directly), `base-ui.com`, and the npm registry. Three
experiments were run in `/tmp` and are described where they are cited.

## Summary

**[M]** Yes. shadcn officially ships Base UI variants of its whole component set. The switch is not a
flag on `add`; it is the `style` value in `components.json`. The schema at
`https://ui.shadcn.com/schema.json` enumerates 26 styles: the two legacy Radix ones (`default`,
`new-york`) plus a 3 × 8 grid of `{radix|base|aria}-{vega|nova|maia|lyra|mira|luma|sera|rhea}`.
`base-*` is Base UI. `npx shadcn init` takes `-b, --base <base>` (base, radix, aria) and
`-p, --preset [name]` (default `nova`), and writes the two together as one `style` string.

**[M]** shadcn targets **`@base-ui/react`** — the same package name assistant-ui's kit uses, not the
retired `@base-ui-components/react`. Running `shadcn add drawer` installed **`@base-ui/react@^1.8.0`**
into a scratch project. npm `latest` is `1.8.0`, published 2026-09-04, MIT. **Exact match with the
1.8.0 the assistant-ui kit pins.** One `@base-ui/react` in `node_modules` serves both.

**[M]** Every gap component the owner listed exists in the Base UI flavour, including two that avoid
new third-party deps entirely: `drawer` is `@base-ui/react/drawer` (**no `vaul`**) and `hover-card` is
`@base-ui/react/preview-card`. Across the 23 files the CLI actually wrote, the *only* non-Base-UI
runtime deps are `cn`, `class-variance-authority`, and an icon package.

**[M]** Only **3 of 23** files need an icon at all: `checkbox` (Check), `context-menu` (Check,
ChevronRight), `spinner` (Loader2). And the icon is not hard-coded — the registry ships
`<IconPlaceholder lucide="CheckIcon" tabler="…" hugeicons="…" phosphor="…" remixicon="…" />` and the
CLI rewrites it from `components.json`'s `iconLibrary`. Setting `"iconLibrary": "phosphor"` produced
`import { CheckIcon } from "@phosphor-icons/react"` — and `@phosphor-icons/react@^2.1.10` is already a
dependency of this repo. **Lucide can be avoided without touching a line of the generated source.**

**Bottom line [A]:** this is a better source for the gap set than the assistant-ui radix twin. It is
the same primitive library at the same version, the same `data-slot` convention, the same token
vocabulary, and it arrives through a real CLI with a real registry rather than a manual `curl` of a
`private: true` package. The costs are three: `shadcn init` must **never** be run in this repo (it
overwrites `src/lib/utils.ts` and rewrites the CSS file), `shadcn add` under-installs (it misses
`class-variance-authority` and the icon package), and shadcn's radius ladder is `calc()`-derived where
assistant-ui's is absolute, so `rounded-4xl` / `rounded-xl` are dead under our `@theme static` reset.

## Install recipe

### 1. `components.json` changes

Current file (repo root) vs. what the Base UI flavour needs:

```diff
 {
   "$schema": "https://ui.shadcn.com/schema.json",
-  "style": "new-york",
+  "style": "base-nova",
   "rsc": false,
   "tsx": true,
   "tailwind": {
     "config": "",
     "css": "src/components/assistant-ui/elements/elements.css",
     "baseColor": "neutral",
     "cssVariables": true
   },
+  "iconLibrary": "phosphor",
   "aliases": { … unchanged … },
   "registries": { "@assistant-ui": "https://r.assistant-ui.com/styles/{style}/{name}.json" }
 }
```

**[M]** `style` is the only switch. The docs say "This cannot be changed after initialization", but
that is advice to the user, not an enforcement — the CLI reads the field and serves from
`https://ui.shadcn.com/r/styles/<style>/<name>.json` with no memory of what was installed before.
Editing it by hand works; measured in experiment 2.

**[M]** `iconLibrary` accepts exactly `lucide | tabler | hugeicons | phosphor | remixicon` (read from
the CLI's `dist/chunk-CHWMSXYA.js`). When the field is **absent** the CLI defaults it to `"lucide"`
(the source is `t.iconLibrary || (t.iconLibrary = t.style === "new-york" ? "radix" : "lucide")`), so
omitting it does **not** mean "no icons" — it means lucide. `"radix"` is not in the icon map, so a
`new-york`-styled project with no `iconLibrary` leaves the raw `<IconPlaceholder>` tag in the file and
the build breaks.

**[M]** The rest of our config is honoured verbatim by `add`: `rsc: false` stripped the `"use client"`
directive; `tsx: true` gave `.tsx`; `aliases.ui` placed files in `src/components/ui/`; `aliases.ui` /
`aliases.components` rewrote cross-component imports (`field.tsx` got
`import { Separator } from "@/components/ui/separator"`). `tailwind.css` and `cssVariables` are
**ignored by `add`** — it wrote no CSS at all. Our `elements.css` was byte-identical afterwards.

### 2. The command

```sh
# once
npm i @base-ui/react@^1.8.0 class-variance-authority@^0.7.1 tw-animate-css@^1.4.0

# then, per component (add takes any number of names)
npx shadcn@latest add checkbox radio-group scroll-area slider progress toggle toggle-group \
  spinner alert-dialog context-menu hover-card card field button-group drawer
```

**Never run `npx shadcn init` in this repo.** **[M]** In experiment 3 (a scratch Vite project,
`shadcn init -b base -p nova`), init:

- **overwrote `src/lib/utils.ts` with a one-liner `export { cn } from "cn"`**, deleting the
  clsx + tailwind-merge implementation;
- rewrote the CSS file end to end — `@import "tw-animate-css"`, `@import "shadcn/tailwind.css"`,
  `@import "@fontsource-variable/geist"`, `@custom-variant dark (&:is(.dark *))`, a full `@theme
  inline` block and `:root` / `.dark` token sets;
- installed `@base-ui/react ^1.8.0`, `@fontsource-variable/geist ^5.3.0`,
  `class-variance-authority ^0.7.1`, `cn ^0.2.6`, `lucide-react ^1.44.0`, `shadcn ^4.21.0`,
  `tw-animate-css ^1.4.0`.

`add` does none of that. Use `add` only.

### 3. Post-`add` fixes (three, all mechanical)

**[M]** `shadcn add` installed only `cn@^0.2.6` and (because `drawer` declares it)
`@base-ui/react@^1.8.0`. It did **not** install `class-variance-authority`, even though 6 of the 23
files import it, nor the icon package. `tsc --noEmit` failed with 9 × TS2307 until both were installed
by hand; after that it was clean over all 23 files. This is because `cva`, `lucide-react` and
`tw-animate-css` are declared on the **style** item (`/r/styles/base-nova/index.json`), which only
`init` consumes — the per-component items don't repeat them.

**[M]** Every generated file imports `cn` from the npm package `"cn"`, not from `@/lib/utils`. The
CLI's import rewriter only touches specifiers starting with `@/`, so `"cn"` passes through untouched
and `cn@^0.2.6` gets installed as a real dependency. Two options:

- keep it (MIT, "drop-in replacement for clsx + tailwind-merge", ~one extra package), or
- `sed -i '' 's|from "cn"|from "@/lib/utils"|'` over the new files — our `src/lib/utils.ts` already
  exports a compatible `cn` and `@/*` → `./src/*` is mapped in `tsconfig.json`. **[M]** This is what
  the assistant-ui kit adoption already does, so it keeps one convention across `src/components/ui/`.

**[M]** `spinner.tsx` uses `React.ComponentProps<"svg">` without an `import * as React`. It
typechecks under our `@types/react` (UMD global), but it is a latent break under stricter `types`
config. Add the import.

### 4. Registry URL pattern

**[M]** `https://ui.shadcn.com/r/styles/{style}/{name}.json` — e.g.
`https://ui.shadcn.com/r/styles/base-nova/checkbox.json`. Verified 200 for all 55 names probed.
`/r/base/checkbox.json`, `/r/base-ui/checkbox.json`, `/r/checkbox.json`, `/r/registry.json` are all
**404**. `/r/index.json` (200) lists every component with per-base doc/api links.
`/r/styles/index.json` (200) still lists only `new-york` and `default` — it is stale and does **not**
enumerate the 24 new styles; the authoritative list is the `style` enum in
`https://ui.shadcn.com/schema.json`.

### 5. The checkbox registry JSON, verbatim

`GET https://ui.shadcn.com/r/styles/base-nova/checkbox.json` **[M]**:

```json
{
  "$schema": "https://ui.shadcn.com/schema/registry-item.json",
  "name": "checkbox",
  "dependencies": ["cn"],
  "files": [
    { "path": "registry/base-nova/ui/checkbox.tsx", "content": "…", "type": "registry:ui" }
  ],
  "meta": {
    "links": {
      "docs": "https://ui.shadcn.com/docs/components/base/checkbox",
      "examples": "https://ui.shadcn.com/code/apps/v4/registry/bases/base/examples/checkbox-example.tsx",
      "api": "https://base-ui.com/react/components/checkbox.md"
    }
  },
  "type": "registry:ui"
}
```

Note what is **not** there: `@base-ui/react` is absent from `dependencies`, so `shadcn add checkbox`
alone installs neither Base UI nor cva. The docs' manual tab says `npm install @base-ui/react`.

The `content` field, decoded, still holds the placeholder:

```tsx
"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { cn } from "cn"

import { IconPlaceholder } from "@/app/(create)/components/icon-placeholder"

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root data-slot="checkbox" className={cn("…", className)} {...props}>
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="…">
        <IconPlaceholder lucide="CheckIcon" tabler="IconCheck" hugeicons="Tick02Icon"
          phosphor="CheckIcon" remixicon="RiCheckLine" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
```

`@/app/(create)/components/icon-placeholder` does not exist in any consumer project. If you fetch the
registry JSON by hand instead of going through the CLI, that import is a broken path. **Go through
the CLI.**

### 6. What the CLI actually writes

**[M]** With `style: "base-nova"`, `iconLibrary: "phosphor"`, `rsc: false`, our aliases — exact bytes
of `src/components/ui/checkbox.tsx`:

```tsx
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { cn } from "cn"
import { CheckIcon } from "@phosphor-icons/react"

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input transition-colors outline-none group-has-disabled/field:opacity-50 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-has-[:focus-visible]/field-label:data-checked:border-primary dark:data-checked:bg-primary",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
      >
        <CheckIcon
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
```

With `iconLibrary` omitted or `"lucide"` the only difference is
`import { CheckIcon } from "lucide-react"`. The `<CheckIcon\n        />` line break is the CLI's
codemod output, not a typo.

## Component table

**[M]** From `https://ui.shadcn.com/r/styles/base-nova/<name>.json`, all fetched 2026-09-10. "Icons"
is the placeholder set in the registry source; the CLI resolves each to the configured library.
Transitive registry deps are pulled automatically.

| Component | Base UI flavour? | Primitive | npm deps in the item | registryDependencies | Icons needed |
| --- | --- | --- | --- | --- | --- |
| `checkbox` | yes | `@base-ui/react/checkbox` | `cn` | — | **Check** |
| `radio-group` | yes | `@base-ui/react/radio` + `/radio-group` | `cn` | — | none |
| `scroll-area` | yes | `@base-ui/react/scroll-area` | `cn` | — | none |
| `slider` | yes | `@base-ui/react/slider` | `cn` | — | none |
| `progress` | yes | `@base-ui/react/progress` | `cn` | — | none |
| `toggle` | yes | `@base-ui/react/toggle` | `cn`, cva | — | none |
| `toggle-group` | yes | `@base-ui/react/toggle-group` | `cn`, cva | `toggle` | none |
| `spinner` | yes | pure icon + `animate-spin` | `cn` | — | **Loader2** |
| `alert-dialog` | yes | `@base-ui/react/alert-dialog` | `cn` | `button` | none |
| `context-menu` | yes | `@base-ui/react/context-menu` | `cn` | — | **Check, ChevronRight** |
| `hover-card` | yes | `@base-ui/react/preview-card` | `cn` | — | none |
| `card` | yes | plain divs | `cn` | — | none |
| `field` | yes | plain elements + cva | `cn` | `label`, `separator` | none |
| `form` | **empty item** — valid JSON, zero files | — | — | — | — |
| `button-group` | yes | `useRender` + `mergeProps` + cva | `cn` | `separator` | none |
| `drawer` | yes | **`@base-ui/react/drawer`** — no `vaul` | `cn`, `@base-ui/react` | — | none |
| `separator` | yes | `@base-ui/react/separator` | `cn` | — | none |
| `avatar` | yes | `@base-ui/react/avatar` | `cn` | — | none |
| `skeleton` | yes | plain div | `cn` | — | none |
| `badge` | yes | `useRender` + `mergeProps` + cva | `cn`, cva | — | none |
| `tooltip` | yes | `@base-ui/react/tooltip` | `cn` | — | none |
| `kbd` | yes | native `<kbd>` | `cn` | — | none |

Pulled transitively by the above: `button` (`@base-ui/react/button`, cva, no icons), `label` (`cn`,
no icons), `separator`, `toggle`.

**Three files need an icon: `checkbox`, `context-menu`, `spinner`.** With
`"iconLibrary": "phosphor"` the generated imports were `CheckIcon` (checkbox), `CaretRightIcon` +
`CheckIcon` (context-menu), `SpinnerIcon` (spinner) — all from `@phosphor-icons/react`, already in our
`package.json`. **[A]** If we would rather vendor apps-sdk-ui SVGs, hand-edit those three imports; it
is a 4-symbol change, not a 14-icon sweep.

### Base UI flavour of things outside the gap list, for reference **[M]**

`accordion`, `alert`, `aspect-ratio`, `breadcrumb`, `calendar` (`react-day-picker@latest`,
`date-fns`), `carousel` (`embla-carousel-react`), `chart` (`recharts@3.8.0`), `collapsible`,
`combobox`, `command` (`cmdk`), `dialog`, `dropdown-menu`, `empty`, `input`, `input-group`,
`input-otp` (`input-otp`), `item`, `menubar`, `native-select`, `navigation-menu`, `pagination`,
`popover`, `resizable` (`react-resizable-panels`), `select`, `sheet`, `sonner` (`sonner`,
`next-themes`), `table`, `tabs`, `textarea` all resolve 200 for `base-nova`.

### Overlap with the assistant-ui base twin **[M]**

The assistant-ui base twin already ships `separator`, `avatar`, `skeleton`, `badge`, `tooltip`, `kbd`.
Re-verified today: all 15 gap components 404 under
`raw.githubusercontent.com/.../packages/ui/src/components/react/ui/base/<name>.tsx`. Taking those six
from shadcn as well would give one visual family but two copies of the same component; taking them
from assistant-ui keeps the kit coherent. **[A]** Not a technical question — pick one and be
consistent.

## Token and variant notes

### Tokens **[M]**

Grepped over all 23 generated files, the complete semantic colour set is:

`background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `primary`,
`primary-foreground`, `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`,
`accent-foreground`, `destructive`, `border`, `input`, `ring`.

**That is a strict subset of the assistant-ui kit's token set** (which also defines `sidebar-*`,
`chart-*`, `code-surface`). No extra colour token is required. Radius: only `--radius-md` is read
directly, via `rounded-[min(var(--radius-md),10px)]` and `…,12px)]` — the same idiom as the
assistant-ui button, and both projects resolve `--radius-md` to `0.5rem`.

Extras beyond the semantic set:

- `bg-white` / `bg-black` in `alert-dialog`, `drawer`, `slider`.
- `rounded-4xl` (`badge`), `rounded-xl` (`alert-dialog`, `card`). **[M]** shadcn derives its radius
  ladder — `--radius: 0.625rem` with `--radius-sm/md/lg/xl/2xl/3xl/4xl` as
  `calc(var(--radius) * 0.6 … 2.6)`. assistant-ui uses absolute semantic aliases and defines nothing
  above `--radius-3xl`. Our `src/index.css` defines only `sm`/`md`/`lg`/`composer`.
- Base UI's own drawer variables (`--drawer-height`, `--drawer-swipe-progress`, `--stack-*`, …) are
  supplied by the primitive, not by the theme.

### `data-slot` **[M]**

Same convention as the assistant-ui kit: 103 `data-slot="…"` attributes across the 23 files. Exactly
one file has none — `badge.tsx`. **[A]** Likely an upstream oversight.

### Dark mode **[M]**

`shadcn init` emits `@custom-variant dark (&:is(.dark *))` — byte-identical to the assistant-ui kit's
declaration. 13 distinct `dark:` utilities appear across the 23 gap files, including
`dark:bg-input/30`, `dark:data-checked:bg-primary`, `dark:aria-invalid:ring-destructive/40`,
`dark:has-data-checked:bg-primary/10`, `dark:after:mix-blend-lighten`. The landmine already recorded
in `assistant-ui-design.md` (§Landmine 2) applies unchanged: our `src/index.css` declares no `dark`
variant, so Tailwind v4's default makes `dark:` compile to `@media (prefers-color-scheme: dark)` and
these rules fire off the OS setting rather than our theme.

### `tw-animate-css` **[M]**

Declared as a **devDependency** on `/r/styles/base-nova/index.json`, alongside `shadcn` itself.
Measured with `@tailwindcss/cli@4.3.3` over the 23 generated files: without
`@import "tw-animate-css"`, `animate-in`, `animate-out`, `fade-in-0`, `fade-out-0`, `zoom-in-95`,
`zoom-out-95`, `slide-in-from-{top,bottom,left,right}-2` are all **not emitted**; with it, all are.
Same requirement, same package, same version range (`^1.4.0`) as the assistant-ui kit.

### `shadcn/tailwind.css` — a second CSS import you probably do not need **[M]**

The style item also declares `@import "shadcn/tailwind.css"`, shipped inside the `shadcn` npm package
at `dist/tailwind.css` (629 lines). It provides `@custom-variant` definitions for `data-open`,
`data-closed`, `data-checked`, `data-unchecked`, `data-selected`, `data-disabled`, `data-active`,
`data-horizontal`, `data-vertical`, plus `accordion-down`/`accordion-up` keyframes and the
`no-scrollbar`, `scroll-fade-*` and `shimmer` utilities.

Each of those `@custom-variant`s matches **both** Radix's `[data-state="…"]` and Base UI's
`[data-…]` — that is its whole purpose. Measured, with and without it:

| Utility | with `shadcn/tailwind.css` | without |
| --- | --- | --- |
| `data-checked:bg-primary` | `:where([data-state="checked"]), :where([data-checked]:not([data-checked="false"]))` | `[data-checked]` |
| `data-disabled:opacity-50` | `:where([data-disabled="true"]), :where([data-disabled]:not([data-disabled="false"]))` | `[data-disabled]` |

**[M]** Tailwind v4's native bare `data-*` variant already produces `[data-checked]`, which is exactly
what Base UI emits. **[A]** So for a Base-UI-only adoption the import is optional; none of the 23 gap
files uses `scroll-fade-*`, `no-scrollbar` or `animate-accordion-*`. Its `shimmer` utility overlaps
with the `tw-shimmer` package we already import in `elements.css` — importing both is a collision
risk not evaluated here.

## Checkbox API diff — Radix twin vs Base UI

Read from the installed `@base-ui/react@1.8.0` type declarations
(`checkbox/root/CheckboxRoot.d.ts`, `internals/types.d.ts`) **[M]**.

| Concern | Radix `new-york` checkbox | Base UI `base-nova` checkbox |
| --- | --- | --- |
| Import | `@radix-ui/react-checkbox` | `@base-ui/react/checkbox` |
| Props type | `React.ComponentPropsWithoutRef<typeof Root>` | `CheckboxPrimitive.Root.Props` |
| `onCheckedChange` | `(checked: boolean \| "indeterminate") => void` | `(checked: boolean, eventDetails: ChangeEventDetails) => void` |
| Indeterminate | third value of `checked` (`"indeterminate"`) | separate boolean prop `indeterminate` |
| Composition | `asChild` | **`render`** — `ReactElement` or `(props, state) => ReactElement` |
| `className` | `string` | `string \| ((state) => string \| undefined)` |
| Rendered element | `<button role="checkbox">` | `<span>` **plus a hidden `<input>` beside it** |
| State attributes | `data-state="checked\|unchecked\|indeterminate"` | `data-checked`, `data-unchecked`, `data-indeterminate`, `data-disabled`, `data-readonly`, `data-required`, and inside `Field.Root`: `data-valid`, `data-invalid`, `data-touched`, `data-dirty`, `data-filled`, `data-focused` |
| Extra props | — | `name`, `value`, `uncheckedValue`, `form`, `inputRef`, `parent`, `readOnly`, `nativeButton` |

### What this means for our call sites

**[M]** There are **12** `<Checkbox` call sites in `src/`, not 7:
`ArchiveSettings.tsx:32`, `Approvals.tsx:234`, `NotesLibrary.tsx:290`, `CommitPreferences.tsx:52,75,81`,
`SessionPreferences.tsx:75,94,113`, `DesktopSettings.tsx:210,240`, `DocumentTab.tsx:447`. All import
from `src/components/controls/checkbox.tsx`.

**[M]** The current control is a native `<input type="checkbox">` wrapped in a `<label>`, and its
signature is `ComponentProps<"input"> & { children?: ReactNode; onCheckedChange?: (checked: boolean) => void }`.

Two consequences:

1. **`onCheckedChange` is compatible as written.** Every call site is `onCheckedChange={(e) => …}`
   with `e` used as a boolean. Base UI passes the boolean first and the event details second, so the
   existing one-argument arrow functions keep working with no edit. Verified by a rendered click in
   experiment 4: the handler received `[true, "object"]`.
2. **`children` is the breaking change.** Our control renders `children` as the label text; shadcn's
   renders `children` inside the `<CheckboxPrimitive.Indicator>` slot (the tick). Every call site must
   move its label out. The shadcn docs' own shape:

   ```tsx
   <Field orientation="horizontal">
     <Checkbox id="co-author" checked={settings.coAuthor}
       onCheckedChange={(v) => save({ ...settings, coAuthor: v })} />
     <FieldLabel htmlFor="co-author">Include “Co-authored-by”</FieldLabel>
   </Field>
   ```

   `field` exports `Field`, `FieldLabel`, `FieldDescription`, `FieldError`, `FieldGroup`,
   `FieldLegend`, `FieldSeparator`, `FieldSet`, `FieldContent`, `FieldTitle` **[M]**. The generated
   checkbox's class string leans on Field: `group-has-disabled/field:opacity-50` and four
   `group-has-[:focus-visible]/field-label:` rules do nothing without a `Field` / `FieldLabel`
   ancestor.

**[A]** Cheapest migration that keeps the 12 call sites unchanged: keep
`src/components/controls/checkbox.tsx` as a thin wrapper that renders `<Field>` + shadcn `<Checkbox>`
+ `<FieldLabel>{children}</FieldLabel>` behind the current signature. Then no call site changes at
all, and the wrapper is the single place the `children`-as-label convention lives.

**[M]** Other props that no longer pass through: the Root is a `<span>`, so `onChange`,
`type="checkbox"`, and anything else typed against `<input>` is gone. `inputRef` reaches the hidden
input if a call site needs it.

## Vitest / jsdom

**No documented polyfills, and none needed. Measured.** **[M]**

Experiment 4: `vitest@4.1.11`, `jsdom@30.0.1`, `@testing-library/react@16.3.3`,
`@testing-library/user-event@14.6.7`, `react@19.1.0`, `@vitejs/plugin-react`, bare
`test: { environment: "jsdom" }` — **no setup file, no `ResizeObserver` / `PointerEvent` /
`scrollIntoView` / `matchMedia` shim.** Twelve tests over the generated files: checkbox renders,
clicks and reports `[true, object]` with `data-checked` set; radio-group, scroll-area, slider,
progress, toggle, spinner, card, separator, skeleton, badge, kbd render; alert-dialog opens on click;
hover-card opens on hover; context-menu opens on right-click; tooltip opens on hover; drawer opens on
click. **12 passed, 0 failed, 1.77 s.**

One jsdom-specific gotcha found **[M]**: the Base UI **Slider thumb renders with
`style="visibility: hidden"`** until it has measured layout, which jsdom never gives it. So
`getByRole("slider")` finds nothing — the element is out of the accessibility tree. `getByRole(
"slider", { hidden: true })` (or a `data-slot` query) works. Expect the same for any Base UI part that
positions itself before revealing.

**[M]** `tsc --noEmit` over all 23 generated files: clean, once `class-variance-authority` and the
icon package are installed.

**[A]** `globalThis.BASE_UI_ANIMATIONS_DISABLED = true` remains the documented escape hatch if an exit
animation ever makes a test flaky; it was not needed here.

## Landmines

1. **`shadcn init` destroys `src/lib/utils.ts`.** **[M]** It replaces the file with
   `export { cn } from "cn"` and rewrites the configured CSS file wholesale. Our `components.json`
   points `tailwind.css` at `src/components/assistant-ui/elements/elements.css`, so that is the file
   it would overwrite — and our actual theme lives in `src/index.css`, which init would not touch,
   leaving the project with two competing token sets. **Use `add` only. Edit `components.json` by
   hand.**

2. **shadcn does not pin Base UI.** **[M]** `drawer.json` and the style item both list a bare
   `"@base-ui/react"` with no version, so the CLI installs whatever npm `latest` is at the moment you
   run it. Today that is 1.8.0 and it happens to match assistant-ui's pin; tomorrow it will not. By
   contrast the registry *does* pin `recharts@3.8.0` and `react-day-picker@latest` explicitly. Install
   `@base-ui/react@^1.8.0` yourself **before** the first `add`, so npm has nothing to resolve.

3. **`add` under-installs.** **[M]** It installed only `cn` and `@base-ui/react`;
   `class-variance-authority` (6 files) and the icon package (3 files) were left missing and `tsc`
   failed with 9 × TS2307. Those live on the style item, which only `init` reads.

4. **Our `@theme static` reset deletes almost every colour these files use.** **[M]** Measured with
   `@tailwindcss/cli@4.3.3` against a replica of our `src/index.css` `@theme static` block
   (`--color-*: initial; --radius-*: initial; --shadow-*: initial`) scanning the 23 generated files:
   `bg-primary`, `text-primary-foreground`, `bg-popover`, `text-popover-foreground`, `bg-muted`,
   `text-muted-foreground`, `bg-accent`, `text-accent-foreground`, `border-input`, `ring-ring`,
   `bg-card`, `text-card-foreground`, `bg-destructive`, `bg-secondary`, `border-border`,
   `bg-background`, `text-foreground`, `bg-white`, `bg-black`, `shadow-md`, `shadow-lg`,
   `rounded-xl`, `rounded-4xl` are **all not emitted**. `rounded-sm`, `rounded-md`, `rounded-lg`,
   `rounded-full`, `size-4`, `p-2` are. No build error, no type error — the components render
   transparent and unpadded. This is the same landmine as `assistant-ui-design.md` §Landmine 1, and it
   is a hard prerequisite: the token bridge lands before the first component.

5. **Radius ladder mismatch.** **[M]** shadcn derives `--radius-sm…4xl` from a single
   `--radius: 0.625rem` via `calc()`; assistant-ui uses absolute semantic aliases from
   `--radius: 0.5rem`; we define four absolute values (`sm 4px`, `md 10px`, `lg 16px`,
   `composer 28px`) and nothing else. `rounded-xl` and `rounded-4xl` (badge, alert-dialog, card) have
   no definition at all under our reset, and `rounded-lg` resolves to our 16px where shadcn means
   ~10px.

6. **Base UI wants `.root { isolation: isolate }` around the app.** **[M]** Verbatim from
   `https://base-ui.com/react/overview/quick-start`: wrap children in `<div className="root">` with
   `.root { isolation: isolate; }` — *"This way, popups always appear above the page contents, and any
   `z-index` property in your styles won't interfere with them."* Applies to `alert-dialog`,
   `context-menu`, `hover-card`, `drawer`, `tooltip` here. The same page also asks for
   `body { position: relative; }` for iOS 26+ Safari backdrops, which a Tauri macOS build does not
   need **[A]**.

7. **`form` is an empty registry item.** **[M]** `/r/styles/base-nova/form.json` returns valid JSON
   with a name and a type and **no `files` array**. `shadcn add form` will write nothing and report
   nothing. Use `field` instead; it is the real component and the checkbox docs are written against it.

8. **The registry source references a path that does not exist in consumer projects.** **[M]** Every
   icon-bearing item carries `import { IconPlaceholder } from "@/app/(create)/components/icon-placeholder"`.
   The CLI's ts-morph codemod removes it. Hand-fetching the JSON and pasting the `content` field gives
   a file that cannot resolve. If a builder ever bypasses the CLI, they must strip that import and
   substitute the icon manually.

9. **`iconLibrary` absent means lucide, not "no icons".** **[M]** The CLI defaults it. With our
   current `style: "new-york"` it would default to `"radix"`, which is not a known icon library, and
   the `<IconPlaceholder>` tag would survive into the file. Set `iconLibrary` explicitly.

10. **Base UI emits `data-checked` / `data-open`, not `data-state`.** **[M]** Any existing test or CSS
    asserting `data-state` will not match. Also, a Base UI checkbox has no `role="checkbox"` on a
    `<button>` — it is a `<span>` with a hidden `<input>` beside it, so DOM assertions that reach for
    the input directly need rechecking.

11. **`HoverCard` takes `delay`, not `openDelay`.** **[M]** `openDelay` is a TS2322. Small, but it is
    the kind of Radix reflex that will bite a builder porting call sites.

12. **`shadcn/tailwind.css` ships a `shimmer` utility.** **[M]** We already import `tw-shimmer` in
    `elements.css`. If the shadcn CSS is imported for its `data-state` compat variants, the two
    `shimmer` definitions collide. Not evaluated here.

13. **`init` pulls a webfont.** **[M]** `@fontsource-variable/geist ^5.3.0` and
    `@import "@fontsource-variable/geist"`. Another reason not to run init — our `--font-sans` is a
    system stack.

14. **Licence: MIT, both.** **[M]** `shadcn@4.21.0`'s `LICENSE.md` is "MIT License, Copyright (c) 2023
    shadcn"; `@base-ui/react@1.8.0`'s `LICENSE` is "MIT License, Copyright (c) 2019 Material-UI SAS".
    No attribution obligation beyond keeping the notices.

## Not checked

- **The paint budget.** No burn run. Adding `@base-ui/react`, `class-variance-authority` and
  `tw-animate-css` to the render path has an unmeasured effect on the 287–295 ms p50 exec → FCP figure
  in `docs/STATUS.md` §4.
- **Bundle size of the gap set.** Not measured here; `assistant-ui-design.md` measured ~85 KB gzip for
  a 13-component Base UI slice, which is the closest proxy.
- **The other seven presets** (`base-vega`, `base-maia`, `base-lyra`, `base-mira`, `base-luma`,
  `base-sera`, `base-rhea`). All 200 for `checkbox.json`; I compared none of their sources or looks.
  `nova` is the CLI default and is what the docs render.
- **`menuColor` and `menuAccent`** (`default | inverted | default-translucent | inverted-translucent`,
  `subtle | bold`). Present in the schema and written by `init`. I did not test whether they change the
  generated menu/context-menu source.
- **`rtl: true`.** Present in the schema; not exercised. The generated files do contain
  `rtl:`-prefixed and logical-property rules.
- **Whether shadcn's Base UI components render correctly under our tokens.** I proved which utilities
  Tailwind emits and does not; I did not build a page with our token bridge and look at it.
- **Visual parity between shadcn `base-nova` and the assistant-ui kit.** Both use the same token
  names, but shadcn's neutral palette is `oklch(1 0 0)`-anchored and assistant-ui's is a `--tint: 106`
  sand family. Mixed on one screen they may not read as one system. Not evaluated.
- **Upgrade path.** `shadcn add --overwrite` re-fetches, but the registry is unversioned; there is no
  changelog per component and no way to diff against what you have except git.
- **`cn@0.2.6` behaviour vs our `clsx` + `tailwind-merge` `cn`.** Assumed equivalent from its own
  description; not diffed.
- **`@base-ui/react/drawer` maturity.** The subpath exists in 1.8.0 and the CHANGELOG shows active
  bugfixes; I did not check whether upstream marks it stable.
- **shadcn GitHub sources.** GitHub's code-search API needs auth and returned nothing unauthenticated.
  Everything above comes from the live registry, the docs `.md` endpoints, and the published npm
  tarball, which are closer to what the CLI actually does anyway.

## Sources

- `https://ui.shadcn.com/docs/components/base/checkbox.md`, `.../docs/cli.md`,
  `.../docs/components-json.md`, `.../docs/changelog/2026-01-base-ui.md`
- `https://ui.shadcn.com/schema.json` (the `style` enum), `https://ui.shadcn.com/r/index.json`,
  `https://ui.shadcn.com/r/styles/index.json` (stale), `https://ui.shadcn.com/r/colors/neutral.json`
- `https://ui.shadcn.com/r/styles/base-nova/<name>.json` — 55 names fetched; also `radix-nova` and
  `new-york` for comparison
- `npm pack shadcn@latest` → 4.21.0: `dist/chunk-CHWMSXYA.js` (icon-library map),
  `dist/chunk-G5AI2VJ6.js` (IconPlaceholder codemod), `dist/chunk-B2MD6U5O.js` (import rewriter,
  config defaults), `dist/tailwind.css`, `LICENSE.md`
- `https://base-ui.com/react/overview/quick-start.md`, `https://base-ui.com/react/components/checkbox.md`
- `https://registry.npmjs.org/@base-ui%2freact` (latest 1.8.0, MIT, 2026-09-04); installed
  `@base-ui/react@1.8.0` type declarations and `CHANGELOG.md`
- Experiments run here, all in `/tmp`:
  1. `shadcn@4.21.0 add checkbox` into a project mirroring our `components.json` with
     `style: "base-nova"` and no `iconLibrary` → lucide import, `cn` installed, CSS untouched.
  2. The same with `"iconLibrary": "phosphor"`, adding all 15 gap components → 23 files,
     `@base-ui/react@^1.8.0` installed, `cva` and the icon package missing, `tsc` clean after
     installing them.
  3. `shadcn@4.21.0 init -b base -p nova` in a scratch Vite project → the full generated CSS,
     `components.json`, dependency set, and the `src/lib/utils.ts` overwrite.
  4. `vitest@4.1.11` + `jsdom@30.0.1` + `@testing-library/react@16.3.3` over the 23 generated files,
     bare jsdom config, 12/12 pass.
  5. `@tailwindcss/cli@4.3.3` builds of the 23 files with and without `tw-animate-css` and
     `shadcn/tailwind.css`, and against a replica of our `@theme static` reset.
