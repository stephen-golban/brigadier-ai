import {
  documentKey,
  sessionLayoutsKey,
  type ProjectLayout,
} from "./workbenchState";

/** Remove recovery data even when the deleted chat has never been opened this run. */
export function removeSessionLocalData(sessionId: string) {
  for (const prefix of [
    "brigadier:startup:",
    "brigadier:scroll:",
    "brigadier:expanded:",
    "brigadier:read:",
    "draft:turn:",
    "composer-pending:",
    "composer-request:",
  ])
    localStorage.removeItem(`${prefix}${sessionId}`);
  for (const key of Object.keys(localStorage))
    if (key.startsWith("commit:") && key.endsWith(`:${sessionId}`))
      localStorage.removeItem(key);
  for (const key of [sessionLayoutsKey, "brigadier:project-tabs:v1"]) {
    try {
      const layouts: Record<string, ProjectLayout> = JSON.parse(
        localStorage.getItem(key) ?? "{}",
      );
      for (const [owner, layout] of Object.entries(layouts)) {
        let owned = false;
        try {
          owned = JSON.parse(owner)[1] === sessionId;
        } catch {
          /* legacy project ID */
        }
        const tabs = layout.tabs.filter((tab) => {
          const remove =
            owned ||
            tab.context.sessionId === sessionId ||
            (tab.kind === "session" && tab.path === sessionId);
          if (remove) {
            if (tab.kind !== "note") localStorage.removeItem(documentKey(tab));
            localStorage.removeItem(`brigadier:terminal:${tab.id}`);
          }
          return !remove;
        });
        if (owned) delete layouts[owner];
        else
          layouts[owner] = {
            ...layout,
            tabs,
            active: tabs.some((tab) => tab.id === layout.active)
              ? layout.active
              : (tabs[tabs.length - 1]?.id ?? null),
          };
      }
      localStorage.setItem(key, JSON.stringify(layouts));
    } catch {
      /* malformed unrelated recovery state must not block deletion */
    }
  }
  for (const key of [
    "brigadier:read-sessions",
    "brigadier:session-titles:v1",
    "brigadier:last-project-session",
    "brigadier:worker-panel-selection",
  ]) {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? "{}");
      delete value[sessionId];
      for (const [id, selected] of Object.entries(value))
        if (selected === sessionId) delete value[id];
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* unrelated state */
    }
  }
  try {
    const key = "brigadier:navigation:v1";
    const navigation = JSON.parse(localStorage.getItem(key) ?? "null");
    if (navigation) {
      navigation.pinnedSessions = navigation.pinnedSessions.filter(
        (id: string) => id !== sessionId,
      );
      navigation.trash = navigation.trash
        .filter(
          (entry: { kind: string; id: string }) =>
            entry.kind !== "session" || entry.id !== sessionId,
        )
        .map((entry: { sessionIds: string[] }) => ({
          ...entry,
          sessionIds: entry.sessionIds.filter((id) => id !== sessionId),
        }));
      localStorage.setItem(key, JSON.stringify(navigation));
    }
  } catch {
    /* unrelated navigation state */
  }
}
