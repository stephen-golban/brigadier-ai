import { ChevronDown } from "@openai/apps-sdk-ui/components/Icon";

import {
  effortLabel,
  ReasoningEffort,
} from "@/components/assistant-ui/elements/reasoning-effort";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ModelChoice, ModelInfo, ProviderKind } from "@/ipc/generated";
import { cn } from "@/lib/utils";

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

/** Keeps an effort only if the model accepts it; otherwise the model's default. */
export function effortFor(model: ModelInfo | null, effort: string | null): string | null {
  if (!model || model.efforts.length === 0) return effort;
  if (effort && model.efforts.includes(effort)) return effort;
  return model.defaultEffort;
}

/**
 * The Model selector element (assistant-ui) with its reasoning effort row, on Brigadier's
 * tokens. Built on the Radix dropdown menu: the live model lists are short, so the element's
 * search box is left out.
 */
export function ModelSelector({
  groups,
  value,
  onChange,
  label = "Model",
  disabled,
  className,
}: {
  groups: readonly ModelGroup[];
  value: ModelChoice;
  onChange: (choice: ModelChoice) => void;
  label?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}) {
  const current = findModel(groups, value);
  const efforts = current?.efforts ?? [];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label={label}
          disabled={disabled}
          data-slot="model-selector-trigger"
          className={cn("text-muted-foreground min-w-0 justify-between", className)}
        >
          <span className="truncate">{choiceLabel(groups, value)}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-(--radix-dropdown-menu-content-available-height) max-w-sm overflow-y-auto"
      >
        <DropdownMenuRadioGroup
          value={current ? `${value.provider}/${current.id}` : ""}
          onValueChange={(next) => {
            const [provider, id] = next.split("/", 2) as [ProviderKind, string];
            const group = groups.find((entry) => entry.provider === provider);
            const model = group?.models.find((entry) => entry.id === id) ?? null;
            onChange({
              provider,
              model: model?.id ?? null,
              effort: effortFor(model, value.effort),
            });
          }}
        >
          {groups.map((group, index) => (
            <div key={group.provider} role="group" aria-label={group.label}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-muted-foreground flex items-center gap-2 text-xs">
                {group.label}
                {group.unavailable && (
                  <span className="text-warning font-normal">{group.unavailable}</span>
                )}
              </DropdownMenuLabel>
              {group.models.map((model) => (
                <DropdownMenuRadioItem
                  key={model.id}
                  value={`${group.provider}/${model.id}`}
                  disabled={group.unavailable !== null}
                  data-slot="model-selector-item"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{model.displayName}</span>
                    {model.description && (
                      <span className="text-muted-foreground truncate text-xs">
                        {model.description}
                      </span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              ))}
              {group.models.length === 0 && (
                <p className="text-muted-foreground px-2 py-1 text-xs">No models listed yet.</p>
              )}
            </div>
          ))}
        </DropdownMenuRadioGroup>
        {efforts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <div
              data-slot="model-selector-effort"
              className="flex items-center justify-between gap-3 px-2 py-1.5"
            >
              <span className="text-muted-foreground text-xs">Reasoning</span>
              <ReasoningEffort
                levels={efforts.map((effort) => ({ key: effort, label: effortLabel(effort) }))}
                selectedKey={effortFor(current, value.effort)}
                onSelect={(effort) => onChange({ ...value, effort })}
              />
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
