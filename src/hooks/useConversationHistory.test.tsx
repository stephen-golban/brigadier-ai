import { act, cleanup, render, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { sameTurns, useConversationHistory } from './useConversationHistory';
import type { ChatTurn } from '../workspaceApi';

const fake = vi.hoisted(() => ({seq: 1, subscribers: new Set<() => void>(), history: vi.fn(), turns: vi.fn(async () => [] as ChatTurn[])}));
vi.mock('../workspaceApi', () => ({desktop:false, errorMessage:String, workspaceApi:{
  historyPage: fake.history,
  chatTurns: fake.turns,
}}));
// Label preparation is deliberately off the publishing path, so the tests below hold it open and
// check that the page is already on screen while it is still pending.
const labels = vi.hoisted(() => ({waiting: [] as (() => void)[], listeners: new Set<(keys: readonly string[]) => void>()}));
vi.mock('../timestampLabels', () => ({
  prepareTimestampLabels: () => new Promise<void>(resolve => labels.waiting.push(resolve)),
  subscribeTimestampLabels: (listener: (keys: readonly string[]) => void) => {
    labels.listeners.add(listener);
    return () => labels.listeners.delete(listener);
  },
  timestampKey: (date: Date) => `key:${date.getTime()}`,
}));
vi.mock('../feedStore', () => ({
  // The hook reads the *live* cursor, not the React snapshot: `src/feedStore.ts` folds
  // `lastEventSeq`/`rowsTotal` into `getState()` only every 500 ms, and a token at that
  // resolution would stop the mounted transcript following a live conversation.
  getSessionCursor: (id: string) => id === 's' ? `${fake.seq}:${fake.seq}:true` : '',
  subscribe: (fn: () => void) => {fake.subscribers.add(fn); return () => fake.subscribers.delete(fn);},
}));
afterEach(() => {
  cleanup();vi.useRealTimers();fake.history.mockReset();fake.seq=1;
  fake.turns.mockReset();fake.turns.mockImplementation(async () => []);
  labels.waiting.length=0;labels.listeners.clear();
});

it('refreshes during a continuous stream, preserves older browsing, and catches up on latest', async () => {
  vi.useFakeTimers();
  fake.history.mockImplementation(async (_id, options) => {
    const seq = options?.before === undefined ? fake.seq : 0;
    return {items:[{id:'item',session_id:'s',seq,at:seq,kind:{type:'assistant-text'},body:String(seq)}], nextAfter:seq,nextBefore:seq,hasMore:false};
  });
  const {result} = renderHook(() => useConversationHistory('s', 0));
  await act(async () => {});
  for (let seq=2;seq<=151;seq++) {
    await act(async () => {
      fake.seq=seq;fake.subscribers.forEach(fn=>fn());
      await vi.advanceTimersByTimeAsync(20);
    });
  }
  expect(fake.history.mock.calls.length).toBeGreaterThan(20);
  expect(result.current.items[0].seq).toBeGreaterThan(140);
  await act(async () => {await vi.advanceTimersByTimeAsync(200);});
  expect(result.current.items[0].seq).toBe(151);
  await act(async () => {await result.current.older();});
  expect(result.current.historical).toBe(true);
  const calls = fake.history.mock.calls.length;
  await act(async () => {fake.seq=200;fake.subscribers.forEach(fn=>fn());await vi.advanceTimersByTimeAsync(1000);});
  expect(fake.history.mock.calls.length).toBe(calls);
  await act(async () => {await result.current.latest();});
  expect(result.current.historical).toBe(false);
  expect(result.current.items[0].seq).toBe(200);
});

/*
 * Invariant behind `getSessionCursor` (2026-09-10): `src/feedStore.ts` stopped rebuilding the React
 * snapshot for a signal that moved only `lastEventSeq`, so this hook reads the live cursor instead.
 * **[measured]** the 60 Hz native benchmark records 534-544 history responses in 63 s and
 * `scripts/measure-native-burn.py:119` fails a run under 60; a coarser token would fail it. The
 * store side of the same invariant is `src/feedStore.test.ts` "moves the live cursor once per
 * signal while the snapshot holds still", which pins 24 token changes over 24 signals.
 */
it('refreshes once per settled token change and not at all while the token repeats', async () => {
  vi.useFakeTimers();
  fake.history.mockImplementation(async () => ({items:[{id:'i',session_id:'s',seq:fake.seq,at:fake.seq,kind:{type:'assistant-text'},body:'b'}], nextAfter:fake.seq, nextBefore:fake.seq, hasMore:false}));
  renderHook(() => useConversationHistory('s', 0));
  await act(async () => {});
  const initial = fake.history.mock.calls.length;

  // Ten distinct cursors, each given the hook's 100 ms debounce window to settle.
  for (let seq = 2; seq <= 11; seq++) {
    await act(async () => {fake.seq = seq; fake.subscribers.forEach(fn => fn()); await vi.advanceTimersByTimeAsync(150);});
  }
  expect(fake.history.mock.calls.length).toBe(initial + 10);

  // Twenty notifications carrying the same cursor: the store notifies every frame it drains rows,
  // and a token that did not move must not cost an IPC round trip.
  const settled = fake.history.mock.calls.length;
  for (let i = 0; i < 20; i++) {
    await act(async () => {fake.subscribers.forEach(fn => fn()); await vi.advanceTimersByTimeAsync(150);});
  }
  expect(fake.history.mock.calls.length).toBe(settled);
});

/*
 * Mount cost. The native 60 Hz burn fails on the first mount of the transcript, so a state update
 * that carries no new information must not schedule a render of the mounted scaffolding. The
 * effect's reset runs on every `[sessionId, revision]` change; on a first mount it has nothing to
 * clear, and a fresh `[]` literal defeats React's `Object.is` bail-out.
 */
it('does not re-render the mount for a reset that clears nothing', async () => {
  fake.history.mockImplementation(async () => ({items:[{id:'i',session_id:'s',seq:1,at:1,kind:{type:'assistant-text'},body:'b'}], nextAfter:1, nextBefore:null, hasMore:false}));
  let renders = 0;
  const {result} = renderHook(() => {renders++; return useConversationHistory('s', 0);});
  await act(async () => {});
  await act(async () => {});
  expect(result.current.loaded).toBe(true);
  expect(result.current.items).toHaveLength(1);
  expect(renders).toBe(2);
});

it('clears the previous conversation when the session or revision changes', async () => {
  fake.history.mockImplementation(async (id: string) => ({items: id === 's' ? [{id:'i',session_id:'s',seq:1,at:1,kind:{type:'assistant-text'},body:'b'}] : [], nextAfter:1, nextBefore:null, hasMore:false}));
  const {result, rerender} = renderHook(({id}) => useConversationHistory(id, 0), {initialProps:{id:'s'}});
  await act(async () => {});
  await act(async () => {});
  expect(result.current.items).toHaveLength(1);
  fake.history.mockImplementation(async () => new Promise(() => {}));
  rerender({id:'other'});
  expect(result.current.items).toHaveLength(0);
  expect(result.current.turns).toHaveLength(0);
  expect(result.current.loaded).toBe(false);
  expect(result.current.historical).toBe(false);
  expect(result.current.error).toBe(null);
});

const item = (seq: number, at = seq) => ({id:`i${seq}`,session_id:'s',seq,at,kind:{type:'assistant-text'},body:`b${seq}`});
const page = (items: ReturnType<typeof item>[]) => ({items, nextAfter: items[items.length - 1]?.seq ?? 0, nextBefore: null, hasMore: false});

/*
 * P4a item 1. **[measured]** `docs/performance/2026-09-11/cold-path-attribution.md` §3: the first
 * `turns` await is 17-34 ms against a ~1 ms steady state and `turns-response` lands inside a
 * dropping frame in 4 traces of 4. Awaiting the timestamp worker in the same `Promise.all` put
 * worker startup on that path; the page must now be published while preparation is still pending.
 */
it('publishes the history page while label preparation is still pending', async () => {
  fake.history.mockImplementation(async () => page([item(1), item(2)]));
  const {result} = renderHook(() => useConversationHistory('s', 0));
  await act(async () => {});
  await act(async () => {});
  expect(result.current.loaded).toBe(true);
  expect(result.current.items).toHaveLength(2);
  expect(labels.waiting).toHaveLength(1);          // still unresolved: it never gated the publish
  expect(result.current.labelPatch.size).toBe(0);
});

it('patches only the rows whose prepared label replaced different text', async () => {
  fake.history.mockImplementation(async () => page([item(1, 1000), item(2, 2000)]));
  const {result} = renderHook(() => useConversationHistory('s', 0));
  await act(async () => {});
  await act(async () => {});
  const published = result.current.items;

  // A key nobody on this page renders must not cost a render at all.
  const before = result.current.labelPatch;
  await act(async () => {labels.listeners.forEach(fn => fn(['key:999999']));});
  expect(result.current.labelPatch).toBe(before);

  await act(async () => {labels.listeners.forEach(fn => fn(['key:2000']));});
  expect(result.current.labelPatch.get(2)).toBe(1);
  expect(result.current.labelPatch.get(1)).toBeUndefined();
  expect(result.current.items).toBe(published);     // the page itself is untouched
});

/*
 * P4a item 2. **[measured]** the same file: `history-request` fired 3 ms *after* the mount commit
 * ended, 4 of 4, so a 19 ms round trip ran strictly after a 13 ms render + 7 ms commit. The probe
 * renders after the hook in the same pass, before any effect flushes.
 */
it('asks for the first page from the render that mounts the transcript, not from an effect', async () => {
  fake.history.mockImplementation(async () => page([item(1)]));
  let duringRender = -1;
  function Host() {useConversationHistory('s', 0); return null;}
  function Probe() {duringRender = fake.history.mock.calls.length; return null;}
  await act(async () => {render(<><Host/><Probe/></>);});
  expect(duringRender).toBe(1);
  expect(fake.history).toHaveBeenCalledTimes(1);
});

it('issues one round trip across a StrictMode mount, unmount and remount', async () => {
  fake.history.mockImplementation(async () => page([item(1)]));
  function Host() {useConversationHistory('s', 0); return null;}
  await act(async () => {render(<StrictMode><Host/></StrictMode>);});
  expect(fake.history).toHaveBeenCalledTimes(1);
});

it('starts a fresh page for a genuine remount rather than replaying the unmounted one', async () => {
  fake.history.mockImplementation(async () => page([item(1)]));
  function Host() {useConversationHistory('s', 0); return null;}
  const first = render(<Host/>);
  await act(async () => {});
  first.unmount();
  await act(async () => {render(<Host/>);});
  expect(fake.history).toHaveBeenCalledTimes(2);
});

it('ignores the first page of a session the user has already left', async () => {
  const resolvers = new Map<string, (value: ReturnType<typeof page>) => void>();
  fake.history.mockImplementation((id: string) => new Promise(resolve => resolvers.set(id, resolve)));
  const {result, rerender} = renderHook(({id}) => useConversationHistory(id, 0), {initialProps:{id:'s'}});
  rerender({id:'other'});
  expect(resolvers.has('other')).toBe(true);
  await act(async () => {resolvers.get('s')!(page([item(1)]));});
  expect(result.current.items).toHaveLength(0);
  expect(result.current.loaded).toBe(false);
  await act(async () => {resolvers.get('other')!(page([]));});
  expect(result.current.loaded).toBe(true);
  expect(result.current.items).toHaveLength(0);
});

/*
 * P4a item 3. `JSON.stringify(old) === JSON.stringify(recorded)` ran twice over the whole turns
 * array on every one of the 534-544 history responses a 63 s benchmark run records.
 */
const turn = (over: Partial<ChatTurn> = {}): ChatTurn =>
  ({id:'t1',start_seq:1,end_seq:4,started_at:10,ended_at:20,status:'completed',...over});

it('keeps turn state identity for equal content and replaces it for any difference', async () => {
  const recorded = [turn(), turn({id:'t2',start_seq:5,end_seq:null,ended_at:null,status:'running'})];
  fake.history.mockImplementation(async () => page([item(1)]));
  fake.turns.mockImplementation(async () => recorded.map(value => ({...value})));
  const {result} = renderHook(() => useConversationHistory('s', 0));
  await act(async () => {});
  await act(async () => {});
  const published = result.current.turns;
  expect(published).toHaveLength(2);
  await act(async () => {await result.current.latest();});
  expect(result.current.turns).toBe(published);
  fake.turns.mockImplementation(async () => [recorded[0]!, {...recorded[1]!, status: 'completed' as const}]);
  await act(async () => {await result.current.latest();});
  expect(result.current.turns).not.toBe(published);
  expect(result.current.turns[1]!.status).toBe('completed');
});

it('agrees with the serialising comparison it replaced, over random histories', () => {
  let seed = 0x2026_0911;
  const next = () => {seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff;};
  const pick = <T,>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
  const statuses = ['running','completed','failed','stopped','interrupted'] as const;
  const make = (): ChatTurn => ({
    id: pick(['a','b','c']),
    start_seq: Math.floor(next() * 3),
    end_seq: next() < 0.3 ? null : Math.floor(next() * 3),
    started_at: Math.floor(next() * 3),
    ended_at: next() < 0.3 ? null : Math.floor(next() * 3),
    status: pick(statuses),
  });
  const list = () => Array.from({length: Math.floor(next() * 4)}, make);
  let equalCases = 0;
  for (let run = 0; run < 400; run++) {
    const left = list();
    // Half the runs compare a list with a copy of itself, so equality is actually exercised.
    const right = next() < 0.5 ? left.map(value => ({...value})) : list();
    const serialised = JSON.stringify(left) === JSON.stringify(right);
    if (serialised) equalCases++;
    expect(sameTurns(left, right)).toBe(serialised);
  }
  expect(equalCases).toBeGreaterThan(50);
});
