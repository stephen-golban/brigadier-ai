// Vendored from the Codex UI Kit (MIT); see src/components/thread/UPSTREAM.md.
import { Globe, Search as SearchGlyph } from "../../icons";
import type { HTMLAttributes, ReactNode } from "react";
import type { AgentItemStatus } from "./types";
import { AgentActivity, type AgentActivityProps } from "./AgentActivity";

export type SearchActivityKind = "code" | "web";

export interface SearchActivityEntry {
  completed?: boolean;
  detail: string;
  favicon?: ReactNode;
  faviconUrl?: string;
  id: string;
}

export interface SearchActivityProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Brigadier addition: the disclosure body. The kit's own body is the `entries` list and
   *  nothing else; brigadier has no `entries` for a `Grep`, but it does have the result. */
  children?: ReactNode;
  defaultOpen?: boolean;
  /** Brigadier addition: forwarded to `AgentActivity` (see `CommandExecution.tsx`). */
  disclosureIndicator?: AgentActivityProps["disclosureIndicator"];
  /** Brigadier addition: forwarded to `AgentActivity`. */
  disclosureMode?: AgentActivityProps["disclosureMode"];
  entries?: readonly SearchActivityEntry[];
  kind: SearchActivityKind;
  onEntryOpen?: (entry: SearchActivityEntry) => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  path?: string;
  query?: string;
  status: AgentItemStatus;
}

function SearchIcon({ kind }: { kind: SearchActivityKind }) {
  return kind === "web" ? (
    <Globe aria-hidden="true" className="thread-search-activity__icon" />
  ) : (
    <SearchGlyph aria-hidden="true" className="thread-search-activity__icon" />
  );
}

function codeSearchSummary(
  status: AgentItemStatus,
  query?: string,
  path?: string,
) {
  const verb =
    status === "running" || status === "pending"
      ? "Searching"
      : status === "failed"
        ? "Search failed"
        : "Searched";
  if (query && path) return `${verb} for ${query} in ${path}`;
  if (query) return `${verb} for ${query}`;
  return `${verb} for files`;
}

export function SearchActivity({
  children,
  className,
  defaultOpen = false,
  disclosureIndicator,
  disclosureMode,
  entries = [],
  kind,
  onEntryOpen,
  onOpenChange,
  open,
  path,
  query,
  status,
  ...props
}: SearchActivityProps) {
  const classes = ["thread-search-activity", className]
    .filter(Boolean)
    .join(" ");
  const isActive = status === "running" || status === "pending";
  const unfinishedEntry = [...entries]
    .reverse()
    .find((entry) => entry.completed !== true);
  const detail = isActive
    ? (unfinishedEntry?.detail ?? query)
    : (entries[entries.length - 1]?.detail ?? query);
  const webDetail = isActive || entries.length === 0 ? detail : undefined;
  const action =
    kind === "web"
      ? isActive
        ? "Searching the web"
        : status === "failed"
          ? "Web search failed"
          : "Searched the web"
      : codeSearchSummary(status, query, path);
  const summary =
    kind === "web" ? (
      <>
        <span
          className="thread-search-activity__action"
          data-active={isActive || undefined}
        >
          {action}
          {webDetail ? " " : null}
        </span>
        {webDetail ? (
          <span className="thread-search-activity__detail">
            {`for ${webDetail}`}
          </span>
        ) : null}
      </>
    ) : (
      <span
        className="thread-search-activity__action"
        data-active={isActive || undefined}
      >
        {action}
      </span>
    );
  const entryList = entries.length > 0 ? (
    <ol className="thread-search-activity__entries" tabIndex={0}>
      {entries.map((entry) => {
        const content = (
          <>
            {entry.favicon ??
              (entry.faviconUrl ? (
                <img alt="" src={entry.faviconUrl} />
              ) : kind === "web" ? (
                <SearchIcon kind="web" />
              ) : null)}
            <span>{entry.detail}</span>
          </>
        );
        return (
          <li data-completed={entry.completed || undefined} key={entry.id}>
            {onEntryOpen ? (
              <button onClick={() => onEntryOpen(entry)} type="button">
                {content}
              </button>
            ) : (
              <div>{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  ) : undefined;
  const body =
    entryList === undefined && (children === undefined || children === null)
      ? undefined
      : (
          <>
            {entryList}
            {children}
          </>
        );

  return (
    <AgentActivity
      className={classes}
      data-search-kind={kind}
      defaultOpen={defaultOpen}
      disclosureIndicator={disclosureIndicator}
      disclosureMode={disclosureMode}
      indicator={<SearchIcon kind={kind} />}
      kind="search"
      onOpenChange={onOpenChange}
      open={open}
      status={status}
      summary={summary}
      {...props}
    >
      {body}
    </AgentActivity>
  );
}
