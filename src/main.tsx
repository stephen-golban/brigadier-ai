import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

// Deliberately empty. The window opens; nothing is wired to it yet.
function App() {
  return <div className="app" />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
