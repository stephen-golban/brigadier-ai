import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from './listeners';
import { desktop } from './workspaceApi';
import type { ModelInfo } from './wire';
export interface ProviderCatalogEntry {
 id:string; label:string; instanceId:string; version:string|null;
 models:{id:string;label:string;efforts:string[];resolvedId?:string|null}[]; efforts:string[]; modelCatalogKnown:boolean;
}
export interface ProviderCatalogState {
 providers:ProviderCatalogEntry[];
 error:string;
 /** The catalogue is settled: the read finished and no retry is outstanding. Never gate a
  * "nothing is connected" message on anything weaker — `provider_catalog` answers from the
  * capability cache and refreshes discovery behind the response, so an empty first read means
  * "not known yet" while a launch's first CLI handshake runs — 719 ms measured, `docs/STATUS.md`
  * §4 (`docs/research/execution-settings-banner.md`). */
 loaded:boolean;
}
/** Bounded, so a machine with no CLI installed settles instead of polling forever. Front-loaded:
 * the cache the Rust side is filling can be ready long before the 719 ms handshake's worst case,
 * and 300 ms is cheap to ask. The four delays total 4.2 s, after which an empty catalogue is
 * reported as empty. */
const RETRY_DELAYS_MS=[300,900,1500,1500];
/** Not a retry: once the budget is spent and the catalogue is still empty, this is the only thing
 * that would ever notice a CLI installed after launch, short of a window focus. Cleared the
 * moment the catalogue settles with a real answer. */
const POLL_MS=15000;
/** Emitted by `src-tauri/src/provider_catalog.rs` when a background discovery finishes, success or
 * failure. It is what makes the retry budget an optimisation rather than the whole mechanism: a
 * handshake slower than 4.2 s still lands, with no window `focus` to wake it — and a launch
 * generates no focus event, because the window already has it. */
const REFRESHED_EVENT='provider-catalog-refreshed';
/** An answer worth trusting: at least one provider, each with the models it advertises. */
const settled=(p:ProviderCatalogEntry[])=>p.length>0&&p.every(entry=>entry.modelCatalogKnown);
const EMPTY:ProviderCatalogState={providers:[],error:'',loaded:false};

/*
 * One module store, not one machine per mount.
 *
 * The hook is mounted by `Composer`, `NewSession` and `SessionPreferences`, and each mount used to
 * hold its own retry budget, its own `provider-catalog-refreshed` subscription, its own `focus`
 * listener and — on a machine with no CLI installed, where the catalogue never settles — its own
 * 15 s poll, for the window's life (`docs/research/lifecycle-bounds-audit-2026-09-11.md` §4,
 * Gap 8). This is the `src/workbenchStore.ts` shape: state and timers live in the module, the last
 * consumer to leave tears the whole thing down, and the answer is shared.
 */
let state:ProviderCatalogState=EMPTY;
const consumers=new Set<(s:ProviderCatalogState)=>void>();
let attempts=0;
let inflight=false;
/** A read has come back with a real catalogue: the poll has nothing left to find. */
let settledOnce=false;
/** A read was skipped because the document was hidden; the next `visible` owes one. */
let deferred=false;
let running=false;
/** Bumped by `stop()`, so a read resolving after teardown cannot write to a torn-down store. */
let generation=0;
let timer:ReturnType<typeof setTimeout>|undefined;
let poll:ReturnType<typeof setInterval>|undefined;
let unlisten:(()=>void)|undefined;

