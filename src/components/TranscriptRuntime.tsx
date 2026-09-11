import {useCallback,useMemo,type ReactNode} from 'react';
import {AssistantRuntimeProvider,ReadonlyThreadProvider,AuiProvider,AuiConfig,type AppendMessage,type ExternalStoreAdapter,type ThreadMessage,type ThreadMessageLike,useExternalStoreRuntime} from '@assistant-ui/react';
import {bridge} from '../bridge';
type TranscriptRuntimeProps = {sessionId:string;messages:ThreadMessageLike[];busy:boolean;loaded:boolean;readOnly:boolean;children:ReactNode};
export function TranscriptRuntime(props:TranscriptRuntimeProps) {
  return props.readOnly ? <ReadonlyTranscriptRuntime {...props}/> : <WritableTranscriptRuntime {...props}/>;
}
function ReadonlyTranscriptRuntime(props:TranscriptRuntimeProps) {
  const readonlyMessages = useMemo<ThreadMessage[]>(()=>props.messages.map((m,index)=>{
    const base = {id:m.id ?? String(index),createdAt:new Date(0),content:typeof m.content === 'string' ? [{type:'text' as const,text:m.content}] : m.content.filter(p=>p.type==='text')};
    return m.role === 'user' ? {...base,role:'user',attachments:[],metadata:{custom:{}}} : {...base,role:'assistant',status:{type:'complete',reason:'stop'},metadata:{custom:{},unstable_state:null,unstable_annotations:[],unstable_data:[],steps:[]}};
  }),[props.messages]);
  return <AuiProvider config={AuiConfig({})}><ReadonlyThreadProvider messages={readonlyMessages}>{props.children}</ReadonlyThreadProvider></AuiProvider>;
}
// Changing this function's identity invalidates the library's entire message cache.
const convertMessage = (message:ThreadMessageLike) => message;
function WritableTranscriptRuntime({sessionId,messages,busy,loaded,children}:TranscriptRuntimeProps) {
  const onNew = useCallback(async (message:AppendMessage) => {
      const text = message.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      await bridge().sendTurn(sessionId, text);
  },[sessionId]);
  const onCancel = useCallback(async () => { await bridge().interrupt(sessionId); },[sessionId]);
  const adapter = useMemo<ExternalStoreAdapter<ThreadMessageLike>>(()=>({
    messages,convertMessage,isRunning:busy,isLoading:!loaded,onNew,onCancel,
  }),[messages,busy,loaded,onNew,onCancel]);
  const runtime = useExternalStoreRuntime(adapter);
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
