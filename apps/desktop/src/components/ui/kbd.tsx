import type * as React from "react";

import { cn } from "@/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "text-muted-foreground border-border/60 bg-muted/50 h-kbd min-w-kbd pointer-events-none inline-flex w-fit items-center justify-center rounded-xs border px-1 font-mono text-2xs select-none",
        "[&_svg:not([class*='size-'])]:size-icon-xs",
        "[[data-slot=tooltip-content]_&]:bg-background/10 [[data-slot=tooltip-content]_&]:text-background",
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
