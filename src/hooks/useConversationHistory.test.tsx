import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useConversationHistory } from './useConversationHistory';

const fake = vi.hoisted(() => ({seq: 1, subscribers: new Set<() => void>(), history: vi.fn()}));
vi.mock('../workspaceApi', () => ({desktop:false, errorMessage:String, workspaceApi:{
  historyPage: fake.history,
  chatTurns: async () => [],
}}));
vi.mock('../feedStore', () => ({
  getState: () => ({sessions:{s:{rowsTotal:fake.seq,lastEventSeq:fake.seq,busy:true}}}),
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
