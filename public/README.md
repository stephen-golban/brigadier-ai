# Cosmic bridge assets

`brand/fold.svg` is the selected vector master. The superseded trials (`brand/aperture.svg`, `brand/carved-b.svg`, `brand/split-b-backup.svg`) were deleted on 2026-09-09; they are recoverable from git history. `brand/app-icon.svg` and the platform icons under `src-tauri/icons` are generated with `node scripts/generate-brand.mjs` from the Fold master. The concept comparison is preserved in `docs/plans/assets/brigadier-abstract-mark-options.png`.

`audio/welcome.m4a` is a 10-second edit of the original synthesized ambient score used in the approved motion concept, with a fade-out over its final 1.5 seconds. The interface also fades playback when leaving the intro. Normal app launches are silent. No audio or graphic asset was extracted from Arc's video.

The procedural light field lives in `src/components/CosmicField.tsx`. Its color formula and shape timing follow the approved Cosmic bridge study in `docs/plans/assets/cosmic-bridge-motion-reference.mp4`.
