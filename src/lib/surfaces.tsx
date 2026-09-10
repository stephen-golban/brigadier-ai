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
