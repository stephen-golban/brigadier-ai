import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ChevronDown, CollapseSmall, Expand, Plus, SidebarRight, TerminalLg, Trash, X } from "../icons";
import { Button } from "@/components/ui/button";
import { iconButton, labelledButtonIcons } from "@/lib/surfaces";
import { cn } from "@/lib/utils";
import { Dropdown, Separator } from "./controls/overlay";
import { DropdownContent } from "./controls/menu";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
import {
  workspaceApi,
  errorMessage,
  type WorkspaceContext,
} from "../workspaceApi";
import { workbenchApi } from "../workbenchApi";
import { removeTerminalSnapshot, sweepTerminalSnapshots } from "../sessionLocalData";
import { LayoutResizer } from "./LayoutResizer";
import type { ProjectLayout, ProjectTab } from "../workbenchState";
const TerminalView = lazy(() => import("./TerminalView"));
const groupOf = (t: ProjectTab) => t.terminalGroup ?? t.id;
/** The startup sweep runs once per window, not once per dock. */
let swept = false;

/**
 * The divider between two panes of one split. Panes are weighted, not sized, so the drag
 * scale is `sum / measured pane width` and is read once per drag.
 */
function SplitResizer({
  dock,
  siblings,
  tab,
  onChange,
}: {
  dock: RefObject<HTMLElement | null>;
  siblings: ProjectTab[];
  tab: ProjectTab;
  onChange: (update: (old: ProjectLayout) => ProjectLayout) => void;
}) {
  const index = siblings.indexOf(tab);
  const previous = siblings[index - 1];
  const before = previous.terminalWeight ?? 1;
  const sum = before + (tab.terminalWeight ?? 1);
  const setWeight = (next: number) => {
    const weight = Math.max(sum * 0.1, Math.min(sum * 0.9, next));
    onChange((old) => ({
      ...old,
      tabs: old.tabs.map((t) =>
        t.id === previous.id
          ? { ...t, terminalWeight: weight }
          : t.id === tab.id
            ? { ...t, terminalWeight: sum - weight }
            : t,
      ),
    }));
  };
  return (
    <LayoutResizer
      orientation="vertical"
      label="Resize terminal split"
      className="absolute inset-y-0 left-0"
      // A full-width grab strip here would swallow the left edge of the terminal beside it.
      hitSize={8}
      value={before}
      min={sum * 0.1}
      max={sum * 0.9}
      step={0.15}
      perPixel={() => {
        const panes = [
          ...(dock.current?.querySelectorAll<HTMLElement>(
            ".terminal-split:not([hidden])",
          ) ?? []),
        ];
        const width =
          (panes[index - 1]?.clientWidth ?? 0) + (panes[index]?.clientWidth ?? 0);
        return width ? sum / width : 0;
      }}
      onChange={setWeight}
    />
  );
}

