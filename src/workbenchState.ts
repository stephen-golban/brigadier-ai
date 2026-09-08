import { useCallback, useState } from "react";
import type { WorkspaceContext } from "./workspaceApi";
export interface ProjectTab {
  id: string;
  kind:
    | "files"
    | "draft"
    | "session"
    | "terminal"
    | "file"
    | "diff"
    | "untitled"
    | "note";
  path: string;
  context: WorkspaceContext;
  root: string;
  staged?: boolean;
  turn?: string | null;
  recorded?: boolean;
  line?: number;
  terminalGroup?: string;
  shell?: string;
  terminalCwd?: string;
  terminalWeight?: number;
}
export interface ProjectLayout {
  tabs: ProjectTab[];
  active: string | null;
  terminalOpen?: boolean;
  activeTerminal?: string;
  terminalHeight?: number;
}
export const sessionLayoutsKey = "brigadier:session-workspaces:v2";
export function workspaceKey(projectId: string, sessionId: string | null) {
  return JSON.stringify([projectId, sessionId]);
}
/** One-time migration keeps recovery-buffer IDs intact and assigns root files to the
 * project's most recently selected session. The old layout remains as recovery data. */
export function migrateSessionLayouts(): Record<string, ProjectLayout> {
  try {
    const old: Record<string, ProjectLayout> = JSON.parse(
      localStorage.getItem("brigadier:project-tabs:v1") ?? "{}",
    );
    const result: Record<string, ProjectLayout> = {};
    for (const [projectId, layout] of Object.entries(old)) {
      const active = layout.tabs.find((t) => t.id === layout.active);
      const fallback =
        active?.context.sessionId ??
        layout.tabs.find((t) => t.kind === "session")?.path ??
        null;
      for (const tab of layout.tabs) {
        if (tab.kind === "files") continue;
        const sessionId =
          tab.kind === "session"
            ? tab.path
            : tab.kind === "draft"
              ? null
              : (tab.context.sessionId ?? fallback);
        const key = workspaceKey(projectId, sessionId);
        const target = (result[key] ??= { tabs: [], active: null });
        target.tabs.push(
          tab.kind === "terminal"
            ? { ...tab, context: { projectId, sessionId } }
            : tab,
        );
        if (tab.kind === "terminal") {
          target.activeTerminal = tab.id;
          target.terminalOpen ||= tab.id === layout.active;
        } else if (tab.id === layout.active || !target.active)
          target.active = tab.id;
      }
    }
    return result;
  } catch {
    return {};
  }
}
export function useStoredState<T>(
  key: string,
  fallback: T,
): [T, (next: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
    } catch {
      return fallback;
    }
  });
  const write = useCallback(
    (next: T | ((previous: T) => T)) =>
      setValue((previous) => {
        const value =
          typeof next === "function"
            ? (next as (previous: T) => T)(previous)
            : next;
        try {
          localStorage.setItem(key, JSON.stringify(value));
        } catch {
          window.dispatchEvent(new CustomEvent("brigadier-storage-error"));
        }
        return value;
      }),
    [key],
  );
  return [value, write];
}
export const documentKey = (t: ProjectTab) => `brigadier:buffer:${t.id}`;
export function languageFor(path: string) {
  return (
    (
      {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        json: "json",
        css: "css",
        html: "html",
        md: "markdown",
        rs: "rust",
        py: "python",
        sh: "shell",
        yml: "yaml",
        yaml: "yaml",
        sql: "sql",
      } as Record<string, string>
    )[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"
  );
}

export function hasSavedEdits(t: ProjectTab) {
  try {
    const b = JSON.parse(localStorage.getItem(documentKey(t)) ?? "null");
    return !!b && b.content !== (b.before ?? "");
  } catch {
    return false;
  }
}
