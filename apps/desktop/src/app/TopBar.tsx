import { ChevronRight, Terminal } from "@openai/apps-sdk-ui/components/Icon";
import { useShallow } from "zustand/react/shallow";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Density, Lifecycle } from "@/ipc/generated";
import { cn } from "@/lib/utils";
import { setDensity, setInspectorOpen } from "@/state/actions";
import { useApp } from "@/state/store";

function useTitle(): { project: string | null; title: string; lifecycle: Lifecycle | null } {
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
        };
      }
      if (selection.type === "draft" && selection.kind === "session") {
        return {
          project: s.projects[selection.projectId]?.name ?? null,
          title: "New session",
          lifecycle: null,
        };
      }
      if (selection.type === "archived") {
        return { project: null, title: "Archived", lifecycle: null };
      }
      return { project: null, title: "New chat", lifecycle: null };
    }),
  );
}

export function TopBar() {
  const { state } = useSidebar();
  const { project, title, lifecycle } = useTitle();
  const connection = useApp((s) => s.connection.status);
  const density = useApp((s) => s.settings.density);
  const inspectorOpen = useApp((s) => s.inspector.open);

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "h-titlebar flex shrink-0 items-center gap-2 border-b px-3",
        state === "collapsed" && "macos:ps-traffic-lights",
      )}
    >
      <SidebarTrigger className="text-muted-foreground" />
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center gap-1 text-sm"
      >
        {project && (
          <>
            <span className="text-muted-foreground truncate">{project}</span>
            <ChevronRight className="text-muted-foreground size-icon-sm shrink-0" />
          </>
        )}
        <span className="truncate font-medium">{title}</span>
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

      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        value={density}
        onValueChange={(value) => {
          if (value === "compact" || value === "normal") {
            void setDensity(value satisfies Density);
          }
        }}
        aria-label="Density"
      >
        <ToggleGroupItem value="compact" className="text-xs">
          Compact
        </ToggleGroupItem>
        <ToggleGroupItem value="normal" className="text-xs">
          Normal
        </ToggleGroupItem>
      </ToggleGroup>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={inspectorOpen ? "secondary" : "ghost"}
            size="icon-md"
            aria-pressed={inspectorOpen}
            aria-label="Inspector"
            onClick={() => setInspectorOpen(!inspectorOpen)}
          >
            <Terminal />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Inspector (Ctrl/⌘ ⌥ I)</TooltipContent>
      </Tooltip>
    </header>
  );
}
