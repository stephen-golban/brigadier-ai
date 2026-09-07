# Intro typography and keyboard refinement

- [MDN font-family](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-family), checked 2026-09-07: `ui-rounded` selects the platform UI font with rounded features. The intro requests it with SF Pro Rounded/system fallbacks; no external font download. Actual family is platform-dependent.
- [MDN aria-keyshortcuts](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-keyshortcuts), checked 2026-09-07: shortcut metadata describes the binding; application code must implement it. Enter advances the ready welcome, ignoring composition, repeats, modifiers, and focused controls whose native keyboard handling should remain intact.

Design choices: 128px mark (was 70px), headline up to 76px (was 46px), two deliberate lines, clipped word reveal with staggered upward motion and blur, 48px-high Continue with visible Enter hint. Required-name behavior is preserved.

Verification: 266 frontend tests passed, release build passed, browser integration passed including Enter, required name, Settings and reduced motion. Animation capture confirmed the 128px logo and different word opacities during the staggered reveal. Installed to `/Applications/Brigadier.app` with verified local ad-hoc signature; previous bundle and onboarding preferences backed up before resetting the first-use preview.

Follow-up: welcome uses the same Continue button class and arrow as name entry, with Enter hint below. Name headline remains one line at 1280px and 800px, input is 340×48px with 16px corners and no focus outline/shadow. Verified equal button styles, focused input appearance, full browser flow, 16 targeted tests, and release build. Installed locally with backup.

Final copy adjustment: removed the visible Press Enter helper; retained the working Enter binding and accessibility metadata. Browser verification passed for both removal and keyboard continuation.
