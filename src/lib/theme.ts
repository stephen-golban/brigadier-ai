/** CSS is the single source of color values, including canvas-based renderers. */
export type ColorToken =
  | "canvas"
  | "sidebar"
  | "elevated"
  | "input"
  | "input-shell"
  | "hairline"
  | "hover"
  | "selected"
  | "text"
  | "text-secondary"
  | "text-tertiary"
  | "text-disabled"
  | "warn"
  | "ok"
  | "error";
export function themeColor(token: ColorToken): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--color-${token}`)
    .trim();
  if (!value) throw new Error(`Missing theme token: ${token}`);
  return value;
}
/** Monaco accepts hexadecimal colors; preserve the alpha on state tokens. */
export function editorColor(token: ColorToken): string {
  const value = themeColor(token);
  if (value.startsWith("#")) return value;
  const channels = value
    .match(/^rgba?\(([^)]+)\)$/)?.[1]
    .split(",")
    .map(Number);
  if (!channels || channels.some((channel) => !Number.isFinite(channel)))
    throw new Error(`Unsupported theme color: ${token}`);
  const [r, g, b, a] = channels;
  return `#${[r, g, b, ...(a === undefined ? [] : [Math.round(a * 255)])].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
