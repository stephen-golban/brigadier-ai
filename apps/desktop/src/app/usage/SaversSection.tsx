import { useId, useState } from "react";

import { useAction } from "@/app/conversation/useAction";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@/app/settings/parts";
import { Input } from "@/components/ui/input";
import type { UsageSettings } from "@/ipc/generated";
import { editSettings } from "@/state/settings";
import { useApp } from "@/state/store";

/** The usage savers (PLAN.md §7), for the Usage page and Settings search. */
export const SAVER_ROWS = {
  rebirthWhenCacheExpired: {
    label: "Start over when the cache has expired",
    description:
      "A Claude orchestrator idle past its prompt cache's hour continues from a briefing instead of sending the whole conversation again. A note written before the cache expired carries what it knew.",
  },
  leanWorkerTools: {
    label: "Lean worker tools",
    description:
      "Claude workers start without the built-in tools they never use, so every request starts smaller.",
  },
  conciseReplies: {
    label: "Concise replies",
    description: "The orchestrator writes plain, short English, and workers keep their reports short.",
  },
  codePointers: {
    label: "Point to the code",
    description:
      "Workers are told to find code with Brigadier's code search before grepping or reading whole files, and Brain answers name the files they are about.",
  },
  buildRules: {
    label: "Rules for writing less code",
    description:
      "Implement and merge workers reuse what exists, add nothing the task doesn't need, and update every caller of what they change.",
  },
  workerHandoff: {
    label: "Hand long workers to a fresh session",
    description:
      "A worker whose context grows past the hand-off size writes a handoff note, and a fresh session of the same model continues from it, with the full transcript on disk.",
  },
} as const satisfies Record<string, { label: string; description: string }>;

const HANDOFF_ROW = {
  label: "Hand-off size",
  description: "A worker whose context passes this continues in a fresh session at its next pause.",
} as const;

type Saver = keyof typeof SAVER_ROWS;

/** The range the hand-off size accepts, in thousands of tokens. */
const HANDOFF_K = { min: 60, max: 4000 } as const;

/** The usage savers' switches, each applied at once, and the hand-off size while that is on. */
export function SaversSection() {
  const handoff = useApp((s) => s.settings.usage.workerHandoff);
  return (
    <SettingsSection
      title="Use less usage"
      description="Ways to spend less of the usage windows. Those that showed a saving at equal quality are on by default."
    >
      <SettingsCard>
        {(Object.keys(SAVER_ROWS) as Saver[]).map((saver) => (
          <SaverRow key={saver} saver={saver} />
        ))}
        {handoff && <HandoffSizeRow />}
      </SettingsCard>
    </SettingsSection>
  );
}

/** Sets one field of the usage savers, on the latest settings. */
function setUsage<K extends keyof UsageSettings>(key: K, value: UsageSettings[K]) {
  return editSettings((settings) => ({ ...settings, usage: { ...settings.usage, [key]: value } }));
}

function SaverRow({ saver }: { saver: Saver }) {
  const checked = useApp((s) => s.settings.usage[saver]);
  const save = useAction();
  const row = SAVER_ROWS[saver];
  return (
    <SettingsRow label={row.label} description={row.description} error={save.error}>
      <SettingsSwitch
        label={row.label}
        checked={checked}
        onCheckedChange={(on) => save.run(() => setUsage(saver, on))}
      />
    </SettingsRow>
  );
}

/** The hand-off size in thousands of tokens: saved when the field is left or on Enter. */
function HandoffSizeRow() {
  const id = useId();
  const tokens = useApp((s) => s.settings.usage.workerHandoffTokens);
  const thousands = Math.round(tokens / 1000);
  // What is typed, while it differs from the setting; else the setting.
  const [typed, setTyped] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const save = useAction();
  const text = typed ?? String(thousands);

  const commit = () => {
    if (typed === null) return;
    const value = Number(typed);
    if (!Number.isInteger(value) || value < HANDOFF_K.min || value > HANDOFF_K.max) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setTyped(null);
    if (value !== thousands) save.run(() => setUsage("workerHandoffTokens", value * 1000));
  };

  return (
    <SettingsRow
      label={HANDOFF_ROW.label}
      description={HANDOFF_ROW.description}
      htmlFor={id}
      error={
        invalid
          ? `A whole number of thousands of tokens, from ${HANDOFF_K.min} to ${HANDOFF_K.max.toLocaleString()}.`
          : save.error
      }
    >
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={HANDOFF_K.min}
        max={HANDOFF_K.max}
        step={10}
        value={text}
        aria-invalid={invalid || undefined}
        className="border-input bg-popover h-control-md rounded-control text-label w-18 [appearance:textfield] px-2.5 tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        onChange={(event) => setTyped(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") {
            // Esc here undoes the typing rather than leaving Settings.
            event.stopPropagation();
            setTyped(null);
            setInvalid(false);
          }
        }}
      />
      <span className="text-muted-foreground text-label">k tokens</span>
    </SettingsRow>
  );
}
