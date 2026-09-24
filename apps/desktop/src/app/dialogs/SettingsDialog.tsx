import { useId, useState, type FormEvent } from "react";

import { ErrorLine, errorText, Field, RadioChoice, SwitchRow } from "@/app/dialogs/fields";
import {
  ModelSelector,
  type ModelGroup,
} from "@/components/assistant-ui/elements/model-selector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ModelChoice, PermissionLevel, Settings } from "@/ipc/generated";
import {
  ALWAYS_ASK_NOTE,
  builtInDefault,
  modelName,
  PERMISSION_DETAILS,
  PERMISSION_LABELS,
  PERMISSION_LEVELS,
  useModelGroups,
} from "@/lib/setup";
import { updateSettings } from "@/state/actions";
import { useApp } from "@/state/store";

/** The defaults new conversations start from. The full Settings screen comes in Phase 9. */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-full overflow-y-auto">
        {open && <SettingsForm onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  );
}

function SettingsForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const id = useId();
  const initial = useApp((s) => s.settings);
  const groups = useModelGroups();
  const [orchestrator, setOrchestrator] = useState(initial.defaultOrchestrator);
  const [chatModel, setChatModel] = useState(initial.defaultChatModel);
  const [permission, setPermission] = useState(initial.defaultPermission);
  const [queueEnabled, setQueueEnabled] = useState(initial.queueEnabled);
  const [hibernate, setHibernate] = useState(String(initial.hibernateAfterMinutes));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const automatic = builtInDefault(groups);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const minutes = Number(hibernate);
    if (!Number.isInteger(minutes) || minutes < 1) {
      setError("Hibernate after must be a whole number of minutes, at least 1.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Density (and anything changed elsewhere meanwhile) is taken from the latest settings.
      const next: Settings = {
        ...useApp.getState().settings,
        defaultOrchestrator: orchestrator,
        defaultChatModel: chatModel,
        defaultPermission: permission,
        queueEnabled,
        hibernateAfterMinutes: minutes,
      };
      await updateSettings(next);
      onOpenChange(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>
          Defaults for new sessions and chats. A project remembers its own choices, which win
          over these.
        </DialogDescription>
      </DialogHeader>

      <Field
        label="Orchestrator model"
        hint={
          orchestrator
            ? "Used by projects that have not remembered their own."
            : `Automatic: the first logged-in provider's default (${modelName(groups, automatic)}).`
        }
      >
        <DefaultModel groups={groups} value={orchestrator} fallback={automatic} onChange={setOrchestrator} />
      </Field>

      <Field
        label="Chat model"
        hint={
          chatModel
            ? "Used by new Chats."
            : "Automatic: the same as the orchestrator model."
        }
      >
        <DefaultModel
          groups={groups}
          value={chatModel}
          fallback={orchestrator ?? automatic}
          onChange={setChatModel}
        />
      </Field>

      <Field label="Permission level" hint={ALWAYS_ASK_NOTE}>
        <RadioChoice<PermissionLevel>
          label="Default permission level"
          value={permission}
          onChange={setPermission}
          options={PERMISSION_LEVELS.map((level) => ({
            value: level,
            label:
              level === "fullAccess" ? (
                <Badge className="bg-full-access/15 text-full-access">
                  {PERMISSION_LABELS[level]}
                </Badge>
              ) : (
                PERMISSION_LABELS[level]
              ),
            hint: PERMISSION_DETAILS[level],
          }))}
        />
      </Field>

      <SwitchRow
        label="Queue messages while a turn runs"
        hint="Off: a message sent while the model works steers the running turn instead."
        checked={queueEnabled}
        onCheckedChange={setQueueEnabled}
      />

      <Field
        label="Hibernate after (minutes)"
        htmlFor={`${id}-hibernate`}
        hint="An idle conversation stops its CLI processes and cleans up; it continues where it left off."
      >
        <Input
          id={`${id}-hibernate`}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={hibernate}
          className="max-w-xs"
          onChange={(event) => setHibernate(event.target.value)}
        />
      </Field>

      <p className="text-muted-foreground text-xs">
        Routing, secrets and the other settings arrive with the full Settings screen (Phase 9).
        Density is in the top bar.
      </p>
      <ErrorLine error={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A default model: "Automatic" (null) or a picked provider, model and effort. */
function DefaultModel({
  groups,
  value,
  fallback,
  onChange,
}: {
  groups: readonly ModelGroup[];
  value: ModelChoice | null;
  fallback: ModelChoice;
  onChange: (value: ModelChoice | null) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <ModelSelector
        groups={groups}
        value={value ?? fallback}
        onChange={onChange}
        className={value ? "text-foreground" : undefined}
      />
      {value ? (
        <Button type="button" variant="ghost" size="xs" onClick={() => onChange(null)}>
          Use automatic
        </Button>
      ) : (
        <span className="text-muted-foreground text-xs">Automatic</span>
      )}
    </div>
  );
}
