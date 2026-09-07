// Sidebar-10 composition adapted from shadcn/ui. See THIRD_PARTY_NOTICES.md.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight,
  FileText,
  Folder,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Pin,
  Trash2,
  Pencil,
  Check,
  X,
} from "lucide-react";
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
import { DesktopSettings } from "./DesktopSettings";
import { BrandMark } from "./BrandMark";
import { NotesLibrary } from "./NotesLibrary";
import { TrashLibrary } from "./TrashLibrary";
import { ActionDialog, type PendingAction } from "./ActionDialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "./ui/command";
import {
  Sidebar as SidebarPrimitive,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarRail,
  useSidebar,
} from "./ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "./ui/dropdown-menu";
import { useStoredState } from "../workbenchState";

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

}

const colors: Record<string, string> = {
  red: "#ef4444",
  orange: "#f97316",
  amber: "#fbbf24",
  green: "#22c55e",
  blue: "#3b82f6",
  violet: "#8b5cf6",
  pink: "#ec4899",
};
const icons = new Map<string, Promise<string | null>>();
function ProjectIcon({ project }: { project: ProjectView }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const key = `${project.id}:${project.root_path}`;
    if (!icons.has(key))
      icons.set(
        key,
        navigationApi.icon(project.id).catch(() => null),
      );
    void icons.get(key)!.then((value) => {
      if (live) setSrc(value);
    });
    return () => {
      live = false;
    };
  }, [project.id, project.root_path]);
  return src ? (
    <img
      src={src}
      alt=""
      className="size-4 shrink-0 object-contain"
      onError={() => setSrc(null)}
    />
  ) : (
    <Folder className="size-4 shrink-0" />
  );
}
export function Sidebar(props: SidebarProps) {
  const { data: navigation, error: navigationError } = useNavigationData();
  const { isMobile, setOpenMobile } = useSidebar();
  const [data, setData] = useState<WorkbenchData>({
    notes: [],
    global: defaultSettings,
    projects: {},
  });
  const [expanded, setExpanded] = useStoredState<Record<string, boolean>>(
    "brigadier:project-expanded:v1",
    {},
  );
  const [all, setAll] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState(false),
    [notes, setNotes] = useState(false),
    [trash, setTrash] = useState(false),
    [search, setSearch] = useState(false);
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
    const show = () => setSettings(true);
    const openNotes = () => {
      setNoteId(undefined);
      setNotes(true);
    };
    const key = (e: KeyboardEvent) => {
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
    window.addEventListener("brigadier-open-notes", openNotes);
    window.addEventListener("keydown", key);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("workbench-data-changed", refresh);
      window.removeEventListener("brigadier-settings", show);
      window.removeEventListener("brigadier-open-notes", openNotes);
      window.removeEventListener("keydown", key);
    };
  }, []);
  const changed = (next: WorkbenchData) => {
    setData(next);
    window.dispatchEvent(new Event("workbench-data-changed"));
  };
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const selectProject = (id: string) => {
    props.onSelectProject(id);
    closeMobile();
  };
  const selectSession = (id: string) => {
    props.onSelectSession(id);
    closeMobile();
  };
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
  const activeProjects = props.projects.filter(
    (p) => !isTrashed(navigation, "project", p.id),
  );
  const activeSessions = Object.values(props.sessions).filter(
    (s) =>
      !isTrashed(navigation, "session", s.sessionId) &&
      !isTrashed(navigation, "project", s.projectId),
  );
  const title = (id: string) => props.titles?.[id] ?? `Session ${id.slice(-6)}`;
  const projectName = (p: ProjectView) => data.projectNames?.[p.id] ?? p.name;
  const sessionRow = (s: SessionRuntime, pinned = false) => (
    <SidebarMenuSubItem key={s.sessionId} className="group/session relative">
      <SidebarMenuSubButton
        asChild
        isActive={props.selectedSessionId === s.sessionId}
        className="pr-8"
      >
        <button
          onClick={() => selectSession(s.sessionId)}
          title={title(s.sessionId)}
        >
          {pinned && <Pin className="size-3" />}
          <span className="truncate">{title(s.sessionId)}</span>
          {working(s) && (
            <i className="status-spinner" role="img" aria-label="Working" />
          )}
          {props.attention?.[s.sessionId] && (
            <i
              className="attention-dot"
              role="img"
              aria-label="Needs attention"
            />
          )}
        </button>
      </SidebarMenuSubButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            showOnHover
            aria-label={`Session actions ${title(s.sessionId)}`}
          >
            <MoreHorizontal />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side={isMobile ? "bottom" : "right"} align="start">
          <DropdownMenuItem
            onSelect={() =>
              customize(
                "pin",
                s.sessionId,
                navigation.pinnedSessions.includes(s.sessionId)
                  ? null
                  : "pinned",
              )
            }
          >
            <Pin />
            {navigation.pinnedSessions.includes(s.sessionId)
              ? "Unpin session"
              : "Pin session"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => void moveToTrash("session", s.sessionId)}
          >
            <Trash2 />
            Move to Trash
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuSubItem>
  );
  return (
    <>
      <SidebarPrimitive
        className="border-r-0"
        collapsible="offcanvas"
        aria-label="Main navigation"
      >
        <SidebarHeader>
          <div
            className="flex h-12 items-center gap-2 px-2 font-semibold"
            data-tauri-drag-region
          >
            <BrandMark className="size-6 shrink-0" />
            <span>Brigadier</span>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => setSearch(true)}>
                <Search />
                <span>Search</span>
                <kbd className="ml-auto text-xs text-muted-foreground">⌘K</kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {navigationError && (
            <p role="alert" className="px-4 text-xs text-destructive">
              {navigationError}
            </p>
          )}
          {navigation.pinnedSessions.some((id) =>
            activeSessions.some((s) => s.sessionId === id),
          ) && (
            <SidebarGroup>
              <SidebarGroupLabel>Pinned</SidebarGroupLabel>
              <SidebarMenu>
                {navigation.pinnedSessions
                  .map((id) => activeSessions.find((s) => s.sessionId === id))
                  .filter((s): s is SessionRuntime => !!s)
                  .map((s) => sessionRow(s, true))}
              </SidebarMenu>
            </SidebarGroup>
          )}
          <SidebarGroup>
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-1 right-2 size-7"
              aria-label="Add project"
              disabled={busy}
              onClick={() => void addProject()}
            >
              <Plus />
            </Button>
            <SidebarGroupContent role="navigation" aria-label="Projects">
              <SidebarMenu>
                {activeProjects.map((project) => {
                  const sessions = activeSessions
                    .filter((s) => s.projectId === project.id)
                    .sort(
                      (a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0),
                    );
                  const open =
                    expanded[project.id] ??
                    props.selectedProjectId === project.id;
                  const selected = props.selectedProjectId === project.id;
                  return (
                    <Collapsible
                      key={project.id}
                      open={open}
                      onOpenChange={(value) =>
                        setExpanded((old) => ({ ...old, [project.id]: value }))
                      }
                      asChild
                    >
                      <SidebarMenuItem className="group/project">
                        {renaming?.id === project.id ? (
                          <div className="flex items-center gap-1">
                            <Input
                              autoFocus
                              aria-label="New name"
                              value={renaming.name}
                              maxLength={200}
                              disabled={busy}
                              onChange={(e) =>
                                setRenaming({
                                  ...renaming,
                                  name: e.target.value,
                                })
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void rename();
                                }
                                if (e.key === "Escape") setRenaming(null);
                              }}
                              onFocus={(e) => e.currentTarget.select()}
                              className="h-8"
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-label="Save project name"
                              disabled={busy}
                              onClick={() => void rename()}
                            >
                              <Check />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-label="Cancel rename"
                              disabled={busy}
                              onClick={() => setRenaming(null)}
                            >
                              <X />
                            </Button>
                          </div>
                        ) : (
                          <>
                            <SidebarMenuButton
                              isActive={selected}
                              className="pr-16"
                              title={project.root_path}
                              aria-current={selected ? "page" : undefined}
                              onClick={() => selectProject(project.id)}
                              onDoubleClick={() =>
                                setRenaming({
                                  id: project.id,
                                  name: projectName(project),
                                })
                              }
                            >
                              <ProjectIcon project={project} />
                              <span>{projectName(project)}</span>
                              {navigation.projectColors[project.id] && (
                                <span
                                  aria-label={`${navigation.projectColors[project.id]} project tag`}
                                  className="size-2 shrink-0 rounded-full"
                                  style={{
                                    backgroundColor:
                                      colors[
                                        navigation.projectColors[project.id]!
                                      ],
                                  }}
                                />
                              )}
                              {sessions.some(working) && (
                                <i
                                  className="status-spinner"
                                  role="img"
                                  aria-label="Working"
                                />
                              )}
                              {props.pendingApprovals?.[project.id] ||
                              sessions.some(
                                (s) => props.attention?.[s.sessionId],
                              ) ? (
                                <i
                                  className="attention-dot"
                                  role="img"
                                  aria-label="Needs attention"
                                />
                              ) : null}
                            </SidebarMenuButton>
                            <CollapsibleTrigger asChild>
                              <SidebarMenuAction
                                className="left-2 bg-sidebar opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[state=open]:rotate-90"
                                aria-label={`${open ? "Collapse" : "Expand"} ${projectName(project)}`}
                              >
                                <ChevronRight />
                              </SidebarMenuAction>
                            </CollapsibleTrigger>
                            <SidebarMenuAction
                              className="right-8 opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100"
                              aria-label={`New session in ${projectName(project)}`}
                              onClick={() => {
                                props.onSelectProject(project.id);
                                setExpanded((old) => ({
                                  ...old,
                                  [project.id]: true,
                                }));
                                window.dispatchEvent(
                                  new CustomEvent(
                                    "brigadier-new-project-session",
                                    { detail: project.id },
                                  ),
                                );
                                closeMobile();
                              }}
                            >
                              <Plus />
                            </SidebarMenuAction>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <SidebarMenuAction
                                  showOnHover
                                  aria-label={`Project actions ${projectName(project)}`}
                                >
                                  <MoreHorizontal />
                                </SidebarMenuAction>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                className="w-56"
                                side={isMobile ? "bottom" : "right"}
                                align="start"
                              >
                                <DropdownMenuItem
                                  onSelect={() =>
                                    setRenaming({
                                      id: project.id,
                                      name: projectName(project),
                                    })
                                  }
                                >
                                  <Pencil />
                                  Rename
                                </DropdownMenuItem>
                                {props.onReveal && (
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      props.onReveal?.(project.root_path)
                                    }
                                  >
                                    <Folder />
                                    Reveal in Finder
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel>
                                  Project color
                                </DropdownMenuLabel>
                                <div className="flex gap-1 px-2 pb-2">
                                  {Object.entries(colors).map(
                                    ([name, color]) => (
                                      <Button
                                        key={name}
                                        variant="ghost"
                                        size="icon"
                                        className="size-6 rounded-full"
                                        aria-label={`${name} tag`}
                                        aria-pressed={
                                          navigation.projectColors[
                                            project.id
                                          ] === name
                                        }
                                        onClick={() =>
                                          customize("color", project.id, name)
                                        }
                                      >
                                        <span
                                          className="size-3 rounded-full"
                                          style={{ backgroundColor: color }}
                                        />
                                      </Button>
                                    ),
                                  )}
                                </div>
                                <DropdownMenuItem
                                  onSelect={() =>
                                    customize("color", project.id, null)
                                  }
                                >
                                  No color
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() =>
                                    void moveToTrash("project", project.id)
                                  }
                                >
                                  <Trash2 />
                                  Move to Trash
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </>
                        )}
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            {(all.has(project.id)
                              ? sessions
                              : sessions.slice(0, 5)
                            ).map((s) => sessionRow(s))}
                            {sessions.length > 5 && (
                              <SidebarMenuSubItem>
                                <SidebarMenuSubButton asChild>
                                  <button
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
                                  </button>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            )}
                            {!sessions.length && (
                              <li className="py-2 text-xs text-muted-foreground">
                                No sessions yet
                              </li>
                            )}
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </SidebarMenuItem>
                    </Collapsible>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
            {!activeProjects.length && (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                Add a project to get started.
              </p>
            )}
            {error && addPath === null && (
              <p role="alert" className="px-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => setSettings(true)}>
                <Settings />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => {
                  setNoteId(undefined);
                  setNotes(true);
                }}
              >
                <FileText />
                <span>Notes</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => setTrash(true)}>
                <Trash2 />
                <span>Trash</span>
                {navigation.trash.length > 0 && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {navigation.trash.length}
                  </span>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </SidebarPrimitive>
      <CommandDialog
        open={search}
        onOpenChange={setSearch}
        title="Search"
        description="Find a project, session, or note by name."
      >
        <CommandInput placeholder="Search projects, sessions, notes…" />
        <CommandList>
          <CommandEmpty>No matches.</CommandEmpty>
          <CommandGroup heading="Projects">
            {activeProjects.map((p) => (
              <CommandItem
                key={p.id}
                value={`project ${p.id} ${projectName(p)}`}
                onSelect={() => {
                  selectProject(p.id);
                  setSearch(false);
                }}
              >
                <Folder />
                {projectName(p)}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Sessions">
            {activeSessions.map((s) => (
              <CommandItem
                key={s.sessionId}
                value={`session ${s.sessionId} ${title(s.sessionId)} ${activeProjects.find((p) => p.id === s.projectId)?.name ?? ""}`}
                onSelect={() => {
                  selectSession(s.sessionId);
                  setSearch(false);
                }}
              >
                <FileText />
                <span className="truncate">{title(s.sessionId)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Notes">
            {data.notes
              .filter((n) => !isTrashed(navigation, "note", n.id))
              .map((n) => (
                <CommandItem
                  key={n.id}
                  value={`note ${n.id} ${n.title}`}
                  onSelect={() => {
                    setNoteId(n.id);
                    setNotes(true);
                    setSearch(false);
                  }}
                >
                  <FileText />
                  {n.title}
                </CommandItem>
              ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
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
              <p role="alert" className="text-sm text-destructive">
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
          sessions={props.sessions}
          titles={props.titles ?? {}}
          jobs={props.jobs ?? []}
          onClose={() => setSettings(false)}
        />
      )}
      {notes && (
        <NotesLibrary
          data={data}
          navigation={navigation}
          initialId={noteId}
          onData={changed}
          onClose={() => setNotes(false)}
        />
      )}
      {trash && (
        <TrashLibrary data={navigation} onClose={() => setTrash(false)} />
      )}
      {action && (
        <ActionDialog action={action} onClose={() => setAction(null)} />
      )}
    </>
  );
}
