import { MessageTimestamp, MessageTime } from "./MessageTimestamp";
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
import { useTaskExecutionSettings, type ExecutionChange } from "../taskSettings";
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
import type { CompactedNoticeDetail } from "../wire";
import { Spinner } from "./controls/status";
import { Disclosure } from "./controls/disclosure";
import {
  memo,
  useCallback,
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
import { reuseRows } from "./rowIdentity";
import { workbenchApi } from "../workbenchApi";
import * as store from "../feedStore";
import { projectThread, flattenTrace } from "../threadProjection";
import { PeerTaskCardScope } from "./peer/PeerTaskCardScope";
import { PeerIncomingMessage, PeerMessages } from "./peer/PeerMessages";
import { PeerAttachmentPreviews } from "./peer/PeerAttachmentPreviews";
import { peerMessageContent } from "../peerPresentation";
import { peerApi, type PeerAttachment, type PeerData } from "../peerApi";
import {AttachmentPreview} from "./composer/AttachmentPreview";
export const ThreadView = memo(function ThreadView({
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
});

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
  /** Bumped only when a prepared label replaced different text; remounts just this row's clock.
   *  Undefined in the measured case — no label ever moved — so no timestamp is disturbed. */
  labelPatch?: number;
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
  /** `CompactedNoticeDetail` on a `compacted` notice, `{error}` on a failure, absent otherwise. */
  detail?: unknown;
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
      {noticeSentence(data.code, data.text, data.detail)}
    </InlineNotice>
  );
};

function noticeHeading(code: string): string {
  if (code === "compacted") return "This response's context was compacted";
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
 *
 * **The compaction sentence names one response, never the conversation.** Every user message gets
 * a fresh child with no provider transcript
 * (`docs/research/does-a-session-accumulate-2026-09-11.md` §0), so a conversation here cannot
 * accumulate and cannot be summarised. The only reachable compaction is one response whose own
 * tool output filled the window mid-turn. Copy reading "Context automatically compacted"
 * described an event this product does not have, and a reader who believed it would self-censor
 * long threads for no reason.
 *
 * It stays **informational** — a boundary in the timeline, drawn as a rule with a centred label
 * by `InlineNotice`, not an alarm. Only the failure beside it is a warning.
 */
function noticeSentence(code: string, text: string, detail?: unknown): string {
  if (code === "compacted")
    return (
      (text === "auto"
        ? noticeHeading(code)
        : text === "manual"
          ? "This response's context was compacted on request"
          : noticeHeading(code)) + compactionNumbers(detail)
    );
  if (code === "exited") {
    if (text === "graceful") return "The provider exited";
    if (text === "killed") return "The provider was stopped";
    if (text === "crashed") return "The provider crashed";
    if (text.startsWith("error: ")) return `The provider exited: ${text.slice(7)}`;
    return text ? `The provider exited · ${text}` : noticeHeading(code);
  }
  return text || noticeHeading(code);
}

/**
 * The measured tail of a compaction label: ` · 12s · 70,633 → 1,379 tokens`.
 *
 * Only what the provider actually reported. `CompactedNoticeDetail` omits a key rather than
 * sending zero (`src/wire.ts`), so a missing number is dropped from the label instead of being
 * printed as `0`, and a boundary that reported nothing produces an empty tail and a bare
 * sentence. The real capture's values are the ones above
 * (`crates/claude-spike/fixtures/s11-auto-compaction.ndjson:49`, CLI 2.1.268).
 *
 * `cumulative_dropped_tokens` is deliberately not shown: it is every compaction in the provider
 * session added together, not this one's loss, so putting it next to a before/after pair would
 * read as a third figure about this event. Tokens and seconds, never a dollar figure
 * (`docs/vision.md` §6).
 */
function compactionNumbers(detail: unknown): string {
  if (typeof detail !== "object" || detail === null) return "";
  const d = detail as CompactedNoticeDetail;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const parts: string[] = [];
  const ms = num(d.duration_ms);
  if (ms !== null)
    parts.push(ms < 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);
  const pre = num(d.pre_tokens);
  const post = num(d.post_tokens);
  if (pre !== null && post !== null)
    parts.push(`${pre.toLocaleString()} → ${post.toLocaleString()} tokens`);
  else if (pre !== null) parts.push(`${pre.toLocaleString()} tokens before`);
  else if (post !== null) parts.push(`${post.toLocaleString()} tokens after`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
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

const EMPTY_ROWS: ThreadRow[] = [];
type BuiltMessage = {
  row: ThreadRow;
  turn: string | null;
  first: boolean;
  peers?: PeerData;
  message: ThreadMessage;
};
const EMPTY_MESSAGES: Map<string, BuiltMessage> = new Map();

/**
 * Every row is a real message with real parts (plan §5 phase 4 item 1). This used to be
 * `content: []` for anything that was not prose, with the row drawn by hand-written JSX beside the
 * runtime; the renderers above are reached through `MessagePrimitive.Parts` instead, which is also
 * what makes the read-only thread in `SubagentsPanel` work.
 *
 * Pure, and out of the component, so the caller can cache one message per row against exactly the
 * four inputs it reads.
 */
function rowMessage(
  row: ThreadRow,
  turn: string | null,
  first: boolean,
  peers: PeerData | undefined,
): ThreadMessage {
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
            data: {
              level: row.level,
              code: row.code,
              text: row.item.body,
              // The compaction's measured numbers live here, not in the body; the row prints
              // them beside its label (`noticeSentence`).
              detail: row.item.kind.type === "notice" ? row.item.kind.detail : undefined,
            },
          },
        ],
      };
    if (row.item.kind.type === "user-text") {
      // The displayed body is the peer delivery's text when this turn was steered in by
      // another session, and the item's own body otherwise — resolved here so the part
      // carries what is drawn rather than a string the renderer has to re-derive.
      const { text } = peerMessageContent(row.item, peers, first);
      return { id: row.id, role: "user", content: [{ type: "text", text }] };
    }
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
  // Normalised here, not by index off the runtime: the external store commits its message list one
  // render behind `rows`, and a `MessageByIndexProvider` reading a freshly-appended row throws
  // `index out of bounds` before that commit lands.
  return fromThreadMessageLike({ createdAt: EPOCH, ...like }, row.id, COMPLETE);
}

