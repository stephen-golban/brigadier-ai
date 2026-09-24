import type { Density } from "@/ipc/generated";

const STORAGE_KEY = "brigadier.density";

/** Switches every size and spacing token at once (see styles/tokens.css). */
export function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density;
  try {
    localStorage.setItem(STORAGE_KEY, density);
  } catch {
    // Storage can be unavailable; the daemon's setting still applies on load.
  }
}

/** The last density used, so the first paint already has it before settings load. */
export function cachedDensity(): Density {
  try {
    return localStorage.getItem(STORAGE_KEY) === "compact" ? "compact" : "normal";
  } catch {
    return "normal";
  }
}
