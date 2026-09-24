import {
  Archive,
  ChatCompose,
  DotsHorizontal,
  Folder,
  FolderOpen,
  MagnifyingGlassSearch,
  Pencil,
  Pin,
  Plus,
  Settings,
  SettingsCog,
  Sleep,
  Trash,
  Unpin,
  X,
} from "@openai/apps-sdk-ui/components/Icon";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";

import { DeleteDialog } from "@/app/dialogs/DeleteDialog";
import { errorText } from "@/app/dialogs/fields";
import { ProjectDialog } from "@/app/dialogs/ProjectDialog";
import { SettingsDialog } from "@/app/dialogs/SettingsDialog";
import { NameDialog } from "@/app/NameDialog";
import { SearchDialog } from "@/app/SearchDialog";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Conversation, Project } from "@/ipc/generated";
import { cn } from "@/lib/utils";
import {
  archive,
  openConversation,
  renameConversation,
  select,
  setPinned,
  setProjectExpanded,
} from "@/state/actions";
import { useApp } from "@/state/store";

type DialogState =
  | { type: "newProject" }
  | { type: "projectSettings"; project: Project }
  | { type: "rename"; conversation: Conversation }
  | { type: "settings" }
  | null;

type Sections = {
  pinned: Conversation[];
  chats: Conversation[];
  projects: Project[];
  sessions: Record<string, Conversation[]>;
};

/** What the rows can ask the sidebar to do. */
type RowActions = {
  onRename: (conversation: Conversation) => void;
  onDelete: (conversation: Conversation) => void;
  onError: (error: string) => void;
};

function useSections(): Sections {
  const projects = useApp((s) => s.projects);
  const conversations = useApp((s) => s.conversations);
  return useMemo(() => {
    // Archived conversations live in the Archived view only.
    const all = Object.values(conversations).filter(
      (conversation) => conversation.lifecycle !== "archived",
    );
    const pinned = all
      .filter((conversation) => conversation.pinnedAtMs !== null)
      .toSorted((a, b) => (b.pinnedAtMs ?? 0) - (a.pinnedAtMs ?? 0));
    const recent = all
      .filter((conversation) => conversation.pinnedAtMs === null)
      .toSorted((a, b) => b.updatedAtMs - a.updatedAtMs);
    const sessions: Record<string, Conversation[]> = {};
    const chats: Conversation[] = [];
    for (const conversation of recent) {
      if (conversation.kind === "chat" || !conversation.projectId) {
        chats.push(conversation);
      } else {
        (sessions[conversation.projectId] ??= []).push(conversation);
      }
    }
    // Projects with recent activity first, then newest.
    const lastActivity = (project: Project) =>
      Math.max(project.createdAtMs, sessions[project.id]?.[0]?.updatedAtMs ?? 0);
    const sortedProjects = Object.values(projects).toSorted(
      (a, b) => lastActivity(b) - lastActivity(a),
    );
    return { pinned, chats, projects: sortedProjects, sessions };
  }, [projects, conversations]);
}

function useActiveId(): string | null {
  return useApp((s) =>
    s.selection.type === "conversation" ? s.selection.id : null,
  );
}

