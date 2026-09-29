import { ChevronDown, ChevronRight } from "@openai/apps-sdk-ui/components/Icon";
import { useMemo, useState } from "react";

import { openUrl } from "@/ipc/client";
import type { ModelGroup } from "@/components/assistant-ui/elements/model-selector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  Learned,
  MergedModel,
  OverrideRule,
  ProviderKind,
  TaskCategory,
  UsageView,
} from "@/ipc/generated";
import { formatDateTime, formatTokens } from "@/lib/format";
import {
  AREA_LABELS,
  CATEGORIES,
  CATEGORY_LABELS,
  formatDelta,
  newRuleId,
  PROVIDERS,
  ruleSentence,
  TIER_LABELS,
  VENDOR_LABELS,
} from "@/lib/routing";
import { cn } from "@/lib/utils";
import { useApp } from "@/state/store";
import { toast } from "@/state/toasts";
import { addOverride, setUsageProject, useUsage } from "@/state/usage";

/** Categories a model is scored for, as the grid's short heads. */
const CATEGORY_HEADS: Record<TaskCategory, string> = {
  scout: "Scout",
  research: "Research",
  implement: "Implement",
  review: "Review",
  merge: "Merge",
  verify: "Verify",
  chat: "Chat",
  orchestrate: "Orchestrate",
};

/** "Curated", "Trial 1/3", "Never routed". */
function statusLabel(model: MergedModel): string {
  if (model.excluded) return "Never routed";
  if (model.trial) return `Trial ${model.trial.outcomes}/${model.trial.needed}`;
  switch (model.status) {
    case "curated":
      return "Curated";
    case "inherited":
      return "Inherited";
    case "researched":
      return "Researched";
    case "unknown":
      return "Unknown";
  }
}

function statusHint(model: MergedModel): string {
  if (model.excluded) return "Brigadier never routes work to this model.";
  if (model.trial) {
    return `An unrated model trying out low-risk work (scouting, research, verification) until ${model.trial.needed} outcomes place it.`;
  }
  switch (model.status) {
    case "curated":
      return "Scored by the curated registry.";
    case "inherited":
      return `A newer version of a registry model (${model.registryKey ?? "its family"}): it inherits its scores until outcomes say otherwise.`;
    case "researched":
      return "Not in the registry yet: scored from a research run's findings.";
    case "unknown":
      return "Not in the registry and not researched yet.";
  }
}

const learnedKey = (provider: ProviderKind, model: string, category: TaskCategory) =>
  `${provider}\u0000${model}\u0000${category}`;

