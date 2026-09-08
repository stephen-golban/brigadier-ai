# Workspace tabs and Notepad pane

Verified 2026-09-08 against WAI-ARIA APG, HTML, and MDN documentation. Implementation recommendations below are inferences, not additional requirements stated by those sources.

## Documented behavior

- Tabs use a labeled `tablist`, `tab` elements with `aria-selected`, and associated `tabpanel` elements. Link each tab to its panel with `aria-controls`, and each panel to its tab with `aria-labelledby`. Only the active panel is displayed. Tab enters the active tab and subsequently leaves the tablist. Left/Right arrows wrap; Home/End are optional. Enter/Space activate manually selected tabs. Automatic activation is recommended only when panel display has no noticeable latency. [WAI-ARIA Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)
- Optional Delete closes the focused tab and panel, then focuses the following tab, or the preceding tab when no following tab remains. If all tabs can close, closing the final tab moves focus to a logical continuation control. [WAI-ARIA Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)
- A native `button` cannot contain interactive descendants or descendants with `tabindex`; therefore a close button must not be nested inside a native tab button. [HTML button content model](https://html.spec.whatwg.org/multipage/form-elements.html#the-button-element)
- Grid column tracks accept fixed lengths and fractions of remaining space. A bare `1fr` has an automatic minimum; `minmax(0, 1fr)` explicitly sets that minimum to zero. MDN documents interpolation for compatible track lists whose length, percentage, or calculation values change. [MDN grid-template-columns](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/grid-template-columns)
- `transition` can target a specific property with duration and easing; `transition: none` disables transitions. [MDN transition](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/transition)
- `prefers-reduced-motion: reduce` detects a device preference to remove, reduce, or replace nonessential motion. [MDN prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion)
- `inert` removes a subtree from keyboard focus and the accessibility tree, and prevents interaction. [MDN inert](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inert)

## Implementation recommendations (inferred)

- Use one keyboard stop for the selected tab, arrow navigation, and Delete for closing. Place the visible close control beside the tab button in a shared visual wrapper. Give it a specific accessible name such as “Close Notepad.” Check the complete keyboard sequence because APG does not prescribe an inline close-button layout.
- Keep a stable two-column grid: `minmax(0, 1fr) 0px` when closed and `minmax(0, 1fr) 360px` when open. Transition only `grid-template-columns`; the expanding second column reduces the main column, creating the requested push effect. Keep the same track structure and validate interpolation in the app browser.
- Give grid children `min-width: 0` and clip overflow within the pane. When retaining the closed pane in the DOM for animation or state preservation, make it inert. Move focus back to its opener before hiding a focused pane.
- Disable the pane transition in `@media (prefers-reduced-motion: reduce)`. Choose duration and responsive pane width as product decisions; these sources prescribe neither.

Verification scope: documentation only. Runtime interpolation, focus restoration, and narrow-window behavior still require checking in the implemented app.
