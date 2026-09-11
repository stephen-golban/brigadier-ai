// Vendored from the Codex UI Kit (MIT); see src/components/thread/UPSTREAM.md.
//
// Modified from upstream: SubagentAvatar (and the five subagent SVGs it rendered) is
// deleted, along with everything that only existed to feed it or to open it in a menu —
// SubagentSummary, SummaryAvatarGroup, DiffStats, SubagentPanel, SubagentPanelIcon,
// SubagentTranscriptHeader, sortForSummary and the SubagentItem shape they used, and the
// `Menu`/`MenuItem` import from InteractivePrimitives.tsx that SubagentSummary's overflow
// popover needed. The kit's own `src/assets/subagents/*.svg` remain OpenAI's copyright and
// are not relicensed under the kit's MIT license (see THIRD_PARTY_NOTICES.md); brigadier
// ships no avatar in their place yet. Only SubagentActivity and SubagentActivityGroup — the
// inline chip rows the row catalogue actually calls for (see the plan's target row catalogue,
// row 11) — survive, now avatar-less.
import {
  type HTMLAttributes,
  type ReactNode,
} from "react";

export type SubagentStatus = "active" | "waiting" | "done";
export type SubagentActivityStatus =
  | "active"
  | "updated"
  | "interrupted"
  | "done";

export interface SubagentActivityItem {
  activityStatus: SubagentActivityStatus;
  id: string;
  name?: string;
  status?: SubagentStatus;
  statusSummary?: ReactNode;
}

function displayName(name?: string) {
  return name?.trim() || "Agent";
}

function activityLabel(item: SubagentActivityItem) {
  const name = displayName(item.name);
  switch (item.activityStatus) {
    case "active":
      return `${name} started working`;
    case "updated":
      return `${name} updated`;
    case "interrupted":
      return `${name} interrupted`;
    case "done":
      return `${name} finished`;
  }
}

function groupStatus(items: SubagentActivityItem[]) {
  const statuses = items.map((item) => item.activityStatus);
  if (statuses.includes("interrupted")) return "interrupted";
  if (statuses.includes("updated")) return "updated";
  if (statuses.length > 0 && statuses.every((status) => status === "done")) {
    return "finished";
  }
  return "started working";
}

export interface SubagentActivityProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  item: SubagentActivityItem;
  onOpen?: (item: SubagentActivityItem) => void;
}

export function SubagentActivity({
  className,
  item,
  onOpen,
  ...props
}: SubagentActivityProps) {
  const summary = item.statusSummary ?? activityLabel(item);
  const content = (
    <span className="thread-subagent-activity__summary">{summary}</span>
  );

  return (
    <div
      className={["thread-subagent-activity", className]
        .filter(Boolean)
        .join(" ")}
      data-status={item.activityStatus}
      {...props}
    >
      {onOpen ? (
        <button
          aria-label={`Open ${displayName(item.name)} subagent`}
          className="thread-subagent-activity__row"
          onClick={() => onOpen(item)}
          type="button"
        >
          {content}
        </button>
      ) : (
        <div className="thread-subagent-activity__row">{content}</div>
      )}
    </div>
  );
}

export interface SubagentActivityGroupProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  animateEntrance?: boolean;
  items: SubagentActivityItem[];
  maxVisible?: number;
  onOpen?: (item: SubagentActivityItem) => void;
  statusLabel?: ReactNode;
}

export function SubagentActivityGroup({
  animateEntrance = true,
  className,
  items,
  maxVisible = 3,
  onOpen,
  statusLabel,
  ...props
}: SubagentActivityGroupProps) {
  if (items.length === 0) return null;

  const visibleItems = items.slice(0, maxVisible);
  const hiddenCount = items.length - visibleItems.length;

  return (
    <div
      className={["thread-subagent-activity-group", className]
        .filter(Boolean)
        .join(" ")}
      data-testid="subagent-activity-inline-group"
      {...props}
    >
      {visibleItems.map((item) => {
        const content = <span>{displayName(item.name)}</span>;
        const classes = "thread-subagent-activity-group__chip";

        return onOpen ? (
          <button
            aria-label={`Open ${displayName(item.name)} subagent`}
            className={classes}
            data-animate-entrance={animateEntrance || undefined}
            key={item.id}
            onClick={() => onOpen(item)}
            type="button"
          >
            {content}
          </button>
        ) : (
          <span
            className={classes}
            data-animate-entrance={animateEntrance || undefined}
            key={item.id}
          >
            {content}
          </span>
        );
      })}
      <span className="thread-subagent-activity-group__status">
        {hiddenCount > 0
          ? `and ${hiddenCount} other ${hiddenCount === 1 ? "subagent" : "subagents"} `
          : null}
        {statusLabel ?? groupStatus(items)}
      </span>
    </div>
  );
}
