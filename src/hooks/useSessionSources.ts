import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { desktop } from "../workspaceApi";
import type { PeerAttachment } from "../peerApi";

const empty: PeerAttachment[] = [];
type Snapshot = { sessionId: string; sources: PeerAttachment[]; error: string };
function sameSources(a: PeerAttachment[], b: PeerAttachment[]) {
  return a.length === b.length && a.every((item, i) => {
    const next = b[i]!;
    return item.id === next.id && item.projectId === next.projectId && item.name === next.name
      && item.mediaType === next.mediaType && item.size === next.size && item.createdAt === next.createdAt;
  });
}

/** Refresh with every existing turn signal, but keep unchanged sources visible and stable. */
export function useSessionSources(sessionId: string, busy: boolean, lastTurnId: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({sessionId, sources: empty, error: ""}));
  useEffect(() => {
    let live = true;
    if (desktop) void invoke<PeerAttachment[]>("session_sources", {sessionId}).then(sources => {
      if (live) setSnapshot(previous => previous.sessionId === sessionId && !previous.error && sameSources(previous.sources, sources)
        ? previous : {sessionId, sources, error: ""});
    }, error => {
      if (live) setSnapshot(previous => ({sessionId, sources: previous.sessionId === sessionId ? previous.sources : empty, error: String(error)}));
    });
    return () => { live = false; };
  }, [sessionId, busy, lastTurnId]);
  return snapshot.sessionId === sessionId ? snapshot : {sessionId, sources: empty, error: ""};
}
