import { Check, Spin, X } from "@openai/apps-sdk-ui/components/Icon";
import type { ComponentProps, ReactNode } from "react";

import { mono, paper } from "@/components/assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";

export type AgentPlanStepStatus = "pending" | "active" | "done" | "failed";

export type AgentPlanStep = {
  key: string;
  title: string;
  detail?: string | null | undefined;
  status: AgentPlanStepStatus;
  /** Shown at the end of the row (e.g. the task carrying the step out). */
  aside?: ReactNode;
};

/** The Agent plan element (assistant-ui), on Brigadier's tokens. */
export function AgentPlan({
  title,
  badges,
  steps,
  footer,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "title"> & {
  title: string;
  badges?: ReactNode;
  steps: readonly AgentPlanStep[];
  footer?: ReactNode;
}) {
  const total = steps.length;
  const completed = steps.filter((step) => step.status === "done").length;
  const progress = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div
      data-slot="agent-plan"
      className={cn(paper, "rounded-thread flex w-full flex-col gap-3 p-3.5", className)}
      {...props}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium">{title}</span>
        {badges}
        <span className={cn(mono, "text-muted-foreground tabular-nums")}>
          {completed} of {total}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Plan progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        className="bg-foreground/10 h-0.5 w-full overflow-hidden rounded-full"
      >
        <span
          className="bg-foreground/80 block h-full rounded-full transition-[width] duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>
      <ol className="flex flex-col gap-2">
        {steps.map((step) => (
          <li key={step.key} className="flex items-start gap-2.5 text-sm">
            <span className="flex h-(--text-sm--line-height) w-icon-md shrink-0 items-center justify-center">
              {step.status === "done" ? (
                <Check className="text-muted-foreground size-icon-sm" />
              ) : step.status === "active" ? (
                <Spin className="text-foreground size-icon-sm animate-spin motion-reduce:animate-none" />
              ) : step.status === "failed" ? (
                <X className="text-destructive size-icon-sm" />
              ) : (
                <span aria-hidden className="bg-foreground/20 size-1.5 rounded-full" />
              )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span
                className={cn(
                  step.status === "done" && "text-muted-foreground",
                  step.status === "pending" && "text-muted-foreground",
                )}
              >
                {step.title}
              </span>
              {step.detail && (
                <span className="text-muted-foreground text-xs whitespace-pre-wrap">
                  {step.detail}
                </span>
              )}
            </span>
            {step.aside}
          </li>
        ))}
      </ol>
      {footer}
    </div>
  );
}
