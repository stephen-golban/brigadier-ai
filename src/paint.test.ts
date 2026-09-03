/**
 * Behaviour tests for `src/paint.ts`, the paint instrument.
 *
 * These pin what must survive the frontend rewrite: the FCP report is sent once, the epoch is the
 * `timeOrigin`-based one and not a page-relative `startTime`, an interaction span resolves only
 * after the **second** animation frame, and a rejecting bridge never escapes the instrument.
 *
 * Three environment facts, verified here rather than assumed:
 *
 *   - **jsdom 30.0.1 does not implement `PerformanceObserver`.** Checked directly:
 *     `new JSDOM("", { pretendToBeVisual: true })` gives `"PerformanceObserver" in window ===
 *     false`, and a bare jsdom window's `performance.mark` / `performance.measure` are
 *     `undefined`. What *is* on `globalThis` under Vitest's jsdom environment is **Node's**
 *     `perf_hooks` observer, whose `supportedEntryTypes` is
 *     `["dns","function","gc","http","http2","mark","measure","net","resource"]` — no `paint`.
 *     Worse than absent: `observe({ type: "paint", buffered: true })` does **not** throw there, it
 *     silently never fires. So these tests install their own stub, which is the only way to drive
 *     the FCP path at all.
 *   - Vitest's default `vi.useFakeTimers()` with no `toFake` list already fakes
 *     `requestAnimationFrame` and `performance` (**[measured]**,
 *     `docs/research/frontend-stack.md` §1.2). That is what drives the double-rAF deterministically
 *     — jsdom's rAF is a `setInterval(…, 1000/60)`, so 17 ms is exactly one frame.
 *   - The faked `performance` keeps a real `timeOrigin` (the epoch millisecond at install) and a
 *     `now()` that starts at 0 and advances with the fake clock, which is what makes the
 *     `timeOrigin + startTime` assertion checkable.
 *
 * Isolation is `vi.resetModules()` plus `await import("./paint")` per test (**[measured]**, §1.6):
 * every piece of the module's state is module-level and there is no test-only `reset()` export to
 * drift.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaintReport } from "./wire";

type Paint = typeof import("./paint");

/** One animation frame. jsdom's rAF period is 1000/60 ms, so 17 ms is one and only one. */
const FRAME_MS = 17;

/* ------------------------------------------------------ PerformanceObserver stub */

interface StubEntry {
  name: string;
  startTime: number;
}

/** Every observer constructed since the last reset, so a test can feed one. */
let observers: StubObserver[] = [];

class StubObserver {
  readonly callback: (list: { getEntries(): StubEntry[] }) => void;
  options: PerformanceObserverInit | null = null;
  disconnected = false;

  constructor(callback: (list: { getEntries(): StubEntry[] }) => void) {
    this.callback = callback;
    observers.push(this);
  }