export function AppSidebar() {
  const { pinned, chats, projects, sessions } = useSections();
  const activeId = useActiveId();
  const draftProjectId = useApp((s) =>
    s.selection.type === "draft" && s.selection.kind === "session"
      ? s.selection.projectId
      : null,
  );
  const isChatDraft = useApp(
    (s) => s.selection.type === "draft" && s.selection.kind === "chat",
  );
  const isArchived = useApp((s) => s.selection.type === "archived");
  const archivedCount = useApp(
    (s) =>
      Object.values(s.conversations).filter(
        (conversation) => conversation.lifecycle === "archived",
      ).length,
  );
  const catalogLoaded = useApp((s) => s.catalogLoaded);
  const searchShortcut = useApp((s) =>
    s.info?.platform === "macos" ? "⌘K" : "Ctrl K",
  );
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cmd/Ctrl+K opens search from anywhere.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const actions = useMemo<RowActions>(
    () => ({
      onRename: (conversation) => setDialog({ type: "rename", conversation }),
      onDelete: (conversation) => setDeleting(conversation),
      onError: (message) => setError(message),
    }),
    [],
  );
  const onProjectSettings = (project: Project) =>
    setDialog({ type: "projectSettings", project });

  return (
    <Sidebar>
      <div data-tauri-drag-region className="h-titlebar macos:block hidden shrink-0" />
      <SidebarHeader className="macos:pt-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={isChatDraft}
              onClick={() => select({ type: "draft", kind: "chat" })}
            >
              <ChatCompose />
              <span>New chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => setSearchOpen(true)}>
              <MagnifyingGlassSearch />
              <span className="flex-1">Search</span>
              <Kbd className="ms-auto">{searchShortcut}</Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={isArchived}
              onClick={() => select({ type: "archived" })}
            >
              <Archive />
              <span className="flex-1">Archived</span>
              {archivedCount > 0 && (
                <span className="text-sidebar-foreground/60 ms-auto text-xs tabular-nums">
                  {archivedCount}
                </span>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {pinned.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Pinned</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pinned.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    active={conversation.id === activeId}
                    actions={actions}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupAction
            title="New project"
            aria-label="New project"
            onClick={() => setDialog({ type: "newProject" })}
          >
            <Plus />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  sessions={sessions[project.id] ?? NO_SESSIONS}
                  activeId={activeId}
                  drafting={draftProjectId === project.id}
                  actions={actions}
                  onSettings={onProjectSettings}
                />
              ))}
            </SidebarMenu>
            {catalogLoaded && projects.length === 0 && (
              <EmptyHint>
                Projects group sessions on a repository.{" "}
                <button
                  type="button"
                  className="text-sidebar-foreground underline-offset-4 hover:underline"
                  onClick={() => setDialog({ type: "newProject" })}
                >
                  Create a project
                </button>
              </EmptyHint>
            )}
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Chats</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {chats.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === activeId}
                  actions={actions}
                />
              ))}
            </SidebarMenu>
            {catalogLoaded && chats.length === 0 && (
              <EmptyHint>Chats you start appear here.</EmptyHint>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        {error && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive rounded-control flex items-start gap-2 border px-2 py-1.5 text-xs"
          >
            <p className="min-w-0 flex-1 wrap-break-word">{error}</p>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss"
              onClick={() => setError(null)}
            >
              <X />
            </Button>
          </div>
        )}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => setDialog({ type: "settings" })}>
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <ProjectDialog
        open={dialog?.type === "newProject" || dialog?.type === "projectSettings"}
        onOpenChange={(open) => !open && setDialog(null)}
        project={dialog?.type === "projectSettings" ? dialog.project : null}
        onCreated={(project) => {
          setProjectExpanded(project.id, true);
          select({ type: "draft", kind: "session", projectId: project.id });
        }}
      />
      <SettingsDialog
        open={dialog?.type === "settings"}
        onOpenChange={(open) => !open && setDialog(null)}
      />
      <DeleteDialog
        conversation={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
      />
      <NameDialog
        open={dialog?.type === "rename"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={
          dialog?.type === "rename" && dialog.conversation.kind === "chat"
            ? "Rename chat"
            : "Rename session"
        }
        label="Title"
        initialValue={dialog?.type === "rename" ? dialog.conversation.title : ""}
        confirmLabel="Rename"
        onSubmit={async (title) => {
          if (dialog?.type === "rename") {
            await renameConversation(dialog.conversation.id, title);
          }
        }}
      />
    </Sidebar>
  );
}

const NO_SESSIONS: Conversation[] = [];

function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <p className="text-sidebar-foreground/60 px-2 py-1 text-xs">{children}</p>
  );
}

