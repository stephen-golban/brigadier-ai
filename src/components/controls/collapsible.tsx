import { Disclosure } from "./disclosure";
import {
  createContext,
  useContext,
  useState,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type ComponentProps,
} from "react";
const Expanded = createContext(false);
export function Collapsible({
  open,
  defaultOpen = false,
  onOpenChange,
  asChild: _asChild,
  children,
  ...props
}: ComponentProps<"div"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  asChild?: boolean;
}) {
  const [local, setLocal] = useState(defaultOpen);
  const expanded = open ?? local;
  return (
    <Expanded.Provider value={expanded}>
      <div {...props}>
        <Disclosure
          isExpanded={expanded}
          onExpandedChange={(value) => {
            setLocal(value);
            onOpenChange?.(value);
          }}
        >
          {children}
        </Disclosure>
      </div>
    </Expanded.Provider>
  );
}
export function CollapsibleTrigger({
  asChild,
  children,
  ...props
}: ComponentProps<typeof Disclosure.Trigger> & { asChild?: boolean }) {
  const child =
    asChild && isValidElement(children)
      ? (children as ReactElement<{ children?: ReactNode }>)
      : null;
  return (
    <Disclosure.Trigger {...(child?.props ?? {})} {...props}>
      {child ? child.props.children : children}
    </Disclosure.Trigger>
  );
}
export function CollapsibleContent({
  children,
  ...props
}: ComponentProps<typeof Disclosure.Content>) {
  const expanded = useContext(Expanded);
  return (
    <Disclosure.Content {...props}>
      {expanded ? children : null}
    </Disclosure.Content>
  );
}