  observe(options: PerformanceObserverInit): void {
    this.options = options;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  takeRecords(): StubEntry[] {
    return [];
  }

  /** Deliver entries the way a buffered `paint` observer would. */
  emit(entries: StubEntry[]): void {
    this.callback({ getEntries: () => entries });
  }
}

/* --------------------------------------------------------------- bridge double */

/** Every report the instrument handed the bridge, in order. */
let reported: PaintReport[] = [];
/** What the mocked `reportPaint` returns. Swapped per test. */
let reportPaint: (report: PaintReport) => Promise<void> = async (report) => {
  reported.push(report);
};

vi.mock("./bridge", () => ({
  bridge: () => ({
    reportPaint: (report: PaintReport) => reportPaint(report),
  }),
}));

async function load(): Promise<Paint> {
  vi.resetModules();
  return await import("./paint");
}

beforeEach(() => {
  observers = [];
  reported = [];
  reportPaint = async (report) => {
    reported.push(report);
  };
  vi.stubGlobal("PerformanceObserver", StubObserver);
  vi.useFakeTimers();
});

afterEach(() => {
  // `restoreAllMocks` and not just `unstubAllGlobals`: the clock tests below install `vi.spyOn`
  // spies on `performance`, which globals-unstubbing does not undo.
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/* ------------------------------------------------------------------ the tests */

describe("jsdom's own capabilities", () => {
  it("has no PerformanceObserver of its own, which is why these tests stub one", async () => {
    vi.unstubAllGlobals();
    // Vitest leaves Node's `perf_hooks` observer on `globalThis`; jsdom contributes none. What
    // matters for this module is that whatever is there does not support `paint`.
    const supported = (globalThis.PerformanceObserver as unknown as { supportedEntryTypes?: string[] })
      ?.supportedEntryTypes;
    expect(supported === undefined || supported.includes("paint")).toBe(false);
    vi.stubGlobal("PerformanceObserver", StubObserver);
  });
});

describe("first contentful paint", () => {
  it("observes the paint type, buffered, so a paint that already happened is still seen", async () => {
    const paint = await load();
    paint.startPaintInstrumentation();
    expect(observers).toHaveLength(1);
    expect(observers[0].options).toEqual({ type: "paint", buffered: true });
  });

  it("reports timeOrigin + startTime, not startTime", async () => {
    const paint = await load();
    paint.startPaintInstrumentation();
    observers[0].emit([{ name: "first-contentful-paint", startTime: 20 }]);

    expect(reported).toHaveLength(1);
    expect(reported[0]).toEqual({ kind: "fcp", epoch_ms: performance.timeOrigin + 20 });
    // The distinction the assertion above exists for: a page-relative 20 would be indistinguishable
    // from an epoch millisecond to Rust, and would compute a negative launch time.
    expect((reported[0] as { epoch_ms: number }).epoch_ms).not.toBe(20);
    expect(performance.timeOrigin).toBeGreaterThan(1_000_000_000_000);
  });

  it("ignores paint entries that are not first-contentful-paint", async () => {
    const paint = await load();
    paint.startPaintInstrumentation();
    // `first-paint` does not exist in this WebKit, but the filter must not depend on that.
    observers[0].emit([{ name: "first-paint", startTime: 5 }]);
    expect(reported).toHaveLength(0);
  });

  it("sends exactly once even when the start function is called twice", async () => {
    const paint = await load();
    // React 19 StrictMode double-invokes effects; the Rust `subscribe_feed` is idempotent for the
    // same reason.
    paint.startPaintInstrumentation();
    paint.startPaintInstrumentation();
    expect(observers).toHaveLength(1);

    observers[0].emit([{ name: "first-contentful-paint", startTime: 20 }]);
    observers[0].emit([{ name: "first-contentful-paint", startTime: 20 }]);
    paint.startPaintInstrumentation();

    expect(reported).toHaveLength(1);
    expect(observers).toHaveLength(1);
  });

  it("disconnects the observer after the one entry", async () => {
    const paint = await load();
    paint.startPaintInstrumentation();
    expect(observers[0].disconnected).toBe(false);
    observers[0].emit([{ name: "first-contentful-paint", startTime: 20 }]);
    expect(observers[0].disconnected).toBe(true);
  });

  it("does nothing at all when there is no PerformanceObserver", async () => {
    vi.stubGlobal("PerformanceObserver", undefined);
    const paint = await load();
    expect(() => paint.startPaintInstrumentation()).not.toThrow();
    expect(reported).toHaveLength(0);
  });

  it("swallows an observer whose observe() throws", async () => {
    class Hostile extends StubObserver {
      override observe(): void {
        throw new Error("no such entry type");
      }
    }
    vi.stubGlobal("PerformanceObserver", Hostile);
    const paint = await load();
    expect(() => paint.startPaintInstrumentation()).not.toThrow();
    expect(reported).toHaveLength(0);
  });

  it("does not throw out of the instrument when the bridge rejects", async () => {
    reportPaint = () => Promise.reject(new Error("command not found"));
    const paint = await load();
    paint.startPaintInstrumentation();
    expect(() => observers[0].emit([{ name: "first-contentful-paint", startTime: 20 }])).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does not throw out of the instrument when the bridge throws synchronously", async () => {
    reportPaint = () => {
      throw new Error("bridge is gone");
    };
    const paint = await load();
    paint.startPaintInstrumentation();
    expect(() => observers[0].emit([{ name: "first-contentful-paint", startTime: 20 }])).not.toThrow();
  });
});

describe("the trace:dcl signpost", () => {
  /**
   * **Every arrangement here is a measured shape, not a guessed one.** Two versions of this code
   * shipped dead because the test stubbed a page state the app never has: the previous suite set
   * `document.readyState` to `"loading"` and its comment called that "the live shape in the real
   * app". It is the one value the app never holds at that moment, so the test certified the bug.
   *
   * The shapes below come from a real `WKWebView` on this machine (2026-09-04) driving a copy of
   * `dist/index.html` — deferred module in `<head>`, stylesheet beside it, served over HTTP so a
   * navigation entry exists. They are what HTML spec §13.2.7 step 6 predicts: 6.1 sets `Start`,
   * 6.2 fires the event, 6.3 sets `End`, and readiness left `"loading"` back at step 3.
   *
   *     module body      readyState "interactive"  Start 0   End 0
   *     handler entry    readyState "interactive"  Start 14  End 0
   *     after the event  readyState "interactive"  Start 15  End 0
   *     load             readyState "complete"     Start 14  End 14
   *     a listener attached after the event never fires    lateFired: false
   *
   * `readyState` is stubbed in exactly one test — the impossible-state one — because the module
   * reads it in exactly one place. jsdom's `readyState` and navigation timing are both fictions
   * here; that is precisely how this shipped twice.
   */

  /**
   * `document.readyState` in a Vitest jsdom document is **`"complete"`** from the first line
   * (measured) — neither the real value nor the `"loading"` the previous suite invented. So every
   * test here pins it to the shape the probe actually recorded at module-body time,
   * **`"interactive"`**, and the one test about the impossible state pins `"complete"` on purpose.
   */
  function setReadyState(value: DocumentReadyState): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "readyState");
    Object.defineProperty(document, "readyState", { configurable: true, get: () => value });
    return () => {
      delete (document as unknown as Record<string, unknown>).readyState;
      if (descriptor !== undefined) {
        Object.defineProperty(Document.prototype, "readyState", descriptor);
      }
    };
  }

  let restoreReadyState: (() => void) | null = null;

  /**
   * **`vi.resetModules()` does not detach listeners.** A fresh module per test is not a fresh
   * `document`: a listener the previous test's module registered stays on the shared jsdom
   * document, holds its own `dclSent`, and reports through the same mocked bridge — so one
   * `dispatchEvent` here fired two modules and produced two lines. Every listener attached during
   * a test is recorded and removed after it, or the suite silently tests two instruments at once.
   */
  let attached: Array<[string, EventListener]> = [];

  beforeEach(() => {
    restoreReadyState = setReadyState("interactive");
    attached = [];
    const real = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, handler, options) => {
      attached.push([type, handler as EventListener]);
      real(type, handler, options);
    });
  });

