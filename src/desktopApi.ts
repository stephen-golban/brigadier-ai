import { removeSessionLocalData } from "./sessionLocalData";
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
export interface ToastAction {
  label: string;
  primary?: boolean;
  onClick: () => void | Promise<void>;
}
export interface ToastNotice {
  id: string;
  message: string;
  error: boolean;
  retry?: () => void;
  icon?: "archive";
  actions?: ToastAction[];
}
export function notify(
  message: string,
  error = false,
  retry?: () => void,
  options: Pick<ToastNotice, "icon" | "actions"> = {},
) {
  window.dispatchEvent(
    new CustomEvent<ToastNotice>("brigadier-toast", {
      detail: { id: crypto.randomUUID(), message, error, retry, ...options },
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
  removeSessionLocalData(sessionId);
  window.dispatchEvent(
    new CustomEvent("workbench-history-deleted", { detail: { sessionId } }),
  );
}
// One shared empty payload so the reset on a session change is a real no-op when there is nothing
// to clear: a fresh object literal defeats React's `Object.is` bail-out and re-renders everything
// under this hook, including the mounted transcript, inside the first-mount window the native
// 60 Hz burn is measured over.
const NO_CHANGES: SessionChanges = { files: [], turns: [] };
export function useSessionChanges(sessionId: string | null) {
  const [data, setData] = useState<SessionChanges>(NO_CHANGES);
  useEffect(() => {
    setData(NO_CHANGES);
    if (!sessionId) return;
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    // What the render tree already shows, as of the reset above. The poll below runs every 3.5 s
    // and a quiet session answers with the same counts each time; setting a fresh object for that
    // re-renders everything under this hook, the mounted transcript included. The payload is a flat
    // list of paths with two integers each plus the same per turn — a few KB of JSON for a large
    // session, so serialising it costs microseconds against the tens of milliseconds a transcript
    // re-render costs. This suppresses *only* a payload identical to the one on screen; any real
    // difference in path, counts or turns still lands on the poll that first sees it. The variable
    // is scoped to one effect run, so a session change starts it over with no stale carry.
    let delivered = JSON.stringify(NO_CHANGES);
    const read = async () => {
      try {
        const next = await desktopApi.changes(sessionId);
        const encoded = JSON.stringify(next);
        if (live && encoded !== delivered) {
          delivered = encoded;
          setData(next);
        }
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
