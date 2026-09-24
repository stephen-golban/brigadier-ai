import type { ComponentProps, ReactNode } from "react";

import { field, mono, paper } from "@/components/assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";

/**
 * The Message queue element (assistant-ui), on Brigadier's tokens: the running turn, then the
 * messages typed meanwhile, in the order they will be sent. Brigadier extends it with
 * steering, editing, reordering and a paused state; those controls come in as children.
 */
export function MessageQueue({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-queue"
      className={cn("flex w-full flex-col gap-1.5", className)}
      {...props}
    />
  );
}

/** The row for the turn in flight. */
export function MessageQueueRunning({
  label,
  active,
  children,
  className,
}: {
  label: ReactNode;
  /** Pulses while the turn runs; still while it is paused or stopping. */
  active: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="message-queue-running"
      className={cn(paper, "rounded-thread flex items-center gap-2.5 px-3 py-2", className)}
    >
      <span className="relative flex size-2 shrink-0">
        {active && (
          <span className="bg-success/60 absolute inline-flex size-full animate-ping rounded-full motion-reduce:hidden" />
        )}
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full",
            active ? "bg-success" : "bg-warning",
          )}
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      {children}
    </div>
  );
}

/** "2 queued · sends when this finishes". */
export function MessageQueueHeader({ start, end }: { start: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-1">
      <span className={cn(mono, "text-muted-foreground")}>{start}</span>
      {end && <span className={cn(mono, "text-muted-foreground")}>{end}</span>}
    </div>
  );
}

/** One queued message. */
export function MessageQueueItem({
  index,
  dragging,
  className,
  children,
  ...props
}: ComponentProps<"li"> & { index: number; dragging?: boolean }) {
  return (
    <li
      data-slot="message-queue-item"
      data-dragging={dragging || undefined}
      className={cn(
        field,
        "rounded-thread fade-in slide-in-from-bottom-1 animate-in fill-mode-both flex items-center gap-2 py-1.5 ps-2 pe-1.5 duration-300",
        dragging && "bg-accent relative z-10 opacity-90",
        className,
      )}
      {...props}
    >
      <span className={cn(mono, "text-muted-foreground w-3 shrink-0 text-center tabular-nums")}>
        {index + 1}
      </span>
      {children}
    </li>
  );
}
