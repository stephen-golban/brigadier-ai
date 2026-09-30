import {
  Branch,
  CollapseLg,
  ExpandLg,
  Folders,
  Globe,
  Plus,
  PlusCircle,
  SidebarFloatingRight,
  Terminal,
  User,
  X,
} from "@openai/apps-sdk-ui/components/Icon";
import {
  createContext,
  type CSSProperties,
  type FC,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { WORKERS_LABEL, WorkersTab } from "@/app/conversation/Agents";
import type { FileTarget } from "@/app/conversation/FilesTab";
import type { AgentsPanelState } from "@/app/conversation/WorkerChip";
import { DiffGlyph } from "@/components/assistant-ui/elements/diff-glyph";
import { TitlebarButton, TitlebarTips } from "@/components/titlebar-button";
import { Kbd } from "@/components/ui/kbd";
import { useSidebar } from "@/components/ui/sidebar";
import { tokenPx } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import { useApp } from "@/state/store";
import { closePage } from "@/state/browsers";
import { closeSideChat } from "@/state/sideChats";
import { closeTerminal } from "@/state/terminals";

const ReviewTab = lazy(() =>
  import("@/app/conversation/ReviewTab").then((module) => ({ default: module.ReviewTab })),
);
const TerminalTab = lazy(() =>
  import("@/app/conversation/TerminalTab").then((module) => ({ default: module.TerminalTab })),
);
const SideChatTab = lazy(() =>
  import("@/app/conversation/SideChatTab").then((module) => ({ default: module.SideChatTab })),
);
const BrowserTab = lazy(() =>
  import("@/app/conversation/BrowserTab").then((module) => ({ default: module.BrowserTab })),
);
const FilesTab = lazy(() =>
  import("@/app/conversation/FilesTab").then((module) => ({ default: module.FilesTab })),
);

/**
 * The right side panel, beside the thread behind a splitter: a strip of tabs with "+" to open
 * another. The titlebar's end holds its buttons: Files, Source, Side chat and Terminal (each
 * opens its tab, or hides the panel when its tab is showing), full view while it is open, and
 * the toggle. Toggling it open with no tab shows the tabs this conversation can open.
 *
 * It opens and closes on a spring, only its width moving: its contents keep their width and
 * are revealed from the window's end. Its width is remembered as a share of the workspace
 * (the room beside the rail and sidebar), kept between its least and what leaves the thread
 * its least; double-clicking the splitter restores the default, and dragging it below half
 * the least hides the panel. When the window or workspace gets too narrow for both, it hides
 * by itself and comes back once there is room; opening it then shows it in full view.
 */

/** The kinds of tab the side panel opens. */
export type SideTab =
  | "workers"
  | "review"
  | "terminal"
  | "browser"
  | "files"
  | "source"
  | "sideChat";

/** Each tab's title, icon and shortcut (macOS keys; Ctrl for ⌘ elsewhere). */
const TABS: Record<SideTab, { title: string; icon: ReactNode; keys: string | null }> = {
  workers: { title: WORKERS_LABEL, icon: <User />, keys: null },
  review: { title: "Review", icon: <DiffGlyph />, keys: "⌃⇧G" },
  terminal: { title: "Terminal", icon: <Terminal />, keys: "⌃`" },
  browser: { title: "Browser", icon: <Globe />, keys: "⌘T" },
  files: { title: "Files", icon: <Folders />, keys: "⌘P" },
  source: { title: "Source", icon: <Branch />, keys: null },
  sideChat: { title: "Side chat", icon: <PlusCircle />, keys: "⌥⌘S" },
};

/** The tabs the titlebar has a button for, in order. */
const TOOLS: readonly SideTab[] = ["files", "source", "sideChat", "terminal"];

/** The panel's own shortcuts: show or hide it, and full view. */
const TOGGLE_KEYS = "⌥⌘B";
const FULL_VIEW_KEYS = "⌘⇧F";

/** Which tab a key press opens: ⌃⇧G, ⌃`, ⌘T, ⌘P and ⌥⌘S (Ctrl for ⌘ off macOS). */
function tabForKey(event: KeyboardEvent, mac: boolean): SideTab | null {
  const command = mac ? event.metaKey : event.ctrlKey;
  if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === "KeyG") {
    return "review";
  }
  if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
    if (event.code === "Backquote") return "terminal";
  }
  if (command && !event.shiftKey && !event.altKey && event.code === "KeyT") return "browser";
  if (command && !event.shiftKey && !event.altKey && event.code === "KeyP") return "files";
  if (command && event.altKey && !event.shiftKey && event.code === "KeyS") return "sideChat";
  return null;
}

