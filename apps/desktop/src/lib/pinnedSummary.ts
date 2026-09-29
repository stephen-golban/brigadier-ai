const STORAGE_KEY = "brigadier.pinnedSummary";

/** Whether the pinned summary is pinned, as last left: pinned until it is unpinned. */
export function cachedPinnedSummary(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Keeps the pin for the next launch. */
export function savePinnedSummary(pinned: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(pinned));
  } catch {
    // Storage can be unavailable; the pin then lasts until the app quits.
  }
}
