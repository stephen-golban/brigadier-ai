import { useEffect, useState } from "react";
import { sessionApi, type ContextReading } from "../sessionApi";
import { errorMessage } from "../workspaceApi";
export function contextPercent(reading: ContextReading | null): number | null {
  if (
    !reading?.available ||
    !Number.isFinite(reading.used) ||
    !Number.isFinite(reading.limit) ||
    reading.used! < 0 ||
    reading.limit! <= 0
  )
    return null;
  return Math.round((reading.used! / reading.limit!) * 100);
}
export function SessionContext({
  sessionId,
  revision,
  busy,
}: {
  sessionId: string;
  revision: number;
  busy: boolean;
}) {
  const [reading, setReading] = useState<ContextReading | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    setReading(null);
    const read = async () => {
      try {
        const value = await sessionApi.context(sessionId);
        if (live) setReading(value);
      } catch (e) {
        if (live) setReading({ available: false, reason: errorMessage(e) });
      }
      if (live) timer = setTimeout(() => void read(), busy ? 8000 : 30000);
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sessionId, revision, busy]);
  const percent = contextPercent(reading);
  return (
    <details className="session-context">
      <summary
        aria-label={
          percent === null
            ? "Context usage unknown"
            : `Context usage approximately ${percent}%`
        }
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="7" className="context-track" />
          {percent !== null && (
            <circle
              cx="10"
              cy="10"
              r="7"
              className="context-value"
              pathLength="100"
              strokeDasharray={`${Math.min(100, percent)} 100`}
            />
          )}
        </svg>
        <span>{percent === null ? "—" : `${percent}%`}</span>
      </summary>
      <div className="context-details">
        <b>Current context</b>
        {percent === null ? (
          <p>{reading?.reason ?? "Reading provider context…"}</p>
        ) : (
          <>
            <p>
              ≈ {reading!.used!.toLocaleString()} /{" "}
              {reading!.limit!.toLocaleString()} tokens
            </p>
            <p>{reading!.model}</p>
            <small>
              Provider estimate · Includes instructions and tools · Updated{" "}
              {reading!.sampledAt
                ? new Date(reading!.sampledAt).toLocaleTimeString()
                : "now"}
            </small>
          </>
        )}
      </div>
    </details>
  );
}
