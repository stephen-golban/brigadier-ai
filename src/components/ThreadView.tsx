import type { SessionStartup } from "../sessionStartup";
import { ProvisioningConversation, SessionProvisioning } from "./SessionProvisioning";
import { profiling } from "../perfDiagnostics";
import { TranscriptRuntime } from "./TranscriptRuntime";
import { TaskPolicyStatus } from "./TaskPolicyStatus";
import { TaskProgress } from "./TaskProgress";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useConversationHistory } from "../hooks/useConversationHistory";
import { isValidElement, cloneElement, createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { ApprovalResolution, type ApprovalsProps } from "./Approvals";
import { useApprovalHistory } from "./approvalHistory";
import { useTaskExecutionSettings } from "../taskSettings";
import { ProviderChangeDivider } from "./composer/ProviderChangeDivider";
import { providerChangePlacement } from "./composer/providerChangePlacement";
import {
  MessagePrimitive,
  MessageProvider,
  fromThreadMessageLike,
  type DataMessagePartComponent,
  type TextMessagePartComponent,
  type ThreadMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { AgentMessage } from "./thread/AgentMessage";
import { InlineNotice, StatusBanner } from "./thread/Notices";
import { Spinner } from "./controls/status";
import { Disclosure } from "./controls/disclosure";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Bug, Loop, Pencil, Telescope, Tools } from "../icons";
import { Button } from "@/components/ui/button";
import { iconButton, labelledButtonIcons } from "@/lib/surfaces";
import { cn } from "@/lib/utils";
import { MessageAction } from "./assistant-ui/elements/tooltip-icon-button";
import { Thread } from "./assistant-ui/elements/thread";
import { ThinkingIndicator } from "./assistant-ui/elements/thinking-indicator";
import "./assistant-ui/elements/elements.css";
import { Markdown, CopyButton } from "./Markdown";
import { BrandMark } from "./BrandMark";
import { WelcomeScreen } from "./WelcomeScreen";
import { WorkTrace } from "./WorkTrace";
import { ChangedFilesCard } from "./SessionReview";
import type { FileChange } from "../desktopApi";
import { useSessionChanges } from "../desktopApi";
import {
  type ChatItem,
} from "../workspaceApi";
import type { ThreadRow } from "../threadProjection";
import { workbenchApi } from "../workbenchApi";
import * as store from "../feedStore";
import { projectThread, flattenTrace } from "../threadProjection";
import { PeerTaskCardScope } from "./peer/PeerTaskCardScope";
import { PeerIncomingMessage, PeerMessages } from "./peer/PeerMessages";
import { PeerAttachmentPreviews } from "./peer/PeerAttachmentPreviews";
import { peerMessageContent } from "../peerPresentation";
import { peerApi, type PeerAttachment, type PeerData } from "../peerApi";
import {AttachmentPreview} from "./composer/AttachmentPreview";
export function ThreadView({
  startup, onRetryStartup,
  requests,
  sessionId,
  projectName,
  projectId,
  onFile,
  onEdit,
  editing = false,
  revision = 0,
  peers,
  onSelectSession,
}: {
  startup?: SessionStartup;
  onRetryStartup?: () => void;
  requests?: ReactNode;
  sessionId: string | null;
  projectId: string | null;
  projectName: string | null;
  onFile: (path: string) => void;
  onEdit?: (item: ChatItem) => void;
  editing?: boolean;
  revision?: number;
  peers?: PeerData;
  onSelectSession?: (id: string) => void;
}) {
  return (
    <section className="conversation flex min-h-0 min-w-0 flex-1 flex-col">
      {sessionId ? (
        <Transcript
          startup={startup}
          requests={requests}
          key={sessionId}
          sessionId={sessionId}
          projectId={projectId}
          onFile={onFile}
          revision={revision}
          onEdit={onEdit}
          editing={editing}
          peers={peers}
          onSelectSession={onSelectSession}
        />
      ) : projectId === null ? (
        <WelcomeScreen />
      ) : (
        startup ? <ProvisioningConversation startup={startup} onRetry={onRetryStartup}/> : <NewConversation projectName={projectName} projectId={projectId} />
      )}
    </section>
  );
}

// The greeting is only ever read by this branch. Holding its state — and its `workbench_load`
// round trip and `workbench-data-changed` listener — in `ThreadView` re-rendered the whole
// mounted transcript for a string no open session displays.
function NewConversation({
  projectName,
  projectId,
}: {
  projectName: string | null;
  projectId: string | null;
}) {
  const [greetingName, setGreetingName] = useState("");
  useEffect(() => {
    let live = true;
    const read = () => {
      void workbenchApi
        .load()
        .then((d) => {
          if (live) setGreetingName(d.displayName?.trim() ?? "");
        })
        .catch(() => {});
    };
    read();
    window.addEventListener("workbench-data-changed", read);
    return () => {
      live = false;
      window.removeEventListener("workbench-data-changed", read);
    };
  }, []);
  return (
    <div className="new-conversation flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-text-secondary">
      <BrandMark className="brand-mark size-[120px] shrink-0 fill-current" />
      <h1>
        {projectName
          ? `What should we build in ${projectName}?`
          : greetingName
            ? `What will you build, ${greetingName}?`
            : "What should we build?"}
      </h1>
      {projectId && (
        <div className="welcome-starters">
          {[
            {
              title: "Explore and understand code",
              prompt:
                "Explore this project and explain its architecture and main flows.",
              Icon: Telescope,
              color: "var(--color-starter-explore)",
            },
            {
              title: "Build a new feature, app, or tool",
              prompt: "Help me build a new feature: ",
              Icon: Tools,
              color: "var(--color-starter-build)",
            },
            {
              title: "Review code and suggest changes",
              prompt:
                "Review the current changes and suggest improvements. Focus on bugs and regressions.",
              Icon: Loop,
              color: "var(--color-starter-review)",
            },
            {
              title: "Fix issues and failures",
              prompt: "Help me investigate and fix this issue: ",
              Icon: Bug,
              color: "var(--color-starter-fix)",
            },
          ].map(({ title, prompt, Icon, color }) => (
            <Button
              key={title}
              variant="ghost"
              size="sm"
              className={cn(labelledButtonIcons, "welcome-starter")}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("workbench-starter", {
                    detail: { projectId, prompt },
                  }),
                )
              }
            >
              <Icon width={18} height={18} style={{ color }} />
              <span>{title}</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

// Neither panel reads a transcript row, so neither has to re-render when one arrives.
const SessionProgress = memo(TaskProgress);
const SessionPolicyStatus = memo(TaskPolicyStatus);
const noActions: ReadonlyMap<string, ReactNode> = new Map();


/**
 * Everything a part renderer needs that is not in the part itself: the projected row it came
 * from, and the session-scoped callbacks. A part component is reached through the runtime, so
 * it cannot be handed props — this is the seam that replaces the old prop drilling.
 */
type RowApprovals = { pending: boolean; actions: ReadonlyMap<string, ReactNode> };
const noRowApprovals: RowApprovals = { pending: false, actions: noActions };
const noFiles: FileChange[] = [];
/** Saved bodies carry their own `at`; the runtime's clock must not enter the render. */
const EPOCH = new Date(0);
const COMPLETE = { type: "complete", reason: "stop" } as const;
type RowScopeValue = {
  row: ThreadRow;
  index: number;
  sessionId: string;
  projectId: string | null;
  readOnly: boolean;
  busy: boolean;
  editing: boolean;
  peers?: PeerData;
  onFile: (path: string) => void;
  onEdit?: (item: ChatItem) => void;
  onSelectSession?: (id: string) => void;
  expanded: Set<string>;
  toggle: (id: string) => void;
  approvals: RowApprovals;
  files: FileChange[];
};
const RowScope = createContext<RowScopeValue | null>(null);
function useRowScope(): RowScopeValue {
  const scope = useContext(RowScope);
  if (!scope) throw new Error("A thread part rendered outside its row scope.");
  return scope;
}

/** Row 1 / row 2: prose. Which bubble it is follows the row, not the part. */
const ThreadText: TextMessagePartComponent = ({ text, status }) => {
  const scope = useRowScope();
  const { row } = scope;
  if (row.type === "message" && row.item.kind.type === "user-text")
    return <UserMessage text={text} item={row.item} scope={scope} />;
  return (
    <AgentMessage
      role="assistant"
      status={status.type === "running" ? "running" : "completed"}
      actions={<CopyButton text={text} />}
    >
      <Markdown text={text} onFile={scope.onFile} />
    </AgentMessage>
  );
};

/** Row 5–11: the whole work row, header and trace. */
const WorkPart: DataMessagePartComponent = () => {
  const scope = useRowScope();
  if (scope.row.type !== "work") return null;
  return (
    <WorkTrace
      row={scope.row}
      hasPendingApproval={scope.approvals.pending}
      actionRequests={scope.approvals.actions}
      sessionTitles={scope.peers?.titles}
      onSelectSession={scope.onSelectSession}
      expanded={scope.expanded}
      toggle={scope.toggle}
      onFile={scope.onFile}
    />
  );
};

/** Row 13 / row 14: a lifecycle notice in `seq` order. Never a banner unless it is fatal. */
const NoticePart: DataMessagePartComponent<{
  level: string;
  code: string;
  text: string;
}> = ({ data, status }) => {
  const tone =
    data.level === "fatal" || data.level === "error"
      ? "error"
      : data.level === "warning"
        ? "warning"
        : "neutral";
  if (tone === "error")
    return (
      <StatusBanner tone="error" heading={noticeHeading(data.code)}>
        {data.text}
      </StatusBanner>
    );
  return (
    <InlineNotice tone={tone} shimmering={status.type === "running"}>
      {noticeSentence(data.code, data.text)}
    </InlineNotice>
  );
};

function noticeHeading(code: string): string {
  if (code === "compacted") return "Context compacted";
  if (code === "exited") return "The provider exited";
  if (code === "runtime") return "Runtime error";
  return code;
}

/**
 * What a person reads, not what the enum is called.
 *
 * `crates/store/src/chat.rs` puts a **discriminator** in the body of the two lifecycle notices
 * that have one — a compaction carries its trigger (`auto` / `manual`) and an exit carries its
 * reason (`graceful` / `killed` / `crashed` / `error: …`) — because the body is the only field
 * those events have to carry it in. Printing it verbatim put the word `auto` in the transcript
 * where a sentence belongs. A `runtime` notice's body is already a real message and is used as
 * written; anything unrecognised falls back to the body, then to the code, rather than being
 * dropped.
 */
function noticeSentence(code: string, text: string): string {
  if (code === "compacted")
    return text === "auto"
      ? "Context automatically compacted"
      : text === "manual"
        ? "Context compacted"
        : noticeHeading(code);
  if (code === "exited") {
    if (text === "graceful") return "The provider exited";
    if (text === "killed") return "The provider was stopped";
    if (text === "crashed") return "The provider crashed";
    if (text.startsWith("error: ")) return `The provider exited: ${text.slice(7)}`;
    return text ? `The provider exited · ${text}` : noticeHeading(code);
  }
  return text || noticeHeading(code);
}

/** Row 8: the per-turn changed-files card, attached under the final answer. */
const ChangedFilesPart: DataMessagePartComponent<{ turn: string }> = ({ data }) => {
  const scope = useRowScope();
  return (
    <ChangedFilesCard
      sessionId={scope.sessionId}
      turn={data.turn}
      files={scope.files}
    />
  );
};

const threadParts: ComponentProps<typeof MessagePrimitive.Parts>["components"] = {
  Text: ThreadText,
  Empty: () => null,
  data: {
    by_name: {
      work: WorkPart,
      notice: NoticePart,
      "changed-files": ChangedFilesPart,
    },
  },
};

function Transcript({
  startup,
  requests,
  sessionId,
  projectId,
  onFile,
  peers,
  onSelectSession,
  revision,
  onEdit,
  editing,
}: {
  startup?: SessionStartup;
  requests?: ReactNode;
  sessionId: string;
  projectId: string | null;
  onFile: (path: string) => void;
  peers?: PeerData;
  onSelectSession?: (id: string) => void;
  revision: number;
  onEdit?: (item: ChatItem) => void;
  editing: boolean;
}) {
  const changes = useSessionChanges(sessionId);
  const readOnly = peers?.loaded === false || !!peers?.subagents?.[sessionId];
  const {items, turns: turnRecords, loaded, error, hasOlder, paging, historical, older, latest} = useConversationHistory(sessionId, revision);
  const hydrated = loaded;
  const { settings: executionSettings } = useTaskExecutionSettings(sessionId);
  const executionChanges = executionSettings?.changes;
  const providerChanges = useMemo(
    () => providerChangePlacement(executionChanges ?? [], items, historical),
    [executionChanges, items, historical],
  );
  const state = useSyncExternalStore(store.subscribe, store.getState),
    session = state.sessions[sessionId],
    busy = session?.busy ?? false;
  const scroll = useRef<HTMLDivElement>(null),
    restored = useRef(false);
  const [initialScroll] = useState<{ top: number; following: boolean }>(
    () => {
      try {
        return (
          JSON.parse(
            localStorage.getItem(`brigadier:scroll:${sessionId}`) ?? "null",
          ) ?? { top: 0, following: true }
        );
      } catch {
        return { top: 0, following: true };
      }
    },
  );
  const saved = useRef(initialScroll);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(
        JSON.parse(
          localStorage.getItem(`brigadier:expanded:${sessionId}`) ?? "[]",
        ),
      );
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        `brigadier:expanded:${sessionId}`,
        JSON.stringify([...expanded]),
      );
    } catch {
      /* Keep in-memory state. */
    }
  }, [expanded, sessionId]);
  const rows = useMemo(
    () => projectThread(items, busy, turnRecords, session?.lastStop),
    [items, busy, turnRecords, session?.lastStop],
  );
  const approvalElement = isValidElement<ApprovalsProps>(requests) && Array.isArray(requests.props.approvals) ? requests : null;
  const approvalHistory = useApprovalHistory(sessionId, (state.approvals ?? []).filter(item => item.sessionId === sessionId).map(item => item.requestId).join(":"));
  const confirmedApprovals = approvalHistory.filter(item => {
    if (!item.resolved) return false;
    const first = items[0], last = items[items.length - 1];
    if (first && first.seq > 1 && item.opened_at_ms < first.at) return false;
    return !historical || !last || item.opened_at_ms <= last.at;
  });
  const confirmedRequestIds = new Set(confirmedApprovals.map(item => item.request_id));
  const resolvedRequests = new Set<string>();
  const matchedRequests = new Set<string>();
  // One `flattenTrace` pass per work row, keeping each row's cards with the row. The row list
  // below used to re-flatten the same trace twice more per row on every render to rebuild this.
  const rowApprovals = new Map<string, { pending: boolean; actions: ReadonlyMap<string, ReactNode> }>();
  for (const row of rows) {
    if (row.type !== "work") continue;
    let pending = false;
    const actions = new Map<string, ReactNode>();
    for (const node of flattenTrace(row.nodes)) {
      const matched = (approvalElement?.props.approvals ?? []).filter(({ approval }) => !confirmedRequestIds.has(approval.requestId) && approval.kind?.type === "tool-permission" && approval.kind.tool_call_id === node.item.id);
      const resolved = confirmedApprovals.filter(item => item.kind?.type === "tool-permission" && item.kind.tool_call_id === node.item.id);
      const cards: ReactNode[] = resolved.map(item => <ApprovalResolution key={item.request_id} approval={item} />);
      resolved.forEach(item => resolvedRequests.add(item.request_id));
      if (matched.length && approvalElement) {
        pending = true;
        cards.push(cloneElement(approvalElement, { key: `pending:${node.item.id}`, approvals: matched }));
        matched.forEach(({ approval }) => matchedRequests.add(approval.requestId));
      }
      if (cards.length) actions.set(node.item.id, cards);
    }
    rowApprovals.set(row.id, { pending, actions });
  }
  const hasApprovals = (approvalElement?.props.approvals.length ?? 0) > 0;
  // Pending decisions must remain mounted and directly reachable even in long transcripts.
  const virtualized = rows.length > 60 && !hasApprovals;
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current,
    estimateSize: () => 140, overscan: 6, getItemKey: index => rows[index]!.id,
    enabled: virtualized, initialRect: {width: 800, height: 800} });
  const visibleRows = virtualized ? virtual.getVirtualItems().map(item => ({row: rows[item.index]!, index: item.index, virtual: item})) : rows.map((row,index)=>({row,index,virtual: null}));
  const turns = useMemo(() => {
    let turn: string | null = null;
    return rows.map((row) => {
      if (row.type === "message" && row.item.kind.type === "user-text")
        turn = row.item.provider_uuid ?? row.item.id;
      return turn;
    });
  }, [rows]);
  // Every row is a real message with real parts (plan §5 phase 4 item 1). This used to be
  // `content: []` for anything that was not prose, with the row drawn by hand-written JSX
  // beside the runtime; the renderers below are reached through `MessagePrimitive.Parts`
  // instead, which is also what makes the read-only thread in `SubagentsPanel` work.
  const messages = useMemo<ThreadMessage[]>(
    () =>
      rows.map((row, index): ThreadMessage => {
        const like = ((): ThreadMessageLike => {
        if (row.type === "work")
          return {
            id: row.id,
            role: "assistant",
            content: [{ type: "data-work", data: { rowId: row.id } }],
          };
        if (row.type === "notice")
          return {
            id: row.id,
            role: "assistant",
            content: [
              {
                type: "data-notice",
                data: { level: row.level, code: row.code, text: row.item.body },
              },
            ],
          };
        if (row.item.kind.type === "user-text") {
          // The displayed body is the peer delivery's text when this turn was steered in by
          // another session, and the item's own body otherwise — resolved here so the part
          // carries what is drawn rather than a string the renderer has to re-derive.
          const { text } = peerMessageContent(row.item, peers, index === 0);
          return { id: row.id, role: "user", content: [{ type: "text", text }] };
        }
        const turn = turns[index];
        return {
          id: row.id,
          role: "assistant",
          status: row.streaming
            ? ({ type: "running" } as const)
            : ({ type: "complete", reason: "stop" } as const),
          content: [
            { type: "text" as const, text: row.item.body },
            ...(row.final && turn
              ? [{ type: "data-changed-files" as const, data: { turn } }]
              : []),
          ],
        };
        })();
        // Normalised here, not by index off the runtime: the external store commits its
        // message list one render behind `rows`, and a `MessageByIndexProvider` reading a
        // freshly-appended row throws `index out of bounds` before that commit lands.
        return fromThreadMessageLike(
          { createdAt: EPOCH, ...like },
          row.id,
          COMPLETE,
        );
      }),
    [rows, turns, peers],
  );
  useLayoutEffect(() => {
    if (hydrated && !restored.current && scroll.current) {
      restored.current = true;
      if (!saved.current.following)
        scroll.current.scrollTop = saved.current.top;
    }
  }, [hydrated]);
  const toggle = (id: string) =>
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <TranscriptRuntime sessionId={sessionId} messages={messages} busy={busy} loaded={loaded} readOnly={readOnly}>
      <PeerTaskCardScope rows={rows} sessionTitles={peers?.titles} sessionId={sessionId} peers={peers}>
      <Thread
        readOnly={readOnly}
        viewportRef={scroll}
        scrollToBottomOnInitialize={saved.current.following}
        onScroll={() => {
          const el = scroll.current;
          if (!el || !restored.current) return;
          try {
            localStorage.setItem(
              `brigadier:scroll:${sessionId}`,
              JSON.stringify({
                top: el.scrollTop,
                following:
                  el.scrollHeight - el.scrollTop - el.clientHeight < 64,
              }),
            );
          } catch {
            /* Scroll still works without storage. */
          }
        }}
      >
        <SessionProgress sessionId={sessionId} />
        <SessionPolicyStatus sessionId={sessionId} projectId={projectId} peers={peers} />
        {error && (
          <p role="alert" className="inline-error my-2 text-[13px] text-error">
            {error}
          </p>
        )}
        {startup && !loaded ? <ProvisioningConversation startup={startup}/> : !loaded ? (
          <div className="thread-empty mx-auto flex max-w-lg flex-col gap-3 p-6 text-text-disabled">
            <Spinner size="sm" /> Loading conversation…
          </div>
        ) : !rows.length ? (
          <p className="thread-empty mx-auto flex max-w-lg flex-col gap-3 p-6 text-text-disabled">
            {busy
              ? "Waiting for the first response…"
              : "No saved message bodies in this session."}
          </p>
        ) : null}
        {hasOlder && <Button variant="ghost" size="sm" className="mx-auto mb-4" disabled={paging} onClick={() => void older()}>{paging ? 'Loading…' : 'Load earlier messages'}</Button>}
        {historical && <Button variant="ghost" size="sm" className="mx-auto mb-4" onClick={() => void latest()}>Return to latest messages</Button>}
        <div style={virtualized ? {height: virtual.getTotalSize(), position: 'relative'} : undefined}>
        {visibleRows.map(({row, index, virtual: position}) => {
          const user = row.type === "message" && row.item.kind.type === "user-text";
          return (
            <RowScope.Provider
              key={row.id}
              value={{
                row,
                index,
                sessionId,
                projectId: projectId ?? session?.projectId ?? null,
                readOnly,
                busy,
                editing,
                peers,
                onFile,
                onEdit,
                onSelectSession,
                expanded,
                toggle,
                approvals: rowApprovals.get(row.id) ?? noRowApprovals,
                files:
                  changes.turns.find((t) => t.turnId === turns[index])?.files ?? noFiles,
              }}
            >
            <div
              data-message-id={row.id}
              data-index={index}
              ref={position ? virtual.measureElement : undefined}
              style={position ? {position: 'absolute', width: '100%', top: 0, left: 0, transform: `translateY(${position.start}px)`} : undefined}
              className={`aui-message group/message ${row.type === "work" ? "aui-activity" : row.type === "notice" ? "notice" : row.item.kind.type}`}
            >
              {user && providerChanges.before.get(row.item.id)?.map(change => <ProviderChangeDivider key={change.id} change={change} />)}
              {user && row.item.at > 0 && (
                <div className="message-separator mb-2 text-xs text-text-tertiary">
                  {dateLabel(row.item.at)}
                </div>
              )}
              {/* One dispatch, in the runtime: the row's parts choose their own renderer. */}
              <MessageProvider
                message={messages[index]!}
                index={index}
                isLast={index === rows.length - 1}
              >
                <MessagePrimitive.Parts
                  components={threadParts}
                  unstable_showEmptyOnNonTextEnd={false}
                />
              </MessageProvider>
              {user && index === 0 && startup && row.item.body === startup.args.prompt && <SessionProvisioning startup={startup}/>}
            </div>
            </RowScope.Provider>
          );
        })}
        </div>
        {providerChanges.after.map(change => <ProviderChangeDivider key={change.id} change={change} />)}
        <PeerMessages sessionId={sessionId} peers={peers} onSelectSession={onSelectSession}
          renderAttachments={message => <PeerAttachmentPreviews message={message} />} />
        {peers?.requests
          .filter((r) => r.to === sessionId && r.resolved)
          .map((r) => (
            <Disclosure key={r.id}>
              <Disclosure.Heading>
                <Disclosure.Trigger>
                  Resolved {r.action} request from{" "}
                  {peers.titles[r.from] ?? "another session"}
                  <Disclosure.Indicator />
                </Disclosure.Trigger>
              </Disclosure.Heading>
              <Disclosure.Content>
                <Disclosure.Body>This request was handled.</Disclosure.Body>
              </Disclosure.Content>
            </Disclosure>
          ))}
        {busy && !rows.some((r) => r.type === "work" && r.running) && (
          <ThinkingIndicator label="Working…" role="status" className="py-2" />
        )}
        {!busy && session?.lastStop && session.lastStop !== "end-turn" && (
          <div className="turn-state">{stopLabel(session.lastStop)}</div>
        )}
        {confirmedApprovals.filter(item => !resolvedRequests.has(item.request_id)).map(item => <ApprovalResolution key={item.request_id} approval={item} />)}
        {approvalElement ? cloneElement(approvalElement, { approvals: approvalElement.props.approvals.filter(({ approval }) => !matchedRequests.has(approval.requestId) && !confirmedRequestIds.has(approval.requestId)) }) : requests}
      </Thread>
      </PeerTaskCardScope>
    </TranscriptRuntime>
  );
}

