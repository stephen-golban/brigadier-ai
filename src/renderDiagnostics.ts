import { invoke, isTauri } from "@tauri-apps/api/core";

// Local-only, bounded diagnostics. See docs/research/render-failure-diagnostics-2026-09-08.md.
export function reportRenderError(error: unknown, componentStack?: string | null) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack ?? "" : "";
  console.error("Brigadier interface error", error);
  if (isTauri()) {
    void invoke("report_frontend_error", {
      message: message.slice(0, 2000),
      stack: `${stack}\n${componentStack ?? ""}`.slice(0, 8000),
    }).catch(() => {});
  }
}

export function installRenderDiagnostics() {
  window.addEventListener("error", (event) => reportRenderError(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => reportRenderError(event.reason));
}
