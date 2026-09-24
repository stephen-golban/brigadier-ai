import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FC,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { Thread, type ThreadComponents } from "@/components/assistant-ui/thread";
import { Button } from "@/components/ui/button";
import type { Message } from "@/ipc/generated";
import { loadEarlier, loadFullText, sendMessage } from "@/state/actions";
import {
  emptyThread,
  type PendingMessage,
  type Selection,
  useApp,
} from "@/state/store";

type Item =
  | { kind: "message"; message: Message; text: string }
  | { kind: "pending"; pending: PendingMessage };

function convertMessage(item: Item): ThreadMessageLike {
  if (item.kind === "message") {
    return {
      id: item.message.id,
      role: "user",
      content: [{ type: "text", text: item.text }],
      createdAt: new Date(item.message.createdAtMs),
    };
  }
  return {
    id: item.pending.localId,
    role: "user",
    content: [{ type: "text", text: item.pending.text }],
    createdAt: new Date(item.pending.createdAtMs),
  };
}

function textOf(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

const NO_PENDING: PendingMessage[] = [];

export function ConversationView({ selection }: { selection: Selection }) {
  const conversationId = selection.type === "conversation" ? selection.id : null;
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

  const items = useMemo<Item[]>(
    () => [
      ...thread.items.map((message) => ({
        kind: "message" as const,
        message,
        text: thread.fullText[message.id] ?? message.text,
      })),
      ...pending.map((entry) => ({ kind: "pending" as const, pending: entry })),
    ],
    [thread.items, thread.fullText, pending],
  );

  const runtime = useExternalStoreRuntime<Item>({
    messages: items,
    convertMessage,
    isLoading: thread.loading && thread.items.length === 0,
    isRunning: false,
    onNew: async (message) => {
      const text = textOf(message);
      if (!text) return;
      setError(null);
      try {
        await sendMessage(text);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });

  return (
    <ViewContext.Provider value={selection}>
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="flex h-full flex-col">
          {error && (
            <p
              role="alert"
              className="bg-destructive/10 text-destructive border-destructive/20 border-b px-4 py-2 text-sm"
            >
              {error}
            </p>
          )}
          <div className="min-h-0 flex-1">
            <Thread
              components={THREAD_COMPONENTS}
              placeholder={
                selection.type === "draft" && selection.kind === "session"
                  ? "Describe what this session should do…"
                  : "Message Brigadier…"
              }
            />
          </div>
        </div>
      </AssistantRuntimeProvider>
    </ViewContext.Provider>
  );
}

/** The view's selection, for the thread slots below (which take no props). */
const ViewContext = createContext<Selection>({ type: "none" });

const Welcome: FC = () => {
  const selection = useContext(ViewContext);
  const projectName = useApp((s) =>
    selection.type === "draft" && selection.kind === "session"
      ? s.projects[selection.projectId]?.name
      : undefined,
  );
  const heading =
    selection.type === "draft" && selection.kind === "session"
      ? `New session in ${projectName ?? "project"}`
      : "What are we working on?";
  const detail =
    selection.type === "draft" && selection.kind === "session"
      ? "The session is created when you send the first message."
      : "Start a chat, or pick a project in the sidebar to open a session.";
  return (
    <div className="mb-6 flex flex-col gap-1 px-2">
      <h1 className="text-2xl">{heading}</h1>
      <p className="text-muted-foreground text-sm">{detail}</p>
    </div>
  );
};

const LoadEarlier: FC = () => {
  const selection = useContext(ViewContext);
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

const THREAD_COMPONENTS: ThreadComponents = {
  Welcome,
  BeforeMessages: LoadEarlier,
};
