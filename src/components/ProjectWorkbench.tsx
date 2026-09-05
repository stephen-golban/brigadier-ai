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
  GitBranchIcon,
  CaretDownIcon,
} from "@phosphor-icons/react";
import type { ProjectView, SessionId, ModelInfo } from "../wire";
import type { SessionRuntime } from "../feedStore";
import { AgentsPanel } from "./AgentsPanel";
import { SessionPreferences } from "./SessionPreferences";
import { NoteScope } from "../noteScope";
import { peerApi, type PeerData } from "../peerApi";
import { bridge } from "../bridge";
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
      const { projectId, sessionId } = (event as CustomEvent<{
        projectId?: string;
        sessionId?: string;
      }>).detail;
      setLayouts((old) => Object.fromEntries(Object.entries(old)
        .filter(([id]) => id !== projectId)
        .map(([id, layout]) => {
          const tabs = layout.tabs.filter((tab) => !sessionId ||
            ((tab.kind === "note" || tab.kind === "untitled") ||
              (tab.context.sessionId !== sessionId &&
                !(tab.kind === "session" && tab.path === sessionId))));
          return [id, {
            tabs,
            active: tabs.some((tab) => tab.id === layout.active)
              ? layout.active : (tabs[tabs.length - 1]?.id ?? null),
          }];
        })));
    };
    window.addEventListener("workbench-history-deleted", deleted);
    return () => window.removeEventListener("workbench-history-deleted", deleted);
  }, [setLayouts]);
  const [data, setData] = useState<WorkbenchData>(initial);
  const [mode, setMode] = useStoredState<WorkspaceMode>(
    "brigadier:workspace-mode",
    "files",
  );
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const restored = () => setRevision(n => n + 1);
    window.addEventListener("workbench-files-restored", restored);
    return () => window.removeEventListener("workbench-files-restored", restored);
  }, []);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [overview, setOverview] = useState(false);
  const terminalIds = useRef(new Map<string, string>());
  const menuRef = useRef<HTMLDivElement>(null);
  const layout = project ? (layouts[project.id] ?? empty) : empty;
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
    const failure = () =>
      setError(
        "Local storage is full. Keep unsaved tabs open and save their contents.",
      );
    window.addEventListener("brigadier-storage-error", failure);
    return () => window.removeEventListener("brigadier-storage-error", failure);
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
                ...l.tabs,
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
  useEffect(() => {
    if (!context.projectId) return;
    let live = true;
    setStatus(null);
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
  const add = (tab: ProjectTab) => {
    if (!project) return;
    setLayouts((old) => {
      const l = old[project.id] ?? empty;
      return {
        ...old,
        [project.id]: {
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
      setLayouts((old) => ({
        ...old,
        [project.id]: { ...(old[project.id] ?? empty), active: null },
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
        projectId: project.id,
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
    if (!project) return;
    setLayouts((old) => ({
      ...old,
      [project.id]: { ...(old[project.id] ?? empty), active: t.id },
    }));
    if (t.kind === "session") onSelectSession(t.path);
  };
  const remove = (tab: ProjectTab) => {
    const id = tab.context.projectId;
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
    if (tab.kind === "session") {
      const s = sessions[tab.path];
      if (s && ["running", "starting"].includes(s.status)) {
        setConfirm({
          title: "Stop and close session?",
          body: "The agent will stop. Its conversation and files will remain available.",
          confirmLabel: "Stop and close",
          onCancel: () => setConfirm(null),
          onConfirm: async () => {
            await bridge().kill(tab.path);
            remove(tab);
            setConfirm(null);
          },
        });
        return;
      }
    }
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
  useEffect(() => {
    setLayouts((old) => {
      let next = old;
      for (const id of Object.keys(peers.origins)) {
        const s = sessions[id];
        if (!s?.projectId || peers.closed.includes(id)) continue;
        const l = next[s.projectId] ?? empty;
        if (l.tabs.some((t) => t.id === `session:${id}`)) continue;
        next = {
          ...next,
          [s.projectId]: {
            ...l,
            tabs: [
              ...l.tabs,
              {
                id: `session:${id}`,
                kind: "session",
                path: id,
                context: { projectId: s.projectId, sessionId: id },
                root: s.cwd ?? "",
              },
            ],
          },
        };
      }
      return next;
    });
  }, [peers.origins, sessions]);
  const pendingRequest = peers.requests.find((r) => !r.resolved);
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
  const showConversation = !selected || selected.kind === "session";
  return (
    <div className="project-workbench">
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
                  {t.kind === "session" && sessions[t.path]?.busy && (
                    <i className="tab-busy" />
                  )}
                </button>
                <button
                  className="icon-button"
                  aria-label={`Close ${t.path}`}
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
        <span className="grow" />
        <AgentsPanel sessions={sessions} projectId={project?.id ?? null} selectedId={selectedSessionId} peers={peers} onSelect={onSelectSession} />
        <button
          className="overview-trigger"
          aria-label="Project overview"
          disabled={!project}
          aria-expanded={overview}
          onClick={() => setOverview(!overview)}
        >
          <GitBranchIcon />
          <span>{status?.branch ?? "Overview"}</span>
          <span className="added">+{status?.additions ?? 0}</span>
          <span className="removed">−{status?.deletions ?? 0}</span>
          <CaretDownIcon />
        </button>
        {overview && (
          <div className="overview-card">
            <b>Project overview</b>
            <button
              onClick={() => {
                setMode("changes");
                setWorkspaceOpen(true);
                setOverview(false);
              }}
            >
              Changes{" "}
              <span>
                {status?.changes.length ?? 0} files · +{status?.additions ?? 0}{" "}
                −{status?.deletions ?? 0}
              </span>
            </button>
            <button
              onClick={() => {
                setMode("changes");
                setWorkspaceOpen(true);
                setOverview(false);
              }}
            >
              Branch & Git actions <span>{status?.branch ?? "Repository"}</span>
            </button>
            <div className="overview-section">
              Sessions{" "}
              <button
                onClick={() => {
                  setSessionPrefs(true);
                  setOverview(false);
                }}
              >
                Session settings
              </button>
            </div>
            {Object.values(sessions)
              .filter((s) => s.projectId === project?.id)
              .map((s) => (
                <button
                  key={s.sessionId}
                  onClick={() => {
                    onSelectSession(s.sessionId);
                    setOverview(false);
                  }}
                >
                  Session {s.sessionId.slice(-6)}
                  <span>{s.busy ? "Working" : s.status}</span>
                </button>
              ))}
            <div className="overview-section">Sources</div>
            {layout.tabs
              .filter((t) => ["file", "note"].includes(t.kind))
              .map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    select(t);
                    setOverview(false);
                  }}
                >
                  {t.path}
                  <span>{t.kind}</span>
                </button>
              ))}
          </div>
        )}
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
      {pendingRequest && (
        <div className="peer-request">
          <span>
            <b>{peers.titles[pendingRequest.from] ?? pendingRequest.from}</b>{" "}
            wants to {pendingRequest.action}{" "}
            <b>{peers.titles[pendingRequest.to] ?? pendingRequest.to}</b>.
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
      <div className={`workbench-body ${workspaceOpen ? "has-workspace" : ""}`}>
        <div className="workbench-main">
          <div className="conversation-surface" hidden={!showConversation}>
            {selectedSessionId && peers.origins[selectedSessionId] && (
              <div className="session-origin">
                Started by{" "}
                <button
                  className="act"
                  onClick={() =>
                    onSelectSession(peers.origins[selectedSessionId!]!)
                  }
                >
                  {peers.titles[peers.origins[selectedSessionId]!] ??
                    peers.origins[selectedSessionId]}
                </button>
              </div>
            )}
            {selectedSessionId &&
              peers.messages.some(
                (m) =>
                  m.to === selectedSessionId || m.from === selectedSessionId,
              ) && (
                <details className="peer-inbox">
                  <summary>Peer messages</summary>
                  {peers.messages
                    .filter(
                      (m) =>
                        m.to === selectedSessionId ||
                        m.from === selectedSessionId,
                    )
                    .map((m) => (
                      <article key={m.id}>
                        <b>{peers.titles[m.from] ?? m.from}</b>
                        <span>
                          {m.error ??
                            (m.delivered
                              ? "Delivered"
                              : m.work
                                ? "Queued work request"
                                : "Information")}
                        </span>
                        <p>{m.text}</p>
                      </article>
                    ))}
                </details>
              )}
            <NoteScope.Provider value={project?.id ?? null}>
              {children}
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
            !["session", "terminal"].includes(selected.kind) &&
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
                onSaved={(path) => open(path)}
                onAttach={attach}
                refresh={refresh}
              />
            )}
        </div>
        {project && (
          <div className="workbench-side" hidden={!workspaceOpen}>
            <WorkspaceTools
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
