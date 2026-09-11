import {
  documentKey,
  sessionLayoutsKey,
  type ProjectLayout,
} from "./workbenchState";

/** Every store that holds a terminal tab's layout, newest key first. */
const LAYOUT_KEYS = [sessionLayoutsKey, "brigadier:project-tabs:v1"];
const TERMINAL_PREFIX = "brigadier:terminal:";
export const terminalSnapshotKey = (tabId: string) => `${TERMINAL_PREFIX}${tabId}`;

/**
 * One warning per window for a `localStorage` write that did not land.
 *
 * The old code swallowed the failure whole (`TerminalView.tsx`, "bounded recovery is best
 * effort"), so the first time the origin hit its quota every other writer in the app — drafts,
 * layouts, scroll positions, session titles — started failing at the same moment with nothing on
 * the console to say so (`docs/research/lifecycle-bounds-audit-2026-09-11.md` §1.6, Gap 3).
 */
let warned = false;
function warnOnce(what: string, error: unknown) {
  if (warned) return;
  warned = true;
  console.warn(`brigadier: ${what}; local recovery data is not being saved`, error);
}

/** `QuotaExceededError` is name-checked, not `instanceof`-checked: WebKit throws a plain
 *  `DOMException` and Firefox historically threw `NS_ERROR_DOM_QUOTA_REACHED` (code 1014). */
function isQuota(error: unknown): boolean {
  const e = error as { name?: string; code?: number } | null;
  return (
    e?.name === "QuotaExceededError" ||
    e?.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    e?.code === 22 ||
    e?.code === 1014
  );
}

function terminalSnapshotKeys(): string[] {
  return Object.keys(localStorage).filter((key) => key.startsWith(TERMINAL_PREFIX));
}

/** Oldest first. A snapshot written before `at` existed sorts as the oldest of all. */
function byAge(keys: string[]): string[] {
  return keys
    .map((key) => {
      let at = 0;
      try {
        at = Number(JSON.parse(localStorage.getItem(key) ?? "{}").at) || 0;
      } catch {
        /* malformed: as good as oldest */
      }
      return { key, at };
    })
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.key);
}

/**
 * Write one terminal scrollback snapshot, giving the quota one chance to be recovered.
 *
 * A snapshot is ~200 lines of xterm output *with SGR escapes*, so a window that has opened many
 * terminals is the app's largest `localStorage` writer by far. On a quota failure the oldest half
 * of the snapshots — never the one being written — is dropped and the write is retried exactly
 * once; a second failure is reported, once, and gives up. Returns whether the value landed.
 */
export function writeTerminalSnapshot(tabId: string, value: object): boolean {
  const key = terminalSnapshotKey(tabId);
  const json = JSON.stringify({ ...value, at: Date.now() });
  try {
    localStorage.setItem(key, json);
    return true;
  } catch (error) {
    if (!isQuota(error)) {
      warnOnce("a terminal snapshot could not be written", error);
      return false;
    }
    const others = byAge(terminalSnapshotKeys().filter((k) => k !== key));
    for (const stale of others.slice(0, Math.max(1, Math.floor(others.length / 2))))
      localStorage.removeItem(stale);
    try {
      localStorage.setItem(key, json);
      return true;
    } catch (again) {
      warnOnce("local storage is full even after dropping old terminal snapshots", again);
      return false;
    }
  }
}

/** Remove one tab's snapshot. Called wherever a terminal tab leaves a layout. */
export function removeTerminalSnapshot(tabId: string) {
  localStorage.removeItem(terminalSnapshotKey(tabId));
}

/**
 * Drop every `brigadier:terminal:<tabId>` whose tab is in no persisted layout any more.
 *
 * The per-tab removal above covers a tab closed through the UI; this covers everything else — a
 * layout dropped wholesale, a crash between the close and the write, and every snapshot orphaned
 * before the removal existed. `live` carries the tab ids of any layout held in memory that may not
 * have been persisted yet, so a sweep can never delete a snapshot for an open terminal.
 */
export function sweepTerminalSnapshots(live: Iterable<string> = []) {
  const keep = new Set<string>(live);
  for (const key of LAYOUT_KEYS) {
    try {
      const layouts: Record<string, ProjectLayout> = JSON.parse(
        localStorage.getItem(key) ?? "{}",
      );
      for (const layout of Object.values(layouts))
        for (const tab of layout.tabs ?? []) keep.add(tab.id);
    } catch {
      // A malformed layout store is not a licence to delete recovery data it might have named.
      return 0;
    }
  }
  let removed = 0;
  for (const key of terminalSnapshotKeys())
    if (!keep.has(key.slice(TERMINAL_PREFIX.length))) {
      localStorage.removeItem(key);
      removed++;
    }
  return removed;
}

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
  for (const key of LAYOUT_KEYS) {
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
            removeTerminalSnapshot(tab.id);
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
