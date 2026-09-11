// Vendored from the Codex UI Kit (MIT); see src/components/thread/UPSTREAM.md.
import { Nodes } from "../../icons";
import type { HTMLAttributes, ReactNode } from "react";
import type { AgentItemStatus } from "./types";
import {
  AgentActivity,
  type AgentActivityProps,
} from "./AgentActivity";

export function McpToolIcon() {
  return <Nodes aria-hidden="true" className="thread-mcp-tool-call-group__icon" />;
}

export interface McpToolCallGroupProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  activeLabel?: ReactNode;
  children?: ReactNode;
  completedLabel?: ReactNode;
  defaultOpen?: boolean;
  disclosureIcon?: AgentActivityProps["disclosureIcon"];
  disclosureMode?: AgentActivityProps["disclosureMode"];
  failedLabel?: ReactNode;
  icon?: ReactNode;
  name: string;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  source?: string;
  status: AgentItemStatus;
}

export function McpToolCallGroup({
  activeLabel,
  children,
  className,
  completedLabel,
  defaultOpen = false,
  disclosureIcon,
  disclosureMode,
  failedLabel,
  icon,
  name,
  onOpenChange,
  open,
  source,
  status,
  ...props
}: McpToolCallGroupProps) {
  const classes = ["thread-mcp-tool-call-group", className]
    .filter(Boolean)
    .join(" ");
  const label =
    status === "running" || status === "pending"
      ? (activeLabel ?? `Using ${name} integration`)
      : status === "failed"
        ? (failedLabel ?? `${name} integration failed`)
        : (completedLabel ?? `Used ${name} integration`);

  return (
    <AgentActivity
      className={classes}
      data-source={source}
      defaultOpen={defaultOpen}
      disclosureIcon={disclosureIcon}
      disclosureIndicator={disclosureMode === "button"}
      disclosureMode={disclosureMode}
      indicator={icon ?? <McpToolIcon />}
      kind="tool"
      onOpenChange={onOpenChange}
      open={open}
      status={status}
      summary={
        <span
          className="thread-mcp-tool-call-group__label"
          data-active={status === "running" || undefined}
        >
          {label}
        </span>
      }
      {...props}
    >
      <div
        aria-label={`${name} tool calls`}
        className="thread-mcp-tool-call-group__calls"
        role="list"
      >
        {children}
      </div>
    </AgentActivity>
  );
}
