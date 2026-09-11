import { listen } from "@tauri-apps/api/event";
import { useSessionNavigation } from "./sessionNavigation";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./workspaceApi";
export interface PeerAttachment {
  id: string; projectId: string; name: string; mediaType: string; size: number; createdAt: number;
}
export interface PeerMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  work: boolean;
  turnId?: string | null;
  delivered: boolean;
  error: string | null;
  uncertain?: boolean;
  attempted?: boolean;
  initial?: boolean;
  attachmentIds?: string[];
  attachments?: PeerAttachment[];
}
export interface PeerRequest {
  id: string;
  from: string;
  to: string;
  action: string;
  resolved: boolean;
}
export interface WorkerAssignment {
  assignmentId?:string; generation?:number; baseline?:string|null; continuedFrom?:string|null;
  history?:Array<{objective?:string;result?:string;evidence?:string;instruction?:string;applied?:boolean}>;
  objective:string; criteria:string; scope:string; operation:string;
  selection:{provider:string; model:string; effort?:string|null; reason:string; version:string; workload:string; pinned:boolean; alternatives:string[]};
  state:string; disposition:string; revision:number; startedAt:number; completedAt?:number|null; result?:string|null; evidence?:string|null;
}
export interface PeerData {
  assignments?: Record<string,WorkerAssignment>;
  allowances?: Record<string,{receipts:string[];extra:number}>;
  origins: Record<string, string>;
  /** Internal execution ownership; origins is provenance only. */
  subagents?: Record<string, string>;
  retired?: Record<string, {turnId:string;workspaceRemoved:boolean;reason:string}>;
  titles: Record<string, string>;
  closed: string[];
  messages: PeerMessage[];
  requests: PeerRequest[];
  /** Durable delivery attribution survives inbox retention and reload. */
  inputs?: PeerMessage[];
  loaded?: boolean;
}
const empty: PeerData = {
  origins: {},
  subagents: {},
  titles: {},
  closed: [],
  messages: [],
  requests: [],
};
export const peerApi = {
  importAttachment: (projectId: string, name: string, base64: string): Promise<PeerAttachment> =>
    invoke("import_conversation_attachment", { projectId, name, base64 }),
  attachment: (projectId: string, id: string): Promise<{metadata: PeerAttachment; base64: string}> =>
    invoke("conversation_attachment", { projectId, id }),
  snapshot: (): Promise<PeerData> =>
    desktop ? invoke("peer_snapshot") : Promise.resolve(empty),
  decide: (id: string, allow: boolean, conversationId?: string): Promise<void> =>
    invoke("peer_decide", { id, allow, conversationId }),
};
export function usePeers() {
  const [data, setData] = useState<PeerData>({ ...empty, loaded: !desktop });
  const { titles } = useSessionNavigation();
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    let last = "";
    let fetching = false;
    const fetch = () => {
      if (fetching) return;
      fetching = true;
      void peerApi
        .snapshot()
        .then((next) => {
          const key = JSON.stringify(next);
          if (live && key !== last) {
            last = key;
            setData({ ...next, loaded: true });
          }
        })
        .catch(() => {})
        .finally(() => { fetching = false; });
    };
    // Listener first, then the fetch (`docs/plans/efficiency-plan-review-2026-09-11.md` §B4).
    // `listen` is async: with the fetch first, a `peer-state-changed` emitted between the
    // snapshot resolving and the subscription landing is dropped — Tauri v2 buffers and replays
    // nothing — and only the 30 s poll hid it. Registering first means the worst case is one
    // redundant fetch instead of a lost one. The poll is deliberately left in place; removing it
    // waits on the producer coverage this reorder is a precondition for.
    let timer: ReturnType<typeof setInterval> | undefined;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const off = await listen("peer-state-changed", fetch);
        // Unmount raced the pending `listen()`: the subscription exists now and nothing will
        // ever tear it down, so tear it down here.
        if (!live) { off(); return; }
        unlisten = off;
      } catch {
        // A subscription that never landed leaves the poll as the only coverage; still fetch.
        if (!live) return;
      }
      fetch();
      timer = setInterval(fetch, 30000);
    })();
    window.addEventListener("focus", fetch);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", fetch);
      unlisten?.();
    };
  }, []);
  return useMemo(() => ({ ...data, titles: { ...data.titles, ...titles } }), [data, titles]);
}
