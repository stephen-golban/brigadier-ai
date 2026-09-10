import { ChevronRight, Edit, Sidebar as SidebarGlyph } from "../../icons";
import { useSidebarVibrancy } from "../../hooks/use-sidebar-vibrancy";
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
  type ReactNode,
} from "react";
import { useIsMobile } from "../../hooks/use-mobile";
import { Button } from "./button";
import { cn } from "../../lib/utils";
type SidebarState = {
  open: boolean;
  openMobile: boolean;
  peek: boolean;
  attention: boolean;
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
export function SidebarProvider({
  open: controlled,
  defaultOpen = true,
  onOpenChange,
  navigationControls,
  attention = false,
  children,
  className,
  ...props
}: ComponentProps<"div"> & {
  open?: boolean;
  defaultOpen?: boolean;
  navigationControls?: ReactNode;
  attention?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  useSidebarVibrancy();
  const [local, setLocal] = useState(defaultOpen),
    [openMobile, setOpenMobile] = useState(false);
  const [peek, setPeek] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const keepPreview = () => clearTimeout(previewTimer.current);
  const open = controlled ?? local,
    isMobile = useIsMobile();
  const previewSidebar = () => {
    keepPreview();
    if (!open && !isMobile)
      previewTimer.current = setTimeout(() => setPeek(true), 180);
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
    }, 160);
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
  const toggleSidebar = () => {
    if (document.querySelector(".desktop-settings")) return;
    keepPreview();
    setPeek(false);
    if (isMobile) setOpenMobile(!openMobile);
    else {
      setLocal(!open);
      onOpenChange?.(!open);
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "b" &&
        !document.querySelector('[role="dialog"]')
      ) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, openMobile, isMobile]);
  return (
    <Context.Provider
      value={{
        open,
        openMobile,
        isMobile,
        peek,
        attention,
        previewSidebar,
        keepPreview,
        leavePreview,
        setOpenMobile,
        toggleSidebar,
      }}
    >
      <div
        {...props}
        data-slot="sidebar-wrapper"
        data-sidebar-open={!isMobile && open}
        data-sidebar-peek={!isMobile && !open && peek}
        className={cn(
          "app-shell flex h-dvh min-h-0 w-full flex-col bg-canvas text-text",
          className,
        )}
      >
        <div
          className="workspace-chrome flex h-11 shrink-0 items-center gap-1"
          data-tauri-drag-region="deep"
        >
          <SidebarTrigger />
          {open && !isMobile ? (
            navigationControls
          ) : (
            <span className="collapsed-new-chat">
              <Tooltip
                content={
                  <>
                    New chat{" "}
                    <Kbd>
                      {navigator.platform.startsWith("Mac") ? "⌘N" : "Ctrl N"}
                    </Kbd>
                  </>
                }
              >
                <Button
                  isIconOnly
                  aria-label="New chat"
                  aria-keyshortcuts={
                    navigator.platform.startsWith("Mac")
                      ? "Meta+N"
                      : "Control+N"
                  }
                  className="size-7 text-text-secondary"
                  onClick={() =>
                    window.dispatchEvent(new Event("brigadier-new-chat"))
                  }
                >
                  <Edit className="size-3.5" />
                </Button>
              </Tooltip>
            </span>
          )}
        </div>
        <div className="flex min-h-0 flex-1">{children}</div>
      </div>
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
            className="app-navigation fixed inset-y-0 left-0 m-0 flex h-dvh max-h-none w-[264px] flex-col border-r border-hairline bg-sidebar p-0 text-[13px] leading-[1.4]"
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
      <div
        {...props}
        data-slot="sidebar"
        onPointerEnter={keepPreview}
        onPointerLeave={leavePreview}
        className={cn(
          "app-navigation flex h-full w-[264px] shrink-0 flex-col border-r border-hairline bg-sidebar text-[13px] leading-[1.4]",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function SidebarTrigger() {
  const {
    toggleSidebar,
    open,
    isMobile,
    openMobile,
    attention,
    previewSidebar,
    leavePreview,
  } = useSidebar();
  const expanded = isMobile ? openMobile : open;
  return (
    <span
      data-sidebar-toggle
      onPointerEnter={previewSidebar}
      onPointerLeave={leavePreview}
    >
      <Tooltip
        content={
          <>
            Toggle sidebar{" "}
            <Kbd>{navigator.platform.startsWith("Mac") ? "⌘B" : "Ctrl B"}</Kbd>
          </>
        }
      >
        <Button
          isIconOnly
          aria-label="Toggle Sidebar"
          aria-keyshortcuts={
            navigator.platform.startsWith("Mac") ? "Meta+B" : "Control+B"
          }
          className="relative size-7 rounded-md text-text-secondary hover:bg-hover hover:text-text [&_svg]:text-current"
          aria-expanded={expanded}
          onPress={toggleSidebar}
        >
          <SidebarGlyph className="size-4" />
          {!expanded && attention && (
            <span
              role="img"
              aria-label="Sessions need attention"
              className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-attention"
            />
          )}
        </Button>
      </Tooltip>
    </span>
  );
}
export function SidebarInset(props: ComponentProps<"main">) {
  return (
    <main
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
    <div
      {...props}
      className={cn("navigation-header shrink-0", props.className)}
    />
  );
}
export function SidebarContent(props: ComponentProps<"div">) {
  return (
    <div
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
    <div
      {...props}
      className={cn("navigation-footer shrink-0 p-2", props.className)}
    />
  );
}
export function SidebarGroup(props: ComponentProps<"section">) {
  return (
    <section {...props} className={cn("relative pt-6", props.className)} />
  );
}
export function SidebarGroupLabel(props: ComponentProps<"h2">) {
  return (
    <h2
      {...props}
      className={cn(
        "flex h-8 items-center px-4 text-[13px] font-normal text-text-tertiary",
        props.className,
      )}
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
    <SidebarGroupLabel className="group/section pr-10 text-[14px] tracking-normal">
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
          className={`projects-chevron size-3.5 text-text-secondary ${open ? "rotate-90" : ""}`}
        />
      </button>
    </SidebarGroupLabel>
  );
}
export function SidebarGroupContent(props: ComponentProps<"div">) {
  return <div {...props} />;
}
export function SidebarMenu(props: ComponentProps<"ul">) {
  return (
    <ul
      {...props}
      className={cn("m-0 flex list-none flex-col gap-0.5 p-0", props.className)}
    />
  );
}
export function SidebarMenuItem(props: ComponentProps<"li">) {
  return (
    <li {...props} className={cn("relative mx-2 min-w-0", props.className)} />
  );
}
export function SidebarMenuButton({
  isActive,
  ...props
}: ComponentProps<typeof Button> & { isActive?: boolean }) {
  return (
    <Button
      {...props}
      variant={isActive ? "secondary" : "ghost"}
      className={cn(
        "navigation-row h-8 w-full justify-start rounded-md px-2 font-normal text-text-secondary data-[active=true]:bg-selected data-[active=true]:text-text",
        props.className,
      )}
      data-active={isActive || undefined}
    />
  );
}
export function SidebarMenuAction({
  showOnHover,
  ...props
}: ComponentProps<typeof Button> & { showOnHover?: boolean }) {
  return (
    <Button
      {...props}
      size="icon"
      iconStyle="bare"
      className={cn(
        "navigation-action absolute top-0 right-1 h-8 w-6 rounded-none p-0 text-text-tertiary hover:bg-transparent hover:text-text [&_svg]:text-current",
        showOnHover && "row-action",
        props.className,
      )}
    />
  );
}
export function SidebarMenuSub(props: ComponentProps<"ul">) {
  return (
    <ul
      {...props}
      className="navigation-sessions m-0 flex list-none flex-col gap-0.5 p-0 pt-0.5 [&>li]:mx-0 [&_.navigation-row]:pl-8"
    />
  );
}
export const SidebarMenuSubItem = SidebarMenuItem;
export const SidebarMenuSubButton = SidebarMenuButton;
export function SidebarRail() {
  return null;
}
