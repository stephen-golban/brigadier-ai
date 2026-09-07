import { isTauri } from "@tauri-apps/api/core";
import "../window-chrome.css";

/** macOS keeps native traffic lights while the webview paints the entire window. */
export function WindowChrome() {
  if (!isTauri() || !navigator.platform.startsWith("Mac")) return null;

  return <div className="window-drag-region" data-tauri-drag-region aria-hidden="true" />;
}
