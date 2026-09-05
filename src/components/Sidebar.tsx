import { useEffect, useState, type ReactNode } from "react";
import {
  FolderIcon,
  PlusIcon,
  CaretDownIcon,
  GearSixIcon,
  PencilSimpleIcon,
  TrashIcon,
  NotebookIcon,
  ChatCircleIcon,
} from "@phosphor-icons/react";
import type { SessionRuntime } from "../feedStore";
import type {
  AppError,
  AppInfo,
  ClaudeStatus,
  ProjectDeletion,
  ProjectId,
  ProjectView,
  SessionDeletion,
  SessionId,
} from "../wire";
import {
  workbenchApi,
  defaultSettings,
  type WorkbenchData,
  type Note,
} from "../workbenchApi";
import { errorMessage } from "../workspaceApi";
import { notify } from "../desktopApi";
import { working } from "../attention";
import { DesktopSettings } from "./DesktopSettings";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
export type DeleteAnswer<T> =
  { deletion: T; error: null } | { deletion: null; error: AppError };
export type SessionDeleteAnswer = DeleteAnswer<SessionDeletion>;
export type ProjectDeleteAnswer = DeleteAnswer<ProjectDeletion>;

export interface SidebarProps {
  titles?: Record<string, string>;
  attention?: Record<string, boolean>;
  jobs?: import("../desktopApi").CleanupJob[];
  projects: ProjectView[];
  sessions: Record<SessionId, SessionRuntime>;
  order: SessionId[];
  selectedProjectId: ProjectId | null;
  selectedSessionId: SessionId | null;
  /**
   * Pending approvals per project. The approvals dock shows every project's prompts at once,
   * so this badge is what says *where* one is waiting.
   */
  pendingApprovals?: Record<ProjectId, number>;
  /** Total pending, for the "Approvals" action row. */
  pendingTotal: number;
  appInfo: AppInfo | null;
  claude: ClaudeStatus | null;
  claudeError: AppError | null;
  isMock: boolean;
  /** Dev-only burn panel; rendered inside the sidebar so the feed keeps its full height. */
  dev?: ReactNode;
  onSelectProject: (id: ProjectId) => void;
  onSelectSession: (id: SessionId | null) => void;
  /**
   * Add a project by typed path — the fallback. Resolves to the `AppError` `add_project` refused
   * with, or `null` on success, so the refusal can be drawn beside the field. `void` is accepted
   * so a caller that reports errors some other way is still a valid one.
   */
  onAddProject: (path: string) => void | Promise<AppError | null>;
  /**
   * Open the native directory picker and add whatever comes back — the primary path.
   * **Undefined means there is no picker in this runtime** (a browser), and the "+" falls back to
   * revealing the typed-path field. Resolves `null` both on success and on a *cancelled* picker;
   * a cancel is not an error (`docs/research/tauri-dialog.md` §2).
   */
  onPickProject?: () => Promise<AppError | null>;
  /**
   * Reveal a path in Finder. Undefined outside a Tauri window, and the reveal controls are then
   * not drawn at all rather than drawn dead.
   */
  onReveal?: (path: string) => void;
  /** Remove Brigadier history; preserve repository and worktree files. */
  onDeleteSession?: (
    sessionId: SessionId,
    force: boolean,
  ) => Promise<SessionDeleteAnswer>;
  onDeleteProject?: (
    projectId: ProjectId,
    force: boolean,
  ) => Promise<ProjectDeleteAnswer>;
}

