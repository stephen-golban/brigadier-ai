// Vendored from the Codex UI Kit (MIT); see src/components/thread/UPSTREAM.md.
import {
  useId,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";

export interface ActivityTimelineProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children?: ReactNode;
  collapsedCount?: number;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  persistentContent?: ReactNode;
  preToggleContent?: ReactNode;
  shouldShowPersistentContentGap?: boolean;
  showToggle?: boolean;
  summary?: ReactNode;
}

function previousMessageSummary(count: number) {
  return `${count} previous ${count === 1 ? "message" : "messages"}`;
}

export function ActivityTimeline({
  children,
  className,
  collapsedCount = 0,
  defaultOpen = false,
  onOpenChange,
  open,
  persistentContent,
  preToggleContent,
  shouldShowPersistentContentGap = false,
  showToggle = true,
  summary,
  ...props
}: ActivityTimelineProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const contentId = useId();
  const resolvedOpen = open ?? internalOpen;
  const classes = ["thread-activity-timeline", className]
    .filter(Boolean)
    .join(" ");
  const hasContent = children !== undefined && children !== null;
  const contentVisible = showToggle ? resolvedOpen : true;
  const resolvedSummary = summary ?? previousMessageSummary(collapsedCount);

  const setOpen = (nextOpen: boolean) => {
    if (open === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  return (
    <div
      className={classes}
      data-expanded={resolvedOpen || undefined}
      data-show-toggle={showToggle || undefined}
      {...props}
    >
      {preToggleContent ? (
        <div className="thread-activity-timeline__pre-toggle">
          {preToggleContent}
        </div>
      ) : null}
      {showToggle ? (
        <div className="thread-activity-timeline__toggle-row">
          <button
            aria-controls={contentId}
            aria-expanded={resolvedOpen}
            className="thread-activity-timeline__toggle"
            onClick={() => setOpen(!resolvedOpen)}
            type="button"
          >
            <span>{resolvedSummary}</span>
            <span
              aria-hidden="true"
              className="thread-activity-timeline__chevron"
            />
          </button>
          <div aria-hidden="true" className="thread-activity-timeline__rule" />
        </div>
      ) : null}
      {persistentContent ? (
        <div
          className="thread-activity-timeline__persistent"
          data-spaced={
            (showToggle && shouldShowPersistentContentGap) || undefined
          }
        >
          {persistentContent}
        </div>
      ) : null}
      {contentVisible && hasContent ? (
        <div className="thread-activity-timeline__content" id={contentId}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
