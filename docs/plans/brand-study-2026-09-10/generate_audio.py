"""Original sound sketches. Run with Python + NumPy; no recordings or samples.

WAV interface: https://docs.python.org/3/library/wave.html
Design rationale: ../../research/brand-intro-2026-09-10.md
"""
from pathlib import Path
import json
import wave
import numpy as np

ROOT = Path(__file__).parent
SR, LENGTH = 44100, 8.6
N = round(SR * LENGTH)
rng = np.random.default_rng(20260910)

def tone(midi, duration, kind="felt"):
    t = np.arange(round(duration * SR)) / SR
    f = 440 * 2 ** ((midi - 69) / 12)
    y = np.zeros_like(t)
    for partial, level in [(1, 1), (2, .22), (3, .095), (4, .025), (7, .008)]:
        decay = (2.6 if kind == "felt" else 4.1) / partial ** .65
        detune = 1 + .00018 * partial * partial
        y += level * np.sin(2*np.pi*f*partial*detune*t) * np.exp(-t/decay)
    attack = 1 - np.exp(-t / (.013 if kind == "felt" else .08))
    return y * attack * np.minimum(1, (duration-t)/.25)

def render(name, notes, chord, color):
    dry = np.zeros((N, 2))
    def add(signal, at, amplitude, pan=0):
        start = round(at * SR)
        count = min(len(signal), N-start)
        gains = np.array([np.cos((pan+1)*np.pi/4), np.sin((pan+1)*np.pi/4)])
        dry[start:start+count] += signal[:count, None] * gains * amplitude
    # A barely audible air texture and tonal swell suggest an opening space.
    t = np.arange(N) / SR
    air = np.convolve(rng.normal(0, 1, N), np.ones(110)/110, mode="same")
    inhale = np.sin(np.pi*np.clip(t/3.1, 0, 1)) ** 2
    add(air*inhale, 0, .055)
    for note in chord:
        pad = np.sin(2*np.pi*(440*2**((note-81)/12))*t + .006*np.sin(t*2.1))
        env = (1-np.exp(-t/1.3))*np.exp(-np.maximum(t-3.1,0)/1.5)
        add(pad*env, 0, .018, -.25 if note%2 else .25)
    for at, note, amp, pan in notes:
        add(tone(note, min(6, LENGTH-at), color), at, amp, pan)
    # Shared resolution at 3.15 s binds every score to the same visual gesture.
    for i, note in enumerate(chord):
        add(tone(note, 5.4, color), 3.15+i*.025, .10/(1+i*.15), (i-1.5)*.2)
    # Deterministic diffuse stereo reflections, with a softened reverb input.
    wet = np.zeros_like(dry)
    for c in range(2):
        blurred = np.convolve(dry[:,c], np.ones(24)/24, mode="same")
        for delay in [.071,.113,.179,.257,.347,.463,.619,.811,1.037,1.291,1.597,1.943,2.327]:
            shift = round((delay + c*.009)*SR)
            wet[shift:,1-c] += blurred[:-shift]*.095*np.exp(-delay/1.25)
    mixed = dry + wet
    mixed -= mixed.mean(axis=0)
    fade = np.clip((LENGTH-t)/1.6,0,1) ** 1.5
    mixed *= fade[:,None] * np.clip(t/.05,0,1)[:,None]
    mixed *= .56 / np.max(np.abs(mixed))
    out = ROOT / f"{name}.wav"
    with wave.open(str(out), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(SR)
        wav.writeframes((mixed*32767).astype("<i2").tobytes())
    return {"file":out.name,"seconds":LENGTH,"sample_rate":SR,"peak_dbfs":round(float(20*np.log10(np.max(np.abs(mixed)))) ,2),"rms_dbfs":round(float(20*np.log10(np.sqrt(np.mean(mixed**2)))) ,2),"clipped_samples":int(np.sum(np.abs(mixed)>=1))}

stats = [
    render("first-light", [(.65,62,.13,-.55),(1.45,69,.12,.45),(2.25,76,.105,-.15),(3.15,78,.08,.2)], [50,57,66,73], "felt"),
    render("open-water", [(.85,60,.10,-.6),(1.9,67,.09,.6),(2.65,74,.07,-.25)], [48,55,62,64], "glass"),
    render("homecoming", [(.5,65,.14,-.3),(1.3,69,.115,.35),(2.15,72,.10,-.1),(3.15,67,.08,.1)], [41,53,60,69], "felt"),
]
(ROOT / "audio-metrics.json").write_text(json.dumps(stats, indent=2)+"\n")
print(json.dumps(stats, indent=2))
