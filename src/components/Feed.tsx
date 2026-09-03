/**
 * The virtualized feed: one line per event, read as a column rather than scanned as a table.
 *
 * Scope: **the selected session's rows** when a session is selected, otherwise the selected
 * project's rows, interleaved across its sessions in the order the Rust batcher delivered them
 * (which is `t` order, since a batch is one animation frame's worth of rows for one project).
 * The project ring is appended to in arrival order rather than merge-sorted, so the interleave
 * costs nothing per frame.
 *
 * `@tanstack/react-virtual` 3.14.10, configured per `docs/research/feed-rendering.md`
 * "Recommendation", with one documented departure: `directDomUpdates` is **off**. In 3.14.10 it
 * positions items by looking them up in `Virtualizer.elementsCache`
 * (`react-virtual/dist/esm/index.js:44`), and that cache is only populated by
 * `virtualizer.measureElement` as a row ref (`virtual-core/dist/esm/index.js:824-831`) — which
 * is exactly what a fixed-height feed must not call. `useFlushSync: false` buys the thing
 * `directDomUpdates` was wanted for: no `flushSync` on scroll notifications.
 *
 * ---------------------------------------------------------------------------------------------
 * W4-D1, 2026-09-03. **The virtualizer is the constraint; the log table was not.** Every earlier
 * order in this wave said "Feed.tsx does not move", and the measurement behind that sentence is
 * only about windowing: ours renders ~110 DOM nodes at 60 Hz over 1,513 samples and the
 * implementation we rejected renders every message. Keeping the virtualizer and a fixed integer
 * row height is non-negotiable. Keeping a zebra-striped fixed-pitch grid was never part of it.
 *
 * What made the old row read as diagnostic, and what replaced it:
 *
 *   - **A left gutter of metadata.** `HH:MM:SS` at full weight and the raw envelope `seq`,
 *     right-aligned in its own 52px column, before any content. A table puts its keys in columns
 *     on the left; a document puts them in the margin. The seq is gone — it is a wire artifact,
 *     not user content — and the clock moved into the left margin, **outside the reading
 *     measure**, where it cannot be read before the line it labels.
 *   - **A mark on every row.** The clock printed the same three fields on seven consecutive rows
 *     inside one second. A mark that never changes is not information. Now the margin prints
 *     only where something changed: the clock minute, or (in project view) the session. Most
 *     rows carry no mark at all, so the margin is a rhythm instead of a column.
 *   - **Alternating fills.** Zebra striping exists to help an eye track one row across a wide
 *     table. The measure does that job now (a 712px column, `--content-max`, instead of ~1004px
 *     of full bleed), and hover does the rest — on demand, for the row under the pointer, rather
 *     than permanently for every row.
 *   - **Fixed pitch for prose.** `l` is a sentence: `session started · <model> · <cwd>`,
 *     `context compacted · <trigger>`, and `docs/vision.md` §9's `Phase 2 green — 41 tests pass.`
 *     Monospace for a sentence is a terminal signal and buys nothing, because nothing in the
 *     column is aligned to anything. 13px system sans; the margin marks stay mono, because a
 *     clock and a session ref are data.
 *
 * **What this order could not do, and why the shape below is not the final one.** Telling a
 * model's answer apart from a tool call, or a failure from a summary, means parsing `l`'s leading
 * label. Rust is adding a `k` kind field to the wire for exactly that, and per-kind hierarchy is
 * W4-D2's. So there is deliberately no verbose toggle, no prose-versus-tool weighting and no
 * per-kind colour here. The two places the design wanted a kind and did without it:
 *   - a failure row should not be the same grey as a successful tool call, and `--color-bad`
 *     exists for it;
 *   - `approval asked` is the one row in the feed that means a person is blocked, and it should
 *     carry weight the way the sidebar's ask row does.
 * Both are one `r.k` away and neither is guessable from the string.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import * as store from "../feedStore";
import type { ProjectId, SessionId } from "../wire";

/**
 * Integer CSS px. A fractional row height drifts against the sizer at devicePixelRatio 2.
 *
 * 28 rather than the old 18 [derived 2026-09-03]. At 18px with a 12px face the pitch is a
 * terminal's: the ink fills two thirds of every row and consecutive lines touch, which is most of
 * why seven rows read as a log dump. At 28 a 13px line sits in ~19px of line box with ~4.5px
 * clear above and below, the pane shows ~21 lines instead of ~33, and a group rule has somewhere
 * to sit. Windowing cost is unchanged — the virtualizer renders a screenful either way.
 *
 * **Kept in step with `--feed-row-h` in `src/index.css`**, which is the row's `line-height`.
 * They must be the same integer or the text stops being centred in its box.
 */
export const ROW_H = 28;

/** Slack before the tail detaches, in px — feed-rendering.md §1. */
const SCROLL_END_THRESHOLD = 24;

