// Adapted from assistant-ui Elements (MIT). The agent owns these checkpoint tasks.
import { AgentStatus } from './agent-status';
export interface TodoItem {id:string;text:string;status:'pending'|'in-progress'|'done'|'blocked'}
export function TodoList({items}:{items:TodoItem[]}) {
  return <ol data-slot="todo-list" className="flex flex-col gap-2">{items.map(item=><li key={item.id} className="flex items-start gap-3">
    <AgentStatus state={item.status==='done'?'done':item.status==='in-progress'?'working':'waiting'} label={item.status.replace(/-/g,' ')}/><span className="min-w-0 flex-1">{item.text}</span>
  </li>)}</ol>;
}
