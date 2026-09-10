import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Launch} from '../../../../src/Launch';
import {BrandMark} from '../../../../src/components/BrandMark';
import {launchApi} from './mocks';
import {SoundContext} from './PreviewMusic';
import './preview.css';

function Preview(){
 const [started,start]=useState(false),[music,setMusic]=useState(true);
 return <SoundContext.Provider value="arrival.m4a">
  {started?<Launch/>:<main className="preview-start">
   <p>Brigadier</p><h1>Striped disc. Arrival.</h1>
   <BrandMark className="preview-mark"/>
   <button className="preview-play" onClick={async()=>{await launchApi.reset();start(true)}}>Play intro · Arrival</button>
   <p className="preview-note">The selected striped-disc logo in the current intro, with Arrival.</p>
  </main>}
  {started&&<nav className="preview-toolbar" aria-label="Preview controls"><span>Striped disc · Arrival</span><button onClick={()=>void launchApi.reset()}>Replay</button><button aria-pressed={!music} onClick={()=>{setMusic(!music);void launchApi.music(!music)}}>{music?'Mute':'Unmute'}</button><button onClick={()=>start(false)}>Back</button></nav>}
 </SoundContext.Provider>
}
createRoot(document.getElementById('root')!).render(<Preview/>);
