import { showNativeMenu, type NativeMenuEntry } from "./native-menu";
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "./button";

type OverlayState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  closeAll: () => void;
  anchor: RefObject<HTMLSpanElement | null>;
  id: string;
  kind: "menu" | "dialog";
  parentId?: string;
};
const State = createContext<OverlayState | null>(null);
export function useOverlay() {
  return useContext(State);
}
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
  const [local, setLocal] = useState(false);
  const [nativeOpen, setNativeOpen] = useState(false);
  const nativePending = useRef(false);
  const open = isOpen ?? local;
  const anchor = useRef<HTMLSpanElement>(null);
  const id = useId();
  const setOpen = (next: boolean) => {
    setLocal(next);
    onOpenChange?.(next);
  };
  const parts = Children.toArray(children);
  const trigger = parts[0] as ReactElement<ComponentProps<typeof Button>>;
  const activate = async (element: HTMLElement, next: boolean) => {
    if (nativePending.current) return;
    if (!native || !next) {
      setOpen(next);
      return;
    }
    const entries = nativeEntries(parts.slice(1));
    if (!entries) {
      setOpen(next);
      return;
    }
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
  return (
    <State.Provider
      value={{
        open,
        setOpen,
        closeAll: () => {
          setOpen(false);
          parent?.closeAll();
        },
        anchor,
        id,
        kind,
        parentId: parent?.id,
      }}
    >
      <span ref={anchor} className="contents">
        {isValidElement(trigger) &&
          cloneElement(trigger, {
            "aria-haspopup": kind,
            "aria-expanded": open || nativeOpen,
            "aria-controls": open ? id : undefined,
            onClick: (event) => {
              trigger.props.onClick?.(event);
              if (!event.defaultPrevented)
                void activate(event.currentTarget, !open);
            },
            onKeyDown: (event) => {
              trigger.props.onKeyDown?.(event);
              if (
                !event.defaultPrevented &&
                [
                  "ArrowDown",
                  "ArrowUp",
                  ...(parent ? ["ArrowRight"] : []),
                ].includes(event.key)
              ) {
                event.preventDefault();
                event.stopPropagation();
                void activate(event.currentTarget, true);
              }
            },
          })}
      </span>
      {parts.slice(1)}
    </State.Provider>
  );
}
const itemSelector =
  '[role="menuitem"]:not(:disabled), [role="option"]:not(:disabled), [role="tab"]:not(:disabled)';
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
  if (state.parentId && state.kind === "menu" && placement === "bottom start")
    placement = "right top";
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(state);
  latest.current = state;
  useLayoutEffect(() => {
    if (!state.open) return;
    const panel = ref.current!;
    const trigger = state.anchor.current
      ?.firstElementChild as HTMLElement | null;
    const previous = document.activeElement as HTMLElement | null;
    const position = () => {
      if (!trigger) return;
      const a = trigger.getBoundingClientRect(),
        p = panel.getBoundingClientRect();
      const [side, align] = placement.split(" ");
      let left = a.left,
        top = a.bottom + 4;
      if (side === "top") top = a.top - p.height - 4;
      if (side === "right") {
        left = a.right + 4;
        top = a.top;
      }
      if (side === "left") {
        left = a.left - p.width - 4;
        top = a.top;
      }
      if (["bottom", "top"].includes(side) && align === "end")
        left = a.right - p.width;
      if (["left", "right"].includes(side) && align === "bottom")
        top = a.bottom - p.height;
      panel.style.left = `${Math.max(8, Math.min(left, window.innerWidth - p.width - 8))}px`;
      panel.style.top = `${Math.max(8, Math.min(top, window.innerHeight - p.height - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(panel);
    (
      panel.querySelector<HTMLElement>(
        '[data-autofocus="true"], [autofocus]',
      ) ??
      panel.querySelector<HTMLElement>('[aria-selected="true"]') ??
      panel.querySelector<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), [tabindex="0"]',
      ) ??
      panel
    ).focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (panel.contains(target) || trigger?.contains(target)) return;
      // Portaled submenus belong to this overlay even though they are not DOM children.
      let overlay = target.closest<HTMLElement>("[data-overlay-parent]");
      while (overlay) {
        if (overlay.dataset.overlayParent === state.id) return;
        overlay = overlay.dataset.overlayParent
          ? document.getElementById(overlay.dataset.overlayParent)
          : null;
      }
      latest.current.setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      if (
        document.activeElement === document.body ||
        panel.contains(document.activeElement)
      ) {
        if (previous?.isConnected) previous.focus();
        else trigger?.focus();
      }
    };
  }, [state.open, placement, state.id, state.anchor]);
  if (!state.open) return null;
  // Keep overlays in the native dialog's top layer when opened from a modal.
  const portal = state.anchor.current?.closest("dialog") ?? document.body;
  return createPortal(
    <div
      ref={ref}
      id={state.id}
      data-overlay-parent={state.parentId}
      tabIndex={-1}
      className={`overlay-surface fixed z-50 max-h-[80dvh] max-w-[calc(100vw-16px)] overflow-auto rounded-md border border-hairline bg-elevated p-1 text-text shadow-overlay ${className ?? ""}`}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" ||
          (state.parentId && event.key === "ArrowLeft")
        ) {
          event.preventDefault();
          event.stopPropagation();
          state.setOpen(false);
          (state.anchor.current?.firstElementChild as HTMLElement)?.focus();
        }
        if (event.key === "Tab") {
          state.closeAll();
        }
      }}
    >
      {children}
    </div>,
    portal,
  );
}
function Menu(props: ComponentProps<"div">) {
  return <div {...props} role="menu" onKeyDown={navigateItems} />;
}
function Item({
  onAction,
  checked: _checked,
  nativeIcon: _nativeIcon,
  accelerator: _accelerator,
  isDisabled,
  textValue,
  variant,
  onClick,
  ...props
}: Omit<ComponentProps<typeof Button>, "id"> & {
  id?: string;
  onAction?: () => void;
  checked?: boolean;
  nativeIcon?: ReactElement;
  accelerator?: string;
  textValue?: string;
}) {
  const state = useContext(State);
  const submenuTrigger = props["aria-haspopup"] === "menu";
  return (
    <Button
      {...props}
      variant={variant}
      role="menuitem"
      tabIndex={-1}
      isDisabled={isDisabled}
      data-text-value={textValue}
      className={`w-full justify-start text-left ${props.className ?? ""}`}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          if (!submenuTrigger) state?.closeAll();
          onAction?.();
        }
      }}
    />
  );
}
function Section(props: ComponentProps<"div">) {
  return <div {...props} role="group" />;
}
function Dialog(props: ComponentProps<"div">) {
  return <div {...props} role="dialog" />;
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
  return <hr className="my-1 border-0 border-t border-hairline" />;
}

/** Read the same declarative items used by the fallback; never duplicate action definitions. */
function nativeEntries(nodes: ReactNode): NativeMenuEntry[] | null {
  const result: NativeMenuEntry[] = [];
  const label = (children: ReactNode): string =>
    Children.toArray(children)
      .map((child) => {
        if (typeof child === "string" || typeof child === "number")
          return String(child);
        return isValidElement<{ children?: ReactNode }>(child)
          ? label(child.props.children)
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
      if (!isValidElement<ComponentProps<typeof Item>>(trigger)) return null;
      const items = nativeEntries(children.slice(1));
      if (!items) return null;
      result.push({
        text: trigger.props.textValue ?? label(trigger.props.children),
        enabled: !(trigger.props.isDisabled || trigger.props.disabled),
        items,
      });
    } else if (node.type === Item) {
      const item = node as ReactElement<ComponentProps<typeof Item>>;
      if (item.props.onClick) return null;
      const text = item.props.textValue ?? label(item.props.children);
      if (!text) return null;
      result.push({
        text,
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
