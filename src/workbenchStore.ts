/**
 * One shared `workbench_load` snapshot for every consumer in the window.
 *
 * Before this module `Sidebar` and `ProjectWorkbench` each held their own `WorkbenchData`
 * state, each started an immediate `workbenchApi.load()` inside its mount effect, and each
 * re-fetched on its own timer — 2.5 s in the sidebar, 3 s in the workbench — comparing every
 * response with `JSON.stringify(previous) === JSON.stringify(next)`, two full serialisations of
 * the whole payload per response per consumer.
 *
 * `docs/performance/2026-09-11/cold-path-attribution.md` §3 puts a 29–31 ms frame with one
 * dropped vsync at about 1.0 s into the capture, over
 * `App / SidebarProvider / Sidebar / SidebarInset / ProjectWorkbench / Tabs` — the shell mount.
 * Two `invoke` round trips fired from inside that mount land their responses, and the re-render
 * each causes, in or next to that frame. So the first load is scheduled **after the first
 * paint** (`afterPaint` below) rather than synchronously from the mount effect.
 *
 * Rules this module keeps (`docs/plans/efficiency-plan-review-2026-09-11.md` B4):
 *   - one in-flight `workbench_load` at a time; a request made during one is coalesced into a
 *     single follow-up rather than a second concurrent call;
 *   - one 3 s cadence while at least one consumer is subscribed, cleared when the last one goes;
 *   - no fetch **and no timer** while `document.visibilityState === "hidden"`: the interval is
 *     cleared when the document hides and re-armed when it shows, so a backgrounded window costs
 *     no wakeups at all rather than a tick every 3 s that early-returns; one fetch when it turns
 *     visible again;
 *   - a response is dropped if a local `publishWorkbench`/`updateWorkbench` landed while it was in
 *     flight — see `publishRevision`;
 *   - listener before fetch: the `workbench-data-changed` and `visibilitychange` listeners are
 *     registered by `start()` before any load is scheduled.
 *
 * The change detector is a single `JSON.stringify` of the **new** payload, cached beside the
 * snapshot. `WorkbenchData` carries no top-level revision to compare instead (`Note.revision` is
 * per note), so this is the cheap form available: one serialisation per response for the whole
 * window instead of two per response per consumer.
 */
import { useSyncExternalStore } from "react";
import {
  workbenchApi,
  defaultSettings,
  type WorkbenchData,
} from "./workbenchApi";
import { errorMessage } from "./workspaceApi";

export interface WorkbenchSnapshot {
  /** The last payload accepted from `workbench_load`, or an empty one before the first load. */
  readonly data: WorkbenchData;
  /** False until the first load resolves. Gates note panels that would otherwise draw empty. */
  readonly loaded: boolean;
  /** The last load failure, or `""`. Sticky, as the per-component state it replaces was. */
  readonly error: string;
}

/** The single cadence. The sidebar's old 2.5 s and the workbench's old 3 s collapse into it. */
export const WORKBENCH_POLL_MS = 3000;

const emptyData = (): WorkbenchData => ({
  notes: [],
  global: { ...defaultSettings },
  projects: {},
});

let snapshot: WorkbenchSnapshot = {
  data: emptyData(),
  loaded: false,
  error: "",
};
/** `JSON.stringify` of `snapshot.data` as last accepted — the whole change detector. */
let serialized: string | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let cancelFirstLoad: (() => void) | null = null;
let inFlight = false;
let queued = false;
/** Bumped by `stop()`; a response from a previous generation is dropped rather than applied. */
let epoch = 0;
/**
 * Bumped by every `publishWorkbench`/`updateWorkbench`. A load records it when it starts and drops
 * its response if the number has moved by the time it resolves.
 *
 * Without it a local publish is silently reverted: `publishWorkbench(next)` is followed by the
 * caller's `workbench-data-changed`, that `load()` finds one in flight and only sets `queued`, and
 * then the **older** request — issued before the save reached the backend — resolves and `accept`s
 * a payload that predates the edit. The user watches their rename undo itself. Dropping it loses
 * nothing: the queued follow-up load is the one that brings the backend's view of the publish
 * back.
 */
let publishRevision = 0;

function notify() {
  for (const listener of [...listeners]) listener();
}

