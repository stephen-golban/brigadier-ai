import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { desktop, errorMessage } from "./workspaceApi";
import { bridge } from "./bridge";
import * as store from "./feedStore";
export interface FileChange {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
}
export interface SessionChanges {
  files: FileChange[];
  turns: { turnId: string; files: FileChange[] }[];
}
export interface ApplyPreview {
  id: string;
  session: string;
  phase: string;
  error: string | null;
  plan: { changes: { path: string }[]; conflicts: string[] };
}
export interface CleanupJob {
  id: string;
  sessions: string[];
  error: string | null;
}
export function notify(message: string, error = false, retry?: () => void) {
  window.dispatchEvent(
    new CustomEvent("brigadier-toast", {
      detail: { id: crypto.randomUUID(), message, error, retry },
    }),
  );
}
export const desktopApi = {
  changes: (sessionId: string): Promise<SessionChanges> =>
    desktop
      ? invoke("session_changes", { sessionId })
      : Promise.resolve({ files: [], turns: [] }),
  diff: (
    sessionId: string,
    path: string,
    turn: string | null = null,
  ): Promise<string> => invoke("session_diff", { sessionId, path, turn }),
  previewUndo: (sessionId: string, turn: string): Promise<ApplyPreview> =>
    invoke("session_undo_preview", { sessionId, turn }),
  previewApply: (sessionId: string): Promise<ApplyPreview> =>
    invoke("session_apply_preview", { sessionId }),
  apply: (sessionId: string, ticket: string): Promise<void> =>
    invoke("session_apply", { sessionId, ticket }),
  applies: (sessionId: string): Promise<ApplyPreview[]> =>
    desktop
      ? invoke("session_apply_history", { sessionId })
      : Promise.resolve([]),
  cleanup: (): Promise<CleanupJob[]> =>
    desktop ? invoke("session_cleanup_status") : Promise.resolve([]),
  retryCleanup: (id: string): Promise<void> =>
    invoke("session_cleanup_retry", { id }),
  discard: async (ids: string[], all = false): Promise<void> => {
    const removed = desktop
      ? (await invoke<CleanupJob>("session_discard", { ids, all })).sessions
      : all
        ? store.getState().order
        : ids;
    for (const sessionId of removed) {
      if (!desktop) await bridge().deleteSession(sessionId, true);
      retireSession(sessionId);
    }
  },
};
export function retireSession(sessionId: string) {
  store.dropSession(sessionId);
  for (const key of [
    `brigadier:scroll:${sessionId}`,
    `brigadier:expanded:${sessionId}`,
    `brigadier:read:${sessionId}`,
    `draft:turn:${sessionId}`,
  ])
    localStorage.removeItem(key);
  try {
    const reads = JSON.parse(
      localStorage.getItem("brigadier:read-sessions") ?? "{}",
    );
    delete reads[sessionId];
    localStorage.setItem("brigadier:read-sessions", JSON.stringify(reads));
  } catch {}
  window.dispatchEvent(
    new CustomEvent("workbench-history-deleted", { detail: { sessionId } }),
  );
}
export function useSessionChanges(sessionId: string | null) {
  const [data, setData] = useState<SessionChanges>({ files: [], turns: [] });
  useEffect(() => {
    setData({ files: [], turns: [] });
    if (!sessionId) return;
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await desktopApi.changes(sessionId);
        if (live) setData(next);
      } catch {
        /* No counts are invented for older or unavailable checkpoints. */
      } finally {
        if (live) timer = setTimeout(read, 3500);
      }
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sessionId]);
  return data;
}
export function useCleanup() {
  const [jobs, setJobs] = useState<CleanupJob[]>([]);
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const retired = new Set<string>();
    const errors = new Set<string>();
    const read = async () => {
      try {
        const next = await desktopApi.cleanup();
        if (!live) return;
        setJobs(next);
        for (const job of next) {
          for (const id of job.sessions) {
            if (!retired.has(id)) {
              retireSession(id);
              retired.add(id);
            }
          }
          if (job.error && !errors.has(job.id + job.error)) {
            errors.add(job.id + job.error);
            notify(
              `Session cleanup: ${job.error}`,
              true,
              () =>
                void desktopApi
                  .retryCleanup(job.id)
                  .catch((e) => notify(errorMessage(e), true)),
            );
          }
        }
      } catch (e) {
        if (live) notify(errorMessage(e), true);
      } finally {
        if (live) timer = setTimeout(read, 2000);
      }
    };
    if (desktop) void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  return jobs;
}