/** `HH:MM`. Seconds are diagnostic detail; the full clock is in the row's `title`. */
function hhmm(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `HH:MM:SS`, for the title only. */
function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Which printed minute a timestamp falls in, without constructing a `Date`.
 *
 * Epoch-minute boundaries coincide with printed `HH:MM` boundaries in every UTC offset in use
 * today, including the :30 and :45 ones — an offset would have to be a non-whole number of
 * minutes for these to disagree, and no current zone has one.
 */
function minuteOf(ms: number): number {
  return Math.floor(ms / 60_000);
}

function shortId(id: string): string {
  return id.length <= 6 ? id : id.slice(-6);
}

/** The empty state's mark: three terse lines, which is what this pane holds. Inline SVG rather
 *  than the `>_` it replaces — a terminal prompt is the most on-the-nose signal in the app, and
 *  which font on the machine claims a codepoint, at what weight and on what baseline, is not
 *  something to delegate. `currentColor` always renders. */
function LinesMark() {
  return (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false">
      <path
        d="M4 8h20M4 14h15M4 20h9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The jump affordance's direction, replacing a `↓` text glyph for the same reason. */
function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
      <path
        d="M1.75 3.75 5 7l3.25-3.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface FeedProps {
  sessionId: SessionId | null;
  projectId: ProjectId | null;
  /** Shown in the empty state, the way the reference names the project in its empty chat. */
  projectName?: string | null;
}

export function Feed({ sessionId, projectId, projectName }: FeedProps) {
  const rows = useSyncExternalStore(store.subscribe, () =>
    sessionId !== null ? store.getSessionRows(sessionId) : store.getProjectRows(projectId),
  );

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [atEnd, setAtEnd] = useState(true);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    // Follows the tail only when the reader was already at the bottom, and re-anchors the
    // scroll offset when the ring drops rows off the head. WebKit 26.5 has no scroll anchoring
    // of its own, so this is not decoration.
    anchorTo: "end",
    followOnAppend: "auto",
    scrollEndThreshold: SCROLL_END_THRESHOLD,
    useScrollendEvent: true,
    useFlushSync: false,
    getItemKey: (index) => {
      const r = rows[index];
      return r === undefined ? index : `${r.s}#${r.q}`;
    },
  });

  // "Detached from the tail" is read off the DOM, not off React state, so the pill does not
  // cost a render per scroll event.
  const syncAtEnd = useCallback(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtEnd((prev) => {
      const next = distance <= SCROLL_END_THRESHOLD;
      return prev === next ? prev : next;
    });
  }, []);

  useEffect(() => {
    syncAtEnd();
  }, [rows, syncAtEnd]);

  const jump = useCallback(() => {
    virtualizer.scrollToEnd();
    setAtEnd(true);
  }, [virtualizer]);

  const items = virtualizer.getVirtualItems();

  return (
    <section className="feed">
      <span className="feed-count">
        {rows.length} row{rows.length === 1 ? "" : "s"}
        {rows.length >= store.ROW_CAP ? ` (capped at ${store.ROW_CAP})` : ""}
      </span>
      <div className="feed-scroller" ref={scrollerRef} onScroll={syncAtEnd}>
        <div className="feed-sizer" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {items.map((item) => {
            const r = rows[item.index];
            if (r === undefined) return null;
            // Both structural, both O(1), and neither reads a character of `l`. `rows` is the
            // whole array, so the row before this one is a plain index lookup even though only a
            // window of them is mounted.
            const prev = item.index === 0 ? undefined : rows[item.index - 1];
            const newMinute = prev === undefined || minuteOf(prev.t) !== minuteOf(r.t);
            const newSession = sessionId === null && (prev === undefined || prev.s !== r.s);
            // The rule marks the clock minute and nothing else. Session changes deliberately do
            // NOT draw one: in a project view with three live sessions the rows interleave, every
            // row would be a boundary, and a rule on every row is the grid this order removed.
            // A minute boundary can appear at most once a minute however the rows interleave.
            const lead = newMinute && item.index > 0;
            return (
              <div
                key={item.key}
                className={lead ? "feed-row lead" : "feed-row"}
                style={{ height: `${ROW_H}px`, transform: `translateY(${item.start}px)` }}
                title={`${clock(r.t)}  ${r.l}`}
              >
                <span className="feed-line">{r.l}</span>
                {newMinute || newSession ? (
                  <span className="feed-mark">
                    {newMinute ? <span className="mark-t">{hhmm(r.t)}</span> : null}
                    {newSession ? <span className="mark-s">{shortId(r.s)}</span> : null}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="thread-empty">
          <span className="mark" aria-hidden="true">
            <LinesMark />
          </span>
          <h2>
            {projectName != null && projectName !== ""
              ? `What should we run in ${projectName}?`
              : "Add a project to begin"}
          </h2>
          <p>
            {sessionId !== null
              ? "This session has not emitted a row yet."
              : projectId !== null
                ? "Every session under this project shows up here as it runs."
                : "Use the plus beside Projects in the sidebar to add a repository path."}
          </p>
        </div>
      ) : null}
      {atEnd ? null : (
        <button type="button" className="jump-pill" onClick={jump}>
          Jump to latest
          <ChevronDownIcon />
        </button>
      )}
    </section>
  );
}
