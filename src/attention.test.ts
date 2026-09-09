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
