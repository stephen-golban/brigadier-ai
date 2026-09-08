import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Button } from "./button";
import { navigateItems } from "./overlay";
const State = createContext<{
  value?: string;
  onChange?: (value: string) => void;
  disabledKeys: string[];
}>({ disabledKeys: [] });
function Root({
  children,
  value,
  onValueChange,
  disabledKeys = [],
  renderEmptyState,
  ...props
}: ComponentProps<"div"> & {
  value?: string;
  onValueChange?: (value: string) => void;
  disabledKeys?: string[];
  renderEmptyState?: () => ReactNode;
}) {
  return (
    <State.Provider value={{ value, onChange: onValueChange, disabledKeys }}>
      <div {...props} role="listbox" onKeyDown={navigateItems}>
        {Array.isArray(children) && !children.length
          ? renderEmptyState?.()
          : children}
      </div>
    </State.Provider>
  );
}
function Item({
  id,
  textValue,
  onAction,
  ...props
}: ComponentProps<typeof Button> & {
  id: string;
  textValue?: string;
  onAction?: () => void;
}) {
  const state = useContext(State);
  return (
    <Button
      {...props}
      role="option"
      aria-selected={state.value === id}
      disabled={state.disabledKeys.includes(id) || props.disabled}
      data-text-value={textValue}
      className={`flex h-auto min-h-8 w-full flex-wrap justify-start text-left ${state.value === id ? "bg-selected" : ""} ${props.className ?? ""}`}
      onClick={() => {
        state.onChange?.(id);
        onAction?.();
      }}
    />
  );
}
function Section(props: ComponentProps<"div">) {
  return <div {...props} role="group" />;
}
export const ListBox = Object.assign(Root, { Item, Section });
