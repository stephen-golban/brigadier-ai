"""Original ten-second plucked-resonator sketch; no reference audio samples."""
from pathlib import Path
import json, wave
import numpy as np
ROOT = Path(__file__).parent
SR = 44100
DURATION = 10
N = SR * DURATION
t = np.arange(N) / SR
rng = np.random.default_rng(91027)
mix = np.zeros((N, 2))

def smooth(a, b):
    x = np.clip((t-a)/(b-a), 0, 1)
    return x*x*(3-2*x)

# A sparse D6/9 figure, using damped, slightly inharmonic string resonators.
# The octave opens with the mark; a soft high answer meets the headline.
notes = [(0.12, 50, .6, -.15), (.38, 62, .42, -.4), (1.15, 69, .25, .4),
         (2.25, 76, .18, -.25), (4.03, 57, .31, .1), (4.07, 66, .26, -.3),
         (4.16, 74, .21, .35), (6.45, 78, .13, -.2), (6.72, 81, .075, .4)]
for at, note, level, pan in notes:
    x = np.maximum(t-at, 0)
    f = 440 * 2**((note-69)/12)
    voice = np.zeros(N)
    for h in range(1, 10):
        decay = (3.7 if note < 60 else 2.9) / h**.62
        envelope = (1-np.exp(-x/.012)) * np.exp(-x/decay) * (t >= at)
        # Soft felt-like attacks and sympathetic beating, without a metallic bell hit.
        freq = f * h * np.sqrt(1 + .00009*h*h)
        voice += np.sin(2*np.pi*freq*x) * envelope * np.exp(-h/3.2)/h**1.3
        voice += .18*np.sin(2*np.pi*freq*1.0008*x) * envelope / h**2
    mix[:, 0] += voice*level*np.sqrt((1-pan)/2)
    mix[:, 1] += voice*level*np.sqrt((1+pan)/2)

# Reverse light gathers into the logo reveal, then resolves into a quiet halo.
for c in range(2):
    for note in [62,69,76,81]:
        f=440*2**((note-69)/12)
        phase=2*np.pi*f*t+rng.uniform(0,2*np.pi)
        swell=smooth(1.6,4.03)*(1-smooth(4.03,5.2))
        mix[:,c] += .018*np.sin(phase+.012*np.sin(t*2+c))*swell
    air=np.convolve(rng.normal(size=N),np.ones(110)/110,mode='same')
    mix[:,c] += air*.028*smooth(.7,3.8)*(1-smooth(4.1,7.5))

# Diffuse stereo room, created only from the new resonator signal.
wet=np.zeros_like(mix)
for delay in np.linspace(.043,2.5,52):
    for c in range(2):
        shift=round((delay+c*.011)*SR)
        wet[shift:,c]+=mix[:-shift,1-c]*.065*np.exp(-delay/1.15)
mix += wet
mix -= mix.mean(axis=0)
mix *= (smooth(0,.055)*(1-smooth(8.0,10)))[:,None]
mix *= .58 / np.abs(mix).max()
with wave.open(str(ROOT/'daybreak.wav'),'wb') as w:
    w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR)
    w.writeframes((mix*32767).astype('<i2').tobytes())
metrics={'duration':DURATION,'sample_rate':SR,'peak_dbfs':round(float(20*np.log10(abs(mix).max())),2),'rms_dbfs':round(float(20*np.log10(np.sqrt(np.mean(mix**2)))),2),'clipped_samples':int(np.sum(abs(mix)>=1))}
(ROOT/'daybreak-metrics.json').write_text(json.dumps(metrics,indent=2)+'\n')
print(metrics)
