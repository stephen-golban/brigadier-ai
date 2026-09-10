# Brigadier brand assets

`brand/striped-disc.svg` is the selected vector master (owner decision, 2026-09-10). It reconstructs the approved striped-disc raster as a solid core with fifteen vertical strokes. It uses `currentColor` and a transparent background for the shared app mark and first-paint loading mark. `brand/app-icon.svg` and the platform icons under `src-tauri/icons` are generated with `node scripts/generate-brand.mjs`. The app icon uses the intro’s solid charcoal canvas (`#181818`). The prior Fold master is retained as an archived alternative. Converge remains a favorite in `docs/plans/brand-study-2026-09-10/favorites/converge/`. The approved raster and its source reference are preserved in `docs/plans/brand-study-2026-09-10/round-6-striped-disc/`.

`audio/arrival.m4a` is the selected soundtrack. The interface fades playback when leaving the intro. Normal app launches are silent.

The current intro uses `src/components/IntroDisc.tsx` to animate the fifteen `stripe-*` fragments and `disc-core` from the same vector master. `src/components/SignalField.tsx` supplies a faint echo of the vertical strokes. Motion is finite CSS in `src/intro.css`; the settled scene is static. The prior CosmicField renderer is retained for the archived studies.
