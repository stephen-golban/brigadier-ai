# Cosmic bridge implementation — 2026-09-06

Implemented following the user's final “Yes, do it!” approval in the [design discussion](intro-redesign-discussion-2026-09-06.md).

## Delivered

- Procedural cobalt/violet light on deep navy, organic reveal into one transparent native window, Carved B reveal, staggered “Your next idea starts here.” text, and a compact continuation arrow. Rendering accounts for display density, reduced motion, hidden first paint, and WebGL failure.
- Required name entry before workspace/project setup. Empty and whitespace-only values cannot advance; native storage also rejects control characters and oversized values. No name Skip option. Interrupted onboarding resumes at name entry.
- Explicitly confirmed name stored locally in the existing workbench preferences, used only by interface greetings, editable and still required in Settings. Existing environment-derived names do not silently count as confirmation.
- Primary Carved B vector, generated platform icons, and retained Split B backup. Restrained related accents in the existing graphite workspace.
- Original finite welcome and return audio, persistent music toggle, replay from Settings, and an explicit playback retry when autoplay is denied.
- Backend initialization proceeds while the introduction paints. Startup failures show recovery controls; the workspace opens only after required profile completion and backend readiness. Quit during initialization prevents late state publication.

## Verification

- Frontend: **22 test files, 265 tests passed** (`npm test -- --run`). Seven new onboarding tests cover required name, persistence handoff, interruption, save failure/retry, backend readiness, startup failure, and replay.
- Native: **67 tests passed** (`cargo test -p brigadier --lib`), including required profile validation, persistence without overwriting unrelated preferences, and pending/shutdown lifecycle tests.
- Production frontend and macOS release app build passed (`npm run tauri build -- --bundles app`). Vite retains a large-chunk advisory; Tauri retains the existing bundle-identifier advisory.
- Browser integration: actual shader, complete name flow, saved profile, returning launch, Settings name validation/edit, music preference on replay, and immediate reduced-motion flow at 800×500 with device scale 2. `scripts/verify-intro.cjs` runs against the dev server on port 1420 and requires Playwright.
- Native QA used an isolated identifier (`ai.brigadier.cosmicqa.20260906a`), preserving the installed app's data. Verified shader first paint, whitespace-disabled Continue, saved name, personalized greeting, restored 1280×800 workspace, automatic repository picker, Settings name validation/edit, persisted music toggle, and replay controls. The stale music preference caught during native replay was corrected and verified by the browser integration check.
- Source audit found profile-name reads confined to preference APIs and interface components, with no name added to agent prompts or context.

## Native playback limitation

The native automation session reported `document.hidden = true`; animation frames and CSS animations were suspended. The first frame now paints independently of that state, and the welcome stage redraws the completed field. The tool subsequently explicitly reported that the Mac was locked. A foreground native motion/audio playthrough and final relaunch inspection remain unverified until the Mac is unlocked. Browser animation and native end-state captures are evidence for their respective surfaces, not a substitute for that remaining check. Audio playback was not verified by listening.

## Artifacts

- Release application: `target/release/bundle/macos/brigadier.app` (built, not installed over the currently installed app).
- [Implemented welcome](assets/cosmic-bridge-implemented-welcome.png)
- [Implemented required name](assets/cosmic-bridge-implemented-name.png)
- [Implemented workspace](assets/cosmic-bridge-implemented-workspace.png)

These three images are browser captures of the implementation. The original selected motion concept and monogram comparison board remain in `assets/`. Asset provenance is in `public/README.md`.
