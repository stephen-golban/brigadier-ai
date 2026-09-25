import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ExternalThreadQueueAdapter,
  type QueueItemState,
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
import { BlobAttachmentAdapter } from "@/app/conversation/attachments";
import { type Block, type BoardDigest, buildBlocks } from "@/app/conversation/blocks";
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
} from "@/ipc/generated";
import { cn } from "@/lib/utils";
import {
  interrupt,
  loadEarlier,
  loadFullText,
  restore,
  send,
} from "@/state/actions";
import { useBoard } from "@/state/board";
import {
  emptyThread,
  type PendingMessage,
  type Selection,
  useApp,
} from "@/state/store";

type Item =
  | { kind: "user"; block: Block }
  | { kind: "block"; block: Block; meta: BlockMeta; texts: string[] };

/** Extra message data the footers read back from assistant-ui's message state. */
type Custom = {
  attachments?: AttachmentRef[];
  block?: BlockMeta;
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
        metadata: { custom: { attachments: user.pending.attachments } satisfies Custom },
      };
    }
    const message = user?.message;
    return {
      id: message?.id ?? block.key,
      role: "user",
      content: textContent(user?.text ?? ""),
      createdAt: new Date(message?.createdAtMs ?? block.startedAtMs),
      metadata: { custom: { attachments: message?.attachments ?? [] } satisfies Custom },
    };
  }
  return {
    id: `request:${block.key}`,
    role: "assistant",
    content: item.texts.map((text) => ({ type: "text" as const, text })),
    createdAt: new Date(block.startedAtMs),
    status: blockStatus(block),
    metadata: {
      custom: { block: item.meta } satisfies Custom,
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
function signature(block: Block, picked: ModelChoice | null, session: boolean): string {
  return JSON.stringify([
    block.state,
    block.error,
    block.startedAtMs,
    block.endedAtMs,
    block.texts.map((text) => [text.messageId, text.position, text.model]),
    block.cards,
    block.tasks,
    picked,
    session,
  ]);
}

/**
 * The thread's messages: per request, the user's message and one assistant block. Items whose
 * block did not change keep their identity, so assistant-ui converts and renders only the
 * block that streams or changed.
 */
function useItems(
  blocks: readonly Block[],
  picked: ModelChoice | null,
  session: boolean,
): Item[] {
  const [cache] = useState(() => new Map<string, { user: Item; block: Item; sig: string; texts: string[] }>());
  return useMemo(() => {
    const items: Item[] = [];
    const seen = new Set<string>();
    for (const block of blocks) {
      seen.add(block.key);
      const sig = signature(block, picked, session);
      const texts = block.texts.map((text) => text.text);
      let entry = cache.get(block.key);
      const userChanged = entry === undefined || entry.user.block.user !== block.user;
      const blockChanged =
        entry === undefined ||
        entry.sig !== sig ||
        entry.texts.length !== texts.length ||
        entry.texts.some((text, index) => text !== texts[index]);
      if (!entry || userChanged || blockChanged) {
        const meta: BlockMeta = {
          texts: block.texts.map((text) => ({ position: text.position, model: text.model })),
          cards: block.cards,
          tasks: block.tasks,
          state: block.state,
          startedAtMs: block.startedAtMs,
          endedAtMs: block.endedAtMs,
          picked,
          session,
        };
        entry = {
          user: userChanged || !entry ? { kind: "user", block } : entry.user,
          block: blockChanged || !entry ? { kind: "block", block, meta, texts } : entry.block,
          sig,
          texts,
        };
        cache.set(block.key, entry);
      }
      if (block.user) items.push(entry.user);
      const shows =
        block.texts.length > 0 || block.cards.length > 0 || block.tasks.length > 0 || block.state !== "done";
      if (shows) items.push(entry.block);
    }
    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    return items;
  }, [blocks, picked, session, cache]);
}

function textOf(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

const NO_PENDING: PendingMessage[] = [];

const EMPTY_DIGEST: BoardDigest = {
  tasks: {},
  approvals: {},
  questions: {},
  plans: {},
  requests: {},
  runRequest: null,
  streaming: null,
};

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
    useShallow((s): BoardDigest | null =>
      s.board?.conversationId === conversationId
        ? {
            tasks: s.board.tasks,
            approvals: s.board.approvals,
            questions: s.board.questions,
            plans: s.board.plans,
            requests: s.board.requests,
            runRequest: s.board.runRequest,
            streaming: s.board.streaming,
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

  const blocks = useMemo(
    () =>
      buildBlocks(
        thread.items,
        thread.fullText,
        thread.hasMore,
        digest ?? EMPTY_DIGEST,
        pending,
      ),
    [thread.items, thread.fullText, thread.hasMore, digest, pending],
  );
  const setup = conversation?.setup;
  const picked =
    setup?.type === "chat" ? setup.model : setup?.type === "session" ? setup.orchestrator : null;
  const session = conversation?.kind === "session" || resolved.kind === "session";
  const items = useItems(blocks, picked, session);
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

  const running = run === "running" || run === "starting";
  const archived = conversation?.lifecycle === "archived";
  const runtime = useExternalStoreRuntime<Item>({
    messages: items,
    convertMessage,
    isLoading: thread.loading && thread.items.length === 0,
    isRunning: running,
    isDisabled: archived,
    isSendDisabled: conversation === null && resolved.problem !== null,
    queue,
    adapters: { attachments },
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

  const target = useMemo<ComposerTarget>(
    () => ({ conversation, resolved, targets, running }),
    [conversation, resolved, targets, running],
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
                <div className="min-h-0 flex-1">
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
          runningLabel={
            conversation.kind === "session" ? "The orchestrator is working…" : "Writing a reply…"
          }
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
