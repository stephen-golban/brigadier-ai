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
      titles: read<Record<string, string>>(titlesKey, {}),
      archivedIds: read<string[]>(archivedKey, []),
    }),
    [titles, archived],
  );
}