/**
 * One row, and the memo boundary the transcript needs.
 *
 * The row's scope used to be an object literal inside `Transcript`'s own JSX, so every row's parts
 * re-rendered whenever `Transcript` rendered at all — a fresh `requests` element, an approval
 * anywhere, a history poll that changed nothing. A `useMemo` on the context value alone would not
 * have fixed that: the row's element tree is recreated by `Transcript`'s render either way. The
 * boundary has to be a memoised component, and the scope is then memoised inside it because the
 * props that are **not** in the scope — the virtualiser's offset, `isLast`, the message — move on
 * their own.
 *
 * Every prop here must therefore be referentially stable across a render that changed nothing:
 * `row` and `message` are (`rowIdentity.ts` and the message cache), `approvals` falls back to one
 * shared empty value, `toggle` is a `useCallback`, and the rest are scalars or `Transcript`'s own
 * props.
 */
type TranscriptRowProps = {
  row: ThreadRow;
  index: number;
  isLast: boolean;
  message: ThreadMessage;
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
  labelPatch?: number;
  /** Provider markers that belong above this row; only a saved user message ever has one. */
  dividers?: ExecutionChange[];
  /** The startup card, on the first row only, and only while its prompt is still the one shown. */
  provisioning?: SessionStartup;
  /** Absolute offset in the virtualised list; `undefined` means the list is not virtualised. */
  offset?: number;
  measure?: (element: HTMLDivElement | null) => void;
};
const TranscriptRow = memo(function TranscriptRow({
  row, index, isLast, message, sessionId, projectId, readOnly, busy, editing, peers,
  onFile, onEdit, onSelectSession, expanded, toggle, approvals, files, labelPatch,
  dividers, provisioning, offset, measure,
}: TranscriptRowProps) {
  const scope = useMemo<RowScopeValue>(
    () => ({
      row, index, sessionId, projectId, readOnly, busy, editing, peers,
      onFile, onEdit, onSelectSession, expanded, toggle, approvals, files, labelPatch,
    }),
    [row, index, sessionId, projectId, readOnly, busy, editing, peers,
     onFile, onEdit, onSelectSession, expanded, toggle, approvals, files, labelPatch],
  );
  const user = row.type === "message" && row.item.kind.type === "user-text";
  return (
    <RowScope.Provider value={scope}>
      <div
        data-message-id={row.id}
        data-index={index}
        ref={measure}
        style={offset === undefined ? undefined : {position: 'absolute', width: '100%', top: 0, left: 0, transform: `translateY(${offset}px)`}}
        className={`aui-message group/message ${row.type === "work" ? "aui-activity" : row.type === "notice" ? "notice" : row.item.kind.type}`}
      >
        {dividers?.map(change => <ProviderChangeDivider key={change.id} change={change} />)}
        {user && row.type === "message" && row.item.at > 0 && (
          // The history page is published before its labels are prepared, so a label that
          // arrives late and differs from the fallback already on screen patches this one
          // row by remounting it. `labelPatch` is empty in the measured case, so the key
          // stays `undefined` and no timestamp is disturbed.
          <MessageTimestamp key={labelPatch} at={row.item.at}/>
        )}
        {/* One dispatch, in the runtime: the row's parts choose their own renderer. */}
        <MessageProvider message={message} index={index} isLast={isLast}>
          <MessagePrimitive.Parts
            components={threadParts}
            unstable_showEmptyOnNonTextEnd={false}
          />
        </MessageProvider>
        {provisioning && <SessionProvisioning startup={provisioning}/>}
      </div>
    </RowScope.Provider>
  );
});
if (profiling) TranscriptRow.displayName = "TranscriptRow";

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
  const {items, turns: turnRecords, loaded, error, hasOlder, paging, historical, labelPatch, older, latest} = useConversationHistory(sessionId, revision);
  const hydrated = loaded;
  const { settings: executionSettings } = useTaskExecutionSettings(sessionId);
  const executionChanges = executionSettings?.changes;
  const providerChanges = useMemo(
    () => providerChangePlacement(executionChanges ?? [], items, historical),
    [executionChanges, items, historical],
  );
  // Only these fields affect transcript pixels; history keeps its own live cursor subscription.
  const session = useSyncExternalStore(store.subscribe, useMemo(() => {
    let previous: {busy: boolean; lastStop: string | null | undefined; projectId: string | null | undefined} | undefined;
    return () => {
      const current = store.getState().sessions[sessionId];
      const busy = current?.busy ?? false;
      if (!previous || previous.busy !== busy || previous.lastStop !== current?.lastStop || previous.projectId !== current?.projectId)
        previous = {busy, lastStop: current?.lastStop, projectId: current?.projectId};
      return previous;
    };
  }, [sessionId]));
  const busy = session.busy;
  const pendingApprovalKey = useSyncExternalStore(store.subscribe, useCallback(() =>
    JSON.stringify((store.getState().approvals ?? []).filter(item => item.sessionId === sessionId).map(item => item.requestId)), [sessionId]));
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
  // `projectThread` returns all-new row objects every call, and a running turn re-projects every
  // 100 ms whether or not anything moved, so the identities are handed back to the rows that did
  // not change (`rowIdentity.ts`). Without this, nothing below — the row memo, the message list,
  // `PeerTaskCardScope` — can ever bail out during a live turn.
  // Written during render, and safe if React throws that render away: `reuseRows` never mutates
  // what it was given, and a discarded result is structurally equal to the one that replaces it.
  const projected = useRef<ThreadRow[]>(EMPTY_ROWS);
  const rows = useMemo(() => {
    const next = reuseRows(
      projected.current,
      projectThread(items, busy, turnRecords, session?.lastStop),
    );
    projected.current = next;
    return next;
  }, [items, busy, turnRecords, session?.lastStop]);
  const approvalElement = isValidElement<ApprovalsProps>(requests) && Array.isArray(requests.props.approvals) ? requests : null;
  const approvalHistory = useApprovalHistory(sessionId, pendingApprovalKey);
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
  // A row with neither a pending decision nor a resolved one keeps the shared empty value rather
  // than a fresh object per render: that object is a row memo input, and every work row in a
  // transcript without approvals has the same one.
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
    if (pending || actions.size) rowApprovals.set(row.id, { pending, actions });
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
  // One normalised message per row, each kept only as long as its own inputs hold. Rebuilding the
  // list is not enough to rebuild a message: the object is a row memo input, and a re-projection
  // that changed one row must not hand 39 other rows a new one.
  // Written during render like `projected` above, and safe for the same reason: a cache entry a
  // discarded render built is replaced by an equal one, and nothing here reads a stale entry —
  // every hit is gated on the identities it was built from.
  const built = useRef<Map<string, BuiltMessage>>(EMPTY_MESSAGES);
  const messages = useMemo<ThreadMessage[]>(() => {
    const next = new Map<string, BuiltMessage>();
    const list = rows.map((row, index): ThreadMessage => {
      const turn = turns[index] ?? null;
      const first = index === 0;
      const cached = built.current.get(row.id);
      if (cached && cached.row === row && cached.turn === turn && cached.first === first && cached.peers === peers) {
        next.set(row.id, cached);
        return cached.message;
      }
      const message = rowMessage(row, turn, first, peers);
      next.set(row.id, { row, turn, first, peers, message });
      return message;
    });
    built.current = next;
    return list;
  }, [rows, turns, peers]);
  useLayoutEffect(() => {
    if (hydrated && !restored.current && scroll.current) {
      restored.current = true;
      if (!saved.current.following)
        scroll.current.scrollTop = saved.current.top;
    }
  }, [hydrated]);
  // Stable: it is a row memo input, and a fresh closure per render would re-render every row.
  const toggle = useCallback(
    (id: string) =>
      setExpanded((old) => {
        const next = new Set(old);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
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
            <TranscriptRow
              key={row.id}
              row={row}
              index={index}
              isLast={index === rows.length - 1}
              message={messages[index]!}
              sessionId={sessionId}
              projectId={projectId ?? session?.projectId ?? null}
              readOnly={readOnly}
              busy={busy}
              editing={editing}
              peers={peers}
              onFile={onFile}
              onEdit={onEdit}
              onSelectSession={onSelectSession}
              expanded={expanded}
              toggle={toggle}
              approvals={rowApprovals.get(row.id) ?? noRowApprovals}
              files={changes.turns.find((t) => t.turnId === turns[index])?.files ?? noFiles}
              labelPatch={row.type === "message" ? labelPatch.get(row.item.seq) : undefined}
              dividers={user && row.type === "message" ? providerChanges.before.get(row.item.id) : undefined}
              provisioning={user && index === 0 && row.type === "message" && startup && row.item.body === startup.args.prompt ? startup : undefined}
              offset={position ? position.start : undefined}
              measure={position ? virtual.measureElement : undefined}
            />
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
  const openReference = useCallback((path: string) => {
    if (path.startsWith('brigadier-session:')) { onSelectSession?.(path.slice('brigadier-session:'.length)); return; }
    if (!path.startsWith('brigadier-attachment:')) { onFile(path); return; }
    if (!projectId) {setSourceError('Attachment project is unavailable.');return;}
    void peerApi.attachment(projectId, path.slice('brigadier-attachment:'.length)).then(file=>setAttachment(file.metadata), error=>setSourceError(String(error)));
  }, [onFile, onSelectSession, projectId]);
  const { source } = peerMessageContent(item, peers, index === 0);
  if (source) return <PeerIncomingMessage item={item} peers={peers} onSelectSession={onSelectSession} />;
  const long = text.length > 480 || text.split("\n").length > 8;
  return (
    <AgentMessage
      role="user"
      attachments={attachment ? <AttachmentPreview attachment={attachment}/> : undefined}
      actions={
        <>
          {item.at > 0 && <MessageTime key={scope.labelPatch} at={item.at}/>}
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
