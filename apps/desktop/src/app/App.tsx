import { lazy, Suspense, useEffect } from "react";

import { AppRail, AppSidebar, TitlebarControls } from "@/app/AppSidebar";
import { AddProjectDialog } from "@/app/dialogs/AddProjectDialog";
import { StorageDialog } from "@/app/dialogs/StorageDialog";
import { UninstallDialog } from "@/app/dialogs/UninstallDialog";
import { FolderDropZone } from "@/app/FolderDropZone";
import { ConversationView } from "@/app/ConversationView";
import { OnboardingDialog } from "@/app/onboarding/OnboardingDialog";
import { GlobalSearch } from "@/app/SearchDialog";
import { StatusBar } from "@/app/StatusBar";
import { SettingsNav } from "@/app/settings/SettingsNav";
import { SettingsView } from "@/app/settings/SettingsView";
import { runSmoke } from "@/app/smoke";
import { SidebarPanel, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toast";
import { appReady, nowEpochMs } from "@/ipc/client";
import { nextPaint, setFrameSampling } from "@/lib/perf";
import { markStartup } from "@/lib/startup";
import {
  goBack,
  goForward,
  setInspectorOpen,
  setMetricsStreaming,
  toggleSettings,
} from "@/state/actions";
import { openFolderPicker } from "@/state/addProject";
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
    case "settings":
      return "settings";
    case "none":
      return "none";
  }
}

/** Keeps the page surface's corners round over the columns that fill it (see page-corner). */
function PageCorners() {
  return (
    <div
      aria-hidden
      className="top-titlebar start-rail end-surface-inset bottom-surface-inset pointer-events-none absolute z-20"
    >
      <span className="page-corner page-corner-top-start" />
      <span className="page-corner page-corner-top-end" />
      <span className="page-corner page-corner-bottom-start" />
      <span className="page-corner page-corner-bottom-end" />
    </div>
  );
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
    markStartup("catalog");
    void nextPaint()
      .then(() => {
        markStartup("paint");
        return appReady(nowEpochMs());
      })
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
      const mac = useApp.getState().info?.platform === "macos";
      // Back and Forward: ⌘[ and ⌘] on macOS, Alt+← and Alt+→ elsewhere.
      const back = mac
        ? event.metaKey && !event.altKey && !event.shiftKey && event.code === "BracketLeft"
        : event.altKey && !event.ctrlKey && !event.metaKey && event.key === "ArrowLeft";
      const forward = mac
        ? event.metaKey && !event.altKey && !event.shiftKey && event.code === "BracketRight"
        : event.altKey && !event.ctrlKey && !event.metaKey && event.key === "ArrowRight";
      if (back || forward) {
        event.preventDefault();
        if (back) goBack();
        else goForward();
      }
      // Settings: on macOS the app menu's ⌘, does it.
      if (!mac && event.key === "," && event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        toggleSettings();
      }
      // Open Folder…: on macOS the File menu's ⌘O does it.
      if (!mac && event.code === "KeyO" && event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        void openFolderPicker();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="bg-chrome flex h-full flex-col">
      <SidebarProvider className="relative min-h-0 flex-1">
        {/* The page surface the sidebar panel, the content and the Inspector sit on; their
            headers stay above it, in the titlebar strip. */}
        <div
          aria-hidden
          data-slot="page-surface"
          className="bg-background rounded-page shadow-page top-titlebar start-rail end-surface-inset bottom-surface-inset pointer-events-none absolute"
        />
        <PageCorners />
        <AppRail />
        <div className="relative flex min-w-0 flex-1 pb-surface-inset pe-surface-inset">
          <SidebarPanel>{selection.type === "settings" ? <SettingsNav /> : <AppSidebar />}</SidebarPanel>
          <main className="body-divider relative flex h-full min-w-0 flex-1">
            <div className="relative flex h-full min-w-0 flex-1 flex-col">
              {selection.type === "settings" ? (
                <>
                  {/* The page's strip of the titlebar: empty, for dragging the window. */}
                  <div data-tauri-drag-region className="h-titlebar shrink-0" />
                  <div className="min-h-0 flex-1">
                    <SettingsView page={selection.page} />
                  </div>
                </>
              ) : (
                <ConversationView key={viewKey(selection)} selection={selection} />
              )}
              <Toaster className="top-titlebar pt-2" />
            </div>
            {inspectorOpen && (
              <Suspense fallback={null}>
                <Inspector />
              </Suspense>
            )}
          </main>
        </div>
        <TitlebarControls />
        <GlobalSearch />
        <OnboardingDialog />
        <AddProjectDialog />
        <StorageDialog />
        <UninstallDialog />
        <FolderDropZone />
      </SidebarProvider>
      <StatusBar />
    </div>
  );
}
