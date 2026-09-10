import { ChevronRight, Edit, Folder } from "../../icons";
import { useSidebarVibrancy } from "../../hooks/use-sidebar-vibrancy";
import { useFullscreen } from "../../hooks/use-fullscreen";
import { Tooltip } from "./tooltip";
import { Kbd } from "./kbd";
import { Modal } from "./modal";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useIsMobile } from "../../hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { iconButton } from "@/lib/surfaces";
import { cn } from "../../lib/utils";
import {
  Sidebar as KitSidebar,
  SidebarContent as KitSidebarContent,
  SidebarFooter as KitSidebarFooter,
  SidebarGroup as KitSidebarGroup,
  SidebarGroupContent as KitSidebarGroupContent,
  SidebarGroupLabel as KitSidebarGroupLabel,
  SidebarHeader as KitSidebarHeader,
  SidebarInset as KitSidebarInset,
  SidebarMenu as KitSidebarMenu,
  SidebarMenuAction as KitSidebarMenuAction,
  SidebarMenuButton as KitSidebarMenuButton,
  SidebarMenuItem as KitSidebarMenuItem,
  SidebarMenuSub as KitSidebarMenuSub,
  SidebarProvider as KitSidebarProvider,
  SidebarTrigger as KitSidebarTrigger,
} from "@/components/ui/sidebar";

/**
 * brigadier's navigation, as an adapter over the design kit's `sidebar.tsx`
 * (`src/components/ui/sidebar.tsx`, a copy of assistant-ui/assistant-ui `1a5da0f`). Every export
 * name its call sites already use survives; the geometry and ink are Codex's, measured in
 * `docs/research/codex-sidebar.md` and applied in `src/index.css`'s sidebar section.
 *
 * Three things stay brigadier's and are *not* the kit's:
 *
 *  - **peek.** Hovering the collapsed toggle previews the panel without pinning it; a click
 *    pins. The kit has no such state, so `peek` and its pointer/Escape machinery live here.
 *  - **the workspace chrome.** A 46px bar above both panes carrying the toggle and, collapsed,
 *    the Codex row: toggle · pencil · divider · folder · current session title.
 *  - **the shell.** `.sidebar-shell` animates a `clip-path` rather than the kit's fixed/offcanvas
 *    translate, so the kit's `Sidebar` is used in its `collapsible="none"` form (a plain
 *    `w-(--sidebar-width)` column) inside brigadier's own shell.
 *
 * The kit's `SidebarProvider` is nested *inside* brigadier's and driven controlled. It is what
 * publishes the kit's own `SidebarContext`, which every kit leaf primitive
 * (`SidebarMenuButton`, `SidebarMenuAction`, `SidebarTrigger`) reads, and it owns the single
 * ⌘B listener — brigadier's duplicate was removed, because two `window` keydown handlers both
 * toggling would cancel each other out. Its guards moved to `applyOpen` below.
 */
type SidebarState = {
  open: boolean;
  openMobile: boolean;
  peek: boolean;
  attention: boolean;
  /** Label for the collapsed chrome; published by `Sidebar.tsx`, which owns the lookup. */
  currentSession: string | null;
  setCurrentSession: (title: string | null) => void;
  previewSidebar: () => void;
  keepPreview: () => void;
  leavePreview: () => void;
  isMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  toggleSidebar: () => void;
};
const Context = createContext<SidebarState | null>(null);
export function useSidebar() {
  const state = useContext(Context);
  if (!state) throw new Error("Sidebar provider is missing");
  return state;
}
const mac = () => navigator.platform.startsWith("Mac");
/**
 * Hover intent. The pointer has to rest on the collapsed toggle for this long before the peek
 * opens, so crossing the chrome on the way to the thread no longer flashes the panel open.
 * Owner decision 2026-09-11; it was 180ms, which read as immediate. Only the *opening* edge is
 * delayed — `PEEK_CLOSE_DELAY_MS` and the click toggle are untouched.
 */
