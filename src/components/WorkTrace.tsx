import { createContext, useContext, useState, type ReactNode } from "react";
import { BookOpen, Globe, Nodes, Pencil, Search, Terminal } from "../icons";
import { ActivityTimeline } from "./thread/ActivityTimeline";
import { AgentActivity } from "./thread/AgentActivity";
import { CommandExecution, CommandOutput } from "./thread/CommandExecution";
import { FileChangeStats } from "./thread/FileChangeGroup";
import { SearchActivity } from "./thread/SearchActivity";
import { LoadingShimmer } from "./thread/ThreadState";
import { TurnDuration, type TurnDurationStatus } from "./thread/TurnDuration";
import type { AgentItemStatus } from "./thread/types";
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

/**
 * D6, plan §3 row 5. The elapsed figure is noise on a turn that took four seconds, so it
 * renders only above a minute; the completion time renders whatever the turn took. Both are
 * deliberate — do not "restore" the always-on duration.
 */
const DURATION_FLOOR_MS = 60_000;

/** `· done 3:04 PM`, or `· done Mar 3 at 3:04 PM` when the turn did not end today. */
function doneLabel(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (date.toDateString() === new Date().toDateString()) return `done ${time}`;
  return `done ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}

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
  // Only work preceding a final answer folds. An interrupted turn stays inspectable.
  const open = hasPendingApproval || !row.canCollapse || props.expanded.has(row.id);
  const outcome = row.running
    ? "Working"
    : row.status === "failed"
      ? "Failed"
      : row.status === "interrupted"
        ? "You stopped"
        : row.status === "stopped"
          ? "Stopped"
          : "Worked";
  const status: TurnDurationStatus = row.running
    ? "working"
    : row.status === "interrupted" || row.status === "stopped"
      ? "stopped"
      : "worked";
  const longEnough = (row.durationMs ?? 0) >= DURATION_FLOOR_MS;
  // One text node, not a label span plus a time span: the accessible-name algorithm trims
  // each element's text before joining, so a separate ` · done …` span reads back as
  // `Worked for 15m 53s· done …` with the separator's space gone.
  const done = row.completedAtMs != null ? ` · ${doneLabel(row.completedAtMs)}` : "";
  const heading = (
    <>
      {/* The kit owns the 1 s tick and the d/h/m/s formatting; brigadier owns every word. */}
      <TurnDuration
        className="work-turn-duration"
        status={status}
        startedAtMs={row.startedAt}
        durationMs={row.durationMs}
        completedAtMs={row.completedAtMs}
        workingLabel={(time) => (time === null ? outcome : `${outcome} for ${time}`)}
        workedLabel={(time) => (longEnough ? `${outcome} for ${time}${done}` : `${outcome}${done}`)}
        stoppedLabel={(time) => (longEnough ? `${outcome} after ${time}${done}` : `${outcome}${done}`)}
      />
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
      {/*
        The turn header, its hairline rule and the fold are the kit's `ActivityTimeline`
        (plan §3 row 5). A turn that cannot fold keeps its label as `preToggleContent`: a
        label, not a control, which is what `showToggle={false}` means here.
      */}
      <ActivityTimeline
        className="work-block min-w-0"
        data-work-status={row.status}
        open={open}
        onOpenChange={() => props.toggle(row.id)}
        showToggle={row.canCollapse}
        summary={heading}
        preToggleContent={row.canCollapse ? undefined : heading}
        persistentContent={
          needsThinking ? (
            <div role="status" className="work-thinking">
              <LoadingShimmer>Thinking</LoadingShimmer>
            </div>
          ) : undefined
        }
      >
        <TraceList nodes={row.nodes} running={row.running} {...props} />
      </ActivityTimeline>
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
    <div className="work-activity flex min-w-0 flex-col">
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
            <AgentActivity
              key={id}
              data-trace-id={id}
              className="work-activity-row"
              disclosureMode="button"
              kind={activityKind(first.item)}
              status={
                group.some(traceFailed)
                  ? "failed"
                  : live
                    ? "running"
                    : group.every((n) => n.result !== undefined)
                      ? "completed"
                      : "pending"
              }
              indicator={<ActivityIcon item={first.item} />}
              summary={
                live ? (
                  <LoadingShimmer>{activeWorkLabel(group)}</LoadingShimmer>
                ) : (
                  label
                )
              }
              open={props.expanded.has(id)}
              onOpenChange={() => props.toggle(id)}
            >
              <div className="work-group-details max-h-56 overflow-y-auto py-1">
                <TraceBatch nodes={group} {...props} running={live} />
              </div>
            </AgentActivity>
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
      <div className="work-commentary py-2">
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
  // Landmine 1: an interrupt sets `is_error` too, and it is *not* a failure. `interrupted`
  // is the wire's own discriminator; a row that carries it reads as "You stopped".
  const interrupted = resultKind(node)?.interrupted === true;
  const failed = !interrupted && flattenTrace([node]).some(traceFailed);
  const label = conciseAction(item);
  const output = item.kind.type === "tool-result" ? item.body : result?.body;
  const request = item.kind.type === "tool-result" ? undefined : item.body;
  const live = current || (running && item.kind.type === "tool-call" && !result);
  const status: AgentItemStatus = failed
    ? "failed"
    : live
      ? "running"
      : output !== undefined || interrupted
        ? "completed"
        : "pending";
  const activeLabel =
    current && result
      ? "Thinking"
      : label
          .replace(/^Ran /, "Running ")
          .replace(/^Searched /, "Searching ")
          .replace(/^Read /, "Reading ")
          .replace(/^Edited /, "Editing ");
  const summary = live ? <LoadingShimmer>{activeLabel}</LoadingShimmer> : label;
  const actions = (
    <div className="work-row-actions flex flex-wrap items-center gap-2">
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
      {(output ?? request)?.trim() && <CopyButton text={(output ?? request)!} />}
    </div>
  );
  const nested = (updates.length > 0 || children.length > 0) && (
    <div className="work-nested ml-1 border-l border-hairline pl-4 py-2">
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
  );
  const kind = activityKind(item);
  const shared = {
    "data-trace-id": item.id,
    className: "work-activity-row",
    disclosureMode: "button" as const,
    detail: failed ? (
      <span className="work-row-failed text-error">Failed</span>
    ) : interrupted ? (
      <span className="work-row-stopped">You stopped</span>
    ) : node.edit ? (
      <FileChangeStats
        data-variant="agent-activity"
        additions={node.edit.added}
        change="modified"
        deletions={node.edit.removed}
      />
    ) : undefined,
    open,
    onOpenChange: () => toggle(item.id),
  };
  const body = (
    <>
      {request?.trim() && kind !== "command" && (
        <pre className="work-request max-h-80 overflow-auto whitespace-pre-wrap break-words">
          {request}
        </pre>
      )}
      {output !== undefined && kind !== "command" && (
        <CappedOutput text={output} />
      )}
      {actions}
      {nested}
    </>
  );
  return (
    <>
      {kind === "command" ? (
        <CommandExecution
          {...shared}
          command={commandText(item)}
          // The collapsed line is one string on purpose: `Ran <cmd>` as a single text node,
          // never a bare `<span>{cmd}</span>` the operator's eye (and a test's `getByText`)
          // would read as a second, separately addressable command row.
          summary={summary}
          status={
            live
              ? "running"
              : interrupted
                ? "interrupted"
                : failed
                  ? "failed"
                  : output !== undefined
                    ? "completed"
                    : "pending"
          }
          durationMs={node.durationMs}
          exitCode={exitCode(node)}
          terminalIcon={<Terminal aria-hidden className="size-3.5 shrink-0" />}
        >
          <CappedOutput text={output} />
          {actions}
          {nested}
        </CommandExecution>
      ) : kind === "search" ? (
        <SearchActivity
          {...shared}
          kind={traceLabel(item) === "Web research" ? "web" : "code"}
          query={searchQuery(item)}
          status={status}
        >
          {body}
        </SearchActivity>
      ) : (
        <AgentActivity
          {...shared}
          kind={kind}
          status={status}
          indicator={<ActivityIcon item={item} />}
          summary={summary}
        >
          {body}
        </AgentActivity>
      )}
      {actionRequests.get(item.id)}
    </>
  );
}

/**
 * Plan §3 row 7: command output is capped at 20 lines, with the rest behind one control.
 * The kit's `CommandOutput` draws the pane, its scroll fades and its copy action; the cap
 * is brigadier's, because the kit caps in `px` against a measured line box this app has no
 * equivalent of.
 */
const OUTPUT_LINE_CAP = 20;
function CappedOutput({ text }: { text: string | undefined }) {
  const [expanded, setExpanded] = useState(false);
  if (text === undefined) return <CommandOutput emptyLabel="No output" />;
  const lines = text.split("\n");
  const capped = lines.length > OUTPUT_LINE_CAP;
  return (
    <>
      <CommandOutput copyText={text}>
        {capped && !expanded
          ? `${lines.slice(0, OUTPUT_LINE_CAP).join("\n")}\n…`
          : text}
      </CommandOutput>
      {capped && (
        <Button
          variant="link"
          size="sm"
          className="work-output-more self-start"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </>
  );
}

/** This node's own `tool-result` kind, whichever half of the pair carries it. */
function resultKind(node: TraceNode) {
  const kind = node.result?.kind ?? node.item.kind;
  return kind.type === "tool-result" ? kind : undefined;
}

/** The exit code the wire carries on a `tool-result`, when it carries one. Never parsed here:
 *  Rust reads the literal `Exit code N` line and puts the number on the wire (`src/wire.ts`). */
function exitCode(node: TraceNode): number | undefined {
  const code = resultKind(node)?.exit_code;
  return typeof code === "number" ? code : undefined;
}

/** Which kit component draws this row (plan §3 rows 6–11). */
function activityKind(
  item: TraceNode["item"],
): "command" | "search" | "file-change" | "subagent" | "tool" | "generic" {
  if (isAgent(item)) return "subagent";
  const label = traceLabel(item);
  if (label === "Ran commands") return "command";
  if (label === "Searched files" || label === "Web research") return "search";
  if (label === "Edit files") return "file-change";
  if (label === "Read files") return "generic";
  return item.kind.type === "tool-call" ? "tool" : "generic";
}

function toolInput(item: TraceNode["item"]): Record<string, unknown> {
  try {
    return JSON.parse(item.body.slice(item.body.indexOf("{")));
  } catch {
    return {};
  }
}

function commandText(item: TraceNode["item"]): string {
  const input = toolInput(item);
  const command = input.command ?? input.cmd;
  if (typeof command === "string") return command;
  return item.body.trim().startsWith("{") ? "command" : item.body.trim() || "command";
}

function searchQuery(item: TraceNode["item"]): string | undefined {
  const input = toolInput(item);
  const query = input.pattern ?? input.query;
  return typeof query === "string" ? query : undefined;
}

function conciseAction(item: TraceNode["item"]) {
  const label = traceLabel(item);
  if (item.kind.type !== "tool-call") return label;
  const input = toolInput(item);
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
    return `Ran ${commandText(item).split("\n")[0]!.slice(0, 180)}`;
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
