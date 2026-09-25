import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ExternalStoreBranchChange,
  ExportedMessageRepository,
  type ExternalThreadQueueAdapter,
  type FeedbackAdapter,
  type QueueItemState,
  type ThreadMessage,
  type ThreadMessageLike,
  useAuiState,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { Unarchive, X } from "@openai/apps-sdk-ui/components/Icon";
import {
  createContext,
  type FC,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { AgentsPanel, AgentsPanelContext, type AgentsPanelState } from "@/app/conversation/Agents";
import { PinnedSummary } from "@/app/conversation/PinnedSummary";
import { BlobAttachmentAdapter } from "@/app/conversation/attachments";
import {
  type Block,
  type BoardDigest,
  buildThread,
  type ThreadNode,
} from "@/app/conversation/blocks";
import {
  type ComposerTarget,
  ComposerTargetContext,
  ConversationComposer,
} from "@/app/conversation/Composer";
import { useResolvedDraft } from "@/app/conversation/draftSetup";
import { QueuePanel } from "@/app/conversation/QueuePanel";
import { type BlockMeta, RequestBlock } from "@/app/conversation/RequestBlock";
import { useAction } from "@/app/conversation/useAction";
import {
  mentionedTasks,
  type MentionTarget,
} from "@/components/assistant-ui/elements/composer-mentions";
import { MessageAttachments } from "@/components/assistant-ui/elements/message-attachment";
import { Thread, type ThreadComponents } from "@/components/assistant-ui/thread";
import { Button } from "@/components/ui/button";
import type {
  AttachmentRef,
  Conversation,
  ModelChoice,
  Notice,
  Rating,
  UserRequest,
} from "@/ipc/generated";
import { cn } from "@/lib/utils";
import {
  editMessage,
  interrupt,
  loadEarlier,
  loadFullText,
  rateMessage,
  regenerate,
  restore,
  resume,
  send,
  switchBranch,
} from "@/state/actions";
import { type Board, useBoard } from "@/state/board";
import {
  emptyThread,
  type PendingMessage,
  type Selection,
  useApp,
} from "@/state/store";

type Item = { id: string; parentId: string | null } & (
  | { kind: "user"; block: Block; rework: boolean }
  | { kind: "block"; block: Block; meta: BlockMeta; texts: string[]; rating: Rating | null }
);

/** Extra message data the footers read back from assistant-ui's message state. */
type Custom = {
  attachments?: AttachmentRef[];
  block?: BlockMeta;
  /** The message can be edited now (see `canRework`). */
  rework?: boolean;
};

/** An attachment-only message has no text part, so no empty bubble shows above its files. */
function textContent(text: string): ThreadMessageLike["content"] {
  return text ? [{ type: "text", text }] : [];
}

function blockStatus(block: Block): ThreadMessageLike["status"] {
  switch (block.state) {
    case "working":
      return { type: "running" };
    case "waiting":
      return { type: "requires-action", reason: "interrupt" };
    case "done":
      return { type: "complete", reason: "stop" };
    case "stopped":
      return { type: "incomplete", reason: "cancelled" };
    case "failed":
      return { type: "incomplete", reason: "error", error: block.error ?? "The reply failed." };
  }
}

function convertMessage(item: Item): ThreadMessageLike {
  const { block } = item;
  if (item.kind === "user") {
    const user = block.user;
    if (user?.kind === "pending") {
      return {
        id: user.pending.localId,
        role: "user",
        content: textContent(user.pending.text),
        createdAt: new Date(user.pending.createdAtMs),
        metadata: { custom: { attachments: user.pending.attachments, rework: false } satisfies Custom },
      };
    }
    const message = user?.message;
    return {
      id: item.id,
      role: "user",
      content: textContent(user?.text ?? ""),
      createdAt: new Date(message?.createdAtMs ?? block.startedAtMs),
      metadata: {
        custom: { attachments: message?.attachments ?? [], rework: item.rework } satisfies Custom,
      },
    };
  }
  return {
    id: item.id,
    role: "assistant",
    content: item.texts.map((text) => ({ type: "text" as const, text })),
    createdAt: new Date(block.startedAtMs),
    status: blockStatus(block),
    metadata: {
      custom: { block: item.meta } satisfies Custom,
      ...(item.rating && {
        submittedFeedback: { type: item.rating === "good" ? "positive" : "negative" },
      }),
      timing: {
        streamStartTime: block.startedAtMs,
        ...(block.endedAtMs !== null && { totalStreamTime: block.endedAtMs - block.startedAtMs }),
        totalChunks: item.texts.length,
        toolCallCount: block.tasks.length,
      },
    },
  };
}

/** A block's shape without its text, to reuse the previous item while only text is unchanged. */
function signature(
  block: Block,
  picked: ModelChoice | null,
  session: boolean,
  rework: boolean,
  rating: Rating | null,
): string {
  return JSON.stringify([
    rework,
    rating,
    block.state,
    block.error,
    block.startedAtMs,
    block.endedAtMs,
    block.texts.map((text) => [text.messageId, text.position, text.model]),
    block.cards,
    block.tasks,
    block.steps,
    block.steers.map((steer) => [steer.message.id, steer.text]),
    block.requestIds,
    picked,
    session,
  ]);
}

/**
 * The thread's messages: per request, the user's message and one assistant block, each under
 * its parent. Items whose block did not change keep their identity, so assistant-ui converts
 * and renders only the block that streams or changed.
 */
function useItems(
  nodes: readonly ThreadNode[],
  picked: ModelChoice | null,
  session: boolean,
  canRework: (requestId: string) => boolean,
  ratings: Partial<Record<string, Rating>>,
): Item[] {
  const [cache] = useState(() => new Map<string, { item: Item; sig: string; texts: string[] }>());
  return useMemo(() => {
    const items: Item[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      seen.add(node.id);
      const { block } = node;
      const entry = cache.get(node.id);
      // A block that joined steered requests answers the last of them, not its own message.
      const rework =
        block.user?.kind === "message" &&
        canRework(block.key) &&
        (node.kind === "user" || block.steers.length === 0);
      if (node.kind === "user") {
        if (
          entry?.item.kind !== "user" ||
          entry.item.block.user !== block.user ||
          entry.item.parentId !== node.parentId ||
          entry.item.rework !== rework
        ) {
          cache.set(node.id, {
            item: { id: node.id, parentId: node.parentId, kind: "user", block, rework },
            sig: "",
            texts: [],
          });
        }
        items.push((cache.get(node.id) as { item: Item }).item);
        continue;
      }
      const answerId = block.texts.at(-1)?.messageId ?? null;
      const rating = (answerId && ratings[answerId]) || null;
      const sig = signature(block, picked, session, rework, rating);
      const texts = block.texts.map((text) => text.text);
      const changed =
        entry === undefined ||
        entry.item.parentId !== node.parentId ||
        entry.sig !== sig ||
        entry.texts.length !== texts.length ||
        entry.texts.some((text, index) => text !== texts[index]);
      if (changed) {
        const meta: BlockMeta = {
          texts: block.texts.map((text) => ({ position: text.position, model: text.model })),
          cards: block.cards,
          steps: block.steps,
          steers: block.steers.map((steer) => ({
            position: steer.position,
            text: steer.text,
            atMs: steer.message.createdAtMs,
          })),
          state: block.state,
          startedAtMs: block.startedAtMs,
          endedAtMs: block.endedAtMs,
          picked,
          session,
          rework,
          requestId: block.key,
          requestIds: block.requestIds,
          answerId,
        };
        cache.set(node.id, {
          item: { id: node.id, parentId: node.parentId, kind: "block", block, meta, texts, rating },
          sig,
          texts,
        });
      }
      items.push((cache.get(node.id) as { item: Item }).item);
    }
    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    return items;
  }, [nodes, picked, session, canRework, ratings, cache]);
}

/** assistant-ui's form of each item, converted once per item. */
const converted = new WeakMap<Item, ThreadMessage>();

function toThreadMessage(item: Item): ThreadMessage {
  let message = converted.get(item);
  if (!message) {
    const [entry] = ExportedMessageRepository.fromBranchableArray([
      { message: convertMessage(item), parentId: item.parentId },
    ]).messages;
    message = (entry as { message: ThreadMessage }).message;
    converted.set(item, message);
  }
  return message;
}

function textOf(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

const NO_PENDING: PendingMessage[] = [];
const NO_RATINGS: Partial<Record<string, Rating>> = {};

const EMPTY_DIGEST: BoardDigest & { head: string | null } = {
  tasks: {},
  approvals: {},
  questions: {},
  plans: {},
  requests: {},
  workerSteps: [],
  runRequest: null,
  streaming: null,
  head: null,
};

/** The conversation's newest request (the daemon orders them the same way). */
function latestRequest(board: Board): UserRequest | null {
  let latest: UserRequest | null = null;
  for (const request of Object.values(board.requests)) {
    if (
      !latest ||
      request.startedAtMs > latest.startedAtMs ||
      (request.startedAtMs === latest.startedAtMs && request.id > latest.id)
    ) {
      latest = request;
    }
  }
  return latest;
}

/**
 * The session request the user may still edit or have answered again: the latest, until
 * anything it started has landed (or is landing with their approval).
 */
function reworkableRequest(board: Board): string | null {
  const latest = latestRequest(board);
  if (!latest) return null;
  const id = latest.id;
  const landed =
    Object.values(board.tasks).some((task) => task.requestId === id && task.state === "landed") ||
    Object.values(board.approvals).some(
      (approval) =>
        approval.requestId === id &&
        approval.state.type === "allowed" &&
        (approval.subject.type === "landing" || approval.subject.type === "finishSession"),
    );
  return landed ? null : id;
}

/** The open conversation's workers, for @-mentions. */
function useMentionTargets(conversationId: string | null): MentionTarget[] {
  const flat = useBoard(
    useShallow((s) => {
      const board = s.board;
      if (!board || board.conversationId !== conversationId) return [];
      return Object.values(board.tasks)
        .toSorted((a, b) => a.number - b.number)
        .flatMap((task) => [task.id, task.number, task.title, task.state]);
    }),
  );
  return useMemo(() => {
    const targets: MentionTarget[] = [];
    for (let i = 0; i < flat.length; i += 4) {
      targets.push({
        id: flat[i] as string,
        number: flat[i + 1] as number,
        title: flat[i + 2] as string,
        state: flat[i + 3] as string,
      });
    }
    return targets;
  }, [flat]);
}

export function ConversationView({ selection }: { selection: Selection }) {
  const conversationId = selection.type === "conversation" ? selection.id : null;
  const conversation = useApp((s) =>
    conversationId ? (s.conversations[conversationId] ?? null) : null,
  );
  const thread = useApp((s) =>
    conversationId ? (s.threads[conversationId] ?? emptyThread) : emptyThread,
  );
  const pending = useApp(
    useShallow((s) =>
      conversationId
        ? s.pending.filter((entry) => entry.conversationId === conversationId)
        : NO_PENDING,
    ),
  );
  const digest = useBoard(
    useShallow((s): (BoardDigest & { head: string | null }) | null =>
      s.board?.conversationId === conversationId
        ? {
            tasks: s.board.tasks,
            approvals: s.board.approvals,
            questions: s.board.questions,
            plans: s.board.plans,
            requests: s.board.requests,
            workerSteps: s.board.workerSteps,
            runRequest: s.board.runRequest,
            streaming: s.board.streaming,
            head: s.board.head,
          }
        : null,
    ),
  );
  const run = useBoard((s) =>
    s.board?.conversationId === conversationId ? s.board.run : "idle",
  );
  const queueItems = useBoard((s) =>
    s.board?.conversationId === conversationId ? s.board.queue.items : null,
  );
  const targets = useMentionTargets(conversationId);
  const resolved = useResolvedDraft(selection);
  const [error, setError] = useState<string | null>(null);

  // Blob-backed messages show their preview until the full text arrives.
  useEffect(() => {
    if (!conversationId) return;
    for (const message of thread.items) {
      if (message.blob && thread.fullText[message.id] === undefined) {
        void loadFullText(conversationId, message.id, message.blob).catch(
          (cause: unknown) => setError(String(cause)),
        );
      }
    }
  }, [conversationId, thread.items, thread.fullText]);

  const session = conversation?.kind === "session" || resolved.kind === "session";
  const tree = useMemo(
    () =>
      buildThread(
        thread.items,
        thread.fullText,
        thread.hasMore,
        digest ?? EMPTY_DIGEST,
        pending,
        session ? "edits" : "all",
      ),
    [thread.items, thread.fullText, thread.hasMore, digest, pending, session],
  );
  const setup = conversation?.setup;
  const picked =
    setup?.type === "chat" ? setup.model : setup?.type === "session" ? setup.orchestrator : null;
  const running = run === "running" || run === "starting";
  const reworkable = useBoard((s) =>
    s.board?.conversationId === conversationId && s.board ? reworkableRequest(s.board) : null,
  );
  // The user stopped the latest request and nothing runs for it: the send button resumes it.
  const stopped = useBoard(
    (s) =>
      s.board?.conversationId === conversationId &&
      !!s.board &&
      latestRequest(s.board)?.state.type === "stopped",
  );
  // Not while the orchestrator's turn for the request runs (the composer can stop it); a
  // request whose workers still run can be redone.
  const runRequest = digest?.runRequest ?? null;
  const canRework = useCallback(
    (requestId: string) =>
      session ? requestId === reworkable && !(running && runRequest === requestId) : !running,
    [session, reworkable, running, runRequest],
  );
  const ratings = useBoard((s) =>
    s.board?.conversationId === conversationId ? s.board.ratings : NO_RATINGS,
  );
  const items = useItems(tree.nodes, picked, session, canRework, ratings);
  const repository = useMemo<ExportedMessageRepository>(
    () => ({
      headId: tree.headId,
      messages: items.map((item) => ({ message: toThreadMessage(item), parentId: item.parentId })),
    }),
    [items, tree.headId],
  );
  // What each item's branch ends at, for the branch picker.
  const heads = useMemo(
    () => new Map(tree.nodes.map((node) => [node.id, node.head])),
    [tree.nodes],
  );
  const [panel, setPanel] = useState<AgentsPanelState>(undefined);
  const agents = useMemo(() => ({ panel, setPanel }), [panel]);

  const [attachments] = useState(() => new BlobAttachmentAdapter());
  const draftTarget = resolved.target;
  const submit = useCallback(
    (message: AppendMessage) => {
      const text = textOf(message);
      const refs = attachments.refsOf(message.attachments ?? []);
      if (!text && refs.length === 0) return;
      setError(null);
      send(
        { text, attachments: refs, mentions: mentionedTasks(text, targets) },
        draftTarget ?? undefined,
      ).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [attachments, targets, draftTarget],
  );

  // assistant-ui's queue surface over the daemon's queue: sending goes through it so the
  // composer stays usable while a turn runs; the panel above the composer shows the items.
  const queue = useMemo<ExternalThreadQueueAdapter>(() => {
    const states: QueueItemState[] = (queueItems ?? []).map((item) => ({
      id: item.id,
      prompt: item.text,
      parts: [{ type: "text", text: item.text }],
    }));
    return {
      items: states,
      steerItems: [],
      enqueue: submit,
      steer: submit,
      move: () => {},
      edit: () => {},
      remove: () => {},
    };
  }, [queueItems, submit]);

  const archived = conversation?.lifecycle === "archived";
  const fail = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  // "Good response" / "Bad response" on an answer: kept by the daemon, on this machine.
  const feedback = useMemo<FeedbackAdapter>(
    () => ({
      submit: ({ message, type }) => {
        const answerId = (message.metadata.custom as Custom).block?.answerId;
        if (!conversationId || !answerId) return;
        void rateMessage(conversationId, answerId, type === "positive" ? "good" : "bad").catch(
          fail,
        );
      },
    }),
    [conversationId, fail],
  );
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messageRepository: repository,
    // The daemon owns the messages; this only lets the branch picker switch (see below).
    setMessages: () => {},
    unstable_onBranchChange: ({ headId }: ExternalStoreBranchChange) => {
      const head = headId ? heads.get(headId) : null;
      if (conversationId && head) void switchBranch(conversationId, head).catch(fail);
    },
    onEdit: async (message) => {
      const text = textOf(message);
      if (!conversationId || !message.sourceId || !text) return;
      setError(null);
      await editMessage(conversationId, message.sourceId, text).catch(fail);
    },
    onReload: async (parentId) => {
      if (!conversationId || !parentId) return;
      setError(null);
      await regenerate(conversationId, parentId).catch(fail);
    },
    isLoading: thread.loading && thread.items.length === 0,
    isRunning: running,
    isDisabled: archived,
    isSendDisabled: conversation === null && resolved.problem !== null,
    queue,
    adapters: { attachments, feedback },
    onNew: async (message) => submit(message),
    onCancel: async () => {
      if (!conversationId) return;
      try {
        await interrupt(conversationId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });

  const onResume = useMemo(
    () =>
      conversationId && stopped && !running && !archived
        ? () => {
            setError(null);
            void resume(conversationId).catch(fail);
          }
        : null,
    [conversationId, stopped, running, archived, fail],
  );

  const target = useMemo<ComposerTarget>(
    () => ({ conversation, resolved, targets, running, onResume }),
    [conversation, resolved, targets, running, onResume],
  );

  return (
    <ViewContext.Provider value={{ selection, conversation }}>
      <ComposerTargetContext.Provider value={target}>
        <AgentsPanelContext.Provider value={agents}>
          <AssistantRuntimeProvider runtime={runtime}>
            <div className="flex h-full">
              <div className="flex h-full min-w-0 flex-1 flex-col">
                {error && (
                  <p
                    role="alert"
                    className="bg-destructive/10 text-destructive border-destructive/20 flex items-center gap-2 border-b px-4 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1">{error}</span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Dismiss"
                      onClick={() => setError(null)}
                    >
                      <X />
                    </Button>
                  </p>
                )}
                <div className="relative min-h-0 flex-1">
                  {conversation && <PinnedSummary conversation={conversation} />}
                  <Thread
                    components={THREAD_COMPONENTS}
                    placeholder={
                      resolved.kind === "session" || conversation?.kind === "session"
                        ? "Describe what this session should do…  (@ mentions a worker)"
                        : "Message Brigadier…"
                    }
                  />
                </div>
              </div>
              {conversationId && <AgentsPanel conversationId={conversationId} />}
            </div>
          </AssistantRuntimeProvider>
        </AgentsPanelContext.Provider>
      </ComposerTargetContext.Provider>
    </ViewContext.Provider>
  );
}

/** The view's selection and conversation, for the thread slots below (which take no props). */
const ViewContext = createContext<{ selection: Selection; conversation: Conversation | null }>({
  selection: { type: "none" },
  conversation: null,
});

const Welcome: FC = () => {
  const { selection } = useContext(ViewContext);
  const projectName = useApp((s) =>
    selection.type === "draft" && selection.kind === "session"
      ? s.projects[selection.projectId]?.name
      : undefined,
  );
  const session = selection.type === "draft" && selection.kind === "session";
  const heading = session ? `New session in ${projectName ?? "project"}` : "What are we working on?";
  const detail = session
    ? "Pick where the work lands below; the session starts with your first message."
    : "Chat with the model you pick, or choose a project below to start a session.";
  return (
    <div className="mb-6 flex flex-col gap-1 px-2">
      <h1 className="text-2xl">{heading}</h1>
      <p className="text-muted-foreground text-sm">{detail}</p>
    </div>
  );
};

const LoadEarlier: FC = () => {
  const { selection } = useContext(ViewContext);
  const conversationId = selection.type === "conversation" ? selection.id : "";
  const hasMore = useApp((s) => s.threads[conversationId]?.hasMore ?? false);
  const loading = useApp((s) => s.threads[conversationId]?.loading ?? false);
  if (!hasMore) return null;
  return (
    <div className="mb-4 flex justify-center">
      <Button
        variant="ghost"
        size="sm"
        disabled={loading}
        onClick={() => void loadEarlier(conversationId)}
      >
        {loading ? "Loading…" : "Load earlier messages"}
      </Button>
    </div>
  );
};

/** Under a user message: its attachments. */
const MessageFooter: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const custom = useAuiState((s) => s.message.metadata.custom) as Custom;
  if (role !== "user" || !custom.attachments || custom.attachments.length === 0) return null;
  return <MessageAttachments attachments={custom.attachments} className="justify-end" />;
};

/** Notices (environment problems, fallbacks), newest last; each can be dismissed. */
function Notices({ notices }: { notices: readonly Notice[] }) {
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set());
  const shown = notices.filter((notice) => !dismissed.has(notice.atMs)).slice(-3);
  if (shown.length === 0) return null;
  return (
    <ul aria-label="Notices" className="flex flex-col gap-1">
      {shown.map((notice) => (
        <li
          key={`${notice.atMs}:${notice.text}`}
          className={cn(
            "rounded-control flex items-start gap-2 px-3 py-1.5 text-xs",
            notice.level === "warning" ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground",
          )}
        >
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{notice.text}</span>
          <button
            type="button"
            aria-label="Dismiss notice"
            className="shrink-0 opacity-70 hover:opacity-100"
            onClick={() => setDismissed((current) => new Set(current).add(notice.atMs))}
          >
            <X className="size-icon-xs" />
          </button>
        </li>
      ))}
    </ul>
  );
}

const NO_NOTICES: Notice[] = [];

/** Between the thread and the composer: notices, a failed run, the archived state, the queue. */
const AboveComposer: FC = () => {
  const { conversation } = useContext(ViewContext);
  const conversationId = conversation?.id ?? null;
  const notices = useBoard((s) =>
    s.board?.conversationId === conversationId ? s.board.notices : NO_NOTICES,
  );
  const runError = useBoard((s) =>
    s.board?.conversationId === conversationId && s.board.run === "failed"
      ? (s.board.runError ?? "The model stopped with an error.")
      : null,
  );
  const target = useContext(ComposerTargetContext);
  const action = useAction();
  if (!conversation) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <Notices notices={notices} />
      {runError && (
        <p role="alert" className="bg-destructive/10 text-destructive rounded-control px-3 py-1.5 text-xs">
          {runError}
        </p>
      )}
      {conversation.lifecycle === "archived" ? (
        <div className="bg-muted rounded-control flex items-center gap-2 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">
            Archived. Restore it to continue; the orchestrator restarts from its transcript.
          </span>
          {action.error && (
            <span role="alert" className="text-destructive text-xs">
              {action.error}
            </span>
          )}
          <Button size="sm" disabled={action.busy} onClick={() => action.run(() => restore(conversation.id))}>
            <Unarchive />
            Restore
          </Button>
        </div>
      ) : (
        <QueuePanel
          conversationId={conversation.id}
          targets={target?.targets ?? []}
        />
      )}
    </div>
  );
};

const THREAD_COMPONENTS: ThreadComponents = {
  AssistantMessage: RequestBlock,
  Welcome,
  BeforeMessages: LoadEarlier,
  MessageFooter,
  AboveComposer,
  Composer: ConversationComposer,
};
