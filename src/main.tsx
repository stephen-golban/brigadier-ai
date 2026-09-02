import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { startPaintInstrumentation } from "./paint";
import "./index.css";

// The FCP observer is `buffered: true`, so it sees a first contentful paint that has already
// happened. Its position relative to `createRoot` below therefore carries no meaning and is not
// load-bearing — do not reorder it in the belief that it is.
// see src/paint.ts and docs/research/perceived-performance.md §5.3.
startPaintInstrumentation();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
