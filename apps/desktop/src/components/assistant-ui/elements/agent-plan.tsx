import {
  Check,
  ChevronRight,
  Minus,
  X,
} from "@openai/apps-sdk-ui/components/Icon";
import { type ComponentProps, type ReactNode, useId, useState } from "react";

import { paper } from "@/components/assistant-ui/elements/surfaces";
import { Spinner } from "@/components/glyphs/spinner";
import { cn } from "@/lib/utils";

export type AgentPlanStepStatus =
  | "pending"
  | "active"
  | "done"
  | "partial"
  | "failed"
  | "skipped";

export type AgentPlanStep = {
  key: string;
  title: string;
  detail?: ReactNode;
  status: AgentPlanStepStatus;
  statusLabel?: string;
  /** When supplied, details fold independently of the worker link. */
  folded?: boolean;
  /** Shown at the end of the row (e.g. the task carrying the step out). */
  aside?: ReactNode;
};

/** The Agent plan element (assistant-ui), on Brigadier's tokens. */
export function AgentPlan({
  title,
  badges,
  steps,
  footer,
  children,
  progressLabel = "completed",
  showProgress = true,
  limit = 4,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  title: string;
  badges?: ReactNode;
  steps: readonly AgentPlanStep[];
  footer?: ReactNode;
  progressLabel?: string;
  showProgress?: boolean;
  limit?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const total = steps.length;
  const completed = steps.filter((step) => step.status === "done").length;
  const progress = total > 0 ? (completed / total) * 100 : 0;
  // A phase that is working stays visible even beyond the initial short list.
  const shown = steps.filter(
    (step, index) => showAll || index < limit || step.status === "active",
  );
  const hidden = total - shown.length;

  return (
    <div
      data-slot="agent-plan"
      className={cn(
        paper,
        "rounded-thread flex w-full min-w-0 flex-col gap-3 p-3.5",
        className,
      )}
      {...props}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium wrap-anywhere">
          {title}
        </h3>
        {badges}
        {showProgress && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {completed} of {total} {progressLabel}
          </span>
        )}
      </div>
      {showProgress && (
        <div
          role="progressbar"
          aria-label="Plan progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
          className="bg-foreground/10 h-0.5 w-full overflow-hidden rounded-full"
        >
          <span
            className="bg-foreground/80 block h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
      {children}
      <ol id={listId} className="flex flex-col gap-2">
        {shown.map((step) => (
          <StepRow key={step.key} step={step} />
        ))}
      </ol>
      {(hidden > 0 || (showAll && total > limit)) && (
        <button
          type="button"
          aria-expanded={showAll}
          aria-controls={listId}
          className="text-muted-foreground hover:text-foreground rounded-control self-start text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "Show less" : `Show ${hidden} more`}
        </button>
      )}
      {footer}
    </div>
  );
}

function StepRow({ step }: { step: AgentPlanStep }) {
  const id = useId();
  const [fold, setFold] = useState<{
    status: AgentPlanStepStatus;
    open: boolean;
  } | null>(null);
  const open = fold?.status === step.status ? fold.open : !step.folded;
  const foldable = step.folded !== undefined && Boolean(step.detail);
  const title = (
    <span className="min-w-0 flex-1 wrap-anywhere">{step.title}</span>
  );
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="flex h-(--text-sm--line-height) w-icon-md shrink-0 items-center justify-center">
        {step.status === "done" ? (
          <Check className="text-muted-foreground size-icon-sm" />
        ) : step.status === "active" ? (
          <Spinner className="text-foreground size-icon-sm animate-spin motion-reduce:animate-none" />
        ) : step.status === "failed" ? (
          <X className="text-destructive size-icon-sm" />
        ) : step.status === "skipped" ? (
          <Minus className="text-muted-foreground size-icon-sm" />
        ) : step.status === "partial" ? (
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="text-muted-foreground size-icon-sm"
          >
            <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" />
            <path d="M8 2.5a5.5 5.5 0 0 0 0 11z" fill="currentColor" />
          </svg>
        ) : (
          <span
            aria-hidden
            className="bg-foreground/20 size-1.5 rounded-full"
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        {foldable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            className="rounded-control flex items-start gap-1 text-start outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => setFold({ status: step.status, open: !open })}
          >
            {title}
            <ChevronRight
              aria-hidden
              className={cn(
                "mt-0.5 size-icon-xs shrink-0",
                open && "rotate-90",
              )}
            />
          </button>
        ) : (
          title
        )}
        <span className="text-muted-foreground text-xs">
          {step.statusLabel ?? step.status}
        </span>
        {step.detail && (
          <div
            id={id}
            hidden={foldable && !open}
            className="text-muted-foreground pt-1 text-xs whitespace-pre-wrap wrap-anywhere"
          >
            {step.detail}
          </div>
        )}
      </span>
      {step.aside}
    </li>
  );
}
