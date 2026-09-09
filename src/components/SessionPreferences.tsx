import { useProviderCatalog } from "../providerCatalog";
import type { ModelInfo } from "../wire";
const noModels: ModelInfo[] = [];
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
  const {providers} = useProviderCatalog(noModels);
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
            <h3 className="mt-4 text-sm">Worker provider exclusions</h3>
            {providers.map(provider=><Checkbox key={provider.id} checked={!(settings.excludedProviders ?? []).includes(provider.id)} onCheckedChange={enabled=>void save({...settings,excludedProviders:enabled?(settings.excludedProviders ?? []).filter(id=>id!==provider.id):[...(settings.excludedProviders ?? []),provider.id]})}>{provider.label}</Checkbox>)}
            <label className="mt-3 text-xs">Excluded worker model IDs (one per line)
              <textarea key={`${scope}:${JSON.stringify(settings.excludedModels)}`} defaultValue={(settings.excludedModels ?? []).join('\n')} onBlur={e=>{const values=[...new Set(e.target.value.split('\n').map(v=>v.trim()).filter(Boolean))];if(JSON.stringify(values)!==JSON.stringify(settings.excludedModels ?? []))void save({...settings,excludedModels:values});}} className="min-h-16 rounded border border-hairline bg-canvas p-2" />
            </label>
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