/** A shortcut as this platform writes it. */
export function shortcutLabel(keys: string, mac: boolean): string {
  return mac
    ? keys
    : keys.replace("⌃", "Ctrl+").replace("⌥", "Alt+").replace("⇧", "Shift+").replace("⌘", "Ctrl+");
}

type PanelState = {
  open: boolean;
  tabs: SideTab[];
  /** `"new"`: the page listing the tabs to open. */
  active: SideTab | "new";
  fullscreen: boolean;
};

const CLOSED: PanelState = { open: false, tabs: [], active: "new", fullscreen: false };

/** How long the panel's width takes to open or close (the `ease-panel` spring). */
const MOTION_MS = 500;

/** The panel's width, as a share of the workspace, once the user dragged it. */
const WIDTH_KEY = "brigadier.sidePanelWidth";

function savedShare(): number | null {
  try {
    const share = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(share) && share > 0 && share < 1 ? share : null;
  } catch {
    return null;
  }
}

function saveShare(share: number | null): void {
  try {
    if (share === null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, share.toFixed(4));
  } catch {
    // Storage can be unavailable; the width then lasts until the app quits.
  }
}

/** The room the panel has: the workspace beside the rail and sidebar, and the window. */
type Room = { workspace: number; window: number; height: number };

/** The panel's least and greatest width in a workspace this wide. */
function widthLimits(workspace: number): { min: number; max: number } {
  const min = tokenPx("--spacing-side-panel-min");
  return { min, max: Math.max(min, workspace - tokenPx("--spacing-side-panel-chat-min")) };
}

/**
 * The panel's width: the dragged share of the workspace, or by default the preferred width,
 * or more where the window is tall and the thread keeps its room; always within its limits.
 */
export function panelWidth(share: number | null, room: Room): number {
  const { min, max } = widthLimits(room.workspace);
  const wanted =
    share === null
      ? Math.max(
          min,
          Math.min(room.height * 1.6, room.workspace - tokenPx("--spacing-side-panel-chat-room")),
          Math.min(
            tokenPx("--spacing-side-panel-preferred"),
            room.workspace - tokenPx("--spacing-side-panel-chat-min"),
          ),
        )
      : share * room.workspace;
  return Math.round(Math.min(max, Math.max(min, wanted)));
}

/**
 * Whether the panel fits beside the thread: the window is not the narrowest, not narrow
 * while the sidebar is open, and the workspace holds both the thread's and the panel's least.
 */
export function panelFits(room: Room, sidebarOpen: boolean): boolean {
  if (room.workspace === 0) return true;
  if (room.window < tokenPx("--spacing-narrowest-window")) return false;
  if (sidebarOpen && room.window < tokenPx("--spacing-narrow-window")) return false;
  return (
    room.workspace >=
    tokenPx("--spacing-side-panel-min") + tokenPx("--spacing-side-panel-chat-min")
  );
}

export type SidePanelApi = {
  state: PanelState;
  /** Whether the panel shows: open, and either fitting beside the thread or in full view. */
  visible: boolean;
  /** Whether it fits beside the thread (else it shows only in full view). */
  fits: boolean;
  /** Its width beside the thread, in CSS pixels. */
  width: number;
  /** Its least and greatest width beside the thread. */
  limits: { min: number; max: number };
  /** Sets its width (dragging the splitter); null restores the default. */
  resize: (width: number | null) => void;
  /** Measures the workspace: attach to the row holding the thread and the panel. */
  workspace: (element: HTMLElement | null) => void;
  /** The file the Files tab shows; null for its tree. */
  file: FileTarget | null;
  /** Shows a file in the Files tab (null: back to the tree). */
  openFile: (file: FileTarget | null) => void;
  /** The tabs this conversation can open (a Chat has only Side chat). */
  available: readonly SideTab[];
  toggle: () => void;
  hide: () => void;
  openTab: (tab: SideTab) => void;
  /** Opens a tab, or hides the panel when that tab is already showing. */
  toggleTab: (tab: SideTab) => void;
  closeTab: (tab: SideTab) => void;
  showNewTab: () => void;
  setFullscreen: (fullscreen: boolean) => void;
  /** Where the panel's open and close motion is (see `useReveal`). */
  reveal: Reveal;
  /** How wide the titlebar's panel buttons are, for the bars they sit over to leave room. */
  buttonsWidth: number;
  setButtonsWidth: (width: number) => void;
};

