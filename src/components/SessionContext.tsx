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

/** The last observed decrease in the reading: a message reset, or a within-turn compaction. */
export interface Drop {
  from: number;
  to: number;
  /** `sampledAt` of the lower reading, in ms. */
  at: number;
}

/** The usable token count of a reading, or null when there is not one to compare against. */
export function usedTokens(reading: ContextReading | null): number | null {
  if (!reading?.available || !Number.isFinite(reading.used) || reading.used! < 0) return null;
  return reading.used!;
}

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
 * The context meter: how full the window of **the current response** is, and where it will
 * auto-compact.
 *
 * **Scope, because the copy used to get it wrong.** brigadier's interactive path does not
 * accumulate. Every user message kills the running `claude` child and spawns a fresh one with no
 * `--resume` and no provider transcript; the harness re-assembles a bounded brief from SQLite
 * instead (`docs/research/does-a-session-accumulate-2026-09-11.md` §0–§2, measured). So this
 * figure covers one response and returns to its floor at the next message. It is not a
 * conversation-long budget, and no number of messages can walk it up to the threshold.
 *
 * The threshold still earns its place: a compaction is unreachable *across a conversation* but
 * reachable *within one turn* whose own tool output burns the remaining headroom — roughly 120k
 * tokens on the default model, effectively unreachable on a 1M-context one (same file, §3). A
 * compaction is twelve silent seconds (`duration_ms: 12262`, measured) followed by a past-tense
 * warning row, so the only way a user sees one coming is to see the line before they cross it.
 * There **is** an in-progress signal on the wire (`session-compacting`) and it deliberately has no
 * consumer: owner ruling 2026-09-11, no live indicator of any kind — no spinner, no progress row,
 * no status line. That is why the flag below reads `past the line`, which is what this meter
 * measured, rather than `compacting`, which named an event nothing here can observe. The `<meter>` carries the threshold as its `high` attribute,
 * so the bar changes colour at exactly the crossing point rather than at a decorative 80%.
 *
 * **The drop line is a tripwire, not decoration.** On a correct tree this number sawtooths. The
 * popover reports the last decrease it actually observed, so an operator can tell a reset from a
 * glitch — and so a figure that only ever climbs across messages, which would mean conversation
 * history had been wired back into the send path, shows up as a drop line that never populates.
 * It reports what was seen and does not accuse: with reads coalesced at 4 s and polled at 8 s the
 * per-turn floor is not reliably sampled, so an automatic alarm would misfire.
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
  const [drop, setDrop] = useState<Drop | null>(null);
  const lastRead = useRef(0);
  const lastUsed = useRef<number | null>(null);
  // Only a different session clears the number. Clearing on `revision` — as this did — blanked
  // the meter to `—` on every signal and repainted it a moment later, so the figure flickered
  // through every turn boundary it was supposed to be reporting.
  useEffect(() => {
    setReading(null);
    setDrop(null);
    lastRead.current = 0;
    lastUsed.current = null;
  }, [sessionId]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      lastRead.current = Date.now();
      try {
        const value = await sessionApi.context(sessionId);
        if (live) {
          setReading(value);
          const used = usedTokens(value);
          if (used !== null) {
            const previous = lastUsed.current;
            if (previous !== null && used < previous)
              setDrop({ from: previous, to: used, at: value.sampledAt ?? Date.now() });
            lastUsed.current = used;
          }
        }
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
        ? `This response: context ${percent}% used; the provider did not report a compaction threshold`
        : past
          ? `This response: context ${percent}% used, past the ${mark}% auto-compaction threshold`
          : `This response: context ${percent}% used, auto-compacts at ${mark}%`;
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
          <small className="gauge-warn">{past ? "past the line" : "compacts soon"}</small>
        )}
      </Button>
      <Popover.Content placement="top end">
        <Popover.Dialog aria-label="Context usage" className="w-72 p-3 text-sm">
          <b>This response</b>
          {percent === null ? (
            <p>{reading?.reason ?? "Reading provider context…"}</p>
          ) : (
            <>
              <p>
                ≈ {reading!.used!.toLocaleString()} / {reading!.limit!.toLocaleString()} tokens
              </p>
              <p>
                Resets at your next message. brigadier sends every message to a fresh window, so
                this covers the response being written now — never the conversation.
              </p>
              <p>
                <small>
                  {drop
                    ? `Last drop ${drop.from.toLocaleString()} → ${drop.to.toLocaleString()} tokens at ${new Date(drop.at).toLocaleTimeString()}.`
                    : "No drop seen yet."}{" "}
                  A figure that climbs across messages instead of dropping would mean conversation
                  history had been wired back in.
                </small>
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
                    . Only one long response can reach that line; compacting takes about twelve
                    seconds and summarises what this response has done so far.
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
