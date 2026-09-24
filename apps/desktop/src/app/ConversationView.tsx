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
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { BlobAttachmentAdapter } from "@/app/conversation/attachments";
import type { CardType } from "@/app/conversation/cards/CardBody";
import {
  type ComposerTarget,
  ComposerTargetContext,
  ConversationComposer,
} from "@/app/conversation/Composer";
import { useResolvedDraft } from "@/app/conversation/draftSetup";
import { QueuePanel } from "@/app/conversation/QueuePanel";
import { useAction } from "@/app/conversation/useAction";
import {
  mentionedTasks,
  type MentionTarget,
} from "@/components/assistant-ui/elements/composer-mentions";
import { MessageAttachments } from "@/components/assistant-ui/elements/message-attachment";
import { mono } from "@/components/assistant-ui/elements/surfaces";
import { Thread, type ThreadComponents } from "@/components/assistant-ui/thread";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  AttachmentRef,
  Conversation,
  Message,
  ModelChoice,
  Notice,
} from "@/ipc/generated";
import { modelName, sameModel, useModelGroups } from "@/lib/setup";
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

const CardBody = lazy(() => import("@/app/conversation/cards/CardBody"));

type CardItem = { kind: "card"; type: CardType; id: string; position: number };

type Item =
  | { kind: "message"; message: Message; text: string }
  | { kind: "pending"; pending: PendingMessage }
  | { kind: "streaming"; messageId: string; text: string }
  | CardItem;

/** Extra message data the footers and cards read back from assistant-ui's message state. */
type Custom = {
  card?: CardType;
  cardId?: string;
  attachments?: AttachmentRef[];
  model?: ModelChoice | null;
};

/** An attachment-only message has no text part, so no empty bubble shows above its files. */
function textContent(text: string): ThreadMessageLike["content"] {
  return text ? [{ type: "text", text }] : [];
}

function convertMessage(item: Item): ThreadMessageLike {
  switch (item.kind) {
    case "message": {
      const custom: Custom = {
        attachments: item.message.attachments,
        model: item.message.model,
      };
      return {
        id: item.message.id,
        role: item.message.role,
        content: textContent(item.text),
        createdAt: new Date(item.message.createdAtMs),
        metadata: { custom },
      };
    }
    case "pending":
      return {
        id: item.pending.localId,
        role: "user",
        content: textContent(item.pending.text),
        createdAt: new Date(item.pending.createdAtMs),
        metadata: { custom: { attachments: item.pending.attachments } satisfies Custom },
      };
    case "streaming":
      return {
        id: item.messageId,
        role: "assistant",
        content: [{ type: "text", text: item.text }],
        status: { type: "running" },
      };
    case "card":
      return {
        id: `${item.type}:${item.id}`,
        role: "assistant",
        content: [],
        status: { type: "complete", reason: "unknown" },
        metadata: { custom: { card: item.type, cardId: item.id } satisfies Custom },
      };
  }
}

function textOf(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

/** Every card on the board as `type:id:position`, a stable list while nothing is added. */
function cardKeys(s: ReturnType<typeof useBoard.getState>, conversationId: string | null): string[] {
  const board = s.board;
  if (!board || board.conversationId !== conversationId) return [];
  const keys: string[] = [];
  for (const task of Object.values(board.tasks)) keys.push(`task:${task.id}:${task.position}`);
  for (const card of Object.values(board.approvals)) keys.push(`approval:${card.id}:${card.position}`);
  for (const card of Object.values(board.questions)) keys.push(`question:${card.id}:${card.position}`);
  for (const card of Object.values(board.plans)) keys.push(`plan:${card.id}:${card.position}`);
  return keys;
}

const NO_PENDING: PendingMessage[] = [];

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
  const streaming = useBoard((s) =>
    s.board?.conversationId === conversationId ? s.board.streaming : null,
  );
  const run = useBoard((s) =>
    s.board?.conversationId === conversationId ? s.board.run : "idle",
  );
  const queueItems = useBoard((s) =>
    s.board?.conversationId === conversationId ? s.board.queue.items : null,
  );
  const cards = useBoard(useShallow((s) => cardKeys(s, conversationId)));
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

  // Card items change only when a card is added or moves; a task update rerenders its card
  // (which reads the board itself), not the thread.
  const cardItems = useMemo(
    () =>
      cards.map((key): CardItem => {
        const [type, id, position] = key.split(":") as [CardType, string, string];
        return { kind: "card", type, id, position: Number(position) };
      }),
    [cards],
  );

  const items = useMemo<Item[]>(() => {
    // Messages and cards interleave by position: both are sequences in the conversation's stream.
    const placed: { position: number; item: Item }[] = [
      ...thread.items.map((message) => ({
        position: message.seq,
        item: {
          kind: "message" as const,
          message,
          text: thread.fullText[message.id] ?? message.text,
        },
      })),
      ...cardItems.map((item) => ({ position: item.position, item })),
    ];
    placed.sort((a, b) => a.position - b.position);
    const ordered: Item[] = placed.map((entry) => entry.item);
    if (streaming && !thread.items.some((message) => message.id === streaming.messageId)) {
      ordered.push({ kind: "streaming", messageId: streaming.messageId, text: streaming.text });
    }
    for (const entry of pending) ordered.push({ kind: "pending", pending: entry });
    return ordered;
  }, [thread.items, thread.fullText, cardItems, streaming, pending]);

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
        <AssistantRuntimeProvider runtime={runtime}>
          <div className="flex h-full flex-col">
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
        </AssistantRuntimeProvider>
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

/** A worker, approval, question or plan card, placed in the thread by its position. */
const Card: FC = () => {
  const custom = useAuiState((s) => s.message.metadata.custom) as Custom;
  const id = custom.cardId ?? "";
  return (
    <div data-slot="thread-card" className="message-contain px-2">
      {custom.card && (
        <Suspense fallback={null}>
          <CardBody type={custom.card} id={id} />
        </Suspense>
      )}
    </div>
  );
};

/** Under a message: its attachments, and for replies, which model wrote it. */
const MessageFooter: FC = () => {
  const { conversation } = useContext(ViewContext);
  const role = useAuiState((s) => s.message.role);
  const custom = useAuiState((s) => s.message.metadata.custom) as Custom;
  const groups = useModelGroups();
  if (role === "user") {
    return custom.attachments && custom.attachments.length > 0 ? (
      <MessageAttachments attachments={custom.attachments} className="max-w-4/5 justify-end" />
    ) : null;
  }
  const model = custom.model;
  if (!model) return null;
  const setup = conversation?.setup;
  const picked = setup?.type === "chat" ? setup.model : setup?.type === "session" ? setup.orchestrator : null;
  const fellBack = picked !== null && picked !== undefined && !sameModel(picked, model);
  return (
    <span className={cn(mono, "text-muted-foreground flex items-center gap-1.5")}>
      {modelName(groups, model)}
      {model.effort && ` · ${model.effort}`}
      {fellBack && (
        <Badge variant="warning" title={`You picked ${modelName(groups, picked)}`}>
          fallback
        </Badge>
      )}
    </span>
  );
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
  Welcome,
  BeforeMessages: LoadEarlier,
  Card,
  MessageFooter,
  AboveComposer,
  Composer: ConversationComposer,
};
