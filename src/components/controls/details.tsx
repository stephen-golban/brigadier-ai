import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
} from "react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./collapsible";
export function DetailsSummary({ children }: ComponentProps<"span">) {
  return <>{children}</>;
}
export function Details({
  children,
  open,
  ...props
}: ComponentProps<"div"> & { open?: boolean }) {
  const parts = Children.toArray(children);
  const summary = parts.find(
    (c) => isValidElement(c) && c.type === DetailsSummary,
  ) as ReactElement<ComponentProps<"span">> | undefined;
  return (
    <Collapsible {...props} defaultOpen={open}>
      <CollapsibleTrigger aria-label={summary?.props["aria-label"]}>
        {summary?.props.children}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {parts.filter((c) => c !== summary)}
      </CollapsibleContent>
    </Collapsible>
  );
}