  afterEach(() => {
    for (const [type, handler] of attached) document.removeEventListener(type, handler);
    attached = [];
    restoreReadyState?.();
    restoreReadyState = null;
  });

  /** jsdom has no navigation timing at all: `getEntriesByType("navigation")` is `[]` (measured). */
  function navEntry(domContentLoadedEventStart: number, domContentLoadedEventEnd = 0): void {
    vi.spyOn(performance, "getEntriesByType").mockImplementation((type: string) =>
      type === "navigation"
        ? ([
            { domContentLoadedEventStart, domContentLoadedEventEnd },
          ] as unknown as PerformanceEntryList)
        : [],
    );
  }

  function noNavEntry(): void {
    vi.spyOn(performance, "getEntriesByType").mockImplementation(() => []);
  }

  /** jsdom's `Event.timeStamp` is not settable, so the dispatched event carries an explicit one. */
  function dispatchDcl(timeStamp?: number): void {
    const event = new Event("DOMContentLoaded");
    if (timeStamp !== undefined) {
      Object.defineProperty(event, "timeStamp", { value: timeStamp, configurable: true });
    }
    document.dispatchEvent(event);
  }

  function only(): { kind: string; label: string; start_epoch_ms: number; duration_ms: number } {
    expect(reported).toHaveLength(1);
    return reported[0] as never;
  }

