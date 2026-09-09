import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from './workspaceApi';
import type { ModelInfo } from './wire';
export interface ProviderCatalogEntry {
 id:string; label:string; instanceId:string; version:string|null;
 models:{id:string;label:string;efforts:string[]}[]; efforts:string[]; modelCatalogKnown:boolean;
}
export function useProviderCatalog(fallback: ModelInfo[]) {
 const [providers,setProviders]=useState<ProviderCatalogEntry[]>([]);
 const [error,setError]=useState('');
 useEffect(()=>{
  let live=true;
  if(!desktop) {setProviders([{id:'claude-code',label:'Claude Code (demo)',instanceId:'replay:demo',version:null,models:fallback.map(m=>({...m,efforts:[]})),efforts:[],modelCatalogKnown:true}]);return;}
  const read=()=>void invoke<ProviderCatalogEntry[]>('provider_catalog').then(p=>{if(live){setProviders(p);setError('');}},e=>{if(live)setError(String(e));});
  read();window.addEventListener('focus',read);
  return ()=>{live=false;window.removeEventListener('focus',read);};
 },[fallback]);
 return {providers,error};
}