export const SidePanelContext = createContext<SidePanelApi>({
  state: CLOSED,
  visible: false,
  fits: true,
  width: 0,
  limits: { min: 0, max: 0 },
  resize: () => {},
  workspace: () => {},
  file: null,
  openFile: () => {},
  available: [],
  toggle: () => {},
  hide: () => {},
  openTab: () => {},
  toggleTab: () => {},
  closeTab: () => {},
  showNewTab: () => {},
  setFullscreen: () => {},
  reveal: { mounted: false, out: false, moving: false },
  buttonsWidth: 0,
  setButtonsWidth: () => {},
});

/** The room around `element`, followed as it and the window resize. */
function useRoom(): { room: Room; workspace: (element: HTMLElement | null) => void } {
  const [room, setRoom] = useState<Room>(() => ({
    workspace: 0,
    window: window.innerWidth,
    height: window.innerHeight,
  }));
  const observer = useRef<ResizeObserver | null>(null);
  const workspace = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    const measure = () =>
      setRoom({
        workspace: element.getBoundingClientRect().width,
        window: window.innerWidth,
        height: window.innerHeight,
      });
    observer.current = new ResizeObserver(measure);
    observer.current.observe(element);
  }, []);
  // A window growing only taller leaves the workspace's width alone.
  useEffect(() => {
    const onResize = () =>
      setRoom((current) => ({ ...current, window: window.innerWidth, height: window.innerHeight }));
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      observer.current?.disconnect();
    };
  }, []);
  return { room, workspace };
}

/**
 * The open conversation's side panel, and the Workers tab's selection behind
 * `AgentsPanelContext` (opening a worker opens its tab).
 */
