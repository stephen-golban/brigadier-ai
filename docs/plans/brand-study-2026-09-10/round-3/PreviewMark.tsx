import { useEffect,useState } from 'react';
export function BrandMark({className='brand-mark'}:{className?:string}){
 const [shape,setShape]=useState(()=>document.documentElement.dataset.mark||'spark');
 useEffect(()=>{const update=()=>setShape(document.documentElement.dataset.mark||'spark');window.addEventListener('preview-mark',update);return()=>window.removeEventListener('preview-mark',update)},[]);
 return <img className={className} src={'./'+shape+'.svg'} alt="Brigadier"/>
}
