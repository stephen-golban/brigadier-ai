import type { ComponentProps } from "react";

import {
  Collapsible as KitCollapsible,
  CollapsibleContent as KitCollapsibleContent,
  CollapsibleTrigger as KitCollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * Adapter over the kit's Base UI Collapsible (`src/components/ui/collapsible.tsx`).
 *
 * It used to be a second skin on `controls/disclosure.tsx`, which was itself a hand-written
 * open/closed context. Both are Base UI now, so the `Expanded` context, the manual
 * `{expanded ? children : null}` gate and the `aria-controls` id plumbing are gone.
 *
 * What a consumer can no longer do: pass `asChild`. It was accepted and ignored here and no call
 * site passed it. Base UI's composition prop is `render`, which the kit's parts forward.
 *
 * Behaviour that call sites depend on and that survives: the trigger carries `aria-expanded`, which
 * `SourceControl.tsx:582` and `ChangesFileList.tsx:142` use for their caret rotation
 * (`group-aria-expanded/section:rotate-90`).
 */
export function Collapsible(props: ComponentProps<typeof KitCollapsible>) {
  return <KitCollapsible {...props} />;
}

export function CollapsibleTrigger(
  props: ComponentProps<typeof KitCollapsibleTrigger>,
) {
  return <KitCollapsibleTrigger {...props} />;
}

export function CollapsibleContent(
  props: ComponentProps<typeof KitCollapsibleContent>,
) {
  return <KitCollapsibleContent {...props} />;
}
