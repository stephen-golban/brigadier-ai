// Vendored from the Codex UI Kit (MIT); see src/components/thread/UPSTREAM.md.
import type { HTMLAttributes } from "react";
import type { AgentItemStatus } from "./types";

export type StatusIndicatorStatus = AgentItemStatus | "warning";

export interface StatusIndicatorProps extends HTMLAttributes<HTMLSpanElement> {
  status: StatusIndicatorStatus;
}

export function StatusIndicator({
  className,
  status,
  ...props
}: StatusIndicatorProps) {
  const classes = ["thread-status-indicator", className]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      aria-hidden="true"
      className={classes}
      data-status={status}
      {...props}
    />
  );
}
