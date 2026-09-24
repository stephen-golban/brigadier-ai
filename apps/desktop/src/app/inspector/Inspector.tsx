import { X } from "@openai/apps-sdk-ui/components/Icon";

import { EventsTab } from "@/app/inspector/EventsTab";
import { PerformanceTab } from "@/app/inspector/PerformanceTab";
import { ProcessesTab } from "@/app/inspector/ProcessesTab";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { setInspectorOpen, setInspectorTab } from "@/state/actions";
import { type InspectorTab, useApp } from "@/state/store";

function isTab(value: string): value is InspectorTab {
  return value === "events" || value === "processes" || value === "performance";
}

/** Developer view: live event stream, processes, and metrics against the §4 budgets. */
export function Inspector() {
  const tab = useApp((s) => s.inspector.tab);
  return (
    <aside
      aria-label="Inspector"
      className="bg-sidebar w-inspector flex h-full shrink-0 flex-col border-s"
    >
      <Tabs
        value={tab}
        onValueChange={(value) => isTab(value) && setInspectorTab(value)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div
          data-tauri-drag-region
          className="h-titlebar flex shrink-0 items-center gap-2 border-b px-2"
        >
          <TabsList className="flex-1">
            <TabsTrigger value="events">Events</TabsTrigger>
            <TabsTrigger value="processes">Processes</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
          </TabsList>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close Inspector"
            onClick={() => setInspectorOpen(false)}
          >
            <X />
          </Button>
        </div>
        <TabsContent value="events" className="flex min-h-0 flex-col">
          <EventsTab />
        </TabsContent>
        <TabsContent value="processes" className="min-h-0 overflow-y-auto">
          <ProcessesTab />
        </TabsContent>
        <TabsContent value="performance" className="min-h-0 overflow-y-auto">
          <PerformanceTab />
        </TabsContent>
      </Tabs>
    </aside>
  );
}
