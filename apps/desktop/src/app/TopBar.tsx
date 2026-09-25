import { Folder } from "@openai/apps-sdk-ui/components/Icon";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { Badge } from "@/components/ui/badge";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import type { Lifecycle } from "@/ipc/generated";
import { cn } from "@/lib/utils";
import { useApp } from "@/state/store";

function useTitle(): {
  project: string | null;
  title: string;
  lifecycle: Lifecycle | null;
  session: boolean;
} {
  return useApp(
    useShallow((s) => {
      const { selection } = s;
      if (selection.type === "conversation") {
        const conversation = s.conversations[selection.id];
        const project = conversation?.projectId
          ? (s.projects[conversation.projectId]?.name ?? null)
          : null;
        return {
          project,
          title: conversation?.title ?? "",
          lifecycle: conversation?.lifecycle ?? null,
          session: conversation?.kind === "session",
        };
      }
      if (selection.type === "draft" && selection.kind === "session") {
        return {
          project: s.projects[selection.projectId]?.name ?? null,
          title: "New session",
          lifecycle: null,
          session: false,
        };
      }
      if (selection.type === "archived") {
        return { project: null, title: "Archived", lifecycle: null, session: false };
      }
      return { project: null, title: "New chat", lifecycle: null, session: false };
    }),
  );
}

/**
 * The header over the thread, as ChatGPT's: a session's folder icon and the title (click to
 * rename), then the conversation's own controls (`children`) on the right.
 */
export function TopBar({
  onRename,
  children,
}: {
  onRename?: (() => void) | undefined;
  children?: ReactNode;
}) {
  const { state } = useSidebar();
  const { project, title, lifecycle, session } = useTitle();
  const connection = useApp((s) => s.connection.status);

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "h-titlebar flex shrink-0 items-center gap-1 border-b px-3",
        state === "collapsed" && "macos:ps-traffic-lights",
      )}
    >
      <SidebarTrigger className="text-muted-foreground me-1" />
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        {session && (
          <Folder
            aria-label={project ?? undefined}
            className="text-muted-foreground size-icon-md shrink-0"
          />
        )}
        {onRename ? (
          <button
            type="button"
            title={project ? `${project} · Rename` : "Rename"}
            onClick={onRename}
            className="hover:text-foreground/80 min-w-0 truncate font-medium transition-colors"
          >
            {title}
          </button>
        ) : (
          <span className="truncate font-medium">{title}</span>
        )}
        {lifecycle === "hibernated" && (
          <Badge variant="secondary" className="ms-1" title="Idle: its CLI processes are stopped. Sending a message wakes it.">
            Hibernated
          </Badge>
        )}
        {lifecycle === "archived" && (
          <Badge variant="outline" className="ms-1" title="Archived: restore it from the sidebar's Archived view to continue.">
            Archived
          </Badge>
        )}
      </div>

      {connection !== "connected" && (
        <Badge variant="warning" role="status">
          {connection === "connecting"
            ? "Connecting to core…"
            : "Reconnecting to core…"}
        </Badge>
      )}
      {children}
    </header>
  );
}
