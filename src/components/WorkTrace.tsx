import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { BookOpen, ChevronRight, Globe, Nodes, Pencil, Search, Terminal } from "../icons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { ShimmerLabel } from "../lib/surfaces";
import { ToolCall } from "./assistant-ui/elements/tool-call";
import { ReasoningPanel } from "./assistant-ui/elements/reasoning-panel";
import { Button } from "@/components/ui/button";
import { Markdown, CopyButton } from "./Markdown";
import { usePeerTaskCards, usePeerReceiptScope } from "./peer/PeerTaskCardScope";
import { PeerDeliveryReceipt } from "./peer/PeerMessages";
import { PeerAttachmentPreviews } from "./peer/PeerAttachmentPreviews";
import { LinkedTaskCards } from "./peer/LinkedTaskCards";
import { peerTaskTitle, peerToolCards, peerToolSessions } from "../peerPresentation";
import {
  flattenTrace,
  isAgent,
  traceLabel,
  traceFailed,
  activeWorkLabel,
  activitySummary,
  workDuration,
  type TraceNode,
  type ThreadRow,
} from "../threadProjection";

const HasPendingApproval = createContext(false);
const ActionRequests = createContext<ReadonlyMap<string, ReactNode>>(new Map());
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
  actionRequests = new Map(),
  hasPendingApproval = false,
  ...props
}: Omit<TraceProps, "running"> & {
  row: Extract<ThreadRow, { type: "work" }>;
  hasPendingApproval?: boolean;
  actionRequests?: ReadonlyMap<string, ReactNode>;
  sessionTitles?: Record<string, string>;
  onSelectSession?: (id: string) => void;
}) {
  const scopedCards = usePeerTaskCards(row.id);
  const receipts = usePeerReceiptScope()?.receipts.get(row.id);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!row.running || row.startedAt == null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [row.running, row.startedAt]);
  // Only work preceding a final answer folds. An interrupted turn stays inspectable.
  const open = hasPendingApproval || !row.canCollapse || props.expanded.has(row.id);
  const elapsed =
    row.running && row.startedAt != null
      ? Math.max(0, now - row.startedAt)
      : row.durationMs;
  const duration = elapsed != null ? workDuration(elapsed) : null;
  const outcome = row.running
    ? "Working"
    : row.status === "failed"
      ? "Failed"
      : row.status === "interrupted"
        ? "You stopped"
        : row.status === "stopped"
          ? "Stopped"
          : "Worked";
  const summary = `${outcome}${duration && (!row.running || elapsed! >= 1000) ? `${row.status === "interrupted" ? " after" : " for"} ${duration}` : ""}`;
  const heading = (
    <>
      <span>{summary}</span>
      {row.canCollapse && (
        <ChevronRight
          aria-hidden
          className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
      )}
      {row.failures > 0 && (
        <span className="text-error">
          {" "}
          · {row.failures} {row.failures === 1 ? "failure" : "failures"}
        </span>
      )}
    </>
  );
  const last = row.nodes[row.nodes.length - 1];
  // `row.streamingAnswer` says the turn's trailing prose is already being drawn as an answer row
  // below this one (`src/threadProjection.ts`). The model is visibly writing, so a shimmer here
  // would claim it is thinking directly above the words arriving — and on a turn whose only
  // content so far is that prose, this row has no nodes at all, which is the `!last` arm.
  const needsThinking =
    row.running &&
    !row.streamingAnswer &&
    (!last ||
      last.item.kind.type === "assistant-text" ||
      last.item.kind.type === "thinking");
  return (
    <HasPendingApproval.Provider value={hasPendingApproval}><ActionRequests.Provider value={actionRequests}><SessionLinks.Provider
      value={{ titles: sessionTitles, select: onSelectSession }}
    >
      <Collapsible
        open={open}
        onOpenChange={() => props.toggle(row.id)}
        data-work-status={row.status}
        className="work-block min-w-0"
      >
        <div className="work-turn-heading mb-4 border-b border-hairline pb-2 text-[13.5px] text-text-secondary tabular-nums">
          {row.canCollapse ? (
            <CollapsibleTrigger className="flex items-center gap-1 rounded-sm text-left focus-visible:outline focus-visible:outline-1">
              {heading}
            </CollapsibleTrigger>
          ) : (
            <div className="flex items-center gap-1">{heading}</div>
          )}
        </div>
        <CollapsibleContent>
          <TraceList nodes={row.nodes} running={row.running} {...props} />
          {needsThinking && (
            <div
              role="status"
              className="mt-4 text-[13.5px] text-text-secondary"
            >
              <ShimmerLabel active>Thinking</ShimmerLabel>
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
      <LinkedTaskCards tasks={scopedCards ?? flattenTrace(row.nodes).flatMap(node => node.item.kind.type === "tool-call"
        ? peerToolCards(node.item.kind.name, node.item.body, node.result?.body, traceFailed(node), {titles: sessionTitles}, node.item.id)
        : [])} onSelectSession={onSelectSession} />
      {receipts?.map(message => <PeerDeliveryReceipt key={message.id} message={message} destination={peerTaskTitle(message.to, sessionTitles)}>
        <PeerAttachmentPreviews message={message} />
      </PeerDeliveryReceipt>)}
    </SessionLinks.Provider></ActionRequests.Provider></HasPendingApproval.Provider>
  );
}

function TraceList({ nodes, ...props }: TraceProps & { nodes: TraceNode[] }) {
  const [storedLimit, setLimit] = useState(40);
  const actionRequests = useContext(ActionRequests);
  const pendingApproval = useContext(HasPendingApproval);
  const limit = pendingApproval ? Number.MAX_SAFE_INTEGER : storedLimit;
  // Only adjacent independent calls collapse together. Prose remains in sequence,
  // and explicit parentage keeps each child inside its owning tool.
  const groups: TraceNode[][] = [];
  for (const node of nodes) {
    const last = groups[groups.length - 1];
    const batchable = (n: TraceNode) =>
      n.item.kind.type === "tool-call" &&
      !isAgent(n.item) &&
      !n.children.length && !actionRequests.has(n.item.id);
    if (last && batchable(node) && batchable(last[0]!)) last.push(node);
    else groups.push([node]);
  }
  const more = groups.length > limit && (
    <Button variant="link" size="sm" onClick={() => setLimit((n) => n + 40)}>
      {props.running ? "Show earlier activity" : "Show more activity"} (
      {groups.length - limit})
    </Button>
  );
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {props.running && more}
      {(props.running ? groups.slice(-limit) : groups.slice(0, limit)).map(
        (group, index, shown) => {
          const live = props.running && index === shown.length - 1;
          const first = group[0]!;
          if (group.length === 1)
            return (
              <TraceEntry
                key={first.item.id}
                node={first}
                {...props}
                running={live}
                current={live}
              />
            );
          const id = `batch:${first.item.id}`;
          const label = activitySummary(group);
          return (
            <ToolCall
              key={id}
              id={id}
              icon={<ActivityIcon item={first.item} />}
              label={label}
              activeLabel={activeWorkLabel(group)}
              running={live}
              failed={group.some(traceFailed)}
              completed={group.every((n) => n.result !== undefined)}
              open={props.expanded.has(id)}
              onOpenChange={() => props.toggle(id)}
            >
              <div className="work-group-details max-h-56 overflow-y-auto py-1">
                <TraceBatch nodes={group} {...props} running={live} />
              </div>
            </ToolCall>
          );
        },
      )}
      {!props.running && more}
    </div>
  );
}
function TraceBatch({ nodes, ...props }: TraceProps & { nodes: TraceNode[] }) {
  const [storedLimit, setLimit] = useState(40);
  const pendingApproval = useContext(HasPendingApproval);
  const limit = pendingApproval ? Number.MAX_SAFE_INTEGER : storedLimit;
  const more = nodes.length > limit && (
    <Button variant="link" size="sm" onClick={() => setLimit((n) => n + 40)}>
      {props.running ? "Show earlier" : "Show more"} ({nodes.length - limit})
    </Button>
  );
  return (
    <>
      {props.running && more}
      {(props.running ? nodes.slice(-limit) : nodes.slice(0, limit)).map(
        (node) => (
          <TraceEntry key={node.item.id} node={node} {...props} />
        ),
      )}
      {!props.running && more}
    </>
  );
}
function TraceEntry({
  node,
  expanded,
  toggle,
  onFile,
  running,
  current = false,
}: TraceProps & { node: TraceNode; current?: boolean }) {
  const { item, result, updates, children } = node;
  const links = useContext(SessionLinks);
  const actionRequests = useContext(ActionRequests);
  const pendingApproval = useContext(HasPendingApproval);
  const open = expanded.has(item.id) || (pendingApproval && flattenTrace(children).some(child => actionRequests.has(child.item.id)));
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
    <>
    <ToolCall
      id={item.id}
      icon={<ActivityIcon item={item} />}
      label={label}
      activeLabel={
        current && result
          ? "Thinking"
          : label
              .replace(/^Ran /, "Running ")
              .replace(/^Searched /, "Searching ")
              .replace(/^Read /, "Reading ")
              .replace(/^Edited /, "Editing ")
      }
      request={request}
      result={output}
      failed={failed}
      running={
        current || (running && item.kind.type === "tool-call" && !result)
      }
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
    {actionRequests.get(item.id)}
    </>
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
  // The disclosure retains the full request; the activity line needs only the file.
  const filename =
    typeof path === "string"
      ? (path.split(/[\\/]/).filter(Boolean).pop() ?? path)
      : undefined;
  if (label === "Read files" && filename) return `Read ${filename}`;
  if (label === "Edit files" && typeof path === "string")
    return `Edited ${filename}`;
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

function ActivityIcon({ item }: { item: TraceNode["item"] }) {
  const label = traceLabel(item);
  const Icon = isAgent(item)
    ? Nodes
    : label === "Read files"
      ? BookOpen
      : label === "Searched files"
        ? Search
        : label === "Edit files"
          ? Pencil
          : label === "Web research"
            ? Globe
            : Terminal;
  return <Icon aria-hidden className="size-3.5 shrink-0" />;
}
