// Vendored from the Codex UI Kit (MIT); see src/components/thread/UPSTREAM.md.
import { ChevronRight } from "../../icons";
import {
  useId,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import type { AgentActivityKind } from "./types";
import {
  StatusIndicator,
  type StatusIndicatorStatus,
} from "./StatusIndicator";

export type AgentActivityStatus = StatusIndicatorStatus;

export interface AgentActivityProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children?: ReactNode;
  defaultOpen?: boolean;
  description?: ReactNode;
  detail?: ReactNode;
  disclosureIcon?: ReactNode;
  disclosureIndicator?: boolean;
  disclosureMode?: "button" | "details" | "overlay-button";
  indicator?: ReactNode;
  kind?: AgentActivityKind;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  status: AgentActivityStatus;
  summary: ReactNode;
}

/**
 * Brigadier deviation: a closed disclosure renders no body. Upstream keeps every collapsed
 * row's subtree mounted behind `hidden`, which in a brigadier transcript means every tool
 * result, every nested trace and every approval card in a 600-row history is in the DOM at
 * all times — the cost the component this replaced (`CollapsibleContent`) did not pay, and
 * the thread already misses its frame gate (`docs/plans/codex-thread-rebuild-2026-09-11.md`
 * landmine 7). `hasBody` still decides whether a toggle exists, so the control is unchanged.
 */
export function AgentActivity({
  children,
  className,
  defaultOpen = false,
  description,
  detail,
  disclosureIcon,
  disclosureIndicator = false,
  disclosureMode = "details",
  indicator,
  kind = "generic",
  onOpenChange,
  open,
  status,
  summary,
  ...props
}: AgentActivityProps) {
  const generatedSummaryId = useId();
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const resolvedOpen = open ?? internalOpen;
  const classes = ["thread-activity", className].filter(Boolean).join(" ");
  const hasBody = children !== undefined && children !== null;
  const summaryId =
    disclosureMode === "overlay-button" ? generatedSummaryId : undefined;
  const updateOpen = (nextOpen: boolean) => {
    if (open === undefined) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };
  const header = (
    <>
      {indicator === undefined ? <StatusIndicator status={status} /> : indicator}
      <span className="thread-activity__summary" id={summaryId}>
        {summary}
      </span>
      {detail ? (
        <span className="thread-activity__detail">{detail}</span>
      ) : null}
    </>
  );
  const buttonChevron = (
    <span
      aria-hidden="true"
      className="thread-activity__button-chevron"
      data-visible={disclosureIndicator || resolvedOpen || undefined}
    >
      {disclosureIcon ?? (
        <ChevronRight height="20" width="20" />
      )}
    </span>
  );

  return (
    <div
      className={classes}
      data-kind={kind}
      data-status={status}
      data-expandable={hasBody || undefined}
      {...props}
    >
      {hasBody && disclosureMode === "overlay-button" ? (
        <div
          className="thread-activity__disclosure"
          data-disclosure-mode="overlay-button"
          data-open={resolvedOpen || undefined}
        >
          <div className="thread-activity__header">
            {header}
            {buttonChevron}
            <button
              aria-expanded={resolvedOpen}
              aria-labelledby={summaryId}
              className="thread-activity__overlay-toggle"
              onClick={() => updateOpen(!resolvedOpen)}
              type="button"
            />
          </div>
          <div
            aria-hidden={!resolvedOpen}
            className="thread-activity__body"
            hidden={!resolvedOpen}
          >
            {resolvedOpen ? children : null}
          </div>
        </div>
      ) : hasBody && disclosureMode === "button" ? (
        <div
          className="thread-activity__disclosure"
          data-disclosure-mode="button"
          data-open={resolvedOpen || undefined}
        >
          <button
            aria-expanded={resolvedOpen}
            className="thread-activity__header"
            onClick={() => updateOpen(!resolvedOpen)}
            type="button"
          >
            {header}
            {buttonChevron}
          </button>
          <div
            aria-hidden={!resolvedOpen}
            className="thread-activity__body"
            hidden={!resolvedOpen}
          >
            {resolvedOpen ? children : null}
          </div>
        </div>
      ) : hasBody ? (
        <details
          className="thread-activity__disclosure"
          onToggle={(event) => {
            const nextOpen = event.currentTarget.open;
            if (open !== undefined) {
              if (nextOpen !== open) {
                updateOpen(nextOpen);
                event.currentTarget.open = open;
              }
              return;
            }

            updateOpen(nextOpen);
          }}
          open={resolvedOpen}
        >
          <summary
            aria-expanded={resolvedOpen}
            className="thread-activity__header"
            onClick={(event) => {
              if (open === undefined) return;
              event.preventDefault();
              updateOpen(!open);
            }}
          >
            {header}
          </summary>
          <div className="thread-activity__body">
            {resolvedOpen ? children : null}
          </div>
        </details>
      ) : (
        <div className="thread-activity__header">{header}</div>
      )}
      {description ? (
        <div className="thread-activity__description">{description}</div>
      ) : null}
    </div>
  );
}
