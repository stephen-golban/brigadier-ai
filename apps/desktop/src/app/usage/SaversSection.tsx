import { useAction } from "@/app/conversation/useAction";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@/app/settings/parts";
import type { UsageSettings } from "@/ipc/generated";
import { editSettings } from "@/state/settings";
import { useApp } from "@/state/store";

/** The usage savers still being measured (PLAN.md §7), for the Usage page and Settings search. */
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
} as const satisfies Record<string, { label: string; description: string }>;

type Saver = keyof typeof SAVER_ROWS;

/** The usage savers' switches, each applied at once. */
export function SaversSection() {
  return (
    <SettingsSection
      title="Use less usage"
      description="Ways to spend less of the usage windows that are still being measured."
    >
      <SettingsCard>
        {(Object.keys(SAVER_ROWS) as Saver[]).map((saver) => (
          <SaverRow key={saver} saver={saver} />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
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
        onCheckedChange={(on) =>
          save.run(() =>
            editSettings((settings) => ({
              ...settings,
              usage: { ...settings.usage, [saver]: on } satisfies UsageSettings,
            })),
          )
        }
      />
    </SettingsRow>
  );
}
