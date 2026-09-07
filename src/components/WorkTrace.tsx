import {
  ChainOfThoughtStep,
  ChainOfThoughtTrigger,
  ChainOfThoughtContent,
} from "./prompt-kit/chain-of-thought";
import { CircularLoader } from "./prompt-kit/loader";
import { Button } from "./ui/button";
import { useState } from "react";
import {
  TerminalIcon,
  BookOpenIcon,
  MagnifyingGlassIcon,
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
    <ChainOfThoughtStep
      open={open}
      onOpenChange={() => toggle(row.running ? `closed:${row.id}` : row.id)}
      isLast
    >
      <ChainOfThoughtTrigger
        className="py-2"
        leftIcon={row.running ? <CircularLoader size="sm" /> : undefined}
      >
        <span>{label}</span>{" "}
        {row.failures > 0 && (
          <span className="text-destructive text-xs">
            {row.failures} failed
          </span>
        )}
      </ChainOfThoughtTrigger>
      <ChainOfThoughtContent>
        <TraceList
          nodes={row.nodes}
          expanded={expanded}
          toggle={toggle}
          onFile={onFile}
        />
      </ChainOfThoughtContent>
    </ChainOfThoughtStep>
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
          <ChainOfThoughtStep
            key={id}
            open={open}
            onOpenChange={() => toggle(id)}
            isLast
          >
            <ChainOfThoughtTrigger className="py-1">
              <span>
                {[...new Set(group.map((n) => traceLabel(n.item)))].join(", ")}
              </span>
              {group.some(traceFailed) && (
                <span className="text-destructive text-xs">Failed</span>
              )}
            </ChainOfThoughtTrigger>
            <ChainOfThoughtContent>
              <TraceBatch
                nodes={group}
                expanded={expanded}
                toggle={toggle}
                onFile={onFile}
              />
            </ChainOfThoughtContent>
          </ChainOfThoughtStep>
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
      <div className="my-3 space-y-2 text-sm">
        <Markdown text={item.body} onFile={onFile} />
        <CopyButton text={item.body} />
      </div>
    );
  const textOnly =
    item.kind.type === "thinking" || item.kind.type === "assistant-text";
  return (
    <ChainOfThoughtStep
      open={open}
      onOpenChange={() => toggle(item.id)}
      isLast
      data-trace-id={item.id}
    >
      <ChainOfThoughtTrigger
        className="w-full py-1 [&>div]:min-w-0 [&>div>span:last-child]:truncate"
        leftIcon={<Icon size={15} />}
      >
        <span title={label}>{label}</span>{" "}
        {failed ? (
          <span className="text-destructive text-xs">Failed</span>
        ) : null}{" "}
        {agent && updates.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {updates.length} updates
          </span>
        )}
      </ChainOfThoughtTrigger>
      <ChainOfThoughtContent>
        {textOnly ? (
          <Markdown text={item.body} onFile={onFile} />
        ) : agent ? (
          <details className="rounded-lg border border-border bg-card p-3 text-xs [&_pre]:max-h-80 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words">
            <summary>Task details</summary>
            <pre>{item.body}</pre>
          </details>
        ) : (
          <div className="rounded-lg border border-border bg-card p-3 text-xs [&_pre]:max-h-80 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words">
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
          <div className="rounded-lg border border-border bg-card p-3 text-xs [&_pre]:max-h-80 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words">
            <span>{failed ? "Error" : "Output"}</span>
            <pre>{result.body}</pre>
            <CopyButton text={result.body} />
          </div>
        )}
      </ChainOfThoughtContent>
    </ChainOfThoughtStep>
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
