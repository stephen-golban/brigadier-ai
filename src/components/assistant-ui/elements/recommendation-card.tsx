// Adapted from assistant-ui Elements (MIT). Never invent model confidence.
import type { ReactNode } from 'react';
import { Button } from '../../controls/button';
export function RecommendationCard({question,children,onAccept,onAlternatives,busy,accepted,acceptLabel='Accept',alternativeLabel='Alternatives'}:{question:string;children:ReactNode;onAccept:()=>void;onAlternatives:()=>void;busy?:boolean;accepted?:string;acceptLabel?:string;alternativeLabel?:string}) {
  return <section data-slot="recommendation-card" className="element-surface">
    {accepted?<p role="status">{accepted}</p>:<><header>{question}</header><div>{children}</div><div className="flex flex-wrap gap-2 pt-2"><Button disabled={busy} onClick={onAlternatives}>{alternativeLabel}</Button><Button disabled={busy} onClick={onAccept}>{acceptLabel}</Button></div></>}
  </section>;
}
