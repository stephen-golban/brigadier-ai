import { SearchIcon } from "./SearchIcon";
import { ToolCall } from "./assistant-ui/elements/tool-call";
import { Details, DetailsSummary } from "./controls/details";
import {
  ReasoningRoot,
  ReasoningTrigger,
  ReasoningContent,
} from "./assistant-ui/elements/reasoning";
import { Spinner } from "./controls/status";
import { Button } from "./controls/button";
import { createContext, useContext, useState } from "react";
import { peerToolSessions } from "../peerPresentation";
const SessionLinks = createContext<{ titles: Record<string, string>; select?: (id: string) => void }>({ titles: {} });
import {
  TerminalIcon,
  BookOpenIcon,
  BrainIcon,
  PencilSimpleIcon,
  WrenchIcon,
  UsersThreeIcon,
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
  sessionTitles = {},
  onSelectSession,
}: {
  sessionTitles?: Record<string, string>;
  onSelectSession?: (id: string) => void;
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
  const unfinished: TraceNode[] = [];
  const inspect = (nodes: TraceNode[]) => {
    for (const node of nodes) {
      if (node.item.kind.type === "tool-call" && !node.result)
        unfinished.push(node);
      inspect(node.children);
    }
  };
  if (row.running) inspect(row.nodes);
  const currentAction = unfinished.sort((a, b) => a.item.at - b.item.at)[
    unfinished.length - 1
  ];
  const label = row.running
    ? "Working…"
    : duration
      ? `Worked for ${duration}`
      : "Worked";
  return (
    <SessionLinks.Provider value={{ titles: sessionTitles, select: onSelectSession }}>
    <ReasoningRoot
      open={open}
      onOpenChange={() => toggle(row.running ? `closed:${row.id}` : row.id)}
    >
      <ReasoningTrigger
        className="py-2"
        leftIcon={row.running ? <Spinner size="sm" /> : undefined}
      >
        <span>{label}</span>
        {currentAction && (
          <span className="min-w-0 truncate text-xs text-text-secondary">
            {conciseAction(currentAction.item)}
          </span>
        )}{" "}
        {row.failures > 0 && (
          <span className="text-error text-xs">{row.failures} failed</span>
        )}
      </ReasoningTrigger>
      <ReasoningContent>
        <TraceList
          nodes={row.nodes}
          expanded={expanded}
          toggle={toggle}
          onFile={onFile}
        />
      </ReasoningContent>
    </ReasoningRoot>
    </SessionLinks.Provider>
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
          <ReasoningRoot key={id} open={open} onOpenChange={() => toggle(id)}>
            <ReasoningTrigger className="py-1">
              <span>
                {[...new Set(group.map((n) => traceLabel(n.item)))].join(", ")}
              </span>
              {group.some(traceFailed) && (
                <span className="text-error text-xs">Failed</span>
              )}
            </ReasoningTrigger>
            <ReasoningContent>
              <TraceBatch
                nodes={group}
                expanded={expanded}
                toggle={toggle}
                onFile={onFile}
              />
            </ReasoningContent>
          </ReasoningRoot>
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
}: {
  node: TraceNode;
  expanded: Set<string>;
  toggle: (id: string) => void;
  onFile: (path: string) => void;
}) {
  const { item, result, children, updates } = node;
  const links = useContext(SessionLinks);
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
              ? SearchIcon
              : WrenchIcon;
  if (item.kind.type === "tool-call" && item.kind.name.startsWith("mcp__brigadier__")) {
    const sessions = peerToolSessions(item.body, result?.body);
    return <ToolCall
      id={item.id}
      label={label}
      request={item.body}
      result={result?.body}
      failed={failed}
      open={open}
      onOpenChange={() => toggle(item.id)}
      actions={<div className="mt-2 flex flex-wrap items-center gap-2">
        {links.select && sessions.map((s) => <Button key={s.id} variant="link" size="sm" onClick={() => links.select?.(s.id)}>
          {links.titles[s.id] ?? s.title ?? s.id}{s.status ? ` · ${s.status}` : ""}
        </Button>)}
        <CopyButton text={result?.body ?? item.body} />
      </div>}
    />;
  }
  if (item.kind.type === "assistant-text" && !children.length)
    return (
      <div className="my-3 space-y-2 text-sm">
        <Markdown text={item.body} onFile={onFile} />
        <CopyButton text={item.body} />
      </div>
    );
  if (
    item.kind.type === "tool-call" &&
    !agent &&
    !children.length &&
    !updates.length
  )
    return (
      <ToolCall
        id={item.id}
        label={label}
        request={item.body}
        result={result?.body}
        failed={failed}
        open={open}
        onOpenChange={() => toggle(item.id)}
        actions={<CopyButton text={result?.body ?? item.body} />}
      />
    );
  const textOnly =
    item.kind.type === "thinking" || item.kind.type === "assistant-text";
  return (
    <ReasoningRoot
      open={open}
      onOpenChange={() => toggle(item.id)}
      data-trace-id={item.id}
    >
      <ReasoningTrigger
        className="w-full py-1 [&>div]:min-w-0 [&>div>span:last-child]:truncate"
        leftIcon={<Icon size={15} />}
      >
        <span title={label}>{label}</span>{" "}
        {failed ? <span className="text-error text-xs">Failed</span> : null}{" "}
        {agent && updates.length > 0 && (
          <span className="text-xs text-text-secondary">
            {updates.length} updates
          </span>
        )}
      </ReasoningTrigger>
      <ReasoningContent>
        {textOnly ? (
          <Markdown text={item.body} onFile={onFile} />
        ) : agent ? (
          <Details className="rounded-lg border border-hairline bg-elevated p-3 text-xs [&_pre]:max-h-80 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words">
            <DetailsSummary>Task details</DetailsSummary>
            <pre>{item.body}</pre>
          </Details>
        ) : (
          <div className="rounded-lg border border-hairline bg-elevated p-3 text-xs [&_pre]:max-h-80 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words">
            <pre>{item.body}</pre>
          </div>
        )}
        <CopyButton text={item.body} />
        {updates.map((update) => (
          <div key={update.id} className="my-3 space-y-2 text-sm">
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
          <div className="rounded-lg border border-hairline bg-elevated p-3 text-xs [&_pre]:max-h-80 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words">
            <span>{failed ? "Error" : "Output"}</span>
            <pre>{result.body}</pre>
            <CopyButton text={result.body} />
          </div>
        )}
      </ReasoningContent>
    </ReasoningRoot>
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
