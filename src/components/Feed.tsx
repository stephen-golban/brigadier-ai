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
 * only about windowing: ours renders a screenful and the implementation we rejected renders every
 * message. Keeping the virtualizer and a fixed integer row height is non-negotiable. Keeping a
 * zebra-striped fixed-pitch grid was never part of it.
 *
 * **The number that sentence used to quote is superseded, corrected 2026-09-04**
 * (`docs/research/visual-checks-2026-09-04.md` §3.1, §3.6, §3.7). It read "~110 DOM nodes at
 * 60 Hz over 1,513 samples", and two of its three parts were wrong:
 *   - **60 Hz holds**, and it is now measured on *this* markup: 62 of 62 one-second windows at
 *     `hz 60`, `p50 17.0 ms`, under a 10-session / 200-rows-per-second burn while scrolling,
 *     2026-09-04 (§3.4). On a **debug** build, which is strictly worse than what ships.
 *   - **"1,513 one-second samples" is superseded as a citation.** `864a2fe` changed `ROW_H`
 *     18 → 28 at 2026-09-04 01:39, and the last window in `frame-stats.ndjson` before that run
 *     is 2026-09-03 14:24 — so every sample behind that number predates the markup it described.
 *   - **"~110 DOM nodes" was never a feed metric.** `dom_nodes` is
 *     `document.getElementsByTagName("*").length` (`src/fps.ts:182`) — the whole document,
 *     sidebar included; it reads 123 at idle in a release window and 505 under that burn. The
 *     **feed row is 2 DOM nodes** (`div.feed-row` + `span.feed-line`), 3 when it carries a mark,
 *     and 23 rendered rows cost 47 nodes under `.feed-sizer` (§3.6, Chromium + mock).
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
 * ---------------------------------------------------------------------------------------------
 * W4-D2, 2026-09-04. **The kind arrived, and the three things W4-D1 could not do are done.**
 * `FeedRowWire.k` (`src/wire.ts`, `docs/plans/ipc-contract.md` §"the kind discriminator") is the
 * discriminator that removes every reason to parse `l`. Nothing below reads a character of the
 * line, and nothing below moves the virtualizer or `ROW_H`: **filtering changes what is in the
 * `rows` array, never how a row is drawn.**
 *
 *   1. **The verbose toggle**, which `docs/vision.md` §9 has specified since it was written:
 *      *"One line per event, harness-derived. … Model prose lives entirely behind a verbose
 *      toggle."* Model prose is exactly `k === "text"` (`ItemKind::AssistantText` and
 *      `Event::ContentDelta`). Terse is the default and hides it; verbose shows everything.
 *      `think` is deliberately **not** hidden: its `terse_line` is a harness-derived summary
 *      (`thinking · 340 tokens`), not the model's reasoning text, so it is already one line per
 *      event and hiding it would remove information rather than prose.
 *   2. **A failure row is not the same grey as a successful tool call.** `k === "err"` takes
 *      `--color-bad`.
 *   3. **`k === "appr"` is the one row that means a person is blocked**, and it carries weight
 *      the way the sidebar's ask row does — `.side-nav.waiting` lifts that row out of
 *      `--color-text-muted-side` into full reading colour, and this does the same thing to the
 *      line, plus 600 weight. See `src/index.css`.
 *
 * **`unknown` is the one kind that is not a claim about the row**, and the filter leaves it alone
 * under every setting. It is the absence of a class, not a class: 10,037 of the owner's rows
 * predate migration 1 and carry it, and a filter that treated it as one would hide all of them.
 * `crates/store/tests/feed.rs::kind_is_pinned_for_every_variant` pins that `feed::kind` never
 * produces it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import * as store from "../feedStore";
import type { FeedRowWire, ProjectId, SessionId } from "../wire";

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

/**
 * The one kind the terse feed hides: model prose.
 *
 * `docs/plans/ipc-contract.md` derives `text` from `ItemKind::AssistantText` and
 * `Event::ContentDelta` and from nothing else, so this single value is the whole of
 * `docs/vision.md` §9's "model prose lives entirely behind a verbose toggle".
 */
const PROSE: FeedRowWire["k"] = "text";

