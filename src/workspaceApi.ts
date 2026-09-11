import { mockChatItems, mockChatTurns } from "./mock";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
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
/**
 * One message of terminal output. `bytes` is base64 of at most 4096 PTY bytes rather than a
 * `number[]`, which keeps the serialized message under tauri's 8192-byte `eval` threshold and off
 * the unbounded channel queue behind it (`src-tauri/src/terminal.rs`).
 */
export interface TerminalFrame {
  seq: number;
  bytes: string;
  dropped_before: number;
  exited: boolean;
  drained: boolean;
}
export interface HistoryPage { items: ChatItem[]; nextAfter: number; nextBefore: number | null; hasMore: boolean }
export interface ChatTurn {
  id: string;
  start_seq: number;
  end_seq: number | null;
  started_at: number;
  ended_at: number | null;
  status: "running" | "completed" | "failed" | "stopped" | "interrupted";
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
  historyPage: async (sessionId: string, options: { before?: number; after?: number; limit?: number } = {}): Promise<HistoryPage> => {
    if (desktop) return invoke("conversation_history_page", { sessionId, ...options });
    const all = mockChatItems(sessionId, 0);
    const matching = all.filter(item => (options.before === undefined || item.seq < options.before) && (options.after === undefined || item.seq > options.after));
    const limit = options.limit ?? 60;
    const items = options.after === undefined ? matching.slice(-limit) : matching.slice(0,limit);
    return {items, nextAfter: Math.max(options.after ?? 0,...items.map(i=>i.seq)), nextBefore: items[0]?.seq ?? null, hasMore: matching.length > items.length};
  },
  chatTurns: (sessionId: string, range: {start?: number; end?: number} = {}): Promise<ChatTurn[]> =>
    desktop ? invoke("chat_turns", { sessionId, ...range }) : Promise.resolve(mockChatTurns(sessionId, range)),
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
  /**
   * Stream this terminal's output. Resolves once Rust holds the channel — frames only flow after
   * that, and the backlog is whatever is still in the 1 MiB ring, so a late subscriber gets the
   * bytes that arrived while it was opening, oldest first.
   *
   * Subscribing twice to one id replaces the first channel; nothing is replayed to the second.
   * The returned teardown detaches this page's handler (`docs/plans/ipc-contract.md`, terminal
   * section); the Rust-side forwarder stops when the terminal is closed.
   */
  subscribeTerminal: async (
    id: string,
    onFrame: (frame: TerminalFrame) => void,
  ): Promise<() => void> => {
    if (!desktop) return () => {};
    const channel = new Channel<TerminalFrame>();
    channel.onmessage = onFrame;
    await invoke("terminal_subscribe", { id, onOutput: channel });
    return () => {
      channel.onmessage = () => {};
    };
  },
  /** @deprecated Polled fallback, kept for one release. Use `subscribeTerminal`. */
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
