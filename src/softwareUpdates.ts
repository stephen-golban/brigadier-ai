import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { desktop, errorMessage } from "./workspaceApi";
import { notify } from "./desktopApi";

export interface SoftwareUpdate {
  id: string;
  provider: string;
  label: string;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  error: string | null;
}
interface Snapshot { rows: SoftwareUpdate[]; checking: boolean; error: string; checkedAt: number; updatingId: string | null; updateError: string }
let snapshot: Snapshot = { rows: [], checking: false, error: "", checkedAt: 0, updatingId: null, updateError: "" };
const listeners = new Set<() => void>();
let pending: Promise<void> | null = null;
const interval = 15 * 60 * 1000;
const publish = (next: Snapshot) => { snapshot = next; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => snapshot;

export function refreshSoftwareUpdates(force = false): Promise<void> {
  if (!desktop || pending || snapshot.updatingId || (!force && Date.now() - snapshot.checkedAt < interval)) return pending ?? Promise.resolve();
  publish({ ...snapshot, checking: true });
  pending = invoke<SoftwareUpdate[]>("software_updates").then(
    rows => publish({ ...snapshot, rows, checking: false, error: "", checkedAt: Date.now() }),
    error => publish({ ...snapshot, checking: false, error: errorMessage(error), checkedAt: Date.now() }),
  ).finally(() => { pending = null; });
  return pending;
}

// Keep the job outside the settings component so navigation cannot lose progress or feedback.
export async function updateSoftware(id: string): Promise<void> {
  const row = snapshot.rows.find(row => row.id === id);
  if (!desktop || snapshot.updatingId || !row?.updateAvailable || !row.latestVersion || !["codex", "claude-code"].includes(row.provider)) return;
  publish({ ...snapshot, updatingId: id, updateError: "" });
  try {
    // Let an earlier check settle before replacing its version with the verified result.
    await pending;
    const installedVersion = await invoke<string>("update_software", { id, targetVersion: row.latestVersion });
    publish({ ...snapshot, rows: snapshot.rows.map(current => current.id === id
      ? { ...current, installedVersion, updateAvailable: false, error: null }
      : current) });
    notify(`${row.label} updated to ${installedVersion}.`);
  } catch (error) {
    const message = `${row.label} update failed: ${errorMessage(error)}`;
    publish({ ...snapshot, updateError: message });
    notify(message, true, () => { void updateSoftware(id); });
  } finally {
    publish({ ...snapshot, updatingId: null });
    await refreshSoftwareUpdates(true);
  }
}

export function useSoftwareUpdates() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    const refresh = () => { void refreshSoftwareUpdates(); };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, interval);
    return () => { window.removeEventListener("focus", refresh); clearInterval(timer); };
  }, []);
  return state;
}