function hidden() {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

/**
 * Run `job` after the browser has had a chance to paint. `requestAnimationFrame` alone fires
 * *before* the paint of that frame, so the timeout inside it is what puts the work in the task
 * after it. Both are faked by Vitest's default timers, so tests drive this with
 * `advanceTimersByTimeAsync`.
 */
function afterPaint(job: () => void): () => void {
  if (typeof requestAnimationFrame !== "function") {
    const fallback = setTimeout(job, 0);
    return () => clearTimeout(fallback);
  }
  let inner: ReturnType<typeof setTimeout> | null = null;
  const frame = requestAnimationFrame(() => {
    inner = setTimeout(job, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    if (inner !== null) clearTimeout(inner);
  };
}

/** Accept a payload. Returns false — and keeps `snapshot.data` identity — when it is unchanged. */
function accept(data: WorkbenchData): boolean {
  const next = JSON.stringify(data);
  if (snapshot.loaded && next === serialized) return false;
  serialized = next;
  snapshot = { data, loaded: true, error: snapshot.error };
  notify();
  return true;
}

function load() {
  if (inFlight) {
    queued = true;
    return;
  }
  if (hidden()) return;
  inFlight = true;
  const generation = epoch;
  const revision = publishRevision;
  void workbenchApi
    .load()
    .then((data) => {
      if (generation !== epoch || revision !== publishRevision) return;
      accept(data);
    })
    .catch((error: unknown) => {
      const message = errorMessage(error);
      if (generation === epoch && message !== snapshot.error) {
        snapshot = { ...snapshot, error: message };
        notify();
      }
    })
    .finally(() => {
      // A `stop()` already cleared `inFlight` for this generation and a new load may own the flag
      // by now; clearing it again here would let a second request run concurrently with it.
      if (generation !== epoch) return;
      inFlight = false;
      if (queued) {
        queued = false;
        load();
      }
    });
}

/** The cadence exists only while the document is visible; `load()` already refuses to fetch. */
function arm() {
  if (timer === null && !hidden())
    timer = setInterval(load, WORKBENCH_POLL_MS);
}
function disarm() {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

function onVisibility() {
  if (hidden()) {
    disarm();
    return;
  }
  arm();
  load();
}

function start() {
  // Listeners before the fetch: an emit between the load resolving and the subscription would
  // otherwise be lost, and the poll is no longer there to paper over it.
  window.addEventListener("workbench-data-changed", load);
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", onVisibility);
  arm();
  cancelFirstLoad = afterPaint(() => {
    cancelFirstLoad = null;
    load();
  });
}

/**
 * The last consumer left: drop the timer, the listeners and the cached payload. Dropping the
 * payload rather than keeping it warm is deliberate — with no consumer there is nothing the data
 * is for, and a snapshot that outlives every consumer would hand a remount a payload no load has
 * confirmed. In the app neither consumer unmounts for the window's lifetime, so this runs only on
 * StrictMode's double-mount and in tests.
 */
function stop() {
  window.removeEventListener("workbench-data-changed", load);
  if (typeof document !== "undefined")
    document.removeEventListener("visibilitychange", onVisibility);
  disarm();
  cancelFirstLoad?.();
  cancelFirstLoad = null;
  queued = false;
  // The generation bump orphans any request still out there; this releases the flag it holds, so
  // a remount's first load is not swallowed as a `queued` follow-up on a dead promise.
  inFlight = false;
  epoch += 1;
  serialized = null;
  snapshot = { data: emptyData(), loaded: false, error: "" };
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function getSnapshot(): WorkbenchSnapshot {
  return snapshot;
}

/** Ask for a reload now, coalesced against any load already in flight. */
export function refreshWorkbench() {
  load();
}

/**
 * Adopt a payload the caller already has — the response of a save, say — without a round trip.
 * Callers that want every other window listener to hear about it still dispatch
 * `workbench-data-changed` themselves, exactly as they did when they owned the state.
 */
export function publishWorkbench(data: WorkbenchData) {
  publishRevision += 1;
  accept(data);
}

/** Apply a local edit to the shared payload (a renamed note title, say). */
export function updateWorkbench(patch: (data: WorkbenchData) => WorkbenchData) {
  publishRevision += 1;
  accept(patch(snapshot.data));
}

/** Test seam: drop every listener, timer and cached payload. */
export function resetWorkbenchStore() {
  listeners.clear();
  stop();
  inFlight = false;
  queued = false;
  serialized = null;
  snapshot = { data: emptyData(), loaded: false, error: "" };
}

export function useWorkbenchSnapshot(): WorkbenchSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
