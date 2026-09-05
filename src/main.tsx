import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { startPaintInstrumentation } from "./paint";
import { ThemeProvider } from "./providers/ThemeProvider";
import "./index.css";
import "./chat.css";

// The FCP observer is `buffered: true`, so it sees a first contentful paint that has already
// happened. Its position relative to `createRoot` below therefore carries no meaning and is not
// load-bearing — do not reorder it in the belief that it is.
// see src/paint.ts and docs/research/perceived-performance.md §5.3.
startPaintInstrumentation();

// `ThemeProvider` (Apache-2.0, adapted from Jan) is mounted here, which is the whole of what
// W4-C owes it. Know what it does and does not do today: brigadier ships dark only, there is no
// light token set in `index.css` and no `.dark` rule, so the class it toggles has **no visual
// effect**; and its Tauri branch is inert because nothing in `src-tauri/` emits `theme-changed`.
// Neither is a bug to fix here — see the file's own header.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
