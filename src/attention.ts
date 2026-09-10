import { countDiagnostic } from "./perfDiagnostics";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { SessionRuntime } from "./feedStore";

const readKey = "brigadier:read-sessions";

/**
 * Trailing window for the durable write. **[measured]** in the 60 Hz native benchmark (10 sessions
 * x 200 rows/s x 60 s) the selected session's `lastEventSeq` advanced ~45 times a second, and
 * `markSessionRead` performed 2,815 durable writes in 63 s — a `getItem` + `JSON.parse` +
 * `JSON.stringify` + `setItem` on nearly every frame. A read marker has to be durable, not durable
 * at 60 Hz, so the map below is authoritative in memory and storage trails it by at most this
 * window. Trailing **throttle**, not debounce: the timer is armed by the first unpersisted advance
 * and is never pushed back by later ones, so a continuous stream still persists every 250 ms
 * instead of never.
 */
const flushDelayMs = 250;

/**
 * Which page-lifecycle events actually fire is a fact about the platform, not a memory:
 * **[asserted, read 2026-09-10]** MDN's Document: visibilitychange event page states that the
 * event "fires with a `visibilityState` of `hidden` when a user navigates to a new page, switches
 * tabs, closes the tab, minimizes or closes the browser", and that "Transitioning to `hidden` is
 * the last event that's reliably observable by the page", pointing developers at it explicitly
 * "not `beforeunload`/`unload`"
 * (https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event).
 * `pagehide` is kept as the second trigger — MDN's Window: pagehide event page notes it is "not
 * reliably fired by browsers, especially on mobile", which is why it is a backstop and not the
 * primary one. `beforeunload` and `unload` are deliberately not used: `beforeunload` disqualifies
 * the page from the back/forward cache and Chrome is deprecating `unload` outright
 * (https://developer.chrome.com/docs/web-platform/deprecating-unload). Not checked: whether the
 * Tauri/WKWebView window emits `visibilitychange` on macOS app quit — the `pagehide` listener and
 * the selection-change flush are what cover that case, and neither has been measured in the app.
 */
let listening = false;

/** Authoritative read sequences. Lazily seeded from storage; storage trails it. */
let reads: Record<string, number> | null = null;
/** The map as of the last durable write, so an entry deleted from storage by someone else stays deleted. */
let written: Record<string, number> = {};
/** Bumped on every change to `reads`; the snapshot cache keys on it instead of on map identity. */
let readVersion = 0;
let unpersisted = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Sessions that already have an unpersisted advance **in the current task**. A run of advances
 * inside one task gets no chance to interleave the trailing timer, so the second and later
 * advances of the same session in that task persist eagerly; the frame-driven stream delivers one
 * advance per session per task and is coalesced in full. This is also the durability contract
 * asserted by `src/attention.test.ts` ("viewed progress is persisted…"), which reads storage
 * synchronously at the end of a 99-advance burst.
 */
const eager = new Set<string>();
const clearEager = () => eager.clear();

/**
 * **Test-only.** Drops the module state `localStorage.clear()` cannot reach, so a test may reuse a
 * session id another test already acknowledged. Called from `src/attention.test.ts` only — grep
 * `resetAttentionStateForTests`; no production path references it. `listening` is deliberately
 * *not* reset: the `document`/`window` listeners outlive a reset (jsdom keeps one window per test
 * file), so re-registering would double every flush on hide.
 */
export function resetAttentionStateForTests() {
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  reads = null;
  written = {};
  unpersisted = false;
  readVersion++; // bumped, not zeroed: a snapshot cached at version 0 must not match a reset store
  eager.clear();
}

/**
 * The stored map, plus whether it could actually be read. `readable: false` means `getItem` threw
 * or the value did not parse into a plain object — which is *not* evidence that anything was
 * deleted. Collapsing the two (`catch { return {} }`) made every id look deleted to the prune in
 * `flushSessionReads`, which then wrote the wipe back: one flush against a corrupt
 * `brigadier:read-sessions` value reduced a live marker to -1 **[measured, src/attention.test.ts
 * "keeps in-memory markers when the stored value cannot be read"]**. An absent key is readable and
 * empty — a first run is not a corrupt store.
 */
function storedReads(): { map: Record<string, number>; readable: boolean } {
  let raw: string | null;
  try { raw = localStorage.getItem(readKey); } catch { return { map: {}, readable: false }; }
  if (raw === null) return { map: {}, readable: true };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      return { map: parsed as Record<string, number>, readable: true };
  } catch { /* a value we cannot parse is a value we cannot draw a conclusion from */ }
  return { map: {}, readable: false };
}

function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSessionReads();
  });
  window.addEventListener("pagehide", flushSessionReads);
}

function readMap(): Record<string, number> {
  if (reads === null) { reads = storedReads().map; written = { ...reads }; listen(); }
  return reads;
}

/** The acknowledged sequence for one session, current the instant `markSessionRead` returns. */
export function readSequence(sessionId: string): number {
  return readMap()[sessionId] ?? -1;
}

/**
 * Persist the in-memory map now. Merges against storage so the stored value only ever advances,
 * and drops an entry another writer (`sessionLocalData`) deleted while we had nothing newer for it.
 * Nothing here throws: this runs as a `setTimeout` callback and as a `pagehide` /
 * `visibilitychange` listener, where an escaping error is an unhandled window error rather than a
 * React one.
 */
