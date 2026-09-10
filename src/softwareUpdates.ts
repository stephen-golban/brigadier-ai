import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { desktop, errorMessage } from "./workspaceApi";

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
interface Snapshot { rows: SoftwareUpdate[]; checking: boolean; error: string; checkedAt: number }
let snapshot: Snapshot = { rows: [], checking: false, error: "", checkedAt: 0 };
const listeners = new Set<() => void>();
let pending: Promise<void> | null = null;
const interval = 15 * 60 * 1000;
const publish = (next: Snapshot) => { snapshot = next; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => snapshot;

export function refreshSoftwareUpdates(force = false): Promise<void> {
  if (!desktop || pending || (!force && Date.now() - snapshot.checkedAt < interval)) return pending ?? Promise.resolve();
  publish({ ...snapshot, checking: true });
  pending = invoke<SoftwareUpdate[]>("software_updates").then(
    rows => publish({ rows, checking: false, error: "", checkedAt: Date.now() }),
    error => publish({ ...snapshot, checking: false, error: errorMessage(error), checkedAt: Date.now() }),
  ).finally(() => { pending = null; });
  return pending;
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
