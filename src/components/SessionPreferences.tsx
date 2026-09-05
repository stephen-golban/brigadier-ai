import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  defaultPeerSettings,
  workbenchApi,
  type WorkbenchData,
  type PeerSettings,
} from "../workbenchApi";
import { errorMessage } from "../workspaceApi";
export function SessionPreferences({
  projectId,
  data,
  onData,
  onClose,
}: {
  projectId: string;
  data: WorkbenchData;
  onData: (d: WorkbenchData) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"global" | "project">("global");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const global = data.peers ?? defaultPeerSettings;
  const override = data.projectPeers?.[projectId];
  const settings = scope === "global" ? global : (override ?? global);
  const save = async (next: PeerSettings | null) => {
    setBusy(true);
    try {
      onData(
        await workbenchApi.savePeerSettings(
          scope === "global" ? null : projectId,
          next,
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      title="Agent session settings"
      confirmLabel="Done"
      onCancel={onClose}
      onConfirm={async () => onClose()}
      body={
        <div className="commit-preferences">
          <div className="segmented">
            <button
              aria-pressed={scope === "global"}
              onClick={() => setScope("global")}
            >
              Global defaults
            </button>
            <button
              aria-pressed={scope === "project"}
              onClick={() => setScope("project")}
            >
              This project
            </button>
          </div>
          {scope === "project" && (
            <label>
              <input
                type="checkbox"
                disabled={busy}
                checked={!override}
                onChange={(e) =>
                  void save(e.target.checked ? null : { ...global })
                }
              />
              Use global defaults
            </label>
          )}
          <fieldset disabled={busy || (scope === "project" && !override)}>
            {(
              [
                ["createSessions", "Agents can create sessions"],
                ["messages", "Allow session peer messages"],
                [
                  "manageChildren",
                  "Agents can stop and close sessions they created",
                ],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={settings[key]}
                  onChange={(e) =>
                    void save({ ...settings, [key]: e.target.checked })
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <p>
            Managing another session always asks for your confirmation. Turning
            off child management also requires confirmation for child sessions.
          </p>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
      }
    />
  );
}
