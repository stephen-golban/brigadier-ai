import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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
export function useProviderCatalog(fallback: ModelInfo[]): ProviderCatalogState {
 const [state,setState]=useState<ProviderCatalogState>({providers:[],error:'',loaded:false});
 useEffect(()=>{
  let live=true;
  if(!desktop) {setState({providers:[{id:'claude-code',label:'Claude Code (demo)',instanceId:'replay:demo',version:null,models:fallback.map(m=>({...m,efforts:[]})),efforts:[],modelCatalogKnown:true}],error:'',loaded:true});return;}
  let attempts=0;
  let inflight=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let poll:ReturnType<typeof setInterval>|undefined;
  const stopPolling=()=>{clearInterval(poll);poll=undefined;};
  const again=()=>{const delay=RETRY_DELAYS_MS[attempts];if(delay===undefined)return false;attempts++;clearTimeout(timer);timer=setTimeout(read,delay);return true;};
  // One read at a time. Two overlapping reads would each schedule a retry on resolve, and the
  // second `setTimeout` would overwrite `timer` — leaking the first past unmount. Focus fires in
  // bursts (window focus plus a re-focused webview), so this is not theoretical.
  const read=()=>{
   if(inflight)return;
   inflight=true;
   void invoke<ProviderCatalogEntry[]>('provider_catalog').then(p=>{
    inflight=false;
    if(!live)return;
    // Retrying reads the cache the background discovery is filling; a rejection here is usually
    // `startup_pending`, so the error is held back until the retries are spent.
    const done=settled(p);
    const retrying=!done&&again();
    if(done)stopPolling();
    setState({providers:p,error:'',loaded:!retrying});
   },e=>{
    inflight=false;
    if(!live)return;
    const retrying=again();
    setState(s=>({providers:s.providers,error:retrying?'':String(e),loaded:!retrying}));
   });
  };
  const refresh=()=>{attempts=0;clearTimeout(timer);read();};
  read();
  // The retry budget is spent in 4.2 s; this covers the rest of the launch, and stops itself the
  // moment a real catalogue arrives. It never touches `loaded` — a spent budget is settled, and a
  // later poll that finds a provider simply fills `providers` in.
  poll=setInterval(read,POLL_MS);
  const stop=listen(REFRESHED_EVENT,()=>{if(live)read();});
  window.addEventListener('focus',refresh);
  return ()=>{live=false;clearTimeout(timer);stopPolling();window.removeEventListener('focus',refresh);void stop.then(unlisten=>unlisten()).catch(()=>{});};
 },[fallback]);
 return state;
}
