import {
  CollapseLg,
  ExpandLg,
  Folders,
  Globe,
  Plus,
  PlusCircle,
  SidebarRight,
  Terminal,
  User,
  X,
} from "@openai/apps-sdk-ui/components/Icon";
import {
  createContext,
  type FC,
  type ReactNode,
  lazy,
  type RefObject,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { type AgentsPanelState, WORKERS_LABEL, WorkersTab } from "@/app/conversation/Agents";
import type { FileTarget } from "@/app/conversation/FilesTab";
import { DiffGlyph } from "@/components/assistant-ui/elements/diff-glyph";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
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
 * ChatGPT's right side panel: a strip of tabs ("Subagents" there, Workers here) with "+" to
 * open another, full screen and the toggle on the right, beside the thread behind a splitter.
 * Toggling it open with no tab shows the tabs this conversation can open.
 */

/** The kinds of tab the side panel opens. */
export type SideTab = "workers" | "review" | "terminal" | "browser" | "files" | "sideChat";

/** Each tab's title, icon and ChatGPT's shortcut (macOS keys; Ctrl for ⌘ elsewhere). */
const TABS: Record<SideTab, { title: string; icon: ReactNode; keys: string | null }> = {
  workers: { title: WORKERS_LABEL, icon: <User />, keys: null },
  review: { title: "Review", icon: <DiffGlyph />, keys: "⌃⇧G" },
  terminal: { title: "Terminal", icon: <Terminal />, keys: "⌃`" },
  browser: { title: "Browser", icon: <Globe />, keys: "⌘T" },
  files: { title: "Files", icon: <Folders />, keys: "⌘P" },
  sideChat: { title: "Side chat", icon: <PlusCircle />, keys: "⌥⌘S" },
};

/** Which tab a key press opens: ChatGPT's ⌃⇧G, ⌃`, ⌘T, ⌘P and ⌥⌘S (Ctrl for ⌘ off macOS). */
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

export type SidePanelApi = {
  state: PanelState;
  /** The file the Files tab shows; null for its tree. */
  file: FileTarget | null;
  /** Shows a file in the Files tab (null: back to the tree). */
  openFile: (file: FileTarget | null) => void;
  /** The tabs this conversation can open (a Chat has only Side chat). */
  available: readonly SideTab[];
  toggle: () => void;
  openTab: (tab: SideTab) => void;
  closeTab: (tab: SideTab) => void;
  showNewTab: () => void;
  setFullscreen: (fullscreen: boolean) => void;
};

export const SidePanelContext = createContext<SidePanelApi>({
  state: CLOSED,
  file: null,
  openFile: () => {},
  available: [],
  toggle: () => {},
  openTab: () => {},
  closeTab: () => {},
  showNewTab: () => {},
  setFullscreen: () => {},
});

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
  const mac = useApp((s) => s.info?.platform === "macos");
  const available = useMemo<SideTab[]>(
    () =>
      kind === "session"
        ? ["workers", "review", "terminal", "browser", "files", "sideChat"]
        : kind === "chat"
          ? ["sideChat"]
          : [],
    [kind],
  );

  const openTab = useCallback((tab: SideTab) => {
    setState((current) => ({
      ...current,
      open: true,
      tabs: current.tabs.includes(tab) ? current.tabs : [...current.tabs, tab],
      active: tab,
    }));
  }, []);
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
  // ChatGPT's tab shortcuts while this conversation is open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tab = tabForKey(event, mac);
      if (!tab || !available.includes(tab)) return;
      event.preventDefault();
      if (tab === "files") setFile(null);
      openTab(tab);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mac, available, openTab]);

  const panel = useMemo<SidePanelApi>(
    () => ({
      state,
      file,
      openFile: (next) => {
        setFile(next);
        openTab("files");
      },
      available,
      toggle: () =>
        setState((current) =>
          current.open ? { ...current, open: false, fullscreen: false } : { ...current, open: true },
        ),
      openTab,
      closeTab,
      showNewTab: () => setState((current) => ({ ...current, open: true, active: "new" })),
      setFullscreen: (fullscreen) => setState((current) => ({ ...current, fullscreen })),
    }),
    [state, file, available, openTab, closeTab],
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

/** The panel's width once the user dragged it, kept while the app runs. */
let draggedWidth: number | null = null;

/** The panel's width: its token until the user drags the splitter. */
function usePanelWidth() {
  const [width, setWidth] = useState(draggedWidth);
  const resize = (next: number) => {
    const min = tokenPx("--spacing-agents");
    const max = Math.max(min, window.innerWidth * 0.6);
    draggedWidth = Math.round(Math.min(max, Math.max(min, next)));
    setWidth(draggedWidth);
  };
  return { width, resize };
}

function Splitter({
  panel,
  onResize,
}: {
  panel: RefObject<HTMLElement | null>;
  onResize: (width: number) => void;
}) {
  const step = tokenPx("--spacing-row");
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize workspace panes"
      tabIndex={0}
      className="hover:bg-border focus-visible:bg-ring absolute inset-y-0 -start-0.5 z-10 w-1 cursor-col-resize transition-colors"
      onPointerDown={(event) => {
        const element = panel.current;
        if (!element) return;
        event.preventDefault();
        const start = event.clientX;
        const from = element.getBoundingClientRect().width;
        const move = (next: PointerEvent) => onResize(from + start - next.clientX);
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onKeyDown={(event) => {
        const width = panel.current?.getBoundingClientRect().width ?? 0;
        if (event.key === "ArrowLeft") onResize(width + step);
        else if (event.key === "ArrowRight") onResize(width - step);
      }}
    />
  );
}

/** The header button that opens and closes the side panel. */
export const SidePanelToggle: FC = () => {
  const { state, toggle } = useContext(SidePanelContext);
  return (
    <TooltipIconButton
      tooltip="Toggle side panel"
      size="icon-md"
      aria-pressed={state.open}
      className={cn(state.open && "bg-muted")}
      onClick={toggle}
    >
      <SidebarRight />
    </TooltipIconButton>
  );
};

function TabChip({
  title,
  icon,
  active,
  onSelect,
  onClose,
}: {
  title: string;
  icon: ReactNode;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      data-slot="side-panel-tab"
      data-active={active || undefined}
      className={cn(
        "rounded-control h-control-md flex min-w-0 items-center gap-1 ps-2 pe-1 text-sm transition-colors",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        className="flex min-w-0 items-center gap-1.5 [&_svg]:size-icon-sm [&_svg]:shrink-0"
      >
        {icon}
        <span className="truncate">{title}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${title} tab`}
        onClick={onClose}
        className="hover:bg-foreground/10 rounded-control size-icon-button-sm ms-2 flex shrink-0 items-center justify-center"
      >
        <X className="size-icon-xs" />
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

/** The side panel of a conversation, when open. */
export function SidePanel({ conversationId }: { conversationId: string | null }) {
  const { state, closeTab, openTab, showNewTab, setFullscreen } = useContext(SidePanelContext);
  const { state: sidebar } = useSidebar();
  const { width, resize } = usePanelWidth();
  const ref = useRef<HTMLElement>(null);
  if (!state.open) return null;
  const { fullscreen } = state;
  return (
    <aside
      ref={ref}
      aria-label="Side panel"
      className={cn(
        "border-border bg-background animate-in fade-in slide-in-from-right-2 relative flex h-full min-w-0 flex-col duration-200 motion-reduce:animate-none",
        fullscreen ? "flex-1" : "shrink-0 border-s",
        // ChatGPT's panel opens at about half the workspace.
        !fullscreen && width === null && "min-w-agents w-1/2",
      )}
      style={!fullscreen && width !== null ? { width } : undefined}
    >
      {!fullscreen && <Splitter panel={ref} onResize={resize} />}
      <header
        data-tauri-drag-region
        className={cn(
          "h-titlebar flex shrink-0 items-center gap-1 px-2",
          fullscreen && sidebar === "collapsed" && "macos:ps-traffic-lights",
        )}
      >
        <div role="tablist" className="flex min-w-0 items-center gap-1">
          {state.tabs.map((tab) => (
            <TabChip
              key={tab}
              title={TABS[tab].title}
              icon={TABS[tab].icon}
              active={state.active === tab}
              onSelect={() => openTab(tab)}
              onClose={() => closeTab(tab)}
            />
          ))}
          {state.active === "new" && state.tabs.length > 0 && (
            <TabChip
              title="New tab"
              icon={<Plus />}
              active
              onSelect={showNewTab}
              onClose={() => openTab(state.tabs.at(-1) ?? "workers")}
            />
          )}
        </div>
        <TooltipIconButton tooltip="Open side panel tab" size="icon-md" onClick={showNewTab}>
          <Plus />
        </TooltipIconButton>
        <div data-tauri-drag-region className="h-full flex-1" />
        <TooltipIconButton
          tooltip={fullscreen ? "Exit full screen" : "Enter full screen"}
          size="icon-md"
          onClick={() => setFullscreen(!fullscreen)}
        >
          {fullscreen ? <CollapseLg /> : <ExpandLg />}
        </TooltipIconButton>
        <SidePanelToggle />
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
        ) : (
          <NewTabPage />
        )}
      </div>
    </aside>
  );
}