export function flushSessionReads() {
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  if (!unpersisted || reads === null) return;
  const stored = storedReads();
  const merged: Record<string, number> = { ...stored.map };
  let changed = false;
  for (const [id, seq] of Object.entries(reads)) {
    // Prune on evidence only: an id absent from a *readable* store, with nothing newer here than
    // the last durable write, was deleted by `src/sessionLocalData.ts`, which rewrites this key
    // without that id on session delete. An unreadable store is not that evidence. The write below
    // still goes ahead when the store is unreadable: the value we could not parse is one no reader
    // in this tree can use either (`sessionLocalData.ts` JSON.parses it inside a try and skips),
    // so overwriting it with the authoritative map loses no marker and repairs the key.
    if (stored.readable && !(id in stored.map) && written[id] === seq) { delete reads[id]; changed = true; continue; }
    const best = Math.max(stored.map[id] ?? -1, seq);
    merged[id] = best;
    if (best !== seq) { reads[id] = best; changed = true; }
  }
  for (const [id, seq] of Object.entries(stored.map)) if (!(id in reads)) { reads[id] = seq; changed = true; }
  countDiagnostic("readPersistence");
  try {
    localStorage.setItem(readKey, JSON.stringify(merged));
    written = merged;
    unpersisted = false; // set *after* the write, never before: a throw must stay owed
  } catch {
    // Quota, private mode, an unwritable store. The advance stays owed, so the next advance,
    // session switch, hide or `pagehide` retries it. No timer is re-armed here on purpose: a
    // permanently unwritable store would otherwise retry every 250 ms forever with no user
    // activity at all.
  }
  if (changed) { readVersion++; publishReads(); }
}

function publishReads() {
  // No payload. `subscribeReads` below is the only listener in the tree (grep
  // "brigadier-session-read", 2026-09-10: 3 hits, all in this file) and it reads only the
  // notification. Passing `reads` handed a consumer the live mutable map; copying it instead would
  // put a per-advance allocation back on the ~45/s path this coalescing exists to remove.
  window.dispatchEvent(new Event("brigadier-session-read"));
}

/** Reading a worker pane acknowledges that worker only. */
export function markSessionRead(sessionId: string, seq: number) {
  const map = readMap();
  if ((map[sessionId] ?? -1) >= seq) return;
  map[sessionId] = seq;
  readVersion++;
  unpersisted = true;
  publishReads();
  // A session's first-ever marker is a rare, meaningful transition: persist it without waiting.
  if (!(sessionId in written)) { flushSessionReads(); return; }
  // The assumption this whole coalescing rests on: **[asserted]** the app delivers at most one
  // advance per session per task — one `useAttention` effect per commit, one commit per frame, the
  // shape the 60 Hz benchmark measured. Only under that does "a second advance of this session
  // inside the same task" mean "a synchronous burst that the trailing timer can never interleave",
  // which is what keeps `src/attention.test.ts`'s frozen 99-advance durability test green at no
  // per-frame cost. Nothing in the tree pins it: a `flushSync`, or two commits' passive effects
  // flushed in one scheduler callback, would make every advance eager again and restore the ~45
  // durable writes/s this change removed. If the benchmark's `readPersistence` count climbs back
  // toward the event rate, this line is why.
  if (eager.has(sessionId)) { flushSessionReads(); return; }
  if (eager.size === 0) queueMicrotask(clearEager);
  eager.add(sessionId);
  if (flushTimer === null) flushTimer = setTimeout(flushSessionReads, flushDelayMs);
}

export function working(session: SessionRuntime | undefined) {
  return !!session && (session.busy || session.status === "starting");
}

function subscribeReads(notify: () => void) {
  window.addEventListener("brigadier-session-read", notify);
  return () => window.removeEventListener("brigadier-session-read", notify);
}

type Snapshot = {
  sessions: Record<string, SessionRuntime>;
  selected: string | null;
  pending: string[];
  version: number;
  size: number;
  value: Record<string, boolean>;
};

/**
 * `useSyncExternalStore` calls `getSnapshot` more than once per render to detect tearing, so the
 * projection must be cached: recompute only when one of its four inputs changed, and keep the
 * previous object when every badge came out the same, so React sees an `Object.is`-equal value and
 * schedules nothing. That is what the store contract requires anyway — the old code paid a
 * `JSON.stringify` of the whole projection (and a `JSON.parse` back) several times a frame for it.
 */
function attentionCache() {
  let last: Snapshot | null = null;
  return (sessions: Record<string, SessionRuntime>, selected: string | null, pending: string[]) => {
    if (last !== null && last.sessions === sessions && last.selected === selected
      && last.pending === pending && last.version === readVersion) return last.value;
    const map = readMap();
    const value: Record<string, boolean> = {};
    let same = last !== null;
    let size = 0;
    for (const session of Object.values(sessions)) {
      const id = session.sessionId;
      const badge = pending.includes(id) ||
        (id !== selected && !working(session) &&
          (session.lastTurnId !== null || session.status === "failed") &&
          (map[id] ?? -1) < session.lastEventSeq);
      value[id] = badge;
      size++;
      if (same && last!.value[id] !== badge) same = false;
    }
    const kept = same && last!.size === size ? last!.value : value;
    last = { sessions, selected, pending, version: readVersion, size, value: kept };
    return kept;
  };
}

export function useAttention(
  sessions: Record<string, SessionRuntime>,
  selected: string | null,
  pending: string[],
) {
  const [snapshotOf] = useState(attentionCache);
  const snapshot = useSyncExternalStore(subscribeReads, () => snapshotOf(sessions, selected, pending));
  // Acknowledgements advance for every event; the badge map only changes when an outcome does.
  useEffect(() => {
    if (!selected || !sessions[selected]) return;
    markSessionRead(selected, sessions[selected].lastEventSeq);
  }, [selected, sessions[selected ?? ""]?.lastEventSeq]);
  // Leaving a session (or unmounting) persists what was read there, before the switch is visible.
  useEffect(() => flushSessionReads, [selected]);
  return snapshot;
}
