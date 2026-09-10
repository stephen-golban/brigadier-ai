import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ComponentProps,
  type Ref,
} from "react";

import {
  Tabs as KitTabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * Adapter over the kit's Base UI Tabs (`src/components/ui/tabs.tsx`).
 *
 * The hand-written roving-tabindex, the `aria-controls`/`aria-labelledby` id wiring and the
 * `onFocus`/`Enter`/`Space` handlers are all Base UI's now; `<Tabs.List activateOnFocus>` keeps the
 * old behaviour of selecting a tab as soon as an arrow key lands on it.
 *
 * Two shapes are preserved because `ProjectWorkbench.tsx` needs them:
 *  - `Tab` renders a `<div role="tab">`, not a `<button>`. A workbench tab contains its own close
 *    button and a button inside a button is invalid; `render` + `nativeButton={false}` is Base UI's
 *    supported way to say so.
 *  - `ListContainer` is the scroll box that holds the list. It is not a kit part; the ref
 *    `ProjectWorkbench` puts on it is used to find and focus the selected tab after a close
 *    (`ProjectWorkbench.tsx:254`) — it does no scrolling. Keeping the selected tab in view is
 *    `Tab`'s own job, below.
 *
 * Gone: `Tabs.Indicator`, which returned `null` and was never rendered.
 */

/**
 * Base UI publishes the active state to `Tab` only through a `data-active` attribute, a
 * `className` callback or a `render` callback — none of which an effect can depend on. The
 * adapter's own Root already knows the selected key, so it hands it down directly.
 */
const SelectedTab = createContext<string | null>(null);

function Root({
  selectedKey,
  onSelectionChange,
  variant: _variant,
  className,
  ...props
}: Omit<ComponentProps<typeof KitTabs>, "value" | "onValueChange"> & {
  selectedKey: string;
  onSelectionChange: (key: string) => void;
  variant?: string;
}) {
  return (
    <SelectedTab.Provider value={selectedKey}>
      <KitTabs
        {...props}
        value={selectedKey}
        onValueChange={(value) => onSelectionChange(String(value))}
        // The kit spaces root children by `gap-2`; every consumer here lays itself out.
        className={cn("gap-0", className)}
      />
    </SelectedTab.Provider>
  );
}

function ListContainer({
  ref,
  className,
  ...props
}: ComponentProps<"div"> & { ref?: Ref<HTMLDivElement> }) {
  return (
    <div {...props} ref={ref} className={cn("overflow-x-auto", className)} />
  );
}

function List({ className, ...props }: ComponentProps<typeof TabsList>) {
  return (
    <TabsList
      activateOnFocus
      variant="line"
      {...props}
      className={cn("h-auto w-full justify-start p-0", className)}
    />
  );
}

function Tab({
  id,
  className,
  onFocus,
  ...props
}: Omit<ComponentProps<typeof TabsTrigger>, "value"> & { id: string }) {
  // `TabsTrigger` types its ref as the `<button>` it renders by default; here `render={<div />}`
  // makes it a div, so the effect below only needs `scrollIntoView`.
  const node = useRef<HTMLButtonElement>(null);
  const selected = useContext(SelectedTab) === id;
  useEffect(() => {
    // Restored from the pre-port hand-written Tab (af65dec:controls/tabs.tsx:52-59). Selection
    // moves by keyboard shortcut and by closing a neighbour, either of which can leave the new
    // tab off-screen inside `ListContainer`'s horizontal scroll box.
    if (selected)
      node.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected]);
  return (
    <TabsTrigger
      value={id}
      render={<div />}
      nativeButton={false}
      {...props}
      // After the spread on purpose: the effect above is the whole point of the ref, and no
      // call site passes one of its own.
      ref={node}
      onFocus={(event) => {
        onFocus?.(event);
        // `activateOnFocus` fires on `focusin`, which bubbles: focusing a tab's own close button
        // would otherwise select that tab. The hand-written Tab guarded the same way
        // (`event.target === event.currentTarget`); `preventBaseUIHandler` is Base UI's opt-out.
        if (event.target !== event.currentTarget) event.preventBaseUIHandler?.();
      }}
      className={cn(
        "h-8 flex-none cursor-default gap-2 px-3 text-[13px] font-normal hover:bg-hover data-active:bg-selected",
        className,
      )}
    />
  );
}

function Panel({
  id,
  ...props
}: Omit<ComponentProps<typeof TabsContent>, "value"> & { id: string }) {
  return <TabsContent keepMounted value={id} {...props} />;
}

export const Tabs = Object.assign(Root, { ListContainer, List, Tab, Panel });
