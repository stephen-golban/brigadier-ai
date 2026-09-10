"""Original cinematic sound-design sketch: pulse, breath, impact, dissipating air.
No samples, melody, plucked notes, or chord progression. Deterministic synthesis.
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

# A slow, tactile heartbeat gathers energy, audible on laptop speakers as well.
for onset, level in [(.2,.23),(1.5,.27),(2.65,.31),(3.45,.24)]:
    x=np.maximum(t-onset,0)
    phase=2*np.pi*(86*x+31*.055*(1-np.exp(-x/.055)))
    env=(1-np.exp(-x/.014))*np.exp(-x/.28)*(t>=onset)
    pulse=(np.sin(phase)+.31*np.sin(phase*2)+.12*np.sin(phase*3))*env*level
    for c in range(2):mix[:,c]+=pulse

# Broad, moving breath sweeps upward toward the existing logo reveal at 4.032s.
for c in range(2):
    low=texture(160,950)
    high=texture(900,4800)
    rise=smooth(.6,3.98)*(1-smooth(4.03,4.7))
    movement=.78+.22*np.sin(t*3.0+c*1.7)
    mix[:,c] += (low*.045+high*.025*smooth(1.8,3.9))*rise*movement

# Soft cinematic impact: a low pitch drop plus a diffuse, papery air transient.
x=np.maximum(t-4.032,0)
impact_phase=2*np.pi*(55*x+65*.12*(1-np.exp(-x/.12)))
impact_env=(1-np.exp(-x/.01))*np.exp(-x/1.3)*(t>=4.032)
body=(np.sin(impact_phase)+.28*np.sin(impact_phase*2)+.15*np.sin(impact_phase*3))*impact_env
for c in range(2):
    air=texture(260,3200)
    exhale=(1-np.exp(-x/.06))*np.exp(-x/.75)*(t>=4.032)
    mix[:,c]+=.40*body+.035*air*exhale

# A low, open resonance hangs below the headline; no tune or chord changes.
for c in range(2):
    for frequency, gain in [(110,.026),(220.25,.009),(329.4,.006)]:
        phase=2*np.pi*frequency*t+.008*np.sin(t*.9+c)
        mix[:,c]+=np.sin(phase+c*.25)*gain*smooth(3.7,4.6)*(1-smooth(6.4,9.6))
    mix[:,c]+=texture(500,2400)*.008*smooth(5.2,6.4)*(1-smooth(7.1,9.5))

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
with wave.open(str(ROOT/'ignition.wav'),'wb') as w:
    w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR)
    w.writeframes((mix*32767).astype('<i2').tobytes())
metrics={'duration':DURATION,'sample_rate':SR,'peak_dbfs':round(float(20*np.log10(abs(mix).max())),2),'rms_dbfs':round(float(20*np.log10(np.sqrt(np.mean(mix**2)))),2),'clipped_samples':int(np.sum(abs(mix)>=1))}
(ROOT/'ignition-metrics.json').write_text(json.dumps(metrics,indent=2)+'\n')
print(metrics)
