import { lazy, Suspense, useEffect } from "react";

import { AppSidebar } from "@/app/AppSidebar";
import { ArchivedView } from "@/app/ArchivedView";
import { ConversationView } from "@/app/ConversationView";
import { runSmoke } from "@/app/smoke";
import { TopBar } from "@/app/TopBar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { appReady, nowEpochMs } from "@/ipc/client";
import { nextPaint, setFrameSampling } from "@/lib/perf";
import { setInspectorOpen, setMetricsStreaming } from "@/state/actions";
import { useApp, type Selection } from "@/state/store";

// The Inspector is a developer view: keep it off the cold-start path.
const Inspector = lazy(() =>
  import("@/app/inspector/Inspector").then((module) => ({ default: module.Inspector })),
);

let readyReported = false;

/** Drafts share one key: switching the composer's project must not lose the typed text. */
function viewKey(selection: Selection): string {
  switch (selection.type) {
    case "conversation":
      return selection.id;
    case "draft":
      return "draft";
    case "archived":
      return "archived";
    case "none":
      return "none";
  }
}

export function App() {
  const selection = useApp((s) => s.selection);
  const inspectorOpen = useApp((s) => s.inspector.open);
  const windowVisible = useApp((s) => s.windowVisible);
  const connected = useApp((s) => s.connection.status === "connected");
  const catalogLoaded = useApp((s) => s.catalogLoaded);

  // Cold start ends at the first paint that shows the loaded catalog.
  useEffect(() => {
    if (!catalogLoaded || readyReported) return;
    readyReported = true;
    void nextPaint()
      .then(() => appReady(nowEpochMs()))
      .then((coldStartMs) => {
        useApp.setState({ coldStartMs });
        if (useApp.getState().info?.smoke) return runSmoke();
      })
      .catch((error: unknown) => console.error("startup report failed", error));
  }, [catalogLoaded]);

  // Metrics stream and frame sampling run only while someone can see them.
  const sampling = inspectorOpen && windowVisible;
  useEffect(() => {
    setFrameSampling(sampling);
    return () => setFrameSampling(false);
  }, [sampling]);
  useEffect(() => {
    if (!connected) return;
    void setMetricsStreaming(sampling).catch(() => {
      // Reapplied by the shell on reconnect.
    });
  }, [sampling, connected]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "KeyI" && event.altKey && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setInspectorOpen(!useApp.getState().inspector.open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="h-full flex-row overflow-hidden">
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <TopBar />
          <div className="min-h-0 flex-1">
            {selection.type === "archived" ? (
              <ArchivedView />
            ) : (
              <ConversationView key={viewKey(selection)} selection={selection} />
            )}
          </div>
        </div>
        {inspectorOpen && (
          <Suspense fallback={null}>
            <Inspector />
          </Suspense>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
