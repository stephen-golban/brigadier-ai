import { countDiagnostic } from "../perfDiagnostics";
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { workspaceApi, desktop, errorMessage, type ChatItem, type ChatTurn } from '../workspaceApi';
import * as store from '../feedStore';
import { mergeHistory } from '../conversationHistory';

// The explicitly enabled native burn audits the mounted transcript, not only IPC rows.
const historyDelivery = new Map<string, {responses: number; lastItemSeq: number}>();
export function getHistoryDelivery() {
  return [...historyDelivery].map(([sessionId, value]) => ({sessionId, ...value}));
}

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
    const schedule = (delay = 100) => {
      if (timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; void read('updates'); }, delay);
    };
    const read = async (mode: 'latest'|'older'|'updates') => {
      if (!live) return;
      if(fetching) { dirty=true; return; }
      if(mode==='updates' && browsing) return;
      fetching=true;
      if(mode==='older') setPaging(true);
      try {
        const page = await workspaceApi.historyPage(sessionId, mode==='older' && before!==null ? {before} : mode==='updates' ? {after:cursor} : {});
        countDiagnostic("historyResponse");
        if (!page.items.length) countDiagnostic("emptyHistoryResponse");
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
        if (import.meta.env.VITE_BURN === "1") {
          historyDelivery.set(sessionId, {
            responses: (historyDelivery.get(sessionId)?.responses ?? 0) + 1,
            lastItemSeq: Math.max(0, ...merged.map(item => item.seq)),
          });
        }
        setTurns(old=>JSON.stringify(old)===JSON.stringify(recorded)?old:recorded);
        setLoaded(true); setError(null);
        if(mode==='updates' && page.hasMore) dirty=true;
      } catch(e) { if(live) {setError(errorMessage(e));setLoaded(true);} }
      finally {
        fetching=false;
        if(live) {
          setPaging(false);
          if(dirty) {dirty=false;schedule(80);}
        }
      }
    };
    control.current={older:()=>read('older'),latest:()=>read('latest')};
    const changed = () => { if(!live || browsing) return; if(fetching){dirty=true;return;} schedule(); };
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
    return ()=>{live=false;clearTimeout(timer);historyDelivery.delete(sessionId);unsubscribe();window.removeEventListener('focus',focus);void unlisten.then(stop=>stop());};
  },[sessionId,revision]);
  const older=useCallback(()=>control.current?.older(),[]);
  const latest=useCallback(()=>control.current?.latest(),[]);
  return {items,turns,loaded,error,hasOlder,paging,historical,older,latest};
}
