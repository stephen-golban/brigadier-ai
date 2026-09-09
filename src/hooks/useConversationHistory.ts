import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { workspaceApi, desktop, errorMessage, type ChatItem, type ChatTurn } from '../workspaceApi';
import * as store from '../feedStore';
import { mergeHistory } from '../conversationHistory';

export function useConversationHistory(sessionId: string, revision: number) {
  const [items,setItems] = useState<ChatItem[]>([]);
  const [turns,setTurns] = useState<ChatTurn[]>([]);
  const [loaded,setLoaded] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const [hasOlder,setHasOlder] = useState(false);
  const [paging,setPaging] = useState(false);
  const [historical,setHistorical] = useState(false);
  const control = useRef<{older:()=>Promise<void>; latest:()=>Promise<void>} | undefined>(undefined);
  useEffect(()=>{
    let live=true, fetching=false, dirty=false, cursor=0, before:number|null=null, browsing=false;
    let windowItems: ChatItem[] = [];
    let timer:ReturnType<typeof setTimeout>|undefined;
    setItems([]); setTurns([]); setLoaded(false); setHistorical(false); setError(null);
    const read = async (mode: 'latest'|'older'|'updates') => {
      if (!live) return;
      if(fetching) { dirty=true; return; }
      if(mode==='updates' && browsing) return;
      fetching=true;
      if(mode==='older') setPaging(true);
      try {
        const page = await workspaceApi.historyPage(sessionId, mode==='older' && before!==null ? {before} : mode==='updates' ? {after:cursor} : {});
        const merged = mode === 'latest' ? page.items : mergeHistory(windowItems, page.items, mode === 'older' ? 'older' : 'latest');
        const recorded = merged.length ? await workspaceApi.chatTurns(sessionId, {start: Math.min(...merged.map(item => item.seq)), end: Math.max(...merged.map(item => item.seq))}) : [];
        if(!live) return;
        if(mode!=='updates') {
          browsing=mode==='older'; setHistorical(browsing);
          before=page.nextBefore; setHasOlder(page.hasMore);
        }
        if(mode!=='older') cursor=page.nextAfter;
        windowItems = merged;
        setItems(merged);
        setTurns(old=>JSON.stringify(old)===JSON.stringify(recorded)?old:recorded);
        setLoaded(true); setError(null);
        if(mode==='updates' && page.hasMore) dirty=true;
      } catch(e) { if(live) {setError(errorMessage(e));setLoaded(true);} }
      finally {
        fetching=false;
        if(live) {
          setPaging(false);
          if(dirty) {dirty=false;timer=setTimeout(()=>void read('updates'),80);}
        }
      }
    };
    control.current={older:()=>read('older'),latest:()=>read('latest')};
    const changed = () => { if(!live || browsing) return; if(fetching){dirty=true;return;} clearTimeout(timer);timer=setTimeout(()=>void read('updates'),100); };
    // Feed carries bounded activity notifications; full bodies are fetched only for touched sessions.
    let token = '';
    const unsubscribe = store.subscribe(()=>{
      const session=store.getState().sessions[sessionId];
      const next = session ? `${session.rowsTotal}:${session.lastEventSeq}:${session.busy}` : '';
      if(next!==token){token=next;changed();}
    });
    const unlisten = desktop ? listen<{sessionId:string}>('conversation-state-changed', e=>{if(e.payload.sessionId===sessionId)changed();}) : Promise.resolve(()=>{});
    const focus=()=>changed(); window.addEventListener('focus',focus);
    void read('latest');
    return ()=>{live=false;clearTimeout(timer);unsubscribe();window.removeEventListener('focus',focus);void unlisten.then(stop=>stop());};
  },[sessionId,revision]);
  const older=useCallback(()=>control.current?.older(),[]);
  const latest=useCallback(()=>control.current?.latest(),[]);
  return {items,turns,loaded,error,hasOlder,paging,historical,older,latest};
}
