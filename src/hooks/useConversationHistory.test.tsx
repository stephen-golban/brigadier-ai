import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useConversationHistory } from './useConversationHistory';

const fake = vi.hoisted(() => ({seq: 1, subscribers: new Set<() => void>(), history: vi.fn()}));
vi.mock('../workspaceApi', () => ({desktop:false, errorMessage:String, workspaceApi:{
  historyPage: fake.history,
  chatTurns: async () => [],
}}));
vi.mock('../feedStore', () => ({
  // The hook reads the *live* cursor, not the React snapshot: `src/feedStore.ts` folds
  // `lastEventSeq`/`rowsTotal` into `getState()` only every 500 ms, and a token at that
  // resolution would stop the mounted transcript following a live conversation.
  getSessionCursor: (id: string) => id === 's' ? `${fake.seq}:${fake.seq}:true` : '',
  subscribe: (fn: () => void) => {fake.subscribers.add(fn); return () => fake.subscribers.delete(fn);},
}));
afterEach(() => {cleanup();vi.useRealTimers();fake.history.mockReset();fake.seq=1;});

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
