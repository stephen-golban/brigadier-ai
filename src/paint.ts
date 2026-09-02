/**
 * The paint instrument: the app timing its own pixels.
 *
 * Three of the eight budgets in `docs/vision.md` §9 — **B4** (click a session → its last
 * screenful painted), **B6** (the rest of the 500-row scrollback filled in) and **B7** (any button
 * → visible acknowledgement) — are guesses with nothing behind them, and they stay guesses until
 * the app can time its own paints. This module is that instrument. It produces no number by
 * itself and it changes no budget.
 *
 * The recipe is `docs/research/perceived-performance.md` §5.3, which was measured against a real
 * `WKWebView` on this machine. What that section establishes, and what this file is built on:
 *
 *   - `performance.timeOrigin` is directly comparable to Rust's
 *     `SystemTime::now().duration_since(UNIX_EPOCH)`. **[documented]** W3C High Resolution Time
 *     defines it as the duration from the *estimated* monotonic time of the Unix epoch;
 *     **[measured]** `Date.now() - timeOrigin === performance.now()` held to the millisecond in
 *     the real webview. So an epoch millisecond computed here subtracts cleanly against the `T0`
 *     stamped at the top of Rust's `main()`.
 *   - There is **no `first-paint` entry** in this WebKit, only `first-contentful-paint`.
 *     **[measured]**
 *   - `PerformanceObserver.supportedEntryTypes` came back as `["event","first-input",
 *     "largest-contentful-paint","mark","measure","navigation","paint","resource"]` —
 *     **no `element`, no `longtask`, no `long-animation-frame`**. **[measured]** Element timing
 *     and long-task observers are not options here; they would silently never fire.
 *   - Buffered observation is what makes the `paint` observer robust: LCP is readable *only*
 *     through `buffered: true` (`getEntriesByType` returns `[]`), and the same flag is what lets
 *     this module be installed after FCP has already happened and still see it. **[measured]**
 *
 * **Honest limits, in the numbers this produces.** FCP is a *render* timestamp, not a
 * presentation timestamp — `LargestContentfulPaint.presentationTime` "always returns null" in
 * WebKit 26.5 — so the photons land some frames after the number reported here; it is not "when
 * the user saw it". And the Rust delta is `main()` entry → FCP, never `posix_spawn` → FCP: the
 * dyld/pre-main segment is invisible from inside the process (§5.1).
 *
 * **`beginInteraction` has no caller yet, and that is intended.** The components that would use
 * it (`App.tsx`, the feed, the composer) are being deleted and rewritten; the call sites land with
 * the shell and surface orders **W4-C / W4-D** that create those components. This is not dead
 * code, it is an instrument shipped ahead of its dials.
 *
 * **[measured]** 2026-09-02: having no importer means the interaction half is **tree-shaken out of
 * the production bundle entirely** — `beginInteraction`, the double-rAF, the marks and measures,
 * the timeout, `INTERACTION_TIMEOUT_MS` and `INERT_SPAN`, all of it. In `dist/assets/index-*.js`,
 * `first-contentful-paint` and `report_paint` each appear once, while `brigadier:` and
 * `clearMeasures` appear zero times. Two consequences: an edit to this half moves the bundle by
 * zero bytes, which looks exactly like a build that did not run and is not; and this code has
 * never been in a shipped bundle at all — only Vitest, which imports the module directly and does
 * no tree-shaking, has ever run it. W4-C / W4-D pay the bytes when they add the first caller.
 *
 * Framework-free on purpose: no React import, so every path here is testable without rendering.
 * Every failure is swallowed, the way `fps.ts` swallows its `recordFrameStats` rejection — an
 * instrument that can take the app down is worse than no instrument.
 */
import { bridge } from "./bridge";
import type { PaintReport } from "./wire";

/* ------------------------------------------------------ first contentful paint */

/** The one entry name that exists here. `first-paint` does not (**[measured]**, §5.3). */
const FCP_ENTRY = "first-contentful-paint";

let fcpObserver: PerformanceObserver | null = null;
let fcpSent = false;