/** Docks remain mounted across sidebar navigation; hiding a pane never kills its PTY. */
export function TerminalDock({
  active,
  suspended,
  context,
  layout,
  onChange,
  onReady,
}: {
  active: boolean;
  suspended: boolean;
  context: WorkspaceContext;
  layout: ProjectLayout;
  onChange: (update: (old: ProjectLayout) => ProjectLayout) => void;
  onReady: (tabId: string, id: string | null) => void;
}) {
  const [visited, setVisited] = useState(active);
  const [profiles, setProfiles] = useState<
    { path: string; name: string; default: boolean }[]
  >([]);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const ids = useRef(new Map<string, string>());
  const dock = useRef<HTMLElement>(null);
  const terminals = layout.tabs.filter((t) => t.kind === "terminal");
  const selected =
    terminals.find((t) => t.id === layout.activeTerminal) ?? terminals[0];
  const siblings = terminals.filter(
    (t) => selected && groupOf(t) === groupOf(selected),
  );
  const groups = [...new Set(terminals.map(groupOf))];
  const visible = active && !!layout.terminalOpen && !suspended;
  const height = layout.terminalHeight ?? 260;
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  // Per-tab removal covers a tab closed through the UI; this covers everything the UI never saw —
  // a layout dropped wholesale, a crash between the close and the layout write, and every snapshot
  // orphaned before that removal existed. The in-memory layout's own tab ids are passed in, so a
  // layout that has not been persisted yet cannot have its live terminals swept.
  useEffect(() => {
    if (swept) return;
    swept = true;
    sweepTerminalSnapshots(layout.tabs.map((t) => t.id));
    // The first dock is the only sweep; `layout` is read once, deliberately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!visited) return;
    void workspaceApi
      .terminalProfiles()
      .then(setProfiles)
      .catch((e) => setError(errorMessage(e)));
  }, [visited]);
  const activate = (id: string) => {
    onChange((old) => ({ ...old, activeTerminal: id, terminalOpen: true }));
    setFocusRequest((n) => n + 1);
  };
  const create = async (split = false, shell?: string, source = selected) => {
    try {
      let cwd: string | undefined;
      if (split && source) {
        const id = ids.current.get(source.id);
        if (id) cwd = (await workbenchApi.terminalInfo(id)).cwd;
      }
      const id = crypto.randomUUID();
      const profile =
        shell ??
        (split ? source?.shell : undefined) ??
        profiles.find((p) => p.default)?.path;
      const tab: ProjectTab = {
        id,
        kind: "terminal",
        path: profile?.split("/").pop() ?? "Terminal",
        context,
        root: "",
        shell: profile,
        terminalCwd: cwd,
        terminalGroup: split && source ? groupOf(source) : id,
      };
      onChange((old) => ({
        ...old,
        tabs: [...old.tabs, tab],
        activeTerminal: id,
        terminalOpen: true,
      }));
      setFocusRequest((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const toggle = () => {
    if (!terminals.length) void create();
    else {
      onChange((old) => ({ ...old, terminalOpen: !old.terminalOpen }));
      setFocusRequest((n) => n + 1);
    }
  };
  const kill = async (tab = selected) => {
    if (!tab) return;
    const remove = async () => {
      const id = ids.current.get(tab.id);
      if (id) await workspaceApi.closeTerminal(id);
      // The scrollback snapshot dies with the tab. Nothing else ever removes it: a tab id is a
      // `crypto.randomUUID()` minted per terminal and never reused, so the key would be orphaned
      // for good (`docs/research/lifecycle-bounds-audit-2026-09-11.md` §1.6, Gap 3).
      removeTerminalSnapshot(tab.id);
      onChange((old) => {
        const tabs = old.tabs.filter((t) => t.id !== tab.id);
        const remaining = tabs.filter((t) => t.kind === "terminal");
        return {
          ...old,
          tabs,
          activeTerminal:
            remaining.find((t) => groupOf(t) === groupOf(tab))?.id ??
            remaining[0]?.id,
          terminalOpen: remaining.length > 0,
        };
      });
      setConfirm(null);
    };
    try {
      const id = ids.current.get(tab.id);
      if (id && (await workbenchApi.terminalInfo(id)).busy)
        setConfirm({
          title: "Kill running terminal?",
          body: "This will stop the command running in this terminal.",
          confirmLabel: "Kill terminal",
          native: true,
          onCancel: () => setConfirm(null),
          onConfirm: remove,
        });
      else await remove();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const latest = useRef({
    create,
    toggle,
    kill,
    activate,
    selected,
    groups,
    terminals,
    visible,
  });
  latest.current = {
    create,
    toggle,
    kill,
    activate,
    selected,
    groups,
    terminals,
    visible,
  };
  useEffect(() => {
    if (!active || suspended) return;
    const modal = () =>
      !!document.querySelector(
        'dialog[open], [role="dialog"], .settings-overlay',
      );
    const newTerminal = () => {
      if (!modal()) void latest.current.create();
    };
    const toggleTerminal = () => {
      if (!modal()) latest.current.toggle();
    };
    const splitTerminal = () => {
      if (!modal()) void latest.current.create(true);
    };
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || modal()) return;
      const mac = navigator.platform.startsWith("Mac");
      const command = mac ? e.metaKey : e.ctrlKey;
      const inside =
        e.target instanceof Node && !!dock.current?.contains(e.target);
      const state = latest.current;
      let action: (() => void) | undefined;
      if (e.ctrlKey && e.code === "Backquote" && !e.altKey && !e.metaKey)
        action = () => (e.shiftKey ? void state.create() : state.toggle());
      else if (inside && command && e.code === "KeyJ" && !e.shiftKey)
        action = state.toggle;
      else if (
        inside &&
        (mac
          ? e.metaKey && e.code === "Backslash"
          : e.ctrlKey && e.shiftKey && e.code === "Digit5")
      )
        action = () => void state.create(true);
      else if (
        inside &&
        (mac
          ? command &&
            e.shiftKey &&
            ["BracketLeft", "BracketRight"].includes(e.code)
          : e.ctrlKey && ["PageUp", "PageDown"].includes(e.code))
      ) {
        const direction = ["BracketLeft", "PageUp"].includes(e.code) ? -1 : 1;
        const index = state.selected
          ? state.groups.indexOf(groupOf(state.selected))
          : 0;
        const group =
          state.groups[
            (index + direction + state.groups.length) % state.groups.length
          ];
        const tab = state.terminals.find((t) => groupOf(t) === group);
        if (tab) action = () => state.activate(tab.id);
      } else if (
        inside &&
        e.altKey &&
        (!mac || command) &&
        ["ArrowLeft", "ArrowRight"].includes(e.code)
      ) {
        const siblings = state.terminals.filter(
          (t) => state.selected && groupOf(t) === groupOf(state.selected),
        );
        const index = siblings.findIndex((t) => t.id === state.selected?.id);
        const tab =
          siblings[
            (index + (e.code === "ArrowLeft" ? -1 : 1) + siblings.length) %
              siblings.length
          ];
        if (tab) action = () => state.activate(tab.id);
      } else if (
        inside &&
        ["Delete", "Backspace"].includes(e.key) &&
        (e.target as HTMLElement).closest(".terminal-list")
      )
        action = () => void state.kill();
      if (action) {
        e.preventDefault();
        e.stopImmediatePropagation();
        action();
      }
    };
    window.addEventListener("workbench-terminal-create", newTerminal);
    window.addEventListener("workbench-terminal-toggle", toggleTerminal);
    window.addEventListener("workbench-terminal-split", splitTerminal);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("workbench-terminal-create", newTerminal);
      window.removeEventListener("workbench-terminal-toggle", toggleTerminal);
      window.removeEventListener("workbench-terminal-split", splitTerminal);
      window.removeEventListener("keydown", key, true);
    };
  }, [active, suspended]);
  const resize = (next: number) =>
    onChange((old) => ({
      ...old,
      terminalHeight: Math.max(120, Math.min(window.innerHeight * 0.75, next)),
    }));
  return (
    <section
      ref={dock}
      aria-label="Terminal panel"
      className="terminal-dock relative shrink-0 bg-canvas"
      hidden={!active || suspended}
      data-open={visible}
      data-resizing={resizing}
      aria-hidden={!visible}
      inert={!visible}
      style={{
        height: visible ? (maximized ? "75%" : height) : 0,
        maxHeight: "75%",
      }}
    >
      <div className="terminal-dock-content flex h-full min-h-0 flex-col border-t border-hairline">
        <LayoutResizer
          orientation="horizontal"
          label="Resize terminal"
          className="absolute top-0 left-0 w-full"
          value={height}
          min={120}
          max={Math.round(window.innerHeight * 0.75)}
          /* The dock is anchored to the bottom, so it grows as the pointer moves up. */
          invert
          onChange={resize}
          onResizeStart={() => {
            setMaximized(false);
            setResizing(true);
          }}
          onResizeEnd={() => setResizing(false)}
        />
        <div className="flex h-9 shrink-0 items-center gap-1 px-3 text-text-secondary">
          <span className="mr-auto border-b border-text pb-1 text-[11px] font-medium tracking-wide text-text">
            TERMINAL
          </span>
          <Button
            variant="ghost"
            size="icon"
            className={iconButton}
            aria-label="New terminal"
            title="New terminal (⌃⇧`)"
            onClick={(e) => void create(e.altKey)}
          >
            <Plus width={16} height={16} />
          </Button>
          <Dropdown native>
            <Button variant="ghost" size="icon" className={iconButton} aria-label="Terminal profiles">
              <ChevronDown width={14} height={14} />
            </Button>
            <DropdownContent align="end">
              {profiles.map((profile) => (
                <Dropdown.Item
                  key={profile.path}
                  onAction={() => void create(false, profile.path)}
                >
                  {profile.name}
                  {profile.default ? " (default)" : ""}
                </Dropdown.Item>
              ))}
              {!profiles.length && (
                <Dropdown.Item onAction={() => void create()}>
                  Default shell
                </Dropdown.Item>
              )}
            </DropdownContent>
          </Dropdown>
          <Button
            variant="ghost"
            size="icon"
            className={iconButton}
            aria-label="Split terminal"
            title="Split terminal (⌘\\)"
            disabled={!selected}
            onClick={() => void create(true)}
          >
            <SidebarRight width={16} height={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={iconButton}
            aria-label="Kill terminal"
            disabled={!selected}
            onClick={() => void kill()}
          >
            <Trash width={16} height={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={iconButton}
            aria-label={
              maximized ? "Restore terminal size" : "Maximize terminal"
            }
            onClick={() => setMaximized(!maximized)}
          >
            {/*
              `Collapse` is not `Expand`'s mirror upstream: `Expand` is two corner brackets,
              `Collapse` two opposing chevrons. `CollapseSmall`'s path is the true mirror —
              the same brackets moved to the outer corners, pointing in — and `Expand`'s path
              is byte-identical to `ExpandSmall`'s, so this is upstream's own pair reached
              under the shorter alias. [measured, path data in node_modules]
            */}
            {maximized ? <CollapseSmall width={16} height={16} /> : <Expand width={16} height={16} />}
          </Button>
          <Button variant="ghost" size="icon" className={iconButton} aria-label="Hide terminal" onClick={toggle}>
            <X width={16} height={16} />
          </Button>
        </div>
        {error && (
          <p role="alert" className="px-3 text-sm text-error">
            {error}
          </p>
        )}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 overflow-auto">
            {visited &&
              !suspended &&
              terminals.map((tab) => (
                <div
                  key={tab.id}
                  className="terminal-split relative min-w-0 border-r border-hairline p-2"
                  style={{ flex: `${tab.terminalWeight ?? 1} 1 0` }}
                  hidden={!!selected && groupOf(tab) !== groupOf(selected)}
                  onFocusCapture={() => {
                    if (selected?.id !== tab.id)
                      onChange((old) => ({ ...old, activeTerminal: tab.id }));
                  }}
                >
                  {siblings.indexOf(tab) > 0 && (
                    <SplitResizer
                      dock={dock}
                      siblings={siblings}
                      tab={tab}
                      onChange={onChange}
                    />
                  )}
                  <Suspense
                    fallback={
                      <p className="text-sm text-text-secondary">
                        Loading terminal…
                      </p>
                    }
                  >
                    <TerminalView
                      context={tab.context}
                      tabId={tab.id}
                      shell={tab.shell}
                      cwd={tab.terminalCwd}
                      visible={
                        visible &&
                        !!selected &&
                        groupOf(tab) === groupOf(selected)
                      }
                      focused={visible && tab.id === selected?.id}
                      focusRequest={focusRequest}
                      onReady={(id) => {
                        if (id) ids.current.set(tab.id, id);
                        else ids.current.delete(tab.id);
                        onReady(tab.id, id);
                      }}
                    />
                  </Suspense>
                </div>
              ))}
          </div>
          {terminals.length > 1 && (
            <div
              className="terminal-list w-40 shrink-0 overflow-auto border-l border-hairline"
              role="listbox"
              aria-label="Terminals"
            >
              {terminals.map((tab) => (
                <div
                  key={tab.id}
                  className="flex items-center gap-1 px-1"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    activate(tab.id);
                    e.currentTarget
                      .querySelector<HTMLButtonElement>(
                        '[aria-haspopup="menu"]',
                      )
                      ?.click();
                  }}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    role="option"
                    aria-selected={selected?.id === tab.id}
                    className={cn(
                      labelledButtonIcons,
                      `min-w-0 flex-1 justify-start text-xs ${selected?.id === tab.id ? "bg-selected" : ""}`,
                    )}
                    onClick={(e) =>
                      e.altKey
                        ? void create(true, undefined, tab)
                        : activate(tab.id)
                    }
                  >
                    <TerminalLg width={14} height={14} />
                    <span className="truncate">
                      {groups.indexOf(groupOf(tab)) + 1}: {tab.path}
                    </span>
                  </Button>
                  <Dropdown native>
                    <Button variant="ghost" size="icon" className={iconButton} aria-label={`Actions for ${tab.path}`}>
                      <ChevronDown width={12} height={12} />
                    </Button>
                    <DropdownContent align="end">
                      <Dropdown.Item
                        onAction={() => {
                          activate(tab.id);
                          void create(true, undefined, tab);
                        }}
                      >
                        Split
                      </Dropdown.Item>
                      <Dropdown.Item
                        onAction={() =>
                          onChange((old) => ({
                            ...old,
                            tabs: old.tabs.map((t) =>
                              t.id === tab.id
                                ? {
                                    ...t,
                                    terminalGroup: `group:${crypto.randomUUID()}`,
                                    terminalWeight: 1,
                                  }
                                : t,
                            ),
                            activeTerminal: tab.id,
                          }))
                        }
                      >
                        Unsplit
                      </Dropdown.Item>
                      <Separator />
                      <Dropdown.Item onAction={() => void kill(tab)}>
                        Kill terminal
                      </Dropdown.Item>
                    </DropdownContent>
                  </Dropdown>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {confirm && <ConfirmDialog {...confirm} />}
    </section>
  );
}
