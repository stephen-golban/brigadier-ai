import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Plus,
  ChevronDown,
  Columns2,
  Trash2,
  Maximize2,
  Minimize2,
  X,
  TerminalSquare,
} from "lucide-react";
import { Button } from "./controls/button";
import { Dropdown, Separator } from "./controls/overlay";
import { DropdownContent } from "./controls/menu";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
import {
  workspaceApi,
  errorMessage,
  type WorkspaceContext,
} from "../workspaceApi";
import { workbenchApi } from "../workbenchApi";
import type { ProjectLayout, ProjectTab } from "../workbenchState";
const TerminalView = lazy(() => import("./TerminalView"));
const groupOf = (t: ProjectTab) => t.terminalGroup ?? t.id;

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
        <div
          role="separator"
          aria-label="Resize terminal"
          aria-orientation="horizontal"
          aria-valuemin={120}
          aria-valuemax={Math.round(window.innerHeight * 0.75)}
          aria-valuenow={height}
          tabIndex={0}
          className="layout-resizer absolute top-0 left-0 z-10 h-1 w-full cursor-row-resize touch-none"
          onKeyDown={(e) => {
            if (["ArrowUp", "ArrowDown"].includes(e.key)) {
              e.preventDefault();
              resize(height + (e.key === "ArrowUp" ? 24 : -24));
            }
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            e.currentTarget.dataset.y = String(e.clientY);
            e.currentTarget.dataset.height = String(height);
            setMaximized(false);
            setResizing(true);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              resize(
                Number(e.currentTarget.dataset.height) +
                  Number(e.currentTarget.dataset.y) -
                  e.clientY,
              );
          }}
          onPointerUp={(e) =>
            e.currentTarget.releasePointerCapture(e.pointerId)
          }
          onLostPointerCapture={() => setResizing(false)}
        />
        <div className="flex h-9 shrink-0 items-center gap-1 px-3 text-text-secondary">
          <span className="mr-auto border-b border-text pb-1 text-[11px] font-medium tracking-wide text-text">
            TERMINAL
          </span>
          <Button
            size="icon"
            aria-label="New terminal"
            title="New terminal (⌃⇧`)"
            onClick={(e) => void create(e.altKey)}
          >
            <Plus size={16} />
          </Button>
          <Dropdown native>
            <Button size="icon" aria-label="Terminal profiles">
              <ChevronDown size={14} />
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
            size="icon"
            aria-label="Split terminal"
            title="Split terminal (⌘\\)"
            disabled={!selected}
            onClick={() => void create(true)}
          >
            <Columns2 size={16} />
          </Button>
          <Button
            size="icon"
            aria-label="Kill terminal"
            disabled={!selected}
            onClick={() => void kill()}
          >
            <Trash2 size={16} />
          </Button>
          <Button
            size="icon"
            aria-label={
              maximized ? "Restore terminal size" : "Maximize terminal"
            }
            onClick={() => setMaximized(!maximized)}
          >
            {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </Button>
          <Button size="icon" aria-label="Hide terminal" onClick={toggle}>
            <X size={16} />
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
                    <div
                      role="separator"
                      aria-label="Resize terminal split"
                      aria-orientation="vertical"
                      tabIndex={0}
                      className="layout-resizer absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize touch-none"
                      onKeyDown={(e) => {
                        if (!["ArrowLeft", "ArrowRight"].includes(e.key))
                          return;
                        e.preventDefault();
                        const previous = siblings[siblings.indexOf(tab) - 1];
                        const delta = e.key === "ArrowLeft" ? -0.15 : 0.15;
                        onChange((old) => ({
                          ...old,
                          tabs: old.tabs.map((t) =>
                            t.id === previous.id
                              ? {
                                  ...t,
                                  terminalWeight: Math.max(
                                    0.2,
                                    (t.terminalWeight ?? 1) + delta,
                                  ),
                                }
                              : t.id === tab.id
                                ? {
                                    ...t,
                                    terminalWeight: Math.max(
                                      0.2,
                                      (t.terminalWeight ?? 1) - delta,
                                    ),
                                  }
                                : t,
                          ),
                        }));
                      }}
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        const previous = siblings[siblings.indexOf(tab) - 1];
                        const panes = [
                          ...(dock.current?.querySelectorAll<HTMLElement>(
                            ".terminal-split:not([hidden])",
                          ) ?? []),
                        ];
                        e.currentTarget.dataset.start = String(e.clientX);
                        e.currentTarget.dataset.width = String(
                          panes[siblings.indexOf(tab) - 1].clientWidth +
                            panes[siblings.indexOf(tab)].clientWidth,
                        );
                        e.currentTarget.dataset.before = String(
                          previous.terminalWeight ?? 1,
                        );
                        e.currentTarget.dataset.after = String(
                          tab.terminalWeight ?? 1,
                        );
                      }}
                      onPointerMove={(e) => {
                        if (!e.currentTarget.hasPointerCapture(e.pointerId))
                          return;
                        const previous = siblings[siblings.indexOf(tab) - 1];
                        const { start, width, before, after } =
                          e.currentTarget.dataset;
                        const sum = Number(before) + Number(after);
                        const weight = Math.max(
                          sum * 0.1,
                          Math.min(
                            sum * 0.9,
                            Number(before) +
                              ((e.clientX - Number(start)) / Number(width)) *
                                sum,
                          ),
                        );
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
                      }}
                      onPointerUp={(e) =>
                        e.currentTarget.releasePointerCapture(e.pointerId)
                      }
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
                    role="option"
                    aria-selected={selected?.id === tab.id}
                    className={`min-w-0 flex-1 justify-start text-xs ${selected?.id === tab.id ? "bg-selected" : ""}`}
                    onClick={(e) =>
                      e.altKey
                        ? void create(true, undefined, tab)
                        : activate(tab.id)
                    }
                  >
                    <TerminalSquare size={14} />
                    <span className="truncate">
                      {groups.indexOf(groupOf(tab)) + 1}: {tab.path}
                    </span>
                  </Button>
                  <Dropdown native>
                    <Button size="icon" aria-label={`Actions for ${tab.path}`}>
                      <ChevronDown size={12} />
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
