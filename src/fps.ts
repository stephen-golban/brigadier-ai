/**
 * The frame meter from `docs/research/feed-rendering.md` §3c.
 *
 * It runs inside the one rAF loop that `feedStore` owns — the drain runs first, then this
 * samples, so a frame time includes the work the drain did in it.
 *
 * Four things keep it honest:
 *   - the cadence is **derived**, not assumed: the 10th-percentile frame time is the display's
 *     true period, because a frame can be late but never early. WKWebView is 60 Hz or 120 Hz
 *     depending on the OS version and a WebKit preference we do not control;
 *   - that derivation is guarded against a p10 that landed on a *sub-multiple* of the real period
 *     (`derivePeriod` below), which otherwise halves the budget and invents dropped frames;
 *   - `dropped` counts missed vsyncs (`round(dt/budget) - 1`), not "frames under 60";
 *   - rAF is *paused*, not slowed, in a hidden window, so any `dt > 1000` is discarded and the
 *     window restarted, or the first ⌘-tab poisons the run.
 *
 * `longtask` and `long-animation-frame` do not exist in WebKit 26.5, so everything is derived
 * from `performance.now()` deltas.
 */
import { bridge } from "./bridge";
import type { FrameStats } from "./wire";

/**
 * One closed window, as the front end holds it: the wire struct plus which percentile the cadence
 * came from. `hz_source` is **front-end only** — `record_frame_stats` takes the `FrameStats` in
 * `docs/plans/ipc-contract.md` and nothing else, so it is stripped before the invoke.
 */
export interface WindowReport extends FrameStats {
  hz_source: "p10" | "p50";
}

const REPORT_INTERVAL_MS = 1000;
/** Frame times, in ms, for the window being accumulated. */
let acc: number[] = [];
let last = 0;
let windowStartPerf = 0;
let windowStartWall = 0;
let dropRun = 0;
let longestDropRun = 0;
let started = false;

let lastReport: WindowReport | null = null;
let capture: WindowReport[] | null = null;
const listeners = new Set<() => void>();

const STORAGE_KEY = "brigadier.fps";
let enabled = readEnabled();

function readEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "on") return true;
    if (raw === "off") return false;
  } catch {
    // Private mode or a disabled store: fall through to the default.
  }
  return import.meta.env.DEV;
}

/** Whether the meter reports (it always samples; sampling costs one `performance.now()`). */
export function isEnabled(): boolean {
  return enabled;
}

export function setEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Not being able to remember the toggle is not worth an error path.
  }
  notify();
}

/* --------------------------------------------------------------- sampling */

/** Called once per animation frame from the shared loop in `feedStore`. */
export function sampleFrame(): void {
  const now = performance.now();
  if (!started) {
    started = true;
    last = now;
    windowStartPerf = now;
    windowStartWall = Date.now();
    return;
  }
  const dt = now - last;
  last = now;

  // Hidden window: rAF was paused, not slow. Throw the window away rather than record a 4 s frame.
  if (dt > 1000) {
    resetWindow(now);
    return;
  }

  acc.push(dt);
  if (now - windowStartPerf >= REPORT_INTERVAL_MS && acc.length >= 2) report(now);
}

function resetWindow(now: number): void {
  acc = [];
  dropRun = 0;
  longestDropRun = 0;
  windowStartPerf = now;
  windowStartWall = Date.now();
}

/** Periods a real panel runs at, in ms: 120 Hz, 60 Hz, 30 Hz. */
const CADENCES = [1000 / 120, 1000 / 60, 1000 / 30];

/**
 * The display period for one window of frame times, and which percentile it came from.
 *
 * The 10th percentile is the honest estimator — a frame can be late but never early — right up
 * until it is not. **[measured]** In an early 10-session run (Chrome for Testing 152, not
 * WKWebView) three windows had ≥10% of their frames arrive near 8.3 ms while `p50` stayed at
 * 16.6 ms; p10 landed on a sub-multiple of the real period, `hz` came out 120, the budget halved,
 * and the window was charged 43 dropped vsyncs it had not dropped.
 *
 * So p10 is believed only when it agrees with the median; otherwise the median wins. Either way
 * the chosen sample is **snapped to the nearest real cadence** before it is returned — an
 * un-snapped p10 is what turned a healthy WKWebView run into a false "70 Hz" / "80 Hz" panel and
 * flagged 18 ms frames as failures (see feed-rendering.md §3c). `hz` in `report` below is derived
 * from this already-snapped period, so it can only ever be 120, 60 or 30.
 *
 * `sorted` must be ascending. Pure: reads no module state.
 */
export function derivePeriod(sorted: number[]): { period: number; source: "p10" | "p50" } {
  const n = sorted.length;
  if (n === 0) return { period: 1000 / 60, source: "p50" };
  const p10 = sorted[Math.min(n - 1, Math.floor(n * 0.1))];
  const p50 = sorted[Math.min(n - 1, Math.floor(n * 0.5))];
  if (Math.abs(p10 - p50) <= 0.2 * p50) return { period: snapToCadence(p10), source: "p10" };
  return { period: snapToCadence(p50), source: "p50" };
}

