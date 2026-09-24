import type { ComponentProps } from "react";

import { field } from "@/components/assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";

export type EffortLevel = { key: string; label: string };

/**
 * The Reasoning effort element (assistant-ui), on Brigadier's tokens: a segmented control over
 * the levels the picked model accepts. Brigadier does not know thinking budgets, so the
 * element's budget meter is left out.
 */
export function ReasoningEffort({
  levels,
  selectedKey,
  onSelect,
  disabled,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "onSelect"> & {
  levels: readonly EffortLevel[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      data-slot="reasoning-effort"
      role="radiogroup"
      aria-label="Reasoning effort"
      className={cn(field, "rounded-capsule flex gap-0.5 p-0.5", className)}
      {...props}
    >
      {levels.map((level) => {
        const active = level.key === selectedKey;
        return (
          <button
            key={level.key}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onSelect(level.key)}
            className={cn(
              "rounded-capsule h-control-xs px-button-sm flex-1 text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-50",
              active
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {level.label}
          </button>
        );
      })}
    </div>
  );
}

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
