import { create } from "zustand";

import type {
  AppInfo,
  Conversation,
  DaemonInfo,
  DaemonMetrics,
  Diagnostics,
  EventEnvelope,
  Message,
  Project,
  Settings,
} from "@/ipc/generated";
import { applyDensity, cachedDensity } from "@/lib/density";

/** What the main area shows. Drafts become real conversations on their first message. */
export type Selection =
  | { type: "none" }
  | { type: "conversation"; id: string }
  | { type: "draft"; kind: "chat" }
  | { type: "draft"; kind: "session"; projectId: string };

export type ConnectionState = {
  status: "connecting" | "connected" | "disconnected";
  daemon: DaemonInfo | null;
  reason: string | null;
};

/** A sent message not yet confirmed by the daemon. */
export type PendingMessage = {
  localId: string;
  conversationId: string;
  text: string;
  createdAtMs: number;
};

export type Thread = {
  items: Message[];
  hasMore: boolean;
  loading: boolean;
  /** Full text of blob-backed messages, by message id. */
  fullText: Record<string, string>;
};

export type InspectorTab = "events" | "processes" | "performance";

/** Newest inspector events kept in memory. */
export const INSPECTOR_EVENTS = 500;

export type AppState = {
  info: AppInfo | null;
  connection: ConnectionState;
  catalogLoaded: boolean;
  projects: Record<string, Project>;
  conversations: Record<string, Conversation>;
  settings: Settings;
  threads: Record<string, Thread>;
  pending: PendingMessage[];
  selection: Selection;
  expandedProjects: Record<string, boolean>;
  windowVisible: boolean;
  coldStartMs: number | null;
  inspector: {
    open: boolean;
    tab: InspectorTab;
    /** Newest first. */
    events: EventEnvelope[];
    metrics: DaemonMetrics | null;
    diagnostics: Diagnostics | null;
  };
};

export const useApp = create<AppState>()(() => ({
  info: null,
  connection: { status: "connecting", daemon: null, reason: null },
  catalogLoaded: false,
  projects: {},
  conversations: {},
  settings: { density: cachedDensity() },
  threads: {},
  pending: [],
  selection: { type: "draft", kind: "chat" },
  expandedProjects: {},
  windowVisible: true,
  coldStartMs: null,
  inspector: {
    open: false,
    tab: "events",
    events: [],
    metrics: null,
    diagnostics: null,
  },
}));

export const emptyThread: Thread = {
  items: [],
  hasMore: false,
  loading: false,
  fullText: {},
};

function byId<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

export function replaceCatalog(
  projects: readonly Project[],
  conversations: readonly Conversation[],
  settings: Settings,
): void {
  applyDensity(settings.density);
  useApp.setState({
    catalogLoaded: true,
    projects: byId(projects),
    conversations: byId(conversations),
    settings,
  });
}

/** Inserts messages into a thread, ordered by seq, without duplicates. */
export function mergeMessages(
  existing: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  const known = new Set(existing.map((message) => message.id));
  const added = incoming.filter((message) => !known.has(message.id));
  if (added.length === 0) return existing as Message[];
  return [...existing, ...added].toSorted((a, b) => a.seq - b.seq);
}

/**
 * Folds a batch of committed events into the state in one update, so a burst of events
 * costs one render.
 */
export function applyEvents(envelopes: readonly EventEnvelope[]): void {
  if (envelopes.length === 0) return;
  useApp.setState((state) => {
    let { projects, conversations, threads, pending, settings } = state;
    for (const envelope of envelopes) {
      ({ projects, conversations, threads, pending, settings } = applyEvent(
        envelope,
        { projects, conversations, threads, pending, settings },
      ));
    }
    const newest = envelopes.toReversed();
    const events = [...newest, ...state.inspector.events].slice(
      0,
      INSPECTOR_EVENTS,
    );
    return {
      projects,
      conversations,
      threads,
      pending,
      settings,
      inspector: { ...state.inspector, events },
    };
  });
}

type Slice = Pick<
  AppState,
  "projects" | "conversations" | "threads" | "pending" | "settings"
>;

function applyEvent(
  { event, streamSeq }: EventEnvelope,
  slice: Slice,
): Slice {
  switch (event.type) {
    case "projectCreated":
      return {
        ...slice,
        projects: { ...slice.projects, [event.project.id]: event.project },
      };
    case "conversationCreated":
      return {
        ...slice,
        conversations: {
          ...slice.conversations,
          [event.conversation.id]: event.conversation,
        },
      };
    case "conversationRenamed":
    case "conversationPinned": {
      const current = slice.conversations[event.id];
      if (!current) return slice;
      const next =
        event.type === "conversationRenamed"
          ? { ...current, title: event.title }
          : { ...current, pinnedAtMs: event.pinnedAtMs };
      return {
        ...slice,
        conversations: { ...slice.conversations, [event.id]: next },
      };
    }
    case "messageAppended": {
      // The store assigns a message's position: its sequence in the conversation stream.
      const message = { ...event.message, seq: streamSeq };
      const id = message.conversationId;
      let { conversations, threads } = slice;
      const conversation = conversations[id];
      if (conversation && conversation.updatedAtMs < message.createdAtMs) {
        conversations = {
          ...conversations,
          [id]: { ...conversation, updatedAtMs: message.createdAtMs },
        };
      }
      const thread = threads[id];
      if (thread) {
        const items = mergeMessages(thread.items, [message]);
        if (items !== thread.items) {
          threads = { ...threads, [id]: { ...thread, items } };
        }
      }
      // The confirmed message replaces its optimistic copy (the event can beat the response).
      const echo = slice.pending.findIndex(
        (entry) => entry.conversationId === id && entry.text === message.text,
      );
      const pending =
        echo === -1
          ? slice.pending
          : slice.pending.filter((_, index) => index !== echo);
      return { ...slice, conversations, threads, pending };
    }
    case "settingsChanged":
      applyDensity(event.settings.density);
      return { ...slice, settings: event.settings };
    case "probe":
      return slice;
  }
}

/** Resolves the conversation a selection points at, if any. */
export function selectedConversation(state: AppState): Conversation | null {
  return state.selection.type === "conversation"
    ? (state.conversations[state.selection.id] ?? null)
    : null;
}
