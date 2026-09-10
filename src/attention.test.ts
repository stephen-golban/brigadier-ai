import {act, cleanup, renderHook} from '@testing-library/react';
import {afterEach, expect, it} from 'vitest';
import {markSessionRead, useAttention} from './attention';
import type {SessionRuntime} from './feedStore';

afterEach(() => { cleanup(); localStorage.clear(); });
it('reading a worker clears its unread completion while preserving other unread tasks and approvals', () => {
  const sessions = Object.fromEntries(['worker', 'other'].map(sessionId => [sessionId,
    {sessionId, busy:false, status:'running', lastTurnId:'completed', lastEventSeq:42} as SessionRuntime]));
  const {result, rerender} = renderHook(({pending}) => useAttention(sessions, null, pending), {initialProps:{pending:[] as string[]}});
  expect(result.current).toEqual({worker:true, other:true});
  act(() => markSessionRead('worker', 42));
  expect(result.current).toEqual({worker:false, other:true});
  rerender({pending:['worker']});
  expect(result.current.worker).toBe(true);
  expect(JSON.parse(localStorage.getItem('brigadier:read-sessions')!)).toEqual({worker:42});
});

it('viewed progress is persisted without another render and remains read after leaving', () => {
  let renders = 0;
  const worker = {sessionId:'worker', busy:false, status:'running', lastTurnId:'done', lastEventSeq:1} as SessionRuntime;
  const {result, rerender} = renderHook(({seq,selected,pending}) => {
    renders++;
    return useAttention({worker:{...worker,lastEventSeq:seq}}, selected, pending);
  }, {initialProps:{seq:1,selected:'worker' as string|null,pending:[] as string[]}});
  expect(result.current.worker).toBe(false);
  const before = renders;
  for(let seq=2;seq<=100;seq++) rerender({seq,selected:'worker',pending:[]});
  expect(renders-before).toBe(99);
  expect(JSON.parse(localStorage.getItem('brigadier:read-sessions')!)).toEqual({worker:100});
  rerender({seq:100,selected:null,pending:[]});
  expect(result.current.worker).toBe(false);
  rerender({seq:101,selected:null,pending:[]});
  expect(result.current.worker).toBe(true);
  rerender({seq:101,selected:'worker',pending:['worker']});
  expect(result.current.worker).toBe(true);
});

/*
 * Below: the coalesced durable write and the cached snapshot. The two tests above are the frozen
 * contract and are unchanged — note that the second one reads storage synchronously at the end of a
 * 99-advance burst delivered inside one task, which is why a same-task burst persists eagerly while
 * the frame-driven stream (one advance per task) is coalesced.
 */
import {beforeEach, vi} from 'vitest';
import {flushSessionReads, readSequence, resetAttentionStateForTests} from './attention';

/*
 * A file-scope hook applies to every test in the file, above this line as well as below: Vitest
 * registers all of them during collection, before the first one runs. It is registered after
 * `src/test/setup.ts`'s own `beforeEach`, so storage is cleared first and the module state second.
 * Without it this file was isolated only by keeping session ids disjoint — `reads`, `written`,
 * `readVersion`, `eager` and `flushTimer` all survive a `localStorage.clear()`. **[measured
 * 2026-09-10]** with this hook a no-op, a probe placed after the deletion test below read
 * `readSequence('kept')` as 2 with storage empty; with the hook it reads -1.
 */
beforeEach(resetAttentionStateForTests);

