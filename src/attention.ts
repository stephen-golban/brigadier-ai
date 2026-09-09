import { useEffect, useState } from "react";
import type { SessionRuntime } from "./feedStore";
const readKey = "brigadier:read-sessions";
function storedReads(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(readKey) ?? "{}"); } catch { return {}; }
}
/** Reading a worker pane acknowledges that worker only. */
export function markSessionRead(sessionId: string, seq: number) {
  const reads = storedReads();
  if ((reads[sessionId] ?? -1) >= seq) return;
  localStorage.setItem(readKey, JSON.stringify({...reads, [sessionId]: seq}));
  window.dispatchEvent(new Event("brigadier-session-read"));
}
export function working(session: SessionRuntime | undefined) {
  return !!session && (session.busy || session.status === "starting");
}
export function useAttention(
  sessions: Record<string, SessionRuntime>,
  selected: string | null,
  pending: string[],
) {
  const [reads, setReads] = useState<Record<string, number>>(storedReads);
  useEffect(() => {
    const refresh = () => setReads(storedReads());
    window.addEventListener("brigadier-session-read", refresh);
    refresh();
    return () => window.removeEventListener("brigadier-session-read", refresh);
  }, []);
  useEffect(() => {
    if (!selected || !sessions[selected]) return;
    const seq = sessions[selected].lastEventSeq;
    markSessionRead(selected, seq);
  }, [selected, sessions[selected ?? ""]?.lastEventSeq]);
  return Object.fromEntries(
    Object.values(sessions).map((s) => [
      s.sessionId,
      pending.includes(s.sessionId) ||
        (!working(s) &&
          (s.lastTurnId !== null || s.status === "failed") &&
          (reads[s.sessionId] ?? -1) < s.lastEventSeq),
    ]),
  );
}