/** The merged model list, per provider, with what outcomes taught routing in the chosen project. */
export function ModelsSection({
  view,
  groups,
}: {
  view: UsageView;
  groups: readonly ModelGroup[];
}) {
  const projects = useApp((s) => s.projects);
  // The pick shows at once; the view says which project its adjustments are for once read.
  const picked = useUsage((s) => s.projectId);
  // Adjustments read for another project than the one picked are not shown while it is read.
  const forPicked = view.projectId === picked;
  const learned = useMemo(
    () =>
      new Map(
        forPicked
          ? view.learned.map((entry) => [learnedKey(entry.provider, entry.model, entry.category), entry])
          : [],
      ),
    [view.learned, forPicked],
  );
  const projectName = picked ? (projects[picked]?.name ?? "Project") : null;
  return (
    <section aria-labelledby="usage-models" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id="usage-models" className="min-w-0 flex-1 text-sm font-medium">
          Models
        </h2>
        <span className="text-muted-foreground text-xs">Learned in</span>
        <ProjectPicker projectId={picked} />
      </div>
      <p className="text-muted-foreground text-xs">
        Every model the installed agents offer, with its registry strengths per kind of work (0–10)
        and what outcomes {projectName ? `in ${projectName}` : "across your projects"} added or
        took away.
      </p>
      {PROVIDERS.map((provider) => {
        const models = view.models.filter((model) => model.provider === provider);
        if (models.length === 0) return null;
        const current = models.filter((model) => !model.legacy);
        const legacy = models.filter((model) => model.legacy);
        return (
          <div key={provider} className="flex flex-col gap-1">
            <h3 className="text-muted-foreground px-2 text-xs font-medium">
              {VENDOR_LABELS[provider]}
            </h3>
            <ul className="flex flex-col divide-y">
              {current.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  learned={learned}
                  projectId={picked}
                  groups={groups}
                />
              ))}
            </ul>
            {legacy.length > 0 && (
              <Collapsible>
                <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex items-center gap-1 px-2 py-1 text-xs">
                  <ChevronRight
                    aria-hidden
                    className="size-icon-xs transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                  />
                  {legacy.length} legacy {legacy.length === 1 ? "model" : "models"}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="flex flex-col divide-y">
                    {legacy.map((model) => (
                      <ModelRow
                        key={model.id}
                        model={model}
                        learned={learned}
                        projectId={picked}
                        groups={groups}
                      />
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** "All projects" or one project, for the learned adjustments. */
function ProjectPicker({ projectId }: { projectId: string | null }) {
  const projects = useApp((s) => s.projects);
  const list = Object.values(projects).toSorted((a, b) => a.name.localeCompare(b.name));
  const label = projectId ? (projects[projectId]?.name ?? "Project") : "All projects";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="outline" aria-label={`Learned in: ${label}`}>
          <span className="max-w-2xs truncate">{label}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={projectId ?? ""}
          onValueChange={(value) => setUsageProject(value === "" ? null : value)}
        >
          <DropdownMenuRadioItem value="">All projects</DropdownMenuRadioItem>
          {list.length > 0 && <DropdownMenuSeparator />}
          {list.map((project) => (
            <DropdownMenuRadioItem key={project.id} value={project.id}>
              {project.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function learnedHint(entry: Learned): string {
  const parts = [
    `${entry.samples} outcomes`,
    `${Math.round(entry.successRate * 100)}% succeeded`,
    entry.reviewPassRate !== null && `${Math.round(entry.reviewPassRate * 100)}% passed review first time`,
    entry.avgRework !== null && `${entry.avgRework.toFixed(1)} rework rounds on average`,
    entry.verificationPassRate !== null &&
      `${Math.round(entry.verificationPassRate * 100)}% passed verification`,
    entry.medianDurationMs !== null && `median ${Math.round(entry.medianDurationMs / 60_000)} min`,
    entry.medianTokens !== null && `median ${formatTokens(entry.medianTokens)} tokens`,
  ].filter((part): part is string => typeof part === "string");
  return `${parts.join(" · ")}: ${formatDelta(entry.adjustment)} to its score here.`;
}

function ModelRow({
  model,
  learned,
  projectId,
  groups,
}: {
  model: MergedModel;
  learned: ReadonlyMap<string, Learned>;
  projectId: string | null;
  groups: readonly ModelGroup[];
}) {
  const [open, setOpen] = useState(false);
  const rules = useApp((s) => s.settings.routingOverrides);
  const projects = useApp((s) => s.projects);
  const own = rules.filter(
    (rule) =>
      rule.target.provider === model.provider &&
      ((rule.target.type === "model" && rule.target.id === model.id) ||
        (rule.target.type === "family" && rule.target.family === model.family)),
  );
  return (
    <li data-slot="usage-model" className="flex flex-col gap-2 px-2 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-start"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "text-muted-foreground size-icon-xs shrink-0 transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <span className="truncate text-sm group-hover:underline">{model.displayName}</span>
          <span className="text-muted-foreground truncate font-mono text-2xs">{model.id}</span>
        </button>
        <Badge variant={model.trial ? "warning" : "secondary"} title={statusHint(model)}>
          {statusLabel(model)}
        </Badge>
        <Badge variant="outline" title="Quality tier">
          {TIER_LABELS[model.tier]}
        </Badge>
        {!model.excluded && <NeverMenu model={model} projectId={projectId} groups={groups} />}
      </div>
      <dl className="grid grid-cols-4 gap-x-3 gap-y-1 @md:grid-cols-8">
        {CATEGORIES.map((category) => {
          const strength = model.strengths[category];
          const entry = learned.get(learnedKey(model.provider, model.id, category));
          return (
            <div key={category} className="flex min-w-0 flex-col">
              <dt className="text-muted-foreground truncate text-2xs">{CATEGORY_HEADS[category]}</dt>
              <dd className="flex items-baseline gap-1 text-xs tabular-nums">
                <span>{strength ?? "–"}</span>
                {entry && entry.adjustment !== 0 && (
                  <span className="text-muted-foreground text-2xs" title={learnedHint(entry)}>
                    {formatDelta(entry.adjustment)}
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {own.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {own.map((rule) => (
            <li key={rule.id} className="text-muted-foreground text-xs">
              Your rule: {ruleSentence(rule, groups, projects)}
            </li>
          ))}
        </ul>
      )}
      {open && <ModelDetails model={model} />}
    </li>
  );
}

function ModelDetails({ model }: { model: MergedModel }) {
  const areas = Object.entries(model.areaStrengths).filter(([, value]) => value !== 0);
  const facts = [
    model.contextWindow !== null && `${formatTokens(model.contextWindow)} context`,
    model.knowledgeCutoff && `knowledge to ${model.knowledgeCutoff}`,
    model.efforts.length > 0 && `efforts ${model.efforts.join(", ")}`,
    `input ${model.modalities.input.join(", ")}`,
    model.modalities.tools.length > 0 &&
      model.modalities.tools.map((tool) => (tool === "webSearch" ? "web search" : "image generation")).join(", "),
    model.registryKey && `registry: ${model.registryKey}`,
    model.family && `family: ${model.family}`,
  ].filter((fact): fact is string => typeof fact === "string" && fact.length > 0);
  const research = model.research;
  return (
    <div className="ms-5 flex flex-col gap-2 text-xs">
      <p className="text-muted-foreground">{facts.join(" · ")}</p>
      {areas.length > 0 && (
        <p className="text-muted-foreground">
          By area:{" "}
          {areas
            .map(([area, value]) => `${AREA_LABELS[area as keyof typeof AREA_LABELS]} ${formatDelta(value ?? 0)}`)
            .join(", ")}
        </p>
      )}
      {research && (
        <div className="flex flex-col gap-1">
          <p>
            <span className="text-muted-foreground">
              Researched {formatDateTime(research.atMs)} · estimated {TIER_LABELS[research.tier]}:
            </span>{" "}
            {research.summary}
          </p>
          {research.sources.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {research.sources.map((source) => (
                <li key={source} className="min-w-0">
                  <button
                    type="button"
                    className="text-link max-w-full truncate text-start hover:underline"
                    title={source}
                    onClick={() =>
                      openUrl(source).catch((cause: unknown) =>
                        toast(`Couldn't open ${source}: ${cause instanceof Error ? cause.message : String(cause)}`, {
                          tone: "error",
                        }),
                      )
                    }
                  >
                    {source}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** "Never use for…": adds a rule keeping this model from one kind of work, or any. */
function NeverMenu({
  model,
  projectId,
  groups,
}: {
  model: MergedModel;
  projectId: string | null;
  groups: readonly ModelGroup[];
}) {
  const projects = useApp((s) => s.projects);
  const [scope, setScope] = useState<string>(projectId ?? "");
  const add = (categories: TaskCategory[]) => {
    const rule: OverrideRule = {
      id: newRuleId(),
      effect: "never",
      target: { type: "model", provider: model.provider, id: model.id },
      categories,
      areas: [],
      projectId: scope === "" ? null : scope,
      createdAtMs: Date.now(),
    };
    const sentence = ruleSentence(rule, groups, projects);
    addOverride(rule)
      .then(() => toast(`Added: ${sentence}.`))
      .catch((cause: unknown) =>
        toast(`Couldn't add the rule: ${cause instanceof Error ? cause.message : String(cause)}`, {
          tone: "error",
        }),
      );
  };
  const projectName = projectId ? projects[projectId]?.name : undefined;
  return (
    <DropdownMenu onOpenChange={(open) => open && setScope(projectId ?? "")}>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost">
          Never use for…
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-2xs">
        <DropdownMenuLabel>Never use {model.displayName} for</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => add([])}>Anything</DropdownMenuItem>
        {CATEGORIES.map((category) => (
          <DropdownMenuItem key={category} onSelect={() => add([category])}>
            {CATEGORY_LABELS[category].charAt(0).toUpperCase()}
            {CATEGORY_LABELS[category].slice(1)}
          </DropdownMenuItem>
        ))}
        {projectId && projectName && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={scope} onValueChange={setScope}>
              <DropdownMenuRadioItem value={projectId} onSelect={(event) => event.preventDefault()}>
                In {projectName}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="" onSelect={(event) => event.preventDefault()}>
                Everywhere
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
