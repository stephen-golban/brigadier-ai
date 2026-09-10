## Current decision — restored original intro

Restored the original Fold logo, platform icons, cosmic background, typography and animation from `61e8576`. Arrival remains the only intro change. The app stays dark-only. This preview now renders the restored production intro directly; earlier studies below are archived alternatives.

# Current intro, new appearance

## Light terminal variant

The user requested a variant with a light chevron and underscore. The preview defaults to `spark-light.svg`, using soft white `#f4f6ff` for the terminal glyphs. The builder derives both glyphs and the silhouette from the production compound path so geometry and gradient stay identical. A side-by-side comparison and an intro toolbar switch between transparent and light glyphs. This is a preview variant; the installed mark remains unchanged. The build passed and both marks were visually inspected in the browser.

## Reference gradient selected

The user rejected the pastel trials and selected the blue gradient shown on the Spark in the supplied board. The refined geometry now uses a vertical periwinkle-to-deep-blue gradient with stops `#8caeff`, `#3b76fb` at 54%, and `#1323f9`. Colors were guided by samples from the supplied Spark image, rather than the app's flat blue. The outer silhouette and transparent terminal cutouts remain unchanged.

The SVG is now displayed as a self-contained image in the shared component and startup HTML, keeping its gradient references inside its own document in WKWebView. The platform icon is generated from the same master. The native WebKit regression uses this same image-loading route and checks both the gradient and transparent cutouts. All five pixel checks passed; the native image and platform icon were visually inspected. The 21 launch/audio tests and production frontend build also passed. Arrival and the existing intro sequence remain unchanged.

## Color exploration after blue rejection

The user rejected the app blue and invited a different color without requiring a match to the app palette. The preview now offers Jade (`#91c9ae`, default), Coral (`#e5a092`), and Iris (`#b6a4df`). The attention token is overridden only within the review shell, so the exact production Spark geometry and intro can be compared without reinstalling each tentative choice. The native cutout correction and Arrival are retained. Production and installed-app color remain blue pending a selection. The preview rebuilt successfully and the three colors were visually inspected.

## Native cutout correction and app-blue Spark

The installed WKWebView showed a solid silhouette: its external SVG `<use>` rendered the mark but failed to resolve the nested mask. Spark now uses one compound path with `fill-rule="evenodd"`, preserving the original outer geometry and rounded terminal cutouts without mask references. The shared mark, startup mark and generated platform icons use the app's `--color-attention` blue, currently `#3b82f6`. This supersedes the monochrome logo choice below; the intro background remains dark and neutral, with Arrival unchanged.

`scripts/verify-brand-webkit.swift` reproduces the application's external SVG use through a native WKWebView `tauri://localhost` scheme. The old mask asset fails both cutout pixel checks. The new asset passes: Spark fill `[59,130,246]`, chevron and underscore `[24,24,24]`, matching the actual background. The PNG was visually inspected. This checks the native renderer rather than relying on the browser preview. Production frontend and macOS builds passed, and 21 launch/audio tests passed.

## Dark-only alignment with existing worktrees

The user pointed to the existing dark-only decision. Both `ui-design-system` and `burn-baseline` contain commit `af65dec` ("Vendor Apps SDK UI icons, go dark-only, cancel the bb thread port"). The active UI design-system worktree also enforces dark mode at first paint. This checkout was still on its parent `61e8576` when the intro was integrated.

Only the theme-removal portion of that commit was brought into this checkout: remove ThemeProvider/light tokens/settings selector and theme listeners from the existing renderers; fix first paint to dark and clear the stale stored theme. Its unrelated icon migration and ongoing design-system changes were not imported. Neither other worktree was modified. The newly added CosmicField theme listener and the preview theme toggle were also removed. This supersedes the light-mode implementation notes below. The neutral Spark, Arrival, and intro sequence are unchanged.

Verification: 27 tests passed across onboarding, audio, theme tokens, desktop settings and syntax highlighting. No production ThemeProvider references, theme-change event dependencies, or light palette block remain. Production frontend build passed.

## Applied to the app: monochrome Spark and Arrival

The user pointed out that the preview's gold palette did not exist in the app and asked about the actual app intro. The chosen Spark, Arrival soundtrack, persistent upward logo movement, and expanded headline spacing are now integrated in production source. This supersedes the earlier preview-only status below.

The current logo is monochrome and inherits `--color-text`. The full intro, including name entry and error states, uses the semantic colors in `src/index.css`. The animated field reads the canvas/text tokens as WebGL uniforms and refreshes on theme changes; dark and light modes keep the existing field motion. The startup HTML and shared BrandMark reference `public/brand/spark.svg`. The platform icon generator now uses that vector and reads its colors from the app stylesheet; platform icons were regenerated. The chosen audio is `public/audio/arrival.m4a`, byte-identical to the preserved Arrival backup.

The comparison harness now bundles the production Launch, intro CSS, CosmicField, and BrandMark directly, with no preview color or motion replacements. Its theme CSS is generated from the app's token blocks. Only the backend/workspace stubs and soundtrack comparison controls are specific to the preview. This keeps the preview and app appearance in sync.

