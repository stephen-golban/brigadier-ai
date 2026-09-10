# Striped-disc introduction

Owner request: redesign the app intro to match the selected striped-disc logo.

## Quiet continuation hint

At the owner's request, the welcome action now reads “Press Enter to continue” as muted text with a slightly brighter Enter key. It retains native button semantics, a 42 px hit area, visible keyboard focus, the existing Enter shortcut and animation-completion gate. The name-entry form retains its submit button. The final headline-to-hint gap is 24 px on desktop (reduced by 8 px); compact windows use 16 px. The approved backup is unchanged. Preview build, all 23 launch/audio tests, and diff whitespace checks passed; browser inspection confirmed the text treatment, Tab focus and Enter activation.

## Headline refinement after approval

The approved introduction is preserved in `docs/plans/brand-study-2026-09-10/backups/striped-disc-approved-2026-09-11/`, including portable compiled assets, soundtrack, logo and seven hashed source snapshots. All seven snapshot hashes were verified before this refinement.

The current headline uses positive `0.005em` letter spacing and `0.09em` word spacing. At widths of at least 1100 px and heights above 600 px, both phrases share one line. Compact windows retain two lines. The disc's vertical travel adjusts to the shorter desktop composition; animation timings are unchanged. Preview rebuild and diff whitespace checks passed; the single-line 1280 × 800 and compact 800 × 468 layouts were visually inspected.

## Audit and direction

The prior intro expanded a blue procedural orb into a continuously animated cosmic field. The logo appeared briefly and faded away before staggered welcome copy and a Continue action at 9.95 seconds. Blue form controls and rounded display typography belonged to that earlier appearance.

The new design uses the app's neutral color tokens and font, the selected disc as its central image, and finite motion. Preserve the logo geometry, welcome copy, Arrival soundtrack, required name entry, keyboard shortcuts, saved progress, replay/reset, and backend/workspace readiness gates. Design judgment: restrained symmetry, moderate motion, low density (5/5/2).

## Sequence

- 0.3–3.3 seconds: fifteen strokes arrive from alternating vertical offsets and contract into their exact positions in the logo.
- 2.1–3.4 seconds: the existing core fades into place.
- 3.5–5 seconds: the disc moves up and scales down into its persistent position above the headline.
- 4.5–6.21 seconds: the existing headline resolves word by word.
- 6.15–7 seconds: Continue appears. Its own animation completion enables it.
- The final scene is static. Name entry and the greeting retain a smaller disc and the same monochrome background.

`IntroDisc.tsx` references named fragments in `public/brand/striped-disc.svg`; no duplicated logo geometry. `SignalField.tsx` uses fifteen CSS lines and no WebGL or animation loop. `src/intro.css` owns all motion. Research: `docs/research/striped-disc-intro-2026-09-11.md`.

Reduced motion renders the logo and action immediately. Escape settles the welcome without bypassing name entry. Nested stripe animation completion cannot unlock Continue. Existing persistence/error/readiness transitions are retained.

## Verification

- Measured: all 23 launch/audio tests passed, including reduced-motion logo visibility, fragment-event isolation, Escape, and preserving the disc through the name-entry crossfade.
- Measured: production frontend build passed (TypeScript and Vite); existing dependency-externalization and chunk-size warnings remain.
- Observed: browser preview renders the resolved logo and enabled Continue; 800 × 468 viewport fits the full composition and reset control.
- Observed: Escape settles the scene immediately; name entry receives focus after its transition; submitting the preview name displays the matching greeting and disc.
- Release verification, 2026-09-11: 811 Rust tests passed (12 ignored), 600 frontend tests passed; Clippy, rustdoc, TypeScript and the full Tauri app/DMG build exited 0. Cargo is available at `~/.rustup/toolchains/stable-aarch64-apple-darwin/bin`, outside the current PATH. Native timing and installation verification follow below.

Rebuild the isolated preview with `node docs/plans/brand-study-2026-09-10/round-3/build.mjs`. Serve `docs/plans/brand-study-2026-09-10` and open `/round-3/`. The preview uses production UI and in-memory onboarding/workspace stubs.

## Native verification — 2026-09-11

All six functional/build gates passed: 811 Rust tests (12 ignored), 600 frontend tests, Clippy, rustdoc, TypeScript and the standard app/DMG build. The production app was ad-hoc signed and `codesign --verify --deep --strict` exited 0.

The first startup run measured 308.47 ms p50 and failed the 295 ms threshold; the uninterrupted repeat passed at 270.62 ms p50 (ten launches each). Two rendering captures lost visibility and are invalid (2,552 and 198 missed opportunities). A third capture, raised during preparation before the unchanged workload, remained visible and delivered every event. It failed the zero-drop criterion: 3 missed 60 Hz opportunities over 63.555 seconds, 43 ms worst interval. No timing sample was filtered. Raw results are in `docs/performance/2026-09-11/`. The existing shipped baseline recorded 2 misses; these runs do not establish that the intro caused the difference.
