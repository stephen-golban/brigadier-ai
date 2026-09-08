import { useSessionNavigation } from "./sessionNavigation";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./workspaceApi";
export interface PeerMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  work: boolean;
  delivered: boolean;
  error: string | null;
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
  titles: Record<string, string>;
  closed: string[];
  messages: PeerMessage[];
  requests: PeerRequest[];
}
const empty: PeerData = {
  origins: {},
  titles: {},
  closed: [],
  messages: [],
  requests: [],
};
export const peerApi = {
  snapshot: (): Promise<PeerData> =>
    desktop ? invoke("peer_snapshot") : Promise.resolve(empty),
  decide: (id: string, allow: boolean): Promise<void> =>
    invoke("peer_decide", { id, allow }),
};
export function usePeers() {
  const [data, setData] = useState(empty);
  const { titles } = useSessionNavigation();
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    let last = "";
    const fetch = () => {
      void peerApi
        .snapshot()
        .then((next) => {
          const key = JSON.stringify(next);
          if (live && key !== last) {
            last = key;
            setData(next);
          }
        })
        .catch(() => {});
    };
    fetch();
    const timer = setInterval(fetch, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return { ...data, titles: { ...data.titles, ...titles } };
}
