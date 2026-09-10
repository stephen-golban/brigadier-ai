/**
 * Menus and popovers, as thin adapters over the assistant-ui design kit
 * (`src/components/ui/dropdown-menu.tsx`, `src/components/ui/popover.tsx`) and therefore over
 * Base UI's `Menu` and `Popover`. Keyboard navigation, typeahead, focus return, outside-press
 * dismissal and collision-aware positioning are all Base UI's now; the hand-rolled versions of
 * all four are gone.
 *
 * Two things this file still owns, and neither may be refactored away:
 *
 *  1. `nativeEntries()` — the Tauri native-menu bridge. It walks the DECLARATIVE JSX children of
 *     `<Dropdown native>` and compares `node.type` against `Item`, `DropdownRoot` and
 *     `Separator`. Those three component identities, and the `textValue` / `nativeIcon` /
 *     `accelerator` / `checked` / `isDisabled` / `onAction` prop names it reads, are load-bearing
 *     for `src/components/Sidebar.tsx`, `SessionMenu.tsx` and `TerminalDock.tsx` (two menus).
 *     See `native-menu.test.tsx`.
 *  2. Both roots stay controlled (`open` + `onOpenChange`), because `native` has to answer "the
 *     menu was asked to open" with a macOS menu instead of a popup, and because `isOpen` is a
 *     public prop on five call sites. Base UI owns the mounting: a closed popup leaves the DOM
 *     once its exit transition finishes, which under jsdom needs
 *     `globalThis.BASE_UI_ANIMATIONS_DISABLED = true` (set in `src/test/setup.ts`).
 */
import {
  nativeMenusAvailable,
  showNativeMenu,
  type NativeMenuEntry,
} from "./native-menu";
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type OverlayState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  closeAll: () => void;
  /** Opens or closes on `mousedown` without Base UI's animation-frame delay. */
  press: (event: { button: number; preventBaseUIHandler?: () => void }) => void;
  kind: "menu" | "dialog";
  /** Set on a submenu, so `Dropdown.Popover` can default to opening sideways. */
  nested: boolean;
  /** The rendered trigger element, so `Content` can find the surface it belongs to. */
  trigger: RefObject<HTMLButtonElement | null>;
};
const State = createContext<OverlayState | null>(null);
/** Kept for consumers that need to know whether they render inside an overlay. */
export function useOverlay() {
  return useContext(State);
}
/** True for the one child that `Dropdown.SubmenuTrigger` treats as its trigger. */
const SubmenuSlot = createContext(false);