const ProjectRow = memo(function ProjectRow({
  project,
  sessions,
  activeId,
  drafting,
  actions,
  onSettings,
}: {
  project: Project;
  sessions: Conversation[];
  activeId: string | null;
  drafting: boolean;
  actions: RowActions;
  onSettings: (project: Project) => void;
}) {
  const expanded = useApp((s) => s.expandedProjects[project.id] ?? true);
  const newSession = () => {
    setProjectExpanded(project.id, true);
    select({ type: "draft", kind: "session", projectId: project.id });
  };
  return (
    <Collapsible
      asChild
      open={expanded}
      onOpenChange={(open) => setProjectExpanded(project.id, open)}
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton isActive={drafting} className="pe-14">
            {expanded ? <FolderOpen /> : <Folder />}
            <span>{project.name}</span>
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <SidebarMenuAction
          showOnHover
          className="end-7"
          title={`New session in ${project.name}`}
          aria-label={`New session in ${project.name}`}
          onClick={newSession}
        >
          <Plus />
        </SidebarMenuAction>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuAction showOnHover aria-label={`Options for ${project.name}`}>
              <DotsHorizontal />
            </SidebarMenuAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DropdownMenuItem onSelect={newSession}>
              <Plus />
              New session
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSettings(project)}>
              <SettingsCog />
              Project settings…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <CollapsibleContent>
          <SidebarMenuSub>
            {sessions.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeId}
                actions={actions}
                nested
              />
            ))}
            {sessions.length === 0 && (
              <li className="text-sidebar-foreground/60 px-2 py-1 text-xs">
                No sessions yet.
              </li>
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
});

/** A small moon after the title of a conversation that went idle and stopped its CLIs. */
function HibernatedMark() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-slot="hibernated-badge"
          aria-label="Hibernated"
          className="text-sidebar-foreground/60 ms-auto flex shrink-0 items-center"
        >
          <Sleep className="size-icon-sm" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">Hibernated</TooltipContent>
    </Tooltip>
  );
}

const ConversationRow = memo(function ConversationRow({
  conversation,
  active,
  actions,
  nested = false,
}: {
  conversation: Conversation;
  active: boolean;
  actions: RowActions;
  nested?: boolean;
}) {
  const pinned = conversation.pinnedAtMs !== null;
  const hibernated = conversation.lifecycle === "hibernated";
  const menu = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction
          showOnHover={!nested}
          aria-label={`Options for ${conversation.title}`}
          className={cn(
            nested &&
              "opacity-0 group-focus-within/menu-sub-item:opacity-100 group-hover/menu-sub-item:opacity-100 data-[state=open]:opacity-100",
          )}
        >
          <DotsHorizontal />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start">
        <DropdownMenuItem
          onSelect={() =>
            void setPinned(conversation.id, !pinned).catch((error: unknown) =>
              actions.onError(errorText(error)),
            )
          }
        >
          {pinned ? <Unpin /> : <Pin />}
          {pinned ? "Unpin" : "Pin"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onRename(conversation)}>
          <Pencil />
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() =>
            void archive(conversation.id).catch((error: unknown) =>
              actions.onError(errorText(error)),
            )
          }
        >
          <Archive />
          Archive
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => actions.onDelete(conversation)}>
          <Trash />
          Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (nested) {
    return (
      <SidebarMenuSubItem>
        <SidebarMenuSubButton
          isActive={active}
          className="pe-7"
          onClick={() => openConversation(conversation.id)}
        >
          <span className="min-w-0 truncate">{conversation.title}</span>
          {hibernated && <HibernatedMark />}
        </SidebarMenuSubButton>
        {menu}
      </SidebarMenuSubItem>
    );
  }
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        className={cn(hibernated && "pe-7")}
        onClick={() => openConversation(conversation.id)}
      >
        <span className="min-w-0 truncate">{conversation.title}</span>
        {hibernated && <HibernatedMark />}
      </SidebarMenuButton>
      {menu}
    </SidebarMenuItem>
  );
});