const PEEK_OPEN_DELAY_MS = 300;
/** The grace period that lets the pointer cross the gap from toggle to panel. */
const PEEK_CLOSE_DELAY_MS = 160;
export function SidebarProvider({
  open: controlled,
  defaultOpen = true,
  onOpenChange,
  navigationControls,
  attention = false,
  children,
  className,
  style,
  ...props
}: ComponentProps<"div"> & {
  open?: boolean;
  defaultOpen?: boolean;
  navigationControls?: ReactNode;
  attention?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  useSidebarVibrancy();
  useFullscreen();
  const [local, setLocal] = useState(defaultOpen),
    [openMobile, setOpenMobile] = useState(false);
  const [peek, setPeek] = useState(false);
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const keepPreview = () => clearTimeout(previewTimer.current);
  const open = controlled ?? local,
    isMobile = useIsMobile();
  const previewSidebar = () => {
    // `keepPreview` is the cancel half: a `pointerleave` before the timer fires clears it, so a
    // pointer that only passes over the toggle never reaches `setPeek(true)`.
    keepPreview();
    if (!open && !isMobile)
      previewTimer.current = setTimeout(() => setPeek(true), PEEK_OPEN_DELAY_MS);
  };
  const leavePreview = () => {
    keepPreview();
    previewTimer.current = setTimeout(() => {
      // Portaled project/account menus remain usable while the sidebar is previewed.
      if (
        !document.querySelector(
          '.app-navigation [aria-haspopup][aria-expanded="true"]',
        )
      )
        setPeek(false);
    }, PEEK_CLOSE_DELAY_MS);
  };
  useEffect(() => () => clearTimeout(previewTimer.current), []);
  useEffect(() => {
    keepPreview();
    setPeek(false);
  }, [open, isMobile]);
  useEffect(() => {
    if (!peek) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !target.closest(
          ".app-navigation, [data-sidebar-toggle], .overlay-surface",
        )
      )
        setPeek(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPeek(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [peek]);
  /**
   * The single funnel for every open/close: the kit's ⌘B, the kit's `SidebarTrigger` click and
   * `toggleSidebar()` below all arrive here. The two refusals are brigadier's, and were on the
   * pre-port keydown handler and `toggleSidebar`: the settings overlay and any open dialog both
   * swallow the shortcut. The kit still calls `preventDefault()` before we refuse, which is the
   * pre-port behaviour too.
   */
  const applyOpen = (next: boolean) => {
    if (
      document.querySelector(".desktop-settings") ||
      document.querySelector('[role="dialog"]')
    )
      return;
    keepPreview();
    setPeek(false);
    if (isMobile) setOpenMobile(next);
    else {
      setLocal(next);
      onOpenChange?.(next);
    }
  };
  const toggleSidebar = () => applyOpen(isMobile ? !openMobile : !open);
  return (
    <Context.Provider
      value={{
        open,
        openMobile,
        isMobile,
        peek,
        attention,
        currentSession,
        setCurrentSession,
        previewSidebar,
        keepPreview,
        leavePreview,
        setOpenMobile,
        toggleSidebar,
      }}
    >
      <KitSidebarProvider
        {...props}
        open={isMobile ? openMobile : open}
        onOpenChange={applyOpen}
        data-sidebar-open={!isMobile && open}
        data-sidebar-peek={!isMobile && !open && peek}
        // The kit hard-codes `--sidebar-width: 16rem` on this element, which is 224px against
        // this app's 14px root and would beat any `:root` default. Codex's 275px is restated
        // here so `var(--sidebar-width, 275px)` resolves to it, and a caller's own `style` —
        // `App.tsx` sets the resized width — still wins, because it is spread last.
        style={
          { "--sidebar-width": "275px", ...style } as CSSProperties
        }
        className={cn(
          "app-shell flex h-dvh min-h-0 w-full flex-col bg-canvas text-text",
          className,
        )}
      >
        <div className="workspace-chrome flex shrink-0 items-center" data-tauri-drag-region="deep">
          <SidebarTrigger />
          {open && !isMobile ? (
            navigationControls
          ) : (
            <span className="collapsed-chrome flex min-w-0 flex-1 items-center">
              <span className="collapsed-new-chat">
                <Tooltip
                  content={
                    <>
                      New chat <Kbd>{mac() ? "⌘N" : "Ctrl N"}</Kbd>
                    </>
                  }
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="New chat"
                    aria-keyshortcuts={mac() ? "Meta+N" : "Control+N"}
                    className={cn(iconButton, "chrome-button")}
                    onClick={() =>
                      window.dispatchEvent(new Event("brigadier-new-chat"))
                    }
                  >
                    <Edit />
                  </Button>
                </Tooltip>
              </span>
              <span aria-hidden="true" className="chrome-divider" />
              <span className="chrome-session">
                <Folder aria-hidden="true" className="chrome-session-icon" />
                <span className="chrome-session-title text-fade-truncate">
                  {currentSession ?? "New session"}
                </span>
              </span>
            </span>
          )}
        </div>
        <div className="flex min-h-0 flex-1">{children}</div>
      </KitSidebarProvider>
    </Context.Provider>
  );
}
export function Sidebar({
  children,
  className,
  collapsible: _collapsible,
  ...props
}: ComponentProps<"div"> & { collapsible?: string }) {
  const {
    open,
    isMobile,
    openMobile,
    peek,
    keepPreview,
    leavePreview,
    setOpenMobile,
  } = useSidebar();
  if (isMobile)
    return (
      <Modal.Backdrop isOpen={openMobile} onOpenChange={setOpenMobile}>
        <Modal.Container>
          <Modal.Dialog
            aria-label="Main navigation"
            className="app-navigation fixed inset-y-0 left-0 m-0 flex h-dvh max-h-none w-[var(--sidebar-width,275px)] flex-col border-r border-hairline bg-sidebar p-0"
          >
            {children}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    );
  return (
    <div
      data-slot="sidebar-shell"
      data-open={open}
      data-peek={!open && peek}
      className="sidebar-shell"
      inert={!open && !peek}
      aria-hidden={!open && !peek}
    >
      {/*
        `collapsible="none"` is the kit's plain column — `bg-sidebar text-sidebar-foreground flex
        h-full w-(--sidebar-width) flex-col` — which is exactly what `.app-navigation` was. The
        kit's own offcanvas/icon machinery is deliberately unused: it slides a `position: fixed`
        panel, and brigadier's shell animates a clip-path so the thread never reflows.
      */}
      <KitSidebar
        {...props}
        collapsible="none"
        onPointerEnter={keepPreview}
        onPointerLeave={leavePreview}
        className={cn("app-navigation shrink-0 border-r border-hairline", className)}
      >
        {children}
      </KitSidebar>
    </div>
  );
}

export function SidebarTrigger() {
  const { open, isMobile, openMobile, attention, previewSidebar, leavePreview } =
    useSidebar();
  const expanded = isMobile ? openMobile : open;
  return (
    <span
      data-sidebar-toggle
      className="relative inline-flex"
      onPointerEnter={previewSidebar}
      onPointerLeave={leavePreview}
    >
      <Tooltip
        content={
          <>
            Toggle sidebar <Kbd>{mac() ? "⌘B" : "Ctrl B"}</Kbd>
          </>
        }
      >
        {/*
          The kit's trigger owns the click; it calls the kit context's `toggleSidebar`, which
          lands in `applyOpen`. Its accessible name is the kit's own `sr-only` span, so the
          "Toggle Sidebar" queries in `controls/sidebar.test.tsx` are upstream's wording.

          `aria-expanded` is kept for accessibility, but the kit's ghost variant paints it:
          `aria-expanded:bg-muted aria-expanded:text-foreground`
          (`src/components/ui/button.tsx:17`) gave the toggle a filled box for as long as the
          sidebar was open, which the owner reads as "selected". `aria-expanded:bg-transparent`
          is appended after the kit's variant string, so `cn`'s tailwind-merge drops
          `aria-expanded:bg-muted` and the button is neutral open or closed; the hover fill is
          `.workspace-chrome .chrome-button:hover` in `src/index.css`, which is unlayered and
          so still wins. The ink half needs no override for the same reason — that unlayered
          rule's `color` already beats `aria-expanded:text-foreground` in `@layer utilities`.
          Scoped here rather than on the adapter so no other `aria-expanded` button moves.
        */}
        <KitSidebarTrigger
          aria-keyshortcuts={mac() ? "Meta+B" : "Control+B"}
          aria-expanded={expanded}
          className="chrome-button aria-expanded:bg-transparent"
        />
      </Tooltip>
      {!expanded && attention && (
        <span
          role="img"
          aria-label="Sessions need attention"
          className="pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full bg-attention"
        />
      )}
    </span>
  );
}
export function SidebarInset(props: ComponentProps<"main">) {
  return (
    <KitSidebarInset
      {...props}
      className={cn(
        "app-main flex min-h-0 min-w-0 flex-1 flex-col bg-canvas",
        props.className,
      )}
    />
  );
}
export function SidebarHeader(props: ComponentProps<"div">) {
  return (
    <KitSidebarHeader
      {...props}
      className={cn("navigation-header shrink-0 gap-0 p-0", props.className)}
    />
  );
}
export function SidebarContent(props: ComponentProps<"div">) {
  return (
    <KitSidebarContent
      {...props}
      className={cn(
        "navigation-content min-h-0 flex-1 overflow-y-auto",
        props.className,
      )}
    />
  );
}
export function SidebarFooter(props: ComponentProps<"div">) {
  return (
    <KitSidebarFooter
      {...props}
      className={cn("navigation-footer shrink-0", props.className)}
    />
  );
}
export function SidebarGroup(props: ComponentProps<"div">) {
  return (
    <KitSidebarGroup
      {...props}
      className={cn("navigation-section p-0", props.className)}
    />
  );
}
export function SidebarGroupLabel(props: ComponentProps<"h2">) {
  return (
    <KitSidebarGroupLabel
      {...props}
      // `render` keeps the pre-port heading element; the kit's default tag is a plain div.
      render={<h2 />}
      className={cn("navigation-section-title", props.className)}
    />
  );
}
export function SidebarSectionHeading({
  label,
  open,
  controls,
  onToggle,
}: {
  label: string;
  open: boolean;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <SidebarGroupLabel className="group/section pr-10">
      <button
        type="button"
        className="flex h-full w-full items-center gap-1.5 text-left"
        aria-label={label}
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
      >
        {label}
        <ChevronRight
          aria-hidden="true"
          className={`projects-chevron size-3.5 ${open ? "rotate-90" : ""}`}
        />
      </button>
    </SidebarGroupLabel>
  );
}
export function SidebarGroupContent(props: ComponentProps<"div">) {
  return <KitSidebarGroupContent {...props} />;
}
export function SidebarMenu(props: ComponentProps<"ul">) {
  return (
    <KitSidebarMenu
      {...props}
      className={cn("navigation-rows m-0 list-none p-0", props.className)}
    />
  );
}
export function SidebarMenuItem(props: ComponentProps<"li">) {
  return (
    <KitSidebarMenuItem
      {...props}
      className={cn("navigation-item min-w-0", props.className)}
    />
  );
}
export function SidebarMenuButton({
  isActive,
  ...props
}: ComponentProps<"button"> & { isActive?: boolean }) {
  return (
    <KitSidebarMenuButton
      {...props}
      isActive={isActive}
      className={cn("navigation-row", props.className)}
    />
  );
}
export function SidebarMenuAction({
  showOnHover,
  ...props
}: ComponentProps<"button"> & { showOnHover?: boolean }) {
  return (
    <KitSidebarMenuAction
      {...props}
      className={cn(
        // Geometry, ink and hover fill are `.navigation-action` in `src/index.css`; it is
        // hand-written and therefore unlayered, so it outranks every utility the kit brings —
        // including the variant-prefixed `peer-data-[size=default]/menu-button:top-1.5` that
        // would otherwise pin a 20px box to the top of a 30px row.
        "navigation-action",
        showOnHover && "row-action",
        props.className,
      )}
    />
  );
}
export function SidebarMenuSub(props: ComponentProps<"ul">) {
  return (
    <KitSidebarMenuSub
      {...props}
      className={cn(
        "navigation-sessions m-0 list-none border-s-0 p-0",
        props.className,
      )}
    />
  );
}
export const SidebarMenuSubItem = SidebarMenuItem;
/**
 * A session row is a `<button>`, not the kit's `<a>`: it selects a session in place and has no
 * href, and `Sidebar.test.tsx` queries every row by `getByRole("button")`.
 */
export const SidebarMenuSubButton = SidebarMenuButton;
/** The kit's rail is a drag-to-resize affordance; brigadier resizes from `LayoutResizer`. */
export function SidebarRail() {
  return null;
}
