import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
} from "react";

import { Disclosure } from "./disclosure";

export function DetailsSummary({ children }: ComponentProps<"span">) {
  return <>{children}</>;
}

/**
 * `<details>`/`<summary>`-shaped sugar over `controls/disclosure.tsx`, which is now the kit's Base
 * UI Collapsible. Two consumers, `App.tsx:1076` and `Burn.tsx:90`; both pass only `className` and
 * an optional `open`. Unchanged in shape — only the primitive underneath moved.
 */
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
    <Disclosure {...props} defaultExpanded={open}>
      <Disclosure.Trigger aria-label={summary?.props["aria-label"]}>
        {summary?.props.children}
      </Disclosure.Trigger>
      <Disclosure.Content>
        {parts.filter((c) => c !== summary)}
      </Disclosure.Content>
    </Disclosure>
  );
}
