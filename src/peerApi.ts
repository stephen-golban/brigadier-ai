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
export interface PeerData {
  origins: Record<string, string>;
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
  decide: (id: string, allow: boolean): Promise<void> =>
    invoke("peer_decide", { id, allow }),
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