/**
 * Watch for the first contentful paint and report it exactly once.
 *
 * Safe to call any number of times: React 19 StrictMode double-invokes effects, which is the same
 * reason `subscribe_feed`'s Rust side is explicitly idempotent (`src-tauri/src/sink.rs`). A second
 * call with an observer already installed, or with the report already sent, does nothing.
 *
 * The observer is `buffered: true`, so **installing it late still sees an FCP that already
 * happened**. Ordering against `createRoot` in `main.tsx` is therefore not load-bearing — this is
 * stated so the next reader does not preserve an ordering that carries no meaning.
 *
 * The observer disconnects itself after the one entry; there is nothing else on the `paint` type
 * worth holding a subscription for.
 */
export function startPaintInstrumentation(): void {
  if (fcpSent || fcpObserver !== null) return;
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name !== FCP_ENTRY) continue;
        // `startTime` is relative to `timeOrigin`; the sum is a Unix epoch millisecond, which is
        // the only clock Rust can subtract its `main()` stamp from.
        sendFcp(performance.timeOrigin + entry.startTime);
        return;
      }
    });
    observer.observe({ type: "paint", buffered: true });
    fcpObserver = observer;
  } catch {
    // No `paint` entry type, or an observer that would not construct. Report nothing rather than
    // fail the page.
  }
}

function sendFcp(epochMs: number): void {
  if (fcpSent) return;
  fcpSent = true;
  disconnectFcp();
  report({ kind: "fcp", epoch_ms: epochMs });
}

function disconnectFcp(): void {
  const observer = fcpObserver;
  fcpObserver = null;
  if (observer === null) return;
  try {
    observer.disconnect();
  } catch {
    // A disconnect that throws leaves an observer whose callback is already a no-op.
  }
}

/* ------------------------------------------------------ interaction → painted */

/**
 * How long an unresolved interaction is kept before it is abandoned.
 *
 * **Decision for an interaction that never settles** (the component unmounted, the paint never
 * came): after this it is **dropped — its marks cleared, nothing reported**. A missing number is
 * honest; a duration measured to some unrelated later paint is a lie that would be quoted as a
 * budget. Leaving the mark pending forever is the mild version of trap 11 in
 * `docs/research/perceived-performance.md` — an optimistic entry whose retirement trigger never
 * fires.
 *
 * 5 s is far outside any of B4 (100 ms), B6 (250 ms) or B7 (100 ms): a span that takes this long
 * has already failed, and the reason it did will not be in this number.
 */
export const INTERACTION_TIMEOUT_MS = 5000;

/** Prefix on every `performance.mark`/`measure` name, so the Inspector timeline is greppable. */
const MARK_PREFIX = "brigadier:";

/**
 * A span in flight. The call site does exactly two things and nothing more: it named the
 * interaction when it started, and it says here that the commit which paints the result has
 * happened.
 *
 * The double-`requestAnimationFrame`, the mark/measure names, the epoch arithmetic and the
 * reporting all stay inside this module, so no call site can get the double-rAF wrong.
 */
export interface PaintedSpan {
  /**
   * Call from the effect that runs **after the commit that paints this interaction's result**.
   * The report is sent one further frame later, once the rendering update has actually drawn.
   *
   * Idempotent: a second call, or a call after the span was cancelled or timed out, does nothing.
   */
  painted(): void;
  /** Abandon the span: clear its entries, report nothing. Idempotent. */
  cancel(): void;
}

let spanSeq = 0;

/**
 * Start timing an interaction. `label` is what names the budget on the written line — B4, B6 or
 * B7 in `docs/vision.md` §9 — and is written verbatim, so keep it stable across call sites.
 *
 * The measured number is the `performance.now()` delta between the mark and the second animation
 * frame after `painted()`. `performance.mark`/`performance.measure` (Safari 11+, **[documented]**
 * BCD) are emitted alongside so the span shows in Web Inspector's timeline; the delta is not read
 * back out of them, because the entry APIs are not uniformly available and an instrument that
 * depends on the buffer is an instrument that reports nothing when the buffer is full.
 */
