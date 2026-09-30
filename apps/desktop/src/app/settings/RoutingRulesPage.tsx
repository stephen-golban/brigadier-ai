import { RoutingSection } from "@/app/dialogs/RoutingSection";
import { SettingsCard, SettingsPage } from "@/app/settings/parts";
import { useModelGroups } from "@/lib/setup";

/** The Routing page's rows, for Settings search. */
export const ROUTING_ROWS = {
  rules: {
    label: "Routing rules",
    description: "Rules that always win over routing's scores and quota balancing.",
  },
} as const;

export function RoutingRulesPage() {
  const groups = useModelGroups();
  return (
    <SettingsPage title="Routing">
      <SettingsCard className="p-4">
        <RoutingSection groups={groups} />
      </SettingsCard>
    </SettingsPage>
  );
}
