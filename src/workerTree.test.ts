import { expect, it } from 'vitest';
import { workerTree } from './workerTree';
import type { PeerData } from './peerApi';
import type { SessionRuntime } from './feedStore';
it('tracks owned descendants, retains retired workers, excludes consultations and terminates cycles',()=>{
 const peers: PeerData = {origins:{},subagents:{ child:'root', grandchild:'child', root:'grandchild'},titles:{},closed:['child'],requests:[],messages:[{id:'m',from:'root',to:'independent',text:'consult',work:false,delivered:true,error:null}]};
 expect(workerTree('root',peers,{}).map(r=>[r.id,r.depth,r.done])).toEqual([['child',0,true],['grandchild',1,false]]);
});
it('distinguishes completed idle turns awaiting integration from working and not-yet-started workers',()=>{
 const peers: PeerData = {origins:{},subagents:{complete:'root',working:'root',waiting:'root'},titles:{},closed:[],requests:[],messages:[]};
 const base={status:'running',lastTurnId:'turn',lastStop:'end-turn'};
 const sessions={complete:{...base,busy:false},working:{...base,busy:true},waiting:{...base,busy:false,lastStop:null}} as unknown as Record<string,SessionRuntime>;
 expect(workerTree('root',peers,sessions).map(r=>[r.id,r.awaitingIntegration,r.done])).toEqual([['complete',true,true],['working',false,false],['waiting',false,false]]);
});

it('keeps separate conversations and forks visible without granting worker ownership', async()=>{
 const {conversationOwner,conversationSessions}=await import('./workerTree');
 const peers={origins:{chat:'root',fork:'root',child:'root',grandchild:'child'},subagents:{child:'root',grandchild:'child'}};
 const sessions=Object.fromEntries(['root','chat','fork','child','grandchild'].map(id=>[id,{sessionId:id}])) as Record<string,SessionRuntime>;
 expect(Object.keys(conversationSessions(sessions,peers))).toEqual(['root','chat','fork']);
 expect(conversationOwner('grandchild',peers)).toBe('root');
 expect(conversationOwner('chat',peers)).toBe('chat');
 expect(conversationSessions(sessions,{...peers,loaded:false})).toEqual({});
});
