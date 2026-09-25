import {
  Check,
  ChevronRight,
  Pause,
  Spin,
  X,
  XCircle,
} from "@openai/apps-sdk-ui/components/Icon";
import type { ComponentProps, ReactNode } from "react";

import { mono, paper } from "@/components/assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";

/** The Task card element (assistant-ui), on Brigadier's tokens. */
export type TaskCardState = "working" | "waiting" | "paused" | "done" | "failed" | "cancelled";

export function TaskStateIcon({
  state,
  className,
}: {
  state: TaskCardState;
  className?: string;
}) {
  const base = "size-icon-sm shrink-0";
  switch (state) {
    case "done":
      return <Check aria-hidden className={cn(base, "text-success", className)} />;
    case "failed":
      return <X aria-hidden className={cn(base, "text-destructive", className)} />;
    case "cancelled":
      return <XCircle aria-hidden className={cn(base, "text-muted-foreground", className)} />;
    case "paused":
      return <Pause aria-hidden className={cn(base, "text-warning", className)} />;
    case "working":
      return (
        <Spin
          aria-hidden
          className={cn(base, "text-muted-foreground animate-spin motion-reduce:animate-none", className)}
        />
      );
    case "waiting":
      return (
        <span
          aria-hidden
          className={cn("border-warning m-1 size-1.5 shrink-0 rounded-full border", className)}
        />
      );
  }
}

/**
 * A worker's card: a header row that expands the body, an actions row, and a result row.
 * The body renders only while open, so closed cards cost nothing but their header.
 * `standalone` is the card on its own (a side panel names the worker): no toggle, the state,
 * badges and activity in a plain row, and the body always shown.
 */
export function TaskCard({
  label,
  meta,
  state,
  stateLabel,
  badges,
  activity,
  actions,
  result,
  open,
  onOpenChange,
  standalone = false,
  children,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "title"> & {
  label: string;
  meta?: ReactNode;
  state: TaskCardState;
  stateLabel: string;
  badges?: ReactNode;
  /** What the worker is doing right now. */
  activity?: string | undefined;
  actions?: ReactNode;
  result?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  standalone?: boolean;
  children?: ReactNode;
}) {
  if (standalone) {
    return (
      <div data-slot="task-card" data-state={state} className={cn("flex w-full flex-col gap-3", className)} {...props}>
        <div className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <TaskStateIcon state={state} />
            <span className="sr-only">{stateLabel}</span>
            {badges}
            {meta !== undefined && (
              <span className={cn(mono, "text-muted-foreground truncate")}>{meta}</span>
            )}
          </span>
          {activity && (
            <span className={cn(mono, "text-muted-foreground truncate")} data-slot="task-card-activity">
              {activity}
            </span>
          )}
        </div>
        {actions && (
          <div data-slot="task-card-actions" className="flex flex-wrap items-center gap-2">
            {actions}
          </div>
        )}
        {result && (
          <div data-slot="task-card-result" className="text-muted-foreground text-xs">
            {result}
          </div>
        )}
        {children && (
          <div data-slot="task-card-body" className="flex flex-col gap-3">
            {children}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      data-slot="task-card"
      data-state={state}
      className={cn(paper, "rounded-thread flex w-full flex-col overflow-hidden", className)}
      {...props}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="hover:bg-foreground/5 flex flex-col gap-0.5 px-3.5 py-2.5 text-start transition-colors"
      >
        <span className="flex w-full items-center gap-2.5">
          <TaskStateIcon state={state} />
          <span className="sr-only">{stateLabel}</span>
          <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
          {badges}
          {meta !== undefined && (
            <span className={cn(mono, "text-muted-foreground max-w-xs shrink-0 truncate")}>
              {meta}
            </span>
          )}
          <ChevronRight
            aria-hidden
            className={cn(
              "text-muted-foreground size-icon-xs shrink-0 transition-transform duration-200 motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        </span>
        {activity && (
          <span
            className={cn(mono, "text-muted-foreground ms-6 truncate")}
            data-slot="task-card-activity"
          >
            {activity}
          </span>
        )}
      </button>
      {actions && (
        <div
          data-slot="task-card-actions"
          className="border-border flex flex-wrap items-center gap-2 border-t px-3.5 py-2"
        >
          {actions}
        </div>
      )}
      {open && children && (
        <div
          data-slot="task-card-body"
          className="border-border flex flex-col gap-3 border-t px-3.5 py-2.5"
        >
          {children}
        </div>
      )}
      {result && (
        <div
          data-slot="task-card-result"
          className="border-border text-muted-foreground border-t px-3.5 py-2 text-xs"
        >
          {result}
        </div>
      )}
    </div>
  );
}
