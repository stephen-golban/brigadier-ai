// Adapted from assistant-ui Elements (MIT). Inspection is separate from native restoration.
import type { ReactNode } from 'react';
export interface Checkpoint { id:string;label:string;at:string;detail?:ReactNode }
export function CheckpointHistory({checkpoints,selectedId,onSelect}:{checkpoints:Checkpoint[];selectedId:string|null;onSelect:(id:string)=>void}) {
  if(!checkpoints.length)return null;
  return <section data-slot="checkpoint-history" className="element-surface" aria-label="Checkpoints">
    <header>Checkpoints</header>{checkpoints.map(c=><div key={c.id}>
      <button type="button" className="element-list-row" aria-expanded={c.id===selectedId} onClick={()=>onSelect(c.id)}><span>{c.label}</span><small>{c.at}</small><span>{c.id===selectedId?'Hide':'Inspect'}</span></button>
      {c.id===selectedId&&c.detail}
    </div>)}
  </section>;
}
