import { type ComponentPropsWithRef, forwardRef } from "react";
import { Slot } from "radix-ui";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

export type TooltipIconButtonProps = ComponentPropsWithRef<typeof Button> & {
  tooltip: string;
  /** The button's keyboard shortcut, as a pill after the tip (ChatGPT's "Dictate ⌃⇧D"). */
  shortcut?: string | undefined;
  side?: "top" | "bottom" | "left" | "right";
};

export const TooltipIconButton = forwardRef<
  HTMLButtonElement,
  TooltipIconButtonProps
>(
  (
    { children, tooltip, shortcut, side = "bottom", size = "icon-sm", className, ...rest },
    ref,
  ) => {
    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size={size}
              {...rest}
              className={cn("aui-button-icon active:scale-90", className)}
              ref={ref}
            >
              <Slot.Slottable>{children}</Slot.Slottable>
              <span className="aui-sr-only sr-only">{tooltip}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side={side}>
            {tooltip}
            {shortcut && <Kbd>{shortcut}</Kbd>}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  },
);

TooltipIconButton.displayName = "TooltipIconButton";
