import { useId, useState, type FormEvent } from "react";

import { ErrorLine, errorText, Field, RadioChoice, SwitchRow } from "@/app/dialogs/fields";
import { MemoriesSection } from "@/app/dialogs/MemoriesSection";
import { StorageSection } from "@/app/dialogs/StorageSection";
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
import type { Density, KeepAwake, ModelChoice, PermissionLevel, Settings } from "@/ipc/generated";
import {
  ALWAYS_ASK_NOTE,
  builtInDefault,
  modelName,
  PERMISSION_DETAILS,
  PERMISSION_LABELS,
  PERMISSION_LEVELS,
  useModelGroups,
} from "@/lib/setup";
import { setDensity, updateSettings } from "@/state/actions";
import {
  KEEP_AWAKE_OPTIONS,
  lidClosedHint,
  setKeepAwake,
  setKeepAwakeLidClosed,
  useKeepAwake,
} from "@/state/keepAwake";
import { reopenOnboarding } from "@/state/onboarding";
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
  const density = useApp((s) => s.settings.density);
  const groups = useModelGroups();
  const [orchestrator, setOrchestrator] = useState(initial.defaultOrchestrator);
  const [chatModel, setChatModel] = useState(initial.defaultChatModel);
  const [permission, setPermission] = useState(initial.defaultPermission);
  const [showContext, setShowContext] = useState(initial.showContextUsage);
  const [fullAccessNotice, setFullAccessNotice] = useState(initial.showFullAccessNotice);
  const [hibernate, setHibernate] = useState(String(initial.hibernateAfterMinutes));
  const [enrichBrain, setEnrichBrain] = useState(initial.enrichBrain);
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
        showContextUsage: showContext,
        showFullAccessNotice: fullAccessNotice,
        hibernateAfterMinutes: minutes,
        enrichBrain,
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
            hint: `${PERMISSION_DETAILS[level]}.`,
          }))}
        />
      </Field>

      <Field label="Density">
        <RadioChoice<Density>
          label="Density"
          value={density}
          // Applied at once, so the whole app tightens or loosens while you choose.
          onChange={(value) => void setDensity(value).catch((cause: unknown) => setError(errorText(cause)))}
          options={[
            { value: "compact", label: "Compact", hint: "Smaller controls and tighter spacing." },
            { value: "normal", label: "Normal", hint: "The default sizes and spacing." },
          ]}
        />
      </Field>

      <KeepAwakeSettings onError={setError} />

      <SwitchRow
        label="Show context window usage"
        hint="A ring by the model picker in the composer shows how full the model's context is."
        checked={showContext}
        onCheckedChange={setShowContext}
      />

      <SwitchRow
        label="Show the Full access notice"
        hint="A card above the composer while a conversation's workers run without the OS sandbox."
        checked={fullAccessNotice}
        onCheckedChange={setFullAccessNotice}
      />

      <SwitchRow
        label="Use spare quota to deepen the Brain"
        hint="Before a usage window resets with quota left, a cheap model studies your projects further."
        checked={enrichBrain}
        onCheckedChange={setEnrichBrain}
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

      <MemoriesSection />

      <StorageSection onOpenStorage={() => onOpenChange(false)} />

      <p className="text-muted-foreground text-xs">
        Routing, secrets and the other settings arrive with the full Settings screen (Phase 9).
      </p>
      <ErrorLine error={error} />
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          className="me-auto"
          onClick={() => {
            onOpenChange(false);
            reopenOnboarding();
          }}
        >
          Run setup again
        </Button>
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
        defaultChoice={fallback}
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

/** Keeping the computer awake, applied at once (like the status bar's menu). */
function KeepAwakeSettings({ onError }: { onError: (error: string | null) => void }) {
  const keepAwake = useApp((s) => s.settings.keepAwake);
  const lidClosed = useApp((s) => s.settings.keepAwakeLidClosed);
  const status = useKeepAwake((s) => s.status);
  const settingUp = useKeepAwake((s) => s.settingUp);
  const run = (action: () => Promise<void>) => {
    onError(null);
    action().catch((cause: unknown) => onError(errorText(cause)));
  };
  return (
    <>
      <Field label="Keep the computer awake">
        <RadioChoice<KeepAwake>
          label="Keep the computer awake"
          value={keepAwake}
          onChange={(value) => run(() => setKeepAwake(value))}
          options={KEEP_AWAKE_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label,
            hint: `${option.hint}.`,
          }))}
        />
      </Field>
      {status?.lidClosed !== "unsupported" && (
        <SwitchRow
          label="Keep going with the lid closed"
          hint={lidClosedHint(status, settingUp)}
          checked={lidClosed}
          onCheckedChange={(on) => run(() => setKeepAwakeLidClosed(on))}
        />
      )}
    </>
  );
}
