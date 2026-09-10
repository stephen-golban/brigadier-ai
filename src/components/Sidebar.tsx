import { profiling } from "../perfDiagnostics";
import type { SettingsRequest } from "../settingsNavigation";
import { useSessionNavigation } from "../sessionNavigation";
import { createPortal } from "react-dom";
import { EditProjectDialog } from "./EditProjectDialog";
import { SessionStatus } from "./SessionStatus";
import { BrandMark } from "./BrandMark";
import { DropdownContent } from "./controls/menu";
// Project navigation composed from native controls.
import {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  type Ref,
  type ReactNode,
} from "react";
import {
  Archive,
  Bell,
  Check,
  ChevronRight,
  DotsHorizontal,
  Edit,
  Folder,
  FolderOpen,
  Notepad,
  Pin,
  PinFilled,
  Plus,
  Search,
  Settings,
  Tag,
  X,
} from "../icons";
import type { SessionRuntime } from "../feedStore";
import type {
  AppError,
  AppInfo,
  ClaudeStatus,
  ProjectId,
  ProjectView,
  SessionId,
} from "../wire";
import {
  workbenchApi,
  defaultSettings,
  type WorkbenchData,
} from "../workbenchApi";
import {
  navigationApi,
  useNavigationData,
  isTrashed,
  type TrashKind,
} from "../navigationApi";
import { errorMessage } from "../workspaceApi";
import { notify } from "../desktopApi";
import { working } from "../attention";
import { SoftwareStatus } from "./SoftwareUpdates";
import { DesktopSettings } from "./DesktopSettings";
import { NotesLibrary, type NotesLibraryHandle } from "./NotesLibrary";
import { TrashLibrary } from "./TrashLibrary";
import { ActionDialog, type PendingAction } from "./ActionDialog";
import { Button } from "./controls/button";
import { Input } from "./controls/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./controls/dialog";
import { SearchDialog } from "./controls/search-dialog";
import {
  Sidebar as SidebarPrimitive,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarSectionHeading,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  useSidebar,
} from "./controls/sidebar";
import { Dropdown, Separator } from "./controls/overlay";
import { SidebarReveal } from "./controls/sidebar-reveal";
import { Kbd } from "./controls/kbd";
import { Tooltip } from "./controls/tooltip";
import { useStoredState } from "../workbenchState";

export interface SidebarHandle {
  addProject: () => void;
  leaveNotepad: (next: () => void) => void;
  openNotepad: () => void;
}

export interface SidebarProps {
  ref?: Ref<SidebarHandle>;
  notepadHost?: HTMLElement | null;
  origins?: Record<string, string>;
  onNotepadOpenChange?: (open: boolean) => void;
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
}