type RootProps = {
  children: ReactNode;
  native?: boolean;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function OverlayRoot({
  children,
  isOpen,
  onOpenChange,
  native = false,
  kind,
}: RootProps & { kind: OverlayState["kind"] }) {
  const parent = useContext(State);
  const nested = kind === "menu" && parent?.kind === "menu";
  const [local, setLocal] = useState(false);
  const [nativeOpen, setNativeOpen] = useState(false);
  const nativePending = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const open = isOpen ?? local;
  const setOpen = (next: boolean) => {
    setLocal(next);
    onOpenChange?.(next);
  };
  const parts = Children.toArray(children);
  const [triggerNode, ...rest] = parts;

  /** Show macOS's own menu when the items are declarative enough to describe one. */
  const activate = async (entries: NativeMenuEntry[], element: HTMLElement) => {
    nativePending.current = true;
    setNativeOpen(true);
    try {
      if (!(await showNativeMenu(entries, element))) setOpen(true);
    } finally {
      nativePending.current = false;
      setNativeOpen(false);
      if (element.isConnected && document.activeElement === document.body)
        element.focus();
    }
  };
  /**
   * Menus only. Base UI opens a menu from `mousedown`, but only on the next animation frame (floating-ui's
   * `useClick` defers `setOpen` through `requestAnimationFrame` so focus lands before the popup
   * paints). Every call site in this app — and a dozen tests — expects the menu to exist as soon
   * as the press is handled, so the internal handler is prevented and the same toggle is done
   * synchronously here. Base UI's own `click` handler then no-ops, because its `pointerType` was
   * recorded on `pointerdown`. `Popover` needs none of this: its trigger opens from `click`,
   * which is synchronous.
   */
  const press = (event: {
    button: number;
    preventBaseUIHandler?: () => void;
  }) => {
    if (event.button !== 0) return;
    event.preventBaseUIHandler?.();
    requestOpen(!open);
  };
  const requestOpen = (next: boolean) => {
    if (nativePending.current) return;
    const element = trigger.current;
    if (native && next && element && nativeMenusAvailable()) {
      const entries = nativeEntries(rest);
      if (entries) {
        void activate(entries, element);
        return;
      }
    }
    setOpen(next);
  };

  const value: OverlayState = {
    open,
    setOpen,
    press,
    closeAll: () => {
      setOpen(false);
      parent?.closeAll();
    },
    kind,
    nested: !!nested,
    trigger,
  };
  // A native menu is a real macOS window: the trigger stays expanded for as long as it is up,
  // even though Base UI's own open state never leaves `false`.
  const expanded = nativeOpen ? { "aria-expanded": true as const } : {};
  const body = (
    <>
      <SubmenuSlot.Provider value={!!nested}>
        {nested ? (
          triggerNode
        ) : kind === "menu" ? (
          <MenuPrimitive.Trigger
            ref={trigger}
            {...expanded}
            onMouseDown={press}
            render={triggerNode as ReactElement<Record<string, unknown>>}
          />
        ) : (
          <PopoverPrimitive.Trigger
            ref={trigger}
            {...expanded}
            render={triggerNode as ReactElement<Record<string, unknown>>}
          />
        )}
      </SubmenuSlot.Provider>
      {rest}
    </>
  );
  return (
    <State.Provider value={value}>
      {kind === "dialog" ? (
        <PopoverPrimitive.Root
          modal={false}
          open={open}
          onOpenChange={requestOpen}
        >
          {body}
        </PopoverPrimitive.Root>
      ) : nested ? (
        <MenuPrimitive.SubmenuRoot open={open} onOpenChange={requestOpen}>
          {body}
        </MenuPrimitive.SubmenuRoot>
      ) : (
        <MenuPrimitive.Root
          modal={false}
          open={open}
          onOpenChange={requestOpen}
        >
          {body}
        </MenuPrimitive.Root>
      )}
    </State.Provider>
  );
}

const itemSelector =
  '[role="menuitem"]:not(:disabled), [role="option"]:not(:disabled), [role="tab"]:not(:disabled)';
/**
 * Roving focus for the hand-written listboxes and tab strips that are not Base UI components
 * (`controls/tabs.tsx` and the composer rails; `controls/listbox.tsx` was deleted 2026-09-11 when
 * `SelectMenu.tsx` moved to the kit Combobox). Menus no longer use it.
 */
export function navigateItems(event: KeyboardEvent<HTMLElement>) {
  if (event.nativeEvent.isComposing) return;
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(itemSelector),
  ).filter(
    (item) =>
      item.closest('[role="menu"], [role="listbox"], [role="tablist"]') ===
      event.currentTarget,
  );
  if (!items.length) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const backward = event.key === "ArrowUp" || event.key === "ArrowLeft";
  let next = -1;
  if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key))
    next = (index + (backward ? -1 : 1) + items.length) % items.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else if (
    event.key.length === 1 &&
    event.key !== " " &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    next = items.findIndex((_, offset) =>
      (
        items[(index + 1 + offset) % items.length].getAttribute(
          "data-text-value",
        ) ??
        items[(index + 1 + offset) % items.length].textContent ??
        ""
      )
        .trim()
        .toLowerCase()
        .startsWith(event.key.toLowerCase()),
    );
    if (next >= 0) next = (index + 1 + next) % items.length;
  }
  if (next >= 0) {
    event.preventDefault();
    event.stopPropagation();
    items[next].focus();
  }
}