export function useSidePanel(
  conversationId: string | null,
  /** What the panel sits beside: a side chat has no panel of its own. */
  kind: "session" | "chat" | "sideChat" | null,
): {
  panel: SidePanelApi;
  agents: { panel: AgentsPanelState; setPanel: (panel: AgentsPanelState) => void };
} {
  const [state, setState] = useState<PanelState>(CLOSED);
  const [worker, setWorker] = useState<string | null>(null);
  const [file, setFile] = useState<FileTarget | null>(null);
  const [share, setShare] = useState(savedShare);
  const [buttonsWidth, setButtonsWidth] = useState(0);
  const mac = useApp((s) => s.info?.platform === "macos");
  const { open: sidebarOpen } = useSidebar();
  const { room, workspace } = useRoom();
  const fits = panelFits(room, sidebarOpen);
  const fitsNow = useRef(fits);
  useEffect(() => {
    fitsNow.current = fits;
  }, [fits]);
  const visible = state.open && (fits || state.fullscreen);
  const reveal = useReveal(visible);
  const width = panelWidth(share, room);
  const limits = useMemo(() => widthLimits(room.workspace), [room.workspace]);
  const available = useMemo<SideTab[]>(
    () =>
      kind === "session"
        ? ["workers", "review", "terminal", "browser", "files", "source", "sideChat"]
        : kind === "chat"
          ? ["sideChat"]
          : [],
    [kind],
  );

  // Opening the panel where it doesn't fit beside the thread shows it in full view.
  const show = useCallback(
    (current: PanelState): PanelState => ({
      ...current,
      open: true,
      fullscreen: current.fullscreen || !fitsNow.current,
    }),
    [],
  );
  const openTab = useCallback(
    (tab: SideTab) => {
      setState((current) => ({
        ...show(current),
        tabs: current.tabs.includes(tab) ? current.tabs : [...current.tabs, tab],
        active: tab,
      }));
    },
    [show],
  );
  const hide = useCallback(
    () => setState((current) => ({ ...current, open: false, fullscreen: false })),
    [],
  );
  const toggle = useCallback(
    () =>
      setState((current) =>
        current.open && (fitsNow.current || current.fullscreen)
          ? { ...current, open: false, fullscreen: false }
          : show(current),
      ),
    [show],
  );
  const closeTab = useCallback((tab: SideTab) => {
    // Closing the Terminal tab ends its shell, the Browser tab drops its page, and closing
    // the Side chat tab deletes the chat.
    if (tab === "terminal" && conversationId) closeTerminal(conversationId);
    if (tab === "browser" && conversationId) closePage(conversationId);
    if (tab === "sideChat" && conversationId) closeSideChat(conversationId);
    setState((current) => {
      const tabs = current.tabs.filter((open) => open !== tab);
      // Closing the last tab closes the panel.
      if (tabs.length === 0) return CLOSED;
      const active = current.active === tab ? (tabs.at(-1) ?? "new") : current.active;
      return { ...current, tabs, active };
    });
  }, [conversationId]);
  // The panel goes with the conversation view, and the Browser tab's page with it.
  useEffect(() => {
    if (!conversationId) return;
    return () => closePage(conversationId);
  }, [conversationId]);
  // Tab shortcuts while this conversation is open, and the panel's own: ⌥⌘B shows or hides
  // it, ⌘⇧F switches full view (Ctrl for ⌘ off macOS).
  // A side chat's own view has no panel, so it leaves the keys to the conversation around it.
  useEffect(() => {
    if (kind === "sideChat") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const command = mac ? event.metaKey : event.ctrlKey;
      if (command && event.altKey && !event.shiftKey && event.code === "KeyB") {
        event.preventDefault();
        toggle();
        return;
      }
      if (command && event.shiftKey && !event.altKey && event.code === "KeyF") {
        event.preventDefault();
        setState((current) =>
          current.open && fitsNow.current
            ? { ...current, fullscreen: !current.fullscreen }
            : current,
        );
        return;
      }
      const tab = tabForKey(event, mac);
      if (!tab || !available.includes(tab)) return;
      event.preventDefault();
      if (tab === "files") setFile(null);
      openTab(tab);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [kind, mac, available, openTab, toggle]);

  const panel = useMemo<SidePanelApi>(
    () => ({
      state,
      visible,
      fits,
      width,
      limits,
      resize: (next) => {
        const fraction = next === null || room.workspace === 0 ? null : next / room.workspace;
        setShare(fraction);
        saveShare(fraction);
      },
      workspace,
      file,
      openFile: (next) => {
        setFile(next);
        openTab("files");
      },
      available,
      toggle,
      hide,
      openTab,
      toggleTab: (tab) => {
        if (visible && state.active === tab) hide();
        else openTab(tab);
      },
      closeTab,
      showNewTab: () => setState((current) => ({ ...show(current), active: "new" })),
      setFullscreen: (fullscreen) => setState((current) => ({ ...current, fullscreen })),
      reveal,
      buttonsWidth,
      setButtonsWidth,
    }),
    [
      state,
      visible,
      fits,
      width,
      limits,
      room.workspace,
      workspace,
      file,
      available,
      toggle,
      hide,
      openTab,
      closeTab,
      show,
      reveal,
      buttonsWidth,
    ],
  );

  const workersOpen = state.open && state.tabs.includes("workers");
  const agents = useMemo(
    () => ({
      panel: workersOpen ? worker : undefined,
      setPanel: (next: AgentsPanelState) => {
        if (next === undefined) {
          closeTab("workers");
          return;
        }
        setWorker(next);
        openTab("workers");
      },
    }),
    [workersOpen, worker, openTab, closeTab],
  );
  return { panel, agents };
}

/**
 * The splitter on the panel's start edge: drag to resize (below half the least width hides
 * the panel), double-click for the default width; arrow keys step it, Home and End go to its
 * least and greatest.
 */
function Splitter() {
  const { width, limits, resize, hide } = useContext(SidePanelContext);
  const start = useRef<{ x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);

  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizing(false);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panel"
      aria-valuenow={width}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      tabIndex={0}
      data-resizing={resizing || undefined}
      className="group/resize w-resize-handle top-titlebar absolute bottom-0 start-0 z-10 flex -translate-x-1/2 cursor-col-resize justify-center outline-none rtl:translate-x-1/2"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
        const wanted = start.current.width + (start.current.x - event.clientX) * (rtl ? -1 : 1);
        if (wanted < limits.min / 2) {
          // Dragged shut: it opens again at the width it had before the drag.
          resize(start.current.width);
          end(event);
          hide();
          return;
        }
        resize(Math.min(limits.max, Math.max(limits.min, wanted)));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => resize(null)}
      onKeyDown={(event) => {
        const step = tokenPx("--spacing-panel-resize-step");
        const next =
          event.key === "ArrowLeft"
            ? width + step
            : event.key === "ArrowRight"
              ? width - step
              : event.key === "Home"
                ? limits.min
                : event.key === "End"
                  ? limits.max
                  : null;
        if (next === null) return;
        event.preventDefault();
        resize(Math.min(limits.max, Math.max(limits.min, next)));
      }}
    >
      <span className="bg-input w-px opacity-0 transition-opacity duration-150 group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100 group-data-resizing/resize:opacity-100" />
    </div>
  );
}

