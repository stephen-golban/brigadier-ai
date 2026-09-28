import { FolderPlus } from "@openai/apps-sdk-ui/components/Icon";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useState } from "react";

import { openFolders } from "@/state/addProject";

/**
 * Folders dropped anywhere on the window become projects (see `openFolders`). While
 * something is dragged over the window, a veil says so.
 */
export function FolderDropZone() {
  const [over, setOver] = useState(false);

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | null = null;
    getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        switch (payload.type) {
          case "enter":
            setOver(payload.paths.length > 0);
            break;
          case "leave":
            setOver(false);
            break;
          case "drop":
            setOver(false);
            if (payload.paths.length > 0) void openFolders(payload.paths);
            break;
          case "over":
            break;
        }
      })
      .then((stop) => {
        if (live) unlisten = stop;
        else stop();
      })
      .catch((error: unknown) => console.error("folder drops unavailable", error));
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  if (!over) return null;
  return (
    <div
      aria-hidden
      className="bg-background/70 pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-6 backdrop-blur-sm"
    >
      <div className="border-foreground/25 rounded-dialog flex size-full flex-col items-center justify-center gap-3 border-2 border-dashed text-center">
        <FolderPlus className="text-muted-foreground size-10" />
        <p className="text-lg font-medium">Drop folders to add them as projects</p>
        <p className="text-muted-foreground text-sm">
          A repository is added right away. A folder that's already a project opens.
        </p>
      </div>
    </div>
  );
}
