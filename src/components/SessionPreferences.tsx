import { Checkbox } from "./controls/checkbox";
import { Button } from "./controls/button";
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
        <div className="commit-preferences flex flex-col gap-3 [&_label]:flex [&_label]:flex-col [&_label]:gap-2">
          <div className="segmented">
            <Button
              aria-pressed={scope === "global"}
              onClick={() => setScope("global")}
            >
              Global defaults
            </Button>
            <Button
              aria-pressed={scope === "project"}
              onClick={() => setScope("project")}
            >
              This project
            </Button>
          </div>
          {scope === "project" && (
            <Checkbox
              disabled={busy}
              checked={!override}
              onCheckedChange={(e) => void save(e ? null : { ...global })}
            >
              Use global defaults
            </Checkbox>
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
              <Checkbox
                key={key}
                checked={settings[key]}
                onCheckedChange={(e) => void save({ ...settings, [key]: e })}
              >
                {label}
              </Checkbox>
            ))}
          </fieldset>
          <p>
            Sessions can discover and read other project sessions. Creating sessions and
            sending messages respect both projects’ settings. Managing another session always asks for your confirmation. Turning
            off child management also requires confirmation for child sessions.
          </p>
          {error && (
            <p className="inline-error my-2 text-[13px] text-error" role="alert">
              {error}
            </p>
          )}
        </div>
      }
    />
  );
}
