import { X } from "@openai/apps-sdk-ui/components/Icon";
import { useEffect, useRef } from "react";

import { BrainTab } from "@/app/inspector/brain/BrainTab";
import { EventsTab } from "@/app/inspector/EventsTab";
import { OrchestratorTab } from "@/app/inspector/OrchestratorTab";
import { PerformanceTab } from "@/app/inspector/PerformanceTab";
import { ProcessesTab } from "@/app/inspector/ProcessesTab";
import { ProvidersTab } from "@/app/inspector/providers/ProvidersTab";
import { RoutingTab } from "@/app/inspector/RoutingTab";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { setInspectorOpen, setInspectorTab } from "@/state/actions";
import { type InspectorTab, useApp } from "@/state/store";

function isTab(value: string): value is InspectorTab {
  return (
    value === "events" ||
    value === "orchestrator" ||
    value === "brain" ||
    value === "processes" ||
    value === "performance" ||
    value === "providers" ||
    value === "routing"
  );
}

/**
 * Developer view: live event stream, the open session's orchestrator context, the Project
 * Brains, processes,
 * metrics against the §4 budgets, raw provider sessions, and a routing preview.
 */
export function Inspector() {
  const tab = useApp((s) => s.inspector.tab);
  const tabs = useRef<HTMLDivElement>(null);
  // The narrow Inspector cannot fit every tab; the strip scrolls and keeps the open one in view.
  useEffect(() => {
    tabs.current
      ?.querySelector(`[role="tab"][id$="-trigger-${tab}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);
  return (
    <aside
      aria-label="Inspector"
      className={cn(
        "bg-sidebar flex h-full shrink-0 flex-col border-s",
        tab === "providers" || tab === "brain" || tab === "routing"
          ? "w-inspector-wide"
          : "w-inspector",
      )}
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
          <TabsList
            ref={tabs}
            className="hide-scrollbar min-w-0 flex-1 justify-start overflow-x-auto"
          >
            <TabsTrigger value="events">Events</TabsTrigger>
            <TabsTrigger value="orchestrator">Orchestrator</TabsTrigger>
            <TabsTrigger value="brain">Brain</TabsTrigger>
            <TabsTrigger value="processes">Processes</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
            <TabsTrigger value="providers">Providers</TabsTrigger>
            <TabsTrigger value="routing">Routing</TabsTrigger>
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
        <TabsContent value="orchestrator" className="flex min-h-0 flex-col">
          <OrchestratorTab />
        </TabsContent>
        <TabsContent value="brain" className="flex min-h-0 flex-col">
          <BrainTab />
        </TabsContent>
        <TabsContent value="processes" className="min-h-0 overflow-y-auto">
          <ProcessesTab />
        </TabsContent>
        <TabsContent value="performance" className="min-h-0 overflow-y-auto">
          <PerformanceTab />
        </TabsContent>
        <TabsContent value="providers" className="flex min-h-0 flex-col">
          <ProvidersTab />
        </TabsContent>
        <TabsContent value="routing" className="flex min-h-0 flex-col">
          <RoutingTab />
        </TabsContent>
      </Tabs>
    </aside>
  );
}
