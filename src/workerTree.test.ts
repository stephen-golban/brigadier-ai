import { expect, it } from 'vitest';
import { workerTree } from './workerTree';
import type { PeerData } from './peerApi';
import type { SessionRuntime } from './feedStore';
it('tracks owned descendants, retains retired workers, excludes consultations and terminates cycles',()=>{
 const peers: PeerData = {origins:{ child:'root', grandchild:'child', root:'grandchild'},titles:{},closed:['child'],requests:[],messages:[{id:'m',from:'root',to:'independent',text:'consult',work:false,delivered:true,error:null}]};
 expect(workerTree('root',peers,{}).map(r=>[r.id,r.depth,r.done])).toEqual([['child',0,true],['grandchild',1,false]]);
});
it('distinguishes completed idle turns awaiting integration from working and not-yet-started workers',()=>{
 const peers: PeerData = {origins:{complete:'root',working:'root',waiting:'root'},titles:{},closed:[],requests:[],messages:[]};
 const base={status:'running',lastTurnId:'turn',lastStop:'end-turn'};
 const sessions={complete:{...base,busy:false},working:{...base,busy:true},waiting:{...base,busy:false,lastStop:null}} as unknown as Record<string,SessionRuntime>;
 expect(workerTree('root',peers,sessions).map(r=>[r.id,r.awaitingIntegration,r.done])).toEqual([['complete',true,false],['working',false,false],['waiting',false,false]]);
});
