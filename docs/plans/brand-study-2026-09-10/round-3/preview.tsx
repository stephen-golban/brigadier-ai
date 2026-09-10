import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Launch} from '../../../../src/Launch';
import {launchApi} from './mocks';
import {SoundContext} from './PreviewMusic';
import {BrandMark} from '../../../../src/components/BrandMark';
import './preview.css';

const sounds = [
 {file:'arrival.m4a',name:'Arrival · Selected',description:'The chosen soundtrack for Brigadier’s intro.'},
 {file:'arc-exact-reference.mp3',name:'Arc · Original recording',description:'Your attached recording, unchanged.'},
];
function Preview(){
 const [started,start]=useState(false),[music,setMusic]=useState(true);
 const [sound,setSound]=useState(sounds[0].file);
 const chooseSound=async(next:string)=>{setSound(next);if(started)await launchApi.reset()};
 return <SoundContext.Provider value={sound}>
  {started?<Launch/>:<main className="preview-start">
   <p>Brigadier / Intro study</p><h1>Feel it come to life.</h1>
   <BrandMark className="preview-mark"/>
   <fieldset className="preview-sounds"><legend>Choose a soundtrack</legend>{sounds.map(option=><button key={option.file} aria-pressed={sound===option.file} onClick={()=>void chooseSound(option.file)}><strong>{option.name}</strong><small>{option.description}</small></button>)}</fieldset>
   <button className="preview-play" onClick={async()=>{await launchApi.reset();start(true)}}>Play intro · {sounds.find(option=>option.file===sound)?.name.split(' · ')[0]}</button>
   <p className="preview-note">The app’s monochrome palette. Spark glides up and stays.<br/>Arrival, with the existing intro sequence.</p>
  </main>}
  {started&&<nav className="preview-toolbar" aria-label="Appearance study controls"><span>Preview</span><select aria-label="Soundtrack" value={sound} onChange={e=>void chooseSound(e.target.value)}>{sounds.map(option=><option key={option.file} value={option.file}>{option.name}</option>)}</select><button onClick={()=>void launchApi.reset()}>Replay</button><button aria-pressed={!music} onClick={()=>{setMusic(!music);void launchApi.music(!music)}}>{music?'Mute':'Unmute'}</button><button onClick={()=>start(false)}>Compare</button></nav>}
 </SoundContext.Provider>
}
createRoot(document.getElementById('root')!).render(<Preview/>);
