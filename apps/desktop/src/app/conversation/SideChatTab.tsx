import { useEffect, useState } from "react";

import { ConversationView } from "@/app/ConversationView";
import { request } from "@/ipc/client";
import { loadConversation } from "@/state/actions";
import {
  type BoardStore,
  BoardStoreContext,
  createSideBoard,
  disposeSideBoard,
} from "@/state/board";
import { noteSideChat } from "@/state/sideChats";
import { useApp } from "@/state/store";

/**
 * ChatGPT's Side chat tab (⌥⌘S): a temporary chat beside the conversation, for questions
 * about it that stay out of its thread. Its own thread and composer, on its own board; each
 * of its turns carries the conversation's latest messages. Closing the tab deletes it.
 */
export function SideChatTab({ conversationId }: { conversationId: string }) {
  const [side, setSide] = useState<{ id: string; store: BoardStore } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let store: BoardStore | null = null;
    request({ method: "openSideChat", conversationId })
      .then(({ conversation }) => {
        if (!live) return;
        useApp.setState((state) => ({
          conversations: { ...state.conversations, [conversation.id]: conversation },
        }));
        noteSideChat(conversationId, conversation.id);
        store = createSideBoard(conversation.id);
        setSide({ id: conversation.id, store });
        setError(null);
        void loadConversation(conversation.id).catch((cause: unknown) => {
          if (live) setError(cause instanceof Error ? cause.message : String(cause));
        });
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
      if (store) disposeSideBoard(store);
    };
  }, [conversationId]);

  if (error) {
    return (
      <p role="alert" className="text-destructive p-4 text-sm">
        {error}
      </p>
    );
  }
  if (!side) return null;
  return (
    <BoardStoreContext.Provider value={side.store}>
      <ConversationView selection={{ type: "conversation", id: side.id }} embedded />
    </BoardStoreContext.Provider>
  );
}
