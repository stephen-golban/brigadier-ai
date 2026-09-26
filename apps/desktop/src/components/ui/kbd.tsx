import type * as React from "react";

import { cn } from "@/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "text-muted-foreground border-border/60 bg-muted/50 h-kbd min-w-kbd pointer-events-none inline-flex w-fit items-center justify-center rounded-xs border px-1 font-mono text-2xs select-none",
        "[&_svg:not([class*='size-'])]:size-icon-xs",
        // In a tooltip, ChatGPT's grey pill after the tip.
        "[[data-slot=tooltip-content]_&]:bg-foreground/20 [[data-slot=tooltip-content]_&]:text-popover-foreground [[data-slot=tooltip-content]_&]:border-transparent [[data-slot=tooltip-content]_&]:font-sans",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-0.5", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