/**
 * brigadier's `"<side> <align>"` strings, translated to Base UI's two props. `top`/`bottom` on a
 * horizontal side mean "align with the anchor's top/bottom edge", which is Base UI's
 * `start`/`end`.
 */
function place(placement: string, nested: boolean) {
  if (nested && placement === "bottom start") placement = "right top";
  const [side, align] = placement.split(" ");
  return {
    side: (["top", "bottom", "left", "right"].includes(side)
      ? side
      : "bottom") as "top" | "bottom" | "left" | "right",
    align: (align === "end" || align === "bottom"
      ? "end"
      : align === "center"
        ? "center"
        : "start") as "start" | "center" | "end",
  };
}

/**
 * Base UI puts `role="menu"` / `role="dialog"` on the popup itself, so `Dropdown.Menu` and
 * `Popover.Dialog` can no longer carry one of their own — two nested elements with the same role
 * make every `getByRole("menu")` in the suite ambiguous. Their accessible name is lifted onto the
 * popup instead.
 */
function label(children: ReactNode) {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ "aria-label"?: string }>(child)) continue;
    if (child.type === Menu || child.type === Dialog)
      return child.props["aria-label"];
  }
  return undefined;
}

let overlays = 0;

const surface =
  "overlay-surface max-h-[80dvh] max-w-[calc(100vw-16px)] w-auto overflow-auto rounded-md border border-hairline bg-elevated p-1 text-text ring-0 shadow-overlay";

function Content({
  placement = "bottom start",
  children,
  className,
}: {
  placement?: string;
  children: ReactNode;
  className?: string;
}) {
  const state = useContext(State)!;
  // `DropdownMenuContent` and `DropdownMenuSubContent` are plain functions that do not forward a
  // ref, so the popup is found by a marker attribute instead. (`PopoverContent` is the exception —
  // it *is* a `forwardRef` and passes the ref to `Popover.Popup` — but the dialog and menu paths
  // below share one lookup, so it uses the marker too.) `aria-label` proves ordinary props do
  // reach the popup. `useId` is not usable here: React restarts its counter for every root, so two
  // roots in one document (two tests, or a portal-heavy page) would collide on the same marker.
  const marker = useRef(`o${(overlays += 1)}`).current;
  const panel = () =>
    document.querySelector<HTMLElement>(`[data-overlay="${marker}"]`);
  /**
   * Base UI leaves a pointer-opened menu focused on its trigger and a keyboard-opened one focused
   * on the first row. Where it does hand focus to the popup itself, the row is what should have
   * it — focusing the row is enough, because Base UI's composite adopts it as its highlighted
   * index on focus.
   */
  const first = (popup: HTMLElement | null) =>
    popup
      ?.querySelector<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])',
      )
      ?.focus();
  const { side, align } = place(placement, state.nested);
  const name = label(children);
  if (state.kind === "dialog")
    return (
      <PopoverContent
        data-overlay={marker}
        side={side}
        align={align}
        // The pre-port overlay clamped a composer popover to the composer surface on the
        // HORIZONTAL axis only (af65dec:overlay.tsx:196-222 — `minLeft`/`maxRight` from the
        // boundary, `top` from the window). Base UI has one `collisionBoundary` for both axes and
        // feeds it to `flip()` as well as `shift()`, so passing the composer surface here told
        // floating-ui a `side="top"` popover had no room above (the surface's own top edge is a
        // few tens of px up) — it flipped to `bottom`, found no room there either, and fell back
        // to the perpendicular axis, which `fallbackAxisSide` defaults to `'end'`
        // (`@base-ui/react/internals/useAnchorPositioning.mjs:87`). The permission popover landed
        // to the RIGHT of its trigger, across the text area. The boundary is therefore gone; the
        // default `'clipping-ancestors'` is the window, which is what the old code clamped
        // against vertically and what these popovers actually need. `collisionPadding` keeps the
        // old 8px margin, and the perpendicular fallback stays off so no composer popover can
        // ever swing sideways again — it may flip top↔bottom, nothing more. Both settings apply
        // to every `Popover` overlay (`SelectMenu`, `SessionContext`, `AgentsPanel`, the composer),
        // which is what the hand-rolled positioner did too: it picked one side and stayed there.
        collisionPadding={8}
        collisionAvoidance={{ fallbackAxisSide: "none" }}
        aria-label={name}
        // Reproduces the old panel's focus order: an explicit autofocus, else the selected row,
        // else the first control. Base UI focuses the popup itself without it.
        initialFocus={(): HTMLElement | boolean => {
          const popup = panel();
          return (
            popup?.querySelector<HTMLElement>(
              '[data-autofocus="true"], [autofocus]',
            ) ??
            popup?.querySelector<HTMLElement>('[aria-selected="true"]') ??
            popup?.querySelector<HTMLElement>(
              'input:not([disabled]), button:not([disabled]), [tabindex="0"]',
            ) ??
            true
          );
        }}
        className={cn(surface, "flex flex-col gap-0", className)}
      >
        {children}
      </PopoverContent>
    );
  const Popup = state.nested ? DropdownMenuSubContent : DropdownMenuContent;
  return (
    <Popup
      data-overlay={marker}
      side={side}
      align={align}
      aria-label={name}
      onFocus={(event) => {
        if (event.target === event.currentTarget) first(event.currentTarget);
      }}
      className={cn(surface, className)}
    >
      {children}
    </Popup>
  );
}