function snapToCadence(ms: number): number {
  // Slower than ~24 Hz is not a panel; it is a 60 Hz panel with an app stalling on it.
  if (ms > 41.67) return 1000 / 60;
  let best = CADENCES[0];
  for (const c of CADENCES) {
    if (Math.abs(c - ms) < Math.abs(best - ms)) best = c;
  }
  return best;
}

function report(now: number): void {
  const s = acc.slice().sort((a, b) => a - b);
  const n = s.length;
  const { period, source } = derivePeriod(s);
  // `period` is already snapped to one of CADENCES (120/60/30 Hz), so this rounds only the
  // floating-point noise of `1000 / period` back to that exact integer — it must never be a
  // `Math.round(x / 10) * 10` bucket, which is what let 70 Hz / 80 Hz artifacts through.
  const hz = Math.round(1000 / period);
  const budget = 1000 / hz;

  let dropped = 0;
  dropRun = 0;
  longestDropRun = 0;
  for (const dt of acc) {
    const missed = Math.max(0, Math.round(dt / budget) - 1);
    dropped += missed;
    if (missed > 0) {
      dropRun += 1;
      if (dropRun > longestDropRun) longestDropRun = dropRun;
    } else {
      dropRun = 0;
    }
  }

  const at = (q: number) => round2(s[Math.min(n - 1, Math.floor(n * q))] ?? 0);
  const stats: FrameStats = {
    window_start_ms: windowStartWall,
    hz,
    frames: n,
    dropped,
    p50_ms: at(0.5),
    p95_ms: at(0.95),
    p99_ms: at(0.99),
    worst_ms: round2(s[n - 1] ?? 0),
    longest_drop_run: longestDropRun,
    dom_nodes: document.getElementsByTagName("*").length,
  };

  const windowReport: WindowReport = { ...stats, hz_source: source };

  resetWindow(now);
  lastReport = windowReport;
  if (capture !== null) capture.push(windowReport);
  notify();

  if (enabled) {
    console.debug("fps", windowReport);
    void bridge()
      .recordFrameStats(stats)
      .catch(() => {
        // Fire and forget: a meter that can take the app down is worse than no meter.
      });
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/* -------------------------------------------------------------- snapshots */

function notify(): void {
  for (const cb of listeners) cb();
}

/** Module-scope subscribe, as `useSyncExternalStore` requires. */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The most recent one-second window, or null before the first one closes. */
export function getLastReport(): WindowReport | null {
  return lastReport;
}

/* ------------------------------------------------------------- capturing */

/** Start collecting every one-second window, for a burn run. */
export function startCapture(): void {
  capture = [];
}

/** Stop collecting and return the windows gathered. */
export function stopCapture(): WindowReport[] {
  const out: WindowReport[] = capture ?? [];
  capture = null;
  return out;
}

/** Slack on p95 over the budget. See `windowPasses`. */
export const P95_TOLERANCE = 1.1;
/** Slack on the single worst frame over the budget: one late frame is not a stutter. */
export const WORST_TOLERANCE = 3;

/**
 * The gate from feed-rendering.md §4, as revised: a one-second window passes when it dropped no
 * vsyncs at all, its `p95` is within 10% of the budget, and its worst frame is within 3 budgets.
 *
 * The 10% on p95 is not generosity. **[measured]** A 10-session run (Chrome for Testing 152, not
 * WKWebView) reported `hz 60, p50 16.7, p95 16.8, worst 17.7, dropped 0` in every window: frame
 * times cluster on the budget ±0.2 ms, so a bare `p95 <= 16.67` fails a run that dropped nothing.
 * `dropped == 0` is the load-bearing clause; the percentile clauses catch the shape.
 */
export function windowPasses(w: FrameStats): boolean {
  const budget = 1000 / w.hz;
  return (
    w.dropped === 0 && w.p95_ms <= P95_TOLERANCE * budget && w.worst_ms <= WORST_TOLERANCE * budget
  );
}

export interface CaptureSummary {
  windows: number;
  min_hz: number;
  worst_p95_ms: number;
  budget_ms: number;
  p95_limit_ms: number;
  worst_ms: number;
  total_dropped: number;
  longest_drop_run: number;
  max_dom_nodes: number;
  /** Windows whose cadence came from the median because the p10 guard fired. */
  p50_derived_windows: number;
  pass: boolean;
}

/**
 * A run passes only when **every** one-second window passes (`windowPasses`). An average is not a
 * result. The raw numbers are reported either way.
 */
export function summarise(windows: WindowReport[]): CaptureSummary | null {
  if (windows.length === 0) return null;
  const minHz = Math.min(...windows.map((w) => w.hz));
  const budget = 1000 / minHz;
  const worstP95 = Math.max(...windows.map((w) => w.p95_ms));
  const worst = Math.max(...windows.map((w) => w.worst_ms));
  return {
    windows: windows.length,
    min_hz: minHz,
    worst_p95_ms: round2(worstP95),
    budget_ms: round2(budget),
    p95_limit_ms: round2(P95_TOLERANCE * budget),
    worst_ms: round2(worst),
    total_dropped: windows.reduce((k, w) => k + w.dropped, 0),
    longest_drop_run: Math.max(...windows.map((w) => w.longest_drop_run)),
    max_dom_nodes: Math.max(...windows.map((w) => w.dom_nodes)),
    p50_derived_windows: windows.filter((w) => w.hz_source === "p50").length,
    pass: windows.every(windowPasses),
  };
}
