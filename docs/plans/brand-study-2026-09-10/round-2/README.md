# Revised direction, 2026-09-10

The user rejected every first-round mark and supplied an image of the Codex badge: solid rounded mass, a blue gradient, and a terminal cutout. This corrects the earlier assumption that the reference was the interlaced OpenAI Blossom. The new concepts are Pilot, Rally, and Spark, generated with the built-in image generation tool using the supplied image as a style reference. Exact generation prompt: [image-prompt.txt](image-prompt.txt). These are exploratory raster concepts, not final vector masters.

## Sound reference

The user supplied `arc-browser-intro-music_Dwibsf6C.mp3`. `arc-reference.mp3` is a byte-identical copy for this local comparison. It is not included in the production application. No claim about authorship or music licensing is made.

**Measured:** macOS `afinfo` reports 44,100 Hz stereo MP3, estimated duration 12.408163 seconds. PCM decoded using macOS `afconvert` contains 12.37 seconds. The half-second mono RMS rises from approximately -40.3 dBFS at 0 seconds to -17.2 dBFS at 3 seconds, stays approximately -17 to -21 dBFS through the middle, then falls to -49.7 dBFS at 12 seconds. The 100 ms envelope is saved in [arc-analysis.json](arc-analysis.json).

**Interpretation:** the intro should follow a sustained build, a broad middle, and a closing release. This inference concerns measured dynamics. The agent did not verify instruments, exact musical transcription, or subjective timbre by listening.

**Original draft:** [Arrival](arrival.wav) uses newly synthesized detuned harmonic voices, slow amplitude changes, new F(add9)/Bbmaj7/F6/9 harmony, quiet filtered noise, and diffuse reflections. It takes the reference's broad duration and energy shape as direction. No Arc samples or melody were copied. It is a timbre/composition sketch that needs the user's listening feedback. Reproducible with Python and NumPy: [generate_arrival.py](generate_arrival.py).

**Measured:** Arrival is 12.4 seconds, stereo, 44,100 Hz, peak -4.73 dBFS, RMS -18.13 dBFS, zero clipped samples. These measurements do not establish perceptual quality or loudness matching. Playback in the concept is set to 70%.

## Intro study

Preview at [round two](http://127.0.0.1:8769/round-2/) using the original study's local server. Mark selection changes a CSS crop of the generated board. The cream stage follows the app's light palette; blue appears in the mark and a temporary soft field. Motion follows audio playback time, or a monotonic clock in silent mode.

Proposed beats: shape emerges over 0.2-3.3 seconds; name appears at 3.4-5 seconds; invitation at 7.2-8.8 seconds; Begin at 9-10.4 seconds; sound ends at about 12.4 seconds. Skip, silent preview, reduced motion, and a local-only name/greeting flow are included. This is a visual/audio study rather than the production onboarding state machine.

Web Audio and reduced motion research remains in [the reference note](../../../research/brand-intro-2026-09-10.md). The first-round design recommendation in that note is superseded by the user's attached Codex image. Current implementation uses native HTML audio controls so the user can audition both files directly.

Verification records are in [verification.md](verification.md). No production files were changed.
