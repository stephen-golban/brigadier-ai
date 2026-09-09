// Adapted from assistant-ui Elements (MIT). Only a recorded assignment handoff is shown.
export function AgentHandoff({from,to,reason,carried,settled}:{from:string;to:string;reason:string;carried:string[];settled:boolean}) {
  return <div data-slot="agent-handoff" className="element-surface">
    <header><span>{from} → {to}</span><span>{settled?'Handed off':'Handoff pending'}</span></header>
    <p>{reason}</p>{carried.length>0&&<details><summary>Carried context</summary><ul>{carried.map((text,i)=><li key={i}>{text}</li>)}</ul></details>}
  </div>;
}
