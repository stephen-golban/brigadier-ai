# Striped-disc intro: native CSS motion

Checked 2026-09-11. Scope: animate fifteen stripe fragments into the selected master logo, retain the completed mark, and use a CSS background.

## Verified primary documentation

- Animate each local `<use>` host rather than trying to select its external descendants. SVG re-used geometry is drawn in the host's coordinate system with cumulative transforms; outer-document selectors do not match its shadow descendants. The referenced rectangles retain their original coordinates. [SVG 2: use layout and styling](https://www.w3.org/TR/SVG2/struct.html#UseLayout)
- SVG supports CSS transforms. Set `transform-box: view-box; transform-origin: 50% 50%` explicitly for rotation/scaling about the shared logo center. `view-box` uses the nearest SVG viewport, including its viewBox origin and dimensions; for the existing `0 0 256 256` master, the center is `(128,128)`. Use `fill-box` only if rotation about each stripe's own bounds is intended. [CSS Transforms: reference box](https://www.w3.org/TR/css-transforms-1/#transform-box), [SVG 2: transform](https://www.w3.org/TR/SVG2/coords.html#TransformProperty)
- `opacity` applies to all elements, is animatable by computed value, and composites the element with its descendants. It can therefore fade each local use host or the complete logo. [CSS Color: opacity](https://www.w3.org/TR/css-color-4/#transparency)
- `animationend` fires on normal completion and bubbles; its `animationName` identifies the animation. Cancellation, including removal of the animation name or `display:none`, instead triggers `animationcancel`. `animation-fill-mode: forwards` retains the completed keyframe's values. [CSS Animations: events](https://www.w3.org/TR/css-animations-1/#animation-events), [fill mode](https://www.w3.org/TR/css-animations-1/#animation-fill-mode)
- `target` identifies the dispatch target; `currentTarget` identifies the listener currently running. A container completion handler should guard both `event.target === event.currentTarget` and the intended `animationName`, so a stripe's bubbled completion cannot advance the whole scene. This guard is an implementation inference from the event definitions. [DOM Standard: Event](https://dom.spec.whatwg.org/#interface-event)
- `prefers-reduced-motion: reduce` signals a request to minimize nonessential motion. A static default, with motion enabled under `no-preference`, is a documented approach. [Media Queries 5](https://www.w3.org/TR/mediaqueries-5/#prefers-reduced-motion), [W3C technique C39](https://www.w3.org/WAI/WCAG21/Techniques/css/C39.html)

## Repository inspection and recommendations

At inspection, `public/brand/striped-disc.svg` has fifteen thin outer rectangles followed by a circle and eleven thicker rectangles. `BrandMark.tsx` references its `#mark` group. `Launch.tsx` already guards animation target/name for scene transitions and bypasses the cinematic stage for reduced motion.

Give the fifteen existing outer rectangles stable IDs and reference those IDs from local use elements; keep their geometry in the master. Animate finite transforms and opacity, ending at the original coordinates. Reveal the full `#mark` as the permanent result so the center geometry remains exact. A CSS background and this finite animation need no WebGL lifecycle.

Retain the existing event guards. Reduced motion must reach the interactive state directly; disabling an animation cannot be expected to emit its normal end event. If the user changes the preference during playback, also settle the scene explicitly. Verify the completed mark, timing, replay, and reduced-motion behavior in the app's browser/WebView; specification support alone does not establish rendering quality or compositor performance.
