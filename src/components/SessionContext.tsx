import { Popover } from "./controls/overlay";
import { Button } from "./controls/button";
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
    <Popover>
      <Button
        variant="ghost"
        className="gap-1 px-2"
        aria-label={
          percent === null
            ? "Context usage unknown"
            : `Context usage approximately ${percent}%`
        }
      >
        <meter aria-label={percent === null ? "Usage unknown" : "Context used"} value={percent ?? 0} min={0} max={100} className="h-2 w-4" />
        <span>{percent === null ? "—" : `${percent}%`}</span>
      </Button>
      <Popover.Content placement="top end">
        <Popover.Dialog aria-label="Context usage" className="w-64 p-3 text-sm">
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
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
