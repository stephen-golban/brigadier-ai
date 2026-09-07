# Abstract mark exploration

The user rejected a letter-based logo and requested an original abstract mark, citing Arc and Dia as examples of recognizable app identities. The user selected Fold for the first trial and asked to retain Aperture for the next trial. Fold is now the vector master at `public/brand/fold.svg`; Aperture remains preserved on the board. The earlier Carved B assets are retained.

[Refined comparison board](assets/brigadier-abstract-mark-options.png), made with the built-in image-generation tool. Preview concepts only; selected geometry needs vector refinement and small-size verification.

1. Confluence: two organic masses around a flowing diagonal channel. Expressive, but more intricate.
2. Fold: two offset sculpted planes around a diagonal gap. Recommended for the simplest silhouette and compact app-icon shape.
3. Aperture: a soft enclosure with an off-center triangular opening. Closest tie to the cosmic reveal.

Prompt brief: three original non-letter marks for a premium macOS coding-agent workspace; solid ivory on navy; each repeated as a Dock tile and monochrome silhouette. Avoid monograms, AI sparkles, robots, knots, infinity symbols, and existing browser identities. The revision removed glow and gradients, replaced Fold's letter-like first draft with two offset curved quadrilateral planes, and replaced Aperture's browser-like swirl with an asymmetric enclosure and open triangular void. Final generation uses the first board as its edit reference. No concept is claimed to have undergone a trademark clearance search.

The intro sound button was removed per the user's request. Music preference remains in Settings; denied autoplay retries on the next ordinary interaction. Targeted frontend tests (16), browser onboarding flow and release build passed. Installed and relaunched `/Applications/Brigadier.app`; native accessibility confirms the intro contains no sound button.

Fold trial: the chosen two-plane silhouette was refined into `public/brand/fold.svg`; the intro/sidebar/empty state and generated platform icons use that master. Targeted frontend checks (16), full browser onboarding checks, and the macOS release build passed. Installed and relaunched the Fold trial with first-use progress reset and previous app/preferences backed up. The full-display backdrop replaces the previous work-area-sized opening window.

Aperture trial: user liked Fold and requested Aperture next. `public/brand/aperture.svg` is now active across the app and generated platform icons; Fold remains preserved. The button reveal now completes before becoming interactive and no longer jumps from disabled opacity. Seventeen targeted tests, the full browser onboarding flow, a sampled real animation continuity check, and release build passed. Installed the new app, backed up the previous bundle/preferences, and reset all three onboarding flags as explicitly requested.

## Fold selected after the Aperture trial

The owner preferred Fold after trying both. The shared intro/sidebar mark and generated platform icons now use `public/brand/fold.svg`; Aperture remains available as an alternate asset.

The greeting handoff now fades the cosmic field and greeting into a matching graphite surface, waits for native window geometry to settle, and then fades that surface away over the mounted workspace. The greeting stays in the tree during its departure, and App must commit through Suspense before departure begins. The native setters restore resizability before decorations; two main-queue barriers separate style restoration, frame measurement/resize, and the frontend completion response. See `docs/research/intro-window-controls-2026-09-07.md`.
