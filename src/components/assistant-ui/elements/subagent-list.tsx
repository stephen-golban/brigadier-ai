// Adapted from assistant-ui Elements (MIT), with explicit per-worker state.
import { AgentStatus } from './agent-status';
import type { ReactNode } from 'react';
export interface SubagentItem {
  id: string; name: string; model: string; detail?: string; icon?: ReactNode;
  state: 'working' | 'waiting' | 'idle' | 'done' | 'failed'; label: string;
}
export function SubagentList({agents,onSelect}:{agents:SubagentItem[];onSelect:(id:string)=>void}) {
  return <div data-slot="subagent-list">{agents.map(agent=><button type="button" key={agent.id} className="subagent-row" onClick={()=>onSelect(agent.id)}>
    {agent.icon}<span className="subagent-name">{agent.name}<small>{agent.model}</small>{agent.detail && <small title={agent.detail}>{agent.detail}</small>}</span>
    <AgentStatus state={agent.state} label={agent.label}/>
  </button>)}</div>;
}
