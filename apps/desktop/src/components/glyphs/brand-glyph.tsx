import type { FC, SVGProps } from "react";

/**
 * Brigadier's mark as a line glyph: the app icon's rounded square and its three chevrons,
 * outlined on the icon set's 24-unit grid in the current colour, sized by the caller. The new
 * chat's hero shows it faintly above the heading, where ChatGPT shows its own.
 */

const FRAME =
  "M8 1.875h8A6.125 6.125 0 0 1 22.125 8v8A6.125 6.125 0 0 1 16 22.125H8A6.125 6.125 0 0 1 1.875 16V8A6.125 6.125 0 0 1 8 1.875Zm0 1.25A4.875 4.875 0 0 0 3.125 8v8A4.875 4.875 0 0 0 8 20.875h8A4.875 4.875 0 0 0 20.875 16V8A4.875 4.875 0 0 0 16 3.125H8Z";

const CHEVRONS = [
  "M7.389 9.739 12 6.485l4.611 3.254a.625.625 0 0 1-.722 1.022L12 8.015l-3.889 2.746a.625.625 0 0 1-.722-1.022Z",
  "M7.389 12.989 12 9.735l4.611 3.254a.625.625 0 0 1-.722 1.022L12 11.265l-3.889 2.746a.625.625 0 0 1-.722-1.022Z",
  "M7.389 16.239 12 12.985l4.611 3.254a.625.625 0 0 1-.722 1.022L12 14.515l-3.889 2.746a.625.625 0 0 1-.722-1.022Z",
];

export const BrigadierGlyph: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
    <path fillRule="evenodd" clipRule="evenodd" d={FRAME} />
    {CHEVRONS.map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
);