/**
 * The titlebar's end while a conversation is open: the tool buttons, full view while the
 * panel shows, and the toggle. Drawn once over the view's top end, so they stay put while the
 * panel opens and closes; the top bar and the panel's header leave room for them
 * (`PanelButtonsRoom`).
 */
export const PanelButtons: FC = () => {
  const { state, visible, fits, available, toggle, toggleTab, setFullscreen, setButtonsWidth } =
    useContext(SidePanelContext);
  const mac = useApp((s) => s.info?.platform === "macos");
  const keys = (value: string | null) => (value ? shortcutLabel(value, mac) : undefined);
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = group.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setButtonsWidth(element.offsetWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [setButtonsWidth]);
  return (
    <TitlebarTips>
      <div
        ref={group}
        data-slot="panel-buttons"
        data-tauri-drag-region
        className="h-titlebar absolute end-1 top-0 z-20 flex items-center gap-1.5"
      >
        {TOOLS.filter((tab) => available.includes(tab)).map((tab) => (
          <TitlebarButton
            key={tab}
            tooltip={TABS[tab].title}
            shortcut={keys(TABS[tab].keys)}
            aria-pressed={visible && state.active === tab}
            onClick={() => toggleTab(tab)}
          >
            {TABS[tab].icon}
          </TitlebarButton>
        ))}
        {visible && fits && (
          <TitlebarButton
            tooltip={state.fullscreen ? "Exit full view" : "Enter full view"}
            shortcut={keys(FULL_VIEW_KEYS)}
            aria-pressed={state.fullscreen}
            onClick={() => setFullscreen(!state.fullscreen)}
          >
            {state.fullscreen ? <CollapseLg /> : <ExpandLg />}
          </TitlebarButton>
        )}
        <TitlebarButton
          tooltip={visible ? "Hide side panel" : "Show side panel"}
          shortcut={keys(TOGGLE_KEYS)}
          aria-pressed={visible}
          onClick={toggle}
        >
          <SidebarFloatingRight />
        </TitlebarButton>
      </div>
    </TitlebarTips>
  );
};

/**
 * The room a bar leaves at its end for the panel buttons drawn over it. The thread's top bar
 * (`besidePanel`) gives it up as the panel opens and takes it back as it closes, on the
 * panel's spring, so the bar's own buttons never pass under them.
 */
export function PanelButtonsRoom({ besidePanel = false }: { besidePanel?: boolean }) {
  const { buttonsWidth, reveal } = useContext(SidePanelContext);
  const width = besidePanel && reveal.out ? 0 : buttonsWidth;
  return (
    <div
      aria-hidden
      className={cn(
        "shrink-0",
        besidePanel &&
          reveal.moving &&
          "ease-panel transition-[width] duration-500 motion-reduce:transition-none",
      )}
      style={{ width: `${width}px` }}
    />
  );
}

