import "./styles/globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/app/App";
import { appInfo } from "@/ipc/client";
import { applyDensity, cachedDensity } from "@/lib/density";
import { trackFullscreen } from "@/lib/fullscreen";
import { markStartup } from "@/lib/startup";
import { startBridge } from "@/state/bridge";
import { useApp } from "@/state/store";

markStartup("script");
// Density and platform are known before the first React paint, so nothing jumps.
applyDensity(cachedDensity());
const info = await appInfo();
document.documentElement.dataset.platform = info.platform;
if (info.platform === "macos") {
  void trackFullscreen().catch((error: unknown) => {
    console.error("tracking full screen failed", error);
  });
}
useApp.setState({ info });
await startBridge();
markStartup("connected");

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
