import { useEffect, useState } from "react";
import type { SessionRuntime } from "./feedStore";
export function working(session: SessionRuntime | undefined) {
  return !!session && (session.busy || session.status === "starting");
}
export function useAttention(
  sessions: Record<string, SessionRuntime>,
  selected: string | null,
  pending: string[],
) {
  const [reads, setReads] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("brigadier:read-sessions") ?? "{}",
      );
    } catch {
      return {};
    }
  });
  useEffect(() => {
    if (!selected || !sessions[selected]) return;
    const seq = sessions[selected].lastEventSeq;
    setReads((old) => {
      if (old[selected] === seq) return old;
      const next = { ...old, [selected]: seq };
      localStorage.setItem("brigadier:read-sessions", JSON.stringify(next));
      return next;
    });
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
