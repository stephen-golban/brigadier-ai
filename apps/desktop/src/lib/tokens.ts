/**
 * Resolves a length token from styles/tokens.css to CSS pixels, for APIs that need numbers
 * (e.g. a virtualizer's row size). Re-read it whenever density changes.
 */
export function tokenPx(name: `--${string}`): number {
  const root = document.documentElement;
  const value = getComputedStyle(root).getPropertyValue(name).trim();
  const amount = Number.parseFloat(value);
  if (Number.isNaN(amount)) return 0;
  if (value.endsWith("rem")) {
    return amount * Number.parseFloat(getComputedStyle(root).fontSize);
  }
  return amount;
}
