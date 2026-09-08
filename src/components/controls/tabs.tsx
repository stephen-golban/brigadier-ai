import {
  createContext,
  useContext,
  useId,
  useEffect,
  useRef,
  type ComponentProps,
} from "react";
import { navigateItems } from "./overlay";
const State = createContext({
  selected: "",
  select: (_key: string) => {},
  id: "",
});
function Root({
  selectedKey,
  onSelectionChange,
  variant: _variant,
  children,
  ...props
}: ComponentProps<"div"> & {
  selectedKey: string;
  onSelectionChange: (key: string) => void;
  variant?: string;
}) {
  const id = useId();
  return (
    <State.Provider
      value={{ selected: selectedKey, select: onSelectionChange, id }}
    >
      <div {...props}>{children}</div>
    </State.Provider>
  );
}
function ListContainer(props: ComponentProps<"div">) {
  return (
    <div {...props} className={`overflow-x-auto ${props.className ?? ""}`} />
  );
}
function List(props: ComponentProps<"div">) {
  return (
    <div
      {...props}
      role="tablist"
      className={`tabs__list flex items-center ${props.className ?? ""}`}
      onKeyDown={navigateItems}
    />
  );
}
function Tab({
  id,
  children,
  ...props
}: ComponentProps<"div"> & { id: string }) {
  const state = useContext(State);
  const selected = state.selected === id;
  const tabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected)
      tabRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected]);
  // A tab can contain a separate close button; use a focusable tab container, not nested buttons.
  return (
    <div
      {...props}
      ref={tabRef}
      id={`${state.id}-tab-${id}`}
      role="tab"
      aria-selected={selected}
      aria-controls={`${state.id}-panel-${id}`}
      tabIndex={selected ? 0 : -1}
      className={`tabs__tab flex h-8 cursor-default items-center gap-2 rounded-md px-3 text-[13px] hover:bg-hover ${selected ? "bg-selected" : ""} ${props.className ?? ""}`}
      onClick={() => state.select(id)}
      onFocus={(event) => {
        if (event.target === event.currentTarget) state.select(id);
      }}
      onKeyDown={(event) => {
        if (
          event.target === event.currentTarget &&
          [" ", "Enter"].includes(event.key)
        ) {
          event.preventDefault();
          state.select(id);
        }
      }}
    >
      {children}
    </div>
  );
}
function Panel({ id, ...props }: ComponentProps<"div"> & { id: string }) {
  const state = useContext(State);
  return (
    <div
      {...props}
      role="tabpanel"
      id={`${state.id}-panel-${id}`}
      aria-labelledby={`${state.id}-tab-${id}`}
      hidden={state.selected !== id}
    />
  );
}
function Indicator() {
  return null;
}
export const Tabs = Object.assign(Root, {
  ListContainer,
  List,
  Tab,
  Panel,
  Indicator,
});
