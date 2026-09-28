import type { FC, SVGProps } from "react";

/**
 * Brigadier's mark, the striped disc: a solid core with bars through it and fifteen thin
 * strokes around it, on the 256-unit grid of its master (`src-tauri/icons/mark.svg`, which
 * also draws the app and menu-bar icons), in the current colour, sized by the caller. The new
 * chat's hero shows it faintly above the heading.
 */

/** Each thin stroke as `[x, y, height]`; all are 4.4 wide with round ends. */
const STRIPES = [
  [25.0, 108.8, 38.4],
  [39.4, 73.6, 108.8],
  [53.8, 55.2, 145.6],
  [68.2, 42.4, 171.2],
  [82.6, 35.2, 185.6],
  [97.0, 28.8, 198.4],
  [111.4, 25.6, 204.8],
  [125.8, 22.4, 211.2],
  [140.2, 25.6, 204.8],
  [154.6, 28.8, 198.4],
  [169.0, 35.2, 185.6],
  [183.4, 42.4, 171.2],
  [197.8, 55.2, 145.6],
  [212.2, 73.6, 108.8],
  [226.6, 108.8, 38.4],
] as const;

/** Each bar through the core as `[x, y, height]`; all are 9.6 wide with round ends. */
const CORE_BARS = [
  [51.2, 99.2, 57.6],
  [65.6, 79.2, 97.6],
  [80.0, 65.6, 124.8],
  [94.4, 56.0, 144.0],
  [108.8, 51.2, 153.6],
  [123.2, 49.6, 156.8],
  [137.6, 51.2, 153.6],
  [152.0, 56.0, 144.0],
  [166.4, 65.6, 124.8],
  [180.8, 79.2, 97.6],
  [195.2, 99.2, 57.6],
] as const;

/** Rounds away float noise (108.8 + 2.2) so the path data reads like the master's. */
const n = (value: number) => Math.round(value * 100) / 100;

/** A vertical bar with fully rounded ends, as path data (`<rect rx>` in the master). */
const bar = (width: number) => ([x, y, height]: readonly [number, number, number]) => {
  const r = width / 2;
  return `M${n(x)} ${n(y + r)}a${r} ${r} 0 0 1 ${width} 0v${n(height - width)}a${r} ${r} 0 0 1 ${-width} 0Z`;
};

const STRIPE_PATHS = STRIPES.map(bar(4.4));
const CORE_BAR_PATHS = CORE_BARS.map(bar(9.6));

export const BrigadierGlyph: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden {...props}>
    {STRIPE_PATHS.map((d) => (
      <path key={d} d={d} />
    ))}
    <circle cx={128} cy={128} r={59} />
    {CORE_BAR_PATHS.map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
);
