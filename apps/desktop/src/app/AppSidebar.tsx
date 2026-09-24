import {
  ChatCompose,
  DotsHorizontal,
  Folder,
  FolderOpen,
  MagnifyingGlassSearch,
  Pencil,
  Pin,
  Plus,
  Unpin,
} from "@openai/apps-sdk-ui/components/Icon";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";

import { NameDialog } from "@/app/NameDialog";
import { SearchDialog } from "@/app/SearchDialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
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
import type { Conversation, Project } from "@/ipc/generated";
import { cn } from "@/lib/utils";
import {
  createProject,
  openConversation,
  renameConversation,
  select,
  setPinned,
  setProjectExpanded,
} from "@/state/actions";
import { useApp } from "@/state/store";

type DialogState =
  | { type: "project" }
  | { type: "rename"; conversation: Conversation }
  | null;

type Sections = {
  pinned: Conversation[];
  chats: Conversation[];
  projects: Project[];
  sessions: Record<string, Conversation[]>;
};

function useSections(): Sections {
  const projects = useApp((s) => s.projects);
  const conversations = useApp((s) => s.conversations);
  return useMemo(() => {
    const all = Object.values(conversations);
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
  const catalogLoaded = useApp((s) => s.catalogLoaded);
  const searchShortcut = useApp((s) =>
    s.info?.platform === "macos" ? "⌘K" : "Ctrl K",
  );
  const [dialog, setDialog] = useState<DialogState>(null);
  const [searchOpen, setSearchOpen] = useState(false);

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

  const onRename = (conversation: Conversation) =>
    setDialog({ type: "rename", conversation });

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
                    onRename={onRename}
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
            onClick={() => setDialog({ type: "project" })}
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
                  onRename={onRename}
                />
              ))}
            </SidebarMenu>
            {catalogLoaded && projects.length === 0 && (
              <EmptyHint>
                Projects group sessions on one or more repos.{" "}
                <button
                  type="button"
                  className="text-sidebar-foreground underline-offset-4 hover:underline"
                  onClick={() => setDialog({ type: "project" })}
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
                  onRename={onRename}
                />
              ))}
            </SidebarMenu>
            {catalogLoaded && chats.length === 0 && (
              <EmptyHint>Chats you start appear here.</EmptyHint>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <NameDialog
        open={dialog?.type === "project"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="New project"
        description="A project owns its sessions and, later, its repos and Brain."
        label="Project name"
        confirmLabel="Create project"
        onSubmit={async (name) => {
          const project = await createProject(name);
          select({ type: "draft", kind: "session", projectId: project.id });
        }}
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
  onRename,
}: {
  project: Project;
  sessions: Conversation[];
  activeId: string | null;
  drafting: boolean;
  onRename: (conversation: Conversation) => void;
}) {
  const expanded = useApp((s) => s.expandedProjects[project.id] ?? true);
  return (
    <Collapsible
      asChild
      open={expanded}
      onOpenChange={(open) => setProjectExpanded(project.id, open)}
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton isActive={drafting}>
            {expanded ? <FolderOpen /> : <Folder />}
            <span>{project.name}</span>
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <SidebarMenuAction
          showOnHover
          title={`New session in ${project.name}`}
          aria-label={`New session in ${project.name}`}
          onClick={() => {
            setProjectExpanded(project.id, true);
            select({ type: "draft", kind: "session", projectId: project.id });
          }}
        >
          <Plus />
        </SidebarMenuAction>
        <CollapsibleContent>
          <SidebarMenuSub>
            {sessions.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeId}
                onRename={onRename}
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

const ConversationRow = memo(function ConversationRow({
  conversation,
  active,
  onRename,
  nested = false,
}: {
  conversation: Conversation;
  active: boolean;
  onRename: (conversation: Conversation) => void;
  nested?: boolean;
}) {
  const pinned = conversation.pinnedAtMs !== null;
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
          onSelect={() => void setPinned(conversation.id, !pinned)}
        >
          {pinned ? <Unpin /> : <Pin />}
          {pinned ? "Unpin" : "Pin"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onRename(conversation)}>
          <Pencil />
          Rename
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
          <span>{conversation.title}</span>
        </SidebarMenuSubButton>
        {menu}
      </SidebarMenuSubItem>
    );
  }
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        onClick={() => openConversation(conversation.id)}
      >
        <span>{conversation.title}</span>
      </SidebarMenuButton>
      {menu}
    </SidebarMenuItem>
  );
});
