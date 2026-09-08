import React from "react";
import ReactDOM from "react-dom/client";

import { Launch } from "./Launch";
import { WindowChrome } from "./components/WindowChrome";
import { startPaintInstrumentation } from "./paint";
import { ThemeProvider } from "./providers/ThemeProvider";
import "./index.css";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { installRenderDiagnostics, reportRenderError } from "./renderDiagnostics";

// The FCP observer is `buffered: true`, so it sees a first contentful paint that has already
// happened. Its position relative to `createRoot` below therefore carries no meaning and is not
// load-bearing — do not reorder it in the belief that it is.
// see src/paint.ts and docs/research/perceived-performance.md §5.3.
startPaintInstrumentation();
installRenderDiagnostics();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
  onCaughtError: (error, info) => reportRenderError(error, info.componentStack),
  onUncaughtError: (error, info) => reportRenderError(error, info.componentStack),
  onRecoverableError: (error, info) => reportRenderError(error, info.componentStack),
}).render(
  <React.StrictMode>
    <AppErrorBoundary>
    <ThemeProvider>
      <Launch />
      <WindowChrome />
    </ThemeProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
