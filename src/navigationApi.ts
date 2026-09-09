import { retireSession } from "./desktopApi";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import * as feed from "./feedStore";
import { desktop } from "./workspaceApi";
import { workbenchApi } from "./workbenchApi";
import { peerApi } from "./peerApi";

export type TrashKind = "project" | "session" | "note";
export interface TrashEntry {
  kind: TrashKind;
  id: string;
  title: string;
  projectId: string | null;
  sessionIds: string[];
  trashedAt: number;
}
export interface NavigationData {
  projectColors: Record<string, string>;
  pinnedSessions: string[];
  trash: TrashEntry[];
}
export interface TrashPreview {
  entry: TrashEntry;
  running: string[];
}
export const emptyNavigation: NavigationData = {
  projectColors: {},
  pinnedSessions: [],
  trash: [],
};
const storageKey = "brigadier:navigation:v1";
const changed = () =>
  window.dispatchEvent(new Event("brigadier-navigation-changed"));
export function isTrashed(
  data: NavigationData,
  kind: TrashKind,
  id: string | null,
) {
  return (
    id !== null &&
    data.trash.some(
      (t) =>
        (t.kind === kind && t.id === id) ||
        (kind === "session" && t.sessionIds.includes(id)),
    )
  );
}
function readSample(): NavigationData {
  return (
    JSON.parse(localStorage.getItem(storageKey) ?? "null") ??
    structuredClone(emptyNavigation)
  );
}
function updateSample(update: (data: NavigationData) => void): NavigationData {
  const data = readSample();
  update(data);
  localStorage.setItem(storageKey, JSON.stringify(data));
  return data;
}
async function publish(task: Promise<NavigationData>) {
  const data = await task;
  changed();
  window.dispatchEvent(new Event("workbench-data-changed"));
  return data;
}
async function previewSample(
  kind: TrashKind,
  id: string,
): Promise<TrashPreview> {
  const state = feed.getState();
  const peers = await peerApi.snapshot();
  let title = id,
    projectId: string | null = null;
  const ids = new Set<string>();
  if (kind === "project") {
    const project = (await bridge().listProjects()).find((p) => p.id === id);
    if (!project) throw Error("Project no longer exists");
    const names = (await workbenchApi.load()).projectNames;
    title = names?.[id] ?? project.name;
    projectId = id;
    Object.values(state.sessions)
      .filter((s) => s.projectId === id)
      .forEach((s) => ids.add(s.sessionId));
  } else if (kind === "session") {
    const session = state.sessions[id];
    if (!session) throw Error("Session no longer exists");
    title = peers.titles[id] ?? `Session ${id.slice(-6)}`;
    projectId = session.projectId;
    ids.add(id);
  } else {
    const note = (await workbenchApi.load()).notes.find((n) => n.id === id);
    if (!note) throw Error("Note no longer exists");
    title = note.title;
    projectId = note.projectId;
  }
  let added = true;
  while (added) {
    added = false;
    for (const [child, parent] of Object.entries(peers.origins))
      if (ids.has(parent) && !ids.has(child) && state.sessions[child]) {
        ids.add(child);
        added = true;
      }
  }
  return {
    entry: {
      kind,
      id,
      title,
      projectId,
      sessionIds: [...ids].sort(),
      trashedAt: 0,
    },
    running: [...ids].filter((s) =>
      ["running", "starting"].includes(state.sessions[s]?.status ?? ""),
    ),
  };
}
export const navigationApi = {
  load: (): Promise<NavigationData> =>
    desktop ? invoke("navigation_load") : Promise.resolve().then(readSample),
  customize: (
    kind: "name" | "color" | "pin",
    id: string,
    value: string | null,
  ): Promise<NavigationData> =>
    publish(
      desktop
        ? invoke("navigation_customize", { kind, id, value })
        : Promise.resolve().then(async () => {
            if (kind === "name") {
              const name = value?.trim();
              if (!name || name.length > 200)
                throw Error("Use a project name of 1–200 characters");
              await workbenchApi.renameProject(id, name);
              return readSample();
            }
            return updateSample((d) => {
              if (kind === "color") {
                if (value) d.projectColors[id] = value;
                else delete d.projectColors[id];
              } else {
                d.pinnedSessions = d.pinnedSessions.filter((s) => s !== id);
                if (value) d.pinnedSessions.push(id);
              }
            });
          }),
    ),
  icon: (projectId: string): Promise<string | null> =>
    desktop ? invoke("project_icon", { projectId }) : Promise.resolve(null),
  preview: (kind: TrashKind, id: string): Promise<TrashPreview> =>
    desktop ? invoke("trash_preview", { kind, id }) : previewSample(kind, id),
  move: (plan: TrashPreview): Promise<NavigationData> =>
    publish(
      desktop
        ? invoke("trash_move", {
            kind: plan.entry.kind,
            id: plan.entry.id,
            expectedSessions: plan.entry.sessionIds,
            expectedRunning: plan.running,
          })
        : Promise.resolve().then(async () => {
            if (isTrashed(readSample(), plan.entry.kind, plan.entry.id))
              return readSample();
            const fresh = await previewSample(plan.entry.kind, plan.entry.id);
            if (fresh.entry.sessionIds.join() !== plan.entry.sessionIds.join())
              throw Error(
                "Affected sessions changed. Review Move to Trash again.",
              );
            if (fresh.running.some((id) => !plan.running.includes(id)))
              throw Error(
                "A session started running. Review Move to Trash again.",
              );
            for (const id of fresh.running) await bridge().endSession(id);
            // The mock endSession acknowledges its final state directly; desktop verifies child exit.
            const now = await bridge().listSessions();
            feed.seedSessions(now);
            if (
              now.some(
                (s) =>
                  fresh.entry.sessionIds.includes(s.session_id) &&
                  ["running", "starting"].includes(s.status),
              )
            )
              throw Error("Sessions are still stopping. Try again.");
            return updateSample((d) => {
              if (!isTrashed(d, plan.entry.kind, plan.entry.id))
                d.trash.push({ ...plan.entry, trashedAt: Date.now() });
            });
          }),
    ),
  restore: (entry: TrashEntry): Promise<NavigationData> =>
    publish(
      desktop
        ? invoke("trash_restore", { kind: entry.kind, id: entry.id })
        : Promise.resolve().then(() =>
            updateSample((d) => {
              if (
                entry.kind !== "project" &&
                entry.projectId &&
                isTrashed(d, "project", entry.projectId)
              )
                throw Error("Restore the parent project first");
              d.trash = d.trash.filter(
                (t) => !(t.kind === entry.kind && t.id === entry.id),
              );
            }),
          ),
    ),
  purge: (entry: TrashEntry): Promise<NavigationData> =>
    publish(
      (desktop
        ? invoke<NavigationData>("trash_purge", {
            kind: entry.kind,
            id: entry.id,
          })
        : Promise.resolve().then(async () => {
            if (
              !readSample().trash.some(
                (t) => t.kind === entry.kind && t.id === entry.id,
              )
            )
              throw Error("Item is not in Trash");
            if (entry.kind === "note") await workbenchApi.deleteNote(entry.id);
            else {
              const existing = await bridge().listSessions();
              for (const id of entry.sessionIds)
                if (existing.some((s) => s.session_id === id))
                  await bridge().deleteSession(id, false);
              if (entry.kind === "project")
                await bridge().deleteProject(entry.id, false);
            }
            return updateSample((d) => {
              d.trash = d.trash.filter(
                (t) =>
                  !(t.kind === entry.kind && t.id === entry.id) &&
                  !(t.kind === "session" && entry.sessionIds.includes(t.id)),
              );
              d.pinnedSessions = d.pinnedSessions.filter(
                (s) => !entry.sessionIds.includes(s),
              );
              if (entry.kind === "project") delete d.projectColors[entry.id];
            });
          })
      ).then((data) => {
        entry.sessionIds.forEach(retireSession);
        if (entry.kind === "project")
          window.dispatchEvent(
            new CustomEvent("workbench-history-deleted", {
              detail: { projectId: entry.id },
            }),
          );
        if (entry.kind === "note")
          window.dispatchEvent(
            new CustomEvent("workbench-note-deleted", { detail: entry.id }),
          );
        return data;
      }),
    ),
};
export function useNavigationData() {
  const [data, setData] = useState<NavigationData>(emptyNavigation);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await navigationApi.load();
      if (request === sequence.current) {
        setData(next);
        setError(null);
        setLoaded(true);
      }
    } catch (e) {
      if (request === sequence.current) {
        setError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e));
      }
      throw e;
    }
  }, []);
  useEffect(() => {
    const reload = () => { void refresh().catch(() => {}); };
    reload();
    window.addEventListener("brigadier-navigation-changed", reload);
    window.addEventListener("storage", reload);
    return () => {
      ++sequence.current;
      window.removeEventListener("brigadier-navigation-changed", reload);
      window.removeEventListener("storage", reload);
    };
  }, [refresh]);
  return { data, error, loaded, refresh };
}
