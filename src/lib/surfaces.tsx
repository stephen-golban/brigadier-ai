"use client";

import type { ComponentProps } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export const paper = "bg-elevated border border-hairline/60";

export const floating = "bg-elevated border border-hairline/60";

export const field = "bg-text/[0.06]";

export const fieldInteractive =
  "bg-text/[0.06] transition-colors hover:bg-text/[0.09]";

// `ghostButton` and `inkButton` retired 2026-09-10: the kit Button's `ghost` and `default`
// variants at `size="icon-sm"` are the same two affordances. Import `@/components/ui/button`
// instead of reviving them — upstream `elements-surfaces` still ships both.

/* -------------------------------------------------------------------------------------------
   Button recipes. Everything brigadier-specific that `src/components/controls/button.tsx` used
   to add on top of the kit Button (`src/components/ui/button.tsx`) lives here, so the adapter
   was deleted 2026-09-11 and every call site imports the kit Button directly. The codemod recipe is
   `docs/plans/button-codemod-2026-09-11.md`; the class strings are byte-identical to the ones
   the adapter emitted, and they are always passed to `cn()` BEFORE a call site's own
   `className`, exactly as the adapter did, so a site's override still wins through
   tailwind-merge.
   ------------------------------------------------------------------------------------------- */

/**
 * The ink model for an icon-only button: secondary at rest, brightening on hover, with the glyph
 * inheriting the box's colour rather than the `labelledButtonIcons` default. The adapter applied
 * `text-text-secondary hover:text-text` to every icon-only button EXCEPT `variant="danger"`
 * (now `variant="destructive"`), whose own `text-destructive` would have been merged away. No
 * call site is a destructive icon button today; if one appears, compose the box recipe with
 * `cn(iconButton, "text-destructive hover:text-destructive")` rather than editing this.
 */
export const iconButtonInk =
  "text-text-secondary hover:text-text [&_svg]:text-current";

/**
 * Geometry only, no ink and no marker class: a 24px box with 4px padding and a 16px glyph. The
 * kit's `size="icon"` is a 32px box (`size-8`), so this is what puts it back.
 *
 * The corner is `--radius-icon-button` (`src/index.css`), the semantic layer's name for this
 * box: 8px until 2026-09-11, now `--radius-sm` (6px), the nearest step on the monotonic scale.
 *
 * This string is byte-identical to the adapter's old `STANDARD_ICON_BUTTON`. It exists separately
 * from `iconButton` for the one call site that only ever wanted the geometry:
 * `src/components/assistant-ui/elements/tooltip-icon-button.tsx`, which imported
 * `STANDARD_ICON_BUTTON` before the codemod and must not gain `iconButtonInk` (it would repaint
 * the markdown code-block Copy button) or the `icon-button` marker (it would pull the button into
 * the `.icon-button[data-slot="button"]` reduced-motion rule in `src/index.css:1054`).
 */
export const iconButtonBox =
  "size-6 min-w-6 p-1 rounded-[var(--radius-icon-button)] [&_svg:not([class*='size-'])]:size-4";

/**
 * brigadier's standard icon button: `iconButtonBox` plus the marker class plus `iconButtonInk`.
 * `size="icon"` plus this recipe is the adapter's old `size="icon"` / `isIconOnly`.
 *
 * The leading `icon-button` class is the DOM marker the CSS keys on. It replaces the adapter's
 * `data-icon-button="standard"`: `src/index.css` sizes the workbench-tab close button down to
 * 16px through it, and kills its transition under `prefers-reduced-motion`.
 */
export const iconButton = "icon-button " + iconButtonBox + " " + iconButtonInk;

