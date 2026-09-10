import { profiling, recordRender } from "./perfDiagnostics";
import React from "react";
import ReactDOM from "react-dom/client";

import { Launch } from "./Launch";
import { WindowChrome } from "./components/WindowChrome";
import { startPaintInstrumentation } from "./paint";
import "./index.css";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { installRenderDiagnostics, reportRenderError } from "./renderDiagnostics";

// brigadier is dark-only (owner decision 2026-09-10). The class is not a switch: nothing reads it
// today — `src/index.css` declares no `@custom-variant dark`, so no `dark:` utility resolves and the
// class is inert. It is set once, and never toggled, so the design-system phase can add that variant
// and have every `dark:` utility light up without touching bootstrap. The stale preference from the
// deleted theme switcher is dropped on first load.
document.documentElement.classList.add("dark");
try {
  localStorage.removeItem("brigadier.theme");
} catch {
  /* a blocked storage is not a startup failure */
}

// The FCP observer is `buffered: true`, so it sees a first contentful paint that has already
// happened. Its position relative to `createRoot` below therefore carries no meaning and is not
// load-bearing — do not reorder it in the belief that it is.
// see src/paint.ts and docs/research/perceived-performance.md §5.3.
startPaintInstrumentation();
installRenderDiagnostics();

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
  onCaughtError: (error, info) => reportRenderError(error, info.componentStack),
  onUncaughtError: (error, info) => reportRenderError(error, info.componentStack),
  onRecoverableError: (error, info) => reportRenderError(error, info.componentStack),
});
const tree = (
  <React.StrictMode>
    <AppErrorBoundary>
      <Launch />
      <WindowChrome />
    </AppErrorBoundary>
  </React.StrictMode>
);

root.render(profiling ? <React.Profiler id="root" onRender={recordRender}>{tree}</React.Profiler> : tree);
