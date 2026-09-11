import { notify } from "./desktopApi";
import { openSettings, viewChat } from "./settingsNavigation";
import { archiveSession } from "./sessionArchive";
import { useMemo, useSyncExternalStore } from "react";

const titlesKey = "brigadier:session-titles:v1";
const archivedKey = "brigadier:archived-sessions:v1";
const eventName = "brigadier-session-navigation-changed";
function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
/**
 * One parse per key per distinct stored string, shared by every caller in the window.
 *
 * `useSessionNavigation` is mounted once per `SessionMenu` — one per session row — plus the
 * sidebar, the composer and `usePeers`, and each mount used to `JSON.parse` both keys for itself.
 * The cache is keyed on the raw string, so a `getItem` (no parse) is all a hit costs and a write
 * from any source invalidates it without a subscription: the `brigadier-session-navigation-changed`
 * and `storage` events `subscribe` already listens to re-run the getters, which then see a
 * different raw string and re-parse. The values handed out are read-only to their callers; the
 * writers here build a fresh object and go through `write`.
 */
const noTitles: Record<string, string> = Object.freeze({});
const noArchived: string[] = [];
const parsed = new Map<string, { raw: string | null; value: unknown }>();
function cachedRead<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  const hit = parsed.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  const value = read(key, fallback);
  parsed.set(key, { raw, value });
  return value;
}
function write(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new Event(eventName));
}
function subscribe(update: () => void) {
  window.addEventListener(eventName, update);
  window.addEventListener("storage", update);
  return () => {
    window.removeEventListener(eventName, update);
    window.removeEventListener("storage", update);
  };
}
export function renameSession(id: string, name: string) {
  const title = name.trim();
  if (!title || title.length > 200)
    throw new Error("Use a session name of 1–200 characters.");
  write(titlesKey, {
    ...read<Record<string, string>>(titlesKey, {}),
    [id]: title,
  });
}
export async function setSessionArchived(id: string, archived: boolean) {
  await archiveSession(id, archived);
  notify(archived ? "Archived chat" : "Unarchived chat", false, undefined, {
    icon: "archive",
    actions: archived
      ? [
          {
            label: "View",
            onClick: () => openSettings({ page: "archived", sessionId: id }),
          },
          {
            label: "Undo",
            primary: true,
            onClick: () => setSessionArchived(id, false),
          },
        ]
      : [{ label: "View", primary: true, onClick: () => viewChat(id) }],
  });
}
export function useSessionNavigation() {
  const titles = useSyncExternalStore(subscribe, () =>
    localStorage.getItem(titlesKey),
  );
  const archived = useSyncExternalStore(subscribe, () =>
    localStorage.getItem(archivedKey),
  );
  return useMemo(
    () => ({
      titles: cachedRead<Record<string, string>>(titlesKey, noTitles),
      archivedIds: cachedRead<string[]>(archivedKey, noArchived),
    }),
    [titles, archived],
  );
}
