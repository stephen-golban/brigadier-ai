import type { ComponentProps } from "react";
import { Kbd as KitKbd, KbdGroup as KitKbdGroup } from "@/components/ui/kbd";
import { cn } from "../../lib/utils";

/**
 * Thin adapter over the design kit's `Kbd` (`src/components/ui/kbd.tsx`). The kit's own geometry
 * — a 16px bordered chip in `--muted-foreground` — replaces the hand-written one; what stays is
 * brigadier's filled treatment (`bg-selected`, no border) and its 13px sans face, because menu
 * rows and the tooltip both size their shortcut chips against the surrounding text.
 */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <KitKbd
      {...props}
      className={cn(
        "h-5 min-w-5 gap-1 rounded-sm border-0 bg-selected px-1 font-sans text-[13px] font-normal text-text-secondary",
        className,
      )}
    />
  );
}
export function KbdGroup({ className, ...props }: ComponentProps<"div">) {
  return <KitKbdGroup {...props} className={cn("gap-1", className)} />;
}
