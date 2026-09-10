// Installed from assistant-ui Elements (MIT); Brigadier theme and integration extensions.
"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "../../../icons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { collapsePanel, mono, ShimmerLabel, SwapLabel } from "@/lib/surfaces";
import { take } from "@/lib/range";

export interface ReasoningStep {
  title: string;
  body: ReactNode;
}

export interface ReasoningPanelProps {
  steps: ReasoningStep[];
  visibleSteps: number;
  streaming: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restingLabel: string;
  elapsed?: string;
  className?: string;
}

export function ReasoningPanel({
  steps,
  visibleSteps,
  streaming,
  open,
  onOpenChange,
  restingLabel,
  elapsed,
  className,
}: ReasoningPanelProps) {
  const shown = take(steps, visibleSteps);

  return (
    <Collapsible
      data-slot="reasoning-panel"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full max-w-sm", className)}
    >
      <CollapsibleTrigger className="group/trigger text-text/55 hover:text-text/90 flex items-center gap-1.5 py-1.5 text-left focus-visible:ring-1 focus-visible:ring-text/30 text-[13.5px] transition-[color,scale] outline-none active:scale-[0.98]">
        <SwapLabel active={streaming ? 0 : 1} className="text-start">
          <>
            <ShimmerLabel
              active={streaming}
              className="relative inline-block leading-none"
            >
              Thinking
            </ShimmerLabel>
            {elapsed !== undefined && (
              <span className={cn(mono, "text-text/30 tabular-nums")}>
                {elapsed}
              </span>
            )}
          </>
          <>{restingLabel}</>
        </SwapLabel>
        <ChevronDown className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[state=open]/trigger:rotate-180 group-data-panel-open/trigger:rotate-180 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        <ol className="flex flex-col gap-4 pt-3 pb-1">
          {shown.map((step, i) => {
            const active = streaming && i === shown.length - 1;
            return (
              <li
                key={i}
                className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both flex gap-3 duration-300"
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-[7px] size-[5px] shrink-0 rounded-full transition-colors duration-300",
                    active
                      ? "animate-pulse bg-attention dark:bg-attention"
                      : "bg-text/20",
                  )}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  {step.title && (
                    <p className="text-text/90 text-[13.5px] font-medium">
                      {step.title}
                    </p>
                  )}
                  <div className="text-text/60 mt-0.5 text-[13px] leading-relaxed break-words">
                    {step.body}
                  </div>
                </span>
              </li>
            );
          })}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}
