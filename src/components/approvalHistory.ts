import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { desktop } from "../workspaceApi";
import type { ApprovalView, Decision } from "../wire";
export interface ApprovalHistoryItem extends ApprovalView { decision: Decision | null }
export const approvalHistoryApi = {
  load: (sessionId: string): Promise<ApprovalHistoryItem[]> => desktop ? invoke("composer_approval_history", { sessionId }) : Promise.resolve([]),
};
// A first mount usually has no receipts yet, and this hook reloads on every approval response and
// every change of `pendingKey`. A fresh array from the IPC boundary defeats React's `Object.is`
// bail-out and re-renders the whole mounted transcript for a list nobody changed. The receipts are
// a handful of small records per session, so comparing them costs microseconds; the guard only ever
// suppresses an identical list — a new receipt, or a decision landing on an existing one, still
// renders on the same tick it arrives (approvals are never optimistic, CLAUDE.md §5).
const NO_HISTORY: ApprovalHistoryItem[] = [];
const sameHistory = (a: ApprovalHistoryItem[], b: ApprovalHistoryItem[]) =>
  a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
export function useApprovalHistory(sessionId: string, pendingKey: string) {
  const [history, setHistory] = useState<ApprovalHistoryItem[]>(NO_HISTORY);
  useEffect(() => {
    let live = true, generation = 0;
    const refresh = () => {
      const request = ++generation;
      void approvalHistoryApi.load(sessionId).then(items => { if (live && request === generation) setHistory(old => sameHistory(old, items) ? old : items); }).catch(() => { /* An unavailable receipt must never be inferred as acceptance. */ });
    };
    refresh();
    window.addEventListener("brigadier-approval-response", refresh);
    return () => { live = false; window.removeEventListener("brigadier-approval-response", refresh); };
  }, [sessionId, pendingKey]);
  return history;
}