function TabChip({
  tab,
  title,
  icon,
  active,
  onSelect,
  onClose,
}: {
  tab: SideTab | "new";
  title: string;
  icon: ReactNode;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      data-slot="side-panel-tab"
      data-tab={tab}
      data-active={active || undefined}
      className={cn(
        "group/tab rounded-lg h-control-md w-panel-tab min-w-panel-tab-min flex shrink items-center ps-2.5 pe-1.75 text-sm transition-colors",
        active
          ? "bg-panel-tab shadow-panel-tab text-foreground"
          : "text-toolbar-foreground hover:bg-toolbar-hover",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 [&_svg]:size-icon-md [&_svg]:shrink-0"
      >
        {icon}
        <span className="truncate">{title}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${title} tab`}
        onClick={onClose}
        className={cn(
          "hover:bg-toolbar-hover rounded-lg size-icon-button-xs text-toolbar-foreground hover:text-foreground flex shrink-0 items-center justify-center transition-opacity",
          !active && "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
        )}
      >
        <X className="size-icon-sm" />
      </button>
    </div>
  );
}

/** What a panel with no tab shows: the tabs this conversation can open. */
function NewTabPage() {
  const { available, openTab } = useContext(SidePanelContext);
  const mac = useApp((s) => s.info?.platform === "macos");
  if (available.length === 0) {
    return (
      <p className="text-muted-foreground m-auto p-4 text-sm">
        No tabs are available for this chat
      </p>
    );
  }
  return (
    <ul aria-label="New tab" className="m-auto flex w-full max-w-md flex-col gap-1 p-4">
      {available.map((tab) => (
        <li key={tab}>
          <button
            type="button"
            onClick={() => openTab(tab)}
            className="bg-muted/40 hover:bg-muted rounded-control h-control-lg flex w-full items-center gap-2 px-3 text-sm transition-colors [&_svg]:size-icon-sm"
          >
            {TABS[tab].icon}
            <span className="flex-1 text-start">{TABS[tab].title}</span>
            {TABS[tab].keys && <Kbd>{shortcutLabel(TABS[tab].keys, mac)}</Kbd>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The Source tab, for now: where source control will be. */
function SourceTab() {
  return (
    <div className="m-auto flex max-w-xs flex-col items-center gap-2 p-4 text-center">
      <Branch className="text-muted-foreground size-icon-lg" />
      <p className="text-sm font-medium">Source control</p>
      <p className="text-muted-foreground text-sm">
        Changes, commits and branches will show here. Until then, Review shows what changed.
      </p>
    </div>
  );
}

/** Whether the panel is mounted, whether it is out at its width, and whether it is moving. */
type Reveal = { mounted: boolean; out: boolean; moving: boolean };

/** The panel's reveal, following `visible`: it mounts closed and opens a frame later, and
 * stays mounted until it has closed. */
function useReveal(visible: boolean): Reveal {
  const [seen, setSeen] = useState(visible);
  const [mounted, setMounted] = useState(visible);
  const [out, setOut] = useState(visible);
  const [moving, setMoving] = useState(false);
  if (seen !== visible) {
    setSeen(visible);
    if (visible) setMounted(true);
    else setMoving(true);
  }
  useEffect(() => {
    // Two frames: the first lays it out where it is with its transition on, the second moves
    // it (a width changed in the same frame as its transition is turned on doesn't animate).
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        setMoving(true);
        setOut(visible);
      });
    });
    // Settled once the motion has run, counting the frames before it starts.
    const settled = window.setTimeout(() => {
      setMoving(false);
      if (!visible) setMounted(false);
    }, MOTION_MS + 100);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settled);
    };
  }, [visible]);
  return { mounted, out, moving };
}

/** The side panel of a conversation, while it shows (and while it opens and closes). */
export function SidePanel({ conversationId }: { conversationId: string | null }) {
  const { state, visible, width, closeTab, openTab, showNewTab, reveal } =
    useContext(SidePanelContext);
  const { state: sidebar } = useSidebar();
  const { mounted, out, moving } = reveal;
  const strip = useRef<HTMLDivElement>(null);
  // Keep the active tab in view in a strip that scrolls; only the strip moves (scrolling the
  // tab into view would move the panel under it too while it opens).
  const active = state.active;
  useEffect(() => {
    if (!mounted) return;
    const list = strip.current;
    const tab = list?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    if (!list || !tab) return;
    const box = list.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    if (rect.left < box.left) list.scrollLeft -= box.left - rect.left;
    else if (rect.right > box.right) list.scrollLeft += rect.right - box.right;
  }, [active, mounted]);
  if (!mounted) return null;
  const full = state.fullscreen && visible;
  const size = { width: `${width}px` } satisfies CSSProperties;
  return (
    <div className={cn("relative flex h-full", full ? "min-w-0 flex-1" : "shrink-0")}>
      <div
        data-slot="side-panel-clip"
        // Live from the moment it opens, so a tab's field can take focus as it mounts.
        inert={!visible}
        className={cn(
          "flex h-full justify-end overflow-clip",
          full ? "flex-1" : "shadow-side-panel",
          moving && !full && "ease-panel transition-[width] duration-500 motion-reduce:transition-none",
        )}
        style={full ? undefined : out ? size : { width: 0 }}
      >
        <aside
          aria-label="Side panel"
          className={cn("flex h-full shrink-0 flex-col", full ? "w-full" : "column-divider")}
          style={full ? undefined : size}
        >
          <header
            data-tauri-drag-region
            className={cn(
              "h-titlebar flex shrink-0 items-center gap-1 ps-1 pe-1",
              full && sidebar === "collapsed" && "ps-titlebar-clear",
            )}
          >
            <div
              ref={strip}
              role="tablist"
              className="hide-scrollbar flex min-w-0 items-center overflow-x-auto"
            >
              {state.tabs.map((tab, index) => (
                <TabStop key={tab} first={index === 0}>
                  <TabChip
                    tab={tab}
                    title={TABS[tab].title}
                    icon={TABS[tab].icon}
                    active={state.active === tab}
                    onSelect={() => openTab(tab)}
                    onClose={() => closeTab(tab)}
                  />
                </TabStop>
              ))}
              {state.active === "new" && state.tabs.length > 0 && (
                <TabStop first={false}>
                  <TabChip
                    tab="new"
                    title="New tab"
                    icon={<Plus />}
                    active
                    onSelect={showNewTab}
                    onClose={() => openTab(state.tabs.at(-1) ?? "workers")}
                  />
                </TabStop>
              )}
            </div>
            <TitlebarTips>
              <TitlebarButton tooltip="New tab" onClick={showNewTab}>
                <Plus />
              </TitlebarButton>
            </TitlebarTips>
            <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
            <PanelButtonsRoom />
          </header>
          <div className="flex min-h-0 flex-1 flex-col">
            {state.active === "workers" && conversationId ? (
              <WorkersTab conversationId={conversationId} />
            ) : state.active === "review" && conversationId ? (
              <Suspense fallback={null}>
                <ReviewTab conversationId={conversationId} />
              </Suspense>
            ) : state.active === "terminal" && conversationId ? (
              <Suspense fallback={null}>
                <TerminalTab conversationId={conversationId} />
              </Suspense>
            ) : state.active === "browser" && conversationId ? (
              <Suspense fallback={null}>
                <BrowserTab conversationId={conversationId} />
              </Suspense>
            ) : state.active === "sideChat" && conversationId ? (
              <Suspense fallback={null}>
                <SideChatTab conversationId={conversationId} />
              </Suspense>
            ) : state.active === "files" && conversationId ? (
              <Suspense fallback={null}>
                <FilesTab conversationId={conversationId} />
              </Suspense>
            ) : state.active === "source" ? (
              <SourceTab />
            ) : (
              <NewTabPage />
            )}
          </div>
        </aside>
      </div>
      {!full && out && <Splitter />}
    </div>
  );
}

/** A tab in the strip, after a short divider from the one before it. */
function TabStop({ first, children }: { first: boolean; children: ReactNode }) {
  return (
    <>
      {!first && <span aria-hidden className="bg-divider mx-0.5 h-3 w-px shrink-0" />}
      {children}
    </>
  );
}