  it("reports on the event, from domContentLoadedEventStart, in the real launch shape", async () => {
    // Module body: both navigation-timing fields are 0 (step 6.1 not reached).
    navEntry(0, 0);
    const paint = await load();
    paint.startPaintInstrumentation();
    expect(reported).toHaveLength(0);

    // Handler entry: step 6.1 has run, step 6.3 has not. Measured 14 and 0.
    navEntry(14, 0);
    dispatchDcl(14);

    expect(only()).toEqual({
      kind: "interaction",
      label: "trace:dcl",
      start_epoch_ms: performance.timeOrigin + 14,
      duration_ms: 0,
    });
  });

  it("never reads domContentLoadedEventEnd, which is 0 at every moment a handler can look", async () => {
    // The discriminating case: `End` stays 0, `Start` carries the answer. Code that keyed on `End`
    // — v1 at module body, v2 inside the handler — reports nothing here. That is what the real app
    // did on launch: no `dcl` stage at any position.
    navEntry(0, 0);
    const paint = await load();
    paint.startPaintInstrumentation();
    navEntry(14, 0);
    dispatchDcl(14);
    expect(only().start_epoch_ms).toBe(performance.timeOrigin + 14);
  });

  it("reports synchronously when started late, without waiting for an event that cannot fire", async () => {
    // Measured: a listener attached after DOMContentLoaded never fires. Only an already-fired
    // timestamp rescues a late start.
    const addEventListener = vi.spyOn(document, "addEventListener");
    navEntry(14, 14);
    const paint = await load();
    paint.startPaintInstrumentation();

    expect(only().start_epoch_ms).toBe(performance.timeOrigin + 14);
    expect(
      addEventListener.mock.calls.filter((c) => c[0] === "DOMContentLoaded"),
    ).toHaveLength(0);
  });

  it("reports when started in the interactive window, where End is still 0", async () => {
    // readyState "interactive", Start 15, End 0 — measured. This is the hole in a late-start check
    // keyed on `End`, or in a listener gated on `readyState !== "complete"`: both would attach a
    // listener for an event that has already fired and report nothing at all.
    navEntry(15, 0);
    const paint = await load();
    paint.startPaintInstrumentation();
    expect(only().start_epoch_ms).toBe(performance.timeOrigin + 15);
    expect(only().label).toBe("trace:dcl");
  });

