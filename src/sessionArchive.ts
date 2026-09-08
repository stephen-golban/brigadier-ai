import { invoke } from "@tauri-apps/api/core";
import { useMemo, useSyncExternalStore } from "react";
import { desktop } from "./workspaceApi";
import { retireSession } from "./desktopApi";
export interface ArchiveSettings {
  autoDelete: boolean;
  retentionDays: number;
  deleteWorktrees: boolean;
}
export interface ArchiveEntry {
  archivedAt: number;
  needsReview: string | null;
}
export interface ArchiveData {
  settings: ArchiveSettings;
  entries: Record<string, ArchiveEntry>;
  deleted: string[];
}
export const archiveDefaults: ArchiveSettings = {
  autoDelete: true,
  retentionDays: 7,
  deleteWorktrees: true,
};
const key = "brigadier:session-archive:v1";
const idsKey = "brigadier:archived-sessions:v1";
export const archiveEvent = "brigadier-session-navigation-changed";
export function readArchive(): ArchiveData {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (saved) return saved;
    const ids: string[] = JSON.parse(localStorage.getItem(idsKey) ?? "[]");
    return {
      settings: { ...archiveDefaults },
      entries: Object.fromEntries(
        ids.map((id) => [id, { archivedAt: Date.now(), needsReview: null }]),
      ),
      deleted: [],
    };
  } catch {
    return { settings: { ...archiveDefaults }, entries: {}, deleted: [] };
  }
}
function publish(data: ArchiveData) {
  const previous = new Set(readArchive().deleted);
  localStorage.setItem(key, JSON.stringify(data));
  localStorage.setItem(idsKey, JSON.stringify(Object.keys(data.entries)));
  for (const id of data.deleted) if (!previous.has(id)) retireSession(id);
  window.dispatchEvent(new Event(archiveEvent));
  return data;
}
export async function syncArchive() {
  return publish(
    desktop
      ? await invoke<ArchiveData>("archive_load", {
          legacy: Object.keys(readArchive().entries),
        })
      : readArchive(),
  );
}
export async function archiveSession(id: string, archived: boolean) {
  if (desktop)
    return publish(
      await invoke<ArchiveData>("archive_set", { sessionId: id, archived }),
    );
  const data = readArchive();
  if (archived)
    data.entries[id] ??= { archivedAt: Date.now(), needsReview: null };
  else delete data.entries[id];
  return publish(data);
}
export async function saveArchiveSettings(settings: ArchiveSettings) {
  if (
    !Number.isInteger(settings.retentionDays) ||
    settings.retentionDays < 1 ||
    settings.retentionDays > 36500
  )
    throw Error("Use a retention period between 1 and 36500 days.");
  return publish(
    desktop
      ? await invoke<ArchiveData>("archive_settings", { settings })
      : { ...readArchive(), settings },
  );
}
export async function deleteArchivedSession(
  sessionId: string,
  deleteWorktree: boolean,
  force: boolean,
) {
  if (desktop)
    return publish(
      await invoke<ArchiveData>("archive_delete", {
        sessionId,
        deleteWorktree,
        force,
      }),
    );
  const data = readArchive();
  delete data.entries[sessionId];
  data.deleted.push(sessionId);
  return publish(data);
}
function subscribe(update: () => void) {
  window.addEventListener(archiveEvent, update);
  window.addEventListener("storage", update);
  return () => {
    window.removeEventListener(archiveEvent, update);
    window.removeEventListener("storage", update);
  };
}
export function useSessionArchive() {
  const raw = useSyncExternalStore(subscribe, () => localStorage.getItem(key));
  return useMemo(readArchive, [raw]);
}
