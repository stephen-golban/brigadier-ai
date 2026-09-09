import { expect, it } from 'vitest';
import { mergeHistory, HISTORY_WINDOW } from './conversationHistory';
import type { ChatItem } from './workspaceApi';
const row = (id: string, seq: number, body = id): ChatItem => ({ id, seq, body, session_id:'s', at:0, kind:{type:'assistant-text'}, parent_id:null });
it('replaces streaming IDs and ignores stale updates', () => {
 const result = mergeHistory([row('a',2,'first'),row('b',3)], [row('a',4,'streamed'),row('b',1,'stale')]);
 expect(result.map(r=>[r.id,r.body])).toEqual([['b','b'],['a','streamed']]);
});
it('bounds memory while paging in either direction', () => {
 const rows = Array.from({length:HISTORY_WINDOW+100}, (_,i)=>row(`${i}`,i));
 expect(mergeHistory([],rows)).toHaveLength(HISTORY_WINDOW);
 expect(mergeHistory([],rows)[0]?.seq).toBe(100);
 expect(mergeHistory([],rows,'older')[0]?.seq).toBe(0);
});
it('keeps unchanged row identities for incremental projection', () => {
 const item=row('a',1); expect(mergeHistory([item],[{...item}])[0]).toBe(item);
});
