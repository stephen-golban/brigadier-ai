import {
  Bolt,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Regenerate,
} from "@openai/apps-sdk-ui/components/Icon";
import { Slider as SliderPrimitive } from "radix-ui";
import { useState } from "react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ModelChoice, ModelInfo, ProviderKind } from "@/ipc/generated";
import { cn } from "@/lib/utils";

/** "xhigh" → "Extra high", "medium" → "Medium". */
export function effortLabel(effort: string): string {
  const known: Record<string, string> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
  };
  return known[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** A provider's live model list, as the selector offers it. */
export type ModelGroup = {
  provider: ProviderKind;
  label: string;
  models: readonly ModelInfo[];
  /** Why the provider can't be picked (not installed, not logged in). */
  unavailable: string | null;
};

export function findModel(groups: readonly ModelGroup[], choice: ModelChoice): ModelInfo | null {
  const group = groups.find((entry) => entry.provider === choice.provider);
  if (!group) return null;
  return (
    group.models.find((model) =>
      choice.model === null ? model.isDefault : model.id === choice.model,
    ) ?? null
  );
}

/** "Opus 5.5 · High": the choice as the trigger shows it. */
export function choiceLabel(groups: readonly ModelGroup[], choice: ModelChoice): string {
  const model = findModel(groups, choice);
  const name = model?.displayName ?? choice.model ?? "Default model";
  return choice.effort ? `${name} · ${effortLabel(choice.effort)}` : name;
}

/**
 * Keeps an effort only if the model accepts it; otherwise the model's default (none for a model
 * without efforts). An unknown model keeps it.
 */
export function effortFor(model: ModelInfo | null, effort: string | null): string | null {
  if (!model) return effort;
  if (model.efforts.length === 0) return null;
  if (effort && model.efforts.includes(effort)) return effort;
  return model.defaultEffort;
}

/**
 * ChatGPT's model and effort picker. The trigger reads "Opus 5.5 High"; it opens on the effort:
 * the effort in use over the model's name (which opens the model list), a reset to the model's
 * default effort, and a slider with one stop per effort the model accepts. A model without
 * efforts opens on the model list.
 */
export function ModelSelector({
  groups,
  value,
  onChange,
  label = "Model",
  disabled,
  className,
  open: shown,
  onOpenChange,
}: {
  groups: readonly ModelGroup[];
  value: ModelChoice;
  onChange: (choice: ModelChoice) => void;
  label?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  /** Opens the picker from elsewhere (the composer's `/model`); uncontrolled when absent. */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const [own, setOwn] = useState(false);
  const open = shown ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const [listing, setListing] = useState(false);
  const current = findModel(groups, value);
  const effort = effortFor(current, value.effort);
  const name = current?.displayName ?? value.model ?? "Default model";
  const models = listing || !current || current.efforts.length === 0;
  const fast = value.fast === true && Boolean(current?.fast);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setListing(false);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label={label}
          disabled={disabled}
          data-slot="model-selector-trigger"
          className={cn("text-muted-foreground min-w-0 justify-between", className)}
        >
          {open && !models ? (
            <span className="truncate">Select effort</span>
          ) : (
            <>
              {fast && <Bolt aria-label="Fast" className="text-foreground/80 shrink-0" />}
              <span className="text-foreground/80 truncate">{name}</span>
              {effort && <span className="shrink-0">{effortLabel(effort)}</span>}
            </>
          )}
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-60 p-2">
        {models ? (
          <ModelList
            groups={groups}
            value={value}
            onBack={current && current.efforts.length > 0 ? () => setListing(false) : null}
            onPick={(model, provider) => {
              onChange({
                provider,
                model: model.id,
                effort: effortFor(model, value.effort),
                // Fast carries over to a model that has a fast tier too.
                ...(model.fast && value.fast ? { fast: true } : {}),
              });
              if (model.efforts.length > 0) setListing(false);
              else setOpen(false);
            }}
          />
        ) : (
          <EffortPanel
            model={current}
            effort={effort}
            fast={fast}
            onFast={(on) => onChange({ ...value, fast: on })}
            onEffort={(next) => onChange({ ...value, effort: next })}
            onModels={() => setListing(true)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The effort in use over the model's name, ChatGPT's fast mode toggle (for a model with a
 * fast tier), a reset, and the slider.
 */
function EffortPanel({
  model,
  effort,
  fast,
  onFast,
  onEffort,
  onModels,
}: {
  model: ModelInfo;
  effort: string | null;
  fast: boolean;
  onFast: (on: boolean) => void;
  onEffort: (effort: string | null) => void;
  onModels: () => void;
}) {
  const { efforts } = model;
  // While the CLI picks its own default no stop is true: the thumb shows only once moved.
  const index = effort === null ? -1 : efforts.indexOf(effort);
  return (
    <div data-slot="model-selector-effort" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        {model.fast ? (
          <TooltipIconButton
            tooltip={fast ? "Turn off fast mode" : `Enable fast mode: ${model.fast}`}
            size="icon-md"
            aria-pressed={fast}
            data-slot="model-selector-fast"
            className={cn(fast && "text-link")}
            onClick={() => onFast(!fast)}
          >
            <Bolt />
          </TooltipIconButton>
        ) : (
          <span aria-hidden className="size-icon-button-md" />
        )}
        <button
          type="button"
          aria-label="Select model"
          onClick={onModels}
          className="hover:bg-foreground/5 rounded-control flex min-w-0 flex-col items-center px-2 py-0.5"
        >
          <span className="text-link flex items-center gap-0.5 text-sm">
            {effort ? effortLabel(effort) : "Default"}
            <ChevronRight className="size-icon-xs" />
          </span>
          <span className="text-muted-foreground max-w-full truncate text-xs">{model.displayName}</span>
        </button>
        <TooltipIconButton
          tooltip="Reset to default"
          size="icon-md"
          disabled={effort === model.defaultEffort}
          onClick={() => onEffort(model.defaultEffort)}
        >
          <Regenerate />
        </TooltipIconButton>
      </div>
      {efforts.length > 1 && (
        <SliderPrimitive.Root
          min={0}
          max={efforts.length - 1}
          step={1}
          value={[Math.max(0, index)]}
          onValueChange={([next]) => onEffort((next !== undefined && efforts[next]) || effort)}
          // Unset, the thumb rests on the first stop, so a click there would change nothing:
          // the stop nearest the pointer is picked here instead.
          onPointerDown={(event) => {
            if (index >= 0) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const share = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
            const at = Math.round(Math.min(1, Math.max(0, share)) * (efforts.length - 1));
            onEffort(efforts[at] ?? null);
          }}
          aria-label="Reasoning effort"
          className="relative flex h-control-sm w-full touch-none items-center select-none"
        >
          <SliderPrimitive.Track className="bg-foreground/10 rounded-capsule relative h-control-xs w-full overflow-hidden">
            {index >= 0 && <SliderPrimitive.Range className="bg-link absolute h-full" />}
          </SliderPrimitive.Track>
          {efforts.map((stop, at) => (
            <span
              key={stop}
              aria-hidden
              className={cn(
                "pointer-events-none absolute size-1 -translate-x-1/2 rounded-capsule",
                at <= index ? "bg-foreground/60" : "bg-foreground/30",
              )}
              // Where the thumb's centre sits at this stop (it stays inside the track).
              style={{
                left: `calc(var(--spacing-control-sm) / 2 + (100% - var(--spacing-control-sm)) * ${at / (efforts.length - 1)})`,
              }}
            />
          ))}
          <SliderPrimitive.Thumb
            aria-valuetext={effort ? effortLabel(effort) : "Default"}
            className={cn(
              "bg-foreground focus-visible:ring-ring block size-control-sm rounded-capsule shadow-sm outline-hidden focus-visible:ring-2",
              index < 0 && "opacity-0 focus-visible:opacity-100",
            )}
          />
        </SliderPrimitive.Root>
      )}
    </div>
  );
}

/** "Select model": every provider's models, the one in use checked. */
function ModelList({
  groups,
  value,
  onPick,
  onBack,
}: {
  groups: readonly ModelGroup[];
  value: ModelChoice;
  onPick: (model: ModelInfo, provider: ProviderKind) => void;
  onBack: (() => void) | null;
}) {
  const current = findModel(groups, value);
  return (
    <div data-slot="model-selector-models" className="flex max-h-96 flex-col overflow-y-auto">
      <div className="flex items-center gap-1 px-1 pb-1">
        {onBack && (
          <TooltipIconButton tooltip="Back" size="icon-sm" onClick={onBack}>
            <ChevronLeft />
          </TooltipIconButton>
        )}
        <span className="text-muted-foreground text-sm">Select model</span>
      </div>
      {groups.map((group) => (
        <div key={group.provider} role="group" aria-label={group.label} className="flex flex-col">
          <p className="text-muted-foreground flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-xs">
            {group.label}
            {group.unavailable && <span className="text-warning">{group.unavailable}</span>}
          </p>
          {group.models.map((model) => {
            const picked = group.provider === value.provider && model.id === current?.id;
            return (
              <button
                key={model.id}
                type="button"
                disabled={group.unavailable !== null}
                aria-pressed={picked}
                data-slot="model-selector-item"
                onClick={() => onPick(model, group.provider)}
                className="hover:bg-foreground/5 rounded-control flex min-h-control-sm items-center gap-2 px-2 py-1 text-start text-sm disabled:opacity-50"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{model.displayName}</span>
                  {model.description && (
                    <span className="text-muted-foreground truncate text-xs">{model.description}</span>
                  )}
                </span>
                {picked && <Check className="size-icon-md shrink-0" />}
              </button>
            );
          })}
          {group.models.length === 0 && (
            <p className="text-muted-foreground px-2 py-1 text-xs">No models listed yet.</p>
          )}
        </div>
      ))}
    </div>
  );
}
