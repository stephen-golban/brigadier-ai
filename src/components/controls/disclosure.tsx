import type { ComponentProps } from "react";

import {
  Collapsible as KitCollapsible,
  CollapsibleContent as KitCollapsibleContent,
  CollapsibleTrigger as KitCollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown } from "@/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { labelledButtonIcons } from "@/lib/surfaces";

/**
 * Adapter over the kit's Base UI Collapsible, wearing the old `Disclosure` compound API.
 *
 * `ThreadView.tsx:459-470` is the only consumer and uses `Root / Heading / Trigger / Indicator /
 * Content / Body`. The hand-written `State` context, the `useId` + `aria-controls` pair and the
 * manual toggle are Base UI's now. `isExpanded` / `defaultExpanded` / `onExpandedChange` are still
 * accepted and map onto `open` / `defaultOpen` / `onOpenChange`.
 *
 * The trigger is the kit Button, composed through Base UI's `render`, with `labelledButtonIcons`
 * (`@/lib/surfaces`) keeping the ink and geometry that `ThreadView` renders bare unchanged.
 */
function Root({
  isExpanded,
  defaultExpanded,
  onExpandedChange,
  className,
  ...props
}: Omit<
  ComponentProps<typeof KitCollapsible>,
  "open" | "defaultOpen" | "onOpenChange"
> & {
  isExpanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
}) {
  return (
    <KitCollapsible
      {...props}
      open={isExpanded}
      defaultOpen={defaultExpanded}
      onOpenChange={(open) => onExpandedChange?.(open)}
      className={cn("disclosure", className)}
    />
  );
}

function Trigger({
  className,
  ...props
}: ComponentProps<typeof KitCollapsibleTrigger>) {
  return (
    <KitCollapsibleTrigger
      render={<Button variant="ghost" size="sm" className={labelledButtonIcons} />}
      {...props}
      className={cn("disclosure__trigger", className)}
    />
  );
}

function Content({
  className,
  ...props
}: ComponentProps<typeof KitCollapsibleContent>) {
  return (
    <KitCollapsibleContent
      {...props}
      className={cn("disclosure__content", className)}
    />
  );
}

function Heading(props: ComponentProps<"div">) {
  return <div {...props} />;
}

function Indicator() {
  return <ChevronDown aria-hidden className="size-4" />;
}

export const Disclosure = Object.assign(Root, {
  Trigger,
  Content,
  Heading,
  Body: Heading,
  Indicator,
});
