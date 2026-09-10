// Installed from assistant-ui Elements (MIT); Brigadier theme and integration extensions.
"use client";

import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { STANDARD_ICON_BUTTON } from "@/components/controls/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * No native `title`: the Base UI tooltip already renders the hint, and upstream's
 * `tooltip-icon-button` carries none. `aria-label` keeps the accessible name, which is what
 * every test queries by. `MessageAction` below is the one place a `title` survives, because
 * it wraps a caller-supplied button that has no popup of its own.
 *
 * This one reaches for the kit's Button rather than `controls/button`, so the kit's 32px
 * `icon` box is corrected here with the same `STANDARD_ICON_BUTTON` recipe the adapter
 * applies — an explicit `size-6` class rather than `size="icon-xs"`, because `icon-xs` is a
 * 24px box around a **12px** glyph and this button's glyph was 16px before the port.
 */
export function TooltipIconButton({
  tooltip,
  children,
  className,
  ...props
}: ComponentProps<typeof Button> & { tooltip: ReactNode }) {
  const label = typeof tooltip === "string" ? tooltip : undefined;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            {...props}
            className={cn(STANDARD_ICON_BUTTON, className)}
            aria-label={label ?? props["aria-label"]}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent showArrow={false}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A hint on something that is not itself the button: the caller supplies its own button,
 * already carrying the same `title`. Left as a label carrier rather than a second popup.
 */
export function MessageAction({
  tooltip,
  children,
}: {
  tooltip: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className="inline-flex"
      title={typeof tooltip === "string" ? tooltip : undefined}
    >
      {children}
    </span>
  );
}
