# Intro animation handoff

The user observed the welcome button snapping into view. Two source-level causes were identified: a 9700ms wall-clock timer removed the CSS animation irrespective of its actual playback, and the shared disabled-button rule held the button at 0.4 opacity until it became enabled.

The welcome now becomes interactive on the action wrapper's own `welcome-button-reveal` animation-end event. Nested word animation events cannot trigger the handoff. The button remains at opacity 1 internally while its wrapper performs the complete 900ms fade/blur/rise, so enabling it adds no second opacity jump. Reduced motion and the existing Escape fast-forward still enter the ready state directly.

[MDN animationend](https://developer.mozilla.org/en-US/docs/Web/API/Element/animationend_event), checked 2026-09-07: fires on animation completion, not when an animation is removed or aborted. The wrapper stays mounted through the cinematic-to-ready transition. A regression test advances wall-clock time without completing the animation and verifies the button remains gated until its own completion event.
