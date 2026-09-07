import { isTrashed, type NavigationData } from "../navigationApi";
import { hasSavedEdits } from "../workbenchState";
import { SessionCard } from "./SessionCard";
import { ProjectHistory } from "./ProjectHistory";
import { documentCommands } from "../documentCommands";
import { documentKey } from "../workbenchState";
import { working } from "../attention";
import {
  SidebarSimpleIcon,
  FolderIcon,
  MagnifyingGlassIcon,
  ClockCounterClockwiseIcon,
} from "@phosphor-icons/react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  PlusIcon,
  XIcon,
  TerminalIcon,
  FileIcon,
  ChatCircleIcon,
  NotebookIcon,
  GitDiffIcon,
} from "@phosphor-icons/react";
import type { ProjectView, SessionId, ModelInfo } from "../wire";
import type { SessionRuntime } from "../feedStore";
import { SessionPreferences } from "./SessionPreferences";
import { NoteScope } from "../noteScope";
import { peerApi, type PeerData } from "../peerApi";
import { workspaceApi, errorMessage, type GitStatus } from "../workspaceApi";
import {
  workbenchApi,
  defaultSettings,
  type WorkbenchData,
  type Note,
} from "../workbenchApi";
import {
  useStoredState,
  type ProjectTab,
  type ProjectLayout,
} from "../workbenchState";
import { WorkspaceTools, type WorkspaceMode } from "./WorkspaceTools";
import { DocumentTab } from "./DocumentTab";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
const TerminalView = lazy(() => import("./TerminalView"));
const empty: ProjectLayout = { tabs: [], active: null };
const initial: WorkbenchData = {
  notes: [],
  global: { ...defaultSettings },
  projects: {},
};
export function ProjectWorkbench({
  peers,
  project,
  session,
  sessions,
  selectedSessionId,
  onSelectSession,
  workspaceOpen,
  setWorkspaceOpen,
  models,
  children,
  historyContent,
  attention = {},
  sidebarToggle,
  newSessionRequest,
  navigation,
}: {
  peers: PeerData;
  project: ProjectView | null;
  session: SessionRuntime | null;
  sessions: Record<string, SessionRuntime>;
  selectedSessionId: string | null;
  onSelectSession: (id: SessionId | null) => void;
  workspaceOpen: boolean;
  setWorkspaceOpen: (open: boolean) => void;
  models: ModelInfo[];
  children: ReactNode;
  historyContent?: ReactNode;
  attention?: Record<string, boolean>;
  sidebarToggle?: ReactNode;
  newSessionRequest?: { projectId: string; token: number } | null;
  navigation?: NavigationData;
}) {
  const [sessionPrefs, setSessionPrefs] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [layouts, setLayouts] = useStoredState<Record<string, ProjectLayout>>(
    "brigadier:project-tabs:v1",
    {},
  );
  // Sidebar deletion is separate from closing a tab. Retire persisted workspace tabs only
  // after deletion succeeds, so removed sessions cannot reopen through saved layouts.
  useEffect(() => {
    const deleted = (event: Event) => {
      const { projectId, sessionId } = (
        event as CustomEvent<{
          projectId?: string;
          sessionId?: string;
        }>
      ).detail;
      if (sessionId)
        closedTabs.current = closedTabs.current.filter(
          (t) => t.context.sessionId !== sessionId && t.path !== sessionId,
        );
      setLayouts((old) =>
        Object.fromEntries(
          Object.entries(old)
            .filter(([id]) => id !== projectId)
            .map(([id, layout]) => {
              for (const tab of layout.tabs)
                if (
                  tab.kind !== "note" &&
                  tab.kind !== "untitled" &&
                  (projectId === id ||
                    tab.context.sessionId === sessionId ||
                    (tab.kind === "session" && tab.path === sessionId))
                )
                  localStorage.removeItem(documentKey(tab));
              const tabs = layout.tabs.filter(
                (tab) =>
                  !sessionId ||
                  tab.kind === "note" ||
                  tab.kind === "untitled" ||
                  (tab.context.sessionId !== sessionId &&
                    !(tab.kind === "session" && tab.path === sessionId)),
              );
              return [
                id,
                {
                  tabs,
                  active: tabs.some((tab) => tab.id === layout.active)
                    ? layout.active
                    : (tabs[tabs.length - 1]?.id ?? null),
                },
              ];
            }),
        ),
      );
    };
    window.addEventListener("workbench-history-deleted", deleted);
    return () =>
      window.removeEventListener("workbench-history-deleted", deleted);
  }, [setLayouts]);
  const [data, setData] = useState<WorkbenchData>(initial);
  const [mode, setMode] = useStoredState<WorkspaceMode>(
    "brigadier:workspace-mode",
    "files",
  );
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const restored = () => setRevision((n) => n + 1);
    window.addEventListener("workbench-files-restored", restored);
    return () =>
      window.removeEventListener("workbench-files-restored", restored);
  }, []);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [history, setHistory] = useState(false);
  const [, setDocumentRevision] = useState(0);
  const closedTabs = useRef<ProjectTab[]>([]);
  const closeAfterSaveAs = useRef<string | null>(null);
  useEffect(() => {
    const cancel = () => {
      closeAfterSaveAs.current = null;
    };
    window.addEventListener("workbench-save-as-cancelled", cancel);
    return () =>
      window.removeEventListener("workbench-save-as-cancelled", cancel);
  }, []);
  useEffect(() => {
    setHistory(false);
  }, [project?.id]);
  const terminalIds = useRef(new Map<string, string>());
  const menuRef = useRef<HTMLDivElement>(null);
  const layoutKey = project?.id ?? "__notes__";
  const storedLayout = layouts[layoutKey] ?? empty;
  const visibleTabs = storedLayout.tabs.filter(
    (t) =>
      !navigation ||
      (!(t.kind === "session" && isTrashed(navigation, "session", t.path)) &&
        !(
          t.kind === "terminal" &&
          isTrashed(navigation, "session", t.context.sessionId)
        ) &&
        !(
          t.kind === "note" &&
          isTrashed(navigation, "note", t.id.replace(/^note:/, ""))
        )),
  );
  const layout = {
    ...storedLayout,
    tabs: visibleTabs,
    active: visibleTabs.some((t) => t.id === storedLayout.active)
      ? storedLayout.active
      : (visibleTabs[visibleTabs.length - 1]?.id ?? null),
  };
  const selected = layout.tabs.find((t) => t.id === layout.active);
  useEffect(() => {
    if (!project) return;
    const saved = layouts[project.id];
    const t = saved?.tabs.find((t) => t.id === saved.active);
    if (!selectedSessionId && t?.kind === "session" && sessions[t.path])
      onSelectSession(t.path);
  }, [project?.id]);
  const activeSession = session?.projectId === project?.id ? session : null;
  const context =
    selected && selected.kind !== "session"
      ? selected.context
      : {
          projectId: project?.id ?? "",
          sessionId: activeSession?.sessionId ?? null,
        };
  const root =
    selected && selected.kind !== "session"
      ? selected.root
      : (activeSession?.cwd ?? project?.root_path ?? "");
  const refresh = () => setRevision((n) => n + 1);
  const setNote = (note: Note) => {
    setLayouts((old) =>
      Object.fromEntries(
        Object.entries(old).map(([id, l]) => [
          id,
          {
            ...l,
            tabs: l.tabs.map((t) =>
              t.id === `note:${note.id}` ? { ...t, path: note.title } : t,
            ),
          },
        ]),
      ),
    );
    setData((d) => ({
      ...d,
      notes: [...d.notes.filter((n) => n.id !== note.id), note],
    }));
  };
  const loadData = useCallback(() => {
    void workbenchApi
      .load()
      .then((d) => {
        setData(d);
        setDataLoaded(true);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    loadData();
    const timer = setInterval(loadData, 3000);
    window.addEventListener("workbench-data-changed", loadData);
    const failure = () =>
      setError(
        "Local storage is full. Keep unsaved tabs open and save their contents.",
      );
    window.addEventListener("brigadier-storage-error", failure);
    return () => {
      clearInterval(timer);
      window.removeEventListener("workbench-data-changed", loadData);
      window.removeEventListener("brigadier-storage-error", failure);
    };
  }, [loadData]);
  useEffect(() => {
    if (
      !project ||
      !selectedSessionId ||
      sessions[selectedSessionId]?.projectId !== project.id
    )
      return;
    const s = sessions[selectedSessionId]!;
    setLayouts((old) => {
      const l = old[project.id] ?? empty;
      const id = `session:${selectedSessionId}`;
      return {
        ...old,
        [project.id]: {
          tabs: l.tabs.some((t) => t.id === id)
            ? l.tabs
            : [
                ...l.tabs.filter((t) => t.kind !== "draft"),
                {
                  id,
                  kind: "session",
                  path: selectedSessionId,
                  context: {
                    projectId: project.id,
                    sessionId: selectedSessionId,
                  },
                  root: s.cwd ?? project.root_path,
                },
              ],
          active: id,
        },
      };
    });
  }, [selectedSessionId, project?.id]);
  // Keep the last status visible while refreshing the same workspace.
  useEffect(() => {
    setStatus(null);
  }, [context.projectId, context.sessionId]);
  useEffect(() => {
    if (!context.projectId) return;
    let live = true;
    void workspaceApi
      .git(context)
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [context.projectId, context.sessionId, revision]);
  useEffect(() => {
    if (!project) return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [project?.id]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (project && sessions[id]?.projectId === project.id)
        setLayouts((old) => {
          const l = old[project.id] ?? empty;
          return l.tabs.some((t) => t.id === `session:${id}`)
            ? { ...old, [project.id]: { ...l, active: `session:${id}` } }
            : old;
        });
    };
    window.addEventListener("workbench-select-session", handler);
    return () =>
      window.removeEventListener("workbench-select-session", handler);
  }, [project?.id, sessions]);
  const open = useCallback(
    (
      path: string,
      kind: "file" | "diff" = "file",
      staged = false,
      line?: number,
    ) => {
      if (!project) return;
      const suffix = path.match(/(?:#L|:)(\d+)(?::\d+)?$/);
      const cleaned = path
        .replace(/#L\d+(?:-L\d+)?$/, "")
        .replace(/:\d+(?::\d+)?$/, "");
      const relative = cleaned.startsWith(root + "/")
        ? cleaned.slice(root.length + 1)
        : cleaned.replace(/^\.\//, "");
      const id = `${kind}:${context.sessionId ?? "root"}:${staged}:${relative}`;
      const tab: ProjectTab = {
        id,
        kind,
        path: relative,
        context,
        root,
        staged,
        line: line ?? (suffix ? Number(suffix[1]) : undefined),
      };
      setLayouts((old) => {
        const l = old[project.id] ?? empty;
        return {
          ...old,
          [project.id]: {
            tabs: l.tabs.some((t) => t.id === id)
              ? l.tabs.map((t) => (t.id === id ? { ...t, line: tab.line } : t))
              : [...l.tabs, tab],
            active: id,
          },
        };
      });
    },
    [project?.id, context.sessionId, root, setLayouts],
  );
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string }>).detail;
      if (detail?.path?.startsWith("brigadier-note:")) {
        const note = data.notes.find((n) => n.id === detail.path.slice(15));
        if (note) openNote(note);
      } else if (detail?.path) open(detail.path);
    };
    window.addEventListener("workbench-open-file", handler);
    return () => window.removeEventListener("workbench-open-file", handler);
  }, [open, data.notes]);
  useEffect(() => {
    const review = (e: Event) => {
      setReviewTurn((e as CustomEvent).detail?.turn ?? null);
      setMode("changes");
      setWorkspaceOpen(true);
    };
    const diff = (e: Event) => {
      const { sessionId, path, turn } = (
        e as CustomEvent<{
          sessionId: string;
          path: string;
          turn: string | null;
        }>
      ).detail;
      const source = sessions[sessionId];
      if (!source?.projectId) return;
      add({
        id: `recorded:${sessionId}:${turn ?? "all"}:${path}`,
        kind: "diff",
        recorded: true,
        path,
        turn,
        context: { projectId: source.projectId, sessionId },
        root: source.cwd ?? "",
      });
    };
    window.addEventListener("workbench-review", review);
    window.addEventListener("workbench-recorded-diff", diff);
    return () => {
      window.removeEventListener("workbench-review", review);
      window.removeEventListener("workbench-recorded-diff", diff);
    };
  }, [sessions, project?.id]);
  const add = (tab: ProjectTab) => {
    setHistory(false);
    setLayouts((old) => {
      const l = old[layoutKey] ?? empty;
      return {
        ...old,
        [layoutKey]: {
          tabs: l.tabs.some((t) => t.id === tab.id) ? l.tabs : [...l.tabs, tab],
          active: tab.id,
        },
      };
    });
    setMenu(false);
  };
  const openNote = (note: Note) =>
    add({
      id: `note:${note.id}`,
      kind: "note",
      path: note.title || "Untitled note",
      context,
      root,
    });
  const create = (kind: "session" | "terminal" | "untitled" | "note") => {
    if (!project) return;
    setMenu(false);
    if (kind === "session") {
      onSelectSession(null);
      add({
        id: `draft:${project.id}`,
        kind: "draft",
        path: "New session",
        context: { projectId: project.id, sessionId: null },
        root: project.root_path,
      });
      setTimeout(
        () => window.dispatchEvent(new Event("brigadier-new-session")),
        0,
      );
      return;
    }
    if (kind === "note") {
      const note: Note = {
        id: crypto.randomUUID(),
        projectId: null,
        title: "Untitled note",
        content: "",
        language: "markdown",
        alwaysInclude: false,
        revision: 0,
      };
      void workbenchApi
        .saveNote(note)
        .then((n) => {
          setNote(n);
          openNote(n);
        })
        .catch((e) => setError(errorMessage(e)));
      return;
    }
    add({
      id: crypto.randomUUID(),
      kind,
      path:
        kind === "terminal"
          ? `Terminal ${layout.tabs.filter((t) => t.kind === "terminal").length + 1}`
          : "Untitled",
      context,
      root,
    });
  };
  const select = (t: ProjectTab) => {
    setHistory(false);
    setLayouts((old) => ({
      ...old,
      [layoutKey]: { ...(old[layoutKey] ?? empty), active: t.id },
    }));
    if (t.kind === "session") onSelectSession(t.path);
    else if (t.kind === "draft") onSelectSession(null);
  };
  const remove = (tab: ProjectTab) => {
    const id = tab.context.projectId || "__notes__";
    const l = layouts[id] ?? empty;
    const index = l.tabs.findIndex((t) => t.id === tab.id);
    const tabs = l.tabs.filter((t) => t.id !== tab.id);
    const next = tabs[Math.min(index, tabs.length - 1)];
    const active = l.active === tab.id ? (next?.id ?? null) : l.active;
    if (tab.kind === "session" && selectedSessionId === tab.path)
      onSelectSession(next?.kind === "session" ? next.path : null);
    setLayouts((old) => ({ ...old, [id]: { tabs, active } }));
  };
  const close = async (tab: ProjectTab) => {
    if (tab.kind === "terminal") {
      const id = terminalIds.current.get(tab.id);
      if (id) {
        try {
          const info = await workbenchApi.terminalInfo(id);
          if (info.busy) {
            setConfirm({
              title: "Close running terminal?",
              body: "Closing this terminal will stop its running command.",
              confirmLabel: "Stop and close",
              onCancel: () => setConfirm(null),
              onConfirm: async () => {
                await workspaceApi.closeTerminal(id);
                remove(tab);
                setConfirm(null);
              },
            });
            return;
          }
        } catch (e) {
          setError(errorMessage(e));
          return;
        }
      }
    }
    const dirty =
      documentCommands.get(tab.id)?.dirty ??
      (() => {
        try {
          const b = JSON.parse(
            localStorage.getItem(documentKey(tab)) ?? "null",
          );
          return b && b.content !== (b.before ?? "");
        } catch {
          return false;
        }
      })();
    if (dirty && ["file", "note", "untitled"].includes(tab.kind)) {
      select(tab);
      setConfirm({
        title: "Save changes before closing?",
        body: tab.path,
        confirmLabel: "Save",
        secondaryLabel: "Discard",
        onSecondary: () => {
          localStorage.removeItem(documentKey(tab));
          remove(tab);
          setConfirm(null);
        },
        onCancel: () => setConfirm(null),
        onConfirm: async () => {
          if (tab.kind === "untitled") {
            closeAfterSaveAs.current = tab.id;
            setConfirm(null);
            await documentCommands.get(tab.id)?.save();
            return;
          }
          const saved = await documentCommands.get(tab.id)?.save();
          if (!saved)
            throw new Error(
              "The file could not be saved. Cancel to review it.",
            );
          remove(tab);
          setConfirm(null);
        },
      });
      return;
    }
    closedTabs.current = [
      ...closedTabs.current.filter((t) => t.id !== tab.id),
      tab,
    ].slice(-20);
    remove(tab);
  };
  const attach = (path: string, content: string) => {
    const threadTab =
      layout.tabs.find(
        (t) => t.kind === "session" && t.path === selectedSessionId,
      ) ?? layout.tabs.find((t) => t.kind === "session");
    if (threadTab) select(threadTab);
    else if (project)
      setLayouts((old) => ({
        ...old,
        [project.id]: { ...(old[project.id] ?? empty), active: null },
      }));
    setTimeout(
      () =>
        window.dispatchEvent(
          new CustomEvent("brigadier-attach", { detail: { path, content } }),
        ),
      0,
    );
  };
  useEffect(() => {
    const mention = (e: Event) => {
      const note = (e as CustomEvent<Note>).detail;
      const threadTab =
        layout.tabs.find(
          (t) => t.kind === "session" && t.path === selectedSessionId,
        ) ?? layout.tabs.find((t) => t.kind === "session");
      if (threadTab) select(threadTab);
      else if (project)
        setLayouts((old) => ({
          ...old,
          [project.id]: { ...(old[project.id] ?? empty), active: null },
        }));
      setTimeout(
        () =>
          window.dispatchEvent(
            new CustomEvent("brigadier-insert-note", { detail: note }),
          ),
        0,
      );
    };
    window.addEventListener("brigadier-mention-note", mention);
    return () => window.removeEventListener("brigadier-mention-note", mention);
  }, [layout, selectedSessionId, project?.id]);
  const processedClosed = useRef(
    Number(localStorage.getItem("brigadier:peer-close-cursor")) || 0,
  );
  useEffect(() => {
    if (!peers.closed.length) return;
    const closed = peers.closed.slice(
      processedClosed.current > peers.closed.length
        ? 0
        : processedClosed.current,
    );
    if (!closed.length) return;
    processedClosed.current = peers.closed.length;
    localStorage.setItem(
      "brigadier:peer-close-cursor",
      String(processedClosed.current),
    );
    if (selectedSessionId && closed.includes(selectedSessionId))
      onSelectSession(null);
    setLayouts((old) =>
      Object.fromEntries(
        Object.entries(old).map(([id, l]) => {
          const tabs = l.tabs.filter(
            (t) => t.kind !== "session" || !closed.includes(t.path),
          );
          return [
            id,
            {
              tabs,
              active: tabs.some((t) => t.id === l.active)
                ? l.active
                : (tabs[tabs.length - 1]?.id ?? null),
            },
          ];
        }),
      ),
    );
  }, [peers.closed]);
  const pendingRequest = peers.requests.find(
    (r) => !r.resolved && r.to === selectedSessionId,
  );
  const [deciding, setDeciding] = useState(false);
  const decide = async (allow: boolean) => {
    if (!pendingRequest) return;
    setDeciding(true);
    try {
      await peerApi.decide(pendingRequest.id, allow);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeciding(false);
    }
  };
  const [reviewTurn, setReviewTurn] = useState<string | null>(null);
  const showHistory = !!project && (history || layout.tabs.length === 0);
  const showConversation =
    !showHistory &&
    (!selected || selected.kind === "session" || selected.kind === "draft");
  useEffect(() => {
    const newSession = () => create("session");
    const note = (e: Event) => {
      const n = (e as CustomEvent<Note>).detail;
      setNote(n);
      openNote(n);
    };
    const removed = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      closedTabs.current = closedTabs.current.filter(
        (t) => t.id !== `note:${id}`,
      );
      localStorage.removeItem(`brigadier:buffer:note:${id}`);
      documentCommands.delete(`note:${id}`);
      setLayouts((old) =>
        Object.fromEntries(
          Object.entries(old).map(([key, l]) => {
            const tabs = l.tabs.filter((t) => t.id !== `note:${id}`);
            return [
              key,
              {
                tabs,
                active: tabs.some((t) => t.id === l.active)
                  ? l.active
                  : (tabs[tabs.length - 1]?.id ?? null),
              },
            ];
          }),
        ),
      );
    };
    const documentState = () => setDocumentRevision((n) => n + 1);
    const key = (e: KeyboardEvent) => {
      if (
        document.querySelector(
          'dialog[open], [role="dialog"], .settings-overlay',
        )
      )
        return;
      const command =
        e.metaKey || (!navigator.platform.includes("Mac") && e.ctrlKey);
      const cycle =
        (e.ctrlKey && e.key === "Tab") ||
        (command &&
          e.shiftKey &&
          (e.code === "BracketLeft" || e.code === "BracketRight"));
      if (cycle) {
        e.preventDefault();
        const direction =
          e.key === "Tab"
            ? e.shiftKey
              ? -1
              : 1
            : e.code === "BracketLeft"
              ? -1
              : 1;
        const at = layout.tabs.findIndex((t) => t.id === layout.active);
        const next =
          layout.tabs[
            (at + direction + layout.tabs.length) % layout.tabs.length
          ];
        if (next) select(next);
        return;
      }
      if (!command || e.altKey) return;
      if (e.key === ",") {
        e.preventDefault();
        window.dispatchEvent(new Event("brigadier-settings"));
      } else if (e.key.toLowerCase() === "t") {
        e.preventDefault();
        if (e.shiftKey) {
          const previous = closedTabs.current.pop();
          if (
            previous &&
            (!previous.context.sessionId ||
              sessions[previous.context.sessionId])
          ) {
            add(previous);
            if (previous.kind === "session") onSelectSession(previous.path);
          }
        } else create("session");
      } else if (e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (selected) void close(selected);
      } else if (e.key.toLowerCase() === "o") {
        e.preventDefault();
        setOpenPath("");
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const tab =
          e.key === "9"
            ? layout.tabs[layout.tabs.length - 1]
            : layout.tabs[Number(e.key) - 1];
        if (tab) select(tab);
      }
    };
    window.addEventListener("workbench-new-session", newSession);
    window.addEventListener("workbench-open-note", note);
    window.addEventListener("workbench-note-deleted", removed);
    window.addEventListener("workbench-document-state", documentState);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("workbench-new-session", newSession);
      window.removeEventListener("workbench-open-note", note);
      window.removeEventListener("workbench-note-deleted", removed);
      window.removeEventListener("workbench-document-state", documentState);
      window.removeEventListener("keydown", key);
    };
  }, [layout, project?.id, selectedSessionId, sessions, data]);
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("workbench-active-session", {
        detail:
          showConversation && selected?.kind === "session"
            ? selected.path
            : null,
      }),
    );
  }, [showConversation, selected?.id]);
  const handledRequest = useRef<number | null>(null);
  useEffect(() => {
    if (
      newSessionRequest?.projectId === project?.id &&
      newSessionRequest &&
      handledRequest.current !== newSessionRequest.token
    ) {
      handledRequest.current = newSessionRequest.token;
      create("session");
    }
  }, [newSessionRequest, project?.id]);
  return (
    <div className="project-workbench">
      <header
        className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3"
        data-tauri-drag-region="deep"
      >
        {sidebarToggle ?? (
          <button
            className="icon-button"
            aria-label="Toggle sidebar"
            onClick={() =>
              window.dispatchEvent(new Event("brigadier-toggle-sidebar"))
            }
          >
            <SidebarSimpleIcon size={19} />
          </button>
        )}
        <span className="min-w-0 truncate text-sm font-medium">
          {project
            ? (data.projectNames?.[project.id] ?? project.name)
            : "Brigadier"}
        </span>
        <span className="grow" />
        <button
          className="icon-button"
          aria-label="Session history"
          title="Session history"
          disabled={!project}
          onClick={() => setHistory(!history)}
        >
          <ClockCounterClockwiseIcon size={18} />
        </button>
        {(
          [
            ["files", "Tree", FolderIcon],
            ["search", "Search", MagnifyingGlassIcon],
            ["changes", "Changes", GitDiffIcon],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            className="icon-button"
            key={value}
            aria-label={label}
            title={label}
            aria-pressed={workspaceOpen && mode === value}
            disabled={!project}
            onClick={() => {
              setReviewTurn(null);
              setWorkspaceOpen(!workspaceOpen || mode !== value);
              setMode(value);
            }}
          >
            <Icon size={19} />
          </button>
        ))}
      </header>
      <div className="project-tabbar">
        <div role="tablist" aria-label="Project tabs" className="project-tabs">
          {layout.tabs.map((t) => {
            const Icon =
              t.kind === "session"
                ? ChatCircleIcon
                : t.kind === "terminal"
                  ? TerminalIcon
                  : t.kind === "note"
                    ? NotebookIcon
                    : t.kind === "diff"
                      ? GitDiffIcon
                      : FileIcon;
            return (
              <div className="project-tab" key={t.id}>
                <button
                  role="tab"
                  aria-selected={layout.active === t.id}
                  title={t.path}
                  onClick={() => select(t)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                      e.preventDefault();
                      const i = layout.tabs.indexOf(t);
                      select(
                        layout.tabs[
                          (i +
                            (e.key === "ArrowRight" ? 1 : -1) +
                            layout.tabs.length) %
                            layout.tabs.length
                        ]!,
                      );
                      const tabs = e.currentTarget
                        .closest("[role=tablist]")
                        ?.querySelectorAll<HTMLButtonElement>("[role=tab]");
                      tabs?.[
                        (i +
                          (e.key === "ArrowRight" ? 1 : -1) +
                          layout.tabs.length) %
                          layout.tabs.length
                      ]?.focus();
                    }
                  }}
                >
                  <Icon />
                  <span>
                    {t.kind === "session"
                      ? (peers.titles[t.path] ?? `Session ${t.path.slice(-6)}`)
                      : t.kind === "note"
                        ? (data.notes.find((n) => `note:${n.id}` === t.id)
                            ?.title ?? t.path)
                        : t.path.split("/").pop()}
                  </span>
                  {t.kind === "session" && working(sessions[t.path]) && (
                    <i className="status-spinner" aria-label="Working" />
                  )}
                  {t.kind === "session" && attention[t.path] && (
                    <i className="attention-dot" aria-label="Needs attention" />
                  )}
                  {(documentCommands.get(t.id)?.dirty ?? hasSavedEdits(t)) && (
                    <i className="dirty-dot" aria-label="Unsaved changes" />
                  )}
                </button>
                <button
                  className="icon-button"
                  aria-label={`Close ${t.kind === "note" ? (data.notes.find((n) => `note:${n.id}` === t.id)?.title ?? t.path) : t.path}`}
                  onClick={() => void close(t)}
                >
                  <XIcon size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <div
          className="new-tab-menu"
          ref={menuRef}
          onKeyDown={(e) => {
            if (e.key === "Escape") setMenu(false);
          }}
        >
          <button
            className="icon-button"
            aria-label="New tab"
            title="New tab"
            aria-expanded={menu}
            disabled={!project}
            onClick={() => setMenu(!menu)}
          >
            <PlusIcon size={18} />
          </button>
          {menu && (
            <div className="tab-menu" role="menu">
              {[
                ["session", "New Session"],
                ["terminal", "Terminal"],
                ["untitled", "New File"],
              ].map(([kind, label]) => (
                <button
                  role="menuitem"
                  key={kind}
                  onClick={() =>
                    create(kind as "session" | "terminal" | "untitled")
                  }
                >
                  {label}
                </button>
              ))}
              <button
                role="menuitem"
                onClick={() => {
                  setOpenPath("");
                  setMenu(false);
                }}
              >
                Open File
              </button>
              <button role="menuitem" onClick={() => create("note")}>
                New Note
              </button>
            </div>
          )}
        </div>
      </div>
      {error && (
        <div className="workbench-error" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="Dismiss workspace error"
            onClick={() => setError("")}
          >
            <XIcon />
          </button>
        </div>
      )}
      {openPath !== null && (
        <form
          className="open-file-bar"
          onSubmit={(e) => {
            e.preventDefault();
            if (openPath.trim()) {
              open(openPath.trim());
              setOpenPath(null);
            }
          }}
        >
          <input
            autoFocus
            placeholder="File path in this workspace"
            aria-label="Open file path"
            value={openPath}
            onChange={(e) => setOpenPath(e.target.value)}
          />
          <button className="act">Open</button>
          <button
            type="button"
            className="act"
            onClick={() => setOpenPath(null)}
          >
            Cancel
          </button>
        </form>
      )}
      <div className={`workbench-body ${workspaceOpen ? "has-workspace" : ""}`}>
        <div className="workbench-main">
          {showHistory && historyContent}
          {showHistory && project && (
            <ProjectHistory
              projectName={data.projectNames?.[project.id] ?? project.name}
              sessions={Object.values(sessions).filter(
                (s) => s.projectId === project.id,
              )}
              titles={peers.titles}
              attention={attention}
              onSelect={(id) => {
                setHistory(false);
                onSelectSession(id);
              }}
              onNew={() => create("session")}
            />
          )}
          {showConversation &&
            activeSession &&
            selected?.kind === "session" && (
              <SessionCard
                session={activeSession}
                sessions={sessions}
                peers={peers}
                onSelect={onSelectSession}
                onChanges={() => {
                  setReviewTurn(null);
                  setMode("changes");
                  setWorkspaceOpen(true);
                }}
                onSettings={() => setSessionPrefs(true)}
              />
            )}
          <div className="conversation-surface" hidden={!showConversation}>
            <NoteScope.Provider value={project?.id ?? null}>
              {!showHistory && historyContent}
              {children}
              {pendingRequest && (
                <div className="peer-request">
                  <span>
                    <b>
                      {peers.titles[pendingRequest.from] ?? pendingRequest.from}
                    </b>{" "}
                    wants to {pendingRequest.action}{" "}
                    <b>
                      {peers.titles[pendingRequest.to] ?? pendingRequest.to}
                    </b>
                    .
                  </span>
                  <button
                    className="act"
                    disabled={deciding}
                    onClick={() => void decide(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="act"
                    disabled={deciding}
                    onClick={() =>
                      setConfirm({
                        title: `${pendingRequest.action === "close" ? "Stop and close" : "Stop"} session?`,
                        body: "This request came from another session. Confirming stops the target agent.",
                        confirmLabel: "Confirm",
                        onCancel: () => setConfirm(null),
                        onConfirm: async () => {
                          await decide(true);
                          setConfirm(null);
                        },
                      })
                    }
                  >
                    Review
                  </button>
                </div>
              )}
            </NoteScope.Provider>
          </div>
          {Object.values(layouts)
            .flatMap((l) => l.tabs)
            .filter((t) => t.kind === "terminal")
            .map((t) => (
              <div
                className="terminal-surface"
                key={t.id}
                hidden={
                  selected?.id !== t.id || t.context.projectId !== project?.id
                }
              >
                <Suspense
                  fallback={<p className="panel-empty">Loading terminal…</p>}
                >
                  <TerminalView
                    context={t.context}
                    visible={
                      selected?.id === t.id &&
                      t.context.projectId === project?.id
                    }
                    tabId={t.id}
                    onReady={(id) => {
                      if (id) terminalIds.current.set(t.id, id);
                      else terminalIds.current.delete(t.id);
                    }}
                  />
                </Suspense>
              </div>
            ))}
          {selected &&
            !["session", "draft", "terminal"].includes(selected.kind) &&
            (selected.kind !== "note" || dataLoaded) && (
              <DocumentTab
                key={selected.id}
                tab={selected}
                note={
                  selected.kind === "note"
                    ? data.notes.find((n) => `note:${n.id}` === selected.id)
                    : undefined
                }
                onNote={setNote}
                onSaved={(path) => {
                  const closing = closeAfterSaveAs.current === selected.id;
                  closeAfterSaveAs.current = null;
                  if (selected.kind === "untitled") remove(selected);
                  if (!closing) open(path);
                }}
                onAttach={attach}
                refresh={refresh}
              />
            )}
        </div>
        {project && (
          <div className="workbench-side" hidden={!workspaceOpen}>
            <WorkspaceTools
              visible={workspaceOpen}
              reviewTurn={reviewTurn}
              context={context}
              root={root}
              mode={mode}
              onMode={setMode}
              status={status}
              revision={revision}
              refresh={refresh}
              onOpen={open}
              onNote={openNote}
              data={data}
              onData={setData}
              models={models}
              onClose={() => setWorkspaceOpen(false)}
            />
          </div>
        )}
      </div>
      {sessionPrefs && project && (
        <SessionPreferences
          projectId={project.id}
          data={data}
          onData={setData}
          onClose={() => setSessionPrefs(false)}
        />
      )}
      {confirm && <ConfirmDialog {...confirm} />}
    </div>
  );
}
