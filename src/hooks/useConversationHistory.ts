import { countDiagnostic, profiling, traceEvent } from "../perfDiagnostics";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { workspaceApi, desktop, errorMessage, type ChatItem, type ChatTurn, type HistoryPage } from '../workspaceApi';
import * as store from '../feedStore';
import { mergeHistory } from '../conversationHistory';
import { prepareTimestampLabels, subscribeTimestampLabels, timestampKey } from '../timestampLabels';

// One shared empty window, so the reset below can be a real no-op. The effect re-runs on every
// `[sessionId, revision]` change and must clear the previous conversation; on a first mount it has
// nothing to clear, and a fresh `[]` literal defeats React's `Object.is` bail-out — costing an
// extra render *and* commit of the whole mounted transcript inside the first-mount window the
// native 60 Hz burn is measured over. Neither array is ever mutated; the read path only maps.
const EMPTY_ITEMS: ChatItem[] = [];
const EMPTY_TURNS: ChatTurn[] = [];
/** Shared so the common case — no label ever moved — never changes the hook's result identity. */
const EMPTY_LABEL_PATCH: ReadonlyMap<number, number> = new Map();

// The explicitly enabled native burn audits the mounted transcript, not only IPC rows.
const historyDelivery = new Map<string, {responses: number; lastItemSeq: number}>();
export function getHistoryDelivery() {
  return [...historyDelivery].map(([sessionId, value]) => ({sessionId, ...value}));
}

/**
 * **[measured]** `docs/performance/2026-09-11/cold-path-attribution.md` §3: the effect below fired
 * its first `history-request` **3 ms after the mount commit ended**, 4 traces of 4, so the 19 ms
 * IPC round trip ran strictly *after* the 13 ms render + 7 ms commit instead of under them. The
 * request is therefore issued from the render that mounts the transcript, and the effect claims the
 * promise instead of issuing a second one.
 *
 * One slot, because only the transcript that is mounting right now can claim it. It is kept after
 * the claim so React 19 StrictMode's mount → unmount → mount replay reuses the same round trip;
 * a genuine remount is distinguished by `claimed && released` and starts a fresh page, so a
 * conversation is never served a page fetched before it was unmounted.
 */
type FirstPage = {key: string; page: Promise<HistoryPage>; claimed: boolean; released: boolean};
let firstPage: FirstPage | null = null;
const firstPageKey = (sessionId: string, revision: number) => `${revision}:${sessionId}`;

function beginFirstPage(sessionId: string, revision: number) {
  const key = firstPageKey(sessionId, revision);
  if (firstPage?.key === key && !(firstPage.claimed && firstPage.released)) return;
  if (profiling) traceEvent("history-request");
  const page = workspaceApi.historyPage(sessionId, {});
  // The effect owns the real handling; a page nobody claims must not become an unhandled rejection.
  void page.catch(() => {});
  firstPage = {key, page, claimed: false, released: false};
}

function claimFirstPage(key: string): Promise<HistoryPage> | null {
  if (firstPage?.key !== key) return null;
  firstPage.claimed = true;
  return firstPage.page;
}

function releaseFirstPage(key: string) {
  if (firstPage?.key === key) firstPage.released = true;
}

/**
 * Turn equality without serialising the array twice per response (534-544 responses per 63 s run).
 * `ChatTurn` is a flat record of six scalars, so field equality is exactly `JSON.stringify`
 * equality for anything the `chat_turns` command can return, at O(changed) instead of O(n·size).
 */
export function sameTurns(a: readonly ChatTurn[], b: readonly ChatTurn[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const left = a[index]!, right = b[index]!;
    if (left === right) continue;
    if (left.id !== right.id || left.start_seq !== right.start_seq || left.end_seq !== right.end_seq
      || left.started_at !== right.started_at || left.ended_at !== right.ended_at || left.status !== right.status) return false;
  }
  return true;
}

