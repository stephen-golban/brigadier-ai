// Hand-extracted from the Codex UI Kit's FileChange.tsx (MIT) — FileChangeGroup and
// FileChangeStats only. See src/components/thread/UPSTREAM.md for what was left behind
// and why (FileChange, FileDiff, FileReview, FileReviewWorkspace, FileRevertErrorDialog
// drag in Dialog.tsx and InteractivePrimitives.tsx and +37,104 bytes of CSS this app has
// no use for — brigadier has no per-file diff text to put in an expanded body anyway).
import type { HTMLAttributes, ReactNode } from "react";
import type { AgentItemStatus } from "./types";
import { StatusIndicator } from "./StatusIndicator";

export type FileChangeKind = "added" | "modified" | "deleted" | "renamed";

export type FileChangeStatus =
  | AgentItemStatus
  | "streaming"
  | "applied"
  | "stopped"
  | "rejected";

function normalizeStatus(status: FileChangeStatus) {
  if (status === "completed") return "applied";
  if (status === "running") return "streaming";
  if (status === "failed") return "rejected";
  return status;
}

function toAgentStatus(status: FileChangeStatus): AgentItemStatus {
  const normalized = normalizeStatus(status);
  if (normalized === "applied") return "completed";
  if (normalized === "streaming") return "running";
  if (normalized === "stopped" || normalized === "rejected") return "failed";
  return "pending";
}

/** Brigadier deviation: exported (the kit keeps it file-private) and given a props spread,
 *  so an activity row can carry its own per-edit counts — plan §3 row 8's `+A/-D`, drawn
 *  `data-variant="agent-activity"` so they stay colourless until the row is hovered. */
export function FileChangeStats({
  additions,
  change,
  className,
  deletions,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  additions?: number;
  change: FileChangeKind;
  deletions?: number;
}) {
  return (
    <span
      className={["thread-file-change__stats", className].filter(Boolean).join(" ")}
      {...props}
    >
      {additions !== undefined ? (
        <span data-stat="additions">+{additions}</span>
      ) : null}
      {deletions !== undefined ? (
        <span data-stat="deletions">−{deletions}</span>
      ) : null}
      {change === "added" ? <span aria-hidden="true" data-dot="added" /> : null}
      {change === "deleted" ? (
        <span aria-hidden="true" data-dot="deleted" />
      ) : null}
    </span>
  );
}

export interface FileChangeGroupItem {
  additions?: number;
  change: FileChangeKind;
  deletions?: number;
  path: string;
  previousPath?: string;
}

export interface FileChangeGroupProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  changes: readonly FileChangeGroupItem[];
  description?: ReactNode;
  detail?: ReactNode;
  indicator?: ReactNode;
  onOpenFile?: (change: FileChangeGroupItem, index: number) => void;
  status?: FileChangeStatus;
  summary?: ReactNode;
}

export function FileChangeGroup({
  changes,
  className,
  description,
  detail,
  indicator,
  onOpenFile,
  status = "applied",
  summary,
  "aria-label": ariaLabel,
  ...props
}: FileChangeGroupProps) {
  const normalizedStatus = normalizeStatus(status);
  const count = changes.length;
  const fileLabel = count === 1 ? "file" : "files";
  const statusLabel =
    normalizedStatus === "applied"
      ? "Edited"
      : normalizedStatus === "stopped"
        ? "Stopped editing"
        : normalizedStatus === "rejected"
          ? "Rejected"
          : "Editing";
  const classes = ["thread-file-change-group", className]
    .filter(Boolean)
    .join(" ");
  const resolvedSummary = summary ?? `${statusLabel} ${count} ${fileLabel}`;
  const resolvedDescription =
    description === undefined && normalizedStatus === "applied"
      ? "Review changes ↗"
      : description;
  const resolvedAriaLabel =
    ariaLabel ??
    (typeof resolvedSummary === "string" ||
    typeof resolvedSummary === "number"
      ? String(resolvedSummary)
      : undefined);

  return (
    <div
      aria-label={resolvedAriaLabel}
      className={classes}
      data-file-count={count}
      data-file-status={normalizedStatus}
      data-kind="file-change-group"
      role="group"
      {...props}
    >
      <div className="thread-file-change-group__header">
        <span className="thread-file-change-group__indicator">
          {indicator ?? <StatusIndicator status={toAgentStatus(status)} />}
        </span>
        <span className="thread-file-change-group__identity">
          <span className="thread-file-change-group__summary">
            {resolvedSummary}
          </span>
          {resolvedDescription ? (
            <span className="thread-file-change-group__description">
              {resolvedDescription}
            </span>
          ) : null}
        </span>
        {detail ? (
          <span className="thread-file-change-group__detail">{detail}</span>
        ) : null}
      </div>
      <div
        aria-label={`${count} changed ${fileLabel}`}
        className="thread-file-change-group__files"
        role="list"
      >
        {changes.map((change, index) => {
          const pathContent = change.previousPath
            ? `${change.previousPath} → ${change.path}`
            : change.path;
          const content = (
            <>
              <span className="thread-file-change-group__path">
                {pathContent}
              </span>
              <FileChangeStats
                additions={change.additions}
                change={change.change}
                deletions={change.deletions}
              />
            </>
          );

          return (
            <div
              className="thread-file-change-group__file"
              data-change={change.change}
              key={`${change.previousPath ?? ""}:${change.path}`}
              role="listitem"
            >
              {onOpenFile ? (
                <button
                  aria-label={`Open ${change.path}`}
                  onClick={() => onOpenFile(change, index)}
                  type="button"
                >
                  {content}
                </button>
              ) : (
                content
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
