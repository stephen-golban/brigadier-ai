import { ChevronRight, Reload } from "@openai/apps-sdk-ui/components/Icon";
import { useMemo, useState } from "react";

import { useAction } from "@/app/conversation/useAction";
import { PROVIDER_LABELS } from "@/app/inspector/providers/shared";
import { learnedKey, ModelRow, ProjectPicker, RegistryCard } from "@/app/providers/models";
import { AdvancedRouting, ROUTING_ROWS, RoutingKinds } from "@/app/providers/routing";
import {
  SettingsButton,
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@/app/settings/parts";
import type { ModelGroup } from "@/components/assistant-ui/elements/model-selector";
import { ProviderGlyph } from "@/components/glyphs/provider-glyphs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useNow } from "@/hooks/use-now";
import type { Learned, MergedModel, ProviderKind, ProviderOverview } from "@/ipc/generated";
import { formatAgo, formatCountdown } from "@/lib/format";
import { byLength, PROVIDERS } from "@/lib/routing";
import { providerStatusText, useModelGroups } from "@/lib/setup";
import { cn } from "@/lib/utils";
import { openSettings, refreshProviders } from "@/state/actions";
import { blocksProvider, setProviderAllowed } from "@/state/routing";
import { useApp } from "@/state/store";
import { useUsage, useUsageRefresh } from "@/state/usage";

/** The Providers page's rows, for Settings search; the page renders this copy. */
export const PROVIDERS_ROWS = {
  providers: {
    label: "Providers",
    description: "The agents Brigadier runs, whether each is signed in, and turning one off.",
  },
  models: {
    label: "Models",
    description: "Each agent's models, what each is best for, and turning one off.",
  },
  whoDoesWhat: ROUTING_ROWS.simple,
  advanced: {
    label: "Advanced",
    description:
      "The full order and why, backup models, settings per project or area, rules like “never use this model for reviews”, and where the models' scores come from.",
  },
  registry: {
    label: "Model registry",
    description: "Where the models' strengths come from, and checking it for updates.",
  },
  rules: ROUTING_ROWS.rules,
} as const;

/**
 * The Providers page: the agents Brigadier runs, as a list beside the chosen agent's details
 * (its account, install, usage and models, each model with a switch); then who does what (one
 * choice per kind of work); then, closed, everything else routing and the models' scores offer.
 */
export function ProvidersPage() {
  useUsageRefresh();
  const view = useUsage((s) => s.view);
  const overviews = useApp((s) => s.providers.view?.providers);
  const groups = useModelGroups();
  const now = useNow(30_000);
  const refresh = useAction();
  const [selected, setSelected] = useState<ProviderKind>(PROVIDERS[0] ?? "claude");
  const picked = useUsage((s) => s.projectId);
  // Adjustments read for another project than the one picked are not shown while it is read.
  const forPicked = view?.projectId === picked;
  const learned = useMemo(
    () =>
      new Map<string, Learned>(
        forPicked && view
          ? view.learned.map((entry) => [learnedKey(entry.provider, entry.model, entry.category), entry])
          : [],
      ),
    [view, forPicked],
  );
  const checkedAtMs = Math.max(0, ...(overviews ?? []).map((overview) => overview.checkedAtMs ?? 0));

  return (
    <SettingsPage
      title="Providers"
      description="The agents Brigadier runs, their models, and which model does each kind of work."
      wide
      actions={
        <>
          {checkedAtMs > 0 && (
            <span className="text-muted-foreground text-xs">Checked {formatAgo(checkedAtMs, now)}</span>
          )}
          <SettingsButton
            aria-label="Check the agents again"
            disabled={refresh.busy}
            onClick={() => refresh.run(refreshProviders)}
          >
            <Reload className={refresh.busy ? "animate-spin motion-reduce:animate-none" : undefined} />
            Refresh
          </SettingsButton>
        </>
      }
    >
      <div
        data-slot="providers"
        className="bg-card border-divider rounded-settings flex min-h-0 overflow-hidden border"
      >
        <ul aria-label="Agents" className="border-divider flex w-64 shrink-0 flex-col border-e">
          {PROVIDERS.map((provider) => (
            <ProviderItem
              key={provider}
              provider={provider}
              overview={overviews?.find((entry) => entry.provider === provider)}
              selected={provider === selected}
              onSelect={() => setSelected(provider)}
            />
          ))}
        </ul>
        <div className="@container min-w-0 flex-1">
          <ProviderDetail
            provider={selected}
            overview={overviews?.find((entry) => entry.provider === selected)}
            models={view?.models.filter((model) => model.provider === selected) ?? null}
            learned={learned}
            projectId={picked}
            groups={groups}
            now={now}
          />
        </div>
      </div>

      <RoutingKinds groups={groups} />

      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-start gap-2 text-start">
          <ChevronRight
            aria-hidden
            className="text-muted-foreground size-icon-sm mt-0.5 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">{PROVIDERS_ROWS.advanced.label}</span>
            <span className="text-foreground/65 text-label">{PROVIDERS_ROWS.advanced.description}</span>
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-10 pt-6">
          <AdvancedRouting groups={groups} />
          <SettingsSection
            title="Model scores"
            description="Brigadier scores each model 0–10 per kind of work from the registry, then adjusts the scores from how its tasks went."
          >
            <SettingsCard>
              <SettingsRow
                label="Learned in"
                description="The project a model's details show the adjustments for, or all of them."
              >
                <ProjectPicker projectId={picked} />
              </SettingsRow>
            </SettingsCard>
          </SettingsSection>
          {view && <RegistryCard registry={view.registry} now={now} />}
        </CollapsibleContent>
      </Collapsible>
    </SettingsPage>
  );
}

/** An agent in the list: its logo, name and version, how it stands, and its switch. */
function ProviderItem({
  provider,
  overview,
  selected,
  onSelect,
}: {
  provider: ProviderKind;
  overview: ProviderOverview | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const on = useApp((s) => !s.settings.routingOverrides.some((rule) => blocksProvider(rule, provider)));
  const toggle = useAction();
  const status = overview?.status;
  const ready = status?.path != null && status.loggedIn;
  return (
    <li className="border-divider flex items-start gap-3 border-b px-4 py-3 last:border-b-0 has-[button[aria-current]]:bg-foreground/5">
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-start gap-2.5 rounded-xs text-start outline-none focus-visible:ring-2"
      >
        <ProviderGlyph provider={provider} className="size-icon-md mt-0.5 shrink-0" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className={cn("text-label truncate font-medium", !on && "text-muted-foreground")}>
            {PROVIDER_LABELS[provider]}
          </span>
          <span className="text-foreground/65 flex items-center gap-1.5 text-xs">
            {!ready && status && <span aria-hidden className="bg-warning size-1.5 shrink-0 rounded-full" />}
            <span className="line-clamp-2">{on ? providerStatusText(overview) : "Off"}</span>
          </span>
        </span>
      </button>
      <SettingsSwitch
        label={`Let Brigadier use ${PROVIDER_LABELS[provider]}`}
        checked={on}
        disabled={toggle.busy}
        onCheckedChange={(next) => toggle.run(() => setProviderAllowed(provider, next))}
      />
    </li>
  );
}

/** The chosen agent: its account and install, its usage at a glance, and its models. */
function ProviderDetail({
  provider,
  overview,
  models,
  learned,
  projectId,
  groups,
  now,
}: {
  provider: ProviderKind;
  overview: ProviderOverview | undefined;
  models: MergedModel[] | null;
  learned: ReadonlyMap<string, Learned>;
  projectId: string | null;
  groups: readonly ModelGroup[];
  now: number;
}) {
  const on = useApp((s) => !s.settings.routingOverrides.some((rule) => blocksProvider(rule, provider)));
  const status = overview?.status;
  const windows = (overview?.quota?.windows ?? []).toSorted(byLength);
  const current = models?.filter((model) => !model.legacy) ?? [];
  const older = models?.filter((model) => model.legacy) ?? [];
  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex items-center gap-2.5">
        <ProviderGlyph provider={provider} className="size-icon-lg shrink-0" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{PROVIDER_LABELS[provider]}</h2>
        {status?.version && (
          <span className="text-muted-foreground font-mono text-xs">v{status.version}</span>
        )}
      </div>

      {!on && (
        <p className="text-foreground/65 text-xs">
          Off: Brigadier won't hand {PROVIDER_LABELS[provider]} any work. Chats can still use it.
        </p>
      )}

      <SettingsCard>
        <SettingsRow label="Account" description={status?.guidance ?? undefined}>
          <span className="text-foreground/80 text-xs">{providerStatusText(overview)}</span>
        </SettingsRow>
        {status?.path && (
          <SettingsRow label="Installed at">
            <span className="text-foreground/80 truncate font-mono text-xs" title={status.path}>
              {status.path}
            </span>
          </SettingsRow>
        )}
        {windows.length > 0 && (
          <SettingsRow
            label="Usage"
            description={windows
              .map(
                (window) =>
                  `${window.label} ${Math.round(Math.min(100, Math.max(0, window.usedPercent)))}% used${
                    window.resetsAtMs !== null ? `, resets in ${formatCountdown(window.resetsAtMs, now)}` : ""
                  }`,
              )
              .join(" · ")}
          >
            <SettingsButton onClick={() => openSettings("usage")}>Open Usage</SettingsButton>
          </SettingsRow>
        )}
      </SettingsCard>

      <SettingsSection
        title={PROVIDERS_ROWS.models.label}
        description="Turn a model off and Brigadier won't hand it work. Details show its scores."
      >
        {models === null ? (
          <p className="text-muted-foreground text-xs">Reading the models…</p>
        ) : models.length === 0 ? (
          <p className="text-muted-foreground text-xs">No models listed yet.</p>
        ) : (
          <SettingsCard className={cn(!on && "opacity-60")}>
            {current.map((model) => (
              <ModelRow key={model.id} model={model} learned={learned} projectId={projectId} groups={groups} />
            ))}
            {older.length > 0 && (
              <Collapsible>
                <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex w-full items-center gap-1.5 px-4 py-2.5 text-xs">
                  <ChevronRight
                    aria-hidden
                    className="size-icon-xs transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                  />
                  {older.length} older {older.length === 1 ? "model" : "models"}
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col">
                  {older.map((model) => (
                    <ModelRow key={model.id} model={model} learned={learned} projectId={projectId} groups={groups} />
                  ))}
                </CollapsibleContent>
              </Collapsible>
            )}
          </SettingsCard>
        )}
      </SettingsSection>
    </div>
  );
}
