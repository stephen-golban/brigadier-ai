import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Marks the root `data-fullscreen` while the window is in full screen, where macOS hides the
 * traffic lights and the titlebar's sidebar toggle moves to their place (see
 * styles/tokens.css). The window resizes on entering and leaving full screen, so each resize
 * rechecks.
 */
export async function trackFullscreen(): Promise<void> {
  const appWindow = getCurrentWindow();
  const check = async () => {
    document.documentElement.toggleAttribute("data-fullscreen", await appWindow.isFullscreen());
  };
  await appWindow.onResized(() => {
    void check().catch((error: unknown) => console.error("reading full screen failed", error));
  });
  await check();
}