export function useConversationHistory(sessionId: string, revision: number) {
  const [items,setItems] = useState<ChatItem[]>(EMPTY_ITEMS);
  const [turns,setTurns] = useState<ChatTurn[]>(EMPTY_TURNS);
  const [loaded,setLoaded] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const [hasOlder,setHasOlder] = useState(false);
  const [paging,setPaging] = useState(false);
  const [historical,setHistorical] = useState(false);
  const [labelPatch,setLabelPatch] = useState(EMPTY_LABEL_PATCH);
  const control = useRef<{older:()=>Promise<void>; latest:()=>Promise<void>} | undefined>(undefined);
  // Render phase on purpose: the IPC round trip has to overlap the mount commit, not follow it.
  useMemo(() => beginFirstPage(sessionId, revision), [sessionId, revision]);
  useEffect(()=>{
    const key = firstPageKey(sessionId, revision);
    let live=true, fetching=false, dirty=false, cursor=0, before:number|null=null, browsing=false;
    let windowItems: ChatItem[] = [];
    let timer:ReturnType<typeof setTimeout>|undefined;
    let started = claimFirstPage(key);
    setItems(EMPTY_ITEMS); setTurns(EMPTY_TURNS); setLoaded(false); setHistorical(false); setError(null);
    setLabelPatch(EMPTY_LABEL_PATCH);
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
        // The first page was already asked for from the mounting render, and carries its own stamp.
        const inFlight = mode === 'latest' ? started : null;
        started = null;
        if (!inFlight && profiling) traceEvent("history-request");
        const page = await (inFlight ?? workspaceApi.historyPage(sessionId, mode==='older' && before!==null ? {before} : mode==='updates' ? {after:cursor} : {}));
        countDiagnostic("historyResponse");
        if (profiling) traceEvent("history-response", page.items.length);
        if (!page.items.length) countDiagnostic("emptyHistoryResponse");
        const merged = mode === 'latest' ? page.items : mergeHistory(windowItems, page.items, mode === 'older' ? 'older' : 'latest');
        // Labels are prepared beside the turns round trip and **not** awaited with it: the page is
        // published as soon as `chatTurns` resolves, and a label that arrives later patches only
        // the rows whose text actually moved. Rows rendered before it arrives take the same
        // synchronous fallback `timestampLabels.ts` already serves on a worker timeout.
        void prepareTimestampLabels(merged).then(() => {if (profiling) traceEvent("labels-applied", merged.length);});
        // `d` on the request is the window size asked about; 0 means no invoke was made at all.
        if (profiling) traceEvent("turns-request", merged.length);
        const recorded: ChatTurn[] = merged.length
          ? await workspaceApi.chatTurns(sessionId, {start: Math.min(...merged.map(item => item.seq)), end: Math.max(...merged.map(item => item.seq))})
          : [];
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
        setTurns(old=>sameTurns(old,recorded)?old:recorded);
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
    let token = '';
    const unsubscribe = store.subscribe(()=>{
      const next = store.getSessionCursor(sessionId);
      if(next!==token){token=next;changed();}
    });
    const unlisten = desktop ? listen<{sessionId:string}>('conversation-state-changed', e=>{if(e.payload.sessionId===sessionId)changed();}) : Promise.resolve(()=>{});
    const focus=()=>changed(); window.addEventListener('focus',focus);
    // Fires only when a prepared label differs from one a row already rendered. The scan is O(n)
    // but runs per *change*, and the measured change count is zero: `burn-worker-labels.json`
    // records one worker label in a 63 s run, and the worker and the fallback format the same
    // string from the same locale and zone. Rows whose key did not move keep their patch value,
    // so their `MessageTimestamp` keeps its identity and its memoised label.
    const unpatch = subscribeTimestampLabels(changedKeys => {
      if (!live || !windowItems.length) return;
      const keys = new Set(changedKeys);
      const affected = windowItems.filter(item => item.at > 0 && keys.has(timestampKey(new Date(item.at))));
      if (!affected.length) return;
      setLabelPatch(old => {
        const next = new Map(old);
        affected.forEach(item => next.set(item.seq, (next.get(item.seq) ?? 0) + 1));
        return next;
      });
    });
    void read('latest');
    return ()=>{live=false;clearTimeout(timer);releaseFirstPage(key);historyDelivery.delete(sessionId);unsubscribe();unpatch();window.removeEventListener('focus',focus);void unlisten.then(stop=>stop());};
  },[sessionId,revision]);
  const older=useCallback(()=>control.current?.older(),[]);
  const latest=useCallback(()=>control.current?.latest(),[]);
  return {items,turns,loaded,error,hasOlder,paging,historical,labelPatch,older,latest};
}
