import { useEffect } from 'react';
const initial=()=>({name:'',completed:false,introSeen:false,music:true});
let prefs=initial();
export const launchApi={
 preferences:async()=>({...prefs}),status:async()=>({ready:true,error:null}),
 seen:async()=>{prefs.introSeen=true},
 complete:async(name:string)=>{if(!name.trim())throw Error('Enter your name.');prefs={...prefs,name:name.trim(),completed:true,introSeen:true};return {...prefs}},
 reset:async()=>{const music=prefs.music;prefs={...initial(),music};window.dispatchEvent(new Event('brigadier-reset-welcome'))},
 restart:async()=>{},
 music:async(enabled:boolean)=>{prefs.music=enabled;window.dispatchEvent(new Event('workbench-data-changed'))},
};
export const errorMessage=(e:unknown)=>e instanceof Error?e.message:String(e);
export function App({onReady}:{onReady:()=>void}){
 useEffect(onReady,[onReady]);
 return <div className="preview-complete"><h1>Preview complete.</h1><p>This is where the existing sequence reveals your workspace.</p></div>
}
