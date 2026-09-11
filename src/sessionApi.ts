import { invoke } from "@tauri-apps/api/core";
import { demoContextReading } from "./mock";
import { desktop } from "./workspaceApi";
export interface ContextReading {
  available: boolean;
  used?: number;
  limit?: number;
  /**
   * Tokens at which the provider auto-compacts — `get_context_usage`'s `autoCompactThreshold`,
   * passed through by `src-tauri/src/conversation.rs`.
   *
   * **Never derived from a ratio.** It is real and configurable: measured 2026-09-11 on CLI
   * 2.1.268, `167000` of a `200000` window by model default and `67000` of `100000` under
   * `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`
   * (`docs/research/compaction-and-long-sessions-2026-09-11.md` §A1). Absent means the provider
   * did not report one, and the meter then draws no line rather than guessing at 80%.
   */
  compactAt?: number | null;
  /** `autocompactSource` verbatim — `"model-default"`, `"env"`, or whatever a later CLI adds. */
  compactSource?: string | null;
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
  /**
   * Current context, from the CLI's own `get_context_usage` control — never the cumulative
   * `usage` counters, which are lifetime spend (`docs/STATUS.md` §7).
   *
   * Off the desktop the browser mock answers instead of returning "unavailable". It used to
   * refuse, which meant the meter rendered `—` in the only fixture anyone reviews, and the
   * component sat unmounted for two days without being missed.
   */
  context: (sessionId: string): Promise<ContextReading> =>
    desktop ? invoke("session_context", { sessionId }) : Promise.resolve(demoContextReading(sessionId)),
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
