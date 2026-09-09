// Adapted from assistant-ui Elements (MIT). Opening activity does not accept a result.
import { AgentStatus } from './agent-status';
export interface BackgroundRun { id:string; title:string; state:'running'|'ready'|'failed'; summary?:string }
export function BackgroundInbox({runs,onCollect}:{runs:BackgroundRun[];onCollect:(id:string)=>void}) {
  if(!runs.length)return null;
  return <section data-slot="background-inbox" className="element-surface" aria-label="Background results">
    <header>Background results <span>{runs.filter(r=>r.state==='ready').length} ready</span></header>
    {runs.map(run=><button type="button" aria-label={`Open background result: ${run.title}`} key={run.id} onClick={()=>onCollect(run.id)} className="element-list-row">
      <span className="min-w-0 flex-1"><span>{run.title}</span>{run.summary&&<small className="line-clamp-2">{run.summary}</small>}</span>
      <AgentStatus state={run.state==='running'?'working':run.state==='ready'?'done':'failed'} label={run.state==='ready'?'Review result':run.state==='running'?'Working':'Inspect failure'}/>
    </button>)}
  </section>;
}
