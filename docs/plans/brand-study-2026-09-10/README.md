# Brigadier: a new beginning

Exploratory brand, intro, and sonic direction, 2026-09-10. Recommendation: **Weave + First Light**.

The user likes ChatGPT's logo and Arc's introductory sound. The proposed Brigadier identity expresses independent threads working toward one intention, using interlaced geometry, warm ivory, the app's charcoal background, and its existing system typography. These are design judgments, not audience-tested findings.

## Preview

From the repository root:

```sh
python3 -m http.server 8769 --bind 127.0.0.1 --directory docs/plans/brand-study-2026-09-10
```

Open [the concept](http://127.0.0.1:8769). Select a mark and sound, then Play introduction. Audio requires HTTP serving; opening the HTML directly from the filesystem can block the audio fetch.

The study contains three editable vector marks and three original 8.6-second stereo WAV sketches. `generate_audio.py` reproduces the sound files using NumPy and Python's WAV writer. No third-party recording or sample is used. SVGs are concept exports with background-colored weaving gaps; final production artwork should convert these gaps into transparent cutouts and receive optical refinement at small sizes.

## Proposed sequence

| Time | Visual | Audio intention |
| --- | --- | --- |
| 0-0.5 s | A quiet charcoal field | A breath of air and low warmth |
| 0.5-3.15 s | Two threads approach and interlace | Sparse notes open the space |
| 3.15-4.2 s | Mark settles; Brigadier appears | Shared chord resolution |
| 4.2-6.2 s | Personal invitation and action appear | Warm decay |
| 6.2-8.6 s | Ready for name entry | Tail settles to silence |

The invitation is “Your ideas. In good company.” Name entry leads to “Welcome, [name].” The prototype stores nothing and ends there. Proposed product behavior: full ceremony only on first use, quiet repeat launches, optional replay, visible skip and sound controls. Existing production onboarding is unchanged.

First Light is the warmest luminous direction; Open Water uses longer rounded glass-like tones; Homecoming is closer and more melodic. These timbre descriptions are composition intentions. Final selection and mix need human listening on headphones and speakers.

## Verification

- **Measured:** all WAVs are 44,100 Hz stereo, 8.6 seconds, peak -5.04 dBFS, with zero clipped samples. RMS values are in `audio-metrics.json`; no perceptual loudness claim is made.
- **Observed in browser:** first-light playback progressed to completion, replay control appeared, and no console error was recorded for that run. Silent reduced-motion playback, light/dark appearance, name entry, and personal greeting were exercised.
- **Observed visually:** desktop and narrow previews. At a 390 px viewport, document scroll width equals 390 px after correcting grid minimum sizing.
- **Checked:** JavaScript syntax parses; three SVG studies export from the preview's same mark definitions.
- **Not checked:** audible fidelity by the agent, actual Arc audio comparison, all sound choices in-browser, audio-fetch failure injection, native Tauri playback/performance, or production onboarding regression tests. No production code was changed.

Reference facts and documented browser interfaces: [research note](../../research/brand-intro-2026-09-10.md).
