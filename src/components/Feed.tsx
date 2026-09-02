/**
 * The virtualized terse-row feed.
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
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import * as store from "../feedStore";
import type { ProjectId, SessionId } from "../wire";

/** Integer CSS px. A fractional row height drifts against the sizer at devicePixelRatio 2. */
export const ROW_H = 18;

/** Slack before the tail detaches, in px — feed-rendering.md §1. */
const SCROLL_END_THRESHOLD = 24;

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function shortId(id: string): string {
  return id.length <= 6 ? id : id.slice(-6);
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
            return (
              <div
                key={item.key}
                className={item.index % 2 === 0 ? "feed-row" : "feed-row alt"}
                style={{ height: `${ROW_H}px`, transform: `translateY(${item.start}px)` }}
              >
                <span className="col-t">{clock(r.t)}</span>
                {sessionId === null ? <span className="col-s">{shortId(r.s)}</span> : null}
                <span className="col-q">{r.q}</span>
                <span className="col-l">{r.l}</span>
              </div>
            );
          })}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="thread-empty">
          <span className="mark" aria-hidden="true">
            &gt;_
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
          Jump to latest ↓
        </button>
      )}
    </section>
  );
}
