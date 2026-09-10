import type { ComponentProps } from "react";

import { Spinner as KitSpinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * Adapter over the shadcn `spinner` (`src/components/ui/spinner.tsx`).
 *
 * This used to render a literal `…`. The kit's spinner is `animate-spin` on a loader glyph, and
 * upstream's glyph is lucide's `Loader2Icon`. This repo has no lucide and the vendored
 * `@openai/apps-sdk-ui` set has no circular loader, so `ui/spinner.tsx` draws the 3/4 ring itself
 * as one inline `<path>` — lucide's `loader-circle` geometry, no dependency.
 *
 * `role="status"` and the default `aria-label="Working"` are kept: 5 files render this and
 * `SessionStatus.test.tsx` and friends query it by role. The `size` prop stays accepted and
 * ignored, as before.
 */
export function Spinner({
  size: _size,
  className,
  ...props
}: ComponentProps<"svg"> & { size?: string }) {
  return (
    <KitSpinner
      {...props}
      aria-label={props["aria-label"] ?? "Working"}
      className={cn("text-warn", className)}
    />
  );
}

/** Not a kit component: a plain elevated slab. `variant` was never read. */
export function Surface({
  variant: _variant,
  ...props
}: ComponentProps<"div"> & { variant?: string }) {
  return (
    <div
      {...props}
      className={cn("surface bg-elevated rounded-md", props.className)}
    />
  );
}
