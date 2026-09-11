// Vendored from the Codex UI Kit (MIT); see src/components/thread/UPSTREAM.md.
import { Tools, Code } from "../../icons";
import type { HTMLAttributes, ReactNode } from "react";
import type { AgentItemStatus } from "./types";
import {
  AgentActivity,
  type AgentActivityProps,
} from "./AgentActivity";

function stringifyStructuredContent(value: unknown) {
  try {
    return JSON.stringify(
      value,
      (_key, item) => (typeof item === "bigint" ? item.toString() : item),
      2,
    );
  } catch {
    return null;
  }
}

export interface ToolCallCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  accessory?: ReactNode;
  activeLabel?: ReactNode;
  children?: ReactNode;
  completedLabel?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  disclosureIcon?: AgentActivityProps["disclosureIcon"];
  disclosureIndicator?: AgentActivityProps["disclosureIndicator"];
  disclosureMode?: AgentActivityProps["disclosureMode"];
  emptyLabel?: ReactNode;
  error?: ReactNode;
  errorLanguage?: ReactNode;
  errorPresentation?: "alert" | "output";
  failedAriaLabel?: string;
  failedLabel?: ReactNode;
  icon?: ReactNode;
  name: string;
  onOpenChange?: (open: boolean) => void;
  onViewRawOutput?: (rawOutput: unknown) => void;
  open?: boolean;
  rawOutput?: unknown;
  result?: ReactNode;
  source?: string;
  status: AgentItemStatus;
  structuredContent?: unknown;
  summary?: ReactNode;
  viewRawOutputLabel?: string;
}

export function ToolCallCard({
  accessory,
  activeLabel,
  children,
  className,
  completedLabel,
  collapsible = true,
  defaultOpen = false,
  disclosureIcon,
  disclosureIndicator,
  disclosureMode,
  emptyLabel = "Tool returned no content",
  error,
  errorLanguage,
  errorPresentation = "alert",
  failedAriaLabel,
  failedLabel,
  icon,
  name,
  onOpenChange,
  onViewRawOutput,
  open,
  rawOutput,
  result,
  source,
  status,
  structuredContent,
  summary,
  viewRawOutputLabel = "Show raw tool call output",
  ...props
}: ToolCallCardProps) {
  const classes = ["thread-tool-call", className].filter(Boolean).join(" ");
  const structuredText =
    structuredContent === undefined
      ? null
      : stringifyStructuredContent(structuredContent);
  const resolvedContent = children ?? result;
  const hasContent =
    typeof resolvedContent === "string"
      ? resolvedContent.trim().length > 0
      : resolvedContent !== undefined &&
        resolvedContent !== null &&
        resolvedContent !== false;
  const hasError =
    error !== undefined && error !== null && error !== false;
  const canExpand =
    collapsible &&
    (status === "completed" ||
      status === "failed" ||
      hasContent ||
      hasError ||
      structuredContent !== undefined);
  const label =
    status === "running" || status === "pending"
      ? (activeLabel ?? name)
      : status === "failed"
        ? (failedLabel ?? `${name} failed`)
        : (completedLabel ?? name);
  const body = canExpand ? (
    <div className="thread-tool-call__result">
      {hasError ? (
        <div
          className="thread-tool-call__error"
          data-presentation={errorPresentation}
          role="alert"
        >
          {errorPresentation === "output" ? (
            <>
              {errorLanguage ? (
                <span className="thread-tool-call__error-language">
                  {errorLanguage}
                </span>
              ) : null}
              <pre className="thread-tool-call__error-output">
                <code>{error}</code>
              </pre>
            </>
          ) : (
            error
          )}
        </div>
      ) : hasContent ? (
        <div className="thread-tool-call__content">{resolvedContent}</div>
      ) : structuredText !== null ? (
        <pre className="thread-tool-call__structured">
          <code>{structuredText}</code>
        </pre>
      ) : (
        <p className="thread-tool-call__empty">{emptyLabel}</p>
      )}
      {rawOutput !== undefined && onViewRawOutput ? (
        <button
          aria-label={viewRawOutputLabel}
          className="thread-tool-call__raw-output"
          onClick={() => onViewRawOutput(rawOutput)}
          title={viewRawOutputLabel}
          type="button"
        >
          <Code />
        </button>
      ) : null}
    </div>
  ) : undefined;

  return (
    <AgentActivity
      className={classes}
      data-source={source}
      defaultOpen={defaultOpen}
      disclosureIcon={disclosureIcon}
      disclosureIndicator={disclosureIndicator}
      disclosureMode={disclosureMode}
      description={
        summary ? <p className="thread-tool-call__summary">{summary}</p> : null
      }
      detail={accessory}
      indicator={icon ?? <Tools aria-hidden="true" className="thread-tool-call__icon" />}
      kind="tool"
      onOpenChange={onOpenChange}
      open={open}
      status={status}
      summary={
        <span
          aria-label={status === "failed" ? failedAriaLabel : undefined}
          className="thread-tool-call__label"
          data-active={status === "running" || undefined}
        >
          {label}
        </span>
      }
      {...props}
    >
      {body}
    </AgentActivity>
  );
}
