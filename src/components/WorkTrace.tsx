import { useState } from "react";
import {
  TerminalIcon,
  BookOpenIcon,
  MagnifyingGlassIcon,
  BrainIcon,
  PencilSimpleIcon,
  WrenchIcon,
  UsersThreeIcon,
  CaretRightIcon,
} from "@phosphor-icons/react";
import { Markdown, CopyButton } from "./Markdown";
import {
  isAgent,
  traceLabel,
  traceFailed,
  type TraceNode,
  type ThreadRow,
} from "../threadProjection";
type WorkRow = Extract<ThreadRow, { type: "work" }>;
export function WorkTrace({
  row,
  expanded,
  toggle,
  onFile,
}: {
  row: WorkRow;
  expanded: Set<string>;
  toggle: (id: string) => void;
  onFile: (path: string) => void;
}) {
  const open =
    expanded.has(row.id) || (row.running && !expanded.has(`closed:${row.id}`));
  const seconds = !row.durationMs
    ? null
    : Math.max(0, Math.floor(row.durationMs / 1000));
  const duration =
    seconds === null
      ? ""
      : seconds >= 3600
        ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`
        : seconds >= 60
          ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
          : `${seconds}s`;
  const label = row.running
    ? "Working…"
    : duration
      ? `Worked for ${duration}`
      : "Worked";
  return (
    <div className="work-trace">
      <button
        className="work-summary"
        aria-expanded={open}
        aria-controls={`trace-${row.id}`}
        onClick={() => toggle(row.running ? `closed:${row.id}` : row.id)}
      >
        {row.running && <span className="working-dot" />}
        <span>{label}</span>
        <CaretRightIcon className={open ? "rotated" : ""} />{" "}
        {row.failures > 0 && (
          <span className="trace-failure">{row.failures} failed</span>
        )}
      </button>
      {open && (
        <div className="work-details" id={`trace-${row.id}`}>
          <TraceList
            nodes={row.nodes}
            expanded={expanded}
            toggle={toggle}
            onFile={onFile}
          />
        </div>
      )}
    </div>
  );
}
function TraceList({
  nodes,
  expanded,
  toggle,
  onFile,
}: {
  nodes: TraceNode[];
  expanded: Set<string>;
  toggle: (id: string) => void;
  onFile: (path: string) => void;
}) {
  const [limit, setLimit] = useState(40);
  // Only adjacent, unrelated leaf calls share a category; explicit parentage always wins.
  const groups: TraceNode[][] = [];
  for (const node of nodes) {
    const last = groups[groups.length - 1];
    if (
      last &&
      node.item.kind.type === "tool-call" &&
      !isAgent(node.item) &&
      !node.children.length &&
      last[0]!.item.kind.type === "tool-call" &&
      !isAgent(last[0]!.item) &&
      !last[0]!.children.length
    )
      last.push(node);
    else groups.push([node]);
  }
  return (
    <>
      {groups.slice(0, limit).map((group) => {
        const first = group[0]!;
        if (group.length === 1)
          return (
            <TraceEntry
              key={first.item.id}
              node={first}
              expanded={expanded}
              toggle={toggle}
              onFile={onFile}
            />
          );
        const id = `batch:${first.item.id}`;
        const open = expanded.has(id);
        return (
          <div className="trace-entry" key={id}>
            <button
              className="trace-summary"
              aria-expanded={open}
              onClick={() => toggle(id)}
            >
              <CaretRightIcon className={open ? "rotated" : ""} />
              <span>
                {[...new Set(group.map((n) => traceLabel(n.item)))].join(", ")}
              </span>
              {group.some(traceFailed) && (
                <span className="trace-failure">Failed</span>
              )}
            </button>
            {open && (
              <div className="trace-children">
                <TraceBatch
                  nodes={group}
                  expanded={expanded}
                  toggle={toggle}
                  onFile={onFile}
                />
              </div>
            )}
          </div>
        );
      })}
      {groups.length > limit && (
        <button className="trace-more" onClick={() => setLimit((n) => n + 40)}>
          Show more activity ({groups.length - limit})
        </button>
      )}
    </>
  );
}
function TraceBatch({
  nodes,
  expanded,
  toggle,
  onFile,
}: {
  nodes: TraceNode[];
  expanded: Set<string>;
  toggle: (id: string) => void;
  onFile: (path: string) => void;
}) {
  const [limit, setLimit] = useState(40);
  return (
    <>
      {nodes.slice(0, limit).map((node) => (
        <TraceEntry
          key={node.item.id}
          node={node}
          expanded={expanded}
          toggle={toggle}
          onFile={onFile}
        />
      ))}
      {nodes.length > limit && (
        <button className="trace-more" onClick={() => setLimit((n) => n + 40)}>
          Show more ({nodes.length - limit})
        </button>
      )}
    </>
  );
}
function TraceEntry({
  node,
  expanded,
  toggle,
  onFile,
}: {
  node: TraceNode;
  expanded: Set<string>;
  toggle: (id: string) => void;
  onFile: (path: string) => void;
}) {
  const { item, result, children, updates } = node;
  const open = expanded.has(item.id);
  const agent = isAgent(item);
  const failed = traceFailed(node);
  const category = traceLabel(item);
  const label = conciseAction(item);
  const Icon = isAgent(item)
    ? UsersThreeIcon
    : category === "Read files"
      ? BookOpenIcon
      : category === "Ran commands"
        ? TerminalIcon
        : category === "Thinking"
          ? BrainIcon
          : category === "Edit files"
            ? PencilSimpleIcon
            : category.includes("earch")
              ? MagnifyingGlassIcon
              : WrenchIcon;
  if (item.kind.type === "assistant-text" && !children.length)
    return (
      <div className="trace-progress">
        <Markdown text={item.body} onFile={onFile} />
        <CopyButton text={item.body} />
      </div>
    );
  const textOnly =
    item.kind.type === "thinking" || item.kind.type === "assistant-text";
  return (
    <div className="trace-entry">
      <button
        className="trace-summary"
        aria-expanded={open}
        aria-controls={`detail-${item.id}`}
        onClick={() => toggle(item.id)}
      >
        <CaretRightIcon className={open ? "rotated" : ""} />
        <Icon size={15} />
        <span title={label}>{label}</span>{" "}
        {failed ? <span className="trace-failure">Failed</span> : null}{" "}
        {agent && updates.length > 0 && (
          <span className="trace-outcome">{updates.length} updates</span>
        )}
      </button>
      {open && (
        <div className="trace-children" id={`detail-${item.id}`}>
          {textOnly ? (
            <Markdown text={item.body} onFile={onFile} />
          ) : agent ? (
            <details className="trace-raw">
              <summary>Task details</summary>
              <pre>{item.body}</pre>
            </details>
          ) : (
            <div className="trace-raw">
              <pre>{item.body}</pre>
            </div>
          )}
          <CopyButton text={item.body} />
          {updates.map((update) => (
            <div key={update.id} className="trace-progress">
              <Markdown text={update.body} onFile={onFile} />
              <CopyButton text={update.body} />
            </div>
          ))}
          {children.length > 0 && (
            <TraceList
              nodes={children}
              expanded={expanded}
              toggle={toggle}
              onFile={onFile}
            />
          )}
          {result && (
            <div className="trace-raw">
              <span>{failed ? "Error" : "Output"}</span>
              <pre>{result.body}</pre>
              <CopyButton text={result.body} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function conciseAction(item: TraceNode["item"]) {
  const label = traceLabel(item);
  if (item.kind.type !== "tool-call") return label;
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(item.body.slice(item.body.indexOf("{")));
  } catch {
    /* Older records remain expandable verbatim. */
  }
  const path = input.file_path ?? input.path ?? input.file;
  if (label === "Read files" && typeof path === "string") return `Read ${path}`;
  if (label === "Edit files" && typeof path === "string")
    return `Edited ${path}`;
  if (label === "Ran commands")
    return `Ran ${String(
      input.command ??
        input.cmd ??
        (item.body.trim().startsWith("{")
          ? "command"
          : item.body.trim() || "command"),
    )
      .split("\n")[0]!
      .slice(0, 180)}`;
  if (label === "Searched files")
    return `Searched for ${String(input.pattern ?? input.query ?? "files").slice(0, 120)}${path ? ` in ${path}` : ""}`;
  return label;
}
