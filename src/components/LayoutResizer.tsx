import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { cn } from "../lib/utils";

/** The keys that move a resizer, and the sign each one carries along its axis. */
const NUDGE: Record<string, number> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
};

export type LayoutResizerProps = {
  /** `"vertical"` is a column splitter (drags along x); `"horizontal"` drags along y. */
  orientation: "vertical" | "horizontal";
  /** Current size, in the caller's own units. Reported as `aria-valuenow`. */
  value: number;
  min: number;
  max: number;
  /**
   * Called with the raw candidate size. Deliberately unclamped: the caller owns the clamp,
   * because "below the minimum" is a meaningful gesture for some panels (the sidebar
   * collapses there) and a plain clamp for others.
   */
  onChange: (next: number) => void;
  /** Accessible name, e.g. "Resize sidebar". */
  label: string;
  /** Arrow-key increment, in the caller's units. */
  step?: number;
  /** Thickness of the invisible grab strip, in px. The visible line is always 1px. */
  hitSize?: number;
  /** `true` when the panel grows against the drag direction (leftward, or upward). */
  invert?: boolean;
  /**
   * Caller units per pixel of pointer travel. A function is read once per drag, for
   * resizers whose scale depends on a measured layout.
   */
  perPixel?: number | (() => number);
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  /** Positioning is the caller's: this component owns thickness, keys and pointer capture. */
  className?: string;
  tabIndex?: number;
  style?: CSSProperties;
};

/**
 * The one splitter. Pointer capture with the drag origin parked in `dataset` (so a drag
 * survives re-renders without a ref), arrow-key nudges, and the `role="separator"` a11y
 * contract shared by the sidebar, the workspace panel and the terminal dock.
 */
export function LayoutResizer({
  orientation,
  value,
  min,
  max,
  onChange,
  label,
  step = 24,
  hitSize = 16,
  invert = false,
  perPixel = 1,
  onResizeStart,
  onResizeEnd,
  className,
  tabIndex = 0,
  style,
}: LayoutResizerProps) {
  const vertical = orientation === "vertical";
  const sign = invert ? -1 : 1;
  const coordinate = (event: { clientX: number; clientY: number }) =>
    vertical ? event.clientX : event.clientY;
  const release = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={tabIndex}
      data-orientation={orientation}
      className={cn(
        "layout-resizer z-10 touch-none",
        vertical ? "cursor-col-resize" : "cursor-row-resize",
        className,
      )}
      style={{ ...(vertical ? { width: hitSize } : { height: hitSize }), ...style }}
      onKeyDown={(event) => {
        const direction = NUDGE[event.key];
        if (!direction) return;
        if (vertical !== (event.key === "ArrowLeft" || event.key === "ArrowRight"))
          return;
        event.preventDefault();
        onChange(value + sign * direction * step);
      }}
      onPointerDown={(event) => {
        onResizeStart?.();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.origin = String(coordinate(event));
        event.currentTarget.dataset.value = String(value);
        event.currentTarget.dataset.scale = String(
          typeof perPixel === "function" ? perPixel() : perPixel,
        );
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const { origin, value: start, scale } = event.currentTarget.dataset;
        onChange(
          Number(start) +
            sign * (coordinate(event) - Number(origin)) * Number(scale),
        );
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={() => onResizeEnd?.()}
    />
  );
}
