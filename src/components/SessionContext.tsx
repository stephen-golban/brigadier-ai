import { Popover } from "./controls/overlay";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { sessionApi, type ContextReading } from "../sessionApi";
import { errorMessage } from "../workspaceApi";

/**
 * Smallest gap between two reads of the same session's context, in ms.
 *
 * `revision` is `SessionRuntime.lastEventSeq`, which advances on **every signal** — turn started,
 * turn completed, each approval opened and resolved, each `usage-windows` announcement. Re-running
 * the effect on each of those is right (a turn boundary is exactly when the number moved), but
 * firing an IPC round trip to the CLI's control lane per signal is not: an approval-heavy turn
 * produces a handful in a second. Coalescing them costs at most this much staleness and turns a
 * burst into one read.
 */
const MIN_READ_GAP_MS = 4_000;
/** How close to the threshold counts as "about to compact", in points of the window. */
const NEAR_THRESHOLD_POINTS = 8;

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

/**
 * Where the provider auto-compacts, as a percentage of the same window — or null when it did not
 * say.
 *
 * Never a fallback constant. The threshold is configurable and was measured at two different
 * ratios of the same window on one afternoon (83.5% by model default, 67% under
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW`), so a guessed line would be a drawn lie
 * (`docs/research/compaction-and-long-sessions-2026-09-11.md` §A1).
 */
export function compactPercent(reading: ContextReading | null): number | null {
  if (!reading?.available) return null;
  const at = reading.compactAt;
  const limit = reading.limit;
  if (
    at === null ||
    at === undefined ||
    !Number.isFinite(at) ||
    !Number.isFinite(limit) ||
    at <= 0 ||
    limit! <= 0 ||
    at > limit!
  )
    return null;
  return Math.round((at / limit!) * 100);
}

/** `autocompactSource` verbatim from the CLI, in words. An unknown value is shown, not hidden. */
function sourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  if (source === "model-default") return "the model's default";
  if (source === "env") return "the environment";
  if (source === "setting") return "a setting";
  return source;
}

/**
 * The context meter: how full the provider's window is, and where it will auto-compact.
 *
 * The second number is the point of the component. A compaction is twelve silent seconds
 * (`duration_ms: 12262`, measured) followed by a past-tense row, and the harness gets no
 * in-progress signal — so the only way a user sees one coming is to see the line before they
 * cross it. The `<meter>` carries the threshold as its `high` attribute, so the bar changes
 * colour at exactly the crossing point rather than at a decorative 80%.
 *
 * Tokens and a model name, never a dollar figure.
 */
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
  const lastRead = useRef(0);
  // Only a different session clears the number. Clearing on `revision` — as this did — blanked
  // the meter to `—` on every signal and repainted it a moment later, so the figure flickered
  // through every turn boundary it was supposed to be reporting.
  useEffect(() => {
    setReading(null);
    lastRead.current = 0;
  }, [sessionId]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      lastRead.current = Date.now();
      try {
        const value = await sessionApi.context(sessionId);
        if (live) setReading(value);
      } catch (e) {
        if (live) setReading({ available: false, reason: errorMessage(e) });
      }
      if (live) timer = setTimeout(() => void read(), busy ? 8000 : 30000);
    };
    timer = setTimeout(
      () => void read(),
      Math.max(0, MIN_READ_GAP_MS - (Date.now() - lastRead.current)),
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sessionId, revision, busy]);
  const percent = contextPercent(reading);
  const mark = compactPercent(reading);
  const near = percent !== null && mark !== null && percent >= mark - NEAR_THRESHOLD_POINTS;
  const past = percent !== null && mark !== null && percent >= mark;
  const label =
    percent === null
      ? "Context usage unknown"
      : mark === null
        ? `Context ${percent}% used; the provider did not report a compaction threshold`
        : past
          ? `Context ${percent}% used, past the ${mark}% auto-compaction threshold`
          : `Context ${percent}% used, auto-compacts at ${mark}%`;
  return (
    <Popover>
      <Button variant="ghost" size="sm" className="gauge-button" aria-label={label}>
        <span
          className="gauge-track"
          style={mark === null ? undefined : ({ "--gauge-mark": `${mark}%` } as CSSProperties)}
        >
          <meter
            aria-label={percent === null ? "Usage unknown" : "Context used"}
            value={percent ?? 0}
            min={0}
            max={100}
            low={mark === null ? 100 : Math.max(1, mark - NEAR_THRESHOLD_POINTS)}
            high={mark ?? 100}
            optimum={0}
          />
          {mark !== null && <i className="gauge-mark" aria-hidden="true" />}
        </span>
        <span>Context {percent === null ? "—" : `${percent}%`}</span>
        {near && (
          <small className="gauge-warn">{past ? "compacting" : "compacts soon"}</small>
        )}
      </Button>
      <Popover.Content placement="top end">
        <Popover.Dialog aria-label="Context usage" className="w-72 p-3 text-sm">
          <b>Current context</b>
          {percent === null ? (
            <p>{reading?.reason ?? "Reading provider context…"}</p>
          ) : (
            <>
              <p>
                ≈ {reading!.used!.toLocaleString()} / {reading!.limit!.toLocaleString()} tokens
              </p>
              <p>
                {mark === null || reading!.compactAt == null ? (
                  "The provider did not report an auto-compaction threshold."
                ) : (
                  <>
                    Auto-compacts at {reading!.compactAt.toLocaleString()} tokens ({mark}%)
                    {sourceLabel(reading!.compactSource)
                      ? `, from ${sourceLabel(reading!.compactSource)}`
                      : ""}
                    . Compacting takes about ten seconds and summarises the conversation so far.
                  </>
                )}
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