/**
 * The visible rows under a verbose setting, and the **only** place `k` decides whether a row
 * exists.
 *
 * Two invariants, in one function so neither can be lost in a branch:
 *
 *   - **`unknown` survives every setting.** It is not a class (`src/wire.ts` `FeedKind`), and the
 *     predicate below can only ever remove `text`, so a row that claims no class is never removed
 *     by anything. 10,037 of the owner's rows are in that state.
 *   - **Verbose allocates nothing.** It returns the store's own array by identity, so the common
 *     "show me everything" path adds no copy per frame to a store that changes up to 60 times a
 *     second. Terse costs one `filter` over at most `ROW_CAP` (2,000) rows per store change,
 *     memoised on `[rows, verbose]` so it runs once per commit rather than once per render.
 */
function visibleRows(rows: readonly FeedRowWire[], verbose: boolean): readonly FeedRowWire[] {
  return verbose ? rows : rows.filter((r) => r.k !== PROSE);
}

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
  const all = useSyncExternalStore(store.subscribe, () =>
    sessionId !== null ? store.getSessionRows(sessionId) : store.getProjectRows(projectId),
  );

  /**
   * Terse is the default, which is `docs/vision.md` §9's default: one harness-derived line per
   * event. Component state, not `localStorage`: unlike the frame meter this is a reading
   * preference rather than an instrument setting, and `Feed` is not unmounted when the selected
   * session changes, so it survives everything except a reload. Not persisted across launches —
   * stated rather than implied.
   */
  const [verbose, setVerbose] = useState(false);
  const rows = useMemo(() => visibleRows(all, verbose), [all, verbose]);
  const hidden = all.length - rows.length;

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
      {/*
        The band above row 0: the toggle, then the count. One absolutely-positioned flex row so
        the two stay on one line and keep the alignment `.feed-count` already had — hard against
        the right edge of the reading column, not of the pane.

        The count reports both numbers whenever the two differ. A pane that silently showed 12 of
        30 rows would be the worst outcome of this whole feature: the operator would be reading a
        feed with holes in it and have no way to know.
      */}
      <div className="feed-band">
        <button
          type="button"
          className="feed-verbose"
          aria-pressed={verbose}
          title={verbose ? "hide model prose" : "show model prose"}
          onClick={() => setVerbose((v) => !v)}
        >
          verbose
        </button>
        <span className="feed-count">
          {hidden > 0
            ? `${rows.length} of ${all.length} rows`
            : `${rows.length} row${rows.length === 1 ? "" : "s"}`}
          {all.length >= store.ROW_CAP ? ` (capped at ${store.ROW_CAP})` : ""}
        </span>
      </div>
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
            // The two per-kind treatments, resolved to booleans **here** rather than inline in
            // the `className` below. `src/index.css.test.ts` reads every string literal out of a
            // `className` expression, so an inline `r.k === "err" ? …` reports `.err` and `.appr`
            // as classes with no rule and fails that gate — which it did, and it was right to:
            // it cannot tell a comparison operand from a class name, and neither can a reader
            // skimming the attribute.
            const failed = r.k === "err";
            const blocked = r.k === "appr";
            return (
              <div
                key={item.key}
                className={lead ? "feed-row lead" : "feed-row"}
                style={{ height: `${ROW_H}px`, transform: `translateY(${item.start}px)` }}
                title={`${clock(r.t)}  ${r.l}`}
              >
                {/*
                  Plain string literals, never a template with `${…}` in it: `index.css.test.ts`
                  blanks template interpolations, so a computed class name is invisible to the gate
                  that proves every class has a hand-written rule, and would ship unstyled with no
                  error. Same reason `lead` is a ternary on the row above.
                */}
                <span className={failed ? "feed-line bad" : blocked ? "feed-line ask" : "feed-line"}>
                  {r.l}
                </span>
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
      {/*
        Keyed on `all`, not on `rows`: "this session has not emitted a row yet" must stay a fact
        about the feed rather than about the filter. A session that has emitted only model prose
        gets the second state below, which says what is hidden and how to see it — never the
        first, which would be a lie the toggle told.
      */}
      {all.length === 0 ? (
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
      ) : rows.length === 0 ? (
        <div className="thread-empty">
          <span className="mark" aria-hidden="true">
            <LinesMark />
          </span>
          <h2>Every row so far is model prose</h2>
          <p>Turn verbose on to read it.</p>
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
