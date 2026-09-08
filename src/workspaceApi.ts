import { mockChatItems } from "./mock";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ItemKind } from "./wire";
export interface WorkspaceContext {
  projectId: string;
  sessionId: string | null;
}
export interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
}
export interface FilePreview {
  path: string;
  content: string;
  truncated: boolean;
}
export interface GitChange {
  path: string;
  index: string;
  worktree: string;
  original?: string|null;
}
export interface GitStatus {
  branch: string;
  changes: GitChange[];
  additions?:number; deletions?:number; ahead?:number; behind?:number;
}
export interface ChatItem {
  session_id: string;
  id: string;
  seq: number;
  at: number;
  kind: ItemKind;
  body: string;
  parent_id: string | null;
  provider_uuid?: string | null;
}
export const desktop = isTauri();
const example = "# Brigadier\n\nA local workspace for your coding agents.\n";
// Browser fixtures are visibly marked by the existing application-wide mock indicator.
export const workspaceApi = {
  stat: (context: WorkspaceContext, path: string): Promise<{ directory: boolean; size: number; modified: number }> =>
    desktop ? invoke("workspace_file_stat", { ...context, path }) : Promise.resolve({ directory: !path || path === "src", size: example.length, modified: 1 }),
  entries: (context: WorkspaceContext, path: string): Promise<FileEntry[]> =>
    desktop
      ? invoke("workspace_entries", { ...context, path })
      : Promise.resolve(
          path
            ? [{ name: "App.tsx", path: `${path}/App.tsx`, directory: false }]
            : [
                { name: "src", path: "src", directory: true },
                { name: "README.md", path: "README.md", directory: false },
              ],
        ),
  findFiles: (
    context: WorkspaceContext,
    query: string,
  ): Promise<{ paths: string[]; truncated: boolean }> =>
    desktop
      ? invoke("workspace_find_files", { ...context, query })
      : Promise.resolve({
          paths: ["README.md", "src/App.tsx"].filter((path) =>
            path.toLowerCase().includes(query.toLowerCase()),
          ),
          truncated: false,
        }),
  file: (context: WorkspaceContext, path: string): Promise<FilePreview> =>
    desktop
      ? invoke("workspace_file", { ...context, path })
      : Promise.resolve({ path, content: example, truncated: false }),
  git: (context: WorkspaceContext): Promise<GitStatus> =>
    desktop
      ? invoke("workspace_git", context as unknown as Record<string, unknown>)
      : Promise.resolve({
          branch: "main",
          changes: [{ path: "README.md", index: " ", worktree: "M" }],
        }),
  diff: (
    context: WorkspaceContext,
    path: string,
    staged: boolean,
  ): Promise<FilePreview> =>
    desktop
      ? invoke("workspace_diff", { ...context, path, staged })
      : Promise.resolve({
          path,
          content:
            "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,3 @@\n # Brigadier\n+\n+A local workspace for your coding agents.",
          truncated: false,
        }),
  chat: (sessionId: string, after: number): Promise<ChatItem[]> =>
    desktop
      ? invoke("chat_items", { sessionId, after })
      : Promise.resolve(mockChatItems(sessionId, after)),
  openTerminal: (
    context: WorkspaceContext,
    cols: number,
    rows: number,
    cwd?: string,
    shell?: string,
  ): Promise<string> =>
    desktop
      ? invoke("terminal_open", { ...context, cols, rows, cwd, shell })
      : Promise.reject(
          new Error("Interactive terminals are available in the desktop app."),
        ),
  terminalProfiles: (): Promise<{ path: string; name: string; default: boolean }[]> => desktop ? invoke("terminal_profiles") : Promise.resolve([]),
  readTerminal: (
    id: string,
  ): Promise<{ data: number[]; exited: boolean; dropped: number; busy:boolean }> =>
    invoke("terminal_read", { id }),
  writeTerminal: (id: string, data: string): Promise<void> =>
    invoke("terminal_write", { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number): Promise<void> =>
    invoke("terminal_resize", { id, cols, rows }),
  closeTerminal: (id: string): Promise<void> =>
    invoke("terminal_close", { id }),
};
export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error);
}
