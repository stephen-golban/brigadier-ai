import {
  createContext,
  useContext,
  useId,
  useState,
  type ComponentProps,
} from "react";
import { ChevronDown } from "../../icons";
import { Button } from "./button";
const State = createContext({ open: false, toggle: () => {}, id: "" });
function Root({
  isExpanded,
  defaultExpanded = false,
  onExpandedChange,
  children,
  ...props
}: ComponentProps<"div"> & {
  isExpanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
}) {
  const [local, setLocal] = useState(defaultExpanded);
  const open = isExpanded ?? local;
  const id = useId();
  return (
    <State.Provider
      value={{
        open,
        id,
        toggle: () => {
          setLocal(!open);
          onExpandedChange?.(!open);
        },
      }}
    >
      <div {...props} className={`disclosure ${props.className ?? ""}`}>
        {children}
      </div>
    </State.Provider>
  );
}
function Trigger({ onClick, ...props }: ComponentProps<typeof Button>) {
  const state = useContext(State);
  return (
    <Button
      {...props}
      className={`disclosure__trigger ${props.className ?? ""}`}
      aria-expanded={state.open}
      aria-controls={state.id}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) state.toggle();
      }}
    />
  );
}
function Content(props: ComponentProps<"div">) {
  const { open, id } = useContext(State);
  return open ? (
    <div
      {...props}
      id={id}
      className={`disclosure__content ${props.className ?? ""}`}
    />
  ) : null;
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
