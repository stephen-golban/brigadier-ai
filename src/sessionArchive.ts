import { invoke } from "@tauri-apps/api/core";
import { useMemo, useSyncExternalStore } from "react";
import { desktop } from "./workspaceApi";
import { peerApi } from "./peerApi";
import { retireSession } from "./desktopApi";
export interface ArchiveSettings {
  autoDelete: boolean;
  retentionDays: number;
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
};
const key = "brigadier:session-archive:v1";
const idsKey = "brigadier:archived-sessions:v1";
export const archiveEvent = "brigadier-session-navigation-changed";
export function readArchive(): ArchiveData {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (saved)
      return {
        ...saved,
        settings: {
          autoDelete: saved.settings?.autoDelete ?? true,
          retentionDays: saved.settings?.retentionDays ?? 7,
        },
      };
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
  const { origins } = await peerApi.snapshot();
  const ids = chatSessionIds(id, origins);
  const data = readArchive();
  for (const member of ids) {
    if (archived)
      data.entries[member] ??= { archivedAt: Date.now(), needsReview: null };
    else delete data.entries[member];
  }
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
/** A chat is the root session and all of its descendants. */
export function chatSessionIds(
  id: string,
  origins: Record<string, string>,
): string[] {
  if (origins[id])
    throw new Error("Manage subagents through their parent chat.");
  const ids = new Set([id]);
  for (;;) {
    const before = ids.size;
    for (const [child, parent] of Object.entries(origins))
      if (ids.has(parent)) ids.add(child);
    if (ids.size === before) return [...ids];
  }
}
export async function deleteArchivedSession(sessionId: string) {
  if (desktop)
    return publish(await invoke<ArchiveData>("archive_delete", { sessionId }));
  const { origins } = await peerApi.snapshot();
  const ids = chatSessionIds(sessionId, origins);
  const data = readArchive();
  if (!data.entries[sessionId])
    throw new Error("Only archived chats can be deleted here.");
  for (const id of ids) {
    delete data.entries[id];
    if (!data.deleted.includes(id)) data.deleted.push(id);
  }
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