const readKey = 'brigadier:read-sessions';
const stored = () => JSON.parse(localStorage.getItem(readKey) ?? '{}') as Record<string, number>;
const writes = (spy: {mock: {calls: unknown[][]}}) => spy.mock.calls.filter(call => call[0] === readKey).length;
afterEach(() => { flushSessionReads(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('coalesces the durable write across frames while the in-memory sequence stays current', async () => {
  vi.useFakeTimers();
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const advances = 2815; // the count measured in the 60 Hz native benchmark, 63 s at ~45/s
  for (let seq = 1; seq <= advances; seq++) {
    markSessionRead('burst', seq);
    expect(readSequence('burst')).toBe(seq); // authoritative the instant the call returns
    await vi.advanceTimersByTimeAsync(16); // one frame, one task, as the app delivers them
  }
  flushSessionReads();
  expect(stored().burst).toBe(advances);
  const durable = writes(setItem);
  expect(durable).toBeGreaterThan(0);
  expect(durable).toBeLessThan(advances / 10);
  console.log(`durable writes for ${advances} advances: ${durable}`);
});

it('persists the highest sequence seen and never an earlier one', () => {
  vi.useFakeTimers();
  markSessionRead('high', 5);
  markSessionRead('high', 9);
  markSessionRead('high', 7); // stale acknowledgement: must not lower anything
  flushSessionReads();
  expect(readSequence('high')).toBe(9);
  expect(stored().high).toBe(9);
  localStorage.setItem(readKey, JSON.stringify({...stored(), high: 50})); // another writer got further
  markSessionRead('high', 11);
  flushSessionReads();
  expect(stored().high).toBe(50);
});

it('flushes the read marker synchronously when the selected session changes', () => {
  vi.useFakeTimers();
  const of = (sessionId: string, seq: number) =>
    ({sessionId, busy:false, status:'running', lastTurnId:'done', lastEventSeq:seq} as SessionRuntime);
  const {rerender} = renderHook(({seq, selected}) => useAttention({left: of('left', seq), right: of('right', seq)}, selected, []),
    {initialProps:{seq:10, selected:'left' as string|null}});
  expect(stored().left).toBe(10); // a session's first marker is durable at once
  rerender({seq:11, selected:'left'});
  expect(readSequence('left')).toBe(11);
  expect(stored().left).toBe(10); // …later advances trail, with no timer run
  rerender({seq:11, selected:'right'});
  expect(stored().left).toBe(11); // leaving the session persisted it, before the switch is observable
});

it('flushes a pending read marker when the document hides or the page goes away', async () => {
  vi.useFakeTimers();
  markSessionRead('leaving', 1);
  markSessionRead('leaving', 2);
  expect(stored().leaving).toBe(1);
  const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', {configurable:true, get: () => 'hidden'});
  document.dispatchEvent(new Event('visibilitychange'));
  expect(stored().leaving).toBe(2);
  if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
  await Promise.resolve(); // a later frame, so the advance below trails as it does in the app
  markSessionRead('leaving', 3);
  expect(stored().leaving).toBe(2);
  window.dispatchEvent(new Event('pagehide'));
  expect(stored().leaving).toBe(3);
});

it('returns an Object.is-equal snapshot until a badge outcome changes', () => {
  const sessions = Object.fromEntries(['snap-a', 'snap-b'].map(sessionId => [sessionId,
    {sessionId, busy:false, status:'running', lastTurnId:'done', lastEventSeq:3} as SessionRuntime]));
  const none: string[] = [];
  const {result, rerender} = renderHook(({pending}) => useAttention(sessions, null, pending), {initialProps:{pending:none}});
  const first = result.current;
  expect(first).toEqual({'snap-a':true, 'snap-b':true});
  rerender({pending:none});
  expect(result.current).toBe(first); // unchanged inputs
  rerender({pending:[]}); // a fresh array with the same outcomes still recomputes to the same object
  expect(result.current).toBe(first);
  act(() => markSessionRead('snap-a', 3)); // an acknowledgement that does change an outcome
  expect(result.current).not.toBe(first);
  expect(result.current).toEqual({'snap-a':false, 'snap-b':true});
});

it('turns the badge on for a pending approval with no delay', () => {
  vi.useFakeTimers();
  const busy = {sessionId:'approving', busy:true, status:'running', lastTurnId:null, lastEventSeq:7} as SessionRuntime;
  const {result, rerender} = renderHook(({pending}) => useAttention({approving: busy}, 'approving', pending), {initialProps:{pending:[] as string[]}});
  expect(result.current.approving).toBe(false);
  rerender({pending:['approving']});
  expect(result.current.approving).toBe(true); // no timer advanced, no debounce in the approval path
});

it('keeps a failed durable write retryable instead of recording it as persisted', () => {
  vi.useFakeTimers();
  markSessionRead('quota', 1); // a first-ever marker is durable at once
  expect(stored().quota).toBe(1);
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  markSessionRead('quota', 2);
  flushSessionReads(); // the write throws: it must not escape, and must not claim success
  expect(readSequence('quota')).toBe(2);
  expect(stored().quota).toBe(1); // storage still trails, and the module knows it
  setItem.mockRestore();
  flushSessionReads(); // the retry the pre-fix code skipped, having set unpersisted = false
  expect(stored().quota).toBe(2);
});

it('keeps in-memory markers when the stored value cannot be read, and persists no wipe', () => {
  vi.useFakeTimers();
  markSessionRead('corrupt-old', 4); // fully persisted: written[id] === reads[id], the prune's shape
  markSessionRead('corrupt-new', 1);
  markSessionRead('corrupt-new', 2); // a trailing advance, so the flush below has work
  localStorage.setItem(readKey, '{not json'); // storage unreadable, not empty
  flushSessionReads();
  expect(readSequence('corrupt-old')).toBe(4); // pre-fix: -1, pruned as if deleted by another writer
  expect(stored()['corrupt-old']).toBe(4); // …and the loss was written back
  expect(stored()['corrupt-new']).toBe(2);
});

it('still drops an id another writer deleted from storage', () => {
  vi.useFakeTimers();
  markSessionRead('deleted', 3);
  markSessionRead('kept', 1);
  markSessionRead('kept', 2);
  const value = stored(); // what src/sessionLocalData.ts does on session delete: read, delete, write
  delete value.deleted;
  localStorage.setItem(readKey, JSON.stringify(value));
  flushSessionReads();
  expect(readSequence('deleted')).toBe(-1); // the reason the prune exists; must survive the fix
  expect('deleted' in stored()).toBe(false);
  expect(stored().kept).toBe(2);
});

it('the test-only reset isolates module state, so a session id may be reused', () => {
  vi.useFakeTimers();
  // 'worker' is the id the two frozen tests above acknowledge, at 42 and 100. Without the
  // `beforeEach` above, `written` still holds it here, so this is not a first-ever marker and
  // trails instead of persisting at once: a reused id quietly changes behaviour under the test.
  markSessionRead('worker', 5);
  expect(stored().worker).toBe(5); // a session's first-ever marker is durable immediately
  expect(readSequence('worker')).toBe(5);
  localStorage.clear();
  resetAttentionStateForTests();
  expect(readSequence('worker')).toBe(-1); // storage and the authoritative map both start over
  markSessionRead('worker', 2); // a sequence a leaked map, still at 5, would refuse as stale
  expect(readSequence('worker')).toBe(2);
  expect(stored().worker).toBe(2);
});

/*
 * A store that can never be written. Pre-fix, `written` was assigned only after a successful
 * `setItem`, so it stayed `{}` forever and every advance took the "first-ever marker" branch: a
 * synchronous `getItem` + `JSON.parse` + whole-map `JSON.stringify` + throwing `setItem` on every
 * one — exactly the ~45 writes/s the coalescing removed, restored in the one environment already
 * degraded. The retry path is what stops the flag from latching: attempts continue at the trailing
 * window, so a store that frees quota resumes persisting with no user action.
 */
it('stops hammering a store that cannot be written, and resumes when it can again', () => {
  vi.useFakeTimers();
  const setItem = vi.spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  const advances = 200;
  for (let seq = 1; seq <= advances; seq++) {
    markSessionRead('unwritable', seq);
    expect(readSequence('unwritable')).toBe(seq); // authoritative with nothing durable behind it
    vi.advanceTimersByTime(16); // one frame, one task, as the app delivers them
  }
  const attempts = writes(setItem);
  expect(attempts).toBeLessThan(advances / 10); // pre-fix: one attempt per advance, all 200
  console.log(`failing write attempts for ${advances} advances: ${attempts}`);
  setItem.mockRestore();
  markSessionRead('unwritable', advances + 1);
  vi.advanceTimersByTime(300); // the trailing window, now that the store takes writes again
  expect(stored().unwritable).toBe(advances + 1);
});

/*
 * The badge against the real store, added 2026-09-10 with the `getState()` cursor split in
 * `src/feedStore.ts`. `lastEventSeq` no longer rebuilds the snapshot on the frame it moves, so the
 * badge predicate `(reads[id] ?? -1) < session.lastEventSeq` now reads a number that may trail the
 * event stream by up to `COUNTER_FLUSH_MS`. **The choice taken is late, never never**: a badge for
 * a background session with new activity appears within 500 ms rather than in the arriving frame,
 * which `docs/vision.md` §9 permits — it is the approval card, not the badge, that may never be
 * deferred.
 */
import type {Envelope, Event, FeedBatch} from './wire';

/*
 * The other side of that trade: the **selected** session must never inherit the 500 ms lag. Pre-fix
 * the acknowledgement read `lastEventSeq` off the React snapshot, so a cursor-only advance for the
 * selected session (a repeated `session-compacted`, a `turn-aborted` with `busy` already false, a
 * repeated identical `runtime-error`) inside the window before the operator switched away was
 * persisted at the stale sequence; the fold then lifted the snapshot above it and the badge
 * predicate turned the dot on for a conversation just read. The real store is driven here rather
 * than a faked cursor, so a regression in either module fails this.
 */
it('acknowledges the live sequence when leaving a session a cursor-only signal just advanced', async () => {
  vi.useFakeTimers();
  // No `vi.resetModules()`: this must be the same `feedStore` instance `src/attention.ts` imports,
  // or the live cursor it reads would belong to a different store than the one driven here.
  const store = await import('./feedStore');
  let seq = 0;
  const signal = (event: Event): Envelope => ({seq: ++seq, at: 1_000, instance_id: 'i', session_id: 'ack', event});
  const push = (...signals: Envelope[]) => {
    store.pushBatch({project_id: 'p', rows: [], signals, counters: []} as FeedBatch);
    vi.advanceTimersByTime(17); // one jsdom rAF period: exactly one drain
  };
  const announce = (): Event =>
    ({type:'session-started', provider_session_id:'p1', model:'m', cwd:'/repo', capabilities:[], resume_token:null});

  store.start();
  push(signal(announce()), signal({type:'turn-started', turn_id:'t1'}),
       signal({type:'turn-completed', turn_id:'t1', stop_reason:'end-turn', cost_usd_cumulative:0,
               usage:{input_tokens:0, output_tokens:0, cache_read_tokens:0, cache_creation_tokens:0, context_window:null}}));
  const read = store.getState();
  const {result, rerender} = renderHook(({sessions, selected}) => useAttention(sessions, selected, []),
    {initialProps:{sessions: read.sessions, selected: 'ack' as string|null}});
  expect(result.current.ack).toBe(false);

  push(signal(announce())); // a cursor-only advance for the session being read
  expect(store.getState()).toBe(read); // no rebuild on this frame: the snapshot still trails
  const live = seq;
  rerender({sessions: store.getState().sessions, selected: null}); // …and the operator leaves
  expect(readSequence('ack')).toBe(live); // pre-fix: the snapshot's stale sequence
  expect(stored().ack).toBe(live); // leaving persisted it, before the switch is observable

  vi.advanceTimersByTime(600); // the COUNTER_FLUSH_MS fold
  const folded = store.getState();
  expect(folded).not.toBe(read);
  rerender({sessions: folded.sessions, selected: null});
  expect(result.current.ack).toBe(false); // no dot on the conversation just read
  store.stop();
});

it('turns a background badge on from a signal that moved only the event cursor', async () => {
  vi.useFakeTimers();
  vi.resetModules();
  const store = await import('./feedStore');
  let seq = 0;
  const signal = (event: Event): Envelope => ({seq: ++seq, at: 1_000, instance_id: 'i', session_id: 'bg', event});
  const push = (...signals: Envelope[]) => {
    store.pushBatch({project_id: 'p', rows: [], signals, counters: []} as FeedBatch);
    vi.advanceTimersByTime(17); // one jsdom rAF period: exactly one drain
  };
  const announce = (): Event =>
    ({type:'session-started', provider_session_id:'p1', model:'m', cwd:'/repo', capabilities:[], resume_token:null});

  store.start();
  push(signal(announce()), signal({type:'turn-started', turn_id:'t1'}),
       signal({type:'turn-completed', turn_id:'t1', stop_reason:'end-turn', cost_usd_cumulative:0,
               usage:{input_tokens:0, output_tokens:0, cache_read_tokens:0, cache_creation_tokens:0, context_window:null}}));
  const read = store.getState();
  markSessionRead('bg', read.sessions['bg']!.lastEventSeq); // the operator saw this session
  const {result, rerender} = renderHook(({sessions}) => useAttention(sessions, null, []),
    {initialProps:{sessions: read.sessions}});
  expect(result.current.bg).toBe(false);

  // New activity while the session is in the background, carrying nothing rendered but the cursor.
  push(signal(announce()));
  expect(store.getState()).toBe(read); // no rebuild on this frame, so no shell re-render
  rerender({sessions: store.getState().sessions});
  expect(result.current.bg).toBe(false);

  vi.advanceTimersByTime(600); // the COUNTER_FLUSH_MS fold
  const folded = store.getState();
  expect(folded).not.toBe(read);
  rerender({sessions: folded.sessions});
  expect(result.current.bg).toBe(true);
  store.stop();
});