const hidden=()=>typeof document!=='undefined'&&document.visibilityState==='hidden';
const publish=(next:ProviderCatalogState)=>{state=next;for(const consumer of [...consumers])consumer(state);};
const stopPolling=()=>{clearInterval(poll);poll=undefined;};
const startPolling=()=>{if(poll===undefined&&!settledOnce&&!hidden())poll=setInterval(read,POLL_MS);};
const again=()=>{const delay=RETRY_DELAYS_MS[attempts];if(delay===undefined)return false;attempts++;clearTimeout(timer);timer=setTimeout(read,delay);return true;};
// One read at a time. Two overlapping reads would each schedule a retry on resolve, and the
// second `setTimeout` would overwrite `timer` — leaking the first past teardown. Focus fires in
// bursts (window focus plus a re-focused webview), so this is not theoretical.
function read(){
 if(inflight)return;
 // A hidden window is not worth an IPC round trip, and it must not spend the retry budget either:
 // `visibilitychange` gives the budget back, so a window backgrounded through the whole launch
 // still gets a full discovery when it comes forward. The catalogue is only ever read to draw it.
 if(hidden()){deferred=true;return;}
 deferred=false;
 inflight=true;
 const gen=generation;
 void invoke<ProviderCatalogEntry[]>('provider_catalog').then(p=>{
  if(gen!==generation)return;
  inflight=false;
  // Retrying reads the cache the background discovery is filling; a rejection here is usually
  // `startup_pending`, so the error is held back until the retries are spent.
  const done=settled(p);
  const retrying=!done&&again();
  if(done){settledOnce=true;stopPolling();}
  publish({providers:p,error:'',loaded:!retrying});
 },e=>{
  if(gen!==generation)return;
  inflight=false;
  const retrying=again();
  publish({providers:state.providers,error:retrying?'':String(e),loaded:!retrying});
 });
}
const refresh=()=>{attempts=0;clearTimeout(timer);read();};
// The poll is a timer a backgrounded window has no use for, so it is cleared on hide and re-armed
// on show — `src/workbenchStore.ts:173-180`. Coming forward also reads once, which is what keeps
// "a CLI installed after launch is discovered" true for a window that was hidden when it happened.
const onVisibility=()=>{
 if(hidden()){stopPolling();return;}
 if(deferred||!settledOnce)refresh();
 startPolling();
};

function start(){
 running=true;
 window.addEventListener('focus',refresh);
 document.addEventListener('visibilitychange',onVisibility);
 // Subscribe before the first read (`docs/plans/efficiency-plan-review-2026-09-11.md` §B4).
 // `listen` is async and Tauri v2 neither buffers nor replays: with `read()` first, a
 // `provider-catalog-refreshed` emitted while the subscription was still resolving was lost,
 // and only the 15 s poll would ever have noticed — the exact case the event exists for, a
 // handshake finishing right after the first read. The poll stays until this store's producer
 // coverage is proven; it is a belt, not the mechanism.
 const gen=generation;
 void (async()=>{
  try{
   const off=await listen(REFRESHED_EVENT,()=>{if(gen===generation)read();});
   // Teardown raced the pending `listen()`: nothing else will ever call this one.
   if(gen!==generation){off();return;}
   unlisten=off;
  }catch{
   if(gen!==generation)return;
  }
  read();
  // The retry budget is spent in 4.2 s; this covers the rest of the launch, and stops itself the
  // moment a real catalogue arrives. It never touches `loaded` — a spent budget is settled, and a
  // later poll that finds a provider simply fills `providers` in. A read that settled while this
  // was still awaiting the subscription (a `focus` beat it to it) needs no poll at all.
  startPolling();
 })();
}

function stop(){
 running=false;
 generation++;
 clearTimeout(timer);timer=undefined;
 stopPolling();
 window.removeEventListener('focus',refresh);
 document.removeEventListener('visibilitychange',onVisibility);
 unlisten?.();unlisten=undefined;
 attempts=0;inflight=false;settledOnce=false;deferred=false;
 state=EMPTY;
}

function subscribe(consumer:(s:ProviderCatalogState)=>void):()=>void{
 consumers.add(consumer);
 if(!running)start();
 else consumer(state);
 return()=>{consumers.delete(consumer);if(consumers.size===0)stop();};
}

/** Live consumers and whether the store's timers are armed. A test hook. */
export function providerCatalogStore(){return{consumers:consumers.size,running,polling:poll!==undefined};}

const demoState=(fallback:ModelInfo[]):ProviderCatalogState=>({providers:[{id:'claude-code',label:'Claude Code (demo)',instanceId:'replay:demo',version:null,models:fallback.map(m=>({...m,efforts:[]})),efforts:[],modelCatalogKnown:true}],error:'',loaded:true});

export function useProviderCatalog(fallback: ModelInfo[]): ProviderCatalogState {
 const demo=useMemo(()=>demoState(fallback),[fallback]);
 const [live,setLive]=useState<ProviderCatalogState>(()=>state);
 useEffect(()=>{if(desktop)return subscribe(setLive);},[]);
 return desktop?live:demo;
}
