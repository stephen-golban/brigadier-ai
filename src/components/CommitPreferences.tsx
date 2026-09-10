import { useState } from "react";
import { Checkbox } from "./controls/checkbox";
import { Button } from "@/components/ui/button";
import { SelectMenu } from "./SelectMenu";
import { errorMessage } from "../workspaceApi";
import {
  workbenchApi,
  defaultSettings,
  type CommitSettings,
  type WorkbenchData,
} from "../workbenchApi";
import type { ModelInfo } from "../wire";
export function CommitPreferences({
  data,
  projectId,
  models,
  changed,
}: {
  data: WorkbenchData;
  projectId: string;
  models: ModelInfo[];
  changed: (data: WorkbenchData) => void;
}) {
  const [scope, setScope] = useState<"project" | "global">("project");
  const [error, setError] = useState("");
  const override = data.projects[projectId];
  const settings =
    (scope === "global" ? data.global : (override ?? data.global)) ??
    defaultSettings;
  const save = (next: CommitSettings | null) =>
    void workbenchApi
      .saveSettings(scope === "global" ? null : projectId, next)
      .then(changed)
      .catch((e) => setError(errorMessage(e)));
  return (
    <div className="commit-preferences flex flex-col gap-3 [&_label]:flex [&_label]:flex-col [&_label]:gap-2">
      <div className="segmented">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={scope === "global"}
          onClick={() => setScope("global")}
        >
          Global defaults
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={scope === "project"}
          onClick={() => setScope("project")}
        >
          This project
        </Button>
      </div>
      {scope === "project" && (
        <Checkbox
          checked={!override}
          onCheckedChange={(e) => save(e ? null : { ...data.global })}
        >
          Use global defaults
        </Checkbox>
      )}
      <fieldset disabled={scope === "project" && !override}>
        <SelectMenu
          label="Commit message model"
          value={settings.model}
          searchable
          options={[
            {
              value: "auto",
              label: "Auto",
              description: "Cheapest available model from this CLI",
            },
            { value: "session", label: "Session model" },
            ...models.map((m) => ({ value: m.id, label: m.label })),
          ]}
          onChange={(model) => save({ ...settings, model })}
        />
        <Checkbox
          checked={settings.coAuthor}
          onCheckedChange={(e) => save({ ...settings, coAuthor: e })}
        >
          Include “Co-authored-by”
        </Checkbox>
        <Checkbox
          checked={settings.smartCommit}
          onCheckedChange={(e) => save({ ...settings, smartCommit: e })}
        >
          Smart commit when nothing is staged
        </Checkbox>
        <label>
          Untracked files
          <SelectMenu
            label="Untracked files"
            value={settings.untracked}
            onChange={(value) =>
              save({
                ...settings,
                untracked: value as CommitSettings["untracked"],
              })
            }
            options={[
              { value: "mixed", label: "With Changes" },
              { value: "separate", label: "Separate group" },
              { value: "hidden", label: "Hidden" },
            ]}
          />
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="inline-error my-2 text-[13px] text-error">
          {error}
        </p>
      )}
    </div>
  );
}