/** A passthrough: the popup itself is the `role="menu"` element. */
function Menu({ children }: ComponentProps<"div">) {
  return <>{children}</>;
}

type ItemProps = Omit<ComponentProps<"div">, "id" | "onClick"> & {
  id?: string;
  onClick?: ComponentProps<"div">["onClick"];
  onAction?: () => void;
  onPress?: () => void;
  checked?: boolean;
  nativeIcon?: ReactElement;
  accelerator?: string;
  textValue?: string;
  isDisabled?: boolean;
  disabled?: boolean;
  isIconOnly?: boolean;
  iconStyle?: "standard" | "bare";
  size?: "sm" | "lg" | "icon" | "icon-xs";
  variant?:
    | "primary"
    | "secondary"
    | "outline"
    | "ghost"
    | "link"
    | "danger"
    | "default"
    | "destructive";
};

function Item({
  onAction,
  onPress,
  checked: _checked,
  nativeIcon: _nativeIcon,
  accelerator: _accelerator,
  isIconOnly: _isIconOnly,
  iconStyle: _iconStyle,
  size: _size,
  isDisabled,
  disabled,
  textValue,
  variant,
  onClick,
  className,
  ...props
}: ItemProps) {
  const submenu = useContext(SubmenuSlot);
  const state = useContext(State);
  const off = isDisabled || disabled;
  const shared = {
    ...props,
    "data-text-value": textValue,
    // The kit's row is `px-2 py-1.5 text-sm rounded-lg` and free-height. brigadier's menu row
    // was 28px tall, 10px inset, 13px type, `--radius-sm` cornered, with 14px glyphs — the
    // metrics `.blur-menu [role="menuitem"]` held in `src/index.css` before the port
    // (af65dec:src/index.css:373-378). They live here now so every menu row carries them, not
    // just the ones inside a `.blur-menu`. The kit's own hover fill is untouched.
    className: cn(
      "h-7 w-full justify-start rounded-sm px-2.5 text-left text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
      className,
    ),
  };
  // A disabled row stays out of Base UI's composite so the arrow keys skip it, which is what
  // `controls-keyboard.test.tsx` asserts and what the old disabled `<button>` did.
  if (off)
    return (
      <div
        {...shared}
        role="menuitem"
        aria-disabled="true"
        tabIndex={-1}
        className={cn(
          "flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm opacity-50 select-none",
          shared.className,
        )}
      />
    );
  const act: ComponentProps<"div">["onClick"] = (event) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    onAction?.();
    onPress?.();
  };
  if (submenu)
    // The kit's `DropdownMenuSubTrigger` appends its own chevron; our call sites supply their
    // own affordance, so this uses the primitive with the kit's classes instead.
    return (
      <MenuPrimitive.SubmenuTrigger
        {...shared}
        // brigadier's menus have never opened a submenu on hover, and Base UI's hover path
        // arms a safe-polygon that sets `pointer-events: none` on everything outside the open
        // popup — which strands a pointer click on a sibling row.
        openOnHover={false}
        onMouseDown={state?.press}
        label={textValue}
        data-slot="dropdown-menu-sub-trigger"
        className={cn(
          "focus:bg-foreground/[0.06] data-open:bg-foreground/[0.06] data-popup-open:bg-foreground/[0.06] flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          shared.className,
        )}
      />
    );
  return (
    <DropdownMenuItem
      {...shared}
      label={textValue}
      variant={
        variant === "danger" || variant === "destructive"
          ? "destructive"
          : "default"
      }
      onClick={act}
    />
  );
}

