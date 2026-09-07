import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./workspaceApi";
import {
  workbenchApi,
  validateDisplayName,
  type WorkbenchData,
} from "./workbenchApi";

export interface LaunchPreferences {
  name: string;
  completed: boolean;
  introSeen: boolean;
  music: boolean;
  desktopReveal: boolean;
}
function preferences(data: WorkbenchData): LaunchPreferences {
  const name = data.nameConfirmed ? (data.displayName ?? "").trim() : "";
  return {
    name,
    completed: !!data.welcomeCompleted && !!name,
    introSeen: !!data.introSeen,
    music: data.launchMusic ?? true,
    desktopReveal: false,
  };
}
function changed() {
  window.dispatchEvent(new Event("workbench-data-changed"));
}
export const launchApi = {
  preferences: (): Promise<LaunchPreferences> =>
    desktop
      ? invoke("launch_preferences")
      : workbenchApi.load().then(preferences),
  status: (): Promise<{ ready: boolean; error: string | null }> =>
    desktop
      ? invoke("launch_status")
      : Promise.resolve({ ready: true, error: null }),
  seen: async () => {
    if (desktop) await invoke("launch_seen");
    else workbenchApi.saveLaunchPreferences({ introSeen: true });
  },
  complete: async (value: string): Promise<LaunchPreferences> => {
    const name = validateDisplayName(value);
    const result = desktop
      ? await invoke<LaunchPreferences>("launch_complete", { name })
      : preferences(
          workbenchApi.saveLaunchPreferences({
            displayName: name,
            nameConfirmed: true,
            welcomeCompleted: true,
            introSeen: true,
          }),
        );
    changed();
    return result;
  },
  music: async (music: boolean) => {
    if (desktop) await invoke("launch_music", { music });
    else workbenchApi.saveLaunchPreferences({ launchMusic: music });
    changed();
  },
  finish: async () => {
    if (desktop) await invoke("launch_finish");
  },
  reveal: async () => {
    if (desktop) await invoke("launch_reveal");
  },
  restart: async () => {
    if (desktop) await invoke("launch_restart");
    else location.reload();
  },
  replay: () => window.dispatchEvent(new Event("brigadier-replay-welcome")),
};
