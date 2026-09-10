import { forwardRef, type ComponentProps } from "react";

import { Textarea as KitTextarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Thin adapter over the design kit's Textarea (`src/components/ui/textarea.tsx`).
 * `bg-input` and the `data-autofocus` marker are held for the same reasons as in `input.tsx`.
 * `min-h-16` is dropped: both call sites size the box themselves and the composer's inner
 * textarea must be free to collapse to one line.
 */
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  ComponentProps<"textarea">
>(function Textarea({ className, ...props }, ref) {
  return (
    <KitTextarea
      {...props}
      data-autofocus={props.autoFocus || undefined}
      ref={ref}
      className={cn(
        "textarea min-h-0 bg-input focus-visible:bg-input",
        className,
      )}
    />
  );
});