function Section(props: ComponentProps<"div">) {
  return <div {...props} role="group" />;
}
/** A passthrough: `Popover.Content` is the `role="dialog"` element. */
function Dialog({ children, className }: ComponentProps<"div">) {
  return className ? (
    <div className={className}>{children}</div>
  ) : (
    <>{children}</>
  );
}
function DropdownRoot(props: RootProps) {
  return <OverlayRoot {...props} kind="menu" />;
}
function PopoverRoot(props: RootProps) {
  return <OverlayRoot {...props} kind="dialog" />;
}
export const Dropdown = Object.assign(DropdownRoot, {
  Popover: Content,
  Menu,
  Item,
  Section,
  SubmenuTrigger: DropdownRoot,
});
export const Popover = Object.assign(PopoverRoot, { Content, Dialog });
export function Label(props: ComponentProps<"span">) {
  return <span {...props} />;
}
export function Description(props: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={`text-xs text-text-secondary ${props.className ?? ""}`}
    />
  );
}
export function Header(props: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={`px-3 py-1 text-xs text-text-secondary ${props.className ?? ""}`}
    />
  );
}
export function Separator() {
  return <MenuPrimitive.Separator className="my-1 h-px bg-hairline" />;
}

/** Read the same declarative items used by the fallback; never duplicate action definitions. */
function nativeEntries(nodes: ReactNode): NativeMenuEntry[] | null {
  const result: NativeMenuEntry[] = [];
  const text = (children: ReactNode): string =>
    Children.toArray(children)
      .map((child) => {
        if (typeof child === "string" || typeof child === "number")
          return String(child);
        return isValidElement<{ children?: ReactNode }>(child)
          ? text(child.props.children)
          : "";
      })
      .join("")
      .trim();
  for (const node of Children.toArray(nodes)) {
    if (!isValidElement<{ children?: ReactNode }>(node)) continue;
    if (node.type === Separator) {
      result.push({ separator: true });
      continue;
    }
    if (node.type === DropdownRoot) {
      const children = Children.toArray(node.props.children);
      const trigger = children[0];
      if (!isValidElement<ItemProps>(trigger)) return null;
      const items = nativeEntries(children.slice(1));
      if (!items) return null;
      result.push({
        text: trigger.props.textValue ?? text(trigger.props.children),
        enabled: !(trigger.props.isDisabled || trigger.props.disabled),
        icon: trigger.props.nativeIcon,
        items,
      });
    } else if (node.type === Item) {
      const item = node as ReactElement<ItemProps>;
      if (item.props.onClick) return null;
      const name = item.props.textValue ?? text(item.props.children);
      if (!name) return null;
      result.push({
        text: name,
        enabled: !(item.props.isDisabled || item.props.disabled),
        checked: item.props.checked,
        icon: item.props.nativeIcon,
        accelerator: item.props.accelerator,
        action: item.props.onAction,
      });
    } else {
      const nested = nativeEntries(node.props.children);
      if (!nested) return null;
      result.push(...nested);
    }
  }
  return result;
}
