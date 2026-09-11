import {useCallback,useMemo,type ReactNode} from 'react';
import {AssistantRuntimeProvider,DataRenderers,ReadonlyThreadProvider,AuiProvider,AuiConfig,fromThreadMessageLike,type AppendMessage,type ExternalStoreAdapter,type MessageStatus,type ThreadMessage,type ThreadMessageLike,useExternalStoreRuntime} from '@assistant-ui/react';
import {bridge} from '../bridge';
type TranscriptRuntimeProps = {sessionId:string;messages:ThreadMessageLike[];busy:boolean;loaded:boolean;readOnly:boolean;children:ReactNode};
/** Every saved row is finished by definition; a read-only thread never streams. */
const COMPLETE: MessageStatus = {type:'complete',reason:'stop'};
/** Saved bodies carry their own `at`; the runtime's own clock must not enter the render. */
const EPOCH = new Date(0);
/** Module scope so the external store sees one stable identity, not a new closure per render. */
const identity = (message: ThreadMessageLike) => message;
export function TranscriptRuntime(props:TranscriptRuntimeProps) {
  // Split so the read-only conversion is a hook of the read-only component only. Held in one
  // body, its `useMemo` still re-ran — and re-allocated a whole normalised message array — on
  // every `messages` change taken by the writable path, which never reads the result.
  return props.readOnly ? <ReadonlyTranscriptRuntime {...props}/> : <WritableTranscriptRuntime {...props}/>;
}
function ReadonlyTranscriptRuntime(props:TranscriptRuntimeProps) {
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
  // every work row and every notice does. Built once: a fresh config object per render is a
  // new provider value for the whole read-only subtree.
  const config = useMemo(()=>AuiConfig({dataRenderers:DataRenderers()}),[]);
  return <AuiProvider config={config}><ReadonlyThreadProvider messages={readonlyMessages}>{props.children}</ReadonlyThreadProvider></AuiProvider>;
}
function WritableTranscriptRuntime({sessionId,messages,busy,loaded,children}:TranscriptRuntimeProps) {
  const onNew = useCallback(async (message:AppendMessage) => {
    const text = message.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    await bridge().sendTurn(sessionId, text);
  },[sessionId]);
  const onCancel = useCallback(async () => { await bridge().interrupt(sessionId); },[sessionId]);
  // One adapter object per real input change. A fresh literal each render re-enters the store
  // runtime with new callback identities and invalidates the library's message cache, which
  // this codebase pays for as a re-render of the entire mounted transcript.
  const adapter = useMemo<ExternalStoreAdapter<ThreadMessageLike>>(()=>({
    messages,convertMessage:identity,isRunning:busy,isLoading:!loaded,onNew,onCancel,
  }),[messages,busy,loaded,onNew,onCancel]);
  const runtime = useExternalStoreRuntime(adapter);
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
