import type { Settings } from "@/ipc/generated";
import { request } from "@/ipc/client";
import {
  beginSettingsEdit,
  endSettingsEdit,
  settingsThrough,
  type SettingsEdit,
} from "@/state/store";

/**
 * Settings writes, one at a time. Every change is an edit of the latest settings: it shows at
 * once, then is sent when the write before it has answered, as the daemon's last answer with
 * the edits up to it applied. Answers and `settingsChanged` events only replace the confirmed
 * settings, so edits still waiting stay shown on top of them. A write that fails drops its
 * edit (the control goes back) and rejects, for the caller to report.
 *
 * Edits must be idempotent: one can be applied again to settings that already include it
 * (the daemon's event can arrive before its answer).
 */
let writes: Promise<unknown> = Promise.resolve();

export function editSettings(edit: SettingsEdit): Promise<Settings> {
  beginSettingsEdit(edit);
  const write = writes.then(async () => {
    try {
      const { settings } = await request({
        method: "updateSettings",
        settings: settingsThrough(edit),
      });
      return endSettingsEdit(edit, settings);
    } catch (error) {
      endSettingsEdit(edit, null);
      throw error;
    }
  });
  writes = write.catch(() => undefined);
  return write;
}

/** Sets one setting. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<Settings> {
  return editSettings((settings) => ({ ...settings, [key]: value }));
}
