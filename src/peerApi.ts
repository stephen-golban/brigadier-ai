import { listen } from "@tauri-apps/api/event";
import { useSessionNavigation } from "./sessionNavigation";
import { useEffect, useState } from "react";
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
    fetch();
    const stop = listen("peer-state-changed", fetch);
    window.addEventListener("focus", fetch);
    const timer = setInterval(fetch, 30000);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", fetch);
      void stop.then(unlisten=>unlisten());
    };
  }, []);
  return { ...data, titles: { ...data.titles, ...titles } };
}
