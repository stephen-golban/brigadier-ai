import { countDiagnostic } from "./perfDiagnostics";
import { useEffect, useState, useSyncExternalStore } from "react";
import { getSessionCursor } from "./feedStore";
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
 * The page-lifecycle flushes, and what they do **not** cover.
 *
 * MDN calls the transition to `hidden` "the last event that's reliably observable by the page"
 * **[asserted, read 2026-09-10,
 * https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event]**. In this
 * WKWebView, on a macOS app quit, it is not observable at all. 31 controlled runs against the real
 * isolated app, killed mid-workload with the read marker advancing every ~5 ms, put a graceful
 * Apple-Event quit (the Cmd-Q path, 11 reps: median 100 ms of read-marker progress lost, worst
 * 240 ms) level with a bare SIGTERM, which runs no handler whatsoever (6 reps: median 140 ms,
 * worst 255 ms). Loss repeatedly reaches this file's `flushDelayMs` ceiling, which it could not do
 * if a listener flushed at teardown, and the control run — quit ≥6 s after advances stopped — lost
 * exactly 0 twice, so the method sees a flush when there is one **[measured, 2026-09-10,
 * docs/research/read-marker-durability-2026-09-10.md]**. `visibilitychange→hidden` and `pagehide`
 * therefore contribute nothing on quit. They are kept because they cost nothing and may still fire
 * in other lifecycle transitions (display sleep, a hidden window) — not as quit coverage.
 *
 * What does fire in this webview is `blur` **[measured, same file]**, so that is the third trigger:
 * losing focus is the ordinary precursor to switching away or quitting, and it is user-paced rather
 * than 60 Hz, so it costs nothing on the hot path this coalescing exists to keep clear. The
 * selection-change flush in `useAttention` was measured to work as well.
 *
 * Residual exposure, stated plainly: up to `flushDelayMs` of read-marker progress, lost when the
 * app is quit while it still has keyboard focus and the selected session is advancing. What the
 * user sees is an unread dot back on the conversation they were looking at, cleared for good by
 * re-selecting it. Closing that gap needs a synchronous flush driven from Rust on the window's
 * close/exit path; it is written up as the follow-up in the research file above.
 *
 * `beforeunload` and `unload` are deliberately not used: `beforeunload` disqualifies the page from
 * the back/forward cache and Chrome is deprecating `unload` outright
 * (https://developer.chrome.com/docs/web-platform/deprecating-unload). Shortening `flushDelayMs`
 * is not the remedy either — it trades back the ~45 durable writes/s that the 2,815→224 measured
 * reduction removed.
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
 * Whether the last durable write went through. It gates the two *eager* flushes below, and nothing
 * else: the in-memory map stays authoritative and every advance stays owed either way, so a store
 * that cannot be written costs a read marker nothing but latency.
 *
 * Why it has to exist: `written` is assigned only after a successful `setItem`, so under a store
 * that always throws (private mode, exhausted quota, storage disabled) it stays `{}` forever and
 * every advance looks like a session's first-ever marker — a `getItem` + `JSON.parse` +
 * whole-map `JSON.stringify` + throwing `setItem` on every one. That is the ~45 writes/s the
 * coalescing exists to remove, restored in the one environment that was already degraded
 * **[measured, src/attention.test.ts "stops hammering a store that cannot be written"]**: 200
 * advances made 200 attempts before this flag, ~13 after.
 *
 * It is not latched. A suppressed advance falls through to the trailing timer, so attempts
 * continue at `flushDelayMs` rather than per advance, and the first one that succeeds sets this
 * back to `true` — a store whose quota is freed resumes persisting with no user action.
 */
let writable = true;
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
  writable = true;
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
  // The one trigger above that was measured to fire in this WKWebView. See the block on
  // `listening`: on a macOS quit the other two are indistinguishable from no listener at all.
  window.addEventListener("blur", flushSessionReads);
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
 * Nothing here throws: this runs as a `setTimeout` callback and as a `blur` / `pagehide` /
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
    writable = true; // a store that took this write is one the eager flushes may use again
  } catch {
    // Quota, private mode, an unwritable store. The advance stays owed, so the next advance,
    // session switch, blur, hide or `pagehide` retries it. No timer is re-armed here on purpose: a
    // permanently unwritable store would otherwise retry every 250 ms forever with no user
    // activity at all. `writable` stops the *eager* flushes in `markSessionRead` instead, which
    // is what keeps a per-advance attempt from taking that timer's place.
    writable = false;
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
  // Only while the store takes writes: under one that always throws, `written` never fills, so
  // every advance would look like a first marker and pay a full failing write. See `writable`.
  if (writable && !(sessionId in written)) { flushSessionReads(); return; }
  // The assumption this whole coalescing rests on: **[asserted]** the app delivers at most one
  // advance per session per task — one `useAttention` effect per commit, one commit per frame, the
  // shape the 60 Hz benchmark measured. Only under that does "a second advance of this session
  // inside the same task" mean "a synchronous burst that the trailing timer can never interleave",
  // which is what keeps `src/attention.test.ts`'s frozen 99-advance durability test green at no
  // per-frame cost. Nothing in the tree pins it: a `flushSync`, or two commits' passive effects
  // flushed in one scheduler callback, would make every advance eager again and restore the ~45
  // durable writes/s this change removed. If the benchmark's `readPersistence` count climbs back
  // toward the event rate, this line is why.
  if (writable && eager.has(sessionId)) { flushSessionReads(); return; }
  if (eager.size === 0) queueMicrotask(clearEager);
  eager.add(sessionId);
  if (flushTimer === null) flushTimer = setTimeout(flushSessionReads, flushDelayMs);
}