function stopLabel(reason: string) {
  if (reason === "end-turn") return "Completed";
  if (reason === "max-tokens") return "Response limit reached";
  if (reason === "max-turns") return "Turn limit reached";
  if (reason === "refusal") return "The agent could not fulfill this request";
  try {
    const value = JSON.parse(reason) as { error?: string; other?: string };
    // `error` is a provider message and reads as prose. `other` is a raw provider token the
    // wire could not map (`crates/core/src/claude/adapter.rs` rides it verbatim) — it is shown,
    // because dropping it would hide why a turn ended, but it is framed rather than passed off
    // as a sentence.
    if (typeof value.error === "string") return value.error;
    if (typeof value.other === "string")
      return `Stopped · ${value.other.replace(/[_-]/g, " ")}`;
    return reason;
  } catch {
    return reason;
  }
}

function dateLabel(at: number) {
  const date = new Date(at);
  return `${date.toDateString() === new Date().toDateString() ? "Today" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}
/**
 * Row 1. The bubble is the kit's `AgentMessage` at the measured tokens (70% of the column,
 * 22px radius, 10x16 padding — `docs/research/codex-thread-tokens.md` §3.1); the clamp, the
 * attachment preview and the edit affordance are brigadier's and are unchanged.
 */
function UserMessage({
  text,
  item,
  scope,
}: {
  text: string;
  item: ChatItem;
  scope: RowScopeValue;
}) {
  const { readOnly, projectId, onFile, peers, busy, editing, onEdit, onSelectSession, index } = scope;
  const [expanded, setExpanded] = useState(false);
  const [attachment, setAttachment] = useState<PeerAttachment | null>(null);
  const [sourceError, setSourceError] = useState('');
  const openReference = (path: string) => {
    if (path.startsWith('brigadier-session:')) { onSelectSession?.(path.slice('brigadier-session:'.length)); return; }
    if (!path.startsWith('brigadier-attachment:')) { onFile(path); return; }
    if (!projectId) {setSourceError('Attachment project is unavailable.');return;}
    void peerApi.attachment(projectId, path.slice('brigadier-attachment:'.length)).then(file=>setAttachment(file.metadata), error=>setSourceError(String(error)));
  };
  const { source } = peerMessageContent(item, peers, index === 0);
  if (source) return <PeerIncomingMessage item={item} peers={peers} onSelectSession={onSelectSession} />;
  const long = text.length > 480 || text.split("\n").length > 8;
  return (
    <AgentMessage
      role="user"
      attachments={attachment ? <AttachmentPreview attachment={attachment}/> : undefined}
      actions={
        <>
          {item.at > 0 && (
            <time dateTime={new Date(item.at).toISOString()}>
              {new Date(item.at).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
          )}
          <CopyButton text={text} />
          {!readOnly && (
            <MessageAction
              tooltip={busy ? "Wait for the current turn to finish" : "Edit message"}
            >
              <Button
                variant="ghost"
                size="icon"
                className={cn(iconButton, "size-7")}
                aria-label="Edit message"
                title={busy ? "Wait for the current turn to finish" : "Edit message"}
                disabled={busy || editing || !onEdit}
                onClick={() => onEdit?.(item)}
              >
                <Pencil width={15} height={15} />
              </Button>
            </MessageAction>
          )}
        </>
      }
    >
      <div className={long && !expanded ? "line-clamp-5" : ""}>
        <Markdown text={text} onFile={openReference} />
      </div>
      {sourceError && <p role="alert">{sourceError}</p>}
      {long && (
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0 pt-2 text-text-secondary"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show more"}
          <span aria-hidden="true">⌄</span>
        </Button>
      )}
    </AgentMessage>
  );
}

if (profiling) ThreadView.displayName = "ThreadView";

if (profiling) Transcript.displayName = "Transcript";
