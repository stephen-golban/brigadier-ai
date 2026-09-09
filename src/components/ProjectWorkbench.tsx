import { useSessionArchive } from "../sessionArchive";
import { setSessionArchived } from "../sessionNavigation";
import { Folders as FoldersIcon, Terminal as TerminalIcon } from "lucide-react";
import { SessionMenu } from "./SessionMenu";
import { working } from "../attention";
import { SidebarIcon } from "./NavigationIcons";
import { SearchIcon } from "./SearchIcon";
import { Tabs } from "./controls/tabs";
import { Input } from "./controls/input";
import { Button } from "./controls/button";
import { isTrashed, type NavigationData } from "../navigationApi";
import { hasSavedEdits } from "../workbenchState";
import { SubagentsPanel } from "./SubagentsPanel";
import { UsersThreeIcon } from "@phosphor-icons/react";
import { SessionCard } from "./SessionCard";
import { ProjectHistory } from "./ProjectHistory";
import { documentCommands } from "../documentCommands";
import { documentKey } from "../workbenchState";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import {
  XIcon,
  FileIcon,
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
  workspaceKey,
  sessionLayoutsKey,
  migrateSessionLayouts,
  type ProjectTab,
  type ProjectLayout,
} from "../workbenchState";
import { WorkspaceTools, type WorkspaceMode } from "./WorkspaceTools";
import { DocumentTab } from "./DocumentTab";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
import { TerminalDock } from "./TerminalDock";
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
  onForkSession,
  workspaceOpen,
  setWorkspaceOpen,
  models,
  children,
  historyContent,
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
  onForkSession?: (id: SessionId, newWorktree: boolean) => Promise<void>;
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
  const archive = useSessionArchive();
  const archivedSessions = Object.values(sessions).filter(
    (s) =>
      s.projectId === project?.id &&
      archive.entries[s.sessionId] &&
      !(navigation && isTrashed(navigation, "session", s.sessionId)),
  );
  const [sessionPrefs, setSessionPrefs] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [legacyLayouts] = useState(migrateSessionLayouts);
  const [layouts, setLayouts] = useStoredState<Record<string, ProjectLayout>>(
    sessionLayoutsKey,
    legacyLayouts,
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
            .filter(
              ([, saved]) =>
                !projectId ||
                !saved.tabs.some((t) => t.context.projectId === projectId),
            )
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
                  ...layout,
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
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [history, setHistory] = useState(false);
  const [subagents, setSubagents] = useStoredState("brigadier:subagents-panel", false);
  const [requestedWorker, setRequestedWorker] = useState<string|null>(null);
  useEffect(()=>{
    const openWorker=(event:Event)=>{const detail=(event as CustomEvent<{rootId:string;id:string}>).detail;if(detail.rootId!==selectedSessionId)return;setRequestedWorker(detail.id);setSubagents(true);setHistory(false);setWorkspaceOpen(true);};
    window.addEventListener("workbench-open-worker",openWorker);
    return ()=>window.removeEventListener("workbench-open-worker",openWorker);
  },[selectedSessionId]);

  const [panelWidth, setPanelWidth] = useStoredState(
    "brigadier:workspace-width",
    280,
  );
  const [resizingPanel, setResizingPanel] = useState(false);
  const resizePanel = (value: number) =>
    setPanelWidth(Math.max(240, Math.min(900, value)));

  const [, setDocumentRevision] = useState(0);
  const closedTabs = useRef<(ProjectTab & { owner: string })[]>([]);
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
  const tabStrip = useRef<HTMLDivElement>(null);
  const focusAfterClose = useRef(false);
  const layoutKey = workspaceKey(project?.id ?? "__notes__", selectedSessionId);
  useEffect(() => {
    if (project)
      setLayouts((old) =>
        old[layoutKey]
          ? old
          : { ...old, [layoutKey]: { tabs: [], active: null } },
      );
  }, [layoutKey, project?.id]);
  const storedLayout = layouts[layoutKey] ?? empty;
  const visibleTabs = storedLayout.tabs
    .filter((t) => t.kind !== "terminal")
    .filter((t) => !(t.kind === "session" && archive.entries[t.path]))
    .filter(
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
    active:
      storedLayout.active === null ||
      visibleTabs.some((t) => t.id === storedLayout.active)
        ? storedLayout.active
        : (visibleTabs[visibleTabs.length - 1]?.id ?? null),
  };
  useEffect(() => {
    if (focusAfterClose.current) {
      focusAfterClose.current = false;
      const target = tabStrip.current?.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]',
      );
      (
        target ??
        tabStrip.current?.parentElement?.querySelector<HTMLElement>(
          '[aria-label="Show conversation"]',
        )
      )?.focus();
    }
  }, [layout.active]);
  const selected = layout.tabs.find((t) => t.id === layout.active);
  const resourceActive =
    !!selected && !["session", "draft"].includes(selected.kind);
  const panelTab = resourceActive ? selected : undefined;
  useEffect(() => {
    if (selectedSessionId && archive.entries[selectedSessionId])
      onSelectSession(null);
  }, [archive, selectedSessionId]);
  const activeSession =
    session &&
    session.projectId === project?.id &&
    !archive.entries[session.sessionId]
      ? session
      : null;
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
      !!archive.entries[selectedSessionId] ||
      sessions[selectedSessionId]?.projectId !== project.id
    )
      return;
    const current = sessions[selectedSessionId]!;
    setLayouts((old) => {
      const l = old[layoutKey] ?? empty;
      const id = `session:${selectedSessionId}`;
      if (l.tabs.some((t) => t.id === id)) return old;
      return {
        ...old,
        [layoutKey]: {
          ...l,
          tabs: [
            {
              id,
              kind: "session",
              path: selectedSessionId,
              context: { projectId: project.id, sessionId: selectedSessionId },
              root: current.cwd ?? project.root_path,
            },
            ...l.tabs.filter((t) => t.kind !== "draft"),
          ],
          active: l.active ?? id,
        },
      };
    });
    try {
      const last = JSON.parse(
        localStorage.getItem("brigadier:last-project-session") ?? "{}",
      );
      localStorage.setItem(
        "brigadier:last-project-session",
        JSON.stringify({ ...last, [project.id]: selectedSessionId }),
      );
    } catch {
      /* selection is still available in memory */
    }
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
  const open = useCallback(
    (
      path: string,
      kind: "file" | "diff" = "file",
      staged = false,
      line?: number,
      source?: SessionRuntime,
    ) => {
      const fileRoot = source?.cwd ?? root;
      const fileContext = source?.projectId ? {projectId: source.projectId, sessionId: source.sessionId} : context;
      if (!project) return;
      const suffix = path.match(/(?:#L|:)(\d+)(?::\d+)?$/);
      const cleaned = path
        .replace(/#L\d+(?:-L\d+)?$/, "")
        .replace(/:\d+(?::\d+)?$/, "");
      const relative = cleaned.startsWith(fileRoot + "/")
        ? cleaned.slice(fileRoot.length + 1)
        : cleaned.replace(/^\.\//, "");
      const id = `${kind}:${fileContext.sessionId ?? "root"}:${staged}:${relative}`;
      const tab: ProjectTab = {
        id,
        kind,
        path: relative,
        context: fileContext,
        root: fileRoot,
        staged,
        line: line ?? (suffix ? Number(suffix[1]) : undefined),
      };
      setLayouts((old) => {
        const l = old[layoutKey] ?? empty;
        // A Files menu tab is a placeholder for its first document. Toolbar
        // panel toggles never create a placeholder or change the selected tab.
        const placeholder = l.tabs.find(
          (t) => t.id === l.active && t.kind === "files",
        );
        const existing = l.tabs.some((t) => t.id === id);
        const tabs = existing
          ? l.tabs
              .filter((t) => t.id !== placeholder?.id)
              .map((t) => (t.id === id ? { ...t, line: tab.line } : t))
          : placeholder
            ? l.tabs.map((t) => (t.id === placeholder.id ? tab : t))
            : [...l.tabs, tab];
        return { ...old, [layoutKey]: { ...l, tabs, active: id } };
      });
    },
    [layoutKey, project?.id, context.sessionId, root, setLayouts],
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
          ...l,
          tabs: l.tabs.some((t) => t.id === tab.id) ? l.tabs : [...l.tabs, tab],
          active: tab.id,
        },
      };
    });
  };
  const openNote = (note: Note) =>
    add({
      id: `note:${note.id}`,
      kind: "note",
      path: note.title || "Untitled note",
      context,
      root,
    });
  const create = (
    kind: "session" | "terminal" | "untitled" | "note" | "files",
  ) => {
    if (!project) return;
    if (kind === "files") {
      setMode("files");
      setWorkspaceOpen(true);
      return;
    }
    if (kind === "terminal") {
      window.dispatchEvent(new Event("workbench-terminal-create"));
      return;
    }
    if (kind === "session") {
      onSelectSession(null);
      const key = workspaceKey(project.id, null);
      setLayouts((old) => ({
        ...old,
        [key]: old[key] ?? { tabs: [], active: null },
      }));
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
      path: "Untitled",
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
    const id = layouts[layoutKey]?.tabs.some((t) => t.id === tab.id)
      ? layoutKey
      : (Object.keys(layouts).find((key) =>
          layouts[key].tabs.some((t) => t.id === tab.id),
        ) ?? layoutKey);
    const l = layouts[id] ?? empty;
    focusAfterClose.current = !!tabStrip.current?.contains(
      document.activeElement,
    );
    const index = l.tabs.findIndex((t) => t.id === tab.id);
    const tabs = l.tabs.filter((t) => t.id !== tab.id);
    const next = tabs[Math.min(index, tabs.length - 1)];
    const active = l.active === tab.id ? (next?.id ?? null) : l.active;
    if (id === layoutKey && l.active === tab.id) {
      if (next?.kind === "session") onSelectSession(next.path);
      else if (next?.kind === "draft" || !next) onSelectSession(null);
    }
    setLayouts((old) => ({ ...old, [id]: { ...l, tabs, active } }));
  };
  const closing = useRef(false);
  const close = async (tab: ProjectTab) => {
    if (closing.current || confirm) return;
    if (tab.kind === "session") {
      const related = new Set([tab.path]);
      for (let before = -1; before !== related.size;) {
        before = related.size;
        for (const [child, parent] of Object.entries(peers.origins))
          if (related.has(parent)) related.add(child);
      }
      const archiveAndClose = async () => {
        await setSessionArchived(tab.path, true);
        if (selectedSessionId === tab.path) onSelectSession(null);
        setConfirm(null);
      };
      const ownedTerminals = Object.values(layouts)
        .flatMap((l) => l.tabs)
        .filter(
          (t) =>
            t.kind === "terminal" &&
            !!t.context.sessionId &&
            related.has(t.context.sessionId),
        );
      let terminalBusy = false;
      try {
        const info = await Promise.all(
          ownedTerminals.map((t) => {
            const id = terminalIds.current.get(t.id);
            return id
              ? workbenchApi.terminalInfo(id)
              : Promise.resolve({ busy: false });
          }),
        );
        terminalBusy = info.some((t) => t.busy);
      } catch (e) {
        setError(errorMessage(e));
        return;
      }
      if (terminalBusy || [...related].some((id) => working(sessions[id]))) {
        setConfirm({
          native: true,
          title: "Stop and archive session?",
          body: "Archiving stops this session’s AI work, child agents, and terminals. File tabs and drafts are kept in History.",
          confirmLabel: "Stop and archive",
          onCancel: () => setConfirm(null),
          onConfirm: archiveAndClose,
        });
      } else {
        closing.current = true;
        try {
          await archiveAndClose();
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          closing.current = false;
        }
      }
      return;
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
      { ...tab, owner: layoutKey },
    ].slice(-20);
    remove(tab);
  };
  const revealConversation = () => {
    const threadTab =
      layout.tabs.find(
        (t) => t.kind === "session" && t.path === selectedSessionId,
      ) ??
      layout.tabs.find((t) => t.kind === "session") ??
      layout.tabs.find((t) => t.kind === "draft");
    if (threadTab) select(threadTab);
    else
      setLayouts((old) => ({
        ...old,
        [layoutKey]: { ...(old[layoutKey] ?? empty), active: null },
      }));
  };
  const attach = (path: string, content: string) => {
    revealConversation();
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
      revealConversation();
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
              ...l,
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
  const [, setReviewTurn] = useState<string | null>(null);
  const showConversation = !resourceActive;
  const navigationTabs: ProjectTab[] = layout.tabs.some(
    (t) => t.kind === "session" || t.kind === "draft",
  )
    ? layout.tabs
    : [
        {
          id: `conversation:${layoutKey}`,
          kind: "draft",
          path: "New session",
          context,
          root,
        },
        ...layout.tabs,
      ];
  useEffect(() => {
    const modalOpen = () =>
      !!document.querySelector(
        'dialog[open], [role="dialog"], .settings-overlay',
      );
    const newSession = () => {
      if (!modalOpen()) create("session");
    };
    const newTerminal = () => {
      if (!modalOpen()) create("terminal");
    };
    const newFiles = () => {
      if (!modalOpen()) create("files");
    };
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
                ...l,
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
      if (e.isComposing) return;
      if (
        e.target instanceof HTMLElement &&
        e.target.closest(".terminal-dock") &&
        e.code !== "KeyW"
      )
        return;
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (
        document.querySelector(
          'dialog[open], [role="dialog"], .settings-overlay',
        )
      )
        return;
      const command =
        e.metaKey || (!navigator.platform.includes("Mac") && e.ctrlKey);
      // Option changes event.key on macOS; physical key codes keep these stable.
      if (e.altKey) {
        if (command && !e.shiftKey && e.code === "KeyF") {
          consume();
          create("files");
        }
        return;
      }
      const cycle =
        (e.ctrlKey && ["Tab", "PageUp", "PageDown"].includes(e.key)) ||
        (command &&
          e.shiftKey &&
          (e.code === "BracketLeft" || e.code === "BracketRight"));
      if (cycle) {
        consume();
        const direction =
          e.key === "Tab"
            ? e.shiftKey
              ? -1
              : 1
            : e.code === "BracketLeft" || e.key === "PageUp"
              ? -1
              : 1;
        const at = Math.max(
          0,
          navigationTabs.findIndex((t) => t.id === layout.active),
        );
        const next =
          navigationTabs[
            (at + direction + navigationTabs.length) % navigationTabs.length
          ];
        if (next) select(next);
        return;
      }
      if (!command || e.altKey) return;
      if (e.key === ",") {
        consume();
        window.dispatchEvent(new Event("brigadier-settings"));
      } else if (e.key.toLowerCase() === "j" && !e.shiftKey) {
        consume();
        window.dispatchEvent(new Event("workbench-terminal-toggle"));
      } else if (e.key.toLowerCase() === "t") {
        consume();
        if (e.shiftKey) {
          const index = closedTabs.current
            .map((t) => t.owner)
            .lastIndexOf(layoutKey);
          const previous =
            index >= 0 ? closedTabs.current.splice(index, 1)[0] : undefined;
          if (
            previous &&
            (!previous.context.sessionId ||
              sessions[previous.context.sessionId])
          ) {
            if (previous.kind === "session")
              void setSessionArchived(previous.path, false)
                .then(() => {
                  add(previous);
                  onSelectSession(previous.path);
                })
                .catch((e) => setError(errorMessage(e)));
            else add(previous);
          }
        } else create("session");
      } else if (e.key.toLowerCase() === "w") {
        consume();
        if (selected && !["session", "draft"].includes(selected.kind))
          void close(selected);
      } else if (e.key.toLowerCase() === "o") {
        consume();
        setOpenPath("");
      } else if (/^[1-9]$/.test(e.key)) {
        consume();
        const tab =
          e.key === "9"
            ? navigationTabs[navigationTabs.length - 1]
            : navigationTabs[Number(e.key) - 1];
        if (tab) select(tab);
      }
    };
    const nativeClose = () => {
      if (
        !document.querySelector(
          'dialog[open], [role="dialog"], .settings-overlay',
        ) &&
        selected &&
        !["session", "draft"].includes(selected.kind)
      )
        void close(selected);
    };
    const archiveTab = (event: Event) => {
      const id = (event as CustomEvent<{ sessionId: string }>).detail.sessionId;
      const source = sessions[id];
      if (!source) return;
      const tab = Object.values(layouts)
        .flatMap((l) => l.tabs)
        .find((t) => t.kind === "session" && t.path === id) ?? {
        id: `session:${id}`,
        kind: "session" as const,
        path: id,
        context: { projectId: source.projectId ?? "", sessionId: id },
        root: source.cwd ?? "",
      };
      void close(tab);
    };
    window.addEventListener("workbench-close-tab", nativeClose);
    window.addEventListener("workbench-archive-session", archiveTab);
    window.addEventListener("workbench-new-session", newSession);
    window.addEventListener("workbench-new-terminal", newTerminal);
    window.addEventListener("workbench-new-files", newFiles);
    window.addEventListener("workbench-open-note", note);
    window.addEventListener("workbench-note-deleted", removed);
    window.addEventListener("workbench-document-state", documentState);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("workbench-close-tab", nativeClose);
      window.removeEventListener("workbench-archive-session", archiveTab);
      window.removeEventListener("workbench-new-session", newSession);
      window.removeEventListener("workbench-new-terminal", newTerminal);
      window.removeEventListener("workbench-new-files", newFiles);
      window.removeEventListener("workbench-open-note", note);
      window.removeEventListener("workbench-note-deleted", removed);
      window.removeEventListener("workbench-document-state", documentState);
      window.removeEventListener("keydown", key, true);
    };
  }, [layout, project?.id, selectedSessionId, sessions, data, workspaceOpen]);
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("workbench-active-session", {
        detail: activeSession ? activeSession.sessionId : null,
      }),
    );
  }, [showConversation, activeSession?.sessionId]);
  const panelVisible =
    workspaceOpen && (!history || archivedSessions.length > 0);
  const togglePanel = (next: WorkspaceMode) => {
    setReviewTurn(null);
    setSubagents(false);
    setMode(next);
    setHistory(false);
    setWorkspaceOpen(!panelVisible || history || subagents || mode !== next);
  };
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
    <Tabs
      selectedKey={layout.active ?? ""}
      onSelectionChange={(id) => {
        const t = layout.tabs.find((t) => t.id === id);
        if (t) select(t);
      }}
      className="project-workbench relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas"
    >
      <header
        className="project-topbar flex h-11 shrink-0 items-center gap-3 border-b border-hairline px-4 text-text-secondary"
        data-tauri-drag-region="deep"
      >
        {sidebarToggle !== undefined ? (
          sidebarToggle
        ) : (
          <Button
            isIconOnly
            className="icon-button size-8 p-0"
            aria-label="Toggle sidebar"
            onClick={() =>
              window.dispatchEvent(new Event("brigadier-toggle-sidebar"))
            }
          >
            <SidebarIcon size={19} />
          </Button>
        )}
        <div className="session-heading flex min-w-0 shrink items-center gap-1">
          <Button
            aria-label="Show conversation"
            title={
              activeSession
                ? peers.titles[activeSession.sessionId]
                : "New session"
            }
            className={`session-title min-w-0 truncate text-sm ${showConversation ? "text-text" : "text-text-secondary"}`}
            aria-pressed={showConversation}
            onClick={revealConversation}
          >
            {activeSession
              ? (peers.titles[activeSession.sessionId] ??
                `Session ${activeSession.sessionId.slice(-6)}`)
              : "New session"}
          </Button>
          {activeSession && (
            <SessionMenu
              key={activeSession.sessionId}
              sessionId={activeSession.sessionId}
              title={
                peers.titles[activeSession.sessionId] ??
                `Session ${activeSession.sessionId.slice(-6)}`
              }
              canFork={
                !!activeSession.providerSessionId && !working(activeSession)
              }
              onFork={
                onForkSession
                  ? (newWorktree) =>
                      onForkSession(activeSession.sessionId, newWorktree)
                  : undefined
              }
              onArchive={() =>
                void close({
                  id: `session:${activeSession.sessionId}`,
                  kind: "session",
                  path: activeSession.sessionId,
                  context: {
                    projectId: project?.id ?? "",
                    sessionId: activeSession.sessionId,
                  },
                  root,
                })
              }
            />
          )}
        </div>
        {layout.tabs.some((t) => !["session", "draft"].includes(t.kind)) && (
          <div className="session-tab-divider h-5 w-px shrink-0 bg-hairline" />
        )}
        <Tabs.ListContainer
          ref={tabStrip}
          className="main-tab-strip flex min-w-0 items-center gap-1"
        >
          <Tabs.List aria-label="Open files" className="shrink-0 gap-1">
            {layout.tabs
              .filter((t) => !["session", "draft"].includes(t.kind))
              .map((t, index) => {
                const title =
                  t.kind === "note"
                    ? (data.notes.find((n) => `note:${n.id}` === t.id)?.title ??
                      t.path)
                    : t.path.split("/").pop() || "Untitled";
                return (
                  <Tabs.Tab
                    tabIndex={!resourceActive && index === 0 ? 0 : undefined}
                    key={t.id}
                    id={t.id}
                    aria-label={title}
                    title={t.path}
                    className="workbench-tab shrink-0"
                  >
                    {t.kind === "diff" ? (
                      <GitDiffIcon size={14} />
                    ) : (
                      <FileIcon size={14} />
                    )}
                    <span className="max-w-[160px] truncate">{title}</span>
                    {(documentCommands.get(t.id)?.dirty ??
                      hasSavedEdits(t)) && (
                      <i
                        className="size-1.5 rounded-full bg-text-secondary"
                        aria-label="Unsaved changes"
                      />
                    )}
                    <Button
                      size="icon"
                      aria-label={`Close ${title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void close(t);
                      }}
                    >
                      <XIcon size={10} />
                    </Button>
                  </Tabs.Tab>
                );
              })}
          </Tabs.List>
        </Tabs.ListContainer>

        <span className="grow" />
        <div
          className="workbench-panel-actions flex shrink-0 items-center gap-1"
          role="group"
          aria-label="Workspace panels"
        >
          {(
            [
              ["files", "Files", FoldersIcon],
              ["search", "Search", SearchIcon],
              ["changes", "Changes", GitDiffIcon],
            ] as const
          ).map(([value, label, Icon]) => (
            <Button
              key={value}
              size="icon"
              aria-label={label}
              title={
                value === "changes" && status?.changes.length
                  ? `Changes (${status.changes.length})`
                  : label
              }
              className="relative"
              aria-description={
                value === "changes" && status
                  ? `${status.changes.length} changed ${status.changes.length === 1 ? "file" : "files"}`
                  : undefined
              }
              aria-controls="workspace-panel"
              aria-pressed={panelVisible && !history && !subagents && mode === value}
              onClick={() => togglePanel(value)}
              disabled={!project}
            >
              <Icon size={18} />
              {value === "changes" && !!status?.changes.length && (
                <span className="workbench-change-count" aria-hidden="true">
                  {status.changes.length}
                </span>
              )}
            </Button>
          ))}
          <Button size="icon" aria-label="Subagents" title="Subagents" aria-controls="workspace-panel" aria-pressed={panelVisible && subagents} disabled={!selectedSessionId} onClick={() => { setHistory(false); setSubagents(true); setWorkspaceOpen(!panelVisible || !subagents); }}><UsersThreeIcon size={18}/></Button>
          <Button
            size="icon"
            aria-label="Terminal"
            title="Toggle terminal (⌃` / ⌘J)"
            disabled={!project}
            aria-pressed={!!storedLayout.terminalOpen}
            onClick={() =>
              window.dispatchEvent(new Event("workbench-terminal-toggle"))
            }
          >
            <TerminalIcon size={18} />
          </Button>
          {archivedSessions.length > 0 && (
            <Button
              size="icon"
              aria-label="History"
              title="History"
              aria-controls="workspace-panel"
              aria-pressed={panelVisible && history}
              onClick={() => {
                if (history && workspaceOpen) setWorkspaceOpen(false);
                else {
                  setSubagents(false);
                  setHistory(true);
                  setWorkspaceOpen(true);
                }
              }}
            >
              <ClockCounterClockwiseIcon />
            </Button>
          )}
        </div>
      </header>
      {error && (
        <div
          className="workbench-error flex items-center justify-between gap-2 px-3 text-error"
          role="alert"
        >
          <span>{error}</span>
          <Button
            isIconOnly
            className="icon-button size-8 p-0"
            aria-label="Dismiss workspace error"
            onClick={() => setError("")}
          >
            <XIcon />
          </Button>
        </div>
      )}
      {openPath !== null && (
        <form
          className="open-file-bar flex items-center gap-2 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (openPath.trim()) {
              open(openPath.trim());
              setOpenPath(null);
            }
          }}
        >
          <Input
            autoFocus
            placeholder="File path in this workspace"
            aria-label="Open file path"
            value={openPath}
            onChange={(e) => setOpenPath(e.target.value)}
          />
          <Button type="submit" className="act">
            Open
          </Button>
          <Button
            type="button"
            className="act"
            onClick={() => setOpenPath(null)}
          >
            Cancel
          </Button>
        </form>
      )}
      {resourceActive && (
        <div
          className="workbench-path flex h-10 shrink-0 items-center border-b border-hairline px-4 text-sm text-text-secondary"
          title={root}
        >
          <span className="truncate">
            {selected?.kind === "file" || selected?.kind === "diff"
              ? `/ ${selected.path}`
              : "/"}
          </span>
        </div>
      )}
      <div
        role="region"
        aria-label={resourceActive ? "Document" : "Conversation"}
        className={`workbench-body flex min-h-0 flex-1 overflow-hidden ${panelVisible ? "has-workspace" : ""}`}
      >
        <div
          className="workbench-main flex min-h-0 min-w-0 flex-1 flex-col"
          hidden={resourceActive}
        >
          <div
            className="conversation-surface flex min-h-0 min-w-0 flex-1 flex-col"
            hidden={!showConversation}
          >
          {showConversation && activeSession && (
            <SessionCard
              session={activeSession}
              sessions={sessions}
              peers={peers}
              onSelect={onSelectSession}
              onChanges={() => {
                setHistory(false);
                setSubagents(false);
                setReviewTurn(null);
                setMode("changes");
                setWorkspaceOpen(true);
              }}
              onSubagents={() => { setHistory(false); setSubagents(true); setWorkspaceOpen(true); }}
              onFiles={() => { setHistory(false); setSubagents(false); setMode("files"); setWorkspaceOpen(true); }}
              onSettings={() => setSessionPrefs(true)}
            />
          )}
            <NoteScope.Provider value={project?.id ?? null}>
              {historyContent}
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
                  <Button
                    className="act"
                    disabled={deciding}
                    onClick={() => void decide(false)}
                  >
                    Cancel
                  </Button>
                  <Button
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
                  </Button>
                </div>
              )}
            </NoteScope.Provider>
          </div>
        </div>
        <div
          className="workbench-document flex min-h-0 min-w-0 flex-1 flex-col"
          hidden={!resourceActive}
        >
          {selected?.kind === "files" && (
            <div className="open-file-empty flex flex-1 flex-col items-center justify-center gap-3 text-text-secondary">
              <FoldersIcon size={32} />
              <h2 className="text-lg text-text">Open file</h2>
              <p className="text-sm">Select a file from the workspace tree</p>
            </div>
          )}
          {panelTab &&
            !["session", "draft", "terminal", "files"].includes(
              panelTab.kind,
            ) &&
            (panelTab.kind !== "note" || dataLoaded) && (
              <DocumentTab
                key={panelTab.id}
                tab={panelTab}
                note={
                  panelTab.kind === "note"
                    ? data.notes.find((n) => `note:${n.id}` === panelTab.id)
                    : undefined
                }
                onNote={setNote}
                onSaved={(path) => {
                  const closing = closeAfterSaveAs.current === panelTab.id;
                  closeAfterSaveAs.current = null;
                  if (panelTab.kind === "untitled") remove(panelTab);
                  if (!closing) open(path);
                }}
                onAttach={attach}
                refresh={refresh}
              />
            )}
        </div>
        {project && (
          <aside
            id="workspace-panel"
            className="workbench-side relative flex min-h-0 min-w-0 shrink-0 flex-col bg-canvas"
            data-open={panelVisible}
            data-resizing={resizingPanel}
            aria-label="Workspace"
            aria-hidden={!panelVisible}
            inert={!panelVisible}
            style={
              { "--workspace-panel-width": `${panelWidth}px` } as CSSProperties
            }
          >
            <div
              className="layout-resizer absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize touch-none"
              role="separator"
              aria-label="Resize workspace"
              aria-orientation="vertical"
              aria-valuemin={240}
              aria-valuemax={900}
              aria-valuenow={panelWidth}
              tabIndex={panelVisible ? 0 : -1}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  resizePanel(panelWidth + (e.key === "ArrowLeft" ? 24 : -24));
                }
              }}
              onPointerDown={(e) => {
                setResizingPanel(true);
                e.currentTarget.setPointerCapture(e.pointerId);
                e.currentTarget.dataset.start = String(e.clientX);
                e.currentTarget.dataset.width = String(panelWidth);
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  resizePanel(
                    Number(e.currentTarget.dataset.width) +
                      Number(e.currentTarget.dataset.start) -
                      e.clientX,
                  );
              }}
              onPointerUp={(e) =>
                e.currentTarget.releasePointerCapture(e.pointerId)
              }
              onLostPointerCapture={() => setResizingPanel(false)}
            />
            <div className="workbench-side-content flex min-h-0 flex-1 flex-col">
              {subagents ? <SubagentsPanel requestedId={requestedWorker} key={selectedSessionId ?? "none"} rootId={selectedSessionId} projectId={project.id} peers={peers} sessions={sessions} onFile={(path, worker) => { if(path.startsWith("brigadier-note:")) {const note=data.notes.find(note=>note.id===path.slice(15));if(note)openNote(note);}else open(path, "file", false, undefined, worker);}} /> : history ? (
                <ProjectHistory
                  projectName={data.projectNames?.[project.id] ?? project.name}
                  sessions={archivedSessions}
                  titles={peers.titles}
                  entries={archive.entries}
                  settings={archive.settings}
                  onSelect={async (id) => {
                    try {
                      await setSessionArchived(id, false);
                      onSelectSession(id);
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  }}
                />
              ) : (
                <WorkspaceTools
                  visible={panelVisible}
                  openPaths={layout.tabs
                    .filter(
                      (tab) =>
                        tab.kind === "file" &&
                        tab.context.projectId === context.projectId &&
                        tab.context.sessionId === context.sessionId,
                    )
                    .map((tab) => tab.path)}
                  context={context}
                  root={root}
                  mode={mode}
                  selectedPath={
                    selected?.kind === "file" ? selected.path : undefined
                  }
                  status={status}
                  revision={revision}
                  refresh={refresh}
                  onOpen={open}
                  onNote={openNote}
                  data={data}
                  onData={setData}
                  models={models}
                />
              )}
            </div>
          </aside>
        )}
      </div>
      {Object.entries(layouts).map(([key, saved]) => {
        const [projectId, sessionId] = JSON.parse(key) as [
          string,
          string | null,
        ];
        return (
          <TerminalDock
            key={key}
            active={key === layoutKey}
            suspended={!!(sessionId && archive.entries[sessionId])}
            context={{ projectId, sessionId }}
            layout={saved}
            onChange={(update) =>
              setLayouts((old) => ({
                ...old,
                [key]: update(old[key] ?? empty),
              }))
            }
            onReady={(tabId, id) => {
              if (id) terminalIds.current.set(tabId, id);
              else terminalIds.current.delete(tabId);
            }}
          />
        );
      })}
      {sessionPrefs && project && (
        <SessionPreferences
          projectId={project.id}
          data={data}
          onData={setData}
          onClose={() => setSessionPrefs(false)}
        />
      )}
      {confirm && <ConfirmDialog {...confirm} />}
    </Tabs>
  );
}
