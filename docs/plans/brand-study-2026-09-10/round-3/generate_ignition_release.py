"""Ignition refinement: breath, a soft reveal, warm harmonic release.
No reference samples or repeated bass pulses. Deterministic synthesis.
"""
from pathlib import Path
import json, wave
import numpy as np
ROOT = Path(__file__).parent
SR, DURATION = 44100, 10
N = SR * DURATION
t = np.arange(N) / SR
rng = np.random.default_rng(10629)
mix = np.zeros((N, 2))

def smooth(a, b):
    x = np.clip((t-a)/(b-a), 0, 1)
    return x*x*(3-2*x)

def texture(low, high):
    frequencies = np.fft.rfftfreq(N, 1/SR)
    spectrum = np.fft.rfft(rng.normal(size=N))
    band = np.exp(-(frequencies/high)**4) * (1-np.exp(-(frequencies/low)**4))
    signal = np.fft.irfft(spectrum*band/np.sqrt(np.maximum(frequencies,low)),n=N)
    return signal/np.sqrt(np.mean(signal**2))

# Broad, moving breath sweeps upward toward the existing logo reveal at 4.032s.
for c in range(2):
    low=texture(160,950)
    high=texture(900,4800)
    rise=smooth(.6,3.98)*(1-smooth(4.03,4.7))
    movement=.78+.22*np.sin(t*3.0+c*1.7)
    mix[:,c] += (low*.045+high*.025*smooth(1.8,3.9))*rise*movement

# Keep the reveal as a soft breath, without the previous sub-bass pitch drop.
x=np.maximum(t-4.032,0)
for c in range(2):
    air=texture(260,3200)
    exhale=(1-np.exp(-x/.06))*np.exp(-x/.75)*(t>=4.032)
    mix[:,c]+=.035*air*exhale

# The supplied reference's last seconds have a stable low-mid harmonic tail
# and falling level. Use that broad behavior with a new Dmaj9 voicing.
# A warm ensemble blooms under the mark, then releases without a final hit.
release=np.exp(-np.maximum(t-7.05,0)/.88)*(1-smooth(9.25,10))
for c in range(2):
    for note, gain in [(50,.038),(54,.032),(57,.026),(61,.016),(64,.009)]:
        frequency=440*2**((note-69)/12)
        voice=np.zeros(N)
        for cents in [-4.5,4.5]:
            f=frequency*2**((cents+(c-.5)*1.4)/1200)
            phase=2*np.pi*f*t+rng.uniform(0,2*np.pi)
            for h in range(1,6):
                voice+=np.sin(phase*h+.012*np.sin(t*1.2+c))*.5/h**2.3
        mix[:,c]+=voice*gain*smooth(3.65,5.4)*release
    mix[:,c]+=texture(500,2400)*.004*smooth(5.2,6.4)*release

# Stereo diffusion extends the impact into the quiet landing.
wet=np.zeros_like(mix)
for delay in np.linspace(.057,1.85,43):
    for c in range(2):
        shift=round((delay+c*.013)*SR)
        wet[shift:,c]+=mix[:-shift,1-c]*.045*np.exp(-delay/1.0)
mix+=wet
mix-=mix.mean(axis=0)
mix*=(smooth(0,.06)*(1-smooth(8.4,10)))[:,None]
mix*=.63/np.abs(mix).max()
with wave.open(str(ROOT/'ignition-release.wav'),'wb') as w:
    w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR)
    w.writeframes((mix*32767).astype('<i2').tobytes())
metrics={'duration':DURATION,'sample_rate':SR,'peak_dbfs':round(float(20*np.log10(abs(mix).max())),2),'rms_dbfs':round(float(20*np.log10(np.sqrt(np.mean(mix**2)))),2),'clipped_samples':int(np.sum(abs(mix)>=1))}
(ROOT/'ignition-release-metrics.json').write_text(json.dumps(metrics,indent=2)+'\n')
print(metrics)