export function beginInteraction(label: string): PaintedSpan {
  const id = ++spanSeq;
  const startMark = `${MARK_PREFIX}${label}:${id}:start`;
  const endMark = `${MARK_PREFIX}${label}:${id}:painted`;
  const measureName = `${MARK_PREFIX}${label}:${id}`;

  const startNow = now();
  const origin = timeOrigin();
  if (startNow === null || origin === null) {
    // No usable clock, so there is no honest number to be had. Report nothing rather than a
    // page-relative `start_epoch_ms` that looks like an epoch — the same principle
    // `INTERACTION_TIMEOUT_MS` states, applied to a different failure.
    return INERT_SPAN;
  }
  // Re-bound past the guard: `finish` is a hoisted function declaration, so TypeScript will not
  // carry the null-narrowing of `startNow` into it.
  const startedAt: number = startNow;
  const startEpochMs = origin + startedAt;
  mark(startMark);

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => {
      timer = null;
      finish(null);
    },
    INTERACTION_TIMEOUT_MS,
  );

  /** `endNow` is `null` to drop the span: clear up and report nothing. */
  function finish(endNow: number | null): void {
    if (settled) return;
    settled = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (endNow === null) {
      clearMarks(startMark);
      return;
    }
    mark(endMark);
    measure(measureName, startMark, endMark);
    // Every entry this span created is cleared, the measure included. The window is long-lived by
    // design — `docs/vision.md` §1, "the thread is permanent" — so once B4/B6/B7 call sites land
    // this runs on every session switch and every button press for the life of the window. A
    // measure left behind is a permanent entry, and enough of them are what fill the user-timing
    // buffer this module is careful not to read from.
    clearMarks(startMark);
    clearMarks(endMark);
    clearMeasures(measureName);
    report({
      kind: "interaction",
      label,
      start_epoch_ms: startEpochMs,
      duration_ms: endNow - startedAt,
    });
  }

  return {
    painted() {
      if (settled) return;
      // Two frames, not one. The first callback runs *before* the rendering update that draws
      // this commit; the second runs after it. A single rAF measures the wrong edge.
      // see docs/research/perceived-performance.md §5.3, last paragraph.
      try {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            // `now()` is `null` only if the clock went away mid-span; `finish` then drops it
            // rather than report `0 - startNow`, which is negative and would be averaged.
            finish(now());
          });
        });
      } catch {
        // No rAF at all: drop the span rather than report an untrustworthy duration.
        finish(null);
      }
    },
    cancel() {
      finish(null);
    },
  };
}

/** The span handed back when there was no clock to start one with. Reports nothing, ever. */
const INERT_SPAN: PaintedSpan = {
  painted() {},
  cancel() {},
};

/* ------------------------------------------------------------------- plumbing */

/**
 * Fire and forget, exactly like `fps.ts`'s `recordFrameStats` call: an instrument that can take
 * the app down is worse than no instrument, so a rejected invoke — or a bridge that throws
 * synchronously — is swallowed here and nowhere else.
 */
function report(payload: PaintReport): void {
  try {
    void bridge()
      .reportPaint(payload)
      .catch(() => {});
  } catch {
    // No bridge (a bare test page, a torn-down module): nothing to report to.
  }
}

/* The two clock reads below return `null` rather than a fallback number, and every caller drops
   the span on `null`. A `0` fallback would put a page-relative `start_epoch_ms` and a *negative*
   `duration_ms` into `paint.ndjson`, indistinguishable from real ones and certain to be averaged
   by whoever reads the file. A missing line is honest; a wrong number is not. Neither
   `performance.now` nor `performance.timeOrigin` throws in WebKit or in jsdom, so this is the
   file's principle holding on an unreachable path, not a live bug.

   The mark/measure/clear helpers below are different and keep swallowing: they are Web Inspector
   timeline sugar, no reported number comes from them, and jsdom has no `performance.mark` at all. */

function now(): number | null {
  try {
    const t = performance.now();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

function timeOrigin(): number | null {
  try {
    const t = performance.timeOrigin;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

function mark(name: string): void {
  try {
    performance.mark(name);
  } catch {
    // Inspector-timeline sugar only; the number does not come from here.
  }
}

function measure(name: string, start: string, end: string): void {
  try {
    performance.measure(name, start, end);
  } catch {
    // As above.
  }
}

function clearMarks(name: string): void {
  try {
    performance.clearMarks(name);
  } catch {
    // As above.
  }
}

function clearMeasures(name: string): void {
  try {
    performance.clearMeasures(name);
  } catch {
    // As above.
  }
}
