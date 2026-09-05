import { useCallback, useState } from "react";
import type { WorkspaceContext } from "./workspaceApi";
export interface ProjectTab {
  id: string;
  kind:
    "draft" | "session" | "terminal" | "file" | "diff" | "untitled" | "note";
  path: string;
  context: WorkspaceContext;
  root: string;
  staged?: boolean;
  turn?: string | null;
  recorded?: boolean;
  line?: number;
}
export interface ProjectLayout {
  tabs: ProjectTab[];
  active: string | null;
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