export function Sidebar(props: SidebarProps) {
  const [data, setData] = useState<WorkbenchData>({
    notes: [],
    global: defaultSettings,
    projects: {},
  });
  const [notesOpen, setNotesOpen] = useState(true);
  const [settings, setSettings] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [renaming, setRenaming] = useState<{
    kind: "project" | "note";
    id: string;
    name: string;
  } | null>(null);
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [addPath, setAddPath] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const d = await workbenchApi.load();
        if (live) setData(d);
      } catch (e) {
        if (live) notify(errorMessage(e), true);
      } finally {
        if (live) timer = setTimeout(load, 2500);
      }
    };
    void load();
    const refresh = () => {
      clearTimeout(timer);
      void load();
    };
    const show = () => setSettings(true);
    window.addEventListener("workbench-data-changed", refresh);
    window.addEventListener("brigadier-settings", show);
    return () => {
      live = false;
      clearTimeout(timer);
      window.removeEventListener("workbench-data-changed", refresh);
      window.removeEventListener("brigadier-settings", show);
    };
  }, []);
  const changed = (next: WorkbenchData) => {
    setData(next);
    window.dispatchEvent(new Event("workbench-data-changed"));
  };
  const showNote = (note: Note) =>
    window.dispatchEvent(
      new CustomEvent("workbench-open-note", { detail: note }),
    );
  const newNote = () => {
    const names = new Set(data.notes.map((n) => n.title));
    let title = "Untitled note",
      n = 2;
    while (names.has(title)) title = `Untitled note ${n++}`;
    void workbenchApi
      .saveNote({
        id: crypto.randomUUID(),
        projectId: null,
        title,
        content: "",
        language: "markdown",
        alwaysInclude: false,
        revision: 0,
      })
      .then((note) => {
        changed({ ...data, notes: [...data.notes, note] });
        setNotesOpen(true);
        showNote(note);
      })
      .catch((e) => notify(errorMessage(e), true));
  };
  const rename = async () => {
    if (!renaming || !renaming.name.trim()) return;
    try {
      if (renaming.kind === "project")
        changed(
          await workbenchApi.saveDesktopSettings(data.displayName ?? "", {
            ...data.projectNames,
            [renaming.id]: renaming.name.trim(),
          }),
        );
      else {
        const note = data.notes.find((n) => n.id === renaming.id);
        if (note) {
          const saved = await workbenchApi.saveNote({
            ...note,
            title: renaming.name.trim(),
          });
          changed({
            ...data,
            notes: data.notes.map((n) => (n.id === saved.id ? saved : n)),
          });
        }
      }
      setRenaming(null);
    } catch (e) {
      notify(errorMessage(e), true);
    }
  };
  return (
    <aside className="sidebar desktop-sidebar">
      <div className="sidebar-brand">Brigadier</div>
      <button
        className="sidebar-action"
        onClick={() => window.dispatchEvent(new Event("workbench-new-session"))}
      >
        <ChatCircleIcon />
        New session
      </button>
      <div className="sidebar-section-heading">
        <span>Projects</span>
        <button
          className="icon-button"
          aria-label="Add project"
          onClick={() => {
            if (props.onPickProject)
              void props.onPickProject().then((error) => {
                if (error) {
                  notify(error.message, true);
                  setAddPath("");
                }
              });
            else setAddPath("");
          }}
        >
          <PlusIcon />
        </button>
      </div>
      {addPath !== null && (
        <form
          className="sidebar-add"
          onSubmit={(e) => {
            e.preventDefault();
            void Promise.resolve(props.onAddProject(addPath)).then((error) => {
              if (error) notify(error.message, true);
              else setAddPath(null);
            });
          }}
        >
          <input
            autoFocus
            aria-label="Project path"
            value={addPath}
            onChange={(e) => setAddPath(e.target.value)}
            placeholder="Project folder"
          />
          <button>Add</button>
        </form>
      )}
      <nav className="project-list" aria-label="Projects">
        {props.projects.map((project) => {
          const sessions = Object.values(props.sessions).filter(
            (s) => s.projectId === project.id,
          );
          const busy = sessions.some(working);
          const attention =
            !!props.pendingApprovals?.[project.id] ||
            sessions.some((s) => props.attention?.[s.sessionId]);
          return (
            <div
              className={`project-row ${props.selectedProjectId === project.id ? "selected" : ""}`}
              key={project.id}
            >
              <button
                className="project-select"
                title={project.root_path}
                aria-current={
                  props.selectedProjectId === project.id ? "page" : undefined
                }
                onClick={() => props.onSelectProject(project.id)}
              >
                <FolderIcon />
                <span>{data.projectNames?.[project.id] ?? project.name}</span>
                {busy && (
                  <i
                    className="status-spinner"
                    role="img"
                    aria-label="Working"
                  />
                )}
                {attention && (
                  <i
                    className="attention-dot"
                    role="img"
                    aria-label="Needs attention"
                  />
                )}
              </button>
              <button
                className="icon-button row-menu"
                aria-label={`Project actions ${project.name}`}
                onClick={() =>
                  setProjectMenu(projectMenu === project.id ? null : project.id)
                }
              >
                ···
              </button>
              {projectMenu === project.id && (
                <div className="project-menu">
                  {props.onReveal && (
                    <button
                      onClick={() => {
                        props.onReveal?.(project.root_path);
                        setProjectMenu(null);
                      }}
                    >
                      Reveal in Finder
                    </button>
                  )}
                  {props.onDeleteProject && (
                    <button
                      onClick={() =>
                        setConfirm({
                          title: "Remove project?",
                          body: "Remove this project and its session history from Brigadier. Files on disk stay in place.",
                          confirmLabel: "Remove project",
                          onCancel: () => setConfirm(null),
                          onConfirm: async () => {
                            const result = await props.onDeleteProject!(
                              project.id,
                              false,
                            );
                            if (result.error)
                              throw new Error(result.error.message);
                            setConfirm(null);
                            setProjectMenu(null);
                          },
                        })
                      }
                    >
                      Remove project
                    </button>
                  )}
                </div>
              )}
              <button
                className="icon-button row-menu"
                aria-label={`Rename ${project.name}`}
                onClick={() =>
                  setRenaming({
                    kind: "project",
                    id: project.id,
                    name: data.projectNames?.[project.id] ?? project.name,
                  })
                }
              >
                <PencilSimpleIcon />
              </button>
            </div>
          );
        })}
      </nav>
      <div className="sidebar-section-heading notes-heading">
        <button
          aria-expanded={notesOpen}
          onClick={() => setNotesOpen(!notesOpen)}
        >
          <CaretDownIcon className={notesOpen ? "" : "closed"} />
          Notes
        </button>
        <button className="icon-button" aria-label="Add note" onClick={newNote}>
          <PlusIcon />
        </button>
      </div>
      {notesOpen && (
        <div className="sidebar-notes">
          {data.notesError ? (
            <button
              className="notes-reconnect"
              onClick={() => setSettings(true)}
            >
              Reconnect notes folder
            </button>
          ) : (
            data.notes.map((note) => (
              <div className="note-row" key={note.id}>
                <button className="note-select" onClick={() => showNote(note)}>
                  <NotebookIcon />
                  <span>{note.title}</span>
                </button>
                <button
                  className="icon-button row-menu"
                  aria-label={`Rename note ${note.title}`}
                  onClick={() =>
                    setRenaming({ kind: "note", id: note.id, name: note.title })
                  }
                >
                  <PencilSimpleIcon />
                </button>
                <button
                  className="icon-button row-menu"
                  aria-label={`Delete note ${note.title}`}
                  onClick={() =>
                    setConfirm({
                      title: "Delete note?",
                      body: `“${note.title}” will be removed from your notes folder.`,
                      confirmLabel: "Delete note",
                      onCancel: () => setConfirm(null),
                      onConfirm: async () => {
                        await workbenchApi.deleteNote(note.id);
                        changed({
                          ...data,
                          notes: data.notes.filter((n) => n.id !== note.id),
                        });
                        window.dispatchEvent(
                          new CustomEvent("workbench-note-deleted", {
                            detail: note.id,
                          }),
                        );
                        setConfirm(null);
                      },
                    })
                  }
                >
                  <TrashIcon />
                </button>
              </div>
            ))
          )}
          {!data.notes.length && !data.notesError && (
            <button className="empty-notes" onClick={newNote}>
              Create your first note
            </button>
          )}
        </div>
      )}
      <footer className="sidebar-footer">
        <span className="user-avatar">
          {(data.displayName || "U").slice(0, 1).toUpperCase()}
        </span>
        <span>{data.displayName || "Local user"}</span>
        <button
          className="icon-button"
          aria-label="Settings"
          title="Settings (⌘,)"
          onClick={() => setSettings(true)}
        >
          <GearSixIcon size={21} />
        </button>
      </footer>
      {settings && (
        <DesktopSettings
          data={data}
          onData={changed}
          sessions={props.sessions}
          titles={props.titles ?? {}}
          jobs={props.jobs ?? []}
          onClose={() => setSettings(false)}
        />
      )}
      {renaming && (
        <ConfirmDialog
          title={renaming.kind === "project" ? "Rename project" : "Rename note"}
          body={
            <label>
              Display name
              <input
                autoFocus
                aria-label="New name"
                value={renaming.name}
                onChange={(e) =>
                  setRenaming({ ...renaming, name: e.target.value })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") void rename();
                }}
              />
            </label>
          }
          confirmLabel="Rename"
          onCancel={() => setRenaming(null)}
          onConfirm={rename}
        />
      )}
      {confirm && <ConfirmDialog {...confirm} />}
    </aside>
  );
}
