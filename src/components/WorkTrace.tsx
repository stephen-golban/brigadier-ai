import { createContext, useContext, useState } from "react";
import { ToolCall } from "./assistant-ui/elements/tool-call";
import { ReasoningPanel } from "./assistant-ui/elements/reasoning-panel";
import { Button } from "./controls/button";
import { Markdown, CopyButton } from "./Markdown";
import { peerToolSessions } from "../peerPresentation";
import {
  flattenTrace,
  isAgent,
  traceLabel,
  traceFailed,
  type TraceNode,
  type ThreadRow,
} from "../threadProjection";

const SessionLinks = createContext<{
  titles: Record<string, string>;
  select?: (id: string) => void;
}>({ titles: {} });
type TraceProps = {
  expanded: Set<string>;
  toggle: (id: string) => void;
  onFile: (path: string) => void;
  running: boolean;
};
export function WorkTrace({
  row,
  sessionTitles = {},
  onSelectSession,
  ...props
}: Omit<TraceProps, "running"> & {
  row: Extract<ThreadRow, { type: "work" }>;
  sessionTitles?: Record<string, string>;
  onSelectSession?: (id: string) => void;
}) {
  return (
    <SessionLinks.Provider
      value={{ titles: sessionTitles, select: onSelectSession }}
    >
      <TraceList nodes={row.nodes} running={row.running} {...props} />
    </SessionLinks.Provider>
  );
}

function TraceList({ nodes, ...props }: TraceProps & { nodes: TraceNode[] }) {
  const [limit, setLimit] = useState(40);
  // Only adjacent independent calls collapse together. Prose remains in sequence,
  // and explicit parentage keeps each child inside its owning tool.
  const groups: TraceNode[][] = [];
  for (const node of nodes) {
    const last = groups[groups.length - 1];
    const batchable = (n: TraceNode) =>
      n.item.kind.type === "tool-call" &&
      !isAgent(n.item) &&
      !n.children.length;
    if (last && batchable(node) && batchable(last[0]!)) last.push(node);
    else groups.push([node]);
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {groups.slice(0, limit).map((group) => {
        const first = group[0]!;
        if (group.length === 1)
          return <TraceEntry key={first.item.id} node={first} {...props} />;
        const id = `batch:${first.item.id}`;
        const label = [...new Set(group.map((n) => traceLabel(n.item)))].join(
          ", ",
        );
        return (
          <ToolCall
            key={id}
            id={id}
            label={label}
            activeLabel={label}
            running={props.running && group.some((n) => !n.result)}
            failed={group.some(traceFailed)}
            completed={group.every((n) => n.result !== undefined)}
            open={props.expanded.has(id)}
            onOpenChange={() => props.toggle(id)}
          >
            <div className="ml-1 border-l border-hairline pl-4 py-2">
              <TraceBatch nodes={group} {...props} />
            </div>
          </ToolCall>
        );
      })}
      {groups.length > limit && (
        <Button
          variant="link"
          size="sm"
          onClick={() => setLimit((n) => n + 40)}
        >
          Show more activity ({groups.length - limit})
        </Button>
      )}
    </div>
  );
}
function TraceBatch({ nodes, ...props }: TraceProps & { nodes: TraceNode[] }) {
  const [limit, setLimit] = useState(40);
  return (
    <>
      {nodes.slice(0, limit).map((node) => (
        <TraceEntry key={node.item.id} node={node} {...props} />
      ))}
      {nodes.length > limit && (
        <Button
          variant="link"
          size="sm"
          onClick={() => setLimit((n) => n + 40)}
        >
          Show more ({nodes.length - limit})
        </Button>
      )}
    </>
  );
}
function TraceEntry({
  node,
  expanded,
  toggle,
  onFile,
  running,
}: TraceProps & { node: TraceNode }) {
  const { item, result, updates, children } = node;
  const links = useContext(SessionLinks);
  const open = expanded.has(item.id);
  if (item.kind.type === "thinking") {
    if (!item.body.trim())
      return children.length ? (
        <TraceList
          nodes={children}
          expanded={expanded}
          toggle={toggle}
          onFile={onFile}
          running={running}
        />
      ) : null;
    return (
      <ReasoningPanel
        steps={[
          { title: "", body: <Markdown text={item.body} onFile={onFile} /> },
        ]}
        visibleSteps={1}
        streaming={false}
        open={open}
        onOpenChange={() => toggle(item.id)}
        restingLabel="Reasoning"
        className="max-w-none"
      />
    );
  }
  if (item.kind.type === "assistant-text" || item.kind.type === "user-text")
    return (
      <div className="py-2">
        {item.body.trim() && <Markdown text={item.body} onFile={onFile} />}
        {children.length > 0 && (
          <TraceList
            nodes={children}
            expanded={expanded}
            toggle={toggle}
            onFile={onFile}
            running={running}
          />
        )}
      </div>
    );
  const sessions =
    item.kind.type === "tool-call" &&
    item.kind.name.startsWith("mcp__brigadier__")
      ? peerToolSessions(item.body, result?.body)
      : [];
  const failed = flattenTrace([node]).some(traceFailed);
  const label = conciseAction(item);
  const output = item.kind.type === "tool-result" ? item.body : result?.body;
  const request = item.kind.type === "tool-result" ? undefined : item.body;
  return (
    <ToolCall
      id={item.id}
      label={label}
      activeLabel={label}
      request={request}
      result={output}
      failed={failed}
      running={running && item.kind.type === "tool-call" && !result}
      open={open}
      onOpenChange={() => toggle(item.id)}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {links.select &&
            sessions.map((s) => (
              <Button
                key={s.id}
                variant="link"
                size="sm"
                onClick={() => links.select?.(s.id)}
              >
                {links.titles[s.id] ?? s.title ?? s.id}
                {s.status ? ` · ${s.status}` : ""}
              </Button>
            ))}
          {(output ?? request)?.trim() && (
            <CopyButton text={(output ?? request)!} />
          )}
        </div>
      }
    >
      {(updates.length > 0 || children.length > 0) && (
        <div className="ml-1 border-l border-hairline pl-4 py-2">
          {updates
            .filter((u) => u.body.trim())
            .map((update) => (
              <div key={update.id} className="py-2">
                <Markdown text={update.body} onFile={onFile} />
              </div>
            ))}
          <TraceList
            nodes={children}
            expanded={expanded}
            toggle={toggle}
            onFile={onFile}
            running={running}
          />
        </div>
      )}
    </ToolCall>
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
