import { TodoList } from './assistant-ui/elements/todo-list';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '../listeners';
import { desktop } from '../workspaceApi';
interface TaskMemory { sessionId:string; revision:number; goal:string; progress:{id:string;text:string;status:'pending'|'in-progress'|'done'|'blocked'}[]; decisions:string[]; results:string[]; verification:string[]; unresolved:string[] }
export function TaskProgress({sessionId}:{sessionId:string}) {
 const [memory,setMemory]=useState<TaskMemory|null>(null);
 useEffect(()=>{
  setMemory(null);
  if(!desktop)return;
  let live=true;
  const apply=(next:TaskMemory)=>{if(live&&next.sessionId===sessionId)setMemory(old=>old&&old.revision>next.revision?old:next);};
  const subscription=listen<TaskMemory>('task-checkpoint',e=>apply(e.payload));
  void invoke<TaskMemory>('task_checkpoint',{sessionId}).then(apply).catch(()=>{});
  return ()=>{live=false;void subscription.then(stop=>stop());};
 },[sessionId]);
 if(!memory || !(memory.progress.length||memory.results.length||memory.unresolved.length))return null;
 const done=memory.progress.filter(s=>s.status==='done').length;
 return <details className="task-progress mx-auto max-w-[780px] text-xs text-text-secondary" open={memory.progress.some(s=>s.status==='in-progress')}>
  <summary>Progress · {done}/{memory.progress.length}{memory.unresolved.length ? ` · ${memory.unresolved.length} unresolved` : ''}</summary>
  <TodoList items={memory.progress}/>
  {memory.verification.length>0 && <details><summary>Verification</summary><ul>{memory.verification.map((entry,i)=><li key={i}>{entry}</li>)}</ul></details>}
  {memory.results.length>0 && <details><summary>Results</summary><ul>{memory.results.map((entry,i)=><li key={i}>{entry}</li>)}</ul></details>}
  {memory.unresolved.map((entry,i)=><p key={i} className="text-warn">{entry}</p>)}
 </details>;
}
