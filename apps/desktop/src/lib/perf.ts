import { nowEpochMs } from "@/ipc/client";
import type { LatencySummary } from "@/ipc/generated";

/** Fixed-capacity sample buffer; the oldest samples drop off. */
export class Ring {
  private readonly buffer: number[];
  private next = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.buffer = Array.from({ length: capacity }, () => 0);
  }

  push(value: number): void {
    this.buffer[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  values(): number[] {
    if (this.count < this.capacity) return this.buffer.slice(0, this.count);
    return [...this.buffer.slice(this.next), ...this.buffer.slice(0, this.next)];
  }

  clear(): void {
    this.next = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }
}

export function summarize(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) return { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.round((sorted.length - 1) * q)] ?? 0;
  return {
    samples: sorted.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

/** Daemon ingest → UI paint latency of every event, most recent 1000. */
export const ingestToPaint = new Ring(1000);
/** Gaps between animation frames while sampling is on, most recent 600 (~10 s). */
export const frameGaps = new Ring(600);

const probeLatencies = new Map<string, number[]>();

type Pending = { atMs: number; burstId: string | null };
let pending: Pending[] = [];
let scheduled = false;
let paused = false;
/** Events waiting for a paint are dropped past this, e.g. while frames are throttled. */
const MAX_PENDING = 5000;

// A message posted from a rAF callback is delivered after that frame has painted.
const afterPaint = new MessageChannel();
afterPaint.port1.addEventListener("message", () => {
  const paintedAt = nowEpochMs();
  for (const { atMs, burstId } of pending) {
    const latency = Math.max(0, paintedAt - atMs);
    ingestToPaint.push(latency);
    if (burstId !== null) probeLatencies.get(burstId)?.push(latency);
  }
  pending = [];
  scheduled = false;
});
afterPaint.port1.start();

/**
 * Records that an event ingested by the daemon at `atMs` was just applied to UI state; its
 * latency is taken at the next paint. Probe events carry their burst id.
 */
export function markApplied(atMs: number, burstId: string | null = null): void {
  if (paused || pending.length >= MAX_PENDING) return;
  if (burstId !== null && !probeLatencies.has(burstId)) {
    probeLatencies.set(burstId, []);
  }
  pending.push({ atMs, burstId });
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(() => afterPaint.port2.postMessage(null));
  }
}

/** Latencies of one probe burst's events painted so far. */
export function probeSamples(burstId: string): readonly number[] {
  return probeLatencies.get(burstId) ?? [];
}

export function forgetProbes(burstId: string): void {
  probeLatencies.delete(burstId);
}

let frameLoop: number | null = null;
let lastFrame: number | null = null;

// What explains a stall while sampling: when the longest frame gap ended, and the longest
// synchronous event flush with the event kinds it applied (times relative to sampling start).
let sampledFrom = 0;
let longestGap = { ms: 0, endedAt: 0 };
let longestFlush = { ms: 0, at: 0, kinds: "" };

function onFrame(time: number) {
  if (lastFrame !== null) {
    const gap = time - lastFrame;
    frameGaps.push(gap);
    if (gap > longestGap.ms) longestGap = { ms: gap, endedAt: time - sampledFrom };
  }
  lastFrame = time;
  frameLoop = requestAnimationFrame(onFrame);
}

/** Records how long applying one batch of events to UI state took (while sampling). */
export function noteFlush(startedAt: number, kinds: readonly string[]): void {
  if (frameLoop === null) return;
  const ms = performance.now() - startedAt;
  if (ms <= longestFlush.ms) return;
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  longestFlush = {
    ms,
    at: startedAt - sampledFrom,
    kinds: [...counts].map(([kind, n]) => (n > 1 ? `${kind}×${n}` : kind)).join(", "),
  };
}

/** One line on where the longest frame gap fell and the costliest event flush. */
export function stallContext(): string {
  const gap = `longest gap ended at +${Math.round(longestGap.endedAt)} ms`;
  if (longestFlush.ms === 0) return gap;
  return `${gap}; longest event flush ${Math.round(longestFlush.ms)} ms at +${Math.round(longestFlush.at)} ms (${longestFlush.kinds})`;
}

/** Starts or stops frame-gap sampling (a proxy for long tasks: WebKit has no Long Tasks API). */
export function setFrameSampling(on: boolean): void {
  if (on && frameLoop === null) {
    lastFrame = null;
    sampledFrom = performance.now();
    longestGap = { ms: 0, endedAt: 0 };
    longestFlush = { ms: 0, at: 0, kinds: "" };
    frameLoop = requestAnimationFrame(onFrame);
  } else if (!on && frameLoop !== null) {
    cancelAnimationFrame(frameLoop);
    frameLoop = null;
    lastFrame = null;
  }
}

/** While the window is hidden frames stop; don't count that as latency or gaps. */
export function setSamplingPaused(value: boolean): void {
  paused = value;
  if (value) pending = [];
}

/** Resolves just after the next frame has painted. */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.addEventListener("message", () => resolve(), { once: true });
      channel.port1.start();
      channel.port2.postMessage(null);
    });
  });
}
