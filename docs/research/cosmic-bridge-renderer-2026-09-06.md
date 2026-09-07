# Cosmic bridge renderer

Implementation references verified 2026-09-06:

- [WebGLRenderingContext](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext): canvas WebGL context, shader compilation/linking, uniforms, viewport, buffer drawing, and resource cleanup. The custom analytic field ports the approved preview's formula and timing, rather than inferring Arc's original rendering implementation. GLSL ES 1.00 uses an exponential tanh equivalent. The loop is capped at 30 fps and DPR at 1.5, paints its first frame even when WKWebView is hidden, then lets requestAnimationFrame suspend and resume with visibility, and provides a CSS fallback. These are implementation choices, not measured performance claims.
- [HTMLMediaElement.play](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play): playback returns a promise that may reject for autoplay policy. The music control offers a user-gesture retry on rejection; it must not claim playback started merely because play was called.
- [React useEffect](https://react.dev/reference/react/useEffect): setup/cleanup is stress-tested an extra time in development Strict Mode. Timers, event handlers, animation frames and GL resources have cleanup. Music fades on departure and does not loop indefinitely.

Native window and startup API findings are in [the native research note](cosmic-bridge-native-2026-09-06.md). Production assets derive from the selected local preview and custom vector mark. Browser and native verification results are in [the implementation report](../plans/cosmic-bridge-implementation-2026-09-06.md).
