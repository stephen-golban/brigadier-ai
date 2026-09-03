/**
 * The composer's glyphs, as inline SVG.
 *
 * These replace the `▤ ▸ ◇ ↑` text characters that `Composer.tsx` and `NewSession.tsx` rendered,
 * for the reason the sidebar's own `✎ ◈ ▤` were replaced at `a0901e5` and the thread header's
 * `✕` after it: whether a codepoint like `▤` draws as a mark, as a box, or as a fallback serif is
 * decided by whichever font on the machine claims it, and it never sits on the label's baseline.
 * Inline SVG at `currentColor`, sized in the same units as the text beside it, always does.
 *
 * Deliberately not an icon package. `docs/plans/phase-4.md`'s frontend wave adds no dependency,
 * and four 12px glyphs are ~40 lines against a package's install, licence and bundle.
 *
 * House style, matching `Sidebar.tsx`: a square `viewBox`, `fill="none"`, `stroke="currentColor"`,
 * `aria-hidden` plus `focusable="false"` because every one of them sits beside its own label.
 * Stroke width is 1.3–1.4 at 12px and 1.5 at 14px, so the optical weight is the same at both.
 */

/** A repository. The `▤` it replaces: a filled square, which is what a folder of files looks like
 *  from far enough away. Drawn as a rounded rectangle with its rows in it. */
export function ProjectIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <rect
        x="1.35"
        y="2.1"
        width="9.3"
        height="7.8"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M3.6 5.2h4.8M3.6 7.3h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** A working directory, one step down from the project. The `▸` it replaces, at the same weight
 *  as the sidebar's disclosure caret so the two read as the same gesture. */
export function PathIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <path
        d="M4.4 2.4 8 6l-3.6 3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The model. The `◇` it replaces, kept as a diamond: it is the one glyph in the strip that names
 *  a thing rather than a place, and a shape nothing else in the app uses says so. */
export function ModelIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <path
        d="M6 1.5 10.5 6 6 10.5 1.5 6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Send. The `↑` it replaces sat inside the one solid control in the window, where a fallback
 *  glyph at the wrong baseline is at its most visible. */
export function SendIcon() {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M7 11.2V3.3M3.4 6.7 7 3.1l3.6 3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
