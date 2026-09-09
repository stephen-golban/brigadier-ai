import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {type PeerData} from '../peerApi';
import {conversationOwner} from '../workerTree';
import {workbenchApi,defaultOrchestrationPolicy} from '../workbenchApi';
import {RecommendationCard} from './assistant-ui/elements/recommendation-card';
import {AgentStatus} from './assistant-ui/elements/agent-status';
import {errorMessage} from '../workspaceApi';
/** Measurements and human outcome confirmation remain in the owner conversation. */
export function TaskPolicyStatus({sessionId,projectId,peers}:{sessionId:string;projectId:string|null;peers?:PeerData}){
 const [confirmed,setConfirmed]=useState<Record<string,string>>({});
 const [limit,setLimit]=useState<number|null>(null);const [message,setMessage]=useState('');const [busy,setBusy]=useState(false);
 useEffect(()=>{let live=true;const refresh=()=>void workbenchApi.load().then(d=>{const p=(projectId?d.projectPeers?.[projectId]:undefined)??d.peers;if(live)setLimit((p?.orchestration??defaultOrchestrationPolicy).maxDispatches);}).catch(()=>{});refresh();window.addEventListener('workbench-data-changed',refresh);return()=>{live=false;window.removeEventListener('workbench-data-changed',refresh);};},[projectId]);
 if(!peers || peers.subagents?.[sessionId])return null;
 const allowance=peers.allowances?.[sessionId];const used=allowance?.receipts.length??0;const total=limit===null?null:limit+(allowance?.extra??0);
 const contributions=Object.entries(peers.assignments??{}).filter(([id,a])=>conversationOwner(id,peers)===sessionId&&a.state==='completed'&&a.evidence);
 const confirm=async(id:string,revision:number,accepted:boolean)=>{setBusy(true);try{await invoke('confirm_worker_outcome',{conversationId:sessionId,sessionId:id,expectedRevision:revision,accepted});setConfirmed(old=>({...old,[`${id}:${revision}`]:accepted?'Verified outcome saved.':'Confirmed defect saved.'}));setMessage(accepted?'Verified outcome saved for future routing.':'Confirmed defect saved for future routing.');}catch(e){setMessage(errorMessage(e));}finally{setBusy(false);}};
 if(!used&&!contributions.length)return null;
 return <div className="task-progress mx-auto max-w-[780px] text-xs text-text-secondary">
   <AgentStatus state={total!==null&&used>=total?'waiting':'idle'} label={`Background model turns: ${used}${total===null?'':` / ${total}`}`}/>
   {total!==null&&used>=total*0.8&&<p role="status">{used>=total?'Task allowance reached. New background work is paused.':'Approaching the task allowance.'} Ask the orchestrator for a cheaper plan or approve an allowance increase. Provider tokens and cost may be unavailable.</p>}
   {!!contributions.length&&<details><summary>Confirm contribution outcomes</summary>{contributions.map(([id,a])=><RecommendationCard key={id} question={`Verify ${peers.titles[id]??'worker'} contribution?`} busy={busy} accepted={confirmed[`${id}:${a.revision}`]} acceptLabel="I verified this result" alternativeLabel="I confirmed a defect" onAccept={()=>void confirm(id,a.revision,true)} onAlternatives={()=>void confirm(id,a.revision,false)}><p>{a.result}</p><p>{a.evidence}</p><small>{a.disposition} · Confirm after checking the evidence.</small></RecommendationCard>)}</details>}
   {message&&<p role="status">{message}</p>}
 </div>;
}