  it("attaches the listener with no gate in front of it when DCL has not fired", async () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    navEntry(0, 0);
    const paint = await load();
    paint.startPaintInstrumentation();
    expect(
      addEventListener.mock.calls.filter((c) => c[0] === "DOMContentLoaded"),
    ).toHaveLength(1);
  });

  it("falls back to the event's timeStamp under the dcl-approx label when there is no navigation entry", async () => {
    // §5.3 measured a null navigation entry under `loadHTMLString(_:baseURL:)`. The number is then
    // the event's dispatch time, a different quantity from step 6.1's, so the stage says so.
    noNavEntry();
    const paint = await load();
    paint.startPaintInstrumentation();
    dispatchDcl(21);

    expect(only()).toEqual({
      kind: "interaction",
      label: "trace:dcl-approx",
      start_epoch_ms: performance.timeOrigin + 21,
      duration_ms: 0,
    });
  });

  it("falls back to handler-entry time under dcl-approx when the event carries no usable timeStamp", async () => {
    // The branch nobody will exercise by accident. `Start` unavailable and `timeStamp` unusable:
    // the number is when we got around to handling it, and the stage never claims otherwise.
    noNavEntry();
    const paint = await load();
    paint.startPaintInstrumentation();
    vi.advanceTimersByTime(30);
    dispatchDcl(Number.NaN);

    expect(only()).toEqual({
      kind: "interaction",
      label: "trace:dcl-approx",
      start_epoch_ms: performance.timeOrigin + 30,
      duration_ms: 0,
    });
  });

  it("reports nothing in the impossible state: complete with Start unset", async () => {
    // Reaching this means steps 6.2 and 6.3 have both run while 6.1 left `Start` at 0, which the
    // spec forbids and the probe never produced. No number exists; none is invented.
    navEntry(0, 0);
    restoreReadyState?.();
    restoreReadyState = setReadyState("complete");

    const paint = await load();
    const addEventListener = vi.spyOn(document, "addEventListener");
    paint.startPaintInstrumentation();
    expect(reported).toHaveLength(0);
    expect(
      addEventListener.mock.calls.filter((c) => c[0] === "DOMContentLoaded"),
    ).toHaveLength(0);
  });

  it("reports once across two starts, and attaches one listener", async () => {
    const onDocument = vi.spyOn(document, "addEventListener");
    navEntry(0, 0);
    const paint = await load();
    // React 19 StrictMode double-invokes effects.
    paint.startPaintInstrumentation();
    paint.startPaintInstrumentation();
    expect(onDocument.mock.calls.filter((c) => c[0] === "DOMContentLoaded")).toHaveLength(1);

    navEntry(14, 0);
    dispatchDcl(14);
    dispatchDcl(14);
    paint.startPaintInstrumentation();
    expect(reported).toHaveLength(1);
  });

  it("reports once when the late-start path is entered twice", async () => {
    navEntry(14, 14);
    const paint = await load();
    paint.startPaintInstrumentation();
    paint.startPaintInstrumentation();
    expect(reported).toHaveLength(1);
  });

  it("still emits when the FCP observer is missing entirely", async () => {
    // The signpost runs ahead of the FCP guards on purpose; an environment with no
    // `PerformanceObserver` must not cost the launch trace.
    vi.stubGlobal("PerformanceObserver", undefined);
    navEntry(14, 14);
    const paint = await load();
    paint.startPaintInstrumentation();
    expect(only().label).toBe("trace:dcl");
  });

  it("does not throw out of the instrument when the bridge rejects", async () => {
    reportPaint = () => Promise.reject(new Error("command not found"));
    navEntry(14, 14);
    const paint = await load();
    expect(() => paint.startPaintInstrumentation()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does not throw out of the instrument when the bridge throws synchronously", async () => {
    reportPaint = () => {
      throw new Error("bridge is gone");
    };
    navEntry(14, 14);
    const paint = await load();
    expect(() => paint.startPaintInstrumentation()).not.toThrow();
  });

  it("does not disturb the FCP report", async () => {
    navEntry(14, 14);
    const paint = await load();
    paint.startPaintInstrumentation();
    observers[0].emit([{ name: "first-contentful-paint", startTime: 20 }]);

    expect(reported).toHaveLength(2);
    expect((reported[0] as { label: string }).label).toBe("trace:dcl");
    expect(reported[1]).toEqual({ kind: "fcp", epoch_ms: performance.timeOrigin + 20 });
  });
});