/**
 * The event sequence the **stream** has reached for one session, or -1 when the store has never
 * seen it (a fabricated session in a test, or one deleted since). `getSessionCursor` is
 * `${rowsTotal}:${lastEventSeq}:${busy}` read straight off `src/feedStore.ts`'s live map, which is
 * why the middle field is taken rather than `getState()`'s copy: `lastEventSeq` is a `CURSOR_FIELDS`
 * value, folded into the React snapshot only on the `COUNTER_FLUSH_MS` (500 ms) tick.
 *
 * **Never call this during a render** — `src/feedStore.ts` mutates that map outside React's
 * knowledge. Both callers below are effects.
 */
function liveEventSeq(sessionId: string): number {
  const cursor = getSessionCursor(sessionId);
  if (cursor === "") return -1;
  const seq = Number(cursor.slice(cursor.indexOf(":") + 1, cursor.lastIndexOf(":")));
  return Number.isFinite(seq) ? seq : -1;
}

/**
 * Acknowledge a session at whichever is further along: the sequence the live stream has reached
 * *at this instant*, or the one the caller's React snapshot carries. The snapshot is kept as a
 * floor rather than dropped because a `SessionRuntime` need not have come from the store at all
 * (a saved or closed worker has no live session, and `getSessionCursor` returns `""` for it).
 *
 * Prefer this over `markSessionRead(id, snapshot.lastEventSeq)` **everywhere a read marker is set
 * from a React snapshot**: `lastEventSeq` is a `CURSOR_FIELDS` value in `src/feedStore.ts`, folded
 * into the snapshot only on the `COUNTER_FLUSH_MS` (500 ms) tick, so the snapshot's copy may trail
 * the stream. Persisting that stale sequence and then letting the fold lift the snapshot above it
 * is what turns an unread dot back on for a conversation the operator just read. Pass `-1` as the
 * snapshot floor from a cleanup, where there is no snapshot to read.
 *
 * Callers: `useAttention` below, and `src/components/SubagentsPanel.tsx` for its own nested worker
 * selection. `markSessionRead` only ever advances a marker, so two callers for the same session id
 * cannot lower it between them.
 *
 * **Never call this during a render** — see `liveEventSeq`. Every caller is an effect.
 */
export function acknowledgeSessionRead(sessionId: string, snapshotSeq: number) {
  const live = liveEventSeq(sessionId);
  markSessionRead(sessionId, live > snapshotSeq ? live : snapshotSeq);
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
  // The snapshot's `lastEventSeq` is the *trigger* — it still re-runs this effect on every folded
  // advance — but the value acknowledged comes off the live stream, which is never behind it.
  useEffect(() => {
    if (!selected || !sessions[selected]) return;
    acknowledgeSessionRead(selected, sessions[selected].lastEventSeq);
  }, [selected, sessions[selected ?? ""]?.lastEventSeq]);
  /*
   * Leaving a session (or unmounting) acknowledges it at the live sequence and persists that,
   * before the switch is visible.
   *
   * The acknowledgement here is not redundant with the effect above. A cursor-only advance for the
   * selected session — a repeated `session-compacted`, a `turn-aborted` with `busy` already false,
   * a repeated identical `runtime-error` — does not rebuild the snapshot, so that effect does not
   * re-run and the last value it acknowledged trails the stream by up to `COUNTER_FLUSH_MS`.
   * Leaving inside that window used to persist the stale sequence; the 500 ms fold then lifted the
   * snapshot above what was persisted and the badge predicate turned an unread dot on for the
   * conversation just read **[measured, src/attention.test.ts "acknowledges the live sequence when
   * leaving a session a cursor-only signal just advanced"]**. `-1` as the floor because there is no
   * snapshot to read in a cleanup: anything the snapshot ever showed was already acknowledged
   * above, and `markSessionRead` only ever advances.
   */
  useEffect(() => () => {
    if (selected) acknowledgeSessionRead(selected, -1);
    flushSessionReads();
  }, [selected]);
  return snapshot;
}
