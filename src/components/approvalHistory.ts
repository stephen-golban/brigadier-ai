import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { desktop } from "../workspaceApi";
import type { ApprovalView, Decision } from "../wire";
export interface ApprovalHistoryItem extends ApprovalView { decision: Decision | null }
export const approvalHistoryApi = {
  load: (sessionId: string): Promise<ApprovalHistoryItem[]> => desktop ? invoke("composer_approval_history", { sessionId }) : Promise.resolve([]),
};
export function useApprovalHistory(sessionId: string, pendingKey: string) {
  const [history, setHistory] = useState<ApprovalHistoryItem[]>([]);
  useEffect(() => {
    let live = true, generation = 0;
    const refresh = () => {
      const request = ++generation;
      void approvalHistoryApi.load(sessionId).then(items => { if (live && request === generation) setHistory(items); }).catch(() => { /* An unavailable receipt must never be inferred as acceptance. */ });
    };
    refresh();
    window.addEventListener("brigadier-approval-response", refresh);
    return () => { live = false; window.removeEventListener("brigadier-approval-response", refresh); };
  }, [sessionId, pendingKey]);
  return history;
}