describe("interaction → painted", () => {
  it("reports nothing until painted() is called", async () => {
    const paint = await load();
    paint.beginInteraction("b4_session_switch");
    vi.advanceTimersByTime(FRAME_MS * 10);
    expect(reported).toHaveLength(0);
  });

  it("resolves only after the SECOND animation frame, never the first", async () => {
    const paint = await load();
    const span = paint.beginInteraction("b4_session_switch");
    span.painted();

    vi.advanceTimersByTime(FRAME_MS);
    // One frame in: the rendering update that drew this commit has not happened yet. A test that
    // passes here has not tested the thing.
    expect(reported).toHaveLength(0);

    vi.advanceTimersByTime(FRAME_MS);
    expect(reported).toHaveLength(1);
  });

  it("carries the label and an epoch start, and a duration spanning the two frames", async () => {
    const paint = await load();
    const startEpoch = performance.timeOrigin + performance.now();
    const span = paint.beginInteraction("b7_button_ack");
    vi.advanceTimersByTime(50);
    span.painted();
    vi.advanceTimersByTime(FRAME_MS * 2);

    expect(reported).toHaveLength(1);
    const report = reported[0] as {
      kind: string;
      label: string;
      start_epoch_ms: number;
      duration_ms: number;
    };
    expect(report.kind).toBe("interaction");
    expect(report.label).toBe("b7_button_ack");
    expect(report.start_epoch_ms).toBe(startEpoch);
    expect(report.start_epoch_ms).toBeGreaterThan(1_000_000_000_000);
    // 50 ms of work plus the two frames it took to see the paint land.
    expect(report.duration_ms).toBeGreaterThanOrEqual(50);
    expect(report.duration_ms).toBeLessThan(50 + 4 * FRAME_MS);
  });

  it("reports once however many times painted() is called", async () => {
    const paint = await load();
    const span = paint.beginInteraction("b6_scrollback");
    span.painted();
    span.painted();
    vi.advanceTimersByTime(FRAME_MS * 4);
    span.painted();
    vi.advanceTimersByTime(FRAME_MS * 4);
    expect(reported).toHaveLength(1);
  });

  it("reports nothing for a cancelled span, even if painted() follows", async () => {
    const paint = await load();
    const span = paint.beginInteraction("b4_session_switch");
    span.cancel();
    span.painted();
    vi.advanceTimersByTime(FRAME_MS * 4);
    expect(reported).toHaveLength(0);
  });

  it("abandons a span that never settles rather than leaving a mark pending forever", async () => {
    const paint = await load();
    const span = paint.beginInteraction("b4_session_switch");
    vi.advanceTimersByTime(paint.INTERACTION_TIMEOUT_MS + 1);
    expect(reported).toHaveLength(0);

    // A late paint after the timeout reports nothing: a duration measured to an unrelated later
    // paint would be quoted as a budget.
    span.painted();
    vi.advanceTimersByTime(FRAME_MS * 4);
    expect(reported).toHaveLength(0);
  });

  it("keeps concurrent spans apart", async () => {
    const paint = await load();
    const a = paint.beginInteraction("b4_session_switch");
    const b = paint.beginInteraction("b6_scrollback");
    b.painted();
    vi.advanceTimersByTime(FRAME_MS * 2);
    expect(reported.map((r) => (r as { label: string }).label)).toEqual(["b6_scrollback"]);

    a.painted();
    vi.advanceTimersByTime(FRAME_MS * 2);
    expect(reported.map((r) => (r as { label: string }).label)).toEqual([
      "b6_scrollback",
      "b4_session_switch",
    ]);
  });

  it("does not throw out of the instrument when the bridge rejects", async () => {
    reportPaint = () => Promise.reject(new Error("command not found"));
    const paint = await load();
    paint.beginInteraction("b4_session_switch").painted();
    expect(() => vi.advanceTimersByTime(FRAME_MS * 2)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("the user-timing buffer", () => {
  /**
   * The window is long-lived by design (`docs/vision.md` §1, "the thread is permanent"), so an
   * entry left behind by one span is left behind for the life of the app. Marks were always
   * cleared; the `performance.measure` entry was not, which is one permanent entry per session
   * switch and per button press once the call sites land.
   *
   * Asserted through spies rather than through `performance.getEntriesByName`: the fake-timer
   * `performance` is a NOOP object whose `mark`/`measure` record nothing at all (**measured** —
   * `getEntriesByName("m")` returns `[]` immediately after a `measure("m", …)` under
   * `vi.useFakeTimers()`), so a buffer assertion would pass whether or not anything cleared it.
   */
  it("clears every measure it creates, not only its marks", async () => {
    const measure = vi.spyOn(performance, "measure");
    const clearMeasures = vi.spyOn(performance, "clearMeasures");
    const paint = await load();

    const a = paint.beginInteraction("b4_session_switch");
    a.painted();
    vi.advanceTimersByTime(FRAME_MS * 2);
    const b = paint.beginInteraction("b7_button_ack");
    b.painted();
    vi.advanceTimersByTime(FRAME_MS * 2);

    expect(reported).toHaveLength(2);
    const created = measure.mock.calls.map((c) => c[0]);
    const cleared = clearMeasures.mock.calls.map((c) => c[0]);
    expect(created).toHaveLength(2);
    // Every entry this module put in the buffer came back out of it. Without the `clearMeasures`
    // call in `finish`, `cleared` is `[]` and this fails.
    expect(cleared).toEqual(created);
  });

  it("leaves nothing behind for a span that was dropped rather than reported", async () => {
    const measure = vi.spyOn(performance, "measure");
    const clearMarks = vi.spyOn(performance, "clearMarks");
    const paint = await load();

    paint.beginInteraction("b4_session_switch").cancel();
    // A dropped span never measures, so there is no measure to clear; its start mark still goes.
    expect(measure).not.toHaveBeenCalled();
    expect(clearMarks.mock.calls.map((c) => c[0])).toEqual([
      "brigadier:b4_session_switch:1:start",
    ]);
  });
});

describe("an unusable clock", () => {
  /**
   * Neither `performance.now` nor `performance.timeOrigin` throws in WebKit or in jsdom, so none
   * of this is reachable today. It is tested because the module's stated principle —
   * a missing number is honest, a wrong one is not — has to hold on every path, and because the
   * previous `0` fallbacks emitted numbers that were wrong in ways nobody downstream could see.
   */
  it("reports nothing when the clock is unavailable at the start of a span", async () => {
    const paint = await load();
    vi.spyOn(performance, "now").mockImplementation(() => {
      throw new Error("no clock");
    });

    const span = paint.beginInteraction("b4_session_switch");
    span.painted();
    vi.advanceTimersByTime(FRAME_MS * 4);

    // With a `0` fallback this reported `duration_ms: 0` against a plausible-looking
    // `start_epoch_ms`, which is indistinguishable from a real 0 ms paint.
    expect(reported).toHaveLength(0);
  });

  it("reports nothing rather than a negative duration when the clock dies mid-span", async () => {
    const paint = await load();
    const real = performance.now.bind(performance);
    let alive = true;
    vi.spyOn(performance, "now").mockImplementation(() => {
      if (!alive) throw new Error("no clock");
      return real();
    });

    const span = paint.beginInteraction("b4_session_switch");
    vi.advanceTimersByTime(50);
    alive = false;
    span.painted();
    vi.advanceTimersByTime(FRAME_MS * 4);

    // With a `0` fallback the duration was `0 - startNow`: negative, written to `paint.ndjson`,
    // and certain to be averaged by whoever reads it.
    expect(reported).toHaveLength(0);
  });

  it("reports nothing when timeOrigin is unavailable, rather than a page-relative epoch", async () => {
    const paint = await load();
    const descriptor = Object.getOwnPropertyDescriptor(performance, "timeOrigin");
    Object.defineProperty(performance, "timeOrigin", {
      configurable: true,
      get() {
        throw new Error("no time origin");
      },
    });
    try {
      const span = paint.beginInteraction("b4_session_switch");
      span.painted();
      vi.advanceTimersByTime(FRAME_MS * 4);
    } finally {
      if (descriptor !== undefined) Object.defineProperty(performance, "timeOrigin", descriptor);
    }

    // With a `0` fallback `start_epoch_ms` was a small page-relative number wearing an epoch
    // field's name.
    expect(reported).toHaveLength(0);
  });

  it("hands back a span that is safe to use after the clock failed", async () => {
    const paint = await load();
    vi.spyOn(performance, "now").mockImplementation(() => {
      throw new Error("no clock");
    });
    const span = paint.beginInteraction("b4_session_switch");
    expect(() => {
      span.painted();
      span.cancel();
      span.painted();
    }).not.toThrow();
    vi.advanceTimersByTime(paint.INTERACTION_TIMEOUT_MS * 2);
    expect(reported).toHaveLength(0);
  });
});
