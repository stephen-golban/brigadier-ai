import type { ProfilerOnRenderCallback } from "react";

/** Separate profiling build only. Buffer evidence; never publish state or IPC per render. */
export const profiling = import.meta.env.VITE_REACT_PROFILE === "1";
type Span = { name: string; start: number; end: number; track: string };
let spans: Span[] = [];
let components: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
let renders: Parameters<ProfilerOnRenderCallback>[] = [];
let counters: Record<string, number> = {};
let active = false;

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
export function resetDiagnostics(): void {
  spans = []; renders = []; counters = {}; components = {}; active = true;
}
export function getDiagnostics() {
  active = false;
  return profiling ? {
    timeOriginMs: performance.timeOrigin, spans, renders, counters, components,
    resources: performance.getEntriesByType("resource").map(entry => ({
      name: entry.name, startTime: entry.startTime, duration: entry.duration,
    })),
  } : null;
}
