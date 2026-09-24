import type { ComponentProps, ReactNode } from "react";

import { field, paper } from "@/components/assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";

/**
 * The Approval card element (assistant-ui), on Brigadier's tokens. While it waits it shows
 * its actions; once answered, the resolution line replaces them.
 */
export function ApprovalCard({
  icon,
  title,
  subtitle,
  pending,
  actions,
  resolution,
  children,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  pending: boolean;
  actions?: ReactNode;
  resolution?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      data-slot="approval-card"
      data-pending={pending || undefined}
      className={cn(
        paper,
        "rounded-thread flex w-full flex-col gap-3 p-3.5",
        pending && "border-warning/50",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-3">
        <span className="bg-foreground/5 text-muted-foreground rounded-control flex size-icon-button-lg shrink-0 items-center justify-center [&_svg]:size-icon-md">
          {icon}
        </span>
        <div className="flex min-w-0 flex-col">
          <p className="text-sm font-medium">{title}</p>
          {subtitle && <p className="text-muted-foreground truncate text-xs">{subtitle}</p>}
        </div>
      </div>
      {children}
      <div className="flex min-h-control-sm flex-wrap items-center justify-end gap-2">
        {pending ? (
          actions
        ) : (
          <div className="fade-in animate-in text-muted-foreground flex items-center gap-2 text-xs duration-300">
            {resolution}
          </div>
        )}
      </div>
    </div>
  );
}

/** Exact text the card asks about (a command line, a path). */
export function ApprovalCardCode({ className, ...props }: ComponentProps<"pre">) {
  return (
    <pre
      data-selectable
      className={cn(
        field,
        "rounded-control text-foreground max-h-60 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap",
        className,
      )}
      {...props}
    />
  );
}
