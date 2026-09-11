import { countDiagnostic, profiling, traceEvent } from "../perfDiagnostics";
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { workspaceApi, desktop, errorMessage, type ChatItem, type ChatTurn } from '../workspaceApi';
import * as store from '../feedStore';
import { mergeHistory } from '../conversationHistory';

// One shared empty window, so the reset below can be a real no-op. The effect re-runs on every
// `[sessionId, revision]` change and must clear the previous conversation; on a first mount it has
// nothing to clear, and a fresh `[]` literal defeats React's `Object.is` bail-out — costing an
// extra render *and* commit of the whole mounted transcript inside the first-mount window the
// native 60 Hz burn is measured over. Neither array is ever mutated; the read path only maps.
const EMPTY_ITEMS: ChatItem[] = [];
const EMPTY_TURNS: ChatTurn[] = [];

// The explicitly enabled native burn audits the mounted transcript, not only IPC rows.
const historyDelivery = new Map<string, {responses: number; lastItemSeq: number}>();
export function getHistoryDelivery() {
  return [...historyDelivery].map(([sessionId, value]) => ({sessionId, ...value}));
}

export function useConversationHistory(sessionId: string, revision: number) {
  const [items,setItems] = useState<ChatItem[]>(EMPTY_ITEMS);
  const [turns,setTurns] = useState<ChatTurn[]>(EMPTY_TURNS);
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
    setItems(EMPTY_ITEMS); setTurns(EMPTY_TURNS); setLoaded(false); setHistorical(false); setError(null);
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
        // Diagnostic only, both sides of each awaited invoke: a long frame gap with no React span
        // is either an IPC response landing on the main thread or it is not, and this says which.
        if (profiling) traceEvent("history-request");
        const page = await workspaceApi.historyPage(sessionId, mode==='older' && before!==null ? {before} : mode==='updates' ? {after:cursor} : {});
        countDiagnostic("historyResponse");
        if (profiling) traceEvent("history-response", page.items.length);
        if (!page.items.length) countDiagnostic("emptyHistoryResponse");
        const merged = mode === 'latest' ? page.items : mergeHistory(windowItems, page.items, mode === 'older' ? 'older' : 'latest');
        // `d` on the request is the window size asked about; 0 means no invoke was made at all.
        if (profiling) traceEvent("turns-request", merged.length);
        const recorded = merged.length ? await workspaceApi.chatTurns(sessionId, {start: Math.min(...merged.map(item => item.seq)), end: Math.max(...merged.map(item => item.seq))}) : [];
        if (profiling) traceEvent("turns-response", recorded.length);
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
    // The token comes off `getSessionCursor`, the live map, not off `getState()`: the React
    // snapshot folds `lastEventSeq` and `rowsTotal` in on a 500 ms tick so the shell does not
    // re-render for a number nobody draws (`src/feedStore.ts` header), and a token at that
    // resolution would stop the mounted transcript following a live conversation.
    // **[measured]** 534-544 history responses in 63 s of the 60 Hz benchmark; under 60 fails the
    // run at `scripts/measure-native-burn.py:119`.
    // The token's `deltas` field is what makes a *streaming* body arrive at all: a content delta
    // writes to SQLite but produces no feed row and no signal, so without it `rowsTotal` and
    // `lastEventSeq` hold still for the whole of a long answer and nothing here ever fires
    // (§4.2 of `docs/plans/codex-thread-rebuild-2026-09-11.md`). Streamed prose therefore grows at
    // this debounce's 100 ms granularity, not per fragment.
    let token = '';
    const unsubscribe = store.subscribe(()=>{
      const next = store.getSessionCursor(sessionId);
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