// Preserve stored tag identifiers while removing their palette styling.
const projectTags = [
  "red",
  "orange",
  "amber",
  "green",
  "blue",
  "violet",
  "pink",
];
export function Sidebar(props: SidebarProps) {
  const { data: navigation, error: navigationError } = useNavigationData();
  const { isMobile, setOpenMobile, setCurrentSession } = useSidebar();
  const [data, setData] = useState<WorkbenchData>({
    notes: [],
    global: defaultSettings,
    projects: {},
  });
  const [expanded, setExpanded] = useStoredState<Record<string, boolean>>(
    "brigadier:project-expanded:v1",
    {},
  );
  const [pinnedOpen, setPinnedOpen] = useStoredState(
    "brigadier:pinned-open:v1",
    true,
  );
  const [projectsOpen, setProjectsOpen] = useStoredState(
    "brigadier:projects-open:v1",
    true,
  );
  const [chatsOpen, setChatsOpen] = useStoredState("brigadier:chats-open:v1", true);
  const [pinnedProjects, setPinnedProjects] = useStoredState<string[]>(
    "brigadier:pinned-projects:v1",
    [],
  );
  const { archivedIds } = useSessionNavigation();
  const [settingsRequest, setSettingsRequest] = useState<SettingsRequest>({});
  const [all, setAll] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState(false),
    [notes, setNotes] = useState(false),
    [trash, setTrash] = useState(false),
    [search, setSearch] = useState(false);
  const showSettings = () => { setSettingsRequest({}); setSettings(true); };
  const notepad = useRef<NotesLibraryHandle>(null);
  useEffect(
    () => props.onNotepadOpenChange?.(notes),
    [notes, props.onNotepadOpenChange],
  );
  const closeNotepad = (next: () => void) => {
    const done = () => {
      setNotes(false);
      setNewNote(false);
      next();
    };
    if (notes) notepad.current?.leave(done);
    else done();
  };
  useEffect(() => {
    const view = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      setSettings(false);
      closeNotepad(() => props.onSelectSession(id));
    };
    window.addEventListener("brigadier-view-chat", view);
    return () => window.removeEventListener("brigadier-view-chat", view);
  });
  const openNotepad = (id?: string, create = false) => {
    if (notes) notepad.current?.open(id, create);
    else {
      setNoteId(id);
      setNewNote(create);
      setNotes(true);
    }
    if (isMobile) setOpenMobile(false);
  };
  useImperativeHandle(props.ref, () => ({
    addProject: () => { void addProject(); },
    leaveNotepad: closeNotepad,
    openNotepad,
  }));
  const [newNote, setNewNote] = useState(false);
  const [noteId, setNoteId] = useState<string | undefined>();
  const [action, setAction] = useState<PendingAction | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [addPath, setAddPath] = useState<string | null>(null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    let live = true,
      revision = 0;
    const refresh = () => {
      const request = ++revision;
      void workbenchApi
        .load()
        .then((d) => {
          if (live && request === revision) setData(d);
        })
        .catch((e) => {
          if (live) setError(errorMessage(e));
        });
    };
    refresh();
    const timer = setInterval(refresh, 2500);
    const show = (event: Event) => { setSettingsRequest((event as CustomEvent<SettingsRequest>).detail ?? {}); setSettings(true); };
    const key = (e: KeyboardEvent) => {
      if (document.querySelector(".desktop-settings")) return;
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        setSearch((s) => !s);
      }
    };
    window.addEventListener("workbench-data-changed", refresh);
    window.addEventListener("brigadier-settings", show);
    window.addEventListener("keydown", key);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("workbench-data-changed", refresh);
      window.removeEventListener("brigadier-settings", show);
      window.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    const open = () => openNotepad();
    window.addEventListener("brigadier-open-notes", open);
    return () => window.removeEventListener("brigadier-open-notes", open);
  });
  const changed = (next: WorkbenchData) => {
    setData(next);
    window.dispatchEvent(new Event("workbench-data-changed"));
  };
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const selectProject = (id: string) =>
    closeNotepad(() => {
      props.onSelectProject(id);
      closeMobile();
    });
  const selectSession = (id: string) =>
    closeNotepad(() => {
      props.onSelectSession(id);
      closeMobile();
    });
  const addProject = async () => {
    if (busy) return;
    setError("");
    if (!props.onPickProject) {
      setAddPath("");
      return;
    }
    setBusy(true);
    try {
      const e = await props.onPickProject();
      if (e) {
        setError(e.message);
        setAddPath("");
      }
    } catch (e) {
      setError(errorMessage(e));
      setAddPath("");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const start = () => {
      if (!props.projects.length) void addProject();
    };
    window.addEventListener("brigadier-onboarding-complete", start);
    return () =>
      window.removeEventListener("brigadier-onboarding-complete", start);
  }, [props.projects.length, props.onPickProject]);
  const customize = (
    kind: "color" | "pin",
    id: string,
    value: string | null,
  ) => {
    void navigationApi
      .customize(kind, id, value)
      .catch((e) => notify(errorMessage(e), true));
  };
  const rename = async () => {
    if (!renaming || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await navigationApi.customize("name", renaming.id, renaming.name);
      setRenaming(null);
      setData(await workbenchApi.load());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const moveToTrash = async (kind: TrashKind, id: string) => {
    try {
      const plan = await navigationApi.preview(kind, id);
      setAction({
        title: plan.running.length
          ? "Stop and move to Trash?"
          : "Move to Trash?",
        label: plan.running.length ? "Stop and move to Trash" : "Move to Trash",
        destructive: true,
        description: (
          <div className="space-y-2">
            <p>
              “{plan.entry.title}” can be restored from Trash. Repository files
              and worktrees stay on disk.
            </p>
            {plan.running.length > 0 && (
              <>
                <p>These running sessions will stop first:</p>
                <ul className="max-h-44 list-disc overflow-auto pl-5">
                  {plan.running.map((s) => (
                    <li key={s}>{props.titles?.[s] ?? s}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ),
        run: async () => {
          await navigationApi.move(plan);
          window.dispatchEvent(
            new CustomEvent("workbench-items-trashed", { detail: plan.entry }),
          );
        },
      });
    } catch (e) {
      notify(errorMessage(e), true);
    }
  };
  const activeProjects = props.projects
    .filter((p) => !p.projectless && !isTrashed(navigation, "project", p.id))
    .sort(
      (a, b) =>
        Number(pinnedProjects.includes(b.id)) -
        Number(pinnedProjects.includes(a.id)),
    );
  const activeSessions = Object.values(props.sessions).filter(
    (s) =>
      !props.origins?.[s.sessionId] &&
      !isTrashed(navigation, "session", s.sessionId) &&
      !isTrashed(navigation, "project", s.projectId),
  );
  const title = (id: string) => props.titles?.[id] ?? `Session ${id.slice(-6)}`;
  /**
   * The collapsed workspace chrome shows the current session's title beside a folder glyph
   * (`docs/research/codex-sidebar.md` §4.10). `SidebarProvider` owns that bar and has no access
   * to session data, so the label is published up to it from here — using the same lookup
   * `ProjectWorkbench.tsx` makes around lines 1064-1071 (`peers.titles[id]`, which arrives here
   * as `props.titles`, with a `Session <last6>` fallback), so the two can never disagree.
   */
  useEffect(() => {
    setCurrentSession(
      props.selectedSessionId ? title(props.selectedSessionId) : null,
    );
  }, [props.selectedSessionId, props.titles, setCurrentSession]);
  const projectName = (p: ProjectView) => p.projectless ? "Chats" : data.projectNames?.[p.id] ?? p.name;
  const pinSession = (id: string) =>
    customize(
      "pin",
      id,
      navigation.pinnedSessions.includes(id) ? null : "pinned",
    );
  const archiveSession = (id: string) => {
    window.dispatchEvent(new CustomEvent("workbench-archive-session", { detail: { sessionId: id } }));
  };
  const visibleSessions = activeSessions.filter(
    (s) => !archivedIds.includes(s.sessionId),
  );
  const projectlessIds = new Set(props.projects.filter(project => project.projectless).map(project => project.id));
  const chats = visibleSessions.filter(session => session.projectId !== null && projectlessIds.has(session.projectId))
    .sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0));
  const newSession = (projectId: string) =>
    closeNotepad(() => {
      props.onSelectProject(projectId);
      setExpanded((old) => ({ ...old, [projectId]: true }));
      window.dispatchEvent(
        new CustomEvent("brigadier-new-project-session", { detail: projectId }),
      );
      closeMobile();
    });
  /** A global new chat starts without a project, including on an empty installation. */
  const startNewChat = () => {
    closeNotepad(() => {
      window.dispatchEvent(
        new CustomEvent("brigadier-new-project-session", { detail: null }),
      );
      closeMobile();
    });
  };
  useEffect(() => {
    window.addEventListener("brigadier-new-chat", startNewChat);
    const key = (event: KeyboardEvent) => {
      if (document.querySelector(".desktop-settings")) return;
      const command = navigator.platform.startsWith("Mac")
        ? event.metaKey
        : event.ctrlKey;
      if (
        !command ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "n" ||
        document.querySelector('dialog[open], [role="dialog"]')
      )
        return;
      event.preventDefault();
      if (!event.repeat) startNewChat();
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("brigadier-new-chat", startNewChat);
      window.removeEventListener("keydown", key);
    };
  });
  const sessionRow = (s: SessionRuntime) => {
    const pinned = navigation.pinnedSessions.includes(s.sessionId);
    const project = props.projects.find((p) => p.id === s.projectId);
    return (
      <SidebarMenuSubItem key={s.sessionId} className="group/session">
        <Tooltip
          className="w-full"
          onlyWhenTruncated=".session-label"
          placement="right"
          content={
            <div className="w-72 max-w-full space-y-2 py-1">
              <div className="flex items-start gap-3">
                <span className="min-w-0 flex-1 break-words text-[13px] text-text">
                  {title(s.sessionId)}
                </span>
                <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                  <SessionStatus
                    attention={props.attention?.[s.sessionId]}
                    working={working(s)}
                  />
                </span>
              </div>
              <div className="flex items-center gap-2 text-text-secondary">
                <Folder className="size-4" />
                <span className="min-w-0 break-words">
                  {project ? projectName(project) : "Project"}
                </span>
              </div>
            </div>
          }
        >
          <SidebarMenuSubButton
            isActive={!notes && props.selectedSessionId === s.sessionId}
            className="session-row"
            onClick={() => selectSession(s.sessionId)}
          >
            <span className="session-label text-fade-truncate min-w-0 flex-1 text-left text-text">
              {title(s.sessionId)}
            </span>
            <span className="session-indicator absolute top-0 right-1 flex h-7 w-6 items-center justify-center">
              <SessionStatus
                attention={props.attention?.[s.sessionId]}
                working={working(s)}
              />
            </span>
          </SidebarMenuSubButton>
        </Tooltip>
        <Tooltip
          content={pinned ? "Unpin session" : "Pin session"}
          className="absolute top-0 right-7 h-7 w-6 items-center justify-center"
        >
          <SidebarMenuAction
            showOnHover
            className="relative right-auto"
            aria-label={`${pinned ? "Unpin" : "Pin"} ${title(s.sessionId)}`}
            disabled={s.sessionId.startsWith("starting:")}
            onClick={() => pinSession(s.sessionId)}
          >
            {pinned ? (
              <PinFilled className="size-3.5" />
            ) : (
              <Pin className="size-3.5" />
            )}
          </SidebarMenuAction>
        </Tooltip>
        <Tooltip
          content="Archive session"
          className="absolute top-0 right-1 h-7 w-6 items-center justify-center"
        >
          <SidebarMenuAction
            showOnHover
            className="relative right-auto"
            aria-label={`Archive ${title(s.sessionId)}`}
            disabled={s.sessionId.startsWith("starting:")}
            onClick={() => archiveSession(s.sessionId)}
          >
            <Archive className="size-3.5" />
          </SidebarMenuAction>
        </Tooltip>
      </SidebarMenuSubItem>
    );
  };
  return (
    <>
      <SidebarPrimitive collapsible="offcanvas" aria-label="Main navigation">
        <SidebarHeader>
          <div
            className="navigation-title mb-4 flex h-8 items-center gap-2 text-[17px] font-semibold"
            data-tauri-drag-region="deep"
          >
            <span aria-hidden="true" className="flex size-4 shrink-0 items-center">
              <BrandMark className="brand-mark size-4 shrink-0 fill-current" />
            </span>
            <span>Brigadier</span>
            <div className="ml-auto flex items-center gap-1">
              <Tooltip
                content={
                  <>
                    Search{" "}
                    <Kbd>
                      {navigator.platform.startsWith("Mac") ? "⌘K" : "Ctrl K"}
                    </Kbd>
                  </>
                }
              >
                <Button
                  isIconOnly
                  aria-label="Search"
                  aria-keyshortcuts={
                    navigator.platform.startsWith("Mac")
                      ? "Meta+K"
                      : "Control+K"
                  }
                  className="navigation-icon-button"
                  onClick={() => setSearch(true)}
                >
                  <Search />
                </Button>
              </Tooltip>
              <Dropdown>
                <Button
                  isIconOnly
                  aria-label="Notifications"
                  className="navigation-icon-button relative"
                >
                  <Bell />
                  {(props.pendingTotal > 0 ||
                    Object.values(props.attention ?? {}).some(Boolean)) && (
                    <span className="absolute top-1 right-1 size-1.5 rounded-full bg-attention" />
                  )}
                </Button>
                <DropdownContent className="w-64">
                  {activeSessions
                    .filter((session) => props.attention?.[session.sessionId])
                    .map((session) => (
                      <Dropdown.Item
                        key={session.sessionId}
                        onAction={() => selectSession(session.sessionId)}
                      >
                        <span className="truncate">
                          {title(session.sessionId)}
                        </span>
                      </Dropdown.Item>
                    ))}
                  {!activeSessions.some(
                    (session) => props.attention?.[session.sessionId],
                  ) && (
                    <div className="px-3 py-2 text-text-secondary">
                      {props.pendingTotal
                        ? `${props.pendingTotal} pending approval${props.pendingTotal === 1 ? "" : "s"}`
                        : "You're all caught up"}
                    </div>
                  )}
                </DropdownContent>
              </Dropdown>
            </div>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <Tooltip
                className="w-full"
                content={
                  <>
                    New chat{" "}
                    <Kbd>
                      {navigator.platform.startsWith("Mac") ? "⌘N" : "Ctrl N"}
                    </Kbd>
                  </>
                }
              >
                <SidebarMenuButton
                  onClick={startNewChat}
                  className="text-text [&_svg]:text-text"
                  aria-label="New chat"
                  aria-keyshortcuts={
                    navigator.platform.startsWith("Mac")
                      ? "Meta+N"
                      : "Control+N"
                  }
                >
                  <span className="flex size-4 items-center justify-center">
                    <Edit className="size-3.5" />
                  </span>
                  <span>New chat</span>
                </SidebarMenuButton>
              </Tooltip>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {navigationError && (
            <p role="alert" className="navigation-notice text-error">
              {navigationError}
            </p>
          )}
          {navigation.pinnedSessions.some((id) =>
            visibleSessions.some((s) => s.sessionId === id),
          ) && (
            <SidebarGroup>
              <SidebarSectionHeading
                label="Pinned"
                open={pinnedOpen}
                controls="sidebar-pinned"
                onToggle={() => setPinnedOpen((open) => !open)}
              />
              <SidebarReveal open={pinnedOpen} id="sidebar-pinned">
                <SidebarMenu>
                  {navigation.pinnedSessions
                    .map((id) =>
                      visibleSessions.find((s) => s.sessionId === id),
                    )
                    .filter((s): s is SessionRuntime => !!s)
                    .map(sessionRow)}
                </SidebarMenu>
              </SidebarReveal>
            </SidebarGroup>
          )}
          <SidebarGroup>
            <div className="group/section relative">
              <SidebarSectionHeading
                label="Projects"
                open={projectsOpen}
                controls="sidebar-projects"
                onToggle={() => setProjectsOpen((open) => !open)}
              />
              <SidebarMenuAction
                className="section-action right-2"
                aria-label="Add project"
                title="Add project"
                disabled={busy}
                onClick={() => void addProject()}
              >
                <Plus />
              </SidebarMenuAction>
            </div>
            <SidebarReveal open={projectsOpen} id="sidebar-projects">
              <SidebarGroupContent role="navigation" aria-label="Projects">
                <SidebarMenu>
                  {activeProjects.map((project) => {
                    const sessions = visibleSessions
                      .filter((s) => s.projectId === project.id)
                      .sort(
                        (a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0),
                      );
                    const open =
                      expanded[project.id] ??
                      props.selectedProjectId === project.id;
                    const selected = props.selectedProjectId === project.id;
                    const toggle = () =>
                      setExpanded((old) => ({ ...old, [project.id]: !open }));
                    return (
                      <SidebarMenuItem key={project.id}>
                        <div className="group/project relative">
                          <SidebarMenuButton
                            isActive={
                              !notes && selected && !props.selectedSessionId
                            }
                            className="project-row"
                            title={project.root_path}
                            aria-expanded={open}
                            aria-controls={`project-sessions-${project.id}`}
                            aria-current={selected ? "page" : undefined}
                            onClick={() => {
                              toggle();
                              selectProject(project.id);
                            }}
                          >
                            <span className="size-4 shrink-0" />
                            <span className="project-label text-fade-truncate min-w-0 flex-1 text-left text-text">
                              {projectName(project)}
                            </span>
                            {navigation.projectColors[project.id] && (
                              <span
                                aria-label={`${navigation.projectColors[project.id]} project tag`}
                                className="sr-only"
                              />
                            )}
                            {!open && (
                              <span className="project-indicator">
                                <SessionStatus
                                  attention={
                                    !!props.pendingApprovals?.[project.id] ||
                                    sessions.some(
                                      (s) => props.attention?.[s.sessionId],
                                    )
                                  }
                                  working={sessions.some(working)}
                                />
                              </span>
                            )}
                          </SidebarMenuButton>
                          <button
                            type="button"
                            className="folder-toggle absolute top-0 left-1 flex h-8 w-6 items-center justify-center text-text-secondary hover:text-text"
                            aria-label={`${open ? "Collapse" : "Expand"} ${projectName(project)}`}
                            aria-expanded={open}
                            aria-controls={`project-sessions-${project.id}`}
                            onClick={toggle}
                          >
                            {open ? (
                              <FolderOpen className="size-4" />
                            ) : (
                              <Folder className="size-4" />
                            )}
                          </button>
                          <Dropdown native>
                            <SidebarMenuAction
                              showOnHover
                              className="right-7"
                              aria-label={`Project actions ${projectName(project)}`}
                              title="Project actions"
                            >
                              <DotsHorizontal className="size-3.5" />
                            </SidebarMenuAction>
                            <DropdownContent
                              className="w-[280px]"
                              side={isMobile ? "bottom" : "right"}
                              align="start"
                            >
                              <Tooltip
                                content={
                                  pinnedProjects.includes(project.id)
                                    ? "Unpin project"
                                    : "Pin project"
                                }
                                className="w-full"
                              >
                                <Dropdown.Item
                                  nativeIcon={
                                    pinnedProjects.includes(project.id) ? <PinFilled className="size-4" /> : <Pin className="size-4" />
                                  }
                                  onAction={() =>
                                    setPinnedProjects((ids) =>
                                      ids.includes(project.id)
                                        ? ids.filter((id) => id !== project.id)
                                        : [...ids, project.id],
                                    )
                                  }
                                >
                                  {pinnedProjects.includes(project.id) ? <PinFilled className="size-4" /> : <Pin className="size-4" />}
                                  {pinnedProjects.includes(project.id)
                                    ? "Unpin"
                                    : "Pin"}
                                </Dropdown.Item>
                              </Tooltip>
                              <Dropdown.Item
                                nativeIcon={<Settings />}
                                onAction={() => {
                                  setError("");
                                  setRenaming({
                                    id: project.id,
                                    name: projectName(project),
                                  });
                                }}
                              >
                                <Settings />
                                Edit
                              </Dropdown.Item>
                              <Dropdown.Item
                                onAction={() => newSession(project.id)}
                              >
                                <Edit className="size-3.5" />
                                New chat
                              </Dropdown.Item>
                              {props.onReveal && (
                                <Dropdown.Item
                                  onAction={() =>
                                    props.onReveal?.(project.root_path)
                                  }
                                >
                                  <FolderOpen className="size-4" />
                                  Reveal in Finder
                                </Dropdown.Item>
                              )}
                              <Separator />
                              <Dropdown.SubmenuTrigger>
                                <Dropdown.Item>
                                  <Tag />
                                  Project tag
                                  <ChevronRight className="ml-auto" />
                                </Dropdown.Item>
                                <DropdownContent className="w-48">
                                  {projectTags.map((name) => (
                                    <Dropdown.Item
                                      key={name}
                                      id={`color:${name}`}
                                      textValue={`${name} tag`}
                                      checked={
                                        navigation.projectColors[project.id] ===
                                        name
                                      }
                                      onAction={() =>
                                        customize("color", project.id, name)
                                      }
                                    >
                                      <span className="flex size-4 items-center">
                                        {navigation.projectColors[
                                          project.id
                                        ] === name && <Check />}
                                      </span>
                                      {name} tag
                                    </Dropdown.Item>
                                  ))}
                                  <Separator />
                                  <Dropdown.Item
                                    onAction={() =>
                                      customize("color", project.id, null)
                                    }
                                  >
                                    <X />
                                    No color
                                  </Dropdown.Item>
                                </DropdownContent>
                              </Dropdown.SubmenuTrigger>
                              <Separator />
                              <Dropdown.Item
                                nativeIcon={<X />}
                                onAction={() =>
                                  void moveToTrash("project", project.id)
                                }
                              >
                                <X />
                                Remove project
                              </Dropdown.Item>
                            </DropdownContent>
                          </Dropdown>
                          <SidebarMenuAction
                            showOnHover
                            aria-label={`New session in ${projectName(project)}`}
                            title="New chat"
                            onClick={() => newSession(project.id)}
                          >
                            <Edit className="size-3.5" />
                          </SidebarMenuAction>
                        </div>
                        <SidebarReveal
                          open={open}
                          id={`project-sessions-${project.id}`}
                        >
                          <SidebarMenuSub>
                            {(all.has(project.id)
                              ? sessions
                              : sessions.slice(0, 5)
                            ).map(sessionRow)}
                            {sessions.length > 5 && (
                              <SidebarMenuSubItem>
                                <SidebarMenuSubButton
                                  onClick={() =>
                                    setAll((old) => {
                                      const next = new Set(old);
                                      if (next.has(project.id))
                                        next.delete(project.id);
                                      else next.add(project.id);
                                      return next;
                                    })
                                  }
                                >
                                  {all.has(project.id)
                                    ? "Show less"
                                    : `Show more (${sessions.length - 5})`}
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            )}
                            {!sessions.length && (
                              <li className="navigation-empty">No chats</li>
                            )}
                          </SidebarMenuSub>
                        </SidebarReveal>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
              {!activeProjects.length && (
                <p className="navigation-empty">No projects imported.</p>
              )}
              {error && addPath === null && !renaming && (
                <p role="alert" className="navigation-notice text-error">
                  {error}
                </p>
              )}
            </SidebarReveal>
          </SidebarGroup>
          {chats.length > 0 && <SidebarGroup>
            <SidebarSectionHeading label="Chats" open={chatsOpen} controls="sidebar-chats" onToggle={() => setChatsOpen(open => !open)} />
            <SidebarReveal open={chatsOpen} id="sidebar-chats">
              <SidebarGroupContent role="navigation" aria-label="Chats">
                <SidebarMenu>{chats.map(sessionRow)}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarReveal>
          </SidebarGroup>}
          {props.dev}
        </SidebarContent>
        <SidebarFooter>
          <Tooltip
            content={
              <>
                Settings{" "}
                <Kbd>
                  {navigator.platform.startsWith("Mac") ? "⌘," : "Ctrl ,"}
                </Kbd>
              </>
            }
          >
            <Button
              isIconOnly
              className="navigation-icon-button"
              aria-label="Settings"
              aria-keyshortcuts={
                navigator.platform.startsWith("Mac") ? "Meta+," : "Control+,"
              }
              onClick={showSettings}
            >
              <Settings />
            </Button>
          </Tooltip>
          <Tooltip content="Notepad">
            <Button isIconOnly className="navigation-icon-button text-text" aria-label="Notepad" aria-pressed={notes} onClick={() => openNotepad()}>
              <Notepad />
            </Button>
          </Tooltip>
          <SoftwareStatus />
        </SidebarFooter>
      </SidebarPrimitive>
      {renaming && (
        <EditProjectDialog
          name={renaming.name}
          busy={busy}
          error={error}
          onNameChange={(name) => setRenaming({ ...renaming, name })}
          onSave={() => void rename()}
          onClose={() => {
            if (!saving.current) {
              setRenaming(null);
              setError("");
            }
          }}
          onRemove={() => {
            const id = renaming.id;
            setRenaming(null);
            setError("");
            void moveToTrash("project", id);
          }}
        />
      )}
      <SearchDialog
        open={search}
        onOpenChange={setSearch}
        groups={[
          {
            label: "Navigation",
            items: [
              {
                id: "new-chat",
                search: "New chat",
                content: (
                  <>
                    <Edit className="size-3.5" />
                    <span>New chat</span>
                    <Kbd className="ml-auto">
                      {navigator.platform.startsWith("Mac") ? "⌘N" : "Ctrl N"}
                    </Kbd>
                  </>
                ),
                onSelect: () => {
                  setSearch(false);
                  startNewChat();
                },
              },
              {
                id: "notepad",
                search: "Notepad notes",
                content: (
                  <>
                    <Notepad className="size-4" />
                    <span>Notepad</span>
                  </>
                ),
                onSelect: () => {
                  setSearch(false);
                  openNotepad();
                },
              },
              {
                id: "settings",
                search: "Settings",
                content: (
                  <>
                    <Settings />
                    <span>Settings</span>
                  </>
                ),
                onSelect: () => {
                  setSearch(false);
                  showSettings();
                },
              },
            ],
          },
          {
            label: "Projects",
            items: activeProjects.map((p) => ({
              id: `project:${p.id}`,
              search: `${p.id} ${projectName(p)}`,
              content: (
                <>
                  <Folder className="size-4" />
                  {projectName(p)}
                </>
              ),
              onSelect: () => {
                selectProject(p.id);
                setSearch(false);
              },
            })),
          },
          {
            label: "Sessions",
            items: activeSessions.map((s) => ({
              id: `session:${s.sessionId}`,
              search: `${s.sessionId} ${title(s.sessionId)} ${activeProjects.find((p) => p.id === s.projectId)?.name ?? ""}`,
              content: (
                <>
                  <Edit className="size-3.5" />
                  <span className="truncate">{title(s.sessionId)}</span>
                </>
              ),
              onSelect: () => {
                selectSession(s.sessionId);
                setSearch(false);
              },
            })),
          },
          {
            label: "Notes",
            items: data.notes
              .filter((n) => !isTrashed(navigation, "note", n.id))
              .map((n) => ({
                id: `note:${n.id}`,
                search: `${n.id} ${n.title}`,
                content: (
                  <>
                    <Notepad className="size-4" />
                    {n.title}
                  </>
                ),
                onSelect: () => {
                  openNotepad(n.id);
                  setSearch(false);
                },
              })),
          },
        ]}
      />

      <Dialog
        open={addPath !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAddPath(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add project</DialogTitle>
            <DialogDescription>
              Choose the repository folder to open in Brigadier.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || !addPath?.trim()) return;
              setBusy(true);
              setError("");
              void Promise.resolve(props.onAddProject(addPath.trim()))
                .then((result) => {
                  if (result) setError(result.message);
                  else setAddPath(null);
                })
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            <Input
              autoFocus
              aria-label="Project path"
              placeholder="Project folder"
              value={addPath ?? ""}
              onChange={(e) => setAddPath(e.target.value)}
              disabled={busy}
            />
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
            <Button disabled={busy || !addPath?.trim()} type="submit">
              {busy ? "Adding…" : "Add"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      {settings && (
        <DesktopSettings
          data={data}
          onData={changed}
          sessions={Object.fromEntries(
            Object.entries(props.sessions).filter(
              ([id]) => !isTrashed(navigation, "session", id),
            ),
          )}
          projects={props.projects}
          origins={props.origins ?? {}}
          request={settingsRequest}
          titles={props.titles ?? {}}
          jobs={props.jobs ?? []}
          onOpenTrash={() => { setSettings(false); setTrash(true); }}
          onClose={() => setSettings(false)}
        />
      )}
      {notes &&
        (() => {
          const page = (
            <NotesLibrary
              ref={notepad}
              data={data}
              navigation={navigation}
              initialId={noteId}
              initialNew={newNote}
              onData={changed}
            />
          );
          return props.notepadHost
            ? createPortal(page, props.notepadHost)
            : page;
        })()}
      {trash && (
        <TrashLibrary data={navigation} onClose={() => setTrash(false)} />
      )}
      {action && (
        <ActionDialog action={action} onClose={() => setAction(null)} />
      )}
    </>
  );
}

if (profiling) Sidebar.displayName = "Sidebar";
