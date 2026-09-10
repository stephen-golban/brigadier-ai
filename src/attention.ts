import { countDiagnostic } from "./perfDiagnostics";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SessionRuntime } from "./feedStore";
const readKey = "brigadier:read-sessions";
function storedReads(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(readKey) ?? "{}"); } catch { return {}; }
}
/** Reading a worker pane acknowledges that worker only. */
export function markSessionRead(sessionId: string, seq: number) {
  const reads = storedReads();
  if ((reads[sessionId] ?? -1) >= seq) return;
  countDiagnostic("readPersistence");
  const next = {...reads, [sessionId]: seq};
  localStorage.setItem(readKey, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent("brigadier-session-read", {detail: next}));
}
export function working(session: SessionRuntime | undefined) {
  return !!session && (session.busy || session.status === "starting");
}

function readObserver() {
  let reads = storedReads();
  return {
    get: () => reads,
    subscribe: (notify: () => void) => {
      const refresh = (event?: Event) => {
        reads = (event as CustomEvent<Record<string, number>> | undefined)?.detail ?? storedReads();
        notify();
      };
      window.addEventListener("brigadier-session-read", refresh);
      refresh();
      return () => window.removeEventListener("brigadier-session-read", refresh);
    },
  };
}

export function useAttention(
  sessions: Record<string, SessionRuntime>,
  selected: string | null,
  pending: string[],
) {
  const [observer] = useState(readObserver);
  // Acknowledgements advance for every event, but React only needs a new snapshot
  // when a badge changes. The primitive snapshot is stable across equal maps.
  const snapshot = useSyncExternalStore(observer.subscribe, () => JSON.stringify(
    Object.fromEntries(Object.values(sessions).map(s => [s.sessionId,
      pending.includes(s.sessionId) ||
      (s.sessionId !== selected && !working(s) &&
        (s.lastTurnId !== null || s.status === "failed") &&
        (observer.get()[s.sessionId] ?? -1) < s.lastEventSeq),
    ])),
  ));
  useEffect(() => {
    if (!selected || !sessions[selected]) return;
    markSessionRead(selected, sessions[selected].lastEventSeq);
  }, [selected, sessions[selected ?? ""]?.lastEventSeq]);
  return useMemo(() => JSON.parse(snapshot) as Record<string, boolean>, [snapshot]);
}
