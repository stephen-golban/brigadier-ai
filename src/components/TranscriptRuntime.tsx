import {useMemo,type ReactNode} from 'react';
import {AssistantRuntimeProvider,DataRenderers,ReadonlyThreadProvider,AuiProvider,AuiConfig,fromThreadMessageLike,type MessageStatus,type ThreadMessage,type ThreadMessageLike,useExternalStoreRuntime} from '@assistant-ui/react';
import {bridge} from '../bridge';
type TranscriptRuntimeProps = {sessionId:string;messages:ThreadMessageLike[];busy:boolean;loaded:boolean;readOnly:boolean;children:ReactNode};
/** Every saved row is finished by definition; a read-only thread never streams. */
const COMPLETE: MessageStatus = {type:'complete',reason:'stop'};
/** Saved bodies carry their own `at`; the runtime's own clock must not enter the render. */
const EPOCH = new Date(0);
/** Module scope so the external store sees one stable identity, not a new closure per render. */
const identity = (message: ThreadMessageLike) => message;
export function TranscriptRuntime(props:TranscriptRuntimeProps) {
  // Phase 4: this used to be `m.content.filter(p => p.type === 'text')`, which dropped every
  // tool-call, reasoning and `data-*` part — i.e. every work row — from the read-only thread
  // `SubagentsPanel` mounts for a selected worker, and from every archived session.
  // `fromThreadMessageLike` is the runtime's own normaliser, so the read-only path now carries
  // exactly the parts the writable path does; nothing is filtered out.
  const readonlyMessages = useMemo<ThreadMessage[]>(()=>props.messages.map((m,index)=>
    fromThreadMessageLike(m.createdAt ? m : {...m,createdAt:EPOCH},m.id ?? String(index),COMPLETE)
  ),[props.messages]);
  // `dataRenderers` is mounted by the runtime adapter on the writable path only. Without it
  // `MessagePrimitive.Parts` throws `The current scope does not have a "dataRenderers"
  // property` the moment a read-only row carries a `data-*` part — which, since phase 4,
  // every work row and every notice does.
  if(props.readOnly) return <AuiProvider config={AuiConfig({dataRenderers:DataRenderers()})}><ReadonlyThreadProvider messages={readonlyMessages}>{props.children}</ReadonlyThreadProvider></AuiProvider>;
  return <WritableTranscriptRuntime {...props}/>;
}
function WritableTranscriptRuntime({sessionId,messages,busy,loaded,children}:TranscriptRuntimeProps) {
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: identity,
    isRunning: busy,
    isLoading: !loaded,
    onNew: async (message) => {
      const text = message.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      await bridge().sendTurn(sessionId, text);
    },
    onCancel: async () => {
      await bridge().interrupt(sessionId);
    },
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
