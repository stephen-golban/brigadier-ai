import { forwardRef, type ComponentProps } from "react";

import { Input as KitInput } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Thin adapter over the design kit's Input (`src/components/ui/input.tsx`, Base UI `Input`),
 * shaped like `controls/button.tsx`: the 16 files that import from here compile unchanged.
 *
 * What the adapter still owns:
 *  - the `input` class, which `src/index.css:686-687` keys off for the rename dialog's field.
 *  - `data-autofocus`, the marker `controls/modal.tsx` and `controls/overlay.tsx` use to find the
 *    element to focus when a surface opens.
 *  - `bg-input`, brigadier's solid field fill. The kit paints `bg-muted/60`, which is
 *    `rgba(255,255,255,0.05)` here — nearly invisible on `--background`. `cn` merges the kit's
 *    value away, so this is a one-class override, not a fork.
 */
export const Input = forwardRef<HTMLInputElement, ComponentProps<"input">>(
  function Input({ className, ...props }, ref) {
    return (
      <KitInput
        {...props}
        data-autofocus={props.autoFocus || undefined}
        ref={ref}
        className={cn("input bg-input focus-visible:bg-input", className)}
      />
    );
  },
);
