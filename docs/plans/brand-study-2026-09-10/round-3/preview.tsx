import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Launch} from '../../../../src/Launch';
import {launchApi} from './mocks';
import {SoundContext} from './PreviewMusic';
import {BrandMark} from '../../../../src/components/BrandMark';
import './preview.css';

function Preview(){
 const [started,start]=useState(false),[music,setMusic]=useState(true);
 return <SoundContext.Provider value="arrival.m4a">
  {started?<Launch/>:<main className="preview-start">
   <p>Brigadier / Spark</p><h1>Back to the gradient.</h1>
   <BrandMark className="preview-mark"/>
   <button className="preview-play" onClick={async()=>{await launchApi.reset();start(true)}}>Play intro · Arrival</button>
   <p className="preview-note">Periwinkle into deep blue, from your reference.<br/>The refined Spark shape, transparent cutouts, and Arrival.</p>
  </main>}
  {started&&<nav className="preview-toolbar" aria-label="Appearance study controls"><span>Preview</span><button onClick={()=>void launchApi.reset()}>Replay</button><button aria-pressed={!music} onClick={()=>{setMusic(!music);void launchApi.music(!music)}}>{music?'Mute':'Unmute'}</button><button onClick={()=>start(false)}>View mark</button></nav>}
 </SoundContext.Provider>
}
createRoot(document.getElementById('root')!).render(<Preview/>);