Validation: TypeScript and Vite production build passed; 33 onboarding, audio-hook, theme-token, and theme-provider tests passed. The existing name-entry transition test now verifies that the same mark survives the welcome and crossfade and leaves at name entry. Browser inspection confirmed a fully opaque docked mark, a running WebGL field, and matching dark/light palettes. Generated platform icon was visually inspected. Vite reported dependency externalization and large-chunk warnings; no build failure.

## Final soundtrack choice: Arrival

The user chose Arrival after auditioning the alternatives. The preview now defaults to the unchanged `arrival.m4a`, labeled Arrival · Selected. Its byte-identical backup is retained. This supersedes the soundtrack defaults described in the historical notes below.

## Exact supplied Arc recording

The user rejected the synthesized approximation and requested Arc's exact sound, supplying a new file, `/Users/stephen/Downloads/Arc Browser Intro Music.mp3`. The preview now selects a byte-identical copy, `arc-exact-reference.mp3`, labeled Arc · Original recording. This is the supplied recording, not a newly synthesized recreation. Both files have SHA-256 `f027608399b96ec2af6376fd8f1e050c0f9a21ee0faea5117f22347f3b1d589a`. No trimming, retiming, or re-encoding was applied. `afinfo` estimates 21.838367 seconds, longer than the earlier supplied reference.

The existing audio hook plays it at the existing gain and fades it on leaving onboarding. Intro visuals and Continue timing are unchanged. Arrival remains available as the backup. Build succeeded, audio asset returns HTTP 200, and browser controls show the original Arc recording selected. This use is confined to the local appearance preview; no production assets were changed.

## Ignition refinement: no pulses, harmonic release

The user liked Ignition, requested removing its deep pulses, and wanted an ending similar to the supplied Arc reference. `ignition-release.m4a` is now selected. The repeated heartbeat layer and the sub-bass pitch drop are removed. The airy build is retained, followed by a soft breath and a new detuned Dmaj9 ensemble that decays into silence. The prior Ignition and Arrival backup assets remain preserved.

Reference analysis of the supplied decoded Arc file showed a stable low-mid harmonic tail (energy centroid approximately 272–280 Hz over seconds 9–12) and declining one-second RMS levels of -20.1, -24.5, and -32.0 dBFS. These broad properties inform the release; no reference samples were used. The reference comparison was signal analysis, not a perceptual listening test.

Reproducible source: `generate_ignition_release.py`. PCM peak -4.01 dBFS, RMS -21.99 dBFS, zero clipped samples. Encoded AAC has exactly 441,000 valid frames at 44,100 Hz (ten seconds); HTTP 200 and preview build verified. The browser shows Ignition · Refined selected. All changes are isolated preview audio and labels; visual sequence is unchanged.

## Ignition: contrasting sound direction

The user rejected Daybreak and requested a completely different option. Ignition now replaces it as the selected alternative; Daybreak's files remain archived here. Ignition uses tactile low pulses, a filtered air swell, a soft descending impact at the existing 4.032-second logo appearance, and a fading resonance under the headline. It has no plucked melody or changing chord bed. All material is synthesized locally by `generate_ignition.py`, with no reference audio samples.

`ignition.wav` is the master and `ignition.m4a` the encoded preview. The build succeeds and the asset returns HTTP 200. The AAC has exactly ten seconds of valid audio; PCM peak is -4.01 dBFS, RMS -19.77 dBFS, with zero clipped samples. Sound quality awaits user audition. Arrival's backup checksum remains unchanged. The intro visuals and timing retain the preceding revision.

## Headline spacing and second sound option

The latest preview opens the headline line height from 1.08 to 1.22 and tracking from -0.035em to -0.02em. The short-window rule now reduces the logo before reducing headline size; normal headline sizing is retained above 400px height. The logo docking offset accounts for the larger line height, with a 36px nominal gap on regular windows. Original word and button timing is retained.

Daybreak is a new, original ten-second synthesized sketch: damped string-like plucks, a reverse harmonic swell into the logo reveal, and a gentle high response with the headline. `generate_daybreak.py` is its reproducible source. `daybreak.wav` is the PCM master; `daybreak.m4a` is the preview AAC. Measured peak is -4.73 dBFS, RMS -16.89 dBFS, with zero clipped PCM samples. `afinfo` confirms 441,000 valid frames at 44,100 Hz, exactly ten seconds. Perceptual quality is for user audition.

The sound the user liked is preserved as `arrival.m4a` and the byte-identical `arrival-backup.m4a`. Both SHA-256 hashes are `1dbd6b9c6ff1929e9588b3b48de7b60f0a3391c1c0906e303cdfb3e4e96f858b`. The comparison page and intro toolbar select between Daybreak and Arrival (backup); switching during playback restarts the intro. `PreviewMusic.tsx` supplies the selected URL to the original audio hook. All changes remain isolated to this preview.

## Persistent logo on the welcome screen

The user requested keeping the logo visible when the headline arrives. In the current preview, Spark retains its original appearance at 4.032-4.788 seconds, then moves upward over 5.35-6.45 seconds. It stays above the headline and Continue button. The complete group is centered with clear spacing between logo and text; compact windows use smaller logo/type sizes. The original word stagger and Continue activation timing remain intact. On continuing to name entry, the logo leaves with the existing welcome crossfade. Reduced-motion behavior remains the existing immediate welcome.

