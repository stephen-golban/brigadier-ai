import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "./listeners";
import { desktop, errorMessage } from "./workspaceApi";
import { serializeComposerWrite } from "./composerApi";

export type ComposerMode = "auto" | "custom";
export type PermissionPolicy = "ask" | "approve" | "full";
export interface ExecutionSelection { provider: string; model: string | null; effort: string | null }
export interface ProjectComposerPreferences {
  mode: ComposerMode;
  permission: PermissionPolicy;
  manual: ExecutionSelection;
  isolated: boolean;
  baseBranch: string | null;
  workspacePath?: string | null;
  newBranch?: string | null;
}
export interface ExecutionChange {
  id: string; provider: string; previousProvider: string; model: string | null; effort: string | null; timestamp: number;
}
export interface TaskExecutionSettings {
  sessionId: string; projectId: string; mode: ComposerMode; permission: PermissionPolicy;
  execution: ExecutionSelection; isolated: boolean; baseBranch: string | null; changes: ExecutionChange[];
  workspacePath?: string | null; newBranch?: string | null;
}
export const defaultComposerPreferences = (): ProjectComposerPreferences => ({
  mode: "auto", permission: "approve", manual: { provider: "", model: null, effort: null }, isolated: true, baseBranch: null, workspacePath: null, newBranch: null,
});
const demoRead = <T,>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
};
export const taskSettingsApi = {
  subscribe: (apply: (settings: TaskExecutionSettings) => void): Promise<() => void> => desktop
    ? listen<TaskExecutionSettings>("task-execution-settings", event => apply(event.payload))
    : Promise.resolve((() => {
      const receive = (event: Event) => apply((event as CustomEvent<TaskExecutionSettings>).detail);
      window.addEventListener("demo-task-execution-settings", receive);
      return () => window.removeEventListener("demo-task-execution-settings", receive);
    })()),
  preferences: (projectId: string): Promise<ProjectComposerPreferences> => desktop
    ? invoke("project_composer_preferences", { projectId })
    : Promise.resolve(demoRead(`demo:composer:${projectId}`, defaultComposerPreferences())),
  savePreferences: (projectId: string, preferences: ProjectComposerPreferences): Promise<ProjectComposerPreferences> => {
    if (desktop) return invoke("save_project_composer_preferences", { projectId, preferences });
    localStorage.setItem(`demo:composer:${projectId}`, JSON.stringify(preferences));
    return Promise.resolve(preferences);
  },
  read: (sessionId: string): Promise<TaskExecutionSettings> => invoke("task_execution_settings", { sessionId }),
  update: (sessionId: string, settings: TaskExecutionSettings): Promise<TaskExecutionSettings> => invoke("update_task_execution_settings", { sessionId, settings: { mode: settings.mode, permission: settings.permission, execution: settings.execution } }),
};

export function useProjectComposerPreferences(projectId: string | null) {
  const [entry, setEntry] = useState<{ id: string | null; value: ProjectComposerPreferences; loaded: boolean }>({ id: null, value: defaultComposerPreferences(), loaded: false });
  const [error, setError] = useState<string | null>(null);
  const current = useRef(projectId); current.current = projectId;
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    let live = true;
    setError(null);
    setEntry({ id: projectId, value: defaultComposerPreferences(), loaded: false });
    if (projectId) void taskSettingsApi.preferences(projectId).then(value => {
      if (live) setEntry({ id: projectId, value, loaded: true });
    }).catch(e => { if (live) setError(`Settings could not be loaded: ${errorMessage(e)}`); });
    return () => { live = false; };
  }, [projectId]);
  const save = useCallback((value: ProjectComposerPreferences) => {
    if (!projectId) return;
    setEntry({ id: projectId, value, loaded: true }); setError(null);
    pending.current = serializeComposerWrite(`preferences:${projectId}`, () => taskSettingsApi.savePreferences(projectId, value));
    void pending.current.catch(e => { if (current.current === projectId) setError(`Settings not saved: ${errorMessage(e)}`); });
  }, [projectId]);
  return { value: entry.id === projectId ? entry.value : defaultComposerPreferences(), loaded: entry.id === projectId && entry.loaded, save, error, flush: () => pending.current };
}

export function useTaskExecutionSettings(sessionId: string | null, fallback?: TaskExecutionSettings) {
  const [settings, setSettings] = useState<TaskExecutionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = useRef(sessionId); current.current = sessionId;
  useEffect(() => {
    let live = true;
    setSettings(null); setError(null); setSaving(false);
    if (!sessionId) return;
    let observedEvent = false;
    const apply = (next: TaskExecutionSettings) => { if (live && next.sessionId === sessionId) setSettings(next); };
    const subscription = taskSettingsApi.subscribe(next => { if (next.sessionId === sessionId) { observedEvent = true; apply(next); } }).catch(e => { if (live) setError(`Settings updates unavailable: ${errorMessage(e)}`); return () => {}; });
    if (desktop) void taskSettingsApi.read(sessionId).then(next => { if (!observedEvent) apply(next); }).catch(e => { if (live && !observedEvent) setError(errorMessage(e)); });
    else { const saved = demoRead<TaskExecutionSettings | null>(`demo:task:${sessionId}`, null); if (saved) apply(saved); }
    return () => { live = false; void subscription.then(dispose => dispose()); };
  }, [sessionId]);
  const update = async (next: TaskExecutionSettings) => {
    if (!sessionId || saving) return;
    setSaving(true); setError(null);
    try {
      let accepted = next;
      if (desktop) accepted = await serializeComposerWrite(sessionId, () => taskSettingsApi.update(sessionId, next));
      else {
        const previous = settings ?? fallback;
        if (previous?.mode === "custom" && next.mode === "auto") throw new Error("A started Custom task cannot return to Auto.");
        if (previous && previous.execution.provider !== next.execution.provider) accepted = { ...next, changes: [...next.changes, { id: crypto.randomUUID(), previousProvider: previous.execution.provider, ...next.execution, timestamp: Date.now() }] };
        localStorage.setItem(`demo:task:${sessionId}`, JSON.stringify(accepted));
        const prefs = await taskSettingsApi.preferences(accepted.projectId);
        await taskSettingsApi.savePreferences(accepted.projectId, { ...prefs, mode: accepted.mode, permission: accepted.permission, ...(accepted.mode === "custom" ? { manual: accepted.execution } : {}) });
        window.dispatchEvent(new CustomEvent("demo-task-execution-settings", { detail: accepted }));
      }
      if (current.current === sessionId) setSettings(accepted);
    } catch (e) { if (current.current === sessionId) setError(errorMessage(e)); }
    finally { if (current.current === sessionId) setSaving(false); }
  };
  return { settings: settings?.sessionId === sessionId ? settings : desktop ? null : fallback ?? null, error, saving, update };
}
