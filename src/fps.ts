/**
 * Rendering-opportunity meter, with a fixed 60 Hz acceptance target.
 * rAF timestamps are not compositor presentation acknowledgements. Never derive the
 * budget from loaded callbacks: sustained missed frames would become a slower target.
 * Evidence: docs/research/native-performance-timing-2026-09-09.md.
 */
import { bridge } from "./bridge";
import type { FrameStats } from "./wire";

/**
 * One closed window, as the front end holds it: the wire struct plus raw callback intervals and capture validity. `hz_source` is **front-end only** — `record_frame_stats` takes the `FrameStats` in
 * `docs/plans/ipc-contract.md` and nothing else, so it is stripped before the invoke.
 */
export interface WindowReport extends FrameStats {
  hz_source: "target";
  /** Raw callback intervals retained for independent analysis. */
  intervals_ms: number[];
  interrupted: boolean;
  hidden: boolean;
  focused: boolean;
  drain_worst_ms: number;
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
let interrupted = false;
let drainWorst = 0;
/** Optional diagnostic-only timing; ordinary runs never call this. */
export function recordDrain(duration: number): void { drainWorst = Math.max(drainWorst, duration); }
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (capture !== null && document.hidden) interrupted = true;
  });
}

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
export function sampleFrame(now: number): void {
  if (capture !== null && document.hidden) interrupted = true;
  if (!started) {
    started = true;
    last = now;
    windowStartPerf = now;
    windowStartWall = Date.now();
    return;
  }
  const dt = now - last;
  last = now;

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

/** The repository's 60 Hz bar, independent of observed cadence and display mode. */
export const TARGET_HZ = 60;

function report(now: number): void {
  const s = acc.slice().sort((a, b) => a - b);
  const n = s.length;
  const hz = TARGET_HZ;
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

  const windowReport: WindowReport = { ...stats, hz_source: "target", intervals_ms: acc.slice(), interrupted,
    hidden: document.hidden, focused: document.hasFocus(), drain_worst_ms: drainWorst };
  drainWorst = 0;

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
  interrupted = document.hidden;
  last = performance.now();
  resetWindow(last);
  started = true;
  capture = [];
}

/** Stop collecting and return the windows gathered. */
export function stopCapture(): WindowReport[] {
  // A blocked event loop may run the stop timer before the next rAF callback.
  // Retain a terminal gap that already missed an opportunity instead of hiding it.
  const tail = performance.now() - last;
  if (capture !== null && tail >= 1.5 * (1000 / TARGET_HZ)) acc.push(tail);
  if (capture !== null && acc.length > 0) report(last + Math.max(0, tail));
  const out: WindowReport[] = (capture ?? []).map(w => ({ ...w, interrupted: w.interrupted || interrupted }));
  capture = null;
  started = false;
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
    w.hz >= TARGET_HZ && w.frames > 0 && w.dropped === 0 && w.p95_ms <= P95_TOLERANCE * budget && w.worst_ms <= WORST_TOLERANCE * budget
  );
}

export interface CaptureSummary {
  windows: number;
  duration_ms: number;
  min_hz: number;
  worst_p95_ms: number;
  budget_ms: number;
  p95_limit_ms: number;
  worst_ms: number;
  total_dropped: number;
  longest_drop_run: number;
  max_dom_nodes: number;
  interrupted: boolean;
  pass: boolean;
}

/**
 * A run passes only when **every** one-second window passes (`windowPasses`). An average is not a
 * result. The raw numbers are reported either way.
 */
export function summarise(windows: WindowReport[], minimumDurationMs = 0): CaptureSummary | null {
  if (windows.length === 0) return null;
  const duration = windows.reduce((total, w) => total + w.intervals_ms.reduce((a,b) => a+b,0), 0);
  const minHz = Math.min(...windows.map((w) => w.hz));
  const budget = 1000 / minHz;
  const worstP95 = Math.max(...windows.map((w) => w.p95_ms));
  const worst = Math.max(...windows.map((w) => w.worst_ms));
  return {
    windows: windows.length,
    duration_ms: duration,
    min_hz: minHz,
    worst_p95_ms: round2(worstP95),
    budget_ms: round2(budget),
    p95_limit_ms: round2(P95_TOLERANCE * budget),
    worst_ms: round2(worst),
    total_dropped: windows.reduce((k, w) => k + w.dropped, 0),
    longest_drop_run: Math.max(...windows.map((w) => w.longest_drop_run)),
    max_dom_nodes: Math.max(...windows.map((w) => w.dom_nodes)),
    interrupted: windows.some(w => w.interrupted),
    pass: duration >= minimumDurationMs && windows.every(w => !w.interrupted && windowPasses(w)),
  };
}
