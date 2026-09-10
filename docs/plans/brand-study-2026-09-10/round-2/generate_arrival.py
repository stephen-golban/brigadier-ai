"""Original sustained sound study; no samples or copied melody.

The supplied Arc file informs the broad energy envelope only.
"""
from pathlib import Path
import json
import wave
import numpy as np

ROOT = Path(__file__).parent
SR, DURATION = 44100, 12.4
t = np.arange(round(SR * DURATION)) / SR
rng = np.random.default_rng(9102026)
mix = np.zeros((len(t), 2))

def smooth(start, end):
    x = np.clip((t-start)/(end-start), 0, 1)
    return x*x*(3-2*x)

# New harmony: F(add9) opens to Bbmaj7, then settles into F6/9.
chords = [(0, [41,53,60,67,69], 0.9), (3.1, [46,53,57,65,69], 0.65), (7.9, [41,53,60,62,67], 0.85)]
for index, (at, notes, level) in enumerate(chords):
    envelope = smooth(at, at+1.7)
    if index < len(chords)-1:
        envelope *= 1-smooth(chords[index+1][0], chords[index+1][0]+2.3)
    for ni, note in enumerate(notes):
        frequency = 440*2**((note-69)/12)
        for c in range(2):
            voice=np.zeros_like(t)
            for cents in [-6.5, -1.8, 2.4, 6.1]:
                f=frequency*2**((cents+(c-.5)*1.3)/1200)
                phase=2*np.pi*f*t+.018*np.sin(2*np.pi*.23*t+ni+c)
                for h in range(1,14):
                    # Warm ensemble spectrum; upper harmonics emerge with the swell.
                    weight=(1/h**1.65)*np.exp(-h/(3+5*smooth(.5,3.5)))
                    voice += np.sin(h*phase+rng.uniform(0,2*np.pi))*weight
            movement=1+.09*np.sin(2*np.pi*(.15+ni*.019)*t+c*1.3)
            mix[:,c] += voice*envelope*movement*level*.022/(1+ni*.10)

# Quiet, slow air and an upper octave bloom; no note attacks or percussion.
for c in range(2):
    air=np.convolve(rng.normal(size=len(t)),np.ones(75)/75,mode='same')
    mix[:,c]+=air*.06*smooth(.15,2.8)*(1-smooth(7.4,10))
    bloom=np.sin(2*np.pi*698.456*t+.02*np.sin(t*1.8+c))
    mix[:,c]+=bloom*.008*smooth(2,4)*(1-smooth(5.5,9))

# Diffuse reflections are formed from this new synthesized material.
wet=np.zeros_like(mix)
for delay in np.linspace(.061,1.9,28):
    for c in range(2):
        shift=round((delay+c*.008)*SR)
        wet[shift:,c]+=mix[:-shift,1-c]*.075*np.exp(-delay/1.0)
mix += wet
envelope=(.035+.965*smooth(0,3.0))*(1-smooth(9.3,DURATION))
mix*=envelope[:,None]
mix-=mix.mean(axis=0)
mix*=np.minimum(1,t/.025)[:,None]*np.minimum(1,(DURATION-t)/.04)[:,None]
mix*=.58/abs(mix).max()
with wave.open(str(ROOT/'arrival.wav'),'wb') as w:
    w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR)
    w.writeframes((mix*32767).astype('<i2').tobytes())
metrics={'duration':DURATION,'sample_rate':SR,'peak_dbfs':round(float(20*np.log10(abs(mix).max())),2),'rms_dbfs':round(float(20*np.log10(np.sqrt(np.mean(mix**2)))),2),'clipped_samples':int(np.sum(abs(mix)>=1))}
(ROOT/'arrival-metrics.json').write_text(json.dumps(metrics,indent=2)+'\n')
print(metrics)
