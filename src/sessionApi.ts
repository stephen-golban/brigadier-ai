import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./workspaceApi";
export interface ContextReading {
  available: boolean;
  used?: number;
  limit?: number;
  model?: string;
  estimated?: boolean;
  sampledAt?: number;
  reason?: string;
  rewindPending?: boolean;
}
export interface RewindPreview {
  ticket: string;
  conversation: boolean;
  reason: string | null;
  files: string[];
  filesAvailable: boolean;
  hasFileChanges: boolean;
  filesReason: string | null;
}
export type RewindScope = "conversation" | "conversation-and-files";
export const sessionApi = {
  context: (sessionId: string): Promise<ContextReading> =>
    desktop
      ? invoke("session_context", { sessionId })
      : Promise.resolve({
          available: false,
          reason: "Demo session has no live provider telemetry",
        }),
  preview: (sessionId: string, itemId: string): Promise<RewindPreview> =>
    desktop
      ? invoke("preview_rewind", { sessionId, itemId })
      : Promise.resolve({
          ticket: "",
          conversation: false,
          reason: "Native rewind is available in a live desktop session",
          files: [],
          filesAvailable: false,
          hasFileChanges: false,
          filesReason: "No provider checkpoint in this demo",
        }),
  rewind: (
    ticket: string,
    scope: RewindScope,
    text?: string,
  ): Promise<{
    rewound: boolean;
    recoveryId: string;
    filesRestored: boolean;
    sent?: boolean;
  }> => invoke("apply_rewind", { ticket, scope, text }),
};
export interface AgentActivity {
  provider: string;
  cli: string;
  instance: string;
  model: string | null;
  status: string;
  action: string | null;
  agents: {
    id: string;
    description?: string;
    model: string | null;
    status: string;
    action?: string;
  }[];
}
export const readActivity = (sessionId: string): Promise<AgentActivity> =>
  desktop
    ? invoke("session_activity", { sessionId })
    : Promise.reject(new Error("No live provider in demo"));
export const recoverWorkspaceRewind = (sessionId: string, operation: string): Promise<void> => invoke("recover_workspace_rewind", {sessionId, operation});
export interface RewindHistory {
  workspaceOperations?: { id: string; phase: string; draft: string; error: string | null }[];
  records: { id: string; state: string; createdAt: number }[];
  recoveryRoot: string;
}
export interface ArchivedItem {
  cursor: number;
  item: import("./workspaceApi").ChatItem;
}
export const rewindHistory = (sessionId: string): Promise<RewindHistory> =>
  desktop
    ? invoke("rewind_history", { sessionId })
    : Promise.resolve({ records: [], recoveryRoot: "" });
export const rewindHistoryItems = (
  sessionId: string,
  rewindId: string,
  after: number,
): Promise<ArchivedItem[]> =>
  desktop
    ? invoke("rewind_history_items", { sessionId, rewindId, after })
    : Promise.resolve([]);
