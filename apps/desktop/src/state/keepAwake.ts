import { create } from "zustand";

import { request } from "@/ipc/client";
import type { KeepAwake, KeepAwakeStatus } from "@/ipc/generated";
import { setSetting } from "@/state/settings";

/**
 * Keeping the computer awake: the daemon applies the `keepAwake` settings; this holds how
 * that stands (active now, whether the lid option is ready) for the status bar and Settings.
 */

export const useKeepAwake = create<{
  status: KeepAwakeStatus | null;
  settingUp: boolean;
}>(() => ({ status: null, settingUp: false }));

/** Applies the settings in the daemon and fetches how keeping awake stands. */
export async function loadKeepAwake(): Promise<void> {
  const { status } = await request({ method: "getKeepAwake" });
  useKeepAwake.setState({ status });
}

export async function setKeepAwake(keepAwake: KeepAwake): Promise<void> {
  await setSetting("keepAwake", keepAwake);
  await loadKeepAwake();
}

/**
 * Turns staying awake with the lid closed on or off. The first time on macOS this asks for
 * an administrator password; without it, the option stays off.
 */
export async function setKeepAwakeLidClosed(on: boolean): Promise<void> {
  await setSetting("keepAwakeLidClosed", on);
  if (!on || useKeepAwake.getState().status?.lidClosed !== "needsSetup") {
    await loadKeepAwake();
    return;
  }
  useKeepAwake.setState({ settingUp: true });
  try {
    const { status } = await request({ method: "setUpLidClosed" });
    useKeepAwake.setState({ status });
    if (status.lidClosed === "needsSetup") {
      await setSetting("keepAwakeLidClosed", false);
    }
  } finally {
    useKeepAwake.setState({ settingUp: false });
  }
}

export const KEEP_AWAKE_OPTIONS: readonly {
  value: KeepAwake;
  label: string;
  hint: string;
}[] = [
  {
    value: "always",
    label: "On",
    hint: "Keep this computer awake continuously",
  },
  {
    value: "agents",
    label: "Agents",
    hint: "Stay awake while an agent is working",
  },
  { value: "off", label: "Off", hint: "Allow normal system sleep" },
];

/** What the lid option does, as it stands now. */
export function lidClosedHint(status: KeepAwakeStatus | null, settingUp: boolean): string {
  if (settingUp) return "Waiting for the administrator password…";
  switch (status?.lidClosed) {
    case "needsSetup":
      return "Asks for your administrator password once.";
    case "active":
      return "Sleep is off, even with the lid closed. Keep it plugged in.";
    case "ready":
      return "Applied whenever the computer is kept awake. Best plugged in.";
    default:
      return "Applied whenever the computer is kept awake.";
  }
}
