import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Mirrors the native window's fullscreen state onto `<html data-fullscreen>`.
 *
 * Tauri v2 ships no fullscreen event (`@tauri-apps/api` 2.11.1 exposes `isFullscreen`,
 * `onResized` and `onFocusChanged` and nothing else that fires on the transition), so the
 * resize stream is the only signal: seed from `isFullscreen()`, then re-poll it on every
 * resize. In macOS fullscreen the traffic lights withdraw, and the CSS keyed off this
 * attribute drops `--window-controls-inset` to match.
 */
export function useFullscreen(): void {
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    let unlisten: (() => void) | undefined;
    const apply = (fullscreen: boolean) => {
      if (!live) return;
      if (fullscreen) document.documentElement.dataset.fullscreen = "true";
      else delete document.documentElement.dataset.fullscreen;
    };
    const read = async () => {
      try {
        apply(await getCurrentWindow().isFullscreen());
      } catch {
        // A runtime that cannot answer is treated as windowed.
        apply(false);
      }
    };
    void (async () => {
      await read();
      try {
        const stop = await getCurrentWindow().onResized(() => void read());
        if (live) unlisten = stop;
        else stop();
      } catch {
        // Without the resize stream the seeded value stands.
      }
    })();
    return () => {
      live = false;
      unlisten?.();
      unlisten = undefined;
      delete document.documentElement.dataset.fullscreen;
    };
  }, []);
}
