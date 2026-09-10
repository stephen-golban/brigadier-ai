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
