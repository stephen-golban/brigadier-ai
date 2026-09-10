import type { ProfilerOnRenderCallback } from "react";

/** Separate profiling build only. Buffer evidence; never publish state or IPC per render. */
export const profiling = import.meta.env.VITE_REACT_PROFILE === "1";
type Span = { name: string; start: number; end: number; track: string };
let spans: Span[] = [];
let components: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
let renders: Parameters<ProfilerOnRenderCallback>[] = [];
let counters: Record<string, number> = {};
let active = false;

/**
 * Timestamped trace, for attributing a long frame gap that carries **no** React span. Every entry
 * is `t` = `performance.now()` at the call, `k` = kind, `d` = an optional work size, so a gap in
 * the `frame` series can be read against what else ran between its two ends.
 *
 * Capped: a 63 s run at 60 Hz with a handful of events per frame is ~20k entries, so 300k is two
 * orders of magnitude of headroom; past the cap entries are counted, never dropped silently.
 */
export const TRACE_CAP = 300_000;
type TraceEntry = { t: number; k: string; d?: number };
let trace: TraceEntry[] = [];
let traceDropped = 0;

if (profiling) {
  const original = console.timeStamp.bind(console);
  console.timeStamp = (...args: unknown[]) => {
    const [name, start, end] = args;
    if (active && typeof name === "string" && typeof start === "number" && typeof end === "number"
      && args.some(arg => arg === "Scheduler ⚛" || arg === "Components ⚛")) {
      if (args.includes("Components ⚛")) {
        const entry = components[name] ??= { count: 0, totalMs: 0, maxMs: 0 };
        entry.count++; entry.totalMs += end - start; entry.maxMs = Math.max(entry.maxMs, end - start);
      } else if (name === "Commit" || name === "Render") {
        spans.push({ name, start, end, track: "scheduler" });
      }
    }
    Reflect.apply(original, console, args);
  };
}

export const recordRender: ProfilerOnRenderCallback = (...args) => {
  if (profiling && active) renders.push(args);
};
export function countDiagnostic(name: string): void {
  if (profiling && active) counters[name] = (counters[name] ?? 0) + 1;
}

/** Append one trace entry. Inert unless this is a profiling build inside a capture. */
export function traceEvent(kind: string, detail?: number): void {
  if (!profiling || !active) return;
  if (trace.length >= TRACE_CAP) { traceDropped++; return; }
  trace.push({ t: performance.now(), k: kind, d: detail });
}

/* The end-of-frame probe. `port1.postMessage` from inside the rAF callback is a macrotask, and
 * WebKit has run rAF callbacks inside the RenderingUpdate since bugs.webkit.org/177484 (landed
 * 2019-03-07, the RenderingUpdateScheduler), so the reply lands after style, layout and paint.
 * **[asserted]** — read off that bug and the HTML event loop, not measured in this tree. The
 * delta is therefore "everything the engine did after our callback returned", not paint alone. */
let renderPort: MessagePort | null = null;
let renderPostedAt = 0;
let renderPending = false;

/** Post the end-of-frame probe. One in flight at a time; the channel is built on first use. */
export function markRenderUpdate(): void {
  if (!profiling || !active || renderPending) return;
  if (renderPort === null) {
    if (typeof MessageChannel === "undefined") return;
    const channel = new MessageChannel();
    // Assigning `onmessage` starts port2; port1 only ever posts.
    channel.port2.onmessage = () => {
      renderPending = false;
      traceEvent("render-update", performance.now() - renderPostedAt);
    };
    renderPort = channel.port1;
  }
  renderPending = true;
  renderPostedAt = performance.now();
  renderPort.postMessage(0);
}

export function resetDiagnostics(): void {
  spans = []; renders = []; counters = {}; components = {}; active = true;
  // A probe posted by the frame before the capture opened still replies, and its `render-update`
  // lands as the trace's first entry: a real measurement of the frame before `t = 0`, not a
  // spurious one. Clearing `renderPending` is what lets the capture's own first frame probe.
  trace = []; traceDropped = 0; renderPending = false;
}
export function getDiagnostics() {
  active = false;
  return profiling ? {
    timeOriginMs: performance.timeOrigin, spans, renders, counters, components, trace, traceDropped,
    resources: performance.getEntriesByType("resource").map(entry => ({
      name: entry.name, startTime: entry.startTime, duration: entry.duration,
    })),
  } : null;
}