/**
 * `size="icon-xs"` plus this. The kit's `icon-xs` box pins its corner with
 * `rounded-[min(var(--radius-md),10px)]` (`src/components/ui/button.tsx:30`) — a clamp that caps
 * at 10px. It is overridden here so the box moves with the semantic layer rather than with the
 * clamp, and so `src/components/ui/` stays a verbatim upstream copy
 * (`src/components/ui/UPSTREAM.md`). `cn`'s tailwind-merge resolves the two `rounded-` classes
 * in favour of this one. The box itself is already 24px upstream, so no `size-*` is repeated.
 */
export const iconButtonXs =
  "icon-button rounded-[var(--radius-icon-button-xs)] " + iconButtonInk;

/**
 * The secondary icon ink the adapter gave every LABELLED button — a text button whose row also
 * carries an svg. Icon-only buttons take `iconButtonInk` instead (the adapter's `text-current`
 * won the merge there).
 */
export const labelledButtonIcons = "[&_svg]:text-text-secondary";

/**
 * The pressed fill. The adapter put this on every icon-only button, where it is inert without an
 * `aria-pressed` attribute; add it to any icon button that toggles. Labelled toggles never had
 * it and must not gain it. Call sites that need it today: `src/components/ProjectWorkbench.tsx`
 * (the Files/Search/Changes strip, Subagents, Terminal).
 */
export const toggleButton = "aria-pressed:bg-selected aria-pressed:text-text";

export const pressable =
  "transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.96] motion-reduce:transition-none";

export const iconSwap =
  "[grid-area:1/1] transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";

export const iconSwapIn = "scale-100 opacity-100 blur-none";

export const iconSwapOut = "scale-[0.25] opacity-0 blur-[4px]";

export const labelSwap =
  "col-start-1 row-start-1 flex w-max items-center gap-1.5 leading-none transition-[opacity,filter] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none";

export const labelSwapIn = "opacity-100 blur-none";

export const labelSwapOut =
  "pointer-events-none select-none opacity-0 blur-[2px]";

// Base UI's Collapsible.Panel emits `data-open` / `data-closed` (and `--collapsible-panel-height`),
// never Radix's `data-state`. The two `@custom-variant` lines at the top of `src/index.css` accept
// either spelling; the keyframes in `elements/elements.css` read Base UI's variable.
export const collapsePanel =
  "overflow-hidden data-open:animate-[elements-expand_200ms_ease-out] data-closed:animate-[elements-collapse_200ms_ease-out] motion-reduce:animate-none";

export const live = "text-attention";

export const mono = "font-mono text-[11px] tracking-tight";

export function ShimmerLabel({
  active = true,
  className,
  ...props
}: ComponentProps<"span"> & { active?: boolean }) {
  return (
    <span
      className={cn(active && "shimmer motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

/**
 * Scroll region for content that keeps its own whitespace. `whitespace-pre` in
 * a bounded box clips a long line with no way to reach it, so the rows scroll
 * instead.
 *
 * `codeSurface` wraps all the rows as one block, and the rows are its children.
 * It cannot go on each row: `min-width: 100%` resolves against the scroll
 * container's visible width rather than its scroll width, so a per-row width
 * leaves every row except the longest ending its canvas at the fold.
 */
export const codeScroll = "overflow-x-auto";

export const codeSurface = "w-max min-w-full";

export function SwapLabel({
  active,
  children,
  className,
}: {
  active: 0 | 1;
  children: [React.ReactNode, React.ReactNode];
  className?: string;
}) {
  const layers = [useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null)];
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const target = layers[active]?.current;
    if (!target) return undefined;
    const measure = () =>
      setWidth(Math.ceil(target.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [active]);

  return (
    <span
      style={width === null ? undefined : { width }}
      className={cn(
        "grid overflow-x-clip transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        className,
      )}
    >
      {children.map((layer, index) => (
        <span
          key={index}
          ref={layers[index]}
          aria-hidden={active !== index}
          className={cn(
            labelSwap,
            active === index ? labelSwapIn : labelSwapOut,
          )}
        >
          {layer}
        </span>
      ))}
    </span>
  );
}
