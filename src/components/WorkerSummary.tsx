import { AgentStatus } from './assistant-ui/elements/agent-status';
import { workerPresentation, type WorkerRow } from '../workerTree';
/** Success counts stay separate from stopped/failed executions. */
export function WorkerSummary({rows}:{rows:WorkerRow[]}) {
  const working=rows.filter(r=>workerPresentation(r).state==='working').length;
  const done=rows.filter(r=>r.state==='completed').length;
  const waiting=rows.filter(r=>!r.done&&workerPresentation(r).state!=='working').length;
  const stopped=rows.filter(r=>r.done&&r.state!=='completed').length;
  return <span className="worker-summary"><AgentStatus state={working?'working':waiting?'waiting':done?'done':'idle'} label={`${working} working`}/><span>{done} done{waiting?` · ${waiting} waiting`:''}{stopped?` · ${stopped} stopped/failed`:''}</span></span>;
}
