import { create } from "zustand";

import { request } from "@/ipc/client";
import type { EventEnvelope, OverrideRule, UsageView } from "@/ipc/generated";
import { updateSettings } from "@/state/actions";
import { useApp } from "@/state/store";

/**
 * The Usage page's data: one `getUsage` read, taken again when a provider is checked and every
 * minute while the page is shown.
 */
export type UsageState = {
  view: UsageView | null;
  /** The project the models' learned adjustments are for; `null`: every project. */
  projectId: string | null;
  loading: boolean;
  error: string | null;
  /** The page is mounted: provider checks read the view again. */
  shown: boolean;
};

export const useUsage = create<UsageState>()(() => ({
  view: null,
  projectId: null,
  loading: false,
  error: null,
  shown: false,
}));

let inFlight: Promise<void> | null = null;
let again = false;

/** Reads the view for the chosen project; a read asked for meanwhile runs once after it. */
export function loadUsage(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  useUsage.setState({ loading: true });
  inFlight = (async () => {
    try {
      do {
        again = false;
        const projectId = useUsage.getState().projectId;
        try {
          const { usage } = await request({ method: "getUsage", projectId });
          // A project picked while reading is read next; keep this one only if it still applies.
          if (useUsage.getState().projectId === projectId) {
            useUsage.setState({ view: usage, error: null });
          }
        } catch (error) {
          useUsage.setState({ error: error instanceof Error ? error.message : String(error) });
        }
      } while (again);
    } finally {
      inFlight = null;
      useUsage.setState({ loading: false });
    }
  })();
  return inFlight;
}

export function setUsageProject(projectId: string | null): void {
  useUsage.setState({ projectId });
  void loadUsage();
}

export function setUsageShown(shown: boolean): void {
  useUsage.setState({ shown });
}

/** A provider check changes windows, estimates and balancing: read the view again. */
export function applyUsageEvents(batch: readonly EventEnvelope[]): void {
  if (!useUsage.getState().shown) return;
  if (batch.some(({ event }) => event.type === "providerChecked")) void loadUsage();
}

/** Asks the repository for a newer registry now, then shows the registry in use. */
export async function checkRegistry(): Promise<void> {
  const { registry } = await request({ method: "checkRegistry" });
  const view = useUsage.getState().view;
  if (view) useUsage.setState({ view: { ...view, registry } });
}

/** Adds a routing rule to the user's settings. */
export async function addOverride(rule: OverrideRule): Promise<void> {
  const settings = useApp.getState().settings;
  await updateSettings({ ...settings, routingOverrides: [...settings.routingOverrides, rule] });
}

/** Removes a routing rule from the user's settings. */
export async function removeOverride(id: string): Promise<void> {
  const settings = useApp.getState().settings;
  await updateSettings({
    ...settings,
    routingOverrides: settings.routingOverrides.filter((rule) => rule.id !== id),
  });
}
