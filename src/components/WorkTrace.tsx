import { useState } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";
import { Markdown, CopyButton } from "./Markdown";
import {
  flattenTrace,
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
  const open = expanded.has(row.id);
  const agents = flattenTrace(row.nodes).filter((n) => isAgent(n.item)).length;
  const label = [
    row.running ? "Working" : "Worked",
    row.count ? `${row.count} ${row.count === 1 ? "action" : "actions"}` : null,
    agents ? `${agents} ${agents === 1 ? "agent" : "agents"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="work-trace">
      <button
        className="work-summary"
        aria-expanded={open}
        aria-controls={`trace-${row.id}`}
        onClick={() => toggle(row.id)}
      >
        <CaretRightIcon className={open ? "rotated" : ""} />
        {row.running && <span className="working-dot" />}
        <span>{label}</span>{" "}
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
      !last[0]!.children.length &&
      traceLabel(last[0]!.item) === traceLabel(node.item)
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
                {traceLabel(first.item)} · {group.length}
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
  const label = traceLabel(item);
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
        <span>{label}</span>{" "}
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