The implementation is in the isolated `preview.css` override. Production `src/intro.css` and `src/Launch.tsx` remain unchanged. This supersedes earlier statements below that every original motion rule is retained.

## Spark refinement

The user preferred Spark, rejected the Codex-like blue, and described its side curves as pinched. The current preview now defaults to a refined Spark with fourfold symmetry, fuller shoulders, and a shallow waist. The terminal geometry is unchanged. Its new gradient runs from warm amber `#f3cb8c` to ochre `#d8914b`; the surrounding charcoal field receives a restrained warm tint. This palette is a proposed direction for review.

The comparison screen shows the prior blue Spark alongside the current amber Spark. `spark-before.svg` preserves the earlier geometry and color for comparison only. The source-generated vectors, not the older imagegen comparison board, are authoritative for this refinement. The original intro source, motion, and ten-second soundtrack are unchanged. The preview rebuilt successfully and both silhouettes were visually inspected in the browser.

The following notes record the preceding two-shape iteration.

The user likes the existing application intro sequence and wants only its background, sound, and logo changed. Both Rally and Spark outer shapes are candidates, now using the same rounded terminal chevron and underscore.

## Preview

Open [the current sequence with the revised appearance](http://127.0.0.1:8769/round-3/) using the earlier local server on port 8769. Choose a shape and Play current intro. The preview toolbar changes the mark, replays, and mutes. It is review tooling, not proposed production chrome.

`build.mjs` bundles the actual `src/Launch.tsx`, `src/intro.css`, `src/hooks/useMusic.ts`, `NameInput`, and existing controls. Build-time substitutions are restricted to the soundtrack URL, a preview BrandMark, and five background color expressions. `launchApi` and workspace content are replaced with in-memory preview stubs; this preview never writes user preferences, projects, or sessions.

The current sequence remains: orb emergence and expansion; logo at approximately 4-6 seconds; “Your next idea starts here.” with the original stagger; Continue becoming ready on its animation completion around 9.95 seconds; required name entry; 1.4-second greeting hold; 0.5-second workspace fade. All those transitions come from the original source. The final workspace is a labeled end-of-preview surface.

## Assets

- `rally.svg` and `spark.svg`: editable vector studies, manually reconstructed from the selected shape concepts, with identical terminal cutout geometry. Masks create true transparency. These approximate the generated shapes; they are not traced pixel-identical masters.
- `logo-comparison.png`: imagegen refinement of the earlier board, keeping the two preferred silhouettes and replacing their interiors with the terminal glyph. Exact prompt: `image-prompt.txt`. Generated through the built-in image generation tool.
- `arrival.m4a`: ten-second edit of the original synthesized Arrival sketch. Preserves pitch; removes its initial 0.4 seconds, takes the next ten seconds, adds a 0.25-second onset and 1.8-second cosine release. Arc is a reference only and is not used as the preview soundtrack.
- `arrival.wav` and `audio-metrics.json`: uncompressed edit and measured signal metrics. `afinfo` confirms the encoded AAC has exactly 441,000 valid frames at 44,100 Hz, or 10 seconds. The uncompressed edit has no clipped samples. Human listening approval is still pending.
- `preview.css`: appearance-only overrides to use the app's charcoal, neutral text, inputs, and controls. Original motion CSS is imported intact. `launch-preview.js` and `launch-preview.css` are generated browser outputs.

Rebuild from the repository root: `node docs/plans/brand-study-2026-09-10/round-3/build.mjs`.

## Verification

- Preview build succeeded. No production source or assets were changed.
- Browser inspection showed the initial two shape choices and the current headline/Continue sequence reaching its ready state, with the recolored WebGL background. Name entry received focus and the submitted name appeared in the existing greeting. No browser errors or warnings were recorded for that run.
- The original launch and audio-hook tests passed: 21 tests across two files.
- Not measured: native Tauri performance, exact audible/compositor synchronization, or perceptual sound quality. This is a reviewable appearance study while the final outer shape remains undecided.

Logo docking verification: preview build passed; at the ready welcome the logo remained fully opaque and above the headline. At 1280 x 500, the logo top was 94.52 px, logo-to-heading gap 16.36 px, and Continue ended at 409.11 px, all inside the viewport. Temporary viewport override was reset.

Latest verification: rebuilt successfully; both soundtrack assets return HTTP 200. Browser playback reached the ready welcome with Daybreak selected, and switching to Arrival restarted and reached the ready welcome. At 853 × 933 the headline is 52.886px with 64.52px line height and the logo-to-heading gap is 32.57px. At 1280 × 500 the headline stays 76px, the logo is 80px, and Continue ends at 438.66px, within the viewport. The temporary viewport override was reset, and the comparison page is left with Daybreak selected for audition. No production files changed.

Native validation: the local unsigned macOS release bundle also built successfully at `target/release/bundle/macos/Brigadier.app`; its executable exists. No installed application copy was replaced or running app restarted.
